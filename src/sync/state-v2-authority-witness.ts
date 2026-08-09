import type { DataAdapter } from "obsidian";
import { isRecord } from "../obsidian-compat";
import {
  sameSyncScope,
} from "./types";
import {
  isStateV2Manifest,
  type StateV2Manifest,
} from "./state-v2-migration";
import {
  isSharedSyncProtocolBinding,
  isSharedSyncProtocolBindingTransitionAllowed,
  type SharedSyncProtocolBinding,
} from "./sync-protocol-v3";

export interface StateV2ActiveAuthorityWitness {
  schemaVersion: 1;
  kind: "state-v2-authority-witness";
  revision: number;
  status: "active";
  createdAt: number;
  updatedAt: number;
  manifest: StateV2Manifest;
  /**
   * Absent means the manifest-selected JSON envelope is the active V2
   * storage owner. Once present, JSON is only a frozen recovery source and
   * must never be used as a silent fallback.
   */
  storageAuthority?: StateV2IndexedDbStorageAuthority;
  /** Required for every production V1→V2 cutover created after V2-50. */
  protocolBinding?: SharedSyncProtocolBinding;
}

export interface StateV2IndexedDbStorageAuthorityV1 {
  schemaVersion: 1;
  kind: "indexeddb";
  databaseId: string;
  stateCommitSeq: number;
  lifecycleEpoch: number;
  stateDigest: string;
  selectedAt: number;
}

export interface StateV2IndexedDbStorageAuthorityV2 {
  schemaVersion: 2;
  kind: "indexeddb";
  /** Copy of the current App-local identity used to detect cloned Vault files. */
  vaultInstanceId: string;
  databaseId: string;
  stateCommitSeq: number;
  lifecycleEpoch: number;
  stateDigest: string;
  selectedAt: number;
}

export type StateV2IndexedDbStorageAuthority =
  | StateV2IndexedDbStorageAuthorityV1
  | StateV2IndexedDbStorageAuthorityV2;

export type StateV2AuthorityWitness = StateV2ActiveAuthorityWitness;

export interface StateV2AuthorityWitnessPaths {
  committed: string;
  next: string;
}

export type StateV2AuthorityWitnessLoadFailureReason =
  | "authority-witness-presence-unreadable"
  | "authority-witness-unreadable"
  | "authority-witness-unsupported";

export class StateV2AuthorityWitnessLoadError extends Error {
  constructor(
    readonly reason: StateV2AuthorityWitnessLoadFailureReason,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StateV2AuthorityWitnessLoadError";
  }
}

/**
 * Persistent authority memory independent of the replaceable V2 manifest.
 *
 * The manifest remains the actual cutover point. This witness is published
 * only after that manifest is committed, so a missing manifest on a later
 * startup can no longer be confused with a never-migrated V1 vault.
 */
