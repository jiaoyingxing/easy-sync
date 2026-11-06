import { describe, expect, it } from "vitest";
import {
  QUEUE_WAIT_WARN_COOLDOWN_MS,
  QUEUE_WAIT_WARN_MS,
  QueueWaitObservation,
} from "../src/sync/queue-wait-observation";

describe("QueueWaitObservation", () => {
  it("tracks live depth and never goes negative on a double release", () => {
    const observation = new QueueWaitObservation();
    const releaseA = observation.enter("sideAction");
    const releaseB = observation.enter("sideAction");
    expect(observation.snapshot().sideAction.maxDepth).toBe(2);

    releaseA();
    releaseA();
    releaseB();
    expect(observation.snapshot().sideAction.maxDepth).toBe(2);
  });

  it("records wait counts and keeps the worst wait per lane", () => {
    const observation = new QueueWaitObservation();
    const release = observation.enter("v2Commit");
    expect(observation.noteDequeue("v2Commit", 12.34567)).toBeNull();
    expect(observation.noteDequeue("v2Commit", 3)).toBeNull();
    release();

    const snapshot = observation.snapshot().v2Commit;
    expect(snapshot.waits).toBe(2);
    expect(snapshot.maxWaitMs).toBe(12.346);
    expect(snapshot.maxDepth).toBe(1);
    expect(snapshot.warnings).toBe(0);
  });

  it("warns once above the threshold, suppresses inside the cooldown, then resumes", () => {
    const observation = new QueueWaitObservation();
    const release = observation.enter("pluginDataSave");

    expect(observation.noteDequeue(
      "pluginDataSave",
      QUEUE_WAIT_WARN_MS - 1,
      1_000,
    )).toBeNull();

    const first = observation.noteDequeue(
      "pluginDataSave",
      QUEUE_WAIT_WARN_MS,
      2_000,
    );
    expect(first).toMatchObject({ lane: "pluginDataSave", suppressed: 0 });

    expect(observation.noteDequeue(
      "pluginDataSave",
      QUEUE_WAIT_WARN_MS * 2,
      3_000,
    )).toBeNull();
    expect(observation.noteDequeue(
      "pluginDataSave",
      QUEUE_WAIT_WARN_MS * 3,
      4_000,
    )).toBeNull();
    expect(observation.snapshot().pluginDataSave.suppressed).toBe(2);

    const resumed = observation.noteDequeue(
      "pluginDataSave",
      QUEUE_WAIT_WARN_MS,
      2_000 + QUEUE_WAIT_WARN_COOLDOWN_MS,
    );
    expect(resumed).toMatchObject({ suppressed: 2 });
    expect(observation.snapshot().pluginDataSave.warnings).toBe(2);
    release();
  });

  it("starts a window without losing the depth of work already queued", () => {
    const observation = new QueueWaitObservation();
    const release = observation.enter("sideAction");
    observation.noteDequeue("sideAction", 20_000);
    expect(observation.snapshot().sideAction.waits).toBe(1);

    observation.startWindow();
    const window = observation.snapshot().sideAction;
    expect(window.waits).toBe(0);
    expect(window.maxWaitMs).toBe(0);
    expect(window.maxDepth).toBe(1);
    release();
  });

  it("reports a fixed lane set even for lanes that never ran", () => {
    const snapshot = new QueueWaitObservation().snapshot();
    expect(Object.keys(snapshot).sort()).toEqual([
      "pluginDataCommit",
      "pluginDataSave",
      "sideAction",
      "v2Commit",
    ]);
    expect(snapshot.pluginDataCommit).toEqual({
      waits: 0,
      maxWaitMs: 0,
      maxDepth: 0,
      warnings: 0,
      suppressed: 0,
    });
  });
});
