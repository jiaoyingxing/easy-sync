import { describe, expect, it, vi } from "vitest";
import {
  fetchLatestStableVersion,
  isStableVersion,
  isNewerVersion,
  isUpdateCheckDue,
  isUpdateReminderSuppressed,
  pickLatestStableVersion,
  SNOOZE_DURATION_MS,
  UPDATE_CHECK_INTERVAL_MS,
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

  it("returns the newest stable version from jsDelivr payload", async () => {
    const fetcher = vi.fn(() =>
      ok(JSON.stringify({ versions: ["1.4.8-beta", "1.4.7", "1.4.8"] })),
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
