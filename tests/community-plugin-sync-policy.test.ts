import { describe, expect, it } from "vitest";
import {
  clearCompletedCommunityPluginRestores,
  createEffectiveCommunityPluginSyncPolicy,
  isCommunityPluginDataSelected,
  isPluginSelected,
  normalizeCommunityPluginSyncSettings,
  normalizePluginScopeSelection,
  readCommunityPluginSyncPolicy,
  stripPluginFromScopeSelection,
} from "../src/sync/community-plugin-sync-policy";

describe("community plugin sync policy", () => {
  it("keeps the public boolean baseline separate from default-all selection", () => {
    expect(readCommunityPluginSyncPolicy(null, true, false)).toEqual({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "all", pluginIds: [] },
    });
    expect(readCommunityPluginSyncPolicy(null, false, false)).toEqual({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "all", pluginIds: [] },
    });
  });

  it("normalizes selected ids and always excludes EasySync itself", () => {
    expect(normalizePluginScopeSelection({
      mode: "selected",
      pluginIds: [
        "calendar",
        " easy-sync ",
        "calendar",
        "../escape",
        "dataview",
      ],
    })).toEqual({
      mode: "selected",
      pluginIds: ["calendar", "dataview"],
    });
  });

  it("drops ids outside selected mode and fails closed on an unknown mode", () => {
    expect(normalizePluginScopeSelection({
      mode: "all",
      pluginIds: ["calendar"],
    })).toEqual({ mode: "all", pluginIds: [] });
    expect(normalizePluginScopeSelection({
      mode: "future",
      pluginIds: ["calendar"],
    })).toEqual({ mode: "none", pluginIds: [] });
  });

  it("matches only selected ids in partial mode", () => {
    const selection = normalizePluginScopeSelection({
      mode: "selected",
      pluginIds: ["calendar"],
    });
    expect(isPluginSelected(selection, "calendar")).toBe(true);
    expect(isPluginSelected(selection, "dataview")).toBe(false);
  });

  it("keeps device-local ignores across all and selected modes", () => {
    const all = normalizePluginScopeSelection({
      mode: "all",
      pluginIds: ["calendar"],
      ignoredPluginIds: [" dataview ", "easy-sync", "dataview"],
    });
    expect(all).toEqual({
      mode: "all",
      pluginIds: [],
      ignoredPluginIds: ["dataview"],
    });
    expect(isPluginSelected(all, "calendar")).toBe(true);
    expect(isPluginSelected(all, "dataview")).toBe(false);

    const selected = normalizePluginScopeSelection({
      mode: "selected",
      pluginIds: ["calendar", "dataview"],
      ignoredPluginIds: ["calendar"],
    });
    expect(isPluginSelected(selected, "calendar")).toBe(false);
    expect(isPluginSelected(selected, "dataview")).toBe(true);
  });

  it("normalizes and retires only valid one-shot restore authorizations", () => {
    const policy = readCommunityPluginSyncPolicy({
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
        restoringPluginIds: ["calendar", "dataview"],
      },
      data: {
        mode: "selected",
        pluginIds: ["calendar"],
        restoringPluginIds: ["calendar", "dataview"],
      },
    });

    expect(policy).toEqual({
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
        restoringPluginIds: ["dataview"],
      },
      data: {
        mode: "selected",
        pluginIds: ["calendar"],
        restoringPluginIds: ["calendar"],
      },
    });
    expect(clearCompletedCommunityPluginRestores(policy, {
      files: ["dataview"],
      data: [],
    })).toEqual({
      ...policy,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
    });
  });

  it("requires plugin files before plugin data can participate", () => {
    const policy = {
      version: 1 as const,
      files: {
        mode: "all" as const,
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: { mode: "all" as const, pluginIds: [] },
    };
    expect(isCommunityPluginDataSelected(policy, "calendar")).toBe(false);
    expect(isCommunityPluginDataSelected(policy, "dataview")).toBe(true);
  });

  it("projects outer switches without erasing the retained inner policy", () => {
    const policy = {
      version: 1 as const,
      files: {
        mode: "all" as const,
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: {
        mode: "selected" as const,
        pluginIds: ["dataview"],
      },
    };
    expect(createEffectiveCommunityPluginSyncPolicy(
      policy,
      false,
      true,
    )).toEqual({
      version: 1,
      files: { mode: "none", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    });
    expect(policy).toEqual({
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: { mode: "selected", pluginIds: ["dataview"] },
    });
  });

  it("normalizes legacy none only when an outer switch is enabled", () => {
    const retained = {
      version: 1 as const,
      files: { mode: "none" as const, pluginIds: [] },
      data: { mode: "selected" as const, pluginIds: ["calendar"] },
    };
    expect(normalizeCommunityPluginSyncSettings(
      retained,
      true,
      true,
    )).toEqual({
      filesEnabled: true,
      dataEnabled: true,
      policy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "selected", pluginIds: ["calendar"] },
      },
    });
    expect(normalizeCommunityPluginSyncSettings(
      retained,
      false,
      true,
    )).toEqual({
      filesEnabled: false,
      dataEnabled: false,
      policy: retained,
    });

    const bothLegacyNone = {
      version: 1 as const,
      files: { mode: "none" as const, pluginIds: [] },
      data: { mode: "none" as const, pluginIds: [] },
    };
    expect(normalizeCommunityPluginSyncSettings(
      bothLegacyNone,
      false,
      true,
    )).toEqual({
      filesEnabled: false,
      dataEnabled: false,
      policy: bothLegacyNone,
    });
  });

  it("strips one plugin from every list while keeping the mode and the rest", () => {
    const selection = {
      mode: "selected" as const,
      pluginIds: ["calendar", "other"],
      ignoredPluginIds: ["calendar", "ignored"],
      restoringPluginIds: ["calendar"],
    };
    expect(stripPluginFromScopeSelection(selection, "calendar")).toEqual({
      mode: "selected",
      pluginIds: ["other"],
      ignoredPluginIds: ["ignored"],
      restoringPluginIds: [],
    });
    // A missing plugin is a no-op.
    expect(stripPluginFromScopeSelection(
      { mode: "all", pluginIds: [] },
      "calendar",
    )).toEqual({ mode: "all", pluginIds: [] });
  });
});
