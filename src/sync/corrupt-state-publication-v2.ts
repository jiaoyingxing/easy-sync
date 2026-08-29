import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";
import { isRecord } from "../obsidian-compat";
import {
  validateCorruptStateRecoveryHoldV2,
  type CorruptStateRecoveryHoldV2,
} from "./corrupt-state-recovery-hold-v2";
import {
  validateEnvelope,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  sameStateV2AuthorityManifest,
  StateV2AuthorityWitnessStore,
  validateStateV2AuthorityWitness,
  type StateV2ActiveAuthorityWitness,
  type StateV2AuthorityWitnessPaths,
} from "./state-v2-authority-witness";
import {
  isStateV2Manifest,
  readStateV2Manifest,
  type StateV2Manifest,
} from "./state-v2-migration";
import { sameSyncScope } from "./types";

export interface CorruptStatePublicationV2Paths {
  stateCommitted: string;
  stateNext: string;
  statePrevious: string;
  stateRecovery: string;
  manifestCommitted: string;
  manifestNext: string;
  witness: StateV2AuthorityWitnessPaths;
  scopeTransitionCommitted: string;
  scopeTransitionNext: string;
  forensicSourcePrefix: string;
  publicationCommitted: string;
  publicationNext: string;
}

export interface CorruptStatePublicationV2Record {
  schemaVersion: 1;
  kind: "v2-corrupt-state-publication";
  createdAt: number;
  confirmedHold: CorruptStateRecoveryHoldV2;
  sourceManifest: StateV2Manifest;
  sourceWitness: StateV2ActiveAuthorityWitness;
}

export interface CorruptStatePublicationV2Recovery {
  record: CorruptStatePublicationV2Record;
  envelope: SyncStateEnvelopeV2;
  manifest: StateV2Manifest;
}

export type CorruptStatePublicationV2FailureReason =
  | "corrupt-state-publication-presence-unreadable"
  | "corrupt-state-publication-unreadable"
  | "corrupt-state-publication-unsupported"
  | "corrupt-state-publication-state-ambiguous";

export class CorruptStatePublicationV2Error extends Error {
  constructor(
    readonly reason: CorruptStatePublicationV2FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "CorruptStatePublicationV2Error";
  }
}

type StateSlot =
  | { status: "missing" }
  | { status: "source"; raw: string }
  | { status: "target"; envelope: SyncStateEnvelopeV2 }
  | { status: "unexpected" };

/**
 * Source-bound, roll-forward-only authority transaction for a reviewed
 * RemoteIndexV2 / anchor reconstruction.
 *
 * The control record embeds the complete confirmed hold before any authority
 * file changes. Once committed, every restart converges on the exact candidate,
 * then advances the same-scope manifest and witness. It never owns Graph or
 * user-file mutation capability.
 */
export class CorruptStatePublicationV2Store {
  constructor(
    private readonly adapter: DataAdapter,
    readonly paths: CorruptStatePublicationV2Paths,
  ) {}

  async hasControlRecord(): Promise<boolean> {
    try {
      return await this.adapter.exists(this.paths.publicationCommitted)
        || await this.adapter.exists(this.paths.publicationNext);
    } catch {
      throw new CorruptStatePublicationV2Error(
        "corrupt-state-publication-presence-unreadable",
        "V2 corrupt-state publication presence is unreadable",
      );
    }
  }

  async commit(input: {
    confirmedHold: CorruptStateRecoveryHoldV2;
    sourceManifest: StateV2Manifest;
    sourceWitness: StateV2ActiveAuthorityWitness;
    now?: number;
  }): Promise<CorruptStatePublicationV2Recovery> {
    const record: CorruptStatePublicationV2Record = {
      schemaVersion: 1,
      kind: "v2-corrupt-state-publication",
      createdAt: input.now ?? Date.now(),
      confirmedHold: structuredClone(input.confirmedHold),
      sourceManifest: structuredClone(input.sourceManifest),
      sourceWitness: structuredClone(input.sourceWitness),
    };
    validateCorruptStatePublicationV2Record(record);
    const existing = await this.loadControlRecord();
    if (existing && !sameRecord(existing, record, true)) {
      throw this.ambiguous(
        "Another V2 corrupt-state publication is already committed",
      );
    }
    if (!existing) await this.publishControlRecord(record);
    return this.rollForward(existing ?? record);
  }

