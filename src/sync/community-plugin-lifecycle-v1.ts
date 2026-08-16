import { isRecord } from "../obsidian-compat";
import { isSyncScope, sameSyncScope, type SyncScope } from "./types";

/**
 * S6-S8 pure control model for a shared community-plugin lifecycle.
 * It performs no Graph, Vault or persistence I/O and cannot authorize cleanup.
 * `complete-close` only records an externally verified receipt; S8/S9 must supply
 * generation isolation and a crash-safe cleanup transaction before runtime wiring.
 */
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface CommunityPluginParticipantIdentityV1 {
  participantId: string;
  incarnation: string;
}

export interface CommunityPluginParticipantV1 {
  identity: CommunityPluginParticipantIdentityV1;
  registeredAt: number;
  lastObservedAt: number;
  registeredFenceEpoch: number;
  retiredAt?: number;
  retiredFenceEpoch?: number;
  lastOperationId?: string;
  lastOperationFingerprint?: string;
}

export interface CommunityPluginGenerationMemberV1 {
  identity: CommunityPluginParticipantIdentityV1;
  phase: "joined" | "exited";
  joinNonce: string;
  joinEvidence: "host-install" | "user-confirmed";
  joinedAt: number;
  joinedFenceEpoch: number;
  exitedAt?: number;
}

export interface CommunityPluginClosingV1 {
  owner: CommunityPluginParticipantIdentityV1;
  startedAt: number;
  startedRevision: number;
  fenceEpoch: number;
  memberKeys: string[];
}

export interface CommunityPluginClosedV1 extends CommunityPluginClosingV1 {
  closedAt: number;
  cleanupReceiptDigest: string;
}

export interface CommunityPluginGenerationV1 {
  generation: number;
  phase: "open" | "closing" | "closed";
  openedAt: number;
  membersByKey: Record<string, CommunityPluginGenerationMemberV1>;
  publishedBundle?: CommunityPluginPublishedBundleV1;
  closing?: CommunityPluginClosingV1;
  closed?: CommunityPluginClosedV1;
}

/** Exact Graph identity of one immutable, content-addressed bundle manifest. */
export interface CommunityPluginPublishedManifestObjectV1 {
  objectPath: string;
  remoteId: string;
  parentId: string;
  size: number;
  eTag: string;
  cTag: string;
  sha256Hash: string;
}

/**
 * The only current-content pointer for one open generation. The referenced
 * manifest is created and hash-verified outside this reducer before CAS.
 */
export interface CommunityPluginPublishedBundleV1 {
  publicationRevision: number;
  publisher: CommunityPluginParticipantIdentityV1;
  publisherJoinNonce: string;
  publishedAt: number;
  publishedFenceEpoch: number;
  manifestObject: CommunityPluginPublishedManifestObjectV1;
}

export interface CommunityPluginClosedTombstoneV1 {
  generation: number;
  closedAt: number;
  fenceEpoch: number;
  cleanupReceiptDigest: string;
}

export interface CommunityPluginLifecycleV1 {
  pluginId: string;
  generationHighWatermark: number;
  currentGeneration: CommunityPluginGenerationV1 | null;
  closedTombstones: CommunityPluginClosedTombstoneV1[];
  /**
   * Irreversible proof that this plugin's generation content has replaced its
   * legacy fixed path as the only current authority. Absence means the fixed
   * path must continue to use the existing sync behavior.
   */
  legacyAuthoritySeal?: CommunityPluginLegacyAuthoritySealV1;
}

export interface CommunityPluginLegacyAuthoritySealV1 {
  generation: number;
  sealedBy: CommunityPluginParticipantIdentityV1;
  sealedAt: number;
  sealedRevision: number;
  sealedFenceEpoch: number;
  consentRevision: number;
  publishedBundle: CommunityPluginPublishedBundleV1;
}

/**
 * Resolve the authoritative bundle for the current generation after the
 * plugin's legacy fixed path has been retired. The legacy seal is permanent:
 * its own generation keeps the exact sealed snapshot, while later generations
 * use their independently CAS-published current pointer without rewriting the
 * original cutoff proof.
 */
export function communityPluginAuthoritativePublishedBundleV1(
  lifecycle: Readonly<CommunityPluginLifecycleV1> | null | undefined,
): Readonly<CommunityPluginPublishedBundleV1> | null {
  const generation = lifecycle?.currentGeneration;
  const published = generation?.publishedBundle;
  const seal = lifecycle?.legacyAuthoritySeal;
  if (!generation || !published || !seal) return null;
  if (seal.generation > generation.generation) return null;
  if (
    seal.generation === generation.generation
    && !sameCommunityPluginPublishedBundleV1(published, seal.publishedBundle)
  ) return null;
  return published;
}

/**
 * One-way user authorization to stop treating unknown public-version devices
 * as trusted writers for legacy fixed plugin paths. This confirmation does not
 * switch any plugin by itself; S8 must still publish and seal each plugin
 * independently before generation content becomes authoritative.
 */
export interface CommunityPluginLegacyMigrationConsentV1 {
  confirmedBy: CommunityPluginParticipantIdentityV1;
  confirmedAt: number;
  confirmedRevision: number;
  confirmedFenceEpoch: number;
  evidence: "user-confirmed-legacy-devices-upgraded-or-retired";
}

export interface CommunityPluginLifecycleControlV1 {
  /**
   * Version 1 is the observation-only development schema. Version 2 adds the
   * explicit, irreversible legacy-writer migration consent. Existing version 1
   * objects remain readable and are upgraded only by that explicit command.
   */
  schemaVersion: 1 | 2;
  kind: "community-plugin-lifecycle-control";
  scope: SyncScope;
  revision: number;
  fenceEpoch: number;
  participantsByKey: Record<string, CommunityPluginParticipantV1>;
  pluginsById: Record<string, CommunityPluginLifecycleV1>;
  legacyMigrationConsent?: CommunityPluginLegacyMigrationConsentV1 | null;
}

interface CommandBase {
  operationId: string;
  expectedRevision: number;
  scope: SyncScope;
  at: number;
}

