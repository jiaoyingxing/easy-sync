/**
 * W2b2a：已激活 mock V2 状态下的 WebDAV 文件级最小闭环。
 *
 * 覆盖设计 §13.3／§13.8：
 * A. 首轮上传（空远端）→ uploaded 1、远端字节正确、无删除／改名／移动；
 *    坚果云画像下走 staged-MOVE；
 * B. 次轮零计划（uploaded／downloaded／deleted 0、`userFileChanges="none"`、
 *    `onFileComplete` 零次）；
 * C. 远端已有、本地为空 → downloaded 1、本地字节正确，次轮零计划；
 * D. WebDAV full scope 持久化（envelope.scope 含 S0 provider 字段，提交不因
 *    scope 不等抛错）；
 * E. 根缺失 fail-closed：轮次失败、无删除计划、未持久化空远端。
 *
 * 全部 fake：不碰真实账号、不制造大文件／750 项。
 */
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import { WebDavRootMissingError } from "../src/providers/webdav/webdav-client";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import type { BaseFileEntry, RemoteFileEntry } from "../src/sync/types";
import { sameSyncScope } from "../src/sync/types";
import { installWebDavProbeFixture } from "./helpers/webdav-probe-fixture";
import {
  createWebDavSyncExecutorHarness,
  NUTSTORE_PROFILES,
} from "./helpers/webdav-sync-executor-harness";
import {
  buildWebDavSyncScope,
  legacyWebDavScopeFieldsToSyncScope,
} from "./helpers/webdav-sync-scope";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = "https://webdav.test/vault";
const NOTE_TEXT = "hello webdav\n";

async function remoteNote(
  path = "note.md",
  text = NOTE_TEXT,
): Promise<RemoteFileEntry> {
  const buffer = new TextEncoder().encode(text).buffer;
  return {
    path,
    driveId: path,
    parentId: "/",
    size: buffer.byteLength,
    mtime: 1,
    eTag: `"etag-${path}"`,
    cTag: `"etag-${path}"`,
    sha256Hash: await sha256Hex(buffer),
  };
}

async function baseNote(path = "note.md", text = NOTE_TEXT): Promise<BaseFileEntry> {
  const buffer = new TextEncoder().encode(text).buffer;
  return {
    path,
    size: buffer.byteLength,
    mtime: 1,
    hash: await sha256Hex(buffer),
    binary: false,
  };
}

function requestsTo(path: string, method?: string) {
  return fixture.fake.requests.filter(
    (request) =>
      request.decodedPath === path
      && (method === undefined || request.method === method),
  );
}

/** 记录引擎错误事件的诊断替身；消息与 detail 都保留为可查文本。 */
function recordingDiag(): { diag: DiagnosticLogger; errors: string[] } {
  const errors: string[] = [];
  const diag = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((
      _category: string,
      message: string,
      detail?: unknown,
    ) => {
      errors.push(
        `${message} ${detail === undefined ? "" : String(detail)}`.trim(),
      );
    }),
    isEnabled: vi.fn(() => true),
  } as unknown as DiagnosticLogger;
  return { diag, errors };
}

