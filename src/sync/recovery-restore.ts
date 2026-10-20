/**
 * 找回写动作（文件版本找回刀二之二）：把一条找回条目落成本机文件，或让云端
 * 回收站把删除的文件还原回原位置。
 *
 * 约束：
 * - 只有两个动作：本机写一份副本（`writeRecoveryCopyV1`）与云端回收站恢复
 *   （`OneDriveClient.restoreDeletedDriveItemById`）。不建索引、不写同步状态、
 *   不动锚点／账本／信封——找回出来的副本就是一个普通新文件，之后走常规扫描。
 * - 命名「原名优先」：原路径空着就落回原名（找回的文件名不变最不意外）；被占就
 *   换 `{原名}（找回 {yyyy-MM-dd HHmm}）{扩展名}`，再撞再换，绝不覆盖任何既有
 *   文件。戳＝该历史版本自身的时刻（列表所示时间），不是点恢复那刻——
 *   用户 2026-10-20 定案：文件名里的时间说的是「装的是哪一版」。「本机改动副本」
 *   的戳同样是内容自身的时间（改动时刻），找回副本循同一规矩。
 * - 本机写盘形状＝插件运行时临时目录暂存（`<tmpDir>/recovery-copy/<原路径>.part`）
 *   → 回读逐字节复核 → 改名落位 → 再复核；库内路径下不出现任何临时文件，失败只
 *   清理自己的暂存，不产生半成品、不动任何既有文件。
 * - 暂存不落库内同目录：扫描器的排除口径只认 `*.easy-sync-recovery` 结尾，普通
 *   `.tmp` 暂存会被当库内文件扫到（同步 churn）；`tmpDir` 整棵子树在扫描排除面内。
 * - 云端回收站恢复失败如实降级成 `unavailable`：原因分类由云客户端给出，这里
 *   不吞分类、不重试循环。
 */

import type {
  RecoveryContentV1,
  RecoveryEntryV1,
  RecoveryIndexV1,
  RecoveryUnavailableReason,
} from "./recovery-index";

/** 撞名换名上限（与留档／副本命名同一量级：正常最多一次）。 */
const RECOVERY_COPY_MAX_ATTEMPTS = 50;

/** 本机写副本只需要这六个文件面动作（与 `DataAdapter` 同形，测试可换内存盘）。 */
export interface RecoveryCopyAdapterV1 {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, content: ArrayBuffer): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** 云端回收站恢复（删除记录专用；实现在 `OneDriveClient.restoreDeletedDriveItemById`）。 */
export interface RecoveryRestoreCloudV1 {
  restoreDeletedDriveItemById(driveItemId: string): Promise<void>;
}

/**
 * 恢复失败的原因：读面的四档原样透传，另加本机写入失败那一档
 * （内容已经取到手、是本机没写成——不得混进「内容不可用」）。
 */
export type RecoveryRestoreUnavailableReasonV1 =
  | RecoveryUnavailableReason
  | "write-failed";

export type RecoveryRestoreResultV1 =
  /** 本机副本已落位（原名优先，被占则是带找回戳的换名副本）。 */
  | { kind: "copy"; newPath: string }
  /** 云端回收站恢复已受理（下一次常规同步把它带回本机）。 */
  | { kind: "cloud-restored"; remoteId: string }
  /** 此刻恢复不了，原因如实回报。 */
  | { kind: "unavailable"; reason: RecoveryRestoreUnavailableReasonV1 };

/**
 * 找回副本落点：`attempt = 0` 就是原路径（原名优先）；被占（`attempt > 0`）换
 * `{原名}（找回 {yyyy-MM-dd HHmm}）{扩展名}`，同一分钟里再撞就换 `… (2)`、
 * `… (3)`。无扩展名／点开头文件按整名处理后缀，不制造新扩展名。
 * 戳＝本历史版本自身的时刻（列表所示时间），由调用方从条目带入。
 *
 * 纯函数：只算名字，不算存在性——「目标是否已被占」由调用方逐个确认，所以这里
 * 给不出「绝不覆盖」的保证，保证写在 `writeRecoveryCopyV1` 里。
 */
