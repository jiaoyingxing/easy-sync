import {
  ButtonComponent,
  ItemView,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  setIcon,
  setTooltip,
} from "obsidian";
import {
  compatCancelAnimationFrame,
  compatRequestAnimationFrame,
  getConfigDir,
  type AnimationFrameHandle,
} from "../obsidian-compat";
import { UpdateReminderModal } from "./update-reminder-modal";
import type EasySyncPlugin from "../main";
import type { CommunityPluginAdoptionRow } from "../main";
import { SyncActionType } from "../sync/types";
import type {
  ManualMutationResolutionChoiceV1,
  ManualMutationResolutionSnapshotV1,
  PlanReviewItem,
  SyncPlanItem,
} from "../sync/types";
import type { LocaleStrings } from "../i18n/types";
import {
  resolveSyncActionPresentation,
  type SyncActionGroup,
} from "../sync/sync-action-presentation";
import {
  type FileProgress,
  isAnySyncActivityRunning,
  isSuccessfulFileProgress,
  type RemoteScopeRecoveryVerificationProgress,
  type SyncProgressState,
} from "../sync/sync-progress";
import type { PendingIssue, SyncHistoryEntry } from "../sync/state-manager";
import {
  formatTransferRate,
  type TransferRateReading,
} from "../sync/transfer-rate";
import { ConfirmModal } from "./confirm-modal";
import { applyDestructiveButton } from "./destructive-button";
import { EmptyFolderResolutionModal } from "./empty-folder-resolution-modal";
import { ConflictDetailModal } from "./conflict-detail-modal";
import { ConfigSyncModal } from "./config-sync-modal";
import { MutationRecoveryResolutionModal } from "./mutation-recovery-resolution-modal";
import {
  RIBBON_STATUS_ICONS,
  resolveRibbonStatus,
  type RibbonStatus,
} from "./ribbon-status";
import {
  handleAuthEntryAction,
  resolveAuthEntryPresentation,
} from "./auth-entry-flow";
import {
  formatMutationRecoveryHistory,
  mutationRecoveryBodyPresentation,
  mutationRecoveryPrimaryActionKey,
  mutationRecoveryTopStatusLabel,
  shouldAutoSettleIdenticalRecovery,
  type MutationRecoveryDisplayState,
} from "./mutation-recovery-presentation";
import { resolveSyncPendingAttentionCounts } from "./sync-result-presentation";
import { parseCommunityPluginBundlePath } from "../sync/community-plugin-bundle";
import type { ManualResolutionEntryReason } from "../sync/manual-resolution-entry";
import { resolveManualResolutionNotice } from "./manual-resolution-presentation";
import {
  resolveSyncActivityPresentation,
  translateSyncActivity,
} from "./sync-status-presentation";

interface StatusPanelState {
  isLoggedIn: boolean;
  isInitializing: boolean;
  isPending: boolean;
  sessionPending: boolean;
  isRunning: boolean;
  canCancel: boolean;
  lastSyncTime: number;
  pendingCount: number;
  planReviewActive: boolean;
  planReviewRevision: number;
  planReviewDetailsState: "ready" | "recovering" | "retry";
  autoSyncPaused: boolean;
  mutationRecovery: MutationRecoveryDisplayState | null;
  latestHistory?: SyncHistoryEntry;
  progress: Readonly<SyncProgressState>;
}

type SyncViewBodyMode = "plan" | "progress" | "pending" | "recovery" | "idle";

/** 工具栏「全部展开／折叠」的会话级覆盖。它只由用户点击改变，跨正文重建与
 *  计划修订保持；"default" 表示交回各区域自己的类别默认态。 */
export type SyncViewSessionOverride = "default" | "expanded" | "collapsed";
type SyncViewStatusDetailMode = "timestamp" | "current-file" | "recovery";

export function resolveSyncViewStatusDetailMode(input: {
  isRunning: boolean;
  activityKind?: SyncProgressState["activityKind"];
  mutationRecoveryVisible: boolean;
}): SyncViewStatusDetailMode {
  if (input.isRunning && input.activityKind !== "mutationRecovery") {
    return "current-file";
  }
  if (input.mutationRecoveryVisible || input.activityKind === "mutationRecovery") {
    return "recovery";
  }
  return "timestamp";
}

export function resolveSyncViewBodyMode(input: {
  planReviewActive: boolean;
  hasSyncState: boolean;
  fullSyncRunning: boolean;
  pendingCount: number;
  sideActionResultsVisible: boolean;
  mutationRecoveryVisible?: boolean;
  remoteScopeRecoveryFailureVisible?: boolean;
  updatePromptVisible?: boolean;
}): SyncViewBodyMode {
  if (input.planReviewActive && input.hasSyncState) return "plan";
  // Pending rows stay visible even while a full sync round is running, so
  // every row type keeps the "click one, it leaves the list, the rest stay
  // clickable" contract (continuous click-in). The top status panel already
  // shows the round's progress. A full sync round only takes over the body
  // when there is nothing left to act on.
  if (input.pendingCount > 0) return "pending";
  if (input.fullSyncRunning) return "progress";
  if (input.sideActionResultsVisible) return "progress";
  if (input.mutationRecoveryVisible) return "recovery";
  if (input.remoteScopeRecoveryFailureVisible) return "progress";
  // Update reminder row renders at the tail of the decision area and never
  // displaces sync decisions: it only fills the body when nothing more
  // important is showing (方案单 20260915-0025 §四 提示层).
  if (input.updatePromptVisible) return "pending";
  return "idle";
}

export type SyncViewPrimaryActionKind =
  | { kind: "cancel" }
  | { kind: "processing" }
  | { kind: "plan-review-restore"; recovering: boolean }
  | { kind: "plan-review-confirm"; migration: boolean }
  | { kind: "recovery"; actionKey: string }
  | { kind: "sync-now" }
  | { kind: "auth"; labelKey: string; cta: boolean; disabled: boolean };

/** Decide which primary action the fixed top status panel renders. Kept pure
 *  so the branch chain has a behaviour-level test gate (review 2026-09-02
 *  finding ⑧, C9 P1): a logged-in user in a recovery state without a real
 *  action (waiting-network/checking/blocked with recoveryActionKey=null)
 *  must keep a working sync-now button — never a dead login button. */
export function resolveSyncViewPrimaryAction(input: {
  isLoggedIn: boolean;
  isRunning: boolean;
  canCancel: boolean;
  planReviewActive: boolean;
  planReviewDetailsState: "ready" | "recovering" | "retry";
  reviewKind: string | null | undefined;
  recoveryActionKey: string | null;
  isInitializing: boolean;
  isPending: boolean;
  devicePending: boolean;
}): SyncViewPrimaryActionKind {
  if (input.isLoggedIn && input.isRunning && input.canCancel) return { kind: "cancel" };
  if (input.isLoggedIn && input.isRunning) return { kind: "processing" };
  if (input.isLoggedIn && input.planReviewActive) {
    if (input.planReviewDetailsState !== "ready") {
      return {
        kind: "plan-review-restore",
        recovering: input.planReviewDetailsState === "recovering",
      };
    }
    return { kind: "plan-review-confirm", migration: input.reviewKind === "v2-migration" };
  }
  if (input.isLoggedIn && input.recoveryActionKey) {
    return { kind: "recovery", actionKey: input.recoveryActionKey };
  }
  if (input.isLoggedIn) {
    return { kind: "sync-now" };
  }
  const authEntry = resolveAuthEntryPresentation({
    isInitializing: input.isInitializing,
    isPending: input.isPending,
    isDevicePending: input.devicePending,
  });
  return {
    kind: "auth",
    labelKey: authEntry.labelKey,
    cta: authEntry.cta,
    disabled: authEntry.disabled,
  };
}

export function resolveRemoteScopeRecoveryFailurePresentation(
  state: Pick<RemoteScopeRecoveryVerificationProgress, "failureStage" | "firstFailurePath">,
  t: (key: keyof LocaleStrings) => string,
): { title: string; summary: string; path: string | null; nextStep: string } | null {
  if (!state.failureStage) return null;
  return {
    title: t("syncView.progress.remoteScopeRecoveryFailureTitle"),
    summary: t("syncView.progress.remoteScopeRecoveryFailureSummary"),
    path: state.firstFailurePath ?? null,
    nextStep: t("syncView.progress.remoteScopeRecoveryFailureNextStep"),
  };
}

export interface SyncViewContentKeyInput {
  isLoggedIn: boolean;
  isInitializing: boolean;
  isPending: boolean;
  /** Session present but the account is not verified yet — the status panel
   *  shows "connecting" instead of a healthy ready/synced state. */
  sessionPending?: boolean;
  isRunning: boolean;
  canCancel: boolean;
  bodyMode: SyncViewBodyMode;
  progress: Readonly<SyncProgressState>;
  planReviewActive: boolean;
  planReviewDetailsState: "ready" | "recovering" | "retry";
  pendingIssues: PendingIssue[];
  /** Pre-grouped pending issues from doRender — the key builder reuses them
   *  instead of re-running the grouping a second time per render. */
  pendingIssueGroups?: PendingIssueReviewGroup[];
  conflicts: SyncPlanItem[];
  pendingDeletes: SyncPlanItem[];
  adoptionRows: CommunityPluginAdoptionRow[];
  planReviewCounts: { uploads: number; downloads: number; folders?: number; deletes: number; conflicts: number; skipped: number } | null;
  planReviewRevision: number;
  history: SyncHistoryEntry[];
  lastSyncTime: number;
  mutationRecovery: MutationRecoveryDisplayState | null;
}

export interface PendingIssueReviewGroup {
  issue: PendingIssue;
  nestedIssues: PendingIssue[];
}

/** Keep one review entry for nested instances of the same missing-local tree. */
export function groupPendingIssuesForReview(
  issues: readonly PendingIssue[],
): PendingIssueReviewGroup[] {
  // The nested-tree grouping only ever pairs anchored-folder-missing-local
  // issues with each other, so the candidate set is collected once instead of
  // rescanning the whole list per issue (O(n·k) → O(n + k²), k = folder
  // issues). Semantics identical to the previous per-issue full scans.
  const folderIssues = issues.filter((issue) =>
    issue.issueCode === "anchored-folder-missing-local",
  );
  return issues.map((issue, index) => ({ issue, index }))
    .filter(({ issue }) =>
      issue.issueCode !== "anchored-folder-missing-local"
        || !folderIssues.some((candidate) =>
          candidate !== issue && isNestedPath(issue.path, candidate.path),
        ),
    )
    .map(({ issue }) => ({
      issue,
      nestedIssues: issue.issueCode === "anchored-folder-missing-local"
        ? folderIssues.filter((candidate) =>
          candidate !== issue
            && isNestedPath(candidate.path, issue.path),
        )
        : [],
    }));
}

/** One mountable row of the pending section, in display order. */
export interface SyncPendingDisplayRow {
  key: string;
  kind: "adoption" | "issue" | "conflict" | "pluginConflict" | "batchDelete" | "delete";
  adoption?: CommunityPluginAdoptionRow;
  issue?: PendingIssue;
  nestedIssues?: PendingIssue[];
  retryable?: boolean;
  item?: SyncPlanItem;
  pluginConflict?: { pluginId: string; items: SyncPlanItem[] };
  deletes?: SyncPlanItem[];
}

/**
 * Resolve the pending section into the DOM rows it actually produces, in
 * display order (adoptions → failures → conflicts → batch delete → per-item
 * deletes → skips). Deriving the rows from the whole section keeps every key —
 * and therefore each row's expansion memory and in-flight pin — independent of
 * which rows the current scroll window happens to contain.
 */
export function buildSyncPendingDisplayRows(input: Readonly<{
  adoptionRows: readonly CommunityPluginAdoptionRow[];
  failures: readonly PendingIssueReviewGroup[];
  conflictEntries: readonly BundleConflictReviewEntry[];
  pendingDeletes: readonly SyncPlanItem[];
  skipped: readonly PendingIssueReviewGroup[];
}>): SyncPendingDisplayRow[] {
  const rows: SyncPendingDisplayRow[] = [];
  const seen = new Set<string>();
  const push = (row: SyncPendingDisplayRow) => {
    if (seen.has(row.key)) return;
    seen.add(row.key);
    rows.push(row);
  };
  for (const adoption of input.adoptionRows) {
    push({
      key: `adoption:${adoption.pluginId}`,
      kind: "adoption",
      adoption,
    });
  }
  for (const { issue, nestedIssues } of input.failures) {
    push({
      key: `issue:${issue.actionType}:${issue.issueCode ?? ""}:${issue.path}`,
      kind: "issue",
      issue,
      nestedIssues,
      retryable: true,
    });
  }
  for (const entry of input.conflictEntries) {
    if (entry.kind === "file") {
      push({
        key: `conflict:${entry.item.path}`,
        kind: "conflict",
        item: entry.item,
      });
    } else {
      push({
        key: `plugin:${entry.pluginId}`,
        kind: "pluginConflict",
        pluginConflict: { pluginId: entry.pluginId, items: entry.items },
      });
    }
  }
  if (isBatchedDeleteSet(input.pendingDeletes.map((item) => `delete:${item.path}`))) {
    push({
      key: "batch-delete",
      kind: "batchDelete",
      deletes: [...input.pendingDeletes],
    });
  }
  for (const item of input.pendingDeletes) {
    push({ key: `delete:${item.path}`, kind: "delete", item });
  }
  for (const { issue, nestedIssues } of input.skipped) {
    push({
      key: `issue:${issue.actionType}:${issue.issueCode ?? ""}:${issue.path}`,
      kind: "issue",
      issue,
      nestedIssues,
      retryable: false,
    });
  }
  return rows;
}

function remoteScopeRecoveryPercent(
  state: Readonly<SyncProgressState>,
): number | null {
  const recovery = state.recoveryVerification;
  if (!recovery || recovery.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(
    ((recovery.reused + recovery.verifiedThisRun) / recovery.total) * 100,
  )));
}

const FILE_STATUS_ICONS: Record<FileProgress["status"], string> = {
  upload: "arrow-up",
  download: "arrow-down",
  folder: "folder-plus",
  delete: "trash-2",
  conflict: "triangle-alert",
  skip: "circle-slash-2",
  error: "circle-x",
};

function commonDirPrefix(paths: string[]): string {
  if (paths.length < 2) return "";
  const parts = paths.map((path) => path.split("/"));
  const limit = Math.min(...parts.map((path) => path.length)) - 1;
  let depth = 0;
  for (let index = 0; index < limit; index++) {
    if (!parts.every((path) => path[index] === parts[0][index])) break;
    depth = index + 1;
  }
  return depth > 0 ? `${parts[0].slice(0, depth).join("/")}/` : "";
}

export function trimFilePathPrefix(path: string, prefix: string): string {
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export interface AdaptivePathLayoutInput {
  path: string;
  availableWidth: number;
  measureTextWidth: (text: string) => number;
}

export interface AdaptivePathLayoutDecision {
  displayPath: string;
  directory: string | null;
  directoryKind: "shared" | "isolated" | null;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator >= 0 ? path.slice(0, separator) : "";
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function isNestedPath(path: string, parent: string): boolean {
  return path.length > parent.length && path.startsWith(`${parent}/`);
}

function pathExtractionHelps(
  item: AdaptivePathLayoutInput,
  displayPath: string,
): boolean {
  if (item.availableWidth <= 0) return false;
  const fullWidth = item.measureTextWidth(item.path);
  if (fullWidth <= item.availableWidth + 1) return false;
  return item.measureTextWidth(displayPath) + 1 < fullWidth;
}

/** 灰字目录放不下时的显示串：保尾巴而不是保头。头部省略号截断留住的是
 *  各库相同的浅层根前缀，路径越深可见部分越无信息，灰字行退化成一条
 *  「稍宽的空格」却仍占一行（用户 2026-09-24 报告的挤压/行距观感）。这里
 *  反过来保住最深的层段——最区分位置的部分——以「…/」标记被截的头。
 *  availableWidth 与 measureTextWidth 处于同一盒模型域（调用方用目录元素
 *  的 clientWidth／scrollWidth），尾部连最深一段都放不下时原样返回，交给
 *  CSS 头部省略号兜底。 */
export function fitDirectoryTail(
  directory: string,
  availableWidth: number,
  measureTextWidth: (text: string) => number,
): string {
  if (availableWidth <= 0 || directory.endsWith("…")) return directory;
  if (measureTextWidth(directory) <= availableWidth) return directory;
  const parts = directory.split("/").filter(Boolean);
  if (parts.length === 0) return directory;
  for (let from = 1; from < parts.length; from++) {
    const candidate = `…/${parts.slice(from).join("/")}/`;
    if (measureTextWidth(candidate) <= availableWidth) return candidate;
  }
  return directory;
}

/**
 * Derive path summaries from actual rendered width. Shared summaries only
 * span adjacent rows so the existing order remains truthful.
 */
export function buildAdaptivePathLayout(
  items: readonly AdaptivePathLayoutInput[],
): AdaptivePathLayoutDecision[] {
  const decisions = items.map<AdaptivePathLayoutDecision>((item) => ({
    displayPath: item.path,
    directory: null,
    directoryKind: null,
  }));

  let index = 0;
  while (index < items.length) {
    const next = items[index + 1];
    const sharedPrefix = next
      ? commonDirPrefix([items[index].path, next.path])
      : "";
    if (sharedPrefix) {
      let end = index + 1;
      while (
        end + 1 < items.length
        && items[end + 1].path.startsWith(sharedPrefix)
      ) {
        end++;
      }
      const sharedHelps = items
        .slice(index, end + 1)
        .some((item) => pathExtractionHelps(
          item,
          trimFilePathPrefix(item.path, sharedPrefix),
        ));
      if (sharedHelps) {
        for (let itemIndex = index; itemIndex <= end; itemIndex++) {
          decisions[itemIndex] = {
            displayPath: trimFilePathPrefix(
              items[itemIndex].path,
              sharedPrefix,
            ),
            directory: itemIndex === index ? sharedPrefix : null,
            directoryKind: itemIndex === index ? "shared" : null,
          };
        }
        index = end + 1;
        continue;
      }
    }

    const item = items[index];
    const directory = parentPath(item.path);
    if (
      directory
      && pathDepth(directory) >= 2
      && pathExtractionHelps(item, trimFilePathPrefix(
        item.path,
        `${directory}/`,
      ))
    ) {
      decisions[index] = {
        displayPath: trimFilePathPrefix(item.path, `${directory}/`),
        directory: `${directory}/`,
        directoryKind: "isolated",
      };
    }
    index++;
  }

  return decisions;
}

/** Per-row content identity: the same five fields the list renders, so a
 *  re-completed path (new entry, same path) produces a different key and the
 *  diff moves the row to the top instead of leaving stale content behind. */
function completedFileRowKey(
  file: Pick<FileProgress, "path" | "sourcePath" | "status" | "actionType" | "reason">,
): string {
  return `${file.path}\u0000${file.sourcePath ?? ""}\u0000${file.status}\u0000${file.actionType ?? ""}\u0000${file.reason ?? ""}`;
}

export interface CompletedFileRowsDiff {
  /** Rows to insert at the top, newest first. */
  prepend: FileProgress[];
  /** Rendered paths that must leave the list (re-completed or retired). */
  removePaths: string[];
  /** Ledger state after applying this diff. */
  nextLedger: Map<string, string>;
}

/** Incremental mount diff for the read-only completed-file list.
 *
 *  The visible list is newest first and deduped by path (a later completion
 *  of the same path supersedes the older row). Comparing the previous
 *  path→row-key ledger against the desired order yields the minimal DOM
 *  operations: prepend new rows, remove re-completed or cap-retired rows.
 *  Completed entries are append-immutable (sync-progress only appends and
 *  trims), so a row key can never change without a new entry arriving. */
export function diffCompletedFileRows(
  ledger: ReadonlyMap<string, string>,
  files: readonly FileProgress[],
): CompletedFileRowsDiff {
  const newestByPath = new Map<string, FileProgress>();
  const order: string[] = [];
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i];
    if (newestByPath.has(file.path)) continue;
    newestByPath.set(file.path, file);
    order.push(file.path);
  }

  const prepend: FileProgress[] = [];
  const removePaths: string[] = [];
  const nextLedger = new Map<string, string>();
  for (const path of order) {
    const file = newestByPath.get(path);
    if (!file) continue;
    const key = completedFileRowKey(file);
    nextLedger.set(path, key);
    const previous = ledger.get(path);
    if (previous === key) continue;
    if (previous !== undefined) removePaths.push(path);
    prepend.push(file);
  }
  for (const path of ledger.keys()) {
    if (!nextLedger.has(path)) removePaths.push(path);
  }
  return { prepend, removePaths, nextLedger };
}

