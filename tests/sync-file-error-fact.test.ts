// A3（2026-10-26）：失败身份证据 `SyncFileErrorFactV1`
//
// 目标：诊断报告能回答「这个文件为什么失败」——错误类型、HTTP 状态码、Graph
// 错误码、已传字节、死在哪一层瀑布、重试了几次。
//
// 本文件钉三件事：
// 1. 采集链路：`trackTransfer` 的 catch → 失败分支 → `PendingIssue.error` 与
//    `FileProgress.error`（同一份形状、同一批字段名）；
// 2. 呈现：报告「失败文件明细」行尾的六项证据，缺项写「—」，老条目一律「—」；
// 3. 硬边界：这些字段只作证据，判据函数（网络类分类、熔断、暂停门）不读它们。

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import {
  formatSyncFileErrorFactSuffix,
  projectSyncFileErrorFactColumns,
} from "../src/sync/diagnostic-report-evidence";
import type { LocalScanner } from "../src/sync/local-scanner";
import { SyncExecutor, type SyncCallbacks } from "../src/sync/sync-executor";
import type { FileProgress } from "../src/sync/sync-progress";
import type { PendingIssue } from "../src/sync/state-manager";
import type {
  RemoteFileEntry,
  SyncFileErrorFactV1,
} from "../src/sync/types";
import { functionBody, readSourceFile } from "./helpers/source-scope";
import {
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
  TEST_SYNC_SCOPE,
} from "./helpers/sync-safety-harness";

/** 3.4MB —— 2026-10-26 手机端现场那条始终「网络请求失败」的 resojot/main.js。 */
const FILE_SIZE = 3_565_158;
/** 1.2MB —— 同一条失败已经传出去的字节。 */
const TRANSFERRED_BYTES = 1_258_291;

/** 与 main.ts 报告内的 `formatSize` 同一口径（报告文本断言必须逐字对齐）。 */
function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "?";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const REMOTE_PATH = "big.m4a";

interface FailureHarness {
  executor: SyncExecutor;
  downloadFile: ReturnType<typeof vi.fn>;
  reconcileCalls: PendingIssue[][];
}

function makeFailureExecutor(input: {
  failure: unknown;
  /** Bytes the mocked transport reports before failing — goes through
   *  `trackTransfer`, which is the only place that stamps them. */
  reportBytes?: number;
}): FailureHarness {
  const downloadFile = vi.fn().mockImplementation(
    async (
      _vaultName: string,
      _path: string,
      _url?: string,
      _driveItemId?: string,
      _size?: number,
      report?: (downloaded: number, total: number) => void,
    ) => {
      if (input.reportBytes) report?.(input.reportBytes, FILE_SIZE);
      throw input.failure;
    },
  );
  const remote: RemoteFileEntry = {
    path: REMOTE_PATH,
    driveId: "item-big",
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: FILE_SIZE,
    mtime: 1,
    eTag: "etag-big",
    cTag: "ctag-big",
  };
  const mockState = makeActiveV2State([remote], [], { pendingIssues: [] });
  const reconcileCalls: PendingIssue[][] = [];
  mockState.reconcilePendingIssues = vi.fn(async (issues: PendingIssue[]) => {
    reconcileCalls.push(issues);
  });
  const executor = new SyncExecutor(
    makeMockOneDrive({
      downloadFile,
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "item-big",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: FILE_SIZE,
        mtime: 1,
        eTag: "etag-big",
      }),
    }),
    {
      vault: {
        adapter: makeMockAdapter(),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
      }),
      scanFile: vi.fn().mockResolvedValue(null),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner,
    mockState,
    "testVault",
  );
  return { executor, downloadFile, reconcileCalls };
}

interface FailureOutcome {
  issue: PendingIssue | undefined;
  row: FileProgress | undefined;
  issueError: SyncFileErrorFactV1 | undefined;
  rowError: SyncFileErrorFactV1 | undefined;
  suffix: string;
  networkFailureErrors: number | undefined;
}

