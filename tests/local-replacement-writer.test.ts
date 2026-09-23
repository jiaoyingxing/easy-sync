import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { sha256Hex } from "../src/crypto";
import {
  LocalReplacementVerificationError,
  writeReplacementInPlace,
} from "../src/sync/local-replacement-writer";

/**
 * 覆盖下载的原地替换合同（F12 改造）：宿主看得见的文件必须原地写，不得改名。
 * ① 规范 UTF-8 走宿主写入接口（`vault.modify`）；
 * ② 非规范字节 / 无宿主写入接口时走底层原地写，仍逐字节保真；
 * ③ 写后按磁盘状态分档判定（`DECISIONS` 2026-09-23 第 9 点）：我们写入的内容
 *    原样落地或后面被宿主追加了未保存的行都算落地；只剩前缀＝我们自己写坏了，
 *    回放旧内容；磁盘还是旧版本＝同轮重试一次；认不出来＝现场不动交调用方延后。
 */
function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function createAdapter(initial: Record<string, ArrayBuffer> = {}) {
  const files = new Map<string, ArrayBuffer>(Object.entries(initial));
  const calls = { rename: 0, write: 0, read: 0 };
  const adapter = {
    async stat(path: string) {
      const data = files.get(path);
      return data ? { size: data.byteLength, mtime: 1 } : null;
    },
    async readBinary(path: string) {
      calls.read += 1;
      const data = files.get(path);
      if (!data) throw new Error(`missing: ${path}`);
      return data;
    },
    async writeBinary(path: string, data: ArrayBuffer) {
      calls.write += 1;
      files.set(path, data);
    },
    async exists(path: string) {
      return files.has(path);
    },
    async remove(path: string) {
      files.delete(path);
    },
    async rename(from: string, to: string) {
      calls.rename += 1;
      const data = files.get(from);
      if (!data) throw new Error(`missing: ${from}`);
      files.delete(from);
      files.set(to, data);
    },
  };
  return { adapter, files, calls };
}

async function versionOf(text: string) {
  const bytes = bytesOf(text);
  return { hash: await sha256Hex(bytes), size: bytes.byteLength };
}

