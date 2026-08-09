/**
 * Vault-local recovery records for a future active IndexedDB authority.
 *
 * These immutable records are never runtime authority and are not planner
 * input. They may only rebuild a new database after the selected IndexedDB
 * authority is missing and the complete committed record chain is exact.
 * StateManager/manifest wiring remains a separate cutover decision.
 */

import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";
import type { RemoteNodeV2 } from "./remote-index-v2";
import {
  stateV2EnvelopeHeader,
  validateEnvelope,
  type FolderAnchorV2,
  type StateV2EnvelopeHeader,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import { sameSyncScope } from "./types";

const CHECKPOINT_PREFIX = "checkpoint-";
const COMMIT_PREFIX = "commit-";
const COMMIT_WITNESS_PREFIX = "confirmed-";
const FILE_SUFFIX = ".json";
const STAGED_SUFFIX = ".next";

interface StateV2IndexedDbRecoveryCheckpointV1 {
  schemaVersion: 1;
  kind: "indexeddb-recovery-checkpoint";
  commitSeq: number;
  lifecycleEpoch: number;
  envelopeDigest: string;
  envelope: SyncStateEnvelopeV2;
  recordDigest: string;
}

interface StateV2IndexedDbRecoveryDeltaV1 {
  schemaVersion: 1;
  kind: "indexeddb-recovery-delta";
  previousCommitSeq: number;
  nextCommitSeq: number;
  previousEnvelopeDigest: string;
  nextEnvelopeDigest: string;
  nextHeader: StateV2EnvelopeHeader;
  remoteNodeUpserts: RemoteNodeV2[];
  remoteNodeDeletes: string[];
  anchorUpserts: SyncAnchorV2[];
  anchorDeletes: string[];
  folderAnchorUpserts: FolderAnchorV2[];
  folderAnchorDeletes: string[];
  recordDigest: string;
}

interface StateV2IndexedDbRecoveryCommitWitnessV1 {
  schemaVersion: 1;
  kind: "indexeddb-recovery-commit-witness";
  commitSeq: number;
  envelopeDigest: string;
  deltaRecordDigest: string;
  recordDigest: string;
}

export interface StateV2IndexedDbPreparedRecoveryDelta {
  previousCommitSeq: number;
  nextCommitSeq: number;
  previousEnvelopeDigest: string;
  nextEnvelopeDigest: string;
  recordDigest: string;
  remoteNodes: StateV2IndexedDbRecoveryRowChanges<RemoteNodeV2>;
  anchors: StateV2IndexedDbRecoveryRowChanges<SyncAnchorV2>;
  folderAnchors: StateV2IndexedDbRecoveryRowChanges<FolderAnchorV2>;
}

export interface StateV2IndexedDbRecoveryRowChanges<T> {
  upserts: T[];
  deletes: string[];
}

interface StateV2IndexedDbFutureDeltaSnapshot {
  path: string;
  raw: string;
  delta: StateV2IndexedDbRecoveryDeltaV1;
}

export class StateV2IndexedDbRecoveryStore {
  constructor(
    private readonly adapter: DataAdapter,
    readonly directory: string,
  ) {
    if (!directory || directory.endsWith("/")) {
      throw new Error(
        "IndexedDB recovery POC directory must be a non-empty normalized path",
      );
    }
  }

  checkpointPath(commitSeq: number): string {
    return `${this.directory}/${CHECKPOINT_PREFIX}${formatSeq(commitSeq)}${FILE_SUFFIX}`;
  }

  deltaPath(nextCommitSeq: number): string {
    return `${this.directory}/${COMMIT_PREFIX}${formatSeq(nextCommitSeq)}${FILE_SUFFIX}`;
  }

  commitWitnessPath(commitSeq: number): string {
    return `${this.directory}/${COMMIT_WITNESS_PREFIX}${formatSeq(commitSeq)}${FILE_SUFFIX}`;
  }

  async needsCommitWitness(commitSeq: number): Promise<boolean> {
    await this.ensureDirectory();
    await this.recoverStagedRecords();
    const deltaPath = this.deltaPath(commitSeq);
    const witnessPath = this.commitWitnessPath(commitSeq);
    const [hasDelta, hasWitness] = await Promise.all([
      this.adapter.exists(deltaPath),
      this.adapter.exists(witnessPath),
    ]);
    if (!hasDelta) {
      if (hasWitness) {
        await this.readCommitWitness(witnessPath);
        throw new Error(
          "IndexedDB recovery commit witness is missing its delta",
        );
      }
      return false;
    }
    const delta = await this.readDelta(deltaPath);
    if (!hasWitness) return true;
    const witness = await this.readCommitWitness(witnessPath);
    if (
      witness.envelopeDigest !== delta.nextEnvelopeDigest
      || witness.deltaRecordDigest !== delta.recordDigest
    ) {
      throw new Error(
        "IndexedDB recovery commit witness does not bind its delta",
      );
    }
    return false;
  }

  async publishCheckpoint(
    envelope: SyncStateEnvelopeV2,
  ): Promise<void> {
    validateEnvelope(envelope);
    await this.ensureDirectory();
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "indexeddb-recovery-checkpoint" as const,
      commitSeq: envelope.meta.commitSeq,
      lifecycleEpoch: envelope.meta.lifecycleEpoch,
      envelopeDigest: await digestValidatedEnvelope(envelope),
      envelope: structuredClone(envelope),
    };
    const checkpoint: StateV2IndexedDbRecoveryCheckpointV1 = {
      ...unsigned,
      recordDigest: await canonicalRecordDigest(unsigned),
    };
    await this.publishImmutable(
      this.checkpointPath(envelope.meta.commitSeq),
      checkpoint,
    );
  }

  async prepareDelta(
    previous: SyncStateEnvelopeV2,
    next: SyncStateEnvelopeV2,
    options: {
      previousEnvelopeDigest?: string;
    } = {},
  ): Promise<StateV2IndexedDbPreparedRecoveryDelta> {
    validateEnvelope(previous);
    validateEnvelope(next);
    return this.prepareValidatedDelta(previous, next, options);
  }

  /**
   * Hot-path variant for an owner that already validated and retained the
   * exact previous envelope, and has validated the exact next envelope once.
   * Callers must not pass independently reconstructed or unchecked values.
   */
  async prepareValidatedDelta(
    previous: SyncStateEnvelopeV2,
    next: SyncStateEnvelopeV2,
    options: {
      previousEnvelopeDigest?: string;
    } = {},
  ): Promise<StateV2IndexedDbPreparedRecoveryDelta> {
    if (!sameSyncScope(previous.scope, next.scope)) {
      throw new Error("IndexedDB recovery delta cannot change sync scope");
    }
    if (next.meta.commitSeq !== previous.meta.commitSeq + 1) {
      throw new Error(
        "IndexedDB recovery delta must advance exactly one commit sequence",
      );
    }
    if (next.meta.lifecycleEpoch < previous.meta.lifecycleEpoch) {
      throw new Error(
        "IndexedDB recovery delta cannot move lifecycle epoch backwards",
      );
    }
    await this.ensureDirectory();
    const remoteNodes = diffRows(
      previous.remoteIndex.itemsById,
      next.remoteIndex.itemsById,
    );
    const anchors = diffRows(
      previous.anchors.byAnchorId,
      next.anchors.byAnchorId,
    );
    const folderAnchors = diffRows(
      previous.folderAnchors?.byAnchorId ?? {},
      next.folderAnchors?.byAnchorId ?? {},
    );
    const previousEnvelopeDigest = options.previousEnvelopeDigest
      ?? await digestValidatedEnvelope(previous);
    if (!isSha256Hex(previousEnvelopeDigest)) {
      throw new Error(
        "IndexedDB recovery previous envelope digest is invalid",
      );
    }
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "indexeddb-recovery-delta" as const,
      previousCommitSeq: previous.meta.commitSeq,
      nextCommitSeq: next.meta.commitSeq,
      previousEnvelopeDigest,
      nextEnvelopeDigest:
        await digestValidatedEnvelope(next),
      nextHeader: stateV2EnvelopeHeader(next),
      remoteNodeUpserts: remoteNodes.upserts,
      remoteNodeDeletes: remoteNodes.deletes,
      anchorUpserts: anchors.upserts,
      anchorDeletes: anchors.deletes,
      folderAnchorUpserts: folderAnchors.upserts,
      folderAnchorDeletes: folderAnchors.deletes,
    };
    const delta: StateV2IndexedDbRecoveryDeltaV1 = {
      ...unsigned,
      recordDigest: await canonicalRecordDigest(unsigned),
    };
    await this.publishImmutable(
      this.deltaPath(next.meta.commitSeq),
      delta,
    );
    return {
      previousCommitSeq: delta.previousCommitSeq,
      nextCommitSeq: delta.nextCommitSeq,
      previousEnvelopeDigest: delta.previousEnvelopeDigest,
      nextEnvelopeDigest: delta.nextEnvelopeDigest,
      recordDigest: delta.recordDigest,
      remoteNodes: structuredClone(remoteNodes),
      anchors: structuredClone(anchors),
      folderAnchors: structuredClone(folderAnchors),
    };
  }

  async confirmCommittedDelta(
    committed: SyncStateEnvelopeV2,
    expectedEnvelopeDigest?: string,
  ): Promise<void> {
    validateEnvelope(committed);
    await this.confirmValidatedCommittedDelta(
      committed,
      expectedEnvelopeDigest,
    );
  }

  /**
   * Hot-path variant paired with prepareValidatedDelta. The owner must pass
   * the same validated envelope and digest that its transaction committed.
   */
  async confirmValidatedCommittedDelta(
    committed: SyncStateEnvelopeV2,
    expectedEnvelopeDigest?: string,
  ): Promise<void> {
    await this.ensureDirectory();
    const delta = await this.readDelta(
      this.deltaPath(committed.meta.commitSeq),
    );
    const envelopeDigest = expectedEnvelopeDigest
      ?? await digestValidatedEnvelope(committed);
    if (!isSha256Hex(envelopeDigest)) {
      throw new Error(
        "IndexedDB recovery commit witness digest is invalid",
      );
    }
    if (
      delta.nextCommitSeq !== committed.meta.commitSeq
      || delta.nextEnvelopeDigest !== envelopeDigest
    ) {
      throw new Error(
        "IndexedDB recovery commit witness does not match committed state",
      );
    }
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "indexeddb-recovery-commit-witness" as const,
      commitSeq: committed.meta.commitSeq,
      envelopeDigest,
      deltaRecordDigest: delta.recordDigest,
    };
    const witness: StateV2IndexedDbRecoveryCommitWitnessV1 = {
      ...unsigned,
      recordDigest: await canonicalRecordDigest(unsigned),
    };
    await this.publishImmutable(
      this.commitWitnessPath(committed.meta.commitSeq),
      witness,
    );
  }

  /**
   * Retires exactly one future prepared delta that an already selected and
   * fully verified active database proves was never committed. This is not a
   * database-loss recovery path: callers must reverify the active database
   * before and after the only destructive step.
   */
  async retireUncommittedFutureDelta(
    active: SyncStateEnvelopeV2,
    expectedEnvelopeDigest: string,
    reverifyActive: () => Promise<void>,
  ): Promise<boolean> {
    validateEnvelope(active);
    if (
      !isSha256Hex(expectedEnvelopeDigest)
      || await digestValidatedEnvelope(active) !== expectedEnvelopeDigest
    ) {
      throw new Error(
        "IndexedDB recovery active envelope digest does not match",
      );
    }
    await this.ensureDirectory();
    await this.recoverStagedRecords();
    const observed = await this.readFutureDeltaSnapshot(
      active,
      expectedEnvelopeDigest,
    );
    if (!observed) return false;

    // Protect the exact database revision before removing its disproven tail.
    await this.publishCheckpoint(active);
    await this.assertExactCheckpoint(active, expectedEnvelopeDigest);
    await reverifyActive();

    // Re-read every relevant byte after the checkpoint and database proof.
    await this.recoverStagedRecords();
    const confirmed = await this.readFutureDeltaSnapshot(
      active,
      expectedEnvelopeDigest,
    );
    if (
      !confirmed
      || confirmed.path !== observed.path
      || confirmed.raw !== observed.raw
      || confirmed.delta.recordDigest !== observed.delta.recordDigest
    ) {
      throw new Error(
        "IndexedDB recovery future prepared delta changed during reconciliation",
      );
    }
    if (await this.adapter.exists(`${confirmed.path}${STAGED_SUFFIX}`)) {
      throw new Error(
        "IndexedDB recovery future prepared delta still has staged state",
      );
    }
    if (
      await this.adapter.exists(
        this.commitWitnessPath(confirmed.delta.nextCommitSeq),
      )
    ) {
      throw new Error(
        "IndexedDB recovery future prepared delta gained a commit witness",
      );
    }

    await this.removeExactRecord(confirmed.path, confirmed.raw);
    if (await this.adapter.exists(`${confirmed.path}${STAGED_SUFFIX}`)) {
      throw new Error(
        "IndexedDB recovery future prepared staging survived retirement",
      );
    }
    if (
      await this.readFutureDeltaSnapshot(active, expectedEnvelopeDigest)
        !== null
    ) {
      throw new Error(
        "IndexedDB recovery future prepared delta survived retirement",
      );
    }
    await this.assertExactCheckpoint(active, expectedEnvelopeDigest);
    await reverifyActive();
    return true;
  }

  async rebuild(): Promise<SyncStateEnvelopeV2> {
    await this.ensureDirectory();
    await this.recoverStagedRecords();
    const { files } = await this.adapter.list(this.directory);
    const checkpointPaths = files
      .filter((path) => isCommittedCheckpointPath(this.directory, path))
      .sort();
    if (checkpointPaths.length === 0) {
      throw new Error("IndexedDB recovery checkpoint is missing");
    }
    const checkpoints = await Promise.all(
      checkpointPaths.map((path) => this.readCheckpoint(path)),
    );
    checkpoints.sort((left, right) => left.commitSeq - right.commitSeq);
    const checkpoint = checkpoints[checkpoints.length - 1]!;
    let current = structuredClone(checkpoint.envelope);
    let currentDigest = checkpoint.envelopeDigest;

    const deltaPaths = files
      .filter((path) => isCommittedDeltaPath(this.directory, path))
      .sort();
    const deltas = await Promise.all(
      deltaPaths.map((path) => this.readDelta(path)),
    );
    deltas.sort((left, right) => left.nextCommitSeq - right.nextCommitSeq);
    const commitWitnessPaths = files
      .filter((path) => isCommittedWitnessPath(this.directory, path))
      .sort();
    const commitWitnesses = await Promise.all(
      commitWitnessPaths.map((path) => this.readCommitWitness(path)),
    );
    const witnessByCommitSeq = new Map(
      commitWitnesses.map((witness) => [witness.commitSeq, witness]),
    );
    const deltaByCommitSeq = new Map(
      deltas.map((delta) => [delta.nextCommitSeq, delta]),
    );
    for (const witness of commitWitnesses) {
      if (
        witness.commitSeq > checkpoint.commitSeq
        && !deltaByCommitSeq.has(witness.commitSeq)
      ) {
        throw new Error(
          "IndexedDB recovery commit witness is missing its delta",
        );
      }
    }
    for (const delta of deltas) {
      if (delta.nextCommitSeq <= current.meta.commitSeq) continue;
      const witness = witnessByCommitSeq.get(delta.nextCommitSeq);
      if (!witness) {
        throw new Error(
          "IndexedDB recovery prepared delta has no commit witness",
        );
      }
      if (
        witness.envelopeDigest !== delta.nextEnvelopeDigest
        || witness.deltaRecordDigest !== delta.recordDigest
      ) {
        throw new Error(
          "IndexedDB recovery commit witness does not bind its delta",
        );
      }
      if (
        delta.previousCommitSeq !== current.meta.commitSeq
        || delta.nextCommitSeq !== current.meta.commitSeq + 1
      ) {
        throw new Error(
          "IndexedDB recovery delta sequence contains a gap or branch",
        );
      }
      if (delta.previousEnvelopeDigest !== currentDigest) {
        throw new Error(
          "IndexedDB recovery delta previous digest does not match",
        );
      }
      current = applyDelta(current, delta);
      currentDigest =
        await digestValidatedEnvelope(current);
      if (currentDigest !== delta.nextEnvelopeDigest) {
        throw new Error(
          "IndexedDB recovery delta did not rebuild its bound envelope",
        );
      }
    }
    return current;
  }

  async compact(
    envelope: SyncStateEnvelopeV2,
  ): Promise<void> {
    await this.publishCheckpoint(envelope);
    const exact = await this.readCheckpoint(
      this.checkpointPath(envelope.meta.commitSeq),
    );
    if (
      exact.commitSeq !== envelope.meta.commitSeq
      || exact.envelopeDigest
        !== await digestValidatedEnvelope(envelope)
    ) {
      throw new Error("IndexedDB recovery checkpoint compaction is not exact");
    }
    const { files } = await this.adapter.list(this.directory);
    for (const path of files) {
      const checkpointSeq = parseCommittedSeq(
        this.directory,
        path,
        CHECKPOINT_PREFIX,
      );
      const deltaSeq = parseCommittedSeq(
        this.directory,
        path,
        COMMIT_PREFIX,
      );
      const witnessSeq = parseCommittedSeq(
        this.directory,
        path,
        COMMIT_WITNESS_PREFIX,
      );
      if (
        (checkpointSeq !== null && checkpointSeq < envelope.meta.commitSeq)
        || (deltaSeq !== null && deltaSeq <= envelope.meta.commitSeq)
        || (witnessSeq !== null && witnessSeq <= envelope.meta.commitSeq)
      ) {
        await this.adapter.remove(path);
      }
    }
  }

  async shouldCompact(
    commitSeq: number,
    minimumStaleRecords = 512,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(commitSeq)
      || commitSeq < 1
      || !Number.isSafeInteger(minimumStaleRecords)
      || minimumStaleRecords < 1
    ) {
      throw new Error("IndexedDB recovery compaction threshold is invalid");
    }
    await this.ensureDirectory();
    const { files } = await this.adapter.list(this.directory);
    let staleRecords = 0;
    for (const path of files) {
      const checkpointSeq = parseCommittedSeq(
        this.directory,
        path,
        CHECKPOINT_PREFIX,
      );
      const deltaSeq = parseCommittedSeq(
        this.directory,
        path,
        COMMIT_PREFIX,
      );
      const witnessSeq = parseCommittedSeq(
        this.directory,
        path,
        COMMIT_WITNESS_PREFIX,
      );
      if (
        (checkpointSeq !== null && checkpointSeq < commitSeq)
        || (deltaSeq !== null && deltaSeq <= commitSeq)
        || (witnessSeq !== null && witnessSeq <= commitSeq)
      ) {
        staleRecords += 1;
        if (staleRecords >= minimumStaleRecords) return true;
      }
    }
    return false;
  }

  private async publishImmutable(
    target: string,
    value:
      | StateV2IndexedDbRecoveryCheckpointV1
      | StateV2IndexedDbRecoveryDeltaV1
      | StateV2IndexedDbRecoveryCommitWitnessV1,
  ): Promise<void> {
    const serialized = canonicalJson(value);
    const staged = `${target}${STAGED_SUFFIX}`;
    if (await this.adapter.exists(target)) {
      if (await this.adapter.read(target) !== serialized) {
        throw new Error(
          "IndexedDB recovery target already contains different bytes",
        );
      }
      if (await this.adapter.exists(staged)) {
        if (await this.adapter.read(staged) !== serialized) {
          throw new Error(
            "IndexedDB recovery committed and staged records differ",
          );
        }
        await this.adapter.remove(staged);
      }
      return;
    }
    if (await this.adapter.exists(staged)) {
      if (await this.adapter.read(staged) !== serialized) {
        throw new Error(
          "IndexedDB recovery staging already contains different bytes",
        );
      }
    } else {
      await this.adapter.write(staged, serialized);
    }
    if (await this.adapter.read(staged) !== serialized) {
      throw new Error("IndexedDB recovery staging failed exact read-back");
    }
    await this.adapter.rename(staged, target);
    if (await this.adapter.read(target) !== serialized) {
      throw new Error("IndexedDB recovery record failed committed read-back");
    }
  }

  private async readFutureDeltaSnapshot(
    active: SyncStateEnvelopeV2,
    activeDigest: string,
  ): Promise<StateV2IndexedDbFutureDeltaSnapshot | null> {
    const currentSeq = active.meta.commitSeq;
    const expectedNextSeq = currentSeq + 1;
    const { files } = await this.adapter.list(this.directory);
    let candidate: StateV2IndexedDbFutureDeltaSnapshot | null = null;
    for (const path of files) {
      const checkpointSeq = parseCommittedSeq(
        this.directory,
        path,
        CHECKPOINT_PREFIX,
      );
      if (checkpointSeq !== null && checkpointSeq > currentSeq) {
        await this.readCheckpoint(path);
        throw new Error(
          "IndexedDB recovery future checkpoint blocks delta retirement",
        );
      }
      const witnessSeq = parseCommittedSeq(
        this.directory,
        path,
        COMMIT_WITNESS_PREFIX,
      );
      if (witnessSeq !== null && witnessSeq > currentSeq) {
        await this.readCommitWitness(path);
        throw new Error(
          "IndexedDB recovery future commit witness blocks delta retirement",
        );
      }
      const deltaSeq = parseCommittedSeq(
        this.directory,
        path,
        COMMIT_PREFIX,
      );
      if (deltaSeq === null || deltaSeq <= currentSeq) continue;
      if (deltaSeq !== expectedNextSeq || candidate) {
        await this.readDelta(path);
        throw new Error(
          "IndexedDB recovery future delta contains a gap or branch",
        );
      }
      const raw = await this.adapter.read(path);
      const delta = await this.readDeltaRaw(path, raw);
      candidate = { path, raw, delta };
    }
    if (!candidate) return null;
    const { delta } = candidate;
    if (
      delta.previousCommitSeq !== currentSeq
      || delta.nextCommitSeq !== expectedNextSeq
      || delta.previousEnvelopeDigest !== activeDigest
    ) {
      throw new Error(
        "IndexedDB recovery future delta does not bind the active state",
      );
    }
    if (
      delta.nextHeader.meta.commitSeq !== delta.nextCommitSeq
      || delta.nextHeader.meta.lifecycleEpoch < active.meta.lifecycleEpoch
      || !sameSyncScope(active.scope, delta.nextHeader.scope)
    ) {
      throw new Error(
        "IndexedDB recovery future delta header is inconsistent",
      );
    }
    const reconstructed = applyDelta(active, delta);
    if (
      await digestValidatedEnvelope(reconstructed)
        !== delta.nextEnvelopeDigest
    ) {
      throw new Error(
        "IndexedDB recovery future delta does not rebuild its bound envelope",
      );
    }
    return candidate;
  }

  private async assertExactCheckpoint(
    active: SyncStateEnvelopeV2,
    activeDigest: string,
  ): Promise<void> {
    const exact = await this.readCheckpoint(
      this.checkpointPath(active.meta.commitSeq),
    );
    if (
      exact.commitSeq !== active.meta.commitSeq
      || exact.lifecycleEpoch !== active.meta.lifecycleEpoch
      || exact.envelopeDigest !== activeDigest
    ) {
      throw new Error(
        "IndexedDB recovery protected checkpoint is not exact",
      );
    }
  }

  private async removeExactRecord(
    path: string,
    expectedRaw: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!await this.adapter.exists(path)) return;
      if (await this.adapter.read(path) !== expectedRaw) {
        throw new Error(
          "IndexedDB recovery record changed before retirement",
        );
      }
      try {
        await this.adapter.remove(path);
      } catch (error) {
        if (!await this.adapter.exists(path)) return;
        if (attempt === 1) throw error;
        continue;
      }
      if (!await this.adapter.exists(path)) return;
    }
    throw new Error("IndexedDB recovery record retirement did not complete");
  }

  private async recoverStagedRecords(): Promise<void> {
    const { files } = await this.adapter.list(this.directory);
    const stagedPaths = files
      .filter((path) => path.endsWith(`${FILE_SUFFIX}${STAGED_SUFFIX}`))
      .sort();
    for (const staged of stagedPaths) {
      const target = staged.slice(0, -STAGED_SUFFIX.length);
      const raw = await this.adapter.read(staged);
      if (
        !isCommittedCheckpointPath(this.directory, target)
        && !isCommittedDeltaPath(this.directory, target)
        && !isCommittedWitnessPath(this.directory, target)
      ) {
        throw new Error("IndexedDB recovery staging path is unsupported");
      }
      await validateRecordRaw(raw);
      if (await this.adapter.exists(target)) {
        if (await this.adapter.read(target) !== raw) {
          throw new Error(
            "IndexedDB recovery committed and staged records differ",
          );
        }
        await this.adapter.remove(staged);
        continue;
      }
      await this.adapter.rename(staged, target);
      if (await this.adapter.read(target) !== raw) {
        throw new Error(
          "IndexedDB recovery staged promotion failed read-back",
        );
      }
    }
  }

  private async readCheckpoint(
    path: string,
  ): Promise<StateV2IndexedDbRecoveryCheckpointV1> {
    const value = await parseAndVerifyRecord(await this.adapter.read(path));
    if (value.kind !== "indexeddb-recovery-checkpoint") {
      throw new Error("IndexedDB recovery checkpoint kind is invalid");
    }
    const pathSeq = parseCommittedSeq(
      this.directory,
      path,
      CHECKPOINT_PREFIX,
    );
    if (pathSeq !== value.commitSeq) {
      throw new Error(
        "IndexedDB recovery checkpoint path sequence does not match",
      );
    }
    validateEnvelope(value.envelope);
    if (
      value.commitSeq !== value.envelope.meta.commitSeq
      || value.lifecycleEpoch !== value.envelope.meta.lifecycleEpoch
      || value.envelopeDigest
        !== await digestValidatedEnvelope(value.envelope)
    ) {
      throw new Error("IndexedDB recovery checkpoint envelope is not exact");
    }
    return value;
  }

  private async readDelta(
    path: string,
  ): Promise<StateV2IndexedDbRecoveryDeltaV1> {
    return this.readDeltaRaw(path, await this.adapter.read(path));
  }

  private async readDeltaRaw(
    path: string,
    raw: string,
  ): Promise<StateV2IndexedDbRecoveryDeltaV1> {
    const value = await parseAndVerifyRecord(raw);
    if (value.kind !== "indexeddb-recovery-delta") {
      throw new Error("IndexedDB recovery delta kind is invalid");
    }
    const pathSeq = parseCommittedSeq(this.directory, path, COMMIT_PREFIX);
    if (pathSeq !== value.nextCommitSeq) {
      throw new Error(
        "IndexedDB recovery delta path sequence does not match",
      );
    }
    return value;
  }

  private async readCommitWitness(
    path: string,
  ): Promise<StateV2IndexedDbRecoveryCommitWitnessV1> {
    const value = await parseAndVerifyRecord(await this.adapter.read(path));
    if (value.kind !== "indexeddb-recovery-commit-witness") {
      throw new Error("IndexedDB recovery commit witness kind is invalid");
    }
    const pathSeq = parseCommittedSeq(
      this.directory,
      path,
      COMMIT_WITNESS_PREFIX,
    );
    if (pathSeq !== value.commitSeq) {
      throw new Error(
        "IndexedDB recovery commit witness path sequence does not match",
      );
    }
    return value;
  }

  private async ensureDirectory(): Promise<void> {
    if (await this.adapter.exists(this.directory)) return;
    try {
      await this.adapter.mkdir(this.directory);
    } catch (error) {
      if (!await this.adapter.exists(this.directory)) throw error;
    }
  }
}

