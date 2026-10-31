import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import {
  formatMutationRecoveryHistory,
  mutationRecoveryBlockReasonText,
  mutationRecoveryBodyPresentation,
  mutationRecoveryStatusDetail,
  mutationRecoveryStatusLabel,
  resolveOrdinaryResolutionActions,
  mutationRecoveryTopStatusLabel,
  mutationRecoveryPrimaryActionKey,
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

  it("gives the review state its own one-line body and keeps the file list out", () => {
    const zh = new I18n("zh-cn");
    const t = zh.t.bind(zh);
    const state = {
      kind: "blocked" as const,
      total: 2,
      settled: 1,
      remaining: 1,
      retryAt: null,
      firstPath: ".obsidian/plugins/dataview/data.json",
      paths: [".obsidian/plugins/dataview/data.json"],
      blockReason: "facts-changed" as const,
      blockedOperationId: "op-1",
      manualResolutionAvailable: true,
    };

    expect(mutationRecoveryStatusLabel(state, t)).toBe("未完成操作");
    expect(mutationRecoveryBodyPresentation(state, t, () => "")).toEqual({
      summary: "请检查本机与云端差异，选择保留版本，之后自动继续。",
      paths: [],
      showFileList: false,
      nextStep: null,
      actionKey: "syncView.recovery.reviewDetails",
      secondaryAction: null,
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
      nextStep: "如果再次同步后仍未完成，请前往「设置 → 维护」生成诊断报告发给作者，或重置同步状态。",
      showFileList: true,
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

  it("offers the review exit under a state-unavailable stamp when the record is eligible", () => {
    const zh = new I18n("zh-cn");
    const t = zh.t.bind(zh);
    const base = {
      total: 1,
      settled: 0,
      remaining: 1,
      retryAt: null,
      firstPath: "行医启发/慢性肾病的康复.md",
      blockedOperationId: "op-1",
      paused: true,
    };

    // A state-unavailable stamp describes how a past round ended, not what
    // the record is. When the record itself is eligible, the crash stamp
    // must not freeze it behind "export or reset" (field reports 2026-09-28).
    expect(mutationRecoveryPrimaryActionKey({
      kind: "blocked",
      ...base,
      blockReason: "state-unavailable",
      manualResolutionAvailable: true,
    })).toBe("syncView.recovery.reviewDetails");
    expect(mutationRecoveryBodyPresentation({
      kind: "blocked",
      ...base,
      blockReason: "state-unavailable",
      manualResolutionAvailable: true,
    }, t, () => "")).toMatchObject({
      actionKey: "syncView.recovery.reviewDetails",
      nextStep: null,
      summary: "请检查本机与云端差异，选择保留版本，之后自动继续。",
      showFileList: false,
    });

    // Eligibility still governs: an ineligible or corrupt-evidence block
    // keeps the honest no-choice presentation.
    expect(mutationRecoveryPrimaryActionKey({
      kind: "blocked",
      ...base,
      blockReason: "state-unavailable",
      manualResolutionAvailable: false,
    })).toBeNull();
    expect(mutationRecoveryPrimaryActionKey({
      kind: "blocked",
      ...base,
      blockReason: "evidence-corrupt",
      manualResolutionAvailable: true,
    })).toBeNull();
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
      // 2026-09-15 文案减负 R-4：summary 已含「网络恢复后自动重试」，
      // 自动态不再渲染同义复读的 next-step 行。
      nextStep: null,
    });

    expect(mutationRecoveryBodyPresentation({
      kind: "checking",
      total: 2,
      settled: 0,
      remaining: 2,
      retryAt: null,
      firstPath: "notes/a.md",
      blockReason: null,
    }, t, () => "")).toMatchObject({
      summary: "正在核对上次操作的结果，核对结束前不会继续同步。",
      nextStep: null,
      showFileList: true,
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
      summary: "上次同步意外中断，有文件未能完成同步。",
      actionKey: null,
      showFileList: true,
    });
  });

  it("maps each recovery family to its own body, footer, list mode, and chip", () => {
    const zh = new I18n("zh-cn");
    const t = zh.t.bind(zh);
    const base = {
      kind: "blocked" as const,
      total: 8,
      settled: 0,
      remaining: 8,
      retryAt: null,
      firstPath: "notes/a.md",
      paths: ["notes/a.md", "notes/b.md"],
      blockedOperationId: "op-1",
    };

    expect(mutationRecoveryBodyPresentation({
      ...base,
      blockReason: "facts-changed",
    }, t, () => "")).toMatchObject({
      summary: "上次同步意外中断，有文件未能完成同步。",
      paths: ["notes/a.md", "notes/b.md"],
      showFileList: true,
      nextStep: "如果再次同步后仍未完成，请前往「设置 → 维护」生成诊断报告发给作者，或重置同步状态。",
    });

    expect(mutationRecoveryBodyPresentation({
      ...base,
      kind: "waiting-network",
      retryAt: 20,
      blockReason: null,
    }, t, () => "20:30")).toMatchObject({
      summary: "网络暂时不可用，将在 20:30 自动重试。",
      paths: ["notes/a.md", "notes/b.md"],
      showFileList: true,
      nextStep: null,
    });

    expect(mutationRecoveryBodyPresentation({
      ...base,
      kind: "waiting-network",
      retryAt: null,
      blockReason: null,
      exhausted: true,
    }, t, () => "")).toMatchObject({
      summary: "系统不再自动重试，有文件未能完成同步。",
      showFileList: false,
      nextStep: "如果再次同步后仍未完成，请前往「设置 → 维护」生成诊断报告发给作者，或重置同步状态。",
    });
    expect(mutationRecoveryTopStatusLabel({
      ...base,
      kind: "waiting-network",
      retryAt: null,
      blockReason: null,
      exhausted: true,
    }, t)).toBe("未完成操作");

    expect(mutationRecoveryBodyPresentation({
      ...base,
      blockReason: "scope-changed",
    }, t, () => "")).toMatchObject({
      summary: "同步位置与上次操作不一致，有文件未能完成同步。",
      showFileList: false,
      nextStep: "恢复同步位置后会重新核对。",
    });

    expect(mutationRecoveryBodyPresentation({
      ...base,
      blockReason: "account-changed",
    }, t, () => "")).toMatchObject({
      summary: "当前账号与上次操作不一致，有文件未能完成同步。",
      showFileList: false,
      secondaryAction: "open-settings",
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

describe("folder recovery settle exit presentation", () => {
  const base = {
    kind: "blocked" as const,
    total: 1,
    settled: 0,
    remaining: 1,
    retryAt: null,
    firstPath: "second-brain/books",
    blockReason: "facts-changed" as const,
    blockedOperationId: "stuck-folder-op",
  };

  it("keeps blocked-folder records honest without an exit button (auto-settled upstream, 2026-09-13 拍板)", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const state = { ...base };

    // Folder records auto-settle in the recovery batch: no top-slot button,
    // no settlement pointer — only the honest blocked status remains.
    expect(mutationRecoveryPrimaryActionKey(state)).toBeNull();
    const body = mutationRecoveryBodyPresentation(state, t, () => "");
    expect(body.actionKey).toBeNull();
    expect(body.nextStep).toBe(t("syncView.recovery.nextStep.blocked"));
  });

  it("keeps the file review exit for an eligible ordinary-file record", () => {
    const state = { ...base, manualResolutionAvailable: true };

    expect(mutationRecoveryPrimaryActionKey(state)).toBe(
      "syncView.recovery.reviewDetails",
    );
  });

  it("keeps honest status without an exit when no settlement is available", () => {
    expect(mutationRecoveryPrimaryActionKey(base)).toBeNull();
  });
});

describe("resolveOrdinaryResolutionActions (2026-10-31 move shapes)", () => {
  const sourcePath = "情感勒索.md";
  const targetPath = "心理学习/情感勒索.md";

  function moveSnapshot(options: {
    localSource?: boolean;
    localTarget?: boolean;
    remoteSource?: boolean;
    remoteTarget?: boolean;
    localHash?: string;
    remoteHash?: string;
    keepLocalAvailable?: boolean;
    keepRemoteAvailable?: boolean;
    recoveryEvidence?: boolean;
  }): ManualMutationResolutionSnapshotV1 {
    const localHash = options.localHash ?? "a".repeat(64);
    const remoteHash = options.remoteHash ?? "a".repeat(64);
    const local = [
      options.localSource
        ? { path: sourcePath, exists: true, hash: localHash, size: 12_300 }
        : { path: sourcePath, exists: false },
      options.localTarget
        ? { path: targetPath, exists: true, hash: localHash, size: 12_300 }
        : { path: targetPath, exists: false },
    ];
    const remote = [
      options.remoteSource
        ? {
            path: sourcePath,
            exists: true,
            driveId: "drive-source",
            eTag: "etag-source",
            hash: remoteHash,
            size: 12_300,
          }
        : { path: sourcePath, exists: false },
      options.remoteTarget
        ? {
            path: targetPath,
            exists: true,
            driveId: "drive-target",
            eTag: "etag-target",
            hash: remoteHash,
            size: 12_300,
          }
        : { path: targetPath, exists: false },
    ];
    return {
      version: 1,
      sourceOperationId: "1792661471166-283-renameRemote",
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault-folder",
        filesRootId: "files-root",
      },
      previousAction: "renameRemote",
      path: targetPath,
      sourcePath,
      local,
      remote,
      factsDigest: "digest",
      identical: false,
      keepLocal: {
        available: options.keepLocalAvailable ?? true,
        deletesOtherSide: false,
      },
      keepRemote: {
        available: options.keepRemoteAvailable ?? true,
        deletesOtherSide: false,
      },
      ...(options.recoveryEvidence
        ? {
            recoveryEvidence: {
              kind: "receipted-rename-target-anchor-collision" as const,
              lifecycleEpoch: 1,
              sourceCommitSeq: 1,
              sourceAnchorId: "source-anchor",
              targetAnchorId: "target-anchor",
              staleRemoteIds: ["stale"],
            },
          }
        : {}),
    };
  }

  it("names the operation when only the cloud copy survives", () => {
    const actions = resolveOrdinaryResolutionActions(moveSnapshot({
      remoteSource: true,
    }));
    expect(actions?.map((action) => action.labelKey)).toEqual([
      "syncView.mutationResolution.action.deleteRemote",
      "syncView.mutationResolution.action.download",
    ]);
    expect(actions?.map((action) => action.choice)).toEqual([
      "keep-local",
      "keep-remote",
    ]);
    expect(actions?.map((action) => action.className)).toEqual([
      "mod-warning",
      "mod-cta",
    ]);
  });

  it("names the operation when only the local copy survives", () => {
    const actions = resolveOrdinaryResolutionActions(moveSnapshot({
      localTarget: true,
    }));
    expect(actions?.map((action) => action.labelKey)).toEqual([
      "syncView.mutationResolution.action.deleteLocal",
      "syncView.mutationResolution.action.upload",
    ]);
    expect(actions?.map((action) => action.choice)).toEqual([
      "keep-remote",
      "keep-local",
    ]);
    expect(actions?.map((action) => action.className)).toEqual([
      "mod-warning",
      "mod-cta",
    ]);
  });

  it("keeps the location wording when both copies are identical", () => {
    const actions = resolveOrdinaryResolutionActions(moveSnapshot({
      localTarget: true,
      remoteSource: true,
    }));
    expect(actions?.map((action) => action.labelKey)).toEqual([
      "syncView.mutationResolution.keepLocal",
      "syncView.mutationResolution.keepRemote",
    ]);
    expect(actions?.every((action) => action.className === null)).toBe(true);
  });

  it("uses the version wording when the two copies diverged", () => {
    const actions = resolveOrdinaryResolutionActions(moveSnapshot({
      localTarget: true,
      remoteSource: true,
      localHash: "b".repeat(64),
    }));
    expect(actions?.map((action) => action.labelKey)).toEqual([
      "syncView.mutationResolution.keepLocalVersion",
      "syncView.mutationResolution.keepRemoteVersion",
    ]);
    expect(actions?.every((action) => action.className === null)).toBe(true);
  });

  it("drops an unavailable direction instead of rendering it", () => {
    const actions = resolveOrdinaryResolutionActions(moveSnapshot({
      localTarget: true,
      remoteSource: true,
      keepRemoteAvailable: false,
    }));
    expect(actions?.map((action) => action.choice)).toEqual(["keep-local"]);
  });

  it("keeps the modal wired to the resolver and drops the old prose hints", () => {
    // No DOM harness exists in this repo, so the render wiring is pinned by
    // source shape: the modal must ask the resolver, and the old
    // "delete this side" sentences must be gone (2026-10-31 field case).
    const modal = readFileSync(
      path.resolve(__dirname, "../src/ui/mutation-recovery-resolution-modal.ts"),
      "utf8",
    );
    expect(modal).toContain("resolveOrdinaryResolutionActions(");
    expect(modal).not.toContain("resolveMoveNoActionHints(");
    expect(modal).toContain("noAvailableActionsMoveDiverged");
    expect(modal).toContain("noAvailableActionsMoveMismatch");
  });
});

describe("resolveOrdinaryResolutionActions (2026-10-25 empty-side naming)", () => {
  function snapshotFor(options: {
    local: boolean;
    remote: boolean;
    sourcePath?: string;
    bundle?: boolean;
  }): ManualMutationResolutionSnapshotV1 {
    const path = "yx/附件/Screenrecording_20261020_064519.mp4";
    const local = options.local
      ? [{ path, exists: true, hash: "a".repeat(64), size: 141_033_472 }]
      : [{ path, exists: false }];
    const remote = options.remote
      ? [{
          path,
          exists: true,
          driveId: "drive-item",
          eTag: "etag-1",
          size: 141_033_472,
        }]
      : [{ path, exists: false }];
    return {
      version: 1,
      sourceOperationId: "1792853851010-100-download",
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault-folder",
        filesRootId: "files-root",
      },
      previousAction: "download",
      path,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      local,
      remote,
      factsDigest: "digest",
      identical: false,
      keepLocal: {
        available: true,
        deletesOtherSide: !options.local && options.remote,
      },
      keepRemote: {
        available: true,
        deletesOtherSide: options.local && !options.remote,
      },
      ...(options.bundle ? { bundleReview: {} as never } : {}),
    };
  }

  it("names the operation, not the side, when the local side is empty", () => {
    const actions = resolveOrdinaryResolutionActions(
      snapshotFor({ local: false, remote: true }),
    );

    // The old buttons said "keep local" / "keep cloud"; keeping an empty local
    // side deletes the cloud copy, so the labels must name the operation, and
    // the CTA sits last (DOM secondary → primary). 2026-10-31.
    expect(actions?.map((action) => action.labelKey)).toEqual([
      "syncView.mutationResolution.action.deleteRemote",
      "syncView.mutationResolution.action.download",
    ]);
    expect(actions?.map((action) => action.choice)).toEqual([
      "keep-local",
      "keep-remote",
    ]);
    expect(actions?.map((action) => action.className)).toEqual([
      "mod-warning",
      "mod-cta",
    ]);
  });

  it("names the operation when the cloud side is empty", () => {
    const actions = resolveOrdinaryResolutionActions(
      snapshotFor({ local: true, remote: false }),
    );

    expect(actions?.map((action) => action.labelKey)).toEqual([
      "syncView.mutationResolution.action.deleteLocal",
      "syncView.mutationResolution.action.upload",
    ]);
    expect(actions?.map((action) => action.choice)).toEqual([
      "keep-remote",
      "keep-local",
    ]);
    expect(actions?.map((action) => action.className)).toEqual([
      "mod-warning",
      "mod-cta",
    ]);
  });

  it("keeps the side wording with an explicit version noun when both sides exist", () => {
    const actions = resolveOrdinaryResolutionActions(
      snapshotFor({ local: true, remote: true }),
    );

    expect(actions?.map((action) => action.labelKey)).toEqual([
      "syncView.mutationResolution.keepLocalVersion",
      "syncView.mutationResolution.keepRemoteVersion",
    ]);
    // Both directions overwrite a recoverable version: no danger colour, no
    // restored-file CTA.
    expect(actions?.every((action) => action.className === null)).toBe(true);
  });

  it("leaves whole-bundle reviews on their own wording", () => {
    expect(resolveOrdinaryResolutionActions(
      snapshotFor({ local: true, remote: true, bundle: true }),
    )).toBeNull();
    // A move-style review with one copy per side but different content has no
    // executable single-step settlement yet; the caller keeps the honest
    // "do not delete either side" body (2026-10-31).
    expect(resolveOrdinaryResolutionActions(
      snapshotFor({ local: true, remote: true, sourcePath: "old/a.md" }),
    )).toBeNull();
  });

  it("pins the visible copy and the body slot", () => {
    const zh = new I18n("zh-cn");
    expect(zh.t("syncView.mutationResolution.title")).toBe("选择以哪一侧为准");
    expect(zh.t("syncView.mutationResolution.description")).toBe(
      "上次操作结果无法确认，请核对后选择。",
    );
    expect(zh.t("syncView.mutationResolution.deleteConfirmWarning")).toBe(
      "执行前会再核对两侧，有变化就停止。",
    );
    expect(zh.t("syncView.mutationResolution.action.deleteRemote")).toBe(
      "删除云端文件",
    );
    expect(zh.t("syncView.mutationResolution.deleteConfirm")).toBe("删除");
    expect(zh.t("syncView.mutationResolution.deleteConfirmTitleRemote")).toBe(
      "删除云端这份文件？",
    );
    const message = zh.t("syncView.mutationResolution.deleteConfirmMessageRemote", {
      path: "a.mp4",
      size: "134.5 MB",
    });
    expect(message).toContain("只存在于云端");
    expect(message).toContain("都不再有这份文件");
    expect(zh.t("syncView.mutationResolution.noAvailableActionsMoveDiverged"))
      .toContain("请不要删除任何一侧");
    expect(zh.t("syncView.mutationResolution.noAvailableActionsMoveMismatch", {
      localCount: 2,
      remoteCount: 1,
    })).toContain("本机 2 份、云端 1 份");

    // The reason line moved out of the collapsed evidence into the body and no
    // longer repeats the path (2026-08-16: the path shows in the table once).
    const modal = readFileSync(
      path.resolve(__dirname, "../src/ui/mutation-recovery-resolution-modal.ts"),
      "utf8",
    );
    expect(modal).toContain("resolveOrdinaryResolutionActions(");
    expect(modal).toMatch(
      /body\.createEl\("p", \{\s*text: this\.t\("syncView\.mutationResolution\.description"\)/,
    );
    expect(modal).not.toContain('"syncView.mutationResolution.description", {');
    expect(modal).not.toContain("noAvailableActionsKeepLocal");
  });
});
