import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  createOneDriveCommunityPluginGenerationContentTransportV1,
  stageCommunityPluginGenerationBundleV1,
  stageCommunityPluginGenerationBundleManifestV1,
  stageCommunityPluginGenerationBundleMemberV1,
  type CommunityPluginGenerationContentCloudTransportV1,
} from "../src/sync/community-plugin-generation-content-cloud-v1";
import {
  createCommunityPluginGenerationContentGrantV1,
  prepareCommunityPluginGenerationBundleManifestV1,
  type CommunityPluginGenerationContentGrantV1,
} from "../src/sync/community-plugin-generation-content-v1";
import {
  createCommunityPluginLifecycleControlV1,
  reduceCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
} from "../src/sync/community-plugin-lifecycle-v1";

const scope = {
  accountId: "account-s8c",
  driveId: "drive-s8c",
  vaultFolderId: "vault-s8c",
  filesRootId: "files-s8c",
};
const participant = {
  participantId: "participant-s8c",
  incarnation: "incarnation-s8c",
};

function apply(
  state: CommunityPluginLifecycleControlV1,
  command: Omit<CommunityPluginLifecycleCommandV1, "scope" | "expectedRevision">,
): CommunityPluginLifecycleControlV1 {
  const result = reduceCommunityPluginLifecycleV1(state, {
    ...command,
    scope,
    expectedRevision: state.revision,
  } as CommunityPluginLifecycleCommandV1);
  if (result.status !== "applied") throw new Error(`fixture command ${result.status}`);
  return result.state;
}

function fixture(): {
  state: CommunityPluginLifecycleControlV1;
  grant: CommunityPluginGenerationContentGrantV1;
} {
  let state = createCommunityPluginLifecycleControlV1(scope);
  state = apply(state, {
    type: "register-participant",
    participant,
    operationId: "register-s8c",
    at: 10,
  });
  state = apply(state, {
    type: "join-plugin",
    participant,
    pluginId: "calendar",
    targetGeneration: 1,
    joinNonce: "join-calendar-s8c",
    joinEvidence: "host-install",
    operationId: "join-calendar-s8c",
    at: 11,
  });
  const grantResult = createCommunityPluginGenerationContentGrantV1({
    control: state,
    scope,
    participant,
    pluginId: "calendar",
  });
  if (grantResult.status !== "ready") throw new Error("grant fixture missing");
  return { state, grant: grantResult.grant };
}

async function cloudObject(
  objectPath: string,
  content: ArrayBuffer,
  overrides: Partial<{
    id: string;
    name: string;
    parentId: string;
    size: number;
    eTag: string;
    cTag: string;
    content: ArrayBuffer;
  }> = {},
) {
  return {
    id: "object-id",
    name: objectPath.split("/").at(-1)!,
    parentId: "parent-id",
    size: content.byteLength,
    eTag: "object-etag",
    cTag: "object-ctag",
    content,
    ...overrides,
  };
}

function transportHarness(): {
  transport: CommunityPluginGenerationContentCloudTransportV1;
  createOnly: ReturnType<typeof vi.fn>;
  readByPath: ReturnType<typeof vi.fn>;
  readById: ReturnType<typeof vi.fn>;
} {
  const createOnly = vi.fn();
  const readByPath = vi.fn();
  const readById = vi.fn();
  return {
    transport: { createOnly, readByPath, readById },
    createOnly,
    readByPath,
    readById,
  };
}