export type CommunityPluginLifecycleCommandV1 =
  | (CommandBase & {
    type: "register-participant";
    participant: CommunityPluginParticipantIdentityV1;
  })
  | (CommandBase & {
    type: "observe-participant";
    participant: CommunityPluginParticipantIdentityV1;
  })
  | (CommandBase & {
    type: "join-plugin";
    participant: CommunityPluginParticipantIdentityV1;
    pluginId: string;
    targetGeneration: number;
    joinNonce: string;
    joinEvidence: "host-install" | "user-confirmed";
    observedClosedRevision?: number;
  })
  | (CommandBase & {
    type: "exit-plugin";
    participant: CommunityPluginParticipantIdentityV1;
    pluginId: string;
    generation: number;
  })
  | (CommandBase & {
    type: "publish-plugin-bundle";
    participant: CommunityPluginParticipantIdentityV1;
    pluginId: string;
    generation: number;
    joinNonce: string;
    fenceEpoch: number;
    manifestObject: CommunityPluginPublishedManifestObjectV1;
  })
  | (CommandBase & {
    type: "confirm-legacy-migration";
    actor: CommunityPluginParticipantIdentityV1;
    evidence: "user-confirmed-legacy-devices-upgraded-or-retired";
  })
  | (CommandBase & {
    type: "seal-plugin-legacy-authority";
    actor: CommunityPluginParticipantIdentityV1;
    pluginId: string;
    generation: number;
    publishedBundle: CommunityPluginPublishedBundleV1;
  })
  | (CommandBase & {
    type: "retire-participant";
    actor: CommunityPluginParticipantIdentityV1;
    target: CommunityPluginParticipantIdentityV1;
  })
  | (CommandBase & {
    type: "begin-close";
    actor: CommunityPluginParticipantIdentityV1;
    pluginId: string;
    generation: number;
  })
  | (CommandBase & {
    type: "complete-close";
    actor: CommunityPluginParticipantIdentityV1;
    pluginId: string;
    generation: number;
    cleanupReceiptDigest: string;
  });

export type CommunityPluginLifecycleBlockReasonV1 =
  | "invalid-command"
  | "scope-mismatch"
  | "revision-mismatch"
  | "operation-id-reused"
  | "participant-missing"
  | "participant-retired"
  | "self-retirement-forbidden"
  | "closing-owner-retirement-forbidden"
  | "plugin-generation-missing"
  | "generation-mismatch"
  | "generation-closing"
  | "generation-closed"
  | "closed-observation-required"
  | "participant-not-joined"
  | "participant-already-joined"
  | "participant-still-joined"
  | "participant-status-unknown"
  | "publication-fence-changed"
  | "publication-join-changed"
  | "publication-missing"
  | "publication-changed"
  | "legacy-migration-consent-required"
  | "legacy-migration-already-confirmed"
  | "legacy-authority-already-sealed"
  | "close-owner-mismatch";

export type CommunityPluginLifecycleReduceResultV1 =
  | { status: "applied"; state: CommunityPluginLifecycleControlV1 }
  | { status: "idempotent"; state: CommunityPluginLifecycleControlV1 }
  | {
    status: "blocked";
    reason: CommunityPluginLifecycleBlockReasonV1;
    state: CommunityPluginLifecycleControlV1;
  };

export type CommunityPluginParticipantAvailabilityV1 =
  | "active"
  | "lost"
  | "retired";

export interface CommunityPluginCloseEligibilityV1 {
  eligible: boolean;
  blockers: Array<{
    identity: CommunityPluginParticipantIdentityV1;
    reason: "still-joined" | "participant-unknown";
  }>;
}

export function createCommunityPluginLifecycleControlV1(
  scope: SyncScope,
): CommunityPluginLifecycleControlV1 {
  if (!isSyncScope(scope)) throw new Error("Community plugin lifecycle scope is invalid");
  return {
    schemaVersion: 2,
    kind: "community-plugin-lifecycle-control",
    scope: { ...scope },
    revision: 1,
    fenceEpoch: 0,
    participantsByKey: {},
    pluginsById: {},
    legacyMigrationConsent: null,
  };
}

export function communityPluginParticipantKeyV1(
  identity: CommunityPluginParticipantIdentityV1,
): string {
  return `${identity.participantId}::${identity.incarnation}`;
}

/** Relative to the vault's `.easy-sync` cloud-control directory. */
export function communityPluginPublishedManifestObjectPathV1(
  pluginId: string,
  generation: number,
  sha256Hash: string,
): string {
  if (!safePluginId(pluginId) || !positiveInteger(generation) || !SHA256.test(sha256Hash)) {
    throw new Error("Community plugin published manifest path input is invalid");
  }
  return `community-plugin-content-v1/plugins/${encodePluginId(pluginId)}`
    + `/generations/${generation}/manifests/${sha256Hash}.json`;
}

export function isCommunityPluginParticipantIdentityV1(
  value: unknown,
): value is CommunityPluginParticipantIdentityV1 {
  return isIdentity(value);
}

export function isCommunityPluginLifecycleCommandV1(
  value: unknown,
): value is CommunityPluginLifecycleCommandV1 {
  return isRecord(value)
    && typeof value.type === "string"
    && isValidCommand(value as unknown as CommunityPluginLifecycleCommandV1);
}

export function sameCommunityPluginLifecycleCommandV1(
  left: Readonly<CommunityPluginLifecycleCommandV1>,
  right: Readonly<CommunityPluginLifecycleCommandV1>,
): boolean {
  return left.operationId === right.operationId
    && commandFingerprint(left) === commandFingerprint(right);
}

export function communityPluginParticipantAvailabilityV1(
  participant: Readonly<CommunityPluginParticipantV1>,
  now: number,
  lostAfterMs: number,
): CommunityPluginParticipantAvailabilityV1 {
  if (participant.retiredAt !== undefined) return "retired";
  if (
    Number.isFinite(now)
    && Number.isFinite(lostAfterMs)
    && lostAfterMs >= 0
    && now - participant.lastObservedAt > lostAfterMs
  ) return "lost";
  return "active";
}

export function communityPluginCloseEligibilityV1(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  pluginId: string,
  generation: number,
): CommunityPluginCloseEligibilityV1 {
  const current = state.pluginsById[pluginId]?.currentGeneration;
  if (!current || current.generation !== generation || current.phase !== "open") {
    return { eligible: false, blockers: [] };
  }
  const blockers: CommunityPluginCloseEligibilityV1["blockers"] = [];
  for (const member of Object.values(current.membersByKey)) {
    if (member.phase === "exited") continue;
    const participant = state.participantsByKey[
      communityPluginParticipantKeyV1(member.identity)
    ];
    if (!participant) {
      blockers.push({ identity: member.identity, reason: "participant-unknown" });
    } else if (participant.retiredAt === undefined) {
      blockers.push({ identity: member.identity, reason: "still-joined" });
    }
  }
  return { eligible: blockers.length === 0, blockers };
}

