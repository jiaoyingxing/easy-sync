import { describe, expect, it } from "vitest";
import {
  communityPluginGenerationNamespaceRootV1,
  communityPluginGenerationManifestObjectPathV1,
  communityPluginGenerationObjectPathV1,
  createCommunityPluginBundlePublicationCommandV1,
  createCommunityPluginGenerationContentGrantV1,
  createCommunityPluginGenerationRestoreProjectionV1,
  isCommunityPluginGenerationContentGrantV1,
  parseCommunityPluginGenerationObjectPathV1,
  projectCommunityPluginGenerationRestorePlanItemsV1,
  prepareCommunityPluginGenerationBundleManifestV1,
  readCommunityPluginGenerationBundleManifestV1,
  validateCommunityPluginGenerationContentGrantV1,
  validateCommunityPluginGenerationRestoreProjectionV1,
  type CommunityPluginGenerationBundleFileNameV1,
  type CommunityPluginGenerationContentGrantV1,
} from "../src/sync/community-plugin-generation-content-v1";
import {
  createCommunityPluginLifecycleControlV1,
  isCommunityPluginLifecycleControlV1,
  reduceCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginParticipantIdentityV1,
} from "../src/sync/community-plugin-lifecycle-v1";
import { SyncActionType, type SyncScope } from "../src/sync/types";

const scope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};
const participantA = { participantId: "participant-a", incarnation: "incarnation-a" };
const participantB = { participantId: "participant-b", incarnation: "incarnation-b" };
const hash = "a".repeat(64);
const controlRecordId = "community-plugin-lifecycle-record";

function apply(
  state: CommunityPluginLifecycleControlV1,
  input: Omit<CommunityPluginLifecycleCommandV1, "scope" | "expectedRevision" | "at" | "operationId">,
  operationId: string,
  at: number,
): CommunityPluginLifecycleControlV1 {
  const result = reduceCommunityPluginLifecycleV1(state, {
    ...input,
    operationId,
    expectedRevision: state.revision,
    scope,
    at,
  } as CommunityPluginLifecycleCommandV1);
  expect(result.status).toBe("applied");
  return result.state;
}

function register(
  state: CommunityPluginLifecycleControlV1,
  participant: CommunityPluginParticipantIdentityV1,
  suffix: string,
  at: number,
): CommunityPluginLifecycleControlV1 {
  return apply(state, { type: "register-participant", participant }, `register-${suffix}`, at);
}

function join(
  state: CommunityPluginLifecycleControlV1,
  participant: CommunityPluginParticipantIdentityV1,
  suffix: string,
  at: number,
): CommunityPluginLifecycleControlV1 {
  return apply(state, {
    type: "join-plugin",
    participant,
    pluginId: "calendar",
    targetGeneration: 1,
    joinNonce: `join-nonce-${suffix}`,
    joinEvidence: "user-confirmed",
  }, `join-operation-${suffix}`, at);
}

function readyGrant(state: CommunityPluginLifecycleControlV1) {
  const result = createCommunityPluginGenerationContentGrantV1({
    control: state,
    scope,
    participant: participantA,
    pluginId: "calendar",
  });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("grant was not ready");
  return result.grant;
}

function objectReceipt(
  grant: CommunityPluginGenerationContentGrantV1,
  fileName: CommunityPluginGenerationBundleFileNameV1,
  fill: string,
) {
  const sha256Hash = fill.repeat(64);
  return {
    fileName,
    objectPath: communityPluginGenerationObjectPathV1(grant, sha256Hash),
    remoteId: `remote-${fileName}`,
    parentId: "generation-objects-parent",
    size: fileName.length,
    eTag: `etag-${fileName}`,
    cTag: `ctag-${fileName}`,
    sha256Hash,
  };
}

