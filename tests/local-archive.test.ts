// 冲突「保留云端版」前的本机版本留档（`src/sync/local-archive.ts`）。
// 纯函数钉住留档夹结构与撞名规则；执行函数钉住「字节逐份复制、不覆盖既有留档、
// 失败不落盘」三条约束。

import {
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  LocalArchiveSourceChangedError,
  listLocalArchiveEntriesV1,
  localArchiveDirV1,
  localArchiveFilePathV1,
  localArchiveStampV1,
  parseLocalArchiveStampV1,
  pruneExpiredLocalArchiveDirectoriesV1,
  writeLocalArchiveCopyV1,
  type LocalArchiveEntryV1,
} from "../src/sync/local-archive";

const PLUGIN_DIR = ".obsidian/plugins/easy-sync";
const TMP_DIR = `${PLUGIN_DIR}/tmp`;
const ARCHIVED_AT = new Date(2024, 0, 5, 9, 7).getTime();

function makeAdapter(
  initial: Record<string, ArrayBuffer>,
  options: { failWriteBinary?: (target: string) => boolean } = {},
) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    adapter: {
      exists: vi.fn(async (target: string) => files.has(target)),
      readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
      writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => {
        if (options.failWriteBinary?.(target)) throw new Error("disk full");
        files.set(target, bytes.slice(0));
      }),
      remove: vi.fn(async (target: string) => { files.delete(target); }),
      rename: vi.fn(async (from: string, to: string) => {
        const bytes = files.get(from);
        if (!bytes) throw new Error(`missing ${from}`);
        files.set(to, bytes);
        files.delete(from);
      }),
      mkdir: vi.fn(async () => undefined),
    },
  };
}

describe("local archive path contract", () => {
  it("stamps with the frozen colon-free yyyy-MM-dd HHmm format", () => {
    expect(localArchiveStampV1(ARCHIVED_AT)).toBe("2024-01-05 0907");
    // 留档夹名要能在 Windows／安卓上落地，也要与副本命名同一形状。
    const stamp = localArchiveStampV1(ARCHIVED_AT);
    expect(stamp).not.toContain(":");
    expect(stamp).not.toContain("/");
    // 无有效时间时退回当下，格式不变。
    expect(localArchiveStampV1(Number.NaN)).toMatch(/^\d{4}-\d{2}-\d{2} \d{4}$/);
  });

  it("maps a vault-relative path under archive/<stamp>/", () => {
    expect(localArchiveDirV1({ pluginDir: PLUGIN_DIR, archivedAt: ARCHIVED_AT }))
      .toBe(`${PLUGIN_DIR}/archive/2024-01-05 0907`);
    expect(localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: "notes/deep/note.md",
      archivedAt: ARCHIVED_AT,
    })).toBe(`${PLUGIN_DIR}/archive/2024-01-05 0907/notes/deep/note.md`);
  });

  it("keeps a taken name intact for the next kept version", () => {
    const first = localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: "notes/note.md",
      archivedAt: ARCHIVED_AT,
      attempt: 0,
    });
    expect(first).toBe(`${PLUGIN_DIR}/archive/2024-01-05 0907/notes/note.md`);
    expect(localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: "notes/note.md",
      archivedAt: ARCHIVED_AT,
      attempt: 1,
    })).toBe(`${PLUGIN_DIR}/archive/2024-01-05 0907/notes/note (2).md`);
    expect(localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: "notes/note.md",
      archivedAt: ARCHIVED_AT,
      attempt: 2,
    })).toBe(`${PLUGIN_DIR}/archive/2024-01-05 0907/notes/note (3).md`);
    // 无扩展名／点开头：撞名后缀落在整名之后，不制造新的扩展名。
    expect(localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: "README",
      archivedAt: ARCHIVED_AT,
      attempt: 1,
    })).toBe(`${PLUGIN_DIR}/archive/2024-01-05 0907/README (2)`);
    expect(localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: "notes/.hidden",
      archivedAt: ARCHIVED_AT,
      attempt: 1,
    })).toBe(`${PLUGIN_DIR}/archive/2024-01-05 0907/notes/.hidden (2)`);
  });
});

