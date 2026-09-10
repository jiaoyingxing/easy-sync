import { describe, expect, it } from "vitest";
import {
  createEmptyCommunityPluginAdoptionMemory,
  isCommunityPluginIgnored,
  readCommunityPluginAdoptionMemory,
  reduceCommunityPluginAdoptionMemory,
} from "../src/sync/community-plugin-adoption-memory";

describe("community-plugin adoption memory", () => {
  it("reads only canonical device-local records", () => {
    expect(() => readCommunityPluginAdoptionMemory(null)).toThrow(
      "adoption memory is invalid",
    );
    expect(() => readCommunityPluginAdoptionMemory({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: [],
      pendingPluginIds: [],
      extra: true,
    })).toThrow("adoption memory is invalid");
    expect(() => readCommunityPluginAdoptionMemory({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: ["plugin-a", "plugin-a"],
      pendingPluginIds: [],
    })).toThrow("not canonical");
    expect(() => readCommunityPluginAdoptionMemory({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: ["plugin-b", "plugin-a"],
      pendingPluginIds: [],
    })).toThrow("not canonical");
    expect(readCommunityPluginAdoptionMemory({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: ["plugin-a"],
      pendingPluginIds: [],
    })).toEqual({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: ["plugin-a"],
      pendingPluginIds: [],
    });
  });

  it("ignore removes the pending row and suppresses future proposals", () => {
    let memory = createEmptyCommunityPluginAdoptionMemory();
    memory = reduceCommunityPluginAdoptionMemory(memory, {
      type: "reconcile-pending",
      pluginIds: ["plugin-b", "plugin-a"],
    });
    expect(memory.pendingPluginIds).toEqual(["plugin-a", "plugin-b"]);
    memory = reduceCommunityPluginAdoptionMemory(memory, {
      type: "ignore",
      pluginId: "plugin-a",
    });
    expect(memory).toEqual({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: ["plugin-a"],
      pendingPluginIds: ["plugin-b"],
    });
    expect(isCommunityPluginIgnored(memory, "plugin-a")).toBe(true);
    // A stale reconcile must never resurrect the ignored plugin.
    memory = reduceCommunityPluginAdoptionMemory(memory, {
      type: "reconcile-pending",
      pluginIds: ["plugin-a", "plugin-b", "plugin-c"],
    });
    expect(memory.pendingPluginIds).toEqual(["plugin-b", "plugin-c"]);
  });

  it("clear-ignore is the only removal path and leaves pending untouched", () => {
    let memory = createEmptyCommunityPluginAdoptionMemory();
    memory = reduceCommunityPluginAdoptionMemory(memory, {
      type: "ignore",
      pluginId: "plugin-a",
    });
    memory = reduceCommunityPluginAdoptionMemory(memory, {
      type: "clear-ignore",
      pluginId: "plugin-a",
    });
    expect(memory.ignoredPluginIds).toEqual([]);
    expect(memory.pendingPluginIds).toEqual([]);
    expect(isCommunityPluginIgnored(memory, "plugin-a")).toBe(false);
    // Idempotent clear and remove stay semantically unchanged.
    const same = reduceCommunityPluginAdoptionMemory(memory, {
      type: "remove-pending",
      pluginId: "plugin-a",
    });
    expect(same).toEqual(memory);
  });

  it("reconcile replaces the pending set canonically", () => {
    let memory = createEmptyCommunityPluginAdoptionMemory();
    memory = reduceCommunityPluginAdoptionMemory(memory, {
      type: "reconcile-pending",
      pluginIds: ["plugin-b"],
    });
    const changed = reduceCommunityPluginAdoptionMemory(memory, {
      type: "reconcile-pending",
      pluginIds: ["plugin-a", "plugin-b"],
    });
    expect(changed.pendingPluginIds).toEqual(["plugin-a", "plugin-b"]);
    expect(changed.ignoredPluginIds).toEqual([]);
    // Dropped ids leave the store without an explicit remove.
    const shrunk = reduceCommunityPluginAdoptionMemory(changed, {
      type: "reconcile-pending",
      pluginIds: ["plugin-b"],
    });
    expect(shrunk.pendingPluginIds).toEqual(["plugin-b"]);
    expect(reduceCommunityPluginAdoptionMemory(shrunk, {
      type: "reconcile-pending",
      pluginIds: ["plugin-b"],
    })).toEqual(shrunk);
  });
});
