import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder, type Vault } from "obsidian";
import {
  isEasySyncInternalPath,
  LocalScanner,
  normalizeExcludedFolders,
} from "../src/sync/local-scanner";
import type { ScanConfig } from "../src/sync/types";
import type { PluginScopeSelection } from "../src/sync/community-plugin-sync-policy";

const content = new TextEncoder().encode("test").buffer;

function makeScanner(
  includePluginCode: boolean,
  includePluginData: boolean,
  pluginCodeSelection?: PluginScopeSelection,
  pluginDataSelection?: PluginScopeSelection,
  includeOwnPluginCode = true,
) {
  const directories: Record<string, { files: string[]; folders: string[] }> = {
    ".obsidian/plugins": {
      files: [],
      folders: [
        ".obsidian/plugins/example-plugin",
        ".obsidian/plugins/easy-sync",
      ],
    },
    ".obsidian/plugins/example-plugin": {
      files: [
        ".obsidian/plugins/example-plugin/main.js",
        ".obsidian/plugins/example-plugin/manifest.json",
        ".obsidian/plugins/example-plugin/styles.css",
        ".obsidian/plugins/example-plugin/data.json",
        ".obsidian/plugins/example-plugin/versions.json",
      ],
      folders: [".obsidian/plugins/example-plugin/runtime"],
    },
    ".obsidian/plugins/example-plugin/runtime": {
      files: [
        ".obsidian/plugins/example-plugin/runtime/cache.json",
        ".obsidian/plugins/example-plugin/runtime/output.wav",
      ],
      folders: [],
    },
    ".obsidian/plugins/easy-sync": {
      files: [
        ".obsidian/plugins/easy-sync/main.js",
        ".obsidian/plugins/easy-sync/manifest.json",
        ".obsidian/plugins/easy-sync/styles.css",
        ".obsidian/plugins/easy-sync/data.json",
        ".obsidian/plugins/easy-sync/data.sync-conflict-20260709.json",
        ".obsidian/plugins/easy-sync/remote-state.json",
        ".obsidian/plugins/easy-sync/base-content.json",
        ".obsidian/plugins/easy-sync/state-v2.json",
        ".obsidian/plugins/easy-sync/state-v2.next.json",
        ".obsidian/plugins/easy-sync/state-v2.previous.json",
        ".obsidian/plugins/easy-sync/state-v2.recovery.json",
        ".obsidian/plugins/easy-sync/state-v2.manifest.json",
        ".obsidian/plugins/easy-sync/state-v2.manifest.next.json",
        ".obsidian/plugins/easy-sync/state-v2.manifest.retired.json",
        ".obsidian/plugins/easy-sync/state-v2.rollback.json",
        ".obsidian/plugins/easy-sync/state-v2.migration-hold.json",
        ".obsidian/plugins/easy-sync/state-v2.migration-hold.next.json",
        `.obsidian/plugins/easy-sync/state-v2.corrupt-source-${"a".repeat(64)}.json`,
        `.obsidian/plugins/easy-sync/state-v2.corrupt-source-${"a".repeat(64)}.json.next`,
        ".obsidian/plugins/easy-sync/state-v2.corrupt-recovery.json",
        ".obsidian/plugins/easy-sync/state-v2.corrupt-recovery.next.json",
        ".obsidian/plugins/easy-sync/state-v1.backup.json",
        ".obsidian/plugins/easy-sync/ancestor-manifest-v2.json",
        ".obsidian/plugins/easy-sync/ancestor-manifest-v2.next.json",
      ],
      folders: [
        ".obsidian/plugins/easy-sync/logs",
        ".obsidian/plugins/easy-sync/tmp",
        ".obsidian/plugins/easy-sync/ancestors-v2",
        ".obsidian/plugins/easy-sync/state",
        ".obsidian/plugins/easy-sync/objects",
        ".obsidian/plugins/easy-sync/runtime",
      ],
    },
    ".obsidian/plugins/easy-sync/logs": {
      files: [".obsidian/plugins/easy-sync/logs/2026-07-10.jsonl"],
      folders: [],
    },
    ".obsidian/plugins/easy-sync/tmp": {
      files: [".obsidian/plugins/easy-sync/tmp/download.part"],
      folders: [],
    },
    ".obsidian/plugins/easy-sync/ancestors-v2": {
      files: [`.obsidian/plugins/easy-sync/ancestors-v2/${"a".repeat(64)}.txt`],
      folders: [],
    },
    ".obsidian/plugins/easy-sync/state": {
      files: [],
      folders: [
        ".obsidian/plugins/easy-sync/state/legacy",
        ".obsidian/plugins/easy-sync/state/v2",
      ],
    },
    ".obsidian/plugins/easy-sync/objects": {
      files: [],
      folders: [".obsidian/plugins/easy-sync/objects/ancestors-v2"],
    },
    ".obsidian/plugins/easy-sync/runtime": {
      files: [],
      folders: [".obsidian/plugins/easy-sync/runtime/cache"],
    },
  };

  const adapter = {
    exists: vi.fn(async () => true),
    list: vi.fn(async (path: string) => directories[path] ?? { files: [], folders: [] }),
    stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
    readBinary: vi.fn(async () => content),
  };
  const vault = {
    adapter,
    getFiles: vi.fn(() => []),
  } as unknown as Vault;
  const config: ScanConfig & { includeOwnPluginCode: boolean } = {
    excludePaths: [".obsidian/"],
    includePaths: [
      ".obsidian/plugins/easy-sync/",
      ".obsidian/plugins/",
      ".obsidian/plugins/",
    ],
    maxFileSize: 50 * 1024 * 1024,
    includeOwnPluginCode,
    includePluginCode,
    includePluginData,
    pluginCodeSelection,
    pluginDataSelection,
  };

  return { scanner: new LocalScanner(vault, config), adapter };
}

