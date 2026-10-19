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

/**
 * 本次运行内的源码内容缓存（2026-10-17，B12 时基健康）。
 *
 * 本文件的守卫用**同一批 src 文件**（实测 154 个文件 / 4.07 MiB）跑 25 次模式扫描：
 * 上面那组 `it.each` 每条模式重新走一遍全目录并重新读一遍每个文件，合计约 102 MiB
 * 同步读取。机器忙时（杀软扫描／磁盘排队）这段纯 I/O 会整段变慢，让守卫在默认 5s
 * 超时上假红——那是机器的时基，不是判据。
 *
 * 只在**同一次进程运行内**复用文件内容：不改任何一条守卫的判据、扫描面或期望值，
 * 也不改目录遍历本身（`listTypeScriptFiles` 仍然每次真走一遍）。测试不写 `src/`，
 * 所以一次运行内文件内容不会变。
 */
const sourceTextCache = new Map<string, string>();

function readSourceText(path: string): string {
  const cached = sourceTextCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(path, "utf8");
  sourceTextCache.set(path, text);
  return text;
}

function countDebt(pattern: RegExp): Record<string, number> {
  return Object.fromEntries(
    listTypeScriptFiles("src")
      .map((path) => {
        const source = readSourceText(path);
        return [path, [...source.matchAll(pattern)].length] as const;
      })
      .filter((entry) => entry[1] > 0),
  );
}

function filesContaining(literal: string): string[] {
  return listTypeScriptFiles("src")
    .filter((path) => readSourceText(path).includes(literal));
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
    pattern: /\bthis\.state\.(?:clearRemoteState|applyRemoteMutations|upsertBaseEntries|removeBaseEntries|setRemoteState|commitMutationCheckpoints?)\s*\(/g,
    expected: {
      "src/sync/sync-executor.ts": 9,
    },
  },
  {
    label: "active mutation recovery ledger calls",
    pattern: /\bthis\.state\.(?:beginMutationIntent|recordMutationReceipt|abandonMutationIntent|commitMutationCheckpoints?)\s*\(/g,
    expected: {
      // Two additional V2-only receipt writes rebind a completed upload to a
      // replacement folder identity. One more V2-only rebind owner added
      // 2026-09-28: rebaseReceiptsAfterHierarchyRefresh rebinds upload
      // receipts after a hierarchy refresh for the deferred upload batch and
      // the recovery chain (parent-drift field reports) — never a V1 runtime
      // path. The extra checkpoint owner is the V2-only independent upload
      // batch gateway, not a V1 runtime path.
      "src/sync/sync-executor.ts": 16,
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
    expectedFiles: ["src/sync/state-manager.ts", "src/sync/state-v2-migration.ts"],
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
    expectedFiles: ["src/obsidian-compat.ts"],
  },
  {
    label: "base-content artifact",
    disposition: "pre-v2-70-safety-boundary",
    literal: "base-content.json",
    expectedFiles: ["src/obsidian-compat.ts", "src/sync/state-manager.ts"],
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
      "src/sync/conservative-reset-recovery.ts",
      "src/sync/diagnostic-report-evidence.ts",
      "src/sync/file-state-reducer-v2.ts",
      "src/sync/folder-state-reducer-v2.ts",
      // S2 隔离通道（2026-10-17）：逐形状有界证据 capsule 只读记录本身的
      // 意图与收据形状（准入判定零写入、零第二状态源；见
      // docs/temp/20261016-151934 §六 S2 行）。
      "src/sync/isolation-capsules.ts",
      "src/sync/state-manager.ts",
      "src/sync/state-v2-migration.ts",
      "src/sync/sync-executor.ts",
      // S1 观测刀（2026-10-17 用户拍板）：轮末只读扫描恢复账本记录面组成事实
      // 指纹（零写入、零控制流；见 docs/temp/20261016-151934 §六 S1）。
      "src/sync/sync-idle-observation.ts",
      "src/sync/types.ts",
    ],
  },
];

describe("file-sync V1 runtime freeze", () => {
  // 超时分档（2026-10-17，B12 时基健康）：本组守卫每次都要走一遍全 `src` 目录并
  // 读遍每个文件，属"整仓扫描型"。默认 5s 是给普通用例的时基，机器忙时（杀软／
  // 磁盘排队／并行全量）纯 I/O 就能吃掉它 ⇒ 给 30s 余量（实测单条 4–83ms，见交付
  // 报告普查清单）；判据、扫描面与期望值一个没动。
  it.each(FILE_SYNC_V1_DEBT)(
    "allows $label debt only to shrink",
    ({ pattern, expected }) => {
      expect(countDebt(pattern)).toEqual(expected);
    },
    30_000,
  );

  // 反假绿（2026-10-16 检查体检轮）：上面那组门断言的是"某个模式一处都搜不到"，
  // 也就是**零命中即通过**——目录改名、递归断掉、`readFileSync` 抛错被吞、
  // `matchAll` 拿到空串，都会让门静默变绿。这条控制项证明**探测器本身在工作**：
  // 扫描面非空，且一个必然命中的模式确实命中了一批文件。
  // 已知边界：它证明的是"扫描机制没坏"，不能证明每条模式的**写法**没写错
  // （模式写错仍会零命中而变绿）；逐条兜底需要给每个守卫补一个"应当命中的样本串"
  // 字段并断言 `pattern.test(probe)`，已登记为检查体检轮的实施候选。
  it("keeps the V1 debt scanner itself non-vacuous", () => {
    const scanned = listTypeScriptFiles("src");
    expect(scanned.length).toBeGreaterThan(100);

    const control = countDebt(/\bexport\b/g);
    expect(Object.keys(control).length).toBeGreaterThan(50);
  }, 30_000);

  it.each(V2_70_BOUNDARY_OWNERS)(
    "keeps $disposition owner set explicit for $label",
    ({ literal, expectedFiles }) => {
      expect(filesContaining(literal)).toEqual(expectedFiles);
    },
    30_000,
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
      .map((path) => readSourceText(path))
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
  }, 30_000);

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
    // 超时分档（2026-10-17，B12 时基健康）：本条是**打包子门**——`esbuild` 真跑一次
    // 整包构建。它是全仓唯一会拉起打包器／子进程的用例，等待时间由机器负载而非判据
    // 决定（实测热态 0.19–0.23s，全量跑内 1.97s，并行全量负载下 1.78s，野外曾见 6–10s）
    // ⇒ 给 60s 余量（约 30x 最慢实测）。
  }, 60_000);

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
