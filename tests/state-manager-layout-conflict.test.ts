import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import {
  EasySyncRuntimeLayoutMigrationConflict,
} from "../src/sync/runtime-layout-migration";

// The migration itself is forced to surface a conflict so load() reaches its
// clean exits with `layoutMigrationConflict` set (账本 §八 布局冲突诊断两处).
vi.mock("../src/sync/runtime-layout-migration", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/sync/runtime-layout-migration")
  >();
  return {
    ...actual,
    ensureEasySyncRuntimeLayoutMigration: vi.fn().mockRejectedValue(
      new actual.EasySyncRuntimeLayoutMigrationConflict(
        ".obsidian/plugins/easy-sync/legacy/state.json",
        ".obsidian/plugins/easy-sync/data/state.json",
      ),
    ),
  };
});

function makePlugin(diag: { warn: ReturnType<typeof vi.fn> }): PluginDataStore {
  return {
    loadData: vi.fn().mockResolvedValue(undefined),
    updatePluginData: vi.fn().mockResolvedValue(undefined),
    manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
    diag,
    app: {
      vault: {
        adapter: {
          exists: vi.fn().mockResolvedValue(false),
          read: vi.fn().mockRejectedValue(new Error("missing")),
          write: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
          rmdir: vi.fn().mockResolvedValue(undefined),
          stat: vi.fn().mockResolvedValue(null),
          readBinary: vi.fn().mockRejectedValue(new Error("missing")),
          writeBinary: vi.fn().mockResolvedValue(undefined),
        } as DataAdapter,
        configDir: ".obsidian",
      },
    },
  };
}

type BlockShape = {
  authority: string;
  reason: string;
} | null;

function readBlock(sm: StateManager): BlockShape {
  return (sm as unknown as { v2StateLoadBlock: BlockShape }).v2StateLoadBlock;
}

describe("StateManager load layout-migration conflict diagnostics", () => {
  it("records the conflict on the legacy exit with unknown authority", async () => {
    // adapter.exists=false throughout: no V2 manifest, no witness, no downgrade
    // artifacts — load() ends on the legacy clean exit, not the V2 one.
    const diag = { warn: vi.fn() };
    const sm = new StateManager(makePlugin(diag));

    await sm.load();

    expect(readBlock(sm)).toMatchObject({
      reason: "layout-migration-conflict",
      authority: "unknown",
    });
  });

  it("surfaces a suppressed conflict through diagnostics when a block already exists", () => {
    const diag = { warn: vi.fn() };
    const sm = new StateManager(makePlugin(diag));
    const slot = sm as unknown as {
      v2StateLoadBlock: BlockShape;
      applyLayoutMigrationConflictBlock: (
        conflict: EasySyncRuntimeLayoutMigrationConflict | null,
        authority: "v2" | "unknown",
      ) => void;
    };
    // Arrange a loader-recorded block (more specific reason owns the surface).
    slot.v2StateLoadBlock = {
      authority: "v2",
      reason: "manifest-envelope-missing",
    } as NonNullable<BlockShape>;

    slot.applyLayoutMigrationConflictBlock(
      new EasySyncRuntimeLayoutMigrationConflict(
        ".obsidian/plugins/easy-sync/legacy/state.json",
        ".obsidian/plugins/easy-sync/data/state.json",
      ),
      "v2",
    );

    // The conflict evidence (both paths) must reach diagnostics, not vanish.
    expect(diag.warn).toHaveBeenCalledTimes(1);
    const [category, message, detail] = diag.warn.mock.calls[0];
    expect(category).toBe("state");
    expect(message).toContain("layout migration conflict");
    expect(JSON.stringify(detail)).toContain("easy-sync/legacy/state.json");
    expect(JSON.stringify(detail)).toContain("easy-sync/data/state.json");
    // The loader-recorded block stays authoritative.
    expect(readBlock(sm)).toMatchObject({ reason: "manifest-envelope-missing" });
  });

  it("keeps the block-setting path silent when no conflict exists", async () => {
    const diag = { warn: vi.fn() };
    const sm = new StateManager(makePlugin(diag));

    // No forced conflict on this round: load() completes unblocked and
    // without diagnostics on the narrow legacy path.
    vi.mocked(
      (await import("../src/sync/runtime-layout-migration"))
        .ensureEasySyncRuntimeLayoutMigration,
    ).mockResolvedValueOnce({} as never);
    await sm.load();

    expect(readBlock(sm)).toBeNull();
    expect(diag.warn).not.toHaveBeenCalled();
  });
});
