import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  communityPluginCloseEligibilityV1,
  communityPluginParticipantAvailabilityV1,
  communityPluginParticipantKeyV1,
  communityPluginPublishedManifestObjectPathV1,
  createCommunityPluginLifecycleControlV1,
  isCommunityPluginLifecycleControlV1,
  reduceCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginParticipantIdentityV1,
  type CommunityPluginPublishedManifestObjectV1,
} from "../src/sync/community-plugin-lifecycle-v1";
import type { SyncScope } from "../src/sync/types";

const scope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};
const otherScope: SyncScope = { ...scope, vaultFolderId: "other-vault" };
const participantA = identity("participant-a", "incarnation-a");
const participantB = identity("participant-b", "incarnation-b");
const participantC = identity("participant-c", "incarnation-c");
const participantD = identity("participant-d", "incarnation-d");
const receiptA = "a".repeat(64);
const receiptB = "b".repeat(64);
const manifestHash = "c".repeat(64);

type CommandInput<T = CommunityPluginLifecycleCommandV1> = T extends unknown
  ? Omit<T, "scope" | "expectedRevision" | "at" | "operationId">
  : never;

function identity(
  participantId: string,
  incarnation: string,
): CommunityPluginParticipantIdentityV1 {
  return { participantId, incarnation };
}

function command(
  state: CommunityPluginLifecycleControlV1,
  input: CommandInput,
  operationId: string,
  at: number,
): CommunityPluginLifecycleCommandV1 {
  return {
    ...input,
    scope,
    expectedRevision: state.revision,
    operationId,
    at,
  } as CommunityPluginLifecycleCommandV1;
}

function apply(
  state: CommunityPluginLifecycleControlV1,
  input: CommandInput,
  operationId: string,
  at: number,
): CommunityPluginLifecycleControlV1 {
  const result = reduceCommunityPluginLifecycleV1(
    state,
    command(state, input, operationId, at),
  );
  expect(result.status).toBe("applied");
  return result.state;
}

function register(
  state: CommunityPluginLifecycleControlV1,
  participant: CommunityPluginParticipantIdentityV1,
  suffix: string,
  at: number,
): CommunityPluginLifecycleControlV1 {
  return apply(
    state,
    { type: "register-participant", participant },
    `register-${suffix}`,
    at,
  );
}

function join(
  state: CommunityPluginLifecycleControlV1,
  participant: CommunityPluginParticipantIdentityV1,
  suffix: string,
  at: number,
  observedClosedRevision?: number,
): CommunityPluginLifecycleControlV1 {
  const lifecycle = state.pluginsById.calendar;
  const targetGeneration = lifecycle?.currentGeneration?.phase === "closed"
    ? lifecycle.generationHighWatermark + 1
    : lifecycle?.currentGeneration?.generation ?? 1;
  return apply(
    state,
    {
      type: "join-plugin",
      participant,
      pluginId: "calendar",
      targetGeneration,
      joinNonce: `join-nonce-${suffix}`,
      joinEvidence: "user-confirmed",
      observedClosedRevision,
    },
    `join-operation-${suffix}`,
    at,
  );
}

function exitPlugin(
  state: CommunityPluginLifecycleControlV1,
  participant: CommunityPluginParticipantIdentityV1,
  suffix: string,
  at: number,
  generation = 1,
): CommunityPluginLifecycleControlV1 {
  return apply(
    state,
    { type: "exit-plugin", participant, pluginId: "calendar", generation },
    `exit-operation-${suffix}`,
    at,
  );
}

function manifestObject(suffix: string): CommunityPluginPublishedManifestObjectV1 {
  return {
    objectPath: communityPluginPublishedManifestObjectPathV1(
      "calendar",
      1,
      manifestHash,
    ),
    remoteId: `manifest-${suffix}`,
    parentId: "manifest-parent",
    size: 256,
    eTag: `etag-${suffix}`,
    cTag: `ctag-${suffix}`,
    sha256Hash: manifestHash,
  };
}

function publish(
  state: CommunityPluginLifecycleControlV1,
  suffix: string,
  at: number,
): CommunityPluginLifecycleControlV1 {
  return apply(
    state,
    {
      type: "publish-plugin-bundle",
      participant: participantA,
      pluginId: "calendar",
      generation: 1,
      joinNonce: "join-nonce-a",
      fenceEpoch: state.fenceEpoch,
      manifestObject: manifestObject(suffix),
    },
    `publish-${suffix}`,
    at,
  );
}

