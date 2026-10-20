/**
 * 找回读面（文件版本找回刀二之一）：把四个来源聚合成一条统一条目流，并提供
 * 「按条目取内容」的只读入口。
 *
 * 约束：
 * - 本模块零写动作——不写云端、不写本机、不建索引、不动同步状态；恢复动作
 *   （写成副本／走云端回收站恢复）不在这里。
 * - 单源失败不整体失败：云端读不到、内容读不出都降级成 `unavailable` 行；
 *   删除记录本机没有内容，只能如实说「要恢复才有内容」。
 * - 总列表（`global`）只聚合本机留档与删除记录：**不扫云端版本**（按方案定案，
 *   列表秒开、不浪费云端请求）；按路径查询才列该文件的云端版本。
 * - 云端版本要求该路径在本机有同步身份（committed 锚点的远端 id）：没有身份时
 *   不猜、不按路径去云端找，如实标不可用。
 * - 云端版本列表里的「当前版本」不成行（版本内容端点 400，且当前内容本就在库里）：
 *   按锚点 eTag 尾号精确摘除，锚点没有可解析 eTag 时摘第一条（列表 newest→oldest）。
 * - 时刻一律本机时钟毫秒；排序＝按 `at` 倒序，同 `at` 时来源顺序固定
 *   （留档 → 删除记录 → 云端版本 → 同步基线）。
 */

import type { DriveItemVersion } from "../onedrive/types";
import { parseDriveItemETagVersion } from "./blocked-upload-version-history";
import {
  deletionLedgerCutoffV1,
  type DeletionLedgerEntryV1,
} from "./deletion-ledger";
import {
  listLocalArchiveEntriesV1,
  localArchiveFilePathV1,
} from "./local-archive";

export type RecoverySource =
  | "local-archive"
  | "deleted-record"
  | "cloud-version"
  | "sync-baseline";

export type RecoveryUnavailableReason =
  /** 该路径没有 committed 远端身份，云端版本面无从查起。 */
  | "no-remote-identity"
  /** 有远端身份，但服务端一份保留版本都没有。 */
  | "no-version-history"
  /** 有身份/有历史，但内容此刻取不回来（含列表或传输失败）。 */
  | "content-unavailable"
  /** 已出保留窗口（删除记录的官方回收站 30 天）。 */
  | "expired";

export type RecoveryHandleV1 =
  | { kind: "local-archive"; archivePath: string }
  | { kind: "deleted-record"; remoteId: string; entryKind: "file" | "folder" }
  | {
    kind: "cloud-version";
    versionId: string;
    /** 列出条目自带的即时下载链接：一次性凭据，只在本次会话里用，不持久化。 */
    downloadUrl?: string;
  }
  | { kind: "sync-baseline"; hash: string };

export interface RecoveryEntryV1 {
  source: RecoverySource;
  /** 原路径（显示与恢复落点用；留档源的撞名副本保留它在留档夹里的实际文件名）。 */
  path: string;
  /** 该版本/事件的时刻（本机时钟毫秒）：排序键，倒序。 */
  at: number;
  size?: number;
  availability: "available" | "unavailable";
  reason?: RecoveryUnavailableReason;
  /** `available` 必有句柄；不可用的行可能没有可读身份（句柄缺席）。 */
  handle?: RecoveryHandleV1;
}

export type RecoveryContentV1 =
  | { kind: "bytes"; bytes: ArrayBuffer }
  | { kind: "text"; text: string }
  /** 删除记录：内容不在本机，取回只能走云端回收站恢复（属下一段）。 */
  | { kind: "requiresCloudRestore"; requiresCloudRestore: true }
  | { kind: "unavailable"; reason: RecoveryUnavailableReason };

