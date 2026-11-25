import { describe, expect, it } from "vitest";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

/**
 * WebDAV 常用项进每轮诊断摘要：请求总数／按方法、列表次数与最大页数、
 * provider 能力位。只作观测，不改变计划、重试或用户可见文案。
 */
describe("WebDAV 诊断摘要", () => {
  it("确认轮 phase summary 带请求、列表与能力位", async () => {
    const calls: unknown[][] = [];
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello",
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
      diag: {
        log: (...args: unknown[]) => calls.push(args),
        warn: (...args: unknown[]) => calls.push(args),
        error: (...args: unknown[]) => calls.push(args),
        isEnabled: () => true,
      },
    });
    try {
      await harness.runRound("manual");
      await harness.confirmRound(harness.state.planReviewAuthorization!);

      const summaries = calls.filter((args) =>
        args[1] === "sync run phase summary");
      expect(summaries.length).toBeGreaterThan(0);
      const data = summaries[summaries.length - 1][2] as {
        webdav?: {
          requests: { total: number; byMethod: Record<string, number> };
          listings: { calls: number; maxPages: number };
          capabilities: Record<string, unknown>;
        };
      };
      expect(data.webdav).toBeDefined();
      expect(data.webdav!.requests.total).toBeGreaterThan(0);
      expect(data.webdav!.requests.byMethod.PROPFIND).toBeGreaterThan(0);
      expect(data.webdav!.requests.byMethod.PUT).toBeGreaterThan(0);
      expect(data.webdav!.listings.calls).toBeGreaterThan(0);
      expect(data.webdav!.listings.maxPages).toBeGreaterThanOrEqual(1);
      expect(data.webdav!.capabilities).toMatchObject({
        maxSinglePutBytes: 100 * 1024 * 1024,
        stableIdentity: false,
        conditionalCreate: false,
        serverSideMove: true,
        rangeDownload: false,
        resumableUpload: false,
      });
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("同一 client 的两轮摘要只统计各自轮次", async () => {
    const calls: unknown[][] = [];
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      diag: {
        log: (...args: unknown[]) => calls.push(args),
        warn: () => {},
        error: () => {},
        isEnabled: () => true,
      },
    });
    try {
      await harness.runRound("manual");
      await harness.confirmRound(harness.state.planReviewAuthorization!);
      await harness.runRound("manual");
      const summaries = calls
        .filter((args) => args[1] === "sync run phase summary")
        .map((args) => (args[2] as {
          webdav?: { requests: { total: number } };
        }).webdav?.requests.total);
      expect(summaries.length).toBeGreaterThanOrEqual(2);
      const first = summaries[summaries.length - 2];
      const second = summaries[summaries.length - 1];
      expect(first).toBeGreaterThan(0);
      // 第二轮零计划，只读观察仍会发少量请求，但绝不能是累计值。
      expect(second).toBeLessThan(first);
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