export function reduceCommunityPluginLifecycleV1(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  command: Readonly<CommunityPluginLifecycleCommandV1>,
): CommunityPluginLifecycleReduceResultV1 {
  if (!isCommunityPluginLifecycleControlV1(state)) {
    throw new Error("Community plugin lifecycle state is invalid");
  }
  if (!isValidCommand(command)) return blocked(state, "invalid-command");
  if (!sameSyncScope(state.scope, command.scope)) return blocked(state, "scope-mismatch");
  const operationOwner = participantFor(state, commandOwner(command));
  if (operationOwner?.lastOperationId === command.operationId) {
    return operationOwner.lastOperationFingerprint === commandFingerprint(command)
      ? { status: "idempotent", state: state as CommunityPluginLifecycleControlV1 }
      : blocked(state, "operation-id-reused");
  }
  if (state.revision !== command.expectedRevision) {
    return blocked(state, "revision-mismatch");
  }

  const next = structuredClone(state) as CommunityPluginLifecycleControlV1;
  switch (command.type) {
    case "register-participant": {
      const key = communityPluginParticipantKeyV1(command.participant);
      const existing = next.participantsByKey[key];
      if (existing?.retiredAt !== undefined) return blocked(state, "participant-retired");
      if (existing) {
        existing.lastObservedAt = Math.max(existing.lastObservedAt, command.at);
      } else {
        next.participantsByKey[key] = {
          identity: { ...command.participant },
          registeredAt: command.at,
          lastObservedAt: command.at,
          registeredFenceEpoch: next.fenceEpoch,
        };
      }
      return applied(next, command);
    }
    case "observe-participant": {
      const participant = participantFor(next, command.participant);
      if (!participant) return blocked(state, "participant-missing");
      if (participant.retiredAt !== undefined) return blocked(state, "participant-retired");
      participant.lastObservedAt = Math.max(participant.lastObservedAt, command.at);
      return applied(next, command);
    }
    case "join-plugin": {
      const participant = participantFor(next, command.participant);
      if (!participant) return blocked(state, "participant-missing");
      if (participant.retiredAt !== undefined) return blocked(state, "participant-retired");
      if (command.at < participant.registeredAt) return blocked(state, "invalid-command");
      let plugin = next.pluginsById[command.pluginId];
      if (!plugin) {
        plugin = {
          pluginId: command.pluginId,
          generationHighWatermark: 0,
          currentGeneration: null,
          closedTombstones: [],
        };
        next.pluginsById[command.pluginId] = plugin;
      }
      const current = plugin.currentGeneration;
      if (current?.phase === "closing") return blocked(state, "generation-closing");
      if (current?.phase === "closed") {
        if (command.at < current.closed!.closedAt) return blocked(state, "invalid-command");
        if (command.targetGeneration !== plugin.generationHighWatermark + 1) {
          return blocked(state, "generation-mismatch");
        }
        if (command.observedClosedRevision !== state.revision) {
          return blocked(state, "closed-observation-required");
        }
        plugin.currentGeneration = openGeneration(
          plugin.generationHighWatermark + 1,
          command.at,
        );
        plugin.generationHighWatermark += 1;
      } else if (!current) {
        if (command.targetGeneration !== plugin.generationHighWatermark + 1) {
          return blocked(state, "generation-mismatch");
        }
        plugin.currentGeneration = openGeneration(
          plugin.generationHighWatermark + 1,
          command.at,
        );
        plugin.generationHighWatermark += 1;
      }
      const generationState = plugin.currentGeneration!;
      if (command.targetGeneration !== generationState.generation) {
        return blocked(state, "generation-mismatch");
      }
      if (command.at < generationState.openedAt) return blocked(state, "invalid-command");
      const key = communityPluginParticipantKeyV1(command.participant);
      if (generationState.membersByKey[key]?.phase === "joined") {
        return blocked(state, "participant-already-joined");
      }
      generationState.membersByKey[key] = {
        identity: { ...command.participant },
        phase: "joined",
        joinNonce: command.joinNonce,
        joinEvidence: command.joinEvidence,
        joinedAt: command.at,
        joinedFenceEpoch: next.fenceEpoch,
      };
      participant.lastObservedAt = Math.max(participant.lastObservedAt, command.at);
      return applied(next, command);
    }
    case "exit-plugin": {
      const participant = participantFor(next, command.participant);
      if (!participant) return blocked(state, "participant-missing");
      if (participant.retiredAt !== undefined) return blocked(state, "participant-retired");
      const generationState = currentGeneration(next, command.pluginId);
      if (!generationState) return blocked(state, "plugin-generation-missing");
      if (generationState.generation !== command.generation) {
        return blocked(state, "generation-mismatch");
      }
      if (generationState.phase === "closing") return blocked(state, "generation-closing");
      if (generationState.phase === "closed") return blocked(state, "generation-closed");
      const member = generationState.membersByKey[
        communityPluginParticipantKeyV1(command.participant)
      ];
      if (!member || member.phase !== "joined") {
        return blocked(state, "participant-not-joined");
      }
      if (command.at < member.joinedAt) return blocked(state, "invalid-command");
      member.phase = "exited";
      member.exitedAt = command.at;
      participant.lastObservedAt = Math.max(participant.lastObservedAt, command.at);
      return applied(next, command);
    }
    case "publish-plugin-bundle": {
      const participant = participantFor(next, command.participant);
      if (!participant) return blocked(state, "participant-missing");
      if (participant.retiredAt !== undefined) return blocked(state, "participant-retired");
      if (command.fenceEpoch !== next.fenceEpoch) {
        return blocked(state, "publication-fence-changed");
      }
      const generationState = currentGeneration(next, command.pluginId);
      if (!generationState) return blocked(state, "plugin-generation-missing");
      if (generationState.generation !== command.generation) {
        return blocked(state, "generation-mismatch");
      }
      if (generationState.phase === "closing") return blocked(state, "generation-closing");
      if (generationState.phase === "closed") return blocked(state, "generation-closed");
      const member = generationState.membersByKey[
        communityPluginParticipantKeyV1(command.participant)
      ];
      if (!member || member.phase !== "joined") {
        return blocked(state, "participant-not-joined");
      }
      if (member.joinNonce !== command.joinNonce) {
        return blocked(state, "publication-join-changed");
      }
      if (command.at < member.joinedAt) return blocked(state, "invalid-command");
      generationState.publishedBundle = {
        publicationRevision:
          (generationState.publishedBundle?.publicationRevision ?? 0) + 1,
        publisher: { ...command.participant },
        publisherJoinNonce: command.joinNonce,
        publishedAt: command.at,
        publishedFenceEpoch: command.fenceEpoch,
        manifestObject: { ...command.manifestObject },
      };
      participant.lastObservedAt = Math.max(participant.lastObservedAt, command.at);
      return applied(next, command);
    }
    case "confirm-legacy-migration": {
      const actor = participantFor(next, command.actor);
      if (!actor) return blocked(state, "participant-missing");
      if (actor.retiredAt !== undefined) return blocked(state, "participant-retired");
      if (command.at < actor.registeredAt) return blocked(state, "invalid-command");
      if (next.schemaVersion === 2 && next.legacyMigrationConsent !== null) {
        return blocked(state, "legacy-migration-already-confirmed");
      }
      next.schemaVersion = 2;
      next.fenceEpoch += 1;
      next.legacyMigrationConsent = {
        confirmedBy: { ...command.actor },
        confirmedAt: command.at,
        confirmedRevision: state.revision + 1,
        confirmedFenceEpoch: next.fenceEpoch,
        evidence: command.evidence,
      };
      actor.lastObservedAt = Math.max(actor.lastObservedAt, command.at);
      return applied(next, command);
    }
    case "seal-plugin-legacy-authority": {
      const actor = participantFor(next, command.actor);
      if (!actor) return blocked(state, "participant-missing");
      if (actor.retiredAt !== undefined) return blocked(state, "participant-retired");
      const consent = next.legacyMigrationConsent;
      if (next.schemaVersion !== 2 || !consent) {
        return blocked(state, "legacy-migration-consent-required");
      }
      const plugin = next.pluginsById[command.pluginId];
      const generationState = plugin?.currentGeneration;
      if (!generationState) return blocked(state, "plugin-generation-missing");
      if (generationState.generation !== command.generation) {
        return blocked(state, "generation-mismatch");
      }
      if (generationState.phase === "closing") return blocked(state, "generation-closing");
      if (generationState.phase === "closed") return blocked(state, "generation-closed");
      if (plugin.legacyAuthoritySeal !== undefined) {
        return blocked(state, "legacy-authority-already-sealed");
      }
      const published = generationState.publishedBundle;
      if (!published) return blocked(state, "publication-missing");
      if (!sameCommunityPluginPublishedBundleV1(published, command.publishedBundle)) {
        return blocked(state, "publication-changed");
      }
      if (
        published.publishedFenceEpoch !== next.fenceEpoch
        || published.publishedFenceEpoch < consent.confirmedFenceEpoch
      ) return blocked(state, "publication-fence-changed");
      const actorMember = generationState.membersByKey[
        communityPluginParticipantKeyV1(command.actor)
      ];
      if (
        !actorMember
        || actorMember.phase !== "joined"
        || !sameParticipant(published.publisher, command.actor)
        || actorMember.joinNonce !== published.publisherJoinNonce
      ) return blocked(state, "participant-not-joined");
      if (
        command.at < published.publishedAt
        || command.at < consent.confirmedAt
      ) return blocked(state, "invalid-command");
      next.fenceEpoch += 1;
      plugin.legacyAuthoritySeal = {
        generation: generationState.generation,
        sealedBy: { ...command.actor },
        sealedAt: command.at,
        sealedRevision: state.revision + 1,
        sealedFenceEpoch: next.fenceEpoch,
        consentRevision: consent.confirmedRevision,
        publishedBundle: clonePublishedBundle(published),
      };
      actor.lastObservedAt = Math.max(actor.lastObservedAt, command.at);
      return applied(next, command);
    }
    case "retire-participant": {
      if (sameParticipant(command.actor, command.target)) {
        return blocked(state, "self-retirement-forbidden");
      }
      const actor = participantFor(next, command.actor);
      const target = participantFor(next, command.target);
      if (!actor || !target) return blocked(state, "participant-missing");
      if (actor.retiredAt !== undefined || target.retiredAt !== undefined) {
        return blocked(state, "participant-retired");
      }
      if (command.at < Math.max(actor.registeredAt, target.registeredAt)) {
        return blocked(state, "invalid-command");
      }
      const targetKey = communityPluginParticipantKeyV1(command.target);
      if (Object.values(next.pluginsById).some((plugin) =>
        plugin.currentGeneration?.phase === "closing"
        && communityPluginParticipantKeyV1(
          plugin.currentGeneration.closing!.owner,
        ) === targetKey
      )) return blocked(state, "closing-owner-retirement-forbidden");
      next.fenceEpoch += 1;
      target.retiredAt = command.at;
      target.retiredFenceEpoch = next.fenceEpoch;
      actor.lastObservedAt = Math.max(actor.lastObservedAt, command.at);
      return applied(next, command);
    }
    case "begin-close": {
      const actor = participantFor(next, command.actor);
      if (!actor) return blocked(state, "participant-missing");
      if (actor.retiredAt !== undefined) return blocked(state, "participant-retired");
      const generationState = currentGeneration(next, command.pluginId);
      if (!generationState) return blocked(state, "plugin-generation-missing");
      if (generationState.generation !== command.generation) {
        return blocked(state, "generation-mismatch");
      }
      if (generationState.phase === "closing") return blocked(state, "generation-closing");
      if (generationState.phase === "closed") return blocked(state, "generation-closed");
      if (
        command.at < generationState.openedAt
        || Object.values(generationState.membersByKey).some(
          (member) => command.at < (member.exitedAt ?? member.joinedAt),
        )
      ) return blocked(state, "invalid-command");
      const actorMember = generationState.membersByKey[
        communityPluginParticipantKeyV1(command.actor)
      ];
      if (!actorMember || actorMember.phase !== "exited") {
        return blocked(state, "participant-not-joined");
      }
      const eligibility = communityPluginCloseEligibilityV1(
        next,
        command.pluginId,
        command.generation,
      );
      if (!eligibility.eligible) {
        return blocked(
          state,
          eligibility.blockers.some((entry) => entry.reason === "participant-unknown")
            ? "participant-status-unknown"
            : "participant-still-joined",
        );
      }
      generationState.phase = "closing";
      generationState.closing = {
        owner: { ...command.actor },
        startedAt: command.at,
        startedRevision: state.revision + 1,
        fenceEpoch: next.fenceEpoch,
        memberKeys: Object.keys(generationState.membersByKey).sort(),
      };
      actor.lastObservedAt = Math.max(actor.lastObservedAt, command.at);
      return applied(next, command);
    }
    case "complete-close": {
      const actor = participantFor(next, command.actor);
      if (!actor) return blocked(state, "participant-missing");
      if (actor.retiredAt !== undefined) return blocked(state, "participant-retired");
      const plugin = next.pluginsById[command.pluginId];
      const generationState = plugin?.currentGeneration;
      if (!generationState) return blocked(state, "plugin-generation-missing");
      if (generationState.generation !== command.generation) {
        return blocked(state, "generation-mismatch");
      }
      if (generationState.phase === "open") return blocked(state, "generation-closing");
      if (generationState.phase === "closed") return blocked(state, "generation-closed");
      if (command.at < generationState.closing!.startedAt) {
        return blocked(state, "invalid-command");
      }
      if (!sameParticipant(generationState.closing!.owner, command.actor)) {
        return blocked(state, "close-owner-mismatch");
      }
      const closed: CommunityPluginClosedV1 = {
        ...generationState.closing!,
        closedAt: command.at,
        cleanupReceiptDigest: command.cleanupReceiptDigest,
      };
      generationState.phase = "closed";
      generationState.closed = closed;
      plugin.closedTombstones.push({
        generation: generationState.generation,
        closedAt: command.at,
        fenceEpoch: closed.fenceEpoch,
        cleanupReceiptDigest: command.cleanupReceiptDigest,
      });
      actor.lastObservedAt = Math.max(actor.lastObservedAt, command.at);
      return applied(next, command);
    }
  }
}

