import { describe, expect, it, vi } from "vitest";
import { selectNextProvablyReplacedIdentityRetirementV2 } from "../src/sync/stale-replacement-settlement";
import type {
  BaseFileEntry,
  LocalFileEntry,
  RemoteFileEntry,
  SyncPlanItem,
} from "../src/sync/types";
import { TEST_SYNC_SCOPE } from "./helpers/sync-safety-harness";
import { createFileStateShadowEnvelopeV2 } from "./helpers/file-state-shadow-v2";

const HASH = "a".repeat(64);

function facts(input: {
  remoteHash?: string;
  remainingDownloads?: number;
  resolve?: () => Promise<string>;
} = {}) {
  const scope = { ...TEST_SYNC_SCOPE, accountId: "account-test" };
  const remote: RemoteFileEntry = {
    path: "old.md",
    driveId: "replacement",
    parentId: scope.filesRootId,
    size: 10,
    mtime: 1,
    eTag: "etag-replacement",
    ...(input.remoteHash ? { sha256Hash: input.remoteHash } : {}),
    downloadUrl: "https://example.invalid/old.md",
  };
  const base: BaseFileEntry = {
    path: "old.md",
    hash: HASH,
    size: 10,
    eTag: "etag-original",
  };
  const local: LocalFileEntry = {
    path: "moved.md",
    hash: HASH,
    size: 10,
    mtime: 2,
    binary: false,
  };
  const envelope = createFileStateShadowEnvelopeV2({
    scope,
    lifecycleEpoch: 1,
    commitSeq: 1,
    committedAt: 1,
    remoteEntries: [remote],
    remoteFolders: [],
    baseEntries: [base],
  });
  envelope.folderAnchors = { schemaVersion: 2, byAnchorId: {} };
  const anchor = Object.values(envelope.anchors.byAnchorId)[0]!;
  envelope.anchors.byAnchorId = {
    [anchor.anchorId]: { ...anchor, remoteId: "original" },
  };
  return {
    envelope,
    remote,
    local,
    input: {
      envelope,
      localFiles: [local],
      localFolders: [],
      localFolderScanComplete: true,
      skippedLarge: [],
      remoteEntries: [remote],
      includeFilePath: () => true,
      includeFolderPath: () => true,
      preserveFolderPath: () => false,
      configDir: ".obsidian",
      automaticDeleteLocalFiles: false,
      skippedPaths: new Set<string>(),
      remainingDownloads: input.remainingDownloads ?? 0,
      resolveRemoteContentHash:
        input.resolve ?? (async () => {
          throw new Error("no download budget");
        }),
    },
  };
}

/**
 * Replacement candidates in anchor order. Every occupant is hashless (so it
 * must be downloaded) except `knownHashIndex`, whose hash already matches the
 * anchor. The caller loops the selector after each accepted retirement, so
 * several hashless occupants ahead of the match exercise the download cap and
 * the per-download budget accounting.
 */
function candidateFacts(input: {
  count: number;
  knownHashIndex?: number;
  resolve?: (path: string) => Promise<string>;
  remainingDownloads?: number;
}) {
  const scope = { ...TEST_SYNC_SCOPE, accountId: "account-test" };
  const candidates = Array.from({ length: input.count }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    const driveId = `id-${suffix}`;
    return {
      path: `old-${suffix}.md`,
      driveId,
      anchorId: `shadow:${driveId}`,
      hash: suffix.repeat(32),
      localPath: `moved-${suffix}.md`,
    };
  });
  const remotes: RemoteFileEntry[] = candidates.map((candidate, index) => ({
    path: candidate.path,
    driveId: candidate.driveId,
    parentId: scope.filesRootId,
    size: 10,
    mtime: 1,
    eTag: `etag-${candidate.driveId}`,
    ...(index === input.knownHashIndex
      ? { sha256Hash: candidate.hash }
      : {}),
    downloadUrl: `https://example.invalid/${candidate.path}`,
  }));
  const bases: BaseFileEntry[] = candidates.map((candidate) => ({
    path: candidate.path,
    hash: candidate.hash,
    size: 10,
    eTag: `etag-original-${candidate.driveId}`,
  }));
  const locals: LocalFileEntry[] = candidates.map((candidate) => ({
    path: candidate.localPath,
    hash: candidate.hash,
    size: 10,
    mtime: 2,
    binary: false,
  }));
  const envelope = createFileStateShadowEnvelopeV2({
    scope,
    lifecycleEpoch: 1,
    commitSeq: 1,
    committedAt: 1,
    remoteEntries: remotes,
    remoteFolders: [],
    baseEntries: bases,
  });
  envelope.folderAnchors = { schemaVersion: 2, byAnchorId: {} };
  for (const candidate of candidates) {
    envelope.anchors.byAnchorId[candidate.anchorId] = {
      ...envelope.anchors.byAnchorId[candidate.anchorId]!,
      remoteId: `original-${candidate.driveId}`,
    };
  }
  const resolveContent = input.resolve ?? (async () => {
    throw new Error("no download budget");
  });
  return {
    candidates,
    envelope,
    input: {
      envelope,
      localFiles: locals,
      localFolders: [],
      localFolderScanComplete: true,
      skippedLarge: [],
      remoteEntries: remotes,
      includeFilePath: () => true,
      includeFolderPath: () => true,
      preserveFolderPath: () => false,
      configDir: ".obsidian",
      automaticDeleteLocalFiles: false,
      skippedPaths: new Set<string>(),
      remainingDownloads: input.remainingDownloads ?? 10,
      resolveRemoteContentHash: (item: Readonly<SyncPlanItem>) =>
        resolveContent(item.path),
    },
  };
}

