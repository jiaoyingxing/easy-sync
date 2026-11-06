import { describe, expect, it } from "vitest";
import { functionBody, readSourceFile } from "./helpers/source-scope";
import {
  appendStartupTimingObservation,
  buildStartupTimingObservation,
  formatStartupTimingSection,
  normalizeStartupTimingObservation,
  readStartupTimingObservations,
  STARTUP_TIMING_OBSERVATION_FILE,
  STARTUP_TIMING_OBSERVATION_MAX_RECORDS,
  type StartupTimingObservationRecord,
} from "../src/startup-timing-observation";
import type { PluginColdStartSummary } from "../src/startup-performance";

function makeAdapter() {
  const files = new Map<string, string>();
  return {
    files,
    exists: async (path: string) => files.has(path),
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, text: string) => {
      files.set(path, text);
    },
    mkdir: async () => undefined,
  };
}

const LOGS_DIR = ".obsidian/plugins/easy-sync/logs";

function record(
  overrides: Partial<StartupTimingObservationRecord> = {},
): StartupTimingObservationRecord {
  return {
    schemaVersion: 1,
    recordedAt: "2026-11-05T20:30:00.000Z",
    platform: "desktop",
    apiVersion: "1.11.4",
    pluginVersion: "1.6.6",
    visibilityAtOnload: "visible",
    readyMs: { ui: 3, state: 400, auth: 900 },
    onloadReturnedMs: 4,
    layoutReadyMs: 140,
    hostLayoutWaitMs: 136,
    pluginDataReadMs: 7.5,
    stateOutcome: "ready",
    authOutcome: "ready",
    stages: [
      { stage: "onload:begin", atMs: 0 },
      { stage: "onload:returned", atMs: 4 },
      { stage: "host:layout-ready", atMs: 140 },
    ],
    ...overrides,
  };
}

