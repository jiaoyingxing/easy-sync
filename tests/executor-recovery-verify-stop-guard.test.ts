import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// C1-3(账本 §七):恢复核验 N1 主循环此前只在迭代尾检查 shouldStop,
// 取消请求要等整轮下载+哈希+核验跑完才被响应;N2 侧循环顶部即检查。
// 守卫钉住 N1 循环体首行与 N2 同形(纯行号漂移无关)。
describe("recovery verification loop stop checks", () => {
  it("N1 verification loop checks shouldStop before the first download", () => {
    const source = readFileSync("src/sync/sync-executor.ts", "utf8");
    expect(source).toContain(
      "for (const { node, path } of verificationCandidates) {\n      if (this.shouldStop(result, operationEpoch)) return result;",
    );
  });
});
