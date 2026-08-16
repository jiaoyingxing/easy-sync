import { sha256Hex } from "../crypto";
import { isRecord } from "../obsidian-compat";
import {
  communityPluginAuthoritativePublishedBundleV1,
  communityPluginPublishedManifestObjectPathV1,
  communityPluginParticipantKeyV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginParticipantIdentityV1,
  type CommunityPluginPublishedManifestObjectV1,
} from "./community-plugin-lifecycle-v1";
import {
  isSyncScope,
  sameSyncScope,
  SyncActionType,
  type SyncPlanItem,
  type SyncScope,
} from "./types";

/**
 * S8a pure contract for staging immutable community-plugin bytes outside the
 * ordinary files root. A staged object is deliberately not a published bundle
 * and grants no download, overwrite, cleanup or current-generation authority.
 */

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/i;
const SAFE_PARTICIPANT_ID = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_ROOT = "community-plugin-content-v1";

export interface CommunityPluginGenerationContentGrantV1 {
  schemaVersion: 1;
  capability: "stage-immutable-object";
  scope: SyncScope;
  participant: CommunityPluginParticipantIdentityV1;
  pluginId: string;
  generation: number;
  joinNonce: string;
  observedControlRevision: number;
  fenceEpoch: number;
  namespaceRoot: string;
}

export type CommunityPluginGenerationContentBlockReasonV1 =
  | "invalid-grant"
  | "scope-mismatch"
  | "control-revision-regressed"
  | "fence-changed"
  | "participant-missing"
  | "participant-retired"
  | "generation-missing"
  | "generation-mismatch"
  | "generation-not-open"
  | "participant-not-joined"
  | "join-changed";

export type CommunityPluginGenerationContentGrantResultV1 =
  | { status: "ready"; grant: CommunityPluginGenerationContentGrantV1 }
  | { status: "blocked"; reason: CommunityPluginGenerationContentBlockReasonV1 };

export interface CommunityPluginGenerationObjectPathV1 {
  pluginId: string;
  generation: number;
  sha256Hash: string;
}

export type CommunityPluginGenerationBundleFileNameV1 =
  | "main.js"
  | "manifest.json"
  | "styles.css";

/** Strict read-back receipt for one immutable content object. */
export interface CommunityPluginGenerationContentObjectReceiptV1 {
  fileName: CommunityPluginGenerationBundleFileNameV1;
  objectPath: string;
  remoteId: string;
  parentId: string;
  size: number;
  eTag: string;
  cTag: string;
  sha256Hash: string;
}

/** Canonical bytes referenced by the lifecycle control object's current pointer. */
export interface CommunityPluginGenerationBundleManifestV1 {
  schemaVersion: 1;
  pluginId: string;
  generation: number;
  members: CommunityPluginGenerationContentObjectReceiptV1[];
}

export interface PreparedCommunityPluginGenerationBundleManifestV1 {
  manifest: CommunityPluginGenerationBundleManifestV1;
  bytes: ArrayBuffer;
  sha256Hash: string;
  objectPath: string;
}

/**
 * A sealed generation is projected as an explicit local restore source, not
 * as a synthetic `files`-root remote entry. The target path belongs to the
 * Vault while `source` retains the immutable object's real Graph identity.
 */
export interface CommunityPluginGenerationRestoreMemberV1 {
  fileName: CommunityPluginGenerationBundleFileNameV1;
  targetPath: string;
  source: CommunityPluginGenerationContentObjectReceiptV1;
}

export interface CommunityPluginGenerationRestoreProjectionV1 {
  schemaVersion: 1;
  capability: "restore-sealed-generation-bundle";
  scope: SyncScope;
  participant: CommunityPluginParticipantIdentityV1;
  pluginId: string;
  generation: number;
  joinNonce: string;
  controlRecordId: string;
  observedControlRevision: number;
  fenceEpoch: number;
  sealRevision: number;
  configDir: string;
  manifestObject: CommunityPluginPublishedManifestObjectV1;
  members: CommunityPluginGenerationRestoreMemberV1[];
}

export type CommunityPluginGenerationRestoreBlockReasonV1 =
  | CommunityPluginGenerationContentBlockReasonV1
  | "control-record-changed"
  | "legacy-authority-unsealed"
  | "published-bundle-changed"
  | "manifest-object-changed"
  | "manifest-invalid"
  | "invalid-target-root";

