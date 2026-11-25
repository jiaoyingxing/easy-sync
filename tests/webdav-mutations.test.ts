import { describe, expect, it } from "vitest";
import { WebDavClient } from "../src/providers/webdav/webdav-client";
import { WebDavProvider } from "../src/providers/webdav/webdav-provider";
import {
  idForPath,
  loadIdentityLedger,
  serializeIdentityLedger,
} from "../src/providers/webdav/webdav-identity-ledger";
import { RemoteError, RemoteErrorType } from "../src/remote/errors";
import type { FakeWebDavProfile } from "./helpers/fake-webdav";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const credentials = {
  username: WEBDAV_TEST_USERNAME,
  password: WEBDAV_TEST_PASSWORD,
};

const NUTSTORE_PROFILES: readonly FakeWebDavProfile[] = [
  "ignore-if-none-match",
  "ignore-delete-if-match",
  "move-conflict-on-overwrite",
  "depth-infinity-as-one",
  "no-head-length",
  "mkcol-existing-201",
];

async function createProvider(
  profiles: readonly FakeWebDavProfile[] = ["strict"],
): Promise<{ provider: WebDavProvider; client: WebDavClient }> {
  fixture.fake.setProfiles(profiles);
  const client = new WebDavClient({
    endpoint,
    credentials,
    transport: fixture.transport,
  });
  await client.initialize();
  return { provider: new WebDavProvider({ client }), client };
}

function textOf(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(buffer));
}

async function statOf(
  client: WebDavClient,
  path: string,
): Promise<{ eTag: string }> {
  const stat = await client.stat(path);
  if (!stat?.eTag) {
    throw new Error(`Expected a stat with ETag for ${path}`);
  }
  return { eTag: stat.eTag };
}

const LEDGER_UUID = "0123456789abcdef0123456789abcdef";
const LEDGER_UUID_B = "fedcba9876543210fedcba9876543210";

function seedLedger(entries: Record<string, string>): void {
  fixture.fake.seedFile(
    "/vault/.easy-sync/identity.json",
    serializeIdentityLedger({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      entries,
    }),
  );
}

describe("WebDAV provider 文件删除", () => {
  it("带当前 ETag 删除文件：文件消失且回读为空", async () => {
    fixture.fake.seedFile("/vault/notes/a.md", "alpha");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "notes/a.md");

    await provider.deleteItem("vault", "notes/a.md", eTag);

    expect(await client.stat("notes/a.md")).toBeNull();
  });

  it("陈旧 ETag 删除：PreconditionFailed，文件仍在", async () => {
    fixture.fake.seedFile("/vault/notes/a.md", "alpha");
    const { provider, client } = await createProvider();

    await expect(
      provider.deleteItem("vault", "notes/a.md", '"stale"'),
    ).rejects.toMatchObject({
      type: RemoteErrorType.PreconditionFailed,
    });
    expect(await client.stat("notes/a.md")).not.toBeNull();
  });

  it("缺少 ETag：发请求前 fail-closed", async () => {
    fixture.fake.seedFile("/vault/notes/a.md", "alpha");
    const { provider, client } = await createProvider();

    await expect(
      provider.deleteItem("vault", "notes/a.md"),
    ).rejects.toMatchObject({
      type: RemoteErrorType.PreconditionFailed,
      graphCode: "webdav-mutation-requires-etag",
    });
    expect(await client.stat("notes/a.md")).not.toBeNull();
  });

  it("弱 ETag：发请求前 fail-closed", async () => {
    fixture.fake.seedFile("/vault/notes/a.md", "alpha");
    const { provider, client } = await createProvider(["weak-etag"]);
    const stat = await client.stat("notes/a.md");
    expect(stat?.eTag?.startsWith("W/")).toBe(true);

    await expect(
      provider.deleteItem("vault", "notes/a.md", stat?.eTag ?? ""),
    ).rejects.toMatchObject({
      type: RemoteErrorType.PreconditionFailed,
      graphCode: "webdav-mutation-requires-etag",
    });
    expect(await client.stat("notes/a.md")).not.toBeNull();
  });

  it("目标已不存在：幂等成功", async () => {
    const { provider } = await createProvider();
    await expect(
      provider.deleteItem("vault", "missing.md", '"whatever"'),
    ).resolves.toBeUndefined();
  });
});

