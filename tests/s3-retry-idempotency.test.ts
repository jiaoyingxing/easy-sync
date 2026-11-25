import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { S3Client } from "../src/providers/s3/s3-client";
import { FakeS3Server } from "./helpers/fake-s3";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * 重试与幂等合同：`503 SlowDown` + `Retry-After` 重试后服务端 mutation
 * 计数仍为 1；条件头在每次重试中原样保留；Complete 已提交但响应丢失时
 * 用 HEAD 目标对象收敛，而不是盲目重传。
 */
let fake: FakeS3Server;
let client: S3Client;
const sleeps: number[] = [];

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
    retry: {
      maxAttempts: 3,
      backoffBaseMs: 1,
      maxBackoffMs: 4,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
  sleeps.length = 0;
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

describe("重试幂等", () => {
  it("PUT create-only：503 SlowDown 后重试，mutation 仍为 1", async () => {
    fake.failNext({
      method: "PUT",
      keyIncludes: "note.md",
      status: 503,
      code: "SlowDown",
      headers: { "retry-after": "1" },
    });
    await client.putObjectCreateOnly("note.md", bytes("payload"));

    expect(sleeps).toContain(1000);
    const requests = fake.requests.filter((request) => request.key === "note.md");
    expect(requests).toHaveLength(2);
    expect(requests[0].headers["if-none-match"]).toBe("*");
    expect(requests[1].headers["if-none-match"]).toBe("*");
    expect(fake.mutationCounts("note.md").put).toBe(1);
    expect(fake.getObjectSnapshot("note.md")?.sha256).toBe(sha256("payload"));
  });

  it("PUT update：重试保持同一 If-Match，mutation 为 1", async () => {
    fake.seedObject("note.md", "old");
    const head = await client.headObject("note.md");
    fake.failNext({ method: "PUT", keyIncludes: "note.md", status: 503, code: "SlowDown" });

    await client.putObjectUpdate("note.md", bytes("new"), { ifMatch: head.eTag! });

    const requests = fake.requests.filter(
      (request) => request.key === "note.md" && request.method === "PUT",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].headers["if-match"]).toBe(head.eTag);
    expect(requests[1].headers["if-match"]).toBe(head.eTag);
    expect(fake.mutationCounts("note.md").put).toBe(1);
    expect(fake.getBody("note.md")?.toString("utf8")).toBe("new");
  });

  it("DELETE：重试保持同一 If-Match，删除计数为 1", async () => {
    fake.seedObject("note.md", "old");
    const head = await client.headObject("note.md");
    fake.failNext({ method: "DELETE", keyIncludes: "note.md", status: 503, code: "SlowDown" });

    await client.deleteObject("note.md", { ifMatch: head.eTag! });

    const requests = fake.requests.filter(
      (request) => request.key === "note.md" && request.method === "DELETE",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].headers["if-match"]).toBe(head.eTag);
    expect(requests[1].headers["if-match"]).toBe(head.eTag);
    expect(fake.mutationCounts("note.md").delete).toBe(1);
    expect(fake.getObjectSnapshot("note.md")).toBeNull();
  });

  it("COPY：重试保持源条件与目标 If-None-Match，copy 计数为 1", async () => {
    fake.seedObject("source.md", "source");
    const head = await client.headObject("source.md");
    fake.failNext({ method: "PUT", keyIncludes: "target.md", status: 503, code: "SlowDown" });

    await client.copyObject({
      sourceKey: "source.md",
      targetKey: "target.md",
      sourceETag: head.eTag!,
      conditionalCopyTarget: true,
    });

    const requests = fake.requests.filter(
      (request) => request.key === "target.md" && request.method === "PUT",
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers["x-amz-copy-source"]).toBe(`/${fake.bucket}/source.md`);
      expect(request.headers["x-amz-copy-source-if-match"]).toBe(head.eTag);
      expect(request.headers["if-none-match"]).toBe("*");
    }
    expect(fake.mutationCounts("target.md").copy).toBe(1);
    expect(fake.getBody("target.md")?.toString("utf8")).toBe("source");
  });

  it("UploadPart：同 partNumber 重试，完成后内容只出现一次", async () => {
    const created = await client.createMultipartUpload("big.bin");
    fake.failNext({
      method: "PUT",
      keyIncludes: "big.bin",
      queryIncludes: "partNumber=1",
      status: 503,
      code: "SlowDown",
    });
    const part = await client.uploadPart("big.bin", created.uploadId, 1, bytes("part-1"));
    expect(part.eTag).toBeTruthy();

    const requests = fake.requests.filter(
      (request) => request.key === "big.bin" && request.rawQuery.includes("partNumber=1"),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].rawQuery).toBe(requests[1].rawQuery);

    await client.completeMultipartUpload("big.bin", created.uploadId, [
      { partNumber: 1, eTag: part.eTag! },
    ]);
    expect(fake.getBody("big.bin")?.toString("utf8")).toBe("part-1");
    expect(fake.mutationCounts("big.bin").put).toBe(1);
  });

  it("create 已提交但连接中断 → 重试 412 后用 HEAD＋内容哈希证明收敛", async () => {
    fake.failNext({ method: "PUT", keyIncludes: "note.md", status: 0, afterCommit: true });
    const result = await client.putObjectCreateOnly("note.md", bytes("payload"));
    expect(result.recovered).toBe(true);
    expect(fake.mutationCounts("note.md").put).toBe(1);
    expect(fake.getObjectSnapshot("note.md")?.sha256).toBe(sha256("payload"));
    expect(fake.requests.some((request) => request.method === "HEAD")).toBe(true);
    expect(fake.requests.some((request) => request.method === "GET")).toBe(true);
  });

  it("Complete 已提交但响应 503 → 重试得到 NoSuchUpload 后 HEAD 收敛", async () => {
    const created = await client.createMultipartUpload("big.bin");
    const part = await client.uploadPart("big.bin", created.uploadId, 1, bytes("part-1"));
    fake.failNext({
      method: "POST",
      keyIncludes: "big.bin",
      queryIncludes: "uploadId=",
      status: 503,
      code: "ServiceUnavailable",
      afterCommit: true,
    });

    const completed = await client.completeMultipartUpload("big.bin", created.uploadId, [
      { partNumber: 1, eTag: part.eTag! },
    ]);
    expect(completed.recovered).toBe(true);
    expect(fake.getBody("big.bin")?.toString("utf8")).toBe("part-1");
    expect(fake.mutationCounts("big.bin").put).toBe(1);
    expect(fake.requests.some((request) => request.method === "HEAD" && request.key === "big.bin")).toBe(true);
  });
});

describe("不重试的失败", () => {
  it("412 只请求一次且对象不变", async () => {
    fake.seedObject("note.md", "original");
    await expect(client.putObjectCreateOnly("note.md", bytes("new"))).rejects.toMatchObject({
      status: 412,
    });
    expect(fake.requests.filter((request) => request.key === "note.md")).toHaveLength(1);
    expect(fake.getObjectSnapshot("note.md")?.sha256).toBe(sha256("original"));
    expect(fake.mutationCounts("note.md").put).toBe(0);
  });

  it("网络中断（status 0）受重试预算约束，最终 NetworkError", async () => {
    fake.failNext({ method: "GET", keyIncludes: "note.md", status: 0, times: 5 });
    await expect(client.getObject("note.md")).rejects.toMatchObject({
      type: "NetworkError",
      retry: "backoff",
    });
    expect(fake.requests.filter((request) => request.key === "note.md")).toHaveLength(3);
  });
});
