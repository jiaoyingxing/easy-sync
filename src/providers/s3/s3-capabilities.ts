/**
 * S3 的 14 位能力声明、3 项协议事实与逐会话探针。
 *
 * 两条设计约束：
 * - 能力是执行依据，不是宣传字段；探测结果**不进同步权威**，可丢弃、每会话
 *   重探（§2.2）；
 * - 能力漂移必须能降级：探针里任何一项没有观察到预期语义（例如 create 碰撞
 *   仍返回 200、目标条件 COPY 仍覆盖），就把对应位置 false，由上层 fail-closed
 *   或降级，不允许「先查再写」冒充同等安全。
 *
 * 探针只碰 `<root>/.easy-sync/probe/` 下的临时对象，结束后清理；它不写
 * `scope.json`，也不发任何用户内容。
 */
import type { ProviderCapabilities } from "../../sync/provider-capabilities";
import { OneDriveErrorType } from "../../onedrive/types";
import { S3Error } from "./s3-errors";
import type { S3ListedObject } from "./s3-enum-checkpoint";

export type S3Platform = "desktop" | "mobile";

/** 单次 PUT 的安全切路阈值（客户端策略，不是服务端硬上限）。 */
export const S3_MAX_SINGLE_PUT_BYTES_DESKTOP = 32 * 1024 * 1024;
export const S3_MAX_SINGLE_PUT_BYTES_MOBILE = 8 * 1024 * 1024;
/** 单次 GET 的内存上限（初始值；S2 实测后按传输专题登记）。 */
export const S3_MAX_SINGLE_GET_BYTES_DESKTOP = 64 * 1024 * 1024;
export const S3_MAX_SINGLE_GET_BYTES_MOBILE = 16 * 1024 * 1024;

/** 13 位布尔能力＋`maxSinglePutBytes`；按平台返回冻结常量。 */
export function s3Capabilities(platform: S3Platform = "desktop"): Readonly<ProviderCapabilities> {
  return Object.freeze({
    stableIdentity: false,
    conditionalCreate: true,
    conditionalUpdate: true,
    conditionalDelete: true,
    serverSideMove: false,
    deltaCursor: false,
    folderEntity: false,
    // AWS 的 ETag 不是通用内容 MD5；附加校验和逐产品探测，V1 不依赖。
    contentChecksum: false,
    contentVersionToken: false,
    versionHistory: false,
    recycleBin: false,
    rangeDownload: true,
    resumableUpload: true,
    maxSinglePutBytes: platform === "mobile"
      ? S3_MAX_SINGLE_PUT_BYTES_MOBILE
      : S3_MAX_SINGLE_PUT_BYTES_DESKTOP,
  });
}

export const S3_CAPABILITIES: Readonly<ProviderCapabilities> = s3Capabilities("desktop");

/** 协议事实：不是 14 位能力，但同样决定「这轮能不能安全地做」。 */
export interface S3ProtocolFacts {
  readonly listingConsistency: "strong" | "eventual";
  readonly maxSingleGetBytes: number;
  readonly conditionalCopyTarget: boolean;
}

export function s3ProtocolFacts(platform: S3Platform = "desktop"): Readonly<S3ProtocolFacts> {
  return Object.freeze({
    listingConsistency: "strong",
    maxSingleGetBytes: platform === "mobile"
      ? S3_MAX_SINGLE_GET_BYTES_MOBILE
      : S3_MAX_SINGLE_GET_BYTES_DESKTOP,
    conditionalCopyTarget: true,
  });
}

/** 探针只依赖这些结构化原语；由 `S3Client` 满足。 */
export interface S3ProbeClient {
  putObjectCreateOnly(key: string, body: ArrayBuffer): Promise<{ eTag: string | null }>;
  putObjectUpdate(
    key: string,
    body: ArrayBuffer,
    options: { ifMatch: string },
  ): Promise<{ eTag: string | null }>;
  deleteObject(key: string, options: { ifMatch: string }): Promise<void>;
  headObject(key: string): Promise<{ exists: boolean; eTag: string | null }>;
  /** 条件写／COPY 的负向与阳性对照都靠回读字节，不能只看 2xx。 */
  getObject(key: string): Promise<{ readonly body: ArrayBuffer }>;
  copyObject(args: {
    sourceKey: string;
    targetKey: string;
    sourceETag: string;
    conditionalCopyTarget: boolean;
  }): Promise<{ eTag: string | null }>;
  listObjectsV2?(args: {
    prefix?: string;
    continuationToken?: string;
    maxKeys?: number;
  }): Promise<{ objects: readonly S3ListedObject[]; isTruncated: boolean; nextContinuationToken?: string }>;
}

