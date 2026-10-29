import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Node 环境没有 DOM 全局；补桩见该文件注释（本仓无 jsdom）。
    setupFiles: ["tests/setup/environment-stubs.ts"],
    // 源码形状测试要读大文件并做括号配对，机器负载高时默认 5s 容易假红；
    // 单条用例仍可在 it 上单独覆盖更长的上限。
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/__mocks__/obsidian.ts"),
    },
  },
});