describe("local archive copy writing", () => {
  const sourcePath = "notes/note.md";
  const archivedAt = ARCHIVED_AT;

  async function makeSource(text: string) {
    const bytes = new TextEncoder().encode(text).buffer;
    return {
      bytes,
      expected: { size: bytes.byteLength, hash: await sha256Hex(bytes) },
    };
  }

  it("copies the reviewed local bytes into the archive and leaves the source alone", async () => {
    const { bytes, expected } = await makeSource("local version\n");
    const store = makeAdapter({ [sourcePath]: bytes });
    const result = await writeLocalArchiveCopyV1({
      adapter: store.adapter,
      path: sourcePath,
      pluginDir: PLUGIN_DIR,
      tmpDir: TMP_DIR,
      expected,
      archivedAt,
      isCurrent: () => true,
    });

    const archivePath = localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: sourcePath,
      archivedAt,
    });
    expect(result).toEqual({ archivePath });
    expect(new Uint8Array(store.files.get(archivePath)!)).toEqual(new Uint8Array(bytes));
    // 复制进档：原文件字节原地不动（覆盖链依赖它仍持有旧字节）。
    expect(new Uint8Array(store.files.get(sourcePath)!)).toEqual(new Uint8Array(bytes));
    // 暂存是改名的：不留第二份。
    expect([...store.files.keys()].sort()).toEqual([archivePath, sourcePath].sort());
  });

  it("never overwrites an existing archive of the same moment", async () => {
    const { bytes, expected } = await makeSource("local version\n");
    const takenPath = localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: sourcePath,
      archivedAt,
    });
    const takenBytes = new TextEncoder().encode("earlier archive\n").buffer;
    const store = makeAdapter({
      [sourcePath]: bytes,
      [takenPath]: takenBytes,
    });

    const result = await writeLocalArchiveCopyV1({
      adapter: store.adapter,
      path: sourcePath,
      pluginDir: PLUGIN_DIR,
      tmpDir: TMP_DIR,
      expected,
      archivedAt,
      isCurrent: () => true,
    });

    expect(result?.archivePath).toBe(localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: sourcePath,
      archivedAt,
      attempt: 1,
    }));
    expect(new Uint8Array(store.files.get(takenPath)!)).toEqual(new Uint8Array(takenBytes));
    expect(new Uint8Array(store.files.get(result!.archivePath)!)).toEqual(new Uint8Array(bytes));
  });

  it("refuses to archive a source that no longer matches the reviewed version", async () => {
    const { expected } = await makeSource("local version\n");
    const racedBytes = new TextEncoder().encode("raced\n").buffer;
    const store = makeAdapter({ [sourcePath]: racedBytes });

    await expect(writeLocalArchiveCopyV1({
      adapter: store.adapter,
      path: sourcePath,
      pluginDir: PLUGIN_DIR,
      tmpDir: TMP_DIR,
      expected,
      archivedAt,
      isCurrent: () => true,
    })).rejects.toBeInstanceOf(LocalArchiveSourceChangedError);

    expect([...store.files.keys()]).toEqual([sourcePath]);
  });

  it("writes nothing once the action was cancelled", async () => {
    const { bytes, expected } = await makeSource("local version\n");
    const store = makeAdapter({ [sourcePath]: bytes });

    const result = await writeLocalArchiveCopyV1({
      adapter: store.adapter,
      path: sourcePath,
      pluginDir: PLUGIN_DIR,
      tmpDir: TMP_DIR,
      expected,
      archivedAt,
      isCurrent: () => false,
    });

    expect(result).toBeNull();
    expect([...store.files.keys()]).toEqual([sourcePath]);
  });

  it("leaves no archive and no staging file when the copy write fails", async () => {
    const { bytes, expected } = await makeSource("local version\n");
    const store = makeAdapter(
      { [sourcePath]: bytes },
      { failWriteBinary: (target) => target.startsWith(`${TMP_DIR}/local-archive/`) },
    );

    await expect(writeLocalArchiveCopyV1({
      adapter: store.adapter,
      path: sourcePath,
      pluginDir: PLUGIN_DIR,
      tmpDir: TMP_DIR,
      expected,
      archivedAt,
      isCurrent: () => true,
    })).rejects.toThrow("disk full");

    expect([...store.files.keys()]).toEqual([sourcePath]);
  });
});

