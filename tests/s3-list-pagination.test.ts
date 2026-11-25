import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  runS3Enumeration,
  type S3EnumCheckpointStore,
} from "../src/providers/s3/s3-enum-checkpoint";
import { S3Client } from "../src/providers/s3/s3-client";
import { FakeS3Server } from "./helpers/fake-s3";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * ListObjectsV2 分页合同：1,001 个 key 两页、`encoding-type=url` 还原、
 * 同页重复去重、跨页重复判列举异常（complete=false、零删除）。
 */
let fake: FakeS3Server;
let client: S3Client;

beforeAll(async () => {
  fake = new FakeS3Server();
  const { endpoint, port } = await fake.start();
  expect(port).toBeGreaterThan(0);
  client = new S3Client({
    endpoint,
    region: "us-east-1",
    bucket: fake.bucket,
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    transport: createFetchS3Transport(),
    retry: { maxAttempts: 1, sleep: async () => undefined },
  });
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
});

afterEach(() => {
  expect(fake.violations).toEqual([]);
});

class MemoryCheckpointStore implements S3EnumCheckpointStore {
  value: string | null = null;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(raw: string): Promise<void> {
    this.value = raw;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

function key(index: number): string {
  return `notes/file-${String(index).padStart(4, "0")}.md`;
}

describe("ListObjectsV2 分页", () => {
  it("1,001 个 key 分两页，continuation-token 驱动循环", async () => {
    for (let index = 0; index < 1001; index += 1) fake.seedObject(key(index), "x");

    const first = await client.listObjectsV2({ prefix: "notes/", maxKeys: 1000 });
    expect(first.objects).toHaveLength(1000);
    expect(first.isTruncated).toBe(true);
    expect(first.nextContinuationToken).toBeTruthy();

    const second = await client.listObjectsV2({
      prefix: "notes/",
      maxKeys: 1000,
      continuationToken: first.nextContinuationToken,
    });
    expect(second.objects).toHaveLength(1);
    expect(second.isTruncated).toBe(false);

    const keys = [...first.objects, ...second.objects].map((object) => object.key);
    expect(keys).toHaveLength(1001);
    expect(new Set(keys).size).toBe(1001);
    expect(keys[0]).toBe(key(0));
    expect(keys[1000]).toBe(key(1000));
  });

  it("encoding-type=url 的 key 按 UTF-8 还原（空格／#／%／+／中文／emoji）", async () => {
    const keys = [
      "odd/a b.md",
      "odd/hash#tag.md",
      "odd/percent%25.md",
      "odd/plus+sign.md",
      "odd/中文 文档.md",
      "odd/emoji😀.md",
    ];
    for (const keyName of keys) fake.seedObject(keyName, "x");

    const page = await client.listObjectsV2({ prefix: "odd/", maxKeys: 1000 });
    expect(page.objects.map((object) => object.key).sort()).toEqual([...keys].sort());
    const request = fake.requests.at(-1);
    expect(request?.rawQuery).toContain("encoding-type=url");
    expect(request?.rawQuery).toContain("list-type=2");
  });

  it("max-keys 被客户端钳到 1000", async () => {
    await client.listObjectsV2({ maxKeys: 5000 });
    expect(fake.requests.at(-1)?.rawQuery).toContain("max-keys=1000");
  });

  it("minio-like 用 `+` 表示空格时也还原为空格", async () => {
    const minioFake = new FakeS3Server({ profile: "minio-like" });
    const started = await minioFake.start();
    try {
      minioFake.seedObject("odd/a b.md", "x");
      minioFake.seedObject("odd/plus+sign.md", "x");
      const minioClient = new S3Client({
        endpoint: started.endpoint,
        region: "us-east-1",
        bucket: minioFake.bucket,
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        transport: createFetchS3Transport(),
        retry: { maxAttempts: 1, sleep: async () => undefined },
      });
      const page = await minioClient.listObjectsV2({ prefix: "odd/" });
      expect(page.objects.map((object) => object.key).sort()).toEqual([
        "odd/a b.md",
        "odd/plus+sign.md",
      ]);
      expect(minioFake.violations).toEqual([]);
    } finally {
      await minioFake.stop();
    }
  });

  it("prefix 只返回匹配对象", async () => {
    fake.seedObject("a/one.md", "x");
    fake.seedObject("a/two.md", "x");
    fake.seedObject("b/three.md", "x");
    const page = await client.listObjectsV2({ prefix: "a/" });
    expect(page.objects.map((object) => object.key)).toEqual(["a/one.md", "a/two.md"]);
  });
});

describe("续点与列举异常", () => {
  it("同页重复 key 去重（last-wins），仍 complete=true", async () => {
    fake.seedObject("notes/a.md", "a");
    fake.seedObject("notes/b.md", "b");
    fake.setSamePageDuplicate(true);
    const store = new MemoryCheckpointStore();
    const result = await runS3Enumeration({
      scopeId: "scope-1",
      prefix: "notes/",
      pageBudget: 10,
      store,
      listPage: (token) => client.listObjectsV2({ prefix: "notes/", continuationToken: token }),
    });
    expect(result.complete).toBe(true);
    expect(result.deletionPermitted).toBe(true);
    expect(result.crossPageDuplicate).toBe(false);
    expect(result.objects.map((object) => object.key)).toEqual(["notes/a.md", "notes/b.md"]);
    expect(fake.snapshotStats().userContent.delete).toBe(0);
  });

  it("跨页重复 → complete=false、deletionPermitted=false、零删除", async () => {
    for (let index = 0; index < 1001; index += 1) fake.seedObject(key(index), "x");
    fake.setCrossPageDuplicate(true);
    const result = await runS3Enumeration({
      scopeId: "scope-1",
      prefix: "notes/",
      pageBudget: 10,
      listPage: (token) => client.listObjectsV2({ prefix: "notes/", continuationToken: token, maxKeys: 1000 }),
    });
    expect(result.crossPageDuplicate).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.deletionPermitted).toBe(false);
    expect(fake.snapshotStats().userContent.delete).toBe(0);
  });

  it("完整列举到 IsTruncated=false 才 complete=true", async () => {
    for (let index = 0; index < 1001; index += 1) fake.seedObject(key(index), "x");
    const result = await runS3Enumeration({
      scopeId: "scope-1",
      prefix: "notes/",
      pageBudget: 10,
      listPage: (token) => client.listObjectsV2({ prefix: "notes/", continuationToken: token, maxKeys: 1000 }),
    });
    expect(result.complete).toBe(true);
    expect(result.deletionPermitted).toBe(true);
    expect(result.pages).toBe(2);
    expect(result.objects).toHaveLength(1001);
  });
});
