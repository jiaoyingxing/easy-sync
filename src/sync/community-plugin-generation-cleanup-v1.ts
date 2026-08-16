import { sha256Hex } from "../crypto";
import { isRecord } from "../obsidian-compat";
import {
  communityPluginGenerationNamespaceRootV1,
  readCommunityPluginGenerationBundleManifestV1,
  type CommunityPluginGenerationBundleFileNameV1,
  type CommunityPluginGenerationContentGrantV1,
} from "./community-plugin-generation-content-v1";
import {
  communityPluginAuthoritativePublishedBundleV1,
  communityPluginParticipantKeyV1,
  sameCommunityPluginPublishedBundleV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginParticipantIdentityV1,
  type CommunityPluginPublishedBundleV1,
} from "./community-plugin-lifecycle-v1";
import { sameSyncScope, type SyncScope } from "./types";

/**
 * S9b pure evidence contract for closing one sealed generation.
 *
 * It deliberately performs no Graph/Vault mutation and is not another file
 * planner. The snapshot freezes the exact immutable objects and structured
 * object identities that a later crash-safe cleanup transaction must
 * revalidate before every mutation. Despite the historical file name, the
 * schema below is V2 and intentionally rejects enablement-coupled V1 data.
 */

export interface CommunityPluginGenerationCleanupObjectTargetV1 {
  kind: "bundle-member" | "bundle-manifest";
  fileNames: CommunityPluginGenerationBundleFileNameV1[];
  objectPath: string;
  remoteId: string;
  parentId: string;
  size: number;
  eTag: string;
  cTag: string;
  sha256Hash: string;
}

export interface CommunityPluginGenerationCleanupSnapshotV1 {
  schemaVersion: 2;
  capability: "close-community-plugin-generation";
  scope: SyncScope;
  controlRecordId: string;
  /** Physical plugin directory / lifecycle key. */
  pluginId: string;
  generation: number;
  owner: CommunityPluginParticipantIdentityV1;
  closingStartedRevision: number;
  closingFenceEpoch: number;
  memberKeys: string[];
  publishedBundle: CommunityPluginPublishedBundleV1;
  objects: CommunityPluginGenerationCleanupObjectTargetV1[];
  snapshotDigest: string;
}

export interface CommunityPluginGenerationCleanupObjectConfirmationV1 {
  remoteId: string;
  outcome: "deleted" | "already-absent";
  confirmedAt: number;
}

export interface CommunityPluginGenerationCleanupReceiptV1 {
  schemaVersion: 2;
  kind: "community-plugin-generation-cleanup-receipt";
  snapshotDigest: string;
  pluginId: string;
  generation: number;
  objectConfirmations: CommunityPluginGenerationCleanupObjectConfirmationV1[];
  completedAt: number;
  receiptDigest: string;
}

export type CommunityPluginGenerationCleanupSnapshotBlockReasonV1 =
  | "invalid-control-record"
  | "scope-mismatch"
  | "plugin-generation-missing"
  | "generation-not-closing"
  | "closing-owner-retired"
  | "publication-missing"
  | "publication-changed"
  | "legacy-authority-unsealed"
  | "manifest-object-changed"
  | "manifest-invalid"
  | "generation-object-identity-invalid";

export type CommunityPluginGenerationCleanupSnapshotResultV1 =
  | { status: "ready"; snapshot: CommunityPluginGenerationCleanupSnapshotV1 }
  | { status: "blocked"; reason: CommunityPluginGenerationCleanupSnapshotBlockReasonV1 };

