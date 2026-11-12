// 流式 SHA-256 的位长编码边界。
// 512 MiB 恰好是 2^32 位：这是只写低 32 位就会算错的第一个尺寸（默认上限
// 512 MiB 的文件正好可达），故用纯函数直接钉住两个字的拆分。
import { describe, expect, it } from "vitest";
import { sha256BitLengthWords } from "../src/onedrive/client";

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
