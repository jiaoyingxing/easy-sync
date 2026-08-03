import { describe, expect, it, vi } from "vitest";
import type { LocalFileEntry } from "../src/sync/types";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import {
  publishCloudBootstrapV2,
  verifyCloudBootstrapV2,
  type CloudBootstrapHealthV2,
  type CloudBootstrapObjectV2,
  type CloudBootstrapTransportV2,
} from "../src/sync/cloud-bootstrap-v2";

const hash = "a".repeat(64);

function envelope(commitSeq = 1): SyncStateEnvelopeV2 {
  return {
    meta: { schemaVersion: 2, lifecycleEpoch: 1, commitSeq, committedAt: commitSeq },
    scope: { accountId: "account", driveId: "drive", vaultFolderId: "vault", filesRootId: "root" },
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: "root",
      cursorRevision: commitSeq,
      deltaLink: `delta-${commitSeq}`,
      complete: true,
      itemsById: {
        file: {
          id: "file", parentId: "root", name: "a.md", kind: "file",
          eTag: `e${commitSeq}`, cTag: `c${commitSeq}`, size: 4,
          quickXorHash: "quickxor",
        },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        anchor: {
          anchorId: "anchor", remoteId: "file", lastPath: "a.md",
          contentHash: hash, size: 4, remoteETag: `e${commitSeq}`,
          confirmedAt: commitSeq, confirmedBy: "equal-read",
        },
      },
    },
  };
}

const healthy: CloudBootstrapHealthV2 = {
  envelopeCommitted: true,
  localScanComplete: true,
  remoteScanComplete: true,
  lifecycleCurrent: true,
  unresolvedMutations: 0,
  pendingItems: 0,
  stateRecoveryPending: false,
};

function makeTransport(initial: CloudBootstrapObjectV2 | null = null) {
  let object = initial;
  const transport = {
    read: vi.fn(async () => object),
    createOnly: vi.fn(async (content: string) => {
      if (object) throw new Error("conflict");
      object = { id: "bootstrap", eTag: "etag-1", content };
      return { id: object.id, eTag: object.eTag };
    }),
    updateCas: vi.fn(async (id: string, eTag: string, content: string) => {
      if (!object || object.id !== id || object.eTag !== eTag) throw new Error("precondition");
      object = { id, eTag: `etag-${JSON.parse(content).revision}`, content };
      return { id: object.id, eTag: object.eTag };
    }),
    readById: vi.fn(async (id: string) => {
      if (!object || object.id !== id) throw new Error("missing");
      return object;
    }),
  };
  return { transport: transport as CloudBootstrapTransportV2, spies: transport, current: () => object };
}

function local(): LocalFileEntry[] {
  return [{ path: "a.md", hash, size: 4, mtime: 1, binary: false }];
}

