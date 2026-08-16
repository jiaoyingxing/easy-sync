import "obsidian";
import type { Vault } from "obsidian";

export const DEFAULT_CONFIG_DIR = `.${"obsidian"}`;

/**
 * Version of the local EasySync path contract. This is deliberately separate
 * from V2 generation, remote scope and the IndexedDB authority revision.
 */
export const EASY_SYNC_STORAGE_LAYOUT_VERSION = 2 as const;
export const EASY_SYNC_LEGACY_STORAGE_LAYOUT_VERSION = 1 as const;

const EASY_SYNC_STORAGE_ROOT = {
  dataFile: "data.json",
  manifestFile: "manifest.json",
  selfSyncMainFile: "main.js",
  selfSyncStylesFile: "styles.css",
} as const;

const EASY_SYNC_STORAGE_LAYOUT = {
  version: EASY_SYNC_STORAGE_LAYOUT_VERSION,
  root: EASY_SYNC_STORAGE_ROOT,
  sidecars: {
    remoteStateFile: "state/legacy/remote-state.json",
    stateV2File: "state/v2/state-v2.json",
    stateV2NextFile: "state/v2/state-v2.next.json",
    stateV2PreviousFile: "state/v2/state-v2.previous.json",
    stateV2RecoveryFile: "state/v2/state-v2.recovery.json",
    stateV2ManifestFile: "state/v2/state-v2.manifest.json",
    stateV2ManifestNextFile: "state/v2/state-v2.manifest.next.json",
    stateV2AuthorityWitnessFile: "state/v2/state-v2.authority.json",
    stateV2AuthorityWitnessNextFile: "state/v2/state-v2.authority.next.json",
    stateV2IndexedDbRecoveryDir: "state/v2/indexeddb-recovery",
    stateV2RetiredManifestFile: "state/v2/state-v2.manifest.retired.json",
    stateV2RollbackFile: "state/v2/state-v2.rollback.json",
    stateV2ReactivationArchivePrefix: "state/v2/state-v2.reactivation-archive-",
    stateV2MigrationHoldFile: "state/v2/state-v2.migration-hold.json",
    stateV2MigrationHoldNextFile: "state/v2/state-v2.migration-hold.next.json",
    stateV2ScopeTransitionFile: "state/v2/state-v2.scope-transition.json",
    stateV2ScopeTransitionNextFile: "state/v2/state-v2.scope-transition.next.json",
    stateV2CorruptSourcePrefix: "state/v2/state-v2.corrupt-source-",
    stateV2CorruptRecoveryFile: "state/v2/state-v2.corrupt-recovery.json",
    stateV2CorruptRecoveryNextFile: "state/v2/state-v2.corrupt-recovery.next.json",
    stateV2CorruptPublicationFile: "state/v2/state-v2.corrupt-publication.json",
    stateV2CorruptPublicationNextFile: "state/v2/state-v2.corrupt-publication.next.json",
    stateV1BackupFile: "state/legacy/state-v1.backup.json",
    baseContentFile: "state/legacy/base-content.json",
    ancestorsV2Dir: "objects/ancestors-v2",
    ancestorManifestV2File: "objects/ancestor-manifest-v2.json",
    ancestorManifestV2NextFile: "objects/ancestor-manifest-v2.next.json",
    logsDir: "logs",
    tmpDir: "runtime",
    scanCacheFile: "runtime/cache/scan-cache.json",
  },
} as const;

