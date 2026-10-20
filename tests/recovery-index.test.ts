// 找回读面（`src/sync/recovery-index.ts`）：四源聚合、排序、按需读内容。
// 全部只读：内存 adapter ＋ 假状态面 ＋ 假云面，不写任何文件、不发写请求。

import { describe, expect, it, vi } from "vitest";
import type { DriveItemVersion } from "../src/onedrive/types";
import type { DeletionLedgerEntryV1 } from "../src/sync/deletion-ledger";
import {
  localArchiveFilePathV1,
  parseLocalArchiveStampV1,
} from "../src/sync/local-archive";
import {
  RecoveryIndexV1,
  type RecoveryContentV1,
  type RecoveryEntryV1,
  type RecoveryHandleV1,
  type RecoveryIndexDepsV1,
  type RecoverySource,
  type RecoveryUnavailableReason,
} from "../src/sync/recovery-index";

const PLUGIN_DIR = ".obsidian/plugins/easy-sync";
const ARCHIVE_ROOT = `${PLUGIN_DIR}/archive`;
const STAMP_NAME = "2026-10-18 1430";
const STAMP_AT = parseLocalArchiveStampV1(STAMP_NAME)!;
const NOTE_PATH = "notes/note.md";
const NOTE_HASH = "ab".repeat(32);

const VERSION_2_AT = new Date(2026, 9, 19, 14, 0).getTime();
const VERSION_1_AT = new Date(2026, 9, 18, 10, 0).getTime();
const DELETED_AT = new Date(2026, 9, 17, 9, 0).getTime();
const BASELINE_AT = new Date(2026, 9, 16, 8, 0).getTime();
const NOW = new Date(2026, 9, 19, 20, 0).getTime();

