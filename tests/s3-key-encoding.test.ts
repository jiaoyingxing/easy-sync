import { describe, expect, it } from "vitest";
import {
  assertNoPathCollisions,
  findPathCollisions,
  foldPathIdentity,
  inspectVaultRelativePath,
  isControlPlaneKey,
  isDirectoryPlaceholderKey,
  keyToRelativePath,
  normalizeRootPrefix,
  scopeMarkerKey,
  S3PathConflictError,
  vaultPathToKey,
} from "../src/providers/s3/s3-key";
import { canonicalQueryString, canonicalUri, encodeRfc3986 } from "../src/providers/s3/sigv4";

/**
 * key 编码合同：空格、`#`、`%`、`+`、中文、emoji、大小写；以及 NFC／大小写
 * 折叠冲突 fail-closed、Windows 非法名与 S3 控制前缀排除。
 */
describe("SigV4 编码", () => {
  it("RFC 3986：非保留字符原样，其他字符大写百分号编码", () => {
    expect(encodeRfc3986("AZaz09-._~")).toBe("AZaz09-._~");
    expect(encodeRfc3986("a b#c%d+e中文😀")).toBe(
      "a%20b%23c%25d%2Be%E4%B8%AD%E6%96%87%F0%9F%98%80",
    );
    expect(encodeRfc3986("!*'()")).toBe("%21%2A%27%28%29");
  });

  it("canonicalUri 保留 `/`、空段与大小写，不做双重编码", () => {
    expect(canonicalUri("/A/b C/%+")).toBe("/A/b%20C/%25%2B");
    expect(canonicalUri("//a//b/")).toBe("//a//b/");
    expect(canonicalUri("")).toBe("/");
  });

  it("canonicalQueryString：编码后按 key/value 排序，`+` 不当空格", () => {
    expect(
      canonicalQueryString([
        ["prefix", "中文"],
        ["continuation-token", "a+b/c=="],
      ]),
    ).toBe("continuation-token=a%2Bb%2Fc%3D%3D&prefix=%E4%B8%AD%E6%96%87");
    expect(canonicalQueryString("b=2&a=1&a=0")).toBe("a=0&a=1&b=2");
  });
});