describe("LocalScanner plugin config paths", () => {
  it("excludes the vault config directory by default and re-includes only selected paths", () => {
    const vault = {
      configDir: ".obsidian",
      adapter: {},
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault);

    expect(scanner.shouldSyncPath(".obsidian/app.json")).toBe(false);
    expect(scanner.shouldSyncPath(".obsidian/hotkeys.json")).toBe(false);
    expect(scanner.shouldSyncPath("Notes/note.md")).toBe(true);

    scanner.setConfig({
      includePaths: [".obsidian/appearance.json"],
    });

    expect(scanner.shouldSyncPath(".obsidian/app.json")).toBe(false);
    expect(scanner.shouldSyncPath(".obsidian/appearance.json")).toBe(true);
  });

  it("uses the vault's custom config directory for the default exclusion", () => {
    const vault = {
      configDir: ".mobile-config",
      adapter: {},
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault);

    expect(scanner.shouldSyncPath(".mobile-config/app.json")).toBe(false);
    expect(scanner.shouldSyncPath(".obsidian/app.json")).toBe(true);
  });

  it.each([
    { code: false, data: false, expected: [
      ".obsidian/plugins/easy-sync/main.js",
      ".obsidian/plugins/easy-sync/manifest.json",
      ".obsidian/plugins/easy-sync/styles.css",
    ] },
    { code: true, data: false, expected: [
      ".obsidian/plugins/easy-sync/main.js",
      ".obsidian/plugins/easy-sync/manifest.json",
      ".obsidian/plugins/easy-sync/styles.css",
      ".obsidian/plugins/example-plugin/main.js",
      ".obsidian/plugins/example-plugin/manifest.json",
      ".obsidian/plugins/example-plugin/styles.css",
    ] },
    { code: false, data: true, expected: [
      ".obsidian/plugins/easy-sync/main.js",
      ".obsidian/plugins/easy-sync/manifest.json",
      ".obsidian/plugins/easy-sync/styles.css",
    ] },
    { code: true, data: true, expected: [
      ".obsidian/plugins/easy-sync/main.js",
      ".obsidian/plugins/easy-sync/manifest.json",
      ".obsidian/plugins/easy-sync/styles.css",
      ".obsidian/plugins/example-plugin/data.json",
      ".obsidian/plugins/example-plugin/main.js",
      ".obsidian/plugins/example-plugin/manifest.json",
      ".obsidian/plugins/example-plugin/styles.css",
    ] },
  ])("requires plugin code participation before plugin data", async ({ code, data, expected }) => {
    const { scanner } = makeScanner(code, data);

    const result = await scanner.scanAll();

    expect(result.entries.map((entry) => entry.path).sort()).toEqual(expected.sort());
  });

  it("normalizes full folder paths and never scans EasySync logs twice", async () => {
    const { scanner, adapter } = makeScanner(true, true);

    await scanner.scanAll();

    expect(adapter.list).not.toHaveBeenCalledWith(
      expect.stringContaining(".obsidian/plugins/.obsidian/plugins"),
    );
    expect(adapter.list).not.toHaveBeenCalledWith(".obsidian/plugins/easy-sync/logs");
    expect(adapter.list).not.toHaveBeenCalledWith(".obsidian/plugins/easy-sync/tmp");
    expect(adapter.list).not.toHaveBeenCalledWith(".obsidian/plugins/easy-sync/state");
    expect(adapter.list).not.toHaveBeenCalledWith(".obsidian/plugins/easy-sync/objects");
    expect(adapter.list).not.toHaveBeenCalledWith(".obsidian/plugins/easy-sync/runtime");
    expect(adapter.list).not.toHaveBeenCalledWith(".obsidian/plugins/example-plugin/runtime");
    expect(adapter.list).toHaveBeenCalledTimes(3);
  });

  it("keeps EasySync self-sync outside the community-plugin owner", async () => {
    const { scanner } = makeScanner(
      true,
      true,
      { mode: "all", pluginIds: [] },
      { mode: "all", pluginIds: [] },
      false,
    );

    const result = await scanner.scanAll();

    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      ".obsidian/plugins/example-plugin/data.json",
      ".obsidian/plugins/example-plugin/main.js",
      ".obsidian/plugins/example-plugin/manifest.json",
      ".obsidian/plugins/example-plugin/styles.css",
    ]);
    expect(scanner.shouldSyncPath(
      ".obsidian/plugins/easy-sync/main.js",
    )).toBe(false);
    expect(scanner.shouldSyncFolderPath(
      ".obsidian/plugins/easy-sync",
    )).toBe(false);
    expect(scanner.shouldSyncFolderPath(".obsidian/plugins")).toBe(true);
    expect(scanner.shouldSyncPath(
      ".obsidian/plugins/example-plugin/main.js",
    )).toBe(true);
  });

  it("filters community plugin code and data independently in selected mode", async () => {
    const { scanner } = makeScanner(
      true,
      true,
      { mode: "selected", pluginIds: ["example-plugin"] },
      { mode: "selected", pluginIds: [] },
    );

    const result = await scanner.scanAll();

    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      ".obsidian/plugins/easy-sync/main.js",
      ".obsidian/plugins/easy-sync/manifest.json",
      ".obsidian/plugins/easy-sync/styles.css",
      ".obsidian/plugins/example-plugin/main.js",
      ".obsidian/plugins/example-plugin/manifest.json",
      ".obsidian/plugins/example-plugin/styles.css",
    ]);
    expect(scanner.shouldSyncPath(".obsidian/plugins/example-plugin/data.json")).toBe(false);
  });

  it("keeps device-local plugin exclusions outside an all-mode scan", async () => {
    const { scanner } = makeScanner(
      true,
      true,
      {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["example-plugin"],
      },
      {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["example-plugin"],
      },
    );

    const result = await scanner.scanAll();

    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      ".obsidian/plugins/easy-sync/main.js",
      ".obsidian/plugins/easy-sync/manifest.json",
      ".obsidian/plugins/easy-sync/styles.css",
    ]);
    expect(scanner.shouldSyncPath(
      ".obsidian/plugins/example-plugin/main.js",
    )).toBe(false);
    expect(scanner.shouldSyncPath(
      ".obsidian/plugins/example-plugin/data.json",
    )).toBe(false);
  });

  it("exposes the same plugin path filter for remote snapshots", () => {
    const { scanner } = makeScanner(true, false);

    expect(scanner.shouldSyncPath(".obsidian/plugins/example-plugin/main.js")).toBe(true);
    expect(scanner.shouldSyncPath(".obsidian/plugins/example-plugin/runtime/cache.json")).toBe(false);
    expect(scanner.shouldSyncPath(".obsidian/plugins/example-plugin/data.json")).toBe(false);
    expect(scanner.shouldSyncPath(".obsidian/plugins/easy-sync/tmp/download.part")).toBe(false);
  });

  it.each([
    ".obsidian/plugins/easy-sync/state-v2.authority.json",
    ".obsidian/plugins/easy-sync/state-v2.authority.next.json",
    ".obsidian/plugins/easy-sync/state-v2-indexeddb-recovery",
    ".obsidian/plugins/easy-sync/state-v2-indexeddb-recovery/checkpoint-000000000003.json",
    ".obsidian/plugins/easy-sync/state-v2-indexeddb-recovery/commit-000000000004.json.next",
    ".obsidian/plugins/easy-sync/state-v2.manifest.retired.json",
    ".obsidian/plugins/easy-sync/state-v2.rollback.json",
    ".obsidian/plugins/easy-sync/state-v2.reactivation-archive-123.json",
    ".obsidian/plugins/easy-sync/state-v2.reactivation-archive-123.json.next",
    `.obsidian/plugins/easy-sync/state-v2.corrupt-source-${"a".repeat(64)}.json`,
    `.obsidian/plugins/easy-sync/state-v2.corrupt-source-${"a".repeat(64)}.json.next`,
    ".obsidian/plugins/easy-sync/state-v2.corrupt-recovery.json",
    ".obsidian/plugins/easy-sync/state-v2.corrupt-recovery.next.json",
  ])("keeps V2 authority and downgrade evidence local: %s", (path) => {
    expect(isEasySyncInternalPath(path)).toBe(true);
  });
});

