import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import {
  formatMutationRecoveryHistory,
  mutationRecoveryBlockReasonText,
  mutationRecoveryBodyPresentation,
  mutationRecoveryStatusDetail,
  mutationRecoveryStatusLabel,
  mutationRecoveryTopStatusLabel,
  shouldAutoSettleIdenticalRecovery,
} from "../src/ui/mutation-recovery-presentation";
import type { ManualMutationResolutionSnapshotV1 } from "../src/sync/types";

describe("mutation recovery presentation", () => {
  it("keeps checking, network wait, and stable block semantically distinct", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);

    expect(mutationRecoveryStatusLabel({
      kind: "checking",
      total: 2,
      settled: 0,
      remaining: 2,
      retryAt: null,
      firstPath: "notes/a.md",
      blockReason: null,
    }, t)).toBe("正在核对上次未完成的操作");

    expect(mutationRecoveryTopStatusLabel({
      kind: "checking",
      total: 2,
      settled: 0,
      remaining: 2,
      retryAt: null,
      firstPath: "notes/a.md",
      blockReason: null,
    }, t)).toBe("正在核对");

    const en = new I18n("en");
    expect(mutationRecoveryTopStatusLabel({
      kind: "checking",
      total: 2,
      settled: 0,
      remaining: 2,
      retryAt: null,
      firstPath: "notes/a.md",
      blockReason: null,
    }, en.t.bind(en))).toBe("Checking");

    expect(mutationRecoveryStatusDetail({
      kind: "waiting-network",
      total: 2,
      settled: 1,
      remaining: 1,
      retryAt: 123,
      firstPath: "notes/a.md",
      blockReason: null,
    }, t, () => "20:30:00")).toBe(
      "1 项待核对，20:30:00 再次核对",
    );

    expect(mutationRecoveryStatusDetail({
      kind: "blocked",
      total: 2,
      settled: 1,
      remaining: 1,
      retryAt: null,
      firstPath: "notes/a.md",
      blockReason: "facts-changed",
    }, t, () => "")).toBe(
      "文件或云端状态已经变化 · 涉及 1 项 · notes/a.md",
    );
  });

  it("maps every stable block reason through equivalent locale contracts", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const reasons = [
      "facts-changed",
      "scope-changed",
      "account-changed",
      "evidence-corrupt",
      "state-unavailable",
      "automatic-budget-exhausted",
      "unknown",
    ] as const;

    for (const reason of reasons) {
      expect(mutationRecoveryBlockReasonText(reason, zh.t.bind(zh)))
        .not.toBe(reason);
      expect(mutationRecoveryBlockReasonText(reason, en.t.bind(en)))
        .not.toBe(reason);
    }
  });

  it("separates the short top status from persistent reason, path, and next step", () => {
    const zh = new I18n("zh-cn");
    const t = zh.t.bind(zh);
    const state = {
      kind: "blocked" as const,
      total: 2,
      settled: 1,
      remaining: 1,
      retryAt: null,
      firstPath: ".obsidian/plugins/dataview/data.json",
      blockReason: "facts-changed" as const,
      blockedOperationId: "op-1",
      manualResolutionAvailable: true,
    };

    expect(mutationRecoveryStatusLabel(state, t)).toBe("未完成操作");
    expect(mutationRecoveryBodyPresentation(state, t, () => "")).toEqual({
      summary: "有 1 笔操作无法自动完成，不影响其他同步。",
      path: ".obsidian/plugins/dataview/data.json",
      reason: "文件或云端状态已经变化",
      retryAt: null,
      nextStep: "核对本机与云端内容并选择保留哪一侧。完成后会自动继续同步。",
      actionKey: "syncView.recovery.reviewDetails",
    });
  });

  it("keeps only real recovery actions: review for facts-changed, scope retry for scope-changed", () => {
    const zh = new I18n("zh-cn");
    const t = zh.t.bind(zh);
    const base = {
      total: 2,
      settled: 1,
      remaining: 1,
      retryAt: null,
      firstPath: "notes/a.md",
      blockedOperationId: "op-1",
    };

    expect(mutationRecoveryBodyPresentation({
      kind: "blocked",
      ...base,
      blockReason: "facts-changed",
      manualResolutionAvailable: false,
    }, t, () => "")).toMatchObject({
      actionKey: null,
      nextStep: "暂时无法自动确认。可导出诊断报告，或强制重置同步状态。",
    });

    expect(mutationRecoveryBodyPresentation({
      kind: "blocked",
      ...base,
      blockReason: "scope-changed",
    }, t, () => "")).toMatchObject({
      actionKey: "syncView.recovery.retryScopeRecovery",
    });

    expect(mutationRecoveryBodyPresentation({
      kind: "blocked",
      ...base,
      blockReason: "account-changed",
    }, t, () => "")).toMatchObject({
      actionKey: null,
      nextStep: "请换回原账号，换回后会自动继续；也可以强制重置同步状态。",
    });
  });

  it("renders honest status without choice buttons for waiting and paused states", () => {
    const zh = new I18n("zh-cn");
    const t = zh.t.bind(zh);

    expect(mutationRecoveryBodyPresentation({
      kind: "waiting-network",
      total: 2,
      settled: 1,
      remaining: 1,
      retryAt: 20,
      firstPath: "notes/a.md",
      blockReason: null,
    }, t, () => "20:30:00")).toMatchObject({
      actionKey: null,
      nextStep: "无需操作，网络恢复后会自动继续。",
    });

    expect(mutationRecoveryBodyPresentation({
      kind: "blocked",
      total: 2,
      settled: 1,
      remaining: 1,
      retryAt: null,
      firstPath: "notes/a.md",
      blockReason: "evidence-corrupt",
      paused: true,
    }, t, () => "")).toMatchObject({
      summary: "同步已暂停：有 1 笔操作无法自动确认。",
      actionKey: null,
    });
  });

  it("describes one continuing history event without inventing separate failures", () => {
    const i18n = new I18n("en");
    const t = i18n.t.bind(i18n);

    expect(formatMutationRecoveryHistory({
      state: "waiting-network",
      total: 3,
      settled: 1,
      remaining: 2,
      updatedAt: 10,
      retryAt: 20,
    }, t)).toBe(
      "Waiting for the network: 2/3 item(s) need checking",
    );
    expect(formatMutationRecoveryHistory({
      state: "recovered",
      total: 3,
      settled: 3,
      remaining: 0,
      updatedAt: 30,
    }, t)).toBe(
      "Automatically recovered 3 item(s), then continued syncing",
    );
  });
});