export function isCommunityPluginLifecycleControlV1(
  value: unknown,
): value is CommunityPluginLifecycleControlV1 {
  if (
    !isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || value.kind !== "community-plugin-lifecycle-control"
    || !isSyncScope(value.scope)
    || !positiveInteger(value.revision)
    || !nonNegativeInteger(value.fenceEpoch)
    || !isRecord(value.participantsByKey)
    || !isRecord(value.pluginsById)
  ) return false;
  const fenceEpoch = Number(value.fenceEpoch);
  if (
    value.schemaVersion === 1
      ? value.legacyMigrationConsent !== undefined
      : !("legacyMigrationConsent" in value)
        || (value.legacyMigrationConsent !== null
          && !isLegacyMigrationConsent(value.legacyMigrationConsent))
  ) return false;
  const legacyMigrationConsent = value.schemaVersion === 2
    && value.legacyMigrationConsent !== null
    && isLegacyMigrationConsent(value.legacyMigrationConsent)
    ? value.legacyMigrationConsent
    : null;

  for (const [key, participant] of Object.entries(value.participantsByKey)) {
    if (!isParticipant(participant) || key !== communityPluginParticipantKeyV1(participant.identity)) {
      return false;
    }
    if (
      participant.registeredFenceEpoch > fenceEpoch
      || (participant.retiredFenceEpoch ?? 0) > fenceEpoch
    ) return false;
  }
  for (const [pluginId, lifecycle] of Object.entries(value.pluginsById)) {
    if (!isPluginLifecycle(lifecycle) || pluginId !== lifecycle.pluginId) return false;
    if (value.schemaVersion === 1 && lifecycle.legacyAuthoritySeal !== undefined) return false;
    for (const member of Object.values(lifecycle.currentGeneration?.membersByKey ?? {})) {
      const participant = value.participantsByKey[communityPluginParticipantKeyV1(member.identity)];
      if (
        !isParticipant(participant)
        || member.joinedFenceEpoch < participant.registeredFenceEpoch
        || member.joinedFenceEpoch > fenceEpoch
      ) return false;
    }
    const current = lifecycle.currentGeneration;
    if (
      (current?.closing?.fenceEpoch ?? 0) > fenceEpoch
      || (current?.publishedBundle?.publishedFenceEpoch ?? 0) > fenceEpoch
      || lifecycle.closedTombstones.some((entry) => entry.fenceEpoch > fenceEpoch)
    ) return false;
    const seal = lifecycle.legacyAuthoritySeal;
    if (seal !== undefined) {
      if (
        value.schemaVersion !== 2
        || legacyMigrationConsent === null
        || seal.sealedFenceEpoch > fenceEpoch
        || seal.sealedFenceEpoch <= seal.publishedBundle.publishedFenceEpoch
        || seal.consentRevision !== legacyMigrationConsent.confirmedRevision
        || seal.publishedBundle.publishedFenceEpoch
          < legacyMigrationConsent.confirmedFenceEpoch
        || seal.sealedAt < legacyMigrationConsent.confirmedAt
        || seal.sealedRevision > Number(value.revision)
      ) return false;
      const participant = value.participantsByKey[
        communityPluginParticipantKeyV1(seal.sealedBy)
      ];
      if (!isParticipant(participant) || seal.sealedAt < participant.registeredAt) return false;
    }
  }
  if (value.schemaVersion === 2 && value.legacyMigrationConsent !== null) {
    const consent = value.legacyMigrationConsent as CommunityPluginLegacyMigrationConsentV1;
    const participant = value.participantsByKey[
      communityPluginParticipantKeyV1(consent.confirmedBy)
    ];
    if (
      !isParticipant(participant)
      || consent.confirmedAt < participant.registeredAt
      || consent.confirmedRevision > Number(value.revision)
      || consent.confirmedFenceEpoch > fenceEpoch
    ) return false;
  }
  return true;
}

