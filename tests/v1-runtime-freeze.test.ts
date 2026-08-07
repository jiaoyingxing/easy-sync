import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

interface DebtGuard {
  label: string;
  pattern: RegExp;
  expected: Record<string, number>;
}

interface BoundaryOwnerGuard {
  label: string;
  disposition:
    | "public-read-only-import"
    | "pre-v2-70-safety-boundary"
    | "v2-70-state-source-migration"
    | "v2-active-recovery";
  literal: string;
  expectedFiles: string[];
}

function listTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? listTypeScriptFiles(path)
        : entry.isFile() && entry.name.endsWith(".ts")
          ? [path]
          : [];
    })
    .map((path) => relative(".", path).replaceAll("\\", "/"))
    .sort();
}

function countDebt(pattern: RegExp): Record<string, number> {
  return Object.fromEntries(
    listTypeScriptFiles("src")
      .map((path) => {
        const source = readFileSync(path, "utf8");
        return [path, [...source.matchAll(pattern)].length] as const;
      })
      .filter((entry) => entry[1] > 0),
  );
}

function filesContaining(literal: string): string[] {
  return listTypeScriptFiles("src")
    .filter((path) => readFileSync(path, "utf8").includes(literal));
}

const FILE_SYNC_V1_DEBT: DebtGuard[] = [
  {
    label: "V1 planner construction",
    pattern: /\bnew SyncEngine\s*\(/g,
    expected: {},
  },
  {
    label: "V1 planner calls",
    pattern: /\.generatePlan\s*\(/g,
    expected: {},
  },
  {
    label: "pre-manifest file-plan adapter",
    pattern: /\bbuildPreManifestFilePlanV2\s*\(/g,
    expected: {},
  },
  {
    label: "V2 to V1 downgrade entry and callers",
    pattern: /\bdowngradeV2FileState\s*\(/g,
    expected: {},
  },
  {
    label: "V2 to V1 downgrade run option",
    pattern: /\bdowngradeV2State\b/g,
    expected: {},
  },
  {
    label: "legacy V2 activation from mutable V1 state",
    pattern: /\bactivateV2FileState\s*\(/g,
    expected: {},
  },
  {
    label: "production V2 activation test override",
    pattern: /\bactivateV2State\b/g,
    expected: {},
  },
  {
    label: "production V1/V2 plan shadow",
    pattern: /\bcompareV1WithV2Shadow\b|V2 plan shadow/g,
    expected: {},
  },
  {
    label: "production V1/V2 receipt shadow",
    pattern: /\bcreateFileStateShadowEnvelopeV2\b|V2 (?:file projection|receipt|next-envelope) shadow/g,
    expected: {},
  },
  {
    label: "retired V2 authority writers",
    pattern: /\b(?:publishRetired|clearRetiredForReactivation)\s*\(/g,
    expected: {},
  },
  {
    label: "retired-generation reactivation fallback",
    pattern: /\barchiveRetiredV2GenerationForReactivation\s*\(/g,
    expected: {},
  },
  {
    label: "legacy remote-state writer",
    pattern: /\bpersistRemoteState\s*\(/g,
    expected: {},
  },
  {
    label: "legacy or dual-state writer calls",
    pattern: /\bthis\.state\.(?:clearRemoteState|applyRemoteMutations|upsertBaseEntries|removeBaseEntries|setRemoteState|commitMutationCheckpoint)\s*\(/g,
    expected: {
      "src/sync/sync-executor.ts": 9,
    },
  },
  {
    label: "active mutation recovery ledger calls",
    pattern: /\bthis\.state\.(?:beginMutationIntent|recordMutationReceipt|abandonMutationIntent|commitMutationCheckpoint)\s*\(/g,
    expected: {
      // Two additional V2-only receipt writes rebind a completed upload to a
      // replacement folder identity. They do not add a V1 runtime path.
      "src/sync/sync-executor.ts": 14,
    },
  },
];

/**
 * This is the exact production owner map that must survive until the real
 * platform gates allow V2-70. It intentionally fails on both expansion and
 * silent removal: shrinking a precommit writer or moving the ledger/state
 * schema needs an explicit gate review, not an incidental rename.
 */
const V2_70_BOUNDARY_OWNERS: BoundaryOwnerGuard[] = [
  {
    label: "public 1.1.3 state importer module",
    disposition: "public-read-only-import",
    literal: "public-1-1-3-state-import",
    expectedFiles: ["src/sync/state-manager.ts"],
  },
  {
    label: "public 1.1.3 cutover controller module",
    disposition: "public-read-only-import",
    literal: "public-1-1-3-cutover",
    expectedFiles: ["src/sync/state-manager.ts"],
  },
  {
    label: "public state backup artifact",
    disposition: "public-read-only-import",
    literal: "state-v1.backup.json",
    expectedFiles: [
      "src/obsidian-compat.ts",
      "src/sync/public-1-1-3-cutover.ts",
    ],
  },
  {
    label: "remote-state artifact",
    disposition: "pre-v2-70-safety-boundary",
    literal: "remote-state.json",
    expectedFiles: [
      "src/obsidian-compat.ts",
      "src/sync/state-manager.ts",
    ],
  },
  {
    label: "base-content artifact",
    disposition: "pre-v2-70-safety-boundary",
    literal: "base-content.json",
    expectedFiles: [
      "src/obsidian-compat.ts",
      "src/sync/base-content-cache.ts",
      "src/sync/state-manager.ts",
    ],
  },
  {
    label: "public mutation ledger key",
    disposition: "public-read-only-import",
    literal: "easy-sync-mutation-ledger",
    expectedFiles: [
      "src/sync/public-1-1-3-cutover.ts",
      "src/sync/state-manager.ts",
    ],
  },
  {
    label: "active V2 mutation ledger key",
    disposition: "v2-active-recovery",
    literal: "easy-sync-v2-mutation-ledger",
    expectedFiles: [
      "src/sync/public-1-1-3-cutover.ts",
      "src/sync/state-manager.ts",
    ],
  },
  {
    label: "pre-manifest authority gate",
    disposition: "pre-v2-70-safety-boundary",
    literal: "legacyStateAllowed",
    expectedFiles: ["src/sync/state-manager.ts"],
  },
  {
    label: "path-keyed public remote schema",
    disposition: "v2-70-state-source-migration",
    literal: "RemoteSyncState",
    expectedFiles: [
      "src/sync/public-1-1-3-state-import.ts",
      "src/sync/state-manager.ts",
      "src/sync/types.ts",
    ],
  },
  {
    label: "path-keyed public ancestor cache",
    disposition: "v2-70-state-source-migration",
    literal: "BaseContentCache",
    expectedFiles: [
      "src/sync/base-content-cache.ts",
      "src/sync/state-manager.ts",
    ],
  },
  {
    label: "shared legacy-shaped mutation ledger schema",
    disposition: "v2-70-state-source-migration",
    literal: "MutationLedgerEntryV1",
    expectedFiles: [
      "src/sync/diagnostic-report-evidence.ts",
      "src/sync/file-state-reducer-v2.ts",
      "src/sync/folder-state-reducer-v2.ts",
      "src/sync/state-manager.ts",
      "src/sync/state-v2-migration.ts",
      "src/sync/sync-executor.ts",
      "src/sync/types.ts",
    ],
  },
];

describe("file-sync V1 runtime freeze", () => {
  it.each(FILE_SYNC_V1_DEBT)(
    "allows $label debt only to shrink",
    ({ pattern, expected }) => {
      expect(countDebt(pattern)).toEqual(expected);
    },
  );

  it.each(V2_70_BOUNDARY_OWNERS)(
    "keeps $disposition owner set explicit for $label",
    ({ literal, expectedFiles }) => {
      expect(filesContaining(literal)).toEqual(expectedFiles);
    },
  );

  it("keeps deleted V1 planner facades and constructor seams out of src", () => {
    expect(existsSync("src/sync/sync-engine.ts")).toBe(false);
    const main = readFileSync("src/main.ts", "utf8");
    const executor = readFileSync("src/sync/sync-executor.ts", "utf8");
    const canonicalPlan = readFileSync(
      "src/sync/canonical-plan-v2.ts",
      "utf8",
    );
    const fileStateReducer = readFileSync(
      "src/sync/file-state-reducer-v2.ts",
      "utf8",
    );
    expect(main).not.toContain("SyncEngine");
    expect(main).toMatch(
      /new SyncExecutor\(\s*this\.onedrive,\s*this\.scanner,\s*this\.state,/,
    );
    expect(executor).not.toContain("Public113FilePlanFixture");
    expect(executor).not.toContain("public113Fixture");
    expect(canonicalPlan).not.toContain("projectStatePathViewV2");
    expect(canonicalPlan).not.toContain("projectFileStatePathViewV2");
    expect(fileStateReducer).not.toContain("FileStateProjectionV1");
    expect(fileStateReducer).not.toContain("V1 planner view");
  });

  it("keeps both IndexedDB owners wired into the production StateManager", () => {
    const main = readFileSync("src/main.ts", "utf8");

    expect(main.match(/createPublic113IndexedDbCandidateStore/g))
      .toHaveLength(1);
    expect(main).toContain("new IndexedDbPublic113StateStore(");
    expect(main).toMatch(
      /public113IndexedDbDatabaseName\(\s*indexedDbVaultInstanceId,\s*sourceStateDigest,?\s*\)/,
    );
    expect(main).toContain("loadOrCreateIndexedDbVaultInstanceId(this.app)");
    expect(main).toContain(
      "readIndexedDbVaultInstanceId(this.app)",
    );
    expect(main.match(/createStateV2IndexedDbActiveStore/g))
      .toHaveLength(1);
    expect(main).toContain(
      "new StateV2IndexedDbActiveStore(databaseId, recovery)",
    );
  });

  it("keeps the public 1.1.3 importer capability-free and read-only", () => {
    const importer = readFileSync(
      "src/sync/public-1-1-3-state-import.ts",
      "utf8",
    );
    const executable = importer
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(executable).not.toMatch(
      /\b(?:DataAdapter|OneDriveClient|Vault|SyncExecutor|StateManager)\b/,
    );
    expect(executable).not.toMatch(
      /\.(?:write|remove|rename|mkdir|rmdir|request|save|commit)\s*\(/,
    );
  });

  it("keeps the public-1.1.3 reentry fixture independent and outside production source", () => {
    const productionSources = listTypeScriptFiles("src")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const fixture = readFileSync(
      "tests/helpers/public-1-1-3-reentry-fixture.ts",
      "utf8",
    );

    expect(productionSources).not.toContain("PUBLIC_113_REENTRY_PROVENANCE");
    expect(fixture).toContain("01a4ac30936a89c53ddbf521e7ea9399d71e79c4");
    expect(fixture).toContain(
      "ad708214a0421025889cd334f8d3e91b885b7df4747d55ecd425fe8a2a8aa581",
    );
    expect(fixture).not.toContain("file-decision-planner-v2");
  });

  it("keeps the immutable public-1.1.3 fixture out of the production bundle graph", async () => {
    const bundled = await build({
      absWorkingDir: process.cwd(),
      entryPoints: ["src/main.ts"],
      bundle: true,
      external: ["obsidian"],
      format: "cjs",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const output = bundled.outputFiles[0]?.text ?? "";
    const inputs = Object.keys(bundled.metafile?.inputs ?? {})
      .map((path) => path.replaceAll("\\", "/"));

    expect(inputs.some((path) => path.startsWith("tests/"))).toBe(false);
    expect(output).not.toContain("PUBLIC_113_REENTRY_PROVENANCE");
    expect(output).not.toContain("activateV2State");
    expect(output).not.toContain("compareV1WithV2Shadow");
    expect(output).not.toContain("V2 plan shadow");
    expect(output).not.toContain("createFileStateShadowEnvelopeV2");
    expect(output).not.toContain("V2 file projection shadow");
    expect(output).not.toContain("V2 receipt shadow");
    expect(output).not.toContain("V2 next-envelope shadow");
  });

  it("does not confuse unrelated version-1 schemas with the frozen file-sync runtime", () => {
    const policy = readFileSync("src/sync/community-plugin-sync-policy.ts", "utf8");
    const recovery = readFileSync("src/sync/local-recovery-journal.ts", "utf8");

    expect(policy).toContain("CommunityPluginSyncPolicyV1");
    expect(recovery).toContain("version: 1");
    expect(FILE_SYNC_V1_DEBT.every(({ pattern }) =>
      !pattern.test(policy) && !pattern.test(recovery)
    )).toBe(true);
  });
});
