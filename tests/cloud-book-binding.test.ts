/**
 * F2 绑定闭环：WebDAV 也必须登记「这个库属于谁」。
 *
 * 病根（设计 §1 事实 3、4）：账本开头记的「这个库属于谁」只有 OneDrive 登录
 * 会写（`bindAccount` 唯一调用点在 `main.ts` 的 `checkAccountBinding`），而
 * WebDAV 的分流整个绕过那道闸。于是账上的身份是空串，`isSyncScope` 要求
 * 非空，每一轮提交都会被自己的完整性校验拒绝——能扫描、能算计划，就是落
 * 不了账。既有测试每次都在夹具里事先塞好了身份，所以没暴露。
 *
 * 本文件钉三件事：
 * 1. WebDAV 的身份来自 scope 的 `credentialBindingId`，不是微软账号 id；
 * 2. 绑定闸在没有 OneDrive 登录态时也必须放行（红：改造前第一句就 return false）；
 * 3. OneDrive 侧逐字不变（有登录态时仍用账号 id，既有行为零回归）。
 */
import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";

interface Harness {
  plugin: EasySyncPlugin;
  boundAccountId: string;
  bindAccount: ReturnType<typeof vi.fn>;
}

const webdavCoordinates = {
  url: "https://nas.example.com",
  username: "alice",
  rootPrefix: "EasySync",
};

/**
 * 真插件实例，只替换身份来源与状态读写。
 *
 * 刻意用真实实例而不是对象字面量：`activeCloudIdentityId` 与
 * `checkAccountBinding` 都是**私有方法**，要验它们真的被主线调用链用上，
 * 就得让它们在真实类里跑。
 */
function makeHarness(options: {
  loggedIn?: boolean;
  accountId?: string;
} = {}): Harness {
  const plugin = new EasySyncPlugin();
  const state = {
    boundAccountId: "",
    bindAccount: vi.fn(async (accountId: string) => {
      state.boundAccountId = accountId;
    }),
  };
  // 状态只提供绑定闸用到的成员，避免拉起整套 V2 状态机。
  plugin.state = state as never;
  const loggedIn = options.loggedIn ?? false;
  plugin.auth = {
    authState: {
      isLoggedIn: loggedIn,
      accountId: loggedIn ? (options.accountId ?? "onedrive-account-id") : undefined,
    },
  } as never;
  return { plugin, boundAccountId: state.boundAccountId, bindAccount: state.bindAccount };
}

function withWebDav(plugin: EasySyncPlugin): void {
  plugin.cloudSettings = {
    provider: "webdav",
    webdav: {
      coordinates: webdavCoordinates,
      credentialRevision: 1,
      lastTest: null,
    },
  };
}

function withOneDrive(plugin: EasySyncPlugin): void {
  plugin.cloudSettings = { provider: "onedrive", webdav: null };
}

type BindingInternals = {
  activeCloudIdentityId(): Promise<string | null>;
  checkAccountBinding(options?: {
    suppressNotice?: boolean;
    allowInitialBind?: boolean;
  }): Promise<boolean>;
};

function internals(plugin: EasySyncPlugin): BindingInternals {
  return plugin as unknown as BindingInternals;
}

