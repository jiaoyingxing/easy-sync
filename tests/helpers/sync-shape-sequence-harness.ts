// S5 形状序列测试台的共享夹具：双设备真实形状的测试替身。
//
// 现有的同步安全替身只建「一份设备状态」——「另一台设备」由测试直接改远端
// 数组冒充（校准单 §五 D6 的判定原文）。本夹具补上缺的那一台：
//   · 两台设备各自持有独立的本地树（内容字节＋目录集合）与独立的 V2 信封
//     （base＋锚点＋远端索引各建一份；提交走 makeActiveV2State 的真实归约链）；
//   · 共享同一个「远端世界」（一张 Graph 风格 item 树＋按身份追踪的增量日志）。
//     任一设备经引擎执行的动作（上传／删除／移动）都落到同一份世界事实上，
//     另一台设备下一轮经增量页（或跨目录层级失配触发的整体重建——与真实
//     Graph 的路由同形）看到它；
//   · 世界变化既可由设备动作产生，也可由云侧第三方动作（world.* 方法）直接
//     施加——对应野外判例里「用户在网页端动手」的形状段；
//   · Runner 按「设备 A 一轮 → 世界变化/设备 B 一轮 → 拉锯」编排，
//     并提供 D6 断言原语（零动作轮、双设备视图一致＋账本/待办清空）。
//
// 状态替身复用 tests/helpers/sync-safety-harness.ts 的 makeActiveV2State
// （14 个 sync-safety 主题文件共用、已由整轮用例证明可跑）；本夹具不新增
// 任何状态语义，只新增「第二台设备＋共同世界」的可表达性。

import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import { TFile, TFolder, type DataAdapter } from "obsidian";
import type { DriveItem } from "../../src/onedrive/types";
import type { OneDriveClient } from "../../src/onedrive/client";
import { isEasySyncInternalPath } from "../../src/sync/local-scanner";
import type { LocalScanner } from "../../src/sync/local-scanner";
import { SyncExecutor, type SyncResult } from "../../src/sync/sync-executor";
import type { StateManager } from "../../src/sync/state-manager";
import type {
  BaseFileEntry,
  LocalFileEntry,
  MutationLedgerEntryV1,
  PendingIssue,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncScope,
} from "../../src/sync/types";
import { makeActiveV2State, TEST_SYNC_SCOPE } from "./sync-safety-harness";

/**
 * 世界/设备替身的内容哈希。与 src/crypto 的 sha256Hex 同算法（SHA-256、
 * 小写 hex）；替身内需要同步取值，故用 node:crypto（测试环境为 Node）。
 */
const sha256Bytes = (bytes: ArrayBuffer | Uint8Array): string =>
  createHash("sha256")
    .update(Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))
    .digest("hex")
    .toLowerCase();


/**
 * 测试文件用：与替身同源的同步 SHA-256（小写十六进制）。
 */
export const sha256Sync = sha256Bytes;

/**
 * 双设备世界共用的一份同步范围（同一个云端目录）。
 * accountId 与夹具替身 makeActiveV2State 内建范围一致（键盘注入的恢复记录
 * 要与已提交状态逐字段同范围，genus sameSyncScope gate）。
 */
export const SHAPE_SCOPE: SyncScope = {
  ...TEST_SYNC_SCOPE,
  accountId: "account-id",
};

// ---------------------------------------------------------------------------
// 世界（远端测试替身）
// ---------------------------------------------------------------------------

interface WorldFile {
  kind: "file";
  id: string;
  path: string;
  bytes: ArrayBuffer;
  size: number;
  hash: string;
  /** 世界级修订号：增量页按它判断「该设备游标之后变过什么」。 */
  lastChange: number;
  /**
   * F17 形状专用：本修订号的一次 Graph 响应里不带内容哈希
   * （真实 Graph 在移动后会出现「先到名字、哈希补发延迟」的窗口）。
   * 该 item 下一次内容变化时自动清除。
   */
  hashBlindRevision?: number;
}

interface WorldFolder {
  kind: "folder";
  id: string;
  path: string;
  lastChange: number;
}

type WorldItem = WorldFile | WorldFolder;

interface WorldFacts {
  revision: number;
  nextItemId: () => string;
  files: Map<string, WorldFile>;
  folders: Map<string, WorldFolder>;
  byId: Map<string, WorldItem>;
  /** 删除痕迹：id → 删除修订号（全量页不含它，增量页必须交付删除事件）。 */
  tombstones: Map<string, number>;
}

export interface WorldSnapshot {
  /** 文件路径 → 内容 sha256（小写）。 */
  files: Map<string, string>;
  /** 内容字节（按文件路径索引）。 */
  bytes: Map<string, ArrayBuffer>;
  /** 目录路径集合（已含祖先链，排序稳定）。 */
  folders: string[];
  /** 路径 → Graph 身份 id（现存项）。 */
  ids: Map<string, string>;
}

export interface ShapeWorld {
  id: string;
  scope: SyncScope;
  filesRootId: string;
  /** 云侧第三方编辑文件内容（等价于网页端改写）。 */
  editRemoteFile(path: string, content: string): void;
  deleteRemoteFile(path: string): void;
  deleteRemoteFolder(path: string): void;
  renameRemoteFile(path: string, newName: string): void;
  renameRemoteFolder(path: string, newName: string): void;
  /** 该次内容变更的 Graph 响应不带内容哈希（哈希补发延迟窗口）。 */
  editRemoteFileHashBlind(path: string, content: string): void;
  moveRemoteFileToFolder(path: string, targetParentPath: string): void;
  moveRemoteFolder(path: string, targetParentPath: string): void;
  /** F17 形状：云端移动一个文件且该次变更的 Graph 响应不带内容哈希。 */
  moveRemoteFileHashBlind(path: string, targetParentPath: string): void;
  /** F24 形状：删除整棵目录树再在原路径原内容重建（所有 id 全部新生）。 */
  recreateRemoteFolderAt(path: string): void;
  snapshot(): WorldSnapshot;
}

function parentPathOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function completeFolderChain(
  path: string,
  folders: Map<string, WorldFolder>,
  nextItemId: () => string,
): void {
  if (folders.has(path)) return;
  const parent = parentPathOf(path);
  if (parent) completeFolderChain(parent, folders, nextItemId);
  const folder: WorldFolder = {
    kind: "folder",
    id: `w-folder-${nextItemId()}`,
    path,
    lastChange: 0,
  };
  folders.set(path, folder);
}

