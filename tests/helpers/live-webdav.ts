import type { WebDavTransport } from "../../src/providers/webdav/webdav-probe";

/**
 * 真实 WebDAV 探针的共享入口（仅测试使用）。
 *
 * 凭据只从环境变量读取，不写入仓库或日志：
 *   EASYSYNC_WEBDAV_LIVE=1
 *   EASYSYNC_WEBDAV_ENDPOINT=https://dav.jianguoyun.com/dav/
 *   EASYSYNC_WEBDAV_USER=...
 *   EASYSYNC_WEBDAV_PASSWORD=...（应用密码）
 */
export interface LiveWebDavConfig {
  readonly endpoint: string;
  readonly username: string;
  readonly password: string;
}

export function readLiveWebDavConfig(): LiveWebDavConfig | null {
  if (process.env.EASYSYNC_WEBDAV_LIVE !== "1") return null;
  const endpoint = process.env.EASYSYNC_WEBDAV_ENDPOINT ?? "";
  const username = process.env.EASYSYNC_WEBDAV_USER ?? "";
  const password = process.env.EASYSYNC_WEBDAV_PASSWORD ?? "";
  return endpoint.length > 0 && username.length > 0 && password.length > 0
    ? { endpoint, username, password }
    : null;
}

export function basicAuthHeader(config: LiveWebDavConfig): string {
  return `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`;
}

export function liveOrigin(endpoint: string, path: string): string {
  return `${new URL(endpoint).origin}${path}`;
}

export function liveBasePath(endpoint: string): string {
  return new URL(endpoint).pathname.replace(/\/+$/u, "");
}

export function uniqueLiveFolder(prefix: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}`;
}

/** 生产 `WebDavClient` 用的 fetch transport；与既有 live 探针同形。 */
export function createLiveWebDavTransport(): WebDavTransport {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.deadlineMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        redirect: "follow",
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

export interface LiveRawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** 播种/清理用的裸请求；错误体只保留前 300 字符。 */
export async function liveRaw(
  config: LiveWebDavConfig,
  method: string,
  path: string,
  body?: string | Uint8Array,
  headers: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<LiveRawResponse> {
  const response = await fetch(liveOrigin(config.endpoint, path), {
    method,
    headers: { Authorization: basicAuthHeader(config), ...headers },
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: (await response.text()).slice(0, 300),
  };
}

export const liveSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function retryAfterMs(
  headers: Record<string, string>,
  fallbackMs = 30 * 60 * 1000,
): number {
  const raw = headers["retry-after"];
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

/**
 * 503/429/509 且体里是限流语义时按 Retry-After 等待；返回 true 表示已等待，
 * 调用方应重试。等待超过 6 次视为持续限流，测试失败而不是无限挂起。
 */
export async function waitForLiveRateLimit(
  response: LiveRawResponse,
  attempt: number,
  logPrefix: string,
): Promise<boolean> {
  if (response.status !== 503 && response.status !== 429 && response.status !== 509) {
    return false;
  }
  const blocked = response.status === 429
    || response.status === 509
    || /BlockedTemporarily|Too many requests/i.test(response.body);
  if (!blocked) return false;
  if (attempt >= 6) {
    throw new Error(`WebDAV live probe still rate-limited after ${attempt} waits`);
  }
  const delay = retryAfterMs(response.headers);
  console.log(`${logPrefix}_RATE_LIMIT wait_ms=${delay} attempt=${attempt + 1}`);
  await liveSleep(delay);
  return true;
}

/** 逐方法请求数差值，用于区分“初始化成本”和“单次列表成本”。 */
export function requestCountDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [method, count] of Object.entries(after)) {
    const previous = before[method] ?? 0;
    if (count !== previous) delta[method] = count - previous;
  }
  return delta;
}
