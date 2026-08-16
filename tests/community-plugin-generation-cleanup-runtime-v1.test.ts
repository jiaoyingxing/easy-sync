import { describe, expect, it, vi } from "vitest";
import type { CommunityPluginGenerationCloudObjectV1 } from
  "../src/onedrive/types";
import {
  completeCommunityPluginGenerationCleanupV1,
  coordinateCommunityPluginGenerationClosingV1,
} from "../src/sync/community-plugin-generation-cleanup-runtime-v1";
import type { CommunityPluginGenerationCleanupCloudTransportV1 } from
  "../src/sync/community-plugin-generation-cleanup-cloud-v1";
import {
  stageCommunityPluginGenerationBundleV1,
  type CommunityPluginGenerationContentCloudTransportV1,
} from "../src/sync/community-plugin-generation-content-cloud-v1";
import {
  createCommunityPluginBundlePublicationCommandV1,
  createCommunityPluginGenerationContentGrantV1,
} from "../src/sync/community-plugin-generation-content-v1";
import {
  CommunityPluginLifecycleDeviceObserverV1,
  createCommunityPluginGenerationCleanupCheckpointStoreV1,
  createCommunityPluginLifecycleControlMutationCheckpointStoreV1,
  loadOrCreateCommunityPluginLifecycleDeviceIdentityV1,
} from "../src/sync/community-plugin-lifecycle-device-v1";
import type {
  CommunityPluginLifecycleCloudObjectV1,
  CommunityPluginLifecycleCloudTransportV1,
} from "../src/sync/community-plugin-lifecycle-cloud-v1";
import {
  createCommunityPluginLifecycleControlV1,
  reduceCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
} from "../src/sync/community-plugin-lifecycle-v1";
import type { DeviceCommunityPluginParticipationV1 } from
  "../src/sync/community-plugin-participation";
import type { VaultLocalStorage } from
  "../src/sync/indexeddb-vault-namespace";
import type { SyncScope } from "../src/sync/types";

const scope: SyncScope = {
  accountId: "account-runtime",
  driveId: "drive-runtime",
  vaultFolderId: "vault-runtime",
  filesRootId: "files-runtime",
};
const vaultInstanceId = "a".repeat(32);

