import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";
import { isRecord } from "../obsidian-compat";
import {
  readDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationV1,
} from "./community-plugin-participation";
import type { RemoteIndexV2, RemoteNodeV2 } from "./remote-index-v2";
import { isSyncScope, sameSyncScope, type SyncScope } from "./types";

export interface CommitMetaV2 {
  schemaVersion: 2;
  lifecycleEpoch: number;
  commitSeq: number;
  committedAt: number;
}

export type SyncAnchorConfirmationV2 =
  | "equal-read"
  | "upload-cas"
  | "download-cas"
  | "rename-cas"
  | "folder-move-cas"
  | "merge-cas"
  | "user-resolution";

export interface RemoteIdentityLineageV2 {
  fromRemoteId: string;
  toRemoteId: string;
  path: string;
  contentHash: string;
  size: number;
  fromRemoteETag?: string;
  toRemoteETag?: string;
  confirmedAt: number;
  confirmedBy: SyncAnchorConfirmationV2;
}

export interface SyncAnchorV2 {
  anchorId: string;
  /** Last known stable remote identity. A remote tombstone may remove the
   *  current index node before the anchor is retired by a sync decision. */
  remoteId?: string;
  lastPath: string;
  contentHash: string;
  size: number;
  remoteETag?: string;
  /** Graph content version. Unlike eTag, metadata-only rename/move does not
   *  change this value, so it can prove that a stable remote identity kept
   *  the same file content across a path change. */
  remoteCTag?: string;
  ancestorHash?: string;
  /** Ordered evidence of the same logical anchor binding to a new Graph ID. */
  remoteIdentityLineage?: RemoteIdentityLineageV2[];
  confirmedAt: number;
  confirmedBy: SyncAnchorConfirmationV2;
}

export interface SyncAnchorSetV2 {
  schemaVersion: 2;
  byAnchorId: Record<string, SyncAnchorV2>;
}

export function advanceRemoteIdentityLineageV2(
  prior: SyncAnchorV2 | undefined,
  next: {
    remoteId: string | undefined;
    path: string;
    contentHash: string;
    size: number;
    remoteETag?: string;
    confirmedAt: number;
    confirmedBy: SyncAnchorConfirmationV2;
  },
): RemoteIdentityLineageV2[] | undefined {
  const existing = prior?.remoteIdentityLineage?.map((entry) => ({
    ...entry,
  }));
  if (
    !prior?.remoteId
    || !next.remoteId
    || prior.remoteId === next.remoteId
  ) {
    return existing;
  }
  return [
    ...(existing ?? []),
    {
      fromRemoteId: prior.remoteId,
      toRemoteId: next.remoteId,
      path: next.path,
      contentHash: next.contentHash,
      size: next.size,
      ...(prior.remoteETag !== undefined
        ? { fromRemoteETag: prior.remoteETag }
        : {}),
      ...(next.remoteETag !== undefined
        ? { toRemoteETag: next.remoteETag }
        : {}),
      confirmedAt: next.confirmedAt,
      confirmedBy: next.confirmedBy,
    },
  ];
}

export interface FolderAnchorV2 {
  anchorId: string;
  /** Stable OneDrive driveItem identity. Folder paths are projections only. */
  remoteId: string;
  /** Last path confirmed to represent the same folder on both sides. */
  lastPath: string;
  /** Parent identity at the time lastPath was confirmed. */
  parentRemoteId: string;
  /** Optional Graph version evidence used by later mutation slices. */
  remoteETag?: string;
  /** Commit sequence of the envelope that first confirmed this association. */
  confirmedGeneration: number;
  confirmedAt: number;
}

export interface FolderAnchorSetV2 {
  schemaVersion: 2;
  byAnchorId: Record<string, FolderAnchorV2>;
}

export interface RemoteScopeRecoveryV2 {
  schemaVersion: 1;
  kind: "v2-remote-scope-recovery";
  reason: "committed-scope-unreachable";
  /** Envelope revision whose committed remote identities became unreachable. */
  sourceCommitSeq: number;
  /** Complete current path-owned scope, or null when the path is absent. */
  observedScope: SyncScope | null;
  observedAt: number;
  /**
   * Durable authorization phase for rebuilding only the missing remote
   * vault/files infrastructure. User content remains outside this control
   * action and is planned later from the newly observed scope.
   */
  scopeBootstrap?: RemoteScopeBootstrapReviewV2;
}

export interface RemoteScopeBootstrapReviewV2 {
  schemaVersion: 1;
  kind: "v2-remote-scope-bootstrap-review";
  phase: "pending" | "confirmed";
  /** Source revision used by the exact device-local review bundle. */
  reviewSourceCommitSeq: number;
  requestedAt: number;
  confirmedAt?: number;
}

