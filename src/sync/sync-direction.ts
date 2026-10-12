/**
 * Sync direction (two-way / one-way) and the one-way plan guard.
 *
 * One-way mode ("单向同步" / 仅接收) never writes user content to the cloud: the
 * canonical plan drops every cloud-bound user-content action before decision
 * tokens and the review threshold are computed. The three blocks excluded from
 * one-way mode (managed config whitelist, community plugins, the EasySync
 * bundle itself) keep their two-way behavior, so the path recognition here
 * reuses exactly the recognizers the `protect*Plan` chain already applies.
 *
 * Hard constraint (实施单 §三-10): the predicate below is called from the plan
 * production chain only (`finalizeCanonicalPlanCandidateV2`). The recognizers it
 * composes are shared with the side-action chain, so a direction check must
 * never be pushed into them — user-initiated writes stay authorized by the user
 * in both directions.
 */

import {
  getEasySyncPaths,
  isEasySyncSelfSyncFilePath,
} from "../obsidian-compat";
import { classifyCommunityPluginManagedPath } from "./community-plugin-deletion-boundary";
import { normalizePluginIds } from "./community-plugin-sync-policy";
import {
  isObsidianConfigWhitelistDirectoryPath,
  isObsidianManagedConfigPath,
} from "./file-decision-planner-v2";
import {
  SyncActionType,
  type LocalOnlyCopyKindV1,
  type SyncPlanItem,
} from "./types";

export type SyncDirection = "two-way" | "one-way";

export const DEFAULT_SYNC_DIRECTION: SyncDirection = "two-way";

/** Cloud-bound user-content actions; the one-way plan drops exactly these. */
const OUTBOUND_USER_CONTENT_ACTIONS: ReadonlySet<SyncActionType> = new Set([
  SyncActionType.Upload,
  SyncActionType.DeleteRemote,
  SyncActionType.RenameRemote,
  SyncActionType.CreateRemoteFolder,
  SyncActionType.MoveRemoteFolder,
  SyncActionType.DeleteRemoteFolder,
]);

/** Read the persisted direction; anything but the one-way literal is two-way. */
export function readSyncDirection(value: unknown): SyncDirection {
  return value === "one-way" ? "one-way" : DEFAULT_SYNC_DIRECTION;
}

export function isOutboundUserContentAction(type: SyncActionType): boolean {
  return OUTBOUND_USER_CONTENT_ACTIONS.has(type);
}

/**
 * True when one path belongs to one of the blocks excluded from one-way mode
 * (DECISIONS 2026-10-11：首版只同步笔记与附件，配置／插件／自身构筑物照常双向).
 *
 * The member surface follows the sync-scope function matrix
 * (`docs/topics/同步范围边界.md`): the managed config files, the config
 * whitelist *directories* (`<configDir>/themes/`、`<configDir>/snippets/` —
 * the 「主题与代码片段」row, 2026-10-12 review), community plugins and the
 * EasySync bundle. Community-plugin recognition reuses the same classifier as
 * `protectCommunityPluginPlan`; the subtree branch covers folder targets whose
 * own id is the running plugin's (the classifier intentionally excludes the
 * own plugin id).
 */
export function isExcludedFromOneWaySyncPath(
  path: string,
  configDir: string,
  pluginId = "easy-sync",
): boolean {
  if (isObsidianManagedConfigPath(path, configDir)) return true;
  if (isObsidianConfigWhitelistDirectoryPath(path, configDir)) return true;
  if (isEasySyncSelfSyncFilePath(path, configDir, pluginId)) return true;
  if (classifyCommunityPluginManagedPath(path, configDir, pluginId)) return true;
  return isCommunityPluginSubtreePath(path, configDir, pluginId);
}

/**
 * Folder-level recognition inside `${configDir}/plugins/`: the same prefix shape
 * `isCommunityPluginFolderPreservedByPolicy` uses, without its participation
 * gate (this predicate answers "which block does this path belong to", not
 * "does this device participate in that plugin").
 */
