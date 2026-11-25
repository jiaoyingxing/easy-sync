import { describe, expect, it } from "vitest";
import {
  buildS3ScopeFields,
  buildS3ScopeId,
  buildS3ScopeMarker,
  ensureS3ScopeMarker,
  readS3ScopeMarker,
  s3ScopeFieldsToSyncScope,
  s3ScopeMarkerKey,
  serializeS3ScopeMarker,
  type S3ScopeMarkerIo,
} from "../src/providers/s3/s3-scope";
import { isSyncScope, sameSyncScope, type SyncScope } from "../src/sync/types";

/**
 * S0 远端根占用（S3）：标记 create-only；不同库拒绝；同库换 scope 需显式
 * 接管；非空前缀无标记需显式确认，确认前零写入、零计划。
 */
const ROOT = "Root/Docs";
const BASE = {
  endpoint: "https://S3.Example.com:443",
  region: "US-East-1",
  bucket: "my-bucket",
  rootPath: "/Root/Docs/",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
} as const;
const CREATED_AT = new Date("2026-11-17T00:00:00.000Z");

async function localIdentity(overrides: Partial<typeof BASE> = {}) {
  const fields = await buildS3ScopeFields({ ...BASE, ...overrides });
  const scopeId = await buildS3ScopeId(fields);
  const marker = buildS3ScopeMarker({
    vaultName: "MyVault",
    scopeId,
    createdAt: CREATED_AT,
  });
  return { fields, scopeId, marker };
}

function makeIo(options: {
  rootPath?: string;
  markerText?: string;
  objects?: readonly string[];
  raceWith?: string;
  isTruncated?: boolean;
} = {}) {
  const rootPath = options.rootPath ?? ROOT;
  const markerKey = s3ScopeMarkerKey(rootPath);
  const objects = new Map<string, string>();
  if (options.markerText !== undefined) objects.set(markerKey, options.markerText);
  for (const key of options.objects ?? []) objects.set(key, "user-content");
  const writes: Array<{ key: string; text: string; createOnly: boolean }> = [];
  let raced = false;
  const io: S3ScopeMarkerIo = {
    head: async (key) => ({ exists: objects.has(key) }),
    readText: async (key) => objects.get(key) ?? null,
    writeCreateOnly: async (key, text) => {
      if (options.raceWith !== undefined && !raced) {
        raced = true;
        objects.set(key, options.raceWith);
        return false;
      }
      if (objects.has(key)) return false;
      objects.set(key, text);
      writes.push({ key, text, createOnly: true });
      return true;
    },
    writeReplace: async (key, text) => {
      objects.set(key, text);
      writes.push({ key, text, createOnly: false });
    },
    list: async (prefix) => ({
      objects: [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key]) => ({ key, size: 1 })),
      isTruncated: options.isTruncated === true,
    }),
  };
  return { io, objects, writes };
}