export interface SyncPlanDisplayGroup {
  group: SyncActionGroup;
  labelKey: keyof LocaleStrings;
  items: PlanReviewItem[];
}

export function shouldAutoRebuildPlanReview(
  counts: SyncViewContentKeyInput["planReviewCounts"],
  items: readonly PlanReviewItem[],
): boolean {
  if (!counts || items.length > 0) return false;
  return counts.uploads
    + counts.downloads
    + (counts.folders ?? 0)
    + counts.deletes
    + counts.conflicts
    + counts.skipped > 0;
}

export function resolvePlanReviewDetailsState(
  detailsMissing: boolean,
  recoveryInFlight: boolean,
): "ready" | "recovering" | "retry" {
  if (!detailsMissing) return "ready";
  return recoveryInFlight ? "recovering" : "retry";
}

export const SYNC_PLAN_VIRTUAL_OVERSCAN = 6;

/**
 * Invisible text for the row-height probes. It is only ever set on a detached,
 * hidden probe that is removed right after measuring, and it is kept off the
 * call sites as a literal so the sentence-case UI lint cannot read it as copy.
 */
const PLAN_ROW_PROBE_TEXT = "measure";

export function buildSyncPlanVirtualOffsets(
  items: readonly Pick<PlanReviewItem, "reason">[],
  rowHeight: number,
  reasonRowHeight: number,
): number[] {
  const safeRowHeight = Math.max(1, rowHeight);
  const safeReasonRowHeight = Math.max(safeRowHeight, reasonRowHeight);
  const offsets = [0];
  for (const item of items) {
    offsets.push(
      offsets[offsets.length - 1]
      + (item.reason ? safeReasonRowHeight : safeRowHeight),
    );
  }
  return offsets;
}

export function buildSyncPlanVirtualWindow(input: Readonly<{
  offsets: readonly number[];
  listTop: number;
  viewportTop: number;
  viewportBottom: number;
  overscan?: number;
}>): { start: number; end: number; offset: number; totalHeight: number } {
  const itemCount = Math.max(0, input.offsets.length - 1);
  const overscan = Math.max(0, Math.trunc(input.overscan ?? SYNC_PLAN_VIRTUAL_OVERSCAN));
  const totalHeight = input.offsets[itemCount] ?? 0;
  const visibleTop = Math.max(0, input.viewportTop - input.listTop);
  const visibleBottom = Math.min(totalHeight, input.viewportBottom - input.listTop);
  if (itemCount === 0 || visibleBottom <= 0 || visibleTop >= totalHeight) {
    return { start: 0, end: 0, offset: 0, totalHeight };
  }
  let start = 0;
  let startUpper = itemCount;
  while (start < startUpper) {
    const middle = Math.floor((start + startUpper) / 2);
    if ((input.offsets[middle + 1] ?? totalHeight) <= visibleTop) {
      start = middle + 1;
    } else {
      startUpper = middle;
    }
  }
  let end = start;
  let endUpper = itemCount;
  while (end < endUpper) {
    const middle = Math.floor((end + endUpper) / 2);
    if ((input.offsets[middle] ?? 0) < visibleBottom) {
      end = middle + 1;
    } else {
      endUpper = middle;
    }
  }
  start = Math.max(0, start - overscan);
  end = Math.min(itemCount, end + overscan);
  return {
    start,
    end,
    offset: input.offsets[start] ?? 0,
    totalHeight,
  };
}

export interface SyncPlanDisplayRow {
  /** Stable identity for the mounted row; also the key for its open state. */
  key: string;
  item: PlanReviewItem;
  /** Plugin bundle this conflict row stands for: a community plugin, or
   *  EasySync's own three files, when it does. */
  pluginConflict: { pluginId: string; items: SyncPlanItem[] } | null;
}

/**
 * Resolve a group's plan items into the DOM rows they actually produce. One
 * bundle conflict renders a single row for the whole bundle (a community
 * plugin, or EasySync's own files) — the first member in plan order wins —
 * and an item whose conflict or delete detail is missing degrades to a plain
 * row. Deriving the rows from the whole group keeps that choice independent
 * of which items the current scroll window happens to contain.
 */
export function buildSyncPlanDisplayRows(
  items: readonly PlanReviewItem[],
  conflictByPath: ReadonlyMap<string, SyncPlanItem>,
  deleteByPath: ReadonlyMap<string, SyncPlanItem>,
  pluginConflictByPath: ReadonlyMap<string, {
    pluginId: string;
    items: SyncPlanItem[];
  }>,
): SyncPlanDisplayRow[] {
  const rows: SyncPlanDisplayRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let key: string;
    let pluginConflict: SyncPlanDisplayRow["pluginConflict"] = null;
    if (item.type === SyncActionType.Conflict && conflictByPath.has(item.path)) {
      pluginConflict = pluginConflictByPath.get(item.path) ?? null;
      key = pluginConflict
        ? `plugin:${pluginConflict.pluginId}`
        : `conflict:${item.path}`;
    } else if (
      item.type === SyncActionType.ConfirmLocalDelete
      && deleteByPath.has(item.path)
    ) {
      key = `delete:${item.path}`;
    } else {
      key = `row:${item.type}:${item.path}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, item, pluginConflict });
  }
  return rows;
}

/** 决策行＝折叠里藏着该条目唯一出口的行（冲突、插件捆绑冲突、插件待决策、
 *  待确认删除）；只读行（问题、跳过、普通计划行）的出口在顶部主动作或自动
 *  轮次，不靠行内展开。key 前缀就是行身份族，见两处 build*DisplayRows。 */
export function isDecisionRowKey(key: string): boolean {
  return key.startsWith("conflict:")
    || key.startsWith("delete:")
    || key.startsWith("plugin:")
    || key.startsWith("adoption:");
}

/** 成批的待确认删除：同一区域会出现两条及以上逐条删除行——与界面给出批量
 *  删除入口的同一条件。成批时该区域的出口是批量入口，逐条行不再默认展开。 */
export function isBatchedDeleteSet(keys: readonly string[]): boolean {
  let count = 0;
  for (const key of keys) {
    if (!key.startsWith("delete:")) continue;
    count += 1;
    if (count > 1) return true;
  }
  return false;
}

/** 决策行的类别默认态：决策行默认展开，出口第一眼可见；成批出现的待确认
 *  删除默认收起。只读行不在此列（它们没有行身份，也不会被写成展开态）。 */
export function resolveDecisionRowDefaultOpen(
  key: string,
  options: { deleteRowsBatched?: boolean } = {},
): boolean {
  if (!isDecisionRowKey(key)) return false;
  if (key.startsWith("delete:")) return options.deleteRowsBatched !== true;
  return true;
}

/** Offsets for rows whose height is not uniform (a decision row grows when its
 *  body is expanded), so every slot has to carry its own measured height. */
export function buildSyncPlanMeasuredVirtualOffsets(
  heights: readonly number[],
): number[] {
  const offsets = [0];
  for (const height of heights) {
    offsets.push(offsets[offsets.length - 1] + Math.max(1, height));
  }
  return offsets;
}

export function buildSyncPlanDisplayGroups(
  items: readonly PlanReviewItem[],
): SyncPlanDisplayGroup[] {
  const groups = new Map<SyncActionGroup, SyncPlanDisplayGroup & { order: number }>();
  for (const item of items) {
    const presentation = resolveSyncActionPresentation(item.type);
    const existing = groups.get(presentation.group);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(presentation.group, {
      group: presentation.group,
      labelKey: presentation.groupLabelKey,
      order: presentation.groupOrder,
      items: [item],
    });
  }
  return [...groups.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...group }) => group);
}

export function formatSyncHistoryCounts(
  entry: SyncHistoryEntry,
  t: (key: string) => string,
): string {
  const pending = resolveSyncPendingAttentionCounts(
    entry.conflicts,
    entry.files,
  );
  const values: Array<[keyof LocaleStrings, number]> = [
    ["syncAction.group.upload", entry.uploaded],
    ["syncAction.group.download", entry.downloaded],
    ["syncAction.summary.fileMoves", entry.filesMoved ?? 0],
    ["syncAction.summary.foldersCreated", entry.foldersCreated ?? 0],
    ["syncAction.summary.foldersMoved", entry.foldersMoved ?? 0],
    ["syncAction.summary.foldersDeleted", entry.foldersDeleted ?? 0],
    ["syncAction.summary.filesDeleted", entry.deleted],
    ["syncAction.group.conflict", pending.conflicts],
    ["syncAction.summary.remoteDeletesPending", pending.remoteDeletes],
    ["syncAction.summary.deferred", entry.deferred ?? 0],
    ["syncAction.summary.skipped", entry.skipped],
    ["syncAction.summary.errors", entry.errors],
  ];
  return values
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${t(key)} ${count}`)
    .join(" · ");
}

export function countOmittedSyncHistorySuccessfulFiles(
  entry: SyncHistoryEntry,
): number {
  const successfulActionTotal = entry.uploaded + entry.downloaded
    + (entry.filesMoved ?? 0) + (entry.foldersCreated ?? 0)
    + (entry.foldersMoved ?? 0) + (entry.foldersDeleted ?? 0)
    + entry.deleted;
  const retainedSuccessfulTotal = entry.files
    .filter(isSuccessfulFileProgress)
    .length;
  return Math.max(0, successfulActionTotal - retainedSuccessfulTotal);
}

export function resolveFileProgressPresentation(
  file: Pick<FileProgress, "path" | "sourcePath" | "status" | "actionType">,
): { icon: string; labelKey: keyof LocaleStrings | null } {
  const action = file.actionType
    ? resolveSyncActionPresentation(file.actionType)
    : null;
  const result = resolveFileProgressChipKey(file);
  return {
    icon: result === "syncView.fileStatus.error"
      ? FILE_STATUS_ICONS.error
      : action?.icon ?? FILE_STATUS_ICONS[file.status],
    labelKey: result,
  };
}

function resolveFileProgressChipKey(
  file: Pick<FileProgress, "path" | "sourcePath" | "status" | "actionType">,
): keyof LocaleStrings | null {
  if (
    file.actionType === SyncActionType.AuthExpired
    || file.actionType === SyncActionType.RecreateRemoteScope
  ) {
    return null;
  }
  if (
    file.actionType === SyncActionType.RetryLater
    || file.actionType === SyncActionType.FolderDeferred
  ) {
    return "syncView.fileStatus.notSynced";
  }
  if (
    file.actionType === SyncActionType.SkipLargeFile
    || file.actionType === SyncActionType.SkipIgnoredPath
    || file.actionType === SyncActionType.SkipOneDriveInvalidName
  ) {
    return "syncView.fileStatus.skip";
  }
  if (file.status === "error") return "syncView.fileStatus.error";

  switch (file.actionType) {
    case SyncActionType.Upload:
      return "syncView.fileStatus.upload";
    case SyncActionType.Download:
      return "syncView.fileStatus.download";
    case SyncActionType.CreateRemoteFolder:
    case SyncActionType.CreateLocalFolder:
      return "syncView.fileStatus.create";
    case SyncActionType.MoveRemoteFolder:
    case SyncActionType.MoveLocalFolder:
    case SyncActionType.RenameRemote:
    case SyncActionType.MoveLocalFile:
      if (!file.sourcePath || file.sourcePath === file.path) return null;
      return parentPath(file.sourcePath) === parentPath(file.path)
        ? "syncView.fileStatus.rename"
        : "syncView.fileStatus.move";
    case SyncActionType.DeleteRemoteFolder:
    case SyncActionType.DeleteLocalFolder:
    case SyncActionType.DeleteRemote:
    case SyncActionType.DeleteLocal:
      return "syncView.fileStatus.delete";
    case SyncActionType.ConfirmLocalDelete:
      return file.status === "delete"
        ? "syncView.fileStatus.delete"
        : "syncView.fileStatus.pendingConfirmation";
    case SyncActionType.Conflict:
      return file.status === "conflict"
        ? "syncView.fileStatus.conflict"
        : null;
    case undefined:
      if (file.status === "upload") return "syncView.fileStatus.upload";
      if (file.status === "download") return "syncView.fileStatus.download";
      if (file.status === "delete") return "syncView.fileStatus.delete";
      return null;
    default:
      return null;
  }
}

export function formatFileProgressLabel(
  file: Pick<FileProgress, "path" | "sourcePath" | "status" | "actionType">,
  t: (key: string) => string,
): string | null {
  const presentation = resolveFileProgressPresentation(file);
  return presentation.labelKey ? t(presentation.labelKey) : null;
}

export function formatPendingIssueChipLabel(
  actionType: SyncActionType,
  t: (key: string) => string,
): string | null {
  if (
    actionType === SyncActionType.AuthExpired
    || actionType === SyncActionType.RecreateRemoteScope
  ) {
    return null;
  }
  if (
    actionType === SyncActionType.RetryLater
    || actionType === SyncActionType.FolderDeferred
  ) {
    return t("syncView.fileStatus.notSynced");
  }
  if (
    actionType === SyncActionType.SkipLargeFile
    || actionType === SyncActionType.SkipIgnoredPath
    || actionType === SyncActionType.SkipOneDriveInvalidName
  ) {
    return t("syncView.fileStatus.skip");
  }
  return t("syncView.fileStatus.error");
}

export type BundleConflictReviewEntry =
  | { kind: "file"; item: SyncPlanItem }
  | {
      kind: "bundle";
      pluginId: string;
      items: SyncPlanItem[];
    };

/** Preserve first-seen order while presenting one row per bundle: one for a
 *  community plugin, and one for EasySync's own three bundle files (which
 *  would otherwise show up as bare config paths the user cannot place). */
export function groupBundleConflictReviews(
  conflicts: readonly SyncPlanItem[],
  configDir: string,
): BundleConflictReviewEntry[] {
  const pluginItems = new Map<string, SyncPlanItem[]>();
  for (const item of conflicts) {
    const parsed = parseCommunityPluginBundlePath(item.path, configDir);
    if (!parsed) continue;
    const items = pluginItems.get(parsed.pluginId) ?? [];
    items.push(item);
    pluginItems.set(parsed.pluginId, items);
  }
  const emitted = new Set<string>();
  const result: BundleConflictReviewEntry[] = [];
  for (const item of conflicts) {
    const parsed = parseCommunityPluginBundlePath(item.path, configDir);
    if (!parsed) {
      result.push({ kind: "file", item });
      continue;
    }
    if (emitted.has(parsed.pluginId)) continue;
    emitted.add(parsed.pluginId);
    result.push({
      kind: "bundle",
      pluginId: parsed.pluginId,
      items: pluginItems.get(parsed.pluginId) ?? [item],
    });
  }
  return result;
}

export const SYNC_VIEW_TYPE = "easy-sync-detail";

export function buildSyncViewContentKey(
  historyExpanded: boolean,
  input: SyncViewContentKeyInput,
): string {
  const authKey = `auth:${input.isInitializing ? 1 : 0}:${input.isLoggedIn ? 1 : 0}:${input.isPending ? 1 : 0}:${input.sessionPending ? 1 : 0}`;
  const runKey = `run:${input.isRunning ? 1 : 0}:${input.canCancel ? 1 : 0}`;
  const recovery = input.mutationRecovery;
  const recoveryKey = recovery
    ? `recovery:${recovery.kind}:${recovery.total}:${recovery.settled}:${recovery.remaining}:${recovery.retryAt ?? ""}:${recovery.blockReason ?? ""}:${recovery.blockedOperationId ?? ""}:${recovery.manualResolutionAvailable ? 1 : 0}:${recovery.firstPath ?? ""}`
    : "recovery:none";
  const historyIds = input.history.map((entry) => {
    const itemRecovery = entry.recovery;
    const scopeRecovery = entry.remoteScopeRecovery;
    const messageKey = JSON.stringify(entry.message ?? "");
    const runFactsKey = entry.runFacts
      ? `${entry.runFacts.termination}:${entry.runFacts.ordinaryPlanning}:${entry.runFacts.userFileChanges}`
      : "legacy";
    const scopeRecoveryKey = scopeRecovery
      ? `${scopeRecovery.operationFingerprint}:${scopeRecovery.protocolPreflight}:${scopeRecovery.total}:${scopeRecovery.verifiedThisRun}:${scopeRecovery.reused}:${scopeRecovery.invalidated}:${scopeRecovery.remaining}:${scopeRecovery.failureStage ?? ""}:${scopeRecovery.firstFailurePath ?? ""}`
      : "";
    return itemRecovery
      ? `${entry.id}:${entry.status}:${messageKey}:${runFactsKey}:${itemRecovery.state}:${itemRecovery.total}:${itemRecovery.settled}:${itemRecovery.remaining}:${itemRecovery.retryAt ?? ""}:${itemRecovery.blockReason ?? ""}:${scopeRecoveryKey}`
      : `${entry.id}:${entry.status}:${messageKey}:${runFactsKey}:${scopeRecoveryKey}`;
  }).join("|");
  const historyKey = historyExpanded ? `history:open:${historyIds}` : "history:closed";
  if (input.bodyMode === "plan") {
    const counts = input.planReviewCounts
      ? `${input.planReviewCounts.uploads},${input.planReviewCounts.downloads},${input.planReviewCounts.folders ?? 0},${input.planReviewCounts.deletes},${input.planReviewCounts.conflicts},${input.planReviewCounts.skipped}`
      : "";
    return `plan:${authKey}:${runKey}:${recoveryKey}:${counts}:details:${input.planReviewDetailsState}:revision:${input.planReviewRevision}:${historyKey}`;
  }
  if (input.bodyMode === "progress") {
    const scopeRecovery = input.progress.recoveryVerification;
    const progressStructure = input.progress.total > 0
      || (scopeRecovery?.total ?? 0) > 0
      ? "determinate"
      : "indeterminate";
    const scopeRecoveryKey = scopeRecovery
      ? `${scopeRecovery.operationFingerprint}:${scopeRecovery.protocolPreflight}:${scopeRecovery.total}:${scopeRecovery.verifiedThisRun}:${scopeRecovery.reused}:${scopeRecovery.invalidated}:${scopeRecovery.remaining}:${scopeRecovery.failureStage ?? ""}:${scopeRecovery.firstFailurePath ?? ""}`
      : "none";
    return `progress:${authKey}:${runKey}:${recoveryKey}:${input.progress.phase}:${progressStructure}:scope-proof:${scopeRecoveryKey}:${historyKey}`;
  }
  if (input.bodyMode === "pending") {
    const issues = (input.pendingIssueGroups ?? groupPendingIssuesForReview(input.pendingIssues))
      .map(({ issue, nestedIssues }) =>
        `${issue.actionType}:${issue.issueCode ?? ""}:${issue.path}:${issue.updatedAt}:${issue.reason ?? ""}:nested:${nestedIssues.map((nested) => nested.path).join(",")}`)
      .join("|");
    const conflicts = input.conflicts
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    const deletes = input.pendingDeletes
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    const adoption = (input.adoptionRows ?? [])
      .map((row) =>
        `${row.pluginId}:${row.displayName}:${row.desktopOnly ? 1 : 0}`
      )
      .join("|");
    return `pending:${authKey}:${runKey}:${recoveryKey}:${issues}:${conflicts}:${deletes}:adoption:${adoption}:${historyKey}`;
  }
  if (input.bodyMode === "recovery") {
    return `recovery:${authKey}:${runKey}:${recoveryKey}:${historyKey}`;
  }
  return `idle:${authKey}:${runKey}:${recoveryKey}:${input.lastSyncTime}:${historyKey}`;
}

