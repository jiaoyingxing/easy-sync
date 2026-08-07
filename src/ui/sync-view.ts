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
  type AnimationFrameHandle,
} from "../obsidian-compat";
import type EasySyncPlugin from "../main";
import { SyncActionType } from "../sync/types";
import type { PlanReviewItem, SyncPlanItem } from "../sync/types";
import type { LocaleStrings } from "../i18n/types";
import {
  resolveSyncActionPresentation,
  type SyncActionGroup,
} from "../sync/sync-action-presentation";
import {
  type FileProgress,
  isAnySyncActivityRunning,
  type SyncProgressState,
} from "../sync/sync-progress";
import type { PendingIssue, SyncHistoryEntry } from "../sync/state-manager";
import { ConfirmModal } from "./confirm-modal";
import { EmptyFolderResolutionModal } from "./empty-folder-resolution-modal";
import { MutationRecoveryResolutionModal } from "./mutation-recovery-resolution-modal";
import { ConflictDetailModal } from "./conflict-detail-modal";
import {
  RIBBON_STATUS_ICONS,
  resolveRibbonStatus,
  type RibbonStatus,
} from "./ribbon-status";
import {
  resolveSyncActivityPresentation,
  translateSyncActivity,
} from "./sync-status-presentation";
import {
  handleAuthEntryAction,
  resolveAuthEntryPresentation,
} from "./auth-entry-flow";
import {
  formatMutationRecoveryHistory,
  mutationRecoveryStatusDetail,
  mutationRecoveryStatusLabel,
  type MutationRecoveryDisplayState,
} from "./mutation-recovery-presentation";
import { resolveSyncPendingAttentionCounts } from "./sync-result-presentation";

interface StatusPanelState {
  isLoggedIn: boolean;
  isInitializing: boolean;
  isPending: boolean;
  isRunning: boolean;
  canCancel: boolean;
  lastSyncTime: number;
  pendingCount: number;
  planReviewActive: boolean;
  autoSyncPaused: boolean;
  mutationRecovery: MutationRecoveryDisplayState | null;
  latestHistory?: SyncHistoryEntry;
  progress: Readonly<SyncProgressState>;
}

type SyncViewBodyMode = "plan" | "progress" | "pending" | "idle";