export function recoveryCopyPathV1(input: {
  path: string;
  stampAt: number;
  attempt?: number;
}): string {
  const attempt = Math.max(0, Math.trunc(input.attempt ?? 0));
  if (attempt === 0) return input.path;
  const separator = input.path.lastIndexOf("/");
  const directory = separator < 0 ? "" : input.path.slice(0, separator + 1);
  const baseName = input.path.slice(separator + 1);
  const dot = baseName.lastIndexOf(".");
  const stem = dot <= 0 ? baseName : baseName.slice(0, dot);
  const extension = dot <= 0 ? "" : baseName.slice(dot);
  return `${directory}${stem}（找回 ${recoveryCopyStampV1(input.stampAt)}）`
    + `${attempt <= 1 ? "" : ` (${attempt})`}${extension}`;
}

/**
 * 找回戳：`yyyy-MM-dd HHmm`——与 `localOnlyCopyStampV1`（副本命名）同一冻格式，
 * 时分不加任何标点（`:` 不是合法 Windows 文件名字符，库还要同步到 Windows／
 * 安卓；`-`／`.` 会与日期段混淆）。正常路径不会走到失效兜底：戳来自条目自带的
 * 版本时刻，永远是合法数字。
 */
function recoveryCopyStampV1(stampAt: number): string {
  const at = Number.isFinite(stampAt) && stampAt > 0 ? stampAt : Date.now();
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * 把一份找回内容写成库内文件（成功返回落位路径）：
 * 1. 候选名逐个先确认目标不存在（原名优先，被占换名）；所有候选都被占就抛出；
 * 2. 插件运行时临时目录暂存（`<tmpDir>/recovery-copy/<原路径>.part`，与下载暂存的
 *    `<tmpDir>/downloads/<路径>.part` 同一既有约定）→ 回读逐字节复核 → 改名落位
 *    → 再复核；库内路径下不出现任何临时文件；
 * 3. 任何失败都先清理自己的暂存再抛出：不产生半成品、不覆盖任何既有文件。
 */
export async function writeRecoveryCopyV1(input: {
  adapter: RecoveryCopyAdapterV1;
  /** 原路径：副本的落点与暂存名的锚点。 */
  path: string;
  bytes: ArrayBuffer;
  /** 找回戳来源＝该历史版本自身的时刻（列表所示时间）；统一入口从条目带入，测试可钉住。 */
  stampAt: number;
  /** 插件运行时临时目录（`getEasySyncPaths(vault).tmpDir`）：暂存只落它下面。 */
  tmpDir: string;
  maxAttempts?: number;
}): Promise<{ newPath: string }> {
  // 暂存位固定且只属于我们：同名残留先清掉（这个目录是我们自己的，不是别人的东西）。
  const stagePath = `${input.tmpDir}/recovery-copy/${input.path}.part`;
  try {
    await ensureParentDirs(input.adapter, stagePath);
    await removeIfExists(input.adapter, stagePath);
    await input.adapter.writeBinary(stagePath, input.bytes);
    // 暂存回读复核：读不回原样就不允许落名（平台可能给出假尺寸）。
    const staged = await readIfExists(input.adapter, stagePath);
    if (!staged || !sameBytesV1(staged, input.bytes)) {
      throw new Error(`Recovery copy staging verification failed: ${input.path}`);
    }
    const maxAttempts = input.maxAttempts ?? RECOVERY_COPY_MAX_ATTEMPTS;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      const candidate = recoveryCopyPathV1({
        path: input.path,
        stampAt: input.stampAt,
        attempt,
      });
      // 每次尝试都要先确认目标不存在：桌面端改名会静默覆盖，守卫只能在这里。
      if (await input.adapter.exists(candidate)) continue;
      await ensureParentDirs(input.adapter, candidate);
      await input.adapter.rename(stagePath, candidate);
      const written = await readIfExists(input.adapter, candidate);
      if (!written || !sameBytesV1(written, input.bytes)) {
        // 不删目标：回读不符只可能是别人在这个窗口里先落了位，删掉会毁别人的东西。
        throw new Error(`Recovery copy verification failed: ${candidate}`);
      }
      return { newPath: candidate };
    }
    throw new Error(`No free recovery copy name for: ${input.path}`);
  } catch (error) {
    await removeIfExists(input.adapter, stagePath);
    throw error;
  }
}

