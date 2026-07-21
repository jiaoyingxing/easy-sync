import { isSyncScope, sameSyncScope, type LocalFileEntry, type SyncScope } from "./types";
import type { OneDriveClient } from "../onedrive/client";
import { projectRemoteIndexV2, type RemoteIndexV2 } from "./remote-index-v2";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";

export interface CloudBootstrapAnchorV2 {
  remoteId: string;
  lastPath: string;
  contentHash: string;
  size: number;
  remoteETag?: string;
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
  reason?: "unhealthy" | "invalid-current" | "stale-envelope" | "write-failed";
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
): Promise<CloudBootstrapPublishResultV2> {
  if (!isHealthy(health) || envelope.remoteIndex.complete !== true) {
    return { published: false, dirty: true, revision: null, reason: "unhealthy" };
  }

  let currentObject: CloudBootstrapObjectV2 | null;
  let current: CloudBootstrapV2 | null = null;
  try {
    currentObject = await transport.read();
    if (currentObject) {
      current = parseCloudBootstrap(currentObject.content);
      if (!current || !sameSyncScope(current.scope, envelope.scope)) {
        return { published: false, dirty: true, revision: null, reason: "invalid-current" };
      }
      if (current.sourceCommitSeq > envelope.meta.commitSeq) {
        return { published: false, dirty: true, revision: current.revision, reason: "stale-envelope" };
      }
      if (current.sourceCommitSeq === envelope.meta.commitSeq) {
        return { published: false, dirty: false, revision: current.revision };
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
    return { published: true, dirty: false, revision: bootstrap.revision };
  } catch {
    return { published: false, dirty: true, revision: current?.revision ?? null, reason: "write-failed" };
  }
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
      && remote?.kind === "file"
      && pathById.get(hint.remoteId) === hint.lastPath
      && remote.contentHash === hint.contentHash
      && remote.size === hint.size
      && (!hint.remoteETag || remote.eTag === hint.remoteETag)
      && local?.hash === hint.contentHash
      && local.size === hint.size;
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
      remoteETag: anchor.remoteETag,
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
    && (anchor.remoteETag === undefined || typeof anchor.remoteETag === "string");
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
