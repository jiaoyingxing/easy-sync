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
import { getEasySyncPaths, getPluginDir } from "../obsidian-compat";
import { retainFileProgress, type FileProgress } from "./sync-progress";
import { readStateV2Manifest } from "./state-v2-migration";

/** M14: minimal plugin-data store contract — EasySyncPlugin satisfies this. */
export interface PluginDataStore {
  loadData(): Promise<Record<string, unknown> | null>;
  updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void>;
  app: { vault: { adapter: DataAdapter; configDir: string } };
  manifest: { dir?: string; id: string };
}
import {
  type LocalFileEntry,
  type RemoteFileEntry,
  type RemoteFolderEntry,
  type BaseFileEntry,
  type SyncPlanItem,
  type PlanReviewCounts,
  type PlanReviewItem,
  type RemoteSyncState,
  type SyncScope,
  type PlanReviewAuthorization,
  type MutationIntentV1,
  type MutationReceiptV1,
  type MutationLedgerEntryV1,
  SyncActionType,
  planDigest,
  sameSyncScope,
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
const KEY_PLAN_REVIEW_REVISION = "easy-sync-plan-review-revision";
const KEY_PLAN_REVIEW_SCOPE = "easy-sync-plan-review-scope";
const KEY_SYNC_HISTORY = "easy-sync-history";
const KEY_GENERATION = "easy-sync-generation";
const KEY_BOUND_ACCOUNT = "easy-sync-bound-account";
const KEY_MUTATION_LEDGER = "easy-sync-mutation-ledger";
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
  deferred?: number;
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
  [KEY_PLAN_REVIEW_REVISION]: number;
  [KEY_PLAN_REVIEW_SCOPE]: SyncScope | null;
  [KEY_SYNC_HISTORY]: SyncHistoryEntry[];
  [KEY_GENERATION]: number;
  [KEY_BOUND_ACCOUNT]: string;
  [KEY_MUTATION_LEDGER]: MutationLedgerEntryV1[];
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
  [KEY_PLAN_REVIEW_REVISION]: 0,
  [KEY_PLAN_REVIEW_SCOPE]: null,
  [KEY_SYNC_HISTORY]: [],
  [KEY_GENERATION]: 0,
  [KEY_BOUND_ACCOUNT]: "",
  [KEY_MUTATION_LEDGER]: [],
};

function createDefaultData(generation = 0, planRevision = 0): PluginData {
  return {
    ...DEFAULT_DATA,
    [KEY_BASE_SNAPSHOT]: {},
    [KEY_PENDING_CONFLICTS]: [],
    [KEY_PENDING_DELETES]: [],
    [KEY_PENDING_ISSUES]: [],
    [KEY_PLAN_REVIEW_ITEMS]: [],
    [KEY_PLAN_REVIEW_DIGEST]: "",
    [KEY_PLAN_REVIEW_REVISION]: planRevision,
    [KEY_PLAN_REVIEW_SCOPE]: null,
    [KEY_SYNC_HISTORY]: [],
    [KEY_GENERATION]: generation,
    [KEY_BOUND_ACCOUNT]: "",
    [KEY_MUTATION_LEDGER]: [],
  };
}

