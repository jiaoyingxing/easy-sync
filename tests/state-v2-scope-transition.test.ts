import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  StateV2AuthorityWitnessStore,
} from "../src/sync/state-v2-authority-witness";
import {
  StateV2ScopeTransitionStore,
  type StateV2ScopeTransitionPaths,
} from "../src/sync/state-v2-scope-transition";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import type { StateV2Manifest } from "../src/sync/state-v2-migration";
import type { SyncScope } from "../src/sync/types";

class MemoryAdapter {
  readonly files = new Map<string, string>();
  failWriteOnce: string | null = null;
  failProcessOnce: string | null = null;
  failRenameOnce: string | null = null;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing: ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    if (this.failWriteOnce === path) {
      this.failWriteOnce = null;
      throw new Error(`injected write failure: ${path}`);
    }
    this.files.set(path, value);
  }

  async process(
    path: string,
    fn: (value: string) => string,
  ): Promise<string> {
    if (this.failProcessOnce === path) {
      this.failProcessOnce = null;
      throw new Error(`injected process failure: ${path}`);
    }
    const value = await this.read(path);
    const next = fn(value);
    this.files.set(path, next);
    return next;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failRenameOnce === from) {
      this.failRenameOnce = null;
      throw new Error(`injected rename failure: ${from}`);
    }
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`missing: ${from}`);
    this.files.delete(from);
    this.files.set(to, value);
  }
}

const paths: StateV2ScopeTransitionPaths = {
  stateCommitted: "state.json",
  stateNext: "state.next.json",
  statePrevious: "state.previous.json",
  stateRecovery: "state.recovery.json",
  manifestCommitted: "manifest.json",
  manifestNext: "manifest.next.json",
  witness: {
    committed: "authority.json",
    next: "authority.next.json",
  },
  transitionCommitted: "scope-transition.json",
  transitionNext: "scope-transition.next.json",
};

const sourceScope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault-old",
  filesRootId: "files-old",
};
const targetScope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault-new",
  filesRootId: "files-new",
};

function envelope(
  scope: SyncScope,
  commitSeq: number,
  lifecycleEpoch: number,
  held: boolean,
): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch,
      commitSeq,
      committedAt: commitSeq,
    },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: commitSeq,
      deltaLink: null,
      complete: true,
      itemsById: {},
    },
    anchors: { schemaVersion: 2, byAnchorId: {} },
    folderAnchors: { schemaVersion: 2, byAnchorId: {} },
    ...(held
      ? {
          remoteScopeRecovery: {
            schemaVersion: 1 as const,
            kind: "v2-remote-scope-recovery" as const,
            reason: "committed-scope-unreachable" as const,
            sourceCommitSeq: commitSeq - 1,
            observedScope: targetScope,
            observedAt: commitSeq,
          },
        }
      : {}),
  };
}

const sourceEnvelope = envelope(sourceScope, 8, 3, true);
const candidate = envelope(targetScope, 9, 4, false);
const sourceManifest: StateV2Manifest = {
  schemaVersion: 2,
  activeState: "state-v2.json",
  stateCommitSeq: 1,
  lifecycleEpoch: 1,
  scope: sourceScope,
  migratedAt: 1,
  legacyAutoSyncAllowed: false,
};
const sourceProtocolBinding = {
  schemaVersion: 1 as const,
  protocolVersion: 2 as const,
  migrationGeneration: "a".repeat(64),
  confirmedAllDevicesUpdatedAt: 10,
  recordId: "protocol-old",
  recordETag: "protocol-old-etag",
};
const nextProtocolBinding = {
  ...sourceProtocolBinding,
  recordId: "protocol-new",
  recordETag: "protocol-new-etag",
};

async function harness(withProtocolBinding = false) {
  const memory = new MemoryAdapter();
  const adapter = memory as unknown as DataAdapter;
  memory.files.set(paths.stateCommitted, JSON.stringify(sourceEnvelope));
  memory.files.set(paths.manifestCommitted, JSON.stringify(sourceManifest));
  const witnessStore = new StateV2AuthorityWitnessStore(
    adapter,
    paths.witness,
  );
  const witness = await witnessStore.publishActive(
    sourceManifest,
    1,
    withProtocolBinding ? sourceProtocolBinding : undefined,
  );
  return {
    memory,
    adapter,
    witness,
    witnessStore,
    store: new StateV2ScopeTransitionStore(adapter, paths),
  };
}