/** Run one failing round and read the three surfaces the report consumes. */
async function runFailure(harness: FailureHarness): Promise<FailureOutcome> {
  const completed: FileProgress[] = [];
  const onFileComplete: NonNullable<SyncCallbacks["onFileComplete"]> = (
    path,
    actionType,
    success,
    reason,
    fileSize,
    sourcePath,
    error,
  ) => {
    completed.push({
      path,
      actionType,
      status: success ? "download" : "error",
      reason,
      fileSize,
      sourcePath,
      ...(error ? { error } : {}),
    });
  };
  const result = await harness.executor.run("auto", { onFileComplete });
  const issue = harness.reconcileCalls
    .at(-1)
    ?.find((candidate) => candidate.path === REMOTE_PATH);
  const row = completed.find(
    (candidate) => candidate.path === REMOTE_PATH && candidate.status === "error",
  );
  const issueError = issue?.error;
  const rowError = row?.error;
  return {
    issue,
    row,
    issueError,
    rowError,
    suffix: formatSyncFileErrorFactSuffix(issueError, formatSize, FILE_SIZE),
    networkFailureErrors: result.networkFailureErrors,
  };
}

describe("失败身份证据：采集到报告（A3）", () => {
  it("statusCode=0（完全没有 HTTP 响应）——网络类判定不变，证据写 status=0", async () => {
    const harness = makeFailureExecutor({
      failure: new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
    });

    const outcome = await runFailure(harness);

    // 同一份形状落在两个载体上：字段名与取值逐项一致。
    expect(outcome.issueError).toEqual({
      errorType: "NetworkError",
      statusCode: 0,
    });
    expect(outcome.rowError).toEqual(outcome.issueError);
    expect(Object.keys(outcome.rowError ?? {}).sort()).toEqual(
      Object.keys(outcome.issueError ?? {}).sort(),
    );
    // 报告行尾：六项齐全，缺的四项写「—」。
    expect(outcome.suffix).toBe(
      "— type=NetworkError status=0 code=— moved=— tier=— retries=—",
    );
    // 行为钉：新字段不参与「网络类」判定（0 仍是网络类）。
    expect(outcome.networkFailureErrors).toBe(1);
  });

  it("503 服务端失败——证据写 status=503 与 Graph 错误码，仍不算网络类", async () => {
    const harness = makeFailureExecutor({
      failure: new OneDriveError(
        OneDriveErrorType.ServerError,
        "graph unavailable",
        503,
        null,
        "serviceUnavailable",
      ),
    });

    const outcome = await runFailure(harness);

    expect(outcome.issueError).toEqual({
      errorType: "ServerError",
      statusCode: 503,
      graphCode: "serviceUnavailable",
    });
    expect(outcome.rowError).toEqual(outcome.issueError);
    expect(outcome.suffix).toBe(
      "— type=ServerError status=503 code=serviceUnavailable moved=— tier=— retries=—",
    );
    // 行为钉：新字段不参与「网络类」判定（503 仍不是网络类）。
    expect(outcome.networkFailureErrors).toBeUndefined();
  });

  it("tier=downloadUrl——报告直接说出死在哪一层瀑布，并带上重试次数", async () => {
    const harness = makeFailureExecutor({
      failure: Object.assign(
        new OneDriveError(OneDriveErrorType.NetworkError, "cdn dropped"),
        { tier: "downloadUrl", attempts: 2 },
      ),
    });

    const outcome = await runFailure(harness);

    expect(outcome.issueError).toEqual({
      errorType: "NetworkError",
      statusCode: 0,
      tier: "downloadUrl",
      attempts: 2,
    });
    expect(outcome.rowError).toEqual(outcome.issueError);
    expect(outcome.suffix).toBe(
      "— type=NetworkError status=0 code=— moved=— tier=downloadUrl retries=2",
    );
    // 行为钉：带着证据字段的错误对象照样是网络类（判定只看既有字段）。
    expect(outcome.networkFailureErrors).toBe(1);
  });

  it("transferredBytes=1.2MB——trackTransfer 在 catch 里把已传字节挂到错误上", async () => {
    const harness = makeFailureExecutor({
      failure: new OneDriveError(OneDriveErrorType.NetworkError, "stalled"),
      reportBytes: TRANSFERRED_BYTES,
    });

    const outcome = await runFailure(harness);

    // 传输层只报了进度，没有自己写 transferredBytes：这个值只能来自
    // trackTransfer 的 catch。
    expect(outcome.issueError).toEqual({
      errorType: "NetworkError",
      statusCode: 0,
      transferredBytes: TRANSFERRED_BYTES,
    });
    expect(outcome.rowError).toEqual(outcome.issueError);
    expect(outcome.suffix).toBe(
      "— type=NetworkError status=0 code=— moved=1.2MB/3.4MB tier=— retries=—",
    );
    expect(outcome.suffix).toContain("moved=1.2MB/3.4MB");
  });

  it("待处理项四列的取值与失败明细同源，缺项同样写「—」", async () => {
    const harness = makeFailureExecutor({
      failure: Object.assign(
        new OneDriveError(OneDriveErrorType.NetworkError, "cdn dropped"),
        { tier: "downloadUrl", attempts: 3, transferredBytes: TRANSFERRED_BYTES },
      ),
    });

    const outcome = await runFailure(harness);

    expect(projectSyncFileErrorFactColumns(outcome.issueError, formatSize)).toEqual({
      errorType: "NetworkError",
      transferred: "1.2MB",
      tier: "downloadUrl",
      attempts: "3",
    });
    expect(projectSyncFileErrorFactColumns(undefined, formatSize)).toEqual({
      errorType: "—",
      transferred: "—",
      tier: "—",
      attempts: "—",
    });
  });
});

