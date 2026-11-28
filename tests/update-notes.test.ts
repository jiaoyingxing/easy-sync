import { describe, expect, it, vi } from "vitest";
import {
  fetchPendingUpdateNotes,
  parseUpdateReleaseNotes,
  releasePageUrl,
  resolveUpdateNotesDisplayState,
  selectPendingUpdateNotes,
  type UpdateReleaseNote,
} from "../src/update-notes";
import en from "../src/i18n/en";
import zhCN from "../src/i18n/zh-cn";

/** 定稿文案逐字断言（2026-11-27 用户拍板：侧栏内联、无查看详情）。 */
describe("update notes finalized copy", () => {
  it("pins the section title and the loading line", () => {
    expect(zhCN["updateCheck.notesSectionTitle"]).toBe("更新内容");
    expect(en["updateCheck.notesSectionTitle"]).toBe("Release notes");
    expect(zhCN["updateCheck.notesLoading"]).toBe("正在获取更新内容…");
    expect(en["updateCheck.notesLoading"]).toBe("Loading release notes…");
  });

  it("pins the failure and empty lines", () => {
    expect(zhCN["updateCheck.notesLoadFailed"]).toBe("未能获取更新内容。");
    expect(en["updateCheck.notesLoadFailed"]).toBe(
      "Couldn’t load the release notes.",
    );
    expect(zhCN["updateCheck.notesEmpty"]).toBe(
      "没有找到待更新版本的说明。",
    );
    expect(en["updateCheck.notesEmpty"]).toBe(
      "No release notes found for the pending update.",
    );
    expect(zhCN["updateCheck.notesEmptyRelease"]).toBe(
      "这个版本没有提供更新说明。",
    );
    expect(en["updateCheck.notesEmptyRelease"]).toBe(
      "No notes were published for this release.",
    );
  });

  it("pins the two inline exits", () => {
    expect(zhCN["updateCheck.notesRetry"]).toBe("重试");
    expect(en["updateCheck.notesRetry"]).toBe("Retry");
    expect(zhCN["updateCheck.notesOpenInBrowser"]).toBe("在浏览器中查看");
    expect(en["updateCheck.notesOpenInBrowser"]).toBe("Open in browser");
  });
});

describe("parseUpdateReleaseNotes", () => {
  it("keeps stable public releases and skips drafts, prereleases and bad tags", () => {
    const notes = parseUpdateReleaseNotes(
      JSON.stringify([
        { tag_name: "1.7.1", body: "B1" },
        { tag_name: "1.7.2", body: "B2", draft: false, prerelease: false },
        { tag_name: "1.7.3-beta", body: "unstable tag" },
        { tag_name: "1.7.4", body: "prerelease", prerelease: true },
        { tag_name: "1.7.5", body: "draft", draft: true },
        { tag_name: "v1.7.6", body: "v prefix" },
        null,
        "not a record",
        {},
        { tag_name: "1.7.2", body: "duplicate" },
        { tag_name: "1.8.0", body: null },
        { tag_name: "1.6.0", body: "older" },
      ]),
    );

    expect(notes?.map((note) => note.version)).toEqual([
      "1.7.1",
      "1.7.2",
      "1.8.0",
      "1.6.0",
    ]);
    // Missing body is an empty body, not a dropped release.
    expect(notes?.[2].body).toBe("");
    // Duplicate tags keep the first entry.
    expect(notes?.[1].body).toBe("B2");
  });

  it("rejects malformed payloads but accepts an empty array", () => {
    expect(parseUpdateReleaseNotes("not json")).toBeNull();
    expect(parseUpdateReleaseNotes("{}")).toBeNull();
    expect(parseUpdateReleaseNotes("null")).toBeNull();
    expect(parseUpdateReleaseNotes("[]")).toEqual([]);
  });
});

