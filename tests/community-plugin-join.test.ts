import { describe, expect, it } from "vitest";
import {
  createCommunityPluginJoinAuthorization,
  isCommunityPluginJoinBlockRetryable,
  validateCommunityPluginJoinAuthorization,
} from "../src/sync/community-plugin-join";
import type { RemoteCommunityPluginCatalogV1 } from
  "../src/sync/community-plugin-remote-catalog";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};

function catalog(): RemoteCommunityPluginCatalogV1 {
  return {
    version: 1,
    scope,
    complete: true,
    stale: false,
    revision: 7,
    observedAt: 1,
    sourceDigest: "f".repeat(64),
    entries: [{
      pluginId: "calendar",
      bundleState: "complete",
      bundleDigest: "a".repeat(64),
      members: [
        {
          path: ".obsidian/plugins/calendar/main.js",
          remoteId: "main-id",
          parentId: "calendar-folder",
          size: 4,
          mtime: 1,
          eTag: "main-etag",
          cTag: "main-ctag",
          sha256Hash: "b".repeat(64),
          quickXorHash: null,
        },
        {
          path: ".obsidian/plugins/calendar/manifest.json",
          remoteId: "manifest-id",
          parentId: "calendar-folder",
          size: 8,
          mtime: 1,
          eTag: "manifest-etag",
          cTag: "manifest-ctag",
          sha256Hash: "c".repeat(64),
          quickXorHash: null,
        },
      ],
    }],
  };
}

describe("community-plugin join authorization", () => {
  it("retries recoverable facts but not a changed or incompatible target", () => {
    expect(isCommunityPluginJoinBlockRetryable("catalog-unavailable"))
      .toBe(true);
    expect(isCommunityPluginJoinBlockRetryable("remote-bundle-incomplete"))
      .toBe(true);
    expect(isCommunityPluginJoinBlockRetryable("local-bundle-incomplete"))
      .toBe(true);
    expect(isCommunityPluginJoinBlockRetryable("remote-bundle-changed"))
      .toBe(false);
    expect(isCommunityPluginJoinBlockRetryable("manifest-incompatible"))
      .toBe(false);
    expect(isCommunityPluginJoinBlockRetryable(undefined)).toBe(false);
  });

  it("binds a restore only to one fresh complete remote bundle", () => {
    expect(createCommunityPluginJoinAuthorization({
      participation: {
        pluginId: "calendar",
        phase: "join-requested",
        operationId: "join-calendar-1",
        targetCatalogRevision: 7,
        targetBundleDigest: "a".repeat(64),
      },
      catalog: catalog(),
      scope,
    })).toEqual({
      status: "ready",
      authorization: expect.objectContaining({
        pluginId: "calendar",
        operationId: "join-calendar-1",
        targetCatalogRevision: 7,
        targetBundleDigest: "a".repeat(64),
      }),
    });
  });

  it.each([
    ["stale catalog", { stale: true }, "catalog-stale"],
    ["partial bundle", {
      entries: [{ ...catalog().entries[0], bundleState: "partial" }],
    }, "remote-bundle-incomplete"],
    ["replacement bundle", {
      entries: [{
        ...catalog().entries[0],
        bundleDigest: "d".repeat(64),
      }],
    }, "remote-bundle-changed"],
  ])("blocks %s before restore", (_label, patch, reason) => {
    const candidate = { ...catalog(), ...patch } as RemoteCommunityPluginCatalogV1;
    expect(createCommunityPluginJoinAuthorization({
      participation: {
        pluginId: "calendar",
        phase: "restoring",
        operationId: "join-calendar-1",
        targetCatalogRevision: 7,
        targetBundleDigest: "a".repeat(64),
      },
      catalog: candidate,
      scope,
    })).toEqual({ status: "blocked", reason });
  });

  it("rejects a changed remote member after the complete identity scan", () => {
    const prepared = createCommunityPluginJoinAuthorization({
      participation: {
        pluginId: "calendar",
        phase: "restoring",
        operationId: "join-calendar-1",
        targetCatalogRevision: 7,
        targetBundleDigest: "a".repeat(64),
      },
      catalog: catalog(),
      scope,
    });
    if (prepared.status !== "ready") throw new Error("authorization missing");
    const remoteEntries = prepared.authorization.members.map((member) => ({
      path: member.path,
      driveId: member.remoteId,
      parentId: member.parentId,
      size: member.size,
      mtime: member.mtime,
      eTag: member.eTag,
      cTag: member.cTag,
      ...(member.sha256Hash ? { sha256Hash: member.sha256Hash } : {}),
    }));

    expect(validateCommunityPluginJoinAuthorization(
      prepared.authorization,
      remoteEntries,
      scope,
    )).toEqual({ status: "valid" });
    expect(validateCommunityPluginJoinAuthorization(
      prepared.authorization,
      remoteEntries.map((entry, index) => index === 0
        ? { ...entry, eTag: "changed-etag" }
        : entry),
      scope,
    )).toEqual({ status: "blocked", reason: "remote-bundle-changed" });
  });

  it("rejects a join target from another committed scope", () => {
    expect(createCommunityPluginJoinAuthorization({
      participation: {
        pluginId: "calendar",
        phase: "restoring",
        operationId: "join-calendar-1",
        targetCatalogRevision: 7,
        targetBundleDigest: "a".repeat(64),
      },
      catalog: catalog(),
      scope: { ...scope, filesRootId: "other-files" },
    })).toEqual({ status: "blocked", reason: "scope-changed" });
  });
});
