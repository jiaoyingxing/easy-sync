import { describe, expect, it, vi } from "vitest";
import {
  createCommunityPluginManifestObservation,
  type CommunityPluginManifestObservationV1,
} from "../src/sync/community-plugin-bundle";
import {
  COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT,
  ensureCommunityPluginDisplayFacts,
  mergeCommunityPluginManifestObservations,
} from "../src/sync/community-plugin-display-facts";
import type {
  RemoteCommunityPluginCatalogEntryV1,
  RemoteCommunityPluginCatalogMemberV1,
  RemoteCommunityPluginCatalogV1,
} from "../src/sync/community-plugin-remote-catalog";
import type {
  RemoteFileEntry,
  SyncScope,
} from "../src/sync/types";

const SCOPE: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};

const OTHER_SCOPE: SyncScope = { ...SCOPE, filesRootId: "other-files" };

function manifestText(pluginId: string): string {
  return JSON.stringify({
    id: pluginId,
    name: `Display ${pluginId}`,
    version: "2.0.0",
  });
}

function textBytes(pluginId: string): Uint8Array {
  return new TextEncoder().encode(manifestText(pluginId));
}

function toRemoteFileEntry(
  value: RemoteCommunityPluginCatalogMemberV1,
): RemoteFileEntry {
  return {
    path: value.path,
    driveId: value.remoteId,
    parentId: value.parentId,
    size: value.size,
    mtime: value.mtime,
    eTag: value.eTag,
    cTag: value.cTag,
    ...(value.sha256Hash ? { sha256Hash: value.sha256Hash } : {}),
    ...(value.quickXorHash ? { quickXorHash: value.quickXorHash } : {}),
  };
}

function member(
  pluginId: string,
  overrides: Partial<RemoteCommunityPluginCatalogMemberV1> = {},
): RemoteCommunityPluginCatalogMemberV1 {
  return {
    path: `.obsidian/plugins/${pluginId}/manifest.json`,
    remoteId: `remote-${pluginId}`,
    parentId: `parent-${pluginId}`,
    size: textBytes(pluginId).byteLength,
    mtime: 1000,
    eTag: `etag-${pluginId}`,
    cTag: `ctag-${pluginId}`,
    sha256Hash: null,
    quickXorHash: null,
    ...overrides,
  };
}

function mainMember(pluginId: string): RemoteCommunityPluginCatalogMemberV1 {
  return {
    path: `.obsidian/plugins/${pluginId}/main.js`,
    remoteId: `remote-main-${pluginId}`,
    parentId: `parent-${pluginId}`,
    size: 4,
    mtime: 1000,
    eTag: `etag-main-${pluginId}`,
    cTag: `ctag-main-${pluginId}`,
    sha256Hash: null,
    quickXorHash: null,
  };
}

function completeEntry(
  pluginId: string,
  manifest = member(pluginId),
): RemoteCommunityPluginCatalogEntryV1 {
  return {
    pluginId,
    bundleState: "complete",
    bundleDigest: "b".repeat(64),
    members: [mainMember(pluginId), manifest],
  };
}

function partialEntry(
  pluginId: string,
  manifest = member(pluginId),
): RemoteCommunityPluginCatalogEntryV1 {
  return {
    pluginId,
    bundleState: "partial",
    bundleDigest: "b".repeat(64),
    members: [manifest],
  };
}

function catalog(
  entries: readonly RemoteCommunityPluginCatalogEntryV1[],
): RemoteCommunityPluginCatalogV1 {
  return {
    version: 1,
    scope: { ...SCOPE },
    complete: true,
    stale: false,
    revision: 1,
    observedAt: 1000,
    sourceDigest: "a".repeat(64),
    entries: entries.map((entry) => ({ ...entry })),
  };
}

async function observationFor(
  pluginId: string,
  manifestMember: RemoteCommunityPluginCatalogMemberV1,
  scope: Readonly<SyncScope> = SCOPE,
): Promise<CommunityPluginManifestObservationV1> {
  const bytes = textBytes(pluginId);
  return createCommunityPluginManifestObservation(
    scope,
    pluginId,
    toRemoteFileEntry(manifestMember),
    bytes.buffer,
  );
}

function pluginIds(ids: number): string[] {
  return Array.from({ length: ids }, (_, index) =>
    `p${String(index + 1).padStart(2, "0")}`
  );
}