type VerifiedRecoveryRecord =
  | StateV2IndexedDbRecoveryCheckpointV1
  | StateV2IndexedDbRecoveryDeltaV1
  | StateV2IndexedDbRecoveryCommitWitnessV1;

async function validateRecordRaw(raw: string): Promise<void> {
  await parseAndVerifyRecord(raw);
}

async function parseAndVerifyRecord(
  raw: string,
): Promise<VerifiedRecoveryRecord> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("IndexedDB recovery record is unreadable");
  }
  if (!isRecord(value) || typeof value.recordDigest !== "string") {
    throw new Error("IndexedDB recovery record is unsupported");
  }
  const { recordDigest, ...unsigned } = value;
  if (recordDigest !== await canonicalRecordDigest(unsigned)) {
    throw new Error("IndexedDB recovery record digest does not match");
  }
  if (
    value.schemaVersion !== 1
    || (
      value.kind !== "indexeddb-recovery-checkpoint"
      && value.kind !== "indexeddb-recovery-delta"
      && value.kind !== "indexeddb-recovery-commit-witness"
    )
  ) {
    throw new Error("IndexedDB recovery record is unsupported");
  }
  if (
    value.kind === "indexeddb-recovery-checkpoint"
    && (
      !isPositiveSafeInteger(value.commitSeq)
      || !isNonNegativeSafeInteger(value.lifecycleEpoch)
      || !isSha256Hex(value.envelopeDigest)
      || !isRecord(value.envelope)
    )
  ) {
    throw new Error("IndexedDB recovery checkpoint is unsupported");
  }
  if (
    value.kind === "indexeddb-recovery-delta"
    && (
      !isPositiveSafeInteger(value.previousCommitSeq)
      || !isPositiveSafeInteger(value.nextCommitSeq)
      || Number(value.nextCommitSeq) !== Number(value.previousCommitSeq) + 1
      || !isSha256Hex(value.previousEnvelopeDigest)
      || !isSha256Hex(value.nextEnvelopeDigest)
      || !isRecord(value.nextHeader)
      || !Array.isArray(value.remoteNodeUpserts)
      || !Array.isArray(value.remoteNodeDeletes)
      || !Array.isArray(value.anchorUpserts)
      || !Array.isArray(value.anchorDeletes)
      || !Array.isArray(value.folderAnchorUpserts)
      || !Array.isArray(value.folderAnchorDeletes)
    )
  ) {
    throw new Error("IndexedDB recovery delta is unsupported");
  }
  if (
    value.kind === "indexeddb-recovery-commit-witness"
    && (
      !isPositiveSafeInteger(value.commitSeq)
      || !isSha256Hex(value.envelopeDigest)
      || !isSha256Hex(value.deltaRecordDigest)
    )
  ) {
    throw new Error("IndexedDB recovery commit witness is unsupported");
  }
  return value as unknown as VerifiedRecoveryRecord;
}

