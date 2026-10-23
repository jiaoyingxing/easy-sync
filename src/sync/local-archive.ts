/**
 * 冲突「保留云端版」前的本机版本留档（文件版本找回第一刀的一半）。
 *
 * 选择「保留云端版」时，云端字节会原地接管同一个库内路径，而现役覆盖链
 * （`commitDownloadedTempFile` 的本机 CAS、原子改名，以及 `local-replacement-writer`
 * 写坏回滚用的 `previousBytes`）都硬依赖目标路径在覆盖落地前仍持有旧字节——所以
 * 本机那份只能「复制进档」，不能物理挪走。
 *
 * 落点＝`<pluginDir>/archive/<stamp>/<库内相对路径>`：插件目录下的任何子目录本来
 * 就不进扫描、不进同步（`local-scanner` 的目录门／文件门），因此不登记布局表，
 * 也不会被当成库内文件同步出去。这里不写任何同步记录：留档失败时调用方不得覆盖、
 * 不得产生账本记录；留档成功时副本本身就是那个持久事实（面向用户的列表属后续刀）。
 * 留档只在本机留 30 天：健康轮摘除戳时间早于窗口的目录（见
 * `pruneExpiredLocalArchiveDirectoriesV1`）；留档夹不随「重置同步状态」删除。
 */

import { sha256Hex } from "../crypto";
import { describeError } from "../obsidian-compat";

/** 留档根目录：插件目录下的固定子目录名。 */
const LOCAL_ARCHIVE_DIR_NAME = "archive";

/** 撞名换名的次数上限（与副本命名同一量级：正常只需一次）。 */
const LOCAL_ARCHIVE_MAX_ATTEMPTS = 50;

/** 留档只需文件面的这几个动作，便于测试替换成内存盘。 */
interface LocalArchiveAdapterV1 {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, content: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * 目标路径上的字节已经不等于审阅时的本机版本（读不出来也算同一档）。
 * 调用方据此把原因说成「确认后本机文件发生了变化」，本轮不覆盖。
 */
export class LocalArchiveSourceChangedError extends Error {
  readonly path: string;

  constructor(path: string, detail?: string) {
    super(detail
      ? `Local file could not be read for archiving: ${path} (${detail})`
      : `Local file changed before its version could be archived: ${path}`);
    this.name = "LocalArchiveSourceChangedError";
    this.path = path;
  }
}

/**
 * 留档戳：`yyyy-MM-dd HHmm`——与 `localOnlyCopyStampV1`（副本命名）同一冻格式，
 * 时分不加任何标点（`:` 不是合法 Windows 文件名字符，`-`／`.` 会与日期段混淆）。
 */
export function localArchiveStampV1(archivedAt: number): string {
  const at = Number.isFinite(archivedAt) && archivedAt > 0
    ? archivedAt
    : Date.now();
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * `localArchiveStampV1` 的反解析（本机时区，与格式化函数同一口径）：不是这个
 * 格式、或不是合法时刻（`2024-13-05`／`2024-01-05 2570`）一律返回 null——解析
 * 不出来的目录名不是我们的留档目录，调用方必须原地不动。
 */
export function parseLocalArchiveStampV1(name: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})$/.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  const at = date.getTime();
  if (!Number.isFinite(at)) return null;
  // `new Date` 会把越界字段滚到下一位（`2024-02-30` → 03-01），必须逐字段回读。
  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
    || date.getHours() !== Number(hour)
    || date.getMinutes() !== Number(minute)
  ) {
    return null;
  }
  return at;
}

/** 一个留档时刻对应一个子目录：同一时刻的多个路径互不干扰。 */
export function localArchiveDirV1(input: {
  pluginDir: string;
  archivedAt: number;
}): string {
  return `${input.pluginDir}/${LOCAL_ARCHIVE_DIR_NAME}/${localArchiveStampV1(input.archivedAt)}`;
}

/**
 * `archive/<stamp>/<库内相对路径>`；`attempt` > 0 是撞名换名：既有留档绝不覆盖，
 * 每一个被保下来的版本都是独立的一份文件（后缀落在扩展名之前）。
 */
export function localArchiveFilePathV1(input: {
  pluginDir: string;
  path: string;
  archivedAt: number;
  attempt?: number;
}): string {
  const directory = localArchiveDirV1(input);
  const attempt = Math.max(0, Math.trunc(input.attempt ?? 0));
  if (attempt === 0) return `${directory}/${input.path}`;
  const separator = input.path.lastIndexOf("/");
  const parent = separator < 0 ? "" : input.path.slice(0, separator + 1);
  const baseName = input.path.slice(separator + 1);
  const dot = baseName.lastIndexOf(".");
  const stem = dot <= 0 ? baseName : baseName.slice(0, dot);
  const extension = dot <= 0 ? "" : baseName.slice(dot);
  return `${directory}/${parent}${stem} (${attempt + 1})${extension}`;
}