describe("LocalScanner folder topology", () => {
  const config: ScanConfig = {
    excludePaths: [".obsidian/"],
    includePaths: [".obsidian/snippets/"],
    maxFileSize: 50 * 1024 * 1024,
    includePluginCode: false,
    includePluginData: false,
  };

  it("combines file parent chains, loaded empty folders, and adapter-only included folders", async () => {
    const note = Object.assign(new TFile("Projects/Active/note.md"), {
      stat: { size: content.byteLength, mtime: 1 },
    });
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async (path: string) => {
        if (path === ".obsidian/snippets") {
          return { files: [], folders: [".obsidian/snippets/mobile"] };
        }
        if (path === ".obsidian/snippets/mobile") {
          return { files: [], folders: [] };
        }
        return { files: [], folders: [] };
      }),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => [note]),
      getAllLoadedFiles: vi.fn(() => [
        note,
        new TFolder("Projects"),
        new TFolder("Projects/Active"),
        new TFolder("Empty"),
        new TFolder("Excluded"),
      ]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      ...config,
      excludePaths: [".obsidian/", "Excluded/"],
    });

    const result = await scanner.scanAll();

    expect(result.folders).toEqual([
      { path: ".obsidian" },
      { path: ".obsidian/snippets" },
      { path: ".obsidian/snippets/mobile" },
      { path: "Empty" },
      { path: "Projects" },
      { path: "Projects/Active" },
    ]);
    expect(result.folderScanComplete).toBe(true);
    expect(result.folderScanFailures).toEqual([]);
  });

  it("keeps file sync complete but rejects folder shadow when folder enumeration is unavailable", async () => {
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, config);

    const result = await scanner.scanAll();

    expect(result.complete).toBe(true);
    expect(result.folderScanComplete).toBe(false);
    expect(result.folderScanFailures).toEqual(["/"]);
  });

  it("fails the folder snapshot closed on normalized folder collisions", async () => {
    const adapter = {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
      getAllLoadedFiles: vi.fn(() => [
        new TFolder("Notes"),
        new TFolder("notes"),
      ]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, { ...config, includePaths: [] });

    const result = await scanner.scanAll();

    expect(result.complete).toBe(true);
    expect(result.folderScanComplete).toBe(false);
    expect(result.folderScanFailures).toEqual(["Notes", "notes"]);
  });
});

