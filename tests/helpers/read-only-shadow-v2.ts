import type { DriveItem } from "../../src/onedrive/types";
import {
  buildRemoteIndexV2,
  projectRemoteIndexV2,
} from "../../src/sync/remote-index-v2";
import { generateFileDecisionPlanV2 } from "../../src/sync/file-decision-planner-v2";
import {
  planFolderStateV2,
  type FolderStatePlanV2,
} from "../../src/sync/folder-state-v2";
import type { SyncStateEnvelopeV2 } from "../../src/sync/state-envelope-v2";
import {
  sameSyncScope,
  type BaseFileEntry,
  type LocalFileEntry,
  type LocalFolderEntry,
  type RemoteFileEntry,
  type SyncPlan,
  type SyncPlanItem,
  type SyncScope,
} from "../../src/sync/types";

export interface V2ShadowDifference {
  dimension: "scope" | "remote-identity" | "plan";
  key: string;
  v1?: string;
  v2?: string;
}

export interface V2FolderTopologyDifference {
  type: "local-only" | "remote-only" | "type-conflict";
  path: string;
  localKind?: "file" | "folder";
  remoteKind?: "file" | "folder";
}

export interface V2FolderTopologyObservation {
  status: "match" | "differences" | "rejected";
  rejectionReason?: "local-folder-scan-incomplete" | "local-normalized-path-conflict";
  counts: {
    local: number;
    remote: number;
    shared: number;
    localOnly: number;
    remoteOnly: number;
    typeConflicts: number;
  };
  differences: V2FolderTopologyDifference[];
}

export interface V2ReadOnlyShadowReport {
  version: 1;
  status: "match" | "mismatch" | "rejected";
  rejectionReason?: "scope-mismatch" | "remote-identity-incomplete";
  rejectionDetail?: string;
  scope: SyncScope;
  remoteCounts: { v1: number; v2: number };
  planCounts: { v1: number; v2: number };
  differences: V2ShadowDifference[];
  folderTopology: V2FolderTopologyObservation;
  folderPlan: FolderStatePlanV2 | null;
  mutations: [];
  manifestWrites: 0;
}

export interface V2ReadOnlyShadowInput {
  v1Scope: SyncScope;
  v2Scope: SyncScope;
  remoteItems: readonly DriveItem[];
  v1RemoteEntries: readonly RemoteFileEntry[];
  localEntries: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  baseEntries: readonly BaseFileEntry[];
  skippedLarge: readonly string[];
  v1Plan: SyncPlan;
  /** Present only after the V2 manifest owns production state. */
  v2Envelope?: SyncStateEnvelopeV2 | null;
  includeRemotePath: (path: string) => boolean;
  includeRemoteFolderPath: (path: string) => boolean;
}

const MAX_DIFFERENCES = 20;

/**
 * Read-only V2 shadow. It has no adapter, state store, manifest or Graph client,
 * so the only possible output is an in-memory comparison report.
 */
