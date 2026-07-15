/**
 * StateManager — Sync state persistence and recovery
 *
 * Manages the three snapshots (local, remote, base) and pending
 * conflict/delete lists. Uses Obsidian plugin data API for persistence.
 *
 * Key design: Per-file immediate persistence.
 * After each file operation succeeds, update baseSnapshot immediately.
 * On interruption, the next sync round naturally handles remaining diffs.
 */

import type { DataAdapter } from "obsidian";
import { getPluginDir } from "../obsidian-compat";
import { retainFileProgress, type FileProgress } from "./sync-progress";

/** M14: minimal plugin-data store contract — EasySyncPlugin satisfies this. */
export interface PluginDataStore {
  loadData(): Promise<Record<string, unknown>>;
  updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void>;
  app: { vault: { adapter: DataAdapter; configDir: string } };
  manifest: { dir?: string; id: string };
}
import {
  type LocalFileEntry,
  type RemoteFileEntry,
  type BaseFileEntry,
  type SyncPlanItem,
  type PlanReviewCounts,
  type PlanReviewItem,
  type RemoteSyncState,
  SyncActionType,
  planDigest,
} from "./types";
import { BaseContentCache } from "./base-content-cache";

/** Plugin data keys for state persistence */
const KEY_BASE_SNAPSHOT = "easy-sync-base-snapshot";
const KEY_PENDING_CONFLICTS = "easy-sync-pending-conflicts";
const KEY_PENDING_DELETES = "easy-sync-pending-remote-deletes";
const KEY_PENDING_ISSUES = "easy-sync-pending-issues";
const KEY_LAST_SYNC_TIME = "easy-sync-last-sync-time";
const KEY_PLAN_REVIEW_ACTIVE = "easy-sync-plan-review-active";
const KEY_PLAN_REVIEW_COUNTS = "easy-sync-plan-review-counts";
const KEY_PLAN_REVIEW_ITEMS = "easy-sync-plan-review-items";
const KEY_PLAN_REVIEW_DIGEST = "easy-sync-plan-review-digest";
const KEY_CLOUD_BASELINE_DIRTY = "easy-sync-cloud-baseline-dirty";
const KEY_SYNC_HISTORY = "easy-sync-history";
const KEY_GENERATION = "easy-sync-generation";
const KEY_BOUND_ACCOUNT = "easy-sync-bound-account";
const REMOTE_STATE_FILE = "remote-state.json";

export type SyncHistoryStatus = "success" | "partial" | "cancelled" | "authExpired" | "failed";

export interface SyncHistoryEntry {
  id: string;
  mode: "manual" | "auto" | "first";
  status: SyncHistoryStatus;
  startedAt: number;
  endedAt: number;
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  skipped: number;
  skippedLarge?: number;
  skippedIgnored?: number;
  errors: number;
  message: string;
  files: FileProgress[];
  uploadBytes?: number;
  uploadReadMs?: number;
  uploadNetworkMs?: number;
  peakUploads?: number;
}

export interface PendingIssue {
  path: string;
  actionType: SyncActionType;
  reason?: string;
  updatedAt: number;
  fileSize?: number;
  /** M17: content hash/etag at time of failure — used to detect version changes */
  localHash?: string;
  remoteETag?: string;
  /** M17: consecutive failures with same version. >= 3 → circuit breaker. */
  consecutiveFailures?: number;
}

/** Top-level plugin data structure */
interface PluginData {
  [KEY_BASE_SNAPSHOT]: Record<string, BaseFileEntry>;
  [KEY_PENDING_CONFLICTS]: SyncPlanItem[];
  [KEY_PENDING_DELETES]: SyncPlanItem[];
  [KEY_PENDING_ISSUES]: PendingIssue[];
  [KEY_LAST_SYNC_TIME]: number;
  [KEY_PLAN_REVIEW_ACTIVE]: boolean;
  [KEY_PLAN_REVIEW_COUNTS]: PlanReviewCounts | null;
  [KEY_PLAN_REVIEW_ITEMS]: PlanReviewItem[];
  [KEY_PLAN_REVIEW_DIGEST]: string;
  [KEY_CLOUD_BASELINE_DIRTY]: boolean;
  [KEY_SYNC_HISTORY]: SyncHistoryEntry[];
  [KEY_GENERATION]: number;
  [KEY_BOUND_ACCOUNT]: string;
}

