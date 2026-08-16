import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createOneDriveCommunityPluginLifecycleTransportV1,
  confirmCommunityPluginLegacyMigrationV1,
  isCommunityPluginBundlePublicationCheckpointV1,
  isCommunityPluginLifecycleControlMutationCheckpointV1,
  isCommunityPluginLifecycleObservationCheckpointV1,
  joinCommunityPluginGenerationV1,
  publishCommunityPluginBundleSelectionV1,
  publishCommunityPluginParticipantObservationV1,
  readCommunityPluginLifecycleControlV1,
  sealCommunityPluginLegacyAuthorityV1,
  transitionCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCloudObjectV1,
  type CommunityPluginLifecycleCloudTransportV1,
} from "../src/sync/community-plugin-lifecycle-cloud-v1";
import {
  communityPluginPublishedManifestObjectPathV1,
  createCommunityPluginLifecycleControlV1,
  reduceCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
} from "../src/sync/community-plugin-lifecycle-v1";

const scope = {
  accountId: "account-s7",
  driveId: "drive-s7",
  vaultFolderId: "vault-s7",
  filesRootId: "files-s7",
};
const participantA = {
  participantId: "participant-a",
  incarnation: "incarnation-a",
};
const participantB = {
  participantId: "participant-b",
  incarnation: "incarnation-b",
};
const checkpointWriter = {
  persist: async () => undefined,
};

const manifestHash = "a".repeat(64);

function input(
  participant = participantA,
  operationId = "observe-operation-a",
  observedAt = 10,
) {
  return { scope, participant, operationId, observedAt };
}

