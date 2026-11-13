import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { AuthModule, type AuthPluginContext } from "../src/auth/auth-module";
import {
  SS_CREDENTIAL_ID,
  SS_REFRESH_TOKEN,
  isAccountCredentialBindingV1,
  type AccountCredentialBindingV1,
} from "../src/auth/types";

const ACCOUNT_ID = "account-a";
const DRIVE_ID = "drive-a";

vi.mock("../src/auth/pkce", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/pkce")>(
    "../src/auth/pkce",
  );
  return {
    ...actual,
    generateCodeVerifier: vi.fn(() => "verifier-fixed"),
    generateCodeChallengeSync: vi.fn(() => "challenge-fixed"),
    generateState: vi.fn(() => "state-fixed"),
  };
});

function response(
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
): obsidian.RequestUrlResponse {
  return {
    status,
    headers,
    json,
    text: JSON.stringify(json),
    arrayBuffer: new ArrayBuffer(0),
  } as obsidian.RequestUrlResponse;
}

function makeSecretStore(initial: {
  refreshToken?: string | null;
  credentialId?: string | null;
} = {}) {
  let refreshToken = initial.refreshToken ?? null;
  let credentialId = initial.credentialId ?? null;
  const secretStorage = {
    get: vi.fn(async (key: string) => {
      if (key === SS_REFRESH_TOKEN) return refreshToken;
      if (key === SS_CREDENTIAL_ID) return credentialId;
      return null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      if (key === SS_REFRESH_TOKEN) refreshToken = value;
      else if (key === SS_CREDENTIAL_ID) credentialId = value;
    }),
    remove: vi.fn(async (key: string) => {
      if (key === SS_REFRESH_TOKEN) refreshToken = null;
      else if (key === SS_CREDENTIAL_ID) credentialId = null;
    }),
  };
  return {
    secretStorage,
    current: () => ({ refreshToken, credentialId }),
  };
}

function makeBindingStore(initial: AccountCredentialBindingV1 | null = null) {
  let current = initial;
  return {
    get: vi.fn(async () => current),
    set: vi.fn(async (binding: AccountCredentialBindingV1) => {
      current = binding;
    }),
    clear: vi.fn(async (expectedCredentialId?: string) => {
      if (expectedCredentialId && current?.credentialId !== expectedCredentialId) {
        return;
      }
      current = null;
    }),
    current: () => current,
  };
}

