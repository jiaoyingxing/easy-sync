// 批量 upsert 归约等价性 (2026-11-08)：上传批 / 下载提交组把 N 条普通文件
// 回执交给一个批量 reducer，而不是 N 次全库归约。注意它并非「一次投影、一次
// 校验」：每条 remote upsert 各做一次全量 projectRemoteIndexV2，入参与结果各
// 校验一次。
// 本文件钉住：
// 1. 批量结果与逐条归约的**逻辑状态**（base / remote / anchors）一致；
// 2. 任何非普通 upsert 形状（含删除、待处理清账、移动、sourcePath）返回 null，
//    调用方回退到逐条归约；
// 3. 空批次返回 null。
import { describe, expect, it } from "vitest";
import {
  projectFileStatePathViewV2,
  reduceFileStateEnvelopeV2,
  reduceFileStateEnvelopeV2Upserts,
} from "../src/sync/file-state-reducer-v2";
import type {
  BaseFileEntry,
  MutationLedgerEntryV1,
  RemoteFileEntry,
} from "../src/sync/types";
import { createFileStateShadowEnvelopeV2 } from "./helpers/file-state-shadow-v2";

const SCOPE = {
  accountId: "account-id",
  driveId: "drive-id",
  vaultFolderId: "vault-folder-id",
  filesRootId: "files-root-id",
};
const PARENT = SCOPE.filesRootId;

function remote(
  path: string,
  index: number,
  eTag = `etag-${index}-new`,
): RemoteFileEntry {
  return {
    path,
    driveId: `id-${index}`,
    parentId: PARENT,
    size: 18,
    mtime: index,
    eTag,
    cTag: `ctag-${index}-new`,
    sha256Hash: `${index.toString(16).padStart(2, "0")}`.repeat(32),
  };
}

function base(
  path: string,
  index: number,
  eTag = `etag-${index}-new`,
): BaseFileEntry {
  return {
    path,
    hash: `${index.toString(16).padStart(2, "0")}`.repeat(32),
    size: 18,
    eTag,
  };
}

function receipt(
  action: "upload" | "download",
  path: string,
  input: {
    baseEntry?: BaseFileEntry;
    remoteEntry?: RemoteFileEntry;
    sourcePath?: string;
    pendingDeleteRemovals?: string[];
    remoteDeletes?: string[];
    baseRemovals?: string[];
  } = {},
): MutationLedgerEntryV1 {
  return {
    intent: {
      version: 1,
      operationId: `op-${action}-${path}`,
      planRevision: 1,
      scope: SCOPE,
      action,
      path,
      sourcePath: input.sourcePath,
      expectedLocal: { exists: false },
      expectedRemote: { exists: true, driveId: `id-${path}` },
      createdAt: 1,
    },
    receipt: {
      version: 1,
      operationId: `op-${action}-${path}`,
      completedAt: 10,
      checkpoint: {
        baseUpserts: input.baseEntry ? [input.baseEntry] : [],
        baseRemovals: input.baseRemovals ?? [],
        remoteUpserts: input.remoteEntry ? [input.remoteEntry] : [],
        remoteDeletes: input.remoteDeletes ?? [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: input.pendingDeleteRemovals ?? [],
      },
    },
  } as unknown as MutationLedgerEntryV1;
}

function envelope() {
  return createFileStateShadowEnvelopeV2({
    scope: SCOPE,
    lifecycleEpoch: 1,
    commitSeq: 1,
    committedAt: 1,
    remoteEntries: [remote("down-0.md", 0)],
    remoteFolders: [],
    baseEntries: [base("down-0.md", 0, "etag-0-old")],
  });
}

describe("batched ordinary-file upsert reducer", () => {
  it("matches the logical state of N single-record reduces", () => {
    const records: MutationLedgerEntryV1[] = [
      // Existing-file advance (download): remote unchanged, base/anchor move
      // to the new version.
      receipt("download", "down-0.md", {
        baseEntry: base("down-0.md", 0),
      }),
      // New remote files (upload): both remote and base rows appear.
      receipt("upload", "up-1.md", {
        baseEntry: base("up-1.md", 1),
        remoteEntry: remote("up-1.md", 1),
      }),
      receipt("upload", "up-2.md", {
        baseEntry: base("up-2.md", 2),
        remoteEntry: remote("up-2.md", 2),
      }),
    ];
    const start = envelope();
    const batched = reduceFileStateEnvelopeV2Upserts(start, records);
    expect(batched).not.toBeNull();

    let sequential = start;
    for (const record of records) {
      sequential = reduceFileStateEnvelopeV2(sequential, record);
    }

    expect(projectFileStatePathViewV2(batched!)).toEqual(
      projectFileStatePathViewV2(sequential),
    );
    expect(batched!.anchors).toEqual(sequential.anchors);
    expect(batched!.remoteIndex.itemsById).toEqual(
      sequential.remoteIndex.itemsById,
    );
    // The batch is one commit, not N commits (the existing deletion batch
    // uses the same convention); the logical rows above are byte-identical.
    expect(batched!.meta.commitSeq).toBe(start.meta.commitSeq + 1);
  });

  it("returns null for any shape that is not an independent ordinary upsert", () => {
    const start = envelope();
    const withPendingRemoval = receipt("download", "down-0.md", {
      baseEntry: base("down-0.md", 0),
      pendingDeleteRemovals: ["down-0.md"],
    });
    const withSourceMove = receipt("upload", "up-3.md", {
      baseEntry: base("up-3.md", 3),
      remoteEntry: remote("up-3.md", 3),
      sourcePath: "old-3.md",
      baseRemovals: ["old-3.md"],
      remoteDeletes: ["old-3.md"],
    });
    const moveAction = {
      ...receipt("upload", "up-4.md", {
        baseEntry: base("up-4.md", 4),
        remoteEntry: remote("up-4.md", 4),
      }),
      intent: {
        ...receipt("upload", "up-4.md").intent,
        action: "moveLocal",
      },
    } as unknown as MutationLedgerEntryV1;

    expect(reduceFileStateEnvelopeV2Upserts(start, [])).toBeNull();
    expect(reduceFileStateEnvelopeV2Upserts(start, [withPendingRemoval]))
      .toBeNull();
    expect(reduceFileStateEnvelopeV2Upserts(start, [withSourceMove]))
      .toBeNull();
    expect(reduceFileStateEnvelopeV2Upserts(start, [moveAction])).toBeNull();
  });
});
