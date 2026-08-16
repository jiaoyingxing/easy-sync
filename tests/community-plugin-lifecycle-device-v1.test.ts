import { describe, expect, it, vi } from "vitest";
import type { CommunityPluginGenerationCloudObjectV1 } from "../src/onedrive/types";
import {
  COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY,
  COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY,
  COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
  COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_INTERVAL_MS,
  COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
  CommunityPluginLifecycleDeviceObserverV1,
  loadOrCreateCommunityPluginLifecycleDeviceIdentityV1,
  readCommunityPluginLifecycleDeviceIdentityV1,
} from "../src/sync/community-plugin-lifecycle-device-v1";
import type {
  CommunityPluginLifecycleCloudObjectV1,
  CommunityPluginLifecycleCloudTransportV1,
} from "../src/sync/community-plugin-lifecycle-cloud-v1";
import type { CommunityPluginGenerationContentCloudTransportV1 } from "../src/sync/community-plugin-generation-content-cloud-v1";
import {
  communityPluginPublishedManifestObjectPathV1,
  createCommunityPluginLifecycleControlV1,
  reduceCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginParticipantIdentityV1,
} from "../src/sync/community-plugin-lifecycle-v1";
import type { VaultLocalStorage } from "../src/sync/indexeddb-vault-namespace";

const vaultInstanceA = "a".repeat(32);
const vaultInstanceB = "b".repeat(32);
const scope = {
  accountId: "account-device",
  driveId: "drive-device",
  vaultFolderId: "vault-device",
  filesRootId: "files-device",
};