describe("community-plugin generation S8c immutable cloud staging", () => {
  it("stages one complete bundle and repeats it only through immutable read-back", async () => {
    const { state, grant } = fixture();
    const cloud = transportHarness();
    const objects = new Map<string, Awaited<ReturnType<typeof cloudObject>>>();
    cloud.createOnly.mockImplementation(async (objectPath: string, content: ArrayBuffer) => {
      if (objects.has(objectPath)) throw new Error("name conflict");
      const object = await cloudObject(objectPath, content, {
        id: `id-${objects.size + 1}`,
        parentId: "generation-parent",
      });
      objects.set(objectPath, object);
      return {
        id: object.id,
        name: object.name,
        size: object.size,
        eTag: object.eTag,
        cTag: object.cTag,
        parentReference: { id: object.parentId },
      };
    });
    cloud.readById.mockImplementation(async (id: string) => {
      const object = [...objects.values()].find((candidate) => candidate.id === id);
      if (!object) throw new Error("missing object");
      return object;
    });
    cloud.readByPath.mockImplementation(async (objectPath: string) =>
      objects.get(objectPath) ?? null);
    const files = [
      { fileName: "main.js" as const, content: new TextEncoder().encode("main").buffer },
      {
        fileName: "manifest.json" as const,
        content: new TextEncoder().encode('{"id":"calendar"}').buffer,
      },
      { fileName: "styles.css" as const, content: new TextEncoder().encode("body{}").buffer },
    ];

    const first = await stageCommunityPluginGenerationBundleV1({
      transport: cloud.transport,
      grant,
      control: state,
      files,
    });
    expect(first).toMatchObject({
      status: "ready",
      source: "created",
      receipt: {
        members: [
          { fileName: "main.js" },
          { fileName: "manifest.json" },
          { fileName: "styles.css" },
        ],
        manifestObject: { parentId: "generation-parent" },
      },
    });
    expect(objects.size).toBe(4);

    await expect(stageCommunityPluginGenerationBundleV1({
      transport: cloud.transport,
      grant,
      control: state,
      files,
    })).resolves.toMatchObject({ status: "ready", source: "existing" });
    expect(objects.size).toBe(4);
    expect(cloud.readByPath).toHaveBeenCalledTimes(4);
  });

  it("rejects an incomplete bundle before creating any immutable object", async () => {
    const { state, grant } = fixture();
    const cloud = transportHarness();
    await expect(stageCommunityPluginGenerationBundleV1({
      transport: cloud.transport,
      grant,
      control: state,
      files: [{
        fileName: "main.js",
        content: new TextEncoder().encode("main").buffer,
      }],
    })).resolves.toEqual({ status: "blocked", reason: "invalid-content" });
    expect(cloud.createOnly).not.toHaveBeenCalled();
  });

  it("creates and strictly reads back one content-addressed bundle member", async () => {
    const { state, grant } = fixture();
    const content = new TextEncoder().encode("plugin-main").buffer;
    const hash = await sha256Hex(content);
    const objectPath = `${grant.namespaceRoot}/objects/${hash}.bin`;
    const object = await cloudObject(objectPath, content);
    const cloud = transportHarness();
    cloud.createOnly.mockResolvedValue({
      id: object.id,
      name: object.name,
      size: object.size,
      eTag: object.eTag,
      cTag: object.cTag,
      parentReference: { id: object.parentId },
    });
    cloud.readById.mockResolvedValue(object);

    await expect(stageCommunityPluginGenerationBundleMemberV1({
      transport: cloud.transport,
      grant,
      control: state,
      fileName: "main.js",
      content,
    })).resolves.toEqual({
      status: "ready",
      source: "created",
      receipt: {
        fileName: "main.js",
        objectPath,
        remoteId: "object-id",
        parentId: "parent-id",
        size: content.byteLength,
        eTag: "object-etag",
        cTag: "object-ctag",
        sha256Hash: hash,
      },
    });
    expect(cloud.readById).toHaveBeenCalledWith("object-id", content.byteLength);
    expect(cloud.readByPath).not.toHaveBeenCalled();
  });

  it("accepts a create conflict only after the existing exact path hashes identically", async () => {
    const { state, grant } = fixture();
    const content = new TextEncoder().encode("existing-main").buffer;
    const hash = await sha256Hex(content);
    const objectPath = `${grant.namespaceRoot}/objects/${hash}.bin`;
    const cloud = transportHarness();
    cloud.createOnly.mockRejectedValue(new Error("409"));
    cloud.readByPath.mockResolvedValue(await cloudObject(objectPath, content));

    await expect(stageCommunityPluginGenerationBundleMemberV1({
      transport: cloud.transport,
      grant,
      control: state,
      fileName: "main.js",
      content,
    })).resolves.toMatchObject({ status: "ready", source: "existing" });
    expect(cloud.readById).not.toHaveBeenCalled();
  });

  it("blocks a tainted content-addressed path and never overwrites it", async () => {
    const { state, grant } = fixture();
    const content = new TextEncoder().encode("expected-main").buffer;
    const hash = await sha256Hex(content);
    const objectPath = `${grant.namespaceRoot}/objects/${hash}.bin`;
    const cloud = transportHarness();
    cloud.createOnly.mockRejectedValue(new Error("409"));
    cloud.readByPath.mockResolvedValue(await cloudObject(
      objectPath,
      new TextEncoder().encode("tampered-main").buffer,
      { size: content.byteLength },
    ));

    await expect(stageCommunityPluginGenerationBundleMemberV1({
      transport: cloud.transport,
      grant,
      control: state,
      fileName: "main.js",
      content,
    })).resolves.toEqual({ status: "blocked", reason: "readback-mismatch" });
    expect(cloud.createOnly).toHaveBeenCalledTimes(1);
  });

  it("returns retry without authority when create outcome cannot be read", async () => {
    const { state, grant } = fixture();
    const cloud = transportHarness();
    cloud.createOnly.mockRejectedValue(new Error("response lost"));
    cloud.readByPath.mockRejectedValue(new Error("offline"));

    await expect(stageCommunityPluginGenerationBundleMemberV1({
      transport: cloud.transport,
      grant,
      control: state,
      fileName: "main.js",
      content: new TextEncoder().encode("main").buffer,
    })).resolves.toEqual({ status: "retry", reason: "create-outcome-unknown" });
  });

  it("stops before Graph when the participant grant has been retired", async () => {
    const { state, grant } = fixture();
    const replacement = {
      participantId: "participant-replacement",
      incarnation: "incarnation-replacement",
    };
    let retired = apply(state, {
      type: "register-participant",
      participant: replacement,
      operationId: "register-replacement",
      at: 12,
    });
    retired = apply(retired, {
      type: "retire-participant",
      actor: replacement,
      target: participant,
      operationId: "retire-original",
      at: 13,
    });
    const cloud = transportHarness();

    await expect(stageCommunityPluginGenerationBundleMemberV1({
      transport: cloud.transport,
      grant,
      control: retired,
      fileName: "main.js",
      content: new TextEncoder().encode("main").buffer,
    })).resolves.toEqual({ status: "blocked", reason: "grant-stale" });
    expect(cloud.createOnly).not.toHaveBeenCalled();
  });

  it("stages only the canonical rebuilt manifest bytes", async () => {
    const { state, grant } = fixture();
    const memberContent = new TextEncoder().encode("member").buffer;
    const memberHash = await sha256Hex(memberContent);
    const prepared = await prepareCommunityPluginGenerationBundleManifestV1(grant, [
      {
        fileName: "main.js",
        objectPath: `${grant.namespaceRoot}/objects/${memberHash}.bin`,
        remoteId: "main-id",
        parentId: "objects-id",
        size: memberContent.byteLength,
        eTag: "main-etag",
        cTag: "main-ctag",
        sha256Hash: memberHash,
      },
      {
        fileName: "manifest.json",
        objectPath: `${grant.namespaceRoot}/objects/${"b".repeat(64)}.bin`,
        remoteId: "plugin-manifest-id",
        parentId: "objects-id",
        size: 10,
        eTag: "plugin-manifest-etag",
        cTag: "plugin-manifest-ctag",
        sha256Hash: "b".repeat(64),
      },
    ]);
    const object = await cloudObject(prepared.objectPath, prepared.bytes, {
      id: "bundle-manifest-id",
      parentId: "manifests-id",
    });
    const cloud = transportHarness();
    cloud.createOnly.mockResolvedValue({
      id: object.id,
      name: object.name,
      size: object.size,
      eTag: object.eTag,
      cTag: object.cTag,
      parentReference: { id: object.parentId },
    });
    cloud.readById.mockResolvedValue(object);

    await expect(stageCommunityPluginGenerationBundleManifestV1({
      transport: cloud.transport,
      grant,
      control: state,
      prepared,
    })).resolves.toMatchObject({
      status: "ready",
      source: "created",
      receipt: {
        objectPath: prepared.objectPath,
        remoteId: "bundle-manifest-id",
        sha256Hash: prepared.sha256Hash,
      },
    });
  });

  it("keeps the production transport mutation-fenced without blocking read-back", async () => {
    const client = {
      createCommunityPluginGenerationObjectV1: vi.fn(),
      readCommunityPluginGenerationObjectV1: vi.fn().mockResolvedValue(null),
      readCommunityPluginGenerationObjectV1ById: vi.fn().mockResolvedValue({}),
    };
    const transport = createOneDriveCommunityPluginGenerationContentTransportV1(
      client as never,
      "Vault",
      () => false,
    );

    expect(() => transport.createOnly("community-plugin-content-v1/a", new ArrayBuffer(0)))
      .toThrow("invalidated");
    await expect(transport.readByPath("community-plugin-content-v1/a", 0))
      .resolves.toBeNull();
    expect(client.createCommunityPluginGenerationObjectV1).not.toHaveBeenCalled();

    const { state, grant } = fixture();
    await expect(stageCommunityPluginGenerationBundleMemberV1({
      transport,
      grant,
      control: state,
      fileName: "main.js",
      content: new TextEncoder().encode("main").buffer,
    })).resolves.toEqual({ status: "blocked", reason: "grant-stale" });
    expect(client.readCommunityPluginGenerationObjectV1).toHaveBeenCalledTimes(1);
  });
});
