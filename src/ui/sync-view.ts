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
import {
  type SyncPhase,
  type FileProgress,
  type SyncProgressState,
} from "../sync/sync-progress";
import type { PendingIssue, SyncHistoryEntry } from "../sync/state-manager";
import { ConflictDetailModal } from "./conflict-detail-modal";
import {
  RIBBON_STATUS_ICONS,
  resolveRibbonStatus,
  type RibbonStatus,
} from "./ribbon-status";

interface StatusPanelState {
  isLoggedIn: boolean;
  isInitializing: boolean;
  isRunning: boolean;
  lastSyncTime: number;
  pendingCount: number;
  planReviewActive: boolean;
  autoSyncPaused: boolean;
  latestHistory?: SyncHistoryEntry;
  progress: Readonly<SyncProgressState>;
}

export interface SyncViewContentKeyInput {
  isLoggedIn: boolean;
  isInitializing: boolean;
  isRunning: boolean;
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

const PHASE_LABEL_MAP: Record<SyncPhase, string | null> = {
  idle: null,
  scanning: "progress.scanningLocal",
  baseline: "progress.loadingBaseline",
  preparing: "progress.preparingRemote",
  checking: "progress.checkingRemote",
  planning: "progress.generatingPlan",
  verifying: "progress.verifyingFiles",
  executing: "syncView.progress",
  done: null,
};

const ACTIVE_ACTION_LABEL_MAP: Partial<Record<SyncActionType, string>> = {
  [SyncActionType.Upload]: "syncView.active.upload",
  [SyncActionType.Download]: "syncView.active.download",
  [SyncActionType.DeleteRemote]: "syncView.active.delete",
};

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

export const SYNC_VIEW_TYPE = "easy-sync-detail";

export function buildSyncViewContentKey(
  historyExpanded: boolean,
  input: SyncViewContentKeyInput,
): string {
  const authKey = `auth:${input.isInitializing ? 1 : 0}:${input.isLoggedIn ? 1 : 0}`;
  const historyIds = input.history.map((entry) => entry.id).join("|");
  const historyKey = historyExpanded ? `history:open:${historyIds}` : "history:closed";
  if (input.planReviewActive) {
    const counts = input.planReviewCounts
      ? `${input.planReviewCounts.uploads},${input.planReviewCounts.downloads},${input.planReviewCounts.deletes},${input.planReviewCounts.conflicts},${input.planReviewCounts.skipped}`
      : "";
    const items = input.planReviewItems
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    return `plan:${authKey}:${counts}:${items}:${historyKey}`;
  }
  if (input.isRunning) {
    return `running:${authKey}:${input.progress.phase}:${historyKey}`;
  }
  if (input.pendingIssues.length > 0 || input.conflicts.length > 0 || input.pendingDeletes.length > 0) {
    const issues = input.pendingIssues
      .map((issue) => `${issue.actionType}:${issue.path}:${issue.updatedAt}:${issue.reason ?? ""}`)
      .join("|");
    const conflicts = input.conflicts
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    const deletes = input.pendingDeletes
      .map((item) => `${item.type}:${item.path}:${item.reason ?? ""}`)
      .join("|");
    return `pending:${authKey}:${issues}:${conflicts}:${deletes}:${historyKey}`;
  }
  return `idle:${authKey}:${input.lastSyncTime}:${historyKey}`;
}

/** Format byte progress as "downloaded/total unit" with unit shown once. */
function formatByteProgress(downloaded: number, total: number): string {
  if (total >= 1_048_576) return `${(downloaded/1_048_576).toFixed(1)}/${(total/1_048_576).toFixed(1)} MB`;
  if (total >= 1_024) return `${Math.round(downloaded/1_024)}/${Math.round(total/1_024)} KB`;
  return `${downloaded}/${total} B`;
}

function progressPercent(state: Readonly<SyncProgressState>): number {
  if (state.total > 0) {
    return Math.min(100, Math.round((state.current/state.total) * 100));
  }
  return 0;
}

function renderFileRow(file: FileProgress, list: HTMLElement, prefix: string, t: (key: string) => string): void {
  const row = list.createDiv("easy-sync-file-row");
  const icon = row.createSpan("easy-sync-file-icon");
  setIcon(icon, file.actionType
    ? (ISSUE_ACTION_ICONS[file.actionType] ?? FILE_STATUS_ICONS[file.status])
    : FILE_STATUS_ICONS[file.status]);
  row.createSpan("easy-sync-file-path").setText(
    prefix ? file.path.slice(prefix.length) : file.path,
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
  private renderedFilePaths: Set<string> = new Set();
  private lastPhase: SyncPhase = "idle";
  // Cached DOM refs for direct progress-bar updates
  private progressPanelEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressSubtitleEl: HTMLElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private cachedPrefix: string | null = null;
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
    const isRunning = this.plugin.syncExecutor?.isRunning ?? false;
    const syncState = this.plugin.state;
    const isInitializing = this.plugin.auth?.isInitializing ?? false;
    const authState = this.plugin.auth?.authState;
    const isLoggedIn = isInitializing ? false : (authState?.isLoggedIn ?? false);
    const conflicts = syncState?.pendingConflicts ?? [];
    const pendingDeletes = syncState?.pendingRemoteDeletes ?? [];
    const pendingIssues = syncState?.pendingIssues ?? [];
    const planReviewActive = syncState?.planReviewActive ?? false;
    const pendingCount = pendingIssues.length + conflicts.length + pendingDeletes.length;

    // Phase change or not running → full rebuild
    const statusState: StatusPanelState = {
      isLoggedIn,
      isInitializing,
      isRunning,
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
      this.renderedFilePaths.clear();
      this.progressPanelEl = null;
      this.progressFillEl = null;
      this.progressSubtitleEl = null;
      this.fileListEl = null;
      this.cachedPrefix = null;
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

      if (planReviewActive && syncState) {
        this.renderPlanReviewSection(
          content,
          syncState.planReviewCounts,
          syncState.planReviewItems,
          conflicts,
          pendingDeletes,
        );
      } else if (isRunning) {
        this.renderProgressPanel(content, progress);
      } else if (pendingIssues.length > 0 || conflicts.length > 0 || pendingDeletes.length > 0) {
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
          this.progressFillEl.style.width = `${progressPercent(progress)}%`;
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
      this.fileListEl = this.progressPanelEl.createDiv("easy-sync-file-list is-limited");
    }
    const list = this.fileListEl;
    if (!this.cachedPrefix) {
      this.cachedPrefix = commonDirPrefix(files.map((f) => f.path));
    }
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const prefix = this.cachedPrefix;
    let added = false;

    for (const file of files) {
      if (this.renderedFilePaths.has(file.path)) continue;
      this.renderedFilePaths.add(file.path);
      added = true;
      if (prefix && !list.querySelector(".easy-sync-progress-prefix")) {
        const prefixEl = list.createDiv("easy-sync-progress-prefix");
        prefixEl.setText(prefix);
      }
      renderFileRow(file, list, prefix, t);
    }

    if (added) {
      this.progressSubtitleEl?.setText(t("syncView.progress.completed", { count: files.length }));
    }
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
      cls: "clickable-icon nav-action-button easy-sync-nav-action",
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
    } else if (state.isLoggedIn && state.isRunning) {
      new ButtonComponent(actions)
        .setButtonText(t("syncView.cancelSync"))
        .setWarning()
        .onClick(() => {
          void this.plugin.cancelSync();
        });
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
              new Notice(error instanceof Error ? error.message : t("general.unknown"));
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
    if (progress.cancelRequested) return t("syncView.cancelling");
    if (progress.phase === "executing" && progress.currentActionType) {
      return t(ACTIVE_ACTION_LABEL_MAP[progress.currentActionType] ?? "syncView.progress");
    }
    const phaseKey = PHASE_LABEL_MAP[progress.phase];
    if (!phaseKey) return t("syncView.progress");
    return progress.phase === "verifying"
      ? t(phaseKey, { current: progress.current, total: progress.total })
      : t(phaseKey);
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
      this.progressFillEl.style.width = `${progressPercent(state)}%`;
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
      .createDiv("easy-sync-section easy-sync-issues-section")
      .createDiv("easy-sync-section-body");
    const failures = issues.filter((issue) => issue.actionType !== SyncActionType.SkipLargeFile);
    const skipped = issues.filter((issue) => issue.actionType === SyncActionType.SkipLargeFile);

    for (const issue of failures) this.renderPendingIssue(section, issue, true);
    for (const conflict of conflicts) this.renderConflictItem(section, conflict);
    for (const item of pendingDeletes) this.renderDeleteItem(section, item);
    for (const issue of skipped) this.renderPendingIssue(section, issue, false);
  }

  private renderPendingIssue(
    container: HTMLElement,
    issue: PendingIssue,
    retryable: boolean,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item easy-sync-issue-item");
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
    const prefix = limitHeight ? commonDirPrefix(files.map((f) => f.path)) : "";
    if (prefix) container.createDiv("easy-sync-progress-prefix").setText(prefix);
    const list = container.createDiv("easy-sync-file-list");
    const renderedPaths = new Set<string>();
    if (limitHeight) {
      list.addClass("is-limited");
      this.fileListEl = list;
      this.cachedPrefix = prefix;
    }

    // Iterate in reverse (newest first)
    for (let i = files.length - 1; i >= 0; i--) {
      if (limitHeight && renderedPaths.has(files[i].path)) continue;
      renderedPaths.add(files[i].path);
      renderFileRow(files[i], list, prefix, t);
    }
    if (limitHeight) {
      this.renderedFilePaths = renderedPaths;
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
    }

    const actions = panel.createDiv("easy-sync-plan-execute");
    new ButtonComponent(actions)
      .setButtonText(t("syncPlan.recalculate"))
      .onClick(() => {
        void this.plugin.rebuildPlanReview();
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
      { label: t("syncView.fileStatus.delete"), items: items.filter((item) => item.type === SyncActionType.DeleteRemote || item.type === SyncActionType.ConfirmLocalDelete), open: true },
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
    const details = container.createEl("details", "easy-sync-tree-item easy-sync-issue-item");
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
      void this.runItemAction(actions, () => this.plugin.syncExecutor!.resolveConflictKeepLocal(item.path));
    });
    this.createActionChip(actions, t("syncView.conflict.keepRemote"), "accent", () => {
      void this.runItemAction(actions, () => this.plugin.syncExecutor!.resolveConflictKeepRemote(item.path));
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
    const details = container.createEl("details", "easy-sync-tree-item easy-sync-issue-item");
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
      void this.runItemAction(actions, () => this.plugin.syncExecutor!.confirmRemoteDelete(item.path));
    });
    this.createActionChip(actions, t("syncView.delete.reject"), "", () => {
      void this.runItemAction(actions, () => this.plugin.syncExecutor!.rejectRemoteDelete(item.path));
    });
  }

  private createSection(container: HTMLElement, title: string): HTMLElement {
    const section = container.createDiv("easy-sync-section");
    section.createEl("h4", { cls: "easy-sync-section-title", text: title });
    return section.createDiv("easy-sync-section-body");
  }

  private createTreeGroup(
    container: HTMLElement,
    title: string,
    count: number,
    open: boolean,
  ): HTMLElement {
    const details = container.createEl("details", "easy-sync-tree-group easy-sync-tree-item");
    details.open = open;
    const summary = details.createEl("summary", "easy-sync-tree-group-summary easy-sync-tree-row");
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

  private disableActionChips(actionsEl: HTMLElement): void {
    for (const chip of Array.from(actionsEl.querySelectorAll(".easy-sync-action-chip"))) {
      (chip as HTMLButtonElement).disabled = true;
    }
  }

  private formatHistoryCounts(entry: SyncHistoryEntry): string {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const values: Array<[string, number]> = [
      [t("syncView.fileStatus.upload"), entry.uploaded],
      [t("syncView.fileStatus.download"), entry.downloaded],
      [t("syncView.fileStatus.delete"), entry.deleted],
      [t("syncView.fileStatus.conflict"), entry.conflicts],
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
    action: () => Promise<void>,
  ): Promise<void> {
    this.disableActionChips(actionsEl);
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