export class StateManager {
  private data: PluginData;
  private pluginDataCommitQueue: Promise<void> = Promise.resolve();
  private remoteState: RemoteSyncState | null = null;
  private legacyStateAllowed = true;
  private mutationLedgerCorrupt = false;
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
    await this.save((current) => ({
      ...current,
      [KEY_GENERATION]: current[KEY_GENERATION] + 1,
    }));
  }

  /** Load all state from plugin data */
  async load(): Promise<void> {
    const saved = await this.plugin.loadData();
    if (saved) {
      const rawMutationLedger = saved[KEY_MUTATION_LEDGER];
      const mutationLedger = parseMutationLedger(rawMutationLedger);
      this.mutationLedgerCorrupt = rawMutationLedger !== undefined
        && (!Array.isArray(rawMutationLedger) || mutationLedger.length !== rawMutationLedger.length);
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
        [KEY_PLAN_REVIEW_REVISION]: Number.isSafeInteger(saved[KEY_PLAN_REVIEW_REVISION])
          && Number(saved[KEY_PLAN_REVIEW_REVISION]) >= 0
          ? Number(saved[KEY_PLAN_REVIEW_REVISION])
          : 0,
        [KEY_PLAN_REVIEW_SCOPE]: isSyncScope(saved[KEY_PLAN_REVIEW_SCOPE])
          ? saved[KEY_PLAN_REVIEW_SCOPE]
          : null,
        [KEY_SYNC_HISTORY]: Array.isArray(saved[KEY_SYNC_HISTORY])
          ? saved[KEY_SYNC_HISTORY]
          : [],
        [KEY_GENERATION]: saved[KEY_GENERATION] ?? 0,
        [KEY_BOUND_ACCOUNT]: saved[KEY_BOUND_ACCOUNT] ?? "",
        [KEY_MUTATION_LEDGER]: mutationLedger,
      } as PluginData;
    }
    this.remoteState = await this.loadRemoteState();
    await this.baseContentCache.load(
      this.plugin.app.vault.adapter,
      this.pluginDir,
    );
    const paths = getEasySyncPaths(this.plugin.app.vault, this.plugin.manifest.id);
    // Real Obsidian adapters expose exists(). Narrow compatibility/test
    // adapters that do not cannot reliably distinguish this new optional file
    // from another read target, so they remain on the legacy path.
    if (typeof (this.plugin.app.vault.adapter as Partial<DataAdapter>).exists === "function") {
      this.legacyStateAllowed = await readStateV2Manifest(
        this.plugin.app.vault.adapter,
        paths.stateV2ManifestFile,
      ) === null;
    }
  }

  /** M14: persist sync state through the shared serialized queue.
   *  base-content.json remains an independent file, not PluginData. */
  private save(buildNext: (current: PluginData) => PluginData): Promise<void> {
    return this.commitPluginData(buildNext, true);
  }

  /** Publish a complete PluginData candidate only after its durable write succeeds. */
  private commitPluginData(
    buildNext: (current: PluginData) => PluginData,
    saveBaseContent = false,
  ): Promise<void> {
    const task = this.pluginDataCommitQueue.then(async () => {
      const next = buildNext(this.data);
      if (next === this.data) return;
      await this.persistPluginData(next);
      this.data = next;
      if (saveBaseContent) {
        // Independently-owned file — not part of PluginData. A cache write
        // failure must not roll memory back behind PluginData that committed.
        await this.baseContentCache.save(
          this.plugin.app.vault.adapter,
          this.pluginDir,
        );
      }
    });
    this.pluginDataCommitQueue = task.catch(() => undefined);
    return task;
  }

  private persistPluginData(snapshot: PluginData): Promise<void> {
    return this.plugin.updatePluginData((data) => {
      const snapshotRecord = snapshot as unknown as Record<string, unknown>;
      for (const key of Object.keys(snapshot)) {
        data[key] = snapshotRecord[key];
      }
    });
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

  // ---- Mutation recovery ledger ----

  get mutationLedger(): readonly MutationLedgerEntryV1[] {
    return this.data[KEY_MUTATION_LEDGER];
  }

  get hasMutationLedgerCorruption(): boolean {
    return this.mutationLedgerCorrupt;
  }

  async beginMutationIntent(intent: MutationIntentV1): Promise<void> {
    if (this.mutationLedgerCorrupt) throw new Error("Mutation recovery ledger is corrupt");
    await this.commitPluginData((current) => {
      if (current[KEY_MUTATION_LEDGER].some((entry) => entry.intent.operationId === intent.operationId)) {
        throw new Error(`Duplicate mutation operation: ${intent.operationId}`);
      }
      if (current[KEY_MUTATION_LEDGER].some((entry) => entry.intent.path === intent.path)) {
        throw new Error(`Mutation already pending for path: ${intent.path}`);
      }
      return {
        ...current,
        [KEY_MUTATION_LEDGER]: [
          ...current[KEY_MUTATION_LEDGER],
          { intent, receipt: null },
        ],
      };
    });
  }

  async recordMutationReceipt(receipt: MutationReceiptV1): Promise<void> {
    if (this.mutationLedgerCorrupt) throw new Error("Mutation recovery ledger is corrupt");
    await this.commitPluginData((current) => {
      const index = current[KEY_MUTATION_LEDGER].findIndex(
        (entry) => entry.intent.operationId === receipt.operationId,
      );
      if (index < 0) throw new Error(`Mutation intent missing: ${receipt.operationId}`);
      const entries = [...current[KEY_MUTATION_LEDGER]];
      entries[index] = { intent: entries[index].intent, receipt };
      return { ...current, [KEY_MUTATION_LEDGER]: entries };
    });
  }

  async abandonMutationIntent(operationId: string): Promise<void> {
    await this.commitPluginData((data) => {
      const current = data[KEY_MUTATION_LEDGER].find(
        (entry) => entry.intent.operationId === operationId,
      );
      if (!current) return data;
      if (current.receipt) throw new Error(`Cannot abandon receipted mutation: ${operationId}`);
      return {
        ...data,
        [KEY_MUTATION_LEDGER]: data[KEY_MUTATION_LEDGER].filter(
          (entry) => entry.intent.operationId !== operationId,
        ),
      };
    });
  }

  /** Publish a receipted mutation's base/remote/pending checkpoint, then clear it. */
  async commitMutationCheckpoint(operationId: string): Promise<void> {
    const record = this.data[KEY_MUTATION_LEDGER].find(
      (entry) => entry.intent.operationId === operationId,
    );
    if (!record?.receipt) throw new Error(`Mutation receipt missing: ${operationId}`);
    const checkpoint = record.receipt.checkpoint;
    assertRemoteUpsertsHaveParentIdentity(checkpoint.remoteUpserts);

    let nextRemote = this.remoteState;
    if (nextRemote && (checkpoint.remoteUpserts.length > 0 || checkpoint.remoteDeletes.length > 0)) {
      nextRemote = { ...nextRemote, entries: { ...nextRemote.entries } };
      for (const path of checkpoint.remoteDeletes) delete nextRemote.entries[path];
      for (const entry of checkpoint.remoteUpserts) nextRemote.entries[entry.path] = entry;
      await this.persistRemoteState(nextRemote);
    }

    await this.commitPluginData((current) => {
      const nextBase = { ...current[KEY_BASE_SNAPSHOT] };
      for (const path of checkpoint.baseRemovals) delete nextBase[path];
      for (const entry of checkpoint.baseUpserts) nextBase[entry.path] = entry;
      return {
        ...current,
        [KEY_BASE_SNAPSHOT]: nextBase,
        [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
          (item) => !checkpoint.pendingConflictRemovals.includes(item.path),
        ),
        [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
          (item) => !checkpoint.pendingDeleteRemovals.includes(item.path),
        ),
        [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
          (entry) => entry.intent.operationId !== operationId,
        ),
      };
    });
    this.remoteState = nextRemote;
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
    await this.save((current) => {
      const nextBase = { ...current[KEY_BASE_SNAPSHOT] };
      let changed = false;
      for (const entry of entries) {
        if (sameBaseEntry(nextBase[entry.path], entry)) {
          continue;
        }
        nextBase[entry.path] = entry;
        changed = true;
      }
      return changed ? { ...current, [KEY_BASE_SNAPSHOT]: nextBase } : current;
    });
  }

  /** Commit exact-content evidence and retire its false conflict in one data write. */
  async reconcileIdenticalConflict(entry: BaseFileEntry): Promise<void> {
    await this.save((current) => {
      const hasPending = current[KEY_PENDING_CONFLICTS].some(
        (item) => item.path === entry.path,
      );
      const baseChanged = !sameBaseEntry(
        current[KEY_BASE_SNAPSHOT][entry.path],
        entry,
      );
      if (!hasPending && !baseChanged) return current;
      return {
        ...current,
        [KEY_BASE_SNAPSHOT]: baseChanged
          ? { ...current[KEY_BASE_SNAPSHOT], [entry.path]: entry }
          : current[KEY_BASE_SNAPSHOT],
        [KEY_PENDING_CONFLICTS]: hasPending
          ? current[KEY_PENDING_CONFLICTS].filter((item) => item.path !== entry.path)
          : current[KEY_PENDING_CONFLICTS],
        // The reviewed bundle contains a digest of the old conflict. Retire it
        // instead of leaving a stale confirmation entry beside the new base.
        [KEY_PLAN_REVIEW_ACTIVE]: false,
        [KEY_PLAN_REVIEW_COUNTS]: null,
        [KEY_PLAN_REVIEW_ITEMS]: [],
        [KEY_PLAN_REVIEW_DIGEST]: "",
        [KEY_PLAN_REVIEW_SCOPE]: null,
      };
    });
  }

  /** Remove a file from the base snapshot */
  async removeBaseEntry(path: string): Promise<void> {
    await this.save((current) => {
      if (!current[KEY_BASE_SNAPSHOT][path]) return current;
      const nextBase = { ...current[KEY_BASE_SNAPSHOT] };
      delete nextBase[path];
      return { ...current, [KEY_BASE_SNAPSHOT]: nextBase };
    });
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
    await this.save((current) => {
      const nextBase = { ...current[KEY_BASE_SNAPSHOT] };
      let changed = false;
      for (const path of paths) {
        if (nextBase[path]) {
          delete nextBase[path];
          changed = true;
        }
      }
      return changed ? { ...current, [KEY_BASE_SNAPSHOT]: nextBase } : current;
    });
  }

  /** Replace the entire base snapshot (used after first sync or full scan sync) */
  async setBaseSnapshot(entries: BaseFileEntry[]): Promise<void> {
    const next: Record<string, BaseFileEntry> = {};
    for (const entry of entries) {
      next[entry.path] = entry;
    }
    await this.save((current) => sameBaseSnapshot(current[KEY_BASE_SNAPSHOT], next)
      ? current
      : { ...current, [KEY_BASE_SNAPSHOT]: next });
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

  get remoteFolders(): RemoteFolderEntry[] {
    return Object.values(this.remoteState?.folders ?? {});
  }

  get remoteScope(): SyncScope | null {
    return this.remoteState?.scope ?? null;
  }

  async setRemoteState(
    entries: RemoteFileEntry[],
    deltaLink: string | null,
    scope: SyncScope | null = null,
    folders: RemoteFolderEntry[] = [],
  ): Promise<void> {
    const nextEntries: Record<string, RemoteFileEntry> = {};
    for (const entry of entries) {
      nextEntries[entry.path] = entry;
    }
    const nextFolders: Record<string, RemoteFolderEntry> = {};
    for (const folder of folders) {
      nextFolders[folder.driveId] = folder;
    }
    const current = this.remoteState;
    if (
      current?.deltaLink === deltaLink
      && sameSyncScope(current.scope, scope)
      && sameRemoteSnapshot(current.entries, nextEntries)
      && sameRemoteFolderSnapshot(current.folders, nextFolders)
    ) {
      return;
    }
    const next: RemoteSyncState = {
      version: 1,
      generation: this.data[KEY_GENERATION],
      scope,
      deltaLink,
      entries: nextEntries,
      folders: nextFolders,
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
    assertRemoteUpsertsHaveParentIdentity(upserts);
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
    await this.save((current) => ({
      ...current,
      [KEY_PENDING_CONFLICTS]: upsertPlanItems(
        current[KEY_PENDING_CONFLICTS],
        items,
      ),
    }));
  }

  async removePendingConflict(path: string): Promise<void> {
    await this.save((current) => ({
      ...current,
      [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
        (i) => i.path !== path,
      ),
    }));
  }

  async prunePendingConflicts(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    await this.save((current) => {
      const next = current[KEY_PENDING_CONFLICTS].filter((item) =>
        active.has(item.path),
      );
      return next.length === current[KEY_PENDING_CONFLICTS].length
        ? current
        : { ...current, [KEY_PENDING_CONFLICTS]: next };
    });
  }

  // ---- Pending Remote Deletes ----

  get pendingRemoteDeletes(): SyncPlanItem[] {
    return this.data[KEY_PENDING_DELETES];
  }

  async addPendingDelete(item: SyncPlanItem): Promise<void> {
    await this.upsertPendingDeletes([item]);
  }

  async upsertPendingDeletes(items: SyncPlanItem[]): Promise<void> {
    await this.save((current) => ({
      ...current,
      [KEY_PENDING_DELETES]: upsertPlanItems(
        current[KEY_PENDING_DELETES],
        items,
      ),
    }));
  }

  async removePendingDelete(path: string): Promise<void> {
    await this.save((current) => ({
      ...current,
      [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
        (i) => i.path !== path,
      ),
    }));
  }

  async prunePendingDeletes(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    await this.save((current) => {
      const next = current[KEY_PENDING_DELETES].filter((item) =>
        active.has(item.path),
      );
      return next.length === current[KEY_PENDING_DELETES].length
        ? current
        : { ...current, [KEY_PENDING_DELETES]: next };
    });
  }

  // ---- Pending file issues ----

  get pendingIssues(): PendingIssue[] {
    return this.data[KEY_PENDING_ISSUES];
  }

  async reconcilePendingIssues(
    issues: PendingIssue[],
    resolvedPaths: Iterable<string>,
  ): Promise<void> {
    const resolved = new Set(resolvedPaths);
    await this.save((current) => {
      const byPath = new Map(
        current[KEY_PENDING_ISSUES].map((issue) => [issue.path, { ...issue }]),
      );
      for (const path of resolved) {
        byPath.delete(path);
      }
      for (const issue of issues) {
        const nextIssue = { ...issue };
        const existing = byPath.get(issue.path);
        // M17: merge consecutive failures — same version increments counter.
        // === handles undefined correctly: both undefined → same version.
        if (
          existing
          && issue.localHash === existing.localHash
          && (issue.remoteETag ?? "") === (existing.remoteETag ?? "")
        ) {
          nextIssue.consecutiveFailures = (existing.consecutiveFailures ?? 1) + 1;
        } else if (existing && (issue.localHash !== existing.localHash || issue.remoteETag !== existing.remoteETag)) {
          // Version changed — reset counter
          nextIssue.consecutiveFailures = 1;
        }
        byPath.set(issue.path, nextIssue);
      }
      const next = [...byPath.values()];
      return samePendingIssues(current[KEY_PENDING_ISSUES], next)
        ? current
        : { ...current, [KEY_PENDING_ISSUES]: next };
    });
  }

  /** Reset all M17 circuit breaker counters. Call after auth scope change
   *  (re-login with broader permissions) so old failures don't block retries. */
  async resetCircuitBreakers(): Promise<void> {
    await this.save((current) => {
      const nextIssues = current[KEY_PENDING_ISSUES].map((issue) => ({ ...issue }));
      let changed = false;
      for (const issue of nextIssues) {
        if (issue.consecutiveFailures && issue.consecutiveFailures > 0) {
          issue.consecutiveFailures = 0;
          changed = true;
        }
      }
      return changed ? { ...current, [KEY_PENDING_ISSUES]: nextIssues } : current;
    });
  }

  async prunePendingIssues(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    await this.save((current) => {
      const next = current[KEY_PENDING_ISSUES].filter((issue) =>
        active.has(issue.path),
      );
      return next.length === current[KEY_PENDING_ISSUES].length
        ? current
        : { ...current, [KEY_PENDING_ISSUES]: next };
    });
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

  get planReviewRevision(): number {
    return this.data[KEY_PLAN_REVIEW_REVISION];
  }

  get planReviewScope(): SyncScope | null {
    return this.data[KEY_PLAN_REVIEW_SCOPE];
  }

  get planReviewAuthorization(): PlanReviewAuthorization | null {
    if (
      !this.planReviewActive
      || this.planReviewRevision < 1
      || !this.planReviewScope
    ) return null;
    return {
      revision: this.planReviewRevision,
      scope: { ...this.planReviewScope },
    };
  }

  async setPlanReviewBundle(
    items: SyncPlanItem[],
    counts: PlanReviewCounts,
    scope: SyncScope,
  ): Promise<void> {
    const conflicts = items.filter((item) => item.type === SyncActionType.Conflict);
    const deletes = items.filter((item) => item.type === SyncActionType.ConfirmLocalDelete);
    await this.commitPluginData((current) => ({
      ...current,
      [KEY_PENDING_CONFLICTS]: upsertPlanItems(
        current[KEY_PENDING_CONFLICTS],
        conflicts,
      ),
      [KEY_PENDING_DELETES]: upsertPlanItems(
        current[KEY_PENDING_DELETES],
        deletes,
      ),
      [KEY_PLAN_REVIEW_ACTIVE]: true,
      [KEY_PLAN_REVIEW_COUNTS]: counts,
      [KEY_PLAN_REVIEW_ITEMS]: items.map(({ type, path, reason, local, remote }) => ({
        type,
        path,
        reason,
        localHash: local?.hash,
        remoteETag: remote?.eTag,
      })),
      [KEY_PLAN_REVIEW_DIGEST]: planDigest(items),
      [KEY_PLAN_REVIEW_REVISION]: current[KEY_PLAN_REVIEW_REVISION] + 1,
      [KEY_PLAN_REVIEW_SCOPE]: { ...scope },
    }));
  }

  get planReviewDigest(): string {
    return this.data[KEY_PLAN_REVIEW_DIGEST] ?? "";
  }

  async clearPlanReview(expected?: PlanReviewAuthorization): Promise<boolean> {
    let cleared = false;
    await this.commitPluginData((current) => {
      if (expected && (
        !current[KEY_PLAN_REVIEW_ACTIVE]
        || current[KEY_PLAN_REVIEW_REVISION] !== expected.revision
        || !sameSyncScope(current[KEY_PLAN_REVIEW_SCOPE], expected.scope)
      )) return current;
      cleared = true;
      return {
        ...current,
        [KEY_PLAN_REVIEW_ACTIVE]: false,
        [KEY_PLAN_REVIEW_COUNTS]: null,
        [KEY_PLAN_REVIEW_ITEMS]: [],
        [KEY_PLAN_REVIEW_DIGEST]: "",
        [KEY_PLAN_REVIEW_SCOPE]: null,
      };
    });
    return cleared;
  }

  // ---- Sync Time ----

  get lastSyncTime(): number {
    return this.data[KEY_LAST_SYNC_TIME];
  }

  async setLastSyncTime(time: number): Promise<void> {
    await this.save((current) => ({ ...current, [KEY_LAST_SYNC_TIME]: time }));
  }

  // ---- Account binding ----

  get boundAccountId(): string {
    return this.data[KEY_BOUND_ACCOUNT] ?? "";
  }

  /** False after the V2 manifest commits. Legacy V1 writers must fail closed. */
  get legacyAutoSyncAllowed(): boolean {
    return this.legacyStateAllowed;
  }

  /** Bind the vault to an account. Once bound, only this account can sync.
   *  Returns true if binding changed (needs save). */
  async bindAccount(accountId: string): Promise<void> {
    if (this.data[KEY_BOUND_ACCOUNT] === accountId) return;
    await this.save((current) => current[KEY_BOUND_ACCOUNT] === accountId
      ? current
      : { ...current, [KEY_BOUND_ACCOUNT]: accountId });
  }

  get syncHistory(): SyncHistoryEntry[] {
    return this.data[KEY_SYNC_HISTORY];
  }

  async addSyncHistory(entry: SyncHistoryEntry): Promise<void> {
    const normalized = { ...entry, files: retainFileProgress(entry.files) };
    await this.save((current) => ({
      ...current,
      [KEY_SYNC_HISTORY]: [
        normalized,
        ...current[KEY_SYNC_HISTORY].filter((item) => item.id !== entry.id),
      ].slice(0, 10),
    }));
  }

  // ---- Reset ----

  /** Clear all sync state (for "reset" functionality).
   *  Bumps generation BEFORE clearing so any in-flight sync detects the mismatch. */
  async reset(): Promise<void> {
    if (!this.legacyStateAllowed) {
      throw new Error("Legacy reset is disabled after V2 state activation");
    }
    if (this.mutationLedgerCorrupt || this.data[KEY_MUTATION_LEDGER].length > 0) {
      throw new Error("Cannot reset while mutation recovery is unresolved");
    }
    await this.incrementRemoteGeneration();
    await this.save((current) => createDefaultData(
      current[KEY_GENERATION],
      current[KEY_PLAN_REVIEW_REVISION] + 1,
    ));
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
  const rawScope = (state as Partial<RemoteSyncState>).scope;
  if (rawScope !== undefined && rawScope !== null && !isSyncScope(rawScope)) return null;
  if (state.deltaLink !== null && typeof state.deltaLink !== "string") return null;
  if (!state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) {
    return null;
  }
  for (const [path, entry] of Object.entries(state.entries)) {
    if (!isRemoteEntry(entry) || entry.path !== path) return null;
  }
  const rawFolders = (state as Partial<RemoteSyncState>).folders;
  if (rawFolders !== undefined && (
    !rawFolders
    || typeof rawFolders !== "object"
    || Array.isArray(rawFolders)
  )) return null;
  const folders = (rawFolders ?? {}) as Record<string, RemoteFolderEntry>;
  for (const [driveId, folder] of Object.entries(folders)) {
    if (!isRemoteFolderEntry(folder) || folder.driveId !== driveId) return null;
  }
  return {
    version: 1,
    generation: state.generation ?? 0,
    scope: rawScope ?? null,
    deltaLink: state.deltaLink ?? null,
    entries: state.entries as Record<string, RemoteFileEntry>,
    folders,
  };
}

function isSyncScope(value: unknown): value is SyncScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Partial<SyncScope>;
  return typeof scope.accountId === "string"
    && typeof scope.driveId === "string"
    && typeof scope.vaultFolderId === "string"
    && typeof scope.filesRootId === "string";
}

function parseMutationLedger(value: unknown): MutationLedgerEntryV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isMutationLedgerEntry)) return [];
  return value;
}

