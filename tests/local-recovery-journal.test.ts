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

  it("rolls back a partially written plugin bundle as one recovery unit", async () => {
    const root = ".obsidian/plugins/resojot";
    const mainPath = `${root}/main.js`;
    const manifestPath = `${root}/manifest.json`;
    const stylesPath = `${root}/styles.css`;
    const oldMain = bytes(1);
    const oldManifest = bytes(2);
    const newMain = bytes(3);
    const newManifest = bytes(4);
    const newStyles = bytes(5);
    const { adapter, files } = makeMemoryAdapter({
      [mainPath]: oldMain,
      [manifestPath]: oldManifest,
    });
    const journal = new LocalRecoveryJournal(
      adapter,
      ".obsidian/plugins/easy-sync/tmp",
    );

    await journal.prepareCopiedBundleOriginals([
      {
        targetPath: mainPath,
        expected: await entry(mainPath, oldMain),
        original: oldMain,
        downloaded: { hash: await sha256Hex(newMain), size: newMain.byteLength },
      },
      {
        targetPath: stylesPath,
        expected: undefined,
        original: null,
        downloaded: { hash: await sha256Hex(newStyles), size: newStyles.byteLength },
      },
      {
        targetPath: manifestPath,
        expected: await entry(manifestPath, oldManifest),
        original: oldManifest,
        downloaded: { hash: await sha256Hex(newManifest), size: newManifest.byteLength },
      },
    ]);
    await adapter.writeBinary(mainPath, newMain);
    await adapter.writeBinary(stylesPath, newStyles);

    expect(await journal.recover()).toBe("restored");
    expect(new Uint8Array(files.get(mainPath) as ArrayBuffer))
      .toEqual(new Uint8Array(oldMain));
    expect(new Uint8Array(files.get(manifestPath) as ArrayBuffer))
      .toEqual(new Uint8Array(oldManifest));
    expect(files.has(stylesPath)).toBe(false);
    expect(files.has(journal.intentPath)).toBe(false);
  });

  it("preserves a third bundle member version while rolling back the others", async () => {
    const root = ".obsidian/plugins/resojot";
    const mainPath = `${root}/main.js`;
    const manifestPath = `${root}/manifest.json`;
    const oldMain = bytes(1);
    const oldManifest = bytes(2);
    const newMain = bytes(3);
    const newManifest = bytes(4);
    const userManifest = bytes(9);
    const { adapter, files } = makeMemoryAdapter({
      [mainPath]: oldMain,
      [manifestPath]: oldManifest,
    });
    const journal = new LocalRecoveryJournal(
      adapter,
      ".obsidian/plugins/easy-sync/tmp",
    );

    await journal.prepareCopiedBundleOriginals([
      {
        targetPath: mainPath,
        expected: await entry(mainPath, oldMain),
        original: oldMain,
        downloaded: { hash: await sha256Hex(newMain), size: newMain.byteLength },
      },
      {
        targetPath: manifestPath,
        expected: await entry(manifestPath, oldManifest),
        original: oldManifest,
        downloaded: {
          hash: await sha256Hex(newManifest),
          size: newManifest.byteLength,
        },
      },
    ]);
    await adapter.writeBinary(mainPath, newMain);
    await adapter.writeBinary(manifestPath, newManifest);
    await adapter.writeBinary(manifestPath, userManifest);

    expect(await journal.recover()).toBe("preserved-newer");
    expect(new Uint8Array(files.get(mainPath) as ArrayBuffer))
      .toEqual(new Uint8Array(oldMain));
    expect(new Uint8Array(files.get(manifestPath) as ArrayBuffer))
      .toEqual(new Uint8Array(userManifest));
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

  it("writeIntent uses .next staging then renames to the canonical path", async () => {
    const downloaded = bytes(9);
    const { adapter, files, spies } = makeMemoryAdapter();
    const journal = new LocalRecoveryJournal(adapter, ".obsidian/plugins/easy-sync/tmp");
    const nextPath = `${journal.intentPath}.next`;

    await journal.prepareRenamedOriginal("note.md", undefined, "note.md.easy-sync-recovery", {
      hash: await sha256Hex(downloaded),
      size: downloaded.byteLength,
    });

    // After successful staging: .json exists, .next is gone (renamed).
    expect(typeof files.get(journal.intentPath)).toBe("string");
    expect(files.has(nextPath)).toBe(false);
    expect(spies.rename).toHaveBeenCalledWith(nextPath, journal.intentPath);
  });

  it("readIntent recovers an orphaned .next file after a crash before rename", async () => {
    const downloaded = bytes(9);
    const { adapter, files } = makeMemoryAdapter();
    const journal = new LocalRecoveryJournal(adapter, ".obsidian/plugins/easy-sync/tmp");
    const nextPath = `${journal.intentPath}.next`;

    // Simulate crash: write .next but never rename to .json
    files.set(nextPath, JSON.stringify({
      version: 1,
      targetPath: "note.md",
      recoveryPath: "note.md.easy-sync-recovery",
      recoveryMode: "rename" as const,
      expected: null,
      downloaded: { hash: await sha256Hex(downloaded), size: downloaded.byteLength },
      createdAt: Date.now(),
    }));

    // readIntent must recover the orphan .next → .json, then recover()
    // runs normally (writes target file, restores, cleans up intent).
    const recovered = await new LocalRecoveryJournal(adapter, ".obsidian/plugins/easy-sync/tmp")
      .recover();
    expect(recovered).toBe("restored");
    // Both .next and .json cleaned up after successful recovery
    expect(files.has(nextPath)).toBe(false);
    expect(files.has(journal.intentPath)).toBe(false);
  });

  it("writeIntent falls back to direct write when rename throws", async () => {
    const downloaded = bytes(9);
    const { adapter, files } = makeMemoryAdapter();
    const brokenRename = vi.fn(async () => { throw new Error("rename unsupported"); });
    const hybridAdapter = {
      ...adapter,
      rename: brokenRename,
    } as unknown as DataAdapter;
    const journal = new LocalRecoveryJournal(hybridAdapter, ".obsidian/plugins/easy-sync/tmp");

    await journal.prepareRenamedOriginal("note.md", undefined, "note.md.easy-sync-recovery", {
      hash: await sha256Hex(downloaded),
      size: downloaded.byteLength,
    });

    // Fallback: .json must exist with correct content despite rename throwing.
    expect(brokenRename).toHaveBeenCalled();
    expect(typeof files.get(journal.intentPath)).toBe("string");
  });

  it("cleanupOrphanCopies removes an orphaned copy when its target still exists", async () => {
    const recoveryPath = "assets/photo.png.easy-sync-recovery";
    const { adapter, files } = makeMemoryAdapter({
      "assets/photo.png": bytes(9, 8, 7),
      [recoveryPath]: bytes(1, 2, 3),
    });
    const journal = new LocalRecoveryJournal(
      adapter,
      ".obsidian/plugins/easy-sync/tmp",
    );

    const summary = await journal.cleanupOrphanCopies([recoveryPath]);

    expect(summary).toEqual({
      removed: 1,
      retained: 0,
      removedPaths: [recoveryPath],
    });
    expect(files.has(recoveryPath)).toBe(false);
    expect(files.has("assets/photo.png")).toBe(true);
  });

  it("cleanupOrphanCopies retains an orphaned copy when its target is missing", async () => {
    const recoveryPath = "assets/photo.png.easy-sync-recovery";
    const { adapter, files } = makeMemoryAdapter({ [recoveryPath]: bytes(1, 2) });
    const journal = new LocalRecoveryJournal(
      adapter,
      ".obsidian/plugins/easy-sync/tmp",
    );

    const summary = await journal.cleanupOrphanCopies([recoveryPath]);

    expect(summary).toEqual({ removed: 0, retained: 1, removedPaths: [] });
    expect(files.has(recoveryPath)).toBe(true);
  });

  it("cleanupOrphanCopies never touches copies while a recovery intent is pending", async () => {
    const path = "note.md";
    const oldContent = bytes(1, 2, 3);
    const recoveryPath = `${path}.easy-sync-recovery`;
    const { adapter, files } = makeMemoryAdapter({ [path]: oldContent });
    const journal = new LocalRecoveryJournal(
      adapter,
      ".obsidian/plugins/easy-sync/tmp",
    );

    await journal.prepareRenamedOriginal(path, await entry(path, oldContent), recoveryPath, {
      hash: "aa".repeat(32),
      size: 3,
    });
    await adapter.rename(path, recoveryPath);

    const summary = await journal.cleanupOrphanCopies([recoveryPath]);

    expect(summary).toEqual({ removed: 0, retained: 1, removedPaths: [] });
    expect(files.has(recoveryPath)).toBe(true);
    expect(files.has(journal.intentPath)).toBe(true);
  });

  it("cleanupOrphanCopies is idempotent for empty and already-cleared lists", async () => {
    const { adapter, files } = makeMemoryAdapter();
    const journal = new LocalRecoveryJournal(
      adapter,
      ".obsidian/plugins/easy-sync/tmp",
    );

    expect(await journal.cleanupOrphanCopies([]))
      .toEqual({ removed: 0, retained: 0, removedPaths: [] });
    expect(await journal.cleanupOrphanCopies(["a.md.easy-sync-recovery"]))
      .toEqual({ removed: 0, retained: 0, removedPaths: [] });
    expect(files.size).toBe(0);
  });
});
