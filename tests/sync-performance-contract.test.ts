import { describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import type { Vault } from "obsidian";
import { quickXorHashBase64, sha256Hex } from "../src/crypto";
import { OneDriveClient } from "../src/onedrive/client";
import { LocalScanner } from "../src/sync/local-scanner";
import type { ScanConfig } from "../src/sync/types";

const FILE_COUNT = 500;
const ROUNDS = 5;
const FILE_BYTES = 128;

const COLD_FILE_COUNT = 100;
const COLD_MIN_BYTES = 64 * 1024;
const COLD_MAX_BYTES = 256 * 1024;

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

/** Cold scan: no persisted scan cache, so every file goes through the full
 *  readBinary → SHA-256 + QuickXorHash path measured by D12. */
function makeColdScanner() {
  const contents = Array.from({ length: COLD_FILE_COUNT }, (_, index) => {
    const size =
      COLD_MIN_BYTES
      + ((index * 7919) % (COLD_MAX_BYTES - COLD_MIN_BYTES + 1));
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset++) {
      // Non-zero bytes keep the whole-file binary probe off the text path.
      bytes[offset] = ((index * 31 + offset * 17) & 0xff) || 1;
    }
    return bytes.buffer;
  });
  const files = contents.map((buffer, index) => ({
    path: `notes/cold-${index.toString().padStart(3, "0")}.md`,
    stat: { size: buffer.byteLength, mtime: 1000 + index },
  }));
  const contentByPath = new Map(
    files.map((file, index) => [file.path, contents[index]] as const),
  );
  const adapter = {
    read: vi.fn(async () => {
      throw new Error("scan cache missing");
    }),
    write: vi.fn(async () => undefined),
    stat: vi.fn(async (path: string) => {
      const file = files.find((candidate) => candidate.path === path);
      return file ? { ...file.stat } : null;
    }),
    readBinary: vi.fn(async (path: string) => {
      const content = contentByPath.get(path);
      if (!content) throw new Error(`missing ${path}`);
      return content;
    }),
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
  return { scanner: new LocalScanner(vault, config), adapter, files, contents };
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

  it("measures the A0-P cold full-content double-hash path", async () => {
      const { scanner, adapter, files, contents } = makeColdScanner();
      const expected = await Promise.all(contents.map(async (content) => ({
        hash: await sha256Hex(content),
        quickXorHash: quickXorHashBase64(content),
      })));

      const coldStartedAt = performance.now();
      const cold = await scanner.scanAll();
      const coldMs = performance.now() - coldStartedAt;

      const warmStartedAt = performance.now();
      const warm = await scanner.scanAll();
      const warmMs = performance.now() - warmStartedAt;

      expect(cold.complete).toBe(true);
      expect(warm.complete).toBe(true);
      expect(cold.entries).toHaveLength(COLD_FILE_COUNT);
      expect(warm.entries).toHaveLength(COLD_FILE_COUNT);
      for (const [index, entry] of cold.entries.entries()) {
        expect(entry.path).toBe(files[index].path);
        expect(entry.size).toBe(contents[index].byteLength);
        expect(entry.hash).toBe(expected[index].hash);
        expect(entry.quickXorHash).toBe(expected[index].quickXorHash);
      }
      // Exactly one full content read per file on the cold round; the second
      // round is served from the in-memory scan cache.
      expect(adapter.readBinary).toHaveBeenCalledTimes(COLD_FILE_COUNT);

      const totalBytes = contents.reduce(
        (sum, content) => sum + content.byteLength,
        0,
      );
      console.info("[a0p-performance]", JSON.stringify({
        schemaVersion: 1,
        mode: "cold-content-double-hash",
        files: COLD_FILE_COUNT,
        totalBytes,
        coldMs: Number(coldMs.toFixed(3)),
        warmMs: Number(warmMs.toFixed(3)),
        operations: {
          contentReads: COLD_FILE_COUNT,
          sha256: COLD_FILE_COUNT,
          quickXor: COLD_FILE_COUNT,
          cacheReads: 1,
          cacheWrites: 1,
        },
      }));
  });

  it("uses one Graph page for a valid single-page zero-change delta", async () => {
      const currentDelta =
        "https://graph.microsoft.com/v1.0/drives/drive-id/items/files-root-id/delta?token=current";
      const nextDelta =
        "https://graph.microsoft.com/v1.0/drives/drive-id/items/files-root-id/delta?token=next";
      const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [],
          "@odata.deltaLink": nextDelta,
        },
      });
      const client = new OneDriveClient(async () => "token");

      const result = await client.getDelta(
        "testVault",
        currentDelta,
      );

      expect(result.value).toEqual([]);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: "GET",
        url: currentDelta,
      }));
      requestSpy.mockRestore();
  });
});
