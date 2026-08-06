import type { DataAdapter } from "obsidian";
import { isRecord } from "../obsidian-compat";
import {
  validateEnvelope,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  StateV2AuthorityWitnessStore,
  type StateV2ActiveAuthorityWitness,
  type StateV2AuthorityWitnessPaths,
} from "./state-v2-authority-witness";
import {
  readStateV2Manifest,
  type StateV2Manifest,
} from "./state-v2-migration";
import { isSyncScope, sameSyncScope } from "./types";
import {
  isSharedSyncProtocolBinding,
  isSharedSyncProtocolBindingTransitionAllowed,
  type SharedSyncProtocolBinding,
} from "./sync-protocol-v3";

export interface StateV2ScopeTransitionPaths {
  stateCommitted: string;
  stateNext: string;
  statePrevious: string;
  stateRecovery: string;
  manifestCommitted: string;
  manifestNext: string;
  witness: StateV2AuthorityWitnessPaths;
  transitionCommitted: string;
  transitionNext: string;
}

export interface StateV2ScopeTransitionRecord {
  schemaVersion: 1;
  kind: "state-v2-scope-transition";
  createdAt: number;
  sourceEnvelope: SyncStateEnvelopeV2;
  candidate: SyncStateEnvelopeV2;
  sourceManifest: StateV2Manifest;
  sourceWitnessRevision: number;
  nextProtocolBinding?: SharedSyncProtocolBinding;
}

export type StateV2ScopeTransitionFailureReason =
  | "scope-transition-unreadable"
  | "scope-transition-unsupported"
  | "scope-transition-state-ambiguous";

export class StateV2ScopeTransitionError extends Error {
  constructor(
    readonly reason: StateV2ScopeTransitionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "StateV2ScopeTransitionError";
  }
}

/**
 * Crash-resumable V2 scope transition.
 *
 * Once the control record is committed, recovery always rolls forward to the
 * exact candidate stored in that record. No user/Graph mutation is involved.
 * Envelope, manifest and authority witness may be separate adapter files, but
 * every partial prefix is deterministic on restart and cannot expose V1.
 */
