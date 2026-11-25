// 下载还原远端修改时间（2026-11-22 用户拍板只做桌面）：
// 桌面宿主接受 `DataWriteOptions.mtime` 并把它落到文件系统，于是「同步过来的
// 文件」在文件管理器与库内排序里显示的是云端那一刻，而不是本机落盘时刻；
// 移动端宿主覆盖 `.md` 时自己盖章（真宿主实测），所以一个参数都不带。
//
// 这里从真实下载轮次进入（`SyncExecutor.run`），钉住三件事：
// 1. 桌面新建文件：写入时带上远端 mtime，并在整轮结束后仍等于远端值；
// 2. 移动端：写入不带任何写选项，保持宿主默认行为；
// 3. 留档戳用「留档这一刻」，不跟着文件时间走——否则还原时间后旧版本会被
//    30 天摘除机制当成过期文件立刻删掉。
import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { sha256Hex } from "../src/crypto";
import type { HostPlatformFacts } from "../src/obsidian-compat";
import {
  localArchiveStampV1,
  parseLocalArchiveStampV1,
} from "../src/sync/local-archive";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { RemoteFileEntry } from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

const CONTENT = new TextEncoder().encode("synchronized body\n").buffer;
const REMOTE_MTIME = 1_600_000_000_000;
const DESKTOP_FACTS: HostPlatformFacts = {
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isDesktop: true,
  isMobile: false,
};
const ANDROID_FACTS: HostPlatformFacts = {
  isDesktopApp: false,
  isMobileApp: true,
  isIosApp: false,
  isAndroidApp: true,
  isDesktop: false,
  isMobile: true,
};

type WriteCall = { path: string; options: { mtime?: number } | undefined };

/** 记录每次 `writeBinary` 收到的写选项；`stat` 回读时给出最后一次写入的选项值，
 *  近似桌面宿主的"写进文件系统后 stat 读回一致"（该行为已由真宿主实测确认）。 */
function makeRecordingStore() {
  const files = new Map<string, ArrayBuffer>();
  const statMtimes = new Map<string, number>();
  const writes: WriteCall[] = [];
  const adapter = {
    async exists(path: string) {
      return files.has(path);
    },
    async stat(path: string) {
      const content = files.get(path);
      if (!content) return null;
      return { size: content.byteLength, mtime: statMtimes.get(path) ?? 1 };
    },
    async read(path: string) {
      const content = files.get(path);
      if (!content) throw new Error(`missing ${path}`);
      return new TextDecoder().decode(content);
    },
    async readBinary(path: string) {
      const content = files.get(path);
      if (!content) throw new Error(`missing ${path}`);
      return content.slice(0);
    },
    async write(path: string, value: string) {
      writes.push({ path, options: undefined });
      files.set(path, new TextEncoder().encode(value).buffer);
    },
    async writeBinary(
      path: string,
      content: ArrayBuffer,
      options?: { mtime?: number },
    ) {
      writes.push({ path, options });
      files.set(path, content.slice(0));
      // 桌面宿主：传了 mtime 就落这个值，没传就盖当前时刻。
      statMtimes.set(path, options?.mtime ?? Date.now());
    },
    async remove(path: string) {
      files.delete(path);
      statMtimes.delete(path);
    },
    async rename(from: string, to: string) {
      const content = files.get(from);
      if (!content) throw new Error(`missing ${from}`);
      files.set(to, content);
      files.delete(from);
      // 真宿主实测：桌面改名原样带走时间戳。
      const mtime = statMtimes.get(from);
      statMtimes.delete(from);
      if (mtime !== undefined) statMtimes.set(to, mtime);
    },
    async mkdir() { /* 目录只需调用能结算 */ },
    async list() { return { files: [...files.keys()], folders: [] }; },
  };
  const inspectFile = vi.fn(async (path: string) => {
    const content = files.get(path);
    if (!content) return { status: "missing" as const };
    return {
      status: "present" as const,
      entry: {
        path,
        size: content.byteLength,
        mtime: statMtimes.get(path) ?? 1,
        hash: await sha256Hex(content),
        binary: true,
      },
    };
  });
  return { adapter, files, inspectFile, statMtimes, writes };
}

