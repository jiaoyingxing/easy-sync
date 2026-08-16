import type { OneDriveClient } from "../onedrive/client";
import { isRecord } from "../obsidian-compat";
import {
  communityPluginParticipantKeyV1,
  createCommunityPluginLifecycleControlV1,
  isCommunityPluginLifecycleCommandV1,
  isCommunityPluginLifecycleControlV1,
  isCommunityPluginParticipantIdentityV1,
  reduceCommunityPluginLifecycleV1,
  sameCommunityPluginLifecycleCommandV1,
  sameCommunityPluginPublishedBundleV1,
  type CommunityPluginLifecycleBlockReasonV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginParticipantIdentityV1,
  type CommunityPluginPublishedBundleV1,
} from "./community-plugin-lifecycle-v1";
import { isSyncScope, sameSyncScope, type SyncScope } from "./types";

export interface CommunityPluginLifecycleCloudObjectV1 {
  id: string;
  eTag: string;
  content: string;
}

export interface CommunityPluginLifecycleCloudTransportV1 {
  read(): Promise<CommunityPluginLifecycleCloudObjectV1 | null>;
  createOnly(content: string): Promise<{ id: string; eTag: string }>;
  updateCas(
    id: string,
    eTag: string,
    content: string,
  ): Promise<{ id: string; eTag: string }>;
  readById(id: string): Promise<CommunityPluginLifecycleCloudObjectV1>;
}

export type CommunityPluginLifecycleControlReadResultV1 =
  | {
    status: "ready";
    state: CommunityPluginLifecycleControlV1;
    recordId: string;
    recordETag: string;
  }
  | { status: "missing" }
  | {
    status: "blocked";
    reason: "read-failed" | "invalid-current" | "scope-mismatch" | "record-changed";
  };

export interface CommunityPluginParticipantObservationInputV1 {
  scope: SyncScope;
  participant: CommunityPluginParticipantIdentityV1;
  operationId: string;
  observedAt: number;
}

type ParticipantObservationCommandV1 = Extract<
  CommunityPluginLifecycleCommandV1,
  { type: "register-participant" | "observe-participant" }
>;

type PluginBundlePublicationCommandV1 = Extract<
  CommunityPluginLifecycleCommandV1,
  { type: "publish-plugin-bundle" }
>;

type LifecycleControlMutationCommandV1 = Extract<
  CommunityPluginLifecycleCommandV1,
  {
    type:
      | "join-plugin"
      | "confirm-legacy-migration"
      | "seal-plugin-legacy-authority"
      | "exit-plugin"
      | "retire-participant"
      | "begin-close"
      | "complete-close";
  }
>;

export type CommunityPluginLifecycleTransitionCommandV1 = Extract<
  LifecycleControlMutationCommandV1,
  { type: "exit-plugin" | "retire-participant" | "begin-close" | "complete-close" }
>;

export interface CommunityPluginGenerationJoinInputV1 {
  scope: SyncScope;
  participant: CommunityPluginParticipantIdentityV1;
  pluginId: string;
  targetGeneration: number;
  joinNonce: string;
  joinEvidence: "host-install" | "user-confirmed";
  observedClosedRevision?: number;
  operationId: string;
  joinedAt: number;
}

export interface CommunityPluginLegacyMigrationConfirmationInputV1 {
  scope: SyncScope;
  actor: CommunityPluginParticipantIdentityV1;
  operationId: string;
  confirmedAt: number;
  evidence: "user-confirmed-legacy-devices-upgraded-or-retired";
}

export interface CommunityPluginLegacyAuthoritySealInputV1 {
  scope: SyncScope;
  actor: CommunityPluginParticipantIdentityV1;
  pluginId: string;
  generation: number;
  publishedBundle: CommunityPluginPublishedBundleV1;
  operationId: string;
  sealedAt: number;
}

/**
 * Device-local recovery evidence for one response-unknown participant write.
 * Future runtime wiring must persist this before issuing another control write
 * for the same participant. S7 itself has no PluginData or IndexedDB I/O.
 */
export interface CommunityPluginLifecycleObservationCheckpointV1 {
  schemaVersion: 1;
  kind: "community-plugin-lifecycle-observation-checkpoint";
  command: ParticipantObservationCommandV1;
  recordId: string | null;
}

export interface CommunityPluginLifecycleObservationCheckpointWriterV1 {
  persist(
    checkpoint: Readonly<CommunityPluginLifecycleObservationCheckpointV1>,
  ): Promise<void>;
}

/**
 * Device-local recovery evidence for one response-unknown bundle selection.
 * The immutable objects already exist; this checkpoint covers only the CAS
 * that selects their verified manifest as the current generation bundle.
 */
export interface CommunityPluginBundlePublicationCheckpointV1 {
  schemaVersion: 1;
  kind: "community-plugin-bundle-publication-checkpoint";
  command: PluginBundlePublicationCommandV1;
  recordId: string;
}

export interface CommunityPluginBundlePublicationCheckpointWriterV1 {
  persist(
    checkpoint: Readonly<CommunityPluginBundlePublicationCheckpointV1>,
  ): Promise<void>;
}

/**
 * One device-local recovery record shared by explicit joins, consent, seals,
 * exits, retirement and closing transitions. It never stores plugin bytes or
 * creates another cloud authority; the lifecycle object remains the only
 * control state.
 */
export interface CommunityPluginLifecycleControlMutationCheckpointV1 {
  schemaVersion: 1;
  kind: "community-plugin-lifecycle-control-mutation-checkpoint";
  command: LifecycleControlMutationCommandV1;
  recordId: string;
}

export interface CommunityPluginLifecycleControlMutationCheckpointWriterV1 {
  persist(
    checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
  ): Promise<void>;
}

