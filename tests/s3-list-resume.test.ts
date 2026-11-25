import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  runS3Enumeration,
  serializeS3EnumCheckpoint,
  type S3EnumCheckpointStore,
} from "../src/providers/s3/s3-enum-checkpoint";
import { S3Client } from "../src/providers/s3/s3-client";
import { FakeS3Server } from "./helpers/fake-s3";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * LIST 续点合同：页数预算截断 → 写续点 → 下一轮从 token 继续 → 最终
 * complete=true；损坏 token／缓存 → 从头重列且零删除。
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
  failWrites = false;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(raw: string): Promise<void> {
    if (this.failWrites) throw new Error("disk full");
    this.value = raw;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

function key(index: number): string {
  return `notes/file-${String(index).padStart(4, "0")}.md`;
}

function seed(count: number): void {
  for (let index = 0; index < count; index += 1) fake.seedObject(key(index), "x");
}

function enumerate(store: MemoryCheckpointStore, pageBudget: number, prefix = "notes/") {
  return runS3Enumeration({
    scopeId: "scope-1",
    prefix,
    pageBudget,
    store,
    now: () => new Date("2026-11-17T12:00:00.000Z"),
    listPage: (token) =>
      client.listObjectsV2({ prefix, continuationToken: token, maxKeys: 1000 }),
  });
}

describe("页数预算与续点", () => {
  it("预算截断 → 写续点、complete=false、deletionPermitted=false", async () => {
    seed(2500);
    const store = new MemoryCheckpointStore();
    const first = await enumerate(store, 2);

    expect(first.complete).toBe(false);
    expect(first.deletionPermitted).toBe(false);
    expect(first.pages).toBe(2);
    expect(first.checkpointWritten).toBe(true);
    expect(first.objects).toHaveLength(2000);
    expect(store.value).not.toBeNull();

    const checkpoint = JSON.parse(store.value!) as Record<string, unknown>;
    expect(checkpoint.schemaVersion).toBe(1);
    expect(checkpoint.providerKind).toBe("s3");
    expect(checkpoint.scopeId).toBe("scope-1");
    expect(checkpoint.prefix).toBe("notes/");
    expect(typeof checkpoint.continuationToken).toBe("string");
    expect(checkpoint.pages).toBe(2);
    expect(fake.snapshotStats().userContent.delete).toBe(0);
  });

  it("下一轮从 token 继续，走到末尾后 complete=true 并清空续点", async () => {
    seed(2500);
    const store = new MemoryCheckpointStore();
    const first = await enumerate(store, 2);
    const second = await enumerate(store, 10);

    expect(second.resumed).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.deletionPermitted).toBe(true);
    expect(second.pages).toBe(1);
    expect(second.objects).toHaveLength(500);
    expect(second.objects[0].key).toBe(key(2000));
    expect(store.value).toBeNull();

    const allKeys = [...first.objects, ...second.objects].map((object) => object.key);
    expect(allKeys).toHaveLength(2500);
    expect(new Set(allKeys).size).toBe(2500);
  });

  it("预算恰好覆盖最后一页时直接 complete=true", async () => {
    seed(1000);
    const store = new MemoryCheckpointStore();
    const result = await enumerate(store, 1);
    expect(result.complete).toBe(true);
    expect(result.pages).toBe(1);
    expect(store.value).toBeNull();
  });

  it("续点写入失败不升级为失败，但 complete=false 且零删除", async () => {
    seed(2500);
    const store = new MemoryCheckpointStore();
    store.failWrites = true;
    const result = await enumerate(store, 1);
    expect(result.complete).toBe(false);
    expect(result.deletionPermitted).toBe(false);
    expect(result.checkpointWritten).toBe(false);
    expect(fake.snapshotStats().userContent.delete).toBe(0);
  });
});

describe("损坏与失效续点", () => {
  it("损坏的缓存 → 从头重列且零删除", async () => {
    seed(1500);
    const store = new MemoryCheckpointStore();
    store.value = "{ this is not json";
    const result = await enumerate(store, 10);
    expect(result.restartReason).toBe("corrupt");
    expect(result.resumed).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.objects).toHaveLength(1500);
    expect(fake.snapshotStats().userContent.delete).toBe(0);
  });

  it("scopeId／prefix 不匹配的续点被忽略", async () => {
    seed(100);
    const store = new MemoryCheckpointStore();
    store.value = serializeS3EnumCheckpoint({
      schemaVersion: 1,
      providerKind: "s3",
      scopeId: "other-scope",
      prefix: "notes/",
      continuationToken: "stale-token",
      startedAt: "2026-11-17T11:00:00.000Z",
      pages: 3,
    });
    const result = await enumerate(store, 10);
    expect(result.restartReason).toBe("corrupt");
    expect(result.complete).toBe(true);
    expect(result.objects).toHaveLength(100);
  });

  it("token 被服务端拒绝（InvalidArgument）→ 从头重列且零删除", async () => {
    seed(1500);
    const store = new MemoryCheckpointStore();
    store.value = serializeS3EnumCheckpoint({
      schemaVersion: 1,
      providerKind: "s3",
      scopeId: "scope-1",
      prefix: "notes/",
      continuationToken: "token-rejected-by-server",
      startedAt: "2026-11-17T11:00:00.000Z",
      pages: 1,
    });
    const result = await enumerate(store, 10);
    expect(result.restartReason).toBe("token-rejected");
    expect(result.resumed).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.objects).toHaveLength(1500);
    expect(fake.snapshotStats().userContent.delete).toBe(0);
  });
});