function isMutationLedgerEntry(value: unknown): value is MutationLedgerEntryV1 {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<MutationLedgerEntryV1>;
  return isMutationIntent(entry.intent)
    && (entry.receipt === null || isMutationReceipt(entry.receipt, entry.intent.operationId));
}

function isMutationIntent(value: unknown): value is MutationIntentV1 {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<MutationIntentV1>;
  return intent.version === 1
    && typeof intent.operationId === "string"
    && Number.isSafeInteger(intent.planRevision)
    && isSyncScope(intent.scope)
    && (intent.action === "upload"
      || intent.action === "download"
      || intent.action === "deleteRemote"
      || intent.action === "renameRemote"
      || intent.action === "deleteLocal"
      || intent.action === "merge")
    && typeof intent.path === "string"
    && (intent.sourcePath === undefined || typeof intent.sourcePath === "string")
    && isMutationLocalExpectation(intent.expectedLocal)
    && isMutationRemoteExpectation(intent.expectedRemote)
    && (intent.target === undefined || isMutationVersion(intent.target))
    && (intent.action !== "merge"
      || (isExistingMutationLocalExpectation(intent.expectedLocal)
        && isExistingMutationRemoteExpectation(intent.expectedRemote)
        && isMutationVersion(intent.target)))
    && typeof intent.createdAt === "number";
}

