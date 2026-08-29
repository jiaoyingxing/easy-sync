import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { AuthModule, type AuthPluginContext } from "../src/auth/auth-module";
import { createAuthBrowserLauncher } from "../src/auth/auth-browser";
import { MS_AUTH_CONFIG } from "../src/auth/types";

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    const authUrl = new URL(openWindow.mock.calls[0][0]);
    expect(authUrl.searchParams.get("scope")).toBe(MS_AUTH_CONFIG.scopes.join(" "));
    expect(MS_AUTH_CONFIG.scopes).toEqual([
      "User.Read",
      "offline_access",
      "Files.ReadWrite.AppFolder",
      "Files.Read",
    ]);
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

  it("records the provider error details when the token exchange is rejected", async () => {
    let callback: ((params: Record<string, string>) => void) | undefined;
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 400,
      headers: {},
      json: {
        error: "invalid_scope",
        error_description: "The requested permission is not valid for this account.",
        trace_id: "trace-123",
        correlation_id: "corr-456",
      },
    });
    const auth = new AuthModule(makeContext({
      diag: diag as never,
      registerProtocolHandler: (_action, handler) => {
        callback = handler;
      },
    }));

    await auth.initialize();
    await auth.login();
    callback?.({ code: "auth-code", state: "state-fixed" });

    await vi.waitFor(() => expect(diag.error).toHaveBeenCalled());
    expect(obsidian.requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      throw: false,
    }));
    const entries = diag.error.mock.calls.map(([, message, data]) => ({ message, data }));
    expect(entries).toContainEqual({
      message: "token endpoint rejected OAuth request",
      data: {
        status: 400,
        error: "invalid_scope",
        errorDescription: "The requested permission is not valid for this account.",
        traceId: "trace-123",
        correlationId: "corr-456",
      },
    });
    expect(entries).toContainEqual({
      message: "OAuth callback error",
      data: expect.objectContaining({
        name: "AuthError",
        type: "ProviderError",
        message: expect.stringContaining("invalid_scope"),
      }),
    });
    expect(auth.authState.isLoggedIn).toBe(false);
  });

  it("keeps token transport failures separate from provider rejections", async () => {
    let callback: ((params: Record<string, string>) => void) | undefined;
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    vi.spyOn(obsidian, "requestUrl").mockRejectedValue(new Error("offline"));
    const auth = new AuthModule(makeContext({
      diag: diag as never,
      registerProtocolHandler: (_action, handler) => {
        callback = handler;
      },
    }));

    await auth.initialize();
    await auth.login();
    callback?.({ code: "auth-code", state: "state-fixed" });

    await vi.waitFor(() => expect(diag.error).toHaveBeenCalled());
    expect(diag.error).not.toHaveBeenCalledWith(
      "auth",
      "token endpoint rejected OAuth request",
      expect.anything(),
    );
    expect(diag.error).toHaveBeenCalledWith(
      "auth",
      "OAuth callback error",
      expect.objectContaining({
        name: "AuthError",
        type: "NetworkError",
      }),
    );
    expect(auth.authState.isLoggedIn).toBe(false);
  });
});

describe("AuthModule account identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifies listeners as soon as initialization starts so cold-start surfaces can show the connecting state", async () => {
    // Hold the token refresh open so the start of initialization is
    // distinguishable from its completion.
    const gate = deferred<void>();
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        await gate.promise;
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
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue("stored-refresh-token"),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    }));
    const onStateChange = vi.fn();
    auth.onStateChange(onStateChange);

    const initializePromise = auth.initialize();

    // The listener must be notified while the session restore is still
    // in flight — that is the transition that lets the sidebar / status
    // bar flip from a pre-init "logged out" frame to "connecting".
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(auth.isInitializing).toBe(true);
    expect(auth.authState.isLoggedIn).toBe(false);

    gate.resolve();
    await initializePromise;
    expect(auth.isInitializing).toBe(false);
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(onStateChange).toHaveBeenCalledTimes(2);
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

