import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { sha256Hex } from "../src/crypto";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { LocalScanner } from "../src/sync/types";

/**
 * 落盘门 `commitDownloadedTempFile` 的写后状态分档（`DECISIONS` 2026-09-23 第 9 点）。
 *
 * 门是九处调用共用的唯一用户文件替换入口，判据只有一条：写完回读磁盘看到什么。
 * 这里钉住——宿主可见的文件走原地写（不改名、暂存文件清掉、留底退休）；宿主把
 * 未保存的行合并进来算落地且记账仍是云端版本；写入没落地时文件不被改动；宿主
 * 不认得的路径保持原子替换；本地事实与扫描不符时在写之前就停下。
 */
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const PATHS = getEasySyncPaths({ configDir: ".obsidian" });
const TEMP_PATH = `${PATHS.tmpDir}/downloads/note.md.part`;
const JOURNAL_INTENT_PATH = `${PATHS.tmpDir}/recovery/intent.json`;
const JOURNAL_COPY_PATH = `${PATHS.tmpDir}/recovery/original.bin`;
const REMOTE_SIZE = bytesOf("remote\n").byteLength;

type FileTable = Map<string, ArrayBuffer>;
type HostWrite = (file: TFile, data: string, files: FileTable) => Promise<void>;

function bytesOf(text: string): ArrayBuffer {
  return ENCODER.encode(text).buffer;
}

function createAdapter(initial: Record<string, string> = {}) {
  const files: FileTable = new Map(
    Object.entries(initial).map(([path, text]) => [path, bytesOf(text)]),
  );
  const calls = { renames: [] as string[], writes: 0 };
  const adapter = {
    async exists(path: string) {
      return files.has(path);
    },
    async stat(path: string) {
      const data = files.get(path);
      return data ? { size: data.byteLength, mtime: 1 } : null;
    },
    async read(path: string) {
      const data = files.get(path);
      if (!data) throw new Error(`missing: ${path}`);
      return DECODER.decode(data);
    },
    async readBinary(path: string) {
      const data = files.get(path);
      if (!data) throw new Error(`missing: ${path}`);
      return data;
    },
    async write(path: string, value: string) {
      calls.writes += 1;
      files.set(path, bytesOf(value));
    },
    async writeBinary(path: string, value: ArrayBuffer) {
      calls.writes += 1;
      files.set(path, value);
    },
    async remove(path: string) {
      files.delete(path);
    },
    async rename(from: string, to: string) {
      calls.renames.push(`${from} -> ${to}`);
      const data = files.get(from);
      if (!data) throw new Error(`missing: ${from}`);
      files.delete(from);
      files.set(to, data);
    },
    async mkdir() { /* 留底目录只需要调用能结算 */ },
    async list() { return { files: [...files.keys()], folders: [] }; },
  };
  return { adapter, calls, files };
}

function makeGateHarness(input: {
  /** 宿主认得的文件；缺席＝索引外路径，宿主没有可保留的视图。 */
  hostFile?: TFile;
  /** 宿主写入面的行为；缺席但给了 hostFile 时按「原样写入」。 */
  hostWrite?: HostWrite;
  /** 给了 hostFile 但没有宿主写入面（宿主只读索引）时置 false。 */
  hostWriteSurface?: boolean;
  initial?: Record<string, string>;
}) {
  const { adapter, calls, files } = createAdapter(input.initial);
  const warnings: string[] = [];
  const hostWrites: string[] = [];
  const hostFile = input.hostFile;
  const hostWrite: HostWrite = input.hostWrite
    ?? (async (file, data, table) => { table.set(file.path, bytesOf(data)); });
  const vault = {
    configDir: ".obsidian",
    adapter,
    getName: () => "testVault",
    getFileByPath: (path: string) => (hostFile && hostFile.path === path ? hostFile : null),
    ...(hostFile && input.hostWriteSurface !== false
      ? {
          modify: async (file: TFile, data: string) => {
            hostWrites.push(data);
            await hostWrite(file, data, files);
          },
        }
      : {}),
  };
  const executor = new SyncExecutor(
    {} as never,
    { vault, inspectFile: vi.fn() } as unknown as LocalScanner,
    {} as never,
    "testVault",
    undefined,
    undefined,
    {
      warn: (_category: string, message: string) => { warnings.push(message); },
      log: vi.fn(),
      error: vi.fn(),
    } as never,
  );
  const gate = (executor as unknown as {
    commitDownloadedTempFile: (
      adapter: unknown,
      targetPath: string,
      tempPath: string,
      expected: { path: string; hash: string; size: number; mtime: number; binary: boolean } | undefined,
      downloaded: { size: number; hash: string },
    ) => Promise<{ size: number; mtime?: number } | null>;
  }).commitDownloadedTempFile.bind(executor);
  return { adapter, calls, files, gate, hostWrites, warnings };
}

async function versionOf(text: string): Promise<{ size: number; hash: string }> {
  const bytes = bytesOf(text);
  return { size: bytes.byteLength, hash: await sha256Hex(bytes) };
}

