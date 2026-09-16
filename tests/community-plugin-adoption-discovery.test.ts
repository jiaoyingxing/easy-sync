import { describe, expect, it } from "vitest";
import { createCommunityPluginManifestObservation } from "../src/sync/community-plugin-bundle";
import {
  createEmptyCommunityPluginAdoptionMemory,
} from "../src/sync/community-plugin-adoption-memory";
import {
  deriveCommunityPluginAdoptionCandidates,
  resolveCommunityPluginPlatformFacts,
} from "../src/sync/community-plugin-adoption-discovery";
import type { RemoteCommunityPluginCatalogEntryV1 } from "../src/sync/community-plugin-remote-catalog";
import type { RemoteCommunityPluginCatalogV1 } from "../src/sync/community-plugin-remote-catalog";
import type { SyncScope } from "../src/sync/types";

const SCOPE: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files-root",
};

interface EntrySpec {
  pluginId: string;
  bundleState: "complete" | "partial";
  manifestText?: string;
}

function manifestText(
  pluginId: string,
  name: string,
  desktopOnly?: boolean,
): string {
  return JSON.stringify({
    id: pluginId,
    version: "1.0.0",
    name,
    ...(desktopOnly !== undefined ? { isDesktopOnly: desktopOnly } : {}),
  });
}

function catalog(entrySpecs: readonly EntrySpec[]): RemoteCommunityPluginCatalogV1 {
  const entries: RemoteCommunityPluginCatalogEntryV1[] = entrySpecs
    .map((spec) => {
      const files = spec.bundleState === "complete"
        ? ["main.js", "manifest.json"]
        : ["manifest.json"];
      const members = files.map((fileName, index) => {
        const text = spec.manifestText;
        const isManifest = fileName === "manifest.json";
        return {
          path: `.obsidian/plugins/${spec.pluginId}/${fileName}`,
          remoteId: `${spec.pluginId}-${fileName}-id`,
          parentId: `${spec.pluginId}-root`,
          size: isManifest && text
            ? new TextEncoder().encode(text).byteLength
            : 10,
          mtime: 1 + index,
          eTag: `etag-${spec.pluginId}-${fileName}`,
          cTag: `ctag-${spec.pluginId}-${fileName}`,
          sha256Hash: null,
          quickXorHash: null,
        };
      });
      return {
        pluginId: spec.pluginId,
        bundleState: spec.bundleState,
        bundleDigest: "a".repeat(64),
        members,
      };
    })
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  return {
    version: 1,
    scope: SCOPE,
    complete: true,
    stale: false,
    revision: 1,
    observedAt: 1,
    sourceDigest: "b".repeat(64),
    entries,
  };
}

async function observed(
  pluginId: string,
  name: string,
  desktopOnly?: boolean,
): Promise<{ spec: EntrySpec; observation: Awaited<
  ReturnType<typeof createCommunityPluginManifestObservation>
> }> {
  const text = manifestText(pluginId, name, desktopOnly);
  const bytes = new TextEncoder().encode(text);
  const entry: EntrySpec = {
    pluginId,
    bundleState: "complete",
    manifestText: text,
  };
  const observation = await createCommunityPluginManifestObservation(
    SCOPE,
    pluginId,
    {
      path: `.obsidian/plugins/${pluginId}/manifest.json`,
      driveId: `${pluginId}-manifest.json-id`,
      parentId: `${pluginId}-root`,
      size: bytes.byteLength,
      mtime: 2,
      eTag: `etag-${pluginId}-manifest.json`,
      cTag: `ctag-${pluginId}-manifest.json`,
    },
    bytes.buffer,
  );
  return { spec: entry, observation };
}