describe("LocalScanner device-local folder exclusions", () => {
  it("normalizes separators, removes config paths, deduplicates case-insensitively, and collapses nested folders", () => {
    expect(normalizeExcludedFolders([
      " Notes\\Private/ ",
      "notes/private",
      "Notes/Private/Archive",
      "Projects/Local",
      ".obsidian",
      ".obsidian/themes",
      "",
      "/",
    ], ".obsidian")).toEqual([
      "Notes/Private",
      "Projects/Local",
    ]);
  });

  it("matches exact folder boundaries case-insensitively without excluding siblings", () => {
    const vault = {
      adapter: {},
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      excludePaths: [],
      includePaths: [],
      excludedFolders: ["Private"],
      maxFileSize: 50 * 1024 * 1024,
    });

    expect(scanner.shouldSyncPath("Private")).toBe(false);
    expect(scanner.shouldSyncPath("private/note.md")).toBe(false);
    expect(scanner.shouldSyncPath("PRIVATE/Nested/note.md")).toBe(false);
    expect(scanner.shouldSyncPath("Private-old/note.md")).toBe(true);
    expect(scanner.shouldSyncPath("Public/Private/note.md")).toBe(true);
  });

  it("keeps user folder exclusions stronger than technical include paths", () => {
    const vault = {
      adapter: {},
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      excludePaths: [],
      includePaths: ["Shared/"],
      excludedFolders: ["Shared"],
      maxFileSize: 50 * 1024 * 1024,
    });

    expect(scanner.shouldSyncPath("Shared/note.md")).toBe(false);
  });

  it("does not report intentionally excluded files as skipped", async () => {
    const adapter = {
      read: vi.fn().mockRejectedValue(new Error("missing")),
      write: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: content.byteLength, mtime: 1 }),
      readBinary: vi.fn().mockResolvedValue(content),
      list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => [
        { path: "Private/secret.md", stat: { size: content.byteLength, mtime: 1 } },
        { path: "Public/note.md", stat: { size: content.byteLength, mtime: 1 } },
      ]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      excludePaths: [],
      includePaths: [],
      excludedFolders: ["Private"],
      maxFileSize: 50 * 1024 * 1024,
    });

    const result = await scanner.scanAll();

    expect(result.entries.map((entry) => entry.path)).toEqual(["Public/note.md"]);
    expect(result.skippedCount).toBe(0);
    expect(adapter.readBinary).toHaveBeenCalledTimes(1);
  });
});