export function compareV1WithV2Shadow(input: V2ReadOnlyShadowInput): V2ReadOnlyShadowReport {
  const report: V2ReadOnlyShadowReport = {
    version: 1,
    status: "match",
    scope: { ...input.v2Scope },
    remoteCounts: { v1: input.v1RemoteEntries.length, v2: 0 },
    planCounts: { v1: input.v1Plan.items.length, v2: 0 },
    differences: [],
    folderTopology: emptyFolderTopologyObservation(),
    folderPlan: null,
    mutations: [],
    manifestWrites: 0,
  };

  if (!sameShadowScope(input.v1Scope, input.v2Scope)) {
    report.status = "rejected";
    report.rejectionReason = "scope-mismatch";
    report.differences.push({
      dimension: "scope",
      key: "active-scope",
      v1: scopeKey(input.v1Scope),
      v2: scopeKey(input.v2Scope),
    });
    return report;
  }

  let projection: ReturnType<typeof buildRemoteIndexV2>;
  try {
    projection = buildRemoteIndexV2(
      [...input.remoteItems],
      input.v2Scope.filesRootId,
      null,
    );
  } catch (error) {
    report.status = "rejected";
    report.rejectionReason = "remote-identity-incomplete";
    report.rejectionDetail = error instanceof Error ? error.message : String(error);
    return report;
  }

  const itemById = new Map(input.remoteItems.map((item) => [item.id, item]));
  const v2RemoteEntries: RemoteFileEntry[] = [];
  for (const node of Object.values(projection.index.itemsById)) {
    if (node.kind !== "file") continue;
    const path = projection.pathById.get(node.id);
    if (!path || !input.includeRemotePath(path)) continue;
    const raw = itemById.get(node.id);
    v2RemoteEntries.push({
      path,
      driveId: node.id,
      parentId: node.parentId,
      downloadUrl: raw?.["@microsoft.graph.downloadUrl"],
      size: node.size ?? 0,
      mtime: node.mtime ?? 0,
      eTag: node.eTag ?? "",
      cTag: node.cTag ?? "",
      sha256Hash: node.contentHash,
      quickXorHash: node.quickXorHash,
    });
  }
  report.remoteCounts.v2 = v2RemoteEntries.length;
  compareRemoteIdentity(input.v1RemoteEntries, v2RemoteEntries, report.differences);
  report.folderTopology = observeFolderTopologyV2(
    input.localEntries,
    input.localFolders,
    input.localFolderScanComplete,
    projection.index,
    input.includeRemotePath,
    input.includeRemoteFolderPath,
  );
  if (input.v2Envelope && sameSyncScope(input.v2Envelope.scope, input.v2Scope)) {
    report.folderPlan = planFolderStateV2({
      envelope: input.v2Envelope,
      localFiles: input.localEntries,
      localFolders: input.localFolders,
      localFolderScanComplete: input.localFolderScanComplete,
      includeFilePath: input.includeRemotePath,
      includeFolderPath: input.includeRemoteFolderPath,
    });
  }

  const v2Plan = generateFileDecisionPlanV2({
    localEntries: input.localEntries,
    remoteEntries: v2RemoteEntries,
    baseEntries: input.baseEntries,
    skippedLarge: input.skippedLarge,
  configDir: ".obsidian",
  });
  report.planCounts.v2 = v2Plan.items.length;
  comparePlans(input.v1Plan.items, v2Plan.items, report.differences);
  if (report.differences.length > 0) report.status = "mismatch";
  return report;
}

/**
 * Compare complete local and remote folder topology without authorizing an
 * action. The result deliberately says local-only/remote-only, never
 * create/delete, because no committed folder anchor exists in F0.
 */
