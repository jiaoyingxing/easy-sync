import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { LocalFileEntry } from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  driveItem,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

/**
 * P1（2026-11-24）：未回执 upload 的第三种正常结局。
 *
 * 双设备实测里，手机的计划还认为远端是旧版本时，电脑已经写入了第三种内容；
 * 条件写失败后旧实现只能把 intent 记为 unresolved，整轮被隔离，最后只能
 * 强制重置。窄修口径：只有远端文件完整可读、内容既不是意图前状态也不是
 * 本机目标内容时，才把 intent 结算为「未发生」；下一轮用刷新后的远端事实
 * 生成普通冲突行。读不到内容、本地已变、scope 变化仍保持 blocked。
 */
describe("P1 远端第三方内容取代未回执 upload", () => {
  const localBytes = new Uint8Array([7, 8, 9]).buffer;
  const remoteBytes = new Uint8Array([1, 2, 3, 4]).buffer;

  async function makeScenario(options: {
    readonly remoteBytes?: ArrayBuffer | null;
    readonly localChanged?: boolean;
  } = {}) {
    const localHash = await sha256Hex(localBytes);
    const changedBytes = new Uint8Array([9, 9, 9, 9]).buffer;
    const changedHash = await sha256Hex(changedBytes);
    const currentBytes = options.localChanged ? changedBytes : localBytes;
    const currentHash = options.localChanged ? changedHash : localHash;
    const remoteHash = await sha256Hex(remoteBytes);
    const remoteSize = options.remoteBytes === null
      ? localBytes.byteLength
      : remoteBytes.byteLength;
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const local: LocalFileEntry = {
      path: "superseded.md",
      hash: currentHash,
      size: currentBytes.byteLength,
      mtime: options.localChanged ? 3 : 2,
      binary: false,
    };
    const remote = driveItem("superseded.md", remoteHash, {
      id: "remote-b-id",
      size: remoteSize,
      eTag: "etag-B",
      cTag: "ctag-B",
    });
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-superseded",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash: localHash, size: localBytes.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "old-remote-id",
            eTag: "old-etag",
            size: 3,
            sha256Hash: "cc".repeat(32),
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn().mockResolvedValue({ id: "should-not-upload", eTag: "x" });
    const getFileMetadata = vi.fn().mockResolvedValue({
      eTag: "etag-B",
      cTag: "ctag-B",
      size: remoteSize,
      driveId: "remote-b-id",
      parentId: "files-root-id",
      mtime: 0,
    });
    const downloadFile = vi.fn().mockImplementation(async () => {
      if (options.remoteBytes === null) return new ArrayBuffer(0);
      return options.remoteBytes ?? remoteBytes;
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [remote],
      "@odata.deltaLink": "tok",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata,
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(currentBytes),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as never,
      state,
      "testVault",
    );
    return { executor, state, uploadFile, local, remote };
  }

  it("远端是完整可读的第三种内容 → intent 退休，下一轮产出冲突而不是强制重置", async () => {
    const { executor, state, uploadFile, local } = await makeScenario();

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toEqual([]);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(state.pendingConflicts.map((item) => item.path)).toContain(local.path);
    expect(result.conflicts ?? 0).toBeGreaterThan(0);
  });

  it("远端内容读不到 → 维持未结算/隔离，不把未知当第三方内容", async () => {
    const { executor, state, uploadFile, local } = await makeScenario({ remoteBytes: null });

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toHaveLength(1);
    expect(state.pendingConflicts.map((item) => item.path)).not.toContain(local.path);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(0);
    expect(result.downloaded).toBe(0);
  });

  it("本地在 intent 之后又变过 → 维持未结算/隔离，不替用户选边", async () => {
    const { executor, state, uploadFile, local } = await makeScenario({ localChanged: true });

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toHaveLength(1);
    expect(state.pendingConflicts.map((item) => item.path)).not.toContain(local.path);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(0);
  });
});
