// 找回写动作（`src/sync/recovery-restore.ts`）：命名「原名优先」、写副本的
// 「暂存 → 回读复核 → 改名 → 再复核」形状（暂存在插件运行时临时目录，不在库内），
// 以及统一入口对四个来源的分派。全程用内存盘替身：不碰真库、不碰云端。

import { describe, expect, it, vi, type Mock } from "vitest";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import type { DeletionLedgerEntryV1 } from "../src/sync/deletion-ledger";
import {
  RecoveryIndexV1,
  type RecoveryEntryV1,
  type RecoveryIndexDepsV1,
} from "../src/sync/recovery-index";
import {
  recoveryCopyPathV1,
  restoreRecoveryEntryV1,
  writeRecoveryCopyV1,
  type RecoveryCopyAdapterV1,
  type RecoveryRestoreCloudV1,
  type RecoveryRestoreResultV1,
  type RecoveryRestoreUnavailableReasonV1,
} from "../src/sync/recovery-restore";

const PLUGIN_DIR = ".obsidian/plugins/easy-sync";
// 与运行期同一约定（`getEasySyncPaths(vault).tmpDir`）：暂存只落它下面。
const TMP_DIR = getEasySyncPaths(".obsidian").tmpDir;
const STAMP_DIR = "2026-10-18 1430";
const ARCHIVE_PATH = `${PLUGIN_DIR}/archive/${STAMP_DIR}/notes/note.md`;
const NOTE_PATH = "notes/note.md";
const NOTE_HASH = "ab".repeat(32);
const NOW = new Date(2026, 9, 19, 15, 7).getTime();
const STAMP_AT = new Date(2026, 9, 18, 14, 30).getTime();
const VERSION_AT = new Date(2026, 9, 18, 10, 0).getTime();
const STAMP = "2026-10-19 1507";
// 历史版本自身时刻的戳文本（＝列表显示的那个时间；不是恢复动作发生的时刻）。
const ARCHIVE_AT_STAMP = "2026-10-18 1430";
const VERSION_AT_STAMP = "2026-10-18 1000";
const STAGE_PATH = `${TMP_DIR}/recovery-copy/${NOTE_PATH}.part`;

const ARCHIVED_BYTES = utf8("archived local version\n");
const CLOUD_BYTES = utf8("cloud version 1.0 bytes\n");
const BASELINE_TEXT = "# baseline\n";

