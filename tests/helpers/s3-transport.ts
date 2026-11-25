/**
 * 测试专用 S3 传输：Node `fetch`。
 *
 * 只出现在 `tests/helpers`（eslint 的 `no-nodejs-modules` / `platform` 规则
 * 不允许 src 依赖 Node）。要点：
 *
 * - `redirect: "manual"`：否则 fetch 自动跟随重定向，301 `PermanentRedirect`
 *   的错误映射就测不到；
 * - `AbortController` 兑现 deadline；
 * - 响应体归一化为 `ArrayBuffer`；
 * - 不改写全局 `fetch`，避免跨用例污染。
 *
 * 网络失败与超时都折成 `status: 0`，与生产 `requestUrl` 适配器同一条
 * NetworkError 路径。
 */
import type { S3HttpRequest, S3HttpResponse, S3Transport } from "../../src/providers/s3/s3-transport";

export interface FetchS3TransportOptions {
  readonly fetchFn?: typeof fetch;
  readonly defaultDeadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 30_000;

export function createFetchS3Transport(options: FetchS3TransportOptions = {}): S3Transport {
  const fetchFn = options.fetchFn ?? fetch;
  const defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  return async (request: S3HttpRequest): Promise<S3HttpResponse> => {
    const deadline = Number.isFinite(request.deadlineMs) && request.deadlineMs > 0
      ? request.deadlineMs
      : defaultDeadlineMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline);
    try {
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        redirect: "manual",
        signal: controller.signal,
      });
      const body = await response.arrayBuffer();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return { status: response.status, headers, body };
    } catch {
      return { status: 0, headers: {}, body: new ArrayBuffer(0) };
    } finally {
      clearTimeout(timer);
    }
  };
}
