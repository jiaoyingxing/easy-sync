import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  WebDavClient,
  WebDavPreconditionFailedError,
  WebDavRootMissingError,
  WebDavTargetExistsError,
} from "../src/providers/webdav/webdav-client";
import { webdavCapabilities } from "../src/providers/webdav/webdav-probe";
import {
  WEBDAV_CLOUD_BOOTSTRAP_V2_PATH,
  WebDavCapabilityMissingError,
  WebDavDownloadHashMismatchError,
  WebDavListingIncompleteError,
  WebDavProvider,
  WebDavProviderNotInitializedError,
  WebDavUploadTooLargeError,
} from "../src/providers/webdav/webdav-provider";
import { RemoteError, RemoteErrorType } from "../src/remote/errors";
import type { DriveItem, RemoteVaultScope } from "../src/onedrive/types";
import type { FakeWebDavProfile } from "./helpers/fake-webdav";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const DRIVE_ID = new URL(endpoint).origin;
const credentials = {
  username: WEBDAV_TEST_USERNAME,
  password: WEBDAV_TEST_PASSWORD,
};
const FIXED_NOW = new Date("2026-11-19T12:00:00.000Z");

/** 坚果云 L2 画像：条件创建／条件删除缺失、MOVE 用 409 拒绝覆盖。 */
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
  return {
    provider: new WebDavProvider({ client, now: () => FIXED_NOW }),
    client,
  };
}

function textBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function bufferText(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(buffer));
}

function makeAdapter(): {
  adapter: DataAdapter;
  writes: Map<string, ArrayBuffer>;
} {
  const writes = new Map<string, ArrayBuffer>();
  const adapter = {
    writeBinary: async (path: string, value: ArrayBuffer) => {
      writes.set(path, value);
    },
  } as unknown as DataAdapter;
  return { adapter, writes };
}

function seedUserTree(): void {
  fixture.fake.seedFile("/vault/root.md", "root");
  fixture.fake.seedFile("/vault/a/b.md", "hello");
  fixture.fake.seedFile("/vault/a/sub/c.md", "nested");
  fixture.fake.seedCollection("/vault/empty");
  fixture.fake.seedFile("/vault/.easy-sync/scope.json", "{}");
  fixture.fake.seedFile("/vault/.easy-sync/cloud-bootstrap-v2.json", "{}");
  fixture.fake.seedFile("/vault/.easy-sync/tmp/create-test", "tmp");
  fixture.fake.seedFile("/vault/.easy-sync-scope.json", "{}");
  fixture.fake.seedFile("/vault/.easysync-user-file.md", "user");
}

function idsOf(items: readonly DriveItem[]): string[] {
  return items.map((item) => item.id).sort();
}

describe("WebDAV provider 能力与初始化", () => {
  it("capabilities 与已初始化的 client 逐位一致", async () => {
    const { provider, client } = await createProvider();
    expect(provider.capabilities).toBe(client.capabilities);
    expect(provider.capabilities).toEqual(client.capabilities);
  });

  it("driveId 缺省取 endpoint origin，可由 options 覆盖", async () => {
    const { client } = await createProvider();
    const defaultProvider = new WebDavProvider({ client });
    expect(
      (await defaultProvider.getDriveItemMetadataById("/"))?.parentReference
        ?.driveId,
    ).toBe(DRIVE_ID);
    expect((await defaultProvider.initVaultScope("vault")).driveId).toBe(
      DRIVE_ID,
    );

    const custom = new WebDavProvider({
      client,
      driveId: "https://custom.example",
    });
    expect(
      (await custom.getDriveItemMetadataById("/"))?.parentReference?.driveId,
    ).toBe("https://custom.example");
    expect((await custom.initVaultScope("vault")).driveId).toBe(
      "https://custom.example",
    );
  });

  it("未 initialize 时构造期 fail-closed", () => {
    const client = new WebDavClient({
      endpoint,
      credentials,
      transport: fixture.transport,
    });
    expect(client.capabilities).toBeNull();
    expect(() => new WebDavProvider({ client })).toThrow(
      WebDavProviderNotInitializedError,
    );
    expect(fixture.fake.requests).toHaveLength(0);
  });
});

