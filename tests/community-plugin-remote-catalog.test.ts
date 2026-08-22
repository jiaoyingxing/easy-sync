import { describe, expect, it } from "vitest";
import { createCommunityPluginManifestObservation } from "../src/sync/community-plugin-bundle";
import {
  buildRemoteCommunityPluginCatalog,
  markRemoteCommunityPluginCatalogStale,
  readRemoteCommunityPluginCatalog,
  remoteCommunityPluginCatalogEntries,
  shouldMarkCommunityPluginCatalogStale,
  type RemoteCommunityPluginCatalogV1,
} from "../src/sync/community-plugin-remote-catalog";
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
});
