import { sha256Hex } from "../crypto";
import type { OneDriveClient } from "../onedrive/client";
import { isRecord } from "../obsidian-compat";
import {
  isSharedSyncProtocolBindingV2,
  parseSharedSyncProtocolV2,
  type SharedSyncProtocolBindingV2,
  type SharedSyncProtocolObjectV2,
} from "./sync-protocol-v2";

export const SYNC_PROTOCOL_V3_VERSION = 3;

export interface SharedSyncProtocolV3 {
  schemaVersion: 1;
  kind: "easy-sync-generation-protocol";
  protocolVersion: typeof SYNC_PROTOCOL_V3_VERSION;
  migrationGeneration: string;
  predecessor: {
    protocolVersion: 2;
    contentSha256: string;
  };
  createdAt: number;
}

export interface SharedSyncProtocolObjectV3 {
  id: string;
  eTag: string;
  content: string;
}

export interface SharedSyncProtocolTransportV3 {
  read(): Promise<SharedSyncProtocolObjectV3 | null>;
  createOnly(content: string): Promise<{ id: string; eTag: string }>;
  readById(id: string): Promise<SharedSyncProtocolObjectV3>;
}

/**
 * Device-local proof of the immutable, scope-free generation protocol.
 * The predecessor fields make a V2 -> V3 transition independently
 * verifiable without turning this binding into file or folder authority.
 */
export interface SharedSyncProtocolBindingV3 {
  schemaVersion: 1;
  protocolVersion: typeof SYNC_PROTOCOL_V3_VERSION;
  migrationGeneration: string;
  predecessorProtocolVersion: 2;
  predecessorContentSha256: string;
  predecessorConfirmedAllDevicesUpdatedAt: number;
  createdAt: number;
  contentSha256: string;
  recordId: string;
  recordETag: string;
}

export type SharedSyncProtocolBinding =
  | SharedSyncProtocolBindingV2
  | SharedSyncProtocolBindingV3;

export type EnsureSharedSyncProtocolResultV3 =
  | {
    status: "ready";
    source: "existing" | "created" | "create-race";
    protocol: SharedSyncProtocolV3;
    binding: SharedSyncProtocolBindingV3;
  }
  | {
    status: "blocked";
    reason:
      | "read-failed"
      | "invalid-current"
      | "unsupported-protocol"
      | "predecessor-required"
      | "predecessor-mismatch"
      | "generation-mismatch"
      | "write-not-authorized"
      | "write-failed"
      | "readback-mismatch";
  };

export function createOneDriveSharedSyncProtocolTransportV3(
  client: OneDriveClient,
  vaultName: string,
): SharedSyncProtocolTransportV3 {
  return {
    read: () => client.readSharedSyncProtocolV3(vaultName),
    createOnly: (content) =>
      client.createSharedSyncProtocolV3(vaultName, content),
    readById: (id) => client.readSharedSyncProtocolV3ById(id),
  };
}

/**
 * Join or create the immutable scope-free generation protocol.
 *
 * Creation is authorized by either an exact V2 predecessor plus its bound
 * authority, an exact current-scope V2 predecessor checked by the caller,
 * or an already-bound V3 protocol. No path or scope is stored in V3.
 */