function utf8(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function decode(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

interface VaultOptions {
  failWriteBinary?: (target: string) => boolean;
  failRename?: (from: string, to: string) => boolean;
  readOverride?: (target: string, actual: ArrayBuffer) => ArrayBuffer;
}

/**
 * 内存盘：文件面动作与 `DataAdapter` 同形。`rename` 按桌面端 `fs.rename` 形态
 * 静默覆盖目标——「目标必须不存在」的守卫只能靠调用方，这让变异可被测试抓到。
 * `writeTargets`／`renameCalls` 留下运行期轨迹，用来钉住「库内不出现临时文件」。
 */
function makeVault(
  initial: Record<string, ArrayBuffer> = {},
  options: VaultOptions = {},
) {
  const files = new Map(Object.entries(initial));
  const directories = new Set<string>();
  const writeTargets: string[] = [];
  const renameCalls: Array<{ from: string; to: string }> = [];
  const adapter = {
    exists: vi.fn(async (target: string) =>
      files.has(target) || directories.has(target)),
    list: vi.fn(async (target: string) => {
      const prefix = `${target}/`;
      const childFiles = [...files.keys()].filter((path) =>
        path.startsWith(prefix)
        && !path.slice(prefix.length).includes("/"));
      const childFolders = new Set(
        [...directories, ...files.keys()]
          .filter((path) =>
            path.startsWith(prefix)
            && path.slice(prefix.length).split("/").length > 1)
          .map((path) => `${prefix}${path.slice(prefix.length).split("/")[0]}`),
      );
      return { files: childFiles, folders: [...childFolders] };
    }),
    stat: vi.fn(async (target: string) => {
      const bytes = files.get(target);
      return bytes ? { size: bytes.byteLength } : null;
    }),
    readBinary: vi.fn(async (target: string) => {
      const bytes = files.get(target);
      if (!bytes) throw new Error(`missing: ${target}`);
      const copy = bytes.slice(0);
      return options.readOverride?.(target, copy) ?? copy;
    }),
    writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => {
      if (options.failWriteBinary?.(target)) throw new Error("disk full");
      writeTargets.push(target);
      files.set(target, bytes.slice(0));
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (options.failRename?.(from, to)) throw new Error("rename failed");
      const bytes = files.get(from);
      if (!bytes) throw new Error(`missing: ${from}`);
      renameCalls.push({ from, to });
      files.set(to, bytes);
      files.delete(from);
    }),
    remove: vi.fn(async (target: string) => {
      files.delete(target);
    }),
    mkdir: vi.fn(async (target: string) => {
      directories.add(target);
    }),
  } satisfies RecoveryCopyAdapterV1
    & Pick<RecoveryIndexDepsV1["adapter"], "list" | "stat">;
  return { files, directories, writeTargets, renameCalls, adapter };
}

/** 云端回收站替身：按入口的接口契约形状（`RecoveryRestoreCloudV1`），并留调用痕迹。 */
function makeCloudRestore(): RecoveryRestoreCloudV1 & {
  restoreDeletedDriveItemById: Mock<(driveItemId: string) => Promise<void>>;
} {
  return {
    restoreDeletedDriveItemById: vi.fn(async () => undefined),
  };
}

/** 只读面（`RecoveryIndexV1`）：与写动作共用同一个内存盘，形状同运行期。 */
function makeRecoveryIndex(input: {
  files?: Record<string, ArrayBuffer>;
  remoteIds?: Record<string, string>;
  baselines?: Record<string, string>;
  download?: RecoveryIndexDepsV1["cloud"]["downloadDriveItemVersionContent"];
  vaultOptions?: VaultOptions;
}) {
  const vault = makeVault(input.files ?? {}, input.vaultOptions);
  const baselines = input.baselines ?? {};
  const state = {
    remoteIdForPath: vi.fn((path: string) => input.remoteIds?.[path]),
    remoteETagForPath: vi.fn(() => undefined),
    deletionLedgerEntries: [] as readonly DeletionLedgerEntryV1[],
    getBaseContent: vi.fn(async (path: string) => baselines[path]),
    baselineFactsForPath: vi.fn(() => undefined),
  };
  const cloud = {
    listDriveItemVersionsById: vi.fn(async () => []),
    downloadDriveItemVersionContent: vi.fn(
      input.download ?? (async () => CLOUD_BYTES),
    ),
  };
  const index = new RecoveryIndexV1({
    adapter: vault.adapter,
    pluginDir: PLUGIN_DIR,
    state,
    cloud,
  });
  return { vault, index, state, cloud };
}

/** 读面产出形状的条目（原样手工构造，钉住入口只消费这层契约）。 */
function archiveEntry(): RecoveryEntryV1 {
  return {
    source: "local-archive",
    path: NOTE_PATH,
    at: STAMP_AT,
    size: ARCHIVED_BYTES.byteLength,
    availability: "available",
    handle: { kind: "local-archive", archivePath: ARCHIVE_PATH },
  };
}

function cloudEntry(): RecoveryEntryV1 {
  return {
    source: "cloud-version",
    path: NOTE_PATH,
    at: VERSION_AT,
    size: CLOUD_BYTES.byteLength,
    availability: "available",
    handle: {
      kind: "cloud-version",
      versionId: "1.0",
      downloadUrl: "https://cdn/1.0",
    },
  };
}

function baselineEntry(): RecoveryEntryV1 {
  return {
    source: "sync-baseline",
    path: NOTE_PATH,
    at: STAMP_AT,
    size: BASELINE_TEXT.length,
    availability: "available",
    handle: { kind: "sync-baseline", hash: NOTE_HASH },
  };
}

function deletedEntry(
  overrides: Partial<RecoveryEntryV1> = {},
): RecoveryEntryV1 {
  return {
    source: "deleted-record",
    path: NOTE_PATH,
    at: STAMP_AT,
    availability: "available",
    handle: {
      kind: "deleted-record",
      remoteId: "note-item-id",
      entryKind: "file",
    },
    ...overrides,
  };
}

describe("recoveryCopyPathV1", () => {
  it("prefers the original path", () => {
    expect(recoveryCopyPathV1({ path: NOTE_PATH, stampAt: NOW })).toBe(NOTE_PATH);
    expect(recoveryCopyPathV1({ path: NOTE_PATH, stampAt: NOW, attempt: 0 }))
      .toBe(NOTE_PATH);
    // 负数/小数尝试都按 0 处理：纯函数不留可玩坏的边界。
    expect(recoveryCopyPathV1({ path: NOTE_PATH, stampAt: NOW, attempt: -3 }))
      .toBe(NOTE_PATH);
  });

  it("adds the frozen recovery stamp to a taken original name", () => {
    expect(recoveryCopyPathV1({
      path: "notes/deep/note.md",
      stampAt: NOW,
      attempt: 1,
    })).toBe(`notes/deep/note（找回 ${STAMP}）.md`);
    expect(recoveryCopyPathV1({
      path: "notes/deep/note.md",
      stampAt: NOW,
      attempt: 2,
    })).toBe(`notes/deep/note（找回 ${STAMP}） (2).md`);
    expect(recoveryCopyPathV1({
      path: "notes/deep/note.md",
      stampAt: NOW,
      attempt: 3,
    })).toBe(`notes/deep/note（找回 ${STAMP}） (3).md`);
  });

  it("keeps extensionless and dot-leading names whole", () => {
    expect(recoveryCopyPathV1({ path: "README", stampAt: NOW, attempt: 1 }))
      .toBe(`README（找回 ${STAMP}）`);
    expect(recoveryCopyPathV1({ path: "notes/.hidden", stampAt: NOW, attempt: 1 }))
      .toBe(`notes/.hidden（找回 ${STAMP}）`);
    // 点开头但带扩展名：扩展名照常跟着走。
    expect(recoveryCopyPathV1({ path: ".env.local", stampAt: NOW, attempt: 1 }))
      .toBe(`.env（找回 ${STAMP}）.local`);
  });

  it("stamps without Windows-hostile characters and falls back to the clock", () => {
    const stamped = recoveryCopyPathV1({ path: "note.md", stampAt: NOW, attempt: 1 });
    expect(stamped).not.toContain(":");
    expect(stamped).not.toContain("/");
    expect(recoveryCopyPathV1({ path: "note.md", stampAt: Number.NaN, attempt: 1 }))
      .toMatch(/^note（找回 \d{4}-\d{2}-\d{2} \d{4}）\.md$/);
  });
});

describe("writeRecoveryCopyV1", () => {
  it("lands the bytes under the original name when it is free", async () => {
    const bytes = utf8("recovered old version\n");
    const vault = makeVault();

    const result = await writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes,
      stampAt: NOW,
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({ newPath: NOTE_PATH });
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe("recovered old version\n");
    // 暂存不残留：磁盘上只剩落位的那一份。
    expect([...vault.files.keys()]).toEqual([NOTE_PATH]);
    // 父目录按需建出来。
    expect(vault.adapter.mkdir).toHaveBeenCalledWith("notes");
  });

  it("stages inside the plugin runtime directory: no temp file appears in the vault", async () => {
    const vault = makeVault({ [NOTE_PATH]: utf8("current live content\n") });

    const result = await writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
    });

    // 运行期走过的每个写／改名动作都只在运行时临时目录里（库内路径不进临时文件）。
    expect(vault.writeTargets).toEqual([STAGE_PATH]);
    expect(vault.writeTargets.every((target) =>
      target.startsWith(`${TMP_DIR}/`))).toBe(true);
    expect(vault.renameCalls).toEqual([{
      from: STAGE_PATH,
      to: result.newPath,
    }]);
    expect(vault.adapter.mkdir).toHaveBeenCalledWith(`${TMP_DIR}/recovery-copy`);
    // 收尾后库内只剩原有文件与落位的副本，没有任何 `.part` 残留。
    expect([...vault.files.keys()].sort())
      .toEqual([NOTE_PATH, result.newPath].sort());
    const vaultSideFiles = [...vault.files.keys()].filter((path) =>
      !path.startsWith(`${TMP_DIR}/`));
    expect(vaultSideFiles.some((path) => path.endsWith(".part"))).toBe(false);
  });

  it("cleans its own same-named staging copy in the runtime directory first", async () => {
    const vault = makeVault({
      [STAGE_PATH]: utf8("leftover from a crashed run\n"),
    });

    const result = await writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({ newPath: NOTE_PATH });
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe("recovered old version\n");
    // 暂存位只属于我们：同名残留被清掉后由本次暂存接替，改名落位后不残留。
    expect([...vault.files.keys()]).toEqual([NOTE_PATH]);
  });

  it("keeps non-text bytes byte-for-byte", async () => {
    const payload = [0, 255, 1, 254, 0, 128];
    const bytes = new Uint8Array(payload).buffer;
    const vault = makeVault();

    await writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes,
      stampAt: NOW,
      tmpDir: TMP_DIR,
    });

    expect([...new Uint8Array(await vault.adapter.readBinary(NOTE_PATH))])
      .toEqual(payload);
  });

  it("never overwrites an existing file: a taken name moves aside", async () => {
    const vault = makeVault({ [NOTE_PATH]: utf8("current live content\n") });

    const result = await writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
    });

    expect(result.newPath).toBe(`notes/note（找回 ${STAMP}）.md`);
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe("current live content\n");
    expect(decode(await vault.adapter.readBinary(result.newPath)))
      .toBe("recovered old version\n");
  });

  it("moves to the next candidate when the stamped name is taken too", async () => {
    const stampedPath = `notes/note（找回 ${STAMP}）.md`;
    const vault = makeVault({
      [NOTE_PATH]: utf8("current live content\n"),
      [stampedPath]: utf8("an earlier recovery copy\n"),
    });

    const result = await writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
    });

    expect(result.newPath).toBe(`notes/note（找回 ${STAMP}） (2).md`);
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe("current live content\n");
    expect(decode(await vault.adapter.readBinary(stampedPath)))
      .toBe("an earlier recovery copy\n");
  });

  it("leaves nothing behind when the staging write fails", async () => {
    const vault = makeVault({}, {
      failWriteBinary: (target) => target.startsWith(`${TMP_DIR}/`),
    });

    await expect(writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
    })).rejects.toThrow("disk full");

    expect([...vault.files.keys()]).toEqual([]);
  });

  it("does not land a name when the staged bytes do not read back", async () => {
    const vault = makeVault({}, {
      readOverride: (target, actual) =>
        target === STAGE_PATH ? utf8("tampered\n") : actual,
    });

    await expect(writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
    })).rejects.toThrow(/staging verification/i);

    // 不落名、暂存清掉、原路径一个字都没写。
    expect([...vault.files.keys()]).toEqual([]);
  });

  it("reports a failed readback instead of claiming success, and deletes nothing", async () => {
    const vault = makeVault({}, {
      readOverride: (target, actual) =>
        target === NOTE_PATH ? utf8("host rewrote it\n") : actual,
    });

    await expect(writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
    })).rejects.toThrow(/verification failed/i);

    // 落位后的文件不删（可能是别人先落的位置），但也不报成功。
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe("host rewrote it\n");
  });

  it("cleans its own staging file when the rename fails", async () => {
    const vault = makeVault({}, { failRename: () => true });

    await expect(writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
    })).rejects.toThrow("rename failed");

    expect([...vault.files.keys()]).toEqual([]);
  });

  it("gives up without leftovers when every candidate name is taken", async () => {
    const vault = makeVault({
      [NOTE_PATH]: utf8("current live content\n"),
      [`notes/note（找回 ${STAMP}）.md`]: utf8("copy one\n"),
      [`notes/note（找回 ${STAMP}） (2).md`]: utf8("copy two\n"),
    });

    await expect(writeRecoveryCopyV1({
      adapter: vault.adapter,
      path: NOTE_PATH,
      bytes: utf8("recovered old version\n"),
      stampAt: NOW,
      tmpDir: TMP_DIR,
      maxAttempts: 2,
    })).rejects.toThrow(/no free recovery copy name/i);

    // 一个候选都没落位，自己的暂存也清干净了。
    expect([...vault.files.keys()].some((path) => path.endsWith(".part")))
      .toBe(false);
    expect([...vault.files.keys()].length).toBe(3);
  });
});

