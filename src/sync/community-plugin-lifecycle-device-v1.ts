import { isRecord } from "../obsidian-compat";
import {
  isCommunityPluginGenerationCleanupCheckpointV1,
  type CommunityPluginGenerationCleanupCheckpointStoreV1,
  type CommunityPluginGenerationCleanupCheckpointV1,
  type CommunityPluginLifecycleControlMutationCheckpointStoreV1,
} from "./community-plugin-generation-cleanup-cloud-v1";
import {
  stageCommunityPluginGenerationBundleV1,
  type CommunityPluginGenerationContentCloudTransportV1,
} from "./community-plugin-generation-content-cloud-v1";
import {
  createCommunityPluginBundlePublicationCommandV1,
  createCommunityPluginGenerationContentGrantV1,
  type CommunityPluginGenerationBundleFileNameV1,
} from "./community-plugin-generation-content-v1";
import {
  createIndexedDbVaultInstanceId,
  isIndexedDbVaultInstanceId,
  type VaultLocalStorage,
} from "./indexeddb-vault-namespace";
import {
  confirmCommunityPluginLegacyMigrationV1,
  isCommunityPluginBundlePublicationCheckpointV1,
  isCommunityPluginLifecycleControlMutationCheckpointV1,
  isCommunityPluginLifecycleObservationCheckpointV1,
  joinCommunityPluginGenerationV1,
  publishCommunityPluginParticipantObservationV1,
  publishCommunityPluginBundleSelectionV1,
  sealCommunityPluginLegacyAuthorityV1,
  transitionCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCloudTransportV1,
  type CommunityPluginBundlePublicationCheckpointV1,
  type CommunityPluginBundlePublicationResultV1,
  type CommunityPluginLifecycleControlMutationCheckpointV1,
  type CommunityPluginLifecycleControlMutationResultV1,
  type CommunityPluginLegacyAuthoritySealInputV1,
  type CommunityPluginGenerationJoinInputV1,
  type CommunityPluginLegacyMigrationConfirmationInputV1,
  type CommunityPluginLifecycleObservationCheckpointV1,
  type CommunityPluginLifecycleObservationResultV1,
  type CommunityPluginParticipantObservationInputV1,
  type CommunityPluginLifecycleTransitionCommandV1,
} from "./community-plugin-lifecycle-cloud-v1";
import {
  communityPluginAuthoritativePublishedBundleV1,
  isCommunityPluginParticipantIdentityV1,
  sameCommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginParticipantIdentityV1,
  type CommunityPluginPublishedBundleV1,
} from "./community-plugin-lifecycle-v1";
import { sameSyncScope, type SyncScope } from "./types";

export const COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY =
  "easy-sync-community-plugin-lifecycle-device-v1";
export const COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY =
  "easy-sync-community-plugin-lifecycle-observation-checkpoint-v1";
export const COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY =
  "easy-sync-community-plugin-lifecycle-control-mutation-checkpoint-v1";
export const COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY =
  "easy-sync-community-plugin-bundle-publication-checkpoint-v1";
export const COMMUNITY_PLUGIN_GENERATION_CLEANUP_CHECKPOINT_KEY =
  "easy-sync-community-plugin-generation-cleanup-checkpoint-v2";
export const COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_INTERVAL_MS =
  24 * 60 * 60 * 1_000;

export interface CommunityPluginLifecycleDeviceIdentityV1 {
  schemaVersion: 1;
  kind: "community-plugin-lifecycle-device";
  vaultInstanceId: string;
  participant: CommunityPluginParticipantIdentityV1;
  createdAt: number;
  lastSuccessfulObservationAt: number | null;
}

export type CommunityPluginLifecycleDeviceObservationResultV1 =
  | CommunityPluginLifecycleObservationResultV1
  | {
    status: "blocked";
    reason:
      | "local-identity-unavailable"
      | "local-checkpoint-invalid"
      | "local-checkpoint-conflict"
      | "local-checkpoint-clear-failed"
      | "pending-scope-mismatch";
  };

export type CommunityPluginLifecycleDeviceControlMutationResultV1 =
  | CommunityPluginLifecycleControlMutationResultV1
  | {
    status: "blocked";
    reason:
      | "local-identity-unavailable"
      | "local-checkpoint-invalid"
      | "local-checkpoint-conflict"
      | "local-checkpoint-clear-failed"
      | "pending-scope-mismatch";
  };

export type CommunityPluginLifecycleDeviceBundlePublicationResultV1 =
  | CommunityPluginBundlePublicationResultV1
  | {
    status: "blocked";
    reason:
      | "local-identity-unavailable"
      | "local-checkpoint-invalid"
      | "local-checkpoint-conflict"
      | "local-checkpoint-clear-failed"
      | "pending-scope-mismatch";
  };

export type CommunityPluginLegacyBundleMigrationResultV1 =
  | {
    status: "ready";
    state: CommunityPluginLifecycleControlV1;
  }
  | {
    status: "retry";
    phase: "staging";
    reason: "create-outcome-unknown" | "readback-unavailable";
  }
  | {
    status: "uncertain";
    phase: "publication" | "seal";
  }
  | {
    status: "blocked";
    phase: "staging" | "publication" | "seal";
    reason: string;
  };

export type CommunityPluginLifecycleDeviceTransitionCommandV1 = Exclude<
  CommunityPluginLifecycleTransitionCommandV1,
  { type: "complete-close" }
>;

