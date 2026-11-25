/**
 * C1 数据层测试：坐标校验、状态派生、持久化读写与凭据边界。
 *
 * 全部纯逻辑，不访问网络、不触真实账号；连接测试用 loopback fake WebDAV
 * （`tests/helpers/fake-webdav.ts`）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  bumpCredentialRevision,
  computeWebDavConfigFingerprint,
  EMPTY_CLOUD_SETTINGS,
  markWebDavTested,
  normalizeCloudRootPrefix,
  readCloudSettings,
  resolveWebDavConnectionStatus,
  validateWebDavCoordinates,
  writeCloudSettings,
  type WebDavCloudConnectionV1,
} from "../src/cloud/cloud-settings";
import {
  classifyTestFailure,
  resolveRootPath,
  testWebDavConnection,
} from "../src/cloud/cloud-connection-test";
import {
  CloudSecretStorageUnavailableError,
  createCloudSecrets,
  SS_WEBDAV_PASSWORD,
} from "../src/cloud/cloud-secrets";
import { RemoteError, RemoteErrorType } from "../src/remote/errors";
import {
  encodeWebDavPath,
  WebDavProbeConfigError,
} from "../src/providers/webdav/webdav-probe";
import { FakeWebDavServer, createLoopbackWebDavTransport } from "./helpers/fake-webdav";

const KEY_PROVIDER = "cloud-provider";
const KEY_WEBDAV = "cloud-webdav";
const KEYS = { provider: KEY_PROVIDER, webdav: KEY_WEBDAV };

function connection(
  overrides: Partial<WebDavCloudConnectionV1> = {},
): WebDavCloudConnectionV1 {
  return {
    coordinates: {
      url: "https://nas.example.com/webdav",
      username: "alice",
      rootPrefix: "EasySync",
    },
    credentialRevision: 1,
    lastTest: null,
    ...overrides,
  };
}

describe("C1 坐标校验", () => {
  it("接受 HTTPS 地址并去掉末尾斜杠", () => {
    const result = validateWebDavCoordinates({
      url: "https://nas.example.com/webdav/",
      username: " alice ",
      rootPrefix: "/Obsidian/EasySync/",
    });
    expect(result.error).toBeNull();
    expect(result.value).toEqual({
      url: "https://nas.example.com/webdav",
      username: "alice",
      rootPrefix: "Obsidian/EasySync",
    });
  });

  it("拒绝明文 HTTP、内嵌凭据、查询串与片段", () => {
    for (const url of [
      "http://nas.example.com/webdav",
      "https://alice:secret@nas.example.com/webdav",
      "https://nas.example.com/webdav?token=abc",
      "https://nas.example.com/webdav#frag",
      "not-a-url",
      "",
    ]) {
      const result = validateWebDavCoordinates({ url, username: "alice", rootPrefix: "" });
      expect(result.value, url).toBeNull();
      expect(result.error, url).toBe("urlInvalid");
    }
  });

  it("用户名必须非空且不含控制字符", () => {
    expect(validateWebDavCoordinates({
      url: "https://nas.example.com/webdav",
      username: "   ",
      rootPrefix: "",
    }).error).toBe("usernameInvalid");
    expect(validateWebDavCoordinates({
      url: "https://nas.example.com/webdav",
      username: "ali\u0000ce",
      rootPrefix: "",
    }).error).toBe("usernameInvalid");
  });

  it("根路径拒绝 ..、反斜杠与控制字符，允许空串", () => {
    expect(normalizeCloudRootPrefix("")).toBe("");
    expect(normalizeCloudRootPrefix("a/b")).toBe("a/b");
    expect(normalizeCloudRootPrefix("a//b")).toBeNull();
    expect(normalizeCloudRootPrefix("a/../b")).toBeNull();
    expect(normalizeCloudRootPrefix("a\\b")).toBeNull();
    expect(normalizeCloudRootPrefix("a\u000b b")).toBeNull();
  });
});

describe("C1 连接状态", () => {
  it("无坐标或无凭据一律「未配置」", () => {
    expect(resolveWebDavConnectionStatus(null, true)).toBe("unconfigured");
    expect(resolveWebDavConnectionStatus(connection(), false)).toBe("unconfigured");
  });

  it("有坐标与凭据但没有测试 = 未测试", () => {
    expect(resolveWebDavConnectionStatus(connection(), true)).toBe("untested");
  });

  it("测试通过 = 已连接；失败 = 失败", () => {
    const passed = markWebDavTested(connection(), { ok: true, testedAt: 1000 });
    expect(resolveWebDavConnectionStatus(passed, true)).toBe("connected");
    const failed = markWebDavTested(connection(), {
      ok: false,
      failureKind: "authRejected",
      testedAt: 1000,
    });
    expect(resolveWebDavConnectionStatus(failed, true)).toBe("failed");
  });

  it("坐标变化或凭据轮换都让旧测试失效", () => {
    const passed = markWebDavTested(connection(), { ok: true, testedAt: 1000 });
    const changedUrl = {
      ...passed,
      coordinates: { ...passed.coordinates, url: "https://other.example.com/dav" },
    };
    expect(resolveWebDavConnectionStatus(changedUrl, true)).toBe("untested");
    const rotated = bumpCredentialRevision(passed);
    expect(rotated.credentialRevision).toBe(2);
    expect(rotated.lastTest).toBeNull();
    expect(resolveWebDavConnectionStatus(rotated, true)).toBe("untested");
  });

  it("指纹只随坐标与凭据版本变化", () => {
    const base = computeWebDavConfigFingerprint(connection().coordinates, 1);
    expect(base).toBe(computeWebDavConfigFingerprint(connection().coordinates, 1));
    expect(base).not.toBe(computeWebDavConfigFingerprint(connection().coordinates, 2));
    expect(base).toMatch(/^wd1-[0-9a-f]{8}$/);
  });
});

describe("C1 持久化", () => {
  it("OneDrive 用户不写任何字段（零迁移）", () => {
    const data: Record<string, unknown> = {};
    writeCloudSettings(data, EMPTY_CLOUD_SETTINGS, KEYS);
    expect(data).toEqual({});
  });

  it("WebDAV 连接写入后可原样读回", () => {
    const data: Record<string, unknown> = { untouched: 1 };
    const settings = {
      provider: "webdav" as const,
      webdav: markWebDavTested(connection(), { ok: true, testedAt: 2000 }),
    };
    writeCloudSettings(data, settings, KEYS);
    const restored = readCloudSettings(data, KEYS);
    expect(restored.provider).toBe("webdav");
    expect(restored.webdav).toEqual(settings.webdav);
    expect(data.untouched).toBe(1);
  });

  it("异常形状退回安全默认（不抛错、不半状态）", () => {
    expect(readCloudSettings(null, KEYS)).toEqual(EMPTY_CLOUD_SETTINGS);
    expect(readCloudSettings({ [KEY_PROVIDER]: "webdav" }, KEYS)).toEqual(EMPTY_CLOUD_SETTINGS);
    expect(readCloudSettings({
      [KEY_PROVIDER]: "webdav",
      [KEY_WEBDAV]: { coordinates: { url: "http://x/", username: "a", rootPrefix: "" } },
    }, KEYS)).toEqual(EMPTY_CLOUD_SETTINGS);
    expect(readCloudSettings({ [KEY_PROVIDER]: "s3" }, KEYS)).toEqual(EMPTY_CLOUD_SETTINGS);
  });

  it("坐标非法时整条连接被丢弃", () => {
    const data: Record<string, unknown> = {
      [KEY_PROVIDER]: "webdav",
      [KEY_WEBDAV]: {
        coordinates: { url: "https://nas.example.com/webdav", username: "alice", rootPrefix: "a/../b" },
        credentialRevision: 1,
        lastTest: null,
      },
    };
    expect(readCloudSettings(data, KEYS).webdav).toBeNull();
    expect(readCloudSettings(data, KEYS).provider).toBe("onedrive");
  });
});

describe("C1 凭据边界", () => {
  it("写入后读回同一密码；空串不修改", async () => {
    const store = new Map<string, string>();
    const secrets = createCloudSecrets({
      getSecret: (key) => store.get(key) ?? null,
      setSecret: async (key, value) => { store.set(key, value); },
      deleteSecret: async (key) => { store.delete(key); },
    });
    await secrets.saveWebDavPassword("app-password");
    expect(await secrets.readWebDavPassword()).toBe("app-password");
    await secrets.saveWebDavPassword("");
    expect(await secrets.readWebDavPassword()).toBe("app-password");
    await secrets.removeWebDavPassword();
    expect(await secrets.readWebDavPassword()).toBeNull();
  });

  it("缺安全存储时写入大声失败、读取返回 null", async () => {
    const secrets = createCloudSecrets(null);
    await expect(secrets.saveWebDavPassword("x"))
      .rejects.toBeInstanceOf(CloudSecretStorageUnavailableError);
    expect(await secrets.readWebDavPassword()).toBeNull();
    await expect(secrets.removeWebDavPassword()).resolves.toBeUndefined();
  });

  it("槽位名与 OneDrive 同族但不同键", () => {
    expect(SS_WEBDAV_PASSWORD).toBe("easy-sync-webdav-password");
    expect(SS_WEBDAV_PASSWORD.startsWith("easy-sync-")).toBe(true);
  });
});

describe("C1 失败分类", () => {
  it("中性 RemoteError 折成用户可见类别", () => {
    const cases: Array<[RemoteErrorType, string]> = [
      [RemoteErrorType.Unauthorized, "authRejected"],
      [RemoteErrorType.AuthExpired, "authRejected"],
      [RemoteErrorType.Forbidden, "forbidden"],
      [RemoteErrorType.NotFound, "notFound"],
      [RemoteErrorType.RateLimited, "rateLimited"],
      [RemoteErrorType.NetworkError, "network"],
      [RemoteErrorType.ServerError, "service"],
    ];
    for (const [type, expected] of cases) {
      expect(classifyTestFailure(new RemoteError(type, "x")).kind, type).toBe(expected);
    }
  });

  it("配置层拒绝折成 config；未识别错误折成 unknown", () => {
    expect(classifyTestFailure(new WebDavProbeConfigError("plaintext")).kind).toBe("config");
    expect(classifyTestFailure(new Error("boom")).kind).toBe("unknown");
  });
});

describe("C1 连接测试（loopback fake WebDAV）", () => {
  let fake: FakeWebDavServer | null = null;

  afterEach(async () => {
    if (fake) {
      await fake.stop();
      fake = null;
    }
  });

  it("根可写时测试通过，且不改动已有文件", async () => {
    fake = new FakeWebDavServer({ rootPath: "/dav", username: "alice", password: "app-password" });
    const { port } = await fake.start();
    const transport = createLoopbackWebDavTransport({ port });
    fake.seedFile("/dav/note.md", "hello");

    const result = await testWebDavConnection({
      coordinates: { url: "https://webdav.test/dav", username: "alice", rootPrefix: "" },
      password: "app-password",
      transport,
    });

    expect(result).toEqual({ ok: true });
    expect(fake.readText("/dav/note.md")).toBe("hello");
  });

  it("密码错误折成 authRejected", async () => {
    fake = new FakeWebDavServer({ rootPath: "/dav", username: "alice", password: "app-password" });
    const { port } = await fake.start();
    const transport = createLoopbackWebDavTransport({ port });

    const result = await testWebDavConnection({
      coordinates: { url: "https://webdav.test/dav", username: "alice", rootPrefix: "" },
      password: "wrong-password",
      transport,
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("authRejected");
  });

  it("凭据为空时不发请求，直接 config", async () => {
    fake = new FakeWebDavServer({ rootPath: "/dav" });
    const { port } = await fake.start();
    const transport = createLoopbackWebDavTransport({ port });
    const before = fake.requests.length;

    const result = await testWebDavConnection({
      coordinates: { url: "https://webdav.test/dav", username: "alice", rootPrefix: "" },
      password: "",
      transport,
    });

    expect(result).toEqual({ ok: false, failureKind: "config" });
    expect(fake.requests.length).toBe(before);
  });

  it("根路径 = 地址路径 + 根前缀", () => {
    expect(resolveRootPath({ url: "https://nas.example.com/dav", username: "a", rootPrefix: "" }))
      .toBe("/dav");
    expect(resolveRootPath({ url: "https://nas.example.com/dav", username: "a", rootPrefix: "Note/ES" }))
      .toBe("/dav/Note/ES");
    expect(resolveRootPath({ url: "https://nas.example.com", username: "a", rootPrefix: "" }))
      .toBe("/");
  });

  it("地址里的百分号编码只解码一次，客户端再编码时不会出现 %25", () => {
    // 模拟真实用户：服务器地址里带中文文件夹。validate 保存的是百分号编码，
    // resolveRootPath 必须还原成段路径，WebDavClient 才能只编码一次。
    const validated = validateWebDavCoordinates({
      url: "https://dav.jianguoyun.com/dav/安卓手机测试仓库",
      username: "alice",
      rootPrefix: "Dual-1123",
    });
    expect(validated.error).toBeNull();
    expect(validated.value?.url).toContain("%E5%AE%89");
    const rootPath = resolveRootPath(validated.value!);
    expect(rootPath).toBe("/dav/安卓手机测试仓库/Dual-1123");
    const encoded = encodeWebDavPath(rootPath);
    expect(encoded).toBe("/dav/%E5%AE%89%E5%8D%93%E6%89%8B%E6%9C%BA%E6%B5%8B%E8%AF%95%E4%BB%93%E5%BA%93/Dual-1123");
    expect(encoded).not.toContain("%25");

    // 直接传百分号编码的坐标也一样：只能解码一次，不能把 % 当普通字符再编码。
    expect(resolveRootPath({
      url: "https://dav.jianguoyun.com/dav/%E5%AE%89%E5%8D%93%E6%89%8B%E6%9C%BA%E6%B5%8B%E8%AF%95%E4%BB%93%E5%BA%93",
      username: "alice",
      rootPrefix: "Dual-1123",
    })).toBe("/dav/安卓手机测试仓库/Dual-1123");
  });
});
