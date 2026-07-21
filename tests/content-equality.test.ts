import { describe, expect, it } from "vitest";
import {
  compareContentBuffers,
  resolveContentEquality,
} from "../src/sync/content-equality";

describe("content equality evidence", () => {
  it("uses a remote SHA-256 without downloading content", () => {
    expect(resolveContentEquality({
      local: { hash: "aa".repeat(32), size: 4 },
      remote: { sha256Hash: "AA".repeat(32), size: 4, eTag: "remote" },
    })).toEqual({ status: "equal", proof: "remoteSha256" });
  });

  it("reuses the committed base when the remote eTag is unchanged", () => {
    expect(resolveContentEquality({
      local: { hash: "bb".repeat(32), size: 8 },
      remote: { size: 8, eTag: "same-etag" },
      base: { hash: "bb".repeat(32), size: 8, eTag: "same-etag" },
    })).toEqual({ status: "equal", proof: "baseETag" });
  });

  it("returns unknown instead of treating matching size as matching content", () => {
    expect(resolveContentEquality({
      local: { hash: "aa".repeat(32), size: 4 },
      remote: { size: 4, eTag: "remote" },
    })).toEqual({ status: "unknown", proof: "insufficientEvidence" });
  });

  it("distinguishes exact bytes from decoded text that only looks identical", async () => {
    const exact = await compareContentBuffers(
      new Uint8Array([1, 2, 3]).buffer,
      new Uint8Array([1, 2, 3]).buffer,
    );
    expect(exact).toMatchObject({ status: "equal", decodedTextEqual: true });

    const replacementA = await compareContentBuffers(
      new Uint8Array([0x80]).buffer,
      new Uint8Array([0x81]).buffer,
    );
    expect(replacementA).toMatchObject({
      status: "different",
      decodedTextEqual: true,
    });
    expect(replacementA.localHash).not.toBe(replacementA.remoteHash);
  });
});
