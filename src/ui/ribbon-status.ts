export type RibbonStatus =
  | "loggedOut"
  | "cancelling"
  | "syncing"
  | "attention"
  | "success"
  | "ready";

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
  success: "cloud-check",
  ready: "cloud",
};

export function resolveRibbonStatus(input: RibbonStatusInput): RibbonStatus {
  if (!input.loggedIn) return "loggedOut";
  if (input.cancelling) return "cancelling";
  if (input.syncing) return "syncing";
  if (input.needsAttention) return "attention";
  if (input.recentSuccess) return "success";
  return "ready";
}