describe("AuthModule credential concurrency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares one token request between concurrent refresh callers", async () => {
    const token = deferred<obsidian.RequestUrlResponse>();
    const request = vi.spyOn(obsidian, "requestUrl").mockReturnValue(token.promise);
    const auth = new AuthModule(makeContext());

    const first = auth.refreshAccessToken("refresh-token");
    const second = auth.refreshAccessToken("refresh-token");
    expect(request).toHaveBeenCalledTimes(1);

    token.resolve({
      status: 200,
      headers: {},
      json: { access_token: "new-access-token", expires_in: 3600 },
    });

    await expect(first).resolves.toBe("new-access-token");
    await expect(second).resolves.toBe("new-access-token");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("serializes logout after a rotated refresh token write and removes it", async () => {
    const secretSet = deferred<void>();
    let storedToken: string | null = "old-refresh-token";
    const set = vi.fn(async (_key: string, value: string) => {
      await secretSet.promise;
      storedToken = value;
    });
    const remove = vi.fn(async () => {
      storedToken = null;
    });
    vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: {
        access_token: "stale-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      },
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set,
        get: vi.fn(async () => storedToken),
        remove,
      },
    }));

    const refresh = auth.refreshAccessToken("old-refresh-token");
    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
    const logout = auth.logout();
    secretSet.resolve();

    await expect(refresh).rejects.toMatchObject({
      name: "AuthOperationInvalidatedError",
    });
    await expect(logout).resolves.toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(storedToken).toBeNull();
    expect(auth.authState.isLoggedIn).toBe(false);
  });

  it("does not commit an OAuth callback after logout invalidates the attempt", async () => {
    const token = deferred<obsidian.RequestUrlResponse>();
    let callback: ((params: Record<string, string>) => void) | undefined;
    const secretSet = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(obsidian, "requestUrl").mockReturnValue(token.promise);
    const auth = new AuthModule(makeContext({
      registerProtocolHandler: (_action, handler) => {
        callback = handler;
      },
      secretStorage: {
        set: secretSet,
        get: vi.fn().mockResolvedValue(null),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      diag: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    }));

    await auth.initialize();
    await auth.login();
    callback?.({ code: "auth-code", state: "state-fixed" });
    await vi.waitFor(() => expect(obsidian.requestUrl).toHaveBeenCalledOnce());
    await expect(auth.logout()).resolves.toBe(true);

    token.resolve({
      status: 200,
      headers: {},
      json: {
        access_token: "stale-access-token",
        refresh_token: "stale-refresh-token",
        expires_in: 3600,
      },
    });
    await vi.waitFor(() => expect(auth.isPending).toBe(false));

    expect(secretSet).not.toHaveBeenCalled();
    expect(auth.authState.isLoggedIn).toBe(false);
  });

  it("does not report logout success when refresh-token removal is unverified", async () => {
    const get = vi.fn().mockResolvedValue("persisted-refresh-token");
    vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { access_token: "access-token", expires_in: 3600 },
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get,
        remove: vi.fn().mockResolvedValue(undefined),
      },
      diag: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    }));
    await auth.refreshAccessToken("persisted-refresh-token");

    await expect(auth.logout()).resolves.toBe(false);
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(get).toHaveBeenCalled();
  });
});