/** 把 path 子树（本体与全部后代文件/文件夹）整体搬到 targetParent + newLeaf。 */
function rewriteFolderSubtree(
  facts: WorldFacts,
  sourcePath: string,
  targetParentPath: string,
  newLeaf: string,
): void {
  const folder = facts.folders.get(sourcePath);
  if (!folder) throw new Error(`shape world subtree missing folder: ${sourcePath}`);
  const targetPath = `${targetParentPath ? `${targetParentPath}/` : ""}${newLeaf}`;
  const files = [...facts.files.values()].filter((file) =>
    file.path === sourcePath || file.path.startsWith(`${sourcePath}/`));
  const descendantFolders = [...facts.folders.keys()]
    .filter((path) => path.startsWith(`${sourcePath}/`))
    .sort((left, right) => left.split("/").length - right.split("/").length);
  facts.revision += 1;
  for (const file of files) {
    facts.files.delete(file.path);
    file.path = `${targetPath}${file.path.slice(sourcePath.length)}`;
    file.lastChange = facts.revision;
    facts.files.set(file.path, file);
  }
  for (const descendantPath of descendantFolders) {
    const sub = facts.folders.get(descendantPath)!;
    facts.folders.delete(descendantPath);
    sub.path = `${targetPath}${descendantPath.slice(sourcePath.length)}`;
    facts.folders.set(sub.path, sub);
  }
  facts.folders.delete(sourcePath);
  folder.path = targetPath;
  folder.lastChange = facts.revision;
  facts.folders.set(targetPath, folder);
}

let worldSequence = 0;

/**
 * 创立一个共享远端世界。files 为 路径→文本内容；folders 为显式目录列表
 * （文件路径的祖先目录自动补齐）。所有 item id 由世界分配。
 */
export function createShapeWorld(input: {
  files: Record<string, string>;
  folders?: readonly string[];
}): ShapeWorld {
  const facts: WorldFacts = {
    revision: 0,
    nextItemId: (() => {
      const base = ++worldSequence * 1000;
      let value = 0;
      return () => `w-item-${base + (value += 1)}`;
    })(),
    files: new Map(),
    folders: new Map(),
    byId: new Map(),
    tombstones: new Map(),
  };
  for (const folderPath of input.folders ?? []) {
    completeFolderChain(folderPath, facts.folders, facts.nextItemId);
  }
  for (const [path, content] of Object.entries(input.files)) {
    const parent = parentPathOf(path);
    if (parent) completeFolderChain(parent, facts.folders, facts.nextItemId);
    if (facts.files.has(path) || facts.folders.has(path)) {
      throw new Error(`shape world duplicated path: ${path}`);
    }
    const bytes = new TextEncoder().encode(content).buffer;
    const file: WorldFile = {
      kind: "file",
      id: facts.nextItemId(),
      path,
      bytes,
      size: bytes.byteLength,
      hash: sha256Bytes(bytes),
      lastChange: 0,
    };
    facts.files.set(path, file);
    facts.byId.set(file.id, file);
  }
  for (const folder of facts.folders.values()) {
    facts.byId.set(folder.id, folder);
  }
  worldSequence += 1;

  const ensureFolders = (parent: string): void => {
    if (!parent) return;
    completeFolderChain(parent, facts.folders, facts.nextItemId);
  };

  const world: ShapeWorld = {
    id: `shape-world-${worldSequence}`,
    scope: SHAPE_SCOPE,
    filesRootId: SHAPE_SCOPE.filesRootId,
    editRemoteFile(path, content) {
      const file = facts.files.get(path);
      if (!file) throw new Error(`shape world edit missing file: ${path}`);
      file.bytes = new TextEncoder().encode(content).buffer;
      file.size = file.bytes.byteLength;
      file.hash = sha256Bytes(file.bytes);
      file.hashBlindRevision = undefined;
      file.lastChange = facts.revision += 1;
    },
    editRemoteFileHashBlind(path, content) {
      const file = facts.files.get(path);
      if (!file) throw new Error(`shape world blind edit missing file: ${path}`);
      file.bytes = new TextEncoder().encode(content).buffer;
      file.size = file.bytes.byteLength;
      file.hash = sha256Bytes(file.bytes);
      file.lastChange = facts.revision += 1;
      file.hashBlindRevision = file.lastChange;
    },
    deleteRemoteFile(path) {
      const file = facts.files.get(path);
      if (!file) throw new Error(`shape world delete missing file: ${path}`);
      facts.files.delete(path);
      facts.byId.delete(file.id);
      facts.tombstones.set(file.id, facts.revision += 1);
    },
    deleteRemoteFolder(path) {
      const files = [...facts.files.values()].filter((file) =>
        file.path === path || file.path.startsWith(`${path}/`));
      const folders = [...facts.folders.values()].filter((folder) =>
        folder.path === path || folder.path.startsWith(`${path}/`));
      facts.revision += 1;
      for (const file of files) {
        facts.files.delete(file.path);
        facts.byId.delete(file.id);
        facts.tombstones.set(file.id, facts.revision);
      }
      for (const folder of folders) {
        facts.folders.delete(folder.path);
        facts.byId.delete(folder.id);
        facts.tombstones.set(folder.id, facts.revision);
      }
    },
    renameRemoteFile(path, newName) {
      const file = facts.files.get(path);
      if (!file) throw new Error(`shape world rename missing file: ${path}`);
      const parent = parentPathOf(path);
      facts.files.delete(path);
      file.path = parent ? `${parent}/${newName}` : newName;
      file.lastChange = facts.revision += 1;
      facts.files.set(file.path, file);
    },
    renameRemoteFolder(path, newName) {
      const folder = facts.folders.get(path);
      if (!folder) throw new Error(`shape world rename missing folder: ${path}`);
      if (newName.includes("/")) {
        throw new Error(`shape world renameFolder expects a bare name: ${newName}`);
      }
      const parent = parentPathOf(path);
      rewriteFolderSubtree(facts, path, parent, newName);
    },
    moveRemoteFileToFolder(path, targetParentPath) {
      const file = facts.files.get(path);
      if (!file) throw new Error(`shape world move missing file: ${path}`);
      ensureFolders(targetParentPath);
      facts.files.delete(path);
      file.path = `${targetParentPath ? `${targetParentPath}/` : ""}${baseName(path)}`;
      file.lastChange = facts.revision += 1;
      facts.files.set(file.path, file);
    },
    moveRemoteFileHashBlind(path, targetParentPath) {
      const file = facts.files.get(path);
      if (!file) throw new Error(`shape world blind move missing file: ${path}`);
      ensureFolders(targetParentPath);
      facts.files.delete(path);
      file.path = `${targetParentPath ? `${targetParentPath}/` : ""}${baseName(path)}`;
      file.lastChange = facts.revision += 1;
      file.hashBlindRevision = file.lastChange;
      facts.files.set(file.path, file);
    },
    moveRemoteFolder(path, targetParentPath) {
      const folder = facts.folders.get(path);
      if (!folder) throw new Error(`shape world move missing folder: ${path}`);
      ensureFolders(targetParentPath);
      rewriteFolderSubtree(facts, path, targetParentPath, baseName(path));
    },
    recreateRemoteFolderAt(path) {
      const contents = new Map<string, ArrayBuffer>();
      for (const file of [...facts.files.values()].filter((candidate) =>
        candidate.path.startsWith(`${path}/`))) {
        contents.set(file.path, file.bytes.slice(0));
      }
      world.deleteRemoteFolder(path);
      for (const [subPath] of contents) {
        completeFolderChain(
          parentPathOf(subPath),
          facts.folders,
          facts.nextItemId,
        );
      }
      facts.revision += 1;
      for (const [subPath, bytes] of contents) {
        const parentFolder = facts.folders.get(parentPathOf(subPath))!;
        parentFolder.lastChange = facts.revision;
        facts.byId.set(parentFolder.id, parentFolder);
        const file: WorldFile = {
          kind: "file",
          id: facts.nextItemId(),
          path: subPath,
          bytes,
          size: bytes.byteLength,
          hash: sha256Bytes(bytes),
          lastChange: facts.revision,
        };
        facts.files.set(subPath, file);
        facts.byId.set(file.id, file);
      }
    },
    snapshot(): WorldSnapshot {
      const fileMap = new Map<string, string>();
      const bytesMap = new Map<string, ArrayBuffer>();
      const ids = new Map<string, string>();
      for (const [path, file] of facts.files) {
        fileMap.set(path, file.hash);
        bytesMap.set(path, file.bytes.slice(0));
        ids.set(path, file.id);
      }
      for (const [path, folder] of facts.folders) ids.set(path, folder.id);
      return {
        files: fileMap,
        bytes: bytesMap,
        folders: [...facts.folders.keys()].sort(),
        ids,
      };
    },
  };

  (world as unknown as { __facts: WorldFacts }).__facts = facts;

  return world;
}