/**
 * 统一恢复入口：给定一条读面产出的条目，做它能做的那一个动作。
 * - 本机留档／云端版本／同步基线 ⇒ 取内容写成库内副本（原名优先）；
 * - 删除记录 ⇒ 调云端回收站恢复（内容不在本机，只能让云把文件放回去）；
 * - 条目本就不可用、内容取不回、本机写入失败、云端恢复被拒 ⇒ 如实 `unavailable`。
 *
 * 不抛错：所有失败都翻成 `unavailable` 交调用方呈现（云端失败的原因分类不吞）。
 *
 * 找回戳取条目自带的版本时刻（`entry.at`＝列表所示时间），不是恢复动作的时刻；
 * 本接口不再收当下时钟。用户 2026-10-20 定案。
 */
export async function restoreRecoveryEntryV1(input: {
  index: RecoveryIndexV1;
  entry: RecoveryEntryV1;
  adapter: RecoveryCopyAdapterV1;
  cloud: RecoveryRestoreCloudV1;
  /** 插件运行时临时目录：写副本时的暂存落点（恢复删除记录用不到）。 */
  tmpDir: string;
}): Promise<RecoveryRestoreResultV1> {
  const { entry } = input;
  if (entry.availability === "unavailable" || !entry.handle) {
    return {
      kind: "unavailable",
      reason: entry.reason ?? "content-unavailable",
    };
  }
  if (entry.handle.kind === "deleted-record") {
    try {
      await input.cloud.restoreDeletedDriveItemById(entry.handle.remoteId);
      return { kind: "cloud-restored", remoteId: entry.handle.remoteId };
    } catch {
      // 云端拒绝／回收站里也没有了：如实说此刻取不回，不重试。
      return { kind: "unavailable", reason: "content-unavailable" };
    }
  }
  const content = await readContentQuietly(input.index, entry);
  if (content.kind === "unavailable") {
    return { kind: "unavailable", reason: content.reason };
  }
  if (content.kind === "requiresCloudRestore") {
    // 读面只在删除记录上给这个答案，那条路已被上面的分支接走：保守兜底。
    return { kind: "unavailable", reason: "content-unavailable" };
  }
  const bytes = content.kind === "text"
    ? new TextEncoder().encode(content.text).buffer
    : content.bytes;
  try {
    const written = await writeRecoveryCopyV1({
      adapter: input.adapter,
      path: entry.path,
      bytes,
      stampAt: entry.at,
      tmpDir: input.tmpDir,
    });
    return { kind: "copy", newPath: written.newPath };
  } catch {
    // 内容取到了、本机没写成：不是「内容不可用」，如实分开说。
    return { kind: "unavailable", reason: "write-failed" };
  }
}

async function readContentQuietly(
  index: RecoveryIndexV1,
  entry: RecoveryEntryV1,
): Promise<RecoveryContentV1> {
  try {
    return await index.readRecoveryContent(entry);
  } catch {
    // 读面自己会降级；意外抛出也按「此刻取不回内容」如实呈现。
    return { kind: "unavailable", reason: "content-unavailable" };
  }
}

async function ensureParentDirs(
  adapter: RecoveryCopyAdapterV1,
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

async function readIfExists(
  adapter: RecoveryCopyAdapterV1,
  path: string,
): Promise<ArrayBuffer | null> {
  try {
    return await adapter.readBinary(path);
  } catch {
    return null;
  }
}

async function removeIfExists(
  adapter: RecoveryCopyAdapterV1,
  path: string,
): Promise<void> {
  try {
    if (await adapter.exists(path)) await adapter.remove(path);
  } catch {
    // 清理失败不影响判定：没落位的东西最多留成暂存，下一次调用会重新占位。
  }
}

function sameBytesV1(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}