describe("S3 scope marker create-only initialization", () => {
  it("creates the marker once when no marker and no existing content", async () => {
    const { marker } = await localIdentity();
    const fake = makeIo();

    const result = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
    });

    expect(result.action).toBe("initialize");
    expect(result.mayWrite).toBe(true);
    expect(result.markerWritten).toBe(true);
    expect(result.markerKey).toBe(`${ROOT}/.easy-sync/scope.json`);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].createOnly).toBe(true);
    expect(await readS3ScopeMarker(fake.io, ROOT)).toEqual(marker);
    const raw = fake.objects.get(result.markerKey)!;
    expect(raw).not.toContain("AKIA");
    expect(raw).not.toContain("secret");
  });

  it("accepts an existing matching marker without writing", async () => {
    const { marker } = await localIdentity();
    const fake = makeIo({ markerText: serializeS3ScopeMarker(marker) });

    const result = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: true,
    });

    expect(result.action).toBe("accept");
    expect(result.mayWrite).toBe(true);
    expect(result.markerWritten).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  it("refuses a marker from another vault with a different scope", async () => {
    const { scopeId: otherScopeId } = await localIdentity({ bucket: "other-bucket" });
    const otherMarker = buildS3ScopeMarker({
      vaultName: "OtherVault",
      scopeId: otherScopeId,
      createdAt: CREATED_AT,
    });
    const fake = makeIo({ markerText: serializeS3ScopeMarker(otherMarker) });
    const { marker } = await localIdentity();

    const result = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: true,
    });

    expect(result.action).toBe("refuse");
    expect(result.mayWrite).toBe(false);
    expect(result.markerWritten).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });

  it("refuses the same scope id under a different vault name", async () => {
    const { marker } = await localIdentity();
    const sameScopeOtherVault = buildS3ScopeMarker({
      vaultName: "OtherVault",
      scopeId: marker.scopeId,
      createdAt: CREATED_AT,
    });
    const fake = makeIo({
      markerText: serializeS3ScopeMarker(sameScopeOtherVault),
    });

    const result = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: true,
    });

    expect(result.action).toBe("refuse");
    expect(result.mayWrite).toBe(false);
    expect(result.markerWritten).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });
});
describe("S3 scope marker takeover", () => {
  it("requires explicit confirmation for the same vault with a different scope", async () => {
    const { scopeId: otherScopeId } = await localIdentity({ bucket: "other-bucket" });
    const otherMarker = buildS3ScopeMarker({
      vaultName: "MyVault",
      scopeId: otherScopeId,
      createdAt: CREATED_AT,
    });
    const fake = makeIo({ markerText: serializeS3ScopeMarker(otherMarker) });
    const { marker } = await localIdentity();

    const pending = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
    });
    expect(pending.action).toBe("takeover-required");
    expect(pending.mayWrite).toBe(false);
    expect(pending.reason).toContain("local state is missing");
    expect(fake.writes).toHaveLength(0);

    const takenOver = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
      confirmTakeover: true,
    });
    expect(takenOver.action).toBe("takeover");
    expect(takenOver.mayWrite).toBe(true);
    expect(takenOver.markerWritten).toBe(true);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].createOnly).toBe(false);
    expect(await readS3ScopeMarker(fake.io, ROOT)).toEqual(marker);
  });

  it("accepts a raced identical create-only marker instead of overwriting", async () => {
    const { marker } = await localIdentity();
    const fake = makeIo({ raceWith: serializeS3ScopeMarker(marker) });

    const result = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: true,
    });

    expect(result.action).toBe("accept");
    expect(result.mayWrite).toBe(true);
    expect(result.markerWritten).toBe(false);
    expect(fake.writes).toHaveLength(0);
  });
});

describe("S3 non-empty prefix without a marker", () => {
  it("requires confirmation and performs zero writes before it", async () => {
    const { marker } = await localIdentity();
    const fake = makeIo({
      objects: [`${ROOT}/notes/a.md`, `${ROOT}/notes/b.md`],
    });

    const pending = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
    });

    expect(pending.action).toBe("existing-content-confirm");
    expect(pending.mayWrite).toBe(false);
    expect(pending.markerWritten).toBe(false);
    expect(pending.existingObjectCount).toBe(2);
    expect(fake.writes).toHaveLength(0);
    expect(fake.objects.has(s3ScopeMarkerKey(ROOT))).toBe(false);

    const confirmed = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
      confirmExistingContent: true,
    });
    expect(confirmed.action).toBe("initialize");
    expect(confirmed.mayWrite).toBe(true);
    expect(confirmed.existingObjectCount).toBe(2);
    expect(fake.writes).toHaveLength(1);
  });

  it("does not count control-plane objects as existing content", async () => {
    const { marker } = await localIdentity();
    const fake = makeIo({
      objects: [`${ROOT}/.easy-sync/probe/one`, `${ROOT}/.easy-sync-scope.json`],
    });

    const result = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
    });

    expect(result.action).toBe("initialize");
    expect(result.existingObjectCount).toBe(0);
  });

  it("requires confirmation for existing content at the bucket root", async () => {
    const { marker } = await localIdentity({ rootPath: "" });
    const fake = makeIo({
      rootPath: "",
      objects: ["notes/a.md", ".easy-sync/probe/one"],
    });

    const pending = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: "",
      marker,
      localStatePresent: false,
    });

    expect(pending.action).toBe("existing-content-confirm");
    expect(pending.mayWrite).toBe(false);
    expect(pending.markerWritten).toBe(false);
    expect(pending.existingObjectCount).toBe(1);
    expect(fake.writes).toHaveLength(0);

    const confirmed = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: "",
      marker,
      localStatePresent: false,
      confirmExistingContent: true,
    });
    expect(confirmed.action).toBe("initialize");
    expect(confirmed.mayWrite).toBe(true);
    expect(confirmed.existingObjectCount).toBe(1);
    expect(confirmed.markerKey).toBe(".easy-sync/scope.json");
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].createOnly).toBe(true);
    expect(fake.writes.some((write) => write.createOnly === false)).toBe(false);
  });

  it.each([
    { label: "an empty first page", objects: [] as string[] },
    {
      label: "a control-plane-only first page",
      objects: [`${ROOT}/.easy-sync/probe/one`],
    },
  ])("requires confirmation for a truncated LIST with $label", async ({ objects }) => {
    const { marker } = await localIdentity();
    const fake = makeIo({ objects, isTruncated: true });

    const pending = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
    });

    expect(pending.action).toBe("existing-content-confirm");
    expect(pending.mayWrite).toBe(false);
    expect(pending.markerWritten).toBe(false);
    expect(pending.existingObjectCount).toBe(0);
    expect(pending.reason).toContain("not listed");
    expect(fake.writes).toHaveLength(0);

    const confirmed = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
      confirmExistingContent: true,
    });
    expect(confirmed.action).toBe("initialize");
    expect(confirmed.mayWrite).toBe(true);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].createOnly).toBe(true);
  });

  it("requires confirmation when the LIST is truncated and already has content", async () => {
    const { marker } = await localIdentity();
    const fake = makeIo({
      objects: [`${ROOT}/notes/a.md`, `${ROOT}/.easy-sync/probe/one`],
      isTruncated: true,
    });

    const pending = await ensureS3ScopeMarker({
      io: fake.io,
      rootPath: ROOT,
      marker,
      localStatePresent: false,
    });

    expect(pending.action).toBe("existing-content-confirm");
    expect(pending.mayWrite).toBe(false);
    expect(pending.existingObjectCount).toBe(1);
    expect(fake.writes).toHaveLength(0);
  });
});