export async function createCommunityPluginGenerationCleanupSnapshotV1(
  input: Readonly<{
    control: Readonly<CommunityPluginLifecycleControlV1>;
    controlRecordId: string;
    pluginId: string;
    manifestContent: ArrayBuffer;
  }>,
): Promise<CommunityPluginGenerationCleanupSnapshotResultV1> {
  if (!input.controlRecordId || input.controlRecordId.length > 512) {
    return blocked("invalid-control-record");
  }
  const lifecycle = input.control.pluginsById[input.pluginId];
  const generation = lifecycle?.currentGeneration;
  if (!generation) return blocked("plugin-generation-missing");
  if (generation.phase !== "closing" || !generation.closing) {
    return blocked("generation-not-closing");
  }
  const closing = generation.closing;
  const ownerKey = communityPluginParticipantKeyV1(closing.owner);
  const owner = input.control.participantsByKey[ownerKey];
  if (!owner || owner.retiredAt !== undefined) return blocked("closing-owner-retired");
  const publishedBundle = generation.publishedBundle;
  if (!publishedBundle) return blocked("publication-missing");
  if (!communityPluginAuthoritativePublishedBundleV1(lifecycle)) {
    return blocked("legacy-authority-unsealed");
  }

  const ownerMember = generation.membersByKey[ownerKey];
  if (!ownerMember) return blocked("closing-owner-retired");
  const grant: CommunityPluginGenerationContentGrantV1 = {
    schemaVersion: 1,
    capability: "stage-immutable-object",
    scope: { ...input.control.scope },
    participant: { ...closing.owner },
    pluginId: input.pluginId,
    generation: generation.generation,
    joinNonce: ownerMember.joinNonce,
    observedControlRevision: closing.startedRevision,
    fenceEpoch: closing.fenceEpoch,
    namespaceRoot: communityPluginGenerationNamespaceRootV1(
      input.pluginId,
      generation.generation,
    ),
  };
  const manifestObject = publishedBundle.manifestObject;
  if (input.manifestContent.byteLength !== manifestObject.size) {
    return blocked("manifest-object-changed");
  }
  const prepared = await readCommunityPluginGenerationBundleManifestV1(
    input.manifestContent,
    grant,
    manifestObject.sha256Hash,
  );
  if (!prepared) return blocked("manifest-invalid");
  if (
    prepared.objectPath !== manifestObject.objectPath
    || prepared.sha256Hash !== manifestObject.sha256Hash
  ) return blocked("manifest-object-changed");

  const objects = buildObjectTargets(prepared.manifest.members, manifestObject);
  if (!objects) return blocked("generation-object-identity-invalid");
  const unsigned = {
    schemaVersion: 2 as const,
    capability: "close-community-plugin-generation" as const,
    scope: { ...input.control.scope },
    controlRecordId: input.controlRecordId,
    pluginId: input.pluginId,
    generation: generation.generation,
    owner: { ...closing.owner },
    closingStartedRevision: closing.startedRevision,
    closingFenceEpoch: closing.fenceEpoch,
    memberKeys: [...closing.memberKeys],
    publishedBundle: structuredClone(publishedBundle),
    objects,
  };
  return {
    status: "ready",
    snapshot: {
      ...unsigned,
      snapshotDigest: await sha256Hex(encodeCanonical(unsigned)),
    },
  };
}

/** Revalidate the immutable lifecycle side immediately before cleanup work. */
export async function validateCommunityPluginGenerationCleanupSnapshotV1(
  snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>,
  control: Readonly<CommunityPluginLifecycleControlV1>,
  controlRecordId: string,
): Promise<{ status: "valid" } | {
  status: "blocked";
  reason: CommunityPluginGenerationCleanupSnapshotBlockReasonV1;
}> {
  if (snapshot.schemaVersion !== 2) {
    return blocked("generation-object-identity-invalid");
  }
  if (snapshot.controlRecordId !== controlRecordId || !controlRecordId) {
    return blocked("invalid-control-record");
  }
  if (!sameSyncScope(snapshot.scope, control.scope)) {
    return blocked("scope-mismatch");
  }
  const lifecycle = control.pluginsById[snapshot.pluginId];
  const generation = lifecycle?.currentGeneration;
  if (!generation || generation.generation !== snapshot.generation) {
    return blocked("plugin-generation-missing");
  }
  if (generation.phase !== "closing" || !generation.closing) {
    return blocked("generation-not-closing");
  }
  const closing = generation.closing;
  if (
    closing.startedRevision !== snapshot.closingStartedRevision
    || closing.fenceEpoch !== snapshot.closingFenceEpoch
    || !sameParticipant(closing.owner, snapshot.owner)
    || !sameStringList(closing.memberKeys, snapshot.memberKeys)
  ) return blocked("publication-changed");
  const owner = control.participantsByKey[communityPluginParticipantKeyV1(snapshot.owner)];
  if (!owner || owner.retiredAt !== undefined) return blocked("closing-owner-retired");
  if (!generation.publishedBundle) return blocked("publication-missing");
  if (!sameCommunityPluginPublishedBundleV1(
    generation.publishedBundle,
    snapshot.publishedBundle,
  )) return blocked("publication-changed");
  const authoritativeBundle =
    communityPluginAuthoritativePublishedBundleV1(lifecycle);
  if (!authoritativeBundle) return blocked("legacy-authority-unsealed");
  if (!sameCommunityPluginPublishedBundleV1(
    authoritativeBundle,
    snapshot.publishedBundle,
  )) return blocked("publication-changed");
  const unsigned = {
    schemaVersion: snapshot.schemaVersion,
    capability: snapshot.capability,
    scope: snapshot.scope,
    controlRecordId: snapshot.controlRecordId,
    pluginId: snapshot.pluginId,
    generation: snapshot.generation,
    owner: snapshot.owner,
    closingStartedRevision: snapshot.closingStartedRevision,
    closingFenceEpoch: snapshot.closingFenceEpoch,
    memberKeys: snapshot.memberKeys,
    publishedBundle: snapshot.publishedBundle,
    objects: snapshot.objects,
  };
  if (await sha256Hex(encodeCanonical(unsigned)) !== snapshot.snapshotDigest) {
    return blocked("generation-object-identity-invalid");
  }
  return { status: "valid" };
}

