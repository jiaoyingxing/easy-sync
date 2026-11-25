/**
 * W2b2b2：真实 `StateManager` ＋ 真实 `WebDavProvider` ＋ fake WebDAV 的
 * 冷启动首同步测试台。
 *
 * 与 W2b2a 的 `webdav-sync-executor-harness` 不同，这里不伪造 V2 状态：
 * - 本地状态是真实 `StateManager`（plugin data store／DataAdapter／
 *   fake-indexeddb，取自 state-v2-activation harness 的夹具形状）；
 * - 每轮协议门、迁移 hold、authority 提交、V3 binding、重启都是生产代码；
 * - 远端全部是进程内 fake WebDAV（`FakeWebDavServer`），能力画像可参数化
 *   （strict／坚果云 L2 组合／weak-etag）。
 *
 * 不接 `src/main.ts`／设置 UI／真实账号；用户文件与协议对象都只在 fake 上。
 */
import "fake-indexeddb/auto";

import { vi } from "vitest";
import { TFile, TFolder, type DataAdapter } from "obsidian";
import { sha256Hex } from "../../src/crypto";
import { getEasySyncPaths } from "../../src/obsidian-compat";
import type { LocalScanner } from "../../src/sync/local-scanner";
import { StateManager, type PluginDataStore } from "../../src/sync/state-manager";
import {
  SyncExecutor,
  type SyncCallbacks,
  type SyncMode,
  type SyncResult,
  type SyncRunOptions,
} from "../../src/sync/sync-executor";
import type {
  LocalFileEntry,
  LocalFolderEntry,
  PlanReviewAuthorization,
  SyncScope,
} from "../../src/sync/types";
import {
  buildWebDavScopeFields,
  webDavScopeFieldsToSyncScope,
  WEBDAV_CONTROL_DIRECTORY,
  WEBDAV_SCOPE_MARKER_FILE,
  type WebDavScopeFields,
} from "../../src/providers/webdav/webdav-scope";
import { WebDavClient } from "../../src/providers/webdav/webdav-client";
import { WebDavProvider } from "../../src/providers/webdav/webdav-provider";
import type { WebDavTransport } from "../../src/providers/webdav/webdav-probe";
import {
  createLoopbackWebDavTransport,
  FakeWebDavServer,
  type FakeWebDavProfile,
} from "./fake-webdav";
import { WEBDAV_SHARED_PROTOCOL_V2_PATH, WEBDAV_SHARED_PROTOCOL_V3_PATH } from "../../src/providers/webdav/webdav-protocol";
import { IndexedDbRemoteScopeRecoveryEvidenceStore } from "../../src/sync/remote-scope-recovery-evidence-store";

export const WEBDAV_COLD_START_ENDPOINT = "https://webdav.test/vault";
export const WEBDAV_COLD_START_USERNAME = "probe";
export const WEBDAV_COLD_START_PASSWORD = "app-password";
export const WEBDAV_COLD_START_ROOT_PATH = "/vault";
export const WEBDAV_COLD_START_VAULT_NAME = "testVault";
export const WEBDAV_COLD_START_USER_PATH = "note.md";
export const WEBDAV_COLD_START_USER_TEXT = "hello webdav cold start\n";

export const WEBDAV_COLD_START_PATHS = getEasySyncPaths(".obsidian");

const INSTRUMENTED_PROVIDER_METHODS = [
  "initVaultScope",
  "restoreVaultScopeByIdentity",
  "getDelta",
  "fullScan",
  "getFileMetadata",
  "getDriveItemMetadata",
  "getDriveItemMetadataById",
  "uploadFile",
  "downloadFile",
  "downloadFileToPath",
  "readSharedSyncProtocolObjects",
  "readSharedSyncProtocolV2ById",
  "createSharedSyncProtocolV2",
  "overwriteSharedSyncProtocolV2",
  "readSharedSyncProtocolV3ById",
  "createSharedSyncProtocolV3",
  "readCloudBootstrapV2",
  "createCloudBootstrapV2",
  "updateCloudBootstrapV2",
] as const;

