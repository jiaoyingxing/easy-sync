import { isSyncScope, sameSyncScope, type LocalFileEntry, type SyncScope } from "./types";
import type { OneDriveClient } from "../onedrive/client";
import { sha256Hex } from "../crypto";
import { isRecord } from "../obsidian-compat";
import {
  projectRemoteIndexV2,
  type RemoteIndexV2,
  type RemoteNodeV2,
} from "./remote-index-v2";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";

export interface CloudBootstrapAnchorV2 {
  remoteId: string;
  lastPath: string;
  contentHash: string;
  size: number;
  remoteETag?: string;
  remoteCTag?: string;
}

export interface CloudBootstrapV2 {
  schemaVersion: 2;
  scope: SyncScope;
  revision: number;
  sourceCommitSeq: number;
  generatedAt: number;
  anchors: CloudBootstrapAnchorV2[];
}

export interface CloudBootstrapObjectV2 {
  id: string;
  eTag: string;
  content: string;
}

/**
 * Non-authoritative receipt for the last bootstrap version this device
 * published or read back successfully. It only avoids proving the same
 * recovery hint again; the committed V2 envelope remains authoritative.
 */
export interface CloudBootstrapPublicationCheckpointV2 {
  version: 1;
  scope: SyncScope;
  anchorDigest: string;
  objectId: string;
  eTag: string;
  revision: number;
}

export interface CloudBootstrapTransportV2 {
  read(): Promise<CloudBootstrapObjectV2 | null>;
  createOnly(content: string): Promise<{ id: string; eTag: string }>;
  updateCas(id: string, eTag: string, content: string): Promise<{ id: string; eTag: string }>;
  readById(id: string): Promise<CloudBootstrapObjectV2>;
}

export function createOneDriveCloudBootstrapTransportV2(
  client: OneDriveClient,
  vaultName: string,
): CloudBootstrapTransportV2 {
  return {
    read: () => client.readCloudBootstrapV2(vaultName),
    createOnly: (content) => client.createCloudBootstrapV2(vaultName, content),
    updateCas: (id, eTag, content) => client.updateCloudBootstrapV2(id, eTag, content),
    readById: (id) => client.readCloudBootstrapV2ById(id),
  };
}

export interface CloudBootstrapHealthV2 {
  envelopeCommitted: boolean;
  localScanComplete: boolean;
  remoteScanComplete: boolean;
  lifecycleCurrent: boolean;
  unresolvedMutations: number;
  pendingItems: number;
  stateRecoveryPending: boolean;
}

export interface CloudBootstrapPublishResultV2 {
  published: boolean;
  dirty: boolean;
  revision: number | null;
  checkpoint: CloudBootstrapPublicationCheckpointV2 | null;
  reason?: "unhealthy" | "invalid-current" | "write-failed";
}

export interface VerifiedCloudBootstrapV2 {
  status: "verified" | "rejected";
  reason?: "invalid-schema" | "scope-mismatch" | "remote-index-incomplete";
  anchors: CloudBootstrapAnchorV2[];
  rejectedPaths: string[];
  mutations: [];
}

export async function publishCloudBootstrapV2(
  transport: CloudBootstrapTransportV2,
  envelope: SyncStateEnvelopeV2,
  health: CloudBootstrapHealthV2,
  now = Date.now(),
  checkpoint: Readonly<CloudBootstrapPublicationCheckpointV2> | null = null,
): Promise<CloudBootstrapPublishResultV2> {
  const anchorDigest = await cloudBootstrapAnchorDigestV2(envelope);
  if (
    checkpoint
    && cloudBootstrapCheckpointMatchesEnvelopeV2(
      checkpoint,
      envelope,
      anchorDigest,
    )
  ) {
    return {
      published: false,
      dirty: false,
      revision: checkpoint.revision,
      checkpoint: { ...checkpoint, scope: { ...checkpoint.scope } },
    };
  }
  if (!isHealthy(health) || envelope.remoteIndex.complete !== true) {
    return {
      published: false,
      dirty: true,
      revision: null,
      checkpoint: null,
      reason: "unhealthy",
    };
  }

  let currentObject: CloudBootstrapObjectV2 | null;
  let current: CloudBootstrapV2 | null = null;

  if (checkpoint && sameSyncScope(checkpoint.scope, envelope.scope)) {
    const bootstrap = buildCloudBootstrap(
      envelope,
      checkpoint.revision + 1,
      now,
    );
    const content = JSON.stringify(bootstrap);
    try {
      const written = await transport.updateCas(
        checkpoint.objectId,
        checkpoint.eTag,
        content,
      );
      const verified = await transport.readById(written.id);
      const verifiedDocument = parseCloudBootstrap(verified.content);
      if (!verifiedDocument || JSON.stringify(verifiedDocument) !== content) {
        throw new Error("Cloud bootstrap read-back mismatch");
      }
      return {
        published: true,
        dirty: false,
        revision: bootstrap.revision,
        checkpoint: checkpointFromObject(
          envelope.scope,
          anchorDigest,
          verified,
          bootstrap.revision,
        ),
      };
    } catch {
      // The cached eTag may be stale or the write response/read-back may have
      // been lost. Re-read once and converge from provider-observed facts.
    }
  }

  try {
    currentObject = await transport.read();
    if (currentObject) {
      current = parseCloudBootstrap(currentObject.content);
      if (!current || !sameSyncScope(current.scope, envelope.scope)) {
        return {
          published: false,
          dirty: true,
          revision: null,
          checkpoint: null,
          reason: "invalid-current",
        };
      }
      if (sameBootstrapAnchors(current, envelope)) {
        return {
          published: false,
          dirty: false,
          revision: current.revision,
          checkpoint: checkpointFromObject(
            envelope.scope,
            anchorDigest,
            currentObject,
            current.revision,
          ),
        };
      }
    }

    const bootstrap = buildCloudBootstrap(envelope, (current?.revision ?? 0) + 1, now);
    const content = JSON.stringify(bootstrap);
    const written = currentObject
      ? await transport.updateCas(currentObject.id, currentObject.eTag, content)
      : await transport.createOnly(content);
    const verified = await transport.readById(written.id);
    const verifiedDocument = parseCloudBootstrap(verified.content);
    if (!verifiedDocument || JSON.stringify(verifiedDocument) !== content) {
      throw new Error("Cloud bootstrap read-back mismatch");
    }
    return {
      published: true,
      dirty: false,
      revision: bootstrap.revision,
      checkpoint: checkpointFromObject(
        envelope.scope,
        anchorDigest,
        verified,
        bootstrap.revision,
      ),
    };
  } catch {
    return {
      published: false,
      dirty: true,
      revision: current?.revision ?? checkpoint?.revision ?? null,
      checkpoint: null,
      reason: "write-failed",
    };
  }
}