/** 读面依赖（都是现役只读入口；DataAdapter／OneDriveClient／StateManager 同形）。 */
export interface RecoveryIndexDepsV1 {
  adapter: {
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    stat(path: string): Promise<{ size: number } | null>;
    readBinary(path: string): Promise<ArrayBuffer>;
  };
  /** 插件目录：留档夹 `<pluginDir>/archive/<戳>/` 落在它下面。 */
  pluginDir: string;
  state: {
    remoteIdForPath(path: string): string | undefined;
    remoteETagForPath(path: string): string | undefined;
    readonly deletionLedgerEntries: readonly DeletionLedgerEntryV1[];
    getBaseContent(path: string): Promise<string | undefined>;
    baselineFactsForPath(
      path: string,
    ): { hash: string; size: number; at: number } | undefined;
  };
  cloud: {
    listDriveItemVersionsById(driveItemId: string): Promise<DriveItemVersion[]>;
    downloadDriveItemVersionContent(input: {
      driveItemId: string;
      versionId: string;
      downloadUrl?: string;
      size?: number;
    }): Promise<ArrayBuffer>;
  };
}

/** 同 `at` 时的来源顺序（固定，不随查询变化）。 */
const RECOVERY_SOURCE_ORDER: readonly RecoverySource[] = [
  "local-archive",
  "deleted-record",
  "cloud-version",
  "sync-baseline",
];

/**
 * 一致过滤（2026-10-20 用户定性：与当前文件一模一样的条目不是历史）的单侧
 * 字节数上限：超过按「查不动，保留」处理——不猜原因、不拦行，宁多列不少列。
 */
const IDENTICAL_FILTER_MAX_BYTES_V1 = 1_048_576;

