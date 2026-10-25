import { describe, expect, it, vi } from "vitest";
import { selectNextProvablyReplacedIdentityRetirementV2 } from "../src/sync/stale-replacement-settlement";
import type {
  BaseFileEntry,
  LocalFileEntry,
  RemoteFileEntry,
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

describe("provable same-path replacement settlement", () => {
  it("selects the stale anchor when the occupant bytes equal the anchor", async () => {
    const fixture = facts({ remoteHash: HASH });
    const candidate =
      await selectNextProvablyReplacedIdentityRetirementV2(fixture.input);

    expect(candidate).not.toBeNull();
    expect(candidate?.path).toBe("old.md");
    expect(candidate?.downloaded).toBe(false);
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
    expect(candidate?.downloaded).toBe(true);
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
});
