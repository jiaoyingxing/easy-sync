/**
 * AuthModule — OneDrive OAuth authentication handler
 *
 * Manages the full OAuth Authorization Code + PKCE flow:
 *  1. Generate PKCE params, open Microsoft login
 *  2. Receive callback via obsidian:// protocol
 *  3. Exchange code for tokens
 *  4. Store refresh token in SecretStorage
 *  5. Refresh expired access tokens
 *
 * The module is self-contained: the sync engine only calls getAccessToken().
 */

import {
  compatClearInterval,
  compatSetInterval,
  IntervalHandle,
} from "../obsidian-compat";
import {
  requestUrl,
  type RequestUrlResponse,
} from "obsidian";
import {
  type AuthState,
  type PendingAuth,
  type TokenResponse,
  AuthError,
  AuthErrorType,
  MS_AUTH_CONFIG,
  SS_REFRESH_TOKEN,
} from "./types";
import { generateCodeVerifier, generateCodeChallengeSync, generateState } from "./pkce";
import type { DiagnosticLogger } from "../sync/diagnostic-logger";

/** Minimal interface for the Obsidian plugin context used by auth */
export interface AuthPopupHandle {
  /** Navigate an already-opened browser window to the target URL. */
  navigate(url: string): boolean;
  /** Close the pre-opened window when auth bootstrap fails early. */
  close(): void;
}

export interface AuthPluginContext {
  /** Obsidian SecretStorage for refresh token persistence */
  secretStorage: {
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    remove(key: string): Promise<void>;
  };
  /** Register a protocol handler for OAuth callback */
  registerProtocolHandler(
    action: string,
    handler: (params: Record<string, string>) => void,
  ): void;
  /** Pre-open a browser window synchronously from the click gesture. */
  openAuthPopup?(): AuthPopupHandle | null;
  /** Open a URL in the system browser */
  openUrl(url: string): void;
  /** Cache for user profile (displayName, accountId) to avoid network call on every startup */
  profileCache?: {
    get(): Promise<{ displayName: string; accountId: string } | null>;
    set(profile: { displayName: string; accountId: string }): Promise<void>;
    clear(): Promise<void>;
  };
  /** Diagnostic logger (optional) */
  diag?: DiagnosticLogger;
  /** Called when a fresh OAuth login completes (not session restore).
   *  Hook for resetting state that's invalidated by auth scope changes. */
  onFreshLogin?: () => void;
}

export class AuthModule {
  /** Current non-sensitive auth state (no tokens) */
  private state: AuthState = {
    accessTokenExpiry: 0,
    accountId: "",
    displayName: "",
    isLoggedIn: false,
  };

  /** In-memory access token (never persisted to disk) */
  private accessToken: string = "";

  /** Pending OAuth flow state */
  private pending: PendingAuth | null = null;

  /** True while initialize() is running its async work (token refresh + profile fetch) */
  private _initializing = false;

  /** Polling timer for auto-detecting OAuth callback completion */
  private pollTimer: IntervalHandle | null = null;

  /** Callback when auth state changes */
  private onChange: (() => void) | null = null;

  /** Optional i18n translate function for user-facing error messages */
  private t?: (key: string, params?: Record<string, string | number>) => string;

  /** Shorthand to ctx.diag so we don't write this.ctx.diag?. everywhere */
  private get diag(): DiagnosticLogger | undefined {
    return this.ctx.diag;
  }

  constructor(
    private ctx: AuthPluginContext,
    t?: (key: string, params?: Record<string, string | number>) => string,
  ) {
    this.t = t;
  }

  private tr(key: string, fallback: string, params?: Record<string, string | number>): string {
    return this.t?.(key, params) ?? fallback;
  }

  /** Current auth state (no tokens) */
  get authState(): AuthState {
    return { ...this.state };
  }

  /** Whether an OAuth flow is in progress (browser opened, awaiting callback).
   *  Auto-clears after 5 minutes to prevent stale pending state. */
  get isPending(): boolean {
    if (!this.pending) return false;
    if (Date.now() - this.pending.createdAt > 5 * 60 * 1000) {
      this.diag?.warn("auth", "OAuth pending auth expired after 5 minutes — no callback received");
      this.pending = null;
      this.stopPolling();
      return false;
    }
    return true;
  }

