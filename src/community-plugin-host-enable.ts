import type { App } from "obsidian";

/**
 * No-restart enablement for explicitly downloaded community plugins
 * (slice 3, decision §2.3/§8.3).
 *
 * Obsidian does not declare `PluginManager#loadManifests` /
 * `enablePluginAndSave` in its public type surface, so the API is probed
 * structurally before every use. The verified open-plug chain is:
 * `loadManifests()` (register freshly written manifests) followed by
 * `enablePluginAndSave(pluginId)` (create the instance, run its onload and
 * persist the enablement). Every absence or throw degrades to a fallback
 * ("restart and enable manually") and must never fail the sync round.
 *
 * Scope discipline: this module is only ever invoked for the explicit
 * downloads of one settled round (`completedRestores.files` in
 * dispatchSyncRun). Background automatic updates never enter that set, so
 * they can never flip an enablement state here.
 */
export type CommunityPluginHostEnableOutcome =
  | { kind: "enabled" }
  | { kind: "fallback"; reason: string };

interface HostEnableApi {
  loadManifests(): Promise<void> | void;
  enablePluginAndSave(pluginId: string): Promise<void> | void;
}

export function readCommunityPluginHostEnableApi(
  app: Readonly<App>,
): HostEnableApi | null {
  const plugins = (app as unknown as { plugins?: HostEnableApi }).plugins;
  return plugins
    && typeof plugins.loadManifests === "function"
    && typeof plugins.enablePluginAndSave === "function"
    ? plugins
    : null;
}

export async function tryEnableDownloadedCommunityPlugin(
  app: Readonly<App>,
  pluginId: string,
): Promise<CommunityPluginHostEnableOutcome> {
  const api = readCommunityPluginHostEnableApi(app);
  if (!api) {
    return { kind: "fallback", reason: "host-api-unavailable" };
  }
  try {
    await api.loadManifests();
    await api.enablePluginAndSave(pluginId);
    return { kind: "enabled" };
  } catch (error) {
    return {
      kind: "fallback",
      reason: error instanceof Error
        ? error.message
        : String(error),
    };
  }
}
