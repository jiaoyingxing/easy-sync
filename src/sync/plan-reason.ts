/**
 * 封闭的计划 reason 词汇表（重构刀 1）。
 *
 * `SyncPlanItem.reason` / `PlanReviewItem.reason` 此前是自由字符串。本表是
 * 计划项 reason 字面值的来源，`PlanReason` 封闭联合由 tsc 仲裁
 * （39 值＝24 直产＋12 folder 派生＋3 熔断）。仍有裸字面量消费点
 * （如 sync-executor 的 plannerIssueCodeForReason switch，契约门只扫
 * `.reason ===/!==` 比较），改表值时须一并核对。
 *
 * 硬边界（方案单 §四）：reason 字面值被封进计划摘要（canonicalPlanItemFactsV2），
 * **任何字面值改动都会作废在途待确认计划的摘要比对**。本刀只加类型，字面值
 * 逐字保留；改值属另一刀且须先定在途计划策略。
 *
 * 实测结论（2026-11-01）：计划域词汇是纯 `reason.` 前缀键式，zh-cn／en 文案
 * 全覆盖。仓库其他 `.reason` 裸暗码取值（envelope-unsupported、identity-mismatch、
 * receipted-upload-version-unreachable、replacement-with-local-relocation、
 * folder 内部词汇等）经闭合仲裁全部属其他域，不落计划项、不在本表。若未来
 * 有取值想进入本表，必须先有 i18n 文案（tests/plan-reason.test.ts 契约门）。
 */
export const PLAN_REASON = {
  newFileBothSides: "reason.newFileBothSides",
  bothSidesModified: "reason.bothSidesModified",
  pluginDowngradeRemote: "reason.pluginDowngradeRemote",
  renameIdentityAmbiguous: "reason.renameIdentityAmbiguous",
  localDeletedRemoteModified: "reason.localDeletedRemoteModified",
  remoteDeletedLocalModified: "reason.remoteDeletedLocalModified",
  fileDeletedLocally: "reason.fileDeletedLocally",
  fileDeletedFromRemote: "reason.fileDeletedFromRemote",
  identityReplacementVerificationPending:
    "reason.identityReplacement.verificationPending",
  identityReplacementAmbiguous: "reason.identityReplacement.ambiguous",
  identityMoveFactsChanged: "reason.identityMove.factsChanged",
  identityMoveVerificationFailed: "reason.identityMove.verificationFailed",
  identityMoveParentUnavailable: "reason.identityMove.parentUnavailable",
  identityMoveLocalTargetOccupied: "reason.identityMove.localTargetOccupied",
  identityMoveRemoteTargetOccupied: "reason.identityMove.remoteTargetOccupied",
  identityMoveContentChanged: "reason.identityMove.contentChanged",
  identityMoveBothSidesChanged: "reason.identityMove.bothSidesChanged",
  identityMoveMultipleCandidates: "reason.identityMove.multipleCandidates",
  identityMoveDeferred: "reason.identityMove.deferred",
  fileScopeCrossing: "reason.file.scope-crossing",
  folderAnchoredFolderMissingRemote:
    "reason.folder.anchored-folder-missing-remote",
  fileNameNotSyncable: "reason.fileNameNotSyncable",
  fileExceedsSizeLimit: "reason.fileExceedsSizeLimit",
  remoteScopeRecreate: "reason.remoteScopeRecreate",

  // —— folder 派生族（`reason.folder.${FolderPlanConflictReasonV2}`，映射见
  // canonical-plan-v2.ts FOLDER_PLAN_CONFLICT_REASON）——
  folderAnchorsUninitialized: "reason.folder.folder-anchors-uninitialized",
  folderAnchoredFolderMissingLocal:
    "reason.folder.anchored-folder-missing-local",
  folderBothSidesMoved: "reason.folder.both-sides-moved",
  folderLocalSubtreeChanged: "reason.folder.local-subtree-changed",
  folderRemoteSubtreeChanged: "reason.folder.remote-subtree-changed",
  folderTargetOccupied: "reason.folder.target-occupied",
  folderScopeCrossing: "reason.folder.scope-crossing",
  folderParentChainIncomplete: "reason.folder.parent-chain-incomplete",
  folderTypeConflict: "reason.folder.type-conflict",
  folderUnanchoredSharedFolder: "reason.folder.unanchored-shared-folder",
  folderLocalRenameEvidenceConflict:
    "reason.folder.local-rename-evidence-conflict",
  folderDeferred: "reason.folder.deferred",

  // —— 熔断族（RetryLater 行）——
  circuitBreaker: "reason.circuitBreaker",
  circuitBreakerNetwork: "reason.circuitBreaker.network",
  circuitBreakerRemoteMoving: "reason.circuitBreaker.remoteMoving",
} as const;

/** 计划域 reason 的封闭联合：能落进 SyncPlanItem.reason 的全部取值。 */
export type PlanReason = (typeof PLAN_REASON)[keyof typeof PLAN_REASON];
