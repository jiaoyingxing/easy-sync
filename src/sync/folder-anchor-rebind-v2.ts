import {
  isAnchoredDescendantV2,
  projectRemoteIndexV2,
  translateAnchoredPathV2,
} from "./remote-index-v2";
import {
  validateEnvelope,
  type FolderAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";

interface PathIdentityFolderAnchorRebindInputV2 {
  /** 已在本机消失的源文件夹路径。 */
  readonly sourcePath: string;
  /** 本机文件夹的新路径；远端目标文件夹必须已存在于提交的远端索引。 */
  readonly targetPath: string;
  readonly completedAt: number;
}

/** 路径身份 folder anchor 重绑的前置事实不成立；整次提交必须失败关闭。 */
export class FolderAnchorRebindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderAnchorRebindError";
  }
}

/**
 * 路径身份（WebDAV）小文件夹改名拆解后的状态收口：逐文件移动已经完成、
 * 目标文件夹已创建/观察，但文件夹锚点仍指向旧路径。把源子树下的 folder
 * anchor 翻译到目标路径，并把 `remoteId` 改成目标路径（路径身份没有稳定
 * folder id）。
 *
 * 只做状态翻译，不产生任何 provider mutation：
 * - 源子树下不得还有 file anchor（说明还有文件没移动完）——失败关闭；
 * - 目标路径必须已存在于提交的远端索引且是 folder——失败关闭；
 * - 目标不能在源子树内（会自引用）——失败关闭；
 * - 没有源 folder anchor 时视为已收口，幂等返回原 envelope。
 */
export function rebindPathIdentityFolderAnchorsV2(
  envelope: SyncStateEnvelopeV2,
  input: PathIdentityFolderAnchorRebindInputV2,
): SyncStateEnvelopeV2 {
  if (!envelope.folderAnchors) {
    throw new FolderAnchorRebindError("Folder anchor rebind requires initialized folder anchors");
  }
  const sourcePath = input.sourcePath;
  const targetPath = input.targetPath;
  if (sourcePath.length === 0 || targetPath.length === 0) {
    throw new FolderAnchorRebindError("Folder anchor rebind requires non-empty paths");
  }
  if (sourcePath === targetPath || targetPath.startsWith(`${sourcePath}/`)) {
    throw new FolderAnchorRebindError(
      `Folder anchor rebind target is not outside the source: ${sourcePath} -> ${targetPath}`,
    );
  }
  const sourceAnchors = Object.values(envelope.folderAnchors.byAnchorId)
    .filter((anchor) => anchor.lastPath === sourcePath
      || isAnchoredDescendantV2(anchor.lastPath, sourcePath));
  if (sourceAnchors.length === 0) return envelope;

  for (const anchor of Object.values(envelope.anchors.byAnchorId)) {
    if (anchor.lastPath === sourcePath
      || isAnchoredDescendantV2(anchor.lastPath, sourcePath)) {
      throw new FolderAnchorRebindError(
        `Folder anchor rebind still has a file anchor under the source: ${anchor.lastPath}`,
      );
    }
  }

  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  const idByPath = new Map<string, string>();
  for (const [id, path] of pathById) idByPath.set(path, id);

  const nextCommitSeq = envelope.meta.commitSeq + 1;
  const nextAnchors: Record<string, FolderAnchorV2> = {
    ...envelope.folderAnchors.byAnchorId,
  };
  for (const anchor of sourceAnchors) {
    const translated = translateAnchoredPathV2(
      anchor.lastPath,
      sourcePath,
      targetPath,
    );
    const targetId = idByPath.get(translated);
    const targetNode = targetId
      ? envelope.remoteIndex.itemsById[targetId]
      : undefined;
    if (!targetId || !targetNode || targetNode.kind !== "folder") {
      throw new FolderAnchorRebindError(
        `Folder anchor rebind target folder is missing: ${translated}`,
      );
    }
    delete nextAnchors[anchor.anchorId];
    const anchorId = `folder:${targetId}`;
    nextAnchors[anchorId] = {
      anchorId,
      remoteId: targetId,
      lastPath: translated,
      parentRemoteId: targetNode.parentId,
      ...(targetNode.eTag !== undefined ? { remoteETag: targetNode.eTag } : {}),
      confirmedGeneration: nextCommitSeq,
      confirmedAt: input.completedAt,
    };
  }

  const next: SyncStateEnvelopeV2 = {
    ...envelope,
    meta: {
      ...envelope.meta,
      commitSeq: nextCommitSeq,
      committedAt: input.completedAt,
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextAnchors),
    },
  };
  validateEnvelope(next);
  return next;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}
