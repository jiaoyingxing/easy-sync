import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { AuthModule, type AuthPluginContext } from "../src/auth/auth-module";

// We mock generateCodeChallengeSync (the sync path now used by login()).
// generateCodeChallenge (async) is kept unmocked for other test paths.
const syncChallengeMock = vi.hoisted(() => ({
  generateCodeChallengeSync: vi.fn(() => "challenge-sync-fixed"),
}));

vi.mock("../src/auth/pkce", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/pkce")>(
    "../src/auth/pkce",
  );
  return {
    ...actual,
    generateCodeVerifier: vi.fn(() => "verifier-fixed"),
    generateCodeChallengeSync: syncChallengeMock.generateCodeChallengeSync,
    generateState: vi.fn(() => "state-fixed"),
  };
});

function makeContext(overrides: Partial<AuthPluginContext> = {}): AuthPluginContext {
  return {
    secretStorage: {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    registerProtocolHandler: vi.fn(),
    openAuthPopup: vi.fn(() => ({
      navigate: vi.fn(() => true),
      close: vi.fn(),
    })),
    openUrl: vi.fn(),
    ...overrides,
  };
}

describe("AuthModule.login", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds the auth URL synchronously and navigates the pre-opened popup", async () => {
    vi.useFakeTimers();

    const popup = {
      navigate: vi.fn(() => true),
      close: vi.fn(),
    };
    const ctx = makeContext({
      openAuthPopup: vi.fn(() => popup),
      openUrl: vi.fn(),
    });
    const auth = new AuthModule(ctx);

    // login() is still declared async but the browser-open path is
    // entirely synchronous — no await needed for the core logic.
    await auth.login();

    // Popup must be pre-opened first (sync, before PKCE)
    expect(ctx.openAuthPopup).toHaveBeenCalledTimes(1);

    // Sync challenge must have been called
    expect(syncChallengeMock.generateCodeChallengeSync).toHaveBeenCalledWith("verifier-fixed");

    // Popup must be navigated to the full auth URL
    expect(popup.navigate).toHaveBeenCalledTimes(1);
    expect(popup.navigate).toHaveBeenCalledWith(
      expect.stringContaining("code_challenge=challenge-sync-fixed"),
    );
    expect(popup.navigate).toHaveBeenCalledWith(
      expect.stringContaining(`redirect_uri=${encodeURIComponent("obsidian://easy-sync-auth")}`),
    );
    expect(popup.navigate).toHaveBeenCalledWith(
      expect.stringContaining("state=state-fixed"),
    );

    // openUrl must NOT be called (popup navigation succeeded)
    expect(ctx.openUrl).not.toHaveBeenCalled();

    // pending must be set
    expect(auth.isPending).toBe(true);

    // polling must be active
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("falls back to direct openUrl when popup navigation fails", async () => {
    const popup = {
      navigate: vi.fn(() => false), // navigation fails
      close: vi.fn(),
    };
    const ctx = makeContext({
      openAuthPopup: vi.fn(() => popup),
      openUrl: vi.fn(),
    });
    const auth = new AuthModule(ctx);

    await auth.login();

    expect(popup.navigate).toHaveBeenCalledTimes(1);
    // Fallback must fire
    expect(ctx.openUrl).toHaveBeenCalledTimes(1);
    expect(ctx.openUrl).toHaveBeenCalledWith(
      expect.stringContaining("code_challenge=challenge-sync-fixed"),
    );
    expect(auth.isPending).toBe(true);
  });

  it("falls back to direct openUrl when openAuthPopup is not available", async () => {
    const ctx = makeContext({
      openAuthPopup: undefined,
      openUrl: vi.fn(),
    });
    const auth = new AuthModule(ctx);

    await auth.login();

    // openUrl must be called directly
    expect(ctx.openUrl).toHaveBeenCalledTimes(1);
    expect(ctx.openUrl).toHaveBeenCalledWith(
      expect.stringContaining("code_challenge=challenge-sync-fixed"),
    );
    expect(auth.isPending).toBe(true);
  });
});

describe("AuthModule account identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses current-token /me identity instead of the cached account id", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        return {
          status: 200,
          headers: {},
          json: { access_token: "current-token", expires_in: 3600 },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "Current User", id: "current-account" },
      };
    });
    const cacheSet = vi.fn().mockResolvedValue(undefined);
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue("stored-refresh-token"),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      profileCache: {
        get: vi.fn().mockResolvedValue({
          displayName: "Cached User",
          accountId: "cached-account",
        }),
        set: cacheSet,
        clear: vi.fn().mockResolvedValue(undefined),
      },
    }));

    await auth.initialize();

    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.accountId).toBe("current-account");
    expect(auth.authState.displayName).toBe("Current User");
    expect(cacheSet).toHaveBeenCalledWith({
      displayName: "Current User",
      accountId: "current-account",
    });
  });

  it("does not authorize with a cached account when /me cannot be verified", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        return {
          status: 200,
          headers: {},
          json: { access_token: "current-token", expires_in: 3600 },
        };
      }
      throw new Error("profile unavailable");
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue("stored-refresh-token"),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      profileCache: {
        get: vi.fn().mockResolvedValue({
          displayName: "Cached User",
          accountId: "cached-account",
        }),
        set: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      },
    }));

    await auth.initialize();

    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.displayName).toBe("Cached User");
    expect(auth.authState.accountId).toBe("");
  });
});

describe("generateCodeChallengeSync", () => {
  it("produces the same result as the async Web Crypto version", async () => {
    // Import the ACTUAL module (bypass vi.mock) to get the real functions
    const actual = await vi.importActual<typeof import("../src/auth/pkce")>(
      "../src/auth/pkce",
    );

    const verifier = "test-verifier-string-12345";
    const syncResult = actual.generateCodeChallengeSync(verifier);
    const asyncResult = await actual.generateCodeChallenge(verifier);

    expect(syncResult).toBe(asyncResult);
    // Should be 43 chars (32 bytes of SHA-256 → base64url without padding)
    expect(syncResult.length).toBe(43);
  });

  it("produces known test vectors", async () => {
    const actual = await vi.importActual<typeof import("../src/auth/pkce")>(
      "../src/auth/pkce",
    );

    // Known test vector: SHA-256("abc")
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    // → base64url without padding = "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
    const result = actual.generateCodeChallengeSync("abc");
    expect(result).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});
