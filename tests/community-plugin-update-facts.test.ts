import { describe, expect, it } from "vitest";
import {
  buildCommunityPluginUpdateFacts,
  type CommunityPluginAutoUpdateCandidate,
} from "../src/sync/community-plugin-update-facts";
import { SyncActionType } from "../src/sync/types";

const configDir = ".obsidian";

function download(
  path: string,
): { path: string; actionType: SyncActionType.Download } {
  return { path, actionType: SyncActionType.Download };
}

describe("community plugin update facts", () => {
  it("collects one deduped candidate per participating plugin whose bundle files were downloaded", () => {
    const candidates = buildCommunityPluginUpdateFacts({
      configDir,
      participatingBeforePluginIds: ["calendar"],
      files: [
        download(`${configDir}/plugins/calendar/main.js`),
        // Duplicate completion entries for the same member still dedupe.
        download(`${configDir}/plugins/calendar/main.js`),
        download(`${configDir}/plugins/calendar/manifest.json`),
        download(`${configDir}/plugins/calendar/styles.css`),
      ],
    });
    expect(candidates).toEqual([{ pluginId: "calendar", manifestDownloaded: true }]);
  });

  it("ignores downloads outside the direct plugin bundle members", () => {
    const candidates = buildCommunityPluginUpdateFacts({
      configDir,
      participatingBeforePluginIds: ["calendar", "dataview"],
      files: [
        download("notes/meeting.md"),
        download(`${configDir}/plugins/calendar/data.json`), // plugin data, not bundle code
        download(`${configDir}/plugins/calendar/assets/icon.svg`), // nested asset
        download(`${configDir}/plugins/calendar/main.js.backup`), // unrecognized file name
        download(".obsidian-other/plugins/calendar/main.js"), // different config dir
        download(`${configDir}/plugins/dataview/manifest.json`), // real bundle member
      ],
    });
    expect(candidates).toEqual([{ pluginId: "dataview", manifestDownloaded: true }]);
  });

  it("excludes the sync plugin's own downloaded bundle", () => {
    const candidates = buildCommunityPluginUpdateFacts({
      configDir,
      ownPluginId: "easy-sync",
      participatingBeforePluginIds: ["easy-sync", "calendar"],
      files: [
        download(`${configDir}/plugins/easy-sync/main.js`),
        download(`${configDir}/plugins/easy-sync/manifest.json`),
        download(`${configDir}/plugins/calendar/main.js`),
      ],
    });
    expect(candidates).toEqual([{ pluginId: "calendar", manifestDownloaded: false }]);
  });

  it("excludes plugins that were not already participating before the round", () => {
    // A plugin that did not participate before this round arrived through an
    // explicit accept / fresh join / restore path with its own prompt semantics.
    const candidates = buildCommunityPluginUpdateFacts({
      configDir,
      participatingBeforePluginIds: ["calendar"],
      files: [
        download(`${configDir}/plugins/dataview/main.js`),
        download(`${configDir}/plugins/dataview/manifest.json`),
        download(`${configDir}/plugins/calendar/styles.css`),
      ],
    });
    expect(candidates).toEqual([{ pluginId: "calendar", manifestDownloaded: false }]);
    // Without participation facts nothing is claimed to be an auto update.
    expect(buildCommunityPluginUpdateFacts({
      configDir,
      files: [download(`${configDir}/plugins/calendar/main.js`)],
    })).toEqual([]);
  });

  it("marks manifestDownloaded only when the round downloaded the manifest.json member", () => {
    const candidates = buildCommunityPluginUpdateFacts({
      configDir,
      participatingBeforePluginIds: ["quickadd", "calendar"],
      files: [
        download(`${configDir}/plugins/quickadd/main.js`),
        download(`${configDir}/plugins/quickadd/manifest.json`),
        download(`${configDir}/plugins/calendar/main.js`),
        download(`${configDir}/plugins/calendar/styles.css`),
      ],
    });
    expect(candidates).toEqual([
      { pluginId: "quickadd", manifestDownloaded: true },
      { pluginId: "calendar", manifestDownloaded: false },
    ]);
  });

  it("keeps a styles.css-only update as a candidate with manifestDownloaded=false", () => {
    const candidates = buildCommunityPluginUpdateFacts({
      configDir,
      participatingBeforePluginIds: ["calendar"],
      files: [download(`${configDir}/plugins/calendar/styles.css`)],
    });
    expect(candidates).toEqual([{ pluginId: "calendar", manifestDownloaded: false }]);
  });

  it("returns an empty list for an empty completed-files list", () => {
    expect(buildCommunityPluginUpdateFacts({
      configDir,
      participatingBeforePluginIds: ["calendar"],
      files: [],
    })).toEqual([]);
  });

  it("ignores non-Download actions even on participating bundle paths", () => {
    const candidates = buildCommunityPluginUpdateFacts({
      configDir,
      participatingBeforePluginIds: ["calendar", "quickadd"],
      files: [
        // An upload of the manifest is not an auto update this round.
        {
          path: `${configDir}/plugins/quickadd/manifest.json`,
          actionType: SyncActionType.Upload,
        },
        // An entry without an action type (optional field) is not a download.
        { path: `${configDir}/plugins/quickadd/main.js` },
        // A real download of only the styles member stays a candidate.
        download(`${configDir}/plugins/calendar/styles.css`),
      ],
    });
    expect(candidates).toEqual([{ pluginId: "calendar", manifestDownloaded: false }]);
    expect<CommunityPluginAutoUpdateCandidate[]>(candidates).toHaveLength(1);
  });
});
