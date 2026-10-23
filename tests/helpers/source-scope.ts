import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * 按解析后的绝对路径缓存源码文本。
 *
 * 一次测试运行里源码是只读的，同一文件被几十个断言反复读取没有意义；
 * 用绝对路径作键，让 `src/main.ts` 与 `./src/main.ts` 命中同一份。
 */
const SOURCE_TEXT_CACHE = new Map<string, string>();

/** 读仓库内文本（按仓库根相对路径书写，测试里不出现绝对路径）。 */
export function readSourceFile(relativePath: string): string {
  const absolutePath = resolve(REPO_ROOT, relativePath);
  const cached = SOURCE_TEXT_CACHE.get(absolutePath);
  if (cached !== undefined) return cached;
  const source = readFileSync(absolutePath, "utf8");
  SOURCE_TEXT_CACHE.set(absolutePath, source);
  return source;
}

/**
 * 取 `signature` 首次出现处所属的那一整个花括号块（含签名本身）。
 *
 * 用途：把「整个文件里含某段文字」的粗断言收窄成「这个函数体里含某段文字」。
 * 后者才挡得住「同一个词在同一文件别处也出现，于是删掉真正那一处、断言照样绿」。
 *
 * 语义与边界：
 * - 括号配对忽略字符串、模板串、注释与正则字面量里的花括号；
 * - 签名必须出现在行首（只允许前置空白）⇒ 只认声明，不认调用点；
 * - 签名与开括号之间出现 `;` 或 `}` ⇒ 说明这不是函数头，直接抛错
 *   （防止「签名写错了但恰好匹配到调用点」，那会让收窄静默退化成空断言）；
 * - 找不到签名、或括号不配平 ⇒ 抛错。测试应当当场红，而不是悄悄放行。
 */
export function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`functionBody: 源码里找不到签名 ${JSON.stringify(signature)}`);
  }
  if (!isAtLineStart(source, start)) {
    throw new Error(
      `functionBody: ${JSON.stringify(signature)} 不在行首（多半命中调用点而非声明）`,
    );
  }
  const afterSignature = start + signature.length;
  const open = findBlockOpen(source, afterSignature, parenBalance(signature));
  if (open === -1) {
    throw new Error(
      `functionBody: 签名 ${JSON.stringify(signature)} 后面没有找到代码块起始 '{'`,
    );
  }
  if (open === -2) {
    throw new Error(
      `functionBody: ${JSON.stringify(signature)} 是调用点而不是函数头（括号外先出现语句结束符）`,
    );
  }
  const end = findBlockEnd(source, open);
  return source.slice(start, end);
}

function isAtLineStart(source: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const char = source[i];
    if (char === " " || char === "\t") continue;
    return char === "\n" || char === "\r";
  }
  return true;
}

/** 签名自身的圆括号收支：签名通常以 `(` 收尾，于是参数表内部的 `{`（内联对象类型）不算函数体。 */
function parenBalance(signature: string): number {
  let depth = 0;
  for (const char of signature) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
  }
  return depth;
}

/**
 * 从签名之后找「函数体」那个 `{`：参数表内部的 `{` 不算。
 * 返回 `-1`＝扫到文件尾也没找到；`-2`＝括号外先撞上 `;` 或 `}`（即这不是函数头）。
 */
function findBlockOpen(source: string, from: number, parenDepthAtStart: number): number {
  let parenDepth = parenDepthAtStart;
  for (let i = from; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", i);
      if (lineEnd === -1) return -1;
      i = lineEnd;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", i + 2);
      if (commentEnd === -1) return -1;
      i = commentEnd + 1;
      continue;
    }
    if (char === "/" && startsRegexLiteral(source, i)) {
      i = skipRegexLiteral(source, i);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      i = skipQuoted(source, i);
      continue;
    }
    if (char === "(") {
      parenDepth++;
      continue;
    }
    if (char === ")") {
      parenDepth--;
      continue;
    }
    if (parenDepth > 0) continue;
    if (char === "{") return i;
    if (char === "}" || char === ";") return -2;
  }
  return -1;
}

function findBlockEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", i);
      if (lineEnd === -1) break;
      i = lineEnd;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", i + 2);
      if (commentEnd === -1) {
        throw new Error("functionBody: 注释没有闭合，无法确定代码块边界");
      }
      i = commentEnd + 1;
      continue;
    }
    if (char === "/" && startsRegexLiteral(source, i)) {
      i = skipRegexLiteral(source, i);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      i = skipQuoted(source, i);
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) break;
    }
  }
  throw new Error("functionBody: 花括号不配平，无法确定代码块边界");
}

/** 前一个有效字符决定 `/` 是正则字面量起点还是除号。 */
function startsRegexLiteral(source: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const char = source[i];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") continue;
    return "([{,;:=!&|?+-*%~^<>".includes(char);
  }
  return true;
}

function skipRegexLiteral(source: string, at: number): number {
  let inClass = false;
  for (let i = at + 1; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "\n") break;
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "]") {
      inClass = false;
      continue;
    }
    if (char === "/" && !inClass) return i;
  }
  throw new Error("functionBody: 正则字面量没有闭合，无法确定代码块边界");
}

function skipQuoted(source: string, at: number): number {
  const quote = source[at];
  for (let i = at + 1; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === quote) return i;
  }
  throw new Error(`functionBody: ${quote} 字符串没有闭合，无法确定代码块边界`);
}