export async function ensureSharedSyncProtocolV3(
  transport: SharedSyncProtocolTransportV3,
  input: {
    predecessor?: SharedSyncProtocolObjectV2;
    expectedBinding?: SharedSyncProtocolBinding;
    allowCreate: boolean;
  },
): Promise<EnsureSharedSyncProtocolResultV3> {
  if (
    input.expectedBinding !== undefined
    && !isSharedSyncProtocolBinding(input.expectedBinding)
  ) {
    return { status: "blocked", reason: "generation-mismatch" };
  }

  const desired = await deriveDesiredProtocol(input);
  if (desired.status === "blocked") return desired;

  let current: SharedSyncProtocolObjectV3 | null;
  try {
    current = await transport.read();
  } catch {
    return { status: "blocked", reason: "read-failed" };
  }
  if (current) {
    return inspectProtocolObject(
      current,
      desired.protocol,
      desired.predecessorConfirmedAllDevicesUpdatedAt,
      "existing",
      input.expectedBinding,
    );
  }
  if (!input.allowCreate) {
    return { status: "blocked", reason: "write-not-authorized" };
  }

  const content = JSON.stringify(desired.protocol);
  let created: { id: string; eTag: string };
  try {
    created = await transport.createOnly(content);
  } catch {
    try {
      const raced = await transport.read();
      if (raced) {
        return inspectProtocolObject(
          raced,
          desired.protocol,
          desired.predecessorConfirmedAllDevicesUpdatedAt,
          "create-race",
          input.expectedBinding,
        );
      }
    } catch {
      // Preserve the conservative write-failed classification.
    }
    return { status: "blocked", reason: "write-failed" };
  }

  let verified: SharedSyncProtocolObjectV3;
  try {
    verified = await transport.readById(created.id);
  } catch {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  if (verified.id !== created.id || verified.content !== content) {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  return readyResult(
    verified,
    desired.protocol,
    desired.predecessorConfirmedAllDevicesUpdatedAt,
    "created",
  );
}

export function isSharedSyncProtocolBinding(
  value: unknown,
): value is SharedSyncProtocolBinding {
  return isSharedSyncProtocolBindingV2(value)
    || isSharedSyncProtocolBindingV3(value);
}

export function isSharedSyncProtocolBindingV3(
  value: unknown,
): value is SharedSyncProtocolBindingV3 {
  return isRecord(value)
    && hasExactKeys(value, [
      "schemaVersion",
      "protocolVersion",
      "migrationGeneration",
      "predecessorProtocolVersion",
      "predecessorContentSha256",
      "predecessorConfirmedAllDevicesUpdatedAt",
      "createdAt",
      "contentSha256",
      "recordId",
      "recordETag",
    ])
    && value.schemaVersion === 1
    && value.protocolVersion === SYNC_PROTOCOL_V3_VERSION
    && isSha256(value.migrationGeneration)
    && value.predecessorProtocolVersion === 2
    && isSha256(value.predecessorContentSha256)
    && isNonNegativeNumber(value.predecessorConfirmedAllDevicesUpdatedAt)
    && isNonNegativeNumber(value.createdAt)
    && isSha256(value.contentSha256)
    && typeof value.recordId === "string"
    && value.recordId.length > 0
    && typeof value.recordETag === "string"
    && value.recordETag.length > 0;
}

export function isSharedSyncProtocolBindingTransitionAllowed(
  current: SharedSyncProtocolBinding,
  next: SharedSyncProtocolBinding,
): boolean {
  if (current.migrationGeneration !== next.migrationGeneration) return false;
  if (current.protocolVersion === 2 && next.protocolVersion === 2) {
    return current.confirmedAllDevicesUpdatedAt
      === next.confirmedAllDevicesUpdatedAt;
  }
  if (current.protocolVersion === 2 && next.protocolVersion === 3) {
    return current.confirmedAllDevicesUpdatedAt
      === next.predecessorConfirmedAllDevicesUpdatedAt;
  }
  if (current.protocolVersion === 3 && next.protocolVersion === 3) {
    return current.predecessorProtocolVersion
        === next.predecessorProtocolVersion
      && current.predecessorContentSha256
        === next.predecessorContentSha256
      && current.predecessorConfirmedAllDevicesUpdatedAt
        === next.predecessorConfirmedAllDevicesUpdatedAt
      && current.createdAt === next.createdAt
      && current.contentSha256 === next.contentSha256;
  }
  return false;
}

async function deriveDesiredProtocol(input: {
  predecessor?: SharedSyncProtocolObjectV2;
  expectedBinding?: SharedSyncProtocolBinding;
  allowCreate: boolean;
}): Promise<
  | {
    status: "ready";
    protocol: SharedSyncProtocolV3;
    predecessorConfirmedAllDevicesUpdatedAt: number;
  }
  | Extract<EnsureSharedSyncProtocolResultV3, { status: "blocked" }>
> {
  const predecessorProtocol = input.predecessor
    ? parseSharedSyncProtocolV2(input.predecessor.content)
    : null;
  const predecessorContentSha256 = input.predecessor
    ? await sha256Text(input.predecessor.content)
    : null;

  if (input.predecessor && !predecessorProtocol) {
    return { status: "blocked", reason: "predecessor-mismatch" };
  }
  if (input.expectedBinding?.protocolVersion === 3) {
    if (
      predecessorProtocol
      && (
        predecessorProtocol.migrationGeneration
          !== input.expectedBinding.migrationGeneration
        || predecessorContentSha256
          !== input.expectedBinding.predecessorContentSha256
      )
    ) {
      return { status: "blocked", reason: "predecessor-mismatch" };
    }
    return {
      status: "ready",
      protocol: {
        schemaVersion: 1,
        kind: "easy-sync-generation-protocol",
        protocolVersion: SYNC_PROTOCOL_V3_VERSION,
        migrationGeneration: input.expectedBinding.migrationGeneration,
        predecessor: {
          protocolVersion: 2,
          contentSha256: input.expectedBinding.predecessorContentSha256,
        },
        createdAt: input.expectedBinding.createdAt,
      },
      predecessorConfirmedAllDevicesUpdatedAt:
        input.expectedBinding.predecessorConfirmedAllDevicesUpdatedAt,
    };
  }
  if (!predecessorProtocol || !predecessorContentSha256) {
    return { status: "blocked", reason: "predecessor-required" };
  }
  if (
    input.expectedBinding?.protocolVersion === 2
    && (
      input.predecessor?.id !== input.expectedBinding.recordId
      || input.predecessor?.eTag !== input.expectedBinding.recordETag
      || predecessorProtocol.migrationGeneration
        !== input.expectedBinding.migrationGeneration
      || predecessorProtocol.confirmedAllDevicesUpdatedAt
        !== input.expectedBinding.confirmedAllDevicesUpdatedAt
    )
  ) {
    return { status: "blocked", reason: "predecessor-mismatch" };
  }
  return {
    status: "ready",
    protocol: {
      schemaVersion: 1,
      kind: "easy-sync-generation-protocol",
      protocolVersion: SYNC_PROTOCOL_V3_VERSION,
      migrationGeneration: predecessorProtocol.migrationGeneration,
      predecessor: {
        protocolVersion: 2,
        contentSha256: predecessorContentSha256,
      },
      createdAt: predecessorProtocol.createdAt,
    },
    predecessorConfirmedAllDevicesUpdatedAt:
      predecessorProtocol.confirmedAllDevicesUpdatedAt,
  };
}

async function inspectProtocolObject(
  object: SharedSyncProtocolObjectV3,
  desired: SharedSyncProtocolV3,
  predecessorConfirmedAllDevicesUpdatedAt: number,
  source: "existing" | "create-race",
  expectedBinding?: SharedSyncProtocolBinding,
): Promise<EnsureSharedSyncProtocolResultV3> {
  let value: unknown;
  try {
    value = JSON.parse(object.content);
  } catch {
    return { status: "blocked", reason: "invalid-current" };
  }
  if (
    isRecord(value)
    && (
      value.kind !== "easy-sync-generation-protocol"
      || value.schemaVersion !== 1
      || value.protocolVersion !== SYNC_PROTOCOL_V3_VERSION
    )
  ) {
    return { status: "blocked", reason: "unsupported-protocol" };
  }
  if (!isSharedSyncProtocolV3(value)) {
    return { status: "blocked", reason: "invalid-current" };
  }
  if (value.migrationGeneration !== desired.migrationGeneration) {
    return { status: "blocked", reason: "generation-mismatch" };
  }
  if (
    value.predecessor.protocolVersion !== desired.predecessor.protocolVersion
    || value.predecessor.contentSha256 !== desired.predecessor.contentSha256
    || value.createdAt !== desired.createdAt
  ) {
    return { status: "blocked", reason: "predecessor-mismatch" };
  }
  const contentSha256 = await sha256Text(object.content);
  if (
    expectedBinding?.protocolVersion === 3
    && contentSha256 !== expectedBinding.contentSha256
  ) {
    return { status: "blocked", reason: "predecessor-mismatch" };
  }
  return readyResult(
    object,
    value,
    predecessorConfirmedAllDevicesUpdatedAt,
    source,
    contentSha256,
  );
}

async function readyResult(
  object: SharedSyncProtocolObjectV3,
  protocol: SharedSyncProtocolV3,
  predecessorConfirmedAllDevicesUpdatedAt: number,
  source: "existing" | "created" | "create-race",
  knownContentSha256?: string,
): Promise<Extract<EnsureSharedSyncProtocolResultV3, { status: "ready" }>> {
  if (
    typeof object.id !== "string"
    || object.id.length === 0
    || typeof object.eTag !== "string"
    || object.eTag.length === 0
  ) {
    throw new Error("Shared V3 sync protocol object identity is incomplete");
  }
  return {
    status: "ready",
    source,
    protocol: structuredClone(protocol),
    binding: {
      schemaVersion: 1,
      protocolVersion: SYNC_PROTOCOL_V3_VERSION,
      migrationGeneration: protocol.migrationGeneration,
      predecessorProtocolVersion: 2,
      predecessorContentSha256: protocol.predecessor.contentSha256,
      predecessorConfirmedAllDevicesUpdatedAt:
        predecessorConfirmedAllDevicesUpdatedAt,
      createdAt: protocol.createdAt,
      contentSha256: knownContentSha256 ?? await sha256Text(object.content),
      recordId: object.id,
      recordETag: object.eTag,
    },
  };
}

function isSharedSyncProtocolV3(value: unknown): value is SharedSyncProtocolV3 {
  return isRecord(value)
    && hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "protocolVersion",
      "migrationGeneration",
      "predecessor",
      "createdAt",
    ])
    && value.schemaVersion === 1
    && value.kind === "easy-sync-generation-protocol"
    && value.protocolVersion === SYNC_PROTOCOL_V3_VERSION
    && isSha256(value.migrationGeneration)
    && isRecord(value.predecessor)
    && hasExactKeys(value.predecessor, ["protocolVersion", "contentSha256"])
    && value.predecessor.protocolVersion === 2
    && isSha256(value.predecessor.contentSha256)
    && isNonNegativeNumber(value.createdAt);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) >= 0;
}

function sha256Text(content: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(content).buffer);
}
