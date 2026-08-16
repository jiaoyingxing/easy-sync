import { sha256Hex } from "../crypto";
import type { OneDriveClient } from "../onedrive/client";
import type {
  CommunityPluginGenerationCloudObjectV1,
  UploadResult,
} from "../onedrive/types";
import {
  communityPluginGenerationManifestObjectPathV1,
  communityPluginGenerationObjectPathV1,
  prepareCommunityPluginGenerationBundleManifestV1,
  validateCommunityPluginGenerationContentGrantV1,
  type CommunityPluginGenerationBundleFileNameV1,
  type CommunityPluginGenerationContentGrantV1,
  type CommunityPluginGenerationContentObjectReceiptV1,
  type PreparedCommunityPluginGenerationBundleManifestV1,
} from "./community-plugin-generation-content-v1";
import type {
  CommunityPluginLifecycleControlV1,
  CommunityPluginPublishedManifestObjectV1,
} from "./community-plugin-lifecycle-v1";

export interface CommunityPluginGenerationContentCloudTransportV1 {
  createOnly(objectPath: string, content: ArrayBuffer): Promise<UploadResult>;
  readByPath(
    objectPath: string,
    maxBytes: number,
  ): Promise<CommunityPluginGenerationCloudObjectV1 | null>;
  readById(
    id: string,
    maxBytes: number,
  ): Promise<CommunityPluginGenerationCloudObjectV1>;
}

export type CommunityPluginGenerationContentStageResultV1<T> =
  | { status: "ready"; source: "created" | "existing"; receipt: T }
  | {
    status: "retry";
    reason: "create-outcome-unknown" | "readback-unavailable";
  }
  | {
    status: "blocked";
    reason: "grant-stale" | "invalid-content" | "readback-mismatch";
  };

class CommunityPluginGenerationStagingInvalidatedError extends Error {
  constructor() {
    super("Generation content staging was invalidated");
    this.name = "CommunityPluginGenerationStagingInvalidatedError";
  }
}

export function createOneDriveCommunityPluginGenerationContentTransportV1(
  client: OneDriveClient,
  vaultName: string,
  canMutate: () => boolean = () => true,
): CommunityPluginGenerationContentCloudTransportV1 {
  return {
    createOnly: (objectPath, content) => {
      if (!canMutate()) throw new CommunityPluginGenerationStagingInvalidatedError();
      return client.createCommunityPluginGenerationObjectV1(
        vaultName,
        objectPath,
        content,
      );
    },
    readByPath: (objectPath, maxBytes) =>
      client.readCommunityPluginGenerationObjectV1(vaultName, objectPath, maxBytes),
    readById: (id, maxBytes) =>
      client.readCommunityPluginGenerationObjectV1ById(id, maxBytes),
  };
}

/** Stage one bundle member without making it current. */
export async function stageCommunityPluginGenerationBundleMemberV1(input: Readonly<{
  transport: CommunityPluginGenerationContentCloudTransportV1;
  grant: Readonly<CommunityPluginGenerationContentGrantV1>;
  control: Readonly<CommunityPluginLifecycleControlV1>;
  fileName: CommunityPluginGenerationBundleFileNameV1;
  content: ArrayBuffer;
}>): Promise<CommunityPluginGenerationContentStageResultV1<
  CommunityPluginGenerationContentObjectReceiptV1
>> {
  if (validateCommunityPluginGenerationContentGrantV1(input.grant, input.control).status
    !== "valid") {
    return { status: "blocked", reason: "grant-stale" };
  }
  const sha256Hash = await sha256Hex(input.content);
  let objectPath: string;
  try {
    objectPath = communityPluginGenerationObjectPathV1(input.grant, sha256Hash);
  } catch {
    return { status: "blocked", reason: "invalid-content" };
  }
  const staged = await stageImmutableObject(
    input.transport,
    objectPath,
    input.content,
    sha256Hash,
  );
  if (staged.status !== "ready") return staged;
  return {
    status: "ready",
    source: staged.source,
    receipt: {
      fileName: input.fileName,
      objectPath,
      remoteId: staged.object.id,
      parentId: staged.object.parentId,
      size: staged.object.size,
      eTag: staged.object.eTag,
      cTag: staged.object.cTag,
      sha256Hash,
    },
  };
}

