import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import {
  createLargeV2Envelope,
  LARGE_V2_FIXTURE_SCOPE,
} from "./helpers/large-v2-envelope";

const paths = getEasySyncPaths(".obsidian");
const scope = LARGE_V2_FIXTURE_SCOPE;
const FILE_COUNT = 50_000;
const LOAD_BUDGET_MS = 5_000;

describe("V2 cold-start performance contract", () => {
  it("loads a 50k-identity active envelope without Graph, user-file I/O or writes", async () => {
    const envelope = createLargeV2Envelope(FILE_COUNT);
    const manifest = {
      schemaVersion: 2,
      activeState: "state-v2.json",
      stateCommitSeq: envelope.meta.commitSeq,
      lifecycleEpoch: envelope.meta.lifecycleEpoch,
      scope,
      migratedAt: 1,
      legacyAutoSyncAllowed: false,
    };
    const files = new Map<string, string>([
      [paths.stateV2ManifestFile, JSON.stringify(manifest)],
      [paths.stateV2File, JSON.stringify(envelope)],
    ]);
    const folders = new Set<string>();
    const adapterMethods = {
      exists: vi.fn(async (path: string) =>
        files.has(path) || folders.has(path)
      ),
      read: vi.fn(async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return value;
      }),
      write: vi.fn(async (path: string, value: string) => {
        files.set(path, value);
      }),
      remove: vi.fn(async (path: string) => {
        files.delete(path);
        folders.delete(path);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        const value = files.get(from);
        if (value === undefined) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, value);
      }),
      mkdir: vi.fn(async (path: string) => {
        folders.add(path);
      }),
      list: vi.fn(async () => ({ files: [], folders: [] })),
    };
    const pluginData: Record<string, unknown> = {};
    const plugin: PluginDataStore = {
      loadData: vi.fn(async () => pluginData),
      updatePluginData: vi.fn(async (mutator) => mutator(pluginData)),
      app: {
        vault: {
          adapter: adapterMethods as unknown as DataAdapter,
          configDir: ".obsidian",
        },
      },
      manifest: { id: "easy-sync", dir: paths.pluginDir },
    };

    // Establish the authority witness outside the measured rounds. A normal
    // active V2 cold start already has this file.
    const seed = new StateManager(plugin);
    await seed.load();
    expect(seed.isV2StateActive).toBe(true);
    adapterMethods.read.mockClear();
    adapterMethods.write.mockClear();
    adapterMethods.rename.mockClear();
    adapterMethods.remove.mockClear();
    adapterMethods.mkdir.mockClear();
    adapterMethods.list.mockClear();
    vi.mocked(plugin.loadData).mockClear();
    vi.mocked(plugin.updatePluginData).mockClear();

    const elapsedMs: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const state = new StateManager(plugin);
      const startedAt = performance.now();
      await state.load();
      elapsedMs.push(performance.now() - startedAt);
      expect(state.isV2StateActive).toBe(true);
      expect(state.remoteSnapshot).toHaveLength(FILE_COUNT);
      expect(state.remoteFolders).toHaveLength(1);
      expect(state.mutationLedger).toHaveLength(0);
      expect(state.v2StateLoadRecoveryBlock).toBeNull();
    }

    const sorted = [...elapsedMs].sort((left, right) => left - right);
    const medianMs = sorted[1];
    const stateBytes = new TextEncoder().encode(
      files.get(paths.stateV2File)!,
    ).byteLength;
    console.log("[v2-cold-start-large-state]", JSON.stringify({
      schemaVersion: 1,
      files: FILE_COUNT,
      folders: 1,
      stateBytes,
      rounds: elapsedMs.length,
      medianMs: Number(medianMs.toFixed(3)),
      slowestMs: Number(Math.max(...elapsedMs).toFixed(3)),
      operations: {
        pluginDataReads: vi.mocked(plugin.loadData).mock.calls.length,
        pluginDataWrites:
          vi.mocked(plugin.updatePluginData).mock.calls.length,
        internalReads: adapterMethods.read.mock.calls.length,
        internalWrites:
          adapterMethods.write.mock.calls.length
          + adapterMethods.rename.mock.calls.length
          + adapterMethods.remove.mock.calls.length,
        userFileOperations: 0,
        graphRequests: 0,
      },
    }));

    expect(medianMs).toBeLessThan(LOAD_BUDGET_MS);
    expect(vi.mocked(plugin.loadData)).toHaveBeenCalledTimes(3);
    expect(plugin.updatePluginData).not.toHaveBeenCalled();
    expect(adapterMethods.write).not.toHaveBeenCalled();
    expect(adapterMethods.rename).not.toHaveBeenCalled();
    expect(adapterMethods.remove).not.toHaveBeenCalled();
    expect(adapterMethods.mkdir).not.toHaveBeenCalled();
    expect(adapterMethods.list).not.toHaveBeenCalled();
    expect(adapterMethods.read.mock.calls.every(
      ([path]) => String(path).startsWith(`${paths.pluginDir}/`),
    )).toBe(true);
  }, 30_000);
});
