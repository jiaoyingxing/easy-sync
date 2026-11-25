import { describe, expect, it, vi } from "vitest";
import {
  resolveLanServeFile,
  type LanServeGateDeps,
  type LanServeOutcome,
} from "../src/sync/lan-serve-gate";
import type { LanContentHint } from "../src/sync/lan-content-source";
import type { LocalFileInspection } from "../src/sync/local-scanner";

/** Compile-time inventory of the shared gate contract. */
type LanServeGateContractTypes = [LanServeGateDeps, LanServeOutcome];

const HASH = "ab".repeat(32);
const BYTES = new TextEncoder().encode("payload").buffer;

function deps(overrides: Partial<LanServeGateDeps> = {}): LanServeGateDeps {
  return {
    isReady: () => true,
    getBaseEntry: () => ({ path: "note.bin", hash: HASH, size: 7, eTag: "etag-1" }),
    shouldSyncPath: () => true,
    inspectFile: async () => ({
      status: "present",
      entry: {
        path: "note.bin",
        size: 7,
        mtime: 0,
        hash: HASH,
        quickXorHash: "q",
        binary: true,
      },
    } as LocalFileInspection),
    readRemoteETag: async () => "etag-1",
    readLocalBytes: async () => BYTES,
    hashBytes: async () => HASH,
    ...overrides,
  };
}

const REQUEST = { path: "note.bin", eTag: "etag-1", size: 7 };

describe("shared LAN serve gate", () => {
  it("keeps the gate contract reachable by the automatic and dev callers", () => {
    const inventory: LanServeGateContractTypes = [
      deps(),
      { error: "no" } as LanServeOutcome,
    ];
    const hint: LanContentHint = { path: "note.bin", eTag: "etag-1", size: 7 };
    expect(inventory).toHaveLength(2);
    expect(hint.size).toBe(REQUEST.size);
  });

  it("serves only when all six checks pass and attests the base hash", async () => {
    const result = await resolveLanServeFile(deps(), REQUEST);
    expect(result).toEqual({ bytes: BYTES, sha256: HASH });
  });

  it("refuses each failing check with its stable reason", async () => {
    const cases: Array<[Partial<LanServeGateDeps>, string]> = [
      [{ isReady: () => false }, "sync state is not ready"],
      [{ getBaseEntry: () => undefined }, "file has no synced base entry"],
      [{ getBaseEntry: () => ({ path: "note.bin", hash: HASH, size: 7, eTag: "old" }) },
        "cloud version does not match the base receipt"],
      [{ getBaseEntry: () => ({ path: "note.bin", hash: HASH, size: 8, eTag: "etag-1" }) },
        "size does not match the base receipt"],
      [{ shouldSyncPath: () => false }, "path is outside the sync scope"],
      [{ inspectFile: async () => ({ status: "missing" }) }, "local file is not available"],
      [{
        inspectFile: async () => ({
          status: "present",
          entry: {
            path: "note.bin",
            size: 7,
            mtime: 0,
            hash: "cd".repeat(32),
            quickXorHash: "q",
            binary: true,
          },
        } as LocalFileInspection),
      }, "local file changed since the last sync"],
      [{ readRemoteETag: async () => null }, "cloud version changed"],
      [{ readRemoteETag: async () => "etag-2" }, "cloud version changed"],
      [{ hashBytes: async () => "ef".repeat(32) }, "local file changed while it was read"],
    ];

    for (const [override, error] of cases) {
      expect(await resolveLanServeFile(deps(override), REQUEST)).toEqual({ error });
    }
  });

  it("checks the cloud version before reading bytes and the hash before serving", async () => {
    const readLocalBytes = vi.fn(async () => BYTES);
    const readRemoteETag = vi.fn(async () => "etag-1");
    await resolveLanServeFile(deps({ readLocalBytes, readRemoteETag }), REQUEST);
    expect(readRemoteETag).toHaveBeenCalledOnce();
    expect(readLocalBytes).toHaveBeenCalledOnce();

    const blockedRead = vi.fn(async () => BYTES);
    expect(await resolveLanServeFile(deps({
      readRemoteETag: async () => "etag-2",
      readLocalBytes: blockedRead,
    }), REQUEST)).toEqual({ error: "cloud version changed" });
    expect(blockedRead).not.toHaveBeenCalled();
  });

  it("does not read bytes when a pre-read check fails", async () => {
    const readLocalBytes = vi.fn(async () => BYTES);
    expect(await resolveLanServeFile(deps({
      shouldSyncPath: () => false,
      readLocalBytes,
    }), REQUEST)).toEqual({ error: "path is outside the sync scope" });
    expect(readLocalBytes).not.toHaveBeenCalled();
  });
});
