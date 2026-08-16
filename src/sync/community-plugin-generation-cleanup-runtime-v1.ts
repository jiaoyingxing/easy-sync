import { sha256Hex } from "../crypto";
import {
  createCommunityPluginGenerationCleanupSnapshotV1,
  type CommunityPluginGenerationCleanupSnapshotV1,
} from "./community-plugin-generation-cleanup-v1";
import {
  executeCommunityPluginGenerationCleanupV1,
  finalizeCommunityPluginGenerationCleanupV1,
  isCommunityPluginGenerationCleanupCheckpointV1,
  prepareCommunityPluginGenerationCleanupCheckpointV1,
  type CommunityPluginGenerationCleanupCheckpointV1,
  type CommunityPluginGenerationCleanupCheckpointStoreV1,
  type CommunityPluginGenerationCleanupCloudTransportV1,
  type CommunityPluginLifecycleControlMutationCheckpointStoreV1,
} from "./community-plugin-generation-cleanup-cloud-v1";
import type { CommunityPluginGenerationContentCloudTransportV1 } from
  "./community-plugin-generation-content-cloud-v1";
import {
  communityPluginGenerationNamespaceRootV1,
  readCommunityPluginGenerationBundleManifestV1,
  type CommunityPluginGenerationContentGrantV1,
} from "./community-plugin-generation-content-v1";
import {
  readCommunityPluginLifecycleControlV1,
  type CommunityPluginLifecycleCloudTransportV1,
} from "./community-plugin-lifecycle-cloud-v1";
import {
  CommunityPluginLifecycleDeviceObserverV1,
} from "./community-plugin-lifecycle-device-v1";
import {
  communityPluginAuthoritativePublishedBundleV1,
  communityPluginCloseEligibilityV1,
  communityPluginParticipantKeyV1,
  type CommunityPluginGenerationV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginPublishedManifestObjectV1,
} from "./community-plugin-lifecycle-v1";
import type { DeviceCommunityPluginParticipationV1 } from
  "./community-plugin-participation";
import { createIndexedDbVaultInstanceId } from "./indexeddb-vault-namespace";
import { sameSyncScope, type SyncScope } from "./types";

class CommunityPluginCleanupEvidenceChangedError extends Error {}

export type CommunityPluginGenerationCleanupCoordinationResultV1 =
  | { status: "idle"; exitedPluginIds: string[] }
  | {
    status: "cleanup-ready";
    snapshot: CommunityPluginGenerationCleanupSnapshotV1;
    exitedPluginIds: string[];
  }
  | {
    status: "retry" | "blocked";
    phase: "checkpoint" | "control" | "snapshot";
    reason: string;
    exitedPluginIds: string[];
  };

export type CommunityPluginGenerationCleanupCompletionResultV1 =
  | { status: "idle" }
  | { status: "completed"; pluginId: string; generation: number }
  | {
    status: "retry" | "blocked";
    phase: "checkpoint" | "cleanup" | "finalize";
    reason: string;
  };

export type CommunityPluginGenerationCleanupPendingResultV1 =
  | { status: "idle" }
  | {
    status: "cleanup-ready";
    checkpoint: CommunityPluginGenerationCleanupCheckpointV1;
  }
  | { status: "retry" | "blocked"; reason: string };

/** Read one exact local cleanup transaction without starting any mutation. */
export async function readCommunityPluginGenerationCleanupPendingV1(
  checkpointStore: CommunityPluginGenerationCleanupCheckpointStoreV1,
  scope: Readonly<SyncScope>,
): Promise<CommunityPluginGenerationCleanupPendingResultV1> {
  let stored: unknown | null;
  try {
    stored = await checkpointStore.load();
  } catch {
    return { status: "retry", reason: "checkpoint-read-failed" };
  }
  if (stored === null || stored === undefined) return { status: "idle" };
  if (!isCommunityPluginGenerationCleanupCheckpointV1(stored)) {
    return { status: "blocked", reason: "checkpoint-invalid" };
  }
  if (!sameSyncScope(stored.snapshot.scope, scope)) {
    return { status: "blocked", reason: "checkpoint-scope-mismatch" };
  }
  return {
    status: "cleanup-ready",
    checkpoint: structuredClone(stored),
  };
}

/**
 * Reconcile explicit device exits and, for at most one generation, freeze the
 * evidence needed by the bundle-only cleanup transaction. This function
 * never reads or edits community-plugins.json and never deletes an object.
 */
