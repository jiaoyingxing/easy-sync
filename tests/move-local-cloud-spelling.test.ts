import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { SyncActionType } from "../src/sync/types";
import type { MutationIntent, RemoteFileEntry } from "../src/sync/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import { SyncExecutor, type SyncResult } from "../src/sync/sync-executor";
import { normalizeRemotePathKey } from "../src/sync/canonical-plan-v2";
import { projectRemoteIndexV2 } from "../src/sync/remote-index-v2";
import {
  emptyScanner,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
  TEST_SYNC_SCOPE,
} from "./helpers/sync-safety-harness";

/**
 * Cloud-side case-only rename followed by the local file (F34 family,
 * 2026-11-05).
 *
 * The planner emits `move-local` when the cloud renamed `Meta分析.md` ->
 * `meta分析.md` while the local side kept the anchored spelling. Graph path
 * addressing ignores case, so the source spelling still resolves to the same
 * live object — the executor must read that as an alias of the target, rename
 * the one local file, and never defer forever on `remoteSource !== undefined`.
 */

const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
const hash = "a".repeat(64);
const size = 10;
const driveId = "file-case-alias";
const parentId = scope.filesRootId;
const eTag = "etag-case-alias";
const localSpelling = "Meta分析.md";
const cloudSpelling = "meta分析.md";

function remote(path: string, id = driveId): RemoteFileEntry {
  return {
    path,
    driveId: id,
    parentId,
    size,
    mtime: 1,
    eTag,
    cTag: "ctag",
    sha256Hash: hash,
  };
}

function caseAliasHarness(options: {
  caseInsensitiveLocal?: boolean;
  sourceDriveId?: string;
  seededState?: boolean;
} = {}) {
  let livePath = localSpelling;
  const samePath = (left: string, right: string): boolean =>
    options.caseInsensitiveLocal
      ? normalizeRemotePathKey(left) === normalizeRemotePathKey(right)
      : left === right;
  const vault = {
    adapter: makeMockAdapter(),
    getFiles: vi.fn().mockReturnValue([]),
    getName: vi.fn().mockReturnValue("testVault"),
    getAbstractFileByPath: vi.fn((path: string) =>
      samePath(path, livePath) ? new TFile(livePath) : null),
    rename: vi.fn(async (_file: { path: string }, target: string) => {
      livePath = target;
    }),
  };
  const scanner = {
    ...emptyScanner(),
    vault,
    inspectFile: vi.fn(async (path: string) => {
      if (!samePath(path, livePath)) return { status: "missing" as const };
      return {
        status: "present" as const,
        entry: { path: livePath, hash, size, mtime: 1, binary: false },
      };
    }),
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
  } as unknown as LocalScanner;
  const onedrive = makeMockOneDrive({
    // Graph resolves both spellings to the live object.
    getFileMetadata: vi.fn(async (_vault: string, path: string) => ({
      driveId: path === localSpelling
        ? options.sourceDriveId ?? driveId
        : driveId,
      parentId,
      size,
      mtime: 1,
      eTag,
      cTag: "ctag",
      sha256Hash: hash,
    })),
  });
  const state = options.seededState
    ? makeActiveV2State(
        [remote(localSpelling)],
        [{ path: localSpelling, hash, size, eTag }],
      )
    : makeActiveV2State([], []);
  const executor = new SyncExecutor(
    onedrive,
    scanner,
    state,
    "testVault",
    undefined,
    undefined,
  );
  (executor as unknown as { activeSyncScope: typeof scope })
    .activeSyncScope = scope;
  return { executor, state, vault, liveName: () => livePath };
}

function executeMoveLocal(
  executor: SyncExecutor,
): Promise<{
  executed: boolean;
  baseRemoval?: string;
  baseUpsert?: { path: string; hash: string; size: number; eTag: string };
}> {
  const result = {} as SyncResult;
  return (executor as unknown as {
    executeMoveLocalFileItem(args: {
      item: unknown;
      result: SyncResult;
      remoteUpserts: RemoteFileEntry[];
      remoteDeletes: string[];
      callbacks: Record<string, never>;
      operationEpoch: number;
      factsChangedPolicy: "defer" | "throw";
    }): Promise<{
      executed: boolean;
      baseRemoval?: string;
      baseUpsert?: { path: string; hash: string; size: number; eTag: string };
    }>;
  }).executeMoveLocalFileItem({
    item: {
      type: SyncActionType.MoveLocalFile,
      path: cloudSpelling,
      renameFrom: localSpelling,
      local: { path: localSpelling, hash, size, mtime: 1, binary: false },
      remote: remote(cloudSpelling),
    },
    result,
    remoteUpserts: [],
    remoteDeletes: [],
    callbacks: {},
    operationEpoch: 0,
    factsChangedPolicy: "defer",
  });
}

