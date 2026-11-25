/**
 * Device-local snapshot of the last verified WebDAV sidecar identity ledger
 * (uuid → vault path). It exists only to recognize a cross-device move:
 *
 *   previous round: uuid -> old path
 *   current ledger: uuid -> new path
 *
 * The snapshot is scoped to one SyncScope and never authorizes a mutation by
 * itself; the executor cross-checks the current local/remote observations
 * before turning a change into a remote-identity relocation for the planner.
 */
import type { SyncScope } from "./types";

export interface IdentityLedgerSnapshotV1 {
  schemaVersion: 1;
  kind: "identity-ledger-snapshot";
  scope: SyncScope;
  /** uuid → vault-relative path. */
  entries: Record<string, string>;
  updatedAt: number;
}

export function createIdentityLedgerSnapshot(
  scope: SyncScope,
  entries: Record<string, string>,
  now = Date.now(),
): IdentityLedgerSnapshotV1 {
  return {
    schemaVersion: 1,
    kind: "identity-ledger-snapshot",
    scope: { ...scope },
    entries: { ...entries },
    updatedAt: now,
  };
}

export function readIdentityLedgerSnapshot(
  value: unknown,
): IdentityLedgerSnapshotV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "identity-ledger-snapshot"
    || !isRecord(value.scope)
    || !isRecord(value.entries)) {
    return null;
  }
  const entries: Record<string, string> = {};
  for (const [id, path] of Object.entries(value.entries)) {
    if (!/^[0-9a-f]{32}$/.test(id)) continue;
    if (typeof path !== "string" || !isVaultPath(path)) continue;
    entries[id] = path;
  }
  return {
    schemaVersion: 1,
    kind: "identity-ledger-snapshot",
    scope: value.scope as unknown as SyncScope,
    entries,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

function isVaultPath(path: string): boolean {
  return path.length > 0
    && path.length <= 1024
    && !path.startsWith("/")
    && !path.endsWith("/")
    && !path.includes("\\")
    && path.split("/").every((segment) =>
      segment.length > 0
      && segment !== "."
      && segment !== ".."
      && ![...segment].some((char) => char.charCodeAt(0) < 0x20));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
