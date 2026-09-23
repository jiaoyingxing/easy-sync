import { describe, expect, it } from "vitest";
import { classifyManualResolutionEntry } from "../src/sync/manual-resolution-entry";
import { resolveManualResolutionNotice } from "../src/ui/manual-resolution-presentation";
import { I18n } from "../src/i18n";

const idle = {
  running: false,
  sideActionsInFlight: false,
  v2StateActive: true,
  mutationLedgerCorruption: false,
  stateLoadRecoveryBlock: false,
  remoteScopeRecovery: false,
};

describe("manual resolution entry gate", () => {
  it("opens when nothing blocks it", () => {
    expect(classifyManualResolutionEntry(idle)).toBe("ready");
  });

  it("separates a running round from another in-flight resolution", () => {
    expect(classifyManualResolutionEntry({ ...idle, running: true }))
      .toBe("round-running");
    expect(classifyManualResolutionEntry({ ...idle, sideActionsInFlight: true }))
      .toBe("action-in-flight");
  });

  it("separates the state-layer causes the entry cannot work around", () => {
    expect(classifyManualResolutionEntry({ ...idle, v2StateActive: false }))
      .toBe("state-unprepared");
    expect(classifyManualResolutionEntry({ ...idle, mutationLedgerCorruption: true }))
      .toBe("evidence-corrupt");
    expect(classifyManualResolutionEntry({ ...idle, stateLoadRecoveryBlock: true }))
      .toBe("state-load-blocked");
    expect(classifyManualResolutionEntry({ ...idle, remoteScopeRecovery: true }))
      .toBe("scope-recovery");
  });

  it("keeps the same winner order as the guards it replaces", () => {
    expect(classifyManualResolutionEntry({
      running: true,
      sideActionsInFlight: true,
      v2StateActive: false,
      mutationLedgerCorruption: true,
      stateLoadRecoveryBlock: true,
      remoteScopeRecovery: true,
    })).toBe("round-running");
  });
});

describe("manual resolution entry wording", () => {
  it("names the real blocker instead of reporting changed facts", () => {
    expect(resolveManualResolutionNotice("round-running"))
      .toEqual({ kind: "entry", key: "result.alreadyRunning" });
    expect(resolveManualResolutionNotice("action-in-flight"))
      .toEqual({ kind: "entry", key: "result.lockBusy" });
    expect(resolveManualResolutionNotice("state-unprepared"))
      .toEqual({ kind: "entry", key: "notice.v2MigrationRequired" });
    expect(resolveManualResolutionNotice("state-load-blocked"))
      .toEqual({ kind: "entry", key: "result.v2StateLoadBlocked" });
    expect(resolveManualResolutionNotice("scope-recovery"))
      .toEqual({ kind: "entry", key: "result.v2ScopeRecoveryPending" });
    expect(resolveManualResolutionNotice("evidence-corrupt"))
      .toEqual({ kind: "entry", key: "notice.sideActionPendingWork" });
  });

  it("keeps changed facts and name mismatches with the calling family", () => {
    expect(resolveManualResolutionNotice("facts-changed"))
      .toEqual({ kind: "facts-changed" });
    expect(resolveManualResolutionNotice("name-mismatch"))
      .toEqual({ kind: "name-mismatch" });
    expect(resolveManualResolutionNotice("ready"))
      .toEqual({ kind: "facts-changed" });
  });
});

describe("manual resolution entry copy", () => {
  it("tells the user what to rename when the two folder names differ", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const params = { path: "notes", namePath: "Notes" };

    expect(zh.t("notice.sharedFolderIdentity.nameMismatch", params)).toBe(
      "“notes”在本机与云端的文件夹名不完全相同（例如只有大小写不同，差异在“Notes”），EasySync 无法确认它们是同一个文件夹。请把其中一侧的名字改成与另一侧完全一致，重新同步后再确认。",
    );
    expect(en.t("notice.sharedFolderIdentity.nameMismatch", params)).toBe(
      "The local and cloud folder names for “notes” are not exactly the same (for example they differ only in letter case; the difference is at “Notes”), so EasySync cannot confirm they are the same folder. Rename one side to match the other exactly, sync again, then confirm.",
    );
  });

  it("names the unfinished work instead of blaming the facts", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("notice.sideActionPendingWork")).toBe(
      "本设备还有未完成的计划审阅或恢复处理，这项操作暂时无法执行；请先完成它们，再重新同步后重试。",
    );
    expect(en.t("notice.sideActionPendingWork")).toBe(
      "This device still has an unfinished plan review or recovery, so this action cannot run yet. Finish those first, then sync again and retry.",
    );
  });
});
