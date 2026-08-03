import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import {
  formatMutationRecoveryHistory,
  mutationRecoveryBlockReasonText,
  mutationRecoveryStatusDetail,
  mutationRecoveryStatusLabel,
} from "../src/ui/mutation-recovery-presentation";

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

    expect(mutationRecoveryStatusDetail({
      kind: "waiting-network",
      total: 2,
      settled: 1,
      remaining: 1,
      retryAt: 123,
      firstPath: "notes/a.md",
      blockReason: null,
    }, t, () => "20:30:00")).toBe(
      "1 项仍待核对，将于 20:30:00 再次核对",
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
