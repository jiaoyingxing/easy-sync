import { describe, expect, it } from "vitest";
import {
  buildS3ScopeFields,
  buildS3ScopeId,
  buildS3ScopeMarker,
  decideS3ScopeMarker,
  normalizeS3Endpoint,
  parseS3ScopeMarker,
  requiresExistingContentConfirmation,
  s3ControlDirectoryKey,
  s3ScopeMarkerKey,
  serializeS3ScopeMarker,
} from "../src/providers/s3/s3-scope";

/**
 * S3 scope 身份与根占用标记合同。重点：endpoint／region／bucket／root／
 * access key id 任一变化都得到不同身份；scope.json 不含凭据；标记冲突按
 * 「同 scope 同库接受、不同库拒绝、同库换 scope 需显式接管」判定。
 */
const BASE = {
  endpoint: "https://S3.Example.com:443",
  region: "US-East-1",
  bucket: "my-bucket",
  rootPath: "/Root/Docs/",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
} as const;

describe("endpoint 规范化", () => {
  it("小写 host、去默认端口、保留非默认端口", () => {
    expect(normalizeS3Endpoint("https://S3.Example.com:443").origin).toBe("https://s3.example.com");
    expect(normalizeS3Endpoint("http://127.0.0.1:9000").origin).toBe("http://127.0.0.1:9000");
    expect(normalizeS3Endpoint("https://example.com:8443").origin).toBe("https://example.com:8443");
  });

  it("拒绝凭据、路径、查询、非 http(s)", () => {
    expect(() => normalizeS3Endpoint("https://user:pass@example.com")).toThrow();
    expect(() => normalizeS3Endpoint("https://example.com/base")).toThrow();
    expect(() => normalizeS3Endpoint("https://example.com/?a=1")).toThrow();
    expect(() => normalizeS3Endpoint("ftp://example.com")).toThrow();
    expect(() => normalizeS3Endpoint("not a url")).toThrow();
  });
});

describe("scope 字段", () => {
  it("endpointId = origin|region；credentialBindingId 为 32 位十六进制", async () => {
    const fields = await buildS3ScopeFields(BASE);
    expect(fields.providerKind).toBe("s3");
    expect(fields.endpointId).toBe("https://s3.example.com|us-east-1");
    expect(fields.containerId).toBe("my-bucket");
    expect(fields.rootPath).toBe("Root/Docs");
    expect(fields.credentialBindingId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("同一输入稳定；换 access key id／region／bucket／root 都改变身份", async () => {
    const first = await buildS3ScopeFields(BASE);
    const second = await buildS3ScopeFields(BASE);
    expect(second.credentialBindingId).toBe(first.credentialBindingId);
    expect(await buildS3ScopeId(second)).toBe(await buildS3ScopeId(first));

    const rotated = await buildS3ScopeFields({ ...BASE, accessKeyId: "AKIAOTHER" });
    expect(rotated.credentialBindingId).not.toBe(first.credentialBindingId);

    const otherRegion = await buildS3ScopeFields({ ...BASE, region: "eu-west-1" });
    expect(otherRegion.endpointId).not.toBe(first.endpointId);

    const otherBucket = await buildS3ScopeFields({ ...BASE, bucket: "other-bucket" });
    expect(await buildS3ScopeId(otherBucket)).not.toBe(await buildS3ScopeId(first));

    const otherRoot = await buildS3ScopeFields({ ...BASE, rootPath: "Other" });
    expect(await buildS3ScopeId(otherRoot)).not.toBe(await buildS3ScopeId(first));
  });

  it("secret 不进入 scope 字段（凭据轮换只换 secret 时 scope 不变）", async () => {
    const fields = await buildS3ScopeFields(BASE);
    expect(Object.keys(fields).sort()).toEqual([
      "containerId",
      "credentialBindingId",
      "endpointId",
      "providerKind",
      "rootPath",
    ]);
    expect(JSON.stringify(fields)).not.toContain("secret");
    expect(JSON.stringify(fields)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("scope.json 标记", () => {
  it("序列化 round-trip，且不含凭据", async () => {
    const fields = await buildS3ScopeFields(BASE);
    const scopeId = await buildS3ScopeId(fields);
    const marker = buildS3ScopeMarker({
      vaultName: "MyVault",
      scopeId,
      createdAt: new Date("2026-11-17T00:00:00.000Z"),
    });
    const raw = serializeS3ScopeMarker(marker);
    expect(raw).not.toContain("AKIA");
    expect(raw).not.toContain("secret");
    expect(parseS3ScopeMarker(raw)).toEqual(marker);
    expect(s3ScopeMarkerKey("Root/Docs")).toBe("Root/Docs/.easy-sync/scope.json");
    expect(s3ControlDirectoryKey("Root/Docs")).toBe("Root/Docs/.easy-sync/");
  });

  it("拒绝坏 JSON、错误 schema／providerKind、缺失字段与坏日期", () => {
    expect(() => parseS3ScopeMarker("{")).toThrow();
    expect(() =>
      parseS3ScopeMarker(
        JSON.stringify({ schemaVersion: 2, providerKind: "s3", vaultName: "v", scopeId: "s", createdAt: "" }),
      ),
    ).toThrow();
    expect(() =>
      parseS3ScopeMarker(
        JSON.stringify({ schemaVersion: 1, providerKind: "webdav", vaultName: "v", scopeId: "s", createdAt: "" }),
      ),
    ).toThrow();
    expect(() => parseS3ScopeMarker(JSON.stringify({ schemaVersion: 1, providerKind: "s3" }))).toThrow();
    expect(() =>
      parseS3ScopeMarker(
        JSON.stringify({
          schemaVersion: 1,
          providerKind: "s3",
          vaultName: "v",
          scopeId: "s",
          createdAt: "not-a-date",
        }),
      ),
    ).toThrow();
  });
});

describe("标记冲突判定", () => {
  const existing = {
    schemaVersion: 1 as const,
    providerKind: "s3" as const,
    vaultName: "MyVault",
    scopeId: "aaaabbbbccccdddd",
    createdAt: "2026-11-17T00:00:00.000Z",
  };

  it("无标记 → 初始化；同 scope 同库 → 接受", () => {
    expect(decideS3ScopeMarker(null, { scopeId: existing.scopeId, vaultName: "MyVault", localStatePresent: true }).action).toBe(
      "initialize",
    );
    expect(
      decideS3ScopeMarker(existing, { scopeId: existing.scopeId, vaultName: "MyVault", localStatePresent: true }).action,
    ).toBe("accept");
  });

  it("同 scope 但不同库 → 拒绝", () => {
    expect(
      decideS3ScopeMarker(existing, { scopeId: existing.scopeId, vaultName: "OtherVault", localStatePresent: true }).action,
    ).toBe("refuse");
  });

  it("同库但 scope 不同 → 需要显式接管", () => {
    const decision = decideS3ScopeMarker(existing, {
      scopeId: "eeeeffff00001111",
      vaultName: "MyVault",
      localStatePresent: false,
    });
    expect(decision.action).toBe("takeover-required");
    expect(decision.reason).toContain("local state is missing");
  });

  it("两者都不同 → 拒绝", () => {
    expect(
      decideS3ScopeMarker(existing, {
        scopeId: "eeeeffff00001111",
        vaultName: "OtherVault",
        localStatePresent: true,
      }).action,
    ).toBe("refuse");
  });

  it("前缀非空且已有内容 → 需要确认", () => {
    expect(requiresExistingContentConfirmation(0)).toBe(false);
    expect(requiresExistingContentConfirmation(3)).toBe(true);
  });
});