function applied(
  state: CommunityPluginLifecycleControlV1,
  command: CommunityPluginLifecycleCommandV1,
): CommunityPluginLifecycleReduceResultV1 {
  state.revision += 1;
  const operationOwner = participantFor(state, commandOwner(command));
  if (!operationOwner) throw new Error("Applied lifecycle command has no operation owner");
  operationOwner.lastOperationId = command.operationId;
  operationOwner.lastOperationFingerprint = commandFingerprint(command);
  return { status: "applied", state };
}

function blocked(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  reason: CommunityPluginLifecycleBlockReasonV1,
): CommunityPluginLifecycleReduceResultV1 {
  return {
    status: "blocked",
    reason,
    state: state as CommunityPluginLifecycleControlV1,
  };
}

function openGeneration(generation: number, openedAt: number): CommunityPluginGenerationV1 {
  return {
    generation,
    phase: "open",
    openedAt,
    membersByKey: {},
  };
}

function participantFor(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  identity: CommunityPluginParticipantIdentityV1,
): CommunityPluginParticipantV1 | undefined {
  return state.participantsByKey[communityPluginParticipantKeyV1(identity)];
}

function currentGeneration(
  state: Readonly<CommunityPluginLifecycleControlV1>,
  pluginId: string,
): CommunityPluginGenerationV1 | null | undefined {
  return state.pluginsById[pluginId]?.currentGeneration;
}