export async function cloudBootstrapAnchorDigestV2(
  envelope: SyncStateEnvelopeV2,
): Promise<string> {
  const content = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    scope: envelope.scope,
    anchors: buildCloudBootstrap(envelope, 1, 0).anchors,
  }));
  return sha256Hex(content.buffer);
}

export function cloudBootstrapCheckpointMatchesEnvelopeV2(
  checkpoint: Readonly<CloudBootstrapPublicationCheckpointV2>,
  envelope: Readonly<SyncStateEnvelopeV2>,
  anchorDigest: string,
): boolean {
  return sameSyncScope(checkpoint.scope, envelope.scope)
    && checkpoint.anchorDigest === anchorDigest;
}

export function readCloudBootstrapPublicationCheckpointV2(
  value: unknown,
): CloudBootstrapPublicationCheckpointV2 | null {
  if (
    !isRecord(value)
    || value.version !== 1
    || !isSyncScope(value.scope)
    || typeof value.anchorDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(value.anchorDigest)
    || typeof value.objectId !== "string"
    || value.objectId.length === 0
    || typeof value.eTag !== "string"
    || value.eTag.length === 0
    || typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
  ) return null;
  return {
    version: 1,
    scope: { ...value.scope },
    anchorDigest: value.anchorDigest,
    objectId: value.objectId,
    eTag: value.eTag,
    revision: value.revision,
  };
}

export function verifyCloudBootstrapV2(
  value: string | unknown,
  expectedScope: SyncScope,
  remoteIndex: RemoteIndexV2,
  localEntries: readonly LocalFileEntry[],
): VerifiedCloudBootstrapV2 {
  const bootstrap = typeof value === "string" ? parseCloudBootstrap(value) : parseCloudBootstrapValue(value);
  if (!bootstrap) return rejected("invalid-schema");
  if (!sameSyncScope(bootstrap.scope, expectedScope)) return rejected("scope-mismatch");
  if (remoteIndex.filesRootId !== expectedScope.filesRootId) {
    return rejected("scope-mismatch");
  }
  if (remoteIndex.complete !== true) return rejected("remote-index-incomplete");

  let pathById: Map<string, string>;
  try {
    pathById = projectRemoteIndexV2(remoteIndex);
  } catch {
    return rejected("remote-index-incomplete");
  }
  const localByPath = new Map(localEntries.map((entry) => [entry.path, entry]));
  const seenRemote = new Set<string>();
  const seenPath = new Set<string>();
  const anchors: CloudBootstrapAnchorV2[] = [];
  const rejectedPaths: string[] = [];
  for (const hint of bootstrap.anchors) {
    const normalizedPath = hint.lastPath.normalize("NFC").toLocaleLowerCase();
    const remote = remoteIndex.itemsById[hint.remoteId];
    const local = localByPath.get(hint.lastPath);
    const verified = !seenRemote.has(hint.remoteId)
      && !seenPath.has(normalizedPath)
      && cloudBootstrapRemoteVersionMatches(remote, hint)
      && pathById.get(hint.remoteId) === hint.lastPath
      && local?.hash === hint.contentHash
      && local.size === hint.size
      // Graph normally omits SHA-256 for OneDrive Personal files, which is
      // why the bootstrap exists. When Graph does expose a stronger current
      // content fact, however, it must never be ignored if it contradicts the
      // bootstrap. QuickXor mismatch is likewise definitive evidence that the
      // local and remote bytes differ, although a match alone is not enough.
      && (
        !remote?.contentHash
        || remote.contentHash.toLowerCase() === hint.contentHash.toLowerCase()
      )
      && (
        !remote?.quickXorHash
        || !local.quickXorHash
        || remote.quickXorHash === local.quickXorHash
      );
    if (!verified) {
      rejectedPaths.push(hint.lastPath);
      continue;
    }
    seenRemote.add(hint.remoteId);
    seenPath.add(normalizedPath);
    anchors.push(hint);
  }
  return { status: "verified", anchors, rejectedPaths, mutations: [] };
}