interface LocalArchiveWriteInputV1 {
  adapter: LocalArchiveAdapterV1;
  /** 即将被云端版本覆盖的库内相对路径。 */
  path: string;
  /** 插件目录：留档根 `<pluginDir>/archive/...` 落在它下面。 */
  pluginDir: string;
  /** 插件 tmp 目录：留档先写到这里复核，再改名落入留档根。 */
  tmpDir: string;
  /** 审阅时记录的本机版本：留档字节必须与它逐字节相同。 */
  expected: { size: number; hash: string };
  /** 留档戳来源（取审阅版本的本机时间，构成确定性的落点）。 */
  archivedAt: number;
  /** 现役暂存写入形状（Android 零字节重试等）；缺省走 adapter.writeBinary。 */
  writeTempFile?: (tempPath: string, content: ArrayBuffer) => Promise<void>;
  /** 取消／换代检查：每次落字节之前都会问一次。 */
  isCurrent: () => boolean;
  maxAttempts?: number;
}

/**
 * 把 `path` 上当前那份本机字节复制进留档夹，并逐字节复核两次（暂存回读一次、
 * 改名落位后回读一次）；成功返回留档路径。任何抛出都意味着「本次不得覆盖」，
 * 调用方负责报错并保留原冲突行。取消（`isCurrent` 为假）时返回 null，
 * 不落任何字节。
 */
export async function writeLocalArchiveCopyV1(
  input: LocalArchiveWriteInputV1,
): Promise<{ archivePath: string } | null> {
  const originalBytes = await readSourceBytes(input);
  if (!await matchesExpected(originalBytes, input.expected)) {
    throw new LocalArchiveSourceChangedError(input.path);
  }
  const writeTempFile = input.writeTempFile
    ?? ((tempPath: string, content: ArrayBuffer) =>
      input.adapter.writeBinary(tempPath, content));
  const maxAttempts = input.maxAttempts ?? LOCAL_ARCHIVE_MAX_ATTEMPTS;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    if (!input.isCurrent()) return null;
    const archivePath = localArchiveFilePathV1({
      pluginDir: input.pluginDir,
      path: input.path,
      archivedAt: input.archivedAt,
      attempt,
    });
    // 撞名：换名落位，绝不覆盖已有留档。
    if (await input.adapter.exists(archivePath)) continue;
    const stagingPath = `${input.tmpDir}/local-archive/${input.path}.part`;
    await ensureParentDirs(input.adapter, stagingPath);
    await removeIfExists(input.adapter, stagingPath);
    await writeTempFile(stagingPath, originalBytes);
    const stagedBytes = await readIfExists(input.adapter, stagingPath);
    if (!stagedBytes || !await matchesExpected(stagedBytes, input.expected)) {
      await removeIfExists(input.adapter, stagingPath);
      throw new Error(`Local archive staging verification failed: ${archivePath}`);
    }
    if (!input.isCurrent()) {
      await removeIfExists(input.adapter, stagingPath);
      return null;
    }
    await ensureParentDirs(input.adapter, archivePath);
    try {
      await input.adapter.rename(stagingPath, archivePath);
    } catch (renameError) {
      // 只清我们自己的暂存文件；留档位置里的任何东西都不动。
      await removeIfExists(input.adapter, stagingPath);
      throw renameError;
    }
    const archivedBytes = await readIfExists(input.adapter, archivePath);
    if (!archivedBytes || !await matchesExpected(archivedBytes, input.expected)) {
      // 不删目标：回读不符只可能是别人在这个窗口里先落了位，删掉会毁掉别人的留档。
      // 本轮不覆盖原文件，下一次按撞名换名落位。
      throw new Error(`Local archive verification failed: ${archivePath}`);
    }
    return { archivePath };
  }
  throw new Error(`No free local archive name for: ${input.path}`);
}

/** 留档夹清理只需要文件面的这三个动作（便于测试替换成内存盘）。 */
interface LocalArchivePruneAdapterV1 {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

/** 留档夹枚举只需要这三个动作（与 `DataAdapter` 同形，便于测试换成内存盘）。 */
interface LocalArchiveListAdapterV1 {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ size: number } | null>;
}

export interface LocalArchiveEntryV1 {
  /**
   * 留档文件相对戳目录的路径——磁盘事实，撞名换名后的实际文件名原样在内。
   * `localArchiveFilePathV1({pluginDir, path, archivedAt})`（attempt 0）给出该
   * 文件的完整路径，也是取内容时唯一可靠的句柄（撞名后缀不可反推原名）。
   */
  path: string;
  /** 目录戳解析出的留档时刻。 */
  archivedAt: number;
  /** 文件字节数。 */
  size: number;
}

/**
 * 列出现存留档（只读）：只认 `<pluginDir>/archive/<戳>` 目录——目录名解析不出戳
 * 的一律跳过，不猜、不动；戳目录内递归收集文件。单条读不出（stat 失败、列举期间
 * 被删）只跳过那一条，不整体失败；留档根不存在＝空列表。顺序＝目录列举顺序，
 * 调用方自行排序；本函数不写任何字节。
 */
