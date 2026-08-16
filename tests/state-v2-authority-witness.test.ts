import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { getEasySyncPaths } from "../src/obsidian-compat";
import {
  StateV2AuthorityWitnessLoadError,
  StateV2AuthorityWitnessStore,
  type StateV2IndexedDbStorageAuthority,
} from "../src/sync/state-v2-authority-witness";
import type { StateV2Manifest } from "../src/sync/state-v2-migration";
import type { SharedSyncProtocolBinding } from "../src/sync/sync-protocol-v3";

const paths = getEasySyncPaths(".obsidian");
const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const manifest: StateV2Manifest = {
  schemaVersion: 2,
  activeState: "state-v2.json",
  stateCommitSeq: 3,
  lifecycleEpoch: 7,
  scope,
  migratedAt: 10,
  legacyAutoSyncAllowed: false,
};
const indexedDbStorage: StateV2IndexedDbStorageAuthority = {
  schemaVersion: 1,
  kind: "indexeddb",
  databaseId: "a".repeat(32),
  stateCommitSeq: 3,
  lifecycleEpoch: 7,
  stateDigest: "b".repeat(64),
  selectedAt: 30,
};
const protocolV2: SharedSyncProtocolBinding = {
  schemaVersion: 1,
  protocolVersion: 2,
  migrationGeneration: "c".repeat(64),
  confirmedAllDevicesUpdatedAt: 11,
  recordId: "v2-id",
  recordETag: "v2-etag",
};
const protocolV3: SharedSyncProtocolBinding = {
  schemaVersion: 1,
  protocolVersion: 3,
  migrationGeneration: "c".repeat(64),
  predecessorProtocolVersion: 2,
  predecessorContentSha256: "d".repeat(64),
  predecessorConfirmedAllDevicesUpdatedAt: 11,
  createdAt: 11,
  contentSha256: "e".repeat(64),
  recordId: "v3-id",
  recordETag: "v3-etag",
};

function makeHarness() {
  const files = new Map<string, string>();
  const rawAdapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
    process: vi.fn(async (
      path: string,
      fn: (value: string) => string,
    ) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      const next = fn(value);
      files.set(path, next);
      return next;
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
  };
  const store = new StateV2AuthorityWitnessStore(
    rawAdapter as unknown as DataAdapter,
    {
      committed: paths.stateV2AuthorityWitnessFile,
      next: paths.stateV2AuthorityWitnessNextFile,
    },
  );
  return { files, rawAdapter, store };
}

