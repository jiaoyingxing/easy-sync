/**
 * F1 云端分账：账本身份、分账边界与「两份账互不可见」的反向保护。
 *
 * 病根（2026-11-22～23 追问收敛）：一台设备只容得下一本同步账，而这本账
 * 从没写过自己属于哪份远端。切到 WebDAV 后 WebDAV 的远端内容被记进
 * OneDrive 的账，切回来时 OneDrive 的文件全被判成新增。
 *
 * 本文件钉四件事：
 * 1) OneDrive 的账在顶层原地（升级零迁移，降级也读得到）；
 * 2) WebDAV 的账只从自己的命名空间读，**绝不回退到顶层**（那是分账白做）；
 * 3) 切换账本时，另一本账一个字节都不被读写；
 * 4) 分账键清单与源码常量逐字一致（漏登记会红，不是静默留在原地）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloudBookDirectory,
  liftCloudBookView,
  pushCloudBookView,
  resolveActiveCloudBookId,
} from "../src/cloud/cloud-book";
import {
  EMPTY_CLOUD_SETTINGS,
  readCloudSettings,
} from "../src/cloud/cloud-settings";
import { getEasySyncPaths } from "../src/obsidian-compat";

const CLOUD_KEYS = { provider: "cloud-provider", webdav: "cloud-webdav" };
const ONEDRIVE = "onedrive";

const webdavCoordinates = {
  url: "https://nas.example.com/webdav",
  username: "alice",
  rootPrefix: "EasySync",
};

/** 一份「老用户」物理数据：账本键全在顶层，没有命名空间。 */
function legacyPhysicalData(): Record<string, unknown> {
  return {
    "sync-interval": 15,
    "sync-editor": true,
    "easy-sync-base-snapshot": { "a.md": { eTag: "1" } },
    "easy-sync-bound-account": "onedrive-account-id",
    "easy-sync-history": [{ status: "success" }],
    "sync-direction": "one-way",
    "cloud-provider": "onedrive",
    "cloud-webdav": null,
  };
}

/** 已切到 WebDAV 的物理数据：OneDrive 的账仍在顶层。 */
function switchedPhysicalData(): Record<string, unknown> {
  return {
    ...legacyPhysicalData(),
    "cloud-provider": "webdav",
    "cloud-webdav": {
      coordinates: webdavCoordinates,
      credentialRevision: 1,
      lastTest: null,
    },
    "easy-sync-profiles": {
      "webdav-fixture": {
        "easy-sync-base-snapshot": { "b.md": { eTag: "2" } },
        "easy-sync-bound-account": "webdav-bound",
      },
    },
  };
}

describe("F1 账本身份", () => {
  it("OneDrive 与「坐标不全」都解析成 OneDrive 的账（fail-closed）", () => {
    expect(resolveActiveCloudBookId({}, CLOUD_KEYS)).toBe(ONEDRIVE);
    expect(resolveActiveCloudBookId({
      "cloud-provider": "onedrive",
      "cloud-webdav": null,
    }, CLOUD_KEYS)).toBe(ONEDRIVE);
    // provider 指向 webdav 但坐标缺失：readCloudSettings 已退回 OneDrive，
    // 这里必须跟着退回，不能凭一条坏配置开一本谁也不认识的账。
    expect(resolveActiveCloudBookId({
      "cloud-provider": "webdav",
      "cloud-webdav": null,
    }, CLOUD_KEYS)).toBe(ONEDRIVE);
  });

  it("WebDAV 的账 id 只由地址／根路径／用户名决定", () => {
    const base = resolveActiveCloudBookId({
      "cloud-provider": "webdav",
      "cloud-webdav": {
        coordinates: webdavCoordinates,
        credentialRevision: 1,
        lastTest: null,
      },
    }, CLOUD_KEYS);
    expect(base).toMatch(/^webdav-[0-9a-f]{8}$/);
    // 界面永不显示这个串，但它必须是稳定的目录名。
    expect(base).not.toBe(ONEDRIVE);

    // 改密码（凭据版本）：同一本账——改密码不该让同步基线失联。
    expect(resolveActiveCloudBookId({
      "cloud-provider": "webdav",
      "cloud-webdav": {
        coordinates: webdavCoordinates,
        credentialRevision: 7,
        lastTest: null,
      },
    }, CLOUD_KEYS)).toBe(base);

    // 改地址／根路径／用户名：换了一个云端，旧账保留但不再命中。
    for (const changed of [
      { ...webdavCoordinates, url: "https://other.example.com/webdav" },
      { ...webdavCoordinates, rootPrefix: "Elsewhere" },
      { ...webdavCoordinates, username: "bob" },
    ]) {
      expect(resolveActiveCloudBookId({
        "cloud-provider": "webdav",
        "cloud-webdav": {
          coordinates: changed,
          credentialRevision: 1,
          lastTest: null,
        },
      }, CLOUD_KEYS)).not.toBe(base);
    }
  });

  it("OneDrive 没有分账目录，其他账有", () => {
    expect(cloudBookDirectory(ONEDRIVE)).toBeNull();
    expect(cloudBookDirectory("webdav-3f9a1c7d")).toBe(
      "state/profiles/webdav-3f9a1c7d",
    );
  });
});