export function observeFolderTopologyV2(
  localFiles: readonly LocalFileEntry[],
  localFolders: readonly LocalFolderEntry[],
  localFolderScanComplete: boolean,
  remoteIndex: ReturnType<typeof buildRemoteIndexV2>["index"],
  includeRemoteFilePath: (path: string) => boolean,
  includeRemoteFolderPath: (path: string) => boolean,
): V2FolderTopologyObservation {
  const report = emptyFolderTopologyObservation();
  if (!localFolderScanComplete) {
    report.status = "rejected";
    report.rejectionReason = "local-folder-scan-incomplete";
    return report;
  }

  const pathByRemoteId = projectRemoteIndexV2(remoteIndex);
  const localFolderByKey = new Map<string, string>();
  for (const folder of localFolders) {
    const key = normalizeTopologyPath(folder.path);
    const previous = localFolderByKey.get(key);
    if (previous && previous !== folder.path) {
      report.status = "rejected";
      report.rejectionReason = "local-normalized-path-conflict";
      return report;
    }
    localFolderByKey.set(key, folder.path);
  }
  const localFileByKey = new Map(
    localFiles.map((file) => [normalizeTopologyPath(file.path), file.path]),
  );
  const remoteFolderByKey = new Map<string, string>();
  const remoteFileByKey = new Map<string, string>();
  for (const node of Object.values(remoteIndex.itemsById)) {
    const path = pathByRemoteId.get(node.id);
    if (!path) continue;
    if (node.kind === "folder") {
      if (includeRemoteFolderPath(path)) {
        remoteFolderByKey.set(normalizeTopologyPath(path), path);
      }
    } else if (includeRemoteFilePath(path)) {
      remoteFileByKey.set(normalizeTopologyPath(path), path);
    }
  }

  report.counts.local = localFolderByKey.size;
  report.counts.remote = remoteFolderByKey.size;
  for (const key of new Set([...localFolderByKey.keys(), ...remoteFolderByKey.keys()])) {
    const localFolder = localFolderByKey.get(key);
    const remoteFolder = remoteFolderByKey.get(key);
    const localFile = localFileByKey.get(key);
    const remoteFile = remoteFileByKey.get(key);
    if (localFolder && remoteFolder) {
      report.counts.shared++;
      continue;
    }
    if (localFolder && remoteFile) {
      report.counts.typeConflicts++;
      pushFolderDifference(report.differences, {
        type: "type-conflict",
        path: localFolder,
        localKind: "folder",
        remoteKind: "file",
      });
      continue;
    }
    if (remoteFolder && localFile) {
      report.counts.typeConflicts++;
      pushFolderDifference(report.differences, {
        type: "type-conflict",
        path: remoteFolder,
        localKind: "file",
        remoteKind: "folder",
      });
      continue;
    }
    if (localFolder) {
      report.counts.localOnly++;
      pushFolderDifference(report.differences, { type: "local-only", path: localFolder });
    } else if (remoteFolder) {
      report.counts.remoteOnly++;
      pushFolderDifference(report.differences, { type: "remote-only", path: remoteFolder });
    }
  }
  if (
    report.counts.localOnly > 0
    || report.counts.remoteOnly > 0
    || report.counts.typeConflicts > 0
  ) {
    report.status = "differences";
  }
  return report;
}

function compareRemoteIdentity(
  v1Entries: readonly RemoteFileEntry[],
  v2Entries: readonly RemoteFileEntry[],
  differences: V2ShadowDifference[],
): void {
  const v1 = new Map(v1Entries.map((entry) => [entry.driveId, entry.path]));
  const v2 = new Map(v2Entries.map((entry) => [entry.driveId, entry.path]));
  for (const id of new Set([...v1.keys(), ...v2.keys()])) {
    const left = v1.get(id);
    const right = v2.get(id);
    if (left === right) continue;
    pushDifference(differences, {
      dimension: "remote-identity",
      key: id,
      v1: left,
      v2: right,
    });
  }
}

function comparePlans(
  v1Items: readonly SyncPlanItem[],
  v2Items: readonly SyncPlanItem[],
  differences: V2ShadowDifference[],
): void {
  const v1 = countPlanSignatures(v1Items);
  const v2 = countPlanSignatures(v2Items);
  for (const signature of new Set([...v1.keys(), ...v2.keys()])) {
    const left = v1.get(signature) ?? 0;
    const right = v2.get(signature) ?? 0;
    if (left === right) continue;
    pushDifference(differences, {
      dimension: "plan",
      key: signature,
      v1: String(left),
      v2: String(right),
    });
  }
}

function countPlanSignatures(items: readonly SyncPlanItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const signature = [item.path, item.type, item.reason ?? "", item.renameFrom ?? ""].join("|");
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function pushDifference(
  differences: V2ShadowDifference[],
  difference: V2ShadowDifference,
): void {
  if (differences.length < MAX_DIFFERENCES) differences.push(difference);
}

function pushFolderDifference(
  differences: V2FolderTopologyDifference[],
  difference: V2FolderTopologyDifference,
): void {
  if (differences.length < MAX_DIFFERENCES) differences.push(difference);
}

function emptyFolderTopologyObservation(): V2FolderTopologyObservation {
  return {
    status: "match",
    counts: {
      local: 0,
      remote: 0,
      shared: 0,
      localOnly: 0,
      remoteOnly: 0,
      typeConflicts: 0,
    },
    differences: [],
  };
}

function normalizeTopologyPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}

const sameShadowScope = sameSyncScope;

function scopeKey(scope: SyncScope): string {
  return [scope.accountId, scope.driveId, scope.vaultFolderId, scope.filesRootId].join("/");
}
