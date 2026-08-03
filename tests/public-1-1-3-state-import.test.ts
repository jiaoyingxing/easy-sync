import { describe, expect, it } from "vitest";
import {
  createPublic113BackupSnapshot,
  createPublic113MigrationInput,
  public113MigrationInputDigest,
} from "../src/sync/public-1-1-3-state-import";
import type { BaseFileEntry, RemoteSyncState } from "../src/sync/types";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};
const base: BaseFileEntry = {
  path: "Notes/a.md",
  hash: "a".repeat(64),
  size: 1,
  eTag: "etag-a",
};
const remoteState: RemoteSyncState = {
  version: 1,
  generation: 7,
  scope,
  deltaLink: "delta",
  entries: {
    [base.path]: {
      path: base.path,
      size: base.size,
      mtime: 1,
      eTag: base.eTag,
      cTag: "ctag-a",
      driveId: "file-a",
      parentId: "folder-notes",
    },
  },
  folders: {
    "folder-notes": {
      path: "Notes",
      driveId: "folder-notes",
      parentId: scope.filesRootId,
      name: "Notes",
      eTag: "etag-folder-notes",
    },
  },
  folderIndexComplete: true,
};

describe("public 1.1.3 state importer", () => {
  it("returns a detached capability-free value for V2 migration planning", () => {
    const sourceRemoteState = structuredClone(remoteState);
    const pluginData = {
      "easy-sync-base-snapshot": { [base.path]: base },
      "easy-sync-generation": 7,
      unknownFutureKey: { keep: true },
    };
    const input = createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData,
      remoteState: sourceRemoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    });

    expect(input).toMatchObject({
      kind: "public-1.1.3-read-only-input",
      sourceVersion: "1.1.3",
      lifecycleEpoch: 7,
      remoteScope: scope,
      remoteDeltaLink: "delta",
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
      remoteEntries: [expect.objectContaining({ driveId: "file-a" })],
      remoteFolders: [expect.objectContaining({ driveId: "folder-notes" })],
    });
    expect(Object.values(input).some((value) => typeof value === "function"))
      .toBe(false);

    pluginData.unknownFutureKey.keep = false;
    sourceRemoteState.entries[base.path]!.eTag = "changed";
    expect(input.pluginData.unknownFutureKey).toEqual({ keep: true });
    expect(input.remoteEntries[0]!.eTag).toBe("etag-a");
  });

  it("creates a second detached snapshot for the retained V1 backup", () => {
    const input = createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: { marker: { value: 1 } },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    });
    const backup = createPublic113BackupSnapshot(input);

    (backup.pluginData.marker as { value: number }).value = 2;
    backup.remoteState!.entries[base.path]!.eTag = "backup-change";
    (backup.baseContentEntries as Record<string, string>)[base.path] =
      "backup-content";

    expect(input.pluginData.marker).toEqual({ value: 1 });
    expect(input.remoteEntries[0]!.eTag).toBe("etag-a");
    expect(input.baseContentEntries[base.path]).toBe("a");
  });

  it("binds the transaction to all source values with a canonical digest", async () => {
    const left = createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: {
        z: { enabled: true, interval: 7 },
        a: ["one", "two"],
      },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    });
    const sameWithDifferentKeyOrder = createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: {
        a: ["one", "two"],
        z: { interval: 7, enabled: true },
      },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    });
    const changedSetting = createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: {
        a: ["one", "two"],
        z: { interval: 8, enabled: true },
      },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    });
    const changedBaseContent = createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: {
        a: ["one", "two"],
        z: { interval: 7, enabled: true },
      },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "b" },
    });

    const digest = await public113MigrationInputDigest(left);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(public113MigrationInputDigest(sameWithDifferentKeyOrder))
      .resolves.toBe(digest);
    await expect(public113MigrationInputDigest(changedSetting))
      .resolves.not.toBe(digest);
    await expect(public113MigrationInputDigest(changedBaseContent))
      .resolves.not.toBe(digest);
  });
});