function harness(initial: CommunityPluginLifecycleControlV1 | null = null): {
  transport: CommunityPluginLifecycleCloudTransportV1;
  read: ReturnType<typeof vi.fn>;
  createOnly: ReturnType<typeof vi.fn>;
  updateCas: ReturnType<typeof vi.fn>;
  readById: ReturnType<typeof vi.fn>;
  current(): CommunityPluginLifecycleCloudObjectV1 | null;
} {
  let revision = 0;
  let current: CommunityPluginLifecycleCloudObjectV1 | null = initial
    ? { id: "lifecycle-id", eTag: "etag-0", content: JSON.stringify(initial) }
    : null;
  const read = vi.fn(async () => current);
  const createOnly = vi.fn(async (content: string) => {
    if (current) throw new Error("conflict");
    revision += 1;
    current = { id: "lifecycle-id", eTag: `etag-${revision}`, content };
    return { id: current.id, eTag: current.eTag };
  });
  const updateCas = vi.fn(async (id: string, eTag: string, content: string) => {
    if (!current || current.id !== id || current.eTag !== eTag) throw new Error("412");
    revision += 1;
    current = { ...current, eTag: `etag-${revision}`, content };
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

function publicationFixture(): {
  state: CommunityPluginLifecycleControlV1;
  command: Extract<CommunityPluginLifecycleCommandV1, { type: "publish-plugin-bundle" }>;
} {
  let state = createCommunityPluginLifecycleControlV1(scope);
  state = apply(state, {
    type: "register-participant",
    participant: participantA,
    operationId: "register-publication-participant",
    at: 10,
  });
  state = apply(state, {
    type: "join-plugin",
    participant: participantA,
    pluginId: "calendar",
    targetGeneration: 1,
    joinNonce: "calendar-join-1",
    joinEvidence: "host-install",
    operationId: "join-calendar",
    at: 11,
  });
  return {
    state,
    command: {
      type: "publish-plugin-bundle",
      participant: participantA,
      pluginId: "calendar",
      generation: 1,
      joinNonce: "calendar-join-1",
      fenceEpoch: state.fenceEpoch,
      manifestObject: {
        objectPath: communityPluginPublishedManifestObjectPathV1(
          "calendar",
          1,
          manifestHash,
        ),
        remoteId: "manifest-remote-id",
        parentId: "manifest-parent-id",
        size: 321,
        eTag: "manifest-etag",
        cTag: "manifest-ctag",
        sha256Hash: manifestHash,
      },
      operationId: "publish-calendar-bundle",
      expectedRevision: state.revision,
      scope,
      at: 12,
    },
  };
}

function confirmationFixture(): CommunityPluginLifecycleControlV1 {
  let state = createCommunityPluginLifecycleControlV1(scope);
  state = apply(state, {
    type: "register-participant",
    participant: participantA,
    operationId: "register-confirmation-participant",
    at: 10,
  });
  return state;
}

function confirmationInput(
  operationId = "confirm-legacy-devices",
  confirmedAt = 11,
) {
  return {
    scope,
    actor: participantA,
    operationId,
    confirmedAt,
    evidence: "user-confirmed-legacy-devices-upgraded-or-retired" as const,
  };
}

function sealFixture() {
  const base = publicationFixture();
  let state = apply(base.state, {
    type: "confirm-legacy-migration",
    actor: participantA,
    evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
    operationId: "confirm-before-seal",
    at: 12,
  });
  state = apply(state, {
    ...base.command,
    fenceEpoch: state.fenceEpoch,
    operationId: "publish-before-seal",
    at: 13,
  });
  const publishedBundle = state.pluginsById.calendar.currentGeneration.publishedBundle;
  if (!publishedBundle) throw new Error("published bundle fixture missing");
  return {
    state,
    input: {
      scope,
      actor: participantA,
      pluginId: "calendar",
      generation: 1,
      publishedBundle,
      operationId: "seal-calendar-legacy-authority",
      sealedAt: 14,
    },
  };
}

function transitionFixture(): CommunityPluginLifecycleControlV1 {
  let state = createCommunityPluginLifecycleControlV1(scope);
  state = apply(state, {
    type: "register-participant",
    participant: participantA,
    operationId: "register-transition-a",
    at: 10,
  });
  state = apply(state, {
    type: "register-participant",
    participant: participantB,
    operationId: "register-transition-b",
    at: 11,
  });
  state = apply(state, {
    type: "join-plugin",
    participant: participantA,
    pluginId: "calendar",
    targetGeneration: 1,
    joinNonce: "transition-join-a",
    joinEvidence: "host-install",
    operationId: "transition-join-operation-a",
    at: 12,
  });
  return apply(state, {
    type: "join-plugin",
    participant: participantB,
    pluginId: "calendar",
    targetGeneration: 1,
    joinNonce: "transition-join-b",
    joinEvidence: "host-install",
    operationId: "transition-join-operation-b",
    at: 13,
  });
}

describe("community-plugin lifecycle S7 observation transport", () => {
  it("blocks control mutations after the production lifecycle is invalidated", async () => {
    const client = {
      readCommunityPluginLifecycleV1: vi.fn().mockResolvedValue(null),
      createCommunityPluginLifecycleV1: vi.fn(),
      updateCommunityPluginLifecycleV1: vi.fn(),
      readCommunityPluginLifecycleV1ById: vi.fn(),
    };
    const transport = createOneDriveCommunityPluginLifecycleTransportV1(
      client as never,
      "Vault",
      () => false,
    );

    await expect(transport.read()).resolves.toBeNull();
    expect(() => transport.createOnly("{}")).toThrow("invalidated");
    expect(() => transport.updateCas("id", "etag", "{}"))
      .toThrow("invalidated");
    expect(client.createCommunityPluginLifecycleV1).not.toHaveBeenCalled();
    expect(client.updateCommunityPluginLifecycleV1).not.toHaveBeenCalled();
  });

  it("binds read-only planning to the exact lifecycle record identity", async () => {
    const cloud = harness(confirmationFixture());
    await expect(readCommunityPluginLifecycleControlV1(
      cloud.transport,
      scope,
    )).resolves.toMatchObject({
      status: "ready",
      recordId: "lifecycle-id",
      state: { scope },
    });
    await expect(readCommunityPluginLifecycleControlV1(
      cloud.transport,
      scope,
      "different-lifecycle-id",
    )).resolves.toEqual({ status: "blocked", reason: "read-failed" });
    await expect(readCommunityPluginLifecycleControlV1(
      cloud.transport,
      { ...scope, filesRootId: "other-files-root" },
    )).resolves.toEqual({ status: "blocked", reason: "scope-mismatch" });
  });

  it("creates the scope-bound registry and then observes the same participant with CAS", async () => {
    const cloud = harness();
    const created = await publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(),
      null,
      checkpointWriter,
    );
    expect(created).toMatchObject({
      status: "ready",
      source: "created",
      state: { revision: 2 },
      recordId: "lifecycle-id",
    });
    expect(cloud.createOnly).toHaveBeenCalledTimes(1);

    const observed = await publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(participantA, "observe-operation-b", 20),
      null,
      checkpointWriter,
    );
    expect(observed).toMatchObject({
      status: "ready",
      source: "updated",
      state: {
        revision: 3,
        participantsByKey: {
          "participant-a::incarnation-a": { lastObservedAt: 20 },
        },
      },
    });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
  });

  it("recovers a create whose response was lost without issuing a second write", async () => {
    const cloud = harness();
    cloud.createOnly.mockImplementationOnce(async (content: string) => {
      await harnessCreate(cloud, content);
      throw new Error("response lost");
    });

    await expect(publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(),
      null,
      checkpointWriter,
    )).resolves.toMatchObject({ status: "ready", source: "recovered" });
    expect(cloud.createOnly).toHaveBeenCalledTimes(1);
    expect(cloud.updateCas).not.toHaveBeenCalled();
  });

  it("does not write when the device-local checkpoint cannot be persisted first", async () => {
    const cloud = harness();
    await expect(publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(),
      null,
      { persist: vi.fn().mockRejectedValue(new Error("local storage unavailable")) },
    )).resolves.toEqual({ status: "blocked", reason: "checkpoint-persist-failed" });
    expect(cloud.createOnly).not.toHaveBeenCalled();
    expect(cloud.updateCas).not.toHaveBeenCalled();
  });

  it("joins one exact plugin generation through the existing control CAS", async () => {
    const cloud = harness(confirmationFixture());
    const joinInput = {
      scope,
      participant: participantA,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "calendar-explicit-join",
      joinEvidence: "user-confirmed" as const,
      operationId: "join-calendar-generation",
      joinedAt: 12,
    };

    await expect(joinCommunityPluginGenerationV1(
      cloud.transport,
      joinInput,
      null,
      checkpointWriter,
    )).resolves.toMatchObject({
      status: "ready",
      source: "updated",
      state: {
        pluginsById: {
          calendar: {
            currentGeneration: {
              generation: 1,
              membersByKey: {
                "participant-a::incarnation-a": {
                  phase: "joined",
                  joinNonce: "calendar-explicit-join",
                  joinEvidence: "user-confirmed",
                },
              },
            },
          },
        },
      },
    });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);

    await expect(joinCommunityPluginGenerationV1(
      cloud.transport,
      joinInput,
      null,
      checkpointWriter,
    )).resolves.toMatchObject({ status: "ready", source: "existing" });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
  });

  it("returns a durable checkpoint when write outcome cannot be read and resumes only that operation", async () => {
    const cloud = harness();
    cloud.createOnly.mockImplementationOnce(async () => {
      cloud.read.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("network lost");
    });
    const first = await publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(),
      null,
      checkpointWriter,
    );
    expect(first).toMatchObject({
      status: "uncertain",
      checkpoint: { recordId: null, command: { operationId: "observe-operation-a" } },
    });
    if (first.status !== "uncertain") throw new Error("checkpoint fixture missing");
    const reopenedCheckpoint: unknown = JSON.parse(JSON.stringify(first.checkpoint));
    expect(isCommunityPluginLifecycleObservationCheckpointV1(reopenedCheckpoint)).toBe(true);
    if (!isCommunityPluginLifecycleObservationCheckpointV1(reopenedCheckpoint)) {
      throw new Error("checkpoint did not survive reload");
    }

    await expect(publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(participantA, "different-operation", 11),
      reopenedCheckpoint,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "pending-operation-required" });

    await expect(publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(),
      reopenedCheckpoint,
      checkpointWriter,
    )).resolves.toMatchObject({ status: "ready", source: "created" });
  });

  it("does not overwrite another participant after a CAS race", async () => {
    const seeded = harness();
    await publishCommunityPluginParticipantObservationV1(
      seeded.transport,
      input(),
      null,
      checkpointWriter,
    );
    const state = JSON.parse(seeded.current()!.content) as CommunityPluginLifecycleControlV1;
    const cloud = harness(state);
    cloud.updateCas.mockImplementationOnce(async () => {
      await publishCommunityPluginParticipantObservationV1(
        seeded.transport,
        input(participantB, "register-participant-b", 30),
        null,
        checkpointWriter,
      );
      cloud.readById.mockResolvedValueOnce(seeded.current());
      throw new Error("412");
    });

    await expect(publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(participantA, "observe-after-race", 31),
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "write-race" });
  });

  it("keeps a retired incarnation retired when the old device returns", async () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = apply(state, {
      type: "register-participant",
      participant: participantA,
      operationId: "register-participant-a",
      at: 10,
    });
    state = apply(state, {
      type: "register-participant",
      participant: participantB,
      operationId: "register-participant-b",
      at: 11,
    });
    state = apply(state, {
      type: "retire-participant",
      actor: participantB,
      target: participantA,
      operationId: "retire-participant-a",
      at: 12,
    });
    const cloud = harness(state);

    await expect(publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(participantA, "old-device-return", 20),
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "participant-retired" });
    expect(cloud.updateCas).not.toHaveBeenCalled();
  });

  it("fails closed on a different scope, corrupt record or first read failure", async () => {
    const differentScope = createCommunityPluginLifecycleControlV1({
      ...scope,
      filesRootId: "other-files-root",
    });
    await expect(publishCommunityPluginParticipantObservationV1(
      harness(differentScope).transport,
      input(),
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "scope-mismatch" });

    const corrupt = harness();
    corrupt.read.mockResolvedValueOnce({
      id: "lifecycle-id",
      eTag: "etag-corrupt",
      content: "{}",
    });
    await expect(publishCommunityPluginParticipantObservationV1(
      corrupt.transport,
      input(),
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "invalid-current" });

    const unavailable = harness();
    unavailable.read.mockRejectedValueOnce(new Error("offline"));
    await expect(publishCommunityPluginParticipantObservationV1(
      unavailable.transport,
      input(),
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "read-failed" });
  });

  it("keeps S7 free of plugin join, retirement, closing and file mutation APIs", () => {
    const source = readFileSync(
      "src/sync/community-plugin-lifecycle-cloud-v1.ts",
      "utf8",
    );
    expect(source).not.toMatch(/joinPlugin|retireParticipant|beginClose|completeClose/);
    expect(source).not.toMatch(/uploadFile|downloadFile|deleteItem|SyncExecutor|from\s+["']obsidian["']/);
  });
});

