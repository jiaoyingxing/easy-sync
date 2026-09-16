/**
 * Update check helpers for the update-reminder line (方案单 20260915-0025).
 *
 * Prompt-only by design: the plugin never downloads or replaces its own
 * files (Obsidian developer policies forbid "Install or update themselves"),
 * it only learns the latest stable version and lets the host updater do the
 * rest. Everything here is a pure function or a self-contained request
 * wrapper; state lives in main and is injected, so the whole module is
 * unit-testable without the Obsidian host.
 *
 * Check source: jsDelivr data API for the public release repo (same source
 * precedent as OpenPlug / Resojot; reachable from CN networks without a
 * mirror). Single KB-sized anonymous GET, 15s budget, every failure silent.
 */

/** One cold-start-cycle check budget; failures surface nothing anywhere. */
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;

/** Throttle between real network checks (per device, persisted by main). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** "Remind me in 7 days" window (方案单 §四 跳过层 选项 A). */
export const SNOOZE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export const JSDELIVR_PACKAGE_URL =
  "https://data.jsdelivr.com/v1/package/gh/jiaoyingxing/easy-sync";

export function isStableVersion(version: string): boolean {
  return /^\d+(\.\d+)+$/u.test(version);
}

/** Numeric segment comparison: candidate must be strictly greater. */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!isStableVersion(candidate) || !isStableVersion(current)) return false;
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function pickLatestStableVersion(
  versions: readonly string[],
): string | null {
  let latest: string | null = null;
  for (const version of versions) {
    if (!isStableVersion(version)) continue;
    if (latest === null || isNewerVersion(version, latest)) latest = version;
  }
  return latest;
}

