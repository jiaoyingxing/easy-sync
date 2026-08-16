import type { OneDriveClient } from "../onedrive/client";
import type { DriveItem } from "../onedrive/types";
import { isRecord } from "../obsidian-compat";
import {
  createCommunityPluginGenerationCleanupReceiptV1,
  validateCommunityPluginGenerationCleanupSnapshotV1,
  type CommunityPluginGenerationCleanupObjectConfirmationV1,
  type CommunityPluginGenerationCleanupObjectTargetV1,
  type CommunityPluginGenerationCleanupReceiptV1,
  type CommunityPluginGenerationCleanupSnapshotV1,
} from "./community-plugin-generation-cleanup-v1";
import {
  isCommunityPluginLifecycleControlMutationCheckpointV1,
  readCommunityPluginLifecycleControlV1,
  transitionCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCloudTransportV1,
  type CommunityPluginLifecycleControlMutationCheckpointV1,
  type CommunityPluginLifecycleControlMutationCheckpointWriterV1,
} from "./community-plugin-lifecycle-cloud-v1";
import {
  communityPluginParticipantKeyV1,
  type CommunityPluginLifecycleControlV1,
} from "./community-plugin-lifecycle-v1";
import { sameSyncScope } from "./types";

export interface CommunityPluginGenerationCleanupObjectMetadataV1 {
  id: string;
  name: string;
  parentId: string;
  size: number;
  eTag: string;
  cTag: string;
}

export interface CommunityPluginGenerationCleanupCloudTransportV1 {
  readById(id: string): Promise<CommunityPluginGenerationCleanupObjectMetadataV1 | null>;
  deleteById(id: string, eTag: string): Promise<void>;
}

export interface CommunityPluginGenerationCleanupCheckpointV1 {
  schemaVersion: 2;
  kind: "community-plugin-generation-cleanup-checkpoint";
  snapshotDigest: string;
  pluginId: string;
  generation: number;
  snapshot: CommunityPluginGenerationCleanupSnapshotV1;
  startedAt: number;
  objectConfirmations: CommunityPluginGenerationCleanupObjectConfirmationV1[];
}

export type CommunityPluginGenerationCleanupCheckpointPreparationResultV1 =
  | {
    status: "ready";
    checkpoint: CommunityPluginGenerationCleanupCheckpointV1;
  }
  | {
    status: "retry";
    reason: "checkpoint-read-failed" | "checkpoint-persist-failed";
  }
  | {
    status: "blocked";
    reason: "snapshot-stale" | "checkpoint-invalid" | "checkpoint-conflict";
  };

export interface CommunityPluginGenerationCleanupCheckpointStoreV1 {
  load(): Promise<unknown | null>;
  persist(
    checkpoint: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
  ): Promise<void>;
  clear(
    checkpoint: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
  ): Promise<void>;
}

export interface CommunityPluginLifecycleControlMutationCheckpointStoreV1
  extends CommunityPluginLifecycleControlMutationCheckpointWriterV1 {
  load(): Promise<unknown | null>;
  clear(
    checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
  ): Promise<void>;
}

export type CommunityPluginGenerationCleanupExecutionResultV1 =
  | {
    status: "ready";
    checkpoint: CommunityPluginGenerationCleanupCheckpointV1;
    receipt: CommunityPluginGenerationCleanupReceiptV1;
  }
  | {
    status: "retry";
    reason:
      | "checkpoint-read-failed"
      | "checkpoint-persist-failed"
      | "object-read-unavailable"
      | "object-delete-outcome-unknown";
  }
  | {
    status: "blocked";
    reason:
      | "snapshot-stale"
      | "checkpoint-invalid"
      | "checkpoint-conflict"
      | "object-changed"
      | "cleanup-invalidated";
  };

