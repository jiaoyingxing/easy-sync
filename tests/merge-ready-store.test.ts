import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import { MergeReadyStore } from "../src/sync/merge-ready-store";

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function memoryAdapter() {
  const binary = new Map<string, ArrayBuffer>();
  const text = new Map<string, string>();
  return {
    binary,
    adapter: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn(async (path: string) => binary.has(path) || text.has(path)),
      writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
        binary.set(path, value.slice(0));
      }),
      readBinary: vi.fn(async (path: string) => {
        const value = binary.get(path);
        if (!value) throw new Error("missing");
        return value.slice(0);
      }),
      write: vi.fn(async (path: string, value: string) => {
        text.set(path, value);
      }),
      read: vi.fn(async (path: string) => {
        const value = text.get(path);
        if (value === undefined) throw new Error("missing");
        return value;
      }),
      remove: vi.fn(async (path: string) => {
        binary.delete(path);
        text.delete(path);
      }),
    },
  };
}

describe("MergeReadyStore", () => {
  it("stages exact merge bytes and only returns them to the matching operation", async () => {
    const { adapter } = memoryAdapter();
    const store = new MergeReadyStore(adapter as never, ".tmp");
    const payload = bytes("merged");
    const target = { hash: await sha256Hex(payload), size: payload.byteLength };

    await store.prepare("merge-1", payload, target);

    await expect(store.read("merge-1", target)).resolves.toEqual(payload);
    await expect(store.read("merge-2", target)).resolves.toBeNull();
    await store.complete("merge-1");
    await expect(store.read("merge-1", target)).resolves.toBeNull();
  });

  it("fails closed when staged bytes no longer match the target hash", async () => {
    const { adapter, binary } = memoryAdapter();
    const store = new MergeReadyStore(adapter as never, ".tmp");
    const payload = bytes("merged");
    const target = { hash: await sha256Hex(payload), size: payload.byteLength };
    await store.prepare("merge-1", payload, target);

    binary.set(store.payloadPath, bytes("tamper"));

    await expect(store.read("merge-1", target)).resolves.toBeNull();
  });
});