  /** True while initialize() is restoring a session from SecretStorage.
   *  UI can use this to show a "connecting" state during cold start. */
  get isInitializing(): boolean {
    return this._initializing;
  }

  /** Three-state auth status for UI display */
  get authStatus(): "idle" | "pending" | "loggedIn" {
    if (this.state.isLoggedIn) return "loggedIn";
    if (this.isPending) return "pending";
    return "idle";
  }

  /** Manual one-shot check: has the OAuth callback completed?
   *  Returns true if the user is now logged in. */
  checkAuthStatus(): boolean {
    return this.state.isLoggedIn;
  }

  /** Start auto-polling for OAuth callback completion (every 3 seconds) */
  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = compatSetInterval(() => {
      if (this.state.isLoggedIn) {
        // Auth completed — stop polling and refresh UI
        this.stopPolling();
        this.notifyChange();
        return;
      }
      if (!this.isPending) {
        // Pending timed out — stop polling
        this.stopPolling();
        this.notifyChange();
        return;
      }
      // Still waiting — keep polling, notify anyway so UI can update timers etc.
      this.notifyChange();
    }, 3000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      compatClearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Register a callback for auth state changes */
  onStateChange(cb: () => void): void {
    this.onChange = cb;
  }

  /** Initialize: restore session from stored refresh token.
   *  Caller can choose to await (blocking) or fire-and-forget (non-blocking).
   *  The protocol handler is registered synchronously at the start so
   *  OAuth callbacks work even before the async token refresh completes. */
  async initialize(): Promise<void> {
    // Register protocol handler once — handles ALL OAuth callbacks for this session.
    // This runs synchronously and must complete before any login flow begins.
    try {
      this.ctx.registerProtocolHandler("easy-sync-auth", (params) => {
        this.handleCallback(params).catch((e) => {
          this.diag?.error("auth", "OAuth callback error", e);
        });
      });
      this.diag?.log("auth", "protocol handler registered");
    } catch (e) {
      this.diag?.error("auth", "failed to register protocol handler", e);
    }

    this._initializing = true;

    try {
      const stored = await this.ctx.secretStorage.get(SS_REFRESH_TOKEN);
      if (stored) {
        // Refresh token exists — try to get a fresh access token
        await this.refreshAccessToken(stored);
        this.state.isLoggedIn = true;
        // Fetch user profile (displayName, accountId) for UI display
        await this.fetchUserProfile();
        this.diag?.log("auth", "restored auth session from SecretStorage");
      }
    } catch (e) {
      if (e instanceof AuthError && e.type === AuthErrorType.SecretStorageUnavailable) {
        this.diag?.warn("auth", "SecretStorage not available, auth disabled");
      } else {
        this.diag?.warn("auth", "failed to restore auth session", e);
      }
    }
    this._initializing = false;
    this.notifyChange();
  }

  /** Start the OAuth login flow.
   *
   *  IMPORTANT — iOS WKWebView compat:
   *  Every operation between the user tap and window.open() MUST be
   *  synchronous. Any await breaks the "user initiated" gesture chain
   *  and causes iOS to block the popup. We use generateCodeChallengeSync()
   *  (inline SHA-256) instead of the async Web Crypto version for this
   *  reason. */
  async login(): Promise<void> {
    this.diag?.log("auth", `login() called, isLoggedIn=${this.state.isLoggedIn}, isPending=${!!this.pending}`);

    if (!MS_AUTH_CONFIG.clientId) {
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.clientNotConfigured", "OneDrive client ID not configured."),
      );
    }

    // Mobile pre-opens a blank browser window BEFORE any async work to
    // preserve the user-action gesture. Desktop skips the popup and opens
    // the completed authorization URL directly in the system browser.
    const popup = this.ctx.openAuthPopup?.() ?? null;

    try {
      // ---- Synchronous block: entire PKCE + URL construction ----
      // No await allowed in this section — iOS WKWebView requires
      // window.open() to be called on the same synchronous chain as
      // the user tap.

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallengeSync(codeVerifier);
      const state = generateState();

      this.pending = {
        codeVerifier,
        state,
        createdAt: Date.now(),
      };

      const params = new URLSearchParams({
        client_id: MS_AUTH_CONFIG.clientId,
        response_type: "code",
        redirect_uri: MS_AUTH_CONFIG.redirectUri,
        scope: MS_AUTH_CONFIG.scopes.join(" "),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        prompt: "consent", // force re-consent so scope upgrades (e.g. AppFolder → Files.ReadWrite) take effect
      });

      const authUrl = `${MS_AUTH_CONFIG.authorizeEndpoint}?${params.toString()}`;
      // ---- End synchronous block ----

      // Try navigating the mobile pre-opened popup first. Desktop has no
      // popup and uses the system-browser launcher directly. A blocked mobile
      // popup also falls back while still on the synchronous click chain.
      this.diag?.log("auth", "opening auth URL...");
      const navigated = popup?.navigate(authUrl) ?? false;
      if (!navigated) {
        this.ctx.openUrl(authUrl);
      }
      this.diag?.log("auth", "openUrl returned");

      // Start auto-polling — detects OAuth callback completion and refreshes UI
      this.startPolling();
      this.diag?.log("auth", "polling started");
    } catch (error) {
      popup?.close();
      throw error;
    }
  }