export type CommunityPluginGenerationCleanupFinalizationResultV1 =
  | {
    status: "ready";
    source: "updated" | "existing" | "recovered";
    state: CommunityPluginLifecycleControlV1;
    recordId: string;
    recordETag: string;
    receipt: CommunityPluginGenerationCleanupReceiptV1;
  }
  | {
    status: "retry";
    reason:
      | "cleanup-checkpoint-read-failed"
      | "lifecycle-read-failed"
      | "control-checkpoint-read-failed"
      | "control-checkpoint-persist-failed"
      | "control-write-outcome-unknown"
      | "control-state-changed"
      | "control-checkpoint-clear-failed"
      | "cleanup-checkpoint-clear-failed";
  }
  | {
    status: "blocked";
    reason:
      | "invalid-input"
      | "cleanup-checkpoint-invalid"
      | "cleanup-checkpoint-incomplete"
      | "lifecycle-record-changed"
      | "lifecycle-scope-mismatch"
      | "lifecycle-state-invalid"
      | "lifecycle-checkpoint-invalid"
      | "lifecycle-checkpoint-conflict"
      | "closed-tombstone-mismatch"
      | "snapshot-stale"
      | "lifecycle-transition-blocked";
    detail?: string;
  };

class CommunityPluginGenerationCleanupInvalidatedError extends Error {
  constructor() {
    super("Community-plugin generation cleanup was invalidated");
    this.name = "CommunityPluginGenerationCleanupInvalidatedError";
  }
}

/**
 * Use the existing Graph ID + If-Match primitives. The factory is not wired to
 * a sync entry; callers still need the lifecycle and operation-epoch grants.
 */
export function createOneDriveCommunityPluginGenerationCleanupTransportV1(
  client: OneDriveClient,
  canMutate: () => boolean = () => true,
): CommunityPluginGenerationCleanupCloudTransportV1 {
  return {
    readById: async (id) => {
      const item = await client.getDriveItemMetadataById(id, "other");
      return item ? readObjectMetadata(item, id) : null;
    },
    deleteById: async (id, eTag) => {
      if (!canMutate()) throw new CommunityPluginGenerationCleanupInvalidatedError();
      await client.deleteItem("", "", eTag, id);
    },
  };
}

/**
 * Persist the immutable closing snapshot before the first object deletion.
 * The V2 checkpoint is bundle-only and rejects the former enablement-coupled
 * V1 schema.
 */
export async function prepareCommunityPluginGenerationCleanupCheckpointV1(
  input: Readonly<{
    snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>;
    currentControl: Readonly<CommunityPluginLifecycleControlV1>;
    currentControlRecordId: string;
    checkpointStore: CommunityPluginGenerationCleanupCheckpointStoreV1;
    preparedAt: number;
  }>,
): Promise<CommunityPluginGenerationCleanupCheckpointPreparationResultV1> {
  if (
    !Number.isFinite(input.preparedAt)
    || input.preparedAt < 0
    || (await validateCommunityPluginGenerationCleanupSnapshotV1(
      input.snapshot,
      input.currentControl,
      input.currentControlRecordId,
    )).status !== "valid"
  ) return { status: "blocked", reason: "snapshot-stale" };

  let stored: unknown | null;
  try {
    stored = await input.checkpointStore.load();
  } catch {
    return { status: "retry", reason: "checkpoint-read-failed" };
  }
  if (stored !== null && stored !== undefined) {
    if (!isCommunityPluginGenerationCleanupCheckpointV1(stored)) {
      return { status: "blocked", reason: "checkpoint-invalid" };
    }
    if (!checkpointSnapshotMatches(stored, input.snapshot)) {
      return { status: "blocked", reason: "checkpoint-conflict" };
    }
    return { status: "ready", checkpoint: cloneCheckpoint(stored) };
  }

  const checkpoint: CommunityPluginGenerationCleanupCheckpointV1 = {
    schemaVersion: 2,
    kind: "community-plugin-generation-cleanup-checkpoint",
    snapshotDigest: input.snapshot.snapshotDigest,
    pluginId: input.snapshot.pluginId,
    generation: input.snapshot.generation,
    snapshot: structuredClone(input.snapshot),
    startedAt: input.preparedAt,
    objectConfirmations: [],
  };
  if (!await persistExact(input.checkpointStore, checkpoint)) {
    return { status: "retry", reason: "checkpoint-persist-failed" };
  }
  return { status: "ready", checkpoint: cloneCheckpoint(checkpoint) };
}

