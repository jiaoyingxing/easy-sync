/**
 * W2b2b2：WebDAV 真实 StateManager 冷启动首同步／确认轮／次轮／重启。
 *
 * A. 首轮暂停：planReviewPaused、hold pending、reviewKind="v2-first-sync"，
 *    不创建协议对象、不写用户文件、零 DELETE。
 * B. 确认轮：生产调用形状（skipConfirmation＋reviewedAuthorization＋
 *    acknowledgeMigrationRisk）→ 创建 V2／V3、确认 hold、提交 authority、
 *    上传用户文件；V3 predecessor 字节证明 V2；V2 记录与首个 envelope 带
 *    WebDAV full scope 五字段。
 * C. 次轮零计划：uploaded／downloaded／deleted 0，协议 create 计数不增。
 * D. 重启：新 StateManager／client／provider 指向同一 fake，binding 与
 *    full scope 仍匹配。
 * E. 负向：删／篡改控制对象 → blocked，用户文件零动作，不自动重建。
 * F. 弱 ETag → 确认轮在协议绑定／用户上传前 fail-closed。
 * G. 并发首同步：只存在一套 V2/V3，失败方采纳赢家且不覆盖。
 * H. scope 负向：同 origin／同账号、不同 rootPath 的 full scope 不相等；
 *    换根后不能复用已提交状态（整轮 blocked）；不匹配的 providerScope
 *    不被引擎合并。
 *
 * 全部 fake：不接真实账号、不制造大文件／750 项真实请求。
 */
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  isSharedSyncProtocolBindingV3,
  parseSharedSyncProtocolV3,
} from "../src/sync/sync-protocol-v3";
import { parseSharedSyncProtocolV2 } from "../src/sync/sync-protocol-v2";
import { isSyncScope, sameSyncScope } from "../src/sync/types";
import {
  buildWebDavScopeFields,
  webDavScopeFieldsToSyncScope,
} from "../src/providers/webdav/webdav-scope";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_PATHS,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

/** 直接向 fake 读取控制对象的真实字节（不经过 provider）。 */
async function readControlObject(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
  path: string,
): Promise<{ bytes: ArrayBuffer; text: string; eTag: string | null } | null> {
  const snapshot = harness.remoteSnapshot(path);
  if (!snapshot) return null;
  const text = harness.remoteText(path);
  if (text === null) return null;
  return {
    bytes: new TextEncoder().encode(text).buffer,
    text,
    eTag: snapshot.eTag,
  };
}