export type CommunityPluginLifecycleObservationResultV1 =
  | {
    status: "ready";
    source: "created" | "updated" | "existing" | "recovered";
    state: CommunityPluginLifecycleControlV1;
    recordId: string;
    recordETag: string;
  }
  | {
    status: "blocked";
    reason:
      | "invalid-input"
      | "invalid-checkpoint"
      | "checkpoint-persist-failed"
      | "pending-operation-required"
      | "read-failed"
      | "invalid-current"
      | "record-missing"
      | "write-race"
      | "readback-mismatch"
      | CommunityPluginLifecycleBlockReasonV1;
  }
  | {
    status: "uncertain";
    checkpoint: CommunityPluginLifecycleObservationCheckpointV1;
  };

export type CommunityPluginBundlePublicationResultV1 =
  | {
    status: "ready";
    source: "updated" | "existing" | "recovered";
    state: CommunityPluginLifecycleControlV1;
    recordId: string;
    recordETag: string;
  }
  | {
    status: "blocked";
    reason:
      | "invalid-command"
      | "invalid-checkpoint"
      | "checkpoint-persist-failed"
      | "pending-operation-required"
      | "read-failed"
      | "invalid-current"
      | "record-missing"
      | "write-race"
      | "readback-mismatch"
      | CommunityPluginLifecycleBlockReasonV1;
  }
  | {
    status: "uncertain";
    checkpoint: CommunityPluginBundlePublicationCheckpointV1;
  };

export type CommunityPluginLifecycleControlMutationResultV1 =
  | {
    status: "ready";
    source: "updated" | "existing" | "recovered";
    state: CommunityPluginLifecycleControlV1;
    recordId: string;
    recordETag: string;
  }
  | {
    status: "blocked";
    reason:
      | "invalid-input"
      | "invalid-checkpoint"
      | "checkpoint-persist-failed"
      | "pending-operation-required"
      | "read-failed"
      | "invalid-current"
      | "record-missing"
      | "write-race"
      | "readback-mismatch"
      | CommunityPluginLifecycleBlockReasonV1;
  }
  | {
    status: "uncertain";
    checkpoint: CommunityPluginLifecycleControlMutationCheckpointV1;
  };

type ExistingControlMutationCommandV1 =
  | PluginBundlePublicationCommandV1
  | LifecycleControlMutationCommandV1;

interface ExistingControlMutationCheckpointV1<
  Command extends ExistingControlMutationCommandV1 = ExistingControlMutationCommandV1,
> {
  command: Command;
  recordId: string;
}

type ExistingControlMutationResultV1<Checkpoint> =
  | {
    status: "ready";
    source: "updated" | "existing" | "recovered";
    state: CommunityPluginLifecycleControlV1;
    recordId: string;
    recordETag: string;
  }
  | {
    status: "blocked";
    reason:
      | "checkpoint-persist-failed"
      | "write-race"
      | "readback-mismatch"
      | CommunityPluginLifecycleBlockReasonV1;
  }
  | {
    status: "uncertain";
    checkpoint: Checkpoint;
  };

export function createOneDriveCommunityPluginLifecycleTransportV1(
  client: OneDriveClient,
  vaultName: string,
  canMutate: () => boolean = () => true,
): CommunityPluginLifecycleCloudTransportV1 {
  return {
    read: () => client.readCommunityPluginLifecycleV1(vaultName),
    createOnly: (content) => {
      if (!canMutate()) throw new Error("Lifecycle observation was invalidated");
      return client.createCommunityPluginLifecycleV1(vaultName, content);
    },
    updateCas: (id, eTag, content) => {
      if (!canMutate()) throw new Error("Lifecycle observation was invalidated");
      return client.updateCommunityPluginLifecycleV1(id, eTag, content);
    },
    readById: (id) => client.readCommunityPluginLifecycleV1ById(id),
  };
}

/** Strict read-only view used by generation planning and final revalidation. */
export async function readCommunityPluginLifecycleControlV1(
  transport: CommunityPluginLifecycleCloudTransportV1,
  scope: Readonly<SyncScope>,
  expectedRecordId?: string,
): Promise<CommunityPluginLifecycleControlReadResultV1> {
  let object: CommunityPluginLifecycleCloudObjectV1 | null;
  try {
    object = expectedRecordId
      ? await transport.readById(expectedRecordId)
      : await transport.read();
  } catch {
    return { status: "blocked", reason: "read-failed" };
  }
  if (!object) return expectedRecordId
    ? { status: "blocked", reason: "record-changed" }
    : { status: "missing" };
  if (expectedRecordId && object.id !== expectedRecordId) {
    return { status: "blocked", reason: "record-changed" };
  }
  const state = parseControl(object.content);
  if (!state) return { status: "blocked", reason: "invalid-current" };
  if (!sameSyncScope(state.scope, scope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  return {
    status: "ready",
    state,
    recordId: object.id,
    recordETag: object.eTag,
  };
}

export function isCommunityPluginLifecycleObservationCheckpointV1(
  value: unknown,
): value is CommunityPluginLifecycleObservationCheckpointV1 {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "community-plugin-lifecycle-observation-checkpoint"
    || !isParticipantObservationCommand(value.command)
  ) return false;
  return value.recordId === null
    || (typeof value.recordId === "string" && value.recordId.length > 0);
}

export function isCommunityPluginBundlePublicationCheckpointV1(
  value: unknown,
): value is CommunityPluginBundlePublicationCheckpointV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === "community-plugin-bundle-publication-checkpoint"
    && typeof value.recordId === "string"
    && value.recordId.length > 0
    && isPluginBundlePublicationCommand(value.command);
}