// ---------------------------------------------------------------------------
// Graph item 投影（设备客户端共用；形状与消费方 toRemoteEntry／
// projectCompleteRemoteSnapshot 一致）
// ---------------------------------------------------------------------------

function lastModifiedIso(revision: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, revision)).toISOString();
}

function parentItemId(facts: WorldFacts, path: string): string {
  const parent = parentPathOf(path);
  return parent === ""
    ? SHAPE_SCOPE.filesRootId
    : facts.folders.get(parent)!.id;
}

function makeFolderDriveItem(facts: WorldFacts, folder: WorldFolder): DriveItem {
  return {
    id: folder.id,
    name: baseName(folder.path),
    folder: { childCount: 0 },
    parentReference: { id: parentItemId(facts, folder.path) },
    lastModifiedDateTime: lastModifiedIso(folder.lastChange),
    eTag: `w-etag-${folder.id}`,
    cTag: `w-ctag-${folder.id}`,
  };
}

function makeFileDriveItem(facts: WorldFacts, file: WorldFile): DriveItem {
  const hashBlind = file.hashBlindRevision === file.lastChange;
  return {
    id: file.id,
    name: baseName(file.path),
    size: file.size,
    file: hashBlind ? {} : { hashes: { sha256Hash: file.hash } },
    parentReference: { id: parentItemId(facts, file.path) },
    lastModifiedDateTime: lastModifiedIso(file.lastChange),
    eTag: `w-etag-${file.id}`,
    cTag: `w-ctag-${file.id}`,
  };
}

function driveItemsForWorld(facts: WorldFacts): DriveItem[] {
  const items: DriveItem[] = [];
  for (const folder of [...facts.folders.values()].sort(
    (left, right) =>
      left.path.split("/").length - right.path.split("/").length
      || left.path.localeCompare(right.path),
  )) {
    items.push(makeFolderDriveItem(facts, folder));
  }
  for (const file of [...facts.files.values()].sort(
    (left, right) => left.path.localeCompare(right.path),
  )) {
    items.push(makeFileDriveItem(facts, file));
  }
  return items;
}

// ---------------------------------------------------------------------------
// 设备
// ---------------------------------------------------------------------------

export interface ShapeDevice {
  name: string;
  world: ShapeWorld;
  scope: SyncScope;
  state: StateManager;
  executor: SyncExecutor;
  /** 本地树字节面（测试可直接改造本地事实的小窗口）。 */
  localBytes: Map<string, ArrayBuffer>;
  localFolders: Set<string>;
  /** 该设备把哪些动作打到世界上（形状内可核对）。 */
  syncCalls: {
    uploads: string[];
    downloads: string[];
    deletes: string[];
    moves: string[];
  };
  /** 最近一轮的同步结果（零动作断言原语读这里）。 */
  lastResult: SyncResult | null;
  /** 最近一轮（含本轮）引擎侧的简要诊断行（替换内调试窗口）。 */
  recentDiagnostics: Array<{ level: string; source: string; message: string }>;
  runRound(options?: { recoveryOnly?: boolean }): Promise<SyncResult>;
  /** 本地内容面（路径 → 内容哈希）。 */
  localView(): Promise<Map<string, string>>;
  /** 已提交远端索引面（路径 → 内容哈希；目录单独列）。 */
  remoteView(): { files: Map<string, string>; folders: string[] };
  ledger(): MutationLedgerEntryV1[];
  pendingIssues(): PendingIssue[];
  committedBasePaths(): string[];
  /** 本地用户动作（下一轮扫描会被引擎看见）。 */
  writeLocalFile(path: string, content: string): Promise<void>;
  deleteLocalFile(path: string): Promise<void>;
  renameLocalFile(fromPath: string, toPath: string): Promise<void>;
  deleteLocalFolder(path: string): Promise<void>;
  renameLocalFolder(fromPath: string, toPath: string): Promise<void>;
  /** 注入一条「真实动作已被世界落实、回执缺失」的文件夹移动意图
   *  字段全部取自运行时世界事实（F29 真宿主协议 §3.2 的注入手法）。 */
  seedAppliedFolderMoveRecord(input: {
    sourcePath: string;
    targetPath: string;
    operationId?: string;
  }): MutationLedgerEntryV1;
  /** 本机文件是否存在（本地树直读）。 */
  hasLocalFile(path: string): boolean;
}

/**
 * 在世界下加一台设备：本地树复制世界当前内容，V2 状态按「与已同步世界完全
 * 一致」直接落成（base＋锚点＋远端索引一次到齐，等价于刚完成首轮归零的设备）。
 * 加设备后先各跑一轮稳定轮即验证「0 动作基线」。
 */