function entryFor(text: string, hash: string) {
  return {
    path: "note.md",
    hash,
    size: bytesOf(text).byteLength,
    mtime: 1,
    binary: false,
  };
}

/** 留底必须退休：意图与副本都不能留在 tmp 里，否则下一轮会把它当未完成事务。 */
function expectJournalSettled(files: FileTable) {
  expect(files.has(JOURNAL_INTENT_PATH)).toBe(false);
  expect(files.has(JOURNAL_COPY_PATH)).toBe(false);
}

/**
 * 只看落到仓库路径上的改名。留底日志自身的原子写入（目标在插件临时目录里）
 * 是簿记动作，不算替换手段。
 */
function vaultRenames(harness: { calls: { renames: string[] } }): string[] {
  return harness.calls.renames.filter((entry) => !entry.split(" -> ")[1].startsWith(PATHS.tmpDir));
}

describe("commitDownloadedTempFile", () => {
  it("replaces a host-visible file in place and records the remote version", async () => {
    let copyAtWriteTime: string | null = null;
    const harness = makeGateHarness({
      hostFile: new TFile("note.md"),
      // 留底必须发生在写入之前——那是「进程在写入窗口内被杀」时用户唯一可用的本机副本。
      hostWrite: async (file, data, files) => {
        const copy = files.get(JOURNAL_COPY_PATH);
        copyAtWriteTime = copy ? DECODER.decode(copy) : null;
        files.set(file.path, bytesOf(data));
      },
      initial: { "note.md": "old\n", [TEMP_PATH]: "remote\n" },
    });

    const result = await harness.gate(
      harness.adapter,
      "note.md",
      TEMP_PATH,
      entryFor("old\n", (await versionOf("old\n")).hash),
      await versionOf("remote\n"),
    );

    expect(result).toEqual({ size: REMOTE_SIZE, mtime: 1 });
    expect(harness.hostWrites).toEqual(["remote\n"]);
    expect(copyAtWriteTime).toBe("old\n");
    expect(DECODER.decode(harness.files.get("note.md"))).toBe("remote\n");
    // 原地写：不经过改名，暂存文件与留底都清掉。
    expect(vaultRenames(harness)).toEqual([]);
    expect(harness.files.has(TEMP_PATH)).toBe(false);
    expectJournalSettled(harness.files);
  });

  it("counts the host's merge of unsaved text as landed and keeps the remote version as the base", async () => {
    const harness = makeGateHarness({
      hostFile: new TFile("note.md"),
      // 宿主把编辑器里未保存的行合并到我们写入的内容之后。
      hostWrite: async (file, data, files) => {
        files.set(file.path, bytesOf(`${data}user typed\n`));
      },
      initial: { "note.md": "old\n", [TEMP_PATH]: "remote\n" },
    });

    const result = await harness.gate(
      harness.adapter,
      "note.md",
      TEMP_PATH,
      entryFor("old\n", (await versionOf("old\n")).hash),
      await versionOf("remote\n"),
    );

    // 记账仍是云端版本（8B），不是磁盘上的合并结果；合并结果留给下一轮按本机改动上传。
    expect(result).toEqual({ size: REMOTE_SIZE, mtime: 1 });
    expect(DECODER.decode(harness.files.get("note.md"))).toBe("remote\nuser typed\n");
    expect(harness.warnings.some((line) => line.includes("merged unsaved editor text"))).toBe(true);
    expect(vaultRenames(harness)).toEqual([]);
    expect(harness.files.has(TEMP_PATH)).toBe(false);
    expectJournalSettled(harness.files);
  });

  it("reports a write that never landed without touching the target", async () => {
    const harness = makeGateHarness({
      hostFile: new TFile("note.md"),
      hostWrite: async () => { /* 写入静默失败 */ },
      initial: { "note.md": "old\n", [TEMP_PATH]: "remote\n" },
    });

    const error = await harness.gate(
      harness.adapter,
      "note.md",
      TEMP_PATH,
      entryFor("old\n", (await versionOf("old\n")).hash),
      await versionOf("remote\n"),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("did not land the downloaded version");
    // 旧版本原样还在 ⇒ 本机内容确定没被改动，上层可以说「文件未因此改变」。
    expect((error as Error & { localStateUncertain?: boolean }).localStateUncertain).toBe(false);
    // ④ 同轮内有界重试一次（桌面预算 2），失败后旧内容原样留在磁盘上。
    expect(harness.hostWrites).toEqual(["remote\n", "remote\n"]);
    expect(DECODER.decode(harness.files.get("note.md"))).toBe("old\n");
    expect(harness.files.has(TEMP_PATH)).toBe(false);
    expectJournalSettled(harness.files);
  });

  it("does not read a stale old version as a host merge when it extends our bytes", async () => {
    // 远端版本是旧版本的前缀（另一端删了尾部）时，没落地的旧版本也长着「我们写入内容 +
    // 多出来的东西」的样子。这一格若被当作宿主合并，门会返回成功、基线记成远端版本，
    // 下一轮把旧内容当本机改动传回云端＝「保留云端」被反过来执行。
    const localTail = "remote\nlocal tail\n";
    const harness = makeGateHarness({
      hostFile: new TFile("note.md"),
      hostWrite: async () => { /* 写入静默失败：磁盘仍是旧版本 */ },
      initial: { "note.md": localTail, [TEMP_PATH]: "remote\n" },
    });

    const error = await harness.gate(
      harness.adapter,
      "note.md",
      TEMP_PATH,
      entryFor(localTail, (await versionOf(localTail)).hash),
      await versionOf("remote\n"),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("did not land the downloaded version");
    expect(harness.hostWrites).toEqual(["remote\n", "remote\n"]);
    expect(DECODER.decode(harness.files.get("note.md"))).toBe(localTail);
    expect(harness.files.has(TEMP_PATH)).toBe(false);
    expectJournalSettled(harness.files);
  });

  it("restores the previous content when our own write landed truncated", async () => {
    const harness = makeGateHarness({
      hostFile: new TFile("note.md"),
      hostWrite: async (file, data, files) => {
        files.set(file.path, bytesOf(data).slice(0, 2));
      },
      initial: { "note.md": "old\n", [TEMP_PATH]: "remote\n" },
    });

    const error = await harness.gate(
      harness.adapter,
      "note.md",
      TEMP_PATH,
      entryFor("old\n", (await versionOf("old\n")).hash),
      await versionOf("remote\n"),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("truncated file");
    // 回放成功 ⇒ 本机内容确定回到旧版本，同样可以据实说「文件未因此改变」。
    expect((error as Error & { localStateUncertain?: boolean }).localStateUncertain).toBe(false);
    expect(DECODER.decode(harness.files.get("note.md"))).toBe("old\n");
    expect(harness.files.has(TEMP_PATH)).toBe(false);
    expectJournalSettled(harness.files);
  });

  it("marks the local state uncertain when the rollback itself failed", async () => {
    const harness = makeGateHarness({
      hostFile: new TFile("note.md"),
      hostWrite: async (file, data, files) => {
        files.set(file.path, bytesOf(data).slice(0, 2));
      },
      initial: { "note.md": "old\n", [TEMP_PATH]: "remote\n" },
    });
    const honestWriteBinary = harness.adapter.writeBinary.bind(harness.adapter);
    harness.adapter.writeBinary = (async (target: string, bytes: ArrayBuffer) => {
      if (target === "note.md") throw new Error("rollback failed on purpose");
      return honestWriteBinary(target, bytes);
    }) as typeof harness.adapter.writeBinary;

    const error = await harness.gate(
      harness.adapter,
      "note.md",
      TEMP_PATH,
      entryFor("old\n", (await versionOf("old\n")).hash),
      await versionOf("remote\n"),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("truncated file");
    // 回放失败 ⇒ 本机停在被写坏的状态上：必须标成「内容无法确认」。
    expect((error as Error & { localStateUncertain?: boolean }).localStateUncertain).toBe(true);
    expect(DECODER.decode(harness.files.get("note.md"))).toBe("re");
    expect(harness.warnings.some((line) => line.includes("could not be rolled back"))).toBe(true);
  });

  it("keeps the atomic rename swap for paths the host cannot name", async () => {
    const harness = makeGateHarness({
      initial: { "note.md": "old\n", [TEMP_PATH]: "remote\n" },
    });

    const result = await harness.gate(
      harness.adapter,
      "note.md",
      TEMP_PATH,
      entryFor("old\n", (await versionOf("old\n")).hash),
      await versionOf("remote\n"),
    );

    expect(result).toEqual({ size: REMOTE_SIZE, mtime: 1 });
    expect(vaultRenames(harness)).toEqual([
      "note.md -> note.md.easy-sync-recovery",
      `${TEMP_PATH} -> note.md`,
    ]);
    expect(DECODER.decode(harness.files.get("note.md"))).toBe("remote\n");
    // 留底随 complete() 退休，不留在库里当孤儿副本。
    expect(harness.files.has("note.md.easy-sync-recovery")).toBe(false);
    expectJournalSettled(harness.files);
  });

  it("stops before writing when the local facts no longer match the scan", async () => {
    const harness = makeGateHarness({
      hostFile: new TFile("note.md"),
      initial: { "note.md": "changed by the user\n", [TEMP_PATH]: "remote\n" },
    });

    const error = await harness.gate(
      harness.adapter,
      "note.md",
      TEMP_PATH,
      entryFor("old\n", (await versionOf("old\n")).hash),
      await versionOf("remote\n"),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("changed before replacement");
    // 扫描事实不符时连宿主写入面都不碰，现场保持用户那份内容。
    expect(harness.hostWrites).toEqual([]);
    expect(DECODER.decode(harness.files.get("note.md"))).toBe("changed by the user\n");
    expect(harness.files.has(TEMP_PATH)).toBe(false);
  });
});