function storageHarness(): VaultLocalStorage {
  const values = new Map<string, unknown>();
  return {
    loadLocalStorage(key) {
      const value = values.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    saveLocalStorage(key, value) {
      if (value === null) values.delete(key);
      else values.set(key, structuredClone(value));
    },
  };
}

function apply(
  state: CommunityPluginLifecycleControlV1,
  command: Omit<CommunityPluginLifecycleCommandV1, "scope" | "expectedRevision">,
): CommunityPluginLifecycleControlV1 {
  const result = reduceCommunityPluginLifecycleV1(state, {
    ...command,
    scope,
    expectedRevision: state.revision,
  } as CommunityPluginLifecycleCommandV1);
  if (result.status !== "applied") throw new Error(`fixture ${result.status}`);
  return result.state;
}

function lifecycleHarness(initial: CommunityPluginLifecycleControlV1): {
  transport: CommunityPluginLifecycleCloudTransportV1;
  state(): CommunityPluginLifecycleControlV1;
  updates: ReturnType<typeof vi.fn>;
} {
  let revision = 0;
  let current: CommunityPluginLifecycleCloudObjectV1 = {
    id: "lifecycle-runtime-id",
    eTag: "lifecycle-runtime-etag-0",
    content: JSON.stringify(initial),
  };
  const updates = vi.fn(async (id: string, eTag: string, content: string) => {
    if (id !== current.id || eTag !== current.eTag) throw new Error("412");
    revision += 1;
    current = {
      id,
      eTag: `lifecycle-runtime-etag-${revision}`,
      content,
    };
    return { id: current.id, eTag: current.eTag };
  });
  return {
    updates,
    state: () => JSON.parse(current.content) as CommunityPluginLifecycleControlV1,
    transport: {
      async read() {
        return structuredClone(current);
      },
      async createOnly() {
        throw new Error("already exists");
      },
      updateCas: updates,
      async readById(id) {
        if (id !== current.id) throw new Error("not found");
        return structuredClone(current);
      },
    },
  };
}

function contentHarness(): {
  transport: CommunityPluginGenerationContentCloudTransportV1;
  objectsById: Map<string, CommunityPluginGenerationCloudObjectV1>;
} {
  const objectsByPath = new Map<string, CommunityPluginGenerationCloudObjectV1>();
  const objectsById = new Map<string, CommunityPluginGenerationCloudObjectV1>();
  const transport: CommunityPluginGenerationContentCloudTransportV1 = {
    async createOnly(objectPath, content) {
      if (objectsByPath.has(objectPath)) throw new Error("already exists");
      const object: CommunityPluginGenerationCloudObjectV1 = {
        id: `content-${objectsById.size + 1}`,
        name: objectPath.split("/").pop()!,
        parentId: "content-parent",
        size: content.byteLength,
        eTag: `content-etag-${objectsById.size + 1}`,
        cTag: `content-ctag-${objectsById.size + 1}`,
        content: content.slice(0),
      };
      objectsByPath.set(objectPath, object);
      objectsById.set(object.id, object);
      return {
        id: object.id,
        name: object.name,
        size: object.size,
        eTag: object.eTag,
        cTag: object.cTag,
        parentReference: { id: object.parentId },
      };
    },
    async readByPath(path) {
      return structuredClone(objectsByPath.get(path) ?? null);
    },
    async readById(id) {
      const object = objectsById.get(id);
      if (!object) throw new Error("not found");
      return structuredClone(object);
    },
  };
  return { transport, objectsById };
}

function excludedParticipation(pluginId = "plugin-directory"):
DeviceCommunityPluginParticipationV1 {
  return {
    schemaVersion: 1,
    kind: "device-community-plugin-participation",
    scopeEnabled: true,
    pluginsById: {
      [pluginId]: { pluginId, phase: "excluded" },
    },
  };
}

async function runtimeFixture(withJoinedSecondDevice = false) {
  const storage = storageHarness();
  const identity = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
    storage,
    vaultInstanceId,
    10,
  )!;
  const second = {
    participantId: "participant-second-device",
    incarnation: "incarnation-second-device",
  };
  let state = createCommunityPluginLifecycleControlV1(scope);
  state = apply(state, {
    type: "register-participant",
    participant: identity.participant,
    operationId: "register-owner",
    at: 10,
  });
  if (withJoinedSecondDevice) {
    state = apply(state, {
      type: "register-participant",
      participant: second,
      operationId: "register-second",
      at: 10,
    });
  }
  state = apply(state, {
    type: "confirm-legacy-migration",
    actor: identity.participant,
    evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
    operationId: "confirm-legacy",
    at: 11,
  });
  state = apply(state, {
    type: "join-plugin",
    participant: identity.participant,
    pluginId: "plugin-directory",
    targetGeneration: 1,
    joinNonce: "owner-join",
    joinEvidence: "user-confirmed",
    operationId: "join-owner",
    at: 12,
  });
  if (withJoinedSecondDevice) {
    state = apply(state, {
      type: "join-plugin",
      participant: second,
      pluginId: "plugin-directory",
      targetGeneration: 1,
      joinNonce: "second-join",
      joinEvidence: "user-confirmed",
      operationId: "join-second",
      at: 12,
    });
  }
  const grant = createCommunityPluginGenerationContentGrantV1({
    control: state,
    scope,
    participant: identity.participant,
    pluginId: "plugin-directory",
  });
  if (grant.status !== "ready") throw new Error("grant missing");
  const content = contentHarness();
  const staged = await stageCommunityPluginGenerationBundleV1({
    transport: content.transport,
    grant: grant.grant,
    control: state,
    files: [
      { fileName: "main.js", content: new TextEncoder().encode("main").buffer },
      {
        fileName: "manifest.json",
        content: new TextEncoder().encode(JSON.stringify({
          id: "logical-plugin",
          name: "Logical Plugin",
          version: "1.0.0",
        })).buffer,
      },
    ],
  });
  if (staged.status !== "ready") throw new Error("stage failed");
  const publication = await createCommunityPluginBundlePublicationCommandV1({
    grant: grant.grant,
    control: state,
    prepared: staged.receipt.prepared,
    manifestObject: staged.receipt.manifestObject,
    operationId: "publish-bundle",
    at: 13,
  });
  state = apply(state, publication);
  const published = state.pluginsById["plugin-directory"]
    .currentGeneration!.publishedBundle!;
  state = apply(state, {
    type: "seal-plugin-legacy-authority",
    actor: identity.participant,
    pluginId: "plugin-directory",
    generation: 1,
    publishedBundle: published,
    operationId: "seal-bundle",
    at: 14,
  });
  const lifecycle = lifecycleHarness(state);
  return {
    storage,
    identity,
    lifecycle,
    content,
    observer: new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceId,
    ),
    cleanupStore: createCommunityPluginGenerationCleanupCheckpointStoreV1(storage),
    controlStore: createCommunityPluginLifecycleControlMutationCheckpointStoreV1(storage),
  };
}

