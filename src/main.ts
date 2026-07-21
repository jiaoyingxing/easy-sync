import { Platform, Plugin, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import { AuthModule, type AuthPluginContext } from "./auth/auth-module";
import { createAuthBrowserLauncher } from "./auth/auth-browser";
import {
  compatClearInterval,
  compatClearTimeout,
  compatCancelAnimationFrame,
  compatRequestAnimationFrame,
  compatSetInterval,
  compatSetTimeout,
  type AnimationFrameHandle,
  getConfigDir,
  getEasySyncPaths,
  IntervalHandle,
  isRecord,
  TimeoutHandle,
} from "./obsidian-compat";
import { OneDriveClient } from "./onedrive/client";
import { LocalScanner } from "./sync/local-scanner";
import { SyncEngine } from "./sync/sync-engine";
import { StateManager } from "./sync/state-manager";
import {
  SyncExecutor,
  type SyncCallbacks,
  type SyncMode,
  type SyncResult,
  type SyncRunOptions,
  type ReviewedContentEqualityProof,
} from "./sync/sync-executor";
import {
  isAnySyncActivityRunning,
  SyncProgressStore,
} from "./sync/sync-progress";
import { DiagnosticLogger } from "./sync/diagnostic-logger";
import { EasySyncSettingTab } from "./ui/settings-tab";
import { EasySyncSyncView, SYNC_VIEW_TYPE } from "./ui/sync-view";
import {
  RIBBON_STATUS_ICONS,
  resolveRibbonStatus,
  resolveRibbonStatusLabel,
  type RibbonStatus,
} from "./ui/ribbon-status";
import { SyncPlanAlertModal } from "./ui/confirm-modal";
import type { PlanReviewAuthorization, SyncPlan } from "./sync/types";
import { SyncActionType } from "./sync/types";
import { I18n } from "./i18n/index";
import { OperationLifecycle } from "./sync/operation-lifecycle";
import { EasySyncNoticeCenter, NOTICE_PRIORITY } from "./ui/notice-center";
import {
  createSyncProgressNoticeMessage,
  formatSyncProgressNoticeLabel,
  resolveSyncProgressNoticePresentation,
  resolveSyncNoticeOutcome,
  shouldSuppressSyncNoticeForMobileSidebar,
  type SyncNoticeOutcomeKind,
} from "./ui/sync-notice";
import {
  AutoSyncDirtyHint,
  LOCAL_DIRTY_DEBOUNCE_MS,
} from "./sync/auto-sync-dirty-hint";
import { sha256Hex } from "./crypto";
import {
  buildConflictEvidence,
  findLatestAutomaticHandlingSummary,
  findLatestNetworkSummary,
  findLatestPhaseSummary,
  findLatestTransferSummary,
  fingerprintOpaqueValue,
  summarizeMutationRecovery,
} from "./sync/diagnostic-report-evidence";
import {
  DEFAULT_AUTOMATIC_HANDLING_POLICY,
  readAutomaticHandlingPolicy,
  type AutomaticHandlingPolicy,
} from "./sync/automatic-handling-policy";

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
const KEY_LEGACY_AUTO_MERGE = "sync-auto-merge";
const KEY_AUTOMATIC_HANDLING_POLICY = "sync-auto-conflict-policy";
const KEY_PROFILE_CACHE = "easy-sync-profile-cache";
const RIBBON_SUCCESS_DURATION_MS = 5_000;
const SYNC_RESULT_NOTICE_DURATION_MS = 2_000;
const SYNC_PROGRESS_NOTICE_KEY = "sync-progress";

function clonePluginData(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

function measurePluginDataWrite(data: Record<string, unknown>): {
  serializedBytes: number;
  topLevelKeys: number;
  largestKeys: Array<{ key: string; bytes: number }>;
} {
  const encoder = new TextEncoder();
  const serializedBytes = encoder.encode(JSON.stringify(data)).byteLength;
  const largestKeys = Object.entries(data)
    .map(([key, value]) => {
      const serialized = JSON.stringify(value);
      return { key, bytes: serialized === undefined ? 0 : encoder.encode(serialized).byteLength };
    })
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 5);
  return { serializedBytes, topLevelKeys: Object.keys(data).length, largestKeys };
}

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
  noticeCenter: EasySyncNoticeCenter = new EasySyncNoticeCenter();
  i18n: I18n = new I18n("en");
  diag: DiagnosticLogger = new DiagnosticLogger();

  // M14: single serialized write queue for PluginData — prevents
  // StateManager.save() / saveSyncSettings() / auth profile writes
  // from racing on loadData → modify → saveData cycles.
  private pluginDataQueue: Promise<void> = Promise.resolve();
  private pluginDataCache: Record<string, unknown> | null | undefined;
  private pluginDataLoadPromise: Promise<Record<string, unknown> | null> | null = null;

  syncInterval = 3;
  syncPluginFiles = false; // M19: EasySync self-sync default OFF — explicit opt-in
  syncMaxFileSizeMb = 500;
  automaticHandlingPolicy: AutomaticHandlingPolicy = {
    ...DEFAULT_AUTOMATIC_HANDLING_POLICY,
  };
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
  private autoSyncTimer: IntervalHandle | null = null;
  private readonly autoSyncDirtyHint = new AutoSyncDirtyHint(
    () => this.runAutomaticSync("dirty"),
  );
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private ribbonSuccessTimer: TimeoutHandle | null = null;
  private ribbonSuccessVisible = false;
  private settingsTab: EasySyncSettingTab | null = null;
  private stateLoadPromise: Promise<void> | null = null;
  private syncNoticeFrame: AnimationFrameHandle | null = null;
  private syncNoticeSignature: string | null = null;
  private readonly operationLifecycle = new OperationLifecycle();

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
    this.diag.setAdapter(this.app.vault.adapter, getConfigDir(this.app.vault));

    // ════ ① Fast init (all synchronous / negligible I/O) ════

    const lang = I18n.detectLanguage(this.app as unknown as { vault: { getConfig: (key: string) => string } });
    this.i18n = new I18n(lang);
    await this.loadSyncSettings();

    // ════ ② Auth (create, register callback, then background-init) ════

    const authBrowser = createAuthBrowserLauncher({
      isDesktopApp: Platform.isDesktopApp,
      onPopupNavigationError: (error) => {
        this.diag.warn("auth", "failed to navigate auth popup, falling back to direct open", error);
      },
    });
    const authCtx: AuthPluginContext = {
      secretStorage: {
        set: (key, value) => this.saveSecret(key, value),
        get: (key) => this.loadSecret(key),
        remove: (key) => this.removeSecret(key),
      },
      registerProtocolHandler: (action, handler) => {
        this.registerObsidianProtocolHandler(action, handler);
      },
      openAuthPopup: authBrowser.openAuthPopup,
      openUrl: authBrowser.openUrl,
      // User profile cache: avoid network call on every cold start
      profileCache: {
        get: async () => {
          const data = await this.loadPluginData();
          const cached = data?.[KEY_PROFILE_CACHE];
          if (!isRecord(cached)) return null;
          return typeof cached.displayName === "string" && typeof cached.accountId === "string"
            ? { displayName: cached.displayName, accountId: cached.accountId }
            : null;
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
    this.auth = new AuthModule(authCtx, (key, params) => this.i18n.t(key, params));

    // CRITICAL: register callback BEFORE initialize() so UI updates
    // when the background token refresh completes
    this.auth.onStateChange(() => {
      this.updateStatusBar();
      this.syncView?.render();
      this.settingsTab?.refreshAuthState();
    });

    // ════ ③ Sync engine + scanner (no state load yet) ════

    this.engine = new SyncEngine();
    this.state = new StateManager({
      loadData: () => this.loadPluginData(),
      updatePluginData: (mutator) => this.updatePluginData(mutator),
      app: this.app,
      manifest: this.manifest,
    });
    // Reset circuit breakers on fresh OAuth login — old failures may
    // be due to stale auth scope and are no longer predictive.
    authCtx.onFreshLogin = () => {
      void this.state!.resetCircuitBreakers().catch((error) => {
        this.diag.warn("state", "failed to reset circuit breakers after fresh login", error);
      });
    };
    // Loaded in the background after UI registration so Ribbon state is accurate.

    this.scanner = new LocalScanner(this.app.vault, undefined, this.manifest.id);
    this.scanner.setDiag(this.diag);
    this.applyPluginFilesSetting(); // Apply saved setting after scanner is created
    this.onedrive = new OneDriveClient(
      () => this.auth!.getAccessToken(),
      this.diag,
      getConfigDir(this.app.vault),
      this.manifest.id,
    );
    this.syncExecutor = new SyncExecutor(
      this.onedrive,
      this.scanner,
      this.engine,
      this.state,
      this.app.vault.getName(),
      this.i18n,
      this.progressStore,
      this.diag,
      this.app.fileManager,
      () => {
        this.updateStatusBar();
        this.syncView?.render();
        this.settingsTab?.refreshSyncState();
      },
      this.operationLifecycle,
      this.noticeCenter,
    );
    this.syncExecutor.setAutomaticHandlingPolicy(this.automaticHandlingPolicy);

    // ════ ④ Register UI (Obsidian is usable from here on) ════

    this.settingsTab = new EasySyncSettingTab(this);
    this.addSettingTab(this.settingsTab);
    this.registerView(
      SYNC_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new EasySyncSyncView(leaf, this),
    );
    this.registerEvent(this.app.workspace.on(
      "layout-change",
      () => this.refreshSyncNoticeVisibility(),
    ));
    this.registerEvent(this.app.workspace.on(
      "active-leaf-change",
      () => this.refreshSyncNoticeVisibility(),
    ));
    this.ribbonEl = this.addRibbonIcon(
      "cloud",
      this.i18n.t("syncView.title"),
      () => this.handleRibbonClick(),
    );
    this.ribbonEl.addClass("easy-sync-ribbon");
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar(); // Shows "Connecting…" while auth initializes
    this.addCommand({
      id: "start-sync",
      name: this.i18n.t("command.syncNow"),
      callback: () => {
        void this.startManualSync();
      },
    });
    this.addCommand({
      id: "show-detail",
      name: this.i18n.t("command.showDetail"),
      callback: () => {
        void this.activateSyncView();
      },
    });

    // ════ ⑤ Background auth init (non-blocking) ════

    void this.auth.initialize().catch((e) => {
      this.diag.warn("lifecycle", "background auth init failed", e);
    });
    // onStateChange callback fires when complete → UI auto-refreshes
    void this.ensureStateLoaded()
      .then(() => this.updateStatusBar())
      .catch((e) => this.diag.warn("state", "background state load failed", e));

    // ════ ⑥ Auto-sync timer (skips until auth is ready) ════

    this.registerEvent(this.app.vault.on("create", (file) => this.markLocalDirtyHint(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.markLocalDirtyHint(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.markLocalDirtyHint(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.markLocalDirtyHint(file.path, oldPath)));
    this.startAutoSync();

    this.diag.log("lifecycle", "onload complete (auth initializing in background)");
  }

  onunload(): void {
    this.diag.log("lifecycle", "unloading");
    this.syncExecutor?.invalidateLifecycle("unload");
    // Sever the UI gateway immediately. The invalidated executor object stays
    // alive only for already-captured async work to drain safely.
    this.syncExecutor = null;
    this.stopAutoSync();
    compatClearTimeout(this.ribbonSuccessTimer);
    compatCancelAnimationFrame(this.syncNoticeFrame);
    this.noticeCenter.dispose();
    void this.diag.dispose().catch(() => undefined);
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
      await this.app.workspace.revealLeaf(existing[0]);
      this.refreshSyncNoticeVisibility();
      return;
    }
    await this.app.workspace.getLeftLeaf(false)?.setViewState({
      type: SYNC_VIEW_TYPE,
      active: true,
    });
    this.refreshSyncNoticeVisibility();
  }

  private async runSideActionIntent(
    path: string,
    failureKey: "notice.conflict.failed" | "notice.delete.failed",
    action: (executor: SyncExecutor, state: StateManager) => Promise<void>,
    requireIdleSideActions = false,
  ): Promise<boolean> {
    const executor = this.syncExecutor;
    const state = this.state;
    if (!executor || !state) return false;

    const rejectBusy = (): boolean => {
      if (this.opLock === null
        && !executor.isRunning
        && (!requireIdleSideActions || !executor.hasSideActionsInFlight)) {
        return false;
      }
      this.noticeCenter.show({
        key: `side-action-gateway:busy:${path}`,
        message: this.i18n.t(failureKey, {
          path,
          reason: this.i18n.t("result.lockBusy"),
        }),
        priority: NOTICE_PRIORITY.attention,
        className: "easy-sync-notice-action",
      });
      return true;
    };

    try {
      await this.ensureStateLoaded();
      if (rejectBusy()) return false;
      if (!await this.checkAccountBinding()) return false;
      if (rejectBusy()) return false;
      await action(executor, state);
      this.updateStatusBar();
      this.syncView?.render();
      this.settingsTab?.refreshSyncState();
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.diag.warn("execute", `side-action gateway failed — ${path}`, reason);
      this.noticeCenter.show({
        key: `side-action-gateway:failed:${path}`,
        message: this.i18n.t(failureKey, { path, reason }),
        priority: NOTICE_PRIORITY.failure,
        className: "easy-sync-notice-action",
      });
      this.updateStatusBar();
      this.syncView?.render();
      this.settingsTab?.refreshSyncState();
      return false;
    }
  }

  resolveConflictKeepLocal(path: string): Promise<boolean> {
    return this.runSideActionIntent(
      path,
      "notice.conflict.failed",
      (executor) => executor.resolveConflictKeepLocal(path),
    );
  }

  resolveConflictKeepRemote(path: string): Promise<boolean> {
    return this.runSideActionIntent(
      path,
      "notice.conflict.failed",
      (executor) => executor.resolveConflictKeepRemote(path),
    );
  }

  reconcileIdenticalConflict(
    path: string,
    proof: ReviewedContentEqualityProof,
  ): Promise<boolean> {
    return this.runSideActionIntent(
      path,
      "notice.conflict.failed",
      (executor) => executor.reconcileIdenticalConflict(path, proof),
    );
  }

  confirmRemoteDelete(path: string): Promise<boolean> {
    return this.runSideActionIntent(
      path,
      "notice.delete.failed",
      (executor) => executor.confirmRemoteDelete(path),
    );
  }

  confirmRemoteDeletes(paths: readonly string[]): Promise<boolean> {
    const requestedPaths = [...new Set(paths)];
    if (requestedPaths.length === 0) return Promise.resolve(false);
    return this.runSideActionIntent(
      requestedPaths[0],
      "notice.delete.failed",
      (executor, state) => {
        const requested = new Set(requestedPaths);
        const currentPaths = state.pendingRemoteDeletes
          .filter((item) => requested.has(item.path))
          .map((item) => item.path);
        return executor.confirmRemoteDeletes(currentPaths);
      },
    );
  }

  rejectRemoteDelete(path: string): Promise<boolean> {
    return this.runSideActionIntent(
      path,
      "notice.delete.failed",
      (executor) => executor.rejectRemoteDelete(path),
    );
  }

  dismissConflict(path: string): Promise<boolean> {
    return this.runSideActionIntent(
      path,
      "notice.conflict.failed",
      async (_executor, state) => state.removePendingConflict(path),
      true,
    );
  }

  private createSyncCallbacks(mode: SyncMode): SyncCallbacks {
    return {
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
      onFirstSyncPreview: mode === "first"
        ? async (plan) => this.showPlanAlert("firstSync", plan)
        : undefined,
      onConfirmThreshold: mode === "auto"
        ? async () => false
        : async (plan) => this.showPlanAlert("threshold", plan),
      onStateChange: () => {
        this.updateStatusBar();
        this.syncView?.render();
      },
    };
  }

  private async dispatchSyncRun(request: {
    mode: SyncMode;
    skipConfirmation?: boolean;
    reviewedAuthorization?: PlanReviewAuthorization;
    options?: SyncRunOptions;
    logLabel?: string;
    renderAfter?: boolean;
  }): Promise<SyncResult | null> {
    if (!this.syncExecutor) return null;
    this.progressStore.markStarted();
    this.beginSyncNotice();
    const result = await this.syncExecutor.run(
      request.mode,
      this.createSyncCallbacks(request.mode),
      request.skipConfirmation ?? false,
      request.reviewedAuthorization,
      request.options ?? {},
    );
    if (request.logLabel) {
      this.diag.log("execute", `${request.logLabel}: ${result.message}`);
    }
    await this.handleSyncResult(result, request.mode);
    if (request.renderAfter) this.syncView?.render();
    return result;
  }

  /** Execute a sync after the user has reviewed the plan in the sidebar.
   *  The reviewed digest may become stale before execution; in that case the
   *  executor sends the replacement plan back through the normal alert path. */
  async executePlanReview(): Promise<void> {
    if (!this.syncExecutor || !this.state) return;
    if (this.acquireOpLock("sync")) return;
    try {
    await this.ensureStateLoaded();
    if (!this.state.planReviewActive) return;
    if (!await this.checkAccountBinding()) return;
    const reviewedAuthorization = this.state.planReviewAuthorization ?? undefined;
    await this.dispatchSyncRun({
      mode: "manual",
      skipConfirmation: true,
      reviewedAuthorization,
      logLabel: "plan review execution result",
      renderAfter: true,
    });
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

  hasCompletedSyncState(): boolean {
    const baseCount = this.state?.baseSnapshot?.length ?? 0;
    return (this.state?.lastSyncTime ?? 0) > 0
      || baseCount > 0;
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
      this.operationLifecycle.invalidate("account-binding-change");
      await this.state?.bindAccount(currentId);
      return true;
    }
    if (bound !== currentId) {
      this.noticeCenter.show({
        key: "account-mismatch",
        message: this.i18n.t("notice.accountMismatch", {
          bound: `${bound.slice(0, 8)}…`,
          current: `${currentId.slice(0, 8)}…`,
        }),
        priority: NOTICE_PRIORITY.critical,
      });
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
  async startFirstSync(options: SyncRunOptions = {}): Promise<void> {
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
    await this.dispatchSyncRun({
      mode: "first",
      options,
      logLabel: "first sync result",
    });
    } finally {
      this.releaseOpLock();
    }
  }

  /** Start a manual sync */
  async startManualSync(): Promise<void> {
    if (!this.syncExecutor) return;
    if (!this.hasCompletedSyncState() && !(this.state?.planReviewActive ?? false)) {
      await this.startFirstSync();
      return;
    }
    if (this.acquireOpLock("sync")) return;
    try {
    await this.ensureStateLoaded();
    if (!await this.checkAccountBinding()) return;

    // If a plan review is pending, execute it directly — but keep the
    // reviewed bundle in state until SyncExecutor re-validates its digest.
    const skipConfirmation = this.state?.planReviewActive ?? false;
    const reviewedAuthorization = skipConfirmation
      ? this.state?.planReviewAuthorization ?? undefined
      : undefined;

    await this.dispatchSyncRun({
      mode: "manual",
      skipConfirmation,
      reviewedAuthorization,
      logLabel: "manual sync result",
    });
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

    const conflictItems = plan.items.filter((i) => i.type === SyncActionType.Conflict);

    const counts = {
      uploads: plan.items.filter((i) => i.type === SyncActionType.Upload).length,
      downloads: plan.items.filter((i) => i.type === SyncActionType.Download).length,
      deletes: plan.items.filter((i) =>
        i.type === SyncActionType.DeleteRemote
          || i.type === SyncActionType.DeleteLocal
          || i.type === SyncActionType.ConfirmLocalDelete).length,
      conflicts: conflictItems.length,
      skipped: plan.items.filter((i) =>
        i.type === SyncActionType.SkipLargeFile || i.type === SyncActionType.SkipIgnoredPath).length,
    };
    if (!plan.scope) {
      throw new Error("Cannot persist a plan review without a complete sync scope");
    }
    await this.state!.setPlanReviewBundle(plan.items, counts, plan.scope);

    // Refresh sidebar to show plan review section
    this.updateStatusBar();
    this.syncView?.render();

    // Show lightweight alert (non-blocking)
    const modal = new SyncPlanAlertModal(
      this.app,
      t("syncPlan.readyTitle"),
      t("syncPlan.readyMessage"),
      t("syncPlan.viewButton"),
      () => { void this.activateSyncView(); },
    );
    modal.open();

    // Always return false — sync pauses for sidebar confirmation
    return false;
  }

  // ---- Progress helpers ----

  private shouldSuppressSyncNotice(): boolean {
    const leftSidebar = this.app.workspace.leftSplit;
    if (!leftSidebar) return false;
    return shouldSuppressSyncNoticeForMobileSidebar({
      isMobile: Platform.isMobile,
      leftSidebarCollapsed: leftSidebar.collapsed,
      easySyncViewInLeftSidebar: this.app.workspace
        .getLeavesOfType(SYNC_VIEW_TYPE)
        .some((leaf) => leaf.parent === leftSidebar),
    });
  }

  private clearSyncLifecycleNotice(): void {
    const activeKey = this.noticeCenter.activeKey;
    this.noticeCenter.clear(SYNC_PROGRESS_NOTICE_KEY);
    if (activeKey?.startsWith("sync-result:")) this.noticeCenter.clear(activeKey);
  }

  private refreshSyncNoticeVisibility(): void {
    if (!Platform.isMobile) return;
    if (this.shouldSuppressSyncNotice()) {
      this.syncNoticeSignature = null;
      this.clearSyncLifecycleNotice();
      return;
    }
    if (this.syncExecutor?.isRunning) this.renderSyncNoticeProgress();
  }

  private beginSyncNotice(): void {
    compatCancelAnimationFrame(this.syncNoticeFrame);
    this.syncNoticeFrame = null;
    if (this.shouldSuppressSyncNotice()) {
      this.syncNoticeSignature = null;
      this.clearSyncLifecycleNotice();
      return;
    }
    const label = this.i18n.t("notice.sync.start");
    this.syncNoticeSignature = `start:${label}`;
    this.noticeCenter.show({
      key: SYNC_PROGRESS_NOTICE_KEY,
      message: () => createSyncProgressNoticeMessage(label, 0, false, false),
      priority: NOTICE_PRIORITY.progress,
      durationMs: 0,
      className: "easy-sync-notice-progress",
      resumable: true,
    });
  }

  private scheduleSyncNoticeUpdate(): void {
    if (this.syncNoticeFrame !== null) return;
    this.syncNoticeFrame = compatRequestAnimationFrame(() => {
      this.syncNoticeFrame = null;
      if (this.syncExecutor?.isRunning) this.renderSyncNoticeProgress();
    });
  }

  private renderSyncNoticeProgress(): void {
    if (this.shouldSuppressSyncNotice()) {
      this.syncNoticeSignature = null;
      this.clearSyncLifecycleNotice();
      return;
    }
    const progress = this.progressStore.state;
    const presentation = resolveSyncProgressNoticePresentation(progress);
    const t = this.i18n.t.bind(this.i18n);
    const label = formatSyncProgressNoticeLabel(presentation, t);
    const signature = [
      presentation.kind,
      presentation.activity.kind,
      label,
      presentation.percent,
      presentation.determinate,
      presentation.showProgressBar,
    ].join(":");
    if (signature === this.syncNoticeSignature) return;
    this.syncNoticeSignature = signature;
    this.noticeCenter.show({
      key: SYNC_PROGRESS_NOTICE_KEY,
      message: () => createSyncProgressNoticeMessage(
        label,
        presentation.percent,
        presentation.determinate,
        presentation.showProgressBar,
      ),
      priority: NOTICE_PRIORITY.progress,
      durationMs: 0,
      className: "easy-sync-notice-progress",
      resumable: true,
    });
  }

  private finishSyncNotice(result: SyncResult): void {
    compatCancelAnimationFrame(this.syncNoticeFrame);
    this.syncNoticeFrame = null;
    this.syncNoticeSignature = null;
    const suppressNotice = this.shouldSuppressSyncNotice();
    this.clearSyncLifecycleNotice();

    const outcome = resolveSyncNoticeOutcome(result, {
      pausedForReview: result.message === this.i18n.t("result.pausedForReview"),
      cancelled: result.message === this.i18n.t("result.cancelled"),
    });
    if (!outcome || suppressNotice) return;

    const messageKeys: Record<SyncNoticeOutcomeKind, string> = {
      completed: "notice.sync.completed",
      conflicts: "notice.sync.conflicts",
      review: "notice.sync.review",
      cancelled: "notice.sync.cancelled",
      failed: "notice.sync.failed",
      authExpired: "notice.sync.authExpired",
    };
    const priorities: Record<SyncNoticeOutcomeKind, number> = {
      completed: NOTICE_PRIORITY.info,
      conflicts: NOTICE_PRIORITY.attention,
      review: NOTICE_PRIORITY.attention,
      cancelled: NOTICE_PRIORITY.action,
      failed: NOTICE_PRIORITY.failure,
      authExpired: NOTICE_PRIORITY.critical,
    };
    this.noticeCenter.show({
      key: `sync-result:${outcome.kind}`,
      message: this.i18n.t(messageKeys[outcome.kind], { count: outcome.count }),
      priority: priorities[outcome.kind],
      durationMs: SYNC_RESULT_NOTICE_DURATION_MS,
      className: "easy-sync-notice-result",
    });
  }

  /** Forward progress from executor to the store for sync-view display.
   *  Phase and progress are set directly by the executor on the store;
   *  this callback only triggers UI refresh. */
  private handleProgress(_current: number, _total: number, _currentFile: string): void {
    // Store already updated by SyncExecutor — just refresh UI
    this.scheduleSyncNoticeUpdate();
  }

  /** Track byte-level progress for the current file download */
  private handleFileProgress(downloaded: number, total: number): void {
    this.progressStore?.setByteProgress(downloaded, total);
    // render() uses requestAnimationFrame — multiple calls per frame are
    // coalesced, so calling on every byte chunk is safe and efficient.
    this.syncView?.render();
    this.scheduleSyncNoticeUpdate();
  }

  /** Track a completed file in the progress store */
  private handleFileComplete(path: string, actionType: SyncActionType, success: boolean, reason?: string, fileSize?: number): void {
    const status = success
      ? SyncProgressStore.actionToStatus(actionType)
      : "error";
    this.progressStore.completeCurrentItem();
    this.progressStore.addCompletedFile({ path, status, actionType, reason, fileSize });
    this.scheduleSyncNoticeUpdate();
  }

  async cancelSync(): Promise<void> {
    if (!this.syncExecutor?.isRunning) return;
    this.progressStore.requestCancel();
    this.scheduleSyncNoticeUpdate();
    this.syncExecutor.invalidateLifecycle("cancel");
    this.diag.log("execute", "sync cancellation requested, waiting for drain...");
    this.updateStatusBar();
    this.syncView?.render();

    const deadline = Date.now() + 30_000;
    while (this.syncExecutor.isRunning && Date.now() < deadline) {
      await new Promise<void>((resolve) => compatSetTimeout(() => resolve(), 100));
    }

    if (this.syncExecutor.isRunning) {
      this.diag.warn("execute", "sync did not drain within 30s timeout");
    } else {
      this.diag.log("execute", "sync drained after cancellation");
    }

    this.updateStatusBar();
    this.syncView?.render();
  }

  private async invalidateAndDrainSyncActivity(reason: string): Promise<boolean> {
    const executor = this.syncExecutor;
    if (!executor) {
      this.operationLifecycle.invalidate(reason);
      return true;
    }

    if (executor.isRunning) {
      this.progressStore.requestCancel();
    }
    executor.invalidateLifecycle(reason);

    const deadline = Date.now() + 30_000;
    while ((executor.hasActivityInFlight || this.opLock !== null) && Date.now() < deadline) {
      await new Promise<void>((resolve) => compatSetTimeout(() => resolve(), 100));
    }
    if (executor.hasActivityInFlight || this.opLock !== null) {
      this.diag.warn("lifecycle", `${reason} blocked because old sync work did not drain within 30s`);
      return false;
    }
    return true;
  }

  /** Reset sync state safely — cancels running sync, acquires lock, clears state. */
  async resetSyncState(): Promise<void> {
    if (!await this.invalidateAndDrainSyncActivity("reset")) {
      this.noticeCenter.show({
        key: "reset-lock-busy",
        message: this.i18n.t("result.lockBusy"),
        priority: NOTICE_PRIORITY.attention,
      });
      return;
    }
    const holder = this.acquireOpLock("reset");
    if (holder) {
      this.noticeCenter.show({
        key: "reset-lock-busy",
        message: this.i18n.t("result.lockBusy"),
        priority: NOTICE_PRIORITY.attention,
      });
      return;
    }
    try {
      await this.ensureStateLoaded();
      await this.state?.reset();
      await this.scanner?.clearScanCache();
      this.noticeCenter.show({
        key: "reset-complete",
        message: this.i18n.t("settings.reset.done"),
        priority: NOTICE_PRIORITY.action,
      });
      this.updateStatusBar();
      this.syncView?.render();
    } finally {
      this.releaseOpLock();
    }
  }

  /** Log out safely — cancels running sync, acquires lock, clears auth. */
  async logoutUser(): Promise<void> {
    if (!await this.invalidateAndDrainSyncActivity("logout")) {
      this.noticeCenter.show({
        key: "logout-lock-busy",
        message: this.i18n.t("result.lockBusy"),
        priority: NOTICE_PRIORITY.attention,
      });
      return;
    }
    const holder = this.acquireOpLock("logout");
    if (holder) {
      this.noticeCenter.show({
        key: "logout-lock-busy",
        message: this.i18n.t("result.lockBusy"),
        priority: NOTICE_PRIORITY.attention,
      });
      return;
    }
    try {
      await this.auth?.logout();
    } finally {
      this.releaseOpLock();
    }
  }

  private async handleSyncResult(result: SyncResult, mode: SyncMode): Promise<void> {
    this.finishSyncNotice(result);
    await this.recordSyncHistory(result, mode);
    const harmlessRejectedRun = result.message === this.i18n.t("result.alreadyRunning");
    const pauseAutoSync = (!result.success && !harmlessRejectedRun)
      || result.errors > 0
      || result.authExpired
      || result.message === this.i18n.t("result.cancelled")
      || result.message === this.i18n.t("result.pausedForReview")
      || (this.state?.planReviewActive ?? false);
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
    if (result.success && result.deferred === 0 && this.autoSyncPaused) {
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
    if (result.success && result.deferred === 0) this.showRibbonSuccess();
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
      ? result.deferred > 0 ? "partial" : "success"
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
        deferred: result.deferred,
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

  private markLocalDirtyHint(path: string, oldPath?: string): void {
    if (this.syncInterval <= 0 || this.autoSyncPaused) return;
    const currentIncluded = this.scanner?.shouldSyncPath(path) === true;
    const previousIncluded = oldPath !== undefined
      && this.scanner?.shouldSyncPath(oldPath) === true;
    if (!currentIncluded && !previousIncluded) return;
    if (this.autoSyncDirtyHint.mark()) {
      this.diag.log("execute", "local dirty hint scheduled normal auto sync", {
        debounceMs: LOCAL_DIRTY_DEBOUNCE_MS,
        scopeMatch: currentIncluded ? "current" : "previous",
      });
    }
  }

  /** Shared activity-gated entry for periodic reconciliation and dirty hints. */
  private async runAutomaticSync(trigger: "interval" | "dirty"): Promise<boolean> {
    if (this.syncInterval <= 0 || this.autoSyncPaused) return true;
    if (!this.auth?.authState.isLoggedIn) return true;
    if (!this.syncExecutor) return false;
    if (this.opLock !== null || this.syncExecutor.isRunning) return false;
    if (this.acquireOpLock("sync")) return false;
    let dispatched = false;
    try {
      await this.ensureStateLoaded();
      if (!await this.checkAccountBinding()) return true;
      if (this.state?.planReviewActive) {
        this.diag.log("execute", `auto sync skipped — plan review pending (${trigger})`);
        return true;
      }
      this.diag.log("execute", `auto sync started — trigger=${trigger}`);
      dispatched = true;
      await this.dispatchSyncRun({ mode: "auto" });
      return true;
    } catch (error) {
      this.diag.warn(
        "execute",
        `auto sync setup failed — trigger=${trigger}`,
        error instanceof Error ? error.message : String(error),
      );
      // Only consume a dirty hint after the executor actually received it.
      // A transient setup failure must keep the in-memory hint for retry.
      return dispatched;
    } finally {
      this.releaseOpLock();
    }
  }

  startAutoSync(): void {
    if (this.autoSyncTimer) {
      compatClearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this.syncInterval <= 0 || this.autoSyncPaused) return;
    this.autoSyncTimer = compatSetInterval(() => {
      void this.runAutomaticSync("interval");
    }, this.syncInterval * 60 * 1000);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      compatClearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    this.autoSyncDirtyHint.cancel();
  }

  restartAutoSync(): void {
    this.stopAutoSync();
    this.startAutoSync();
  }

  // ---- Settings persistence ----

  async loadSyncSettings(): Promise<void> {
    const data = await this.loadPluginData();
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
      this.automaticHandlingPolicy = readAutomaticHandlingPolicy(
        data[KEY_AUTOMATIC_HANDLING_POLICY],
        data[KEY_LEGACY_AUTO_MERGE],
      );
    }
    this.applyPluginFilesSetting();
    this.applyMaxFileSize();
    this.applyDiagnosticSetting();
  }

  /** M14: serialized PluginData write. All callers (StateManager, settings,
   *  auth profile) mutate through this queue — no interleaved load-modify-save. */
  private async updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void> {
    const task = this.pluginDataQueue.then(async () => {
      const diagnosticsEnabled = this.diag.isEnabled("state");
      const totalStartedAt = diagnosticsEnabled ? performance.now() : 0;
      const committed = await this.ensurePluginDataCache();
      // The private synchronous mutator never escapes this candidate. Keeping
      // the old cache until saveData succeeds preserves failure atomicity while
      // avoiding a second whole-object clone after the physical write.
      const data = committed === null ? {} : clonePluginData(committed);
      mutator(data);
      const prepareFinishedAt = diagnosticsEnabled ? performance.now() : 0;
      const measurementStartedAt = prepareFinishedAt;
      const measurement = diagnosticsEnabled ? measurePluginDataWrite(data) : null;
      const measurementFinishedAt = diagnosticsEnabled ? performance.now() : 0;
      const startedAt = diagnosticsEnabled ? performance.now() : 0;
      let saveMs = 0;
      let publishMs = 0;
      let success = false;
      try {
        const saveStartedAt = diagnosticsEnabled ? performance.now() : 0;
        try {
          await this.saveData(data);
        } finally {
          if (diagnosticsEnabled) saveMs = performance.now() - saveStartedAt;
        }
        const publishStartedAt = diagnosticsEnabled ? performance.now() : 0;
        this.pluginDataCache = data;
        if (diagnosticsEnabled) publishMs = performance.now() - publishStartedAt;
        success = true;
      } finally {
        if (measurement) {
          const finishedAt = performance.now();
          this.diag.log("state", "plugin data write", {
            ...measurement,
            elapsedMs: Number((finishedAt - startedAt).toFixed(3)),
            prepareMs: Number((prepareFinishedAt - totalStartedAt).toFixed(3)),
            measurementMs: Number((measurementFinishedAt - measurementStartedAt).toFixed(3)),
            saveMs: Number(saveMs.toFixed(3)),
            publishMs: Number(publishMs.toFixed(3)),
            totalMs: Number((finishedAt - totalStartedAt).toFixed(3)),
            success,
          });
        }
      }
    });
    this.pluginDataQueue = task.catch(() => undefined);
    return task;
  }

  async loadPluginData(): Promise<Record<string, unknown> | null> {
    const data = await this.ensurePluginDataCache();
    return data === null ? null : clonePluginData(data);
  }

  private async ensurePluginDataCache(): Promise<Record<string, unknown> | null> {
    if (this.pluginDataCache !== undefined) return this.pluginDataCache;
    this.pluginDataLoadPromise ??= this.loadData()
      .then((data: unknown) => {
        this.pluginDataCache = isRecord(data) ? clonePluginData(data) : null;
        return this.pluginDataCache;
      })
      .finally(() => {
        this.pluginDataLoadPromise = null;
      });
    return this.pluginDataLoadPromise;
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
      data[KEY_AUTOMATIC_HANDLING_POLICY] = { ...this.automaticHandlingPolicy };
    });
  }

  async updateAutomaticHandlingPolicy(
    policy: Readonly<AutomaticHandlingPolicy>,
  ): Promise<void> {
    const previous = this.automaticHandlingPolicy;
    this.automaticHandlingPolicy = { ...policy };
    try {
      await this.saveSyncSettings();
    } catch (error) {
      this.automaticHandlingPolicy = previous;
      throw error;
    }
    this.syncExecutor?.setAutomaticHandlingPolicy(this.automaticHandlingPolicy);
    if (this.state?.planReviewActive) {
      await this.state.clearPlanReview();
    }
    this.updateStatusBar();
    this.syncView?.render();
    this.settingsTab?.refreshSyncState();
  }

  /** Build includePaths from all config sync toggles and apply to scanner. */
  applyPluginFilesSetting(): void {
    const paths = new Set<string>();
    const { configDir, pluginDir } = getEasySyncPaths(this.app.vault, this.manifest.id);
    const pluginDirPrefix = `${pluginDir}/`;

    // EasySync self-sync (default on)
    if (this.syncPluginFiles) paths.add(pluginDirPrefix);

    // Editor
    if (this.syncEditorSettings) paths.add(`${configDir}/app.json`);

    // Appearance settings
    if (this.syncAppearance) paths.add(`${configDir}/appearance.json`);

    // Themes & snippets
    if (this.syncThemes) {
      paths.add(`${configDir}/themes/`);
      paths.add(`${configDir}/snippets/`);
    }

    // Hotkeys
    if (this.syncHotkeys) paths.add(`${configDir}/hotkeys.json`);

    // Core plugins (built-in enable states only, no code files)
    if (this.syncCorePlugins) paths.add(`${configDir}/core-plugins.json`);

    // Community plugins (enable list + code files, no data.json)
    if (this.syncCommunityPlugins) {
      paths.add(`${configDir}/community-plugins.json`);
      paths.add(`${configDir}/plugins/`);
    }

    // Plugin data (data.json only)
    if (this.syncPluginData) {
      paths.add(`${configDir}/plugins/`);
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
    const reportState = this.state;
    const reportScope = reportState?.remoteScope;
    const [accountFingerprint, driveFingerprint, vaultFingerprint, filesRootFingerprint] = await Promise.all([
      fingerprintOpaqueValue(reportScope?.accountId || reportState?.boundAccountId),
      fingerprintOpaqueValue(reportScope?.driveId),
      fingerprintOpaqueValue(reportScope?.vaultFolderId),
      fingerprintOpaqueValue(reportScope?.filesRootId),
    ]);
    const { pluginDir } = getEasySyncPaths(this.app.vault, this.manifest.id);
    let buildFingerprint = "不可用";
    try {
      const mainPath = `${pluginDir}/main.js`;
      const [mainRaw, mainStat] = await Promise.all([
        this.app.vault.adapter.readBinary(mainPath),
        this.app.vault.adapter.stat(mainPath),
      ]);
      const mainHash = await sha256Hex(mainRaw);
      buildFingerprint = `sha256:${mainHash.slice(0, 16)} (${mainRaw.byteLength}B, mtime ${fmt(mainStat?.mtime ?? 0)})`;
    } catch {
      // A missing artifact must not prevent the report itself from being generated.
    }
    const lines: string[] = [];

    // ── Header ──
    lines.push("# EasySync 诊断报告");
    lines.push("");
    lines.push(`**生成时间**: ${fmt(now.getTime())}`);
    lines.push(`**插件版本**: ${this.manifest.version}`);
    lines.push(`**仓库名**: ${this.app.vault.getName()}`);
    lines.push(`**登录账号**: ${auth?.isLoggedIn ? auth.displayName || "已登录" : "未登录"}`);
    lines.push(`**构筑物指纹**: ${buildFingerprint}`);
    if (this.syncInterval > 0) {
      lines.push(`**自动同步**: ${this.autoSyncPaused ? "已暂停" : `运行中（每 ${this.syncInterval} 分钟）`}`);
    } else {
      lines.push("**自动同步**: 已关闭");
    }
    const automaticActivity = this.syncExecutor?.isRunning
      ? "同步中"
      : this.opLock !== null
        ? "其他操作占用中"
        : "空闲";
    lines.push(`**自动同步触发**: 本地变更 ${this.autoSyncDirtyHint.pending ? "等待重试" : "无等待"} / 当前 ${automaticActivity}`);
    const platformLabel = Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : Platform.isMobile ? "Mobile" : "Desktop";
    lines.push(`**平台**: ${platformLabel}`);
    lines.push(`**上次同步**: ${fmt(this.state?.lastSyncTime ?? 0)}`);
    lines.push(`**远端快照**: generation ${reportState?.remoteGeneration ?? 0}`);
    lines.push(`**最近同步记录 ID**: ${reportState?.syncHistory?.[0]?.id ?? "—"}`);
    lines.push(`**同步范围指纹**: account ${accountFingerprint} / drive ${driveFingerprint} / vault ${vaultFingerprint} / files ${filesRootFingerprint}`);
    lines.push(`**状态规模**: 基线 ${reportState?.baseSnapshot.length ?? 0} / 远端文件 ${reportState?.remoteSnapshot.length ?? 0} / 远端目录 ${reportState?.remoteFolders.length ?? 0} / 冲突 ${reportState?.pendingConflicts.length ?? 0} / 待删除 ${reportState?.pendingRemoteDeletes.length ?? 0} / 传输异常 ${reportState?.pendingIssues.length ?? 0}`);
    lines.push(`**增量游标**: ${reportState?.remoteDeltaLink ? "已保存" : "无"}`);
    lines.push(`**计划审阅**: ${reportState?.planReviewActive ? `等待确认（revision ${reportState.planReviewRevision}）` : "无"}`);
    lines.push(`**自动处理配置**: 将远端删除同步到本地 ${this.automaticHandlingPolicy.autoDeleteLocalFiles ? "开启" : "关闭"} / 合并不重叠的文本修改 ${this.automaticHandlingPolicy.mergeNonOverlappingText ? "开启" : "关闭"}`);
    const configSyncLabels = [
      [this.syncEditorSettings, "编辑器设置"],
      [this.syncAppearance, "外观"],
      [this.syncThemes, "主题"],
      [this.syncHotkeys, "快捷键"],
      [this.syncCorePlugins, "核心插件"],
      [this.syncCommunityPlugins, "社区插件"],
      [this.syncPluginData, "插件数据"],
      [this.syncPluginFiles, "EasySync 插件文件"],
    ] as const;
    lines.push(`**已启用配置同步**: ${configSyncLabels.filter(([enabled]) => enabled).map(([, label]) => label).join("、") || "无"}`);
    lines.push("");

    // ── Sync History ──
    const history = this.state?.syncHistory ?? [];
    lines.push("## 近期同步记录");
    lines.push("");
    if (history.length === 0) {
      lines.push("*暂无同步记录*");
    } else {
      lines.push("| 时间 | 模式 | 状态 | 耗时 | 上传 | 下载 | 删除 | 冲突 | 延后 | 跳过(L/I) | 错误 |");
      lines.push("|------|------|------|------|------|------|------|------|------|-----------|------|");
      for (const h of history) {
        const mode = h.mode === "manual" ? "手动" : h.mode === "auto" ? "自动" : "首次";
        const statusMap: Record<string, string> = { success: "已完成", partial: "部分完成", cancelled: "已取消", authExpired: "登录过期", failed: "失败" };
        const status = statusMap[h.status] ?? h.status;
        const duration = h.endedAt > 0 && h.startedAt > 0 ? `${Math.round((h.endedAt - h.startedAt) / 1000)}s` : "—";
        const skipLarge = h.skippedLarge ?? 0;
        const skipIgnored = h.skippedIgnored ?? 0;
        lines.push(`| ${fmt(h.startedAt)} | ${mode} | ${status} | ${duration} | ${h.uploaded} | ${h.downloaded} | ${h.deleted} | ${h.conflicts} | ${h.deferred ?? 0} | ${skipLarge}/${skipIgnored} | ${h.errors} |`);
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
    const failures = issues.filter((i) => i.actionType !== SyncActionType.SkipLargeFile);
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
      for (const c of conflicts) {
        const evidence = buildConflictEvidence(c, reportState?.getBaseEntry(c.path));
        const eTagFingerprint = await fingerprintOpaqueValue(evidence.remoteETag);
        const reasonCode = c.reason ?? "conflict";
        const reasonText = c.reason ? this.i18n.t(c.reason) : "冲突";
        lines.push(`- \`${c.path}\` — ${reasonText} (${reasonCode})`);
        lines.push(`  - 判等证据: ${evidence.equalityStatus} / ${evidence.equalityProof}; decision token: ${evidence.hasDecisionToken ? "有" : "无"}`);
        lines.push(`  - 本地: ${formatSize(evidence.localSize)}, mtime ${fmt(evidence.localMtime ?? 0)}, sha256 ${evidence.localHash}`);
        lines.push(`  - 远端: ${formatSize(evidence.remoteSize)}, mtime ${fmt(evidence.remoteMtime ?? 0)}, sha256 ${evidence.remoteSha256}, eTag ${eTagFingerprint}`);
      }
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
    const latestAutomaticHandlingSummary = findLatestAutomaticHandlingSummary(diagAll);
    const currentRecoverySummary = summarizeMutationRecovery(
      reportState?.mutationLedger ?? [],
    );
    const latestPhaseSummary = findLatestPhaseSummary(diagAll);
    const latestNetworkSummary = findLatestNetworkSummary(diagAll);
    const latestTransferSummary = findLatestTransferSummary(diagAll);
    lines.push("## 自动处理与恢复摘要");
    lines.push("");
    lines.push("**当前恢复账本**:");
    lines.push("```json");
    lines.push(formatDiagData(currentRecoverySummary));
    lines.push("```");
    if (latestAutomaticHandlingSummary) {
      lines.push("");
      lines.push(`**最近一轮自动处理**（${fmt(latestAutomaticHandlingSummary.ts)}）:`);
      lines.push("```json");
      lines.push(formatDiagData(latestAutomaticHandlingSummary.data));
      lines.push("```");
    } else {
      lines.push("");
      lines.push("*暂无结构化自动处理摘要；开启诊断日志并完成一轮同步后再生成报告。*");
    }
    lines.push("");
    lines.push("## 最近一轮阶段耗时与请求摘要");
    lines.push("");
    if (latestPhaseSummary) {
      lines.push(`**记录时间**: ${fmt(latestPhaseSummary.ts)}`);
      lines.push("**同步阶段**:");
      lines.push("```json");
      lines.push(formatDiagData(latestPhaseSummary.data));
      lines.push("```");
    } else {
      lines.push("*暂无结构化阶段摘要；完成一轮同步后再生成报告。*");
    }
    if (latestNetworkSummary) {
      lines.push("");
      lines.push(`**OneDrive 请求与令牌获取**（${fmt(latestNetworkSummary.ts)}）:`);
      lines.push("```json");
      lines.push(formatDiagData(latestNetworkSummary.data));
      lines.push("```");
    } else {
      lines.push("");
      lines.push("*暂无结构化 OneDrive 请求摘要。*");
    }
    if (latestTransferSummary) {
      lines.push("");
      lines.push(`**文件传输与本地处理**（${fmt(latestTransferSummary.ts)}）:`);
      lines.push("```json");
      lines.push(formatDiagData(latestTransferSummary.data));
      lines.push("```");
    } else {
      lines.push("");
      lines.push("*暂无结构化文件传输摘要。*");
    }
    lines.push("");
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
    this.noticeCenter.show({
      key: "diagnostic-report-created",
      message: this.i18n.t("notice.diagnosticReportGenerated", { fileName }),
      priority: NOTICE_PRIORITY.action,
    });
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
    this.settingsTab?.refreshSyncState();
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    const t = this.i18n.t.bind(this.i18n);
    const fullSyncRunning = this.syncExecutor?.isRunning ?? false;
    const sideActionRunning = this.syncExecutor?.hasSideActionsInFlight ?? false;
    const isRunning = isAnySyncActivityRunning(this.progressStore.state, fullSyncRunning, sideActionRunning);

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

    if (isRunning) {
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
    const label = resolveRibbonStatusLabel(
      status,
      this.progressStore.state,
      this.i18n.t.bind(this.i18n),
    );
    setIcon(this.ribbonEl, RIBBON_STATUS_ICONS[status]);
    setTooltip(this.ribbonEl, label);
    this.ribbonEl.setAttr("aria-label", label);
    this.ribbonEl.dataset.easySyncStatus = status;
  }

  private getRibbonStatus(): RibbonStatus {
    const fullSyncRunning = this.syncExecutor?.isRunning ?? false;
    const sideActionRunning = this.syncExecutor?.hasSideActionsInFlight ?? false;
    return resolveRibbonStatus({
      loggedIn: this.auth?.authState.isLoggedIn ?? false,
      cancelling: this.progressStore.state.cancelRequested,
      syncing: isAnySyncActivityRunning(this.progressStore.state, fullSyncRunning, sideActionRunning),
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
    this.ribbonSuccessTimer = compatSetTimeout(() => {
      this.ribbonSuccessVisible = false;
      this.ribbonSuccessTimer = null;
      this.updateStatusBar();
    }, RIBBON_SUCCESS_DURATION_MS);
  }

  private clearRibbonSuccess(): void {
    compatClearTimeout(this.ribbonSuccessTimer);
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
