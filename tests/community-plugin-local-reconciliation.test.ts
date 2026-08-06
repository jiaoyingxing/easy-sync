import { describe, expect, it } from "vitest";
import {
  planCommunityPluginLocalReconciliation,
} from "../src/sync/community-plugin-local-reconciliation";
import {
  createEmptyDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
} from "../src/sync/community-plugin-participation";

function participatingState() {
  return reduceDeviceCommunityPluginParticipation(
    createEmptyDeviceCommunityPluginParticipation(true),
    {
      type: "confirm-participating",
      pluginId: "calendar",
      joinedGeneration: 4,
      localBundleDigest: "a".repeat(64),
    },
  );
}

describe("community plugin local reconciliation", () => {
  it("requires two complete absence observations before exclusion", () => {
    const first = planCommunityPluginLocalReconciliation({
      participation: participatingState(),
      localBundleFacts: new Map([["calendar", "absent"]]),
      operationId: () => "exit-calendar-1",
    });

    expect(first.commands).toEqual([{
      type: "request-exit",
      pluginId: "calendar",
      operationId: "exit-calendar-1",
    }]);
    expect(first.followUpPluginIds).toEqual(["calendar"]);

    const exiting = reduceDeviceCommunityPluginParticipation(
      participatingState(),
      first.commands[0]!,
    );
    expect(exiting.pluginsById.calendar).toMatchObject({
      phase: "exit-requested",
      joinedGeneration: 4,
      lastConfirmedLocalBundleDigest: "a".repeat(64),
    });
    expect(planCommunityPluginLocalReconciliation({
      participation: exiting,
      localBundleFacts: new Map([["calendar", "absent"]]),
      operationId: () => "unused",
    }).commands).toEqual([{
      type: "confirm-excluded",
      pluginId: "calendar",
    }]);
  });

  it("cancels a transient exit when any managed file returns", () => {
    const exiting = reduceDeviceCommunityPluginParticipation(
      participatingState(),
      {
        type: "request-exit",
        pluginId: "calendar",
        operationId: "exit-calendar-1",
      },
    );

    for (const fact of ["partial", "complete"] as const) {
      expect(planCommunityPluginLocalReconciliation({
        participation: exiting,
        localBundleFacts: new Map([["calendar", fact]]),
        operationId: () => "unused",
      }).commands).toEqual([{
        type: "confirm-participating",
        pluginId: "calendar",
        joinedGeneration: 4,
        localBundleDigest: "a".repeat(64),
      }]);
    }
  });

  it("does not infer exits for partial bundles or non-participating rows", () => {
    const participation = reduceDeviceCommunityPluginParticipation(
      participatingState(),
      { type: "confirm-excluded", pluginId: "dataview" },
    );

    expect(planCommunityPluginLocalReconciliation({
      participation,
      localBundleFacts: new Map([
        ["calendar", "partial"],
        ["dataview", "absent"],
      ]),
      operationId: () => "unused",
    })).toEqual({
      commands: [],
      followUpPluginIds: [],
      autoParticipatedPluginIds: [],
    });
  });

  it("auto-participates complete local installs only when there is no prior opt-out", () => {
    const participation = reduceDeviceCommunityPluginParticipation(
      reduceDeviceCommunityPluginParticipation(
        createEmptyDeviceCommunityPluginParticipation(true),
        { type: "mark-never-participated", pluginId: "calendar" },
      ),
      { type: "confirm-excluded", pluginId: "dataview" },
    );

    const planned = planCommunityPluginLocalReconciliation({
      participation,
      localBundleFacts: new Map([
        ["calendar", "complete"],
        ["dataview", "complete"],
        ["quickadd", "complete"],
        ["partial-local", "partial"],
      ]),
      operationId: () => "unused",
      autoParticipatePluginIds: [
        "calendar",
        "dataview",
        "quickadd",
        "partial-local",
      ],
    });

    expect(planned.commands).toEqual([
      { type: "confirm-participating", pluginId: "calendar" },
      { type: "confirm-participating", pluginId: "quickadd" },
    ]);
    expect(planned.autoParticipatedPluginIds).toEqual([
      "calendar",
      "quickadd",
    ]);
  });
});
