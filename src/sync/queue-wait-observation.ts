/**
 * Observation-only queue wait accounting.
 *
 * Four serial points decide when a sync round actually gets to work: the
 * physical PluginData write queue, the state-manager PluginData commit queue,
 * the V2 commit queue, and the side-action queue. A round that looks "stuck
 * with no logs" is usually parked in one of them, and none of them records the
 * wait between enqueue and start.
 *
 * The counters live in one process-wide instance because there is one sync
 * pipeline per plugin instance and a side action can be enqueued before a round
 * starts. Nothing here feeds a decision: the values are read once per round
 * into the `sync run phase summary` line. `noteDequeue` returns a warning only
 * when the wait crosses `QUEUE_WAIT_WARN_MS`, at most once per lane per
 * cooldown, so a 2,000-file delete cannot turn this into a per-file log (warn
 * lines flush immediately); the caller owns the sink.
 */

type QueueWaitLane =
  | "pluginDataSave"
  | "pluginDataCommit"
  | "v2Commit"
  | "sideAction";

export const QUEUE_WAIT_WARN_MS = 15_000;
export const QUEUE_WAIT_WARN_COOLDOWN_MS = 60_000;

interface QueueWaitWarning {
  lane: QueueWaitLane;
  waitMs: number;
  depth: number;
  suppressed: number;
}

interface QueueWaitLaneSnapshot {
  waits: number;
  maxWaitMs: number;
  maxDepth: number;
  warnings: number;
  suppressed: number;
}

interface QueueWaitLaneState extends QueueWaitLaneSnapshot {
  depth: number;
  lastWarnAt: number;
}

type QueueWaitSnapshot = Record<QueueWaitLane, QueueWaitLaneSnapshot>;

const LANES: readonly QueueWaitLane[] = [
  "pluginDataSave",
  "pluginDataCommit",
  "v2Commit",
  "sideAction",
];

function emptyLaneState(): QueueWaitLaneState {
  return {
    depth: 0,
    maxDepth: 0,
    waits: 0,
    maxWaitMs: 0,
    warnings: 0,
    suppressed: 0,
    lastWarnAt: 0,
  };
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

export class QueueWaitObservation {
  private readonly lanes = new Map<QueueWaitLane, QueueWaitLaneState>();

  /** Start a new accounting window (one sync round): zero the per-round
   *  accumulators while keeping live depth, so a side action that was already
   *  queued before the round still counts in `maxDepth` when it starts. */
  startWindow(): void {
    for (const state of this.lanes.values()) {
      state.waits = 0;
      state.maxWaitMs = 0;
      state.maxDepth = state.depth;
      state.warnings = 0;
      state.suppressed = 0;
      state.lastWarnAt = 0;
    }
  }

  /** Mark one task as enqueued. Call the returned release exactly once when it
   *  settles; double release is a no-op. */
  enter(lane: QueueWaitLane): () => void {
    const state = this.lane(lane);
    state.depth += 1;
    state.maxDepth = Math.max(state.maxDepth, state.depth);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.depth = Math.max(0, state.depth - 1);
    };
  }

  /** Record the enqueue→start wait of one task. Returns a warning when this
   *  wait crossed the threshold and the lane is past its cooldown; the caller
   *  decides how to log it. Observation only. */
  noteDequeue(
    lane: QueueWaitLane,
    waitMs: number,
    now = Date.now(),
  ): QueueWaitWarning | null {
    const state = this.lane(lane);
    state.waits += 1;
    state.maxWaitMs = Math.max(state.maxWaitMs, waitMs);
    if (waitMs < QUEUE_WAIT_WARN_MS) return null;
    if (
      state.lastWarnAt > 0
      && now - state.lastWarnAt < QUEUE_WAIT_WARN_COOLDOWN_MS
    ) {
      state.suppressed += 1;
      return null;
    }
    const suppressed = state.suppressed;
    state.suppressed = 0;
    state.warnings += 1;
    state.lastWarnAt = now;
    return {
      lane,
      waitMs: roundMs(waitMs),
      depth: state.depth,
      suppressed,
    };
  }

  /** Per-round numbers for the phase summary. Never a decision input. */
  snapshot(): QueueWaitSnapshot {
    const snapshot = {} as QueueWaitSnapshot;
    for (const lane of LANES) {
      const state = this.lane(lane);
      snapshot[lane] = {
        waits: state.waits,
        maxWaitMs: roundMs(state.maxWaitMs),
        maxDepth: state.maxDepth,
        warnings: state.warnings,
        suppressed: state.suppressed,
      };
    }
    return snapshot;
  }

  private lane(lane: QueueWaitLane): QueueWaitLaneState {
    let state = this.lanes.get(lane);
    if (!state) {
      state = emptyLaneState();
      this.lanes.set(lane, state);
    }
    return state;
  }
}

/** The one process-wide accounting instance. */
export const queueWaitObservation = new QueueWaitObservation();
