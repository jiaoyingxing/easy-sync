/**
 * LAN acceleration settings (S4, experimental).
 *
 * The switch only changes where downloaded bytes come from; it never changes
 * when a sync runs or which sync mode is active. Values are persisted in the
 * existing `data.json`; an unknown or malformed threshold falls back to the
 * product default instead of clamping silently, so a hand-edited file cannot
 * turn the feature on with an unintended size.
 */

/** Selectable trigger sizes in MiB. 0 means every file. */
export const LAN_ACCELERATION_THRESHOLD_OPTIONS_MB = [
  0, 1, 8, 32, 64, 128, 256,
] as const;

export const DEFAULT_LAN_ACCELERATION_THRESHOLD_MB = 8;

/**
 * Product default for the experimental switch.
 *
 * 2026-11-24 user decision: default on. A saved explicit `false` still wins
 * (a device that turned it off stays off); only a missing key falls back to
 * this value. See `EasySyncPlugin.loadSyncSettings`.
 */
export const DEFAULT_LAN_ACCELERATION_ENABLED = true;

export function normalizeLanAccelerationThresholdMb(value: unknown): number {
  return typeof value === "number"
    && LAN_ACCELERATION_THRESHOLD_OPTIONS_MB.includes(
      value as (typeof LAN_ACCELERATION_THRESHOLD_OPTIONS_MB)[number],
    )
    ? value
    : DEFAULT_LAN_ACCELERATION_THRESHOLD_MB;
}

/** Convert the persisted MiB value to the byte threshold used by downloads. */
export function lanAccelerationThresholdBytes(thresholdMb: number): number {
  return normalizeLanAccelerationThresholdMb(thresholdMb) * 1024 * 1024;
}