/** Format byte progress as "downloaded/total unit" with unit shown once. */
function formatByteProgress(downloaded: number, total: number): string {
  if (total >= 1_048_576) return `${(downloaded/1_048_576).toFixed(1)}/${(total/1_048_576).toFixed(1)} MB`;
  if (total >= 1_024) return `${Math.round(downloaded/1_024)}/${Math.round(total/1_024)} KB`;
  return `${downloaded}/${total} B`;
}

export function syncViewProgressPercent(state: Readonly<SyncProgressState>): number {
  if (state.total <= 0) return 0;
  return Math.min(100, Math.round((state.current / state.total) * 100));
}

function configureFilePath(
  root: HTMLElement,
  pathEl: HTMLElement,
  path: string,
  adaptive: boolean,
): void {
  pathEl.setText(path);
  pathEl.setAttribute("aria-label", path);
  setTooltip(pathEl, path);
  if (!adaptive) return;
  root.addClass("easy-sync-path-layout-item");
  pathEl.addClass("easy-sync-adaptive-path");
  pathEl.dataset.easySyncFullPath = path;
}

function renderFileRow(
  file: FileProgress,
  list: HTMLElement,
  t: (key: string) => string,
  adaptive: boolean,
): HTMLElement {
  const row = list.createDiv("easy-sync-file-row");
  row.dataset.easySyncCompletedPath = file.path;
  const icon = row.createSpan("easy-sync-file-icon");
  const presentation = resolveFileProgressPresentation(file);
  setIcon(icon, presentation.icon);
  const pathEl = row.createSpan("easy-sync-file-path");
  configureFilePath(row, pathEl, file.path, adaptive);
  const chipLabel = formatFileProgressLabel(file, t);
  if (chipLabel) row.createSpan("easy-sync-tree-chip").setText(chipLabel);
  if (file.reason) row.createDiv("easy-sync-file-reason").setText(file.reason);
  return row;
}

export function shouldExpandAllVisibleDetails(
  openStates: readonly boolean[],
): boolean {
  return openStates.some((open) => !open);
}

export class EasySyncSyncView extends ItemView {
  plugin: EasySyncPlugin;
  private historyExpanded = false;
  private sessionOverride: SyncViewSessionOverride = "default";
  // 组级手势与行级同族：记录用户对单个分组的显式开合（默认展开的分组也必须
  // 记住用户收起过它，否则正文重建会让它弹开）。
  private planGroupExpandedState = new Map<SyncActionGroup, boolean>();
  private collapseToggleButtonEl: HTMLButtonElement | null = null;
  private renderedBodyMode: SyncViewBodyMode = "idle";
  private renderedPlanReviewRevision = -1;
  private autoRebuiltPlanReviewRevision = -1;
  private planReviewDetailsRecoveryInFlight = false;
  // P0: incremental render — frame merging + diffed file list
  private renderFrameId: AnimationFrameHandle | null = null;
  private lastContentKey: string | null = null;
  // Cached DOM refs for direct progress-bar updates
  private progressPanelEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressSubtitleEl: HTMLElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private completedFileRowsLedger: Map<string, string> | null = null;
  private planViewportFrameId: AnimationFrameHandle | null = null;
  private planVirtualRenderers = new Set<() => void>();
  // Windowed decision rows are unmounted while off screen, so their open state
  // and their measured height have to outlive the DOM they were read from.
  private planRowExpandedState = new Map<string, boolean>();
  private planRowHeights = new Map<string, number>();
  private planRowLayoutRevision = 0;
  private planDecisionRowsInFlight = new Set<string>();
  // 当前正文区域是否含成批的待确认删除（决定逐条删除行的类别默认态）。
  // 区域渲染时写下，正文整体重建后回填展开态时读回；正文没有决策行时该值
  // 不产生作用。
  private renderedDeleteRowsBatched = false;
  private pathLayoutObserver: ResizeObserver | null = null;
  private pathLayoutObservedWidth = -1;
  private statusLineEl: HTMLElement | null = null;
  private statusIconEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private statusCounterEl: HTMLElement | null = null;
  private statusDetailEl: HTMLElement | null = null;
  private currentFileTextEl: HTMLElement | null = null;
  private currentByteProgressEl: HTMLElement | null = null;
  private statusDetailMode: SyncViewStatusDetailMode | null = null;
  private emptyFolderResolutionOpening = false;
  private sharedFolderIdentityResolutionOpening = false;
  private staleIdentityResolutionOpening = false;
  private scopeCrossingResolutionOpening = false;
  private mutationRecoveryResolutionOpening = false;
  private resolutionRowLocks = new Set<string>();
  private closed = false;

  constructor(leaf: WorkspaceLeaf, plugin: EasySyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SYNC_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.i18n.t("syncView.title");
  }

  getIcon(): string {
    return "refresh-cw";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    await this.plugin.ensureStateLoaded();
    if (this.closed) return;
    // The mobile chip pins above the (in-flow) buttons row: re-anchor it as
    // the list scrolls or the window resizes. Capture scroll on the window —
    // the drawer's scroller is a nested element, and scroll does not bubble.
    this.registerDomEvent(
      window,
      "scroll",
      () => this.scheduleTransferRateFooterPosition(),
      { capture: true, passive: true },
    );
    this.registerDomEvent(window, "resize", () =>
      this.scheduleTransferRateFooterPosition(),
    );
    // Live reading cadence: sample the run's cumulative transfer counters
    // once a second and refresh the indicator in place (a no-op write when
    // nothing changed). The sidebar drives the sampler — polling lives with
    // the only consumer, so main stays interval-free.
    this.registerInterval(
      window.setInterval(() => {
        this.plugin.pollTransferRateTick();
        this.refreshTransferRateValue();
      }, 1000),
    );
    this.contentEl.addEventListener(
      "toggle",
      this.handlePathLayoutToggle,
      true,
    );
    this.contentEl.addEventListener(
      "click",
      this.handlePlanRowToggleIntent,
      true,
    );
    window.addEventListener("resize", this.handlePathLayoutResize);
    this.contentEl.ownerDocument.addEventListener(
      "scroll",
      this.handlePlanViewportScroll,
      true,
    );
    if (typeof ResizeObserver !== "undefined") {
      this.pathLayoutObserver = new ResizeObserver((entries) => {
        this.scheduleTransferRateFooterPosition();
        const width = entries[0]?.contentRect.width ?? -1;
        if (Math.abs(width - this.pathLayoutObservedWidth) < 0.5) return;
        this.pathLayoutObservedWidth = width;
        this.scheduleAdaptivePathLayout();
        this.schedulePlanViewportRender();
      });
      this.pathLayoutObserver.observe(this.contentEl);
    }
    this.render();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    if (this.renderFrameId !== null) {
      compatCancelAnimationFrame(this.renderFrameId);
      this.renderFrameId = null;
    }
    if (this.planViewportFrameId !== null) {
      compatCancelAnimationFrame(this.planViewportFrameId);
      this.planViewportFrameId = null;
    }
    this.planVirtualRenderers.clear();
    this.collapseToggleButtonEl = null;
    this.pathLayoutObserver?.disconnect();
    this.pathLayoutObserver = null;
    for (const id of this.transferRateSettleTimeoutIds) window.clearTimeout(id);
    this.transferRateSettleTimeoutIds = [];
    this.contentEl.removeEventListener(
      "toggle",
      this.handlePathLayoutToggle,
      true,
    );
    this.contentEl.removeEventListener(
      "click",
      this.handlePlanRowToggleIntent,
      true,
    );
    window.removeEventListener("resize", this.handlePathLayoutResize);
    this.contentEl.ownerDocument.removeEventListener(
      "scroll",
      this.handlePlanViewportScroll,
      true,
    );
  }

  private readonly handlePathLayoutToggle = (): void => {
    this.scheduleAdaptivePathLayout();
    this.updateCollapseTogglePresentation();
  };

  /**
   * Record a decision row's open state from the user's own gesture instead of
   * the `toggle` event: `toggle` also fires for our programmatic writes
   * (`applyPlanRowExpansionIn`, `toggleAllDetails`), which would pin rows the
   * user never touched. Only a summary click can toggle a `<details>`, and our
   * own writes never produce one.
   */
  private readonly handlePlanRowToggleIntent = (event: Event): void => {
    const target = event.target as Node | null;
    if (!target || !target.instanceOf(HTMLElement)) return;
    const summary = target.closest("summary");
    const host = summary?.parentElement ?? null;
    if (!host || !host.instanceOf(HTMLDetailsElement)) return;
    const key = host.dataset.easySyncPlanRow;
    if (!key) return;
    this.rememberPlanRowExpansion(key, !host.open);
  };

  private readonly handlePathLayoutResize = (): void => {
    this.scheduleAdaptivePathLayout();
    this.schedulePlanViewportRender();
  };

  private readonly handlePlanViewportScroll = (): void => {
    this.schedulePlanViewportRender();
  };

  private schedulePlanViewportRender(): void {
    if (this.planViewportFrameId !== null) return;
    this.planViewportFrameId = compatRequestAnimationFrame(() => {
      this.planViewportFrameId = null;
      for (const renderWindow of this.planVirtualRenderers) renderWindow();
    });
  }

  /** Public entry point — merges multiple calls within the same animation frame. */
  render(): void {
    if (this.renderFrameId !== null) return;
    this.renderFrameId = compatRequestAnimationFrame(() => {
      this.renderFrameId = null;
      this.doRender();
    });
  }

  private doRender(): void {
    const container = this.contentEl;
    const progress = this.plugin.progressStore.state;
    const fullSyncRunning = this.plugin.syncExecutor?.isRunning ?? false;
    const canCancel = fullSyncRunning;
    const sideActionRunning = this.plugin.syncExecutor?.hasSideActionsInFlight ?? false;
    const isRunning = isAnySyncActivityRunning(
      progress,
      fullSyncRunning,
      sideActionRunning,
    );
    const syncState = this.plugin.state;
    const isInitializing = this.plugin.auth?.isInitializing ?? false;
    const authState = this.plugin.auth?.authState;
    const isLoggedIn = isInitializing ? false : (authState?.isLoggedIn ?? false);
    const isPending = !isInitializing
      && !isLoggedIn
      && (this.plugin.auth?.isPending ?? false);
    // Session restored but the account is not verified yet: sync authorization
    // is closed, so the panel must not read as a healthy "synced" state.
    const sessionPending = this.plugin.auth?.isSessionPending ?? false;
    const conflicts = (syncState?.pendingConflicts ?? [])
      .filter((item) => !this.plugin.syncExecutor?.isSideActionQueued(item.path));
    const pendingDeletes = (syncState?.pendingRemoteDeletes ?? [])
      .filter((item) => !this.plugin.syncExecutor?.isSideActionQueued(item.path));
    // Resolution rows (scope-crossing / stale identity / empty folder /
    // folder subtree / folder location / shared folder identity) settle
    // through the same side-action queue; hiding them as soon as their path
    // is queued gives them the same immediate-removal contract as ordinary
    // conflicts (continuous click-in).
    const pendingIssues = (syncState?.pendingIssues ?? [])
      .filter((item) => !this.plugin.syncExecutor?.isSideActionQueued(item.path));
    const pendingIssueGroups = groupPendingIssuesForReview(pendingIssues);
    const adoptionRows = this.plugin.getCommunityPluginAdoptionRows();
    const planReviewActive = syncState?.planReviewActive ?? false;
    const pendingCount = pendingIssueGroups.length + conflicts.length
      + pendingDeletes.length + adoptionRows.length;
    const sideActionResultsVisible = progress.activityKind === "sideAction"
      && (sideActionRunning || progress.completedFiles.length > 0);
    const mutationRecovery = this.plugin.getMutationRecoveryDisplayState();
    const updatePrompt = this.plugin.getUpdatePromptState();
    const bodyMode = resolveSyncViewBodyMode({
      planReviewActive,
      hasSyncState: Boolean(syncState),
      fullSyncRunning,
      pendingCount,
      sideActionResultsVisible,
      mutationRecoveryVisible: mutationRecovery !== null,
      remoteScopeRecoveryFailureVisible: Boolean(
        progress.recoveryVerification?.failureStage,
      ),
      updatePromptVisible: updatePrompt !== null,
    });
    const preservesContentScroll = this.renderedBodyMode === bodyMode
      && (bodyMode === "plan" || bodyMode === "recovery" || bodyMode === "idle");
    let preservedContentScrollTop = preservesContentScroll
      ? container.querySelector<HTMLElement>(".easy-sync-view-content")?.scrollTop ?? null
      : null;
    let preservedHostScrollTop = preservesContentScroll
      ? container.scrollTop
      : null;
    if (bodyMode === "plan" && syncState) {
      if (this.renderedPlanReviewRevision !== syncState.planReviewRevision) {
        // 会话级覆盖有意不在这里重置：用户点过「全部展开／折叠」之后，新计划
        // 里新出现的条目服从该覆盖（否则每轮新计划都把用户的明确选择抹掉）。
        this.planGroupExpandedState.clear();
        // Row identities belong to one plan revision: a path can change action
        // type between revisions, so carrying its open state over would restore
        // it on a row that no longer means the same thing.
        this.planRowExpandedState.clear();
        this.planRowHeights.clear();
        this.planRowLayoutRevision += 1;
        preservedContentScrollTop = null;
        preservedHostScrollTop = null;
        this.renderedPlanReviewRevision = syncState.planReviewRevision;
      }
    }
    this.renderedBodyMode = bodyMode;
    const planReviewCounts = syncState?.planReviewCounts ?? null;
    const planReviewItems = bodyMode === "plan"
      ? syncState?.planReviewItems ?? []
      : [];
    const planReviewDetailsMissing = bodyMode === "plan"
      && shouldAutoRebuildPlanReview(planReviewCounts, planReviewItems);
    if (
      planReviewDetailsMissing
      && syncState
      && this.autoRebuiltPlanReviewRevision !== syncState.planReviewRevision
      && !(this.plugin.syncExecutor?.isRunning ?? false)
    ) {
      this.recoverPlanReviewDetails(syncState.planReviewRevision);
    }
    const planReviewDetailsState = resolvePlanReviewDetailsState(
      planReviewDetailsMissing,
      this.planReviewDetailsRecoveryInFlight,
    );

    // Phase change or not running → full rebuild
    const statusState: StatusPanelState = {
      isLoggedIn,
      isInitializing,
      isPending,
      sessionPending,
      isRunning,
      canCancel,
      lastSyncTime: syncState?.lastSyncTime ?? 0,
      pendingCount,
      planReviewActive,
      planReviewRevision: syncState?.planReviewRevision ?? 0,
      planReviewDetailsState,
      autoSyncPaused: this.plugin.autoSyncPaused,
      mutationRecovery,
      latestHistory: syncState?.syncHistory[0],
      progress,
    };
    const contentKey = buildSyncViewContentKey(this.historyExpanded, {
      isLoggedIn,
      isInitializing,
      isPending,
      sessionPending,
      isRunning,
      canCancel,
      bodyMode,
      progress,
      planReviewActive,
      planReviewDetailsState,
      pendingIssues,
      pendingIssueGroups,
      conflicts,
      pendingDeletes,
      adoptionRows,
      planReviewCounts,
      planReviewRevision: syncState?.planReviewRevision ?? 0,
      history: syncState?.syncHistory ?? [],
      lastSyncTime: syncState?.lastSyncTime ?? 0,
      mutationRecovery,
    });

    if (this.lastContentKey !== contentKey) {
      this.planVirtualRenderers.clear();
      if (this.planViewportFrameId !== null) {
        compatCancelAnimationFrame(this.planViewportFrameId);
        this.planViewportFrameId = null;
      }
      this.progressPanelEl = null;
      this.progressFillEl = null;
      this.progressSubtitleEl = null;
      this.fileListEl = null;
      this.completedFileRowsLedger = null;
      this.statusLineEl = null;
      this.statusIconEl = null;
      this.statusTextEl = null;
      this.statusCounterEl = null;
      this.statusDetailEl = null;
      this.currentFileTextEl = null;
      this.currentByteProgressEl = null;
      this.statusDetailMode = null;
      this.collapseToggleButtonEl = null;
      container.empty();
      container.addClass("easy-sync-view");

      this.renderToolbar(container);
      this.renderStatusPanel(container, statusState);
      const content = container.createDiv("easy-sync-view-content");

      // While a round runs, a borrowed body (plan review / pending rows /
      // recovery) keeps its rows and their click-in contract, but the round
      // bar still holds its original body-top spot under the status divider.
      // The progress body paints the same bar itself (renderProgressPanel).
      const progressPanelShown = bodyMode === "progress"
        || (bodyMode === "pending" && sideActionResultsVisible);
      if (!progressPanelShown && isRunning) {
        const bar = content.createDiv("easy-sync-progress-bar");
        this.progressFillEl = bar.createDiv("easy-sync-progress-fill");
        this.progressFillEl.style.width = `${
          remoteScopeRecoveryPercent(progress)
          ?? syncViewProgressPercent(progress)
        }%`;
      }

      if (bodyMode === "plan" && syncState) {
        this.renderPlanReviewSection(
          content,
          planReviewCounts,
          planReviewItems,
          conflicts,
          pendingDeletes,
        );
      } else if (bodyMode === "progress") {
        this.renderProgressPanel(content, progress);
      } else if (bodyMode === "pending") {
        if (sideActionResultsVisible) this.renderProgressPanel(content, progress);
        this.renderPendingSection(
          content,
          pendingIssueGroups,
          conflicts,
          pendingDeletes,
          adoptionRows,
          updatePrompt,
        );
      } else if (bodyMode === "recovery" && mutationRecovery) {
        this.renderMutationRecoverySection(content, mutationRecovery);
      }

      if (this.historyExpanded) {
        this.renderHistorySection(content, syncState?.syncHistory ?? []);
      }

      this.renderTransferRateFooter(container);

      // Re-apply the toolbar state while retaining groups the user opened in
      // this exact reviewed revision.
      this.toggleAllDetails();
      // `toggleAllDetails` owns group and issue rows; a decision row inside a
      // plan group answers to its own remembered state instead.
      this.applyPlanRowExpansion();
      this.planRowHeights.clear();
      this.planRowLayoutRevision += 1;
      this.updateCollapseTogglePresentation();
      this.schedulePlanViewportRender();
      if (preservedContentScrollTop !== null) {
        content.scrollTop = preservedContentScrollTop;
      }
      if (preservedHostScrollTop !== null) {
        container.scrollTop = preservedHostScrollTop;
      }
    } else {
      // Same visible content — keep DOM, only patch the bits that changed.
      this.updateStatusPanel(statusState);
      if (isRunning) {
        if (this.progressFillEl) {
          const recoveryPercent = remoteScopeRecoveryPercent(progress);
          this.progressFillEl.style.width = `${
            recoveryPercent ?? syncViewProgressPercent(progress)
          }%`;
        }
        this.appendNewFileRows(progress.completedFiles);
      }
    }

    this.refreshTransferRateValue();
    this.lastContentKey = contentKey;
    this.scheduleAdaptivePathLayout();
  }

