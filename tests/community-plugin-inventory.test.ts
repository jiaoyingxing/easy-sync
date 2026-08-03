import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  createCommunityPluginManifestObservation,
  type CommunityPluginManifestObservationV1,
} from "../src/sync/community-plugin-bundle";
import { buildCommunityPluginInventory } from "../src/sync/community-plugin-inventory";
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

function remoteFile(
  path: string,
  overrides: Partial<RemoteFileEntry> = {},
): RemoteFileEntry {
  return {
    path,
    driveId: path,
    parentId: "parent",
    size: 2,
    mtime: 1,
    eTag: "etag",
    cTag: "ctag",
    ...overrides,
  };
}

async function remoteManifestEvidence(
  pluginId: string,
  name: unknown,
): Promise<{
  remote: RemoteFileEntry;
  observation: CommunityPluginManifestObservationV1;
}> {
  const manifestText = JSON.stringify({
    id: pluginId,
    name,
    version: "2.0.0",
  });
  const content = new TextEncoder().encode(manifestText);
  const remote = remoteFile(
    `.obsidian/plugins/${pluginId}/manifest.json`,
    { size: content.byteLength },
  );
  const observation = await createCommunityPluginManifestObservation(
    SCOPE,
    pluginId,
    remote,
    content.buffer,
  );
  return { remote, observation };
}

