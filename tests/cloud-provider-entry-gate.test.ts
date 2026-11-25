/**
 * 云端入口可见性与 WebDAV 单向模式闸门（W2b）。
 *
 * 历史（2026-11-21 用户指出后拆除）：这里曾有一层构建期白名单
 * （`__EASYSYNC_CLOUD_PROVIDERS__`，实施者自行加的临时措施）。它失败时是
 * **静默**的——读端写了写端没写、投放脚本把开关覆盖掉、同步出去的是关闭版，
 * 三次事故全部源于此，排查成本远高于它想防的问题。用户要求：入口默认显示，
 * 能力状态用「试验性」标注说明。
 *
 * 本文件钉四件事：
 * 1) 维护页「实验性」组无条件出现 WebDAV 行（2026-11-24 起暂离登录页）；
 * 2) 白名单标识符不许回来（源码与构建脚本双向断言）；
 * 3) WebDAV 生效时同步模式行不出现「单向同步」选项，并显示原因说明；
 * 4) OneDrive 生效时选项与说明逐字保持现状（零回归）。
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLoginPage,
  buildMaintenancePage,
  renderSyncModeRow,
} from "../src/ui/settings-tab";
import { computeWebDavConfigFingerprint } from "../src/cloud/cloud-settings";
import { I18n } from "../src/i18n";
import type EasySyncPlugin from "../src/main";

const globals = globalThis as { __EASYSYNC_CLOUD_PROVIDERS__?: string };

afterEach(() => {
  delete globals.__EASYSYNC_CLOUD_PROVIDERS__;
  vi.restoreAllMocks();
});

interface WebdavFixtureOptions {
  /** true＝加一条「测试通过」的记录（这一行因此算「已部署」）。 */
  connection?: { tested: boolean } | null;
  /** 活动云端是不是 WebDAV；缺省＝有连接记录即活动。 */
  active?: boolean;
  hasPassword?: boolean;
  loggedIn?: boolean;
}

/** 已连接的连接记录：`lastTest` 的指纹必须与坐标一致，否则状态会算成 `untested`。 */
function testedConnection(): Record<string, unknown> {
  const coordinates = {
    url: "https://nas.example.com/webdav",
    username: "alice",
    rootPrefix: "EasySync",
  };
  const credentialRevision = 1;
  return {
    coordinates,
    credentialRevision,
    lastTest: {
      testedAt: 1_700_000_000_000,
      ok: true,
      configFingerprint: computeWebDavConfigFingerprint(
        coordinates,
        credentialRevision,
      ),
    },
  };
}

function webdavPlugin(options: WebdavFixtureOptions = {}): EasySyncPlugin {
  const connection = options.connection === undefined
    ? {
      coordinates: {
        url: "https://nas.example.com/webdav",
        username: "alice",
        rootPrefix: "EasySync",
      },
      credentialRevision: 1,
      lastTest: null,
    }
    : options.connection === null
      ? null
      : testedConnection();
  return {
    app: {} as never,
    auth: {
      authState: {
        isLoggedIn: options.loggedIn === true,
        displayName: options.loggedIn === true ? "Alice" : undefined,
        accountName: "",
      },
      isInitializing: false,
      isPending: false,
      deviceAttempt: null,
    },
    cloudSettings: {
      provider: connection && options.active !== false ? "webdav" : "onedrive",
      webdav: connection,
    },
    hasSavedWebDavPassword: options.hasPassword ?? true,
    syncDirection: "two-way",
    i18n: new I18n("zh-cn"),
    getIgnoredLocalOnlyCount: () => 0,
    lanAccelerationEnabled: false,
    logoutUser: vi.fn().mockResolvedValue(undefined),
    openWebDavConfig: vi.fn().mockResolvedValue(undefined),
    deactivateCloudAndRestoreOneDrive: vi.fn().mockResolvedValue(true),
  } as unknown as EasySyncPlugin;
}

function onedrivePlugin(): EasySyncPlugin {
  return {
    app: {} as never,
    auth: {
      authState: { isLoggedIn: true, displayName: "Alice", accountName: "" },
      isInitializing: false,
      isPending: false,
      deviceAttempt: null,
    },
    cloudSettings: { provider: "onedrive", webdav: null },
    hasSavedWebDavPassword: false,
    syncDirection: "one-way",
    i18n: new I18n("zh-cn"),
    getIgnoredLocalOnlyCount: () => 0,
    lanAccelerationEnabled: false,
    logoutUser: vi.fn().mockResolvedValue(undefined),
    openWebDavConfig: vi.fn().mockResolvedValue(undefined),
  } as unknown as EasySyncPlugin;
}

