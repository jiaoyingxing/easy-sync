import { describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import type { Vault } from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";
import { LocalScanner } from "../src/sync/local-scanner";
import type { ScanConfig } from "../src/sync/types";

const FILE_COUNT = 500;
const ROUNDS = 5;
const FILE_BYTES = 128;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function makeWarmScanner() {
  const files = Array.from({ length: FILE_COUNT }, (_, index) => ({
    path: `notes/note-${index.toString().padStart(3, "0")}.md`,
    stat: { size: FILE_BYTES, mtime: 1 },
  }));
  const entries = Object.fromEntries(files.map((file) => [file.path, {
    mtime: file.stat.mtime,
    size: file.stat.size,
    hash: "aa".repeat(32),
    binary: false,
  }]));
  const adapter = {
    read: vi.fn(async () => JSON.stringify({ format: 1, entries })),
    write: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ size: FILE_BYTES, mtime: 1 })),
    readBinary: vi.fn(async () => new ArrayBuffer(FILE_BYTES)),
    list: vi.fn(async () => ({ files: [], folders: [] })),
  };
  const vault = {
    adapter,
    getFiles: vi.fn(() => files),
  } as unknown as Vault;
  const config: ScanConfig = {
    excludePaths: [],
    includePaths: [],
    maxFileSize: 500 * 1024 * 1024,
    includePluginCode: false,
    includePluginData: false,
  };
  return { scanner: new LocalScanner(vault, config), adapter, vault };
}

describe("A0-P zero-change performance contract", () => {
  it("keeps the platform-neutral 500-file warm scan metadata-only", async () => {
      const { scanner, adapter, vault } = makeWarmScanner();
      const elapsedMs: number[] = [];

      for (let round = 0; round < ROUNDS; round++) {
        const startedAt = performance.now();
        const result = await scanner.scanAll();
        elapsedMs.push(performance.now() - startedAt);
        expect(result.complete).toBe(true);
        expect(result.entries).toHaveLength(FILE_COUNT);
      }

      expect(vault.getFiles).toHaveBeenCalledTimes(ROUNDS);
      expect(adapter.stat).not.toHaveBeenCalled();
      expect(adapter.readBinary).not.toHaveBeenCalled();
      expect(adapter.write).not.toHaveBeenCalled();
      expect(adapter.read).toHaveBeenCalledTimes(1);

      console.info("[a0p-performance]", JSON.stringify({
        schemaVersion: 1,
        mode: "platform-neutral",
        files: FILE_COUNT,
        rounds: ROUNDS,
        medianMs: Number(median(elapsedMs).toFixed(3)),
        elapsedMs: elapsedMs.map((value) => Number(value.toFixed(3))),
        operations: {
          getFiles: ROUNDS,
          cacheReads: 1,
          adapterStat: 0,
          contentReads: 0,
          cacheWrites: 0,
        },
      }));
  });

  it("uses one Graph page for a valid single-page zero-change delta", async () => {
      const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [],
          "@odata.deltaLink": "https://graph.example/delta-next",
        },
      });
      const client = new OneDriveClient(async () => "token");

      const result = await client.getDelta(
        "testVault",
        "https://graph.example/delta-current",
      );

      expect(result.value).toEqual([]);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: "GET",
        url: "https://graph.example/delta-current",
      }));
      requestSpy.mockRestore();
  });
});