describe("S3 scope fields → SyncScope mapping", () => {
  it("derives the four legacy identities and carries all five fields", async () => {
    const { fields } = await localIdentity();
    const scope = s3ScopeFieldsToSyncScope(fields);

    expect(scope.accountId).toBe(fields.credentialBindingId);
    expect(scope.driveId).toBe(fields.containerId);
    expect(scope.vaultFolderId).toBe(fields.rootPath);
    expect(scope.filesRootId).toBe(fields.rootPath);
    expect(scope.providerKind).toBe("s3");
    expect(scope.endpointId).toBe(fields.endpointId);
    expect(scope.containerId).toBe(fields.containerId);
    expect(scope.rootPath).toBe(fields.rootPath);
    expect(scope.credentialBindingId).toBe(fields.credentialBindingId);
    expect(isSyncScope(scope)).toBe(true);
    expect(sameSyncScope(scope, JSON.parse(JSON.stringify(scope)) as SyncScope)).toBe(true);
  });

  it("uses the synthetic root id \"/\" for a bucket-root scope", async () => {
    const { fields } = await localIdentity({ rootPath: "" });
    const scope = s3ScopeFieldsToSyncScope(fields);

    expect(fields.rootPath).toBe("");
    expect(scope.rootPath).toBe("");
    expect(scope.vaultFolderId).toBe("/");
    expect(scope.filesRootId).toBe("/");
    expect(isSyncScope(scope)).toBe(true);
    expect(sameSyncScope(scope, s3ScopeFieldsToSyncScope(fields))).toBe(true);

    const sameBucketEmptyRoot = s3ScopeFieldsToSyncScope(
      await buildS3ScopeFields({ ...BASE, rootPath: "" }),
    );
    expect(sameSyncScope(scope, sameBucketEmptyRoot)).toBe(true);

    const otherBucket = s3ScopeFieldsToSyncScope(
      await buildS3ScopeFields({ ...BASE, rootPath: "", bucket: "other-bucket" }),
    );
    expect(sameSyncScope(scope, otherBucket)).toBe(false);

    const notesRoot = s3ScopeFieldsToSyncScope(
      await buildS3ScopeFields({ ...BASE, rootPath: "notes" }),
    );
    expect(notesRoot.vaultFolderId).toBe("notes");
    expect(notesRoot.filesRootId).toBe("notes");
    expect(sameSyncScope(scope, notesRoot)).toBe(false);
  });

  it("normalizes rootPath at the mapping boundary and rejects empty identity fields", async () => {
    const { fields } = await localIdentity({ rootPath: "" });

    const slashRoot = s3ScopeFieldsToSyncScope({ ...fields, rootPath: "/" });
    expect(slashRoot.rootPath).toBe("");
    expect(slashRoot.vaultFolderId).toBe("/");
    expect(slashRoot.filesRootId).toBe("/");
    expect(isSyncScope(slashRoot)).toBe(true);

    const trailingSlash = s3ScopeFieldsToSyncScope({
      ...fields,
      rootPath: "/notes/",
    });
    expect(trailingSlash.rootPath).toBe("notes");
    expect(trailingSlash.vaultFolderId).toBe("notes");
    expect(trailingSlash.filesRootId).toBe("notes");

    expect(() => s3ScopeFieldsToSyncScope({ ...fields, containerId: "" })).toThrow();
    expect(() => s3ScopeFieldsToSyncScope({ ...fields, endpointId: " " })).toThrow();
    expect(() => s3ScopeFieldsToSyncScope({ ...fields, credentialBindingId: "" })).toThrow();
  });
});