/**
 * Delete only the immutable objects frozen by one closing snapshot. Progress
 * is persisted before the first DELETE and after every confirmed absence.
 * The manifest remains last because the snapshot already orders it last.
 */
export async function executeCommunityPluginGenerationCleanupV1(
  input: Readonly<{
    snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>;
    currentControl: Readonly<CommunityPluginLifecycleControlV1>;
    currentControlRecordId: string;
    transport: CommunityPluginGenerationCleanupCloudTransportV1;
    checkpointStore: CommunityPluginGenerationCleanupCheckpointStoreV1;
    confirmedAt: number;
  }>,
): Promise<CommunityPluginGenerationCleanupExecutionResultV1> {
  if (
    !Number.isFinite(input.confirmedAt)
    || input.confirmedAt < 0
    || (await validateCommunityPluginGenerationCleanupSnapshotV1(
      input.snapshot,
      input.currentControl,
      input.currentControlRecordId,
    )).status !== "valid"
  ) return { status: "blocked", reason: "snapshot-stale" };
  let stored: unknown | null;
  try {
    stored = await input.checkpointStore.load();
  } catch {
    return { status: "retry", reason: "checkpoint-read-failed" };
  }
  let checkpoint: CommunityPluginGenerationCleanupCheckpointV1;
  if (stored === null || stored === undefined) {
    checkpoint = {
      schemaVersion: 2,
      kind: "community-plugin-generation-cleanup-checkpoint",
      snapshotDigest: input.snapshot.snapshotDigest,
      pluginId: input.snapshot.pluginId,
      generation: input.snapshot.generation,
      snapshot: structuredClone(input.snapshot),
      startedAt: input.confirmedAt,
      objectConfirmations: [],
    };
    if (!await persistExact(input.checkpointStore, checkpoint)) {
      return { status: "retry", reason: "checkpoint-persist-failed" };
    }
  } else {
    if (!isCommunityPluginGenerationCleanupCheckpointV1(stored)) {
      return { status: "blocked", reason: "checkpoint-invalid" };
    }
    try {
      if (!checkpointSnapshotMatches(stored, input.snapshot)) {
        return { status: "blocked", reason: "checkpoint-conflict" };
      }
      if (input.confirmedAt < stored.startedAt) {
        return { status: "blocked", reason: "checkpoint-invalid" };
      }
      if (!checkpointMatches(stored, input.snapshot)) {
        return { status: "blocked", reason: "checkpoint-conflict" };
      }
      checkpoint = cloneCheckpoint(stored);
      if (
        (await validateCommunityPluginGenerationCleanupSnapshotV1(
          checkpoint.snapshot,
          input.currentControl,
          input.currentControlRecordId,
        )).status !== "valid"
      ) return { status: "blocked", reason: "checkpoint-invalid" };
    } catch {
      return { status: "blocked", reason: "checkpoint-invalid" };
    }
  }
  const lastConfirmation = checkpoint.objectConfirmations[
    checkpoint.objectConfirmations.length - 1
  ];
  if (
    input.confirmedAt < checkpoint.startedAt
    || (lastConfirmation && input.confirmedAt < lastConfirmation.confirmedAt)
  ) return { status: "blocked", reason: "checkpoint-invalid" };

  for (
    let index = checkpoint.objectConfirmations.length;
    index < input.snapshot.objects.length;
    index += 1
  ) {
    const target = input.snapshot.objects[index]!;
    let before: CommunityPluginGenerationCleanupObjectMetadataV1 | null;
    try {
      before = await input.transport.readById(target.remoteId);
    } catch {
      return { status: "retry", reason: "object-read-unavailable" };
    }
    let outcome: CommunityPluginGenerationCleanupObjectConfirmationV1["outcome"];
    if (!before) {
      outcome = "already-absent";
    } else {
      if (!sameObjectMetadata(before, target)) {
        return { status: "blocked", reason: "object-changed" };
      }
      let deleteResolved = false;
      try {
        await input.transport.deleteById(target.remoteId, target.eTag);
        deleteResolved = true;
      } catch (error) {
        if (error instanceof CommunityPluginGenerationCleanupInvalidatedError) {
          return { status: "blocked", reason: "cleanup-invalidated" };
        }
      }
      let after: CommunityPluginGenerationCleanupObjectMetadataV1 | null;
      try {
        after = await input.transport.readById(target.remoteId);
      } catch {
        return { status: "retry", reason: "object-read-unavailable" };
      }
      if (after) {
        if (!sameObjectMetadata(after, target)) {
          return { status: "blocked", reason: "object-changed" };
        }
        return { status: "retry", reason: "object-delete-outcome-unknown" };
      }
      outcome = deleteResolved ? "deleted" : "already-absent";
    }
    checkpoint = {
      ...checkpoint,
      objectConfirmations: [
        ...checkpoint.objectConfirmations,
        { remoteId: target.remoteId, outcome, confirmedAt: input.confirmedAt },
      ],
    };
    if (!await persistExact(input.checkpointStore, checkpoint)) {
      return { status: "retry", reason: "checkpoint-persist-failed" };
    }
  }

  const receipt = await createCommunityPluginGenerationCleanupReceiptV1({
    snapshot: input.snapshot,
    objectConfirmations: checkpoint.objectConfirmations,
  });
  return receipt
    ? { status: "ready", checkpoint: cloneCheckpoint(checkpoint), receipt }
    : { status: "blocked", reason: "checkpoint-invalid" };
}

