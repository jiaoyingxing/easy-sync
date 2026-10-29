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
import {
  collectRecentRunSummaries,
  type DiagRunSummary,
} from "./diagnostic-run-summary";

export type DiagCategory =
  | "scan"       // 本地扫描
  | "plan"       // 同步计划
  | "execute"    // 执行
  | "auth"       // 认证
  | "onedrive"   // API 调用
  | "state"      // 状态持久化
  | "lifecycle"; // 插件生命周期

type DiagLevel = "log" | "warn" | "error";

export interface DiagEntry {
  ts: number;
  cat: DiagCategory;
  lvl: DiagLevel;
  msg: string;
  data?: unknown;
}

/** What one report read sees: the tail window unchanged, plus the per-round
 *  summaries that window would otherwise hide. */
interface DiagnosticSnapshot {
  /** Recent entries, capped exactly as before (report passes 500). */
  entries: DiagEntry[];
  /** Up to 5 most recent rounds, extracted by fixed message name *before* the
   *  window is applied. Never persisted. */
  runSummaries: DiagRunSummary[];
}

const ALL_CATEGORIES: DiagCategory[] = [
  "scan", "plan", "execute", "auth", "onedrive", "state", "lifecycle",
];

const MAX_BUFFER = 5000;
const MAX_LOG_DAYS = 7;
const MAX_LOG_BYTES = 30 * 1024 * 1024;
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 5000;
/** Highest segment suffix rolling will use (`YYYY-MM-DD.99.jsonl`). */
const MAX_SEGMENT_INDEX = 99;
/**
 * Backlog cap for entries waiting to reach disk (same order as the memory
 * ring). Background throttling can stall the flush timer for hours; without
 * a cap the queue grows without bound and a hard kill loses every pending
 * line. Oldest entries are dropped first and the drop is reported to disk.
 */
export const MAX_PENDING = 5000;

/** The JSONL segment this logger writes, plus the byte count it accounts for
 *  in that file itself. */
interface LogSegment {
  index: number;
  path: string;
  /** Bytes this logger expects in the file before the current batch. */
  bytes: number;
  /** False when the adapter could not report a size: `bytes` is then only a
   *  lower bound, so neither the file cap nor the rewrite probe may trust it. */
  known: boolean;
}

export class DiagnosticLogger {
  private enabled = new Set<DiagCategory>();
  private buffer: DiagEntry[] = [];
  private pending: DiagEntry[] = [];
  private pendingDropped = 0;
  private timer: TimeoutHandle | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private adapter: DataAdapter | null = null;
  private logDir = getEasySyncPaths(DEFAULT_CONFIG_DIR).logsDir;
  private lastPruneDate: string | null = null;
  /** Segment already selected for the day, with this logger's own UTF-8 byte
   *  count for it. Selection must not be re-derived from `stat` on every
   *  flush: a stale or failing size read used to move one sync round's lines
   *  between `.jsonl` / `.1.jsonl` / `.2.jsonl`, which reads like a frozen
   *  sync to anyone opening a single file (2026-10-26 field evidence). */
  private segment: { date: string; index: number; bytes: number } | null = null;
  /** Batches whose lines never reached disk (both write attempts failed); the
   *  next batch that does land stamps the gap into the log. */
  private unpersistedBatches = 0;
  private unpersistedEntries = 0;
  /** One console warning per failure episode, not one per failed flush. */
  private writeFailureReported = false;
  /** Paths already reported by the external-rewrite probe (once per session). */
  private externalRewriteReported = new Set<string>();

