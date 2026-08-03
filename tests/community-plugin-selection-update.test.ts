import { describe, expect, it } from "vitest";
import {
  enableCommunityPluginDataWithFiles,
  updateAllCommunityPluginSelections,
  updateCommunityPluginSelection,
  type CommunityPluginSelectionSettings,
} from "../src/sync/community-plugin-selection-update";
import { isPluginSelected } from "../src/sync/community-plugin-sync-policy";

const knownIds = ["calendar", "dataview", "excalidraw"];

function defaultSettings(): CommunityPluginSelectionSettings {
  return {
    filesEnabled: true,
    dataEnabled: true,
    policy: {
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "all", pluginIds: [] },
    },
  };
}

describe("community plugin selection updates", () => {
  it("uses the outer files switch to enable or disable every plugin", () => {
    const partial: CommunityPluginSelectionSettings = {
      filesEnabled: true,
      dataEnabled: true,
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "selected", pluginIds: ["calendar"] },
      },
    };
    const paused = updateAllCommunityPluginSelections(
      partial,
      "files",
      false,
      knownIds,
    );
    expect(paused).toEqual({
      filesEnabled: false,
      dataEnabled: false,
      policy: {
        version: 1,
        files: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: knownIds,
        },
        data: partial.policy.data,
      },
    });
    expect(updateAllCommunityPluginSelections(
      JSON.parse(JSON.stringify(paused)),
      "files",
      true,
      knownIds,
    )).toEqual({
      filesEnabled: true,
      dataEnabled: false,
      policy: {
        version: 1,
        files: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: knownIds,
        },
        data: partial.policy.data,
      },
    });
  });

  it("uses the outer data switch to enable or disable all eligible data", () => {
    const partial: CommunityPluginSelectionSettings = {
      filesEnabled: true,
      dataEnabled: true,
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "selected", pluginIds: ["calendar"] },
      },
    };
    const paused = updateAllCommunityPluginSelections(
      partial,
      "data",
      false,
      ["calendar"],
    );
    expect(paused).toEqual({
      ...partial,
      dataEnabled: false,
      policy: {
        ...partial.policy,
        data: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: ["calendar"],
        },
      },
    });
    expect(updateAllCommunityPluginSelections(
      JSON.parse(JSON.stringify(paused)),
      "data",
      true,
      ["calendar"],
    )).toEqual({
      ...partial,
      policy: {
        ...partial.policy,
        data: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: ["calendar"],
        },
      },
    });
  });

  it("turns a cold disabled scope into explicit restore authority for known plugins", () => {
    const disabled: CommunityPluginSelectionSettings = {
      filesEnabled: false,
      dataEnabled: false,
      policy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "all", pluginIds: [] },
      },
    };

    expect(updateAllCommunityPluginSelections(
      disabled,
      "files",
      true,
      ["calendar"],
    ).policy.files).toEqual({
      mode: "all",
      pluginIds: [],
      restoringPluginIds: ["calendar"],
    });
  });

  it("keeps all-mode exclusions local while new plugins remain enabled", () => {
    const next = updateCommunityPluginSelection(
      defaultSettings(),
      "files",
      "calendar",
      false,
      knownIds,
    );
    expect(next).toEqual({
      filesEnabled: true,
      dataEnabled: true,
      policy: {
        version: 1,
        files: {
          mode: "all",
          pluginIds: [],
          ignoredPluginIds: ["calendar"],
        },
        data: { mode: "all", pluginIds: [] },
      },
    });
  });

  it("keeps newly discovered plugins enabled until explicitly ignored", () => {
    const next = updateCommunityPluginSelection(
      defaultSettings(),
      "files",
      "calendar",
      false,
      knownIds,
    );

    expect(next.policy.files.mode).toBe("all");
    expect(next.policy.files.ignoredPluginIds).toEqual(["calendar"]);
    expect(isPluginSelected(next.policy.files, "new-plugin")).toBe(true);
  });

  it("turns off the outer range when selected mode loses its last item", () => {
    const current: CommunityPluginSelectionSettings = {
      filesEnabled: true,
      dataEnabled: false,
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "all", pluginIds: [] },
      },
    };
    expect(updateCommunityPluginSelection(
      current,
      "files",
      "calendar",
      false,
      knownIds,
    )).toEqual({
      filesEnabled: false,
      dataEnabled: false,
      policy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "all", pluginIds: [] },
      },
    });
  });

  it("carries an explicit ignored-plugin rejoin as one-shot restore authority", () => {
    const current = defaultSettings();
    current.policy.files.ignoredPluginIds = ["calendar"];

    const rejoined = updateCommunityPluginSelection(
      current,
      "files",
      "calendar",
      true,
      knownIds,
    );

    expect(rejoined.policy.files).toEqual({
      mode: "all",
      pluginIds: [],
      restoringPluginIds: ["calendar"],
    });
    expect(isPluginSelected(rejoined.policy.files, "calendar")).toBe(true);
    expect(updateCommunityPluginSelection(
      rejoined,
      "files",
      "calendar",
      false,
      knownIds,
    ).policy.files).toEqual({
      mode: "all",
      pluginIds: [],
      ignoredPluginIds: ["calendar"],
    });
  });

  it("does not enable data for a restricted plugin without confirmation", () => {
    const current: CommunityPluginSelectionSettings = {
      filesEnabled: true,
      dataEnabled: true,
      policy: {
        version: 1,
        files: {
          mode: "all",
          pluginIds: [],
          ignoredPluginIds: ["excalidraw"],
        },
        data: { mode: "all", pluginIds: [] },
      },
    };
    expect(updateCommunityPluginSelection(
      current,
      "data",
      "excalidraw",
      true,
      knownIds,
    )).toEqual(current);

    expect(enableCommunityPluginDataWithFiles(
      current,
      "excalidraw",
      knownIds,
    )).toEqual({
      filesEnabled: true,
      dataEnabled: true,
      policy: {
        version: 1,
        files: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: ["excalidraw"],
        },
        data: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: ["excalidraw"],
        },
      },
    });
  });

  it("uses selected mode when confirmation starts from both outer switches off", () => {
    const current: CommunityPluginSelectionSettings = {
      filesEnabled: false,
      dataEnabled: false,
      policy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "all", pluginIds: [] },
      },
    };
    expect(enableCommunityPluginDataWithFiles(
      current,
      "calendar",
      knownIds,
    )).toEqual({
      filesEnabled: true,
      dataEnabled: true,
      policy: {
        version: 1,
        files: {
          mode: "selected",
          pluginIds: ["calendar"],
          restoringPluginIds: ["calendar"],
        },
        data: {
          mode: "selected",
          pluginIds: ["calendar"],
          restoringPluginIds: ["calendar"],
        },
      },
    });
  });
});