describe("community plugin inventory", () => {
  it("combines local and cached remote ids without private Obsidian APIs", async () => {
    const files = new Map<string, string>([
      [".obsidian/community-plugins.json", JSON.stringify(["calendar"])],
      [".obsidian/plugins/calendar/manifest.json", JSON.stringify({
        id: "calendar",
        name: "Calendar",
        version: "2.0.0",
        isDesktopOnly: false,
      })],
      [".obsidian/plugins/calendar/data.json", "{}"],
      [".obsidian/plugins/easy-sync/manifest.json", JSON.stringify({
        id: "easy-sync",
        name: "EasySync",
        version: "1.1.3",
      })],
    ]);
    const adapter = {
      exists: vi.fn(async (path: string) =>
        path === ".obsidian/plugins" || files.has(path)
      ),
      list: vi.fn(async () => ({
        files: [],
        folders: [
          ".obsidian/plugins/calendar",
          ".obsidian/plugins/easy-sync",
        ],
      })),
      read: vi.fn(async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error("missing");
        return value;
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      [],
      [
        remoteFile(".obsidian/plugins/calendar/manifest.json"),
        remoteFile(".obsidian/plugins/remote-only/data.json"),
      ],
    );

    expect(result).toEqual([
      {
        id: "calendar",
        name: "Calendar",
        version: "2.0.0",
        local: true,
        remote: true,
        dataLocally: true,
        dataRemotely: false,
        enabledLocally: true,
        desktopOnly: false,
        manifestIssue: false,
      },
      {
        id: "remote-only",
        name: null,
        version: null,
        local: false,
        remote: true,
        dataLocally: false,
        dataRemotely: true,
        enabledLocally: null,
        desktopOnly: false,
        manifestIssue: false,
      },
    ]);
  });

  it("does not expose an empty remote plugin directory shell as an inventory row", async () => {
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      read: vi.fn(async () => {
        throw new Error("missing");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
    );

    expect(result).toEqual([]);
  });

  it("keeps a locally ignored plugin visible after its local files disappear", async () => {
    const root = ".obsidian/plugins/calendar";
    const adapter = {
      exists: vi.fn(async (path: string) =>
        path === ".obsidian/plugins" || path === root
      ),
      list: vi.fn(async () => ({ files: [], folders: [root] })),
      read: vi.fn(async () => {
        throw new Error("missing");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      ["calendar"],
      [],
      ["calendar"],
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "calendar",
        local: false,
        remote: false,
      }),
    ]);
  });

  it("uses retained common-state evidence for an ignored remote-only row", async () => {
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      read: vi.fn(async () => {
        throw new Error("missing");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      ["calendar"],
      [],
      ["calendar"],
      [],
      [],
      null,
      ["calendar"],
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "calendar",
        local: false,
        remote: true,
      }),
    ]);
  });

  it("marks a local plugin with an unreadable manifest instead of dropping it", async () => {
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async () => ({
        files: [],
        folders: [".obsidian/plugins/broken"],
      })),
      read: vi.fn(async () => {
        throw new Error("bad json");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
    );

    expect(result[0]).toMatchObject({
      id: "broken",
      name: null,
      local: true,
      remote: false,
      manifestIssue: true,
    });
  });

  it("presents an ignored residual directory as a remote-only managed plugin", async () => {
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async () => ({
        files: [],
        folders: [".obsidian/plugins/calendar"],
      })),
      read: vi.fn(async () => {
        throw new Error("missing manifest");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      ["calendar"],
      [
        remoteFile(".obsidian/plugins/calendar/main.js"),
        remoteFile(".obsidian/plugins/calendar/manifest.json"),
      ],
      ["calendar"],
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "calendar",
        local: false,
        remote: true,
        manifestIssue: false,
      }),
    ]);
  });

  it("presents a mobile desktop-only residual directory from the runtime participation result", async () => {
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async () => ({
        files: [],
        folders: [".obsidian/plugins/calendar"],
      })),
      read: vi.fn(async () => {
        throw new Error("missing manifest");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      ["calendar"],
      [
        remoteFile(".obsidian/plugins/calendar/main.js"),
        remoteFile(".obsidian/plugins/calendar/manifest.json"),
      ],
      [],
      ["calendar"],
    );

    expect(result).toEqual([
      expect.objectContaining({
        id: "calendar",
        local: false,
        remote: true,
        desktopOnly: true,
        manifestIssue: false,
      }),
    ]);
  });

  it("keeps a saved selected id visible so the user can remove it", async () => {
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      read: vi.fn(async () => {
        throw new Error("missing");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      ["missing-plugin", "easy-sync"],
    );

    expect(result).toEqual([
      {
        id: "missing-plugin",
        name: null,
        version: null,
        local: false,
        remote: false,
        dataLocally: false,
        dataRemotely: false,
        enabledLocally: null,
        desktopOnly: false,
        manifestIssue: false,
      },
    ]);
  });

  it("uses only an exact source-bound remote manifest observation as the remote display name", async () => {
    const { remote, observation } = await remoteManifestEvidence(
      "remote-only",
      "  Remote Display Name  ",
    );
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      read: vi.fn(async () => {
        throw new Error("missing");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      [],
      [remote],
      [],
      [],
      [],
      { scope: SCOPE, observations: [observation] },
    );

    expect(result[0]).toMatchObject({
      id: "remote-only",
      name: "Remote Display Name",
      local: false,
      remote: true,
    });
  });

  it("prefers a valid local manifest name over exact remote evidence", async () => {
    const { remote, observation } = await remoteManifestEvidence(
      "calendar",
      "Remote Calendar",
    );
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const adapter = {
      exists: vi.fn(async (path: string) =>
        path === ".obsidian/plugins" || path === manifestPath
      ),
      list: vi.fn(async () => ({
        files: [],
        folders: [".obsidian/plugins/calendar"],
      })),
      read: vi.fn(async (path: string) => {
        if (path !== manifestPath) throw new Error("missing");
        return JSON.stringify({
          id: "calendar",
          name: "Local Calendar",
          version: "3.0.0",
        });
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      [],
      [remote],
      [],
      [],
      [],
      { scope: SCOPE, observations: [observation] },
    );

    expect(result[0]).toMatchObject({
      id: "calendar",
      name: "Local Calendar",
      manifestIssue: false,
    });
  });

  it("rejects an empty local name and may fall back to exact remote evidence", async () => {
    const { remote, observation } = await remoteManifestEvidence(
      "calendar",
      "Remote Calendar",
    );
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const adapter = {
      exists: vi.fn(async (path: string) =>
        path === ".obsidian/plugins" || path === manifestPath
      ),
      list: vi.fn(async () => ({
        files: [],
        folders: [".obsidian/plugins/calendar"],
      })),
      read: vi.fn(async (path: string) => {
        if (path !== manifestPath) throw new Error("missing");
        return JSON.stringify({
          id: "calendar",
          name: "   ",
          version: "3.0.0",
        });
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      [],
      [remote],
      [],
      [],
      [],
      { scope: SCOPE, observations: [observation] },
    );

    expect(result[0]).toMatchObject({
      id: "calendar",
      name: "Remote Calendar",
      local: true,
      manifestIssue: true,
    });
  });

  it("keeps the display name neutral when exact remote evidence has an empty name", async () => {
    const { remote, observation } = await remoteManifestEvidence(
      "remote-only",
      "   ",
    );
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      read: vi.fn(async () => {
        throw new Error("missing");
      }),
    } as unknown as DataAdapter;

    const result = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      [],
      [remote],
      [],
      [],
      [],
      { scope: SCOPE, observations: [observation] },
    );

    expect(result[0]?.name).toBeNull();
  });

  it("ignores stale or wrong-scope remote manifest observations", async () => {
    const { remote, observation } = await remoteManifestEvidence(
      "remote-only",
      "Remote Display Name",
    );
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      read: vi.fn(async () => {
        throw new Error("missing");
      }),
    } as unknown as DataAdapter;

    const stale = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      [],
      [{ ...remote, eTag: "changed" }],
      [],
      [],
      [],
      { scope: SCOPE, observations: [observation] },
    );
    const wrongScope = await buildCommunityPluginInventory(
      adapter,
      ".obsidian",
      "easy-sync",
      [],
      [remote],
      [],
      [],
      [],
      {
        scope: { ...SCOPE, filesRootId: "other-files" },
        observations: [observation],
      },
    );

    expect(stale[0]?.name).toBeNull();
    expect(wrongScope[0]?.name).toBeNull();
  });

  it("fails closed when the local plugin folder cannot be listed", async () => {
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      read: vi.fn(async () => "[]"),
    } as unknown as DataAdapter;

    await expect(buildCommunityPluginInventory(
      adapter,
      ".obsidian",
    )).rejects.toThrow("storage unavailable");
  });
});
