import { describe, expect, it } from "vitest";
import type { SyncProviderKind } from "../src/sync/types";
import {
  S3_CREDENTIAL_BINDING_PREFIX,
  S3_SCOPE_SCHEMA_VERSION,
  buildS3ScopeFields,
  buildS3ScopeId,
  buildS3ScopeMarker,
  ensureS3ScopeMarker,
  readS3ScopeMarker,
  requiresExistingContentConfirmation,
  s3ScopeFieldsToSyncScope,
  type S3LocalScopeIdentity,
  type S3ScopeFields,
  type S3ScopeInitAction,
  type S3ScopeInitInput,
  type S3ScopeInitResult,
  type S3ScopeMarkerDecision,
  type S3ScopeMarkerIo,
  type S3ScopeMarkerV1,
} from "../src/providers/s3/s3-scope";
import {
  WEBDAV_CONTROL_DIRECTORY,
  WEBDAV_CREDENTIAL_BINDING_PREFIX,
  WEBDAV_SCOPE_FALLBACK_FILE,
  WEBDAV_SCOPE_MARKER_FILE,
  WEBDAV_SCOPE_SCHEMA_VERSION,
  WebDavScopeConfigError,
  WebDavScopeProtocolError,
  buildWebDavScopeFields,
  buildWebDavScopeId,
  buildWebDavScopeMarker,
  decideWebDavScopeMarker,
  ensureWebDavScopeMarker,
  isWebDavControlPlanePath,
  normalizeWebDavRootPath,
  parseWebDavScopeMarker,
  readWebDavScopeMarker,
  requiresExistingWebDavContentConfirmation,
  resolveWebDavScopeEndpoint,
  serializeWebDavScopeMarker,
  webDavControlDirectoryPath,
  webDavScopeFallbackMarkerPath,
  webDavScopeFieldsToSyncScope,
  webDavScopeMarkerPath,
  type BuildWebDavScopeMarkerInput,
  type ResolvedWebDavScopeEndpoint,
  type WebDavLocalScopeIdentity,
  type WebDavScopeFields,
  type WebDavScopeInitAction,
  type WebDavScopeInitInput,
  type WebDavScopeInitResult,
  type WebDavScopeInput,
  type WebDavScopeListingEntry,
  type WebDavScopeMarkerAction,
  type WebDavScopeMarkerDecision,
  type WebDavScopeMarkerLocation,
  type WebDavScopeMarkerStyle,
  type WebDavScopeMarkerV1,
  type WebDavScopeRemoteIo,
  type WebDavScopeStatResult,
} from "../src/providers/webdav/webdav-scope";

/**
 * S0 导出面合同：把设计 §2.1／§6 新增的公共类型、常量与 helper 固定在一个
 * 可编译清单里。它只回答“这些导出在定义文件之外仍被需要”，不重复 S0 的
 * 行为用例；S0 行为断言见 `sync-scope-provider-fields`、`s3-scope-init`、
 * `webdav-scope-init`、`state-envelope-v2`。
 */
type S0TypeSurface = {
  BuildWebDavScopeMarkerInput: BuildWebDavScopeMarkerInput;
  ResolvedWebDavScopeEndpoint: ResolvedWebDavScopeEndpoint;
  S3LocalScopeIdentity: S3LocalScopeIdentity;
  S3ScopeFields: S3ScopeFields;
  S3ScopeInitAction: S3ScopeInitAction;
  S3ScopeInitInput: S3ScopeInitInput;
  S3ScopeInitResult: S3ScopeInitResult;
  S3ScopeMarkerDecision: S3ScopeMarkerDecision;
  S3ScopeMarkerIo: S3ScopeMarkerIo;
  S3ScopeMarkerV1: S3ScopeMarkerV1;
  SyncProviderKind: SyncProviderKind;
  WebDavLocalScopeIdentity: WebDavLocalScopeIdentity;
  WebDavScopeFields: WebDavScopeFields;
  WebDavScopeInitAction: WebDavScopeInitAction;
  WebDavScopeInitInput: WebDavScopeInitInput;
  WebDavScopeInitResult: WebDavScopeInitResult;
  WebDavScopeInput: WebDavScopeInput;
  WebDavScopeListingEntry: WebDavScopeListingEntry;
  WebDavScopeMarkerAction: WebDavScopeMarkerAction;
  WebDavScopeMarkerDecision: WebDavScopeMarkerDecision;
  WebDavScopeMarkerLocation: WebDavScopeMarkerLocation;
  WebDavScopeMarkerStyle: WebDavScopeMarkerStyle;
  WebDavScopeMarkerV1: WebDavScopeMarkerV1;
  WebDavScopeRemoteIo: WebDavScopeRemoteIo;
  WebDavScopeStatResult: WebDavScopeStatResult;
};

const CREATED_AT = new Date("2026-11-18T00:00:00.000Z");

