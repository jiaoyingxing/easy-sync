import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en";
import zhCN from "../src/i18n/zh-cn";
import { PLAN_REASON, type PlanReason } from "../src/sync/plan-reason";

/**
 * 重构刀 1（2026-11-01）契约门：计划 reason 词汇封闭性。
 *
 * 三道闸：
 * 1. 字面值钉子——PLAN_REASON 的每个值逐字节钉死。reason 字面值被封进计划
 *    摘要（canonicalPlanItemFactsV2，方案单 §四），任何字面值改动都会作废
 *    在途待确认计划的摘要比对；改值必须走「另一刀＋在途计划策略拍板」。
 * 2. i18n 闭环——每个词汇值在 zh-cn／en 都能解析出文案（t() 缺键时原样
 *    返回键名，等值即缺键）。新值进表前必须先有文案。
 * 3. 比较回流门——src 内所有 `.reason ===/!== "<字面量>"` 一律引用
 *    PLAN_REASON 或落在显式登记的**非计划域**_allowlist（错误域／协议域／
 *    内部动作词汇／隔离条目域／包审查域等），防止自由字符串比较回流。
 */
describe("plan reason vocabulary contract (刀 1)", () => {
  const entries = Object.entries(PLAN_REASON) as [
    string,
    PlanReason,
  ][];

  it("pins every reason literal byte-for-byte (digest safety)", () => {
    // 黄金快照：改任何一个字面值都会让此测试变红——那是摘要作废级改动，
    // 必须按方案单 §六.2 的在途计划策略另行走刀，不许顺手改。
    expect(entries.length).toBe(39);
    expect(PLAN_REASON.newFileBothSides).toBe("reason.newFileBothSides");
    expect(PLAN_REASON.bothSidesModified).toBe("reason.bothSidesModified");
    expect(PLAN_REASON.pluginDowngradeRemote).toBe("reason.pluginDowngradeRemote");
    expect(PLAN_REASON.renameIdentityAmbiguous).toBe("reason.renameIdentityAmbiguous");
    expect(PLAN_REASON.localDeletedRemoteModified).toBe("reason.localDeletedRemoteModified");
    expect(PLAN_REASON.remoteDeletedLocalModified).toBe("reason.remoteDeletedLocalModified");
    expect(PLAN_REASON.fileDeletedLocally).toBe("reason.fileDeletedLocally");
    expect(PLAN_REASON.fileDeletedFromRemote).toBe("reason.fileDeletedFromRemote");
    expect(PLAN_REASON.identityReplacementVerificationPending).toBe("reason.identityReplacement.verificationPending");
    expect(PLAN_REASON.identityReplacementAmbiguous).toBe("reason.identityReplacement.ambiguous");
    expect(PLAN_REASON.identityMoveFactsChanged).toBe("reason.identityMove.factsChanged");
    expect(PLAN_REASON.identityMoveVerificationFailed).toBe("reason.identityMove.verificationFailed");
    expect(PLAN_REASON.identityMoveParentUnavailable).toBe("reason.identityMove.parentUnavailable");
    expect(PLAN_REASON.identityMoveLocalTargetOccupied).toBe("reason.identityMove.localTargetOccupied");
    expect(PLAN_REASON.identityMoveRemoteTargetOccupied).toBe("reason.identityMove.remoteTargetOccupied");
    expect(PLAN_REASON.identityMoveContentChanged).toBe("reason.identityMove.contentChanged");
    expect(PLAN_REASON.identityMoveBothSidesChanged).toBe("reason.identityMove.bothSidesChanged");
    expect(PLAN_REASON.identityMoveMultipleCandidates).toBe("reason.identityMove.multipleCandidates");
    expect(PLAN_REASON.identityMoveDeferred).toBe("reason.identityMove.deferred");
    expect(PLAN_REASON.fileScopeCrossing).toBe("reason.file.scope-crossing");
    expect(PLAN_REASON.folderAnchoredFolderMissingRemote).toBe("reason.folder.anchored-folder-missing-remote");
    expect(PLAN_REASON.fileNameNotSyncable).toBe("reason.fileNameNotSyncable");
    expect(PLAN_REASON.fileExceedsSizeLimit).toBe("reason.fileExceedsSizeLimit");
    expect(PLAN_REASON.remoteScopeRecreate).toBe("reason.remoteScopeRecreate");
    expect(PLAN_REASON.folderAnchorsUninitialized).toBe("reason.folder.folder-anchors-uninitialized");
    expect(PLAN_REASON.folderAnchoredFolderMissingLocal).toBe("reason.folder.anchored-folder-missing-local");
    expect(PLAN_REASON.folderBothSidesMoved).toBe("reason.folder.both-sides-moved");
    expect(PLAN_REASON.folderLocalSubtreeChanged).toBe("reason.folder.local-subtree-changed");
    expect(PLAN_REASON.folderRemoteSubtreeChanged).toBe("reason.folder.remote-subtree-changed");
    expect(PLAN_REASON.folderTargetOccupied).toBe("reason.folder.target-occupied");
    expect(PLAN_REASON.folderScopeCrossing).toBe("reason.folder.scope-crossing");
    expect(PLAN_REASON.folderParentChainIncomplete).toBe("reason.folder.parent-chain-incomplete");
    expect(PLAN_REASON.folderTypeConflict).toBe("reason.folder.type-conflict");
    expect(PLAN_REASON.folderUnanchoredSharedFolder).toBe("reason.folder.unanchored-shared-folder");
    expect(PLAN_REASON.folderLocalRenameEvidenceConflict).toBe("reason.folder.local-rename-evidence-conflict");
    expect(PLAN_REASON.folderDeferred).toBe("reason.folder.deferred");
    expect(PLAN_REASON.circuitBreaker).toBe("reason.circuitBreaker");
    expect(PLAN_REASON.circuitBreakerNetwork).toBe("reason.circuitBreaker.network");
    expect(PLAN_REASON.circuitBreakerRemoteMoving).toBe("reason.circuitBreaker.remoteMoving");
  });

  it("resolves copy for every value in both locales (no identity fallback)", () => {
    const locales: Record<string, Record<string, string>> = {
      "zh-cn": zhCN as unknown as Record<string, string>,
      en: en as unknown as Record<string, string>,
    };
    for (const [name, value] of entries) {
      for (const [locale, table] of Object.entries(locales)) {
        const copy = table[value];
        expect(
          copy,
          `PLAN_REASON.${name} (${value}) 在 ${locale} 缺文案；t() 会把键名原样显示给用户`,
        ).toBeDefined();
        expect(
          copy.length,
          `PLAN_REASON.${name} (${value}) 在 ${locale} 的文案为空串`,
        ).toBeGreaterThan(0);
        expect(
          copy,
          `PLAN_REASON.${name} (${value}) 在 ${locale} 的文案等于键名本身＝事实缺键`,
        ).not.toBe(value);
      }
    }
  });

  it("keeps every raw `.reason` literal comparison on the table or the non-plan allowlist", () => {
    const srcRoot = path.resolve(__dirname, "../src");
    const values = new Set<string>(entries.map(([, value]) => value));
    // 非计划域的 `.reason` 字面量比较（刀 1 闭合仲裁逐一核实过的接收者）：
    // 错误域（state-manager error.reason）、协议域（sync-executor protocol.reason）、
    // 隔离条目域（MutationRecoveryQuarantineEntryV2）、包审查域（bundle.local/remote.reason）、
    // folder 内部词汇（FolderPlanConflictReasonV2/FolderPlanImpactV2）、
    // 内部动作词汇（IdentityRenameActionV2）、信封域（state-envelope-v2）。
    const allowlist = new Set<string>([
      "envelope-unsupported",
      "identity-mismatch",
      "receipted-upload-version-unreachable",
      "control-directory-not-found",
      "committed-scope-unreachable",
      "migration-authority-commit-interrupted",
      "parent-chain-incomplete",
      "missing",
      "replacement-with-local-relocation",
      "same-path-identity-occupied",
      "remote-identity-missing",
      "local-identity-ambiguous",
      "both-sides-moved",
      "unanchored-shared-folder",
      "anchored-folder-missing-local",
      "anchored-folder-missing-remote",
      // typeof 守卫（diagnostic-report-evidence.ts），非词汇比较
      "string",
    ]);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        const pattern = /\.reason\s*(===|!==)\s*(?:"([^"]+)"|'([^']+)')/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          const literal = match[2] ?? match[3] ?? "";
          if (!values.has(literal) && !allowlist.has(literal)) {
            offenders.push(
              `${path.relative(srcRoot, full)}: .reason ${match[1]} "${literal}"`,
            );
          }
        }
      }
    };
    walk(srcRoot);

    expect(
      offenders,
      `发现既不在 PLAN_REASON 也不在非计划域 allowlist 的裸比较（应改引常量表或先登记域归属）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
