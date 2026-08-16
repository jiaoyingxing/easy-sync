import { sha256Hex } from "../crypto";
import { isRecord } from "../obsidian-compat";
import {
  parseSharedSyncProtocolV2,
  serializeSharedSyncProtocolV2,
  type SharedSyncProtocolObjectV2,
  type SharedSyncProtocolV2,
} from "./sync-protocol-v2";
import {
  isSharedSyncProtocolBindingV3,
  parseSharedSyncProtocolV3,
  type SharedSyncProtocolBindingV3,
  type SharedSyncProtocolObjectV3,
  type SharedSyncProtocolV3,
} from "./sync-protocol-v3";
import { sameSyncScope, type SyncScope } from "./types";

export type SharedSyncProtocolProfile =
  | { status: "empty" }
  | {
    status: "legacy-v2";
    migrationGeneration: string;
    protocolV2: SharedSyncProtocolV2;
    protocolV2Object: SharedSyncProtocolObjectV2;
  }
  | {
    status: "healthy";
    migrationGeneration: string;
    protocolV2: SharedSyncProtocolV2;
    protocolV3: SharedSyncProtocolV3;
    protocolV2Object: SharedSyncProtocolObjectV2;
    protocolV3Object: SharedSyncProtocolObjectV3;
  }
  | {
    status: "recoverable";
    migrationGeneration: string;
    missing: Array<"v2" | "v3">;
    canonicalV2Content: string;
    canonicalV3Content: string;
  }
  | {
    status: "inconsistent";
    reason: SharedSyncProtocolInconsistencyReason;
    evidence: SharedSyncProtocolInconsistencyEvidence;
  };

export type SharedSyncProtocolInconsistencyReason =
  | "invalid-v2"
  | "unsupported-v2"
  | "invalid-v3"
  | "unsupported-v3"
  | "v2-scope-mismatch"
  | "v3-only-unbound"
  | "recovery-proof-incomplete"
  | "binding-mismatch"
  | "generation-mismatch"
  | "predecessor-mismatch"
  | "target-slot-occupied";

export interface SharedSyncProtocolInconsistencyEvidence {
  status: "inconsistent";
  reason: SharedSyncProtocolInconsistencyReason;
  v2Generation: string;
  v3Generation: string;
  predecessor: "match" | "mismatch" | "unavailable";
}

export const SHARED_SYNC_PROTOCOL_PROFILE_DIAGNOSTIC_EVENT =
  "shared-sync-protocol-profile-inconsistent";

export async function classifySharedSyncProtocolProfile(input: {
  v2: SharedSyncProtocolObjectV2 | null;
  v3: SharedSyncProtocolObjectV3 | null;
  targetScope: SyncScope;
  expectedBinding?: SharedSyncProtocolBindingV3;
  predecessorScope?: SyncScope;
}): Promise<SharedSyncProtocolProfile> {
  const invalidV2 = invalidReason(input.v2?.content, 2);
  if (invalidV2) return inconsistentProfile(invalidV2);
  const invalidV3 = invalidReason(input.v3?.content, 3);
  if (invalidV3) return inconsistentProfile(invalidV3);

  const protocolV2 = input.v2
    ? parseSharedSyncProtocolV2(input.v2.content)
    : null;
  const protocolV3 = input.v3
    ? parseSharedSyncProtocolV3(input.v3.content)
    : null;

  if (protocolV2 && protocolV3) {
    const lineageReason = await compareLineage(protocolV2, input.v2!.content, protocolV3);
    if (!lineageReason) {
      if (input.expectedBinding) {
        const bindingReason = await compareBinding(
          input.expectedBinding,
          input.v3!,
          protocolV3,
          protocolV2.confirmedAllDevicesUpdatedAt,
        );
        if (bindingReason) {
          return inconsistentProfile(
            bindingReason,
            protocolV2,
            input.v2!.content,
            protocolV3,
          );
        }
      }
      return {
        status: "healthy",
        migrationGeneration: protocolV2.migrationGeneration,
        protocolV2,
        protocolV3,
        protocolV2Object: input.v2!,
        protocolV3Object: input.v3!,
      };
    }
    return inconsistentProfile(
      input.expectedBinding ? "target-slot-occupied" : lineageReason,
      protocolV2,
      input.v2!.content,
      protocolV3,
    );
  }

  if (!input.expectedBinding) {
    if (!protocolV2 && !protocolV3) return { status: "empty" };
    if (protocolV3) {
      return inconsistentProfile("v3-only-unbound", null, undefined, protocolV3);
    }
    if (!sameSyncScope(protocolV2!.scope, input.targetScope)) {
      return inconsistentProfile(
        "v2-scope-mismatch",
        protocolV2,
        input.v2!.content,
      );
    }
    return {
      status: "legacy-v2",
      migrationGeneration: protocolV2!.migrationGeneration,
      protocolV2: protocolV2!,
      protocolV2Object: input.v2!,
    };
  }

  if (!isSharedSyncProtocolBindingV3(input.expectedBinding)) {
    return inconsistentProfile("binding-mismatch", protocolV2, input.v2?.content, protocolV3);
  }
  if (!input.predecessorScope) {
    return inconsistentProfile(
      "recovery-proof-incomplete",
      protocolV2,
      input.v2?.content,
      protocolV3,
    );
  }
  const canonicalV2Content = serializeSharedSyncProtocolV2({
    schemaVersion: 1,
    kind: "easy-sync-v2-protocol",
    protocolVersion: 2,
    migrationGeneration: input.expectedBinding.migrationGeneration,
    scope: input.predecessorScope,
    confirmedAllDevicesUpdatedAt:
      input.expectedBinding.predecessorConfirmedAllDevicesUpdatedAt,
    createdAt: input.expectedBinding.createdAt,
  });
  if (await digest(canonicalV2Content)
    !== input.expectedBinding.predecessorContentSha256) {
    return inconsistentProfile("binding-mismatch", protocolV2, input.v2?.content, protocolV3);
  }
  const canonicalV3: SharedSyncProtocolV3 = {
    schemaVersion: 1,
    kind: "easy-sync-generation-protocol",
    protocolVersion: 3,
    migrationGeneration: input.expectedBinding.migrationGeneration,
    predecessor: {
      protocolVersion: 2,
      contentSha256: input.expectedBinding.predecessorContentSha256,
    },
    createdAt: input.expectedBinding.createdAt,
  };
  const canonicalV3Content = JSON.stringify(canonicalV3);
  if (await digest(canonicalV3Content) !== input.expectedBinding.contentSha256) {
    return inconsistentProfile("binding-mismatch", protocolV2, input.v2?.content, protocolV3);
  }
  if (protocolV2 && input.v2!.content !== canonicalV2Content) {
    return inconsistentProfile(
      "target-slot-occupied",
      protocolV2,
      input.v2!.content,
      protocolV3,
    );
  }
  if (protocolV3 && input.v3!.content !== canonicalV3Content) {
    return inconsistentProfile(
      "target-slot-occupied",
      protocolV2,
      input.v2?.content,
      protocolV3,
    );
  }
  if (input.v3) {
    const bindingReason = await compareBinding(
      input.expectedBinding,
      input.v3,
      protocolV3!,
    );
    if (bindingReason) {
      return inconsistentProfile(
        bindingReason,
        protocolV2,
        input.v2?.content,
        protocolV3,
      );
    }
  }
  return {
    status: "recoverable",
    migrationGeneration: input.expectedBinding.migrationGeneration,
    missing: [
      ...(input.v2 ? [] : ["v2" as const]),
      ...(input.v3 ? [] : ["v3" as const]),
    ],
    canonicalV2Content,
    canonicalV3Content,
  };
}