describe("WebDAV provider 全量扫描", () => {
  it("合成根／文件／文件夹／父路径并排除控制面", async () => {
    const { provider } = await createProvider();
    seedUserTree();

    const items = await provider.fullScan("vault");
    expect(idsOf(items)).toEqual([
      ".easysync-user-file.md",
      "a",
      "a/b.md",
      "a/sub",
      "a/sub/c.md",
      "empty",
      "root.md",
    ]);

    const topFile = items.find((item) => item.id === "root.md")!;
    expect(topFile).toMatchObject({
      id: "root.md",
      name: "root.md",
      size: 4,
      parentReference: { driveId: DRIVE_ID, id: "/" },
    });
    expect(topFile.file).toBeDefined();
    expect(topFile.folder).toBeUndefined();
    expect(topFile.eTag).toMatch(/^".+"$/);
    expect(topFile.lastModifiedDateTime).toBeTruthy();
    expect(topFile.file?.hashes).toBeUndefined();
    expect(topFile.cTag).toBeUndefined();

    const folder = items.find((item) => item.id === "a")!;
    expect(folder.folder).toEqual({});
    expect(folder.file).toBeUndefined();
    expect(folder.parentReference).toEqual({ driveId: DRIVE_ID, id: "/" });

    const nested = items.find((item) => item.id === "a/b.md")!;
    expect(nested.size).toBe(5);
    expect(nested.parentReference).toEqual({ driveId: DRIVE_ID, id: "a" });

    const empty = items.find((item) => item.id === "empty")!;
    expect(empty.folder).toEqual({});
  });

  it("列表达到服务器上限时抛 WebDavListingIncompleteError，不把截断当完整", async () => {
    const { provider } = await createProvider();
    for (let index = 0; index < 749; index += 1) {
      fixture.fake.seedFile(
        `/vault/edge-${String(index).padStart(4, "0")}.md`,
        "x",
      );
    }

    const error = (await provider.fullScan("vault").then(
      () => null,
      (cause: unknown) => cause,
    )) as WebDavListingIncompleteError;

    expect(error).toBeInstanceOf(WebDavListingIncompleteError);
    expect(error.path).toBe("/vault");
    expect(error.limit).toBe(750);
    expect(error.responseEntryCount).toBe(750);
  });
});