export interface SyncStateEnvelopeV2 {
  meta: CommitMetaV2;
  scope: SyncScope;
  remoteIndex: RemoteIndexV2;
  anchors: SyncAnchorSetV2;
  /**
   * Added by the folder-sync S5 slice. Optional only for loading envelopes
   * committed by pre-S5 builds; an absent set is uninitialized, not empty.
   */
  folderAnchors?: FolderAnchorSetV2;
  /**
   * Durable V2-only hold created when committed Graph folder identities are
   * definitively unreachable. Ordinary state commits remain frozen until a
   * complete live-fact recovery transaction replaces or clears this record.
   */
  remoteScopeRecovery?: RemoteScopeRecoveryV2;
  /**
   * Device-local community-plugin intent stored by the selected V2 owner.
   * This is not a cloud device roster or proof that every device exited.
   */
  communityPluginParticipation?: DeviceCommunityPluginParticipationV1;
}

export interface StateV2EnvelopeHeader {
  meta: SyncStateEnvelopeV2["meta"];
  scope: SyncStateEnvelopeV2["scope"];
  remoteIndex: Omit<SyncStateEnvelopeV2["remoteIndex"], "itemsById">;
  anchorsSchemaVersion: 2;
  folderAnchorsPresent: boolean;
  folderAnchorsSchemaVersion?: 2;
  remoteScopeRecovery?: SyncStateEnvelopeV2["remoteScopeRecovery"];
  communityPluginParticipation?:
    SyncStateEnvelopeV2["communityPluginParticipation"];
}

export function stateV2EnvelopeHeader(
  envelope: SyncStateEnvelopeV2,
): StateV2EnvelopeHeader {
  const { itemsById: _itemsById, ...remoteIndex } = envelope.remoteIndex;
  return {
    meta: structuredClone(envelope.meta),
    scope: structuredClone(envelope.scope),
    remoteIndex: structuredClone(remoteIndex),
    anchorsSchemaVersion: envelope.anchors.schemaVersion,
    folderAnchorsPresent: envelope.folderAnchors !== undefined,
    ...(envelope.folderAnchors
      ? { folderAnchorsSchemaVersion: envelope.folderAnchors.schemaVersion }
      : {}),
    ...(envelope.remoteScopeRecovery
      ? {
          remoteScopeRecovery: structuredClone(
            envelope.remoteScopeRecovery,
          ),
        }
      : {}),
    ...(envelope.communityPluginParticipation
      ? {
          communityPluginParticipation: structuredClone(
            envelope.communityPluginParticipation,
          ),
        }
      : {}),
  };
}

export interface StateEnvelopeV2Paths {
  committed: string;
  next: string;
  previous: string;
  recovery: string;
}

export type StateEnvelopeV2LoadFailureReason =
  | "envelope-unreadable"
  | "envelope-unsupported"
  | "publication-journal-unreadable"
  | "publication-journal-unsupported"
  | "publication-state-ambiguous"
  | "scope-mismatch";

export type StateEnvelopeV2CorruptionKind =
  | "remote-index"
  | "anchors"
  | "remote-index-and-anchors";

/**
 * Exact, read-only source evidence for a future corrupt-state recovery
 * transaction. The raw bytes remain private to StateManager; diagnostics use
 * only the digest and non-path-bearing corruption kind.
 */
export interface StateEnvelopeV2CorruptionEvidence {
  version: 1;
  kind: "v2-corrupt-state-evidence";
  scope: SyncScope;
  sourceCommitSeq: number;
  sourceLifecycleEpoch: number;
  sourceDigest: string;
  corruption: StateEnvelopeV2CorruptionKind;
  rawEnvelope: string;
}

/**
 * Stable, non-path-bearing classification for a committed V2 state load
 * failure. Callers may expose `reason` in diagnostics without leaking the
 * adapter path or relying on human error text.
 */
export class StateEnvelopeV2LoadError extends Error {
  constructor(
    readonly reason: StateEnvelopeV2LoadFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "StateEnvelopeV2LoadError";
  }
}

interface StatePublishRecoveryV1 {
  version: 1;
  status: "publishing";
  scope: SyncScope;
  previousCommitSeq: number | null;
  nextCommitSeq: number;
  startedAt: number;
}

interface StateCursorRepairRecoveryV2 {
  version: 2;
  status: "repairing-cursor";
  scope: SyncScope;
  previousCommitSeq: number;
  nextCommitSeq: number;
  startedAt: number;
}

type StatePublishRecovery =
  | StatePublishRecoveryV1
  | StateCursorRepairRecoveryV2;

type EnvelopeReadOutcome =
  | { status: "missing" }
  | { status: "valid"; value: SyncStateEnvelopeV2 }
  | { status: "invalid"; error: unknown };

/**
 * Single publication point for RemoteIndexV2 + SyncAnchorSetV2.
 *
 * A candidate is validated, staged and read back before the old committed
 * envelope is moved aside. Failed publication restores the old envelope and
 * deliberately retains the recovery record for the next preflight.
 */
export class StateEnvelopeV2Store {
  constructor(
    private readonly adapter: DataAdapter,
    readonly paths: StateEnvelopeV2Paths,
    private readonly ancestorExists?: (hash: string) => Promise<boolean>,
  ) {}