export class StateV2ScopeTransitionStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly paths: StateV2ScopeTransitionPaths,
  ) {}

  async commit(input: {
    sourceEnvelope: SyncStateEnvelopeV2;
    candidate: SyncStateEnvelopeV2;
    sourceManifest: StateV2Manifest;
    sourceWitness: StateV2ActiveAuthorityWitness;
    nextProtocolBinding?: SharedSyncProtocolBinding;
    now?: number;
  }): Promise<SyncStateEnvelopeV2> {
    const existing = await this.loadControlRecord();
    const record: StateV2ScopeTransitionRecord = {
      schemaVersion: 1,
      kind: "state-v2-scope-transition",
      createdAt: input.now ?? Date.now(),
      sourceEnvelope: structuredClone(input.sourceEnvelope),
      candidate: structuredClone(input.candidate),
      sourceManifest: structuredClone(input.sourceManifest),
      sourceWitnessRevision: input.sourceWitness.revision,
      ...(input.nextProtocolBinding
        ? {
            nextProtocolBinding:
              structuredClone(input.nextProtocolBinding),
          }
        : {}),
    };
    validateTransitionRecord(record);
    if (
      input.sourceWitness.status !== "active"
      || !sameManifest(input.sourceWitness.manifest, input.sourceManifest)
      || !protocolBindingTransitionAllowed(
        input.sourceWitness.protocolBinding,
        input.nextProtocolBinding,
      )
    ) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-unsupported",
        "V2 scope transition source witness is inconsistent",
      );
    }
    if (existing && !sameRecord(existing, record, true)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "Another V2 scope transition is already committed",
      );
    }
    if (!existing) await this.publishControlRecord(record);
    return this.rollForward(existing ?? record);
  }

  async recover(): Promise<SyncStateEnvelopeV2 | null> {
    const record = await this.loadControlRecord();
    return record ? this.rollForward(record) : null;
  }

  private async rollForward(
    record: StateV2ScopeTransitionRecord,
  ): Promise<SyncStateEnvelopeV2> {
    validateTransitionRecord(record);
    if (await this.adapter.exists(this.paths.stateRecovery)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "Ordinary V2 publication recovery must finish before scope transition",
      );
    }
    await this.publishCandidateEnvelope(record);
    const targetManifest = targetManifestFor(record);
    await this.publishTargetManifest(record.sourceManifest, targetManifest);
    const witnessStore = new StateV2AuthorityWitnessStore(
      this.adapter,
      this.paths.witness,
    );
    await witnessStore.replaceActive({
      expectedManifest: record.sourceManifest,
      expectedRevision: record.sourceWitnessRevision,
      nextManifest: targetManifest,
      ...(record.nextProtocolBinding
        ? { nextProtocolBinding: record.nextProtocolBinding }
        : {}),
      now: record.createdAt,
    });
    const committed = await this.readEnvelopeRequired(
      this.paths.stateCommitted,
    );
    const manifest = await readStateV2Manifest(
      this.adapter,
      this.paths.manifestCommitted,
    );
    const witness = await witnessStore.load();
    if (
      !sameEnvelope(committed, record.candidate)
      || !manifest
      || !sameManifest(manifest, targetManifest)
      || witness?.status !== "active"
      || !sameManifest(witness.manifest, targetManifest)
    ) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "V2 scope transition did not converge on one authority",
      );
    }
    await this.removeIfExists(this.paths.stateNext);
    await this.removeIfExists(this.paths.statePrevious);
    await this.removeIfExists(this.paths.manifestNext);
    await this.removeIfExists(this.paths.transitionNext);
    await this.removeIfExists(this.paths.transitionCommitted);
    return committed;
  }

  private async publishCandidateEnvelope(
    record: StateV2ScopeTransitionRecord,
  ): Promise<void> {
    const [committed, staged, previous] = await Promise.all([
      this.readEnvelopeOptional(this.paths.stateCommitted),
      this.readEnvelopeOptional(this.paths.stateNext),
      this.readEnvelopeOptional(this.paths.statePrevious),
    ]);
    if (committed && sameEnvelope(committed, record.candidate)) return;
    if (committed && !sameEnvelope(committed, record.sourceEnvelope)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "Committed V2 envelope is neither transition source nor target",
      );
    }
    if (previous && !sameEnvelope(previous, record.sourceEnvelope)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "Previous V2 envelope is not the transition source",
      );
    }
    if (staged && !sameEnvelope(staged, record.candidate)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "Staged V2 envelope is not the transition target",
      );
    }

    if (!staged) {
      await this.adapter.write(
        this.paths.stateNext,
        JSON.stringify(record.candidate),
      );
      const reread = await this.readEnvelopeRequired(this.paths.stateNext);
      if (!sameEnvelope(reread, record.candidate)) {
        throw new StateV2ScopeTransitionError(
          "scope-transition-state-ambiguous",
          "V2 scope transition candidate failed staged read-back",
        );
      }
    }
    if (committed) {
      await this.removeIfExists(this.paths.statePrevious);
      await this.adapter.rename(
        this.paths.stateCommitted,
        this.paths.statePrevious,
      );
    } else if (!previous) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "V2 scope transition source envelope disappeared",
      );
    }
    await this.removeIfExists(this.paths.stateCommitted);
    await this.adapter.rename(this.paths.stateNext, this.paths.stateCommitted);
    const target = await this.readEnvelopeRequired(this.paths.stateCommitted);
    if (!sameEnvelope(target, record.candidate)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "V2 scope transition candidate failed committed read-back",
      );
    }
  }

  private async publishTargetManifest(
    source: StateV2Manifest,
    target: StateV2Manifest,
  ): Promise<void> {
    const current = await readStateV2Manifest(
      this.adapter,
      this.paths.manifestCommitted,
    );
    if (current && sameManifest(current, target)) return;
    if (current && !sameManifest(current, source)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "V2 manifest is neither transition source nor target",
      );
    }
    const staged = await readStateV2Manifest(
      this.adapter,
      this.paths.manifestNext,
    );
    if (staged && !sameManifest(staged, target)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "Staged V2 manifest is not the transition target",
      );
    }
    if (!staged) {
      await this.adapter.write(
        this.paths.manifestNext,
        JSON.stringify(target),
      );
      const reread = await readStateV2Manifest(
        this.adapter,
        this.paths.manifestNext,
      );
      if (!reread || !sameManifest(reread, target)) {
        throw new StateV2ScopeTransitionError(
          "scope-transition-state-ambiguous",
          "V2 scope transition manifest failed staged read-back",
        );
      }
    }
    await this.removeIfExists(this.paths.manifestCommitted);
    await this.adapter.rename(
      this.paths.manifestNext,
      this.paths.manifestCommitted,
    );
  }

  private async loadControlRecord():
    Promise<StateV2ScopeTransitionRecord | null> {
    const committedPresent = await this.adapter.exists(
      this.paths.transitionCommitted,
    );
    const stagedPresent = await this.adapter.exists(this.paths.transitionNext);
    let committed: StateV2ScopeTransitionRecord | null = null;
    if (committedPresent) {
      committed = await this.readControlRecordRequired(
        this.paths.transitionCommitted,
      );
    }
    if (!stagedPresent) return committed;
    let staged: StateV2ScopeTransitionRecord;
    try {
      staged = await this.readControlRecordRequired(this.paths.transitionNext);
    } catch (error) {
      if (!committed) {
        await this.removeIfExists(this.paths.transitionNext);
        return null;
      }
      throw error;
    }
    if (committed) {
      if (!sameRecord(committed, staged, false)) {
        throw new StateV2ScopeTransitionError(
          "scope-transition-state-ambiguous",
          "V2 scope transition slots disagree",
        );
      }
      await this.removeIfExists(this.paths.transitionNext);
      return committed;
    }
    await this.adapter.rename(
      this.paths.transitionNext,
      this.paths.transitionCommitted,
    );
    return staged;
  }

  private async publishControlRecord(
    record: StateV2ScopeTransitionRecord,
  ): Promise<void> {
    await this.removeIfExists(this.paths.transitionNext);
    await this.adapter.write(
      this.paths.transitionNext,
      JSON.stringify(record),
    );
    const staged = await this.readControlRecordRequired(
      this.paths.transitionNext,
    );
    if (!sameRecord(staged, record, false)) {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "V2 scope transition control record failed staged read-back",
      );
    }
    await this.adapter.rename(
      this.paths.transitionNext,
      this.paths.transitionCommitted,
    );
  }

  private async readControlRecordRequired(
    path: string,
  ): Promise<StateV2ScopeTransitionRecord> {
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch {
      throw new StateV2ScopeTransitionError(
        "scope-transition-unreadable",
        "V2 scope transition control record is unreadable",
      );
    }
    try {
      validateTransitionRecord(value);
    } catch {
      throw new StateV2ScopeTransitionError(
        "scope-transition-unsupported",
        "V2 scope transition control record is unsupported",
      );
    }
    return value;
  }

  private async readEnvelopeOptional(
    path: string,
  ): Promise<SyncStateEnvelopeV2 | null> {
    if (!await this.adapter.exists(path)) return null;
    return this.readEnvelopeRequired(path);
  }

  private async readEnvelopeRequired(
    path: string,
  ): Promise<SyncStateEnvelopeV2> {
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
      validateEnvelope(value);
    } catch {
      throw new StateV2ScopeTransitionError(
        "scope-transition-state-ambiguous",
        "V2 scope transition envelope is unreadable or unsupported",
      );
    }
    return value;
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

