import { describe, expect, it } from "vitest";
import {
  canonicalPlanDigestV2,
  describeCanonicalPlanItemFactsDriftV2,
} from "../src/sync/canonical-plan-v2";
import {
  sameCanonicalPlanIdentityV2,
  SyncActionType,
  type CanonicalPlanIdentityV2,
  type SyncPlanItem,
  type SyncScope,
} from "../src/sync/types";

/**
 * 刀 5b（2026-11-02）计划摘要中性化＋升版 2→3 的四条钉子性质：
 * ① 旧形状（v2 位置数组形）摘要字符串 ≠ 新形状（v3 定键对象形）——旧持久化
 *    摘要全门失效关闭的物理基础；
 * ② sameCanonicalPlanIdentityV2 对 version:2 身份恒 false、version:3 且摘要
 *    相等才 true——一次性失效的闸门语义；
 * ③ 同输入两次生成摘要逐字节相同（键插入顺序固定的序列化确定性）；
 * ④ 摘要事实读取对 v2 形状降级 shape-mismatch、对 v3 正常解析（经公开窗口
 *    describeCanonicalPlanItemFactsDriftV2 观察，不抛错）。
 */

const scope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

/** One item carrying every fact slot the digest serializes. */
function guardItem(): SyncPlanItem {
  return {
    type: SyncActionType.Conflict,
    path: "guard/note.md",
    reason: "reason.newFileBothSides",
    local: {
      path: "guard/note.md",
      hash: hashB,
      size: 12,
      mtime: 1,
      binary: false,
    },
    remote: {
      path: "guard/note.md",
      driveId: "guard-drive",
      parentId: "guard-parent",
      size: 12,
      mtime: 1,
      eTag: "etag-guard",
      cTag: "ctag-guard",
      sha256Hash: hashB,
      quickXorHash: "quick-guard",
    },
    folder: {
      remoteId: "guard-folder",
      parentRemoteId: "guard-folder-parent",
      parentPath: "guard",
      remoteETag: "etag-guard-folder",
      parentRemoteETag: "etag-guard-folder-parent",
      sourceParentRemoteId: "guard-source-parent",
    },
    baseEtag: "etag-guard-base",
    renameFrom: "guard/old.md",
    targetParentRemoteId: "guard-target-parent",
    requiresConfirmation: false,
    reviewImpactCount: 3,
    decisionToken: {
      version: 1,
      vaultName: "Vault",
      accountId: scope.accountId,
      scope,
      local: { exists: true, hash: hashB, size: 12 },
      remote: { exists: true, driveId: "guard-drive", eTag: "etag-guard" },
      ancestorHash: hashA,
    },
    contentComparison: {
      version: 1,
      result: "different",
      localHash: hashB,
      localSize: 12,
      remoteDriveId: "guard-drive",
      remoteETag: "etag-guard",
      remoteSize: 12,
      remoteHash: "d".repeat(64),
    },
  };
}

const digestOf = (items: readonly SyncPlanItem[], lastTotalFiles = 4) =>
  canonicalPlanDigestV2({
    items: [...items],
    lastTotalFiles,
    scope,
    sourceCommitSeq: 7,
  });

/**
 * Hand-serialized pre-5b (version 2) digest of the same facts: the exact
 * position-array layout the v2 writer produced, mirrored here so the
 * old-shape sample stays faithful without importing removed code.
 */
function legacyV2Digest(
  items: readonly SyncPlanItem[],
  lastTotalFiles: number,
): string {
  const itemFacts = items.map((item) => {
    const token = item.decisionToken;
    const comparison = item.contentComparison;
    return [
      item.type,
      item.path,
      item.reason ?? null,
      item.local
        ? [item.local.path, item.local.hash, item.local.size, item.local.binary]
        : null,
      item.remote
        ? [
            item.remote.path,
            item.remote.driveId,
            item.remote.parentId,
            item.remote.size,
            item.remote.eTag,
            item.remote.cTag,
            item.remote.sha256Hash ?? null,
            item.remote.quickXorHash ?? null,
          ]
        : null,
      item.folder
        ? [
            item.folder.remoteId ?? null,
            item.folder.parentRemoteId ?? null,
            item.folder.parentPath,
            item.folder.remoteETag ?? null,
            item.folder.parentRemoteETag ?? null,
            item.folder.sourceParentRemoteId ?? null,
          ]
        : null,
      item.baseEtag ?? null,
      item.renameFrom ?? null,
      item.targetParentRemoteId ?? null,
      item.requiresConfirmation ?? false,
      item.reviewImpactCount ?? 1,
      token
        ? [
            token.version,
            token.vaultName,
            token.accountId,
            token.scope.accountId,
            token.scope.driveId,
            token.scope.vaultFolderId,
            token.scope.filesRootId,
            token.local.exists
              ? [true, token.local.hash, token.local.size]
              : [false],
            token.remote.exists
              ? [true, token.remote.driveId, token.remote.eTag]
              : [false],
            token.ancestorHash,
          ]
        : null,
      comparison
        ? [
            comparison.version,
            comparison.result,
            comparison.localHash,
            comparison.localSize,
            comparison.remoteDriveId,
            comparison.remoteETag,
            comparison.remoteSize,
            comparison.remoteHash,
          ]
        : null,
      item.localOnlyCopyKind ?? null,
    ];
  });
  return JSON.stringify({
    version: 2,
    sourceCommitSeq: 7,
    scope: [
      scope.accountId,
      scope.driveId,
      scope.vaultFolderId,
      scope.filesRootId,
    ],
    lastTotalFiles,
    items: itemFacts,
  });
}

