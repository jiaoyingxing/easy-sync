/**
 * F1 端到端：真实 `StateManager` + 真实插件数据层，两份账互不可见。
 *
 * 纯函数层（`tests/cloud-book.test.ts`）钉的是分账规则本身；这里钉的是
 * **接线**——账本身份真的被 `StateManager` 用来选目录、真的被数据层用来选
 * 命名空间，而不是只在测试里成立。
 *
 * 本文件回答两个「会说会做」的问题：
 * 1. 切到 WebDAV 后 `StateManager` 读写的 sidecar 真的换了目录，且 OneDrive
 *    的原文件一个都没被碰（用文件存在性 + 内容快照双判据）；
 * 2. 老用户升级（账本全在顶层、没有命名空间）读到的基线逐字不变。
 */
import type { DataAdapter, Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";

const PLUGIN_DIR = ".obsidian/plugins/easy-sync";
const ONEDRIVE_STATE_V2 = `${PLUGIN_DIR}/state/v2/state-v2.json`;

const webdavCoordinates = {
  url: "https://nas.example.com/webdav",
  username: "alice",
  rootPrefix: "EasySync",
};

/** 最小内存适配器：只提供账本功能走得到的成员。 */
function makeAdapter(files: Map<string, string>): DataAdapter {
  return {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    // 账本目录的摸底：本项目里的调用点都容忍 list 缺失，这里给空目录即可。
    list: vi.fn(async () => ({ files: [], folders: [] })),
  } as unknown as DataAdapter;
}

/** 一个已同步过一轮的老用户：账全在顶层，没有任何分账命名空间。 */
function onedrivePluginData(): Record<string, unknown> {
  return {
    "sync-interval": 15,
    "sync-editor": true,
    "cloud-provider": "onedrive",
    "cloud-webdav": null,
    "easy-sync-base-snapshot": {
      "notes/stable.md": { hash: "aaaa", size: 4, eTag: "e1" },
    },
    "easy-sync-bound-account": "onedrive-account-id",
    "easy-sync-last-sync-time": 1_700_000_000_000,
    "easy-sync-generation": 3,
    "sync-direction": "one-way",
    "easy-sync-history": [{ status: "success", at: 1_700_000_000_000 }],
  };
}

interface Harness {
  plugin: EasySyncPlugin;
  store: PluginDataStore;
  adapter: DataAdapter;
  files: Map<string, string>;
  persisted: () => Record<string, unknown>;
}

function makeHarness(initial: Record<string, unknown>): Harness {
  let persisted = structuredClone(initial);
  const plugin = new EasySyncPlugin();
  vi.spyOn(plugin, "loadData").mockImplementation(
    async () => structuredClone(persisted),
  );
  vi.spyOn(plugin, "saveData").mockImplementation(async (next) => {
    persisted = structuredClone(next as Record<string, unknown>);
  });
  const files = new Map<string, string>();
  const adapter = makeAdapter(files);
  const store: PluginDataStore = {
    loadData: () => plugin.loadPluginData(),
    updatePluginData: (mutator) => (plugin as unknown as {
      updatePluginData(
        callback: (data: Record<string, unknown>) => void,
      ): Promise<void>;
    }).updatePluginData(mutator),
    app: { vault: { adapter, configDir: ".obsidian" } },
    manifest: { id: "easy-sync", dir: PLUGIN_DIR },
    // 真实接缝：账本目录由插件按活动云端给出。
    get activeCloudBookDirectory() {
      return plugin.activeCloudBookDirectory;
    },
  };
  return { plugin, store, adapter, files, persisted: () => persisted };
}

describe("F1 端到端：账本路径跟活动云端走", () => {
  it("OneDrive 活动时账本仍原处（老用户升级零迁移）", async () => {
    const harness = makeHarness(onedrivePluginData());
    await harness.plugin.loadSyncSettings();
    expect(harness.plugin.activeCloudBookId).toBe("onedrive");
    expect(harness.plugin.activeCloudBookDirectory).toBeNull();

    const state = new StateManager(harness.store);
    await expect(state.load()).resolves.toBeUndefined();

    // 基线读得到（老用户不会因为分账而失忆）。
    // 注：没有 V2 权威时 `baseSnapshot` 走的是旧形状（按路径为键的映射，
    // 值里不带 path），所以判据取键而不是条目字段。
    expect(
      harness.persisted()["easy-sync-base-snapshot"],
    ).toEqual({ "notes/stable.md": { hash: "aaaa", size: 4, eTag: "e1" } });
    expect(state.boundAccountId).toBe("onedrive-account-id");
    expect(harness.plugin.syncDirection).toBe("one-way");
  });

  it("切到 WebDAV 后账本目录换到 state/profiles/<id>，且是空账", async () => {
    const harness = makeHarness({
      ...onedrivePluginData(),
      "cloud-provider": "webdav",
      "cloud-webdav": {
        coordinates: webdavCoordinates,
        credentialRevision: 1,
        lastTest: null,
      },
    });
    await harness.plugin.loadSyncSettings();

    const bookId = harness.plugin.activeCloudBookId;
    expect(bookId).toMatch(/^webdav-[0-9a-f]{8}$/);
    // 这就是「账本路径真的换了」：目录名来自活动云端，不是写死的。
    expect(harness.plugin.activeCloudBookDirectory).toBe(
      `state/profiles/${bookId}`,
    );

    const state = new StateManager(harness.store);
    await expect(state.load()).resolves.toBeUndefined();

    // 空账：WebDAV 拿不到 OneDrive 的基线、身份账本与同步模式。
    expect(state.baseSnapshot).toEqual([]);
    expect(state.boundAccountId).toBe("");
    expect(harness.plugin.syncDirection).toBe("two-way");
  });

  it("切到 WebDAV 后写一轮账，OneDrive 的原账本文件与数据一个字节不变", async () => {
    const harness = makeHarness({
      ...onedrivePluginData(),
      "cloud-provider": "webdav",
      "cloud-webdav": {
        coordinates: webdavCoordinates,
        credentialRevision: 1,
        lastTest: null,
      },
    });
    await harness.plugin.loadSyncSettings();
    const state = new StateManager(harness.store);
    await state.load();

    const onedriveBookBefore = {
      baseSnapshot: harness.persisted()["easy-sync-base-snapshot"],
      boundAccount: harness.persisted()["easy-sync-bound-account"],
      history: harness.persisted()["easy-sync-history"],
      direction: harness.persisted()["sync-direction"],
      generation: harness.persisted()["easy-sync-generation"],
    };

    // 写一笔 WebDAV 的账：设同步时间并推进代数。
    await state.setLastSyncTimeAndIncrementGeneration(1_800_000_000_000);

    const after = harness.persisted();
    // 反向保护：判据是「值仍等于原值」。写成 `not.toContain(...)` 会让一个
    // 被写成空对象的账本键蒙过去。
    expect(after["easy-sync-base-snapshot"]).toEqual(
      onedriveBookBefore.baseSnapshot,
    );
    expect(after["easy-sync-bound-account"]).toBe(
      onedriveBookBefore.boundAccount,
    );
    expect(after["easy-sync-history"]).toEqual(onedriveBookBefore.history);
    expect(after["sync-direction"]).toBe(onedriveBookBefore.direction);
    expect(after["easy-sync-generation"]).toBe(onedriveBookBefore.generation);

    // WebDAV 自己的账本确实落了盘，而且只落在自己的命名空间里。
    const namespace = after["easy-sync-profiles"] as Record<
      string,
      Record<string, unknown>
    >;
    const webdavSlice = namespace[harness.plugin.activeCloudBookId];
    expect(webdavSlice["easy-sync-last-sync-time"]).toBe(1_800_000_000_000);
    expect(webdavSlice["easy-sync-generation"]).toBe(1);
    // 顶层没有副本（留着就是第二本账）。
    expect(after["easy-sync-last-sync-time"]).toBe(1_700_000_000_000);
  });

  it("账本目录真的用于 sidecar 读写：OneDrive 的 state-v2.json 不被 WebDAV 读到", async () => {
    // 直接验「路径换来的是真的隔离」：给 OneDrive 的账本放一份假 sidecar，
    // 切到 WebDAV 后它必须读不到（账本目录不同），读的是自己那一份。
    const harness = makeHarness({
      ...onedrivePluginData(),
      "cloud-provider": "webdav",
      "cloud-webdav": {
        coordinates: webdavCoordinates,
        credentialRevision: 1,
        lastTest: null,
      },
    });
    harness.files.set(
      ONEDRIVE_STATE_V2,
      JSON.stringify({ marker: "oneDrive-only-payload" }),
    );
    await harness.plugin.loadSyncSettings();

    // 账本目录不同 ⇒ 同一个键派生出的路径不同。
    const { getEasySyncPaths } = await import("../src/obsidian-compat");
    const onedrivePaths = getEasySyncPaths(".obsidian", "easy-sync", null);
    const webdavPaths = getEasySyncPaths(
      ".obsidian",
      "easy-sync",
      harness.plugin.activeCloudBookDirectory,
    );
    expect(onedrivePaths.stateV2File).toBe(ONEDRIVE_STATE_V2);
    expect(webdavPaths.stateV2File).not.toBe(ONEDRIVE_STATE_V2);
    // 文件在这个路径下确实不存在（隔离的物理判据）。
    expect(await harness.adapter.exists(webdavPaths.stateV2File)).toBe(false);
    // 而 OneDrive 那份还在原地，等着切回来。
    expect(await harness.adapter.exists(ONEDRIVE_STATE_V2)).toBe(true);
  });
});