describe("W2b2b2 B：确认轮", () => {
  it("生产确认形状：创建 V2/V3、确认 hold、提交 authority、上传用户文件并绑定 V3", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      const authorization = harness.state.planReviewAuthorization!;
      expect(authorization.reviewKind).toBe("v2-first-sync");

      const result = await harness.confirmRound(authorization);

      expect(result).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 1,
        downloaded: 0,
        deleted: 0,
      });
      // 远端用户文件字节。
      expect(
        harness.remoteText(`${harness.fake.rootPath}/note.md`),
      ).toBe("hello webdav cold start\n");

      // V2／V3 控制对象存在且可 parse。
      const v2 = await readControlObject(harness, harness.protocolPaths.v2);
      const v3 = await readControlObject(harness, harness.protocolPaths.v3);
      expect(v2).not.toBeNull();
      expect(v3).not.toBeNull();
      const parsedV2 = parseSharedSyncProtocolV2(v2!.text);
      const parsedV3 = JSON.parse(v3!.text) as {
        migrationGeneration: string;
        predecessor: { contentSha256: string; protocolVersion: number };
        createdAt: number;
      };
      expect(parsedV2).not.toBeNull();
      expect(parseSharedSyncProtocolV3(v3!.text)).not.toBeNull();
      expect(parsedV2!.migrationGeneration).toMatch(/^[0-9a-f]{64}$/);

      // V2 记录必须携带完整 WebDAV full scope（四元＋五个 provider 字段）。
      expect(parsedV2!.scope).toEqual(harness.scope);
      expect(parsedV2!.scope).toMatchObject({
        accountId: harness.scope.credentialBindingId,
        driveId: "https://webdav.test",
        vaultFolderId: "/",
        filesRootId: "/",
        providerKind: "webdav",
        endpointId: "https://webdav.test",
        containerId: "",
        rootPath: "/vault",
        credentialBindingId: harness.scope.credentialBindingId,
      });
      expect(sameSyncScope(parsedV2!.scope, harness.scope)).toBe(true);

      // 首个已提交 V2 envelope 也必须是 full scope。
      expect(harness.state.getCommittedV2Envelope()?.scope)
        .toEqual(harness.scope);

      // V3 predecessor 必须是 V2 控制对象的真实字节摘要。
      const v2Sha256 = await sha256Hex(v2!.bytes);
      expect(parsedV3.predecessor).toMatchObject({
        protocolVersion: 2,
        contentSha256: v2Sha256,
      });
      expect(parsedV3.migrationGeneration)
        .toBe(parsedV2!.migrationGeneration);

      // hold 已完成；authority 已提交。
      const hold = JSON.parse(
        harness.files.get(WEBDAV_COLD_START_PATHS.stateV2MigrationHoldFile)!,
      ) as { phase: string; reviewKind: string; scope: unknown };
      expect(hold).toMatchObject({
        phase: "completed",
        reviewKind: "v2-first-sync",
      });
      expect(hold.scope).toEqual(harness.scope);
      expect(harness.state.isV2StateActive).toBe(true);

      // V3 binding 指向真实远端控制对象（精确路径＋PROPFIND ETag）。
      const binding = await harness.state.getActiveV2ProtocolBinding();
      expect(isSharedSyncProtocolBindingV3(binding)).toBe(true);
      if (!isSharedSyncProtocolBindingV3(binding)) return;
      expect(binding.recordId).toBe(".easy-sync/protocol-v3.json");
      expect(binding.recordETag).toBe(v3!.eTag);
      expect(binding.migrationGeneration).toBe(parsedV2!.migrationGeneration);
      expect(binding.predecessorContentSha256).toBe(v2Sha256);
      expect(harness.scope.providerKind).toBe("webdav");

      // 用户文件写入发生在协议对象创建之后（provider 调用顺序）。
      const lastProtocolCreate = Math.max(
        ...harness.providerCalls
          .map((call, index) => ({ call, index }))
          .filter(({ call }) =>
            call.method === "createSharedSyncProtocolV2"
            || call.method === "createSharedSyncProtocolV3")
          .map(({ index }) => index),
      );
      const firstUpload = harness.providerCalls.findIndex(
        (call) => call.method === "uploadFile",
      );
      expect(firstUpload).toBeGreaterThan(lastProtocolCreate);
      expect(harness.fake.requests.some(
        (request) => request.decodedPath === `${harness.fake.rootPath}/note.md`,
      )).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});

describe("W2b2b2 C：次轮零计划", () => {
  it("确认后的普通轮：零文件动作、userFileChanges=none、协议 create 不增且观察读取发生", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      await harness.confirmRound();
      expect(harness.state.getCommittedV2Envelope()?.scope)
        .toEqual(harness.scope);
      const before = harness.protocolCallCounts();

      const result = await harness.runRound("manual");

      expect(result).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
      });
      expect(result.runFacts?.userFileChanges).toBe("none");
      expect(harness.state.getCommittedV2Envelope()?.scope)
        .toEqual(harness.scope);
      const after = harness.protocolCallCounts();
      expect(after.createV2).toBe(before.createV2);
      expect(after.createV3).toBe(before.createV3);
      expect(after.overwriteV2).toBe(0);
      // 每轮协议门必须真实观察控制对象，而不是靠缓存跳过。
      expect(after.observe).toBeGreaterThan(before.observe);
      expect(
        harness.fake.requests.filter(
          (request) =>
            request.method === "DELETE"
            && (
              request.decodedPath === `${harness.fake.rootPath}/note.md`
              || request.decodedPath === harness.protocolPaths.v2
              || request.decodedPath === harness.protocolPaths.v3
            ),
        ),
      ).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });
});

