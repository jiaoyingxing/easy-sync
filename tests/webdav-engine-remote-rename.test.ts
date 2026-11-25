import { describe, expect, it } from "vitest";
import { serializeIdentityLedger } from "../src/providers/webdav/webdav-identity-ledger";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

const UUID = "0123456789abcdef0123456789abcdef";

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
  uploaded = 1,
): Promise<void> {
  expect((await harness.runRound("manual")).message)
    .toBe("result.pausedForReview");
  expect(await harness.confirmRound(harness.state.planReviewAuthorization!))
    .toMatchObject({ success: true, uploaded, errors: 0 });
}

function expectZeroPlan(result: Awaited<ReturnType<
  Awaited<ReturnType<typeof createWebDavColdStartHarness>>["runRound"]
>>): void {
  expect(result).toMatchObject({
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    filesMoved: 0,
    conflicts: 0,
    errors: 0,
  });
}

describe("W3d2 跨设备改名：账本 uuid 识别", () => {
  it("另一设备改名：本机按账本把本地文件改名，不下载、不需人工处理", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await firstSync(harness);

      // 本机在另一设备改名前的某一轮读到 verified 账本：uuid -> note.md。
      seedLedger(harness, WEBDAV_COLD_START_USER_PATH);
      const baseline = await harness.runRound("manual");
      expect(baseline.errors).toBe(0);
      expect(harness.state.identityLedgerSnapshot?.entries[UUID])
        .toBe(WEBDAV_COLD_START_USER_PATH);

      // 另一设备：MOVE note.md -> renamed.md，并把账本 uuid 改到新路径。
      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeLessThan(300);
      expect(await harness.putRemote(
        `${harness.fake.rootPath}/renamed.md`,
        "hello webdav cold start\n",
      )).toBeLessThan(300);
      seedLedger(harness, "renamed.md");

      const result = await harness.runRound("manual");
      expect(result).toMatchObject({
        success: true,
        errors: 0,
        downloaded: 0,
        conflicts: 0,
        filesMoved: 1,
      });
      // 本机直接改名：旧路径消失、新路径保留原字节，没有重新下载。
      expect(harness.files.has(WEBDAV_COLD_START_USER_PATH)).toBe(false);
      expect(harness.files.get("renamed.md"))
        .toBe("hello webdav cold start\n");
      expect(harness.remoteText(`${harness.fake.rootPath}/renamed.md`))
        .toBe("hello webdav cold start\n");

      expectZeroPlan(await harness.runRound("manual"));
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("远端内容已变化：不自动改名，保留本机并进入待确认", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await firstSync(harness);
      seedLedger(harness, WEBDAV_COLD_START_USER_PATH);
      expect((await harness.runRound("manual")).errors).toBe(0);

      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeLessThan(300);
      expect(await harness.putRemote(
        `${harness.fake.rootPath}/renamed.md`,
        "different bytes on the other device\n",
      )).toBeLessThan(300);
      seedLedger(harness, "renamed.md");

      const result = await harness.runRound("manual");
      // 账本证明同一身份搬了家，但新远端对象已不是锚定版本（move+edit）：
      // 不按纯移动自动改名，避免覆盖本机未变内容；走既有删除/新增决策。
      expect(result.filesMoved ?? 0).toBe(0);
      expect(harness.files.has(WEBDAV_COLD_START_USER_PATH)).toBe(true);
      expect(result.errors).toBe(0);
      expect(
        result.downloaded + result.remoteDeletePending + result.conflicts,
      ).toBeGreaterThan(0);
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("本机新路径已被占用：不自动改名，不覆盖本机文件", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello webdav cold start\n",
        "renamed.md": "local occupant\n",
      },
    });
    try {
      await firstSync(harness, 2);
      seedLedger(harness, WEBDAV_COLD_START_USER_PATH);
      expect((await harness.runRound("manual")).errors).toBe(0);

      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeLessThan(300);
      expect(await harness.putRemote(
        `${harness.fake.rootPath}/renamed.md`,
        "hello webdav cold start\n",
      )).toBeLessThan(300);
      seedLedger(harness, "renamed.md");

      const result = await harness.runRound("manual");
      // 账本只说“同一身份搬了家”，但本机新路径已有文件：不能覆盖，
      // 不发射本地改名；本机文件保留，交给既有同路径决策。
      expect(result.filesMoved ?? 0).toBe(0);
      expect(harness.files.has(WEBDAV_COLD_START_USER_PATH)).toBe(true);
      expect(harness.files.has("renamed.md")).toBe(true);
      expect(result.errors).toBe(0);
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("账本只读（无 If-Match）：不识别跨设备改名，走普通待确认", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-if-match"],
    });
    try {
      await firstSync(harness);
      seedLedger(harness, WEBDAV_COLD_START_USER_PATH);
      expect((await harness.runRound("manual")).errors).toBe(0);
      expect(harness.state.identityLedgerSnapshot).toBeNull();

      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeLessThan(300);
      expect(await harness.putRemote(
        `${harness.fake.rootPath}/renamed.md`,
        "hello webdav cold start\n",
      )).toBeLessThan(300);

      const result = await harness.runRound("manual");
      expect(result.filesMoved ?? 0).toBe(0);
      expect(harness.files.has(WEBDAV_COLD_START_USER_PATH)).toBe(true);
      expect(result.errors).toBe(0);
      expect(result.remoteDeletePending).toBeGreaterThan(0);
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
