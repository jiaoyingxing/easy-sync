import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OneDriveErrorType } from "../src/onedrive/types";
import {
  isMultipartETag,
  S3Client,
  type S3ClientConfig,
} from "../src/providers/s3/s3-client";
import { FakeS3Server } from "./helpers/fake-s3";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * 对象操作合同：HEAD／GET／PUT／COPY／DELETE／multipart 的方法、路径、
 * 查询与必备头逐项断言；200 带错误体必须解析；目标条件 copy 缺失时拒绝执行。
 */
let fake: FakeS3Server;
let client: S3Client;
let endpoint = "";

beforeAll(async () => {
  fake = new FakeS3Server();
  const started = await fake.start();
  endpoint = started.endpoint;
  expect(started.port).toBeGreaterThan(0);
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

function text(body: ArrayBuffer): string {
  return new TextDecoder().decode(body);
}

function sha256(textValue: string): string {
  return createHash("sha256").update(textValue).digest("hex");
}

function lastRequest(key: string) {
  return fake.requests.filter((request) => request.key === key).at(-1);
}

describe("HEAD 与 GET", () => {
  it("HEAD 返回 ETag、长度、时间与 x-amz-meta-*", async () => {
    fake.seedObject("dir/note.md", "hello", { contentType: "text/markdown", metadata: { author: "jiaor" } });
    const head = await client.headObject("dir/note.md");
    expect(head.exists).toBe(true);
    expect(head.eTag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(head.contentLength).toBe(5);
    expect(head.lastModified).toBeTruthy();
    expect(head.metadata).toEqual({ author: "jiaor" });
    expect(lastRequest("dir/note.md")?.method).toBe("HEAD");
  });

  it("HEAD 404 表示不存在（不是错误）", async () => {
    const head = await client.headObject("missing.md");
    expect(head.exists).toBe(false);
    expect(head.eTag).toBeNull();
    expect(lastRequest("missing.md")?.status).toBe(404);
  });

  it("GET 返回完整字节；Range 只有 206 且起点相等才接纳", async () => {
    fake.seedObject("range.txt", "0123456789");
    const full = await client.getObject("range.txt");
    expect(full.status).toBe(200);
    expect(text(full.body)).toBe("0123456789");
    expect(full.rangeAccepted).toBe(false);

    const ranged = await client.getObject("range.txt", { range: { offset: 2, length: 4 } });
    expect(ranged.status).toBe(206);
    expect(text(ranged.body)).toBe("2345");
    expect(ranged.contentRange).toBe("bytes 2-5/10");
    expect(ranged.rangeAccepted).toBe(true);
    expect(lastRequest("range.txt")?.headers.range).toBe("bytes=2-5");
  });

  it("服务端忽略 Range 返回 200 时，客户端不把它当作已接纳的区间", async () => {
    fake.seedObject("range.txt", "0123456789");
    fake.setIgnoreRange(true);
    const ranged = await client.getObject("range.txt", { range: { offset: 2, length: 4 } });
    expect(ranged.status).toBe(200);
    expect(ranged.rangeAccepted).toBe(false);
    expect(text(ranged.body)).toBe("0123456789");
  });

  it("Range 未被接纳或 416 时，安全复合操作退回整份 GET", async () => {
    fake.seedObject("range.txt", "0123456789");
    fake.setIgnoreRange(true);
    const fallback = await client.getObjectRangeOrFull("range.txt", { offset: 2, length: 4 });
    expect(fallback.fallbackToFull).toBe(true);
    expect(text(fallback.body)).toBe("0123456789");
    expect(fallback.rangeAccepted).toBe(false);

    fake.setIgnoreRange(false);
    const unsatisfiable = await client.getObjectRangeOrFull("range.txt", { offset: 99, length: 1 });
    expect(unsatisfiable.fallbackToFull).toBe(true);
    expect(text(unsatisfiable.body)).toBe("0123456789");
  });

  it("416 InvalidRange 映射为 RangeNotSatisfiable", async () => {
    fake.seedObject("range.txt", "0123");
    await expect(
      client.getObject("range.txt", { range: { offset: 99, length: 1 } }),
    ).rejects.toMatchObject({
      type: OneDriveErrorType.RangeNotSatisfiable,
      status: 416,
      code: "InvalidRange",
    });
  });

  it("GET 超过客户端内存上限时拒绝继续", async () => {
    fake.seedObject("big.bin", "0123456789");
    const config: S3ClientConfig = {
      endpoint,
      region: "us-east-1",
      bucket: fake.bucket,
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      transport: createFetchS3Transport(),
      maxSingleGetBytes: 4,
      retry: { maxAttempts: 1 },
    };
    const limited = new S3Client(config);
    await expect(limited.getObject("big.bin")).rejects.toMatchObject({
      name: "S3RequestTooLargeError",
    });
  });
});

describe("PUT 与 COPY", () => {
  it("create-only 带 If-None-Match: *、真实 payload hash 与 content-type", async () => {
    await client.putObjectCreateOnly("dir/note.md", bytes("hello"), { contentType: "text/markdown" });
    const request = lastRequest("dir/note.md");
    expect(request?.method).toBe("PUT");
    expect(request?.headers["if-none-match"]).toBe("*");
    expect(request?.headers["x-amz-content-sha256"]).toBe(sha256("hello"));
    expect(request?.headers["content-type"]).toBe("text/markdown");
    expect(request?.bodySha256).toBe(sha256("hello"));
    expect(request?.signedHeaders).toEqual(
      expect.arrayContaining(["host", "x-amz-content-sha256", "x-amz-date", "if-none-match"]),
    );
    expect(fake.violations).toEqual([]);
  });

  it("update 带调用方的原始 If-Match", async () => {
    fake.seedObject("dir/note.md", "old");
    const head = await client.headObject("dir/note.md");
    await client.putObjectUpdate("dir/note.md", bytes("new"), { ifMatch: head.eTag! });
    const request = lastRequest("dir/note.md");
    expect(request?.headers["if-match"]).toBe(head.eTag);
    expect(fake.getBody("dir/note.md")?.toString("utf8")).toBe("new");
  });

  it("COPY 带源编码、源条件与目标 If-None-Match: *", async () => {
    fake.seedObject("dir/source file.md", "copy-me");
    const head = await client.headObject("dir/source file.md");
    const result = await client.copyObject({
      sourceKey: "dir/source file.md",
      targetKey: "dir/target.md",
      sourceETag: head.eTag!,
      conditionalCopyTarget: true,
    });
    expect(result.eTag).toBeTruthy();
    const request = lastRequest("dir/target.md");
    expect(request?.method).toBe("PUT");
    expect(request?.headers["x-amz-copy-source"]).toBe(
      `/${fake.bucket}/dir/source%20file.md`,
    );
    expect(request?.headers["x-amz-metadata-directive"]).toBe("COPY");
    expect(request?.headers["x-amz-copy-source-if-match"]).toBe(head.eTag);
    expect(request?.headers["if-none-match"]).toBe("*");
    expect(fake.getBody("dir/target.md")?.toString("utf8")).toBe("copy-me");
    expect(fake.mutationCounts("dir/target.md").copy).toBe(1);
  });

  it("COPY 200 响应体里的 <Error> 必须解析为失败（即使目标已提交）", async () => {
    fake.seedObject("dir/source.md", "copy-me");
    const sourceHead = await client.headObject("dir/source.md");
    fake.failNext({
      method: "PUT",
      keyIncludes: "dir/target.md",
      status: 200,
      code: "InternalError",
      message: "We encountered an internal error. Please try again.",
      afterCommit: true,
    });
    await expect(
      client.copyObject({
        sourceKey: "dir/source.md",
        targetKey: "dir/target.md",
        sourceETag: sourceHead.eTag!,
        conditionalCopyTarget: true,
      }),
    ).rejects.toMatchObject({
      type: OneDriveErrorType.ServerError,
      code: "InternalError",
      status: 200,
    });
    // 陷阱取证：服务端其实已经提交了目标对象，客户端仍必须按失败处理，
    // 由上层重对账，不能把 200 当成功。
    expect(fake.getBody("dir/target.md")?.toString("utf8")).toBe("copy-me");
    expect(fake.mutationCounts("dir/target.md").copy).toBe(1);
  });

  it("目标条件不被支持 → 不执行 copy，也不 HEAD+COPY", async () => {
    fake.seedObject("dir/source.md", "copy-me");
    fake.seedObject("dir/target.md", "keep-me");
    const before = fake.requests.length;
    await expect(
      client.copyObject({
        sourceKey: "dir/source.md",
        targetKey: "dir/target.md",
        sourceETag: '"any-source-etag"',
        conditionalCopyTarget: false,
      }),
    ).rejects.toMatchObject({ capability: "conditionalCopyTarget" });
    expect(fake.requests.length).toBe(before);
    expect(fake.getBody("dir/target.md")?.toString("utf8")).toBe("keep-me");
  });

  it("超过 5 GiB 的 COPY 由客户端拒绝", async () => {
    await expect(
      client.copyObject({
        sourceKey: "big.bin",
        targetKey: "copy.bin",
        sourceETag: '"any-source-etag"',
        conditionalCopyTarget: true,
        sourceSize: 5 * 1024 * 1024 * 1024 + 1,
      }),
    ).rejects.toMatchObject({ capability: "copyObjectSizeLimit" });
  });
});

describe("DELETE", () => {
  it("条件删除后对象消失；对不存在的 key 也返回 204", async () => {
    fake.seedObject("dir/note.md", "hello");
    const head = await client.headObject("dir/note.md");
    await client.deleteObject("dir/note.md", { ifMatch: head.eTag! });
    expect(fake.getObjectSnapshot("dir/note.md")).toBeNull();

    // 不存在 key 的 204 不是错误，但也不是删除证据。
    await expect(client.deleteObject("dir/note.md", { ifMatch: '"whatever"' })).resolves.toBeUndefined();
    expect(lastRequest("dir/note.md")?.status).toBe(204);
  });
});

describe("multipart", () => {
  it("Create／UploadPart／ListParts／Complete 全链路与 ETag 形态", async () => {
    const created = await client.createMultipartUpload("big.bin", { contentType: "application/octet-stream" });
    expect(created.uploadId).toBeTruthy();
    const createRequest = lastRequest("big.bin");
    expect(createRequest?.method).toBe("POST");
    expect(createRequest?.rawQuery).toContain("uploads=");

    const firstPart = new Uint8Array(5 * 1024 * 1024).fill(0x61);
    const part1 = await client.uploadPart(
      "big.bin",
      created.uploadId,
      1,
      firstPart.buffer.slice(0, firstPart.byteLength) as ArrayBuffer,
    );
    const part2 = await client.uploadPart("big.bin", created.uploadId, 2, bytes("part-2"));
    expect(part1.eTag).toBeTruthy();
    expect(part2.eTag).toBeTruthy();
    const partRequest = lastRequest("big.bin");
    expect(partRequest?.rawQuery).toContain("partNumber=2");
    expect(partRequest?.rawQuery).toContain("uploadId=");

    const listed = await client.listParts("big.bin", created.uploadId);
    expect(listed.parts.map((part) => part.partNumber)).toEqual([1, 2]);
    expect(listed.isTruncated).toBe(false);

    const completed = await client.completeMultipartUpload("big.bin", created.uploadId, [
      { partNumber: 1, eTag: part1.eTag! },
      { partNumber: 2, eTag: part2.eTag! },
    ]);
    expect(completed.recovered).toBe(false);
    expect(isMultipartETag(completed.eTag!)).toBe(true);
    const body = fake.getBody("big.bin");
    expect(body?.byteLength).toBe(5 * 1024 * 1024 + 6);
    expect(body?.subarray(0, 4).toString("utf8")).toBe("aaaa");
    expect(body?.subarray(-6).toString("utf8")).toBe("part-2");
    expect(body?.toString("utf8")).not.toBe(completed.eTag);
    expect(
      fake.requests.filter((request) => request.method === "POST").at(-1)?.rawQuery,
    ).toContain("uploadId=");
  });

  it("Complete 200 响应体里的 <Error> 必须解析为失败（即使对象已提交）", async () => {
    const created = await client.createMultipartUpload("big.bin");
    const firstPart = new Uint8Array(5 * 1024 * 1024).fill(0x61);
    const part = await client.uploadPart(
      "big.bin",
      created.uploadId,
      1,
      firstPart.buffer.slice(0, firstPart.byteLength) as ArrayBuffer,
    );
    fake.failNext({
      method: "POST",
      keyIncludes: "big.bin",
      queryIncludes: "uploadId=",
      status: 200,
      code: "InternalError",
      message: "We encountered an internal error. Please try again.",
      afterCommit: true,
    });
    await expect(
      client.completeMultipartUpload("big.bin", created.uploadId, [
        { partNumber: 1, eTag: part.eTag! },
      ]),
    ).rejects.toMatchObject({
      type: OneDriveErrorType.ServerError,
      code: "InternalError",
      status: 200,
    });
    // 陷阱取证：对象已提交，但 200＋<Error> 必须按失败处理。
    expect(fake.getObjectSnapshot("big.bin")?.size).toBe(5 * 1024 * 1024);
    expect(fake.mutationCounts("big.bin").put).toBe(1);
  });

  it("非最后部件小于 5 MiB 被真实语义拒绝（EntityTooSmall）", async () => {
    const created = await client.createMultipartUpload("small.bin");
    const part1 = await client.uploadPart("small.bin", created.uploadId, 1, bytes("six-byte"));
    const part2 = await client.uploadPart("small.bin", created.uploadId, 2, bytes("tail"));
    await expect(
      client.completeMultipartUpload("small.bin", created.uploadId, [
        { partNumber: 1, eTag: part1.eTag! },
        { partNumber: 2, eTag: part2.eTag! },
      ]),
    ).rejects.toMatchObject({ code: "EntityTooSmall", status: 400 });
    expect(fake.getObjectSnapshot("small.bin")).toBeNull();
    await client.abortMultipartUpload("small.bin", created.uploadId);
  });

  it("未知 uploadId → NoSuchUpload；Abort 对未知会话幂等", async () => {
    await expect(
      client.uploadPart("big.bin", "missing-upload", 1, bytes("x")),
    ).rejects.toMatchObject({ type: OneDriveErrorType.NotFound, code: "NoSuchUpload" });
    await expect(
      client.completeMultipartUpload("big.bin", "missing-upload", [{ partNumber: 1, eTag: '"x"' }]),
    ).rejects.toMatchObject({ code: "NoSuchUpload" });
    await expect(client.abortMultipartUpload("big.bin", "missing-upload")).resolves.toBeUndefined();
  });

  it("Abort 后会话消失，ListParts → NoSuchUpload", async () => {
    const created = await client.createMultipartUpload("big.bin");
    await client.uploadPart("big.bin", created.uploadId, 1, bytes("part-1"));
    await client.abortMultipartUpload("big.bin", created.uploadId);
    await expect(client.listParts("big.bin", created.uploadId)).rejects.toMatchObject({
      code: "NoSuchUpload",
    });
    expect(fake.getObjectSnapshot("big.bin")).toBeNull();
    expect(fake.snapshotStats().userContent.put).toBe(0);
  });

  it("部件号越界在发请求前拒绝", async () => {
    const before = fake.requests.length;
    await expect(client.uploadPart("big.bin", "u", 0, bytes("x"))).rejects.toMatchObject({
      code: "ProtocolError",
    });
    await expect(client.uploadPart("big.bin", "u", 10001, bytes("x"))).rejects.toMatchObject({
      code: "ProtocolError",
    });
    expect(fake.requests.length).toBe(before);
  });
});
