import type { SyncProgressState } from "../sync/sync-progress";
import {
  resolveSyncActivityPresentation,
  translateSyncActivity,
  trimSyncActivityLabel,
  type SyncStatusTranslator,
} from "./sync-status-presentation";

export type RibbonStatus =
  | "loggedOut"
  | "cancelling"
  | "syncing"
  | "attention"
  | "offline"
  | "success"
  | "ready";

/**
 * The statuses the ribbon itself can take. "offline" is deliberately absent:
 * the offline presentation belongs to the desktop status bar and the sidebar
 * status line (2026-08-29 拍板), which each pass their own label key. Keeping
 * it out of this type means the ribbon label lookup can never ask for the
 * `ribbon.offline` key, which is not part of the locale files.
 */
export type RibbonOwnStatus = Exclude<RibbonStatus, "offline">;

export interface RibbonStatusInput {
  loggedIn: boolean;
  cancelling: boolean;
  syncing: boolean;
  needsAttention: boolean;
  recentSuccess: boolean;
}

export const RIBBON_STATUS_ICONS: Record<RibbonStatus, string> = {
  loggedOut: "cloud-off",
  cancelling: "cloud-alert",
  syncing: "refresh-cw",
  attention: "cloud-alert",
  offline: "wifi-off",
  success: "cloud-check",
  ready: "cloud",
};

export function resolveRibbonStatus(input: RibbonStatusInput): RibbonOwnStatus {
  if (!input.loggedIn) return "loggedOut";
  if (input.cancelling) return "cancelling";
  if (input.syncing) return "syncing";
  if (input.needsAttention) return "attention";
  if (input.recentSuccess) return "success";
  return "ready";
}

export function resolveRibbonStatusLabel(
  status: RibbonOwnStatus,
  progress: Readonly<SyncProgressState>,
  t: SyncStatusTranslator,
): string {
  if (status !== "syncing") return t(`ribbon.${status}`);
  const activity = resolveSyncActivityPresentation(progress);
  const phase = trimSyncActivityLabel(translateSyncActivity(activity, t));
  return t("ribbon.syncingPhase", { phase });
}