describe("WebDAV provider 集合删除", () => {
  it("条件删除可用：空集合带 ETag 删除成功", async () => {
    fixture.fake.seedCollection("/vault/empty");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "empty");

    await provider.deleteItem("vault", "empty", eTag);

    expect(await client.stat("empty")).toBeNull();
  });

  it("非空集合：拒绝删除，子项仍在", async () => {
    fixture.fake.seedFile("/vault/full/child.md", "child");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "full");

    await expect(
      provider.deleteItem("vault", "full", eTag),
    ).rejects.toMatchObject({
      type: RemoteErrorType.Conflict,
    });
    expect(await client.stat("full/child.md")).not.toBeNull();
  });

  it("坚果云画像（无条件删除）：证明空壳后成功返回，不发集合 DELETE", async () => {
    fixture.fake.seedCollection("/vault/empty");
    const { provider, client } = await createProvider(NUTSTORE_PROFILES);
    const { eTag } = await statOf(client, "empty");

    await expect(
      provider.deleteItem("vault", "empty", eTag),
    ).resolves.toBeUndefined();
    expect(await client.stat("empty")).not.toBeNull();
    expect(fixture.fake.mutationCounts("/vault/empty").delete).toBe(0);
  });
});

describe("WebDAV provider 改名与移动", () => {
  it("同目录改名：目标出现、源消失、字节不变、返回新身份", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "a.md");

    const moved = await provider.renameItem(
      "vault",
      "a.md",
      "b.md",
      "a.md",
      eTag,
    );

    expect(moved.id).toBe("b.md");
    expect(moved.parentReference?.id).toBe("/");
    expect(await client.stat("a.md")).toBeNull();
    expect(textOf((await client.readFile("b.md")).bytes)).toBe("alpha");
  });

  it("目标已存在：Conflict，源与目标都不变", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    fixture.fake.seedFile("/vault/b.md", "beta");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "a.md");

    await expect(
      provider.renameItem("vault", "a.md", "b.md", "a.md", eTag),
    ).rejects.toMatchObject({
      type: RemoteErrorType.Conflict,
    });
    expect(textOf((await client.readFile("a.md")).bytes)).toBe("alpha");
    expect(textOf((await client.readFile("b.md")).bytes)).toBe("beta");
  });

  it("源 ETag 已变化：PreconditionFailed，未移动", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "a.md");
    fixture.fake.seedFile("/vault/a.md", "changed");

    await expect(
      provider.renameItem("vault", "a.md", "b.md", "a.md", eTag),
    ).rejects.toMatchObject({
      type: RemoteErrorType.PreconditionFailed,
      graphCode: "webdav-source-etag-changed",
    });
    expect(await client.stat("b.md")).toBeNull();
    expect(textOf((await client.readFile("a.md")).bytes)).toBe("changed");
  });

  it("跨目录移动文件：新路径出现、父身份正确、源消失", async () => {
    fixture.fake.seedFile("/vault/src/a.md", "alpha");
    fixture.fake.seedCollection("/vault/dst");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "src/a.md");

    const moved = await provider.moveItemById(
      "src/a.md",
      eTag,
      "a.md",
      "dst",
    );

    expect(moved.id).toBe("dst/a.md");
    expect(moved.parentReference?.id).toBe("dst");
    expect(await client.stat("src/a.md")).toBeNull();
    expect(textOf((await client.readFile("dst/a.md")).bytes)).toBe("alpha");
  });

  it("移动文件夹：整个子树跟随、目标父身份正确、源消失", async () => {
    fixture.fake.seedFile("/vault/folder/x.md", "x");
    fixture.fake.seedFile("/vault/folder/sub/y.md", "y");
    fixture.fake.seedCollection("/vault/target");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "folder");

    const moved = await provider.moveItemById(
      "folder",
      eTag,
      "moved",
      "target",
    );

    expect(moved.id).toBe("target/moved");
    expect(moved.folder).toEqual({});
    expect(await client.stat("folder")).toBeNull();
    expect(await client.stat("target/moved/x.md")).not.toBeNull();
    expect(await client.stat("target/moved/sub/y.md")).not.toBeNull();
  });

  it("目标父目录缺失：Conflict，源仍在", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "a.md");

    await expect(
      provider.moveItemById("a.md", eTag, "a.md", "missing-parent"),
    ).rejects.toMatchObject({
      type: RemoteErrorType.Conflict,
    });
    expect(await client.stat("a.md")).not.toBeNull();
  });

  it("控制面路径：拒绝删除／改名／移动", async () => {
    fixture.fake.seedFile("/vault/.easy-sync/identity.json", "{}");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, ".easy-sync/identity.json");

    await expect(
      provider.deleteItem("vault", ".easy-sync/identity.json", eTag),
    ).rejects.toMatchObject({
      type: RemoteErrorType.Conflict,
      graphCode: "webdav-control-plane-immutable",
    });
    await expect(
      provider.renameItem(
        "vault",
        ".easy-sync/identity.json",
        ".easy-sync/identity2.json",
        ".easy-sync/identity.json",
        eTag,
      ),
    ).rejects.toMatchObject({
      type: RemoteErrorType.Conflict,
      graphCode: "webdav-control-plane-immutable",
    });
    await expect(
      provider.deleteItem("vault", "/", '"root-etag"'),
    ).rejects.toMatchObject({
      type: RemoteErrorType.Conflict,
      graphCode: "webdav-root-immutable",
    });
    expect(await client.stat(".easy-sync/identity.json")).not.toBeNull();
  });
});