function makeProfileCache(profile: { displayName: string; accountId: string } | null) {
  return {
    get: vi.fn(async () => profile),
    set: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

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

function tokenOk(accessToken = "access-token", refreshToken = "rt-1") {
  return response(200, {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: "User.Read offline_access Files.ReadWrite.AppFolder Files.Read",
  });
}

function meOk(accountId = ACCOUNT_ID) {
  return response(200, { displayName: "User A", id: accountId });
}

function driveOk(id = DRIVE_ID) {
  return response(200, { id });
}

function mockGraph(handlers: {
  token?: () => obsidian.RequestUrlResponse;
  me: () => obsidian.RequestUrlResponse;
  drive?: () => obsidian.RequestUrlResponse;
}) {
  return vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
    const url = String(options.url);
    if (url.includes("/oauth2/v2.0/token")) {
      return handlers.token ? handlers.token() : tokenOk();
    }
    if (url.includes("/me/drive")) {
      return handlers.drive ? handlers.drive() : driveOk();
    }
    if (url.includes("/me?")) {
      return handlers.me();
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

function countingMe(factory: () => obsidian.RequestUrlResponse) {
  let calls = 0;
  return {
    handler: () => {
      calls += 1;
      return factory();
    },
    calls: () => calls,
  };
}

describe("AuthModule verified-account credential binding", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("adopts the bound account when /me fails transiently and the credential lineage matches", async () => {
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    const binding = makeBindingStore({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-1",
      verifiedAt: 1,
    });
    mockGraph({ me: () => response(502, { error: { code: "UnknownError" } }) });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache({ displayName: "User A", accountId: ACCOUNT_ID }),
    }));

    await auth.initialize();

    expect(auth.authState.isLoggedIn).toBe(true);
    expect(auth.authState.accountId).toBe(ACCOUNT_ID);
    expect(auth.accountVerificationSource).toBe("credential-binding");
    expect(auth.isSessionPending).toBe(false);
  });

  it("does not adopt a binding recorded for a different credential lineage", async () => {
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-new",
    });
    const binding = makeBindingStore({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-old",
      verifiedAt: 1,
    });
    mockGraph({ me: () => response(502, { error: { code: "UnknownError" } }) });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache({ displayName: "User A", accountId: ACCOUNT_ID }),
    }));

    await auth.initialize();

    expect(auth.authState.accountId).toBe("");
    expect(auth.isSessionPending).toBe(true);
    expect(auth.accountVerificationSource).toBe("none");
  });

  it("never adopts a binding after an auth rejection", async () => {
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    const binding = makeBindingStore({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-1",
      verifiedAt: 1,
    });
    mockGraph({ me: () => response(401, { error: { code: "InvalidAuthenticationToken" } }) });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache({ displayName: "User A", accountId: ACCOUNT_ID }),
    }));

    await auth.initialize();

    expect(auth.authState.accountId).toBe("");
    expect(auth.isSessionPending).toBe(true);
  });

  it("writes the binding after a live /me verification", async () => {
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    const binding = makeBindingStore(null);
    mockGraph({ me: () => meOk() });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache(null),
    }));

    await auth.initialize();

    expect(auth.authState.accountId).toBe(ACCOUNT_ID);
    expect(auth.accountVerificationSource).toBe("me");
    expect(binding.set).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-1",
    }));
    expect(binding.current()?.accountId).toBe(ACCOUNT_ID);
  });

  it("labels a legacy credential lazily and records the generated lineage", async () => {
    const secrets = makeSecretStore({ refreshToken: "rt-1", credentialId: null });
    const binding = makeBindingStore(null);
    mockGraph({ me: () => meOk() });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache(null),
    }));

    await auth.initialize();

    const stored = secrets.current();
    expect(stored.credentialId).toBeTruthy();
    expect(binding.current()?.credentialId).toBe(stored.credentialId);
  });

  it("removes the lineage and clears the binding on logout", async () => {
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    const binding = makeBindingStore({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-1",
      verifiedAt: 1,
    });
    mockGraph({ me: () => meOk() });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache(null),
    }));
    await auth.initialize();

    await expect(auth.logout()).resolves.toBe(true);

    expect(secrets.current().refreshToken).toBeNull();
    expect(secrets.current().credentialId).toBeNull();
    expect(binding.clear).toHaveBeenCalledWith("lineage-1");
    expect(binding.current()).toBeNull();
    expect(auth.authState.accountId).toBe("");
    expect(auth.accountVerificationSource).toBe("none");
  });

  it("rotates the lineage on a fresh login so an old binding cannot authorize the new credential", async () => {
    const secrets = makeSecretStore({
      refreshToken: null,
      credentialId: "lineage-old",
    });
    const binding = makeBindingStore({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-old",
      verifiedAt: 1,
    });
    let callback: ((params: Record<string, string>) => void) | undefined;
    mockGraph({ me: () => response(502, { error: { code: "UnknownError" } }) });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache({ displayName: "User A", accountId: ACCOUNT_ID }),
      registerProtocolHandler: (_action, handler) => {
        callback = handler;
      },
    }));
    await auth.initialize();
    await auth.login();
    callback?.({ code: "auth-code", state: "state-fixed" });

    await vi.waitFor(() => expect(secrets.current().refreshToken).toBe("rt-1"));

    expect(secrets.current().credentialId).not.toBe("lineage-old");
    expect(auth.authState.accountId).toBe("");
    expect(auth.isSessionPending).toBe(true);
    expect(binding.current()?.credentialId).toBe("lineage-old");
  });

  it("keeps the binding closed when the live /me response carries no id", async () => {
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    const binding = makeBindingStore({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-1",
      verifiedAt: 1,
    });
    mockGraph({ me: () => response(200, { displayName: "No Id" }) });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache(null),
    }));

    await auth.initialize();

    // A malformed success is treated as a provider anomaly; the matching
    // binding is the only reason the session can continue.
    expect(auth.authState.accountId).toBe(ACCOUNT_ID);
    expect(auth.accountVerificationSource).toBe("credential-binding");
  });
});

describe("AuthModule legacy credential bootstrap", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeBootstrapAuth(input: {
    cachedAccountId?: string;
    boundAccountId?: string;
    boundDriveId?: string;
    currentDriveId?: string;
    meStatus?: number;
  } = {}) {
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    const binding = makeBindingStore(null);
    mockGraph({
      me: () => response(input.meStatus ?? 502, { error: { code: "UnknownError" } }),
      drive: () => driveOk(input.currentDriveId ?? DRIVE_ID),
    });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: binding,
      profileCache: makeProfileCache({
        displayName: "User A",
        accountId: input.cachedAccountId ?? ACCOUNT_ID,
      }),
      vaultIdentity: {
        getBoundAccountId: () => input.boundAccountId ?? ACCOUNT_ID,
        getBoundDriveId: () => input.boundDriveId ?? DRIVE_ID,
      },
    }));
    return { auth, binding, secrets };
  }

  it("bootstraps only when cached account, bound account and current drive all agree", async () => {
    const { auth, binding } = makeBootstrapAuth();
    await auth.initialize();

    await expect(auth.tryBootstrapCredentialBinding()).resolves.toBe(true);

    expect(auth.authState.accountId).toBe(ACCOUNT_ID);
    expect(auth.accountVerificationSource).toBe("credential-bootstrap");
    expect(binding.set).toHaveBeenCalledWith(expect.objectContaining({
      accountId: ACCOUNT_ID,
      credentialId: "lineage-1",
    }));
  });

  it("refuses when the current token opens a different drive", async () => {
    const { auth } = makeBootstrapAuth({ currentDriveId: "drive-other" });
    await auth.initialize();

    await expect(auth.tryBootstrapCredentialBinding()).resolves.toBe(false);
    expect(auth.authState.accountId).toBe("");
  });

  it("refuses when the cached account does not match the vault binding", async () => {
    const { auth } = makeBootstrapAuth({ cachedAccountId: "account-other" });
    await auth.initialize();

    await expect(auth.tryBootstrapCredentialBinding()).resolves.toBe(false);
    expect(auth.authState.accountId).toBe("");
  });

  it("refuses when /me failed with an auth rejection rather than a provider outage", async () => {
    const { auth } = makeBootstrapAuth({ meStatus: 403 });
    await auth.initialize();

    await expect(auth.tryBootstrapCredentialBinding()).resolves.toBe(false);
    expect(auth.authState.accountId).toBe("");
  });
});

