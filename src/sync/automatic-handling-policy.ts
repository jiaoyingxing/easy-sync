import { SyncActionType, type SyncPlanItem } from "./types";
import { isTextFile } from "./base-content-cache";
import { isObsidianManagedConfigPath } from "./file-decision-planner-v2";

/** User choices that authorize otherwise manual sync actions. */
export interface AutomaticHandlingPolicy {
  autoDeleteLocalFiles: boolean;
  mergeNonOverlappingText: boolean;
}

export const DEFAULT_AUTOMATIC_HANDLING_POLICY: Readonly<AutomaticHandlingPolicy> = {
  autoDeleteLocalFiles: false,
  mergeNonOverlappingText: true,
};

/**
 * Automatic line merges are limited to vault content. Files below Obsidian's
 * config directory can be host state, plugin data, or generated plugin code;
 * combining two such versions may preserve lines while still producing an
 * invalid application artifact. They remain syncable, but conflicts there
 * always require an explicit side choice.
 */
export function isAutomaticTextMergeCandidatePath(
  path: string,
  configDir: string,
): boolean {
  if (!isTextFile(path)) return false;
  const normalizedConfigDir = configDir.replace(/\/+$/, "");
  return normalizedConfigDir.length === 0
    || (path !== normalizedConfigDir && !path.startsWith(`${normalizedConfigDir}/`));
}

export function readAutomaticHandlingPolicy(
  value: unknown,
  legacyAutoMerge?: unknown,
): AutomaticHandlingPolicy {
  const candidate = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const mergeFallback = typeof legacyAutoMerge === "boolean"
    ? legacyAutoMerge
    : DEFAULT_AUTOMATIC_HANDLING_POLICY.mergeNonOverlappingText;
  return {
    autoDeleteLocalFiles: typeof candidate.autoDeleteLocalFiles === "boolean"
      ? candidate.autoDeleteLocalFiles
      : DEFAULT_AUTOMATIC_HANDLING_POLICY.autoDeleteLocalFiles,
    mergeNonOverlappingText: typeof candidate.mergeNonOverlappingText === "boolean"
      ? candidate.mergeNonOverlappingText
      : mergeFallback,
  };
}

/**
 * Project manual delete confirmations into executable actions for this run.
 *
 * `preserveDeleteConfirmation` lets a caller keep the confirmation row for
 * specific paths even when the policy would auto-delete them: one-way mode
 * passes its excluded-block predicate (config / plugins / own bundle) so those
 * paths keep their two-way delete裁决 instead of being followed silently
 * (2026-10-12 review). Two-way callers pass nothing and keep today's output.
 */
export function applyAutomaticHandlingPolicy(
  items: SyncPlanItem[],
  policy: Readonly<AutomaticHandlingPolicy>,
  configDir: string,
  preserveDeleteConfirmation?: (path: string) => boolean,
): SyncPlanItem[] {
  if (!policy.autoDeleteLocalFiles) return items;
  return items.map((item) => item.type === SyncActionType.ConfirmLocalDelete
    && !isObsidianManagedConfigPath(item.path, configDir)
    && !preserveDeleteConfirmation?.(item.path)
    ? { ...item, type: SyncActionType.DeleteLocal }
    : item);
}