describe("F1 账本视图：OneDrive 原地、WebDAV 另开一份", () => {
  it("OneDrive 视图就是物理数据去掉命名空间，账本键原封不动", () => {
    const raw = switchedPhysicalData();
    const view = liftCloudBookView(raw, ONEDRIVE);
    expect(view["easy-sync-base-snapshot"]).toEqual({ "a.md": { eTag: "1" } });
    expect(view["easy-sync-bound-account"]).toBe("onedrive-account-id");
    // 命名空间不暴露：它是别的账的容器，不属于任何一本账的视图。
    expect(view["easy-sync-profiles"]).toBeUndefined();
    // 设备键照常在。
    expect(view["sync-interval"]).toBe(15);
  });

  it("WebDAV 视图只取自己的命中，绝不回退到顶层", () => {
    const raw = switchedPhysicalData();
    const view = liftCloudBookView(raw, "webdav-fixture");
    // 自己的命中。
    expect(view["easy-sync-base-snapshot"]).toEqual({ "b.md": { eTag: "2" } });
    // 没命中＝空账，**不是** OneDrive 的账——回退就是把 OneDrive 的基线
    // 交给 WebDAV 用，正是本刀要根除的故障。
    expect(view["easy-sync-history"]).toBeUndefined();
    expect(view["sync-direction"]).toBeUndefined();
    // 设备键在两本账间共用（描述「这台设备怎么同步」，不描述「我和云端的
    // 关系」）。
    expect(view["sync-interval"]).toBe(15);
    expect(view["sync-editor"]).toBe(true);
  });

  it("全新的 WebDAV 账从空账开始，拿不到 OneDrive 的任何账本键", () => {
    const view = liftCloudBookView(legacyPhysicalData(), "webdav-brand-new");
    expect(view["easy-sync-base-snapshot"]).toBeUndefined();
    expect(view["easy-sync-bound-account"]).toBeUndefined();
    expect(view["easy-sync-history"]).toBeUndefined();
    expect(view["sync-direction"]).toBeUndefined();
    expect(view["sync-interval"]).toBe(15);
  });
});

describe("F1 写回：切换账本时另一本账零改动", () => {
  it("写 WebDAV 的账不动顶层的 OneDrive 账", () => {
    const raw = switchedPhysicalData();
    const before = JSON.parse(JSON.stringify(raw));
    const view = liftCloudBookView(raw, "webdav-fixture");
    view["easy-sync-base-snapshot"] = { "c.md": { eTag: "3" } };
    const next = pushCloudBookView(raw, view, "webdav-fixture");

    // 反向保护：用「值仍然等于原值」而不是「某字符串不存在」——后者会让
    // 一个不小心被写成空对象的账本键蒙过去。
    expect(next["easy-sync-base-snapshot"]).toEqual(
      before["easy-sync-base-snapshot"],
    );
    expect(next["easy-sync-bound-account"]).toBe(
      before["easy-sync-bound-account"],
    );
    expect(next["easy-sync-history"]).toEqual(before["easy-sync-history"]);
    expect(next["sync-direction"]).toBe(before["sync-direction"]);
    // 顶层账本键没有副本：留着它就是第二本账，下次读会读到它。
    expect(next["easy-sync-base-snapshot"]).toEqual({ "a.md": { eTag: "1" } });
    // 自己的槽位确实更新了。
    expect(
      (next["easy-sync-profiles"] as Record<string, Record<string, unknown>>)
        ["webdav-fixture"]["easy-sync-base-snapshot"],
    ).toEqual({ "c.md": { eTag: "3" } });
  });

  it("写 OneDrive 的账不动命名空间里的 WebDAV 账", () => {
    const raw = switchedPhysicalData();
    const namespaceBefore = JSON.parse(
      JSON.stringify(raw["easy-sync-profiles"]),
    );
    const view = liftCloudBookView(raw, ONEDRIVE);
    view["easy-sync-base-snapshot"] = { "d.md": { eTag: "4" } };
    const next = pushCloudBookView(raw, view, ONEDRIVE);

    expect(next["easy-sync-profiles"]).toEqual(namespaceBefore);
    expect(next["easy-sync-base-snapshot"]).toEqual({ "d.md": { eTag: "4" } });
    expect(next["cloud-provider"]).toBe("webdav");
  });

  it("视图里缺席的账本键在写回时被删掉（删除语义能落到盘上）", () => {
    const raw = switchedPhysicalData();
    const view = liftCloudBookView(raw, "webdav-fixture");
    delete view["easy-sync-bound-account"];
    const next = pushCloudBookView(raw, view, "webdav-fixture");
    expect(
      (next["easy-sync-profiles"] as Record<string, Record<string, unknown>>)
        ["webdav-fixture"],
    ).not.toHaveProperty("easy-sync-bound-account");
    // OneDrive 的那一份不受影响。
    expect(next["easy-sync-bound-account"]).toBe("onedrive-account-id");
  });

  it("圆回来：摊平再压回，物理数据逐字不变", () => {
    // 这是「读路径零改动」的形式化保证。两个方向各测一遍。
    for (const [raw, bookId] of [
      [legacyPhysicalData(), ONEDRIVE],
      [switchedPhysicalData(), ONEDRIVE],
      [switchedPhysicalData(), "webdav-fixture"],
    ] as Array<[Record<string, unknown>, string]>) {
      const view = liftCloudBookView(raw, bookId);
      const roundTripped = pushCloudBookView(raw, view, bookId);
      expect(roundTripped).toEqual(raw);
    }
  });
});

