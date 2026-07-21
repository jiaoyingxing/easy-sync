import { describe, expect, it } from "vitest";
import {
  applyAutomaticHandlingPolicy,
  DEFAULT_AUTOMATIC_HANDLING_POLICY,
  isAutomaticTextMergeCandidatePath,
  readAutomaticHandlingPolicy,
} from "../src/sync/automatic-handling-policy";
import { SyncEngine } from "../src/sync/sync-engine";
import { SyncActionType, type SyncPlanItem } from "../src/sync/types";

describe("automatic handling policy", () => {
  it("defaults deletion off and non-overlapping text merge on", () => {
    expect(readAutomaticHandlingPolicy(undefined)).toEqual(DEFAULT_AUTOMATIC_HANDLING_POLICY);
    expect(readAutomaticHandlingPolicy({ autoDeleteLocalFiles: "yes" })).toEqual({
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: true,
    });
    expect(readAutomaticHandlingPolicy({
      identicalNewFiles: true,
      identicalModifiedFiles: true,
    })).toEqual({ autoDeleteLocalFiles: false, mergeNonOverlappingText: true });
  });

  it("reads the explicit delete authorization", () => {
    expect(readAutomaticHandlingPolicy({ autoDeleteLocalFiles: true })).toEqual({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
  });

  it("uses the 1.0.3 auto-merge choice only as a fallback for the new merge field", () => {
    expect(readAutomaticHandlingPolicy(undefined, false)).toEqual({
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: false,
    });
    expect(readAutomaticHandlingPolicy({ autoDeleteLocalFiles: true }, false)).toEqual({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: false,
    });
    expect(readAutomaticHandlingPolicy({ mergeNonOverlappingText: true }, false)).toEqual({
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: true,
    });
    expect(readAutomaticHandlingPolicy(undefined, "false")).toEqual(
      DEFAULT_AUTOMATIC_HANDLING_POLICY,
    );
  });

  it("only projects local delete confirmations when enabled", () => {
    const items: SyncPlanItem[] = [
      { type: SyncActionType.ConfirmLocalDelete, path: "deleted-remotely.md" },
      { type: SyncActionType.ConfirmLocalDelete, path: ".obsidian/app.json" },
      { type: SyncActionType.Conflict, path: "conflict.md" },
    ];

    expect(applyAutomaticHandlingPolicy(items, {
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: true,
    })).toBe(items);
    expect(applyAutomaticHandlingPolicy(items, {
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    })).toEqual([
      { type: SyncActionType.DeleteLocal, path: "deleted-remotely.md" },
      { type: SyncActionType.ConfirmLocalDelete, path: ".obsidian/app.json" },
      { type: SyncActionType.Conflict, path: "conflict.md" },
    ]);
  });

  it("counts an executable local delete toward the large-change safety threshold", () => {
    const engine = new SyncEngine();
    expect(engine.shouldPauseForConfirmation({
      items: [{ type: SyncActionType.DeleteLocal, path: "deleted-remotely.md" }],
      lastTotalFiles: 1,
      confirmed: false,
    })).toBe(true);
  });

  it("keeps Obsidian config, plugin data, and plugin artifacts out of automatic text merge", () => {
    expect(isAutomaticTextMergeCandidatePath("notes/a.md", ".obsidian")).toBe(true);
    expect(isAutomaticTextMergeCandidatePath("data/export.json", ".obsidian")).toBe(true);
    expect(isAutomaticTextMergeCandidatePath("image.png", ".obsidian")).toBe(false);

    for (const path of [
      ".obsidian/app.json",
      ".obsidian/snippets/theme.css",
      ".obsidian/plugins/easy-sync/main.js",
      ".obsidian/plugins/easy-sync/manifest.json",
      ".obsidian/plugins/easy-sync/styles.css",
      ".obsidian/plugins/example/data.json",
    ]) {
      expect(isAutomaticTextMergeCandidatePath(path, ".obsidian")).toBe(false);
    }
    expect(isAutomaticTextMergeCandidatePath(".config/plugins/example/main.js", ".config"))
      .toBe(false);
  });
});