const DEFAULT_DATA: PluginData = {
  [KEY_BASE_SNAPSHOT]: {},
  [KEY_PENDING_CONFLICTS]: [],
  [KEY_PENDING_DELETES]: [],
  [KEY_PENDING_ISSUES]: [],
  [KEY_LAST_SYNC_TIME]: 0,
  [KEY_PLAN_REVIEW_ACTIVE]: false,
  [KEY_PLAN_REVIEW_COUNTS]: null,
  [KEY_PLAN_REVIEW_ITEMS]: [],
  [KEY_PLAN_REVIEW_DIGEST]: "",
  [KEY_CLOUD_BASELINE_DIRTY]: true,
  [KEY_SYNC_HISTORY]: [],
  [KEY_GENERATION]: 0,
  [KEY_BOUND_ACCOUNT]: "",
};

function createDefaultData(generation = 0): PluginData {
  return {
    ...DEFAULT_DATA,
    [KEY_BASE_SNAPSHOT]: {},
    [KEY_PENDING_CONFLICTS]: [],
    [KEY_PENDING_DELETES]: [],
    [KEY_PENDING_ISSUES]: [],
    [KEY_PLAN_REVIEW_ITEMS]: [],
    [KEY_PLAN_REVIEW_DIGEST]: "",
    [KEY_SYNC_HISTORY]: [],
    [KEY_GENERATION]: generation,
    [KEY_BOUND_ACCOUNT]: "",
  };
}

export class StateManager {
  private data: PluginData;
  private remoteState: RemoteSyncState | null = null;
  readonly baseContentCache = new BaseContentCache();

  constructor(private plugin: PluginDataStore) {
    this.data = createDefaultData();
  }

  /** Monotonically increasing counter — detects mid-sync resets or concurrent runs */
  get remoteGeneration(): number {
    return this.data[KEY_GENERATION];
  }

  /** Bump the generation counter and persist immediately. Called by reset() before clearing
   *  state (to abort any in-flight sync), and by sync completion (to signal success). */
  async incrementRemoteGeneration(): Promise<void> {
    this.data[KEY_GENERATION]++;
    await this.save();
  }

  /** Load all state from plugin data */
  async load(): Promise<void> {
    const saved = await this.plugin.loadData();
    if (saved) {
      this.data = {
        [KEY_BASE_SNAPSHOT]: saved[KEY_BASE_SNAPSHOT] ?? {},
        [KEY_PENDING_CONFLICTS]: saved[KEY_PENDING_CONFLICTS] ?? [],
        [KEY_PENDING_DELETES]: saved[KEY_PENDING_DELETES] ?? [],
        [KEY_PENDING_ISSUES]: Array.isArray(saved[KEY_PENDING_ISSUES])
          ? saved[KEY_PENDING_ISSUES]
          : [],
        [KEY_LAST_SYNC_TIME]: saved[KEY_LAST_SYNC_TIME] ?? 0,
        [KEY_PLAN_REVIEW_ACTIVE]: saved[KEY_PLAN_REVIEW_ACTIVE] ?? false,
        [KEY_PLAN_REVIEW_COUNTS]: saved[KEY_PLAN_REVIEW_COUNTS] ?? null,
        [KEY_PLAN_REVIEW_ITEMS]: saved[KEY_PLAN_REVIEW_ITEMS] ?? [],
        [KEY_PLAN_REVIEW_DIGEST]: saved[KEY_PLAN_REVIEW_DIGEST] ?? "",
        [KEY_CLOUD_BASELINE_DIRTY]: saved[KEY_CLOUD_BASELINE_DIRTY] ?? true,
        [KEY_SYNC_HISTORY]: Array.isArray(saved[KEY_SYNC_HISTORY])
          ? saved[KEY_SYNC_HISTORY]
          : [],
        [KEY_GENERATION]: saved[KEY_GENERATION] ?? 0,
        [KEY_BOUND_ACCOUNT]: saved[KEY_BOUND_ACCOUNT] ?? "",
      } as PluginData;
    }
    this.remoteState = await this.loadRemoteState();
    await this.baseContentCache.load(
      this.plugin.app.vault.adapter,
      this.pluginDir,
    );
  }

