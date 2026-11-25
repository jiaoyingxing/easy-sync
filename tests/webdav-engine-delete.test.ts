import { describe, expect, it } from "vitest";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

async function firstSync(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
): Promise<void> {
  expect((await harness.runRound("manual")).message)
    .toBe("result.pausedForReview");
  const result = await harness.confirmRound(
    harness.state.planReviewAuthorization!,
  );
  expect(result).toMatchObject({ success: true, uploaded: 1, errors: 0 });
}

describe("W3c 引擎删除：文件夹", () => {
  async function firstSyncWithDocs(
    profiles: readonly ("strict" | "ignore-if-none-match" | "ignore-delete-if-match" | "move-conflict-on-overwrite" | "depth-infinity-as-one" | "no-head-length" | "mkcol-existing-201")[],
  ): Promise<Awaited<ReturnType<typeof createWebDavColdStartHarness>>> {
    const harness = await createWebDavColdStartHarness({
      profiles,
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello webdav cold start\n",
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
    });
    expect((await harness.runRound("manual")).message)
      .toBe("result.pausedForReview");
    const initial = await harness.confirmRound(
      harness.state.planReviewAuthorization!,
    );
    expect(initial).toMatchObject({ success: true, errors: 0, uploaded: 2 });
    return harness;
  }

  it("strict：本地删除文件夹 → 先删文件、再删空集合、次轮零计划", async () => {
    let harness = await firstSyncWithDocs(["strict"]);
    try {
      harness.deleteLocal("docs/a.md");
      harness.localFolderPaths.delete("docs");

      const deleted = await harness.runRound("manual");
      console.log("W3C_FOLDER_STRICT_RESULT", JSON.stringify(deleted));
      console.log("W3C_FOLDER_STRICT_DIAG", JSON.stringify(harness.diagErrors));
      expect(deleted).toMatchObject({
        success: true,
        errors: 0,
        deleted: 1,
        foldersDeleted: 1,
        deferred: 0,
      });
      expect(harness.remoteText(`${harness.fake.rootPath}/docs/a.md`)).toBeNull();
      expect(harness.remoteSnapshot(`${harness.fake.rootPath}/docs`)).toBeNull();

      const next = await harness.runRound("manual");
      expect(next).toMatchObject({
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        errors: 0,
      });
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("坚果云：本地删除文件夹 → 删文件、保留空集合、结算后不再重复", async () => {
    let harness = await firstSyncWithDocs(NUTSTORE_PROFILES);
    try {
      harness.deleteLocal("docs/a.md");
      harness.localFolderPaths.delete("docs");

      const deleted = await harness.runRound("manual");
      console.log("W3C_FOLDER_NUTSTORE_RESULT", JSON.stringify(deleted));
      console.log("W3C_FOLDER_NUTSTORE_DIAG", JSON.stringify(harness.diagErrors));
      expect(deleted).toMatchObject({
        success: true,
        errors: 0,
        deleted: 1,
        foldersDeleted: 1,
        deferred: 0,
      });
      expect(harness.remoteText(`${harness.fake.rootPath}/docs/a.md`)).toBeNull();
      // 无条件删除能力：空集合保留（内容已删，空壳不删）。
      expect(harness.remoteSnapshot(`${harness.fake.rootPath}/docs`))
        .toMatchObject({ kind: "collection" });
      // 本机文件夹不得因空壳被重新创建。
      expect(harness.localFolderPaths.has("docs")).toBe(false);
      expect(harness.state.retainedEmptyCollections
        .some((entry) => entry.path === "docs")).toBe(true);

      // 结算后不再重复删除，也不重建本机文件夹。
      const next = await harness.runRound("manual");
      console.log("W3C_FOLDER_NUTSTORE_NEXT", JSON.stringify(next));
      expect(next).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        foldersDeleted: 0,
        deferred: 0,
      });
      expect(harness.localFolderPaths.has("docs")).toBe(false);
      expect(harness.remoteSnapshot(`${harness.fake.rootPath}/docs`))
        .toMatchObject({ kind: "collection" });

      // 重启后保留记忆仍在，空壳仍被抑制。
      harness = await harness.restart();
      const afterRestart = await harness.runRound("manual");
      expect(afterRestart).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        deferred: 0,
      });
      expect(harness.state.retainedEmptyCollections
        .some((entry) => entry.path === "docs")).toBe(true);
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("保留空壳出现远端子项：失效记忆并恢复正常下载/建夹", async () => {
    const harness = await firstSyncWithDocs(NUTSTORE_PROFILES);
    try {
      harness.deleteLocal("docs/a.md");
      harness.localFolderPaths.delete("docs");
      expect((await harness.runRound("manual")).foldersDeleted).toBe(1);
      expect(harness.state.retainedEmptyCollections
        .some((entry) => entry.path === "docs")).toBe(true);

      // 另一设备在空壳里新建文件：空壳不再是“保留空壳”。
      expect(await harness.putRemote(
        `${harness.fake.rootPath}/docs/b.md`,
        "beta",
      )).toBeLessThan(300);

      const result = await harness.runRound("manual");
      console.log("W3C_FOLDER_REVIVED_RESULT", JSON.stringify(result));
      console.log("W3C_FOLDER_REVIVED_DIAG", JSON.stringify(harness.diagErrors));
      expect(result.errors).toBe(0);
      expect(harness.state.retainedEmptyCollections
        .some((entry) => entry.path === "docs")).toBe(false);
      expect(harness.localFolderPaths.has("docs")).toBe(true);
      expect(harness.files.get("docs/b.md")).toBe("beta");
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("本机重建同名文件夹：清除保留记忆并恢复正常", async () => {
    const harness = await firstSyncWithDocs(NUTSTORE_PROFILES);
    try {
      harness.deleteLocal("docs/a.md");
      harness.localFolderPaths.delete("docs");
      expect((await harness.runRound("manual")).foldersDeleted).toBe(1);

      // 用户重新建了同名空文件夹：远端空壳应重新可见，记忆清除。
      harness.localFolderPaths.add("docs");
      const result = await harness.runRound("manual");
      console.log("W3C_FOLDER_RECREATED_RESULT", JSON.stringify(result));
      console.log("W3C_FOLDER_RECREATED_DIAG", JSON.stringify(harness.diagErrors));
      expect(result.errors).toBe(0);
      expect(harness.state.retainedEmptyCollections
        .some((entry) => entry.path === "docs")).toBe(false);
      expect(harness.localFolderPaths.has("docs")).toBe(true);
      expect(harness.remoteSnapshot(`${harness.fake.rootPath}/docs`))
        .toMatchObject({ kind: "collection" });
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});

describe("W3c 引擎删除：本地文件", () => {
  it("本地删除文件：远端 DELETE、次轮零计划、重启后仍零计划", async () => {
    let harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await firstSync(harness);
      harness.deleteLocal(WEBDAV_COLD_START_USER_PATH);

      const deleted = await harness.runRound("manual");
      console.log("W3C_DELETE_RESULT", JSON.stringify(deleted));
      console.log("W3C_DELETE_DIAG", JSON.stringify(harness.diagErrors));
      expect(deleted).toMatchObject({
        success: true,
        errors: 0,
        deleted: 1,
        remoteDeletePending: 0,
        conflicts: 0,
      });
      expect(harness.remoteText(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      )).toBeNull();

      const next = await harness.runRound("manual");
      expect(next).toMatchObject({
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        errors: 0,
      });

      harness = await harness.restart();
      const afterRestart = await harness.runRound("manual");
      expect(afterRestart).toMatchObject({
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        errors: 0,
      });
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("远端删除文件：自动删除关闭时保留本机文件并挂起待确认", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await firstSync(harness);
      const remoteDelete = await harness.deleteRemote(
        `${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`,
      );
      expect(remoteDelete === 204 || remoteDelete === 200).toBe(true);

      const result = await harness.runRound("manual");
      console.log("W3C_REMOTE_DELETE_RESULT", JSON.stringify(result));
      console.log("W3C_REMOTE_DELETE_DIAG", JSON.stringify(harness.diagErrors));

      // 自动删除关闭：本机文件必须还在，且出现待确认，不得静默删除。
      expect(harness.files.has(WEBDAV_COLD_START_USER_PATH)).toBe(true);
      expect(result.deleted).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.remoteDeletePending).toBeGreaterThan(0);
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