describe("F1 落点：账本 sidecar 按云端实例分目录", () => {
  it("OneDrive 的路径与改造前逐字一致", () => {
    // 升级零迁移的全部依据：老用户读到的路径一个字节都没变。
    const paths = getEasySyncPaths(".obsidian", "easy-sync", null);
    expect(paths.stateV2File).toBe(
      ".obsidian/plugins/easy-sync/state/v2/state-v2.json",
    );
    expect(paths.baseContentFile).toBe(
      ".obsidian/plugins/easy-sync/state/legacy/base-content.json",
    );
    expect(paths.ancestorsV2Dir).toBe(
      ".obsidian/plugins/easy-sync/objects/ancestors-v2",
    );
    // 缺省参数与显式 null 同义（所有既有调用点都不传第三个参数）。
    expect(getEasySyncPaths(".obsidian", "easy-sync")).toEqual(paths);
  });

  it("WebDAV 的账落在 state/profiles/<id> 下，且与 OneDrive 的文件不相交", () => {
    const onedrive = getEasySyncPaths(".obsidian", "easy-sync", null);
    const webdav = getEasySyncPaths(
      ".obsidian",
      "easy-sync",
      "state/profiles/webdav-3f9a1c7d",
    );
    expect(webdav.stateV2File).toBe(
      ".obsidian/plugins/easy-sync/state/profiles/webdav-3f9a1c7d/state/v2/state-v2.json",
    );
    // 逐项核对：没有任何一本账的 sidecar 路径与另一本相同。用「路径不相等」
    // 而不是「某文件不存在」——后者在纯函数层判不了。
    const sidecarKeys = [
      "remoteStateFile",
      "stateV2File",
      "stateV2NextFile",
      "stateV2PreviousFile",
      "stateV2RecoveryFile",
      "stateV2ManifestFile",
      "stateV2ManifestNextFile",
      "stateV2AuthorityWitnessFile",
      "stateV2AuthorityWitnessNextFile",
      "stateV2IndexedDbRecoveryDir",
      "stateV2RetiredManifestFile",
      "stateV2RollbackFile",
      "stateV2MigrationHoldFile",
      "stateV2ScopeTransitionFile",
      "stateV1BackupFile",
      "baseContentFile",
      "deletionLedgerFile",
      "ancestorsV2Dir",
      "ancestorManifestV2File",
      "logsDir",
      "tmpDir",
      "scanCacheFile",
      "remoteEnumCheckpointFile",
    ] as const;
    for (const key of sidecarKeys) {
      expect(webdav[key]).not.toBe(onedrive[key]);
      // 真在账本子目录里，而不是只拼了个不同的字符串。
      expect(webdav[key]).toContain("/state/profiles/webdav-3f9a1c7d/");
    }
    // data.json 与 manifest.json 由宿主按插件 id 固定，挪不动也不该挪。
    expect(webdav.dataFile).toBe(onedrive.dataFile);
    expect(webdav.manifestFile).toBe(onedrive.manifestFile);
  });
});