  /** M14: persist sync state through the shared serialized queue.
   *  base-content.json remains an independent file, not PluginData. */
  private save(): Promise<void> {
    const snapshot = { ...this.data };
    const saveTask = this.plugin.updatePluginData((data) => {
      const snapshotRecord = snapshot as Record<string, unknown>;
      for (const key of Object.keys(snapshot)) {
        data[key] = snapshotRecord[key];
      }
    }).then(async () => {
      // Independently-owned file — not part of PluginData
      await this.baseContentCache.save(
        this.plugin.app.vault.adapter,
        this.pluginDir,
      );
    });
    return saveTask;
  }

  private get pluginDir(): string {
    return this.plugin.manifest.dir
      ?? getPluginDir(this.plugin.app.vault, this.plugin.manifest.id);
  }

  private async loadRemoteState(): Promise<RemoteSyncState | null> {
    try {
      const json = await this.plugin.app.vault.adapter.read(this.remoteStatePath);
      return parseRemoteState(JSON.parse(json));
    } catch {
      return null;
    }
  }

  private async persistRemoteState(state: RemoteSyncState | null): Promise<void> {
    await this.plugin.app.vault.adapter.write(
      this.remoteStatePath,
      JSON.stringify(state),
    );
  }

  private get remoteStatePath(): string {
    return `${this.pluginDir}/${REMOTE_STATE_FILE}`;
  }

  // ---- Base Snapshot (per-file persistence) ----

  get baseSnapshot(): BaseFileEntry[] {
    return Object.values(this.data[KEY_BASE_SNAPSHOT]);
  }

  getBaseEntry(path: string): BaseFileEntry | undefined {
    return this.data[KEY_BASE_SNAPSHOT][path];
  }

  /** Update a single file's base entry immediately (per-file persistence) */
  async updateBaseEntry(entry: BaseFileEntry): Promise<void> {
    await this.upsertBaseEntries([entry]);
  }

  /** Update multiple base entries with a single persistence write. */
  async upsertBaseEntries(entries: BaseFileEntry[]): Promise<void> {
    let changed = false;
    for (const entry of entries) {
      if (sameBaseEntry(this.data[KEY_BASE_SNAPSHOT][entry.path], entry)) {
        continue;
      }
      this.data[KEY_BASE_SNAPSHOT][entry.path] = entry;
      changed = true;
    }
    if (!changed) return;
    this.data[KEY_CLOUD_BASELINE_DIRTY] = true;
    await this.save();
  }

  /** Remove a file from the base snapshot */
  async removeBaseEntry(path: string): Promise<void> {
    if (!this.data[KEY_BASE_SNAPSHOT][path]) return;
    delete this.data[KEY_BASE_SNAPSHOT][path];
    this.data[KEY_CLOUD_BASELINE_DIRTY] = true;
    await this.save();
  }

  // ---- Base Content Cache (for three-way merge) ----

  cacheBaseContent(path: string, content: string | ArrayBuffer): void {
    this.baseContentCache.cache(path, content);
  }

  getBaseContent(path: string): string | undefined {
    return this.baseContentCache.get(path);
  }

  /** Batch-remove multiple files from the base snapshot in a single save.
   *  ponytail: mirrors upsertBaseEntries — collect all paths, one persist. */
  async removeBaseEntries(paths: string[]): Promise<void> {
    let changed = false;
    for (const path of paths) {
      if (this.data[KEY_BASE_SNAPSHOT][path]) {
        delete this.data[KEY_BASE_SNAPSHOT][path];
        changed = true;
      }
    }
    if (!changed) return;
    this.data[KEY_CLOUD_BASELINE_DIRTY] = true;
    await this.save();
  }

  /** Replace the entire base snapshot (used after first sync or full scan sync) */
  async setBaseSnapshot(entries: BaseFileEntry[]): Promise<void> {
    const next: Record<string, BaseFileEntry> = {};
    for (const entry of entries) {
      next[entry.path] = entry;
    }
    if (sameBaseSnapshot(this.data[KEY_BASE_SNAPSHOT], next)) return;
    this.data[KEY_BASE_SNAPSHOT] = next;
    this.data[KEY_CLOUD_BASELINE_DIRTY] = true;
    await this.save();
  }

  get needsCloudBaselineUpload(): boolean {
    return this.data[KEY_CLOUD_BASELINE_DIRTY];
  }

  async markCloudBaselineSynced(): Promise<void> {
    if (!this.data[KEY_CLOUD_BASELINE_DIRTY]) return;
    this.data[KEY_CLOUD_BASELINE_DIRTY] = false;
    try {
      await this.save();
    } catch (error) {
      this.data[KEY_CLOUD_BASELINE_DIRTY] = true;
      throw error;
    }
  }