describe("WebDAV provider 元数据", () => {
  it("按路径／ID 读取文件与文件夹，缺失返回 null", async () => {
    const { provider } = await createProvider();
    seedUserTree();

    const file = await provider.getDriveItemMetadata("vault", "a/b.md");
    expect(file).toMatchObject({
      id: "a/b.md",
      name: "b.md",
      size: 5,
      parentReference: { driveId: DRIVE_ID, id: "a" },
    });
    expect(await provider.getDriveItemMetadata("vault", "missing.md")).toBeNull();

    const folder = await provider.getDriveItemMetadataById("a");
    expect(folder?.folder).toEqual({});

    const root = await provider.getDriveItemMetadataById("/");
    expect(root?.id).toBe("/");
    expect(root?.folder).toEqual({});

    expect(await provider.getDriveItemMetadataById("missing")).toBeNull();
  });

  it("getFileMetadata 暴露 eTag／cTag／size／mtime，不伪造强内容指纹", async () => {
    const { provider } = await createProvider();
    seedUserTree();
    const snapshot = fixture.fake.getResource("/vault/a/b.md")!;

    const metadata = await provider.getFileMetadata("vault", "a/b.md");
    expect(metadata).toMatchObject({
      eTag: snapshot.eTag,
      cTag: snapshot.eTag,
      size: 5,
      // 条目身份＝相对路径；drive 容器身份仍由 parentReference 表达。
      driveId: "a/b.md",
      parentId: "a",
    });
    expect(metadata!.mtime).toBeGreaterThan(0);
    expect(metadata).not.toHaveProperty("sha256Hash");
    expect(metadata).not.toHaveProperty("quickXorHash");
    expect(metadata).not.toHaveProperty("downloadUrl");
    expect(
      (await provider.getDriveItemMetadataById("a/b.md"))?.parentReference?.driveId,
    ).toBe(DRIVE_ID);

    expect(await provider.getFileMetadata("vault", "a")).toBeNull();
    expect(await provider.getFileMetadata("vault", "missing.md")).toBeNull();
  });

  it("按路径批量读取保留原始 key，缺失为 null", async () => {
    const { provider } = await createProvider();
    seedUserTree();

    const map = await provider.getFileMetadataByPaths("vault", [
      "a/b.md",
      "missing.md",
      "a",
    ]);
    expect([...map.keys()]).toEqual(["a/b.md", "missing.md", "a"]);
    expect(map.get("a/b.md")?.id).toBe("a/b.md");
    expect(map.get("missing.md")).toBeNull();
    expect(map.get("a")?.folder).toEqual({});
  });

  it("listFolderChildrenById 只返回直接子项并排除控制面", async () => {
    const { provider } = await createProvider();
    seedUserTree();

    const rootChildren = await provider.listFolderChildrenById("/");
    expect(idsOf(rootChildren)).toEqual([
      ".easysync-user-file.md",
      "a",
      "empty",
      "root.md",
    ]);

    const children = await provider.listFolderChildrenById("a");
    expect(idsOf(children)).toEqual(["a/b.md", "a/sub"]);
    expect(children.every((child) => child.parentReference?.id === "a")).toBe(true);
  });
});

describe("WebDAV provider 文件夹创建", () => {
  it("按路径或父 ID 真实建集合，返回真实元数据且已存在幂等", async () => {
    const { provider } = await createProvider();

    const parent = await provider.createFolderByParentId("/", "x");
    expect(parent).toMatchObject({
      id: "x",
      name: "x",
      folder: {},
      parentReference: { driveId: DRIVE_ID, id: "/" },
    });
    expect(parent.eTag).toBe(fixture.fake.getResource("/vault/x")?.eTag);
    expect(parent.lastModifiedDateTime).toBeTruthy();
    expect(fixture.fake.getResource("/vault/x")?.kind).toBe("collection");

    const nested = await provider.createFolderPath("vault", "/x/y/");
    expect(nested).toMatchObject({
      id: "x/y",
      name: "y",
      folder: {},
      parentReference: { driveId: DRIVE_ID, id: "x" },
    });
    expect(nested?.eTag).toBe(fixture.fake.getResource("/vault/x/y")?.eTag);
    expect(nested?.lastModifiedDateTime).toBeTruthy();
    expect(fixture.fake.getResource("/vault/x/y")?.kind).toBe("collection");

    const mkcols = fixture.fake.requests.filter(
      (request) =>
        request.method === "MKCOL"
        && request.decodedPath.startsWith("/vault/x"),
    );
    expect(mkcols.map((request) => request.decodedPath)).toEqual([
      "/vault/x",
      "/vault/x/y",
    ]);

    const existingETag = fixture.fake.getResource("/vault/x")!.eTag;
    const again = await provider.createFolderByParentId("/", "x");
    expect(again.id).toBe("x");
    expect(again.eTag).toBe(existingETag);
    expect(fixture.fake.getResource("/vault/x")?.kind).toBe("collection");
  });

  it("父级缺失时上抛 MKCOL 错误，不静默合成", async () => {
    const { provider } = await createProvider();
    const before = fixture.fake.requests.length;

    await expect(
      provider.createFolderPath("vault", "missing/child"),
    ).rejects.toMatchObject({
      type: RemoteErrorType.Conflict,
      statusCode: 409,
    });
    expect(fixture.fake.getResource("/vault/missing/child")).toBeNull();
    const mkcols = fixture.fake.requests
      .slice(before)
      .filter((request) => request.method === "MKCOL");
    expect(mkcols.map((request) => request.decodedPath)).toEqual([
      "/vault/missing/child",
    ]);
  });
});

