import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 2026-10-16（批次④，用户已拍板）：**版本一致性门的仓内落点**。
 *
 * 背景：此前 `npm run check:meta` 指向本机个人技能目录里的脚本
 * （`C:/Users/jiaor/.codex/skills/…/check-metadata.mjs`），这一行**逐字写在公开仓
 * `package.json` 里** ⇒ 别人克隆公开仓跑它必失败；而它守的"版本四处一致"在仓内
 * **没有任何等价检查**（发布前只能靠维护者记得手跑）。
 *
 * 本门把同一条规则搬进仓库、做成一条测试：跑 `npm test` 即自动覆盖，任何机器上都能
 * 跑。规则与个人脚本逐条对齐（package／manifest／package-lock 两处／versions 映射＋
 * 清单描述格式），**单一负责点＝本文件**；`npm run check:meta` 改为只跑本条测试。
 */

interface ReleaseMetadataFiles {
  pkg: { version?: string } | null;
  manifest: {
    id?: string;
    name?: string;
    version?: string;
    minAppVersion?: string;
    description?: string;
  } | null;
  versions: Record<string, string> | null;
  packageLock: {
    version?: string;
    packages?: Record<string, { version?: string }>;
  } | null;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const MAX_DESCRIPTION_LENGTH = 250;

/** 与个人脚本同一套规则：返回问题清单（空数组＝通过）与告警清单。 */
function collectMetadataIssues(files: ReleaseMetadataFiles): {
  issues: string[];
  warnings: string[];
} {
  const issues: string[] = [];
  const warnings: string[] = [];
  const { pkg, manifest, versions, packageLock } = files;

  if (pkg && !packageLock) warnings.push("package-lock.json is missing");
  if (pkg && manifest && pkg.version !== manifest.version) {
    issues.push(`version mismatch: package.json=${pkg.version}, manifest.json=${manifest.version}`);
  }
  if (pkg && packageLock) {
    if (packageLock.version !== pkg.version) {
      issues.push(`version mismatch: package-lock.json=${packageLock.version}, package.json=${pkg.version}`);
    }
    if (packageLock.packages?.[""]?.version !== pkg.version) {
      issues.push(
        `version mismatch: package-lock.json root=${packageLock.packages?.[""]?.version}, package.json=${pkg.version}`,
      );
    }
  }
  if (manifest) {
    if (!SEMVER.test(String(manifest.version ?? ""))) {
      issues.push(`manifest.json version is not semver x.y.z: ${manifest.version}`);
    }
    if (!SEMVER.test(String(manifest.minAppVersion ?? ""))) {
      issues.push(`manifest.json minAppVersion is not semver x.y.z: ${manifest.minAppVersion}`);
    }
    if (!manifest.id || !manifest.name) {
      issues.push("manifest.json is missing required identity fields (id / name)");
    }
    const description = String(manifest.description ?? "").trim();
    if (!description) {
      issues.push("manifest.json is missing description");
    } else {
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        issues.push(
          `manifest.json description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
        );
      }
      if (!description.endsWith(".")) {
        issues.push("manifest.json description must end with a period");
      }
      if (/\bObsidian\b/i.test(description)) {
        warnings.push('manifest.json description contains the word "Obsidian"');
      }
    }
  }
  if (manifest && versions && typeof versions === "object" && !Array.isArray(versions)) {
    const pluginVersion = manifest.version;
    const minAppVersion = manifest.minAppVersion;
    if (SEMVER.test(String(pluginVersion ?? "")) && SEMVER.test(String(minAppVersion ?? ""))) {
      const entry = versions[String(pluginVersion)];
      if (typeof entry !== "string") {
        if (typeof versions[String(minAppVersion)] === "string") {
          issues.push(
            `versions.json mapping direction looks inverted: found key "${minAppVersion}", expected key "${pluginVersion}" (versions.json maps plugin version -> minAppVersion)`,
          );
        } else {
          issues.push(`versions.json is missing entry for ${pluginVersion}`);
        }
      } else if (entry !== minAppVersion) {
        issues.push(
          `minAppVersion mismatch for ${pluginVersion}: versions.json=${entry}, manifest.json=${minAppVersion}`,
        );
      }
      for (const [key, value] of Object.entries(versions)) {
        if (!SEMVER.test(key) || !SEMVER.test(String(value))) {
          issues.push(
            `versions.json entry "${key}": "${value}" is not a plugin version -> minAppVersion semver pair`,
          );
        }
      }
    }
  }

  return { issues, warnings };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

describe("release metadata alignment gate", () => {
  it("keeps package.json / manifest.json / package-lock.json / versions.json aligned", () => {
    const files: ReleaseMetadataFiles = {
      pkg: readJson("package.json"),
      manifest: readJson("manifest.json"),
      versions: readJson("versions.json"),
      packageLock: readJson("package-lock.json"),
    };

    expect(files.pkg).not.toBeNull();
    expect(files.manifest).not.toBeNull();
    expect(files.versions).not.toBeNull();
    expect(files.packageLock).not.toBeNull();

    const { issues } = collectMetadataIssues(files);

    // 一条都不用"提醒"：直接给出问题清单，便于当场修。
    expect(issues).toEqual([]);
  });

  it("flags each drift shape on synthetic input (mechanism proof)", () => {
    const aligned: ReleaseMetadataFiles = {
      pkg: { version: "1.6.0" },
      manifest: {
        id: "easy-sync",
        name: "EasySync",
        version: "1.6.0",
        minAppVersion: "1.11.4",
        description: "OneDrive sync for Obsidian.",
      },
      versions: { "1.6.0": "1.11.4" },
      packageLock: { version: "1.6.0", packages: { "": { version: "1.6.0" } } },
    };
    expect(collectMetadataIssues(aligned).issues).toEqual([]);

    const drifted: Array<[string, ReleaseMetadataFiles]> = [
      ["manifest version drift", { ...aligned, manifest: { ...aligned.manifest!, version: "1.6.1" } }],
      ["lock version drift", { ...aligned, packageLock: { ...aligned.packageLock!, version: "1.5.9" } }],
      [
        "lock root drift",
        { ...aligned, packageLock: { version: "1.6.0", packages: { "": { version: "1.5.9" } } } },
      ],
      ["versions mapping drift", { ...aligned, versions: { "1.6.0": "1.11.3" } }],
      ["versions missing entry", { ...aligned, versions: {} }],
      ["non-semver manifest version", { ...aligned, manifest: { ...aligned.manifest!, version: "1.6" } }],
      [
        "description without period",
        { ...aligned, manifest: { ...aligned.manifest!, description: "no period here" } },
      ],
    ];

    for (const [label, files] of drifted) {
      expect(collectMetadataIssues(files).issues.length, label).toBeGreaterThan(0);
    }
  });
});
