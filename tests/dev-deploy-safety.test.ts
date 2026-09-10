import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("development deployment safety contracts", () => {
  it("replaces only release artifacts and never overwrites a 1.0.3 user's data or sidecars", () => {
    const source = readFileSync("scripts/dev-deploy.ps1", "utf8");
    const copyFiles = source.match(/\$copyFiles\s*=\s*@\(([^)]+)\)/)?.[1] ?? "";

    expect(copyFiles.match(/"[^"]+"/g)).toEqual([
      '"main.js"',
      '"styles.css"',
      '"manifest.json"',
    ]);
    expect(copyFiles).not.toMatch(/data\.json|remote-state\.json|base-content\.json|scan-cache\.json/i);
  });

  it("copies every requested target without requiring Obsidian to exit", () => {
    const source = readFileSync("scripts/dev-deploy.ps1", "utf8");
    const copyStart = source.indexOf("# Step 2: Copy plugin files");
    const copyCount = source.indexOf("Copying plugin files to $($DeploymentTargets.Count) vault(s)");
    const hashVerify = source.indexOf("Artifact copy verification failed");
    const buildStart = source.indexOf("# Step 1: Build");

    expect(source).toContain("[switch]$ReloadActive");
    expect(source).toContain("[switch]$RequireDisabledTargets");
    expect(source).toContain("[string]$ArtifactRoot");
    expect(source).toContain("[switch]$SkipBuild");
    expect(source).toContain("$sourceHashes[$file]");
    expect(source).toContain("$src = Join-Path $ArtifactRoot $file");
    expect(source).toContain("-SkipBuild requires an explicit -ArtifactRoot");
    expect(source).toContain("[System.Security.Cryptography.SHA256]::Create()");
    expect(source).not.toContain("Get-FileHash");
    expect(source).not.toContain("Get-Process Obsidian");
    expect(source).not.toContain("AllowEnabledTargets");
    expect(copyStart).toBeGreaterThan(buildStart);
    expect(copyCount).toBeGreaterThan(copyStart);
    expect(hashVerify).toBeGreaterThan(copyStart);
  });

  it.runIf(process.platform === "win32")(
    "deploys exact prebuilt release artifacts without touching plugin data",
    () => {
      const root = mkdtempSync(join(tmpdir(), "easy-sync-prebuilt-deploy-"));
      const artifactRoot = join(root, "artifacts");
      const pluginDir = join(root, "vault", ".obsidian", "plugins", "easy-sync");
      mkdirSync(artifactRoot);
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(artifactRoot, "main.js"), "release-main");
      writeFileSync(join(artifactRoot, "styles.css"), "release-style");
      writeFileSync(
        join(artifactRoot, "manifest.json"),
        JSON.stringify({ id: "easy-sync", version: "1.2.7" }),
      );
      writeFileSync(join(pluginDir, "data.json"), "preserve-user-state");

      try {
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve("scripts/dev-deploy.ps1"),
            "-ArtifactRoot",
            artifactRoot,
            "-SkipBuild",
            "-VaultPluginDirs",
            pluginDir,
          ],
          { encoding: "utf8" },
        );

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(readFileSync(join(pluginDir, "main.js"), "utf8")).toBe("release-main");
        expect(readFileSync(join(pluginDir, "styles.css"), "utf8")).toBe("release-style");
        expect(JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"))).toEqual({
          id: "easy-sync",
          version: "1.2.7",
        });
        expect(readFileSync(join(pluginDir, "data.json"), "utf8")).toBe("preserve-user-state");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps active runtime reload explicit while copying all targets", () => {
    const source = readFileSync("scripts/dev-deploy.ps1", "utf8");
    const activePreflight = source.indexOf("Resolving active Obsidian vault");
    const buildStart = source.indexOf("# Step 1: Build");
    const unload = source.indexOf("Unloading active EasySync runtime before copy");
    const copyStart = source.indexOf("# Step 2: Copy plugin files");

    expect(source).toContain("app.vault.adapter.basePath");
    expect(source).toContain("Active reload requires the active vault to be one of the requested targets");
    expect(source).toContain("app.plugins.unloadPlugin");
    expect(source).toContain("Reload triggered (active vault only)");
    expect(source).not.toContain("$DeploymentTargets = @($matchingTargets[0])");
    expect(activePreflight).toBeGreaterThan(-1);
    expect(buildStart).toBeGreaterThan(activePreflight);
    expect(unload).toBeGreaterThan(buildStart);
    expect(copyStart).toBeGreaterThan(unload);
  });

  it("keeps host-free disablement explicit, backed up, atomic, and verified", () => {
    const source = readFileSync("scripts/disable-test-plugin.ps1", "utf8");

    expect(source).toContain("[Parameter(Mandatory = $true)]");
    expect(source).toContain("community-plugin-list.ps1");
    expect(source).toContain("Read-CommunityPluginIds");
    expect(source).not.toMatch(/\$VaultRoots\s*=\s*@\(/);
    expect(source).toContain("$_ -ne $pluginId");
    expect(source).toContain("[System.IO.File]::Replace");
    expect(source).toContain("easysync-disable-backup");
    expect(source).toContain("$verifiedPlugins -contains $pluginId");
    expect(source).not.toMatch(/Start-Process|obsidian\.exe|plugin:reload/i);
  });

  it.runIf(process.platform === "win32")(
    "disables a multi-entry list under Windows PowerShell without nested-array false negatives",
    () => {
      const root = mkdtempSync(join(tmpdir(), "easy-sync-disable-test-"));
      const obsidianDir = join(root, ".obsidian");
      const enabledList = join(obsidianDir, "community-plugins.json");
      mkdirSync(obsidianDir);
      writeFileSync(enabledList, JSON.stringify(["startup-optimizer", "easy-sync", "resojot"]));

      try {
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve("scripts/disable-test-plugin.ps1"),
            "-VaultRoots",
            root,
          ],
          { encoding: "utf8" },
        );

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(JSON.parse(readFileSync(enabledList, "utf8"))).toEqual([
          "startup-optimizer",
          "resojot",
        ]);
        expect(
          readdirSync(obsidianDir).some((name) =>
            name.startsWith("community-plugins.json.easysync-disable-backup-")),
        ).toBe(true);
        expect(existsSync(enabledList)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps a one-entry community plugin list as a valid JSON array",
    () => {
      const root = mkdtempSync(join(tmpdir(), "easy-sync-disable-single-test-"));
      const obsidianDir = join(root, ".obsidian");
      const enabledList = join(obsidianDir, "community-plugins.json");
      mkdirSync(obsidianDir);
      writeFileSync(enabledList, JSON.stringify(["easy-sync"]));

      try {
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve("scripts/disable-test-plugin.ps1"),
            "-VaultRoots",
            root,
          ],
          { encoding: "utf8" },
        );

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(JSON.parse(readFileSync(enabledList, "utf8"))).toEqual([]);
        expect(existsSync(enabledList)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
