/**
 * 找回读面的历史身份解析（只读辅助）。
 *
 * 改名（含改上层文件夹名）后、下一次同步提交前，新路径还没有 committed 锚点，
 * 但本机改名提示已经记下了原路径、新路径与远端身份，且提示只在对应锚点仍绑定
 * 原路径时有效。这里按与同步层相同的采信条件，把查询路径解析回同一个云端对象，
 * 供云端版本与同步快照两类来源使用：
 * - 文件改名：宿主 rename 事件留下的文件提示直接指回原路径的锚点；
 * - 文件夹改名：文件夹提示把新路径翻译回旧路径，再找那条文件锚点；
 * - 解析不唯一（多身份同时认领同一目标、同一时刻的文件夹证据顺序不可判）时
 *   返回 `pending-rename`，由界面说明“刚改过名”，不按内容或相似路径猜身份。
 *
 * 零写动作：不写状态、不消费提示、不触发同步。
 */
import type { FolderAnchorV2, SyncAnchorV2 } from "./state-envelope-v2";
import {
  sameSyncScope,
  type LocalFolderMoveHintV1,
  type SyncScope,
} from "./types";

export type RecoveryPathIdentityV1 =
  | {
    kind: "resolved";
    remoteId: string;
    /** committed 锚点记录的 eTag：摘除“当前版本”行时用它取写入序号。 */
    remoteETag?: string;
    /** 持有同步基线的 committed 锚点路径（锚点原文，不是查询路径）。 */
    baselinePath: string;
  }
  | { kind: "pending-rename" };

interface RecoveryPathIdentityInputV1 {
  /** 用户查询的库内路径（通常是刚改过名的新路径）。 */
  path: string;
  scope: SyncScope;
  fileAnchors: readonly SyncAnchorV2[];
  folderAnchors: readonly FolderAnchorV2[];
  fileMoveHints: readonly LocalFolderMoveHintV1[];
  folderMoveHints: readonly LocalFolderMoveHintV1[];
}

/**
 * 解析查询路径的历史身份；没有任何可用证据时返回 `undefined`（读面沿用
 * “没有云端记录”的原口径）。
 */
export function resolveRecoveryPathIdentityV1(
  input: RecoveryPathIdentityInputV1,
): RecoveryPathIdentityV1 | undefined {
  const direct = findFileAnchor(input.fileAnchors, input.path);
  if (direct) {
    // 该路径已被自己的锚点占用：身份以它为准，改名提示不得覆盖它。
    return resolvedIdentityV1(direct);
  }

  const claims = admittedFileMoveClaims(input);
  const directClaims = claims.get(identityKey(input.path)) ?? [];
  if (directClaims.length > 1) return { kind: "pending-rename" };
  if (directClaims.length === 1) return resolvedIdentityV1(directClaims[0]);

  const translated = translateThroughFolderMoveHints(input);
  if (translated.kind === "ambiguous") return { kind: "pending-rename" };
  if (translated.kind === "none") return undefined;

  // 先改文件名、后改上层文件夹名：翻译后的旧路径可能正是文件提示的目的地。
  const translatedClaims = claims.get(identityKey(translated.path)) ?? [];
  if (translatedClaims.length > 1) return { kind: "pending-rename" };
  if (translatedClaims.length === 1) {
    return resolvedIdentityV1(translatedClaims[0]);
  }
  return resolvedIdentityV1(findFileAnchor(input.fileAnchors, translated.path));
}

/**
 * 采信的文件改名提示 → 目的地键 → 原锚点。采信条件与同步层
 * （`identity-rename-v2` 的 `hintsByRemoteId`／`hintClaimsByDestination`）一致：
 * 同一同步范围、目的地在回收站之外、提示仍绑定原锚点、每个身份只认一条；
 * 目的地已被另一个身份占用时不采信。
 */
function admittedFileMoveClaims(
  input: RecoveryPathIdentityInputV1,
): Map<string, SyncAnchorV2[]> {
  const anchorsByRemoteId = new Map<string, SyncAnchorV2>();
  for (const anchor of input.fileAnchors) {
    if (!anchor.remoteId || anchorsByRemoteId.has(anchor.remoteId)) continue;
    anchorsByRemoteId.set(anchor.remoteId, anchor);
  }
  const claims = new Map<string, SyncAnchorV2[]>();
  const seenRemoteIds = new Set<string>();
  for (const hint of input.fileMoveHints) {
    if (!sameSyncScope(hint.scope, input.scope)) continue;
    if (isVaultTrashPath(hint.toPath)) continue;
    const anchor = anchorsByRemoteId.get(hint.remoteId);
    if (!anchor) continue;
    if (identityKey(hint.fromPath) !== identityKey(anchor.lastPath)) continue;
    // 记录层每个身份只留一条；损坏数据里的重复条目不制造第二次认领。
    if (seenRemoteIds.has(hint.remoteId)) continue;
    seenRemoteIds.add(hint.remoteId);
    const destinationKey = identityKey(hint.toPath);
    // 只改大小写／规范化形式时，占着目的地的正是这条提示自己的锚点，不算冲突。
    const occupiedByOther = input.fileAnchors.some((other) =>
      Boolean(other.remoteId)
      && other.remoteId !== hint.remoteId
      && identityKey(other.lastPath) === destinationKey);
    if (occupiedByOther) continue;
    claims.set(destinationKey, [...(claims.get(destinationKey) ?? []), anchor]);
  }
  return claims;
}