  /** Handle the OAuth redirect callback */
  private async handleCallback(params: Record<string, string>): Promise<void> {
    const { code, state, error, error_description } = params;

    if (!this.pending) {
      this.diag?.warn("auth", "OAuth callback received but no pending auth");
      return;
    }

    // Validate state for CSRF protection
    if (state !== this.pending.state) {
      this.pending = null;
      throw new AuthError(AuthErrorType.StateMismatch, this.tr("auth.error.stateMismatch", "OAuth state mismatch."));
    }

    if (error) {
      this.pending = null;
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.providerError", `Microsoft error: ${error}`, { details: error_description || error }),
      );
    }

    if (!code) {
      this.pending = null;
      throw new AuthError(AuthErrorType.ProviderError, this.tr("auth.error.noCode", "No authorization code received"));
    }

    try {
      // Exchange code for tokens
      const tokenResponse = await this.exchangeCodeForTokens(
        code,
        this.pending.codeVerifier,
      );

      // Store refresh token in SecretStorage
      if (tokenResponse.refresh_token) {
        await this.ctx.secretStorage.set(SS_REFRESH_TOKEN, tokenResponse.refresh_token);
      }

      // Update in-memory state
      this.accessToken = tokenResponse.access_token;
      this.state.accessTokenExpiry =
        Date.now() + (tokenResponse.expires_in - 60) * 1000; // 60s buffer
      this.state.isLoggedIn = true;

      // Fetch user profile (displayName, accountId) for UI display
      await this.fetchUserProfile();

      this.diag?.log("auth", "OAuth login successful");
      // Fresh auth may have new scope — let listeners reset dependent state
      this.ctx.onFreshLogin?.();
    } finally {
      this.pending = null;
      this.stopPolling();
    }

