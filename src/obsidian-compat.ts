import type { Vault } from "obsidian";

export const DEFAULT_CONFIG_DIR = `.${"obsidian"}`;

export type TimeoutHandle = number | ReturnType<typeof globalThis.setTimeout>;
export type IntervalHandle = number | ReturnType<typeof globalThis.setInterval>;
export type AnimationFrameHandle = number | TimeoutHandle;

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
    logsDir: `${pluginDir}/logs`,
    tmpDir: `${pluginDir}/tmp`,
    scanCacheFile: `${pluginDir}/scan-cache.json`,
    manifestFile: `${pluginDir}/manifest.json`,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

export function compatSetTimeout(
  handler: TimerHandler,
  timeout?: number,
): TimeoutHandle {
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    return window.setTimeout(handler, timeout);
  }
  return globalThis.setTimeout(handler, timeout);
}

export function compatClearTimeout(handle: TimeoutHandle | null | undefined): void {
  if (handle == null) return;
  if (typeof window !== "undefined" && typeof window.clearTimeout === "function") {
    window.clearTimeout(handle as unknown as number);
    return;
  }
  globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
}

export function compatSetInterval(
  handler: TimerHandler,
  timeout?: number,
): IntervalHandle {
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    return window.setInterval(handler, timeout);
  }
  return globalThis.setInterval(handler, timeout);
}

export function compatClearInterval(handle: IntervalHandle | null | undefined): void {
  if (handle == null) return;
  if (typeof window !== "undefined" && typeof window.clearInterval === "function") {
    window.clearInterval(handle as unknown as number);
    return;
  }
  globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
}

export function compatRequestAnimationFrame(
  callback: FrameRequestCallback,
): AnimationFrameHandle {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(Date.now()), 16);
}

export function compatCancelAnimationFrame(handle: AnimationFrameHandle | null | undefined): void {
  if (handle == null) return;
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle as number);
    return;
  }
  globalThis.clearTimeout(handle as TimeoutHandle);
}