describe("community plugin display facts", () => {
  it("probes new complete bundles in id order and stops at the per-call limit", async () => {
    const ids = pluginIds(COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT + 2);
    const fetchManifestText = vi.fn(async (pluginId: string) =>
      manifestText(pluginId)
    );
    const persisted: CommunityPluginManifestObservationV1[][] = [];
    const persist = vi.fn(async (
      observations: CommunityPluginManifestObservationV1[],
    ) => {
      persisted.push(structuredClone(observations));
    });

    const result = await ensureCommunityPluginDisplayFacts({
      scope: SCOPE,
      configDir: ".obsidian",
      catalog: catalog(ids.map((id) => completeEntry(id))),
      previousCatalog: null,
      storedObservations: [],
      fetchManifestText,
      persist,
      now: 2000,
    });

    expect(result).toEqual({
      probed: COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT,
      skipped: 0,
      failed: 0,
    });
    expect(fetchManifestText).toHaveBeenCalledTimes(
      COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT,
    );
    expect(fetchManifestText.mock.calls.map((call) => call[0])).toEqual(
      ids.slice(0, COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT),
    );
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persisted[0]).toHaveLength(COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT);
    expect(persisted[0]!.map((observation) => observation.pluginId)).toEqual(
      ids.slice(0, COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT),
    );
    expect(persisted[0]![0]).toMatchObject({
      version: 1,
      scope: SCOPE,
      manifestText: manifestText(ids[0]!),
    });
  });

  it("skips entries already covered by a matching observation without any request", async () => {
    const id = "calendar";
    const manifest = member(id);
    const observation = await observationFor(id, manifest);
    const fetchManifestText = vi.fn(async () => manifestText(id));

    const result = await ensureCommunityPluginDisplayFacts({
      scope: SCOPE,
      configDir: ".obsidian",
      catalog: catalog([completeEntry(id, manifest)]),
      previousCatalog: null,
      storedObservations: [observation],
      fetchManifestText,
      persist: vi.fn(),
      now: 2000,
    });

    expect(result).toEqual({ probed: 0, skipped: 1, failed: 0 });
    expect(fetchManifestText).not.toHaveBeenCalled();
  });

  it("does not treat another scope's observation as a hit", async () => {
    const id = "calendar";
    const manifest = member(id);
    const observation = await observationFor(id, manifest, OTHER_SCOPE);
    const persisted: CommunityPluginManifestObservationV1[][] = [];
    const persist = vi.fn(async (
      observations: CommunityPluginManifestObservationV1[],
    ) => {
      persisted.push(structuredClone(observations));
    });
    const fetchManifestText = vi.fn(async () => manifestText(id));

    const result = await ensureCommunityPluginDisplayFacts({
      scope: SCOPE,
      configDir: ".obsidian",
      catalog: catalog([completeEntry(id, manifest)]),
      previousCatalog: null,
      storedObservations: [observation],
      fetchManifestText,
      persist,
      now: 2000,
    });

    expect(result).toEqual({ probed: 1, skipped: 0, failed: 0 });
    expect(fetchManifestText).toHaveBeenCalledTimes(1);
    expect(persisted[0]).toHaveLength(2);
    expect(persisted[0]![1]).toMatchObject({ scope: SCOPE, pluginId: id });
  });

  it("re-reads when the manifest member version changed and retains the old observation", async () => {
    const id = "calendar";
    const oldManifest = member(id);
    const observation = await observationFor(id, oldManifest);
    const newManifest = member(id, {
      eTag: "etag-calendar-new",
      cTag: "ctag-calendar-new",
    });
    const persisted: CommunityPluginManifestObservationV1[][] = [];
    const persist = vi.fn(async (
      observations: CommunityPluginManifestObservationV1[],
    ) => {
      persisted.push(structuredClone(observations));
    });
    const fetchManifestText = vi.fn(async () => manifestText(id));

    const result = await ensureCommunityPluginDisplayFacts({
      scope: SCOPE,
      configDir: ".obsidian",
      catalog: catalog([completeEntry(id, newManifest)]),
      previousCatalog: null,
      storedObservations: [observation],
      fetchManifestText,
      persist,
      now: 2000,
    });

    expect(result).toEqual({ probed: 1, skipped: 0, failed: 0 });
    expect(fetchManifestText).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persisted[0]).toHaveLength(2);
    expect(persisted[0]!.map((item) => item.source.eTag).sort()).toEqual([
      "etag-calendar",
      "etag-calendar-new",
    ]);
  });

  it("counts fetch and parse failures as failed without persisting bad data", async () => {
    const ids = ["a", "b", "c", "d"];
    const badJson = "not json";
    const entries = [
      completeEntry("a"),
      completeEntry("b"),
      completeEntry("c", member("c", {
        size: new TextEncoder().encode(badJson).byteLength,
      })),
      completeEntry("d"),
    ];
    const persisted: CommunityPluginManifestObservationV1[][] = [];
    const persist = vi.fn(async (
      observations: CommunityPluginManifestObservationV1[],
    ) => {
      persisted.push(structuredClone(observations));
    });
    const fetchManifestText = vi.fn(async (pluginId: string) => {
      if (pluginId === "a") return null;
      if (pluginId === "b") throw new Error("network down");
      if (pluginId === "c") return badJson;
      return manifestText(pluginId);
    });

    const result = await ensureCommunityPluginDisplayFacts({
      scope: SCOPE,
      configDir: ".obsidian",
      catalog: catalog(entries),
      previousCatalog: null,
      storedObservations: [],
      fetchManifestText,
      persist,
      now: 2000,
    });

    expect(result).toEqual({ probed: 1, skipped: 0, failed: 3 });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persisted[0]).toHaveLength(1);
    expect(persisted[0]![0]).toMatchObject({ pluginId: "d" });
    expect(fetchManifestText.mock.calls.map((call) => call[0])).toEqual(ids);
  });

  it("bounds fetch attempts even when every probe fails", async () => {
    const ids = pluginIds(COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT + 2);
    const fetchManifestText = vi.fn(async () => null);

    const result = await ensureCommunityPluginDisplayFacts({
      scope: SCOPE,
      configDir: ".obsidian",
      catalog: catalog(ids.map((id) => completeEntry(id))),
      previousCatalog: null,
      storedObservations: [],
      fetchManifestText,
      persist: vi.fn(),
      now: 2000,
    });

    expect(result).toEqual({
      probed: 0,
      skipped: 0,
      failed: COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT,
    });
    expect(fetchManifestText).toHaveBeenCalledTimes(
      COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT,
    );
  });

  it("leaves batch-capped leftovers as candidates on later triggers and stays idempotent once observed", async () => {
    const ids = pluginIds(COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT + 2);
    const entries = ids.map((id) => completeEntry(id));
    const currentCatalog = catalog(entries);
    const fetchManifestText = vi.fn(async (pluginId: string) =>
      manifestText(pluginId)
    );
    const persisted: CommunityPluginManifestObservationV1[][] = [];
    const persist = vi.fn(async (
      observations: CommunityPluginManifestObservationV1[],
    ) => {
      persisted.push(structuredClone(observations));
    });
    const input = {
      scope: SCOPE,
      configDir: ".obsidian",
      catalog: currentCatalog,
      fetchManifestText,
      persist,
      now: 2000,
    };

    // First open on a device with many pre-existing remote plugins: only the
    // first ten manifests are read this round.
    const first = await ensureCommunityPluginDisplayFacts({
      ...input,
      previousCatalog: null,
      storedObservations: [],
    });
    expect(first).toEqual({
      probed: COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT,
      skipped: 0,
      failed: 0,
    });

    // Next trigger: the catalog is already persisted (previousCatalog now
    // contains every entry), yet the unobserved leftovers must still be
    // probed while the observed ten are skipped without requests.
    const second = await ensureCommunityPluginDisplayFacts({
      ...input,
      previousCatalog: currentCatalog,
      storedObservations: persisted[0]!,
    });
    expect(second).toEqual({
      probed: 2,
      skipped: COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT,
      failed: 0,
    });
    expect(persisted).toHaveLength(2);
    expect(persisted[1]).toHaveLength(ids.length);

    // Fully observed: a later trigger performs zero requests and no writes.
    const third = await ensureCommunityPluginDisplayFacts({
      ...input,
      previousCatalog: currentCatalog,
      storedObservations: persisted[1]!,
    });
    expect(third).toEqual({ probed: 0, skipped: ids.length, failed: 0 });
    expect(fetchManifestText).toHaveBeenCalledTimes(ids.length);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("ignores partial bundles even when they carry a manifest member", async () => {
    const fetchManifestText = vi.fn(async (pluginId: string) =>
      manifestText(pluginId)
    );

    const result = await ensureCommunityPluginDisplayFacts({
      scope: SCOPE,
      configDir: ".obsidian",
      catalog: catalog([
        partialEntry("broken-half"),
        completeEntry("whole"),
      ]),
      previousCatalog: null,
      storedObservations: [],
      fetchManifestText,
      persist: vi.fn(),
      now: 2000,
    });

    expect(result).toEqual({ probed: 1, skipped: 0, failed: 0 });
    expect(fetchManifestText.mock.calls.map((call) => call[0])).toEqual([
      "whole",
    ]);
  });
});

