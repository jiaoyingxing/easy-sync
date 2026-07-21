import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  StateEnvelopeV2Store,
  type StateEnvelopeV2Paths,
  type SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";

const paths: StateEnvelopeV2Paths = {
  committed: "plugin/state-v2.json",
  next: "plugin/state-v2.next.json",
  previous: "plugin/state-v2.previous.json",
  recovery: "plugin/state-v2.recovery.json",
};

function makeAdapter() {
  const files = new Map<string, string>();
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
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
  };
  return { adapter: adapter as unknown as DataAdapter, files, spies: adapter };
}

function envelope(commitSeq = 1): SyncStateEnvelopeV2 {
  const hash = "a".repeat(64);
  return {
    meta: { schemaVersion: 2, lifecycleEpoch: 3, commitSeq, committedAt: 1000 + commitSeq },
    scope: { accountId: "account", driveId: "drive", vaultFolderId: "vault", filesRootId: "root" },
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: "root",
      cursorRevision: commitSeq,
      deltaLink: `delta-${commitSeq}`,
      complete: true,
      itemsById: {
        folder: { id: "folder", parentId: "root", name: "notes", kind: "folder" },
        file: { id: "file", parentId: "folder", name: "a.md", kind: "file", eTag: `e${commitSeq}`, size: 1 },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        anchor: {
          anchorId: "anchor",
          remoteId: "file",
          lastPath: "notes/a.md",
          contentHash: hash,
          size: 1,
          remoteETag: `e${commitSeq}`,
          confirmedAt: 1000 + commitSeq,
          confirmedBy: "equal-read",
        },
      },
    },
  };
}

describe("StateEnvelopeV2Store", () => {
  it("publishes remote identity and anchors through one verified commit", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());

    expect(await store.load(envelope().scope)).toEqual(envelope());
    expect(files.has(paths.next)).toBe(false);
    expect(files.has(paths.previous)).toBe(false);
    expect(await store.hasRecoveryJournal()).toBe(false);
  });

  it("preserves the old committed envelope and journal when final rename fails", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
    spies.rename.mockImplementationOnce(async (from: string, to: string) => {
      const value = files.get(from)!;
      files.delete(from);
      files.set(to, value);
    }).mockImplementationOnce(async () => { throw new Error("rename failed"); });

    await expect(store.publish(envelope(2))).rejects.toThrow("rename failed");
    expect(await store.load(envelope().scope)).toEqual(envelope());
    expect(await store.hasRecoveryJournal()).toBe(true);
    await expect(store.publish(envelope(2))).rejects.toThrow("unresolved recovery journal");
  });

  it("does not replace committed state when staged read-back is corrupt", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
    spies.read.mockImplementation(async (path: string) => {
      if (path === paths.next) return "{broken";
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    });

    await expect(store.publish(envelope(2))).rejects.toThrow("unreadable");
    expect(JSON.parse(files.get(paths.committed)!)).toEqual(envelope());
    expect(await store.hasRecoveryJournal()).toBe(true);
  });

  it("rejects split identity, duplicate remote anchors and stale sequences before staging", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const dangling = envelope();
    dangling.anchors.byAnchorId.anchor!.remoteId = "missing";
    await expect(store.publish(dangling)).rejects.toThrow("no remote file");
    expect(files.size).toBe(0);

    const duplicate = envelope();
    duplicate.anchors.byAnchorId.second = { ...duplicate.anchors.byAnchorId.anchor!, anchorId: "second" };
    await expect(store.publish(duplicate)).rejects.toThrow("multiple anchors");
    expect(files.size).toBe(0);

    await store.publish(envelope());
    await expect(store.publish(envelope(3))).rejects.toThrow("must be 2");
  });

  it.each(["accountId", "driveId", "vaultFolderId", "filesRootId"] as const)(
    "refuses to load an envelope when %s differs",
    async (field) => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
      await expect(store.load({ ...envelope().scope, [field]: `other-${field}` })).rejects.toThrow("scope");
    },
  );

  it("rejects an index rooted at the outer vault folder instead of files/", async () => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const candidate = envelope();
    candidate.remoteIndex.filesRootId = candidate.scope.vaultFolderId;
    await expect(store.publish(candidate)).rejects.toThrow("remote index");
  });
});