function isExistingMutationLocalExpectation(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { exists?: unknown }).exists === true);
}

function isExistingMutationRemoteExpectation(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { exists?: unknown }).exists === true);
}

function isMutationVersion(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const version = value as { hash?: unknown; size?: unknown };
  return typeof version.hash === "string"
    && /^[0-9a-f]{64}$/i.test(version.hash)
    && Number.isSafeInteger(version.size)
    && (version.size as number) >= 0;
}

function isMutationLocalExpectation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const expected = value as { exists?: unknown; hash?: unknown; size?: unknown };
  return expected.exists === false
    || (expected.exists === true
      && typeof expected.hash === "string"
      && typeof expected.size === "number");
}

function isMutationRemoteExpectation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const expected = value as {
    exists?: unknown;
    driveId?: unknown;
    eTag?: unknown;
    size?: unknown;
    sha256Hash?: unknown;
  };
  return expected.exists === false
    || (expected.exists === true
      && typeof expected.driveId === "string"
      && typeof expected.eTag === "string"
      && typeof expected.size === "number"
      && (expected.sha256Hash === undefined || typeof expected.sha256Hash === "string"));
}

function isMutationReceipt(value: unknown, operationId: string): value is MutationReceiptV1 {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<MutationReceiptV1>;
  if (
    receipt.version !== 1
    || receipt.operationId !== operationId
    || typeof receipt.completedAt !== "number"
    || !receipt.checkpoint
    || typeof receipt.checkpoint !== "object"
  ) return false;
  const checkpoint = receipt.checkpoint;
  return Array.isArray(checkpoint.baseUpserts)
    && checkpoint.baseUpserts.every(isBaseEntry)
    && Array.isArray(checkpoint.baseRemovals)
    && checkpoint.baseRemovals.every((path) => typeof path === "string")
    && Array.isArray(checkpoint.remoteUpserts)
    && checkpoint.remoteUpserts.every(isRemoteEntry)
    && Array.isArray(checkpoint.remoteDeletes)
    && checkpoint.remoteDeletes.every((path) => typeof path === "string")
    && Array.isArray(checkpoint.pendingConflictRemovals)
    && checkpoint.pendingConflictRemovals.every((path) => typeof path === "string")
    && Array.isArray(checkpoint.pendingDeleteRemovals)
    && checkpoint.pendingDeleteRemovals.every((path) => typeof path === "string");
}

