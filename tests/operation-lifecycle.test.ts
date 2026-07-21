import { describe, expect, it } from "vitest";
import { OperationLifecycle } from "../src/sync/operation-lifecycle";

describe("OperationLifecycle", () => {
  it("invalidates every capability captured before a lifecycle change", () => {
    const lifecycle = new OperationLifecycle();
    const syncEpoch = lifecycle.capture();
    const sideActionEpoch = lifecycle.capture();

    expect(lifecycle.isCurrent(syncEpoch)).toBe(true);
    expect(lifecycle.isCurrent(sideActionEpoch)).toBe(true);

    lifecycle.invalidate("logout");

    expect(lifecycle.isCurrent(syncEpoch)).toBe(false);
    expect(lifecycle.isCurrent(sideActionEpoch)).toBe(false);
    expect(lifecycle.lastInvalidationReason).toBe("logout");
    expect(lifecycle.isCurrent(lifecycle.capture())).toBe(true);
  });

  it("never revalidates an older epoch after later invalidations", () => {
    const lifecycle = new OperationLifecycle();
    const oldEpoch = lifecycle.capture();

    lifecycle.invalidate("reset");
    const resetEpoch = lifecycle.capture();
    lifecycle.invalidate("unload");

    expect(lifecycle.currentEpoch).toBe(2);
    expect(lifecycle.isCurrent(oldEpoch)).toBe(false);
    expect(lifecycle.isCurrent(resetEpoch)).toBe(false);
  });
});