export interface ProviderCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface WebDavColdStartHarnessOptions {
  /** 复用已启动的 fake；省略时由本夹具创建并在 dispose() 停止。 */
  readonly server?: FakeWebDavServer;
  /** 复用 fake 时必须给出 loopback 端口（直接控制远端测试用）。 */
  readonly port?: number;
  /** 内部：restart() 链上继承 fake 所有权，使最后一个会话负责停止 fake。 */
  readonly ownsServer?: boolean;
  readonly transport?: WebDavTransport;
  /** 含根集合路径的 HTTPS endpoint；默认 `https://webdav.test/vault`。 */
  readonly endpoint?: string;
  /** 覆盖根集合；默认取 endpoint 的 pathname。 */
  readonly rootPath?: string;
  readonly profiles?: readonly FakeWebDavProfile[];
  readonly vaultName?: string;
  /** vault 相对路径 → UTF-8 文本；默认 `{ "note.md": ... }`。 */
  readonly localFiles?: Readonly<Record<string, string>>;
  readonly localFolders?: readonly string[];
  readonly pluginData?: Record<string, unknown>;
  readonly indexedDbVaultInstanceId?: string;
  /** 传给 `SyncExecutor` 的首同步 provider scope；缺省用本夹具推导的 full
   *  scope。负向用例可传不匹配的 scope 证明引擎不会合并。 */
  readonly executorProviderScope?: SyncScope;
  /**
   * 本机是否已确认远端身份账本（W2b-2）。
   *
   * 缺省 `true`：夹具直接构造 provider，等价于「运行时的重建待确认标记不在位」
   * ——绝大多数用例（首同步、删除、改名、重启）都建立在这个基线上。传
   * `false` 等价于「账本刚重建、还没见过一次成功同步」，用于钉住身份闸门。
   */
  readonly identityLedgerConfirmed?: boolean;
  readonly diag?: {
    log?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    isEnabled?: (category: string) => boolean;
  };
}

interface LocalState {
  files: Map<string, string>;
  entries: LocalFileEntry[];
  folders: Set<string>;
}

export interface WebDavColdStartHarness {
  readonly fake: FakeWebDavServer;
  readonly port: number;
  readonly transport: WebDavTransport;
  readonly endpoint: string;
  readonly vaultName: string;
  readonly client: WebDavClient;
  readonly provider: WebDavProvider;
  readonly state: StateManager;
  readonly executor: SyncExecutor;
  readonly scopeFields: WebDavScopeFields;
  /** 生产映射的 WebDAV full scope（含 S0 provider 字段）。 */
  readonly scope: ReturnType<typeof webDavScopeFieldsToSyncScope>;
  readonly files: Map<string, string>;
  readonly localEntryState: LocalFileEntry[];
  readonly localFolderPaths: Set<string>;
  readonly pluginData: Record<string, unknown>;
  readonly plugin: PluginDataStore;
  readonly providerCalls: ProviderCall[];
  readonly diagErrors: string[];
  /** 远端控制对象在 fake 上的绝对路径。 */
  readonly protocolPaths: {
    readonly v2: string;
    readonly v3: string;
    readonly controlDirectory: string;
    readonly scopeMarker: string;
  };
  runRound(
    mode?: SyncMode,
    callbacks?: SyncCallbacks,
    skipConfirmation?: boolean,
    reviewedAuthorization?: PlanReviewAuthorization,
    options?: SyncRunOptions,
  ): Promise<SyncResult>;
  /**
   * 生产确认轮形状（`src/main.ts` plan review）：skipConfirmation=true、
   * 带 hold 的 authorization、`{ acknowledgeMigrationRisk: true }`。
   * 它只是迁移风险确认，不是「所有设备已更新」的证据。
   */
  confirmRound(
    authorization?: PlanReviewAuthorization,
    options?: SyncRunOptions,
  ): Promise<SyncResult>;
  /** 在同一个 fake 远端与同一份本地数据上重建 client/provider/StateManager。 */
  restart(): Promise<WebDavColdStartHarness>;
  /** 关闭 StateManager；不影响 fake 与本地数据，供重启或收尾使用。 */
  closeState(): Promise<void>;
  /** 停止本夹具自建的 fake（复用外部 server 时为空操作）。 */
  dispose(): Promise<void>;
  protocolCallCounts(): {
    readonly observe: number;
    readonly createV2: number;
    readonly createV3: number;
    readonly overwriteV2: number;
  };
  remoteBytes(path: string): ArrayBuffer | null;
  remoteText(path: string): string | null;
  remoteSnapshot(path: string): ReturnType<FakeWebDavServer["getResource"]>;
  /** 模拟另一设备直接 DELETE 远端对象（走 fake 的真实 HTTP 语义）。 */
  deleteRemote(path: string): Promise<number>;
  /** 模拟另一设备覆盖远端对象；可带 If-Match。 */
  putRemote(
    path: string,
    text: string,
    options?: { ifMatch?: string },
  ): Promise<number>;
  /** 远端改名/移动（绕过引擎，模拟另一台设备在云端操作）。 */
  moveRemote(from: string, to: string): Promise<number>;
  /** 本地改名（不经过 vault 事件；下一轮扫描按新路径看到同一内容）。 */
  renameLocal(from: string, to: string): void;
  /** 本地删除文件（不经过 vault 事件；下一轮扫描看不到该条目）。 */
  deleteLocal(path: string): void;
  /** 本地文件夹改名（连同子文件夹与文件路径一起迁移）。 */
  renameLocalFolder(from: string, to: string): void;
  resetProviderCalls(): void;
}