describe("WebDAV 引擎最小闭环 A：首轮上传", () => {
  it("空远端上传 note.md：uploaded 1、字节正确、无删除／改名／移动、scope 提交成功", async () => {
    const harness = await createWebDavSyncExecutorHarness({
      fake: fixture.fake,
      transport: fixture.transport,
      endpoint,
      profiles: NUTSTORE_PROFILES,
      localFiles: { "note.md": NOTE_TEXT },
      baseEntries: [],
    });
    fixture.fake.requests.length = 0;

    const result = await harness.runRound("manual");
    await harness.settle();

    expect(result.uploaded).toBe(1);
    expect(result.downloaded).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.filesMoved ?? 0).toBe(0);
    expect(result.errors).toBe(0);
    expect(fixture.fake.readText("/vault/note.md")).toBe(NOTE_TEXT);
    expect(harness.setRemoteStateCalls.length).toBeGreaterThan(0);
    expect(harness.setRemoteStateCalls.at(-1)?.scope).toEqual(harness.scope);

    const noteCounts = fixture.fake.mutationCounts("/vault/note.md");
    expect(noteCounts.delete).toBe(0);
    expect(noteCounts.move).toBe(0);
    expect(requestsTo("/vault/note.md", "DELETE")).toHaveLength(0);
    // 用户内容的 MOVE 只允许是「临时名 → note.md」；源不能是 note.md。
    expect(
      fixture.fake.requests.filter(
        (request) =>
          request.method === "MOVE"
          && request.decodedPath === "/vault/note.md",
      ),
    ).toHaveLength(0);

    // 坚果云画像：conditionalCreate=false，新建走 staged-MOVE。
    expect(harness.client.capabilities?.conditionalCreate).toBe(false);
    expect(harness.client.capabilities?.serverSideMove).toBe(true);
    const stagedMove = fixture.fake.requests.filter(
      (request) =>
        request.method === "MOVE"
        && request.destination !== null
        && new URL(request.destination).pathname === "/vault/note.md",
    );
    expect(stagedMove).toHaveLength(1);
    expect(stagedMove[0]?.decodedPath).toMatch(/^\/vault\/\.easy-sync\/tmp\/create-/);
  });
});

describe("WebDAV 引擎最小闭环 B：次轮零计划", () => {
  it("上传收口后第二轮零计划，onFileComplete 不再触发", async () => {
    const harness = await createWebDavSyncExecutorHarness({
      fake: fixture.fake,
      transport: fixture.transport,
      endpoint,
      profiles: NUTSTORE_PROFILES,
      localFiles: { "note.md": NOTE_TEXT },
      baseEntries: [],
    });
    const first = await harness.runRound("manual");
    await harness.settle();
    expect(first.uploaded).toBe(1);
    const completionsAfterFirst = harness.fileCompleteCalls.length;
    expect(completionsAfterFirst).toBeGreaterThan(0);

    const second = await harness.runRound("manual");
    await harness.settle();

    expect(second.uploaded).toBe(0);
    expect(second.downloaded).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.runFacts?.userFileChanges).toBe("none");
    expect(harness.fileCompleteCalls).toHaveLength(completionsAfterFirst);
  });
});

describe("WebDAV 引擎最小闭环 C：远端下载", () => {
  it("远端 note.md、本地为空：downloaded 1、本地字节正确，次轮零计划", async () => {
    const remote = await remoteNote();
    const harness = await createWebDavSyncExecutorHarness({
      fake: fixture.fake,
      transport: fixture.transport,
      endpoint,
      profiles: ["strict"],
      remoteFiles: { "note.md": NOTE_TEXT },
      remoteEntries: [remote],
      baseEntries: [],
    });

    const first = await harness.runRound("manual");
    await harness.settle();

    expect(first.downloaded).toBe(1);
    expect(first.uploaded).toBe(0);
    expect(first.errors).toBe(0);
    expect(harness.readLocalText("note.md")).toBe(NOTE_TEXT);
    expect(harness.setRemoteStateCalls.length).toBeGreaterThan(0);

    const completionsAfterFirst = harness.fileCompleteCalls.length;
    const second = await harness.runRound("manual");
    await harness.settle();

    expect(second.uploaded).toBe(0);
    expect(second.downloaded).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.runFacts?.userFileChanges).toBe("none");
    expect(harness.fileCompleteCalls).toHaveLength(completionsAfterFirst);
  });
});

