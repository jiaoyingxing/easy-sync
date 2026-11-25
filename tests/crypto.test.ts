import { describe, expect, it } from "vitest";
import { quickXorHashBase64, sha256Hex } from "../src/crypto";

const UTF8_VECTORS = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["EasySync", "8a3fea954a03ca8e7e0997745a7f307e29b94fdf7fee497f7d5b81de4424537c"],
  ["易同步", "91a4452d3b29b08c4a16c833ab5225dcb3b1b64adf3c666a023a46635767f3aa"],
] as const;

describe("shared SHA-256 primitive", () => {
  it.each(UTF8_VECTORS)("matches the published UTF-8 vector for %j", async (value, expected) => {
    expect(await sha256Hex(new TextEncoder().encode(value).buffer)).toBe(expected);
  });

  it("hashes exact binary bytes without text conversion", async () => {
    expect(await sha256Hex(new Uint8Array([0, 1, 2, 255]).buffer)).toBe(
      "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
    );
  });
});

describe("OneDrive QuickXor primitive", () => {
  it("matches the empty and live Graph probe vectors", () => {
    expect(quickXorHashBase64(new ArrayBuffer(0))).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    expect(quickXorHashBase64(new TextEncoder().encode("child").buffer)).toBe(
      "Y0BDGthABgAAAAAABQAAAAAAAAA=",
    );
  });

  it("is sensitive to byte order and length", () => {
    const first = quickXorHashBase64(new Uint8Array([1, 2, 3]).buffer);
    expect(quickXorHashBase64(new Uint8Array([3, 2, 1]).buffer)).not.toBe(first);
    expect(quickXorHashBase64(new Uint8Array([1, 2, 3, 0]).buffer)).not.toBe(first);
  });

  /**
   * The production function unrolls eight bytes at a time for speed. This
   * reference implementation is the plain per-byte form the unrolled loop must
   * reduce to; a divergence would silently corrupt local content identity.
   */
  function referenceQuickXorBase64(content: ArrayBuffer): string {
    const input = new Uint8Array(content);
    const output = new Uint8Array(20);
    const bitWidth = output.length * 8;
    let shift = 0;
    for (let index = 0; index < input.length; index += 1) {
      const byte = input[index];
      const byteOffset = shift >> 3;
      const bitOffset = shift & 7;
      output[byteOffset] ^= (byte << bitOffset) & 0xff;
      if (bitOffset !== 0) {
        output[(byteOffset + 1) % output.length] ^= byte >> (8 - bitOffset);
      }
      shift += 11;
      if (shift >= bitWidth) shift -= bitWidth;
    }
    const length = BigInt(input.byteLength);
    for (let index = 0; index < 8; index += 1) {
      output[12 + index] ^= Number((length >> BigInt(index * 8)) & 0xffn);
    }
    let binary = "";
    for (const byte of output) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  it("matches the per-byte reference on every block boundary and tail", () => {
    // Eight bytes per unrolled group, 88-bit cursor advance: cover every
    // remainder 0..8 around several full wraps of the 160-bit cursor.
    const sizes = [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      15, 16, 17, 19, 20, 21, 39, 40, 41, 63, 64, 65,
      159, 160, 161, 175, 176, 177, 255, 256, 257, 1000, 4096,
    ];
    for (const size of sizes) {
      for (const seed of [1, 37, 255]) {
        const bytes = new Uint8Array(size);
        for (let index = 0; index < size; index += 1) {
          bytes[index] = (index * seed + size * 11) & 0xff;
        }
        expect(quickXorHashBase64(bytes.buffer)).toBe(
          referenceQuickXorBase64(bytes.buffer),
        );
      }
    }
  });
});