const EASY_SYNC_LEGACY_STORAGE_LAYOUT = {
  version: EASY_SYNC_LEGACY_STORAGE_LAYOUT_VERSION,
  root: EASY_SYNC_STORAGE_ROOT,
  sidecars: {
    remoteStateFile: "remote-state.json",
    stateV2File: "state-v2.json",
    stateV2NextFile: "state-v2.next.json",
    stateV2PreviousFile: "state-v2.previous.json",
    stateV2RecoveryFile: "state-v2.recovery.json",
    stateV2ManifestFile: "state-v2.manifest.json",
    stateV2ManifestNextFile: "state-v2.manifest.next.json",
    stateV2AuthorityWitnessFile: "state-v2.authority.json",
    stateV2AuthorityWitnessNextFile: "state-v2.authority.next.json",
    stateV2IndexedDbRecoveryDir: "state-v2-indexeddb-recovery",
    stateV2RetiredManifestFile: "state-v2.manifest.retired.json",
    stateV2RollbackFile: "state-v2.rollback.json",
    stateV2ReactivationArchivePrefix: "state-v2.reactivation-archive-",
    stateV2MigrationHoldFile: "state-v2.migration-hold.json",
    stateV2MigrationHoldNextFile: "state-v2.migration-hold.next.json",
    stateV2ScopeTransitionFile: "state-v2.scope-transition.json",
    stateV2ScopeTransitionNextFile: "state-v2.scope-transition.next.json",
    stateV2CorruptSourcePrefix: "state-v2.corrupt-source-",
    stateV2CorruptRecoveryFile: "state-v2.corrupt-recovery.json",
    stateV2CorruptRecoveryNextFile: "state-v2.corrupt-recovery.next.json",
    stateV2CorruptPublicationFile: "state-v2.corrupt-publication.json",
    stateV2CorruptPublicationNextFile: "state-v2.corrupt-publication.next.json",
    stateV1BackupFile: "state-v1.backup.json",
    baseContentFile: "base-content.json",
    ancestorsV2Dir: "ancestors-v2",
    ancestorManifestV2File: "ancestor-manifest-v2.json",
    ancestorManifestV2NextFile: "ancestor-manifest-v2.next.json",
    logsDir: "logs",
    tmpDir: "tmp",
    scanCacheFile: "scan-cache.json",
  },
} as const;

export type TimeoutHandle = number;
export type IntervalHandle = number;
export type AnimationFrameHandle = number;

type TimerWindow = Pick<Window, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;
type AnimationWindow = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;
const fallbackWindow = typeof window !== "undefined" ? window : null;

export function getConfigDir(vault: Pick<Vault, "configDir">): string {
  return vault.configDir || DEFAULT_CONFIG_DIR;
}

/**
 * Cross-device path identity used by EasySync and OneDrive. Display casing is
 * preserved elsewhere, but identity follows OneDrive's case-insensitive NFC
 * namespace so a path cannot bypass protection on Windows or macOS and then
 * collide when another device syncs it.
 */
