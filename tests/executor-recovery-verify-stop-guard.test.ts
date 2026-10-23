import { describe, expect, it } from "vitest";
import { functionBody, readSourceFile } from "./helpers/source-scope";

const EXECUTOR_PATH = "src/sync/sync-executor.ts";
const source = readSourceFile(EXECUTOR_PATH);

function occurrenceIndexes(text: string, needle: string): number[] {
  const indexes: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    indexes.push(index);
    index = text.indexOf(needle, index + needle.length);
  }
  return indexes;
}

function countOccurrences(text: string, needle: string): number {
  return occurrenceIndexes(text, needle).length;
}

/** `open` 指向左括号，返回与之配对的右括号下标；跳过字符串与注释。 */
function matchingDelimiter(
  text: string,
  open: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", i);
      if (lineEnd === -1) break;
      i = lineEnd;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = text.indexOf("*/", i + 2);
      if (commentEnd === -1) break;
      i = commentEnd + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      for (i++; i < text.length; i++) {
        if (text[i] === "\\") {
          i++;
          continue;
        }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (char === openChar) depth++;
    else if (char === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("guard test: unbalanced delimiters");
}

function matchingParen(text: string, open: number): number {
  return matchingDelimiter(text, open, "(", ")");
}

/**
 * `functionBody`（tests/helpers/source-scope.ts）把对象字面量返回类型
 * （`): { ... } {`）的第一个 `{` 当成函数体，于是 `runStep5PrepareExecutablePlan`
 * 只能取到签名与返回类型（772 字符）。这里在同样的「签名 + 括号配对」前提上
 * 继续向后走：跳过返回类型里的类型字面量块（其前一个有效字符是
 * `: | & , ( [ < =`），第一个不满足该条件的 `{` 才是方法正文。
 */
function methodBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start === -1) {
    throw new Error(`methodBody: 源码里找不到签名 ${JSON.stringify(signature)}`);
  }
  const paramsOpen = start + signature.length - 1;
  const paramsClose = matchingParen(text, paramsOpen);
  let i = paramsClose + 1;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      const lineEnd = text.indexOf("\n", i);
      if (lineEnd === -1) break;
      i = lineEnd;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = text.indexOf("*/", i + 2);
      if (commentEnd === -1) break;
      i = commentEnd + 1;
      continue;
    }
    if (char === "{") {
      let previous = i - 1;
      while (previous > paramsClose && /\s/.test(text[previous])) previous--;
      if (!":|&,([<=".includes(text[previous])) {
        const close = matchingDelimiter(text, i, "{", "}");
        return text.slice(start, close + 1);
      }
      i = matchingDelimiter(text, i, "{", "}") + 1;
      continue;
    }
    i++;
  }
  throw new Error(`methodBody: ${JSON.stringify(signature)} 后没有正文块`);
}

/** 只数顶层的逗号：嵌套括号/花括号/数组里的逗号都属于同一个实参。
 *  末尾的尾逗号（`downloaded,` 后直接收参）不算新实参。 */
function countTopLevelArguments(argumentText: string): number {
  let depth = 0;
  let count = 1;
  let quote: string | null = null;
  for (let i = 0; i < argumentText.length; i++) {
    const char = argumentText[i];
    if (quote !== null) {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) count++;
  }
  if (argumentText.trimEnd().endsWith(",")) count--;
  return count;
}

// C1-3(账本 §七):恢复核验 N1 主循环此前只在迭代尾检查 shouldStop,
// 取消请求要等整轮下载+哈希+核验跑完才被响应;N2 侧循环顶部即检查。
// 守卫钉住 N1 循环体首行与 N2 同形(纯行号漂移无关)。
describe("recovery verification loop stop checks", () => {
  it("N1 verification loop checks shouldStop before the first download", () => {
    expect(source).toContain(
      "for (const { node, path } of verificationCandidates) {\n      if (this.shouldStop(result, operationEpoch)) return result;",
    );
  });
});

// B7:每个「可执行计划咽喉」都必须先跑社区插件保护，再跑 EasySync 自同步保护。
// 四个入口 = 普通计划 / 文件夹移动续跑 / corrupt-state 恢复 / remote-scope 恢复。
// 残余（有意记录）：本闸只审计「调用了 protectCommunityPluginPlan 的入口」；
// 未来若新增一个完全跳过该保护的入口，本闸不会知道 —— 它钉的是当前四处，
// 不是「所有入口都被覆盖」的语义证明。
describe("community plugin plan protection gate", () => {
  const entries = [
    "private runStep5PrepareExecutablePlan(",
    "private async sealAndRunStagedFolderMoveContinuation(",
    "private async runV2CorruptStateEvidenceCollection(",
    "private async runV2RemoteScopeRecovery(",
  ] as const;

  it("every audited plan entry wraps plugin protection in self-sync protection", () => {
    for (const signature of entries) {
      // functionBody 只能处理返回类型不含对象字面量的声明；第一个入口的
      // 返回类型是 `{ ... } | { ... }`，用 methodBody 补上。
      const body = signature === "private runStep5PrepareExecutablePlan("
        ? methodBody(source, signature)
        : functionBody(source, signature);
      expect(
        countOccurrences(body, "protectEasySyncSelfSyncPlan("),
        `${signature} must call protectEasySyncSelfSyncPlan`,
      ).toBe(1);
      expect(
        countOccurrences(body, "protectCommunityPluginPlan("),
        `${signature} must call protectCommunityPluginPlan`,
      ).toBe(1);
    }
  });

  it("every protectCommunityPluginPlan call sits lexically inside a protectEasySyncSelfSyncPlan call", () => {
    const wrapper = "protectEasySyncSelfSyncPlan(";
    const pluginCalls = occurrenceIndexes(source, "protectCommunityPluginPlan(");
    expect(pluginCalls).toHaveLength(entries.length);

    for (const callAt of pluginCalls) {
      const wrapperAt = source.lastIndexOf(wrapper, callAt);
      expect(wrapperAt, `no protectEasySyncSelfSyncPlan before offset ${callAt}`)
        .toBeGreaterThanOrEqual(0);
      const wrapperClose = matchingParen(source, wrapperAt + wrapper.length - 1);
      expect(callAt).toBeGreaterThan(wrapperAt);
      expect(callAt, "protectCommunityPluginPlan call must be inside the wrapper")
        .toBeLessThan(wrapperClose);
    }
  });
});

