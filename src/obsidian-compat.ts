import "obsidian";
import type { Vault } from "obsidian";

export const DEFAULT_CONFIG_DIR = `.${"obsidian"}`;

export type TimeoutHandle = number;
export type IntervalHandle = number;
export type AnimationFrameHandle = number;

type TimerWindow = Pick<Window, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;
type AnimationWindow = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;
const fallbackWindow = typeof window !== "undefined" ? window : null;

export function getConfigDir(vault: Pick<Vault, "configDir">): string {
  return vault.configDir || DEFAULT_CONFIG_DIR;
}

export function getPluginDir(
  vaultOrConfigDir: Pick<Vault, "configDir"> | string,
  pluginId: string,
): string {
  const configDir = typeof vaultOrConfigDir === "string"
    ? vaultOrConfigDir
    : getConfigDir(vaultOrConfigDir);
  return `${configDir}/plugins/${pluginId}`;
}

export function getEasySyncPaths(
  vaultOrConfigDir: Pick<Vault, "configDir"> | string,
  pluginId = "easy-sync",
): {
  configDir: string;
  pluginRoot: string;
  pluginDir: string;
  pluginDirPrefix: string;
  dataFile: string;
  remoteStateFile: string;
  stateV2File: string;
  stateV2NextFile: string;
  stateV2PreviousFile: string;
  stateV2RecoveryFile: string;
  stateV2ManifestFile: string;
  stateV2ManifestNextFile: string;
  stateV2AuthorityWitnessFile: string;
  stateV2AuthorityWitnessNextFile: string;
  stateV2IndexedDbRecoveryDir: string;
  stateV2RetiredManifestFile: string;
  stateV2RollbackFile: string;
  stateV2ReactivationArchivePrefix: string;
  stateV2MigrationHoldFile: string;
  stateV2MigrationHoldNextFile: string;
  stateV2ScopeTransitionFile: string;
  stateV2ScopeTransitionNextFile: string;
  stateV2CorruptSourcePrefix: string;
  stateV2CorruptRecoveryFile: string;
  stateV2CorruptRecoveryNextFile: string;
  stateV2CorruptPublicationFile: string;
  stateV2CorruptPublicationNextFile: string;
  stateV1BackupFile: string;
  baseContentFile: string;
  ancestorsV2Dir: string;
  ancestorManifestV2File: string;
  ancestorManifestV2NextFile: string;
  logsDir: string;
  tmpDir: string;
  scanCacheFile: string;
  manifestFile: string;
} {
  const configDir = typeof vaultOrConfigDir === "string"
    ? vaultOrConfigDir
    : getConfigDir(vaultOrConfigDir);
  const pluginRoot = `${configDir}/plugins/`;
  const pluginDir = `${pluginRoot}${pluginId}`;
  return {
    configDir,
    pluginRoot,
    pluginDir,
    pluginDirPrefix: `${pluginDir}/`,
    dataFile: `${pluginDir}/data.json`,
    remoteStateFile: `${pluginDir}/remote-state.json`,
    stateV2File: `${pluginDir}/state-v2.json`,
    stateV2NextFile: `${pluginDir}/state-v2.next.json`,
    stateV2PreviousFile: `${pluginDir}/state-v2.previous.json`,
    stateV2RecoveryFile: `${pluginDir}/state-v2.recovery.json`,
    stateV2ManifestFile: `${pluginDir}/state-v2.manifest.json`,
    stateV2ManifestNextFile: `${pluginDir}/state-v2.manifest.next.json`,
    stateV2AuthorityWitnessFile: `${pluginDir}/state-v2.authority.json`,
    stateV2AuthorityWitnessNextFile: `${pluginDir}/state-v2.authority.next.json`,
    stateV2IndexedDbRecoveryDir:
      `${pluginDir}/state-v2-indexeddb-recovery`,
    stateV2RetiredManifestFile: `${pluginDir}/state-v2.manifest.retired.json`,
    stateV2RollbackFile: `${pluginDir}/state-v2.rollback.json`,
    stateV2ReactivationArchivePrefix: `${pluginDir}/state-v2.reactivation-archive-`,
    stateV2MigrationHoldFile: `${pluginDir}/state-v2.migration-hold.json`,
    stateV2MigrationHoldNextFile: `${pluginDir}/state-v2.migration-hold.next.json`,
    stateV2ScopeTransitionFile: `${pluginDir}/state-v2.scope-transition.json`,
    stateV2ScopeTransitionNextFile: `${pluginDir}/state-v2.scope-transition.next.json`,
    stateV2CorruptSourcePrefix: `${pluginDir}/state-v2.corrupt-source-`,
    stateV2CorruptRecoveryFile: `${pluginDir}/state-v2.corrupt-recovery.json`,
    stateV2CorruptRecoveryNextFile: `${pluginDir}/state-v2.corrupt-recovery.next.json`,
    stateV2CorruptPublicationFile: `${pluginDir}/state-v2.corrupt-publication.json`,
    stateV2CorruptPublicationNextFile: `${pluginDir}/state-v2.corrupt-publication.next.json`,
    stateV1BackupFile: `${pluginDir}/state-v1.backup.json`,
    baseContentFile: `${pluginDir}/base-content.json`,
    ancestorsV2Dir: `${pluginDir}/ancestors-v2`,
    ancestorManifestV2File: `${pluginDir}/ancestor-manifest-v2.json`,
    ancestorManifestV2NextFile: `${pluginDir}/ancestor-manifest-v2.next.json`,
    logsDir: `${pluginDir}/logs`,
    tmpDir: `${pluginDir}/tmp`,
    scanCacheFile: `${pluginDir}/scan-cache.json`,
    manifestFile: `${pluginDir}/manifest.json`,
  };
}