/** 与差异视图同口径的严格解码：非 UTF-8 返回 null，不产生替换字符文本。 */
function decodeStrictTextV1(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 行尾差异不算"内容不同"（与差异视图同一口径），先归一再比。 */
function normalizeLineEndingsV1(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export class RecoveryIndexV1 {
  constructor(private readonly deps: RecoveryIndexDepsV1) {}

  /**
   * 聚合条目（只读，不发任何写请求）。`scope: "global"` ＝ 全部本机留档 ＋
   * 删除记录簿；`scope: {path}` ＝ 该路径的四源。条目已排序（`at` 倒序）。
   */
  async listRecoveryEntries(input: {
    scope: { path: string } | "global";
    /** 「现在」：排序与过期判据用；测试注入用，运行期缺省取本机时钟。 */
    now?: number;
  }): Promise<RecoveryEntryV1[]> {
    const now = input.now ?? Date.now();
    const entries = input.scope === "global"
      ? await this.listGlobalEntries(now)
      : await this.listPathEntries(input.scope.path, now);
    return sortRecoveryEntriesV1(entries);
  }

  /**
   * 取一条目的内容（只读）。不可用的条目不做任何读取，原样回报原因；云端版本
   * 按条目里的版本 id 取（句柄里的下载链接过期时由客户端退回版本内容端点）。
   */
  async readRecoveryContent(
    entry: RecoveryEntryV1,
  ): Promise<RecoveryContentV1> {
    if (entry.availability === "unavailable") {
      return { kind: "unavailable", reason: entry.reason ?? "content-unavailable" };
    }
    const handle = entry.handle;
    if (!handle) return { kind: "unavailable", reason: "content-unavailable" };
    switch (handle.kind) {
      case "local-archive":
        return this.readLocalArchiveContent(handle.archivePath);
      case "deleted-record":
        return { kind: "requiresCloudRestore", requiresCloudRestore: true };
      case "cloud-version":
        return this.readCloudVersionContent(entry, handle);
      case "sync-baseline":
        return this.readSyncBaselineContent(entry.path);
    }
  }

  private async listGlobalEntries(now: number): Promise<RecoveryEntryV1[]> {
    return [
      ...await this.dropIdenticalLocalArchiveV1(
        await this.localArchiveEntries(),
      ),
      ...this.deletionLedgerRows().map((record) =>
        deletionRecordEntryV1(record, now)),
    ];
  }

  private async listPathEntries(
    path: string,
    now: number,
  ): Promise<RecoveryEntryV1[]> {
    const entries: RecoveryEntryV1[] = [];
    const localArchives = await this.dropIdenticalLocalArchiveV1(
      await this.localArchiveEntries(),
    );
    for (const archived of localArchives) {
      if (sameVaultPathV1(archived.path, path)) entries.push(archived);
    }
    for (const record of this.deletionLedgerRows()) {
      if (sameVaultPathV1(record.path, path)) {
        entries.push(deletionRecordEntryV1(record, now));
      }
    }
    entries.push(...await this.cloudVersionEntries(path, now));
    const baseline = await this.syncBaselineEntry(path);
    if (baseline) entries.push(baseline);
    return entries;
  }

  /**
   * 删除记录簿的展示行（2026-10-20 用户定案：文件夹是附属品，不是单独的恢复
   * 物）：文件夹行所在夹内已有文件行各自记账 ⇒ 文件夹行不上列表——内容随文件
   * 行退回，空壳跟随重建。只有"整棵子树一次删除"（审阅刀，只记根一条、文件行
   * 不存在）这类夹行才是唯一钥匙，保留展示。
   */
  private deletionLedgerRows(): readonly DeletionLedgerEntryV1[] {
    const records = this.deps.state.deletionLedgerEntries;
    return records.filter((record) => {
      if (record.kind !== "folder") return true;
      return !records.some((other) =>
        other.kind === "file" && isInsideFolderV1(other.path, record.path));
    });
  }

  private async localArchiveEntries(): Promise<RecoveryEntryV1[]> {
    const listed = await listLocalArchiveEntriesV1({
      adapter: this.deps.adapter,
      pluginDir: this.deps.pluginDir,
    });
    return listed.map((archived) => ({
      source: "local-archive",
      path: archived.path,
      at: archived.archivedAt,
      size: archived.size,
      availability: "available",
      handle: {
        kind: "local-archive",
        archivePath: localArchiveFilePathV1({
          pluginDir: this.deps.pluginDir,
          path: archived.path,
          archivedAt: archived.archivedAt,
        }),
      },
    }));
  }

  private async cloudVersionEntries(
    path: string,
    now: number,
  ): Promise<RecoveryEntryV1[]> {
    const remoteId = this.deps.state.remoteIdForPath(path);
    if (!remoteId) {
      return [unavailableCloudVersionEntryV1(path, now, "no-remote-identity")];
    }
    let versions: DriveItemVersion[];
    try {
      versions = await this.deps.cloud.listDriveItemVersionsById(remoteId);
    } catch {
      return [unavailableCloudVersionEntryV1(path, now, "content-unavailable")];
    }
    versions = withoutCurrentVersionV1(
      versions,
      this.deps.state.remoteETagForPath(path),
    );
    if (versions.length === 0) {
      return [unavailableCloudVersionEntryV1(path, now, "no-version-history")];
    }
    const entries: RecoveryEntryV1[] = [];
    for (const version of versions) {
      const entry = cloudVersionEntryV1(version, path);
      if (entry) entries.push(entry);
    }
    // 有历史但一条都排不上时间轴（缺 id／缺时刻）：如实说取不回，不假装没有历史。
    return entries.length > 0
      ? entries
      : [unavailableCloudVersionEntryV1(path, now, "content-unavailable")];
  }

  private async syncBaselineEntry(path: string): Promise<RecoveryEntryV1 | null> {
    // 无基线＝该源缺席（不是"不可用"）：省略。
    const facts = this.deps.state.baselineFactsForPath(path);
    if (!facts) return null;
    let content: string | undefined;
    try {
      content = await this.deps.state.getBaseContent(path);
    } catch {
      content = undefined;
    }
    // 该槽读出来和当前文件一模一样＝"没有变化"的那条，不是历史，不占行
    // （2026-10-20 用户定性）；**基线内容读不出＝同样整行不出**：没有内容的
    // 快照行没有任何动作可给（预览/差异/复制/恢复都依赖内容），挂在列表里
    // 只是永久占位的噪声（同日用户定案"不可读的快照行没有意义"）。
    if (content === undefined) return null;
    if (
      content.length <= IDENTICAL_FILTER_MAX_BYTES_V1
      && (await this.contentIdenticalToCurrentV1(path, content)) === true
    ) {
      return null;
    }
    return {
      source: "sync-baseline",
      path,
      at: facts.at,
      size: facts.size,
      availability: content === undefined ? "unavailable" : "available",
      ...(content === undefined ? { reason: "content-unavailable" as const } : {}),
      handle: { kind: "sync-baseline", hash: facts.hash },
    };
  }

  /**
   * 一致判据（只读本机，不猜）：当前文件不存在＝谈不上"一致"，行保留（它可能
   * 是唯一副本）；读不出、解不出 UTF-8 或超预算＝查不动（null），行保留；
   * 只有换行归一后严格同文才判 true（摘行）。
   */
  private async contentIdenticalToCurrentV1(
    path: string,
    text: string,
  ): Promise<boolean | null> {
    try {
      if (!(await this.deps.adapter.exists(path))) return false;
      const bytes = await this.deps.adapter.readBinary(path);
      if (bytes.byteLength > IDENTICAL_FILTER_MAX_BYTES_V1) return null;
      const currentText = decodeStrictTextV1(bytes);
      if (currentText === null) return null;
      return normalizeLineEndingsV1(currentText) === normalizeLineEndingsV1(text);
    } catch {
      return null;
    }
  }

  /**
   * 列表「只列真有得找回」的一致过滤：本机留档就地读档比对（≤上限的文本才
   * 比对，超大/二进制查不动＝保留）；同步历史槽的过滤在 `syncBaselineEntry`
   * 内容已在手上时做；云端版本要下载才能比，照列（点开有"内容一致"兜底）。
   */
  private async dropIdenticalLocalArchiveV1(
    entries: RecoveryEntryV1[],
  ): Promise<RecoveryEntryV1[]> {
    if (entries.length === 0) return entries;
    const kept: RecoveryEntryV1[] = [];
    for (const entry of entries) {
      if (entry.source !== "local-archive" || entry.availability !== "available") {
        kept.push(entry);
        continue;
      }
      const size = entry.size;
      const archivePath = entry.handle?.kind === "local-archive"
        ? entry.handle.archivePath
        : undefined;
      if (
        typeof size !== "number"
        || size > IDENTICAL_FILTER_MAX_BYTES_V1
        || archivePath === undefined
      ) {
        kept.push(entry);
        continue;
      }
      try {
        const archivedText = decodeStrictTextV1(
          await this.deps.adapter.readBinary(archivePath),
        );
        if (
          archivedText === null
          || (await this.contentIdenticalToCurrentV1(entry.path, archivedText)) !== true
        ) {
          kept.push(entry);
        }
      } catch {
        kept.push(entry);
      }
    }
    return kept;
  }

  private async readLocalArchiveContent(
    archivePath: string,
  ): Promise<RecoveryContentV1> {
    try {
      return { kind: "bytes", bytes: await this.deps.adapter.readBinary(archivePath) };
    } catch {
      return { kind: "unavailable", reason: "content-unavailable" };
    }
  }

  private async readCloudVersionContent(
    entry: RecoveryEntryV1,
    handle: RecoveryHandleV1 & { kind: "cloud-version" },
  ): Promise<RecoveryContentV1> {
    const remoteId = this.deps.state.remoteIdForPath(entry.path);
    if (!remoteId) return { kind: "unavailable", reason: "no-remote-identity" };
    try {
      return {
        kind: "bytes",
        bytes: await this.deps.cloud.downloadDriveItemVersionContent({
          driveItemId: remoteId,
          versionId: handle.versionId,
          downloadUrl: handle.downloadUrl,
          size: entry.size,
        }),
      };
    } catch {
      return { kind: "unavailable", reason: "content-unavailable" };
    }
  }

  private async readSyncBaselineContent(
    path: string,
  ): Promise<RecoveryContentV1> {
    let content: string | undefined;
    try {
      content = await this.deps.state.getBaseContent(path);
    } catch {
      content = undefined;
    }
    return content === undefined
      ? { kind: "unavailable", reason: "content-unavailable" }
      : { kind: "text", text: content };
  }
}

function deletionRecordEntryV1(
  record: DeletionLedgerEntryV1,
  now: number,
): RecoveryEntryV1 {
  const expired = record.deletedAt < deletionLedgerCutoffV1(now);
  return {
    source: "deleted-record",
    path: record.path,
    at: record.deletedAt,
    availability: expired ? "unavailable" : "available",
    ...(expired ? { reason: "expired" as const } : {}),
    handle: {
      kind: "deleted-record",
      remoteId: record.remoteId,
      entryKind: record.kind,
    },
  };
}

/**
 * 摘掉「当前版本」——它不是一条可恢复行：它的版本内容端点实测 400
 * `invalidRequest`（2026-10-19 真机实验，官方文档同口径：取当前内容走文件级
 * `/content`），而且那份内容本来就在库里（当前内容＝本机/云端现役那份）。
 *
 * 排除方式：committed 锚点的 eTag 尾号就是写入序号，也就是当前版本号
 * （`"{GUID},N"` ↔ 版本 id `N.0`），只有精确等于 `N.0` 的那一条被摘掉；锚点
 * 没有可解析 eTag 时退回摘第一条——版本列表按 newest→oldest 排序（Graph 文档
 * 明确，2026-10-19 实测同形：覆写后 `[2.0=当前, 1.0=旧]`）。
 */
function withoutCurrentVersionV1(
  versions: readonly DriveItemVersion[],
  remoteETag: string | undefined,
): DriveItemVersion[] {
  if (versions.length === 0) return [];
  const currentVersionNumber = parseDriveItemETagVersion(remoteETag);
  if (currentVersionNumber === null) return versions.slice(1);
  const currentVersionId = `${currentVersionNumber}.0`;
  return versions.filter((version) => version.id !== currentVersionId);
}

/**
 * 一条保留版本 → 一条可展示条目。缺 id（无从取内容）或缺可解析时刻（排不上
 * 时间轴）的版本跳过：宁可少一行，不给一条说不出时刻的行。
 */
function cloudVersionEntryV1(
  version: DriveItemVersion,
  path: string,
): RecoveryEntryV1 | null {
  if (typeof version.id !== "string" || version.id.length === 0) return null;
  const at = typeof version.lastModifiedDateTime === "string"
    ? Date.parse(version.lastModifiedDateTime)
    : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const downloadUrl = typeof version["@microsoft.graph.downloadUrl"] === "string"
    && version["@microsoft.graph.downloadUrl"].length > 0
    ? version["@microsoft.graph.downloadUrl"]
    : undefined;
  return {
    source: "cloud-version",
    path,
    at,
    ...(typeof version.size === "number" ? { size: version.size } : {}),
    availability: "available",
    handle: {
      kind: "cloud-version",
      versionId: version.id,
      ...(downloadUrl === undefined ? {} : { downloadUrl }),
    },
  };
}

/** 该源此刻不可用的报告行：没有更诚实的时刻，行时间＝本次查询时刻。 */
function unavailableCloudVersionEntryV1(
  path: string,
  now: number,
  reason: RecoveryUnavailableReason,
): RecoveryEntryV1 {
  return {
    source: "cloud-version",
    path,
    at: now,
    availability: "unavailable",
    reason,
  };
}

/** 排序＝`at` 倒序；同 `at` 先按来源固定顺序，再按路径、句柄身份定序（全序，可复现）。 */
function sortRecoveryEntriesV1(
  entries: RecoveryEntryV1[],
): RecoveryEntryV1[] {
  return [...entries].sort((left, right) => {
    if (left.at !== right.at) return right.at - left.at;
    const sourceDelta = RECOVERY_SOURCE_ORDER.indexOf(left.source)
      - RECOVERY_SOURCE_ORDER.indexOf(right.source);
    if (sourceDelta !== 0) return sourceDelta;
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    const leftIdentity = recoveryHandleIdentityV1(left.handle);
    const rightIdentity = recoveryHandleIdentityV1(right.handle);
    if (leftIdentity === rightIdentity) return 0;
    return leftIdentity < rightIdentity ? -1 : 1;
  });
}

function recoveryHandleIdentityV1(
  handle: RecoveryHandleV1 | undefined,
): string {
  if (!handle) return "";
  switch (handle.kind) {
    case "local-archive":
      return handle.archivePath;
    case "deleted-record":
      return handle.remoteId;
    case "cloud-version":
      return handle.versionId;
    case "sync-baseline":
      return handle.hash;
  }
}

function sameVaultPathV1(left: string, right: string): boolean {
  return left.normalize("NFC") === right.normalize("NFC");
}

/** 子路径判断（NFC 归一后按"夹路径 ＋ /"前缀对齐）。 */
function isInsideFolderV1(childPath: string, folderPath: string): boolean {
  const normalizedFolder = `${folderPath.normalize("NFC")}/`;
  return childPath.normalize("NFC").startsWith(normalizedFolder);
}
