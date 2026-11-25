import { UPLOAD_SESSION_THRESHOLD_BYTES } from "./upload-session-policy";
import type { ProviderCapabilities } from "../sync/provider-capabilities";

/** OneDrive（Microsoft Graph，App Folder）能力声明。只读、冻结、单点事实源：
 *  字段语义见 `ProviderCapabilities`；`maxSinglePutBytes` 引用上传会话策略
 *  常量，策略阈值变化时合同测试会同步红，强制一次显式决策。 */
export const ONEDRIVE_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  stableIdentity: true,
  conditionalCreate: true,
  conditionalUpdate: true,
  conditionalDelete: true,
  serverSideMove: true,
  deltaCursor: true,
  folderEntity: true,
  contentChecksum: true,
  contentVersionToken: true,
  versionHistory: true,
  recycleBin: true,
  rangeDownload: true,
  resumableUpload: true,
  maxSinglePutBytes: UPLOAD_SESSION_THRESHOLD_BYTES,
});
