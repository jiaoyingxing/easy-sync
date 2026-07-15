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

/** OAuth flow state for CSRF protection */
export interface PendingAuth {
  /** PKCE code verifier */
  codeVerifier: string;
  /** Random state value for CSRF protection */
  state: string;
  /** Timestamp when this auth attempt was started */
  createdAt: number;
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
}

export class AuthError extends Error {
  constructor(
    public readonly type: AuthErrorType,
    message: string,
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
