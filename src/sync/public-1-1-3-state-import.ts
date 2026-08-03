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
