import { describe, expect, it } from "vitest";
import { createCommunityPluginManifestObservation } from "../src/sync/community-plugin-bundle";
import {
  buildRemoteCommunityPluginCatalog,
  buildRemoteCommunityPluginCatalogFromIndex,
  markRemoteCommunityPluginCatalogStale,
  mergeRemoteCommunityPluginCatalogKeepingSuperset,
  readRemoteCommunityPluginCatalog,
  remoteCommunityPluginCatalogEntries,
  shouldMarkCommunityPluginCatalogStale,
  type RemoteCommunityPluginCatalogV1,
} from "../src/sync/community-plugin-remote-catalog";
import {
  buildRemoteIndexV2,
  type RemoteIndexV2,
} from "../src/sync/remote-index-v2";
import type { DriveItem } from "../src/onedrive/types";
import type { RemoteFileEntry, SyncScope } from "../src/sync/types";

const SCOPE: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files-root",
};

function folder(id: string, name: string, parentId: string): DriveItem {
  return {
    id,
    name,
    folder: {},
    parentReference: { id: parentId, driveId: SCOPE.driveId },
    eTag: `etag-${id}`,
  };
}

function file(
  id: string,
  name: string,
  parentId: string,
  overrides: Partial<DriveItem> = {},
): DriveItem {
  return {
    id,
    name,
    size: 10,
    file: { hashes: { sha256Hash: "a".repeat(64) } },
    parentReference: { id: parentId, driveId: SCOPE.driveId },
    lastModifiedDateTime: "2026-08-03T00:00:00.000Z",
    eTag: `etag-${id}`,
    cTag: `ctag-${id}`,
    ...overrides,
  };
}

function items(manifestSize: number): DriveItem[] {
  return [
    folder("config", ".obsidian", SCOPE.filesRootId),
    folder("plugins", "plugins", "config"),
    folder("calendar-root", "calendar", "plugins"),
    file("calendar-main", "main.js", "calendar-root"),
    file("calendar-manifest", "manifest.json", "calendar-root", {
      size: manifestSize,
      file: { hashes: {} },
    }),
    folder("partial-root", "partial", "plugins"),
    file("partial-manifest", "manifest.json", "partial-root"),
    folder("own-root", "easy-sync", "plugins"),
    file("own-main", "main.js", "own-root"),
    file("own-manifest", "manifest.json", "own-root"),
  ];
}

