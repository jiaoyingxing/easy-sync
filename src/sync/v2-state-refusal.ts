/**
 * V2 状态吸收拒绝（刀 2 错误路由类型化）。
 *
 * 两个状态 reducer（file-state-reducer-v2 / folder-state-reducer-v2）对
 * 「已回执记录无法被共同状态机械吸收」的断言，此前以错误消息前缀为接口：
 * sync-executor 用「冒号前缀 ∈ 27 项封闭集合」判断 record 级 blocked（SC-20
 * 零写入退化），另有三个谓词用 includes 摘取子集决定只读修复通道。
 *
 * 本模块把该接口类型化：`V2StateRefusalError.kind` 是封闭联合（恰为原 27 项
 * 断言词表，一 kind 一断言），消息保持 `${kind}: ${detail}` 逐字节不变。
 * 新增 reducer 断言时编译器强制先在此登记 kind——漏登记的断言保持今天的
 * 响亮整轮失败，静默从不被假设（fail-closed 由类型承接，不再依赖字符串集合）。
 */

/** 封闭的吸收拒绝词表：恰为 `V2_STATE_ABSORPTION_REFUSAL_KINDS` 的 27 项。 */
export const V2_STATE_REFUSAL_KINDS = [
  // file-state-reducer-v2.ts — committed-tree / world divergence
  "V2 remote upsert is missing a drive id",
  "V2 remote upsert is missing a parent id",
  "V2 remote upsert would replace another identity",
  "V2 remote move is missing its source deletion",
  "V2 remote upsert parent does not match path",
  "V2 base upsert has no remote file identity",
  "V2 base upsert remote version mismatch",
  "V2 base upsert would replace another anchor",
  "V2 root file upsert has a non-root parent identity",
  "V2 file path is invalid",
  // folder-state-reducer-v2.ts — committed-tree / world divergence
  "V2 folder move file projection changed",
  "V2 folder move descendant projection changed",
  "V2 folder move descendant identity is missing",
  "V2 folder move has no committed source anchor",
  "V2 folder move source identity is missing",
  "V2 folder move projection differs from receipt",
  "V2 folder move would replace another identity",
  "V2 folder upsert projection differs from receipt",
  "V2 folder upsert would replace another identity",
  "V2 folder parent identity is missing",
  "V2 folder parent path changed",
  "V2 folder delete still has committed descendants",
  "V2 folder delete still has remote children",
  "V2 folder delete identity changed type",
  "V2 local folder create lost its remote identity",
  "V2 remote folder create expected an existing target",
  "V2 root folder has a non-root parent identity",
] as const;

type V2StateRefusalKind = (typeof V2_STATE_REFUSAL_KINDS)[number];

/**
 * reducer 吸收拒绝错误。消息逐字节等于原 `new Error(...)`：detail 缺省或为
 * 空串时消息恰为 kind 本身（对应裸抛形态），否则为 `${kind}: ${detail}`。
 * 一切按消息文本展示 / 指纹的面不受影响；路由面改读 `kind`。
 */
export class V2StateRefusalError extends Error {
  readonly kind: V2StateRefusalKind;

  constructor(kind: V2StateRefusalKind, detail?: string) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "V2StateRefusalError";
    this.kind = kind;
  }
}

/**
 * The reducer refusals one **already receipted** record can still be rejected by
 * after its mutation reached the world: the committed common state cannot
 * mechanically absorb this record's checkpoint any more, because either the
 * receipt claims a projection the committed tree contradicts or the cloud
 * re-organized the same objects underneath it (2026-10-16 field case F29:
 * `V2 folder move file projection changed`).
 *
 * These are not environment faults and not batch-level failures: the record's
 * own receipt is what cannot be absorbed. Reporting them as a record-level
 * `blocked` outcome (instead of a bare `Error`) is what keeps one unabsorbable
 * record from aborting the whole recovery loop — the loop in
 * `recoverMutationLedgerRecords` has no per-record guard, so a bare throw ends
 * the round for every record queued behind it (see SC-20: a record that cannot
 * be mechanically absorbed must have a zero-write degradation target and must
 * not block the whole vault).
 *
 * Fail-closed by construction: `V2StateRefusalError` 的 kind 联合本身就是封闭
 * 词表——只有两个 reducer 的吸收拒绝抛点能构造它，新断言不登记 kind 就无法
 * 进入本通道（编译期强制），保持响亮的整轮失败。静默从不被假设。
 */
export function isV2StateAbsorptionRefusalError(error: unknown): boolean {
  return error instanceof V2StateRefusalError;
}

/**
 * The first reducer refusal a receipted rename can hit (parent-path drift
 * between the receipt spelling and the refreshed index). Read-only recovery:
 * refresh the committed identity tree once, then let attempt 2 face it.
 */
export function isV2RemoteUpsertParentMismatchError(error: unknown): boolean {
  return error instanceof V2StateRefusalError
    && error.kind === "V2 remote upsert parent does not match path";
}

/**
 * The second reducer refusal a receipted rename can hit: the receipt records
 * the destination in the local spelling while the refreshed index already
 * projects the moved identity at the cloud spelling, so the reducer asks for a
 * source deletion of the index path the receipt never had to record
 * (`V2 remote move is missing its source deletion`, 2026-10-14 field case).
 * Same read-only recovery lane as the parent mismatch — refresh the committed
 * tree once, then run the alias-spelling rebase.
 */
export function isV2RemoteMoveMissingSourceDeletionError(error: unknown): boolean {
  return error instanceof V2StateRefusalError
    && error.kind === "V2 remote move is missing its source deletion";
}

/**
 * The three reducer rejections a committed identity tree can raise against a
 * recovery checkpoint's base upsert (`file-state-reducer-v2.ts`): the tree has
 * no node at the path, its node carries a different version, or the path is
 * held by another anchor. Every one of them is a statement about the committed
 * tree, so a single full rebuild of that tree is the read-only repair to try
 * before keeping the record blocked.
 */
export function isV2BaseUpsertRejectionError(error: unknown): boolean {
  return error instanceof V2StateRefusalError
    && (
      error.kind === "V2 base upsert has no remote file identity"
      || error.kind === "V2 base upsert remote version mismatch"
      || error.kind === "V2 base upsert would replace another anchor"
    );
}
