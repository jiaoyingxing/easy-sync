import { describe, expect, it } from "vitest";
import {
  createEmptyDeviceCommunityPluginParticipation,
  isDeviceCommunityPluginEnabled,
  migrateLegacyCommunityPluginParticipation,
  readDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
} from "../src/sync/community-plugin-participation";

describe("device community-plugin participation", () => {
  it("tolerates a legacy joinedGeneration on read and drops it on the next rewrite", () => {
    const legacy = {
      schemaVersion: 1,
      kind: "device-community-plugin-participation",
      scopeEnabled: true,
      pluginsById: {
        calendar: {
          pluginId: "calendar",
          phase: "participating",
          joinedGeneration: 4,
          lastConfirmedLocalBundleDigest: "a".repeat(64),
        },
      },
    } as never as Parameters<typeof readDeviceCommunityPluginParticipation>[0];
    const parsed = readDeviceCommunityPluginParticipation(legacy);
    expect(parsed.pluginsById.calendar?.phase).toBe("participating");
    const rewritten = reduceDeviceCommunityPluginParticipation(parsed, {
      type: "confirm-participating",
      pluginId: "calendar",
      localBundleDigest: "b".repeat(64),
    });
    expect(rewritten.pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "participating",
      lastConfirmedLocalBundleDigest: "b".repeat(64),
    });
  });

  it("keeps plugin participation as a pure, explicit state machine", () => {
    const empty = createEmptyDeviceCommunityPluginParticipation(false);
    const scopeEnabled = reduceDeviceCommunityPluginParticipation(empty, {
      type: "set-scope-enabled",
      enabled: true,
    });
    const requested = reduceDeviceCommunityPluginParticipation(scopeEnabled, {
      type: "request-join",
      pluginId: "calendar",
      operationId: "join-calendar-1",
      targetCatalogRevision: 7,
      targetBundleDigest: "a".repeat(64),
    });
    const restoring = reduceDeviceCommunityPluginParticipation(requested, {
      type: "begin-restore",
      pluginId: "calendar",
      operationId: "join-calendar-1",
    });
    const participating = reduceDeviceCommunityPluginParticipation(restoring, {
      type: "confirm-participating",
      pluginId: "calendar",
      localBundleDigest: "b".repeat(64),
    });
    const exiting = reduceDeviceCommunityPluginParticipation(participating, {
      type: "request-exit",
      pluginId: "calendar",
      operationId: "exit-calendar-1",
    });
    const excluded = reduceDeviceCommunityPluginParticipation(exiting, {
      type: "confirm-excluded",
      pluginId: "calendar",
    });

    expect(empty).toEqual({
      schemaVersion: 1,
      kind: "device-community-plugin-participation",
      scopeEnabled: false,
      pluginsById: {},
    });
    expect(requested.pluginsById.calendar).toMatchObject({
      phase: "join-requested",
      operationId: "join-calendar-1",
      targetCatalogRevision: 7,
      targetBundleDigest: "a".repeat(64),
    });
    expect(restoring.pluginsById.calendar?.phase).toBe("restoring");
    expect(participating.pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "participating",
      lastConfirmedLocalBundleDigest: "b".repeat(64),
    });
    expect(exiting.pluginsById.calendar).toMatchObject({
      phase: "exit-requested",
      operationId: "exit-calendar-1",
    });
    expect(excluded.pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "excluded",
    });
    expect(isDeviceCommunityPluginEnabled(participating, "calendar")).toBe(true);
    expect(isDeviceCommunityPluginEnabled(excluded, "calendar")).toBe(false);
  });

  it("keeps enabled-but-missing work actionable instead of stable", () => {
    const state = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      {
        type: "block",
        pluginId: "calendar",
        reason: "catalog-unavailable",
      },
    );

    expect(state.pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "blocked",
      blockedReason: "catalog-unavailable",
    });
    expect(isDeviceCommunityPluginEnabled(state, "calendar")).toBe(true);
  });

  it("keeps the bound restore target when a join is blocked", () => {
    const requested = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      {
        type: "request-join",
        pluginId: "calendar",
        operationId: "join-calendar-1",
        targetCatalogRevision: 7,
        targetBundleDigest: "a".repeat(64),
      },
    );

    const blocked = reduceDeviceCommunityPluginParticipation(requested, {
      type: "block",
      pluginId: "calendar",
      reason: "remote-bundle-changed",
    });

    expect(blocked.pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "blocked",
      operationId: "join-calendar-1",
      targetCatalogRevision: 7,
      targetBundleDigest: "a".repeat(64),
      blockedReason: "remote-bundle-changed",
    });
  });

  it("lets a newly present bundle start a fresh local participation round", () => {
    const excluded = reduceDeviceCommunityPluginParticipation(
      reduceDeviceCommunityPluginParticipation(
        reduceDeviceCommunityPluginParticipation(
          createEmptyDeviceCommunityPluginParticipation(true),
          { type: "confirm-participating", pluginId: "calendar" },
        ),
        {
          type: "request-exit",
          pluginId: "calendar",
          operationId: "exit-calendar-1",
        },
      ),
      { type: "confirm-excluded", pluginId: "calendar" },
    );

    const reinstalled = reduceDeviceCommunityPluginParticipation(excluded, {
      type: "confirm-participating",
      pluginId: "calendar",
      localBundleDigest: "c".repeat(64),
    });

    expect(reinstalled.pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "participating",
      lastConfirmedLocalBundleDigest: "c".repeat(64),
    });
  });

  it("migrates the legacy policy once without guessing remote-only participation", () => {
    const migrated = migrateLegacyCommunityPluginParticipation({
      filesEnabled: true,
      selection: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["ignored"],
        restoringPluginIds: ["restoring"],
      },
      knownPluginIds: [
        "installed",
        "historical-missing",
        "ignored",
        "remote-only",
        "restoring",
      ],
      completeLocalBundlePluginIds: ["installed"],
      historicallyParticipatedPluginIds: ["historical-missing"],
    });

    expect(migrated.pluginsById).toEqual({
      "historical-missing": {
        pluginId: "historical-missing",
        phase: "excluded",
      },
      ignored: { pluginId: "ignored", phase: "excluded" },
      installed: { pluginId: "installed", phase: "participating" },
      "remote-only": {
        pluginId: "remote-only",
        phase: "never-participated",
      },
      restoring: {
        pluginId: "restoring",
        phase: "join-requested",
      },
    });
  });

  it("keeps dormant per-plugin choices when the old outer scope is off", () => {
    const migrated = migrateLegacyCommunityPluginParticipation({
      filesEnabled: false,
      selection: { mode: "all", pluginIds: [] },
      knownPluginIds: ["installed", "remote-only"],
      completeLocalBundlePluginIds: ["installed"],
    });

    expect(migrated.scopeEnabled).toBe(false);
    expect(migrated.pluginsById.installed?.phase).toBe("participating");
    expect(migrated.pluginsById["remote-only"]?.phase)
      .toBe("never-participated");
    expect(isDeviceCommunityPluginEnabled(migrated, "installed"))
      .toBe(false);
  });

  it("blocks an incomplete local bundle during the one-time migration", () => {
    const migrated = migrateLegacyCommunityPluginParticipation({
      filesEnabled: true,
      selection: { mode: "all", pluginIds: [] },
      knownPluginIds: ["calendar"],
      completeLocalBundlePluginIds: [],
      incompleteLocalBundlePluginIds: ["calendar"],
    });

    expect(migrated.pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "blocked",
      blockedReason: "local-bundle-incomplete",
    });
  });

  it("rejects malformed persisted state instead of normalizing it", () => {
    expect(() => readDeviceCommunityPluginParticipation({
      schemaVersion: 1,
      kind: "device-community-plugin-participation",
      scopeEnabled: true,
      pluginsById: {
        calendar: {
          pluginId: "different-id",
          phase: "participating",
        },
      },
    })).toThrow(/participation/i);
  });
});