describe("LocalScanner large file boundary", () => {
  it("includes files within the default limit (500 MB) and skips larger files", async () => {
    const adapter = {
      stat: vi.fn(async (path: string) => ({
        size: path === "large.mp4" ? 57 * 1024 * 1024 : 501 * 1024 * 1024,
        mtime: 1,
      })),
      readBinary: vi.fn(async () => content),
      list: vi.fn(async () => ({ files: [], folders: [] })),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => [{ path: "large.mp4" }, { path: "too-large.zip" }]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault);

    const result = await scanner.scanAll();

    expect(result.entries.map((entry) => entry.path)).toContain("large.mp4");
    expect(result.skippedLarge).toEqual(["too-large.zip"]);
  });

  it("reuses TFile.stat for regular vault files instead of re-statting each path", async () => {
    const adapter = {
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
      read: vi.fn(async () => JSON.stringify({ format: 1, entries: {} })),
      write: vi.fn(async () => {}),
      list: vi.fn(async () => ({ files: [], folders: [] })),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => [{
        path: "note.md",
        stat: { size: content.byteLength, mtime: 1 },
      }]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      excludePaths: [],
      includePaths: [],
      maxFileSize: 50 * 1024 * 1024,
      includePluginCode: false,
      includePluginData: false,
    });

    const result = await scanner.scanAll();

    expect(result.entries.map((entry) => entry.path)).toEqual(["note.md"]);
    expect(adapter.stat).not.toHaveBeenCalled();
  });

  it("writes scan-cache only when entries actually change", async () => {
    const adapter = {
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
      read: vi.fn(async () => JSON.stringify({ format: 1, entries: {} })),
      write: vi.fn(async () => {}),
      list: vi.fn(async () => ({ files: [], folders: [] })),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => [{
        path: "note.md",
        stat: { size: content.byteLength, mtime: 1 },
      }]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      excludePaths: [],
      includePaths: [],
      maxFileSize: 50 * 1024 * 1024,
      includePluginCode: false,
      includePluginData: false,
    });

    const first = await scanner.scanAll();
    await scanner.scanAll();

    expect(adapter.write).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(adapter.write.mock.calls[0]![1] as string);
    expect(first.entries[0]?.quickXorHash).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(persisted.entries["note.md"].quickXorHash).toBe(
      first.entries[0]?.quickXorHash,
    );
  });
});

