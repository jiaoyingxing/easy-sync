/**
 * WebDAV 同步启动引导（W2b1）。
 *
 * 把 S0 的 scope 标记、W1.6 的身份账本与 W2a 的 provider 串成一次可测试的
 * 启动顺序；不接 `SyncExecutor`／`src/main.ts`／设置 UI，也不访问真实账号。
 *
 * 顺序（设计 §13.3）：
 * 1. `WebDavClient.initialize()`：根集合存在、根可写、能力探针；
 * 2. 构造 S0 scope 字段／scopeId／根标记；
 * 3. `ensureWebDavScopeMarker`：只有 `initialize`／`accept`／`takeover` 且
 *    `mayWrite=true` 才继续；确认态与拒绝一律 fail-closed；
 * 4. 构造 provider（driveId＝scope `endpointId`）；
 * 5. `loadIdentityLedger`：只有 `verified` 打开自动删除／改名；`missing`／
 *    `corrupt` 走全量扫描＋重建，结果 `unverified`；`read-only`／
 *    `unavailable` 保留原状态、不重建。`verified` 还要求调用方显式传
 *    `ledgerTrust="trusted"`；默认 `unverified` 会把暴露状态降为
 *    `unverified`（只影响本地视图，不改远端字节），避免第二次启动把未
 *    确认的重建自动当已确认；
 * 6. 返回 client／provider／scope／标记／账本／能力／协议事实。
 *
 * 失败语义：标记拒绝、根不可写、损坏账本且无强 ETag 无法安全重建时，抛明确
 * 错误，不返回可同步状态。重建只写账本，不删除任何远端用户文件。
 */
import type { ProviderCapabilities } from "../../sync/provider-capabilities";
import type { SyncScope } from "../../sync/types";
import { WebDavClient } from "./webdav-client";
import {
  identityLedgerPolicy,
  loadIdentityLedger,
  rebuildIdentityLedger,
  type WebDavIdentityLedgerLoadResult,
  type WebDavIdentityLedgerPolicy,
  type WebDavIdentityLedgerRebuildResult,
} from "./webdav-identity-ledger";
import { WebDavProvider } from "./webdav-provider";
import type { WebDavProtocolFacts, WebDavTransport } from "./webdav-probe";
import {
  buildWebDavScopeFields,
  buildWebDavScopeId,
  buildWebDavScopeMarker,
  ensureWebDavScopeMarker,
  webDavScopeFieldsToSyncScope,
  type WebDavScopeFields,
  type WebDavScopeInitResult,
} from "./webdav-scope";
import { WebDavClientScopeIo } from "./webdav-scope-io";

/** 解析信任时交给调用方的上下文：已认证的远端账本事实。 */
interface WebDavLedgerTrustContext {
  /** 五字段 scope 折叠出的 scopeId；本机锚点按它区分云端根。 */
  readonly scopeId: string;
  readonly loaded: WebDavIdentityLedgerLoadResult;
}

/**
 * 本地对远端账本的信任来源。
 *
 * - `"trusted"`／`"unverified"`：静态结论（测试与不持久化锚点的调用方）；
 * - 函数：按 scopeId 与已读到的账本内容现场判断（W2b-2 的本机锚点）。
 *
 * 默认 `"unverified"`：即使远端账本格式有效且带强 ETag，也只在返回值里暴露
 * `unverified` 与 policy 全 false。
 */
type WebDavLedgerTrustOption =
  | "trusted"
  | "unverified"
  | ((
    context: WebDavLedgerTrustContext,
  ) => "trusted" | "unverified" | Promise<"trusted" | "unverified">);

export interface WebDavSyncBootstrapOptions {
  readonly endpoint: string;
  readonly rootPath?: string;
  readonly credentials: { username: string; password: string };
  readonly transport: WebDavTransport;
  readonly vaultName: string;
  readonly localStatePresent: boolean;
  readonly confirmTakeover?: boolean;
  readonly confirmExistingContent?: boolean;
  readonly now?: () => Date;
  readonly requestDeadlineMs?: number;
  /** 本地对远端账本的信任来源；见 `WebDavLedgerTrustOption`。 */
  readonly ledgerTrust?: WebDavLedgerTrustOption;
}

export interface WebDavSyncBootstrapResult {
  readonly client: WebDavClient;
  readonly provider: WebDavProvider;
  readonly scope: SyncScope;
  readonly scopeFields: WebDavScopeFields;
  /** 五字段折叠出的 scopeId；本机信任锚点与诊断按它归属。 */
  readonly scopeId: string;
  readonly scopeMarker: WebDavScopeInitResult;
  readonly ledger: WebDavIdentityLedgerLoadResult | WebDavIdentityLedgerRebuildResult;
  readonly identityPolicy: WebDavIdentityLedgerPolicy;
  /**
   * 本次引导是否重建了账本（远端原本缺失／损坏）。重建会把 uuid 全部换新，
   * 调用方据此落一条「重建未确认」标记（W2b-2）：在用户看到一次成功同步之前，
   * 跨设备身份推断与自动删除保持关闭。
   */
  readonly ledgerRebuilt: boolean;
  readonly capabilities: ProviderCapabilities;
  readonly protocolFacts: WebDavProtocolFacts;
}