export type CommunityPluginGenerationRestoreProjectionResultV1 =
  | {
    status: "ready";
    projection: CommunityPluginGenerationRestoreProjectionV1;
  }
  | {
    status: "blocked";
    reason: CommunityPluginGenerationRestoreBlockReasonV1;
  };

export function createCommunityPluginGenerationContentGrantV1(input: Readonly<{
  control: Readonly<CommunityPluginLifecycleControlV1>;
  scope: Readonly<SyncScope>;
  participant: Readonly<CommunityPluginParticipantIdentityV1>;
  pluginId: string;
}>): CommunityPluginGenerationContentGrantResultV1 {
  const { control, scope, participant, pluginId } = input;
  if (!sameSyncScope(control.scope, scope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  if (!SAFE_PLUGIN_ID.test(pluginId)) {
    return { status: "blocked", reason: "invalid-grant" };
  }
  const participantKey = communityPluginParticipantKeyV1(participant);
  const registered = control.participantsByKey[participantKey];
  if (!registered) return { status: "blocked", reason: "participant-missing" };
  if (registered.retiredAt !== undefined) {
    return { status: "blocked", reason: "participant-retired" };
  }
  const generation = control.pluginsById[pluginId]?.currentGeneration;
  if (!generation) return { status: "blocked", reason: "generation-missing" };
  if (generation.phase !== "open") {
    return { status: "blocked", reason: "generation-not-open" };
  }
  const member = generation.membersByKey[participantKey];
  if (!member || member.phase !== "joined") {
    return { status: "blocked", reason: "participant-not-joined" };
  }
  const namespaceRoot = communityPluginGenerationNamespaceRootV1(
    pluginId,
    generation.generation,
  );
  return {
    status: "ready",
    grant: {
      schemaVersion: 1,
      capability: "stage-immutable-object",
      scope: { ...scope },
      participant: { ...participant },
      pluginId,
      generation: generation.generation,
      joinNonce: member.joinNonce,
      observedControlRevision: control.revision,
      fenceEpoch: control.fenceEpoch,
      namespaceRoot,
    },
  };
}

/**
 * Revalidate immediately before an immutable create. Later observation-only
 * revisions are harmless, but retirement advances the fence and invalidates
 * every older grant. Publishing a bundle requires a separate future CAS.
 */
export function validateCommunityPluginGenerationContentGrantV1(
  grant: Readonly<CommunityPluginGenerationContentGrantV1>,
  control: Readonly<CommunityPluginLifecycleControlV1>,
): { status: "valid" } | {
  status: "blocked";
  reason: CommunityPluginGenerationContentBlockReasonV1;
} {
  if (!isCommunityPluginGenerationContentGrantV1(grant)) {
    return { status: "blocked", reason: "invalid-grant" };
  }
  if (!sameSyncScope(grant.scope, control.scope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  if (control.revision < grant.observedControlRevision) {
    return { status: "blocked", reason: "control-revision-regressed" };
  }
  if (control.fenceEpoch !== grant.fenceEpoch) {
    return { status: "blocked", reason: "fence-changed" };
  }
  const participantKey = communityPluginParticipantKeyV1(grant.participant);
  const participant = control.participantsByKey[participantKey];
  if (!participant) return { status: "blocked", reason: "participant-missing" };
  if (participant.retiredAt !== undefined) {
    return { status: "blocked", reason: "participant-retired" };
  }
  const generation = control.pluginsById[grant.pluginId]?.currentGeneration;
  if (!generation) return { status: "blocked", reason: "generation-missing" };
  if (generation.generation !== grant.generation) {
    return { status: "blocked", reason: "generation-mismatch" };
  }
  if (generation.phase !== "open") {
    return { status: "blocked", reason: "generation-not-open" };
  }
  const member = generation.membersByKey[participantKey];
  if (!member || member.phase !== "joined") {
    return { status: "blocked", reason: "participant-not-joined" };
  }
  if (member.joinNonce !== grant.joinNonce) {
    return { status: "blocked", reason: "join-changed" };
  }
  return { status: "valid" };
}

/** Relative to the vault's `.easy-sync` cloud-control directory. */
export function communityPluginGenerationNamespaceRootV1(
  pluginId: string,
  generation: number,
): string {
  assertPluginId(pluginId);
  assertGeneration(generation);
  return `${CONTENT_ROOT}/plugins/${encodePluginId(pluginId)}/generations/${generation}`;
}

/**
 * Content-addressed and create-only. Re-uploading the same bytes is an
 * idempotent existence check; changing bytes necessarily chooses another path.
 */
export function communityPluginGenerationObjectPathV1(
  grant: Readonly<CommunityPluginGenerationContentGrantV1>,
  sha256Hash: string,
): string {
  if (!isCommunityPluginGenerationContentGrantV1(grant)) {
    throw new Error("Community plugin generation content grant is invalid");
  }
  if (!SHA256.test(sha256Hash)) {
    throw new Error("Community plugin generation content hash is invalid");
  }
  return `${grant.namespaceRoot}/objects/${sha256Hash}.bin`;
}

export async function prepareCommunityPluginGenerationBundleManifestV1(
  grant: Readonly<CommunityPluginGenerationContentGrantV1>,
  members: readonly Readonly<CommunityPluginGenerationContentObjectReceiptV1>[],
): Promise<PreparedCommunityPluginGenerationBundleManifestV1> {
  if (!isCommunityPluginGenerationContentGrantV1(grant)) {
    throw new Error("Community plugin generation content grant is invalid");
  }
  const canonicalMembers = validateAndSortBundleMembers(grant, members);
  const manifest: CommunityPluginGenerationBundleManifestV1 = {
    schemaVersion: 1,
    pluginId: grant.pluginId,
    generation: grant.generation,
    members: canonicalMembers,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(manifest));
  const bytes = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );
  const sha256Hash = await sha256Hex(bytes);
  return {
    manifest,
    bytes,
    sha256Hash,
    objectPath: communityPluginGenerationManifestObjectPathV1(
      grant,
      sha256Hash,
    ),
  };
}

export async function readCommunityPluginGenerationBundleManifestV1(
  content: ArrayBuffer,
  grant: Readonly<CommunityPluginGenerationContentGrantV1>,
  expectedSha256Hash: string,
): Promise<PreparedCommunityPluginGenerationBundleManifestV1 | null> {
  if (!isCommunityPluginGenerationContentGrantV1(grant)
    || !SHA256.test(expectedSha256Hash)) return null;
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.pluginId !== grant.pluginId
    || value.generation !== grant.generation
    || !Array.isArray(value.members)
    || !hasOnlyKeys(value, ["schemaVersion", "pluginId", "generation", "members"])) {
    return null;
  }
  const members: CommunityPluginGenerationContentObjectReceiptV1[] = [];
  for (const member of value.members) {
    if (!isBundleMember(member)) return null;
    members.push({ ...member });
  }
  try {
    const prepared = await prepareCommunityPluginGenerationBundleManifestV1(
      grant,
      members,
    );
    const canonicalText = new TextDecoder().decode(prepared.bytes);
    if (
      canonicalText !== text
      || prepared.bytes.byteLength !== content.byteLength
      || prepared.sha256Hash !== expectedSha256Hash
      || await sha256Hex(content) !== expectedSha256Hash
    ) return null;
    return prepared;
  } catch {
    return null;
  }
}

/**
 * Bind canonical manifest bytes to an already sealed generation and project
 * its members onto the Vault plugin paths. This is deliberately only planning
 * evidence: it performs no Graph read, Vault write, participation change or
 * ordinary V2 state publication.
 */
export async function createCommunityPluginGenerationRestoreProjectionV1(
  input: Readonly<{
    control: Readonly<CommunityPluginLifecycleControlV1>;
    scope: Readonly<SyncScope>;
    participant: Readonly<CommunityPluginParticipantIdentityV1>;
    pluginId: string;
    configDir: string;
    controlRecordId: string;
    manifestContent: ArrayBuffer;
  }>,
): Promise<CommunityPluginGenerationRestoreProjectionResultV1> {
  const configDir = canonicalConfigDir(input.configDir);
  if (!configDir) return { status: "blocked", reason: "invalid-target-root" };
  if (!input.controlRecordId) return { status: "blocked", reason: "invalid-grant" };
  const grantResult = createCommunityPluginGenerationContentGrantV1(input);
  if (grantResult.status !== "ready") return grantResult;
  const { grant } = grantResult;
  const plugin = input.control.pluginsById[input.pluginId];
  const seal = plugin?.legacyAuthoritySeal;
  const published = communityPluginAuthoritativePublishedBundleV1(plugin);
  if (!seal || !published) {
    return { status: "blocked", reason: "legacy-authority-unsealed" };
  }
  const manifestObject = published.manifestObject;
  if (input.manifestContent.byteLength !== manifestObject.size) {
    return { status: "blocked", reason: "manifest-object-changed" };
  }
  const prepared = await readCommunityPluginGenerationBundleManifestV1(
    input.manifestContent,
    grant,
    manifestObject.sha256Hash,
  );
  if (!prepared) return { status: "blocked", reason: "manifest-invalid" };
  if (
    prepared.objectPath !== manifestObject.objectPath
    || prepared.sha256Hash !== manifestObject.sha256Hash
  ) {
    return { status: "blocked", reason: "manifest-object-changed" };
  }
  const root = `${configDir}/plugins/${input.pluginId}`;
  return {
    status: "ready",
    projection: {
      schemaVersion: 1,
      capability: "restore-sealed-generation-bundle",
      scope: { ...input.scope },
      participant: { ...input.participant },
      pluginId: input.pluginId,
      generation: grant.generation,
      joinNonce: grant.joinNonce,
      controlRecordId: input.controlRecordId,
      observedControlRevision: input.control.revision,
      fenceEpoch: input.control.fenceEpoch,
      sealRevision: seal.sealedRevision,
      configDir,
      manifestObject: { ...manifestObject },
      members: prepared.manifest.members.map((member) => ({
        fileName: member.fileName,
        targetPath: `${root}/${member.fileName}`,
        source: { ...member },
      })),
    },
  };
}

/**
 * Recheck a previously prepared restore immediately before any byte transfer.
 * Observation-only control revisions may advance, but a fence, join, seal,
 * published pointer or canonical target change invalidates the projection.
 */
export function validateCommunityPluginGenerationRestoreProjectionV1(
  projection: Readonly<CommunityPluginGenerationRestoreProjectionV1>,
  control: Readonly<CommunityPluginLifecycleControlV1>,
  controlRecordId: string,
): { status: "valid" } | {
  status: "blocked";
  reason: CommunityPluginGenerationRestoreBlockReasonV1;
} {
  if (!isCommunityPluginGenerationRestoreProjectionV1(projection)) {
    return { status: "blocked", reason: "invalid-grant" };
  }
  if (projection.controlRecordId !== controlRecordId) {
    return { status: "blocked", reason: "control-record-changed" };
  }
  if (!sameSyncScope(projection.scope, control.scope)) {
    return { status: "blocked", reason: "scope-mismatch" };
  }
  if (control.revision < projection.observedControlRevision) {
    return { status: "blocked", reason: "control-revision-regressed" };
  }
  if (control.fenceEpoch !== projection.fenceEpoch) {
    return { status: "blocked", reason: "fence-changed" };
  }
  const grantResult = createCommunityPluginGenerationContentGrantV1({
    control,
    scope: projection.scope,
    participant: projection.participant,
    pluginId: projection.pluginId,
  });
  if (grantResult.status !== "ready") return grantResult;
  const grant = grantResult.grant;
  if (
    grant.generation !== projection.generation
    || grant.joinNonce !== projection.joinNonce
  ) return { status: "blocked", reason: "join-changed" };
  const plugin = control.pluginsById[projection.pluginId];
  const seal = plugin?.legacyAuthoritySeal;
  const published = communityPluginAuthoritativePublishedBundleV1(plugin);
  if (
    !seal
    || !published
    || seal.sealedRevision !== projection.sealRevision
  ) return { status: "blocked", reason: "legacy-authority-unsealed" };
  if (!samePublishedManifestObject(
    projection.manifestObject,
    published.manifestObject,
  )) return { status: "blocked", reason: "manifest-object-changed" };
  try {
    const canonicalMembers = validateAndSortBundleMembers(
      grant,
      projection.members.map((member) => member.source),
    );
    const root = `${projection.configDir}/plugins/${projection.pluginId}`;
    if (
      canonicalMembers.length !== projection.members.length
      || projection.members.some((member, index) =>
        member.fileName !== canonicalMembers[index].fileName
        || member.targetPath !== `${root}/${member.fileName}`
        || !sameGenerationObjectReceipt(member.source, canonicalMembers[index])
      )
    ) return { status: "blocked", reason: "invalid-grant" };
  } catch {
    return { status: "blocked", reason: "invalid-grant" };
  }
  return { status: "valid" };
}

/**
 * Convert already-validated sealed-generation evidence into ordinary canonical
 * Download actions while retaining the immutable source path and lifecycle
 * authorization. This is still a pure plan projection: it does not read Graph,
 * write the Vault or publish ordinary V2 state.
 */
export function projectCommunityPluginGenerationRestorePlanItemsV1(
  projection: Readonly<CommunityPluginGenerationRestoreProjectionV1>,
): SyncPlanItem[] {
  if (!isCommunityPluginGenerationRestoreProjectionV1(projection)) {
    throw new Error("Community plugin generation restore projection is invalid");
  }
  const generationRestore = {
    schemaVersion: 1 as const,
    pluginId: projection.pluginId,
    participant: { ...projection.participant },
    generation: projection.generation,
    joinNonce: projection.joinNonce,
    controlRecordId: projection.controlRecordId,
    fenceEpoch: projection.fenceEpoch,
    sealRevision: projection.sealRevision,
    manifestObject: { ...projection.manifestObject },
  };
  return projection.members.map((member) => ({
    type: SyncActionType.Download,
    path: member.targetPath,
    remote: {
      path: member.source.objectPath,
      driveId: member.source.remoteId,
      parentId: member.source.parentId,
      size: member.source.size,
      mtime: 0,
      eTag: member.source.eTag,
      cTag: member.source.cTag,
      sha256Hash: member.source.sha256Hash,
    },
    generationRestore: structuredClone(generationRestore),
  }));
}

/** Manifest objects are immutable and content-addressed like their members. */
export function communityPluginGenerationManifestObjectPathV1(
  grant: Readonly<CommunityPluginGenerationContentGrantV1>,
  sha256Hash: string,
): string {
  if (!isCommunityPluginGenerationContentGrantV1(grant)) {
    throw new Error("Community plugin generation content grant is invalid");
  }
  if (!SHA256.test(sha256Hash)) {
    throw new Error("Community plugin generation manifest hash is invalid");
  }
  return communityPluginPublishedManifestObjectPathV1(
    grant.pluginId,
    grant.generation,
    sha256Hash,
  );
}

/**
 * Turn an externally verified immutable manifest object into the one CAS
 * command that may select it. No content object becomes current before this
 * command is accepted by the lifecycle reducer and cloud If-Match write.
 */
export async function createCommunityPluginBundlePublicationCommandV1(input: Readonly<{
  grant: Readonly<CommunityPluginGenerationContentGrantV1>;
  control: Readonly<CommunityPluginLifecycleControlV1>;
  prepared: Readonly<PreparedCommunityPluginGenerationBundleManifestV1>;
  manifestObject: Readonly<CommunityPluginPublishedManifestObjectV1>;
  operationId: string;
  at: number;
}>): Promise<CommunityPluginLifecycleCommandV1> {
  const validation = validateCommunityPluginGenerationContentGrantV1(
    input.grant,
    input.control,
  );
  if (validation.status !== "valid") {
    throw new Error(`Community plugin publication grant is stale: ${validation.reason}`);
  }
  const rebuilt = await prepareCommunityPluginGenerationBundleManifestV1(
    input.grant,
    input.prepared.manifest.members,
  );
  if (
    rebuilt.sha256Hash !== input.prepared.sha256Hash
    || rebuilt.objectPath !== input.prepared.objectPath
    || rebuilt.bytes.byteLength !== input.prepared.bytes.byteLength
    || await sha256Hex(input.prepared.bytes) !== input.prepared.sha256Hash
  ) {
    throw new Error("Community plugin generation bundle manifest changed before publication");
  }
  if (
    input.manifestObject.sha256Hash !== rebuilt.sha256Hash
    || input.manifestObject.objectPath !== rebuilt.objectPath
    || input.manifestObject.size !== rebuilt.bytes.byteLength
    || !input.manifestObject.remoteId
    || !input.manifestObject.parentId
    || (!input.manifestObject.eTag && !input.manifestObject.cTag)
  ) {
    throw new Error("Community plugin generation manifest read-back is incomplete");
  }
  return {
    type: "publish-plugin-bundle",
    operationId: input.operationId,
    expectedRevision: input.control.revision,
    scope: { ...input.control.scope },
    at: input.at,
    participant: { ...input.grant.participant },
    pluginId: input.grant.pluginId,
    generation: input.grant.generation,
    joinNonce: input.grant.joinNonce,
    fenceEpoch: input.grant.fenceEpoch,
    manifestObject: { ...input.manifestObject },
  };
}

export function parseCommunityPluginGenerationObjectPathV1(
  path: string,
): CommunityPluginGenerationObjectPathV1 | null {
  const match = new RegExp(
    `^${CONTENT_ROOT}/plugins/([0-9a-f]+)/generations/([1-9][0-9]*)/objects/([0-9a-f]{64})\\.bin$`,
  ).exec(path);
  if (!match) return null;
  const pluginId = decodePluginId(match[1]);
  if (!pluginId) return null;
  const generation = Number(match[2]);
  if (!Number.isSafeInteger(generation)) return null;
  return {
    pluginId,
    generation,
    sha256Hash: match[3].toLowerCase(),
  };
}

export function isCommunityPluginGenerationContentGrantV1(
  value: unknown,
): value is CommunityPluginGenerationContentGrantV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.capability !== "stage-immutable-object"
    || !isSyncScope(value.scope)
    || !isParticipant(value.participant)
    || typeof value.pluginId !== "string"
    || !SAFE_PLUGIN_ID.test(value.pluginId)
    || !positiveInteger(value.generation)
    || typeof value.joinNonce !== "string"
    || value.joinNonce.length < 8
    || !positiveInteger(value.observedControlRevision)
    || !nonNegativeInteger(value.fenceEpoch)
    || typeof value.namespaceRoot !== "string"
    || value.namespaceRoot !== communityPluginGenerationNamespaceRootV1(
      value.pluginId,
      Number(value.generation),
    )) return false;
  return Object.keys(value).every((key) => [
    "schemaVersion",
    "capability",
    "scope",
    "participant",
    "pluginId",
    "generation",
    "joinNonce",
    "observedControlRevision",
    "fenceEpoch",
    "namespaceRoot",
  ].includes(key));
}

