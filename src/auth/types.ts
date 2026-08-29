/**
 * EasySync Auth Types
 * Authentication state, token types, and error classification.
 */

/** OAuth token response from Microsoft identity platform */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/** Stored token state (refresh token in SecretStorage, rest in plugin data) */
export interface AuthState {
  /** When the access token expires (epoch ms) */
  accessTokenExpiry: number;
  /** Account identifier from id_token or user info */
  accountId: string;
  /** Display name for the logged-in user */
  displayName: string;
  /** Whether a valid refresh token exists */
  isLoggedIn: boolean;
}

/** OAuth flow state for CSRF protection.
 *  Discriminated by kind: the browser (authorization code + PKCE) attempt
 *  keeps its CSRF state, the device-code attempt keeps its polling state. */
export type PendingAuth = PendingBrowserAuth | PendingDeviceAuth;

/** In-flight browser (authorization code + PKCE) login attempt */
export interface PendingBrowserAuth {
  kind: "browser";
  /** PKCE code verifier */
  codeVerifier: string;
  /** Random state value for CSRF protection */
  state: string;
  /** Exact authorization URL for the current in-memory login attempt */
  authUrl: string;
  /** Timestamp when this auth attempt was started */
  createdAt: number;
}

/** In-flight device code login attempt (RFC 8628) */
export interface PendingDeviceAuth {
  kind: "device";
  /** Server-side device code used only for token polling (never displayed) */
  deviceCode: string;
  /** 9-character code shown to the user */
  userCode: string;
  /** Verification page URL (code not embedded) */
  verificationUri: string;
  /** Verification page URL with the code embedded, when the provider
   *  returns it. Microsoft currently does NOT return this field (official
   *  docs: "not included or supported at this time"), so the same-device
   *  path falls back to copy-then-paste on the plain verification page. */
  verificationUriComplete: string | null;
  /** Absolute deadline for this code (epoch ms) */
  expiresAt: number;
  /** Token poll interval in ms; grows on slow_down */
  pollIntervalMs: number;
  /** Terminal failure phase once polling stops without success */
  phase?: DeviceCodeAttemptPhase;
  /** Timestamp when this auth attempt was started */
  createdAt: number;
}

/** Terminal device-code failure states surfaced to the waiting modal */
export type DeviceCodeAttemptPhase =
  | "declined"
  | "expired"
  | "mismatch"
  | "failed";

/** Live view of the current device-code attempt for the waiting modal */
export interface DeviceCodeAttemptView {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  phase: DeviceCodeAttemptPhase | "waiting";
}

/** Response from the devicecode endpoint (RFC 8628).
 *  verification_uri_complete is optional per the standard and is currently
 *  not returned by Microsoft. */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
  message?: string;
}

/** Errors that can occur during authentication */
export enum AuthErrorType {
  /** User cancelled the login */
  Cancelled = "Cancelled",
  /** State mismatch — possible CSRF */
  StateMismatch = "StateMismatch",
  /** Network error or timeout */
  NetworkError = "NetworkError",
  /** Microsoft returned an error */
  ProviderError = "ProviderError",
  /** SecretStorage not available */
  SecretStorageUnavailable = "SecretStorageUnavailable",
  /** Token refresh failed */
  RefreshFailed = "RefreshFailed",
  /** No refresh token available */
  NoRefreshToken = "NoRefreshToken",
  /** The stored refresh token was structurally rejected (OAuth invalid_grant
   *  on the refresh grant): revoked, expired by inactivity or superseded.
   *  Terminal — unlike NetworkError, this always ends the session and
   *  requires a fresh login. */
  CredentialsRevoked = "CredentialsRevoked",
}

export class AuthError extends Error {
  constructor(
    public readonly type: AuthErrorType,
    message: string,
    /** Optional token-endpoint HTTP detail for provider-classified failures.
     *  Read-only diagnostic context (status + OAuth error code); never
     *  contains tokens, codes or account IDs. */
    public readonly provider?: { status: number; error?: string },
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Microsoft OAuth configuration */
export const MS_AUTH_CONFIG = {
  /** Authorization endpoint */
  authorizeEndpoint:
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  /** Token endpoint */
  tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  /** Device code endpoint (RFC 8628) */
  deviceCodeEndpoint:
    "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
  /** Client ID — replaced during Entra app registration */
  clientId: "7d9ac248-9c51-422f-8cba-49e0a6a1ed67",
  /** Redirect URI registered in Entra */
  redirectUri: "obsidian://easy-sync-auth",
  /** OAuth scopes. Files.ReadWrite.AppFolder gives sandboxed access to the
   *  app's dedicated folder. Files.Read covers the /content download endpoint. */
  scopes: ["User.Read", "offline_access", "Files.ReadWrite.AppFolder", "Files.Read"],
} as const;

/** SecretStorage slot name for the OneDrive refresh token */
export const SS_REFRESH_TOKEN = "easy-sync-onedrive-refresh-token";