// D10:降级路由按类型判断，不再按用户可见文案做字符串匹配。
// 消息本身必须逐字不变：error-presentation.ts 依赖前缀本地化，
// tests/error-presentation.test.ts 已有逐字钉子。
describe("community plugin downgrade error routing", () => {
  it("throws a typed downgrade error whose message stays byte-identical", () => {
    const preflight = functionBody(source, "private async assertCommunityPluginUploadPreflight(");
    expect(preflight).toContain("throw new CommunityPluginBundleDowngradeError(pluginId);");
    expect(source).toContain(
      "class CommunityPluginBundleDowngradeError extends Error {",
    );
    expect(source).toContain(
      "super(`Selected plugin upload would downgrade remote bundle: ${pluginId}`);",
    );
  });

  it("routes recovery downgrades by type, not by message text", () => {
    const routing = functionBody(
      source,
      "private async deferPersistedPluginUploadDowngradeToReview(",
    );
    expect(routing).toContain(
      "downgradeError instanceof CommunityPluginBundleDowngradeError",
    );
    expect(routing).not.toContain(
      '.includes("Selected plugin upload would downgrade remote bundle")',
    );
    expect(routing).not.toContain("this.failureReason(preflightError)");
  });
});

// D11:verifyDownloadedPayload 的第四个参数表示「远端版本已由调用方核验过」。
// 本闸钉住恢复链唯一的 `(path, remote, downloaded, true)` 字面调用在
// restoreReceiptedUploadLocal 内。现役代码另有三个既有的 true 调用
// （2026-08-09 批次预取 / 冲突裁决替换两处），各自在调用前已完成远端身份
// 核验；本闸把它们连同前置条件一起钉住，任何新增的四参调用都会当场红。
// 本闸保护当前四处有据可依的 true 调用，不构成「第四参永远只为 true 于这
// 四处」的语义证明。
describe("verifyDownloadedPayload remote-version bypass gate", () => {
  const specialCall = "verifyDownloadedPayload(path, remote, downloaded, true)";
  const compactBatchCall =
    "verifyDownloadedPayload(item.path,item.remote!,prepared[index].downloaded!,true,)";
  const compactReviewedCall =
    "verifyDownloadedPayload(path,queuedConflict.remote!,{size:content.byteLength,hash},true,)";

  it("has exactly one restore-literal call and it lives in restoreReceiptedUploadLocal", () => {
    expect(countOccurrences(source, specialCall)).toBe(1);
    const restore = functionBody(
      source,
      "private async restoreReceiptedUploadLocal(",
    );
    expect(restore).toContain(specialCall);
  });

  it("all other calls pass three arguments; each audited true call keeps its precondition", () => {
    const declarationAt = source.indexOf(
      "private async verifyDownloadedPayload(",
    );
    expect(declarationAt).toBeGreaterThanOrEqual(0);
    const declarationNameAt = declarationAt + "private async ".length;
    const calls = occurrenceIndexes(source, "verifyDownloadedPayload(")
      .filter((index) => index !== declarationNameAt);
    expect(calls.length).toBeGreaterThan(0);

    const fourArgumentKinds: string[] = [];
    for (const callAt of calls) {
      const open = callAt + "verifyDownloadedPayload".length;
      const close = matchingParen(source, open);
      const call = source.slice(callAt, close + 1);
      const argumentCount = countTopLevelArguments(
        source.slice(open + 1, close),
      );
      if (argumentCount === 4) {
        const compact = call.replace(/\s+/g, "");
        const before = source.slice(Math.max(0, callAt - 1000), callAt);
        if (compact === "verifyDownloadedPayload(path,remote,downloaded,true)") {
          fourArgumentKinds.push("restore-receipted");
        } else if (compact === compactBatchCall) {
          fourArgumentKinds.push("batch-metadata-verified");
          expect(
            before,
            "batch true call must follow a batch identity verification",
          ).toContain(
            "refreshedMetadataMatchesIdentity(current, item.remote!.driveId, item.remote!.eTag)",
          );
        } else if (compact === compactReviewedCall) {
          fourArgumentKinds.push("reviewed-remote-version");
          expect(
            before,
            "reviewed true call must follow guardReviewedRemoteVersion",
          ).toContain(
            'guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict")',
          );
        } else {
          fourArgumentKinds.push(`unexpected: ${compact}`);
        }
      } else {
        expect(argumentCount, `unexpected argument count at offset ${callAt}`)
          .toBe(3);
      }
    }
    expect(fourArgumentKinds.sort()).toEqual([
      "batch-metadata-verified",
      "restore-receipted",
      "reviewed-remote-version",
      "reviewed-remote-version",
    ]);
  });
});