  async recover(): Promise<CorruptStatePublicationV2Recovery | null> {
    const record = await this.loadControlRecord();
    return record ? this.rollForward(record) : null;
  }

  /**
   * Remove transaction slots only after StateManager has retired the
   * no-longer-needed corrupt-state hold. The immutable forensic source remains
   * available for diagnostics after completion.
   */
  async finalize(record: CorruptStatePublicationV2Record): Promise<void> {
    validateCorruptStatePublicationV2Record(record);
    const active = await this.verifyConvergedAuthority(record);
    if (!sameEnvelope(active.envelope, record.confirmedHold.candidate)) {
      throw this.ambiguous(
        "V2 corrupt-state publication changed before finalization",
      );
    }
    await this.verifyCleanupSlots(record);
    await this.removeIfExists(this.paths.statePrevious);
    await this.removeIfExists(this.paths.stateNext);
    await this.removeIfExists(this.paths.manifestNext);
    await this.removeIfExists(this.paths.publicationNext);
    await this.removeIfExists(this.paths.publicationCommitted);
  }

  private async verifyCleanupSlots(
    record: CorruptStatePublicationV2Record,
  ): Promise<void> {
    const previous = await this.classifyStateSlot(
      this.paths.statePrevious,
      record,
    );
    const staged = await this.classifyStateSlot(
      this.paths.stateNext,
      record,
    );
    if (
      (previous.status !== "missing" && previous.status !== "source")
      || (staged.status !== "missing" && staged.status !== "target")
    ) {
      throw this.ambiguous(
        "V2 corrupt-state envelope cleanup slots are not owned by this transaction",
      );
    }

    let stagedManifest: StateV2Manifest | null;
    try {
      stagedManifest = await readStateV2Manifest(
        this.adapter,
        this.paths.manifestNext,
      );
    } catch {
      throw this.ambiguous(
        "V2 corrupt-state staged manifest is not owned by this transaction",
      );
    }
    if (
      stagedManifest
      && !sameManifest(stagedManifest, targetManifestFor(record))
    ) {
      throw this.ambiguous(
        "V2 corrupt-state staged manifest is not owned by this transaction",
      );
    }

    const stagedRecord = await this.readControlRecordOptional(
      this.paths.publicationNext,
    );
    const committedRecord = await this.readControlRecordOptional(
      this.paths.publicationCommitted,
    );
    if (
      (stagedRecord && !sameRecord(stagedRecord, record, false))
      || (committedRecord && !sameRecord(committedRecord, record, false))
    ) {
      throw this.ambiguous(
        "V2 corrupt-state journal cleanup slots are not owned by this transaction",
      );
    }
  }

  private async rollForward(
    record: CorruptStatePublicationV2Record,
  ): Promise<CorruptStatePublicationV2Recovery> {
    validateCorruptStatePublicationV2Record(record);
    await this.assertNoCompetingRecovery();
    await this.verifyForensicSource(record);
    await this.verifyAuthorityPrefix(record);
    await this.publishCandidateEnvelope(record);
    const targetManifest = targetManifestFor(record);
    await this.publishTargetManifest(record.sourceManifest, targetManifest);
    const witnessStore = new StateV2AuthorityWitnessStore(
      this.adapter,
      this.paths.witness,
    );
    await witnessStore.repairActive({
      expectedManifest: record.sourceManifest,
      expectedRevision: record.sourceWitness.revision,
      nextManifest: targetManifest,
      now: record.createdAt,
    });
    const active = await this.verifyConvergedAuthority(record);
    return {
      record: structuredClone(record),
      envelope: active.envelope,
      manifest: active.manifest,
    };
  }

