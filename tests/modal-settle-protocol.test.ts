/**
 * Shared settle protocol for "open and wait" modals (评审材料 C2).
 *
 * The harness mirrors the host contract that `close()` runs `onClose()`
 * synchronously, so these tests pin both the "close == cancel" fallback and
 * the double-settle / double-close guards of `EasySyncModal.settle()`.
 */
import { describe, expect, it } from "vitest";
import { EasySyncModal } from "../src/ui/easy-sync-modal";
import { ConfirmModal } from "../src/ui/confirm-modal";
import { SyncModeGateModal } from "../src/ui/sync-mode-gate-modal";
import { UpdateReminderModal } from "../src/ui/update-reminder-modal";

class SettleProbeModal extends EasySyncModal<string | null> {
  closeCalls = 0;

  override open(): void {}

  override close(): void {
    this.closeCalls += 1;
    this.onClose();
  }

  onClose(): void {
    this.takePendingResolve()?.(null);
  }

  wait(): Promise<string | null> {
    return this.awaitResult();
  }

  choose(value: string | null): void {
    this.settle(value);
  }
}

describe("EasySyncModal settle protocol", () => {
  it("keeps a real choice when close() synchronously runs the cancel path", async () => {
    const modal = new SettleProbeModal({} as never);
    const pending = modal.wait();

    modal.choose("keep");

    await expect(pending).resolves.toBe("keep");
    expect(modal.closeCalls).toBe(1);
  });

  it("keeps the first result when settle runs twice", async () => {
    const modal = new SettleProbeModal({} as never);
    const pending = modal.wait();

    modal.choose("first");
    modal.choose("second");

    await expect(pending).resolves.toBe("first");
  });

  it("treats close as cancel exactly once across repeated closes", async () => {
    const modal = new SettleProbeModal({} as never);
    const pending = modal.wait();

    modal.close();
    modal.close();

    await expect(pending).resolves.toBe(null);
    expect(modal.closeCalls).toBe(2);
  });
});

function withHostClose<T extends { close(): void; onClose(): void }>(modal: T): T {
  modal.close = () => modal.onClose();
  return modal;
}

describe("migrated modals keep their settled values", () => {
  it("ConfirmModal resolves confirm=true and ignores the close that follows", async () => {
    const modal = withHostClose(
      new ConfirmModal({} as never, "title", "ok", "cancel", (key) => key),
    );
    const pending = modal.awaitConfirm();

    (modal as unknown as { settle(value: boolean): void }).settle(true);
    modal.onClose();

    await expect(pending).resolves.toBe(true);
  });

  it("SyncModeGateModal resolves the typed confirmation", async () => {
    const modal = withHostClose(
      new SyncModeGateModal(
        {} as never,
        (key) => key,
        { edited: 0, blockedDeletes: 0 },
        "开启单向同步",
      ),
    );
    const pending = modal.awaitDecision();

    (modal as unknown as { settle(value: boolean): void }).settle(true);
    modal.onClose();

    await expect(pending).resolves.toBe(true);
  });

  it("UpdateReminderModal resolves the chosen snooze and null on close", async () => {
    const chooseModal = withHostClose(
      new UpdateReminderModal(
        {} as never,
        "title",
        "body",
        "snooze",
        "skip",
        "ok",
        "cancel",
      ),
    );
    const chosen = chooseModal.awaitSelection();
    (chooseModal as unknown as {
      settle(value: "snooze" | "skipVersion" | null): void;
    }).settle("skipVersion");
    await expect(chosen).resolves.toBe("skipVersion");

    const closedModal = withHostClose(
      new UpdateReminderModal(
        {} as never,
        "title",
        "body",
        "snooze",
        "skip",
        "ok",
        "cancel",
      ),
    );
    const closed = closedModal.awaitSelection();
    closedModal.close();
    await expect(closed).resolves.toBeNull();
  });
});