  // ---- Remote Snapshot / Delta ----

  get hasRemoteState(): boolean {
    return this.remoteState !== null;
  }

  get remoteSnapshot(): RemoteFileEntry[] {
    return Object.values(this.remoteState?.entries ?? {});
  }

  get remoteDeltaLink(): string | null {
    return this.remoteState?.deltaLink ?? null;
  }

  async setRemoteState(
    entries: RemoteFileEntry[],
    deltaLink: string | null,
  ): Promise<void> {
    const nextEntries: Record<string, RemoteFileEntry> = {};
    for (const entry of entries) {
      nextEntries[entry.path] = entry;
    }
    const current = this.remoteState;
    if (
      current?.deltaLink === deltaLink
      && sameRemoteSnapshot(current.entries, nextEntries)
    ) {
      return;
    }
    const next: RemoteSyncState = {
      version: 1,
      generation: this.data[KEY_GENERATION],
      deltaLink,
      entries: nextEntries,
    };
    await this.persistRemoteState(next);
    this.remoteState = next;
  }

  async clearRemoteState(): Promise<void> {
    if (!this.remoteState) return;
    await this.persistRemoteState(null);
    this.remoteState = null;
  }

  async applyRemoteMutations(
    upserts: RemoteFileEntry[],
    deletedPaths: string[],
  ): Promise<void> {
    if (!this.remoteState) return;
    const next: RemoteSyncState = {
      ...this.remoteState,
      entries: { ...this.remoteState.entries },
    };

    let changed = false;
    for (const path of deletedPaths) {
      if (next.entries[path]) {
        delete next.entries[path];
        changed = true;
      }
    }
    for (const entry of upserts) {
      if (sameRemoteEntry(next.entries[entry.path], entry)) continue;
      next.entries[entry.path] = entry;
      changed = true;
    }
    if (changed) {
      await this.persistRemoteState(next);
      this.remoteState = next;
    }
  }

  /** Convert a LocalFileEntry + RemoteFileEntry pair into a BaseFileEntry */
  static toBaseEntry(local: LocalFileEntry, remote: RemoteFileEntry): BaseFileEntry {
    return {
      path: local.path,
      hash: local.hash,
      size: local.size,
      eTag: remote.eTag,
    };
  }

  // ---- Pending Conflicts ----

  get pendingConflicts(): SyncPlanItem[] {
    return this.data[KEY_PENDING_CONFLICTS];
  }

  async addPendingConflict(item: SyncPlanItem): Promise<void> {
    await this.upsertPendingConflicts([item]);
  }

  async upsertPendingConflicts(items: SyncPlanItem[]): Promise<void> {
    this.data[KEY_PENDING_CONFLICTS] = upsertPlanItems(
      this.data[KEY_PENDING_CONFLICTS],
      items,
    );
    await this.save();
  }

  async removePendingConflict(path: string): Promise<void> {
    this.data[KEY_PENDING_CONFLICTS] = this.data[KEY_PENDING_CONFLICTS].filter(
      (i) => i.path !== path,
    );
    await this.save();
  }

  async prunePendingConflicts(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    const next = this.data[KEY_PENDING_CONFLICTS].filter((item) =>
      active.has(item.path),
    );
    if (next.length === this.data[KEY_PENDING_CONFLICTS].length) {
      return;
    }
    this.data[KEY_PENDING_CONFLICTS] = next;
    await this.save();
  }

  // ---- Pending Remote Deletes ----

  get pendingRemoteDeletes(): SyncPlanItem[] {
    return this.data[KEY_PENDING_DELETES];
  }

  async addPendingDelete(item: SyncPlanItem): Promise<void> {
    await this.upsertPendingDeletes([item]);
  }

  async upsertPendingDeletes(items: SyncPlanItem[]): Promise<void> {
    this.data[KEY_PENDING_DELETES] = upsertPlanItems(
      this.data[KEY_PENDING_DELETES],
      items,
    );
    await this.save();
  }

  async removePendingDelete(path: string): Promise<void> {
    this.data[KEY_PENDING_DELETES] = this.data[KEY_PENDING_DELETES].filter(
      (i) => i.path !== path,
    );
    await this.save();
  }

  async prunePendingDeletes(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    const next = this.data[KEY_PENDING_DELETES].filter((item) =>
      active.has(item.path),
    );
    if (next.length === this.data[KEY_PENDING_DELETES].length) {
      return;
    }
    this.data[KEY_PENDING_DELETES] = next;
    await this.save();
  }