describe("CloudBootstrapV2 publication", () => {
  it("publishes a healthy committed envelope with create-only and verifies it", async () => {
    const { transport, spies, current } = makeTransport();
    await expect(publishCloudBootstrapV2(transport, envelope(), healthy, 100)).resolves.toMatchObject({
      published: true, dirty: false, revision: 1,
    });
    expect(spies.createOnly).toHaveBeenCalledTimes(1);
    expect(spies.readById).toHaveBeenCalledWith("bootstrap");
    expect(JSON.parse(current()!.content)).toMatchObject({
      schemaVersion: 2, revision: 1, sourceCommitSeq: 1,
      anchors: [{
        remoteId: "file",
        lastPath: "a.md",
        contentHash: hash,
        remoteCTag: "c1",
      }],
    });
  });

  it("uses an exact local publication receipt without another Graph request", async () => {
    const current = makeTransport();
    const first = await publishCloudBootstrapV2(
      current.transport,
      envelope(),
      healthy,
      100,
    );
    expect(first.checkpoint).not.toBeNull();
    vi.clearAllMocks();

    await expect(publishCloudBootstrapV2(
      current.transport,
      envelope(),
      healthy,
      200,
      first.checkpoint,
    )).resolves.toMatchObject({
      published: false,
      dirty: false,
      revision: 1,
      checkpoint: first.checkpoint,
    });
    expect(current.spies.read).not.toHaveBeenCalled();
    expect(current.spies.createOnly).not.toHaveBeenCalled();
    expect(current.spies.updateCas).not.toHaveBeenCalled();
    expect(current.spies.readById).not.toHaveBeenCalled();
  });

  it("uses the checkpoint ID and eTag directly when anchors change", async () => {
    const current = makeTransport();
    const first = await publishCloudBootstrapV2(
      current.transport,
      envelope(),
      healthy,
      100,
    );
    vi.clearAllMocks();

    await expect(publishCloudBootstrapV2(
      current.transport,
      envelope(2),
      healthy,
      200,
      first.checkpoint,
    )).resolves.toMatchObject({
      published: true,
      dirty: false,
      revision: 2,
    });
    expect(current.spies.read).not.toHaveBeenCalled();
    expect(current.spies.updateCas).toHaveBeenCalledWith(
      "bootstrap",
      "etag-1",
      expect.stringContaining('"revision":2'),
    );
    expect(current.spies.readById).toHaveBeenCalledWith("bootstrap");
  });

  it("re-reads after a stale checkpoint and recognizes an already converged write", async () => {
    const current = makeTransport();
    const first = await publishCloudBootstrapV2(
      current.transport,
      envelope(),
      healthy,
      100,
    );
    await publishCloudBootstrapV2(
      current.transport,
      envelope(2),
      healthy,
      200,
    );
    vi.clearAllMocks();

    await expect(publishCloudBootstrapV2(
      current.transport,
      envelope(2),
      healthy,
      300,
      first.checkpoint,
    )).resolves.toMatchObject({
      published: false,
      dirty: false,
      revision: 2,
      checkpoint: {
        objectId: "bootstrap",
        eTag: "etag-2",
        revision: 2,
      },
    });
    expect(current.spies.updateCas).toHaveBeenCalledOnce();
    expect(current.spies.read).toHaveBeenCalledOnce();
    expect(current.spies.readById).not.toHaveBeenCalled();
  });

  it("uses ID + eTag CAS for the next healthy revision", async () => {
    const first = makeTransport();
    await publishCloudBootstrapV2(first.transport, envelope(), healthy, 100);
    await expect(publishCloudBootstrapV2(first.transport, envelope(2), healthy, 200)).resolves.toMatchObject({
      published: true, dirty: false, revision: 2,
    });
    expect(first.spies.updateCas).toHaveBeenCalledWith(
      "bootstrap", "etag-1", expect.stringContaining('"revision":2'),
    );
  });

  it("treats source commit sequence as provenance instead of cross-device ordering", async () => {
    const current = makeTransport();
    await publishCloudBootstrapV2(current.transport, envelope(5), healthy, 100);

    await expect(
      publishCloudBootstrapV2(current.transport, envelope(2), healthy, 200),
    ).resolves.toMatchObject({
      published: true,
      dirty: false,
      revision: 2,
    });
    expect(JSON.parse(current.current()!.content)).toMatchObject({
      revision: 2,
      sourceCommitSeq: 2,
      anchors: [{ remoteCTag: "c2", remoteETag: "e2" }],
    });
  });

  it("does not publish partial, pending, cancelled or recovery-uncertain state", async () => {
    const { transport, spies } = makeTransport();
    for (const patch of [
      { localScanComplete: false },
      { remoteScanComplete: false },
      { lifecycleCurrent: false },
      { unresolvedMutations: 1 },
      { pendingItems: 1 },
      { stateRecoveryPending: true },
    ]) {
      await expect(publishCloudBootstrapV2(transport, envelope(), { ...healthy, ...patch })).resolves.toMatchObject({
        published: false, dirty: true, reason: "unhealthy",
      });
    }
    expect(spies.createOnly).not.toHaveBeenCalled();
    expect(spies.updateCas).not.toHaveBeenCalled();
  });

  it("keeps the local envelope authoritative when cloud CAS fails", async () => {
    const current = makeTransport();
    await publishCloudBootstrapV2(current.transport, envelope(), healthy);
    current.spies.updateCas.mockRejectedValueOnce(new Error("412"));
    await expect(publishCloudBootstrapV2(current.transport, envelope(2), healthy)).resolves.toMatchObject({
      published: false, dirty: true, revision: 1, reason: "write-failed",
    });
    expect(envelope(2).meta.commitSeq).toBe(2);
  });
});

