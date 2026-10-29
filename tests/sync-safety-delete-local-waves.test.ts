/**
 * `DeleteLocal`（跟随云端删除）在计划路径上的波次成本与逐条可见性（2026-10-27）。
 *
 * 真机现场：云端删掉 2,000 个文件后打开「将云端删除同步到本机」，一轮手动同步
 * 用 285 秒删掉 1,532 个文件（约 186 ms/文件），是桌面批量删除（48 ms/文件）的
 * 约 4 倍。计划路径的 `DeleteLocal` 早已并入 Step 4 清理波（`isCleanup`），所以
 * 意图／回执／检查点本来就是「一波一次」；真正逐文件付的固定成本是
 * `executeDeleteLocalItem` 里**每个文件一次远端 `getFileMetadata`**。
 *
 * 本文件钉住三件事：
 *  ① 同一批 N 条：整库写入次数 = 波数（不是 N），远端缺席读取 = 波数（不是 N），
 *    每文件仍各自做一次本机复核；
 *  ② 波级核对不过的文件只跳过它自己（远端重现／本机已变），其余照删，且该文件
 *    仍退回逐文件核对（合批不放宽）；
 *  ③ `DeleteLocal` 与 `DeleteRemote` 走同一套完成行映射：成功行进「已完成」列表，
 *    失败行原位标红并带原因。
 *
 * 旧实现（HEAD 工作树之外的 `git archive HEAD` 树）在第 ① 条上红：
 * `getFileMetadata` = N 次、`getFileMetadataByPaths` = 0 次。
 */
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticLogger } from "../src/diagnostics/logger";
import type { LocalScanner } from "../src/sync/local-scanner";
import { SyncProgressStore } from "../src/sync/sync-progress";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncCallbacks } from "../src/sync/sync-executor";
import { SyncActionType } from "../src/sync/types";
import type { BaseFileEntry, LocalFileEntry } from "../src/sync/types";
import {
  resolveCompletedActionCount,
  resolveFileProgressPresentation,
} from "../src/ui/sync-view";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

const DESKTOP_DELETE_WAVE = 64;

interface DeleteLocalWaveHarnessInput {
  filePaths: readonly string[];
  /** 这些路径在「本波批量读取」里回报仍然存在（云端又出现了）。 */
  presentRemotely?: readonly string[];
  /** 批量读取整批抛错（弱网／$batch 失败）——必须退化成逐文件核对。 */
  failBatchRead?: boolean;
  /** 这些路径在本机读取时哈希已变（复核不过）。 */
  changedLocally?: readonly string[];
  /** 这些路径的删除抛错（本机一侧失败）。 */
  failErase?: readonly string[];
}

