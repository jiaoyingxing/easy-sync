import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { AncestorStoreV2, type AncestorStoreV2Paths } from "../src/sync/ancestor-store-v2";
import {
  StateEnvelopeV2Store,
  type StateEnvelopeV2Paths,
  type SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";

const ancestorPaths: AncestorStoreV2Paths = {
  directory: "plugin/ancestors-v2",
  manifest: "plugin/ancestor-manifest-v2.json",
  manifestNext: "plugin/ancestor-manifest-v2.next.json",
};

function makeAdapter() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path) || dirs.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
    mkdir: vi.fn(async (path: string) => { dirs.add(path); }),
    list: vi.fn(async (path: string) => ({
      files: [...files.keys()].filter((entry) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes("/")),
      folders: [],
    })),
  };
  return { adapter: adapter as unknown as DataAdapter, files, spies: adapter };
}

describe("AncestorStoreV2", () => {
  it("stores empty text and Unicode ArrayBuffer by verified SHA-256", async () => {
    const { adapter } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    const emptyHash = await store.putText("");
    const unicode = new TextEncoder().encode("中文🙂\n").buffer;
    const unicodeHash = await store.putText(unicode);

    expect(emptyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.getText(emptyHash!)).toBe("");
    expect(await store.getText(unicodeHash!)).toBe("中文🙂\n");
  });

  it("preserves exact CRLF/LF bytes and shares identical content across paths", async () => {
    const { adapter, files } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    const lf = await store.putText("a\nb\n");
    const crlf = await store.putText("a\r\nb\r\n");
    const same = await store.putText(new TextEncoder().encode("a\nb\n").buffer);

    expect(lf).toBe(same);
    expect(crlf).not.toBe(lf);
    expect([...files.keys()].filter((path) => path.endsWith(".txt"))).toHaveLength(2);
  });

  it("rejects invalid UTF-8 and oversized text without publishing an object", async () => {
    const { adapter, files } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);

    expect(await store.putText(new Uint8Array([0xff, 0xfe]).buffer)).toBeNull();
    expect(await store.putText("x".repeat(2 * 1024 * 1024 + 1))).toBeNull();
    expect([...files.keys()].filter((path) => path.endsWith(".txt"))).toHaveLength(0);
  });

  it("supports very long lines without newline normalization", async () => {
    const { adapter } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    const line = "界".repeat(100_000);
    const hash = await store.putText(line);
    expect(await store.getText(hash!)).toBe(line);
  });

  it("sweeps only objects outside reachable, recovery and grace sets", async () => {
    const { adapter } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    const reachable = await store.putText("reachable");
    const recovery = await store.putText("recovery");
    const grace = await store.putText("grace");
    const orphan = await store.putText("orphan");

    await expect(store.sweep(
      new Set([reachable!]),
      new Set([recovery!]),
      new Set([grace!]),
    )).resolves.toEqual([orphan]);
    expect(await store.has(reachable!)).toBe(true);
    expect(await store.has(recovery!)).toBe(true);
    expect(await store.has(grace!)).toBe(true);
    expect(await store.has(orphan!)).toBe(false);
  });

  it("refuses a corrupt object even when its filename has a valid hash", async () => {
    const { adapter, files } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    const hash = await store.putText("original");
    files.set(`${ancestorPaths.directory}/${hash}.txt`, "corrupt");
    expect(await store.getText(hash!)).toBeNull();
    await expect(store.putText("original")).rejects.toThrow("corrupt");
  });
});

describe("AncestorStoreV2 envelope linkage", () => {
  const envelopePaths: StateEnvelopeV2Paths = {
    committed: "plugin/state-v2.json",
    next: "plugin/state-v2.next.json",
    previous: "plugin/state-v2.previous.json",
    recovery: "plugin/state-v2.recovery.json",
  };

  function envelope(ancestorHash: string): SyncStateEnvelopeV2 {
    return {
      meta: { schemaVersion: 2, lifecycleEpoch: 1, commitSeq: 1, committedAt: 1 },
      scope: { accountId: "account", driveId: "drive", vaultFolderId: "vault", filesRootId: "root" },
      remoteIndex: {
        schemaVersion: 2,
        filesRootId: "root",
        cursorRevision: 1,
        deltaLink: null,
        complete: true,
        itemsById: {
          file: { id: "file", parentId: "root", name: "a.md", kind: "file", eTag: "e", size: 4 },
        },
      },
      anchors: {
        schemaVersion: 2,
        byAnchorId: {
          anchor: {
            anchorId: "anchor",
            remoteId: "file",
            lastPath: "a.md",
            contentHash: "a".repeat(64),
            ancestorHash,
            size: 4,
            remoteETag: "e",
            confirmedAt: 1,
            confirmedBy: "equal-read",
          },
        },
      },
    };
  }

  it("requires the content-addressed object before publishing an ancestor reference", async () => {
    const { adapter } = makeAdapter();
    const ancestors = new AncestorStoreV2(adapter, ancestorPaths);
    const missing = "b".repeat(64);
    const withoutVerifier = new StateEnvelopeV2Store(adapter, envelopePaths);
    await expect(withoutVerifier.publish(envelope(missing))).rejects.toThrow("not published");

    const hash = await ancestors.putText("base");
    const withVerifier = new StateEnvelopeV2Store(adapter, envelopePaths, (candidate) => ancestors.has(candidate));
    await expect(withVerifier.publish(envelope(hash!))).resolves.toBeUndefined();
  });
});
