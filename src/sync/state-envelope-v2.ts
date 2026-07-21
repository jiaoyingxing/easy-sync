import type { DataAdapter } from "obsidian";
import { isRecord } from "../obsidian-compat";
import type { RemoteIndexV2, RemoteNodeV2 } from "./remote-index-v2";
import { isSyncScope, sameSyncScope, type SyncScope } from "./types";

export interface CommitMetaV2 {
  schemaVersion: 2;
  lifecycleEpoch: number;
  commitSeq: number;
  committedAt: number;
}

export interface SyncAnchorV2 {
  anchorId: string;
  remoteId?: string;
  lastPath: string;
  contentHash: string;
  size: number;
  remoteETag?: string;
  ancestorHash?: string;
  confirmedAt: number;
  confirmedBy: "equal-read" | "upload-cas" | "download-cas" | "user-resolution";
}

export interface SyncAnchorSetV2 {
  schemaVersion: 2;
  byAnchorId: Record<string, SyncAnchorV2>;
}

export interface SyncStateEnvelopeV2 {
  meta: CommitMetaV2;
  scope: SyncScope;
  remoteIndex: RemoteIndexV2;
  anchors: SyncAnchorSetV2;
}

export interface StateEnvelopeV2Paths {
  committed: string;
  next: string;
  previous: string;
  recovery: string;
}

interface StatePublishRecoveryV1 {
  version: 1;
  status: "publishing";
  scope: SyncScope;
  previousCommitSeq: number | null;
  nextCommitSeq: number;
  startedAt: number;
}

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
    let committed = await this.readEnvelope(this.paths.committed);
    const previous = await this.readEnvelope(this.paths.previous);
    const recovery = await this.readRecovery();

    if (!committed && previous) {
      await this.restorePrevious();
      committed = previous;
    }
    if (committed && expectedScope && !sameSyncScope(committed.scope, expectedScope)) {
      throw new Error("V2 state scope does not match the active account or vault");
    }

    // A crash after the final rename but before cleanup is a completed publish:
    // the staged bytes were already read back and validated before that rename.
    if (committed && recovery && committed.meta.commitSeq === recovery.nextCommitSeq) {
      await this.cleanupPublishedArtifacts();
    }
    return committed;
  }

  async publish(candidate: SyncStateEnvelopeV2): Promise<void> {
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
    if (candidate.meta.commitSeq !== expectedSeq) {
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

    try {
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
    } catch (error) {
      // A recovery record is intentionally retained. The caller must stop the
      // mutation chain; the next run can inspect external facts before retrying.
      throw error;
    }
  }

  async hasRecoveryJournal(): Promise<boolean> {
    return this.adapter.exists(this.paths.recovery);
  }

  private async readEnvelope(path: string): Promise<SyncStateEnvelopeV2 | null> {
    if (!await this.adapter.exists(path)) return null;
    return this.readEnvelopeRequired(path);
  }

  private async readEnvelopeRequired(path: string): Promise<SyncStateEnvelopeV2> {
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(path));
    } catch {
      throw new Error(`V2 state is unreadable: ${path}`);
    }
    validateEnvelope(value);
    return value;
  }

  private async readRecovery(): Promise<StatePublishRecoveryV1 | null> {
    if (!await this.adapter.exists(this.paths.recovery)) return null;
    let value: unknown;
    try {
      value = JSON.parse(await this.adapter.read(this.paths.recovery));
    } catch {
      throw new Error("V2 state recovery journal is unreadable");
    }
    if (!isPublishRecovery(value)) {
      throw new Error("V2 state recovery journal has an unsupported format");
    }
    return value;
  }

  private async restorePrevious(): Promise<void> {
    if (!await this.adapter.exists(this.paths.previous)) return;
    await this.removeIfExists(this.paths.committed);
    await this.adapter.rename(this.paths.previous, this.paths.committed);
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
  for (const [anchorId, raw] of Object.entries(value.anchors.byAnchorId)) {
    if (!isAnchor(raw, anchorId)) throw new Error(`V2 anchor is invalid: ${anchorId}`);
    if (raw.remoteId) {
      if (remoteIds.has(raw.remoteId)) throw new Error(`V2 remote id has multiple anchors: ${raw.remoteId}`);
      const remote = value.remoteIndex.itemsById[raw.remoteId];
      if (!remote || remote.kind !== "file") throw new Error(`V2 anchor has no remote file: ${anchorId}`);
      remoteIds.add(raw.remoteId);
    }
  }
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
    && (value.contentHash === undefined || isSha256(value.contentHash));
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
    && (value.ancestorHash === undefined || isSha256(value.ancestorHash))
    && typeof value.confirmedAt === "number" && Number.isFinite(value.confirmedAt)
    && ["equal-read", "upload-cas", "download-cas", "user-resolution"].includes(String(value.confirmedBy));
}

function isPublishRecovery(value: unknown): value is StatePublishRecoveryV1 {
  return isRecord(value)
    && value.version === 1
    && value.status === "publishing"
    && isSyncScope(value.scope)
    && (value.previousCommitSeq === null || Number.isSafeInteger(value.previousCommitSeq))
    && Number.isSafeInteger(value.nextCommitSeq)
    && typeof value.startedAt === "number";
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