describe("shouldAutoSettleIdenticalRecovery", () => {
  const snapshot = (
    overrides: Partial<ManualMutationResolutionSnapshotV1>,
  ): ManualMutationResolutionSnapshotV1 => ({
    version: 1,
    sourceOperationId: "op-1",
    scope: { accountId: "a" },
    previousAction: "upload",
    path: "note.md",
    local: [{ path: "note.md", exists: true, hash: "h", size: 1 }],
    remote: [{ path: "note.md", exists: true, hash: "h", size: 1 }],
    factsDigest: "digest",
    identical: true,
    keepLocal: { available: true, deletesOtherSide: false },
    keepRemote: { available: true, deletesOtherSide: false },
    ...overrides,
  }) as ManualMutationResolutionSnapshotV1;

  it("auto-settles an identical ordinary snapshot", () => {
    expect(shouldAutoSettleIdenticalRecovery(snapshot({}))).toBe(true);
  });

  it("never auto-settles a bundle review snapshot", () => {
    const bundle = snapshot({});
    (bundle as { bundleReview?: unknown }).bundleReview = {};
    expect(shouldAutoSettleIdenticalRecovery(bundle)).toBe(false);
  });

  it("never auto-settles a non-identical snapshot", () => {
    expect(shouldAutoSettleIdenticalRecovery(
      snapshot({ identical: false }),
    )).toBe(false);
  });
});