export function createCommunityPluginGenerationCleanupCheckpointStoreV1(
  storage: VaultLocalStorage,
): CommunityPluginGenerationCleanupCheckpointStoreV1 {
  return {
    async load() {
      const value = storage.loadLocalStorage(
        COMMUNITY_PLUGIN_GENERATION_CLEANUP_CHECKPOINT_KEY,
      );
      return value === undefined ? null : structuredClone(value);
    },
    async persist(checkpoint) {
      const current = storage.loadLocalStorage(
        COMMUNITY_PLUGIN_GENERATION_CLEANUP_CHECKPOINT_KEY,
      );
      if (
        current !== null
        && current !== undefined
        && (
          !isCommunityPluginGenerationCleanupCheckpointV1(current)
          || !cleanupCheckpointCanAdvance(current, checkpoint)
        )
      ) throw new Error("A different generation cleanup is still pending");
      storage.saveLocalStorage(
        COMMUNITY_PLUGIN_GENERATION_CLEANUP_CHECKPOINT_KEY,
        structuredClone(checkpoint),
      );
      const verified = storage.loadLocalStorage(
        COMMUNITY_PLUGIN_GENERATION_CLEANUP_CHECKPOINT_KEY,
      );
      if (
        !isCommunityPluginGenerationCleanupCheckpointV1(verified)
        || !sameCheckpoint(verified, checkpoint)
      ) throw new Error("Community-plugin generation cleanup checkpoint was not persisted");
    },
    async clear(checkpoint) {
      clearExactLocalCheckpoint(
        storage,
        COMMUNITY_PLUGIN_GENERATION_CLEANUP_CHECKPOINT_KEY,
        checkpoint,
        isCommunityPluginGenerationCleanupCheckpointV1,
        "community-plugin generation cleanup",
      );
    },
  };
}

export function createCommunityPluginLifecycleControlMutationCheckpointStoreV1(
  storage: VaultLocalStorage,
): CommunityPluginLifecycleControlMutationCheckpointStoreV1 {
  return {
    async load() {
      const result = readControlMutationCheckpoint(storage);
      if (result.status === "none") return null;
      if (result.status === "invalid") {
        throw new Error("Lifecycle control mutation checkpoint is invalid");
      }
      return structuredClone(result.checkpoint);
    },
    async persist(checkpoint) {
      persistControlMutationCheckpoint(storage, checkpoint);
    },
    async clear(checkpoint) {
      clearExactLocalCheckpoint(
        storage,
        COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
        checkpoint,
        isCommunityPluginLifecycleControlMutationCheckpointV1,
        "lifecycle control mutation",
      );
    },
  };
}

type LocalCheckpointReadResult<Checkpoint> =
  | { status: "none" }
  | {
    status: "ready";
    checkpoint: Checkpoint;
  }
  | { status: "invalid" };

type DeviceControlMutationRequestV1 =
  | {
    type: "join-plugin";
    scope: SyncScope;
    pluginId: string;
    targetGeneration: number;
    joinNonce: string;
    joinEvidence: "host-install" | "user-confirmed";
    observedClosedRevision?: number;
    at: number;
  }
  | {
    type: "confirm-legacy-migration";
    scope: SyncScope;
    at: number;
  }
  | {
    type: "seal-plugin-legacy-authority";
    scope: SyncScope;
    pluginId: string;
    generation: number;
    publishedBundle: CommunityPluginPublishedBundleV1;
    at: number;
  };

/**
 * S7b device-local owner. It serializes participant observations and persists
 * the exact command before Graph mutation. It does not own the cloud state, plugin
 * participation, a timer, or any file mutation.
 */