describe("WebDAV provider 上传", () => {
  it("strict 画像：无 eTag 新建、有 eTag 条件更新", async () => {
    const { provider } = await createProvider();
    fixture.fake.seedCollection("/vault/notes");
    const progress: Array<[number, number]> = [];

    const created = await provider.uploadFile(
      "vault",
      "notes/new.md",
      textBuffer("hello"),
      (uploaded, total) => progress.push([uploaded, total]),
    );
    expect(created).toMatchObject({
      id: "notes/new.md",
      name: "new.md",
      size: 5,
      parentReference: { driveId: DRIVE_ID, id: "notes" },
    });
    expect(created.eTag).toBeTruthy();
    expect(created.lastModifiedDateTime).toBeTruthy();
    expect(progress).toEqual([
      [0, 5],
      [5, 5],
    ]);
    expect(fixture.fake.readText("/vault/notes/new.md")).toBe("hello");
    const directPuts = fixture.fake.requests.filter(
      (request) => request.method === "PUT" && request.decodedPath === "/vault/notes/new.md",
    );
    expect(directPuts).toHaveLength(1);
    expect(directPuts[0].ifNoneMatch).toBe("*");

    const updated = await provider.uploadFile(
      "vault",
      "notes/new.md",
      textBuffer("world!"),
      undefined,
      created.eTag,
    );
    expect(updated.eTag).not.toBe(created.eTag);
    expect(updated.size).toBe(6);
    expect(fixture.fake.readText("/vault/notes/new.md")).toBe("world!");
    const conditionalPuts = fixture.fake.requests.filter(
      (request) => request.method === "PUT" && request.decodedPath === "/vault/notes/new.md",
    );
    expect(conditionalPuts.at(-1)?.ifMatch).toBe(created.eTag);
  });

  it("父目录不存在时先 MKCOL 再 PUT", async () => {
    const { provider } = await createProvider();
    const before = fixture.fake.requests.length;

    const created = await provider.uploadFile(
      "vault",
      "fresh/new.md",
      textBuffer("hello"),
    );
    expect(created.id).toBe("fresh/new.md");
    expect(created.parentReference).toEqual({ driveId: DRIVE_ID, id: "fresh" });
    expect(fixture.fake.readText("/vault/fresh/new.md")).toBe("hello");
    expect(fixture.fake.getResource("/vault/fresh")?.kind).toBe("collection");

    const requests = fixture.fake.requests.slice(before);
    const mkcolIndex = requests.findIndex(
      (request) =>
        request.method === "MKCOL" && request.decodedPath === "/vault/fresh",
    );
    const putIndex = requests.findIndex(
      (request) =>
        request.method === "PUT"
        && request.decodedPath === "/vault/fresh/new.md",
    );
    expect(mkcolIndex).toBeGreaterThanOrEqual(0);
    expect(putIndex).toBeGreaterThan(mkcolIndex);
  });

  it("坚果云画像：条件创建不可用时走唯一临时名 + MOVE，目标已存在不覆盖", async () => {
    const { provider, client } = await createProvider(NUTSTORE_PROFILES);
    fixture.fake.seedCollection("/vault/notes");
    expect(client.capabilities?.conditionalCreate).toBe(false);
    expect(client.capabilities?.serverSideMove).toBe(true);

    const created = await provider.uploadFile(
      "vault",
      "notes/new.md",
      textBuffer("hello"),
    );
    expect(created.id).toBe("notes/new.md");
    expect(fixture.fake.readText("/vault/notes/new.md")).toBe("hello");

    const puts = fixture.fake.requests.filter((request) => request.method === "PUT");
    expect(
      puts.some(
        (request) =>
          request.decodedPath.startsWith("/vault/.easy-sync/tmp/create-"),
      ),
    ).toBe(true);
    expect(
      puts.every((request) => request.decodedPath !== "/vault/notes/new.md"),
    ).toBe(true);

    const moves = fixture.fake.requests.filter((request) => request.method === "MOVE");
    expect(
      moves.some((request) => {
        const destination = request.destination ?? "";
        return (
          request.decodedPath.startsWith("/vault/.easy-sync/tmp/create-")
          && destination.endsWith("/vault/notes/new.md")
          && request.overwrite === "F"
        );
      }),
    ).toBe(true);

    const updated = await provider.uploadFile(
      "vault",
      "notes/new.md",
      textBuffer("world"),
      undefined,
      created.eTag,
    );
    expect(updated.eTag).not.toBe(created.eTag);
    expect(fixture.fake.readText("/vault/notes/new.md")).toBe("world");
    const conditionalPut = fixture.fake.requests
      .filter(
        (request) =>
          request.method === "PUT"
          && request.decodedPath === "/vault/notes/new.md",
      )
      .at(-1);
    expect(conditionalPut?.ifMatch).toBe(created.eTag);

    const before = fixture.fake.getResource("/vault/notes/new.md")!;
    await expect(
      provider.uploadFile("vault", "notes/new.md", textBuffer("second")),
    ).rejects.toBeInstanceOf(WebDavTargetExistsError);
    const after = fixture.fake.getResource("/vault/notes/new.md")!;
    expect(after.sha256).toBe(before.sha256);
    expect(after.eTag).toBe(before.eTag);
    expect(after.putCount).toBe(before.putCount);
  });

  it("超过当前平台单次 PUT 阈值时零请求拒绝", async () => {
    const client = new WebDavClient({
      endpoint,
      credentials,
      transport: fixture.transport,
      capabilities: { ...webdavCapabilities(), maxSinglePutBytes: 4 },
    });
    const provider = new WebDavProvider({ client });
    const before = fixture.fake.requests.length;

    await expect(
      provider.uploadFile("vault", "big.bin", new ArrayBuffer(5)),
    ).rejects.toBeInstanceOf(WebDavUploadTooLargeError);

    const error = (await provider
      .uploadFile("vault", "big.bin", new ArrayBuffer(5))
      .then(
        () => null,
        (cause: unknown) => cause,
      )) as WebDavUploadTooLargeError;
    expect(error.bytes).toBe(5);
    expect(error.limit).toBe(4);
    expect(fixture.fake.requests.length).toBe(before);
  });
});

