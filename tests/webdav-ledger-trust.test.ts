/**
 * W2b-2：身份账本「重建未确认」闸门（零新界面）。
 *
 * 设计 §13.6 要求：远端账本被重建（缺失／损坏，uuid 全部换新）后，在用户看到
 * 一次成功同步之前，跨设备身份推断与自动删除必须保持关闭。本文件钉四件事：
 *
 * 1. 账本内容摘要的口径：同一份 uuid→path 映射稳定、条目增减会变、与
 *    `updatedAt` 无关；
 * 2. 标记的读取容错：任何异常形状都退回 null，不会变成「已确认」；
 * 3. `mayTrustWebDavLedger` 三条件：没有待确认标记、远端 verified、条件写可用；
 * 4. 端到端：`identityLedgerConfirmed=false` 时另一台设备的改名不被识别、本机
 *    文件不动；这等价于「刚重建、还没成功同步过」。
 *
 * 不接真实账号，不新增界面。
 */
import { describe, expect, it } from "vitest";
import {
  createWebDavLedgerRebuildMarker,
  isWebDavLedgerRebuildPending,
  mayTrustWebDavLedger,
  readWebDavLedgerRebuildMarker,
  type WebDavLedgerRebuildMarkerV1,
} from "../src/cloud/webdav-ledger-trust";
import { serializeIdentityLedger } from "../src/providers/webdav/webdav-identity-ledger";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

const UUID = "0123456789abcdef0123456789abcdef";
const SCOPE_ID = "a".repeat(32);
const FIXED_NOW = Date.parse("2026-11-20T12:00:00.000Z");

function seedLedger(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
  path: string,
): void {
  harness.fake.seedFile(
    `${harness.fake.rootPath}/.easy-sync/identity.json`,
    serializeIdentityLedger({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      entries: { [UUID]: path },
    }),
  );
}

async function firstSync(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
): Promise<void> {
  expect((await harness.runRound("manual")).message).toBe("result.pausedForReview");
  expect(await harness.confirmRound(harness.state.planReviewAuthorization!))
    .toMatchObject({ success: true, uploaded: 1, errors: 0 });
}