describe("canonical plan digest v3 (刀 5b)", () => {
  it("never reproduces a pre-5b v2 digest string from the same facts", () => {
    const items = [guardItem()];
    const v3 = digestOf(items);
    const v2 = legacyV2Digest(items, 4);

    expect(JSON.parse(v3).version).toBe(3);
    expect(JSON.parse(v2).version).toBe(2);
    // Same facts, different shapes: the two serializations can never be
    // byte-equal, which is what invalidates every persisted old digest.
    expect(v3).not.toBe(v2);
  });

  it("fails version-2 identities closed and pairs only equal version-3 digests", () => {
    const digest = digestOf([guardItem()]);
    const identity = (version: 2 | 3): CanonicalPlanIdentityV2 => ({
      version,
      scope,
      sourceCommitSeq: 7,
      digest,
    } as unknown as CanonicalPlanIdentityV2);

    // 一次性失效闸门：旧版本（2）身份任何配对都 false，即使摘要字符串相同。
    expect(sameCanonicalPlanIdentityV2(identity(2), identity(2))).toBe(false);
    expect(sameCanonicalPlanIdentityV2(identity(2), identity(3))).toBe(false);
    expect(sameCanonicalPlanIdentityV2(identity(3), identity(2))).toBe(false);
    // version:3 且摘要相等才配对；摘要不同即失配。
    expect(sameCanonicalPlanIdentityV2(identity(3), identity(3))).toBe(true);
    const otherDigest = digestOf([{ ...guardItem(), path: "guard/other.md" }]);
    expect(sameCanonicalPlanIdentityV2(
      identity(3),
      { ...identity(3), digest: otherDigest },
    )).toBe(false);
    expect(sameCanonicalPlanIdentityV2(null, identity(3))).toBe(false);
    expect(sameCanonicalPlanIdentityV2(null, null)).toBe(true);
  });

  it("is byte-for-byte deterministic for identical input", () => {
    const items = [guardItem(), {
      type: SyncActionType.Upload,
      path: "plain.md",
      local: {
        path: "plain.md",
        hash: hashA,
        size: 10,
        mtime: 1,
        binary: false,
      },
    } as SyncPlanItem];

    expect(digestOf(items)).toBe(digestOf([...items]));
    expect(digestOf(items)).toBe(digestOf(items));
    // Key order is the serialization: a same-content different-order object
    // must never appear, so this pin also guards the fixed insertion order.
    const parsed = JSON.parse(digestOf(items)) as { items: object[] };
    expect(Object.keys(parsed.items[0]!)).toEqual([
      "type",
      "path",
      "reason",
      "local",
      "remote",
      "folder",
      "baseVersionToken",
      "renameFrom",
      "targetParentRemoteId",
      "requiresConfirmation",
      "reviewImpactCount",
      "decisionToken",
      "contentComparison",
      "localOnlyCopyKind",
    ]);
  });

  it("reads v3 digests and degrades v2 shapes to shape-mismatch without throwing", () => {
    const items = [guardItem()];
    const v3 = digestOf(items);
    const v2 = legacyV2Digest(items, 4);

    // 公开窗口：describeCanonicalPlanItemFactsDriftV2 → readCanonicalPlanDigestFactsV2。
    // v2 旧形状降级 shape-mismatch（可用性 false，不抛错）。
    expect(describeCanonicalPlanItemFactsDriftV2({
      previousDigest: v2,
      nextItems: items,
      nextDigest: v3,
    })).toEqual({
      available: false,
      reason: "shape-mismatch",
      items: null,
      lastTotalFiles: null,
      changed: 0,
      added: 0,
      removed: 0,
      samples: [],
      samplesOmitted: 0,
      outsideReviewFields: false,
    });

    // v3 正常解析：同事实重封零漂移。
    expect(describeCanonicalPlanItemFactsDriftV2({
      previousDigest: v3,
      nextItems: items,
      nextDigest: digestOf(items),
    })).toMatchObject({
      available: true,
      reason: null,
      changed: 0,
      added: 0,
      removed: 0,
    });

    // 升版语义的正向验证：中性键名下的事实变化仍被点名。
    const changed = [guardItem()];
    changed[0]!.remote!.eTag = "etag-other";
    const report = describeCanonicalPlanItemFactsDriftV2({
      previousDigest: v3,
      nextItems: changed,
      nextDigest: digestOf(changed),
    });
    expect(report).toMatchObject({ available: true, changed: 1 });
    expect(report.samples[0]?.fields).toEqual(["remote.versionToken"]);
  });
});
