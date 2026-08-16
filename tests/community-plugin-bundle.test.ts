import { describe, expect, it } from "vitest";
import {
  assessCommunityPluginManifestCompatibility,
  assertCommunityPluginManifestIdentityStable,
  compareCommunityPluginVersions,
  findCommunityPluginManifestIdentityCollisions,
  parseCommunityPluginBundleManifest,
  parseCommunityPluginBundlePath,
} from "../src/sync/community-plugin-bundle";

describe("community plugin bundle safety", () => {
  it("recognizes only direct plugin bundle files", () => {
    expect(parseCommunityPluginBundlePath(
      ".obsidian/plugins/calendar/main.js",
      ".obsidian",
    )).toEqual({ pluginId: "calendar", fileName: "main.js" });
    expect(parseCommunityPluginBundlePath(
      ".obsidian/plugins/calendar/data.json",
      ".obsidian",
    )).toBeNull();
    expect(parseCommunityPluginBundlePath(
      ".obsidian/plugins/calendar/assets/icon.svg",
      ".obsidian",
    )).toBeNull();
  });

  it("accepts a safe manifest identity alias and requires a non-empty raw version", () => {
    expect(parseCommunityPluginBundleManifest(
      JSON.stringify({
        id: "calendar",
        name: "  Calendar  ",
        version: "2.1.0",
        minAppVersion: "1.5.0",
        isDesktopOnly: false,
      }),
      "calendar",
    )).toEqual({
      id: "calendar",
      name: "Calendar",
      version: "2.1.0",
      minAppVersion: "1.5.0",
      isDesktopOnly: false,
    });
    expect(parseCommunityPluginBundleManifest(
      JSON.stringify({ id: "pkmer", name: "PKMer", version: "2.1.0" }),
      "obsidian-pkmer",
    )).toMatchObject({ id: "pkmer", name: "PKMer" });
    expect(() => parseCommunityPluginBundleManifest(
      JSON.stringify({ id: "../other", version: "2.1.0" }),
      "calendar",
    )).toThrow("manifest identity is invalid");
    expect(() => parseCommunityPluginBundleManifest(
      JSON.stringify({ id: "calendar" }),
      "calendar",
    )).toThrow("manifest version is missing or invalid");
    expect(() => parseCommunityPluginBundleManifest(
      JSON.stringify({ id: "calendar", version: "   " }),
      "calendar",
    )).toThrow("manifest version is missing or invalid");
    expect(parseCommunityPluginBundleManifest(
      JSON.stringify({ id: "calendar", version: "1.5.12.11" }),
      "calendar",
    ).version).toBe("1.5.12.11");
    expect(parseCommunityPluginBundleManifest(
      JSON.stringify({ id: "calendar", version: "latest" }),
      "calendar",
    ).version).toBe("latest");
    expect(parseCommunityPluginBundleManifest(
      JSON.stringify({ id: "calendar", name: "   ", version: "2.1.0" }),
      "calendar",
    ).name).toBeNull();
    expect(compareCommunityPluginVersions("1.5.12.11", "1.5.12.10"))
      .toBeNull();
  });

  it("blocks identity changes within one directory and duplicate logical ids across directories", () => {
    const pkmer = parseCommunityPluginBundleManifest(
      JSON.stringify({ id: "pkmer", version: "1.0.0" }),
      "obsidian-pkmer",
    );
    expect(() => assertCommunityPluginManifestIdentityStable(
      "obsidian-pkmer",
      [pkmer, { ...pkmer, id: "other" }],
    )).toThrow("identity changed within directory");
    expect(findCommunityPluginManifestIdentityCollisions([
      { directoryId: "obsidian-pkmer", manifestId: "pkmer" },
      { directoryId: "pkmer-copy", manifestId: "pkmer" },
      { directoryId: "obsidian42-brat", manifestId: "obsidian42-brat" },
    ])).toEqual(new Set(["obsidian-pkmer", "pkmer-copy"]));
  });

  it("compares release and prerelease versions without lexicographic downgrade errors", () => {
    expect(compareCommunityPluginVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareCommunityPluginVersions("2.0.0-beta.2", "2.0.0-beta.1")).toBe(1);
    expect(compareCommunityPluginVersions("2.0.0", "2.0.0-beta.2")).toBe(1);
    expect(compareCommunityPluginVersions("not-semver", "1.0.0")).toBeNull();
  });

  it("blocks downgrades and host-incompatible enablement before a bundle commit", () => {
    const manifest = parseCommunityPluginBundleManifest(
      JSON.stringify({
        id: "calendar",
        version: "1.5.0",
        minAppVersion: "1.6.0",
        isDesktopOnly: true,
      }),
      "calendar",
    );
    expect(assessCommunityPluginManifestCompatibility(manifest, {
      localVersion: "2.0.0",
      isMobile: false,
      apiVersionSupported: true,
    })).toBe("downgrade");
    expect(assessCommunityPluginManifestCompatibility(manifest, {
      localVersion: null,
      isMobile: true,
      apiVersionSupported: true,
    })).toBe("desktop-only");
    expect(assessCommunityPluginManifestCompatibility(manifest, {
      localVersion: null,
      isMobile: false,
      apiVersionSupported: false,
    })).toBe("minimum-app-version");
  });
});