function cleanupTransport(
  objects: Map<string, CommunityPluginGenerationCloudObjectV1>,
) {
  const deletes = vi.fn(async (id: string) => {
    objects.delete(id);
  });
  const transport: CommunityPluginGenerationCleanupCloudTransportV1 = {
    async readById(id) {
      const object = objects.get(id);
      return object
        ? {
          id: object.id,
          name: object.name,
          parentId: object.parentId,
          size: object.size,
          eTag: object.eTag,
          cTag: object.cTag,
        }
        : null;
    },
    deleteById: deletes,
  };
  return { transport, deletes };
}

describe("community-plugin generation cleanup production coordinator v1", () => {
  it("records the local exit and freezes one alias-safe cleanup without deleting", async () => {
    const fixture = await runtimeFixture();
    const result = await coordinateCommunityPluginGenerationClosingV1({
      observer: fixture.observer,
      lifecycleTransport: fixture.lifecycle.transport,
      contentTransport: fixture.content.transport,
      cleanupCheckpointStore: fixture.cleanupStore,
      scope,
      participation: excludedParticipation(),
      at: 20,
      createOperationId: () => `operation-${fixture.lifecycle.updates.mock.calls.length}`,
    });

    expect(result.status).toBe("cleanup-ready");
    if (result.status !== "cleanup-ready") return;
    expect(result.exitedPluginIds).toEqual(["plugin-directory"]);
    expect(result.snapshot).toMatchObject({
      pluginId: "plugin-directory",
      schemaVersion: 2,
      pluginId: "plugin-directory",
    });
    expect(fixture.lifecycle.state().pluginsById["plugin-directory"]
      .currentGeneration?.phase).toBe("closing");
    expect(fixture.content.objectsById.size).toBe(3);
  });

  it("reuses a snapshot-only checkpoint after restart without repeating control writes", async () => {
    const fixture = await runtimeFixture();
    const first = await coordinateCommunityPluginGenerationClosingV1({
      observer: fixture.observer,
      lifecycleTransport: fixture.lifecycle.transport,
      contentTransport: fixture.content.transport,
      cleanupCheckpointStore: fixture.cleanupStore,
      scope,
      participation: excludedParticipation(),
      at: 20,
      createOperationId: () => `operation-${fixture.lifecycle.updates.mock.calls.length}`,
    });
    expect(first.status).toBe("cleanup-ready");
    const writesAfterFirstRun = fixture.lifecycle.updates.mock.calls.length;

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(
      fixture.storage,
      vaultInstanceId,
    );
    const second = await coordinateCommunityPluginGenerationClosingV1({
      observer: restarted,
      lifecycleTransport: fixture.lifecycle.transport,
      contentTransport: fixture.content.transport,
      cleanupCheckpointStore: fixture.cleanupStore,
      scope,
      participation: excludedParticipation(),
      at: 30,
      createOperationId: () => "must-not-be-used",
    });

    expect(second.status).toBe("cleanup-ready");
    expect(fixture.lifecycle.updates).toHaveBeenCalledTimes(writesAfterFirstRun);
    expect(fixture.content.objectsById.size).toBe(3);
  });

  it("blocks changed immutable bundle evidence before creating a cleanup checkpoint", async () => {
    const fixture = await runtimeFixture();
    const publishedManifestId = fixture.lifecycle.state()
      .pluginsById["plugin-directory"].currentGeneration!
      .publishedBundle!.manifestObject.remoteId;
    const changed = fixture.content.objectsById.get(publishedManifestId)!;
    changed.eTag = "changed-after-publication";

    const result = await coordinateCommunityPluginGenerationClosingV1({
      observer: fixture.observer,
      lifecycleTransport: fixture.lifecycle.transport,
      contentTransport: fixture.content.transport,
      cleanupCheckpointStore: fixture.cleanupStore,
      scope,
      participation: excludedParticipation(),
      at: 20,
      createOperationId: () => `operation-${fixture.lifecycle.updates.mock.calls.length}`,
    });

    expect(result).toMatchObject({
      status: "blocked",
      phase: "snapshot",
      reason: "bundle-manifest-changed",
    });
    await expect(fixture.cleanupStore.load()).resolves.toBeNull();
  });

  it("keeps the generation open while another registered device is still joined", async () => {
    const fixture = await runtimeFixture(true);
    const result = await coordinateCommunityPluginGenerationClosingV1({
      observer: fixture.observer,
      lifecycleTransport: fixture.lifecycle.transport,
      contentTransport: fixture.content.transport,
      cleanupCheckpointStore: fixture.cleanupStore,
      scope,
      participation: excludedParticipation(),
      at: 20,
      createOperationId: () => `operation-${fixture.lifecycle.updates.mock.calls.length}`,
    });

    expect(result).toMatchObject({
      status: "idle",
      exitedPluginIds: ["plugin-directory"],
    });
    expect(fixture.lifecycle.state().pluginsById["plugin-directory"]
      .currentGeneration?.phase).toBe("open");
    await expect(fixture.cleanupStore.load()).resolves.toBeNull();
  });

  it("completes exact bundle cleanup without reading or editing enablement", async () => {
    const fixture = await runtimeFixture();
    const coordinated = await coordinateCommunityPluginGenerationClosingV1({
      observer: fixture.observer,
      lifecycleTransport: fixture.lifecycle.transport,
      contentTransport: fixture.content.transport,
      cleanupCheckpointStore: fixture.cleanupStore,
      scope,
      participation: excludedParticipation(),
      at: 20,
      createOperationId: () => `operation-${fixture.lifecycle.updates.mock.calls.length}`,
    });
    if (coordinated.status !== "cleanup-ready") {
      throw new Error("cleanup was not prepared");
    }
    const cleanup = cleanupTransport(fixture.content.objectsById);
    const completed = await completeCommunityPluginGenerationCleanupV1({
      lifecycleTransport: fixture.lifecycle.transport,
      cleanupTransport: cleanup.transport,
      cleanupCheckpointStore: fixture.cleanupStore,
      controlCheckpointStore: fixture.controlStore,
      scope,
      at: 30,
      operationId: "complete-cleanup",
    });

    expect(completed).toEqual({
      status: "completed",
      pluginId: "plugin-directory",
      generation: 1,
    });
    expect(cleanup.deletes).toHaveBeenCalledTimes(3);
    expect(fixture.lifecycle.state().pluginsById["plugin-directory"]
      .currentGeneration?.phase).toBe("closed");
    await expect(fixture.cleanupStore.load()).resolves.toBeNull();
  });
});
