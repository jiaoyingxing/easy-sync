import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import type { LocalScanner } from "../src/sync/local-scanner";
import { SyncExecutor } from "../src/sync/sync-executor";
import type {
  BaseFileEntry,
  LocalFileEntry,
  RemoteFileEntry,
  SyncScope,
} from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  driveItem,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

/**
 * Case-only file renames (field report 2026-10-22, Desktop 1.6.1).
 *
 * The user renamed `mjw-文件移动.md` to `MJW-文件移动.md` locally. The plan
 * emits a `renameRemote`; OneDrive applies the name change, but Graph resolves
 * paths case-insensitively, so the pre-rename spelling still addresses the
 * moved object. The old read-back treated that alias as "the source still
 * exists", failed the move, and left an intent-only record that could not be
 * receipted or classified (the shared ordinary-file gate rejects
 * normalize-equal source/target paths) — the whole vault stopped.
 */

const scope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
const sourcePath = "mjw-文件移动.md";
const targetPath = "MJW-文件移动.md";
const driveId = "case-alias-file-id";
const content = new Uint8Array([3, 1, 4]).buffer;
const contentSize = content.byteLength;

function remoteMetadata(input: {
  path: string;
  driveId: string;
  eTag: string;
  hash: string;
}) {
  return {
    eTag: input.eTag,
    cTag: `${input.eTag}-ctag`,
    size: contentSize,
    sha256Hash: input.hash,
    quickXorHash: undefined,
    downloadUrl: "https://example.invalid/download",
    driveId: input.driveId,
    parentId: scope.filesRootId,
    mtime: 100,
  };
}

function renamedDriveItem(hash: string) {
  return {
    id: driveId,
    name: targetPath,
    eTag: "etag-after",
    cTag: "etag-after-ctag",
    size: contentSize,
    lastModifiedDateTime: new Date(1_000).toISOString(),
    file: { hashes: { sha256Hash: hash } },
    parentReference: { id: scope.filesRootId },
  };
}