export function isCommunityPluginLifecycleControlMutationCheckpointV1(
  value: unknown,
): value is CommunityPluginLifecycleControlMutationCheckpointV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === "community-plugin-lifecycle-control-mutation-checkpoint"
    && typeof value.recordId === "string"
    && value.recordId.length > 0
    && isLifecycleControlMutationCommand(value.command);
}

/**
 * Register or observe one participant through a single create/CAS/read-back
 * transaction. It cannot join plugins, retire devices, close generations,
 * mutate plugin files or authorize cleanup.
 */
export async function publishCommunityPluginParticipantObservationV1(
  transport: CommunityPluginLifecycleCloudTransportV1,
  input: Readonly<CommunityPluginParticipantObservationInputV1>,
  pending: Readonly<CommunityPluginLifecycleObservationCheckpointV1> | null,
  checkpointWriter: CommunityPluginLifecycleObservationCheckpointWriterV1,
): Promise<CommunityPluginLifecycleObservationResultV1> {
  if (!isObservationInput(input)) return { status: "blocked", reason: "invalid-input" };
  if (pending && !isCommunityPluginLifecycleObservationCheckpointV1(pending)) {
    return { status: "blocked", reason: "invalid-checkpoint" };
  }
  if (pending && !checkpointMatchesInput(pending, input)) {
    return { status: "blocked", reason: "pending-operation-required" };
  }

  let object: CommunityPluginLifecycleCloudObjectV1 | null;
  try {
    object = pending?.recordId
      ? await transport.readById(pending.recordId)
      : await transport.read();
  } catch {
    if (pending) return { status: "uncertain", checkpoint: cloneCheckpoint(pending) };
    return { status: "blocked", reason: "read-failed" };
  }

  const current = object ? parseControl(object.content) : null;
  if (object && !current) return { status: "blocked", reason: "invalid-current" };
  const command = pending?.command ?? buildObservationCommand(current, input);
  if (!current && command.type !== "register-participant") {
    return { status: "blocked", reason: "record-missing" };
  }
  const base = current ?? createCommunityPluginLifecycleControlV1(input.scope);
  const reduced = reduceCommunityPluginLifecycleV1(base, command);
  if (reduced.status === "blocked") return { status: "blocked", reason: reduced.reason };
  if (reduced.status === "idempotent") {
    if (!object) return { status: "blocked", reason: "record-missing" };
    return ready(object, reduced.state, pending ? "recovered" : "existing");
  }

  const content = JSON.stringify(reduced.state);
  const writeCheckpoint = createCheckpoint(command, object?.id ?? null);
  try {
    await checkpointWriter.persist(writeCheckpoint);
  } catch {
    return { status: "blocked", reason: "checkpoint-persist-failed" };
  }
  let written: { id: string; eTag: string };
  try {
    written = object
      ? await transport.updateCas(object.id, object.eTag, content)
      : await transport.createOnly(content);
  } catch {
    return resolveAfterUnknownWrite(
      transport,
      command,
      object?.id ?? null,
    );
  }

  try {
    const verified = await transport.readById(written.id);
    return verifyAppliedObservation(verified, command, object ? "updated" : "created");
  } catch {
    return resolveAfterUnknownWrite(transport, command, written.id);
  }
}

/**
 * Select one externally uploaded and read-back-verified immutable bundle via
 * the lifecycle object's existing CAS. This function cannot create lifecycle
 * state, upload bytes, join a plugin, close a generation or delete content.
 */
export async function publishCommunityPluginBundleSelectionV1(
  transport: CommunityPluginLifecycleCloudTransportV1,
  command: Readonly<PluginBundlePublicationCommandV1>,
  pending: Readonly<CommunityPluginBundlePublicationCheckpointV1> | null,
  checkpointWriter: CommunityPluginBundlePublicationCheckpointWriterV1,
): Promise<CommunityPluginBundlePublicationResultV1> {
  if (!isPluginBundlePublicationCommand(command)) {
    return { status: "blocked", reason: "invalid-command" };
  }
  if (pending && !isCommunityPluginBundlePublicationCheckpointV1(pending)) {
    return { status: "blocked", reason: "invalid-checkpoint" };
  }
  if (pending && !publicationCheckpointMatchesCommand(pending, command)) {
    return { status: "blocked", reason: "pending-operation-required" };
  }

  let object: CommunityPluginLifecycleCloudObjectV1 | null;
  try {
    object = pending
      ? await transport.readById(pending.recordId)
      : await transport.read();
  } catch {
    if (pending) {
      return { status: "uncertain", checkpoint: clonePublicationCheckpoint(pending) };
    }
    return { status: "blocked", reason: "read-failed" };
  }
  if (!object) return { status: "blocked", reason: "record-missing" };
  const current = parseControl(object.content);
  if (!current) return { status: "blocked", reason: "invalid-current" };
  return applyExistingControlMutation(
    transport,
    object,
    current,
    command,
    checkpointWriter,
    createPublicationCheckpoint,
    publicationEffectMatches,
    pending ? "recovered" : "existing",
  );
}

/**
 * Join one participant to one exact plugin generation through the same
 * lifecycle CAS and response-unknown checkpoint used by the other explicit
 * control mutations. It grants no file transfer by itself.
 */
