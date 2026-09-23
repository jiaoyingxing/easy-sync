import { describe, expect, it, vi } from "vitest";
import {
  fetchLatestStableVersion,
  isStableVersion,
  isNewerVersion,
  isUpdateCheckDue,
  isUpdateReminderSuppressed,
  loadUpdateCheckState,
  pickLatestStableVersion,
  saveUpdateCheckState,
  seedUpdateCheckStateFromLegacyPluginData,
  SNOOZE_DURATION_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCheckStorage,
} from "../src/update-check";
import en from "../src/i18n/en";
import zhCN from "../src/i18n/zh-cn";

/** 定稿文案逐字断言（用户拍板 2026-09-15，语言收口落长期保护）。 */
describe("update reminder finalized copy", () => {
  it("row body asks the upgrade question with both versions", () => {
    expect(zhCN["updateCheck.rowBody"]).toBe(
      "本插件已发布 {latest}，当前 {current}，是否升级？",
    );
    expect(en["updateCheck.rowBody"]).toBe(
      "Version {latest} is now available (current: {current}). Upgrade now?",
    );
  });

  it("modal body points to the host check-for-updates page", () => {
    expect(zhCN["updateCheck.modalBody"]).toBe(
      "你随时可以在「设置/第三方插件」页面检查更新。",
    );
    expect(en["updateCheck.modalBody"]).toBe(
      "You can always check for updates in Settings → Community plugins.",
    );
  });
});

const DAY = 24 * 60 * 60 * 1000;

describe("version comparison", () => {
  it("accepts numeric dotted stable versions only", () => {
    expect(isStableVersion("1.4.7")).toBe(true);
    expect(isStableVersion("1.5")).toBe(true);
    expect(isStableVersion("1.4.8-beta")).toBe(false);
    expect(isStableVersion("")).toBe(false);
    expect(isStableVersion("latest")).toBe(false);
  });

  it("compares segment by segment, so 1.4.10 > 1.4.9", () => {
    expect(isNewerVersion("1.4.10", "1.4.9")).toBe(true);
    expect(isNewerVersion("1.4.9", "1.4.10")).toBe(false);
    expect(isNewerVersion("1.4.8", "1.4.8")).toBe(false);
    expect(isNewerVersion("1.5", "1.4.9")).toBe(true);
    expect(isNewerVersion("1.4.8", "1.4.8.1")).toBe(false);
  });

  it("rejects unstable candidates outright", () => {
    expect(isNewerVersion("1.4.8-beta", "1.4.7")).toBe(false);
    expect(isNewerVersion("1.4.8", "1.4.7-beta")).toBe(false);
  });
});

describe("pickLatestStableVersion", () => {
  it("returns null for empty or all-unstable lists", () => {
    expect(pickLatestStableVersion([])).toBeNull();
    expect(pickLatestStableVersion(["1.4.8-beta", "nightly"])).toBeNull();
  });

  it("picks the newest stable and ignores the rest", () => {
    expect(
      pickLatestStableVersion(["1.4.7", "1.4.9", "1.5.0-rc1", "1.4.10"]),
    ).toBe("1.4.10");
  });
});

describe("update check throttle", () => {
  it("is due when never checked", () => {
    expect(isUpdateCheckDue(null, 1000)).toBe(true);
    expect(isUpdateCheckDue(undefined, 1000)).toBe(true);
  });

  it("is not due within the interval and due after it", () => {
    const now = 10_000 * DAY;
    expect(isUpdateCheckDue(now - UPDATE_CHECK_INTERVAL_MS + 60_000, now)).toBe(
      false,
    );
    expect(isUpdateCheckDue(now - UPDATE_CHECK_INTERVAL_MS - 1, now)).toBe(true);
  });
});

describe("update reminder suppression", () => {
  const now = 10_000 * DAY;

  it("shows when there is no snooze record", () => {
    expect(isUpdateReminderSuppressed("1.4.8", null, now)).toBe(false);
  });

  it("snooze-for-days: hidden inside the window, visible after it", () => {
    const snooze = { version: "1.4.8", until: now + SNOOZE_DURATION_MS };
    expect(isUpdateReminderSuppressed("1.4.8", snooze, now + 1000)).toBe(true);
    expect(
      isUpdateReminderSuppressed("1.4.8", snooze, now + SNOOZE_DURATION_MS + 1),
    ).toBe(false);
  });

  it("snooze-for-days: a newer release reopens immediately", () => {
    const snooze = { version: "1.4.8", until: now + SNOOZE_DURATION_MS };
    expect(
      isUpdateReminderSuppressed("1.4.9", snooze, now + 1000),
    ).toBe(false);
  });

  it("skip-this-version: hidden until a newer release arrives", () => {
    const snooze = { version: "1.4.8", until: null };
    expect(isUpdateReminderSuppressed("1.4.8", snooze, now)).toBe(true);
    expect(isUpdateReminderSuppressed("1.5.0", snooze, now)).toBe(false);
  });

  it("treats a snooze for an older version as expired", () => {
    const snooze = { version: "1.4.6", until: now + SNOOZE_DURATION_MS };
    expect(isUpdateReminderSuppressed("1.4.8", snooze, now)).toBe(false);
  });
});