/**
 * Close the same lifecycle generation only after the durable cleanup
 * checkpoint proves every frozen object absent. The lifecycle CAS keeps using
 * the existing control writer; local evidence is cleared only after an exact
 * closed tombstone is read back from that record.
 */
export async function finalizeCommunityPluginGenerationCleanupV1(
  input: Readonly<{
    lifecycleTransport: CommunityPluginLifecycleCloudTransportV1;
    cleanupCheckpointStore: CommunityPluginGenerationCleanupCheckpointStoreV1;
    controlCheckpointStore:
      CommunityPluginLifecycleControlMutationCheckpointStoreV1;
    operationId: string;
    closedAt: number;
  }>,
): Promise<CommunityPluginGenerationCleanupFinalizationResultV1> {
  if (
    typeof input.operationId !== "string"
    || input.operationId.length === 0
    || !Number.isFinite(input.closedAt)
    || input.closedAt < 0
  ) return { status: "blocked", reason: "invalid-input" };

  let storedCleanup: unknown | null;
  try {
    storedCleanup = await input.cleanupCheckpointStore.load();
  } catch {
    return { status: "retry", reason: "cleanup-checkpoint-read-failed" };
  }
  if (!isCommunityPluginGenerationCleanupCheckpointV1(storedCleanup)) {
    return {
      status: "blocked",
      reason: storedCleanup === null || storedCleanup === undefined
        ? "cleanup-checkpoint-incomplete"
        : "cleanup-checkpoint-invalid",
    };
  }
  const cleanupCheckpoint = cloneCheckpoint(storedCleanup);
  let receipt: CommunityPluginGenerationCleanupReceiptV1 | null;
  try {
    receipt = await createCommunityPluginGenerationCleanupReceiptV1({
      snapshot: cleanupCheckpoint.snapshot,
      objectConfirmations: cleanupCheckpoint.objectConfirmations,
    });
  } catch {
    return { status: "blocked", reason: "cleanup-checkpoint-invalid" };
  }
  if (!receipt) {
    return { status: "blocked", reason: "cleanup-checkpoint-incomplete" };
  }
  if (input.closedAt < receipt.completedAt) {
    return { status: "blocked", reason: "invalid-input" };
  }

  const current = await readCommunityPluginLifecycleControlV1(
    input.lifecycleTransport,
    cleanupCheckpoint.snapshot.scope,
    cleanupCheckpoint.snapshot.controlRecordId,
  );
  if (current.status !== "ready") return mapLifecycleReadFailure(current);

  let pendingControl: unknown | null;
  try {
    pendingControl = await input.controlCheckpointStore.load();
  } catch {
    return { status: "retry", reason: "control-checkpoint-read-failed" };
  }
  if (
    pendingControl !== null
    && pendingControl !== undefined
    && !isCommunityPluginLifecycleControlMutationCheckpointV1(pendingControl)
  ) return { status: "blocked", reason: "lifecycle-checkpoint-invalid" };
  if (
    isCommunityPluginLifecycleControlMutationCheckpointV1(pendingControl)
    && !completionCheckpointMatches(
      pendingControl,
      cleanupCheckpoint.snapshot,
      receipt,
    )
  ) return { status: "blocked", reason: "lifecycle-checkpoint-conflict" };

  if (current.state.pluginsById[cleanupCheckpoint.pluginId]
    ?.currentGeneration?.phase === "closed") {
    if (!closedTombstoneMatches(current.state, cleanupCheckpoint.snapshot, receipt)) {
      return { status: "blocked", reason: "closed-tombstone-mismatch" };
    }
    return clearFinalizationCheckpoints(
      input,
      cleanupCheckpoint,
      receipt,
      current,
      isCommunityPluginLifecycleControlMutationCheckpointV1(pendingControl)
        ? "recovered"
        : "existing",
    );
  }

  if (
    (await validateCommunityPluginGenerationCleanupSnapshotV1(
      cleanupCheckpoint.snapshot,
      current.state,
      current.recordId,
    )).status !== "valid"
  ) return { status: "blocked", reason: "snapshot-stale" };

  const pendingCompletion = isCommunityPluginLifecycleControlMutationCheckpointV1(
    pendingControl,
  ) && pendingControl.command.type === "complete-close"
    ? pendingControl as CommunityPluginLifecycleControlMutationCheckpointV1 & {
      command: Extract<
        CommunityPluginLifecycleControlMutationCheckpointV1["command"],
        { type: "complete-close" }
      >;
    }
    : null;
  const command = pendingCompletion
    ? pendingCompletion.command
    : {
      type: "complete-close" as const,
      scope: { ...cleanupCheckpoint.snapshot.scope },
      actor: { ...cleanupCheckpoint.snapshot.owner },
      pluginId: cleanupCheckpoint.snapshot.pluginId,
      generation: cleanupCheckpoint.snapshot.generation,
      cleanupReceiptDigest: receipt.receiptDigest,
      operationId: input.operationId,
      expectedRevision: current.state.revision,
      at: input.closedAt,
    };
  const transitioned = await transitionCommunityPluginLifecycleV1(
    input.lifecycleTransport,
    command,
    pendingCompletion,
    input.controlCheckpointStore,
  );
  if (transitioned.status === "uncertain") {
    return { status: "retry", reason: "control-write-outcome-unknown" };
  }
  if (transitioned.status === "blocked") {
    if (
      transitioned.reason === "revision-mismatch"
      || transitioned.reason === "write-race"
    ) {
      const cleared = await clearStaleControlCheckpoint(
        input.controlCheckpointStore,
        cleanupCheckpoint.snapshot,
        receipt,
      );
      return cleared === "cleared"
        ? { status: "retry", reason: "control-state-changed" }
        : cleared === "failed"
        ? { status: "retry", reason: "control-checkpoint-clear-failed" }
        : { status: "blocked", reason: "lifecycle-checkpoint-conflict" };
    }
    if (transitioned.reason === "checkpoint-persist-failed") {
      return { status: "retry", reason: "control-checkpoint-persist-failed" };
    }
    if (transitioned.reason === "read-failed") {
      return { status: "retry", reason: "lifecycle-read-failed" };
    }
    return {
      status: "blocked",
      reason: "lifecycle-transition-blocked",
      detail: transitioned.reason,
    };
  }

  const verified = await readCommunityPluginLifecycleControlV1(
    input.lifecycleTransport,
    cleanupCheckpoint.snapshot.scope,
    transitioned.recordId,
  );
  if (verified.status !== "ready") return mapLifecycleReadFailure(verified);
  if (!closedTombstoneMatches(verified.state, cleanupCheckpoint.snapshot, receipt)) {
    return { status: "blocked", reason: "closed-tombstone-mismatch" };
  }
  return clearFinalizationCheckpoints(
    input,
    cleanupCheckpoint,
    receipt,
    verified,
    transitioned.source,
  );
}

