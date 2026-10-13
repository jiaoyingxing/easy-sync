#!/usr/bin/env node
// 产物构建：把 package.json 的版本烧进 bundle，让运行中的插件能识别自己的代际。
//
// 背景（2026-10-13 野外判读）：vault 里的 manifest.json 与 main.js 可能来自不同
// 安装（同步自身插件文件、商店更新中断、人工替换），此时插件会静默运行旧代码而
// 版本号显示为新版——已修缺陷复活、诊断报告版本字段误导判读。把版本烧进产物后，
// 运行时即可对照「代码内版本」与 manifest 版本（诊断报告技术节），不一致可被看见。
//
// esbuild 选项与原先内联命令逐字等价（JS API 与 CLI 产物已实测逐字节相同），
// 只多一个 --define；值取自 package.json，确定性不变。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);

await build({
  entryPoints: [path.join(root, "src/main.ts")],
  bundle: true,
  external: ["obsidian", "https"],
  format: "cjs",
  target: "es2020",
  outfile: path.join(root, "main.js"),
  define: { __EASY_SYNC_BUILD_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});
