import type { DriveItem } from "../onedrive/types";

/**
 * Graph driveItem → 中性远端扫描事实（B2a）。
 *
 * 这是 B2 期间 `src/sync` 模型层唯一允许消费 `DriveItem` 的边界：字段语义
 * 按中性词汇命名，值逐条透传、不做任何默认值归一化。瞬态字段
 * （downloadUrl / parentDriveId）只服务执行器与目录授权边界，禁止进入
 * `RemoteNodeV2`、状态信封、IndexedDB 摘要或任何持久化结构。
 */
export interface RemoteScanFactV1 {
  id: string;
  /** 父条目身份；缺失保留 undefined，由 buildRemoteIndexV2 按原顺序拒绝。 */
  parentId?: string;
  /** 名称；缺失保留 undefined，由 builder 拒绝。 */
  name?: string;
  /** 条目种类；file/folder 都没有时保留 undefined，由 builder 拒绝。 */
  kind?: "file" | "folder";
  /** tombstone 标记；true 时 builder 先跳过，再做身份完整性检查。 */
  deleted?: boolean;
  eTag?: string;
  cTag?: string;
  size?: number;
  /** 毫秒时间；非法日期保留 NaN（与现役 buildRemoteIndexV2 逐字一致）。 */
  mtime?: number;
  contentHash?: string;
  quickXorHash?: string;
  /** 瞬态：预签名下载地址；绝不进入 RemoteNodeV2 / 信封 / 缓存。 */
  downloadUrl?: string;
  /** 瞬态：父条目所属 driveId；只服务社区插件目录的跨 drive 授权校验。 */
  parentDriveId?: string;
}

/**
 * Graph driveItem 流 → 中性扫描事实；逐条映射，不做默认值归一化。
 *
 * eTag/cTag/size/mtime/contentHash 的缺失或非法值原样透传：两条既有 writer
 * （扫描投影与普通提交）的默认值差异是现役行为，统一默认值会改变
 * `sameRemoteNode` 的相等判断。
 */
export function toRemoteScanFactsV1(
  items: readonly DriveItem[],
): RemoteScanFactV1[] {
  return items.map((item) => ({
    id: item.id,
    parentId: item.parentReference?.id,
    name: item.name,
    kind: item.folder ? "folder" : item.file ? "file" : undefined,
    deleted: Boolean(item.deleted),
    eTag: item.eTag,
    cTag: item.cTag,
    size: item.size,
    mtime: item.lastModifiedDateTime
      ? new Date(item.lastModifiedDateTime).getTime()
      : undefined,
    contentHash: item.file?.hashes?.sha256Hash?.toLowerCase(),
    quickXorHash: item.file?.hashes?.quickXorHash,
    downloadUrl: item["@microsoft.graph.downloadUrl"],
    parentDriveId: item.parentReference?.driveId,
  }));
}