describe("key ↔ 库内路径", () => {
  it("空格／#／%／+／中文／emoji 往返一致", () => {
    const paths = [
      "plain.md",
      "with space.md",
      "hash#tag.md",
      "percent%25.md",
      "plus+sign.md",
      "中文目录/文档.md",
      "emoji😀/file.md",
    ];
    for (const path of paths) {
      const key = vaultPathToKey("Root", path);
      expect(key).toBe(`Root/${path}`);
      expect(keyToRelativePath("Root", key)).toBe(path);
    }
  });

  it("NFC：组合字符与预组合字符映射到同一 key，且反向同构", () => {
    const decomposed = "cafe\u0301.md";
    const composed = "café.md";
    expect(vaultPathToKey("", decomposed)).toBe(composed);
    expect(vaultPathToKey("", composed)).toBe(composed);
    expect(foldPathIdentity(decomposed)).toBe(foldPathIdentity(composed));
    expect(keyToRelativePath("Root", `Root/${decomposed}`)).toBe(composed);
    expect(keyToRelativePath("Root", `Root/${decomposed}`)).toBe(
      keyToRelativePath("Root", `Root/${composed}`),
    );
  });

  it("大小写／NFC 折叠撞车 fail-closed", () => {
    const collisions = findPathCollisions(["Notes/A.md", "notes/a.md", "other.md"]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].paths).toEqual(["Notes/A.md", "notes/a.md"]);
    expect(() => assertNoPathCollisions(["Foo.md", "foo.md"])).toThrow(S3PathConflictError);
    try {
      assertNoPathCollisions(["Foo.md", "foo.md"]);
    } catch (error) {
      expect(error).toBeInstanceOf(S3PathConflictError);
      expect((error as S3PathConflictError).collisions[0].folded).toBe("foo.md");
    }
    expect(findPathCollisions(["unique.md"])).toEqual([]);
  });

  it("控制命名空间与根标记不是用户内容", () => {
    expect(isControlPlaneKey("", ".easy-sync/scope.json")).toBe(true);
    expect(isControlPlaneKey("Root", "Root/.easy-sync/probe/x")).toBe(true);
    expect(isControlPlaneKey("Root", "Root/.easy-sync-scope.json")).toBe(true);
    expect(isControlPlaneKey("Root", "Root/notes/x.md")).toBe(false);
    expect(keyToRelativePath("Root", "Root/.easy-sync/scope.json")).toBeNull();
    expect(scopeMarkerKey("Root")).toBe("Root/.easy-sync/scope.json");
    expect(scopeMarkerKey("")).toBe(".easy-sync/scope.json");
    expect(keyToRelativePath("Root", "Other/x.md")).toBeNull();
  });

  it("目录占位对象：以 / 结尾且 Size=0", () => {
    expect(isDirectoryPlaceholderKey("dir/", 0)).toBe(true);
    expect(isDirectoryPlaceholderKey("dir/")).toBe(true);
    expect(isDirectoryPlaceholderKey("dir/", 1)).toBe(false);
    expect(isDirectoryPlaceholderKey("dir/file", 0)).toBe(false);
  });

  it("根前缀规范化并拒绝控制目录／点段", () => {
    expect(normalizeRootPrefix("/Root/Docs/")).toBe("Root/Docs");
    expect(normalizeRootPrefix("Root\\Docs")).toBe("Root/Docs");
    expect(normalizeRootPrefix("")).toBe("");
    expect(() => normalizeRootPrefix(".easy-sync")).toThrow();
    expect(() => normalizeRootPrefix("Root/../Other")).toThrow();
  });
});

describe("Windows 落盘安全", () => {
  it("保留名（含扩展名与大小写变体）", () => {
    for (const name of ["CON", "con.txt", "PRN.md", "AUX", "NUL.log", "COM1.txt", "lpt9"]) {
      const inspection = inspectVaultRelativePath(name);
      expect(inspection.ok, name).toBe(false);
      expect(inspection.issues.some((issue) => issue.problem === "reserved-name"), name).toBe(true);
    }
  });

  it("非法字符、段尾点／空格、点段、空段", () => {
    expect(inspectVaultRelativePath("a:b.md").issues.some((issue) => issue.problem === "illegal-character")).toBe(true);
    expect(inspectVaultRelativePath("a?b.md").issues.some((issue) => issue.problem === "illegal-character")).toBe(true);
    expect(inspectVaultRelativePath("trailing.").issues.some((issue) => issue.problem === "trailing-dot-or-space")).toBe(true);
    expect(inspectVaultRelativePath("trailing ").issues.some((issue) => issue.problem === "trailing-dot-or-space")).toBe(true);
    expect(inspectVaultRelativePath(".").issues.some((issue) => issue.problem === "dot-segment")).toBe(true);
    expect(inspectVaultRelativePath("..").issues.some((issue) => issue.problem === "dot-segment")).toBe(true);
    expect(inspectVaultRelativePath("a//b.md").issues.some((issue) => issue.problem === "empty-segment")).toBe(true);
  });

  it("单段 UTF-8 超过 255 字节、整路径超过 1024 字节", () => {
    const longSegment = "a".repeat(256);
    expect(
      inspectVaultRelativePath(longSegment).issues.some((issue) => issue.problem === "segment-too-long"),
    ).toBe(true);

    const longPath = Array.from({ length: 6 }, () => "b".repeat(200)).join("/");
    expect(inspectVaultRelativePath(longPath).issues.some((issue) => issue.problem === "key-too-long")).toBe(true);
  });

  it("合法路径通过", () => {
    const inspection = inspectVaultRelativePath("笔记/2026.md");
    expect(inspection.ok).toBe(true);
    expect(inspection.issues).toEqual([]);
  });
});
