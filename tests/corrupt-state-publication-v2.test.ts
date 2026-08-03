import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../src/crypto";
import {
  CorruptStatePublicationV2Store,
  type CorruptStatePublicationV2Paths,
} from "../src/sync/corrupt-state-publication-v2";
import {
  canonicalPlanDigestV2,
  summarizeCanonicalPlanReviewV2,
} from "../src/sync/canonical-plan-v2";
import type { CorruptStateRecoveryHoldV2 } from "../src/sync/corrupt-state-recovery-hold-v2";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import type { StateV2ActiveAuthorityWitness } from "../src/sync/state-v2-authority-witness";
import type { StateV2Manifest } from "../src/sync/state-v2-migration";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hash = "a".repeat(64);

const paths: CorruptStatePublicationV2Paths = {
  stateCommitted: "state-v2.json",
  stateNext: "state-v2.next.json",
  statePrevious: "state-v2.previous.json",
  stateRecovery: "state-v2.recovery.json",
  manifestCommitted: "state-v2.manifest.json",
  manifestNext: "state-v2.manifest.next.json",
  witness: {
    committed: "state-v2.authority.json",
    next: "state-v2.authority.next.json",
  },
  scopeTransitionCommitted: "state-v2.scope-transition.json",
  scopeTransitionNext: "state-v2.scope-transition.next.json",
  forensicSourcePrefix: "state-v2.corrupt-source-",
  publicationCommitted: "state-v2.corrupt-publication.json",
  publicationNext: "state-v2.corrupt-publication.next.json",
};

function envelope(commitSeq = 3, lifecycleEpoch = 2): SyncStateEnvelopeV2 {
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
      cursorRevision: 1,
      deltaLink: "delta",
      complete: true,
      itemsById: {
        folder: {
          id: "folder",
          parentId: scope.filesRootId,
          name: "Notes",
          kind: "folder",
        },
        file: {
          id: "file",
          parentId: "folder",
          name: "a.md",
          kind: "file",
          size: 1,
          mtime: 1,
          eTag: "etag",
          contentHash: hash,
        },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        "file:file": {
          anchorId: "file:file",
          remoteId: "file",
          lastPath: "Notes/a.md",
          contentHash: hash,
          size: 1,
          remoteETag: "etag",
          confirmedAt: 1,
          confirmedBy: "equal-read",
        },
      },
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: {
        "folder:folder": {
          anchorId: "folder:folder",
          remoteId: "folder",
          lastPath: "Notes",
          parentRemoteId: scope.filesRootId,
          confirmedGeneration: commitSeq,
          confirmedAt: 1,
        },
      },
    },
  };
}

type Fault = {
  op: "write" | "process" | "remove" | "rename";
  path?: string;
  from?: string;
  to?: string;
  timing: "before" | "after";
};