describe("S0 导出面", () => {
  it("常量与纯函数的取值契约", async () => {
    expect(S3_SCOPE_SCHEMA_VERSION).toBe(1);
    expect(S3_CREDENTIAL_BINDING_PREFIX).toBe("easysync/scope/v1|s3|");
    expect(requiresExistingContentConfirmation(0)).toBe(false);
    expect(requiresExistingContentConfirmation(1)).toBe(true);

    expect(WEBDAV_SCOPE_SCHEMA_VERSION).toBe(1);
    expect(WEBDAV_CREDENTIAL_BINDING_PREFIX).toBe("easysync/scope/v1|webdav|");
    expect(WEBDAV_CONTROL_DIRECTORY).toBe(".easy-sync");
    expect(WEBDAV_SCOPE_MARKER_FILE).toBe("scope.json");
    expect(WEBDAV_SCOPE_FALLBACK_FILE).toBe(".easy-sync-scope.json");
    expect(requiresExistingWebDavContentConfirmation(0)).toBe(false);
    expect(requiresExistingWebDavContentConfirmation(1)).toBe(true);

    expect(normalizeWebDavRootPath("/Notes/")).toBe("/Notes");
    const resolved = resolveWebDavScopeEndpoint(
      "https://dav.example.com/Notes",
      "/Notes",
    );
    expect(resolved).toEqual({
      origin: "https://dav.example.com",
      rootPath: "/Notes",
    });

    const fields = await buildWebDavScopeFields({
      endpoint: "https://dav.example.com/Notes",
      username: "alice",
    });
    expect(fields.providerKind).toBe("webdav");
    expect(fields.rootPath).toBe("/Notes");
    const scopeId = await buildWebDavScopeId(fields);
    expect(scopeId).toMatch(/^[0-9a-f]{32}$/);
    const marker = buildWebDavScopeMarker({
      vaultName: "Vault",
      scopeId,
      createdAt: CREATED_AT,
    });
    expect(parseWebDavScopeMarker(serializeWebDavScopeMarker(marker))).toEqual(marker);
    expect(webDavScopeFieldsToSyncScope(fields).driveId).toBe(fields.endpointId);

    expect(webDavControlDirectoryPath("/Notes")).toBe("/Notes/.easy-sync");
    expect(webDavScopeMarkerPath("/Notes")).toBe("/Notes/.easy-sync/scope.json");
    expect(webDavScopeFallbackMarkerPath("/Notes")).toBe("/Notes/.easy-sync-scope.json");
    expect(isWebDavControlPlanePath("/Notes", "/Notes/.easy-sync/scope.json")).toBe(true);

    const decision = decideWebDavScopeMarker(null, {
      scopeId,
      vaultName: "Vault",
      localStatePresent: false,
    });
    expect(decision.action).toBe("initialize");

    expect(new WebDavScopeConfigError("s0 surface")).toBeInstanceOf(Error);
    expect(new WebDavScopeProtocolError("s0 surface")).toBeInstanceOf(Error);
  });

  it("S3 helper 的最小可调用面", async () => {
    const fields = await buildS3ScopeFields({
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "bucket",
      rootPath: "notes",
      accessKeyId: "AKIAEXAMPLE",
    });
    const scopeId = await buildS3ScopeId(fields);
    const marker = buildS3ScopeMarker({
      vaultName: "Vault",
      scopeId,
      createdAt: CREATED_AT,
    });
    const io: S3ScopeMarkerIo = {
      head: async () => ({ exists: false }),
      readText: async () => null,
      writeCreateOnly: async () => true,
      writeReplace: async () => undefined,
      list: async () => ({ objects: [], isTruncated: false }),
    };

    expect(await readS3ScopeMarker(io, "notes")).toBeNull();
    const result = await ensureS3ScopeMarker({
      io,
      rootPath: "notes",
      marker,
      localStatePresent: false,
    });
    expect(result.action).toBe("initialize");
    expect(s3ScopeFieldsToSyncScope(fields).rootPath).toBe("notes");
  });

  it("WebDAV helper 的最小可调用面", async () => {
    const marker = buildWebDavScopeMarker({
      vaultName: "Vault",
      scopeId: "a".repeat(32),
      createdAt: CREATED_AT,
    });
    const io: WebDavScopeRemoteIo = {
      stat: async () => ({ status: 404, isCollection: false }),
      mkcol: async () => 201,
      putText: async () => 201,
      getText: async () => ({ status: 404, text: "" }),
      list: async () => ({ status: 207, entries: [] }),
    };

    expect(await readWebDavScopeMarker(io, "/Notes")).toBeNull();
    const result = await ensureWebDavScopeMarker({
      io,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
    });
    expect(result.action).toBe("initialize");
  });

  it("类型清单可编译", () => {
    const typeSurface: S0TypeSurface | null = null;
    expect(typeSurface).toBeNull();
  });
});