  // ---- Pending file issues ----

  get pendingIssues(): PendingIssue[] {
    return this.data[KEY_PENDING_ISSUES];
  }

  async reconcilePendingIssues(
    issues: PendingIssue[],
    resolvedPaths: Iterable<string>,
  ): Promise<void> {
    const byPath = new Map(
      this.data[KEY_PENDING_ISSUES].map((issue) => [issue.path, issue]),
    );
    for (const path of resolvedPaths) {
      byPath.delete(path);
    }
    for (const issue of issues) {
      const existing = byPath.get(issue.path);
      // M17: merge consecutive failures — same version increments counter.
      // === handles undefined correctly: both undefined → same version.
      if (
        existing
        && issue.localHash === existing.localHash
        && (issue.remoteETag ?? "") === (existing.remoteETag ?? "")
      ) {
        issue.consecutiveFailures = (existing.consecutiveFailures ?? 1) + 1;
      } else if (existing && (issue.localHash !== existing.localHash || issue.remoteETag !== existing.remoteETag)) {
        // Version changed — reset counter
        issue.consecutiveFailures = 1;
      }
      byPath.set(issue.path, issue);
    }
    const next = [...byPath.values()];
    if (samePendingIssues(this.data[KEY_PENDING_ISSUES], next)) return;
    this.data[KEY_PENDING_ISSUES] = next;
    await this.save();
  }

