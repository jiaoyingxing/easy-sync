import { TFile, type DataAdapter } from "obsidian";
import {
  describeError,
  hostPlatformFacts,
  type HostPlatformFacts,
} from "../obsidian-compat";
import { toStrictUtf8Bytes } from "./ancestor-store-v2";

export const EASY_SYNC_RECOVERY_SUFFIX = ".easy-sync-recovery";

/**
 * In-place replacement of an existing local file through the host's own write
 * surface.
 *
 * Renaming the target aside (`<path>.easy-sync-recovery`) and renaming the
 * staged file into place is what made Obsidian treat the open note as removed:
 * it dropped the view, and an editor with unsaved text lost that text. Writing
 * the same path keeps the host reading the change as an ordinary content
 * update — the open view survives, and unsaved text is merged instead of lost
 * (measured: `scripts/probes/easy-sync-host-write-shapes-probe-auto.js`).
 *
 * The write is verified by reading the target back before the caller retires
 * its recovery copy, because the host can write again right after us (an open
 * editor merges its unsaved text back to disk). What the readback shows decides
 * the outcome: our bytes (with or without host-merged text on top) are a
 * landed write, a strict prefix is our own truncation, an untouched old
 * version is a bounded rewrite, and anything unattributable stops without
 * touching the file (`DECISIONS` 2026-09-23 point 9).
 *
 * The remote modification time rides along as `DataWriteOptions.mtime` on the
 * desktop only (see `restorableLocalMtime`); the landing judgment still reads
 * bytes, never the timestamp.
 */

const ANDROID_TARGET_WRITE_MAX_ATTEMPTS = 3;
/** 其它平台：首次写入没落地时同轮重写一次（`DECISIONS` 2026-09-23 第 9 点④）。 */
const DEFAULT_TARGET_WRITE_MAX_ATTEMPTS = 2;

/**
 * 写完之后磁盘上到底是什么（`DECISIONS` 2026-09-23 第 9 点五档判定的底层形态）：
 * - `exact`：① 就是我们写的那份；
 * - `merged-tail`：② 我们写的那份后面被宿主追加了内容（打开着的编辑器把未保存的行合并回磁盘）；
 * - `empty` / `previous`：④ 写入没有落地（磁盘还是空文件 / 还是旧版本），可同轮重试；
 * - `truncated`：③ 只剩我们写入内容的前缀＝我们自己写坏了；
 * - `unattributed`：⑤ 别的内容或读不回来，无法归属。
 */
type PostWriteArm =
  | "exact"
  | "merged-tail"
  | "empty"
  | "previous"
  | "truncated"
  | "unattributed";

export class LocalReplacementVerificationError extends Error {
  constructor(
    message: string,
    readonly arm: Extract<PostWriteArm, "previous" | "unattributed">,
    readonly observedSize: number | null,
    /** 写入调用本身抛出的错误（若有）。用于诊断报告呈现不落地的原因。 */
    readonly writeFailure: unknown = null,
  ) {
    super(message);
    this.name = "LocalReplacementVerificationError";
  }
}

/**
 * The target ended up holding a strict prefix of what we wrote: that is our own
 * write being cut short (kill mid-write, storage truncation, platform zero-byte),
 * not a third-party write. The writer puts the previous bytes back before
 * throwing, so the user's file never stays half-written.
 */
export class LocalReplacementTruncatedError extends Error {
  constructor(
    message: string,
    readonly restoredPrevious: boolean,
    readonly observedSize: number | null,
  ) {
    super(message);
    this.name = "LocalReplacementTruncatedError";
  }
}

/**
 * 远端修改时间能否还原到本机文件（2026-11-22 用户拍板只做桌面）。
 *
 * 这是这条通道的**唯一裁决点**：平台门、可信性门都在这里。调用方只负责把
 * 远端的 `mtime` 原样递进来，不要各自再判一次平台——规则散在多处时，新增一条
 * 写入路径就很容易漏掉其中一半。
 *
 * 桌面宿主接受 `DataWriteOptions.mtime` 并原样落到文件系统：`vault.modify`、
 * `adapter.writeBinary`、以及改名都保留该值（真宿主实测）。安卓宿主对 `.md`
 * 覆盖会自己盖章、丢掉传入的 mtime（`vault.modify` 与 `writeBinary` 均如此），
 * 而 `.md` 正是库内绝大多数文件，所以移动端不做这件事，保持宿主默认行为。
 *
 * 只接受可信时刻：不早于 1970-01-02 的有限值。缺时间、负值、非有限值，以及
 * 历史状态里当占位符用的极小值（`mtime: 0`／`1`）一律不还原——把一个占位数字
 * 写进用户文件的时间，比不还原更糟。
 *
 * 返回 `undefined` 表示「不传这个参数」，宿主会按自己的默认行为盖章。
 */