  async load(expectedScope?: SyncScope): Promise<SyncStateEnvelopeV2 | null> {
    await this.recoverInterruptedPublish(expectedScope);
    const committed = await this.readEnvelope(this.paths.committed);
    if (committed && expectedScope && !sameSyncScope(committed.scope, expectedScope)) {
      throw new StateEnvelopeV2LoadError(
        "scope-mismatch",
        "V2 state scope does not match the active account or vault",
      );
    }
    return committed;
  }

  /**
   * Resolve only publication facts that are unambiguous from the local journal.
   *
   * A committed next sequence means publication completed and only cleanup was
   * interrupted. A committed previous sequence means publication did not take
   * effect, so staged artifacts can be retired and the durable mutation receipt
   * may be replayed. Any other combination fails closed.
   */
  async recoverInterruptedPublish(
    expectedScope?: SyncScope,
  ): Promise<"none" | "published" | "rolled-back"> {
    const committedRead = await this.readEnvelopeOutcome(this.paths.committed);
    const previousRead = await this.readEnvelopeOutcome(this.paths.previous);
    const nextRead = await this.readEnvelopeOutcome(this.paths.next);
    let recovery: StatePublishRecovery | null;
    try {
      recovery = await this.readRecovery();
    } catch (error) {
      // Preserve the historical failure priority when more than one local
      // artifact is unreadable. No slot can be retired without a valid journal.
      if (committedRead.status === "invalid") throw committedRead.error;
      if (previousRead.status === "invalid") throw previousRead.error;
      throw error;
    }
    let committed =
      committedRead.status === "valid" ? committedRead.value : null;
    const previous =
      previousRead.status === "valid" ? previousRead.value : null;

    if (!recovery) {
      if (committedRead.status === "invalid") throw committedRead.error;
      if (previousRead.status === "invalid") throw previousRead.error;
      if (!committed && previous) {
        if (expectedScope && !sameSyncScope(previous.scope, expectedScope)) {
          throw new StateEnvelopeV2LoadError(
            "scope-mismatch",
            "V2 previous state scope does not match the active account or vault",
          );
        }
        await this.restorePrevious();
      }
      return "none";
    }
    if (expectedScope && !sameSyncScope(recovery.scope, expectedScope)) {
      throw new StateEnvelopeV2LoadError(
        "scope-mismatch",
        "V2 recovery journal scope does not match the active account or vault",
      );
    }
    if (committed && !sameSyncScope(committed.scope, recovery.scope)) {
      throw new StateEnvelopeV2LoadError(
        "scope-mismatch",
        "V2 committed state scope does not match its recovery journal",
      );
    }
    if (previous && !sameSyncScope(previous.scope, recovery.scope)) {
      throw new StateEnvelopeV2LoadError(
        "scope-mismatch",
        "V2 previous state scope does not match its recovery journal",
      );
    }

    // Crash after next -> committed, before artifact cleanup.
    if (committed?.meta.commitSeq === recovery.nextCommitSeq) {
      await this.cleanupPublishedArtifacts();
      return "published";
    }

    // Crash after committed -> previous, before next -> committed. A corrupt
    // replacement candidate can also be rolled back here: the journal and the
    // exact previous sequence prove which readable slot still owns state, and
    // the durable mutation receipt remains available for replay.
    if (
      committedRead.status !== "valid"
      && previous?.meta.commitSeq === recovery.previousCommitSeq
    ) {
      await this.restorePrevious();
      committed = previous;
    }

    // Failed publication restored (or never moved) the old commit.
    if (
      committed
      && recovery.previousCommitSeq !== null
      && committed.meta.commitSeq === recovery.previousCommitSeq
    ) {
      await this.cleanupPublishedArtifacts();
      return "rolled-back";
    }

    // No readable old slot survived, but the journal-bound staged candidate is
    // complete. Roll forward only when its exact next sequence and scope are
    // proven. A readable unexpected committed sequence is never overwritten.
    if (
      committedRead.status !== "valid"
      && previousRead.status !== "valid"
      && nextRead.status === "valid"
      && nextRead.value.meta.commitSeq === recovery.nextCommitSeq
    ) {
      if (
        !sameSyncScope(nextRead.value.scope, recovery.scope)
        || (
          expectedScope
          && !sameSyncScope(nextRead.value.scope, expectedScope)
        )
      ) {
        throw new StateEnvelopeV2LoadError(
          "scope-mismatch",
          "V2 staged state scope does not match its recovery journal",
        );
      }
      await this.promoteStaged();
      await this.cleanupPublishedArtifacts();
      return "published";
    }

    // First publication failed before a committed envelope existed.
    if (
      committedRead.status === "missing"
      && previousRead.status === "missing"
      && nextRead.status !== "valid"
      && recovery.previousCommitSeq === null
    ) {
      await this.cleanupPublishedArtifacts();
      return "rolled-back";
    }

    if (committedRead.status === "invalid") throw committedRead.error;
    if (previousRead.status === "invalid") throw previousRead.error;
    if (nextRead.status === "invalid") throw nextRead.error;
    throw new StateEnvelopeV2LoadError(
      "publication-state-ambiguous",
      "V2 state recovery journal does not match local publication state",
    );
  }

