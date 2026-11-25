// 流式 SHA-256 的正确性与位长编码边界。
//
// 这个哈希器是两条真实传输链的唯一内容证明（移动端云端流式落盘、局域网
// 接收端分片写盘），但此前只有位长拆分的纯函数测试，摘要本身没有任何
// 行为验证。以下用例以 WebCrypto 的 SHA-256 为独立预言机，钉住分块边界、
// 填充边界和大流摘要，任何实现错误都会在这里变红。
import { describe, expect, it } from "vitest";
import { StreamingSha256, sha256BitLengthWords } from "../src/onedrive/client";

/** Independent oracle: the platform's own SHA-256, never this class. */
async function webCryptoSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  const view = new Uint8Array(digest);
  for (let index = 0; index < view.length; index += 1) {
    hex += view[index].toString(16).padStart(2, "0");
  }
  return hex;
}

/** Deterministic pseudo-random bytes so vectors are reproducible. */
function sampleBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 37 + 11) & 0xff;
  }
  return bytes;
}

function streamingDigest(
  bytes: Uint8Array,
  chunkSize: number,
): string {
  const hasher = new StreamingSha256();
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    hasher.update(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return hasher.digestHex();
}

describe("streaming sha256 digest", () => {
  it("matches the published empty and abc vectors", () => {
    const empty = new StreamingSha256();
    expect(empty.digestHex()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );

    const abc = new StreamingSha256();
    abc.update(new TextEncoder().encode("abc"));
    expect(abc.digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches WebCrypto across the 64-byte block and padding boundaries", async () => {
    // 55/56 decides one versus two padding blocks; 63/64/65 straddle the
    // final full block. These are the sizes a wrong tail buffer gets wrong.
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const bytes = sampleBytes(length);
      const expected = await webCryptoSha256(bytes);
      const hasher = new StreamingSha256();
      hasher.update(bytes);
      expect(hasher.digestHex(), `one-shot length ${length}`).toBe(expected);
    }
  });

  it("is independent of how the stream is chunked", async () => {
    const bytes = sampleBytes(200_000);
    const expected = await webCryptoSha256(bytes);
    // 1 and 3 force a tail buffer on every update; 63/64/65 straddle block
    // alignment; the rest are realistic transport frame sizes.
    for (const chunkSize of [1, 3, 63, 64, 65, 1000, 65_536, 200_000]) {
      expect(streamingDigest(bytes, chunkSize), `chunk ${chunkSize}`)
        .toBe(expected);
    }
  });

  it("hashes a multi-megabyte stream identically to the platform", async () => {
    const bytes = sampleBytes(4 * 1024 * 1024 + 123);
    const expected = await webCryptoSha256(bytes);
    expect(streamingDigest(bytes, 256 * 1024)).toBe(expected);
    expect(streamingDigest(bytes, 1024 * 1024)).toBe(expected);
  });
});

describe("streaming sha256 padding length", () => {
  it("keeps the high word zero below 2^32 bits", () => {
    expect(sha256BitLengthWords(0)).toEqual([0, 0]);
    expect(sha256BitLengthWords(3)).toEqual([0, 24]);
    expect(sha256BitLengthWords(512 * 1024 * 1024 - 1)).toEqual([0, 0xfffffff8]);
  });

  it("carries the high word once the stream reaches 2^32 bits", () => {
    expect(sha256BitLengthWords(512 * 1024 * 1024)).toEqual([1, 0]);
    expect(sha256BitLengthWords(512 * 1024 * 1024 + 1)).toEqual([1, 8]);
    expect(sha256BitLengthWords(1024 * 1024 * 1024)).toEqual([2, 0]);
  });
});