function utf8(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function decode(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

/** 内存留档盘：从「文件全路径 → 字节数」反推目录树（null＝读不出）。 */
function makeArchiveAdapter(files: Record<string, number | null>) {
  const directories = new Map<
    string,
    { files: string[]; folders: Set<string> }
  >();
  const ensure = (dir: string) => {
    const existing = directories.get(dir);
    if (existing) return existing;
    const created = { files: [] as string[], folders: new Set<string>() };
    directories.set(dir, created);
    return created;
  };
  for (const file of Object.keys(files)) {
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index++) {
      const dir = ensure(segments.slice(0, index).join("/"));
      if (index + 1 < segments.length) {
        dir.folders.add(segments.slice(0, index + 1).join("/"));
      } else {
        dir.files.push(file);
      }
    }
  }
  return {
    adapter: {
      exists: vi.fn(async (path: string) => directories.has(path)),
      list: vi.fn(async (path: string) => {
        const entry = directories.get(path);
        if (!entry) throw new Error(`not a directory: ${path}`);
        return { files: [...entry.files], folders: [...entry.folders] };
      }),
      stat: vi.fn(async (path: string) => {
        const size = files[path];
        return size === undefined || size === null ? null : { size };
      }),
      readBinary: vi.fn(async (path: string) => {
        if (files[path] === undefined || files[path] === null) {
          throw new Error(`missing: ${path}`);
        }
        return utf8(`archive bytes of ${path}`);
      }),
    },
  };
}

function makeState(input: {
  remoteIds?: Record<string, string>;
  remoteEtags?: Record<string, string>;
  ledger?: DeletionLedgerEntryV1[];
  baselines?: Record<
    string,
    { hash: string; size: number; at: number; content?: string }
  >;
}) {
  const baselines = input.baselines ?? {};
  return {
    remoteIdForPath: vi.fn((path: string) => input.remoteIds?.[path]),
    remoteETagForPath: vi.fn((path: string) => input.remoteEtags?.[path]),
    deletionLedgerEntries: (input.ledger ?? []) as readonly DeletionLedgerEntryV1[],
    getBaseContent: vi.fn(async (path: string) => baselines[path]?.content),
    baselineFactsForPath: vi.fn((path: string) => {
      const facts = baselines[path];
      return facts === undefined
        ? undefined
        : { hash: facts.hash, size: facts.size, at: facts.at };
    }),
  };
}

function makeCloud(input: {
  versions?: Record<string, DriveItemVersion[]>;
  listVersions?: (driveItemId: string) => Promise<DriveItemVersion[]>;
  download?: RecoveryIndexDepsV1["cloud"]["downloadDriveItemVersionContent"];
}) {
  return {
    listDriveItemVersionsById: vi.fn(
      input.listVersions
      ?? (async (driveItemId: string) => input.versions?.[driveItemId] ?? []),
    ),
    downloadDriveItemVersionContent: vi.fn(
      input.download ?? (async () => utf8("cloud bytes")),
    ),
  };
}

function makeIndex(input: {
  archives: Record<string, number | null>;
  state: ReturnType<typeof makeState>;
  cloud: ReturnType<typeof makeCloud>;
}) {
  const store = makeArchiveAdapter(input.archives);
  return {
    store,
    index: new RecoveryIndexV1({
      adapter: store.adapter,
      pluginDir: PLUGIN_DIR,
      state: input.state,
      cloud: input.cloud,
    }),
  };
}

describe("RecoveryIndexV1.listRecoveryEntries (global)", () => {
  it("aggregates local archives and deletion records without scanning the cloud", async () => {
    const archivePath = `${ARCHIVE_ROOT}/${STAMP_NAME}/${NOTE_PATH}`;
    const draftPath = `${ARCHIVE_ROOT}/${STAMP_NAME}/drafts/plan.md`;
    const expiredAt = NOW - 40 * 24 * 60 * 60 * 1000;
    const state = makeState({
      ledger: [
        {
          remoteId: "gone-folder-id",
          path: "gone/folder",
          deletedAt: new Date(2026, 9, 19, 19, 0).getTime(),
          kind: "folder",
        },
        {
          remoteId: "note-record-id",
          path: NOTE_PATH,
          deletedAt: STAMP_AT,
          kind: "file",
        },
        {
          remoteId: "expired-id",
          path: "old.md",
          deletedAt: expiredAt,
          kind: "file",
        },
      ],
    });
    const cloud = makeCloud({});
    const { index } = makeIndex({
      archives: {
        [archivePath]: 1024,
        [draftPath]: 512,
        // 坏戳目录与根下散文件都不是留档。
        [`${ARCHIVE_ROOT}/backup/junk.md`]: 9,
        [`${ARCHIVE_ROOT}/loose.txt`]: 3,
      },
      state,
      cloud,
    });

    const entries = await index.listRecoveryEntries({ scope: "global", now: NOW });

    expect(entries.map((entry) => [entry.source, entry.path])).toEqual([
      ["deleted-record", "gone/folder"],
      ["local-archive", "drafts/plan.md"],
      ["local-archive", "notes/note.md"],
      ["deleted-record", "notes/note.md"],
      ["deleted-record", "old.md"],
    ]);
    // 同 at（留档戳与删除时刻）时来源顺序固定：留档先于删除记录。
    expect(entries[1].at).toBe(STAMP_AT);
    expect(entries[2].at).toBe(STAMP_AT);
    expect(entries[3].at).toBe(STAMP_AT);
    expect(entries[1]).toEqual({
      source: "local-archive",
      path: "drafts/plan.md",
      at: STAMP_AT,
      size: 512,
      availability: "available",
      handle: {
        kind: "local-archive",
        archivePath: localArchiveFilePathV1({
          pluginDir: PLUGIN_DIR,
          path: "drafts/plan.md",
          archivedAt: STAMP_AT,
        }),
      },
    });
    // 已出窗口的删除记录如实标过期，仍留在列表里（摘除由记录簿自己负责）。
    expect(entries[4]).toEqual({
      source: "deleted-record",
      path: "old.md",
      at: expiredAt,
      availability: "unavailable",
      reason: "expired",
      handle: {
        kind: "deleted-record",
        remoteId: "expired-id",
        entryKind: "file",
      },
    });
    // 总列表不扫云端。
    expect(cloud.listDriveItemVersionsById).not.toHaveBeenCalled();
  });
});

describe("RecoveryIndexV1.listRecoveryEntries (path)", () => {
  it("aggregates the four sources of one path and sorts by time desc", async () => {
    const archivePath = `${ARCHIVE_ROOT}/${STAMP_NAME}/${NOTE_PATH}`;
    const versions: DriveItemVersion[] = [
      {
        id: "2.0",
        size: 2048,
        lastModifiedDateTime: new Date(VERSION_2_AT).toISOString(),
        "@microsoft.graph.downloadUrl": "https://cdn/2.0",
      },
      {
        id: "1.0",
        size: 1024,
        lastModifiedDateTime: new Date(VERSION_1_AT).toISOString(),
      },
      // 缺 id（无从取内容）与缺可解析时刻（排不上时间轴）的版本不上列表。
      { id: "", size: 1, lastModifiedDateTime: new Date(VERSION_2_AT).toISOString() },
      { id: "1.5", size: 4, lastModifiedDateTime: "not-a-time" },
    ];
    const state = makeState({
      remoteIds: { [NOTE_PATH]: "note-item-id" },
      // 锚点 eTag 尾号＝当前版本号（2.0）：当前版本不成行，只剩 1.0。
      remoteEtags: { [NOTE_PATH]: `"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},2"` },
      ledger: [
        {
          remoteId: "note-item-id",
          path: NOTE_PATH,
          deletedAt: DELETED_AT,
          kind: "file",
        },
        {
          remoteId: "other-id",
          path: "other/deep.md",
          deletedAt: DELETED_AT,
          kind: "file",
        },
      ],
      baselines: {
        [NOTE_PATH]: {
          hash: NOTE_HASH,
          size: 2048,
          at: BASELINE_AT,
          content: "# baseline\n",
        },
      },
    });
    const cloud = makeCloud({ versions: { "note-item-id": versions } });
    const { index } = makeIndex({
      archives: {
        [archivePath]: 1024,
        [`${ARCHIVE_ROOT}/${STAMP_NAME}/other/deep.md`]: 77,
      },
      state,
      cloud,
    });

    const entries = await index.listRecoveryEntries({
      scope: { path: NOTE_PATH },
      now: NOW,
    });

    expect(entries).toEqual([
      {
        source: "local-archive",
        path: NOTE_PATH,
        at: STAMP_AT,
        size: 1024,
        availability: "available",
        handle: { kind: "local-archive", archivePath },
      },
      {
        source: "cloud-version",
        path: NOTE_PATH,
        at: VERSION_1_AT,
        size: 1024,
        availability: "available",
        handle: { kind: "cloud-version", versionId: "1.0" },
      },
      {
        source: "deleted-record",
        path: NOTE_PATH,
        at: DELETED_AT,
        availability: "available",
        handle: {
          kind: "deleted-record",
          remoteId: "note-item-id",
          entryKind: "file",
        },
      },
      {
        source: "sync-baseline",
        path: NOTE_PATH,
        at: BASELINE_AT,
        size: 2048,
        availability: "available",
        handle: { kind: "sync-baseline", hash: NOTE_HASH },
      },
    ]);
    expect(cloud.listDriveItemVersionsById).toHaveBeenCalledWith("note-item-id");
  });

  it("reports the cloud source as unavailable when the path has no committed remote identity", async () => {
    const state = makeState({});
    const cloud = makeCloud({});
    const { index } = makeIndex({ archives: {}, state, cloud });

    const entries = await index.listRecoveryEntries({
      scope: { path: "never-synced.md" },
      now: NOW,
    });

    // 无基线＝该源缺席；没有云端身份＝该源如实标不可用。
    expect(entries).toEqual([{
      source: "cloud-version",
      path: "never-synced.md",
      at: NOW,
      availability: "unavailable",
      reason: "no-remote-identity",
    }]);
    expect(cloud.listDriveItemVersionsById).not.toHaveBeenCalled();
    expect(state.baselineFactsForPath).toHaveBeenCalledWith("never-synced.md");
  });

  it("degrades an empty history, a failing listing and a contentless baseline in place", async () => {
    const state = makeState({
      remoteIds: { "note.md": "item-id", "offline.md": "offline-id" },
      // 基线只有锚点事实、没有可读内容（二进制／超限）。
      baselines: {
        "note.md": { hash: NOTE_HASH, size: 10, at: BASELINE_AT },
      },
    });
    const cloud = makeCloud({
      versions: { "item-id": [] },
      listVersions: async (driveItemId: string) => {
        if (driveItemId === "offline-id") throw new Error("graph down");
        return [];
      },
    });
    const { index } = makeIndex({ archives: {}, state, cloud });

    const entries = await index.listRecoveryEntries({
      scope: { path: "note.md" },
      now: NOW,
    });

    expect(entries).toEqual([
      {
        source: "cloud-version",
        path: "note.md",
        at: NOW,
        availability: "unavailable",
        reason: "no-version-history",
      },
      // 内容读不出的快照行不出（2026-10-20 用户定案：零动作行＝噪声）。
    ]);

    const offline = await index.listRecoveryEntries({
      scope: { path: "offline.md" },
      now: NOW,
    });
    expect(offline).toEqual([{
      source: "cloud-version",
      path: "offline.md",
      at: NOW,
      availability: "unavailable",
      reason: "content-unavailable",
    }]);
  });
});

describe("RecoveryIndexV1 cloud version current-row exclusion", () => {
  const path = "notes/note.md";
  // 覆写形状（2026-10-19 真机实测）：第一条＝当前版本，其后是旧版本。
  const retained: DriveItemVersion[] = [
    {
      id: "2.0",
      size: 2048,
      lastModifiedDateTime: new Date(VERSION_2_AT).toISOString(),
      "@microsoft.graph.downloadUrl": "https://cdn/2.0",
    },
    {
      id: "1.0",
      size: 1024,
      lastModifiedDateTime: new Date(VERSION_1_AT).toISOString(),
      "@microsoft.graph.downloadUrl": "https://cdn/1.0",
    },
  ];

  function cloudRows(entries: RecoveryEntryV1[]): string[] {
    return entries
      .filter((entry) => entry.source === "cloud-version")
      .map((entry) => entry.handle?.kind === "cloud-version"
        ? entry.handle.versionId
        : `${entry.availability}:${entry.reason}`);
  }

  it("drops the current version by the anchor's eTag version number", async () => {
    const state = makeState({
      remoteIds: { [path]: "item-id" },
      remoteEtags: { [path]: `"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},2"` },
    });
    const cloud = makeCloud({ versions: { "item-id": retained } });
    const { index } = makeIndex({ archives: {}, state, cloud });

    const entries = await index.listRecoveryEntries({ scope: { path }, now: NOW });

    expect(cloudRows(entries)).toEqual(["1.0"]);
    expect(entries).toEqual([{
      source: "cloud-version",
      path,
      at: VERSION_1_AT,
      size: 1024,
      availability: "available",
      handle: {
        kind: "cloud-version",
        versionId: "1.0",
        downloadUrl: "https://cdn/1.0",
      },
    }]);
  });

  it("reports no history when the only retained version is the current one", async () => {
    const state = makeState({
      remoteIds: { [path]: "item-id" },
      remoteEtags: { [path]: `"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},2"` },
    });
    const cloud = makeCloud({ versions: { "item-id": [retained[0]] } });
    const { index } = makeIndex({ archives: {}, state, cloud });

    const entries = await index.listRecoveryEntries({ scope: { path }, now: NOW });

    // 一条必然取不到内容的"当前版本"行都不许出现。
    expect(entries).toEqual([{
      source: "cloud-version",
      path,
      at: NOW,
      availability: "unavailable",
      reason: "no-version-history",
    }]);
  });

  it("drops the first row when the anchor carries no usable eTag", async () => {
    // 依据＝版本列表按 newest→oldest 排序（Graph 文档明确），且 2026-10-19 真机
    // 实测同形；锚点没有 eTag 尾号时第一条就是当前版本。
    const state = makeState({ remoteIds: { [path]: "item-id" } });
    const cloud = makeCloud({ versions: { "item-id": retained } });
    const { index } = makeIndex({ archives: {}, state, cloud });

    const entries = await index.listRecoveryEntries({ scope: { path }, now: NOW });

    expect(cloudRows(entries)).toEqual(["1.0"]);
  });
});

describe("RecoveryIndexV1.readRecoveryContent", () => {
  it("reads archive bytes, cloud version bytes, baseline text, and asks for a cloud restore on a deletion record", async () => {
    const archivePath = `${ARCHIVE_ROOT}/${STAMP_NAME}/${NOTE_PATH}`;
    const state = makeState({
      remoteIds: { [NOTE_PATH]: "note-item-id" },
      // 2.0 是当前版本（锚点 eTag 尾号）：可恢复的那一条是 1.0。
      remoteEtags: { [NOTE_PATH]: `"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},2"` },
      ledger: [{
        remoteId: "note-item-id",
        path: NOTE_PATH,
        deletedAt: DELETED_AT,
        kind: "file",
      }],
      baselines: {
        [NOTE_PATH]: {
          hash: NOTE_HASH,
          size: 2048,
          at: BASELINE_AT,
          content: "# baseline\n",
        },
      },
    });
    const cloud = makeCloud({
      versions: {
        "note-item-id": [
          {
            id: "2.0",
            size: 2048,
            lastModifiedDateTime: new Date(VERSION_2_AT).toISOString(),
            "@microsoft.graph.downloadUrl": "https://cdn/2.0",
          },
          {
            id: "1.0",
            size: 1024,
            lastModifiedDateTime: new Date(VERSION_1_AT).toISOString(),
            "@microsoft.graph.downloadUrl": "https://cdn/1.0",
          },
        ],
      },
      download: async () => utf8("cloud bytes of 1.0"),
    });
    const { store, index } = makeIndex({
      archives: { [archivePath]: 1024 },
      state,
      cloud,
    });
    const entries = await index.listRecoveryEntries({
      scope: { path: NOTE_PATH },
      now: NOW,
    });
    const bySource = (source: RecoverySource): RecoveryEntryV1 =>
      entries.find((entry) => entry.source === source)!;

    const answered: RecoveryContentV1[] = [
      await index.readRecoveryContent(bySource("local-archive")),
      await index.readRecoveryContent(bySource("cloud-version")),
      await index.readRecoveryContent(bySource("sync-baseline")),
    ];
    expect(answered.map((content) => content.kind)).toEqual([
      "bytes",
      "bytes",
      "text",
    ]);
    expect(decode((answered[0] as { bytes: ArrayBuffer }).bytes))
      .toBe(`archive bytes of ${archivePath}`);
    expect(decode((answered[1] as { bytes: ArrayBuffer }).bytes))
      .toBe("cloud bytes of 1.0");
    expect(answered[2]).toEqual({ kind: "text", text: "# baseline\n" });
    expect(cloud.downloadDriveItemVersionContent).toHaveBeenCalledWith({
      driveItemId: "note-item-id",
      versionId: "1.0",
      downloadUrl: "https://cdn/1.0",
      size: 1024,
    });

    // 删除记录：内容不在本机，只能如实说要走云端恢复；不做任何读取。
    const readCountBefore = store.adapter.readBinary.mock.calls.length;
    const downloadCountBefore =
      cloud.downloadDriveItemVersionContent.mock.calls.length;
    await expect(index.readRecoveryContent(bySource("deleted-record")))
      .resolves.toEqual({
        kind: "requiresCloudRestore",
        requiresCloudRestore: true,
      });
    expect(store.adapter.readBinary.mock.calls.length).toBe(readCountBefore);
    expect(cloud.downloadDriveItemVersionContent.mock.calls.length)
      .toBe(downloadCountBefore);
  });

  it("answers an unavailable entry with its reason and never reads", async () => {
    const state = makeState({
      ledger: [{
        remoteId: "expired-id",
        path: "old.md",
        deletedAt: NOW - 40 * 24 * 60 * 60 * 1000,
        kind: "file",
      }],
    });
    const cloud = makeCloud({});
    const { store, index } = makeIndex({ archives: {}, state, cloud });

    const entries = await index.listRecoveryEntries({ scope: "global", now: NOW });

    const expiredReason: RecoveryUnavailableReason = "expired";
    await expect(index.readRecoveryContent(entries[0])).resolves.toEqual({
      kind: "unavailable",
      reason: expiredReason,
    });
    expect(store.adapter.readBinary).not.toHaveBeenCalled();
    expect(cloud.downloadDriveItemVersionContent).not.toHaveBeenCalled();
  });

  it("degrades a failed version read and a missing archive byte read instead of throwing", async () => {
    const archivePath = `${ARCHIVE_ROOT}/${STAMP_NAME}/${NOTE_PATH}`;
    const state = makeState({ remoteIds: { [NOTE_PATH]: "note-item-id" } });
    const cloud = makeCloud({
      versions: {
        // 锚点没有 eTag ⇒ 退回"摘第一条"（列表 newest→oldest），留下 1.0。
        "note-item-id": [
          {
            id: "2.0",
            lastModifiedDateTime: new Date(VERSION_2_AT).toISOString(),
          },
          {
            id: "1.0",
            lastModifiedDateTime: new Date(VERSION_1_AT).toISOString(),
          },
        ],
      },
      download: async () => {
        throw new Error("version content is gone");
      },
    });
    const { store, index } = makeIndex({
      archives: { [archivePath]: 1024 },
      state,
      cloud,
    });
    const entries = await index.listRecoveryEntries({
      scope: { path: NOTE_PATH },
      now: NOW,
    });
    const handles: RecoveryHandleV1[] = entries
      .map((entry) => entry.handle)
      .filter((handle): handle is RecoveryHandleV1 => handle !== undefined);
    expect(handles.map((handle) => handle.kind).sort()).toEqual([
      "cloud-version",
      "local-archive",
    ]);

    // 留档在列举之后消失：读取如实标不可用，不抛。
    store.adapter.readBinary.mockRejectedValueOnce(new Error("gone"));
    await expect(index.readRecoveryContent(entries[0])).resolves.toEqual({
      kind: "unavailable",
      reason: "content-unavailable",
    });
    await expect(index.readRecoveryContent(entries[1])).resolves.toEqual({
      kind: "unavailable",
      reason: "content-unavailable",
    });
  });
});

describe("RecoveryIndexV1 一致过滤（与当前文件一模一样的不列）", () => {
  const FIRST_STAMP = "2026-10-18 1430";
  const SECOND_STAMP = "2026-10-19 1530";
  const ARCHIVE_A = `${ARCHIVE_ROOT}/${FIRST_STAMP}/${NOTE_PATH}`;
  const ARCHIVE_B = `${ARCHIVE_ROOT}/${SECOND_STAMP}/${NOTE_PATH}`;

  /** 与 makeArchiveAdapter 同形，但 readBinary 返回真实内容（同文比对用）。 */
  function makeTextAdapter(files: Record<string, string | ArrayBuffer>) {
    const directories = new Map<
      string,
      { files: string[]; folders: Set<string> }
    >();
    const ensure = (dir: string) => {
      const existing = directories.get(dir);
      if (existing) return existing;
      const created = { files: [] as string[], folders: new Set<string>() };
      directories.set(dir, created);
      return created;
    };
    for (const file of Object.keys(files)) {
      const segments = file.split("/");
      for (let index = 1; index < segments.length; index++) {
        const dir = ensure(segments.slice(0, index).join("/"));
        if (index + 1 < segments.length) {
          dir.folders.add(segments.slice(0, index + 1).join("/"));
        } else {
          dir.files.push(file);
        }
      }
    }
    return {
      adapter: {
        exists: vi.fn(async (path: string) =>
          files[path] !== undefined || directories.has(path)),
        list: vi.fn(async (path: string) => {
          const entry = directories.get(path);
          if (!entry) throw new Error(`not a directory: ${path}`);
          return { files: [...entry.files], folders: [...entry.folders] };
        }),
        stat: vi.fn(async (path: string) => {
          const value = files[path];
          if (value === undefined) return null;
          const size = typeof value === "string"
            ? new TextEncoder().encode(value).byteLength
            : value.byteLength;
          return { size };
        }),
        readBinary: vi.fn(async (path: string) => {
          const value = files[path];
          if (value === undefined) throw new Error(`missing: ${path}`);
          return typeof value === "string" ? utf8(value) : value;
        }),
      },
    };
  }

  function makeFilterIndex(input: {
    files: Record<string, string | ArrayBuffer>;
    state: ReturnType<typeof makeState>;
  }) {
    const store = makeTextAdapter(input.files);
    return {
      store,
      index: new RecoveryIndexV1({
        adapter: store.adapter,
        pluginDir: PLUGIN_DIR,
        state: input.state,
        cloud: makeCloud({}),
      }),
    };
  }

  it("drops the path-scoped baseline row whose content equals the current file", async () => {
    const state = makeState({
      baselines: {
        [NOTE_PATH]: {
          hash: NOTE_HASH,
          size: 13,
          at: BASELINE_AT,
          content: "同一份\n",
        },
      },
    });
    const { index } = makeFilterIndex({
      files: { [NOTE_PATH]: "同一份\n" },
      state,
    });

    const entries = await index.listRecoveryEntries({
      scope: { path: NOTE_PATH },
      now: NOW,
    });

    // "和现在一样"的那条不是历史：基线不占行，该路径只剩云端身份缺席的如实说明。
    expect(entries).toEqual([{
      source: "cloud-version",
      path: NOTE_PATH,
      at: NOW,
      availability: "unavailable",
      reason: "no-remote-identity",
    }]);
  });

  it("keeps the baseline and archive rows that differ from the current file", async () => {
    const state = makeState({
      baselines: {
        [NOTE_PATH]: {
          hash: NOTE_HASH,
          size: 21,
          at: BASELINE_AT,
          content: "变化前\n",
        },
      },
    });
    const { index } = makeFilterIndex({
      files: { [ARCHIVE_A]: "变化前的留档\n", [NOTE_PATH]: "变化后\n" },
      state,
    });

    const entries = await index.listRecoveryEntries({
      scope: { path: NOTE_PATH },
      now: NOW,
    });

    expect(entries.map((entry) => entry.source).sort()).toEqual([
      "cloud-version",
      "local-archive",
      "sync-baseline",
    ]);
  });

  it("keeps the baseline when the current file is gone (可能是唯一副本)", async () => {
    const state = makeState({
      baselines: {
        [NOTE_PATH]: {
          hash: NOTE_HASH,
          size: 13,
          at: BASELINE_AT,
          content: "同一份\n",
        },
      },
    });
    const { index } = makeFilterIndex({
      files: { [ARCHIVE_A]: "同一份\n" },
      state,
    });

    const entries = await index.listRecoveryEntries({
      scope: { path: NOTE_PATH },
      now: NOW,
    });

    // 没有现文件可比 ⇒ "一致"无从谈起：基线与留档都保留。
    expect(entries.map((entry) => entry.source).sort()).toEqual([
      "cloud-version",
      "local-archive",
      "sync-baseline",
    ]);
    expect(entries.find((entry) => entry.source === "sync-baseline")?.availability)
      .toBe("available");
  });

  it("drops an identical archive row in the global list but keeps a divergent one", async () => {
    const state = makeState({});
    const { index } = makeFilterIndex({
      files: {
        [NOTE_PATH]: "同一份\n",
        [ARCHIVE_A]: "同一份\n",
        [ARCHIVE_B]: "变化后的留档\n",
      },
      state,
    });

    const entries = await index.listRecoveryEntries({ scope: "global", now: NOW });

    expect(entries.map((entry) => [entry.source, entry.at])).toEqual([
      ["local-archive", parseLocalArchiveStampV1(SECOND_STAMP)!],
    ]);
  });

  it("keeps archive rows beyond the byte budget or non-UTF-8 (查不动＝保留)", async () => {
    const oversized = new Uint8Array(1_048_577).fill(0x30).buffer as ArrayBuffer;
    const binary = new Uint8Array([0xff, 0xff, 0xff]).buffer as ArrayBuffer;
    const state = makeState({});
    const { index } = makeFilterIndex({
      files: {
        "a.md": oversized,
        [`${ARCHIVE_ROOT}/${FIRST_STAMP}/a.md`]: oversized,
        "b.md": binary,
        [`${ARCHIVE_ROOT}/${SECOND_STAMP}/b.md`]: binary,
      },
      state,
    });

    const entries = await index.listRecoveryEntries({ scope: "global", now: NOW });

    // 超过预算的照实列（size 真实）；二进制的解不出文本＝不比。
    expect(entries.map((entry) => entry.source)).toEqual([
      "local-archive",
      "local-archive",
    ]);
    expect(entries.map((entry) => entry.size).sort((a, b) => (b ?? 0) - (a ?? 0)))
      .toEqual([oversized.byteLength, binary.byteLength]);
  });
});

describe("RecoveryIndexV1 删除记录夹行过滤（附属夹行不上列表）", () => {
  it("hides a folder record when the files inside it are recorded as rows", async () => {
    const state = makeState({
      ledger: [
        { remoteId: "folder-id", path: "同步测试", deletedAt: NOW - 60_000, kind: "folder" },
        { remoteId: "file-id", path: "同步测试/b.md", deletedAt: NOW - 30_000, kind: "file" },
        { remoteId: "other-id", path: "top.md", deletedAt: NOW - 20_000, kind: "file" },
      ],
    });
    const { index } = makeIndex({ archives: {}, state, cloud: makeCloud({}) });

    const entries = await index.listRecoveryEntries({ scope: "global", now: NOW });

    // 夹内有文件行各自握钥匙：文件夹空壳不上列表（用户 2026-10-20 定案）。
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "top.md",
      "同步测试/b.md",
    ]);
  });

  it("keeps a folder record when it is the only recorded door (subtree delete)", async () => {
    const state = makeState({
      ledger: [
        { remoteId: "tree-root-id", path: "整棵子树", deletedAt: NOW - 60_000, kind: "folder" },
      ],
    });
    const { index } = makeIndex({ archives: {}, state, cloud: makeCloud({}) });

    const entries = await index.listRecoveryEntries({ scope: "global", now: NOW });

    // 审阅子树刀只记根一条：夹行是那棵树唯一的找回入口，必须保留展示。
    expect(entries.map((entry) => entry.path)).toEqual(["整棵子树"]);
    expect(entries[0].handle).toEqual({
      kind: "deleted-record",
      remoteId: "tree-root-id",
      entryKind: "folder",
    });
  });
});