export function resolveSyncViewBodyMode(input: {
  planReviewActive: boolean;
  hasSyncState: boolean;
  fullSyncRunning: boolean;
  pendingCount: number;
  sideActionResultsVisible: boolean;
}): SyncViewBodyMode {
  if (input.planReviewActive && input.hasSyncState) return "plan";
  if (input.fullSyncRunning) return "progress";
  if (input.pendingCount > 0) return "pending";
  if (input.sideActionResultsVisible) return "progress";
  return "idle";
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
  pendingIssues: PendingIssue[];
  conflicts: SyncPlanItem[];
  pendingDeletes: SyncPlanItem[];
  communityPluginEnablementPending: number;
  planReviewCounts: { uploads: number; downloads: number; folders?: number; deletes: number; conflicts: number; skipped: number } | null;
  planReviewItems: PlanReviewItem[];
  history: SyncHistoryEntry[];
  lastSyncTime: number;
  mutationRecovery: MutationRecoveryDisplayState | null;
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
      open: presentation.group !== "upload"
        && presentation.group !== "deferred"
        && presentation.group !== "skip",
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
    const attention = entry.attention
      ? `${entry.attention.reason}:${entry.attention.count}`
      : "";
    const scopeRecoveryKey = scopeRecovery
      ? `${scopeRecovery.operationFingerprint}:${scopeRecovery.protocolPreflight}:${scopeRecovery.total}:${scopeRecovery.verifiedThisRun}:${scopeRecovery.reused}:${scopeRecovery.invalidated}:${scopeRecovery.remaining}:${scopeRecovery.failureStage ?? ""}:${scopeRecovery.firstFailurePath ?? ""}`
      : "";
    return itemRecovery
      ? `${entry.id}:${entry.status}:${itemRecovery.state}:${itemRecovery.total}:${itemRecovery.settled}:${itemRecovery.remaining}:${itemRecovery.retryAt ?? ""}:${itemRecovery.blockReason ?? ""}:${attention}:${scopeRecoveryKey}`
      : `${entry.id}:${entry.status}:${attention}:${scopeRecoveryKey}`;
  }).join("|");
  const historyKey = historyExpanded ? `history:open:${historyIds}` : "history:closed";
  if (input.bodyMode === "plan") {
    const counts = input.planReviewCounts
      ? `${input.planReviewCounts.uploads},${input.planReviewCounts.downloads},${input.planReviewCounts.folders ?? 0},${input.planReviewCounts.deletes},${input.planReviewCounts.conflicts},${input.planReviewCounts.skipped}`
      : "";
    const items = input.planReviewItems
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    return `plan:${authKey}:${runKey}:${recoveryKey}:${counts}:${items}:${historyKey}`;
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
    const issues = input.pendingIssues
      .map((issue) => `${issue.actionType}:${issue.issueCode ?? ""}:${issue.path}:${issue.updatedAt}:${issue.reason ?? ""}`)
      .join("|");
    const conflicts = input.conflicts
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    const deletes = input.pendingDeletes
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    return `pending:${authKey}:${runKey}:${recoveryKey}:community-plugins:${input.communityPluginEnablementPending}:${issues}:${conflicts}:${deletes}:${historyKey}`;
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

export class EasySyncSyncView extends ItemView {
  plugin: EasySyncPlugin;
  private historyExpanded = false;
  private allCollapsed = false;
  // P0: incremental render — frame merging + diffed file list
  private renderFrameId: AnimationFrameHandle | null = null;
  private lastContentKey: string | null = null;
  // Cached DOM refs for direct progress-bar updates
  private progressPanelEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressSubtitleEl: HTMLElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private completedFilesRenderKey: string | null = null;
  private pathLayoutFrameId: AnimationFrameHandle | null = null;
  private pathLayoutObserver: ResizeObserver | null = null;
  private pathLayoutObservedWidth = -1;
  private statusLineEl: HTMLElement | null = null;
  private statusIconEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private statusCounterEl: HTMLElement | null = null;
  private statusDetailEl: HTMLElement | null = null;
  private currentFileTextEl: HTMLElement | null = null;
  private currentByteProgressEl: HTMLElement | null = null;
  private statusDetailMode:
    "timestamp" | "current-file" | "recovery" | "scope-recovery" | null = null;
  private emptyFolderResolutionOpening = false;
  private sharedFolderIdentityResolutionOpening = false;
  private staleIdentityResolutionOpening = false;
  private mutationRecoveryResolutionOpening = false;

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
    await this.plugin.ensureStateLoaded();
    this.contentEl.addEventListener(
      "toggle",
      this.handlePathLayoutToggle,
      true,
    );
    window.addEventListener("resize", this.handlePathLayoutResize);
    if (typeof ResizeObserver !== "undefined") {
      this.pathLayoutObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? -1;
        if (Math.abs(width - this.pathLayoutObservedWidth) < 0.5) return;
        this.pathLayoutObservedWidth = width;
        this.scheduleAdaptivePathLayout();
      });
      this.pathLayoutObserver.observe(this.contentEl);
    }
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.renderFrameId !== null) {
      compatCancelAnimationFrame(this.renderFrameId);
      this.renderFrameId = null;
    }
    if (this.pathLayoutFrameId !== null) {
      compatCancelAnimationFrame(this.pathLayoutFrameId);
      this.pathLayoutFrameId = null;
    }
    this.pathLayoutObserver?.disconnect();
    this.pathLayoutObserver = null;
    this.contentEl.removeEventListener(
      "toggle",
      this.handlePathLayoutToggle,
      true,
    );
    window.removeEventListener("resize", this.handlePathLayoutResize);
  }

  private readonly handlePathLayoutToggle = (): void => {
    this.scheduleAdaptivePathLayout();
  };

  private readonly handlePathLayoutResize = (): void => {
    this.scheduleAdaptivePathLayout();
  };

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
    const communityPluginEnablementPending =
      this.plugin.getCommunityPluginEnablementPendingCount();
    const planReviewActive = syncState?.planReviewActive ?? false;
    const pendingCount = pendingIssues.length + conflicts.length
      + pendingDeletes.length + communityPluginEnablementPending;
    const sideActionResultsVisible = progress.activityKind === "sideAction"
      && (sideActionRunning || progress.completedFiles.length > 0);
    const mutationRecovery = this.plugin.getMutationRecoveryDisplayState();
    const bodyMode = resolveSyncViewBodyMode({
      planReviewActive,
      hasSyncState: Boolean(syncState),
      fullSyncRunning,
      pendingCount,
      sideActionResultsVisible,
    });

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
      pendingIssues,
      conflicts,
      pendingDeletes,
      communityPluginEnablementPending,
      planReviewCounts: syncState?.planReviewCounts ?? null,
      planReviewItems: syncState?.planReviewItems ?? [],
      history: syncState?.syncHistory ?? [],
      lastSyncTime: syncState?.lastSyncTime ?? 0,
      mutationRecovery,
    });

    if (this.lastContentKey !== contentKey) {
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
      container.empty();
      container.addClass("easy-sync-view");

      this.renderToolbar(container);
      const content = container.createDiv("easy-sync-view-content");

      this.renderStatusPanel(content, statusState);

      if (bodyMode === "plan" && syncState) {
        this.renderPlanReviewSection(
          content,
          syncState.planReviewCounts,
          syncState.planReviewItems,
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
          communityPluginEnablementPending,
        );
      }

      if (this.historyExpanded) {
        this.renderHistorySection(content, syncState?.syncHistory ?? []);
      }

      // ponytail: re-apply collapsed state after full rebuild — fresh DOM has all <details> closed
      this.toggleAllDetails();
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

  private scheduleAdaptivePathLayout(): void {
    if (this.pathLayoutFrameId !== null) return;
    this.pathLayoutFrameId = compatRequestAnimationFrame(() => {
      this.pathLayoutFrameId = null;
      this.applyAdaptivePathLayout();
    });
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
      if (!(child instanceof HTMLElement)
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
        this.plugin.i18n.t("syncView.progress.completed", { count: files.length }),
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
      this.plugin.i18n.t("syncView.progress.completed", { count: files.length }),
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
    const icon = this.allCollapsed ? "chevrons-up-down" : "chevrons-down-up";
    const label = this.allCollapsed ? t("syncView.expandAll") : t("syncView.collapseAll");

    const button = this.createIconButton(container, icon, label, () => {
      this.allCollapsed = !this.allCollapsed;
      this.toggleAllDetails();
      const newIcon = this.allCollapsed ? "chevrons-up-down" : "chevrons-down-up";
      const newLabel = this.allCollapsed ? t("syncView.expandAll") : t("syncView.collapseAll");
      setIcon(button, newIcon);
      setTooltip(button, newLabel);
      button.ariaLabel = newLabel;
    });
  }

  private toggleAllDetails(): void {
    const details = this.contentEl.querySelectorAll<HTMLDetailsElement>(".easy-sync-tree-item");
    if (this.allCollapsed) {
      for (const d of details) d.removeAttribute("open");
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
    if (state.isLoggedIn && state.isRunning && state.canCancel) {
      const cancelButton = new ButtonComponent(actions)
        .setButtonText(t("syncView.cancelSync"));
      cancelButton.buttonEl.classList.add("mod-warning");
      cancelButton.onClick(() => {
        void this.plugin.cancelSync();
      });
    } else if (state.isLoggedIn && state.isRunning) {
      new ButtonComponent(actions)
        .setButtonText(t("syncView.conflict.processing"))
        .setDisabled(true);
    } else if (state.isLoggedIn && state.planReviewActive) {
      new ButtonComponent(actions)
        .setButtonText(t("command.syncNow"))
        .setDisabled(true);
    } else if (state.isLoggedIn) {
      new ButtonComponent(actions)
        .setButtonText(t(
          state.mutationRecovery?.kind === "blocked"
            && state.mutationRecovery.blockReason === "facts-changed"
            && state.mutationRecovery.manualResolutionAvailable === true
            ? "syncView.recovery.reviewAndResolve"
            : state.mutationRecovery
              ? "syncView.recovery.checkAgain"
            : "command.syncNow",
        ))
        .setCta()
        .setDisabled(state.isInitializing)
        .onClick(() => {
          if (
            state.mutationRecovery?.kind === "blocked"
            && state.mutationRecovery.blockReason === "facts-changed"
            && state.mutationRecovery.manualResolutionAvailable === true
          ) {
            void this.openMutationRecoveryResolution();
            return;
          }
          void this.plugin.startManualSync();
        });
    } else {
      const authEntry = resolveAuthEntryPresentation({
        isInitializing: state.isInitializing,
        isPending: state.isPending,
      });
      const button = new ButtonComponent(actions)
        .setButtonText(t(authEntry.labelKey));
      if (authEntry.cta) button.setCta();
      if (authEntry.disabled) {
        button.setDisabled(true);
      } else {
        button.onClick(() => {
          void handleAuthEntryAction(this.plugin);
        });
      }
    }
  }

  private updateStatusPanel(state: StatusPanelState): void {
    const presentation = this.getStatusPresentation(state);
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);

    if (this.statusLineEl) {
      this.statusLineEl.removeClass("is-loggedOut", "is-cancelling", "is-syncing", "is-attention", "is-success", "is-ready");
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
    } else if (this.statusCounterEl) {
      this.statusCounterEl.remove();
      this.statusCounterEl = null;
    }

    if (!this.statusDetailEl) return;
    if (
      state.mutationRecovery
      && (
        !state.isRunning
        || state.progress.activityKind === "mutationRecovery"
      )
    ) {
      if (this.statusDetailMode !== "recovery") {
        this.statusDetailEl.empty();
        this.statusDetailEl.removeClass("is-current-file");
        this.currentFileTextEl = null;
        this.currentByteProgressEl = null;
        this.statusDetailMode = "recovery";
      }
      this.statusDetailEl.setText(mutationRecoveryStatusDetail(
        state.mutationRecovery,
        t,
        (timestamp) => new Date(timestamp).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      ));
      return;
    }
    if (state.isRunning) {
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

    const scopeRecovery = state.progress.recoveryVerification;
    if (scopeRecovery?.failureStage) {
      if (this.statusDetailMode !== "scope-recovery") {
        this.statusDetailEl.empty();
        this.statusDetailEl.removeClass("is-current-file");
        this.currentFileTextEl = null;
        this.currentByteProgressEl = null;
        this.statusDetailMode = "scope-recovery";
      }
      this.statusDetailEl.setText(
        scopeRecovery.firstFailurePath
          ? t("syncView.progress.remoteScopeRecoveryFailed", {
              path: scopeRecovery.firstFailurePath,
            })
          : t("syncView.progress.remoteScopeRecoveryStopped"),
      );
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
      return { status: "loggedOut", label: t("settings.account.desc.pending") };
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
    switch (status) {
      case "cancelling":
        return { status, label: t("syncView.cancelling") };
      case "syncing":
        return { status, label: this.getRunningStatusLabel(state.progress) };
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
            label: mutationRecoveryStatusLabel(state.mutationRecovery, t),
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

  private getRunningStatusLabel(progress: Readonly<SyncProgressState>): string {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    return translateSyncActivity(resolveSyncActivityPresentation(progress), t);
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
        t("syncView.progress.completed", { count: state.completedFiles.length }),
      );
      this.renderFileResults(panel, state.completedFiles, true);
    }
  }

  private renderPendingSection(
    container: HTMLElement,
    issues: PendingIssue[],
    conflicts: SyncPlanItem[],
    pendingDeletes: SyncPlanItem[],
    communityPluginEnablementPending: number,
  ): void {
    const section = container
      .createDiv("easy-sync-section")
      .createDiv("easy-sync-section-body");
    section.addClass("easy-sync-path-layout");
    const skipped = issues.filter((issue) =>
      issue.actionType === SyncActionType.SkipLargeFile
      || issue.actionType === SyncActionType.SkipIgnoredPath);
    const failures = issues.filter((issue) =>
      issue.actionType !== SyncActionType.SkipLargeFile
      && issue.actionType !== SyncActionType.SkipIgnoredPath);

    if (communityPluginEnablementPending > 0) {
      this.renderCommunityPluginEnablementAttention(
        section,
        communityPluginEnablementPending,
      );
    }
    for (const issue of failures) {
      this.renderPendingIssue(
        section,
        issue,
        communityPluginEnablementPending === 0,
      );
    }
    for (const conflict of conflicts) this.renderConflictItem(section, conflict);
    if (pendingDeletes.length > 1) {
      const t = this.plugin.i18n.t.bind(this.plugin.i18n);
      const paths = pendingDeletes.map((item) => item.path);
      const actions = section.createDiv("easy-sync-plan-execute");
      actions.addClass("easy-sync-primary-actions");
      new ButtonComponent(actions)
        .setButtonText(t("syncView.delete.confirmAll", { count: paths.length }))
        .setWarning()
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
            await this.plugin.confirmRemoteDeletes(paths);
          });
        });
    }
    for (const item of pendingDeletes) this.renderDeleteItem(section, item);
    for (const issue of skipped) this.renderPendingIssue(section, issue, false);
  }

  private renderCommunityPluginEnablementAttention(
    container: HTMLElement,
    count: number,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const item = container.createDiv(
      "easy-sync-community-plugin-attention",
    );
    item.createDiv("easy-sync-community-plugin-attention-title").setText(
      t("syncView.communityPlugins.pendingTitle", { count }),
    );
    item.createDiv("easy-sync-item-reason").setText(
      t("syncView.communityPlugins.pendingDescription", { count }),
    );
    const actions = item.createDiv("easy-sync-item-actions");
    new ButtonComponent(actions)
      .setButtonText(t("syncView.communityPlugins.review"))
      .setCta()
      .onClick(() => {
        this.plugin.openCommunityPluginEnablementReview();
      });
  }

  private renderPendingIssue(
    container: HTMLElement,
    issue: PendingIssue,
    retryable: boolean,
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
          t("syncView.emptyFolder.resolve"),
          "accent",
          () => {
            void this.openEmptyFolderResolution(issue.path);
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
      const choice = await new MutationRecoveryResolutionModal(
        this.plugin.app,
        snapshot,
        t,
      ).awaitChoice();
      if (!choice) return;
      const option = choice === "keep-local"
        ? snapshot.keepLocal
        : snapshot.keepRemote;
      if (option.deletesOtherSide) {
        const confirmed = await new ConfirmModal(
          this.plugin.app,
          t("syncView.mutationResolution.deleteConfirmTitle"),
          null,
          t("syncView.mutationResolution.deleteConfirm"),
          t("confirm.cancel"),
          t,
          {
            message: t("syncView.mutationResolution.deleteConfirmMessage", {
              path: snapshot.path,
              choice: choice === "keep-local"
                ? t("syncView.mutationResolution.keepLocal")
                : t("syncView.mutationResolution.keepRemote"),
            }),
            warning: t("syncView.mutationResolution.deleteConfirmWarning"),
            danger: true,
          },
        ).awaitConfirm();
        if (!confirmed) return;
      }
      await this.plugin.resolveMutationRecovery(snapshot, choice);
    } finally {
      this.mutationRecoveryResolutionOpening = false;
    }
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
      const counts = formatSyncHistoryCounts(entry, t);
      if (counts) body.createDiv("easy-sync-history-counts").setText(counts);
      if (entry.recovery) {
        body.createDiv("easy-sync-history-meta").setText(
          formatMutationRecoveryHistory(entry.recovery, t),
        );
      }
      if (
        entry.attention?.reason
          === "community-plugin-enablement-decision-required"
      ) {
        body.createDiv("easy-sync-history-meta").setText(
          t("syncView.communityPlugins.history", {
            count: entry.attention.count,
          }),
        );
      }

      if (entry.files.length > 0) {
        this.renderFileResults(body, entry.files, false);
      }
      const retainedTotal = entry.files.length;
      const actionTotal = entry.uploaded + entry.downloaded + (entry.filesMoved ?? 0)
        + (entry.foldersCreated ?? 0) + (entry.foldersMoved ?? 0)
        + (entry.foldersDeleted ?? 0) + entry.deleted
        + entry.conflicts + entry.skipped
        + (entry.recovery ? 0 : entry.errors);
      const omitted = Math.max(0, actionTotal - retainedTotal);
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

    const actions = panel.createDiv("easy-sync-plan-execute");
    new ButtonComponent(actions)
      .setButtonText(t("syncPlan.recalculate"))
      .onClick(() => {
        void this.plugin.rebuildPlanReview();
      });
    new ButtonComponent(actions)
      .setButtonText(t(
        activationReviewKind === "v2-migration"
          ? "syncPlan.confirmMigration"
          : "syncPlan.confirmExecute",
      ))
      .setCta()
      .setDisabled(this.plugin.syncExecutor?.isRunning ?? false)
      .onClick(() => {
        void this.plugin.executePlanReview();
      });
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
    const groups = buildSyncPlanDisplayGroups(items);

    for (const group of groups) {
      const body = this.createTreeGroup(
        container,
        t(group.labelKey),
        group.items.length,
        group.open,
      );
      body.addClass("easy-sync-path-layout");
      for (const item of group.items) {
        if (item.type === SyncActionType.Conflict && conflictByPath.has(item.path)) {
          this.renderConflictItem(body, conflictByPath.get(item.path)!);
        } else if (item.type === SyncActionType.ConfirmLocalDelete && deleteByPath.has(item.path)) {
          this.renderDeleteItem(body, deleteByPath.get(item.path)!);
        } else {
          const action = resolveSyncActionPresentation(item.type);
          const row = body.createDiv("easy-sync-file-row");
          const icon = row.createSpan("easy-sync-file-icon");
          setIcon(icon, action.icon);
          const pathEl = row.createSpan("easy-sync-file-path");
          configureFilePath(row, pathEl, item.path, true);
          if (item.reason) {
            row.createDiv("easy-sync-file-reason").setText(t(item.reason));
          }
        }
      }
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
      (button as HTMLButtonElement).disabled = true;
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
