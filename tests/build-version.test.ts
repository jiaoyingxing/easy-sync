import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBakedBuildVersion } from "../src/build-version";
import { formatBuildVersionEvidence } from "../src/sync/diagnostic-report-evidence";

describe("build version evidence", () => {
  it("prints the code generation on its own when it matches the version label", () => {
    expect(formatBuildVersionEvidence("1.5.8", "1.5.8"))
      .toBe("**代码内版本**: 1.5.8");
  });

  it("names the split when the running code and the version label disagree", () => {
    // 2026-10-13 field report: a store-installed 1.5.0 bundle ran under a 1.5.7
    // manifest. The report must not let that pass as a matched install.
    const line = formatBuildVersionEvidence("1.5.0", "1.5.7");
    expect(line).toBe(
      "**代码内版本**: 1.5.0（与上方版本号 1.5.7 不一致——插件文件与版本号可能来自不同安装）",
    );
  });

  it("degrades to 不可用 instead of guessing when the build injected nothing", () => {
    expect(formatBuildVersionEvidence(null, "1.5.8"))
      .toBe("**代码内版本**: 不可用（本构筑物未注入版本）");
    // The unit-test environment itself runs without the define, so the reader
    // must return null here rather than throwing on an undeclared identifier.
    expect(readBakedBuildVersion()).toBeNull();
  });

  it("keeps the build chain injecting the version into the bundle", () => {
    // Guard (source shape): the report can only see the split while the build
    // bakes package.json's version in. Both halves are asserted so a future
    // edit cannot silently drop one.
    const root = path.resolve(__dirname, "..");
    const scripts = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ).scripts as Record<string, string>;
    expect(scripts.build).toContain("node scripts/build-bundle.mjs");
    const wrapper = readFileSync(
      path.join(root, "scripts/build-bundle.mjs"),
      "utf8",
    );
    expect(wrapper).toContain("__EASY_SYNC_BUILD_VERSION__");
    expect(wrapper).toContain('JSON.stringify(version)');
  });

  it("keeps bundle, minify and compatibility steps in dependency order", () => {
    // The compat check inspects the minified artifacts and minify consumes the
    // bundle, so a reordered chain would verify (or ship) the wrong file.
    const root = path.resolve(__dirname, "..");
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { main?: string; scripts: Record<string, string> };
    const build = pkg.scripts.build;

    const bundleAt = build.indexOf("node scripts/build-bundle.mjs");
    const minifyAt = build.indexOf("node scripts/minify-release-artifacts.mjs");
    const compatAt = build.indexOf("node scripts/check-bundle-compat.cjs");

    expect(bundleAt).toBeGreaterThanOrEqual(0);
    expect(minifyAt).toBeGreaterThanOrEqual(0);
    expect(compatAt).toBeGreaterThanOrEqual(0);
    expect(bundleAt).toBeLessThan(minifyAt);
    expect(minifyAt).toBeLessThan(compatAt);

    // Obsidian loads the manifest's main field; the bundle writes main.js.
    expect(pkg.main).toBe("main.js");

    for (const script of [
      "scripts/build-bundle.mjs",
      "scripts/minify-release-artifacts.mjs",
      "scripts/check-bundle-compat.cjs",
    ]) {
      expect(existsSync(path.join(root, script))).toBe(true);
    }
  });
});
