import { describe, expect, it } from "vitest";
import { SequentialSettingsUpdateQueue } from "../src/ui/sequential-settings-update-queue";

describe("sequential settings update queue", () => {
  it("starts each task after the previous commit and observes its latest state", async () => {
    const queue = new SequentialSettingsUpdateQueue();
    const events: string[] = [];
    let committed = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push(`first-read:${committed}`);
      await firstGate;
      committed = 1;
      events.push("first-commit");
    });
    const second = queue.enqueue(async () => {
      events.push(`second-read:${committed}`);
      committed = 2;
      events.push("second-commit");
    });

    await Promise.resolve();
    expect(events).toEqual(["first-read:0"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first-read:0",
      "first-commit",
      "second-read:1",
      "second-commit",
    ]);
    expect(committed).toBe(2);
  });

  it("continues with later tasks after one write fails", async () => {
    const queue = new SequentialSettingsUpdateQueue();
    const failed = queue.enqueue(async () => {
      throw new Error("write failed");
    });
    let completed = false;
    const later = queue.enqueue(async () => {
      completed = true;
    });

    await expect(failed).rejects.toThrow("write failed");
    await later;
    expect(completed).toBe(true);
  });

  it("reports idle only after every queued settings write has settled", async () => {
    const queue = new SequentialSettingsUpdateQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    void queue.enqueue(async () => {
      await firstGate;
      events.push("first");
    });
    const idle = queue.whenIdle().then(() => {
      events.push("idle");
    });
    void queue.enqueue(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual([]);
    releaseFirst();
    await idle;
    expect(events).toEqual(["first", "second", "idle"]);
  });
});
