import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// 官方商店自动扫描同款规则集（eslint-plugin-obsidianmd recommended，含类型敏感规则）。
// 本地全绿即商店扫描 findings 的最强先行证据；每次发布前必须跑 `npm run lint`。
export default defineConfig([
  {
    ignores: [
      // 构建构筑物（git-ignored，build-bundle 生成），不是源码。
      "main.js",
      "dist/**",
      // vitest 运行时转译 + mock 生态：obsidianmd 的类型敏感规则在此只会产出
      // 非产品假告警。该豁免也是「测试零类型门」的构成面之一（夜班审计候选
      // #12）；若未来建 tsconfig.test.json，本注释与豁免要同轮复核。
      "tests/**",
      // Node/PS1 工具脚本，不在官方商店的插件源码审核面。
      "scripts/**",
      // 第三方依赖目录。
      "node_modules/**",
      // 会话临时区（与 .tmp 同族）。
      "**/.codex-tmp*/**",
      // 本轮临时产物区（见 AGENTS.md「临时产物」）：不提交，也不是产品代码；
      // 其他会话留在其中的仓库副本不应让发布前 lint 假红。
      ".tmp/**",
      // 登记保留的临时探针／夹具目录（各保留理由见对应开发日志），非产品代码：
      // 独立 .mjs 不在 tsconfig project service 内，纳入会产生解析错误类假告警。
      "outputs/**",
      // 独立配置文件，不在 tsconfig project service 内（与 outputs/** 同理由族）。
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
