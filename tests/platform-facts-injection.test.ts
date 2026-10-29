// 平台事实注入 (2026-10-28)：设备语义从注入的 `HostPlatformFacts` 读取，
// 不再依赖全局 `Platform` 单例。注入点保留，但移动端分块/流式/通道择优三层
// 已随真机反馈回退，因此这两条用例钉的是「注入的移动事实不会打开移动分支」：
// 下载一律回到单流整包（fetch → 临时文件），且「UI 移动模式 ≠ 移动 App」的
// 语义仍然分离。
import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { Platform, type DataAdapter } from "obsidian";
import { sha256Hex } from "../src/crypto";
import { OneDriveClient } from "../src/onedrive/client";
import type { HostPlatformFacts } from "../src/obsidian-compat";

const MIB = 1024 * 1024;
const GATE_BYTES = 8 * MIB;
const TARGET = "plugins/easy-sync/tmp/downloads/big.bin.part";

const MOBILE_APP_FACTS: HostPlatformFacts = {
  isDesktopApp: false,
  isMobileApp: true,
  isIosApp: false,
  isAndroidApp: true,
  isDesktop: false,
  isMobile: true,
};

/** `app.emulateMobile()` on a desktop app: UI says mobile, runtime does not. */
const UI_MOBILE_ON_DESKTOP_APP_FACTS: HostPlatformFacts = {
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isDesktop: false,
  isMobile: true,
};

let restoreWindow: () => void = () => {};

afterEach(() => {
  restoreWindow();
  restoreWindow = () => {};
  vi.restoreAllMocks();
});

function makeMemoryAdapter(): {
  adapter: DataAdapter;
  files: Map<string, ArrayBuffer>;
} {
  const files = new Map<string, ArrayBuffer>();
  const adapter = {
    async readBinary(path: string): Promise<ArrayBuffer> {
      const data = files.get(path);
      if (!data) throw new Error(`missing: ${path}`);
      return data.slice(0);
    },
    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
      files.set(path, data.slice(0));
    },
    async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
      const current = files.get(path);
      if (!current) throw new Error(`missing: ${path}`);
      const merged = new Uint8Array(current.byteLength + data.byteLength);
      merged.set(new Uint8Array(current), 0);
      merged.set(new Uint8Array(data), current.byteLength);
      files.set(path, merged.buffer as ArrayBuffer);
    },
    async remove(path: string): Promise<void> {
      files.delete(path);
    },
    async rename(from: string, to: string): Promise<void> {
      const data = files.get(from);
      if (!data) throw new Error(`missing: ${from}`);
      files.delete(from);
      files.set(to, data);
    },
    async stat(path: string): Promise<{ size: number; mtime: number } | null> {
      const data = files.get(path);
      return data ? { size: data.byteLength, mtime: 1 } : null;
    },
  };
  return { adapter: adapter as unknown as DataAdapter, files };
}

function patternBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * 31 + seed) & 0xff;
  }
  return bytes;
}

function bytesOf(source: Uint8Array): ArrayBuffer {
  return source.slice().buffer as ArrayBuffer;
}

function installWindowFetch(
  fetchImpl: (url: string) => Promise<Response>,
): { calls: string[] } {
  const previous = (globalThis as { window?: unknown }).window;
  const calls: string[] = [];
  (globalThis as { window?: unknown }).window = {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return fetchImpl(url);
    },
  };
  restoreWindow = () => {
    if (previous === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previous;
    }
  };
  return { calls };
}

describe("injected platform facts drive device semantics", () => {
  it("mobile-app facts (isMobileApp=true) no longer enable a mobile range writer", async () => {
    // The host stays the test mock's desktop default; only the injected facts
    // say "mobile app". The single-stream path is the same one the pre-chunked
    // release used, and no Range request may be issued from it.
    expect(Platform.isMobileApp).toBe(false);
    expect(Platform.isDesktopApp).toBe(true);

    const source = patternBytes(GATE_BYTES, 61);
    const expectedHash = await sha256Hex(bytesOf(source));
    const { adapter, files } = makeMemoryAdapter();
    const rangeCalls: string[] = [];
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      if (request.headers?.Range) rangeCalls.push(request.headers.Range);
      return {
        status: 200,
        headers: {},
        arrayBuffer: bytesOf(source),
      };
    });
    const fetchCalls = installWindowFetch(async () =>
      new Response(source, {
        status: 200,
        headers: { "Content-Length": String(source.byteLength) },
      })
    );

    const client = new OneDriveClient(
      async () => "token",
      undefined,
      undefined,
      undefined,
      MOBILE_APP_FACTS,
    );
    const result = await client.downloadFileToPath(
      "testVault",
      "big.bin",
      TARGET,
      adapter,
      "https://cdn.example/big.bin",
      "big-id",
      source.byteLength,
      expectedHash,
    );

    expect(result).toEqual({ size: source.byteLength, hash: expectedHash });
    // Mobile chunking is gone: the file goes through one whole-file fetch and
    // never asks for a byte range.
    expect(rangeCalls).toEqual([]);
    expect(fetchCalls.calls).toHaveLength(1);
    expect(await sha256Hex(files.get(TARGET)!)).toBe(expectedHash);
  });

  it("UI mobile mode without the mobile app (isMobile=true, isMobileApp=false) keeps the same path", async () => {
    const source = patternBytes(GATE_BYTES, 67);
    const expectedHash = await sha256Hex(bytesOf(source));
    const { adapter } = makeMemoryAdapter();
    const rangeCalls: string[] = [];
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      if (request.headers?.Range) rangeCalls.push(request.headers.Range);
      return {
        status: 200,
        headers: {},
        arrayBuffer: bytesOf(source),
      };
    });
    const fetchCalls = installWindowFetch(async () =>
      new Response(source, {
        status: 200,
        headers: { "Content-Length": String(source.byteLength) },
      })
    );

    const client = new OneDriveClient(
      async () => "token",
      undefined,
      undefined,
      undefined,
      UI_MOBILE_ON_DESKTOP_APP_FACTS,
    );
    const result = await client.downloadFileToPath(
      "testVault",
      "big.bin",
      TARGET,
      adapter,
      "https://cdn.example/big.bin",
      "big-id",
      source.byteLength,
      expectedHash,
    );

    expect(result).toEqual({ size: source.byteLength, hash: expectedHash });
    // UI mode alone must never stand in for the app fact; no mobile branch and
    // therefore no Range request either way.
    expect(rangeCalls).toEqual([]);
    expect(fetchCalls.calls).toHaveLength(1);
  });
});