function isBaseEntry(value: unknown): value is BaseFileEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<BaseFileEntry>;
  return typeof entry.path === "string"
    && typeof entry.hash === "string"
    && typeof entry.size === "number"
    && typeof entry.eTag === "string";
}

function isRemoteEntry(value: unknown): value is RemoteFileEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteFileEntry>;
  return typeof entry.path === "string"
    && typeof entry.driveId === "string"
    && (entry.parentId === undefined || typeof entry.parentId === "string")
    && typeof entry.size === "number"
    && typeof entry.mtime === "number"
    && typeof entry.eTag === "string"
    && typeof entry.cTag === "string";
}

function assertRemoteUpsertsHaveParentIdentity(entries: RemoteFileEntry[]): void {
  const incomplete = entries.find((entry) => !entry.parentId);
  if (incomplete) {
    throw new Error(`Remote cache upsert is missing parent identity: ${incomplete.path}`);
  }
}

function isRemoteFolderEntry(value: unknown): value is RemoteFolderEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteFolderEntry>;
  return typeof entry.path === "string"
    && typeof entry.driveId === "string"
    && typeof entry.parentId === "string"
    && typeof entry.name === "string";
}

function sameRemoteEntry(
  left: RemoteFileEntry | undefined,
  right: RemoteFileEntry,
): boolean {
  return left?.path === right.path
    && left.driveId === right.driveId
    && left.parentId === right.parentId
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

function sameRemoteFolderSnapshot(
  left: Record<string, RemoteFolderEntry>,
  right: Record<string, RemoteFolderEntry>,
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return leftIds.length === rightIds.length
    && rightIds.every((id) => {
      const current = left[id];
      const next = right[id];
      return current?.path === next.path
        && current.driveId === next.driveId
        && current.parentId === next.parentId
        && current.name === next.name;
    });
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