  private async assertNoCompetingRecovery(): Promise<void> {
    let conflicts: boolean;
    try {
      conflicts = await this.adapter.exists(this.paths.stateRecovery)
        || await this.adapter.exists(this.paths.scopeTransitionCommitted)
        || await this.adapter.exists(this.paths.scopeTransitionNext);
    } catch {
      throw this.ambiguous(
        "V2 corrupt-state publication recovery presence is unreadable",
      );
    }
    if (conflicts) {
      throw this.ambiguous(
        "V2 corrupt-state publication conflicts with another state recovery",
      );
    }
  }

  private async verifyForensicSource(
    record: CorruptStatePublicationV2Record,
  ): Promise<void> {
    const sourcePath =
      `${this.paths.forensicSourcePrefix}${record.confirmedHold.sourceDigest}.json`;
    let raw: string;
    try {
      raw = await this.adapter.read(sourcePath);
    } catch {
      throw this.ambiguous(
        "V2 corrupt-state forensic source is unavailable",
      );
    }
    if (await digestText(raw) !== record.confirmedHold.sourceDigest) {
      throw this.ambiguous(
        "V2 corrupt-state forensic source digest changed",
      );
    }
  }

  /**
   * Before envelope publication the manifest/witness must be the source pair.
   * After a crash, manifest may already be target while witness is source or
   * target. Witness-target with manifest-source is never a valid prefix.
   */
  private async verifyAuthorityPrefix(
    record: CorruptStatePublicationV2Record,
  ): Promise<void> {
    const target = targetManifestFor(record);
    const manifest = await readStateV2Manifest(
      this.adapter,
      this.paths.manifestCommitted,
    );
    const stagedManifest = await readStateV2Manifest(
      this.adapter,
      this.paths.manifestNext,
    );
    const witness = await new StateV2AuthorityWitnessStore(
      this.adapter,
      this.paths.witness,
    ).load();
    if (!witness || witness.status !== "active") {
      throw this.ambiguous(
        "V2 corrupt-state publication authority is incomplete",
      );
    }
    const manifestIsSource =
      manifest !== null && sameManifest(manifest, record.sourceManifest);
    const manifestIsTarget =
      manifest !== null && sameManifest(manifest, target);
    const stagedManifestIsTarget =
      stagedManifest !== null && sameManifest(stagedManifest, target);
    const witnessIsSource = sameWitness(witness, record.sourceWitness);
    const witnessIsTarget = sameManifest(witness.manifest, target);
    if (
      (
        !manifestIsSource
        && !manifestIsTarget
        && !(manifest === null && stagedManifestIsTarget)
      )
      || (
        stagedManifest !== null
        && !stagedManifestIsTarget
      )
      || (!witnessIsSource && !witnessIsTarget)
      || (manifestIsSource && !witnessIsSource)
      || (manifest === null && !witnessIsSource)
      || (manifestIsTarget && !witnessIsSource && !witnessIsTarget)
    ) {
      throw this.ambiguous(
        "V2 corrupt-state publication authority is neither source nor target",
      );
    }
  }