describe("WebDAV provider 下载", () => {
  it("downloadFile 返回字节并报告 0/总量与总量/总量", async () => {
    const { provider } = await createProvider();
    fixture.fake.seedFile("/vault/a/b.md", "hello");
    const progress: Array<[number, number]> = [];

    const content = await provider.downloadFile(
      "vault",
      "a/b.md",
      undefined,
      undefined,
      undefined,
      (downloaded, total) => progress.push([downloaded, total]),
    );

    expect(bufferText(content)).toBe("hello");
    expect(progress).toEqual([
      [0, 5],
      [5, 5],
    ]);
  });

  it("downloadFileToPath 写适配器并校验 expectedSha256", async () => {
    const { provider } = await createProvider();
    fixture.fake.seedFile("/vault/a/b.md", "hello");
    const { adapter, writes } = makeAdapter();
    const expected = fixture.sha256("hello");

    const result = await provider.downloadFileToPath(
      "vault",
      "a/b.md",
      ".easy-sync/tmp/a.md.part",
      adapter,
      undefined,
      undefined,
      undefined,
      expected,
    );

    expect(result).toEqual({ size: 5, hash: expected });
    expect(bufferText(writes.get(".easy-sync/tmp/a.md.part")!)).toBe("hello");
  });

  it("expectedSha256 不匹配时抛错", async () => {
    const { provider } = await createProvider();
    fixture.fake.seedFile("/vault/a/b.md", "hello");
    const { adapter } = makeAdapter();
    const expected = "0".repeat(64);

    const error = (await provider
      .downloadFileToPath(
        "vault",
        "a/b.md",
        ".easy-sync/tmp/a.md.part",
        adapter,
        undefined,
        undefined,
        undefined,
        expected,
      )
      .then(
        () => null,
        (cause: unknown) => cause,
      )) as WebDavDownloadHashMismatchError;

    expect(error).toBeInstanceOf(WebDavDownloadHashMismatchError);
    expect(error.path).toBe("a/b.md");
    expect(error.expectedSha256).toBe(expected);
    expect(error.actualSha256).toBe(fixture.sha256("hello"));
  });

  it("缺失文件按 NotFound 抛中性错误", async () => {
    const { provider } = await createProvider();
    await expect(
      provider.downloadFile("vault", "missing.md"),
    ).rejects.toMatchObject({
      type: RemoteErrorType.NotFound,
      statusCode: 404,
    });
  });
});

