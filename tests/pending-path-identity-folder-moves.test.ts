import { describe, expect, it } from "vitest";
import {
  createEmptyPendingPathIdentityFolderMoves,
  normalizePendingPathIdentityFolderMoves,
  pendingPathIdentityFolderMoveKey,
  readPendingPathIdentityFolderMoves,
  type PendingPathIdentityFolderMoveV1,
} from "../src/sync/pending-path-identity-folder-moves";

const scope = {
  accountId: "account-a",
  driveId: "https://webdav.test",
  vaultFolderId: "/",
  filesRootId: "/",
  providerKind: "webdav" as const,
  endpointId: "https://webdav.test",
  containerId: "",
  rootPath: "/vault",
  credentialBindingId: "account-a",
};

function move(
  sourcePath: string,
  targetPath: string,
  observedAt: number,
  scopeOverride: Partial<typeof scope> = {},
): PendingPathIdentityFolderMoveV1 {
  return {
    version: 1,
    scope: { ...scope, ...scopeOverride },
    sourcePath,
    targetPath,
    observedAt,
  };
}

describe("路径身份文件夹改名续做记录", () => {
  it("读取无法识别的数据时返回 null，由调用方回落到空记忆", () => {
    expect(readPendingPathIdentityFolderMoves(null)).toBeNull();
    expect(readPendingPathIdentityFolderMoves({})).toBeNull();
    expect(readPendingPathIdentityFolderMoves({
      schemaVersion: 1,
      kind: "pending-path-identity-folder-moves",
      entries: [{ version: 1, scope: {}, sourcePath: "docs", targetPath: "renamed", observedAt: 1 }],
    })).toEqual(createEmptyPendingPathIdentityFolderMoves());
  });

  it("同一 scope 与源路径只保留最新记录，并丢弃非法路径", () => {
    const normalized = normalizePendingPathIdentityFolderMoves([
      move("docs", "renamed", 10),
      move("docs", "renamed-2", 20),
      move("", "renamed", 30),
      move("docs", "/absolute", 40),
      move("a/b", "c/d", 50),
    ]);
    expect(normalized.entries).toEqual([
      move("a/b", "c/d", 50),
      move("docs", "renamed-2", 20),
    ]);
  });

  it("不同 scope 的同一源路径互不覆盖", () => {
    const normalized = normalizePendingPathIdentityFolderMoves([
      move("docs", "renamed-a", 10),
      move("docs", "renamed-b", 20, { accountId: "account-b", credentialBindingId: "account-b" }),
    ]);
    expect(normalized.entries).toHaveLength(2);
    expect(normalized.entries.map((entry) => entry.targetPath).sort())
      .toEqual(["renamed-a", "renamed-b"]);
  });

  it("同一 endpoint 的根路径不同视为两个 scope", () => {
    const otherRoot = { ...scope, rootPath: "/other-vault" };
    expect(pendingPathIdentityFolderMoveKey(scope, "docs"))
      .not.toBe(pendingPathIdentityFolderMoveKey(otherRoot, "docs"));
    const normalized = normalizePendingPathIdentityFolderMoves([
      move("docs", "renamed-a", 10),
      move("docs", "renamed-b", 20, { rootPath: "/other-vault" }),
    ]);
    expect(normalized.entries).toHaveLength(2);
    expect(normalized.entries.map((entry) => entry.targetPath).sort())
      .toEqual(["renamed-a", "renamed-b"]);
  });

  it("超过上限时保留最新记录", () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      move(`folder-${index}`, `renamed-${index}`, index));
    const normalized = normalizePendingPathIdentityFolderMoves(entries);
    expect(normalized.entries).toHaveLength(50);
    expect(normalized.entries.some((entry) => entry.sourcePath === "folder-0"))
      .toBe(false);
    expect(normalized.entries.some((entry) => entry.sourcePath === "folder-59"))
      .toBe(true);
  });
});