  async publish(candidate: SyncStateEnvelopeV2): Promise<void> {
    await this.publishCandidate(candidate, false);
  }

  /**
   * Materialize an exact state already owned by another verified V2 storage
   * backend. This is used only before switching storage authority back to
   * JSON for a whole-envelope transaction; it never reopens V1.
   */
  async replaceFromVerifiedExternalAuthority(
    candidate: SyncStateEnvelopeV2,
  ): Promise<void> {
    await this.publishCandidate(candidate, true);
  }

  private async publishCandidate(
    candidate: SyncStateEnvelopeV2,
    allowCommitSequenceJump: boolean,
  ): Promise<void> {
    validateEnvelope(candidate);
    const current = await this.load(candidate.scope);
    if (await this.hasRecoveryJournal()) {
      throw new Error("V2 state has an unresolved recovery journal");
    }
    const ancestorHashes = new Set(
      Object.values(candidate.anchors.byAnchorId)
        .map((anchor) => anchor.ancestorHash)
        .filter((hash): hash is string => Boolean(hash)),
    );
    for (const hash of ancestorHashes) {
      if (!this.ancestorExists || !await this.ancestorExists(hash)) {
        throw new Error(`V2 anchor ancestor is not published: ${hash}`);
      }
    }
    const expectedSeq = current ? current.meta.commitSeq + 1 : 1;
    if (
      allowCommitSequenceJump
      && current
      && candidate.meta.commitSeq === current.meta.commitSeq
      && sameEnvelope(candidate, current)
    ) {
      return;
    }
    if (
      allowCommitSequenceJump
        ? (
          !current
          || candidate.meta.commitSeq <= current.meta.commitSeq
        )
        : candidate.meta.commitSeq !== expectedSeq
    ) {
      throw new Error(`V2 state commit sequence must be ${expectedSeq}`);
    }
    if (current && candidate.meta.lifecycleEpoch < current.meta.lifecycleEpoch) {
      throw new Error("V2 state lifecycle epoch cannot move backwards");
    }

    const recovery: StatePublishRecoveryV1 = {
      version: 1,
      status: "publishing",
      scope: candidate.scope,
      previousCommitSeq: current?.meta.commitSeq ?? null,
      nextCommitSeq: candidate.meta.commitSeq,
      startedAt: Date.now(),
    };
    await this.adapter.write(this.paths.recovery, JSON.stringify(recovery));

    await this.removeIfExists(this.paths.next);
    await this.adapter.write(this.paths.next, JSON.stringify(candidate));
    const staged = await this.readEnvelopeRequired(this.paths.next);
    if (!sameEnvelope(candidate, staged)) {
      throw new Error("V2 staged state differs from the publication candidate");
    }

    await this.removeIfExists(this.paths.previous);
    if (current) await this.adapter.rename(this.paths.committed, this.paths.previous);
    try {
      await this.adapter.rename(this.paths.next, this.paths.committed);
    } catch (error) {
      await this.restorePrevious();
      throw error;
    }

    try {
      const published = await this.readEnvelopeRequired(this.paths.committed);
      if (!sameEnvelope(candidate, published)) {
        throw new Error("V2 committed state failed read-back verification");
      }
    } catch (error) {
      await this.removeIfExists(this.paths.committed);
      await this.restorePrevious();
      throw error;
    }

    await this.cleanupPublishedArtifacts();
  }

  /**
   * Repair only cursor metadata in an otherwise fully valid committed
   * envelope. Remote identities, anchors and every other state field must
   * validate unchanged after the cursor is cleared.
   */
  async repairCursorOnly(
    expectedScope: SyncScope,
    now = Date.now(),
  ): Promise<SyncStateEnvelopeV2 | null> {
    if (!await this.adapter.exists(this.paths.committed)) return null;
    if (
      await this.adapter.exists(this.paths.previous)
      || await this.adapter.exists(this.paths.next)
    ) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(await this.adapter.read(this.paths.committed));
    } catch {
      return null;
    }
    if (
      !isRecord(raw)
      || !isRecord(raw.remoteIndex)
      || (
        Number.isSafeInteger(raw.remoteIndex.cursorRevision)
        && Number(raw.remoteIndex.cursorRevision) >= 0
        && (
          raw.remoteIndex.deltaLink === null
          || typeof raw.remoteIndex.deltaLink === "string"
        )
      )
    ) return null;

    const normalized = structuredClone(raw);
    if (!isRecord(normalized.remoteIndex)) return null;
    normalized.remoteIndex.cursorRevision = 0;
    normalized.remoteIndex.deltaLink = null;
    try {
      validateEnvelope(normalized);
    } catch {
      return null;
    }
    if (!sameSyncScope(normalized.scope, expectedScope)) return null;

    const candidate: SyncStateEnvelopeV2 = {
      ...normalized,
      meta: {
        ...normalized.meta,
        commitSeq: normalized.meta.commitSeq + 1,
        committedAt: now,
      },
      remoteIndex: {
        ...normalized.remoteIndex,
        cursorRevision: 0,
        deltaLink: null,
      },
    };
    validateEnvelope(candidate);