export async function coordinateCommunityPluginGenerationClosingV1(
  input: Readonly<{
    observer: CommunityPluginLifecycleDeviceObserverV1;
    lifecycleTransport: CommunityPluginLifecycleCloudTransportV1;
    contentTransport: CommunityPluginGenerationContentCloudTransportV1;
    cleanupCheckpointStore: CommunityPluginGenerationCleanupCheckpointStoreV1;
    scope: Readonly<SyncScope>;
    participation: Readonly<DeviceCommunityPluginParticipationV1>;
    at: number;
    createOperationId?: () => string;
  }>,
): Promise<CommunityPluginGenerationCleanupCoordinationResultV1> {
  const exitedPluginIds: string[] = [];
  const pending = await readCommunityPluginGenerationCleanupPendingV1(
    input.cleanupCheckpointStore,
    input.scope,
  );
  if (pending.status !== "idle") {
    if ("reason" in pending) {
      return pending.status === "retry"
        ? retry("checkpoint", pending.reason, exitedPluginIds)
        : blocked("checkpoint", pending.reason, exitedPluginIds);
    }
    return {
      status: pending.status,
      snapshot: structuredClone(pending.checkpoint.snapshot),
      exitedPluginIds,
    };
  }

  const participant = input.observer.getParticipantIdentity();
  if (!participant) {
    return blocked("control", "local-identity-unavailable", exitedPluginIds);
  }
  const resumed = await input.observer.resumePendingLifecycleTransition(
    input.lifecycleTransport,
    input.scope,
  );
  if (resumed && resumed.status !== "ready") {
    return resumed.status === "uncertain"
      ? retry("control", "transition-outcome-unknown", exitedPluginIds)
      : blockOrRetryControl(resumed.reason, exitedPluginIds);
  }
  const read = await readCommunityPluginLifecycleControlV1(
    input.lifecycleTransport,
    input.scope,
  );
  if (read.status === "missing") return { status: "idle", exitedPluginIds };
  if (read.status === "blocked") {
    return read.reason === "read-failed"
      ? retry("control", read.reason, exitedPluginIds)
      : blocked("control", read.reason, exitedPluginIds);
  }
  let current = read;
  const participantKey = communityPluginParticipantKeyV1(participant);
  const operationId = input.createOperationId ?? createIndexedDbVaultInstanceId;

  for (const pluginId of Object.keys(current.state.pluginsById).sort(compareText)) {
    const generation = current.state.pluginsById[pluginId]?.currentGeneration;
    const member = generation?.membersByKey[participantKey];
    if (
      generation?.phase !== "open"
      || member?.phase !== "joined"
      || !deviceExplicitlyExited(input.participation, pluginId)
    ) continue;
    const transitioned = await input.observer.transitionLifecycle(
      input.lifecycleTransport,
      {
        type: "exit-plugin",
        scope: { ...input.scope },
        participant: { ...participant },
        pluginId,
        generation: generation.generation,
        operationId: operationId(),
        expectedRevision: current.state.revision,
        at: input.at,
      },
    );
    if (transitioned.status !== "ready") {
      return transitioned.status === "uncertain"
        ? retry("control", "exit-outcome-unknown", exitedPluginIds)
        : blockOrRetryControl(transitioned.reason, exitedPluginIds);
    }
    current = transitioned;
    exitedPluginIds.push(pluginId);
  }

  const existingClosing = findOwnedClosingGeneration(
    current.state,
    participantKey,
  );
  let closing = existingClosing;
  if (!closing) {
    const candidate = findEligibleGeneration(
      current.state,
      participantKey,
    );
    if (!candidate) return { status: "idle", exitedPluginIds };
    const transitioned = await input.observer.transitionLifecycle(
      input.lifecycleTransport,
      {
        type: "begin-close",
        scope: { ...input.scope },
        actor: { ...participant },
        pluginId: candidate.pluginId,
        generation: candidate.generation.generation,
        operationId: operationId(),
        expectedRevision: current.state.revision,
        at: input.at,
      },
    );
    if (transitioned.status !== "ready") {
      return transitioned.status === "uncertain"
        ? retry("control", "begin-close-outcome-unknown", exitedPluginIds)
        : blockOrRetryControl(transitioned.reason, exitedPluginIds);
    }
    current = transitioned;
    const generation = current.state.pluginsById[candidate.pluginId]
      ?.currentGeneration;
    if (generation?.phase !== "closing") {
      return blocked("control", "closing-readback-mismatch", exitedPluginIds);
    }
    closing = { pluginId: candidate.pluginId, generation };
  }

  try {
    const evidence = await readClosingBundleEvidence(
      input.contentTransport,
      current.state,
      closing.pluginId,
      closing.generation,
    );
    const snapshot = await createCommunityPluginGenerationCleanupSnapshotV1({
      control: current.state,
      controlRecordId: current.recordId,
      pluginId: closing.pluginId,
      manifestContent: evidence.bundleManifestContent,
    });
    if (snapshot.status !== "ready") {
      return blocked("snapshot", snapshot.reason, exitedPluginIds);
    }
    const prepared = await prepareCommunityPluginGenerationCleanupCheckpointV1({
      snapshot: snapshot.snapshot,
      currentControl: current.state,
      currentControlRecordId: current.recordId,
      checkpointStore: input.cleanupCheckpointStore,
      preparedAt: input.at,
    });
    if (prepared.status !== "ready") {
      return prepared.status === "retry"
        ? retry("checkpoint", prepared.reason, exitedPluginIds)
        : blocked("checkpoint", prepared.reason, exitedPluginIds);
    }
    return {
      status: "cleanup-ready",
      snapshot: structuredClone(prepared.checkpoint.snapshot),
      exitedPluginIds,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "snapshot-read-failed";
    return error instanceof CommunityPluginCleanupEvidenceChangedError
      ? blocked("snapshot", reason, exitedPluginIds)
      : retry("snapshot", reason, exitedPluginIds);
  }
}

/** Complete the bundle-only object cleanup and close transaction. */
export async function completeCommunityPluginGenerationCleanupV1(
  input: Readonly<{
    lifecycleTransport: CommunityPluginLifecycleCloudTransportV1;
    cleanupTransport: CommunityPluginGenerationCleanupCloudTransportV1;
    cleanupCheckpointStore: CommunityPluginGenerationCleanupCheckpointStoreV1;
    controlCheckpointStore: CommunityPluginLifecycleControlMutationCheckpointStoreV1;
    scope: Readonly<SyncScope>;
    at: number;
    operationId?: string;
  }>,
): Promise<CommunityPluginGenerationCleanupCompletionResultV1> {
  const pending = await readCommunityPluginGenerationCleanupPendingV1(
    input.cleanupCheckpointStore,
    input.scope,
  );
  if (pending.status === "idle") return { status: "idle" };
  if ("reason" in pending) {
    return { status: pending.status, phase: "checkpoint", reason: pending.reason };
  }
  const stored = pending.checkpoint;
  const control = await readCommunityPluginLifecycleControlV1(
    input.lifecycleTransport,
    input.scope,
    stored.snapshot.controlRecordId,
  );
  if (control.status !== "ready") {
    return control.status === "blocked" && control.reason === "read-failed"
      ? { status: "retry", phase: "cleanup", reason: control.reason }
      : {
        status: "blocked",
        phase: "cleanup",
        reason: control.status === "missing" ? "control-missing" : control.reason,
      };
  }
  const executed = await executeCommunityPluginGenerationCleanupV1({
    snapshot: stored.snapshot,
    currentControl: control.state,
    currentControlRecordId: control.recordId,
    transport: input.cleanupTransport,
    checkpointStore: input.cleanupCheckpointStore,
    confirmedAt: input.at,
  });
  if (executed.status !== "ready") {
    return {
      status: executed.status,
      phase: "cleanup",
      reason: executed.reason,
    };
  }
  const finalized = await finalizeCommunityPluginGenerationCleanupV1({
    lifecycleTransport: input.lifecycleTransport,
    cleanupCheckpointStore: input.cleanupCheckpointStore,
    controlCheckpointStore: input.controlCheckpointStore,
    operationId: input.operationId ?? createIndexedDbVaultInstanceId(),
    closedAt: input.at,
  });
  if (finalized.status !== "ready") {
    return {
      status: finalized.status,
      phase: "finalize",
      reason: finalized.reason,
    };
  }
  return {
    status: "completed",
    pluginId: stored.snapshot.pluginId,
    generation: stored.snapshot.generation,
  };
}

function deviceExplicitlyExited(
  participation: Readonly<DeviceCommunityPluginParticipationV1>,
  pluginId: string,
): boolean {
  if (!participation.scopeEnabled) return true;
  const phase = participation.pluginsById[pluginId]?.phase;
  return phase === "excluded" || phase === "exit-requested";
}

function findEligibleGeneration(
  control: Readonly<CommunityPluginLifecycleControlV1>,
  participantKey: string,
): { pluginId: string; generation: CommunityPluginGenerationV1 } | null {
  for (const pluginId of Object.keys(control.pluginsById).sort(compareText)) {
    const lifecycle = control.pluginsById[pluginId];
    const generation = lifecycle?.currentGeneration;
    if (
      generation?.phase === "open"
      && generation.membersByKey[participantKey]?.phase === "exited"
      && communityPluginAuthoritativePublishedBundleV1(lifecycle) !== null
      && communityPluginCloseEligibilityV1(
        control,
        pluginId,
        generation.generation,
      ).eligible
    ) return { pluginId, generation };
  }
  return null;
}

function findOwnedClosingGeneration(
  control: Readonly<CommunityPluginLifecycleControlV1>,
  participantKey: string,
): { pluginId: string; generation: CommunityPluginGenerationV1 } | null {
  for (const pluginId of Object.keys(control.pluginsById).sort(compareText)) {
    const generation = control.pluginsById[pluginId]?.currentGeneration;
    if (
      generation?.phase === "closing"
      && communityPluginParticipantKeyV1(generation.closing!.owner)
        === participantKey
    ) return { pluginId, generation };
  }
  return null;
}

async function readClosingBundleEvidence(
  transport: CommunityPluginGenerationContentCloudTransportV1,
  control: Readonly<CommunityPluginLifecycleControlV1>,
  pluginId: string,
  generation: Readonly<CommunityPluginGenerationV1>,
): Promise<{ bundleManifestContent: ArrayBuffer }> {
  if (generation.phase !== "closing" || !generation.closing || !generation.publishedBundle) {
    throw new Error("generation-not-closing");
  }
  const manifestObject = generation.publishedBundle.manifestObject;
  const bundleManifest = await readExactManifestObject(transport, manifestObject);
  const ownerKey = communityPluginParticipantKeyV1(generation.closing.owner);
  const ownerMember = generation.membersByKey[ownerKey];
  if (!ownerMember) throw new CommunityPluginCleanupEvidenceChangedError(
    "closing-owner-missing",
  );
  const grant: CommunityPluginGenerationContentGrantV1 = {
    schemaVersion: 1,
    capability: "stage-immutable-object",
    scope: { ...control.scope },
    participant: { ...generation.closing.owner },
    pluginId,
    generation: generation.generation,
    joinNonce: ownerMember.joinNonce,
    observedControlRevision: generation.closing.startedRevision,
    fenceEpoch: generation.closing.fenceEpoch,
    namespaceRoot: communityPluginGenerationNamespaceRootV1(
      pluginId,
      generation.generation,
    ),
  };
  const prepared = await readCommunityPluginGenerationBundleManifestV1(
    bundleManifest.content,
    grant,
    manifestObject.sha256Hash,
  );
  if (!prepared) throw new CommunityPluginCleanupEvidenceChangedError(
    "bundle-manifest-invalid",
  );
  return { bundleManifestContent: bundleManifest.content };
}

async function readExactManifestObject(
  transport: CommunityPluginGenerationContentCloudTransportV1,
  expected: Readonly<CommunityPluginPublishedManifestObjectV1>,
) {
  const object = await transport.readById(expected.remoteId, expected.size);
  const pathSegments = expected.objectPath.split("/");
  if (
    object.id !== expected.remoteId
    || object.name !== pathSegments[pathSegments.length - 1]
    || object.parentId !== expected.parentId
    || object.size !== expected.size
    || object.eTag !== expected.eTag
    || object.cTag !== expected.cTag
    || await sha256Hex(object.content) !== expected.sha256Hash
  ) throw new CommunityPluginCleanupEvidenceChangedError(
    "bundle-manifest-changed",
  );
  return object;
}

function blockOrRetryControl(
  reason: string,
  exitedPluginIds: string[],
): CommunityPluginGenerationCleanupCoordinationResultV1 {
  return reason === "revision-mismatch" || reason === "write-race"
    ? retry("control", reason, exitedPluginIds)
    : blocked("control", reason, exitedPluginIds);
}

function retry(
  phase: "checkpoint" | "control" | "snapshot",
  reason: string,
  exitedPluginIds: string[],
): CommunityPluginGenerationCleanupCoordinationResultV1 {
  return { status: "retry", phase, reason, exitedPluginIds };
}

function blocked(
  phase: "checkpoint" | "control" | "snapshot",
  reason: string,
  exitedPluginIds: string[],
): CommunityPluginGenerationCleanupCoordinationResultV1 {
  return { status: "blocked", phase, reason, exitedPluginIds };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