function textBytes(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/** 与 activation harness 同形的本地 adapter／vault 夹具（只保留本切片用到的面）。 */
function createLocalState(options: WebDavColdStartHarnessOptions): {
  local: LocalState;
  adapter: DataAdapter;
  scanner: LocalScanner;
  fileManager: { trashFile: (file: TFile | TFolder) => Promise<void> };
} {
  const files = new Map<string, string>(
    Object.entries(options.localFiles ?? {
      [WEBDAV_COLD_START_USER_PATH]: WEBDAV_COLD_START_USER_TEXT,
    }),
  );
  const local: LocalState = {
    files,
    entries: [],
    folders: new Set(options.localFolders ?? []),
  };
  for (const [path, text] of [...files].sort(([left], [right]) =>
    left.localeCompare(right))) {
    // `.obsidian/**` 是宿主/插件状态，不属于用户扫描条目（生产
    // LocalScanner 默认排除整个配置目录）。
    if (path === ".obsidian" || path.startsWith(".obsidian/")) continue;
    const bytes = new TextEncoder().encode(text);
    local.entries.push({
      path,
      size: bytes.byteLength,
      mtime: 1,
      hash: "", // 首次 scanAll 前由 refreshHashes 填。
      binary: false,
    });
  }
  for (const path of files.keys()) {
    let parent = parentPath(path);
    while (parent.length > 0) {
      local.folders.add(parent);
      parent = parentPath(parent);
    }
  }

  const rawAdapter = {
    exists: vi.fn(async (path: string) =>
      local.files.has(path) || local.folders.has(path)),
    read: vi.fn(async (path: string) => {
      const value = local.files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      local.files.set(path, value);
    }),
    process: vi.fn(async (
      path: string,
      fn: (value: string) => string,
    ) => {
      const value = local.files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      const next = fn(value);
      local.files.set(path, next);
      return next;
    }),
    remove: vi.fn(async (path: string) => {
      local.files.delete(path);
      const index = local.entries.findIndex((entry) => entry.path === path);
      if (index >= 0) local.entries.splice(index, 1);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = local.files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      local.files.delete(from);
      local.files.set(to, value);
      const entry = local.entries.find((candidate) => candidate.path === from);
      if (entry) entry.path = to;
    }),
    mkdir: vi.fn(async (path: string) => {
      local.folders.add(path);
    }),
    rmdir: vi.fn(async (path: string, recursive = false) => {
      if (recursive) {
        for (const file of [...local.files.keys()]) {
          if (file === path || file.startsWith(`${path}/`)) {
            local.files.delete(file);
          }
        }
        for (const folder of [...local.folders]) {
          if (folder === path || folder.startsWith(`${path}/`)) {
            local.folders.delete(folder);
          }
        }
        return;
      }
      local.folders.delete(path);
    }),
    stat: vi.fn(async (path: string) => local.folders.has(path)
      ? { type: "folder", ctime: 1, mtime: 1, size: 0 }
      : local.files.has(path)
        ? { type: "file", ctime: 1, mtime: 1, size: local.files.get(path)!.length }
        : null),
    list: vi.fn(async (path: string) => ({
      files: [...new Set([
        ...[...local.files.keys()].filter(
          (entry) => parentPath(entry) === path,
        ),
      ])],
      folders: [...local.folders]
        .filter((folder) => parentPath(folder) === path)
        .sort(),
    })),
    readBinary: vi.fn(async (path: string) =>
      new TextEncoder().encode(local.files.get(path) ?? "").buffer),
    writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
      const text = new TextDecoder().decode(new Uint8Array(value));
      local.files.set(path, text);
      const entry = local.entries.find((candidate) => candidate.path === path);
      const bytes = new Uint8Array(value);
      const next = {
        path,
        size: bytes.byteLength,
        mtime: (entry?.mtime ?? 0) + 1,
        hash: await sha256Hex(bytes),
        binary: false,
      };
      if (entry) Object.assign(entry, next);
      else local.entries.push(next);
    }),
  };
  const adapter = rawAdapter as unknown as DataAdapter;

  const scanner = {
    vault: {
      adapter,
      configDir: ".obsidian",
      getFiles: vi.fn().mockReturnValue([]),
      getAllLoadedFiles: vi.fn(() =>
        [...local.folders].map((path) => new TFolder(path))),
      getAbstractFileByPath: vi.fn((path: string) =>
        local.folders.has(path)
          ? new TFolder(path)
          : local.entries.some((entry) => entry.path === path)
            ? new TFile(path)
            : null),
      // 与 activation harness 同一路由：配置目录不在库索引，原子替换。
      getFileByPath: vi.fn((path: string) =>
        !path.startsWith(".obsidian/")
        && local.entries.some((entry) => entry.path === path)
          ? new TFile(path)
          : null),
      modify: vi.fn(async (file: TFile, data: string) => {
        local.files.set(file.path, data);
        const entry = local.entries.find(
          (candidate) => candidate.path === file.path,
        );
        const bytes = new TextEncoder().encode(data);
        const next = {
          path: file.path,
          size: bytes.byteLength,
          mtime: (entry?.mtime ?? 0) + 1,
          hash: await sha256Hex(bytes),
          binary: false,
        };
        if (entry) Object.assign(entry, next);
        else local.entries.push(next);
      }),
      createFolder: vi.fn(async (path: string) => {
        local.folders.add(path);
      }),
      rename: vi.fn(async (file: TFile | TFolder, targetPath: string) => {
        if (file instanceof TFolder) {
          for (const folder of [...local.folders]) {
            if (folder === file.path || folder.startsWith(`${file.path}/`)) {
              local.folders.delete(folder);
              local.folders.add(
                folder === file.path
                  ? targetPath
                  : `${targetPath}${folder.slice(file.path.length)}`,
              );
            }
          }
          return;
        }
        const value = local.files.get(file.path);
        if (value === undefined) throw new Error(`missing ${file.path}`);
        local.files.delete(file.path);
        local.files.set(targetPath, value);
        const entry = local.entries.find(
          (candidate) => candidate.path === file.path,
        );
        if (entry) entry.path = targetPath;
      }),
      getName: vi.fn(() => options.vaultName ?? WEBDAV_COLD_START_VAULT_NAME),
    },
    scanAll: vi.fn(async () => {
      for (const entry of local.entries) {
        if (entry.hash.length === 0) {
          entry.hash = await sha256Hex(
            new TextEncoder().encode(local.files.get(entry.path) ?? ""),
          );
        }
      }
      return {
        entries: local.entries.map((entry) => ({ ...entry })),
        // 生产 LocalScanner 默认把整个配置目录排除在同步范围外；测试台
        // 的 plugin-data／state 写入会给 adapter 带来 `.obsidian` 父目录，
        // 这里按同一口径剔除，避免把宿主内部目录当成用户文件夹。
        folders: [...local.folders]
          .filter((path) =>
            path !== ".obsidian"
            && !path.startsWith(".obsidian/"))
          .sort()
          .map((path) => ({ path })) as LocalFolderEntry[],
        folderScanComplete: true,
        folderScanFailures: [],
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      };
    }),
    scanFile: vi.fn().mockResolvedValue(null),
    inspectFile: vi.fn(async (path: string) => {
      const entry = local.entries.find((candidate) => candidate.path === path);
      if (!entry) return { status: "missing" as const };
      const bytes = new TextEncoder().encode(local.files.get(path) ?? "");
      return {
        status: "present" as const,
        entry: {
          ...entry,
          size: bytes.byteLength,
          hash: await sha256Hex(bytes),
        },
      };
    }),
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
  } as unknown as LocalScanner;

  const fileManager = {
    trashFile: vi.fn(async (file: TFile | TFolder) => {
      if (file instanceof TFolder) {
        local.folders.delete(file.path);
        return;
      }
      local.files.delete(file.path);
      const index = local.entries.findIndex((entry) => entry.path === file.path);
      if (index >= 0) local.entries.splice(index, 1);
    }),
  };

  return { local, adapter, scanner, fileManager };
}

