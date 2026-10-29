import { describe, expect, it, vi } from "vitest";
import { SyncExecutor } from "../src/sync/sync-executor";
import {
  localDeleteDecisionPathHash,
  localDeleteDecisionRecordToken,
  serializeLocalDeleteDecisionHashes,
  type LocalDeleteDecisionV1,
} from "../src/sync/local-delete-decision";
import type { LocalScanner } from "../src/sync/local-scanner";
import {
  type BaseFileEntry,
  type RemoteFileEntry,
  type SyncDecisionToken,
} from "../src/sync/types";
import {
  driveItem,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
  TEST_SYNC_SCOPE,
} from "./helpers/sync-safety-harness";

const hashA = "a".repeat(64);
const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
const stablePaths = ["s0.md", "s1.md", "s2.md", "s3.md", "s4.md"];
const deletedPath = "gone.md";

function decisionToken(): SyncDecisionToken {
  return {
    version: 1,
    vaultName: "testVault",
    accountId: scope.accountId,
    scope,
    local: { exists: true, hash: hashA, size: 3 },
    remote: { exists: false },
    ancestorHash: hashA,
  };
}

function makeHarness(input: { removeFails?: boolean } = {}) {
  const baseEntries: BaseFileEntry[] = [...stablePaths, deletedPath].map(
    (path) => ({
      path,
      hash: hashA,
      size: 3,
      eTag: `etag-${path}`,
    }),
  );
  const remoteEntries: RemoteFileEntry[] = stablePaths.map((path) => ({
    path,
    driveId: `id-${path}`,
    parentId: scope.filesRootId,
    size: 3,
    eTag: `etag-${path}`,
    sha256Hash: hashA,
  }));
  const present = new Set([...stablePaths, deletedPath]);
  const adapter = makeMockAdapter({
    remove: vi.fn(async (path: string) => {
      if (input.removeFails === true && path === deletedPath) {
        throw new Error("disk write failed");
      }
      present.delete(path);
    }),
  });
  const inspectFile = vi.fn(async (path: string) => present.has(path)
    ? {
        status: "present" as const,
        entry: {
          path,
          hash: hashA,
          size: 3,
          mtime: 1,
          binary: false,
        },
      }
    : { status: "missing" as const });
  const scanner = {
    vault: {
      adapter,
      getFileByPath: vi.fn().mockReturnValue(null),
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
    },
    scanAll: vi.fn().mockResolvedValue({
      entries: [...stablePaths, deletedPath].map((path) => ({
        path,
        hash: hashA,
        size: 3,
        mtime: 1,
        binary: false,
      })),
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    }),
    scanFile: inspectFile,
    inspectFile,
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
  } as unknown as LocalScanner;
  const token = decisionToken();
  const record: LocalDeleteDecisionV1 = {
    token: localDeleteDecisionRecordToken(token),
    paths: [deletedPath],
    planDigest: serializeLocalDeleteDecisionHashes([
      localDeleteDecisionPathHash(token, deletedPath),
    ]),
    createdAt: 1,
  };
  const settleLocalDeleteDecisions = vi.fn().mockResolvedValue(undefined);
  const state = makeActiveV2State(remoteEntries, baseEntries, {
    localDeleteDecisions: [record],
    settleLocalDeleteDecisions,
    removeLocalDeleteDecisionPaths: vi.fn().mockResolvedValue(undefined),
  });
  const oneDrive = makeMockOneDrive({
    getDelta: vi.fn().mockResolvedValue({
      value: stablePaths.map((path) => driveItem(path, hashA, {
        id: `id-${path}`,
        eTag: `etag-${path}`,
      })),
      "@odata.deltaLink": "tok",
    }),
    getFileMetadata: vi.fn().mockResolvedValue(null),
    getFileMetadataByPaths: vi.fn().mockResolvedValue(new Map()),
  });
  const executor = new SyncExecutor(
    oneDrive,
    scanner,
    state,
    "testVault",
  );
  return { executor, adapter, settleLocalDeleteDecisions, record, present };
}

describe("local delete decision execution (S4)", () => {
  it("consumes the decision only after the delete checkpoint settles", async () => {
    const { executor, adapter, settleLocalDeleteDecisions, record, present } =
      makeHarness();
    const result = await executor.run("manual", {});

    expect(result).toMatchObject({
      success: true,
      deleted: 1,
      errors: 0,
    });
    expect(adapter.remove).toHaveBeenCalledWith(deletedPath);
    expect(present.has(deletedPath)).toBe(false);
    expect(settleLocalDeleteDecisions).toHaveBeenCalledWith([
      { token: record.token, path: deletedPath },
    ]);
  });

  it("keeps the decision when the local erase fails, so the next round can retry", async () => {
    const { executor, settleLocalDeleteDecisions, present } = makeHarness({
      removeFails: true,
    });
    const result = await executor.run("manual", {});

    expect(result.errors).toBeGreaterThan(0);
    expect(present.has(deletedPath)).toBe(true);
    expect(settleLocalDeleteDecisions).not.toHaveBeenCalled();
  });
});