export function validateTransitionRecord(
  value: unknown,
): asserts value is StateV2ScopeTransitionRecord {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "state-v2-scope-transition"
    || !Number.isFinite(value.createdAt)
    || !Number.isSafeInteger(value.sourceWitnessRevision)
    || Number(value.sourceWitnessRevision) < 1
    || !("sourceEnvelope" in value)
    || !("candidate" in value)
    || !("sourceManifest" in value)
    || (
      value.nextProtocolBinding !== undefined
      && !isSharedSyncProtocolBinding(value.nextProtocolBinding)
    )
  ) {
    throw new Error("V2 scope transition control record is incomplete");
  }
  validateEnvelope(value.sourceEnvelope);
  validateEnvelope(value.candidate);
  if (!isManifest(value.sourceManifest)) {
    throw new Error("V2 scope transition source manifest is invalid");
  }
  const source = value.sourceEnvelope;
  const candidate = value.candidate;
  const hold = source.remoteScopeRecovery;
  if (
    !hold
    || hold.observedScope === null
    || candidate.remoteScopeRecovery !== undefined
    || !sameSyncScope(candidate.scope, hold.observedScope)
    || sameSyncScope(source.scope, candidate.scope)
    || source.scope.accountId !== candidate.scope.accountId
    || candidate.meta.commitSeq !== source.meta.commitSeq + 1
    || candidate.meta.lifecycleEpoch !== source.meta.lifecycleEpoch + 1
    || candidate.remoteIndex.complete !== true
    || !candidate.folderAnchors
    || !sameSyncScope(value.sourceManifest.scope, source.scope)
    || value.sourceManifest.stateCommitSeq > source.meta.commitSeq
    || value.sourceManifest.lifecycleEpoch > source.meta.lifecycleEpoch
  ) {
    throw new Error("V2 scope transition facts are inconsistent");
  }
}