describe("fetchLatestStableVersion", () => {
  const ok = (text: string) =>
    Promise.resolve({ status: 200, text } as const);

  it("returns the newest stable version from the jsDelivr successor payload", async () => {
    const fetcher = vi.fn(() =>
      ok(
        JSON.stringify({
          versions: [{ version: "1.4.8-beta" }, { version: "1.4.7" }, { version: "1.4.8" }],
        }),
      ),
    );
    await expect(fetchLatestStableVersion(fetcher)).resolves.toBe("1.4.8");
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("/v1/packages/") }),
    );
  });

  it("filters entries without a version field out of the payload", async () => {
    const fetcher = vi.fn(() =>
      ok(JSON.stringify({ versions: [null, {}, { version: "1.4.8" }] })),
    );
    await expect(fetchLatestStableVersion(fetcher)).resolves.toBe("1.4.8");
  });

  it("returns null on non-2xx, malformed JSON and network failure", async () => {
    await expect(
      fetchLatestStableVersion(() => Promise.resolve({ status: 429, text: "" })),
    ).resolves.toBeNull();
    await expect(
      fetchLatestStableVersion(() => ok("not-json")),
    ).resolves.toBeNull();
    await expect(
      fetchLatestStableVersion(() => Promise.reject(new Error("offline"))),
    ).resolves.toBeNull();
  });
});

/** Issue #18 hardening: update bookkeeping lives in device-local storage,
 *  never in the synced plugin data file whose whole content is bound into the
 *  V2 migration input digest — a routine 24h write must not be able to kill
 *  an in-flight first-sync activation round. */
describe("update check device-local persistence", () => {
  function memoryStorage(): UpdateCheckStorage & { dump(): Map<string, string> } {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      dump: () => map,
    };
  }

  it("round-trips lastCheckAt, lastKnownLatest and snooze", () => {
    const storage = memoryStorage();
    saveUpdateCheckState(storage, {
      lastCheckAt: 1_000,
      lastKnownLatest: "1.4.9",
      snooze: { version: "1.4.9", until: 2_000 },
    });
    expect(loadUpdateCheckState(storage)).toEqual({
      lastCheckAt: 1_000,
      lastKnownLatest: "1.4.9",
      snooze: { version: "1.4.9", until: 2_000 },
    });
  });

  it("returns nulls for an empty storage", () => {
    expect(loadUpdateCheckState(memoryStorage())).toEqual({
      lastCheckAt: null,
      lastKnownLatest: null,
      snooze: null,
    });
  });

  it("degrades corrupted values to nulls instead of throwing", () => {
    const storage = memoryStorage();
    storage.setItem("easy-sync-update-last-check-at", "not-a-number");
    storage.setItem("easy-sync-update-last-known-latest", "");
    storage.setItem("easy-sync-update-reminder-snooze", "{not-json");
    expect(loadUpdateCheckState(storage)).toEqual({
      lastCheckAt: null,
      lastKnownLatest: null,
      snooze: null,
    });
  });

  it("rejects a snooze record without a version", () => {
    const storage = memoryStorage();
    storage.setItem(
      "easy-sync-update-reminder-snooze",
      JSON.stringify({ until: 123 }),
    );
    expect(loadUpdateCheckState(storage).snooze).toBeNull();
  });

  it("partial saves leave other fields untouched", () => {
    const storage = memoryStorage();
    saveUpdateCheckState(storage, { lastCheckAt: 5_000 });
    saveUpdateCheckState(storage, { lastKnownLatest: "1.5.0" });
    saveUpdateCheckState(storage, {
      snooze: { version: "1.5.0", until: null },
    });
    expect(loadUpdateCheckState(storage)).toEqual({
      lastCheckAt: 5_000,
      lastKnownLatest: "1.5.0",
      snooze: { version: "1.5.0", until: null },
    });
  });

  it("tolerates a missing storage object on load and save", () => {
    expect(loadUpdateCheckState(null)).toEqual({
      lastCheckAt: null,
      lastKnownLatest: null,
      snooze: null,
    });
    expect(() =>
      saveUpdateCheckState(null, { lastCheckAt: 1 }),
    ).not.toThrow();
  });

  it("seeds once from the retired 1.4.8 plugin-data keys without writing them", () => {
    expect(
      seedUpdateCheckStateFromLegacyPluginData({
        "update-last-check-at": 7_000,
        "update-last-known-latest": "1.4.8",
        "update-reminder-snooze": { version: "1.4.8", until: null },
      }),
    ).toEqual({
      lastCheckAt: 7_000,
      lastKnownLatest: "1.4.8",
      snooze: { version: "1.4.8", until: null },
    });
    expect(
      seedUpdateCheckStateFromLegacyPluginData({
        "update-last-check-at": "corrupt",
        "update-reminder-snooze": "not-a-record",
      }),
    ).toEqual({
      lastCheckAt: null,
      lastKnownLatest: null,
      snooze: null,
    });
    expect(seedUpdateCheckStateFromLegacyPluginData(null)).toEqual({
      lastCheckAt: null,
      lastKnownLatest: null,
      snooze: null,
    });
  });

  it("keeps the plugin data file free of update bookkeeping (structural guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const mainSource = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    expect(mainSource).not.toContain("update-last-check-at");
    expect(mainSource).not.toContain("update-last-known-latest");
    expect(mainSource).not.toContain("update-reminder-snooze");
    expect(mainSource).not.toContain("KEY_UPDATE_");
  });
});