export async function joinCommunityPluginGenerationV1(
  transport: CommunityPluginLifecycleCloudTransportV1,
  input: Readonly<CommunityPluginGenerationJoinInputV1>,
  pending: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1> | null,
  checkpointWriter: CommunityPluginLifecycleControlMutationCheckpointWriterV1,
): Promise<CommunityPluginLifecycleControlMutationResultV1> {
  if (!isGenerationJoinInput(input)) {
    return { status: "blocked", reason: "invalid-input" };
  }
  if (pending && !isCommunityPluginLifecycleControlMutationCheckpointV1(pending)) {
    return { status: "blocked", reason: "invalid-checkpoint" };
  }
  if (pending && !joinCheckpointMatchesInput(pending, input)) {
    return { status: "blocked", reason: "pending-operation-required" };
  }

  let object: CommunityPluginLifecycleCloudObjectV1 | null;
  try {
    object = pending
      ? await transport.readById(pending.recordId)
      : await transport.read();
  } catch {
    if (pending) return { status: "uncertain", checkpoint: cloneControlCheckpoint(pending) };
    return { status: "blocked", reason: "read-failed" };
  }
  if (!object) return { status: "blocked", reason: "record-missing" };
  const current = parseControl(object.content);
  if (!current) return { status: "blocked", reason: "invalid-current" };
  if (!sameSyncScope(current.scope, input.scope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  const command: Extract<
    LifecycleControlMutationCommandV1,
    { type: "join-plugin" }
  > = pending?.command.type === "join-plugin"
    ? pending.command
    : {
      type: "join-plugin",
      participant: { ...input.participant },
      pluginId: input.pluginId,
      targetGeneration: input.targetGeneration,
      joinNonce: input.joinNonce,
      joinEvidence: input.joinEvidence,
      ...(input.observedClosedRevision === undefined
        ? {}
        : { observedClosedRevision: input.observedClosedRevision }),
      operationId: input.operationId,
      expectedRevision: current.revision,
      scope: { ...input.scope },
      at: input.joinedAt,
    };
  if (generationJoinEffectMatches(current, command)) {
    return readyExistingControlMutation(
      object,
      current,
      pending ? "recovered" : "existing",
    );
  }
  return applyExistingControlMutation(
    transport,
    object,
    current,
    command,
    checkpointWriter,
    createControlMutationCheckpoint,
    controlMutationEffectMatches,
    pending ? "recovered" : "existing",
  );
}

/**
 * Persist one explicit legacy-device declaration through the same lifecycle
 * object's If-Match transaction. It does not publish or seal a plugin and it
 * never creates a missing lifecycle registry.
 */
export async function confirmCommunityPluginLegacyMigrationV1(
  transport: CommunityPluginLifecycleCloudTransportV1,
  input: Readonly<CommunityPluginLegacyMigrationConfirmationInputV1>,
  pending: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1> | null,
  checkpointWriter: CommunityPluginLifecycleControlMutationCheckpointWriterV1,
): Promise<CommunityPluginLifecycleControlMutationResultV1> {
  if (!isLegacyMigrationConfirmationInput(input)) {
    return { status: "blocked", reason: "invalid-input" };
  }
  if (pending && !isCommunityPluginLifecycleControlMutationCheckpointV1(pending)) {
    return { status: "blocked", reason: "invalid-checkpoint" };
  }
  if (
    pending
    && (
      pending.command.type !== "confirm-legacy-migration"
      || !confirmationCheckpointMatchesInput(pending, input)
    )
  ) return { status: "blocked", reason: "pending-operation-required" };

  let object: CommunityPluginLifecycleCloudObjectV1 | null;
  try {
    object = pending
      ? await transport.readById(pending.recordId)
      : await transport.read();
  } catch {
    if (pending) return { status: "uncertain", checkpoint: cloneControlCheckpoint(pending) };
    return { status: "blocked", reason: "read-failed" };
  }
  if (!object) return { status: "blocked", reason: "record-missing" };
  const current = parseControl(object.content);
  if (!current) return { status: "blocked", reason: "invalid-current" };
  if (!sameSyncScope(current.scope, input.scope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  if (current.schemaVersion === 2 && current.legacyMigrationConsent !== null) {
    return readyExistingControlMutation(
      object,
      current,
      pending ? "recovered" : "existing",
    );
  }
  const command: Extract<
    LifecycleControlMutationCommandV1,
    { type: "confirm-legacy-migration" }
  > = pending?.command.type === "confirm-legacy-migration"
    ? pending.command
    : {
      type: "confirm-legacy-migration",
      actor: { ...input.actor },
      evidence: input.evidence,
      operationId: input.operationId,
      expectedRevision: current.revision,
      scope: { ...input.scope },
      at: input.confirmedAt,
    };
  return applyExistingControlMutation(
    transport,
    object,
    current,
    command,
    checkpointWriter,
    createControlMutationCheckpoint,
    controlMutationEffectMatches,
    pending ? "recovered" : "existing",
  );
}

/** Seal one already published plugin bundle as the permanent legacy cutoff. */
export async function sealCommunityPluginLegacyAuthorityV1(
  transport: CommunityPluginLifecycleCloudTransportV1,
  input: Readonly<CommunityPluginLegacyAuthoritySealInputV1>,
  pending: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1> | null,
  checkpointWriter: CommunityPluginLifecycleControlMutationCheckpointWriterV1,
): Promise<CommunityPluginLifecycleControlMutationResultV1> {
  if (!isLegacyAuthoritySealInput(input)) {
    return { status: "blocked", reason: "invalid-input" };
  }
  if (pending && !isCommunityPluginLifecycleControlMutationCheckpointV1(pending)) {
    return { status: "blocked", reason: "invalid-checkpoint" };
  }
  if (pending && !sealCheckpointMatchesInput(pending, input)) {
    return { status: "blocked", reason: "pending-operation-required" };
  }

  let object: CommunityPluginLifecycleCloudObjectV1 | null;
  try {
    object = pending
      ? await transport.readById(pending.recordId)
      : await transport.read();
  } catch {
    if (pending) return { status: "uncertain", checkpoint: cloneControlCheckpoint(pending) };
    return { status: "blocked", reason: "read-failed" };
  }
  if (!object) return { status: "blocked", reason: "record-missing" };
  const current = parseControl(object.content);
  if (!current) return { status: "blocked", reason: "invalid-current" };
  if (!sameSyncScope(current.scope, input.scope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  if (legacyAuthoritySealMatchesInput(current, input)) {
    return readyExistingControlMutation(
      object,
      current,
      pending ? "recovered" : "existing",
    );
  }
  const command: Extract<
    LifecycleControlMutationCommandV1,
    { type: "seal-plugin-legacy-authority" }
  > = pending?.command.type === "seal-plugin-legacy-authority"
    ? pending.command
    : {
      type: "seal-plugin-legacy-authority",
      actor: { ...input.actor },
      pluginId: input.pluginId,
      generation: input.generation,
      publishedBundle: structuredClone(input.publishedBundle),
      operationId: input.operationId,
      expectedRevision: current.revision,
      scope: { ...input.scope },
      at: input.sealedAt,
    };
  return applyExistingControlMutation(
    transport,
    object,
    current,
    command,
    checkpointWriter,
    createControlMutationCheckpoint,
    controlMutationEffectMatches,
    pending ? "recovered" : "existing",
  );
}

/**
 * Persist an explicit S9 lifecycle transition through the existing control
 * object's checkpointed If-Match transaction. This function only changes the
 * lifecycle record; it cannot delete plugin bytes or manufacture a cleanup
 * receipt. `complete-close` therefore accepts only a digest produced by the
 * separate verified cleanup transaction.
 */
export async function transitionCommunityPluginLifecycleV1(
  transport: CommunityPluginLifecycleCloudTransportV1,
  requested: Readonly<CommunityPluginLifecycleTransitionCommandV1>,
  pending: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1> | null,
  checkpointWriter: CommunityPluginLifecycleControlMutationCheckpointWriterV1,
): Promise<CommunityPluginLifecycleControlMutationResultV1> {
  if (!isLifecycleTransitionCommand(requested)) {
    return { status: "blocked", reason: "invalid-input" };
  }
  if (pending && !isCommunityPluginLifecycleControlMutationCheckpointV1(pending)) {
    return { status: "blocked", reason: "invalid-checkpoint" };
  }
  if (
    pending
    && (
      !isLifecycleTransitionCommand(pending.command)
      || !sameCommunityPluginLifecycleCommandV1(pending.command, requested)
    )
  ) {
    return { status: "blocked", reason: "pending-operation-required" };
  }

  let object: CommunityPluginLifecycleCloudObjectV1 | null;
  try {
    object = pending
      ? await transport.readById(pending.recordId)
      : await transport.read();
  } catch {
    if (pending) return { status: "uncertain", checkpoint: cloneControlCheckpoint(pending) };
    return { status: "blocked", reason: "read-failed" };
  }
  if (!object) return { status: "blocked", reason: "record-missing" };
  const current = parseControl(object.content);
  if (!current) return { status: "blocked", reason: "invalid-current" };
  if (!sameSyncScope(current.scope, requested.scope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  const command = pending && isLifecycleTransitionCommand(pending.command)
    ? pending.command
    : structuredClone(requested);
  if (lifecycleTransitionEffectMatches(current, command)) {
    return readyExistingControlMutation(
      object,
      current,
      pending ? "recovered" : "existing",
    );
  }
  return applyExistingControlMutation(
    transport,
    object,
    current,
    command,
    checkpointWriter,
    createControlMutationCheckpoint,
    controlMutationEffectMatches,
    pending ? "recovered" : "existing",
  );
}

async function applyExistingControlMutation<
  Command extends ExistingControlMutationCommandV1,
  Checkpoint extends ExistingControlMutationCheckpointV1,
>(
  transport: CommunityPluginLifecycleCloudTransportV1,
  object: CommunityPluginLifecycleCloudObjectV1,
  current: CommunityPluginLifecycleControlV1,
  command: Command,
  checkpointWriter: { persist(checkpoint: Readonly<Checkpoint>): Promise<void> },
  createMutationCheckpoint: (command: Readonly<Command>, recordId: string) => Checkpoint,
  effectMatches: (
    state: Readonly<CommunityPluginLifecycleControlV1>,
    command: Readonly<Command>,
  ) => boolean,
  existingSource: "existing" | "recovered",
): Promise<ExistingControlMutationResultV1<Checkpoint>> {
  const reduced = reduceCommunityPluginLifecycleV1(current, command);
  if (reduced.status === "idempotent" || effectMatches(current, command)) {
    return readyExistingControlMutation(object, current, existingSource);
  }
  if (reduced.status === "blocked") return { status: "blocked", reason: reduced.reason };

  const checkpoint = createMutationCheckpoint(command, object.id);
  try {
    await checkpointWriter.persist(checkpoint);
  } catch {
    return { status: "blocked", reason: "checkpoint-persist-failed" };
  }

  let recordId = object.id;
  let source: "updated" | "recovered" = "recovered";
  let readAttempts = 1;
  try {
    const written = await transport.updateCas(
      object.id,
      object.eTag,
      JSON.stringify(reduced.state),
    );
    recordId = written.id;
    source = "updated";
    readAttempts = 2;
  } catch {
    // The request may have reached OneDrive even when its response was lost.
  }

  let observed: CommunityPluginLifecycleCloudObjectV1 | null = null;
  for (let attempt = 0; attempt < readAttempts && !observed; attempt += 1) {
    try {
      observed = await transport.readById(recordId);
    } catch {
      source = "recovered";
    }
  }
  if (!observed) {
    return {
      status: "uncertain",
      checkpoint: createMutationCheckpoint(command, recordId),
    };
  }
  const state = parseControl(observed.content);
  if (!state) return { status: "blocked", reason: "readback-mismatch" };
  const replay = reduceCommunityPluginLifecycleV1(state, command);
  if (replay.status === "idempotent" || effectMatches(state, command)) {
    return readyExistingControlMutation(observed, state, source);
  }
  return {
    status: "blocked",
    reason: source === "recovered" ? "write-race" : "readback-mismatch",
  };
}

function readyExistingControlMutation(
  object: CommunityPluginLifecycleCloudObjectV1,
  state: CommunityPluginLifecycleControlV1,
  source: "updated" | "existing" | "recovered",
): ExistingControlMutationResultV1<never> {
  return {
    status: "ready",
    source,
    state,
    recordId: object.id,
    recordETag: object.eTag,
  };
}

function controlMutationEffectMatches(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  command: Readonly<LifecycleControlMutationCommandV1>,
): boolean {
  if (command.type === "join-plugin") {
    return generationJoinEffectMatches(state, command);
  }
  if (command.type === "confirm-legacy-migration") {
    const consent = state.legacyMigrationConsent;
    return state.schemaVersion === 2
      && consent !== undefined
      && consent !== null
      && consent.confirmedBy.participantId === command.actor.participantId
      && consent.confirmedBy.incarnation === command.actor.incarnation
      && consent.confirmedAt === command.at
      && consent.confirmedRevision === command.expectedRevision + 1
      && consent.evidence === command.evidence;
  }
  if (command.type === "seal-plugin-legacy-authority") {
    const seal = state.pluginsById[command.pluginId]?.legacyAuthoritySeal;
    return seal !== undefined
      && seal.generation === command.generation
      && seal.sealedBy.participantId === command.actor.participantId
      && seal.sealedBy.incarnation === command.actor.incarnation
      && seal.sealedAt === command.at
      && seal.sealedRevision === command.expectedRevision + 1
      && sameCommunityPluginPublishedBundleV1(
        seal.publishedBundle,
        command.publishedBundle,
      );
  }
  return lifecycleTransitionEffectMatches(state, command);
}

function lifecycleTransitionEffectMatches(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  command: Readonly<Extract<
    LifecycleControlMutationCommandV1,
    { type: "exit-plugin" | "retire-participant" | "begin-close" | "complete-close" }
  >>,
): boolean {
  if (command.type === "exit-plugin") {
    const generation = state.pluginsById[command.pluginId]?.currentGeneration;
    const member = generation?.membersByKey[
      communityPluginParticipantKeyV1(command.participant)
    ];
    return generation?.generation === command.generation
      && member?.phase === "exited"
      && member.exitedAt === command.at;
  }
  if (command.type === "retire-participant") {
    const target = state.participantsByKey[
      communityPluginParticipantKeyV1(command.target)
    ];
    return target?.retiredAt === command.at;
  }
  const generation = state.pluginsById[command.pluginId]?.currentGeneration;
  if (command.type === "begin-close") {
    const closing = generation?.closing;
    return generation?.generation === command.generation
      && closing?.owner.participantId === command.actor.participantId
      && closing.owner.incarnation === command.actor.incarnation
      && closing.startedAt === command.at
      && closing.startedRevision === command.expectedRevision + 1;
  }
  const closed = generation?.closed;
  return generation?.generation === command.generation
    && generation.phase === "closed"
    && closed?.owner.participantId === command.actor.participantId
    && closed.owner.incarnation === command.actor.incarnation
    && closed.closedAt === command.at
    && closed.cleanupReceiptDigest === command.cleanupReceiptDigest;
}

function generationJoinEffectMatches(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  command: Readonly<Extract<
    CommunityPluginLifecycleCommandV1,
    { type: "join-plugin" }
  >>,
): boolean {
  const generation = state.pluginsById[command.pluginId]?.currentGeneration;
  const member = generation?.membersByKey[
    communityPluginParticipantKeyV1(command.participant)
  ];
  return generation?.phase === "open"
    && generation.generation === command.targetGeneration
    && member?.phase === "joined"
    && member.joinNonce === command.joinNonce
    && member.joinEvidence === command.joinEvidence;
}

function createControlMutationCheckpoint(
  command: Readonly<LifecycleControlMutationCommandV1>,
  recordId: string,
): CommunityPluginLifecycleControlMutationCheckpointV1 {
  return {
    schemaVersion: 1,
    kind: "community-plugin-lifecycle-control-mutation-checkpoint",
    command: structuredClone(command),
    recordId,
  };
}

function cloneControlCheckpoint(
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
): CommunityPluginLifecycleControlMutationCheckpointV1 {
  return structuredClone(checkpoint) as CommunityPluginLifecycleControlMutationCheckpointV1;
}

function buildObservationCommand(
  current: CommunityPluginLifecycleControlV1 | null,
  input: Readonly<CommunityPluginParticipantObservationInputV1>,
): ParticipantObservationCommandV1 {
  const key = communityPluginParticipantKeyV1(input.participant);
  return {
    type: current?.participantsByKey[key]
      ? "observe-participant"
      : "register-participant",
    participant: { ...input.participant },
    operationId: input.operationId,
    expectedRevision: current?.revision ?? 1,
    scope: { ...input.scope },
    at: input.observedAt,
  };
}

function publicationEffectMatches(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  command: Readonly<PluginBundlePublicationCommandV1>,
): boolean {
  const published = state.pluginsById[command.pluginId]
    ?.currentGeneration?.publishedBundle;
  return published !== undefined
    && published.publisher.participantId === command.participant.participantId
    && published.publisher.incarnation === command.participant.incarnation
    && published.publisherJoinNonce === command.joinNonce
    && published.publishedAt === command.at
    && published.publishedFenceEpoch === command.fenceEpoch
    && sameManifestObject(published.manifestObject, command.manifestObject);
}

function createPublicationCheckpoint(
  command: Readonly<PluginBundlePublicationCommandV1>,
  recordId: string,
): CommunityPluginBundlePublicationCheckpointV1 {
  return {
    schemaVersion: 1,
    kind: "community-plugin-bundle-publication-checkpoint",
    command: structuredClone(command),
    recordId,
  };
}

function clonePublicationCheckpoint(
  checkpoint: Readonly<CommunityPluginBundlePublicationCheckpointV1>,
): CommunityPluginBundlePublicationCheckpointV1 {
  return structuredClone(checkpoint) as CommunityPluginBundlePublicationCheckpointV1;
}

async function resolveAfterUnknownWrite(
  transport: CommunityPluginLifecycleCloudTransportV1,
  command: ParticipantObservationCommandV1,
  recordId: string | null,
): Promise<CommunityPluginLifecycleObservationResultV1> {
  const checkpoint = createCheckpoint(command, recordId);
  let observed: CommunityPluginLifecycleCloudObjectV1 | null;
  try {
    observed = recordId
      ? await transport.readById(recordId)
      : await transport.read();
  } catch {
    return { status: "uncertain", checkpoint };
  }
  if (!observed) return recordId
    ? { status: "uncertain", checkpoint }
    : { status: "blocked", reason: "write-race" };
  return verifyAppliedObservation(observed, command, "recovered", checkpoint);
}

function verifyAppliedObservation(
  object: CommunityPluginLifecycleCloudObjectV1,
  command: ParticipantObservationCommandV1,
  source: "created" | "updated" | "recovered",
  checkpoint?: CommunityPluginLifecycleObservationCheckpointV1,
): CommunityPluginLifecycleObservationResultV1 {
  const state = parseControl(object.content);
  if (!state) return { status: "blocked", reason: "readback-mismatch" };
  const replay = reduceCommunityPluginLifecycleV1(state, command);
  if (replay.status === "idempotent") return ready(object, state, source);
  if (checkpoint) return { status: "blocked", reason: "write-race" };
  return { status: "blocked", reason: "readback-mismatch" };
}

function ready(
  object: CommunityPluginLifecycleCloudObjectV1,
  state: CommunityPluginLifecycleControlV1,
  source: "created" | "updated" | "existing" | "recovered",
): CommunityPluginLifecycleObservationResultV1 {
  return {
    status: "ready",
    source,
    state,
    recordId: object.id,
    recordETag: object.eTag,
  };
}

function createCheckpoint(
  command: ParticipantObservationCommandV1,
  recordId: string | null,
): CommunityPluginLifecycleObservationCheckpointV1 {
  return {
    schemaVersion: 1,
    kind: "community-plugin-lifecycle-observation-checkpoint",
    command: structuredClone(command),
    recordId,
  };
}

function cloneCheckpoint(
  checkpoint: Readonly<CommunityPluginLifecycleObservationCheckpointV1>,
): CommunityPluginLifecycleObservationCheckpointV1 {
  return structuredClone(checkpoint) as CommunityPluginLifecycleObservationCheckpointV1;
}

function parseControl(content: string): CommunityPluginLifecycleControlV1 | null {
  try {
    const value: unknown = JSON.parse(content);
    return isCommunityPluginLifecycleControlV1(value) ? value : null;
  } catch {
    return null;
  }
}

function isObservationInput(
  input: Readonly<CommunityPluginParticipantObservationInputV1>,
): boolean {
  if (!isSyncScope(input.scope) || !isCommunityPluginParticipantIdentityV1(input.participant)) {
    return false;
  }
  return isParticipantObservationCommand({
    type: "register-participant",
    participant: input.participant,
    operationId: input.operationId,
    expectedRevision: 1,
    scope: input.scope,
    at: input.observedAt,
  });
}

function isParticipantObservationCommand(
  value: unknown,
): value is ParticipantObservationCommandV1 {
  return isCommunityPluginLifecycleCommandV1(value)
    && (value.type === "register-participant" || value.type === "observe-participant");
}

function isPluginBundlePublicationCommand(
  value: unknown,
): value is PluginBundlePublicationCommandV1 {
  return isCommunityPluginLifecycleCommandV1(value)
    && value.type === "publish-plugin-bundle";
}

function isLifecycleControlMutationCommand(
  value: unknown,
): value is LifecycleControlMutationCommandV1 {
  return isCommunityPluginLifecycleCommandV1(value)
    && (
      value.type === "join-plugin"
      || value.type === "confirm-legacy-migration"
      || value.type === "seal-plugin-legacy-authority"
      || value.type === "exit-plugin"
      || value.type === "retire-participant"
      || value.type === "begin-close"
      || value.type === "complete-close"
    );
}

function isLifecycleTransitionCommand(
  value: Readonly<CommunityPluginLifecycleCommandV1>,
): value is Extract<
  LifecycleControlMutationCommandV1,
  { type: "exit-plugin" | "retire-participant" | "begin-close" | "complete-close" }
> {
  return value.type === "exit-plugin"
    || value.type === "retire-participant"
    || value.type === "begin-close"
    || value.type === "complete-close";
}

function isGenerationJoinInput(
  value: unknown,
): value is CommunityPluginGenerationJoinInputV1 {
  if (!isRecord(value)) return false;
  return isSyncScope(value.scope)
    && isCommunityPluginParticipantIdentityV1(value.participant)
    && isCommunityPluginLifecycleCommandV1({
      type: "join-plugin",
      participant: value.participant,
      pluginId: value.pluginId,
      targetGeneration: value.targetGeneration,
      joinNonce: value.joinNonce,
      joinEvidence: value.joinEvidence,
      ...(value.observedClosedRevision === undefined
        ? {}
        : { observedClosedRevision: value.observedClosedRevision }),
      operationId: value.operationId,
      expectedRevision: 1,
      scope: value.scope,
      at: value.joinedAt,
    });
}

function isLegacyMigrationConfirmationInput(
  value: unknown,
): value is CommunityPluginLegacyMigrationConfirmationInputV1 {
  if (!isRecord(value)) return false;
  return isSyncScope(value.scope)
    && isCommunityPluginParticipantIdentityV1(value.actor)
    && value.evidence === "user-confirmed-legacy-devices-upgraded-or-retired"
    && isCommunityPluginLifecycleCommandV1({
      type: "confirm-legacy-migration",
      actor: value.actor,
      evidence: value.evidence,
      operationId: value.operationId,
      expectedRevision: 1,
      scope: value.scope,
      at: value.confirmedAt,
  });
}

function isLegacyAuthoritySealInput(
  value: unknown,
): value is CommunityPluginLegacyAuthoritySealInputV1 {
  if (!isRecord(value)) return false;
  return isSyncScope(value.scope)
    && isCommunityPluginParticipantIdentityV1(value.actor)
    && isCommunityPluginLifecycleCommandV1({
      type: "seal-plugin-legacy-authority",
      actor: value.actor,
      pluginId: value.pluginId,
      generation: value.generation,
      publishedBundle: value.publishedBundle,
      operationId: value.operationId,
      expectedRevision: 1,
      scope: value.scope,
      at: value.sealedAt,
    });
}

function checkpointMatchesInput(
  checkpoint: Readonly<CommunityPluginLifecycleObservationCheckpointV1>,
  input: Readonly<CommunityPluginParticipantObservationInputV1>,
): boolean {
  const command = checkpoint.command;
  return command.operationId === input.operationId
    && command.at === input.observedAt
    && sameSyncScope(command.scope, input.scope)
    && command.participant.participantId === input.participant.participantId
    && command.participant.incarnation === input.participant.incarnation;
}

function confirmationCheckpointMatchesInput(
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
  input: Readonly<CommunityPluginLegacyMigrationConfirmationInputV1>,
): boolean {
  const command = checkpoint.command;
  return command.type === "confirm-legacy-migration"
    && command.operationId === input.operationId
    && command.at === input.confirmedAt
    && sameSyncScope(command.scope, input.scope)
    && command.actor.participantId === input.actor.participantId
    && command.actor.incarnation === input.actor.incarnation
    && command.evidence === input.evidence;
}

function joinCheckpointMatchesInput(
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
  input: Readonly<CommunityPluginGenerationJoinInputV1>,
): boolean {
  const command = checkpoint.command;
  return command.type === "join-plugin"
    && command.operationId === input.operationId
    && command.at === input.joinedAt
    && sameSyncScope(command.scope, input.scope)
    && command.participant.participantId === input.participant.participantId
    && command.participant.incarnation === input.participant.incarnation
    && command.pluginId === input.pluginId
    && command.targetGeneration === input.targetGeneration
    && command.joinNonce === input.joinNonce
    && command.joinEvidence === input.joinEvidence
    && command.observedClosedRevision === input.observedClosedRevision;
}

function sealCheckpointMatchesInput(
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
  input: Readonly<CommunityPluginLegacyAuthoritySealInputV1>,
): boolean {
  const command = checkpoint.command;
  return command.type === "seal-plugin-legacy-authority"
    && command.operationId === input.operationId
    && command.at === input.sealedAt
    && sameSyncScope(command.scope, input.scope)
    && command.actor.participantId === input.actor.participantId
    && command.actor.incarnation === input.actor.incarnation
    && command.pluginId === input.pluginId
    && command.generation === input.generation
    && sameCommunityPluginPublishedBundleV1(
      command.publishedBundle,
      input.publishedBundle,
    );
}

function legacyAuthoritySealMatchesInput(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  input: Readonly<CommunityPluginLegacyAuthoritySealInputV1>,
): boolean {
  const seal = state.pluginsById[input.pluginId]?.legacyAuthoritySeal;
  return seal !== undefined
    && seal.generation === input.generation
    && seal.sealedBy.participantId === input.actor.participantId
    && seal.sealedBy.incarnation === input.actor.incarnation
    && sameCommunityPluginPublishedBundleV1(
      seal.publishedBundle,
      input.publishedBundle,
    );
}

function publicationCheckpointMatchesCommand(
  checkpoint: Readonly<CommunityPluginBundlePublicationCheckpointV1>,
  command: Readonly<PluginBundlePublicationCommandV1>,
): boolean {
  const pending = checkpoint.command;
  return pending.type === command.type
    && pending.operationId === command.operationId
    && pending.expectedRevision === command.expectedRevision
    && pending.at === command.at
    && sameSyncScope(pending.scope, command.scope)
    && pending.participant.participantId === command.participant.participantId
    && pending.participant.incarnation === command.participant.incarnation
    && pending.pluginId === command.pluginId
    && pending.generation === command.generation
    && pending.joinNonce === command.joinNonce
    && pending.fenceEpoch === command.fenceEpoch
    && sameManifestObject(pending.manifestObject, command.manifestObject);
}

function sameManifestObject(
  left: PluginBundlePublicationCommandV1["manifestObject"],
  right: PluginBundlePublicationCommandV1["manifestObject"],
): boolean {
  return left.objectPath === right.objectPath
    && left.remoteId === right.remoteId
    && left.parentId === right.parentId
    && left.size === right.size
    && left.eTag === right.eTag
    && left.cTag === right.cTag
    && left.sha256Hash === right.sha256Hash;
}
