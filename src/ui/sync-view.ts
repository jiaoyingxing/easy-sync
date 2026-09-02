import {
  ButtonComponent,
  ItemView,
  Notice,
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
import type EasySyncPlugin from "../main";
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
import { ConfirmModal } from "./confirm-modal";
import { applyDestructiveButton } from "./destructive-button";
import { EmptyFolderResolutionModal } from "./empty-folder-resolution-modal";
import { ConflictDetailModal } from "./conflict-detail-modal";
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
import {
  resolveSyncActivityPresentation,
  translateSyncActivity,
} from "./sync-status-presentation";

interface StatusPanelState {
  isLoggedIn: boolean;
  isInitializing: boolean;
  isPending: boolean;
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
}): SyncViewBodyMode {
  if (input.planReviewActive && input.hasSyncState) return "plan";
  if (input.fullSyncRunning) return "progress";
  if (input.pendingCount > 0) return "pending";
  if (input.sideActionResultsVisible) return "progress";
  if (input.mutationRecoveryVisible) return "recovery";
  if (input.remoteScopeRecoveryFailureVisible) return "progress";
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
  isRunning: boolean;
  canCancel: boolean;
  bodyMode: SyncViewBodyMode;
  progress: Readonly<SyncProgressState>;
  planReviewActive: boolean;
  planReviewDetailsState: "ready" | "recovering" | "retry";
  pendingIssues: PendingIssue[];
  conflicts: SyncPlanItem[];
  pendingDeletes: SyncPlanItem[];
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
  return issues.map((issue, index) => ({ issue, index }))
    .filter(({ issue, index }) =>
      issue.issueCode !== "anchored-folder-missing-local"
        || !issues.some((candidate, candidateIndex) =>
          candidateIndex !== index
            && candidate.issueCode === "anchored-folder-missing-local"
            && isNestedPath(issue.path, candidate.path),
        ),
    )
    .map(({ issue }) => ({
      issue,
      nestedIssues: issue.issueCode === "anchored-folder-missing-local"
        ? issues.filter((candidate) =>
          candidate !== issue
            && candidate.issueCode === "anchored-folder-missing-local"
            && isNestedPath(candidate.path, issue.path),
        )
        : [],
    }));
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

export function buildCompletedFilesRenderState(
  files: readonly Pick<FileProgress, "path" | "sourcePath" | "status" | "actionType" | "reason">[],
): { key: string } {
  return {
    key: files
      .map((file) => `${file.path}\u0000${file.sourcePath ?? ""}\u0000${file.status}\u0000${file.actionType ?? ""}\u0000${file.reason ?? ""}`)
      .join("\u0001"),
  };
}

export interface SyncPlanDisplayGroup {
  group: SyncActionGroup;
  labelKey: keyof LocaleStrings;
  open: boolean;
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
      open: false,
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

export function formatPendingIssueActionLabel(
  actionType: SyncActionType,
  t: (key: string) => string,
): string {
  return t(
    actionType === SyncActionType.RetryLater
      || actionType === SyncActionType.FolderDeferred
      ? "syncView.issues.recheck"
      : "syncView.issues.retry",
  );
}

export type CommunityPluginConflictReviewEntry =
  | { kind: "file"; item: SyncPlanItem }
  | {
      kind: "community-plugin-bundle";
      pluginId: string;
      items: SyncPlanItem[];
    };

/** Preserve first-seen order while presenting one decision per plugin bundle. */
export function groupCommunityPluginConflictReviews(
  conflicts: readonly SyncPlanItem[],
  configDir: string,
): CommunityPluginConflictReviewEntry[] {
  const pluginItems = new Map<string, SyncPlanItem[]>();
  for (const item of conflicts) {
    const parsed = parseCommunityPluginBundlePath(item.path, configDir);
    if (!parsed || parsed.pluginId === "easy-sync") continue;
    const items = pluginItems.get(parsed.pluginId) ?? [];
    items.push(item);
    pluginItems.set(parsed.pluginId, items);
  }
  const emitted = new Set<string>();
  const result: CommunityPluginConflictReviewEntry[] = [];
  for (const item of conflicts) {
    const parsed = parseCommunityPluginBundlePath(item.path, configDir);
    if (!parsed || parsed.pluginId === "easy-sync") {
      result.push({ kind: "file", item });
      continue;
    }
    if (emitted.has(parsed.pluginId)) continue;
    emitted.add(parsed.pluginId);
    result.push({
      kind: "community-plugin-bundle",
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
  const authKey = `auth:${input.isInitializing ? 1 : 0}:${input.isLoggedIn ? 1 : 0}:${input.isPending ? 1 : 0}`;
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
    const issues = groupPendingIssuesForReview(input.pendingIssues)
      .map(({ issue, nestedIssues }) =>
        `${issue.actionType}:${issue.issueCode ?? ""}:${issue.path}:${issue.updatedAt}:${issue.reason ?? ""}:nested:${nestedIssues.map((nested) => nested.path).join(",")}`)
      .join("|");
    const conflicts = input.conflicts
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    const deletes = input.pendingDeletes
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    return `pending:${authKey}:${runKey}:${recoveryKey}:${issues}:${conflicts}:${deletes}:${historyKey}`;
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
): void {
  const row = list.createDiv("easy-sync-file-row");
  const icon = row.createSpan("easy-sync-file-icon");
  const presentation = resolveFileProgressPresentation(file);
  setIcon(icon, presentation.icon);
  const pathEl = row.createSpan("easy-sync-file-path");
  configureFilePath(row, pathEl, file.path, adaptive);
  const chipLabel = formatFileProgressLabel(file, t);
  if (chipLabel) row.createSpan("easy-sync-tree-chip").setText(chipLabel);
  if (file.reason) row.createDiv("easy-sync-file-reason").setText(file.reason);
}

export function shouldExpandAllVisibleDetails(
  openStates: readonly boolean[],
): boolean {
  return openStates.some((open) => !open);
}

export class EasySyncSyncView extends ItemView {
  plugin: EasySyncPlugin;
  private historyExpanded = false;
  private allCollapsed = false;
  private planGroupsCollapsed = true;
  private planExpandedGroups = new Set<SyncActionGroup>();
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
  private completedFilesRenderKey: string | null = null;
  private planViewportFrameId: AnimationFrameHandle | null = null;
  private planVirtualRenderers = new Set<() => void>();
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
  private mutationRecoveryResolutionOpening = false;
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
    this.contentEl.addEventListener(
      "toggle",
      this.handlePathLayoutToggle,
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
    this.contentEl.removeEventListener(
      "toggle",
      this.handlePathLayoutToggle,
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
    const conflicts = (syncState?.pendingConflicts ?? [])
      .filter((item) => !this.plugin.syncExecutor?.isSideActionQueued(item.path));
    const pendingDeletes = (syncState?.pendingRemoteDeletes ?? [])
      .filter((item) => !this.plugin.syncExecutor?.isSideActionQueued(item.path));
    const pendingIssues = syncState?.pendingIssues ?? [];
    const pendingIssueGroups = groupPendingIssuesForReview(pendingIssues);
    const planReviewActive = syncState?.planReviewActive ?? false;
    const pendingCount = pendingIssueGroups.length + conflicts.length
      + pendingDeletes.length;
    const sideActionResultsVisible = progress.activityKind === "sideAction"
      && (sideActionRunning || progress.completedFiles.length > 0);
    const mutationRecovery = this.plugin.getMutationRecoveryDisplayState();
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
        this.planGroupsCollapsed = true;
        this.planExpandedGroups.clear();
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
      isRunning,
      canCancel,
      bodyMode,
      progress,
      planReviewActive,
      planReviewDetailsState,
      pendingIssues,
      conflicts,
      pendingDeletes,
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
      this.completedFilesRenderKey = null;
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
          pendingIssues,
          conflicts,
          pendingDeletes,
        );
      } else if (bodyMode === "recovery" && mutationRecovery) {
        this.renderMutationRecoverySection(content, mutationRecovery);
      }

      if (this.historyExpanded) {
        this.renderHistorySection(content, syncState?.syncHistory ?? []);
      }

      // Re-apply the toolbar state while retaining groups the user opened in
      // this exact reviewed revision.
      this.toggleAllDetails();
      this.updateCollapseTogglePresentation();
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
      }
    }
  }

  private appendNewFileRows(files: readonly FileProgress[]): void {
    if (files.length === 0 || !this.progressPanelEl) return;
    if (!this.fileListEl) {
      this.progressSubtitleEl = this.progressPanelEl.createDiv("easy-sync-progress-subtitle");
      this.progressSubtitleEl.setText(
        this.plugin.i18n.t("syncView.progress.completed", {
          count: this.plugin.progressStore.state.completedCount,
        }),
      );
    }
    const nextState = buildCompletedFilesRenderState(files);
    if (!this.fileListEl
      || this.completedFilesRenderKey !== nextState.key) {
      // ponytail: the visible list is capped, so a small rebuild is simpler than keeping a drifting incremental cache
      this.fileListEl?.remove();
      this.fileListEl = null;
      this.renderFileResults(this.progressPanelEl, [...files], true);
    }
    this.progressSubtitleEl?.setText(
      this.plugin.i18n.t("syncView.progress.completed", {
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

    this.renderCollapseToggle(buttons);
  }

  private renderCollapseToggle(container: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const shouldExpand = this.shouldExpandAllDetails();
    const icon = shouldExpand ? "chevrons-up-down" : "chevrons-down-up";
    const label = shouldExpand ? t("syncView.expandAll") : t("syncView.collapseAll");

    this.collapseToggleButtonEl = this.createIconButton(container, icon, label, () => {
      const expand = this.shouldExpandAllDetails();
      if (this.renderedBodyMode === "plan") {
        this.planGroupsCollapsed = !expand;
        this.planExpandedGroups.clear();
      } else {
        this.allCollapsed = !expand;
      }
      this.toggleAllDetails();
      this.updateCollapseTogglePresentation();
    });
  }

  private isCollapseOverrideActive(): boolean {
    return this.renderedBodyMode === "plan"
      ? this.planGroupsCollapsed
      : this.allCollapsed;
  }

  private shouldExpandAllDetails(): boolean {
    const details = [
      ...this.contentEl.querySelectorAll<HTMLDetailsElement>(
        ".easy-sync-tree-item",
      ),
    ];
    if (details.length === 0) return this.isCollapseOverrideActive();
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
    const details = this.contentEl.querySelectorAll<HTMLDetailsElement>(".easy-sync-tree-item");
    if (this.isCollapseOverrideActive()) {
      const expandedPlanGroups = new Set(this.planExpandedGroups);
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
    if (state.isInitializing) {
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
    // The latest round may be a retry-pending observation (network unavailable
    // before ordinary planning). That overrides the stale "synced" green from
    // the last healthy round: show an offline hint instead of implying the
    // vault is currently in sync. The next healthy round returns to success.
    if (
      status === "success"
      && state.latestHistory?.status === "retry-pending"
    ) {
      return { status: "offline", label: t("syncView.status.offline") };
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
    // Honest next-step line for every state: real-decision pointers where a
    // decision exists, otherwise status plus the diagnostics / forced-reset
    // guidance. The abandon escape hatch was removed; the single last-resort
    // exit lives on the reset flow (informed forced reset).
    section.createDiv("easy-sync-recovery-next-step").setText(
      presentation.nextStep,
    );
  }

  private renderPendingSection(
    container: HTMLElement,
    issues: PendingIssue[],
    conflicts: SyncPlanItem[],
    pendingDeletes: SyncPlanItem[],
  ): void {
    const section = container
      .createDiv("easy-sync-section")
      .createDiv("easy-sync-section-body");
    section.addClass("easy-sync-path-layout");
    const groupedIssues = groupPendingIssuesForReview(issues);
    const skipped = groupedIssues.filter(({ issue }) =>
      issue.actionType === SyncActionType.SkipLargeFile
      || issue.actionType === SyncActionType.SkipIgnoredPath
      || issue.actionType === SyncActionType.SkipOneDriveInvalidName);
    const failures = groupedIssues.filter(({ issue }) =>
      issue.actionType !== SyncActionType.SkipLargeFile
      && issue.actionType !== SyncActionType.SkipIgnoredPath
      && issue.actionType !== SyncActionType.SkipOneDriveInvalidName);

    for (const { issue, nestedIssues } of failures) {
      this.renderPendingIssue(section, issue, true, nestedIssues);
    }
    for (const entry of groupCommunityPluginConflictReviews(
      conflicts,
      getConfigDir(this.plugin.app.vault),
    )) {
      if (entry.kind === "file") {
        this.renderConflictItem(section, entry.item);
      } else {
        this.renderCommunityPluginConflictItem(
          section,
          entry.pluginId,
          entry.items.length,
        );
      }
    }
    if (pendingDeletes.length > 1) {
      const t = this.plugin.i18n.t.bind(this.plugin.i18n);
      const paths = pendingDeletes.map((item) => item.path);
      const actions = section.createDiv("easy-sync-plan-execute");
      actions.addClass("easy-sync-primary-actions");
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
            // 删除期间侧栏整块重建会销毁本按钮，重建后的按钮由下方
            // batchDeleteInFlight 分支重新挂类，因此加载态可持续到整批结束。
            confirmAllButton.buttonEl.addClass("mod-loading");
            confirmAllButton.setDisabled(true);
            await this.plugin.confirmRemoteDeletes(paths);
          });
        });
      // 重建后恢复加载态：批量删除仍在队列/执行中时，按钮保持官方旋转
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
    for (const item of pendingDeletes) this.renderDeleteItem(section, item);
    for (const { issue, nestedIssues } of skipped) {
      this.renderPendingIssue(section, issue, false, nestedIssues);
    }
  }

  private renderPendingIssue(
    container: HTMLElement,
    issue: PendingIssue,
    retryable: boolean,
    nestedIssues: readonly PendingIssue[] = [],
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const action = resolveSyncActionPresentation(issue.actionType);
    const actionIcon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(actionIcon, action.icon);
    const pathEl = summary.createSpan("easy-sync-tree-path");
    configureFilePath(details, pathEl, issue.path, true);
    const chipLabel = formatPendingIssueChipLabel(issue.actionType, t);
    if (chipLabel) summary.createSpan("easy-sync-tree-chip").setText(chipLabel);

    const body = details.createDiv("easy-sync-tree-item-body");
    if (issue.reason) body.createDiv("easy-sync-item-reason").setText(issue.reason);
    if (nestedIssues.length > 0) {
      body.createDiv("easy-sync-item-reason").setText(
        t("syncView.folderSubtree.affectedFolders", {
          count: nestedIssues.length + 1,
        }),
      );
    }
    body.createDiv("easy-sync-item-time").setText(
      t("syncView.issues.lastAttempt", {
        time: new Date(issue.updatedAt).toLocaleString(),
      }),
    );
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
      this.createActionChip(actions, formatPendingIssueActionLabel(
        issue.actionType,
        t,
      ), "accent", () => {
        void this.plugin.startManualSync();
      });
    }
  }

  private async openStaleIdentityResolution(path: string): Promise<void> {
    if (this.staleIdentityResolutionOpening) return;
    this.staleIdentityResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const snapshot =
        await this.plugin.getStaleIdentityResolutionSnapshot(path);
      if (!snapshot) {
        new Notice(t("notice.staleIdentity.changed", { path }));
        return;
      }
      const confirmed = await new ConfirmModal(
        this.plugin.app,
        t("syncView.staleIdentity.confirmTitle"),
        null,
        t("syncView.staleIdentity.confirm"),
        t("confirm.cancel"),
        t,
        {
          message: t(
            snapshot.kind === "folder-missing-remote"
              ? "syncView.staleIdentity.folderMessage"
              : "syncView.staleIdentity.fileMessage",
            { path },
          ),
        },
      ).awaitConfirm();
      if (!confirmed) return;
      await this.plugin.retireReviewedStaleIdentity(snapshot);
    } finally {
      this.staleIdentityResolutionOpening = false;
    }
  }

  private async openSharedFolderIdentityResolution(path: string): Promise<void> {
    if (this.sharedFolderIdentityResolutionOpening) return;
    this.sharedFolderIdentityResolutionOpening = true;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      const snapshot =
        await this.plugin.getSharedFolderIdentityResolutionSnapshot(path);
      if (!snapshot) {
        new Notice(t("notice.sharedFolderIdentity.changed", { path }));
        return;
      }
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
      await this.plugin.confirmReviewedSharedFolderIdentity(snapshot);
    } finally {
      this.sharedFolderIdentityResolutionOpening = false;
    }
  }

  private async openEmptyFolderResolution(path: string): Promise<void> {
    if (this.emptyFolderResolutionOpening) return;
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
    }
  }

  private async openFolderLocationResolution(path: string): Promise<void> {
    if (this.emptyFolderResolutionOpening) return;
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
    }
  }

  private async openMutationRecoveryResolution(): Promise<void> {
    if (this.mutationRecoveryResolutionOpening) return;
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
      await this.plugin.resolveMutationRecovery(snapshot, choice);
    } finally {
      this.mutationRecoveryResolutionOpening = false;
    }
  }

  private async openCommunityPluginBundleReview(pluginId: string): Promise<void> {
    if (this.mutationRecoveryResolutionOpening) return;
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
      await this.plugin.resolveMutationRecovery(snapshot, choice);
    } finally {
      this.mutationRecoveryResolutionOpening = false;
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
      details.open = index === 0 && entry.status !== "success";
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
        this.renderFileResults(body, entry.files, false);
      }
      const omitted = countOmittedSyncHistorySuccessfulFiles(entry);
      if (omitted > 0) {
        body.createDiv("easy-sync-history-omitted").setText(
          t("syncView.history.omitted", { count: omitted }),
        );
      }
    });
  }

  private renderFileResults(
    container: HTMLElement,
    files: FileProgress[],
    limitHeight: boolean,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const renderState = buildCompletedFilesRenderState(files);
    const list = container.createDiv("easy-sync-file-list");
    const renderedPaths = new Set<string>();
    if (limitHeight) {
      list.addClass("is-limited");
      list.addClass("easy-sync-path-layout");
      this.fileListEl = list;
      this.completedFilesRenderKey = renderState.key;
    }

    // Iterate in reverse (newest first)
    for (let i = files.length - 1; i >= 0; i--) {
      if (limitHeight && renderedPaths.has(files[i].path)) continue;
      renderedPaths.add(files[i].path);
      renderFileRow(files[i], list, t, limitHeight);
    }
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
    for (const entry of groupCommunityPluginConflictReviews(
      conflicts,
      getConfigDir(this.plugin.app.vault),
    )) {
      if (entry.kind !== "community-plugin-bundle") continue;
      for (const item of entry.items) pluginConflictByPath.set(item.path, entry);
    }
    const renderedPluginConflicts = new Set<string>();
    const groups = buildSyncPlanDisplayGroups(items);

    for (const group of groups) {
      const open = !this.planGroupsCollapsed
        || this.planExpandedGroups.has(group.group);
      const body = this.createTreeGroup(
        container,
        t(group.labelKey),
        group.items.length,
        open,
      );
      body.addClass("easy-sync-path-layout");
      const details = body.parentElement as HTMLDetailsElement;
      details.dataset.easySyncPlanGroup = group.group;
      details.addEventListener("toggle", () => {
        if (details.open) this.planExpandedGroups.add(group.group);
        else this.planExpandedGroups.delete(group.group);
      });
      const hasInlineDecisions = group.items.some((item) =>
        item.type === SyncActionType.Conflict
        || item.type === SyncActionType.ConfirmLocalDelete);
      if (hasInlineDecisions) {
        let rendered = false;
        const renderInlineDecisions = (): void => {
          if (!details.open || rendered) return;
          rendered = true;
          for (const item of group.items) {
            this.renderPlanReviewItem(
              body,
              item,
              conflictByPath,
              deleteByPath,
              pluginConflictByPath,
              renderedPluginConflicts,
            );
          }
          this.applyPlanDetailsExpandOverride(body);
          this.scheduleAdaptivePathLayout();
        };
        details.addEventListener("toggle", renderInlineDecisions);
        renderInlineDecisions();
        continue;
      }

      const virtualList = body.createDiv("easy-sync-plan-virtual-list");
      let virtualOffsets: number[] | null = null;
      let renderedKey = "";
      const renderWindow = (): void => {
        if (!details.open) {
          if (renderedKey) virtualList.empty();
          renderedKey = "";
          return;
        }
        if (!virtualOffsets) {
          const rowHeights = this.measurePlanRowHeights(body);
          virtualOffsets = buildSyncPlanVirtualOffsets(
            group.items,
            rowHeights.rowHeight,
            rowHeights.reasonRowHeight,
          );
          virtualList.style.height = `${virtualOffsets[virtualOffsets.length - 1] ?? 0}px`;
        }
        const listRect = virtualList.getBoundingClientRect();
        const viewportRect = this.resolvePlanViewportRect();
        const windowState = buildSyncPlanVirtualWindow({
          offsets: virtualOffsets,
          listTop: listRect.top,
          viewportTop: viewportRect.top,
          viewportBottom: viewportRect.bottom,
        });
        const nextKey = `${windowState.start}:${windowState.end}`;
        if (nextKey === renderedKey) return;
        renderedKey = nextKey;
        virtualList.empty();
        if (windowState.end <= windowState.start) return;
        const visible = virtualList.createDiv("easy-sync-plan-virtual-window");
        visible.style.transform = `translateY(${windowState.offset}px)`;
        for (let index = windowState.start; index < windowState.end; index++) {
          this.renderPlanReviewItem(
            visible,
            group.items[index],
            conflictByPath,
            deleteByPath,
            pluginConflictByPath,
            renderedPluginConflicts,
          );
        }
        this.scheduleAdaptivePathLayout();
      };
      this.planVirtualRenderers.add(renderWindow);
      details.addEventListener("toggle", renderWindow);
      renderWindow();
    }
  }

  private applyPlanDetailsExpandOverride(container: HTMLElement): void {
    if (this.planGroupsCollapsed) return;
    const details = container.querySelectorAll<HTMLDetailsElement>(
      ".easy-sync-tree-item",
    );
    for (const detail of details) detail.setAttribute("open", "");
    this.updateCollapseTogglePresentation();
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
    probe.createDiv("easy-sync-file-reason").setText("measure");
    const reasonRowHeight = probe.getBoundingClientRect().height;
    probe.remove();
    return {
      rowHeight: rowHeight > 0 ? rowHeight : 20,
      reasonRowHeight: reasonRowHeight > 0 ? reasonRowHeight : 42,
    };
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

  private renderPlanReviewItem(
    container: HTMLElement,
    item: PlanReviewItem,
    conflictByPath: ReadonlyMap<string, SyncPlanItem>,
    deleteByPath: ReadonlyMap<string, SyncPlanItem>,
    pluginConflictByPath: ReadonlyMap<string, {
      pluginId: string;
      items: SyncPlanItem[];
    }>,
    renderedPluginConflicts: Set<string>,
  ): void {
    if (item.type === SyncActionType.Conflict && conflictByPath.has(item.path)) {
      const pluginConflict = pluginConflictByPath.get(item.path);
      if (pluginConflict) {
        if (renderedPluginConflicts.has(pluginConflict.pluginId)) return;
        renderedPluginConflicts.add(pluginConflict.pluginId);
        this.renderCommunityPluginConflictItem(
          container,
          pluginConflict.pluginId,
          pluginConflict.items.length,
        );
        return;
      }
      this.renderConflictItem(container, conflictByPath.get(item.path)!);
      return;
    }
    if (item.type === SyncActionType.ConfirmLocalDelete && deleteByPath.has(item.path)) {
      this.renderDeleteItem(container, deleteByPath.get(item.path)!);
      return;
    }
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const action = resolveSyncActionPresentation(item.type);
    const row = container.createDiv("easy-sync-file-row");
    const icon = row.createSpan("easy-sync-file-icon");
    setIcon(icon, action.icon);
    const pathEl = row.createSpan("easy-sync-file-path");
    configureFilePath(row, pathEl, item.path, true);
    if (item.reason) {
      row.createDiv("easy-sync-file-reason").setText(t(item.reason));
    }
  }

  private renderConflictItem(container: HTMLElement, item: SyncPlanItem): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
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

  private renderCommunityPluginConflictItem(
    container: HTMLElement,
    pluginId: string,
    memberCount: number,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const icon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(icon, "blocks");
    summary.createSpan("easy-sync-tree-path").setText(pluginId);
    summary.createSpan("easy-sync-tree-chip").setText(
      t("syncView.fileStatus.conflict"),
    );
    const body = details.createDiv("easy-sync-tree-item-body");
    body.createDiv("easy-sync-item-reason").setText(
      t("syncView.pluginBundleReview.conflictSummary", { count: memberCount }),
    );
    const actions = body.createDiv("easy-sync-item-actions");
    this.createActionChip(
      actions,
      t("syncView.pluginBundleReview.open"),
      "accent",
      () => {
        void this.openCommunityPluginBundleReview(pluginId);
      },
    );
  }

  private renderDeleteItem(container: HTMLElement, item: SyncPlanItem): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
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

  private async runItemAction(
    actionsEl: HTMLElement,
    action: () => Promise<unknown>,
  ): Promise<void> {
    this.disableActionButtons(actionsEl);
    try {
      await action();
    } finally {
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