describe("restoreRecoveryEntryV1", () => {
  it("writes an archived version back as a local file, leaving the archive alone", async () => {
    const { vault, index } = makeRecoveryIndex({
      files: { [ARCHIVE_PATH]: ARCHIVED_BYTES },
    });
    const restoreCloud = makeCloudRestore();

    const result = await restoreRecoveryEntryV1({
      index,
      entry: archiveEntry(),
      adapter: vault.adapter,
      cloud: restoreCloud,
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({ kind: "copy", newPath: NOTE_PATH });
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe("archived local version\n");
    expect(decode(await vault.adapter.readBinary(ARCHIVE_PATH)))
      .toBe("archived local version\n");
    expect(restoreCloud.restoreDeletedDriveItemById).not.toHaveBeenCalled();
  });

  it("copies a retained cloud version back as a local file", async () => {
    const { vault, index, cloud } = makeRecoveryIndex({
      remoteIds: { [NOTE_PATH]: "note-item-id" },
      download: async () => CLOUD_BYTES,
    });

    const result = await restoreRecoveryEntryV1({
      index,
      entry: cloudEntry(),
      adapter: vault.adapter,
      cloud: makeCloudRestore(),
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({ kind: "copy", newPath: NOTE_PATH });
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe("cloud version 1.0 bytes\n");
    expect(cloud.downloadDriveItemVersionContent).toHaveBeenCalledWith({
      driveItemId: "note-item-id",
      versionId: "1.0",
      downloadUrl: "https://cdn/1.0",
      size: CLOUD_BYTES.byteLength,
    });
  });

  it("writes the sync baseline text back as UTF-8 bytes", async () => {
    const { vault, index } = makeRecoveryIndex({
      baselines: { [NOTE_PATH]: BASELINE_TEXT },
    });

    const result = await restoreRecoveryEntryV1({
      index,
      entry: baselineEntry(),
      adapter: vault.adapter,
      cloud: makeCloudRestore(),
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({ kind: "copy", newPath: NOTE_PATH });
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe(BASELINE_TEXT);
  });

  it("writes the recovered copy next to a live file instead of over it", async () => {
    const { vault, index } = makeRecoveryIndex({
      files: {
        [ARCHIVE_PATH]: ARCHIVED_BYTES,
        [NOTE_PATH]: utf8("current live content\n"),
      },
    });

    const result = await restoreRecoveryEntryV1({
      index,
      entry: archiveEntry(),
      adapter: vault.adapter,
      cloud: makeCloudRestore(),
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({
      kind: "copy",
      newPath: `notes/note（找回 ${ARCHIVE_AT_STAMP}）.md`,
    });
    expect(decode(await vault.adapter.readBinary(NOTE_PATH)))
      .toBe("current live content\n");
  });

  it("stamps the displaced copy with the version's own time, not the click time", async () => {
    // 用户口径（2026-10-20）：副本装的是历史版本，文件名里的时间＝列表显示的
    // 那个版本时刻；点击时刻不是这份内容的身份。
    const { vault, index } = makeRecoveryIndex({
      remoteIds: { [NOTE_PATH]: "note-item-id" },
      files: { [NOTE_PATH]: utf8("current live content\n") },
    });

    const result = await restoreRecoveryEntryV1({
      index,
      entry: cloudEntry(),
      adapter: vault.adapter,
      cloud: makeCloudRestore(),
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({
      kind: "copy",
      newPath: `notes/note（找回 ${VERSION_AT_STAMP}）.md`,
    });
  });

  it("restores a deletion record through the cloud recycle bin", async () => {
    const { vault, index } = makeRecoveryIndex({});
    const restoreCloud = makeCloudRestore();

    const result = await restoreRecoveryEntryV1({
      index,
      entry: deletedEntry(),
      adapter: vault.adapter,
      cloud: restoreCloud,
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({
      kind: "cloud-restored",
      remoteId: "note-item-id",
    });
    expect(restoreCloud.restoreDeletedDriveItemById)
      .toHaveBeenCalledWith("note-item-id");
    // 删除记录的内容不在本机：本机一个字节都不写、一个字节都不读。
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(vault.adapter.readBinary).not.toHaveBeenCalled();
  });

  it("turns a recycle-bin refusal into an unavailable answer", async () => {
    const { vault, index } = makeRecoveryIndex({});
    const restoreCloud = makeCloudRestore();
    restoreCloud.restoreDeletedDriveItemById.mockRejectedValueOnce(
      new OneDriveError(OneDriveErrorType.NotFound, "already gone"),
    );

    const result: RecoveryRestoreResultV1 = await restoreRecoveryEntryV1({
      index,
      entry: deletedEntry(),
      adapter: vault.adapter,
      cloud: restoreCloud,
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({
      kind: "unavailable",
      reason: "content-unavailable",
    });
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("passes an already-unavailable entry through without touching anything", async () => {
    const { vault, index } = makeRecoveryIndex({});
    const restoreCloud = makeCloudRestore();
    const expired = deletedEntry({
      availability: "unavailable",
      reason: "expired",
    });

    const result = await restoreRecoveryEntryV1({
      index,
      entry: expired,
      adapter: vault.adapter,
      cloud: restoreCloud,
      tmpDir: TMP_DIR,
    });

    expect(result).toEqual({ kind: "unavailable", reason: "expired" });
    expect(restoreCloud.restoreDeletedDriveItemById).not.toHaveBeenCalled();
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("degrades a failed content read and a failed local write instead of throwing", async () => {
    const read = makeRecoveryIndex({
      remoteIds: { [NOTE_PATH]: "note-item-id" },
      download: async () => {
        throw new Error("version content is gone");
      },
    });
    await expect(restoreRecoveryEntryV1({
      index: read.index,
      entry: cloudEntry(),
      adapter: read.vault.adapter,
      cloud: makeCloudRestore(),
      tmpDir: TMP_DIR,
    })).resolves.toEqual({
      kind: "unavailable",
      reason: "content-unavailable",
    });
    expect(read.vault.adapter.writeBinary).not.toHaveBeenCalled();

    const write = makeRecoveryIndex({
      files: { [ARCHIVE_PATH]: ARCHIVED_BYTES },
      vaultOptions: {
        failWriteBinary: (target) => target.startsWith(`${TMP_DIR}/`),
      },
    });
    const writeFailure: RecoveryRestoreUnavailableReasonV1 = "write-failed";
    await expect(restoreRecoveryEntryV1({
      index: write.index,
      entry: archiveEntry(),
      adapter: write.vault.adapter,
      cloud: makeCloudRestore(),
      tmpDir: TMP_DIR,
    })).resolves.toEqual({ kind: "unavailable", reason: writeFailure });
    expect(write.vault.files.has(NOTE_PATH)).toBe(false);
  });
});
