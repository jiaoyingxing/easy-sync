/**
 * Single-instance gate for modals (2026-10-30 弹框共享件).
 *
 * Two modes live on the same registry:
 *  - replace (detail family): same target rejected, different target closes
 *    the old instance first;
 *  - coexist (scope → manager stacking): same target rejected, different
 *    targets live side by side.
 * The harness mirrors the host contract that `close()` runs `onClose()`
 * synchronously.
 */
import { describe, expect, it } from "vitest";
import { EasySyncModal } from "../src/ui/easy-sync-modal";

class GateProbeModal extends EasySyncModal {
  closeCalls = 0;

  override open(): void {
    if (!this.takeOverSingleInstance(this.key, { replace: this.replace })) {
      return;
    }
    // super.open() would touch host layout; the gate outcome is what we pin.
    this.opened = true;
  }

  override close(): void {
    this.closeCalls += 1;
    this.onClose();
  }

  override onClose(): void {
    this.releaseSingleInstance();
  }

  opened = false;

  constructor(
    private readonly key: unknown,
    private readonly replace: boolean,
  ) {
    super({} as never);
  }
}

describe("EasySyncModal single-instance gate", () => {
  it("replace mode: same target is rejected, different target closes the old", () => {
    const first = new GateProbeModal("a.md", true);
    first.open();
    expect(first.opened).toBe(true);

    const duplicate = new GateProbeModal("a.md", true);
    duplicate.open();
    expect(duplicate.opened).toBe(false);
    expect(first.closeCalls).toBe(0);

    const second = new GateProbeModal("b.md", true);
    second.open();
    expect(second.opened).toBe(true);
    expect(first.closeCalls).toBe(1);
  });

  it("coexist mode: same target rejected, different targets live side by side", () => {
    const scope = new GateProbeModal("scope", false);
    scope.open();
    expect(scope.opened).toBe(true);

    const duplicate = new GateProbeModal("scope", false);
    duplicate.open();
    expect(duplicate.opened).toBe(false);
    expect(scope.closeCalls).toBe(0);

    const manager = new GateProbeModal("files", false);
    manager.open();
    expect(manager.opened).toBe(true);
    // Stacking is a legitimate flow here: the scope modal stays open.
    expect(scope.closeCalls).toBe(0);
  });

  it("release happens on close so the slot frees up", () => {
    const first = new GateProbeModal("a.md", true);
    first.open();
    first.close();

    const second = new GateProbeModal("a.md", true);
    second.open();
    expect(second.opened).toBe(true);
    expect(first.closeCalls).toBe(1);
  });
});
