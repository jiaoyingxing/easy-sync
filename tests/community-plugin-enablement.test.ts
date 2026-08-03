import { describe, expect, it } from "vitest";
import {
  applyPluginEnablementDecisions,
  mergeSelectedPluginEnablement,
  parseCommunityPluginEnablementJson,
  prepareCommunityPluginEnablement,
  prepareCommunityPluginEnablementFromObservations,
  projectCommunityPluginEnablementCarrierStateV2,
  serializeCommunityPluginEnablementJson,
  validateCommunityPluginEnablementMigrationCarrierV2,
} from "../src/sync/community-plugin-enablement";

describe("selected community plugin enablement merge", () => {
  it("keeps a dangling unselected anchor as passive migration history", () => {
    const carrier = {
      version: 1 as const,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "files",
      },
      source: {
        path: ".obsidian/community-plugins.json",
        selectedPluginIds: ["calendar"],
        local: { exists: false },
        remote: { exists: false },
      },
      anchors: {
        calendar: true,
        "startup-optimizer": false,
      },
      pending: [],
      resolved: [],
    };

    expect(() => validateCommunityPluginEnablementMigrationCarrierV2(
      carrier,
    )).not.toThrow();
    expect(projectCommunityPluginEnablementCarrierStateV2(carrier)).toEqual({
      anchors: {
        calendar: true,
        "startup-optimizer": false,
      },
      pending: [],
    });

    expect(() => validateCommunityPluginEnablementMigrationCarrierV2({
      ...carrier,
      anchors: { calendar: true },
      pending: [{
        pluginId: "startup-optimizer",
        localEnabled: true,
        remoteEnabled: false,
      }],
    })).toThrow(/migration carrier is invalid/);

    expect(() => validateCommunityPluginEnablementMigrationCarrierV2({
      ...carrier,
      anchors: { calendar: true },
      resolved: [{
        pluginId: "startup-optimizer",
        localEnabled: true,
        remoteEnabled: false,
        resolvedEnabled: true,
      }],
    })).toThrow(/migration carrier is invalid/);
  });

  it("preserves every unselected id independently on each side", () => {
    const result = mergeSelectedPluginEnablement(
      ["selected", "local-only"],
      ["selected", "remote-only"],
      ["selected"],
      { selected: true },
    );

    expect(result).toMatchObject({
      status: "ready",
      local: ["local-only", "selected"],
      remote: ["remote-only", "selected"],
      anchors: { selected: true },
    });
  });

  it("never removes EasySync itself while merging another selected plugin", () => {
    expect(mergeSelectedPluginEnablement(
      ["easy-sync", "calendar"],
      ["easy-sync"],
      ["calendar"],
      { calendar: false },
    )).toMatchObject({
      local: ["calendar", "easy-sync"],
      remote: ["calendar", "easy-sync"],
    });
  });

  it("propagates a one-sided change from the shared anchor", () => {
    expect(mergeSelectedPluginEnablement(
      [],
      ["calendar"],
      ["calendar"],
      { calendar: false },
    )).toMatchObject({
      status: "ready",
      local: ["calendar"],
      remote: ["calendar"],
      anchors: { calendar: true },
    });
  });

  it("requires an explicit decision for the first divergent observation", () => {
    const pending = mergeSelectedPluginEnablement(
      ["calendar", "local-only"],
      ["remote-only"],
      ["calendar"],
      {},
    );

    expect(pending).toMatchObject({
      status: "decision-required",
      local: ["calendar", "local-only"],
      remote: ["remote-only"],
      decisionPluginIds: ["calendar"],
    });

    expect(applyPluginEnablementDecisions(pending, {
      calendar: false,
    })).toMatchObject({
      status: "ready",
      local: ["local-only"],
      remote: ["remote-only"],
      anchors: { calendar: false },
      decisionPluginIds: [],
    });
  });

  it("reuses a decision only while both observed versions still match", () => {
    const pending = prepareCommunityPluginEnablement(
      ["calendar"],
      [],
      ["calendar"],
      {},
      [{
        pluginId: "calendar",
        localEnabled: true,
        remoteEnabled: false,
        resolvedEnabled: true,
      }],
    );
    expect(pending).toMatchObject({
      status: "ready",
      local: ["calendar"],
      remote: ["calendar"],
      anchors: { calendar: true },
      pending: [],
      localChanged: false,
      remoteChanged: true,
    });

    expect(prepareCommunityPluginEnablement(
      [],
      ["calendar"],
      ["calendar"],
      {},
      [{
        pluginId: "calendar",
        localEnabled: true,
        remoteEnabled: false,
        resolvedEnabled: true,
      }],
    )).toMatchObject({
      status: "decision-required",
      pending: [{
        pluginId: "calendar",
        localEnabled: false,
        remoteEnabled: true,
      }],
    });
  });

  it("does not treat a missing remote file as an explicit disable", () => {
    expect(prepareCommunityPluginEnablementFromObservations(
      { exists: true, pluginIds: ["calendar"] },
      { exists: false, pluginIds: [] },
      ["calendar"],
      { calendar: true },
    )).toMatchObject({
      status: "ready",
      local: ["calendar"],
      remote: ["calendar"],
      anchors: { calendar: true },
      localChanged: false,
      remoteChanged: true,
    });
  });

  it("does not treat a missing local file as an explicit disable", () => {
    expect(prepareCommunityPluginEnablementFromObservations(
      { exists: false, pluginIds: [] },
      { exists: true, pluginIds: ["calendar"] },
      ["calendar"],
      { calendar: true },
    )).toMatchObject({
      status: "ready",
      local: ["calendar"],
      remote: ["calendar"],
      anchors: { calendar: true },
      localChanged: true,
      remoteChanged: false,
    });
  });

  it("keeps anchors when neither side has an enablement file", () => {
    expect(prepareCommunityPluginEnablementFromObservations(
      { exists: false, pluginIds: [] },
      { exists: false, pluginIds: [] },
      ["calendar"],
      { calendar: true },
      [{
        pluginId: "calendar",
        localEnabled: true,
        remoteEnabled: false,
      }],
    )).toEqual({
      status: "ready",
      local: [],
      remote: [],
      anchors: { calendar: true },
      pending: [],
      localChanged: false,
      remoteChanged: false,
    });
  });

  it("parses strict plugin-id arrays and emits stable JSON", () => {
    expect(parseCommunityPluginEnablementJson(
      "[\"quickadd\", \"calendar\", \"quickadd\", \"easy-sync\"]",
    )).toEqual(["calendar", "easy-sync", "quickadd"]);
    expect(new TextDecoder().decode(
      serializeCommunityPluginEnablementJson(["quickadd", "calendar"]),
    )).toBe("[\n  \"calendar\",\n  \"quickadd\"\n]\n");
    expect(() => parseCommunityPluginEnablementJson("{}")).toThrow(/array/);
    expect(() => parseCommunityPluginEnablementJson("[\"../escape\"]")).toThrow(/invalid/);
  });
});