describe("AuthModule device code flow", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const DEVICE_CODE_RESPONSE = {
    status: 200,
    headers: {},
    json: {
      device_code: "device-secret-1",
      user_code: "ABCDEFGHI",
      verification_uri: "https://microsoft.com/devicelogin",
      // Microsoft currently does NOT return verification_uri_complete
      // (official docs: "not included or supported at this time").
      expires_in: 900,
      interval: 5,
    },
  };

  function pendingTokenResponse(): {
    status: number;
    headers: Record<string, never>;
    json: Record<string, string>;
  } {
    return {
      status: 400,
      headers: {},
      json: { error: "authorization_pending" },
    };
  }

  function makeAuth(requestMock: typeof obsidian.requestUrl): AuthModule {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(requestMock);
    return new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    }));
  }

  it("issues a devicecode request, exposes the attempt, and polls on the provider interval", async () => {
    vi.useFakeTimers();
    const tokenCalls: string[] = [];
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      if (options.url.includes("/oauth2/v2.0/token")) {
        tokenCalls.push(String(options.body));
        return pendingTokenResponse() as obsidian.RequestUrlResponse;
      }
      throw new Error("unexpected request");
    });

    const attempt = await auth.beginDeviceCodeLogin();

    expect(attempt).toEqual({
      userCode: "ABCDEFGHI",
      verificationUri: "https://microsoft.com/devicelogin",
      verificationUriComplete: null,
      expiresAt: expect.any(Number),
      phase: "waiting",
    });
    expect(auth.deviceAttempt?.userCode).toBe("ABCDEFGHI");
    expect(auth.isPending).toBe(true);
    expect(auth.pendingAuthUrl).toBeNull();
    expect(auth.authStatus).toBe("pending");

    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
    expect(tokenCalls[0]).toContain("device_code=device-secret-1");
    expect(tokenCalls[0]).not.toContain("code_verifier");

    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenCalls).toHaveLength(2);
    expect(auth.deviceAttempt?.phase).toBe("waiting");
  });

  it("keeps the provider's pre-filled verification URI when it is returned", async () => {
    vi.useFakeTimers();
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return {
          ...DEVICE_CODE_RESPONSE,
          json: {
            ...DEVICE_CODE_RESPONSE.json,
            verification_uri_complete:
              "https://microsoft.com/devicelogin?otc=ABCDEFGHI",
          },
        } as obsidian.RequestUrlResponse;
      }
      return pendingTokenResponse() as obsidian.RequestUrlResponse;
    });

    const attempt = await auth.beginDeviceCodeLogin();

    expect(attempt.verificationUriComplete).toBe(
      "https://microsoft.com/devicelogin?otc=ABCDEFGHI",
    );
    expect(auth.deviceAttempt?.verificationUriComplete).toBe(
      "https://microsoft.com/devicelogin?otc=ABCDEFGHI",
    );
    await vi.advanceTimersByTimeAsync(5000); // drain the first poll tick
  });

  it("completes the shared login tail when the poll returns tokens", async () => {
    vi.useFakeTimers();
    const secretSet = vi.fn().mockResolvedValue(undefined);
    const onFreshLogin = vi.fn();
    const ctx = makeContext({
      secretStorage: {
        set: secretSet,
        get: vi.fn().mockResolvedValue(null),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      onFreshLogin,
    });
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      if (options.url.includes("/oauth2/v2.0/token")) {
        return {
          status: 200,
          headers: {},
          json: {
            access_token: "device-access-token",
            refresh_token: "device-refresh-token",
            expires_in: 3600,
            scope: "User.Read offline_access",
          },
        } as obsidian.RequestUrlResponse;
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "Device User", id: "device-account" },
      } as obsidian.RequestUrlResponse;
    });
    const auth = new AuthModule(ctx);

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000);

    expect(secretSet).toHaveBeenCalledWith(
      "easy-sync-onedrive-refresh-token",
      "device-refresh-token",
    );
    expect(onFreshLogin).toHaveBeenCalledOnce();
    expect(auth.authState).toMatchObject({
      isLoggedIn: true,
      accountId: "device-account",
      displayName: "Device User",
    });
    expect(auth.deviceAttempt).toBeNull();
    expect(auth.isPending).toBe(false);
  });

  it("marks the attempt declined when the provider reports authorization_declined", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return {
        status: 400,
        headers: {},
        json: { error: "authorization_declined" },
      } as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000);

    expect(auth.deviceAttempt?.phase).toBe("declined");
    expect(auth.isPending).toBe(false);
    const callsAfterDecline = tokenCalls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls).toBe(callsAfterDecline);
  });

  it("marks the attempt expired once the code deadline passes", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return {
          ...DEVICE_CODE_RESPONSE,
          json: { ...DEVICE_CODE_RESPONSE.json, expires_in: 12 },
        } as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return pendingTokenResponse() as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000); // poll 1 (still valid)
    await vi.advanceTimersByTimeAsync(5000); // poll 2 (still valid)
    expect(tokenCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(5000); // tick at 15s — deadline passed
    expect(auth.deviceAttempt?.phase).toBe("expired");
    expect(auth.isPending).toBe(false);
    expect(tokenCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls).toBe(2);
  });

  it("grows the poll interval on slow_down", async () => {
    vi.useFakeTimers();
    const tokenCalls: number[] = [];
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls.push(Date.now());
      return {
        status: 400,
        headers: {},
        json: { error: tokenCalls.length === 1 ? "slow_down" : "authorization_pending" },
      } as obsidian.RequestUrlResponse;
    });

    const start = Date.now();
    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenCalls).toHaveLength(1);

    // interval grew 5000 → 10000ms; nothing more at t+5s
    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[1] - start).toBe(15_000);
  });

  it("keeps polling through transient network errors and completes afterwards", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = new AuthModule(makeContext());
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      if (tokenCalls === 1) throw new Error("offline");
      if (options.url.includes("/oauth2/v2.0/token")) {
        return {
          status: 200,
          headers: {},
          json: {
            access_token: "device-access-token",
            refresh_token: "device-refresh-token",
            expires_in: 3600,
            scope: "User.Read offline_access",
          },
        } as obsidian.RequestUrlResponse;
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "Device User", id: "device-account" },
      } as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000); // poll 1 — network error
    expect(auth.deviceAttempt?.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(5000); // poll 2 — success
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.deviceAttempt).toBeNull();
  });

  it("marks mismatch when the provider reports bad_verification_code", async () => {
    vi.useFakeTimers();
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      return {
        status: 400,
        headers: {},
        json: { error: "bad_verification_code" },
      } as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000);

    expect(auth.deviceAttempt?.phase).toBe("mismatch");
    expect(auth.isPending).toBe(false);
  });

  it("marks expired when the provider reports expired_token", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return {
        status: 400,
        headers: {},
        json: { error: "expired_token" },
      } as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000);

    expect(auth.deviceAttempt?.phase).toBe("expired");
    expect(auth.isPending).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls).toBe(1);
  });

  it("stops polling with a generic failure phase on unexpected provider errors", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return {
        status: 500,
        headers: {},
        json: { error: "server_error" },
      } as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000);

    expect(auth.deviceAttempt?.phase).toBe("failed");
    expect(auth.isPending).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls).toBe(1);
  });

  it("cancels the attempt and stops all polling", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return pendingTokenResponse() as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    auth.cancelPendingLogin();

    expect(auth.deviceAttempt).toBeNull();
    expect(auth.isPending).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls).toBe(0);
  });

  it("replaces the previous attempt when regenerating", async () => {
    vi.useFakeTimers();
    const tokenCalls: string[] = [];
    let deviceCodeRequests = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        deviceCodeRequests += 1;
        return {
          ...DEVICE_CODE_RESPONSE,
          json: {
            ...DEVICE_CODE_RESPONSE.json,
            device_code: `device-secret-${deviceCodeRequests}`,
            user_code: deviceCodeRequests === 1 ? "ABCDEFGHI" : "JKLMNOPQR",
          },
        } as obsidian.RequestUrlResponse;
      }
      tokenCalls.push(String(options.body));
      return pendingTokenResponse() as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await auth.beginDeviceCodeLogin();

    expect(deviceCodeRequests).toBe(2);
    expect(auth.deviceAttempt?.userCode).toBe("JKLMNOPQR");

    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]).toContain("device_code=device-secret-2");
  });

  it("clears a device attempt on logout and stops polling", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return pendingTokenResponse() as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await expect(auth.logout()).resolves.toBe(true);

    expect(auth.deviceAttempt).toBeNull();
    expect(auth.isPending).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tokenCalls).toBe(0);
  });

  it("does not commit a stale poll result after the attempt is replaced", async () => {
    vi.useFakeTimers();
    const secretSet = vi.fn().mockResolvedValue(undefined);
    const token = deferred<obsidian.RequestUrlResponse>();
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: secretSet,
        get: vi.fn().mockResolvedValue(null),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    }));
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      return token.promise;
    });

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000); // poll in flight
    auth.cancelPendingLogin();
    token.resolve({
      status: 200,
      headers: {},
      json: {
        access_token: "stale-device-token",
        refresh_token: "stale-device-refresh",
        expires_in: 3600,
        scope: "User.Read offline_access",
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(secretSet).not.toHaveBeenCalled();
    expect(auth.authState.isLoggedIn).toBe(false);
    expect(auth.deviceAttempt).toBeNull();
  });

  it("runs an immediate poll on manual check and keeps the chain alive", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return pendingTokenResponse() as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    expect(tokenCalls).toBe(0);

    await expect(auth.checkDeviceCodeNow()).resolves.toBe(true);
    expect(tokenCalls).toBe(1);
    expect(auth.deviceAttempt?.phase).toBe("waiting");

    // The one-shot chain rescheduled itself after the manual tick.
    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenCalls).toBe(2);
  });

  it("respects a minimum gap between immediate checks against focus storms", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return pendingTokenResponse() as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await expect(auth.checkDeviceCodeNow()).resolves.toBe(true);
    expect(tokenCalls).toBe(1);

    // Immediately after a tick the manual check is a no-op — no provider spam.
    await expect(auth.checkDeviceCodeNow()).resolves.toBe(false);
    expect(tokenCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(auth.checkDeviceCodeNow()).resolves.toBe(true);
    expect(tokenCalls).toBe(2);
  });

  it("awaits an in-flight tick instead of racing a manual check", async () => {
    vi.useFakeTimers();
    const token = deferred<obsidian.RequestUrlResponse>();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return token.promise;
    });

    await auth.beginDeviceCodeLogin();
    const check = auth.checkDeviceCodeNow();
    const racing = auth.checkDeviceCodeNow(); // shares the in-flight tick
    expect(tokenCalls).toBe(1);

    token.resolve(pendingTokenResponse());
    await expect(check).resolves.toBe(true);
    await expect(racing).resolves.toBe(false);
    expect(tokenCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tokenCalls).toBe(2);
  });

  it("skips manual checks without a waiting device attempt", async () => {
    const auth = makeAuth(async () => {
      throw new Error("unexpected request");
    });

    await expect(auth.checkDeviceCodeNow()).resolves.toBe(false);
  });

  it("does not poll a terminal attempt on manual check", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    const auth = makeAuth(async (options) => {
      if (options.url.includes("/oauth2/v2.0/devicecode")) {
        return DEVICE_CODE_RESPONSE as obsidian.RequestUrlResponse;
      }
      tokenCalls += 1;
      return {
        status: 400,
        headers: {},
        json: { error: "authorization_declined" },
      } as obsidian.RequestUrlResponse;
    });

    await auth.beginDeviceCodeLogin();
    await vi.advanceTimersByTimeAsync(5000);
    expect(auth.deviceAttempt?.phase).toBe("declined");

    await expect(auth.checkDeviceCodeNow()).resolves.toBe(false);
    expect(tokenCalls).toBe(1);
  });
});