  private async publishCandidateEnvelope(
    record: CorruptStatePublicationV2Record,
  ): Promise<void> {
    const candidate = record.confirmedHold.candidate;
    let [committed, staged, previous] = await Promise.all([
      this.classifyStateSlot(this.paths.stateCommitted, record),
      this.classifyStateSlot(this.paths.stateNext, record),
      this.classifyStateSlot(this.paths.statePrevious, record),
    ]);
    if (committed.status === "target") return;
    if (
      committed.status === "unexpected"
      || staged.status === "source"
      || staged.status === "unexpected"
      || previous.status === "target"
      || previous.status === "unexpected"
    ) {
      throw this.ambiguous(
        "V2 corrupt-state envelope slots are not a publication prefix",
      );
    }
    if (committed.status === "missing" && previous.status === "missing") {
      throw this.ambiguous(
        "V2 corrupt-state source envelope disappeared",
      );
    }

    if (staged.status === "missing") {
      await this.writeExact(
        this.paths.stateNext,
        JSON.stringify(candidate),
      );
      staged = await this.classifyStateSlot(this.paths.stateNext, record);
      if (staged.status !== "target") {
        throw this.ambiguous(
          "V2 corrupt-state candidate failed staged read-back",
        );
      }
    }

    if (committed.status === "source") {
      if (previous.status === "missing") {
        try {
          await this.adapter.rename(
            this.paths.stateCommitted,
            this.paths.statePrevious,
          );
        } catch (error) {
          const after = await this.classifyStateSlot(
            this.paths.statePrevious,
            record,
          );
          if (after.status !== "source") throw error;
        }
      } else {
        // A response-lost adapter may leave both paths readable. The immutable
        // forensic copy and exact previous slot prove the source before removal.
        await this.removeIfExists(this.paths.stateCommitted);
      }
    }

    committed = await this.classifyStateSlot(
      this.paths.stateCommitted,
      record,
    );
    if (committed.status !== "missing") {
      if (committed.status === "target") return;
      throw this.ambiguous(
        "V2 corrupt-state committed slot did not retire its source",
      );
    }
    try {
      await this.adapter.rename(
        this.paths.stateNext,
        this.paths.stateCommitted,
      );
    } catch (error) {
      const after = await this.classifyStateSlot(
        this.paths.stateCommitted,
        record,
      );
      if (after.status !== "target") throw error;
    }
    const published = await this.classifyStateSlot(
      this.paths.stateCommitted,
      record,
    );
    if (published.status !== "target") {
      throw this.ambiguous(
        "V2 corrupt-state candidate failed committed read-back",
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
      throw this.ambiguous(
        "V2 manifest is neither corrupt-state source nor target",
      );
    }
    const staged = await readStateV2Manifest(
      this.adapter,
      this.paths.manifestNext,
    );
    if (staged && !sameManifest(staged, target)) {
      throw this.ambiguous(
        "Staged V2 manifest is not the corrupt-state target",
      );
    }
    if (!staged) {
      if (!current) {
        throw this.ambiguous(
          "V2 corrupt-state source manifest disappeared",
        );
      }
      await this.writeExact(
        this.paths.manifestNext,
        JSON.stringify(target),
      );
      const reread = await readStateV2Manifest(
        this.adapter,
        this.paths.manifestNext,
      );
      if (!reread || !sameManifest(reread, target)) {
        throw this.ambiguous(
          "V2 corrupt-state manifest failed staged read-back",
        );
      }
    }
    if (current) await this.removeIfExists(this.paths.manifestCommitted);
    try {
      await this.adapter.rename(
        this.paths.manifestNext,
        this.paths.manifestCommitted,
      );
    } catch (error) {
      const committed = await readStateV2Manifest(
        this.adapter,
        this.paths.manifestCommitted,
      );
      if (!committed || !sameManifest(committed, target)) throw error;
    }
  }

  private async verifyConvergedAuthority(
    record: CorruptStatePublicationV2Record,
  ): Promise<{
    envelope: SyncStateEnvelopeV2;
    manifest: StateV2Manifest;
  }> {
    await this.verifyForensicSource(record);
    const slot = await this.classifyStateSlot(
      this.paths.stateCommitted,
      record,
    );
    const manifest = await readStateV2Manifest(
      this.adapter,
      this.paths.manifestCommitted,
    );
    const witness = await new StateV2AuthorityWitnessStore(
      this.adapter,
      this.paths.witness,
    ).load();
    const target = targetManifestFor(record);
    if (
      slot.status !== "target"
      || !manifest
      || !sameManifest(manifest, target)
      || !witness
      || witness.status !== "active"
      || !sameStateV2AuthorityManifest(witness, target)
    ) {
      throw this.ambiguous(
        "V2 corrupt-state publication did not converge on one authority",
      );
    }
    return { envelope: slot.envelope, manifest };
  }

  private async classifyStateSlot(
    path: string,
    record: CorruptStatePublicationV2Record,
  ): Promise<StateSlot> {
    try {
      if (!await this.adapter.exists(path)) return { status: "missing" };
    } catch {
      return { status: "unexpected" };
    }
    let raw: string;
    try {
      raw = await this.adapter.read(path);
    } catch {
      return { status: "unexpected" };
    }
    if (await digestText(raw) === record.confirmedHold.sourceDigest) {
      return { status: "source", raw };
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
      validateEnvelope(value);
    } catch {
      return { status: "unexpected" };
    }
    return sameEnvelope(value, record.confirmedHold.candidate)
      ? { status: "target", envelope: value }
      : { status: "unexpected" };
  }

  private async loadControlRecord():
    Promise<CorruptStatePublicationV2Record | null> {
    let committedPresent: boolean;
    let stagedPresent: boolean;
    try {
      [committedPresent, stagedPresent] = await Promise.all([
        this.adapter.exists(this.paths.publicationCommitted),
        this.adapter.exists(this.paths.publicationNext),
      ]);
    } catch {
      throw new CorruptStatePublicationV2Error(
        "corrupt-state-publication-presence-unreadable",
        "V2 corrupt-state publication presence is unreadable",
      );
    }
    const committed = committedPresent
      ? await this.readControlRecordRequired(this.paths.publicationCommitted)
      : null;
    if (!stagedPresent) return committed;
    let staged: CorruptStatePublicationV2Record;
    try {
      staged = await this.readControlRecordRequired(
        this.paths.publicationNext,
      );
    } catch {
      if (!committed) {
        await this.removeIfExists(this.paths.publicationNext);
        return null;
      }
      await this.removeIfExists(this.paths.publicationNext);
      return committed;
    }
    if (committed) {
      if (!sameRecord(committed, staged, false)) {
        throw this.ambiguous(
          "V2 corrupt-state publication slots disagree",
        );
      }
      await this.removeIfExists(this.paths.publicationNext);
      return committed;
    }
    try {
      await this.adapter.rename(
        this.paths.publicationNext,
        this.paths.publicationCommitted,
      );
    } catch (error) {
      const promoted = await this.readControlRecordOptional(
        this.paths.publicationCommitted,
      );
      if (!promoted || !sameRecord(promoted, staged, false)) throw error;
    }
    return staged;
  }

  private async publishControlRecord(
    record: CorruptStatePublicationV2Record,
  ): Promise<void> {
    await this.removeIfExists(this.paths.publicationNext);
    await this.writeExact(
      this.paths.publicationNext,
      JSON.stringify(record),
    );
    const staged = await this.readControlRecordRequired(
      this.paths.publicationNext,
    );
    if (!sameRecord(staged, record, false)) {
      throw this.ambiguous(
        "V2 corrupt-state publication failed staged read-back",
      );
    }
    try {
      await this.adapter.rename(
        this.paths.publicationNext,
        this.paths.publicationCommitted,
      );
    } catch (error) {
      const committed = await this.readControlRecordOptional(
        this.paths.publicationCommitted,
      );
      if (!committed || !sameRecord(committed, record, false)) throw error;
    }
    const committed = await this.readControlRecordRequired(
      this.paths.publicationCommitted,
    );
    if (!sameRecord(committed, record, false)) {
      throw this.ambiguous(
        "V2 corrupt-state publication failed committed read-back",
      );
    }
  }

  private async readControlRecordOptional(
    path: string,
  ): Promise<CorruptStatePublicationV2Record | null> {
    try {
      if (!await this.adapter.exists(path)) return null;
    } catch {
      throw new CorruptStatePublicationV2Error(
        "corrupt-state-publication-presence-unreadable",
        "V2 corrupt-state publication presence is unreadable",
      );
    }
    return this.readControlRecordRequired(path);
  }

  private async readControlRecordRequired(
    path: string,
  ): Promise<CorruptStatePublicationV2Record> {
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch {
      throw new CorruptStatePublicationV2Error(
        "corrupt-state-publication-unreadable",
        "V2 corrupt-state publication journal is unreadable",
      );
    }
    try {
      validateCorruptStatePublicationV2Record(value);
    } catch {
      throw new CorruptStatePublicationV2Error(
        "corrupt-state-publication-unsupported",
        "V2 corrupt-state publication journal is unsupported",
      );
    }
    return value;
  }

  private async writeExact(path: string, raw: string): Promise<void> {
    try {
      await this.adapter.write(path, raw);
    } catch (error) {
      try {
        if (await this.adapter.read(path) !== raw) throw error;
      } catch {
        throw error;
      }
    }
    try {
      if (await this.adapter.read(path) !== raw) {
        throw this.ambiguous(
          "V2 corrupt-state publication write failed exact read-back",
        );
      }
    } catch (error) {
      if (error instanceof CorruptStatePublicationV2Error) throw error;
      throw this.ambiguous(
        "V2 corrupt-state publication write is unreadable",
      );
    }
  }

  private async removeIfExists(path: string): Promise<void> {
    try {
      if (!await this.adapter.exists(path)) return;
    } catch {
      throw this.ambiguous(
        "V2 corrupt-state publication cleanup presence is unreadable",
      );
    }
    try {
      await this.adapter.remove(path);
    } catch (error) {
      try {
        if (await this.adapter.exists(path)) throw error;
      } catch (presenceError) {
        if (presenceError === error) throw error;
        throw this.ambiguous(
          "V2 corrupt-state publication cleanup result is unreadable",
        );
      }
    }
  }

  private ambiguous(message: string): CorruptStatePublicationV2Error {
    return new CorruptStatePublicationV2Error(
      "corrupt-state-publication-state-ambiguous",
      message,
    );
  }
}

export function validateCorruptStatePublicationV2Record(
  value: unknown,
): asserts value is CorruptStatePublicationV2Record {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "v2-corrupt-state-publication"
    || !Number.isFinite(value.createdAt)
    || !("confirmedHold" in value)
    || !("sourceManifest" in value)
    || !("sourceWitness" in value)
  ) {
    throw new Error("V2 corrupt-state publication record is incomplete");
  }
  validateCorruptStateRecoveryHoldV2(value.confirmedHold);
  validateStateV2AuthorityWitness(value.sourceWitness);
  if (!isStateV2Manifest(value.sourceManifest)) {
    throw new Error("V2 corrupt-state source manifest is invalid");
  }
  const record = value as unknown as CorruptStatePublicationV2Record;
  const hold = record.confirmedHold;
  if (
    hold.phase !== "confirmed"
    || record.sourceWitness.status !== "active"
    || !sameStateV2AuthorityManifest(
      record.sourceWitness,
      record.sourceManifest,
    )
    || !sameSyncScope(record.sourceManifest.scope, hold.scope)
    || record.sourceManifest.stateCommitSeq > hold.sourceCommitSeq
    || record.sourceManifest.lifecycleEpoch > hold.sourceLifecycleEpoch
    || hold.candidate.meta.commitSeq !== hold.sourceCommitSeq + 1
    || hold.candidate.meta.lifecycleEpoch !== hold.sourceLifecycleEpoch + 1
    || hold.candidate.remoteIndex.complete !== true
    || hold.candidate.folderAnchors === undefined
    || hold.candidate.remoteScopeRecovery !== undefined
  ) {
    throw new Error(
      "V2 corrupt-state publication source facts are inconsistent",
    );
  }
}

function targetManifestFor(
  record: CorruptStatePublicationV2Record,
): StateV2Manifest {
  const candidate = record.confirmedHold.candidate;
  return {
    schemaVersion: 2,
    activeState: "state-v2.json",
    stateCommitSeq: candidate.meta.commitSeq,
    lifecycleEpoch: candidate.meta.lifecycleEpoch,
    scope: { ...candidate.scope },
    // This is an in-place V2 authority repair, not another V1→V2 migration.
    migratedAt: record.sourceManifest.migratedAt,
    legacyAutoSyncAllowed: false,
  };
}

function sameRecord(
  left: CorruptStatePublicationV2Record,
  right: CorruptStatePublicationV2Record,
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

function sameWitness(
  left: StateV2ActiveAuthorityWitness,
  right: StateV2ActiveAuthorityWitness,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function digestText(raw: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(raw).buffer);
}