describe("WebDAV provider Cloud Bootstrap V2", () => {
  it("缺失时返回 null，创建前确保控制集合，读取／按 ID 读取一致", async () => {
    const { provider } = await createProvider();
    expect(await provider.readCloudBootstrapV2("vault")).toBeNull();

    const content = '{"schemaVersion":2}';
    const created = await provider.createCloudBootstrapV2("vault", content);
    expect(created.id).toBe(WEBDAV_CLOUD_BOOTSTRAP_V2_PATH);
    expect(created.eTag.length).toBeGreaterThan(0);
    expect(fixture.fake.getResource("/vault/.easy-sync")?.kind).toBe("collection");
    expect(fixture.fake.readText("/vault/.easy-sync/cloud-bootstrap-v2.json")).toBe(
      content,
    );

    const mkcolIndex = fixture.fake.requests.findIndex(
      (request) =>
        request.method === "MKCOL" && request.decodedPath === "/vault/.easy-sync",
    );
    const putIndex = fixture.fake.requests.findIndex(
      (request) =>
        request.method === "PUT"
        && request.decodedPath === "/vault/.easy-sync/cloud-bootstrap-v2.json",
    );
    expect(mkcolIndex).toBeGreaterThanOrEqual(0);
    expect(mkcolIndex).toBeLessThan(putIndex);

    const read = await provider.readCloudBootstrapV2("vault");
    expect(read).toEqual({
      id: WEBDAV_CLOUD_BOOTSTRAP_V2_PATH,
      eTag: created.eTag,
      content,
    });

    const readById = await provider.readCloudBootstrapV2ById(created.id);
    expect(readById).toEqual(read);
  });

  it("更新带 If-Match；陈旧 eTag 拒绝且远端字节不变", async () => {
    const { provider } = await createProvider();
    const created = await provider.createCloudBootstrapV2("vault", '{"v":1}');
    const updated = await provider.updateCloudBootstrapV2(
      created.id,
      created.eTag,
      '{"v":2}',
    );
    expect(updated.id).toBe(created.id);
    expect(updated.eTag).not.toBe(created.eTag);
    expect(fixture.fake.readText("/vault/.easy-sync/cloud-bootstrap-v2.json")).toBe(
      '{"v":2}',
    );
    const conditionalPut = fixture.fake.requests
      .filter(
        (request) =>
          request.method === "PUT"
          && request.decodedPath === "/vault/.easy-sync/cloud-bootstrap-v2.json",
      )
      .at(-1);
    expect(conditionalPut?.ifMatch).toBe(created.eTag);

    await expect(
      provider.updateCloudBootstrapV2(created.id, created.eTag, '{"v":3}'),
    ).rejects.toBeInstanceOf(WebDavPreconditionFailedError);
    expect(fixture.fake.readText("/vault/.easy-sync/cloud-bootstrap-v2.json")).toBe(
      '{"v":2}',
    );
  });

  it("404 时返回 null；按 ID 读取缺失抛 NotFound", async () => {
    const { provider } = await createProvider();
    await provider.createCloudBootstrapV2("vault", '{"v":1}');
    const deleted = await fixture.raw(
      "DELETE",
      "/vault/.easy-sync/cloud-bootstrap-v2.json",
    );
    expect(deleted.status).toBe(204);

    expect(await provider.readCloudBootstrapV2("vault")).toBeNull();
    await expect(
      provider.readCloudBootstrapV2ById(WEBDAV_CLOUD_BOOTSTRAP_V2_PATH),
    ).rejects.toMatchObject({
      type: RemoteErrorType.NotFound,
      statusCode: 404,
    });
  });

  it("坚果云画像下通过 staged-MOVE 安全创建", async () => {
    const { provider } = await createProvider(NUTSTORE_PROFILES);
    const created = await provider.createCloudBootstrapV2("vault", '{"v":1}');
    expect(created.eTag.length).toBeGreaterThan(0);
    expect(fixture.fake.readText("/vault/.easy-sync/cloud-bootstrap-v2.json")).toBe(
      '{"v":1}',
    );
    const moves = fixture.fake.requests.filter(
      (request) =>
        request.method === "MOVE"
        && (request.destination ?? "").endsWith(
          "/vault/.easy-sync/cloud-bootstrap-v2.json",
        ),
    );
    expect(moves.length).toBeGreaterThan(0);
  });
});