describe("community-plugin lifecycle S9 control transitions", () => {
  it("checkpoints both exits, begins closing only after all members exit, and records a verified cleanup digest", async () => {
    const cloud = harness(transitionFixture());
    const persist = vi.fn(async () => undefined);

    await expect(transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "exit-plugin",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        participant: participantA,
        pluginId: "calendar",
        generation: 1,
        operationId: "exit-calendar-a",
        at: 20,
      },
      null,
      { persist },
    )).resolves.toMatchObject({ status: "ready", source: "updated" });
    await expect(transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "begin-close",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        operationId: "close-calendar-too-early",
        at: 21,
      },
      null,
      { persist },
    )).resolves.toEqual({ status: "blocked", reason: "participant-still-joined" });
    await expect(transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "exit-plugin",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        participant: participantB,
        pluginId: "calendar",
        generation: 1,
        operationId: "exit-calendar-b",
        at: 22,
      },
      null,
      { persist },
    )).resolves.toMatchObject({ status: "ready", source: "updated" });
    await expect(transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "begin-close",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        operationId: "begin-close-calendar",
        at: 23,
      },
      null,
      { persist },
    )).resolves.toMatchObject({
      status: "ready",
      source: "updated",
      state: { pluginsById: { calendar: { currentGeneration: { phase: "closing" } } } },
    });
    const cleanupReceiptDigest = "f".repeat(64);
    const completed = await transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "complete-close",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        cleanupReceiptDigest,
        operationId: "complete-close-calendar",
        at: 24,
      },
      null,
      { persist },
    );

    expect(completed).toMatchObject({
      status: "ready",
      source: "updated",
      state: {
        pluginsById: {
          calendar: {
            currentGeneration: {
              phase: "closed",
              closed: { cleanupReceiptDigest },
            },
            closedTombstones: [{ generation: 1, cleanupReceiptDigest }],
          },
        },
      },
    });
    expect(persist).toHaveBeenCalledTimes(4);
  });

  it("allows an explicit retirement to replace one missing member exit", async () => {
    const cloud = harness(transitionFixture());
    await transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "exit-plugin",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        participant: participantA,
        pluginId: "calendar",
        generation: 1,
        operationId: "exit-before-retirement",
        at: 20,
      },
      null,
      checkpointWriter,
    );
    await expect(transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "retire-participant",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        actor: participantA,
        target: participantB,
        operationId: "retire-calendar-b",
        at: 21,
      },
      null,
      checkpointWriter,
    )).resolves.toMatchObject({ status: "ready", source: "updated" });
    await expect(transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "begin-close",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        operationId: "begin-close-after-retirement",
        at: 22,
      },
      null,
      checkpointWriter,
    )).resolves.toMatchObject({
      status: "ready",
      state: { pluginsById: { calendar: { currentGeneration: { phase: "closing" } } } },
    });
  });

  it("recovers an applied transition after the CAS response is lost without repeating it", async () => {
    const cloud = harness(transitionFixture());
    const applyCas = cloud.updateCas.getMockImplementation();
    if (!applyCas) throw new Error("CAS fixture missing");
    cloud.updateCas.mockImplementationOnce(async (id, eTag, content) => {
      await applyCas(id, eTag, content);
      throw new Error("response lost");
    });
    const persist = vi.fn(async () => undefined);
    const transition = {
      type: "exit-plugin" as const,
      scope,
      expectedRevision: JSON.parse(cloud.current()!.content).revision,
      participant: participantA,
      pluginId: "calendar",
      generation: 1,
      operationId: "exit-response-lost",
      at: 20,
    };

    const recovered = await transitionCommunityPluginLifecycleV1(
      cloud.transport,
      transition,
      null,
      { persist },
    );

    expect(recovered).toMatchObject({ status: "ready", source: "recovered" });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cloud.current()!.content).pluginsById.calendar
      .currentGeneration.membersByKey[`${participantA.participantId}::${participantA.incarnation}`])
      .toMatchObject({ phase: "exited", exitedAt: 20 });
  });

  it("keeps a different pending transition from being silently replaced", async () => {
    const cloud = harness(transitionFixture());
    const pending = {
      schemaVersion: 1 as const,
      kind: "community-plugin-lifecycle-control-mutation-checkpoint" as const,
      recordId: "lifecycle-id",
      command: {
        type: "exit-plugin" as const,
        scope,
        participant: participantA,
        pluginId: "calendar",
        generation: 1,
        operationId: "pending-exit-a",
        expectedRevision: transitionFixture().revision,
        at: 20,
      },
    };

    await expect(transitionCommunityPluginLifecycleV1(
      cloud.transport,
      {
        type: "exit-plugin",
        scope,
        expectedRevision: JSON.parse(cloud.current()!.content).revision,
        participant: participantB,
        pluginId: "calendar",
        generation: 1,
        operationId: "new-exit-b",
        at: 21,
      },
      pending,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "pending-operation-required" });
    expect(cloud.updateCas).not.toHaveBeenCalled();
  });
});

