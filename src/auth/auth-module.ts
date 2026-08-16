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

class AuthOperationInvalidatedError extends Error {
  constructor() {
    super("Authentication operation was invalidated");
    this.name = "AuthOperationInvalidatedError";
  }
}

/** Minimal interface for the Obsidian plugin context used by auth */
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

  /** Monotonic fence for login, refresh, initialize and logout races. */
  private authGeneration = 0;

  /** Generation that owns the current pending OAuth browser attempt. */
  private pendingGeneration: number | null = null;

  /** One refresh request per auth generation. */
  private refreshInFlight: {
    generation: number;
    promise: Promise<string>;
  } | null = null;

  /** Serialize credential/profile persistence so logout cannot be overtaken. */
  private secretStorageTail: Promise<void> = Promise.resolve();
  private profileCacheTail: Promise<void> = Promise.resolve();

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

  private assertGeneration(generation: number): void {
    if (generation !== this.authGeneration) {
      throw new AuthOperationInvalidatedError();
    }
  }

  private enqueueSecretStorage<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.secretStorageTail.then(operation, operation);
    this.secretStorageTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueueProfileCache<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.profileCacheTail.then(operation, operation);
    this.profileCacheTail = result.then(() => undefined, () => undefined);
    return result;
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
      this.pendingGeneration = null;
      this.stopPolling();
      return false;
    }
    return true;
  }

  /** Exact URL for the current unexpired login attempt.
   *  Kept in memory only so the UI can offer a manual browser fallback. */
  get pendingAuthUrl(): string | null {
    if (!this.isPending) return null;
    return this.pending?.authUrl ?? null;
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
          this.diag?.error("auth", "OAuth callback error", authErrorDiagData(e));
        });
      });
      this.diag?.log("auth", "protocol handler registered");
    } catch (e) {
      this.diag?.error("auth", "failed to register protocol handler", e);
    }

    this._initializing = true;
    const generation = this.authGeneration;

    try {
      const stored = await this.getStoredRefreshToken();
      this.assertGeneration(generation);
      if (stored) {
        // Refresh token exists — try to get a fresh access token
        await this.refreshAccessTokenForGeneration(stored, generation);
        this.assertGeneration(generation);
        // Fetch user profile (displayName, accountId) for UI display
        await this.fetchUserProfile(generation, this.accessToken);
        this.assertGeneration(generation);
        this.diag?.log("auth", "restored auth session from SecretStorage");
      }
    } catch (e) {
      if (e instanceof AuthOperationInvalidatedError) {
        this.diag?.log("auth", "session restore invalidated by a newer auth action");
      } else if (
        e instanceof AuthError
        && e.type === AuthErrorType.SecretStorageUnavailable
      ) {
        this.diag?.warn("auth", "SecretStorage not available, auth disabled");
      } else {
        this.diag?.warn("auth", "failed to restore auth session", e);
      }
    }
    if (generation === this.authGeneration) {
      this._initializing = false;
      this.notifyChange();
    } else {
      this._initializing = false;
    }
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

    // ---- Synchronous block: entire PKCE + URL construction and browser open ----
    // No await is allowed here. Mobile WebViews require window.open() to stay
    // on the same synchronous chain as the user tap.
    const generation = ++this.authGeneration;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallengeSync(codeVerifier);
    const state = generateState();

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

    // Store the exact URL before opening it so a manual copy uses the same
    // state and PKCE verifier as the callback that this attempt expects.
    this.pending = {
      codeVerifier,
      state,
      authUrl,
      createdAt: Date.now(),
    };
    this.pendingGeneration = generation;

    // Open the completed URL exactly once. Android WebView can leave a
    // pre-opened about:blank page unchanged without throwing on location
    // assignment, which made the former fallback report a false success.
    this.diag?.log("auth", "opening auth URL...");
    this.ctx.openUrl(authUrl);
    this.diag?.log("auth", "openUrl returned");
    // ---- End synchronous block ----

    // Start auto-polling — detects OAuth callback completion and refreshes UI
    this.startPolling();
    this.notifyChange();
    this.diag?.log("auth", "polling started");
  }

  /** Handle the OAuth redirect callback */
  private async handleCallback(params: Record<string, string>): Promise<void> {
    const { code, state, error, error_description } = params;

    const pending = this.pending;
    const generation = this.pendingGeneration;
    if (!pending || generation === null) {
      this.diag?.warn("auth", "OAuth callback received but no pending auth");
      return;
    }

    // Validate state for CSRF protection
    if (state !== pending.state) {
      if (this.pending === pending) {
        this.pending = null;
        this.pendingGeneration = null;
      }
      throw new AuthError(AuthErrorType.StateMismatch, this.tr("auth.error.stateMismatch", "OAuth state mismatch."));
    }

    if (error) {
      if (this.pending === pending) {
        this.pending = null;
        this.pendingGeneration = null;
      }
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.providerError", `Microsoft error: ${error}`, { details: error_description || error }),
      );
    }

    if (!code) {
      if (this.pending === pending) {
        this.pending = null;
        this.pendingGeneration = null;
      }
      throw new AuthError(AuthErrorType.ProviderError, this.tr("auth.error.noCode", "No authorization code received"));
    }

    try {
      this.assertGeneration(generation);
      // Exchange code for tokens
      const tokenResponse = await this.exchangeCodeForTokens(
        code,
        pending.codeVerifier,
      );
      this.assertGeneration(generation);

      // Store refresh token in SecretStorage
      if (tokenResponse.refresh_token) {
        const stored = await this.storeRefreshTokenIfCurrent(
          tokenResponse.refresh_token,
          generation,
        );
        if (!stored) throw new AuthOperationInvalidatedError();
      }
      this.assertGeneration(generation);

      // Update in-memory state
      this.accessToken = tokenResponse.access_token;
      this.state.accessTokenExpiry =
        Date.now() + (tokenResponse.expires_in - 60) * 1000; // 60s buffer
      this.state.isLoggedIn = true;

      // Fetch user profile (displayName, accountId) for UI display
      await this.fetchUserProfile(generation, tokenResponse.access_token);
      this.assertGeneration(generation);

      this.diag?.log("auth", "OAuth login successful");
      // Fresh auth may have new scope — let listeners reset dependent state
      this.ctx.onFreshLogin?.();
    } finally {
      if (this.pending === pending) {
        this.pending = null;
        this.pendingGeneration = null;
        this.stopPolling();
      }
    }

    if (generation === this.authGeneration) this.notifyChange();
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
    return this.refreshAccessTokenForGeneration(
      refreshToken,
      this.authGeneration,
    );
  }

  private async refreshAccessTokenForGeneration(
    refreshToken: string | undefined,
    generation: number,
  ): Promise<string> {
    if (
      this.refreshInFlight
      && this.refreshInFlight.generation === generation
    ) {
      return this.refreshInFlight.promise;
    }

    const promise = this.performRefreshAccessToken(refreshToken, generation);
    this.refreshInFlight = { generation, promise };
    try {
      return await promise;
    } finally {
      if (this.refreshInFlight?.promise === promise) {
        this.refreshInFlight = null;
      }
    }
  }

  private async performRefreshAccessToken(
    refreshToken: string | undefined,
    generation: number,
  ): Promise<string> {
    this.assertGeneration(generation);
    const rt = refreshToken ?? (await this.getStoredRefreshToken());
    this.assertGeneration(generation);
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
      this.assertGeneration(generation);

      // Update stored refresh token if a new one was returned
      if (tokenResponse.refresh_token) {
        const stored = await this.storeRefreshTokenIfCurrent(
          tokenResponse.refresh_token,
          generation,
        );
        if (!stored) throw new AuthOperationInvalidatedError();
      }
      this.assertGeneration(generation);

      this.accessToken = tokenResponse.access_token;
      this.state.accessTokenExpiry =
        Date.now() + (tokenResponse.expires_in - 60) * 1000;
      this.state.isLoggedIn = true;

      return this.accessToken;
    } catch (error) {
      if (error instanceof AuthOperationInvalidatedError) throw error;
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
      if (e instanceof AuthOperationInvalidatedError) {
        throw new AuthError(
          AuthErrorType.NoRefreshToken,
          this.tr("auth.error.notLoggedIn", "Not logged in"),
        );
      }
      this.diag?.warn("auth", `token refresh failed, transitioning to logged-out: ${e instanceof Error ? e.message : String(e)}`);
      await this.logout();
      throw e;
    }
  }

  /** Log out only after SecretStorage confirms the refresh token is absent. */
  async logout(): Promise<boolean> {
    const generation = ++this.authGeneration;
    this.pending = null;
    this.pendingGeneration = null;
    this.stopPolling();
    const refreshTokenRemoved = await this.enqueueSecretStorage(async () => {
      try {
        await this.ctx.secretStorage.remove(SS_REFRESH_TOKEN);
        return (await this.ctx.secretStorage.get(SS_REFRESH_TOKEN)) === null;
      } catch (error) {
        this.diag?.error("auth", "failed to verify refresh token removal", error);
        return false;
      }
    });
    if (generation !== this.authGeneration) return false;
    if (!refreshTokenRemoved) {
      this.diag?.warn("auth", "logout incomplete — refresh token removal was not confirmed");
      this.notifyChange();
      return false;
    }

    // Clear cached user profile so next login fetches fresh data
    try {
      await this.enqueueProfileCache(async () => {
        if (generation !== this.authGeneration) return;
        await this.ctx.profileCache?.clear();
      });
    } catch {
      // Ignore cache clear errors
    }
    if (generation !== this.authGeneration) return false;
    this.accessToken = "";
    this.state = {
      accessTokenExpiry: 0,
      accountId: "",
      displayName: "",
      isLoggedIn: false,
    };
    this.notifyChange();
    this.diag?.log("auth", "logged out");
    return true;
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
        // OAuth failures are structured JSON responses. Keep them available
        // for redacted provider diagnostics instead of letting requestUrl
        // convert every HTTP 400+ response into an opaque network exception.
        throw: false,
      });
    } catch (e) {
      throw new AuthError(
        AuthErrorType.NetworkError,
        this.tr("auth.error.networkError", "Network error during authentication.", { details: e instanceof Error ? e.message : "unknown" }),
      );
    }

    if (response.status !== 200) {
      const errorData = getOAuthErrorData(response.json);
      const details = formatOAuthProviderDetails(errorData);
      this.diag?.error("auth", "token endpoint rejected OAuth request", {
        status: response.status,
        ...errorData,
      });
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.providerError", `Token endpoint returned ${response.status}: ${details}`, { details }),
      );
    }

    return response.json as TokenResponse;
  }

  /** Get the stored refresh token from SecretStorage */
  private async getStoredRefreshToken(): Promise<string | null> {
    try {
      await this.secretStorageTail;
      return await this.ctx.secretStorage.get(SS_REFRESH_TOKEN);
    } catch {
      throw new AuthError(
        AuthErrorType.SecretStorageUnavailable,
        this.tr("auth.error.secretStorageUnavailable", "SecretStorage not available"),
      );
    }
  }

  private storeRefreshTokenIfCurrent(
    refreshToken: string,
    generation: number,
  ): Promise<boolean> {
    return this.enqueueSecretStorage(async () => {
      if (generation !== this.authGeneration) return false;
      await this.ctx.secretStorage.set(SS_REFRESH_TOKEN, refreshToken);
      return generation === this.authGeneration;
    });
  }

  /** Fetch user profile from Microsoft Graph to populate displayName and accountId.
   *  Cached profile data is display-only: account authorization must always be
   *  anchored to /me for the current access token. */
  private async fetchUserProfile(
    generation: number,
    accessToken: string,
  ): Promise<void> {
    const cached = await this.enqueueProfileCache(
      async () => this.ctx.profileCache?.get(),
    );
    this.assertGeneration(generation);
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
          Authorization: `Bearer ${accessToken}`,
        },
      });
      this.assertGeneration(generation);

      if (response.status === 200) {
        const data = response.json as { displayName?: string; id?: string };
        if (data.displayName) {
          this.state.displayName = data.displayName;
        }
        if (data.id) {
          this.state.accountId = data.id;
        }
        if (
          this.state.accountId
          && (
            cached?.displayName !== this.state.displayName
            || cached.accountId !== this.state.accountId
          )
        ) {
          const profile = {
            displayName: this.state.displayName,
            accountId: this.state.accountId,
          };
          await this.enqueueProfileCache(async () => {
            if (generation !== this.authGeneration) return;
            await this.ctx.profileCache?.set(profile);
          });
          this.assertGeneration(generation);
        }
      }
    } catch (e) {
      if (e instanceof AuthOperationInvalidatedError) throw e;
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

/** Keep provider diagnostics useful without ever retaining tokens or codes. */
function getOAuthErrorData(value: unknown): {
  error?: string;
  errorDescription?: string;
  traceId?: string;
  correlationId?: string;
} {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const text = (candidate: unknown, max = 320): string | undefined => {
    if (typeof candidate !== "string" || candidate.length === 0) return undefined;
    return candidate.replace(/[\r\n]+/g, " ").slice(0, max);
  };
  return {
    ...(text(record.error) ? { error: text(record.error) } : {}),
    ...(text(record.error_description) ? { errorDescription: text(record.error_description) } : {}),
    ...(text(record.trace_id, 96) ? { traceId: text(record.trace_id, 96) } : {}),
    ...(text(record.correlation_id, 96) ? { correlationId: text(record.correlation_id, 96) } : {}),
  };
}

function formatOAuthProviderDetails(data: ReturnType<typeof getOAuthErrorData>): string {
  return [data.error, data.errorDescription].filter(Boolean).join(": ") || "unknown";
}

function authErrorDiagData(error: unknown): Record<string, unknown> {
  if (error instanceof AuthError) {
    return {
      name: error.name,
      type: error.type,
      message: error.message.replace(/[\r\n]+/g, " ").slice(0, 500),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.replace(/[\r\n]+/g, " ").slice(0, 500),
    };
  }
  return { message: String(error).replace(/[\r\n]+/g, " ").slice(0, 500) };
}