describe("community-plugin adoption discovery", () => {
  it("proposes complete, never-proposed, non-ignored plugins on desktop", async () => {
    const alpha = await observed("alpha", "Alpha");
    const gamma = await observed("gamma", "Gamma", true);
    const candidates = await deriveCommunityPluginAdoptionCandidates({
      scope: SCOPE,
      catalog: catalog([
        alpha.spec,
        gamma.spec,
        { pluginId: "beta", bundleState: "complete" },
        { pluginId: "delta", bundleState: "partial" },
      ]),
      participation: null,
      memory: createEmptyCommunityPluginAdoptionMemory(),
      manifestObservations: [alpha.observation, gamma.observation],
      isMobile: false,
    });
    expect(candidates).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps desktop-only and unobserved bundles off mobile", async () => {
    const alpha = await observed("alpha", "Alpha");
    const gamma = await observed("gamma", "Gamma", true);
    const candidates = await deriveCommunityPluginAdoptionCandidates({
      scope: SCOPE,
      catalog: catalog([
        alpha.spec,
        gamma.spec,
        { pluginId: "beta", bundleState: "complete" },
      ]),
      participation: null,
      memory: createEmptyCommunityPluginAdoptionMemory(),
      manifestObservations: [alpha.observation, gamma.observation],
      isMobile: true,
    });
    // beta has no observation yet -> platform fact unknown -> mobile waits.
    expect(candidates).toEqual(["alpha"]);
  });

  it("never re-proposes plugins with a real intent or ignore memory; excluded plugins are re-proposed", async () => {
    const candidates = await deriveCommunityPluginAdoptionCandidates({
      scope: SCOPE,
      catalog: catalog([
        { pluginId: "alpha", bundleState: "complete" },
        { pluginId: "beta", bundleState: "complete" },
        { pluginId: "gamma", bundleState: "complete" },
        { pluginId: "epsilon", bundleState: "complete" },
        { pluginId: "easy-sync", bundleState: "complete" },
      ]),
      participation: {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          alpha: { pluginId: "alpha", phase: "never-participated" },
          gamma: { pluginId: "gamma", phase: "excluded" },
          epsilon: { pluginId: "epsilon", phase: "participating" },
          zeta: { pluginId: "zeta", phase: "exit-requested" },
        },
      },
      memory: {
        ...createEmptyCommunityPluginAdoptionMemory(),
        ignoredPluginIds: ["beta"],
      },
      manifestObservations: [],
      isMobile: false,
    });
    // alpha (never-participated) and gamma (excluded, e.g. cleaned then
    // re-uploaded by another device) are proposed again; participating,
    // exit-requested, ignored and own plugins stay out.
    expect(candidates).toEqual(["alpha", "gamma"]);
  });

  it("does not propose plugins whose local bundle is already complete", async () => {
    const candidates = await deriveCommunityPluginAdoptionCandidates({
      scope: SCOPE,
      catalog: catalog([
        { pluginId: "alpha", bundleState: "complete" },
        { pluginId: "gamma", bundleState: "complete" },
      ]),
      participation: {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          alpha: { pluginId: "alpha", phase: "never-participated" },
          gamma: { pluginId: "gamma", phase: "excluded" },
        },
      },
      memory: createEmptyCommunityPluginAdoptionMemory(),
      manifestObservations: [],
      localBundleFacts: new Map([
        ["alpha", "complete"],
        ["gamma", "complete"],
      ]),
      isMobile: false,
    });
    // An installed plugin (even with its sync toggle off) is not "not yet
    // downloaded"; it rejoins sync via the manager toggle instead.
    expect(candidates).toEqual([]);
  });

  it("still proposes plugins whose local bundle is absent, partial or unobserved", async () => {
    const candidates = await deriveCommunityPluginAdoptionCandidates({
      scope: SCOPE,
      catalog: catalog([
        { pluginId: "alpha", bundleState: "complete" },
        { pluginId: "beta", bundleState: "complete" },
        { pluginId: "gamma", bundleState: "complete" },
      ]),
      participation: {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          alpha: { pluginId: "alpha", phase: "never-participated" },
          beta: { pluginId: "beta", phase: "excluded" },
          gamma: { pluginId: "gamma", phase: "excluded" },
        },
      },
      memory: createEmptyCommunityPluginAdoptionMemory(),
      manifestObservations: [],
      localBundleFacts: new Map([
        ["alpha", "partial"],
        ["gamma", "absent"],
      ]),
      isMobile: false,
    });
    // alpha is a repairable partial install, gamma is the cleaned-then-
    // re-uploaded shape (2026-09-09 用户拍板); beta has no local fact, so
    // the gate stays fail-open for it.
    expect(candidates).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps excluded desktop-only bundles off mobile proposals", async () => {
    const gamma = await observed("gamma", "Gamma", true);
    const candidates = await deriveCommunityPluginAdoptionCandidates({
      scope: SCOPE,
      catalog: catalog([gamma.spec]),
      participation: {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          gamma: { pluginId: "gamma", phase: "excluded" },
        },
      },
      memory: createEmptyCommunityPluginAdoptionMemory(),
      manifestObservations: [gamma.observation],
      isMobile: true,
    });
    expect(candidates).toEqual([]);
  });

  it("resolves platform facts only from observations that match the current member", async () => {
    const alpha = await observed("alpha", "Alpha", true);
    const plain = await observed("beta", "Beta");
    const entrySpecs = [alpha.spec, plain.spec];
    const facts = await resolveCommunityPluginPlatformFacts(
      SCOPE,
      catalog(entrySpecs),
      [alpha.observation],
      "easy-sync",
    );
    expect(facts.get("alpha")).toEqual({
      name: "Alpha",
      isDesktopOnly: true,
    });
    expect(facts.get("beta")).toEqual({ name: null, isDesktopOnly: null });

    // An observation whose manifest member changed (new eTag) is no evidence.
    const staleCatalog = catalog(entrySpecs);
    const alphaEntry = staleCatalog.entries.find((entry) =>
      entry.pluginId === "alpha"
    )!;
    alphaEntry.members = alphaEntry.members.map((candidate) =>
      candidate.path.endsWith("manifest.json")
        ? { ...candidate, eTag: "etag-changed" }
        : candidate
    );
    const staleFacts = await resolveCommunityPluginPlatformFacts(
      SCOPE,
      staleCatalog,
      [alpha.observation],
      "easy-sync",
    );
    expect(staleFacts.get("alpha")).toEqual({ name: null, isDesktopOnly: null });
  });

  it("does not propose a plugin this device carries a cloud-cleanup marker for", async () => {
    // 2026-09-16: after a successful cloud cleanup the merged catalog can
    // still remember the deleted bundle for a round or two; proposing it as
    // an install suggestion contradicts the marker and produced noise rows.
    const alpha = await observed("alpha", "Alpha");
    const candidates = await deriveCommunityPluginAdoptionCandidates({
      scope: SCOPE,
      catalog: catalog([alpha.spec]),
      participation: null,
      memory: createEmptyCommunityPluginAdoptionMemory(),
      manifestObservations: [alpha.observation],
      isMobile: false,
      cleanupMarkerPluginIds: ["alpha"],
    });
    expect(candidates).toEqual([]);
  });

  it("resumes proposals once the cleanup marker is dropped (bundle reappeared)", async () => {
    const alpha = await observed("alpha", "Alpha");
    const candidates = await deriveCommunityPluginAdoptionCandidates({
      scope: SCOPE,
      catalog: catalog([alpha.spec]),
      participation: null,
      memory: createEmptyCommunityPluginAdoptionMemory(),
      manifestObservations: [alpha.observation],
      isMobile: false,
      cleanupMarkerPluginIds: [],
    });
    expect(candidates).toEqual(["alpha"]);
  });
});