describe("mergeCommunityPluginManifestObservations", () => {
  async function observation(
    pluginId: string,
    eTag: string,
  ): Promise<CommunityPluginManifestObservationV1> {
    return observationFor(pluginId, member(pluginId, { eTag }));
  }

  it("keeps stored entries whose plugin id is not in the incoming set", async () => {
    const stored = [await observation("alpha", "etag-1")];
    const merged = mergeCommunityPluginManifestObservations(stored, []);
    expect(merged).toEqual(stored);
  });

  it("replaces stored entries of the same plugin id with incoming ones", async () => {
    const stored = [await observation("alpha", "etag-old")];
    const incoming = [await observation("alpha", "etag-new")];
    const merged = mergeCommunityPluginManifestObservations(stored, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toEqual(incoming[0]!.source);
  });

  it("keeps unrelated plugins and appends incoming ones sorted by id", async () => {
    const stored = [
      await observation("zeta", "etag-1"),
      await observation("alpha", "etag-1"),
    ];
    const incoming = [await observation("mid", "etag-1")];
    const merged = mergeCommunityPluginManifestObservations(stored, incoming);
    expect(merged.map((item) => item.pluginId)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
  });

  it("does not mutate the stored input array", async () => {
    const stored = [await observation("alpha", "etag-1")];
    const snapshot = [...stored];
    mergeCommunityPluginManifestObservations(
      stored,
      [await observation("beta", "etag-1")],
    );
    expect(stored).toEqual(snapshot);
  });
});
