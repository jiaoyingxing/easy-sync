import type { DataAdapter } from "obsidian";
import { isRecord } from "../obsidian-compat";
import {
  isSyncScope,
  sameCanonicalPlanIdentityV2,
  sameSyncScope,
  SyncActionType,
  type CanonicalPlanIdentityV2,
  type CanonicalPlanReviewV2,
  type PlanReviewItem,
  type SyncPlanItem,
  type V2ActivationReviewKind,
} from "./types";
import {
  validateEnvelope,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import { sameStateV2MigrationCandidate } from "./state-v2-migration";
import {
  canonicalPlanDigestV2,
  summarizeCanonicalPlanReviewV2,
} from "./canonical-plan-v2";
import {
  isSharedSyncProtocolBinding,
  type SharedSyncProtocolBinding,
} from "./sync-protocol-v3";
import {
  isSharedSyncProtocolBindingV2,
  type SharedSyncProtocolBindingV2,
} from "./sync-protocol-v2";
import {
  sameCommunityPluginEnablementMigrationCarrierV2,
  validateCommunityPluginEnablementMigrationCarrierV2,
  type CommunityPluginEnablementMigrationCarrierV2,
} from "./community-plugin-enablement";

export interface MigrationHoldV2Paths {
  committed: string;
  next: string;
}

export type MigrationHoldPhaseV2 =
  | "pending"
  | "confirmed"
  | "authority-committed"
  | "completed"
  | "cancelled";

export interface MigrationHoldV2 {
  schemaVersion: 1;
  kind: "state-v2-migration-hold";
  revision: number;
  phase: MigrationHoldPhaseV2;
  createdAt: number;
  updatedAt: number;
  scope: CanonicalPlanIdentityV2["scope"];
  candidate: SyncStateEnvelopeV2;
  sourceStateDigest: string;
  canonicalIdentity: CanonicalPlanIdentityV2;
  canonicalReview: CanonicalPlanReviewV2;
  lastTotalFiles: number;
  planFactsDigest: string;
  items: PlanReviewItem[];
  /** Missing only on holds written before activation entry classification. */
  reviewKind?: V2ActivationReviewKind;
  communityPluginEnablement?: CommunityPluginEnablementMigrationCarrierV2;
  /**
   * Exact protocol preparation checkpoint. A pending first-sync hold may
   * carry only the V2 binding proven by create + exact readback; confirmed
   * and authority-committed holds always carry their final binding.
   */
  protocolBinding?: SharedSyncProtocolBinding;
}

export interface PendingMigrationHoldV2Input {
  candidate: SyncStateEnvelopeV2;
  sourceStateDigest: string;
  canonicalIdentity: CanonicalPlanIdentityV2;
  canonicalReview: CanonicalPlanReviewV2;
  items: readonly SyncPlanItem[];
  lastTotalFiles: number;
  reviewKind?: V2ActivationReviewKind;
  communityPluginEnablement?: CommunityPluginEnablementMigrationCarrierV2;
  now?: number;
}

/**
 * Durable migration control record.
 *
 * The two-slot store deliberately owns no user-file or Graph capability. A
 * valid record authorizes only migration orchestration; item-level mutation
 * remains behind the V2 ledger after the manifest commits.
 */
export class MigrationHoldV2Store {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly paths: MigrationHoldV2Paths,
  ) {}

  async load(): Promise<MigrationHoldV2 | null> {
    const [committed, staged] = await Promise.all([
      this.readOptional(this.paths.committed),
      this.readOptional(this.paths.next),
    ]);
    if (!committed && !staged) return null;
    if (!staged) return committed;
    if (committed && staged.revision <= committed.revision) {
      await this.removeIfExists(this.paths.next);
      return committed;
    }
    await this.promoteStaged(staged);
    return staged;
  }

  async publishPending(
    input: PendingMigrationHoldV2Input,
  ): Promise<MigrationHoldV2> {
    validatePendingInput(input);
    const current = await this.load();
    if (
      current
      && isActiveMigrationHoldV2(current)
      && sameStateV2MigrationCandidate(current.candidate, input.candidate)
      && current.sourceStateDigest === input.sourceStateDigest
      && sameCanonicalPlanIdentityV2(
        current.canonicalIdentity,
        input.canonicalIdentity,
      )
      && sameReview(current.canonicalReview, input.canonicalReview)
      && current.lastTotalFiles === input.lastTotalFiles
      && current.planFactsDigest === migrationPlanFactsDigestV2({
        items: input.items,
        lastTotalFiles: input.lastTotalFiles,
        scope: input.canonicalIdentity.scope,
      })
      && sameReviewItems(current.items, projectReviewItems(input.items))
      && migrationHoldReviewKindV2(current)
        === (input.reviewKind ?? "v2-migration")
      && sameCommunityPluginEnablementMigrationCarrierV2(
        current.communityPluginEnablement,
        input.communityPluginEnablement,
      )
    ) {
      return current;
    }
    const now = input.now ?? Date.now();
    return this.publish({
      schemaVersion: 1,
      kind: "state-v2-migration-hold",
      revision: (current?.revision ?? 0) + 1,
      phase: "pending",
      createdAt: now,
      updatedAt: now,
      scope: { ...input.canonicalIdentity.scope },
      candidate: structuredClone(input.candidate),
      sourceStateDigest: input.sourceStateDigest,
      canonicalIdentity: structuredClone(input.canonicalIdentity),
      canonicalReview: structuredClone(input.canonicalReview),
      lastTotalFiles: input.lastTotalFiles,
      planFactsDigest: migrationPlanFactsDigestV2({
        items: input.items,
        lastTotalFiles: input.lastTotalFiles,
        scope: input.canonicalIdentity.scope,
      }),
      items: projectReviewItems(input.items),
      ...((input.reviewKind ?? "v2-migration") === "v2-migration"
        ? {}
        : { reviewKind: input.reviewKind }),
      ...(input.communityPluginEnablement
        ? {
            communityPluginEnablement: structuredClone(
              input.communityPluginEnablement,
            ),
          }
        : {}),
    });
  }

  /**
   * Public 1.2.7 may have persisted a source-bound community-plugin
   * enablement carrier. Enablement is device-local now, so retain the exact
   * migration candidate/review/protocol facts while retiring only that
   * optional carrier. This store owns no user-file or Graph capability.
   */
  async retireCommunityPluginEnablementCarrier(
    now = Date.now(),
  ): Promise<MigrationHoldV2 | null> {
    const current = await this.load();
    if (!current?.communityPluginEnablement) return current;
    const {
      communityPluginEnablement: _retired,
      ...preserved
    } = current;
    return this.publish({
      ...preserved,
      revision: current.revision + 1,
      updatedAt: now,
    });
  }

  async transition(
    expectedRevision: number,
    expectedIdentity: CanonicalPlanIdentityV2,
    phase: Extract<
      MigrationHoldPhaseV2,
      "authority-committed" | "completed" | "cancelled"
    >,
    now = Date.now(),
  ): Promise<MigrationHoldV2 | null> {
    const current = await this.load();
    if (
      !current
      || current.revision !== expectedRevision
      || !sameCanonicalPlanIdentityV2(
        current.canonicalIdentity,
        expectedIdentity,
      )
      || !transitionAllowed(current.phase, phase)
    ) {
      return null;
    }
    return this.publish({
      ...current,
      revision: current.revision + 1,
      phase,
      updatedAt: now,
    });
  }

  async confirm(
    expectedRevision: number,
    expectedIdentity: CanonicalPlanIdentityV2,
    protocolBinding: SharedSyncProtocolBinding,
    now = Date.now(),
  ): Promise<MigrationHoldV2 | null> {
    if (!isSharedSyncProtocolBinding(protocolBinding)) return null;
    const current = await this.load();
    if (
      !current
      || current.revision !== expectedRevision
      || !sameCanonicalPlanIdentityV2(
        current.canonicalIdentity,
        expectedIdentity,
      )
      || !transitionAllowed(current.phase, "confirmed")
    ) {
      return null;
    }
    return this.publish({
      ...current,
      revision: current.revision + 1,
      phase: "confirmed",
      updatedAt: now,
      protocolBinding: structuredClone(protocolBinding),
    });
  }

  async checkpointPendingProtocolBinding(
    expectedRevision: number,
    expectedIdentity: CanonicalPlanIdentityV2,
    protocolBinding: SharedSyncProtocolBindingV2,
    now = Date.now(),
  ): Promise<MigrationHoldV2 | null> {
    if (!isSharedSyncProtocolBindingV2(protocolBinding)) return null;
    const current = await this.load();
    if (
      !current
      || current.phase !== "pending"
      || migrationHoldReviewKindV2(current) !== "v2-first-sync"
      || current.revision !== expectedRevision
      || !sameCanonicalPlanIdentityV2(
        current.canonicalIdentity,
        expectedIdentity,
      )
    ) {
      return null;
    }
    if (current.protocolBinding !== undefined) {
      return isSharedSyncProtocolBindingV2(current.protocolBinding)
        && current.protocolBinding.migrationGeneration
          === protocolBinding.migrationGeneration
        && current.protocolBinding.confirmedAllDevicesUpdatedAt
          === protocolBinding.confirmedAllDevicesUpdatedAt
        && current.protocolBinding.recordId === protocolBinding.recordId
        && current.protocolBinding.recordETag === protocolBinding.recordETag
        ? current
        : null;
    }
    return this.publish({
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      protocolBinding: structuredClone(protocolBinding),
    });
  }

  private async publish(hold: MigrationHoldV2): Promise<MigrationHoldV2> {
    validateMigrationHoldV2(hold);
    await this.removeIfExists(this.paths.next);
    await this.adapter.write(this.paths.next, JSON.stringify(hold));
    const staged = await this.readRequired(this.paths.next);
    if (!sameHold(staged, hold)) {
      throw new Error("V2 migration hold failed staged read-back");
    }
    await this.promoteStaged(staged);
    const committed = await this.readRequired(this.paths.committed);
    if (!sameHold(committed, hold)) {
      throw new Error("V2 migration hold failed committed read-back");
    }
    return committed;
  }

  private async promoteStaged(staged: MigrationHoldV2): Promise<void> {
    const current = await this.readOptional(this.paths.committed);
    if (current && current.revision >= staged.revision) {
      await this.removeIfExists(this.paths.next);
      return;
    }
    await this.removeIfExists(this.paths.committed);
    await this.adapter.rename(this.paths.next, this.paths.committed);
  }

  private async readOptional(path: string): Promise<MigrationHoldV2 | null> {
    if (!await this.adapter.exists(path)) return null;
    return this.readRequired(path);
  }

  private async readRequired(path: string): Promise<MigrationHoldV2> {
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch {
      throw new Error("V2 migration hold is unreadable");
    }
    validateMigrationHoldV2(value);
    return value;
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

export function isActiveMigrationHoldV2(
  hold: MigrationHoldV2 | null,
): hold is MigrationHoldV2 {
  return hold !== null
    && hold.phase !== "completed"
    && hold.phase !== "cancelled";
}

export function migrationHoldReviewKindV2(
  hold: Readonly<MigrationHoldV2>,
): V2ActivationReviewKind {
  return hold.reviewKind ?? "v2-migration";
}

export function validateMigrationHoldV2(
  value: unknown,
): asserts value is MigrationHoldV2 {
  if (!isRecord(value)) throw new Error("V2 migration hold must be an object");
  if (
    value.schemaVersion !== 1
    || value.kind !== "state-v2-migration-hold"
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || !isMigrationHoldPhase(value.phase)
    || !Number.isFinite(value.createdAt)
    || !Number.isFinite(value.updatedAt)
    || Number(value.updatedAt) < Number(value.createdAt)
    || !isSyncScope(value.scope)
    || typeof value.sourceStateDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceStateDigest)
    || !isCanonicalIdentity(value.canonicalIdentity)
    || !sameSyncScope(value.scope, value.canonicalIdentity.scope)
    || !isCanonicalReview(value.canonicalReview)
    || !Number.isSafeInteger(value.lastTotalFiles)
    || Number(value.lastTotalFiles) < 0
    || typeof value.planFactsDigest !== "string"
    || value.planFactsDigest.length === 0
    || !Array.isArray(value.items)
    || !value.items.every(isPlanReviewItem)
    || (
      value.reviewKind !== undefined
      && value.reviewKind !== "v2-migration"
      && value.reviewKind !== "v2-cloud-join"
      && value.reviewKind !== "v2-first-sync"
    )
  ) {
    throw new Error("V2 migration hold has an unsupported format");
  }
  if (value.communityPluginEnablement !== undefined) {
    validateCommunityPluginEnablementMigrationCarrierV2(
      value.communityPluginEnablement,
    );
    if (!sameSyncScope(value.scope, value.communityPluginEnablement.scope)) {
      throw new Error(
        "V2 migration hold community plugin scope is inconsistent",
      );
    }
  }
  validateEnvelope(value.candidate);
  if (
    value.candidate.remoteIndex.complete !== true
    || !value.candidate.folderAnchors
    || !sameSyncScope(value.scope, value.candidate.scope)
    || value.canonicalIdentity.sourceCommitSeq
      !== value.candidate.meta.commitSeq
  ) {
    throw new Error("V2 migration hold candidate identity is inconsistent");
  }
  if (
    (
      value.phase === "confirmed"
      || value.phase === "authority-committed"
    )
    && !isSharedSyncProtocolBinding(value.protocolBinding)
  ) {
    throw new Error("V2 migration hold lacks its shared protocol binding");
  }
  if (
    value.protocolBinding !== undefined
    && !isSharedSyncProtocolBinding(value.protocolBinding)
  ) {
    throw new Error("V2 migration hold protocol binding is invalid");
  }
  if (
    value.phase === "pending"
    && value.protocolBinding !== undefined
    && (
      value.reviewKind !== "v2-first-sync"
      || !isSharedSyncProtocolBindingV2(value.protocolBinding)
    )
  ) {
    throw new Error(
      "Only a pending first-sync hold may carry a V2 protocol checkpoint",
    );
  }
}

function validatePendingInput(input: PendingMigrationHoldV2Input): void {
  validateEnvelope(input.candidate);
  const expectedDigest = canonicalPlanDigestV2({
    items: input.items,
    lastTotalFiles: input.lastTotalFiles,
    scope: input.canonicalIdentity.scope,
    sourceCommitSeq: input.canonicalIdentity.sourceCommitSeq,
  });
  const expectedReview = summarizeCanonicalPlanReviewV2(input.items);
  if (
    input.candidate.remoteIndex.complete !== true
    || !input.candidate.folderAnchors
    || !/^[a-f0-9]{64}$/.test(input.sourceStateDigest)
    || !sameSyncScope(input.candidate.scope, input.canonicalIdentity.scope)
    || input.candidate.meta.commitSeq
      !== input.canonicalIdentity.sourceCommitSeq
    || input.canonicalIdentity.digest.length === 0
    || input.canonicalIdentity.digest !== expectedDigest
    || !Number.isSafeInteger(input.lastTotalFiles)
    || input.lastTotalFiles < 0
    || !Number.isSafeInteger(input.canonicalReview.impactCount)
    || input.canonicalReview.impactCount < 0
    || !sameReview(input.canonicalReview, expectedReview)
  ) {
    throw new Error("V2 migration hold input is not bound to its candidate");
  }
  if (input.communityPluginEnablement) {
    validateCommunityPluginEnablementMigrationCarrierV2(
      input.communityPluginEnablement,
    );
    if (
      !sameSyncScope(
        input.communityPluginEnablement.scope,
        input.canonicalIdentity.scope,
      )
    ) {
      throw new Error(
        "V2 migration hold community plugin scope is not bound to its candidate",
      );
    }
  }
}

/**
 * Exact reviewed action facts without the envelope commit sequence.
 *
 * A V2 remote-index cursor refresh may commit the same item/anchor facts under
 * a later sequence before a crash-resumed migration executes. This digest is
 * paired with an envelope-facts comparison; it never authorizes a changed
 * action list on its own.
 */
export function migrationPlanFactsDigestV2(input: {
  items: readonly SyncPlanItem[];
  lastTotalFiles: number;
  scope: CanonicalPlanIdentityV2["scope"];
}): string {
  return canonicalPlanDigestV2({
    ...input,
    sourceCommitSeq: 0,
  });
}

function projectReviewItems(items: readonly SyncPlanItem[]): PlanReviewItem[] {
  return items.map(({
    type,
    path,
    reason,
    local,
    remote,
    folder,
  }) => ({
    type,
    path,
    reason,
    localHash: local?.hash,
    remoteETag: remote?.eTag,
    folderRemoteId: folder?.remoteId,
    folderRemoteETag: folder?.remoteETag,
    folderParentRemoteId: folder?.parentRemoteId,
    folderParentPath: folder?.parentPath,
    folderParentRemoteETag: folder?.parentRemoteETag,
  }));
}

function isCanonicalIdentity(value: unknown): value is CanonicalPlanIdentityV2 {
  if (!isRecord(value)) return false;
  return value.version === 2
    && isSyncScope(value.scope)
    && Number.isSafeInteger(value.sourceCommitSeq)
    && Number(value.sourceCommitSeq) >= 1
    && typeof value.digest === "string"
    && value.digest.length > 0;
}

function isCanonicalReview(value: unknown): value is CanonicalPlanReviewV2 {
  if (!isRecord(value) || !isRecord(value.counts)) return false;
  const counts = value.counts;
  return ["uploads", "downloads", "deletes", "conflicts", "skipped"]
    .every((key) =>
      Number.isSafeInteger(counts[key])
      && Number(counts[key]) >= 0)
    && (
      counts.folders === undefined
      || (
        Number.isSafeInteger(counts.folders)
        && Number(counts.folders) >= 0
      )
    )
    && Number.isSafeInteger(value.impactCount)
    && Number(value.impactCount) >= 0;
}

function isPlanReviewItem(value: unknown): value is PlanReviewItem {
  return isRecord(value)
    && Object.values(SyncActionType).includes(value.type as SyncActionType)
    && typeof value.path === "string";
}

function isMigrationHoldPhase(value: unknown): value is MigrationHoldPhaseV2 {
  return value === "pending"
    || value === "confirmed"
    || value === "authority-committed"
    || value === "completed"
    || value === "cancelled";
}

function transitionAllowed(
  from: MigrationHoldPhaseV2,
  to: MigrationHoldPhaseV2,
): boolean {
  if (to === "cancelled") {
    return from === "pending" || from === "confirmed";
  }
  if (to === "confirmed") return from === "pending";
  if (to === "authority-committed") return from === "confirmed";
  if (to === "completed") return from === "authority-committed";
  return false;
}

function sameReview(
  left: CanonicalPlanReviewV2,
  right: CanonicalPlanReviewV2,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameReviewItems(
  left: readonly PlanReviewItem[],
  right: readonly PlanReviewItem[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameHold(left: MigrationHoldV2, right: MigrationHoldV2): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