const EASY_SYNC_SELF_SYNC_FILE_NAMES = new Set([
  "main.js",
  "manifest.json",
  "styles.css",
]);

/** Exact EasySync bundle files owned by the self-sync feature. */
export function isEasySyncSelfSyncFilePath(
  path: string,
  configDir = DEFAULT_CONFIG_DIR,
  pluginId = "easy-sync",
): boolean {
  const prefix = getEasySyncPaths(configDir, pluginId).pluginDirPrefix;
  if (!path.startsWith(prefix)) return false;
  const relativePath = path.slice(prefix.length);
  return !relativePath.includes("/")
    && EASY_SYNC_SELF_SYNC_FILE_NAMES.has(relativePath);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function getCurrentWindow(): Window | null {
  return typeof window !== "undefined" ? (window.activeWindow ?? window) : null;
}

function hasTimerMethods(value: unknown): value is TimerWindow {
  return typeof value === "object"
    && value !== null
    && typeof (value as TimerWindow).setTimeout === "function"
    && typeof (value as TimerWindow).clearTimeout === "function"
    && typeof (value as TimerWindow).setInterval === "function"
    && typeof (value as TimerWindow).clearInterval === "function";
}

function hasAnimationMethods(value: unknown): value is AnimationWindow {
  return typeof value === "object"
    && value !== null
    && typeof (value as AnimationWindow).requestAnimationFrame === "function"
    && typeof (value as AnimationWindow).cancelAnimationFrame === "function";
}

function getTimerWindow(): TimerWindow {
  const currentWindow = getCurrentWindow();
  if (hasTimerMethods(currentWindow)) return currentWindow;
  if (hasTimerMethods(fallbackWindow)) return fallbackWindow;
  throw new Error("Timer APIs unavailable");
}

function getAnimationWindow(): AnimationWindow | null {
  const currentWindow = getCurrentWindow();
  if (hasAnimationMethods(currentWindow)) return currentWindow;
  return hasAnimationMethods(fallbackWindow) ? fallbackWindow : null;
}

export function compatSetTimeout(
  handler: () => unknown,
  timeout?: number,
): TimeoutHandle {
  return getTimerWindow().setTimeout(handler, timeout);
}

export function compatClearTimeout(handle: TimeoutHandle | null | undefined): void {
  if (handle == null) return;
  getTimerWindow().clearTimeout(handle);
}

export function compatSetInterval(
  handler: () => unknown,
  timeout?: number,
): IntervalHandle {
  return getTimerWindow().setInterval(handler, timeout);
}

export function compatClearInterval(handle: IntervalHandle | null | undefined): void {
  if (handle == null) return;
  getTimerWindow().clearInterval(handle);
}

export function compatRequestAnimationFrame(
  callback: FrameRequestCallback,
): AnimationFrameHandle {
  const compatWindow = getAnimationWindow();
  if (compatWindow) {
    return compatWindow.requestAnimationFrame(callback);
  }
  return getTimerWindow().setTimeout(() => callback(Date.now()), 16);
}

export function compatCancelAnimationFrame(handle: AnimationFrameHandle | null | undefined): void {
  if (handle == null) return;
  const compatWindow = getAnimationWindow();
  if (compatWindow) {
    compatWindow.cancelAnimationFrame(handle);
    return;
  }
  getTimerWindow().clearTimeout(handle);
}