    const repair: StateCursorRepairRecoveryV2 = {
      version: 2,
      status: "repairing-cursor",
      scope: { ...expectedScope },
      previousCommitSeq: normalized.meta.commitSeq,
      nextCommitSeq: candidate.meta.commitSeq,
      startedAt: now,
    };
    const existing = await this.readRecovery();
    if (existing) {
      if (
        existing.version !== 2
        || existing.status !== "repairing-cursor"
        || !sameSyncScope(existing.scope, repair.scope)
        || existing.previousCommitSeq !== repair.previousCommitSeq
        || existing.nextCommitSeq !== repair.nextCommitSeq
      ) return null;
    } else {
      await this.writeRecoveryVerified(repair);
    }

    await this.writeEnvelopeVerified(this.paths.next, candidate);
    await this.adapter.rename(this.paths.committed, this.paths.previous);
    try {
      await this.adapter.rename(this.paths.next, this.paths.committed);
    } catch (error) {
      const promoted = await this.readEnvelopeOutcome(this.paths.committed);
      if (
        promoted.status !== "valid"
        || !sameEnvelope(promoted.value, candidate)
      ) throw error;
    }
    const published = await this.readEnvelopeRequired(this.paths.committed);
    if (!sameEnvelope(published, candidate)) {
      throw new Error("V2 cursor repair failed committed read-back");
    }
    await this.cleanupPublishedArtifacts();
    return candidate;
  }

  async hasRecoveryJournal(): Promise<boolean> {
    return this.adapter.exists(this.paths.recovery);
  }

  /**
   * Classify only a stable standalone committed envelope. Publication
   * artifacts keep their existing journal recovery priority; malformed
   * metadata, scope, or an active scope-recovery control record is not
   * salvageable by rebuilding file identities.
   */
  async inspectCorruptCommitted(input: {
    expectedScope: SyncScope;
    minimumCommitSeq: number;
    minimumLifecycleEpoch: number;
  }): Promise<StateEnvelopeV2CorruptionEvidence | null> {
    if (
      await this.adapter.exists(this.paths.previous)
      || await this.adapter.exists(this.paths.next)
      || await this.adapter.exists(this.paths.recovery)
      || !await this.adapter.exists(this.paths.committed)
    ) return null;

    let rawEnvelope: string;
    let raw: unknown;
    try {
      rawEnvelope = await this.adapter.read(this.paths.committed);
      raw = JSON.parse(rawEnvelope);
    } catch {
      return null;
    }
    if (
      !isRecord(raw)
      || !isMeta(raw.meta)
      || !isSyncScope(raw.scope)
      || !sameSyncScope(raw.scope, input.expectedScope)
      || raw.meta.commitSeq < input.minimumCommitSeq
      || raw.meta.lifecycleEpoch < input.minimumLifecycleEpoch
      || raw.remoteScopeRecovery !== undefined
    ) return null;

    const remoteIndexValid = isRemoteIndex(
      raw.remoteIndex,
      raw.scope.filesRootId,
    );
    const anchorsValid = hasStructurallyValidAnchorSets(raw);
    try {
      validateEnvelope(raw);
      return null;
    } catch {
      // Expected: this inspector is only for unsupported committed state.
    }
    const corruption: StateEnvelopeV2CorruptionKind =
      !remoteIndexValid && !anchorsValid
        ? "remote-index-and-anchors"
        : remoteIndexValid
          ? "anchors"
          : "remote-index";
    return {
      version: 1,
      kind: "v2-corrupt-state-evidence",
      scope: { ...raw.scope },
      sourceCommitSeq: raw.meta.commitSeq,
      sourceLifecycleEpoch: raw.meta.lifecycleEpoch,
      sourceDigest: await sha256Hex(
        new TextEncoder().encode(rawEnvelope).buffer,
      ),
      corruption,
      rawEnvelope,
    };
  }

  private async readEnvelope(path: string): Promise<SyncStateEnvelopeV2 | null> {
    if (!await this.adapter.exists(path)) return null;
    return this.readEnvelopeRequired(path);
  }

  private async readEnvelopeOutcome(path: string): Promise<EnvelopeReadOutcome> {
    try {
      const value = await this.readEnvelope(path);
      return value ? { status: "valid", value } : { status: "missing" };
    } catch (error) {
      return { status: "invalid", error };
    }
  }

  private async readEnvelopeRequired(path: string): Promise<SyncStateEnvelopeV2> {
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch {
      throw new StateEnvelopeV2LoadError(
        "envelope-unreadable",
        `V2 state is unreadable: ${path}`,
      );
    }
    try {
      validateEnvelope(value);
    } catch {
      throw new StateEnvelopeV2LoadError(
        "envelope-unsupported",
        `V2 state has an unsupported format: ${path}`,
      );
    }
    return value;
  }

  private async readRecovery(): Promise<StatePublishRecovery | null> {
    if (!await this.adapter.exists(this.paths.recovery)) return null;
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(this.paths.recovery));
    } catch {
      throw new StateEnvelopeV2LoadError(
        "publication-journal-unreadable",
        "V2 state recovery journal is unreadable",
      );
    }
    if (!isPublishRecovery(value)) {
      throw new StateEnvelopeV2LoadError(
        "publication-journal-unsupported",
        "V2 state recovery journal has an unsupported format",
      );
    }
    return value;
  }

  private async writeRecoveryVerified(
    recovery: StatePublishRecovery,
  ): Promise<void> {
    const serialized = JSON.stringify(recovery);
    try {
      await this.adapter.write(this.paths.recovery, serialized);
    } catch (error) {
      let persisted: StatePublishRecovery | null = null;
      try {
        persisted = await this.readRecovery();
      } catch {
        // Preserve the original storage error when durable state is unknown.
      }
      if (!persisted || JSON.stringify(persisted) !== serialized) throw error;
    }
    const persisted = await this.readRecovery();
    if (!persisted || JSON.stringify(persisted) !== serialized) {
      throw new Error("V2 state recovery journal failed read-back");
    }
  }

  private async writeEnvelopeVerified(
    path: string,
    candidate: SyncStateEnvelopeV2,
  ): Promise<void> {
    const serialized = JSON.stringify(candidate);
    try {
      await this.adapter.write(path, serialized);
    } catch (error) {
      const persisted = await this.readEnvelopeOutcome(path);
      if (
        persisted.status !== "valid"
        || !sameEnvelope(persisted.value, candidate)
      ) throw error;
    }
    const persisted = await this.readEnvelopeRequired(path);
    if (!sameEnvelope(persisted, candidate)) {
      throw new Error("V2 staged state differs from the publication candidate");
    }
  }

  private async restorePrevious(): Promise<void> {
    if (!await this.adapter.exists(this.paths.previous)) return;
    await this.removeIfExists(this.paths.committed);
    await this.adapter.rename(this.paths.previous, this.paths.committed);
  }

  private async promoteStaged(): Promise<void> {
    await this.removeIfExists(this.paths.committed);
    await this.adapter.rename(this.paths.next, this.paths.committed);
    await this.readEnvelopeRequired(this.paths.committed);
  }

  private async cleanupPublishedArtifacts(): Promise<void> {
    await this.removeIfExists(this.paths.previous);
    await this.removeIfExists(this.paths.next);
    await this.removeIfExists(this.paths.recovery);
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

export function validateEnvelope(value: unknown): asserts value is SyncStateEnvelopeV2 {
  if (!isRecord(value) || !isMeta(value.meta) || !isSyncScope(value.scope)) {
    throw new Error("V2 state envelope metadata is invalid");
  }
  if (!isRemoteIndex(value.remoteIndex, value.scope.filesRootId)) {
    throw new Error("V2 remote index is invalid or incomplete");
  }
  if (!isRecord(value.anchors) || value.anchors.schemaVersion !== 2
    || !isRecord(value.anchors.byAnchorId)) {
    throw new Error("V2 anchor set is invalid");
  }

  const remoteIds = new Set<string>();
  const anchorPaths = new Set<string>();
  for (const [anchorId, raw] of Object.entries(value.anchors.byAnchorId)) {
    if (!isAnchor(raw, anchorId)) throw new Error(`V2 anchor is invalid: ${anchorId}`);
    const normalizedPath = raw.lastPath.normalize("NFC").toLocaleLowerCase();
    if (anchorPaths.has(normalizedPath)) {
      throw new Error(`V2 path has multiple anchors: ${raw.lastPath}`);
    }
    anchorPaths.add(normalizedPath);
    if (raw.remoteId) {
      if (remoteIds.has(raw.remoteId)) throw new Error(`V2 remote id has multiple anchors: ${raw.remoteId}`);
      const remote = value.remoteIndex.itemsById[raw.remoteId];
      if (remote && remote.kind !== "file") {
        throw new Error(`V2 anchor points to a non-file remote node: ${anchorId}`);
      }
      remoteIds.add(raw.remoteId);
    }
  }

  if (value.folderAnchors !== undefined) {
    if (!isRecord(value.folderAnchors) || value.folderAnchors.schemaVersion !== 2
      || !isRecord(value.folderAnchors.byAnchorId)) {
      throw new Error("V2 folder anchor set is invalid");
    }
    const folderRemoteIds = new Set<string>();
    const folderPaths = new Set<string>();
    for (const [anchorId, raw] of Object.entries(value.folderAnchors.byAnchorId)) {
      if (!isFolderAnchor(raw, anchorId, value.meta.commitSeq)) {
        throw new Error(`V2 folder anchor is invalid: ${anchorId}`);
      }
      const normalizedPath = normalizeIdentityPath(raw.lastPath);
      if (folderPaths.has(normalizedPath)) {
        throw new Error(`V2 folder path has multiple anchors: ${raw.lastPath}`);
      }
      if (folderRemoteIds.has(raw.remoteId)) {
        throw new Error(`V2 folder remote id has multiple anchors: ${raw.remoteId}`);
      }
      if (remoteIds.has(raw.remoteId)) {
        throw new Error(`V2 remote id has both file and folder anchors: ${raw.remoteId}`);
      }
      if (anchorPaths.has(normalizedPath)) {
        throw new Error(`V2 path has both file and folder anchors: ${raw.lastPath}`);
      }
      const remote = value.remoteIndex.itemsById[raw.remoteId];
      if (remote && remote.kind !== "folder") {
        throw new Error(`V2 folder anchor points to a non-folder remote node: ${anchorId}`);
      }
      const parent = value.remoteIndex.itemsById[raw.parentRemoteId];
      if (
        raw.parentRemoteId !== value.scope.filesRootId
        && parent
        && parent.kind !== "folder"
      ) {
        throw new Error(`V2 folder anchor has a non-folder parent identity: ${anchorId}`);
      }
      folderPaths.add(normalizedPath);
      folderRemoteIds.add(raw.remoteId);
    }
  }
  if (
    value.remoteScopeRecovery !== undefined
    && !isRemoteScopeRecovery(
      value.remoteScopeRecovery,
      value.scope,
      value.meta.commitSeq,
    )
  ) {
    throw new Error("V2 remote scope recovery hold is invalid");
  }
  if (value.communityPluginParticipation !== undefined) {
    try {
      readDeviceCommunityPluginParticipation(
        value.communityPluginParticipation,
      );
    } catch {
      throw new Error("V2 community-plugin participation state is invalid");
    }
  }
}

function isRemoteScopeRecovery(
  value: unknown,
  sourceScope: SyncScope,
  currentCommitSeq: number,
): value is RemoteScopeRecoveryV2 {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1
    || value.kind !== "v2-remote-scope-recovery"
    || value.reason !== "committed-scope-unreachable"
    || !Number.isSafeInteger(value.sourceCommitSeq)
    || Number(value.sourceCommitSeq) !== currentCommitSeq - 1
    || typeof value.observedAt !== "number"
    || !Number.isFinite(value.observedAt)
    || value.observedAt < 0
  ) {
    return false;
  }
  if (value.observedScope === null) {
    return value.scopeBootstrap === undefined
      || isRemoteScopeBootstrapReview(
        value.scopeBootstrap,
        currentCommitSeq,
      );
  }
  return value.scopeBootstrap === undefined
    && isSyncScope(value.observedScope)
    && value.observedScope.accountId === sourceScope.accountId
    && !sameSyncScope(value.observedScope, sourceScope);
}