export interface S3ProbeOptions {
  readonly platform?: S3Platform;
  /** 探针对象前缀；默认 `.easy-sync/probe`（调用方应带根前缀）。 */
  readonly keyPrefix?: string;
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
}

export interface S3ProbeObservation {
  readonly step: string;
  readonly expected: string;
  readonly observed: string;
  readonly passed: boolean;
}

export interface S3ProbeResult {
  readonly capabilities: Readonly<ProviderCapabilities>;
  readonly protocolFacts: Readonly<S3ProtocolFacts>;
  readonly observations: readonly S3ProbeObservation[];
  readonly probedAt: string;
}

const PROBE_BODY = toArrayBuffer("easysync-s3-probe");
const PROBE_UPDATED_BODY = toArrayBuffer("easysync-s3-probe-updated");
const PROBE_COLLISION_BODY = toArrayBuffer("easysync-s3-probe-collision");
const PROBE_SOURCE_BODY = toArrayBuffer("easysync-s3-probe-copy-source");
const PROBE_TARGET_BODY = toArrayBuffer("easysync-s3-probe-copy-target");

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

async function readBodyOrNull(client: S3ProbeClient, key: string): Promise<ArrayBuffer | null> {
  try {
    return (await client.getObject(key)).body;
  } catch {
    return null;
  }
}

async function readHeadOrNull(
  client: S3ProbeClient,
  key: string,
): Promise<{ exists: boolean; eTag: string | null } | null> {
  try {
    return await client.headObject(key);
  } catch {
    return null;
  }
}

class ProbeRecorder {
  readonly observations: S3ProbeObservation[] = [];

  record(step: string, expected: string, observed: string, passed: boolean): void {
    this.observations.push({ step, expected, observed, passed });
  }
}

function isPreconditionFailed(error: unknown): boolean {
  return error instanceof S3Error && error.type === OneDriveErrorType.PreconditionFailed;
}