/** Stage the already canonical manifest after independently rebuilding it. */
export async function stageCommunityPluginGenerationBundleManifestV1(input: Readonly<{
  transport: CommunityPluginGenerationContentCloudTransportV1;
  grant: Readonly<CommunityPluginGenerationContentGrantV1>;
  control: Readonly<CommunityPluginLifecycleControlV1>;
  prepared: Readonly<PreparedCommunityPluginGenerationBundleManifestV1>;
}>): Promise<CommunityPluginGenerationContentStageResultV1<
  CommunityPluginPublishedManifestObjectV1
>> {
  if (validateCommunityPluginGenerationContentGrantV1(input.grant, input.control).status
    !== "valid") {
    return { status: "blocked", reason: "grant-stale" };
  }
  let rebuilt: PreparedCommunityPluginGenerationBundleManifestV1;
  try {
    rebuilt = await prepareCommunityPluginGenerationBundleManifestV1(
      input.grant,
      input.prepared.manifest.members,
    );
  } catch {
    return { status: "blocked", reason: "invalid-content" };
  }
  if (
    rebuilt.sha256Hash !== input.prepared.sha256Hash
    || rebuilt.objectPath !== input.prepared.objectPath
    || rebuilt.bytes.byteLength !== input.prepared.bytes.byteLength
    || await sha256Hex(input.prepared.bytes) !== input.prepared.sha256Hash
    || rebuilt.objectPath !== communityPluginGenerationManifestObjectPathV1(
      input.grant,
      rebuilt.sha256Hash,
    )
  ) {
    return { status: "blocked", reason: "invalid-content" };
  }
  const staged = await stageImmutableObject(
    input.transport,
    rebuilt.objectPath,
    rebuilt.bytes,
    rebuilt.sha256Hash,
  );
  if (staged.status !== "ready") return staged;
  return {
    status: "ready",
    source: staged.source,
    receipt: {
      objectPath: rebuilt.objectPath,
      remoteId: staged.object.id,
      parentId: staged.object.parentId,
      size: staged.object.size,
      eTag: staged.object.eTag,
      cTag: staged.object.cTag,
      sha256Hash: rebuilt.sha256Hash,
    },
  };
}

/**
 * Stage one complete local bundle through the existing member and manifest
 * primitives. Immutable content-addressed objects make an interrupted attempt
 * safe to repeat; this function does not publish or seal the bundle.
 */
export async function stageCommunityPluginGenerationBundleV1(input: Readonly<{
  transport: CommunityPluginGenerationContentCloudTransportV1;
  grant: Readonly<CommunityPluginGenerationContentGrantV1>;
  control: Readonly<CommunityPluginLifecycleControlV1>;
  files: readonly Readonly<{
    fileName: CommunityPluginGenerationBundleFileNameV1;
    content: ArrayBuffer;
  }>[];
}>): Promise<CommunityPluginGenerationContentStageResultV1<{
  members: CommunityPluginGenerationContentObjectReceiptV1[];
  prepared: PreparedCommunityPluginGenerationBundleManifestV1;
  manifestObject: CommunityPluginPublishedManifestObjectV1;
}>> {
  const filesByName = new Map<CommunityPluginGenerationBundleFileNameV1, ArrayBuffer>();
  for (const file of input.files) {
    if (
      !(file.content instanceof ArrayBuffer)
      || filesByName.has(file.fileName)
      || !["main.js", "manifest.json", "styles.css"].includes(file.fileName)
    ) return { status: "blocked", reason: "invalid-content" };
    filesByName.set(file.fileName, file.content);
  }
  if (!filesByName.has("main.js") || !filesByName.has("manifest.json")) {
    return { status: "blocked", reason: "invalid-content" };
  }

  const members: CommunityPluginGenerationContentObjectReceiptV1[] = [];
  let allExisting = true;
  for (const fileName of ["main.js", "manifest.json", "styles.css"] as const) {
    const content = filesByName.get(fileName);
    if (!content) continue;
    const staged = await stageCommunityPluginGenerationBundleMemberV1({
      transport: input.transport,
      grant: input.grant,
      control: input.control,
      fileName,
      content,
    });
    if (staged.status !== "ready") return staged;
    if (staged.source === "created") allExisting = false;
    members.push(staged.receipt);
  }

  let prepared: PreparedCommunityPluginGenerationBundleManifestV1;
  try {
    prepared = await prepareCommunityPluginGenerationBundleManifestV1(
      input.grant,
      members,
    );
  } catch {
    return { status: "blocked", reason: "invalid-content" };
  }
  const stagedManifest = await stageCommunityPluginGenerationBundleManifestV1({
    transport: input.transport,
    grant: input.grant,
    control: input.control,
    prepared,
  });
  if (stagedManifest.status !== "ready") return stagedManifest;
  return {
    status: "ready",
    source: allExisting && stagedManifest.source === "existing" ? "existing" : "created",
    receipt: {
      members,
      prepared,
      manifestObject: stagedManifest.receipt,
    },
  };
}