async function makeHarness(fault?: Fault) {
  const files = new Map<string, string>();
  const candidate = envelope(4, 3);
  const corrupt = envelope(3, 2);
  corrupt.anchors.byAnchorId["file:file"]!.anchorId = "wrong-anchor";
  const rawSource = JSON.stringify(corrupt);
  const sourceDigest = await sha256Hex(
    new TextEncoder().encode(rawSource).buffer,
  );
  const items: [] = [];
  const canonicalIdentity = {
    version: 2 as const,
    scope,
    sourceCommitSeq: candidate.meta.commitSeq,
    digest: canonicalPlanDigestV2({
      items,
      lastTotalFiles: 1,
      scope,
      sourceCommitSeq: candidate.meta.commitSeq,
    }),
  };
  const hold: CorruptStateRecoveryHoldV2 = {
    schemaVersion: 1,
    kind: "v2-corrupt-state-recovery-hold",
    revision: 2,
    phase: "confirmed",
    createdAt: 10,
    updatedAt: 20,
    sourceDigest,
    sourceCommitSeq: corrupt.meta.commitSeq,
    sourceLifecycleEpoch: corrupt.meta.lifecycleEpoch,
    corruption: "anchors",
    scope,
    candidate,
    canonicalIdentity,
    canonicalReview: summarizeCanonicalPlanReviewV2(items),
    lastTotalFiles: 1,
    items,
  };
  const manifest: StateV2Manifest = {
    schemaVersion: 2,
    activeState: "state-v2.json",
    stateCommitSeq: 1,
    lifecycleEpoch: 1,
    scope,
    migratedAt: 1,
    legacyAutoSyncAllowed: false,
  };
  const witness: StateV2ActiveAuthorityWitness = {
    schemaVersion: 1,
    kind: "state-v2-authority-witness",
    revision: 1,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    manifest,
  };
  files.set(paths.stateCommitted, rawSource);
  files.set(paths.manifestCommitted, JSON.stringify(manifest));
  files.set(paths.witness.committed, JSON.stringify(witness));
  files.set(
    `${paths.forensicSourcePrefix}${sourceDigest}.json`,
    rawSource,
  );
  let pendingFault = fault ? { ...fault } : null;
  const match = (
    op: Fault["op"],
    input: { path?: string; from?: string; to?: string },
  ): Fault | null => {
    if (
      !pendingFault
      || pendingFault.op !== op
      || (
        pendingFault.path !== undefined
        && pendingFault.path !== input.path
      )
      || (
        pendingFault.from !== undefined
        && pendingFault.from !== input.from
      )
      || (
        pendingFault.to !== undefined
        && pendingFault.to !== input.to
      )
    ) return null;
    const matched = pendingFault;
    pendingFault = null;
    return matched;
  };
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      const active = match("write", { path });
      if (active?.timing === "before") throw new Error("write interrupted");
      files.set(path, value);
      if (active?.timing === "after") throw new Error("write response lost");
    }),
    process: vi.fn(async (
      path: string,
      fn: (value: string) => string,
    ) => {
      const active = match("process", { path });
      if (active?.timing === "before") throw new Error("process interrupted");
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      const next = fn(value);
      files.set(path, next);
      if (active?.timing === "after") {
        throw new Error("process response lost");
      }
      return next;
    }),
    remove: vi.fn(async (path: string) => {
      const active = match("remove", { path });
      if (active?.timing === "before") throw new Error("remove interrupted");
      files.delete(path);
      if (active?.timing === "after") throw new Error("remove response lost");
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const active = match("rename", { from, to });
      if (active?.timing === "before") throw new Error("rename interrupted");
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
      if (active?.timing === "after") throw new Error("rename response lost");
    }),
  };
  return {
    files,
    adapter: adapter as unknown as DataAdapter,
    hold,
    manifest,
    witness,
    rawSource,
    sourceDigest,
    setFault: (next: Fault) => {
      pendingFault = { ...next };
    },
  };
}

