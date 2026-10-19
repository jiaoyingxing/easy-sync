import { describe, expect, it } from "vitest";
import { functionBody, readSourceFile } from "./helpers/source-scope";

const SYNTHETIC = [
  "// 头注释",
  "function tricky(input: { a: number }) {",
  '  const text = "撑住 } 花括号";',
  "  const single = '} 也不算';",
  "  const tpl = `模板 ${1 + 2} 里的 } 也不算`;",
  "  // 行注释里的 } 不算",
  "  /* 块注释里的 { 与 } 都不算 */",
  "  const re = /[{}]/;",
  "  if (text) return tpl + single + re.source + String(input.a);",
  "}",
  "function 后面这个不该被吃进来() { return 1; }",
].join("\n");

describe("测试侧源码范围助手", () => {
  it("按花括号配对取整段函数体，并在函数结束处停住", () => {
    const body = functionBody(SYNTHETIC, "function tricky(");
    expect(body).toBe(SYNTHETIC.split("\n").slice(1, 10).join("\n"));
    expect(body).not.toContain("后面这个不该被吃进来");
  });

  it("字符串、模板串、注释、正则里的花括号都不参与配对", () => {
    // 机制自证：只数花括号的朴素取法会在字符串里的 `}` 处提前闭合，
    // 于是丢掉函数体尾部的语句；本助手必须能看出这个差别。
    const naive = (() => {
      const open = SYNTHETIC.indexOf("{", SYNTHETIC.indexOf("function tricky("));
      let depth = 0;
      for (let i = open; i < SYNTHETIC.length; i++) {
        if (SYNTHETIC[i] === "{") depth++;
        else if (SYNTHETIC[i] === "}") {
          depth--;
          if (depth === 0) return SYNTHETIC.slice(0, i + 1).slice(open);
        }
      }
      return "";
    })();
    expect(naive).not.toContain("String(input.a)");
    const body = functionBody(SYNTHETIC, "function tricky(");
    expect(body).toContain("String(input.a)");
    expect(body.endsWith("}")).toBe(true);
    expect(body.trim().split("\n")).toHaveLength(9);
  });

  it("多行签名（真实写法）同样能取到完整函数体", () => {
    const source = [
      "export function wide(",
      "  first: string,",
      "  second: { nested: number },",
      "): string {",
      "  return `${first}${second.nested}`;",
      "}",
      "const 尾巴 = 1;",
    ].join("\n");
    const body = functionBody(source, "export function wide(");
    expect(body).toContain("return `${first}${second.nested}`;");
    expect(body).not.toContain("尾巴");
  });

  it("签名不存在、签名不是行首声明、括号不配平时一律抛错", () => {
    expect(() => functionBody(SYNTHETIC, "function 没有这个函数("))
      .toThrow(/找不到签名/);
    // 调用点：签名出现在行中间 ⇒ 必须拒绝，否则收窄会静默变成空断言。
    const callSite = [
      "const value = tricky({ a: 1 });",
      "function tricky(input: { a: number }) { return input.a; }",
    ].join("\n");
    expect(() => functionBody(callSite, "tricky("))
      .toThrow(/不在行首/);
    expect(() => functionBody("function broken() { if (true) {", "function broken("))
      .toThrow(/不配平/);
  });

  it("能直接用在真实源码上：取到的只是那一段，不是整个文件", () => {
    const source = readSourceFile("src/main.ts");
    const body = functionBody(source, "private acquireOpLock(");
    expect(body).toContain("this.syncView?.render();");
    expect(body.length).toBeLessThan(2_000);
    expect(body.length).toBeGreaterThan(80);
    expect(source.length).toBeGreaterThan(body.length * 50);
  });
});
