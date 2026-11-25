import { describe, expect, it } from "vitest";
import {
  normalizeWebDavPath,
  WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP,
  WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE,
  webdavCapabilities,
  WebDavProbeConfigError,
  type WebDavCredentials,
  type WebDavMultiStatusEntry,
  type WebDavProbeConfig,
  type WebDavProbeObservation,
  type WebDavProbeSecurityFacts,
  type WebDavProtocolFacts,
} from "../src/providers/webdav/webdav-probe";
import {
  classifyWebDavResponse,
  type WebDavErrorClassification,
  type WebDavErrorResponseInput,
  type WebDavRetryDirective,
} from "../src/providers/webdav/webdav-errors";
import {
  WebDavClient,
  WebDavPreconditionFailedError,
  WebDavReadbackMismatchError,
  WebDavRootMissingError,
  WebDavRootNotWritableError,
  WebDavTargetExistsError,
  WebDavUnsafeCreateError,
  WebDavUnsafeDeleteError,
  WebDavUnsafeUpdateError,
  WEBDAV_LIST_ENTRY_LIMIT,
  WEBDAV_TEMP_FILE_MAX_AGE_MS,
  WEBDAV_TEMP_FILE_PREFIX,
  WEBDAV_TEMP_DIRECTORY,
  type WebDavClientCredentials,
  type WebDavClientOptions,
  type WebDavListResult,
  type WebDavResourceStat,
  type WebDavTemporaryCleanupFailure,
  type WebDavTemporaryCleanupResult,
  type WebDavWriteResult,
} from "../src/providers/webdav/webdav-client";
import {
  WEBDAV_SCOPE_UNSAFE_WRITE_STATUS,
  WebDavClientScopeIo,
  type WebDavClientScopeIoOptions,
} from "../src/providers/webdav/webdav-scope-io";
import {
  bindIdentity,
  confirmRebuild,
  idForPath,
  IdentityLedgerConflictError,
  IdentityLedgerIdentityConflictError,
  IdentityLedgerReadbackError,
  IdentityLedgerRebuildNotAllowedError,
  IdentityLedgerTooLargeError,
  IdentityLedgerUnknownIdentityError,
  IdentityLedgerUnsafeWriteError,
  IdentityLedgerValidationError,
  identityLedgerPolicy,
  loadIdentityLedger,
  markVerified,
  moveIdentity,
  parseIdentityLedger,
  pathForId,
  rebuildIdentityLedger,
  removeIdentity,
  saveIdentityLedger,
  serializeIdentityLedger,
  validateLedger,
  webDavIdentityLedgerPath,
  WEBDAV_IDENTITY_LEDGER_PATH,
  WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION,
  WEBDAV_IDENTITY_MAX_LEDGER_BYTES,
  WEBDAV_IDENTITY_MAX_PATH_LENGTH,
  type WebDavIdentityLedgerLoadResult,
  type WebDavIdentityLedgerPolicy,
  type WebDavIdentityLedgerRebuildResult,
  type WebDavIdentityLedgerSaveResult,
  type WebDavIdentityLedgerState,
  type WebDavIdentityLedgerV1,
  type WebDavIdentityLedgerValidation,
  type WebDavIdentityLedgerValidationIssue,
  type WebDavIdentityLedgerWriteExpectation,
} from "../src/providers/webdav/webdav-identity-ledger";
import type { WebDavScopeRemoteIo } from "../src/providers/webdav/webdav-scope";
import {
  WEBDAV_CLOUD_BOOTSTRAP_V2_PATH,
  WebDavCapabilityMissingError,
  WebDavDownloadHashMismatchError,
  WebDavListingIncompleteError,
  WebDavProvider,
  WebDavProviderNotInitializedError,
  WebDavUploadTooLargeError,
  type WebDavProviderOptions,
} from "../src/providers/webdav/webdav-provider";
import {
  MAX_SHARED_PROTOCOL_BYTES,
  WEBDAV_SHARED_PROTOCOL_V2_PATH,
  WEBDAV_SHARED_PROTOCOL_V3_PATH,
  WebDavSharedProtocolConflictError,
  WebDavSharedProtocolError,
  WebDavSharedProtocolEtagError,
  WebDavSharedProtocolListingIncompleteError,
  WebDavSharedProtocolSlotError,
  WebDavSharedProtocolStore,
  WebDavSharedProtocolTooLargeError,
  type WebDavSharedProtocolSlot,
  type WebDavSharedSyncProtocolControlObject,
  type WebDavSharedSyncProtocolObjectsObservation,
} from "../src/providers/webdav/webdav-protocol";
import {
  bootstrapWebDavSync,
  WebDavSyncBootstrapRefusedError,
  type WebDavSyncBootstrapOptions,
  type WebDavSyncBootstrapResult,
} from "../src/providers/webdav/webdav-sync-bootstrap";
import type { SyncProvider } from "../src/sync/sync-provider";