function isCommunityPluginGenerationRestoreProjectionV1(
  value: unknown,
): value is CommunityPluginGenerationRestoreProjectionV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.capability !== "restore-sealed-generation-bundle"
    || !isSyncScope(value.scope)
    || !isParticipant(value.participant)
    || typeof value.pluginId !== "string"
    || !SAFE_PLUGIN_ID.test(value.pluginId)
    || !positiveInteger(value.generation)
    || typeof value.joinNonce !== "string"
    || value.joinNonce.length < 8
    || typeof value.controlRecordId !== "string"
    || value.controlRecordId.length === 0
    || !positiveInteger(value.observedControlRevision)
    || !nonNegativeInteger(value.fenceEpoch)
    || !positiveInteger(value.sealRevision)
    || typeof value.configDir !== "string"
    || canonicalConfigDir(value.configDir) !== value.configDir
    || !isPublishedManifestObjectShape(value.manifestObject)
    || !Array.isArray(value.members)
    || !value.members.every(isRestoreMember)) return false;
  return Object.keys(value).every((key) => [
    "schemaVersion",
    "capability",
    "scope",
    "participant",
    "pluginId",
    "generation",
    "joinNonce",
    "controlRecordId",
    "observedControlRevision",
    "fenceEpoch",
    "sealRevision",
    "configDir",
    "manifestObject",
    "members",
  ].includes(key));
}

