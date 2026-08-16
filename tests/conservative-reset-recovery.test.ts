import { describe, expect, it } from "vitest";
import {
  areIndependentConservativeResetRecords,
  conservativeResetRecordPaths,
  isConservativeResetOrdinaryRecord,
  isOrdinaryFileRecoveryRecord,
} from "../src/sync/conservative-reset-recovery";
import type { SyncAnchorV2 } from "../src/sync/state-envelope-v2";
import type {
  MutationAction,
  MutationCheckpointV1,
  MutationLedgerEntryV1,
  MutationRemoteExpectation,
  RemoteFileEntry,
  SyncScope,
} from "../src/sync/types";

const scope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  appRootId: "app-root",
  vaultsRootId: "vaults-root",
  vaultRootId: "vault-root",
  filesRootId: "files-root",
};
const local = { exists: true as const, hash: "a".repeat(64), size: 10 };
const missingLocal = { exists: false as const };
const remote = (driveId: string): MutationRemoteExpectation => ({
  exists: true,
  driveId,
  eTag: `etag-${driveId}`,
  size: 10,
  sha256Hash: "a".repeat(64),
});
const missingRemote = { exists: false as const };

function emptyCheckpoint(): MutationCheckpointV1 {
  return {
    baseUpserts: [],
    baseRemovals: [],
    remoteUpserts: [],
    remoteDeletes: [],
    pendingConflictRemovals: [],
    pendingDeleteRemovals: [],
  };
}

function remoteEntry(
  path: string,
  driveId: string,
  hash = local.hash,
): RemoteFileEntry {
  return {
    path,
    driveId,
    parentId: "files-root",
    size: 10,
    mtime: 1,
    eTag: `etag-${driveId}-result`,
    cTag: `ctag-${driveId}`,
    sha256Hash: hash,
  };
}

function record(
  action: MutationAction,
  options: {
    operationId?: string;
    path?: string;
    sourcePath?: string;
    expectedRemote?: MutationRemoteExpectation;
    receipt?: boolean;
  } = {},
): MutationLedgerEntryV1 {
  const path = options.path ?? `${action}.md`;
  const operationId = options.operationId ?? `op-${action}`;
  const sourcePath = options.sourcePath
    ?? ((action === "renameRemote" || action === "moveLocal")
      ? `old-${path}`
      : undefined);
  const expectedLocal = action === "download" || action === "deleteRemote"
    ? missingLocal
    : local;
  const expectedRemote = options.expectedRemote
    ?? (action === "deleteLocal" ? missingRemote : remote(`id-${action}`));
  const intent = {
    version: 1 as const,
    operationId,
    planRevision: 1,
    scope,
    action,
    path,
    ...(sourcePath ? { sourcePath } : {}),
    expectedLocal,
    expectedRemote,
    ...(action === "merge"
      ? { target: { hash: "b".repeat(64), size: 10 } }
      : {}),
    createdAt: 1,
  };
  if (!options.receipt) return { intent, receipt: null };
  const checkpoint = emptyCheckpoint();
  const upsert = remoteEntry(
    path,
    expectedRemote.exists
      ? expectedRemote.driveId
      : `created-${action}`,
    action === "merge" ? "b".repeat(64) : local.hash,
  );
  switch (action) {
    case "upload":
      checkpoint.baseUpserts.push({
        path,
        hash: local.hash,
        size: local.size,
        eTag: upsert.eTag,
      });
      checkpoint.remoteUpserts.push(upsert);
      break;
    case "download":
      checkpoint.baseUpserts.push({
        path,
        hash: expectedRemote.exists && expectedRemote.sha256Hash
          ? expectedRemote.sha256Hash
          : local.hash,
        size: 10,
        eTag: (expectedRemote as Extract<MutationRemoteExpectation, { exists: true }>).eTag,
      });
      break;
    case "deleteRemote":
      checkpoint.baseRemovals.push(path);
      checkpoint.remoteDeletes.push(path);
      break;
    case "deleteLocal":
      checkpoint.baseRemovals.push(path);
      checkpoint.pendingDeleteRemovals.push(path);
      break;
    case "renameRemote":
    case "moveLocal":
      checkpoint.baseUpserts.push({
        path,
        hash: local.hash,
        size: local.size,
        eTag: upsert.eTag,
      });
      checkpoint.baseRemovals.push(sourcePath!);
      checkpoint.remoteUpserts.push(upsert);
      checkpoint.remoteDeletes.push(sourcePath!);
      break;
    case "merge":
      checkpoint.baseUpserts.push({
        path,
        hash: "b".repeat(64),
        size: 10,
        eTag: upsert.eTag,
      });
      checkpoint.remoteUpserts.push(upsert);
      checkpoint.pendingConflictRemovals.push(path);
      break;
  }
  return {
    intent,
    receipt: {
      version: 1,
      operationId,
      completedAt: 2,
      checkpoint,
    },
  };
}