function protocolBindingTransitionAllowed(
  current: SharedSyncProtocolBinding | undefined,
  next: SharedSyncProtocolBinding | undefined,
): boolean {
  if (!current || !next) return current === undefined && next === undefined;
  return isSharedSyncProtocolBindingTransitionAllowed(current, next);
}

function targetManifestFor(
  record: StateV2ScopeTransitionRecord,
): StateV2Manifest {
  return {
    schemaVersion: 2,
    activeState: "state-v2.json",
    stateCommitSeq: record.candidate.meta.commitSeq,
    lifecycleEpoch: record.candidate.meta.lifecycleEpoch,
    scope: { ...record.candidate.scope },
    migratedAt: Math.max(
      record.createdAt,
      record.sourceManifest.migratedAt,
    ),
    legacyAutoSyncAllowed: false,
  };
}

function isManifest(value: unknown): value is StateV2Manifest {
  return isRecord(value)
    && value.schemaVersion === 2
    && value.activeState === "state-v2.json"
    && Number.isSafeInteger(value.stateCommitSeq)
    && Number(value.stateCommitSeq) >= 1
    && Number.isSafeInteger(value.lifecycleEpoch)
    && Number(value.lifecycleEpoch) >= 0
    && isSyncScope(value.scope)
    && Number.isFinite(value.migratedAt)
    && value.legacyAutoSyncAllowed === false;
}

function sameEnvelope(
  left: SyncStateEnvelopeV2,
  right: SyncStateEnvelopeV2,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameManifest(
  left: StateV2Manifest,
  right: StateV2Manifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRecord(
  left: StateV2ScopeTransitionRecord,
  right: StateV2ScopeTransitionRecord,
  ignoreCreatedAt: boolean,
): boolean {
  return JSON.stringify({
    ...left,
    ...(ignoreCreatedAt ? { createdAt: 0 } : {}),
  }) === JSON.stringify({
    ...right,
    ...(ignoreCreatedAt ? { createdAt: 0 } : {}),
  });
}
