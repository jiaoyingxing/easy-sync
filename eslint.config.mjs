import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// 官方商店自动扫描同款规则集（eslint-plugin-obsidianmd recommended，含类型敏感规则）。
// 本地全绿即商店扫描 findings 的最强先行证据；每次发布前必须跑 `npm run lint`。
export default defineConfig([
  {
    ignores: [
      "main.js",
      "dist/**",
      "tests/**",
      "scripts/**",
      "node_modules/**",
      "**/.codex-tmp*/**",
      "vitest.config.ts",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    // 该文件是诊断日志的输出端：console 镜像输出即其功能本身（桌面调试与
    // 导出报告依赖），不属于指南针对的"无谓散落日志"。官方 no-console 的
    // 自定义包装按文件粒度关闭，经行内禁用不可行（restricted-disable）。
    files: ["src/sync/diagnostic-logger.ts"],
    rules: { "obsidianmd/rule-custom-message": "off" },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
      },
    },
  },
]);
