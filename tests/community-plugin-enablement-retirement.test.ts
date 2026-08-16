import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { StateManager, type PluginDataStore } from
  "../src/sync/state-manager";

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    "tests/fixtures/public-1.2.7-community-plugin-enablement.json",
    "utf8",
  ));
}

function harness(initial: Record<string, unknown>) {
  const pluginData = structuredClone(initial);
  const plugin: PluginDataStore = {
    loadData: vi.fn(async () => pluginData),
    updatePluginData: vi.fn(async (mutator) => mutator(pluginData)),
    manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          exists: vi.fn(async () => false),
          read: vi.fn(async () => { throw new Error("missing"); }),
          write: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          list: vi.fn(async () => ({ files: [], folders: [] })),
          rmdir: vi.fn(async () => undefined),
          stat: vi.fn(async () => null),
          readBinary: vi.fn(async () => { throw new Error("missing"); }),
          writeBinary: vi.fn(async () => undefined),
        },
      },
    },
  };
  return { state: new StateManager(plugin), plugin, pluginData };
}

describe("public 1.2.7 community plugin enablement retirement", () => {
  it("retires only the enablement projection and its path-specific review", async () => {
    const { state, pluginData } = harness(fixture());

    await state.load();

    expect(pluginData["community-plugin-enablement-state"]).toBeUndefined();
    expect(pluginData["easy-sync-pending-conflicts"]).toEqual([{
      type: "Conflict",
      path: "keep.md",
    }]);
    expect(pluginData["easy-sync-plan-review-active"]).toBe(false);
    expect(pluginData["easy-sync-plan-review-items"]).toEqual([]);
    expect(pluginData["easy-sync-plan-review-revision"]).toBe(8);
    expect(state.consumeCommunityPluginEnablementRetiredThisLoad()).toBe(true);
    expect(state.consumeCommunityPluginEnablementRetiredThisLoad()).toBe(false);

    await state.incrementRemoteGeneration();
    expect(pluginData["community-plugin-enablement-state"]).toBeUndefined();
  });

  it("is idempotent and does not announce a fresh install", async () => {
    const first = harness(fixture());
    await first.state.load();
    const persisted = structuredClone(first.pluginData);
    const second = harness(persisted);

    await second.state.load();

    expect(second.state.consumeCommunityPluginEnablementRetiredThisLoad())
      .toBe(false);
    expect(second.plugin.updatePluginData).not.toHaveBeenCalled();
    expect(second.pluginData).toEqual(persisted);

    const fresh = harness({ "sync-interval": 7 });
    await fresh.state.load();
    expect(fresh.state.consumeCommunityPluginEnablementRetiredThisLoad())
      .toBe(false);
    expect(fresh.plugin.updatePluginData).not.toHaveBeenCalled();
  });
});
