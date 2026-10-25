import type {
  BaseFileEntry,
  RemoteFileEntry,
  RemoteFolderEntry,
  RemoteSyncState,
  SyncScope,
} from "./types";
import { sha256Hex } from "../crypto";

/**
 * Capability-free snapshot of the only supported legacy upgrade input.
 *
 * It deliberately contains values but no writer, Vault, Adapter, Graph or
 * executor capability. Callers may use it to build a V2 candidate and retain
 * the original backup, but cannot turn it into a V1 sync round.
 */
export interface Public113MigrationInput {
  kind: "public-1.1.3-read-only-input";
  sourceVersion: "1.1.3";
  lifecycleEpoch: number;
  pluginData: Readonly<Record<string, unknown>>;
  remoteState: RemoteSyncState | null;
  baseEntries: readonly BaseFileEntry[];
  baseContentEntries: Readonly<Record<string, string>>;
  baseContentRaw: string | null;
  baseContentStatus: "missing" | "valid" | "invalid" | "unreadable";
  remoteEntries: readonly RemoteFileEntry[];
  remoteFolders: readonly RemoteFolderEntry[];
  remoteScope: SyncScope | null;
  remoteDeltaLink: string | null;
}

export function createPublic113MigrationInput(input: {
  lifecycleEpoch: number;
  pluginData: Readonly<Record<string, unknown>>;
  remoteState: RemoteSyncState | null;
  baseEntries: readonly BaseFileEntry[];
  baseContentEntries?: Readonly<Record<string, string>>;
  baseContentRaw?: string | null;
  baseContentStatus?: Public113MigrationInput["baseContentStatus"];
}): Public113MigrationInput {
  const pluginData = structuredClone(input.pluginData);
  const remoteState = input.remoteState
    ? structuredClone(input.remoteState)
    : null;
  const baseEntries = structuredClone([...input.baseEntries]);
  const baseContentEntries = structuredClone(input.baseContentEntries ?? {});
  const baseContentStatus = input.baseContentStatus
    ?? (input.baseContentEntries ? "valid" : "missing");
  const baseContentRaw = input.baseContentRaw
    ?? (baseContentStatus === "valid"
      ? JSON.stringify(baseContentEntries)
      : null);
  return {
    kind: "public-1.1.3-read-only-input",
    sourceVersion: "1.1.3",
    lifecycleEpoch: input.lifecycleEpoch,
    pluginData,
    remoteState,
    baseEntries,
    baseContentEntries,
    baseContentRaw,
    baseContentStatus,
    remoteEntries: Object.values(remoteState?.entries ?? {}),
    remoteFolders: Object.values(remoteState?.folders ?? {}),
    remoteScope: remoteState?.scope ? { ...remoteState.scope } : null,
    remoteDeltaLink: remoteState?.deltaLink ?? null,
  };
}

export function createPublic113BackupSnapshot(
  input: Public113MigrationInput,
  sourceStateDigest?: string,
): {
  kind: "public-1.1.3-backup";
  sourceVersion: "1.1.3";
  sourceStateDigest?: string;
  pluginData: Readonly<Record<string, unknown>>;
  remoteState: RemoteSyncState | null;
  baseContentEntries: Readonly<Record<string, string>>;
  baseContentRaw: string | null;
  baseContentStatus: Public113MigrationInput["baseContentStatus"];
} {
  return {
    kind: "public-1.1.3-backup",
    sourceVersion: "1.1.3",
    ...(sourceStateDigest ? { sourceStateDigest } : {}),
    pluginData: structuredClone(input.pluginData),
    remoteState: input.remoteState
      ? structuredClone(input.remoteState)
      : null,
    baseContentEntries: structuredClone(input.baseContentEntries),
    baseContentRaw: input.baseContentRaw,
    baseContentStatus: input.baseContentStatus,
  };
}

/**
 * Bind a migration transaction to every persisted public-1.1.3 input value,
 * not only to the file/folder candidate derived from it.
 */
export async function public113MigrationInputDigest(
  input: Public113MigrationInput,
): Promise<string> {
  const canonical = canonicalJson({
    kind: input.kind,
    sourceVersion: input.sourceVersion,
    lifecycleEpoch: input.lifecycleEpoch,
    pluginData: input.pluginData,
    remoteState: input.remoteState,
    baseEntries: input.baseEntries,
    baseContentEntries: input.baseContentEntries,
    baseContentRaw: input.baseContentRaw,
    baseContentStatus: input.baseContentStatus,
  });
  return sha256Hex(new TextEncoder().encode(canonical).buffer);
}

