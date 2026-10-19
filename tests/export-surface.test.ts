import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 2026-10-16（批次① 导出面收敛，用户已拍板）：源码仓的"对外门牌"防回流门。
 *
 * 背景：全仓审计与历史遗留轮实测发现 302 个"只在自己文件里被引用"的导出
 * （值级 35 ＋ 类型级 267，散在 107 个文件）。它们不影响行为（类型编译后消失），
 * 但让"这个模块对外提供什么"变得模糊，后来人（含 AI）会误判依赖关系。
 * 2026-10-16 已按证据全部摘除 `export`；本门防止它再长回去：**任何 `src/**`
 * 里的导出，必须在定义文件之外的某个代码文件里出现过**。
 *
 * 判据边界（刻意保守，与审计口径一致）：
 * - 扫描面＝`src` ＋ `tests` ＋ `scripts` 的代码文件（`.ts/.js/.mjs/.cjs`）。
 *   `docs/**` 不算代码依赖：文档提到一个符号名不构成"需要继续导出"。
 * - "出现过"＝按标识符词法匹配。名字出现在别的文件的注释或字符串里也算"出现过"
 *   ⇒ 本门偏向**少报**（不会因为评论里的名字而误红），代价是极少数真冗余可能漏网。
 * - `export default`、`export * from`、`export { X } from` 三类是模块对外面的一部分，
 *   不在本门判据内（前两类没有本地名字，第三类是显式再导出）。
 */

const SURFACE_ROOTS = ["src", "tests", "scripts"];
const CODE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);
const EXPORT_DECLARATION =
  /^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}[ \t]*(from\s+[^;]+)?;/gm;

interface SourceFile {
  path: string;
  text: string;
}

/** 递归列出扫描面代码文件（相对仓库根的 `/` 分隔路径）。 */
function listCodeFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(relativeDir)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const relative = path.posix.join(relativeDir, entry);
      const stats = statSync(relative);
      if (stats.isDirectory()) walk(relative);
      else if (CODE_EXTENSIONS.has(path.extname(entry))) {
        files.push({ path: relative, text: readFileSync(relative, "utf8") });
      }
    }
  };
  for (const root of SURFACE_ROOTS) walk(root);
  return files;
}

function identifiersOf(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z_$][\w$]*/g)) found.add(match[0]);
  return found;
}

/** 抽出某文件里"本地导出"的名字（跳过 `export default` 与各类再导出）。 */
function localExportNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(EXPORT_DECLARATION)) names.push(match[1]);
  for (const match of source.matchAll(EXPORT_LIST)) {
    if (match[2]) continue; // `export { X } from "..."` 是再导出，不判
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const local = trimmed.includes(" as ")
        ? trimmed.split(/\s+as\s+/)[1].trim()
        : trimmed;
      names.push(local);
    }
  }
  return names;
}

/** 只被自己文件引用的导出（门与合成控制项共用同一个实现）。 */
function findSelfOnlyExports(files: SourceFile[]): Array<{ file: string; name: string }> {
  const identifiersByFile = new Map(
    files.map((file) => [file.path, identifiersOf(file.text)]),
  );
  const offenders: Array<{ file: string; name: string }> = [];
  for (const file of files) {
    if (!file.path.startsWith("src/")) continue;
    for (const name of localExportNames(file.text)) {
      let referencedElsewhere = false;
      for (const [other, identifiers] of identifiersByFile) {
        if (other === file.path) continue;
        if (identifiers.has(name)) {
          referencedElsewhere = true;
          break;
        }
      }
      if (!referencedElsewhere) offenders.push({ file: file.path, name });
    }
  }
  return offenders;
}

describe("export surface gate", () => {
  // 超时分档（2026-10-17，B12 时基健康）：本条是**整仓扫描型**门——同步遍历
  // `src`＋`tests`＋`scripts`（实测 424 个代码文件 / 9.78 MiB）并做两两标识符集合比对。
  // 耗时由仓库规模与磁盘／杀软负载决定，不属判据；默认 5s 在机器忙时会被纯 I/O
  // 吃掉，于是出现"与断言无关的假红"。给 30s 余量（实测 0.37s 轻载／0.65–0.77s
  // 全量或并行负载，余量 ≳39x）。
  it("keeps every src export referenced outside its own file", () => {
    const files = listCodeFiles();
    const offenders = findSelfOnlyExports(files);

    // 一条都不用"提醒"，直接给出文件与符号名，便于当场决定归属。
    expect(offenders).toEqual([]);

    // 反假绿（《测试与检查规范》§2）：本门判的是"没发现违规"，必须证明扫描面
    // 与探测器都真的在工作，否则目录改名／正则写坏都会让门静默变绿。
    const srcFiles = files.filter((file) => file.path.startsWith("src/"));
    expect(srcFiles.length).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(250);
    const extracted = srcFiles.reduce(
      (total, file) => total + localExportNames(file.text).length,
      0,
    );
    expect(extracted).toBeGreaterThan(500);
    // 探测器实证：一个确实跨文件使用的导出不得被判违规。
    expect(
      offenders.some((offender) => offender.name === "SyncExecutor"),
    ).toBe(false);
  }, 30_000);

  it("flags a self-only export on synthetic input (mechanism proof)", () => {
    const synthetic: SourceFile[] = [
      {
        path: "src/synthetic-owner.ts",
        text: [
          "export interface ExportSurfaceGateProbeOnlyHere { a: string }",
          "export interface ExportSurfaceGateProbeUsedElsewhere { b: string }",
          "const localOnly = 1;",
          "export { localOnly };",
        ].join("\n"),
      },
      {
        path: "tests/synthetic-consumer.test.ts",
        text: [
          'import type { ExportSurfaceGateProbeUsedElsewhere } from "../src/synthetic-owner";',
          "const probe: ExportSurfaceGateProbeUsedElsewhere = { b: \"x\" };",
        ].join("\n"),
      },
    ];

    const offenders = findSelfOnlyExports(synthetic);

    expect(offenders).toEqual([
      { file: "src/synthetic-owner.ts", name: "ExportSurfaceGateProbeOnlyHere" },
      { file: "src/synthetic-owner.ts", name: "localOnly" },
    ]);
  });
});