  /** Must be called after the Obsidian vault adapter is available. */
  setAdapter(adapter: DataAdapter, configDir: string = DEFAULT_CONFIG_DIR): void {
    this.adapter = adapter;
    this.logDir = getEasySyncPaths(configDir).logsDir;
    // The byte record belongs to the previous log directory.
    this.segment = null;
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

  log(cat: DiagCategory, msg: string, data?: unknown, opts?: { urgent?: boolean }): void {
    if (!this.enabled.has(cat)) return;
    this.emit({ ts: Date.now(), cat, lvl: "log", msg, data }, opts?.urgent === true);
  }

  warn(cat: DiagCategory, msg: string, data?: unknown): void {
    this.emit({ ts: Date.now(), cat, lvl: "warn", msg, data }, true);
  }

  error(cat: DiagCategory, msg: string, data?: unknown): void {
    this.emit({ ts: Date.now(), cat, lvl: "error", msg, data }, true);
  }

  // ---- Internal ----

  /** warn/error and explicitly urgent lines reach disk immediately instead of
   *  waiting for the batch window: a hard kill or a background freeze used to
   *  swallow the last ≤5s batch whole, including receipt/failure/summary rows
   *  (F26 2026-10-13). */
  private emit(e: DiagEntry, urgent = false): void {
    this.writeToConsole(e);
    this.pushRing(e);
    this.pushPending(e);
    if (urgent) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = compatSetTimeout(() => {
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  private writeToConsole(e: DiagEntry): void {
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
      if (e.data !== undefined) console.debug(line, e.data);
      else console.debug(line);
    }
  }

  private pushRing(e: DiagEntry): void {
    this.buffer.push(e);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(-MAX_BUFFER);
    }
  }

  /** Queue for the next batch; beyond the cap the oldest entries are dropped
   *  and the next flush reports the dropped count. */
  private pushPending(e: DiagEntry): void {
    this.pending.push(e);
    if (this.pending.length > MAX_PENDING) {
      const overflow = this.pending.length - MAX_PENDING;
      this.pending.splice(0, overflow);
      this.pendingDropped += overflow;
    }
  }

  /** Serialize flushes: an urgent flush must not interleave its append with a
   *  batch flush writing the same JSONL segment. */
  private flush(): Promise<void> {
    this.flushChain = this.flushChain
      .then(() => this.flushOnce())
      .catch(() => undefined);
    return this.flushChain;
  }

  private async flushOnce(): Promise<void> {
    this.timer = null;
    if (!this.adapter) return;

    const batch = this.pending;
    this.pending = [];
    if (this.pendingDropped > 0) {
      const dropped = this.pendingDropped;
      this.pendingDropped = 0;
      const notice: DiagEntry = {
        ts: Date.now(),
        cat: "lifecycle",
        lvl: "warn",
        msg: `diagnostic log backlog overflow — dropped ${dropped} oldest pending ${dropped === 1 ? "entry" : "entries"}`,
        data: { dropped, limit: MAX_PENDING },
      };
      this.writeToConsole(notice);
      this.pushRing(notice);
      batch.unshift(notice);
    }
    if (batch.length === 0) return;

    const entryCount = batch.length;
    const today = localDate();
    const unpersistedBatches = this.unpersistedBatches;
    const unpersistedEntries = this.unpersistedEntries;
    let payload = batch;
    if (unpersistedBatches > 0) {
      // The lines lost to a failed disk write left no other trace; the next
      // batch that does land carries the count so a log reader can tell the
      // gap was the logger, not a frozen sync.
      const batchWord = unpersistedBatches === 1 ? "batch" : "batches";
      const entryWord = unpersistedEntries === 1 ? "entry" : "entries";
      const notice: DiagEntry = {
        ts: Date.now(),
        cat: "lifecycle",
        lvl: "warn",
        msg: `diagnostic log write failures — ${unpersistedBatches} ${batchWord} / ${unpersistedEntries} ${entryWord} never reached disk`,
        data: { failedBatches: unpersistedBatches, lostEntries: unpersistedEntries },
      };
      this.pushRing(notice);
      payload = [notice, ...batch];
    }
    const text = payload.map((e) => JSON.stringify(e)).join("\n") + "\n";

    if (await this.persistBatch(today, text, utf8Bytes(text))) {
      this.unpersistedBatches = 0;
      this.unpersistedEntries = 0;
      this.writeFailureReported = false;
      // Prune daily; always run after write to enforce byte limits
      if (this.lastPruneDate !== today) {
        await pruneLogs(this.adapter, this.logDir, MAX_LOG_DAYS, MAX_LOG_BYTES);
        this.lastPruneDate = today;
      }
      return;
    }

    this.unpersistedBatches += 1;
    this.unpersistedEntries += entryCount;
    this.reportWriteFailure(entryCount);
  }

  /** Write one payload into today's segment. Returns false when both attempts
   *  failed; never throws, so sync keeps running without disk logging. */
  private async persistBatch(today: string, text: string, textBytes: number): Promise<boolean> {
    const adapter = this.adapter;
    if (!adapter) return false;

    try {
      await ensureDir(adapter, this.logDir);
      const segment = await this.resolveSegment(adapter, today, textBytes);
      const existed = await adapter.exists(segment.path);
      if (existed) {
        const observed = await readLogSize(adapter, segment.path);
        // `segment.bytes` is this logger's own record, not a size read now: a
        // mismatch means something outside the plugin rewrote the file.
        if (segment.known && observed !== null && observed !== undefined
          && observed !== segment.bytes) {
          this.reportExternalRewrite(segment.path, segment.bytes, observed);
        }
      }

      if (!(await this.appendWithRetry(adapter, segment.path, text, existed))) return false;

      if (!segment.known) {
        // The pre-write size was unreadable, so no trustworthy count exists;
        // re-read it next flush instead of probing against a lower bound.
        this.segment = null;
        return true;
      }
      this.segment = {
        date: today,
        index: segment.index,
        // `write` replaces the file from scratch; `append` adds to what we
        // already expected there.
        bytes: existed ? segment.bytes + textBytes : textBytes,
      };
      return true;
    } catch {
      return false;
    }
  }

  /** Pick the segment for `today`, keeping the one already chosen for the day
   *  until this logger's own byte count says the file is full. `stat` only
   *  picks the first segment of a day (and the fallback when no count exists
   *  yet), so a stale or failing size read cannot shuffle lines between
   *  `.jsonl` / `.1.jsonl` / `.2.jsonl` mid-round. */
  private async resolveSegment(
    adapter: DataAdapter,
    today: string,
    textBytes: number,
  ): Promise<LogSegment> {
    const current = this.segment;
    if (current && current.date === today && current.bytes + textBytes <= MAX_LOG_FILE_BYTES) {
      return {
        index: current.index,
        path: segmentPath(this.logDir, today, current.index),
        bytes: current.bytes,
        known: true,
      };
    }

    let index = current && current.date === today
      ? Math.min(current.index + 1, MAX_SEGMENT_INDEX)
      : 0;
    for (;;) {
      const path = segmentPath(this.logDir, today, index);
      const size = await readLogSize(adapter, path);
      if (size === undefined) {
        // Unknown size: write here, but record nothing so the next flush
        // re-reads instead of trusting a made-up byte count.
        return { index, path, bytes: 0, known: false };
      }
      const bytes = size ?? 0;
      // A missing file always starts here, even for a batch larger than the
      // cap on its own; otherwise roll while the file is full.
      if (size === null || bytes + textBytes <= MAX_LOG_FILE_BYTES
        || index >= MAX_SEGMENT_INDEX) {
        this.segment = { date: today, index, bytes };
        return { index, path, bytes, known: true };
      }
      index += 1;
    }
  }

  /** Write one payload, retrying once immediately. A disk that refuses twice
   *  is reported by the caller; it never fails the sync round. */
  private async appendWithRetry(
    adapter: DataAdapter,
    path: string,
    text: string,
    existed: boolean,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (existed) await adapter.append(path, text);
        else await adapter.write(path, text);
        return true;
      } catch {
        // Retried once; a second failure is reported by the caller.
      }
    }
    return false;
  }