async function sealedBundle() {
  let state = createCommunityPluginLifecycleControlV1(scope);
  state = register(state, participantA, "sealed-a", 10);
  state = apply(state, {
    type: "confirm-legacy-migration",
    actor: participantA,
    evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
  }, "confirm-legacy-sealed-a", 11);
  state = join(state, participantA, "sealed-a", 12);
  const grant = readyGrant(state);
  const prepared = await prepareCommunityPluginGenerationBundleManifestV1(grant, [
    objectReceipt(grant, "main.js", "a"),
    objectReceipt(grant, "manifest.json", "b"),
    objectReceipt(grant, "styles.css", "c"),
  ]);
  const publication = await createCommunityPluginBundlePublicationCommandV1({
    grant,
    control: state,
    prepared,
    manifestObject: {
      objectPath: prepared.objectPath,
      remoteId: "sealed-manifest-object",
      parentId: "generation-manifests-parent",
      size: prepared.bytes.byteLength,
      eTag: "sealed-manifest-etag",
      cTag: "sealed-manifest-ctag",
      sha256Hash: prepared.sha256Hash,
    },
    operationId: "publish-sealed-a",
    at: 13,
  });
  const published = reduceCommunityPluginLifecycleV1(state, publication);
  expect(published.status).toBe("applied");
  if (published.status !== "applied") throw new Error("publication was not applied");
  state = published.state;
  const publishedBundle = state.pluginsById.calendar.currentGeneration?.publishedBundle;
  if (!publishedBundle) throw new Error("published bundle is missing");
  state = apply(state, {
    type: "seal-plugin-legacy-authority",
    actor: participantA,
    pluginId: "calendar",
    generation: 1,
    publishedBundle,
  }, "seal-legacy-a", 14);
  return { state, prepared };
}

async function reopenedBundle() {
  const sealed = await sealedBundle();
  let state = apply(sealed.state, {
    type: "exit-plugin",
    participant: participantA,
    pluginId: "calendar",
    generation: 1,
  }, "exit-sealed-generation", 15);
  state = apply(state, {
    type: "begin-close",
    actor: participantA,
    pluginId: "calendar",
    generation: 1,
  }, "begin-close-sealed-generation", 16);
  state = apply(state, {
    type: "complete-close",
    actor: participantA,
    pluginId: "calendar",
    generation: 1,
    cleanupReceiptDigest: "d".repeat(64),
  }, "complete-close-sealed-generation", 17);
  const observedClosedRevision = state.revision;
  state = apply(state, {
    type: "join-plugin",
    participant: participantA,
    pluginId: "calendar",
    targetGeneration: 2,
    joinNonce: "join-nonce-reopened-a",
    joinEvidence: "user-confirmed",
    observedClosedRevision,
  }, "join-reopened-generation", 18);
  const grant = readyGrant(state);
  const prepared = await prepareCommunityPluginGenerationBundleManifestV1(grant, [
    objectReceipt(grant, "main.js", "d"),
    objectReceipt(grant, "manifest.json", "e"),
  ]);
  const publication = await createCommunityPluginBundlePublicationCommandV1({
    grant,
    control: state,
    prepared,
    manifestObject: {
      objectPath: prepared.objectPath,
      remoteId: "reopened-manifest-object",
      parentId: "generation-two-manifests-parent",
      size: prepared.bytes.byteLength,
      eTag: "reopened-manifest-etag",
      cTag: "reopened-manifest-ctag",
      sha256Hash: prepared.sha256Hash,
    },
    operationId: "publish-reopened-generation",
    at: 19,
  });
  const published = reduceCommunityPluginLifecycleV1(state, publication);
  expect(published.status).toBe("applied");
  if (published.status !== "applied") throw new Error("reopened publication failed");
  return { state: published.state, prepared };
}