describe("W2b2b2 D：重启后 binding 仍匹配", () => {
  it("新 StateManager/client/provider 指向同一 fake：V3 binding 不变、普通轮零计划", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    let restarted: Awaited<ReturnType<typeof harness.restart>> | null = null;
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      await harness.confirmRound();
      const bindingBefore = await harness.state.getActiveV2ProtocolBinding();
      expect(isSharedSyncProtocolBindingV3(bindingBefore)).toBe(true);
      const v2Before = harness.remoteText(harness.protocolPaths.v2);
      const v3Before = harness.remoteText(harness.protocolPaths.v3);
      expect(v2Before).not.toBeNull();
      expect(v3Before).not.toBeNull();

      restarted = await harness.restart();

      expect(restarted.state.isV2StateActive).toBe(true);
      expect(restarted.state.getCommittedV2Envelope()?.scope)
        .toEqual(restarted.scope);
      const bindingAfter = await restarted.state.getActiveV2ProtocolBinding();
      expect(bindingAfter).toEqual(bindingBefore);
      if (!isSharedSyncProtocolBindingV3(bindingAfter)) return;
      expect(bindingAfter.recordId).toBe(".easy-sync/protocol-v3.json");
      expect(bindingAfter.recordETag)
        .toBe(restarted.remoteSnapshot(restarted.protocolPaths.v3)?.eTag);
      expect(restarted.remoteText(restarted.protocolPaths.v2)).toBe(v2Before);
      expect(restarted.remoteText(restarted.protocolPaths.v3)).toBe(v3Before);

      const createsBefore = restarted.protocolCallCounts();
      const result = await restarted.runRound("manual");
      expect(result).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(result.runFacts?.userFileChanges).toBe("none");
      expect(restarted.state.getCommittedV2Envelope()?.scope)
        .toEqual(restarted.scope);
      expect(restarted.protocolCallCounts().createV2)
        .toBe(createsBefore.createV2);
      expect(restarted.protocolCallCounts().createV3)
        .toBe(createsBefore.createV3);
      expect(restarted.remoteText(restarted.protocolPaths.v3)).toBe(v3Before);
    } finally {
      if (restarted) await restarted.dispose();
      else await harness.dispose();
    }
  });
});

async function confirmColdStart(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
): Promise<void> {
  expect((await harness.runRound("manual")).message)
    .toBe("result.pausedForReview");
  const confirmed = await harness.confirmRound();
  expect(confirmed).toMatchObject({ success: true, errors: 0, uploaded: 1 });
}

function userFileActions(result: Awaited<ReturnType<typeof createWebDavColdStartHarness>["runRound"]>) {
  return {
    uploaded: result.uploaded,
    downloaded: result.downloaded,
    deleted: result.deleted,
    conflicts: result.conflicts,
    filesMoved: result.filesMoved ?? 0,
  };
}

describe("W2b2b2 E：控制对象被删／篡改 fail-closed", () => {
  it("删除 V3：下一轮 blocked、用户文件零动作、V3 不自动重建", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await confirmColdStart(harness);
      expect(await harness.deleteRemote(harness.protocolPaths.v3)).toBe(204);
      expect(harness.remoteSnapshot(harness.protocolPaths.v3)).toBeNull();
      harness.resetProviderCalls();
      harness.fake.requests.length = 0;

      const result = await harness.runRound("manual");

      expect(result).toMatchObject({
        success: false,
        errors: 1,
        message: "result.v2ProtocolBlocked",
      });
      expect(userFileActions(result)).toEqual({
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        filesMoved: 0,
      });
      expect(harness.remoteSnapshot(harness.protocolPaths.v3)).toBeNull();
      expect(harness.protocolCallCounts()).toMatchObject({
        createV2: 0,
        createV3: 0,
        overwriteV2: 0,
      });
      expect(harness.remoteText(`${harness.fake.rootPath}/note.md`))
        .toBe("hello webdav cold start\n");
    } finally {
      await harness.dispose();
    }
  });
});

