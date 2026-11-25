/**
 * WebDAV 同步运行时（W2b-1）。
 *
 * 把 W2b1 的启动引导、W2a 的 provider 与 C1 的云端设置串成「一次可以真正
 * 参与同步的连接」。本模块只做装配与生命周期，不做计划、不写用户文件。
 *
 * 生命周期：
 * 1. `connect()`：用当前设置跑一次启动引导（根存在／根可写／能力探针 →
 *    scope 标记 → provider → 身份账本），成功时缓存 provider 与 scope；
 * 2. 缓存的 provider 交给执行器（`SyncExecutor.setProvider`），scope 作为
 *    `providerScope` 供首同步写入五字段；
 * 3. `disconnect()`：切换云端或改配置时丢弃缓存，下次 `connect()` 重新引导。
 *
 * 失败语义（全部 fail-closed，不猜）：
 * - 标记需要「接管」或远端已有内容需要确认：抛 `WebDavRuntimeNeedsConfirmationError`，
 *   由调用方提示用户；本切片不提供自助接管界面。
 * - 根不可写、账本无法安全重建、能力不足：抛 `WebDavRuntimeError`，不返回可同步状态。
 * - 密码缺失：抛 `WebDavRuntimeError`，提示先去配置。
 */
import {
  bootstrapWebDavSync,
  WebDavSyncBootstrapRefusedError,
  type WebDavSyncBootstrapResult,
} from "../providers/webdav/webdav-sync-bootstrap";
import type { WebDavTransport } from "../providers/webdav/webdav-probe";
import type { SyncScope } from "../sync/types";
import { RemoteError, RemoteErrorType } from "../remote/errors";
import type { WebDavCloudCoordinatesV1 } from "./cloud-settings";
import { resolveRootPath } from "./cloud-connection-test";
import {
  createWebDavLedgerRebuildMarker,
  isWebDavLedgerRebuildPending,
  mayTrustWebDavLedger,
  type WebDavLedgerRebuildMarkerV1,
} from "./webdav-ledger-trust";

/** 需要用户显式确认才能继续（接管已有同步根，或确认远端已有内容）。 */
export class WebDavRuntimeNeedsConfirmationError extends Error {
  constructor(
    readonly kind: "takeover" | "existing-content",
    readonly detail: string,
  ) {
    super(`WebDAV sync needs confirmation: ${kind} (${detail})`);
    this.name = "WebDavRuntimeNeedsConfirmationError";
  }
}

/** 其余不可继续的原因；`reason` 是稳定短码，供界面选一句现役文案。 */
export class WebDavRuntimeError extends Error {
  constructor(
    readonly reason:
      | "not-configured"
      | "no-password"
      | "root-unwritable"
      | "ledger-unrebuildable"
      | "capability-missing"
      | "rate-limited"
      | "unknown",
    detail: string,
  ) {
    super(`WebDAV sync unavailable: ${reason} (${detail})`);
    this.name = "WebDavRuntimeError";
  }
}

interface WebDavRuntimeOptions {
  readonly coordinates: WebDavCloudCoordinatesV1 | null;
  readonly readPassword: () => Promise<string | null>;
  readonly transport: WebDavTransport;
  readonly vaultName: string;
  readonly localStatePresent: () => boolean;
  readonly now?: () => Date;
  /**
   * 本机信任锚点（W2b-2）。缺省＝没有锚点端口：一律按未确认处理
   * （跨设备改名识别不打开）。接线方由 `main.ts` 从 `StateManager` 供端口。
   */
  readonly ledgerTrust?: WebDavRuntimeLedgerTrustPort;
}

/**
 * 本机「重建未确认」标记的读写端口。
 *
 * `read` 返回当前持久化标记；`write` 在启动引导真的重建了账本时记录；
 * `clear` 在一轮真的成功同步后清除。端口是异步的：持久化走宿主 plugin data。
 */
interface WebDavRuntimeLedgerTrustPort {
  read(): Promise<WebDavLedgerRebuildMarkerV1 | null>;
  write(marker: WebDavLedgerRebuildMarkerV1): Promise<void>;
  clear(): Promise<void>;
}

