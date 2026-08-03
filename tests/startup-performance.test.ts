import { describe, expect, it } from "vitest";
import {
  StartupPerformanceTracker,
  type StartupAuthEvidence,
  type StartupStateEvidence,
} from "../src/startup-performance";

const readyState: StartupStateEvidence = {
  outcome: "ready",
  activeV2: true,
  authorityBlocked: false,
  blockReason: null,
  remoteFiles: 500,
  remoteFolders: 25,
  mutationLedger: 0,
  pendingReview: false,
};

const readyAuth: StartupAuthEvidence = {
  outcome: "ready",
  loggedIn: true,
  accountVerified: true,
};

describe("StartupPerformanceTracker", () => {
  it("emits one path-free summary after UI, state and auth are all ready", () => {
    let now = 100;
    const tracker = new StartupPerformanceTracker(() => now);

    tracker.begin("desktop");
    now = 104.125;
    tracker.recordPluginDataRead(3.5, 39);
    tracker.markUiReady();
    now = 112.5;
    tracker.markStateReady(readyState);
    tracker.recordPluginDataWrite(2.25);
    now = 850.75;
    tracker.markAuthReady(readyAuth);

    expect(tracker.takeCompletedSummary()).toEqual({
      schemaVersion: 1,
      platform: "desktop",
      readyMs: {
        ui: 4.125,
        state: 12.5,
        auth: 750.75,
        total: 750.75,
      },
      pluginData: {
        physicalReads: 1,
        readMs: 3.5,
        topLevelKeys: 39,
        writesBeforeReady: 1,
        writeMs: 2.25,
      },
      state: readyState,
      auth: readyAuth,
    });
    expect(tracker.takeCompletedSummary()).toBeNull();
  });

  it("does not expose a partial state as ready and ignores late operations", () => {
    let now = 0;
    const tracker = new StartupPerformanceTracker(() => now);

    tracker.begin("mobile");
    now = 2;
    tracker.markUiReady();
    now = 8;
    tracker.markStateReady({
      ...readyState,
      outcome: "failed",
      activeV2: false,
      authorityBlocked: true,
      blockReason: "state-load-rejected",
      remoteFiles: 0,
      remoteFolders: 0,
    });
    expect(tracker.takeCompletedSummary()).toBeNull();

    now = 25;
    tracker.markAuthReady({
      outcome: "ready",
      loggedIn: false,
      accountVerified: false,
    });
    expect(tracker.takeCompletedSummary()).toMatchObject({
      platform: "mobile",
      readyMs: { ui: 2, state: 8, auth: 25, total: 25 },
      state: {
        outcome: "failed",
        authorityBlocked: true,
        blockReason: "state-load-rejected",
      },
      auth: {
        outcome: "ready",
        loggedIn: false,
        accountVerified: false,
      },
    });

    tracker.recordPluginDataRead(10, 100);
    tracker.recordPluginDataWrite(10);
    expect(tracker.takeCompletedSummary()).toBeNull();
  });

  it("cancels an unfinished instance without emitting stale readiness", () => {
    let now = 10;
    const tracker = new StartupPerformanceTracker(() => now);

    tracker.begin("desktop");
    tracker.markUiReady();
    tracker.cancel();
    now = 20;
    tracker.markStateReady(readyState);
    tracker.markAuthReady(readyAuth);

    expect(tracker.takeCompletedSummary()).toBeNull();
  });
});
