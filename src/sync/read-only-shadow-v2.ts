import type { DriveItem } from "../onedrive/types";
import { buildRemoteIndexV2 } from "./remote-index-v2";
import { SyncEngine } from "./sync-engine";
import {
  sameSyncScope,
  type BaseFileEntry,
  type LocalFileEntry,
  type RemoteFileEntry,
  type SyncPlan,
  type SyncPlanItem,
  type SyncScope,
} from "./types";

export interface V2ShadowDifference {
  dimension: "scope" | "remote-identity" | "plan";
  key: string;
  v1?: string;
  v2?: string;
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
  mutations: [];
  manifestWrites: 0;
}

export interface V2ReadOnlyShadowInput {
  v1Scope: SyncScope;
  v2Scope: SyncScope;
  remoteItems: readonly DriveItem[];
  v1RemoteEntries: readonly RemoteFileEntry[];
  localEntries: readonly LocalFileEntry[];
  baseEntries: readonly BaseFileEntry[];
  skippedLarge: readonly string[];
  v1Plan: SyncPlan;
  includeRemotePath: (path: string) => boolean;
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
    });
  }
  report.remoteCounts.v2 = v2RemoteEntries.length;
  compareRemoteIdentity(input.v1RemoteEntries, v2RemoteEntries, report.differences);

  const v2Plan = new SyncEngine().generatePlan(
    [...input.localEntries],
    v2RemoteEntries,
    [...input.baseEntries],
    [...input.skippedLarge],
  );
  report.planCounts.v2 = v2Plan.items.length;
  comparePlans(input.v1Plan.items, v2Plan.items, report.differences);
  if (report.differences.length > 0) report.status = "mismatch";
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

const sameShadowScope = sameSyncScope;

function scopeKey(scope: SyncScope): string {
  return [scope.accountId, scope.driveId, scope.vaultFolderId, scope.filesRootId].join("/");
}