describe("CloudBootstrapV2 verification", () => {
  it("rejects the entire document when the remote identity index is incomplete", async () => {
    const { transport, current } = makeTransport();
    await publishCloudBootstrapV2(transport, envelope(), healthy, 100);
    const incomplete = structuredClone(envelope().remoteIndex);
    incomplete.complete = false;

    expect(verifyCloudBootstrapV2(
      current()!.content,
      envelope().scope,
      incomplete,
      local(),
    )).toEqual({
      status: "rejected",
      reason: "remote-index-incomplete",
      anchors: [],
      rejectedPaths: [],
      mutations: [],
    });
  });

  it("seeds version-bound hints without requiring a Graph SHA-256 and never creates mutations", async () => {
    const { transport, current } = makeTransport();
    await publishCloudBootstrapV2(transport, envelope(), healthy, 100);
    expect(verifyCloudBootstrapV2(
      current()!.content,
      envelope().scope,
      envelope().remoteIndex,
      local(),
    )).toEqual({
      status: "verified",
      anchors: [{
        remoteId: "file",
        lastPath: "a.md",
        contentHash: hash,
        size: 4,
        remoteETag: "e1",
        remoteCTag: "c1",
      }],
      rejectedPaths: [],
      mutations: [],
    });
  });

  it("rejects a hint when current Graph content facts contradict it", async () => {
    const { transport, current } = makeTransport();
    await publishCloudBootstrapV2(transport, envelope(), healthy, 100);
    const content = current()!.content;

    const shaContradiction = structuredClone(envelope().remoteIndex);
    shaContradiction.itemsById.file!.contentHash = "b".repeat(64);
    expect(verifyCloudBootstrapV2(
      content,
      envelope().scope,
      shaContradiction,
      local(),
    )).toMatchObject({
      status: "verified",
      anchors: [],
      rejectedPaths: ["a.md"],
      mutations: [],
    });

    expect(verifyCloudBootstrapV2(
      content,
      envelope().scope,
      envelope().remoteIndex,
      [{ ...local()[0], quickXorHash: "different-quickxor" }],
    )).toMatchObject({
      status: "verified",
      anchors: [],
      rejectedPaths: ["a.md"],
      mutations: [],
    });
  });

  it("rejects a remote index rooted outside the expected sync scope", async () => {
    const { transport, current } = makeTransport();
    await publishCloudBootstrapV2(transport, envelope(), healthy, 100);
    const wrongRoot = structuredClone(envelope().remoteIndex);
    wrongRoot.filesRootId = "other-root";

    expect(verifyCloudBootstrapV2(
      current()!.content,
      envelope().scope,
      wrongRoot,
      local(),
    )).toEqual({
      status: "rejected",
      reason: "scope-mismatch",
      anchors: [],
      rejectedPaths: [],
      mutations: [],
    });
  });

  it("accepts only valid anchors when sibling local SHA or remote cTag facts changed", () => {
    const localChangedHash = "b".repeat(64);
    const currentLocalHash = "c".repeat(64);
    const remoteChangedHash = "d".repeat(64);
    const remoteIndex = structuredClone(envelope().remoteIndex);
    remoteIndex.itemsById.localChanged = {
      id: "localChanged",
      parentId: "root",
      name: "local-changed.md",
      kind: "file",
      eTag: "etag-local",
      cTag: "ctag-local",
      size: 4,
    };
    remoteIndex.itemsById.remoteChanged = {
      id: "remoteChanged",
      parentId: "root",
      name: "remote-changed.md",
      kind: "file",
      eTag: "etag-remote-current",
      cTag: "ctag-remote-current",
      size: 4,
    };
    const bootstrap = {
      schemaVersion: 2,
      scope: envelope().scope,
      revision: 1,
      sourceCommitSeq: 1,
      generatedAt: 1,
      anchors: [
        {
          remoteId: "file",
          lastPath: "a.md",
          contentHash: hash,
          size: 4,
          remoteETag: "e1",
          remoteCTag: "c1",
        },
        {
          remoteId: "localChanged",
          lastPath: "local-changed.md",
          contentHash: localChangedHash,
          size: 4,
          remoteETag: "etag-local",
          remoteCTag: "ctag-local",
        },
        {
          remoteId: "remoteChanged",
          lastPath: "remote-changed.md",
          contentHash: remoteChangedHash,
          size: 4,
          remoteETag: "etag-remote-old",
          remoteCTag: "ctag-remote-old",
        },
      ],
    };
    const localEntries: LocalFileEntry[] = [
      ...local(),
      {
        path: "local-changed.md",
        hash: currentLocalHash,
        size: 4,
        mtime: 1,
        binary: false,
      },
      {
        path: "remote-changed.md",
        hash: remoteChangedHash,
        size: 4,
        mtime: 1,
        binary: false,
      },
    ];

    expect(verifyCloudBootstrapV2(
      bootstrap,
      envelope().scope,
      remoteIndex,
      localEntries,
    )).toEqual({
      status: "verified",
      anchors: [bootstrap.anchors[0]],
      rejectedPaths: ["local-changed.md", "remote-changed.md"],
      mutations: [],
    });
  });

  it("accepts a metadata-only eTag change when the content cTag is unchanged", async () => {
    const { transport, current } = makeTransport();
    await publishCloudBootstrapV2(transport, envelope(), healthy, 100);
    const metadataChanged = structuredClone(envelope().remoteIndex);
    metadataChanged.itemsById.file!.eTag = "metadata-only-change";

    expect(verifyCloudBootstrapV2(
      current()!.content,
      envelope().scope,
      metadataChanged,
      local(),
    )).toMatchObject({
      status: "verified",
      anchors: [{ remoteId: "file", remoteCTag: "c1" }],
      rejectedPaths: [],
      mutations: [],
    });
  });

  it("rejects cloud-only, moved, changed-content and cross-scope hints without delete/move/merge", async () => {
    const { transport, current } = makeTransport();
    await publishCloudBootstrapV2(transport, envelope(), healthy, 100);
    const content = current()!.content;

    expect(verifyCloudBootstrapV2(content, envelope().scope, envelope().remoteIndex, [])).toMatchObject({
      status: "verified", anchors: [], rejectedPaths: ["a.md"], mutations: [],
    });
    const movedIndex = structuredClone(envelope().remoteIndex);
    movedIndex.itemsById.file!.name = "moved.md";
    expect(verifyCloudBootstrapV2(content, envelope().scope, movedIndex, local())).toMatchObject({
      anchors: [], rejectedPaths: ["a.md"], mutations: [],
    });
    const contentChanged = structuredClone(envelope().remoteIndex);
    contentChanged.itemsById.file!.cTag = "changed-content";
    expect(verifyCloudBootstrapV2(content, envelope().scope, contentChanged, local())).toMatchObject({
      anchors: [], rejectedPaths: ["a.md"], mutations: [],
    });
    for (const field of ["accountId", "driveId", "vaultFolderId", "filesRootId"] as const) {
      expect(verifyCloudBootstrapV2(
        content,
        { ...envelope().scope, [field]: `other-${field}` },
        envelope().remoteIndex,
        local(),
      )).toMatchObject({ status: "rejected", reason: "scope-mismatch", mutations: [] });
    }
  });

  it("keeps eTag-only bootstrap documents readable for compatibility", () => {
    const legacy = {
      schemaVersion: 2,
      scope: envelope().scope,
      revision: 1,
      sourceCommitSeq: 1,
      generatedAt: 1,
      anchors: [{
        remoteId: "file",
        lastPath: "a.md",
        contentHash: hash,
        size: 4,
        remoteETag: "e1",
      }],
    };

    expect(verifyCloudBootstrapV2(
      legacy,
      envelope().scope,
      envelope().remoteIndex,
      local(),
    )).toMatchObject({
      status: "verified",
      anchors: [{ remoteId: "file", remoteETag: "e1" }],
      rejectedPaths: [],
      mutations: [],
    });

    const changedETag = structuredClone(envelope().remoteIndex);
    changedETag.itemsById.file!.eTag = "changed-content-or-metadata";
    expect(verifyCloudBootstrapV2(
      legacy,
      envelope().scope,
      changedETag,
      local(),
    )).toMatchObject({
      status: "verified",
      anchors: [],
      rejectedPaths: ["a.md"],
      mutations: [],
    });
  });
});
