/**
 * WebDAV 运行时装配测试（W2b-1）。
 *
 * 钉四件事：
 * 1) 没有坐标 / 没有密码时不发起任何网络请求，直接给出稳定原因码；
 * 2) 引导成功时返回 provider ＋ 五字段 scope，并把身份账本状态带出来；
 * 3) 需要「接管」或「远端已有内容」时抛确认类错误，而不是静默继续；
 * 4) 同一份设置下重复 connect 复用缓存，`invalidate()` 之后重新引导。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createWebDavRuntime,
  WebDavRuntimeError,
  WebDavRuntimeNeedsConfirmationError,
} from "../src/cloud/webdav-runtime";
import {
  FakeWebDavServer,
  createLoopbackWebDavTransport,
  type FakeWebDavProfile,
} from "./helpers/fake-webdav";

const COORDINATES = {
  url: "https://webdav.test/dav",
  username: "probe",
  rootPrefix: "",
} as const;

async function withFake(
  run: (ctx: {
    fake: FakeWebDavServer;
    transport: ReturnType<typeof createLoopbackWebDavTransport>;
  }) => Promise<void>,
  options: {
    seed?: (fake: FakeWebDavServer) => void;
    profiles?: readonly FakeWebDavProfile[];
  } = {},
): Promise<void> {
  const fake = new FakeWebDavServer({
    rootPath: "/dav",
    username: "probe",
    password: "app-password",
    profiles: options.profiles,
  });
  const { port } = await fake.start();
  try {
    options.seed?.(fake);
    await run({ fake, transport: createLoopbackWebDavTransport({ port }) });
  } finally {
    await fake.stop();
  }
}

describe("WebDavRuntime", () => {
  it("refuses without coordinates and never calls the transport", async () => {
    const transport = vi.fn();
    const runtime = createWebDavRuntime({
      coordinates: null,
      readPassword: async () => "x",
      transport: transport as never,
      vaultName: "TestVault",
      localStatePresent: () => false,
    });
    await expect(runtime.connect()).rejects.toMatchObject({ reason: "not-configured" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses without a saved password and never calls the transport", async () => {
    const transport = vi.fn();
    const runtime = createWebDavRuntime({
      coordinates: { ...COORDINATES },
      readPassword: async () => null,
      transport: transport as never,
      vaultName: "TestVault",
      localStatePresent: () => false,
    });
    await expect(runtime.connect()).rejects.toMatchObject({ reason: "no-password" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns a provider and a five-field scope on a clean root", async () => {
    await withFake(async ({ transport }) => {
      const runtime = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "app-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => false,
      });
      const connection = await runtime.connect();
      expect(connection.provider).toBeDefined();
      // 五字段齐全（S0 provider 字段进 scope）。
      expect(connection.scope.providerKind).toBe("webdav");
      expect(connection.scope.endpointId).toBe("https://webdav.test");
      expect(connection.scope.rootPath).toBe("/dav");
      expect(connection.scope.vaultFolderId).toBe("/");
      expect(connection.scope.filesRootId).toBe("/");
      // 账本状态如实带出；没有信任端口时一律 unverified。
      expect(connection.identityState).toBe("unverified");
      expect(connection.ledgerTrusted).toBe(false);
      expect(runtime.peek()).toBe(connection);
    });
  });

  it("W2b-2：账本缺失会触发重建，落待确认标记，成功后清除并转正", async () => {
    await withFake(async ({ transport, fake }) => {
      let marker: Parameters<
        NonNullable<Parameters<typeof createWebDavRuntime>[0]["ledgerTrust"]>["write"]
      >[0] | null = null;
      let clears = 0;
      const runtime = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "app-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => false,
        ledgerTrust: {
          read: async () => marker,
          write: async (next) => {
            marker = next;
          },
          clear: async () => {
            clears += 1;
            marker = null;
          },
        },
      });
      const connection = await runtime.connect();
      // 干净根上没有账本 ⇒ 引导阶段重建 ⇒ 本机未确认。
      expect(connection.identityState).toBe("unverified");
      expect(connection.ledgerTrusted).toBe(false);
      expect(connection.provider.identityLedgerConfirmed).toBe(false);
      expect(marker).toMatchObject({
        kind: "webdav-ledger-rebuild-pending",
        scopeId: connection.scopeId,
      });
      // 重建确实写了远端账本（引导层的既有行为）。
      expect(fake.readText("/dav/.easy-sync/identity.json")).not.toBeNull();

      // 一轮成功同步之后：标记清除、身份推断打开。
      expect(await runtime.confirmAfterSuccessfulRound()).toBe(true);
      expect(clears).toBe(1);
      expect(marker).toBeNull();
      expect(runtime.peek()?.ledgerTrusted).toBe(true);
      expect(connection.provider.identityLedgerConfirmed).toBe(true);

      // 再调一次是幂等的：没有标记就不写盘、不改状态。
      expect(await runtime.confirmAfterSuccessfulRound()).toBe(false);
      expect(clears).toBe(1);
    });
  });

  it("W2b-2：待确认标记在位时，健康账本也不打开身份推断", async () => {
    // 先跑一次引导把账本建起来，再模拟「同一 scope 上有未确认的重建」。
    const fake = new FakeWebDavServer({
      rootPath: "/dav",
      username: "probe",
      password: "app-password",
    });
    const { port } = await fake.start();
    try {
      const transport = createLoopbackWebDavTransport({ port });
      const first = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "app-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => false,
      });
      const bootstrapped = await first.connect();
      const scopeId = bootstrapped.scopeId;

      const runtime = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "app-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => true,
        ledgerTrust: {
          read: async () => ({
            schemaVersion: 1,
            kind: "webdav-ledger-rebuild-pending",
            scopeId,
            entriesDigest: "d".repeat(64),
            eTag: "",
            recordedAt: 1,
          }),
          write: async () => undefined,
          clear: async () => undefined,
        },
      });
      const connection = await runtime.connect();
      // 远端账本此刻是 verified 且强 ETag 在位，但本机有未确认的重建。
      expect(connection.identityState).toBe("unverified");
      expect(connection.ledgerTrusted).toBe(false);
      expect(connection.provider.identityLedgerConfirmed).toBe(false);
    } finally {
      await fake.stop();
    }
  });

  it("W2b-2：别处 scope 的待确认标记不影响本 scope", async () => {
    const fake = new FakeWebDavServer({
      rootPath: "/dav",
      username: "probe",
      password: "app-password",
    });
    const { port } = await fake.start();
    try {
      const transport = createLoopbackWebDavTransport({ port });
      const warmup = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "app-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => false,
      });
      await warmup.connect();

      const runtime = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "app-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => true,
        ledgerTrust: {
          read: async () => ({
            schemaVersion: 1,
            kind: "webdav-ledger-rebuild-pending",
            scopeId: "e".repeat(32),
            entriesDigest: "f".repeat(64),
            eTag: "",
            recordedAt: 1,
          }),
          write: async () => undefined,
          clear: async () => undefined,
        },
      });
      const connection = await runtime.connect();
      expect(connection.identityState).toBe("verified");
      expect(connection.ledgerTrusted).toBe(true);
      expect(connection.provider.identityLedgerConfirmed).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it("reuses the cached connection until invalidated", async () => {
    await withFake(async ({ transport, fake }) => {
      const readPassword = vi.fn(async () => "app-password");
      const runtime = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword,
        transport,
        vaultName: "TestVault",
        localStatePresent: () => false,
      });
      const first = await runtime.connect();
      const before = fake.requests.length;
      const second = await runtime.connect();
      expect(second).toBe(first);
      expect(readPassword).toHaveBeenCalledTimes(1);
      expect(fake.requests.length).toBe(before);

      runtime.invalidate();
      expect(runtime.peek()).toBeNull();
      const third = await runtime.connect();
      expect(third).not.toBe(first);
      expect(readPassword).toHaveBeenCalledTimes(2);
    });
  });

  it("surfaces a wrong password as a runtime error, not a confirmation", async () => {
    await withFake(async ({ transport }) => {
      const runtime = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "wrong-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => false,
      });
      await expect(runtime.connect()).rejects.toBeInstanceOf(WebDavRuntimeError);
    });
  });

  it("surfaces 503 BlockedTemporarily as rate-limited", async () => {
    await withFake(async ({ transport }) => {
      const runtime = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "app-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => false,
      });
      await expect(runtime.connect()).rejects.toMatchObject({
        name: "WebDavRuntimeError",
        reason: "rate-limited",
      });
    }, { profiles: ["blocked-temporarily"] });
  });

  it("asks for confirmation when the root already holds content", async () => {
    await withFake(async ({ transport }) => {
      const runtime = createWebDavRuntime({
        coordinates: { ...COORDINATES },
        readPassword: async () => "app-password",
        transport,
        vaultName: "TestVault",
        localStatePresent: () => false,
      });
      await expect(runtime.connect()).rejects.toBeInstanceOf(
        WebDavRuntimeNeedsConfirmationError,
      );
    }, { seed: (fake) => { fake.seedFile("/dav/existing.md", "hello"); } });
  });
});