describe("remote community-plugin catalog", () => {
  it("builds a scope-bound complete catalog independently of device selection", async () => {
    const manifestText = JSON.stringify({
      id: "calendar",
      name: "Calendar",
      version: "2.0.0",
    });
    const manifestBytes = new TextEncoder().encode(manifestText);
    const remoteManifest: RemoteFileEntry = {
      path: ".obsidian/plugins/calendar/manifest.json",
      driveId: "calendar-manifest",
      parentId: "calendar-root",
      size: manifestBytes.byteLength,
      mtime: Date.parse("2026-08-03T00:00:00.000Z"),
      eTag: "etag-calendar-manifest",
      cTag: "ctag-calendar-manifest",
    };
    const observation = await createCommunityPluginManifestObservation(
      SCOPE,
      "calendar",
      remoteManifest,
      manifestBytes.buffer,
    );

    const catalog = await buildRemoteCommunityPluginCatalog({
      scope: SCOPE,
      configDir: ".obsidian",
      items: items(manifestBytes.byteLength),
      manifestObservations: [observation],
      observedAt: 10,
      previous: null,
      ownPluginId: "easy-sync",
    });

    expect(catalog).toMatchObject({
      version: 1,
      complete: true,
      stale: false,
      revision: 1,
      observedAt: 10,
      scope: SCOPE,
    });
    expect(catalog.entries.map((entry) => entry.pluginId))
      .toEqual(["calendar", "partial"]);
    expect(catalog.entries[0]).toMatchObject({
      pluginId: "calendar",
      bundleState: "complete",
      manifestName: "Calendar",
      bundleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(catalog.entries[1]).toMatchObject({
      pluginId: "partial",
      bundleState: "partial",
    });
    expect(remoteCommunityPluginCatalogEntries(catalog).map((entry) => entry.path))
      .toEqual([
        ".obsidian/plugins/calendar/main.js",
        ".obsidian/plugins/calendar/manifest.json",
        ".obsidian/plugins/partial/manifest.json",
      ]);
  });

  it("keeps revisions stable for equal facts, advances on version change, and preserves stale rows", async () => {
    const first = await buildRemoteCommunityPluginCatalog({
      scope: SCOPE,
      configDir: ".obsidian",
      items: items(10),
      manifestObservations: [],
      observedAt: 10,
      previous: null,
    });
    const same = await buildRemoteCommunityPluginCatalog({
      scope: SCOPE,
      configDir: ".obsidian",
      items: items(10),
      manifestObservations: [],
      observedAt: 20,
      previous: first,
    });
    const changedItems = items(10).map((item) =>
      item.id === "calendar-main" ? { ...item, eTag: "etag-changed" } : item
    );
    const changed = await buildRemoteCommunityPluginCatalog({
      scope: SCOPE,
      configDir: ".obsidian",
      items: changedItems,
      manifestObservations: [],
      observedAt: 30,
      previous: same,
    });
    const stale = markRemoteCommunityPluginCatalogStale(changed, 40);

    expect(same.revision).toBe(first.revision);
    expect(changed.revision).toBe(first.revision + 1);
    expect(changed.sourceDigest).not.toBe(first.sourceDigest);
    expect(stale).toMatchObject({
      stale: true,
      revision: changed.revision,
      entries: changed.entries,
      lastRefreshFailedAt: 40,
    });
  });

  it("drops malformed cache instead of converting it into an empty cloud", async () => {
    const catalog = await buildRemoteCommunityPluginCatalog({
      scope: SCOPE,
      configDir: ".obsidian",
      items: items(10),
      manifestObservations: [],
      observedAt: 10,
      previous: null,
    });

    await expect(readRemoteCommunityPluginCatalog({
      ...catalog,
      sourceDigest: "0".repeat(64),
    })).resolves.toBeNull();
    await expect(readRemoteCommunityPluginCatalog(catalog))
      .resolves.toEqual(catalog);
  });

  it("downgrades a trusted catalog to stale only after consecutive failures", () => {
    const trusted: RemoteCommunityPluginCatalogV1 = {
      version: 1,
      scope: SCOPE,
      complete: true,
      stale: false,
      revision: 3,
      observedAt: 10,
      sourceDigest: "a".repeat(64),
      entries: [],
    };
    expect(shouldMarkCommunityPluginCatalogStale(null, 1)).toBe(true);
    expect(shouldMarkCommunityPluginCatalogStale(trusted, 0)).toBe(false);
    expect(shouldMarkCommunityPluginCatalogStale(trusted, 1)).toBe(false);
    expect(shouldMarkCommunityPluginCatalogStale(trusted, 2)).toBe(true);
    expect(shouldMarkCommunityPluginCatalogStale({
      ...trusted,
      stale: true,
    }, 1)).toBe(true);
  });

  describe("committed-index variant", () => {
    function committedIndex(entries: readonly DriveItem[]): RemoteIndexV2 {
      return buildRemoteIndexV2(
        entries as DriveItem[],
        SCOPE.filesRootId,
        null,
      ).index;
    }

    it("builds the identical catalog from a committed remote index as from its item stream", async () => {
      const manifestText = JSON.stringify({
        id: "calendar",
        name: "Calendar",
        version: "2.0.0",
      });
      const manifestBytes = new TextEncoder().encode(manifestText);
      const remoteManifest: RemoteFileEntry = {
        path: ".obsidian/plugins/calendar/manifest.json",
        driveId: "calendar-manifest",
        parentId: "calendar-root",
        size: manifestBytes.byteLength,
        mtime: Date.parse("2026-08-03T00:00:00.000Z"),
        eTag: "etag-calendar-manifest",
        cTag: "ctag-calendar-manifest",
      };
      const observation = await createCommunityPluginManifestObservation(
        SCOPE,
        "calendar",
        remoteManifest,
        manifestBytes.buffer,
      );

      const streamItems = items(manifestBytes.byteLength);
      const fromStream = await buildRemoteCommunityPluginCatalog({
        scope: SCOPE,
        configDir: ".obsidian",
        items: streamItems,
        manifestObservations: [observation],
        observedAt: 10,
        previous: null,
      });
      // A committed index stores the same facts in a different node order;
      // the catalog result must stay byte-identical and canonical.
      const shuffled = [...streamItems].reverse();
      const fromIndex = await buildRemoteCommunityPluginCatalogFromIndex({
        scope: SCOPE,
        configDir: ".obsidian",
        index: committedIndex(shuffled),
        manifestObservations: [observation],
        observedAt: 10,
        previous: null,
      });

      expect(fromIndex).toEqual(fromStream);
      expect(fromIndex.revision).toBe(1);
      expect(fromIndex.entries[0]).toMatchObject({
        pluginId: "calendar",
        bundleState: "complete",
        manifestName: "Calendar",
      });
    });

    it("skips a root node recorded inside the committed index and keeps revision semantics", async () => {
      const firstItems = items(10);
      const first = await buildRemoteCommunityPluginCatalogFromIndex({
        scope: SCOPE,
        configDir: ".obsidian",
        index: committedIndex(firstItems),
        manifestObservations: [],
        observedAt: 10,
        previous: null,
      });
      const indexWithRoot = committedIndex(firstItems);
      const withRoot: RemoteIndexV2 = {
        ...indexWithRoot,
        itemsById: {
          ...indexWithRoot.itemsById,
          [SCOPE.filesRootId]: {
            id: SCOPE.filesRootId,
            parentId: "outside-the-scope",
            name: "files",
            kind: "folder",
          },
        },
      };
      const withRootCatalog = await buildRemoteCommunityPluginCatalogFromIndex({
        scope: SCOPE,
        configDir: ".obsidian",
        index: withRoot,
        manifestObservations: [],
        observedAt: 20,
        previous: first,
      });
      expect(withRootCatalog.entries).toEqual(first.entries);
      expect(withRootCatalog.revision).toBe(first.revision);
    });

    it("rejects an incomplete index or one bound to another files root", async () => {
      const index = committedIndex(items(10));
      await expect(buildRemoteCommunityPluginCatalogFromIndex({
        scope: SCOPE,
        configDir: ".obsidian",
        index: { ...index, complete: false } as unknown as RemoteIndexV2,
        manifestObservations: [],
        observedAt: 10,
        previous: null,
      })).rejects.toThrow("not complete for the scope");
      await expect(buildRemoteCommunityPluginCatalogFromIndex({
        scope: SCOPE,
        configDir: ".obsidian",
        index: { ...index, filesRootId: "another-root" },
        manifestObservations: [],
        observedAt: 10,
        previous: null,
      })).rejects.toThrow("not complete for the scope");
    });
  });

  describe("round-end superset merge", () => {
    function catalogFor(
      ids: readonly string[],
      previous: RemoteCommunityPluginCatalogV1 | null,
      observedAt: number,
    ): Promise<RemoteCommunityPluginCatalogV1> {
      const stream: DriveItem[] = [
        folder("config", ".obsidian", SCOPE.filesRootId),
        folder("plugins", "plugins", "config"),
      ];
      for (const id of ids) {
        const root = `root-${id}`;
        stream.push(
          folder(root, id, "plugins"),
          file(`${id}-main`, "main.js", root),
          file(`${id}-manifest`, "manifest.json", root),
        );
      }
      return buildRemoteCommunityPluginCatalog({
        scope: SCOPE,
        configDir: ".obsidian",
        items: stream,
        manifestObservations: [],
        observedAt,
        previous,
        ownPluginId: "easy-sync",
      });
    }

    it("keeps delta-fresh entries the committed index no longer sees", async () => {
      // Delta refresh saw an unanchored cloud bundle (uploaded by another
      // device): two plugins. The next round-end committed-index build only
      // sees the anchored one (calendar). The merge must not regress.
      const deltaFresh = await catalogFor(["calendar", "cloud-only"], null, 10);
      const indexOnly = await catalogFor(["calendar"], deltaFresh, 20);
      const merged = await mergeRemoteCommunityPluginCatalogKeepingSuperset(
        deltaFresh,
        indexOnly,
      );
      expect(merged.entries.map((entry) => entry.pluginId))
        .toEqual(["calendar", "cloud-only"]);
      expect(merged.revision).toBeGreaterThan(indexOnly.revision);
      expect(merged.observedAt).toBe(20);
      expect(merged.complete).toBe(true);
      expect(merged.stale).toBe(false);
      // The merged catalog stays a valid persisted shape.
      expect(await readRemoteCommunityPluginCatalog(merged)).not.toBeNull();
    });

    it("returns the fresh build unchanged when it already covers every entry", async () => {
      const wide = await catalogFor(["calendar", "cloud-only"], null, 10);
      const fresh = await catalogFor(["calendar", "cloud-only"], wide, 20);
      const merged = await mergeRemoteCommunityPluginCatalogKeepingSuperset(
        wide,
        fresh,
      );
      expect(merged).toBe(fresh);
    });

    it("prefers the fresh build's per-plugin facts over retained entries", async () => {
      const deltaFresh = await catalogFor(["calendar"], null, 10);
      const refreshedStream: DriveItem[] = [
        folder("config", ".obsidian", SCOPE.filesRootId),
        folder("plugins", "plugins", "config"),
        folder("calendar-root", "calendar", "plugins"),
        file("calendar-main", "main.js", "calendar-root"),
        file("calendar-manifest", "manifest.json", "calendar-root", {
          size: 999,
          file: { hashes: {} },
          eTag: "etag-manifest-v2",
        }),
      ];
      const refreshed = await buildRemoteCommunityPluginCatalog({
        scope: SCOPE,
        configDir: ".obsidian",
        items: refreshedStream,
        manifestObservations: [],
        observedAt: 20,
        previous: deltaFresh,
        ownPluginId: "easy-sync",
      });
      const merged = await mergeRemoteCommunityPluginCatalogKeepingSuperset(
        deltaFresh,
        refreshed,
      );
      expect(merged.entries[0].members.find((member) =>
        member.path.endsWith("/manifest.json")
      )?.eTag).toBe("etag-manifest-v2");
    });

    it("returns the fresh build when there is no previous catalog or the scope changed", async () => {
      const fresh = await catalogFor(["calendar"], null, 10);
      expect(await mergeRemoteCommunityPluginCatalogKeepingSuperset(
        null,
        fresh,
      )).toBe(fresh);
      const otherScope: SyncScope = {
        ...SCOPE,
        vaultFolderId: "other-vault",
        filesRootId: "other-root",
      };
      const foreign = await buildRemoteCommunityPluginCatalog({
        scope: otherScope,
        configDir: ".obsidian",
        items: [
          folder("other-config", ".obsidian", otherScope.filesRootId),
          folder("other-plugins", "plugins", "other-config"),
          folder("other-calendar-root", "calendar", "other-plugins"),
          file("other-calendar-main", "main.js", "other-calendar-root"),
          file(
            "other-calendar-manifest",
            "manifest.json",
            "other-calendar-root",
          ),
        ],
        manifestObservations: [],
        observedAt: 10,
        previous: fresh,
        ownPluginId: "easy-sync",
      });
      expect(await mergeRemoteCommunityPluginCatalogKeepingSuperset(
        fresh,
        foreign,
      )).toBe(foreign);
    });
  });
});