function storageHarness(): VaultLocalStorage & {
  values: Map<string, unknown>;
  failSaveFor: Set<string>;
} {
  const values = new Map<string, unknown>();
  const failSaveFor = new Set<string>();
  return {
    values,
    failSaveFor,
    loadLocalStorage(key) {
      const value = values.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    saveLocalStorage(key, value) {
      if (failSaveFor.has(key)) throw new Error("storage unavailable");
      if (value === null) values.delete(key);
      else values.set(key, structuredClone(value));
    },
  };
}

function cloudHarness(initial: CommunityPluginLifecycleControlV1 | null = null): {
  transport: CommunityPluginLifecycleCloudTransportV1;
  read: ReturnType<typeof vi.fn>;
  createOnly: ReturnType<typeof vi.fn>;
  updateCas: ReturnType<typeof vi.fn>;
  readById: ReturnType<typeof vi.fn>;
  current(): CommunityPluginLifecycleCloudObjectV1 | null;
} {
  let tag = 0;
  let current: CommunityPluginLifecycleCloudObjectV1 | null = initial
    ? { id: "lifecycle-id", eTag: "etag-0", content: JSON.stringify(initial) }
    : null;
  const read = vi.fn(async () => current);
  const createOnly = vi.fn(async (content: string) => {
    if (current) throw new Error("conflict");
    tag += 1;
    current = { id: "lifecycle-id", eTag: `etag-${tag}`, content };
    return { id: current.id, eTag: current.eTag };
  });
  const updateCas = vi.fn(async (id: string, eTag: string, content: string) => {
    if (!current || current.id !== id || current.eTag !== eTag) throw new Error("412");
    tag += 1;
    current = { ...current, eTag: `etag-${tag}`, content };
    return { id: current.id, eTag: current.eTag };
  });
  const readById = vi.fn(async (id: string) => {
    if (!current || current.id !== id) throw new Error("not found");
    return current;
  });
  return {
    transport: { read, createOnly, updateCas, readById },
    read,
    createOnly,
    updateCas,
    readById,
    current: () => current,
  };
}

function contentHarness(): {
  transport: CommunityPluginGenerationContentCloudTransportV1;
  createOnly: ReturnType<typeof vi.fn>;
  objects: Map<string, CommunityPluginGenerationCloudObjectV1>;
} {
  const objects = new Map<string, CommunityPluginGenerationCloudObjectV1>();
  const createOnly = vi.fn(async (objectPath: string, content: ArrayBuffer) => {
    if (objects.has(objectPath)) throw new Error("name conflict");
    const object: CommunityPluginGenerationCloudObjectV1 = {
      id: `generation-object-${objects.size + 1}`,
      name: objectPath.split("/").at(-1)!,
      parentId: "generation-parent",
      size: content.byteLength,
      eTag: `generation-etag-${objects.size + 1}`,
      cTag: `generation-ctag-${objects.size + 1}`,
      content,
    };
    objects.set(objectPath, object);
    return {
      id: object.id,
      name: object.name,
      size: object.size,
      eTag: object.eTag,
      cTag: object.cTag,
      parentReference: { id: object.parentId },
    };
  });
  return {
    objects,
    createOnly,
    transport: {
      createOnly,
      readByPath: vi.fn(async (objectPath: string) => objects.get(objectPath) ?? null),
      readById: vi.fn(async (id: string) => {
        const object = [...objects.values()].find((candidate) => candidate.id === id);
        if (!object) throw new Error("missing generation object");
        return object;
      }),
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
  if (result.status !== "applied") throw new Error(`fixture command ${result.status}`);
  return result.state;
}

function publicationDeviceFixture(storage: VaultLocalStorage) {
  const identity = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
    storage,
    vaultInstanceA,
    10,
  )!;
  let state = createCommunityPluginLifecycleControlV1(scope);
  state = apply(state, {
    type: "register-participant",
    participant: identity.participant,
    operationId: "register-publication-device",
    at: 10,
  });
  state = apply(state, {
    type: "join-plugin",
    participant: identity.participant,
    pluginId: "calendar",
    targetGeneration: 1,
    joinNonce: "calendar-join",
    joinEvidence: "host-install",
    operationId: "join-calendar",
    at: 11,
  });
  state = apply(state, {
    type: "confirm-legacy-migration",
    actor: identity.participant,
    evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
    operationId: "confirm-before-publication",
    at: 12,
  });
  const manifestHash = "a".repeat(64);
  const command = {
    type: "publish-plugin-bundle" as const,
    participant: identity.participant,
    pluginId: "calendar",
    generation: 1,
    joinNonce: "calendar-join",
    fenceEpoch: state.fenceEpoch,
    manifestObject: {
      objectPath: communityPluginPublishedManifestObjectPathV1(
        "calendar",
        1,
        manifestHash,
      ),
      remoteId: "manifest-id",
      parentId: "manifest-parent",
      size: 100,
      eTag: "manifest-etag",
      cTag: "manifest-ctag",
      sha256Hash: manifestHash,
    },
    operationId: "publish-device-bundle",
    expectedRevision: state.revision,
    scope,
    at: 13,
  };
  return {
    identity,
    state,
    command,
    publishedState: apply(state, command),
  };
}

describe("community-plugin lifecycle S7b device-local observer", () => {
  it("returns only the current vault-bound participant identity", () => {
    const storage = storageHarness();
    const identity = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceA,
      10,
    )!;
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    expect(observer.getParticipantIdentity()).toEqual(identity.participant);
    expect(new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceB,
    ).getParticipantIdentity()).toBeNull();
  });

  it("keeps one identity for a Vault instance and creates a new identity for another instance", () => {
    const storage = storageHarness();
    const first = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceA,
      10,
    );
    const same = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceA,
      20,
    );
    const copiedVault = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceB,
      30,
    );

    expect(first).not.toBeNull();
    expect(same).toEqual(first);
    expect(copiedVault?.vaultInstanceId).toBe(vaultInstanceB);
    expect(copiedVault?.participant).not.toEqual(first?.participant);
  });

  it("persists the command before cloud creation and clears it only after read-back", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    cloud.createOnly.mockImplementationOnce(async (content: string) => {
      expect(storage.values.has(
        COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
      )).toBe(true);
      return { id: "lifecycle-id", eTag: "etag-1" };
    });
    cloud.readById.mockImplementationOnce(async () => {
      const checkpoint = storage.values.get(
        COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
      ) as { command: CommunityPluginLifecycleCommandV1 };
      let state = createCommunityPluginLifecycleControlV1(scope);
      const result = reduceCommunityPluginLifecycleV1(state, checkpoint.command);
      if (result.status !== "applied") throw new Error("checkpoint command not applicable");
      state = result.state;
      return {
        id: "lifecycle-id",
        eTag: "etag-1",
        content: JSON.stringify(state),
      };
    });
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(observer.observe(cloud.transport, scope, 10))
      .resolves.toMatchObject({ status: "ready", source: "created" });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
    )).toBe(false);
    expect(observer.isObservationDue(
      10 + COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_INTERVAL_MS - 1,
    )).toBe(false);
    expect(observer.isObservationDue(
      10 + COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_INTERVAL_MS,
    )).toBe(true);
  });

  it("persists and clears the one-time legacy migration confirmation on the same device queue", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await observer.observe(cloud.transport, scope, 10);
    const originalUpdate = cloud.updateCas.getMockImplementation();
    if (!originalUpdate) throw new Error("CAS fixture missing");
    cloud.updateCas.mockImplementationOnce(async (...args: [string, string, string]) => {
      expect(storage.values.has(
        COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
      )).toBe(true);
      return originalUpdate(...args);
    });

    await expect(observer.confirmLegacyMigration(cloud.transport, scope, 20))
      .resolves.toMatchObject({
        status: "ready",
        source: "updated",
        state: {
          fenceEpoch: 1,
          legacyMigrationConsent: {
            confirmedAt: 20,
            evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
          },
        },
      });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(false);
  });

  it("persists a generation join before CAS and recovers it after a cold restart", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    const first = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await first.observe(cloud.transport, scope, 10);
    const originalUpdate = cloud.updateCas.getMockImplementation();
    if (!originalUpdate) throw new Error("CAS fixture missing");
    cloud.updateCas.mockImplementationOnce(async (...args: [string, string, string]) => {
      expect(storage.values.has(
        COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
      )).toBe(true);
      const written = await originalUpdate(...args);
      cloud.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error(`response lost after ${written.id}`);
    });

    const join = {
      scope,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "calendar-device-join",
      joinEvidence: "user-confirmed" as const,
      joinedAt: 20,
    };
    await expect(first.joinPluginGeneration(cloud.transport, join))
      .resolves.toMatchObject({ status: "uncertain" });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(true);

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await expect(restarted.joinPluginGeneration(cloud.transport, {
      ...join,
      joinedAt: 30,
    })).resolves.toMatchObject({
      status: "ready",
      source: "recovered",
      state: {
        pluginsById: {
          calendar: {
            currentGeneration: {
              membersByKey: {
                [`${readCommunityPluginLifecycleDeviceIdentityV1(storage)!.participant.participantId}`
                  + `::${readCommunityPluginLifecycleDeviceIdentityV1(storage)!.participant.incarnation}`]: {
                  joinNonce: "calendar-device-join",
                },
              },
            },
          },
        },
      },
    });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(false);
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
  });

  it("persists an exact local exit on the existing lifecycle queue", async () => {
    const storage = storageHarness();
    const identity = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceA,
      10,
    )!;
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = apply(state, {
      type: "register-participant",
      participant: identity.participant,
      operationId: "register-exit-device",
      at: 10,
    });
    state = apply(state, {
      type: "join-plugin",
      participant: identity.participant,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "exit-device-join",
      joinEvidence: "user-confirmed",
      operationId: "join-before-exit",
      at: 11,
    });
    const cloud = cloudHarness(state);
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    const result = await observer.transitionLifecycle(cloud.transport, {
      type: "exit-plugin",
      scope,
      participant: identity.participant,
      pluginId: "calendar",
      generation: 1,
      operationId: "exit-calendar-device",
      expectedRevision: state.revision,
      at: 12,
    });

    expect(result.status).toBe("ready");
    expect(JSON.parse(cloud.current()!.content).pluginsById.calendar
      .currentGeneration.membersByKey[
        `${identity.participant.participantId}::${identity.participant.incarnation}`
      ].phase).toBe("exited");
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(false);
  });

  it("resumes an applied response-unknown exit after a cold restart", async () => {
    const storage = storageHarness();
    const identity = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceA,
      10,
    )!;
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = apply(state, {
      type: "register-participant",
      participant: identity.participant,
      operationId: "register-response-unknown-exit",
      at: 10,
    });
    state = apply(state, {
      type: "join-plugin",
      participant: identity.participant,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "response-unknown-exit-join",
      joinEvidence: "user-confirmed",
      operationId: "join-before-response-unknown-exit",
      at: 11,
    });
    const cloud = cloudHarness(state);
    const originalUpdate = cloud.updateCas.getMockImplementation();
    if (!originalUpdate) throw new Error("CAS fixture missing");
    cloud.updateCas.mockImplementationOnce(async (...args: [string, string, string]) => {
      await originalUpdate(...args);
      cloud.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("response lost");
    });
    const first = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(first.transitionLifecycle(cloud.transport, {
      type: "exit-plugin",
      scope,
      participant: identity.participant,
      pluginId: "calendar",
      generation: 1,
      operationId: "response-unknown-exit",
      expectedRevision: state.revision,
      at: 12,
    })).resolves.toMatchObject({ status: "uncertain" });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(true);

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await expect(restarted.resumePendingLifecycleTransition(
      cloud.transport,
      scope,
    )).resolves.toMatchObject({ status: "ready" });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(false);
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cloud.current()!.content).pluginsById.calendar
      .currentGeneration.membersByKey[
        `${identity.participant.participantId}::${identity.participant.incarnation}`
      ].phase).toBe("exited");
  });

  it("does not start confirmation CAS when its local checkpoint cannot be persisted", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await observer.observe(cloud.transport, scope, 10);
    const writesBefore = cloud.updateCas.mock.calls.length;
    storage.failSaveFor.add(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    );

    await expect(observer.confirmLegacyMigration(cloud.transport, scope, 20))
      .resolves.toEqual({
        status: "blocked",
        reason: "checkpoint-persist-failed",
      });
    expect(cloud.updateCas).toHaveBeenCalledTimes(writesBefore);
    expect(JSON.parse(cloud.current()!.content).legacyMigrationConsent).toBeNull();
  });

  it("resumes one response-unknown confirmation after a cold restart", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    const first = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await first.observe(cloud.transport, scope, 10);
    cloud.updateCas.mockImplementationOnce(async () => {
      cloud.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("response lost");
    });
    await expect(first.confirmLegacyMigration(cloud.transport, scope, 20))
      .resolves.toMatchObject({ status: "uncertain" });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(true);

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await expect(restarted.confirmLegacyMigration(cloud.transport, scope, 30))
      .resolves.toMatchObject({ status: "ready", source: "updated" });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(false);
  });

  it("does not resume another device identity's pending confirmation", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    const first = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await first.observe(cloud.transport, scope, 10);
    cloud.updateCas.mockImplementationOnce(async () => {
      cloud.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("response lost");
    });
    await expect(first.confirmLegacyMigration(cloud.transport, scope, 20))
      .resolves.toMatchObject({ status: "uncertain" });
    const original = readCommunityPluginLifecycleDeviceIdentityV1(storage)!;
    storage.values.set(COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY, {
      ...original,
      participant: {
        ...original.participant,
        incarnation: vaultInstanceB,
      },
    });
    const writesBefore = cloud.updateCas.mock.calls.length;

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await expect(restarted.confirmLegacyMigration(cloud.transport, scope, 30))
      .resolves.toEqual({ status: "blocked", reason: "local-checkpoint-conflict" });
    expect(cloud.updateCas).toHaveBeenCalledTimes(writesBefore);
  });

  it("persists bundle publication before CAS and clears it after exact read-back", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const cloud = cloudHarness(fixture.state);
    const originalUpdate = cloud.updateCas.getMockImplementation();
    if (!originalUpdate) throw new Error("CAS fixture missing");
    cloud.updateCas.mockImplementationOnce(async (...args: [string, string, string]) => {
      expect(storage.values.has(
        COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY,
      )).toBe(true);
      return originalUpdate(...args);
    });
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(observer.publishPluginBundleSelection(
      cloud.transport,
      fixture.command,
    )).resolves.toMatchObject({
      status: "ready",
      source: "updated",
      state: {
        pluginsById: {
          calendar: { currentGeneration: { publishedBundle: { publicationRevision: 1 } } },
        },
      },
    });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY,
    )).toBe(false);
  });

  it("resumes one response-unknown bundle publication after a cold restart", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const cloud = cloudHarness(fixture.state);
    cloud.updateCas.mockImplementationOnce(async () => {
      cloud.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("response lost");
    });
    const first = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await expect(first.publishPluginBundleSelection(cloud.transport, fixture.command))
      .resolves.toMatchObject({ status: "uncertain" });

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await expect(restarted.publishPluginBundleSelection(cloud.transport, fixture.command))
      .resolves.toMatchObject({ status: "ready", source: "updated" });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY,
    )).toBe(false);
  });

  it("stages, publishes and seals one complete legacy bundle on the existing queue", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const lifecycle = cloudHarness(fixture.state);
    const content = contentHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    const files = [
      { fileName: "main.js" as const, content: new TextEncoder().encode("main").buffer },
      {
        fileName: "manifest.json" as const,
        content: new TextEncoder().encode('{"id":"calendar"}').buffer,
      },
    ];

    const migrated = await observer.migratePluginLegacyBundle(
      lifecycle.transport,
      content.transport,
      {
        control: fixture.state,
        pluginId: "calendar",
        files,
        at: 13,
      },
    );
    expect(migrated).toMatchObject({
      status: "ready",
      state: {
        pluginsById: {
          calendar: {
            currentGeneration: { publishedBundle: { publicationRevision: 1 } },
            legacyAuthoritySeal: { generation: 1 },
          },
        },
      },
    });
    expect(content.objects.size).toBe(3);
    expect(lifecycle.updateCas).toHaveBeenCalledTimes(2);
    expect(storage.values.has(
      COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY,
    )).toBe(false);
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(false);
    if (migrated.status !== "ready") throw new Error("migration fixture failed");

    const repeated = await observer.migratePluginLegacyBundle(
      lifecycle.transport,
      content.transport,
      {
        control: migrated.state,
        pluginId: "calendar",
        files,
        at: 14,
      },
    );
    expect(repeated).toMatchObject({ status: "ready" });
    expect(content.objects.size).toBe(3);
    expect(lifecycle.updateCas).toHaveBeenCalledTimes(2);
  });

  it("publishes a new generation while retaining the permanent legacy cutoff", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const firstLifecycle = cloudHarness(fixture.state);
    const firstContent = contentHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    const files = [
      { fileName: "main.js" as const, content: new TextEncoder().encode("main").buffer },
      {
        fileName: "manifest.json" as const,
        content: new TextEncoder().encode('{"id":"calendar"}').buffer,
      },
    ];

    const migrated = await observer.migratePluginLegacyBundle(
      firstLifecycle.transport,
      firstContent.transport,
      {
        control: fixture.state,
        pluginId: "calendar",
        files,
        at: 13,
      },
    );
    if (migrated.status !== "ready") throw new Error("legacy migration failed");
    const legacySeal = structuredClone(
      migrated.state.pluginsById.calendar.legacyAuthoritySeal,
    );
    if (!legacySeal) throw new Error("legacy seal missing");

    let reopened = apply(migrated.state, {
      type: "exit-plugin",
      participant: fixture.identity.participant,
      pluginId: "calendar",
      generation: 1,
      operationId: "exit-generation-one",
      at: 14,
    });
    reopened = apply(reopened, {
      type: "begin-close",
      actor: fixture.identity.participant,
      pluginId: "calendar",
      generation: 1,
      operationId: "begin-close-generation-one",
      at: 15,
    });
    reopened = apply(reopened, {
      type: "complete-close",
      actor: fixture.identity.participant,
      pluginId: "calendar",
      generation: 1,
      cleanupReceiptDigest: "d".repeat(64),
      operationId: "complete-close-generation-one",
      at: 16,
    });
    const observedClosedRevision = reopened.revision;
    reopened = apply(reopened, {
      type: "join-plugin",
      participant: fixture.identity.participant,
      pluginId: "calendar",
      targetGeneration: 2,
      joinNonce: "calendar-generation-two-join",
      joinEvidence: "user-confirmed",
      observedClosedRevision,
      operationId: "join-generation-two",
      at: 17,
    });

    const nextLifecycle = cloudHarness(reopened);
    const nextContent = contentHarness();
    const republished = await observer.migratePluginLegacyBundle(
      nextLifecycle.transport,
      nextContent.transport,
      {
        control: reopened,
        pluginId: "calendar",
        files,
        at: 18,
      },
    );

    expect(republished).toMatchObject({
      status: "ready",
      state: {
        pluginsById: {
          calendar: {
            currentGeneration: {
              generation: 2,
              phase: "open",
              publishedBundle: { publicationRevision: 1 },
            },
            legacyAuthoritySeal: { generation: 1 },
          },
        },
      },
    });
    if (republished.status !== "ready") throw new Error("generation two publish failed");
    expect(republished.state.pluginsById.calendar.legacyAuthoritySeal)
      .toEqual(legacySeal);
    expect(nextContent.objects.size).toBe(3);
    expect(nextLifecycle.updateCas).toHaveBeenCalledTimes(1);
  });

  it("does not seal a published legacy bundle after its local source changes", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const lifecycle = cloudHarness(fixture.state);
    const content = contentHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(observer.migratePluginLegacyBundle(
      lifecycle.transport,
      content.transport,
      {
        control: fixture.state,
        pluginId: "calendar",
        files: [
          {
            fileName: "main.js",
            content: new TextEncoder().encode("main").buffer,
          },
          {
            fileName: "manifest.json",
            content: new TextEncoder().encode('{"id":"calendar"}').buffer,
          },
        ],
        revalidateSource: async () => false,
        at: 13,
      },
    )).resolves.toEqual({
      status: "blocked",
      phase: "seal",
      reason: "source-changed",
    });
    expect(content.objects.size).toBe(3);
    expect(lifecycle.updateCas).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lifecycle.current()!.content).pluginsById.calendar)
      .not.toHaveProperty("legacyAuthoritySeal");
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(false);
  });

  it("resumes an applied response-unknown publication before sealing", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const lifecycle = cloudHarness(fixture.state);
    const content = contentHarness();
    const originalUpdate = lifecycle.updateCas.getMockImplementation();
    if (!originalUpdate) throw new Error("CAS fixture missing");
    lifecycle.updateCas.mockImplementationOnce(async (...args: [string, string, string]) => {
      await originalUpdate(...args);
      lifecycle.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("publication response lost");
    });
    const first = new CommunityPluginLifecycleDeviceObserverV1(storage, vaultInstanceA);
    const files = [
      { fileName: "main.js" as const, content: new TextEncoder().encode("main").buffer },
      {
        fileName: "manifest.json" as const,
        content: new TextEncoder().encode('{"id":"calendar"}').buffer,
      },
    ];
    await expect(first.migratePluginLegacyBundle(
      lifecycle.transport,
      content.transport,
      { control: fixture.state, pluginId: "calendar", files, at: 13 },
    )).resolves.toEqual({ status: "uncertain", phase: "publication" });
    expect(storage.values.has(COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY))
      .toBe(true);
    const current = JSON.parse(lifecycle.current()!.content) as CommunityPluginLifecycleControlV1;

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(storage, vaultInstanceA);
    await expect(restarted.migratePluginLegacyBundle(
      lifecycle.transport,
      content.transport,
      { control: current, pluginId: "calendar", files, at: 14 },
    )).resolves.toMatchObject({
      status: "ready",
      state: { pluginsById: { calendar: { legacyAuthoritySeal: { generation: 1 } } } },
    });
    expect(storage.values.has(COMMUNITY_PLUGIN_BUNDLE_PUBLICATION_CHECKPOINT_KEY))
      .toBe(false);
  });

  it("resumes an applied response-unknown seal before any new staging", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const lifecycle = cloudHarness(fixture.state);
    const content = contentHarness();
    const originalUpdate = lifecycle.updateCas.getMockImplementation();
    if (!originalUpdate) throw new Error("CAS fixture missing");
    lifecycle.updateCas
      .mockImplementationOnce((...args: [string, string, string]) => originalUpdate(...args))
      .mockImplementationOnce(async (...args: [string, string, string]) => {
        await originalUpdate(...args);
        lifecycle.readById.mockRejectedValueOnce(new Error("read unavailable"));
        throw new Error("seal response lost");
      });
    const first = new CommunityPluginLifecycleDeviceObserverV1(storage, vaultInstanceA);
    const files = [
      { fileName: "main.js" as const, content: new TextEncoder().encode("main").buffer },
      {
        fileName: "manifest.json" as const,
        content: new TextEncoder().encode('{"id":"calendar"}').buffer,
      },
    ];
    await expect(first.migratePluginLegacyBundle(
      lifecycle.transport,
      content.transport,
      { control: fixture.state, pluginId: "calendar", files, at: 13 },
    )).resolves.toEqual({ status: "uncertain", phase: "seal" });
    expect(storage.values.has(COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY))
      .toBe(true);
    const createsBefore = content.createOnly.mock.calls.length;
    const current = JSON.parse(lifecycle.current()!.content) as CommunityPluginLifecycleControlV1;

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(storage, vaultInstanceA);
    await expect(restarted.migratePluginLegacyBundle(
      lifecycle.transport,
      content.transport,
      { control: current, pluginId: "calendar", files, at: 14 },
    )).resolves.toMatchObject({ status: "ready" });
    expect(content.createOnly).toHaveBeenCalledTimes(createsBefore);
    expect(storage.values.has(COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY))
      .toBe(false);
  });

  it("keeps an incomplete legacy bundle before both content and lifecycle mutation", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const lifecycle = cloudHarness(fixture.state);
    const content = contentHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(observer.migratePluginLegacyBundle(
      lifecycle.transport,
      content.transport,
      {
        control: fixture.state,
        pluginId: "calendar",
        files: [{
          fileName: "main.js",
          content: new TextEncoder().encode("main").buffer,
        }],
        at: 13,
      },
    )).resolves.toEqual({
      status: "blocked",
      phase: "staging",
      reason: "invalid-content",
    });
    expect(content.createOnly).not.toHaveBeenCalled();
    expect(lifecycle.updateCas).not.toHaveBeenCalled();
  });

  it("seals an exact published bundle through the same control queue", async () => {
    const storage = storageHarness();
    const fixture = publicationDeviceFixture(storage);
    const publishedBundle = fixture.publishedState
      .pluginsById.calendar.currentGeneration.publishedBundle!;
    const cloud = cloudHarness(fixture.publishedState);
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(observer.sealPluginLegacyAuthority(cloud.transport, {
      scope,
      pluginId: "calendar",
      generation: 1,
      publishedBundle,
      sealedAt: 14,
    })).resolves.toMatchObject({
      status: "ready",
      source: "updated",
      state: {
        pluginsById: { calendar: { legacyAuthoritySeal: { generation: 1 } } },
      },
    });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_CONTROL_MUTATION_CHECKPOINT_KEY,
    )).toBe(false);
  });

  it("does not start a Graph mutation when checkpoint persistence fails", async () => {
    const storage = storageHarness();
    storage.failSaveFor.add(COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY);
    const cloud = cloudHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(observer.observe(cloud.transport, scope, 10)).resolves.toEqual({
      status: "blocked",
      reason: "checkpoint-persist-failed",
    });
    expect(cloud.createOnly).not.toHaveBeenCalled();
    expect(cloud.updateCas).not.toHaveBeenCalled();
  });

  it("replaces a corrupt local identity without adopting its participant", async () => {
    const storage = storageHarness();
    storage.values.set(COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY, {
      schemaVersion: 1,
      kind: "community-plugin-lifecycle-device",
      vaultInstanceId: vaultInstanceA,
      participant: {
        participantId: "corrupt",
        incarnation: "corrupt",
      },
      createdAt: 10,
    });

    const replacement = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceA,
      20,
    );

    expect(replacement).not.toBeNull();
    expect(replacement?.participant.participantId).not.toBe("corrupt");
    expect(replacement?.participant.incarnation).not.toBe("corrupt");
  });

  it("recovers one response-unknown registration after a cold restart", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    cloud.createOnly.mockImplementationOnce(async (content: string) => {
      cloud.read.mockRejectedValueOnce(new Error("read unavailable"));
      cloud.read.mockResolvedValueOnce({
        id: "lifecycle-id",
        eTag: "etag-recovered",
        content,
      });
      throw new Error("response lost");
    });
    const first = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    const uncertain = await first.observe(cloud.transport, scope, 10);
    expect(uncertain.status).toBe("uncertain");
    expect(first.isObservationDue(11)).toBe(true);
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
    )).toBe(true);

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await expect(restarted.observe(cloud.transport, scope, 20))
      .resolves.toMatchObject({ status: "ready", source: "recovered" });
    expect(storage.values.has(
      COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY,
    )).toBe(false);
    expect(cloud.createOnly).toHaveBeenCalledTimes(1);
  });

  it("keeps an unresolved old-scope operation from being sent to another scope", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    cloud.createOnly.mockImplementationOnce(async () => {
      cloud.read.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("response lost");
    });
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    expect((await observer.observe(cloud.transport, scope, 10)).status).toBe("uncertain");
    const otherCloud = cloudHarness();

    await expect(observer.observe(otherCloud.transport, {
      ...scope,
      filesRootId: "other-files-root",
    }, 20)).resolves.toEqual({
      status: "blocked",
      reason: "pending-scope-mismatch",
    });
    expect(otherCloud.read).not.toHaveBeenCalled();
    expect(otherCloud.createOnly).not.toHaveBeenCalled();
  });

  it("serializes simultaneous observations for one participant", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await observer.observe(cloud.transport, scope, 10);
    let activeWrites = 0;
    let peakWrites = 0;
    const originalUpdate = cloud.updateCas.getMockImplementation()!;
    cloud.updateCas.mockImplementation(async (...args: [string, string, string]) => {
      activeWrites += 1;
      peakWrites = Math.max(peakWrites, activeWrites);
      await Promise.resolve();
      try {
        return await originalUpdate(...args);
      } finally {
        activeWrites -= 1;
      }
    });

    const [first, second] = await Promise.all([
      observer.observe(cloud.transport, scope, 20),
      observer.observe(cloud.transport, scope, 30),
    ]);
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(peakWrites).toBe(1);
    expect(JSON.parse(cloud.current()!.content)).toMatchObject({ revision: 4 });
  });

  it("registers a new identity after local identity loss without erasing the old participant", async () => {
    const storage = storageHarness();
    const cloud = cloudHarness();
    const first = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await first.observe(cloud.transport, scope, 10);
    const oldIdentity = readCommunityPluginLifecycleDeviceIdentityV1(storage)!;
    storage.values.delete(COMMUNITY_PLUGIN_LIFECYCLE_DEVICE_IDENTITY_KEY);

    const restarted = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );
    await expect(restarted.observe(cloud.transport, scope, 20))
      .resolves.toMatchObject({ status: "ready", source: "updated" });
    const newIdentity = readCommunityPluginLifecycleDeviceIdentityV1(storage)!;
    expect(newIdentity.participant).not.toEqual(oldIdentity.participant);
    const state = JSON.parse(cloud.current()!.content) as CommunityPluginLifecycleControlV1;
    expect(Object.keys(state.participantsByKey)).toHaveLength(2);
  });

  it("rotates a retired incarnation and only registers the replacement", async () => {
    const storage = storageHarness();
    const identity = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceA,
      10,
    )!;
    const admin: CommunityPluginParticipantIdentityV1 = {
      participantId: "admin-participant",
      incarnation: "admin-incarnation",
    };
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = apply(state, {
      type: "register-participant",
      participant: identity.participant,
      operationId: "register-old-device",
      at: 10,
    });
    state = apply(state, {
      type: "register-participant",
      participant: admin,
      operationId: "register-admin-device",
      at: 11,
    });
    state = apply(state, {
      type: "retire-participant",
      actor: admin,
      target: identity.participant,
      operationId: "retire-old-device",
      at: 12,
    });
    const cloud = cloudHarness(state);
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(observer.observe(cloud.transport, scope, 20))
      .resolves.toMatchObject({ status: "ready", source: "updated" });
    const replacement = readCommunityPluginLifecycleDeviceIdentityV1(storage)!;
    expect(replacement.participant.participantId).toBe(identity.participant.participantId);
    expect(replacement.participant.incarnation).not.toBe(identity.participant.incarnation);
    const finalState = JSON.parse(cloud.current()!.content) as CommunityPluginLifecycleControlV1;
    expect(finalState.participantsByKey[
      `${identity.participant.participantId}::${identity.participant.incarnation}`
    ]?.retiredAt).toBe(12);
    expect(finalState.participantsByKey[
      `${replacement.participant.participantId}::${replacement.participant.incarnation}`
    ]).toBeDefined();
    expect(Object.keys(finalState.pluginsById)).toHaveLength(0);
  });

  it("fails closed on a corrupt local checkpoint", async () => {
    const storage = storageHarness();
    storage.values.set(COMMUNITY_PLUGIN_LIFECYCLE_OBSERVATION_CHECKPOINT_KEY, {});
    const cloud = cloudHarness();
    const observer = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceA,
    );

    await expect(observer.observe(cloud.transport, scope, 10)).resolves.toEqual({
      status: "blocked",
      reason: "local-checkpoint-invalid",
    });
    expect(cloud.read).not.toHaveBeenCalled();
  });
});
