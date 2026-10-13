#!/usr/bin/env node
// 发布产物压缩（release minification）：构建后对 main.js / styles.css 做保守后处理。
//
// 口径来源：obsidian-plugin-release-protection skill 的 references/release-minification.md
// 与 scripts/release-artifact-minify.mjs（2026-10-14 对账：同源产物 main.js 3,261,681→1,704,002B、
// styles.css 45,237→28,304B；隔离实例宿主验证通过，官方插件槽 49–59ms vs 未压缩 73ms）。
// 机制落仓内的原因：技能脚本经 %USERPROFILE%\.codex（junction 到 D:\.codex）调用时入口判定
// 会静默跳过（exit 0、零输出），不能作为构建链的依赖；且构建应只依赖本仓。
//
// 位置：必须排在「bundle 产出之后、check-bundle-compat 之前」——兼容门要检查最终形态产物。
// 边界：只做保守压缩（空白/语法/标识符 + legalComments:none + charset:utf8），不做混淆、
// 不加密字符串、不改属性名；开发调试走 src 与测试，不依赖可读产物。
// 只处理 main.js：它是构建产物；本仓 styles.css 是手写源文件（就地压缩会改源码并打破
// 4 个测试文件的 CSS 形断言，2026-10-14 实测）。CSS 压缩若要做，需先把 styles.css 改为
// 「源在别处、根文件由构建生成」，或只在部署/发布时压副本——登记为待办，不在本轮。
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const JS_CONFIG = Object.freeze({
  loader: "js",
  target: "es2020",
  format: "cjs",
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: "none",
  charset: "utf8",
  keepNames: false
});

const targets = [{ file: path.join(root, "main.js"), config: JS_CONFIG }];

const byteLength = (text) => new TextEncoder().encode(text).byteLength;
let saved = 0;

for (const target of targets) {
  try {
    await stat(target.file);
  } catch {
    console.error(`[minify-release] missing artifact: ${path.relative(root, target.file)} (run the bundle step first)`);
    process.exit(1);
  }
  const source = await readFile(target.file, "utf8");
  const { code } = await transform(source, target.config);
  const before = byteLength(source);
  const after = byteLength(code);
  saved += Math.max(0, before - after);
  if (!dryRun && code !== source) {
    await writeFile(target.file, code, "utf8");
  }
  console.log(
    `[minify-release] ${path.basename(target.file)}: ${before}B -> ${after}B ` +
      `(saved ${before - after}B)${dryRun ? " [dry-run]" : ""}`
  );
}

console.log(`[minify-release] ${dryRun ? "checked" : "applied"} ${targets.length} file(s), saved ${saved}B total`);
