/**
 * 云端凭据的 SecretStorage 边界（C1 数据层；本切片零可见变化）。
 *
 * 只放秘密：WebDAV 密码（以及将来的 S3 秘密）。坐标进 `data.json`，
 * 秘密只进宿主 `SecretStorage`；槽位沿用 `easy-sync-<provider>-*` 既有约定。
 *
 * 与 OneDrive 的关系：两个 OneDrive 槽位不在这里读写，`logout()` 的清理路径
 * 也不经过本模块。
 *
 * 失败语义：缺 SecretStorage 时写入必须大声失败（`CloudSecretStorageUnavailableError`），
 * 不允许「看起来保存成功但没落盘」；读取失败返回 null，由调用层按「未保存」处理。
 */

/** WebDAV 密码槽位；与 OneDrive 的 `easy-sync-onedrive-*` 同族命名。 */
export const SS_WEBDAV_PASSWORD = "easy-sync-webdav-password";

/** 宿主 SecretStorage 的最小接口（与 `app.secretStorage` 同形）。 */
interface CloudSecretStoragePort {
  readonly getSecret: (key: string) => string | null;
  readonly setSecret: (key: string, value: string) => Promise<void> | void;
  readonly deleteSecret?: (key: string) => Promise<void> | void;
}

/** 本设备没有可用的安全存储；写入必须失败而不是静默跳过。 */
export class CloudSecretStorageUnavailableError extends Error {
  constructor() {
    super("SecretStorage is not available on this device");
    this.name = "CloudSecretStorageUnavailableError";
  }
}

interface CloudSecretReader {
  readWebDavPassword(): Promise<string | null>;
}

interface CloudSecretWriter extends CloudSecretReader {
  /** 写入密码；空串视为「不修改」，调用方不得用空串清空凭据。 */
  saveWebDavPassword(password: string): Promise<void>;
  removeWebDavPassword(): Promise<void>;
}

/**
 * 建立凭据读写口。
 *
 * `port` 由 `main.ts` 传入 `app.secretStorage`；为空时所有写入抛
 * `CloudSecretStorageUnavailableError`，读取返回 null（与 OneDrive 包装一致：
 * 缺安全存储时读不到就是没保存，而不是假装有）。
 */
export function createCloudSecrets(
  port: CloudSecretStoragePort | null | undefined,
): CloudSecretWriter {
  const storage = port ?? null;
  return {
    async readWebDavPassword(): Promise<string | null> {
      if (!storage) return null;
      const value = storage.getSecret(SS_WEBDAV_PASSWORD);
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    async saveWebDavPassword(password: string): Promise<void> {
      if (password.length === 0) return;
      if (!storage) throw new CloudSecretStorageUnavailableError();
      await storage.setSecret(SS_WEBDAV_PASSWORD, password);
    },
    async removeWebDavPassword(): Promise<void> {
      if (!storage) return;
      const remove = storage.deleteSecret;
      if (typeof remove === "function") {
        await remove.call(storage, SS_WEBDAV_PASSWORD);
        return;
      }
      // 宿主老版本没有 deleteSecret：写空串是既有兜底（与 OneDrive 退场前的
      // 空串回写同义），读侧把空串当「未保存」。
      await storage.setSecret(SS_WEBDAV_PASSWORD, "");
    },
  };
}
