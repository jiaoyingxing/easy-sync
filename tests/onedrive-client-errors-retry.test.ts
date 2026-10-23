// 错误与重试：慢链路证据接线、请求重试策略、Graph 错误可见性
// 由 tests/onedrive-client.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as obsidian from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";
import {
  OneDriveError,
  OneDriveErrorType,
} from "../src/onedrive/types";

describe("OneDriveClient slow-link evidence wiring (2026-09-15 乙路)", () => {
  it("feeds one per-round evidence object into both gate construction sites", () => {
    const clientSource = readFileSync("src/onedrive/client.ts", "utf8");
    const rangeSource = readFileSync("src/onedrive/range-download.ts", "utf8");
    // Round-scoped lifetime: created as an instance field, reset with the
    // other per-round download strategy hints.
    expect(clientSource).toContain("private slowLinkEvidence = createSlowLinkEvidence();");
    expect(clientSource).toContain("this.slowLinkEvidence = createSlowLinkEvidence();");
    // Both gate construction sites share the evidence; the single-stream gate
    // also receives the file size for the completion-imminence exemption.
    expect(clientSource).toContain("{ evidence: this.slowLinkEvidence, totalSize: input.fileSize }");
    expect(clientSource).toContain("slowLinkEvidence: this.slowLinkEvidence,");
    expect(rangeSource).toContain("evidence: input.slowLinkEvidence");
    // Telemetry surfaces through the shared error-data helper.
    expect(clientSource).toContain("data.slowGateRateKiBps = slowGateRate;");
  });
});

