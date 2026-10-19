import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 2026-10-16（Q4，用户已认可方向「甲案」）：公开仓 `npm test` 必红的根治门。
 *
 * 背景：公开仓只投影源码树的一部分。`scripts/` 里只有构建链那四个脚本会投影，
 * 探针与内部部署脚本按历轮披露边界**不投影**。于是"读 `scripts/` 下未投影脚本"
 * 的测试在源码仓全绿、在公开仓必红（实跑：`graph-contract-fixtures` 5 failed／8，
 * `dev-deploy-safety` 7 failed／7，原因都是 ENOENT）。2026-09-14 的 1.4.4 投影
 * 记录把其中两件**刻意**补进公开仓，理由只写了披露安全（"无本机路径与 vault 名"），
 * **从未评估可运行性**；1.3.x 则明确不投影。
 *
 * 本门管的是**根因**而不是再修一次症状：任何测试只要引用未投影的 `scripts/` 路径，
 * 就必须同时出现在下面的"不投影测试"名单里——新增依赖会当场变红，逼出一次显式决定
 * （要么自带缺件守卫、要么进名单），而不是等公开仓跑红才发现。
 *
 * 名单口径：进名单＝**该文件不进公开仓投影**。名单里的文件在公开仓不存在，
 * 因此本门只用"现存文件＋引用"判红，不反过来要求名单项必须存在（两仓都能跑）。
 */

/** 会随公开仓投影出去的脚本（构建链四件；见 PROJECT_CONTEXT「构筑物构建与压缩」）。 */
const PROJECTED_SCRIPTS = new Set([
  "scripts/build-bundle.mjs",
  "scripts/check-bundle-compat.cjs",
  "scripts/check-lockfile-ci.ps1",
  "scripts/minify-release-artifacts.mjs",
]);

/**
 * 明确不投影的测试文件（公开仓 `main` 侧也没有它们）。
 * `recovery-rename-spelling-reflection` 是既有名单；后两件＝2026-10-16 定案补入，
 * 待下次投影时从公开仓删除（删除须随投影推送，推送另行授权）。
 */
const NOT_PROJECTED_TESTS = new Set([
  "tests/recovery-rename-spelling-reflection.test.ts",
  "tests/dev-deploy-safety.test.ts",
  "tests/graph-contract-fixtures.test.ts",
]);

/** 引号里出现的 scripts 路径（够用的启发式：不走注释与正则误伤）。 */
function referencedScriptPaths(source: string): string[] {
  const matches = [...source.matchAll(/["'`](scripts\/[^"'`\s]+)["'`]/g)];
  return [...new Set(matches.map((match) => match[1]))];
}

describe("public projection dependency gate", () => {
  // 超时分档（2026-10-17，B12 时基健康）：本条是**整仓扫描型**门——同步读遍
  // `tests/` 下全部用例文件（实测 217 个 / 5.02 MiB）。耗时由仓库规模与磁盘／杀软
  // 负载决定，不属判据；给 30s 余量（实测 58–126ms，余量 ≳238x）。
  it("keeps every test that reads a non-projected script on the not-projected list", () => {
    const offenders: Array<{ file: string; script: string }> = [];
    const scanned = readdirSync("tests").filter((name) => name.endsWith(".test.ts"));
    for (const name of scanned) {
      const file = `tests/${name}`;
      const source = readFileSync(file, "utf8");
      for (const script of referencedScriptPaths(source)) {
        if (PROJECTED_SCRIPTS.has(script)) continue;
        if (NOT_PROJECTED_TESTS.has(file)) continue;
        offenders.push({ file, script });
      }
    }

    // 一条都不用"提醒"，直接给出文件与脚本路径，便于当场决定归属。
    expect(offenders).toEqual([]);
    // 反假绿（2026-10-16 检查体检轮）：这条门判的是"没发现违规"，所以必须证明
    // **探测器真的在工作**——扫描面非空、且抽取器能从真实文件里抽出引用。
    // 否则目录改名／正则写坏都会让门静默变绿。
    expect(scanned.length).toBeGreaterThan(100);
    const detectorProof = referencedScriptPaths(
      readFileSync("tests/build-version.test.ts", "utf8"),
    );
    expect(detectorProof).toContain("scripts/build-bundle.mjs");
  }, 30_000);

  it("keeps the not-projected list explicit and duplicate-free", () => {
    const entries = [...NOT_PROJECTED_TESTS];

    expect(new Set(entries).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.startsWith("tests/")).toBe(true);
      expect(entry.endsWith(".test.ts")).toBe(true);
    }

    // 构建链脚本是投影面的一部分：把它们误列进"不投影"会让门失去意义。
    for (const script of PROJECTED_SCRIPTS) {
      expect(script.startsWith("scripts/")).toBe(true);
    }
  });
});
