import { describe, it, expect, vi } from "vitest";
import {
  SyncExecutor,
  describeRemoteEnumScopeFingerprint,
} from "../src/sync/sync-executor";
import type { StateManager } from "../src/sync/state-manager";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { OneDriveClient } from "../src/onedrive/client";
import {
  OneDriveError,
  OneDriveErrorType,
} from "../src/onedrive/types";
import {
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
  TEST_SYNC_SCOPE,
} from "./sync-safety.test";

const PAGE2_URL = "https://graph.microsoft.com/v1.0/me/drive/next-page";
const SCAN_SCOPE = { ...TEST_SYNC_SCOPE, accountId: "account-id" };

function makeDriveItem(id: string, name: string) {
  return {
    id,
    name,
    size: 3,
    eTag: `etag-${id}`,
    cTag: `ctag-${id}`,
    parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
    file: {
      hashes: {
        quickXorHash: "provider-quickxor",
        sha256Hash: "aa".repeat(32),
      },
    },
  };
}

/** Standard empty-vault harness (mirrors the healthy-sync case in
 *  sync-safety.test.ts) with an in-memory enumeration-checkpoint store. */
function makeHarness(getDeltaImpl: (...args: never[]) => unknown) {
  const checkpointStore: { current: unknown } = { current: null };
  const state = makeActiveV2State([], []) as StateManager & {
    getRemoteEnumCheckpoint: ReturnType<typeof vi.fn>;
    saveRemoteEnumCheckpoint: ReturnType<typeof vi.fn>;
    clearRemoteEnumCheckpoint: ReturnType<typeof vi.fn>;
  };
  state.getRemoteEnumCheckpoint = vi.fn(async () =>
    checkpointStore.current === null
      ? null
      : JSON.parse(JSON.stringify(checkpointStore.current)),
  );
  state.saveRemoteEnumCheckpoint = vi.fn(async (checkpoint: unknown) => {
    checkpointStore.current = JSON.parse(JSON.stringify(checkpoint));
  });
  state.clearRemoteEnumCheckpoint = vi.fn(async () => {
    checkpointStore.current = null;
  });
  // 首 join 形态：无增量缓存，枚举走 complete-delta 路径。
  (state as unknown as { hasRemoteState: boolean }).hasRemoteState = false;
  (state as unknown as { remoteDeltaLink: string | null }).remoteDeltaLink =
    null;
  const fullScan = vi.fn().mockRejectedValue(
    new OneDriveError(OneDriveErrorType.NetworkError, "full scan offline", 0),
  );
  const onedrive = makeMockOneDrive({
    getDelta: vi.fn(getDeltaImpl),
    fullScan,
  });
  const executor = new SyncExecutor(
    onedrive as unknown as OneDriveClient,
    {
      vault: {
        adapter: makeMockAdapter(),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn().mockResolvedValue(null),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner,
    state,
    "testVault",
  );
  return { executor, state, checkpointStore, fullScan };
}

describe("remote enumeration checkpoint (join 弱网案C)", () => {
  it("persists page progress when a mid-enumeration page fails, then resumes from the checkpoint next round", async () => {
    const item1 = makeDriveItem("item-1", "first.md");
    const item2 = makeDriveItem("item-2", "second.md");
    let round = 0;
    const tokensSeen: (string | undefined)[] = [];
    const { executor, state, checkpointStore } = makeHarness(
      async (
        _vaultName: string,
        token?: string,
        onPage?: (page: {
          values: unknown[];
          nextLink?: string;
          deltaLink?: string;
        }) => Promise<void>,
      ) => {
        round += 1;
        tokensSeen.push(token);
        if (round === 1) {
          // First round: page 1 lands, page 2 never does (pure network death).
          if (onPage) {
            await onPage({ values: [item1], nextLink: PAGE2_URL });
          }
          throw new OneDriveError(
            OneDriveErrorType.NetworkError,
            "offline after page 1",
            0,
          );
        }
        // Second round resumes exactly from the persisted cursor.
        if (onPage) {
          await onPage({ values: [item2], deltaLink: "delta-token" });
        }
        return { value: [item2], "@odata.deltaLink": "delta-token" };
      },
    );

    // Round 1: zero-action retry-pending round, progress persisted.
    const first = await executor.run("auto", {});
    expect(first.uploaded).toBe(0);
    expect(first.downloaded).toBe(0);
    expect(first.success).toBe(false);
    const saved = checkpointStore.current as {
      scopeFingerprint: string;
      nextUrl: string;
      items: { id: string }[];
    } | null;
    expect(saved).not.toBeNull();
    expect(saved?.scopeFingerprint).toBe(
      describeRemoteEnumScopeFingerprint(SCAN_SCOPE),
    );
    expect(saved?.nextUrl).toBe(PAGE2_URL);
    expect(saved?.items.map((item) => item.id)).toEqual(["item-1"]);
    expect(state.saveRemoteEnumCheckpoint).toHaveBeenCalled();

    // Round 2: resume reads ONLY the missing tail; the checkpoint is consumed.
    const second = await executor.run("auto", {});
    expect(tokensSeen[1]).toBe(PAGE2_URL);
    expect(second.runFacts?.ordinaryPlanning).toBe("entered");
    expect(second.metrics?.fileTransfers.download.started).toBe(2);
    expect(state.clearRemoteEnumCheckpoint).toHaveBeenCalled();
    expect(checkpointStore.current).toBeNull();
    const persisted = (state.setRemoteState as ReturnType<typeof vi.fn>).mock
      .calls.at(-1);
    const persistedEntries = (persisted?.[0] ?? []) as { path: string }[];
    expect(persistedEntries.map((entry) => entry.path).sort()).toEqual([
      "first.md",
      "second.md",
    ]);
  });

  it("discards a checkpoint that failed with an HTTP status and re-reads from the first page in the same round", async () => {
    const item1 = makeDriveItem("item-1", "first.md");
    let call = 0;
    const tokensSeen: (string | undefined)[] = [];
    const { executor, checkpointStore } = makeHarness(
      async (
        _vaultName: string,
        token?: string,
        onPage?: (page: {
          values: unknown[];
          nextLink?: string;
          deltaLink?: string;
        }) => Promise<void>,
      ) => {
        call += 1;
        tokensSeen.push(token);
        if (call === 1) {
          if (onPage) {
            await onPage({ values: [item1], nextLink: PAGE2_URL });
          }
          throw new OneDriveError(
            OneDriveErrorType.NetworkError,
            "offline after page 1",
            0,
          );
        }
        if (call === 2) {
          // Resumed cursor is rejected with an HTTP status → session-level
          // death → the checkpoint must be discarded and the enumeration
          // re-read from the first page in the same round.
          throw new OneDriveError(
            OneDriveErrorType.Unknown,
            "gone",
            410,
          );
        }
        if (onPage) {
          await onPage({
            values: [item1, makeDriveItem("item-2", "second.md")],
            deltaLink: "delta-token",
          });
        }
        return {
          value: [item1, makeDriveItem("item-2", "second.md")],
          "@odata.deltaLink": "delta-token",
        };
      },
    );
    // Pre-seed round 1's outcome by running once (builds the checkpoint).
    await executor.run("auto", {});
    expect(checkpointStore.current).not.toBeNull();

    const second = await executor.run("auto", {});
    // Same-round recovery: first-page re-read happened (token undefined again).
    expect(tokensSeen).toContain(undefined);
    const undefinedAfterResume = tokensSeen.filter(
      (token, index) => token === undefined && index > 0,
    );
    expect(undefinedAfterResume.length).toBeGreaterThan(0);
    expect(second.runFacts?.ordinaryPlanning).toBe("entered");
    expect(second.metrics?.fileTransfers.download.started).toBe(2);
    expect(checkpointStore.current).toBeNull();
  });

  it("discards a checkpoint from a different sync scope", async () => {
    const { executor, state, checkpointStore } = makeHarness(
      async () => ({ value: [], "@odata.deltaLink": "tok" }) as never,
    );
    checkpointStore.current = {
      scopeFingerprint: "other|scope|fingerprint",
      nextUrl: PAGE2_URL,
      items: [makeDriveItem("stale", "stale.md")],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const result = await executor.run("auto", {});
    expect(result.success).toBe(true);
    expect(state.clearRemoteEnumCheckpoint).toHaveBeenCalled();
    expect(checkpointStore.current).toBeNull();
  });

  it("discards a checkpoint older than the TTL instead of resuming it", async () => {
    const { executor, state, checkpointStore } = makeHarness(
      async () => ({ value: [], "@odata.deltaLink": "tok" }) as never,
    );
    checkpointStore.current = {
      scopeFingerprint: describeRemoteEnumScopeFingerprint(SCAN_SCOPE),
      nextUrl: PAGE2_URL,
      items: [makeDriveItem("stale", "stale.md")],
      startedAt: Date.now() - 2 * 60 * 60 * 1000,
      updatedAt: Date.now() - 2 * 60 * 60 * 1000,
    };
    const result = await executor.run("auto", {});
    expect(result.success).toBe(true);
    expect(state.clearRemoteEnumCheckpoint).toHaveBeenCalled();
    expect(checkpointStore.current).toBeNull();
  });

  it("collapses duplicate ids to their last occurrence when a long session re-reports an item", async () => {
    const updated = {
      ...makeDriveItem("item-1", "renamed-later.md"),
      size: 9,
    };
    const { executor } = makeHarness(async () => ({
      value: [makeDriveItem("item-1", "first-name.md"), updated],
      "@odata.deltaLink": "tok",
    }) as never);
    const projection = await (
      executor as unknown as {
        projectCompleteRemoteSnapshot: (
          items: unknown[],
          filesRootId: string,
        ) => Promise<{ entries: { path: string; size: number }[] }>;
      }
    ).projectCompleteRemoteSnapshot(
      [makeDriveItem("item-1", "first-name.md"), updated],
      TEST_SYNC_SCOPE.filesRootId,
    );
    const first = projection.entries.find((entry) =>
      entry.path.endsWith(".md"),
    );
    expect(first?.path).toBe("renamed-later.md");
    expect(first?.size).toBe(9);
  });
});
