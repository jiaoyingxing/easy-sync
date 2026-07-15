/**
 * DiagnosticLogger — Structured diagnostic logging for EasySync
 *
 * Three outputs:
 *   1. Console  — `[EasySync|category] HH:MM:SS message`
 *   2. Memory   — Ring buffer (5000 entries max)
 *   3. Disk     — JSONL files under the EasySync log directory in the vault config dir
 *
 * warn/error level entries always emit regardless of category enablement.
 * Log files are NOT synced (stored under the vault config dir, which sync excludes).
 */

import type { DataAdapter } from "obsidian";
import {
  compatClearTimeout,
  compatSetTimeout,
  DEFAULT_CONFIG_DIR,
  getEasySyncPaths,
  isRecord,
  TimeoutHandle,
} from "../obsidian-compat";

export type DiagCategory =
  | "scan"       // 本地扫描
  | "plan"       // 同步计划
  | "execute"    // 执行
  | "auth"       // 认证
  | "onedrive"   // API 调用
  | "state"      // 状态持久化
  | "lifecycle"; // 插件生命周期

export type DiagLevel = "log" | "warn" | "error";

export interface DiagEntry {
  ts: number;
  cat: DiagCategory;
  lvl: DiagLevel;
  msg: string;
  data?: unknown;
}

const ALL_CATEGORIES: DiagCategory[] = [
  "scan", "plan", "execute", "auth", "onedrive", "state", "lifecycle",
];

const MAX_BUFFER = 5000;
const MAX_LOG_DAYS = 7;
const MAX_LOG_BYTES = 30 * 1024 * 1024;
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 5000;
export class DiagnosticLogger {
  private enabled = new Set<DiagCategory>();
  private buffer: DiagEntry[] = [];
  private pending: DiagEntry[] = [];
  private timer: TimeoutHandle | null = null;
  private adapter: DataAdapter | null = null;
  private logDir = getEasySyncPaths(DEFAULT_CONFIG_DIR).logsDir;
  private lastPruneDate: string | null = null;

  /** Must be called after the Obsidian vault adapter is available. */
  setAdapter(adapter: DataAdapter, configDir: string): void {
    this.adapter = adapter;
    this.logDir = `${configDir}/plugins/easy-sync/logs`;
  }

  /** Enable all categories. Called when the user turns on diagnostic logging. */
  enableAll(): void {
    for (const c of ALL_CATEGORIES) this.enabled.add(c);
  }

  /** Disable all categories. warn/error still emit regardless. */
  clear(): void {
    this.enabled.clear();
  }

  /** Check if a specific category is enabled. */
  isEnabled(cat: DiagCategory): boolean {
    return this.enabled.has(cat);
  }

  // ---- Public logging API ----

  log(cat: DiagCategory, msg: string, data?: unknown): void {
    if (!this.enabled.has(cat)) return;
    this.emit({ ts: Date.now(), cat, lvl: "log", msg, data });
  }

  warn(cat: DiagCategory, msg: string, data?: unknown): void {
    this.emit({ ts: Date.now(), cat, lvl: "warn", msg, data });
  }

  error(cat: DiagCategory, msg: string, data?: unknown): void {
    this.emit({ ts: Date.now(), cat, lvl: "error", msg, data });
  }

  // ---- Internal ----

  private emit(e: DiagEntry): void {
    // 1. Console output
    const ts = new Date(e.ts).toLocaleTimeString();
    const prefix = `[EasySync|${e.cat}]`;
    const line = `${ts} ${prefix} ${e.msg}`;
    if (e.lvl === "error") {
      if (e.data !== undefined) console.error(line, e.data);
      else console.error(line);
    } else if (e.lvl === "warn") {
      if (e.data !== undefined) console.warn(line, e.data);
      else console.warn(line);
    } else {
      if (e.data !== undefined) console.log(line, e.data);
      else console.log(line);
    }

    // 2. In-memory ring buffer
    this.buffer.push(e);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(-MAX_BUFFER);
    }