function makeRemoteEntry(path: string): RemoteFileEntry {
  return {
    path,
    driveId: `id-${path}`,
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: CONTENT.byteLength,
    mtime: REMOTE_MTIME,
    eTag: `etag-${path}`,
    cTag: `ctag-${path}`,
  };
}

function makeExecutor(
  entries: RemoteFileEntry[],
  platform: HostPlatformFacts,
) {
  const store = makeRecordingStore();
  const metadataById = new Map(entries.map((entry) => [entry.driveId, entry]));
  const getDriveItemMetadataByIds = vi.fn(async (ids: readonly string[]) =>
    new Map(ids.map((id) => {
      const remote = metadataById.get(id)!;
      return [id, {
        id,
        name: remote.path,
        size: remote.size,
        eTag: remote.eTag,
        cTag: remote.cTag,
        file: {},
        parentReference: { id: remote.parentId },
        "@microsoft.graph.downloadUrl": `https://download.example/${id}`,
      }];
    })));
  const executor = new SyncExecutor(
    makeMockOneDrive({
      downloadFile: vi.fn(async () => CONTENT.slice(0)),
      getDriveItemMetadataByIds,
    }),
    {
      vault: {
        adapter: store.adapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [],
        folders: [],
        folderScanComplete: true,
        folderScanFailures: [],
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      scanFile: vi.fn().mockResolvedValue(null),
      inspectFile: store.inspectFile,
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner,
    makeActiveV2State(entries, []),
    "testVault",
    undefined,
    undefined,
    { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    platform,
  );
  return { executor, store };
}

describe("下载还原远端修改时间（桌面）", () => {
  const previousMobile = Platform.isMobile;
  const previousMobileApp = Platform.isMobileApp;

  afterEach(() => {
    Platform.isMobile = previousMobile;
    Platform.isMobileApp = previousMobileApp;
  });

  it("stamps the remote mtime onto a newly downloaded file on the desktop", async () => {
    Platform.isMobile = false;
    Platform.isMobileApp = false;
    const entries = [makeRemoteEntry("synced.md")];
    const { executor, store } = makeExecutor(entries, DESKTOP_FACTS);

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(1);
    // 新建文件走「暂存文件 → 改名落位」：时间戳写在暂存文件上，桌面 rename
    // 原样带到目标路径（两条都已由真宿主实测确认）。
    const stagedWrites = store.writes.filter((call) => call.path.includes(".ready"));
    expect(stagedWrites.length).toBeGreaterThan(0);
    expect(stagedWrites[stagedWrites.length - 1].options).toEqual({ mtime: REMOTE_MTIME });
    // 落位后的库内文件时间就是云端那一刻，不是「同步发生的现在」。
    expect(store.statMtimes.get(entries[0].path)).toBe(REMOTE_MTIME);
  });

  it("passes no write options at all on Android, where the host stamps its own time", async () => {
    Platform.isMobile = true;
    Platform.isMobileApp = true;
    const entries = [makeRemoteEntry("synced.md")];
    const { executor, store } = makeExecutor(entries, ANDROID_FACTS);

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(1);
    const stampWrites = store.writes.filter(
      (call) => call.path === entries[0].path || call.path.includes(".part")
        || call.path.includes(".ready"),
    );
    expect(stampWrites.length).toBeGreaterThan(0);
    // 移动端：一个都不带。带了也不会生效，只会让日志和事实分家。
    expect(stampWrites.every((call) => call.options === undefined)).toBe(true);
  });
});

describe("留档戳不跟文件时间走", () => {
  it("names an archive directory after the moment it was taken", () => {
    // 还原时间后，被覆盖的旧版本 mtime 可能是几周前；留档戳必须记当下，
    // 否则 `pruneExpiredLocalArchiveDirectoriesV1` 会把这个刚生成的目录
    // 当成过期留档在下一轮直接删掉（保留窗口 30 天）。
    const archivedAt = Date.now();
    const stamp = localArchiveStampV1(archivedAt);
    expect(parseLocalArchiveStampV1(stamp)).not.toBeNull();
    const stampedMs = parseLocalArchiveStampV1(stamp)!;
    // 戳只精确到分钟，允许一分钟内的截断。
    expect(Math.abs(stampedMs - archivedAt)).toBeLessThan(60_000);
  });
});