describe("OneDriveClient request retry policy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a network error and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("summarizes endpoint attempts and retry outcomes without exposing URLs", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 503,
        headers: {},
        json: { error: { code: "serviceUnavailable", message: "down" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    const pending = client.getAppFolder();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    const summary = client.finishRunMetrics();

    expect(summary).toMatchObject({
      schemaVersion: 2,
      totals: {
        attempts: 2,
        succeeded: 1,
        failed: 1,
        cancelled: 0,
        peakConcurrency: 1,
      },
      endpoints: {
        metadata: {
          attempts: 2,
          succeeded: 1,
          failed: 1,
          cancelled: 0,
          effectiveBytes: 0,
          retriedBytes: 0,
          peakConcurrency: 1,
          statusCategories: {
            serverError: 1,
            success: 1,
          },
        },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("graph.microsoft.com");
    expect(JSON.stringify(summary)).not.toContain("app-root");
  });

  it("separates logical upload bytes from bytes sent by retry attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 503,
        headers: {},
        json: { error: { code: "serviceUnavailable", message: "down" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "uploaded", name: "note.md", size: 4 },
      });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    const pending = client.uploadFile("testVault", "note.md", new ArrayBuffer(4));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "uploaded" });
    const summary = client.finishRunMetrics();

    expect(summary?.endpoints.simpleUpload).toMatchObject({
      attempts: 2,
      succeeded: 1,
      failed: 1,
      effectiveBytes: 4,
      retriedBytes: 4,
      statusCategories: {
        serverError: 1,
        success: 1,
      },
    });
    expect(summary?.totals).toMatchObject({
      effectiveBytes: 4,
      retriedBytes: 4,
    });
  });

  it("honors Retry-After before retrying a rate-limited request", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 429,
        headers: { "retry-after": "2" },
        json: { error: { code: "tooManyRequests", message: "slow down" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    await vi.advanceTimersByTimeAsync(1999);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After before retrying a 503 service-unavailable response", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 503,
        headers: { "retry-after": "2" },
        json: { error: { code: "serviceNotAvailable", message: "try later" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    await vi.advanceTimersByTimeAsync(1999);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending Retry-After wait without issuing another request", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 429,
        headers: { "retry-after": "60" },
        json: { error: { code: "tooManyRequests", message: "slow down" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "late-retry", name: "EasySync", folder: {} },
      });
    const controller = new AbortController();
    const client = new OneDriveClient(async () => "token");
    client.setAbortSignal(controller.signal);
    let settled = false;

    const outcome = client.getAppFolder().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { name: "AbortError" },
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 504])("stops after two retries for persistent HTTP %i", async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockRejectedValue({
      status,
      headers: {},
      json: { error: { code: "serviceUnavailable", message: "down" } },
    });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.ServerError,
      statusCode: status,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it("classifies 507 as insufficient OneDrive storage without retrying", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockRejectedValue({
      status: 507,
      headers: {},
      json: { error: { code: "quotaLimitReached", message: "storage full" } },
    });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    await expect(client.getAppFolder()).rejects.toMatchObject({
      type: "InsufficientStorage",
      statusCode: 507,
    });
    const summary = client.finishRunMetrics();

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(summary?.endpoints.metadata?.statusCategories).toMatchObject({
      insufficientStorage: 1,
    });
  });

  it("classifies 509 bandwidth throttling as rate limited and retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 509,
        headers: {},
        json: { error: { code: "activityLimitReached", message: "bandwidth cap" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    const pending = client.getAppFolder();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    expect(requestSpy).toHaveBeenCalledTimes(2);
    const summary = client.finishRunMetrics();

    expect(summary?.endpoints.metadata?.statusCategories).toMatchObject({
      rateLimited: 1,
      success: 1,
    });
  });

  it("does not overlap a timed-out uncancellable DELETE with a retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValueOnce({
        status: 404,
        headers: {},
        json: { error: { code: "itemNotFound", message: "already deleted" } },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.deleteItem("testVault", "deleted.md");
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("does not immediately resend a simple upload after status=0", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce(Object.assign(new Error("transport result unknown"), { status: 0 }))
      .mockResolvedValueOnce({
        status: 201,
        headers: {},
        json: { id: "duplicate-risk", size: 4, eTag: "etag-new" },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.uploadFile("testVault", "note.md", new ArrayBuffer(4));
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      method: "POST",
      run: (client: OneDriveClient) =>
        client.createFolderByParentId("parent-id", "created"),
    },
    {
      method: "PATCH",
      run: (client: OneDriveClient) =>
        client.renameItem("testVault", "old.md", "new.md", "file-id", "etag-1"),
    },
    {
      method: "DELETE",
      run: (client: OneDriveClient) =>
        client.deleteItem("testVault", "deleted.md", "etag-1", "file-id"),
    },
  ])("does not immediately resend a $method mutation after status=0", async ({ method, run }) => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce(Object.assign(new Error("transport result unknown"), { status: 0 }))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          id: "duplicate-risk",
          name: "new.md",
          parentReference: { id: "parent-id" },
          folder: {},
        },
      });
    const client = new OneDriveClient(async () => "token");

    await expect(run(client)).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({ method }));
  });

  it("retries an idempotent GET after an in-call deadline timeout", async () => {
    // A locally timed-out read never produced an HTTP outcome, and a GET is
    // idempotent: a resent request cannot double-apply, so the read joins the
    // ordinary transient retry path (join 弱网「稍后重试」案二, 2026-09-19).
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-idempotent upload whose attempt times out locally", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => new Promise<never>(() => {}));
    const client = new OneDriveClient(async () => "token");

    const pending = client.uploadFile("testVault", "note.md", new ArrayBuffer(4));
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});

describe("OneDriveClient Graph error visibility", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a resolved Graph error body on the typed error and diagnostic log", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 400,
      headers: {},
      json: {
        error: {
          code: "invalidRequest",
          message: "bad name",
          innerError: {
            code: "invalidName",
            "request-id": "request-400",
            date: "2026-10-20T00:00:00Z",
          },
        },
      },
    } as never);
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    const failure = await client.createFolderByParentId("parent-id", "New Folder")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OneDriveError);
    expect(failure).toMatchObject({
      type: OneDriveErrorType.Unknown,
      statusCode: 400,
    });
    const error = failure as OneDriveError;
    expect(error.graphCode).toBe("invalidRequest");
    expect(error.graphMessage).toBe("bad name");
    expect(error.graphInnerCode).toBe("invalidName");
    expect(error.graphRequestId).toBe("request-400");
    expect(requestSpy.mock.calls[0]?.[0]).toMatchObject({ throw: false });
    expect(diag.warn).toHaveBeenCalledWith(
      "onedrive",
      expect.stringContaining(
        "graphCode=invalidRequest, graphMsg=bad name, graphInnerCode=invalidName, graphRequestId=request-400",
      ),
      undefined,
    );
  });
});