/** 一次成功引导的结果里，执行器真正需要的部分。 */
interface WebDavRuntimeConnection {
  readonly provider: WebDavSyncBootstrapResult["provider"];
  readonly scope: SyncScope;
  /** 远端账本状态；`unverified` 时自动删除／改名保持关闭。 */
  readonly identityState: string;
  /** 五字段 scope 折叠出的 scopeId；待确认标记按它归属云端根。 */
  readonly scopeId: string;
  /** 本机是否可用这份账本做身份推断（决定跨设备改名与自动删除）。 */
  readonly ledgerTrusted: boolean;
  /** 远端根集合地址（`host/path`），供诊断与提示用。 */
  readonly rootLabel: string;
}

interface WebDavRuntime {
  /**
   * 取当前连接；未连接或已失效时重新引导。
   *
   * 同一份设置下重复调用复用缓存（不重复跑探测）；`invalidate()` 之后重新引导。
   */
  connect(): Promise<WebDavRuntimeConnection>;
  /**
   * 一轮同步成功后调用：清掉「重建未确认」标记并打开身份推断。
   *
   * 只有当前 scope 上有待确认标记时才有效；返回是否发生了变化。
   */
  confirmAfterSuccessfulRound(): Promise<boolean>;
  /** 丢弃缓存，下次 connect 重新引导（改配置、切换云端、登出时调用）。 */
  invalidate(): void;
  /** 已缓存的连接（没有则 null），不触发引导。 */
  peek(): WebDavRuntimeConnection | null;
}

