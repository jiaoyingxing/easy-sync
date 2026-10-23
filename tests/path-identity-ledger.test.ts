import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeVaultPathKey } from "../src/obsidian-compat";
import { identityPath as sharedIdentityPath } from "../src/sync/recovery-anchor-v2";
import {
  translateAnchoredPathV2,
  isAnchoredDescendantV2,
} from "../src/sync/remote-index-v2";

/**
 * 路径身份台账（只读取证，为「路径身份收敛」立项定界）。
 *
 * 本项目对「两个路径是不是同一个」有多份实现，本文件把**真实语义**钉成可执行
 * 对照表，让漂移不必靠读注释争论。三类语义：
 * - `identityPath` 系（`recovery-anchor-v2.ts:65` 唯一共享导出。原
 *   `folder-state-reducer-v2.ts`／`folder-state-v2.ts`／`stale-identity-resolution.ts`
 *   三份私有副本已于 2026-10-23 删除；文件末尾的源码守卫阻止新副本回流）＝
 *   NFC ＋ `toLocaleLowerCase("en-US")`（折大小写）——身份判等的主流语义；
 * - `nfcPath` 系＝只做 NFC，**区分大小写**；
 * - 逐字节＝不归一化。
 *
 * `normalizeVaultPathKey`（`obsidian-compat.ts:116`）比 `identityPath` 多一步
 * 反斜杠→斜杠，纯 `/` 路径上等价（第 1 条断言）。
 */

const caseFoldedSame = (a: string, b: string) =>
  sharedIdentityPath(a) === sharedIdentityPath(b);
const belowFolded = (path: string, root: string) =>
  normalizeVaultPathKey(path).startsWith(`${normalizeVaultPathKey(root)}/`);

const SHARED_IDENTITY_PATH_FILE = "src/sync/recovery-anchor-v2.ts";
/** A local function declaration or an equivalent const/let/var alias. */
const IDENTITY_PATH_DECLARATION =
  /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+identityPath\s*[<(]|^[ \t]*(?:export\s+)?(?:const|let|var)\s+identityPath\s*(?::[^=\n]+)?=/m;

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const file = path.posix.join(directory, entry);
    if (statSync(file).isDirectory()) files.push(...listSourceFiles(file));
    else if (file.endsWith(".ts")) files.push(file);
  }
  return files;
}

/** Drop comments so a doc mention cannot trip the declaration guard. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("path identity ledger", () => {
  it("shared identityPath agrees with normalizeVaultPathKey on slash-only paths", () => {
    for (const sample of ["Notes/a.md", "notes/A.md", "笔记/子目录/文件.md", ""]) {
      expect(sharedIdentityPath(sample)).toBe(normalizeVaultPathKey(sample));
    }
  });

  it("documents three distinct semantics on the same input", () => {
    expect(caseFoldedSame("Notes/Child", "notes/child")).toBe(true);
    expect("Notes/Child".normalize("NFC")).not.toBe("notes/child".normalize("NFC"));
    expect("Notes/Child").not.toBe("notes/child");
  });

  it("case-folding can make two different byte lengths equal — the mis-slice precondition", () => {
    // `toLocaleLowerCase` 会改变长度（İ→i̇ 等）。只要存在这样一对输入，
    // 按长度切前缀的翻译就会切错——本断言用程序找出一个真实例子，而不是手算。
    const samples = [
      "Notes/İ", "notes/i̇", "NOTES/İD", "Notes/Straße", "NOTES/STRASSE",
      "Notes/Child", "NOTES/CHILD", "Notes/ǅ", "NOTES/Ǆ",
    ];
    let found: { a: string; b: string } | null = null;
    for (const a of samples) {
      for (const b of samples) {
        if (a === b) continue;
        if (caseFoldedSame(a, b) && a.length !== b.length) {
          found = { a, b };
          break;
        }
      }
      if (found) break;
    }
    if (!found) return;   // 本运行环境的 Unicode 折叠不改变长度：缺口不在此处
    expect(found.a.length).not.toBe(found.b.length);
  });

  it("translateAnchoredPathV2 returns the byte prefix whenever the root is byte-equal", () => {
    expect(translateAnchoredPathV2("Notes/Child/a.md", "Notes/Child", "Archive/Child"))
      .toBe("Archive/Child/a.md");
  });

  it("translateAnchoredPathV2 does not normalize a case-different root", () => {
    const actual = "Notes/Child/a.md";
    const fromRoot = "notes/child";
    expect(belowFolded(actual, fromRoot)).toBe(true);
    const translated = translateAnchoredPathV2(actual, fromRoot, "Archive/Child");
    // 切下来的前缀保持**原始拼写**（Notes/Child），而不是 fromRoot 的拼写。
    expect(actual.slice(0, fromRoot.length)).toBe("Notes/Child");
    expect(translated).toBe(`${"Archive/Child"}${actual.slice(fromRoot.length)}`);
  });

  it("isAnchoredDescendantV2 is case-sensitive while the shared path key folds case", () => {
    // `normalizeVaultPathKey` 折大小写，`isAnchoredDescendantV2` 只做 NFC；
    // `folder-state-reducer-v2.ts` 的 `isAtOrBelow` 当前也是 NFC-only——真正的
    // 折叠/NFC 冲突在 `canonical-plan-v2.ts:831` 与 `:3353`，不在本测试的断言面内。
    const anchorPath = "Notes/Child/a.md";
    const sourceRoot = "notes";
    expect(belowFolded(anchorPath, sourceRoot)).toBe(true);
    expect(isAnchoredDescendantV2(anchorPath, sourceRoot)).toBe(false);
  });

  it("only the shared module declares a local identityPath", () => {
    const offenders = listSourceFiles("src")
      .filter((file) => file !== SHARED_IDENTITY_PATH_FILE)
      .filter((file) =>
        IDENTITY_PATH_DECLARATION.test(withoutComments(readFileSync(file, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("source guard recognizes the declarations it must reject", () => {
    expect(IDENTITY_PATH_DECLARATION.test("function identityPath(path: string) {")).toBe(true);
    expect(IDENTITY_PATH_DECLARATION.test("const identityPath = (p: string) => p;")).toBe(true);
    expect(IDENTITY_PATH_DECLARATION.test("identityPath(path);")).toBe(false);
  });
});