function isCommunityPluginSubtreePath(
  path: string,
  configDir: string,
  pluginId: string,
): boolean {
  const { pluginRoot } = getEasySyncPaths(configDir, pluginId);
  if (!path.startsWith(pluginRoot)) return false;
  const directoryId = path.slice(pluginRoot.length).split("/")[0];
  if (!directoryId) return false;
  return directoryId === pluginId
    || normalizePluginIds([directoryId], pluginId).length > 0;
}

/**
 * Drop every cloud-bound user-content action from a canonical plan candidate
 * in one-way mode. Inbound actions, `RecreateRemoteScope`, conflicts and the
 * skip/retry/auth rows are returned untouched, and so is every cloud-bound
 * action inside the three excluded blocks.
 */
export function suppressOutboundUserContentActions(
  items: readonly SyncPlanItem[],
  configDir: string,
  pluginId = "easy-sync",
): SyncPlanItem[] {
  return items.filter((item) =>
    !isOutboundUserContentAction(item.type)
    || isExcludedFromOneWaySyncPath(item.path, configDir, pluginId),
  );
}

/**
 * 片② 单向模式的"本机改动留副本＋原路径还原"：本机改过（有基线）与无基线两端
 * 同名这两种情况，改写成"先把当前本机字节留成副本、再由云端版本接管原路径"的
 * 下载动作。改写后的 `Download` 带着 `localOnlyCopyKind`，执行器会在覆盖原路径
 * 之前先把副本写到笔记库（副本失败则本轮不还原）。
 *
 * 只改这三类（`Upload` 带 remote＋baseEtag＝有基线本机改；两个 `Conflict`
 * reason），且只对不在排除三块内的路径生效：排除块继续按双向运行。其余出站动作
 * 仍由 {@link suppressOutboundUserContentActions} 丢弃，所以抑制与改写都发生在
 * 决策令牌绑定与审阅影响计数之前。
 */
export function applyOneWayLocalOnlyCopyPlan(
  items: readonly SyncPlanItem[],
  configDir: string,
  pluginId = "easy-sync",
): SyncPlanItem[] {
  return items.map((item) => {
    if (isExcludedFromOneWaySyncPath(item.path, configDir, pluginId)) return item;
    const kind = localOnlyCopyKindForOneWayItem(item);
    if (!kind || !item.local || !item.remote) return item;
    return {
      type: SyncActionType.Download,
      path: item.path,
      local: item.local,
      remote: item.remote,
      localOnlyCopyKind: kind,
    };
  });
}

/**
 * 片② 补齐：单向模式「本机删了 → 下次同步自动从云端拉回」（方案单 §二）。本机
 * 删除在双向计划里表现为"删云端"（文件 `DeleteRemote/fileDeletedLocally`、目录
 * `DeleteRemoteFolder`）或"本机删了但云端动过"的人工冲突行；这些出站动作被抑制
 * 后云端版本就不会回来，所以在同一挂点改写成入站动作：
 *
 * - `DeleteRemote`（`reason.fileDeletedLocally`，带 remote、无 local）→ `Download`；
 * - `Conflict`（`reason.localDeletedRemoteModified` / `reason.renameIdentityAmbiguous`，
 *   都带 remote、无 local）→ `Download`；本机重命名不算数＝旧路径拉回，重命名后的
 *   新路径文件是纯本机独有内容，留在原地（片③ 的"本机新建保留"），本片不给它
 *   造条目；
 * - `DeleteRemoteFolder`（本机目录已不在、云端仍在）→ `CreateLocalFolder`，复用同
 *   一项的 `folder` 事实（remoteId/parentRemoteId/parentPath），不改文件夹规划与
 *   锚点语义。含内容的目录同时会随其内部文件改写的 `Download` 由父目录自动重建，
 *   两条路互不冲突（创建与 `ensureParentDirs` 都是幂等的）。
 *
 * 同样只对不在排除三块内的路径生效，且只认"本机已无该路径"（`item.local` 缺失）
 * 的项，绝不改动带本机内容的项。
 */