function isRemoteScopeBootstrapReview(
  value: unknown,
  currentCommitSeq: number,
): value is RemoteScopeBootstrapReviewV2 {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "v2-remote-scope-bootstrap-review"
    || (
      value.phase !== "pending"
      && value.phase !== "confirmed"
    )
    || !Number.isSafeInteger(value.reviewSourceCommitSeq)
    || Number(value.reviewSourceCommitSeq) < 1
    || typeof value.requestedAt !== "number"
    || !Number.isFinite(value.requestedAt)
    || value.requestedAt < 0
  ) return false;
  if (value.phase === "pending") {
    return Number(value.reviewSourceCommitSeq) === currentCommitSeq
      && value.confirmedAt === undefined;
  }
  return Number(value.reviewSourceCommitSeq) === currentCommitSeq - 1
    && typeof value.confirmedAt === "number"
    && Number.isFinite(value.confirmedAt)
    && value.confirmedAt >= value.requestedAt;
}

function isMeta(value: unknown): value is CommitMetaV2 {
  return isRecord(value)
    && value.schemaVersion === 2
    && Number.isSafeInteger(value.lifecycleEpoch) && (value.lifecycleEpoch as number) >= 0
    && Number.isSafeInteger(value.commitSeq) && (value.commitSeq as number) >= 1
    && typeof value.committedAt === "number" && Number.isFinite(value.committedAt);
}