export class StateV2AuthorityWitnessStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly paths: StateV2AuthorityWitnessPaths,
  ) {}

  async load(): Promise<StateV2AuthorityWitness | null> {
    let committedPresent: boolean;
    let stagedPresent: boolean;
    try {
      [committedPresent, stagedPresent] = await Promise.all([
        this.adapter.exists(this.paths.committed),
        this.adapter.exists(this.paths.next),
      ]);
    } catch (error) {
      throw new StateV2AuthorityWitnessLoadError(
        "authority-witness-presence-unreadable",
        "V2 authority witness presence is unreadable",
        error,
      );
    }

    const committed = committedPresent
      ? await this.readRequired(this.paths.committed)
      : null;
    let staged: StateV2AuthorityWitness | null = null;
    if (stagedPresent) {
      try {
        staged = await this.readRequired(this.paths.next);
      } catch (error) {
        if (!committed) throw error;
        // A staged write is never authoritative while the last committed
        // witness is still readable. Discard the incomplete candidate.
        await this.removeIfExists(this.paths.next);
        return committed;
      }
    }

    if (!committed && !staged) return null;
    if (!staged) return committed;
    if (!committed) {
      await this.promoteStaged(staged);
      const promoted = await this.readRequired(this.paths.committed);
      if (!sameWitness(promoted, staged)) {
        throw new Error("V2 authority witness failed recovery read-back");
      }
      return promoted;
    }
    if (staged.revision <= committed.revision) {
      await this.removeIfExists(this.paths.next);
      return committed;
    }
    if (
      staged.revision !== committed.revision + 1
      || !witnessTransitionAllowed(committed, staged)
      || staged.createdAt !== committed.createdAt
    ) {
      throw new StateV2AuthorityWitnessLoadError(
        "authority-witness-unsupported",
        "V2 authority witness transition is unsupported",
      );
    }
    await this.promoteStaged(staged);
    return staged;
  }

  async publishActive(
    manifest: StateV2Manifest,
    now = Date.now(),
    protocolBinding?: SharedSyncProtocolBinding,
  ): Promise<StateV2ActiveAuthorityWitness> {
    const current = await this.load();
    if (current) {
      if (
        current.status === "active"
        && sameManifest(current.manifest, manifest)
        && (
          protocolBinding === undefined
          || sameProtocolBinding(current.protocolBinding, protocolBinding)
        )
      ) {
        return current;
      }
      throw new Error("A different V2 authority witness is already committed");
    }
    return this.publish({
      schemaVersion: 1,
      kind: "state-v2-authority-witness",
      revision: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      manifest: structuredClone(manifest),
      ...(protocolBinding
        ? { protocolBinding: structuredClone(protocolBinding) }
        : {}),
    }) as Promise<StateV2ActiveAuthorityWitness>;
  }

  /**
   * Advance an already-active V2 authority to a newer manifest generation.
   *
   * This is intentionally narrower than migration activation: both manifests
   * must belong to the same account, the target sequence/lifecycle must move
   * forward, and the caller must CAS the exact active revision. It exists for
   * the V2-only remote-scope transition; it never selects V1.
   */
  async replaceActive(input: {
    expectedManifest: StateV2Manifest;
    expectedRevision: number;
    nextManifest: StateV2Manifest;
    nextProtocolBinding?: SharedSyncProtocolBinding;
    now?: number;
  }): Promise<StateV2ActiveAuthorityWitness> {
    const current = await this.load();
    if (
      current?.status === "active"
      && sameManifest(current.manifest, input.nextManifest)
    ) {
      return current;
    }
    if (
      !current
      || current.status !== "active"
      || current.revision !== input.expectedRevision
      || !sameManifest(current.manifest, input.expectedManifest)
      || !activeManifestTransitionAllowed(
        input.expectedManifest,
        input.nextManifest,
      )
      || !protocolBindingTransitionAllowed(
        current.protocolBinding,
        input.nextProtocolBinding ?? current.protocolBinding,
      )
    ) {
      throw new Error("V2 active authority witness transition is not authorized");
    }
    const nextWitness = structuredClone(current);
    delete nextWitness.storageAuthority;
    return this.publish({
      ...nextWitness,
      revision: current.revision + 1,
      status: "active",
      updatedAt: Math.max(input.now ?? Date.now(), current.updatedAt),
      manifest: structuredClone(input.nextManifest),
      ...(input.nextProtocolBinding
        ? {
            protocolBinding:
              structuredClone(input.nextProtocolBinding),
          }
        : {}),
    }) as Promise<StateV2ActiveAuthorityWitness>;
  }

  /**
   * Seal a repaired envelope as the next generation of the same V2 scope.
   *
   * This is not a migration or scope transition: account and all scope IDs
   * remain exact, while commitSeq/lifecycle advance under a caller-owned
   * crash-recovery journal. The shared protocol binding is preserved.
   */
  async repairActive(input: {
    expectedManifest: StateV2Manifest;
    expectedRevision: number;
    nextManifest: StateV2Manifest;
    now?: number;
  }): Promise<StateV2ActiveAuthorityWitness> {
    const current = await this.load();
    if (
      current?.status === "active"
      && sameManifest(current.manifest, input.nextManifest)
    ) {
      return current;
    }
    if (
      !current
      || current.status !== "active"
      || current.revision !== input.expectedRevision
      || !sameManifest(current.manifest, input.expectedManifest)
      || !sameScopeManifestRepairAllowed(
        input.expectedManifest,
        input.nextManifest,
      )
    ) {
      throw new Error("V2 active authority repair is not authorized");
    }
    const nextWitness = structuredClone(current);
    delete nextWitness.storageAuthority;
    return this.publish({
      ...nextWitness,
      revision: current.revision + 1,
      status: "active",
      updatedAt: Math.max(input.now ?? Date.now(), current.updatedAt),
      manifest: structuredClone(input.nextManifest),
    }) as Promise<StateV2ActiveAuthorityWitness>;
  }

  /**
   * One-way runtime cutover from the manifest-selected JSON envelope to an
   * exact, fully verified IndexedDB database. The witness is the selection
   * point; a prepared database without this field remains non-authoritative.
   */
  async selectIndexedDbStorage(input: {
    expectedManifest: StateV2Manifest;
    expectedRevision: number;
    storageAuthority: StateV2IndexedDbStorageAuthority;
    now?: number;
  }): Promise<StateV2ActiveAuthorityWitness> {
    const current = await this.load();
    if (
      current?.status === "active"
      && sameManifest(current.manifest, input.expectedManifest)
      && current.storageAuthority
      && sameStorageAuthority(
        current.storageAuthority,
        input.storageAuthority,
      )
    ) {
      return current;
    }
    if (
      !current
      || current.status !== "active"
      || current.revision !== input.expectedRevision
      || !sameManifest(current.manifest, input.expectedManifest)
      || current.storageAuthority !== undefined
      || !storageAuthorityMatchesManifest(
        input.storageAuthority,
        current.manifest,
      )
    ) {
      throw new Error(
        "V2 IndexedDB storage authority selection is not authorized",
      );
    }
    return this.publish({
      ...current,
      revision: current.revision + 1,
      updatedAt: Math.max(input.now ?? Date.now(), current.updatedAt),
      storageAuthority: structuredClone(input.storageAuthority),
    }) as Promise<StateV2ActiveAuthorityWitness>;
  }

  /**
   * Replace a missing selected database only with a fresh identity rebuilt to
   * the exact same committed state. This never authorizes an in-place repair.
   */
  async replaceIndexedDbStorage(input: {
    expectedManifest: StateV2Manifest;
    expectedRevision: number;
    expectedStorageAuthority: StateV2IndexedDbStorageAuthority;
    nextStorageAuthority: StateV2IndexedDbStorageAuthority;
    now?: number;
  }): Promise<StateV2ActiveAuthorityWitness> {
    const current = await this.load();
    if (
      current?.status === "active"
      && sameManifest(current.manifest, input.expectedManifest)
      && current.storageAuthority
      && sameStorageAuthority(
        current.storageAuthority,
        input.nextStorageAuthority,
      )
    ) {
      return current;
    }
    if (
      !current
      || current.status !== "active"
      || current.revision !== input.expectedRevision
      || !sameManifest(current.manifest, input.expectedManifest)
      || !current.storageAuthority
      || !sameStorageAuthority(
        current.storageAuthority,
        input.expectedStorageAuthority,
      )
      || input.nextStorageAuthority.databaseId
        === current.storageAuthority.databaseId
      || !storageReplacementAllowed(
        current.storageAuthority,
        input.nextStorageAuthority,
      )
      || !storageAuthorityMatchesManifest(
        input.nextStorageAuthority,
        current.manifest,
      )
    ) {
      throw new Error(
        "V2 IndexedDB storage authority replacement is not authorized",
      );
    }
    return this.publish({
      ...current,
      revision: current.revision + 1,
      updatedAt: Math.max(input.now ?? Date.now(), current.updatedAt),
      storageAuthority: structuredClone(input.nextStorageAuthority),
    }) as Promise<StateV2ActiveAuthorityWitness>;
  }

  /**
   * Return storage ownership to an exact JSON envelope before a rare
   * whole-envelope scope/corruption transaction. V2 authority itself remains
   * active and V1 stays permanently closed.
   */
  async selectJsonStorage(input: {
    expectedManifest: StateV2Manifest;
    expectedRevision: number;
    expectedStorageAuthority: StateV2IndexedDbStorageAuthority;
    now?: number;
  }): Promise<StateV2ActiveAuthorityWitness> {
    const current = await this.load();
    if (
      current?.status === "active"
      && sameManifest(current.manifest, input.expectedManifest)
      && current.storageAuthority === undefined
    ) {
      return current;
    }
    if (
      !current
      || current.status !== "active"
      || current.revision !== input.expectedRevision
      || !sameManifest(current.manifest, input.expectedManifest)
      || !current.storageAuthority
      || !sameStorageAuthority(
        current.storageAuthority,
        input.expectedStorageAuthority,
      )
    ) {
      throw new Error("V2 JSON storage authority selection is not authorized");
    }
    const next = structuredClone(current);
    delete next.storageAuthority;
    return this.publish({
      ...next,
      revision: current.revision + 1,
      updatedAt: Math.max(input.now ?? Date.now(), current.updatedAt),
    }) as Promise<StateV2ActiveAuthorityWitness>;
  }

  private async publish(
    witness: StateV2AuthorityWitness,
  ): Promise<StateV2AuthorityWitness> {
    validateStateV2AuthorityWitness(witness);
    await this.removeIfExists(this.paths.next);
    await this.adapter.write(this.paths.next, JSON.stringify(witness));
    const staged = await this.readRequired(this.paths.next);
    if (!sameWitness(staged, witness)) {
      throw new Error("V2 authority witness failed staged read-back");
    }
    await this.promoteStaged(staged);
    const committed = await this.readRequired(this.paths.committed);
    if (!sameWitness(committed, witness)) {
      throw new Error("V2 authority witness failed committed read-back");
    }
    return committed;
  }

  private async promoteStaged(
    staged: StateV2AuthorityWitness,
  ): Promise<void> {
    let current: StateV2AuthorityWitness | null = null;
    if (await this.adapter.exists(this.paths.committed)) {
      current = await this.readRequired(this.paths.committed);
    }
    if (current && current.revision >= staged.revision) {
      await this.removeIfExists(this.paths.next);
      return;
    }
    const raw = JSON.stringify(staged);
    if (current) {
      await this.adapter.process(this.paths.committed, (currentRaw) => {
        let observed: unknown;
        try {
          observed = JSON.parse(currentRaw);
          validateStateV2AuthorityWitness(observed);
        } catch {
          throw new Error(
            "V2 authority witness changed to an unreadable value during update",
          );
        }
        if (!sameWitness(observed, current)) {
          throw new Error("V2 authority witness changed during atomic update");
        }
        return raw;
      });
      const committed = await this.readRequired(this.paths.committed);
      if (!sameWitness(committed, staged)) {
        throw new Error("V2 authority witness failed atomic update read-back");
      }
      await this.removeIfExists(this.paths.next);
      return;
    }
    await this.adapter.write(this.paths.committed, raw);
    const committed = await this.readRequired(this.paths.committed);
    if (!sameWitness(committed, staged)) {
      throw new Error("V2 authority witness failed initial write read-back");
    }
    await this.removeIfExists(this.paths.next);
  }

  private async readRequired(path: string): Promise<StateV2AuthorityWitness> {
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch (error) {
      throw new StateV2AuthorityWitnessLoadError(
        "authority-witness-unreadable",
        "V2 authority witness is unreadable",
        error,
      );
    }
    try {
      validateStateV2AuthorityWitness(value);
    } catch (error) {
      throw new StateV2AuthorityWitnessLoadError(
        "authority-witness-unsupported",
        "V2 authority witness has an unsupported format",
        error,
      );
    }
    return value;
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

export function validateStateV2AuthorityWitness(
  value: unknown,
): asserts value is StateV2AuthorityWitness {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "state-v2-authority-witness"
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || value.status !== "active"
    || !Number.isFinite(value.createdAt)
    || !Number.isFinite(value.updatedAt)
    || Number(value.updatedAt) < Number(value.createdAt)
    || !isStateV2Manifest(value.manifest)
    || (
      value.protocolBinding !== undefined
      && !isSharedSyncProtocolBinding(value.protocolBinding)
    )
    || (
      value.storageAuthority !== undefined
      && (
        !isIndexedDbStorageAuthority(value.storageAuthority)
        || !storageAuthorityMatchesManifest(
          value.storageAuthority,
          value.manifest,
        )
      )
    )
  ) {
    throw new Error("V2 authority witness has an unsupported format");
  }
}