describe("selectPendingUpdateNotes", () => {
  const note = (version: string): UpdateReleaseNote => ({
    version,
    body: `notes ${version}`,
  });

  it("keeps current < tag <= latest and sorts newest first", () => {
    const selected = selectPendingUpdateNotes(
      [
        note("1.7.1"),
        note("1.7.3"),
        note("1.6.0"),
        note("1.7.2"),
        note("1.7.0"),
      ],
      "1.7.0",
      "1.7.2",
    );
    expect(selected.map((entry) => entry.version)).toEqual(["1.7.2", "1.7.1"]);
  });

  it("returns empty when the running version already matches latest", () => {
    expect(
      selectPendingUpdateNotes([note("1.7.2")], "1.7.2", "1.7.2"),
    ).toEqual([]);
  });
});

describe("resolveUpdateNotesDisplayState", () => {
  const notes = [{ version: "1.7.2", body: "B" }];

  it("cache wins for the matching latest", () => {
    expect(
      resolveUpdateNotesDisplayState({
        latest: "1.7.2",
        cache: { latest: "1.7.2", notes },
        error: { latest: "1.7.2" },
      }),
    ).toEqual({ status: "ready", notes });
    expect(
      resolveUpdateNotesDisplayState({
        latest: "1.7.2",
        cache: { latest: "1.7.2", notes: [] },
        error: null,
      }),
    ).toEqual({ status: "empty" });
  });

  it("reports an error only for its own latest", () => {
    expect(
      resolveUpdateNotesDisplayState({
        latest: "1.7.2",
        cache: null,
        error: { latest: "1.7.2" },
      }),
    ).toEqual({ status: "error" });
    expect(
      resolveUpdateNotesDisplayState({
        latest: "1.7.2",
        cache: null,
        error: { latest: "1.7.1" },
      }),
    ).toEqual({ status: "loading" });
  });

  it("reports loading when the latest has no record yet", () => {
    expect(
      resolveUpdateNotesDisplayState({
        latest: "1.7.2",
        cache: { latest: "1.7.1", notes },
        error: null,
      }),
    ).toEqual({ status: "loading" });
  });
});

describe("fetchPendingUpdateNotes", () => {
  const payload = JSON.stringify([
    { tag_name: "1.7.2", body: "B2" },
    { tag_name: "1.7.1", body: "B1" },
    { tag_name: "1.6.0", body: "old" },
  ]);

  it("requests the public releases endpoint and selects the pending notes", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, text: payload }));
    await expect(
      fetchPendingUpdateNotes(fetcher, "1.6.0", "1.7.2"),
    ).resolves.toEqual([
      { version: "1.7.2", body: "B2" },
      { version: "1.7.1", body: "B1" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith({
      url: "https://api.github.com/repos/jiaoyingxing/easy-sync/releases?per_page=30",
      method: "GET",
    });
  });

  it("returns null on HTTP failure, malformed payload or network rejection", async () => {
    await expect(
      fetchPendingUpdateNotes(
        async () => ({ status: 500, text: payload }),
        "1.6.0",
        "1.7.2",
      ),
    ).resolves.toBeNull();
    await expect(
      fetchPendingUpdateNotes(
        async () => ({ status: 200, text: "{}" }),
        "1.6.0",
        "1.7.2",
      ),
    ).resolves.toBeNull();
    await expect(
      fetchPendingUpdateNotes(
        async () => {
          throw new Error("offline");
        },
        "1.6.0",
        "1.7.2",
      ),
    ).resolves.toBeNull();
  });

  it("returns an empty array when no pending release matches", async () => {
    await expect(
      fetchPendingUpdateNotes(
        async () => ({ status: 200, text: payload }),
        "1.7.2",
        "1.7.2",
      ),
    ).resolves.toEqual([]);
  });
});

describe("releasePageUrl", () => {
  it("points at the version's public release page", () => {
    expect(releasePageUrl("1.7.2")).toBe(
      "https://github.com/jiaoyingxing/easy-sync/releases/tag/1.7.2",
    );
  });
});
