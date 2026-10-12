/**
 * 片⑤ 忽略记忆（「留在本机，不再提醒」）——store 单测。
 *
 * 形状照 `community-plugin-adoption-memory.test.ts`：只接受 canonical 记录、
 * 命令式 reduce、损坏整体降级（要么整份可信、要么整份重新提醒）。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyLocalOnlyIgnoreMemory,
  isLocalOnlyPathIgnored,
  normalizeLocalOnlyIgnorePaths,
  readLocalOnlyIgnoreMemory,
  reduceLocalOnlyIgnoreMemory,
} from "../src/sync/local-only-ignore-memory";

const copyPath = "notes/note（副本 2026-10-11 2345）.md";

describe("local-only ignore memory", () => {
  it("reads only canonical device-local records", () => {
    expect(readLocalOnlyIgnoreMemory(undefined)).toEqual({
      schemaVersion: 1,
      kind: "local-only-ignore-memory",
      ignoredPaths: [],
    });
    // 损坏整体降级（null＝调用方按"全部重新提醒"处理）。
    for (const corrupt of [
      null,
      "nope",
      42,
      [],
      { schemaVersion: 2, kind: "local-only-ignore-memory", ignoredPaths: [] },
      { schemaVersion: 1, kind: "something-else", ignoredPaths: [] },
      {
        schemaVersion: 1,
        kind: "local-only-ignore-memory",
        ignoredPaths: [],
        extra: true,
      },
      // 非 canonical（未排序／重复／未归一）＝损坏，不静默修补。
      {
        schemaVersion: 1,
        kind: "local-only-ignore-memory",
        ignoredPaths: ["b.md", "a.md"],
      },
      {
        schemaVersion: 1,
        kind: "local-only-ignore-memory",
        ignoredPaths: ["a.md", "a.md"],
      },
      {
        schemaVersion: 1,
        kind: "local-only-ignore-memory",
        ignoredPaths: ["/a.md"],
      },
    ]) {
      expect(readLocalOnlyIgnoreMemory(corrupt)).toBeNull();
    }

    expect(readLocalOnlyIgnoreMemory({
      schemaVersion: 1,
      kind: "local-only-ignore-memory",
      ignoredPaths: ["a.md", copyPath],
    })).toEqual({
      schemaVersion: 1,
      kind: "local-only-ignore-memory",
      ignoredPaths: ["a.md", copyPath],
    });
  });

  it("reduces ignore and clear-ignore imperatively", () => {
    const empty = createEmptyLocalOnlyIgnoreMemory();
    const ignored = reduceLocalOnlyIgnoreMemory(empty, {
      type: "ignore",
      path: copyPath,
    });
    expect(ignored.ignoredPaths).toEqual([copyPath]);
    // 重复 ignore 不产生第二份（canonical 去重）。
    expect(reduceLocalOnlyIgnoreMemory(ignored, {
      type: "ignore",
      path: copyPath,
    }).ignoredPaths).toEqual([copyPath]);
    // 归一化后再比较：前后斜杠与空白不产生第二条。
    expect(reduceLocalOnlyIgnoreMemory(ignored, {
      type: "ignore",
      path: `/${copyPath}/`,
    }).ignoredPaths).toEqual([copyPath]);
    expect(isLocalOnlyPathIgnored(ignored, copyPath)).toBe(true);
    expect(isLocalOnlyPathIgnored(ignored, "/notes/other.md")).toBe(false);

    // 移除 API（本片不接界面，供后续拍板后的界面使用）。
    const cleared = reduceLocalOnlyIgnoreMemory(ignored, {
      type: "clear-ignore",
      path: copyPath,
    });
    expect(cleared.ignoredPaths).toEqual([]);
    expect(isLocalOnlyPathIgnored(cleared, copyPath)).toBe(false);
    // 移除不存在的路径＝无变化。
    expect(reduceLocalOnlyIgnoreMemory(cleared, {
      type: "clear-ignore",
      path: "never.md",
    })).toEqual(cleared);
  });

  it("normalizes paths canonically", () => {
    expect(normalizeLocalOnlyIgnorePaths([
      " b.md ",
      "a.md",
      "/a.md",
      "b.md",
      "",
      "/",
      42,
    ])).toEqual(["a.md", "b.md"]);
  });
});