export function sameStateV2AuthorityManifest(
  witness: StateV2AuthorityWitness,
  manifest: StateV2Manifest,
): boolean {
  return sameManifest(witness.manifest, manifest);
}

function sameManifest(
  left: StateV2Manifest,
  right: StateV2Manifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameWitness(
  left: StateV2AuthorityWitness,
  right: StateV2AuthorityWitness,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameProtocolBinding(
  left: SharedSyncProtocolBinding | undefined,
  right: SharedSyncProtocolBinding,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function witnessTransitionAllowed(
  current: StateV2AuthorityWitness,
  staged: StateV2AuthorityWitness,
): boolean {
  const manifestTransition = (
    activeManifestTransitionAllowed(
      current.manifest,
      staged.manifest,
    )
    || sameScopeManifestRepairAllowed(
      current.manifest,
      staged.manifest,
    )
  ) && staged.storageAuthority === undefined;
  const storageTransition =
    sameManifest(current.manifest, staged.manifest)
    && storageAuthorityTransitionAllowed(
      current.storageAuthority,
      staged.storageAuthority,
    );
  return (manifestTransition || storageTransition)
    && protocolBindingTransitionAllowed(
    current.protocolBinding,
    staged.protocolBinding,
  );
}

function isIndexedDbStorageAuthority(
  value: unknown,
): value is StateV2IndexedDbStorageAuthority {
  return isRecord(value)
    && (value.schemaVersion === 1 || value.schemaVersion === 2)
    && value.kind === "indexeddb"
    && (
      value.schemaVersion === 1
      || (
        typeof value.vaultInstanceId === "string"
        && /^[a-f0-9]{32}$/.test(value.vaultInstanceId)
      )
    )
    && typeof value.databaseId === "string"
    && /^[a-f0-9]{32}$/.test(value.databaseId)
    && Number.isSafeInteger(value.stateCommitSeq)
    && Number(value.stateCommitSeq) >= 1
    && Number.isSafeInteger(value.lifecycleEpoch)
    && Number(value.lifecycleEpoch) >= 0
    && typeof value.stateDigest === "string"
    && /^[a-f0-9]{64}$/.test(value.stateDigest)
    && Number.isFinite(value.selectedAt);
}

function storageAuthorityMatchesManifest(
  storage: StateV2IndexedDbStorageAuthority,
  manifest: StateV2Manifest,
): boolean {
  return isIndexedDbStorageAuthority(storage)
    && storage.stateCommitSeq >= manifest.stateCommitSeq
    && storage.lifecycleEpoch >= manifest.lifecycleEpoch;
}

function sameStorageAuthority(
  left: StateV2IndexedDbStorageAuthority,
  right: StateV2IndexedDbStorageAuthority,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function storageReplacementAllowed(
  left: StateV2IndexedDbStorageAuthority,
  right: StateV2IndexedDbStorageAuthority,
): boolean {
  return !(left.schemaVersion === 2 && right.schemaVersion === 1)
    && right.stateCommitSeq >= left.stateCommitSeq
    && right.lifecycleEpoch >= left.lifecycleEpoch
    && (
      right.stateCommitSeq !== left.stateCommitSeq
      || right.stateDigest === left.stateDigest
    )
    && right.selectedAt >= left.selectedAt;
}

function storageAuthorityTransitionAllowed(
  current: StateV2IndexedDbStorageAuthority | undefined,
  next: StateV2IndexedDbStorageAuthority | undefined,
): boolean {
  if (!current && next) return true;
  if (current && !next) return true;
  if (!current || !next) return false;
  return current.databaseId !== next.databaseId
    && storageReplacementAllowed(current, next);
}

function protocolBindingTransitionAllowed(
  current: SharedSyncProtocolBinding | undefined,
  next: SharedSyncProtocolBinding | undefined,
): boolean {
  if (!current || !next) return current === undefined && next === undefined;
  return isSharedSyncProtocolBindingTransitionAllowed(current, next);
}

function activeManifestTransitionAllowed(
  current: StateV2Manifest,
  next: StateV2Manifest,
): boolean {
  return current.scope.accountId === next.scope.accountId
    && !sameSyncScope(current.scope, next.scope)
    && next.stateCommitSeq > current.stateCommitSeq
    && next.lifecycleEpoch > current.lifecycleEpoch
    && next.migratedAt >= current.migratedAt;
}

function sameScopeManifestRepairAllowed(
  current: StateV2Manifest,
  next: StateV2Manifest,
): boolean {
  return sameSyncScope(current.scope, next.scope)
    && next.stateCommitSeq > current.stateCommitSeq
    && next.lifecycleEpoch > current.lifecycleEpoch
    && next.migratedAt >= current.migratedAt;
}
