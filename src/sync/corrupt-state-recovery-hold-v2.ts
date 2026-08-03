import type { DataAdapter } from "obsidian";
import { isRecord } from "../obsidian-compat";
import {
  canonicalPlanDigestV2,
  summarizeCanonicalPlanReviewV2,
} from "./canonical-plan-v2";
import {
  validateEnvelope,
  type StateEnvelopeV2CorruptionKind,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  isSyncScope,
  sameCanonicalPlanIdentityV2,
  sameSyncScope,
  SyncActionType,
  type CanonicalPlanIdentityV2,
  type CanonicalPlanReviewV2,
  type SyncPlanItem,
  type SyncScope,
} from "./types";

export interface CorruptStateRecoveryHoldV2Paths {
  committed: string;
  next: string;
}

export interface CorruptStateRecoveryHoldV2 {
  schemaVersion: 1;
  kind: "v2-corrupt-state-recovery-hold";
  revision: number;
  phase: "pending" | "confirmed";
  createdAt: number;
  updatedAt: number;
  sourceDigest: string;
  sourceCommitSeq: number;
  sourceLifecycleEpoch: number;
  corruption: StateEnvelopeV2CorruptionKind;
  scope: SyncScope;
  candidate: SyncStateEnvelopeV2;
  canonicalIdentity: CanonicalPlanIdentityV2;
  canonicalReview: CanonicalPlanReviewV2;
  lastTotalFiles: number;
  items: SyncPlanItem[];
}

export interface PendingCorruptStateRecoveryHoldInputV2 {
  sourceDigest: string;
  sourceCommitSeq: number;
  sourceLifecycleEpoch: number;
  corruption: StateEnvelopeV2CorruptionKind;
  scope: SyncScope;
  candidate: SyncStateEnvelopeV2;
  canonicalIdentity: CanonicalPlanIdentityV2;
  canonicalReview: CanonicalPlanReviewV2;
  lastTotalFiles: number;
  items: readonly SyncPlanItem[];
  now?: number;
}

/**
 * Two-slot control record for a reviewed corrupt-state candidate.
 *
 * It owns no authority or mutation capability. Promoting an exact staged
 * record after a lost response can only preserve/recover a review fact; the
 * separate corrupt-state publication journal remains the sole authority
 * transition owner.
 */
export class CorruptStateRecoveryHoldV2Store {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly paths: CorruptStateRecoveryHoldV2Paths,
  ) {}

  async load(): Promise<CorruptStateRecoveryHoldV2 | null> {
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
    await this.promote(staged);
    return this.readRequired(this.paths.committed);
  }

  async publishPending(
    input: PendingCorruptStateRecoveryHoldInputV2,
  ): Promise<CorruptStateRecoveryHoldV2> {
    validatePendingInput(input);
    const current = await this.load();
    if (
      current
      && current.sourceDigest === input.sourceDigest
      && sameEnvelope(current.candidate, input.candidate)
      && sameCanonicalPlanIdentityV2(
        current.canonicalIdentity,
        input.canonicalIdentity,
      )
      && sameItems(current.items, input.items)
      && current.lastTotalFiles === input.lastTotalFiles
    ) {
      return current;
    }
    const now = input.now ?? Date.now();
    return this.publish({
      schemaVersion: 1,
      kind: "v2-corrupt-state-recovery-hold",
      revision: (current?.revision ?? 0) + 1,
      phase: "pending",
      createdAt: now,
      updatedAt: now,
      sourceDigest: input.sourceDigest,
      sourceCommitSeq: input.sourceCommitSeq,
      sourceLifecycleEpoch: input.sourceLifecycleEpoch,
      corruption: input.corruption,
      scope: { ...input.scope },
      candidate: structuredClone(input.candidate),
      canonicalIdentity: structuredClone(input.canonicalIdentity),
      canonicalReview: structuredClone(input.canonicalReview),
      lastTotalFiles: input.lastTotalFiles,
      items: [...structuredClone(input.items)],
    });
  }

  async confirm(
    expectedIdentity: CanonicalPlanIdentityV2,
    now = Date.now(),
  ): Promise<CorruptStateRecoveryHoldV2 | null> {
    const current = await this.load();
    if (
      !current
      || !sameCanonicalPlanIdentityV2(
        current.canonicalIdentity,
        expectedIdentity,
      )
    ) return null;
    if (current.phase === "confirmed") return current;
    return this.publish({
      ...current,
      revision: current.revision + 1,
      phase: "confirmed",
      updatedAt: now,
    });
  }

  async clear(): Promise<void> {
    await this.removeIfExists(this.paths.next);
    await this.removeIfExists(this.paths.committed);
  }

  private async publish(
    hold: CorruptStateRecoveryHoldV2,
  ): Promise<CorruptStateRecoveryHoldV2> {
    validateCorruptStateRecoveryHoldV2(hold);
    await this.removeIfExists(this.paths.next);
    const raw = JSON.stringify(hold);
    try {
      await this.adapter.write(this.paths.next, raw);
    } catch (error) {
      if (!sameHold(await this.readOptional(this.paths.next), hold)) {
        throw error;
      }
    }
    const staged = await this.readRequired(this.paths.next);
    if (!sameHold(staged, hold)) {
      throw new Error(
        "V2 corrupt-state recovery hold failed staged read-back",
      );
    }
    await this.promote(staged);
    const committed = await this.readRequired(this.paths.committed);
    if (!sameHold(committed, hold)) {
      throw new Error(
        "V2 corrupt-state recovery hold failed committed read-back",
      );
    }
    return committed;
  }

  private async promote(
    staged: CorruptStateRecoveryHoldV2,
  ): Promise<void> {
    const current = await this.readOptional(this.paths.committed);
    if (current && current.revision >= staged.revision) {
      await this.removeIfExists(this.paths.next);
      return;
    }
    await this.removeIfExists(this.paths.committed);
    try {
      await this.adapter.rename(this.paths.next, this.paths.committed);
    } catch (error) {
      if (
        !sameHold(
          await this.readOptional(this.paths.committed),
          staged,
        )
      ) throw error;
    }
  }

  private async readOptional(
    path: string,
  ): Promise<CorruptStateRecoveryHoldV2 | null> {
    if (!await this.adapter.exists(path)) return null;
    return this.readRequired(path);
  }

  private async readRequired(
    path: string,
  ): Promise<CorruptStateRecoveryHoldV2> {
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch {
      throw new Error("V2 corrupt-state recovery hold is unreadable");
    }
    validateCorruptStateRecoveryHoldV2(value);
    return value;
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) {
      try {
        await this.adapter.remove(path);
      } catch (error) {
        if (await this.adapter.exists(path)) throw error;
      }
    }
  }
}