describe("W2b2b2 F：弱 ETag fail-closed", () => {
  it("weak-etag profile：确认轮在协议绑定成立前失败，用户文件零上传", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: ["weak-etag"],
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      expect(harness.state.planReviewAuthorization?.reviewKind)
        .toBe("v2-first-sync");
      harness.resetProviderCalls();
      harness.fake.requests.length = 0;

      const result = await harness.confirmRound();

      expect(result).toMatchObject({
        success: false,
        errors: 1,
        message: "result.v2ProtocolBlocked",
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(userFileActions(result)).toEqual({
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        filesMoved: 0,
      });
      // authority 未推进；没有任何可绑定的强 ETag 证据。
      expect(harness.state.isV2StateActive).toBe(false);
      expect(await harness.state.getActiveV2ProtocolBinding()).toBeNull();
      // 用户文件绝不因为协议绑定失败而被上传。
      expect(harness.providerCalls.some(
        (call) => call.method === "uploadFile",
      )).toBe(false);
      expect(harness.remoteSnapshot(
        `${harness.fake.rootPath}/note.md`,
      )).toBeNull();
      // 明确边界：V2 的 PUT 可以安全完成（条件创建不依赖强 ETag），
      // 但弱 ETag 使其无法成为绑定；V3 与用户上传都不得开始。
      const v2 = await readControlObject(harness, harness.protocolPaths.v2);
      expect(v2).not.toBeNull();
      expect(parseSharedSyncProtocolV2(v2!.text)).not.toBeNull();
      expect(harness.remoteSnapshot(harness.protocolPaths.v3)).toBeNull();
      expect(harness.providerCalls.some(
        (call) => call.method === "createSharedSyncProtocolV3",
      )).toBe(false);
      expect(harness.protocolCallCounts()).toMatchObject({
        createV3: 0,
        overwriteV2: 0,
      });
      // 失败后重新跑一轮仍不会上传用户文件。
      const retry = await harness.runRound("manual");
      expect(retry.uploaded).toBe(0);
      expect(harness.remoteSnapshot(
        `${harness.fake.rootPath}/note.md`,
      )).toBeNull();
    } finally {
      await harness.dispose();
    }
  });
});

