/**
 * WebDAV 连接控制器（C3）：把「坐标 + 凭据 + 连接测试」串成一次可提交的动作。
 *
 * 分工：
 * - `cloud-settings.ts` 管形状与校验；`cloud-secrets.ts` 管密码；
 *   `cloud-connection-test.ts` 管真实测试；本模块只负责顺序与失败边界。
 * - 写入顺序固定为「先坐标（`data.json`）→ 再凭据（SecretStorage）→ 再测试」；
 *   任一步失败都保留前一步的结果并把原因原样返回，绝不让界面显示「已保存」
 *   而实际没落盘。
 * - 凭据轮换先把 `credentialRevision` 加一（旧测试结论立即失效），再写密码；
 *   这样崩溃恢复后最坏是「未测试」，不会带着旧结论继续用新密码。
 *
 * 本模块不碰 DOM、不碰 `main.ts`：所有副作用经端口注入，便于单测与后续接线。
 */
import {
  bumpCredentialRevision,
  markWebDavTested,
  resolveWebDavConnectionStatus,
  validateWebDavCoordinates,
  type WebDavCloudConnectionV1,
} from "./cloud-settings";
import { CloudSecretStorageUnavailableError } from "./cloud-secrets";
import { testWebDavConnection } from "./cloud-connection-test";
import type { WebDavTransport } from "../providers/webdav/webdav-probe";

/** 状态词的对外别名（界面层按此选行说明与角标）。 */
export type CloudConnectionStatus = ReturnType<typeof resolveWebDavConnectionStatus>;

/** 提交入参：界面传进来的原始值。 */
export interface CloudDraft {
  readonly url: string;
  readonly username: string;
  readonly rootPrefix: string;
  /** 空串＝保留已保存的密码。 */
  readonly password: string;
}

/** 提交结果；`ok` 为真时连接记录已落盘且测试通过。 */
type CloudSubmitResult =
  | { readonly ok: true; readonly connection: WebDavCloudConnectionV1 }
  | { readonly ok: false; readonly reason: CloudSubmitFailure };

export type CloudSubmitFailure =
  | "urlInvalid"
  | "usernameInvalid"
  | "rootPrefixInvalid"
  | "passwordRequired"
  | "secretUnavailable"
  | "saveFailed"
  | "testFailed";

interface CloudConnectionPorts {
  /** 读取当前连接记录（没有则 null）。 */
  readonly readConnection: () => WebDavCloudConnectionV1 | null;
  /** 写入连接记录（坐标 + 测试结果）；失败抛错。 */
  readonly writeConnection: (connection: WebDavCloudConnectionV1 | null) => Promise<void>;
  readonly readPassword: () => Promise<string | null>;
  readonly writePassword: (password: string) => Promise<void>;
  readonly transport: WebDavTransport;
  readonly now: () => number;
}

interface CloudConnectionController {
  /** 当前连接记录（原始形状，可能为 null）。 */
  getConnection(): WebDavCloudConnectionV1 | null;
  /** 当前状态；密码是否在位由调用方传入（`hasPassword`）。 */
  getStatus(hasPassword: boolean): CloudConnectionStatus;
  /** 保存 + 测试。成功后返回新记录；失败返回原因，不写半状态。 */
  submit(draft: CloudDraft): Promise<CloudSubmitResult>;
}

export function createCloudConnectionController(
  ports: CloudConnectionPorts,
): CloudConnectionController {
  return {
    getConnection: () => ports.readConnection(),

    getStatus: (hasPassword) =>
      resolveWebDavConnectionStatus(ports.readConnection(), hasPassword),

    async submit(draft) {
      const validated = validateWebDavCoordinates({
        url: draft.url,
        username: draft.username,
        rootPrefix: draft.rootPrefix,
      });
      if (validated.error) return { ok: false, reason: validated.error };
      const coordinates = validated.value!;

      // 密码：留空＝沿用；首次配置留空＝拒绝（不猜）。
      const typedPassword = draft.password.length > 0 ? draft.password : null;
      const existingPassword = typedPassword === null
        ? await ports.readPassword()
        : null;
      const password = typedPassword ?? existingPassword;
      if (password === null || password.length === 0) {
        return { ok: false, reason: "passwordRequired" };
      }

      const previous = ports.readConnection();
      const base: WebDavCloudConnectionV1 = previous
        ? {
          ...previous,
          coordinates,
          // 坐标或密码变化都让旧测试结论失效：换密码走 bump，换坐标清 null。
          lastTest: null,
        }
        : { coordinates, credentialRevision: 0, lastTest: null };
      const next = typedPassword !== null ? bumpCredentialRevision(base) : base;

      // 先写坐标：写盘失败就什么都不做，界面保持「未保存」。
      try {
        await ports.writeConnection(next);
      } catch {
        return { ok: false, reason: "saveFailed" };
      }

      // 再写密码：缺安全存储时大声失败，并把刚写的坐标回滚成上一版，
      // 避免「坐标在、密码没在」的半状态被当成可连接。
      if (typedPassword !== null) {
        try {
          await ports.writePassword(typedPassword);
        } catch (error) {
          await ports.writeConnection(previous).catch(() => undefined);
          return {
            ok: false,
            reason: error instanceof CloudSecretStorageUnavailableError
              ? "secretUnavailable"
              : "saveFailed",
          };
        }
      }

      // 最后测试：失败也落盘（`ok:false` + 原因），冷启动能如实显示。
      const result = await testWebDavConnection({
        coordinates,
        password,
        transport: ports.transport,
        now: () => new Date(ports.now()),
      });
      const tested = markWebDavTested(next, {
        ok: result.ok,
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
        testedAt: ports.now(),
      });
      try {
        await ports.writeConnection(tested);
      } catch {
        return { ok: false, reason: "saveFailed" };
      }
      if (!result.ok) return { ok: false, reason: "testFailed" };
      return { ok: true, connection: tested };
    },
  };
}
