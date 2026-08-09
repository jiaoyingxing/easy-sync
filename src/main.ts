import {
  structuredCloneImplementation,
} from "./structured-clone-compat";
import { Platform, Plugin, setIcon, setTooltip, TFolder, WorkspaceLeaf } from "obsidian";
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
import {
  createFolderSyncScopeSnapshotV1,
  LocalScanner,
  normalizeExcludedFolders,
} from "./sync/local-scanner";
import {
  StateManager,
  type CommunityPluginEnablementDecisionSnapshot,
  type PendingCommunityPluginEnablementDecision,
} from "./sync/state-manager";
import {
  sameCommunityPluginEnablementDecisionSet,
  type CommunityPluginEnablementDecisionResolution,
} from "./sync/community-plugin-enablement";
import {
  IndexedDbPublic113StateStore,
  public113IndexedDbDatabaseName,
} from "./sync/indexeddb-public-1-1-3-state";
import { StateV2IndexedDbActiveStore } from "./sync/state-v2-indexeddb-active";
import {
  IndexedDbRemoteScopeRecoveryEvidenceStore,
} from "./sync/remote-scope-recovery-evidence-store";
import {
  loadOrCreateIndexedDbVaultInstanceId,
  readIndexedDbVaultInstanceId,
} from "./sync/indexeddb-vault-namespace";
import {
  SyncExecutor,
  type SyncCallbacks,
  type SyncMode,
  type SyncResult,
  type SyncRunOptions,
  type ReviewedContentEqualityProof,
} from "./sync/sync-executor";
import type {
  EmptyFolderResolutionSnapshotV1,
} from "./sync/empty-folder-resolution";
import type {
  SharedFolderIdentityResolutionSnapshotV1,
} from "./sync/shared-folder-identity-resolution";
import type {
  StaleIdentityResolutionSnapshotV1,
} from "./sync/stale-identity-resolution";
import {
  isAnySyncActivityRunning,
  SyncProgressStore,
} from "./sync/sync-progress";
import { resolveSyncActionPresentation } from "./sync/sync-action-presentation";
import { DiagnosticLogger } from "./sync/diagnostic-logger";
import { EasySyncSettingTab } from "./ui/settings-tab";
import { EasySyncSyncView, SYNC_VIEW_TYPE } from "./ui/sync-view";
import {
  RIBBON_STATUS_ICONS,
  resolveRibbonStatus,
  resolveRibbonStatusLabel,
  type RibbonStatus,
} from "./ui/ribbon-status";
import { ConfirmModal, SyncPlanAlertModal } from "./ui/confirm-modal";
import type {
  MutationRecoveryBlockReason,
  MutationRecoveryHistory,
  MutationRecoveryRunSummary,
  ManualMutationResolutionChoiceV1,
  ManualMutationResolutionSnapshotV1,
  PlanReviewAuthorization,
  ScanConfig,
  SyncPlan,
} from "./sync/types";
import {
  sameCanonicalPlanIdentityV2,
  sameSyncScope,
  SyncActionType,
} from "./sync/types";
import { I18n } from "./i18n/index";
import { OperationLifecycle } from "./sync/operation-lifecycle";
import { EasySyncNoticeCenter, NOTICE_PRIORITY } from "./ui/notice-center";
import {
  createSyncProgressNoticeMessage,
  formatSyncProgressNoticeLabel,
  resolveSyncProgressNoticePresentation,
  resolveSyncNoticeOutcome,
  shouldSuppressSyncNoticeForVisibleSidebar,
  type SyncNoticeOutcomeKind,
} from "./ui/sync-notice";
import {
  formatSyncResultMessage,
  isSyncResultFullyComplete,
  resolveSyncPendingAttentionCounts,
  resolveSyncHistoryStatus,
} from "./ui/sync-result-presentation";
import {
  AutoSyncDirtyHint,
  DEFAULT_AUTO_SYNC_CHANGE_DELAY_SECONDS,
  LOCAL_DIRTY_DEBOUNCE_MS,
  normalizeAutoSyncChangeDelaySeconds,
} from "./sync/auto-sync-dirty-hint";
import {
  MutationRecoveryScheduler,
  type MutationRecoveryAttemptOutcome,
  type MutationRecoverySchedulerSnapshot,
} from "./sync/mutation-recovery-scheduler";
import {
  formatMutationRecoveryHistory,
  mutationRecoveryBlockReasonText,
  mutationRecoveryStatusDetail,
  mutationRecoveryStatusLabel,
  type MutationRecoveryDisplayState,
} from "./ui/mutation-recovery-presentation";
import { sha256Hex } from "./crypto";
import {
  buildConflictEvidence,
  findLatestAutomaticHandlingSummary,
  findLatestNetworkSummary,
  findLatestPhaseSummary,
  findLatestTransferSummary,
  fingerprintOpaqueValue,
  formatDiagnosticAutomaticSyncSummary,
  formatV2StorageAuthorityEvidence,
  projectSyncHistoryActionCounts,
  summarizeCommunityPluginSync,
  summarizeMutationRecovery,
} from "./sync/diagnostic-report-evidence";
import {
  DEFAULT_AUTOMATIC_HANDLING_POLICY,
  readAutomaticHandlingPolicy,
  type AutomaticHandlingPolicy,
} from "./sync/automatic-handling-policy";
import {
  clearCompletedCommunityPluginRestores,
  cloneCommunityPluginSyncPolicy,
  createEffectiveCommunityPluginSyncPolicy,
  DEFAULT_COMMUNITY_PLUGIN_SYNC_POLICY,
  isPluginSelected,
  normalizePluginIds,
  normalizeCommunityPluginSyncSettings,
  readCommunityPluginSyncPolicy,
  sameCommunityPluginSyncPolicy,
  type CommunityPluginRestoreSet,
  type CommunityPluginSyncPolicyV1,
  type PluginScopeSelection,
} from "./sync/community-plugin-sync-policy";
import {
  applyCommunityPluginLocalIgnores,
  classifyCommunityPluginManagedPath,
  type CommunityPluginLocalIgnores,
} from "./sync/community-plugin-deletion-boundary";
import {
  buildCommunityPluginInventory,
  type CommunityPluginInventoryItem,
} from "./sync/community-plugin-inventory";
import {
  createEmptyDeviceCommunityPluginParticipation,
  isDeviceCommunityPluginEnabled,
  reduceDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationCommand,
  type DeviceCommunityPluginParticipationV1,
} from "./sync/community-plugin-participation";
import {
  buildRemoteCommunityPluginCatalog,
  markRemoteCommunityPluginCatalogStale,
  remoteCommunityPluginCatalogEntries,
  type RemoteCommunityPluginCatalogV1,
} from "./sync/community-plugin-remote-catalog";
import {
  isCommunityPluginJoinBlockRetryable,
  planCommunityPluginJoins,
  type CommunityPluginJoinAuthorization,
  type CommunityPluginJoinBlock,
  type CommunityPluginLocalBundleFact,
} from "./sync/community-plugin-join";
import {
  planCommunityPluginLocalReconciliation,
} from "./sync/community-plugin-local-reconciliation";
import { StartupPerformanceTracker } from "./startup-performance";

/** Plugin data keys for sync settings */
const KEY_SYNC_INTERVAL = "sync-interval";
const KEY_AUTO_SYNC_CHANGE_DELAY_SECONDS = "auto-sync-change-delay-seconds";
const KEY_SYNC_PLUGIN_FILES = "sync-plugin-files";
const KEY_MAX_FILE_SIZE_MB = "sync-max-file-size-mb";
const KEY_DIAG_LOG = "sync-diagnostic-logging";
const KEY_SYNC_EDITOR = "sync-editor";
const KEY_SYNC_APPEARANCE = "sync-appearance";
const KEY_SYNC_THEMES = "sync-themes";
const KEY_SYNC_HOTKEYS = "sync-hotkeys";
const KEY_SYNC_CORE_PLUGINS = "sync-core-plugins";
const KEY_SYNC_BOOKMARKS = "sync-bookmarks";
const KEY_SYNC_COMMUNITY_PLUGINS = "sync-community-plugins";
const KEY_SYNC_PLUGIN_DATA = "sync-plugin-data";
const KEY_COMMUNITY_PLUGIN_SYNC_POLICY = "community-plugin-sync-policy";
const KEY_SYNC_EXCLUDED_FOLDERS = "sync-excluded-folders";
const KEY_AUTO_SYNC_PAUSED = "auto-sync-paused";
const KEY_LEGACY_AUTO_MERGE = "sync-auto-merge";
const KEY_AUTOMATIC_HANDLING_POLICY = "sync-auto-conflict-policy";
const KEY_PROFILE_CACHE = "easy-sync-profile-cache";
const RIBBON_SUCCESS_DURATION_MS = 5_000;
const SYNC_RESULT_NOTICE_DURATION_MS = 2_000;
const SYNC_PROGRESS_NOTICE_KEY = "sync-progress";
const DESCENDANT_FILE_RECONSTRUCTION_CONTINUATION_DELAY_MS = 250;
const COMMUNITY_PLUGIN_FILE_DELETE_UNINSTALL_DELAY_MS = 150;
const DESCENDANT_FILE_RECONSTRUCTION_RETRY_DELAYS_MS =
  [5_000, 15_000, 30_000] as const;

export interface SyncPathSettings {
  syncPluginFiles: boolean;
  syncEditorSettings: boolean;
  syncAppearance: boolean;
  syncThemes: boolean;
  syncHotkeys: boolean;
  syncCorePlugins: boolean;
  syncBookmarks: boolean;
  syncCommunityPlugins: boolean;
  syncPluginData: boolean;
  communityPluginSyncPolicy: CommunityPluginSyncPolicyV1;
  excludedFolders: string[];
}

function syncPathSettingsFingerprint(
  settings: Readonly<SyncPathSettings>,
): string {
  const policy = settings.communityPluginSyncPolicy;
  return JSON.stringify({
    version: 1,
    syncPluginFiles: settings.syncPluginFiles,
    syncEditorSettings: settings.syncEditorSettings,
    syncAppearance: settings.syncAppearance,
    syncThemes: settings.syncThemes,
    syncHotkeys: settings.syncHotkeys,
    syncCorePlugins: settings.syncCorePlugins,
    syncBookmarks: settings.syncBookmarks,
    syncCommunityPlugins: settings.syncCommunityPlugins,
    syncPluginData: settings.syncPluginData,
    communityPluginSyncPolicy: {
      version: 1,
      files: {
        mode: policy.files.mode,
        pluginIds: [...policy.files.pluginIds].sort(),
        ignoredPluginIds: [...(policy.files.ignoredPluginIds ?? [])].sort(),
        restoringPluginIds:
          [...(policy.files.restoringPluginIds ?? [])].sort(),
      },
      data: {
        mode: policy.data.mode,
        pluginIds: [...policy.data.pluginIds].sort(),
        ignoredPluginIds: [...(policy.data.ignoredPluginIds ?? [])].sort(),
        restoringPluginIds:
          [...(policy.data.restoringPluginIds ?? [])].sort(),
      },
    },
    excludedFolders: [...settings.excludedFolders].sort(),
  });
}

function selectedPluginIds(
  selection: Readonly<PluginScopeSelection>,
): string[] {
  return selection.pluginIds.filter(
    (pluginId) => isPluginSelected(selection, pluginId),
  );
}

function pluginSelectionExpands(
  previous: Readonly<PluginScopeSelection>,
  candidate: Readonly<PluginScopeSelection>,
): boolean {
  if (candidate.mode === "none") return false;
  if (candidate.mode === "selected") {
    return selectedPluginIds(candidate).some(
      (pluginId) => !isPluginSelected(previous, pluginId),
    );
  }
  if (previous.mode !== "all") return true;
  const candidateIgnored = new Set(candidate.ignoredPluginIds ?? []);
  return (previous.ignoredPluginIds ?? []).some(
    (pluginId) => !candidateIgnored.has(pluginId),
  );
}

function pluginDataSelectionExpands(
  previous: Readonly<CommunityPluginSyncPolicyV1>,
  candidate: Readonly<CommunityPluginSyncPolicyV1>,
): boolean {
  if (
    candidate.files.mode === "none"
    || candidate.data.mode === "none"
  ) return false;
  const candidateFiniteSelection =
    candidate.files.mode === "selected"
      ? candidate.files
      : candidate.data.mode === "selected"
        ? candidate.data
        : null;
  if (candidateFiniteSelection) {
    return selectedPluginIds(candidateFiniteSelection).some(
      (pluginId) =>
        isPluginSelected(candidate.files, pluginId)
        && isPluginSelected(candidate.data, pluginId)
        && (
          !isPluginSelected(previous.files, pluginId)
          || !isPluginSelected(previous.data, pluginId)
        ),
    );
  }
  if (
    previous.files.mode !== "all"
    || previous.data.mode !== "all"
  ) return true;
  const candidateIgnored = new Set([
    ...(candidate.files.ignoredPluginIds ?? []),
    ...(candidate.data.ignoredPluginIds ?? []),
  ]);
  return [
    ...(previous.files.ignoredPluginIds ?? []),
    ...(previous.data.ignoredPluginIds ?? []),
  ].some((pluginId) => !candidateIgnored.has(pluginId));
}

function syncPathSettingsExpandFileScope(
  previous: Readonly<SyncPathSettings>,
  candidate: Readonly<SyncPathSettings>,
): boolean {
  if (
    (!previous.syncPluginFiles && candidate.syncPluginFiles)
    || (!previous.syncEditorSettings && candidate.syncEditorSettings)
    || (!previous.syncAppearance && candidate.syncAppearance)
    || (!previous.syncThemes && candidate.syncThemes)
    || (!previous.syncHotkeys && candidate.syncHotkeys)
    || (!previous.syncCorePlugins && candidate.syncCorePlugins)
    || (!previous.syncBookmarks && candidate.syncBookmarks)
  ) return true;

  const previousCommunityPolicy = createEffectiveCommunityPluginSyncPolicy(
    previous.communityPluginSyncPolicy,
    previous.syncCommunityPlugins,
    previous.syncPluginData,
  );
  const candidateCommunityPolicy = createEffectiveCommunityPluginSyncPolicy(
    candidate.communityPluginSyncPolicy,
    candidate.syncCommunityPlugins,
    candidate.syncPluginData,
  );
  if (
    pluginSelectionExpands(
      previousCommunityPolicy.files,
      candidateCommunityPolicy.files,
    )
    || pluginDataSelectionExpands(
      previousCommunityPolicy,
      candidateCommunityPolicy,
    )
  ) return true;

  return previous.excludedFolders.some((previousExcluded) => {
    const previousKey = previousExcluded.toLowerCase();
    return !candidate.excludedFolders.some((candidateExcluded) => {
      const candidateKey = candidateExcluded.toLowerCase();
      return previousKey === candidateKey
        || previousKey.startsWith(`${candidateKey}/`);
    });
  });
}

export class SyncPathSettingsUpdateError extends Error {
  constructor(readonly code: "busy" | "recovery") {
    super(code);
    this.name = "SyncPathSettingsUpdateError";
  }
}

