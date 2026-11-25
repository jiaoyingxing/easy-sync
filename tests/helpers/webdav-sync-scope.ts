/**
 * W2b2a 测试台的 WebDAV scope 夹具。
 *
 * 引擎与 provider 的根身份必须一致：provider 的根 ID 是 `"/"`，条目 ID 是
 * vault 相对路径；`rootPath` 只保存绝对根集合（如 `/vault`）。因此
 * `vaultFolderId`／`filesRootId` 都是 `"/"`，不是 `rootPath`。
 *
 * `legacyWebDavScopeFieldsToSyncScope` 故意保留 W2b2a 之前的映射
 * （`vaultFolderId=filesRootId=rootPath`），只用于回归差异断言：它必须与
 * 修正后的 scope 在四元上不同，证明测试真的钉住了修复而不是同义反复。
 */
import type { SyncScope } from "../../src/sync/types";
import {
  buildWebDavScopeFields,
  type WebDavScopeFields,
} from "../../src/providers/webdav/webdav-scope";

export interface WebDavScopedFixture {
  readonly fields: WebDavScopeFields;
  readonly scope: SyncScope;
}

export async function buildWebDavSyncScope(input: {
  readonly endpoint: string;
  readonly username: string;
}): Promise<WebDavScopedFixture> {
  const fields = await buildWebDavScopeFields(input);
  return { fields, scope: webDavSyncScopeFromFields(fields) };
}

/** 生产映射的测试镜像（W2b2a 修正后的口径）。 */
export function webDavSyncScopeFromFields(fields: WebDavScopeFields): SyncScope {
  return {
    accountId: fields.credentialBindingId,
    driveId: fields.endpointId,
    vaultFolderId: "/",
    filesRootId: "/",
    providerKind: fields.providerKind,
    endpointId: fields.endpointId,
    containerId: fields.containerId,
    rootPath: fields.rootPath,
    credentialBindingId: fields.credentialBindingId,
  };
}

/** W2b2a 之前的错误映射；仅用于「修复确实改变四元」的负向对照。 */
export function legacyWebDavScopeFieldsToSyncScope(
  fields: WebDavScopeFields,
): SyncScope {
  return {
    accountId: fields.credentialBindingId,
    driveId: fields.endpointId,
    vaultFolderId: fields.rootPath,
    filesRootId: fields.rootPath,
    providerKind: fields.providerKind,
    endpointId: fields.endpointId,
    containerId: fields.containerId,
    rootPath: fields.rootPath,
    credentialBindingId: fields.credentialBindingId,
  };
}