function sameParticipant(
  left: CommunityPluginParticipantIdentityV1,
  right: CommunityPluginParticipantIdentityV1,
): boolean {
  return left.participantId === right.participantId
    && left.incarnation === right.incarnation;
}

function commandOwner(
  command: CommunityPluginLifecycleCommandV1,
): CommunityPluginParticipantIdentityV1 {
  switch (command.type) {
    case "register-participant":
    case "observe-participant":
    case "join-plugin":
    case "exit-plugin":
    case "publish-plugin-bundle":
      return command.participant;
    case "confirm-legacy-migration":
    case "seal-plugin-legacy-authority":
    case "retire-participant":
    case "begin-close":
    case "complete-close":
      return command.actor;
  }
}

function isValidCommand(command: CommunityPluginLifecycleCommandV1): boolean {
  if (
    !safeId(command.operationId)
    || !positiveInteger(command.expectedRevision)
    || !isSyncScope(command.scope)
    || !nonNegativeNumber(command.at)
  ) return false;
  if ("participant" in command && !isIdentity(command.participant)) return false;
  if ("actor" in command && !isIdentity(command.actor)) return false;
  if ("target" in command && !isIdentity(command.target)) return false;
  if ("pluginId" in command && !safePluginId(command.pluginId)) return false;
  if ("generation" in command && !positiveInteger(command.generation)) return false;
  switch (command.type) {
    case "register-participant":
    case "observe-participant":
      return true;
    case "join-plugin":
      return positiveInteger(command.targetGeneration)
        && safeId(command.joinNonce)
        && (command.joinEvidence === "host-install" || command.joinEvidence === "user-confirmed")
        && (
          command.observedClosedRevision === undefined
          || positiveInteger(command.observedClosedRevision)
        );
    case "exit-plugin":
    case "retire-participant":
    case "begin-close":
      return true;
    case "publish-plugin-bundle":
      return safeId(command.joinNonce)
        && nonNegativeInteger(command.fenceEpoch)
        && isPublishedManifestObject(command.manifestObject)
        && command.manifestObject.objectPath
          === communityPluginPublishedManifestObjectPathV1(
            command.pluginId,
            command.generation,
            command.manifestObject.sha256Hash,
          );
    case "confirm-legacy-migration":
      return command.evidence === "user-confirmed-legacy-devices-upgraded-or-retired";
    case "seal-plugin-legacy-authority":
      return isPublishedBundle(command.publishedBundle)
        && command.publishedBundle.manifestObject.objectPath
          === communityPluginPublishedManifestObjectPathV1(
            command.pluginId,
            command.generation,
            command.publishedBundle.manifestObject.sha256Hash,
          );
    case "complete-close":
      return SHA256.test(command.cleanupReceiptDigest);
    default:
      return false;
  }
}

function isParticipant(value: unknown): value is CommunityPluginParticipantV1 {
  if (
    !isRecord(value)
    || !isIdentity(value.identity)
    || !nonNegativeNumber(value.registeredAt)
    || !nonNegativeNumber(value.lastObservedAt)
    || Number(value.lastObservedAt) < Number(value.registeredAt)
    || !nonNegativeInteger(value.registeredFenceEpoch)
    || (value.lastOperationId !== undefined && !safeId(value.lastOperationId))
    || (
      value.lastOperationFingerprint !== undefined
      && (
        typeof value.lastOperationFingerprint !== "string"
        || value.lastOperationFingerprint.length === 0
        || value.lastOperationFingerprint.length > 2_048
      )
    )
    || ((value.lastOperationId === undefined) !== (value.lastOperationFingerprint === undefined))
  ) return false;
  return value.retiredAt === undefined
    || (
      nonNegativeNumber(value.retiredAt)
      && Number(value.retiredAt) >= Number(value.registeredAt)
      && nonNegativeInteger(value.retiredFenceEpoch)
      && Number(value.retiredFenceEpoch) > Number(value.registeredFenceEpoch)
    );
}

