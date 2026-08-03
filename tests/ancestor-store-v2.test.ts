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
  let failNextObjectWrite = false;
  let loseNextObjectWriteResponse = false;
  let failNextObjectRename = false;
  let loseNextObjectRenameResponse = false;
  let failNextPublishedObjectRead = false;
  let loseNextManifestWriteResponse = false;
  let failNextManifestRename = false;
  let loseNextManifestRenameResponse = false;
  const isObjectNext = (path: string) =>
    path.startsWith(`${ancestorPaths.directory}/.`)
    && path.endsWith(".next");
  const isPublishedObject = (path: string) =>
    path.startsWith(`${ancestorPaths.directory}/`)
    && path.endsWith(".txt");
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path) || dirs.has(path)),
    read: vi.fn(async (path: string) => {
      if (failNextPublishedObjectRead && isPublishedObject(path)) {
        failNextPublishedObjectRead = false;
        throw new Error("published object read interrupted");
      }
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      if (failNextObjectWrite && isObjectNext(path)) {
        failNextObjectWrite = false;
        throw new Error("object write interrupted");
      }
      files.set(path, value);
      if (loseNextObjectWriteResponse && isObjectNext(path)) {
        loseNextObjectWriteResponse = false;
        throw new Error("object write response lost");
      }
      if (
        loseNextManifestWriteResponse
        && path === ancestorPaths.manifestNext
      ) {
        loseNextManifestWriteResponse = false;
        throw new Error("ancestor manifest write response lost");
      }
    }),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      if (failNextObjectRename && isObjectNext(from)) {
        failNextObjectRename = false;
        throw new Error("object rename interrupted");
      }
      if (
        failNextManifestRename
        && from === ancestorPaths.manifestNext
        && to === ancestorPaths.manifest
      ) {
        failNextManifestRename = false;
        throw new Error("ancestor manifest rename interrupted");
      }
      files.delete(from);
      files.set(to, value);
      if (loseNextObjectRenameResponse && isObjectNext(from)) {
        loseNextObjectRenameResponse = false;
        throw new Error("object rename response lost");
      }
      if (
        loseNextManifestRenameResponse
        && from === ancestorPaths.manifestNext
        && to === ancestorPaths.manifest
      ) {
        loseNextManifestRenameResponse = false;
        throw new Error("ancestor manifest rename response lost");
      }
    }),
    mkdir: vi.fn(async (path: string) => { dirs.add(path); }),
    list: vi.fn(async (path: string) => ({
      files: [...files.keys()].filter((entry) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes("/")),
      folders: [],
    })),
  };
  return {
    adapter: adapter as unknown as DataAdapter,
    files,
    spies: adapter,
    failObjectWriteOnce: () => { failNextObjectWrite = true; },
    loseObjectWriteResponseOnce: () => {
      loseNextObjectWriteResponse = true;
    },
    failObjectRenameOnce: () => { failNextObjectRename = true; },
    loseObjectRenameResponseOnce: () => {
      loseNextObjectRenameResponse = true;
    },
    failPublishedObjectReadOnce: () => {
      failNextPublishedObjectRead = true;
    },
    loseManifestWriteResponseOnce: () => {
      loseNextManifestWriteResponse = true;
    },
    failManifestRenameOnce: () => { failNextManifestRename = true; },
    loseManifestRenameResponseOnce: () => {
      loseNextManifestRenameResponse = true;
    },
  };
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

  it("does not publish an object when its staged write never happened", async () => {
    const { adapter, files, failObjectWriteOnce } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    failObjectWriteOnce();

    await expect(store.putText("base")).rejects.toThrow(
      "object write interrupted",
    );
    expect([...files.keys()].some((path) => path.endsWith(".txt")))
      .toBe(false);
    await expect(store.putText("base")).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("continues only from exact staged bytes when the write response is lost", async () => {
    const {
      adapter,
      files,
      loseObjectWriteResponseOnce,
    } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    loseObjectWriteResponseOnce();

    const hash = await store.putText("base");
    expect(files.get(`${ancestorPaths.directory}/${hash}.txt`)).toBe("base");
    expect(JSON.parse(files.get(ancestorPaths.manifest)!).textHashes)
      .toEqual([hash]);
  });

  it("rejects a rename that did not publish and retries from the staged boundary", async () => {
    const { adapter, files, failObjectRenameOnce } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    failObjectRenameOnce();

    await expect(store.putText("base")).rejects.toThrow(
      "object rename interrupted",
    );
    expect([...files.keys()].some((path) => path.endsWith(".txt")))
      .toBe(false);

    const restarted = new AncestorStoreV2(adapter, ancestorPaths);
    const hash = await restarted.putText("base");
    expect(files.get(`${ancestorPaths.directory}/${hash}.txt`)).toBe("base");
  });

  it("accepts a verified object when its rename response is lost", async () => {
    const { adapter, files, loseObjectRenameResponseOnce } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    loseObjectRenameResponseOnce();

    const hash = await store.putText("base");
    expect(files.get(`${ancestorPaths.directory}/${hash}.txt`)).toBe("base");
    expect(JSON.parse(files.get(ancestorPaths.manifest)!).textHashes)
      .toEqual([hash]);
  });

  it("reuses a durable object after its final verification was interrupted", async () => {
    const { adapter, files, failPublishedObjectReadOnce } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    failPublishedObjectReadOnce();

    await expect(store.putText("base")).rejects.toThrow(
      "failed publication",
    );
    expect([...files.keys()].filter((path) => path.endsWith(".txt")))
      .toHaveLength(1);

    const restarted = new AncestorStoreV2(adapter, ancestorPaths);
    const hash = await restarted.putText("base");
    expect(JSON.parse(files.get(ancestorPaths.manifest)!).textHashes)
      .toEqual([hash]);
  });

  it("recovers a staged ancestor manifest whose write response was lost", async () => {
    const { adapter, files, loseManifestWriteResponseOnce } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    loseManifestWriteResponseOnce();

    const hash = await store.putText("base");
    expect(JSON.parse(files.get(ancestorPaths.manifest)!).textHashes)
      .toEqual([hash]);
    expect(files.has(ancestorPaths.manifestNext)).toBe(false);
  });

  it("accepts a committed ancestor manifest whose rename response was lost", async () => {
    const { adapter, files, loseManifestRenameResponseOnce } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    loseManifestRenameResponseOnce();

    const hash = await store.putText("base");
    expect(JSON.parse(files.get(ancestorPaths.manifest)!).textHashes)
      .toEqual([hash]);
    expect(files.has(ancestorPaths.manifestNext)).toBe(false);
  });

  it("keeps verified objects authoritative and rebuilds a missing manifest after restart", async () => {
    const { adapter, files, failManifestRenameOnce } = makeAdapter();
    const store = new AncestorStoreV2(adapter, ancestorPaths);
    failManifestRenameOnce();

    const hash = await store.putText("base");
    expect(files.get(`${ancestorPaths.directory}/${hash}.txt`)).toBe("base");
    expect(files.has(ancestorPaths.manifest)).toBe(false);
    expect(files.has(ancestorPaths.manifestNext)).toBe(true);

    const restarted = new AncestorStoreV2(adapter, ancestorPaths);
    await expect(restarted.putText("base")).resolves.toBe(hash);
    expect(JSON.parse(files.get(ancestorPaths.manifest)!).textHashes)
      .toEqual([hash]);
    expect(files.has(ancestorPaths.manifestNext)).toBe(false);
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

  it("uses verified object bytes rather than the rebuildable inventory as reference authority", async () => {
    const {
      adapter,
      files,
      failManifestRenameOnce,
    } = makeAdapter();
    const ancestors = new AncestorStoreV2(adapter, ancestorPaths);
    failManifestRenameOnce();
    const hash = await ancestors.putText("base");
    expect(files.has(ancestorPaths.manifest)).toBe(false);

    const envelopes = new StateEnvelopeV2Store(
      adapter,
      envelopePaths,
      (candidate) => ancestors.has(candidate),
    );
    await expect(envelopes.publish(envelope(hash!))).resolves.toBeUndefined();
  });
});