/** 给 `restart()` 复用：同一份 fake／transport／本地数据，新 client 与状态。 */
interface SharedWorld {
  readonly fake: FakeWebDavServer;
  readonly transport: WebDavTransport;
  readonly endpoint: string;
  readonly vaultName: string;
  readonly scopeFields: WebDavScopeFields;
  readonly scope: ReturnType<typeof webDavScopeFieldsToSyncScope>;
  readonly local: LocalState;
  readonly adapter: DataAdapter;
  readonly scanner: LocalScanner;
  readonly fileManager: { trashFile: (file: TFile | TFolder) => Promise<void> };
  readonly pluginData: Record<string, unknown>;
  readonly plugin: PluginDataStore;
  readonly indexedDbVaultInstanceId: string;
}

let harnessVaultInstanceSequence = 0;

function createPlugin(
  shared: SharedWorld,
  indexedDbVaultInstanceId: string,
  diag?: WebDavColdStartHarnessOptions["diag"],
): PluginDataStore {
  const plugin: PluginDataStore = {
    loadData: vi.fn(async () => shared.pluginData),
    updatePluginData: vi.fn(async (mutator) => mutator(shared.pluginData)),
    app: {
      vault: {
        adapter: shared.adapter,
        configDir: ".obsidian",
        getName: () => shared.vaultName,
      },
    } as never,
    manifest: { id: "easy-sync", dir: WEBDAV_COLD_START_PATHS.pluginDir },
    indexedDbVaultInstanceId,
    createRemoteScopeRecoveryEvidenceStore: (vaultInstanceId) =>
      new IndexedDbRemoteScopeRecoveryEvidenceStore(vaultInstanceId),
    ...(diag ? { diag } : {}),
  };
  return plugin;
}