describe("F1 分账键清单的完整性", () => {
  /**
   * 清单是手写的，所以必须有东西在「新增／改名一个 data.json 键」时变红。
   * 判据：源码里每个 `KEY_*` 常量的字面量，要么进清单（跟云端走），要么
   * 出现在下面这份显式豁免表里并写明理由（跟设备走）。
   */
  const DEVICE_LOCAL_KEYS = new Set([
    // 这台设备怎么同步
    "sync-interval",
    "auto-sync-change-delay-seconds",
    "auto-sync-restore-interval",
    "auto-sync-restore-change-delay-seconds",
    "auto-sync-on-startup",
    "auto-sync-restore-on-startup",
    "sync-plugin-files",
    "sync-max-file-size-mb",
    "sync-diagnostic-logging",
    "sync-editor",
    "sync-appearance",
    "sync-themes",
    "sync-hotkeys",
    "sync-core-plugins",
    "sync-bookmarks",
    "sync-community-plugins",
    "sync-plugin-data",
    "lan-acceleration",
    "lan-acceleration-threshold-mb",
    "community-plugin-sync-policy",
    "sync-excluded-folders",
    // 路径身份文件夹改名的跨轮续做记录：只描述本设备已开始的半移动，
    // 别的设备没有同一份 V2 锚点，不能继承这条进行中的意图。
    "easy-sync-pending-path-identity-folder-moves",
    "auto-sync-paused",
    // 切换云端后的「首轮须手动」标记：哪台设备切过就由哪台自己跑第一轮，
    // 不跟着账本走（F3-c）。
    "easy-sync-activation-first-manual",
    "sync-auto-merge",
    "sync-auto-conflict-policy",
    "notification-popups",
    "mobile-status-bar",
    "acknowledged-rules",
    "vault-cloud-client-warning-snooze-date",
    // 设备级身份／秘密／一次性提示
    "easy-sync-lan-pairing-v1",
    "easy-sync-profile-cache",
    "easy-sync-account-credential-binding-v1",
    "easy-sync-upload-downgrade-notice-v1",
    "last-reset-facts",
    // 云端身份本身就是「读哪一本账」的输入，不能自己跟自己分账。
    "cloud-provider",
    "cloud-webdav",
    // 1.2.7 兼容投影：只读输入，且每次写盘都会显式删除。
    "community-plugin-enablement-state",
  ]);

  function sourceKeyLiterals(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(
          /^const (KEY_[A-Z0-9_]+)(?:\s*=\s*\n?\s*)"([^"]+)"/gm,
        )) {
          const relative = path.relative(process.cwd(), full)
            .split(path.sep).join("/");
          found.set(match[2], [...(found.get(match[2]) ?? []), relative]);
        }
      }
    };
    walk("src");
    return found;
  }

  it("每个 data.json 键都被显式归入账本或设备，没有漏网的", () => {
    const lib = readFileSync("src/cloud/cloud-book.ts", "utf8");
    const bookKeys = new Set(
      [...lib.matchAll(/^  "([^"]+)",/gm)].map((match) => match[1]),
    );
    const unclassified: string[] = [];
    for (const [literal, files] of sourceKeyLiterals()) {
      if (bookKeys.has(literal) || DEVICE_LOCAL_KEYS.has(literal)) continue;
      unclassified.push(`${literal} (${files.join(", ")})`);
    }
    expect(unclassified).toEqual([]);
  });

  it("清单与豁免表不重叠，且清单里没有源码不存在的键", () => {
    const lib = readFileSync("src/cloud/cloud-book.ts", "utf8");
    const bookKeys = [...lib.matchAll(/^  "([^"]+)",/gm)]
      .map((match) => match[1]);
    // 一个键不能既跟云端走又跟设备走。
    expect(bookKeys.filter((key) => DEVICE_LOCAL_KEYS.has(key))).toEqual([]);
    // 清单里不能有拼错的键：每个都必须真的在源码里出现过。
    const literals = new Set(sourceKeyLiterals().keys());
    expect(bookKeys.filter((key) => !literals.has(key))).toEqual([]);
    // 反假绿：清单与豁免表都不是空的，扫描面也真的扫到了东西。
    expect(bookKeys.length).toBeGreaterThan(20);
    expect(DEVICE_LOCAL_KEYS.size).toBeGreaterThan(20);
    expect(literals.size).toBeGreaterThan(50);
  });

  it("云端字段不进账本：它们决定读哪一本账", () => {
    const lib = readFileSync("src/cloud/cloud-book.ts", "utf8");
    expect(lib).not.toMatch(/^  "cloud-provider",$/m);
    expect(lib).not.toMatch(/^  "cloud-webdav",$/m);
    // 但它们是设备事实，必须被 readCloudSettings 认得。
    expect(readCloudSettings({
      "cloud-provider": "onedrive",
    }, CLOUD_KEYS)).toEqual(EMPTY_CLOUD_SETTINGS);
  });
});
