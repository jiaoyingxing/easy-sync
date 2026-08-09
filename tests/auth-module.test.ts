import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { AuthModule, type AuthPluginContext } from "../src/auth/auth-module";
import { createAuthBrowserLauncher } from "../src/auth/auth-browser";

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

  it("builds and directly opens the completed mobile auth URL on the synchronous click chain", async () => {
    vi.useFakeTimers();

    const openWindow = vi.fn(() => null);
    const launcher = createAuthBrowserLauncher({
      isDesktopApp: false,
      openWindow,
    });
    const ctx = makeContext({
      ...launcher,
    });
    const auth = new AuthModule(ctx);
    const onStateChange = vi.fn();
    auth.onStateChange(onStateChange);

    const loginPromise = auth.login();

    expect(syncChallengeMock.generateCodeChallengeSync).toHaveBeenCalledWith("verifier-fixed");
    expect(openWindow).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith(
      expect.stringContaining("code_challenge=challenge-sync-fixed"),
      "_blank",
    );
    expect(openWindow).toHaveBeenCalledWith(
      expect.stringContaining(`redirect_uri=${encodeURIComponent("obsidian://easy-sync-auth")}`),
      "_blank",
    );
    expect(openWindow).toHaveBeenCalledWith(
      expect.stringContaining("state=state-fixed"),
      "_blank",
    );
    expect(openWindow).not.toHaveBeenCalledWith("about:blank", "_blank");
    expect(auth.pendingAuthUrl).toBe(openWindow.mock.calls[0][0]);
    expect(auth.isPending).toBe(true);
    expect(onStateChange).toHaveBeenCalledOnce();
    expect(openWindow.mock.invocationCallOrder[0]).toBeLessThan(
      onStateChange.mock.invocationCallOrder[0],
    );

    await loginPromise;

    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("expires the current pending URL with the existing five-minute pending state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    const auth = new AuthModule(makeContext());

    await auth.login();
    expect(auth.pendingAuthUrl).toContain("state=state-fixed");

    vi.setSystemTime(new Date("2026-08-01T12:05:00.001Z"));
    expect(auth.pendingAuthUrl).toBeNull();
    expect(auth.isPending).toBe(false);
  });

  it("completes the callback chain for the exact current URL opened manually", async () => {
    let callback: ((params: Record<string, string>) => void) | undefined;
    const registerProtocolHandler = vi.fn(
      (_action: string, handler: (params: Record<string, string>) => void) => {
        callback = handler;
      },
    );
    const openUrl = vi.fn();
    const secretSet = vi.fn().mockResolvedValue(undefined);
    const request = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        return {
          status: 200,
          headers: {},
          json: {
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "Manual Browser User", id: "manual-account" },
      };
    });
    const auth = new AuthModule(makeContext({
      registerProtocolHandler,
      openUrl,
      secretStorage: {
        set: secretSet,
        get: vi.fn().mockResolvedValue(null),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    }));

    await auth.initialize();
    await auth.login();
    const currentUrl = auth.pendingAuthUrl;

    expect(currentUrl).toBe(openUrl.mock.calls[0][0]);
    expect(currentUrl).toContain("state=state-fixed");
    expect(callback).toBeTypeOf("function");

    callback?.({ code: "manual-auth-code", state: "state-fixed" });
    await vi.waitFor(() => expect(auth.authState.isLoggedIn).toBe(true));

    const tokenRequest = request.mock.calls.find(([options]) =>
      options.url.includes("/oauth2/v2.0/token"),
    )?.[0];
    expect(tokenRequest?.body).toContain("code=manual-auth-code");
    expect(tokenRequest?.body).toContain("code_verifier=verifier-fixed");
    expect(secretSet).toHaveBeenCalledWith(
      "easy-sync-onedrive-refresh-token",
      "refresh-token",
    );
    expect(auth.authState.accountId).toBe("manual-account");
    expect(auth.pendingAuthUrl).toBeNull();
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

  it("verifies /me on cold start without rewriting an identical profile cache", async () => {
    const request = vi.spyOn(obsidian, "requestUrl").mockImplementation(
      async (options) => {
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
      },
    );
    const cacheSet = vi.fn().mockResolvedValue(undefined);
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue("stored-refresh-token"),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      profileCache: {
        get: vi.fn().mockResolvedValue({
          displayName: "Current User",
          accountId: "current-account",
        }),
        set: cacheSet,
        clear: vi.fn().mockResolvedValue(undefined),
      },
    }));

    await auth.initialize();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].url).toContain("/me?");
    expect(auth.authState.accountId).toBe("current-account");
    expect(cacheSet).not.toHaveBeenCalled();
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
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const asyncResult = Buffer.from(digest).toString("base64url");

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
