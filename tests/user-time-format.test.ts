/**
 * User-visible time formatting: Chinese six-period labels plus the 12-hour
 * clock, with AM/PM kept for the English UI.
 *
 * Boundary cases pin the CLDR-derived split (00-04:59 凌晨, 05-07:59 早上,
 * 08-11:59 上午, 12 中午, 13-18:59 下午, 19-23:59 晚上) and the red case from
 * the report: 23:30 must read 晚上11:30, never 下午11:30.
 */
import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import {
  formatUserClockTime,
  formatUserDateTime,
  formatUserDateTimeFull,
} from "../src/ui/user-time-format";

const zh = new I18n("zh-cn");
const en = new I18n("en");

function localAt(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 10, 23, hour, minute, second).getTime();
}

describe("formatUserClockTime", () => {
  it.each([
    [0, 0, "凌晨12:00"],
    [4, 59, "凌晨4:59"],
    [5, 0, "早上5:00"],
    [7, 59, "早上7:59"],
    [8, 0, "上午8:00"],
    [11, 59, "上午11:59"],
    [12, 0, "中午12:00"],
    [12, 59, "中午12:59"],
    [13, 0, "下午1:00"],
    [18, 59, "下午6:59"],
    [19, 0, "晚上7:00"],
    [23, 30, "晚上11:30"],
    [23, 59, "晚上11:59"],
  ])("maps %i:%i to %s", (hour, minute, expected) => {
    expect(formatUserClockTime(localAt(hour, minute), zh.language)).toBe(expected);
  });

  it("uses AM/PM for the English UI without leaking Chinese day words", () => {
    expect(formatUserClockTime(localAt(23, 30), en.language)).toBe("11:30 PM");
    expect(formatUserClockTime(localAt(0, 30), en.language)).toBe("12:30 AM");
  });

  it("adds seconds only when asked", () => {
    expect(formatUserClockTime(localAt(23, 30, 5), zh.language, { seconds: true }))
      .toBe("晚上11:30:05");
    expect(formatUserClockTime(localAt(23, 30, 5), zh.language))
      .toBe("晚上11:30");
  });

  it("returns an empty string for a non-finite timestamp", () => {
    expect(formatUserClockTime(Number.NaN, zh.language)).toBe("");
    expect(formatUserClockTime(Number.POSITIVE_INFINITY, zh.language)).toBe("");
  });

  it("keeps the 12-hour clock when the host ignores Intl time options", () => {
    // Mobile WebViews have been seen to ignore hourCycle/dayPeriod and fall
    // back to a 24-hour string. The formatter must assemble the clock itself,
    // so deleting those options from every Intl formatter changes nothing.
    const original = Intl.DateTimeFormat;
    class FakeDateTimeFormat extends original {
      constructor(
        locales?: string | string[],
        options?: Intl.DateTimeFormatOptions,
      ) {
        const safe = { ...(options ?? {}) };
        delete safe.hour;
        delete safe.minute;
        delete safe.second;
        delete safe.hourCycle;
        delete safe.dayPeriod;
        super(locales, safe);
      }
    }
    (Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat })
      .DateTimeFormat = FakeDateTimeFormat;
    try {
      expect(formatUserClockTime(localAt(23, 30), zh.language))
        .toBe("晚上11:30");
      expect(formatUserDateTime(localAt(23, 30), zh.language))
        .toBe("11/23 晚上11:30");
    } finally {
      (Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat })
        .DateTimeFormat = original;
    }
  });
});

describe("formatUserDateTime", () => {
  it("renders the reported 23:30 case as 晚上11:30", () => {
    expect(formatUserDateTime(localAt(23, 30), zh.language))
      .toBe("11/23 晚上11:30");
    expect(formatUserDateTime(localAt(23, 30), zh.language)).not.toContain("下午");
  });

  it("keeps English AM/PM and the English date skeleton", () => {
    expect(formatUserDateTime(localAt(23, 30), en.language))
      .toBe("11/23, 11:30 PM");
  });
});

describe("formatUserDateTimeFull", () => {
  it("renders year, seconds and the Chinese period", () => {
    expect(formatUserDateTimeFull(localAt(23, 30, 5), zh.language))
      .toBe("2026/11/23 晚上11:30:05");
  });

  it("renders the English full timestamp", () => {
    expect(formatUserDateTimeFull(localAt(23, 30, 5), en.language))
      .toBe("11/23/2026, 11:30:05 PM");
  });
});