/**
 * 最小 Setting 替身：只保留 `renderSyncModeRow` 真正用到的成员。
 *
 * `addDropdown` 记录回调，调用方自己驱动 `onChange` 即可观察选项集合。
 */
interface FakeDropdown {
  options: { value: string; label: string }[];
  value: string;
  onChangeHandler: ((value: string) => Promise<void>) | null;
  addOption(value: string, label: string): FakeDropdown;
  setValue(value: string): FakeDropdown;
  onChange(handler: (value: string) => Promise<void>): FakeDropdown;
}

/** 声明式行按钮的最小替身：记录文案与形态（主按钮／破坏性）。 */
interface FakeButton {
  text: string;
  isCta: boolean;
  isDestructive: boolean;
  onClickHandler: (() => void) | null;
  setButtonText(text: string): FakeButton;
  setCta(): FakeButton;
  setDestructive(): FakeButton;
  onClick(handler: () => void): FakeButton;
}

function fakeButton(): FakeButton {
  const button: FakeButton = {
    text: "",
    isCta: false,
    isDestructive: false,
    onClickHandler: null,
    setButtonText(text) {
      this.text = text;
      return this;
    },
    setCta() {
      this.isCta = true;
      return this;
    },
    setDestructive() {
      this.isDestructive = true;
      return this;
    },
    onClick(handler) {
      this.onClickHandler = handler;
      return this;
    },
  };
  return button;
}

/**
 * 走一遍真实渲染入口，返回该行按钮的形态。
 *
 * 登录页账号行与维护页 WebDAV 行仍是平级云端入口，按钮形态必须一致——用户
 * 2026-11-21 目测到一紫一灰，看起来像一个是主操作、一个是被禁用的次要项。
 * 2026-11-24 起 WebDAV 行暂在「维护 → 实验性」，形态判据不变。
 */
function renderRowButton(
  page: { items?: Array<{ name?: string; render?: (s: never) => void }> },
  rowName: string,
): FakeButton | null {
  const row = (page.items ?? []).find((item) => item.name === rowName);
  if (!row?.render) return null;
  const button = fakeButton();
  const setting = {
    addButton: (configure: (b: FakeButton) => void) => {
      configure(button);
    },
  };
  row.render(setting as never);
  return button;
}

interface MaintenancePageItem {
  name?: string;
  render?: (s: never) => void;
  heading?: string;
  items?: MaintenancePageItem[];
}

function flattenMaintenance(
  items: readonly MaintenancePageItem[],
): MaintenancePageItem[] {
  return items.flatMap((item) =>
    item.items ? [item, ...flattenMaintenance(item.items)] : [item],
  );
}

function maintenancePage(plugin: EasySyncPlugin): {
  items?: MaintenancePageItem[];
} {
  const i18n = new I18n("zh-cn");
  const t = i18n.t.bind(i18n);
  const page = buildMaintenancePage(t, plugin, {
    plugin,
    t,
    refresh: vi.fn(),
    noteExclusionChange: vi.fn(),
  }) as unknown as { items?: MaintenancePageItem[] };
  return { items: flattenMaintenance(page.items ?? []) };
}

function fakeSetting(): {
  setting: never;
  dropdown: FakeDropdown;
  hintText: () => string;
} {
  const dropdown: FakeDropdown = {
    options: [],
    value: "",
    onChangeHandler: null,
    addOption(value, label) {
      this.options.push({ value, label });
      return this;
    },
    setValue(value) {
      this.value = value;
      return this;
    },
    onChange(handler) {
      this.onChangeHandler = handler;
      return this;
    },
  };
  let hint = "";
  const setting = {
    setName: () => setting,
    addDropdown: (configure: (d: FakeDropdown) => void) => {
      configure(dropdown);
      return setting;
    },
    descEl: {
      createDiv: () => ({
        setText: (text: string) => {
          hint = text;
        },
      }),
    },
  };
  return { setting: setting as never, dropdown, hintText: () => hint };
}

