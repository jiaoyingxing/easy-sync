/**
 * W2b2a：把真实 `WebDavProvider` 接进 `SyncExecutor` 的进程内测试台。
 *
 * 全部外部世界都是 fake：进程内 WebDAV（`FakeWebDavServer`）、内存本地
 * vault（`makeDownloadLocalStore`）、`makeActiveV2State` 的 mock V2 状态。
 * 不访问真实账号，不制造大文件或 750 项列表。
 *
 * `setRemoteState` 被包了一层与生产 `replaceRemoteStateEnvelopeV2` 同形的
 * scope 相等检查：mock 状态本身不会拒绝 scope 不等，但引擎必须提交与已提交
 * envelope 完全相同的 scope（含 S0 provider 字段）。这层检查让「引擎丢字段」
 * 以生产同款错误暴露，而不是被宽松的 mock 吞掉。
 */
import { vi } from "vitest";
import { sha256Hex } from "../../src/crypto";
import type { WebDavTransport } from "../../src/providers/webdav/webdav-probe";
import { WebDavClient } from "../../src/providers/webdav/webdav-client";
import { WebDavProvider } from "../../src/providers/webdav/webdav-provider";
import { SyncExecutor } from "../../src/sync/sync-executor";
import type { SyncCallbacks, SyncMode, SyncResult } from "../../src/sync/sync-executor";
import type { LocalScanner } from "../../src/sync/local-scanner";
import type { DiagnosticLogger } from "../../src/sync/diagnostic-logger";
import type {
  BaseFileEntry,
  LocalFileEntry,
  LocalFolderEntry,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncScope,
} from "../../src/sync/types";
import { sameSyncScope } from "../../src/sync/types";
import type { FakeWebDavProfile, FakeWebDavServer } from "./fake-webdav";
import {
  makeActiveV2State,
  makeDownloadLocalStore,
} from "./sync-safety-harness";
import { buildWebDavSyncScope } from "./webdav-sync-scope";

export const WEBDAV_SYNC_TEST_USERNAME = "probe";
export const WEBDAV_SYNC_TEST_PASSWORD = "app-password";

/** 坚果云 L2 画像（与 provider 测试同一套）。 */
export const NUTSTORE_PROFILES: readonly FakeWebDavProfile[] = [
  "ignore-if-none-match",
  "ignore-delete-if-match",
  "move-conflict-on-overwrite",
  "depth-infinity-as-one",
  "no-head-length",
  "mkcol-existing-201",
];

export interface WebDavSyncExecutorHarnessOptions {
  readonly fake: FakeWebDavServer;
  readonly transport: WebDavTransport;
  /** 含根集合路径的 HTTPS endpoint，例如 `https://webdav.test/vault`。 */
  readonly endpoint: string;
  readonly vaultName?: string;
  readonly profiles?: readonly FakeWebDavProfile[];
  /** vault 相对路径 → UTF-8 文本；在 provider 初始化前写入 fake 远端。 */
  readonly remoteFiles?: Readonly<Record<string, string>>;
  /** vault 相对路径 → UTF-8 文本；写入内存本地 vault。 */
  readonly localFiles?: Readonly<Record<string, string>>;
  /** 已提交 envelope 的远端文件条目（可选）。 */
  readonly remoteEntries?: readonly RemoteFileEntry[];
  /** 已提交 envelope 的远端文件夹条目（可选）。 */
  readonly remoteFolders?: readonly RemoteFolderEntry[];
  /** 已提交基线（可选）；不传时按 `localFiles` 生成。 */
  readonly baseEntries?: readonly BaseFileEntry[];
  /** 额外的状态覆盖（透传给 `makeActiveV2State`）。 */
  readonly stateOverrides?: Record<string, unknown>;
  /** 可选诊断记录器；根缺失用例用它证明具体失败原因。 */
  readonly diag?: DiagnosticLogger;
}

export interface ProviderCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface SetRemoteStateCall {
  readonly entries: readonly RemoteFileEntry[];
  readonly deltaLink: string | null;
  readonly scope: SyncScope;
  readonly folders: readonly RemoteFolderEntry[];
}

const INSTRUMENTED_PROVIDER_METHODS = [
  "initVaultScope",
  "restoreVaultScopeByIdentity",
  "getDelta",
  "fullScan",
  "getFileMetadata",
  "uploadFile",
  "downloadFile",
  "downloadFileToPath",
  "readCloudBootstrapV2",
  "createCloudBootstrapV2",
  "updateCloudBootstrapV2",
] as const;

export interface WebDavSyncExecutorHarness {
  readonly fake: FakeWebDavServer;
  readonly client: WebDavClient;
  readonly provider: WebDavProvider;
  readonly executor: SyncExecutor;
  readonly state: ReturnType<typeof makeActiveV2State>;
  readonly scope: SyncScope;
  /** 本地 vault 的当前字节（下载落位后可直接读）。 */
  readonly files: Map<string, ArrayBuffer>;
  readonly providerCalls: ProviderCall[];
  readonly setRemoteStateCalls: SetRemoteStateCall[];
  readonly fileCompleteCalls: Array<{
    readonly path: string;
    readonly actionType: unknown;
    readonly success: boolean;
  }>;
  /** 在每次 `provider.getDelta` 真正执行前触发（根缺失竞态用）。 */
  beforeGetDelta: (() => Promise<void> | void) | null;
  runRound(mode?: SyncMode, callbacks?: SyncCallbacks): Promise<SyncResult>;
  /** 等待轮后后台任务（cloud bootstrap 发布等）收口。 */
  settle(): Promise<void>;
  readLocalText(path: string): string | null;
  setProfile(profiles: readonly FakeWebDavProfile[]): void;
}