function invalidReason(
  content: string | undefined,
  version: 2 | 3,
): SharedSyncProtocolInconsistencyReason | null {
  if (content === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return version === 2 ? "invalid-v2" : "invalid-v3";
  }
  const parsed = version === 2
    ? parseSharedSyncProtocolV2(content)
    : parseSharedSyncProtocolV3(content);
  if (parsed) return null;
  if (isRecord(value) && value.protocolVersion !== version) {
    return version === 2 ? "unsupported-v2" : "unsupported-v3";
  }
  return version === 2 ? "invalid-v2" : "invalid-v3";
}

async function compareLineage(
  v2: SharedSyncProtocolV2,
  v2Content: string,
  v3: SharedSyncProtocolV3,
): Promise<"generation-mismatch" | "predecessor-mismatch" | null> {
  if (v2.migrationGeneration !== v3.migrationGeneration) {
    return "generation-mismatch";
  }
  if (
    v2.createdAt !== v3.createdAt
    || await digest(v2Content) !== v3.predecessor.contentSha256
  ) {
    return "predecessor-mismatch";
  }
  return null;
}

async function compareBinding(
  binding: SharedSyncProtocolBindingV3,
  object: SharedSyncProtocolObjectV3,
  protocol: SharedSyncProtocolV3,
  predecessorConfirmedAllDevicesUpdatedAt?: number,
): Promise<"binding-mismatch" | null> {
  return binding.recordId !== object.id
      || binding.recordETag !== object.eTag
      || binding.migrationGeneration !== protocol.migrationGeneration
      || binding.predecessorContentSha256
        !== protocol.predecessor.contentSha256
      || binding.createdAt !== protocol.createdAt
      || (
        predecessorConfirmedAllDevicesUpdatedAt !== undefined
        && binding.predecessorConfirmedAllDevicesUpdatedAt
          !== predecessorConfirmedAllDevicesUpdatedAt
      )
      || binding.contentSha256 !== await digest(object.content)
    ? "binding-mismatch"
    : null;
}

function digest(content: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(content).buffer);
}

async function inconsistentProfile(
  reason: SharedSyncProtocolInconsistencyReason,
  v2: SharedSyncProtocolV2 | null = null,
  v2Content?: string,
  v3: SharedSyncProtocolV3 | null = null,
): Promise<Extract<SharedSyncProtocolProfile, { status: "inconsistent" }>> {
  const predecessor = v2 && v2Content && v3
    ? v2.createdAt === v3.createdAt
      && await digest(v2Content) === v3.predecessor.contentSha256
      ? "match"
      : "mismatch"
    : "unavailable";
  return {
    status: "inconsistent",
    reason,
    evidence: {
      status: "inconsistent",
      reason,
      v2Generation: v2?.migrationGeneration.slice(0, 12) ?? "—",
      v3Generation: v3?.migrationGeneration.slice(0, 12) ?? "—",
      predecessor,
    },
  };
}
