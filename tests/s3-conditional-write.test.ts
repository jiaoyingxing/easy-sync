import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OneDriveErrorType } from "../src/onedrive/types";
import { S3Client } from "../src/providers/s3/s3-client";
import { FakeS3Server } from "./helpers/fake-s3";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * 条件写合同：负向用例必须证明「服务端对象没被覆盖」——旧 SHA 不变且写计数
 * 不变，而不是只断言客户端抛了错。
 */
let fake: FakeS3Server;
let client: S3Client;

beforeAll(async () => {
  fake = new FakeS3Server();
  const { endpoint, port } = await fake.start();
  // §4.5 preflight：随机端口必须真的分配。
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

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("条件创建", () => {
  it("create 撞已有 → 412，且对象字节与写计数不变", async () => {
    fake.seedObject("note.md", "original");

    await expect(client.putObjectCreateOnly("note.md", bytes("replacement"))).rejects.toMatchObject({
      type: OneDriveErrorType.PreconditionFailed,
      status: 412,
      code: "PreconditionFailed",
    });

    const snapshot = fake.getObjectSnapshot("note.md");
    expect(snapshot?.sha256).toBe(sha256("original"));
    expect(fake.mutationCounts("note.md").put).toBe(0);
    expect(fake.snapshotStats().userContent.put).toBe(0);
  });

  it("create 成功后可再次读到新字节，第二次 create 仍 412", async () => {
    await client.putObjectCreateOnly("note.md", bytes("first"));
    expect(fake.getObjectSnapshot("note.md")?.sha256).toBe(sha256("first"));
    expect(fake.mutationCounts("note.md").put).toBe(1);

    await expect(client.putObjectCreateOnly("note.md", bytes("second"))).rejects.toMatchObject({
      status: 412,
    });
    expect(fake.getObjectSnapshot("note.md")?.sha256).toBe(sha256("first"));
    expect(fake.mutationCounts("note.md").put).toBe(1);
  });
});

describe("条件更新", () => {
  it("stale If-Match → 412 且不覆盖", async () => {
    fake.seedObject("note.md", "original");
    const head = await client.headObject("note.md");
    expect(head.eTag).not.toBeNull();

    await expect(
      client.putObjectUpdate("note.md", bytes("stale-write"), { ifMatch: '"stale-etag"' }),
    ).rejects.toMatchObject({ type: OneDriveErrorType.PreconditionFailed, status: 412 });

    expect(fake.getObjectSnapshot("note.md")?.sha256).toBe(sha256("original"));
    expect(fake.mutationCounts("note.md").put).toBe(0);
  });

  it("当前 If-Match → 更新成功", async () => {
    fake.seedObject("note.md", "original");
    const head = await client.headObject("note.md");
    const result = await client.putObjectUpdate("note.md", bytes("updated"), { ifMatch: head.eTag! });
    expect(result.eTag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(fake.getObjectSnapshot("note.md")?.sha256).toBe(sha256("updated"));
    expect(fake.mutationCounts("note.md").put).toBe(1);
  });
});

describe("条件删除", () => {
  it("stale If-Match → 412 且对象仍在", async () => {
    fake.seedObject("note.md", "original");
    await expect(client.deleteObject("note.md", { ifMatch: '"stale-etag"' })).rejects.toMatchObject({
      type: OneDriveErrorType.PreconditionFailed,
      status: 412,
    });
    expect(fake.getObjectSnapshot("note.md")?.sha256).toBe(sha256("original"));
    expect(fake.mutationCounts("note.md").delete).toBe(0);
  });

  it("204 不是删除证据：deleteObjectVerified 必须 HEAD 复核", async () => {
    fake.seedObject("note.md", "original");
    const head = await client.headObject("note.md");
    const result = await client.deleteObjectVerified("note.md", { ifMatch: head.eTag! });
    expect(result.deleted).toBe(true);
    expect(result.verifiedAbsent).toBe(true);
    expect(fake.getObjectSnapshot("note.md")).toBeNull();

    const methods = fake.requests.filter((request) => request.key === "note.md").map((request) => request.method);
    expect(methods).toContain("DELETE");
    expect(methods.lastIndexOf("HEAD")).toBeGreaterThan(methods.lastIndexOf("DELETE"));
  });

  it("对不存在的 key 发 DELETE 仍返回 204，但 verified 结果说明它本来就缺席", async () => {
    const result = await client.deleteObjectVerified("missing.md");
    expect(result.deleted).toBe(false);
    expect(result.verifiedAbsent).toBe(true);
    expect(fake.requests.some((request) => request.method === "DELETE")).toBe(false);
  });
});

describe("COPY 目标条件", () => {
  it("目标已存在 → 412，目标字节与 copy 计数不变", async () => {
    fake.seedObject("source.md", "source-bytes");
    fake.seedObject("target.md", "target-bytes");
    const sourceHead = await client.headObject("source.md");

    await expect(
      client.copyObject({
        sourceKey: "source.md",
        targetKey: "target.md",
        sourceETag: sourceHead.eTag!,
        conditionalCopyTarget: true,
      }),
    ).rejects.toMatchObject({ type: OneDriveErrorType.PreconditionFailed, status: 412 });

    expect(fake.getObjectSnapshot("target.md")?.sha256).toBe(sha256("target-bytes"));
    expect(fake.mutationCounts("target.md").copy).toBe(0);
  });

  it("源条件不匹配 → 412 且目标不创建", async () => {
    fake.seedObject("source.md", "source-bytes");
    await expect(
      client.copyObject({
        sourceKey: "source.md",
        targetKey: "target.md",
        sourceETag: '"stale"',
        conditionalCopyTarget: true,
      }),
    ).rejects.toMatchObject({ type: OneDriveErrorType.PreconditionFailed, status: 412 });

    expect(fake.getObjectSnapshot("target.md")).toBeNull();
    expect(fake.mutationCounts("target.md").copy).toBe(0);
  });

  it("已知目标条件不被支持 → 发请求前拒绝，不退化 HEAD+COPY", async () => {
    fake.seedObject("source.md", "source-bytes");
    const before = fake.requests.length;

    await expect(
      client.copyObject({
        sourceKey: "source.md",
        targetKey: "target.md",
        sourceETag: '"any-source-etag"',
        conditionalCopyTarget: false,
      }),
    ).rejects.toMatchObject({ capability: "conditionalCopyTarget" });

    expect(fake.requests.length).toBe(before);
    expect(fake.getObjectSnapshot("target.md")).toBeNull();
    expect(fake.mutationCounts("target.md").copy).toBe(0);
  });

  it("缺源 ETag → 发请求前拒绝", async () => {
    fake.seedObject("source.md", "source-bytes");
    const before = fake.requests.length;
    await expect(
      client.copyObject({
        sourceKey: "source.md",
        targetKey: "target.md",
        sourceETag: "",
        conditionalCopyTarget: true,
      }),
    ).rejects.toMatchObject({ code: "ProtocolError" });
    expect(fake.requests.length).toBe(before);
  });
});
