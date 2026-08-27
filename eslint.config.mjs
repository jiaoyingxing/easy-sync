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
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
      },
    },
  },
]);