type FolderTranslationV1 =
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "translated"; path: string };

/**
 * 用文件夹改名提示把查询路径翻译回旧路径。提示按观察时刻从新到旧应用：先撤销
 * 后发生的位置变化，路径才会与更早的证据对上；同一时刻的两条提示都命中时，
 * 先后不可判，返回 `ambiguous`。
 */
function translateThroughFolderMoveHints(
  input: RecoveryPathIdentityInputV1,
): FolderTranslationV1 {
  const anchorsByRemoteId = new Map<string, FolderAnchorV2>();
  for (const anchor of input.folderAnchors) {
    if (anchorsByRemoteId.has(anchor.remoteId)) continue;
    anchorsByRemoteId.set(anchor.remoteId, anchor);
  }
  const admitted: LocalFolderMoveHintV1[] = [];
  const seenRemoteIds = new Set<string>();
  for (const hint of input.folderMoveHints) {
    if (!sameSyncScope(hint.scope, input.scope)) continue;
    if (isVaultTrashPath(hint.toPath)) continue;
    const anchor = anchorsByRemoteId.get(hint.remoteId);
    if (!anchor) continue;
    if (nfcKey(anchor.lastPath) !== nfcKey(hint.fromPath)) continue;
    if (seenRemoteIds.has(hint.remoteId)) continue;
    const destinationKey = nfcKey(hint.toPath);
    const occupiedByOther = input.folderAnchors.some((other) =>
      other.remoteId !== hint.remoteId
      && nfcKey(other.lastPath) === destinationKey);
    if (occupiedByOther) continue;
    seenRemoteIds.add(hint.remoteId);
    admitted.push(hint);
  }
  admitted.sort((left, right) =>
    right.observedAt - left.observedAt
    || left.toPath.localeCompare(right.toPath)
    || left.fromPath.localeCompare(right.fromPath));

  let candidate = input.path;
  const applied: LocalFolderMoveHintV1[] = [];
  const skipped: LocalFolderMoveHintV1[] = [];
  for (const hint of admitted) {
    const suffix = suffixBelow(candidate, hint.toPath);
    if (suffix === null) {
      skipped.push(hint);
      continue;
    }
    if (applied.some((other) => other.observedAt === hint.observedAt)) {
      return { kind: "ambiguous" };
    }
    candidate = `${hint.fromPath}${suffix}`;
    applied.push(hint);
  }
  // 当时对不上、翻译完又对上的证据说明应用顺序不可判（同一时刻的多条改名）：
  // 不猜，交给同步提交后的路径锚点。
  if (skipped.some((hint) => suffixBelow(candidate, hint.toPath) !== null)) {
    return { kind: "ambiguous" };
  }
  return applied.length === 0
    ? { kind: "none" }
    : { kind: "translated", path: candidate };
}

function resolvedIdentityV1(
  anchor: SyncAnchorV2 | undefined,
): RecoveryPathIdentityV1 | undefined {
  if (!anchor?.remoteId) return undefined;
  return {
    kind: "resolved",
    remoteId: anchor.remoteId,
    ...(anchor.remoteETag ? { remoteETag: anchor.remoteETag } : {}),
    baselinePath: anchor.lastPath,
  };
}

/** 与 `StateManager.committedAnchorAtPath` 同口径：NFC 路径相等，先到先得。 */
function findFileAnchor(
  anchors: readonly SyncAnchorV2[],
  path: string,
): SyncAnchorV2 | undefined {
  const key = nfcKey(path);
  return anchors.find((anchor) => nfcKey(anchor.lastPath) === key);
}

/** 身份比较键：与同步层 `normalizeIdentityPath` 同口径（NFC ＋ 忽略大小写）。 */
function identityKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function nfcKey(path: string): string {
  return path.normalize("NFC");
}

function isVaultTrashPath(path: string): boolean {
  return path === ".trash" || path.startsWith(".trash/");
}

/** `path` 严格位于 `root` 之下时返回带前导 `/` 的剩余段串，否则 null。 */
function suffixBelow(path: string, root: string): string | null {
  const pathSegments = path.split("/");
  const rootSegments = root.split("/");
  if (rootSegments.length >= pathSegments.length) return null;
  for (let index = 0; index < rootSegments.length; index++) {
    if (nfcKey(pathSegments[index]) !== nfcKey(rootSegments[index])) return null;
  }
  return `/${pathSegments.slice(rootSegments.length).join("/")}`;
}
