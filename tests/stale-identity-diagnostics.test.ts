import { describe, expect, it } from "vitest";
import { makeHarness } from "./helpers/state-v2-activation-harness";

/**
 * The side-action snapshot rebuild used to collapse every failure into one
 * "facts changed" notice. The iOS field report (2026-11-25) had an empty
 * mutation ledger, so the ledger gate could not explain the dead button; the
 * diagnostic now names the failing precondition so the next report can.
 */
describe("stale identity resolution diagnostics", () => {
  it("records a stale remote index as live-facts-changed", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual", {}, false, undefined, {
      activateV2State: true,
    });
    // Keep the folder row: rename locally and change the subtree so the
    // pure-rename auto path deliberately stays fail-closed.
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("NOTES");
    harness.localEntryState[0].path = "NOTES/a.md";
    harness.localEntryState[0].hash = "c".repeat(64);
    await harness.executor.run("manual");
    // The cloud now uses the new spelling, but no round has refreshed the
    // committed index; the reviewed fact still carries the old name.
    harness.remoteItemState.find((item) => item.id === "folder-notes")!.name =
      "NOTES";

    const entry = await harness.executor.getStaleIdentityResolutionSnapshot(
      "Notes",
    );

    expect(entry).toEqual({ snapshot: null, reason: "facts-changed" });
    const calls = harness.diag.warn.mock.calls as Array<
      [string, string, Record<string, unknown>?]
    >;
    expect(calls.some(([, message, data]) =>
      message === "stale identity resolution snapshot unavailable"
      && data?.path === "Notes"
      && data?.reason === "live-facts-changed")).toBe(true);
  }, 120_000);
});