describe("StateV2AuthorityWitnessStore", () => {
  it("publishes active authority only after a read-back-verified staged record", async () => {
    const harness = makeHarness();

    const active = await harness.store.publishActive(manifest, 20);

    expect(active).toMatchObject({
      revision: 1,
      status: "active",
      manifest,
    });
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
    expect(harness.rawAdapter.rename).not.toHaveBeenCalled();
  });

  it("publishes on an older host after installing structuredClone compatibility", async () => {
    const harness = makeHarness();
    vi.stubGlobal("structuredClone", undefined);

    try {
      await import("../src/structured-clone-compat");
      expect(typeof globalThis.structuredClone).toBe("function");

      await expect(harness.store.publishActive(manifest, 20))
        .resolves.toMatchObject({ manifest });
      expect(harness.rawAdapter.write).toHaveBeenCalled();
      expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
      expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recovers when the first committed write is interrupted before it starts", async () => {
    const harness = makeHarness();
    const baseWrite = harness.rawAdapter.write.getMockImplementation()!;
    let interruptCommittedWrite = true;
    harness.rawAdapter.write.mockImplementation(
      async (path: string, value: string) => {
        if (
          interruptCommittedWrite
          && path === paths.stateV2AuthorityWitnessFile
        ) {
          interruptCommittedWrite = false;
          throw new Error("initial committed write interrupted");
        }
        return baseWrite(path, value);
      },
    );

    await expect(harness.store.publishActive(manifest, 20))
      .rejects.toThrow("initial committed write interrupted");
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(true);

    await expect(harness.store.load()).resolves.toMatchObject({
      revision: 1,
      status: "active",
      manifest,
    });
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
  });

  it("recovers when the first committed write response is lost", async () => {
    const harness = makeHarness();
    const baseWrite = harness.rawAdapter.write.getMockImplementation()!;
    let loseCommittedWriteResponse = true;
    harness.rawAdapter.write.mockImplementation(
      async (path: string, value: string) => {
        await baseWrite(path, value);
        if (
          loseCommittedWriteResponse
          && path === paths.stateV2AuthorityWitnessFile
        ) {
          loseCommittedWriteResponse = false;
          throw new Error("initial committed write response lost");
        }
      },
    );

    await expect(harness.store.publishActive(manifest, 20))
      .rejects.toThrow("initial committed write response lost");
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(true);

    await expect(harness.store.load()).resolves.toMatchObject({
      revision: 1,
      status: "active",
      manifest,
    });
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
  });

  it("discards a staged retirement while committed V2 authority remains intact", async () => {
    const harness = makeHarness();
    await harness.store.publishActive(manifest, 20);
    const committed = JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    );
    const staged = {
      ...committed,
      revision: 2,
      status: "retired",
      updatedAt: 30,
      sourceCommitSeq: 5,
      targetScope: scope,
    };
    harness.files.set(
      paths.stateV2AuthorityWitnessNextFile,
      JSON.stringify(staged),
    );

    const recovered = await harness.store.load();

    expect(recovered).toEqual(committed);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toEqual(committed);
  });

  it("discards an unreadable staged candidate while committed authority remains intact", async () => {
    const harness = makeHarness();
    const active = await harness.store.publishActive(manifest, 20);
    harness.files.set(paths.stateV2AuthorityWitnessNextFile, "{");

    await expect(harness.store.load()).resolves.toEqual(active);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
  });

  it("selects IndexedDB last and recovers a staged storage transition", async () => {
    const harness = makeHarness();
    const active = await harness.store.publishActive(manifest, 20);
    const staged = {
      ...active,
      revision: active.revision + 1,
      updatedAt: 30,
      storageAuthority: indexedDbStorage,
    };
    harness.files.set(
      paths.stateV2AuthorityWitnessNextFile,
      JSON.stringify(staged),
    );

    await expect(harness.store.load()).resolves.toEqual(staged);
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toEqual(staged);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
  });

  it("updates an existing witness atomically without deleting its committed path", async () => {
    const harness = makeHarness();
    const active = await harness.store.publishActive(manifest, 20);

    const selected = await harness.store.selectIndexedDbStorage({
      expectedManifest: manifest,
      expectedRevision: active.revision,
      storageAuthority: indexedDbStorage,
      now: 30,
    });

    expect(selected.storageAuthority).toEqual(indexedDbStorage);
    expect(harness.rawAdapter.process).toHaveBeenCalledWith(
      paths.stateV2AuthorityWitnessFile,
      expect.any(Function),
    );
    expect(harness.rawAdapter.remove).not.toHaveBeenCalledWith(
      paths.stateV2AuthorityWitnessFile,
    );
    expect(harness.rawAdapter.rename).not.toHaveBeenCalled();
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
  });

  it("upgrades only the protocol binding on an unchanged active witness", async () => {
    const harness = makeHarness();
    const active = await harness.store.publishActive(manifest, 20, protocolV2);

    const upgraded = await harness.store.upgradeProtocolBinding({
      expectedManifest: manifest,
      expectedRevision: active.revision,
      expectedBinding: protocolV2,
      nextBinding: protocolV3,
      now: 30,
    });

    expect(upgraded).toMatchObject({
      revision: active.revision + 1,
      manifest,
      protocolBinding: protocolV3,
    });
    await expect(harness.store.upgradeProtocolBinding({
      expectedManifest: manifest,
      expectedRevision: upgraded.revision,
      expectedBinding: protocolV3,
      nextBinding: { ...protocolV3, migrationGeneration: "f".repeat(64) },
    })).rejects.toThrow("binding upgrade is not authorized");
  });

  it("does not overwrite a witness that changes during its atomic update", async () => {
    const harness = makeHarness();
    const active = await harness.store.publishActive(manifest, 20);
    const concurrent = {
      ...active,
      revision: active.revision + 1,
      updatedAt: 25,
    };
    harness.rawAdapter.process.mockImplementationOnce(
      async (
        path: string,
        fn: (value: string) => string,
      ) => {
        const concurrentRaw = JSON.stringify(concurrent);
        harness.files.set(path, concurrentRaw);
        return fn(concurrentRaw);
      },
    );

    await expect(harness.store.selectIndexedDbStorage({
      expectedManifest: manifest,
      expectedRevision: active.revision,
      storageAuthority: indexedDbStorage,
      now: 30,
    })).rejects.toThrow("changed during atomic update");

    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toEqual(concurrent);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(true);
  });

  it("replaces a lost database only with a fresh exact identity", async () => {
    const harness = makeHarness();
    const active = await harness.store.publishActive(manifest, 20);
    const selected = await harness.store.selectIndexedDbStorage({
      expectedManifest: manifest,
      expectedRevision: active.revision,
      storageAuthority: indexedDbStorage,
      now: 30,
    });
    const replacement: StateV2IndexedDbStorageAuthority = {
      ...indexedDbStorage,
      databaseId: "c".repeat(32),
      selectedAt: 40,
    };

    const replaced = await harness.store.replaceIndexedDbStorage({
      expectedManifest: manifest,
      expectedRevision: selected.revision,
      expectedStorageAuthority: indexedDbStorage,
      nextStorageAuthority: replacement,
      now: 40,
    });

    expect(replaced).toMatchObject({
      revision: 3,
      storageAuthority: replacement,
    });
    await expect(harness.store.replaceIndexedDbStorage({
      expectedManifest: manifest,
      expectedRevision: replaced.revision,
      expectedStorageAuthority: replacement,
      nextStorageAuthority: {
        ...replacement,
        databaseId: "d".repeat(32),
        stateDigest: "e".repeat(64),
        selectedAt: 50,
      },
    })).rejects.toThrow(
      "V2 IndexedDB storage authority replacement is not authorized",
    );
  });

  it("never downgrades a Vault-scoped storage binding to the legacy schema", async () => {
    const harness = makeHarness();
    const active = await harness.store.publishActive(manifest, 20);
    const scoped: StateV2IndexedDbStorageAuthority = {
      ...indexedDbStorage,
      schemaVersion: 2,
      vaultInstanceId: "1".repeat(32),
    };
    const selected = await harness.store.selectIndexedDbStorage({
      expectedManifest: manifest,
      expectedRevision: active.revision,
      storageAuthority: scoped,
      now: 30,
    });

    await expect(harness.store.replaceIndexedDbStorage({
      expectedManifest: manifest,
      expectedRevision: selected.revision,
      expectedStorageAuthority: scoped,
      nextStorageAuthority: {
        ...indexedDbStorage,
        databaseId: "c".repeat(32),
        selectedAt: 40,
      },
      now: 40,
    })).rejects.toThrow(
      "V2 IndexedDB storage authority replacement is not authorized",
    );
  });

  it("returns to exact JSON storage without reopening V1 authority", async () => {
    const harness = makeHarness();
    const active = await harness.store.publishActive(manifest, 20);
    const selected = await harness.store.selectIndexedDbStorage({
      expectedManifest: manifest,
      expectedRevision: active.revision,
      storageAuthority: indexedDbStorage,
      now: 30,
    });

    const jsonSelected = await harness.store.selectJsonStorage({
      expectedManifest: manifest,
      expectedRevision: selected.revision,
      expectedStorageAuthority: indexedDbStorage,
      now: 40,
    });

    expect(jsonSelected).toMatchObject({
      revision: 3,
      status: "active",
      manifest,
    });
    expect(jsonSelected.storageAuthority).toBeUndefined();
  });

  it("fails closed when committed authority is unreadable", async () => {
    const harness = makeHarness();
    harness.files.set(paths.stateV2AuthorityWitnessFile, "{");
    harness.files.set(paths.stateV2AuthorityWitnessNextFile, JSON.stringify({
      schemaVersion: 1,
      kind: "state-v2-authority-witness",
      revision: 2,
      status: "retired",
      createdAt: 20,
      updatedAt: 30,
      manifest,
      sourceCommitSeq: 5,
      targetScope: scope,
    }));

    await expect(harness.store.load()).rejects.toEqual(
      expect.objectContaining<StateV2AuthorityWitnessLoadError>({
        reason: "authority-witness-unreadable",
      }),
    );
  });

  it("rejects a committed retired witness instead of exposing V1", async () => {
    const harness = makeHarness();
    harness.files.set(paths.stateV2AuthorityWitnessFile, JSON.stringify({
      schemaVersion: 1,
      kind: "state-v2-authority-witness",
      revision: 2,
      status: "retired",
      createdAt: 20,
      updatedAt: 30,
      manifest,
      sourceCommitSeq: 5,
      targetScope: scope,
    }));

    await expect(harness.store.load()).rejects.toEqual(
      expect.objectContaining<StateV2AuthorityWitnessLoadError>({
        reason: "authority-witness-unsupported",
      }),
    );
  });
});
