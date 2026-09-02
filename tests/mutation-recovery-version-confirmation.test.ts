import { describe, expect, it } from "vitest";
import { compareCommunityPluginVersions } from "../src/sync/community-plugin-bundle";
import { requiresBundleVersionConfirmation } from "../src/ui/mutation-recovery-resolution-modal";

describe("requiresBundleVersionConfirmation (finding ②, shared SemVer gate)", () => {
  it("agrees with the plan-level guard on build metadata (no false downgrade)", () => {
    // modal 宽松实现把 "1.2.3+build.5 vs 1.2.3+build.9" 判为 local 更大 → 弹
    // 降级确认；SemVer 判相等 → 不弹。修复后弹框与守卫一致：build
    // metadata 不参与版本比较。
    const comparison = compareCommunityPluginVersions(
      "1.2.3+build.5",
      "1.2.3+build.9",
    );
    expect(comparison).toBe(0);
    expect(requiresBundleVersionConfirmation("keep-remote", comparison)).toBe(false);
    expect(requiresBundleVersionConfirmation("keep-local", comparison)).toBe(false);
  });

  it("uses semantic pre-release ordering instead of the lenient segment order", () => {
    // 旧宽松实现：1.3.0-rc.1 vs 1.3.0-beta.2 → "-rc" 段不可解析(-1) 相等，
    // 数字段 1 < 2 → local 更小；SemVer："rc" > "beta" → local 更大。方向
    // 相反时 "keep-remote" 会从「不确认」翻转为「确认降级」。
    const comparison = compareCommunityPluginVersions(
      "1.3.0-rc.1",
      "1.3.0-beta.2",
    );
    expect(comparison).toBe(1);
    expect(requiresBundleVersionConfirmation("keep-remote", comparison)).toBe(true);
  });

  it("confirms a real downgrade on keep-remote", () => {
    const comparison = compareCommunityPluginVersions("1.3.0", "1.2.0");
    expect(comparison).toBe(1);
    expect(requiresBundleVersionConfirmation("keep-remote", comparison)).toBe(true);
    expect(requiresBundleVersionConfirmation("keep-local", comparison)).toBe(false);
  });

  it("confirms overwriting a newer cloud bundle on keep-local", () => {
    const comparison = compareCommunityPluginVersions("1.2.0", "1.3.0");
    expect(comparison).toBe(-1);
    expect(requiresBundleVersionConfirmation("keep-local", comparison)).toBe(true);
    expect(requiresBundleVersionConfirmation("keep-remote", comparison)).toBe(false);
  });

  it("proceeds without confirmation for unparseable versions", () => {
    expect(compareCommunityPluginVersions("not-semver", "1.0.0")).toBeNull();
    expect(requiresBundleVersionConfirmation("keep-remote", null)).toBe(false);
    expect(requiresBundleVersionConfirmation("keep-local", null)).toBe(false);
  });

  it("does not confirm ordinary equal versions", () => {
    const comparison = compareCommunityPluginVersions("1.4.1", "1.4.1");
    expect(comparison).toBe(0);
    expect(requiresBundleVersionConfirmation("keep-remote", comparison)).toBe(false);
    expect(requiresBundleVersionConfirmation("keep-local", comparison)).toBe(false);
  });
});