export function createWebDavRuntime(options: WebDavRuntimeOptions): WebDavRuntime {
  let cached: WebDavRuntimeConnection | null = null;
  let pending: Promise<WebDavRuntimeConnection> | null = null;

  /**
   * 这份 scope 上的账本此刻能不能用于身份推断。
   *
   * 三个条件：远端账本 `verified`（强 ETag＋条件写）、没有「重建未确认」标记、
   * 账本内容可读。没有端口（未接线／测试）时按没有标记处理——标记本身是加严
   * 记录，缺它不会放开新的写权限，远端 verified 仍是硬前提。
   */
  const resolveTrust = async (context: {
    readonly scopeId: string;
    readonly loaded: WebDavSyncBootstrapResult["ledger"];
  }): Promise<boolean> => {
    const port = options.ledgerTrust;
    let marker: WebDavLedgerRebuildMarkerV1 | null = null;
    if (port) {
      try {
        marker = await port.read();
      } catch {
        // 标记读不出来：无法证明「已确认」，按待确认处理。
        return false;
      }
    }
    return mayTrustWebDavLedger({
      marker,
      facts: {
        state: context.loaded.state,
        canUpdate: context.loaded.canUpdate === true,
        ledger: context.loaded.ledger,
      },
      scopeId: context.scopeId,
    });
  };

  const build = async (): Promise<WebDavRuntimeConnection> => {
    const coordinates = options.coordinates;
    if (!coordinates) {
      throw new WebDavRuntimeError("not-configured", "no WebDAV coordinates");
    }
    const password = await options.readPassword();
    if (password === null || password.length === 0) {
      throw new WebDavRuntimeError("no-password", "WebDAV password is not saved");
    }
    let bootstrapped: WebDavSyncBootstrapResult;
    let ledgerTrusted = false;
    try {
      bootstrapped = await bootstrapWebDavSync({
        endpoint: coordinates.url,
        rootPath: resolveRootPath(coordinates),
        credentials: { username: coordinates.username, password },
        transport: options.transport,
        vaultName: options.vaultName,
        localStatePresent: options.localStatePresent(),
        // W2b-2：信任不再是一条静态开关。引导阶段按「该 scope 是否有未确认的
        // 重建」判定；有标记即 unverified（自动删除与跨设备改名保持关闭）。
        ledgerTrust: async (context) =>
          (await resolveTrust(context)) ? "trusted" : "unverified",
        ...(options.now ? { now: options.now } : {}),
      });
      ledgerTrusted = bootstrapped.identityPolicy.autoDeleteAllowed;
    } catch (error) {
      throw toRuntimeError(error);
    }
    // 记账：本次引导真的重建了账本（uuid 全换）时，落一条待确认标记。这是
    // 「本机没见过一次成功同步」的唯一证据来源，必须先于任何同步轮。
    if (bootstrapped.ledgerRebuilt && options.ledgerTrust) {
      try {
        const entries = bootstrapped.ledger.ledger?.entries;
        if (entries) {
          await options.ledgerTrust.write(
            await createWebDavLedgerRebuildMarker({
              scopeId: bootstrapped.scopeId,
              entries,
              eTag: bootstrapped.ledger.eTag,
              now: (options.now?.() ?? new Date()).getTime(),
            }),
          );
        }
        ledgerTrusted = false;
      } catch {
        // 标记写不进去：无法证明「已确认」，本轮同样按未确认处理。
        ledgerTrusted = false;
      }
    }
    // 把本机确认结论交给 provider：它才是「跨设备改名识别」这一能力的读取口。
    if (typeof bootstrapped.provider.setIdentityLedgerTrust === "function") {
      bootstrapped.provider.setIdentityLedgerTrust(ledgerTrusted);
    }
    const connection: WebDavRuntimeConnection = {
      provider: bootstrapped.provider,
      scope: bootstrapped.scope,
      identityState: bootstrapped.ledger.state,
      scopeId: bootstrapped.scopeId,
      ledgerTrusted,
      rootLabel: coordinates.url,
    };
    return connection;
  };

  return {
    async connect() {
      if (cached) return cached;
      pending ??= build()
        .then((connection) => {
          cached = connection;
          return connection;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },

    async confirmAfterSuccessfulRound() {
      const port = options.ledgerTrust;
      const connection = cached;
      if (!port || !connection) return false;
      let marker: WebDavLedgerRebuildMarkerV1 | null;
      try {
        marker = await port.read();
      } catch {
        return false;
      }
      if (!isWebDavLedgerRebuildPending({
        marker,
        scopeId: connection.scopeId,
      })) return false;
      try {
        await port.clear();
      } catch {
        // 清除失败只意味着下一轮仍然按未确认跑，不能让已成功的同步变成失败。
        return false;
      }
      const updated: WebDavRuntimeConnection = {
        ...connection,
        ledgerTrusted: true,
      };
      // 远端账本本身是否 verified 决定身份状态展示；标记清除不影响它。
      if (updated.identityState === "unverified") {
        // 重建后的账本内容本身是合法的；标的一直是「等一次成功同步」。
        cached = { ...updated, identityState: "verified" };
      } else {
        cached = updated;
      }
      if (typeof connection.provider.setIdentityLedgerTrust === "function") {
        connection.provider.setIdentityLedgerTrust(true);
      }
      return true;
    },

    invalidate() {
      cached = null;
      pending = null;
    },
    peek() {
      return cached;
    },
  };
}

/**
 * 把引导层的错误折成本模块的稳定原因码。
 *
 * 判据优先看标记判定的 `action`（结构化事实），不靠 reason 文案匹配：
 * 文案会随口径调整，`action` 是 S0 合同的一部分。
 */
function toRuntimeError(error: unknown): Error {
  if (
    error instanceof RemoteError
    && error.type === RemoteErrorType.RateLimited
  ) {
    return new WebDavRuntimeError("rate-limited", error.message);
  }
  if (error instanceof WebDavSyncBootstrapRefusedError) {
    const action = error.marker?.action ?? null;
    if (action === "takeover-required") {
      return new WebDavRuntimeNeedsConfirmationError("takeover", error.message);
    }
    if (action === "existing-content-confirm") {
      return new WebDavRuntimeNeedsConfirmationError(
        "existing-content",
        error.message,
      );
    }
    if (action === "refuse") {
      return new WebDavRuntimeError("root-unwritable", error.message);
    }
    // 标记之后的失败（账本不可重建、能力不足等）沿用 bootstrap 的 reason。
    if (error.reason.includes("identity ledger")) {
      return new WebDavRuntimeError("ledger-unrebuildable", error.message);
    }
    return new WebDavRuntimeError("unknown", error.message);
  }
  return error instanceof Error
    ? new WebDavRuntimeError("unknown", error.message)
    : new WebDavRuntimeError("unknown", String(error));
}