describe("失败身份证据：老条目与报告装配", () => {
  it("老历史条目没有 error 时，报告逐项写「—」，不猜", () => {
    // 老条目 = 本轮字段存在之前写下的 FileProgress，读回来 `error` 为 undefined。
    expect(formatSyncFileErrorFactSuffix(undefined, formatSize, FILE_SIZE)).toBe(
      "— type=— status=— code=— moved=— tier=— retries=—",
    );
    expect(formatSyncFileErrorFactSuffix(undefined, formatSize)).toBe(
      "— type=— status=— code=— moved=— tier=— retries=—",
    );
    expect(projectSyncFileErrorFactColumns(undefined, formatSize)).toEqual({
      errorType: "—",
      transferred: "—",
      tier: "—",
      attempts: "—",
    });
  });

  it("报告两处装配点确实读 f.error，并走同一批格式化器", () => {
    const source = readSourceFile("src/main.ts");
    const details = functionBody(
      source,
      "private renderDiagnosticFailedFileDetailsSection(",
    );
    expect(details).toContain("formatSyncFileErrorFactSuffix(");
    expect(details).toContain("f.error");

    const pending = functionBody(
      source,
      "private async renderDiagnosticPendingIssuesSection(",
    );
    expect(pending).toContain("projectSyncFileErrorFactColumns(f.error, formatSize)");
    expect(pending).toContain(
      "| 文件 | 大小 | 操作 | 原因 | 最后尝试 | 错误 | 已传 | 层级 | 重试 |",
    );
    // 未同步项表不加列（只动「待处理项」）：五列表头在该节里仍只出现一次。
    expect(
      pending.split('"| 文件 | 大小 | 操作 | 原因 | 最后尝试 |"').length - 1,
    ).toBe(1);
  });
});

