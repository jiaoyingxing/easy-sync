import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";

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
