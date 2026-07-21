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
          eTag: `e${commitSeq}`, size: 4, contentHash: hash,
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
    await expect(publishCloudBootstrapV2(transport, envelope(), healthy, 100)).resolves.toEqual({
      published: true, dirty: false, revision: 1,
    });
    expect(spies.createOnly).toHaveBeenCalledTimes(1);
    expect(spies.readById).toHaveBeenCalledWith("bootstrap");
    expect(JSON.parse(current()!.content)).toMatchObject({
      schemaVersion: 2, revision: 1, sourceCommitSeq: 1,
      anchors: [{ remoteId: "file", lastPath: "a.md", contentHash: hash }],
    });
  });

  it("uses ID + eTag CAS for the next healthy revision", async () => {
    const first = makeTransport();
    await publishCloudBootstrapV2(first.transport, envelope(), healthy, 100);
    await expect(publishCloudBootstrapV2(first.transport, envelope(2), healthy, 200)).resolves.toEqual({
      published: true, dirty: false, revision: 2,
    });
    expect(first.spies.updateCas).toHaveBeenCalledWith(
      "bootstrap", "etag-1", expect.stringContaining('"revision":2'),
    );
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
  it("seeds only remote-id/path/hash/eTag/local-hash verified hints and never mutations", async () => {
    const { transport, current } = makeTransport();
    await publishCloudBootstrapV2(transport, envelope(), healthy, 100);
    expect(verifyCloudBootstrapV2(
      current()!.content,
      envelope().scope,
      envelope().remoteIndex,
      local(),
    )).toEqual({
      status: "verified",
      anchors: [{ remoteId: "file", lastPath: "a.md", contentHash: hash, size: 4, remoteETag: "e1" }],
      rejectedPaths: [],
      mutations: [],
    });
  });

  it("rejects cloud-only, moved, stale and cross-scope hints without delete/move/merge", async () => {
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
    for (const field of ["accountId", "driveId", "vaultFolderId", "filesRootId"] as const) {
      expect(verifyCloudBootstrapV2(
        content,
        { ...envelope().scope, [field]: `other-${field}` },
        envelope().remoteIndex,
        local(),
      )).toMatchObject({ status: "rejected", reason: "scope-mismatch", mutations: [] });
    }
  });
});