export function isUpdateCheckDue(
  lastCheckAt: number | null | undefined,
  now: number,
): boolean {
  if (lastCheckAt === null || lastCheckAt === undefined) return true;
  return now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Persisted per-device snooze decision from the reminder modal.
 * - 7-day snooze: `{ version, until }` with a future timestamp.
 * - Skip this version: `{ version, until: null }`.
 * A release newer than the snoozed one always reopens the row immediately.
 */
export interface UpdateReminderSnooze {
  version: string;
  until: number | null;
}

export function isUpdateReminderSuppressed(
  latest: string,
  snooze: UpdateReminderSnooze | null | undefined,
  now: number,
): boolean {
  if (!snooze || !snooze.version) return false;
  if (isNewerVersion(latest, snooze.version)) return false;
  if (snooze.until === null || snooze.until === undefined) return true;
  return now < snooze.until;
}

export interface UpdateCheckResponse {
  status: number;
  text: string;
}

export type UpdateCheckFetcher = (
  opts: { url: string; method?: string },
) => Promise<UpdateCheckResponse>;

/**
 * Latest stable version from the jsDelivr package payload, or null on any
 * failure (non-2xx, malformed payload, offline, timeout). The null-on-failure
 * contract is the "失败/离线全静默" guarantee from the 方案单, kept in one
 * place so callers cannot leak errors into the sync surface.
 */
export async function fetchLatestStableVersion(
  fetcher: UpdateCheckFetcher,
): Promise<string | null> {
  try {
    const response = await withTimeout(
      fetcher({ url: JSDELIVR_PACKAGE_URL, method: "GET" }),
      UPDATE_CHECK_TIMEOUT_MS,
    );
    if (response.status < 200 || response.status >= 300) return null;
    const data = JSON.parse(response.text) as { versions?: unknown };
    if (!Array.isArray(data.versions)) return null;
    return pickLatestStableVersion(data.versions.map(String));
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error("update-check-timeout")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

/**
 * Vault-scoped persistence for the update-reminder state (issue #18 round,
 * 2026-09-15). These three values are per-vault device bookkeeping: they never
 * participate in sync, and they must stay out of the plugin data file because
 * the V2 migration input digest binds that file's whole content — a routine
 * 24h check writing there could kill an in-flight first-sync activation
 * round. Callers inject the official App localStorage API; a null storage is
 * tolerated so non-browser test contexts simply keep state in memory.
 *
 * The retired 1.4.8 plugin-data keys are read once as an upgrade seed and
 * are never written again; the seed retires once 1.4.8 devices are gone.
 */
export type UpdateCheckStorage = Pick<Storage, "getItem" | "setItem">;

export interface UpdateCheckPersistedState {
  lastCheckAt: number | null;
  lastKnownLatest: string | null;
  snooze: UpdateReminderSnooze | null;
}

const UPDATE_CHECK_STORAGE_KEY_LAST_CHECK_AT =
  "easy-sync-update-last-check-at";
const UPDATE_CHECK_STORAGE_KEY_LAST_KNOWN_LATEST =
  "easy-sync-update-last-known-latest";
const UPDATE_CHECK_STORAGE_KEY_SNOOZE = "easy-sync-update-reminder-snooze";

const LEGACY_PLUGIN_DATA_KEYS = {
  lastCheckAt: "update-last-check-at",
  lastKnownLatest: "update-last-known-latest",
  snooze: "update-reminder-snooze",
} as const;

export function loadUpdateCheckState(
  storage: UpdateCheckStorage | null,
): UpdateCheckPersistedState {
  if (!storage) {
    return { lastCheckAt: null, lastKnownLatest: null, snooze: null };
  }
  return {
    lastCheckAt: readStoredNumber(
      storage,
      UPDATE_CHECK_STORAGE_KEY_LAST_CHECK_AT,
    ),
    lastKnownLatest: readStoredStableVersion(
      storage,
      UPDATE_CHECK_STORAGE_KEY_LAST_KNOWN_LATEST,
    ),
    snooze: readStoredSnooze(storage),
  };
}

/** Only present fields are written; a field's absence simply means "unset". */
export interface UpdateCheckStatePatch {
  lastCheckAt?: number;
  lastKnownLatest?: string;
  snooze?: UpdateReminderSnooze;
}

export function saveUpdateCheckState(
  storage: UpdateCheckStorage | null,
  state: UpdateCheckStatePatch,
): void {
  if (!storage) return;
  try {
    if (state.lastCheckAt !== undefined) {
      storage.setItem(
        UPDATE_CHECK_STORAGE_KEY_LAST_CHECK_AT,
        String(state.lastCheckAt),
      );
    }
    if (state.lastKnownLatest !== undefined) {
      storage.setItem(
        UPDATE_CHECK_STORAGE_KEY_LAST_KNOWN_LATEST,
        state.lastKnownLatest,
      );
    }
    if (state.snooze !== undefined) {
      storage.setItem(
        UPDATE_CHECK_STORAGE_KEY_SNOOZE,
        JSON.stringify(state.snooze),
      );
    }
  } catch {
    // Lost bookkeeping is always safe: an extra check next load, or a
    // reminder that reopens. Same silence contract as the network check.
  }
}

/**
 * One-time seed from the retired 1.4.8 plugin-data keys so upgrading devices
 * keep their check throttle and snooze decision. Read-only by design: the
 * stale keys stay in the plugin data file untouched, so they can never change
 * a migration input digest again.
 */
export function seedUpdateCheckStateFromLegacyPluginData(
  data: Readonly<Record<string, unknown>> | null,
): UpdateCheckPersistedState {
  if (!data) {
    return { lastCheckAt: null, lastKnownLatest: null, snooze: null };
  }
  const legacyLastCheckAt = data[LEGACY_PLUGIN_DATA_KEYS.lastCheckAt];
  const legacyLastKnownLatest = data[LEGACY_PLUGIN_DATA_KEYS.lastKnownLatest];
  return {
    lastCheckAt: typeof legacyLastCheckAt === "number" ? legacyLastCheckAt : null,
    lastKnownLatest: typeof legacyLastKnownLatest === "string"
      ? legacyLastKnownLatest
      : null,
    snooze: parseSnoozeRecord(data[LEGACY_PLUGIN_DATA_KEYS.snooze]),
  };
}

function readStoredNumber(
  storage: UpdateCheckStorage,
  key: string,
): number | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readStoredStableVersion(
  storage: UpdateCheckStorage,
  key: string,
): string | null {
  const raw = storage.getItem(key);
  return raw !== null && isStableVersion(raw) ? raw : null;
}

function readStoredSnooze(
  storage: UpdateCheckStorage,
): UpdateReminderSnooze | null {
  const raw = storage.getItem(UPDATE_CHECK_STORAGE_KEY_SNOOZE);
  if (raw === null) return null;
  try {
    return parseSnoozeRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function parseSnoozeRecord(value: unknown): UpdateReminderSnooze | null {
  if (
    !!value
    && typeof value === "object"
    && typeof (value as { version?: unknown }).version === "string"
  ) {
    const until = (value as { until?: unknown }).until;
    return {
      version: (value as { version: string }).version,
      until: typeof until === "number" ? until : null,
    };
  }
  return null;
}