function assertPluginId(pluginId: string): void {
  if (!SAFE_PLUGIN_ID.test(pluginId)) {
    throw new Error("Community plugin id is invalid");
  }
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("Community plugin generation is invalid");
  }
}

function isParticipant(value: unknown): value is CommunityPluginParticipantIdentityV1 {
  return isRecord(value)
    && typeof value.participantId === "string"
    && SAFE_PARTICIPANT_ID.test(value.participantId)
    && typeof value.incarnation === "string"
    && SAFE_PARTICIPANT_ID.test(value.incarnation)
    && Object.keys(value).every((key) =>
      key === "participantId" || key === "incarnation");
}

function validateAndSortBundleMembers(
  grant: Readonly<CommunityPluginGenerationContentGrantV1>,
  members: readonly Readonly<CommunityPluginGenerationContentObjectReceiptV1>[],
): CommunityPluginGenerationContentObjectReceiptV1[] {
  const allowed = new Set<CommunityPluginGenerationBundleFileNameV1>([
    "main.js",
    "manifest.json",
    "styles.css",
  ]);
  const seen = new Set<CommunityPluginGenerationBundleFileNameV1>();
  const canonical: CommunityPluginGenerationContentObjectReceiptV1[] = [];
  for (const member of members) {
    if (!allowed.has(member.fileName) || seen.has(member.fileName)) {
      throw new Error("Community plugin generation bundle members are invalid");
    }
    if (!SHA256.test(member.sha256Hash)
      || member.objectPath !== communityPluginGenerationObjectPathV1(
        grant,
        member.sha256Hash,
      )
      || !member.remoteId
      || member.remoteId.length > 512
      || !member.parentId
      || member.parentId.length > 512
      || !Number.isSafeInteger(member.size)
      || member.size < 0
      || typeof member.eTag !== "string"
      || member.eTag.length > 512
      || typeof member.cTag !== "string"
      || member.cTag.length > 512
      || (!member.eTag && !member.cTag)) {
      throw new Error("Community plugin generation object receipt is invalid");
    }
    seen.add(member.fileName);
    canonical.push({ ...member });
  }
  if (!seen.has("main.js") || !seen.has("manifest.json")) {
    throw new Error("Community plugin generation bundle is incomplete");
  }
  return canonical.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function isBundleMember(
  value: unknown,
): value is CommunityPluginGenerationContentObjectReceiptV1 {
  return isRecord(value)
    && ["main.js", "manifest.json", "styles.css"].includes(String(value.fileName))
    && typeof value.objectPath === "string"
    && typeof value.remoteId === "string"
    && typeof value.parentId === "string"
    && typeof value.size === "number"
    && typeof value.eTag === "string"
    && typeof value.cTag === "string"
    && typeof value.sha256Hash === "string"
    && hasOnlyKeys(value, [
      "fileName",
      "objectPath",
      "remoteId",
      "parentId",
      "size",
      "eTag",
      "cTag",
      "sha256Hash",
    ]);
}

function isRestoreMember(
  value: unknown,
): value is CommunityPluginGenerationRestoreMemberV1 {
  return isRecord(value)
    && ["main.js", "manifest.json", "styles.css"].includes(String(value.fileName))
    && typeof value.targetPath === "string"
    && isBundleMember(value.source)
    && hasOnlyKeys(value, ["fileName", "targetPath", "source"]);
}

function isPublishedManifestObjectShape(
  value: unknown,
): value is CommunityPluginPublishedManifestObjectV1 {
  return isRecord(value)
    && typeof value.objectPath === "string"
    && typeof value.remoteId === "string"
    && typeof value.parentId === "string"
    && typeof value.size === "number"
    && typeof value.eTag === "string"
    && typeof value.cTag === "string"
    && typeof value.sha256Hash === "string";
}

function samePublishedManifestObject(
  left: Readonly<CommunityPluginPublishedManifestObjectV1>,
  right: Readonly<CommunityPluginPublishedManifestObjectV1>,
): boolean {
  return left.objectPath === right.objectPath
    && left.remoteId === right.remoteId
    && left.parentId === right.parentId
    && left.size === right.size
    && left.eTag === right.eTag
    && left.cTag === right.cTag
    && left.sha256Hash === right.sha256Hash;
}

function sameGenerationObjectReceipt(
  left: Readonly<CommunityPluginGenerationContentObjectReceiptV1>,
  right: Readonly<CommunityPluginGenerationContentObjectReceiptV1>,
): boolean {
  return left.fileName === right.fileName
    && left.objectPath === right.objectPath
    && left.remoteId === right.remoteId
    && left.parentId === right.parentId
    && left.size === right.size
    && left.eTag === right.eTag
    && left.cTag === right.cTag
    && left.sha256Hash === right.sha256Hash;
}

function canonicalConfigDir(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").normalize("NFC")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return normalized;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function encodePluginId(pluginId: string): string {
  return [...pluginId].map((character) =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function decodePluginId(encoded: string): string | null {
  if (encoded.length % 2 !== 0) return null;
  let pluginId = "";
  for (let index = 0; index < encoded.length; index += 2) {
    pluginId += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 2), 16));
  }
  return SAFE_PLUGIN_ID.test(pluginId) && encodePluginId(pluginId) === encoded
    ? pluginId
    : null;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
