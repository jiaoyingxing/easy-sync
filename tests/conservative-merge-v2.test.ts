import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  createTextMergeManualEvidenceV1,
  evaluateConservativeMergeV2,
  matchingTextMergeManualEvidenceV1,
  type ConservativeMergeInputV2,
  type TextMergeEvidenceIdentityV1,
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

async function evidenceIdentity(): Promise<TextMergeEvidenceIdentityV1> {
  const ancestor = bytes("ancestor\n");
  const local = bytes("local\n");
  const remote = bytes("remote\n");
  return {
    scope: {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "files",
    },
    ancestor: {
      path: "note.md",
      hash: await sha256Hex(ancestor),
      size: ancestor.byteLength,
      eTag: "ancestor-etag",
    },
    local: {
      path: "note.md",
      hash: await sha256Hex(local),
      size: local.byteLength,
      mtime: 1,
      binary: false,
    },
    remote: {
      path: "note.md",
      driveId: "remote-file",
      size: remote.byteLength,
      mtime: 2,
      eTag: "remote-etag",
      cTag: "remote-ctag",
      sha256Hash: await sha256Hex(remote),
    },
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

  it("reuses only well-formed manual evidence bound to every exact source", async () => {
    const identity = await evidenceIdentity();
    const evidence = createTextMergeManualEvidenceV1(
      identity,
      "overlap",
      identity.remote.sha256Hash!,
    );
    expect(matchingTextMergeManualEvidenceV1(evidence, identity)).toEqual(evidence);

    const mismatches: TextMergeEvidenceIdentityV1[] = [
      {
        ...identity,
        scope: { ...identity.scope, accountId: "other-account" },
      },
      {
        ...identity,
        ancestor: { ...identity.ancestor, hash: "1".repeat(64) },
      },
      {
        ...identity,
        local: { ...identity.local, hash: "2".repeat(64) },
      },
      {
        ...identity,
        remote: { ...identity.remote, driveId: "other-file" },
      },
      {
        ...identity,
        remote: { ...identity.remote, eTag: "other-etag" },
      },
      {
        ...identity,
        remote: { ...identity.remote, sha256Hash: "3".repeat(64) },
      },
    ];
    for (const mismatch of mismatches) {
      expect(matchingTextMergeManualEvidenceV1(evidence, mismatch)).toBeNull();
    }
    expect(matchingTextMergeManualEvidenceV1(
      { ...evidence, algorithm: "future-merge" },
      identity,
    )).toBeNull();
    expect(matchingTextMergeManualEvidenceV1(
      { ...evidence, remoteHash: "corrupt" },
      identity,
    )).toBeNull();
  });

  it("does not cache transient or integrity-related manual outcomes", async () => {
    const identity = await evidenceIdentity();
    for (const reason of ["stale-version", "recovery-pending", "invalid-hash"] as const) {
      expect(createTextMergeManualEvidenceV1(
        identity,
        reason,
        identity.remote.sha256Hash!,
      )).toBeNull();
    }
  });

});
