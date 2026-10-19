import { describe, expect, it } from "vitest";
import {
  createPublic113BackupSnapshot,
  createPublic113MigrationInput,
  public113BackupSnapshotSemanticallyMatches,
  public113MigrationInputDigest,
  public113MigrationInputDigestMatches,
  public113MigrationInputDigestV2,
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

  it("masks only self-churning bookkeeping keys in the round-stable digest", async () => {
    const semanticData = {
      "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
      "easy-sync-base-snapshot": { "a.md": { hash: "h" } },
      "sync-interval": 3,
      "release-1.1.3-unknown-key": { mustSurvive: true },
      "easy-sync-history": [{ round: 1 }],
    };
    const digest = await public113MigrationInputDigestV2(createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: semanticData,
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    }));

    // 屏蔽单键翻动（历史追加、时间戳推进、暂停位翻转、采样窗刷新）不动指纹。
    const churned = await public113MigrationInputDigestV2(createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: {
        "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
        "easy-sync-base-snapshot": { "a.md": { hash: "h" } },
        "sync-interval": 3,
        "release-1.1.3-unknown-key": { mustSurvive: true },
        "easy-sync-history": [{ round: 1 }, { round: 2 }, { round: 3 }],
        "easy-sync-last-sync-time": 123,
        "auto-sync-paused": true,
        "easy-sync-transfer-rates-window": { up: 42 },
      },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    }));
    expect(churned).toBe(digest);

    // 屏蔽单之外的一切——设置键、未知键、迁移语义键——仍是绑定对象。
    const settingsChanged = await public113MigrationInputDigestV2(createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: { ...semanticData, "easy-sync-history": [{ round: 1 }], "sync-interval": 9 },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    }));
    expect(settingsChanged).not.toBe(digest);
    const unknownChanged = await public113MigrationInputDigestV2(createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: { ...semanticData, "release-1.1.3-unknown-key": { mustSurvive: false } },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    }));
    expect(unknownChanged).not.toBe(digest);
    const ledgerChanged = await public113MigrationInputDigestV2(createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: { ...semanticData, "easy-sync-mutation-ledger": [{ op: "delete", path: "a.md" }] },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    }));
    expect(ledgerChanged).not.toBe(digest);
  });

  it("accepts a recorded digest under either definition and rejects real drift", async () => {
    const input = createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: {
        "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
        "easy-sync-history": [{ round: 1 }],
      },
      remoteState,
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    });
    const v2Digest = await public113MigrationInputDigestV2(input);
    const legacyDigest = await public113MigrationInputDigest(input);
    expect(v2Digest).not.toBe(legacyDigest);

    // V2 记录与旧式记录都可与 runtime 比对命中。
    await expect(public113MigrationInputDigestMatches(input, v2Digest))
      .resolves.toBe(true);
    await expect(public113MigrationInputDigestMatches(input, legacyDigest))
      .resolves.toBe(true);
    // 语义漂移（远端缓存变化）两种定义都不放行。
    const drifted = createPublic113MigrationInput({
      lifecycleEpoch: 7,
      pluginData: {
        "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
        "easy-sync-history": [{ round: 1 }],
      },
      remoteState: { ...remoteState, deltaLink: "delta-next" },
      baseEntries: [base],
      baseContentEntries: { [base.path]: "a" },
    });
    await expect(public113MigrationInputDigestMatches(drifted, v2Digest))
      .resolves.toBe(false);
    await expect(public113MigrationInputDigestMatches(drifted, legacyDigest))
      .resolves.toBe(false);
    // 非法记录值一律不匹配。
    await expect(public113MigrationInputDigestMatches(input, "zz"))
      .resolves.toBe(false);
  });

  it("keeps the V1 backup binding stable when pluginData bookkeeping churns across rounds", () => {
    // 生产快照形状：书记键住在 pluginData 里面（F31 第六层——首版屏蔽删在
    // 快照顶层，那里从来没有这些键，churn 屏蔽成了空操作）。
    const stored = createPublic113BackupSnapshot(
      createPublic113MigrationInput({
        lifecycleEpoch: 7,
        pluginData: {
          "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
          "auto-sync-paused": true,
          "easy-sync-last-sync-time": 100,
          "easy-sync-history": [{ round: 1 }],
        },
        remoteState,
        baseEntries: [base],
        baseContentEntries: { [base.path]: "a" },
      }),
      "legacy-staging-digest",
    );
    const churned = createPublic113BackupSnapshot(
      createPublic113MigrationInput({
        lifecycleEpoch: 7,
        pluginData: {
          "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
          "auto-sync-paused": false,
          "easy-sync-last-sync-time": 200,
          "easy-sync-history": [{ round: 1 }, { round: 2 }],
        },
        remoteState,
        baseEntries: [base],
        baseContentEntries: { [base.path]: "a" },
      }),
      "current-runtime-legacy-digest",
    );
    expect(public113BackupSnapshotSemanticallyMatches(stored, churned))
      .toBe(true);

    // 语义面（设置页、未知键、基底内容）任何变化仍然拒绝。
    const settingsChanged = createPublic113BackupSnapshot(
      createPublic113MigrationInput({
        lifecycleEpoch: 7,
        pluginData: {
          "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
          "easy-sync-changed-setting": true,
          "auto-sync-paused": false,
          "easy-sync-last-sync-time": 200,
          "easy-sync-history": [{ round: 1 }, { round: 2 }],
        },
        remoteState,
        baseEntries: [base],
        baseContentEntries: { [base.path]: "a" },
      }),
      "current-runtime-legacy-digest",
    );
    expect(public113BackupSnapshotSemanticallyMatches(stored, settingsChanged))
      .toBe(false);
    const unknownKeyChanged = createPublic113BackupSnapshot(
      createPublic113MigrationInput({
        lifecycleEpoch: 7,
        pluginData: {
          "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
          "future-key": "new",
          "auto-sync-paused": false,
          "easy-sync-last-sync-time": 200,
          "easy-sync-history": [{ round: 1 }, { round: 2 }],
        },
        remoteState,
        baseEntries: [base],
        baseContentEntries: { [base.path]: "a" },
      }),
      "current-runtime-legacy-digest",
    );
    expect(
      public113BackupSnapshotSemanticallyMatches(stored, unknownKeyChanged),
    ).toBe(false);
    const baseChanged = createPublic113BackupSnapshot(
      createPublic113MigrationInput({
        lifecycleEpoch: 7,
        pluginData: {
          "easy-sync-mutation-ledger": [{ op: "upload", path: "a.md" }],
          "auto-sync-paused": false,
          "easy-sync-last-sync-time": 200,
          "easy-sync-history": [{ round: 1 }, { round: 2 }],
        },
        remoteState,
        baseEntries: [base],
        baseContentEntries: { [base.path]: "b" },
      }),
      "current-runtime-legacy-digest",
    );
    expect(public113BackupSnapshotSemanticallyMatches(stored, baseChanged))
      .toBe(false);
  });
});