function applyDelta(
  previous: SyncStateEnvelopeV2,
  delta: StateV2IndexedDbRecoveryDeltaV1,
): SyncStateEnvelopeV2 {
  if (!sameSyncScope(previous.scope, delta.nextHeader.scope)) {
    throw new Error("IndexedDB recovery delta scope changed");
  }
  const remoteNodes = { ...previous.remoteIndex.itemsById };
  for (const id of delta.remoteNodeDeletes) delete remoteNodes[id];
  for (const node of delta.remoteNodeUpserts) remoteNodes[node.id] = node;
  const anchors = { ...previous.anchors.byAnchorId };
  for (const id of delta.anchorDeletes) delete anchors[id];
  for (const anchor of delta.anchorUpserts) anchors[anchor.anchorId] = anchor;
  const folderAnchors = {
    ...(previous.folderAnchors?.byAnchorId ?? {}),
  };
  for (const id of delta.folderAnchorDeletes) delete folderAnchors[id];
  for (const anchor of delta.folderAnchorUpserts) {
    folderAnchors[anchor.anchorId] = anchor;
  }
  const next: SyncStateEnvelopeV2 = {
    meta: structuredClone(delta.nextHeader.meta),
    scope: structuredClone(delta.nextHeader.scope),
    remoteIndex: {
      ...structuredClone(delta.nextHeader.remoteIndex),
      itemsById: remoteNodes,
    },
    anchors: {
      schemaVersion: delta.nextHeader.anchorsSchemaVersion,
      byAnchorId: anchors,
    },
    ...(delta.nextHeader.folderAnchorsPresent
      ? {
          folderAnchors: {
            schemaVersion:
              delta.nextHeader.folderAnchorsSchemaVersion ?? 2,
            byAnchorId: folderAnchors,
          },
        }
      : {}),
    ...(delta.nextHeader.remoteScopeRecovery
      ? {
          remoteScopeRecovery: structuredClone(
            delta.nextHeader.remoteScopeRecovery,
          ),
        }
      : {}),
    ...(delta.nextHeader.communityPluginParticipation
      ? {
          communityPluginParticipation: structuredClone(
            delta.nextHeader.communityPluginParticipation,
          ),
        }
      : {}),
  };
  validateEnvelope(next);
  return next;
}

