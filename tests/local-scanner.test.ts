import { describe, expect, it, vi } from "vitest";
import type { Vault } from "obsidian";
import { LocalScanner } from "../src/sync/local-scanner";
import type { ScanConfig } from "../src/sync/types";

const content = new TextEncoder().encode("test").buffer;

function makeScanner(includePluginCode: boolean, includePluginData: boolean) {
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
      ],
      folders: [
        ".obsidian/plugins/easy-sync/logs",
        ".obsidian/plugins/easy-sync/tmp",
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
  };

  const adapter = {
    list: vi.fn(async (path: string) => directories[path] ?? { files: [], folders: [] }),
    stat: vi.fn(async () => ({ size: content.byteLength, mtime: 1 })),
    readBinary: vi.fn(async () => content),
  };
  const vault = {
    adapter,
    getFiles: vi.fn(() => []),
  } as unknown as Vault;
  const config: ScanConfig = {
    excludePaths: [".obsidian/"],
    includePaths: [
      ".obsidian/plugins/easy-sync/",
      ".obsidian/plugins/",
      ".obsidian/plugins/",
    ],
    maxFileSize: 50 * 1024 * 1024,
    includePluginCode,
    includePluginData,
  };

  return { scanner: new LocalScanner(vault, config), adapter };
}

describe("LocalScanner plugin config paths", () => {
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
      ".obsidian/plugins/example-plugin/data.json",
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
  ])("keeps plugin code/data switches independent", async ({ code, data, expected }) => {
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
    expect(adapter.list).not.toHaveBeenCalledWith(".obsidian/plugins/example-plugin/runtime");
    expect(adapter.list).toHaveBeenCalledTimes(3);
  });

  it("exposes the same plugin path filter for remote snapshots", () => {
    const { scanner } = makeScanner(true, false);

    expect(scanner.shouldSyncPath(".obsidian/plugins/example-plugin/main.js")).toBe(true);
    expect(scanner.shouldSyncPath(".obsidian/plugins/example-plugin/runtime/cache.json")).toBe(false);
    expect(scanner.shouldSyncPath(".obsidian/plugins/example-plugin/data.json")).toBe(false);
    expect(scanner.shouldSyncPath(".obsidian/plugins/easy-sync/tmp/download.part")).toBe(false);
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

    await scanner.scanAll();
    await scanner.scanAll();

    expect(adapter.write).toHaveBeenCalledTimes(1);
  });
});
