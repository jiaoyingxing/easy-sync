/**
 * Executor community-plugin parameter types — moved verbatim out of
 * `sync-executor.ts` (分解刀 4, pure move + export). `sync-executor.ts`
 * imports every member; no shape or comment changed.
 *
 * 分解残余（有意记录）：`CommunityPluginDowngradeProbeRefreshArgs` 留在
 * sync-executor——其 `probeBatchClient` 字段引用
 * `NonNullable<ReturnType<typeof resolveBatchMetadataClient>>`，而
 * `resolveBatchMetadataClient` 被源码钉子钉在 sync-executor 文件本体
 * （tests/sync-executor-batch-refresh.test.ts 按本文件计数），不能随迁。
 */

import type { DataAdapter } from "obsidian";
import type { RemoteFileEntry, SyncPlanItem } from "./types";

export type CommunityPluginBundleDownloadDeferralArgs = {
  byPlugin: Map<string, SyncPlanItem[]>;
  configDir: string;
  remoteByPath: Map<string, RemoteFileEntry>;
  adapter: DataAdapter;
  refreshedProbeUrls: Map<string, string>;
  downloads: SyncPlanItem[];
};