describe("conservative reset ordinary-file recovery contract", () => {
  for (const action of [
    "upload",
    "download",
    "deleteRemote",
    "deleteLocal",
    "renameRemote",
    "moveLocal",
    "merge",
  ] as const) {
    it(`accepts canonical ${action} intent and receipt shapes`, () => {
      const intentOnly = record(action);
      expect(isOrdinaryFileRecoveryRecord(intentOnly, scope)).toBe(true);
      expect(isConservativeResetOrdinaryRecord(intentOnly, scope)).toBe(true);
      const receipted = record(action, { receipt: true });
      expect(isOrdinaryFileRecoveryRecord(receipted, scope)).toBe(true);
      expect(isConservativeResetOrdinaryRecord(receipted, scope)).toBe(true);
    });
  }

  it("keeps response-unknown create upload in ordinary isolation but out of reset", () => {
    const create = record("upload", { expectedRemote: missingRemote });
    expect(isOrdinaryFileRecoveryRecord(create, scope)).toBe(true);
    expect(isConservativeResetOrdinaryRecord(create, scope)).toBe(false);
    expect(isConservativeResetOrdinaryRecord(
      record("upload", { expectedRemote: missingRemote, receipt: true }),
      scope,
    )).toBe(true);
  });

  it("rejects parser-readable but non-canonical intent and receipt shapes", () => {
    const wrongUpload = record("upload");
    wrongUpload.intent.expectedLocal = { exists: false };
    expect(isOrdinaryFileRecoveryRecord(wrongUpload, scope)).toBe(false);

    const extraSource = record("download");
    extraSource.intent.sourcePath = "old.md";
    expect(isOrdinaryFileRecoveryRecord(extraSource, scope)).toBe(false);

    const splitMoveIdentity = record("moveLocal");
    if (!splitMoveIdentity.intent.expectedRemote.exists) {
      throw new Error("move fixture requires a remote identity");
    }
    splitMoveIdentity.intent.expectedRemote.size += 1;
    expect(isOrdinaryFileRecoveryRecord(splitMoveIdentity, scope)).toBe(false);

    const malformedReceipt = record("download", { receipt: true });
    malformedReceipt.receipt!.checkpoint.baseUpserts.push({
      path: malformedReceipt.intent.path,
      hash: "c".repeat(64),
      size: 10,
      eTag: "duplicate",
    });
    expect(isOrdinaryFileRecoveryRecord(malformedReceipt, scope)).toBe(false);

    const unrelatedPending = record("upload", { receipt: true });
    unrelatedPending.receipt!.checkpoint.pendingDeleteRemovals.push("other.md");
    expect(isOrdinaryFileRecoveryRecord(unrelatedPending, scope)).toBe(false);
  });

  it("accepts both pending carriers only when the receipt binds both to its own path", () => {
    const bounded = record("upload", { receipt: true });
    bounded.receipt!.checkpoint.pendingConflictRemovals = [bounded.intent.path];
    bounded.receipt!.checkpoint.pendingDeleteRemovals = [bounded.intent.path];
    expect(isOrdinaryFileRecoveryRecord(bounded, scope)).toBe(true);
    expect(isConservativeResetOrdinaryRecord(bounded, scope)).toBe(true);

    bounded.receipt!.checkpoint.pendingDeleteRemovals = ["other.md"];
    expect(isOrdinaryFileRecoveryRecord(bounded, scope)).toBe(false);
  });

  it("rejects receipts whose durable versions do not bind to the intent", () => {
    const wrongUpload = record("upload", { receipt: true });
    wrongUpload.receipt!.checkpoint.remoteUpserts[0].sha256Hash = "c".repeat(64);
    expect(isConservativeResetOrdinaryRecord(wrongUpload, scope)).toBe(false);

    const wrongDownload = record("download", { receipt: true });
    wrongDownload.receipt!.checkpoint.baseUpserts[0].eTag = "stale-etag";
    expect(isConservativeResetOrdinaryRecord(wrongDownload, scope)).toBe(false);

    const wrongRename = record("renameRemote", { receipt: true });
    wrongRename.receipt!.checkpoint.remoteUpserts[0].driveId = "replacement-id";
    expect(isConservativeResetOrdinaryRecord(wrongRename, scope)).toBe(false);

    const wrongMove = record("moveLocal", { receipt: true });
    wrongMove.receipt!.checkpoint.baseUpserts[0].size += 1;
    expect(isConservativeResetOrdinaryRecord(wrongMove, scope)).toBe(false);

    const wrongMerge = record("merge", { receipt: true });
    wrongMerge.receipt!.checkpoint.baseUpserts[0].hash = "d".repeat(64);
    expect(isConservativeResetOrdinaryRecord(wrongMerge, scope)).toBe(false);
  });

  it("owns every exact source, target and checkpoint path", () => {
    const moved = record("renameRemote", { receipt: true });
    expect(conservativeResetRecordPaths(moved)).toEqual([
      moved.intent.sourcePath,
      moved.intent.path,
    ]);
  });

  it("rejects duplicate operations and normalized path intersections", () => {
    const first = record("download", { operationId: "same", path: "A.md" });
    const duplicate = record("download", { operationId: "same", path: "B.md" });
    expect(areIndependentConservativeResetRecords([first, duplicate])).toBe(false);
    const caseCollision = record("download", {
      operationId: "other",
      path: "a.md",
    });
    expect(areIndependentConservativeResetRecords([first, caseCollision])).toBe(false);
  });

  it("rejects ancestor namespaces while keeping siblings independent", () => {
    const parentFile = record("download", {
      operationId: "parent-file",
      path: "Dir",
      expectedRemote: remote("id-parent"),
    });
    const descendant = record("download", {
      operationId: "descendant",
      path: "Dir/a.md",
      expectedRemote: remote("id-descendant"),
    });
    const sibling = record("download", {
      operationId: "sibling",
      path: "Other/b.md",
      expectedRemote: remote("id-sibling"),
    });

    expect(areIndependentConservativeResetRecords([
      parentFile,
      descendant,
    ])).toBe(false);
    expect(areIndependentConservativeResetRecords([
      descendant,
      sibling,
    ])).toBe(true);
    const descendantId = (descendant.intent.expectedRemote as Extract<
      MutationRemoteExpectation,
      { exists: true }
    >).driveId;
    expect(areIndependentConservativeResetRecords(
      [descendant],
      new Map([[descendantId, "Dir"]]),
    )).toBe(true);
    expect(areIndependentConservativeResetRecords(
      [descendant, parentFile],
      new Map([[descendantId, "Dir"]]),
    )).toBe(false);
  });

  it("rejects a current-ID path collision and an indirect anchor claim", () => {
    const first = record("download", { path: "X.md" });
    const second = record("download", { path: "Y.md" });
    const secondId = (second.intent.expectedRemote as Extract<
      MutationRemoteExpectation,
      { exists: true }
    >).driveId;
    expect(areIndependentConservativeResetRecords(
      [first, second],
      new Map([[secondId, "X.md"]]),
    )).toBe(false);

    const anchor: SyncAnchorV2 = {
      anchorId: "file:indirect",
      remoteId: secondId,
      lastPath: "X.md",
      contentHash: "a".repeat(64),
      size: 10,
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };
    expect(areIndependentConservativeResetRecords(
      [first, second],
      new Map(),
      [anchor],
    )).toBe(false);
  });

  it("checks the known 23-record recovery scale without a ledger-size gate", () => {
    const records = Array.from({ length: 23 }, (_, index) => record("download", {
      operationId: `op-batch-${index}`,
      path: `Batch/${index}.md`,
      expectedRemote: remote(`id-batch-${index}`),
    }));
    const anchors = Array.from({ length: 5_000 }, (_, index): SyncAnchorV2 => ({
      anchorId: `file:unrelated-${index}`,
      remoteId: `unrelated-${index}`,
      lastPath: `Archive/${index}.md`,
      contentHash: "e".repeat(64),
      size: 10,
      confirmedAt: 1,
      confirmedBy: "equal-read",
    }));

    expect(areIndependentConservativeResetRecords(
      records,
      new Map(),
      anchors,
    )).toBe(true);
  });
});