/**
 * 启动引导拒绝继续。`marker` 是已经做出的 scope 标记判定（根不可写等更早
 * 失败时为 null）；`reason` 给出可供诊断的具体原因。
 */
export class WebDavSyncBootstrapRefusedError extends Error {
  constructor(
    readonly reason: string,
    readonly marker: WebDavScopeInitResult | null = null,
    readonly detail: string | null = null,
  ) {
    super(
      detail === null
        ? `WebDAV sync bootstrap refused: ${reason}`
        : `WebDAV sync bootstrap refused: ${reason} (${detail})`,
    );
    this.name = "WebDavSyncBootstrapRefusedError";
  }
}

/** 标记判定是否允许继续构造同步状态。 */
function mayContinue(marker: WebDavScopeInitResult): boolean {
  return (
    (marker.action === "initialize"
      || marker.action === "accept"
      || marker.action === "takeover")
    && marker.mayWrite
  );
}

/**
 * 全量扫描后的身份路径。`fullScan` 返回根集合的子项，`DriveItem.id` 就是
 * 规范化 vault 相对路径；根哨兵不进入账本。
 */
function identityPathsOf(items: readonly { readonly id: string }[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.id.length === 0 || item.id === "/") continue;
    paths.push(item.id);
  }
  return paths;
}

/**
 * 一次 WebDAV 启动引导。调用方负责在成功结果上继续 W2b2 的引擎接线；
 * 本函数不执行任何用户文件写入，也不删除远端内容。
 */
export async function bootstrapWebDavSync(
  options: WebDavSyncBootstrapOptions,
): Promise<WebDavSyncBootstrapResult> {
  const now = options.now ?? (() => new Date());
  const client = new WebDavClient({
    endpoint: options.endpoint,
    rootPath: options.rootPath,
    credentials: options.credentials,
    transport: options.transport,
    requestDeadlineMs: options.requestDeadlineMs,
    now,
  });
  await client.initialize();
  const capabilities = client.capabilities;
  const protocolFacts = client.protocol;
  if (capabilities === null || protocolFacts === null) {
    throw new WebDavSyncBootstrapRefusedError(
      "client initialization completed without capabilities/protocol facts",
    );
  }

  const scopeFields = await buildWebDavScopeFields({
    endpoint: options.endpoint,
    rootPath: client.rootPath,
    username: options.credentials.username,
  });
  const scopeId = await buildWebDavScopeId(scopeFields);
  const marker = buildWebDavScopeMarker({
    vaultName: options.vaultName,
    scopeId,
    createdAt: now(),
  });
  const scopeMarker = await ensureWebDavScopeMarker({
    io: new WebDavClientScopeIo(client),
    rootPath: client.rootPath,
    marker,
    localStatePresent: options.localStatePresent,
    confirmTakeover: options.confirmTakeover,
    confirmExistingContent: options.confirmExistingContent,
  });
  if (!mayContinue(scopeMarker)) {
    throw new WebDavSyncBootstrapRefusedError(
      `scope marker ${scopeMarker.action}: ${scopeMarker.reason}`,
      scopeMarker,
    );
  }

  const provider = new WebDavProvider({
    client,
    driveId: scopeFields.endpointId,
    now,
  });

  const loaded = await loadIdentityLedger(client);
  let ledger: WebDavIdentityLedgerLoadResult | WebDavIdentityLedgerRebuildResult;
  let identityPolicy: WebDavIdentityLedgerPolicy;
  /** 本次引导是否重建了账本（uuid 全部换新，W2b-2 要落一条待确认标记）。 */
  let ledgerRebuilt = false;
  if (loaded.state === "missing" || loaded.state === "corrupt") {
    const items = await provider.fullScan(options.vaultName);
    try {
      ledger = await rebuildIdentityLedger(
        client,
        identityPathsOf(items),
        { now: now() },
      );
      identityPolicy = ledger.policy;
      ledgerRebuilt = true;
    } catch (error) {
      throw new WebDavSyncBootstrapRefusedError(
        "identity ledger cannot be rebuilt safely",
        scopeMarker,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (loaded.state === "verified") {
    // 远端账本本身是 verified 事实，但本地是否已确认由调用方决定。默认
    // fail-closed：只降本地暴露状态，不改远端字节，也不把账本改成 unverified。
    // 调用方可以传静态 `"trusted"`，也可以传一个按 scopeId 现场判断的函数
    // （W2b-2：该 scope 是否有未确认的重建）。
    const trust = typeof options.ledgerTrust === "function"
      ? await options.ledgerTrust({ scopeId, loaded })
      : options.ledgerTrust ?? "unverified";
    if (trust === "trusted") {
      ledger = loaded;
      identityPolicy = loaded.policy;
    } else {
      ledger = {
        ...loaded,
        state: "unverified",
        issue: "awaiting-local-confirmation",
        policy: identityLedgerPolicy("unverified"),
      };
      identityPolicy = ledger.policy;
    }
  } else {
    // `read-only`／`unavailable` 保留原状态，不静默当成 verified，也不触发重建。
    ledger = loaded;
    identityPolicy = loaded.policy;
  }

  return {
    client,
    provider,
    scope: webDavScopeFieldsToSyncScope(scopeFields),
    scopeFields,
    scopeId,
    scopeMarker,
    ledger,
    identityPolicy,
    ledgerRebuilt,
    capabilities,
    protocolFacts,
  };
}