/**
 * pluginData keys the plugin's own run loop rewrites on its own
 * between rounds, with zero migration semantics (none of them is read by the
 * cutover, the ledger takeover or the adoption paths). The V2 binding
 * masks only this set: every other persisted value — settings, unknown
 * future keys, all migration carriers — stays bound, so an unexpected
 * change to any of them still invalidates the reviewed authorization.
 * Suspending Android mounts force migration to span rounds, and binding
 * these keys made the authority guards fail on every round with the plan
 * itself unchanged (F31 third layer). Maintenance rule: a key that starts
 * carrying migration semantics must be removed from this set in the same
 * change. `easy-sync-transfer-rates-window` was retired on 2026-10-24 (no
 * writer remains); it stays masked here because existing stores still carry
 * the dead key on disk, and the mask is a harmless no-op for them.
 */
const PUBLIC_113_SELF_CHURNING_PLUGIN_DATA_KEYS = [
  "easy-sync-history",
  "easy-sync-last-sync-time",
  "easy-sync-transfer-rates-window",
  "auto-sync-paused",
] as const;

function runtimeStablePluginDataV2(
  pluginData: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const record = { ...pluginData } as Record<string, unknown>;
  for (const key of PUBLIC_113_SELF_CHURNING_PLUGIN_DATA_KEYS) {
    delete record[key];
  }
  return record;
}

/**
 * Round-stable binding: identical to the legacy digest except that the
 * self-churning bookkeeping keys are masked, so two rounds with unchanged
 * migration semantics produce the same digest even when that bookkeeping
 * churned in between. Settings and unknown keys remain bound.
 */
export async function public113MigrationInputDigestV2(
  input: Public113MigrationInput,
): Promise<string> {
  const canonical = canonicalJson({
    kind: input.kind,
    sourceVersion: input.sourceVersion,
    lifecycleEpoch: input.lifecycleEpoch,
    pluginData: runtimeStablePluginDataV2(input.pluginData),
    remoteState: input.remoteState,
    baseEntries: input.baseEntries,
    baseContentEntries: input.baseContentEntries,
    baseContentRaw: input.baseContentRaw,
    baseContentStatus: input.baseContentStatus,
  });
  return sha256Hex(new TextEncoder().encode(canonical).buffer);
}

/**
 * Record-vs-runtime comparison used by the authority guards: a recorded
 * digest matches either the semantic (V2) or the legacy (whole-pluginData)
 * digest of the runtime input — the latter keeps holds staged by an older
 * build verifiable across an upgrade.
 */
/**
 * Backup-snapshot comparison for the pre-manifest V1 backup: identical to a
 * plain snapshot comparison except that the bookkeeping is masked on both
 * sides. A stored backup snapshots its staging-time source, so a later
 * round's runtime source differs from it by bookkeeping alone whenever the
 * migration semantics are unchanged — and the backup must then stay
 * authoritative instead of triggering a delete-and-rewrite that suspended
 * Android mounts cannot complete (F31 fourth layer).
 */
export function public113BackupSnapshotSemanticallyMatches(
  storedSnapshot: unknown,
  currentSnapshot: unknown,
): boolean {
  const mask = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return sortJsonValue(value);
    }
    const record = { ...(value as Record<string, unknown>) };
    // The stage-time legacy digest and the legacy remote-state cache are
    // snapshot-level anchors, not migration semantics: the runtime digest
    // goes through the masked V2 definition and the runtime cache is owned
    // by the load/bootstrap path, so binding either side here makes the
    // guard fail on every cross-round authority commit once the record is
    // older than the current round.
    delete record.sourceStateDigest;
    delete record.remoteState;
    // Bookkeeping churn lives inside pluginData, not at snapshot top-level:
    // the first cut deleted these keys at top-level, where no snapshot ever
    // carries them, making the whole churn mask a no-op for the real
    // createPublic113BackupSnapshot shape (F31 sixth layer).
    const pluginData = record.pluginData;
    if (
      pluginData
      && typeof pluginData === 'object'
      && !Array.isArray(pluginData)
    ) {
      const maskedPluginData = {
        ...(pluginData as Record<string, unknown>),
      };
      for (const key of PUBLIC_113_SELF_CHURNING_PLUGIN_DATA_KEYS) {
        delete maskedPluginData[key];
      }
      record.pluginData = maskedPluginData;
    }
    return sortJsonValue(record);
  };
  return JSON.stringify(mask(storedSnapshot))
    === JSON.stringify(mask(currentSnapshot));
}

export async function public113MigrationInputDigestMatches(
  input: Public113MigrationInput,
  recorded: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(recorded)) return false;
  return recorded === await public113MigrationInputDigestV2(input)
    || recorded === await public113MigrationInputDigest(input);
}

export async function public113BackupSnapshotDigest(
  snapshot: unknown,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalJson(snapshot)).buffer,
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}