function textBytes(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function localFoldersOf(paths: Iterable<string>): LocalFolderEntry[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      if (segment.length === 0) continue;
      current = current.length === 0 ? segment : `${current}/${segment}`;
      folders.add(current);
    }
  }
  return [...folders].sort().map((path) => ({ path }));
}

export async function createWebDavSyncExecutorHarness(
  options: WebDavSyncExecutorHarnessOptions,
): Promise<WebDavSyncExecutorHarness> {
  const vaultName = options.vaultName ?? "testVault";
  options.fake.setProfiles(options.profiles ?? ["strict"]);
  const rootPath = options.fake.rootPath;
  for (const [path, content] of Object.entries(options.remoteFiles ?? {})) {
    options.fake.seedFile(
      `${rootPath === "/" ? "" : rootPath}/${path}`,
      content,
    );
  }

  const scoped = await buildWebDavSyncScope({
    endpoint: options.endpoint,
    username: WEBDAV_SYNC_TEST_USERNAME,
  });
  const client = new WebDavClient({
    endpoint: options.endpoint,
    credentials: {
      username: WEBDAV_SYNC_TEST_USERNAME,
      password: WEBDAV_SYNC_TEST_PASSWORD,
    },
    transport: options.transport,
  });
  await client.initialize();
  const provider = new WebDavProvider({
    client,
    driveId: scoped.fields.endpointId,
  });

  const local = makeDownloadLocalStore();
  for (const [path, content] of Object.entries(options.localFiles ?? {})) {
    await local.adapter.writeBinary(path, textBytes(content));
  }

  const scanAll = vi.fn(async () => {
    const entries: LocalFileEntry[] = [];
    for (const [path, content] of [...local.files.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      entries.push({
        path,
        size: content.byteLength,
        mtime: 1,
        hash: await sha256Hex(content),
        binary: true,
      });
    }
    return {
      entries,
      folders: localFoldersOf(local.files.keys()),
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
    };
  });

  const scanner = {
    vault: {
      adapter: local.adapter,
      configDir: ".obsidian",
      getFiles: vi.fn(() => []),
      getName: vi.fn(() => vaultName),
    },
    scanAll,
    scanFile: vi.fn(async () => null),
    inspectFile: local.inspectFile,
    shouldSyncFolderPath: vi.fn(() => true),
    getMaxFileSize: vi.fn(() => 500 * 1024 * 1024),
  } as unknown as LocalScanner;

  const state = makeActiveV2State(
    [...(options.remoteEntries ?? [])],
    [...(options.baseEntries ?? [])],
    {
      ...options.stateOverrides,
      ...(options.remoteFolders ? { remoteFolders: options.remoteFolders } : {}),
    },
    scoped.scope,
  );

  // Production fidelity: the committed envelope scope is the only acceptable
  // target scope for a remote-state checkpoint.
  const rawSetRemoteState = state.setRemoteState.bind(state);
  const setRemoteStateCalls: SetRemoteStateCall[] = [];
  state.setRemoteState = vi.fn(async (
    entries: RemoteFileEntry[],
    deltaLink: string | null,
    scope: SyncScope,
    folders: RemoteFolderEntry[] = [],
  ) => {
    const committed = state.getCommittedV2Envelope();
    if (committed && !sameSyncScope(committed.scope, scope)) {
      throw new Error(
        "V2 remote state scope does not match the committed envelope",
      );
    }
    setRemoteStateCalls.push({
      entries: entries.map((entry) => ({ ...entry })),
      deltaLink,
      scope: { ...scope },
      folders: folders.map((entry) => ({ ...entry })),
    });
    return rawSetRemoteState(entries, deltaLink, scope, folders);
  });

  const providerCalls: ProviderCall[] = [];
  const harnessRef: {
    beforeGetDelta: (() => Promise<void> | void) | null;
  } = { beforeGetDelta: null };
  for (const method of INSTRUMENTED_PROVIDER_METHODS) {
    const target = provider as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const original = target[method].bind(provider);
    target[method] = async (...args: unknown[]) => {
      providerCalls.push({ method, args });
      if (method === "getDelta" && harnessRef.beforeGetDelta) {
        await harnessRef.beforeGetDelta();
      }
      return await original(...args);
    };
  }

  const executor = new SyncExecutor(
    provider,
    scanner,
    state,
    vaultName,
    undefined,
    undefined,
    options.diag,
  );

  const fileCompleteCalls: Array<{
    path: string;
    actionType: unknown;
    success: boolean;
  }> = [];

  const harness: WebDavSyncExecutorHarness = {
    fake: options.fake,
    client,
    provider,
    executor,
    state,
    scope: scoped.scope,
    files: local.files,
    providerCalls,
    setRemoteStateCalls,
    fileCompleteCalls,
    get beforeGetDelta() {
      return harnessRef.beforeGetDelta;
    },
    set beforeGetDelta(hook) {
      harnessRef.beforeGetDelta = hook;
    },
    async runRound(mode: SyncMode = "manual", callbacks: SyncCallbacks = {}) {
      return await executor.run(mode, {
        onFileComplete: (path, actionType, success) => {
          fileCompleteCalls.push({ path, actionType, success });
        },
        ...callbacks,
      });
    },
    async settle() {
      await executor.settleBackgroundTasks();
    },
    readLocalText(path: string) {
      const content = local.files.get(path);
      return content ? new TextDecoder().decode(new Uint8Array(content)) : null;
    },
    setProfile(profiles: readonly FakeWebDavProfile[]) {
      options.fake.setProfiles(profiles);
    },
  };
  return harness;
}
