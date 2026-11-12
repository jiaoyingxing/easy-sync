import { describe, expect, it } from "vitest";
import {
  isV2BaseUpsertRejectionError,
  isV2RemoteMoveMissingSourceDeletionError,
  isV2RemoteUpsertParentMismatchError,
  isV2StateAbsorptionRefusalError,
  V2StateRefusalError,
  V2_STATE_REFUSAL_KINDS,
} from "../src/sync/v2-state-refusal";
import { OneDriveError, OneDriveErrorType, SyntheticRequestTimeoutError } from "../src/onedrive/types";
import {
  isRequestTimeoutError,
  isUncancellableRequestTimeout,
  rethrowUncancellableRequestTimeout,
} from "../src/onedrive/download-stream-guards";

/**
 * 重构刀 2（2026-11-01）契约门：错误路由判别码。
 *
 * 两条被路由的错误族——reducer 吸收拒绝（27 kind 封闭词表）与请求超时
 * （SyntheticRequestTimeoutError＋OneDriveError.requestTimeoutMs 标记位）——
 * 的处置分支此前挂在错误消息文本上（includes/startsWith/冒号前缀集合）。
 * 本门钉住：①类型化通道按 kind 判别；②过渡期文本兜底已退役（裸 Error＋消息
 * 文本不再被识别，fail-closed）；③拒绝消息逐字节等于旧 `new Error` 形态（展示/
 * 指纹面零漂移）。
 */
describe("v2 state refusal routing (刀 2)", () => {
  it("pins the closed refusal vocabulary at 27 kinds", () => {
    expect(V2_STATE_REFUSAL_KINDS.length).toBe(27);
    expect(new Set(V2_STATE_REFUSAL_KINDS).size).toBe(27);
  });

  it("keeps refusal messages byte-identical to the old Error shapes", () => {
    expect(new V2StateRefusalError("V2 file path is invalid", "a/b.md").message)
      .toBe("V2 file path is invalid: a/b.md");
    expect(new V2StateRefusalError("V2 root file upsert has a non-root parent identity").message)
      .toBe("V2 root file upsert has a non-root parent identity");
    expect(new V2StateRefusalError("V2 file path is invalid", "").message)
      .toBe("V2 file path is invalid");
  });

  it("routes typed refusals by kind only — message text can no longer fake a kind", () => {
    const typed = new V2StateRefusalError("V2 remote upsert parent does not match path", "a");
    expect(isV2RemoteUpsertParentMismatchError(typed)).toBe(true);
    expect(isV2RemoteUpsertParentMismatchError(new V2StateRefusalError("V2 file path is invalid", "a"))).toBe(false);
    // 兜底已删：裸 Error＋消息文本不再被识别（fail-closed，路由只读 kind）
    expect(isV2RemoteUpsertParentMismatchError(new Error("V2 remote upsert parent does not match path: a"))).toBe(false);

    const move = new V2StateRefusalError("V2 remote move is missing its source deletion", "x");
    expect(isV2RemoteMoveMissingSourceDeletionError(move)).toBe(true);
    expect(isV2RemoteMoveMissingSourceDeletionError(typed)).toBe(false);
    expect(isV2RemoteMoveMissingSourceDeletionError(new Error("V2 remote move is missing its source deletion: x"))).toBe(false);

    expect(isV2BaseUpsertRejectionError(new V2StateRefusalError("V2 base upsert has no remote file identity", "p"))).toBe(true);
    expect(isV2BaseUpsertRejectionError(new V2StateRefusalError("V2 base upsert remote version mismatch", "p"))).toBe(true);
    expect(isV2BaseUpsertRejectionError(new V2StateRefusalError("V2 base upsert would replace another anchor", "p"))).toBe(true);
    expect(isV2BaseUpsertRejectionError(new V2StateRefusalError("V2 folder move file projection changed", "p"))).toBe(false);
    expect(isV2BaseUpsertRejectionError(new Error("V2 base upsert remote version mismatch: p"))).toBe(false);

    expect(isV2RemoteUpsertParentMismatchError(null)).toBe(false);
    expect(isV2RemoteUpsertParentMismatchError("V2 remote upsert parent does not match path: a")).toBe(false);
  });

  it("classifies every vocabulary kind as an absorption refusal, fail-closed otherwise", () => {
    for (const kind of V2_STATE_REFUSAL_KINDS) {
      expect(isV2StateAbsorptionRefusalError(new V2StateRefusalError(kind, "d")), kind).toBe(true);
    }
    // fail-closed：只有类型化拒绝进入通道——文本伪造、未登记断言、格式错误、环境错误一律不算
    expect(isV2StateAbsorptionRefusalError(new Error("V2 remote upsert parent does not match path: p"))).toBe(false);
    expect(isV2StateAbsorptionRefusalError(new Error("V2 reducer requires a completed receipt: op1"))).toBe(false);
    expect(isV2StateAbsorptionRefusalError(new Error("V2 some future assertion: p"))).toBe(false);
    expect(isV2StateAbsorptionRefusalError(new Error("Request timed out after 15000ms"))).toBe(false);
    expect(isV2StateAbsorptionRefusalError(null)).toBe(false);
    expect(isV2StateAbsorptionRefusalError(new Error("weird/path: V2 file path is invalid"))).toBe(false);
  });
});

describe("request timeout routing (刀 2)", () => {
  it("detects only the typed timeout shape", () => {
    expect(isRequestTimeoutError(new SyntheticRequestTimeoutError(15000))).toBe(true);
    expect(isRequestTimeoutError(new Error("Request timed out after 15000ms"))).toBe(false);
    expect(isRequestTimeoutError(new Error("Network error: Request timed out after 15000ms"))).toBe(false);
    expect(isUncancellableRequestTimeout(new SyntheticRequestTimeoutError(15000))).toBe(true);
  });

  it("routes wrapped timeouts by the requestTimeoutMs marker only", () => {
    const wrapped = new OneDriveError(
      OneDriveErrorType.NetworkError,
      "Request timed out after 15000ms",
      0, null, null, null, 15000,
    );
    expect(isUncancellableRequestTimeout(wrapped)).toBe(true);

    // 兜底已删：无标记但文本匹配的包装不再被识别
    const unmarked = new OneDriveError(
      OneDriveErrorType.NetworkError,
      "Request timed out after 15000ms",
    );
    expect(isUncancellableRequestTimeout(unmarked)).toBe(false);

    const embedded = new OneDriveError(
      OneDriveErrorType.NetworkError,
      "Network error: Request timed out after 15000ms",
      0, null, null, null, 15000,
    );
    expect(isUncancellableRequestTimeout(embedded)).toBe(true);

    const plain = new OneDriveError(OneDriveErrorType.NetworkError, "HTTP 500");
    expect(isUncancellableRequestTimeout(plain)).toBe(false);
    expect(isUncancellableRequestTimeout(new Error("boom"))).toBe(false);
  });

  it("carries the deadline marker through the rethrow wrapper", () => {
    try {
      rethrowUncancellableRequestTimeout(new SyntheticRequestTimeoutError(15000));
      throw new Error("expected rethrow");
    } catch (error) {
      expect(error).toBeInstanceOf(OneDriveError);
      const one = error as OneDriveError;
      expect(one.type).toBe(OneDriveErrorType.NetworkError);
      expect(one.message).toBe("Request timed out after 15000ms");
      expect(one.requestTimeoutMs).toBe(15000);
    }
    expect(() => rethrowUncancellableRequestTimeout(new Error("boom"))).not.toThrow();
  });
});