export async function listLocalArchiveEntriesV1(input: {
  adapter: LocalArchiveListAdapterV1;
  pluginDir: string;
}): Promise<LocalArchiveEntryV1[]> {
  const entries: LocalArchiveEntryV1[] = [];
  const root = `${input.pluginDir}/${LOCAL_ARCHIVE_DIR_NAME}`;
  if (!await existsQuietly(input.adapter, root)) return entries;
  const listing = await listQuietly(input.adapter, root);
  for (const directory of listing?.folders ?? []) {
    const archivedAt = parseLocalArchiveStampV1(baseNameOf(directory));
    if (archivedAt === null) continue;
    await collectArchiveFiles(input.adapter, directory, "", archivedAt, entries);
  }
  return entries;
}

async function collectArchiveFiles(
  adapter: LocalArchiveListAdapterV1,
  directory: string,
  prefix: string,
  archivedAt: number,
  out: LocalArchiveEntryV1[],
): Promise<void> {
  const listing = await listQuietly(adapter, directory);
  if (!listing) return;
  for (const file of listing.files) {
    const stats = await statQuietly(adapter, file);
    if (!stats || !Number.isFinite(stats.size)) continue;
    out.push({
      path: `${prefix}${baseNameOf(file)}`,
      archivedAt,
      size: stats.size,
    });
  }
  for (const subdirectory of listing.folders) {
    await collectArchiveFiles(
      adapter,
      subdirectory,
      `${prefix}${baseNameOf(subdirectory)}/`,
      archivedAt,
      out,
    );
  }
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function existsQuietly(
  adapter: LocalArchiveListAdapterV1,
  path: string,
): Promise<boolean> {
  try {
    return await adapter.exists(path);
  } catch {
    return false;
  }
}

async function listQuietly(
  adapter: LocalArchiveListAdapterV1,
  path: string,
): Promise<{ files: string[]; folders: string[] } | null> {
  try {
    return await adapter.list(path);
  } catch {
    return null;
  }
}

async function statQuietly(
  adapter: LocalArchiveListAdapterV1,
  path: string,
): Promise<{ size: number } | null> {
  try {
    return await adapter.stat(path);
  } catch {
    return null;
  }
}

/**
 * 摘除戳时间早于 `cutoff` 的留档目录（连同目录内所有留档）；戳时间不早于
 * `cutoff` 的、以及目录名解析不出戳的一律不动——留档夹里只可能是我们自己的
 * `<stamp>` 目录，认不出来就不动别人的东西。
 *
 * 单个目录删不掉（云客户端句柄占用等）只记进 `failed` 并继续处理其余目录：
 * 留档夹清理任何失败都不得影响同步。目录不存在时什么都不做（不读盘、不报错）。
 */
export async function pruneExpiredLocalArchiveDirectoriesV1(input: {
  adapter: LocalArchivePruneAdapterV1;
  pluginDir: string;
  cutoff: number;
}): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  const root = `${input.pluginDir}/${LOCAL_ARCHIVE_DIR_NAME}`;
  if (!await input.adapter.exists(root)) return { removed, failed };
  const listed = await input.adapter.list(root);
  for (const directory of listed.folders) {
    const name = directory.slice(directory.lastIndexOf("/") + 1);
    const stampedAt = parseLocalArchiveStampV1(name);
    if (stampedAt === null || stampedAt >= input.cutoff) continue;
    try {
      await input.adapter.rmdir(directory, true);
      removed.push(directory);
    } catch {
      failed.push(directory);
    }
  }
  return { removed, failed };
}

async function readSourceBytes(
  input: LocalArchiveWriteInputV1,
): Promise<ArrayBuffer> {
  try {
    return await input.adapter.readBinary(input.path);
  } catch (error) {
    throw new LocalArchiveSourceChangedError(
      input.path,
      describeError(error),
    );
  }
}

async function matchesExpected(
  bytes: ArrayBuffer,
  expected: { size: number; hash: string },
): Promise<boolean> {
  return bytes.byteLength === expected.size
    && await sha256Hex(bytes) === expected.hash;
}

async function readIfExists(
  adapter: LocalArchiveAdapterV1,
  path: string,
): Promise<ArrayBuffer | null> {
  try {
    return await adapter.readBinary(path);
  } catch {
    return null;
  }
}

async function removeIfExists(
  adapter: LocalArchiveAdapterV1,
  path: string,
): Promise<void> {
  try {
    if (await adapter.exists(path)) await adapter.remove(path);
  } catch {
    // 清理失败不影响判定：留档没落位就不会进入覆盖。
  }
}

async function ensureParentDirs(
  adapter: LocalArchiveAdapterV1,
  filePath: string,
): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (!dir) return;
  const segments = dir.split("/");
  for (let index = 1; index <= segments.length; index++) {
    try {
      await adapter.mkdir(segments.slice(0, index).join("/"));
    } catch {
      // 目录可能已存在——继续下一段。
    }
  }
}