describe("community-plugin generation content v1", () => {
  it("grants only a joined active participant an immutable object namespace", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "a", 11);

    const grant = readyGrant(state);
    expect(grant.capability).toBe("stage-immutable-object");
    expect(grant.namespaceRoot).toBe(
      "community-plugin-content-v1/plugins/63616c656e646172/generations/1",
    );
    expect(communityPluginGenerationObjectPathV1(grant, hash)).toBe(
      `${grant.namespaceRoot}/objects/${hash}.bin`,
    );
    expect(validateCommunityPluginGenerationContentGrantV1(grant, state)).toEqual({
      status: "valid",
    });
  });

  it("allows observation-only revisions but expires every older grant after a retirement fence", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = register(state, participantB, "b", 11);
    state = join(state, participantA, "a", 12);
    const grant = readyGrant(state);

    state = apply(state, {
      type: "observe-participant",
      participant: participantB,
    }, "observe-b", 13);
    expect(validateCommunityPluginGenerationContentGrantV1(grant, state)).toEqual({
      status: "valid",
    });

    state = apply(state, {
      type: "retire-participant",
      actor: participantB,
      target: participantA,
    }, "retire-a", 14);
    expect(validateCommunityPluginGenerationContentGrantV1(grant, state)).toEqual({
      status: "blocked",
      reason: "fence-changed",
    });
  });

  it("blocks an exited member and never treats a fixed legacy path as generation content", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "a", 11);
    const grant = readyGrant(state);
    state = apply(state, {
      type: "exit-plugin",
      participant: participantA,
      pluginId: "calendar",
      generation: 1,
    }, "exit-operation-a", 12);

    expect(validateCommunityPluginGenerationContentGrantV1(grant, state)).toEqual({
      status: "blocked",
      reason: "participant-not-joined",
    });
    expect(parseCommunityPluginGenerationObjectPathV1(
      ".obsidian/plugins/calendar/main.js",
    )).toBeNull();
  });

  it("parses only canonical generation object paths and rejects path confusion", () => {
    const path = `${communityPluginGenerationNamespaceRootV1("calendar", 12)}/objects/${hash}.bin`;
    expect(parseCommunityPluginGenerationObjectPathV1(path)).toEqual({
      pluginId: "calendar",
      generation: 12,
      sha256Hash: hash,
    });
    expect(parseCommunityPluginGenerationObjectPathV1(path.replace("/12/", "/012/")))
      .toBeNull();
    expect(parseCommunityPluginGenerationObjectPathV1(path.replace("6361", "zz61")))
      .toBeNull();
    expect(parseCommunityPluginGenerationObjectPathV1(path.replace(".bin", ".js")))
      .toBeNull();
  });

  it("uses a case-preserving encoded plugin key so OneDrive casing cannot alias identities", () => {
    expect(communityPluginGenerationNamespaceRootV1("calendar", 1)).not.toBe(
      communityPluginGenerationNamespaceRootV1("Calendar", 1),
    );
    const upperPath = `${communityPluginGenerationNamespaceRootV1("Calendar", 1)}/objects/${hash}.bin`;
    expect(parseCommunityPluginGenerationObjectPathV1(upperPath)?.pluginId).toBe("Calendar");
  });

  it("prepares one canonical complete manifest and publishes only its verified immutable pointer", async () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "a", 11);
    const grant = readyGrant(state);
    const main = objectReceipt(grant, "main.js", "a");
    const manifest = objectReceipt(grant, "manifest.json", "b");
    const prepared = await prepareCommunityPluginGenerationBundleManifestV1(
      grant,
      [manifest, main],
    );

    expect(prepared.manifest.members.map((member) => member.fileName)).toEqual([
      "main.js",
      "manifest.json",
    ]);
    expect(prepared.objectPath).toBe(
      communityPluginGenerationManifestObjectPathV1(grant, prepared.sha256Hash),
    );
    const command = await createCommunityPluginBundlePublicationCommandV1({
      grant,
      control: state,
      prepared,
      manifestObject: {
        objectPath: prepared.objectPath,
        remoteId: "manifest-object",
        parentId: "generation-manifests-parent",
        size: prepared.bytes.byteLength,
        eTag: "manifest-etag",
        cTag: "manifest-ctag",
        sha256Hash: prepared.sha256Hash,
      },
      operationId: "publish-operation-a",
      at: 12,
    });
    const published = reduceCommunityPluginLifecycleV1(state, command);
    expect(published.status).toBe("applied");
    if (published.status !== "applied") throw new Error("publication was not applied");
    state = published.state;
    expect(state.pluginsById.calendar.currentGeneration?.publishedBundle).toMatchObject({
      publicationRevision: 1,
      publisher: participantA,
      publisherJoinNonce: "join-nonce-a",
      publishedFenceEpoch: 0,
      manifestObject: {
        objectPath: prepared.objectPath,
        remoteId: "manifest-object",
        sha256Hash: prepared.sha256Hash,
      },
    });
    expect(isCommunityPluginLifecycleControlV1(state)).toBe(true);

    expect(reduceCommunityPluginLifecycleV1(state, command).status).toBe("idempotent");
  });

  it("increments only the bundle pointer revision and rejects incomplete or mismatched receipts", async () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "a", 11);
    const grant = readyGrant(state);
    await expect(prepareCommunityPluginGenerationBundleManifestV1(
      grant,
      [objectReceipt(grant, "manifest.json", "b")],
    )).rejects.toThrow("incomplete");

    const prepared = await prepareCommunityPluginGenerationBundleManifestV1(grant, [
      objectReceipt(grant, "main.js", "a"),
      objectReceipt(grant, "manifest.json", "b"),
    ]);
    await expect(createCommunityPluginBundlePublicationCommandV1({
      grant,
      control: state,
      prepared,
      manifestObject: {
        remoteId: "manifest-object",
        parentId: "generation-manifests-parent",
        size: prepared.bytes.byteLength,
        eTag: "manifest-etag",
        cTag: "",
        sha256Hash: "f".repeat(64),
      },
      operationId: "publish-operation-b",
      at: 12,
    })).rejects.toThrow("read-back is incomplete");
  });

  it("reads only canonical manifest bytes bound to the exact current generation and hash", async () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "a", 11);
    const grant = readyGrant(state);
    const prepared = await prepareCommunityPluginGenerationBundleManifestV1(grant, [
      objectReceipt(grant, "main.js", "a"),
      objectReceipt(grant, "manifest.json", "b"),
    ]);
    expect(await readCommunityPluginGenerationBundleManifestV1(
      prepared.bytes,
      grant,
      prepared.sha256Hash,
    )).toMatchObject({ sha256Hash: prepared.sha256Hash });
    expect(await readCommunityPluginGenerationBundleManifestV1(
      prepared.bytes,
      grant,
      "f".repeat(64),
    )).toBeNull();

    const nonCanonical = new TextEncoder().encode(
      JSON.stringify({ ...prepared.manifest, unexpected: true }),
    ).buffer;
    expect(await readCommunityPluginGenerationBundleManifestV1(
      nonCanonical,
      grant,
      prepared.sha256Hash,
    )).toBeNull();
  });

  it("cannot publish after exit or after a retirement fence invalidates the grant", async () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = register(state, participantB, "b", 11);
    state = join(state, participantA, "a", 12);
    const grant = readyGrant(state);
    const prepared = await prepareCommunityPluginGenerationBundleManifestV1(grant, [
      objectReceipt(grant, "main.js", "a"),
      objectReceipt(grant, "manifest.json", "b"),
    ]);
    const manifestObject = {
      objectPath: prepared.objectPath,
      remoteId: "manifest-object",
      parentId: "generation-manifests-parent",
      size: prepared.bytes.byteLength,
      eTag: "manifest-etag",
      cTag: "",
      sha256Hash: prepared.sha256Hash,
    };

    state = apply(state, {
      type: "exit-plugin",
      participant: participantA,
      pluginId: "calendar",
      generation: 1,
    }, "exit-operation-a", 13);
    await expect(createCommunityPluginBundlePublicationCommandV1({
      grant,
      control: state,
      prepared,
      manifestObject,
      operationId: "publish-operation-c",
      at: 14,
    })).rejects.toThrow("participant-not-joined");

    let retired = createCommunityPluginLifecycleControlV1(scope);
    retired = register(retired, participantA, "a2", 20);
    retired = register(retired, participantB, "b2", 21);
    retired = join(retired, participantA, "a2", 22);
    const oldGrant = readyGrant(retired);
    retired = apply(retired, {
      type: "retire-participant",
      actor: participantB,
      target: participantA,
    }, "retire-operation-a", 23);
    expect(validateCommunityPluginGenerationContentGrantV1(oldGrant, retired)).toEqual({
      status: "blocked",
      reason: "fence-changed",
    });
  });

  it("rejects wrong scope, missing generation and tampered grants without mutation authority", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    expect(createCommunityPluginGenerationContentGrantV1({
      control: state,
      scope,
      participant: participantA,
      pluginId: "calendar",
    })).toEqual({ status: "blocked", reason: "generation-missing" });

    state = join(state, participantA, "a", 11);
    expect(createCommunityPluginGenerationContentGrantV1({
      control: state,
      scope: { ...scope, vaultFolderId: "other-vault" },
      participant: participantA,
      pluginId: "calendar",
    })).toEqual({ status: "blocked", reason: "scope-mismatch" });

    const grant = readyGrant(state);
    const tampered = { ...grant, namespaceRoot: `${grant.namespaceRoot}/other` };
    expect(isCommunityPluginGenerationContentGrantV1(tampered)).toBe(false);
    expect(validateCommunityPluginGenerationContentGrantV1(tampered, state)).toEqual({
      status: "blocked",
      reason: "invalid-grant",
    });
  });

  it("projects a sealed manifest into explicit Vault targets without forging files-root identity", async () => {
    const { state, prepared } = await sealedBundle();
    const result = await createCommunityPluginGenerationRestoreProjectionV1({
      control: state,
      scope,
      participant: participantA,
      pluginId: "calendar",
      configDir: ".obsidian",
      controlRecordId,
      manifestContent: prepared.bytes,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("restore projection was not ready");
    expect(result.projection.members.map((member) => member.targetPath)).toEqual([
      ".obsidian/plugins/calendar/main.js",
      ".obsidian/plugins/calendar/manifest.json",
      ".obsidian/plugins/calendar/styles.css",
    ]);
    expect(result.projection.members.map((member) => member.source.remoteId)).toEqual([
      "remote-main.js",
      "remote-manifest.json",
      "remote-styles.css",
    ]);
    expect(result.projection).not.toHaveProperty("remoteEntries");
    const planItems = projectCommunityPluginGenerationRestorePlanItemsV1(
      result.projection,
    );
    expect(planItems.map((item) => [
      item.type,
      item.path,
      item.remote?.path,
      item.remote?.driveId,
    ])).toEqual([
      [
        SyncActionType.Download,
        ".obsidian/plugins/calendar/main.js",
        result.projection.members[0].source.objectPath,
        "remote-main.js",
      ],
      [
        SyncActionType.Download,
        ".obsidian/plugins/calendar/manifest.json",
        result.projection.members[1].source.objectPath,
        "remote-manifest.json",
      ],
      [
        SyncActionType.Download,
        ".obsidian/plugins/calendar/styles.css",
        result.projection.members[2].source.objectPath,
        "remote-styles.css",
      ],
    ]);
    expect(planItems.every((item) =>
      item.generationRestore?.manifestObject.remoteId
        === "sealed-manifest-object"
      && item.generationRestore.participant.participantId
        === participantA.participantId
    )).toBe(true);
    expect(validateCommunityPluginGenerationRestoreProjectionV1(
      result.projection,
      state,
      controlRecordId,
    )).toEqual({ status: "valid" });
    expect(validateCommunityPluginGenerationRestoreProjectionV1(
      result.projection,
      state,
      "replacement-lifecycle-record",
    )).toEqual({ status: "blocked", reason: "control-record-changed" });
  });

  it("projects a later generation while preserving the original legacy cutoff", async () => {
    const { state, prepared } = await reopenedBundle();
    expect(state.pluginsById.calendar).toMatchObject({
      legacyAuthoritySeal: { generation: 1 },
      currentGeneration: {
        generation: 2,
        phase: "open",
        publishedBundle: { publicationRevision: 1 },
      },
    });

    const result = await createCommunityPluginGenerationRestoreProjectionV1({
      control: state,
      scope,
      participant: participantA,
      pluginId: "calendar",
      configDir: ".obsidian",
      controlRecordId,
      manifestContent: prepared.bytes,
    });

    expect(result).toMatchObject({
      status: "ready",
      projection: {
        generation: 2,
        manifestObject: { remoteId: "reopened-manifest-object" },
      },
    });
    if (result.status !== "ready") throw new Error("reopened projection was not ready");
    expect(validateCommunityPluginGenerationRestoreProjectionV1(
      result.projection,
      state,
      controlRecordId,
    )).toEqual({ status: "valid" });
  });

  it("keeps a restore projection valid across observation-only revisions", async () => {
    const { state: sealed, prepared } = await sealedBundle();
    const result = await createCommunityPluginGenerationRestoreProjectionV1({
      control: sealed,
      scope,
      participant: participantA,
      pluginId: "calendar",
      configDir: ".obsidian",
      controlRecordId,
      manifestContent: prepared.bytes,
    });
    if (result.status !== "ready") throw new Error("restore projection was not ready");
    const observed = apply(sealed, {
      type: "observe-participant",
      participant: participantA,
    }, "observe-after-seal", 15);
    expect(observed.revision).toBeGreaterThan(result.projection.observedControlRevision);
    expect(observed.fenceEpoch).toBe(result.projection.fenceEpoch);
    expect(validateCommunityPluginGenerationRestoreProjectionV1(
      result.projection,
      observed,
      controlRecordId,
    )).toEqual({ status: "valid" });
  });

  it("blocks unsealed, tampered and path-confused restore evidence before transfer", async () => {
    let unsealed = createCommunityPluginLifecycleControlV1(scope);
    unsealed = register(unsealed, participantA, "unsealed-a", 10);
    unsealed = join(unsealed, participantA, "unsealed-a", 11);
    const unsealedGrant = readyGrant(unsealed);
    const unsealedManifest = await prepareCommunityPluginGenerationBundleManifestV1(
      unsealedGrant,
      [
        objectReceipt(unsealedGrant, "main.js", "a"),
        objectReceipt(unsealedGrant, "manifest.json", "b"),
      ],
    );
    await expect(createCommunityPluginGenerationRestoreProjectionV1({
      control: unsealed,
      scope,
      participant: participantA,
      pluginId: "calendar",
      configDir: ".obsidian",
      controlRecordId,
      manifestContent: unsealedManifest.bytes,
    })).resolves.toEqual({
      status: "blocked",
      reason: "legacy-authority-unsealed",
    });

    const { state: sealed, prepared } = await sealedBundle();
    const tampered = new Uint8Array(prepared.bytes.slice(0));
    tampered[Math.max(0, tampered.length - 2)] ^= 1;
    await expect(createCommunityPluginGenerationRestoreProjectionV1({
      control: sealed,
      scope,
      participant: participantA,
      pluginId: "calendar",
      configDir: ".obsidian",
      controlRecordId,
      manifestContent: tampered.buffer,
    })).resolves.toEqual({ status: "blocked", reason: "manifest-invalid" });
    await expect(createCommunityPluginGenerationRestoreProjectionV1({
      control: sealed,
      scope,
      participant: participantA,
      pluginId: "calendar",
      configDir: "../.obsidian",
      controlRecordId,
      manifestContent: prepared.bytes,
    })).resolves.toEqual({ status: "blocked", reason: "invalid-target-root" });
  });

  it("invalidates a restore projection when a later fence or target binding changes", async () => {
    const { state: sealed, prepared } = await sealedBundle();
    const result = await createCommunityPluginGenerationRestoreProjectionV1({
      control: sealed,
      scope,
      participant: participantA,
      pluginId: "calendar",
      configDir: ".obsidian",
      controlRecordId,
      manifestContent: prepared.bytes,
    });
    if (result.status !== "ready") throw new Error("restore projection was not ready");
    let fenced = register(sealed, participantB, "fenced-b", 15);
    fenced = apply(fenced, {
      type: "retire-participant",
      actor: participantA,
      target: participantB,
    }, "retire-fenced-b", 16);
    expect(validateCommunityPluginGenerationRestoreProjectionV1(
      result.projection,
      fenced,
      controlRecordId,
    )).toEqual({ status: "blocked", reason: "fence-changed" });

    const pathConfused = structuredClone(result.projection);
    pathConfused.members[0].targetPath = ".obsidian/plugins/other/main.js";
    expect(validateCommunityPluginGenerationRestoreProjectionV1(
      pathConfused,
      sealed,
      controlRecordId,
    )).toEqual({ status: "blocked", reason: "invalid-grant" });
  });
});