async function stageImmutableObject(
  transport: CommunityPluginGenerationContentCloudTransportV1,
  objectPath: string,
  content: ArrayBuffer,
  sha256Hash: string,
): Promise<
  | { status: "ready"; source: "created" | "existing"; object: CommunityPluginGenerationCloudObjectV1 }
  | { status: "retry"; reason: "create-outcome-unknown" | "readback-unavailable" }
  | { status: "blocked"; reason: "grant-stale" | "readback-mismatch" }
> {
  let created: UploadResult | null = null;
  try {
    created = await transport.createOnly(objectPath, content);
  } catch (error) {
    if (error instanceof CommunityPluginGenerationStagingInvalidatedError) {
      return { status: "blocked", reason: "grant-stale" };
    }
    let existing: CommunityPluginGenerationCloudObjectV1 | null;
    try {
      existing = await transport.readByPath(objectPath, content.byteLength);
    } catch {
      return { status: "retry", reason: "create-outcome-unknown" };
    }
    if (!existing) return { status: "retry", reason: "create-outcome-unknown" };
    return await verifiedStageResult(existing, objectPath, content, sha256Hash, "existing");
  }
  if (!validCreateResult(created, objectPath, content.byteLength)) {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  let verified: CommunityPluginGenerationCloudObjectV1;
  try {
    verified = await transport.readById(created.id, content.byteLength);
  } catch {
    return { status: "retry", reason: "readback-unavailable" };
  }
  if (
    verified.id !== created.id
    || verified.name !== created.name
    || verified.parentId !== created.parentReference?.id
    || verified.size !== created.size
    || (created.eTag && verified.eTag !== created.eTag)
    || (created.cTag && verified.cTag !== created.cTag)
  ) {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  return verifiedStageResult(verified, objectPath, content, sha256Hash, "created");
}

async function verifiedStageResult(
  object: CommunityPluginGenerationCloudObjectV1,
  objectPath: string,
  content: ArrayBuffer,
  sha256Hash: string,
  source: "created" | "existing",
): Promise<
  | { status: "ready"; source: "created" | "existing"; object: CommunityPluginGenerationCloudObjectV1 }
  | { status: "blocked"; reason: "readback-mismatch" }
> {
  const pathSegments = objectPath.split("/");
  const expectedName = pathSegments[pathSegments.length - 1];
  if (
    !expectedName
    || object.name !== expectedName
    || !object.id
    || !object.parentId
    || object.size !== content.byteLength
    || object.content.byteLength !== content.byteLength
    || (!object.eTag && !object.cTag)
    || await sha256Hex(object.content) !== sha256Hash
    || await sha256Hex(content) !== sha256Hash
  ) {
    return { status: "blocked", reason: "readback-mismatch" };
  }
  return { status: "ready", source, object };
}

function validCreateResult(
  value: UploadResult,
  objectPath: string,
  size: number,
): boolean {
  const pathSegments = objectPath.split("/");
  return Boolean(value.id)
    && value.name === pathSegments[pathSegments.length - 1]
    && value.size === size
    && Boolean(value.parentReference?.id)
    && Boolean(value.eTag || value.cTag);
}