describe("云端入口始终可见（2026-11-21 撤掉构建期白名单）", () => {
  it("维护页实验性组无条件出现 WebDAV 行", () => {
    // 白名单已按用户要求拆除；2026-11-24 用户又要求把 WebDAV 入口暂移
    // 「维护 → 实验性」，直到它达到主流可用。这里钉“无条件可见 + 位置”。
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const page = maintenancePage(webdavPlugin());
    const items = page.items ?? [];
    const experimental = items.find(
      (item) => item.heading === t("settings.experimental.heading"),
    );
    const webdavRow = items.find(
      (item) => item.name === t("settings.webdav.connection.name"),
    );
    expect(experimental).toBeDefined();
    expect(webdavRow).toBeDefined();
    expect(items.indexOf(webdavRow!)).toBeGreaterThan(items.indexOf(experimental!));
    expect(items.map((item) => item.name)).not.toContain(t("settings.account.name"));
  });

  it("构建期白名单的模块与常量都不复存在", () => {
    // 反向保护：白名单失败时是**静默**的（功能消失、没有报错），三次事故
    // 都源于此。断言它不能悄悄回来：
    // ① 承载它的模块文件被删掉了（不是留个恒 true 的空壳）；
    // ② 构建脚本里没有注入该常量的 define。
    expect(
      existsSync(new URL("../src/cloud/cloud-provider-availability.ts", import.meta.url)),
    ).toBe(false);
    const buildScript = readFileSync(
      new URL("../scripts/build-bundle.mjs", import.meta.url),
      "utf8",
    );
    expect(buildScript).not.toContain("__EASYSYNC_CLOUD_PROVIDERS__");
    expect(buildScript).not.toContain("EASYSYNC_CLOUD_PROVIDERS");
  });

  it("两行按钮的样式随状态变：都没部署都主按钮，一个已部署则该行破坏性、另一行普通", () => {
    // 2026-11-23 用户三轮批注的口径（取代 2026-11-21 的「两行必须同构」）：
    // 「按钮的样式，取决于状态」。①两行都没部署 → 两个「登录」都是主按钮；
    // ②③有一个已部署 → 该行挂破坏性动作（停用／退出登录），另一行的「登录」
    // 降为普通按钮。
    //
    // 判据必须来自同一状态源：这里用「没有连接记录」代表两边都没部署
    // （带未测试记录的旧数据属于「WebDAV 仍是活动云端」，按停用档显示）。
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);

    const idle = webdavPlugin({ connection: null, hasPassword: false });
    const idlePage = buildLoginPage(t, idle) as unknown as {
      items: Array<{ name?: string; render?: (s: never) => void }>;
    };
    const idleAccount = renderRowButton(idlePage, t("settings.account.name"));
    const idleWebdav = renderRowButton(
      maintenancePage(idle),
      t("settings.webdav.connection.name"),
    );
    expect(idleAccount).not.toBeNull();
    expect(idleWebdav).not.toBeNull();
    // ① 都没部署：两个「登录」都是主按钮，且都不是破坏性。
    expect(idleAccount!.isCta).toBe(true);
    expect(idleWebdav!.isCta).toBe(true);
    expect(idleAccount!.isDestructive).toBe(false);
    expect(idleWebdav!.isDestructive).toBe(false);
  });

  it("WebDAV 已连接：按钮是「停用」并挂破坏性样式，OneDrive 的登录降为普通按钮", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const plugin = webdavPlugin({
      connection: { tested: true },
      hasPassword: true,
    });
    const page = buildLoginPage(t, plugin) as unknown as {
      items: Array<{ name?: string; render?: (s: never) => void }>;
    };
    const account = renderRowButton(page, t("settings.account.name"));
    const webdav = renderRowButton(
      maintenancePage(plugin),
      t("settings.webdav.connection.name"),
    );

    // 已部署的那行：破坏性「停用」，不是主按钮——红色已经够醒目。
    expect(webdav!.text).toBe(t("settings.webdav.connection.button.disable"));
    expect(webdav!.isDestructive).toBe(true);
    expect(webdav!.isCta).toBe(false);
    // 另一行：同一个词「登录」，降为普通按钮（屏幕上只该有一个主操作）。
    expect(account!.text).toBe(t("settings.account.login"));
    expect(account!.isCta).toBe(false);
    expect(account!.isDestructive).toBe(false);
  });

  it("配置保留但已停用：这一行是「登录」而不是空操作的「停用」", () => {
    // F3-a 之后，停用只把活动云端交还 OneDrive，坐标与连接记录都留着。
    // 若这一行按「连接状态」判停用，用户会得到一个按下去什么都不做的按钮，
    // 而且没有回到 WebDAV 的入口（2026-11-23 实施自检发现）。
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const plugin = webdavPlugin({
      connection: { tested: true },
      active: false,
      loggedIn: true,
      hasPassword: true,
    });
    const webdav = renderRowButton(
      maintenancePage(plugin),
      t("settings.webdav.connection.name"),
    );

    expect(webdav!.text).toBe(t("settings.webdav.connection.button.login"));
    expect(webdav!.isDestructive).toBe(false);
    // OneDrive 正在用：这行的「登录」不是主按钮。
    expect(webdav!.isCta).toBe(false);
    webdav!.onClickHandler?.();
    expect(plugin.openWebDavConfig).toHaveBeenCalledTimes(1);
    expect(plugin.deactivateCloudAndRestoreOneDrive).not.toHaveBeenCalled();
  });

  it("OneDrive 已登录：按钮是「退出登录」并挂破坏性样式，WebDAV 的登录降为普通按钮", () => {    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const plugin = webdavPlugin({
      loggedIn: true,
      connection: null,
      hasPassword: false,
    });
    const page = buildLoginPage(t, plugin) as unknown as {
      items: Array<{ name?: string; render?: (s: never) => void }>;
    };
    const account = renderRowButton(page, t("settings.account.name"));
    const webdav = renderRowButton(
      maintenancePage(plugin),
      t("settings.webdav.connection.name"),
    );

    expect(account!.text).toBe(t("settings.account.logout"));
    expect(account!.isDestructive).toBe(true);
    expect(webdav!.text).toBe(t("settings.webdav.connection.button.login"));
    expect(webdav!.isCta).toBe(false);
    expect(webdav!.isDestructive).toBe(false);
  });

  it("未连接时的行说明写「未登录」：按钮叫登录，说明句必须是同一个词", () => {
    // 用户 2026-11-23：「WebDAV的按钮改成了登录，但详情文本还是旧的'未配置'」。
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const page = maintenancePage(webdavPlugin()) as unknown as {
      items: Array<{ name?: string; desc?: string }>;
    };
    const webdavRow = page.items.find(
      (item) => item.name === t("settings.webdav.connection.name"),
    );
    expect(webdavRow?.desc).toBe("未登录");
  });

  it("行名带「试验性」标注、不带「连接」后缀；说明句只写状态（2026-11-22 起标注从说明句挪到行名）", () => {
    // 行名：用户原话「叫'WebDAV连接' 是为了要跟'OneDrive 账号'对账吗？大可不必，
    // 如果直接叫WebDAV更好，就叫 WebDAV」。标注：2026-11-21 挂在说明句上，
    // 2026-11-22 用户目测后拍板挪到行名——说明句只回答「现在连上没有」。
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    expect(zh.t("settings.webdav.connection.name")).toBe("WebDAV（试验性）");
    expect(en.t("settings.webdav.connection.name")).toBe("WebDAV (experimental)");
    // 行名不带「连接」后缀。
    expect(zh.t("settings.webdav.connection.name")).not.toContain("连接");
    // 三种连接状态的说明句都不再带标注；标注说的是能力本身，已在行名上。
    expect(zh.t("settings.webdav.connection.desc.unconfigured")).toBe("未登录");
    expect(en.t("settings.webdav.connection.desc.unconfigured")).toBe("Not signed in");
    expect(zh.t("settings.webdav.connection.desc.unconfigured")).not.toContain("试验");
    expect(en.t("settings.webdav.connection.desc.unconfigured").toLowerCase())
      .not.toContain("experimental");
  });
});