async function createSharedWorld(
  options: WebDavColdStartHarnessOptions,
  fake: FakeWebDavServer,
  transport: WebDavTransport,
  endpoint: string,
): Promise<SharedWorld> {
  const vaultName = options.vaultName ?? WEBDAV_COLD_START_VAULT_NAME;
  const scopeFields = await buildWebDavScopeFields({
    endpoint,
    rootPath: options.rootPath,
    username: WEBDAV_COLD_START_USERNAME,
  });
  const scope = webDavScopeFieldsToSyncScope(scopeFields);
  const localParts = createLocalState(options);
  const pluginData: Record<string, unknown> = {
    "easy-sync-base-snapshot": {},
    "easy-sync-bound-account": scope.accountId,
    "easy-sync-generation": 0,
    "easy-sync-last-sync-time": 0,
    ...options.pluginData,
  };
  const indexedDbVaultInstanceId = options.indexedDbVaultInstanceId
    ?? (++harnessVaultInstanceSequence).toString(16).padStart(32, "0");
  const shared: SharedWorld = {
    fake,
    transport,
    endpoint,
    vaultName,
    scopeFields,
    scope,
    local: localParts.local,
    adapter: localParts.adapter,
    scanner: localParts.scanner,
    fileManager: localParts.fileManager,
    pluginData,
    plugin: undefined as unknown as PluginDataStore,
    indexedDbVaultInstanceId,
  };
  (shared as { plugin: PluginDataStore }).plugin = createPlugin(
    shared,
    indexedDbVaultInstanceId,
    options.diag,
  );
  return shared;
}