export async function createCommunityPluginGenerationCleanupReceiptV1(
  input: Readonly<{
    snapshot: Readonly<CommunityPluginGenerationCleanupSnapshotV1>;
    objectConfirmations: readonly Readonly<
      CommunityPluginGenerationCleanupObjectConfirmationV1
    >[];
  }>,
): Promise<CommunityPluginGenerationCleanupReceiptV1 | null> {
  if (
    input.objectConfirmations.length !== input.snapshot.objects.length
    || input.objectConfirmations.some((confirmation, index) =>
      !isRecord(confirmation)
      || confirmation.remoteId !== input.snapshot.objects[index]?.remoteId
      || !["deleted", "already-absent"].includes(confirmation.outcome)
      || !Number.isFinite(confirmation.confirmedAt)
      || confirmation.confirmedAt < 0
    )
  ) return null;
  const objectConfirmations = input.objectConfirmations.map((item) => ({ ...item }));
  const unsigned = {
    schemaVersion: 2 as const,
    kind: "community-plugin-generation-cleanup-receipt" as const,
    snapshotDigest: input.snapshot.snapshotDigest,
    pluginId: input.snapshot.pluginId,
    generation: input.snapshot.generation,
    objectConfirmations,
    completedAt: objectConfirmations[objectConfirmations.length - 1]!.confirmedAt,
  };
  return {
    ...unsigned,
    receiptDigest: await sha256Hex(encodeCanonical(unsigned)),
  };
}

function buildObjectTargets(
  members: readonly Readonly<{
    fileName: CommunityPluginGenerationBundleFileNameV1;
    objectPath: string;
    remoteId: string;
    parentId: string;
    size: number;
    eTag: string;
    cTag: string;
    sha256Hash: string;
  }>[],
  manifest: Readonly<CommunityPluginPublishedBundleV1["manifestObject"]>,
): CommunityPluginGenerationCleanupObjectTargetV1[] | null {
  const byRemoteId = new Map<string, CommunityPluginGenerationCleanupObjectTargetV1>();
  for (const member of members) {
    if (!member.eTag) return null;
    const existing = byRemoteId.get(member.remoteId);
    if (existing) {
      if (!sameObjectIdentity(existing, member)) return null;
      existing.fileNames.push(member.fileName);
      existing.fileNames.sort(compareText);
      continue;
    }
    byRemoteId.set(member.remoteId, {
      kind: "bundle-member",
      fileNames: [member.fileName],
      objectPath: member.objectPath,
      remoteId: member.remoteId,
      parentId: member.parentId,
      size: member.size,
      eTag: member.eTag,
      cTag: member.cTag,
      sha256Hash: member.sha256Hash,
    });
  }
  if (!manifest.eTag || byRemoteId.has(manifest.remoteId)) return null;
  return [
    ...[...byRemoteId.values()].sort((left, right) =>
      compareText(left.objectPath, right.objectPath)),
    {
      kind: "bundle-manifest",
      fileNames: [],
      objectPath: manifest.objectPath,
      remoteId: manifest.remoteId,
      parentId: manifest.parentId,
      size: manifest.size,
      eTag: manifest.eTag,
      cTag: manifest.cTag,
      sha256Hash: manifest.sha256Hash,
    },
  ];
}

function sameObjectIdentity(
  left: Readonly<CommunityPluginGenerationCleanupObjectTargetV1>,
  right: Readonly<{
    objectPath: string;
    remoteId: string;
    parentId: string;
    size: number;
    eTag: string;
    cTag: string;
    sha256Hash: string;
  }>,
): boolean {
  return left.objectPath === right.objectPath
    && left.remoteId === right.remoteId
    && left.parentId === right.parentId
    && left.size === right.size
    && left.eTag === right.eTag
    && left.cTag === right.cTag
    && left.sha256Hash === right.sha256Hash;
}

function encodeCanonical(value: unknown): ArrayBuffer {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

function sameParticipant(
  left: Readonly<CommunityPluginParticipantIdentityV1>,
  right: Readonly<CommunityPluginParticipantIdentityV1>,
): boolean {
  return left.participantId === right.participantId
    && left.incarnation === right.incarnation;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function blocked(
  reason: CommunityPluginGenerationCleanupSnapshotBlockReasonV1,
): { status: "blocked"; reason: CommunityPluginGenerationCleanupSnapshotBlockReasonV1 } {
  return { status: "blocked", reason };
}
