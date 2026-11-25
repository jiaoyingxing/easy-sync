/**
 * 云端连接测试（C1）：把坐标 + 凭据折成一次真实的 WebDAV 连接测试。
 *
 * 与 W1 的探针同一套客户端：`WebDavClient.initialize()` 会依次验证根集合
 * 存在、根可写、能力探针。返回值只保留用户可见所需的两件事（成功／失败类别），
 * 不把能力位带出这一层——能力是内部执行依据，不进界面。
 *
 * 边界：
 * - 只接受已通过 `validateWebDavCoordinates` 的坐标；本层不重复校验 URL 形态，
 *   但会在组装 endpoint 时再次拒绝非 HTTPS。
 * - 传输层由调用方注入（生产＝宿主 `requestUrl`，测试＝loopback fake），
 *   所以本模块不直接依赖 `obsidian`。
 * - 失败一律折成 `CloudConnectionFailureKind`；不把服务端原文、URL 查询串或
 *   凭据写进返回值。
 */
import { WebDavClient } from "../providers/webdav/webdav-client";
import {
  decodeWebDavPathname,
  WebDavProbeConfigError,
} from "../providers/webdav/webdav-probe";
import { RemoteError, RemoteErrorType } from "../remote/errors";
import type { WebDavTransport } from "../providers/webdav/webdav-probe";
import type {
  CloudConnectionFailureKind,
  WebDavCloudCoordinatesV1,
} from "./cloud-settings";

interface WebDavConnectionTestInput {
  readonly coordinates: WebDavCloudCoordinatesV1;
  readonly password: string;
  readonly transport: WebDavTransport;
  /** 测试用注入；缺省真实时钟。 */
  readonly now?: () => Date;
}

interface WebDavConnectionTestResult {
  readonly ok: boolean;
  readonly failureKind?: CloudConnectionFailureKind;
}

/**
 * 执行一次连接测试。
 *
 * 测试会写一个探针文件并删除它（根可写检查），以及 W1 能力探针的临时对象；
 * 测试结束会尽力清理。测试不动用户已有文件。
 */
export async function testWebDavConnection(
  input: WebDavConnectionTestInput,
): Promise<WebDavConnectionTestResult> {
  if (input.coordinates.url.length === 0 || input.password.length === 0) {
    return { ok: false, failureKind: "config" };
  }
  let client: WebDavClient;
  try {
    client = new WebDavClient({
      endpoint: input.coordinates.url,
      rootPath: resolveRootPath(input.coordinates),
      credentials: {
        username: input.coordinates.username,
        password: input.password,
      },
      transport: input.transport,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    return { ok: false, failureKind: classifyTestFailure(error).kind };
  }
  try {
    const probe = await client.initialize();
    // 探针通过即视为连接可用；受限能力不影响「能连上」这个结论，
    // 也不在本层产生任何用户可见说明。
    return probe.capabilities
      ? { ok: true }
      : { ok: false, failureKind: "unknown" };
  } catch (error) {
    return { ok: false, failureKind: classifyTestFailure(error).kind };
  }
}

/** 同步根＝地址自带路径 + 用户根前缀（均以集合路径表示）。 */
export function resolveRootPath(
  coordinates: WebDavCloudCoordinatesV1,
): string {
  const base = safePathname(coordinates.url);
  const prefix = coordinates.rootPrefix;
  const joined = [base, prefix]
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/gu, "/");
  const trimmed = joined.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return trimmed.length === 0 ? "/" : `/${trimmed}`;
}

/**
 * 失败分类：把传输层、探针与中性 `RemoteError` 都折成少数几类。
 *
 * 分类只用于选一句用户可见的话；`service` 保留 HTTP 状态语义但不带原文。
 */
export function classifyTestFailure(
  error: unknown,
): { readonly kind: CloudConnectionFailureKind } {
  if (error instanceof WebDavProbeConfigError) {
    // 配置层拒绝：非 HTTPS、URL 内嵌凭据、空凭据、点段路径。
    return { kind: "config" };
  }
  if (error instanceof RemoteError) {
    return { kind: failureKindForRemoteError(error) };
  }
  const status = readStatusCode(error);
  if (status !== null) return { kind: failureKindForStatus(status) };
  // 传输层把超时／连不上折成 status 0；其余未识别错误按 unknown。
  const name = error instanceof Error ? error.name : "";
  if (name === "TypeError" || name === "AbortError") {
    return { kind: "network" };
  }
  return { kind: "unknown" };
}

function failureKindForRemoteError(error: RemoteError): CloudConnectionFailureKind {
  switch (error.type) {
    case RemoteErrorType.Unauthorized:
    case RemoteErrorType.AuthExpired:
      return "authRejected";
    case RemoteErrorType.Forbidden:
      return "forbidden";
    case RemoteErrorType.NotFound:
      return "notFound";
    case RemoteErrorType.RateLimited:
      return "rateLimited";
    case RemoteErrorType.NetworkError:
      return "network";
    case RemoteErrorType.ServerError:
    case RemoteErrorType.InsufficientStorage:
    case RemoteErrorType.Conflict:
    case RemoteErrorType.PreconditionFailed:
    case RemoteErrorType.RangeNotSatisfiable:
      return "service";
    default:
      return error.statusCode > 0
        ? failureKindForStatus(error.statusCode)
        : "unknown";
  }
}

function failureKindForStatus(status: number): CloudConnectionFailureKind {
  if (status === 0) return "network";
  if (status === 401) return "authRejected";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 429) return "rateLimited";
  if (status >= 400 && status < 500) return "config";
  if (status >= 500) return "service";
  return "unknown";
}

/** 从若干客户端错误类里读出 HTTP 状态；无状态返回 null。 */
function readStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as { status?: unknown; statusCode?: unknown };
  for (const candidate of [record.status, record.statusCode]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function safePathname(url: string): string {
  try {
    // 坐标可能保存百分号编码；这里还原成段路径，客户端随后只编码一次。
    return decodeWebDavPathname(new URL(url).pathname)
      .replace(/^\/+/u, "")
      .replace(/\/+$/u, "");
  } catch {
    return "";
  }
}
