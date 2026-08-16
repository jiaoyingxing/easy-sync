import { sha256Hex } from "../crypto";
import type { OneDriveClient } from "../onedrive/client";
import { isRecord } from "../obsidian-compat";
import {
  isSyncScope,
  sameSyncScope,
  type SyncScope,
} from "./types";
import { rethrowTerminalSharedSyncProtocolTransportError } from "./shared-sync-protocol-transport";

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

export type SharedSyncProtocolMutationTransportV2 = Pick<
  SharedSyncProtocolTransportV2,
  "createOnly" | "readById"
>;

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
      | "invalid-current"
      | "unsupported-protocol"
      | "scope-mismatch"
      | "generation-mismatch"
      | "binding-mismatch"
      | "write-failed"
      | "readback-mismatch";
  };

export type EnsureCanonicalSharedSyncProtocolResultV2 =
  | {
    status: "ready";
    source: "existing" | "created" | "create-race";
    object: SharedSyncProtocolObjectV2;
    protocol: SharedSyncProtocolV2;
  }
  | {
    status: "blocked";
    reason:
      | "invalid-canonical"
      | "canonical-proof-mismatch"
      | "target-slot-occupied"
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
  transport: SharedSyncProtocolMutationTransportV2,
  input: {
    scope: SyncScope;
    acknowledgeMigrationRisk: boolean;
    observedCurrent: SharedSyncProtocolObjectV2 | null;
    observeAfterCreateFailure: () => Promise<
      SharedSyncProtocolObjectV2 | null
    >;
    now?: number;
    createMigrationGeneration?: () => string;
    expectedBinding?: SharedSyncProtocolBindingV2;
    requireExactBinding?: boolean;
  },
): Promise<EnsureSharedSyncProtocolResultV2> {
  if (
    input.expectedBinding !== undefined
    && !isSharedSyncProtocolBindingV2(input.expectedBinding)
  ) {
    return { status: "blocked", reason: "generation-mismatch" };
  }
  const current = input.observedCurrent;
  if (current) {
    return inspectProtocolObject(
      current,
      input.scope,
      "existing",
      input.expectedBinding,
      input.requireExactBinding,
    );
  }
  if (!input.acknowledgeMigrationRisk && !input.expectedBinding) {
    return { status: "acknowledgement-required" };
  }
  if (input.expectedBinding && input.requireExactBinding) {
    return { status: "blocked", reason: "binding-mismatch" };
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
  const content = serializeSharedSyncProtocolV2(protocol);

  let created: { id: string; eTag: string };
  try {
    created = await transport.createOnly(content);
  } catch (error) {
    rethrowTerminalSharedSyncProtocolTransportError(error);
    // A create-only conflict or an outcome-unknown response may still mean
    // another device won the race. The caller owns the required fresh,
    // complete V2+V3 observation; a single-slot reread is not sufficient.
    const raced = await input.observeAfterCreateFailure();
    if (raced) {
      return inspectProtocolObject(
        raced,
        input.scope,
        "create-race",
        input.expectedBinding,
        input.requireExactBinding,
      );
    }
    return { status: "blocked", reason: "write-failed" };
  }

  let verified: SharedSyncProtocolObjectV2;
  try {
    verified = await transport.readById(created.id);
  } catch (error) {
    rethrowTerminalSharedSyncProtocolTransportError(error);
    return { status: "blocked", reason: "readback-mismatch" };
  }
  if (verified.id !== created.id || verified.content !== content) {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  return readyResult(verified, protocol, "created");
}

/**
 * Publish one already-proven immutable V2 predecessor without changing its
 * public bytes. This is intentionally separate from first-generation
 * creation: callers must supply the expected generation and predecessor
 * digest, and every accepted object is re-read by its exact Graph identity.
 */
export async function ensureCanonicalSharedSyncProtocolV2(
  transport: SharedSyncProtocolMutationTransportV2,
  input: {
    canonicalContent: string;
    expectedMigrationGeneration: string;
    expectedContentSha256: string;
    observedCurrent: SharedSyncProtocolObjectV2 | null;
    observeAfterCreateFailure: () => Promise<
      SharedSyncProtocolObjectV2 | null
    >;
  },
): Promise<EnsureCanonicalSharedSyncProtocolResultV2> {
  const protocol = parseSharedSyncProtocolV2(input.canonicalContent);
  if (!protocol) return { status: "blocked", reason: "invalid-canonical" };
  if (
    protocol.migrationGeneration !== input.expectedMigrationGeneration
    || await sha256Text(input.canonicalContent)
      !== input.expectedContentSha256
  ) {
    return { status: "blocked", reason: "canonical-proof-mismatch" };
  }

  const current = input.observedCurrent;
  if (current) {
    return verifyCanonicalObject(
      transport,
      current,
      input.canonicalContent,
      protocol,
      "existing",
    );
  }

  let created: { id: string; eTag: string };
  try {
    created = await transport.createOnly(input.canonicalContent);
  } catch (error) {
    rethrowTerminalSharedSyncProtocolTransportError(error);
    const raced = await input.observeAfterCreateFailure();
    if (raced) {
      return verifyCanonicalObject(
        transport,
        raced,
        input.canonicalContent,
        protocol,
        "create-race",
      );
    }
    return { status: "blocked", reason: "write-failed" };
  }
  return verifyCanonicalObject(
    transport,
    {
      id: created.id,
      eTag: created.eTag,
      content: input.canonicalContent,
    },
    input.canonicalContent,
    protocol,
    "created",
  );
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

/**
 * Canonical byte representation of the immutable public V2 record.
 *
 * Property order is part of the published predecessor digest contract.
 */
export function serializeSharedSyncProtocolV2(
  protocol: SharedSyncProtocolV2,
): string {
  if (!isSharedSyncProtocolV2(protocol)) {
    throw new Error("Cannot serialize an invalid shared V2 sync protocol");
  }
  return JSON.stringify({
    schemaVersion: protocol.schemaVersion,
    kind: protocol.kind,
    protocolVersion: protocol.protocolVersion,
    migrationGeneration: protocol.migrationGeneration,
    scope: {
      accountId: protocol.scope.accountId,
      driveId: protocol.scope.driveId,
      vaultFolderId: protocol.scope.vaultFolderId,
      filesRootId: protocol.scope.filesRootId,
    },
    confirmedAllDevicesUpdatedAt:
      protocol.confirmedAllDevicesUpdatedAt,
    createdAt: protocol.createdAt,
  });
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
  requireExactBinding = false,
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
  if (
    expectedBinding
    && requireExactBinding
    && (
      object.id !== expectedBinding.recordId
      || object.eTag !== expectedBinding.recordETag
      || value.confirmedAllDevicesUpdatedAt
        !== expectedBinding.confirmedAllDevicesUpdatedAt
    )
  ) {
    return { status: "blocked", reason: "binding-mismatch" };
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

async function verifyCanonicalObject(
  transport: SharedSyncProtocolMutationTransportV2,
  observed: SharedSyncProtocolObjectV2,
  canonicalContent: string,
  protocol: SharedSyncProtocolV2,
  source: "existing" | "created" | "create-race",
): Promise<EnsureCanonicalSharedSyncProtocolResultV2> {
  if (observed.content !== canonicalContent) {
    return { status: "blocked", reason: "target-slot-occupied" };
  }
  let verified: SharedSyncProtocolObjectV2;
  try {
    verified = await transport.readById(observed.id);
  } catch (error) {
    rethrowTerminalSharedSyncProtocolTransportError(error);
    return { status: "blocked", reason: "readback-mismatch" };
  }
  if (
    verified.id !== observed.id
    || verified.eTag !== observed.eTag
    || verified.content !== canonicalContent
  ) {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  return {
    status: "ready",
    source,
    object: structuredClone(verified),
    protocol: structuredClone(protocol),
  };
}

function sha256Text(content: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(content).buffer);
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