describe("WebDAV 引擎最小闭环 D：full scope 持久化", () => {
  it("envelope.scope 保留 provider 字段，提交不因 scope 不等抛错", async () => {
    const harness = await createWebDavSyncExecutorHarness({
      fake: fixture.fake,
      transport: fixture.transport,
      endpoint,
      localFiles: { "note.md": NOTE_TEXT },
      baseEntries: [],
    });

    const result = await harness.runRound("manual");
    await harness.settle();
    expect(result.uploaded).toBe(1);
    expect(result.errors).toBe(0);

    const envelope = harness.state.getCommittedV2Envelope();
    expect(envelope).not.toBeNull();
    expect(envelope!.scope).toMatchObject({
      providerKind: "webdav",
      accountId: harness.scope.credentialBindingId,
      driveId: harness.scope.endpointId,
      vaultFolderId: "/",
      filesRootId: "/",
      endpointId: harness.scope.endpointId,
      containerId: "",
      rootPath: "/vault",
      credentialBindingId: harness.scope.credentialBindingId,
    });
    expect(sameSyncScope(envelope!.scope, harness.scope)).toBe(true);
    expect(
      harness.setRemoteStateCalls.every((call) =>
        sameSyncScope(call.scope, harness.scope)),
    ).toBe(true);
  });

  it("旧映射（vaultFolderId=filesRootId=rootPath）与修正后的四元确实不同", async () => {
    const scoped = await buildWebDavSyncScope({
      endpoint,
      username: "probe",
    });
    const legacy = legacyWebDavScopeFieldsToSyncScope(scoped.fields);
    expect(legacy.filesRootId).toBe("/vault");
    expect(scoped.scope.filesRootId).toBe("/");
    expect(legacy.vaultFolderId).toBe("/vault");
    expect(scoped.scope.vaultFolderId).toBe("/");
    expect(scoped.scope.rootPath).toBe("/vault");
    expect(sameSyncScope(legacy, scoped.scope)).toBe(false);
  });
});

describe("WebDAV 引擎最小闭环 E：根缺失 fail-closed", () => {
  it("启动时根不存在：轮次失败，不提交空远端", async () => {
    const remote = await remoteNote();
    const base = await baseNote();
    const { diag, errors } = recordingDiag();
    const harness = await createWebDavSyncExecutorHarness({
      fake: fixture.fake,
      transport: fixture.transport,
      endpoint,
      localFiles: { "note.md": NOTE_TEXT },
      remoteEntries: [remote],
      baseEntries: [base],
      diag,
    });
    expect((await fixture.raw("DELETE", "/vault")).status).toBe(204);
    fixture.fake.requests.length = 0;

    let result: Awaited<ReturnType<typeof harness.runRound>> | null;
    try {
      result = await harness.runRound("manual");
    } catch (error) {
      // The engine may surface the failure either way; both are fail-closed.
      expect(error).toBeInstanceOf(WebDavRootMissingError);
      result = null;
    }

    if (result) {
      expect(result.success).toBe(false);
      expect(result.errors).toBeGreaterThan(0);
    }
    expect(errors.some((line) => line.includes("root collection does not exist")))
      .toBe(true);
    expect(harness.setRemoteStateCalls).toHaveLength(0);
    expect(harness.state.remoteSnapshot).toHaveLength(1);
    expect(harness.fileCompleteCalls).toHaveLength(0);
  });

  it("恢复 scope 后根消失：getDelta 传播根缺失，不把空当事实持久化", async () => {
    const remote = await remoteNote();
    const base = await baseNote();
    const { diag, errors } = recordingDiag();
    const harness = await createWebDavSyncExecutorHarness({
      fake: fixture.fake,
      transport: fixture.transport,
      endpoint,
      localFiles: { "note.md": NOTE_TEXT },
      remoteEntries: [remote],
      baseEntries: [base],
      diag,
    });
    let deletedStatus = 0;
    harness.beforeGetDelta = async () => {
      harness.beforeGetDelta = null;
      deletedStatus = (await fixture.raw("DELETE", "/vault")).status;
    };
    fixture.fake.requests.length = 0;

    let result: Awaited<ReturnType<typeof harness.runRound>> | null;
    try {
      result = await harness.runRound("manual");
    } catch (error) {
      expect(error).toBeInstanceOf(WebDavRootMissingError);
      result = null;
    }

    expect(deletedStatus).toBe(204);
    if (result) {
      expect(result.success).toBe(false);
      expect(result.errors).toBeGreaterThan(0);
    }
    expect(errors.some((line) => line.includes("root collection does not exist")))
      .toBe(true);
    expect(harness.setRemoteStateCalls).toHaveLength(0);
    expect(harness.state.remoteSnapshot).toHaveLength(1);
    expect(harness.fileCompleteCalls).toHaveLength(0);
    // 没有任何用户文件的删除请求。
    expect(
      fixture.fake.requests.filter(
        (request) =>
          request.method === "DELETE"
          && request.decodedPath === "/vault/note.md",
      ),
    ).toHaveLength(0);
  });
});