describe("WebDAV provider 能力缺失与只读降级", () => {
  it("回收站恢复抛 capability-missing 且零请求", async () => {
    const { provider } = await createProvider();
    const before = fixture.fake.requests.length;

    const error = (await provider
      .restoreDeletedDriveItemById("a/b.md")
      .then(
        () => null,
        (cause: unknown) => cause,
      )) as RemoteError;
    expect(error).toBeInstanceOf(RemoteError);
    expect(error.type).toBe(RemoteErrorType.Unknown);
    expect(error.graphCode).toBe("capability-missing");

    expect(fixture.fake.requests.length).toBe(before);
  });

  it("版本／基线返回合法空观察且零请求", async () => {
    const { provider } = await createProvider();
    const before = fixture.fake.requests.length;

    expect(await provider.listDriveItemVersionsById("a/b.md")).toEqual([]);
    expect(await provider.downloadBaseline("vault")).toBeNull();

    expect(fixture.fake.requests.length).toBe(before);
  });

  it("共享协议在 .easy-sync 缺失时返回空观察，不伪造控制对象", async () => {
    const { provider } = await createProvider();

    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).resolves.toEqual({
      v2: null,
      v3: null,
    });
  });
});

describe("WebDAV provider Delta、scope 与运行度量", () => {
  it("delta 退化为一次完整扫描／直接子项，不伪造 deltaLink", async () => {
    const { provider } = await createProvider();
    seedUserTree();

    const delta = await provider.getDelta("vault");
    expect(idsOf(delta.value)).toEqual(idsOf(await provider.fullScan("vault")));
    expect(delta["@odata.deltaLink"]).toBeUndefined();
    expect(delta["@odata.nextLink"]).toBeUndefined();

    const folderDelta = await provider.getDeltaByFolderId("a");
    expect(idsOf(folderDelta.value)).toEqual(["a/b.md", "a/sub"]);
    expect(folderDelta["@odata.deltaLink"]).toBeUndefined();

    const rootDelta = await provider.getDeltaByFolderId("/");
    expect(idsOf(rootDelta.value)).toEqual([
      ".easysync-user-file.md",
      "a",
      "empty",
      "root.md",
    ]);
  });

  it("scope 生命周期按固定映射返回，删除式方法返回 false / no-op", async () => {
    const { provider } = await createProvider();
    const scope: RemoteVaultScope = {
      driveId: "/other",
      vaultFolderId: "other",
      filesRootId: "files",
    };

    expect(await provider.initVaultScope("vault")).toEqual({
      driveId: DRIVE_ID,
      vaultFolderId: "/",
      filesRootId: "/",
    });
    expect(await provider.restoreVaultScopeByIdentity("vault", scope)).toBe(scope);
    expect(provider.restoreVaultScope("vault", scope, "delta-link")).toBe(false);
    expect(provider.isDeltaLinkForVault("vault", "delta-link")).toBe(false);
    expect(() => provider.invalidateVaultScope("vault")).not.toThrow();
  });

  it("initVaultScope 验证根集合：存在通过、缺失按 createMissing 决定", async () => {
    const { provider } = await createProvider();
    expect(await provider.initVaultScope("vault")).toEqual({
      driveId: DRIVE_ID,
      vaultFolderId: "/",
      filesRootId: "/",
    });

    const deleted = await fixture.raw("DELETE", "/vault");
    expect(deleted.status).toBe(204);

    const missingBaseline = fixture.fake.requests.length;
    await expect(provider.initVaultScope("vault")).rejects.toBeInstanceOf(
      WebDavRootMissingError,
    );
    expect(
      fixture.fake.requests
        .slice(missingBaseline)
        .filter((request) => request.method === "MKCOL"),
    ).toHaveLength(0);

    const recreated = await provider.initVaultScope("vault", {
      createMissing: true,
    });
    expect(recreated).toEqual({
      driveId: DRIVE_ID,
      vaultFolderId: "/",
      filesRootId: "/",
    });
    expect(fixture.fake.getResource("/vault")?.kind).toBe("collection");
    expect(
      fixture.fake.requests
        .slice(missingBaseline)
        .filter(
          (request) =>
            request.method === "MKCOL" && request.decodedPath === "/vault",
        ),
    ).toHaveLength(1);
  });

  it("根缺失 fail-closed：恢复 scope／fullScan／getDelta 抛 WebDavRootMissingError", async () => {
    const { provider } = await createProvider();
    const scope: RemoteVaultScope = {
      driveId: DRIVE_ID,
      vaultFolderId: "/",
      filesRootId: "/",
    };
    expect((await fixture.raw("DELETE", "/vault")).status).toBe(204);

    await expect(
      provider.restoreVaultScopeByIdentity("vault", scope),
    ).rejects.toBeInstanceOf(WebDavRootMissingError);
    await expect(provider.fullScan("vault")).rejects.toBeInstanceOf(
      WebDavRootMissingError,
    );
    await expect(provider.getDelta("vault")).rejects.toBeInstanceOf(
      WebDavRootMissingError,
    );

    // 普通子目录缺失仍是中性 NotFound，不能被误报为「根缺失」。
    const folderFailure = await provider
      .listFolderChildrenById("missing-folder")
      .then(() => null, (error: unknown) => error);
    expect(folderFailure).toBeInstanceOf(RemoteError);
    expect(folderFailure).not.toBeInstanceOf(WebDavRootMissingError);
  });

  it("运行度量与下载策略保持零行为", async () => {
    const { provider } = await createProvider();
    expect(() => provider.setAbortSignal(new AbortController().signal)).not.toThrow();
    expect(() => provider.setAbortSignal(null)).not.toThrow();
    expect(() => provider.beginRunMetrics()).not.toThrow();
    expect(provider.finishRunMetrics()).toBeNull();
    expect(() => provider.resetDownloadStrategy()).not.toThrow();
    expect(provider.hasDegradedDownloadPathThisRound()).toBe(false);
  });
});

describe("WebDAV provider 错误类型导出面", () => {
  it("错误类可用于 instanceof 与中性错误判定", () => {
    expect(new WebDavProviderNotInitializedError()).toBeInstanceOf(Error);
    expect(new WebDavListingIncompleteError("/vault", 750, 750)).toMatchObject({
      path: "/vault",
      limit: 750,
      responseEntryCount: 750,
    });
    expect(new WebDavUploadTooLargeError(9, 8)).toMatchObject({
      bytes: 9,
      limit: 8,
    });
    expect(
      new WebDavDownloadHashMismatchError("a.md", "expected", "actual"),
    ).toMatchObject({
      path: "a.md",
      expectedSha256: "expected",
      actualSha256: "actual",
    });
    expect(new WebDavCapabilityMissingError("deleteItem")).toMatchObject({
      type: RemoteErrorType.Unknown,
      graphCode: "capability-missing",
    });
  });
});