describe("local archive 30-day prune", () => {
  const CUTOFF = new Date(2024, 5, 1, 0, 0).getTime();

  function makeListing(folders: string[], failRmdir: (path: string) => boolean = () => false) {
    const archiveRoot = localArchiveDirV1({
      pluginDir: PLUGIN_DIR,
      archivedAt: CUTOFF,
    }).replace(/\/[^/]+$/, "");
    return {
      archiveRoot,
      adapter: {
        exists: vi.fn(async (target: string) => target === archiveRoot),
        list: vi.fn(async (target: string) => {
          if (target !== archiveRoot) return { files: [], folders: [] };
          return { files: [], folders: folders.map((name) => `${target}/${name}`) };
        }),
        rmdir: vi.fn(async (target: string) => {
          if (failRmdir(target)) throw new Error("Windows EPERM");
        }),
      },
    };
  }

  it("parses a stamp back to its wall-clock time and refuses anything else", () => {
    expect(parseLocalArchiveStampV1("2024-01-05 0907"))
      .toBe(new Date(2024, 0, 5, 9, 7).getTime());
    // 与格式化函数互为反函数：同一分钟往返稳定。
    expect(parseLocalArchiveStampV1(localArchiveStampV1(ARCHIVED_AT)))
      .toBe(ARCHIVED_AT);
    for (const name of [
      "archive",
      "2024-1-5 0907",
      "2024-01-05",
      "2024-01-05 09:07",
      "2024-01-05 0907 extra",
      "20240105 0907",
      "2024-13-05 0907",
      "2024-01-45 0907",
      "2024-01-05 2570",
      "",
    ]) {
      expect(parseLocalArchiveStampV1(name)).toBeNull();
    }
  });

  it("removes expired stamp directories and leaves newer ones untouched", async () => {
    const { adapter, archiveRoot } = makeListing([
      "2024-01-05 0907",
      "2024-05-31 2359",
      "2024-06-01 0000",
      "2024-06-01 0001",
    ]);

    const outcome = await pruneExpiredLocalArchiveDirectoriesV1({
      adapter,
      pluginDir: PLUGIN_DIR,
      cutoff: CUTOFF,
    });

    // 边界＝戳时间早于 cutoff 才删：整点同一分钟仍保留。
    expect(outcome).toEqual({
      removed: [
        `${archiveRoot}/2024-01-05 0907`,
        `${archiveRoot}/2024-05-31 2359`,
      ],
      failed: [],
    });
    expect(adapter.rmdir).toHaveBeenCalledTimes(2);
    expect(adapter.rmdir).toHaveBeenCalledWith(
      `${archiveRoot}/2024-01-05 0907`,
      true,
    );
  });

  it("never touches a directory whose name is not a stamp", async () => {
    const { adapter, archiveRoot } = makeListing([
      "backup",
      "2024-13-01 0000",
      "2024-01-05 0907",
    ]);

    const outcome = await pruneExpiredLocalArchiveDirectoriesV1({
      adapter,
      pluginDir: PLUGIN_DIR,
      cutoff: CUTOFF,
    });

    expect(outcome.removed).toEqual([`${archiveRoot}/2024-01-05 0907`]);
    expect(adapter.rmdir).toHaveBeenCalledTimes(1);
  });

  it("keeps pruning after one directory cannot be removed", async () => {
    const { adapter, archiveRoot } = makeListing(
      ["2024-01-05 0907", "2024-02-05 0907"],
      (target) => target.endsWith("2024-01-05 0907"),
    );

    const outcome = await pruneExpiredLocalArchiveDirectoriesV1({
      adapter,
      pluginDir: PLUGIN_DIR,
      cutoff: CUTOFF,
    });

    expect(outcome.removed).toEqual([`${archiveRoot}/2024-02-05 0907`]);
    expect(outcome.failed).toEqual([`${archiveRoot}/2024-01-05 0907`]);
  });

  it("does nothing when the archive folder does not exist yet", async () => {
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      rmdir: vi.fn(async () => undefined),
    };

    expect(await pruneExpiredLocalArchiveDirectoriesV1({
      adapter,
      pluginDir: PLUGIN_DIR,
      cutoff: CUTOFF,
    })).toEqual({ removed: [], failed: [] });
    expect(adapter.list).not.toHaveBeenCalled();
    expect(adapter.rmdir).not.toHaveBeenCalled();
  });
});