  /** A failed batch is already out of `pending`, so keep the loss visible:
   *  count it, warn on the console once per failure episode, and keep a line
   *  in the memory ring. Never throws — logging must not block sync. */
  private reportWriteFailure(entries: number): void {
    if (this.writeFailureReported) return;
    this.writeFailureReported = true;
    const notice: DiagEntry = {
      ts: Date.now(),
      cat: "lifecycle",
      lvl: "warn",
      msg: `diagnostic log write failed after one retry — ${entries} ${entries === 1 ? "entry" : "entries"} kept in memory only`,
      data: {
        entries,
        failedBatches: this.unpersistedBatches,
        lostEntries: this.unpersistedEntries,
      },
    };
    this.writeToConsole(notice);
    this.pushRing(notice);
  }

  /** This logger only ever grows its own file, so a size that differs from the
   *  expected one means something outside the plugin rewrote it (external
   *  vault-level copy/sync — the only way to tell that apart from a lost batch
   *  at the time it happens). Reported once per path per session because the
   *  wrong size persists across flushes. */
  private reportExternalRewrite(path: string, expected: number, observed: number): void {
    if (this.externalRewriteReported.has(path)) return;
    this.externalRewriteReported.add(path);
    this.warn("lifecycle", `diagnostic log file changed outside this plugin — ${path}`, {
      expectedBytes: expected,
      observedBytes: observed,
    });
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
   *  includes events that haven't been persisted yet.
   *
   *  `entries` keeps the historical tail-window contract verbatim: the same
   *  merged set is sliced to `count` after sorting. `runSummaries` is a bypass
   *  over the *unsliced* set, by fixed message name only, so a round whose
   *  four summary lines sit behind a busy window still reaches the report.
   *  The bypass costs no extra I/O: the recent segments are already parsed in
   *  full before the window is applied. */
  async snapshot(count = 500): Promise<DiagnosticSnapshot> {
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
    return {
      entries: merged.slice(-count),
      // The bypass must read the unsliced set: this is the whole point of A1.
      runSummaries: collectRecentRunSummaries(merged),
    };
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
              const parsed: unknown = JSON.parse(trimmed);
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

const UTF8 = new TextEncoder();

/** Byte length of the UTF-8 encoding — the unit log files actually grow in.
 *  `String.length` counts UTF-16 code units, so CJK text (3 bytes per Han
 *  character) reads 2 bytes short per character and the rewrite probe would
 *  fire on every Chinese batch. */
function utf8Bytes(text: string): number {
  return UTF8.encode(text).byteLength;
}

/** `YYYY-MM-DD.jsonl` for segment 0, `YYYY-MM-DD.<n>.jsonl` after that. */
function segmentPath(dir: string, date: string, index: number): string {
  return index === 0 ? `${dir}/${date}.jsonl` : `${dir}/${date}.${index}.jsonl`;
}

/** A log file's size: a number, `null` when the file does not exist, or
 *  `undefined` when the adapter could not tell (unknown, never treated as 0). */
async function readLogSize(
  adapter: DataAdapter,
  path: string,
): Promise<number | null | undefined> {
  try {
    const stat = await adapter.stat(path);
    return stat ? stat.size : null;
  } catch {
    return undefined;
  }
}

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
