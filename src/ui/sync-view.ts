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
  describeError,
  getConfigDir,
  normalizeVaultPathKey,
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
  isConfigurationSkipAction,
  normalizeHistorySkipPaths,
} from "../sync/skip-baseline";
import {
  mutationRecoveryItemKey,
  pendingIssueExitKind,
  pendingIssueTerminationKey,
  syncItemTerminationSignature,
  type PendingIssueExitKind,
} from "../sync/sync-item-termination";
import {
  formatTransferRate,
  type TransferRateReading,
} from "../sync/transfer-rate";
import { ConfirmModal } from "./confirm-modal";
import { applyDestructiveButton } from "./destructive-button";
import { formatFileSize } from "./file-comparison-modal";
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
import type { LocalOnlyEntryRowV1 } from "../sync/local-only-copies";
import { parseCommunityPluginBundlePath } from "../sync/community-plugin-bundle";
import { isObsidianManagedConfigPath } from "../sync/file-decision-planner-v2";
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
  /** 同步入口已持有共享占用（云端检测、运行前准备；执行器尚未开跑）。
   *  与「运行中」同档呈现（同一句现役短语与同一个禁用主动作），但补充事实行
   *  仍按真实运行事实决定——准备期还没有当前文件可显示（2026-10-10 拍板）。 */
  syncEntryInProgress: boolean;
  canCancel: boolean;
  lastSyncTime: number;
  pendingCount: number;
  planReviewActive: boolean;
  planReviewRevision: number;
  planReviewDetailsState: "ready" | "recovering" | "retry";
  planReviewRefreshed: boolean;
  autoSyncPaused: boolean;
  mutationRecovery: MutationRecoveryDisplayState | null;
  latestHistory?: SyncHistoryEntry;
  progress: Readonly<SyncProgressState>;
}

type SyncViewBodyMode = "plan" | "progress" | "pending" | "recovery" | "idle";

/** 工具栏「全部展开／折叠」的会话级覆盖。它只由用户点击改变，跨正文重建与
 *  计划修订保持；"default" 表示交回各区域自己的类别默认态。 */
type SyncViewSessionOverride = "default" | "expanded" | "collapsed";
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

/**
 * 片⑦ E1：静止（时间戳态）detail 槽的文本——时间戳之后拼单向模式常驻标识
 * （已过目文案 `syncView.status.mode.oneway`）。纯文本：不新增控件、不按钮化、
 * 不承担切换入口；无时间戳时标识单独显示；双向不加任何字。
 */
export function resolveSyncViewStatusDetailText(input: {
  timestampText: string;
  oneWay: boolean;
  oneWayIndicator: string;
}): string {
  return input.oneWay
    ? `${input.timestampText}${input.oneWayIndicator}`
    : input.timestampText;
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

type SyncViewPrimaryActionKind =
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
): { title: string; summary: string; path: string | null } | null {
  if (!state.failureStage) return null;
  return {
    title: t("syncView.progress.remoteScopeRecoveryFailureTitle"),
    summary: t("syncView.progress.remoteScopeRecoveryFailureSummary"),
    path: state.firstFailurePath ?? null,
  };
}

interface SyncViewContentKeyInput {
  isLoggedIn: boolean;
  isInitializing: boolean;
  isPending: boolean;
  /** Session present but the account is not verified yet — the status panel
   *  shows "connecting" instead of a healthy ready/synced state. */
  sessionPending?: boolean;
  isRunning: boolean;
  canCancel: boolean;
  /** Sync entry holds the shared operation lock (detection / run preparation);
   *  part of the run key so the panel rebuilds when the window opens or closes. */
  syncEntryInProgress: boolean;
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
  /** 片⑦ 修复：本机独有条目（与待处理区行同源 `plugin.getLocalOnlyRows()`）。
   *  忽略写入与上传成功都只改这份集合——不进指纹时，重建会被跳过，行要等
   *  下一轮同步（historyKey 变化）才消失。 */
  localOnlyRows?: readonly LocalOnlyEntryRowV1[];
  planReviewCounts: { uploads: number; downloads: number; folders?: number; deletes: number; conflicts: number; skipped: number; localOnlyCopies?: number } | null;
  planReviewRevision: number;
  history: SyncHistoryEntry[];
  lastSyncTime: number;
  mutationRecovery: MutationRecoveryDisplayState | null;
  /** 更新提示行（方案单 20260915-0025 §四 提示层）：行只在整屏重建时挂载，
   *  而计划审阅／核对（recovery）体态下模式不随提示出现而翻转——不进指纹时
   *  这两类体态下的出现与消失会被重建跳过（与 localOnlyRows 同族；
   *  2026-10-13 实机坐实：状态层已有新版、侧栏整行不可见）。 */
  updatePrompt?: { latest: string; current: string } | null;
  /** S4 逐项终局判定签名（`syncItemTerminationSignature`）：结论到达的那一轮
   *  可能没有任何其他可见事实变化（记录与待办行都没动），不进指纹时待处理行
   *  的终局句与核对区的终局句会被重建跳过（与 localOnlyRows／updatePrompt 同族）。 */
  itemTerminationKey?: string;
}