describe("local archive enumeration", () => {
  const ARCHIVE_ROOT = `${PLUGIN_DIR}/archive`;
  const STAMP_DIR = `${ARCHIVE_ROOT}/2024-01-05 0907`;
  const OTHER_STAMP_DIR = `${ARCHIVE_ROOT}/2024-02-06 1010`;
  const STAMP_AT = parseLocalArchiveStampV1("2024-01-05 0907");

  function makeListingAdapter(input: {
    directories: Record<string, { files: string[]; folders: string[] }>;
    sizes: Record<string, number | null>;
    failList?: (path: string) => boolean;
  }) {
    return {
      exists: vi.fn(async (target: string) => target in input.directories),
      list: vi.fn(async (target: string) => {
        if (input.failList?.(target)) throw new Error(`cannot list ${target}`);
        return input.directories[target] ?? { files: [], folders: [] };
      }),
      stat: vi.fn(async (target: string) => {
        const size = input.sizes[target];
        return size === undefined || size === null ? null : { size };
      }),
    };
  }

  it("lists files recursively, named relative to their stamp directory", async () => {
    const adapter = makeListingAdapter({
      directories: {
        [ARCHIVE_ROOT]: {
          // 根下的散文件不是留档：只有 `<戳>` 目录算。
          files: [`${ARCHIVE_ROOT}/loose.txt`],
          folders: [STAMP_DIR, OTHER_STAMP_DIR, `${ARCHIVE_ROOT}/backup`],
        },
        [STAMP_DIR]: {
          files: [`${STAMP_DIR}/note.md`],
          folders: [`${STAMP_DIR}/notes`],
        },
        [`${STAMP_DIR}/notes`]: {
          files: [
            `${STAMP_DIR}/notes/deep.md`,
            `${STAMP_DIR}/notes/taken (2).md`,
          ],
          folders: [],
        },
        [OTHER_STAMP_DIR]: {
          files: [`${OTHER_STAMP_DIR}/other.md`],
          folders: [],
        },
        [`${ARCHIVE_ROOT}/backup`]: {
          files: [`${ARCHIVE_ROOT}/backup/junk.md`],
          folders: [],
        },
      },
      sizes: {
        [`${ARCHIVE_ROOT}/loose.txt`]: 1,
        [`${STAMP_DIR}/note.md`]: 6,
        [`${STAMP_DIR}/notes/deep.md`]: 7,
        [`${STAMP_DIR}/notes/taken (2).md`]: 8,
        [`${OTHER_STAMP_DIR}/other.md`]: 9,
        [`${ARCHIVE_ROOT}/backup/junk.md`]: 10,
      },
    });

    const entries: LocalArchiveEntryV1[] = await listLocalArchiveEntriesV1({
      adapter,
      pluginDir: PLUGIN_DIR,
    });

    expect(entries).toEqual([
      { path: "note.md", archivedAt: STAMP_AT, size: 6 },
      { path: "notes/deep.md", archivedAt: STAMP_AT, size: 7 },
      { path: "notes/taken (2).md", archivedAt: STAMP_AT, size: 8 },
      {
        path: "other.md",
        archivedAt: parseLocalArchiveStampV1("2024-02-06 1010"),
        size: 9,
      },
    ]);
    // 枚举出的路径配 attempt 0 原样给出落盘文件：撞名换名的副本也取得到。
    expect(localArchiveFilePathV1({
      pluginDir: PLUGIN_DIR,
      path: entries[2].path,
      archivedAt: entries[2].archivedAt,
    })).toBe(`${STAMP_DIR}/notes/taken (2).md`);
  });

  it("skips bad stamps, unmeasurable files and unlistable directories one by one", async () => {
    const adapter = makeListingAdapter({
      directories: {
        [ARCHIVE_ROOT]: {
          files: [],
          folders: [STAMP_DIR, `${ARCHIVE_ROOT}/backup`, `${ARCHIVE_ROOT}/2024-13-01 0000`],
        },
        [STAMP_DIR]: {
          files: [`${STAMP_DIR}/kept.md`, `${STAMP_DIR}/vanished.md`],
          folders: [`${STAMP_DIR}/locked`],
        },
        [`${STAMP_DIR}/locked`]: {
          files: [`${STAMP_DIR}/locked/hidden.md`],
          folders: [],
        },
        [`${ARCHIVE_ROOT}/backup`]: {
          files: [`${ARCHIVE_ROOT}/backup/junk.md`],
          folders: [],
        },
        [`${ARCHIVE_ROOT}/2024-13-01 0000`]: {
          files: [`${ARCHIVE_ROOT}/2024-13-01 0000/junk.md`],
          folders: [],
        },
      },
      sizes: {
        [`${STAMP_DIR}/kept.md`]: 3,
        [`${STAMP_DIR}/vanished.md`]: null,
        [`${STAMP_DIR}/locked/hidden.md`]: 4,
        [`${ARCHIVE_ROOT}/backup/junk.md`]: 5,
        [`${ARCHIVE_ROOT}/2024-13-01 0000/junk.md`]: 6,
      },
      failList: (target) => target === `${STAMP_DIR}/locked`,
    });

    expect(await listLocalArchiveEntriesV1({
      adapter,
      pluginDir: PLUGIN_DIR,
    })).toEqual([{ path: "kept.md", archivedAt: STAMP_AT, size: 3 }]);
  });

  it("answers an empty list when the archive root is absent", async () => {
    const adapter = makeListingAdapter({ directories: {}, sizes: {} });

    expect(await listLocalArchiveEntriesV1({
      adapter,
      pluginDir: PLUGIN_DIR,
    })).toEqual([]);
    expect(adapter.list).not.toHaveBeenCalled();
  });
});