describe("Preflight P0 — Included path failures make the scan incomplete", () => {
  const config: ScanConfig = {
    excludePaths: [".obsidian/"],
    includePaths: [".obsidian/plugins/"],
    maxFileSize: 50 * 1024 * 1024,
    includePluginCode: true,
    includePluginData: false,
  };

  it("records an included directory traversal failure", async () => {
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async () => {
        throw new Error("simulated list failure");
      }),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, config);

    const result = await scanner.scanAll();

    expect(result.failedPaths).toContain(".obsidian/plugins");
    expect(result.complete).toBe(false);
  });

  it("treats an explicitly included directory that does not exist as a healthy empty scope", async () => {
    const missingPath = ".obsidian/snippets";
    const adapter = {
      exists: vi.fn(async (path: string) => path !== missingPath),
      list: vi.fn(async (path: string) => {
        if (path === ".obsidian/themes") return { files: [], folders: [] };
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      ...config,
      includePaths: [".obsidian/themes/", ".obsidian/snippets/"],
    });

    const result = await scanner.scanAll();

    expect(result.failedPaths).toEqual([]);
    expect(result.complete).toBe(true);
    expect(adapter.list).not.toHaveBeenCalledWith(missingPath);
    expect(scanner.shouldSyncPath(".obsidian/snippets/mobile.css")).toBe(true);
  });

  it("keeps the scan incomplete when an included directory existence check fails", async () => {
    const adapter = {
      exists: vi.fn(async () => {
        throw new Error("simulated existence check failure");
      }),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, config);

    const result = await scanner.scanAll();

    expect(result.failedPaths).toContain(".obsidian/plugins");
    expect(result.complete).toBe(false);
    expect(adapter.list).not.toHaveBeenCalled();
  });

  it("records a stat failure for a file found during included traversal", async () => {
    const path = ".obsidian/plugins/example-plugin/main.js";
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async () => ({ files: [path], folders: [] })),
      stat: vi.fn(async () => null),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, config);

    const result = await scanner.scanAll();

    expect(result.failedPaths).toContain(path);
    expect(result.complete).toBe(false);
  });

  it("records a stat failure for a file reported by the vault", async () => {
    const path = "note.md";
    const adapter = {
      read: vi.fn(async () => JSON.stringify({
        format: 1,
        entries: {
          [path]: {
            mtime: 1,
            size: content.byteLength,
            hash: "aa".repeat(32),
            binary: false,
          },
        },
      })),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      stat: vi.fn(async () => null),
      readBinary: vi.fn(async () => content),
      write: vi.fn(async () => undefined),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => [{ path }]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      excludePaths: [],
      includePaths: [],
      maxFileSize: 50 * 1024 * 1024,
      includePluginCode: false,
      includePluginData: false,
    });

    const result = await scanner.scanAll();

    expect(result.failedPaths).toContain(path);
    expect(result.entries).toEqual([]);
  });

  it("records a content read failure for an included file", async () => {
    const path = ".obsidian/plugins/example-plugin/main.js";
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async () => ({ files: [path], folders: [] })),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => { throw new Error("simulated read failure"); }),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, config);

    const result = await scanner.scanAll();

    expect(result.failedPaths).toContain(path);
  });

  it("records the exact uncertain subtree when nested traversal fails", async () => {
    const nested = ".obsidian/plugins/example-plugin";
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async (path: string) => {
        if (path === ".obsidian/plugins") return { files: [], folders: [nested] };
        throw new Error("nested list failure");
      }),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, config);

    const result = await scanner.scanAll();

    expect(result.failedPaths).toContain(nested);
  });

  it("does not mark an excluded plugin data file as uncertain", async () => {
    const excludedPath = ".obsidian/plugins/example-plugin/data.json";
    const adapter = {
      exists: vi.fn(async () => true),
      list: vi.fn(async () => ({ files: [excludedPath], folders: [] })),
      stat: vi.fn(async () => { throw new Error("must not stat excluded path"); }),
      readBinary: vi.fn(async () => content),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, config);

    const result = await scanner.scanAll();

    expect(result.failedPaths).toEqual([]);
    expect(adapter.stat).not.toHaveBeenCalled();
  });

  it("does not prune or persist the scan cache after an incomplete traversal", async () => {
    const adapter = {
      exists: vi.fn(async () => true),
      read: vi.fn(async () => JSON.stringify({
        format: 1,
        entries: {
          "previous.md": {
            mtime: 1,
            size: content.byteLength,
            hash: "aa".repeat(32),
            binary: false,
          },
        },
      })),
      list: vi.fn(async () => { throw new Error("simulated list failure"); }),
      stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
      readBinary: vi.fn(async () => content),
      write: vi.fn(async () => undefined),
    };
    const vault = {
      adapter,
      getFiles: vi.fn(() => []),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, config);

    const result = await scanner.scanAll();

    expect(result.failedPaths).toContain(".obsidian/plugins");
    expect(adapter.write).not.toHaveBeenCalled();
  });
});