function executorFor(input: {
  state: ReturnType<typeof makeActiveV2State>;
  localEntries: LocalFileEntry[];
  onedrive: Record<string, unknown>;
  inspectFile?: (path: string) => Promise<unknown>;
  diag?: {
    log: (category: string, message: string, detail?: unknown) => void;
    warn: (category: string, message: string, detail?: unknown) => void;
    error: (category: string, message: string, detail?: unknown) => void;
  };
}): SyncExecutor {
  return new SyncExecutor(
    makeMockOneDrive(input.onedrive),
    {
      vault: {
        adapter: makeMockAdapter(),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: input.localEntries,
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn().mockImplementation(
        input.inspectFile
          ?? ((_path: string) => Promise.resolve({ status: "missing" })),
      ),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner,
    input.state,
    "testVault",
    undefined,
    undefined,
    input.diag as never,
  );
}

describe("case-only renameRemote", () => {
  it("commits the rename and its receipt when the old spelling is the moved object", async () => {
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: targetPath,
      hash,
      size: contentSize,
      mtime: 2,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: sourcePath,
      driveId,
      parentId: scope.filesRootId,
      eTag: "etag-before",
      cTag: "etag-before-ctag",
      size: contentSize,
      sha256Hash: hash,
    };
    const base: BaseFileEntry = {
      path: sourcePath,
      hash,
      size: contentSize,
      eTag: "etag-before",
    };
    const state = makeActiveV2State([remote], [base]);

    let moved = false;
    const renameItem = vi.fn().mockImplementation(async () => {
      moved = true;
      return renamedDriveItem(hash);
    });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_vault: string, path: string) => {
        if (!moved) {
          return path === sourcePath
            ? remoteMetadata({ path, driveId, eTag: "etag-before", hash })
            : null;
        }
        return path === sourcePath || path === targetPath
          ? remoteMetadata({ path, driveId, eTag: "etag-after", hash })
          : null;
      },
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-case-alias",
    });
    const diagnostics: string[] = [];
    const diag = {
      log: (_category: string, message: string) =>
        diagnostics.push(`log:${message}`),
      warn: (_category: string, message: string) =>
        diagnostics.push(`warn:${message}`),
      error: (_category: string, message: string) =>
        diagnostics.push(`error:${message}`),
    };
    const executor = executorFor({
      state,
      localEntries: [local],
      onedrive: { renameItem, getFileMetadata, getDelta },
      inspectFile: async (path) =>
        path === targetPath
          ? { status: "present", entry: local }
          : { status: "missing" },
      diag,
    });

    const result = await executor.run("manual", {});

    expect(result).toMatchObject({ success: true, errors: 0 });
    expect(renameItem).toHaveBeenCalledOnce();
    // The alias read-back must pass the move in place: no false failure row
    // and no same-action recovery.
    expect(diagnostics.some((line) =>
      line.includes("Remote file move read-back failed"))).toBe(false);
    expect(diagnostics.some((line) => line.includes("mutation recovered")))
      .toBe(false);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toContainEqual({
      path: targetPath,
      hash,
      size: contentSize,
      eTag: "etag-after",
    });
    expect(state.baseSnapshot.some((entry) => entry.path === sourcePath))
      .toBe(false);
    expect(state.remoteSnapshot.some((entry) => entry.path === sourcePath))
      .toBe(false);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: targetPath,
      driveId,
      eTag: "etag-after",
    }));
  });

  it("keeps the rename fail-closed when the old spelling holds a different object", async () => {
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: targetPath,
      hash,
      size: contentSize,
      mtime: 2,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: sourcePath,
      driveId,
      parentId: scope.filesRootId,
      eTag: "etag-before",
      cTag: "etag-before-ctag",
      size: contentSize,
      sha256Hash: hash,
    };
    const base: BaseFileEntry = {
      path: sourcePath,
      hash,
      size: contentSize,
      eTag: "etag-before",
    };
    const state = makeActiveV2State([remote], [base]);

    let moved = false;
    const renameItem = vi.fn().mockImplementation(async () => {
      moved = true;
      return renamedDriveItem(hash);
    });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_vault: string, path: string) => {
        if (!moved) {
          return path === sourcePath
            ? remoteMetadata({ path, driveId, eTag: "etag-before", hash })
            : null;
        }
        if (path === targetPath) {
          return remoteMetadata({ path, driveId, eTag: "etag-after", hash });
        }
        return path === sourcePath
          ? remoteMetadata({
              path,
              driveId: "second-file-at-source",
              eTag: "etag-second",
              hash,
            })
          : null;
      },
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-case-alias-negative",
    });
    const executor = executorFor({
      state,
      localEntries: [local],
      onedrive: { renameItem, getFileMetadata, getDelta },
      inspectFile: async (path) =>
        path === targetPath
          ? { status: "present", entry: local }
          : { status: "missing" },
    });

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0]!.intent).toMatchObject({
      action: "renameRemote",
      path: targetPath,
      sourcePath,
    });
  });

  it("settles a persisted intent-only record when the local copy is gone and the source spelling is the moved object", async () => {
    const hash = await sha256Hex(content);
    const remote: RemoteFileEntry = {
      path: sourcePath,
      driveId,
      parentId: scope.filesRootId,
      eTag: "etag-before",
      cTag: "etag-before-ctag",
      size: contentSize,
      sha256Hash: hash,
    };
    const base: BaseFileEntry = {
      path: sourcePath,
      hash,
      size: contentSize,
      eTag: "etag-before",
    };
    const state = makeActiveV2State([remote], [base], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-case-alias-intent-only",
          planRevision: 1,
          scope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: contentSize },
          expectedRemote: {
            exists: true,
            driveId,
            eTag: "etag-before",
            size: contentSize,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_vault: string, path: string) =>
        path === sourcePath || path === targetPath
          ? remoteMetadata({ path, driveId, eTag: "etag-after", hash })
          : null,
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(targetPath, hash, {
        id: driveId,
        eTag: "etag-after",
        cTag: "etag-after-ctag",
      })],
      "@odata.deltaLink": "https://graph.example/delta-case-alias-settle",
    });
    const executor = executorFor({
      state,
      localEntries: [],
      onedrive: { getFileMetadata, getDelta },
    });

    const result = await executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toContainEqual({
      path: targetPath,
      hash,
      size: contentSize,
      eTag: "etag-after",
    });
    expect(state.remoteSnapshot.some((entry) => entry.path === sourcePath))
      .toBe(false);
  });

  it("keeps a persisted intent-only record blocked when the source spelling is a different object", async () => {
    const hash = await sha256Hex(content);
    const remote: RemoteFileEntry = {
      path: sourcePath,
      driveId,
      parentId: scope.filesRootId,
      eTag: "etag-before",
      cTag: "etag-before-ctag",
      size: contentSize,
      sha256Hash: hash,
    };
    const base: BaseFileEntry = {
      path: sourcePath,
      hash,
      size: contentSize,
      eTag: "etag-before",
    };
    const state = makeActiveV2State([remote], [base], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-case-alias-blocked",
          planRevision: 1,
          scope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: contentSize },
          expectedRemote: {
            exists: true,
            driveId,
            eTag: "etag-before",
            size: contentSize,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_vault: string, path: string) => {
        if (path === targetPath) {
          return remoteMetadata({ path, driveId, eTag: "etag-after", hash });
        }
        return path === sourcePath
          ? remoteMetadata({
              path,
              driveId: "second-file-at-source",
              eTag: "etag-second",
              hash,
            })
          : null;
      },
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(targetPath, hash, {
        id: driveId,
        eTag: "etag-after",
        cTag: "etag-after-ctag",
      })],
      "@odata.deltaLink": "https://graph.example/delta-case-alias-blocked",
    });
    const executor = executorFor({
      state,
      localEntries: [],
      onedrive: { getFileMetadata, getDelta },
    });

    const result = await executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(false);
    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      remaining: 1,
      isolated: true,
    });
    expect(state.mutationLedger).toHaveLength(1);
  });
});
