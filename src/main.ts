import { Notice, Platform, Plugin, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import { AuthModule, type AuthPluginContext } from "./auth/auth-module";
import { OneDriveClient } from "./onedrive/client";
import { LocalScanner } from "./sync/local-scanner";
import { SyncEngine } from "./sync/sync-engine";
import { StateManager } from "./sync/state-manager";
import { SyncExecutor, type SyncMode, type SyncResult } from "./sync/sync-executor";
import { SyncProgressStore } from "./sync/sync-progress";
import { DiagnosticLogger } from "./sync/diagnostic-logger";
import { EasySyncSettingTab } from "./ui/settings-tab";
import { EasySyncSyncView, SYNC_VIEW_TYPE } from "./ui/sync-view";
import { RIBBON_STATUS_ICONS, resolveRibbonStatus, type RibbonStatus } from "./ui/ribbon-status";
import { ConfirmModal } from "./ui/confirm-modal";
import { SyncPlanAlertModal } from "./ui/confirm-modal";
import type { SyncPlan } from "./sync/types";
import type { SyncActionType } from "./sync/types";
import type { SyncPhase } from "./sync/sync-progress";
import { I18n } from "./i18n/index";

/** Plugin data keys for sync settings */
const KEY_SYNC_INTERVAL = "sync-interval";
const KEY_SYNC_PLUGIN_FILES = "sync-plugin-files";
const KEY_MAX_FILE_SIZE_MB = "sync-max-file-size-mb";
const KEY_DIAG_LOG = "sync-diagnostic-logging";
const KEY_SYNC_EDITOR = "sync-editor";
const KEY_SYNC_APPEARANCE = "sync-appearance";
const KEY_SYNC_THEMES = "sync-themes";
const KEY_SYNC_HOTKEYS = "sync-hotkeys";
const KEY_SYNC_CORE_PLUGINS = "sync-core-plugins";
const KEY_SYNC_COMMUNITY_PLUGINS = "sync-community-plugins";
const KEY_SYNC_PLUGIN_DATA = "sync-plugin-data";
const KEY_AUTO_SYNC_PAUSED = "auto-sync-paused";
const KEY_AUTO_MERGE = "sync-auto-merge";
const KEY_PROFILE_CACHE = "easy-sync-profile-cache";
const RIBBON_SUCCESS_DURATION_MS = 5_000;

/**
 * EasySync / 易同步
 * 面向新手用户的极简 Obsidian 云盘同步插件
 * MVP 首发 OneDrive App Folder 双向同步
 */
export default class EasySyncPlugin extends Plugin {
  auth: AuthModule | null = null;
  onedrive: OneDriveClient | null = null;
  scanner: LocalScanner | null = null;
  engine: SyncEngine | null = null;
  state: StateManager | null = null;
  syncExecutor: SyncExecutor | null = null;
  progressStore: SyncProgressStore = new SyncProgressStore();
  i18n: I18n = new I18n("en");
  diag: DiagnosticLogger = new DiagnosticLogger();

  // M14: single serialized write queue for PluginData — prevents
  // StateManager.save() / saveSyncSettings() / auth profile writes
  // from racing on loadData → modify → saveData cycles.
  private pluginDataQueue: Promise<void> = Promise.resolve();

  syncInterval = 3;
  syncPluginFiles = false; // M19: EasySync self-sync default OFF — explicit opt-in
  syncMaxFileSizeMb = 500;
  autoMerge = true;
  syncEditorSettings = false;
  syncAppearance = false;
  syncThemes = false;
  syncHotkeys = false;
  syncCorePlugins = false;
  syncCommunityPlugins = false;
  syncPluginData = false;
  diagLogEnabled = false;
  autoSyncPaused = false;
  private opLock: string | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private ribbonSuccessTimer: ReturnType<typeof setTimeout> | null = null;
  private ribbonSuccessVisible = false;
  private settingsTab: EasySyncSettingTab | null = null;
  private stateLoadPromise: Promise<void> | null = null;

  /** Set to true after state.load() completes. Public so settings-tab
   *  can guard the "Reset" button with it. */
  _stateLoaded = false;

  // ---- Operation Lock ----

  /** Acquire the shared operation lock. Returns null on success, or the
   *  holder's operation name if already held. */
  private acquireOpLock(operation: string): string | null {
    if (this.opLock !== null) return this.opLock;
    this.opLock = operation;
    return null;
  }

  private releaseOpLock(): void {
    this.opLock = null;
  }

  // ---- Lifecycle ----

  async onload(): Promise<void> {
    this.diag.log("lifecycle", "====== onload start ======");
    this.diag.setAdapter(this.app.vault.adapter);

    // ════ ① Fast init (all synchronous / negligible I/O) ════

    const lang = I18n.detectLanguage(this.app as unknown as { vault: { getConfig: (key: string) => string } });
    this.i18n = new I18n(lang);
    await this.loadSyncSettings();

    // ════ ② Auth (create, register callback, then background-init) ════

    const authCtx: AuthPluginContext = {
      secretStorage: {
        set: (key, value) => this.saveSecret(key, value),
        get: (key) => this.loadSecret(key),
        remove: (key) => this.removeSecret(key),
      },
      registerProtocolHandler: (action, handler) => {
        this.registerObsidianProtocolHandler(action, handler);
      },
      openAuthPopup: () => {
        const popup = window.open("about:blank", "_blank");
        if (!popup) return null;
        return {
          navigate: (url: string) => {
            try {
              popup.location.href = url;
              return true;
            } catch (error) {
              this.diag.warn("auth", "failed to navigate auth popup, falling back to direct open", error);
              return false;
            }
          },
          close: () => {
            try {
              popup.close();
            } catch {
              // Ignore popup close failures.
            }
          },
        };
      },
      openUrl: (url) => {
        window.open(url, "_blank");
      },
      // User profile cache: avoid network call on every cold start
      profileCache: {
        get: async () => {
          const data = await this.loadData();
          return data?.[KEY_PROFILE_CACHE] ?? null;
        },
        set: async (profile) => {
          await this.updatePluginData((data) => {
            data[KEY_PROFILE_CACHE] = profile;
          });
        },
        clear: async () => {
          await this.updatePluginData((data) => {
            delete data[KEY_PROFILE_CACHE];
          });
        },
      },
      diag: this.diag,
    };
    this.auth = new AuthModule(authCtx, (key, params) => this.i18n.t(key, params as Record<string, string | number> | undefined));

    // CRITICAL: register callback BEFORE initialize() so UI updates
    // when the background token refresh completes
    this.auth.onStateChange(() => {
      this.updateStatusBar();
      this.syncView?.render();
      this.settingsTab?.refreshAuthState();
    });

    // ════ ③ Sync engine + scanner (no state load yet) ════

    this.engine = new SyncEngine();
    this.state = new StateManager(this);
    // Reset circuit breakers on fresh OAuth login — old failures may
    // be due to stale auth scope and are no longer predictive.
    authCtx.onFreshLogin = () => {
      this.state!.resetCircuitBreakers();
    };
    // Loaded in the background after UI registration so Ribbon state is accurate.

    this.scanner = new LocalScanner(this.app.vault);
    this.scanner.setDiag(this.diag);
    this.applyPluginFilesSetting(); // Apply saved setting after scanner is created
    this.onedrive = new OneDriveClient(() => this.auth!.getAccessToken(), this.diag);
    this.syncExecutor = new SyncExecutor(
      this.onedrive,
      this.scanner,
      this.engine,
      this.state,
      this.app.vault.getName(),
      this.i18n,
      this.progressStore,
      this.diag,
      this.autoMerge,
    );

    // ════ ④ Register UI (Obsidian is usable from here on) ════

    this.settingsTab = new EasySyncSettingTab(this);
    this.addSettingTab(this.settingsTab);
    this.registerView(
      SYNC_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new EasySyncSyncView(leaf, this),
    );
    this.ribbonEl = this.addRibbonIcon(
      "cloud",
      this.i18n.t("syncView.title"),
      () => this.handleRibbonClick(),
    );
    this.ribbonEl.addClass("easy-sync-ribbon");
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar(); // Shows "Connecting…" while auth initializes
    this.addCommand({
      id: "easy-sync-start",
      name: this.i18n.t("command.syncNow"),
      callback: () => this.startManualSync(),
    });
    this.addCommand({
      id: "easy-sync-show-detail",
      name: this.i18n.t("command.showDetail"),
      callback: () => this.activateSyncView(),
    });

    // ════ ⑤ Background auth init (non-blocking) ════

    this.auth.initialize().catch((e) => {
      this.diag.warn("lifecycle", "background auth init failed", e);
    });
    // onStateChange callback fires when complete → UI auto-refreshes
    void this.ensureStateLoaded()
      .then(() => this.updateStatusBar())
      .catch((e) => this.diag.warn("state", "background state load failed", e));

    // ════ ⑥ Auto-sync timer (skips until auth is ready) ════

    this.startAutoSync();

    this.diag.log("lifecycle", "onload complete (auth initializing in background)");
  }

  async onunload(): Promise<void> {
    this.diag.log("lifecycle", "unloading");
    this.stopAutoSync();
    if (this.ribbonSuccessTimer) clearTimeout(this.ribbonSuccessTimer);
    await this.diag.dispose();
    // Auth token stays in SecretStorage across sessions
  }

  // ---- Public API for UI callbacks ----

  get syncView(): EasySyncSyncView | null {
    const leaves = this.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE);
    if (leaves.length === 0) return null;
    const view = leaves[0].view as unknown as Partial<EasySyncSyncView>;
    // Hot reload can leave an old ItemView instance without the new prototype.
    return typeof view.render === "function" ? view as EasySyncSyncView : null;
  }

  /** Open the sync detail view in the left sidebar */
  async activateSyncView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    await this.app.workspace.getLeftLeaf(false)?.setViewState({
      type: SYNC_VIEW_TYPE,
      active: true,
    });
  }

  /** Execute a sync after the user has reviewed the plan in the sidebar.
   *  Clears plan review state, then runs the sync with confirmation
   *  checks skipped (user already reviewed). */
  async executePlanReview(): Promise<void> {
    if (!this.syncExecutor || !this.state) return;
    if (this.acquireOpLock("sync")) return;
    try {
    await this.ensureStateLoaded();
    if (!this.state.planReviewActive) return;
    this.progressStore.markStarted();

    const result = await this.syncExecutor.run(
      "manual",
      {
        onProgress: (current, total, currentFile) => {
          this.handleProgress(current, total, currentFile);
          this.updateStatusBar();
          this.syncView?.render();
        },
        onFileProgress: (downloaded, total) => {
          this.handleFileProgress(downloaded, total);
        },
        onFileComplete: (path, actionType, success, reason, fileSize) => {
          this.handleFileComplete(path, actionType, success, reason, fileSize);
        },
        onStateChange: () => {
          this.updateStatusBar();
          this.syncView?.render();
        },
      },
      /* skipConfirmation = */ true,
    );

    this.diag.log("execute", `plan review execution result: ${result.message}`);
    await this.handleSyncResult(result, "manual");
    this.syncView?.render();
    } finally {
      this.releaseOpLock();
    }
  }

  async rebuildPlanReview(): Promise<void> {
    if (!this.state || !this.syncExecutor || this.syncExecutor.isRunning) return;
    await this.ensureStateLoaded();
    await this.state.clearPlanReview();
    await this.startFirstSync();
  }

  /** Verify the current account matches the vault's bound identity.
   *  First sync ever silently binds. Account mismatch → Notice + block.
   *  Returns true if sync may proceed. */
  private async checkAccountBinding(): Promise<boolean> {
    const currentId = this.auth?.authState.accountId;
    if (!currentId) return false; // Not logged in

    const bound = this.state?.boundAccountId;
    if (!bound) {
      // First sync ever — bind to this account
      await this.state?.bindAccount(currentId);
      return true;
    }
    if (bound !== currentId) {
      new Notice(`账号不匹配：此仓库已绑定账号 ${bound.slice(0, 8)}…，当前账号为 ${currentId.slice(0, 8)}…。请先重置同步状态再切换账号。`);
      this.diag.warn("lifecycle", `account mismatch — bound=${bound.slice(0, 8)}, current=${currentId.slice(0, 8)}`);
      return false;
    }
    return true;
  }

  /** Ensure StateManager has been loaded from disk.
   *  Idempotent — only calls load() on the first invocation. */
  async ensureStateLoaded(): Promise<void> {
    if (this._stateLoaded || !this.state) return;
    this.stateLoadPromise ??= this.state.load().then(() => {
      this._stateLoaded = true;
    }).finally(() => {
      this.stateLoadPromise = null;
    });
    await this.stateLoadPromise;
  }

  /** Start a first sync (manual trigger from settings) */
  async startFirstSync(): Promise<void> {
    if (!this.syncExecutor) return;
    if (this.acquireOpLock("sync")) return;
    try {
    await this.ensureStateLoaded();
    if (!await this.checkAccountBinding()) return;
    if (this.state?.planReviewActive) {
      await this.activateSyncView();
      this.syncView?.render();
      return;
    }
    await this.activateSyncView();
    this.progressStore.markStarted();
    const result = await this.syncExecutor.run("first", {
      onProgress: (current, total, currentFile) => {
        this.handleProgress(current, total, currentFile);
        this.updateStatusBar();
        this.syncView?.render();
      },
      onFileProgress: (downloaded, total) => {
        this.handleFileProgress(downloaded, total);
      },
      onFileComplete: (path, actionType, success, reason) => {
        this.handleFileComplete(path, actionType, success, reason);
      },
      onFirstSyncPreview: async (plan) => {
        return this.showPlanAlert("firstSync", plan);
      },
      onConfirmThreshold: async (plan) => {
        return this.showPlanAlert("threshold", plan);
      },
      onStateChange: () => {
        this.updateStatusBar();
        this.syncView?.render();
      },
    });
    this.diag.log("execute", `first sync result: ${result.message}`);
    await this.handleSyncResult(result, "first");
    } finally {
      this.releaseOpLock();
    }
  }

  /** Start a manual sync */
  async startManualSync(): Promise<void> {
    if (!this.syncExecutor) return;
    if (this.acquireOpLock("sync")) return;
    try {
    await this.ensureStateLoaded();
    if (!await this.checkAccountBinding()) return;

    // If a plan review is pending, execute it directly — but keep the
    // reviewed bundle in state until SyncExecutor re-validates its digest.
    const skipConfirmation = this.state?.planReviewActive ?? false;

    this.progressStore.markStarted();
    const result = await this.syncExecutor.run(
      "manual",
      {
        onProgress: (current, total, currentFile) => {
          this.handleProgress(current, total, currentFile);
          this.updateStatusBar();
          this.syncView?.render();
        },
        onFileProgress: (downloaded, total) => {
          this.handleFileProgress(downloaded, total);
        },
        onFileComplete: (path, actionType, success, reason, fileSize) => {
          this.handleFileComplete(path, actionType, success, reason, fileSize);
        },
        onConfirmThreshold: async (plan) => {
          return this.showPlanAlert("threshold", plan);
        },
        onStateChange: () => {
          this.updateStatusBar();
          this.syncView?.render();
        },
      },
      skipConfirmation,
    );
    this.diag.log("execute", `manual sync result: ${result.message}`);
    await this.handleSyncResult(result, "manual");
    } finally {
      this.releaseOpLock();
    }
  }

  /**
   * Persist the plan's conflict and delete items to state, then show
   * a lightweight alert. Sync pauses until the user clicks "确认执行"
   * in the sidebar. Returns false to indicate the sync should pause.
   */
  private async showPlanAlert(
    _kind: "firstSync" | "threshold",
    plan: SyncPlan,
  ): Promise<boolean> {
    const t = this.i18n.t.bind(this.i18n);

    const conflictItems = plan.items.filter(i => i.type === "conflict");

    const counts = {
      uploads: plan.items.filter(i => i.type === "upload").length,
      downloads: plan.items.filter(i => i.type === "download").length,
      deletes: plan.items.filter(i => i.type === "deleteRemote" || i.type === "confirmLocalDelete").length,
      conflicts: conflictItems.length,
      skipped: plan.items.filter(i => i.type === "skipLargeFile" || i.type === "skipIgnoredPath").length,
    };
    await this.state!.setPlanReviewBundle(plan.items, counts);

    // Refresh sidebar to show plan review section
    this.updateStatusBar();
    this.syncView?.render();

    // Show lightweight alert (non-blocking)
    const modal = new SyncPlanAlertModal(
      this.app,
      t("syncPlan.readyTitle"),
      t("syncPlan.readyMessage"),
      t("syncPlan.viewButton"),
      () => this.activateSyncView(),
    );
    modal.open();

    // Always return false — sync pauses for sidebar confirmation
    return false;
  }

  // ---- Progress helpers ----

  /** Forward progress from executor to the store for sync-view display.
   *  Phase and progress are set directly by the executor on the store;
   *  this callback only triggers UI refresh. */
  private handleProgress(_current: number, _total: number, _currentFile: string): void {
    // Store already updated by SyncExecutor — just refresh UI
  }

  /** Track byte-level progress for the current file download */
  private handleFileProgress(downloaded: number, total: number): void {
    this.progressStore?.setByteProgress(downloaded, total);
    // render() uses requestAnimationFrame — multiple calls per frame are
    // coalesced, so calling on every byte chunk is safe and efficient.
    this.syncView?.render();
  }

  /** Track a completed file in the progress store */
  private handleFileComplete(path: string, actionType: SyncActionType, success: boolean, reason?: string, fileSize?: number): void {
    const status = success
      ? SyncProgressStore.actionToStatus(actionType)
      : "error";
    this.progressStore.addCompletedFile({ path, status, actionType, reason, fileSize });
  }

  async cancelSync(): Promise<void> {
    if (!this.syncExecutor?.isRunning) return;
    this.progressStore.requestCancel();
    this.syncExecutor.cancel();
    this.diag.log("execute", "sync cancellation requested, waiting for drain...");
    this.updateStatusBar();
    this.syncView?.render();

    const deadline = Date.now() + 30_000;
    while (this.syncExecutor.isRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.syncExecutor.isRunning) {
      this.diag.warn("execute", "sync did not drain within 30s timeout");
    } else {
      this.diag.log("execute", "sync drained after cancellation");
    }

    this.updateStatusBar();
    this.syncView?.render();
  }

  /** Reset sync state safely — cancels running sync, acquires lock, clears state. */
  async resetSyncState(): Promise<void> {
    if (this.syncExecutor?.isRunning) {
      await this.cancelSync();
    }
    const holder = this.acquireOpLock("reset");
    if (holder) {
      new Notice(this.i18n.t("result.lockBusy"));
      return;
    }
    try {
      await this.ensureStateLoaded();
      await this.state?.reset();
      await this.scanner?.clearScanCache();
      new Notice("Sync state reset");
      this.updateStatusBar();
      this.syncView?.render();
    } finally {
      this.releaseOpLock();
    }
  }

  /** Log out safely — cancels running sync, acquires lock, clears auth. */
  async logoutUser(): Promise<void> {
    if (this.syncExecutor?.isRunning) {
      await this.cancelSync();
    }
    const holder = this.acquireOpLock("logout");
    if (holder) {
      new Notice(this.i18n.t("result.lockBusy"));
      return;
    }
    try {
      await this.auth?.logout();
    } finally {
      this.releaseOpLock();
    }
  }

  private async handleSyncResult(result: SyncResult, mode: SyncMode): Promise<void> {
    await this.recordSyncHistory(result, mode);
    // Show user-visible notification when auth expires — the sidebar status
    // alone is too subtle; users won't notice unless they open the sync view.
    if (result.authExpired) {
      new Notice(this.i18n.t("result.authExpired"));
    }
    const pauseAutoSync = result.errors > 0
      || result.authExpired
      || result.message === this.i18n.t("result.cancelled");
    if (pauseAutoSync) {
      this.autoSyncPaused = true;
      this.stopAutoSync();
      await this.saveSyncSettings();
      this.diag.warn("execute", `auto sync paused after incomplete run: ${result.message}`);
      this.clearRibbonSuccess();
      this.updateStatusBar();
      this.syncView?.render();
      return;
    }
    if (result.success && this.autoSyncPaused) {
      this.autoSyncPaused = false;
      await this.saveSyncSettings();
      this.startAutoSync();
    }
    // Reset the auto-sync timer after a successful auto-sync so the
    // full interval gap is guaranteed (prevents back-to-back cycles on
    // slow mobile networks where sync duration approaches the interval).
    if (result.success && mode === "auto") {
      this.startAutoSync();
    }
    if (result.success) this.showRibbonSuccess();
    else this.clearRibbonSuccess();
    this.updateStatusBar();
    this.syncView?.render();
  }

  private async recordSyncHistory(result: SyncResult, mode: SyncMode): Promise<void> {
    if (!this.state) return;
    const progress = this.progressStore.state;
    if (
      progress.startedAt <= 0
      || result.message === this.i18n.t("result.pausedForReview")
      || result.message === this.i18n.t("result.alreadyRunning")
    ) {
      return;
    }
    const endedAt = Date.now();
    const status = result.success
      ? "success"
      : result.message === this.i18n.t("result.cancelled")
        ? "cancelled"
        : result.authExpired
          ? "authExpired"
          : result.errors > 0
            ? "partial"
            : "failed";
    try {
      await this.state.addSyncHistory({
        id: `${progress.startedAt}-${endedAt}`,
        mode,
        status,
        startedAt: progress.startedAt,
        endedAt,
        uploaded: result.uploaded,
        downloaded: result.downloaded,
        deleted: result.deleted,
        conflicts: result.conflicts,
        skipped: result.skippedLarge + result.skippedIgnored,
        skippedLarge: result.skippedLarge,
        skippedIgnored: result.skippedIgnored,
        errors: result.errors,
        message: result.message,
        files: [...progress.completedFiles],
        uploadBytes: result.metrics?.uploadBytes,
        uploadReadMs: result.metrics?.uploadReadMs,
        uploadNetworkMs: result.metrics?.uploadNetworkMs,
        peakUploads: result.metrics?.peakUploads,
      });
    } catch (error) {
      this.diag.warn(
        "state",
        `sync history save failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---- Auto-sync ----

  startAutoSync(): void {
    this.stopAutoSync();
    if (this.syncInterval <= 0 || this.autoSyncPaused) return;
    this.autoSyncTimer = setInterval(async () => {
      // Skip if auth not ready, sync already running, or lock held
      if (!this.auth?.authState.isLoggedIn) return;
      if (this.opLock !== null) return;
      if (this.syncExecutor && !this.syncExecutor.isRunning) {
        if (this.acquireOpLock("sync")) return;
        try {
        await this.ensureStateLoaded();
        if (!await this.checkAccountBinding()) return;
        if (this.state?.planReviewActive) {
          this.diag.log("execute", "auto sync skipped — plan review pending");
          return;
        }
        this.progressStore.markStarted();
        const result = await this.syncExecutor.run("auto", {
          onProgress: (current, total, currentFile) => {
            this.handleProgress(current, total, currentFile);
            this.updateStatusBar();
            this.syncView?.render();
          },
          onFileProgress: (downloaded, total) => {
            this.handleFileProgress(downloaded, total);
          },
          onFileComplete: (path, actionType, success, reason) => {
            this.handleFileComplete(path, actionType, success, reason);
          },
          onConfirmThreshold: async () => {
            // Auto-sync never interrupts with a modal.
            // If threshold exceeded, skip and surface in status bar.
            return false;
          },
          onStateChange: () => {
            this.updateStatusBar();
            this.syncView?.render();
          },
        });
        await this.handleSyncResult(result, "auto");
        } finally {
          this.releaseOpLock();
        }
      }
    }, this.syncInterval * 60 * 1000);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  restartAutoSync(): void {
    this.startAutoSync();
  }

  // ---- Settings persistence ----

  async loadSyncSettings(): Promise<void> {
    const data = await this.loadData();
    if (data) {
      if (typeof data[KEY_SYNC_INTERVAL] === "number") this.syncInterval = data[KEY_SYNC_INTERVAL];
      if (typeof data[KEY_SYNC_PLUGIN_FILES] === "boolean") this.syncPluginFiles = data[KEY_SYNC_PLUGIN_FILES];
      if (typeof data[KEY_DIAG_LOG] === "boolean") this.diagLogEnabled = data[KEY_DIAG_LOG];
      if (typeof data[KEY_SYNC_EDITOR] === "boolean") this.syncEditorSettings = data[KEY_SYNC_EDITOR];
      if (typeof data[KEY_SYNC_APPEARANCE] === "boolean") this.syncAppearance = data[KEY_SYNC_APPEARANCE];
      if (typeof data[KEY_SYNC_THEMES] === "boolean") this.syncThemes = data[KEY_SYNC_THEMES];
      if (typeof data[KEY_SYNC_HOTKEYS] === "boolean") this.syncHotkeys = data[KEY_SYNC_HOTKEYS];
      if (typeof data[KEY_SYNC_CORE_PLUGINS] === "boolean") this.syncCorePlugins = data[KEY_SYNC_CORE_PLUGINS];
      if (typeof data[KEY_SYNC_COMMUNITY_PLUGINS] === "boolean") this.syncCommunityPlugins = data[KEY_SYNC_COMMUNITY_PLUGINS];
      if (typeof data[KEY_SYNC_PLUGIN_DATA] === "boolean") this.syncPluginData = data[KEY_SYNC_PLUGIN_DATA];
      if (typeof data[KEY_AUTO_SYNC_PAUSED] === "boolean") this.autoSyncPaused = data[KEY_AUTO_SYNC_PAUSED];
      if (typeof data[KEY_MAX_FILE_SIZE_MB] === "number") this.syncMaxFileSizeMb = data[KEY_MAX_FILE_SIZE_MB];
      if (typeof data[KEY_AUTO_MERGE] === "boolean") this.autoMerge = data[KEY_AUTO_MERGE];
    }
    this.applyPluginFilesSetting();
    this.applyMaxFileSize();
    this.applyDiagnosticSetting();
  }

  /** M14: serialized PluginData write. All callers (StateManager, settings,
   *  auth profile) mutate through this queue — no interleaved load-modify-save. */
  async updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void> {
    const task = this.pluginDataQueue.then(async () => {
      const data = (await this.loadData()) ?? {};
      mutator(data);
      await this.saveData(data);
    });
    this.pluginDataQueue = task.catch(() => undefined);
    return task;
  }

  async saveSyncSettings(): Promise<void> {
    await this.updatePluginData((data) => {
      data[KEY_SYNC_INTERVAL] = this.syncInterval;
      data[KEY_SYNC_PLUGIN_FILES] = this.syncPluginFiles;
      data[KEY_DIAG_LOG] = this.diagLogEnabled;
      data[KEY_SYNC_EDITOR] = this.syncEditorSettings;
      data[KEY_SYNC_APPEARANCE] = this.syncAppearance;
      data[KEY_SYNC_THEMES] = this.syncThemes;
      data[KEY_SYNC_HOTKEYS] = this.syncHotkeys;
      data[KEY_SYNC_CORE_PLUGINS] = this.syncCorePlugins;
      data[KEY_SYNC_COMMUNITY_PLUGINS] = this.syncCommunityPlugins;
      data[KEY_SYNC_PLUGIN_DATA] = this.syncPluginData;
      data[KEY_AUTO_SYNC_PAUSED] = this.autoSyncPaused;
      data[KEY_MAX_FILE_SIZE_MB] = this.syncMaxFileSizeMb;
      data[KEY_AUTO_MERGE] = this.autoMerge;
    });
  }

  /** Build includePaths from all config sync toggles and apply to scanner. */
  applyPluginFilesSetting(): void {
    const paths = new Set<string>();

    // EasySync self-sync (default on)
    if (this.syncPluginFiles) paths.add(".obsidian/plugins/easy-sync/");

    // Editor
    if (this.syncEditorSettings) paths.add(".obsidian/app.json");

    // Appearance settings
    if (this.syncAppearance) paths.add(".obsidian/appearance.json");

    // Themes & snippets
    if (this.syncThemes) {
      paths.add(".obsidian/themes/");
      paths.add(".obsidian/snippets/");
    }

    // Hotkeys
    if (this.syncHotkeys) paths.add(".obsidian/hotkeys.json");

    // Core plugins (built-in enable states only, no code files)
    if (this.syncCorePlugins) paths.add(".obsidian/core-plugins.json");

    // Community plugins (enable list + code files, no data.json)
    if (this.syncCommunityPlugins) {
      paths.add(".obsidian/community-plugins.json");
      paths.add(".obsidian/plugins/");
    }

    // Plugin data (data.json only)
    if (this.syncPluginData) {
      paths.add(".obsidian/plugins/");
    }

    this.scanner?.setConfig({
      includePaths: [...paths],
      includePluginCode: this.syncCommunityPlugins,
      includePluginData: this.syncPluginData,
    });
  }

  /** Apply diagnostic logging setting. Public so settings-tab can call it. */
  applyDiagnosticSetting(): void {
    if (this.diagLogEnabled) {
      this.diag.enableAll();
    } else {
      this.diag.clear();
    }
  }

  /** Generate a diagnostic report Markdown file in the vault root.
   *  Collects recent anomalies from state and diagnostic buffer. */
  async generateDiagnosticReport(): Promise<void> {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const tsFile = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const fileName = `EasySync 诊断报告 ${tsFile}.md`;

    const fmt = (ts: number) => {
      if (!ts) return "—";
      const d = new Date(ts);
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const fmtShort = (ts: number) => {
      if (!ts) return "—";
      const d = new Date(ts);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const auth = this.auth?.authState;
    const lines: string[] = [];

    // ── Header ──
    lines.push("# EasySync 诊断报告");
    lines.push("");
    lines.push(`**生成时间**: ${fmt(now.getTime())}`);
    lines.push(`**插件版本**: ${this.manifest.version}`);
    lines.push(`**仓库名**: ${this.app.vault.getName()}`);
    lines.push(`**登录账号**: ${auth?.isLoggedIn ? auth.displayName || auth.accountId : "未登录"}`);
    if (this.syncInterval > 0) {
      lines.push(`**自动同步**: ${this.autoSyncPaused ? "已暂停" : `运行中（每 ${this.syncInterval} 分钟）`}`);
    } else {
      lines.push("**自动同步**: 已关闭");
    }
    const platformLabel = Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : Platform.isMobile ? "Mobile" : "Desktop";
    lines.push(`**平台**: ${platformLabel}`);
    lines.push(`**上次同步**: ${fmt(this.state?.lastSyncTime ?? 0)}`);
    lines.push(`**远端快照**: generation ${this.state?.remoteGeneration ?? 0}`);
    lines.push("");

    // ── Sync History ──
    const history = this.state?.syncHistory ?? [];
    lines.push("## 近期同步记录");
    lines.push("");
    if (history.length === 0) {
      lines.push("*暂无同步记录*");
    } else {
      lines.push("| 时间 | 模式 | 状态 | 耗时 | 上传 | 下载 | 删除 | 冲突 | 跳过(L/I) | 错误 |");
      lines.push("|------|------|------|------|------|------|------|------|-----------|------|");
      for (const h of history) {
        const mode = h.mode === "manual" ? "手动" : h.mode === "auto" ? "自动" : "首次";
        const statusMap: Record<string, string> = { success: "已完成", partial: "部分完成", cancelled: "已取消", authExpired: "登录过期", failed: "失败" };
        const status = statusMap[h.status] ?? h.status;
        const duration = h.endedAt > 0 && h.startedAt > 0 ? `${Math.round((h.endedAt - h.startedAt) / 1000)}s` : "—";
        const skipLarge = h.skippedLarge ?? 0;
        const skipIgnored = h.skippedIgnored ?? 0;
        lines.push(`| ${fmt(h.startedAt)} | ${mode} | ${status} | ${duration} | ${h.uploaded} | ${h.downloaded} | ${h.deleted} | ${h.conflicts} | ${skipLarge}/${skipIgnored} | ${h.errors} |`);
      }
    }
    lines.push("");

    const formatSize = (bytes?: number): string => {
      if (bytes === undefined || bytes === null) return "?";
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    };

    // ── Action label map (shared by failed files & pending issues) ──
    const actionLabels: Record<string, string> = {
      upload: "上传", download: "下载", deleteRemote: "远端删除", confirmLocalDelete: "确认本地删除",
      conflict: "冲突", skipLargeFile: "跳过大文件", skipIgnoredPath: "跳过忽略路径",
      retryLater: "稍后重试", renameRemote: "远端重命名", authExpired: "登录过期",
    };

    // ── Failed file details from sync history ──
    const failedFiles = history
      .filter((h) => h.status === "partial" || h.status === "failed")
      .flatMap((h) => (h.files ?? [])
        .filter((f) => f.status === "error")
        .map((f) => ({ ...f, historyStartedAt: h.startedAt })));
    if (failedFiles.length > 0) {
      lines.push("### 失败文件明细");
      lines.push("");
      for (const f of failedFiles) {
        const action = actionLabels[f.actionType ?? ""] ?? f.actionType ?? "—";
        const size = formatSize(f.fileSize);
        lines.push(`- \`${f.path}\` (${size}) — ${action} (${f.reason ?? "未知错误"}) — ${fmtShort(f.historyStartedAt)}`);
      }
      lines.push("");
    }

    // ── Pending Issues ──
    const issues = this.state?.pendingIssues ?? [];
    const conflicts = this.state?.pendingConflicts ?? [];
    const deletes = this.state?.pendingRemoteDeletes ?? [];
    lines.push("## 当前待处理问题");
    lines.push("");

    // Transmission failures (non-skip issues)
    const failures = issues.filter((i) => i.actionType !== "skipLargeFile");
    if (failures.length > 0) {
      lines.push(`### 传输异常（${failures.length}）`);
      lines.push("");
      lines.push("| 文件 | 大小 | 操作 | 原因 | 最后尝试 |");
      lines.push("|------|------|------|------|----------|");
      for (const f of failures) {
        const action = actionLabels[f.actionType ?? ""] ?? f.actionType ?? "—";
        lines.push(`| ${f.path} | ${formatSize(f.fileSize)} | ${action} | ${f.reason ?? "—"} | ${fmtShort(f.updatedAt)} |`);
      }
    } else {
      lines.push("*无传输异常*");
    }
    lines.push("");

    if (conflicts.length > 0) {
      lines.push(`### 待处理冲突（${conflicts.length}）`);
      lines.push("");
      for (const c of conflicts) lines.push(`- \`${c.path}\` — ${(c as { reason?: string }).reason ?? "冲突"}`);
    } else {
      lines.push("### 待处理冲突（0）");
      lines.push("");
      lines.push("*无*");
    }
    lines.push("");

    if (deletes.length > 0) {
      lines.push(`### 待确认删除（${deletes.length}）`);
      lines.push("");
      for (const d of deletes) lines.push(`- \`${d.path}\` — ${(d as { reason?: string }).reason ?? "已在远端删除"}`);
    } else {
      lines.push("### 待确认删除（0）");
      lines.push("");
      lines.push("*无*");
    }
    lines.push("");

    // ── Recent Diagnostic Anomalies (from disk logs) ──
    const diagAll = await this.diag.snapshot(500);
    const diagEntries = diagAll
      .filter((e) => e.lvl === "warn" || e.lvl === "error"
        || (e.cat === "onedrive" && e.lvl === "log" && e.msg.includes("downloadFile"))
      )
      .slice(-200);
    lines.push("## 近期异常日志");
    lines.push("");
    if (diagEntries.length === 0) {
      lines.push("*无异常日志（内存和磁盘均无记录）*");
    } else {
      // Split: execute errors with file paths vs other anomalies
      const execFailures = diagEntries.filter(
        (e) => e.cat === "execute" && e.lvl === "error" && e.msg.includes("FAILED:"),
      );
      const others = diagEntries.filter((e) => !execFailures.includes(e));

      if (execFailures.length > 0) {
        lines.push("### 文件传输失败详情");
        lines.push("");
        lines.push("```");
        for (const e of execFailures) {
          lines.push(`${fmtShort(e.ts)} ❌ ${e.msg}`);
          if (e.data !== undefined) {
            lines.push(`  detail: ${formatDiagData(e.data)}`);
          }
        }
        lines.push("```");
        lines.push("");
      }

      if (others.length > 0) {
        lines.push("### 其他异常");
        lines.push("");
        lines.push("```");
        for (const e of others) {
          const marker = e.lvl === "error" ? "❌" : "⚠️";
          lines.push(`${fmtShort(e.ts)} [${e.cat}] ${marker} ${e.msg}`);
          if (e.data !== undefined) {
            lines.push(`  detail: ${formatDiagData(e.data)}`);
          }
        }
        lines.push("```");
      }
    }
    lines.push("");

    await this.app.vault.adapter.write(fileName, lines.join("\n"));
    new Notice(`诊断报告已生成：${fileName}`);
  }

  /** Apply max file size setting to the scanner. Public so settings-tab can call it. */
  applyMaxFileSize(): void {
    this.scanner?.setConfig({
      maxFileSize: this.syncMaxFileSizeMb * 1024 * 1024,
    });
  }

  // ---- Status bar ----

  updateStatusBar(): void {
    this.updateRibbon();
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    const t = this.i18n.t.bind(this.i18n);

    // Auth still initializing in background -> show "Connecting..."
    if (this.auth?.isInitializing) {
      this.statusBarEl.setText(t("status.connecting"));
      return;
    }

    const authState = this.auth?.authState;
    if (!authState?.isLoggedIn) {
      this.statusBarEl.setText(t("status.notLoggedIn"));
      return;
    }

    if (this.syncExecutor?.isRunning) {
      this.statusBarEl.setText(t("status.syncing"));
      return;
    }

    // Plan review active (sync paused, user needs to confirm in sidebar)
    if (this.state?.planReviewActive) {
      this.statusBarEl.setText(t("status.planReview"));
      return;
    }

    const conflicts = this.state?.pendingConflicts?.length ?? 0;
    const deletes = this.state?.pendingRemoteDeletes?.length ?? 0;
    if (conflicts > 0 && deletes > 0) {
      this.statusBarEl.setText(t("status.conflictsAndDeletes", { conflicts, deletes }));
      return;
    }
    if (conflicts > 0) {
      this.statusBarEl.setText(t("status.conflicts", { count: conflicts }));
      return;
    }
    if (deletes > 0) {
      this.statusBarEl.setText(t("status.pendingDeletes", { count: deletes }));
      return;
    }

    const lastSync = this.state?.lastSyncTime;
    if (lastSync) {
      this.statusBarEl.setText(t("status.lastSync", { time: new Date(lastSync).toLocaleTimeString() }));
    } else {
      this.statusBarEl.setText(t("status.ready"));
    }
  }

  private updateRibbon(): void {
    if (!this.ribbonEl) return;
    if ((this.auth?.isInitializing ?? true) || !this._stateLoaded) return;
    const status = this.getRibbonStatus();
    const label = this.i18n.t(`ribbon.${status}`);
    setIcon(this.ribbonEl, RIBBON_STATUS_ICONS[status]);
    setTooltip(this.ribbonEl, label);
    this.ribbonEl.setAttr("aria-label", label);
    this.ribbonEl.dataset.easySyncStatus = status;
  }

  private getRibbonStatus(): RibbonStatus {
    return resolveRibbonStatus({
      loggedIn: this.auth?.authState.isLoggedIn ?? false,
      cancelling: this.progressStore.state.cancelRequested,
      syncing: this.syncExecutor?.isRunning ?? false,
      needsAttention: this.autoSyncPaused
        || (this.state?.planReviewActive ?? false)
        || (this.state?.pendingIssues.length ?? 0) > 0
        || (this.state?.pendingConflicts.length ?? 0) > 0
        || (this.state?.pendingRemoteDeletes.length ?? 0) > 0,
      recentSuccess: this.ribbonSuccessVisible,
    });
  }

  private async handleRibbonClick(): Promise<void> {
    if ((this.auth?.isInitializing ?? true) || !this._stateLoaded) return;
    switch (this.getRibbonStatus()) {
      case "loggedOut":
        this.openPluginSettings();
        return;
      case "ready":
        await this.startManualSync();
        return;
      default:
        await this.activateSyncView();
    }
  }

  openPluginSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open: () => void; openTabById: (id: string) => void };
    }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  private showRibbonSuccess(): void {
    this.clearRibbonSuccess();
    this.ribbonSuccessVisible = true;
    this.ribbonSuccessTimer = setTimeout(() => {
      this.ribbonSuccessVisible = false;
      this.ribbonSuccessTimer = null;
      this.updateStatusBar();
    }, RIBBON_SUCCESS_DURATION_MS);
  }

  private clearRibbonSuccess(): void {
    if (this.ribbonSuccessTimer) clearTimeout(this.ribbonSuccessTimer);
    this.ribbonSuccessTimer = null;
    this.ribbonSuccessVisible = false;
  }

  // ---- SecretStorage wrappers ----

  private async saveSecret(key: string, value: string): Promise<void> {
    this.app.secretStorage?.setSecret(key, value);
  }

  private async loadSecret(key: string): Promise<string | null> {
    return this.app.secretStorage?.getSecret(key) ?? null;
  }

  private async removeSecret(key: string): Promise<void> {
    const ss = this.app.secretStorage;
    if (!ss) return;
    // Feature-detect: deleteSecret exists at runtime (>= 1.11.4) but TS types
    // haven't caught up. Fallback to overwriting with empty string if unavailable.
    if (typeof (ss as unknown as Record<string, unknown>).deleteSecret === "function") {
      (ss as unknown as { deleteSecret: (k: string) => void }).deleteSecret(key);
    } else {
      // On older versions without deleteSecret, clear the value.
      // AuthModule treats empty string as "no token".
      ss.setSecret(key, "");
    }
  }
}

/** Format diag entry data for human-readable report output.
 *  Strings are returned as-is; objects/arrays are JSON-stringified. */
function formatDiagData(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