/**
 * W1 导出面合同：把 W2–W4（扫描、上传、设置与诊断）会使用的公共类型、
 * 常量与 fail-closed 能力基线固定在一个可编译的清单里。
 *
 * 这同时满足仓库的 export-surface 门（src 导出必须在其它代码文件出现），
 * 避免以后误删后续切片需要的类型；与 S1 的导出面合同测试同构。
 */
type WebDavTypeSurface = {
  WebDavCredentials: WebDavCredentials;
  WebDavMultiStatusEntry: WebDavMultiStatusEntry;
  WebDavProbeConfig: WebDavProbeConfig;
  WebDavProbeObservation: WebDavProbeObservation;
  WebDavProbeSecurityFacts: WebDavProbeSecurityFacts;
  WebDavProtocolFacts: WebDavProtocolFacts;
  WebDavErrorClassification: WebDavErrorClassification;
  WebDavErrorResponseInput: WebDavErrorResponseInput;
  WebDavRetryDirective: WebDavRetryDirective;
  WebDavClientCredentials: WebDavClientCredentials;
  WebDavClientOptions: WebDavClientOptions;
  WebDavListResult: WebDavListResult;
  WebDavResourceStat: WebDavResourceStat;
  WebDavTemporaryCleanupFailure: WebDavTemporaryCleanupFailure;
  WebDavTemporaryCleanupResult: WebDavTemporaryCleanupResult;
  WebDavWriteResult: WebDavWriteResult;
  WebDavScopeRemoteIo: WebDavScopeRemoteIo;
  WebDavClientScopeIoOptions: WebDavClientScopeIoOptions;
  WebDavIdentityLedgerState: WebDavIdentityLedgerState;
  WebDavIdentityLedgerPolicy: WebDavIdentityLedgerPolicy;
  WebDavIdentityLedgerV1: WebDavIdentityLedgerV1;
  WebDavIdentityLedgerLoadResult: WebDavIdentityLedgerLoadResult;
  WebDavIdentityLedgerWriteExpectation: WebDavIdentityLedgerWriteExpectation;
  WebDavIdentityLedgerSaveResult: WebDavIdentityLedgerSaveResult;
  WebDavIdentityLedgerRebuildResult: WebDavIdentityLedgerRebuildResult;
  WebDavIdentityLedgerValidation: WebDavIdentityLedgerValidation;
  WebDavIdentityLedgerValidationIssue: WebDavIdentityLedgerValidationIssue;
  WebDavProviderOptions: WebDavProviderOptions;
  WebDavSyncBootstrapOptions: WebDavSyncBootstrapOptions;
  WebDavSyncBootstrapResult: WebDavSyncBootstrapResult;
  WebDavSharedProtocolSlot: WebDavSharedProtocolSlot;
  WebDavSharedSyncProtocolControlObject: WebDavSharedSyncProtocolControlObject;
  WebDavSharedSyncProtocolObjectsObservation: WebDavSharedSyncProtocolObjectsObservation;
};

