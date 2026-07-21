import {
  ButtonComponent,
  ItemView,
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
import {
  type SyncPhase,
  type FileProgress,
  isAnySyncActivityRunning,
  type SyncProgressState,
} from "../sync/sync-progress";
import type { PendingIssue, SyncHistoryEntry } from "../sync/state-manager";
import { ConfirmModal } from "./confirm-modal";
import { ConflictDetailModal } from "./conflict-detail-modal";
import { NOTICE_PRIORITY } from "./notice-center";
import {
  RIBBON_STATUS_ICONS,
  resolveRibbonStatus,
  type RibbonStatus,
} from "./ribbon-status";
import {
  resolveSyncActivityPresentation,
  translateSyncActivity,
} from "./sync-status-presentation";

interface StatusPanelState {
  isLoggedIn: boolean;
  isInitializing: boolean;
  isRunning: boolean;
  canCancel: boolean;
  lastSyncTime: number;
  pendingCount: number;
  planReviewActive: boolean;
  autoSyncPaused: boolean;
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
  isRunning: boolean;
  canCancel: boolean;
  bodyMode: SyncViewBodyMode;
  progress: Readonly<SyncProgressState>;
  planReviewActive: boolean;
  pendingIssues: PendingIssue[];
  conflicts: SyncPlanItem[];
  pendingDeletes: SyncPlanItem[];
  planReviewCounts: { uploads: number; downloads: number; deletes: number; conflicts: number; skipped: number } | null;
  planReviewItems: PlanReviewItem[];
  history: SyncHistoryEntry[];
  lastSyncTime: number;
}

const FILE_STATUS_ICONS: Record<FileProgress["status"], string> = {
  upload: "arrow-up",
  download: "arrow-down",
  delete: "trash-2",
  conflict: "triangle-alert",
  skip: "circle-slash-2",
  error: "circle-x",
};

const ISSUE_ACTION_ICONS: Partial<Record<SyncActionType, string>> = {
  [SyncActionType.Upload]: "arrow-up",
  [SyncActionType.Download]: "arrow-down",
  [SyncActionType.DeleteRemote]: "trash-2",
  [SyncActionType.DeleteLocal]: "trash-2",
  [SyncActionType.SkipLargeFile]: "circle-slash-2",
  [SyncActionType.RetryLater]: "rotate-cw",
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

export function buildCompletedFilesRenderState(
  files: readonly Pick<FileProgress, "path" | "status" | "reason">[],
): { prefix: string; key: string } {
  return {
    prefix: commonDirPrefix(files.map((file) => file.path)),
    key: files
      .map((file) => `${file.path}\u0000${file.status}\u0000${file.reason ?? ""}`)
      .join("\u0001"),
  };
}

export const SYNC_VIEW_TYPE = "easy-sync-detail";

export function buildSyncViewContentKey(
  historyExpanded: boolean,
  input: SyncViewContentKeyInput,
): string {
  const authKey = `auth:${input.isInitializing ? 1 : 0}:${input.isLoggedIn ? 1 : 0}`;
  const runKey = `run:${input.isRunning ? 1 : 0}:${input.canCancel ? 1 : 0}`;
  const historyIds = input.history.map((entry) => entry.id).join("|");
  const historyKey = historyExpanded ? `history:open:${historyIds}` : "history:closed";
  if (input.bodyMode === "plan") {
    const counts = input.planReviewCounts
      ? `${input.planReviewCounts.uploads},${input.planReviewCounts.downloads},${input.planReviewCounts.deletes},${input.planReviewCounts.conflicts},${input.planReviewCounts.skipped}`
      : "";
    const items = input.planReviewItems
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    return `plan:${authKey}:${runKey}:${counts}:${items}:${historyKey}`;
  }
  if (input.bodyMode === "progress") {
    return `progress:${authKey}:${input.progress.phase}:${historyKey}`;
  }
  if (input.bodyMode === "pending") {
    const issues = input.pendingIssues
      .map((issue) => `${issue.actionType}:${issue.path}:${issue.updatedAt}:${issue.reason ?? ""}`)
      .join("|");
    const conflicts = input.conflicts
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    const deletes = input.pendingDeletes
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    return `pending:${authKey}:${runKey}:${issues}:${conflicts}:${deletes}:${historyKey}`;
  }
  return `idle:${authKey}:${runKey}:${input.lastSyncTime}:${historyKey}`;
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

function renderFileRow(file: FileProgress, list: HTMLElement, prefix: string, t: (key: string) => string): void {
  const row = list.createDiv("easy-sync-file-row");
  const icon = row.createSpan("easy-sync-file-icon");
  setIcon(icon, file.actionType
    ? (ISSUE_ACTION_ICONS[file.actionType] ?? FILE_STATUS_ICONS[file.status])
    : FILE_STATUS_ICONS[file.status]);
  row.createSpan("easy-sync-file-path").setText(
    trimFilePathPrefix(file.path, prefix),
  );
  row.createSpan("easy-sync-tree-chip").setText(t(`syncView.fileStatus.${file.status}`));
  if (file.reason) row.createDiv("easy-sync-file-reason").setText(file.reason);
}

export class EasySyncSyncView extends ItemView {
  plugin: EasySyncPlugin;
  private historyExpanded = false;
  private allCollapsed = false;
  // P0: incremental render — frame merging + diffed file list
  private renderFrameId: AnimationFrameHandle | null = null;
  private lastContentKey: string | null = null;
  private lastPhase: SyncPhase = "idle";
  // Cached DOM refs for direct progress-bar updates
  private progressPanelEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressSubtitleEl: HTMLElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private cachedPrefix: string | null = null;
  private completedFilesRenderKey: string | null = null;
  private statusLineEl: HTMLElement | null = null;
  private statusIconEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private statusCounterEl: HTMLElement | null = null;
  private statusDetailEl: HTMLElement | null = null;
  private currentFileTextEl: HTMLElement | null = null;
  private currentByteProgressEl: HTMLElement | null = null;
  private statusDetailMode: "timestamp" | "current-file" | null = null;

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
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.renderFrameId !== null) {
      compatCancelAnimationFrame(this.renderFrameId);
      this.renderFrameId = null;
    }
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
    const conflicts = (syncState?.pendingConflicts ?? [])
      .filter((item) => !this.plugin.syncExecutor?.isSideActionQueued(item.path));
    const pendingDeletes = (syncState?.pendingRemoteDeletes ?? [])
      .filter((item) => !this.plugin.syncExecutor?.isSideActionQueued(item.path));
    const pendingIssues = syncState?.pendingIssues ?? [];
    const planReviewActive = syncState?.planReviewActive ?? false;
    const pendingCount = pendingIssues.length + conflicts.length + pendingDeletes.length;
    const sideActionResultsVisible = progress.activityKind === "sideAction"
      && (sideActionRunning || progress.completedFiles.length > 0);
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
      isRunning,
      canCancel,
      lastSyncTime: syncState?.lastSyncTime ?? 0,
      pendingCount,
      planReviewActive,
      autoSyncPaused: this.plugin.autoSyncPaused,
      latestHistory: syncState?.syncHistory[0],
      progress,
    };
    const contentKey = buildSyncViewContentKey(this.historyExpanded, {
      isLoggedIn,
      isInitializing,
      isRunning,
      canCancel,
      bodyMode,
      progress,
      planReviewActive,
      pendingIssues,
      conflicts,
      pendingDeletes,
      planReviewCounts: syncState?.planReviewCounts ?? null,
      planReviewItems: syncState?.planReviewItems ?? [],
      history: syncState?.syncHistory ?? [],
      lastSyncTime: syncState?.lastSyncTime ?? 0,
    });

    if (this.lastContentKey !== contentKey) {
      this.progressPanelEl = null;
      this.progressFillEl = null;
      this.progressSubtitleEl = null;
      this.fileListEl = null;
      this.cachedPrefix = null;
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
        this.renderPendingSection(content, pendingIssues, conflicts, pendingDeletes);
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
        if (this.progressFillEl && progress.total > 0) {
          this.progressFillEl.style.width = `${syncViewProgressPercent(progress)}%`;
        }
        this.appendNewFileRows(progress.completedFiles);
      }
    }

    this.lastContentKey = contentKey;
    this.lastPhase = progress.phase;
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
      || this.cachedPrefix !== nextState.prefix
      || this.completedFilesRenderKey !== nextState.key) {
      // ponytail: the visible list is capped, so a small rebuild is simpler than keeping a drifting incremental cache
      this.progressPanelEl.querySelector(".easy-sync-progress-prefix")?.remove();
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
    if (state.isInitializing) {
      new ButtonComponent(actions)
        .setButtonText(t("settings.account.checking"))
        .setDisabled(true);
    } else if (state.isLoggedIn && state.isRunning && state.canCancel) {
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
        .setButtonText(t("command.syncNow"))
        .setCta()
        .setDisabled(state.isInitializing)
        .onClick(() => {
          void this.plugin.startManualSync();
        });
    } else {
      new ButtonComponent(actions)
        .setButtonText(t("settings.account.login"))
        .setCta()
        .onClick(() => {
          void (async () => {
            try {
              await this.plugin.auth?.login();
            } catch (error) {
              this.plugin.noticeCenter.show({
                key: "auth-login-error",
                message: error instanceof Error ? error.message : t("general.unknown"),
                priority: NOTICE_PRIORITY.failure,
              });
            }
          })();
        });
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

    if (state.isRunning && state.progress.total > 0) {
      if (!this.statusCounterEl) {
        const statusLine = this.contentEl.querySelector(".easy-sync-status-line");
        if (statusLine instanceof HTMLElement) {
          this.statusCounterEl = statusLine.createSpan("easy-sync-status-counter");
        }
      }
      this.statusCounterEl?.setText(
        t("syncView.progress.items", {
          current: state.progress.current,
          total: state.progress.total,
        }),
      );
    } else if (this.statusCounterEl) {
      this.statusCounterEl.remove();
      this.statusCounterEl = null;
    }

    if (!this.statusDetailEl) return;
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
    isRunning: boolean;
    lastSyncTime: number;
    pendingCount: number;
    planReviewActive: boolean;
    autoSyncPaused: boolean;
    latestHistory?: SyncHistoryEntry;
    progress: Readonly<SyncProgressState>;
  }): { status: RibbonStatus; label: string } {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (state.isInitializing) {
      return { status: "ready", label: t("settings.account.desc.connecting") };
    }

    const status = resolveRibbonStatus({
      loggedIn: state.isLoggedIn,
      cancelling: state.progress.cancelRequested,
      syncing: state.isRunning,
      needsAttention: state.pendingCount > 0 || state.planReviewActive || state.autoSyncPaused,
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
    if (state.total <= 0 && state.completedFiles.length === 0) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const panel = container.createDiv("easy-sync-progress-panel");
    this.progressPanelEl = panel;
    if (state.total > 0) {
      const bar = panel.createDiv("easy-sync-progress-bar");
      this.progressFillEl = bar.createDiv("easy-sync-progress-fill");
      this.progressFillEl.style.width = `${syncViewProgressPercent(state)}%`;
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
  ): void {
    const section = container
      .createDiv("easy-sync-section")
      .createDiv("easy-sync-section-body");
    const failures = issues.filter((issue) => issue.actionType !== SyncActionType.SkipLargeFile);
    const skipped = issues.filter((issue) => issue.actionType === SyncActionType.SkipLargeFile);

    for (const issue of failures) this.renderPendingIssue(section, issue, true);
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

  private renderPendingIssue(
    container: HTMLElement,
    issue: PendingIssue,
    retryable: boolean,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const actionIcon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(actionIcon, ISSUE_ACTION_ICONS[issue.actionType] ?? "circle-alert");
    summary.createSpan("easy-sync-tree-path").setText(issue.path);
    summary.createSpan("easy-sync-tree-chip").setText(
      retryable ? t("syncView.fileStatus.error") : t("syncView.issues.notSynced"),
    );

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
      this.createActionChip(actions, t("syncView.issues.retry"), "accent", () => {
        void this.plugin.startManualSync();
      });
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
      const counts = this.formatHistoryCounts(entry);
      if (counts) body.createDiv("easy-sync-history-counts").setText(counts);

      if (entry.files.length > 0) {
        this.renderFileResults(body, entry.files, false);
      }
      const retainedTotal = entry.files.length;
      const actionTotal = entry.uploaded + entry.downloaded + entry.deleted
        + entry.conflicts + entry.skipped + entry.errors;
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
    const prefix = limitHeight ? renderState.prefix : "";
    if (prefix) container.createDiv("easy-sync-progress-prefix").setText(prefix);
    const list = container.createDiv("easy-sync-file-list");
    const renderedPaths = new Set<string>();
    if (limitHeight) {
      list.addClass("is-limited");
      this.fileListEl = list;
      this.cachedPrefix = prefix;
      this.completedFilesRenderKey = renderState.key;
    }

    // Iterate in reverse (newest first)
    for (let i = files.length - 1; i >= 0; i--) {
      if (limitHeight && renderedPaths.has(files[i].path)) continue;
      renderedPaths.add(files[i].path);
      renderFileRow(files[i], list, prefix, t);
    }
  }

  private renderPlanReviewSection(
    container: HTMLElement,
    counts: { uploads: number; downloads: number; deletes: number; conflicts: number; skipped: number } | null,
    items: PlanReviewItem[],
    conflicts: SyncPlanItem[],
    pendingDeletes: SyncPlanItem[],
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const panel = this.createSection(container, t("syncPlan.sectionTitle"));

    if (counts && items.length === 0) {
      const rows: Array<[string, number]> = [
        [t("syncView.fileStatus.upload"), counts.uploads],
        [t("syncView.fileStatus.download"), counts.downloads],
        [t("syncView.fileStatus.delete"), counts.deletes],
        [t("syncView.fileStatus.conflict"), counts.conflicts],
        [t("syncView.fileStatus.skip"), counts.skipped],
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
      .setButtonText(t("syncPlan.confirmExecute"))
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
    const groups = [
      { label: t("syncView.fileStatus.upload"), items: items.filter((item) => item.type === SyncActionType.Upload || item.type === SyncActionType.RenameRemote), open: false },
      { label: t("syncView.fileStatus.download"), items: items.filter((item) => item.type === SyncActionType.Download), open: true },
      { label: t("syncView.fileStatus.conflict"), items: items.filter((item) => item.type === SyncActionType.Conflict), open: true },
      { label: t("syncView.fileStatus.delete"), items: items.filter((item) => item.type === SyncActionType.DeleteRemote || item.type === SyncActionType.DeleteLocal || item.type === SyncActionType.ConfirmLocalDelete), open: true },
      { label: t("syncView.fileStatus.skip"), items: items.filter((item) => item.type === SyncActionType.SkipLargeFile || item.type === SyncActionType.SkipIgnoredPath || item.type === SyncActionType.RetryLater), open: false },
    ].filter((group) => group.items.length > 0);

    for (const group of groups) {
      const body = this.createTreeGroup(container, group.label, group.items.length, group.open);
      for (const item of group.items) {
        if (item.type === SyncActionType.Conflict && conflictByPath.has(item.path)) {
          this.renderConflictItem(body, conflictByPath.get(item.path)!);
        } else if (item.type === SyncActionType.ConfirmLocalDelete && deleteByPath.has(item.path)) {
          this.renderDeleteItem(body, deleteByPath.get(item.path)!);
        } else {
          const row = body.createDiv("easy-sync-file-row");
          const icon = row.createSpan("easy-sync-file-icon");
          setIcon(icon, ISSUE_ACTION_ICONS[item.type] ?? "file");
          row.createSpan("easy-sync-file-path").setText(item.path);
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
    summary.createSpan("easy-sync-tree-path").setText(item.path);
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
    summary.createSpan("easy-sync-tree-path").setText(item.path);
    summary.createSpan("easy-sync-tree-chip").setText(t("syncView.issues.awaitingConfirmation"));

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

  private formatHistoryCounts(entry: SyncHistoryEntry): string {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const values: Array<[string, number]> = [
      [t("syncView.fileStatus.upload"), entry.uploaded],
      [t("syncView.fileStatus.download"), entry.downloaded],
      [t("syncView.fileStatus.delete"), entry.deleted],
      [t("syncView.fileStatus.conflict"), entry.conflicts],
      [t("syncView.fileStatus.deferred"), entry.deferred ?? 0],
      [t("syncView.fileStatus.skip"), entry.skipped],
      [t("syncView.fileStatus.error"), entry.errors],
    ];
    return values
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} ${count}`)
      .join(" · ");
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