describe("WebDAV provider 身份账本重绑", () => {
  it("verified 账本：改名后 uuid 跟随新路径", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    seedLedger({ [LEDGER_UUID]: "a.md" });
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "a.md");

    await provider.renameItem("vault", "a.md", "b.md", "a.md", eTag);

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("verified");
    expect(loaded.ledger).not.toBeNull();
    expect(idForPath(loaded.ledger!, "b.md")).toBe(LEDGER_UUID);
    expect(idForPath(loaded.ledger!, "a.md")).toBeNull();
  });

  it("账本缺失：改名仍成功，不凭空创建账本", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "a.md");

    await provider.renameItem("vault", "a.md", "b.md", "a.md", eTag);

    expect((await loadIdentityLedger(client)).state).toBe("missing");
    expect(await client.stat("b.md")).not.toBeNull();
  });

  it("只读账本（无 If-Match）：改名成功但账本保持旧路径", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    seedLedger({ [LEDGER_UUID]: "a.md" });
    const { provider, client } = await createProvider(["no-if-match"]);
    const { eTag } = await statOf(client, "a.md");

    await provider.renameItem("vault", "a.md", "b.md", "a.md", eTag);

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("read-only");
    expect(idForPath(loaded.ledger!, "a.md")).toBe(LEDGER_UUID);
    expect(idForPath(loaded.ledger!, "b.md")).toBeNull();
  });

  it("目标路径已被其他 uuid 占用：改名仍成功，账本不被强改", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    seedLedger({
      [LEDGER_UUID]: "a.md",
      [LEDGER_UUID_B]: "b.md",
    });
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "a.md");

    await provider.renameItem("vault", "a.md", "b.md", "a.md", eTag);

    const loaded = await loadIdentityLedger(client);
    expect(idForPath(loaded.ledger!, "a.md")).toBe(LEDGER_UUID);
    expect(idForPath(loaded.ledger!, "b.md")).toBe(LEDGER_UUID_B);
  });
});

describe("WebDAV provider mutation 错误中性化", () => {
  it("把客户端条件错误折成 RemoteError 冲突类型", async () => {
    fixture.fake.seedFile("/vault/a.md", "alpha");
    const { provider, client } = await createProvider();
    const { eTag } = await statOf(client, "a.md");

    const error = await provider
      .deleteItem("vault", "a.md", '"stale"')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).type).toBe(RemoteErrorType.PreconditionFailed);
  });
});