export async function addShapeDevice(
  world: ShapeWorld,
  name: string,
): Promise<ShapeDevice> {
  const facts = (world as unknown as { __facts: WorldFacts }).__facts;

  // —— 设备本地树与已提交状态（与世界当前一致）——
  const localBytes = new Map<string, ArrayBuffer>();
  const localFolders = new Set<string>();
  const entries: LocalFileEntry[] = [];
  const baseEntries: BaseFileEntry[] = [];
  const remoteEntries: RemoteFileEntry[] = [];
  const remoteFolderEntries: RemoteFolderEntry[] = [];
  const folderAnchorSeeds: Array<{
    remoteId: string;
    lastPath: string;
    parentId: string;
    eTag: string;
  }> = [];
  let mtimeSeq = 0;

  for (const folderPath of [...facts.folders.keys()].sort()) {
    localFolders.add(folderPath);
    const folder = facts.folders.get(folderPath)!;
    const folderEntry: RemoteFolderEntry = {
      path: folderPath,
      driveId: folder.id,
      parentId: parentItemId(facts, folderPath),
      name: baseName(folderPath),
      eTag: `w-etag-${folder.id}`,
    };
    remoteFolderEntries.push(folderEntry);
    folderAnchorSeeds.push({
      remoteId: folder.id,
      lastPath: folderPath,
      parentId: folderEntry.parentId,
      eTag: folderEntry.eTag!,
    });
  }
  for (const path of [...facts.files.keys()].sort()) {
    const file = facts.files.get(path)!;
    localBytes.set(path, file.bytes.slice(0));
    const localEntry: LocalFileEntry = {
      path,
      hash: file.hash,
      size: file.size,
      mtime: ++mtimeSeq,
      binary: false,
    };
    entries.push(localEntry);
    baseEntries.push({
      path,
      hash: file.hash,
      size: file.size,
      eTag: `w-etag-${file.id}`,
    });
    remoteEntries.push({
      path,
      driveId: file.id,
      parentId: parentItemId(facts, path),
      size: file.size,
      mtime: Date.parse(lastModifiedIso(file.lastChange)),
      eTag: `w-etag-${file.id}`,
      cTag: `w-ctag-${file.id}`,
      sha256Hash: file.hash,
    });
  }

  const state = makeActiveV2State(remoteEntries, baseEntries, {
    remoteFolders: remoteFolderEntries,
    folderAnchors: folderAnchorSeeds,
  });

  // 轮末待办落库：替身的 reconcile 换成与真实语义同形的内存实现
  // （按路径替换、resolved 退休、FolderDeferred 行不累计失败）。
  const pendingIssueStore = (state as unknown as {
    pendingIssues: PendingIssue[];
  }).pendingIssues;
  (state as unknown as {
    reconcilePendingIssues: (
      issues: PendingIssue[],
      resolvedPaths: Iterable<string>,
    ) => Promise<void>;
  }).reconcilePendingIssues = vi.fn(
    async (issues: PendingIssue[], resolvedPaths: Iterable<string>) => {
      const resolved = new Set(resolvedPaths);
      const byPath = new Map(
        pendingIssueStore.map((issue) => [issue.path, { ...issue }]),
      );
      for (const path of resolved) byPath.delete(path);
      for (const issue of issues) byPath.set(issue.path, { ...issue });
      pendingIssueStore.splice(
        0,
        pendingIssueStore.length,
        ...[...byPath.values()],
      );
    },
  );

  // —— 本地适配器（map 驱动）——
  const commitLocalFile = (path: string, bytes: ArrayBuffer): void => {
    localBytes.set(path, bytes);
    const content = new Uint8Array(bytes);
    const next: LocalFileEntry = {
      path,
      hash: sha256Bytes(content),
      size: content.byteLength,
      mtime: ++mtimeSeq,
      binary: false,
    };
    const index = entries.findIndex((candidate) => candidate.path === path);
    if (index >= 0) entries[index] = next;
    else entries.push(next);
  };

  const adapter = {
    exists: vi.fn(async (path: string) =>
      localBytes.has(path) || localFolders.has(path)),
    stat: vi.fn(async (path: string) => {
      if (localFolders.has(path)) {
        return { type: "folder", mtime: 1 };
      }
      const bytes = localBytes.get(path);
      return bytes
        ? { type: "file", size: bytes.byteLength, mtime: 1 }
        : null;
    }),
    read: vi.fn(async (path: string) => {
      const bytes = localBytes.get(path);
      if (!bytes) throw new Error(`missing local: ${path}`);
      return new TextDecoder().decode(bytes);
    }),
    readBinary: vi.fn(async (path: string) => {
      const bytes = localBytes.get(path);
      if (!bytes) throw new Error(`missing local: ${path}`);
      return bytes.slice(0);
    }),
    write: vi.fn(async (path: string, value: string) => {
      commitLocalFile(path, new TextEncoder().encode(value).buffer);
    }),
    writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
      commitLocalFile(path, value);
    }),
    appendBinary: vi.fn(async () => undefined),
    remove: vi.fn(async (path: string) => {
      localBytes.delete(path);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const bytes = localBytes.get(from);
      if (!bytes) throw new Error(`missing local: ${from}`);
      localBytes.delete(from);
      localBytes.set(to, bytes);
      const entry = entries.find((candidate) => candidate.path === from);
      if (entry) entry.path = to;
    }),
    mkdir: vi.fn(async (path: string) => {
      localFolders.add(path);
    }),
    rmdir: vi.fn(async () => undefined),
    list: vi.fn(async (path: string) => ({
      files: [...localBytes.keys()].filter((entry) =>
        parentPathOf(entry) === path),
      folders: [...localFolders].filter((folder) =>
        parentPathOf(folder) === path),
    })),
  };
  const dataAdapter = adapter as unknown as DataAdapter;

  // 目录/文件的本机镜像同步到 entries 与 localBytes 的辅助（本地树移动后
  // 由下一次 scanAll/inspectFile 统一重算，无需在此逐项维护）。
  const refreshEntries = async (): Promise<void> => {
    for (const entry of [...entries]) {
      const bytes = localBytes.get(entry.path);
      if (!bytes) {
        entries.splice(entries.indexOf(entry), 1);
        continue;
      }
      entry.hash = sha256Bytes(new Uint8Array(bytes));
      entry.size = bytes.byteLength;
    }
    for (const [path, bytes] of localBytes) {
      if (!entries.some((candidate) => candidate.path === path)) {
        entries.push({
          path,
          hash: sha256Bytes(new Uint8Array(bytes)),
          size: bytes.byteLength,
          mtime: ++mtimeSeq,
          binary: false,
        });
      }
    }
  };

  // —— 宿主面（Obsidian 索引里的文件/文件夹形态）——
  const vault = {
    configDir: ".obsidian",
    adapter: dataAdapter,
    getFiles: vi.fn(() => [] as TFile[]),
    getAllLoadedFiles: vi.fn(() =>
      [...localFolders].map((path) => new TFolder(path))),
    getAbstractFileByPath: vi.fn((path: string) =>
      localFolders.has(path)
        ? new TFolder(path)
        : localBytes.has(path)
          ? new TFile(path)
          : null),
    getFileByPath: vi.fn((path: string) =>
      !path.startsWith(".obsidian/") && localBytes.has(path)
        ? new TFile(path)
        : null),
    modify: vi.fn(async (file: TFile, data: string) => {
      commitLocalFile(
        file.path,
        new TextEncoder().encode(data).buffer,
      );
    }),
    createFolder: vi.fn(async (path: string) => {
      localFolders.add(path);
    }),
    rename: vi.fn(async (target: TFile | TFolder, targetPath: string) => {
      if (target instanceof TFolder) {
        const sourcePath = target.path;
        const affected = [...localFolders].filter((path) =>
          path === sourcePath || path.startsWith(`${sourcePath}/`));
        for (const path of affected) localFolders.delete(path);
        for (const path of affected) {
          localFolders.add(
            path === sourcePath
              ? targetPath
              : `${targetPath}${path.slice(sourcePath.length)}`,
          );
        }
        for (const [path, bytes] of [...localBytes.entries()]) {
          if (path === sourcePath || path.startsWith(`${sourcePath}/`)) {
            localBytes.delete(path);
            localBytes.set(
              path === sourcePath
                ? targetPath
                : `${targetPath}${path.slice(sourcePath.length)}`,
              bytes,
            );
          }
        }
        for (const entry of entries) {
          if (
            entry.path === sourcePath
            || entry.path.startsWith(`${sourcePath}/`)
          ) {
            entry.path = entry.path === sourcePath
              ? targetPath
              : `${targetPath}${entry.path.slice(sourcePath.length)}`;
          }
        }
        return;
      }
      await adapter.rename(target.path, targetPath);
    }),
    getName: vi.fn(() => name),
  };

  // 真实扫描器只把「范围内文件的祖先链」当作候选目录（addParentFolderPaths），
  // 引擎自己的暂存目录（tmp/state/logs）按 isExcluded 出局；下载时 mkdir 的
  // `.obsidian` 父链壳在真实实现里也绝不会进入扫描面。按同语义建模。
  const folderScanCandidates = (): string[] => {
    const candidateSet = new Set<string>();
    for (const path of localBytes.keys()) {
      if (isEasySyncInternalPath(path, ".obsidian")) continue;
      let parent = parentPathOf(path);
      while (parent) {
        if (!isEasySyncInternalPath(parent, ".obsidian")) candidateSet.add(parent);
        parent = parentPathOf(parent);
      }
    }
    for (const folder of localFolders) {
      if (isEasySyncInternalPath(folder, ".obsidian")) continue;
      if (folder.startsWith(".obsidian")) continue;
      candidateSet.add(folder);
    }
    return [...candidateSet].sort();
  };

  const scanner = {
    vault,
    scanAll: vi.fn(async () => {
      await refreshEntries();
      return {
        entries: entries.map((entry) => ({ ...entry })),
        folders: folderScanCandidates().map((path) => ({ path })),
        folderScanComplete: true,
        folderScanFailures: [],
        skippedLarge: [],
        skippedCount: 0,
        failedPaths: [],
        complete: true,
      };
    }),
    scanFile: vi.fn(async () => null),
    inspectFile: vi.fn(async (path: string) => {
      await refreshEntries();
      const entry = entries.find((candidate) => candidate.path === path);
      return entry
        ? { status: "present" as const, entry: { ...entry } }
        : { status: "missing" as const };
    }),
    shouldSyncPath: vi.fn((path: string) =>
      !isEasySyncInternalPath(path, ".obsidian")),
    shouldSyncFolderPath: vi.fn((path: string) =>
      Boolean(path) && !isEasySyncInternalPath(path, ".obsidian")
        && !path.startsWith(".obsidian")),
    getMaxFileSize: vi.fn(() => 100 * 1024 * 1024),
  } as unknown as LocalScanner;

  // —— 共享世界的设备端 Graph 客户端 ——
  const syncCalls = {
    uploads: [] as string[],
    downloads: [] as string[],
    deletes: [] as string[],
    moves: [] as string[],
  };
  const tokenIssuedRevision = new Map<string, number>();
  let tokenIndex = 0;
  const issueToken = (): string => {
    const token = `shape-delta-${world.id}-${name}-${tokenIndex += 1}`;
    tokenIssuedRevision.set(token, facts.revision);
    return token;
  };
  const folderPathById = (driveItemId: string): string | null => {
    if (driveItemId === SHAPE_SCOPE.filesRootId) return "";
    for (const folder of facts.folders.values()) {
      if (folder.id === driveItemId) return folder.path;
    }
    return null;
  };

  const uploadFile = vi.fn(async (
    _vaultName: string,
    path: string,
    bytes: ArrayBuffer,
  ) => {
    syncCalls.uploads.push(path);
    const existing = facts.files.get(path);
    if (existing) {
      existing.bytes = bytes;
      existing.hash = sha256Bytes(new Uint8Array(bytes));
      existing.size = bytes.byteLength;
      existing.lastChange = facts.revision += 1;
      return {
        id: existing.id,
        eTag: `w-etag-${existing.id}`,
        cTag: `w-ctag-${existing.id}`,
        size: existing.size,
        parentReference: { id: parentItemId(facts, path) },
      };
    }
    const parent = parentPathOf(path);
    if (parent && !facts.folders.has(parent)) {
      throw new Error(`shape world upload missing parent folder: ${path}`);
    }
    facts.revision += 1;
    const file: WorldFile = {
      kind: "file",
      id: facts.nextItemId(),
      path,
      bytes: bytes.slice(0),
      size: bytes.byteLength,
      hash: sha256Bytes(new Uint8Array(bytes)),
      lastChange: facts.revision,
    };
    facts.files.set(path, file);
    facts.byId.set(file.id, file);
    return {
      id: file.id,
      eTag: `w-etag-${file.id}`,
      cTag: `w-ctag-${file.id}`,
      size: file.size,
      parentReference: { id: parentItemId(facts, path) },
    };
  });

  const deleteItem = vi.fn(async (
    _vaultName: string,
    path: string,
    _eTag?: string,
    driveItemId?: string,
  ) => {
    syncCalls.deletes.push(path);
    const target = (driveItemId ? facts.byId.get(driveItemId) : undefined)
      ?? facts.files.get(path)
      ?? facts.folders.get(path);
    if (!target) throw new Error(`shape world delete missing: ${path}`);
    if (target.kind === "folder") world.deleteRemoteFolder(target.path);
    else world.deleteRemoteFile(target.path);
  });

  const moveItemById = vi.fn(async (
    driveItemId: string,
    eTag: string,
    newName: string,
    parentDriveItemId: string,
  ) => {
    const target = facts.byId.get(driveItemId);
    if (!target) throw new Error(`shape world move missing identity: ${driveItemId}`);
    syncCalls.moves.push(`${target.path}->${newName}`);
    if (`w-etag-${target.id}` !== eTag) {
      throw new Error(`shape world move precondition changed: ${target.path}`);
    }
    const targetParentPath = folderPathById(parentDriveItemId) ?? "";
    if (target.kind === "folder") {
      if (targetParentPath !== parentPathOf(target.path)) {
        world.moveRemoteFolder(target.path, targetParentPath);
      }
      if (newName !== baseName(target.path)) {
        world.renameRemoteFolder(target.path, newName);
      }
    } else {
      if (targetParentPath !== parentPathOf(target.path)) {
        world.moveRemoteFileToFolder(target.path, targetParentPath);
      }
      if (newName !== baseName(target.path)) {
        world.renameRemoteFile(target.path, newName);
      }
    }
    const moved = facts.byId.get(driveItemId)!;
    return moved.kind === "file"
      ? makeFileDriveItem(facts, moved)
      : makeFolderDriveItem(facts, moved);
  });

  const downloadFile = vi.fn(async (_vaultName: string, path: string) => {
    syncCalls.downloads.push(path);
    const file = facts.files.get(path);
    if (!file) throw new Error(`missing remote: ${path}`);
    return file.bytes.slice(0);
  });

  const getDeltaImpl = vi.fn(async (
    _vaultName: string,
    token?: string,
  ): Promise<{ value: DriveItem[]; "@odata.deltaLink": string }> => {
    const wholeTree = driveItemsForWorld(facts);
    if (!token) {
      return { value: wholeTree, "@odata.deltaLink": issueToken() };
    }
    const issuedAt = tokenIssuedRevision.get(token) ?? 0;
    const changes: DriveItem[] = [];
    for (const [tombId, when] of facts.tombstones) {
      if (when > issuedAt && !facts.byId.has(tombId)) {
        changes.push({ id: tombId, name: "", deleted: { state: "deleted" } });
      }
    }
    for (const item of wholeTree) {
      const worldItem = facts.byId.get(item.id);
      if (!worldItem) {
        throw new Error(
          `shape world delta lost identity: ${item.id} ${item.name}`,
        );
      }
      if (worldItem.lastChange > issuedAt) {
        changes.push(item);
      }
    }
    return { value: changes, "@odata.deltaLink": issueToken() };
  });
  const getDelta = getDeltaImpl as unknown as ReturnType<typeof vi.fn>;

  const getFileMetadata = vi.fn(async (_vaultName: string, path: string) => {
    const item = facts.files.get(path) ?? facts.folders.get(path);
    if (!item) return null;
    if (item.kind === "folder") {
      return {
        eTag: `w-etag-${item.id}`,
        cTag: `w-ctag-${item.id}`,
        size: 1,
        driveId: item.id,
        parentId: parentItemId(facts, item.path),
        mtime: Date.parse(lastModifiedIso(item.lastChange)),
      };
    }
    return {
      eTag: `w-etag-${item.id}`,
      cTag: `w-ctag-${item.id}`,
      size: item.size,
      sha256Hash: item.hash,
      driveId: item.id,
      parentId: parentItemId(facts, item.path),
      mtime: Date.parse(lastModifiedIso(item.lastChange)),
    };
  });

  const client = {
    downloadBaseline: vi.fn(async () => null),
    initVaultScope: vi.fn(async () => ({
      driveId: SHAPE_SCOPE.driveId,
      vaultFolderId: SHAPE_SCOPE.vaultFolderId,
      filesRootId: SHAPE_SCOPE.filesRootId,
    })),
    restoreVaultScope: vi.fn(() => false),
    invalidateVaultScope: vi.fn(),
    isDeltaLinkForVault: vi.fn(() => true),
    setAbortSignal: vi.fn(),
    resetDownloadStrategy: vi.fn(),
    hasDegradedDownloadPathThisRound: vi.fn(() => false),
    beginRunMetrics: vi.fn(),
    finishRunMetrics: vi.fn(() => null),
    getDelta,
    getDeltaByFolderId: getDelta,
    fullScan: vi.fn(async () => driveItemsForWorld(facts)),
    getFileMetadata,
    getFileMetadataByPaths: vi.fn(async (
      vaultName: string,
      paths: readonly string[],
    ) => {
      const result = new Map<string, Awaited<ReturnType<typeof getFileMetadata>>>();
      for (const path of paths) {
        result.set(path, await getFileMetadata(vaultName, path));
      }
      return result;
    }),
    getDriveItemMetadata: vi.fn(async (
      _vaultName: string,
      path: string,
    ): Promise<DriveItem | null> => {
      const file = facts.files.get(path);
      if (file) return makeFileDriveItem(facts, file);
      const folder = facts.folders.get(path);
      if (!folder) return null;
      return makeFolderDriveItem(facts, folder);
    }),
    getDriveItemMetadataById: vi.fn(async (driveItemId: string) => {
      const target = facts.byId.get(driveItemId);
      if (!target) return null;
      return target.kind === "file"
        ? makeFileDriveItem(facts, target)
        : makeFolderDriveItem(facts, target);
    }),
    getDriveItemMetadataByIds: vi.fn(async (ids: readonly string[]) => {
      const byId = new Map<string, DriveItem | null>();
      for (const id of ids) {
        const target = facts.byId.get(id);
        byId.set(id, target
          ? (target.kind === "file"
            ? makeFileDriveItem(facts, target)
            : makeFolderDriveItem(facts, target))
          : null);
      }
      return byId;
    }),
    listFolderChildrenById: vi.fn(async (driveItemId: string) =>
      driveItemsForWorld(facts).filter(
        (item) => item.parentReference?.id === driveItemId,
      )),
    createFolderByParentId: vi.fn(async (
      parentDriveItemId: string,
      folderName: string,
    ) => {
      const parentPath = folderPathById(parentDriveItemId) ?? "";
      const path = parentPath ? `${parentPath}/${folderName}` : folderName;
      const existing = facts.folders.get(path);
      if (existing) {
        return makeFolderDriveItem(facts, existing);
      }
      facts.revision += 1;
      completeFolderChain(path, facts.folders, facts.nextItemId);
      const created = facts.folders.get(path)!;
      created.lastChange = facts.revision;
      facts.byId.set(created.id, created);
      return makeFolderDriveItem(facts, created);
    }),
    uploadFile,
    deleteItem,
    moveItemById,
    downloadFile,
    downloadFileToPath: vi.fn(async (
      _vaultName: string,
      path: string,
      _localPath: string,
      targetAdapter: {
        writeBinary: (path: string, bytes: ArrayBuffer) => Promise<void>;
      },
    ) => {
      const file = facts.files.get(path);
      if (!file) throw new Error(`missing remote: ${path}`);
      await targetAdapter.writeBinary(path, file.bytes.slice(0));
      return { size: file.size, hash: file.hash };
    }),
  } as unknown as OneDriveClient;

  const diagnostics: Array<{ level: string; source: string; message: string }> = [];
  const diag = {
    log: (source: string, message: string, detail?: unknown) => {
      diagnostics.push({ level: "log", source, message: String(message) + (detail === undefined ? "" : ` ${JSON.stringify(detail)}`) });
    },
    warn: (source: string, message: string, detail?: unknown) => {
      diagnostics.push({ level: "warn", source, message: String(message) + (detail === undefined ? "" : ` ${JSON.stringify(detail)}`) });
    },
    error: (source: string, message: string, detail?: unknown) => {
      diagnostics.push({ level: "error", source, message: String(message) + (detail === undefined ? "" : ` ${JSON.stringify(detail)}`) });
    },
    isEnabled: vi.fn(() => false),
  };
  const executor = new SyncExecutor(client, scanner, state, name, undefined, undefined, diag as never, undefined, undefined, undefined, { show: vi.fn() } as never);

  const device: ShapeDevice = {
    name,
    world,
    scope: SHAPE_SCOPE,
    state,
    executor,
    localBytes,
    localFolders,
    syncCalls,
    lastResult: null,
    recentDiagnostics: diagnostics,
    async runRound(options) {
      diagnostics.splice(0);
      const result = await executor.run(
        "manual",
        {},
        undefined,
        undefined,
        options?.recoveryOnly ? { recoveryOnly: true } : undefined,
      );
      device.lastResult = result;
      return result;
    },
    async localView() {
      await refreshEntries();
      const view = new Map<string, string>();
      for (const [path, bytes] of localBytes) {
        view.set(path, sha256Bytes(new Uint8Array(bytes)));
      }
      return view;
    },
    remoteView() {
      const snapshot = state.remoteSnapshot as RemoteFileEntry[];
      const folders = state.remoteFolders as RemoteFolderEntry[];
      return {
        files: new Map(
          snapshot.map((entry) => [entry.path, entry.sha256Hash ?? ""]),
        ),
        folders: folders.map((folder) => folder.path).sort(),
      };
    },
    ledger() {
      return state.mutationLedger as MutationLedgerEntryV1[];
    },
    pendingIssues() {
      const conflicts = (state as unknown as {
        pendingConflicts: unknown[];
      }).pendingConflicts;
      return [
        ...state.pendingIssues,
        ...conflicts,
      ] as PendingIssue[];
    },
    committedBasePaths() {
      return (state.baseSnapshot as BaseFileEntry[])
        .map((entry) => entry.path)
        .sort();
    },
    async writeLocalFile(path, content) {
      commitLocalFile(path, new TextEncoder().encode(content).buffer);
    },
    async deleteLocalFile(path) {
      if (!localBytes.delete(path)) throw new Error(`missing local: ${path}`);
    },
    async renameLocalFile(fromPath, toPath) {
      await vault.rename(new TFile(fromPath), toPath);
    },
    async deleteLocalFolder(path) {
      for (const subPath of [...localFolders]) {
        if (subPath === path || subPath.startsWith(`${path}/`)) {
          localFolders.delete(subPath);
        }
      }
      for (const subPath of [...localBytes.keys()]) {
        if (subPath === path || subPath.startsWith(`${path}/`)) {
          localBytes.delete(subPath);
        }
      }
    },
    async renameLocalFolder(fromPath, toPath) {
      await vault.rename(new TFolder(fromPath), toPath);
    },
    seedAppliedFolderMoveRecord(input) {
      const sourceFolder = facts.folders.get(input.sourcePath);
      if (!sourceFolder) {
        throw new Error(`shape record seed missing source folder: ${input.sourcePath}`);
      }
      const targetParent = parentPathOf(input.targetPath);
      const parentEntry = targetParent === ""
        ? undefined
        : facts.folders.get(targetParent);
      const operationId = input.operationId ?? `seeded-move-${input.sourcePath}`;
      const receipt: MutationLedgerEntryV1 = {
        intent: {
          version: 2,
          operationId,
          planRevision: 1,
          scope: SHAPE_SCOPE,
          action: "moveRemoteFolder",
          path: input.targetPath,
          sourcePath: input.sourcePath,
          folderId: sourceFolder.id,
          expectedLocal: { exists: true },
          expectedSourceLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: sourceFolder.id,
            parentId: parentEntry?.id ?? SHAPE_SCOPE.filesRootId,
            eTag: `w-etag-${sourceFolder.id}`,
          },
          expectedParent: {
            driveId: parentEntry?.id ?? SHAPE_SCOPE.filesRootId,
            path: targetParent,
            eTag: parentEntry ? `w-etag-${parentEntry.id}` : undefined,
          },
          createdAt: 1,
        },
        receipt: null,
      };
      (state.mutationLedger as MutationLedgerEntryV1[]).push(receipt);
      return receipt;
    },
    hasLocalFile(path: string) {
      return localBytes.has(path);
    },
  };
  return device;
}