describe("WebDAV W1 导出面", () => {
  it("规范化路径：统一分隔符、去掉空段与前导／尾随斜杠", () => {
    expect(normalizeWebDavPath("/root//a b/")).toBe("/root/a b");
    expect(normalizeWebDavPath("\\root\\a\\")).toBe("/root/a");
    expect(normalizeWebDavPath("")).toBe("/");
    expect(() => normalizeWebDavPath("/a/../b")).toThrow(WebDavProbeConfigError);
  });

  it("单次 PUT 阈值按平台分档，fail-closed 能力基线", () => {
    expect(WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP).toBe(100 * 1024 * 1024);
    expect(WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE).toBe(32 * 1024 * 1024);

    const capabilities = webdavCapabilities();
    expect(capabilities.maxSinglePutBytes).toBe(WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP);
    expect(webdavCapabilities("mobile").maxSinglePutBytes)
      .toBe(WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE);
    expect(capabilities.folderEntity).toBe(true);
    for (const bit of [
      "stableIdentity",
      "conditionalCreate",
      "conditionalUpdate",
      "conditionalDelete",
      "serverSideMove",
      "deltaCursor",
      "contentChecksum",
      "contentVersionToken",
      "versionHistory",
      "recycleBin",
      "rangeDownload",
      "resumableUpload",
    ] as const) {
      expect(capabilities[bit], `${bit} must stay false until the probe proves it`).toBe(false);
    }
  });

  it("类型清单可编译", () => {
    const typeSurface: WebDavTypeSurface | null = null;
    expect(typeSurface).toBeNull();
  });

  it("安全客户端与错误分类导出可用", () => {
    expect(WebDavClient).toBeTypeOf("function");
    expect(WebDavClientScopeIo).toBeTypeOf("function");
    expect(WEBDAV_LIST_ENTRY_LIMIT).toBe(750);
    expect(WEBDAV_TEMP_DIRECTORY).toBe(".easy-sync/tmp");
    expect(WEBDAV_TEMP_FILE_PREFIX).toBe("create-");
    expect(WEBDAV_TEMP_FILE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(WEBDAV_SCOPE_UNSAFE_WRITE_STATUS).toBe(428);
    expect(classifyWebDavResponse({ status: 412 }).type).toBe("PreconditionFailed");
    for (const errorClass of [
      WebDavPreconditionFailedError,
      WebDavReadbackMismatchError,
      WebDavRootMissingError,
      WebDavRootNotWritableError,
      WebDavTargetExistsError,
      WebDavUnsafeCreateError,
      WebDavUnsafeDeleteError,
      WebDavUnsafeUpdateError,
      IdentityLedgerConflictError,
      IdentityLedgerIdentityConflictError,
      IdentityLedgerReadbackError,
      IdentityLedgerRebuildNotAllowedError,
      IdentityLedgerTooLargeError,
      IdentityLedgerUnknownIdentityError,
      IdentityLedgerUnsafeWriteError,
      IdentityLedgerValidationError,
    ]) {
      expect(errorClass).toBeTypeOf("function");
    }
  });

  it("W1.6 身份账本导出可用", () => {
    expect(WEBDAV_IDENTITY_LEDGER_PATH).toBe(".easy-sync/identity.json");
    expect(webDavIdentityLedgerPath("/Notes")).toBe(
      "/Notes/.easy-sync/identity.json",
    );
    expect(WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION).toBe(1);
    expect(WEBDAV_IDENTITY_MAX_PATH_LENGTH).toBe(1024);
    expect(WEBDAV_IDENTITY_MAX_LEDGER_BYTES).toBe(8 * 1024 * 1024);
    for (const fn of [
      bindIdentity,
      confirmRebuild,
      idForPath,
      identityLedgerPolicy,
      loadIdentityLedger,
      markVerified,
      moveIdentity,
      parseIdentityLedger,
      pathForId,
      rebuildIdentityLedger,
      removeIdentity,
      saveIdentityLedger,
      serializeIdentityLedger,
      validateLedger,
    ]) {
      expect(fn).toBeTypeOf("function");
    }
    expect(identityLedgerPolicy("unverified").autoDeleteAllowed).toBe(false);
  });

  it("W2b1 启动引导导出可用", () => {
    expect(bootstrapWebDavSync).toBeTypeOf("function");
    expect(WebDavSyncBootstrapRefusedError).toBeTypeOf("function");
    const options: WebDavSyncBootstrapOptions | null = null;
    const result: WebDavSyncBootstrapResult | null = null;
    expect(options).toBeNull();
    expect(result).toBeNull();
  });

  it("W2a provider 合同面导出可用", () => {
    expect(WEBDAV_CLOUD_BOOTSTRAP_V2_PATH).toBe(
      ".easy-sync/cloud-bootstrap-v2.json",
    );
    for (const errorClass of [
      WebDavProviderNotInitializedError,
      WebDavListingIncompleteError,
      WebDavUploadTooLargeError,
      WebDavDownloadHashMismatchError,
      WebDavCapabilityMissingError,
    ]) {
      expect(errorClass).toBeTypeOf("function");
    }
    const providerConstructor: new (
      options: WebDavProviderOptions,
    ) => SyncProvider = WebDavProvider;
    expect(providerConstructor).toBe(WebDavProvider);
    expect(WebDavProvider).toBeTypeOf("function");
  });

  it("W2b2b1 共享协议控制对象导出可用", () => {
    expect(MAX_SHARED_PROTOCOL_BYTES).toBe(1024 * 1024);
    expect(WEBDAV_SHARED_PROTOCOL_V2_PATH).toBe(
      ".easy-sync/protocol-v2.json",
    );
    expect(WEBDAV_SHARED_PROTOCOL_V3_PATH).toBe(
      ".easy-sync/protocol-v3.json",
    );
    expect(WebDavSharedProtocolStore).toBeTypeOf("function");
    for (const errorClass of [
      WebDavSharedProtocolConflictError,
      WebDavSharedProtocolError,
      WebDavSharedProtocolEtagError,
      WebDavSharedProtocolListingIncompleteError,
      WebDavSharedProtocolSlotError,
      WebDavSharedProtocolTooLargeError,
    ]) {
      expect(errorClass).toBeTypeOf("function");
    }
    for (const method of [
      WebDavProvider.prototype.readSharedSyncProtocolObjects,
      WebDavProvider.prototype.readSharedSyncProtocolV2ById,
      WebDavProvider.prototype.createSharedSyncProtocolV2,
      WebDavProvider.prototype.overwriteSharedSyncProtocolV2,
      WebDavProvider.prototype.readSharedSyncProtocolV3ById,
      WebDavProvider.prototype.createSharedSyncProtocolV3,
    ]) {
      expect(method).toBeTypeOf("function");
    }
  });
});
