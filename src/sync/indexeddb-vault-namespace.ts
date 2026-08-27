const VAULT_INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/;

export const INDEXED_DB_VAULT_INSTANCE_STORAGE_KEY =
  "easy-sync-indexeddb-vault-instance-v1";

export interface VaultLocalStorage {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

/**
 * Resolve an origin-local identity for this Obsidian Vault registration.
 *
 * App local storage is deliberately outside the Vault filesystem. Copying a
 * Vault therefore does not copy this identity into another same-origin Vault,
 * while ordinary plugin reloads keep it stable.
 */
export function loadOrCreateIndexedDbVaultInstanceId(
  storage: VaultLocalStorage,
): string | null {
  try {
    const existing = readIndexedDbVaultInstanceId(storage);
    if (existing) return existing;

    const created = createIndexedDbVaultInstanceId();
    storage.saveLocalStorage(
      INDEXED_DB_VAULT_INSTANCE_STORAGE_KEY,
      created,
    );
    return readIndexedDbVaultInstanceId(storage) === created
      ? created
      : null;
  } catch {
    return null;
  }
}

export function readIndexedDbVaultInstanceId(
  storage: VaultLocalStorage,
): string | null {
  try {
    const value = storage.loadLocalStorage(
      INDEXED_DB_VAULT_INSTANCE_STORAGE_KEY,
    );
    return isIndexedDbVaultInstanceId(value) ? value : null;
  } catch {
    return null;
  }
}

export function isIndexedDbVaultInstanceId(
  value: unknown,
): value is string {
  return typeof value === "string" && VAULT_INSTANCE_ID_PATTERN.test(value);
}

export function createIndexedDbVaultInstanceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