// ---------------------------------------------------------------------------
// Runner：形状序列编排与 D6 断言原语
// ---------------------------------------------------------------------------

/** D6 ①「有限轮内零动作收敛」的直接行：一轮零动作判定。 */
export function roundHadZeroActions(result: SyncResult): boolean {
  return result.success !== false
    && result.uploaded === 0
    && result.downloaded === 0
    && result.deleted === 0
    && result.conflicts === 0
    && result.deferred === 0
    && result.errors === 0
    && result.foldersCreated === 0
    && result.foldersMoved === 0
    && result.foldersDeleted === 0
    && result.filesMoved === 0;
}

export function roundActionCount(result: SyncResult): number {
  return result.uploaded
    + result.downloaded
    + result.deleted
    + result.conflicts
    + result.deferred
    + result.foldersCreated
    + result.foldersMoved
    + result.foldersDeleted
    + result.filesMoved
    + result.errors;
}

function roundSummary(result: SyncResult): string {
  return `uploaded=${result.uploaded} downloaded=${result.downloaded} `
    + `deleted=${result.deleted} foldersCreated=${result.foldersCreated} `
    + `foldersMoved=${result.foldersMoved} foldersDeleted=${result.foldersDeleted} `
    + `filesMoved=${result.filesMoved} conflicts=${result.conflicts} `
    + `deferred=${result.deferred} errors=${result.errors} `
    + `message=${JSON.stringify(result.message)}`;
}