describe("community-plugin lifecycle v1 pure control state", () => {
  it("upgrades observation-only state only through one explicit legacy migration confirmation", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    expect(state).toMatchObject({
      schemaVersion: 2,
      fenceEpoch: 0,
      legacyMigrationConsent: null,
      pluginsById: {},
    });

    // S7 created schema version 1 before the migration contract existed. It
    // remains readable, and ordinary observation does not silently upgrade it.
    const observationOnly = structuredClone(state) as CommunityPluginLifecycleControlV1;
    observationOnly.schemaVersion = 1;
    delete observationOnly.legacyMigrationConsent;
    state = register(observationOnly, participantA, "legacy-a", 10);
    expect(state).toMatchObject({ schemaVersion: 1, fenceEpoch: 0 });
    expect(state).not.toHaveProperty("legacyMigrationConsent");

    const confirm = command(
      state,
      {
        type: "confirm-legacy-migration",
        actor: participantA,
        evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
      },
      "confirm-legacy-migration-a",
      11,
    );
    const confirmed = reduceCommunityPluginLifecycleV1(state, confirm);
    expect(confirmed.status).toBe("applied");
    state = confirmed.state;
    expect(state).toMatchObject({
      schemaVersion: 2,
      revision: 3,
      fenceEpoch: 1,
      pluginsById: {},
      legacyMigrationConsent: {
        confirmedBy: participantA,
        confirmedAt: 11,
        confirmedRevision: 3,
        confirmedFenceEpoch: 1,
        evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
      },
    });
    expect(isCommunityPluginLifecycleControlV1(state)).toBe(true);
    expect(reduceCommunityPluginLifecycleV1(state, confirm)).toMatchObject({
      status: "idempotent",
      state,
    });

    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "confirm-legacy-migration",
          actor: participantA,
          evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
        },
        "confirm-legacy-migration-again",
        12,
      ),
    )).toMatchObject({
      status: "blocked",
      reason: "legacy-migration-already-confirmed",
      state,
    });
  });

  it("seals one plugin only from an exact post-consent publication and advances the fence", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "a", 11);
    state = publish(state, "before-consent", 12);
    const preConsentBundle = structuredClone(
      state.pluginsById.calendar.currentGeneration!.publishedBundle!,
    );

    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "seal-plugin-legacy-authority",
          actor: participantA,
          pluginId: "calendar",
          generation: 1,
          publishedBundle: preConsentBundle,
        },
        "seal-without-consent",
        13,
      ),
    )).toMatchObject({
      status: "blocked",
      reason: "legacy-migration-consent-required",
      state,
    });

    state = apply(
      state,
      {
        type: "confirm-legacy-migration",
        actor: participantA,
        evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
      },
      "confirm-before-seal",
      13,
    );
    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "seal-plugin-legacy-authority",
          actor: participantA,
          pluginId: "calendar",
          generation: 1,
          publishedBundle: preConsentBundle,
        },
        "seal-stale-publication",
        14,
      ),
    )).toMatchObject({
      status: "blocked",
      reason: "publication-fence-changed",
      state,
    });

    state = publish(state, "after-consent", 14);
    const publishedBundle = structuredClone(
      state.pluginsById.calendar.currentGeneration!.publishedBundle!,
    );
    const seal = command(
      state,
      {
        type: "seal-plugin-legacy-authority",
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        publishedBundle,
      },
      "seal-calendar-generation-one",
      15,
    );
    const sealed = reduceCommunityPluginLifecycleV1(state, seal);
    expect(sealed.status).toBe("applied");
    if (sealed.status !== "applied") throw new Error("seal was not applied");
    state = sealed.state;
    expect(state).toMatchObject({
      fenceEpoch: 2,
      pluginsById: {
        calendar: {
          generationHighWatermark: 1,
          legacyAuthoritySeal: {
            generation: 1,
            sealedBy: participantA,
            sealedAt: 15,
            sealedRevision: state.revision,
            sealedFenceEpoch: 2,
            consentRevision: state.legacyMigrationConsent!.confirmedRevision,
            publishedBundle,
          },
        },
      },
    });
    expect(isCommunityPluginLifecycleControlV1(state)).toBe(true);
    const wrongConsentRevision = structuredClone(state);
    wrongConsentRevision.pluginsById.calendar.legacyAuthoritySeal!.consentRevision -= 1;
    expect(isCommunityPluginLifecycleControlV1(wrongConsentRevision)).toBe(false);
    const wrongSealFence = structuredClone(state);
    wrongSealFence.pluginsById.calendar.legacyAuthoritySeal!.sealedFenceEpoch =
      publishedBundle.publishedFenceEpoch;
    expect(isCommunityPluginLifecycleControlV1(wrongSealFence)).toBe(false);
    const schemaOneWithSeal = structuredClone(state);
    schemaOneWithSeal.schemaVersion = 1;
    delete schemaOneWithSeal.legacyMigrationConsent;
    expect(isCommunityPluginLifecycleControlV1(schemaOneWithSeal)).toBe(false);
    expect(reduceCommunityPluginLifecycleV1(state, seal)).toMatchObject({
      status: "idempotent",
      state,
    });
    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "seal-plugin-legacy-authority",
          actor: participantA,
          pluginId: "calendar",
          generation: 1,
          publishedBundle,
        },
        "seal-calendar-again",
        16,
      ),
    )).toMatchObject({
      status: "blocked",
      reason: "legacy-authority-already-sealed",
      state,
    });
  });

  it("does not seal from a changed publication snapshot or another participant", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = register(state, participantB, "b", 11);
    state = join(state, participantA, "a", 12);
    state = apply(
      state,
      {
        type: "confirm-legacy-migration",
        actor: participantA,
        evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
      },
      "confirm-for-mismatch",
      13,
    );
    state = publish(state, "current", 14);
    const currentBundle = structuredClone(
      state.pluginsById.calendar.currentGeneration!.publishedBundle!,
    );
    const changedBundle = structuredClone(currentBundle);
    changedBundle.manifestObject.eTag = "changed-etag";
    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "seal-plugin-legacy-authority",
          actor: participantA,
          pluginId: "calendar",
          generation: 1,
          publishedBundle: changedBundle,
        },
        "seal-changed-publication",
        15,
      ),
    )).toMatchObject({ status: "blocked", reason: "publication-changed" });
    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "seal-plugin-legacy-authority",
          actor: participantB,
          pluginId: "calendar",
          generation: 1,
          publishedBundle: currentBundle,
        },
        "seal-by-non-publisher",
        15,
      ),
    )).toMatchObject({ status: "blocked", reason: "participant-not-joined" });
    expect(state.pluginsById.calendar.legacyAuthoritySeal).toBeUndefined();
  });

  it("closes only after both devices exit and requires an explicit closed observation to reopen", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = register(state, participantB, "b", 11);
    state = join(state, participantA, "a", 12);
    state = join(state, participantB, "b", 13);
    state = exitPlugin(state, participantA, "a", 14);

    expect(communityPluginCloseEligibilityV1(state, "calendar", 1)).toEqual({
      eligible: false,
      blockers: [{ identity: participantB, reason: "still-joined" }],
    });

    state = exitPlugin(state, participantB, "b", 15);
    expect(communityPluginCloseEligibilityV1(state, "calendar", 1)).toEqual({
      eligible: true,
      blockers: [],
    });
    state = apply(
      state,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 1 },
      "begin-close-one",
      16,
    );

    const joinDuringClose = reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "join-plugin",
          participant: participantB,
          pluginId: "calendar",
          targetGeneration: 1,
          joinNonce: "join-nonce-during-close",
          joinEvidence: "user-confirmed",
        },
        "join-during-close",
        17,
      ),
    );
    expect(joinDuringClose).toMatchObject({ status: "blocked", reason: "generation-closing" });

    state = apply(
      state,
      {
        type: "complete-close",
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        cleanupReceiptDigest: receiptA,
      },
      "complete-close-one",
      18,
    );
    const closedRevision = state.revision;
    expect(state.pluginsById.calendar).toMatchObject({
      generationHighWatermark: 1,
      currentGeneration: { generation: 1, phase: "closed" },
      closedTombstones: [{ generation: 1, cleanupReceiptDigest: receiptA }],
    });

    const unprovenReinstall = reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "join-plugin",
          participant: participantB,
          pluginId: "calendar",
          targetGeneration: 2,
          joinNonce: "join-nonce-unproven",
          joinEvidence: "user-confirmed",
        },
        "join-without-closed-observation",
        19,
      ),
    );
    expect(unprovenReinstall).toMatchObject({
      status: "blocked",
      reason: "closed-observation-required",
    });
    const staleGenerationJoin = reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "join-plugin",
          participant: participantB,
          pluginId: "calendar",
          targetGeneration: 1,
          joinNonce: "join-nonce-stale-generation",
          joinEvidence: "user-confirmed",
          observedClosedRevision: closedRevision,
        },
        "join-stale-generation",
        20,
      ),
    );
    expect(staleGenerationJoin).toMatchObject({ status: "blocked", reason: "generation-mismatch" });

    state = join(state, participantB, "generation-two", 21, closedRevision);
    expect(state.pluginsById.calendar).toMatchObject({
      generationHighWatermark: 2,
      currentGeneration: {
        generation: 2,
        phase: "open",
        membersByKey: {
          [communityPluginParticipantKeyV1(participantB)]: {
            joinEvidence: "user-confirmed",
          },
        },
      },
      closedTombstones: [{ generation: 1 }],
    });
    expect(isCommunityPluginLifecycleControlV1(state)).toBe(true);
  });

  it("keeps a long-offline member as a blocker until another participant explicitly retires it", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = register(state, participantB, "b", 11);
    state = register(state, participantC, "c", 12);
    state = join(state, participantA, "a", 13);
    state = join(state, participantB, "b", 14);
    state = join(state, participantC, "c", 15);
    state = exitPlugin(state, participantA, "a", 16);
    state = exitPlugin(state, participantB, "b", 17);

    const participantCRecord = state.participantsByKey[communityPluginParticipantKeyV1(participantC)]!;
    expect(communityPluginParticipantAvailabilityV1(participantCRecord, 10_000, 100)).toBe("lost");
    expect(communityPluginCloseEligibilityV1(state, "calendar", 1)).toEqual({
      eligible: false,
      blockers: [{ identity: participantC, reason: "still-joined" }],
    });

    state = apply(
      state,
      { type: "retire-participant", actor: participantA, target: participantC },
      "retire-participant-c",
      10_001,
    );
    expect(communityPluginCloseEligibilityV1(state, "calendar", 1).eligible).toBe(true);

    const oldDeviceReturns = reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        { type: "observe-participant", participant: participantC },
        "observe-retired-c",
        10_002,
      ),
    );
    expect(oldDeviceReturns).toMatchObject({ status: "blocked", reason: "participant-retired" });

    state = apply(
      state,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 1 },
      "begin-close-after-retirement",
      10_003,
    );
    state = apply(
      state,
      {
        type: "complete-close",
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        cleanupReceiptDigest: receiptA,
      },
      "complete-close-after-retirement",
      10_004,
    );
    const observedClosedRevision = state.revision;
    const participantCNew = identity("participant-c", "incarnation-c-new");
    state = register(state, participantCNew, "c-new", 10_005);
    state = join(state, participantCNew, "c-new", 10_006, state.revision);
    expect(state.revision).toBe(observedClosedRevision + 2);
    expect(state.pluginsById.calendar.currentGeneration).toMatchObject({
      generation: 2,
      phase: "open",
    });
  });

  it("does not make a device that never joined this plugin block its closure", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = register(state, participantD, "d", 11);
    state = join(state, participantA, "a", 12);
    state = exitPlugin(state, participantA, "a", 13);

    expect(communityPluginCloseEligibilityV1(state, "calendar", 1)).toEqual({
      eligible: true,
      blockers: [],
    });
  });

  it("does not confuse copied or lost local identity with proof that the old incarnation exited", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "a", 11);
    const replacementA = identity("participant-a-new", "incarnation-a-new");
    state = register(state, replacementA, "a-replacement", 12);
    state = join(state, replacementA, "a-replacement", 13);
    state = exitPlugin(state, replacementA, "a-replacement", 14);

    expect(communityPluginCloseEligibilityV1(state, "calendar", 1)).toEqual({
      eligible: false,
      blockers: [{ identity: participantA, reason: "still-joined" }],
    });
  });

  it("serializes a rejoin racing with closure without accepting stale commands", () => {
    let base = createCommunityPluginLifecycleControlV1(scope);
    base = register(base, participantA, "a", 10);
    base = register(base, participantB, "b", 11);
    base = join(base, participantA, "a", 12);
    base = join(base, participantB, "b", 13);
    base = exitPlugin(base, participantA, "a", 14);
    base = exitPlugin(base, participantB, "b", 15);

    const staleClose = command(
      base,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 1 },
      "stale-close-command",
      17,
    );
    const rejoined = join(base, participantB, "wins-race", 16);
    expect(communityPluginCloseEligibilityV1(rejoined, "calendar", 1).eligible).toBe(false);
    expect(reduceCommunityPluginLifecycleV1(rejoined, staleClose)).toMatchObject({
      status: "blocked",
      reason: "revision-mismatch",
    });

    const closing = apply(
      base,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 1 },
      "close-wins-race",
      16,
    );
    const freshJoin = reduceCommunityPluginLifecycleV1(
      closing,
      command(
        closing,
        {
          type: "join-plugin",
          participant: participantB,
          pluginId: "calendar",
          targetGeneration: 1,
          joinNonce: "join-nonce-after-closing",
          joinEvidence: "user-confirmed",
        },
        "join-after-closing",
        17,
      ),
    );
    expect(freshJoin).toMatchObject({ status: "blocked", reason: "generation-closing" });
  });

  it("keeps operation retry idempotent and rejects wrong scope or revision without mutation", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    const registerA = command(
      state,
      { type: "register-participant", participant: participantA },
      "repeatable-register-a",
      10,
    );
    const applied = reduceCommunityPluginLifecycleV1(state, registerA);
    expect(applied.status).toBe("applied");
    state = applied.state;
    expect(reduceCommunityPluginLifecycleV1(state, registerA)).toMatchObject({ status: "idempotent" });
    state = register(state, participantB, "b-after-a", 11);
    expect(reduceCommunityPluginLifecycleV1(state, registerA)).toMatchObject({ status: "idempotent" });
    expect(reduceCommunityPluginLifecycleV1(state, {
      ...registerA,
      at: 99,
    })).toMatchObject({ status: "blocked", reason: "operation-id-reused", state });

    const wrongScope = {
      ...command(
        state,
        { type: "observe-participant", participant: participantA },
        "wrong-scope-observation",
        11,
      ),
      scope: otherScope,
    };
    expect(reduceCommunityPluginLifecycleV1(state, wrongScope)).toMatchObject({
      status: "blocked",
      reason: "scope-mismatch",
      state,
    });
    expect(reduceCommunityPluginLifecycleV1(state, {
      ...wrongScope,
      scope,
      expectedRevision: state.revision - 1,
    })).toMatchObject({ status: "blocked", reason: "revision-mismatch", state });
    expect(reduceCommunityPluginLifecycleV1(state, {
      ...wrongScope,
      scope,
      type: "unknown-command",
    } as unknown as CommunityPluginLifecycleCommandV1)).toMatchObject({
      status: "blocked",
      reason: "invalid-command",
      state,
    });
    expect(reduceCommunityPluginLifecycleV1(state, {
      ...command(
        state,
        {
          type: "join-plugin",
          participant: participantA,
          pluginId: "calendar",
          targetGeneration: 1,
          joinNonce: "join-without-evidence",
          joinEvidence: "user-confirmed",
        },
        "join-missing-evidence",
        12,
      ),
      joinEvidence: undefined,
    } as unknown as CommunityPluginLifecycleCommandV1)).toMatchObject({
      status: "blocked",
      reason: "invalid-command",
      state,
    });
  });

  it("rejects self-retirement, a closing-owner retirement and backwards lifecycle time", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = register(state, participantB, "b", 11);
    state = join(state, participantA, "a", 12);
    state = exitPlugin(state, participantA, "a", 13);

    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        { type: "retire-participant", actor: participantA, target: participantA },
        "self-retirement",
        14,
      ),
    )).toMatchObject({ status: "blocked", reason: "self-retirement-forbidden" });
    state = apply(
      state,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 1 },
      "begin-close-owner-protection",
      15,
    );
    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        { type: "retire-participant", actor: participantB, target: participantA },
        "retire-closing-owner",
        16,
      ),
    )).toMatchObject({ status: "blocked", reason: "closing-owner-retirement-forbidden" });
    expect(reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        {
          type: "complete-close",
          actor: participantA,
          pluginId: "calendar",
          generation: 1,
          cleanupReceiptDigest: receiptA,
        },
        "backwards-close-time",
        14,
      ),
    )).toMatchObject({ status: "blocked", reason: "invalid-command" });
  });

  it("keeps tombstones and the generation high watermark monotonic across repeated lifecycles", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "generation-one", 11);
    state = exitPlugin(state, participantA, "generation-one", 12);
    state = apply(
      state,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 1 },
      "begin-close-generation-one",
      13,
    );
    state = apply(
      state,
      {
        type: "complete-close",
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        cleanupReceiptDigest: receiptA,
      },
      "complete-close-generation-one",
      14,
    );
    state = join(state, participantA, "generation-two", 15, state.revision);
    state = exitPlugin(state, participantA, "generation-two", 16, 2);
    state = apply(
      state,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 2 },
      "begin-close-generation-two",
      17,
    );
    state = apply(
      state,
      {
        type: "complete-close",
        actor: participantA,
        pluginId: "calendar",
        generation: 2,
        cleanupReceiptDigest: receiptB,
      },
      "complete-close-generation-two",
      18,
    );
    state = join(state, participantA, "generation-three", 19, state.revision);

    expect(state.pluginsById.calendar).toMatchObject({
      generationHighWatermark: 3,
      currentGeneration: { generation: 3, phase: "open" },
      closedTombstones: [
        { generation: 1, cleanupReceiptDigest: receiptA },
        { generation: 2, cleanupReceiptDigest: receiptB },
      ],
    });
    const staleExit = reduceCommunityPluginLifecycleV1(
      state,
      command(
        state,
        { type: "exit-plugin", participant: participantA, pluginId: "calendar", generation: 1 },
        "stale-generation-exit",
        20,
      ),
    );
    expect(staleExit).toMatchObject({ status: "blocked", reason: "generation-mismatch" });
  });

  it("rejects malformed or internally contradictory persisted control state", () => {
    let state = createCommunityPluginLifecycleControlV1(scope);
    state = register(state, participantA, "a", 10);
    state = join(state, participantA, "a", 11);
    state = exitPlugin(state, participantA, "a", 12);
    state = apply(
      state,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 1 },
      "begin-close-validation",
      13,
    );

    expect(isCommunityPluginLifecycleControlV1(state)).toBe(true);
    const wrongMembers = structuredClone(state);
    wrongMembers.pluginsById.calendar.currentGeneration!.closing!.memberKeys = [];
    expect(isCommunityPluginLifecycleControlV1(wrongMembers)).toBe(false);
    const futureSchema = { ...state, schemaVersion: 3 };
    expect(isCommunityPluginLifecycleControlV1(futureSchema)).toBe(false);
    const schemaOneWithConsent = structuredClone(state);
    schemaOneWithConsent.schemaVersion = 1;
    expect(isCommunityPluginLifecycleControlV1(schemaOneWithConsent)).toBe(false);
    const schemaTwoWithoutConsent = structuredClone(state);
    delete schemaTwoWithoutConsent.legacyMigrationConsent;
    expect(isCommunityPluginLifecycleControlV1(schemaTwoWithoutConsent)).toBe(false);
    const danglingMember = structuredClone(state);
    delete danglingMember.participantsByKey[communityPluginParticipantKeyV1(participantA)];
    expect(isCommunityPluginLifecycleControlV1(danglingMember)).toBe(false);
    const emptyGeneration = structuredClone(state);
    emptyGeneration.pluginsById.calendar.currentGeneration!.membersByKey = {};
    emptyGeneration.pluginsById.calendar.currentGeneration!.closing!.memberKeys = [];
    expect(isCommunityPluginLifecycleControlV1(emptyGeneration)).toBe(false);

    let repeated = structuredClone(state);
    repeated = apply(
      repeated,
      {
        type: "complete-close",
        actor: participantA,
        pluginId: "calendar",
        generation: 1,
        cleanupReceiptDigest: receiptA,
      },
      "complete-close-validation",
      14,
    );
    repeated = join(repeated, participantA, "second-validation-generation", 15, repeated.revision);
    repeated = exitPlugin(repeated, participantA, "second-validation-generation", 16, 2);
    repeated = apply(
      repeated,
      { type: "begin-close", actor: participantA, pluginId: "calendar", generation: 2 },
      "begin-close-second-validation-generation",
      17,
    );
    repeated = apply(
      repeated,
      {
        type: "complete-close",
        actor: participantA,
        pluginId: "calendar",
        generation: 2,
        cleanupReceiptDigest: receiptB,
      },
      "complete-close-second-validation-generation",
      18,
    );
    const reorderedTombstones = structuredClone(repeated);
    reorderedTombstones.pluginsById.calendar.closedTombstones.reverse();
    expect(isCommunityPluginLifecycleControlV1(reorderedTombstones)).toBe(false);
  });

  it("stays isolated from Graph, Vault, Main and SyncExecutor integration", () => {
    const source = readFileSync(
      "src/sync/community-plugin-lifecycle-v1.ts",
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']obsidian["']/);
    expect(source).not.toMatch(/onedrive|sync-executor|\.\.\/main/i);
  });
});