const persistenceFaults: Array<[string, Fault]> = [
  ["journal staged write not started", {
    op: "write",
    path: paths.publicationNext,
    timing: "before",
  }],
  ["journal staged write response lost", {
    op: "write",
    path: paths.publicationNext,
    timing: "after",
  }],
  ["journal promotion not started", {
    op: "rename",
    from: paths.publicationNext,
    to: paths.publicationCommitted,
    timing: "before",
  }],
  ["journal promotion response lost", {
    op: "rename",
    from: paths.publicationNext,
    to: paths.publicationCommitted,
    timing: "after",
  }],
  ["candidate staged write not started", {
    op: "write",
    path: paths.stateNext,
    timing: "before",
  }],
  ["candidate staged write response lost", {
    op: "write",
    path: paths.stateNext,
    timing: "after",
  }],
  ["source retirement not started", {
    op: "rename",
    from: paths.stateCommitted,
    to: paths.statePrevious,
    timing: "before",
  }],
  ["source retirement response lost", {
    op: "rename",
    from: paths.stateCommitted,
    to: paths.statePrevious,
    timing: "after",
  }],
  ["candidate promotion not started", {
    op: "rename",
    from: paths.stateNext,
    to: paths.stateCommitted,
    timing: "before",
  }],
  ["candidate promotion response lost", {
    op: "rename",
    from: paths.stateNext,
    to: paths.stateCommitted,
    timing: "after",
  }],
  ["manifest staged write not started", {
    op: "write",
    path: paths.manifestNext,
    timing: "before",
  }],
  ["manifest staged write response lost", {
    op: "write",
    path: paths.manifestNext,
    timing: "after",
  }],
  ["source manifest retirement not started", {
    op: "remove",
    path: paths.manifestCommitted,
    timing: "before",
  }],
  ["source manifest retirement response lost", {
    op: "remove",
    path: paths.manifestCommitted,
    timing: "after",
  }],
  ["target manifest promotion not started", {
    op: "rename",
    from: paths.manifestNext,
    to: paths.manifestCommitted,
    timing: "before",
  }],
  ["target manifest promotion response lost", {
    op: "rename",
    from: paths.manifestNext,
    to: paths.manifestCommitted,
    timing: "after",
  }],
  ["witness staged write not started", {
    op: "write",
    path: paths.witness.next,
    timing: "before",
  }],
  ["witness staged write response lost", {
    op: "write",
    path: paths.witness.next,
    timing: "after",
  }],
  ["witness atomic update not started", {
    op: "process",
    path: paths.witness.committed,
    timing: "before",
  }],
  ["witness atomic update response lost", {
    op: "process",
    path: paths.witness.committed,
    timing: "after",
  }],
];

const finalizationFaults: Array<[string, Fault]> = [
  ["source backup cleanup not started", {
    op: "remove",
    path: paths.statePrevious,
    timing: "before",
  }],
  ["source backup cleanup response lost", {
    op: "remove",
    path: paths.statePrevious,
    timing: "after",
  }],
  ["journal cleanup not started", {
    op: "remove",
    path: paths.publicationCommitted,
    timing: "before",
  }],
  ["journal cleanup response lost", {
    op: "remove",
    path: paths.publicationCommitted,
    timing: "after",
  }],
];