async function openSession(
  shared: SharedWorld,
  options: WebDavColdStartHarnessOptions,
): Promise<{
  client: WebDavClient;
  provider: WebDavProvider;
  state: StateManager;
  executor: SyncExecutor;
  providerCalls: ProviderCall[];
  diagErrors: string[];
}> {
  const client = new WebDavClient({
    endpoint: shared.endpoint,
    credentials: {
      username: WEBDAV_COLD_START_USERNAME,
      password: WEBDAV_COLD_START_PASSWORD,
    },
    transport: shared.transport,
  });
  await client.initialize();
  const provider = new WebDavProvider({
    client,
    driveId: shared.scopeFields.endpointId,
  });
  // W2b-2：夹具充当运行时的替身。默认已确认（标记不在位）；传 false 时
  // 与「刚重建、待一次成功同步」同义，身份推断与自动删除必须保持关闭。
  provider.setIdentityLedgerTrust(options.identityLedgerConfirmed !== false);

  const providerCalls: ProviderCall[] = [];
  const target = provider as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const method of INSTRUMENTED_PROVIDER_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = async (...args: unknown[]) => {
      providerCalls.push({ method, args });
      return await original.apply(provider, args);
    };
  }

  const diagErrors: string[] = [];
  const diag = options.diag ?? {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      diagErrors.push(args.map((arg) =>
        typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
    }),
    isEnabled: vi.fn(() => true),
  };
  const state = new StateManager(shared.plugin);
  await state.load();
  const executor = new SyncExecutor(
    provider,
    shared.scanner,
    state,
    shared.vaultName,
    undefined,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    diag as any,
    shared.fileManager as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // W2b2b2：首同步 full scope 来源；不传时 OneDrive 保持四元旧行为。
    options.executorProviderScope ?? shared.scope,
  );
  return { client, provider, state, executor, providerCalls, diagErrors };
}