function describeError(error: unknown): string {
  if (error instanceof S3Error) return `${error.type}/${error.code || "no-code"}/HTTP ${error.status}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 逐会话能力探针（设计 §9.3 的 1–8 步＋LIST 一致性）。
 *
 * 返回值非权威：每一步都记 expected／observed／passed，失败也会留下诊断；
 * 临时对象在 `finally` 中尽力清理。
 */
export async function probeS3Capabilities(
  client: S3ProbeClient,
  options: S3ProbeOptions = {},
): Promise<S3ProbeResult> {
  const platform = options.platform ?? "desktop";
  const base = s3Capabilities(platform);
  const keyPrefix = (options.keyPrefix ?? ".easy-sync/probe").replace(/\/+$/, "");
  const suffix = options.randomSuffix ? options.randomSuffix() : `${Date.now().toString(36)}-${randomHex()}`;
  const createKey = `${keyPrefix}/${suffix}-create`;
  const sourceKey = `${keyPrefix}/${suffix}-copy-source`;
  const targetKey = `${keyPrefix}/${suffix}-copy-target`;
  const freshTargetKey = `${keyPrefix}/${suffix}-copy-fresh-target`;
  const listKeys = [1, 2, 3].map((index) => `${keyPrefix}/${suffix}-list-${index}`);
  const recorder = new ProbeRecorder();
  let conditionalCreate = base.conditionalCreate;
  let conditionalUpdate = base.conditionalUpdate;
  let conditionalDelete = base.conditionalDelete;
  let conditionalCopyTarget = true;
  let listingConsistency: "strong" | "eventual" = "strong";
  const cleanupKeys: string[] = [createKey, sourceKey, targetKey, freshTargetKey, ...listKeys];

  try {
    // 1. create-only 首次写入。
    try {
      const created = await client.putObjectCreateOnly(createKey, PROBE_BODY);
      recorder.record("conditionalCreate:first", "create succeeds", "created", true);
      // 2. 对同一 key 再发 create-only，期望 412。
      try {
        await client.putObjectCreateOnly(createKey, PROBE_COLLISION_BODY);
        conditionalCreate = false;
        recorder.record(
          "conditionalCreate:collision",
          "HTTP 412",
          "second create succeeded; conditionalCreate=false",
          false,
        );
      } catch (error) {
        const passed = isPreconditionFailed(error);
        if (!passed) conditionalCreate = false;
        recorder.record("conditionalCreate:collision", "HTTP 412", describeError(error), passed);
      }
      // 3–4. stale If-Match 必须 412 且不改字节；当前 ETag 必须成功并回读字节。
      const head = await client.headObject(createKey);
      const currentETag = head.eTag ?? created.eTag;
      let staleUpdateRejected = false;
      try {
        await client.putObjectUpdate(createKey, PROBE_UPDATED_BODY, { ifMatch: '"bogus-easysync-probe"' });
        conditionalUpdate = false;
        recorder.record("conditionalUpdate:stale", "HTTP 412", "stale update succeeded", false);
      } catch (error) {
        const passed = isPreconditionFailed(error);
        if (!passed) conditionalUpdate = false;
        staleUpdateRejected = passed;
        recorder.record("conditionalUpdate:stale", "HTTP 412", describeError(error), passed);
      }
      if (staleUpdateRejected) {
        // 412 本身不等于「没写」：必须回读，确认陈旧请求没有改动对象字节。
        const staleBody = await readBodyOrNull(client, createKey);
        const unchanged = staleBody !== null && buffersEqual(staleBody, PROBE_BODY);
        if (!unchanged) conditionalUpdate = false;
        recorder.record(
          "conditionalUpdate:stale-bytes",
          "stale If-Match leaves the object bytes unchanged",
          unchanged ? "unchanged" : "bytes changed or unreadable",
          unchanged,
        );
      }
      if (currentETag) {
        try {
          await client.putObjectUpdate(createKey, PROBE_UPDATED_BODY, { ifMatch: currentETag });
          const updatedBody = await readBodyOrNull(client, createKey);
          const applied = updatedBody !== null && buffersEqual(updatedBody, PROBE_UPDATED_BODY);
          if (!applied) conditionalUpdate = false;
          recorder.record(
            "conditionalUpdate:current",
            "2xx and updated bytes read back",
            applied ? "updated" : "2xx but bytes not updated or unreadable",
            applied,
          );
        } catch (error) {
          conditionalUpdate = false;
          recorder.record("conditionalUpdate:current", "update succeeds", describeError(error), false);
        }
      } else {
        conditionalUpdate = false;
        recorder.record("conditionalUpdate:current", "ETag from HEAD", "no ETag", false);
      }
      // 5–6. stale 条件删除必须 412；当前 ETag 必须删除。
      const beforeDelete = await client.headObject(createKey);
      if (beforeDelete.exists && beforeDelete.eTag) {
        try {
          await client.deleteObject(createKey, { ifMatch: '"bogus-easysync-probe"' });
          conditionalDelete = false;
          recorder.record("conditionalDelete:stale", "HTTP 412", "stale delete succeeded", false);
        } catch (error) {
          const passed = isPreconditionFailed(error);
          if (!passed) conditionalDelete = false;
          recorder.record("conditionalDelete:stale", "HTTP 412", describeError(error), passed);
        }
        try {
          await client.deleteObject(createKey, { ifMatch: beforeDelete.eTag });
          recorder.record("conditionalDelete:current", "HTTP 204", "deleted", true);
        } catch (error) {
          conditionalDelete = false;
          recorder.record("conditionalDelete:current", "HTTP 204", describeError(error), false);
        }
        // 7. HEAD 复核 404；204 不是删除证据，HEAD 仍在就必须降级。
        const afterDelete = await readHeadOrNull(client, createKey);
        const absent = afterDelete !== null && !afterDelete.exists;
        if (!absent) conditionalDelete = false;
        recorder.record(
          "delete:verify",
          "HEAD returns 404",
          afterDelete === null
            ? "HEAD failed"
            : afterDelete.exists
              ? "HEAD still returns 200"
              : "HEAD returns 404",
          absent,
        );
      } else {
        // 没有 HEAD ETag 就无法证明条件删除；保持基线 true 会把「无 ETag」
        // 服务端误报成支持条件删除。
        conditionalDelete = false;
        recorder.record(
          "conditionalDelete:precondition",
          "HEAD returns an ETag for the probe object",
          beforeDelete.exists ? "HEAD returned no ETag" : "HEAD reports the probe object missing",
          false,
        );
      }
    } catch (error) {
      recorder.record("conditionalCreate:first", "create succeeds", describeError(error), false);
      conditionalCreate = false;
      conditionalUpdate = false;
      conditionalDelete = false;
    }

    // 8. 目标条件 COPY：负向（已存在目标必须 412 且不改字节）＋阳性对照
    // （复制到不存在目标必须成功），两者都观察到了才算 conditionalCopyTarget。
    try {
      await client.putObjectCreateOnly(sourceKey, PROBE_SOURCE_BODY);
      await client.putObjectCreateOnly(targetKey, PROBE_TARGET_BODY);
      const sourceHead = await client.headObject(sourceKey);
      if (!sourceHead.eTag) {
        conditionalCopyTarget = false;
        recorder.record("conditionalCopyTarget", "source ETag from HEAD", "no ETag", false);
      } else {
        let rejectedWithoutOverwrite = false;
        try {
          await client.copyObject({
            sourceKey,
            targetKey,
            sourceETag: sourceHead.eTag,
            conditionalCopyTarget: true,
          });
          conditionalCopyTarget = false;
          recorder.record("conditionalCopyTarget", "HTTP 412", "copy overwrote target", false);
        } catch (error) {
          const passed = isPreconditionFailed(error);
          if (!passed) conditionalCopyTarget = false;
          const targetBody = await readBodyOrNull(client, targetKey);
          const unchanged = targetBody !== null && buffersEqual(targetBody, PROBE_TARGET_BODY);
          if (!unchanged) conditionalCopyTarget = false;
          rejectedWithoutOverwrite = passed && unchanged;
          recorder.record(
            "conditionalCopyTarget",
            "HTTP 412 and the destination bytes unchanged",
            `${describeError(error)}; destination ${unchanged ? "unchanged" : "changed or unreadable"}`,
            rejectedWithoutOverwrite,
          );
        }
        if (rejectedWithoutOverwrite) {
          try {
            await client.copyObject({
              sourceKey,
              targetKey: freshTargetKey,
              sourceETag: sourceHead.eTag,
              conditionalCopyTarget: true,
            });
            const copiedBody = await readBodyOrNull(client, freshTargetKey);
            const copied = copiedBody !== null && buffersEqual(copiedBody, PROBE_SOURCE_BODY);
            if (!copied) conditionalCopyTarget = false;
            recorder.record(
              "conditionalCopyTarget:absent-target",
              "copy to an absent destination succeeds with the source bytes",
              copied ? "copied" : "copy returned success but bytes differ or are unreadable",
              copied,
            );
          } catch (error) {
            conditionalCopyTarget = false;
            recorder.record(
              "conditionalCopyTarget:absent-target",
              "copy to an absent destination succeeds",
              describeError(error),
              false,
            );
          }
        }
      }
    } catch (error) {
      conditionalCopyTarget = false;
      recorder.record("conditionalCopyTarget", "probe objects creatable", describeError(error), false);
    }

    // LIST 一致性：写 3 个探针 key 后立即列举，任一未命中即 eventual。
    if (client.listObjectsV2) {
      try {
        for (const listKey of listKeys) await client.putObjectCreateOnly(listKey, PROBE_BODY);
        const listed = await client.listObjectsV2({ prefix: `${keyPrefix}/`, maxKeys: 100 });
        const keys = new Set(listed.objects.map((object) => object.key));
        const missing = listKeys.filter((key) => !keys.has(key));
        listingConsistency = missing.length === 0 ? "strong" : "eventual";
        recorder.record(
          "listingConsistency",
          "all probe keys visible immediately",
          missing.length === 0 ? "all visible" : `missing: ${missing.join(", ")}`,
          missing.length === 0,
        );
      } catch (error) {
        listingConsistency = "eventual";
        recorder.record("listingConsistency", "LIST succeeds", describeError(error), false);
      }
    }
  } finally {
    for (const key of cleanupKeys) {
      try {
        const head = await client.headObject(key);
        if (head.exists && head.eTag) await client.deleteObject(key, { ifMatch: head.eTag });
      } catch {
        // 清理失败留下诊断，但不覆盖主结果。
      }
    }
  }

  const capabilities = Object.freeze({
    ...base,
    conditionalCreate,
    conditionalUpdate,
    conditionalDelete,
  });
  const protocolFacts = Object.freeze({
    ...s3ProtocolFacts(platform),
    listingConsistency,
    conditionalCopyTarget,
  });
  return {
    capabilities,
    protocolFacts,
    observations: recorder.observations,
    probedAt: (options.now ? options.now() : new Date()).toISOString(),
  };
}

function randomHex(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
