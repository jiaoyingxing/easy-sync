import type { OneDriveClient } from "../onedrive/client";
import { isRecord } from "../obsidian-compat";
import {
  isSyncScope,
  sameSyncScope,
  type SyncScope,
} from "./types";

export const SYNC_PROTOCOL_V2_VERSION = 2;

export interface SharedSyncProtocolV2 {
  schemaVersion: 1;
  kind: "easy-sync-v2-protocol";
  protocolVersion: typeof SYNC_PROTOCOL_V2_VERSION;
  migrationGeneration: string;
  scope: SyncScope;
  /**
   * Immutable protocol-v2 compatibility field.
   *
   * Despite its original name, this records only the creating device's
   * local migration-risk acknowledgement. It is not evidence that every
   * device has been discovered or updated.
   */
  confirmedAllDevicesUpdatedAt: number;
  createdAt: number;
}

export interface SharedSyncProtocolObjectV2 {
  id: string;
  eTag: string;
  content: string;
}

export interface SharedSyncProtocolTransportV2 {
  read(): Promise<SharedSyncProtocolObjectV2 | null>;
  createOnly(content: string): Promise<{ id: string; eTag: string }>;
  readById(id: string): Promise<SharedSyncProtocolObjectV2>;
}

/**
 * Device-local proof that this authority joined one immutable shared
 * migration generation. It is control-plane provenance only: no file,
 * directory, cursor, anchor or mutation may be derived from it.
 */
export interface SharedSyncProtocolBindingV2 {
  schemaVersion: 1;
  protocolVersion: typeof SYNC_PROTOCOL_V2_VERSION;
  migrationGeneration: string;
  /** See SharedSyncProtocolV2.confirmedAllDevicesUpdatedAt. */
  confirmedAllDevicesUpdatedAt: number;
  recordId: string;
  recordETag: string;
}

export type EnsureSharedSyncProtocolResultV2 =
  | {
    status: "ready";
    source: "existing" | "created" | "create-race";
    protocol: SharedSyncProtocolV2;
    binding: SharedSyncProtocolBindingV2;
  }
  | { status: "acknowledgement-required" }
  | {
    status: "blocked";
    reason:
      | "read-failed"
      | "invalid-current"
      | "unsupported-protocol"
      | "scope-mismatch"
      | "generation-mismatch"
      | "write-failed"
      | "readback-mismatch";
  };

export function createOneDriveSharedSyncProtocolTransportV2(
  client: OneDriveClient,
  vaultName: string,
): SharedSyncProtocolTransportV2 {
  return {
    read: () => client.readSharedSyncProtocolV2(vaultName),
    createOnly: (content) =>
      client.createSharedSyncProtocolV2(vaultName, content),
    readById: (id) => client.readSharedSyncProtocolV2ById(id),
  };
}

/**
 * Join or create the shared V2 migration generation.
 *
 * A missing record may be created only after the current device explicitly
 * acknowledges the migration risk. The persisted compatibility timestamp
 * does not attest to the state of other devices.
 * The record is immutable: create races are resolved by rereading and
 * adopting the compatible winner, never by overwriting it.
 */
