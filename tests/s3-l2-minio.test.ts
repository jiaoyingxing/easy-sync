import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OneDriveErrorType } from "../src/onedrive/types";
import { probeS3Capabilities, type S3ProbeResult } from "../src/providers/s3/s3-capabilities";
import { S3Client } from "../src/providers/s3/s3-client";
import { signS3Request } from "../src/providers/s3/sigv4";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * L2：固定版 MinIO（真实 S3 服务端）。
 *
 * 固定版本：`RELEASE.2025-04-22T22-12-26Z`
 * 来源：https://github.com/minio/minio/releases/tag/RELEASE.2025-04-22T22-12-26Z
 * 资产：`minio.windows-amd64.RELEASE.2025-04-22T22-12-26Z.exe`
 * 大小：121,008,640 bytes
 * SHA-256：`2ceb3b3d68bdf1c4def9702cb02c5c8adb235197d1c8f2eaad24136833ab9a57`
 * （GitHub asset digest 与该 release 的 `.sha256sum` 互证；本地实测 `--version`
 * 输出同一 tag。）
 *
 * 只有设置 `EASYSYNC_S3_L2_EXE` 指向 MinIO 二进制时才运行；缺失时整组
 * `skipped`，**不得**视为通过（设计 §4.3：跳过≠通过，S1 不得收口）。
 * 数据目录默认建在仓库 `.tmp/s3-l2-minio-*`（可用 `EASYSYNC_S3_L2_DATA_DIR`
 * 覆盖）；`afterAll` 停进程并清理。
 *
 * 覆盖 S1 出口要求：签名被真实服务端接受、条件创建／更新／删除、COPY 目标
 * 条件、multipart、分页与 key 编码。
 *
 * 重要：固定 MinIO 该版本缺少条件删除与 COPY 目标条件；本文件对这两项断言
 * 「probe 降级与真实行为一致」，因此本组全绿只证明探针准确，**不构成 S1
 * 协议级通过**。S1 出口仍需支持这两项的后端。
 */
const MINIO_EXE = process.env.EASYSYNC_S3_L2_EXE ?? "";
const MINIO_VERSION = "RELEASE.2025-04-22T22-12-26Z";
const MINIO_SHA256 = "2ceb3b3d68bdf1c4def9702cb02c5c8adb235197d1c8f2eaad24136833ab9a57";
const MINIO_BYTES = 121_008_640;
const BUCKET = "easysync-l2";
const ACCESS_KEY = "easysync-l2";
const SECRET_KEY = "easysync-l2-secret";

const suite = MINIO_EXE.length > 0 && existsSync(MINIO_EXE) ? describe : describe.skip;

let child: ChildProcess | null = null;
let dataDir = "";
let endpoint = "";
let client: S3Client;
let port = 0;
let minioLog = "";
let probeResult: S3ProbeResult | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a free port")));
        return;
      }
      const allocated = address.port;
      server.close(() => resolve(allocated));
    });
  });
}