function isPluginLifecycle(value: unknown): value is CommunityPluginLifecycleV1 {
  if (
    !isRecord(value)
    || !safePluginId(value.pluginId)
    || !nonNegativeInteger(value.generationHighWatermark)
    || !Array.isArray(value.closedTombstones)
    || (value.currentGeneration !== null
      && !isGeneration(value.currentGeneration, value.pluginId))
  ) return false;
  if (value.legacyAuthoritySeal !== undefined) {
    if (
      !isLegacyAuthoritySeal(value.legacyAuthoritySeal)
      || Number(value.legacyAuthoritySeal.generation) > Number(value.generationHighWatermark)
      || value.legacyAuthoritySeal.publishedBundle.manifestObject.objectPath
        !== communityPluginPublishedManifestObjectPathV1(
          String(value.pluginId),
          Number(value.legacyAuthoritySeal.generation),
          value.legacyAuthoritySeal.publishedBundle.manifestObject.sha256Hash,
        )
    ) return false;
  }
  let previousClosedAt = -1;
  let previousFenceEpoch = -1;
  for (const [index, tombstone] of value.closedTombstones.entries()) {
    if (
      !isRecord(tombstone)
      || !positiveInteger(tombstone.generation)
      || Number(tombstone.generation) !== index + 1
      || Number(tombstone.generation) > Number(value.generationHighWatermark)
      || !nonNegativeNumber(tombstone.closedAt)
      || Number(tombstone.closedAt) < previousClosedAt
      || !nonNegativeInteger(tombstone.fenceEpoch)
      || Number(tombstone.fenceEpoch) < previousFenceEpoch
      || typeof tombstone.cleanupReceiptDigest !== "string"
      || !SHA256.test(tombstone.cleanupReceiptDigest)
    ) return false;
    previousClosedAt = Number(tombstone.closedAt);
    previousFenceEpoch = Number(tombstone.fenceEpoch);
  }
  const current = value.currentGeneration as CommunityPluginGenerationV1 | null;
  if (!current && Number(value.generationHighWatermark) !== 0) return false;
  if (current && current.generation !== value.generationHighWatermark) return false;
  const expectedTombstoneCount = current?.phase === "closed"
    ? Number(value.generationHighWatermark)
    : Math.max(0, Number(value.generationHighWatermark) - 1);
  if (value.closedTombstones.length !== expectedTombstoneCount) return false;
  const previousGenerationTombstone = value.closedTombstones[
    current?.phase === "closed"
      ? value.closedTombstones.length - 2
      : value.closedTombstones.length - 1
  ];
  if (current && previousGenerationTombstone && current.openedAt < previousGenerationTombstone.closedAt) {
    return false;
  }
  if (current?.phase === "closed") {
    const tombstone = value.closedTombstones.find(
      (entry) => entry.generation === current.generation,
    );
    if (
      !tombstone
      || tombstone.closedAt !== current.closed!.closedAt
      || tombstone.fenceEpoch !== current.closed!.fenceEpoch
      || tombstone.cleanupReceiptDigest !== current.closed!.cleanupReceiptDigest
    ) return false;
  }
  return true;
}

function isGeneration(
  value: unknown,
  pluginId: string,
): value is CommunityPluginGenerationV1 {
  if (
    !isRecord(value)
    || !positiveInteger(value.generation)
    || !["open", "closing", "closed"].includes(String(value.phase))
    || !nonNegativeNumber(value.openedAt)
    || !isRecord(value.membersByKey)
    || Object.keys(value.membersByKey).length === 0
  ) return false;
  for (const [key, member] of Object.entries(value.membersByKey)) {
    if (!isGenerationMember(member) || key !== communityPluginParticipantKeyV1(member.identity)) {
      return false;
    }
  }
  if (value.publishedBundle !== undefined) {
    if (!isPublishedBundle(value.publishedBundle)) return false;
    const publisher = value.membersByKey[
      communityPluginParticipantKeyV1(value.publishedBundle.publisher)
    ];
    if (
      !isGenerationMember(publisher)
      || publisher.joinNonce !== value.publishedBundle.publisherJoinNonce
      || value.publishedBundle.publishedAt < publisher.joinedAt
      || value.publishedBundle.publishedAt < Number(value.openedAt)
      || value.publishedBundle.publishedFenceEpoch < publisher.joinedFenceEpoch
      || value.publishedBundle.manifestObject.objectPath
        !== communityPluginPublishedManifestObjectPathV1(
          pluginId,
          Number(value.generation),
          value.publishedBundle.manifestObject.sha256Hash,
        )
    ) return false;
  }
  if (value.phase === "open") return value.closing === undefined && value.closed === undefined;
  if (!isClosing(value.closing)) return false;
  const memberKeys = Object.keys(value.membersByKey).sort();
  if (
    value.closing.memberKeys.length !== memberKeys.length
    || value.closing.memberKeys.some((key, index) => key !== memberKeys[index])
  ) return false;
  const ownerMember = value.membersByKey[communityPluginParticipantKeyV1(value.closing.owner)];
  if (!isGenerationMember(ownerMember) || ownerMember.phase !== "exited") return false;
  return value.phase === "closing"
    ? value.closed === undefined
    : isClosed(value.closed)
      && sameClosingSnapshot(value.closing, value.closed);
}

function isGenerationMember(value: unknown): value is CommunityPluginGenerationMemberV1 {
  return isRecord(value)
    && isIdentity(value.identity)
    && (value.phase === "joined" || value.phase === "exited")
    && safeId(value.joinNonce)
    && (value.joinEvidence === "host-install" || value.joinEvidence === "user-confirmed")
    && nonNegativeNumber(value.joinedAt)
    && nonNegativeInteger(value.joinedFenceEpoch)
    && (
      value.phase === "joined"
        ? value.exitedAt === undefined
        : nonNegativeNumber(value.exitedAt) && Number(value.exitedAt) >= Number(value.joinedAt)
    );
}

function isClosing(value: unknown): value is CommunityPluginClosingV1 {
  return isRecord(value)
    && isIdentity(value.owner)
    && nonNegativeNumber(value.startedAt)
    && positiveInteger(value.startedRevision)
    && nonNegativeInteger(value.fenceEpoch)
    && Array.isArray(value.memberKeys)
    && value.memberKeys.every((key) => typeof key === "string" && key.length > 0)
    && new Set(value.memberKeys).size === value.memberKeys.length;
}

function isClosed(value: unknown): value is CommunityPluginClosedV1 {
  if (!isRecord(value) || !isClosing(value)) return false;
  return nonNegativeNumber(value.closedAt)
    && Number(value.closedAt) >= value.startedAt
    && typeof value.cleanupReceiptDigest === "string"
    && SHA256.test(value.cleanupReceiptDigest);
}

function isPublishedBundle(value: unknown): value is CommunityPluginPublishedBundleV1 {
  return isRecord(value)
    && positiveInteger(value.publicationRevision)
    && isIdentity(value.publisher)
    && safeId(value.publisherJoinNonce)
    && nonNegativeNumber(value.publishedAt)
    && nonNegativeInteger(value.publishedFenceEpoch)
    && isPublishedManifestObject(value.manifestObject);
}

function isPublishedManifestObject(
  value: unknown,
): value is CommunityPluginPublishedManifestObjectV1 {
  return isRecord(value)
    && boundedString(value.objectPath, 1_024)
    && boundedString(value.remoteId, 512)
    && boundedString(value.parentId, 512)
    && nonNegativeInteger(value.size)
    && typeof value.eTag === "string"
    && value.eTag.length <= 512
    && typeof value.cTag === "string"
    && value.cTag.length <= 512
    && Boolean(value.eTag || value.cTag)
    && typeof value.sha256Hash === "string"
    && SHA256.test(value.sha256Hash);
}