async function makeDeleteLocalWaveHarness(input: DeleteLocalWaveHarnessInput) {
  const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
  const baseEntries: BaseFileEntry[] = input.filePaths.map((path, index) => ({
    path,
    hash: `${(index % 251).toString(16).padStart(2, "0")}`.repeat(32),
    size: 10 + index,
    eTag: `etag-${index}`,
  }));
  const localEntries: LocalFileEntry[] = baseEntries.map((entry, index) => ({
    path: entry.path,
    hash: entry.hash,
    size: entry.size,
    mtime: 1,
    binary: false,
  }));
  const localByPath = new Map(localEntries.map((entry) => [entry.path, entry]));
  const presentRemotely = new Set(input.presentRemotely ?? []);
  const changedLocally = new Set(input.changedLocally ?? []);
  const failErase = new Set(input.failErase ?? []);
  const uniquePaths = [...new Set(input.filePaths)];

  const removed: string[] = [];
  const adapter = makeMockAdapter({
    exists: vi.fn().mockResolvedValue(false),
    remove: vi.fn(async (path: string) => {
      if (failErase.has(path)) throw new Error(`erase failed: ${path}`);
      removed.push(path);
    }),
  });
  const getFileMetadata = vi.fn(async (_vault: string, path: string) =>
    presentRemotely.has(path) ? { driveId: `remote-${path}` } : null);
  const batchReads: string[][] = [];
  const getFileMetadataByPaths = vi.fn(
    async (_vault: string, paths: readonly string[]) => {
      batchReads.push([...paths]);
      if (input.failBatchRead) throw new Error("$batch unavailable");
      return new Map(
        paths.map((path) => [
          path,
          presentRemotely.has(path) ? { driveId: `remote-${path}` } : null,
        ]),
      );
    },
  );
  const inspectFile = vi.fn(async (path: string) => {
    const entry = localByPath.get(path);
    if (!entry) return { status: "missing" as const };
    return {
      status: "present" as const,
      entry: changedLocally.has(path)
        ? { ...entry, hash: "ff".repeat(32) }
        : entry,
    };
  });
  const state = makeActiveV2State([], baseEntries);
  const diagLines: Array<{ message: string; data?: unknown }> = [];
  const diag = {
    isEnabled: vi.fn().mockReturnValue(false),
    log: vi.fn((_category: string, message: string, data?: unknown) => {
      diagLines.push({ message, data });
    }),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as DiagnosticLogger;
  const scanner = {
    vault: {
      configDir: ".obsidian",
      adapter,
      getFiles: vi.fn().mockReturnValue([]),
      getFileByPath: vi.fn().mockReturnValue(null),
      getName: vi.fn().mockReturnValue("testVault"),
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
    },
    scanAll: vi.fn().mockResolvedValue({
      entries: localEntries,
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    }),
    scanFile: vi.fn().mockResolvedValue(null),
    inspectFile,
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
  } as unknown as LocalScanner;
  const executor = new SyncExecutor(
    makeMockOneDrive({ getFileMetadata, getFileMetadataByPaths }),
    scanner,
    state,
    "testVault",
    undefined,
    undefined,
    diag,
  );
  executor.setAutomaticHandlingPolicy({
    autoDeleteLocalFiles: true,
    mergeNonOverlappingText: true,
  });

  const completions: Array<{
    path: string;
    actionType: SyncActionType;
    success: boolean;
    reason?: string;
  }> = [];
  const callbacks: SyncCallbacks = {
    onFileComplete: (path, actionType, success, reason) => {
      completions.push({ path, actionType, success, reason });
    },
  };
  const result = await executor.run("manual", callbacks);

  return {
    scope,
    result,
    state,
    completions,
    removed,
    batchReads,
    getFileMetadata,
    getFileMetadataByPaths,
    inspectFile,
    adapter,
    diagLines,
    uniquePaths,
  };
}

function cleanupWaveLogs(
  lines: readonly { message: string; data?: unknown }[],
): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.message === "cleanup wave settled")
    .map((line) => line.data as Record<string, unknown>);
}