describe("失败身份证据：只作证据，不回流进判据", () => {
  const EVIDENCE_TOKENS = [
    "tier",
    "attempts",
    "transferredBytes",
    "SyncFileErrorFact",
    "errorType",
  ];

  it("网络类分类函数不读任何证据字段", () => {
    const body = functionBody(
      readSourceFile("src/sync/sync-executor.ts"),
      "function isNetworkClassTransferFailure(",
    );
    for (const token of EVIDENCE_TOKENS) {
      expect(body, `isNetworkClassTransferFailure 读了 ${token}`).not.toContain(token);
    }
  });

  it("自动同步暂停门不读任何证据字段", () => {
    const source = readSourceFile("src/main.ts");
    const start = source.indexOf("const exemptErrorFamilies =");
    const end = source.indexOf("this.finishSyncNotice(result);", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const gate = source.slice(start, end);
    for (const token of ["SyncFileErrorFact", "transferredBytes", ".tier", "attempts"]) {
      expect(gate, `暂停门读了 ${token}`).not.toContain(token);
    }
  });

  it("M17 熔断臂只读既有字段，不读证据对象", () => {
    const source = readSourceFile("src/sync/sync-executor.ts");
    const start = source.indexOf("const breakerMap = new Map<string, PendingIssue>();");
    const end = source.indexOf("const configPrefix =", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const breaker = source.slice(start, end);
    for (const token of ["SyncFileErrorFact", "transferredBytes", ".tier", "issue.error"]) {
      expect(breaker, `熔断臂读了 ${token}`).not.toContain(token);
    }
  });

  it("证据类型的消费者集合被钉死：新增读者必须显式改这张清单", () => {
    // 任何把 `SyncFileErrorFactV1` / 层级词汇带进别的模块的改动都会让这条断言
    // 变红——包括把证据接进规划、熔断、暂停或重试预算。
    const FACT_TOKENS = [
      "SyncFileErrorFactV1",
      "SyncFileErrorTierV1",
      "SYNC_FILE_ERROR_TIERS",
    ];
    const EXPECTED_CONSUMERS = [
      "src/main.ts",
      "src/onedrive/client.ts",
      "src/sync/diagnostic-report-evidence.ts",
      "src/sync/state-manager.ts",
      "src/sync/sync-executor.ts",
      "src/sync/sync-progress.ts",
      "src/sync/types.ts",
    ];
    const consumers: string[] = [];
    for (const file of listSourceFiles("src")) {
      const text = readSourceFile(file);
      if (FACT_TOKENS.some((token) => text.includes(token))) consumers.push(file);
    }
    expect(consumers.sort()).toEqual(EXPECTED_CONSUMERS);
  });

  it("OneDrive 客户端在五个瀑布失败点各自挂 tier，重试计数落到错误上", () => {
    const client = readSourceFile("src/onedrive/client.ts");
    for (const tier of [
      "content",
      "downloadUrl",
      "itemMetadata",
      "pathContent",
      "itemContent",
    ]) {
      expect(client, `缺 ${tier} 层的 tier 标记`).toContain(
        `stampDownloadTier(caught, "${tier}")`,
      );
    }
    expect(client).toContain("throw stampDownloadAttempts(err, attempt);");
    // downloadErrorData 把两者读出来，进每层自己的诊断日志行。
    expect(client).toContain("data.tier = tier;");
    expect(client).toContain("data.attempts = attempts;");
  });
});

describe("OneDrive 客户端：瀑布最后一层失败时错误对象带着 tier", () => {
  afterEach(() => vi.restoreAllMocks());

  it("item /content 也失败时，抛出的错误带 tier=itemContent", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation((request) => {
      const url = String((request as { url?: string }).url ?? "");
      const response = url.includes("/me/drive/items/item-big?")
        ? {
          status: 200,
          headers: {},
          json: { id: "item-big", name: "big.m4a", size: 3, file: {} },
        }
        : {
          status: 404,
          headers: {},
          json: { error: { code: "itemNotFound", message: "gone" } },
        };
      return Promise.resolve(response) as never;
    });
    const client = new OneDriveClient(async () => "token");

    const failure = await client
      .downloadFile("testVault", "big.m4a", undefined, "item-big", 3)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OneDriveError);
    expect(failure).toMatchObject({
      type: OneDriveErrorType.NotFound,
      statusCode: 404,
      graphCode: "itemNotFound",
    });
    // 证据只挂在错误对象上：类型与状态码的既有分类不变。
    expect((failure as unknown as { tier?: string }).tier).toBe("itemContent");
  });
});

/** 列出 `src/` 下的全部 TypeScript 源文件（仓库根相对路径，正斜杠）。 */
function listSourceFiles(directory: string): string[] {
  const root = process.cwd();
  const collected: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const next = join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(next);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        collected.push(relative(root, next).replace(/\\/g, "/"));
      }
    }
  };
  walk(join(root, directory));
  return collected;
}