function diffRows<T>(
  previous: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>,
): { upserts: T[]; deletes: string[] } {
  const upserts = Object.keys(next)
    .sort(compareText)
    .filter((key) =>
      previous[key] !== next[key]
      && JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .map((key) => structuredClone(next[key]!));
  const deletes = Object.keys(previous)
    .filter((key) => !(key in next))
    .sort(compareText);
  return { upserts, deletes };
}

async function canonicalRecordDigest(value: unknown): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalJson(value)).buffer,
  );
}

export async function stateV2IndexedDbRecoveryEnvelopeDigest(
  envelope: SyncStateEnvelopeV2,
): Promise<string> {
  validateEnvelope(envelope);
  return digestValidatedEnvelope(envelope);
}

async function digestValidatedEnvelope(
  envelope: SyncStateEnvelopeV2,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalEnvelopeDigestJson(envelope)).buffer,
  );
}

function canonicalEnvelopeDigestJson(
  envelope: SyncStateEnvelopeV2,
): string {
  return [
    "{\"schemaVersion\":1,\"kind\":\"state-v2-indexeddb-envelope\",",
    "\"header\":",
    canonicalJson(stateV2EnvelopeHeader(envelope)),
    ",\"remoteNodes\":",
    canonicalRowEntries(envelope.remoteIndex.itemsById),
    ",\"anchors\":",
    canonicalRowEntries(envelope.anchors.byAnchorId),
    ",\"folderAnchors\":",
    canonicalRowEntries(envelope.folderAnchors?.byAnchorId ?? {}),
    "}",
  ].join("");
}

function canonicalRowEntries<T>(
  rows: Readonly<Record<string, T>>,
): string {
  return `[${Object.keys(rows)
    .sort(compareText)
    .map((key) =>
      `[${JSON.stringify(key)},${canonicalJson(rows[key])}]`)
    .join(",")}]`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function isCommittedCheckpointPath(
  directory: string,
  path: string,
): boolean {
  return parseCommittedSeq(directory, path, CHECKPOINT_PREFIX) !== null;
}

function isCommittedDeltaPath(
  directory: string,
  path: string,
): boolean {
  return parseCommittedSeq(directory, path, COMMIT_PREFIX) !== null;
}

function isCommittedWitnessPath(
  directory: string,
  path: string,
): boolean {
  return parseCommittedSeq(
    directory,
    path,
    COMMIT_WITNESS_PREFIX,
  ) !== null;
}

function parseCommittedSeq(
  directory: string,
  path: string,
  prefix: string,
): number | null {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = path.match(
    new RegExp(`^${escaped}/${prefix}(\\d{12})\\.json$`),
  );
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function formatSeq(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("IndexedDB recovery commit sequence is invalid");
  }
  return String(value).padStart(12, "0");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