export class CommunityPluginLifecycleDeviceObserverV1 {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: VaultLocalStorage,
    private readonly vaultInstanceId: string,
  ) {}

  /** Read the current device participant without creating or rotating it. */
  getParticipantIdentity(): CommunityPluginParticipantIdentityV1 | null {
    const identity = readCommunityPluginLifecycleDeviceIdentityV1(this.storage);
    if (!identity || identity.vaultInstanceId !== this.vaultInstanceId) return null;
    return { ...identity.participant };
  }

  createGenerationCleanupCheckpointStore():
  CommunityPluginGenerationCleanupCheckpointStoreV1 {
    return createCommunityPluginGenerationCleanupCheckpointStoreV1(this.storage);
  }

  createControlMutationCheckpointStore():
  CommunityPluginLifecycleControlMutationCheckpointStoreV1 {
    return createCommunityPluginLifecycleControlMutationCheckpointStoreV1(
      this.storage,
    );
  }

  /**
   * Production wiring calls this only after a healthy ordinary sync. Pending
   * recovery always wins; otherwise one successful observation per day is
   * enough. This cadence is diagnostic only and never authorizes closing.
   */
  isObservationDue(observedAt: number): boolean {
    if (!isTime(observedAt)) return false;
    const pending = readObservationCheckpoint(this.storage);
    if (pending.status !== "none") return true;
    const identity = readCommunityPluginLifecycleDeviceIdentityV1(this.storage);
    if (!identity || identity.vaultInstanceId !== this.vaultInstanceId) return true;
    const last = identity.lastSuccessfulObservationAt;
    return last === null
      || observedAt >= last + COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_INTERVAL_MS;
  }

  observe(
    transport: CommunityPluginLifecycleCloudTransportV1,
    scope: SyncScope,
    observedAt: number,
  ): Promise<CommunityPluginLifecycleDeviceObservationResultV1> {
    const task = this.queue.then(() => this.runObservation(
      transport,
      scope,
      observedAt,
      true,
    ));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  confirmLegacyMigration(
    transport: CommunityPluginLifecycleCloudTransportV1,
    scope: SyncScope,
    confirmedAt: number,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1> {
    const task = this.queue.then(() => this.runControlMutation(
      transport,
      {
        type: "confirm-legacy-migration",
        scope,
        at: confirmedAt,
      },
      true,
    ));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  joinPluginGeneration(
    transport: CommunityPluginLifecycleCloudTransportV1,
    input: Readonly<Omit<
      CommunityPluginGenerationJoinInputV1,
      "participant" | "operationId"
    >>,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1> {
    const task = this.queue.then(() => this.runControlMutation(
      transport,
      {
        type: "join-plugin",
        scope: { ...input.scope },
        pluginId: input.pluginId,
        targetGeneration: input.targetGeneration,
        joinNonce: input.joinNonce,
        joinEvidence: input.joinEvidence,
        ...(input.observedClosedRevision === undefined
          ? {}
          : { observedClosedRevision: input.observedClosedRevision }),
        at: input.joinedAt,
      },
      true,
    ));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  publishPluginBundleSelection(
    transport: CommunityPluginLifecycleCloudTransportV1,
    command: Readonly<Extract<
      CommunityPluginLifecycleCommandV1,
      { type: "publish-plugin-bundle" }
    >>,
  ): Promise<CommunityPluginLifecycleDeviceBundlePublicationResultV1> {
    const task = this.queue.then(() => this.runBundlePublication(
      transport,
      command,
    ));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  migratePluginLegacyBundle(
    lifecycleTransport: CommunityPluginLifecycleCloudTransportV1,
    contentTransport: CommunityPluginGenerationContentCloudTransportV1,
    input: Readonly<{
      control: Readonly<CommunityPluginLifecycleControlV1>;
      pluginId: string;
      files: readonly Readonly<{
        fileName: CommunityPluginGenerationBundleFileNameV1;
        content: ArrayBuffer;
      }>[];
      revalidateSource?: () => Promise<boolean>;
      at: number;
    }>,
  ): Promise<CommunityPluginLegacyBundleMigrationResultV1> {
    const task = this.queue.then(() => this.runLegacyBundleMigration(
      lifecycleTransport,
      contentTransport,
      input,
    ));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  sealPluginLegacyAuthority(
    transport: CommunityPluginLifecycleCloudTransportV1,
    input: Readonly<Omit<CommunityPluginLegacyAuthoritySealInputV1,
      "actor" | "operationId">>,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1> {
    const task = this.queue.then(() => this.runControlMutation(
      transport,
      {
        type: "seal-plugin-legacy-authority",
        scope: { ...input.scope },
        pluginId: input.pluginId,
        generation: input.generation,
        publishedBundle: structuredClone(input.publishedBundle),
        at: input.sealedAt,
      },
      true,
    ));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * Persist one exact exit, retirement, or begin-close command on the same
   * device queue. The caller must derive it from a current control revision;
   * revision races are returned for fresh eligibility evaluation rather than
   * guessed or replayed against a newer device set.
   */
  transitionLifecycle(
    transport: CommunityPluginLifecycleCloudTransportV1,
    command: Readonly<CommunityPluginLifecycleDeviceTransitionCommandV1>,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1> {
    const task = this.queue.then(() => this.runLifecycleTransition(
      transport,
      command,
    ));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Resume an exact response-unknown exit/retirement/close-start first. */
  resumePendingLifecycleTransition(
    transport: CommunityPluginLifecycleCloudTransportV1,
    scope: Readonly<SyncScope>,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1 | null> {
    const task = this.queue.then(() => this.runPendingLifecycleTransition(
      transport,
      scope,
    ));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async runPendingLifecycleTransition(
    transport: CommunityPluginLifecycleCloudTransportV1,
    scope: Readonly<SyncScope>,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1 | null> {
    const pending = readControlMutationCheckpoint(this.storage);
    if (pending.status === "none") return null;
    if (pending.status === "invalid") {
      return { status: "blocked", reason: "local-checkpoint-invalid" };
    }
    if (!sameSyncScope(pending.checkpoint.command.scope, scope)) {
      return { status: "blocked", reason: "pending-scope-mismatch" };
    }
    if (!isDeviceLifecycleTransition(pending.checkpoint.command)) {
      return { status: "blocked", reason: "local-checkpoint-conflict" };
    }
    return this.commitLifecycleTransition(
      transport,
      pending.checkpoint.command,
      pending.checkpoint,
    );
  }

  private async runLifecycleTransition(
    transport: CommunityPluginLifecycleCloudTransportV1,
    requested: Readonly<CommunityPluginLifecycleDeviceTransitionCommandV1>,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1> {
    if (!["exit-plugin", "retire-participant", "begin-close"].includes(
      requested.type,
    )) return { status: "blocked", reason: "invalid-input" };
    const pending = readControlMutationCheckpoint(this.storage);
    if (pending.status === "invalid") {
      return { status: "blocked", reason: "local-checkpoint-invalid" };
    }
    if (
      pending.status === "ready"
      && (
        !sameSyncScope(pending.checkpoint.command.scope, requested.scope)
        || !sameCommunityPluginLifecycleCommandV1(
          pending.checkpoint.command,
          requested,
        )
      )
    ) return { status: "blocked", reason: "local-checkpoint-conflict" };
    const checkpoint = pending.status === "ready"
      ? pending.checkpoint
      : null;
    const command = checkpoint
      ? checkpoint.command as CommunityPluginLifecycleDeviceTransitionCommandV1
      : structuredClone(requested);
    return this.commitLifecycleTransition(transport, command, checkpoint);
  }

  private async commitLifecycleTransition(
    transport: CommunityPluginLifecycleCloudTransportV1,
    command: Readonly<CommunityPluginLifecycleDeviceTransitionCommandV1>,
    checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1> | null,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1> {
    const identity = readCommunityPluginLifecycleDeviceIdentityV1(this.storage);
    if (!identity || identity.vaultInstanceId !== this.vaultInstanceId) {
      return { status: "blocked", reason: "local-identity-unavailable" };
    }
    const actor = command.type === "exit-plugin"
      ? command.participant
      : command.actor;
    if (
      actor.participantId !== identity.participant.participantId
      || actor.incarnation !== identity.participant.incarnation
    ) return { status: "blocked", reason: "local-checkpoint-conflict" };
    const result = await transitionCommunityPluginLifecycleV1(
      transport,
      command,
      checkpoint,
      {
        persist: async (next) => {
          persistControlMutationCheckpoint(this.storage, next);
        },
      },
    );
    if (result.status === "ready") {
      try {
        clearControlMutationCheckpoint(this.storage);
      } catch {
        return { status: "blocked", reason: "local-checkpoint-clear-failed" };
      }
    }
    return result;
  }

  private async runLegacyBundleMigration(
    lifecycleTransport: CommunityPluginLifecycleCloudTransportV1,
    contentTransport: CommunityPluginGenerationContentCloudTransportV1,
    input: Readonly<{
      control: Readonly<CommunityPluginLifecycleControlV1>;
      pluginId: string;
      files: readonly Readonly<{
        fileName: CommunityPluginGenerationBundleFileNameV1;
        content: ArrayBuffer;
      }>[];
      revalidateSource?: () => Promise<boolean>;
      at: number;
    }>,
  ): Promise<CommunityPluginLegacyBundleMigrationResultV1> {
    const identity = readCommunityPluginLifecycleDeviceIdentityV1(this.storage);
    if (!identity || identity.vaultInstanceId !== this.vaultInstanceId) {
      return { status: "blocked", phase: "staging", reason: "local-identity-unavailable" };
    }
    const pendingControl = readControlMutationCheckpoint(this.storage);
    if (pendingControl.status === "invalid") {
      return { status: "blocked", phase: "seal", reason: "local-checkpoint-invalid" };
    }
    if (pendingControl.status === "ready") {
      if (pendingControl.checkpoint.command.type !== "seal-plugin-legacy-authority") {
        return { status: "blocked", phase: "seal", reason: "local-checkpoint-conflict" };
      }
      const command = pendingControl.checkpoint.command;
      const recovered = await this.runControlMutation(
        lifecycleTransport,
        {
          type: "seal-plugin-legacy-authority",
          scope: { ...command.scope },
          pluginId: command.pluginId,
          generation: command.generation,
          publishedBundle: structuredClone(command.publishedBundle),
          at: command.at,
        },
        true,
      );
      if (recovered.status === "uncertain") {
        return { status: "uncertain", phase: "seal" };
      }
      if (recovered.status === "blocked") return { ...recovered, phase: "seal" };
      return { status: "ready", state: recovered.state };
    }
    const pendingPublication = readBundlePublicationCheckpoint(this.storage);
    if (pendingPublication.status === "invalid") {
      return { status: "blocked", phase: "publication", reason: "local-checkpoint-invalid" };
    }
    if (pendingPublication.status === "ready") {
      const recovered = await this.runBundlePublication(
        lifecycleTransport,
        pendingPublication.checkpoint.command,
      );
      if (recovered.status === "uncertain") {
        return { status: "uncertain", phase: "publication" };
      }
      if (recovered.status === "blocked") return { ...recovered, phase: "publication" };
      if (!await revalidateLegacyBundleSource(input.revalidateSource)) {
        return { status: "blocked", phase: "seal", reason: "source-changed" };
      }
      return this.finalizePublishedGenerationBundle(
        lifecycleTransport,
        recovered.state,
        pendingPublication.checkpoint.command.pluginId,
        pendingPublication.checkpoint.command.generation,
        input.at,
      );
    }
    const inputLifecycle = input.control.pluginsById[input.pluginId];
    if (communityPluginAuthoritativePublishedBundleV1(inputLifecycle)) {
      return { status: "ready", state: structuredClone(input.control) };
    }
    const inputGeneration = inputLifecycle?.currentGeneration;
    if (
      inputLifecycle?.legacyAuthoritySeal
      && inputGeneration
      && inputLifecycle.legacyAuthoritySeal.generation >= inputGeneration.generation
    ) {
      return {
        status: "blocked",
        phase: "publication",
        reason: "publication-changed",
      };
    }
    const granted = createCommunityPluginGenerationContentGrantV1({
      control: input.control,
      scope: input.control.scope,
      participant: identity.participant,
      pluginId: input.pluginId,
    });
    if (granted.status !== "ready") {
      return { status: "blocked", phase: "staging", reason: granted.reason };
    }
    const staged = await stageCommunityPluginGenerationBundleV1({
      transport: contentTransport,
      grant: granted.grant,
      control: input.control,
      files: input.files,
    });
    if (staged.status !== "ready") return { ...staged, phase: "staging" };

    let publicationCommand: Extract<
      CommunityPluginLifecycleCommandV1,
      { type: "publish-plugin-bundle" }
    >;
    try {
      const command = await createCommunityPluginBundlePublicationCommandV1({
        grant: granted.grant,
        control: input.control,
        prepared: staged.receipt.prepared,
        manifestObject: staged.receipt.manifestObject,
        operationId: createIndexedDbVaultInstanceId(),
        at: input.at,
      });
      if (command.type !== "publish-plugin-bundle") throw new Error("unexpected command");
      publicationCommand = command;
    } catch {
      return {
        status: "blocked",
        phase: "publication",
        reason: "publication-command-invalid",
      };
    }
    const currentPublished = input.control.pluginsById[input.pluginId]
      ?.currentGeneration?.publishedBundle;
    const published = currentPublished
      && currentPublished.publisher.participantId === identity.participant.participantId
      && currentPublished.publisher.incarnation === identity.participant.incarnation
      && currentPublished.publisherJoinNonce === granted.grant.joinNonce
      && currentPublished.publishedFenceEpoch === granted.grant.fenceEpoch
      && sameManifestObject(
        currentPublished.manifestObject,
        staged.receipt.manifestObject,
      )
      ? {
        status: "ready" as const,
        state: structuredClone(input.control),
      }
      : await this.runBundlePublication(
        lifecycleTransport,
        publicationCommand,
      );
    if (published.status === "uncertain") {
      return { status: "uncertain", phase: "publication" };
    }
    if (published.status === "blocked") {
      return { ...published, phase: "publication" };
    }
    if (!await revalidateLegacyBundleSource(input.revalidateSource)) {
      return { status: "blocked", phase: "seal", reason: "source-changed" };
    }
    return this.finalizePublishedGenerationBundle(
      lifecycleTransport,
      published.state,
      input.pluginId,
      granted.grant.generation,
      input.at,
    );
  }

  private async finalizePublishedGenerationBundle(
    lifecycleTransport: CommunityPluginLifecycleCloudTransportV1,
    state: Readonly<CommunityPluginLifecycleControlV1>,
    pluginId: string,
    generation: number,
    at: number,
  ): Promise<CommunityPluginLegacyBundleMigrationResultV1> {
    const lifecycle = state.pluginsById[pluginId];
    const current = lifecycle?.currentGeneration;
    if (!current || current.generation !== generation || !current.publishedBundle) {
      return { status: "blocked", phase: "publication", reason: "publication-missing" };
    }
    const seal = lifecycle.legacyAuthoritySeal;
    if (!seal) {
      return this.sealPublishedLegacyBundle(
        lifecycleTransport,
        state,
        pluginId,
        generation,
        at,
      );
    }
    if (seal.generation < generation) {
      return { status: "ready", state: structuredClone(state) };
    }
    return {
      status: "blocked",
      phase: "publication",
      reason: "publication-changed",
    };
  }

  private async sealPublishedLegacyBundle(
    lifecycleTransport: CommunityPluginLifecycleCloudTransportV1,
    state: Readonly<CommunityPluginLifecycleControlV1>,
    pluginId: string,
    generation: number,
    at: number,
  ): Promise<CommunityPluginLegacyBundleMigrationResultV1> {
    const publishedBundle = state.pluginsById[pluginId]
      ?.currentGeneration?.publishedBundle;
    if (!publishedBundle) {
      return { status: "blocked", phase: "publication", reason: "publication-missing" };
    }
    const sealed = await this.runControlMutation(
      lifecycleTransport,
      {
        type: "seal-plugin-legacy-authority",
        scope: { ...state.scope },
        pluginId,
        generation,
        publishedBundle,
        at,
      },
      true,
    );
    if (sealed.status === "uncertain") return { status: "uncertain", phase: "seal" };
    if (sealed.status === "blocked") return { ...sealed, phase: "seal" };
    return { status: "ready", state: sealed.state };
  }

  private async runControlMutation(
    transport: CommunityPluginLifecycleCloudTransportV1,
    request: Readonly<DeviceControlMutationRequestV1>,
    allowFreshRetry: boolean,
  ): Promise<CommunityPluginLifecycleDeviceControlMutationResultV1> {
    const pending = readControlMutationCheckpoint(this.storage);
    if (pending.status === "invalid") {
      return { status: "blocked", reason: "local-checkpoint-invalid" };
    }
    if (
      pending.status === "ready"
      && !sameSyncScope(pending.checkpoint.command.scope, request.scope)
    ) return { status: "blocked", reason: "pending-scope-mismatch" };
    if (
      pending.status === "ready"
      && pending.checkpoint.command.type !== request.type
    ) return { status: "blocked", reason: "local-checkpoint-conflict" };
    const identity = readCommunityPluginLifecycleDeviceIdentityV1(this.storage);
    if (!identity || identity.vaultInstanceId !== this.vaultInstanceId) {
      return { status: "blocked", reason: "local-identity-unavailable" };
    }
    if (pending.status === "ready") {
      const owner = controlMutationOwner(pending.checkpoint.command);
      if (
        owner.participantId !== identity.participant.participantId
        || owner.incarnation !== identity.participant.incarnation
      ) return { status: "blocked", reason: "local-checkpoint-conflict" };
    }
    const operationId = pending.status === "ready"
      ? pending.checkpoint.command.operationId
      : createIndexedDbVaultInstanceId();
    const writer = {
      persist: async (checkpoint: CommunityPluginLifecycleControlMutationCheckpointV1) => {
        persistControlMutationCheckpoint(this.storage, checkpoint);
      },
    };
    const result = request.type === "join-plugin"
      ? await joinCommunityPluginGenerationV1(
        transport,
        pending.status === "ready"
          ? generationJoinInputFromCheckpoint(pending.checkpoint)
          : {
            scope: { ...request.scope },
            participant: { ...identity.participant },
            pluginId: request.pluginId,
            targetGeneration: request.targetGeneration,
            joinNonce: request.joinNonce,
            joinEvidence: request.joinEvidence,
            ...(request.observedClosedRevision === undefined
              ? {}
              : { observedClosedRevision: request.observedClosedRevision }),
            operationId,
            joinedAt: request.at,
          },
        pending.status === "ready" ? pending.checkpoint : null,
        writer,
      )
      : request.type === "confirm-legacy-migration"
      ? await confirmCommunityPluginLegacyMigrationV1(
        transport,
        pending.status === "ready"
          ? confirmationInputFromCheckpoint(pending.checkpoint)
          : {
            scope: { ...request.scope },
            actor: { ...identity.participant },
            operationId,
            confirmedAt: request.at,
            evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
          },
        pending.status === "ready" ? pending.checkpoint : null,
        writer,
      )
      : await sealCommunityPluginLegacyAuthorityV1(
        transport,
        pending.status === "ready"
          ? sealInputFromCheckpoint(pending.checkpoint)
          : {
            scope: { ...request.scope },
            actor: { ...identity.participant },
            pluginId: request.pluginId,
            generation: request.generation,
            publishedBundle: structuredClone(request.publishedBundle),
            operationId,
            sealedAt: request.at,
          },
        pending.status === "ready" ? pending.checkpoint : null,
        writer,
      );
    if (result.status === "ready") {
      try {
        clearControlMutationCheckpoint(this.storage);
      } catch {
        return { status: "blocked", reason: "local-checkpoint-clear-failed" };
      }
      return result;
    }
    if (result.status === "uncertain") return result;
    const persistedAfterBlock = readControlMutationCheckpoint(this.storage);
    if (
      allowFreshRetry
      && (result.reason === "revision-mismatch" || result.reason === "write-race")
      && persistedAfterBlock.status === "ready"
    ) {
      try {
        clearControlMutationCheckpoint(this.storage);
      } catch {
        return { status: "blocked", reason: "local-checkpoint-conflict" };
      }
      return this.runControlMutation(
        transport,
        request,
        false,
      );
    }
    return result;
  }

  private async runBundlePublication(
    transport: CommunityPluginLifecycleCloudTransportV1,
    requested: Readonly<Extract<
      CommunityPluginLifecycleCommandV1,
      { type: "publish-plugin-bundle" }
    >>,
  ): Promise<CommunityPluginLifecycleDeviceBundlePublicationResultV1> {
    const pending = readBundlePublicationCheckpoint(this.storage);
    if (pending.status === "invalid") {
      return { status: "blocked", reason: "local-checkpoint-invalid" };
    }
    if (
      pending.status === "ready"
      && !sameSyncScope(pending.checkpoint.command.scope, requested.scope)
    ) return { status: "blocked", reason: "pending-scope-mismatch" };
    const command = pending.status === "ready"
      ? pending.checkpoint.command
      : structuredClone(requested);
    const identity = readCommunityPluginLifecycleDeviceIdentityV1(this.storage);
    if (!identity || identity.vaultInstanceId !== this.vaultInstanceId) {
      return { status: "blocked", reason: "local-identity-unavailable" };
    }
    if (
      command.participant.participantId !== identity.participant.participantId
      || command.participant.incarnation !== identity.participant.incarnation
    ) return { status: "blocked", reason: "local-checkpoint-conflict" };

    const result = await publishCommunityPluginBundleSelectionV1(
      transport,
      command,
      pending.status === "ready" ? pending.checkpoint : null,
      {
        persist: async (checkpoint) => {
          persistBundlePublicationCheckpoint(this.storage, checkpoint);
        },
      },
    );
    if (result.status === "ready") {
      try {
        clearBundlePublicationCheckpoint(this.storage);
      } catch {
        return { status: "blocked", reason: "local-checkpoint-clear-failed" };
      }
      return result;
    }
    if (
      result.status === "blocked"
      && (result.reason === "revision-mismatch" || result.reason === "write-race")
      && readBundlePublicationCheckpoint(this.storage).status === "ready"
    ) {
      try {
        clearBundlePublicationCheckpoint(this.storage);
      } catch {
        return { status: "blocked", reason: "local-checkpoint-conflict" };
      }
    }
    return result;
  }

  private async runObservation(
    transport: CommunityPluginLifecycleCloudTransportV1,
    scope: SyncScope,
    observedAt: number,
    allowFreshRetry: boolean,
  ): Promise<CommunityPluginLifecycleDeviceObservationResultV1> {
    const pending = readObservationCheckpoint(this.storage);
    if (pending.status === "invalid") {
      return { status: "blocked", reason: "local-checkpoint-invalid" };
    }
    if (
      pending.status === "ready"
      && !sameSyncScope(pending.checkpoint.command.scope, scope)
    ) {
      return { status: "blocked", reason: "pending-scope-mismatch" };
    }

    const identity = pending.status === "ready"
      ? identityFromCheckpoint(pending.checkpoint, this.vaultInstanceId)
      : loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
        this.storage,
        this.vaultInstanceId,
        observedAt,
      );
    if (!identity) return { status: "blocked", reason: "local-identity-unavailable" };

    const input = pending.status === "ready"
      ? inputFromCheckpoint(pending.checkpoint)
      : createObservationInput(identity.participant, scope, observedAt);
    const result = await publishCommunityPluginParticipantObservationV1(
      transport,
      input,
      pending.status === "ready" ? pending.checkpoint : null,
      {
        persist: async (checkpoint) => {
          persistObservationCheckpoint(this.storage, checkpoint);
        },
      },
    );

    if (result.status === "ready") {
      try {
        clearObservationCheckpoint(this.storage);
      } catch {
        const unresolved = readObservationCheckpoint(this.storage);
        return unresolved.status === "ready"
          ? { status: "uncertain", checkpoint: unresolved.checkpoint }
          : { status: "blocked", reason: "local-checkpoint-clear-failed" };
      }
      if (pending.status === "none") {
        noteSuccessfulObservation(
          this.storage,
          identity,
          input.observedAt,
        );
      }
      return result;
    }
    if (result.status === "uncertain") return result;

    const persistedAfterBlock = readObservationCheckpoint(this.storage);
    if (
      allowFreshRetry
      && isDefinitivelyNotApplied(result.reason)
      && (
        result.reason === "participant-retired"
        || persistedAfterBlock.status === "ready"
      )
    ) {
      try {
        if (persistedAfterBlock.status === "ready") {
          clearObservationCheckpoint(this.storage);
        }
        if (result.reason === "participant-retired") {
          rotateCommunityPluginLifecycleDeviceIncarnationV1(
            this.storage,
            identity,
            observedAt,
          );
        }
      } catch {
        return { status: "blocked", reason: "local-checkpoint-conflict" };
      }
      return this.runObservation(transport, scope, observedAt, false);
    }
    return result;
  }
}

async function revalidateLegacyBundleSource(
  revalidate: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!revalidate) return true;
  try {
    return await revalidate();
  } catch {
    return false;
  }
}

export function loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
  storage: VaultLocalStorage,
  vaultInstanceId: string,
  createdAt: number,
): CommunityPluginLifecycleDeviceIdentityV1 | null {
  if (!isIndexedDbVaultInstanceId(vaultInstanceId) || !isTime(createdAt)) return null;
  try {
    const current = readCommunityPluginLifecycleDeviceIdentityV1(storage);
    if (current?.vaultInstanceId === vaultInstanceId) return current;
    const created: CommunityPluginLifecycleDeviceIdentityV1 = {
      schemaVersion: 1,
      kind: "community-plugin-lifecycle-device",
      vaultInstanceId,
      participant: {
        participantId: createIndexedDbVaultInstanceId(),
        incarnation: createIndexedDbVaultInstanceId(),
      },
      createdAt,
      lastSuccessfulObservationAt: null,
    };
    storage.saveLocalStorage(COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY, created);
    const verified = readCommunityPluginLifecycleDeviceIdentityV1(storage);
    return sameDeviceIdentity(verified, created) ? verified : null;
  } catch {
    return null;
  }
}

export function readCommunityPluginLifecycleDeviceIdentityV1(
  storage: VaultLocalStorage,
): CommunityPluginLifecycleDeviceIdentityV1 | null {
  try {
    const value = storage.loadLocalStorage(COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY);
    return isCommunityPluginLifecycleDeviceIdentityV1(value) ? value : null;
  } catch {
    return null;
  }
}

export function isCommunityPluginLifecycleDeviceIdentityV1(
  value: unknown,
): value is CommunityPluginLifecycleDeviceIdentityV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === "community-plugin-lifecycle-device"
    && isIndexedDbVaultInstanceId(value.vaultInstanceId)
    && isCommunityPluginParticipantIdentityV1(value.participant)
    && isTime(value.createdAt)
    && (
      value.lastSuccessfulObservationAt === null
      || (
        isTime(value.lastSuccessfulObservationAt)
        && value.lastSuccessfulObservationAt >= value.createdAt
      )
    );
}

function rotateCommunityPluginLifecycleDeviceIncarnationV1(
  storage: VaultLocalStorage,
  current: CommunityPluginLifecycleDeviceIdentityV1,
  createdAt: number,
): CommunityPluginLifecycleDeviceIdentityV1 {
  const next: CommunityPluginLifecycleDeviceIdentityV1 = {
    ...current,
    participant: {
      participantId: current.participant.participantId,
      incarnation: createIndexedDbVaultInstanceId(),
    },
    createdAt,
    lastSuccessfulObservationAt: null,
  };
  storage.saveLocalStorage(COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY, next);
  const verified = readCommunityPluginLifecycleDeviceIdentityV1(storage);
  if (!sameDeviceIdentity(verified, next)) {
    throw new Error("Community-plugin lifecycle device incarnation was not persisted");
  }
  return verified;
}

function readObservationCheckpoint(
  storage: VaultLocalStorage,
): LocalCheckpointReadResult<CommunityPluginLifecycleObservationCheckpointV1> {
  return readLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
    isCommunityPluginLifecycleObservationCheckpointV1,
  );
}

function readControlMutationCheckpoint(
  storage: VaultLocalStorage,
): LocalCheckpointReadResult<CommunityPluginLifecycleControlMutationCheckpointV1> {
  return readLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    isCommunityPluginLifecycleControlMutationCheckpointV1,
  );
}

function readBundlePublicationCheckpoint(
  storage: VaultLocalStorage,
): LocalCheckpointReadResult<CommunityPluginBundlePublicationCheckpointV1> {
  return readLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY,
    isCommunityPluginBundlePublicationCheckpointV1,
  );
}

function persistBundlePublicationCheckpoint(
  storage: VaultLocalStorage,
  checkpoint: Readonly<CommunityPluginBundlePublicationCheckpointV1>,
): void {
  persistLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY,
    checkpoint,
    isCommunityPluginBundlePublicationCheckpointV1,
    "community plugin bundle publication",
  );
}

function clearBundlePublicationCheckpoint(storage: VaultLocalStorage): void {
  clearLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY,
    isCommunityPluginBundlePublicationCheckpointV1,
    "community plugin bundle publication",
  );
}

function persistControlMutationCheckpoint(
  storage: VaultLocalStorage,
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
): void {
  persistLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    checkpoint,
    isCommunityPluginLifecycleControlMutationCheckpointV1,
    "lifecycle control mutation",
  );
}

function clearControlMutationCheckpoint(storage: VaultLocalStorage): void {
  clearLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    isCommunityPluginLifecycleControlMutationCheckpointV1,
    "lifecycle control mutation",
  );
}

function persistObservationCheckpoint(
  storage: VaultLocalStorage,
  checkpoint: Readonly<CommunityPluginLifecycleObservationCheckpointV1>,
): void {
  persistLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
    checkpoint,
    isCommunityPluginLifecycleObservationCheckpointV1,
    "lifecycle observation",
  );
}

function clearObservationCheckpoint(storage: VaultLocalStorage): void {
  clearLocalCheckpoint(
    storage,
    COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
    isCommunityPluginLifecycleObservationCheckpointV1,
    "lifecycle observation",
  );
}

function readLocalCheckpoint<Checkpoint>(
  storage: VaultLocalStorage,
  key: string,
  isCheckpoint: (value: unknown) => value is Checkpoint,
): LocalCheckpointReadResult<Checkpoint> {
  try {
    const value = storage.loadLocalStorage(key);
    if (value === null || value === undefined) return { status: "none" };
    return isCheckpoint(value)
      ? { status: "ready", checkpoint: value }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

function persistLocalCheckpoint<Checkpoint>(
  storage: VaultLocalStorage,
  key: string,
  checkpoint: Readonly<Checkpoint>,
  isCheckpoint: (value: unknown) => value is Checkpoint,
  label: string,
): void {
  const current = readLocalCheckpoint(storage, key, isCheckpoint);
  if (
    current.status === "invalid"
    || (current.status === "ready" && !sameCheckpoint(current.checkpoint, checkpoint))
  ) throw new Error(`A different ${label} is still pending`);
  if (current.status === "ready") return;
  storage.saveLocalStorage(key, structuredClone(checkpoint));
  const verified = readLocalCheckpoint(storage, key, isCheckpoint);
  if (verified.status !== "ready" || !sameCheckpoint(verified.checkpoint, checkpoint)) {
    throw new Error(`${label} checkpoint was not persisted`);
  }
}

function clearLocalCheckpoint<Checkpoint>(
  storage: VaultLocalStorage,
  key: string,
  isCheckpoint: (value: unknown) => value is Checkpoint,
  label: string,
): void {
  const current = readLocalCheckpoint(storage, key, isCheckpoint);
  if (current.status === "invalid") throw new Error(`${label} checkpoint is invalid`);
  if (current.status === "none") return;
  storage.saveLocalStorage(key, null);
  if (readLocalCheckpoint(storage, key, isCheckpoint).status !== "none") {
    throw new Error(`${label} checkpoint was not cleared`);
  }
}

function clearExactLocalCheckpoint<Checkpoint>(
  storage: VaultLocalStorage,
  key: string,
  expected: Readonly<Checkpoint>,
  isCheckpoint: (value: unknown) => value is Checkpoint,
  label: string,
): void {
  const current = readLocalCheckpoint(storage, key, isCheckpoint);
  if (current.status === "invalid") throw new Error(`${label} checkpoint is invalid`);
  if (current.status === "none") return;
  if (!sameCheckpoint(current.checkpoint, expected)) {
    throw new Error(`A different ${label} is still pending`);
  }
  clearLocalCheckpoint(storage, key, isCheckpoint, label);
}

function createObservationInput(
  participant: CommunityPluginParticipantIdentityV1,
  scope: SyncScope,
  observedAt: number,
): CommunityPluginParticipantObservationInputV1 {
  return {
    participant: { ...participant },
    scope: { ...scope },
    operationId: createIndexedDbVaultInstanceId(),
    observedAt,
  };
}

function confirmationInputFromCheckpoint(
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
): CommunityPluginLegacyMigrationConfirmationInputV1 {
  const command = checkpoint.command;
  if (command.type !== "confirm-legacy-migration") {
    throw new Error("Pending lifecycle command is not a migration confirmation");
  }
  return {
    scope: { ...command.scope },
    actor: { ...command.actor },
    operationId: command.operationId,
    confirmedAt: command.at,
    evidence: command.evidence,
  };
}

function generationJoinInputFromCheckpoint(
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
): CommunityPluginGenerationJoinInputV1 {
  const command = checkpoint.command;
  if (command.type !== "join-plugin") {
    throw new Error("Pending lifecycle mutation is not a plugin join");
  }
  return {
    scope: { ...command.scope },
    participant: { ...command.participant },
    pluginId: command.pluginId,
    targetGeneration: command.targetGeneration,
    joinNonce: command.joinNonce,
    joinEvidence: command.joinEvidence,
    ...(command.observedClosedRevision === undefined
      ? {}
      : { observedClosedRevision: command.observedClosedRevision }),
    operationId: command.operationId,
    joinedAt: command.at,
  };
}

function controlMutationOwner(
  command: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1["command"]>,
): CommunityPluginParticipantIdentityV1 {
  return command.type === "join-plugin" || command.type === "exit-plugin"
    ? command.participant
    : command.actor;
}

function sealInputFromCheckpoint(
  checkpoint: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1>,
): CommunityPluginLegacyAuthoritySealInputV1 {
  const command = checkpoint.command;
  if (command.type !== "seal-plugin-legacy-authority") {
    throw new Error("Pending lifecycle command is not a legacy authority seal");
  }
  return {
    scope: { ...command.scope },
    actor: { ...command.actor },
    pluginId: command.pluginId,
    generation: command.generation,
    publishedBundle: structuredClone(command.publishedBundle),
    operationId: command.operationId,
    sealedAt: command.at,
  };
}

function inputFromCheckpoint(
  checkpoint: Readonly<CommunityPluginLifecycleObservationCheckpointV1>,
): CommunityPluginParticipantObservationInputV1 {
  return {
    participant: { ...checkpoint.command.participant },
    scope: { ...checkpoint.command.scope },
    operationId: checkpoint.command.operationId,
    observedAt: checkpoint.command.at,
  };
}

function identityFromCheckpoint(
  checkpoint: Readonly<CommunityPluginLifecycleObservationCheckpointV1>,
  vaultInstanceId: string,
): CommunityPluginLifecycleDeviceIdentityV1 | null {
  if (!isIndexedDbVaultInstanceId(vaultInstanceId)) return null;
  return {
    schemaVersion: 1,
    kind: "community-plugin-lifecycle-device",
    vaultInstanceId,
    participant: { ...checkpoint.command.participant },
    createdAt: checkpoint.command.at,
    lastSuccessfulObservationAt: null,
  };
}

function isDefinitivelyNotApplied(reason: string): boolean {
  return reason === "revision-mismatch"
    || reason === "write-race"
    || reason === "participant-retired";
}

function sameCheckpoint(
  left: unknown,
  right: unknown,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanupCheckpointCanAdvance(
  current: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
  next: Readonly<CommunityPluginGenerationCleanupCheckpointV1>,
): boolean {
  return current.snapshotDigest === next.snapshotDigest
    && current.pluginId === next.pluginId
    && current.generation === next.generation
    && sameCheckpoint(current.snapshot, next.snapshot)
    && current.startedAt === next.startedAt
    && current.objectConfirmations.length <= next.objectConfirmations.length
    && current.objectConfirmations.every((confirmation, index) =>
      sameCheckpoint(confirmation, next.objectConfirmations[index])
    );
}

function isDeviceLifecycleTransition(
  command: Readonly<CommunityPluginLifecycleControlMutationCheckpointV1["command"]>,
): command is CommunityPluginLifecycleDeviceTransitionCommandV1 {
  return command.type === "exit-plugin"
    || command.type === "retire-participant"
    || command.type === "begin-close";
}

function sameManifestObject(
  left: CommunityPluginPublishedBundleV1["manifestObject"],
  right: CommunityPluginPublishedBundleV1["manifestObject"],
): boolean {
  return left.objectPath === right.objectPath
    && left.remoteId === right.remoteId
    && left.parentId === right.parentId
    && left.size === right.size
    && left.eTag === right.eTag
    && left.cTag === right.cTag
    && left.sha256Hash === right.sha256Hash;
}

function sameDeviceIdentity(
  left: CommunityPluginLifecycleDeviceIdentityV1 | null,
  right: CommunityPluginLifecycleDeviceIdentityV1,
): left is CommunityPluginLifecycleDeviceIdentityV1 {
  return left !== null
    && left.vaultInstanceId === right.vaultInstanceId
    && left.participant.participantId === right.participant.participantId
    && left.participant.incarnation === right.participant.incarnation
    && left.createdAt === right.createdAt
    && left.lastSuccessfulObservationAt === right.lastSuccessfulObservationAt;
}

function noteSuccessfulObservation(
  storage: VaultLocalStorage,
  expected: Readonly<CommunityPluginLifecycleDeviceIdentityV1>,
  observedAt: number,
): void {
  try {
    const current = readCommunityPluginLifecycleDeviceIdentityV1(storage);
    if (!sameDeviceIdentity(current, expected)) return;
    const next: CommunityPluginLifecycleDeviceIdentityV1 = {
      ...current,
      lastSuccessfulObservationAt: observedAt,
    };
    storage.saveLocalStorage(COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY, next);
  } catch {
    // The cloud observation is already proven. A missing local throttle marker
    // only causes a later harmless re-observation; it must not change sync.
  }
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