describe("community-plugin lifecycle S8 legacy migration confirmation CAS", () => {
  it("persists the explicit declaration through the existing lifecycle If-Match write", async () => {
    const cloud = harness(confirmationFixture());
    const result = await confirmCommunityPluginLegacyMigrationV1(
      cloud.transport,
      confirmationInput(),
      null,
      checkpointWriter,
    );

    expect(result).toMatchObject({
      status: "ready",
      source: "updated",
      state: {
        schemaVersion: 2,
        fenceEpoch: 1,
        legacyMigrationConsent: {
          confirmedBy: participantA,
          confirmedAt: 11,
          evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
        },
        pluginsById: {},
      },
    });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
    expect(cloud.createOnly).not.toHaveBeenCalled();

    await expect(confirmCommunityPluginLegacyMigrationV1(
      cloud.transport,
      confirmationInput("confirm-legacy-devices-again", 12),
      null,
      checkpointWriter,
    )).resolves.toMatchObject({ status: "ready", source: "existing" });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost response and keeps only the exact pending declaration", async () => {
    const cloud = harness(confirmationFixture());
    const applyCas = cloud.updateCas.getMockImplementation();
    if (!applyCas) throw new Error("CAS fixture missing");
    cloud.updateCas.mockImplementationOnce(async (...args: [string, string, string]) => {
      await applyCas(...args);
      throw new Error("response lost");
    });
    await expect(confirmCommunityPluginLegacyMigrationV1(
      cloud.transport,
      confirmationInput(),
      null,
      checkpointWriter,
    )).resolves.toMatchObject({ status: "ready", source: "recovered" });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);

    const uncertain = harness(confirmationFixture());
    uncertain.updateCas.mockImplementationOnce(async () => {
      uncertain.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("network lost");
    });
    const first = await confirmCommunityPluginLegacyMigrationV1(
      uncertain.transport,
      confirmationInput(),
      null,
      checkpointWriter,
    );
    expect(first).toMatchObject({
      status: "uncertain",
      checkpoint: { recordId: "lifecycle-id" },
    });
    if (first.status !== "uncertain") throw new Error("checkpoint fixture missing");
    const reopened: unknown = JSON.parse(JSON.stringify(first.checkpoint));
    expect(isCommunityPluginLifecycleControlMutationCheckpointV1(reopened)).toBe(true);
    if (!isCommunityPluginLifecycleControlMutationCheckpointV1(reopened)) {
      throw new Error("control checkpoint did not survive reload");
    }
    await expect(confirmCommunityPluginLegacyMigrationV1(
      uncertain.transport,
      confirmationInput("different-confirmation", 12),
      reopened,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "pending-operation-required" });
  });

  it("never creates a missing registry or overwrites a concurrent observation", async () => {
    const missing = harness();
    await expect(confirmCommunityPluginLegacyMigrationV1(
      missing.transport,
      confirmationInput(),
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "record-missing" });
    expect(missing.createOnly).not.toHaveBeenCalled();

    const state = confirmationFixture();
    const concurrent = harness(state);
    const applyCas = concurrent.updateCas.getMockImplementation();
    if (!applyCas) throw new Error("CAS fixture missing");
    concurrent.updateCas.mockImplementationOnce(async () => {
      const observed = apply(state, {
        type: "observe-participant",
        participant: participantA,
        operationId: "concurrent-confirmation-observation",
        at: 11,
      });
      await applyCas("lifecycle-id", "etag-0", JSON.stringify(observed));
      throw new Error("412");
    });
    await expect(confirmCommunityPluginLegacyMigrationV1(
      concurrent.transport,
      confirmationInput(),
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "write-race" });
    expect(JSON.parse(concurrent.current()!.content)).toMatchObject({
      revision: state.revision + 1,
      legacyMigrationConsent: null,
    });
  });
});