export function isCommunityPluginGenerationCleanupCheckpointV1(
  value: unknown,
): value is CommunityPluginGenerationCleanupCheckpointV1 {
  return isRecord(value)
    && value.schemaVersion === 2
    && value.kind === "community-plugin-generation-cleanup-checkpoint"
    && typeof value.snapshotDigest === "string"
    && /^[a-f0-9]{64}$/.test(value.snapshotDigest)
    && typeof value.pluginId === "string"
    && value.pluginId.length > 0
    && Number.isSafeInteger(value.generation)
    && Number(value.generation) > 0
    && isRecord(value.snapshot)
    && value.snapshot.snapshotDigest === value.snapshotDigest
    && value.snapshot.pluginId === value.pluginId
    && value.snapshot.generation === value.generation
    && value.snapshot.schemaVersion === 2
    && typeof value.snapshot.controlRecordId === "string"
    && isRecord(value.snapshot.scope)
    && isRecord(value.snapshot.owner)
    && typeof value.snapshot.owner.participantId === "string"
    && typeof value.snapshot.owner.incarnation === "string"
    && Number.isSafeInteger(value.snapshot.closingStartedRevision)
    && Number.isSafeInteger(value.snapshot.closingFenceEpoch)
    && Array.isArray(value.snapshot.memberKeys)
    && value.snapshot.memberKeys.every((item) => typeof item === "string")
    && isRecord(value.snapshot.publishedBundle)
    && Array.isArray(value.snapshot.objects)
    && Array.isArray(value.objectConfirmations)
    && Number.isFinite(value.startedAt)
    && Number(value.startedAt) >= 0
    && value.objectConfirmations.every((item) =>
      isRecord(item)
      && typeof item.remoteId === "string"
      && item.remoteId.length > 0
      && (item.outcome === "deleted" || item.outcome === "already-absent")
      && Number.isFinite(item.confirmedAt)
      && Number(item.confirmedAt) >= 0
    );
}