  /**
   * Apply the adaptive path extraction in the same task that updated the
   * rows. Deferring to a later animation frame makes the browser paint the
   * full-path rows first and re-paint the extracted rows one frame later — a
   * visible two-frame jump while many rows are refreshed quickly (deletion
   * sync or receiving files). Every call site runs after its DOM update, so
   * a synchronous apply still measures the real rendered width and never
   * shows an intermediate full-path state.
   */
  private scheduleAdaptivePathLayout(): void {
    this.applyAdaptivePathLayout();
  }

  private applyAdaptivePathLayout(): void {
    const scopes = Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(".easy-sync-path-layout"),
    );
    for (const scope of scopes) this.applyAdaptivePathLayoutScope(scope);
  }

  /**
   * Direct children only, deliberately: the windowed decision rows live one
   * level deeper (`.easy-sync-plan-virtual-window`) and must keep showing their
   * full path, because extracting a gray directory there drifts while the
   * window re-mounts during scrolling. Walking descendants instead of
   * `children` would silently reintroduce that drift.
   */
  private applyAdaptivePathLayoutScope(scope: HTMLElement): void {
    for (const child of Array.from(scope.children)) {
      if (child.classList.contains("easy-sync-path-directory")) child.remove();
    }

    type DomPathItem = {
      root: HTMLElement;
      pathEl: HTMLElement;
      path: string;
      pathLeft: number;
    };
    const sequences: DomPathItem[][] = [];
    let sequence: DomPathItem[] = [];
    const flush = (): void => {
      if (sequence.length > 0) sequences.push(sequence);
      sequence = [];
    };

    for (const child of Array.from(scope.children)) {
      if (!(child.instanceOf(HTMLElement))
        || !child.classList.contains("easy-sync-path-layout-item")) {
        flush();
        continue;
      }
      const pathEl = child.querySelector<HTMLElement>(
        ".easy-sync-adaptive-path",
      );
      const path = pathEl?.dataset.easySyncFullPath;
      if (!pathEl || !path) {
        flush();
        continue;
      }
      pathEl.setText(path);
      const pathLeft = pathEl.getBoundingClientRect().left;
      if (
        sequence.length > 0
        && Math.abs(sequence[0].pathLeft - pathLeft) > 1
      ) {
        flush();
      }
      sequence.push({ root: child, pathEl, path, pathLeft });
    }
    flush();

    for (const items of sequences) {
      const decisions = buildAdaptivePathLayout(items.map((item) => ({
        path: item.path,
        availableWidth: item.pathEl.clientWidth,
        measureTextWidth: (text: string) => {
          const previousText = item.pathEl.textContent ?? "";
          item.pathEl.setText(text);
          const width = item.pathEl.scrollWidth;
          item.pathEl.setText(previousText);
          return width;
        },
      })));
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const decision = decisions[index];
        item.pathEl.setText(decision.displayPath);
        if (!decision.directory) continue;
        const directory = scope.createDiv("easy-sync-path-directory");
        directory.setText(decision.directory);
        directory.setAttribute("aria-hidden", "true");
        item.root.before(directory);
        const indent = Math.max(
          0,
          item.pathEl.getBoundingClientRect().left
            - directory.getBoundingClientRect().left,
        );
        directory.style.setProperty(
          "--easy-sync-path-directory-indent",
          `${indent}px`,
        );
        directory.setText(fitDirectoryTail(
          decision.directory,
          directory.clientWidth,
          (text) => {
            directory.setText(text);
            return directory.scrollWidth;
          },
        ));
      }
    }
  }

  private appendNewFileRows(files: readonly FileProgress[]): void {
    if (files.length === 0 || !this.progressPanelEl) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (!this.progressSubtitleEl) {
      this.progressSubtitleEl = this.progressPanelEl.createDiv("easy-sync-progress-subtitle");
      this.progressSubtitleEl.setText(
        t("syncView.progress.completed", {
          count: this.plugin.progressStore.state.completedCount,
        }),
      );
    }
    if (!this.fileListEl || !this.completedFileRowsLedger) {
      // Fallback: no rendered list (or a stale ledger) to diff against.
      this.fileListEl?.remove();
      this.fileListEl = null;
      this.renderFileResults(this.progressPanelEl, [...files], true);
    } else {
      const diff = diffCompletedFileRows(this.completedFileRowsLedger, files);
      this.completedFileRowsLedger = diff.nextLedger;
      if (diff.removePaths.length > 0) {
        const removeSet = new Set(diff.removePaths);
        for (const row of Array.from(this.fileListEl.children)) {
          if (!row.instanceOf(HTMLElement)) continue;
          const path = row.dataset.easySyncCompletedPath;
          if (path && removeSet.has(path)) row.remove();
        }
      }
      // `prepend` is newest first: inserting bottom-up leaves the newest row
      // on top, matching the full-rebuild order.
      for (let i = diff.prepend.length - 1; i >= 0; i--) {
        const row = renderFileRow(diff.prepend[i], this.fileListEl, t, true);
        this.fileListEl.prepend(row);
      }
    }
    this.progressSubtitleEl?.setText(
      t("syncView.progress.completed", {
        count: this.plugin.progressStore.state.completedCount,
      }),
    );
  }

  private renderToolbar(container: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const toolbar = container.createDiv("nav-header");
    const buttons = toolbar.createDiv("nav-buttons-container");

    this.createIconButton(buttons, "history", t("syncView.history.title"), () => {
      this.historyExpanded = !this.historyExpanded;
      this.render();
    }, this.historyExpanded);
    this.createIconButton(buttons, "settings", t("syncView.openSettings"), () => {
      this.plugin.openPluginSettings();
    });
    // 管理入口浅化（切片 4）：范围管理弹框直达，保持设置页现状。
    this.createIconButton(
      buttons,
      "sliders-horizontal",
      t("syncView.openScopeManage"),
      () => {
        new ConfigSyncModal(this.plugin).open();
      },
    );

    this.renderCollapseToggle(buttons);
  }

  /** Passive connection-speed reading. Mobile: a compact fixed chip pinned
   *  (via JS-measured viewport offset) just above the host bottom action
   *  bar; desktop: a panel-footer band at the bottom right. Both carriers
   *  share the same rendering, level classes and color treatment — only
   *  positioning differs. */
  private renderTransferRateFooter(container: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const reading = this.plugin.getTransferRateReading();
    if (!reading) return;
    const indicator = container.createDiv("easy-sync-transfer-rate");
    if (Platform.isMobile) {
      indicator.addClass("is-mobile-footer");
    } else {
      indicator.addClass("is-panel-footer");
    }
    indicator.addClass(`is-${reading.level}`);
    this.fillTransferRateIndicator(indicator, reading);
    setTooltip(indicator, t("syncView.transferRate.title"));
    if (Platform.isMobile) {
      // Invisible until the first valid anchor lands (visibility, not
      // display, so the chip's height stays measurable): without this the
      // chip flashes at its CSS fallback position — the "drift to the top
      // right, then snap down" the user saw when opening the drawer
      // instantly, before the buttons row reached its final place.
      indicator.addClass("is-anchor-pending");
      this.positionTransferRateFooter(indicator);
      this.scheduleTransferRateAnchorSettle();
    }
  }

  /** Pin the mobile chip directly above the buttons row, wherever the host
   *  currently places that row (bottom action bar on narrow phones, top of
   *  the drawer in wide layouts): measure the row's live position and set
   *  the chip's leaf-relative `top` from it. Layout-agnostic by
   *  construction — no per-layout CSS guessing. */
  private positionTransferRateFooter(indicator: HTMLElement): void {
    const buttons = this.contentEl.querySelector<HTMLElement>(
      ".nav-buttons-container",
    );
    if (!buttons) return; // nothing to measure yet — stay anchor-pending
    const buttonsRect = buttons.getBoundingClientRect();
    const containerRect = this.contentEl.getBoundingClientRect();
    // The first successful measurement clears the pending-invisible state;
    // from here on only a genuinely off-screen row hides the chip.
    indicator.removeClass("is-anchor-pending");
    const offScreen =
      buttonsRect.bottom < containerRect.top
      || buttonsRect.top > containerRect.bottom;
    indicator.toggleClass("is-hidden", offScreen);
    if (offScreen) return;
    indicator.style.setProperty(
      "--transfer-rate-top",
      `${Math.max(
        0,
        Math.round(buttonsRect.top - containerRect.top - indicator.offsetHeight - 4),
      )}px`,
    );
  }

  private transferRatePositionFrameId: number | null = null;

  private scheduleTransferRateFooterPosition(): void {
    if (this.transferRatePositionFrameId !== null) return;
    this.transferRatePositionFrameId = compatRequestAnimationFrame(() => {
      this.transferRatePositionFrameId = null;
      const indicator = this.contentEl.querySelector<HTMLElement>(
        ".easy-sync-transfer-rate",
      );
      if (indicator) this.positionTransferRateFooter(indicator);
    });
  }

  private transferRateSettleTimeoutIds: number[] = [];

  /** Drawer-open animations (and the host relocating the buttons row between
   *  narrow/wide layouts) keep moving the anchor after the first
   *  measurement: re-measure on a short bounded schedule so the chip lands
   *  together with the drawer instead of trailing it. */
  private scheduleTransferRateAnchorSettle(): void {
    for (const delay of [80, 200, 450]) {
      this.transferRateSettleTimeoutIds.push(
        window.setTimeout(() => this.scheduleTransferRateFooterPosition(), delay),
      );
    }
  }

  private fillTransferRateIndicator(
    indicator: HTMLElement,
    reading: TransferRateReading,
  ): void {
    const iconEl = indicator.createSpan("easy-sync-transfer-rate-icon");
    // Lucide ladder: full bars read as "excellent"; signal-zero means the
    // link moved no bytes at all during attempted transfers.
    setIcon(iconEl, reading.level === "high" ? "signal" : `signal-${reading.level}`);
    if (reading.kbps !== null) {
      indicator.createSpan("easy-sync-transfer-rate-value")
        .setText(formatTransferRate(reading.kbps));
    }
  }

  /** Per-second cadence and settled-run paths update the existing indicator
   *  in place — a remove-and-rerender would flash the mobile chip and force
   *  a pointless re-anchor. Renders only when no indicator exists yet. */
  private refreshTransferRateValue(): void {
    const reading = this.plugin.getTransferRateReading();
    const indicator = this.contentEl.querySelector<HTMLElement>(
      ".easy-sync-transfer-rate",
    );
    if (!reading) {
      indicator?.remove();
      return;
    }
    if (!indicator) {
      this.renderTransferRateFooter(this.contentEl);
      return;
    }
    for (const level of ["high", "medium", "low", "zero"] as const) {
      indicator.toggleClass(`is-${level}`, reading.level === level);
    }
    const iconEl = indicator.querySelector<HTMLElement>(
      ".easy-sync-transfer-rate-icon",
    );
    if (iconEl) {
      setIcon(iconEl, reading.level === "high" ? "signal" : `signal-${reading.level}`);
    }
    const text = reading.kbps !== null ? formatTransferRate(reading.kbps) : null;
    const valueEl = indicator.querySelector<HTMLElement>(
      ".easy-sync-transfer-rate-value",
    );
    if (valueEl && text !== null) {
      if (valueEl.textContent !== text) valueEl.setText(text);
    } else if (valueEl) {
      valueEl.remove();
    } else if (text !== null) {
      indicator.createSpan("easy-sync-transfer-rate-value").setText(text);
    }
  }

  private renderCollapseToggle(container: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const shouldExpand = this.shouldExpandAllDetails();
    const icon = shouldExpand ? "chevrons-up-down" : "chevrons-down-up";
    const label = shouldExpand ? t("syncView.expandAll") : t("syncView.collapseAll");

    this.collapseToggleButtonEl = this.createIconButton(container, icon, label, () => {
      const expand = this.shouldExpandAllDetails();
      // 一次用户动作同时覆盖计划面与待处理面：两处共用同一份会话级覆盖，
      // 新出现的可展开项（含下一轮新计划）都服从它。
      this.sessionOverride = expand ? "expanded" : "collapsed";
      this.planGroupExpandedState.clear();
      this.toggleAllDetails();
      this.updateCollapseTogglePresentation();
    });
  }

  private isSessionCollapsed(): boolean {
    return this.sessionOverride === "collapsed";
  }

  private shouldExpandAllDetails(): boolean {
    const details = [
      ...this.contentEl.querySelectorAll<HTMLDetailsElement>(
        ".easy-sync-tree-item",
      ),
    ];
    // 还没有可展开项可读时按会话覆盖回答：默认态与折叠态下「全部展开」才是
    // 用户的下一步动作，只有显式展开过才轮到「全部折叠」。
    if (details.length === 0) return this.sessionOverride !== "expanded";
    return shouldExpandAllVisibleDetails(details.map((detail) => detail.open));
  }

  private updateCollapseTogglePresentation(): void {
    const button = this.collapseToggleButtonEl;
    if (!button) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const shouldExpand = this.shouldExpandAllDetails();
    const icon = shouldExpand ? "chevrons-up-down" : "chevrons-down-up";
    const label = shouldExpand ? t("syncView.expandAll") : t("syncView.collapseAll");
    setIcon(button, icon);
    setTooltip(button, label);
    button.ariaLabel = label;
  }

  private toggleAllDetails(): void {
    // 默认态下不在这里铺开或收起任何东西：每个区域按自己的类别默认渲染
    // （含决策项的分组与决策行展开、只读项折叠）。只有用户显式点过工具栏
    // 之后，才由这一份会话级覆盖统一压过类别默认。
    if (this.sessionOverride === "default") return;
    const details = this.contentEl.querySelectorAll<HTMLDetailsElement>(".easy-sync-tree-item");
    if (this.isSessionCollapsed()) {
      const expandedPlanGroups = new Set(
        [...this.planGroupExpandedState]
          .filter(([, open]) => open)
          .map(([group]) => group),
      );
      for (const d of details) d.removeAttribute("open");
      if (this.renderedBodyMode === "plan") {
        for (const d of details) {
          const group = d.dataset.easySyncPlanGroup as SyncActionGroup | undefined;
          if (group && expandedPlanGroups.has(group)) d.setAttribute("open", "");
        }
      }
    } else {
      for (const d of details) d.setAttribute("open", "");
    }
    // 程序化批量开合改变了每行的真实高度，但窗口化列表的高度模型不知道：
    // 行内量高缓存与偏移估算仍按旧的开合态记账，挂载窗口会按旧容器高度
    // 原地长高溢出，把更新提示行与历史区盖在下面。行级手势走
    // rememberPlanRowExpansion，正文重建路径结尾也有同一组收尾；这里补齐
    // 第三个程序化写入口，三个入口对齐同一新鲜度规则。
    this.planRowHeights.clear();
    this.planRowLayoutRevision += 1;
    this.schedulePlanViewportRender();
  }

  private createIconButton(
    container: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    pressed?: boolean,
  ): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "clickable-icon nav-action-button",
      attr: { "aria-label": label, type: "button" },
    });
    if (pressed !== undefined) {
      button.setAttr("aria-pressed", String(pressed));
      button.toggleClass("is-active", pressed);
    }
    setIcon(button, icon);
    setTooltip(button, label);
    button.addEventListener("click", onClick);
    return button;
  }

  private renderStatusPanel(
    container: HTMLElement,
    state: StatusPanelState,
  ): void {
    const panel = container.createDiv("easy-sync-status-panel");
    this.statusLineEl = panel.createDiv("easy-sync-status-line");
    this.statusIconEl = this.statusLineEl.createSpan("easy-sync-status-icon");
    this.statusTextEl = this.statusLineEl.createSpan("easy-sync-status-text");
    this.statusDetailEl = panel.createDiv("easy-sync-status-detail");
    this.updateStatusPanel(state);

    const actions = panel.createDiv("easy-sync-primary-actions");
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const recoveryActionKey = state.mutationRecovery
      ? mutationRecoveryPrimaryActionKey(state.mutationRecovery)
      : null;
    const action = resolveSyncViewPrimaryAction({
      isLoggedIn: state.isLoggedIn,
      isRunning: state.isRunning,
      canCancel: state.canCancel,
      planReviewActive: state.planReviewActive,
      planReviewDetailsState: state.planReviewDetailsState,
      reviewKind: this.plugin.state?.planReviewAuthorization?.reviewKind,
      recoveryActionKey,
      isInitializing: state.isInitializing,
      isPending: state.isPending,
      devicePending: (this.plugin.auth?.deviceAttempt ?? null) !== null,
    });
    switch (action.kind) {
      case "cancel": {
        const cancelButton = new ButtonComponent(actions)
          .setButtonText(t("syncView.cancelSync"));
        cancelButton.buttonEl.classList.add("mod-warning");
        cancelButton.onClick(() => {
          void this.plugin.cancelSync();
        });
        break;
      }
      case "processing": {
        new ButtonComponent(actions)
          .setButtonText(t("syncView.conflict.processing"))
          .setDisabled(true);
        break;
      }
      case "plan-review-restore": {
        const recovering = action.recovering;
        const detailsButton = new ButtonComponent(actions)
          .setButtonText(t(
            recovering
              ? "syncPlan.restoringDetails"
              : "syncPlan.restoreDetails",
          ))
          .setCta()
          .setDisabled(recovering);
        if (!recovering) {
          detailsButton.onClick(() => {
            this.recoverPlanReviewDetails(
              state.planReviewRevision,
              true,
            );
          });
        }
        break;
      }
      case "plan-review-confirm": {
        new ButtonComponent(actions)
          .setButtonText(t(
            action.migration
              ? "syncPlan.confirmMigration"
              : "syncPlan.confirmExecute",
          ))
          .setCta()
          .onClick(() => {
            void this.plugin.executePlanReview(state.planReviewRevision);
          });
        break;
      }
      case "recovery": {
        // Only real recovery decisions keep a primary action: keep-side
        // review and scope-recovery retry. Other recovery states render
        // honest status without a choice button (no fake "check again").
        const actionKey = action.actionKey;
        new ButtonComponent(actions)
          .setButtonText(t(actionKey))
          .setCta()
          .setDisabled(state.isInitializing)
          .onClick(() => {
            if (actionKey === "syncView.recovery.reviewDetails") {
              void this.openMutationRecoveryResolution();
              return;
            }
            // retryScopeRecovery: a manual round re-runs remote scope recovery.
            void this.plugin.startManualSync();
          });
        break;
      }
      case "sync-now": {
        // Logged in without a durable plan review or a real recovery decision
        // (e.g. waiting-network/checking recovery with no action): keep the
        // fixed top primary button a working "sync now" button — never swap it
        // for a dead "login" button (review 2026-09-02 finding ⑧, C9 P1).
        new ButtonComponent(actions)
          .setButtonText(t("command.syncNow"))
          .setCta()
          .setDisabled(state.isInitializing)
          .onClick(() => {
            void this.plugin.startManualSync();
          });
        break;
      }
      case "auth": {
        const button = new ButtonComponent(actions)
          .setButtonText(t(action.labelKey));
        if (action.cta) button.setCta();
        if (action.disabled) {
          button.setDisabled(true);
        } else {
          button.onClick(() => {
            void handleAuthEntryAction(this.plugin);
          });
        }
        break;
      }
      default: {
        // Exhaustiveness guard: adding a kind to the union without a render
        // branch here is a compile error instead of a silently missing button.
        const neverKind: never = action;
        void neverKind;
        break;
      }
    }
  }

  private recoverPlanReviewDetails(revision: number, force = false): void {
    const state = this.plugin.state;
    if (
      this.closed
      || this.planReviewDetailsRecoveryInFlight
      || (!force && this.autoRebuiltPlanReviewRevision === revision)
      || !state
      || state.planReviewRevision !== revision
      || !shouldAutoRebuildPlanReview(
        state.planReviewCounts ?? null,
        state.planReviewItems ?? [],
      )
    ) return;
    this.autoRebuiltPlanReviewRevision = revision;
    this.planReviewDetailsRecoveryInFlight = true;
    this.render();
    void this.plugin.rebuildPlanReview()
      .catch((error: unknown) => {
        this.plugin.diag.warn("plan", "plan review detail recovery failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.planReviewDetailsRecoveryInFlight = false;
        if (!this.closed) this.render();
      });
  }

  private updateStatusPanel(state: StatusPanelState): void {
    const presentation = this.getStatusPresentation(state);
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);

    if (this.statusLineEl) {
      this.statusLineEl.removeClass("is-loggedOut", "is-cancelling", "is-syncing", "is-attention", "is-offline", "is-success", "is-ready");
      this.statusLineEl.addClass(`is-${presentation.status}`);
    }
    if (this.statusIconEl) {
      setIcon(this.statusIconEl, RIBBON_STATUS_ICONS[presentation.status]);
    }
    this.statusTextEl?.setText(presentation.label);

    const recoveryProgress = state.progress.recoveryVerification;
    const progressCurrent = recoveryProgress
      ? recoveryProgress.reused + recoveryProgress.verifiedThisRun
      : state.progress.current;
    const progressTotal = recoveryProgress?.total ?? state.progress.total;
    if (state.isRunning && progressTotal > 0) {
      if (!this.statusCounterEl) {
        const statusLine = this.contentEl.querySelector(".easy-sync-status-line");
        if (statusLine instanceof HTMLElement) {
          this.statusCounterEl = statusLine.createSpan("easy-sync-status-counter");
        }
      }
      this.statusCounterEl?.setText(
        t("syncView.progress.items", {
          current: progressCurrent,
          total: progressTotal,
        }),
      );
    } else if (state.mutationRecovery && state.mutationRecovery.remaining > 0) {
      if (!this.statusCounterEl) {
        const statusLine = this.contentEl.querySelector(".easy-sync-status-line");
        if (statusLine instanceof HTMLElement) {
          this.statusCounterEl = statusLine.createSpan("easy-sync-status-counter");
        }
      }
      this.statusCounterEl?.setText(String(state.mutationRecovery.remaining));
    } else if (this.statusCounterEl) {
      this.statusCounterEl.remove();
      this.statusCounterEl = null;
    }

    if (!this.statusDetailEl) return;
    const detailMode = resolveSyncViewStatusDetailMode({
      isRunning: state.isRunning,
      activityKind: state.progress.activityKind,
      mutationRecoveryVisible: state.mutationRecovery !== null,
    });
    if (detailMode === "recovery") {
      if (this.statusDetailMode !== "recovery") {
        this.statusDetailEl.empty();
        this.statusDetailEl.removeClass("is-current-file");
        this.statusDetailEl.addClass("is-empty");
        this.currentFileTextEl = null;
        this.currentByteProgressEl = null;
        this.statusDetailMode = "recovery";
      }
      return;
    }
    this.statusDetailEl.removeClass("is-empty");
    if (detailMode === "current-file") {
      if (this.statusDetailMode !== "current-file" || !this.currentFileTextEl) {
        this.statusDetailEl.empty();
        this.statusDetailEl.addClass("is-current-file");
        this.currentFileTextEl = this.statusDetailEl.createSpan("easy-sync-status-current-file");
        this.currentByteProgressEl = null;
        this.statusDetailMode = "current-file";
      }
      this.currentFileTextEl.setText(state.progress.currentFile);
      this.updateByteProgress(state.progress);
      return;
    }

    if (this.statusDetailMode !== "timestamp") {
      this.statusDetailEl.empty();
      this.statusDetailEl.removeClass("is-current-file");
      this.currentFileTextEl = null;
      this.currentByteProgressEl = null;
      this.statusDetailMode = "timestamp";
    }
    const timestamp = state.autoSyncPaused && state.latestHistory
      ? state.latestHistory.endedAt
      : state.lastSyncTime;
    const detailText = timestamp > 0
      ? new Date(timestamp).toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
      : "";
    if (this.statusDetailEl.textContent !== detailText) {
      this.statusDetailEl.setText(detailText);
    }
  }

  private updateByteProgress(progress: Readonly<SyncProgressState>): void {
    if (progress.currentItemTotalBytes > 0) {
      if (!this.currentByteProgressEl && this.statusDetailEl) {
        this.currentByteProgressEl = this.statusDetailEl.createSpan("easy-sync-status-byte-progress");
      }
      this.currentByteProgressEl?.setText(
        formatByteProgress(progress.currentItemBytes, progress.currentItemTotalBytes),
      );
      return;
    }
    if (this.currentByteProgressEl) {
      this.currentByteProgressEl.remove();
      this.currentByteProgressEl = null;
    }
  }

  private getStatusPresentation(state: {
    isLoggedIn: boolean;
    isInitializing: boolean;
    isPending: boolean;
    sessionPending: boolean;
    isRunning: boolean;
    lastSyncTime: number;
    pendingCount: number;
    planReviewActive: boolean;
    autoSyncPaused: boolean;
    mutationRecovery: MutationRecoveryDisplayState | null;
    latestHistory?: SyncHistoryEntry;
    progress: Readonly<SyncProgressState>;
  }): { status: RibbonStatus; label: string } {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    // Cold start, and a restored session whose account is not verified yet,
    // share the same "connecting" presentation — never a ready/synced claim.
    if (state.isInitializing || state.sessionPending) {
      return { status: "ready", label: t("settings.account.desc.connecting") };
    }
    if (!state.isLoggedIn && state.isPending) {
      return { status: "loggedOut", label: t("syncView.status.awaitingLogin") };
    }

    const status = resolveRibbonStatus({
      loggedIn: state.isLoggedIn,
      cancelling: state.progress.cancelRequested,
      syncing: state.isRunning,
      needsAttention: state.pendingCount > 0
        || state.planReviewActive
        || state.autoSyncPaused
        || state.mutationRecovery !== null,
      recentSuccess: state.lastSyncTime > 0,
    });
    // The latest round may be a retry-pending observation (a remote read
    // failed before ordinary planning). That overrides the stale "synced"
    // green from the last healthy round: never imply the vault is currently
    // in sync. While the system reports the device has a network, the only
    // known fact is "the cloud was not readable" — share the neutral
    // connecting form with cold start / session-pending; keep the offline
    // presentation only for a system-reported device-level offline. The next
    // healthy round returns to success.
    if (
      status === "success"
      && state.latestHistory?.status === "retry-pending"
    ) {
      if (navigator.onLine === false) {
        return { status: "offline", label: t("syncView.status.offline") };
      }
      return { status: "ready", label: t("status.connecting") };
    }
    switch (status) {
      case "cancelling":
        return { status, label: t("syncView.cancelling") };
      case "syncing":
        if (state.progress.phase !== "executing") {
          // Stage-level short status (scanning / preparing / baseline /
          // checking / planning / verifying). Exact per-action labels stay
          // out of the fixed top (S4 boundary): executing falls through to
          // the generic running status below.
          return {
            status,
            label: translateSyncActivity(
              resolveSyncActivityPresentation(state.progress),
              t,
            ),
          };
        }
        return { status, label: t("syncView.progress") };
      case "attention":
        if (state.pendingCount > 0) {
          return { status, label: t("syncView.issues.title", { count: state.pendingCount }) };
        }
        if (state.planReviewActive) {
          return { status, label: t("syncPlan.sectionTitle") };
        }
        if (state.mutationRecovery) {
          return {
            status,
            label: mutationRecoveryTopStatusLabel(state.mutationRecovery, t),
          };
        }
        if (state.latestHistory && state.latestHistory.status !== "success") {
          return {
            status,
            label: t(`syncView.history.status.${state.latestHistory.status}`),
          };
        }
        return { status, label: t("syncView.history.status.partial") };
      case "success":
        return { status, label: t("syncView.status.synced") };
      case "loggedOut":
        return { status, label: t("settings.account.desc.notLoggedIn") };
      default:
        return { status, label: t("syncView.never") };
    }
  }

  private renderProgressPanel(
    container: HTMLElement,
    state: Readonly<SyncProgressState>,
  ): void {
    if (
      state.total <= 0
      && state.completedFiles.length === 0
      && !state.recoveryVerification
    ) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const panel = container.createDiv("easy-sync-progress-panel");
    this.progressPanelEl = panel;
    const recoveryPercent = remoteScopeRecoveryPercent(state);
    if (state.total > 0 || recoveryPercent !== null) {
      const bar = panel.createDiv("easy-sync-progress-bar");
      this.progressFillEl = bar.createDiv("easy-sync-progress-fill");
      this.progressFillEl.style.width = `${
        recoveryPercent ?? syncViewProgressPercent(state)
      }%`;
    }
    if (state.completedFiles.length > 0) {
      this.progressSubtitleEl = panel.createDiv("easy-sync-progress-subtitle");
      this.progressSubtitleEl.setText(
        t("syncView.progress.completed", { count: state.completedCount }),
      );
      this.renderFileResults(panel, state.completedFiles, true);
    }
    this.renderRemoteScopeRecoveryFailure(panel, state.recoveryVerification);
  }

  private renderRemoteScopeRecoveryFailure(
    container: HTMLElement,
    recovery: Readonly<RemoteScopeRecoveryVerificationProgress> | undefined,
  ): void {
    if (!recovery) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const presentation = resolveRemoteScopeRecoveryFailurePresentation(recovery, t);
    if (!presentation) return;
    const section = this.createSection(container, presentation.title);
    section.createDiv("easy-sync-recovery-summary").setText(presentation.summary);
    if (presentation.path) {
      const facts = section.createEl("dl", "easy-sync-recovery-facts");
      facts.createEl("dt").setText(t("syncView.recovery.field.path"));
      const path = facts.createEl("dd", "easy-sync-recovery-path");
      configureFilePath(facts, path, presentation.path, false);
    }
    section.createDiv("easy-sync-recovery-next-step").setText(
      presentation.nextStep,
    );
  }

  private renderMutationRecoverySection(
    container: HTMLElement,
    state: Readonly<MutationRecoveryDisplayState>,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const presentation = mutationRecoveryBodyPresentation(
      state,
      t,
      (timestamp) => new Date(timestamp).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    const section = this.createSection(
      container,
      t("syncView.recovery.sectionTitle"),
    );
    section.createDiv("easy-sync-recovery-summary").setText(
      presentation.summary,
    );
    if (
      state.kind === "blocked"
      && presentation.path
      && presentation.reason
    ) {
      // The decision hinges on which operation is stuck and why; keep it to
      // one compact line instead of a stacked field list.
      const subject = section.createDiv("easy-sync-recovery-subject");
      subject.createSpan("easy-sync-recovery-path").setText(
        presentation.path,
      );
      subject.createSpan().setText(` · ${presentation.reason}`);
    }
    if (
      state.kind !== "blocked"
      && (presentation.path || presentation.reason || presentation.retryAt)
    ) {
      const facts = section.createEl("dl", "easy-sync-recovery-facts");
      if (presentation.path) {
        facts.createEl("dt").setText(t("syncView.recovery.field.path"));
        const path = facts.createEl("dd", "easy-sync-recovery-path");
        configureFilePath(facts, path, presentation.path, false);
      }
      if (presentation.reason) {
        facts.createEl("dt").setText(t("syncView.recovery.field.reason"));
        facts.createEl("dd").setText(presentation.reason);
      }
      if (presentation.retryAt) {
        facts.createEl("dt").setText(t("syncView.recovery.field.retryAt"));
        facts.createEl("dd").setText(presentation.retryAt);
      }
    }
    // Honest next-step line for states with a real decision or an active
    // exit (review / blocked / account-changed). Automatic states
    // (checking / waiting-network) render none: their summaries already state
    // the auto-continue outcome, so the line would only repeat it
    // (2026-09-15 copy-reduction round R-4). The abandon escape hatch was
    // removed; the single last-resort exit lives on the reset flow (informed
    // forced reset).
    if (presentation.nextStep) {
      section.createDiv("easy-sync-recovery-next-step").setText(
        presentation.nextStep,
      );
    }
  }

  /** 流内窗口壳（方案单 20260924-0001）：上占位、流内窗口、下占位。窗口
   *  参与文档流，行内容只会把下占位连同下方区域一起推开——溢出叠压在构
   *  造上不可能；估算误差降级为滚动长度短暂不准，由量实高收敛机制自纠。
   *  空窗口返回 null，但上下占位照常挂载，滚动长度不塌。 */
  private mountPlanFlowWindow(
    virtualList: HTMLElement,
    windowState: { start: number; end: number; offset: number },
    offsets: readonly number[],
  ): HTMLElement | null {
    const totalHeight = offsets[offsets.length - 1] ?? 0;
    const endOffset = offsets[windowState.end] ?? totalHeight;
    const topSpacer = virtualList.createDiv("easy-sync-plan-virtual-spacer");
    topSpacer.style.height = `${Math.max(0, windowState.offset)}px`;
    const visible = windowState.end <= windowState.start
      ? null
      : virtualList.createDiv("easy-sync-plan-virtual-window");
    const bottomSpacer = virtualList.createDiv("easy-sync-plan-virtual-spacer");
    bottomSpacer.style.height = `${Math.max(0, totalHeight - endOffset)}px`;
    return visible;
  }

  private renderPendingSection(
    container: HTMLElement,
    issueGroups: readonly PendingIssueReviewGroup[],
    conflicts: SyncPlanItem[],
    pendingDeletes: SyncPlanItem[],
    adoptionRows: readonly CommunityPluginAdoptionRow[],
    updatePrompt: { latest: string; current: string } | null,
  ): void {
    const section = container
      .createDiv("easy-sync-section")
      .createDiv("easy-sync-section-body");
    section.addClass("easy-sync-path-layout");
    const skipped = issueGroups.filter(({ issue }) =>
      issue.actionType === SyncActionType.SkipLargeFile
      || issue.actionType === SyncActionType.SkipIgnoredPath
      || issue.actionType === SyncActionType.SkipOneDriveInvalidName);
    const failures = issueGroups.filter(({ issue }) =>
      issue.actionType !== SyncActionType.SkipLargeFile
      && issue.actionType !== SyncActionType.SkipIgnoredPath
      && issue.actionType !== SyncActionType.SkipOneDriveInvalidName);
    const rows = buildSyncPendingDisplayRows({
      adoptionRows,
      failures,
      conflictEntries: groupBundleConflictReviews(
        conflicts,
        getConfigDir(this.plugin.app.vault),
      ),
      pendingDeletes,
      skipped,
    });
    // 窗口化挂载（2026-09-16，与计划审阅决策行同一机制）：待处理行数大时
    // 只挂载视口附近的行，滚动按窗口替换。行 key（data-easy-sync-plan-row）
    // 与计划决策行同族——展开记忆、在飞 pin、换窗回填顺序全部沿用；计数
    // 与顶部合计仍来自全量事实，窗口化只改变挂载范围。
    const virtualList = section.createDiv("easy-sync-plan-virtual-list");
    let virtualOffsets: number[] | null = null;
    let offsetsRevision = -1;
    let renderedKey = "";
    let renderDepth = 0;
    // 成批的待确认删除（≥2 条，与批量删除入口同一条件）逐条默认收起。
    const deleteRowsBatched = isBatchedDeleteSet(rows.map((row) => row.key));
    this.renderedDeleteRowsBatched = deleteRowsBatched;

    const resolveOffsets = (): number[] => {
      if (virtualOffsets && offsetsRevision === this.planRowLayoutRevision) {
        return virtualOffsets;
      }
      const probe = this.measurePlanDecisionRowHeights(section);
      virtualOffsets = buildSyncPlanMeasuredVirtualOffsets(
        rows.map((row) =>
          this.planRowHeights.get(row.key)
          ?? (this.resolvePlanRowOpen(row.key, deleteRowsBatched)
            ? probe.expandedRowHeight
            : probe.collapsedRowHeight)),
      );
      offsetsRevision = this.planRowLayoutRevision;
      return virtualOffsets;
    };

    const renderPendingWindow = (): void => {
      // A row whose decision is still settling has to stay mounted: the user
      // is waiting on that exact row, and a window shift would take it away.
      if (rows.some((row) => this.planDecisionRowsInFlight.has(row.key))) {
        return;
      }
      const offsets = resolveOffsets();
      const listRect = virtualList.getBoundingClientRect();
      const viewportRect = this.resolvePlanViewportRect();
      const windowState = buildSyncPlanVirtualWindow({
        offsets,
        listTop: listRect.top,
        viewportTop: viewportRect.top,
        viewportBottom: viewportRect.bottom,
      });
      const nextKey =
        `${windowState.start}:${windowState.end}:${windowState.offset}`;
      // 行高缓存被清空后，占位与槽位会退回探针估算；窗口键未变时早退会
      // 把这套估算冻结住（流内窗口下表现为滚动长度与行位不准）。键未变
      // 也要重挂量一次实高——本窗口每行都有实测高度后才允许提前返回。
      const mountedMeasured = rows
        .slice(windowState.start, windowState.end)
        .every((row) => this.planRowHeights.has(row.key));
      if (nextKey === renderedKey && mountedMeasured) return;
      renderedKey = nextKey;
      virtualList.empty();
      const visible = this.mountPlanFlowWindow(
        virtualList,
        windowState,
        offsets,
      );
      if (!visible) return;
      for (let index = windowState.start; index < windowState.end; index++) {
        this.renderPendingRow(visible, rows[index]);
      }
      // Restore the per-row open state before measuring: a row remounted by a
      // window shift has to answer to the same rule as its first mount.
      this.applyPlanRowExpansionIn(visible, deleteRowsBatched);
      if (this.rememberPlanRowHeights(visible) && renderDepth === 0) {
        renderDepth += 1;
        virtualOffsets = null;
        renderPendingWindow();
        renderDepth -= 1;
        return;
      }
      this.scheduleAdaptivePathLayout();
    };
    this.planVirtualRenderers.add(renderPendingWindow);
    renderPendingWindow();
    // Update reminder row sits at the very tail of the decision area: sync
    // decisions keep their positions, the row only exists while a newer
    // version is running late (方案单 20260915-0025 §四 提示层).
    if (updatePrompt) this.renderUpdateAvailableItem(section, updatePrompt);
  }

  /** One windowed pending row, dispatched by its display kind. */
  private renderPendingRow(
    container: HTMLElement,
    row: SyncPendingDisplayRow,
  ): void {
    switch (row.kind) {
      case "adoption":
        if (row.adoption) this.renderAdoptionItem(container, row.adoption, row.key);
        return;
      case "issue":
        if (row.issue) {
          this.renderPendingIssue(
            container,
            row.issue,
            row.retryable === true,
            row.nestedIssues ?? [],
            row.key,
          );
        }
        return;
      case "conflict":
        if (row.item) this.renderConflictItem(container, row.item, row.key);
        return;
      case "pluginConflict":
        if (row.pluginConflict) {
          this.renderBundleConflictItem(
            container,
            row.pluginConflict,
            row.key,
          );
        }
        return;
      case "batchDelete":
        this.renderBatchDeleteRow(container, row.deletes ?? []);
        return;
      case "delete":
        if (row.item) this.renderDeleteItem(container, row.item, row.key);
        return;
    }
  }

  /** The batch delete entry: one destructive button for the whole set. */
  private renderBatchDeleteRow(
    container: HTMLElement,
    pendingDeletes: SyncPlanItem[],
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const actions = container.createDiv("easy-sync-plan-execute");
    actions.addClass("easy-sync-primary-actions");
    actions.dataset.easySyncPlanRow = "batch-delete";
    const paths = pendingDeletes.map((item) => item.path);
    const confirmAllButton = applyDestructiveButton(
      new ButtonComponent(actions),
    );
    confirmAllButton
      .setButtonText(t("syncView.delete.confirmAll", { count: paths.length }))
      .onClick(() => {
        void this.runItemAction(actions, async () => {
          const confirmed = await new ConfirmModal(
            this.plugin.app,
            t("syncView.delete.confirmAllTitle", { count: paths.length }),
            null,
            t("syncView.delete.confirmAll", { count: paths.length }),
            t("confirm.cancel"),
            t,
            {
              message: t("syncView.delete.confirmAllMessage"),
              warning: t("syncView.delete.confirmAllWarning"),
              danger: true,
            },
          ).awaitConfirm();
          if (!confirmed) return;
          // 批量删除确认后立即进入官方 mod-loading 加载态：按钮文字被官方
          // CSS 隐藏并显示旋转圆圈，用户能看出插件正在处理而不是卡死。
          // 窗口重挂后的按钮由下方 batchDeleteInFlight 分支重新挂类，
          // 加载态可持续到整批结束。
          confirmAllButton.buttonEl.addClass("mod-loading");
          confirmAllButton.setDisabled(true);
          await this.plugin.confirmRemoteDeletes(paths);
        });
      });
    // 重挂后恢复加载态：批量删除仍在队列/执行中时，按钮保持官方旋转
    // 加载态与禁用，直到整批结束（hasSideActionsInFlight 归 false）。
    if (
      this.plugin.syncExecutor?.hasSideActionsInFlight
      && this.plugin.progressStore.state.activityKind === "sideAction"
      && this.plugin.progressStore.state.currentActionType
        === SyncActionType.ConfirmLocalDelete
    ) {
      confirmAllButton.buttonEl.addClass("mod-loading");
      confirmAllButton.setDisabled(true);
    }
  }

  /** One update-reminder row, same collapsible tree-item shape as the other
   *  decision rows. 「去更新」 is a stateless handoff to the host's own plugin
   *  detail page (the row must NOT disappear on click — 行不清规则);
   *  「跳过」 opens the snooze modal and the row leaves only after a
   *  confirmed choice. */
  private renderUpdateAvailableItem(
    container: HTMLElement,
    prompt: { latest: string; current: string },
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const icon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(icon, "square-arrow-up");
    // Row title is the plugin's own display name (manifest is the single
    // source of truth for the product proper noun).
    summary.createSpan("easy-sync-tree-path").setText(this.plugin.manifest.name);
    summary.createSpan("easy-sync-tree-chip").setText(t("updateCheck.chip"));
    const body = details.createDiv("easy-sync-tree-item-body");
    body.createDiv("easy-sync-item-reason").setText(
      t("updateCheck.rowBody", {
        latest: prompt.latest,
        current: prompt.current,
      }),
    );
    const actions = body.createDiv("easy-sync-item-actions");
    this.createActionChip(actions, t("updateCheck.goUpdate"), "accent", () => {
      this.plugin.openUpdatePage();
    });
    this.createActionChip(actions, t("updateCheck.skip"), "", () => {
      void (async () => {
        const choice = await new UpdateReminderModal(
          this.plugin.app,
          t("updateCheck.modalTitle"),
          t("updateCheck.modalBody"),
          t("updateCheck.optionSnooze"),
          t("updateCheck.optionSkipVersion"),
          t("updateCheck.confirm"),
          t("updateCheck.cancel"),
        ).awaitSelection();
        if (choice) this.plugin.snoozeUpdateReminder(choice);
      })();
    });
  }

  private renderPendingIssue(
    container: HTMLElement,
    issue: PendingIssue,
    retryable: boolean,
    nestedIssues: readonly PendingIssue[] = [],
    rowKey?: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    if (rowKey) details.dataset.easySyncPlanRow = rowKey;
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const action = resolveSyncActionPresentation(issue.actionType);
    const actionIcon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(actionIcon, action.icon);
    const pathEl = summary.createSpan("easy-sync-tree-path");
    configureFilePath(details, pathEl, issue.path, true);
    const chipLabel = formatPendingIssueChipLabel(issue.actionType, t);
    if (chipLabel) summary.createSpan("easy-sync-tree-chip").setText(chipLabel);
    // scope-crossing 行的出口按当前去向记录分流：有覆盖 hint 的移出行才
    // 渲染撤销/确认双按钮；漂移与设置形态没有去向证据，恢复通用「重新检
    // 查」。判定与行动侧快照共用同一规则（StateManager.getScopeCrossing
    // ExitKind → findScopeCrossingCoveringHintV1），渲染不会许诺不可用的动作。
    const scopeCrossingExitKind = issue.issueCode === "scope-crossing"
      ? this.plugin.state?.getScopeCrossingExitKind(issue.path) ?? null
      : null;

    const body = details.createDiv("easy-sync-tree-item-body");
    if (issue.reason) {
      body.createDiv("easy-sync-item-reason").setText(
        scopeCrossingExitKind === "folder"
          ? t("syncView.scopeCrossing.rowReasonFolder")
          : issue.reason,
      );
    }
    if (nestedIssues.length > 0) {
      body.createDiv("easy-sync-item-reason").setText(
        t("syncView.folderSubtree.affectedFolders", {
          count: nestedIssues.length + 1,
        }),
      );
    }
    const actions = body.createDiv("easy-sync-item-actions");
    const localFile = this.plugin.app.vault.getAbstractFileByPath(issue.path);
    if (localFile instanceof TFile) {
      this.createActionChip(actions, t("syncView.issues.openFile"), "", () => {
        void this.plugin.app.workspace.getLeaf(false).openFile(localFile);
      });
    }
    if (retryable) {
      if (
        issue.issueCode === "identity-replacement-ambiguous"
        || issue.issueCode === "anchored-folder-missing-remote"
        || issue.issueCode === "local-rename-evidence-conflict"
        || issue.issueCode === "local-subtree-changed"
        || issue.issueCode === "remote-subtree-changed"
        || issue.issueCode === "target-occupied"
        || issue.issueCode === "parent-chain-incomplete"
      ) {
        this.createActionChip(
          actions,
          t("syncView.staleIdentity.resolve"),
          "accent",
          () => {
            void this.openStaleIdentityResolution(issue.path);
          },
        );
        return;
      }
      if (issue.issueCode === "unanchored-shared-folder") {
        this.createActionChip(
          actions,
          t("syncView.sharedFolderIdentity.resolve"),
          "accent",
          () => {
            void this.openSharedFolderIdentityResolution(issue.path);
          },
        );
        return;
      }
      if (issue.issueCode === "anchored-folder-missing-local") {
        this.createActionChip(
          actions,
          t("syncView.folderSubtree.review"),
          "accent",
          () => {
            void this.openEmptyFolderResolution(issue.path);
          },
        );
        return;
      }
      if (issue.issueCode === "folder-location-choice") {
        this.createActionChip(
          actions,
          t("syncView.folderLocation.resolve"),
          "accent",
          () => {
            void this.openFolderLocationResolution(issue.path);
          },
        );
        return;
      }
      if (issue.issueCode === "scope-crossing" && scopeCrossingExitKind) {
        this.createActionChip(
          actions,
          t("syncView.scopeCrossing.restore"),
          "accent",
          () => {
            void this.openScopeCrossingRestore(issue.path);
          },
        );
        this.createActionChip(
          actions,
          t("syncView.scopeCrossing.confirm"),
          "accent",
          () => {
            void this.openScopeCrossingConfirm(issue.path);
          },
        );
        return;
      }
      // 通用重试 chip 不再渲染（2026-09-16 按钮清理）：其余可重试问题行
      // 的行内重试与顶部主动作完全等同（同一完整手动同步入口），轮运行
      // 中点击也仅得 busy 提示——重试统一经顶部「立即同步」；延后类行
      // 由自动轮次收敛。行内保留原因文案与可选「打开文件」。
    }
  }

  // Per-row short guard. The kind-wide flags above are released before the
  // settlement so other rows of the same kind stay immediately clickable;
  // without this, the same row would accept a second decision while its first
  // settlement is still in flight and silently discard it.
  private lockResolutionRow(key: string): boolean {
    if (this.resolutionRowLocks.has(key)) return false;
    this.resolutionRowLocks.add(key);
    return true;
  }

  private unlockResolutionRow(key: string): void {
    this.resolutionRowLocks.delete(key);
  }

  /**
   * Report why one manual resolution chip did not open. The entry knows the
   * cause; this keeps the caller's own facts-level wording for real changes
   * and stops the entry gates (a running sync, another action, unfinished
   * state work) from being reported as "the facts changed".
   */
  private notifyResolutionEntryUnavailable(
    entry: {
      reason: ManualResolutionEntryReason;
      nameMismatchPath?: string;
    },
    path: string,
    factsChangedKey: string,
    nameMismatchKey?: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const notice = resolveManualResolutionNotice(entry.reason);
    if (notice.kind === "entry") {
      new Notice(t(notice.key));
      return;
    }
    if (notice.kind === "name-mismatch" && nameMismatchKey) {
      new Notice(t(nameMismatchKey, {
        path,
        namePath: entry.nameMismatchPath ?? path,
      }));
      return;
    }
    new Notice(t(factsChangedKey, { path }));
  }

  private async openStaleIdentityResolution(path: string): Promise<void> {
    if (this.staleIdentityResolutionOpening) return;
    const rowKey = `stale:${path}`;
    if (!this.lockResolutionRow(rowKey)) return;
    this.staleIdentityResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const entry =
        await this.plugin.getStaleIdentityResolutionSnapshot(path);
      if (!entry.snapshot) {
        this.notifyResolutionEntryUnavailable(
          entry,
          path,
          "notice.staleIdentity.changed",
        );
        return;
      }
      const snapshot = entry.snapshot;
      const confirmed = await new ConfirmModal(
        this.plugin.app,
        t("syncView.staleIdentity.confirmTitle"),
        null,
        t("syncView.staleIdentity.confirm"),
        t("confirm.cancel"),
        t,
        {
          message: t(
            snapshot.kind === "folder-active-forget"
              ? "syncView.staleIdentity.activeForgetMessage"
              : snapshot.kind === "folder-missing-remote"
                ? "syncView.staleIdentity.folderMessage"
                : "syncView.staleIdentity.fileMessage",
            { path },
          ),
        },
      ).awaitConfirm();
      if (!confirmed) return;
      // The modal interaction is over — release the shared guard before the
      // settlement so other rows of the same kind stay clickable (same
      // immediate-response contract as ordinary file conflicts).
      this.staleIdentityResolutionOpening = false;
      await this.plugin.retireReviewedStaleIdentity(snapshot);
    } finally {
      this.staleIdentityResolutionOpening = false;
      this.unlockResolutionRow(rowKey);
    }
  }

  private async openSharedFolderIdentityResolution(path: string): Promise<void> {
    if (this.sharedFolderIdentityResolutionOpening) return;
    const rowKey = `shared-folder:${path}`;
    if (!this.lockResolutionRow(rowKey)) return;
    this.sharedFolderIdentityResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const entry =
        await this.plugin.getSharedFolderIdentityResolutionSnapshot(path);
      if (!entry.snapshot) {
        this.notifyResolutionEntryUnavailable(
          entry,
          path,
          "notice.sharedFolderIdentity.changed",
          "notice.sharedFolderIdentity.nameMismatch",
        );
        return;
      }
      const snapshot = entry.snapshot;
      const confirmed = await new ConfirmModal(
        this.plugin.app,
        t("syncView.sharedFolderIdentity.confirmTitle"),
        null,
        t("syncView.sharedFolderIdentity.confirm"),
        t("confirm.cancel"),
        t,
        {
          message: t("syncView.sharedFolderIdentity.confirmMessage", { path }),
        },
      ).awaitConfirm();
      if (!confirmed) return;
      // The modal interaction is over — release the shared guard before the
      // settlement so other rows of the same kind stay clickable (same
      // immediate-response contract as ordinary file conflicts).
      this.sharedFolderIdentityResolutionOpening = false;
      await this.plugin.confirmReviewedSharedFolderIdentity(snapshot);
    } finally {
      this.sharedFolderIdentityResolutionOpening = false;
      this.unlockResolutionRow(rowKey);
    }
  }

  private async openEmptyFolderResolution(path: string): Promise<void> {
    if (this.emptyFolderResolutionOpening) return;
    const rowKey = `empty-folder:${path}`;
    if (!this.lockResolutionRow(rowKey)) return;
    this.emptyFolderResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const snapshot = await this.plugin.getEmptyFolderResolutionSnapshot(path);
      if (!snapshot) {
        const subtree = await this.plugin.getFolderSubtreeReviewSnapshot(path);
        if (subtree) {
          const choice = await new EmptyFolderResolutionModal(
            this.plugin.app,
            subtree,
            t,
          ).awaitChoice();
          // The modal interaction is over — release the shared guard before
          // the settlement so other rows stay clickable (same immediate-
          // response contract as ordinary file conflicts).
          this.emptyFolderResolutionOpening = false;
          if (choice?.action === "restore") {
            await this.plugin.restoreReviewedFolderSubtree(subtree);
          }
          if (choice?.action === "delete-subtree") {
            const folders = subtree.members.filter(
              (member) => member.kind === "folder",
            ).length;
            const files = subtree.members.length - folders;
            const confirmed = await new ConfirmModal(
              this.plugin.app,
              t("syncView.folderSubtree.deleteConfirmTitle"),
              null,
              t("syncView.folderSubtree.delete"),
              t("confirm.cancel"),
              t,
              {
                message: t("syncView.folderSubtree.deleteConfirmMessage", {
                  path: subtree.path,
                  folders,
                  files,
                }),
                warning: t("syncView.folderSubtree.deleteConfirmWarning"),
                danger: true,
              },
            ).awaitConfirm();
            if (confirmed) {
              await this.plugin.deleteReviewedFolderSubtree(subtree);
            }
          }
          return;
        }
        new Notice(t("notice.emptyFolder.changed", { path }));
        return;
      }
      const choice = await new EmptyFolderResolutionModal(
        this.plugin.app,
        snapshot,
        t,
      ).awaitChoice();
      if (!choice) return;
      // The modal interaction is over — release the shared guard before the
      // settlement so other rows stay clickable (same immediate-response
      // contract as ordinary file conflicts).
      this.emptyFolderResolutionOpening = false;
      if (choice.action === "restore") {
        await this.plugin.restoreReviewedEmptyFolder(snapshot);
        return;
      }
      if (choice.action === "bind") {
        await this.plugin.bindReviewedEmptyFolderRename(
          snapshot,
          choice.candidatePath,
        );
        return;
      }
      const confirmed = await new ConfirmModal(
        this.plugin.app,
        t("syncView.emptyFolder.deleteConfirmTitle", { path }),
        null,
        t("syncView.emptyFolder.deleteConfirm"),
        t("confirm.cancel"),
        t,
        {
          message: t("syncView.emptyFolder.deleteConfirmMessage", { path }),
          warning: t("syncView.emptyFolder.deleteConfirmWarning"),
          danger: true,
        },
      ).awaitConfirm();
      if (!confirmed) return;
      await this.plugin.deleteReviewedEmptyRemoteFolder(snapshot);
    } finally {
      this.emptyFolderResolutionOpening = false;
      this.unlockResolutionRow(rowKey);
    }
  }

  private async openFolderLocationResolution(path: string): Promise<void> {
    if (this.emptyFolderResolutionOpening) return;
    const rowKey = `folder-location:${path}`;
    if (!this.lockResolutionRow(rowKey)) return;
    this.emptyFolderResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const snapshot =
        await this.plugin.getFolderLocationResolutionSnapshot(path);
      if (!snapshot) {
        new Notice(t("notice.folderLocation.changed", { path }));
        return;
      }
      const choice = await new EmptyFolderResolutionModal(
        this.plugin.app,
        snapshot,
        t,
      ).awaitChoice();
      if (!choice) return;
      // The modal interaction is over — release the shared guard before the
      // settlement so other rows stay clickable (same immediate-response
      // contract as ordinary file conflicts).
      this.emptyFolderResolutionOpening = false;
      if (choice?.action === "keep-local-location") {
        await this.plugin.resolveReviewedFolderLocation(
          snapshot,
          "keep-local",
        );
      }
      if (choice?.action === "keep-remote-location") {
        await this.plugin.resolveReviewedFolderLocation(
          snapshot,
          "keep-remote",
        );
      }
    } finally {
      this.emptyFolderResolutionOpening = false;
      this.unlockResolutionRow(rowKey);
    }
  }

  private async openScopeCrossingRestore(path: string): Promise<void> {
    if (this.scopeCrossingResolutionOpening) return;
    const rowKey = `scope-crossing:${path}`;
    if (!this.lockResolutionRow(rowKey)) return;
    this.scopeCrossingResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const entry =
        await this.plugin.getScopeCrossingResolutionSnapshot(path);
      if (!entry.snapshot) {
        this.notifyResolutionEntryUnavailable(
          entry,
          path,
          "notice.scopeCrossing.changed",
        );
        return;
      }
      const snapshot = entry.snapshot;
      const confirmed = await new ConfirmModal(
        this.plugin.app,
        t("syncView.scopeCrossing.restoreTitle"),
        null,
        t("syncView.scopeCrossing.restore"),
        t("confirm.cancel"),
        t,
        {
          message: t("syncView.scopeCrossing.restoreMessage", {
            path: snapshot.fromPath,
          }),
        },
      ).awaitConfirm();
      if (!confirmed) return;
      // The modal interaction is over — release the shared guard before the
      // settlement so other rows of the same kind stay clickable (same
      // immediate-response contract as ordinary file conflicts).
      this.scopeCrossingResolutionOpening = false;
      await this.plugin.restoreScopeCrossingMove(snapshot);
    } finally {
      this.scopeCrossingResolutionOpening = false;
      this.unlockResolutionRow(rowKey);
    }
  }

  private async openScopeCrossingConfirm(path: string): Promise<void> {
    if (this.scopeCrossingResolutionOpening) return;
    const rowKey = `scope-crossing:${path}`;
    if (!this.lockResolutionRow(rowKey)) return;
    this.scopeCrossingResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const entry =
        await this.plugin.getScopeCrossingResolutionSnapshot(path);
      if (!entry.snapshot) {
        this.notifyResolutionEntryUnavailable(
          entry,
          path,
          "notice.scopeCrossing.changed",
        );
        return;
      }
      const snapshot = entry.snapshot;
      const confirmed = await new ConfirmModal(
        this.plugin.app,
        t("syncView.scopeCrossing.confirmTitle"),
        null,
        t("syncView.scopeCrossing.confirm"),
        t("confirm.cancel"),
        t,
        {
          message: t(
            snapshot.kind === "folder"
              ? "syncView.scopeCrossing.confirmMessageFolder"
              : "syncView.scopeCrossing.confirmMessageFile",
            { path: snapshot.fromPath },
          ),
          danger: true,
        },
      ).awaitConfirm();
      if (!confirmed) return;
      // The modal interaction is over — release the shared guard before the
      // settlement so other rows of the same kind stay clickable (same
      // immediate-response contract as ordinary file conflicts).
      this.scopeCrossingResolutionOpening = false;
      await this.plugin.confirmScopeCrossingExit(snapshot);
    } finally {
      this.scopeCrossingResolutionOpening = false;
      this.unlockResolutionRow(rowKey);
    }
  }

  private async openMutationRecoveryResolution(): Promise<void> {
    if (this.mutationRecoveryResolutionOpening) return;
    const rowKey = "mutation-recovery";
    if (!this.lockResolutionRow(rowKey)) return;
    this.mutationRecoveryResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const snapshot = await this.plugin.getMutationRecoveryResolutionSnapshot();
      if (!snapshot) {
        new Notice(t("notice.mutationResolution.unavailable"));
        return;
      }
      if (shouldAutoSettleIdenticalRecovery(snapshot)) {
        // Identical facts leave no decision for the user: settle through the
        // existing chain, which rechecks facts and digests before any write.
        this.mutationRecoveryResolutionOpening = false;
        await this.plugin.resolveMutationRecovery(snapshot, "keep-local");
        this.plugin.updateStatusBar();
        this.render();
        return;
      }
      const choice = await new MutationRecoveryResolutionModal(
        this.plugin.app,
        snapshot,
        t,
        (filePluginId, path) =>
          this.plugin.getCommunityPluginBundleFileDiff(filePluginId, path),
      ).awaitChoice();
      if (!choice) return;
      if (!await this.confirmMutationResolutionDeletion(snapshot, choice)) return;
      // The modal interaction is over — release the shared guard before the
      // settlement + full sync round so other plugin rows stay clickable
      // (same immediate-response contract as ordinary file conflicts).
      this.mutationRecoveryResolutionOpening = false;
      await this.plugin.resolveMutationRecovery(snapshot, choice);
    } finally {
      this.mutationRecoveryResolutionOpening = false;
      this.unlockResolutionRow(rowKey);
    }
  }

  /**
   * Folder-intent blocked recovery records carry no keep-side content
   * decision: the exit confirms continuing from the current two-sided
   * facts. Zero-write settlement; ordinary planning takes over afterwards.
   */
  private async openCommunityPluginBundleReview(pluginId: string): Promise<void> {
    if (this.mutationRecoveryResolutionOpening) return;
    const rowKey = `bundle-review:${pluginId}`;
    if (!this.lockResolutionRow(rowKey)) return;
    this.mutationRecoveryResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const snapshotPromise = this.plugin
        .getCommunityPluginBundleReviewSnapshot(pluginId);
      const getFileDiff = (filePluginId: string, path: string) =>
        this.plugin.getCommunityPluginBundleFileDiff(filePluginId, path);
      const choice = await new MutationRecoveryResolutionModal(
        this.plugin.app,
        snapshotPromise,
        t,
        getFileDiff,
      ).awaitChoice();
      if (!choice) return;
      const snapshot = await snapshotPromise;
      if (!snapshot?.bundleReview) {
        new Notice(t("notice.mutationResolution.unavailable"));
        return;
      }
      if (!await this.confirmMutationResolutionDeletion(snapshot, choice)) return;
      // The modal interaction is over — release the shared guard before the
      // settlement + full sync round so other plugin rows stay clickable
      // (same immediate-response contract as ordinary file conflicts).
      this.mutationRecoveryResolutionOpening = false;
      await this.plugin.resolveMutationRecovery(snapshot, choice);
    } finally {
      this.mutationRecoveryResolutionOpening = false;
      this.unlockResolutionRow(rowKey);
    }
  }

  private async confirmMutationResolutionDeletion(
    snapshot: Readonly<ManualMutationResolutionSnapshotV1>,
    choice: ManualMutationResolutionChoiceV1,
  ): Promise<boolean> {
    const option = choice === "keep-local"
      ? snapshot.keepLocal
      : snapshot.keepRemote;
    if (!option.deletesOtherSide) return true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    return new ConfirmModal(
      this.plugin.app,
      t("syncView.mutationResolution.deleteConfirmTitle"),
      null,
      t("syncView.mutationResolution.deleteConfirm"),
      t("confirm.cancel"),
      t,
      {
        message: t("syncView.mutationResolution.deleteConfirmMessage", {
          path: snapshot.bundleReview?.displayName
            ?? snapshot.bundleReview?.pluginId
            ?? snapshot.path,
          choice: choice === "keep-local"
            ? t("syncView.mutationResolution.keepLocal")
            : t("syncView.mutationResolution.keepRemote"),
        }),
        warning: t("syncView.mutationResolution.deleteConfirmWarning"),
        danger: true,
      },
    ).awaitConfirm();
  }

  private renderHistorySection(container: HTMLElement, history: SyncHistoryEntry[]): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const section = this.createSection(container, t("syncView.history.title"));
    if (history.length === 0) {
      section.createDiv("easy-sync-empty-state").setText(t("syncView.history.empty"));
      return;
    }

    const list = section.createDiv("easy-sync-history-list");
    history.forEach((entry, index) => {
      const details = list.createEl("details", "easy-sync-history-run easy-sync-tree-item");
      const initiallyOpen = index === 0 && entry.status !== "success";
      details.open = initiallyOpen;
      const summary = details.createEl("summary", "easy-sync-history-summary easy-sync-tree-row");
      this.addCollapseIcon(summary);
      const main = summary.createSpan("easy-sync-history-main");
      main.createSpan("easy-sync-history-time").setText(
        new Date(entry.endedAt).toLocaleString(undefined, {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      main.createSpan(`easy-sync-history-status is-${entry.status}`).setText(
        t(`syncView.history.status.${entry.status}`),
      );

      const body = details.createDiv("easy-sync-history-detail");
      if (initiallyOpen) {
        this.renderHistoryEntryBody(body, entry);
      } else {
        // 收起轮懒建:首次展开时才挂详情——10 轮×≤100 文件行的全量挂载是
        // 打开历史区的主要 DOM 成本;折叠态 summary 照常渲染,建后保留
        // (再收展零重建)。
        details.addEventListener("toggle", () => {
          if (details.open && body.firstElementChild === null) {
            this.renderHistoryEntryBody(body, entry);
          }
        });
      }
    });
  }

  private renderHistoryEntryBody(
    body: HTMLElement,
    entry: SyncHistoryEntry,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    {
      body.createDiv("easy-sync-history-meta").setText(
        `${t(`syncView.history.mode.${entry.mode}`)} · ${t("syncView.history.duration", {
          seconds: Math.max(0, Math.round((entry.endedAt - entry.startedAt)/1000)),
        })}`,
      );
      const runMessage = (entry.message ?? "").trim();
      if (entry.status !== "success" && runMessage) {
        body.createDiv("easy-sync-history-result").setText(runMessage);
      }
      const counts = formatSyncHistoryCounts(entry, t);
      if (counts) {
        body.createDiv("easy-sync-history-counts").setText(counts);
      } else if (
        entry.status === "success"
        && entry.files.length === 0
        && entry.runFacts?.userFileChanges === "none"
        && !entry.recovery
        && !entry.remoteScopeRecovery
      ) {
        body.createDiv("easy-sync-history-result").setText(
          t("syncView.history.noFileChanges"),
        );
      }
      if (entry.recovery) {
        body.createDiv("easy-sync-history-meta").setText(
          formatMutationRecoveryHistory(entry.recovery, t),
        );
      }
      if (entry.files.length > 0) {
        // 增量呈现（2026-09-16 方案单 §十二）：SkipLargeFile 行归入折叠组，
        // 组标题承载性质（设置名「大型文件排除」），组内行=图标+路径，
        // 徽标与理由句由组收掉；其余行（含上传/下载/invalid-name）照旧。
        const skipLargeRows = entry.files.filter(
          (file) => file.actionType === SyncActionType.SkipLargeFile,
        );
        const otherRows = entry.files.filter(
          (file) => file.actionType !== SyncActionType.SkipLargeFile,
        );
        if (otherRows.length > 0) {
          this.renderFileResults(body, otherRows, false);
        }
        if (skipLargeRows.length > 0) {
          const group = body.createEl(
            "details",
            "easy-sync-history-skip-group easy-sync-tree-item",
          );
          const summary = group.createEl(
            "summary",
            "easy-sync-history-skip-summary easy-sync-tree-row",
          );
          this.addCollapseIcon(summary);
          summary.createSpan("easy-sync-history-skip-title").setText(
            t("syncView.history.skipGroupTitle", {
              count: skipLargeRows.length,
            }),
          );
          const groupRows = group.createDiv("easy-sync-file-list");
          for (let i = skipLargeRows.length - 1; i >= 0; i--) {
            const row = groupRows.createDiv("easy-sync-file-row");
            const icon = row.createSpan("easy-sync-file-icon");
            setIcon(icon, resolveFileProgressPresentation(skipLargeRows[i]).icon);
            const pathEl = row.createSpan("easy-sync-file-path");
            configureFilePath(row, pathEl, skipLargeRows[i].path, false);
          }
        }
      }
      const omitted = countOmittedSyncHistorySuccessfulFiles(entry);
      if (omitted > 0) {
        body.createDiv("easy-sync-history-omitted").setText(
          t("syncView.history.omitted", { count: omitted }),
        );
      }
    }
  }

  private renderFileResults(
    container: HTMLElement,
    files: FileProgress[],
    limitHeight: boolean,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const list = container.createDiv("easy-sync-file-list");
    const renderedPaths = new Set<string>();
    const ledger = new Map<string, string>();
    if (limitHeight) {
      list.addClass("is-limited");
      list.addClass("easy-sync-path-layout");
      this.fileListEl = list;
    }

    // Iterate in reverse (newest first)
    for (let i = files.length - 1; i >= 0; i--) {
      if (limitHeight && renderedPaths.has(files[i].path)) continue;
      renderedPaths.add(files[i].path);
      renderFileRow(files[i], list, t, limitHeight);
      if (limitHeight) ledger.set(files[i].path, completedFileRowKey(files[i]));
    }
    if (limitHeight) this.completedFileRowsLedger = ledger;
  }

  private renderPlanReviewSection(
    container: HTMLElement,
    counts: { uploads: number; downloads: number; folders?: number; deletes: number; conflicts: number; skipped: number } | null,
    items: PlanReviewItem[],
    conflicts: SyncPlanItem[],
    pendingDeletes: SyncPlanItem[],
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const panel = this.createSection(container, t("syncPlan.sectionTitle"));
    const activationReviewKind =
      this.plugin.state?.planReviewAuthorization?.reviewKind;

    if (activationReviewKind === "v2-migration") {
      panel.createDiv("setting-item-description").setText(
        t("syncPlan.migrationSummary"),
      );
    } else if (activationReviewKind === "v2-cloud-join") {
      panel.createDiv("setting-item-description").setText(
        t("syncPlan.cloudJoinSummary"),
      );
    } else if (items.some(
      (item) => item.type === SyncActionType.RecreateRemoteScope,
    )) {
      panel.createDiv("setting-item-description").setText(
        t("syncPlan.remoteScopeRecreateSummary"),
      );
    } else if (
      // Ordinary plans only: the dedicated review kinds keep their own single
      // sentence, and a clean plan stays silent. The note states the confirm
      // button's boundary — decision rows are not executed by it.
      items.some((item) =>
        item.type === SyncActionType.Conflict
        || item.type === SyncActionType.ConfirmLocalDelete)
    ) {
      panel.createDiv("setting-item-description").setText(
        t("syncPlan.confirmBoundarySummary"),
      );
    }

    if (counts && items.length === 0) {
      const rows: Array<[string, number]> = [
        [t("syncAction.group.upload"), counts.uploads],
        [t("syncAction.group.download"), counts.downloads],
        [t("syncAction.summary.folderChanges"), counts.folders ?? 0],
        [t("syncAction.group.delete"), counts.deletes],
        [t("syncAction.group.conflict"), counts.conflicts],
        [t("syncAction.group.skip"), counts.skipped],
      ];
      panel.createDiv("easy-sync-plan-counts").setText(
        rows.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`).join(" · "),
      );
    }

    if (items.length > 0) {
      this.renderPlanGroups(panel, items, conflicts, pendingDeletes);
    } else if (!counts || Object.values(counts).every((count) => count === 0)) {
      panel.createDiv("easy-sync-empty-state").setText(t("syncPlan.noChanges"));
    } else {
      panel.createDiv("easy-sync-empty-state").setText(t("syncPlan.detailsUnavailable"));
    }

  }

  private renderPlanGroups(
    container: HTMLElement,
    items: PlanReviewItem[],
    conflicts: SyncPlanItem[],
    pendingDeletes: SyncPlanItem[],
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const conflictByPath = new Map(conflicts.map((item) => [item.path, item]));
    const deleteByPath = new Map(pendingDeletes.map((item) => [item.path, item]));
    const pluginConflictByPath = new Map<string, {
      pluginId: string;
      items: SyncPlanItem[];
    }>();
    for (const entry of groupBundleConflictReviews(
      conflicts,
      getConfigDir(this.plugin.app.vault),
    )) {
      if (entry.kind !== "bundle") continue;
      for (const item of entry.items) pluginConflictByPath.set(item.path, entry);
    }
    const groups = buildSyncPlanDisplayGroups(items);
    // 成批的待确认删除按区域判定（与待处理区批量删除入口同一条件）：它们默认
    // 收起，出口是那一组行本身或批量入口，不是每行的展开区。
    const deleteRowsBatched = isBatchedDeleteSet(
      items
        .filter((item) => item.type === SyncActionType.ConfirmLocalDelete
          && deleteByPath.has(item.path))
        .map((item) => `delete:${item.path}`),
    );
    this.renderedDeleteRowsBatched = deleteRowsBatched;

    for (const group of groups) {
      const rows = buildSyncPlanDisplayRows(
        group.items,
        conflictByPath,
        deleteByPath,
        pluginConflictByPath,
      );
      const body = this.createTreeGroup(
        container,
        t(group.labelKey),
        group.items.length,
        this.resolvePlanGroupOpen(
          group.group,
          rows.some((row) => isDecisionRowKey(row.key)),
        ),
      );
      body.addClass("easy-sync-path-layout");
      const details = body.parentElement as HTMLDetailsElement;
      details.dataset.easySyncPlanGroup = group.group;
      details.addEventListener("toggle", () => {
        this.planGroupExpandedState.set(group.group, details.open);
      });
      // Conflict and delete rows carry their own buttons, so they have to be
      // mounted to be used — and one expanded row is worth several plain ones.
      // They are windowed the same way, with a measured height per row instead
      // of the flat two-height model the read-only groups use.
      const hasInlineDecisions = group.items.some((item) =>
        item.type === SyncActionType.Conflict
        || item.type === SyncActionType.ConfirmLocalDelete);

      const virtualList = body.createDiv("easy-sync-plan-virtual-list");
      let virtualOffsets: number[] | null = null;
      let offsetsRevision = -1;
      let renderedKey = "";
      let renderDepth = 0;

      const resolveOffsets = (): number[] => {
        if (virtualOffsets && offsetsRevision === this.planRowLayoutRevision) {
          return virtualOffsets;
        }
        if (hasInlineDecisions) {
          const probe = this.measurePlanDecisionRowHeights(body);
          virtualOffsets = buildSyncPlanMeasuredVirtualOffsets(
            rows.map((row) =>
              this.planRowHeights.get(row.key)
              ?? (this.resolvePlanRowOpen(row.key, deleteRowsBatched)
                ? probe.expandedRowHeight
                : probe.collapsedRowHeight)),
          );
        } else {
          const probe = this.measurePlanRowHeights(body);
          virtualOffsets = buildSyncPlanVirtualOffsets(
            rows.map((row) => row.item),
            probe.rowHeight,
            probe.reasonRowHeight,
          );
        }
        offsetsRevision = this.planRowLayoutRevision;
        return virtualOffsets;
      };

      let renderInlineDecisions: () => void;
      renderInlineDecisions = (): void => {
        if (!details.open) {
          if (renderedKey) virtualList.empty();
          renderedKey = "";
          return;
        }
        // A row whose decision is still settling has to stay mounted: the user
        // is waiting on that exact row, and a window shift would take it away.
        // Only the window that holds such a row freezes; other groups render.
        if (
          hasInlineDecisions
          && rows.some((row) => this.planDecisionRowsInFlight.has(row.key))
        ) {
          return;
        }
        const offsets = resolveOffsets();
        const listRect = virtualList.getBoundingClientRect();
        const viewportRect = this.resolvePlanViewportRect();
        const windowState = buildSyncPlanVirtualWindow({
          offsets,
          listTop: listRect.top,
          viewportTop: viewportRect.top,
          viewportBottom: viewportRect.bottom,
        });
        const nextKey =
          `${windowState.start}:${windowState.end}:${windowState.offset}`;
        // 与待处理窗口同一规则：行高缓存被清空后窗口键可能不变，早退会把
        // 占位与槽位冻结在估算值上。键未变也要重挂量一次实高。只读组不用
        // 行高缓存（两档探针高度即模型本身），保持原早退。
        const mountedMeasured = !hasInlineDecisions
          || rows
            .slice(windowState.start, windowState.end)
            .every((row) => this.planRowHeights.has(row.key));
        if (nextKey === renderedKey && mountedMeasured) return;
        renderedKey = nextKey;
        virtualList.empty();
        const visible = this.mountPlanFlowWindow(
          virtualList,
          windowState,
          offsets,
        );
        if (!visible) return;
        for (let index = windowState.start; index < windowState.end; index++) {
          this.renderPlanReviewRow(
            visible,
            rows[index],
            conflictByPath,
            deleteByPath,
          );
        }
        // Restore the per-row open state before measuring: a row remounted by a
        // window shift has to answer to the same rule as its first mount.
        this.applyPlanRowExpansionIn(visible, deleteRowsBatched);
        if (hasInlineDecisions && this.rememberPlanRowHeights(visible) && renderDepth === 0) {
          // The estimates only place the first window; as soon as the real
          // heights are known the window has to be resolved against them.
          renderDepth += 1;
          virtualOffsets = null;
          renderInlineDecisions();
          renderDepth -= 1;
          return;
        }
        this.scheduleAdaptivePathLayout();
      };
      this.planVirtualRenderers.add(renderInlineDecisions);
      details.addEventListener("toggle", renderInlineDecisions);
      renderInlineDecisions();
    }
  }

  private measurePlanRowHeights(container: HTMLElement): {
    rowHeight: number;
    reasonRowHeight: number;
  } {
    const probe = container.createDiv(
      "easy-sync-file-row easy-sync-plan-measure-probe",
    );
    const icon = probe.createSpan("easy-sync-file-icon");
    setIcon(icon, "arrow-up");
    probe.createSpan("easy-sync-file-path").setText("measure.md");
    const rowHeight = probe.getBoundingClientRect().height;
    probe.createDiv("easy-sync-file-reason").setText(PLAN_ROW_PROBE_TEXT);
    const reasonRowHeight = probe.getBoundingClientRect().height;
    probe.remove();
    return {
      rowHeight: rowHeight > 0 ? rowHeight : 20,
      reasonRowHeight: reasonRowHeight > 0 ? reasonRowHeight : 42,
    };
  }

  /**
   * Collapsed and expanded heights of a decision row, measured so a window can
   * be placed before any row is mounted. The probe mirrors the conflict row
   * markup — the tallest of the three decision shapes — so the estimate never
   * under-shoots and leaves blank space while the first window settles.
   */
  private measurePlanDecisionRowHeights(container: HTMLElement): {
    collapsedRowHeight: number;
    expandedRowHeight: number;
  } {
    const probe = container.createEl("details", {
      cls: "easy-sync-tree-item easy-sync-plan-decision-probe",
    });
    const summary = probe.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const icon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(icon, "triangle-alert");
    configureFilePath(
      probe,
      summary.createSpan("easy-sync-tree-path"),
      "measure.md",
      true,
    );
    summary.createSpan("easy-sync-tree-chip").setText(PLAN_ROW_PROBE_TEXT);
    const collapsedRowHeight = probe.getBoundingClientRect().height;
    const body = probe.createDiv("easy-sync-tree-item-body");
    body.createDiv("easy-sync-item-reason").setText(PLAN_ROW_PROBE_TEXT);
    const actions = body.createDiv("easy-sync-item-actions");
    const variants: Array<"" | "accent"> = ["accent", "accent", ""];
    for (const variant of variants) {
      this.createActionChip(actions, "measure", variant, () => undefined);
    }
    probe.open = true;
    const expandedRowHeight = probe.getBoundingClientRect().height;
    probe.remove();
    const collapsed = collapsedRowHeight > 0 ? collapsedRowHeight : 26;
    return {
      collapsedRowHeight: collapsed,
      expandedRowHeight: expandedRowHeight > collapsed
        ? expandedRowHeight
        : collapsed + 62,
    };
  }

  /** 分组头的默认态：含决策项的分组默认展开（决策出口不该藏在两层折叠后
   *  面），纯只读分组默认折叠；用户手势与会话级覆盖都在此之上。 */
  private resolvePlanGroupOpen(
    group: SyncActionGroup,
    hasDecisionRows: boolean,
  ): boolean {
    const remembered = this.planGroupExpandedState.get(group);
    if (remembered !== undefined) return remembered;
    if (this.sessionOverride === "expanded") return true;
    if (this.sessionOverride === "collapsed") return false;
    return hasDecisionRows;
  }

  /** 决策行开合的解析顺序：行级手势 > 会话级覆盖 > 类别默认。key 是行身份；
   *  类别默认里唯一依赖区域事实的是成批的待确认删除。 */
  private resolvePlanRowOpen(rowKey: string, deleteRowsBatched: boolean): boolean {
    const remembered = this.planRowExpandedState.get(rowKey);
    if (remembered !== undefined) return remembered;
    if (this.sessionOverride === "expanded") return true;
    if (this.sessionOverride === "collapsed") return false;
    return resolveDecisionRowDefaultOpen(rowKey, { deleteRowsBatched });
  }

  /** Re-apply the remembered open state to every mounted decision row. */
  private applyPlanRowExpansion(): void {
    this.applyPlanRowExpansionIn(this.contentEl, this.renderedDeleteRowsBatched);
  }

  /**
   * The same rule, scoped to one subtree. A window shift remounts rows, so the
   * mount has to restore their state before any height is measured — otherwise
   * a scrolled-in row comes back collapsed while the offset model still holds
   * its expanded height.
   */
  private applyPlanRowExpansionIn(
    root: ParentNode,
    deleteRowsBatched: boolean,
  ): void {
    const rows = root.querySelectorAll<HTMLElement>("[data-easy-sync-plan-row]");
    for (const row of Array.from(rows)) {
      const key = row.dataset.easySyncPlanRow;
      if (!key || !row.instanceOf(HTMLDetailsElement)) continue;
      row.open = this.resolvePlanRowOpen(key, deleteRowsBatched);
    }
  }

  /**
   * Record the user's choice for one decision row. The row is about to
   * re-flow, so its cached height no longer applies.
   */
  private rememberPlanRowExpansion(key: string, open: boolean): void {
    this.planRowExpandedState.set(key, open);
    this.planRowHeights.delete(key);
    this.planRowLayoutRevision += 1;
    this.schedulePlanViewportRender();
  }

  /** Measure the mounted rows and report whether any height changed. */
  private rememberPlanRowHeights(container: HTMLElement): boolean {
    const rows = container.querySelectorAll<HTMLElement>(
      "[data-easy-sync-plan-row]",
    );
    let changed = false;
    for (const row of Array.from(rows)) {
      const key = row.dataset.easySyncPlanRow;
      if (!key) continue;
      const height = row.getBoundingClientRect().height;
      if (height <= 0 || this.planRowHeights.get(key) === height) continue;
      this.planRowHeights.set(key, height);
      changed = true;
    }
    return changed;
  }

  private resolvePlanViewportRect(): { top: number; bottom: number } {
    const content = this.contentEl.querySelector<HTMLElement>(
      ".easy-sync-view-content",
    );
    const leaf = this.contentEl.closest<HTMLElement>(".workspace-leaf-content");
    const candidate = content
      && content.clientHeight > 0
      && content.scrollHeight > content.clientHeight
      ? content
      : leaf ?? this.contentEl;
    const rect = candidate.getBoundingClientRect();
    const viewportHeight = this.contentEl.ownerDocument.defaultView?.innerHeight
      ?? rect.bottom;
    return {
      top: Math.max(0, rect.top),
      bottom: Math.min(viewportHeight, rect.bottom),
    };
  }

  private renderPlanReviewRow(
    container: HTMLElement,
    row: SyncPlanDisplayRow,
    conflictByPath: ReadonlyMap<string, SyncPlanItem>,
    deleteByPath: ReadonlyMap<string, SyncPlanItem>,
  ): void {
    const { item, pluginConflict } = row;
    if (pluginConflict) {
      this.renderBundleConflictItem(container, pluginConflict, row.key);
      return;
    }
    if (item.type === SyncActionType.Conflict && conflictByPath.has(item.path)) {
      this.renderConflictItem(container, conflictByPath.get(item.path)!, row.key);
      return;
    }
    if (item.type === SyncActionType.ConfirmLocalDelete && deleteByPath.has(item.path)) {
      this.renderDeleteItem(container, deleteByPath.get(item.path)!, row.key);
      return;
    }
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const action = resolveSyncActionPresentation(item.type);
    const rowEl = container.createDiv("easy-sync-file-row");
    rowEl.dataset.easySyncPlanRow = row.key;
    const icon = rowEl.createSpan("easy-sync-file-icon");
    setIcon(icon, action.icon);
    const pathEl = rowEl.createSpan("easy-sync-file-path");
    configureFilePath(rowEl, pathEl, item.path, true);
    if (item.reason) {
      rowEl.createDiv("easy-sync-file-reason").setText(t(item.reason));
    }
  }

  private renderConflictItem(
    container: HTMLElement,
    item: SyncPlanItem,
    rowKey?: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    if (rowKey) details.dataset.easySyncPlanRow = rowKey;
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const icon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(icon, "triangle-alert");
    const pathEl = summary.createSpan("easy-sync-tree-path");
    configureFilePath(details, pathEl, item.path, true);
    summary.createSpan("easy-sync-tree-chip").setText(t("syncView.fileStatus.conflict"));

    const body = details.createDiv("easy-sync-tree-item-body");
    body.createDiv("easy-sync-item-reason").setText(
      item.reason ? t(item.reason) : t("syncView.conflict.defaultReason"),
    );
    if (item.local || item.remote) {
      if (item.local) {
        body.createDiv("easy-sync-conflict-meta").setText(
          `${t("conflictDetail.localLabel")}：${item.local.mtime ? new Date(item.local.mtime).toLocaleString() : "-"} (${item.local.size != null ? formatSize(item.local.size) : "-"})`,
        );
      }
      if (item.remote) {
        body.createDiv("easy-sync-conflict-meta").setText(
          `${t("conflictDetail.remoteLabel")}：${item.remote.mtime ? new Date(item.remote.mtime).toLocaleString() : "-"} (${item.remote.size != null ? formatSize(item.remote.size) : "-"})`,
        );
      }
    }

    const actions = body.createDiv("easy-sync-item-actions");
    this.createActionChip(actions, t("syncView.conflict.keepLocal"), "accent", () => {
      void this.runItemAction(actions, () => this.plugin.resolveConflictKeepLocal(item.path));
    });
    this.createActionChip(actions, t("syncView.conflict.keepRemote"), "accent", () => {
      void this.runItemAction(actions, () => this.plugin.resolveConflictKeepRemote(item.path));
    });
    this.createActionChip(actions, t("syncView.conflict.viewDetail"), "", () => {
      const modal = new ConflictDetailModal(this.plugin, item);
      modal.setOnResolved(() => {
        this.plugin.updateStatusBar();
        this.render();
      });
      modal.open();
    });
  }

  private renderBundleConflictItem(
    container: HTMLElement,
    bundle: { pluginId: string; items: readonly SyncPlanItem[] },
    rowKey?: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    // EasySync's own three files reuse this one-row shape so the user sees
    // what the config paths are, but without the bundle review modal: that
    // chain is community-plugin owned and refuses this plugin's directory.
    // The members keep their existing per-file choices underneath.
    const ownBundle = bundle.pluginId === "easy-sync";
    const details = container.createEl("details", "easy-sync-tree-item");
    if (rowKey) details.dataset.easySyncPlanRow = rowKey;
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const icon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(icon, "blocks");
    summary.createSpan("easy-sync-tree-path").setText(
      ownBundle ? t("syncView.selfBundleReview.title") : bundle.pluginId,
    );
    summary.createSpan("easy-sync-tree-chip").setText(
      t("syncView.fileStatus.conflict"),
    );
    const body = details.createDiv("easy-sync-tree-item-body");
    body.createDiv("easy-sync-item-reason").setText(
      t(
        ownBundle
          ? "syncView.selfBundleReview.conflictSummary"
          : "syncView.pluginBundleReview.conflictSummary",
        { count: bundle.items.length },
      ),
    );
    if (ownBundle) {
      for (const item of bundle.items) {
        this.renderConflictItem(body, item, `conflict:${item.path}`);
      }
      return;
    }
    const actions = body.createDiv("easy-sync-item-actions");
    this.createActionChip(
      actions,
      t("syncView.pluginBundleReview.open"),
      "accent",
      () => {
        void this.openCommunityPluginBundleReview(bundle.pluginId);
      },
    );
  }

  /**
   * One pending new-plugin / reappeared-plugin decision row (slice 2). It uses
   * the same collapsible tree-item shape as the other pending rows (details +
   * collapse icon + summary chips + expandable body with action chips), so the
   * sidebar keeps one consistent format (2026-09-09 用户反馈：原扁平行与其
   * 它行格式对不上). The two chips execute directly — no expand step, no
   * confirmation dialog. The desktop-only marker only appears on desktop;
   * mobile never receives those bundles.
   */
  private renderAdoptionItem(
    container: HTMLElement,
    row: CommunityPluginAdoptionRow,
    rowKey?: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    if (rowKey) details.dataset.easySyncPlanRow = rowKey;
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const icon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(icon, "blocks");
    const nameEl = summary.createSpan("easy-sync-tree-path");
    nameEl.setText(row.displayName);
    nameEl.setAttribute("aria-label", row.displayName);
    setTooltip(nameEl, row.displayName);
    summary.createSpan("easy-sync-tree-chip").setText(
      t("syncView.adoption.chip"),
    );
    if (row.desktopOnly) {
      summary.createSpan("easy-sync-tree-chip").setText(
        t("syncView.adoption.desktopOnly"),
      );
    }
    const body = details.createDiv("easy-sync-tree-item-body");
    body.createDiv("easy-sync-item-reason").setText(
      t("syncView.adoption.reason"),
    );
    const actions = body.createDiv("easy-sync-item-actions");
    this.createActionChip(
      actions,
      t("syncView.adoption.download"),
      "accent",
      () => {
        void this.runItemAction(
          actions,
          () => this.plugin.downloadCommunityPluginAdoption(row.pluginId),
        );
      },
    );
    this.createActionChip(actions, t("syncView.adoption.skip"), "", () => {
      void this.runItemAction(
        actions,
        () => this.plugin.skipCommunityPluginAdoption(row.pluginId),
      );
    });
  }

  private renderDeleteItem(
    container: HTMLElement,
    item: SyncPlanItem,
    rowKey?: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    if (rowKey) details.dataset.easySyncPlanRow = rowKey;
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const icon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(icon, "trash-2");
    const pathEl = summary.createSpan("easy-sync-tree-path");
    configureFilePath(details, pathEl, item.path, true);
    summary.createSpan("easy-sync-tree-chip").setText(
      t("syncView.fileStatus.pendingConfirmation"),
    );

    const body = details.createDiv("easy-sync-tree-item-body");
    body.createDiv("easy-sync-item-reason").setText(t("syncView.delete.reason"));
    const actions = body.createDiv("easy-sync-item-actions");
    this.createActionChip(actions, t("syncView.delete.confirm"), "warning", () => {
      void this.runItemAction(actions, () => this.plugin.confirmRemoteDelete(item.path));
    });
    this.createActionChip(actions, t("syncView.delete.reject"), "", () => {
      void this.runItemAction(actions, () => this.plugin.rejectRemoteDelete(item.path));
    });
  }

  private createSection(container: HTMLElement, title: string): HTMLElement {
    const section = container.createDiv("easy-sync-section");
    section.createEl("h4", { cls: "easy-sync-section-title", text: title });
    return section.createDiv("easy-sync-section-body easy-sync-section-content");
  }

  private createTreeGroup(
    container: HTMLElement,
    title: string,
    count: number,
    open: boolean,
  ): HTMLElement {
    const details = container.createEl("details", "easy-sync-tree-item");
    details.open = open;
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    summary.createSpan("easy-sync-tree-label").setText(title);
    summary.createSpan("easy-sync-tree-count").setText(String(count));
    return details.createDiv("easy-sync-tree-group-body");
  }

  private addCollapseIcon(container: HTMLElement): void {
    const icon = container.createSpan("easy-sync-collapse-icon");
    setIcon(icon, "chevron-right");
  }

  private createActionChip(
    container: HTMLElement,
    text: string,
    variant: "" | "accent" | "warning",
    onClick: () => void,
  ): HTMLButtonElement {
    const chip = container.createEl("button", {
      cls: `easy-sync-action-chip${variant ? ` is-${variant}` : ""}`,
      attr: { type: "button" },
      text,
    });
    chip.addEventListener("click", onClick);
    return chip;
  }

  private disableActionButtons(actionsEl: HTMLElement): void {
    for (const button of Array.from(actionsEl.querySelectorAll("button"))) {
      (button).disabled = true;
    }
  }

  private enableActionButtons(actionsEl: HTMLElement): void {
    for (const button of Array.from(actionsEl.querySelectorAll("button"))) {
      (button).disabled = false;
    }
  }

  private async runItemAction(
    actionsEl: HTMLElement,
    action: () => Promise<unknown>,
  ): Promise<void> {
    this.disableActionButtons(actionsEl);
    // A windowed decision row is pinned while its action settles: scrolling the
    // window out from under it would take away the row the user is waiting on.
    const rowKey = actionsEl.closest<HTMLElement>("[data-easy-sync-plan-row]")
      ?.dataset.easySyncPlanRow;
    if (rowKey) this.planDecisionRowsInFlight.add(rowKey);
    try {
      await action();
    } finally {
      if (rowKey) this.planDecisionRowsInFlight.delete(rowKey);
      // The row is usually still mounted — the window was frozen — so restore
      // the controls here instead of waiting for a remount that may not come.
      this.enableActionButtons(actionsEl);
      this.plugin.updateStatusBar();
      this.render();
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024 * 1024)).toFixed(1)} MB`;
}