/**
 * D6 ③的直读位：一列待办行的（路径，动作类，行为码）摘要，形状用它断言
 * 「期望的延后行在、且形态正确」。
 */
export function describePending(device: ShapeDevice): Array<{
  path: string;
  actionType: string;
  issueCode: string | null;
}> {
  return device.pendingIssues().map((issue) => {
    const extended = issue as unknown as {
      issueCode?: string;
      actionType: unknown;
    };
    return {
      path: issue.path,
      actionType: String(extended.actionType),
      issueCode: extended.issueCode ?? null,
    };
  });
}

/**
 * D6 ①③：断言该设备最近一轮为零动作、账本与待办清空
 * （配合世界变化的形状各自另断言期望的延后行）。
 */
export function expectDeviceZeroActionRound(device: ShapeDevice): SyncResult {
  const pending = device.pendingIssues();
  expect(
    roundHadZeroActions(device.lastResult!),
    `${device.name} expected a zero-action round but got: ${roundSummary(device.lastResult!)}`,
  ).toBe(true);
  expect(pending, `${device.name} pending issues survive: ${
    pending.map((issue) => issue.path).join(", ")
  }`).toHaveLength(0);
  expect(device.ledger()).toHaveLength(0);
  return device.lastResult!;
}

/** 世界当前文件面与目录面。 */
export function worldView(world: ShapeWorld): {
  files: Map<string, string>;
  folders: string[];
} {
  const snapshot = world.snapshot();
  return { files: snapshot.files, folders: snapshot.folders };
}

