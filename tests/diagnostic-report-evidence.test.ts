import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildConflictEvidence,
  findLatestAutomaticHandlingSummary,
  findLatestNetworkSummary,
  findLatestPhaseSummary,
  findLatestTransferSummary,
  fingerprintOpaqueValue,
  summarizeMutationRecovery,
} from "../src/sync/diagnostic-report-evidence";
import { SyncActionType, type MutationLedgerEntryV1 } from "../src/sync/types";

describe("diagnostic report evidence", () => {
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
      remoteSha256: "—",
      hasDecisionToken: false,
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

  it("keeps the report wired to build, scope, state, conflict, and phase evidence", () => {
    const source = readFileSync("src/main.ts", "utf8");
    for (const label of [
      "**构筑物指纹**",
      "**同步范围指纹**",
      "**状态规模**",
      "**增量游标**",
      "判等证据:",
      "**自动处理配置**",
      "## 自动处理与恢复摘要",
      "## 最近一轮阶段耗时与请求摘要",
    ]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("findLatestPhaseSummary(diagAll)");
    expect(source).toContain("findLatestNetworkSummary(diagAll)");
    expect(source).toContain("findLatestTransferSummary(diagAll)");
    expect(source).toContain("findLatestAutomaticHandlingSummary(diagAll)");
    expect(source).toContain("**文件传输与本地处理**");
    expect(source).toContain("summarizeMutationRecovery(");
    expect(source).toContain("buildConflictEvidence(c");
    expect(source).toContain("合并不重叠的文本修改");
  });
});