function isRemoteIndex(value: unknown, filesRootId: string): value is RemoteIndexV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.complete !== true
    || value.filesRootId !== filesRootId
    || !Number.isSafeInteger(value.cursorRevision) || (value.cursorRevision as number) < 0
    || !(value.deltaLink === null || typeof value.deltaLink === "string")
    || !isRecord(value.itemsById)) return false;

  const nodes = value.itemsById as Record<string, unknown>;
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRemoteNode(node, id)) return false;
  }
  try {
    validateRemoteHierarchy(nodes as Record<string, RemoteNodeV2>, filesRootId);
  } catch {
    return false;
  }
  return true;
}

function hasStructurallyValidAnchorSets(
  value: Record<string, unknown>,
): boolean {
  if (!isMeta(value.meta) || !isSyncScope(value.scope)) return false;
  const identityNeutral = structuredClone(value);
  identityNeutral.remoteIndex = {
    schemaVersion: 2,
    filesRootId: value.scope.filesRootId,
    cursorRevision: 0,
    deltaLink: null,
    complete: true,
    itemsById: {},
  } satisfies RemoteIndexV2;
  try {
    validateEnvelope(identityNeutral);
    return true;
  } catch {
    return false;
  }
}

function isRemoteNode(value: unknown, id: string): value is RemoteNodeV2 {
  return isRecord(value)
    && value.id === id
    && nonEmpty(value.parentId)
    && nonEmpty(value.name)
    && (value.kind === "file" || value.kind === "folder")
    && optionalString(value.eTag)
    && optionalString(value.cTag)
    && optionalFiniteNumber(value.size)
    && optionalFiniteNumber(value.mtime)
    && (value.contentHash === undefined || isSha256(value.contentHash))
    && optionalString(value.quickXorHash);
}

