import { describe, expect, it } from "vitest";
import { probeS3Capabilities } from "../src/providers/s3/s3-capabilities";
import { S3Client } from "../src/providers/s3/s3-client";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * S3 live：腾讯云 COS（或任意真实 S3／S3-compatible 桶）能力探针。
 *
 * 默认跳过；设置以下环境变量后运行：
 *   EASYSYNC_S3_LIVE=1
 *   EASYSYNC_S3_ENDPOINT=https://cos.ap-chengdu.myqcloud.com
 *   EASYSYNC_S3_REGION=ap-chengdu
 *   EASYSYNC_S3_BUCKET=easysync-test-1419215605
 *   EASYSYNC_S3_ACCESS_KEY_ID=...
 *   EASYSYNC_S3_SECRET_ACCESS_KEY=...
 *
 * 可选：
 *   EASYSYNC_S3_PROBE_PREFIX=.easy-sync/probe-live
 *
 * 只写探针前缀下的临时对象，`probeS3Capabilities` 结束时会尽力清理；
 * 凭据只从环境变量读取，不进入仓库。探针结果不是「全部必须通过」：
 * 缺少条件删除／COPY 目标条件会如实标 FAIL，正是本轮要拿到的能力表。
 * 唯一硬断言是首笔 create 成功——它证明 endpoint、region、bucket、签名
 * 和权限都正确；其余项按 observed 记录。
 */
const live = process.env.EASYSYNC_S3_LIVE === "1";
const endpoint = process.env.EASYSYNC_S3_ENDPOINT ?? "";
const region = process.env.EASYSYNC_S3_REGION ?? "";
const bucket = process.env.EASYSYNC_S3_BUCKET ?? "";
const accessKeyId = process.env.EASYSYNC_S3_ACCESS_KEY_ID ?? "";
const secretAccessKey = process.env.EASYSYNC_S3_SECRET_ACCESS_KEY ?? "";
const configured =
  live &&
  [endpoint, region, bucket, accessKeyId, secretAccessKey].every(
    (value) => value.trim().length > 0,
  );

const suite = configured ? describe : describe.skip;

suite("S3 live：真实桶能力探针", () => {
  it("跑 probeS3Capabilities 并打印逐项结果", async () => {
    const client = new S3Client({
      endpoint,
      region,
      bucket,
      credentials: { accessKeyId, secretAccessKey },
      transport: createFetchS3Transport(),
      requestDeadlineMs: 60_000,
      retry: { maxAttempts: 2, sleep: async () => undefined },
    });
    const prefix = (process.env.EASYSYNC_S3_PROBE_PREFIX ?? ".easy-sync/probe-live").replace(
      /\/+$/,
      "",
    );

    const result = await probeS3Capabilities(client, { keyPrefix: prefix });

    for (const observation of result.observations) {
      console.log(
        `[${observation.passed ? "PASS" : "FAIL"}] ${observation.step}\n` +
          `  expected: ${observation.expected}\n` +
          `  observed: ${observation.observed}`,
      );
    }

    const summary = {
      conditionalCreate: result.capabilities.conditionalCreate,
      conditionalUpdate: result.capabilities.conditionalUpdate,
      conditionalDelete: result.capabilities.conditionalDelete,
      conditionalCopyTarget: result.protocolFacts.conditionalCopyTarget,
      listingConsistency: result.protocolFacts.listingConsistency,
    };
    console.log(`S3 live probe summary: ${JSON.stringify(summary)}`);

    expect(result.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.observations.length).toBeGreaterThan(0);
    // 首笔 create 失败通常意味着 endpoint／region／bucket／签名／权限之一不对，
    // 此时后续能力观察没有意义，直接失败并保留上面的 observed 诊断。
    expect(
      result.observations.find((entry) => entry.step === "conditionalCreate:first")?.passed,
    ).toBe(true);

    try {
      const listed = await client.listObjectsV2({ prefix: `${prefix}/`, maxKeys: 100 });
      console.log(`S3 live probe leftover objects: ${listed.objects.length}`);
    } catch (error) {
      console.log(
        `S3 live probe leftover check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, 180_000);
});