interface MutationRecoveryRunContext {
  priorTotal: number;
  priorRemaining: number;
  newRemaining: number;
}

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
  autoSyncChangeDelaySeconds = DEFAULT_AUTO_SYNC_CHANGE_DELAY_SECONDS;
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
  syncBookmarks = false;
  syncCommunityPlugins = false;
  syncPluginData = false;
  communityPluginSyncPolicy = cloneCommunityPluginSyncPolicy(
    DEFAULT_COMMUNITY_PLUGIN_SYNC_POLICY,
  );
  excludedFolders: string[] = [];
  diagLogEnabled = false;
  autoSyncPaused = false;
  private opLock: string | null = null;
  private autoSyncTimer: IntervalHandle | null = null;
  private descendantFileReconstructionTimer: TimeoutHandle | null = null;
  private descendantFileReconstructionFailures = 0;
  private readonly autoSyncDirtyHint = new AutoSyncDirtyHint(
    () => this.runAutomaticSync("dirty"),
  );
  private readonly mutationRecoveryScheduler = new MutationRecoveryScheduler(
    () => this.runScheduledMutationRecovery(),
    () => {
      void this.pauseAfterMutationRecoveryBudget();
    },
    Math.random,
    (snapshot) => {
      void this.handleMutationRecoverySchedulerState(snapshot);
    },
  );
  private mutationRecoveryBlockReason: MutationRecoveryBlockReason | null = null;
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private ribbonSuccessTimer: TimeoutHandle | null = null;
  private ribbonSuccessVisible = false;
  private settingsTab: EasySyncSettingTab | null = null;
  private stateLoadPromise: Promise<void> | null = null;
  private syncNoticeFrame: AnimationFrameHandle | null = null;
  private syncNoticeSignature: string | null = null;
  private readonly operationLifecycle = new OperationLifecycle();
  private readonly startupPerformance = new StartupPerformanceTracker();
  private communityPluginInventoryRevision = 0;
  private communityPluginInventoryRefreshTimer: TimeoutHandle | null = null;
  private communityPluginLocalReconciliationTimer: TimeoutHandle | null = null;
  private readonly communityPluginInventoryRevisionListeners = new Set<
    (revision: number) => void
  >();
  private communityPluginLocalReconciliationQueue: Promise<void> =
    Promise.resolve();
  private readonly pendingCommunityPluginReconciliationIds =
    new Map<string, number>();
  private communityPluginReconciliationToken = 0;
  private communityPluginReconciliationRetryOnLockRelease = false;
  private communityPluginParticipation:
    DeviceCommunityPluginParticipationV1 | null = null;
  private communityPluginParticipationInitializationPromise:
    Promise<DeviceCommunityPluginParticipationV1 | null> | null = null;
  private communityPluginParticipationOperationSequence = 0;
  private remoteCommunityPluginCatalogRefreshPromise:
    Promise<RemoteCommunityPluginCatalogV1 | null> | null = null;

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
    this.retryCommunityPluginLocalReconciliationIfIdle();
  }

  // ---- Lifecycle ----

  async onload(): Promise<void> {
    this.startupPerformance.begin(
      Platform.isMobile ? "mobile" : "desktop",
    );
    this.diag.log("lifecycle", "====== onload start ======");
    this.diag.log(
      "lifecycle",
      `structuredClone implementation: ${structuredCloneImplementation}`,
    );
    this.diag.setAdapter(this.app.vault.adapter, getConfigDir(this.app.vault));

    // ════ ① Fast init (all synchronous / negligible I/O) ════

    const lang = I18n.detectLanguage(this.app as unknown as { vault: { getConfig: (key: string) => string } });
    this.i18n = new I18n(lang);
    await this.loadSyncSettings();

    // ════ ② Auth (create, register callback, then background-init) ════

    const authBrowser = createAuthBrowserLauncher({
      isDesktopApp: Platform.isDesktopApp,
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
      this.requestMutationRecoveryObservation("auth-state");
      this.requestDescendantFileReconstructionContinuation("auth-state");
    });

    // ════ ③ Scanner + state (no state load yet) ════

    const indexedDbVaultInstanceId =
      loadOrCreateIndexedDbVaultInstanceId(this.app);
    if (!indexedDbVaultInstanceId) {
      this.diag.warn(
        "state",
        "Vault-local IndexedDB namespace is unavailable; new selection is disabled and an existing binding will fail closed",
      );
    }

    this.state = new StateManager({
      loadData: () => this.loadPluginData(),
      updatePluginData: (mutator) => this.updatePluginData(mutator),
      app: this.app,
      layoutMigrationStorage: this.app,
      manifest: this.manifest,
      ...(indexedDbVaultInstanceId
        ? {
            indexedDbVaultInstanceId,
            readIndexedDbVaultInstanceId: () =>
              readIndexedDbVaultInstanceId(this.app),
            createPublic113IndexedDbCandidateStore: (sourceStateDigest) =>
              new IndexedDbPublic113StateStore(
                public113IndexedDbDatabaseName(
                  indexedDbVaultInstanceId,
                  sourceStateDigest,
                ),
              ),
            createStateV2IndexedDbActiveStore: (databaseId, recovery) =>
              new StateV2IndexedDbActiveStore(databaseId, recovery),
            createRemoteScopeRecoveryEvidenceStore: (vaultInstanceId) =>
              new IndexedDbRemoteScopeRecoveryEvidenceStore(vaultInstanceId),
          }
        : {}),
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
    this.applySyncPathSettings(); // Apply saved path settings after scanner is created
    this.onedrive = new OneDriveClient(
      () => this.auth!.getAccessToken(),
      this.diag,
      getConfigDir(this.app.vault),
      this.manifest.id,
    );
    this.syncExecutor = new SyncExecutor(
      this.onedrive,
      this.scanner,
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
    this.syncExecutor.setCommunityPluginSyncPolicy(
      this.getEffectiveCommunityPluginSyncPolicy(),
    );

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
    this.startupPerformance.markUiReady();

    // ════ ⑤ Background auth init (non-blocking) ════

    void this.auth.initialize()
      .then(() => {
        const authState = this.auth?.authState;
        this.startupPerformance.markAuthReady({
          outcome: "ready",
          loggedIn: authState?.isLoggedIn === true,
          accountVerified:
            typeof authState?.accountId === "string"
            && authState.accountId.length > 0,
        });
        this.emitColdStartSummaryIfReady();
        this.schedulePersistedCommunityPluginJoinSync("auth-ready");
      })
      .catch((e) => {
        this.startupPerformance.markAuthReady({
          outcome: "failed",
          loggedIn: false,
          accountVerified: false,
        });
        this.emitColdStartSummaryIfReady();
        this.diag.warn("lifecycle", "background auth init failed", e);
      });
    // onStateChange callback fires when complete → UI auto-refreshes
    void this.ensureStateLoaded()
      .then(() => {
        const state = this.state;
        const block = state?.v2StateLoadRecoveryBlock ?? null;
        this.startupPerformance.markStateReady({
          outcome: "ready",
          activeV2: state?.isV2StateActive === true,
          authorityBlocked: block !== null,
          blockReason: block?.reason ?? null,
          remoteFiles: state?.remoteSnapshot.length ?? 0,
          remoteFolders: state?.remoteFolders.length ?? 0,
          mutationLedger: state?.mutationLedger.length ?? 0,
          pendingReview: state?.planReviewActive === true,
        });
        this.emitColdStartSummaryIfReady();
        this.updateStatusBar();
        this.requestMutationRecoveryObservation("state-loaded");
        this.requestDescendantFileReconstructionContinuation("state-loaded");
        this.scheduleCommunityPluginLocalReconciliation("state-loaded");
        this.schedulePersistedCommunityPluginJoinSync("state-loaded");
      })
      .catch((e) => {
        this.startupPerformance.markStateReady({
          outcome: "failed",
          activeV2: false,
          authorityBlocked: true,
          blockReason: "state-load-rejected",
          remoteFiles: 0,
          remoteFolders: 0,
          mutationLedger: 0,
          pendingReview: false,
        });
        this.emitColdStartSummaryIfReady();
        this.diag.warn("state", "background state load failed", e);
      });

    // ════ ⑥ Auto-sync timer (skips until auth is ready) ════

    this.registerEvent(this.app.vault.on("create", (file) => {
      this.handleLocalVaultChange(file, "create");
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      this.handleLocalVaultChange(file, "modify");
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      void this.handleLocalVaultDelete(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.handleLocalVaultRename(file, oldPath);
    }));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.requestMutationRecoveryObservation("foreground");
        this.requestDescendantFileReconstructionContinuation("foreground");
        this.scheduleCommunityPluginLocalReconciliation("foreground");
        this.schedulePersistedCommunityPluginJoinSync("foreground");
      }
    });
    this.startAutoSync();

    this.diag.log("lifecycle", "onload complete (auth initializing in background)");
  }

  onunload(): void {
    this.startupPerformance.cancel();
    this.diag.log("lifecycle", "unloading");
    if (this.syncExecutor) {
      this.syncExecutor.invalidateLifecycle("unload");
    } else {
      this.operationLifecycle.invalidate("unload");
    }
    // Sever the UI gateway immediately. The invalidated executor object stays
    // alive only for already-captured async work to drain safely.
    this.syncExecutor = null;
    this.communityPluginInventoryRevisionListeners.clear();
    this.pendingCommunityPluginReconciliationIds.clear();
    this.communityPluginReconciliationRetryOnLockRelease = false;
    compatClearTimeout(this.communityPluginInventoryRefreshTimer);
    this.communityPluginInventoryRefreshTimer = null;
    compatClearTimeout(this.communityPluginLocalReconciliationTimer);
    this.communityPluginLocalReconciliationTimer = null;
    this.stopAutoSync();
    this.cancelDescendantFileReconstructionContinuation();
    compatClearTimeout(this.ribbonSuccessTimer);
    compatCancelAnimationFrame(this.syncNoticeFrame);
    this.noticeCenter.dispose();
    void this.state?.close().catch(() => undefined);
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
    failureKey:
      | "notice.conflict.failed"
      | "notice.delete.failed"
      | "notice.emptyFolder.failed"
      | "notice.sharedFolderIdentity.failed"
      | "notice.staleIdentity.failed"
      | "notice.mutationResolution.failed",
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
      if (state.hasV2StateLoadRecoveryBlock) {
        this.noticeCenter.show({
          key: "side-action-gateway:v2-state-load-blocked",
          message: this.i18n.t("result.v2StateLoadBlocked"),
          priority: NOTICE_PRIORITY.critical,
          className: "easy-sync-notice-action",
        });
        return false;
      }
      if (state.hasV2RemoteScopeRecovery) {
        this.noticeCenter.show({
          key: "side-action-gateway:v2-scope-recovery-pending",
          message: this.i18n.t("result.v2ScopeRecoveryPending"),
          priority: NOTICE_PRIORITY.critical,
          className: "easy-sync-notice-action",
        });
        return false;
      }
      if (state.isV2StateActive === false) {
        this.noticeCenter.show({
          key: "side-action-gateway:v2-migration-required",
          message: this.i18n.t("notice.v2MigrationRequired"),
          priority: NOTICE_PRIORITY.attention,
          className: "easy-sync-notice-action",
        });
        return false;
      }
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

  async getEmptyFolderResolutionSnapshot(
    path: string,
  ): Promise<EmptyFolderResolutionSnapshotV1 | null> {
    await this.ensureStateLoaded();
    if (!this.syncExecutor || !this.state?.isV2StateActive) return null;
    return this.syncExecutor.getEmptyFolderResolutionSnapshot(path);
  }

  async getSharedFolderIdentityResolutionSnapshot(
    path: string,
  ): Promise<SharedFolderIdentityResolutionSnapshotV1 | null> {
    await this.ensureStateLoaded();
    if (!this.syncExecutor || !this.state?.isV2StateActive) return null;
    return this.syncExecutor.getSharedFolderIdentityResolutionSnapshot(path);
  }

  async getStaleIdentityResolutionSnapshot(
    path: string,
  ): Promise<StaleIdentityResolutionSnapshotV1 | null> {
    await this.ensureStateLoaded();
    if (!this.syncExecutor || !this.state?.isV2StateActive) return null;
    return this.syncExecutor.getStaleIdentityResolutionSnapshot(path);
  }

  async getMutationRecoveryResolutionSnapshot():
    Promise<ManualMutationResolutionSnapshotV1 | null> {
    await this.ensureStateLoaded();
    const executor = this.syncExecutor;
    const display = this.getMutationRecoveryDisplayState();
    if (
      !executor
      || executor.isRunning
      || executor.hasSideActionsInFlight
      || !this.state?.isV2StateActive
      || display?.kind !== "blocked"
      || display.blockReason !== "facts-changed"
    ) return null;
    if (!await this.checkAccountBinding()) return null;
    return executor.getMutationRecoveryResolutionSnapshot(
      display.blockedOperationId ?? undefined,
    );
  }

  async resolveMutationRecovery(
    reviewed: Readonly<ManualMutationResolutionSnapshotV1>,
    choice: ManualMutationResolutionChoiceV1,
  ): Promise<boolean> {
    let resolved = false;
    const admitted = await this.runSideActionIntent(
      reviewed.path,
      "notice.mutationResolution.failed",
      async (executor) => {
        resolved = await executor.resolveMutationRecovery(reviewed, choice);
      },
      true,
    );
    if (!admitted || !resolved || !this.state) return false;
    this.mutationRecoveryBlockReason = null;
    await this.startManualSync();
    return true;
  }

  restoreReviewedEmptyFolder(
    reviewed: Readonly<EmptyFolderResolutionSnapshotV1>,
  ): Promise<boolean> {
    return this.runSideActionIntent(
      reviewed.path,
      "notice.emptyFolder.failed",
      (executor) => executor.restoreReviewedEmptyFolder(reviewed),
    );
  }

  async bindReviewedEmptyFolderRename(
    reviewed: Readonly<EmptyFolderResolutionSnapshotV1>,
    candidatePath: string,
  ): Promise<boolean> {
    let bound = false;
    const admitted = await this.runSideActionIntent(
      reviewed.path,
      "notice.emptyFolder.failed",
      async (executor) => {
        bound = await executor.bindReviewedEmptyFolderRename(
          reviewed,
          candidatePath,
        );
      },
    );
    if (!admitted || !bound) return false;
    await this.startManualSync();
    return true;
  }

  async confirmReviewedSharedFolderIdentity(
    reviewed: Readonly<SharedFolderIdentityResolutionSnapshotV1>,
  ): Promise<boolean> {
    let accepted = false;
    const admitted = await this.runSideActionIntent(
      reviewed.path,
      "notice.sharedFolderIdentity.failed",
      async (executor) => {
        accepted = await executor.confirmReviewedSharedFolderIdentity(reviewed);
      },
    );
    if (!admitted || !accepted) return false;
    await this.startManualSync();
    return true;
  }

  async retireReviewedStaleIdentity(
    reviewed: Readonly<StaleIdentityResolutionSnapshotV1>,
  ): Promise<boolean> {
    let retired = false;
    const admitted = await this.runSideActionIntent(
      reviewed.path,
      "notice.staleIdentity.failed",
      async (executor) => {
        retired = await executor.retireReviewedStaleIdentity(reviewed);
      },
    );
    if (!admitted || !retired) return false;
    await this.startManualSync();
    return true;
  }

  deleteReviewedEmptyRemoteFolder(
    reviewed: Readonly<EmptyFolderResolutionSnapshotV1>,
  ): Promise<boolean> {
    return this.runSideActionIntent(
      reviewed.path,
      "notice.emptyFolder.failed",
      (executor) => executor.deleteReviewedEmptyRemoteFolder(reviewed),
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
      onFileComplete: (path, actionType, success, reason, fileSize, sourcePath) => {
        this.handleFileComplete(
          path,
          actionType,
          success,
          reason,
          fileSize,
          sourcePath,
        );
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
    await this.preparePublic113MigrationSettings(request.options);
    if (request.options?.recoveryOnly !== true) {
      await this.reconcileCommunityPluginParticipationFromLocalBundles({
        trigger: "sync",
        allowedLockHolder: "sync",
      });
    }
    const preparedCommunityPluginJoins = request.options?.recoveryOnly === true
      ? { authorizations: [] }
      : await this.prepareCommunityPluginJoinsForSync();
    const runOptions: SyncRunOptions = {
      ...(request.options ?? {}),
      ...(preparedCommunityPluginJoins.authorizations.length > 0
        ? {
            communityPluginJoinAuthorizations:
              preparedCommunityPluginJoins.authorizations,
          }
        : {}),
    };
    const priorRecoveryIds = this.state?.isV2StateActive
      ? new Set(
          (this.state.mutationLedger ?? []).map(
            (entry) => entry.intent.operationId,
          ),
        )
      : new Set<string>();
    this.progressStore.markStarted(
      request.options?.recoveryOnly === true
        ? "mutationRecovery"
        : "fullSync",
    );
    this.beginSyncNotice();
    let continuedAfterStateOnlyRecovery = false;
    let retainReviewedAuthorization = false;
    let result: SyncResult;
    do {
      result = await this.syncExecutor.run(
        request.mode,
        this.createSyncCallbacks(request.mode),
        continuedAfterStateOnlyRecovery && !retainReviewedAuthorization
          ? false
          : request.skipConfirmation ?? false,
        continuedAfterStateOnlyRecovery && !retainReviewedAuthorization
          ? undefined
          : request.reviewedAuthorization,
        runOptions,
      );
      if (
        result.continueAfterStateOnlyMigrationRecovery
        && !continuedAfterStateOnlyRecovery
      ) {
        this.diag.log(
          "state",
          "public 1.1.3 mutation ledger settled under V2 authority; continuing with one ordinary V2 round",
          { mutations: 0 },
        );
        continuedAfterStateOnlyRecovery = true;
        retainReviewedAuthorization = false;
        continue;
      }
      if (
        result.continueAfterV2CorruptStateRecovery
        && !continuedAfterStateOnlyRecovery
      ) {
        this.diag.log(
          "state",
          "V2 corrupt state republished; continuing with one ordinary V2 round under the same reviewed authorization",
          { mutations: 0 },
        );
        continuedAfterStateOnlyRecovery = true;
        retainReviewedAuthorization = true;
        continue;
      }
      break;
    } while (true);
    const localIgnores = result.communityPluginLocalIgnores;
    if (
      this.state?.isV2StateActive === true
      && localIgnores
      && (localIgnores.files.length > 0 || localIgnores.data.length > 0)
    ) {
      try {
        await this.persistCommunityPluginLocalIgnores(localIgnores);
      } catch (error) {
        result.success = false;
        result.errors += 1;
        result.message = this.i18n.t(
          "result.communityPluginLocalIgnoreFailed",
        );
        this.diag.error(
          "state",
          "failed to persist device-local community plugin exclusions",
          error,
        );
      }
    }
    const completedRestores = result.communityPluginRestoresCompleted;
    const joinBlocks = result.communityPluginJoinBlocks ?? [];
    const hasCommunityPluginJoinOutcome = joinBlocks.length > 0
      || (completedRestores?.files.length ?? 0) > 0
      || (completedRestores?.data.length ?? 0) > 0;
    if (hasCommunityPluginJoinOutcome) {
      try {
        await this.persistCommunityPluginJoinOutcomes(
          completedRestores ?? { files: [], data: [] },
          joinBlocks,
        );
      } catch (error) {
        result.success = false;
        result.errors += 1;
        this.diag.error(
          "state",
          "failed to persist community plugin join outcome",
          error,
        );
      }
    }
    result.message = formatSyncResultMessage(
      result,
      this.progressStore.state.completedFiles,
      this.i18n.t.bind(this.i18n),
    );
    if (request.logLabel) {
      this.diag.log("execute", `${request.logLabel}: ${result.message}`);
    }
    const remainingRecoveryIds = new Set(
      this.state?.isV2StateActive
        ? (this.state.mutationLedger ?? []).map(
            (entry) => entry.intent.operationId,
          )
        : [],
    );
    const recoveryContext: MutationRecoveryRunContext = {
      priorTotal: priorRecoveryIds.size,
      priorRemaining: [...priorRecoveryIds].filter(
        (operationId) => remainingRecoveryIds.has(operationId),
      ).length,
      newRemaining: [...remainingRecoveryIds].filter(
        (operationId) => !priorRecoveryIds.has(operationId),
      ).length,
    };
    let reconstructionContinuationDelay =
      DESCENDANT_FILE_RECONSTRUCTION_CONTINUATION_DELAY_MS;
    let scheduleReconstructionContinuation = false;
    if (result.continueAfterConfirmedDescendantFileReconstruction) {
      if (result.descendantFileReconstructionRetryableFailure) {
        this.descendantFileReconstructionFailures++;
        const retryDelay =
          DESCENDANT_FILE_RECONSTRUCTION_RETRY_DELAYS_MS[
            this.descendantFileReconstructionFailures - 1
          ];
        if (retryDelay === undefined) {
          delete result.continueAfterConfirmedDescendantFileReconstruction;
          delete result.descendantFileReconstructionRetryableFailure;
          this.diag.warn(
            "state",
            "descendant file baseline automatic retry budget exhausted",
            {
              attempts: this.descendantFileReconstructionFailures,
              mutations: 0,
            },
          );
        } else {
          reconstructionContinuationDelay = retryDelay;
          scheduleReconstructionContinuation = true;
        }
      } else {
        this.descendantFileReconstructionFailures = 0;
        delete result.continueAfterConfirmedDescendantFileReconstruction;
        delete result.descendantFileReconstructionRetryableFailure;
        this.diag.warn(
          "state",
          "ignored a successful descendant file reconstruction continuation; successful work must remain in one visible sync",
          { mutations: 0 },
        );
      }
    } else if (!this.state?.confirmedDescendantFileReconstruction) {
      this.descendantFileReconstructionFailures = 0;
    }
    await this.handleSyncResult(
      result,
      request.mode,
      request.options?.recoveryOnly === true,
      recoveryContext,
    );
    this.advanceCommunityPluginInventoryRevision();
    if (
      scheduleReconstructionContinuation
      && result.continueAfterConfirmedDescendantFileReconstruction
    ) {
      this.requestDescendantFileReconstructionContinuation(
        `${request.mode}-slice`,
        reconstructionContinuationDelay,
      );
    }
    if (request.renderAfter) this.syncView?.render();
    return result;
  }

  /**
   * Persist the automatic pause and the current settings shape before a
   * public-1.1.3 run snapshots PluginData for its migration hold.
   *
   * handleSyncResult persists the same values after a plan is held. Without
   * this preflight, that deterministic post-run write makes the hold's full
   * source digest stale before the user can confirm it. Read-only preview must
   * remain mutation-free, and active V2 never enters this compatibility path.
   */
  private async preparePublic113MigrationSettings(
    options: SyncRunOptions | undefined,
  ): Promise<void> {
    if (
      options?.readOnlyPreview === true
      || !this.state?.legacyAutoSyncAllowed
      || this.state.isV2StateActive
    ) return;
    if (!this.autoSyncPaused) {
      this.autoSyncPaused = true;
      this.stopAutoSync();
    }
    await this.saveSyncSettings();
  }

  /**
   * A manifest-selected V2 state that cannot load must still enter the normal
   * result/diagnostic path. Stable identity/anchor corruption gets one
   * explicit manual GET-only evidence pass after account verification;
   * automatic runs and all other load failures stop before scan or Graph.
   */
  private async dispatchV2StateLoadBlockIfPresent(
    mode: SyncMode,
    logLabel: string,
  ): Promise<boolean> {
    if (!this.state?.hasV2StateLoadRecoveryBlock) return false;
    if (mode !== "auto") await this.activateSyncView();
    const recoverV2CorruptState =
      mode !== "auto"
      && this.state.v2CorruptStateRecoveryEvidence !== null;
    if (recoverV2CorruptState && !await this.checkAccountBinding()) {
      return true;
    }
    const reviewedAuthorization =
      recoverV2CorruptState && this.state.planReviewActive
        ? this.state.planReviewAuthorization ?? undefined
        : undefined;
    await this.dispatchSyncRun({
      mode,
      skipConfirmation: reviewedAuthorization !== undefined,
      reviewedAuthorization,
      options: recoverV2CorruptState
        ? { recoverV2CorruptState: true }
        : undefined,
      logLabel,
      renderAfter: true,
    });
    return true;
  }

  /** Execute a sync after the user has reviewed the plan in the sidebar.
   *  The reviewed digest may become stale before execution; in that case the
   *  executor sends the replacement plan back through the normal alert path. */
  async executePlanReview(): Promise<void> {
    if (!this.syncExecutor || !this.state) return;
    if (this.acquireOpLock("sync")) return;
    try {
    await this.ensureStateLoaded();
    if (await this.dispatchV2StateLoadBlockIfPresent(
      "manual",
      "blocked plan review execution result",
    )) return;
    if (this.state.hasV2RemoteScopeRecovery) {
      if (!await this.checkAccountBinding()) return;
      const reviewedAuthorization =
        this.state.planReviewAuthorization ?? undefined;
      await this.dispatchSyncRun({
        mode: "manual",
        skipConfirmation: reviewedAuthorization !== undefined,
        reviewedAuthorization,
        options: { recoverV2RemoteScope: true },
        logLabel: "remote scope recovery result",
        renderAfter: true,
      });
      return;
    }
    if (!this.state.planReviewActive) return;
    if (!await this.checkAccountBinding()) return;
    const reviewedAuthorization = this.state.planReviewAuthorization ?? undefined;
    const acknowledgeMigrationRisk =
      reviewedAuthorization?.reviewKind === "v2-migration";
    const createFirstV2Protocol =
      reviewedAuthorization?.reviewKind === "v2-first-sync";
    if (
      acknowledgeMigrationRisk
      && !await this.acknowledgeV2MigrationRisk()
    ) return;
    await this.dispatchSyncRun({
      mode: "manual",
      skipConfirmation: true,
      reviewedAuthorization,
      options: acknowledgeMigrationRisk || createFirstV2Protocol
        ? { acknowledgeMigrationRisk: true }
        : undefined,
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
    if (
      this.state.v2CorruptStateRecoveryEvidence
      && this.state.activeV2CorruptStateRecoveryHold
    ) {
      await this.state.clearV2CorruptStateRecoveryReview();
      await this.startFirstSync();
      return;
    }
    if (
      this.state.hasV2StateLoadRecoveryBlock
      || this.state.hasV2RemoteScopeRecovery
    ) {
      await this.startFirstSync();
      return;
    }
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
  private async checkAccountBinding(options: {
    suppressNotice?: boolean;
    allowInitialBind?: boolean;
  } = {}): Promise<boolean> {
    const currentId = this.auth?.authState.accountId;
    if (!currentId) return false; // Not logged in

    const bound = this.state?.boundAccountId;
    if (!bound) {
      if (options.allowInitialBind === false) return false;
      // First sync ever — bind to this account
      this.operationLifecycle.invalidate("account-binding-change");
      await this.state?.bindAccount(currentId);
      return true;
    }
    if (bound !== currentId) {
      if (!options.suppressNotice) {
        this.noticeCenter.show({
          key: "account-mismatch",
          message: this.i18n.t("notice.accountMismatch", {
            bound: `${bound.slice(0, 8)}…`,
            current: `${currentId.slice(0, 8)}…`,
          }),
          priority: NOTICE_PRIORITY.critical,
        });
      }
      this.diag.warn("lifecycle", `account mismatch — bound=${bound.slice(0, 8)}, current=${currentId.slice(0, 8)}`);
      return false;
    }
    return true;
  }

  private async checkAccountBindingForSync(): Promise<boolean> {
    if (!this.hasUnresolvedMutationRecovery()) {
      return this.checkAccountBinding();
    }
    const matches = await this.checkAccountBinding({
      suppressNotice: true,
      allowInitialBind: false,
    });
    if (!matches) {
      await this.pauseForMutationRecoveryBlock("account-changed");
    }
    return matches;
  }

  /** Ensure StateManager has been loaded from disk.
   *  Idempotent — only calls load() on the first invocation. */
  async ensureStateLoaded(): Promise<void> {
    if (this._stateLoaded || !this.state) return;
    this.stateLoadPromise ??= this.state.load().then(async () => {
      try {
        await this.ensureCommunityPluginParticipationInitialized();
      } catch (error) {
        // File/content sync can remain available, but the community-plugin
        // scope fails closed until its device-local intent can be loaded.
        this.applyCommunityPluginParticipationProjection(
          createEmptyDeviceCommunityPluginParticipation(false),
        );
        this.diag.warn(
          "state",
          "community plugin participation initialization failed",
          error instanceof Error ? error.message : String(error),
        );
      }
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
    if (await this.dispatchV2StateLoadBlockIfPresent(
      "first",
      "blocked first sync result",
    )) return;
    if (!await this.checkAccountBindingForSync()) return;
    const recoverV2RemoteScope =
      this.state?.hasV2RemoteScopeRecovery === true;
    if (this.state?.planReviewActive && !recoverV2RemoteScope) {
      await this.activateSyncView();
      this.syncView?.render();
      return;
    }
    await this.activateSyncView();
    await this.dispatchSyncRun({
      mode: "first",
      options: {
        ...options,
        ...(recoverV2RemoteScope
          ? { recoverV2RemoteScope: true }
          : {}),
      },
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
    if (await this.dispatchV2StateLoadBlockIfPresent(
      "manual",
      "blocked manual sync result",
    )) return;
    if (!await this.checkAccountBindingForSync()) return;

    // If a plan review is pending, execute it directly — but keep the
    // reviewed bundle in state until SyncExecutor re-validates its digest.
    const recoverV2RemoteScope =
      this.state?.hasV2RemoteScopeRecovery === true;
    const skipConfirmation = this.state?.planReviewActive ?? false;
    const reviewedAuthorization = skipConfirmation
      ? this.state?.planReviewAuthorization ?? undefined
      : undefined;
    const acknowledgeMigrationRisk =
      reviewedAuthorization?.reviewKind === "v2-migration";
    const createFirstV2Protocol =
      reviewedAuthorization?.reviewKind === "v2-first-sync";
    if (
      acknowledgeMigrationRisk
      && !await this.acknowledgeV2MigrationRisk()
    ) return;

    await this.dispatchSyncRun({
      mode: "manual",
      skipConfirmation,
      reviewedAuthorization,
      options: {
        ...(recoverV2RemoteScope
          ? { recoverV2RemoteScope: true }
          : {}),
        ...(acknowledgeMigrationRisk || createFirstV2Protocol
          ? { acknowledgeMigrationRisk: true }
          : {}),
      },
      logLabel: "manual sync result",
    });
    } finally {
      this.releaseOpLock();
    }
  }

  private async acknowledgeV2MigrationRisk(): Promise<boolean> {
    const t = this.i18n.t.bind(this.i18n);
    return new ConfirmModal(
      this.app,
      t("syncPlan.migrationConfirmTitle"),
      null,
      t("syncPlan.migrationConfirm"),
      t("confirm.cancel"),
      t,
      {
        message: t("syncPlan.migrationConfirmMessage"),
      },
    ).awaitConfirm();
  }

  /**
   * Persist the plan's conflict and delete items to state, then show
   * a lightweight alert. Sync pauses until the user clicks "确认执行"
   * in the sidebar. Returns false to indicate the sync should pause.
   */
  private async showPlanAlert(
    kind: "firstSync" | "threshold",
    plan: SyncPlan,
  ): Promise<boolean> {
    const t = this.i18n.t.bind(this.i18n);

    const counts = plan.canonicalReview?.counts ?? {
      uploads: plan.items.filter((i) => i.type === SyncActionType.Upload).length,
      downloads: plan.items.filter((i) => i.type === SyncActionType.Download).length,
      folders: plan.items.filter((i) =>
        i.type === SyncActionType.RecreateRemoteScope
          || i.type === SyncActionType.CreateRemoteFolder
          || i.type === SyncActionType.CreateLocalFolder
          || i.type === SyncActionType.MoveRemoteFolder
          || i.type === SyncActionType.MoveLocalFolder).length,
      deletes: plan.items.filter((i) =>
        i.type === SyncActionType.DeleteRemote
          || i.type === SyncActionType.DeleteLocal
          || i.type === SyncActionType.ConfirmLocalDelete
          || i.type === SyncActionType.DeleteRemoteFolder
          || i.type === SyncActionType.DeleteLocalFolder).length,
      conflicts: plan.items.filter((i) => i.type === SyncActionType.Conflict).length,
      skipped: plan.items.filter((i) =>
        i.type === SyncActionType.SkipLargeFile || i.type === SyncActionType.SkipIgnoredPath).length,
    };
    if (!plan.scope) {
      throw new Error("Cannot persist a plan review without a complete sync scope");
    }
    // Capture the previous canonical identity before it is overwritten by
    // setPlanReviewBundle below. When the plan did not actually change the
    // regenerated alert can be skipped entirely — the sidebar still holds the
    // same review from the previous round.
    const previousIdentity = this.state?.planReviewCanonicalIdentity ?? null;
    if (plan.reviewKind !== undefined) {
      const hold = this.state!.activeV2MigrationHold;
      if (
        !hold
        || !sameSyncScope(hold.scope, plan.scope)
        || !sameCanonicalPlanIdentityV2(
          hold.canonicalIdentity,
          plan.canonicalIdentity,
        )
      ) {
        throw new Error(
          "Cannot display a V2 activation review without its durable hold",
        );
      }
    } else {
      await this.state!.setPlanReviewBundle(
        plan.items,
        counts,
        plan.scope,
        plan.canonicalIdentity,
      );
    }

    // Refresh sidebar to show plan review section
    this.updateStatusBar();
    this.syncView?.render();

    // When a regenerated plan is byte-for-byte identical to the review that
    // was already sitting in the sidebar there is nothing new to show. The
    // user still needs to confirm in the sidebar, so we still pause.
    if (
      kind === "threshold"
      && previousIdentity
      && plan.canonicalIdentity
      && sameCanonicalPlanIdentityV2(previousIdentity, plan.canonicalIdentity)
    ) {
      this.diag?.log(
        "state",
        "regenerated plan review is identical — skipping repeat alert",
        { mutations: 0 },
      );
      return false;
    }

    const firstTime = kind === "firstSync";
    const modal = new SyncPlanAlertModal(
      this.app,
      t(firstTime
        ? "syncPlan.readyTitle"
        : "syncPlan.reviewUpdatedTitle"),
      t(firstTime
        ? "syncPlan.readyMessage"
        : "syncPlan.reviewUpdatedMessage"),
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
    const easySyncViewVisibleInLeftSidebar = this.app.workspace
      .getLeavesOfType(SYNC_VIEW_TYPE)
      .some((leaf) => {
        const parent = leaf.parent;
        const belongsToLeftSidebar = parent === leftSidebar
          || parent.parent === leftSidebar;
        return belongsToLeftSidebar && leaf.view.containerEl.isShown();
      });
    return shouldSuppressSyncNoticeForVisibleSidebar({
      leftSidebarCollapsed: leftSidebar.collapsed,
      easySyncViewVisibleInLeftSidebar,
    });
  }

  private clearSyncLifecycleNotice(): void {
    const activeKey = this.noticeCenter.activeKey;
    this.noticeCenter.clear(SYNC_PROGRESS_NOTICE_KEY);
    if (activeKey?.startsWith("sync-result:")) this.noticeCenter.clear(activeKey);
  }

  private refreshSyncNoticeVisibility(): void {
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
    this.clearSyncLifecycleNotice();
    if (this.shouldSuppressSyncNotice()) {
      this.syncNoticeSignature = null;
      return;
    }
    const recovering =
      this.progressStore.state.activityKind === "mutationRecovery";
    const label = this.i18n.t(
      recovering
        ? "progress.recoveringMutation"
        : "notice.sync.start",
    );
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
    }, this.progressStore.state.completedFiles);
    const equivalentCommunityPluginSidebar =
      outcome?.kind === "communityPluginEnablement"
      && this.getCommunityPluginEnablementPendingCount() > 0;
    if (
      !outcome
      || (
        suppressNotice
        && (
          outcome.kind !== "communityPluginEnablement"
          || equivalentCommunityPluginSidebar
        )
      )
    ) return;

    const messageKeys: Record<SyncNoticeOutcomeKind, string> = {
      completed: "notice.sync.completed",
      conflicts: "notice.sync.conflicts",
      remoteDeletes: "notice.sync.remoteDeletes",
      mixedPending: "notice.sync.mixedPending",
      communityPluginEnablement:
        "notice.sync.communityPluginEnablement",
      review: "notice.sync.review",
      cancelled: "notice.sync.cancelled",
      failed: "notice.sync.failed",
      authExpired: "notice.sync.authExpired",
    };
    const priorities: Record<SyncNoticeOutcomeKind, number> = {
      completed: NOTICE_PRIORITY.info,
      conflicts: NOTICE_PRIORITY.attention,
      remoteDeletes: NOTICE_PRIORITY.attention,
      mixedPending: NOTICE_PRIORITY.attention,
      communityPluginEnablement: NOTICE_PRIORITY.attention,
      review: NOTICE_PRIORITY.attention,
      cancelled: NOTICE_PRIORITY.action,
      failed: NOTICE_PRIORITY.failure,
      authExpired: NOTICE_PRIORITY.critical,
    };
    this.noticeCenter.show({
      key: `sync-result:${outcome.kind}`,
      message: outcome.message ?? this.i18n.t(
        messageKeys[outcome.kind],
        {
          count: outcome.count,
          remoteDeletes: outcome.remoteDeletes ?? 0,
        },
      ),
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
  private handleFileComplete(
    path: string,
    actionType: SyncActionType,
    success: boolean,
    reason?: string,
    fileSize?: number,
    sourcePath?: string,
  ): void {
    const safelyDeferred = actionType === SyncActionType.RetryLater
      || actionType === SyncActionType.FolderDeferred;
    const status = success || safelyDeferred
      ? SyncProgressStore.actionToStatus(actionType)
      : "error";
    this.progressStore.completeCurrentItem();
    this.progressStore.addCompletedFile({
      path,
      sourcePath,
      status,
      actionType,
      reason,
      fileSize,
    });
    this.scheduleSyncNoticeUpdate();
  }

  async cancelSync(): Promise<void> {
    this.cancelDescendantFileReconstructionContinuation();
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
    this.cancelDescendantFileReconstructionContinuation();
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
    await this.ensureStateLoaded();
    if (this.hasResetBlockingRecovery()) {
      this.showMutationRecoveryResetBlockedNotice();
      return;
    }
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
      if (this.hasResetBlockingRecovery()) {
        this.showMutationRecoveryResetBlockedNotice();
        return;
      }
      try {
        await this.state?.reset();
      } catch (error) {
        if (this.hasResetBlockingRecovery()) {
          this.showMutationRecoveryResetBlockedNotice();
          return;
        }
        this.diag.error("state", "local sync state reset failed", error);
        this.noticeCenter.show({
          key: "reset-failed",
          message: this.i18n.t("settings.reset.failed"),
          priority: NOTICE_PRIORITY.attention,
          durationMs: 10_000,
        });
        return;
      }
      // V2 participation is part of the discarded local baseline. Keep the
      // user's current sync settings, then let the next V2 join rebuild a new
      // participation projection from those settings and current file facts.
      this.communityPluginParticipation = null;
      this.communityPluginParticipationInitializationPromise = null;
      try {
        await this.saveSyncSettings();
        await this.scanner?.clearScanCache();
      } catch (error) {
        this.diag.error("state", "local reset maintenance failed", error);
        this.noticeCenter.show({
          key: "reset-failed",
          message: this.i18n.t("settings.reset.failed"),
          priority: NOTICE_PRIORITY.attention,
          durationMs: 10_000,
        });
        return;
      }
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

  private hasResetBlockingRecovery(): boolean {
    const state = this.state;
    if (!state) return false;
    return (state.mutationLedger?.length ?? 0) > 0
      || (state.mutationRecoveryQuarantine?.length ?? 0) > 0
      || state.hasMutationLedgerCorruption
      || state.hasMutationRecoveryQuarantineCorruption;
  }

  private hasUnresolvedMutationRecovery(): boolean {
    const state = this.state;
    if (!state) return false;
    return state.hasV2StateLoadRecoveryBlock
      || (state.mutationLedger?.length ?? 0) > 0
      || (state.mutationRecoveryQuarantine?.length ?? 0) > 0
      || state.hasMutationLedgerCorruption
      || state.hasMutationRecoveryQuarantineCorruption;
  }

  private showMutationRecoveryResetBlockedNotice(): void {
    this.noticeCenter.show({
      key: "reset-mutation-recovery-blocked",
      message: this.i18n.t("notice.sync.recoveryResetBlocked"),
      priority: NOTICE_PRIORITY.attention,
      durationMs: 10_000,
    });
    this.updateStatusBar();
    this.syncView?.render();
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

  private async handleSyncResult(
    result: SyncResult,
    mode: SyncMode,
    recoveryOnly = false,
    recoveryContext: MutationRecoveryRunContext = {
      priorTotal: 0,
      priorRemaining: 0,
      newRemaining: 0,
    },
  ): Promise<void> {
    const harmlessRejectedRun = result.message === this.i18n.t("result.alreadyRunning");
    const retryableMutationRecovery =
      result.mutationRecovery?.state === "network-unavailable"
      && !result.authExpired
      && result.message !== this.i18n.t("result.cancelled")
      && !(this.state?.planReviewActive ?? false);
    const blockedMutationRecovery =
      result.mutationRecovery?.state === "blocked"
      && !result.authExpired
      && result.message !== this.i18n.t("result.cancelled");

    if (retryableMutationRecovery) {
      this.clearSyncLifecycleNotice();
      this.mutationRecoveryBlockReason = null;
      await this.recordSyncHistory(
        result,
        mode,
        recoveryOnly,
        recoveryContext,
      );
      if (
        !recoveryOnly
        && this.syncInterval > 0
        && !this.autoSyncPaused
      ) {
        this.mutationRecoveryScheduler.continueAfterExternalFailure(
          result.mutationRecovery?.retryAfterSeconds ?? null,
        );
      }
      this.clearRibbonSuccess();
      this.updateStatusBar();
      this.syncView?.render();
      return;
    }

    if (blockedMutationRecovery) {
      this.clearSyncLifecycleNotice();
      this.mutationRecoveryBlockReason =
        result.mutationRecovery?.blockReason ?? "unknown";
      this.autoSyncPaused = true;
      this.stopAutoSync();
      await this.saveSyncSettings();
      await this.recordSyncHistory(
        result,
        mode,
        recoveryOnly,
        recoveryContext,
      );
      this.showMutationRecoveryBlockedNotice();
      this.diag.warn(
        "execute",
        `automatic mutation recovery stopped: ${this.mutationRecoveryBlockReason}`,
      );
      this.clearRibbonSuccess();
      this.updateStatusBar();
      this.syncView?.render();
      return;
    }

    if (recoveryOnly && result.mutationRecovery?.state === "settled") {
      this.clearSyncLifecycleNotice();
      this.mutationRecoveryBlockReason = null;
      await this.recordSyncHistory(
        result,
        mode,
        true,
        recoveryContext,
      );
      this.showMutationRecoveryRecoveredNotice(
        result.mutationRecovery.settled,
      );
      this.clearRibbonSuccess();
      this.updateStatusBar();
      this.syncView?.render();
      return;
    }

    const retryingDescendantFileReconstruction =
      result.continueAfterConfirmedDescendantFileReconstruction === true
      && result.descendantFileReconstructionRetryableFailure === true;
    const pauseAutoSync =
      !retryableMutationRecovery
      && !retryingDescendantFileReconstruction
      && (
      (!result.success && !harmlessRejectedRun)
      || result.errors > 0
      || result.conflicts > 0
      || result.authExpired
      || result.message === this.i18n.t("result.cancelled")
      || result.message === this.i18n.t("result.pausedForReview")
      || (this.state?.planReviewActive ?? false)
      );
    this.finishSyncNotice(result);
    await this.recordSyncHistory(
      result,
      mode,
      recoveryOnly,
      recoveryContext,
    );
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
    if (isSyncResultFullyComplete(result)) this.showRibbonSuccess();
    else this.clearRibbonSuccess();
    this.updateStatusBar();
    this.syncView?.render();
  }

  private async recordSyncHistory(
    result: SyncResult,
    mode: SyncMode,
    recoveryOnly: boolean,
    recoveryContext: MutationRecoveryRunContext,
  ): Promise<void> {
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
    const activeRecoveryEntry = this.state.syncHistory.find(
      (entry) => entry.recovery?.state !== undefined
        && entry.recovery.state !== "recovered",
    );
    const priorRecoverySettled = Math.max(
      0,
      recoveryContext.priorTotal - recoveryContext.priorRemaining,
    );
    let priorRecoveryWithoutEntry: MutationRecoveryHistory | undefined;
    if (recoveryContext.priorTotal > 0 && activeRecoveryEntry) {
      const previous = activeRecoveryEntry.recovery!;
      const total = Math.max(previous.total, recoveryContext.priorTotal);
      const priorRecovery: MutationRecoveryHistory =
        recoveryContext.priorRemaining === 0
          ? {
              state: "recovered",
              total,
              settled: total,
              remaining: 0,
              updatedAt: endedAt,
            }
          : this.buildMutationRecoveryHistory(
              result.mutationRecovery,
              {
                total,
                settled: Math.max(
                  previous.settled,
                  total - recoveryContext.priorRemaining,
                  priorRecoverySettled,
                ),
                remaining: recoveryContext.priorRemaining,
              },
              endedAt,
            );
      try {
        await this.state.addSyncHistory({
          ...activeRecoveryEntry,
          status: priorRecovery.state === "recovered"
            ? "success"
            : "partial",
          endedAt,
          errors: priorRecovery.state === "blocked"
            ? Math.max(1, activeRecoveryEntry.errors)
            : priorRecovery.state === "recovered"
              ? 0
              : activeRecoveryEntry.errors,
          recovery: priorRecovery,
        });
      } catch (error) {
        this.diag.warn(
          "state",
          `sync recovery history update failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (recoveryContext.priorTotal > 0) {
      priorRecoveryWithoutEntry = this.buildMutationRecoveryHistory(
        result.mutationRecovery,
        {
          total: recoveryContext.priorTotal,
          settled: priorRecoverySettled,
          remaining: recoveryContext.priorRemaining,
        },
        endedAt,
      );
    }

    const stoppedInsidePriorRecovery =
      recoveryContext.priorTotal > 0
      && recoveryContext.priorRemaining > 0
      && (
        result.mutationRecovery !== undefined
        || result.message === this.i18n.t("result.cancelled")
      );
    if (recoveryOnly || stoppedInsidePriorRecovery) {
      if (priorRecoveryWithoutEntry) {
        await this.createMutationRecoveryHistoryEntry(
          priorRecoveryWithoutEntry,
          progress.startedAt,
        );
      }
      return;
    }

    const status = resolveSyncHistoryStatus(result, {
      cancelled: result.message === this.i18n.t("result.cancelled"),
    });
    const newRecovery = recoveryContext.newRemaining > 0
      && result.mutationRecovery
      ? this.buildMutationRecoveryHistory(
          result.mutationRecovery,
          {
            total: Math.max(
              recoveryContext.newRemaining,
              result.mutationRecovery.total,
            ),
            settled: result.mutationRecovery.settled,
            remaining: recoveryContext.newRemaining,
          },
          endedAt,
        )
      : undefined;
    try {
      await this.state.addSyncHistory({
        id: `${progress.startedAt}-${endedAt}`,
        mode,
        status,
        startedAt: progress.startedAt,
        endedAt,
        uploaded: result.uploaded,
        downloaded: result.downloaded,
        foldersCreated: result.foldersCreated,
        foldersMoved: result.foldersMoved,
        foldersDeleted: result.foldersDeleted,
        filesMoved: result.filesMoved,
        deleted: result.deleted,
        conflicts: result.conflicts,
        deferred: result.deferred,
        skipped: result.skippedLarge + result.skippedIgnored,
        skippedLarge: result.skippedLarge,
        skippedIgnored: result.skippedIgnored,
        errors: result.errors,
        message: result.message,
        attention: result.attention,
        files: [...progress.completedFiles],
        uploadBytes: result.metrics?.uploadBytes,
        uploadReadMs: result.metrics?.uploadReadMs,
        uploadNetworkMs: result.metrics?.uploadNetworkMs,
        peakUploads: result.metrics?.peakUploads,
        recovery: newRecovery ?? priorRecoveryWithoutEntry,
        remoteScopeRecovery: result.remoteScopeRecovery,
      });
    } catch (error) {
      this.diag.warn(
        "state",
        `sync history save failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private buildMutationRecoveryHistory(
    summary: MutationRecoveryRunSummary | undefined,
    counts: { total: number; settled: number; remaining: number },
    updatedAt: number,
  ): MutationRecoveryHistory {
    if (summary?.state === "settled" || counts.remaining === 0) {
      return {
        state: "recovered",
        total: counts.total,
        settled: Math.max(counts.total, counts.settled),
        remaining: 0,
        updatedAt,
      };
    }
    if (summary?.state === "blocked") {
      return {
        state: "blocked",
        ...counts,
        updatedAt,
        blockReason:
          summary.blockReason
          ?? this.mutationRecoveryBlockReason
          ?? "unknown",
        ...(summary.blockedOperationId
          ? { blockedOperationId: summary.blockedOperationId }
          : {}),
      };
    }
    const retryAt =
      this.mutationRecoveryScheduler.snapshot.nextObservationAt ?? undefined;
    return {
      state: "waiting-network",
      ...counts,
      updatedAt,
      ...(retryAt !== undefined ? { retryAt } : {}),
    };
  }

  getMutationRecoveryDisplayState(): MutationRecoveryDisplayState | null {
    const state = this.state;
    if (!state?.isV2StateActive) return null;
    const mutationLedger = state.mutationLedger ?? [];
    const recoveryQuarantine = state.mutationRecoveryQuarantine ?? [];
    const ledgerRemaining = mutationLedger.length;
    const corruptEvidence =
      state.hasMutationLedgerCorruption
      || state.hasMutationRecoveryQuarantineCorruption;
    const remaining = ledgerRemaining > 0
      ? ledgerRemaining
      : corruptEvidence
        ? Math.max(1, recoveryQuarantine.length)
        : 0;
    if (remaining === 0) return null;

    const historyRecovery = (state.syncHistory ?? []).find(
      (entry) => entry.recovery?.state !== undefined
        && entry.recovery.state !== "recovered",
    )?.recovery;
    const total = Math.max(remaining, historyRecovery?.total ?? remaining);
    const scheduler = this.mutationRecoveryScheduler.snapshot;
    const progress = this.progressStore.state;
    const checking =
      scheduler.state === "running"
      || (
        progress.activityKind === "mutationRecovery"
        && isAnySyncActivityRunning(
          progress,
          this.syncExecutor?.isRunning ?? false,
          this.syncExecutor?.hasSideActionsInFlight ?? false,
        )
      );
    const retryAt = scheduler.state === "scheduled"
      ? scheduler.nextObservationAt
      : null;
    const kind = checking
      ? "checking"
      : retryAt !== null && retryAt > Date.now()
        ? "waiting-network"
        : this.autoSyncPaused
            || corruptEvidence
            || historyRecovery?.state === "blocked"
          ? "blocked"
          : "checking";
    const blockReason = kind === "blocked"
      ? this.mutationRecoveryBlockReason
        ?? (corruptEvidence ? "evidence-corrupt" : null)
        ?? historyRecovery?.blockReason
        ?? "unknown"
      : null;
    const blockedOperationId = kind === "blocked"
      ? historyRecovery?.blockedOperationId
        ?? mutationLedger[0]?.intent.operationId
        ?? null
      : null;
    const firstBlockedRecord = blockedOperationId
      ? mutationLedger.find(
          (entry) => entry.intent.operationId === blockedOperationId,
        )
      : undefined;
    return {
      kind,
      total,
      settled: Math.max(
        historyRecovery?.settled ?? 0,
        total - remaining,
      ),
      remaining,
      retryAt,
      firstPath: firstBlockedRecord?.intent.path
        ?? mutationLedger[0]?.intent.path
        ?? null,
      blockReason,
      blockedOperationId,
      manualResolutionAvailable: kind === "blocked"
        && blockReason === "facts-changed"
        && this.syncExecutor?.canResolveMutationRecovery(
          blockedOperationId ?? undefined,
        ) === true,
    };
  }

  private async handleMutationRecoverySchedulerState(
    snapshot: MutationRecoverySchedulerSnapshot,
  ): Promise<void> {
    if (
      snapshot.state === "scheduled"
      && snapshot.nextObservationAt !== null
    ) {
      await this.updateActiveMutationRecoveryHistory((recovery) => ({
        ...recovery,
        state: "waiting-network",
        retryAt: snapshot.nextObservationAt ?? undefined,
        updatedAt: Date.now(),
      }));
      this.showMutationRecoveryWaitingNotice();
    } else {
      this.noticeCenter.clear("sync-result:recovery-waiting");
    }
    this.updateStatusBar();
    this.syncView?.render();
  }

  private async updateActiveMutationRecoveryHistory(
    update: (recovery: MutationRecoveryHistory) => MutationRecoveryHistory,
  ): Promise<void> {
    const state = this.state;
    if (!state) return;
    const entry = (state.syncHistory ?? []).find(
      (candidate) => candidate.recovery?.state !== undefined
        && candidate.recovery.state !== "recovered",
    );
    const display = this.getMutationRecoveryDisplayState();
    const seed = entry?.recovery ?? (display
      ? {
          state: display.kind === "blocked"
            ? "blocked" as const
            : "waiting-network" as const,
          total: display.total,
          settled: display.settled,
          remaining: display.remaining,
          updatedAt: Date.now(),
          ...(display.retryAt !== null
            ? { retryAt: display.retryAt }
            : {}),
          ...(display.blockReason !== null
            ? { blockReason: display.blockReason }
            : {}),
          ...(display.blockedOperationId !== null
            ? { blockedOperationId: display.blockedOperationId }
            : {}),
        }
      : null);
    if (!seed) return;
    const recovery = update(seed);
    if (!entry) {
      await this.createMutationRecoveryHistoryEntry(recovery);
      return;
    }
    const existingRecovery = entry.recovery;
    if (
      existingRecovery
      && recovery.state === existingRecovery.state
      && recovery.total === existingRecovery.total
      && recovery.settled === existingRecovery.settled
      && recovery.remaining === existingRecovery.remaining
      && recovery.retryAt === existingRecovery.retryAt
      && recovery.blockReason === existingRecovery.blockReason
      && recovery.blockedOperationId === existingRecovery.blockedOperationId
    ) return;
    try {
      await state.addSyncHistory({
        ...entry,
        status: recovery.state === "recovered"
          ? "success"
          : "partial",
        endedAt: recovery.updatedAt,
        errors: recovery.state === "blocked"
          ? Math.max(1, entry.errors)
          : recovery.state === "recovered"
            ? 0
            : entry.errors,
        recovery,
      });
    } catch (error) {
      this.diag.warn(
        "state",
        `sync recovery history refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async createMutationRecoveryHistoryEntry(
    recovery: MutationRecoveryHistory,
    startedAtHint?: number,
  ): Promise<void> {
    const state = this.state;
    if (!state) return;
    const now = Date.now();
    const eventStartedAt = (state.mutationLedger ?? []).reduce(
      (oldest, record) => Math.min(oldest, record.intent.createdAt),
      startedAtHint && startedAtHint > 0 ? startedAtHint : now,
    );
    try {
      await state.addSyncHistory({
        id: `mutation-recovery-${eventStartedAt}`,
        mode: "auto",
        status: recovery.state === "recovered" ? "success" : "partial",
        startedAt: eventStartedAt,
        endedAt: now,
        uploaded: 0,
        downloaded: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
        filesMoved: 0,
        deleted: 0,
        conflicts: 0,
        deferred: 0,
        skipped: 0,
        skippedLarge: 0,
        skippedIgnored: 0,
        errors: recovery.state === "blocked" ? 1 : 0,
        message: this.i18n.t(
          recovery.state === "blocked"
            ? "result.v2RecoveryBlocked"
            : recovery.state === "recovered"
              ? "notice.sync.recoveryRecovered"
              : "progress.recoveringMutation",
          recovery.state === "recovered"
            ? { settled: recovery.settled }
            : undefined,
        ),
        files: [],
        recovery,
      });
    } catch (error) {
      this.diag.warn(
        "state",
        `sync recovery history create failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private showMutationRecoveryWaitingNotice(): void {
    if (this.shouldSuppressSyncNotice()) {
      this.noticeCenter.clear("sync-result:recovery-waiting");
      return;
    }
    const recovery = this.getMutationRecoveryDisplayState();
    if (
      !recovery
      || recovery.kind !== "waiting-network"
      || recovery.retryAt === null
    ) return;
    this.noticeCenter.show({
      key: "sync-result:recovery-waiting",
      message: this.i18n.t("notice.sync.recoveryWaiting", {
        remaining: recovery.remaining,
        time: new Date(recovery.retryAt).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      }),
      priority: NOTICE_PRIORITY.action,
      durationMs: 5_000,
      className: "easy-sync-notice-result",
    });
  }

  private showMutationRecoveryRecoveredNotice(settled: number): void {
    if (this.shouldSuppressSyncNotice()) return;
    this.noticeCenter.show({
      key: "sync-result:recovery-recovered",
      message: this.i18n.t("notice.sync.recoveryRecovered", { settled }),
      priority: NOTICE_PRIORITY.info,
      durationMs: SYNC_RESULT_NOTICE_DURATION_MS,
      className: "easy-sync-notice-result",
    });
  }

  private showMutationRecoveryBlockedNotice(): void {
    if (this.shouldSuppressSyncNotice()) return;
    const recovery = this.getMutationRecoveryDisplayState();
    const reason = mutationRecoveryBlockReasonText(
      recovery?.blockReason,
      this.i18n.t.bind(this.i18n),
    );
    this.noticeCenter.show({
      key: "sync-result:recovery-blocked",
      message: recovery?.firstPath
        ? this.i18n.t("notice.sync.recoveryBlocked", {
            reason,
            remaining: recovery.remaining,
            path: recovery.firstPath,
          })
        : this.i18n.t("notice.sync.recoveryBlockedNoPath", {
            reason,
            remaining: recovery?.remaining ?? 1,
          }),
      priority: NOTICE_PRIORITY.attention,
      durationMs: 8_000,
      className: "easy-sync-notice-result",
    });
  }

  private async pauseForMutationRecoveryBlock(
    reason: MutationRecoveryBlockReason,
  ): Promise<void> {
    this.mutationRecoveryBlockReason = reason;
    this.autoSyncPaused = true;
    this.stopAutoSync();
    try {
      await this.saveSyncSettings();
    } catch (error) {
      this.diag.error(
        "state",
        "failed to persist automatic pause after mutation recovery block",
        error,
      );
    }
    const display = this.getMutationRecoveryDisplayState();
    if (display) {
      await this.updateActiveMutationRecoveryHistory((previous) => ({
        state: "blocked",
        total: Math.max(previous.total, display.total),
        settled: Math.max(previous.settled, display.settled),
        remaining: display.remaining,
        updatedAt: Date.now(),
        blockReason: reason,
        blockedOperationId: previous.blockedOperationId,
      }));
    }
    this.showMutationRecoveryBlockedNotice();
    this.clearRibbonSuccess();
    this.updateStatusBar();
    this.syncView?.render();
  }

  // ---- Auto-sync ----

  /**
   * Persisted V2 mutation intent is itself a recovery trigger. This gate only
   * arms the timer-only scheduler; the scheduler cannot inspect or mutate
   * sync state and still re-enters through the shared operation lock.
   */
  private requestMutationRecoveryObservation(trigger: string): boolean {
    if (
      this.syncInterval <= 0
      || this.autoSyncPaused
      || !this._stateLoaded
      || !this.auth?.authState.isLoggedIn
      || !this.state?.isV2StateActive
      || this.state.planReviewActive
    ) return false;
    if (
      this.state.hasMutationLedgerCorruption
      || this.state.hasMutationRecoveryQuarantineCorruption
    ) {
      void this.pauseForMutationRecoveryBlock("evidence-corrupt");
      return false;
    }
    if (this.state.hasV2StateLoadRecoveryBlock) {
      void this.pauseForMutationRecoveryBlock("state-unavailable");
      return false;
    }
    if (this.state.hasV2RemoteScopeRecovery) {
      void this.pauseForMutationRecoveryBlock("scope-changed");
      return false;
    }
    if (this.state.mutationLedger.length === 0) return false;
    const scheduled = this.mutationRecoveryScheduler.requestObservation();
    if (scheduled) {
      this.diag.log(
        "execute",
        `mutation recovery observation scheduled — trigger=${trigger}`,
        {
          remaining: this.state.mutationLedger.length,
          mutations: 0,
        },
      );
    }
    return scheduled;
  }

  /**
   * One scheduler observation. The executor may settle existing intent but
   * recoveryOnly guarantees that this run returns before ordinary planning.
   */
  private async runScheduledMutationRecovery():
    Promise<MutationRecoveryAttemptOutcome> {
    if (
      this.syncInterval <= 0
      || this.autoSyncPaused
      || !this.auth?.authState.isLoggedIn
      || !this.syncExecutor
    ) return { state: "inactive" };
    if (this.opLock !== null || this.syncExecutor.isRunning) {
      return { state: "busy" };
    }
    if (this.acquireOpLock("mutation-recovery")) return { state: "busy" };
    let settled = false;
    try {
      await this.ensureStateLoaded();
      if (
        !this.state?.isV2StateActive
        || this.state.mutationLedger.length === 0
      ) return { state: "inactive" };
      if (this.state.planReviewActive) return { state: "inactive" };
      if (
        this.state.hasMutationLedgerCorruption
        || this.state.hasMutationRecoveryQuarantineCorruption
      ) {
        await this.pauseForMutationRecoveryBlock("evidence-corrupt");
        return { state: "blocked" };
      }
      if (this.state.hasV2StateLoadRecoveryBlock) {
        await this.pauseForMutationRecoveryBlock("state-unavailable");
        return { state: "blocked" };
      }
      if (this.state.hasV2RemoteScopeRecovery) {
        await this.pauseForMutationRecoveryBlock("scope-changed");
        return { state: "blocked" };
      }
      if (!await this.checkAccountBinding({
        suppressNotice: true,
        allowInitialBind: false,
      })) {
        await this.pauseForMutationRecoveryBlock("account-changed");
        return { state: "blocked" };
      }

      this.diag.log("execute", "scheduled mutation recovery observation started", {
        remaining: this.state.mutationLedger.length,
        mutations: 0,
      });
      const result = await this.dispatchSyncRun({
        mode: "auto",
        options: { recoveryOnly: true },
        logLabel: "scheduled mutation recovery result",
      });
      const recovery = result?.mutationRecovery;
      if (!recovery) {
        if (this.state.mutationLedger.length > 0) {
          await this.pauseForMutationRecoveryBlock("state-unavailable");
        }
        return { state: "blocked" };
      }
      if (recovery.state === "network-unavailable") {
        return {
          state: "retry",
          retryAfterSeconds: recovery.retryAfterSeconds,
        };
      }
      if (recovery.state === "blocked") return { state: "blocked" };
      settled = recovery.remaining === 0;
      if (!settled) {
        await this.pauseForMutationRecoveryBlock("state-unavailable");
        return { state: "blocked" };
      }
      return { state: "settled" };
    } catch (error) {
      this.diag.warn(
        "execute",
        "scheduled mutation recovery setup failed",
        error instanceof Error ? error.message : String(error),
      );
      if (
        this.state?.isV2StateActive
        && this.state.mutationLedger.length > 0
      ) {
        await this.pauseForMutationRecoveryBlock("state-unavailable");
      }
      return { state: "blocked" };
    } finally {
      this.releaseOpLock();
      if (
        settled
        && this.syncInterval > 0
        && !this.autoSyncPaused
      ) {
        this.diag.log(
          "execute",
          "mutation recovery settled; continuing through a new canonical V2 round",
          { mutations: 0 },
        );
        void this.runAutomaticSync("recovery-continuation");
      }
    }
  }

  private async pauseAfterMutationRecoveryBudget(): Promise<void> {
    if (
      this.autoSyncPaused
      || !this.state?.isV2StateActive
      || this.state.mutationLedger.length === 0
    ) return;
    this.diag.warn(
      "execute",
      "automatic mutation recovery budget exhausted; evidence retained",
      {
        remaining: this.state.mutationLedger.length,
        mutations: 0,
      },
    );
    await this.pauseForMutationRecoveryBlock(
      "automatic-budget-exhausted",
    );
  }

  private markLocalDirtyHint(path: string, oldPath?: string): void {
    if (!this.canScheduleLocalChangeAutoSync()) return;
    const currentIncluded = this.scanner?.shouldSyncPath(path) === true;
    const previousIncluded = oldPath !== undefined
      && this.scanner?.shouldSyncPath(oldPath) === true;
    if (!currentIncluded && !previousIncluded) return;
    if (this.autoSyncDirtyHint.mark()) {
      this.diag.log("execute", "local dirty hint scheduled normal auto sync", {
        debounceMs: this.autoSyncChangeDelaySeconds * 1_000,
        scopeMatch: currentIncluded ? "current" : "previous",
      });
    }
  }

  private markLocalDirtyFolderHint(path: string, oldPath?: string): void {
    if (!this.canScheduleLocalChangeAutoSync()) return;
    const currentIncluded =
      this.scanner?.shouldSyncFolderPath(path) === true;
    const previousIncluded = oldPath !== undefined
      && this.scanner?.shouldSyncFolderPath(oldPath) === true;
    if (!currentIncluded && !previousIncluded) return;
    if (this.autoSyncDirtyHint.mark()) {
      this.diag.log("execute", "local dirty hint scheduled normal auto sync", {
        debounceMs: this.autoSyncChangeDelaySeconds * 1_000,
        scopeMatch: currentIncluded ? "current" : "previous",
      });
    }
  }

  private handleLocalVaultChange(
    file: { path: string },
    kind: "create" | "modify" = "modify",
  ): void {
    if (file instanceof TFolder) {
      this.markLocalDirtyFolderHint(file.path);
    } else {
      this.markLocalDirtyHint(file.path);
    }
    if (kind === "create" || kind === "modify") {
      this.invalidateCommunityPluginLocalReconciliationForPath(file.path);
    }
    this.scheduleCommunityPluginInventoryRevisionForPaths(
      kind,
      { path: file.path, isFolder: file instanceof TFolder },
    );
  }

  private async handleLocalVaultDelete(file: { path: string }): Promise<void> {
    if (!(file instanceof TFolder)) {
      this.markLocalDirtyHint(file.path);
      this.scheduleCommunityPluginInventoryRevisionForPaths(
        "delete",
        { path: file.path, isFolder: false },
      );
      const pluginId = this.parseCommunityPluginManagedPathPluginId(file.path);
      if (pluginId && !file.path.endsWith("/data.json")) {
        this.queueCommunityPluginLocalReconciliation(pluginId);
        this.scheduleCommunityPluginLocalReconciliationFollowUp();
      }
      return;
    }

    const pluginId = this.parseCommunityPluginRootPath(file.path);
    if (!pluginId) {
      this.markLocalDirtyFolderHint(file.path);
      this.scheduleCommunityPluginInventoryRevisionForPaths(
        "delete",
        { path: file.path, isFolder: true },
      );
      return;
    }

    this.markLocalDirtyFolderHint(file.path);
    this.queueCommunityPluginLocalReconciliation(pluginId);
    await this.flushCommunityPluginLocalReconciliation();
  }

  private queueCommunityPluginLocalReconciliation(pluginId: string): void {
    this.pendingCommunityPluginReconciliationIds.set(
      pluginId,
      ++this.communityPluginReconciliationToken,
    );
  }

  private scheduleCommunityPluginLocalReconciliationFollowUp(): void {
    compatClearTimeout(this.communityPluginLocalReconciliationTimer);
    this.communityPluginLocalReconciliationTimer = compatSetTimeout(() => {
      this.communityPluginLocalReconciliationTimer = null;
      void this.flushCommunityPluginLocalReconciliation();
    }, COMMUNITY_PLUGIN_FILE_DELETE_UNINSTALL_DELAY_MS);
  }

  private invalidateCommunityPluginLocalReconciliationForPath(
    path: string,
  ): void {
    const pluginId = this.parseCommunityPluginManagedPathPluginId(path);
    if (!pluginId) return;
    if (
      !this.syncCommunityPlugins
      && this.communityPluginParticipation?.scopeEnabled !== true
    ) return;
    this.communityPluginReconciliationToken += 1;
    this.pendingCommunityPluginReconciliationIds.delete(pluginId);
    const phase =
      this.communityPluginParticipation?.pluginsById[pluginId]?.phase;
    if (
      phase === "exit-requested"
      || phase === "never-participated"
      || phase === undefined
    ) {
      this.queueCommunityPluginLocalReconciliation(pluginId);
      void this.flushCommunityPluginLocalReconciliation();
    }
  }

  private async scheduleCommunityPluginLocalReconciliation(
    trigger: string,
  ): Promise<void> {
    const participation = this.communityPluginParticipation;
    if (!participation?.scopeEnabled) return;
    for (const entry of Object.values(participation.pluginsById)) {
      if (
        entry.phase === "participating"
        || entry.phase === "exit-requested"
      ) {
        this.queueCommunityPluginLocalReconciliation(entry.pluginId);
      }
    }
    for (const pluginId of await this.listLocalCommunityPluginIdsForParticipation()) {
      const phase = participation.pluginsById[pluginId]?.phase;
      if (phase === undefined || phase === "never-participated") {
        this.queueCommunityPluginLocalReconciliation(pluginId);
      }
    }
    if (this.pendingCommunityPluginReconciliationIds.size === 0) {
      return;
    }
    this.diag?.log(
      "state",
      "scheduled community plugin local participation reconciliation",
      { trigger, mutations: 0 },
    );
    return this.flushCommunityPluginLocalReconciliation();
  }

  private async listLocalCommunityPluginIdsForParticipation():
    Promise<string[]> {
    const configDir = getConfigDir(this.app.vault).replace(/\/+$/, "");
    const pluginRoot = `${configDir}/plugins`;
    const adapter = this.app.vault.adapter;
    try {
      if (!await adapter.exists(pluginRoot)) return [];
      const listed = await adapter.list(pluginRoot);
      return normalizePluginIds(
        listed.folders.map((path) =>
          path.replace(/\/+$/, "").split("/").pop() ?? ""
        ),
        this.manifest.id,
      );
    } catch (error) {
      this.diag.warn(
        "state",
        "community plugin local participation inventory unavailable",
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  private flushCommunityPluginLocalReconciliation(): Promise<void> {
    const operationEpoch = this.operationLifecycle.capture();
    const attempt = this.communityPluginLocalReconciliationQueue.then(async () => {
      if (this.pendingCommunityPluginReconciliationIds.size === 0) return;
      if (!this.operationLifecycle.isCurrent(operationEpoch)) return;
      await this.ensureStateLoaded();
      if (!this.operationLifecycle.isCurrent(operationEpoch)) return;
      const pending = [...this.pendingCommunityPluginReconciliationIds];
      if (
        this.state?.isV2StateActive !== true
        || typeof this.state.getCommunityPluginParticipation !== "function"
      ) {
        for (const [pluginId, token] of pending) {
          if (
            this.pendingCommunityPluginReconciliationIds.get(pluginId)
              === token
          ) {
            this.pendingCommunityPluginReconciliationIds.delete(pluginId);
          }
        }
        return;
      }
      const outcome =
        await this.reconcileCommunityPluginParticipationFromLocalBundles({
          pluginIds: pending.map(([pluginId]) => pluginId),
          trigger: "local-reconciliation-queue",
        });
      const followUp = new Set(outcome.followUpPluginIds);
      for (const [pluginId, token] of pending) {
        if (
          !followUp.has(pluginId)
          && this.pendingCommunityPluginReconciliationIds.get(pluginId)
            === token
        ) {
          this.pendingCommunityPluginReconciliationIds.delete(pluginId);
        }
      }
      if (followUp.size > 0) {
        this.scheduleCommunityPluginLocalReconciliationFollowUp();
      }
    });

    this.communityPluginLocalReconciliationQueue = attempt.catch((error) => {
      // A concurrent sync or recovery can temporarily own the settings
      // transaction. The ordinary sync-time detector remains the durable
      // fallback; never turn a Vault event rejection into an unhandled task.
      this.diag.warn(
        "lifecycle",
        "community plugin local participation reconciliation deferred",
        error instanceof Error ? error.message : String(error),
      );
      if (
        error instanceof SyncPathSettingsUpdateError
        && error.code === "busy"
      ) {
        this.communityPluginReconciliationRetryOnLockRelease = true;
      }
      this.advanceCommunityPluginInventoryRevision();
      this.retryCommunityPluginLocalReconciliationIfIdle();
    });
    return this.communityPluginLocalReconciliationQueue;
  }

  private retryCommunityPluginLocalReconciliationIfIdle(): void {
    if (this.pendingCommunityPluginReconciliationIds.size === 0) {
      this.communityPluginReconciliationRetryOnLockRelease = false;
      return;
    }
    if (
      !this.communityPluginReconciliationRetryOnLockRelease
      || this.opLock !== null
      || this.syncExecutor?.hasActivityInFlight === true
    ) return;
    this.communityPluginReconciliationRetryOnLockRelease = false;
    void this.flushCommunityPluginLocalReconciliation();
  }

  private parseCommunityPluginRootPath(path: string): string | null {
    const configDir = getConfigDir(this.app.vault).replace(/\/+$/, "");
    const prefix = `${configDir}/plugins/`;
    if (!path.startsWith(prefix)) return null;
    const pluginId = path.slice(prefix.length);
    if (pluginId.includes("/")) return null;
    const normalized = normalizePluginIds([pluginId], this.manifest.id);
    return normalized.length === 1 && normalized[0] === pluginId
      ? pluginId
      : null;
  }

  private parseCommunityPluginManagedPathPluginId(path: string): string | null {
    const configDir = getConfigDir(this.app.vault).replace(/\/+$/, "");
    const prefix = `${configDir}/plugins/`;
    if (!path.startsWith(prefix)) return null;
    const parts = path.slice(prefix.length).split("/");
    if (parts.length < 1 || parts.length > 2) return null;
    if (
      parts.length === 2
      && !["main.js", "manifest.json", "styles.css", "data.json"].includes(
        parts[1],
      )
    ) return null;
    const pluginId = normalizePluginIds([parts[0]], this.manifest.id)[0];
    return pluginId === parts[0] ? pluginId : null;
  }

  private async handleLocalVaultRename(
    file: { path: string },
    oldPath: string,
  ): Promise<void> {
    if (file instanceof TFolder) {
      // The folder identity hint is the durable evidence used by the next
      // scan. Never let the dirty timer overtake that persistence attempt.
      await this.captureLocalFolderMoveHint(oldPath, file.path);
      const previousPluginId = this.parseCommunityPluginRootPath(oldPath);
      const currentPluginId = this.parseCommunityPluginRootPath(file.path);
      if (currentPluginId) {
        this.invalidateCommunityPluginLocalReconciliationForPath(file.path);
      }
      if (previousPluginId && currentPluginId !== previousPluginId) {
        this.queueCommunityPluginLocalReconciliation(previousPluginId);
        await this.flushCommunityPluginLocalReconciliation();
      } else {
        this.scheduleCommunityPluginInventoryRevisionForPaths(
          "rename",
          { path: oldPath, isFolder: true },
          { path: file.path, isFolder: true },
        );
      }
      this.markLocalDirtyFolderHint(file.path, oldPath);
      return;
    }
    this.invalidateCommunityPluginLocalReconciliationForPath(file.path);
    this.scheduleCommunityPluginInventoryRevisionForPaths(
      "rename",
      { path: oldPath, isFolder: false },
      { path: file.path, isFolder: false },
    );
    this.markLocalDirtyHint(file.path, oldPath);
  }

  private async captureLocalFolderMoveHint(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    try {
      await this.ensureStateLoaded();
      const state = this.state;
      if (!state) return;
      const recorded = await state.recordLocalFolderMoveHint(oldPath, newPath);
      if (recorded) {
        this.diag.log("state", "local folder move hint bound to committed V2 identity", {
          fromPath: oldPath,
          toPath: newPath,
        });
      }
    } catch (error) {
      this.diag.warn(
        "state",
        `local folder move hint was not retained: ${oldPath} -> ${newPath}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Shared activity-gated entry for periodic reconciliation and dirty hints. */
  private async runAutomaticSync(
    trigger:
      | "interval"
      | "dirty"
      | "recovery-continuation",
  ): Promise<boolean> {
    const persistedJoinPending = trigger === "dirty"
      && this.hasPendingCommunityPluginJoin();
    if (
      (!persistedJoinPending && this.syncInterval <= 0)
      || this.autoSyncPaused
    ) return true;
    if (!this.auth?.authState.isLoggedIn) return true;
    if (!this.syncExecutor) return false;
    if (this.opLock !== null || this.syncExecutor.isRunning) return false;
    if (this.acquireOpLock("sync")) return false;
    let dispatched = false;
    try {
      await this.ensureStateLoaded();
      if (await this.dispatchV2StateLoadBlockIfPresent(
        "auto",
        `blocked auto sync result (${trigger})`,
      )) {
        dispatched = true;
        return true;
      }
      if (!await this.checkAccountBinding()) return true;
      if (
        trigger !== "recovery-continuation"
        && this.state?.isV2StateActive
        && this.state.mutationLedger.length > 0
      ) {
        this.requestMutationRecoveryObservation(trigger);
        return true;
      }
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

  /**
   * Resume a persisted or retryable source-bound subtree baseline repair.
   * Successful work stays inside its originating visible sync; this scheduler
   * is only for lifecycle recovery or bounded retries after a real failure.
   */
  private requestDescendantFileReconstructionContinuation(
    trigger: string,
    delayMs = DESCENDANT_FILE_RECONSTRUCTION_CONTINUATION_DELAY_MS,
  ): boolean {
    if (trigger === "foreground") {
      this.descendantFileReconstructionFailures = 0;
    }
    if (
      this.descendantFileReconstructionTimer
      || !this.state?.confirmedDescendantFileReconstruction
      || this.state.hasV2StateLoadRecoveryBlock
      || this.state.planReviewActive
      || !this.auth?.authState.isLoggedIn
    ) return false;
    this.descendantFileReconstructionTimer = compatSetTimeout(() => {
      this.descendantFileReconstructionTimer = null;
      void this.runDescendantFileReconstructionContinuation();
    }, delayMs);
    this.diag.log(
      "state",
      "scheduled descendant file baseline reconstruction continuation",
      { trigger, delayMs, mutations: 0 },
    );
    return true;
  }

  private cancelDescendantFileReconstructionContinuation(): void {
    compatClearTimeout(this.descendantFileReconstructionTimer);
    this.descendantFileReconstructionTimer = null;
    this.descendantFileReconstructionFailures = 0;
  }

  private async runDescendantFileReconstructionContinuation(): Promise<void> {
    if (!this.state?.confirmedDescendantFileReconstruction) return;
    if (
      this.opLock !== null
      || !this.syncExecutor
      || this.syncExecutor.isRunning
    ) {
      this.requestDescendantFileReconstructionContinuation("activity-busy", 1_000);
      return;
    }
    if (this.acquireOpLock("sync")) {
      this.requestDescendantFileReconstructionContinuation("lock-busy", 1_000);
      return;
    }
    try {
      await this.ensureStateLoaded();
      if (
        !this.state?.confirmedDescendantFileReconstruction
        || this.state.hasV2StateLoadRecoveryBlock
        || this.state.planReviewActive
        || !this.auth?.authState.isLoggedIn
      ) return;
      if (!await this.checkAccountBindingForSync()) return;
      await this.dispatchSyncRun({
        mode: "auto",
        logLabel: "descendant file baseline continuation result",
      });
    } catch (error) {
      this.diag.warn(
        "state",
        "descendant file baseline continuation setup failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.releaseOpLock();
    }
  }

  startAutoSync(): void {
    if (this.autoSyncTimer) {
      compatClearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this.autoSyncPaused) return;
    this.schedulePersistedCommunityPluginJoinSync("auto-start");
    if (this.syncInterval <= 0) return;
    this.autoSyncTimer = compatSetInterval(() => {
      void this.runAutomaticSync("interval");
    }, this.syncInterval * 60 * 1000);
    this.requestMutationRecoveryObservation("auto-start");
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      compatClearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    this.autoSyncDirtyHint.cancel();
    this.mutationRecoveryScheduler.cancel();
  }

  private schedulePersistedCommunityPluginJoinSync(trigger: string): void {
    if (!this.hasPendingCommunityPluginJoin()) return;
    this.scheduleCommunityPluginJoinSync(trigger);
  }

  private scheduleCommunityPluginJoinSync(trigger = "settings"): void {
    if (this.autoSyncDirtyHint.mark()) {
      this.diag?.log(
        "state",
        "scheduled persisted community plugin join through the shared dirty trigger",
        { trigger, mutations: 0 },
      );
    }
  }

  private hasPendingCommunityPluginJoin(): boolean {
    const participation = this.communityPluginParticipation;
    return participation?.scopeEnabled === true
      && Object.values(participation.pluginsById).some((entry) =>
        entry.phase === "join-requested"
        || entry.phase === "restoring"
        || (entry.phase === "blocked"
          && isCommunityPluginJoinBlockRetryable(entry.blockedReason))
      );
  }

  restartAutoSync(): void {
    this.stopAutoSync();
    this.startAutoSync();
  }

  private canScheduleLocalChangeAutoSync(): boolean {
    return this.syncInterval > 0
      && !this.autoSyncPaused
      && this.autoSyncChangeDelaySeconds > 0;
  }

  setAutoSyncChangeDelaySeconds(value: unknown): void {
    this.autoSyncChangeDelaySeconds =
      normalizeAutoSyncChangeDelaySeconds(value);
    if (this.autoSyncChangeDelaySeconds === 0) {
      this.autoSyncDirtyHint.cancel();
      this.autoSyncDirtyHint.setDelayMs(LOCAL_DIRTY_DEBOUNCE_MS);
      this.schedulePersistedCommunityPluginJoinSync(
        "local-change-trigger-disabled",
      );
      return;
    }
    this.autoSyncDirtyHint.setDelayMs(
      this.autoSyncChangeDelaySeconds * 1_000,
    );
  }

  // ---- Settings persistence ----

  async loadSyncSettings(): Promise<void> {
    const data = await this.loadPluginData();
    this.setAutoSyncChangeDelaySeconds(
      data?.[KEY_AUTO_SYNC_CHANGE_DELAY_SECONDS],
    );
    if (data) {
      if (typeof data[KEY_SYNC_INTERVAL] === "number") this.syncInterval = data[KEY_SYNC_INTERVAL];
      if (typeof data[KEY_SYNC_PLUGIN_FILES] === "boolean") this.syncPluginFiles = data[KEY_SYNC_PLUGIN_FILES];
      if (typeof data[KEY_DIAG_LOG] === "boolean") this.diagLogEnabled = data[KEY_DIAG_LOG];
      if (typeof data[KEY_SYNC_EDITOR] === "boolean") this.syncEditorSettings = data[KEY_SYNC_EDITOR];
      if (typeof data[KEY_SYNC_APPEARANCE] === "boolean") this.syncAppearance = data[KEY_SYNC_APPEARANCE];
      if (typeof data[KEY_SYNC_THEMES] === "boolean") this.syncThemes = data[KEY_SYNC_THEMES];
      if (typeof data[KEY_SYNC_HOTKEYS] === "boolean") this.syncHotkeys = data[KEY_SYNC_HOTKEYS];
      if (typeof data[KEY_SYNC_CORE_PLUGINS] === "boolean") this.syncCorePlugins = data[KEY_SYNC_CORE_PLUGINS];
      if (typeof data[KEY_SYNC_BOOKMARKS] === "boolean") this.syncBookmarks = data[KEY_SYNC_BOOKMARKS];
      this.syncCommunityPlugins =
        data[KEY_SYNC_COMMUNITY_PLUGINS] === true;
      this.syncPluginData = this.syncCommunityPlugins
        && data[KEY_SYNC_PLUGIN_DATA] === true;
      const communityPluginSyncSettings =
        normalizeCommunityPluginSyncSettings(
          readCommunityPluginSyncPolicy(
            data[KEY_COMMUNITY_PLUGIN_SYNC_POLICY],
            this.syncCommunityPlugins,
            this.syncPluginData,
            this.manifest.id,
          ),
          this.syncCommunityPlugins,
          this.syncPluginData,
          this.manifest.id,
        );
      this.syncCommunityPlugins =
        communityPluginSyncSettings.filesEnabled;
      this.syncPluginData = communityPluginSyncSettings.dataEnabled;
      this.communityPluginSyncPolicy = communityPluginSyncSettings.policy;
      this.excludedFolders = normalizeExcludedFolders(
        Array.isArray(data[KEY_SYNC_EXCLUDED_FOLDERS])
          ? data[KEY_SYNC_EXCLUDED_FOLDERS]
          : [],
        getConfigDir(this.app.vault),
      );
      if (typeof data[KEY_AUTO_SYNC_PAUSED] === "boolean") this.autoSyncPaused = data[KEY_AUTO_SYNC_PAUSED];
      if (typeof data[KEY_MAX_FILE_SIZE_MB] === "number") this.syncMaxFileSizeMb = data[KEY_MAX_FILE_SIZE_MB];
      this.automaticHandlingPolicy = readAutomaticHandlingPolicy(
        data[KEY_AUTOMATIC_HANDLING_POLICY],
        data[KEY_LEGACY_AUTO_MERGE],
      );
    }
    this.applySyncPathSettings();
    this.applyMaxFileSize();
    this.applyDiagnosticSetting();
  }

  /** M14: serialized PluginData write. All callers (StateManager, settings,
   *  auth profile) mutate through this queue — no interleaved load-modify-save. */
  private async updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void> {
    const task = this.pluginDataQueue.then(async () => {
      const startupWriteStartedAt = this.startupPerformance.isCollecting
        ? performance.now()
        : 0;
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
        if (success && startupWriteStartedAt > 0) {
          this.startupPerformance.recordPluginDataWrite(
            performance.now() - startupWriteStartedAt,
          );
        }
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
    const startedAt = performance.now();
    let topLevelKeys: number | null = null;
    this.pluginDataLoadPromise ??= this.loadData()
      .then((data: unknown) => {
        this.pluginDataCache = isRecord(data) ? clonePluginData(data) : null;
        topLevelKeys = this.pluginDataCache === null
          ? 0
          : Object.keys(this.pluginDataCache).length;
        return this.pluginDataCache;
      })
      .finally(() => {
        this.startupPerformance.recordPluginDataRead(
          performance.now() - startedAt,
          topLevelKeys,
        );
        this.pluginDataLoadPromise = null;
      });
    return this.pluginDataLoadPromise;
  }

  private emitColdStartSummaryIfReady(): void {
    const summary = this.startupPerformance.takeCompletedSummary();
    if (!summary) return;
    this.diag.log("lifecycle", "plugin cold start summary", summary);
  }

  async saveSyncSettings(): Promise<void> {
    await this.updatePluginData((data) => {
      data[KEY_SYNC_INTERVAL] = this.syncInterval;
      data[KEY_AUTO_SYNC_CHANGE_DELAY_SECONDS] =
        this.autoSyncChangeDelaySeconds;
      data[KEY_DIAG_LOG] = this.diagLogEnabled;
      this.writeSyncPathSettingsData(data, this.captureSyncPathSettings());
      data[KEY_AUTO_SYNC_PAUSED] = this.autoSyncPaused;
      data[KEY_MAX_FILE_SIZE_MB] = this.syncMaxFileSizeMb;
      data[KEY_AUTOMATIC_HANDLING_POLICY] = { ...this.automaticHandlingPolicy };
    });
  }

  private captureSyncPathSettings(): SyncPathSettings {
    return {
      syncPluginFiles: this.syncPluginFiles,
      syncEditorSettings: this.syncEditorSettings,
      syncAppearance: this.syncAppearance,
      syncThemes: this.syncThemes,
      syncHotkeys: this.syncHotkeys,
      syncCorePlugins: this.syncCorePlugins,
      syncBookmarks: this.syncBookmarks,
      syncCommunityPlugins: this.syncCommunityPlugins,
      syncPluginData: this.syncPluginData,
      communityPluginSyncPolicy: cloneCommunityPluginSyncPolicy(
        this.communityPluginSyncPolicy,
      ),
      excludedFolders: [...this.excludedFolders],
    };
  }

  private writeSyncPathSettingsData(
    data: Record<string, unknown>,
    settings: Readonly<SyncPathSettings>,
  ): void {
    data[KEY_SYNC_PLUGIN_FILES] = settings.syncPluginFiles;
    data[KEY_SYNC_EDITOR] = settings.syncEditorSettings;
    data[KEY_SYNC_APPEARANCE] = settings.syncAppearance;
    data[KEY_SYNC_THEMES] = settings.syncThemes;
    data[KEY_SYNC_HOTKEYS] = settings.syncHotkeys;
    data[KEY_SYNC_CORE_PLUGINS] = settings.syncCorePlugins;
    data[KEY_SYNC_BOOKMARKS] = settings.syncBookmarks;
    data[KEY_SYNC_PLUGIN_DATA] = settings.syncPluginData;
    if (!this.communityPluginParticipation) {
      data[KEY_SYNC_COMMUNITY_PLUGINS] = settings.syncCommunityPlugins;
      data[KEY_COMMUNITY_PLUGIN_SYNC_POLICY] = cloneCommunityPluginSyncPolicy(
        settings.communityPluginSyncPolicy,
      );
    } else {
      const legacy = readCommunityPluginSyncPolicy(
        data[KEY_COMMUNITY_PLUGIN_SYNC_POLICY],
        false,
        false,
        this.manifest.id,
      );
      data[KEY_COMMUNITY_PLUGIN_SYNC_POLICY] = {
        ...legacy,
        data: cloneCommunityPluginSyncPolicy(
          settings.communityPluginSyncPolicy,
        ).data,
      };
    }
    data[KEY_SYNC_EXCLUDED_FOLDERS] = [...settings.excludedFolders];
  }

  private publishSyncPathSettings(settings: Readonly<SyncPathSettings>): void {
    this.syncPluginFiles = settings.syncPluginFiles;
    this.syncEditorSettings = settings.syncEditorSettings;
    this.syncAppearance = settings.syncAppearance;
    this.syncThemes = settings.syncThemes;
    this.syncHotkeys = settings.syncHotkeys;
    this.syncCorePlugins = settings.syncCorePlugins;
    this.syncBookmarks = settings.syncBookmarks;
    this.syncCommunityPlugins = settings.syncCommunityPlugins;
    this.syncPluginData = settings.syncPluginData;
    this.communityPluginSyncPolicy = cloneCommunityPluginSyncPolicy(
      settings.communityPluginSyncPolicy,
    );
    this.excludedFolders = [...settings.excludedFolders];
    this.applySyncPathSettings();
    if (typeof this.syncExecutor?.setCommunityPluginSyncPolicy === "function") {
      this.syncExecutor.setCommunityPluginSyncPolicy(
        this.getEffectiveCommunityPluginSyncPolicy(),
      );
    }
  }

  private getEffectiveCommunityPluginSyncPolicy(
    settings: Readonly<SyncPathSettings> = this.captureSyncPathSettings(),
  ): CommunityPluginSyncPolicyV1 {
    return createEffectiveCommunityPluginSyncPolicy(
      settings.communityPluginSyncPolicy,
      settings.syncCommunityPlugins,
      settings.syncPluginData,
    );
  }

  async createSyncExclusionFolderSnapshot(): Promise<{
    hadPendingReview: boolean;
    remoteFolderPaths: string[];
  }> {
    await this.ensureStateLoaded();
    if (!this.state) {
      return { hadPendingReview: false, remoteFolderPaths: [] };
    }
    return await this.state.createSyncExclusionFolderSnapshot(
      this.auth?.authState.accountId ?? "",
    );
  }

  async updateSyncPathSettings(
    patch: Partial<SyncPathSettings>,
    operationEpoch?: number,
  ): Promise<void> {
    const previous = this.captureSyncPathSettings();
    const candidate: SyncPathSettings = {
      ...previous,
      ...patch,
      excludedFolders: normalizeExcludedFolders(
        patch.excludedFolders ?? previous.excludedFolders,
        getConfigDir(this.app.vault),
      ),
    };
    if (patch.communityPluginSyncPolicy) {
      candidate.communityPluginSyncPolicy = readCommunityPluginSyncPolicy(
        patch.communityPluginSyncPolicy,
        false,
        false,
        this.manifest.id,
      );
    } else {
      candidate.communityPluginSyncPolicy = cloneCommunityPluginSyncPolicy(
        previous.communityPluginSyncPolicy,
      );
    }
    const normalizedCommunityPluginSettings =
      normalizeCommunityPluginSyncSettings(
        candidate.communityPluginSyncPolicy,
        candidate.syncCommunityPlugins,
        candidate.syncPluginData,
        this.manifest.id,
      );
    candidate.syncCommunityPlugins =
      normalizedCommunityPluginSettings.filesEnabled;
    candidate.syncPluginData =
      normalizedCommunityPluginSettings.dataEnabled;
    candidate.communityPluginSyncPolicy =
      normalizedCommunityPluginSettings.policy;
    if (this.communityPluginParticipation) {
      candidate.syncCommunityPlugins =
        this.communityPluginParticipation.scopeEnabled;
      candidate.communityPluginSyncPolicy.files =
        cloneCommunityPluginSyncPolicy(
          this.communityPluginSyncPolicy,
        ).files;
      candidate.syncPluginData = candidate.syncCommunityPlugins
        && candidate.syncPluginData;
    }
    if (
      previous.syncPluginFiles === candidate.syncPluginFiles
      && previous.syncEditorSettings === candidate.syncEditorSettings
      && previous.syncAppearance === candidate.syncAppearance
      && previous.syncThemes === candidate.syncThemes
      && previous.syncHotkeys === candidate.syncHotkeys
      && previous.syncCorePlugins === candidate.syncCorePlugins
      && previous.syncBookmarks === candidate.syncBookmarks
      && previous.syncCommunityPlugins === candidate.syncCommunityPlugins
      && previous.syncPluginData === candidate.syncPluginData
      && sameCommunityPluginSyncPolicy(
        previous.communityPluginSyncPolicy,
        candidate.communityPluginSyncPolicy,
      )
      && previous.excludedFolders.length === candidate.excludedFolders.length
      && previous.excludedFolders.every(
        (path, index) => path === candidate.excludedFolders[index],
      )
    ) return;

    await this.ensureStateLoaded();
    if (
      operationEpoch !== undefined
      && !this.operationLifecycle.isCurrent(operationEpoch)
    ) return;
    if (this.syncExecutor?.hasActivityInFlight) {
      throw new SyncPathSettingsUpdateError("busy");
    }
    if (
      this.state?.hasV2StateLoadRecoveryBlock
      || this.state?.hasV2RemoteScopeRecovery
      || this.state?.hasMutationLedgerCorruption
      || this.state?.hasMutationRecoveryQuarantineCorruption
      || (this.state?.mutationLedger.length ?? 0) > 0
    ) {
      throw new SyncPathSettingsUpdateError("recovery");
    }
    const lockHolder = this.acquireOpLock("sync-path-settings");
    if (lockHolder !== null) {
      throw new SyncPathSettingsUpdateError("busy");
    }

    try {
      if (
        operationEpoch !== undefined
        && !this.operationLifecycle.isCurrent(operationEpoch)
      ) return;
      await this.commitSyncPathSettingsCandidate(previous, candidate, {
        operationEpoch,
      });
    } finally {
      this.releaseOpLock();
    }
  }

  private async persistCommunityPluginLocalIgnores(
    ignores: Readonly<CommunityPluginLocalIgnores>,
  ): Promise<void> {
    const legacyIgnores: CommunityPluginLocalIgnores = {
      files: [],
      data: [...ignores.data],
      ...(ignores.folderMoveHintRemoteIds
        ? { folderMoveHintRemoteIds: [...ignores.folderMoveHintRemoteIds] }
        : {}),
    };
    const previous = this.captureSyncPathSettings();
    const communityPluginSyncPolicy = applyCommunityPluginLocalIgnores(
      previous.communityPluginSyncPolicy,
      legacyIgnores,
      this.manifest.id,
    );
    if (sameCommunityPluginSyncPolicy(
      previous.communityPluginSyncPolicy,
      communityPluginSyncPolicy,
    )) return;
    if (
      this.state?.hasV2StateLoadRecoveryBlock
      || this.state?.hasV2RemoteScopeRecovery
      || this.state?.hasMutationLedgerCorruption
      || this.state?.hasMutationRecoveryQuarantineCorruption
      || (this.state?.mutationLedger.length ?? 0) > 0
    ) {
      throw new SyncPathSettingsUpdateError("recovery");
    }
    await this.commitSyncPathSettingsCandidate(previous, {
      ...previous,
      communityPluginSyncPolicy,
    }, {
      retireLocalFolderMoveHintRemoteIds:
        legacyIgnores.folderMoveHintRemoteIds ?? [],
    });
  }

  private async persistCompletedCommunityPluginRestores(
    completed: Readonly<CommunityPluginRestoreSet>,
  ): Promise<void> {
    const previous = this.captureSyncPathSettings();
    const communityPluginSyncPolicy =
      clearCompletedCommunityPluginRestores(
        previous.communityPluginSyncPolicy,
        completed,
        this.manifest.id,
      );
    if (sameCommunityPluginSyncPolicy(
      previous.communityPluginSyncPolicy,
      communityPluginSyncPolicy,
    )) return;
    if (
      this.state?.hasV2StateLoadRecoveryBlock
      || this.state?.hasV2RemoteScopeRecovery
      || this.state?.hasMutationLedgerCorruption
      || this.state?.hasMutationRecoveryQuarantineCorruption
      || (this.state?.mutationLedger.length ?? 0) > 0
    ) {
      throw new SyncPathSettingsUpdateError("recovery");
    }
    await this.commitSyncPathSettingsCandidate(previous, {
      ...previous,
      communityPluginSyncPolicy,
    });
  }

  private async persistCommunityPluginJoinOutcomes(
    completed: Readonly<CommunityPluginRestoreSet>,
    blocks: readonly Readonly<CommunityPluginJoinBlock>[],
  ): Promise<void> {
    const state = this.state;
    const participation = state?.getCommunityPluginParticipation?.() ?? null;
    if (!state?.isV2StateActive || !participation) {
      await this.persistCompletedCommunityPluginRestores(completed);
      return;
    }
    for (const block of blocks) {
      const current = state.getCommunityPluginParticipation()
        ?.pluginsById[block.pluginId];
      if (
        !current
        || (current.phase !== "join-requested" && current.phase !== "restoring")
        || (block.operationId && current.operationId !== block.operationId)
      ) continue;
      await state.updateCommunityPluginParticipation({
        type: "block",
        pluginId: block.pluginId,
        reason: block.reason,
        operationId: block.operationId,
      });
    }
    for (const pluginId of completed.files) {
      const current = state.getCommunityPluginParticipation()
        ?.pluginsById[pluginId];
      if (current?.phase !== "restoring") continue;
      await state.updateCommunityPluginParticipation({
        type: "confirm-participating",
        pluginId,
        joinedGeneration: Math.max(1, state.remoteGeneration),
        localBundleDigest: current.targetBundleDigest,
      });
    }
    const committed = state.getCommunityPluginParticipation();
    if (committed) this.applyCommunityPluginParticipationProjection(committed);
    const legacyCompleted = {
      files: [],
      data: completed.data,
    };
    if (
      legacyCompleted.files.length > 0
      || legacyCompleted.data.length > 0
    ) {
      await this.persistCompletedCommunityPluginRestores(legacyCompleted);
    }
  }

  private async commitSyncPathSettingsCandidate(
    previous: Readonly<SyncPathSettings>,
    candidate: Readonly<SyncPathSettings>,
    options: Readonly<{
      retireLocalFolderMoveHintRemoteIds?: readonly string[];
      operationEpoch?: number;
    }> = {},
  ): Promise<void> {
    if (!this.state || !this.scanner) {
      throw new Error("Sync path state is unavailable");
    }
    const assertOperationCurrent = (): void => {
      if (
        options.operationEpoch !== undefined
        && !this.operationLifecycle.isCurrent(options.operationEpoch)
      ) {
        throw new Error("Operation lifecycle was invalidated");
      }
    };
    try {
      const migrationHold = this.state.activeV2MigrationHold;
      if (migrationHold) {
        const migrationAuthorization = this.state.planReviewAuthorization;
        if (!migrationAuthorization) {
          throw new Error(
            "Cannot change sync paths without a valid migration review",
          );
        }
        assertOperationCurrent();
        const retired = await this.state.clearPlanReview(
          migrationAuthorization,
        );
        assertOperationCurrent();
        if (!retired || this.state.activeV2MigrationHold) {
          throw new Error(
            "Cannot change sync paths while the migration review remains active",
          );
        }
      }
      const previousSettingsFingerprint =
        syncPathSettingsFingerprint(previous);
      const targetSettingsFingerprint =
        syncPathSettingsFingerprint(candidate);
      const requiresCompleteRemoteIdentitySnapshot =
        syncPathSettingsExpandFileScope(previous, candidate);
      const { configDir } = getEasySyncPaths(
        this.app.vault,
        this.manifest.id,
      );
      const previousFolderScope = createFolderSyncScopeSnapshotV1(
        this.buildSyncPathScanConfig(previous),
        configDir,
        this.manifest.id,
      );
      const targetFolderScope = createFolderSyncScopeSnapshotV1(
        this.buildSyncPathScanConfig(candidate),
        configDir,
        this.manifest.id,
      );
      const v2RemoteFolderPaths =
        this.state.isV2StateActive
        && this.state.hasCompleteRemoteFolderIndex
          ? this.state.remoteFolders.map((folder) => folder.path)
          : [];
      const previousIncludedFolderPaths = new Set(
        v2RemoteFolderPaths.filter(
          (path) => this.scanner!.shouldSyncFolderPath(path),
        ),
      );
      assertOperationCurrent();
      this.publishSyncPathSettings(candidate);
      const expandedFolderPaths = v2RemoteFolderPaths.filter(
        (path) =>
          !previousIncludedFolderPaths.has(path)
          && this.scanner!.shouldSyncFolderPath(path),
      );
      const includedFolderPaths = v2RemoteFolderPaths.filter(
        (path) => this.scanner!.shouldSyncFolderPath(path),
      );
      const filesPolicy =
        this.getEffectiveCommunityPluginSyncPolicy(candidate).files;
      assertOperationCurrent();
      await this.state.commitSyncPathSettingsChange(
        (path) => this.scanner!.shouldSyncPath(path),
        (data) => {
          assertOperationCurrent();
          this.writeSyncPathSettingsData(data, candidate);
        },
        filesPolicy.mode === "all"
          ? undefined
          : filesPolicy.mode === "selected"
            ? filesPolicy.pluginIds.filter(
                (pluginId) => isPluginSelected(filesPolicy, pluginId),
              )
            : [],
        {
          previousSettingsFingerprint,
          targetSettingsFingerprint,
          expandedFolderPaths,
          includedFolderPaths,
          folderScopeTransition: {
            previous: previousFolderScope,
            target: targetFolderScope,
          },
          requiresCompleteRemoteIdentitySnapshot,
          retireLocalFolderMoveHintRemoteIds:
            options.retireLocalFolderMoveHintRemoteIds,
        },
      );
      assertOperationCurrent();
      this.advanceCommunityPluginInventoryRevision();
      this.updateStatusBar();
      this.syncView?.render();
      this.settingsTab?.refreshSyncState();
    } catch (error) {
      if (
        options.operationEpoch === undefined
        || this.operationLifecycle.isCurrent(options.operationEpoch)
      ) {
        this.publishSyncPathSettings(previous);
      }
      throw error;
    }
  }

  async updateExcludedFolders(excludedFolders: readonly string[]): Promise<void> {
    await this.updateSyncPathSettings({
      excludedFolders: [...excludedFolders],
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

  private buildSyncPathScanConfig(
    settings: Readonly<SyncPathSettings>,
  ): Partial<ScanConfig> {
    const paths = new Set<string>();
    const effectiveCommunityPluginPolicy =
      this.getEffectiveCommunityPluginSyncPolicy(settings);
    const { configDir, pluginDir } = getEasySyncPaths(this.app.vault, this.manifest.id);
    const pluginDirPrefix = `${pluginDir}/`;

    // EasySync self-sync (default on)
    if (settings.syncPluginFiles) paths.add(pluginDirPrefix);

    // Editor
    if (settings.syncEditorSettings) paths.add(`${configDir}/app.json`);

    // Appearance settings
    if (settings.syncAppearance) paths.add(`${configDir}/appearance.json`);

    // Themes & snippets
    if (settings.syncThemes) {
      paths.add(`${configDir}/themes/`);
      paths.add(`${configDir}/snippets/`);
    }

    // Hotkeys
    if (settings.syncHotkeys) paths.add(`${configDir}/hotkeys.json`);

    // Core plugins (built-in enable states only, no code files)
    if (settings.syncCorePlugins) paths.add(`${configDir}/core-plugins.json`);

    // Bookmarks
    if (settings.syncBookmarks) paths.add(`${configDir}/bookmarks.json`);

    // Community plugins (enable list + code files, no data.json).
    // Selected mode keeps the plugin root observable while the scanner owns
    // the per-plugin file filter.
    if (settings.syncCommunityPlugins) {
      paths.add(`${configDir}/community-plugins.json`);
      paths.add(`${configDir}/plugins/`);
    }

    // Plugin data (data.json only)
    if (settings.syncPluginData) {
      paths.add(`${configDir}/plugins/`);
    }

    return {
      includePaths: [...paths],
      excludedFolders: [...settings.excludedFolders],
      includeOwnPluginCode: settings.syncPluginFiles,
      includePluginCode: settings.syncCommunityPlugins,
      includePluginData: settings.syncPluginData,
      pluginCodeSelection: {
        ...effectiveCommunityPluginPolicy.files,
        pluginIds: [...effectiveCommunityPluginPolicy.files.pluginIds],
        ...(effectiveCommunityPluginPolicy.files.ignoredPluginIds
          ? {
              ignoredPluginIds: [
                ...effectiveCommunityPluginPolicy.files.ignoredPluginIds,
              ],
            }
          : {}),
      },
      pluginDataSelection: {
        ...effectiveCommunityPluginPolicy.data,
        pluginIds: [...effectiveCommunityPluginPolicy.data.pluginIds],
        ...(effectiveCommunityPluginPolicy.data.ignoredPluginIds
          ? {
              ignoredPluginIds: [
                ...effectiveCommunityPluginPolicy.data.ignoredPluginIds,
              ],
            }
          : {}),
      },
    };
  }

  /** Apply the single effective local/remote path policy to the scanner. */
  applySyncPathSettings(): void {
    this.scanner?.setConfig(
      this.buildSyncPathScanConfig(this.captureSyncPathSettings()),
    );
  }

  getCommunityPluginParticipation():
    DeviceCommunityPluginParticipationV1 | null {
    return this.communityPluginParticipation
      ? structuredClone(this.communityPluginParticipation)
      : null;
  }

  isCommunityPluginFilesParticipationEnabled(pluginId: string): boolean {
    return this.communityPluginParticipation
      ? isDeviceCommunityPluginEnabled(
          this.communityPluginParticipation,
          pluginId,
        )
      : this.syncCommunityPlugins
        && isPluginSelected(this.communityPluginSyncPolicy.files, pluginId);
  }

  private async retireExcludedCommunityPluginPendingState(
    participation: Readonly<DeviceCommunityPluginParticipationV1>,
    invalidatePlanReview = false,
  ): Promise<void> {
    const state = this.state;
    if (!state) return;
    const retireAll = !participation.scopeEnabled;
    const retiredPluginIds = new Set(
      Object.values(participation.pluginsById)
        .filter((entry) =>
          entry.phase === "excluded"
          || entry.phase === "never-participated"
          || entry.phase === "exit-requested"
        )
        .map((entry) => entry.pluginId),
    );
    if (
      !retireAll
      && retiredPluginIds.size === 0
      && !invalidatePlanReview
    ) return;
    const configDir = getConfigDir(this.app.vault);
    await state.retirePendingStateForPaths((path) => {
      const managed = classifyCommunityPluginManagedPath(
        path,
        configDir,
        this.manifest.id,
      );
      return Boolean(
        managed
        && managed.kind !== "enablement"
        && (retireAll || retiredPluginIds.has(managed.pluginId)),
      );
    }, invalidatePlanReview);
  }

  async ensureCommunityPluginParticipationInitialized():
    Promise<DeviceCommunityPluginParticipationV1 | null> {
    const state = this.state;
    if (
      !state?.isV2StateActive
      || typeof state.getCommunityPluginParticipation !== "function"
    ) return null;
    const existing = state.getCommunityPluginParticipation();
    if (existing) {
      await this.retireExcludedCommunityPluginPendingState(existing);
      this.applyCommunityPluginParticipationProjection(existing);
      return this.getCommunityPluginParticipation();
    }
    if (typeof state.initializeCommunityPluginParticipation !== "function") {
      return null;
    }
    if (this.communityPluginParticipationInitializationPromise) {
      return this.communityPluginParticipationInitializationPromise;
    }
    this.communityPluginParticipationInitializationPromise = (async () => {
      const inventory =
        await this.buildCommunityPluginInventoryFromLoadedState();
      const completeLocalBundlePluginIds: string[] = [];
      const incompleteLocalBundlePluginIds: string[] = [];
      const pluginRoot = `${getConfigDir(this.app.vault)}/plugins`;
      for (const item of inventory) {
        if (!item.local) continue;
        const complete = !item.manifestIssue
          && await this.app.vault.adapter.exists(
            `${pluginRoot}/${item.id}/main.js`,
          );
        (complete
          ? completeLocalBundlePluginIds
          : incompleteLocalBundlePluginIds).push(item.id);
      }
      const historicalPluginIds = (state.baseSnapshot ?? []).flatMap(
        (entry) => {
          const managed = classifyCommunityPluginManagedPath(
            entry.path,
            getConfigDir(this.app.vault),
            this.manifest.id,
          );
          return managed?.kind === "files" ? [managed.pluginId] : [];
        },
      );
      const initialized = await state.initializeCommunityPluginParticipation({
        filesEnabled: this.syncCommunityPlugins,
        selection: this.communityPluginSyncPolicy.files,
        knownPluginIds: inventory.map((item) => item.id),
        completeLocalBundlePluginIds,
        incompleteLocalBundlePluginIds,
        historicallyParticipatedPluginIds: historicalPluginIds,
      });
      await this.retireExcludedCommunityPluginPendingState(initialized.state);
      this.applyCommunityPluginParticipationProjection(initialized.state);
      return this.getCommunityPluginParticipation();
    })().finally(() => {
      this.communityPluginParticipationInitializationPromise = null;
    });
    return this.communityPluginParticipationInitializationPromise;
  }

  private async observeCommunityPluginLocalBundleFacts(
    pluginIds: readonly string[],
  ): Promise<Map<string, CommunityPluginLocalBundleFact>> {
    const configDir = getConfigDir(this.app.vault).replace(/\/+$/, "");
    const adapter = this.app.vault.adapter;
    const facts = new Map<string, CommunityPluginLocalBundleFact>();
    for (const pluginId of [...new Set(pluginIds)].sort()) {
      const root = `${configDir}/plugins/${pluginId}`;
      const [mainExists, manifestExists, stylesExists] = await Promise.all([
        adapter.exists(`${root}/main.js`),
        adapter.exists(`${root}/manifest.json`),
        adapter.exists(`${root}/styles.css`),
      ]);
      facts.set(
        pluginId,
        mainExists && manifestExists
          ? "complete"
          : mainExists || manifestExists || stylesExists
            ? "partial"
            : "absent",
      );
    }
    return facts;
  }

  private async reconcileCommunityPluginParticipationFromLocalBundles(
    input: Readonly<{
      trigger: string;
      pluginIds?: readonly string[];
      allowedLockHolder?: string;
    }>,
  ): Promise<{ followUpPluginIds: string[] }> {
    const state = this.state;
    if (
      !state?.isV2StateActive
      || typeof state.getCommunityPluginParticipation !== "function"
    ) return { followUpPluginIds: [] };
    const participation =
      await this.ensureCommunityPluginParticipationInitialized();
    if (!participation?.scopeEnabled) return { followUpPluginIds: [] };
    const requested = input.pluginIds
      ? new Set(normalizePluginIds(input.pluginIds, this.manifest.id))
      : null;
    const candidatePluginIds = new Set<string>();
    for (const entry of Object.values(participation.pluginsById)) {
      if (
        (entry.phase === "participating"
          || entry.phase === "exit-requested")
        && (!requested || requested.has(entry.pluginId))
      ) {
        candidatePluginIds.add(entry.pluginId);
      }
    }
    const localPluginIds = requested
      ? [...requested]
      : await this.listLocalCommunityPluginIdsForParticipation();
    const autoParticipatePluginIds: string[] = [];
    for (const pluginId of localPluginIds) {
      const phase = participation.pluginsById[pluginId]?.phase;
      if (phase === undefined || phase === "never-participated") {
        candidatePluginIds.add(pluginId);
        autoParticipatePluginIds.push(pluginId);
      }
    }
    if (candidatePluginIds.size === 0) return { followUpPluginIds: [] };
    const localBundleFacts = await this.observeCommunityPluginLocalBundleFacts(
      [...candidatePluginIds],
    );
    const planned = planCommunityPluginLocalReconciliation({
      participation,
      localBundleFacts,
      operationId: (pluginId) =>
        `exit-${pluginId}-${Date.now()}-${
          ++this.communityPluginParticipationOperationSequence
        }`,
      autoParticipatePluginIds,
    });
    if (planned.commands.length === 0) return planned;
    await this.commitCommunityPluginParticipationCommands(
      planned.commands,
      {
        allowedLockHolder: input.allowedLockHolder,
        expectedParticipation: participation,
        commitSyncPathSettingsTransition: true,
      },
    );
    this.diag?.log(
      "state",
      "reconciled community plugin participation from current local bundles",
      {
        trigger: input.trigger,
        commands: planned.commands.length,
        followUps: planned.followUpPluginIds.length,
        autoParticipated: planned.autoParticipatedPluginIds.length,
        mutations: 0,
      },
    );
    if (
      planned.autoParticipatedPluginIds.length > 0
      && this.canScheduleLocalChangeAutoSync()
      && this.autoSyncDirtyHint.mark()
    ) {
      this.diag.log(
        "execute",
        "local community plugin install scheduled normal auto sync",
        {
          debounceMs: this.autoSyncChangeDelaySeconds * 1_000,
          plugins: planned.autoParticipatedPluginIds.length,
        },
      );
    }
    for (const pluginId of planned.followUpPluginIds) {
      this.queueCommunityPluginLocalReconciliation(pluginId);
    }
    if (planned.followUpPluginIds.length > 0) {
      this.scheduleCommunityPluginLocalReconciliationFollowUp();
    }
    return planned;
  }

  private async prepareCommunityPluginJoinsForSync(): Promise<{
    authorizations: CommunityPluginJoinAuthorization[];
  }> {
    const state = this.state;
    if (!state?.isV2StateActive) return { authorizations: [] };
    if (typeof state.getCommunityPluginParticipation !== "function") {
      return { authorizations: [] };
    }
    if (
      state.hasV2StateLoadRecoveryBlock
      || state.hasV2RemoteScopeRecovery
      || state.hasMutationLedgerCorruption
      || state.hasMutationRecoveryQuarantineCorruption
      || state.mutationLedger.length > 0
      || state.planReviewActive
    ) return { authorizations: [] };
    const initial = await this.ensureCommunityPluginParticipationInitialized();
    if (!initial?.scopeEnabled) return { authorizations: [] };
    const pending = Object.values(initial.pluginsById).filter((entry) =>
      entry.phase === "join-requested"
      || entry.phase === "restoring"
      || (entry.phase === "blocked"
        && isCommunityPluginJoinBlockRetryable(entry.blockedReason))
    );
    if (pending.length === 0) return { authorizations: [] };

    const retryEntries = pending.map((entry) => entry.phase === "blocked"
      ? {
          pluginId: entry.pluginId,
          phase: "join-requested" as const,
          ...(entry.operationId ? { operationId: entry.operationId } : {}),
          ...(entry.targetCatalogRevision !== undefined
            ? { targetCatalogRevision: entry.targetCatalogRevision }
            : {}),
          ...(entry.targetBundleDigest
            ? { targetBundleDigest: entry.targetBundleDigest }
            : {}),
        }
      : entry);

    const localBundleFacts = await this.observeCommunityPluginLocalBundleFacts(
      retryEntries.map((entry) => entry.pluginId),
    );

    let catalog = this.getCurrentRemoteCommunityPluginCatalog();
    const remoteRequired = retryEntries.some((entry) =>
      entry.phase === "restoring"
      || localBundleFacts.get(entry.pluginId) === "absent"
    );
    if (remoteRequired && (!catalog || catalog.stale)) {
      try {
        catalog = await this.refreshCommunityPluginRemoteCatalog();
      } catch (error) {
        this.diag.warn(
          "state",
          "community plugin join catalog refresh failed closed",
          error instanceof Error ? error.message : String(error),
        );
        catalog = null;
      }
    }

    const planned = planCommunityPluginJoins({
      entries: retryEntries,
      localBundleFacts,
      catalog,
      scope: state.remoteScope,
    });
    await this.commitCommunityPluginParticipationCommands(
      planned.commands,
      {
        allowedLockHolder: "sync",
        expectedParticipation: initial,
        commitSyncPathSettingsTransition: true,
      },
    );
    return { authorizations: planned.authorizations };
  }

  async updateCommunityPluginFilesScope(enabled: boolean): Promise<void> {
    await this.commitCommunityPluginParticipationCommands([{
      type: "set-scope-enabled",
      enabled,
    }], {
      commitSyncPathSettingsTransition: true,
    });
  }

  async updateCommunityPluginFilesSelection(
    pluginId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.ensureStateLoaded();
    const current = await this.ensureCommunityPluginParticipationInitialized();
    if (!current) {
      throw new SyncPathSettingsUpdateError("recovery");
    }
    const phase = current.pluginsById[pluginId]?.phase;
    if (enabled && (
      phase === "join-requested"
      || phase === "restoring"
      || phase === "participating"
    )) return;
    if (!enabled && (
      phase === "excluded"
      || phase === "never-participated"
      || phase === "exit-requested"
      || phase === undefined
    )) return;
    if (!enabled) {
      await this.commitCommunityPluginParticipationCommands([{
        type: "confirm-excluded",
        pluginId,
      }], {
        expectedParticipation: current,
        commitSyncPathSettingsTransition: true,
      });
      return;
    }
    const catalog = this.getCurrentRemoteCommunityPluginCatalog();
    const catalogEntry = !catalog?.stale
      ? catalog?.entries.find((entry) =>
          entry.pluginId === pluginId && entry.bundleState === "complete"
        )
      : undefined;
    await this.commitCommunityPluginParticipationCommand({
      type: "request-join",
      pluginId,
      operationId:
        `join-${Date.now()}-${
          ++this.communityPluginParticipationOperationSequence
        }`,
      ...(catalog && catalogEntry
        ? {
            targetCatalogRevision: catalog.revision,
            targetBundleDigest: catalogEntry.bundleDigest,
          }
        : {}),
    });
    this.scheduleCommunityPluginJoinSync();
  }

  private async commitCommunityPluginParticipationCommand(
    command: Readonly<DeviceCommunityPluginParticipationCommand>,
  ): Promise<void> {
    await this.commitCommunityPluginParticipationCommands([command]);
  }

  private async commitCommunityPluginParticipationCommands(
    commands: readonly Readonly<DeviceCommunityPluginParticipationCommand>[],
    options: Readonly<{
      allowedLockHolder?: string;
      expectedParticipation?: Readonly<DeviceCommunityPluginParticipationV1>;
      commitSyncPathSettingsTransition?: boolean;
    }> = {},
  ): Promise<void> {
    if (commands.length === 0) return;
    await this.ensureStateLoaded();
    const state = this.state;
    if (!state || !await this.ensureCommunityPluginParticipationInitialized()) {
      throw new SyncPathSettingsUpdateError("recovery");
    }
    if (this.syncExecutor?.hasActivityInFlight) {
      throw new SyncPathSettingsUpdateError("busy");
    }
    if (
      state.hasV2StateLoadRecoveryBlock
      || state.hasV2RemoteScopeRecovery
      || state.hasMutationLedgerCorruption
      || state.hasMutationRecoveryQuarantineCorruption
      || (state.mutationLedger?.length ?? 0) > 0
    ) {
      throw new SyncPathSettingsUpdateError("recovery");
    }
    let ownsLock = false;
    if (this.opLock === null) {
      this.acquireOpLock("community-plugin-participation");
      ownsLock = true;
    } else if (this.opLock !== options.allowedLockHolder) {
      throw new SyncPathSettingsUpdateError("busy");
    }
    try {
      if (
        options.expectedParticipation
        && JSON.stringify(state.getCommunityPluginParticipation())
          !== JSON.stringify(options.expectedParticipation)
      ) {
        throw new SyncPathSettingsUpdateError("busy");
      }
      const previousParticipation = state.getCommunityPluginParticipation();
      if (!previousParticipation) {
        throw new Error("Community-plugin participation commit disappeared");
      }
      let targetParticipation = previousParticipation;
      for (const command of commands) {
        targetParticipation = reduceDeviceCommunityPluginParticipation(
          targetParticipation,
          command,
          this.manifest.id,
        );
      }
      const previousSyncPathSettings =
        options.commitSyncPathSettingsTransition
          ? this.captureSyncPathSettings()
          : null;
      let candidateSyncPathSettings: SyncPathSettings | null = null;
      if (previousSyncPathSettings) {
        this.applyCommunityPluginParticipationProjection(targetParticipation);
        candidateSyncPathSettings = this.captureSyncPathSettings();
        this.applyCommunityPluginParticipationProjection(previousParticipation);
      }
      const requiresSyncPathSettingsCommit = Boolean(
        previousSyncPathSettings
        && candidateSyncPathSettings
        && syncPathSettingsFingerprint(previousSyncPathSettings)
          !== syncPathSettingsFingerprint(candidateSyncPathSettings),
      );
      const participationStateChanged =
        JSON.stringify(previousParticipation)
          !== JSON.stringify(targetParticipation);
      if (
        requiresSyncPathSettingsCommit
        && previousSyncPathSettings
        && candidateSyncPathSettings
      ) {
        await this.commitSyncPathSettingsCandidate(
          previousSyncPathSettings,
          candidateSyncPathSettings,
        );
      } else {
        await this.retireExcludedCommunityPluginPendingState(
          targetParticipation,
          participationStateChanged,
        );
      }
      await state.updateCommunityPluginParticipationBatch(commands);
      const committed = state.getCommunityPluginParticipation();
      if (!committed) {
        throw new Error("Community-plugin participation commit disappeared");
      }
      this.applyCommunityPluginParticipationProjection(committed);
      if (!requiresSyncPathSettingsCommit) {
        this.advanceCommunityPluginInventoryRevision();
        this.updateStatusBar();
        this.syncView?.render();
        this.settingsTab?.refreshSyncState();
      }
    } catch (error) {
      const durableParticipation =
        state.getCommunityPluginParticipation();
      if (durableParticipation) {
        this.applyCommunityPluginParticipationProjection(
          durableParticipation,
        );
        this.advanceCommunityPluginInventoryRevision();
        this.updateStatusBar();
        this.syncView?.render();
        this.settingsTab?.refreshSyncState();
      }
      throw error;
    } finally {
      if (ownsLock) this.releaseOpLock();
    }
  }

  private applyCommunityPluginParticipationProjection(
    participation: Readonly<DeviceCommunityPluginParticipationV1>,
  ): void {
    this.communityPluginParticipation = structuredClone(participation);
    this.syncCommunityPlugins = participation.scopeEnabled;
    const participatingPluginIds = Object.values(
      participation.pluginsById,
    ).filter((entry) => entry.phase === "participating")
      .map((entry) => entry.pluginId)
      .sort((left, right) => left.localeCompare(right));
    const restoringPluginIds = Object.values(
      participation.pluginsById,
    ).filter((entry) => entry.phase === "restoring")
      .map((entry) => entry.pluginId)
      .sort((left, right) => left.localeCompare(right));
    this.communityPluginSyncPolicy = {
      ...cloneCommunityPluginSyncPolicy(this.communityPluginSyncPolicy),
      files: {
        mode: "selected",
        pluginIds: [...participatingPluginIds, ...restoringPluginIds].sort(
          (left, right) => left.localeCompare(right),
        ),
      },
    };
    if (!this.syncCommunityPlugins) this.syncPluginData = false;
    this.applySyncPathSettings();
    this.syncExecutor?.setCommunityPluginSyncPolicy(
      this.getEffectiveCommunityPluginSyncPolicy(),
    );
  }

  async getCommunityPluginInventory(): Promise<CommunityPluginInventoryItem[]> {
    await this.ensureStateLoaded();
    await this.ensureCommunityPluginParticipationInitialized();
    await this.scheduleCommunityPluginLocalReconciliation("settings-open");
    const inventory = await this.buildCommunityPluginInventoryFromLoadedState();
    const participation = this.communityPluginParticipation;
    const catalog = this.getCurrentRemoteCommunityPluginCatalog();
    const catalogById = new Map(
      (catalog?.entries ?? []).map((entry) => [entry.pluginId, entry]),
    );
    return inventory.map((item) => ({
      ...item,
      ...(item.name === null && catalogById.get(item.id)?.manifestName
        ? { name: catalogById.get(item.id)!.manifestName! }
        : {}),
      ...(catalog?.stale && catalogById.has(item.id)
        ? { remoteCatalogStale: true }
        : {}),
      ...(participation?.pluginsById[item.id]
        ? {
            participationPhase:
              participation.pluginsById[item.id]!.phase,
            ...(participation.pluginsById[item.id]!.blockedReason
              ? {
                  participationBlockedReason:
                    participation.pluginsById[item.id]!.blockedReason,
                }
              : {}),
          }
        : {}),
    }));
  }

  private async buildCommunityPluginInventoryFromLoadedState():
    Promise<CommunityPluginInventoryItem[]> {
    const remoteDataInventoryTrusted =
      this.hasTrustedCommunityPluginRemoteInventoryLoaded("data");
    const remoteScope = this.state?.remoteScope;
    const catalog = this.getCurrentRemoteCommunityPluginCatalog();
    const catalogPluginIds = catalog?.entries.map((entry) => entry.pluginId)
      ?? [];
    const catalogRemoteEntries = catalog
      ? remoteCommunityPluginCatalogEntries(catalog)
      : [];
    const legacyRemoteDataEntries = remoteDataInventoryTrusted
      ? (this.state?.remoteSnapshot ?? []).filter((entry) =>
          classifyCommunityPluginManagedPath(
            entry.path,
            getConfigDir(this.app.vault),
            this.manifest.id,
          )?.kind === "data"
        )
      : [];
    const enablementScope =
      this.state?.activeV2MigrationHold?.communityPluginEnablement?.scope
      ?? remoteScope;
    const pendingPluginIds = enablementScope && this.state
      ? this.state.getCommunityPluginEnablementState(enablementScope).pending.map(
          (item) => item.pluginId,
        )
      : [];
    const configDir = getConfigDir(this.app.vault);
    const historicalManagedPlugins = (this.state?.baseSnapshot ?? []).flatMap(
      (entry) => {
        const managed = classifyCommunityPluginManagedPath(
          entry.path,
          configDir,
          this.manifest.id,
        );
        return managed && managed.kind !== "enablement"
          ? [managed]
          : [];
      },
    );
    const historicalPluginIds = historicalManagedPlugins.map(
      (managed) => managed.pluginId,
    );
    const historicalCodePluginIds = historicalManagedPlugins
      .filter((managed) => managed.kind === "files")
      .map((managed) => managed.pluginId);
    const historicalDataPluginIds = historicalManagedPlugins
      .filter((managed) => managed.kind === "data")
      .map((managed) => managed.pluginId);
    const participationPluginIds = Object.keys(
      this.communityPluginParticipation?.pluginsById ?? {},
    );
    const participationExcludedPluginIds = Object.values(
      this.communityPluginParticipation?.pluginsById ?? {},
    ).filter((entry) =>
      entry.phase === "excluded"
      || entry.phase === "never-participated"
      || entry.phase === "exit-requested"
    ).map((entry) => entry.pluginId);
    return buildCommunityPluginInventory(
      this.app.vault.adapter,
      configDir,
      this.manifest.id,
      [
        ...this.communityPluginSyncPolicy.files.pluginIds,
        ...this.communityPluginSyncPolicy.data.pluginIds,
        ...(this.communityPluginSyncPolicy.data.ignoredPluginIds ?? []),
        ...(this.communityPluginSyncPolicy.data.restoringPluginIds ?? []),
        ...participationPluginIds,
        ...catalogPluginIds,
        ...pendingPluginIds,
        ...historicalPluginIds,
      ],
      [...catalogRemoteEntries, ...legacyRemoteDataEntries],
      participationExcludedPluginIds,
      this.syncExecutor?.getMobileDesktopOnlyCommunityPluginIds() ?? [],
      historicalDataPluginIds,
      catalog && remoteScope && this.state
        ? {
            scope: remoteScope,
            observations:
              this.state.getCommunityPluginManifestObservations(),
          }
        : null,
      [...historicalCodePluginIds, ...catalogPluginIds],
    );
  }

  async refreshCommunityPluginRemoteCatalog():
    Promise<RemoteCommunityPluginCatalogV1 | null> {
    await this.ensureStateLoaded();
    if (this.remoteCommunityPluginCatalogRefreshPromise) {
      return this.remoteCommunityPluginCatalogRefreshPromise;
    }
    const state = this.state;
    const onedrive = this.onedrive;
    const scope = state?.remoteScope;
    if (!state?.isV2StateActive || !onedrive || !scope) return null;
    if (this.syncExecutor?.hasActivityInFlight) {
      return this.getCurrentRemoteCommunityPluginCatalog();
    }
    this.remoteCommunityPluginCatalogRefreshPromise = (async () => {
      const previous = this.getCurrentRemoteCommunityPluginCatalog();
      try {
        const delta = await onedrive.getDeltaByFolderId(scope.filesRootId);
        if (!sameSyncScope(state.remoteScope, scope)) {
          throw new Error("Remote plugin catalog scope changed during refresh");
        }
        const catalog = await buildRemoteCommunityPluginCatalog({
          scope,
          configDir: getConfigDir(this.app.vault),
          items: delta.value,
          manifestObservations:
            state.getCommunityPluginManifestObservations(),
          observedAt: Date.now(),
          previous,
          ownPluginId: this.manifest.id,
        });
        await state.setRemoteCommunityPluginCatalog(catalog);
        this.advanceCommunityPluginInventoryRevision();
        return catalog;
      } catch (error) {
        if (previous && sameSyncScope(previous.scope, state.remoteScope)) {
          try {
            await state.setRemoteCommunityPluginCatalog(
              markRemoteCommunityPluginCatalogStale(previous, Date.now()),
            );
            this.advanceCommunityPluginInventoryRevision();
          } catch {
            // The previous complete cache remains in memory. A disposable
            // catalog failure must never become an empty-cloud assertion.
          }
        }
        throw error;
      }
    })().finally(() => {
      this.remoteCommunityPluginCatalogRefreshPromise = null;
    });
    return this.remoteCommunityPluginCatalogRefreshPromise;
  }

  private getCurrentRemoteCommunityPluginCatalog():
    RemoteCommunityPluginCatalogV1 | null {
    const state = this.state;
    if (typeof state?.getRemoteCommunityPluginCatalog !== "function") {
      return null;
    }
    const catalog = state.getRemoteCommunityPluginCatalog();
    return catalog && sameSyncScope(catalog.scope, state?.remoteScope ?? null)
      ? catalog
      : null;
  }

  onCommunityPluginInventoryRevision(
    listener: (revision: number) => void,
  ): () => void {
    this.communityPluginInventoryRevisionListeners.add(listener);
    return () => {
      this.communityPluginInventoryRevisionListeners.delete(listener);
    };
  }

  private advanceCommunityPluginInventoryRevision(): void {
    this.communityPluginInventoryRevision += 1;
    for (const listener of this.communityPluginInventoryRevisionListeners) {
      try {
        listener(this.communityPluginInventoryRevision);
      } catch (error) {
        this.diag.warn(
          "lifecycle",
          "community plugin inventory revision listener failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private scheduleCommunityPluginInventoryRevisionForPaths(
    kind: "create" | "modify" | "delete" | "rename",
    ...entries: Array<{ path: string; isFolder: boolean }>
  ): void {
    if (!entries.some((entry) =>
      this.isCommunityPluginInventoryPath(entry.path, kind, entry.isFolder)
    )) {
      return;
    }
    if (this.communityPluginInventoryRefreshTimer !== null) return;
    this.communityPluginInventoryRefreshTimer = compatSetTimeout(() => {
      this.communityPluginInventoryRefreshTimer = null;
      this.advanceCommunityPluginInventoryRevision();
    }, 100);
  }

  private isCommunityPluginInventoryPath(
    path: string,
    kind: "create" | "modify" | "delete" | "rename",
    isFolder: boolean,
  ): boolean {
    const configDir = getConfigDir(this.app.vault).replace(/\/+$/, "");
    if (path === `${configDir}/community-plugins.json`) return true;
    const pluginsRoot = `${configDir}/plugins`;
    if (path === pluginsRoot) return isFolder && kind !== "modify";
    const prefix = `${pluginsRoot}/`;
    if (!path.startsWith(prefix)) return false;
    const parts = path.slice(prefix.length).split("/");
    const pluginId = normalizePluginIds([parts[0]], this.manifest.id)[0];
    if (!pluginId || pluginId !== parts[0]) return false;
    if (parts.length === 1) return isFolder && kind !== "modify";
    if (isFolder || parts.length !== 2) return false;
    const fileName = parts[1];
    if (!["main.js", "manifest.json", "styles.css", "data.json"].includes(
      fileName,
    )) return false;
    return kind !== "modify" || fileName === "manifest.json";
  }

  async hasTrustedCommunityPluginRemoteInventory(
    column: "files" | "data" = "files",
  ): Promise<boolean> {
    await this.ensureStateLoaded();
    return this.hasTrustedCommunityPluginRemoteInventoryLoaded(column);
  }

  private hasTrustedCommunityPluginRemoteInventoryLoaded(
    column: "files" | "data",
  ): boolean {
    const catalog = this.getCurrentRemoteCommunityPluginCatalog();
    if (column === "files") return Boolean(catalog && !catalog.stale);
    return this.state?.remoteScope != null
      && this.state.hasCompleteRemoteFolderIndex;
  }

  async getPendingCommunityPluginEnablementDecisions(): Promise<
    PendingCommunityPluginEnablementDecision[]
  > {
    return (await this.getCommunityPluginEnablementDecisionSnapshot())
      .decisions;
  }

  async getCommunityPluginEnablementDecisionSnapshot(): Promise<
    CommunityPluginEnablementDecisionSnapshot
  > {
    await this.ensureStateLoaded();
    const scope =
      this.state?.activeV2MigrationHold?.communityPluginEnablement?.scope
      ?? this.state?.remoteScope;
    if (
      !scope
      || !this.state
      || !this.syncCommunityPlugins
    ) return { revision: "", decisions: [] };
    const snapshot =
      this.state.getCommunityPluginEnablementDecisionSnapshot(scope);
    return {
      revision: snapshot.revision,
      decisions: snapshot.decisions.filter((item) => isPluginSelected(
        this.communityPluginSyncPolicy.files,
        item.pluginId,
      )),
    };
  }

  getCommunityPluginEnablementPendingCount(): number {
    const scope =
      this.state?.activeV2MigrationHold?.communityPluginEnablement?.scope
      ?? this.state?.remoteScope;
    if (
      !scope
      || !this.state
      || !this.syncCommunityPlugins
    ) return 0;
    return this.state.getCommunityPluginEnablementState(scope).pending.filter(
      (item) => isPluginSelected(
        this.communityPluginSyncPolicy.files,
        item.pluginId,
      ),
    ).length;
  }

  openCommunityPluginEnablementReview(): void {
    this.settingsTab?.openCommunityPluginEnablementReview();
  }

  async resolveCommunityPluginEnablementDecisions(
    expectedRevision: string,
    resolutions: readonly Readonly<
      CommunityPluginEnablementDecisionResolution
    >[],
  ): Promise<boolean> {
    await this.ensureStateLoaded();
    const scope =
      this.state?.activeV2MigrationHold?.communityPluginEnablement?.scope
      ?? this.state?.remoteScope;
    if (
      !scope
      || !this.state
      || !this.syncCommunityPlugins
      || resolutions.length === 0
      || resolutions.some((item) => !isPluginSelected(
        this.communityPluginSyncPolicy.files,
        item.pluginId,
      ))
    ) return false;
    const snapshot = await this.getCommunityPluginEnablementDecisionSnapshot();
    const pending = snapshot.decisions;
    if (snapshot.revision !== expectedRevision) return false;
    if (!sameCommunityPluginEnablementDecisionSet(pending, resolutions)) {
      return false;
    }
    const resolved =
      await this.state.resolveCommunityPluginEnablementDecisions(
        scope,
        expectedRevision,
        resolutions,
      );
    if (resolved) this.advanceCommunityPluginInventoryRevision();
    return resolved;
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
    const reportI18n = new I18n("zh-cn");
    const formatActionLabel = (type?: SyncActionType): string =>
      type
        ? reportI18n.t(resolveSyncActionPresentation(type).labelKey)
        : "—";
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

    try {
      await this.ensureStateLoaded();
    } catch (error) {
      // A load failure is itself reportable. Keep generating the report from
      // the StateManager's fail-closed evidence instead of hiding the export.
      this.diag.warn(
        "state",
        "diagnostic report state load failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    const auth = this.auth?.authState;
    const reportState = this.state;
    const reportScope = reportState?.remoteScope;
    const v2StorageAuthority =
      reportState?.activeV2StorageAuthorityEvidence ?? null;
    const v2StateLoadBlock = reportState?.v2StateLoadRecoveryBlock;
    const v2RemoteScopeRecovery = reportState?.activeV2RemoteScopeRecovery;
    const mutationRecoveryDisplay = this.getMutationRecoveryDisplayState();
    const mutationRecoveryScheduler =
      this.mutationRecoveryScheduler.snapshot;
    const [
      accountFingerprint,
      driveFingerprint,
      vaultFingerprint,
      filesRootFingerprint,
      v2DatabaseFingerprint,
    ] = await Promise.all([
      fingerprintOpaqueValue(reportScope?.accountId || reportState?.boundAccountId),
      fingerprintOpaqueValue(reportScope?.driveId),
      fingerprintOpaqueValue(reportScope?.vaultFolderId),
      fingerprintOpaqueValue(reportScope?.filesRootId),
      fingerprintOpaqueValue(v2StorageAuthority?.databaseId ?? undefined),
    ]);
    let communityPluginInventory: CommunityPluginInventoryItem[] = [];
    let communityPluginRemoteInventoryTrusted =
      this.hasTrustedCommunityPluginRemoteInventoryLoaded("files");
    try {
      communityPluginInventory = await this.getCommunityPluginInventory();
    } catch (error) {
      communityPluginRemoteInventoryTrusted = false;
      this.diag.warn(
        "state",
        "diagnostic report could not read community plugin inventory",
        error instanceof Error ? error.message : String(error),
      );
    }
    const communityPluginEnablementState = reportScope && reportState
      ? reportState.getCommunityPluginEnablementState(reportScope)
      : null;
    const communityPluginSummary = await summarizeCommunityPluginSync({
      policy: this.getEffectiveCommunityPluginSyncPolicy(),
      inventory: communityPluginInventory,
      remoteInventoryTrusted: communityPluginRemoteInventoryTrusted,
      anchors: communityPluginEnablementState
        ? Object.keys(communityPluginEnablementState.anchors).length
        : 0,
      pending: communityPluginEnablementState?.pending.length ?? 0,
    });
    const { pluginDir, storageLayoutVersion } = getEasySyncPaths(
      this.app.vault,
      this.manifest.id,
    );
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
    const platformLabel = Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : Platform.isMobile ? "Mobile" : "Desktop";
    const automaticActivity = this.syncExecutor?.isRunning
      ? "同步中"
      : this.opLock !== null
        ? "其他操作占用中"
        : "空闲";

    // ── Header ──
    lines.push("# EasySync 诊断报告");
    lines.push("");
    lines.push(`**生成时间**: ${fmt(now.getTime())}`);
    lines.push(`**插件版本**: ${this.manifest.version}`);
    lines.push(`**仓库名**: ${this.app.vault.getName()}`);
    lines.push(`**登录账号**: ${auth?.isLoggedIn ? auth.displayName || "已登录" : "未登录"}`);
    lines.push(`**平台**: ${platformLabel}`);
    lines.push("");
    lines.push("## 当前同步概况");
    lines.push("");
    lines.push(...formatDiagnosticAutomaticSyncSummary({
      intervalMinutes: this.syncInterval,
      paused: this.autoSyncPaused,
      changeDelaySeconds: this.autoSyncChangeDelaySeconds,
      dirtyPending: this.autoSyncDirtyHint.pending,
      activity: automaticActivity,
    }));
    lines.push(`**上次同步**: ${fmt(this.state?.lastSyncTime ?? 0)}`);
    if (mutationRecoveryDisplay) {
      const pathlessRecovery = {
        ...mutationRecoveryDisplay,
        firstPath: null,
      };
      lines.push(
        `**未完成操作核对**: ${mutationRecoveryStatusLabel(
          pathlessRecovery,
          reportI18n.t.bind(reportI18n),
        )}；${mutationRecoveryStatusDetail(
          pathlessRecovery,
          reportI18n.t.bind(reportI18n),
          fmtShort,
        )}`,
      );
    } else {
      lines.push("**未完成操作核对**: 无");
    }
    lines.push(`**计划审阅**: ${reportState?.planReviewActive ? `等待确认（revision ${reportState.planReviewRevision}）` : "无"}`);
    lines.push(`**自动处理配置**: 将远端删除同步到本地 ${this.automaticHandlingPolicy.autoDeleteLocalFiles ? "开启" : "关闭"} / 合并不重叠的文本修改 ${this.automaticHandlingPolicy.mergeNonOverlappingText ? "开启" : "关闭"}`);
    const describePluginScope = (
      scope: typeof communityPluginSummary.files,
    ): string => `${scope.mode === "selected"
      ? `已选 ${scope.selected} 个`
      : scope.mode === "all"
        ? "全部"
        : "关闭"}（本机不同步 ${scope.ignoredOnDevice} 个）`;
    lines.push(
      `**社区插件精细化范围**: 文件 ${describePluginScope(communityPluginSummary.files)} / 数据 ${describePluginScope(communityPluginSummary.data)} / 清单 ${communityPluginSummary.inventory.total} 个（本地 ${communityPluginSummary.inventory.local}、远端 ${communityPluginSummary.inventory.remote}、清单异常 ${communityPluginSummary.inventory.manifestIssues}） / 远端清单 ${communityPluginSummary.remoteInventoryTrusted ? "可信" : "不可用"} / 启用锚点 ${communityPluginSummary.enablement.anchors} / 待决策 ${communityPluginSummary.enablement.pending}`,
    );
    const inventoryById = new Map(
      communityPluginInventory.map((item) => [item.id, item]),
    );
    const participationIssues = Object.values(
      this.communityPluginParticipation?.pluginsById ?? {},
    ).filter((entry) =>
      entry.phase === "join-requested"
      || entry.phase === "restoring"
      || entry.phase === "exit-requested"
      || entry.phase === "blocked"
    ).map((entry) => {
      const inventoryItem = inventoryById.get(entry.pluginId);
      const name = inventoryItem?.name?.trim() || entry.pluginId;
      const identity = name === entry.pluginId
        ? entry.pluginId
        : `${name} (${entry.pluginId})`;
      return `${identity}: ${entry.phase}${
        entry.blockedReason ? ` / ${entry.blockedReason}` : ""
      }`;
    });
    lines.push(
      `**社区插件过渡或受阻项**: ${
        participationIssues.length > 0 ? participationIssues.join("；") : "无"
      }`,
    );
    const configSyncLabels = [
      [this.syncEditorSettings, "编辑器设置"],
      [this.syncAppearance, "外观"],
      [this.syncThemes, "主题"],
      [this.syncHotkeys, "快捷键"],
      [this.syncBookmarks, "书签"],
      [this.syncCorePlugins, "核心插件"],
      [this.syncCommunityPlugins, "社区插件"],
      [this.syncPluginData, "插件数据"],
      [this.syncPluginFiles, "EasySync 插件文件"],
    ] as const;
    lines.push(`**已启用配置同步**: ${configSyncLabels.filter(([enabled]) => enabled).map(([, label]) => label).join("、") || "无"}`);
    lines.push(`**本机同步排除**: ${this.excludedFolders.length} 个`);
    if (this.excludedFolders.length > 0) {
      lines.push("");
      for (const path of this.excludedFolders) {
        lines.push(`- \`${path.replace(/`/g, "\\`")}\``);
      }
    }
    lines.push("");
    lines.push("## 技术状态证据");
    lines.push("");
    lines.push(`**构筑物指纹**: ${buildFingerprint}`);
    lines.push(`**本地存储布局**: v${storageLayoutVersion}`);
    lines.push(
      `**同步状态权威**: ${v2StateLoadBlock
        ? `${v2StateLoadBlock.authority}（加载受阻：${v2StateLoadBlock.reason}）`
        : reportState?.isV2StateActive
          ? "v2（已加载）"
          : "v1-precommit"}`,
    );
    lines.push(`**V2 状态存储权威**: ${formatV2StorageAuthorityEvidence(
      v2StorageAuthority?.kind === "indexeddb"
        ? {
            kind: "indexeddb",
            databaseFingerprint: v2DatabaseFingerprint,
            stateCommitSeq: v2StorageAuthority.stateCommitSeq,
            lifecycleEpoch: v2StorageAuthority.lifecycleEpoch,
          }
        : v2StorageAuthority,
    )}`);
    lines.push(`**同步范围指纹**: account ${accountFingerprint} / drive ${driveFingerprint} / vault ${vaultFingerprint} / files ${filesRootFingerprint}`);
    lines.push(`**远端快照**: generation ${reportState?.remoteGeneration ?? 0}`);
    lines.push(`**状态规模**: 基线 ${reportState?.baseSnapshot.length ?? 0} / 远端文件 ${reportState?.remoteSnapshot.length ?? 0} / 远端目录 ${reportState?.remoteFolders.length ?? 0} / 冲突 ${reportState?.pendingConflicts.length ?? 0} / 待删除 ${reportState?.pendingRemoteDeletes.length ?? 0} / 待处理项 ${reportState?.pendingIssues.length ?? 0}`);
    lines.push(`**增量游标**: ${reportState?.remoteDeltaLink ? "已保存" : "无"}`);
    lines.push(`**最近同步记录 ID**: ${reportState?.syncHistory?.[0]?.id ?? "—"}`);
    lines.push(`**社区插件策略指纹**: ${communityPluginSummary.policyFingerprint}`);
    lines.push("");

    const remoteScopeRecoverySummary =
      this.progressStore.state.recoveryVerification
      ?? reportState?.syncHistory.find(
        (entry) => entry.remoteScopeRecovery !== undefined,
      )?.remoteScopeRecovery;
    lines.push("## 远端 Scope 恢复");
    lines.push("");
    lines.push(`**当前状态**: ${v2RemoteScopeRecovery ? "等待或正在恢复" : "无待恢复项"}`);
    if (remoteScopeRecoverySummary) {
      lines.push(`**操作指纹**: ${remoteScopeRecoverySummary.operationFingerprint}`);
      lines.push(`**协议预检**: ${remoteScopeRecoverySummary.protocolPreflight === "ready" ? "通过" : "受阻"}`);
      lines.push(`**正文核验**: 总数 ${remoteScopeRecoverySummary.total} / 本轮新增 ${remoteScopeRecoverySummary.verifiedThisRun} / 复用 ${remoteScopeRecoverySummary.reused} / 失效 ${remoteScopeRecoverySummary.invalidated} / 剩余 ${remoteScopeRecoverySummary.remaining}`);
      lines.push(`**终止阶段**: ${remoteScopeRecoverySummary.failureStage ?? "无"}`);
      lines.push(`**首个失败对象**: ${remoteScopeRecoverySummary.firstFailurePath ?? "—"}`);
    } else {
      lines.push("**最近核验证据**: 无");
    }
    lines.push("");

    // ── Sync History ──
    const history = this.state?.syncHistory ?? [];
    lines.push("## 近期同步记录");
    lines.push("");
    if (history.length === 0) {
      lines.push("*暂无同步记录*");
    } else {
      lines.push("| 时间 | 模式 | 状态 | 未完成操作核对 | 耗时 | 上传 | 下载 | 文件移动 | 文件夹创建 | 文件夹移动 | 文件夹删除 | 文件删除 | 冲突 | 远端删除待确认 | 延后 | 跳过(L/I) | 错误 |");
      lines.push("|------|------|------|----------------|------|------|------|----------|------------|------------|------------|----------|------|------------------|------|-----------|------|");
      for (const h of history) {
        const mode = h.mode === "manual" ? "手动" : h.mode === "auto" ? "自动" : "首次";
        const statusMap: Record<string, string> = { success: "已完成", partial: "部分完成", cancelled: "已取消", authExpired: "登录过期", failed: "失败" };
        const status = statusMap[h.status] ?? h.status;
        const duration = h.endedAt > 0 && h.startedAt > 0 ? `${Math.round((h.endedAt - h.startedAt) / 1000)}s` : "—";
        const skipLarge = h.skippedLarge ?? 0;
        const skipIgnored = h.skippedIgnored ?? 0;
        const actions = projectSyncHistoryActionCounts(h);
        const pending = resolveSyncPendingAttentionCounts(
          h.conflicts,
          h.files,
        );
        const recovery = h.recovery
          ? formatMutationRecoveryHistory(
              h.recovery,
              reportI18n.t.bind(reportI18n),
            )
          : "—";
        lines.push(`| ${fmt(h.startedAt)} | ${mode} | ${status} | ${recovery} | ${duration} | ${actions.uploaded} | ${actions.downloaded} | ${actions.filesMoved} | ${actions.foldersCreated} | ${actions.foldersMoved} | ${actions.foldersDeleted} | ${actions.filesDeleted} | ${pending.conflicts} | ${pending.remoteDeletes} | ${h.deferred ?? 0} | ${skipLarge}/${skipIgnored} | ${h.errors} |`);
      }
    }
    lines.push("");

    const formatSize = (bytes?: number): string => {
      if (bytes === undefined || bytes === null) return "?";
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
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
        const action = formatActionLabel(f.actionType);
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

    const pendingItems = issues.filter((i) =>
      i.actionType !== SyncActionType.SkipLargeFile
      && i.actionType !== SyncActionType.SkipIgnoredPath);
    const skippedItems = issues.filter((i) =>
      i.actionType === SyncActionType.SkipLargeFile
      || i.actionType === SyncActionType.SkipIgnoredPath);
    if (pendingItems.length > 0) {
      lines.push(`### 待处理项（${pendingItems.length}）`);
      lines.push("");
      lines.push("| 文件 | 大小 | 操作 | 原因 | 最后尝试 |");
      lines.push("|------|------|------|------|----------|");
      for (const f of pendingItems) {
        const action = formatActionLabel(f.actionType);
        lines.push(`| ${f.path} | ${formatSize(f.fileSize)} | ${action} | ${f.reason ?? "—"} | ${fmtShort(f.updatedAt)} |`);
      }
    } else {
      lines.push("*无待处理项*");
    }
    lines.push("");

    if (skippedItems.length > 0) {
      lines.push(`### 未同步项（${skippedItems.length}）`);
      lines.push("");
      lines.push("| 文件 | 大小 | 操作 | 原因 | 最后尝试 |");
      lines.push("|------|------|------|------|----------|");
      for (const item of skippedItems) {
        lines.push(`| ${item.path} | ${formatSize(item.fileSize)} | ${formatActionLabel(item.actionType)} | ${item.reason ?? "—"} | ${fmtShort(item.updatedAt)} |`);
      }
      lines.push("");
    }

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
    const currentRecoverySummary = {
      ...summarizeMutationRecovery(reportState?.mutationLedger ?? []),
      v2Quarantined:
        reportState?.mutationRecoveryQuarantine.length ?? 0,
      v2QuarantineCorrupt:
        reportState?.hasMutationRecoveryQuarantineCorruption ?? false,
      v2AuthoritySelected:
        reportState?.isV2AuthoritySelected ?? false,
      v2StateActive:
        reportState?.isV2StateActive ?? false,
      v2StateLoadBlocked:
        reportState?.hasV2StateLoadRecoveryBlock ?? false,
      v2StateLoadBlockAuthority:
        v2StateLoadBlock?.authority ?? null,
      v2StateLoadBlockReason:
        v2StateLoadBlock?.reason ?? null,
      v2StateLoadBlockDetail:
        v2StateLoadBlock?.detail ?? null,
      v2RemoteScopeRecoveryPending:
        reportState?.hasV2RemoteScopeRecovery ?? false,
      v2RemoteScopeRecoveryReason:
        v2RemoteScopeRecovery?.reason ?? null,
      v2RemoteScopeObserved:
        v2RemoteScopeRecovery?.observedScope !== null
          && v2RemoteScopeRecovery?.observedScope !== undefined,
      remoteScopeRecoveryVerification:
        remoteScopeRecoverySummary ?? null,
      automaticRecoveryState:
        mutationRecoveryDisplay?.kind ?? "inactive",
      automaticRecoveryRemaining:
        mutationRecoveryDisplay?.remaining ?? 0,
      automaticRecoveryRetryAt:
        mutationRecoveryDisplay?.retryAt ?? null,
      automaticRecoveryBlockReason:
        mutationRecoveryDisplay?.blockReason ?? null,
      automaticRecoveryObservations:
        mutationRecoveryScheduler.automaticObservations,
      automaticRecoverySchedulerState:
        mutationRecoveryScheduler.state,
      manualResolutionAuditCount:
        reportState?.manualMutationResolutionAudit.length ?? 0,
      latestManualResolution:
        reportState?.manualMutationResolutionAudit.slice(-1)[0] ?? null,
      autoSyncPaused: this.autoSyncPaused,
    };
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
      this.statusBarEl.setText(
        this.progressStore.state.activityKind === "mutationRecovery"
          ? t("status.recovering")
          : t("status.syncing"),
      );
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

    const recovery = this.getMutationRecoveryDisplayState();
    if (recovery?.kind === "waiting-network") {
      this.statusBarEl.setText(t("status.waitingForNetwork"));
      return;
    }
    if (recovery?.kind === "blocked") {
      this.statusBarEl.setText(t("status.recoveryBlocked"));
      return;
    }
    if (recovery?.kind === "checking") {
      this.statusBarEl.setText(t("status.recovering"));
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
    const recovery = this.getMutationRecoveryDisplayState();
    const hasHigherPriorityAttention =
      (this.state?.planReviewActive ?? false)
      || (this.state?.pendingIssues.length ?? 0) > 0
      || (this.state?.pendingConflicts.length ?? 0) > 0
      || (this.state?.pendingRemoteDeletes.length ?? 0) > 0;
    const label =
      status === "attention"
      && recovery
      && !hasHigherPriorityAttention
        ? this.i18n.t(
            recovery.kind === "waiting-network"
              ? "ribbon.waitingForNetwork"
              : "ribbon.recoveryBlocked",
          )
        : resolveRibbonStatusLabel(
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
        || (this.state?.pendingRemoteDeletes.length ?? 0) > 0
        || this.getCommunityPluginEnablementPendingCount() > 0
        || this.getMutationRecoveryDisplayState() !== null,
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
