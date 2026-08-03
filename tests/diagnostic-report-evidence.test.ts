import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildConflictEvidence,
  findLatestAutomaticHandlingSummary,
  findLatestNetworkSummary,
  findLatestPhaseSummary,
  findLatestTransferSummary,
  fingerprintOpaqueValue,
  formatDiagnosticAutomaticSyncSummary,
  formatV2StorageAuthorityEvidence,
  projectSyncHistoryActionCounts,
  summarizeCommunityPluginSync,
  summarizeMutationRecovery,
} from "../src/sync/diagnostic-report-evidence";
import { SyncActionType, type MutationLedgerEntryV1 } from "../src/sync/types";

describe("diagnostic report evidence", () => {
  it("formats the active V2 storage owner without exposing a database ID", async () => {
    expect(formatV2StorageAuthorityEvidence({
      kind: "json",
      stateCommitSeq: 3,
      lifecycleEpoch: 1,
    })).toBe("json（commit 3 / epoch 1）");

    const rawDatabaseId = "0123456789abcdef0123456789abcdef";
    const databaseFingerprint = await fingerprintOpaqueValue(rawDatabaseId);
    const rendered = formatV2StorageAuthorityEvidence({
      kind: "indexeddb",
      databaseFingerprint,
      stateCommitSeq: 4,
      lifecycleEpoch: 1,
    });
    expect(rendered).toBe(
      `indexeddb（database fingerprint ${databaseFingerprint} / commit 4 / epoch 1）`,
    );
    expect(rendered).not.toContain(rawDatabaseId);
  });

  it("does not claim local-change triggering is active when automatic sync is off", () => {
    expect(formatDiagnosticAutomaticSyncSummary({
      intervalMinutes: 0,
      paused: false,
      changeDelaySeconds: 7,
      dirtyPending: false,
      activity: "空闲",
    })).toEqual([
      "**自动同步**: 已关闭",
      "**修改后触发同步**: 未启用（自动同步已关闭）",
    ]);

    expect(formatDiagnosticAutomaticSyncSummary({
      intervalMinutes: 3,
      paused: false,
      changeDelaySeconds: 7,
      dirtyPending: true,
      activity: "同步中",
    })).toEqual([
      "**自动同步**: 运行中（每 3 分钟）",
      "**修改后触发同步**: 本地变化后等待 7 秒（已有待处理变化）/ 当前状态：同步中",
    ]);
  });

  it("projects every file and folder action count for the diagnostic history table", () => {
    expect(projectSyncHistoryActionCounts({
      uploaded: 1,
      downloaded: 2,
      filesMoved: 3,
      foldersCreated: 4,
      foldersMoved: 5,
      foldersDeleted: 6,
      deleted: 7,
    })).toEqual({
      uploaded: 1,
      downloaded: 2,
      filesMoved: 3,
      foldersCreated: 4,
      foldersMoved: 5,
      foldersDeleted: 6,
      filesDeleted: 7,
    });
  });

  it("reports why a pending conflict can or cannot be proven equal without I/O", () => {
    const evidence = buildConflictEvidence({
      type: SyncActionType.Conflict,
      path: "note.md",
      local: { path: "note.md", hash: "aa".repeat(32), size: 4, mtime: 1, binary: false },
      remote: { path: "note.md", driveId: "id", eTag: "etag", cTag: "", size: 4, mtime: 2 },
    });
    expect(evidence).toMatchObject({
      equalityStatus: "unknown",
      equalityProof: "insufficientEvidence",
      localHash: "aaaaaaaaaaaa",
      localQuickXor: "—",
      remoteSha256: "—",
      remoteQuickXor: "—",
      hasDecisionToken: false,
    });
  });

  it("reports QuickXor mismatch evidence from the shared resolver", () => {
    const evidence = buildConflictEvidence({
      type: SyncActionType.Conflict,
      path: "note.md",
      local: {
        path: "note.md",
        hash: "aa".repeat(32),
        quickXorHash: "LocalQuickXor",
        size: 4,
        mtime: 1,
        binary: false,
      },
      remote: {
        path: "note.md",
        driveId: "id",
        eTag: "etag",
        cTag: "ctag",
        quickXorHash: "RemoteQuickXor",
        size: 4,
        mtime: 2,
      },
    });

    expect(evidence).toMatchObject({
      equalityStatus: "different",
      equalityProof: "quickXorMismatch",
      localQuickXor: "LocalQuickXo",
      remoteQuickXor: "RemoteQuickX",
    });
  });

  it("selects the latest structured sync phase summary", () => {
    const latest = findLatestPhaseSummary([
      { ts: 1, cat: "lifecycle", lvl: "log", msg: "sync run phase summary", data: { run: 1 } },
      { ts: 2, cat: "execute", lvl: "warn", msg: "other" },
      { ts: 3, cat: "lifecycle", lvl: "log", msg: "sync run phase summary", data: { run: 2 } },
    ]);
    expect(latest?.data).toEqual({ run: 2 });
  });

  it("selects the latest structured OneDrive network summary", () => {
    const latest = findLatestNetworkSummary([
      { ts: 1, cat: "onedrive", lvl: "log", msg: "sync network summary", data: { run: 1 } },
      { ts: 2, cat: "onedrive", lvl: "log", msg: "downloadFile finished" },
      { ts: 3, cat: "onedrive", lvl: "log", msg: "sync network summary", data: { run: 2 } },
    ]);
    expect(latest?.data).toEqual({ run: 2 });
  });

  it("selects the latest structured file transfer summary", () => {
    const latest = findLatestTransferSummary([
      { ts: 1, cat: "execute", lvl: "log", msg: "sync file transfer summary", data: { run: 1 } },
      { ts: 2, cat: "execute", lvl: "warn", msg: "other" },
      { ts: 3, cat: "execute", lvl: "log", msg: "sync file transfer summary", data: { run: 2 } },
    ]);
    expect(latest?.data).toEqual({ run: 2 });
  });

  it("selects the latest automatic handling summary", () => {
    const latest = findLatestAutomaticHandlingSummary([
      { ts: 1, cat: "execute", lvl: "log", msg: "sync automatic handling summary", data: { run: 1 } },
      { ts: 2, cat: "execute", lvl: "warn", msg: "other" },
      { ts: 3, cat: "execute", lvl: "log", msg: "sync automatic handling summary", data: { run: 2 } },
    ]);
    expect(latest?.data).toEqual({ run: 2 });
  });

  it("summarizes recovery records without exposing paths or remote identities", () => {
    const makeEntry = (
      action: MutationLedgerEntryV1["intent"]["action"],
      receipt: MutationLedgerEntryV1["receipt"],
    ): MutationLedgerEntryV1 => ({
      intent: {
        version: 1,
        operationId: `operation-${action}`,
        planRevision: 1,
        scope: {
          accountId: "account-secret",
          driveId: "drive-secret",
          vaultFolderId: "vault-secret",
          filesRootId: "files-secret",
        },
        action,
        path: "private/path.md",
        expectedLocal: { exists: false },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt,
    });
    const summary = summarizeMutationRecovery([
      makeEntry("merge", null),
      makeEntry("deleteLocal", {
        version: 1,
        operationId: "operation-deleteLocal",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      }),
    ]);

    expect(summary).toMatchObject({
      total: 2,
      intentOnly: 1,
      receiptPendingCommit: 1,
      byAction: { merge: 1, deleteLocal: 1 },
    });
    expect(JSON.stringify(summary)).not.toContain("private/path.md");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("fingerprints opaque scope identifiers without exposing the raw value", async () => {
    const fingerprint = await fingerprintOpaqueValue("account-secret");
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).not.toContain("account-secret");
  });

  it("summarizes selective plugin scope without exposing plugin ids or data", async () => {
    const summary = await summarizeCommunityPluginSync({
      policy: {
        version: 1,
        files: {
          mode: "selected",
          pluginIds: ["calendar", "quickadd"],
          ignoredPluginIds: ["quickadd"],
        },
        data: {
          mode: "selected",
          pluginIds: ["calendar"],
          ignoredPluginIds: ["calendar"],
        },
      },
      inventory: [
        {
          id: "calendar",
          name: "Calendar",
          version: "1.0.0",
          local: true,
          remote: false,
          enabledLocally: true,
          desktopOnly: false,
          manifestIssue: false,
        },
        {
          id: "quickadd",
          name: "QuickAdd",
          version: null,
          local: false,
          remote: true,
          enabledLocally: null,
          desktopOnly: false,
          manifestIssue: false,
        },
      ],
      remoteInventoryTrusted: true,
      anchors: 1,
      pending: 1,
    });

    expect(summary).toMatchObject({
      files: { mode: "selected", selected: 1, ignoredOnDevice: 1 },
      data: { mode: "selected", selected: 0, ignoredOnDevice: 1 },
      inventory: {
        total: 2,
        local: 1,
        remote: 1,
        localOnly: 1,
        remoteOnly: 1,
        manifestIssues: 0,
      },
      enablement: { anchors: 1, pending: 1 },
      remoteInventoryTrusted: true,
    });
    expect(summary.policyFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(summary)).not.toContain("calendar");
    expect(JSON.stringify(summary)).not.toContain("quickadd");
  });

  it("keeps the report wired to build, scope, state, conflict, and phase evidence", () => {
    const source = readFileSync("src/main.ts", "utf8");
    for (const label of [
      "**构筑物指纹**",
      "**V2 状态存储权威**",
      "**同步范围指纹**",
      "**状态规模**",
      "**增量游标**",
      "**未完成操作核对**",
      "判等证据:",
      "**自动处理配置**",
      "**社区插件精细化范围**",
      "**社区插件过渡或受阻项**",
      "## 自动处理与恢复摘要",
      "## 最近一轮阶段耗时与请求摘要",
    ]) {
      expect(source).toContain(label);
    }
    const overviewStart = source.indexOf('lines.push("## 当前同步概况")');
    const technicalStart = source.indexOf('lines.push("## 技术状态证据")');
    const historyStart = source.indexOf('lines.push("## 近期同步记录")');
    const reportStart = source.indexOf("async generateDiagnosticReport()");
    const stateLoad = source.indexOf("await this.ensureStateLoaded()", reportStart);
    const stateCapture = source.indexOf("const reportState = this.state", reportStart);
    expect(stateLoad).toBeGreaterThan(reportStart);
    expect(stateLoad).toBeLessThan(stateCapture);
    expect(overviewStart).toBeGreaterThan(-1);
    expect(technicalStart).toBeGreaterThan(overviewStart);
    expect(historyStart).toBeGreaterThan(technicalStart);
    expect(source.indexOf("**同步状态权威**")).toBeGreaterThan(technicalStart);
    expect(source.indexOf("**V2 状态存储权威**"))
      .toBeGreaterThan(technicalStart);
    expect(source.indexOf("**同步范围指纹**")).toBeGreaterThan(technicalStart);
    expect(source.indexOf("**远端快照**")).toBeGreaterThan(technicalStart);
    expect(source).toContain("findLatestPhaseSummary(diagAll)");
    expect(source).toContain("findLatestNetworkSummary(diagAll)");
    expect(source).toContain("findLatestTransferSummary(diagAll)");
    expect(source).toContain("findLatestAutomaticHandlingSummary(diagAll)");
    expect(source).toContain("**文件传输与本地处理**");
    expect(source).toContain("summarizeMutationRecovery(");
    expect(source).toContain("automaticRecoverySchedulerState");
    expect(source).toContain("formatMutationRecoveryHistory(");
    expect(source).toContain("远端删除待确认");
    expect(source).toContain("resolveSyncPendingAttentionCounts(");
    expect(source).toContain("summarizeCommunityPluginSync(");
    expect(source).toContain(
      "fingerprintOpaqueValue(v2StorageAuthority?.databaseId ?? undefined)",
    );
    expect(source).toContain("formatV2StorageAuthorityEvidence(");
    expect(source).toContain("buildConflictEvidence(c");
    expect(source).toContain("合并不重叠的文本修改");
  });
});