export function validateCorruptStateRecoveryHoldV2(
  value: unknown,
): asserts value is CorruptStateRecoveryHoldV2 {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "v2-corrupt-state-recovery-hold"
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || (value.phase !== "pending" && value.phase !== "confirmed")
    || !Number.isFinite(value.createdAt)
    || !Number.isFinite(value.updatedAt)
    || Number(value.updatedAt) < Number(value.createdAt)
    || typeof value.sourceDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
    || !Number.isSafeInteger(value.sourceCommitSeq)
    || Number(value.sourceCommitSeq) < 1
    || !Number.isSafeInteger(value.sourceLifecycleEpoch)
    || Number(value.sourceLifecycleEpoch) < 1
    || !isCorruption(value.corruption)
    || !isSyncScope(value.scope)
    || !isCanonicalIdentity(value.canonicalIdentity)
    || !isCanonicalReview(value.canonicalReview)
    || !Number.isSafeInteger(value.lastTotalFiles)
    || Number(value.lastTotalFiles) < 0
    || !Array.isArray(value.items)
    || !value.items.every(isPlanItem)
  ) {
    throw new Error(
      "V2 corrupt-state recovery hold has an unsupported format",
    );
  }
  const hold = value as unknown as CorruptStateRecoveryHoldV2;
  validateEnvelope(hold.candidate);
  const expectedDigest = canonicalPlanDigestV2({
    items: hold.items,
    lastTotalFiles: hold.lastTotalFiles,
    scope: hold.scope,
    sourceCommitSeq: hold.candidate.meta.commitSeq,
  });
  const expectedReview = summarizeCanonicalPlanReviewV2(hold.items);
  if (
    !sameSyncScope(hold.scope, hold.candidate.scope)
    || !sameSyncScope(hold.scope, hold.canonicalIdentity.scope)
    || hold.candidate.meta.commitSeq !== hold.sourceCommitSeq + 1
    || hold.candidate.meta.lifecycleEpoch
      !== hold.sourceLifecycleEpoch + 1
    || hold.canonicalIdentity.sourceCommitSeq
      !== hold.candidate.meta.commitSeq
    || hold.canonicalIdentity.digest !== expectedDigest
    || JSON.stringify(hold.canonicalReview)
      !== JSON.stringify(expectedReview)
  ) {
    throw new Error(
      "V2 corrupt-state recovery hold facts are inconsistent",
    );
  }
}

function validatePendingInput(
  input: PendingCorruptStateRecoveryHoldInputV2,
): void {
  validateCorruptStateRecoveryHoldV2({
    schemaVersion: 1,
    kind: "v2-corrupt-state-recovery-hold",
    revision: 1,
    phase: "pending",
    createdAt: input.now ?? 1,
    updatedAt: input.now ?? 1,
    sourceDigest: input.sourceDigest,
    sourceCommitSeq: input.sourceCommitSeq,
    sourceLifecycleEpoch: input.sourceLifecycleEpoch,
    corruption: input.corruption,
    scope: input.scope,
    candidate: input.candidate,
    canonicalIdentity: input.canonicalIdentity,
    canonicalReview: input.canonicalReview,
    lastTotalFiles: input.lastTotalFiles,
    items: [...input.items],
  });
}

function isCanonicalIdentity(
  value: unknown,
): value is CanonicalPlanIdentityV2 {
  return isRecord(value)
    && value.version === 2
    && isSyncScope(value.scope)
    && Number.isSafeInteger(value.sourceCommitSeq)
    && Number(value.sourceCommitSeq) > 0
    && typeof value.digest === "string"
    && value.digest.length > 0;
}

function isCanonicalReview(
  value: unknown,
): value is CanonicalPlanReviewV2 {
  return isRecord(value)
    && isRecord(value.counts)
    && Number.isSafeInteger(value.impactCount)
    && Number(value.impactCount) >= 0;
}

function isPlanItem(value: unknown): value is SyncPlanItem {
  return isRecord(value)
    && Object.values(SyncActionType).includes(
      value.type as SyncActionType,
    )
    && typeof value.path === "string";
}

function isCorruption(
  value: unknown,
): value is StateEnvelopeV2CorruptionKind {
  return value === "remote-index"
    || value === "anchors"
    || value === "remote-index-and-anchors";
}

function sameHold(
  left: CorruptStateRecoveryHoldV2 | null,
  right: CorruptStateRecoveryHoldV2,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function sameEnvelope(
  left: SyncStateEnvelopeV2,
  right: SyncStateEnvelopeV2,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameItems(
  left: readonly SyncPlanItem[],
  right: readonly SyncPlanItem[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