describe("F2 WebDAV 的身份来源", () => {
  it("WebDAV 用地址＋用户名的指纹，而不是微软账号 id", async () => {
    const { plugin } = makeHarness({ loggedIn: false });
    withWebDav(plugin);
    const id = await internals(plugin).activeCloudIdentityId();
    expect(id).toBeTruthy();
    // 与远端 scope 的 `credentialBindingId` 同源：32 位十六进制指纹。
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // 换用户名就是换了一份远端。
    plugin.cloudSettings = { provider: "webdav", webdav: {
      coordinates: { ...webdavCoordinates, username: "bob" },
      credentialRevision: 1,
      lastTest: null,
    } };
    expect(await internals(plugin).activeCloudIdentityId()).not.toBe(id);
  });

  it("WebDAV 已配好时身份与 OneDrive 登录态无关", async () => {
    // 有 OneDrive 登录态也必须给 WebDAV 的身份：否则两台云的身份会串。
    const { plugin } = makeHarness({ loggedIn: true });
    withWebDav(plugin);
    const id = await internals(plugin).activeCloudIdentityId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe("onedrive-account-id");
  });

  it("坐标不合法＝没有可用身份（交给入口自己报配置问题）", async () => {
    const { plugin } = makeHarness();
    plugin.cloudSettings = { provider: "webdav", webdav: {
      // 明文 http：scope 解析只接受 https。
      coordinates: { url: "http://insecure.example/dav", username: "u", rootPrefix: "" },
      credentialRevision: 1,
      lastTest: null,
    } };
    expect(await internals(plugin).activeCloudIdentityId()).toBeNull();
  });
});

describe("F2 绑定闸对 WebDAV 放行", () => {
  it("没有 OneDrive 登录态时 WebDAV 仍能过闸（红：改造前这里直接 false）", async () => {
    const { plugin, bindAccount } = makeHarness({ loggedIn: false });
    withWebDav(plugin);
    // 判据是返回值，不是「有没有调 bindAccount」——首次登记会顺带绑定。
    await expect(internals(plugin).checkAccountBinding()).resolves.toBe(true);
    expect(bindAccount).toHaveBeenCalledTimes(1);
    // 登记的是 WebDAV 的指纹，不是空串。
    const bound = bindAccount.mock.calls[0][0] as string;
    expect(bound).toMatch(/^[0-9a-f]{32}$/);
  });

  it("已登记同一份远端：不再重复绑定，闸照常放行", async () => {
    const { plugin, bindAccount } = makeHarness({ loggedIn: false });
    withWebDav(plugin);
    const id = await internals(plugin).activeCloudIdentityId();
    const internalsPlugin = internals(plugin);
    // 先登记一次（模拟上一轮已经写过）。
    await internalsPlugin.checkAccountBinding();
    bindAccount.mockClear();
    await expect(internalsPlugin.checkAccountBinding()).resolves.toBe(true);
    expect(bindAccount).not.toHaveBeenCalled();
    // 账本上记的确实是那份远端。
    expect((plugin.state as unknown as { boundAccountId: string }).boundAccountId)
      .toBe(id);
  });

  it("换了远端（改用户名）：拒绝并指名，不静默继续", async () => {
    const { plugin } = makeHarness({ loggedIn: false });
    withWebDav(plugin);
    await internals(plugin).checkAccountBinding();
    const noticeCenter = { show: vi.fn() };
    Object.defineProperty(plugin, "noticeCenter", {
      value: noticeCenter,
      configurable: true,
    });
    plugin.cloudSettings = { provider: "webdav", webdav: {
      coordinates: { ...webdavCoordinates, username: "someone-else" },
      credentialRevision: 1,
      lastTest: null,
    } };
    await expect(internals(plugin).checkAccountBinding()).resolves.toBe(false);
    expect(noticeCenter.show).toHaveBeenCalled();
  });
});

describe("F2 OneDrive 侧零回归", () => {
  it("有登录态、未登记：首次登记成账号 id", async () => {
    const { plugin, bindAccount } = makeHarness({
      loggedIn: true,
      accountId: "onedrive-account-id",
    });
    withOneDrive(plugin);
    await expect(internals(plugin).checkAccountBinding()).resolves.toBe(true);
    expect(bindAccount).toHaveBeenCalledWith("onedrive-account-id");
  });

  it("未登录：仍不放行（不能因为改了身份来源就把这道闸放松）", async () => {
    const { plugin, bindAccount } = makeHarness({ loggedIn: false });
    withOneDrive(plugin);
    await expect(internals(plugin).checkAccountBinding()).resolves.toBe(false);
    expect(bindAccount).not.toHaveBeenCalled();
  });
});