  /** Reset all M17 circuit breaker counters. Call after auth scope change
   *  (re-login with broader permissions) so old failures don't block retries. */
  async resetCircuitBreakers(): Promise<void> {
    let changed = false;
    for (const issue of this.data[KEY_PENDING_ISSUES]) {
      if (issue.consecutiveFailures && issue.consecutiveFailures > 0) {
        issue.consecutiveFailures = 0;
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async prunePendingIssues(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    const next = this.data[KEY_PENDING_ISSUES].filter((issue) =>
      active.has(issue.path),
    );
    if (next.length === this.data[KEY_PENDING_ISSUES].length) return;
    this.data[KEY_PENDING_ISSUES] = next;
    await this.save();
  }

  // ---- Plan Review ----

  get planReviewActive(): boolean {
    return this.data[KEY_PLAN_REVIEW_ACTIVE];
  }

  get planReviewCounts(): PlanReviewCounts | null {
    return this.data[KEY_PLAN_REVIEW_COUNTS];
  }

  get planReviewItems(): PlanReviewItem[] {
    return this.data[KEY_PLAN_REVIEW_ITEMS];
  }

  async setPlanReviewBundle(
    items: SyncPlanItem[],
    counts: PlanReviewCounts,
  ): Promise<void> {
    const conflicts = items.filter((item) => item.type === SyncActionType.Conflict);
    const deletes = items.filter((item) => item.type === SyncActionType.ConfirmLocalDelete);
    this.data[KEY_PENDING_CONFLICTS] = upsertPlanItems(
      this.data[KEY_PENDING_CONFLICTS],
      conflicts,
    );
    this.data[KEY_PENDING_DELETES] = upsertPlanItems(
      this.data[KEY_PENDING_DELETES],
      deletes,
    );
    this.data[KEY_PLAN_REVIEW_ACTIVE] = true;
    this.data[KEY_PLAN_REVIEW_COUNTS] = counts;
    this.data[KEY_PLAN_REVIEW_ITEMS] = items.map(({ type, path, reason, local, remote }) => ({
      type,
      path,
      reason,
      localHash: local?.hash,
      remoteETag: remote?.eTag,
    }));
    this.data[KEY_PLAN_REVIEW_DIGEST] = planDigest(items);
    await this.save();
  }

  get planReviewDigest(): string {
    return this.data[KEY_PLAN_REVIEW_DIGEST] ?? "";
  }

  async clearPlanReview(): Promise<void> {
    this.data[KEY_PLAN_REVIEW_ACTIVE] = false;
    this.data[KEY_PLAN_REVIEW_COUNTS] = null;
    this.data[KEY_PLAN_REVIEW_ITEMS] = [];
    this.data[KEY_PLAN_REVIEW_DIGEST] = "";
    await this.save();
  }

  // ---- Sync Time ----

  get lastSyncTime(): number {
    return this.data[KEY_LAST_SYNC_TIME];
  }

  async setLastSyncTime(time: number): Promise<void> {
    this.data[KEY_LAST_SYNC_TIME] = time;
    await this.save();
  }

  // ---- Account binding ----

  get boundAccountId(): string {
    return this.data[KEY_BOUND_ACCOUNT] ?? "";
  }

  /** Bind the vault to an account. Once bound, only this account can sync.
   *  Returns true if binding changed (needs save). */
  async bindAccount(accountId: string): Promise<void> {
    if (this.data[KEY_BOUND_ACCOUNT] === accountId) return;
    this.data[KEY_BOUND_ACCOUNT] = accountId;
    await this.save();
  }

  get syncHistory(): SyncHistoryEntry[] {
    return this.data[KEY_SYNC_HISTORY];
  }

  async addSyncHistory(entry: SyncHistoryEntry): Promise<void> {
    const normalized = { ...entry, files: retainFileProgress(entry.files) };
    this.data[KEY_SYNC_HISTORY] = [
      normalized,
      ...this.data[KEY_SYNC_HISTORY].filter((item) => item.id !== entry.id),
    ].slice(0, 10);
    await this.save();
  }

  // ---- Reset ----

  /** Clear all sync state (for "reset" functionality).
   *  Bumps generation BEFORE clearing so any in-flight sync detects the mismatch. */
  async reset(): Promise<void> {
    await this.incrementRemoteGeneration();
    const nextGen = this.data[KEY_GENERATION];
    this.data = createDefaultData(nextGen);
    await this.save();
    await this.persistRemoteState(null);
    this.remoteState = null;
  }
}

function sameBaseEntry(
  left: BaseFileEntry | undefined,
  right: BaseFileEntry,
): boolean {
  return left?.hash === right.hash
    && left.size === right.size
    && left.eTag === right.eTag;
}

function sameBaseSnapshot(
  left: Record<string, BaseFileEntry>,
  right: Record<string, BaseFileEntry>,
): boolean {
  const leftPaths = Object.keys(left);
  const rightPaths = Object.keys(right);
  return leftPaths.length === rightPaths.length
    && rightPaths.every((path) => sameBaseEntry(left[path], right[path]));
}

function parseRemoteState(value: unknown): RemoteSyncState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<RemoteSyncState>;
  if (state.version !== 1) return null;
  if (typeof state.generation !== "number") (state as Record<string, unknown>).generation = 0;
  if (state.deltaLink !== null && typeof state.deltaLink !== "string") return null;
  if (!state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) {
    return null;
  }
  for (const [path, entry] of Object.entries(state.entries)) {
    if (!isRemoteEntry(entry) || entry.path !== path) return null;
  }
  return state as RemoteSyncState;
}

function isRemoteEntry(value: unknown): value is RemoteFileEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteFileEntry>;
  return typeof entry.path === "string"
    && typeof entry.driveId === "string"
    && typeof entry.size === "number"
    && typeof entry.mtime === "number"
    && typeof entry.eTag === "string"
    && typeof entry.cTag === "string";
}

function sameRemoteEntry(
  left: RemoteFileEntry | undefined,
  right: RemoteFileEntry,
): boolean {
  return left?.path === right.path
    && left.driveId === right.driveId
    && left.downloadUrl === right.downloadUrl
    && left.size === right.size
    && left.mtime === right.mtime
    && left.eTag === right.eTag
    && left.cTag === right.cTag
    && left.sha256Hash === right.sha256Hash;
}

function sameRemoteSnapshot(
  left: Record<string, RemoteFileEntry>,
  right: Record<string, RemoteFileEntry>,
): boolean {
  const leftPaths = Object.keys(left);
  const rightPaths = Object.keys(right);
  return leftPaths.length === rightPaths.length
    && rightPaths.every((path) => sameRemoteEntry(left[path], right[path]));
}

function upsertPlanItems(
  existing: SyncPlanItem[],
  incoming: SyncPlanItem[],
): SyncPlanItem[] {
  const byPath = new Map(existing.map((item) => [item.path, item]));
  for (const item of incoming) {
    byPath.set(item.path, item);
  }
  return [...byPath.values()];
}

function samePendingIssues(left: PendingIssue[], right: PendingIssue[]): boolean {
  return left.length === right.length
    && right.every((issue, index) => {
      const current = left[index];
      return current?.path === issue.path
        && current.actionType === issue.actionType
        && current.reason === issue.reason
        && current.updatedAt === issue.updatedAt;
    });
}