describe("W2b-2 账本重建待确认标记", () => {
  it("标记按 scopeId 归属：同一 scope 才待确认", async () => {
    const marker = await createWebDavLedgerRebuildMarker({
      scopeId: SCOPE_ID,
      entries: { [UUID]: "note.md" },
      eTag: 'W/"abc"',
      now: FIXED_NOW,
    });
    expect(isWebDavLedgerRebuildPending({ marker, scopeId: SCOPE_ID })).toBe(true);
    expect(
      isWebDavLedgerRebuildPending({ marker, scopeId: "b".repeat(32) }),
    ).toBe(false);
    expect(isWebDavLedgerRebuildPending({ marker: null, scopeId: SCOPE_ID }))
      .toBe(false);
  });

  it("异常形状退回 null（不会被读成「已确认」以外的任何东西）", () => {
    for (const value of [
      null,
      undefined,
      "marker",
      42,
      [],
      {},
      { schemaVersion: 1 },
      { schemaVersion: 1, kind: "webdav-ledger-rebuild-pending" },
      { schemaVersion: 2, kind: "webdav-ledger-rebuild-pending", scopeId: SCOPE_ID },
      { schemaVersion: 1, kind: "other", scopeId: SCOPE_ID },
      { schemaVersion: 1, kind: "webdav-ledger-rebuild-pending", scopeId: "xyz" },
    ]) {
      expect(readWebDavLedgerRebuildMarker(value)).toBeNull();
    }
  });

  it("往返：写出去的标记能原样读回", async () => {
    const marker = await createWebDavLedgerRebuildMarker({
      scopeId: SCOPE_ID,
      entries: { [UUID]: "note.md" },
      eTag: "abc",
      now: FIXED_NOW,
    });
    const parsed = readWebDavLedgerRebuildMarker(JSON.parse(JSON.stringify(marker)));
    expect(parsed).toEqual(marker);
    expect(parsed?.recordedAt).toBe(FIXED_NOW);
  });

  it("信任需要三条件：无待确认标记 + 远端 verified + 条件写可用", () => {
    const verified = {
      state: "verified",
      canUpdate: true,
      ledger: { entries: { [UUID]: "note.md" } },
    };
    const pending: WebDavLedgerRebuildMarkerV1 = {
      schemaVersion: 1,
      kind: "webdav-ledger-rebuild-pending",
      scopeId: SCOPE_ID,
      entriesDigest: "c".repeat(64),
      eTag: "",
      recordedAt: FIXED_NOW,
    };
    // 基线：没有标记、远端 verified、条件写可用 ⇒ 可以信任。
    expect(mayTrustWebDavLedger({
      marker: null,
      facts: verified,
      scopeId: SCOPE_ID,
    })).toBe(true);

    // 有待确认标记 ⇒ 不信任，即使远端正健康。
    expect(mayTrustWebDavLedger({
      marker: pending,
      facts: verified,
      scopeId: SCOPE_ID,
    })).toBe(false);

    // 别处 scope 的标记不影响本 scope。
    expect(mayTrustWebDavLedger({
      marker: { ...pending, scopeId: "b".repeat(32) },
      facts: verified,
      scopeId: SCOPE_ID,
    })).toBe(true);

    // 远端只读（无 IF-Match）⇒ 不信任：身份事实无法被条件写保护。
    expect(mayTrustWebDavLedger({
      marker: null,
      facts: { ...verified, canUpdate: false },
      scopeId: SCOPE_ID,
    })).toBe(false);

    // 远端缺失／损坏／不可读 ⇒ 不信任。
    for (const state of ["missing", "corrupt", "unavailable", "unverified"]) {
      expect(mayTrustWebDavLedger({
        marker: null,
        facts: { state, canUpdate: true, ledger: null },
        scopeId: SCOPE_ID,
      }), state).toBe(false);
    }
  });

  it("端到端：未确认时另一台设备的改名不被识别，本机文件不动", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      identityLedgerConfirmed: false,
    });
    try {
      await firstSync(harness);
      seedLedger(harness, WEBDAV_COLD_START_USER_PATH);
      expect((await harness.runRound("manual")).errors).toBe(0);
      // 未确认：连快照都不记，身份推断整条链关闭。
      expect(harness.state.identityLedgerSnapshot).toBeNull();

      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeLessThan(300);
      expect(await harness.putRemote(
        `${harness.fake.rootPath}/renamed.md`,
        "hello webdav cold start\n",
      )).toBeLessThan(300);
      seedLedger(harness, "renamed.md");

      const result = await harness.runRound("manual");
      // 不发射本地改名、不下载、不静默删除本机文件：走既有待确认决策。
      expect(result.filesMoved ?? 0).toBe(0);
      expect(result.errors).toBe(0);
      expect(harness.files.has(WEBDAV_COLD_START_USER_PATH)).toBe(true);
      expect(
        result.remoteDeletePending + result.conflicts,
      ).toBeGreaterThan(0);
    } finally {
      await harness.dispose();
    }
  }, 180_000);

  it("端到端：已确认时同一场景照常识别改名（对照组）", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      identityLedgerConfirmed: true,
    });
    try {
      await firstSync(harness);
      seedLedger(harness, WEBDAV_COLD_START_USER_PATH);
      expect((await harness.runRound("manual")).errors).toBe(0);
      expect(harness.state.identityLedgerSnapshot?.entries[UUID])
        .toBe(WEBDAV_COLD_START_USER_PATH);

      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeLessThan(300);
      expect(await harness.putRemote(
        `${harness.fake.rootPath}/renamed.md`,
        "hello webdav cold start\n",
      )).toBeLessThan(300);
      seedLedger(harness, "renamed.md");

      const result = await harness.runRound("manual");
      expect(result.filesMoved).toBe(1);
      expect(harness.files.has("renamed.md")).toBe(true);
      expect(harness.files.has(WEBDAV_COLD_START_USER_PATH)).toBe(false);
    } finally {
      await harness.dispose();
    }
  }, 180_000);

  it("端到端：未确认时「跟随云端删除本机」不通自动执行，只出确认行", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      identityLedgerConfirmed: false,
    });
    try {
      await firstSync(harness);
      // 用户明确打开了「将云端删除同步到本机」。
      harness.executor.setAutomaticHandlingPolicy({
        autoDeleteLocalFiles: true,
        mergeNonOverlappingText: true,
      });

      // 另一台设备删掉了远端文件。
      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeLessThan(300);

      const result = await harness.runRound("manual");
      // 身份未确认：即使设置开着，也不得自动删本机文件。
      expect(result.errors).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.remoteDeletePending).toBeGreaterThan(0);
      expect(harness.files.get(WEBDAV_COLD_START_USER_PATH))
        .toBe("hello webdav cold start\n");
    } finally {
      await harness.dispose();
    }
  }, 180_000);

  it("端到端：已确认时同一删除按设置自动执行（对照组）", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      identityLedgerConfirmed: true,
    });
    try {
      await firstSync(harness);
      harness.executor.setAutomaticHandlingPolicy({
        autoDeleteLocalFiles: true,
        mergeNonOverlappingText: true,
      });
      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeLessThan(300);

      const result = await harness.runRound("manual");
      expect(result.errors).toBe(0);
      expect(result.deleted).toBe(1);
      expect(result.remoteDeletePending).toBe(0);
      expect(harness.files.has(WEBDAV_COLD_START_USER_PATH)).toBe(false);
    } finally {
      await harness.dispose();
    }
  }, 180_000);

  it("端到端：未确认时单向模式的强制跟随同样不生效", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello webdav cold start\n",
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
      identityLedgerConfirmed: false,
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      expect(await harness.confirmRound(harness.state.planReviewAuthorization!))
        .toMatchObject({ success: true, errors: 0, uploaded: 2 });
      // 单向同步：云端删除在本机「强制跟随」。身份未确认时必须压住。
      harness.executor.setSyncDirection("one-way");

      // 另一台设备删掉了远端文件夹与其内容。
      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/docs/a.md`,
      )).toBeLessThan(300);
      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/docs`,
      )).toBeLessThan(300);

      const result = await harness.runRound("manual");
      expect(result.errors).toBe(0);
      // 目录与文件都不得被自动删除；只出待确认。
      expect(result.deleted).toBe(0);
      expect(result.foldersDeleted ?? 0).toBe(0);
      expect(harness.files.has("docs/a.md")).toBe(true);
      expect(harness.localFolderPaths.has("docs")).toBe(true);
    } finally {
      await harness.dispose();
    }
  }, 180_000);
});