describe("community-plugin lifecycle S8 legacy authority seal CAS", () => {
  it("seals the exact current publication and remains idempotent", async () => {
    const fixture = sealFixture();
    const cloud = harness(fixture.state);
    await expect(sealCommunityPluginLegacyAuthorityV1(
      cloud.transport,
      fixture.input,
      null,
      checkpointWriter,
    )).resolves.toMatchObject({
      status: "ready",
      source: "updated",
      state: {
        fenceEpoch: fixture.state.fenceEpoch + 1,
        pluginsById: {
          calendar: {
            legacyAuthoritySeal: {
              generation: 1,
              sealedBy: participantA,
              publishedBundle: fixture.input.publishedBundle,
            },
          },
        },
      },
    });
    await expect(sealCommunityPluginLegacyAuthorityV1(
      cloud.transport,
      { ...fixture.input, operationId: "seal-calendar-again", sealedAt: 15 },
      null,
      checkpointWriter,
    )).resolves.toMatchObject({ status: "ready", source: "existing" });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
  });

  it("recovers only the exact pending seal and rejects changed publication evidence", async () => {
    const fixture = sealFixture();
    const cloud = harness(fixture.state);
    cloud.updateCas.mockImplementationOnce(async () => {
      cloud.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("response lost");
    });
    const first = await sealCommunityPluginLegacyAuthorityV1(
      cloud.transport,
      fixture.input,
      null,
      checkpointWriter,
    );
    expect(first.status).toBe("uncertain");
    if (first.status !== "uncertain") throw new Error("seal checkpoint missing");
    await expect(sealCommunityPluginLegacyAuthorityV1(
      cloud.transport,
      {
        ...fixture.input,
        publishedBundle: {
          ...fixture.input.publishedBundle,
          publicationRevision: fixture.input.publishedBundle.publicationRevision + 1,
        },
      },
      first.checkpoint,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "pending-operation-required" });
  });
});