function mapToObject(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries(
    [...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function identicalMaps(
  left: Map<string, string>,
  right: Map<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

export function describeFleetFailure(
  world: ShapeWorld,
  devices: readonly ShapeDevice[],
  resultsByDevice: readonly SyncResult[][],
): string {
  const expected = worldView(world);
  const lines = [
    `world files=[${[...expected.files.entries()]
      .map(([path, hash]) => `${path}=${hash.slice(0, 8)}`)
      .sort()
      .join(", ")}]`,
    `world folders=[${expected.folders.join(", ")}]`,
  ];
  devices.forEach((device, index) => {
    const remote = device.remoteView();
    lines.push(`${device.name} remote files=[${[...remote.files.entries()]
      .map(([path, hash]) => `${path}=${hash.slice(0, 8)}`)
      .sort()
      .join(", ")}]`);
    lines.push(
      `${device.name} remote folders=[${remote.folders.join(", ")}]`
      + ` ledger=${device.ledger().length}`
      + ` pending=[${device.pendingIssues().map((issue) => issue.path).join(", ")}]`,
    );
    const last = resultsByDevice[index]?.[resultsByDevice[index].length - 1];
    if (last) lines.push(`${device.name} last round: ${roundSummary(last)}`);
  });
  return lines.join("\n");
}

/**
 * D6 ①②③④汇集断言：每台设备的本地面、远端面都等于世界；账本与待办清空；
 * 世界内每个文件 id 都以「现路径」绑在该设备锚点上（身份收敛）。
 */
export async function expectFleetConverged(
  world: ShapeWorld,
  devices: readonly ShapeDevice[],
): Promise<void> {
  const expected = worldView(world);
  const snapshot = world.snapshot();
  const fileIdsById = [...snapshot.ids.entries()].filter(([path]) =>
    snapshot.files.has(path));
  const folderIdsByPath = [...snapshot.ids.entries()].filter(([path]) =>
    !snapshot.files.has(path));
  for (const device of devices) {
    const local = await device.localView();
    await expect(mapToObject(local)).toEqual(mapToObject(expected.files));
    const remote = device.remoteView();
    expect(mapToObject(remote.files)).toEqual(mapToObject(expected.files));
    expect(remote.folders).toEqual(expected.folders);
    expect(device.ledger(), `${device.name} ledger`).toHaveLength(0);
    expect(device.pendingIssues()).toHaveLength(0);
    const envelope = device.state.getCommittedV2Envelope()!;
    expect(envelope).not.toBeNull();
    const anchorsByPath = new Map(
      Object.values(envelope.anchors.byAnchorId).map((anchor) => [
        anchor.lastPath,
        anchor,
      ]),
    );
    for (const [path, id] of fileIdsById) {
      const anchor = anchorsByPath.get(path);
      expect(anchor, `${device.name} anchor missing at ${path}`).toBeTruthy();
      if (anchor) {
        expect(
          anchor.remoteId,
          `${device.name} anchor identity mismatch at ${path}`,
        ).toBe(id);
      }
    }
    const folderAnchorsByPath = new Map(
      Object.values(envelope.folderAnchors?.byAnchorId ?? {}).map((anchor) => [
        anchor.lastPath,
        anchor,
      ]),
    );
    for (const [path, id] of folderIdsByPath) {
      const anchor = folderAnchorsByPath.get(path);
      expect(
        anchor,
        `${device.name} folder anchor missing at ${path}`,
      ).toBeTruthy();
      if (anchor) {
        expect(
          anchor.remoteId,
          `${device.name} folder anchor identity mismatch at ${path}`,
        ).toBe(id);
      }
    }
  }
}

/**
 * D6 ①的编排行：交替轮直到每台设备都拿到一个零动作轮且全队视图与世界一致；
 * 有限轮内不收敛即抛诊断（失败读数逐字段列出）。
 */
export async function settleFleet(
  world: ShapeWorld,
  devices: readonly ShapeDevice[],
  options: { maxSweeps?: number } = {},
): Promise<SyncResult[][]> {
  const maxSweeps = options.maxSweeps ?? 3;
  const resultsByDevice = devices.map(() => [] as SyncResult[]);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    for (const device of devices) {
      const result = await device.runRound();
      resultsByDevice[devices.indexOf(device)].push(result);
    }
    const everyDeviceIdle = devices.every((device) =>
      roundHadZeroActions(device.lastResult!)
      && device.pendingIssues().length === 0
      && device.ledger().length === 0);
    if (!everyDeviceIdle) continue;
    const expected = worldView(world);
    const viewsMatch = (await Promise.all(devices.map(async (device) => {
      const remote = device.remoteView();
      const local = await device.localView();
      return identicalMaps(remote.files, expected.files)
        && identicalMaps(local, expected.files)
        && remote.folders.join(",") === expected.folders.join(",");
    }))).every(Boolean);
    if (viewsMatch) {
      await expectFleetConverged(world, devices);
      return resultsByDevice;
    }
  }
  throw new Error(describeFleetFailure(world, devices, resultsByDevice));
}

/** 逐台跑一轮（形状序列的编排积木：每步显式）。 */
export async function runRoundOnEach(
  devices: readonly ShapeDevice[],
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const device of devices) {
    results.push(await device.runRound());
  }
  return results;
}
