/**
 * S3 传输注入面＋`requestUrl` 实现。
 *
 * 生产只走宿主兼容入口 `requestUrl({throw:false})`：4xx／5xx 保留响应体，
 * 由 `s3-errors` 统一分类。`requestUrl` 没有超时参数、也不可中断，所以本层
 * 自建 deadline：超时后放弃等待并返回 `status: 0`（映射为 NetworkError），
 * 但**请求可能仍在宿主侧运行**——这一点必须写进诊断，不能假装已经取消。
 *
 * 测试注入 Node `fetch` 适配器（`tests/helpers/s3-transport.ts`）；本模块
 * 不内嵌任何重试或规划规则。
 */
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { compatClearTimeout, compatSetTimeout, type TimeoutHandle } from "../../obsidian-compat";

export const DEFAULT_S3_REQUEST_DEADLINE_MS = 60_000;

/** 单次 S3 HTTP 请求。`deadlineMs` 由客户端给出，传输层负责兑现。 */
export interface S3HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: ArrayBuffer;
  readonly deadlineMs: number;
}

/** 归一化响应。传输层失败统一返回 `status: 0` 与空体。 */
export interface S3HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ArrayBuffer;
}

export type S3Transport = (request: S3HttpRequest) => Promise<S3HttpResponse>;

export type RequestUrlFunction = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

export interface RequestUrlTransportOptions {
  /** 测试可注入；缺省使用宿主 `requestUrl`。 */
  readonly requestUrlFn?: RequestUrlFunction;
}

export const EMPTY_RESPONSE_BODY = new ArrayBuffer(0);

/**
 * `requestUrl` 适配器。超时／host 抛错都折成 `status: 0`，让错误分类只有
 * 一条网络错误路径；不会把晚到的成功响应当成第二次结果。
 */
export function createRequestUrlTransport(
  options: RequestUrlTransportOptions = {},
): S3Transport {
  const requestUrlFn = options.requestUrlFn ?? requestUrl;
  return async (request: S3HttpRequest): Promise<S3HttpResponse> => {
    const deadlineMs = effectiveDeadline(request.deadlineMs);
    const pending = Promise.resolve().then(() =>
      requestUrlFn({
        url: request.url,
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        // 保留 4xx/5xx 的响应体，错误分类需要 S3 <Error> code。
        throw: false,
      }),
    );
    let timer: TimeoutHandle | undefined;
    const timeout = new Promise<"deadline">((resolve) => {
      timer = compatSetTimeout(() => resolve("deadline"), deadlineMs);
    });
    try {
      const result = await Promise.race([pending, timeout]);
      if (result === "deadline") {
        // 晚到的响应／拒绝不能变成未处理拒绝；结果直接丢弃。
        pending.catch(() => undefined);
        return emptyResponse(0);
      }
      const status = Number.isFinite(result.status) ? result.status : 0;
      return {
        status,
        headers: result.headers ?? {},
        body: result.arrayBuffer instanceof ArrayBuffer ? result.arrayBuffer : EMPTY_RESPONSE_BODY,
      };
    } catch {
      return emptyResponse(0);
    } finally {
      if (timer !== undefined) compatClearTimeout(timer);
    }
  };
}

function effectiveDeadline(deadlineMs: number): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return DEFAULT_S3_REQUEST_DEADLINE_MS;
  return deadlineMs;
}

function emptyResponse(status: number): S3HttpResponse {
  return { status, headers: {}, body: EMPTY_RESPONSE_BODY };
}