export function applyOneWayLocalDeletedPullBackPlan(
  items: readonly SyncPlanItem[],
  configDir: string,
  pluginId = "easy-sync",
): SyncPlanItem[] {
  return items.map((item) => {
    if (isExcludedFromOneWaySyncPath(item.path, configDir, pluginId)) return item;
    if (item.type === SyncActionType.DeleteRemoteFolder) {
      return item.folder?.remoteId ? pullBackFolderItem(item) : item;
    }
    if (item.local || !item.remote) return item;
    if (!isLocalDeletedPullBackItem(item)) return item;
    return {
      type: SyncActionType.Download,
      path: item.path,
      remote: item.remote,
    };
  });
}

function isLocalDeletedPullBackItem(item: SyncPlanItem): boolean {
  if (item.type === SyncActionType.DeleteRemote) {
    return item.reason === "reason.fileDeletedLocally";
  }
  if (item.type !== SyncActionType.Conflict) return false;
  return item.reason === "reason.localDeletedRemoteModified"
    || item.reason === "reason.renameIdentityAmbiguous";
}

/** Same remote identity facts, inbound action: create the missing local folder. */
function pullBackFolderItem(item: SyncPlanItem): SyncPlanItem {
  const folder = item.folder!;
  return {
    type: SyncActionType.CreateLocalFolder,
    path: item.path,
    folder: {
      remoteId: folder.remoteId,
      remoteETag: folder.remoteETag,
      parentRemoteId: folder.parentRemoteId,
      parentPath: folder.parentPath,
    },
  };
}

function localOnlyCopyKindForOneWayItem(
  item: SyncPlanItem,
): LocalOnlyCopyKindV1 | null {
  // 有基线的本机改动：planner 的 Upload 带 remote＋baseEtag（身份替换路径同样
  // 带 baseEtag），本机新建的 Upload 没有 remote，不在此列。
  if (
    item.type === SyncActionType.Upload
    && item.remote
    && item.baseEtag
  ) {
    return "edited";
  }
  if (item.type !== SyncActionType.Conflict) return null;
  if (item.reason === "reason.bothSidesModified") return "edited";
  if (item.reason === "reason.newFileBothSides") return "new-file-both-sides";
  return null;
}

/**
 * 片④：本轮"本机独有内容"（无基线、云端也没有）的路径集合。planner 对这类
 * 文件产出**无 remote** 的 `Upload`（`file-decision-planner-v2.ts` 的无基线
 * 本机独有分支），本函数必须在 finalize 改写之前取快照——改写之后这些项就不在
 * 计划里了。排除三块继续按双向运行，不算本模式的条目。
 */
export function collectOneWayLocalOnlyPaths(
  items: readonly SyncPlanItem[],
  configDir: string,
  pluginId = "easy-sync",
): Set<string> {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.type !== SyncActionType.Upload) continue;
    if (item.remote || item.baseEtag || !item.local) continue;
    if (isExcludedFromOneWaySyncPath(item.path, configDir, pluginId)) continue;
    paths.add(item.path);
  }
  return paths;
}

/**
 * Force the remote delete follow for folder targets. The planner decides
 * `DeleteLocalFolder.requiresConfirmation` at build time from the device's
 * `autoDeleteLocalFiles` switch (canonical-plan-v2.ts), so finalize has to
 * clear the marker in one-way mode — otherwise a remote-deleted non-empty
 * folder still surfaces as a pending delete instead of following the cloud.
 * Only that one field on `DeleteLocalFolder` is touched; `DeleteRemoteFolder`
 * and every non-one-way path are returned untouched.
 *
 * Path-aware since the 2026-10-12 review: the excluded blocks (config /
 * plugins / own bundle) keep their two-way裁决, so a cloud-deleted non-empty
 * folder inside them still asks the user instead of being followed silently.
 */
export function forceRemoteFolderDeleteFollow(
  items: readonly SyncPlanItem[],
  configDir: string,
  pluginId = "easy-sync",
): SyncPlanItem[] {
  return items.map((item) =>
    item.type === SyncActionType.DeleteLocalFolder
      && item.requiresConfirmation === true
      && !isExcludedFromOneWaySyncPath(item.path, configDir, pluginId)
      ? { ...item, requiresConfirmation: false }
      : item,
  );
}