describe("DeleteLocal cleanup waves", () => {
  it("settles 2,000 local deletes in one round with one checkpoint and one absence read per wave", async () => {
    const filePaths = Array.from(
      { length: 2000 },
      (_unused, index) => `followed/f-${String(index).padStart(4, "0")}.md`,
    );
    const harness = await makeDeleteLocalWaveHarness({ filePaths });

    expect(harness.result.deleted).toBe(filePaths.length);
    expect(harness.result.errors).toBe(0);
    expect(harness.removed).toHaveLength(filePaths.length);

    // ① 整库写入 = 波数，不是文件数：意图／回执／检查点各一次／波。
    const waveCount = Math.ceil(filePaths.length / DESKTOP_DELETE_WAVE);
    expect(waveCount).toBe(32);
    expect(
      vi.mocked(harness.state.beginMutationIntents).mock.calls.length,
    ).toBe(waveCount);
    expect(
      vi.mocked(harness.state.recordMutationReceipts).mock.calls.length,
    ).toBe(waveCount);
    expect(
      vi.mocked(harness.state.commitMutationCheckpoints).mock.calls.length,
    ).toBe(waveCount);
    // 单文件检查点接口一次都不用（清理波的共享检查点拥有整波）。
    expect(harness.state.commitMutationCheckpoint).not.toHaveBeenCalled();
    for (const [intents] of vi.mocked(harness.state.beginMutationIntents)
      .mock.calls) {
      expect(intents.length).toBeLessThanOrEqual(DESKTOP_DELETE_WAVE);
    }

    // ② 远端缺席读取也按波：一波一次批量读，没有任何逐文件 metadata GET。
    //    旧实现这里恰好相反（N 次 getFileMetadata、0 次批量读）。
    expect(harness.getFileMetadata).not.toHaveBeenCalled();
    expect(harness.getFileMetadataByPaths).toHaveBeenCalledTimes(waveCount);
    const readPaths = harness.batchReads.flat();
    expect(readPaths).toHaveLength(filePaths.length);
    expect(new Set(readPaths).size).toBe(filePaths.length);

    // ③ 每文件的本机复核没有因为合批而消失。
    expect(harness.inspectFile).toHaveBeenCalledTimes(filePaths.length);

    // 波内顺序：意图 → 逐条擦除 → 回执 → 共享检查点。
    const intentOrder = vi.mocked(harness.state.beginMutationIntents)
      .mock.invocationCallOrder;
    const receiptOrder = vi.mocked(harness.state.recordMutationReceipts)
      .mock.invocationCallOrder;
    const checkpointOrder = vi.mocked(harness.state.commitMutationCheckpoints)
      .mock.invocationCallOrder;
    for (let wave = 0; wave < waveCount; wave++) {
      expect(intentOrder[wave]).toBeLessThan(receiptOrder[wave]);
      expect(receiptOrder[wave]).toBeLessThan(checkpointOrder[wave]);
    }

    // 波级保证金：每一波的整体日志都说明这一波有多少本机跟随删除、其中多少条
    // 已被那一次批量读取证明缺席。
    const waves = cleanupWaveLogs(harness.diagLines);
    expect(waves).toHaveLength(waveCount);
    const totalLocalDeletes = waves.reduce(
      (sum, wave) => sum + Number(wave.localDeletes ?? 0),
      0,
    );
    const totalPreverified = waves.reduce(
      (sum, wave) => sum + Number(wave.localDeletesPreverified ?? 0),
      0,
    );
    expect(totalLocalDeletes).toBe(filePaths.length);
    expect(totalPreverified).toBe(filePaths.length);
  }, 120_000);

  it("skips only the members whose wave check failed and keeps deleting the rest", async () => {
    const filePaths = Array.from({ length: 5 }, (_unused, index) =>
      `mixed/f-${index}.md`);
    const harness = await makeDeleteLocalWaveHarness({
      filePaths,
      // 云端又出现了：批量读取只能证明它「存在」，该成员必须退回逐文件核对。
      presentRemotely: ["mixed/f-2.md"],
      // 复核时本机已经变了：不得擦除。
      changedLocally: ["mixed/f-4.md"],
    });

    expect(harness.removed.sort()).toEqual([
      "mixed/f-0.md",
      "mixed/f-1.md",
      "mixed/f-3.md",
    ]);
    expect(harness.result.deleted).toBe(3);
    expect(harness.result.errors).toBe(2);
    // 合批不等于放宽：没被证明缺席的那一条走了现役逐文件远端核对，一步没省。
    expect(harness.getFileMetadata).toHaveBeenCalledTimes(1);
    expect(harness.getFileMetadata).toHaveBeenCalledWith(
      "testVault",
      "mixed/f-2.md",
    );
    // 两条被跳过的都留下了证据与完成行，且失败那一条排在本机复核之后。
    const failed = harness.completions.filter((row) => !row.success);
    expect(failed.map((row) => row.path).sort()).toEqual([
      "mixed/f-2.md",
      "mixed/f-4.md",
    ]);
    expect(failed.every((row) => row.actionType === SyncActionType.DeleteLocal))
      .toBe(true);
    expect(failed.every((row) => Boolean(row.reason))).toBe(true);
    // 远端缺席核对排在本机复核之前（现役顺序）：远端已重现的那条不会再去读本机。
    expect(harness.inspectFile).toHaveBeenCalledTimes(4);
    expect(harness.removed).not.toContain("mixed/f-4.md");
  }, 120_000);

  it("falls back to per-file remote checks when the wave read fails", async () => {
    const filePaths = Array.from({ length: 4 }, (_unused, index) =>
      `weak/f-${index}.md`);
    const harness = await makeDeleteLocalWaveHarness({
      filePaths,
      failBatchRead: true,
    });

    // 读取整批失败 ⇒ 一个路径都不算「已证明缺席」，全部走逐文件核对；
    // 删除照旧成功（不成失败、不静默跳过）。
    expect(harness.getFileMetadata).toHaveBeenCalledTimes(filePaths.length);
    expect(harness.removed.sort()).toEqual([...filePaths].sort());
    expect(harness.result.errors).toBe(0);
    const waves = cleanupWaveLogs(harness.diagLines);
    expect(waves).toHaveLength(1);
    expect(waves[0].localDeletes).toBe(filePaths.length);
    expect(waves[0].localDeletesPreverified).toBe(0);
  }, 120_000);

  it("publishes DeleteLocal rows through the same completed-row mapping as DeleteRemote", async () => {
    const filePaths = ["rows/ok-1.md", "rows/ok-2.md", "rows/changed.md"];
    const harness = await makeDeleteLocalWaveHarness({
      filePaths,
      changedLocally: ["rows/changed.md"],
    });

    // 执行侧：每个文件都上报自己的完成行，类型就是 DeleteLocal。
    expect(harness.completions).toHaveLength(filePaths.length);
    expect(
      harness.completions.every((row) => row.actionType === SyncActionType.DeleteLocal),
    ).toBe(true);

    // 视图侧：按 main.ts `handleFileComplete` 的现役映射灌进真实进度仓库。
    const progressStore = new SyncProgressStore();
    progressStore.markStarted("fullSync");
    for (const row of harness.completions) {
      progressStore.addCompletedFile({
        path: row.path,
        status: row.success
          ? SyncProgressStore.actionToStatus(row.actionType)
          : "error",
        actionType: row.actionType,
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.success ? {} : { failedAt: 1 }),
      });
    }
    const rows = progressStore.state.completedFiles;

    // 成功行与 DeleteRemote 完全同形：同一 status、同一 chip、同一图标。
    const deleteRemoteStatus = SyncProgressStore.actionToStatus(
      SyncActionType.DeleteRemote,
    );
    expect(SyncProgressStore.actionToStatus(SyncActionType.DeleteLocal))
      .toBe(deleteRemoteStatus);
    const successRows = rows.filter((row) => row.path !== "rows/changed.md");
    expect(successRows).toHaveLength(2);
    for (const row of successRows) {
      expect(row.status).toBe(deleteRemoteStatus);
      expect(resolveFileProgressPresentation(row)).toEqual(
        resolveFileProgressPresentation({
          path: "remote.md",
          status: deleteRemoteStatus,
          actionType: SyncActionType.DeleteRemote,
        }),
      );
      expect(resolveFileProgressPresentation(row).labelKey)
        .toBe("syncView.fileStatus.delete");
    }

    // 失败行原位标红并带原因：status=error、错误 chip、原因原样保留，
    // 且不算成功行（不会被成功行 100 条截断先丢）。
    const failedRow = rows.find((row) => row.path === "rows/changed.md");
    expect(failedRow?.status).toBe("error");
    expect(failedRow?.reason).toBe("syncView.failure.localChangedBeforeDelete");
    expect(resolveFileProgressPresentation(failedRow!).labelKey)
      .toBe("syncView.fileStatus.error");
    // 计数口径未动：已结算行数＝3（成功 2 ＋ 失败 1，错误行本来就计数），
    // `completedCount` 与 `resolveCompletedActionCount` 都不因合批改变。
    expect(progressStore.state.completedCount).toBe(3);
    expect(resolveCompletedActionCount(progressStore.state)).toBe(3);
  }, 120_000);
});