function checkpointMatches(
  checkpoint: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
  snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>,
): boolean {
  return checkpoint.snapshotDigest === snapshot.snapshotDigest
    && checkpoint.pluginId === snapshot.pluginId
    && checkpoint.generation === snapshot.generation
    && checkpoint.snapshot.snapshotDigest === snapshot.snapshotDigest
    && checkpoint.objectConfirmations.length <= snapshot.objects.length
    && checkpoint.objectConfirmations.every((confirmation, index) =>
      confirmation.remoteId === snapshot.objects[index]?.remoteId
      && confirmation.confirmedAt >= checkpoint.startedAt
      && (
        index === 0
        || confirmation.confirmedAt
          >= checkpoint.objectConfirmations[index - 1]!.confirmedAt
      )
    );
}

function checkpointSnapshotMatches(
  checkpoint: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
  snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>,
): boolean {
  return checkpoint.snapshotDigest === snapshot.snapshotDigest
    && checkpoint.pluginId === snapshot.pluginId
    && checkpoint.generation === snapshot.generation
    && checkpoint.snapshot.snapshotDigest === snapshot.snapshotDigest
    && JSON.stringify(checkpoint.snapshot) === JSON.stringify(snapshot);
}

function completionCheckpointMatches(
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
  snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>,
  receipt: Readonly<CommunityPluginGenerationCleanupReceiptV1>,
): boolean {
  const command = checkpoint.command;
  return checkpoint.recordId === snapshot.controlRecordId
    && command.type === "complete-close"
    && sameSyncScope(command.scope, snapshot.scope)
    && command.actor.participantId === snapshot.owner.participantId
    && command.actor.incarnation === snapshot.owner.incarnation
    && command.pluginId === snapshot.pluginId
    && command.generation === snapshot.generation
    && command.cleanupReceiptDigest === receipt.receiptDigest
    && command.at >= receipt.completedAt;
}

