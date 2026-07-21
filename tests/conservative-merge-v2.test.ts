import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  evaluateConservativeMergeV2,
  type ConservativeMergeInputV2,
} from "../src/sync/conservative-merge-v2";

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

async function input(
  ancestorText = "a\nb\nc\nd",
  localText = "a\nlocal-b\nc\nd",
  remoteText = "a\nb\nremote-c\nd",
): Promise<ConservativeMergeInputV2> {
  const ancestor = bytes(ancestorText);
  const local = bytes(localText);
  const remote = bytes(remoteText);
  return {
    ancestor: { bytes: ancestor, hash: await sha256Hex(ancestor) },
    local: { bytes: local, hash: await sha256Hex(local), size: local.byteLength },
    remote: {
      bytes: remote,
      hash: await sha256Hex(remote),
      size: remote.byteLength,
      remoteId: "file",
      eTag: "etag",
    },
    expectedRemoteId: "file",
    expectedRemoteETag: "etag",
    lifecycleCurrent: true,
    envelopeCommitCurrent: true,
    localVersionCurrent: true,
    remoteVersionCurrent: true,
    recoveryPending: false,
  };
}

describe("conservative merge V2 preflight", () => {
  it("returns a mutation-free clean candidate only after every version and hash check", async () => {
    const result = await evaluateConservativeMergeV2(await input());
    expect(result).toMatchObject({
      status: "ready",
      mergedText: "a\nlocal-b\nremote-c\nd",
      mergedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      mutations: [],
    });
  });

  it("routes partially overlapping hunks to manual resolution without persisting file content", async () => {
    const result = await evaluateConservativeMergeV2(await input(
      "a\nb\nc\nd",
      "a\nlocal-b\nlocal-c\nd",
      "a\nb\nremote-c\nd",
    ));
    expect(result).toMatchObject({
      status: "manual", reason: "overlap", mutations: [],
    });
    expect(result).not.toHaveProperty("preview");
  });

  it("rejects lifecycle, envelope, local, remote ID/eTag or recovery drift", async () => {
    const base = await input();
    for (const patch of [
      { lifecycleCurrent: false },
      { envelopeCommitCurrent: false },
      { localVersionCurrent: false },
      { remoteVersionCurrent: false },
      { expectedRemoteId: "other" },
      { expectedRemoteETag: "other" },
    ]) {
      await expect(evaluateConservativeMergeV2({ ...base, ...patch })).resolves.toMatchObject({
        status: "manual", reason: "stale-version", mutations: [],
      });
    }
    await expect(evaluateConservativeMergeV2({ ...base, recoveryPending: true })).resolves.toMatchObject({
      status: "manual", reason: "recovery-pending", mutations: [],
    });
  });

  it("rejects mismatched hashes and non-canonical or invalid UTF-8", async () => {
    const wrongHash = await input();
    wrongHash.local.hash = "0".repeat(64);
    await expect(evaluateConservativeMergeV2(wrongHash)).resolves.toMatchObject({
      status: "manual", reason: "invalid-hash",
    });

    const invalid = await input();
    invalid.remote.bytes = new Uint8Array([0xff]).buffer;
    invalid.remote.size = 1;
    invalid.remote.hash = await sha256Hex(invalid.remote.bytes);
    await expect(evaluateConservativeMergeV2(invalid)).resolves.toMatchObject({
      status: "manual", reason: "invalid-utf8",
    });
  });

  it("refuses oversized inputs before diff computation", async () => {
    const candidate = await input();
    candidate.local.bytes = new Uint8Array(2 * 1024 * 1024 + 1).buffer;
    candidate.local.size = candidate.local.bytes.byteLength;
    candidate.local.hash = await sha256Hex(candidate.local.bytes);
    await expect(evaluateConservativeMergeV2(candidate)).resolves.toMatchObject({
      status: "manual", reason: "too-large", mutations: [],
    });
  });

  it("preserves a shared CRLF convention in the merged bytes", async () => {
    const result = await evaluateConservativeMergeV2(await input(
      "a\r\nb\r\nc\r\nd",
      "a\r\nlocal-b\r\nc\r\nd",
      "a\r\nb\r\nremote-c\r\nd",
    ));
    expect(result).toMatchObject({
      status: "ready",
      mergedText: "a\r\nlocal-b\r\nremote-c\r\nd",
    });
  });

  it("keeps mixed or incompatible line-ending conventions manual", async () => {
    await expect(evaluateConservativeMergeV2(await input(
      "a\r\nb\r\nc\r\nd",
      "a\nlocal-b\nc\nd",
      "a\r\nb\r\nremote-c\r\nd",
    ))).resolves.toMatchObject({
      status: "manual",
      reason: "mixed-line-endings",
    });
  });

});