interface PendingIssueReviewGroup {
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
interface SyncPendingDisplayRow {
  key: string;
  kind:
    | "adoption"
    | "issue"
    | "batchConflict"
    | "conflict"
    | "pluginConflict"
    | "batchDelete"
    | "delete"
    | "batchLocalOnly"
    | "localOnly"
    | "retainedFolder";
  adoption?: CommunityPluginAdoptionRow;
  issue?: PendingIssue;
  nestedIssues?: PendingIssue[];
  retryable?: boolean;
  item?: SyncPlanItem;
  pluginConflict?: { pluginId: string; items: SyncPlanItem[] };
  deletes?: SyncPlanItem[];
  /** 成批的普通文件冲突：批量行的动作作用在这整份清单上。 */
  conflicts?: readonly SyncPlanItem[];
  /** 同屏可见、但不在批量覆盖范围内的文件冲突数（插件子树/受管设置）。 */
  conflictBatchExcluded?: number;
  /** 片④ 单向模式的本机独有条目（改动副本／本机新建）。 */
  localOnly?: LocalOnlyEntryRowV1;
  /** 成批的本机独有条目：批量行的动作作用在这整份清单上。 */
  localOnlyBatch?: readonly LocalOnlyEntryRowV1[];
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
  /** 片④ 本机独有条目；排在逐条删除之后、只读跳过项之前（仍是要处理的动作）。 */
  localOnlyRows?: readonly LocalOnlyEntryRowV1[];
  /** 单向模式保留的云端已删文件夹说明行；无动作，不计入待处理数。 */
  retainedFolders?: readonly PendingIssueReviewGroup[];
  /** 配置目录；用于把插件目录与受管设置排除出批量冲突。 */
  configDir?: string;
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
      key: pendingIssueTerminationKey(issue),
      kind: "issue",
      issue,
      nestedIssues,
      retryable: true,
    });
  }
  const configDir = input.configDir ?? "";
  const batchConflictItems = collectBatchConflictItems(
    input.conflictEntries,
    configDir,
  );
  if (
    isBatchedConflictSet(
      batchConflictItems.map((item) => `conflict:${item.path}`),
    )
  ) {
    const fileConflictCount = input.conflictEntries.filter(
      (entry) => entry.kind === "file",
    ).length;
    push({
      key: "batch-conflict",
      kind: "batchConflict",
      conflicts: batchConflictItems,
      conflictBatchExcluded: Math.max(
        0,
        fileConflictCount - batchConflictItems.length,
      ),
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
  const localOnlyRows = input.localOnlyRows ?? [];
  if (isBatchedLocalOnlySet(localOnlyRows.map((entry) => `localOnly:${entry.targetPath}`))) {
    push({
      key: "batch-localOnly",
      kind: "batchLocalOnly",
      localOnlyBatch: [...localOnlyRows],
    });
  }
  // A retained folder note is context for its local-only rows, so it rides
  // immediately above the first file of that folder. Notes only materialize
  // when this device still shows an actionable (non-ignored) local-only file
  // below them; ignored files keep the folder but drop the reminder.
  const retainedFolderIssues = (input.retainedFolders ?? [])
    .map(({ issue }) => issue)
    .filter((issue) => localOnlyRows.some((entry) =>
      isPathAtOrBelow(entry.targetPath, issue.path)))
    .sort((left, right) => left.path.localeCompare(right.path));
  const retainedFolderByPath = new Map(
    retainedFolderIssues.map((issue) => [issue.path, issue]),
  );
  const localOnlyByRetainedFolder = new Map<string, LocalOnlyEntryRowV1[]>();
  const ungroupedLocalOnlyRows: LocalOnlyEntryRowV1[] = [];
  for (const entry of localOnlyRows) {
    const folder = retainedFolderIssues
      .filter((issue) => isPathAtOrBelow(entry.targetPath, issue.path))
      .sort((left, right) => left.path.length - right.path.length)[0];
    if (!folder) {
      ungroupedLocalOnlyRows.push(entry);
      continue;
    }
    const bucket = localOnlyByRetainedFolder.get(folder.path) ?? [];
    bucket.push(entry);
    localOnlyByRetainedFolder.set(folder.path, bucket);
  }
  for (const issue of retainedFolderIssues) {
    const entries = localOnlyByRetainedFolder.get(issue.path) ?? [];
    if (entries.length === 0) continue;
    push({
      key: `retainedFolder:${issue.path}`,
      kind: "retainedFolder",
      issue: retainedFolderByPath.get(issue.path),
    });
    for (const entry of entries) {
      push({
        key: `localOnly:${entry.targetPath}`,
        kind: "localOnly",
        localOnly: entry,
      });
    }
  }
  for (const entry of ungroupedLocalOnlyRows) {
    push({
      key: `localOnly:${entry.targetPath}`,
      kind: "localOnly",
      localOnly: entry,
    });
  }
  for (const { issue, nestedIssues } of input.skipped) {
    push({
      key: pendingIssueTerminationKey(issue),
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

interface AdaptivePathLayoutInput {
  path: string;
  availableWidth: number;
  measureTextWidth: (text: string) => number;
}

interface AdaptivePathLayoutDecision {
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

function isPathAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
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

interface CompletedFileRowsDiff {
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

interface SyncPlanDisplayGroup {
  group: SyncActionGroup;
  labelKey: keyof LocaleStrings;
  items: PlanReviewItem[];
}

/** A completed row that only records "excluded by configuration" (size limit
 *  or ignored path). It performs no work, so it never counts toward the run's
 *  progress numbers and the list folds it into one collapsed group
 *  (2026-10-25 拍板). */
function isConfigurationSkipFile(
  file: Pick<FileProgress, "actionType">,
): boolean {
  return isConfigurationSkipAction(file.actionType);
}

export function partitionCompletedProgressRows(
  files: readonly FileProgress[],
): { action: FileProgress[]; skipped: FileProgress[] } {
  const action: FileProgress[] = [];
  const skipped: FileProgress[] = [];
  for (const file of files) {
    (isConfigurationSkipFile(file) ? skipped : action).push(file);
  }
  return { action, skipped };
}

/**
 * The "completed" subtitle counts real actions only. `completedCount` is the
 * executor's true completed total (the retained row list caps successes), and
 * size/ignored-path rows are never trimmed, so counting them in the retained
 * list gives the exact amount to subtract.
 */
export function resolveCompletedActionCount(
  state: Readonly<SyncProgressState>,
): number {
  const skipped = state.completedFiles.reduce(
    (count, file) => count + (isConfigurationSkipFile(file) ? 1 : 0),
    0,
  );
  return Math.max(0, state.completedCount - skipped);
}

/**
 * History fold rows for one round: the rows that round actually emitted (a new
 * skip's first sighting) plus the retained path list, so every entry can expand
 * the same fold even after the sidebar stops re-emitting stable skips
 * (2026-10-25 拍板). `total` keeps the round's true skip count and `omitted`
 * reports the remainder beyond `MAX_HISTORY_SKIP_PATHS`.
 */
export function collectHistorySkipRows(args: {
  files: readonly FileProgress[];
  skipPaths: unknown;
  total?: number;
}): { rows: FileProgress[]; total: number; omitted: number } {
  const byPath = new Map<string, FileProgress>();
  for (const file of partitionCompletedProgressRows(args.files).skipped) {
    byPath.set(file.path, file);
  }
  for (const path of normalizeHistorySkipPaths(args.skipPaths)) {
    if (byPath.has(path)) continue;
    byPath.set(path, {
      path,
      status: "skip",
      actionType: SyncActionType.SkipLargeFile,
    });
  }
  const rows = [...byPath.values()];
  const total = Math.max(args.total ?? 0, rows.length);
  return { rows, total, omitted: Math.max(0, total - rows.length) };
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

/**
 * 计划在侧栏展示期间被重新生成过（本会话）。
 *
 * 只对激活类审阅（`reviewKind` 存在）成立：该家族的审阅修订号由 hold 的
 * 幂等暂存守卫维护——计划事实全同则原样返回、不涨号——所以「修订号前进」
 * 就等于「用户正看着的这份计划被换过」，与确认被拒是同一个不变量。普通审阅
 * 的修订号每次重写计划都会 +1（计划没变也涨），口径不同，且其「同步计划已
 * 更新」弹框本就正常出现，不在此列。首次展示（无基线）恒 false。
 */
export function isPlanReviewRefreshedSinceShown(input: {
  reviewKind: string | null | undefined;
  currentRevision: number;
  baselineRevision: number | null;
}): boolean {
  return input.reviewKind != null
    && input.baselineRevision !== null
    && input.currentRevision > input.baselineRevision;
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

interface SyncPlanDisplayRow {
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
    || key.startsWith("adoption:")
    // 片④ 本机独有条目：唯一出口（「上传到云端」）只在展开区。
    || key.startsWith("localOnly:");
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

/** 成批的本机独有条目：与批量删除同一判据（≥2 条才给批量入口），批量入口
 *  出现时逐条行不再默认展开——同一屏里一个出口就够了。 */
export function isBatchedLocalOnlySet(keys: readonly string[]): boolean {
  let count = 0;
  for (const key of keys) {
    if (!key.startsWith("localOnly:")) continue;
    count += 1;
    if (count > 1) return true;
  }
  return false;
}

/** 成批的普通文件冲突：≥2 条可批量处理的文件冲突才给批量入口。插件整包与
 *  受管设置不进入这一族（整包中途失败会留下混装三件套；受管设置覆盖前没有
 *  本机留档），逐条行保持原出口。 */
export function isBatchedConflictSet(keys: readonly string[]): boolean {
  let count = 0;
  for (const key of keys) {
    if (!key.startsWith("conflict:")) continue;
    count += 1;
    if (count > 1) return true;
  }
  return false;
}

/** 本条冲突是否允许进入批量：插件目录整棵（含插件 data.json）与 Obsidian
 *  受管设置文件排除，其余普通文件冲突可批量。 */
export function isConflictBatchExcludedPath(
  path: string,
  configDir: string,
): boolean {
  const normalizedDir = normalizeVaultPathKey(configDir).replace(/\/+$/, "");
  if (!normalizedDir) return false;
  const normalizedPath = normalizeVaultPathKey(path);
  const pluginsPrefix = `${normalizedDir}/plugins/`;
  if (
    normalizedPath === `${normalizedDir}/plugins`
    || normalizedPath.startsWith(pluginsPrefix)
  ) return true;
  return isObsidianManagedConfigPath(path, normalizedDir);
}

/** 从待处理冲突条目中取出可批量处理的普通文件冲突（保持原显示顺序）。 */
export function collectBatchConflictItems(
  conflictEntries: readonly BundleConflictReviewEntry[],
  configDir: string,
): SyncPlanItem[] {
  return conflictEntries
    .filter((entry): entry is { kind: "file"; item: SyncPlanItem } =>
      entry.kind === "file"
      && !isConflictBatchExcludedPath(entry.item.path, configDir))
    .map((entry) => entry.item);
}

/** 决策行的类别默认态：决策行默认展开，出口第一眼可见；成批出现的待确认
 *  删除与成批出现的本机独有条目默认收起（这两类各有自己的批量入口）。
 *  只读行不在此列（它们没有行身份，也不会被写成展开态）。 */
export function resolveDecisionRowDefaultOpen(
  key: string,
  options: {
    deleteRowsBatched?: boolean;
    localOnlyRowsBatched?: boolean;
  } = {},
): boolean {
  if (!isDecisionRowKey(key)) return false;
  if (key.startsWith("delete:")) return options.deleteRowsBatched !== true;
  if (key.startsWith("localOnly:")) return options.localOnlyRowsBatched !== true;
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
  issue: Pick<PendingIssue, "actionType" | "issueCode">,
  t: (key: string) => string,
): string | null {
  const actionType = issue.actionType;
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

type BundleConflictReviewEntry =
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
  const runKey = `run:${input.isRunning ? 1 : 0}:${input.canCancel ? 1 : 0}:${input.syncEntryInProgress ? 1 : 0}`;
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
  // 更新提示行（pending 区尾部、计划审阅与核对体态的内容尾部）都只在整屏
  // 重建时挂载：提示的出现、消失与版本文案变化必须进指纹，否则重建会被跳过
  // （pending 体态已由 localOnlyRows 同族修复，2026-10-13 补齐本行）。
  const updateKey = input.updatePrompt
    ? `update:${input.updatePrompt.latest}:${input.updatePrompt.current}`
    : "update:none";
  // S4 逐项终局判定：结论本身可能就是这一轮唯一的可见变化（记录与待办行
  // 都没动），所以与 updatePrompt 同族进指纹。
  const terminationKey = `termination:${input.itemTerminationKey ?? ""}`;
  if (input.bodyMode === "plan") {
    const counts = input.planReviewCounts
      ? `${input.planReviewCounts.uploads},${input.planReviewCounts.downloads},${input.planReviewCounts.folders ?? 0},${input.planReviewCounts.deletes},${input.planReviewCounts.conflicts},${input.planReviewCounts.skipped},${input.planReviewCounts.localOnlyCopies ?? 0}`
      : "";
    return `plan:${authKey}:${runKey}:${recoveryKey}:${counts}:details:${input.planReviewDetailsState}:revision:${input.planReviewRevision}:${updateKey}:${historyKey}`;
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
    // 本机独有条目：行事实全进指纹——显示路径（`path`）、行 key／忽略键
    // （`targetPath`）与类别。待处理区行会再按 `isSideActionQueued` 过滤，但那份
    // 过滤只会与 runKey（isRunning）同时变化——有排队项时
    // `hasSideActionsInFlight` 必为真——所以未过滤集合足够。
    const localOnly = (input.localOnlyRows ?? [])
      .map((row) => `${row.path}:${row.targetPath}:${row.kind}`)
      .join("|");
    return `pending:${authKey}:${runKey}:${recoveryKey}:${issues}:${conflicts}:${deletes}:adoption:${adoption}:localOnly:${localOnly}:${updateKey}:${terminationKey}:${historyKey}`;
  }
  if (input.bodyMode === "recovery") {
    return `recovery:${authKey}:${runKey}:${recoveryKey}:${updateKey}:${terminationKey}:${historyKey}`;
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
  // 会话级基线：本视图首次展示当前审阅时的修订号（计划正文首次渲染时记下，
  // 审阅结束清零）。它只喂 isPlanReviewRefreshedSinceShown——被重新暂存后
  // 顶部状态行与计划区说明行改说既有的「同步计划已更新」文案。
  private planReviewBaselineRevision: number | null = null;
  private planReviewDetailsRecoveryInFlight = false;
  // P0: incremental render — frame merging + diffed file list
  private renderFrameId: AnimationFrameHandle | null = null;
  private lastContentKey: string | null = null;
  /** S4 终止判据的呈现缓存：本渲染 tick 内「不可重试诊断」已结论的项 key。
   *  判定状态只在轮末变化，同一 tick 内重扫快照纯属浪费（大列表下逐行
   *  扫＝O(行数×结论数)）。doRender 开头置空。 */
  private nonRetryableTerminationKeys: ReadonlySet<string> | null = null;
  // Cached DOM refs for direct progress-bar updates
  private progressPanelEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressSubtitleEl: HTMLElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private completedFileRowsLedger: Map<string, string> | null = null;
  // 按设置跳过的零动作行：运行中与历史共用同一个折叠组（2026-10-25 拍板），
  // 这里缓存运行中那一份，供增量补行与标题计数使用。
  private progressSkipGroupEl: HTMLElement | null = null;
  private progressSkipListEl: HTMLElement | null = null;
  private progressSkipTitleEl: HTMLElement | null = null;
  private progressSkipRowsLedger: Map<string, string> | null = null;
  private planViewportFrameId: AnimationFrameHandle | null = null;
  private planVirtualRenderers = new Set<() => void>();
  // Windowed decision rows are unmounted while off screen, so their open state
  // and their measured height have to outlive the DOM they were read from.
  private planRowExpandedState = new Map<string, boolean>();
  private planRowHeights = new Map<string, number>();
  private planRowLayoutRevision = 0;
  private planDecisionRowsInFlight = new Set<string>();
  // 当前正文区域里两类"成批"事实（决定逐条行的类别默认态）：成批的待确认删除、
  // 成批的本机独有条目。区域渲染时写下，正文整体重建后回填展开态时读回；正文没有
  // 对应行时该值不产生作用。
  private renderedBatchedRows: {
    deleteRowsBatched: boolean;
    localOnlyRowsBatched: boolean;
  } = { deleteRowsBatched: false, localOnlyRowsBatched: false };
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

  /**
   * Rebuild the view content from scratch for the current body mode.
   *
   * Contract: `container` is the live content element (`this.contentEl`)
   * threaded by reference, never cloned; every other field is a read-only
   * input sampled by the caller before the rebuild. The phase neither
   * reassigns a host binding nor terminates the host, so it returns void.
   * `this.lastContentKey` is deliberately not written here — the caller
   * records the new content key once both branches have rendered.
   */
  private renderSyncViewFullRebuild(args: {
    container: HTMLElement;
    statusState: StatusPanelState;
    bodyMode: SyncViewBodyMode;
    sideActionResultsVisible: boolean;
    isRunning: boolean;
    progress: SyncProgressState;
    syncState: EasySyncPlugin["state"];
    planReviewCounts: NonNullable<EasySyncPlugin["state"]>["planReviewCounts"];
    planReviewItems: PlanReviewItem[];
    planReviewRefreshed: boolean;
    conflicts: SyncPlanItem[];
    pendingDeletes: SyncPlanItem[];
    pendingIssueGroups: PendingIssueReviewGroup[];
    adoptionRows: CommunityPluginAdoptionRow[];
    updatePrompt: ReturnType<EasySyncPlugin["getUpdatePromptState"]>;
    mutationRecovery: MutationRecoveryDisplayState | null;
    preservedContentScrollTop: number | null;
    preservedHostScrollTop: number | null;
  }): void {
    const {
      container,
      statusState,
      bodyMode,
      sideActionResultsVisible,
      isRunning,
      progress,
      syncState,
      planReviewCounts,
      planReviewItems,
      planReviewRefreshed,
      conflicts,
      pendingDeletes,
      pendingIssueGroups,
      adoptionRows,
      updatePrompt,
      mutationRecovery,
      preservedContentScrollTop,
      preservedHostScrollTop,
    } = args;
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
    this.progressSkipGroupEl = null;
    this.progressSkipListEl = null;
    this.progressSkipTitleEl = null;
    this.progressSkipRowsLedger = null;
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
        planReviewRefreshed,
      );
    } else if (bodyMode === "progress") {
      this.renderProgressPanel(content, progress);
      this.renderRemoteScopeRecoveryFailure(
        content,
        progress.recoveryVerification,
      );
    } else if (bodyMode === "pending") {
      if (sideActionResultsVisible) {
        this.renderProgressPanel(content, progress);
        this.renderRemoteScopeRecoveryFailure(
          content,
          progress.recoveryVerification,
        );
      }
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

    // 更新提示行：待处理区自带（`renderPendingSection` 尾部）；计划审阅与核对
    // （recovery）体态此前把它整行吞掉——方案单 §四 要求行位于「冲突/核对/
    // 待审计划行」之后，故这两类体态也在内容末尾补挂（追加在下方，不推挤
    // 上方任何行；2026-10-13 实机坐实 iphone/rs-migration 两库整行不可见）。
    if (updatePrompt && (bodyMode === "plan" || bodyMode === "recovery")) {
      const updateSection = content
        .createDiv("easy-sync-section")
        .createDiv("easy-sync-section-body");
      this.renderUpdateAvailableItem(updateSection, updatePrompt);
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
  }

  private doRender(): void {
    const container = this.contentEl;
    // S4 逐项终局判定按渲染轮次重新取样一次：判定只在轮末变化，同一 tick 内
    // 多行查询不必各自重扫快照（见 nonRetryableItemKeys）。
    this.nonRetryableTerminationKeys = null;
    const progress = this.plugin.progressStore.state;
    const fullSyncRunning = this.plugin.syncExecutor?.isRunning ?? false;
    // 可取消＝轮在跑，或入口只读准备期已 armed（2026-10-10 R1：那段等待此前
    // 没有任何出口，现在复用现役「取消同步」；弹框/写事务期间不 armed）。
    const canCancel = fullSyncRunning || this.plugin.isSyncEntryCancellable;
    const sideActionRunning = this.plugin.syncExecutor?.hasSideActionsInFlight ?? false;
    const isRunning = isAnySyncActivityRunning(
      progress,
      fullSyncRunning,
      sideActionRunning,
    );
    // 同步入口占用（云端检测/运行前准备，执行器尚未开跑）：与运行中同档呈现，
    // 让「点同步→运行开始」这段空窗不再读成空闲（2026-10-10 拍板；同族事实
    // 与状态栏、Ribbon 同源）。
    const syncEntryInProgress = this.plugin.isSyncEntryInProgress;
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
    // Retained-folder notes are context for the local-only file rows, not
    // tasks: the files inside are already counted one by one, so counting the
    // note too would inflate "需要处理 N" without adding an exit.
    const retainedFolderIssueCount = pendingIssueGroups.filter(({ issue }) =>
      issue.issueCode === "one-way-folder-retained").length;
    const pendingCount = pendingIssueGroups.length - retainedFolderIssueCount
      + conflicts.length
      + pendingDeletes.length + adoptionRows.length
      + this.plugin.getLocalOnlyRows().filter((entry) =>
        !this.plugin.syncExecutor?.isSideActionQueued(entry.targetPath)).length;
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
      if (this.planReviewBaselineRevision === null) {
        // 本视图第一次展示这份审阅：记下基线。之后修订号前进＝这份计划被换过。
        this.planReviewBaselineRevision = syncState.planReviewRevision;
      }
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
    } else if (!planReviewActive) {
      // 审阅结束（确认成功/清空/重置）：基线清零，下一份审阅从流程句重新开始。
      this.planReviewBaselineRevision = null;
    }
    const planReviewRefreshed = isPlanReviewRefreshedSinceShown({
      reviewKind: this.plugin.state?.planReviewAuthorization?.reviewKind,
      currentRevision: syncState?.planReviewRevision ?? 0,
      baselineRevision: this.planReviewBaselineRevision,
    });
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
      syncEntryInProgress,
      canCancel,
      lastSyncTime: syncState?.lastSyncTime ?? 0,
      pendingCount,
      planReviewActive,
      planReviewRevision: syncState?.planReviewRevision ?? 0,
      planReviewDetailsState,
      planReviewRefreshed,
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
      syncEntryInProgress,
      bodyMode,
      progress,
      planReviewActive,
      planReviewDetailsState,
      pendingIssues,
      pendingIssueGroups,
      conflicts,
      pendingDeletes,
      adoptionRows,
      // 片⑦ 修复：与待处理区行同一真源（`renderPendingSection` 也读这里）。
      localOnlyRows: this.plugin.getLocalOnlyRows(),
      planReviewCounts,
      planReviewRevision: syncState?.planReviewRevision ?? 0,
      history: syncState?.syncHistory ?? [],
      lastSyncTime: syncState?.lastSyncTime ?? 0,
      mutationRecovery,
      // 与行渲染同一取值源：提示的出现/消失/版本文案变化都进指纹。
      updatePrompt,
      // S4：逐项终局判定的出现/消失/结局变化都进指纹（同族理由见上）。
      itemTerminationKey: syncItemTerminationSignature(
        this.plugin.syncExecutor?.getSyncItemTerminationSnapshot() ?? [],
      ),
    });

    if (this.lastContentKey !== contentKey) {
      this.renderSyncViewFullRebuild({
        container,
        statusState,
        bodyMode,
        sideActionResultsVisible,
        isRunning,
        progress,
        syncState,
        planReviewCounts,
        planReviewItems,
        planReviewRefreshed,
        conflicts,
        pendingDeletes,
        pendingIssueGroups,
        adoptionRows,
        updatePrompt,
        mutationRecovery,
        preservedContentScrollTop,
        preservedHostScrollTop,
      });
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
    const rows = partitionCompletedProgressRows(files);
    if (rows.action.length > 0) this.appendCompletedActionRows(rows.action);
    if (rows.skipped.length > 0) this.appendProgressSkipRows(rows.skipped);
  }

  private appendCompletedActionRows(files: readonly FileProgress[]): void {
    const panel = this.progressPanelEl;
    if (!panel) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (!this.progressSubtitleEl) {
      this.progressSubtitleEl = panel.createDiv("easy-sync-progress-subtitle");
      this.progressSubtitleEl.setText(
        t("syncView.progress.completed", {
          count: resolveCompletedActionCount(this.plugin.progressStore.state),
        }),
      );
    }
    if (!this.fileListEl || !this.completedFileRowsLedger) {
      // Fallback: no rendered list (or a stale ledger) to diff against.
      this.fileListEl?.remove();
      this.fileListEl = null;
      this.renderFileResults(panel, [...files], true);
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
    this.pinProgressSkipFoldLast();
    this.progressSubtitleEl?.setText(
      t("syncView.progress.completed", {
        count: resolveCompletedActionCount(this.plugin.progressStore.state),
      }),
    );
  }

  /**
   * 按设置跳过的行在运行中也收进一个折叠组（2026-10-25 拍板）：零动作条目
   * 不进计数、不逐行铺开；组标题承载规则与数量，组内只留图标＋路径。
   */
  private appendProgressSkipRows(files: readonly FileProgress[]): void {
    const panel = this.progressPanelEl;
    if (!panel) return;
    if (
      !this.progressSkipGroupEl
      || !this.progressSkipListEl
      || !this.progressSkipTitleEl
      || !this.progressSkipRowsLedger
    ) {
      const fold = this.createSkipFold(panel, files);
      this.progressSkipGroupEl = fold.group;
      this.progressSkipListEl = fold.list;
      this.progressSkipTitleEl = fold.title;
      this.progressSkipRowsLedger = fold.ledger;
      this.pinProgressSkipFoldLast();
      return;
    }
    const diff = diffCompletedFileRows(this.progressSkipRowsLedger, files);
    this.progressSkipRowsLedger = diff.nextLedger;
    if (diff.removePaths.length > 0) {
      const removeSet = new Set(diff.removePaths);
      for (const row of Array.from(this.progressSkipListEl.children)) {
        if (!row.instanceOf(HTMLElement)) continue;
        const path = row.dataset.easySyncCompletedPath;
        if (path && removeSet.has(path)) row.remove();
      }
    }
    for (let i = diff.prepend.length - 1; i >= 0; i--) {
      this.appendSkipFoldRow(this.progressSkipListEl, diff.prepend[i], true);
    }
    this.progressSkipTitleEl.setText(
      this.plugin.i18n.t("syncView.skipGroup.title", {
        count: diff.nextLedger.size,
      }),
    );
  }

  /** 折叠组恒排在动作列表之后：冲突／删除行在跳过项之后结算，列表可能是
   *  后补的，必须把组重新压到面板末尾。 */
  private pinProgressSkipFoldLast(): void {
    if (this.progressSkipGroupEl && this.progressPanelEl) {
      this.progressPanelEl.appendChild(this.progressSkipGroupEl);
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
      // 同步入口占用同样落到运行档：canCancel 仍为假（检测/准备不可取消），
      // 于是拿到现役的禁用「处理中…」，而不是一颗点了只弹 busy 的「立即同步」。
      isRunning: state.isRunning || state.syncEntryInProgress,
      canCancel: state.canCancel,
      planReviewActive: state.planReviewActive,
      planReviewDetailsState: state.planReviewDetailsState,
      reviewKind: this.plugin.state?.planReviewAuthorization?.reviewKind,
      recoveryActionKey,
      isInitializing: state.isInitializing,
      isPending: state.isPending,
      devicePending: (this.plugin.auth?.deviceAttempt ?? null) !== null,
    });
    this.renderStatusPanelPrimaryAction({
      action,
      actions,
      state,
      t,
    });
  }

  /**
   * Render the status panel's fixed primary action button for the resolved
   * action kind.
   *
   * Contract: `actions` is the live container element the button is appended
   * into (threaded by reference, never cloned); `t` is the plugin-bound
   * translator; `action` and `state` are read-only inputs. The phase neither
   * reassigns a host binding nor terminates the host, so it returns void.
   */
  private renderStatusPanelPrimaryAction(args: {
    action: SyncViewPrimaryActionKind;
    actions: ReturnType<HTMLElement["createDiv"]>;
    state: StatusPanelState;
    t: EasySyncPlugin["i18n"]["t"];
  }): void {
    const { action, actions, state, t } = args;
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
          reason: describeError(error),
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
    const timestampText = timestamp > 0
      ? new Date(timestamp).toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
      : "";
    // 片⑦ E1：常驻标识只属静止的时间戳态（current-file／recovery 两个分支已
    // 提前返回）；纯文本，不新增槽位与控件。
    const detailText = resolveSyncViewStatusDetailText({
      timestampText,
      oneWay: this.plugin.syncDirection === "one-way",
      oneWayIndicator: t("syncView.status.mode.oneway"),
    });
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
    syncEntryInProgress: boolean;
    lastSyncTime: number;
    pendingCount: number;
    planReviewActive: boolean;
    planReviewRefreshed: boolean;
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
      syncing: state.isRunning || state.syncEntryInProgress,
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
          // 计划在展示期间被重新生成过：同一槽位改说既有的「已更新」句
          // （弹框标题逐字复用，不新增文案）。
          return {
            status,
            label: t(state.planReviewRefreshed
              ? "syncPlan.reviewUpdatedTitle"
              : "syncPlan.sectionTitle"),
          };
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
    // The recovery-failure section is mounted by render() directly under the
    // view content. Keeping it inside this panel stacked two `border-top`
    // rules with only the panel padding between them (visible as a double
    // divider above the section), so this panel now owns progress content
    // only and is skipped entirely when there is none.
    if (state.total <= 0 && state.completedFiles.length === 0) return;
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
      const rows = partitionCompletedProgressRows(state.completedFiles);
      // 「已完成」只算真实动作。按设置跳过是零动作，单独进下方折叠组，
      // 否则标题数会远大于列表里可见的行（2026-10-25 拍板）。
      if (rows.action.length > 0) {
        this.progressSubtitleEl = panel.createDiv("easy-sync-progress-subtitle");
        this.progressSubtitleEl.setText(
          t("syncView.progress.completed", {
            count: resolveCompletedActionCount(state),
          }),
        );
        this.renderFileResults(panel, rows.action, true);
      }
      if (rows.skipped.length > 0) {
        const fold = this.createSkipFold(panel, rows.skipped);
        this.progressSkipGroupEl = fold.group;
        this.progressSkipListEl = fold.list;
        this.progressSkipTitleEl = fold.title;
        this.progressSkipRowsLedger = fold.ledger;
      }
    }
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
      // S4 终止判据（2026-10-16 §六 S4）：这条记录连续两轮事实完全相同、且
      // 没有现役人工出口时，正文的「暂时无法自动确认」不再成立，换成一句终局
      // 诊断（同一事实指纹下结论不变，不会每轮换说法）。判定只读 executor 的
      // 逐项台账，本处不重推任何资格规则。
      {
        nonRetryable: typeof state.blockedOperationId === "string"
          && this.nonRetryableItemKeys()
            .has(mutationRecoveryItemKey(state.blockedOperationId)),
      },
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

  /**
   * S4: keys of the items whose terminal outcome is an explicit non-retryable
   * diagnosis (the executor's per-item fact ledger), sampled once per render
   * tick. Presentation-only read: it decides which single terminal line a row
   * or the recovery section shows, and never a sync decision.
   */
  private nonRetryableItemKeys(): ReadonlySet<string> {
    if (this.nonRetryableTerminationKeys === null) {
      this.nonRetryableTerminationKeys = new Set(
        (this.plugin.syncExecutor?.getSyncItemTerminationSnapshot() ?? [])
          .filter((verdict) => verdict.outcome === "non-retryable")
          .map((verdict) => verdict.key),
      );
    }
    return this.nonRetryableTerminationKeys;
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
    const retainedFolders = issueGroups.filter(({ issue }) =>
      issue.issueCode === "one-way-folder-retained");
    const skipped = issueGroups.filter(({ issue }) =>
      issue.issueCode !== "one-way-folder-retained"
      && (
        issue.actionType === SyncActionType.SkipLargeFile
        || issue.actionType === SyncActionType.SkipIgnoredPath
        || issue.actionType === SyncActionType.SkipOneDriveInvalidName
      ));
    const failures = issueGroups.filter(({ issue }) =>
      issue.issueCode !== "one-way-folder-retained"
      && issue.actionType !== SyncActionType.SkipLargeFile
      && issue.actionType !== SyncActionType.SkipIgnoredPath
      && issue.actionType !== SyncActionType.SkipOneDriveInvalidName);
    const configDir = getConfigDir(this.plugin.app.vault);
    const rows = buildSyncPendingDisplayRows({
      adoptionRows,
      failures,
      conflictEntries: groupBundleConflictReviews(conflicts, configDir),
      pendingDeletes,
      skipped,
      localOnlyRows: this.plugin.getLocalOnlyRows().filter((entry) =>
        !this.plugin.syncExecutor?.isSideActionQueued(entry.targetPath)),
      retainedFolders,
      configDir,
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
    // 成批的待确认删除与成批的本机独有条目（各≥2 条，与各自的批量入口同一
    // 条件）逐条默认收起：批量入口就是这一屏的出口。
    const deleteRowsBatched = isBatchedDeleteSet(rows.map((row) => row.key));
    const localOnlyRowsBatched = isBatchedLocalOnlySet(
      rows.map((row) => row.key),
    );
    this.renderedBatchedRows = { deleteRowsBatched, localOnlyRowsBatched };

    const resolveOffsets = (): number[] => {
      if (virtualOffsets && offsetsRevision === this.planRowLayoutRevision) {
        return virtualOffsets;
      }
      const probe = this.measurePlanDecisionRowHeights(section);
      virtualOffsets = buildSyncPlanMeasuredVirtualOffsets(
        rows.map((row) =>
          this.planRowHeights.get(row.key)
          ?? (this.resolvePlanRowOpen(row.key, this.renderedBatchedRows)
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
      this.applyPlanRowExpansionIn(visible, this.renderedBatchedRows);
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
      case "batchConflict":
        if (row.conflicts) {
          this.renderBatchConflictRow(
            container,
            row.conflicts,
            row.conflictBatchExcluded ?? 0,
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
      case "batchLocalOnly":
        if (row.localOnlyBatch) {
          this.renderBatchLocalOnlyRow(container, row.localOnlyBatch);
        }
        return;
      case "localOnly":
        if (row.localOnly) {
          this.renderLocalOnlyItem(container, row.localOnly, row.key);
        }
        return;
      case "retainedFolder":
        if (row.issue) {
          this.renderRetainedFolderRow(container, row.issue, row.key);
        }
        return;
    }
  }

  /**
   * One-way retained folder note: a cloud-deleted folder stays because local
   * content still occupies it. Read-only by design — no button, no decision,
   * no hover/click affordance; the actionable exits stay on the local-only
   * file rows below it.
   */
  private renderRetainedFolderRow(
    container: HTMLElement,
    issue: PendingIssue,
    rowKey?: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const rowEl = container.createDiv("easy-sync-retained-folder-row");
    if (rowKey) rowEl.dataset.easySyncPlanRow = rowKey;
    const header = rowEl.createDiv("easy-sync-retained-folder-header");
    const icon = header.createSpan("easy-sync-tree-status-icon");
    // Same icon and chip as every other FolderDeferred row: retained is a
    // not-synced state, not a new decision category.
    setIcon(icon, "folder-clock");
    header.createSpan("easy-sync-tree-path").setText(issue.path);
    const chipLabel = formatPendingIssueChipLabel(issue, t);
    if (chipLabel) {
      header.createSpan("easy-sync-tree-chip").setText(chipLabel);
    }
    rowEl.createDiv("easy-sync-item-reason").setText(
      issue.reason ?? t("reason.oneWay.folderRetained"),
    );
  }

  /**
   * 片④ 单向模式的本机独有条目：行主体只承担识别与展开（不是按钮），来源
   * chip 只做识别，唯一出口「上传到云端」在展开区。上传成功由执行器退场条目，
   * 侧栏随之少一行。
   */
  private renderLocalOnlyItem(
    container: HTMLElement,
    entry: LocalOnlyEntryRowV1,
    rowKey?: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const details = container.createEl("details", "easy-sync-tree-item");
    if (rowKey) details.dataset.easySyncPlanRow = rowKey;
    const summary = details.createEl("summary", "easy-sync-tree-row");
    this.addCollapseIcon(summary);
    const icon = summary.createSpan("easy-sync-tree-status-icon");
    setIcon(icon, "arrow-up");
    const pathEl = summary.createSpan("easy-sync-tree-path");
    // 行主体显示要操作的那份文件：改动类＝副本路径（上传目标同一路径），
    // 新建类＝文件自身。chip／两个动作／行 key／忽略键一律不变。
    configureFilePath(details, pathEl, entry.targetPath, true);
    summary.createSpan("easy-sync-tree-chip").setText(
      entry.kind === "edited"
        ? t("syncView.localOnly.chip.edited")
        : t("syncView.localOnly.chip.created"),
    );

    const body = details.createDiv("easy-sync-tree-item-body");
    // 说明句只有改动类有（2026-10-12 文案定稿）：新建类的身份由 chip 承担，
    // 处境由列表级（批量行／审阅句）说一次，行内不重复。
    if (entry.kind === "edited") {
      body.createDiv("easy-sync-item-reason").setText(
        t("syncView.localOnly.reason.edited"),
      );
    }
    const actions = body.createDiv("easy-sync-item-actions");
    // 主次判据（同族先例：采纳行「下载并同步」＝accent／「跳过」＝""，删除行
    // 「确认删除」＝warning／「拒绝」＝""）：上传是这一行的主动作，上强调色；
    // 「留在本机，不再提醒」是次动作，保持中性。
    this.createActionChip(
      actions,
      t("syncView.localOnly.upload"),
      "accent",
      () => {
        void this.runItemAction(
          actions,
          () => this.plugin.uploadLocalOnlyEntry(entry.targetPath),
        );
      },
    );
    // 片⑤：留在本机、不再提醒。点击即写入忽略记忆并刷新（行消失即反馈，
    // 不加 Notice）。逐条反悔入口未建：设置页整体清空是现役唯一出口
    // （`tests/sync-view.test.ts` 钉住侧栏不得引用移除 API）。
    this.createActionChip(
      actions,
      t("syncView.localOnly.keep"),
      "",
      () => {
        void this.runItemAction(
          actions,
          () => this.plugin.ignoreLocalOnlyEntry(entry.targetPath),
        );
      },
    );

  }

  /**
   * 批量处置行（三件优化·件②）：≥2 条本机独有条目时出现在这一族的顶部，两个
   * 动作＝逐条行两个动作的并集（两类可用动作完全相同）：上传全部走现役上行链
   * （确认后逐条成功不弹提示，照批量删除先例），全部留在本机＝一次写忽略记忆
   * （零云端写入、零文件改动、不加确认，行消失即反馈）。逐条行的 chip／原因句／
   * 动作／忽略键都不变——这一行只是同一屏多出来的出口。
   */
  private renderBatchLocalOnlyRow(
    container: HTMLElement,
    entries: readonly LocalOnlyEntryRowV1[],
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const rowEl = container.createDiv();
    rowEl.dataset.easySyncPlanRow = "batch-localOnly";
    rowEl.createDiv("easy-sync-item-reason").setText(
      t("syncView.localOnly.batchNote", { count: entries.length }),
    );
    const actions = rowEl.createDiv(
      "easy-sync-plan-execute easy-sync-local-only-batch-actions",
    );
    // 忽略键＝行代表的上传目标路径（与逐条行、side action 同一把键）。
    const targetPaths = entries.map((entry) => entry.targetPath);
    // 主次照逐条行：上传＝强调色，留在本机＝中性。
    const uploadAllButton = new ButtonComponent(actions);
    uploadAllButton
      .setButtonText(t("syncView.localOnly.batchUploadAll"))
      .setCta()
      .onClick(() => {
        void this.runItemAction(actions, async () => {
          const confirmed = await new ConfirmModal(
            this.plugin.app,
            t("syncView.localOnly.batchConfirmTitle", {
              count: targetPaths.length,
            }),
            t("syncView.localOnly.batchConfirmUpload"),
            t("confirm.cancel"),
            t,
            {
              message: t("syncView.localOnly.batchConfirmMessage"),
            },
          ).awaitConfirm();
          if (!confirmed) return;
          // 照批量删除：确认后立刻进官方加载态，整批执行期间保持旋转与禁用。
          uploadAllButton.buttonEl.addClass("mod-loading");
          uploadAllButton.setDisabled(true);
          await this.plugin.uploadLocalOnlyEntries(targetPaths);
        });
      });
    new ButtonComponent(actions)
      .setButtonText(t("syncView.localOnly.batchKeepAll"))
      .onClick(() => {
        void this.runItemAction(
          actions,
          () => this.plugin.ignoreLocalOnlyEntries(targetPaths),
        );
      });
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
    const chipLabel = formatPendingIssueChipLabel(issue, t);
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
    // S4 终止判据（2026-10-16 §六 S4）：这一项连续两轮事实完全相同、且没有
    // 现役人工出口时，行内只补一句终局诊断——同一事实指纹下结论不变，不会
    // 每轮换一个说法；判定来自 executor 的逐项指纹台账（本处只读）。有真实
    // 出口的项不会走到这里（它们由下面的 chip 承接「一次裁决」）。
    if (this.nonRetryableItemKeys().has(pendingIssueTerminationKey(issue))) {
      body.createDiv("easy-sync-item-reason").setText(
        t("syncView.itemTermination.nonRetryable"),
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
      this.renderPendingIssueRetryableActions({
        actions,
        issue,
        scopeCrossingExitKind,
        t,
      });
    }
  }

  /**
   * Render the retryable action chips for one pending issue row.
   *
   * Contract: `actions` is the live action container the chips are appended
   * into (threaded by reference, never cloned); `t` is the plugin-bound
   * translator; `issue` and `scopeCrossingExitKind` are read-only inputs. Every
   * branch appends its chip and returns; the caller has no statements after the
   * call, so an early return here ends the row render exactly as the inline
   * block did, and the phase returns void.
   *
   * The handled code lists live in `pendingIssueExitKind` (single source of
   * truth): the S4 termination verdict derives "this row has a live manual
   * exit" from the same call, so a row can never be diagnosed as having no
   * disposition while a chip for it is on screen.
   */
  private renderPendingIssueRetryableActions(args: {
    actions: ReturnType<HTMLElement["createDiv"]>;
    issue: PendingIssue;
    scopeCrossingExitKind: ReturnType<
      NonNullable<EasySyncPlugin["state"]>["getScopeCrossingExitKind"]
    >;
    t: EasySyncPlugin["i18n"]["t"];
  }): void {
    const { actions, issue, scopeCrossingExitKind, t } = args;
    const exitKind: PendingIssueExitKind | null = pendingIssueExitKind(
      issue.issueCode,
      scopeCrossingExitKind,
    );
    switch (exitKind) {
      case "stale-identity":
        this.createActionChip(
          actions,
          t("syncView.staleIdentity.resolve"),
          "accent",
          () => {
            void this.openStaleIdentityResolution(issue.path);
          },
        );
        return;
      case "shared-folder-identity":
        this.createActionChip(
          actions,
          t("syncView.sharedFolderIdentity.resolve"),
          "accent",
          () => {
            void this.openSharedFolderIdentityResolution(issue.path);
          },
        );
        return;
      case "empty-folder-review":
        this.createActionChip(
          actions,
          t("syncView.folderSubtree.review"),
          "accent",
          () => {
            void this.openEmptyFolderResolution(issue.path);
          },
        );
        return;
      case "folder-location":
        this.createActionChip(
          actions,
          t("syncView.folderLocation.resolve"),
          "accent",
          () => {
            void this.openFolderLocationResolution(issue.path);
          },
        );
        return;
      case "scope-crossing":
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
      case null:
        // 通用重试 chip 不再渲染（2026-09-16 按钮清理）：其余可重试问题行
        // 的行内重试与顶部主动作完全等同（同一完整手动同步入口），轮运行
        // 中点击也仅得 busy 提示——重试统一经顶部「立即同步」；延后类行
        // 由自动轮次收敛。行内保留原因文案与可选「打开文件」。
        return;
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
            await this.plugin.deleteReviewedFolderSubtree(subtree);
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
      // 删除是单一破坏性确认：第一层弹框的红键即最终授权，删前核对与版本门
      // 由执行链独立承担（2026-09-29 用户拍板撤第二道确认）。
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
    // keep-remote on a missing remote deletes the local copy; keep-local on a
    // missing local deletes the cloud copy (2026-10-25). Naming the side that
    // disappears keeps the question and the consequence in one sentence.
    const deletesLocal = choice === "keep-remote";
    const bundle = snapshot.bundleReview;
    const title = bundle
      ? t("syncView.mutationResolution.deleteConfirmTitle")
      : t(deletesLocal
        ? "syncView.mutationResolution.deleteConfirmTitleLocal"
        : "syncView.mutationResolution.deleteConfirmTitleRemote");
    const message = bundle
      ? t("syncView.mutationResolution.deleteConfirmMessage", {
          path: bundle.displayName ?? bundle.pluginId ?? snapshot.path,
          // Quote the label the bundle buttons actually show.
          choice: t(choice === "keep-local"
            ? "syncView.conflict.keepLocal"
            : "syncView.conflict.keepRemote"),
        })
      : t(deletesLocal
        ? "syncView.mutationResolution.deleteConfirmMessageLocal"
        : "syncView.mutationResolution.deleteConfirmMessageRemote", {
          path: snapshot.path,
          size: formatFileSize(
            (deletesLocal ? snapshot.local[0]?.size : snapshot.remote[0]?.size)
              ?? 0,
          ),
        });
    return new ConfirmModal(
      this.plugin.app,
      title,
      t("syncView.mutationResolution.deleteConfirm"),
      t("confirm.cancel"),
      t,
      {
        message,
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
            // 懒建的正文不在首帧渲染里，补一次同一任务内的路径摘取，
            // 否则展开后要等下一次 resize／toggle 才出现灰字目录。
            this.scheduleAdaptivePathLayout();
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
      // 增量呈现（2026-09-16 方案单 §十二）：按设置跳过（超大小）的行归入折叠
      // 组，与运行中共用同一个折叠件；组标题承载性质（设置名），组内行＝图标＋
      // 路径。历史每轮都能展开——行既有当轮发行的，也有从 `skipPaths` 保留的稳定
      // 集合（2026-10-25 追加拍板：运行列表仍只报新面孔，历史不再丢清单）。
      // 其余行（含上传/下载/非法文件名）照旧逐行。
      if (entry.files.length > 0) {
        const rows = partitionCompletedProgressRows(entry.files);
        if (rows.action.length > 0) {
          // 2026-10-25 用户确认：历史普通文件行也接现役灰字目录（此前"历史
          // 不挂"只是实现现状被追认成约定，不是用户拍板）。高度不设限，行
          // 仍按内容自然展开。
          this.renderFileResults(body, rows.action, false, true);
        }
      }
      const skip = collectHistorySkipRows({
        files: entry.files,
        skipPaths: entry.skipPaths,
        total: entry.skippedLarge,
      });
      if (skip.rows.length > 0) {
        this.createSkipFold(body, skip.rows, skip.total);
      }
      if (skip.omitted > 0) {
        body.createDiv("easy-sync-history-omitted").setText(
          t("syncView.history.skipOmitted", { count: skip.omitted }),
        );
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
    adaptive = limitHeight,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const list = container.createDiv("easy-sync-file-list");
    const renderedPaths = new Set<string>();
    const ledger = new Map<string, string>();
    if (adaptive) list.addClass("easy-sync-path-layout");
    if (limitHeight) {
      list.addClass("is-limited");
      this.fileListEl = list;
    }

    // Iterate in reverse (newest first)
    for (let i = files.length - 1; i >= 0; i--) {
      if (limitHeight && renderedPaths.has(files[i].path)) continue;
      renderedPaths.add(files[i].path);
      renderFileRow(files[i], list, t, adaptive);
      if (limitHeight) ledger.set(files[i].path, completedFileRowKey(files[i]));
    }
    if (limitHeight) this.completedFileRowsLedger = ledger;
  }

  /**
   * 按设置跳过（超大小／忽略路径）的折叠组：运行中的完成列表与历史条目共用
   * 同一个折叠件（2026-10-25 拍板）。组标题＝设置名＋数量，组内行只留图标＋
   * 路径；视觉家族沿用 `.easy-sync-history-skip-*`，两个载体渲染一致。
   * 组内列表是独立的 `easy-sync-path-layout` 测量范围（2026-10-25 用户真机
   * 反馈：长路径要复用现役灰字目录摘取）——不与组外行共享，避免跨组摘取。
   */
  private createSkipFold(
    container: HTMLElement,
    rows: readonly FileProgress[],
    titleCount?: number,
  ): {
    group: HTMLElement;
    list: HTMLElement;
    title: HTMLElement;
    ledger: Map<string, string>;
  } {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const group = container.createEl(
      "details",
      "easy-sync-history-skip-group easy-sync-tree-item",
    );
    const summary = group.createEl(
      "summary",
      "easy-sync-history-skip-summary easy-sync-tree-row",
    );
    this.addCollapseIcon(summary);
    const title = summary.createSpan("easy-sync-history-skip-title");
    const list = group.createDiv(
      "easy-sync-file-list easy-sync-path-layout",
    );
    // 与动作列表同一套行身份／去重口径：同路径后完成的覆盖先前的。
    const diff = diffCompletedFileRows(new Map(), rows);
    for (const file of diff.prepend) {
      this.appendSkipFoldRow(list, file, false);
    }
    title.setText(
      t("syncView.skipGroup.title", {
        count: titleCount ?? diff.nextLedger.size,
      }),
    );
    return { group, list, title, ledger: diff.nextLedger };
  }

  /** 折叠组里的一行：图标＋路径；数量与理由句归组标题。 */
  private appendSkipFoldRow(
    list: HTMLElement,
    file: FileProgress,
    prepend: boolean,
  ): HTMLElement {
    const row = list.createDiv("easy-sync-file-row");
    row.dataset.easySyncCompletedPath = file.path;
    const icon = row.createSpan("easy-sync-file-icon");
    setIcon(icon, resolveFileProgressPresentation(file).icon);
    const pathEl = row.createSpan("easy-sync-file-path");
    configureFilePath(row, pathEl, file.path, true);
    if (prepend) list.prepend(row);
    return row;
  }

  /**
   * 件① 单向模式的审阅告知句（三种组合：只一类命中时报一类，两类都命中时报
   * 并集句）。计数来源见 `renderPlanReviewSection` 的注释；没有本机独有内容时
   * 返回 null（双向模式恒 null）。
   */
  private buildOneWayReviewNote(
    counts: { localOnlyCopies?: number } | null,
  ): string | null {
    if (this.plugin.syncDirection !== "one-way") return null;
    const copies = counts?.localOnlyCopies ?? 0;
    const localOnly = this.plugin
      .getLocalOnlyRows()
      .filter((row) => row.kind === "created").length;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (copies <= 0 && localOnly <= 0) return null;
    if (copies <= 0) return t("syncPlan.oneWayNote.localOnly", { localOnly });
    if (localOnly <= 0) return t("syncPlan.oneWayNote.copies", { copies });
    return t("syncPlan.oneWayNote.both", { localOnly, copies });
  }

  private renderPlanReviewSection(
    container: HTMLElement,
    counts: { uploads: number; downloads: number; folders?: number; deletes: number; conflicts: number; skipped: number; localOnlyCopies?: number } | null,
    items: PlanReviewItem[],
    conflicts: SyncPlanItem[],
    pendingDeletes: SyncPlanItem[],
    planReviewRefreshed: boolean,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const panel = this.createSection(container, t("syncPlan.sectionTitle"));
    const activationReviewKind =
      this.plugin.state?.planReviewAuthorization?.reviewKind;
    const hasDecisionRows = items.some((item) =>
      item.type === SyncActionType.Conflict
      || item.type === SyncActionType.ConfirmLocalDelete);
    // 件① 事前告知：单向模式下的本机独有内容数量。两个计数都是冻结事实——
    // 「会另存为副本」数取自随计划封存的审阅计数（localOnlyCopies），「只在本机」
    // 数取自面板同源的那份记录族（忽略记忆已过滤，所以报的就是接下来会列出的行
    // 数）。两类都为 0 时不出现这句话（双向模式恒不出现）。
    const oneWayNote = this.buildOneWayReviewNote(counts);
    const oneWaySuffix = oneWayNote ? ` ${oneWayNote}` : "";
    const renderSummaryLine = (base: string): void => {
      // One slot, two roles: the flow line states what confirming does; the
      // decision note is appended only when the plan actually carries decision
      // rows. Activation reviews defer those rows to after the run (they are
      // read-only here); ordinary plans decide them inline right now — each
      // sentence must say the timing its rows really have.
      const decisionNote = hasDecisionRows
        ? ` ${t("syncPlan.activationDecisionSummary")}`
        : "";
      panel.createDiv("setting-item-description").setText(
        `${base}${oneWaySuffix}${decisionNote}`,
      );
    };

    if (planReviewRefreshed) {
      // 计划在展示期间被重新生成：同一个说明槽位改说既有的「已更新」句
      // （弹框正文逐字复用，不新增文案）。与下方流程句分支互斥，仍是单块。
      panel.createDiv("setting-item-description").setText(
        `${t("syncPlan.reviewUpdatedMessage")}${oneWaySuffix}`,
      );
    } else if (activationReviewKind === "v2-migration") {
      renderSummaryLine(t("syncPlan.migrationSummary"));
    } else if (activationReviewKind === "v2-cloud-join") {
      renderSummaryLine(t("syncPlan.cloudJoinSummary"));
    } else if (activationReviewKind === "v2-first-sync") {
      renderSummaryLine(t("syncPlan.firstSyncSummary"));
    } else if (activationReviewKind === "v2-rs-adoption") {
      renderSummaryLine(t("syncPlan.rsAdoptionSummary"));
    } else if (items.some(
      (item) => item.type === SyncActionType.RecreateRemoteScope,
    )) {
      renderSummaryLine(t("syncPlan.remoteScopeRecreateSummary"));
    } else if (
      // Ordinary plans only: the note states the confirm button's boundary
      // and the decision rows' own timing — they are decidable inline now.
      hasDecisionRows
    ) {
      panel.createDiv("setting-item-description").setText(
        `${t("syncPlan.confirmBoundarySummary")}${oneWaySuffix}`,
      );
    } else if (oneWayNote) {
      // 上面各分支都没占这个槽位（普通审阅里既没有决策行、也没有激活类流程句）：
      // 告知句自己占它——否则这一屏对"有多少本机内容不会被上传"一个字都不说。
      panel.createDiv("setting-item-description").setText(oneWayNote);
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
      // 全 0 时不渲染（零文案、零结构变化）：单向模式下"只有本机独有内容"
      // 会走到这里，否则会留下一个空的计数行。
      const present = rows.filter(([, count]) => count > 0);
      if (present.length > 0) {
        panel.createDiv("easy-sync-plan-counts").setText(
          present.map(([label, count]) => `${label} ${count}`).join(" · "),
        );
      }
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
    // 收起，出口是那一组行本身或批量入口，不是每行的展开区。本机独有行不在这份
    // 分组里（它们在待处理区），这一屏按"未成批"记账。
    const deleteRowsBatched = isBatchedDeleteSet(
      items
        .filter((item) => item.type === SyncActionType.ConfirmLocalDelete
          && deleteByPath.has(item.path))
        .map((item) => `delete:${item.path}`),
    );
    this.renderedBatchedRows = {
      deleteRowsBatched,
      localOnlyRowsBatched: false,
    };

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
              ?? (this.resolvePlanRowOpen(row.key, this.renderedBatchedRows)
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
        this.applyPlanRowExpansionIn(visible, this.renderedBatchedRows);
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
   *  类别默认里依赖区域事实的两类（成批的待确认删除、成批的本机独有条目）
   *  由 `batchedRows` 带进来。 */
  private resolvePlanRowOpen(
    rowKey: string,
    batchedRows: {
      deleteRowsBatched: boolean;
      localOnlyRowsBatched: boolean;
    },
  ): boolean {
    const remembered = this.planRowExpandedState.get(rowKey);
    if (remembered !== undefined) return remembered;
    if (this.sessionOverride === "expanded") return true;
    if (this.sessionOverride === "collapsed") return false;
    return resolveDecisionRowDefaultOpen(rowKey, batchedRows);
  }

  /** Re-apply the remembered open state to every mounted decision row. */
  private applyPlanRowExpansion(): void {
    this.applyPlanRowExpansionIn(this.contentEl, this.renderedBatchedRows);
  }

  /**
   * The same rule, scoped to one subtree. A window shift remounts rows, so the
   * mount has to restore their state before any height is measured — otherwise
   * a scrolled-in row comes back collapsed while the offset model still holds
   * its expanded height.
   */
  private applyPlanRowExpansionIn(
    root: ParentNode,
    batchedRows: {
      deleteRowsBatched: boolean;
      localOnlyRowsBatched: boolean;
    },
  ): void {
    const rows = root.querySelectorAll<HTMLElement>("[data-easy-sync-plan-row]");
    for (const row of Array.from(rows)) {
      const key = row.dataset.easySyncPlanRow;
      if (!key || !row.instanceOf(HTMLDetailsElement)) continue;
      row.open = this.resolvePlanRowOpen(key, batchedRows);
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

  /**
   * 冲突批量处置行：≥2 条可批量的普通文件冲突时出现在冲突族顶部。两个方向都先
   * 过确认弹框；插件目录整棵与 Obsidian 受管设置不在这一行覆盖范围内，逐条行
   * 保持原出口。批量在飞时按方向恢复加载态，避免侧栏整屏重建后按钮又变可点。
   */
  private renderBatchConflictRow(
    container: HTMLElement,
    conflicts: readonly SyncPlanItem[],
    excludedCount: number,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const rowEl = container.createDiv();
    rowEl.dataset.easySyncPlanRow = "batch-conflict";
    rowEl.createDiv("easy-sync-item-reason").setText(
      t("syncView.conflict.batchNote", { count: conflicts.length }),
    );
    if (excludedCount > 0) {
      rowEl.createDiv("easy-sync-item-reason").setText(
        t("syncView.conflict.batchExcludedNote", { count: excludedCount }),
      );
    }
    const actions = rowEl.createDiv(
      "easy-sync-plan-execute easy-sync-local-only-batch-actions",
    );
    const paths = conflicts.map((item) => item.path);
    const batchState = this.plugin.conflictBatchState;
    // 入口两颗按钮同色（中性）：批量行只是对等入口，危险色留给确认弹框。
    const keepLocalButton = new ButtonComponent(actions);
    keepLocalButton
      .setButtonText(t("syncView.conflict.batchKeepLocal"))
      .onClick(() => {
        void this.runItemAction(actions, async () => {
          const confirmed = await new ConfirmModal(
            this.plugin.app,
            t("syncView.conflict.batchKeepLocalTitle", {
              count: paths.length,
            }),
            t("syncView.conflict.batchKeepLocal"),
            t("confirm.cancel"),
            t,
            {
              message: t("syncView.conflict.batchKeepLocalMessage"),
              danger: true,
            },
          ).awaitConfirm();
          if (!confirmed) return;
          keepLocalButton.buttonEl.addClass("mod-loading");
          keepLocalButton.setDisabled(true);
          await this.plugin.resolveConflictsKeepLocal(paths);
        });
      });
    const keepRemoteButton = new ButtonComponent(actions);
    keepRemoteButton
      .setButtonText(t("syncView.conflict.batchKeepRemote"))
      .onClick(() => {
        void this.runItemAction(actions, async () => {
          const confirmed = await new ConfirmModal(
            this.plugin.app,
            t("syncView.conflict.batchKeepRemoteTitle", {
              count: paths.length,
            }),
            t("syncView.conflict.batchKeepRemote"),
            t("confirm.cancel"),
            t,
            {
              message: t("syncView.conflict.batchKeepRemoteMessage"),
              danger: true,
            },
          ).awaitConfirm();
          if (!confirmed) return;
          keepRemoteButton.buttonEl.addClass("mod-loading");
          keepRemoteButton.setDisabled(true);
          await this.plugin.resolveConflictsKeepRemote(paths);
        });
      });
    // 重挂恢复加载态：批量在飞时侧栏可能因进度整屏重建；按方向恢复旋转与禁用。
    if (batchState === "local") {
      keepLocalButton.buttonEl.addClass("mod-loading");
      keepLocalButton.setDisabled(true);
      keepRemoteButton.setDisabled(true);
    } else if (batchState === "remote") {
      keepRemoteButton.buttonEl.addClass("mod-loading");
      keepRemoteButton.setDisabled(true);
      keepLocalButton.setDisabled(true);
    }
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