describe("startup timing observation", () => {
  it("round-trips a bounded record set and keeps the newest 40", async () => {
    const adapter = makeAdapter();
    for (let index = 0; index < STARTUP_TIMING_OBSERVATION_MAX_RECORDS + 3; index += 1) {
      await appendStartupTimingObservation(
        adapter,
        LOGS_DIR,
        record({ recordedAt: `2026-11-05T20:30:${String(index).padStart(2, "0")}.000Z` }),
      );
    }

    const stored = await readStartupTimingObservations(adapter, LOGS_DIR);
    expect(stored).toHaveLength(STARTUP_TIMING_OBSERVATION_MAX_RECORDS);
    expect(stored[0]?.recordedAt).toBe("2026-11-05T20:30:03.000Z");
    expect(adapter.files.get(`${LOGS_DIR}/${STARTUP_TIMING_OBSERVATION_FILE}`))
      .toContain("schemaVersion");
  });

  it("reads a missing or corrupt file as empty and recovers on the next append", async () => {
    const adapter = makeAdapter();
    expect(await readStartupTimingObservations(adapter, LOGS_DIR)).toEqual([]);

    adapter.files.set(
      `${LOGS_DIR}/${STARTUP_TIMING_OBSERVATION_FILE}`,
      "{not json",
    );
    expect(await readStartupTimingObservations(adapter, LOGS_DIR)).toEqual([]);

    await expect(
      appendStartupTimingObservation(adapter, LOGS_DIR, record()),
    ).resolves.toBe(true);
    expect(await readStartupTimingObservations(adapter, LOGS_DIR)).toHaveLength(1);
  });

  it("normalizes invalid values, stakes and stage names", () => {
    expect(normalizeStartupTimingObservation(null)).toBeNull();
    expect(normalizeStartupTimingObservation({ schemaVersion: 2 })).toBeNull();
    expect(normalizeStartupTimingObservation({ schemaVersion: 1, platform: "web" }))
      .toBeNull();

    const normalized = normalizeStartupTimingObservation({
      schemaVersion: 1,
      recordedAt: "2026-11-05T20:30:00.000Z",
      platform: "mobile",
      readyMs: { ui: -1, state: "nope", auth: 12 },
      onloadReturnedMs: -4,
      layoutReadyMs: Number.NaN,
      hostLayoutWaitMs: 8,
      pluginDataReadMs: Number.POSITIVE_INFINITY,
      stateOutcome: "weird",
      authOutcome: "failed",
      stages: [
        { stage: "ok", atMs: 9 },
        { stage: "", atMs: 1 },
        { stage: "bad-time", atMs: "x" },
        { stage: "x".repeat(200), atMs: 3 },
        null,
      ],
    });

    expect(normalized).toMatchObject({
      platform: "mobile",
      readyMs: { ui: 0, state: 0, auth: 12 },
      onloadReturnedMs: null,
      layoutReadyMs: null,
      hostLayoutWaitMs: 8,
      pluginDataReadMs: 0,
      stateOutcome: "",
      authOutcome: "failed",
    });
    expect(normalized?.stages.map((mark) => mark.stage)).toEqual([
      "x".repeat(48),
      "ok",
    ]);
  });

  it("builds from a completed summary without paths or credentials", () => {
    const summary: PluginColdStartSummary = {
      schemaVersion: 1,
      platform: "mobile",
      readyMs: { ui: 3.5, state: 410, auth: 980, total: 980 },
      pluginData: {
        physicalReads: 1,
        readMs: 7.5,
        topLevelKeys: 69,
        writesBeforeReady: 0,
        writeMs: 0,
      },
      state: {
        outcome: "ready",
        activeV2: true,
        authorityBlocked: false,
        blockReason: null,
        remoteFiles: 640,
        remoteFolders: 64,
        mutationLedger: 0,
        pendingReview: false,
      },
      auth: { outcome: "ready", loggedIn: true, accountVerified: true },
      stages: [{ stage: "onload:returned", atMs: 4 }],
      onloadReturnedMs: 4,
      layoutReadyMs: 160,
      hostLayoutWaitMs: 156,
      host: {
        apiVersion: "1.11.4",
        pluginVersion: "1.6.6",
        visibilityAtOnload: "visible",
      },
    };

    const built = buildStartupTimingObservation(summary, "2026-11-05T20:30:00.000Z");
    expect(built).toMatchObject({
      platform: "mobile",
      apiVersion: "1.11.4",
      pluginVersion: "1.6.6",
      pluginDataReadMs: 7.5,
      stateOutcome: "ready",
      authOutcome: "ready",
    });
    const serialized = JSON.stringify(built);
    expect(serialized).not.toMatch(/C:\\|\/Users\/|token|secret|Bearer|accountId/);
  });

  it("formats the report section with the plugin segment and host wait separate", () => {
    const lines = formatStartupTimingSection([record()]).join("\n");
    expect(lines).toContain("## 启动耗时观察");
    expect(lines).toContain("插件同步段");
    expect(lines).toContain("宿主 layout-ready 等待");
    expect(lines).toContain("| onload:returned | 4.0ms | 4.0ms |");
    expect(lines).toContain("不是官方 Startup time 槽");

    const empty = formatStartupTimingSection([]).join("\n");
    expect(empty).toContain("当前还没有记录");
  });

  it("keeps observation writes diagnostics-only and off the sync path", () => {
    const source = readSourceFile("src/main.ts");
    const emitter = functionBody(source, "private emitColdStartSummaryIfReady(): void");
    expect(emitter).toContain("if (!this.diagLogEnabled) return;");
    expect(emitter).toContain("appendStartupTimingObservation(");
    expect(emitter).toContain("void ");
    const reportStart = source.indexOf(
      "private async buildDiagnosticReportFile(resetSnapshot = false): Promise<string>",
    );
    const reportEnd = source.indexOf('lines.push("## 云客户端同步环境")', reportStart);
    expect(reportStart).toBeGreaterThan(-1);
    expect(reportEnd).toBeGreaterThan(reportStart);
    const report = source.slice(reportStart, reportEnd);
    expect(report).toContain("if (this.diagLogEnabled)");
    expect(report).toContain("formatStartupTimingSection(");
    expect(report).toContain("readStartupTimingObservations(");
  });
});