function validateRemoteHierarchy(nodes: Record<string, RemoteNodeV2>, rootId: string): void {
  const pathById = new Map<string, string>();
  const visiting = new Set<string>();
  const resolve = (id: string): string => {
    const cached = pathById.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error("cycle");
    const node = nodes[id];
    if (!node) throw new Error("missing node");
    visiting.add(id);
    let path: string;
    if (node.parentId === rootId) path = node.name;
    else {
      const parent = nodes[node.parentId];
      if (!parent || parent.kind !== "folder") throw new Error("missing parent");
      path = `${resolve(parent.id)}/${node.name}`;
    }
    visiting.delete(id);
    pathById.set(id, path);
    return path;
  };
  const seen = new Set<string>();
  for (const id of Object.keys(nodes)) {
    const path = resolve(id).normalize("NFC").toLocaleLowerCase();
    if (seen.has(path)) throw new Error("duplicate path");
    seen.add(path);
  }
}

function isAnchor(value: unknown, anchorId: string): value is SyncAnchorV2 {
  if (!isRecord(value)) return false;
  return value.anchorId === anchorId
    && optionalString(value.remoteId)
    && nonEmpty(value.lastPath)
    && isSha256(value.contentHash)
    && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0
    && optionalString(value.remoteETag)
    && optionalString(value.remoteCTag)
    && (value.ancestorHash === undefined || isSha256(value.ancestorHash))
    && (
      value.remoteIdentityLineage === undefined
      || isRemoteIdentityLineage(
        value.remoteIdentityLineage,
        typeof value.remoteId === "string" ? value.remoteId : undefined,
      )
    )
    && typeof value.confirmedAt === "number" && Number.isFinite(value.confirmedAt)
    && isAnchorConfirmation(value.confirmedBy);
}

function isRemoteIdentityLineage(
  value: unknown,
  currentRemoteId: string | undefined,
): value is RemoteIdentityLineageV2[] {
  if (!Array.isArray(value) || value.length === 0 || !currentRemoteId) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (
      !isRecord(entry)
      || !nonEmpty(entry.fromRemoteId)
      || !nonEmpty(entry.toRemoteId)
      || entry.fromRemoteId === entry.toRemoteId
      || !isVaultRelativePath(entry.path)
      || !isSha256(entry.contentHash)
      || !Number.isSafeInteger(entry.size)
      || Number(entry.size) < 0
      || !optionalString(entry.fromRemoteETag)
      || !optionalString(entry.toRemoteETag)
      || typeof entry.confirmedAt !== "number"
      || !Number.isFinite(entry.confirmedAt)
      || !isAnchorConfirmation(entry.confirmedBy)
    ) return false;
    if (
      index > 0
      && value[index - 1]?.toRemoteId !== entry.fromRemoteId
    ) return false;
  }
  return value[value.length - 1]?.toRemoteId === currentRemoteId;
}

function isAnchorConfirmation(
  value: unknown,
): value is SyncAnchorConfirmationV2 {
  return [
    "equal-read",
    "upload-cas",
    "download-cas",
    "rename-cas",
    "folder-move-cas",
    "merge-cas",
    "user-resolution",
  ].includes(String(value));
}

function isFolderAnchor(
  value: unknown,
  anchorId: string,
  currentCommitSeq: number,
): value is FolderAnchorV2 {
  if (!isRecord(value)) return false;
  return value.anchorId === anchorId
    && nonEmpty(value.remoteId)
    && isVaultRelativePath(value.lastPath)
    && nonEmpty(value.parentRemoteId)
    && optionalString(value.remoteETag)
    && Number.isSafeInteger(value.confirmedGeneration)
    && (value.confirmedGeneration as number) >= 1
    && (value.confirmedGeneration as number) <= currentCommitSeq
    && typeof value.confirmedAt === "number"
    && Number.isFinite(value.confirmedAt);
}

function isPublishRecovery(value: unknown): value is StatePublishRecovery {
  if (
    !isRecord(value)
    || !isSyncScope(value.scope)
    || !Number.isSafeInteger(value.nextCommitSeq)
    || typeof value.startedAt !== "number"
  ) return false;
  if (value.version === 1 && value.status === "publishing") {
    return value.previousCommitSeq === null
      || Number.isSafeInteger(value.previousCommitSeq);
  }
  return value.version === 2
    && value.status === "repairing-cursor"
    && Number.isSafeInteger(value.previousCommitSeq);
}

function sameEnvelope(left: SyncStateEnvelopeV2, right: SyncStateEnvelopeV2): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isVaultRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) =>
      Boolean(segment) && segment !== "." && segment !== "..");
}

function normalizeIdentityPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}