const EARLIEST_PLAUSIBLE_MTIME = Date.UTC(1970, 0, 2);

export function restorableLocalMtime(
  remoteMtime: number | undefined,
  platform: HostPlatformFacts,
): number | undefined {
  if (!platform.isDesktopApp) return undefined;
  if (remoteMtime === undefined || !Number.isFinite(remoteMtime)) {
    return undefined;
  }
  if (remoteMtime < EARLIEST_PLAUSIBLE_MTIME) return undefined;
  return remoteMtime;
}

/**
 * 把裁决结果转成写入选项；`undefined` 时调用方**不传实参**，让宿主默认行为
 * 逐字保持原样（有调用方桩按实参个数断言）。
 *
 * 这是 `restorableLocalMtime` 之后的**唯一转换点**：每一条写盘路径（暂存文件、
 * 原地替换、直写）都只调用它，不各自写 `mtime === undefined ? undefined : …`。
 * 转换散在三处时，新增一条写入路径就会漏掉其中一处——2026-11-22 review 在
 * `sync-executor` 的冲突分支里就发现过一次内联复制。
 */
export function localMtimeWriteOptions(
  mtime: number | undefined,
): { mtime: number } | undefined {
  return mtime === undefined ? undefined : { mtime };
}

interface InPlaceReplacementRequest {
  /** Host-visible identity of the target. Callers only route files the vault
   *  can name here: without it there is no open view to preserve, and the
   *  atomic swap stays the safer replacement. */
  file: TFile;
  modify?: (file: TFile, data: string, options?: { mtime?: number }) => Promise<void>;
  adapter: DataAdapter;
  targetPath: string;
  content: ArrayBuffer;
  /** 要还原到落盘文件的远端修改时间；缺席＝由宿主盖章（见 `restorableLocalMtime`）。 */
  mtime?: number;
  /** Bytes the target held before this write. Used to undo a truncated write. */
  previousBytes?: ArrayBuffer | null;
  /**
   * Identity of the version being written, for diagnostics only. The landing
   * decision compares bytes read back from disk, so only `size` is read here
   * (`DECISIONS` 2026-09-23 point 9: 判据只看回读字节).
   */
  expectedVersion: { size: number };
  maxAttempts?: number;
  /** Host platform facts used for the Android zero-byte retry; defaults to the
   *  live `Platform`-backed facts. */
  platform?: HostPlatformFacts;
  onWarning?: (message: string) => void;
}

interface InPlaceReplacementOutcome {
  via: "host-modify" | "adapter-write";
  attempts: number;
  /** 磁盘上的实际字节数（宿主可能在我们的写入之后又合并了一次）。 */
  size: number;
  mtime?: number;
  /** 落地判据：`exact` 与 `merged-tail` 都算写入成功。 */
  arm: "exact" | "merged-tail";
  /** 仅 `merged-tail`：宿主追加在我们写入内容之后的字节数。 */
  appendedBytes: number;
}