describe("community-plugin lifecycle S8 bundle publication CAS", () => {
  it("selects one verified manifest with the existing lifecycle If-Match write", async () => {
    const { state, command } = publicationFixture();
    const cloud = harness(state);
    const result = await publishCommunityPluginBundleSelectionV1(
      cloud.transport,
      command,
      null,
      checkpointWriter,
    );

    expect(result).toMatchObject({
      status: "ready",
      source: "updated",
      state: {
        revision: state.revision + 1,
        pluginsById: {
          calendar: {
            currentGeneration: {
              publishedBundle: {
                publisherJoinNonce: "calendar-join-1",
                manifestObject: { remoteId: "manifest-remote-id" },
              },
            },
          },
        },
      },
    });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
    expect(cloud.updateCas).toHaveBeenCalledWith(
      "lifecycle-id",
      "etag-0",
      expect.any(String),
    );
    expect(cloud.createOnly).not.toHaveBeenCalled();
  });

  it("recovers a lost CAS response without selecting the manifest twice", async () => {
    const { state, command } = publicationFixture();
    const cloud = harness(state);
    const applyCas = cloud.updateCas.getMockImplementation();
    if (!applyCas) throw new Error("CAS fixture missing");
    cloud.updateCas.mockImplementationOnce(async (...args: [string, string, string]) => {
      await applyCas(...args);
      throw new Error("response lost");
    });

    const result = await publishCommunityPluginBundleSelectionV1(
      cloud.transport,
      command,
      null,
      checkpointWriter,
    );
    expect(result).toMatchObject({ status: "ready", source: "recovered" });
    expect(cloud.updateCas).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cloud.current()!.content)).toMatchObject({
      pluginsById: {
        calendar: { currentGeneration: { publishedBundle: { publicationRevision: 1 } } },
      },
    });
  });

  it("recognizes the exact published effect after a later observation advances revision", async () => {
    const { state, command } = publicationFixture();
    const cloud = harness(state);
    await publishCommunityPluginBundleSelectionV1(
      cloud.transport,
      command,
      null,
      checkpointWriter,
    );
    await publishCommunityPluginParticipantObservationV1(
      cloud.transport,
      input(participantA, "observe-after-publication", 13),
      null,
      checkpointWriter,
    );

    await expect(publishCommunityPluginBundleSelectionV1(
      cloud.transport,
      command,
      null,
      checkpointWriter,
    )).resolves.toMatchObject({
      status: "ready",
      source: "existing",
      state: { revision: state.revision + 2 },
    });
    expect(cloud.updateCas).toHaveBeenCalledTimes(2);
    expect(JSON.parse(cloud.current()!.content)).toMatchObject({
      pluginsById: {
        calendar: { currentGeneration: { publishedBundle: { publicationRevision: 1 } } },
      },
    });
  });

  it("keeps an uncertain publication durable and resumes only that exact command", async () => {
    const { state, command } = publicationFixture();
    const cloud = harness(state);
    cloud.updateCas.mockImplementationOnce(async () => {
      cloud.readById.mockRejectedValueOnce(new Error("read unavailable"));
      throw new Error("network lost");
    });
    const first = await publishCommunityPluginBundleSelectionV1(
      cloud.transport,
      command,
      null,
      checkpointWriter,
    );
    expect(first).toMatchObject({
      status: "uncertain",
      checkpoint: { recordId: "lifecycle-id" },
    });
    if (first.status !== "uncertain") throw new Error("checkpoint fixture missing");
    const reopened: unknown = JSON.parse(JSON.stringify(first.checkpoint));
    expect(isCommunityPluginBundlePublicationCheckpointV1(reopened)).toBe(true);
    if (!isCommunityPluginBundlePublicationCheckpointV1(reopened)) {
      throw new Error("publication checkpoint did not survive reload");
    }

    await expect(publishCommunityPluginBundleSelectionV1(
      cloud.transport,
      { ...command, operationId: "different-publication" },
      reopened,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "pending-operation-required" });
  });

  it("does not overwrite a concurrent lifecycle observation", async () => {
    const { state, command } = publicationFixture();
    const cloud = harness(state);
    const applyCas = cloud.updateCas.getMockImplementation();
    if (!applyCas) throw new Error("CAS fixture missing");
    cloud.updateCas.mockImplementationOnce(async () => {
      const concurrent = apply(state, {
        type: "observe-participant",
        participant: participantA,
        operationId: "concurrent-observation",
        at: 12,
      });
      await applyCas("lifecycle-id", "etag-0", JSON.stringify(concurrent));
      throw new Error("412");
    });

    await expect(publishCommunityPluginBundleSelectionV1(
      cloud.transport,
      command,
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "write-race" });
    const current = JSON.parse(cloud.current()!.content);
    expect(current.revision).toBe(state.revision + 1);
    expect(current.pluginsById.calendar.currentGeneration.publishedBundle).toBeUndefined();
  });

  it("never creates a missing lifecycle registry and fails closed on stale state", async () => {
    const { state, command } = publicationFixture();
    const missing = harness();
    await expect(publishCommunityPluginBundleSelectionV1(
      missing.transport,
      command,
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "record-missing" });
    expect(missing.createOnly).not.toHaveBeenCalled();

    const stale = harness(apply(state, {
      type: "exit-plugin",
      participant: participantA,
      pluginId: "calendar",
      generation: 1,
      operationId: "exit-before-publication",
      at: 12,
    }));
    await expect(publishCommunityPluginBundleSelectionV1(
      stale.transport,
      { ...command, expectedRevision: stale.current()!.content
        ? JSON.parse(stale.current()!.content).revision
        : command.expectedRevision },
      null,
      checkpointWriter,
    )).resolves.toEqual({ status: "blocked", reason: "participant-not-joined" });
    expect(stale.updateCas).not.toHaveBeenCalled();
  });
});

async function harnessCreate(
  cloud: ReturnType<typeof harness>,
  content: string,
): Promise<void> {
  cloud.read.mockResolvedValueOnce({
    id: "lifecycle-id",
    eTag: "etag-recovered",
    content,
  });
}