describe("move-local under a cloud-side case-only rename", () => {
  it("renames the local file when the source spelling resolves to the same identity", async () => {
    const { executor, vault, liveName } = caseAliasHarness();

    const outcome = await executeMoveLocal(executor);

    expect(outcome.executed).toBe(true);
    expect(liveName()).toBe(cloudSpelling);
    expect(vault.rename).toHaveBeenCalledTimes(1);
    expect(outcome.baseRemoval).toBe(localSpelling);
    expect(outcome.baseUpsert?.path).toBe(cloudSpelling);
  });

  it("treats a case-insensitive host as a completed move", async () => {
    const { executor, liveName } = caseAliasHarness({
      caseInsensitiveLocal: true,
    });

    const outcome = await executeMoveLocal(executor);

    expect(outcome.executed).toBe(true);
    expect(liveName()).toBe(cloudSpelling);
  });

  it("still defers when the source spelling is a different live object", async () => {
    const { executor, vault, liveName } = caseAliasHarness({
      sourceDriveId: "another-file",
    });

    const outcome = await executeMoveLocal(executor);

    expect(outcome.executed).toBe(false);
    expect(liveName()).toBe(localSpelling);
    expect(vault.rename).not.toHaveBeenCalled();
  });

  it("verifies the alias move receipt in the recovery lane", async () => {
    const { executor } = caseAliasHarness();
    await executeMoveLocal(executor);
    const operationId = "op-case-alias-verify";
    const record = {
      intent: {
        version: 1 as const,
        operationId,
        planRevision: 1,
        scope,
        action: "moveLocal" as const,
        path: cloudSpelling,
        sourcePath: localSpelling,
        expectedLocal: { exists: true as const, hash, size },
        expectedRemote: {
          exists: true as const,
          driveId,
          eTag,
          size,
          sha256Hash: hash,
        },
        createdAt: 1,
      },
      receipt: {
        version: 1 as const,
        operationId,
        completedAt: 2,
        checkpoint: {
          baseUpserts: [{ path: cloudSpelling, hash, size, eTag }],
          baseRemovals: [localSpelling],
          remoteUpserts: [remote(cloudSpelling)],
          remoteDeletes: [localSpelling],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    };

    await expect((executor as unknown as {
      verifyMutationReceipt(entry: unknown): Promise<boolean>;
    }).verifyMutationReceipt(record)).resolves.toBe(true);
  });

  it("commits the alias move through the real file reducer", async () => {
    const { executor, state } = caseAliasHarness({ seededState: true });
    const outcome = await executeMoveLocal(executor);
    expect(outcome.executed).toBe(true);

    const operationId = "op-case-alias-move";
    const intent: MutationIntent = {
      version: 1,
      operationId,
      planRevision: 1,
      scope,
      action: "moveLocal",
      path: cloudSpelling,
      sourcePath: localSpelling,
      expectedLocal: { exists: true, hash, size },
      expectedRemote: {
        exists: true,
        driveId,
        eTag,
        size,
        sha256Hash: hash,
      },
      createdAt: 1,
    };
    await state.beginMutationIntent(intent);
    await state.recordMutationReceipt({
      version: 1,
      operationId,
      completedAt: 2,
      checkpoint: {
        baseUpserts: [outcome.baseUpsert!],
        baseRemovals: [outcome.baseRemoval!],
        remoteUpserts: [remote(cloudSpelling)],
        remoteDeletes: [localSpelling],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    });
    await state.commitMutationCheckpoint(operationId);

    expect(state.mutationLedger).toEqual([]);
    const committed = state.getCommittedV2Envelope()!;
    expect(projectRemoteIndexV2(committed.remoteIndex).get(driveId))
      .toBe(cloudSpelling);
    expect(Object.values(committed.anchors.byAnchorId)).toMatchObject([{
      remoteId: driveId,
      lastPath: cloudSpelling,
      contentHash: hash,
    }]);
  });
});