    // 3. Queue for batched disk flush
    this.pending.push(e);
    if (!this.timer) {
      this.timer = compatSetTimeout(() => {
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (!this.adapter || this.pending.length === 0) return;

    const batch = this.pending;
    this.pending = [];

    const today = localDate();
    const text = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";

    try {
      await ensureDir(this.adapter, this.logDir);

      // Pick the current segment, rolling if the file exceeds the single-file cap
      let seg = 0;
      let path = `${this.logDir}/${today}.jsonl`;
      while (seg < 99) {
        try {
          const st = await this.adapter.stat(path);
          if (!st || st.size + text.length <= MAX_LOG_FILE_BYTES) break;
        } catch { break; }
        seg++;
        path = `${this.logDir}/${today}.${seg}.jsonl`;
      }

      if (await this.adapter.exists(path)) {
        await this.adapter.append(path, text);
      } else {
        await this.adapter.write(path, text);
      }
      // Prune daily; always run after write to enforce byte limits
      if (this.lastPruneDate !== today) {
        await pruneLogs(this.adapter, this.logDir, MAX_LOG_DAYS, MAX_LOG_BYTES);
        this.lastPruneDate = today;
      }
    } catch {
      // Disk write failed — silently degrade (console + buffer still work)
    }
  }

  /** Force flush pending entries to disk. Call on plugin unload. */
  async dispose(): Promise<void> {
    if (this.timer) {
      compatClearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Get recent entries from the in-memory buffer (for future debug UI). */
  getRecent(count = 100): DiagEntry[] {
    return this.buffer.slice(-count);
  }

  /** Flush pending entries to disk immediately, then restart the batch timer.
   *  Called before reading snapshot so the report includes the latest events. */
  async forceFlush(): Promise<void> {
    if (this.timer) {
      compatClearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Return a merged snapshot of recent log entries from disk, pending batch,
   *  and memory buffer. Force-flushes pending to disk first so the report
   *  includes events that haven't been persisted yet. */
  async snapshot(count = 500): Promise<DiagEntry[]> {
    // ① Flush pending so the latest events are on disk
    await this.forceFlush();

    // ② Read disk entries
    const diskEntries = await this.readRecentDiskLogs(Number.MAX_SAFE_INTEGER);
    // If disk is unavailable, readRecentDiskLogs already falls back to buffer

    // ③ Merge with memory buffer (catches edge case: disk write failed)
    const seen = new Set<string>();
    const merged: DiagEntry[] = [];
    for (const e of [...diskEntries, ...this.buffer]) {
      const key = `${e.ts}|${e.cat}|${e.lvl}|${e.msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(e);
    }
    merged.sort((a, b) => a.ts - b.ts);
    return merged.slice(-count);
  }

  /** Read recent disk log entries from JSONL files (max `count` most recent).
   *  Reads up to 3 recent log files. Falls back to memory buffer if adapter
   *  is unavailable or no disk files exist. */
  async readRecentDiskLogs(count = 500): Promise<DiagEntry[]> {
    // Fallback to memory buffer when no disk access
    if (!this.adapter) return this.buffer.slice(-count);

    try {
      let listed: { files: string[] };
      try {
        listed = await this.adapter.list(this.logDir);
      } catch {
        return this.buffer.slice(-count);
      }

      const jsonlFiles = listed.files
        .filter((f) => /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(fileName(f)))
        .sort((a, b) => fileName(b).localeCompare(fileName(a))) // newest first
        .slice(0, 3);

      if (jsonlFiles.length === 0) return this.buffer.slice(-count);

      const entries: DiagEntry[] = [];
      for (const filePath of jsonlFiles) {
        try {
          const raw = await this.adapter.read(filePath);
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (
                isRecord(parsed)
                && typeof parsed.ts === "number"
                && typeof parsed.msg === "string"
                && (parsed.cat === "scan"
                  || parsed.cat === "plan"
                  || parsed.cat === "execute"
                  || parsed.cat === "auth"
                  || parsed.cat === "onedrive"
                  || parsed.cat === "state"
                  || parsed.cat === "lifecycle")
                && (parsed.lvl === "log" || parsed.lvl === "warn" || parsed.lvl === "error")
              ) {
                entries.push({
                  ts: parsed.ts,
                  cat: parsed.cat,
                  lvl: parsed.lvl,
                  msg: parsed.msg,
                  data: parsed.data,
                });
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      if (entries.length === 0) return this.buffer.slice(-count);
      entries.sort((a, b) => a.ts - b.ts);
      return entries.slice(-count);
    } catch {
      return this.buffer.slice(-count);
    }
  }
}

// ---- Helpers ----

/** Ensure a directory path exists, creating parents bottom-up. */
async function ensureDir(
  adapter: DataAdapter,
  dir: string,
): Promise<void> {
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    try {
      await adapter.mkdir(p);
    } catch {
      // Already exists or cannot create — continue
    }
  }
}

/** Enforce triple retention limit: max days, max total bytes, per-file cap
 *  (already enforced at append time via segment rolling). Oldest files
 *  deleted first. Prune failures are silent — logging infrastructure must
 *  never block sync. */
async function pruneLogs(
  adapter: DataAdapter,
  dir: string,
  maxDays: number,
  maxBytes: number,
): Promise<void> {
  let listed: { files: string[] };
  try {
    listed = await adapter.list(dir);
  } catch {
    return;
  }

  const logPattern = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/;
  const logs = listed.files.filter((p) => logPattern.test(fileName(p)));

  // Collect size for each log file
  const sized: Array<{ path: string; size: number }> = [];
  for (const p of logs) {
    try {
      const st = await adapter.stat(p.includes("/") ? p : `${dir}/${p}`);
      if (st) sized.push({ path: p, size: st.size });
    } catch { /* skip unstatable */ }
  }
  sized.sort((a, b) => fileName(a.path).localeCompare(fileName(b.path)));

  // Delete files older than maxDays
  const cutoff = localDate();
  const cutoffDate = new Date(cutoff);
  cutoffDate.setDate(cutoffDate.getDate() - maxDays);
  const cutoffStr = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}-${String(cutoffDate.getDate()).padStart(2, "0")}`;

  let remaining: typeof sized = [];
  for (const s of sized) {
    const name = fileName(s.path);
    const fileDate = name.slice(0, 10); // YYYY-MM-DD prefix
    if (fileDate < cutoffStr) {
      try { await adapter.remove(s.path); } catch { /* skip */ }
    } else {
      remaining.push(s);
    }
  }

  // Delete oldest files until total bytes within limit
  let total = remaining.reduce((sum, s) => sum + s.size, 0);
  for (const s of remaining) {
    if (total <= maxBytes) break;
    try { await adapter.remove(s.path); } catch { /* skip */ }
    total -= s.size;
  }
}

function fileName(path: string): string {
  return path.substring(path.lastIndexOf("/") + 1);
}

/** Return today's date in YYYY-MM-DD using local time (not UTC). */
function localDate(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
