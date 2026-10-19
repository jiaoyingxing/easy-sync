import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateCodeChallengeSync,
  generateCodeVerifier,
  generateState,
} from "../src/auth/pkce";

/**
 * 2026-10-16（批次⑤ 之一，用户已拍板）：**真实 PKCE 生成的覆盖补齐**。
 *
 * 背景（全仓审计原文）：`tests/auth-module.test.ts` 把 `pkce` 三件换成常量 ⇒
 * **那套用例并不覆盖真实的 PKCE 生成**（证明的是"替身抄得对"）。本文件直接对真实现
 * 取证，并且**用 node:crypto 独立重算一遍 S256**——不是拿实现对自己，而是拿
 * RFC 7636 的定义对它。原用例保持不变（其替换常量仍是那条流程测试的既定手法）。
 */

const VERIFIER_CHARSET = /^[A-Za-z0-9\-._~]+$/;

/** RFC 7636 §4.2：S256 = BASE64URL(SHA256(ASCII(code_verifier)))，无填充。 */
function expectedS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

describe("real PKCE generation (RFC 7636)", () => {
  it("generates a verifier inside the RFC shape and derives its S256 challenge", () => {
    const verifier = generateCodeVerifier();

    // 形状：43–128 个 unreserved 字符（RFC 7636 §4.1）。
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(VERIFIER_CHARSET.test(verifier)).toBe(true);

    // 独立重算 S256：base64url(sha256(verifier))，且不带填充。
    const challenge = generateCodeChallengeSync(verifier);
    expect(challenge).toBe(expectedS256(verifier));
    expect(challenge).not.toContain("=");
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("produces fresh randomness per call (no fixed fixture)", () => {
    const verifiers = new Set(Array.from({ length: 8 }, () => generateCodeVerifier()));
    expect(verifiers.size).toBe(8);

    const challenges = [...verifiers].map((verifier) => generateCodeChallengeSync(verifier));
    expect(new Set(challenges).size).toBe(8);
  });

  it("derives a stable challenge for a fixed verifier (independent vectors)", () => {
    // 固定向量：用 node:crypto 与实现各自算一次，两者必须逐字符一致。
    const verifier = randomBytes(32).toString("base64url");
    expect(verifier).toMatch(VERIFIER_CHARSET);
    expect(generateCodeChallengeSync(verifier)).toBe(expectedS256(verifier));
    expect(generateCodeChallengeSync(verifier)).toBe(generateCodeChallengeSync(verifier));
  });

  it("generates distinct OAuth state values of usable length", () => {
    const states = new Set(Array.from({ length: 8 }, () => generateState()));
    expect(states.size).toBe(8);
    for (const state of states) {
      expect(state.length).toBeGreaterThanOrEqual(16);
      expect(state).toMatch(VERIFIER_CHARSET);
    }
  });
});