describe("CorruptStatePublicationV2Store", () => {
  it("publishes candidate, manifest, and witness while retaining exact forensic bytes", async () => {
    const harness = await makeHarness();
    const store = new CorruptStatePublicationV2Store(
      harness.adapter,
      paths,
    );

    const recovered = await store.commit({
      confirmedHold: harness.hold,
      sourceManifest: harness.manifest,
      sourceWitness: harness.witness,
      now: 50,
    });

    expect(recovered.envelope).toEqual(harness.hold.candidate);
    expect(recovered.manifest).toMatchObject({
      stateCommitSeq: 4,
      lifecycleEpoch: 3,
      scope,
    });
    expect(JSON.parse(harness.files.get(paths.witness.committed)!))
      .toMatchObject({
        revision: 2,
        manifest: {
          stateCommitSeq: 4,
          lifecycleEpoch: 3,
          scope,
        },
      });
    expect(harness.files.get(
      `${paths.forensicSourcePrefix}${harness.sourceDigest}.json`,
    )).toBe(harness.rawSource);
    expect(harness.files.has(paths.publicationCommitted)).toBe(true);
    expect(harness.files.get(paths.statePrevious)).toBe(harness.rawSource);

    await store.finalize(recovered.record);

    expect(harness.files.has(paths.publicationCommitted)).toBe(false);
    expect(harness.files.has(paths.statePrevious)).toBe(false);
    expect(harness.files.get(
      `${paths.forensicSourcePrefix}${harness.sourceDigest}.json`,
    )).toBe(harness.rawSource);
  });

  it.each(persistenceFaults)(
    "converges after %s",
    async (_name, fault) => {
      const harness = await makeHarness(fault);
      const input = {
        confirmedHold: harness.hold,
        sourceManifest: harness.manifest,
        sourceWitness: harness.witness,
        now: 50,
      };
      const first = new CorruptStatePublicationV2Store(
        harness.adapter,
        paths,
      );
      try {
        await first.commit(input);
      } catch {
        // The next process owns recovery from the durable prefix.
      }

      const restarted = new CorruptStatePublicationV2Store(
        harness.adapter,
        paths,
      );
      const recovered =
        await restarted.recover() ?? await restarted.commit(input);
      await restarted.finalize(recovered.record);

      expect(JSON.parse(harness.files.get(paths.stateCommitted)!))
        .toEqual(harness.hold.candidate);
      expect(JSON.parse(harness.files.get(paths.manifestCommitted)!))
        .toMatchObject({ stateCommitSeq: 4, lifecycleEpoch: 3, scope });
      expect(JSON.parse(harness.files.get(paths.witness.committed)!))
        .toMatchObject({
          revision: 2,
          manifest: { stateCommitSeq: 4, lifecycleEpoch: 3, scope },
        });
      expect(harness.files.has(paths.publicationCommitted)).toBe(false);
      expect(harness.files.has(paths.publicationNext)).toBe(false);
      expect(harness.files.has(paths.statePrevious)).toBe(false);
      expect(harness.files.get(
        `${paths.forensicSourcePrefix}${harness.sourceDigest}.json`,
      )).toBe(harness.rawSource);
    },
  );

  it.each(finalizationFaults)(
    "converges after %s",
    async (_name, fault) => {
      const harness = await makeHarness();
      const first = new CorruptStatePublicationV2Store(
        harness.adapter,
        paths,
      );
      const published = await first.commit({
        confirmedHold: harness.hold,
        sourceManifest: harness.manifest,
        sourceWitness: harness.witness,
        now: 50,
      });
      harness.setFault(fault);
      try {
        await first.finalize(published.record);
      } catch {
        // A new process must finish any cleanup that did not durably complete.
      }

      const restarted = new CorruptStatePublicationV2Store(
        harness.adapter,
        paths,
      );
      const recovered = await restarted.recover();
      if (recovered) await restarted.finalize(recovered.record);

      expect(JSON.parse(harness.files.get(paths.stateCommitted)!))
        .toEqual(harness.hold.candidate);
      expect(harness.files.has(paths.statePrevious)).toBe(false);
      expect(harness.files.has(paths.publicationCommitted)).toBe(false);
      expect(harness.files.has(paths.publicationNext)).toBe(false);
      expect(harness.files.get(
        `${paths.forensicSourcePrefix}${harness.sourceDigest}.json`,
      )).toBe(harness.rawSource);
    },
  );

  it("preserves unknown cleanup-slot contents instead of deleting evidence", async () => {
    for (const variant of [
      "previous-envelope",
      "staged-envelope",
      "staged-manifest",
      "staged-journal",
    ] as const) {
      const harness = await makeHarness();
      const store = new CorruptStatePublicationV2Store(
        harness.adapter,
        paths,
      );
      const published = await store.commit({
        confirmedHold: harness.hold,
        sourceManifest: harness.manifest,
        sourceWitness: harness.witness,
        now: 50,
      });
      let path: string;
      let value: string;
      if (variant === "previous-envelope") {
        path = paths.statePrevious;
        value = JSON.stringify(envelope(99, 99));
      } else if (variant === "staged-envelope") {
        path = paths.stateNext;
        value = harness.rawSource;
      } else if (variant === "staged-manifest") {
        path = paths.manifestNext;
        value = JSON.stringify(harness.manifest);
      } else {
        path = paths.publicationNext;
        value = JSON.stringify({
          ...published.record,
          createdAt: published.record.createdAt + 1,
        });
      }
      harness.files.set(path, value);

      await expect(store.finalize(published.record)).rejects.toThrow(
        "not owned by this transaction",
      );

      expect(harness.files.get(path)).toBe(value);
      expect(harness.files.has(paths.publicationCommitted)).toBe(true);
      expect(JSON.parse(harness.files.get(paths.stateCommitted)!))
        .toEqual(harness.hold.candidate);
    }
  });

  it("keeps every authority file unchanged when forensic source bytes differ", async () => {
    const harness = await makeHarness();
    harness.files.set(
      `${paths.forensicSourcePrefix}${harness.sourceDigest}.json`,
      "different",
    );
    const store = new CorruptStatePublicationV2Store(
      harness.adapter,
      paths,
    );

    await expect(store.commit({
      confirmedHold: harness.hold,
      sourceManifest: harness.manifest,
      sourceWitness: harness.witness,
      now: 50,
    })).rejects.toThrow("digest changed");

    expect(harness.files.get(paths.stateCommitted)).toBe(harness.rawSource);
    expect(JSON.parse(harness.files.get(paths.manifestCommitted)!))
      .toEqual(harness.manifest);
    expect(JSON.parse(harness.files.get(paths.witness.committed)!))
      .toEqual(harness.witness);
    expect(harness.files.has(paths.publicationCommitted)).toBe(true);
  });

  it("refuses to overlap ordinary publication or scope transition recovery", async () => {
    for (const conflict of [
      paths.stateRecovery,
      paths.scopeTransitionCommitted,
      paths.scopeTransitionNext,
    ]) {
      const harness = await makeHarness();
      harness.files.set(conflict, "{}");
      const store = new CorruptStatePublicationV2Store(
        harness.adapter,
        paths,
      );

      await expect(store.commit({
        confirmedHold: harness.hold,
        sourceManifest: harness.manifest,
        sourceWitness: harness.witness,
        now: 50,
      })).rejects.toThrow("conflicts with another state recovery");
      expect(harness.files.get(paths.stateCommitted)).toBe(harness.rawSource);
    }
  });

  it("removes an invalid staged-only journal before any authority mutation", async () => {
    const harness = await makeHarness();
    harness.files.set(paths.publicationNext, "{");
    const store = new CorruptStatePublicationV2Store(
      harness.adapter,
      paths,
    );

    await expect(store.recover()).resolves.toBeNull();

    expect(harness.files.has(paths.publicationNext)).toBe(false);
    expect(harness.files.get(paths.stateCommitted)).toBe(harness.rawSource);
    expect(JSON.parse(harness.files.get(paths.manifestCommitted)!))
      .toEqual(harness.manifest);
    expect(JSON.parse(harness.files.get(paths.witness.committed)!))
      .toEqual(harness.witness);
  });

  it("preserves and blocks on an unreadable committed journal", async () => {
    const harness = await makeHarness();
    harness.files.set(paths.publicationCommitted, "{");
    const store = new CorruptStatePublicationV2Store(
      harness.adapter,
      paths,
    );

    await expect(store.recover()).rejects.toMatchObject({
      reason: "corrupt-state-publication-unreadable",
    });

    expect(harness.files.get(paths.publicationCommitted)).toBe("{");
    expect(harness.files.get(paths.stateCommitted)).toBe(harness.rawSource);
  });

  it("preserves and blocks when committed and staged journals disagree", async () => {
    const harness = await makeHarness();
    const base = {
      schemaVersion: 1 as const,
      kind: "v2-corrupt-state-publication" as const,
      createdAt: 50,
      confirmedHold: harness.hold,
      sourceManifest: harness.manifest,
      sourceWitness: harness.witness,
    };
    harness.files.set(paths.publicationCommitted, JSON.stringify(base));
    harness.files.set(
      paths.publicationNext,
      JSON.stringify({ ...base, createdAt: 51 }),
    );
    const store = new CorruptStatePublicationV2Store(
      harness.adapter,
      paths,
    );

    await expect(store.recover()).rejects.toMatchObject({
      reason: "corrupt-state-publication-state-ambiguous",
    });

    expect(harness.files.has(paths.publicationCommitted)).toBe(true);
    expect(harness.files.has(paths.publicationNext)).toBe(true);
    expect(harness.files.get(paths.stateCommitted)).toBe(harness.rawSource);
  });
});
