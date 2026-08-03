import { describe, expect, it, vi } from "vitest";
import {
  INDEXED_DB_VAULT_INSTANCE_STORAGE_KEY,
  loadOrCreateIndexedDbVaultInstanceId,
  readIndexedDbVaultInstanceId,
  type VaultLocalStorage,
} from "../src/sync/indexeddb-vault-namespace";

function makeStorage(initial?: unknown): VaultLocalStorage {
  const values = new Map<string, unknown>();
  if (initial !== undefined) {
    values.set(INDEXED_DB_VAULT_INSTANCE_STORAGE_KEY, initial);
  }
  return {
    loadLocalStorage: vi.fn((key) => values.get(key) ?? null),
    saveLocalStorage: vi.fn((key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    }),
  };
}

describe("IndexedDB Vault namespace", () => {
  it("keeps one valid identity across reloads of the same Vault", () => {
    const storage = makeStorage();

    const first = loadOrCreateIndexedDbVaultInstanceId(storage);
    const second = loadOrCreateIndexedDbVaultInstanceId(storage);

    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(second).toBe(first);
    expect(storage.saveLocalStorage).toHaveBeenCalledOnce();
  });

  it("assigns distinct identities to independently registered Vaults", () => {
    const first = loadOrCreateIndexedDbVaultInstanceId(makeStorage());
    const second = loadOrCreateIndexedDbVaultInstanceId(makeStorage());

    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(second).toMatch(/^[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
  });

  it("fails closed when Vault-local storage cannot verify its write", () => {
    const storage: VaultLocalStorage = {
      loadLocalStorage: vi.fn(() => null),
      saveLocalStorage: vi.fn(),
    };

    expect(loadOrCreateIndexedDbVaultInstanceId(storage)).toBeNull();
  });

  it("reads only a currently valid Vault-local identity", () => {
    expect(readIndexedDbVaultInstanceId(makeStorage("1".repeat(32))))
      .toBe("1".repeat(32));
    expect(readIndexedDbVaultInstanceId(makeStorage("not-an-id")))
      .toBeNull();
  });
});