export async function writeReplacementInPlace(
  request: InPlaceReplacementRequest,
): Promise<InPlaceReplacementOutcome> {
  const { file, modify, adapter, targetPath, content, expectedVersion, previousBytes } = request;
  // Only canonical UTF-8 that round-trips byte-for-byte may take the text
  // surface; anything else keeps its exact bytes through the adapter.
  const text = canonicalUtf8Text(content);
  const useHostModify = text !== null && typeof modify === "function";
  const via: InPlaceReplacementOutcome["via"] = useHostModify
    ? "host-modify"
    : "adapter-write";
  const maxAttempts = request.maxAttempts
    ?? ((request.platform ?? hostPlatformFacts).isAndroidApp && content.byteLength > 0
      ? ANDROID_TARGET_WRITE_MAX_ATTEMPTS
      : DEFAULT_TARGET_WRITE_MAX_ATTEMPTS);
  // `request.mtime` 已由调用方过 `restorableLocalMtime`（唯一裁决点）；这里只把
  // 结果转成写选项。`undefined` 时不传实参，宿主默认行为逐字保持原样。
  const writeOptions = localMtimeWriteOptions(request.mtime);

  let observed: ArrayBuffer | null = null;
  let arm: PostWriteArm = "unattributed";
  let writeFailure: unknown = null;
  let attempt = 0;
  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    writeFailure = null;
    try {
      if (useHostModify) {
        if (writeOptions) await modify(file, text, writeOptions);
        else await modify(file, text);
      } else if (writeOptions) {
        await adapter.writeBinary(targetPath, content, writeOptions);
      } else {
        await adapter.writeBinary(targetPath, content);
      }
    } catch (error) {
      // 写入接口抛错不代表没落盘，判据仍看回读字节；但抛错后不再重写。
      writeFailure = error;
      request.onWarning?.(
        `in-place replacement attempt ${attempt}/${maxAttempts} threw while writing ${targetPath}: ${describeError(error)}`,
      );
    }
    // 回读字节是权威：某些平台（Android）对刚写入的文件会给出假的 stat 尺寸。
    observed = await readBack(adapter, targetPath);
    arm = classifyPostWrite(observed, content, previousBytes ?? null);
    if (arm === "exact" || arm === "merged-tail") {
      const stat = await adapter.stat(targetPath);
      return {
        via,
        attempts: attempt,
        size: observed!.byteLength,
        mtime: stat?.mtime,
        arm,
        appendedBytes: arm === "merged-tail"
          ? observed!.byteLength - content.byteLength
          : 0,
      };
    }
    if (writeFailure) break;
    if (arm === "empty" || arm === "previous") {
      // ④ 写入没有落地（空文件或旧版本）：同轮内有界重试一次。
      request.onWarning?.(
        `in-place replacement attempt ${attempt}/${maxAttempts} did not land for ${targetPath} (observed ${observed?.byteLength ?? "missing"} byte(s), expected ${expectedVersion.size})`,
      );
      continue;
    }
    // ③ 截断 / ⑤ 无法归属：现场不动，不再写第二遍。
    request.onWarning?.(
      `in-place replacement attempt ${attempt}/${maxAttempts} landed an unattributable state for ${targetPath} (observed ${observed?.byteLength ?? "missing"} byte(s), expected ${expectedVersion.size})`,
    );
    break;
  }

  const observedSize = observed ? observed.byteLength : null;
  // ③（含空文件写不进去）＝我们写坏了：把旧内容放回去，绝不让用户文件停在半截。
  if (arm === "truncated" || arm === "empty") {
    let restoredPrevious = false;
    if (request.previousBytes) {
      try {
        const previous = request.previousBytes;
        await adapter.writeBinary(targetPath, previous);
        const back = await readBack(adapter, targetPath);
        restoredPrevious = Boolean(back && sameBytes(back, previous));
      } catch {
        restoredPrevious = false;
      }
    }
    throw new LocalReplacementTruncatedError(
      `Local replacement left a truncated file: ${targetPath}`,
      restoredPrevious,
      observedSize,
    );
  }

  throw new LocalReplacementVerificationError(
    arm === "previous"
      ? `Local replacement did not land the downloaded version: ${targetPath}`
      : `Local replacement landed an unattributable version: ${targetPath}`,
    arm,
    observedSize,
    writeFailure,
  );
}

async function readBack(adapter: DataAdapter, path: string): Promise<ArrayBuffer | null> {
  try {
    return await adapter.readBinary(path);
  } catch {
    return null;
  }
}

function classifyPostWrite(
  observed: ArrayBuffer | null,
  content: ArrayBuffer,
  previousBytes: ArrayBuffer | null,
): PostWriteArm {
  if (!observed) return "unattributed";
  if (sameBytes(observed, content)) return "exact";
  // ④ 旧版本原样还在＝这次写入没有落地，必须先判：远端版本恰好是旧版本前缀时（另一端
  // 删掉了尾部），旧版本也满足下面「我们写入内容 + 后面多了东西」的形状——顺序反了会
  // 把没落地读成宿主合并、记成功并把基线记成远端版本，下一轮把旧内容当本机改动传上去。
  if (previousBytes && sameBytes(observed, previousBytes)) return "previous";
  // ② 只有「我们写入内容严格作为前缀、后面多了东西」才认成宿主合并。内容本身为空时
  // 这个形状承载不了这个含义（空前缀对谁都是真），一律按无法归属保守延后。
  if (
    content.byteLength > 0
    && observed.byteLength > content.byteLength
    && startsWithBytes(observed, content)
  ) {
    return "merged-tail";
  }
  if (observed.byteLength === 0) return "empty";
  if (isStrictPrefixOf(observed, content)) return "truncated";
  return "unattributed";
}

function startsWithBytes(candidate: ArrayBuffer, prefix: ArrayBuffer): boolean {
  const left = new Uint8Array(candidate);
  const right = new Uint8Array(prefix);
  for (let index = 0; index < right.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isStrictPrefixOf(candidate: ArrayBuffer, content: ArrayBuffer): boolean {
  if (candidate.byteLength >= content.byteLength) return false;
  const left = new Uint8Array(candidate);
  const right = new Uint8Array(content);
  return left.every((value, index) => value === right[index]);
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}

function canonicalUtf8Text(content: ArrayBuffer): string | null {
  const canonical = toStrictUtf8Bytes(content);
  if (!canonical) return null;
  return new TextDecoder("utf-8").decode(canonical);
}