function closedTombstoneMatches(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>,
  receipt: Readonly<CommunityPluginGenerationCleanupReceiptV1>,
): boolean {
  if (!sameSyncScope(state.scope, snapshot.scope)) return false;
  const lifecycle = state.pluginsById[snapshot.pluginId];
  const generation = lifecycle?.currentGeneration;
  const closed = generation?.closed;
  const tombstone = lifecycle?.closedTombstones.find(
    (item) => item.generation === snapshot.generation,
  );
  return generation?.generation === snapshot.generation
    && generation.phase === "closed"
    && closed !== undefined
    && closed.owner.participantId === snapshot.owner.participantId
    && closed.owner.incarnation === snapshot.owner.incarnation
    && closed.startedRevision === snapshot.closingStartedRevision
    && closed.fenceEpoch === snapshot.closingFenceEpoch
    && JSON.stringify(closed.memberKeys) === JSON.stringify(snapshot.memberKeys)
    && closed.closedAt >= receipt.completedAt
    && closed.cleanupReceiptDigest === receipt.receiptDigest
    && tombstone?.closedAt === closed.closedAt
    && tombstone.fenceEpoch === closed.fenceEpoch
    && tombstone.cleanupReceiptDigest === receipt.receiptDigest
    && state.participantsByKey[
      communityPluginParticipantKeyV1(snapshot.owner)
    ]?.retiredAt === undefined;
}

function mapLifecycleReadFailure(
  result: Exclude<
    Awaited<ReturnType<typeof readCommunityPluginLifecycleControlV1>>,
    { status: "ready" }
  >,
): CommunityPluginGenerationCleanupFinalizationResultV1 {
  if (result.status === "missing" || result.reason === "record-changed") {
    return { status: "blocked", reason: "lifecycle-record-changed" };
  }
  if (result.reason === "read-failed") {
    return { status: "retry", reason: "lifecycle-read-failed" };
  }
  if (result.reason === "scope-mismatch") {
    return { status: "blocked", reason: "lifecycle-scope-mismatch" };
  }
  return { status: "blocked", reason: "lifecycle-state-invalid" };
}

async function clearStaleControlCheckpoint(
  store: CommunityPluginLifecycleControlMutationCheckpointStoreV1,
  snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>,
  receipt: Readonly<CommunityPluginGenerationCleanupReceiptV1>,
): Promise<"cleared" | "conflict" | "failed"> {
  let value: unknown | null;
  try {
    value = await store.load();
  } catch {
    return "failed";
  }
  if (value === null || value === undefined) return "cleared";
  if (
    !isCommunityPluginLifecycleControlMutationCheckpointV1(value)
    || !completionCheckpointMatches(value, snapshot, receipt)
  ) return "conflict";
  try {
    await store.clear(value);
    return "cleared";
  } catch {
    return "failed";
  }
}

