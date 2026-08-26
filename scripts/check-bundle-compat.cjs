// 产物兼容门：防止 main.js 携带旧版 WKWebView / JavaScriptCore 无法解析的较新语法。
//
// 背景（2026-08-25，GitHub issue #13）：esbuild 在未显式指定 --target 时会隐式读取
// tsconfig.json 的 "target": "ES2020"，而该路径下对类静态字段的降级会生成 ES2022 的
// class static initialization block（`static { ... }`）。iOS 15.5 的 WKWebView
// （Safari 15.5 内核）无法解析该语法 → 整个 main.js 解析失败 → Obsidian 仅报
// "plugin failed to load"。构建命令现显式声明 --target=es2020（产物为严格 ES2020
// 语法子集），本脚本作为防回归门：产物中出现 `static {` 即构建失败。
//
// 用法：由 `npm run build` 末尾调用；也可单独执行 `node scripts/check-bundle-compat.cjs`。

const fs = require("fs");
const path = require("path");

const bundlePath = path.join(__dirname, "..", "main.js");
if (!fs.existsSync(bundlePath)) {
  console.error(`[check-bundle-compat] FAIL: bundle not found: ${bundlePath}`);
  process.exit(1);
}

const code = fs.readFileSync(bundlePath, "utf8");

const staticBlockMatches = code.match(/static\s*\{/g);
if (staticBlockMatches && staticBlockMatches.length > 0) {
  const first = code.indexOf("static {");
  const line = code.slice(0, first).split("\n").length;
  console.error(
    `[check-bundle-compat] FAIL: bundle contains class static initialization block (` +
      `ES2022 syntax, not parseable by iOS 15.x WKWebView) at main.js:${line}. ` +
      `Class static fields are lowered to plain assignments under --target=es2020; ` +
      `a literal \`static {}\` block in source or an esbuild behavior change is the likely cause.`
  );
  process.exit(1);
}

console.log(
  `[check-bundle-compat] OK: ${path.basename(bundlePath)} (${code.length} bytes), ` +
    `no class static initialization block, ES2020 syntax floor enforced.`
);