describe("AuthModule login persistence (transient refresh failures)", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeDiagnostics(): never {
    return {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never;
  }

  it("keeps the session and the stored credential when silent refresh fails transiently", async () => {
    let storedToken: string | null = "stored-refresh-token";
    const remove = vi.fn(async () => {
      storedToken = null;
    });
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        throw new Error("network unreachable");
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "Offline User", id: "offline-account" },
      };
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async () => storedToken),
        remove,
      },
      diag: makeDiagnostics(),
    }));

    // Cold start while offline: the restore refresh fails transiently, but the
    // stored session is marked present instead of "logged out".
    await auth.initialize();
    expect(auth.authState.isLoggedIn).toBe(true);

    // A sync round refresh fails transiently again: no logout, no credential
    // deletion, and the session stays present for a later retry.
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      type: "NetworkError",
    });
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(storedToken).toBe("stored-refresh-token");
  });

  it("logs out and deletes the credential when refresh is structurally rejected (invalid_grant)", async () => {
    vi.useFakeTimers();
    let storedToken: string | null = "stored-refresh-token";
    let tokenCalls = 0;
    const remove = vi.fn(async () => {
      storedToken = null;
    });
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        tokenCalls++;
        if (tokenCalls === 1) {
          return {
            status: 200,
            headers: {},
            json: {
              access_token: "first-at",
              refresh_token: "rotated-rt",
              expires_in: 3600,
            },
          };
        }
        return {
          status: 400,
          headers: {},
          json: {
            error: "invalid_grant",
            error_description: "AADSTS700082: The refresh token has expired due to inactivity.",
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "Bound User", id: "bound-account" },
      };
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async () => storedToken),
        remove,
      },
      diag: makeDiagnostics(),
    }));

    await auth.initialize();
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.accountId).toBe("bound-account");

    // Expire the 1h access token (with its 60s buffer).
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));

    await expect(auth.getAccessToken()).rejects.toMatchObject({
      type: "CredentialsRevoked",
    });
    expect(auth.authState.isLoggedIn).toBe(false);
    expect(auth.authState.accountId).toBe("");
    expect(remove).toHaveBeenCalled();
    expect(storedToken).toBeNull();
  });

  it("backs off after a transient refresh failure instead of hammering the token endpoint", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    let storedToken: string | null = "stored-refresh-token";
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        tokenCalls++;
        throw new Error("still offline");
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "U", id: "a" },
      };
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async () => storedToken),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      diag: makeDiagnostics(),
    }));

    await auth.initialize(); // transient restore failure (1 token request)
    await expect(auth.getAccessToken()).rejects.toMatchObject({
      type: "NetworkError",
    });
    const callsAfterFirstFailure = tokenCalls;

    await expect(auth.getAccessToken()).rejects.toMatchObject({
      type: "NetworkError",
    });
    expect(tokenCalls).toBe(callsAfterFirstFailure); // inside backoff: no HTTP
  });

  it("recovers automatically after the backoff window and binds the account via /me", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    let tokenCalls = 0;
    let storedToken: string | null = "stored-refresh-token";
    let meCalls = 0;
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        tokenCalls++;
        if (tokenCalls <= 2) throw new Error("network down");
        return {
          status: 200,
          headers: {},
          json: { access_token: "fresh-at", expires_in: 3600 },
        };
      }
      if (options.url.includes("graph.microsoft.com/v1.0/me")) {
        meCalls++;
        return {
          status: 200,
          headers: {},
          json: { displayName: "Recovered User", id: "recovered-account" },
        };
      }
      return { status: 200, headers: {}, json: {} };
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async () => storedToken),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      diag: makeDiagnostics(),
    }));

    await auth.initialize(); // cold start offline — session present, no account
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.accountId).toBe("");

    await expect(auth.getAccessToken()).rejects.toMatchObject({
      type: "NetworkError",
    });
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.accountId).toBe("");

    vi.advanceTimersByTime(60_000); // past the 15s backoff window

    await expect(auth.getAccessToken()).resolves.toBe("fresh-at");
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.accountId).toBe("recovered-account");
    expect(meCalls).toBeGreaterThan(0);
  });

  it("recovers a pending session via refreshNowIfNeeded on connectivity events", async () => {
    vi.useFakeTimers();
    let tokenCalls = 0;
    let storedToken: string | null = "stored-refresh-token";
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        tokenCalls++;
        if (tokenCalls === 1) throw new Error("network down");
        return {
          status: 200,
          headers: {},
          json: { access_token: "online-at", expires_in: 3600 },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "Online User", id: "online-account" },
      };
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async () => storedToken),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      diag: makeDiagnostics(),
    }));

    await auth.initialize(); // cold start offline — pending session
    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.accountId).toBe("");

    await auth.refreshNowIfNeeded(true); // simulated window "online" event

    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.accountId).toBe("online-account");
    await expect(auth.getAccessToken()).resolves.toBe("online-at");
  });

  it("logs out when a connectivity-triggered refresh is structurally rejected", async () => {
    vi.useFakeTimers();
    let storedToken: string | null = "stored-refresh-token";
    const remove = vi.fn(async () => {
      storedToken = null;
    });
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.includes("/oauth2/v2.0/token")) {
        return {
          status: 400,
          headers: {},
          json: {
            error: "invalid_grant",
            error_description: "AADSTS700082: The refresh token has expired.",
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { displayName: "U", id: "a" },
      };
    });
    const auth = new AuthModule(makeContext({
      secretStorage: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async () => storedToken),
        remove,
      },
      diag: makeDiagnostics(),
    }));

    await auth.initialize(); // restore hits invalid_grant → session ends
    expect(auth.authState.isLoggedIn).toBe(false);
    expect(remove).toHaveBeenCalled();
    expect(storedToken).toBeNull();

    await auth.refreshNowIfNeeded(true); // no credential — stays logged out
    expect(auth.authState.isLoggedIn).toBe(false);
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