export async function createWebDavColdStartHarness(
  options: WebDavColdStartHarnessOptions = {},
): Promise<WebDavColdStartHarness> {
  let fake = options.server;
  let transport = options.transport;
  let port = options.port ?? 0;
  if (!fake) {
    fake = new FakeWebDavServer({
      rootPath: options.rootPath ?? WEBDAV_COLD_START_ROOT_PATH,
      username: WEBDAV_COLD_START_USERNAME,
      password: WEBDAV_COLD_START_PASSWORD,
    });
    const started = await fake.start();
    port = started.port;
    transport = createLoopbackWebDavTransport({ port });
  }
  if (!transport) throw new Error("WebDAV cold-start harness requires a transport");
  if (!(port > 0)) {
    throw new Error("WebDAV cold-start harness requires a loopback port");
  }
  fake.setProfiles(options.profiles ?? ["strict"]);
  const endpoint = options.endpoint ?? WEBDAV_COLD_START_ENDPOINT;
  const shared = await createSharedWorld(options, fake, transport, endpoint);
  const session = await openSession(shared, options);
  let sessionClosed = false;
  let restartedAway = false;
  const closeSession = async (): Promise<void> => {
    if (sessionClosed) return;
    sessionClosed = true;
    await session.state.close();
  };
  const rootPath = fake.rootPath;
  const absolute = (relative: string) =>
    `${rootPath === "/" ? "" : rootPath}/${relative}`;

  const authorizationHeader = `Basic ${Buffer.from(
    `${WEBDAV_COLD_START_USERNAME}:${WEBDAV_COLD_START_PASSWORD}`,
    "utf8",
  ).toString("base64")}`;
  const directRequest = async (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<number> => {
    const response = await fetch(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: { Authorization: authorizationHeader, ...headers },
        body,
      },
    );
    return response.status;
  };

  const harness: WebDavColdStartHarness = {
    fake,
    port,
    transport,
    endpoint,
    vaultName: shared.vaultName,
    client: session.client,
    provider: session.provider,
    state: session.state,
    executor: session.executor,
    scopeFields: shared.scopeFields,
    scope: shared.scope,
    files: shared.local.files,
    localEntryState: shared.local.entries,
    localFolderPaths: shared.local.folders,
    pluginData: shared.pluginData,
    plugin: shared.plugin,
    providerCalls: session.providerCalls,
    diagErrors: session.diagErrors,
    protocolPaths: {
      v2: absolute(WEBDAV_SHARED_PROTOCOL_V2_PATH),
      v3: absolute(WEBDAV_SHARED_PROTOCOL_V3_PATH),
      controlDirectory: absolute(WEBDAV_CONTROL_DIRECTORY),
      scopeMarker: absolute(`${WEBDAV_CONTROL_DIRECTORY}/${WEBDAV_SCOPE_MARKER_FILE}`),
    },
    async runRound(mode = "manual", callbacks = {}, skipConfirmation = false, reviewedAuthorization, runOptions = {}) {
      return await session.executor.run(
        mode,
        callbacks,
        skipConfirmation,
        reviewedAuthorization,
        runOptions,
      );
    },
    async confirmRound(authorization, runOptions = {}) {
      const authorizationToUse =
        authorization ?? session.state.planReviewAuthorization ?? undefined;
      return await session.executor.run(
        "manual",
        {},
        true,
        authorizationToUse,
        { acknowledgeMigrationRisk: true, ...runOptions },
      );
    },
    async restart() {
      await closeSession();
      restartedAway = true;
      // adapter 文件（含 `.obsidian/**` 状态 sidecar）必须全部交给新会话，
      // 否则重启后的 StateManager 读不到自己的权威状态；扫描条目会在
      // createLocalState 里按生产配置目录排除口径过滤。
      const next = await createWebDavColdStartHarness({
        ...options,
        server: fake,
        transport,
        endpoint,
        localFiles: Object.fromEntries(shared.local.files),
        localFolders: [...shared.local.folders],
        pluginData: shared.pluginData,
        port,
        // 同设备重启：IndexedDB 身份不能换，否则会看不到自己的持久权威。
        indexedDbVaultInstanceId: shared.indexedDbVaultInstanceId,
        // fake 所有权沿 restart 链传递；复用外部 fake 的会话不拥有它。
        ownsServer: options.ownsServer ?? !options.server,
      });
      return next;
    },
    async closeState() {
      await closeSession();
    },
    async dispose() {
      await closeSession();
      // 已被 restart 接管的旧会话不再拥有 fake；由新会话负责停止。
      if (!restartedAway && (options.ownsServer ?? !options.server)) {
        await fake.stop();
      }
    },
    protocolCallCounts() {
      const counts = {
        observe: 0,
        createV2: 0,
        createV3: 0,
        overwriteV2: 0,
      };
      for (const call of session.providerCalls) {
        if (call.method === "readSharedSyncProtocolObjects") counts.observe++;
        if (call.method === "createSharedSyncProtocolV2") counts.createV2++;
        if (call.method === "createSharedSyncProtocolV3") counts.createV3++;
        if (call.method === "overwriteSharedSyncProtocolV2") counts.overwriteV2++;
      }
      return counts;
    },
    remoteBytes(path) {
      const resource = fake.getResource(path);
      if (!resource || resource.kind !== "file") return null;
      return textBytes(fake.readText(path) ?? "");
    },
    remoteText(path) {
      return fake.readText(path);
    },
    remoteSnapshot(path) {
      return fake.getResource(path);
    },
    async deleteRemote(path) {
      return await directRequest("DELETE", path);
    },
    async putRemote(path, text, putOptions = {}) {
      return await directRequest(
        "PUT",
        path,
        {
          "Content-Type": "application/octet-stream",
          ...(putOptions.ifMatch ? { "If-Match": putOptions.ifMatch } : {}),
        },
        text,
      );
    },
    async moveRemote(from, to) {
      return await directRequest("MOVE", from, {
        Destination: `http://127.0.0.1:${port}${to}`,
        Overwrite: "F",
      });
    },
    renameLocal(from, to) {
      const text = shared.local.files.get(from);
      if (text === undefined) throw new Error(`missing local file ${from}`);
      shared.local.files.delete(from);
      shared.local.files.set(to, text);
      const entry = shared.local.entries.find(
        (candidate) => candidate.path === from,
      );
      if (entry) {
        entry.path = to;
      } else {
        shared.local.entries.push({
          path: to,
          size: new TextEncoder().encode(text).byteLength,
          mtime: 1,
          hash: "",
          binary: false,
        });
      }
    },
    deleteLocal(path) {
      shared.local.files.delete(path);
      const index = shared.local.entries.findIndex(
        (candidate) => candidate.path === path,
      );
      if (index >= 0) shared.local.entries.splice(index, 1);
    },
    renameLocalFolder(from, to) {
      if (!shared.local.folders.has(from)) {
        throw new Error(`missing local folder ${from}`);
      }
      for (const folder of [...shared.local.folders]) {
        if (folder === from || folder.startsWith(`${from}/`)) {
          shared.local.folders.delete(folder);
          shared.local.folders.add(
            folder === from ? to : `${to}${folder.slice(from.length)}`,
          );
        }
      }
      for (const [path, text] of [...shared.local.files]) {
        if (path.startsWith(`${from}/`)) {
          shared.local.files.delete(path);
          shared.local.files.set(`${to}${path.slice(from.length)}`, text);
        }
      }
      for (const entry of shared.local.entries) {
        if (entry.path.startsWith(`${from}/`)) {
          entry.path = `${to}${entry.path.slice(from.length)}`;
        }
      }
    },
    resetProviderCalls() {
      session.providerCalls.length = 0;
    },
  };
  return harness;
}
