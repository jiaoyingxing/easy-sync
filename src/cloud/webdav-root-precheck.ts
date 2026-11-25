/**
 * 保存 WebDAV 配置时的根目录只读预检（F4/S3）。
 *
 * 目的只有一个：**把「切过去点同步才发现」提前到「配置时就知道」**。
 *
 * 既有的三档判定（`decideWebDavScopeMarker`）本来就在，但只在同步引导时
 * 触发；这里把它前移一次，且**只读**——不写标记、不建目录、不改任何远端
 * 状态。真正的安全闸仍在同步引导里，这里只是让用户在保存那一刻就看见。
 *
 * 三档（用户 2026-11-23 拍板 Q2A：不做 B 档「接管已有内容」）：
 * - **自己以前用过**（标记在、身份与库名都对上）→ 静默放行；
 * - **全新但非空**，或「同一个库名但换了地址／账号」→ 当场拒绝，提示换一个
 *   空文件夹（同一句话：它确实已经有内容）。**不提供「纳入对账」的同意
 *   通路**——那等于允许覆盖别人的文件夹内容。
 * - **被别的笔记库占用** → 当场拒绝，说明原因。
 *
 * 失败语义：预检本身出错（网络／服务器不支持 Depth 1／列表被截断）**不阻断
 * 保存**。保存即测试，连接测试已经证明过一次可达；预检是加固，不是新的
 * 门槛，把它变成门槛只会在弱服务器上卡死正常用户。截断的列表按「可能有
 * 内容」处理（fail-closed 方向与既有 750 项口径一致）。
 */
import type { WebDavTransport } from "../providers/webdav/webdav-probe";
import { WebDavClient } from "../providers/webdav/webdav-client";
import { WebDavClientScopeIo } from "../providers/webdav/webdav-scope-io";
import {
  buildWebDavScopeFields,
  buildWebDavScopeId,
  decideWebDavScopeMarker,
  readWebDavScopeMarker,
} from "../providers/webdav/webdav-scope";
import { resolveRootPath } from "./cloud-connection-test";
import type { WebDavCloudCoordinatesV1 } from "./cloud-settings";

/** 预检结论。`allow` 之外的两种都要在保存处拦下并说明。 */
type WebDavRootPrecheckVerdict =
  /** 放行：自己的根、空根，或没有标记且本来就是空的。 */
  | { readonly action: "allow"; readonly kind: "own" | "empty" }
  /** 拦下：它已经有内容（全新非空 / 同库名换了地址账号）。 */
  | {
    readonly action: "refuse";
    readonly kind: "existing-content";
    readonly entryCount: number;
  }
  /** 拦下：这块远端属于另一个笔记库。 */
  | { readonly action: "refuse"; readonly kind: "other-vault" };

interface WebDavRootPrecheckInput {
  readonly coordinates: WebDavCloudCoordinatesV1;
  readonly password: string;
  /** 本库名：与远端标记里的 `vaultName` 比对，判断「是不是自己以前用过」。 */
  readonly vaultName: string;
  readonly transport: WebDavTransport;
}

/**
 * 跑一次只读预检。
 *
 * 不抛错：任何执行失败都退回 `null`（＝预检没结论，照常保存）。调用方把
 * `null` 与 `allow` 一样处理——但两者在诊断日志里要分开记，否则「预检被
 * 跳过」会静默消失。
 */
export async function precheckWebDavRoot(
  input: WebDavRootPrecheckInput,
): Promise<WebDavRootPrecheckVerdict | null> {
  try {
    const rootPath = resolveRootPath(input.coordinates);
    const fields = await buildWebDavScopeFields({
      // endpoint 只给 origin：`resolveWebDavScopeEndpoint` 拒绝「endpoint 自带
      // 路径又同时给 rootPath」的组合，那是它的安全规则。
      endpoint: new URL(input.coordinates.url).origin,
      rootPath,
      username: input.coordinates.username,
    });
    const scopeId = await buildWebDavScopeId(fields);
    const client = new WebDavClient({
      endpoint: input.coordinates.url,
      rootPath,
      credentials: {
        username: input.coordinates.username,
        password: input.password,
      },
      transport: input.transport,
    });
    const io = new WebDavClientScopeIo(client);

    // ① 标记在不在、是谁的。这是「自己以前用过」与「被别的库占用」的分水岭。
    const existing = await readWebDavScopeMarker(io, rootPath);
    const decision = decideWebDavScopeMarker(existing?.marker ?? null, {
      scopeId,
      vaultName: input.vaultName,
      localStatePresent: true,
    });
    if (decision.action === "accept") {
      return { action: "allow", kind: "own" };
    }
    if (decision.action === "refuse") {
      return { action: "refuse", kind: "other-vault" };
    }
    // `takeover-required`（同一个库名、换了地址或账号）与「全新非空」归为
    // 同一档：文件夹里确实已经有内容，而本轮不做「接管已有内容」的同意通路。
    if (decision.action === "takeover-required") {
      return { action: "refuse", kind: "existing-content", entryCount: 0 };
    }

    // ② 没有标记：看根里有没有内容（控制面与集合自身不算）。
    const listing = await io.list(rootPath);
    if (listing.status !== 207) return null;
    const controlPlane = `${rootPath === "/" ? "" : rootPath}/.easy-sync`;
    const entryCount = listing.entries.filter((entry) => {
      if (entry.path === rootPath) return false;
      return !(entry.path === controlPlane
        || entry.path.startsWith(`${controlPlane}/`));
    }).length;
    // 列表被截断时只能证明「有这些」，不能证明「没有别的」——按可能有内容
    // 处理（与既有 750 项 fail-closed 同向）。
    if (listing.complete === false || entryCount > 0) {
      return { action: "refuse", kind: "existing-content", entryCount };
    }
    return { action: "allow", kind: "empty" };
  } catch {
    // 预检是加固而不是门槛：读不到结论就照常保存，由同步引导的既有安全闸兜底。
    return null;
  }
}