/** Match only the provider version that the cloud content anchor was bound to. */
export function cloudBootstrapRemoteVersionMatches(
  remote: RemoteNodeV2 | undefined,
  hint: Pick<CloudBootstrapAnchorV2, "size" | "remoteCTag" | "remoteETag">,
): boolean {
  return remote?.kind === "file"
    && remote.size === hint.size
    && (
      hint.remoteCTag
        ? remote.cTag === hint.remoteCTag
        : Boolean(hint.remoteETag) && remote.eTag === hint.remoteETag
    );
}

function checkpointFromObject(
  scope: Readonly<SyncScope>,
  anchorDigest: string,
  object: Readonly<CloudBootstrapObjectV2>,
  revision: number,
): CloudBootstrapPublicationCheckpointV2 {
  return {
    version: 1,
    scope: { ...scope },
    anchorDigest,
    objectId: object.id,
    eTag: object.eTag,
    revision,
  };
}

function buildCloudBootstrap(
  envelope: SyncStateEnvelopeV2,
  revision: number,
  generatedAt: number,
): CloudBootstrapV2 {
  const anchors = Object.values(envelope.anchors.byAnchorId)
    .filter((anchor): anchor is typeof anchor & { remoteId: string } => Boolean(anchor.remoteId))
    .filter((anchor) => envelope.remoteIndex.itemsById[anchor.remoteId]?.kind === "file")
    .map((anchor) => ({
      remoteId: anchor.remoteId,
      lastPath: anchor.lastPath,
      contentHash: anchor.contentHash,
      size: anchor.size,
      remoteETag: anchor.remoteETag
        ?? envelope.remoteIndex.itemsById[anchor.remoteId]?.eTag,
      remoteCTag: envelope.remoteIndex.itemsById[anchor.remoteId]?.cTag,
    }))
    .sort((left, right) => left.remoteId.localeCompare(right.remoteId));
  return {
    schemaVersion: 2,
    scope: envelope.scope,
    revision,
    sourceCommitSeq: envelope.meta.commitSeq,
    generatedAt,
    anchors,
  };
}

function parseCloudBootstrap(content: string): CloudBootstrapV2 | null {
  try { return parseCloudBootstrapValue(JSON.parse(content)); } catch { return null; }
}

function parseCloudBootstrapValue(value: unknown): CloudBootstrapV2 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CloudBootstrapV2>;
  if (candidate.schemaVersion !== 2 || !isSyncScope(candidate.scope)
    || !Number.isSafeInteger(candidate.revision) || (candidate.revision ?? 0) < 1
    || !Number.isSafeInteger(candidate.sourceCommitSeq) || (candidate.sourceCommitSeq ?? 0) < 1
    || typeof candidate.generatedAt !== "number" || !Array.isArray(candidate.anchors)) return null;
  if (!candidate.anchors.every(isAnchor)) return null;
  return candidate as CloudBootstrapV2;
}

function isAnchor(value: unknown): value is CloudBootstrapAnchorV2 {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Partial<CloudBootstrapAnchorV2>;
  return typeof anchor.remoteId === "string" && anchor.remoteId.length > 0
    && typeof anchor.lastPath === "string" && anchor.lastPath.length > 0
    && typeof anchor.contentHash === "string" && /^[a-f0-9]{64}$/i.test(anchor.contentHash)
    && typeof anchor.size === "number" && Number.isSafeInteger(anchor.size) && anchor.size >= 0
    && (anchor.remoteETag === undefined || typeof anchor.remoteETag === "string")
    && (anchor.remoteCTag === undefined || typeof anchor.remoteCTag === "string")
    && Boolean(anchor.remoteCTag || anchor.remoteETag);
}

function sameBootstrapAnchors(
  current: CloudBootstrapV2,
  envelope: SyncStateEnvelopeV2,
): boolean {
  const candidate = buildCloudBootstrap(envelope, current.revision, current.generatedAt);
  return JSON.stringify(current.anchors) === JSON.stringify(candidate.anchors);
}

function isHealthy(health: CloudBootstrapHealthV2): boolean {
  return health.envelopeCommitted
    && health.localScanComplete
    && health.remoteScanComplete
    && health.lifecycleCurrent
    && health.unresolvedMutations === 0
    && health.pendingItems === 0
    && !health.stateRecoveryPending;
}

function rejected(reason: VerifiedCloudBootstrapV2["reason"]): VerifiedCloudBootstrapV2 {
  return { status: "rejected", reason, anchors: [], rejectedPaths: [], mutations: [] };
}