describe("W2b2b2 H：full scope 身份负向", () => {
  it("同 origin／同账号、不同 rootPath 的两个 full scope 不相等", async () => {
    const fieldsA = await buildWebDavScopeFields({
      endpoint: "https://webdav.test/vaultA",
      username: "probe",
    });
    const fieldsB = await buildWebDavScopeFields({
      endpoint: "https://webdav.test/vaultB",
      username: "probe",
    });
    const scopeA = webDavScopeFieldsToSyncScope(fieldsA);
    const scopeB = webDavScopeFieldsToSyncScope(fieldsB);

    // 四元完全相同——这正是没有 providerScope 时会互相复用的原因。
    expect(scopeA.accountId).toBe(scopeB.accountId);
    expect(scopeA.driveId).toBe(scopeB.driveId);
    expect(scopeA.vaultFolderId).toBe(scopeB.vaultFolderId);
    expect(scopeA.filesRootId).toBe(scopeB.filesRootId);
    // full scope 只用 rootPath 区分两个根；sameSyncScope 必须拒绝复用。
    expect(scopeA.rootPath).toBe("/vaultA");
    expect(scopeB.rootPath).toBe("/vaultB");
    expect(isSyncScope(scopeA)).toBe(true);
    expect(isSyncScope(scopeB)).toBe(true);
    expect(sameSyncScope(scopeA, scopeB)).toBe(false);
  });

  it("不同 rootPath 不能复用已提交状态：换成另一根后整轮 blocked、零用户动作", async () => {
    const source = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    let target: Awaited<ReturnType<typeof createWebDavColdStartHarness>> | null = null;
    try {
      await confirmColdStart(source);
      expect(source.state.getCommittedV2Envelope()?.scope)
        .toEqual(source.scope);

      // 同一个本地 vault／plugin data／V2 状态，换成另一个远端根。
      target = await createWebDavColdStartHarness({
        profiles: NUTSTORE_PROFILES,
        endpoint: "https://webdav.test/vaultB",
        rootPath: "/vaultB",
        localFiles: Object.fromEntries(source.files),
        localFolders: [...source.localFolderPaths],
        pluginData: structuredClone(source.pluginData),
      });
      expect(target.scope.rootPath).toBe("/vaultB");
      expect(sameSyncScope(source.scope, target.scope)).toBe(false);

      const result = await target.runRound("manual");

      expect(result).toMatchObject({
        success: false,
        errors: 1,
        message: "result.v2ProtocolBlocked",
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(target.remoteSnapshot(`${target.fake.rootPath}/note.md`))
        .toBeNull();
      expect(target.fake.listPaths()).toEqual([
        "/",
        "/vaultB",
      ]);
    } finally {
      if (target) await target.dispose();
      await source.dispose();
    }
  });

  it("不匹配的 providerScope 不被引擎合并：首同步 V2 仍是四元", async () => {
    const otherScope = webDavScopeFieldsToSyncScope(
      await buildWebDavScopeFields({
        endpoint: "https://other.example/vault",
        username: "probe",
      }),
    );
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      executorProviderScope: otherScope,
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      const result = await harness.confirmRound();
      expect(result).toMatchObject({ success: true, errors: 0, uploaded: 1 });

      const v2 = parseSharedSyncProtocolV2(
        harness.remoteText(harness.protocolPaths.v2)!,
      );
      expect(v2).not.toBeNull();
      expect(v2!.scope).toEqual({
        accountId: harness.scope.accountId,
        driveId: harness.scope.driveId,
        vaultFolderId: "/",
        filesRootId: "/",
      });
      expect(v2!.scope.providerKind).toBeUndefined();
      expect(harness.state.getCommittedV2Envelope()?.scope)
        .toEqual(v2!.scope);
    } finally {
      await harness.dispose();
    }
  });
});

describe("W2b2b2 G：并发首同步", () => {
  it("两台设备同时首同步：只存在一套 V2/V3；失败方采纳赢家且不覆盖", async () => {
    const deviceA = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      localFiles: { "a.md": "from device A\n" },
    });
    let deviceB: Awaited<ReturnType<typeof createWebDavColdStartHarness>> | null = null;
    try {
      deviceB = await createWebDavColdStartHarness({
        server: deviceA.fake,
        transport: deviceA.transport,
        port: deviceA.port,
        profiles: NUTSTORE_PROFILES,
        localFiles: { "b.md": "from device B\n" },
      });
      // 两台设备都在空远端上得到 first-sync 计划并暂停。
      expect((await deviceA.runRound("manual")).message)
        .toBe("result.pausedForReview");
      expect((await deviceB.runRound("manual")).message)
        .toBe("result.pausedForReview");
      expect(deviceA.state.planReviewAuthorization?.reviewKind)
        .toBe("v2-first-sync");
      expect(deviceB.state.planReviewAuthorization?.reviewKind)
        .toBe("v2-first-sync");

      // A 先确认：创建唯一一套 V2/V3 并上传 a.md。
      const winner = await deviceA.confirmRound();
      expect(winner).toMatchObject({ success: true, errors: 0, uploaded: 1 });
      const v2Bytes = deviceA.remoteText(deviceA.protocolPaths.v2);
      const v3Bytes = deviceA.remoteText(deviceA.protocolPaths.v3);
      expect(v2Bytes).not.toBeNull();
      expect(v3Bytes).not.toBeNull();
      const winnerBinding = await deviceA.state.getActiveV2ProtocolBinding();
      expect(isSharedSyncProtocolBindingV3(winnerBinding)).toBe(true);
      deviceB.resetProviderCalls();

      // B 的旧计划因远端出现 a.md 而需要再次审阅；逐次确认直到成功。
      let loser = await deviceB.confirmRound();
      for (
        let round = 0;
        round < 4 && !loser.success;
        round++
      ) {
        expect(loser.message).toBe("result.pausedForReview");
        loser = await deviceB.confirmRound();
      }
      expect(loser).toMatchObject({ success: true, errors: 0 });

      // 失败方没有创建／覆盖任何协议对象，而是采纳赢家的 V3 binding。
      expect(deviceB.protocolCallCounts()).toMatchObject({
        createV2: 0,
        createV3: 0,
        overwriteV2: 0,
      });
      expect(deviceA.protocolCallCounts()).toMatchObject({
        createV2: 1,
        createV3: 1,
        overwriteV2: 0,
      });
      expect(deviceB.remoteText(deviceB.protocolPaths.v2)).toBe(v2Bytes);
      expect(deviceB.remoteText(deviceB.protocolPaths.v3)).toBe(v3Bytes);
      const loserBinding = await deviceB.state.getActiveV2ProtocolBinding();
      expect(loserBinding).toEqual(winnerBinding);
      if (!isSharedSyncProtocolBindingV3(loserBinding)) return;
      expect(loserBinding.recordId).toBe(".easy-sync/protocol-v3.json");
      expect(loserBinding.recordETag)
        .toBe(deviceB.remoteSnapshot(deviceB.protocolPaths.v3)?.eTag);
      expect(loserBinding.migrationGeneration)
        .toBe(parseSharedSyncProtocolV2(v2Bytes!)!.migrationGeneration);

      // 两端用户文件都在，且没有重复协议对象。
      expect(deviceA.remoteText(`${deviceA.fake.rootPath}/a.md`))
        .toBe("from device A\n");
      expect(deviceB.remoteText(`${deviceB.fake.rootPath}/b.md`))
        .toBe("from device B\n");
      expect(deviceA.state.getCommittedV2Envelope()?.scope)
        .toEqual(deviceA.scope);
      expect(deviceB.state.getCommittedV2Envelope()?.scope)
        .toEqual(deviceB.scope);
      expect(deviceB.fake.listPaths().filter(
        (path) => path.includes("protocol-"),
      )).toEqual([
        `${deviceB.fake.rootPath}/.easy-sync/protocol-v2.json`,
        `${deviceB.fake.rootPath}/.easy-sync/protocol-v3.json`,
      ]);
    } finally {
      if (deviceB) await deviceB.dispose();
      await deviceA.dispose();
    }
  });
});

