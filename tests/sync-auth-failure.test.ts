import { describe, expect, it } from "vitest";
import { AuthError, AuthErrorType } from "../src/auth/types";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import { isAuthFailure } from "../src/sync/sync-executor";

describe("isAuthFailure (unified auth failure classifier)", () => {
  it("treats OneDrive authentication expiry as an auth failure", () => {
    expect(isAuthFailure(new OneDriveError(
      OneDriveErrorType.AuthExpired,
      "access token expired",
      401,
    ))).toBe(true);
  });

  it("treats structural credential rejection as an auth failure", () => {
    expect(isAuthFailure(new AuthError(
      AuthErrorType.CredentialsRevoked,
      "refresh token rejected (invalid_grant)",
    ))).toBe(true);
    expect(isAuthFailure(new AuthError(
      AuthErrorType.NoRefreshToken,
      "not logged in",
    ))).toBe(true);
  });

  it("does NOT treat transient refresh network errors as auth failures (login persistence)", () => {
    // A transient refresh failure keeps the session logged in and retries
    // later — it must surface as an ordinary failure, never as an auth
    // expiry that forces a re-login.
    expect(isAuthFailure(new AuthError(
      AuthErrorType.NetworkError,
      "network error during authentication",
    ))).toBe(false);
  });

  it("does not treat unrelated errors as auth failures", () => {
    expect(isAuthFailure(new Error("boom"))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });
});