    this.notifyChange();
  }

  /** Exchange authorization code for access + refresh tokens */
  private async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: MS_AUTH_CONFIG.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: MS_AUTH_CONFIG.redirectUri,
      code_verifier: codeVerifier,
    });

    return this.tokenRequest(body);
  }

  /** Refresh an expired access token */
  async refreshAccessToken(refreshToken?: string): Promise<string> {
    const rt = refreshToken ?? (await this.getStoredRefreshToken());
    if (!rt) {
      throw new AuthError(AuthErrorType.NoRefreshToken, this.tr("auth.error.noRefreshToken", "No refresh token available"));
    }

    const body = new URLSearchParams({
      client_id: MS_AUTH_CONFIG.clientId,
      grant_type: "refresh_token",
      refresh_token: rt,
    });

    try {
      const tokenResponse = await this.tokenRequest(body);

      // Update stored refresh token if a new one was returned
      if (tokenResponse.refresh_token) {
        await this.ctx.secretStorage.set(SS_REFRESH_TOKEN, tokenResponse.refresh_token);
      }

      this.accessToken = tokenResponse.access_token;
      this.state.accessTokenExpiry =
        Date.now() + (tokenResponse.expires_in - 60) * 1000;
      this.state.isLoggedIn = true;

      return this.accessToken;
    } catch {
      this.state.isLoggedIn = false;
      this.notifyChange();
      throw new AuthError(
        AuthErrorType.RefreshFailed,
        this.tr("auth.error.refreshFailed", "Token refresh failed."),
      );
    }
  }

  /**
   * Get a valid access token.
   * Refreshes automatically if expired.
   * This is the only method the sync engine should call.
   */
  async getAccessToken(): Promise<string> {
    if (!this.state.isLoggedIn) {
      throw new AuthError(AuthErrorType.NoRefreshToken, this.tr("auth.error.notLoggedIn", "Not logged in"));
    }

    // Check if token is still valid (with 60s buffer)
    if (this.accessToken && Date.now() < this.state.accessTokenExpiry) {
      return this.accessToken;
    }

    // Token expired — refresh. If refresh fails, transition to logged-out
    // state so the UI (ribbon, sidebar) reflects reality immediately.
    this.diag?.log("auth", "access token expired, refreshing silently");
    try {
      return await this.refreshAccessToken();
    } catch (e) {
      this.diag?.warn("auth", `token refresh failed, transitioning to logged-out: ${e instanceof Error ? e.message : String(e)}`);
      await this.logout();
      throw e;
    }
  }

  /** Log out: clear tokens from SecretStorage and memory */
  async logout(): Promise<void> {
    this.stopPolling();
    try {
      await this.ctx.secretStorage.remove(SS_REFRESH_TOKEN);
    } catch {
      // Ignore removal errors
    }
    // Clear cached user profile so next login fetches fresh data
    try {
      await this.ctx.profileCache?.clear();
    } catch {
      // Ignore cache clear errors
    }
    this.accessToken = "";
    this.state = {
      accessTokenExpiry: 0,
      accountId: "",
      displayName: "",
      isLoggedIn: false,
    };
    this.notifyChange();
    this.diag?.log("auth", "logged out");
  }

  /** Make a POST request to the Microsoft token endpoint */
  private async tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        url: MS_AUTH_CONFIG.tokenEndpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (e) {
      throw new AuthError(
        AuthErrorType.NetworkError,
        this.tr("auth.error.networkError", "Network error during authentication.", { details: e instanceof Error ? e.message : "unknown" }),
      );
    }

    if (response.status !== 200) {
      const errorData = response.json as Record<string, unknown> | undefined;
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.providerError", `Token endpoint returned ${response.status}`, { details: String(errorData?.error || "unknown") }),
      );
    }

    return response.json as TokenResponse;
  }

  /** Get the stored refresh token from SecretStorage */
  private async getStoredRefreshToken(): Promise<string | null> {
    try {
      return await this.ctx.secretStorage.get(SS_REFRESH_TOKEN);
    } catch {
      throw new AuthError(
        AuthErrorType.SecretStorageUnavailable,
        this.tr("auth.error.secretStorageUnavailable", "SecretStorage not available"),
      );
    }
  }

  /** Fetch user profile from Microsoft Graph to populate displayName and accountId.
   *  Cached profile data is display-only: account authorization must always be
   *  anchored to /me for the current access token. */
  private async fetchUserProfile(): Promise<void> {
    const cached = await this.ctx.profileCache?.get();
    if (cached) {
      this.state.displayName = cached.displayName;
      this.diag?.log("auth", `profile display cache hit: ${cached.displayName}`);
    }
    this.state.accountId = "";
    this.diag?.log("auth", "verifying current token account through Graph /me");

    try {
      const response = await requestUrl({
        url: "https://graph.microsoft.com/v1.0/me?$select=displayName,id",
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (response.status === 200) {
        const data = response.json as { displayName?: string; id?: string };
        if (data.displayName) {
          this.state.displayName = data.displayName;
        }
        if (data.id) {
          this.state.accountId = data.id;
        }
        if (this.state.accountId) {
          await this.ctx.profileCache?.set({
            displayName: this.state.displayName,
            accountId: this.state.accountId,
          });
        }
      }
    } catch (e) {
      // The refreshed token remains available, but sync authorization stays
      // closed because accountId is empty until /me succeeds.
      this.diag?.warn("auth", "failed to verify current token account", e);
    }
  }

  private notifyChange(): void {
    if (this.onChange) {
      this.onChange();
    }
  }
}