async function waitForHealth(deadlineMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/minio/health/live`);
      if (response.ok) return;
    } catch {
      // 服务还没起来。
    }
    if (Date.now() - started > deadlineMs) {
      throw new Error(`MinIO did not become healthy in time. Output:\n${minioLog.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function signedRequest(method: string, path: string, body?: ArrayBuffer): Promise<Response> {
  const signed = await signS3Request({
    method,
    host: `127.0.0.1:${port}`,
    path,
    body,
    region: "us-east-1",
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: signed.headers,
    body,
    redirect: "manual",
  });
}

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

beforeAll(async () => {
  if (MINIO_EXE.length === 0 || !existsSync(MINIO_EXE)) return;
  // §4.2 preflight：先校验二进制身份，再启动服务。
  const binary = readFileSync(MINIO_EXE);
  expect(binary.byteLength).toBe(MINIO_BYTES);
  expect(createHash("sha256").update(binary).digest("hex")).toBe(MINIO_SHA256);
  const version = spawnSync(MINIO_EXE, ["--version"], { encoding: "utf8" });
  expect(version.status).toBe(0);
  expect(`${version.stdout}\n${version.stderr}`).toContain(MINIO_VERSION);
  const dataRoot = process.env.EASYSYNC_S3_L2_DATA_DIR ?? join(process.cwd(), ".tmp");
  mkdirSync(dataRoot, { recursive: true });
  dataDir = mkdtempSync(join(dataRoot, "s3-l2-minio-"));
  port = await freePort();
  let consolePort = await freePort();
  while (consolePort === port) consolePort = await freePort();
  child = spawn(
    MINIO_EXE,
    [
      "server",
      dataDir,
      "--address",
      `127.0.0.1:${port}`,
      "--console-address",
      `127.0.0.1:${consolePort}`,
    ],
    {
      env: {
        ...process.env,
        MINIO_ROOT_USER: ACCESS_KEY,
        MINIO_ROOT_PASSWORD: SECRET_KEY,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    minioLog += chunk.toString("utf8");
  });
  await waitForHealth(90_000);
  endpoint = `http://127.0.0.1:${port}`;
  client = new S3Client({
    endpoint,
    region: "us-east-1",
    bucket: BUCKET,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    transport: createFetchS3Transport(),
    retry: { maxAttempts: 2, sleep: async () => undefined },
  });
  let created: Response | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    created = await signedRequest("PUT", `/${BUCKET}`);
    if (created.status === 200) break;
    const text = await created.text();
    minioLog += `\ncreate bucket attempt ${attempt}: HTTP ${created.status} ${text}`;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(created?.status).toBe(200);
}, 120_000);

afterAll(async () => {
  if (child) {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (dataDir.length > 0) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows 上进程刚退出时可能仍占用文件；临时目录留给系统清理。
    }
  }
}, 30_000);

suite(`L2 MinIO ${MINIO_VERSION}`, () => {
  // 本组验证「客户端与探针在真实服务端上的行为」，不是「S1 出口通过」：
  // 固定 MinIO 缺少条件删除与 COPY 目标条件，下面用独立行为取证证明 probe
  // 的降级是真实的；S1 协议级出口仍需支持这两项的后端。
  it("签名被真实服务端接受（HEAD 不存在对象返回 404，不是 403）", async () => {
    const head = await client.headObject("missing/object.md");
    expect(head.exists).toBe(false);
  });

  it("条件创建与条件更新", async () => {
    probeResult = await probeS3Capabilities(client, {
      platform: "desktop",
      randomSuffix: () => "l2",
    });
    expect(probeResult.capabilities.conditionalCreate).toBe(true);
    expect(probeResult.capabilities.conditionalUpdate).toBe(true);
  });

  it("条件删除：probe 降级与真实行为一致（MinIO 缺口）", async () => {
    // MinIO RELEASE.2025-04-22T22-12-26Z 忽略 DELETE 的 If-Match
    // （minio/minio#21677）。这里同时断言 probe=false 与真实行为，避免
    // 注释说缺口、用例却断言能力为 true 的自相矛盾。
    expect(probeResult).not.toBeNull();
    expect(probeResult!.capabilities.conditionalDelete).toBe(false);

    await client.putObjectCreateOnly("l2/cond-delete.md", bytes("x"));
    await expect(
      client.deleteObject("l2/cond-delete.md", { ifMatch: '"stale-etag"' }),
    ).resolves.toBeUndefined();
    expect((await client.headObject("l2/cond-delete.md")).exists).toBe(false);
  });

  it("COPY 目标条件：probe 降级与真实行为一致（MinIO 缺口）", async () => {
    expect(probeResult).not.toBeNull();
    expect(probeResult!.protocolFacts.conditionalCopyTarget).toBe(false);

    await client.putObjectCreateOnly("l2/copy-source.md", bytes("source"));
    await client.putObjectCreateOnly("l2/copy-target.md", bytes("target"));
    const sourceHead = await client.headObject("l2/copy-source.md");
    await expect(
      client.copyObject({
        sourceKey: "l2/copy-source.md",
        targetKey: "l2/copy-target.md",
        sourceETag: sourceHead.eTag!,
        conditionalCopyTarget: true,
      }),
    ).resolves.toBeTruthy();
    expect(new TextDecoder().decode((await client.getObject("l2/copy-target.md")).body)).toBe("source");
  });

  it("非 ASCII key 与 GET Range", async () => {
    const key = "l2/中文 文档+😀#%.md";
    await client.putObjectCreateOnly(key, bytes("0123456789"));
    const head = await client.headObject(key);
    expect(head.exists).toBe(true);
    const ranged = await client.getObject(key, { range: { offset: 2, length: 4 } });
    expect(ranged.status).toBe(206);
    expect(ranged.rangeAccepted).toBe(true);
    expect(new TextDecoder().decode(ranged.body)).toBe("2345");
    await client.deleteObject(key, { ifMatch: head.eTag! });
    const after = await client.headObject(key);
    expect(after.exists).toBe(false);
  });

  it("multipart 全链路", async () => {
    const created = await client.createMultipartUpload("l2/big.bin");
    const part1Body = new Uint8Array(5 * 1024 * 1024).fill(0x61);
    const part2Body = new TextEncoder().encode("tail");
    const part1 = await client.uploadPart(
      "l2/big.bin",
      created.uploadId,
      1,
      part1Body.buffer.slice(0, part1Body.byteLength) as ArrayBuffer,
    );
    const part2 = await client.uploadPart("l2/big.bin", created.uploadId, 2, part2Body.buffer as ArrayBuffer);
    const completed = await client.completeMultipartUpload("l2/big.bin", created.uploadId, [
      { partNumber: 1, eTag: part1.eTag! },
      { partNumber: 2, eTag: part2.eTag! },
    ]);
    expect(completed.recovered).toBe(false);
    const head = await client.headObject("l2/big.bin");
    expect(head.contentLength).toBe(5 * 1024 * 1024 + 4);

    const abort = await client.createMultipartUpload("l2/abort.bin");
    await client.uploadPart("l2/abort.bin", abort.uploadId, 1, bytes("x"));
    await client.abortMultipartUpload("l2/abort.bin", abort.uploadId);
    await expect(client.listParts("l2/abort.bin", abort.uploadId)).rejects.toMatchObject({
      code: "NoSuchUpload",
    });
  }, 30_000);

  it("ListObjectsV2 分页与 encoding-type=url", async () => {
    await client.putObjectCreateOnly("l2/list/a b.md", bytes("x"));
    await client.putObjectCreateOnly("l2/list/中文.md", bytes("x"));
    await client.putObjectCreateOnly("l2/list/emoji😀.md", bytes("x"));
    const first = await client.listObjectsV2({ prefix: "l2/list/", maxKeys: 2 });
    expect(first.objects).toHaveLength(2);
    expect(first.isTruncated).toBe(true);
    const second = await client.listObjectsV2({
      prefix: "l2/list/",
      maxKeys: 2,
      continuationToken: first.nextContinuationToken,
    });
    expect(second.objects).toHaveLength(1);
    expect(second.isTruncated).toBe(false);
    const keys = [...first.objects, ...second.objects].map((object) => object.key);
    expect(keys).toEqual(expect.arrayContaining(["l2/list/a b.md", "l2/list/中文.md", "l2/list/emoji😀.md"]));
  });

  it("条件失败分类来自真实服务端", async () => {
    await client.putObjectCreateOnly("l2/conflict.md", bytes("a"));
    await expect(client.putObjectCreateOnly("l2/conflict.md", bytes("b"))).rejects.toMatchObject({
      type: OneDriveErrorType.PreconditionFailed,
      status: 412,
    });
    const head = await client.headObject("l2/conflict.md");
    await expect(
      client.putObjectUpdate("l2/conflict.md", bytes("c"), { ifMatch: '"stale"' }),
    ).rejects.toMatchObject({ type: OneDriveErrorType.PreconditionFailed });
    await client.deleteObject("l2/conflict.md", { ifMatch: head.eTag! });
  });
});