function isLegacyMigrationConsent(
  value: unknown,
): value is CommunityPluginLegacyMigrationConsentV1 {
  return isRecord(value)
    && isIdentity(value.confirmedBy)
    && nonNegativeNumber(value.confirmedAt)
    && positiveInteger(value.confirmedRevision)
    && nonNegativeInteger(value.confirmedFenceEpoch)
    && value.evidence === "user-confirmed-legacy-devices-upgraded-or-retired";
}

function isLegacyAuthoritySeal(
  value: unknown,
): value is CommunityPluginLegacyAuthoritySealV1 {
  return isRecord(value)
    && positiveInteger(value.generation)
    && isIdentity(value.sealedBy)
    && nonNegativeNumber(value.sealedAt)
    && positiveInteger(value.sealedRevision)
    && nonNegativeInteger(value.sealedFenceEpoch)
    && positiveInteger(value.consentRevision)
    && isPublishedBundle(value.publishedBundle);
}

function clonePublishedBundle(
  value: CommunityPluginPublishedBundleV1,
): CommunityPluginPublishedBundleV1 {
  return {
    ...value,
    publisher: { ...value.publisher },
    manifestObject: { ...value.manifestObject },
  };
}

export function sameCommunityPluginPublishedBundleV1(
  left: CommunityPluginPublishedBundleV1,
  right: CommunityPluginPublishedBundleV1,
): boolean {
  return left.publicationRevision === right.publicationRevision
    && sameParticipant(left.publisher, right.publisher)
    && left.publisherJoinNonce === right.publisherJoinNonce
    && left.publishedAt === right.publishedAt
    && left.publishedFenceEpoch === right.publishedFenceEpoch
    && left.manifestObject.objectPath === right.manifestObject.objectPath
    && left.manifestObject.remoteId === right.manifestObject.remoteId
    && left.manifestObject.parentId === right.manifestObject.parentId
    && left.manifestObject.size === right.manifestObject.size
    && left.manifestObject.eTag === right.manifestObject.eTag
    && left.manifestObject.cTag === right.manifestObject.cTag
    && left.manifestObject.sha256Hash === right.manifestObject.sha256Hash;
}

function sameClosingSnapshot(
  closing: CommunityPluginClosingV1,
  closed: CommunityPluginClosedV1,
): boolean {
  return sameParticipant(closing.owner, closed.owner)
    && closing.startedAt === closed.startedAt
    && closing.startedRevision === closed.startedRevision
    && closing.fenceEpoch === closed.fenceEpoch
    && closing.memberKeys.length === closed.memberKeys.length
    && closing.memberKeys.every((key, index) => key === closed.memberKeys[index]);
}

function isIdentity(value: unknown): value is CommunityPluginParticipantIdentityV1 {
  return isRecord(value)
    && safeId(value.participantId)
    && safeId(value.incarnation);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function safePluginId(value: unknown): value is string {
  return typeof value === "string" && SAFE_PLUGIN_ID.test(value);
}

function commandFingerprint(command: CommunityPluginLifecycleCommandV1): string {
  const base = [
    command.type,
    command.expectedRevision,
    command.scope.accountId,
    command.scope.driveId,
    command.scope.vaultFolderId,
    command.scope.filesRootId,
    command.at,
  ];
  switch (command.type) {
    case "register-participant":
    case "observe-participant":
      return JSON.stringify([...base, command.participant.participantId, command.participant.incarnation]);
    case "join-plugin":
      return JSON.stringify([
        ...base,
        command.participant.participantId,
        command.participant.incarnation,
        command.pluginId,
        command.targetGeneration,
        command.joinNonce,
        command.joinEvidence,
        command.observedClosedRevision ?? null,
      ]);
    case "exit-plugin":
      return JSON.stringify([
        ...base,
        command.participant.participantId,
        command.participant.incarnation,
        command.pluginId,
        command.generation,
      ]);
    case "publish-plugin-bundle":
      return JSON.stringify([
        ...base,
        command.participant.participantId,
        command.participant.incarnation,
        command.pluginId,
        command.generation,
        command.joinNonce,
        command.fenceEpoch,
        command.manifestObject.objectPath,
        command.manifestObject.remoteId,
        command.manifestObject.parentId,
        command.manifestObject.size,
        command.manifestObject.eTag,
        command.manifestObject.cTag,
        command.manifestObject.sha256Hash,
      ]);
    case "confirm-legacy-migration":
      return JSON.stringify([
        ...base,
        command.actor.participantId,
        command.actor.incarnation,
        command.evidence,
      ]);
    case "seal-plugin-legacy-authority":
      return JSON.stringify([
        ...base,
        command.actor.participantId,
        command.actor.incarnation,
        command.pluginId,
        command.generation,
        command.publishedBundle.publicationRevision,
        command.publishedBundle.publisher.participantId,
        command.publishedBundle.publisher.incarnation,
        command.publishedBundle.publisherJoinNonce,
        command.publishedBundle.publishedAt,
        command.publishedBundle.publishedFenceEpoch,
        command.publishedBundle.manifestObject.objectPath,
        command.publishedBundle.manifestObject.remoteId,
        command.publishedBundle.manifestObject.parentId,
        command.publishedBundle.manifestObject.size,
        command.publishedBundle.manifestObject.eTag,
        command.publishedBundle.manifestObject.cTag,
        command.publishedBundle.manifestObject.sha256Hash,
      ]);
    case "retire-participant":
      return JSON.stringify([
        ...base,
        command.actor.participantId,
        command.actor.incarnation,
        command.target.participantId,
        command.target.incarnation,
      ]);
    case "begin-close":
      return JSON.stringify([
        ...base,
        command.actor.participantId,
        command.actor.incarnation,
        command.pluginId,
        command.generation,
      ]);
    case "complete-close":
      return JSON.stringify([
        ...base,
        command.actor.participantId,
        command.actor.incarnation,
        command.pluginId,
        command.generation,
        command.cleanupReceiptDigest,
      ]);
  }
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function encodePluginId(pluginId: string): string {
  return [...pluginId].map((character) =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}