describe("WebDAV 单向模式闸门", () => {
  it("WebDAV 生效：下拉里没有单向选项，说明句解释原因", () => {
    const i18n = new I18n("zh-cn");
    const { setting, dropdown, hintText } = fakeSetting();
    renderSyncModeRow(setting, i18n.t.bind(i18n), webdavPlugin());

    const values = dropdown.options.map((option) => option.value);
    expect(values).toEqual(["two-way"]);
    expect(values).not.toContain("one-way");
    // 说明句换成「为什么只有双向」，而不是留下单向的说明。
    expect(hintText()).toBe(i18n.t("settings.syncMode.hint.onewayUnavailable"));
    expect(hintText()).not.toBe(i18n.t("settings.syncMode.hint.oneway"));
  });

  it("OneDrive 生效：选项与说明逐字保持现状", () => {
    const i18n = new I18n("zh-cn");
    const { setting, dropdown, hintText } = fakeSetting();
    renderSyncModeRow(setting, i18n.t.bind(i18n), onedrivePlugin());

    expect(dropdown.options.map((option) => option.value))
      .toEqual(["two-way", "one-way"]);
    expect(dropdown.value).toBe("one-way");
    expect(hintText()).toBe(i18n.t("settings.syncMode.hint.oneway"));
  });

  it("WebDAV 但尚未连接（坐标为 null）：不做禁用，保持通用行为", () => {
    // 判据是「路径身份服务是否真的生效」。provider 指向 webdav 但没有可用
    // 坐标时 `readCloudSettings` 会退回 onedrive，此处按同样口径不拦。
    const i18n = new I18n("zh-cn");
    const plugin = webdavPlugin();
    (plugin as unknown as { cloudSettings: unknown }).cloudSettings = {
      provider: "webdav",
      webdav: null,
    };
    const { setting, dropdown } = fakeSetting();
    renderSyncModeRow(setting, i18n.t.bind(i18n), plugin);
    expect(dropdown.options.map((option) => option.value))
      .toEqual(["two-way", "one-way"]);
  });
});