describe("W2b2b2 A：首轮暂停", () => {
  it("删除 V2（V3 binding 仍在）：blocked、不伪造 V2、用户文件零动作", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await confirmColdStart(harness);
      expect(await harness.deleteRemote(harness.protocolPaths.v2)).toBe(204);
      expect(harness.remoteSnapshot(harness.protocolPaths.v2)).toBeNull();
      expect(harness.remoteSnapshot(harness.protocolPaths.v3)).not.toBeNull();
      harness.resetProviderCalls();
      harness.fake.requests.length = 0;

      const result = await harness.runRound("manual");

      expect(result).toMatchObject({
        success: false,
        errors: 1,
        message: "result.v2ProtocolBlocked",
      });
      expect(userFileActions(result)).toEqual({
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        filesMoved: 0,
      });
      // 不自动重建／伪造 V2；V3 原样保留。
      expect(harness.remoteSnapshot(harness.protocolPaths.v2)).toBeNull();
      expect(harness.remoteSnapshot(harness.protocolPaths.v3)).not.toBeNull();
      expect(harness.protocolCallCounts()).toMatchObject({
        createV2: 0,
        createV3: 0,
        overwriteV2: 0,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("篡改 V3 内容：blocked、不覆盖篡改字节、用户文件零动作", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await confirmColdStart(harness);
      const v3 = harness.remoteSnapshot(harness.protocolPaths.v3);
      expect(v3).not.toBeNull();
      expect(await harness.putRemote(
        harness.protocolPaths.v3,
        JSON.stringify({ schemaVersion: 1, tampered: true }),
        { ifMatch: v3!.eTag },
      )).toBe(204);
      const tampered = harness.remoteText(harness.protocolPaths.v3);
      expect(tampered).toContain("tampered");
      harness.resetProviderCalls();
      harness.fake.requests.length = 0;

      const result = await harness.runRound("manual");

      expect(result).toMatchObject({
        success: false,
        errors: 1,
        message: "result.v2ProtocolBlocked",
      });
      expect(userFileActions(result)).toEqual({
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        filesMoved: 0,
      });
      expect(harness.remoteText(harness.protocolPaths.v3)).toBe(tampered);
      expect(harness.protocolCallCounts()).toMatchObject({
        createV2: 0,
        createV3: 0,
        overwriteV2: 0,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("V3 字节不变但 eTag 改变：binding 不匹配 → blocked", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await confirmColdStart(harness);
      const v3Before = harness.remoteSnapshot(harness.protocolPaths.v3)!;
      const v3Text = harness.remoteText(harness.protocolPaths.v3)!;
      expect(await harness.putRemote(
        harness.protocolPaths.v3,
        v3Text,
        { ifMatch: v3Before.eTag },
      )).toBe(204);
      const v3After = harness.remoteSnapshot(harness.protocolPaths.v3)!;
      expect(v3After.sha256).toBe(v3Before.sha256);
      expect(v3After.eTag).not.toBe(v3Before.eTag);
      harness.resetProviderCalls();

      const result = await harness.runRound("manual");

      expect(result).toMatchObject({
        success: false,
        errors: 1,
        message: "result.v2ProtocolBlocked",
      });
      expect(userFileActions(result)).toEqual({
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        filesMoved: 0,
      });
      // 引擎不把 eTag 变化当成「换一个绑定点」继续，也不覆盖字节。
      expect(harness.remoteSnapshot(harness.protocolPaths.v3)?.sha256)
        .toBe(v3After.sha256);
      expect(harness.protocolCallCounts()).toMatchObject({
        createV2: 0,
        createV3: 0,
        overwriteV2: 0,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("空远端＋真实 StateManager：首轮只暂停、不创建协议对象、不写用户文件、零 DELETE", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      harness.fake.requests.length = 0;
      const preview = vi.fn().mockResolvedValue(false);
      const result = await harness.runRound("manual", {
        onConfirmThreshold: preview,
      });

      expect(result.message).toBe("result.pausedForReview");
      expect(result.success).toBe(false);
      expect(result.errors).toBe(0);
      expect(result.uploaded).toBe(0);
      expect(result.downloaded).toBe(0);
      expect(result.deleted).toBe(0);
      expect(preview).toHaveBeenCalledOnce();
      expect(preview.mock.calls[0]?.[0]).toMatchObject({
        reviewKind: "v2-first-sync",
      });

      const hold = harness.state.activeV2MigrationHold;
      expect(hold).not.toBeNull();
      expect(hold).toMatchObject({
        phase: "pending",
        reviewKind: "v2-first-sync",
      });
      expect(harness.state.planReviewAuthorization).toMatchObject({
        reviewKind: "v2-first-sync",
        revision: hold!.revision,
        scope: harness.scope,
      });
      expect(hold!.scope).toEqual(harness.scope);
      expect(harness.state.isV2StateActive).toBe(false);

      // 协议对象与用户文件都未创建。
      expect(harness.remoteSnapshot(harness.protocolPaths.v2)).toBeNull();
      expect(harness.remoteSnapshot(harness.protocolPaths.v3)).toBeNull();
      expect(harness.remoteSnapshot(
        `${harness.fake.rootPath}/note.md`,
      )).toBeNull();
      expect(
        harness.fake.requests.filter((request) => request.method === "DELETE"),
      ).toHaveLength(0);
      expect(harness.providerCalls.some(
        (call) => call.method === "createSharedSyncProtocolV2",
      )).toBe(false);
      expect(harness.providerCalls.some(
        (call) => call.method === "createSharedSyncProtocolV3",
      )).toBe(false);
      expect(harness.providerCalls.some(
        (call) => call.method === "uploadFile",
      )).toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});
