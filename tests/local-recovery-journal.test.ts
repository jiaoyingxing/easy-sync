import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../src/crypto";
import { LocalRecoveryJournal } from "../src/sync/local-recovery-journal";
import { isEasySyncInternalPath } from "../src/sync/local-scanner";
import type { LocalFileEntry } from "../src/sync/types";

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function cloneBuffer(value: ArrayBuffer): ArrayBuffer {
  return value.slice(0);
}

function makeMemoryAdapter(initial: Record<string, ArrayBuffer | string> = {}) {
  const files = new Map<string, ArrayBuffer | string>(Object.entries(initial));
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (typeof value !== "string") throw new Error(`Text file missing: ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
    readBinary: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (!(value instanceof ArrayBuffer)) throw new Error(`Binary file missing: ${path}`);
      return cloneBuffer(value);
    }),
    writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
      files.set(path, cloneBuffer(value));
    }),
    stat: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) return null;
      return { type: "file", size: typeof value === "string" ? value.length : value.byteLength, mtime: 1, ctime: 1 };
    }),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`Rename source missing: ${from}`);
      files.set(to, value);
      files.delete(from);
    }),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
  return { adapter: adapter as unknown as DataAdapter, files, spies: adapter };
}

async function entry(path: string, content: ArrayBuffer): Promise<LocalFileEntry> {
  return {
    path,
    size: content.byteLength,
    mtime: 1,
    hash: await sha256Hex(content),
    binary: false,
  };
}

describe("S03 — state-neutral local recovery journal", () => {
  it("restores the reviewed local version after an interrupted replacement", async () => {
    const path = "note.md";
    const oldContent = bytes(1, 2, 3);
    const downloaded = bytes(4, 5, 6);
    const recoveryPath = `${path}.easy-sync-recovery`;
    const { adapter, files } = makeMemoryAdapter({ [path]: oldContent });
    const journal = new LocalRecoveryJournal(adapter, ".obsidian/plugins/easy-sync/tmp");

    await journal.prepareRenamedOriginal(path, await entry(path, oldContent), recoveryPath, {
      hash: await sha256Hex(downloaded),
      size: downloaded.byteLength,
    });
    await adapter.rename(path, recoveryPath);
    await adapter.writeBinary(path, downloaded);

    const outcome = await new LocalRecoveryJournal(adapter, ".obsidian/plugins/easy-sync/tmp").recover();

    expect(outcome).toBe("restored");
    expect(new Uint8Array(files.get(path) as ArrayBuffer)).toEqual(new Uint8Array(oldContent));
    expect(files.has(journal.intentPath)).toBe(false);
    expect(files.has(recoveryPath)).toBe(false);
  });

  it("preserves a third local version written after the interruption", async () => {
    const path = "note.md";
    const oldContent = bytes(1);
    const downloaded = bytes(2);
    const newer = bytes(3);
    const recoveryPath = `${path}.easy-sync-recovery`;
    const { adapter, files } = makeMemoryAdapter({ [path]: oldContent });
    const journal = new LocalRecoveryJournal(adapter, ".obsidian/plugins/easy-sync/tmp");

    await journal.prepareRenamedOriginal(path, await entry(path, oldContent), recoveryPath, {
      hash: await sha256Hex(downloaded),
      size: downloaded.byteLength,
    });
    await adapter.rename(path, recoveryPath);
    await adapter.writeBinary(path, downloaded);
    await adapter.writeBinary(path, newer);

    expect(await journal.recover()).toBe("preserved-newer");
    expect(new Uint8Array(files.get(path) as ArrayBuffer)).toEqual(new Uint8Array(newer));
  });

  it("keeps the intent and fails closed when the recovery copy cannot be read", async () => {
    const path = "note.md";
    const oldContent = bytes(1);
    const downloaded = bytes(2);
    const recoveryPath = `${path}.easy-sync-recovery`;
    const { adapter, files, spies } = makeMemoryAdapter({ [path]: oldContent });
    const journal = new LocalRecoveryJournal(adapter, ".obsidian/plugins/easy-sync/tmp");

    await journal.prepareRenamedOriginal(path, await entry(path, oldContent), recoveryPath, {
      hash: await sha256Hex(downloaded),
      size: downloaded.byteLength,
    });
    await adapter.rename(path, recoveryPath);
    await adapter.writeBinary(path, downloaded);
    const originalReadBinary = spies.readBinary.getMockImplementation()!;
    spies.readBinary.mockImplementation(async (candidate: string) => {
      if (candidate === recoveryPath) throw new Error("disk unavailable");
      return originalReadBinary(candidate);
    });

    await expect(journal.recover()).rejects.toThrow("disk unavailable");
    expect(files.has(journal.intentPath)).toBe(true);
  });

  it("stores no baseline, remote cursor, or manifest state and reserves recovery artifacts", async () => {
    const path = "note.md";
    const downloaded = bytes(9);
    const { adapter, files } = makeMemoryAdapter();
    const journal = new LocalRecoveryJournal(adapter, ".obsidian/plugins/easy-sync/tmp");

    await journal.prepareRenamedOriginal(path, undefined, `${path}.easy-sync-recovery`, {
      hash: await sha256Hex(downloaded),
      size: downloaded.byteLength,
    });
    const raw = files.get(journal.intentPath) as string;

    expect(raw).not.toMatch(/baseline|delta|etag|manifest/i);
    expect(isEasySyncInternalPath(`${path}.easy-sync-recovery`)).toBe(true);
  });
});