async function clearFinalizationCheckpoints(
  input: Readonly<{
    cleanupCheckpointStore: CommunityPluginGenerationCleanupCheckpointStoreV1;
    controlCheckpointStore:
      CommunityPluginLifecycleControlMutationCheckpointStoreV1;
  }>,
  cleanupCheckpoint: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
  receipt: Readonly<CommunityPluginGenerationCleanupReceiptV1>,
  lifecycle: Extract<
    Awaited<ReturnType<typeof readCommunityPluginLifecycleControlV1>>,
    { status: "ready" }
  >,
  source: "updated" | "existing" | "recovered",
): Promise<CommunityPluginGenerationCleanupFinalizationResultV1> {
  let control: unknown | null;
  try {
    control = await input.controlCheckpointStore.load();
  } catch {
    return { status: "retry", reason: "control-checkpoint-read-failed" };
  }
  if (control !== null && control !== undefined) {
    if (!isCommunityPluginLifecycleControlMutationCheckpointV1(control)) {
      return { status: "blocked", reason: "lifecycle-checkpoint-invalid" };
    }
    if (!completionCheckpointMatches(control, cleanupCheckpoint.snapshot, receipt)) {
      return { status: "blocked", reason: "lifecycle-checkpoint-conflict" };
    }
    try {
      await input.controlCheckpointStore.clear(control);
    } catch {
      return { status: "retry", reason: "control-checkpoint-clear-failed" };
    }
  }
  try {
    await input.cleanupCheckpointStore.clear(cleanupCheckpoint);
  } catch {
    return { status: "retry", reason: "cleanup-checkpoint-clear-failed" };
  }
  return {
    status: "ready",
    source,
    state: structuredClone(lifecycle.state),
    recordId: lifecycle.recordId,
    recordETag: lifecycle.recordETag,
    receipt: structuredClone(receipt),
  };
}

async function persistExact(
  store: CommunityPluginGenerationCleanupCheckpointStoreV1,
  checkpoint: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
): Promise<boolean> {
  try {
    await store.persist(cloneCheckpoint(checkpoint));
    const stored = await store.load();
    return isCommunityPluginGenerationCleanupCheckpointV1(stored)
      && sameCheckpoint(stored, checkpoint);
  } catch {
    return false;
  }
}

function readObjectMetadata(
  item: Readonly<DriveItem>,
  expectedId: string,
): CommunityPluginGenerationCleanupObjectMetadataV1 {
  if (
    item.id !== expectedId
    || !item.file
    || !item.name
    || !item.parentReference?.id
    || !Number.isSafeInteger(item.size)
    || Number(item.size) < 0
    || !item.eTag
    || !item.cTag
  ) throw new Error("Immutable generation cleanup metadata is incomplete");
  return {
    id: item.id,
    name: item.name,
    parentId: item.parentReference.id,
    size: Number(item.size),
    eTag: item.eTag,
    cTag: item.cTag,
  };
}

function sameObjectMetadata(
  current: Readonly<CommunityPluginGenerationCleanupObjectMetadataV1>,
  target: Readonly<CommunityPluginGenerationCleanupObjectTargetV1>,
): boolean {
  const pathSegments = target.objectPath.split("/");
  const expectedName = pathSegments[pathSegments.length - 1];
  return current.id === target.remoteId
    && current.name === expectedName
    && current.parentId === target.parentId
    && current.size === target.size
    && current.eTag === target.eTag
    && current.cTag === target.cTag;
}

function cloneCheckpoint(
  checkpoint: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
): CommunityPluginGenerationCleanupCheckpointV1 {
  return structuredClone(checkpoint) as CommunityPluginGenerationCleanupCheckpointV1;
}

function sameCheckpoint(
  left: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
  right: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