describe("StateV2ScopeTransitionStore", () => {
  it("publishes envelope, manifest and witness as one recoverable transition", async () => {
    const h = await harness();
    const committed = await h.store.commit({
      sourceEnvelope,
      candidate,
      sourceManifest,
      sourceWitness: h.witness,
      now: 100,
    });

    expect(committed).toEqual(candidate);
    expect(JSON.parse(h.memory.files.get(paths.stateCommitted)!)).toEqual(
      candidate,
    );
    const manifest = JSON.parse(
      h.memory.files.get(paths.manifestCommitted)!,
    ) as StateV2Manifest;
    expect(manifest).toMatchObject({
      stateCommitSeq: 9,
      lifecycleEpoch: 4,
      scope: targetScope,
    });
    expect(await h.witnessStore.load()).toMatchObject({
      revision: 2,
      status: "active",
      manifest,
    });
    expect(h.memory.files.has(paths.transitionCommitted)).toBe(false);
    expect(h.memory.files.has(paths.statePrevious)).toBe(false);
  });

  it("preserves one migration generation while rebinding the recovered scope record", async () => {
    const h = await harness(true);

    await h.store.commit({
      sourceEnvelope,
      candidate,
      sourceManifest,
      sourceWitness: h.witness,
      nextProtocolBinding,
      now: 100,
    });

    expect(await h.witnessStore.load()).toMatchObject({
      revision: 2,
      protocolBinding: nextProtocolBinding,
    });
    expect(JSON.parse(
      h.memory.files.get(paths.transitionCommitted) ?? "null",
    )).toBeNull();
  });

  it("rolls forward after envelope commit but before manifest publication", async () => {
    const h = await harness();
    h.memory.failWriteOnce = paths.manifestNext;
    await expect(h.store.commit({
      sourceEnvelope,
      candidate,
      sourceManifest,
      sourceWitness: h.witness,
      now: 100,
    })).rejects.toThrow("injected write failure");

    expect(JSON.parse(h.memory.files.get(paths.stateCommitted)!)).toEqual(
      candidate,
    );
    expect(h.memory.files.has(paths.transitionCommitted)).toBe(true);
    expect(JSON.parse(h.memory.files.get(paths.manifestCommitted)!)).toEqual(
      sourceManifest,
    );

    const recovered = await new StateV2ScopeTransitionStore(
      h.adapter,
      paths,
    ).recover();
    expect(recovered).toEqual(candidate);
    expect(JSON.parse(h.memory.files.get(paths.manifestCommitted)!))
      .toMatchObject({ scope: targetScope, stateCommitSeq: 9 });
    expect((await h.witnessStore.load())?.status).toBe("active");
    expect(h.memory.files.has(paths.transitionCommitted)).toBe(false);
  });

  it("promotes a staged target witness after an atomic update interruption", async () => {
    const h = await harness();
    h.memory.failProcessOnce = paths.witness.committed;
    await expect(h.store.commit({
      sourceEnvelope,
      candidate,
      sourceManifest,
      sourceWitness: h.witness,
      now: 100,
    })).rejects.toThrow("injected process failure");

    expect(h.memory.files.has(paths.transitionCommitted)).toBe(true);
    expect(h.memory.files.has(paths.witness.committed)).toBe(true);
    expect(h.memory.files.has(paths.witness.next)).toBe(true);

    await new StateV2ScopeTransitionStore(h.adapter, paths).recover();
    expect(await h.witnessStore.load()).toMatchObject({
      revision: 2,
      status: "active",
      manifest: { scope: targetScope, stateCommitSeq: 9 },
    });
    expect(h.memory.files.has(paths.transitionCommitted)).toBe(false);
  });

  it("refuses to transition across an unrelated committed envelope", async () => {
    const h = await harness();
    h.memory.files.set(
      paths.stateCommitted,
      JSON.stringify(envelope(sourceScope, 10, 3, true)),
    );
    await expect(h.store.commit({
      sourceEnvelope,
      candidate,
      sourceManifest,
      sourceWitness: h.witness,
      now: 100,
    })).rejects.toMatchObject({
      reason: "scope-transition-state-ambiguous",
    });
    expect(h.memory.files.has(paths.transitionCommitted)).toBe(true);
  });
});