describe("AuthModule foreground verification retry", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries on the backoff cadence and stops once /me binds the account", async () => {
    vi.useFakeTimers();
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    let meCalls = 0;
    mockGraph({
      me: () => {
        meCalls += 1;
        return meCalls < 3 ? response(502, { error: { code: "UnknownError" } }) : meOk();
      },
    });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: makeBindingStore(null),
      profileCache: makeProfileCache(null),
    }));
    auth.setVerificationRetryActive(true);

    await auth.initialize();
    expect(auth.isSessionPending).toBe(true);
    expect(meCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(meCalls).toBe(2);
    expect(auth.isSessionPending).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(meCalls).toBe(3);
    expect(auth.authState.accountId).toBe(ACCOUNT_ID);
    expect(auth.isSessionPending).toBe(false);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(meCalls).toBe(3);
  });

  it("stops the chain after an auth rejection instead of hammering the provider", async () => {
    vi.useFakeTimers();
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    let meCalls = 0;
    mockGraph({
      me: () => {
        meCalls += 1;
        return response(401, { error: { code: "InvalidAuthenticationToken" } });
      },
    });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: makeBindingStore(null),
      profileCache: makeProfileCache(null),
    }));
    auth.setVerificationRetryActive(true);

    await auth.initialize();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(meCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(meCalls).toBe(2);
  });

  it("honors the provider Retry-After before the next attempt", async () => {
    vi.useFakeTimers();
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    let meCalls = 0;
    mockGraph({
      me: () => {
        meCalls += 1;
        return response(503, { error: { code: "ServiceUnavailable" } }, { "retry-after": "30" });
      },
    });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: makeBindingStore(null),
      profileCache: makeProfileCache(null),
    }));
    auth.setVerificationRetryActive(true);

    await auth.initialize();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(meCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(meCalls).toBe(2);
  });

  it("pauses the chain when the page is hidden and resumes when it is visible again", async () => {
    vi.useFakeTimers();
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    let meCalls = 0;
    mockGraph({
      me: () => {
        meCalls += 1;
        return response(502, { error: { code: "UnknownError" } });
      },
    });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: makeBindingStore(null),
      profileCache: makeProfileCache(null),
    }));
    auth.setVerificationRetryActive(true);
    await auth.initialize();
    expect(meCalls).toBe(1);

    auth.setVerificationRetryActive(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(meCalls).toBe(1);

    auth.setVerificationRetryActive(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(meCalls).toBe(2);
  });

  it("lets a manual verification attempt recover without waiting for the timer", async () => {
    const secrets = makeSecretStore({
      refreshToken: "rt-1",
      credentialId: "lineage-1",
    });
    let shouldFail = true;
    mockGraph({
      me: () => shouldFail
        ? response(502, { error: { code: "UnknownError" } })
        : meOk(),
    });
    const auth = new AuthModule(makeContext({
      secretStorage: secrets.secretStorage,
      accountBinding: makeBindingStore(null),
      profileCache: makeProfileCache(null),
    }));
    await auth.initialize();
    expect(auth.isSessionPending).toBe(true);

    shouldFail = false;
    await expect(auth.verifyAccountNow({ allowBootstrap: true })).resolves.toBe(true);
    expect(auth.authState.accountId).toBe(ACCOUNT_ID);
    expect(auth.isSessionPending).toBe(false);
  });
});

describe("isAccountCredentialBindingV1", () => {
  it("accepts only the complete version-1 shape", () => {
    expect(isAccountCredentialBindingV1({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-1",
      verifiedAt: 1,
    })).toBe(true);
    expect(isAccountCredentialBindingV1({
      version: 1,
      accountId: "",
      credentialId: "lineage-1",
      verifiedAt: 1,
    })).toBe(false);
    expect(isAccountCredentialBindingV1({
      version: 2,
      accountId: ACCOUNT_ID,
      credentialId: "lineage-1",
      verifiedAt: 1,
    })).toBe(false);
    expect(isAccountCredentialBindingV1(null)).toBe(false);
  });
});
