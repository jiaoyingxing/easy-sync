/**
 * User-visible timestamp formatting shared by every EasySync surface.
 *
 * The plugin renders a 12-hour clock with Chinese day periods. The coarse
 * CLDR 12-hour markers ("上午"/"下午") make 23:30 read as "下午11:30" and cannot
 * distinguish morning, forenoon, noon and evening. The six periods below use
 * Unicode CLDR's Chinese boundaries; 05:00-07:59 is labelled 早上 (CLDR zh-CN
 * says 清晨, while zh-HK and the product wording use 早上).
 *
 * The 12-hour clock is assembled locally instead of asking Intl for
 * `hourCycle: "h12"`/`dayPeriod: "long"`: some mobile WebViews ignore those
 * options and fall back to a 24-hour string with no day period. Intl is used
 * only for the date skeleton (date order/separators), which every host
 * supports. Formatting follows the plugin UI language, not the host locale: a
 * Chinese UI must not inherit a host's coarse 上午/下午, and an English UI must
 * not inherit Chinese day words.
 */
import type { I18n } from "../i18n";

/** UI language keys that have their own day-period rendering. */
export type UserTimeLanguage = I18n["language"];

type DayPeriod =
  | "lateNight"
  | "morning"
  | "forenoon"
  | "noon"
  | "afternoon"
  | "evening";

const ZH_PERIOD_LABELS: Readonly<Record<DayPeriod, string>> = {
  lateNight: "凌晨",
  morning: "早上",
  forenoon: "上午",
  noon: "中午",
  afternoon: "下午",
  evening: "晚上",
};

/** Local wall-clock hour → the Chinese period shown before the time. */
function resolveDayPeriod(hour: number): DayPeriod {
  if (hour < 5) return "lateNight";
  if (hour < 8) return "morning";
  if (hour < 12) return "forenoon";
  if (hour < 13) return "noon";
  if (hour < 19) return "afternoon";
  return "evening";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

interface TimeParts {
  /** Include the locale date (month/day, optional year). */
  date: boolean;
  year?: boolean;
  seconds?: boolean;
}

function formatWithOptions(
  timestamp: number,
  language: UserTimeLanguage,
  parts: TimeParts,
): string {
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const hour = date.getHours();
  const hour12 = hour % 12 || 12;
  const minute = pad2(date.getMinutes());
  const second = parts.seconds ? `:${pad2(date.getSeconds())}` : "";
  const timeText = language === "zh-cn"
    ? `${ZH_PERIOD_LABELS[resolveDayPeriod(hour)]}${hour12}:${minute}${second}`
    : `${hour12}:${minute}${second} ${hour < 12 ? "AM" : "PM"}`;
  if (!parts.date) return timeText;

  const dateOptions: Intl.DateTimeFormatOptions = {
    month: "numeric",
    day: "numeric",
  };
  if (parts.year) dateOptions.year = "numeric";
  const dateText = new Intl.DateTimeFormat(
    language === "zh-cn" ? "zh-CN" : "en",
    dateOptions,
  ).format(date);
  return language === "zh-cn"
    ? `${dateText} ${timeText}`
    : `${dateText}, ${timeText}`;
}

/** Month/day + 12-hour clock at minute precision (sidebar timestamps). */
export function formatUserDateTime(
  timestamp: number,
  language: UserTimeLanguage,
): string {
  return formatWithOptions(timestamp, language, { date: true });
}

/** Year/month/day + 12-hour clock with seconds (detail timestamps). */
export function formatUserDateTimeFull(
  timestamp: number,
  language: UserTimeLanguage,
): string {
  return formatWithOptions(timestamp, language, {
    date: true,
    year: true,
    seconds: true,
  });
}

/** Time-only 12-hour clock; seconds only where the surface needs them. */
export function formatUserClockTime(
  timestamp: number,
  language: UserTimeLanguage,
  options: { seconds?: boolean } = {},
): string {
  return formatWithOptions(timestamp, language, {
    date: false,
    seconds: options.seconds,
  });
}