export function normalizeVaultPathKey(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC").toLocaleLowerCase();
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

export interface EasySyncPathSet {
  configDir: string;
  pluginRoot: string;
  pluginDir: string;
  pluginDirPrefix: string;
  storageLayoutVersion: number;
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
}

function buildEasySyncPaths(
  vaultOrConfigDir: Pick<Vault, "configDir"> | string,
  pluginId: string,
  layout: typeof EASY_SYNC_STORAGE_LAYOUT | typeof EASY_SYNC_LEGACY_STORAGE_LAYOUT,
): EasySyncPathSet {
  const configDir = typeof vaultOrConfigDir === "string"
    ? vaultOrConfigDir
    : getConfigDir(vaultOrConfigDir);
  const pluginRoot = `${configDir}/plugins/`;
  const pluginDir = `${pluginRoot}${pluginId}`;
  const path = (relativePath: string): string => `${pluginDir}/${relativePath}`;
  const sidecars = layout.sidecars;
  return {
    configDir,
    pluginRoot,
    pluginDir,
    pluginDirPrefix: `${pluginDir}/`,
    storageLayoutVersion: layout.version,
    dataFile: path(layout.root.dataFile),
    remoteStateFile: path(sidecars.remoteStateFile),
    stateV2File: path(sidecars.stateV2File),
    stateV2NextFile: path(sidecars.stateV2NextFile),
    stateV2PreviousFile: path(sidecars.stateV2PreviousFile),
    stateV2RecoveryFile: path(sidecars.stateV2RecoveryFile),
    stateV2ManifestFile: path(sidecars.stateV2ManifestFile),
    stateV2ManifestNextFile: path(sidecars.stateV2ManifestNextFile),
    stateV2AuthorityWitnessFile: path(sidecars.stateV2AuthorityWitnessFile),
    stateV2AuthorityWitnessNextFile: path(sidecars.stateV2AuthorityWitnessNextFile),
    stateV2IndexedDbRecoveryDir: path(sidecars.stateV2IndexedDbRecoveryDir),
    stateV2RetiredManifestFile: path(sidecars.stateV2RetiredManifestFile),
    stateV2RollbackFile: path(sidecars.stateV2RollbackFile),
    stateV2ReactivationArchivePrefix: path(sidecars.stateV2ReactivationArchivePrefix),
    stateV2MigrationHoldFile: path(sidecars.stateV2MigrationHoldFile),
    stateV2MigrationHoldNextFile: path(sidecars.stateV2MigrationHoldNextFile),
    stateV2ScopeTransitionFile: path(sidecars.stateV2ScopeTransitionFile),
    stateV2ScopeTransitionNextFile: path(sidecars.stateV2ScopeTransitionNextFile),
    stateV2CorruptSourcePrefix: path(sidecars.stateV2CorruptSourcePrefix),
    stateV2CorruptRecoveryFile: path(sidecars.stateV2CorruptRecoveryFile),
    stateV2CorruptRecoveryNextFile: path(sidecars.stateV2CorruptRecoveryNextFile),
    stateV2CorruptPublicationFile: path(sidecars.stateV2CorruptPublicationFile),
    stateV2CorruptPublicationNextFile: path(sidecars.stateV2CorruptPublicationNextFile),
    stateV1BackupFile: path(sidecars.stateV1BackupFile),
    baseContentFile: path(sidecars.baseContentFile),
    ancestorsV2Dir: path(sidecars.ancestorsV2Dir),
    ancestorManifestV2File: path(sidecars.ancestorManifestV2File),
    ancestorManifestV2NextFile: path(sidecars.ancestorManifestV2NextFile),
    logsDir: path(sidecars.logsDir),
    tmpDir: path(sidecars.tmpDir),
    scanCacheFile: path(sidecars.scanCacheFile),
    manifestFile: path(layout.root.manifestFile),
  };
}

export function getEasySyncPaths(
  vaultOrConfigDir: Pick<Vault, "configDir"> | string,
  pluginId = "easy-sync",
): EasySyncPathSet {
  return buildEasySyncPaths(vaultOrConfigDir, pluginId, EASY_SYNC_STORAGE_LAYOUT);
}

/** Paths emitted by public 1.1.3 / v1 builds, used only during local migration. */
export function getEasySyncLegacyPaths(
  vaultOrConfigDir: Pick<Vault, "configDir"> | string,
  pluginId = "easy-sync",
): EasySyncPathSet {
  return buildEasySyncPaths(
    vaultOrConfigDir,
    pluginId,
    EASY_SYNC_LEGACY_STORAGE_LAYOUT,
  );
}

const EASY_SYNC_SELF_SYNC_FILE_NAMES: ReadonlySet<string> = new Set([
  EASY_SYNC_STORAGE_LAYOUT.root.selfSyncMainFile,
  EASY_SYNC_STORAGE_LAYOUT.root.manifestFile,
  EASY_SYNC_STORAGE_LAYOUT.root.selfSyncStylesFile,
]);

/** Exact EasySync bundle files owned by the self-sync feature. */
export function isEasySyncSelfSyncFilePath(
  path: string,
  configDir = DEFAULT_CONFIG_DIR,
  pluginId = "easy-sync",
): boolean {
  const prefix = normalizeVaultPathKey(
    getEasySyncPaths(configDir, pluginId).pluginDirPrefix,
  );
  const normalizedPath = normalizeVaultPathKey(path);
  if (!normalizedPath.startsWith(prefix)) return false;
  const relativePath = normalizedPath.slice(prefix.length);
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