function retireCandidate(
  envelope: ReturnType<typeof candidateFacts>["envelope"],
  anchorId: string,
): void {
  delete envelope.anchors.byAnchorId[anchorId];
}

describe("provable same-path replacement settlement", () => {
  it("selects the stale anchor when the occupant bytes equal the anchor", async () => {
    const fixture = facts({ remoteHash: HASH });
    const candidate =
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input);

    expect(candidate).not.toBeNull();
    expect(candidate?.path).toBe("old.md");
    expect(candidate?.downloadsConsumed).toBe(0);
    expect(candidate?.snapshot.kind).toBe("file-replacement");
    expect(candidate?.snapshot.path).toBe("old.md");
    expect(candidate?.snapshot.relatedPaths).toEqual(["moved.md"]);
    expect(candidate?.snapshot.fileAnchors).toHaveLength(1);
  });

  it("keeps the review row when the occupant bytes differ", async () => {
    const fixture = facts({ remoteHash: "b".repeat(64) });
    expect(
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input),
    ).toBeNull();
  });

  it("downloads the occupant only when the budget allows it", async () => {
    const noBudget = facts({ remainingDownloads: 0 });
    expect(
      await selectNextProvablyReplacedIdentityRetirementV2(noBudget.input),
    ).toBeNull();

    const resolve = vi.fn().mockResolvedValue(HASH);
    const withBudget = facts({ remainingDownloads: 1, resolve });
    const candidate =
      await selectNextProvablyReplacedIdentityRetirementV2(withBudget.input);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(candidate?.downloadsConsumed).toBe(1);
    expect(candidate?.path).toBe("old.md");
  });

  it("keeps the review row when the content check fails", async () => {
    const fixture = facts({
      remainingDownloads: 1,
      resolve: async () => {
        throw new Error("download failed");
      },
    });
    expect(
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input),
    ).toBeNull();
  });

  it("charges a mismatched occupant's download to the caller's budget", async () => {
    const resolve = vi.fn().mockResolvedValue("b".repeat(64));
    const fixture = candidateFacts({ count: 2, knownHashIndex: 1, resolve });

    const candidate =
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(candidate?.path).toBe("old-01.md");
    expect(candidate?.downloadsConsumed).toBe(1);
  });

  it("reports every download a selection consumed", async () => {
    const resolve = vi.fn(async (path: string) =>
      path === "old-02.md" ? "02".repeat(32) : "b".repeat(64));
    const fixture = candidateFacts({ count: 3, resolve });

    const candidate =
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input);

    expect(resolve).toHaveBeenCalledTimes(3);
    expect(candidate?.path).toBe("old-02.md");
    expect(candidate?.downloadsConsumed).toBe(3);
  });

  it("caps one selection's downloads at the remaining budget", async () => {
    const resolve = vi.fn().mockResolvedValue("b".repeat(64));
    const fixture = candidateFacts({
      count: 12,
      remainingDownloads: 10,
      resolve,
    });

    expect(
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input),
    ).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(10);
  });

  it("records a mismatched occupant instead of downloading it again", async () => {
    const resolve = vi.fn().mockResolvedValue("b".repeat(64));
    const fixture = candidateFacts({ count: 2, knownHashIndex: 1, resolve });

    const first =
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input);
    expect(first?.path).toBe("old-01.md");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fixture.input.skippedPaths.has("old-00.md")).toBe(true);

    // The caller retires old-01.md and re-enters the selector with the same
    // round-scoped attempted set and the budget it just decremented.
    retireCandidate(fixture.envelope, "shadow:id-01");
    expect(
      await selectNextProvablyReplacedIdentityRetirementV2({
        ...fixture.input,
        remainingDownloads: 9,
      }),
    ).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("records an unreadable occupant instead of downloading it again", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("download failed"));
    const fixture = candidateFacts({ count: 2, knownHashIndex: 1, resolve });

    const first =
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(first?.path).toBe("old-01.md");
    expect(first?.downloadsConsumed).toBe(1);
    expect(fixture.input.skippedPaths.has("old-00.md")).toBe(true);

    retireCandidate(fixture.envelope, "shadow:id-01");
    expect(
      await selectNextProvablyReplacedIdentityRetirementV2({
        ...fixture.input,
        remainingDownloads: 9,
      }),
    ).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
