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
      stages: [
        { stage: "onload:ui-ready", atMs: 4.125 },
        { stage: "state:ready", atMs: 12.5 },
        { stage: "auth:ready", atMs: 750.75 },
      ],
      onloadReturnedMs: null,
      layoutReadyMs: null,
      hostLayoutWaitMs: null,
      host: null,
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

  it("separates the plugin onload segment from the host layout-ready wait", () => {
    let now = 0;
    const tracker = new StartupPerformanceTracker(() => now);

    tracker.begin("mobile");
    tracker.setHostFacts({
      apiVersion: "1.11.4",
      pluginVersion: "1.6.6",
      visibilityAtOnload: "visible",
    });
    now = 10;
    tracker.markOnloadReturned();
    now = 110;
    tracker.markLayoutReady();
    now = 2;
    tracker.markUiReady();
    now = 20;
    tracker.markStateReady(readyState);
    now = 30;
    tracker.markAuthReady(readyAuth);
    // Marks may complete out of declaration order once work is parallel;
    // export sorts by the recorded time instead of call order.
    now = 8;
    tracker.markStage("settings:loaded");
    now = 4;
    tracker.markStage("plugin-data:read");

    const summary = tracker.takeCompletedSummary();
    expect(summary).toMatchObject({
      platform: "mobile",
      onloadReturnedMs: 10,
      layoutReadyMs: 110,
      hostLayoutWaitMs: 100,
      host: {
        apiVersion: "1.11.4",
        pluginVersion: "1.6.6",
        visibilityAtOnload: "visible",
      },
    });
    expect(summary?.stages.map((mark) => mark.stage)).toEqual([
      "onload:ui-ready",
      "plugin-data:read",
      "settings:loaded",
      "onload:returned",
      "state:ready",
      "auth:ready",
      "host:layout-ready",
    ]);
  });
});