describe("writeReplacementInPlace", () => {
  it("writes an open note through the host surface without renaming the target", async () => {
    const { adapter, files, calls } = createAdapter({ "note.md": bytesOf("old\n") });
    const file = new TFile("note.md");
    const modified: string[] = [];
    const modify = async (target: TFile, data: string) => {
      modified.push(data);
      files.set(target.path, bytesOf(data));
    };

    const outcome = await writeReplacementInPlace({
      file,
      modify,
      adapter: adapter as never,
      targetPath: "note.md",
      content: bytesOf("new\n"),
      expectedVersion: await versionOf("new\n"),
    });

    expect(outcome.via).toBe("host-modify");
    expect(modified).toEqual(["new\n"]);
    expect(new TextDecoder().decode(files.get("note.md"))).toBe("new\n");
    expect(calls.rename).toBe(0);
  });

  it("keeps binary bytes off the text surface even for a host-visible file", async () => {
    const { adapter, files, calls } = createAdapter({ "assets/photo.png": bytesOf("old") });
    const file = new TFile("assets/photo.png");
    // 0xC3 单独出现＝非法 UTF-8 序列，解码再编码会被规范化，必须走字节通道。
    const content = new Uint8Array([0x61, 0xc3, 0x62]).buffer;

    const outcome = await writeReplacementInPlace({
      file,
      modify: () => { throw new Error("must not be used for non-canonical bytes"); },
      adapter: adapter as never,
      targetPath: "assets/photo.png",
      content,
      expectedVersion: { hash: await sha256Hex(content), size: content.byteLength },
    });

    expect(outcome.via).toBe("adapter-write");
    expect(new Uint8Array(files.get("assets/photo.png")!)).toEqual(new Uint8Array(content));
    expect(calls.rename).toBe(0);
  });

  it("falls back to the adapter when the host exposes no write surface", async () => {
    const { adapter, files, calls } = createAdapter({ "note.md": bytesOf("old\n") });
    const outcome = await writeReplacementInPlace({
      file: new TFile("note.md"),
      adapter: adapter as never,
      targetPath: "note.md",
      content: bytesOf("new\n"),
      expectedVersion: await versionOf("new\n"),
    });

    expect(outcome.via).toBe("adapter-write");
    expect(new TextDecoder().decode(files.get("note.md"))).toBe("new\n");
    expect(calls.rename).toBe(0);
  });

  it("retries a write that landed empty and then verifies the bytes", async () => {
    const { adapter, files, calls } = createAdapter({ "assets/photo.png": bytesOf("old") });
    let attempts = 0;
    const flakyAdapter = {
      ...adapter,
      async writeBinary(path: string, data: ArrayBuffer) {
        attempts += 1;
        calls.write += 1;
        files.set(path, attempts === 1 ? new ArrayBuffer(0) : data);
      },
    };

    const outcome = await writeReplacementInPlace({
      file: new TFile("assets/photo.png"),
      adapter: flakyAdapter as never,
      targetPath: "assets/photo.png",
      content: bytesOf("payload"),
      expectedVersion: await versionOf("payload"),
      maxAttempts: 3,
    });

    expect(attempts).toBe(2);
    expect(outcome.attempts).toBe(2);
    expect(new TextDecoder().decode(files.get("assets/photo.png"))).toBe("payload");
  });

  it("puts the previous bytes back when our own write landed truncated", async () => {
    const previous = bytesOf("old\n");
    const { adapter, files, calls } = createAdapter({ "note.md": previous });
    let writes = 0;
    const truncatedAdapter = {
      ...adapter,
      // 模拟写到一半被切断 / 平台静默截断：首次写入只剩内容的前缀；
      // 之后的写入（含旧内容回放）正常落盘。
      async writeBinary(path: string, data: ArrayBuffer) {
        writes += 1;
        calls.write += 1;
        files.set(
          path,
          writes === 1 ? data.slice(0, Math.max(1, Math.floor(data.byteLength / 2))) : data,
        );
      },
    };

    await expect(writeReplacementInPlace({
      file: new TFile("note.md"),
      adapter: truncatedAdapter as never,
      targetPath: "note.md",
      content: bytesOf("remote-version\n"),
      previousBytes: previous,
      expectedVersion: await versionOf("remote-version\n"),
      maxAttempts: 1,
    })).rejects.toMatchObject({
      name: "LocalReplacementTruncatedError",
      restoredPrevious: true,
    });

    // 用户文件绝不能停在半截：旧内容已经放回。
    expect(new TextDecoder().decode(files.get("note.md"))).toBe("old\n");
    expect(calls.rename).toBe(0);
  });

  it("keeps the damaged state when no previous bytes are available to restore", async () => {
    const { adapter, files, calls } = createAdapter({ "note.md": bytesOf("old\n") });
    const truncatedAdapter = {
      ...adapter,
      async writeBinary(path: string, data: ArrayBuffer) {
        calls.write += 1;
        files.set(path, data.slice(0, Math.max(1, Math.floor(data.byteLength / 2))));
      },
    };

    await expect(writeReplacementInPlace({
      file: new TFile("note.md"),
      adapter: truncatedAdapter as never,
      targetPath: "note.md",
      content: bytesOf("remote-version\n"),
      expectedVersion: await versionOf("remote-version\n"),
      maxAttempts: 1,
    })).rejects.toMatchObject({
      name: "LocalReplacementTruncatedError",
      restoredPrevious: false,
    });

    // 无旧内容可放回时保持原样并如实报告（调用方据此保留未决证据）。
    expect(new TextDecoder().decode(files.get("note.md"))).toBe("remote-");
    expect(calls.rename).toBe(0);
  });

  it("records the host's merge of unsaved text as a landed write", async () => {
    const { adapter, files, calls } = createAdapter({ "note.md": bytesOf("old\n") });
    const merged = "remote\nuser typed\n";
    const file = new TFile("note.md");
    // 宿主在写入后立刻把「远端内容 + 未保存行」的合并结果写回磁盘。
    const modify = async (target: TFile) => {
      files.set(target.path, bytesOf(merged));
    };

    const outcome = await writeReplacementInPlace({
      file,
      modify,
      adapter: adapter as never,
      targetPath: "note.md",
      content: bytesOf("remote\n"),
      previousBytes: bytesOf("old\n"),
      expectedVersion: await versionOf("remote\n"),
    });

    // ② 我们写的那份 + 宿主追加的未保存行：写入算落地，合并结果留在磁盘上，
    // 调用方据此把基线记成云端版本，下一轮按「本机改动」上传合并结果。
    expect(outcome.arm).toBe("merged-tail");
    expect(outcome.appendedBytes).toBe(bytesOf("user typed\n").byteLength);
    expect(outcome.attempts).toBe(1);
    expect(new TextDecoder().decode(files.get("note.md"))).toBe(merged);
    expect(calls.rename).toBe(0);
  });

  it("retries once when the write left the old version, then reports it", async () => {
    const previous = bytesOf("old\n");
    const { adapter, files, calls } = createAdapter({ "note.md": previous });
    let writes = 0;
    const noopAdapter = {
      ...adapter,
      async writeBinary() {
        writes += 1;
        calls.write += 1;
      },
    };

    const error = await writeReplacementInPlace({
      file: new TFile("note.md"),
      adapter: noopAdapter as never,
      targetPath: "note.md",
      content: bytesOf("remote\n"),
      previousBytes: previous,
      expectedVersion: await versionOf("remote\n"),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LocalReplacementVerificationError);
    expect(error).toMatchObject({ arm: "previous", observedSize: previous.byteLength });

    // ④ 同轮内有界重试一次，仍不成即按延后处置；旧内容原样留在磁盘上。
    expect(writes).toBe(2);
    expect(new TextDecoder().decode(files.get("note.md"))).toBe("old\n");
    expect(calls.rename).toBe(0);
  });

  it("reads the untouched old version as a miss even when it extends our bytes", async () => {
    // 远端版本恰好是旧版本的前缀（另一端删掉了尾部）时，没落地的旧版本也满足「我们写入
    // 内容的严格前缀 + 后面多了东西」的形状。判档顺序把这一格读成「宿主合并」就会记成功
    // 并把基线记成远端版本，下一轮再把它当本机改动传上去＝把用户的「保留云端」反过来执行。
    const previous = bytesOf("remote\nlocal tail\n");
    const { adapter, files, calls } = createAdapter({ "note.md": previous });
    let writes = 0;
    const noopAdapter = {
      ...adapter,
      async writeBinary() {
        writes += 1;
        calls.write += 1;
      },
    };

    const error = await writeReplacementInPlace({
      file: new TFile("note.md"),
      adapter: noopAdapter as never,
      targetPath: "note.md",
      content: bytesOf("remote\n"),
      previousBytes: previous,
      expectedVersion: await versionOf("remote\n"),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LocalReplacementVerificationError);
    expect(error).toMatchObject({ arm: "previous", observedSize: previous.byteLength });
    expect(writes).toBe(2);
    expect(new TextDecoder().decode(files.get("note.md"))).toBe("remote\nlocal tail\n");
    expect(calls.rename).toBe(0);
  });

  it("stops without rewriting when the target holds unattributable content", async () => {
    const { adapter, files, calls } = createAdapter({ "note.md": bytesOf("old\n") });
    let writes = 0;
    const foreignAdapter = {
      ...adapter,
      async writeBinary(path: string) {
        writes += 1;
        calls.write += 1;
        files.set(path, bytesOf("written by someone else\n"));
      },
    };

    await expect(writeReplacementInPlace({
      file: new TFile("note.md"),
      adapter: foreignAdapter as never,
      targetPath: "note.md",
      content: bytesOf("remote\n"),
      previousBytes: bytesOf("old\n"),
      expectedVersion: await versionOf("remote\n"),
    })).rejects.toMatchObject({
      name: "LocalReplacementVerificationError",
      arm: "unattributed",
    });

    // ⑤ 认不出来就不写第二遍：现场保留第三方内容，交给调用方延后。
    expect(writes).toBe(1);
    expect(new TextDecoder().decode(files.get("note.md"))).toBe("written by someone else\n");
    expect(calls.rename).toBe(0);
  });

  it("does not retry a write that threw, and keeps the failure for diagnostics", async () => {
    const previous = bytesOf("old\n");
    const { adapter, files, calls } = createAdapter({ "note.md": previous });
    const failure = new Error("permission denied");
    let writes = 0;
    const throwingAdapter = {
      ...adapter,
      async writeBinary() {
        writes += 1;
        calls.write += 1;
        throw failure;
      },
    };

    await expect(writeReplacementInPlace({
      file: new TFile("note.md"),
      adapter: throwingAdapter as never,
      targetPath: "note.md",
      content: bytesOf("remote\n"),
      previousBytes: previous,
      expectedVersion: await versionOf("remote\n"),
    })).rejects.toMatchObject({
      name: "LocalReplacementVerificationError",
      arm: "previous",
      writeFailure: failure,
    });

    expect(writes).toBe(1);
    expect(new TextDecoder().decode(files.get("note.md"))).toBe("old\n");
    expect(calls.rename).toBe(0);
  });

  it("never treats an empty download as merged with whatever the disk holds", async () => {
    const previous = bytesOf("old\n");
    const { adapter, files, calls } = createAdapter({ "note.md": previous });
    const noopAdapter = {
      ...adapter,
      async writeBinary() {
        calls.write += 1;
      },
    };

    // 云端版本是空文件、写入没落地：磁盘上的旧内容不能当作「空内容 + 宿主追加」，
    // 否则下一轮会把旧内容当成新的本机改动传回云端。
    await expect(writeReplacementInPlace({
      file: new TFile("note.md"),
      adapter: noopAdapter as never,
      targetPath: "note.md",
      content: new ArrayBuffer(0),
      previousBytes: previous,
      expectedVersion: await versionOf(""),
    })).rejects.toMatchObject({
      name: "LocalReplacementVerificationError",
      arm: "previous",
    });

    expect(new TextDecoder().decode(files.get("note.md"))).toBe("old\n");
    expect(calls.rename).toBe(0);
  });
});