export async function ensureSharedSyncProtocolV2(
  transport: SharedSyncProtocolTransportV2,
  input: {
    scope: SyncScope;
    acknowledgeMigrationRisk: boolean;
    now?: number;
    createMigrationGeneration?: () => string;
    expectedBinding?: SharedSyncProtocolBindingV2;
  },
): Promise<EnsureSharedSyncProtocolResultV2> {
  if (
    input.expectedBinding !== undefined
    && !isSharedSyncProtocolBindingV2(input.expectedBinding)
  ) {
    return { status: "blocked", reason: "generation-mismatch" };
  }
  let current: SharedSyncProtocolObjectV2 | null;
  try {
    current = await transport.read();
  } catch {
    return { status: "blocked", reason: "read-failed" };
  }
  if (current) {
    return inspectProtocolObject(
      current,
      input.scope,
      "existing",
      input.expectedBinding,
    );
  }
  if (!input.acknowledgeMigrationRisk && !input.expectedBinding) {
    return { status: "acknowledgement-required" };
  }

  const now = input.now ?? Date.now();
  const protocol: SharedSyncProtocolV2 = {
    schemaVersion: 1,
    kind: "easy-sync-v2-protocol",
    protocolVersion: SYNC_PROTOCOL_V2_VERSION,
    migrationGeneration: input.expectedBinding?.migrationGeneration
      ?? (input.createMigrationGeneration ?? createMigrationGenerationV2)(),
    scope: { ...input.scope },
    confirmedAllDevicesUpdatedAt:
      input.expectedBinding?.confirmedAllDevicesUpdatedAt ?? now,
    createdAt: now,
  };
  if (!isSharedSyncProtocolV2(protocol)) {
    return { status: "blocked", reason: "write-failed" };
  }
  const content = JSON.stringify(protocol);

  let created: { id: string; eTag: string };
  try {
    created = await transport.createOnly(content);
  } catch {
    // A create-only conflict or an outcome-unknown response may still mean
    // another device won the race. Only a compatible reread is acceptable.
    try {
      const raced = await transport.read();
      if (raced) {
        return inspectProtocolObject(
          raced,
          input.scope,
          "create-race",
          input.expectedBinding,
        );
      }
    } catch {
      // Preserve the original conservative write-failed classification.
    }
    return { status: "blocked", reason: "write-failed" };
  }

  let verified: SharedSyncProtocolObjectV2;
  try {
    verified = await transport.readById(created.id);
  } catch {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  if (verified.id !== created.id || verified.content !== content) {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  return readyResult(verified, protocol, "created");
}

export function parseSharedSyncProtocolV2(
  content: string,
): SharedSyncProtocolV2 | null {
  try {
    const value: unknown = JSON.parse(content);
    return isSharedSyncProtocolV2(value) ? value : null;
  } catch {
    return null;
  }
}

export function isSharedSyncProtocolBindingV2(
  value: unknown,
): value is SharedSyncProtocolBindingV2 {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.protocolVersion === SYNC_PROTOCOL_V2_VERSION
    && isMigrationGeneration(value.migrationGeneration)
    && Number.isFinite(value.confirmedAllDevicesUpdatedAt)
    && Number(value.confirmedAllDevicesUpdatedAt) >= 0
    && typeof value.recordId === "string"
    && value.recordId.length > 0
    && typeof value.recordETag === "string"
    && value.recordETag.length > 0;
}

export function createMigrationGenerationV2(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function inspectProtocolObject(
  object: SharedSyncProtocolObjectV2,
  expectedScope: SyncScope,
  source: "existing" | "create-race",
  expectedBinding?: SharedSyncProtocolBindingV2,
): EnsureSharedSyncProtocolResultV2 {
  let value: unknown;
  try {
    value = JSON.parse(object.content);
  } catch {
    return { status: "blocked", reason: "invalid-current" };
  }
  if (
    isRecord(value)
    && (
      value.kind !== "easy-sync-v2-protocol"
      || value.schemaVersion !== 1
      || value.protocolVersion !== SYNC_PROTOCOL_V2_VERSION
    )
  ) {
    return { status: "blocked", reason: "unsupported-protocol" };
  }
  if (!isSharedSyncProtocolV2(value)) {
    return { status: "blocked", reason: "invalid-current" };
  }
  if (!sameSyncScope(value.scope, expectedScope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  if (
    expectedBinding
    && value.migrationGeneration
      !== expectedBinding.migrationGeneration
  ) {
    return { status: "blocked", reason: "generation-mismatch" };
  }
  return readyResult(object, value, source);
}

function readyResult(
  object: SharedSyncProtocolObjectV2,
  protocol: SharedSyncProtocolV2,
  source: "existing" | "created" | "create-race",
): Extract<EnsureSharedSyncProtocolResultV2, { status: "ready" }> {
  if (
    typeof object.id !== "string"
    || object.id.length === 0
    || typeof object.eTag !== "string"
    || object.eTag.length === 0
  ) {
    throw new Error("Shared V2 sync protocol object identity is incomplete");
  }
  return {
    status: "ready",
    source,
    protocol: structuredClone(protocol),
    binding: {
      schemaVersion: 1,
      protocolVersion: SYNC_PROTOCOL_V2_VERSION,
      migrationGeneration: protocol.migrationGeneration,
      confirmedAllDevicesUpdatedAt:
        protocol.confirmedAllDevicesUpdatedAt,
      recordId: object.id,
      recordETag: object.eTag,
    },
  };
}

function isSharedSyncProtocolV2(
  value: unknown,
): value is SharedSyncProtocolV2 {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === "easy-sync-v2-protocol"
    && value.protocolVersion === SYNC_PROTOCOL_V2_VERSION
    && isMigrationGeneration(value.migrationGeneration)
    && isSyncScope(value.scope)
    && Number.isFinite(value.confirmedAllDevicesUpdatedAt)
    && Number(value.confirmedAllDevicesUpdatedAt) >= 0
    && Number.isFinite(value.createdAt)
    && Number(value.createdAt) >= 0
    && Number(value.confirmedAllDevicesUpdatedAt) <= Number(value.createdAt);
}

function isMigrationGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
