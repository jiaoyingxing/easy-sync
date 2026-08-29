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
  compatClearTimeout,
  compatSetInterval,
  compatSetTimeout,
  IntervalHandle,
  TimeoutHandle,
} from "../obsidian-compat";
import {
  requestUrl,
  type RequestUrlResponse,
} from "obsidian";
import {
  type AuthState,
  type DeviceCodeAttemptView,
  type DeviceCodeResponse,
  type PendingAuth,
  type PendingDeviceAuth,
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

/** Classification of a single device-code token poll. */
type DevicePollResult =
  | { status: "pending" }
  | { status: "slowDown" }
  | { status: "networkError" }
  | { status: "declined" }
  | { status: "expired" }
  | { status: "mismatch" }
  | { status: "error" }
  | { status: "success"; tokens: TokenResponse };

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

  /** Transient refresh-failure backoff (login-persistence contract): a
   *  network flake right after sleep/wake or an offline period must NOT log
   *  the user out or delete the stored credential, but we also must not
   *  hammer the token endpoint on every request within a round. Reset by any
   *  successful refresh and by an explicit connectivity-restored event. */
  private static readonly REFRESH_RETRY_DELAYS_MS = [
    15_000, 30_000, 60_000, 120_000, 300_000,
  ];
  private refreshFailureCount = 0;
  private refreshFailureBlockedUntil = 0;

  /** Serialize credential/profile persistence so logout cannot be overtaken. */
  private secretStorageTail: Promise<void> = Promise.resolve();
  private profileCacheTail: Promise<void> = Promise.resolve();

  /** True while initialize() is running its async work (token refresh + profile fetch) */
  private _initializing = false;

  /** Polling timer for auto-detecting OAuth callback completion */
  private pollTimer: IntervalHandle | null = null;

  /** One-shot chain timer for device code token polling */
  private devicePollTimer: TimeoutHandle | null = null;

  /** In-flight poll tick so manual/immediate checks never race a timer tick */
  private deviceTickPromise: Promise<void> | null = null;

  /** Start time of the last poll tick — immediate checks respect a gap so a
   *  focus storm cannot hammer the provider faster than its interval */
  private lastDeviceTickAt = 0;

  /** Poll tick counter for per-tick diagnostics */
  private deviceTickCount = 0;

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

  /** Whether an OAuth flow is in progress (browser opened awaiting callback,
   *  or a device code still waiting for approval).
   *  Browser attempts auto-clear after 5 minutes to prevent stale pending
   *  state; device attempts stay until success, cancel or a terminal phase. */
  get isPending(): boolean {
    if (!this.pending) return false;
    if (this.pending.kind === "device") {
      // Still waiting unless the poll loop reached a terminal phase.
      return this.pending.phase === undefined;
    }
    if (Date.now() - this.pending.createdAt > 5 * 60 * 1000) {
      this.diag?.warn("auth", "OAuth pending auth expired after 5 minutes — no callback received");
      this.pending = null;
      this.pendingGeneration = null;
      this.stopPolling();
      return false;
    }
    return true;
  }

  /** Exact URL for the current unexpired browser login attempt.
   *  Kept in memory only so the UI can offer a manual browser fallback. */
  get pendingAuthUrl(): string | null {
    if (!this.isPending) return null;
    return this.pending?.kind === "browser" ? this.pending.authUrl : null;
  }

  /** Live view of the current device-code attempt for the waiting modal.
   *  null when no device attempt is active (or after it was cancelled). */
  get deviceAttempt(): DeviceCodeAttemptView | null {
    const pending = this.pending;
    if (!pending || pending.kind !== "device") return null;
    return {
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresAt: pending.expiresAt,
      phase: pending.phase ?? "waiting",
    };
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
    // Surface the connecting state immediately. Listeners render the
    // "connecting" presentation while initialization runs; without this
    // notification, surfaces that rendered before initialization started
    // (cold-start first frames) keep their pre-init "logged out" presentation
    // for the whole init window, because the next notification only arrives
    // when initialization completes.
    this.notifyChange();

    let storedRefreshToken: string | null = null;
    try {
      storedRefreshToken = await this.getStoredRefreshToken();
      this.assertGeneration(generation);
      if (storedRefreshToken) {
        // Refresh token exists — try to get a fresh access token
        await this.refreshAccessTokenForGeneration(storedRefreshToken, generation);
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
      } else if (
        e instanceof AuthError
        && e.type === AuthErrorType.CredentialsRevoked
      ) {
        // Stored credential was structurally rejected (invalid_grant) — it is
        // no longer valid, so the session must end: same terminal contract as
        // the sync path.
        this.diag?.warn("auth", "stored session rejected (invalid_grant), logging out");
        await this.logout();
      } else {
        this.diag?.warn("auth", "failed to restore auth session", e);
        // A stored session may still be valid — this was a transient failure
        // (e.g. network flake right after wake-up). Present the session as
        // present so surfaces never show "logged out"; a later refresh (next
        // sync round or a connectivity event) recovers the token and binds
        // the account. Only structural rejection ends the session.
        if (storedRefreshToken) {
          this.state.isLoggedIn = true;
        }
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
      kind: "browser",
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

  /** Start a device code login (RFC 8628).
   *
   *  Issues a devicecode request and begins token polling. No browser popup
   *  is opened here, so this may be awaited freely — the "open verification
   *  page" action happens later on its own user click inside the modal.
   *
   *  Returns the attempt view for the waiting modal; on failure the previous
   *  attempt is left untouched only if the request itself failed before
   *  replacing it (the caller decides whether to retry). */
  async beginDeviceCodeLogin(): Promise<DeviceCodeAttemptView> {
    this.diag?.log("auth", `beginDeviceCodeLogin() called, isLoggedIn=${this.state.isLoggedIn}, isPending=${!!this.pending}`);

    if (!MS_AUTH_CONFIG.clientId) {
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.clientNotConfigured", "OneDrive client ID not configured."),
      );
    }

    const generation = ++this.authGeneration;
    // Replace any previous attempt of either kind.
    this.pending = null;
    this.pendingGeneration = null;
    this.stopPolling();
    this.stopDevicePolling();

    const body = new URLSearchParams({
      client_id: MS_AUTH_CONFIG.clientId,
      scope: MS_AUTH_CONFIG.scopes.join(" "),
    });

    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        url: MS_AUTH_CONFIG.deviceCodeEndpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        throw: false,
      });
    } catch (e) {
      throw new AuthError(
        AuthErrorType.NetworkError,
        this.tr("auth.error.networkError", "Network error during authentication.", { details: e instanceof Error ? e.message : "unknown" }),
      );
    }
    this.assertGeneration(generation);

    if (response.status !== 200) {
      const errorData = getOAuthErrorData(response.json);
      const details = formatOAuthProviderDetails(errorData);
      this.diag?.error("auth", "devicecode endpoint rejected request", {
        status: response.status,
        ...errorData,
      });
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.providerError", `Device code endpoint returned ${response.status}: ${details}`, { details }),
      );
    }

    const data = response.json as DeviceCodeResponse;
    if (
      !data.user_code
      || !data.device_code
      || !data.verification_uri
      || !data.expires_in
    ) {
      this.diag?.error("auth", "devicecode endpoint returned an incomplete response");
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.providerError", "Device code response was incomplete."),
      );
    }

    // Microsoft currently does not return verification_uri_complete; treat it
    // as an optional enhancement and fall back to the plain verification page.
    const pending: PendingDeviceAuth = {
      kind: "device",
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete ?? null,
      expiresAt: Date.now() + data.expires_in * 1000,
      pollIntervalMs: Math.max(1000, (data.interval ?? 5) * 1000),
      createdAt: Date.now(),
    };
    this.pending = pending;
    this.pendingGeneration = generation;
    this.deviceTickCount = 0;
    this.lastDeviceTickAt = 0;

    this.scheduleDevicePoll(pending.pollIntervalMs);
    this.notifyChange();
    this.diag?.log("auth", "device code request accepted, polling started");

    return {
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresAt: pending.expiresAt,
      phase: "waiting",
    };
  }

  /** Cancel the current pending login attempt of either kind (modal close,
   *  cancel button, chooser dismissal). Bumps the generation so an in-flight
   *  request cannot commit a dangling attempt after cancellation. */
  cancelPendingLogin(): void {
    ++this.authGeneration;
    const hadAttempt = this.pending !== null;
    if (hadAttempt) this.diag?.log("auth", "pending login cancelled by user");
    this.pending = null;
    this.pendingGeneration = null;
    this.stopDevicePolling();
    if (hadAttempt) this.notifyChange();
  }

  /** Immediate one-shot poll for the current waiting device attempt — used by
   *  the modal's manual "check now" button and by window focus / foreground
   *  re-checks so a throttled background timer never leaves the modal
   *  unresponsive after the user returns. Awaits an in-flight tick instead of
   *  racing it, and respects a 2s gap since the last tick against focus
   *  storms. Resolves true only when a fresh tick actually ran. */
  checkDeviceCodeNow(): Promise<boolean> {
    const pending = this.pending;
    if (!pending || pending.kind !== "device" || pending.phase !== undefined) {
      return Promise.resolve(false);
    }
    if (this.deviceTickPromise) {
      return this.deviceTickPromise.then(() => false);
    }
    if (Date.now() - this.lastDeviceTickAt < 2000) {
      return Promise.resolve(false);
    }
    this.stopDevicePolling();
    return this.runDevicePollTick().then(() => true);
  }

  /** Open a URL in the system browser (delegates to the plugin launcher).
   *  The device-code modal uses this for the pre-filled verification page;
   *  the call must happen inside a user click to survive iOS popup rules. */
  openUrl(url: string): void {
    this.ctx.openUrl(url);
  }

  /** One-shot chain timer so slow_down can grow the interval and mobile
   *  suspension automatically resumes against the expiresAt deadline. */
  private scheduleDevicePoll(delayMs: number): void {
    this.devicePollTimer = compatSetTimeout(() => {
      this.devicePollTimer = null;
      void this.runDevicePollTick();
    }, delayMs);
  }

  private stopDevicePolling(): void {
    compatClearTimeout(this.devicePollTimer);
    this.devicePollTimer = null;
  }

  /** Run one poll tick, deduped: a scheduled timer tick, a manual check and a
   *  focus re-check all await the same in-flight tick instead of racing it. */
  private runDevicePollTick(): Promise<void> {
    if (this.deviceTickPromise) return this.deviceTickPromise;
    this.deviceTickPromise = this.doDevicePollTick().finally(() => {
      this.deviceTickPromise = null;
    });
    return this.deviceTickPromise;
  }

  private async doDevicePollTick(): Promise<void> {
    const pending = this.pending;
    const generation = this.pendingGeneration;
    if (
      !pending
      || pending.kind !== "device"
      || generation === null
      || generation !== this.authGeneration
      || pending.phase !== undefined
    ) {
      return;
    }

    this.lastDeviceTickAt = Date.now();
    this.deviceTickCount += 1;

    if (Date.now() >= pending.expiresAt) {
      pending.phase = "expired";
      this.diag?.warn("auth", "device code expired before approval");
      this.notifyChange();
      return;
    }

    const result = await this.deviceTokenPoll(pending.deviceCode);

    // The attempt may have been cancelled, regenerated or logged out while
    // the request was in flight — only commit against the same attempt.
    if (this.pending !== pending || this.pendingGeneration !== generation) {
      return;
    }

    // Every tick leaves a log line so an unresponsive modal is diagnosable:
    // a steady "pending" cadence proves the chain is alive and the provider
    // still waits for approval; a gap proves the chain died.
    this.diag?.log(
      "auth",
      `device code poll tick ${this.deviceTickCount}: ${result.status}`,
    );

    switch (result.status) {
      case "pending":
      case "networkError":
        this.scheduleDevicePoll(pending.pollIntervalMs);
        break;
      case "slowDown":
        pending.pollIntervalMs = Math.min(pending.pollIntervalMs + 5000, 60_000);
        this.scheduleDevicePoll(pending.pollIntervalMs);
        break;
      case "declined":
        pending.phase = "declined";
        this.diag?.warn("auth", "device code authorization declined by user");
        this.notifyChange();
        break;
      case "expired":
        pending.phase = "expired";
        this.diag?.warn("auth", "device code expired per provider");
        this.notifyChange();
        break;
      case "mismatch":
        pending.phase = "mismatch";
        this.diag?.warn("auth", "device code verification mismatch reported by provider");
        this.notifyChange();
        break;
      case "error":
        pending.phase = "failed";
        this.notifyChange();
        break;
      case "success": {
        try {
          await this.completeFreshLogin(result.tokens, generation);
        } catch (e) {
          if (e instanceof AuthOperationInvalidatedError) return;
          this.diag?.error("auth", "device code login completion failed", authErrorDiagData(e));
          if (this.pending === pending && pending.phase === undefined) {
            pending.phase = "failed";
          }
          this.notifyChange();
          return;
        }
        if (this.pending === pending) {
          this.pending = null;
          this.pendingGeneration = null;
          this.notifyChange();
        }
        break;
      }
    }
  }

  /** One token-endpoint poll for a device code. Never throws: transport
   *  failures become networkError (retried next tick), provider errors are
   *  classified into the terminal/transient states. */
  private async deviceTokenPoll(deviceCode: string): Promise<DevicePollResult> {
    const body = new URLSearchParams({
      client_id: MS_AUTH_CONFIG.clientId,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    });

    let response: RequestUrlResponse;
    try {
      response = await requestUrl({
        url: MS_AUTH_CONFIG.tokenEndpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        throw: false,
      });
    } catch (e) {
      this.diag?.warn("auth", "device code poll network error", authErrorDiagData(e));
      return { status: "networkError" };
    }

    if (response.status !== 200) {
      const errorData = getOAuthErrorData(response.json);
      switch (errorData.error) {
        case "authorization_pending":
          return { status: "pending" };
        case "slow_down":
          return { status: "slowDown" };
        case "authorization_declined":
          return { status: "declined" };
        case "expired_token":
          return { status: "expired" };
        case "bad_verification_code":
          return { status: "mismatch" };
        default:
          break;
      }
      if (response.status === 429) {
        return { status: "networkError" };
      }
      this.diag?.error("auth", "device code poll rejected", {
        status: response.status,
        ...errorData,
      });
      return { status: "error" };
    }

    return { status: "success", tokens: response.json as TokenResponse };
  }

  /** Handle the OAuth redirect callback */
  private async handleCallback(params: Record<string, string>): Promise<void> {
    const { code, state, error, error_description } = params;

    const pending = this.pending;
    const generation = this.pendingGeneration;
    if (!pending || pending.kind !== "browser" || generation === null) {
      this.diag?.warn("auth", "OAuth callback received but no pending browser auth");
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

      await this.completeFreshLogin(tokenResponse, generation);
    } finally {
      if (this.pending === pending) {
        this.pending = null;
        this.pendingGeneration = null;
        this.stopPolling();
      }
    }

    if (generation === this.authGeneration) this.notifyChange();
  }

  /** Shared completion tail for every fresh login path (browser callback and
   *  device code success): persist the refresh token, activate the access
   *  token, bind /me identity, and let listeners reset dependent state. */
  private async completeFreshLogin(
    tokenResponse: TokenResponse,
    generation: number,
  ): Promise<void> {
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
    this.resetRefreshBackoff();

    // Fetch user profile (displayName, accountId) for UI display
    await this.fetchUserProfile(generation, tokenResponse.access_token);
    this.assertGeneration(generation);

    this.diag?.log("auth", "OAuth login successful");
    // Fresh auth may have new scope — let listeners reset dependent state
    this.ctx.onFreshLogin?.();
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
      this.resetRefreshBackoff();

      return this.accessToken;
    } catch (error) {
      if (error instanceof AuthOperationInvalidatedError) throw error;
      if (error instanceof AuthError) {
        if (error.type === AuthErrorType.CredentialsRevoked) {
          // Terminal: the stored refresh token is no longer valid. Callers
          // transition to logged-out.
          throw error;
        }
        // Transient (network flake, 5xx, timeout, unexpected provider
        // rejection): the stored credential is still valid, so the session
        // stays logged in and a later attempt retries. Unified as NetworkError
        // so downstream classification never mistakes this for a logout.
        throw new AuthError(
          AuthErrorType.NetworkError,
          this.tr("auth.error.networkError", "Network error during authentication.", {
            details: error.message,
          }),
        );
      }
      throw new AuthError(
        AuthErrorType.NetworkError,
        this.tr("auth.error.networkError", "Network error during authentication.", {
          details: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  /**
   * Get a valid access token.
   * Refreshes automatically if expired.
   * This is the only method the sync engine should call.
   *
   * Login-persistence contract:
   * - Structural credential rejection (invalid_grant on refresh) → the stored
   *   credential is no longer valid: the session logs out (and the credential
   *   is deleted). This is the ONLY terminal refresh outcome.
   * - Any transient failure (network flake right after sleep/wake or offline
   *   periods, 5xx, timeouts) → the session STAYS logged in, the stored
   *   refresh token is preserved, and a later attempt retries (backoff, next
   *   sync round, or a connectivity event). Callers receive a NetworkError.
   */
  async getAccessToken(): Promise<string> {
    if (!this.state.isLoggedIn) {
      const established = await this.establishSessionFromStoredCredential();
      if (!established) {
        throw new AuthError(
          AuthErrorType.NoRefreshToken,
          this.tr("auth.error.notLoggedIn", "Not logged in"),
        );
      }
    }

    const token = await this.ensureFreshAccessToken(this.authGeneration);

    // A session recovered through refresh (e.g. cold start while offline) may
    // not have bound the account yet — anchor it via /me before returning.
    // /me failures stay non-fatal: sync authorization remains closed until
    // the account is bound, and a later round retries.
    if (!this.state.accountId) {
      await this.fetchUserProfile(this.authGeneration, token);
    }
    return token;
  }

  /** Get a valid access token, refreshing when expired and respecting the
   *  transient-failure backoff window. Throws NetworkError while in backoff
   *  without touching the network; CredentialsRevoked (after logout already
   *  performed by the caller's path) marks a terminal credential rejection. */
  private async ensureFreshAccessToken(generation: number): Promise<string> {
    if (this.accessToken && Date.now() < this.state.accessTokenExpiry) {
      return this.accessToken;
    }

    if (this.refreshFailureBlockedUntil > Date.now()) {
      this.diag?.log("auth", "silent refresh in backoff, skipping attempt");
      throw new AuthError(
        AuthErrorType.NetworkError,
        this.tr("auth.error.networkError", "Network error during authentication.", {
          details: "refresh in backoff",
        }),
      );
    }

    this.diag?.log("auth", "access token expired, refreshing silently");
    try {
      const token = await this.refreshAccessToken();
      this.resetRefreshBackoff();
      return token;
    } catch (e) {
      if (e instanceof AuthOperationInvalidatedError) {
        throw new AuthError(
          AuthErrorType.NoRefreshToken,
          this.tr("auth.error.notLoggedIn", "Not logged in"),
        );
      }
      if (e instanceof AuthError && e.type === AuthErrorType.CredentialsRevoked) {
        this.diag?.warn("auth", "token refresh rejected (invalid_grant), transitioning to logged-out");
        await this.logout();
        throw e;
      }
      this.diag?.warn("auth", `token refresh failed transiently, staying logged in: ${e instanceof Error ? e.message : String(e)}`);
      this.recordRefreshFailure();
      throw e;
    }
  }

  /** Connectivity-triggered silent refresh (window online / focus / returning
   *  to a visible document): immediately recovers a session whose token
   *  expired while offline or sleeping — without waiting for the next sync
   *  round timer. Never logs out on transient failure; `force` (online
   *  event) clears the transient backoff for a fresh chance. */
  async refreshNowIfNeeded(force = false): Promise<void> {
    if (this._initializing || this.pending) return;
    if (force) this.resetRefreshBackoff();
    const generation = this.authGeneration;
    try {
      if (!this.state.isLoggedIn) {
        const established = await this.establishSessionFromStoredCredential();
        if (!established) return;
      }
      const token = await this.ensureFreshAccessToken(generation);
      if (!this.state.accountId) {
        await this.fetchUserProfile(generation, token);
      }
    } catch (e) {
      if (e instanceof AuthOperationInvalidatedError) return;
      // CredentialsRevoked already performed logout and notified; transient
      // failures already recorded backoff. Either way the session state is
      // coherent — log and move on.
      this.diag?.warn("auth", "connectivity-triggered refresh attempt failed", authErrorDiagData(e));
    }
  }

  /** When no token has been acquired yet (e.g. cold start while offline), a
   *  stored refresh token still proves an existing login: mark the session
   *  present so surfaces never show "logged out" for it. The next refresh
   *  recovers the token and binds the account. Returns false only when no
   *  credential exists (true "not logged in"). */
  private async establishSessionFromStoredCredential(): Promise<boolean> {
    const rt = await this.getStoredRefreshToken();
    if (!rt) return false;
    if (!this.state.isLoggedIn) {
      this.state.isLoggedIn = true;
      this.notifyChange();
    }
    return true;
  }

  private recordRefreshFailure(): void {
    this.refreshFailureCount++;
    const index = Math.min(
      this.refreshFailureCount - 1,
      AuthModule.REFRESH_RETRY_DELAYS_MS.length - 1,
    );
    this.refreshFailureBlockedUntil =
      Date.now() + AuthModule.REFRESH_RETRY_DELAYS_MS[index];
  }

  private resetRefreshBackoff(): void {
    this.refreshFailureCount = 0;
    this.refreshFailureBlockedUntil = 0;
  }

  /** Log out only after SecretStorage confirms the refresh token is absent. */
  async logout(): Promise<boolean> {
    const generation = ++this.authGeneration;
    this.pending = null;
    this.pendingGeneration = null;
    this.stopPolling();
    this.stopDevicePolling();
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
    this.resetRefreshBackoff();
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
      const provider = { status: response.status, error: errorData.error };
      if (
        body.get("grant_type") === "refresh_token"
        && errorData.error === "invalid_grant"
      ) {
        // Structural rejection of the stored refresh token (revoked, expired
        // by inactivity, superseded): terminal — the session must log out.
        // Other grant types keep their existing ProviderError semantics.
        throw new AuthError(
          AuthErrorType.CredentialsRevoked,
          this.tr("auth.error.refreshFailed", "Token refresh failed."),
          provider,
        );
      }
      throw new AuthError(
        AuthErrorType.ProviderError,
        this.tr("auth.error.providerError", `Token endpoint returned ${response.status}: ${details}`, { details }),
        provider,
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
