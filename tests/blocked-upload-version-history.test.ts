/**
 * Blocked-upload diagnostics (2026-10-13 field case).
 *
 * Two read-only evidence surfaces were added after the `iphone-test-vault`
 * incident (a self-sync `main.js` upload whose receipt was lost):
 *
 *  - the existing "blocked upload evidence" line now carries the remote-side
 *    dimensions needed to read it at a glance (size / sha / eTag / write
 *    sequence / whether the remote is still the base or still our content);
 *  - a bounded version-history probe answers what the current facts cannot:
 *    "did our write land, and did someone replace it afterwards?" The field
 *    history below is the real thing, read from that incident's cloud folder.
 *
 * Both are diagnostics only: they never settle a record, so these tests also
 * pin that no settlement path is touched.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OneDriveClient } from "../src/onedrive/client";
import type { DriveItemVersion } from "../src/onedrive/types";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { RemoteNodeV2 } from "../src/sync/remote-index-v2";
import type { StateManager } from "../src/sync/state-manager";
import type { SyncScope } from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import {
  BlockedUploadVersionHistoryProbe,
  buildBlockedUploadRemoteFacts,
  buildVersionHistoryEvidence,
  computeETagVersionDelta,
  parseDriveItemETagVersion,
} from "../src/sync/blocked-upload-version-history";
import type { MutationIntent, MutationIntentV1 } from "../src/sync/types";

/** Read (read-only Graph probe) from the 2026-10-13 incident's cloud folder:
 *  version 356.0 carries exactly the size the desktop tried to upload at
 *  2026-10-12 21:22:15; 357.0 is the overwrite another device pushed later. */
const FIELD_MAIN_JS_VERSIONS: DriveItemVersion[] = [
  {
    id: "357.0",
    size: 3237938,
    lastModifiedDateTime: "2026-10-13T02:12:56Z",
    lastModifiedBy: { user: { displayName: "应行 焦" } },
  },
  {
    id: "356.0",
    size: 3230255,
    lastModifiedDateTime: "2026-10-12T13:22:18Z",
    lastModifiedBy: { user: { displayName: "应行 焦" } },
  },
  {
    id: "355.0",
    size: 3229920,
    lastModifiedDateTime: "2026-10-12T11:27:31Z",
    lastModifiedBy: { user: { displayName: "应行 焦" } },
  },
];

const INTENT_CREATED_AT = Date.parse("2026-10-12T21:22:15+08:00");
const FIELD_PATH = ".obsidian/plugins/easy-sync/main.js";

function makeIntent(
  overrides: Partial<MutationIntentV1> = {},
): MutationIntentV1 {
  return {
    version: 1,
    operationId: "field-upload-op",
    planRevision: 148,
    scope: {
      accountId: "account-id",
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    } as SyncScope,
    action: "upload",
    path: FIELD_PATH,
    expectedLocal: { exists: true, hash: "b".repeat(64), size: 3230255 },
    expectedRemote: {
      exists: true,
      driveId: "main-js-id",
      eTag: "\"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},355\"",
      size: 3229920,
    },
    createdAt: INTENT_CREATED_AT,
    ...overrides,
  };
}

function makeDiag(log: (message: string, data: unknown) => void) {
  return {
    log,
    warn: vi.fn(),
    error: vi.fn(),
    isEnabled: vi.fn().mockReturnValue(true),
  } as unknown as DiagnosticLogger;
}

describe("blocked upload remote facts (C2)", () => {
  it("reads the field incident's remote node into one self-contained payload", () => {
    const node: RemoteNodeV2 = {
      id: "main-js-id",
      parentId: "files-root-id",
      name: "main.js",
      kind: "file",
      size: 3237938,
      mtime: Date.parse("2026-10-13T02:12:56Z"),
      eTag: "\"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},357\"",
      contentHash: "e".repeat(64),
    };

    expect(buildBlockedUploadRemoteFacts(node, makeIntent())).toEqual({
      intentExpectedLocalSize: 3230255,
      remoteSize: 3237938,
      remoteSha256: "e".repeat(64),
      remoteETag: "\"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},357\"",
      remoteVersion: 357,
      remoteVersionDelta: 2,
      remoteMatchesExpectedRemote: false,
      remoteMatchesIntendedLocal: false,
    });
  });

  it("marks a remote that still is the recorded base and still our content", () => {
    const node: RemoteNodeV2 = {
      id: "main-js-id",
      parentId: "files-root-id",
      name: "main.js",
      kind: "file",
      size: 3230255,
      mtime: INTENT_CREATED_AT,
      eTag: "\"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},356\"",
      contentHash: "b".repeat(64),
    };
    const facts = buildBlockedUploadRemoteFacts(
      node,
      makeIntent({
        expectedRemote: {
          exists: true,
          driveId: "main-js-id",
          eTag: "\"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},356\"",
          size: 3230255,
        },
      }),
    );

    expect(facts.remoteMatchesExpectedRemote).toBe(true);
    expect(facts.remoteMatchesIntendedLocal).toBe(true);
    expect(facts.remoteVersionDelta).toBe(0);
  });

  it("keeps the hash gate when the index carries one, and sizes alone otherwise", () => {
    const base = {
      id: "main-js-id",
      parentId: "files-root-id",
      name: "main.js",
      kind: "file" as const,
      size: 3230255,
    };

    expect(buildBlockedUploadRemoteFacts(
      { ...base, contentHash: "c".repeat(64) },
      makeIntent(),
    ).remoteMatchesIntendedLocal).toBe(false);
    expect(buildBlockedUploadRemoteFacts(base, makeIntent())
      .remoteMatchesIntendedLocal).toBe(true);
  });

  it("reports an absent node without inventing remote facts", () => {
    const facts = buildBlockedUploadRemoteFacts(undefined, makeIntent());

    expect(facts.remoteSize).toBeUndefined();
    expect(facts.remoteSha256).toBeUndefined();
    expect(facts.remoteVersion).toBeNull();
    expect(facts.remoteVersionDelta).toBeUndefined();
    expect(facts.remoteMatchesExpectedRemote).toBe(false);
    expect(facts.remoteMatchesIntendedLocal).toBe(false);
  });

  it("parses eTag write sequences and their delta", () => {
    expect(parseDriveItemETagVersion(
      "\"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},355\"",
    )).toBe(355);
    expect(parseDriveItemETagVersion("etag-1")).toBeNull();
    expect(parseDriveItemETagVersion(undefined)).toBeNull();
    expect(computeETagVersionDelta(
      "\"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},357\"",
      "\"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},355\"",
    )).toBe(2);
    expect(computeETagVersionDelta("etag-1", "etag-0")).toBeUndefined();
    expect(computeETagVersionDelta(undefined, "etag-0")).toBeUndefined();
  });
});

describe("blocked upload version history (C8)", () => {
  it("reads the intended write and the later overwrite out of field history", () => {
    const evidence = buildVersionHistoryEvidence(
      FIELD_MAIN_JS_VERSIONS,
      makeIntent(),
    );

    expect(evidence.retainedCount).toBe(3);
    expect(evidence.newest.map((entry) => entry.versionId)).toEqual([
      "357.0",
      "356.0",
      "355.0",
    ]);
    expect(evidence.intendedSizeSeen).toBe(true);
    expect(evidence.intendedSizeVersionId).toBe("356.0");
    expect(evidence.intendedSizeVersionAtMs).toBe(
      Date.parse("2026-10-12T13:22:18Z"),
    );
    expect(evidence.versionsAtOrAfterIntent).toBe(2);
  });

  it("sorts defensively and caps the payload", () => {
    const versions: DriveItemVersion[] = Array.from({ length: 12 }, (_, i) => ({
      id: `${200 + i}.0`,
      size: 100 + i,
      lastModifiedDateTime: new Date(
        Date.parse("2026-10-01T00:00:00Z") + i * 60_000,
      ).toISOString(),
    })).reverse();
    const evidence = buildVersionHistoryEvidence(versions, makeIntent());

    expect(evidence.retainedCount).toBe(12);
    expect(evidence.newest).toHaveLength(8);
    expect(evidence.newest[0].versionId).toBe("211.0");
  });

  it("reports an absent intended version instead of guessing one", () => {
    const evidence = buildVersionHistoryEvidence(
      FIELD_MAIN_JS_VERSIONS,
      makeIntent({
        expectedLocal: { exists: true, hash: "d".repeat(64), size: 999999 },
      }),
    );

    expect(evidence.intendedSizeSeen).toBe(false);
    expect(evidence.intendedSizeVersionId).toBeNull();
    expect(evidence.intendedSizeVersionAtMs).toBeNull();
  });

  it("treats an empty history as a valid answer", () => {
    const evidence = buildVersionHistoryEvidence([], makeIntent());

    expect(evidence.retainedCount).toBe(0);
    expect(evidence.intendedSizeSeen).toBe(false);
    expect(evidence.versionsAtOrAfterIntent).toBe(0);
  });

  it("probes at most once per operation", async () => {
    const listVersions = vi.fn(async () => FIELD_MAIN_JS_VERSIONS);
    const log = vi.fn();
    const probe = new BlockedUploadVersionHistoryProbe({
      listVersions,
      isLoggingEnabled: () => true,
      log,
    });

    await probe.probe(makeIntent());
    await probe.probe(makeIntent());

    expect(listVersions).toHaveBeenCalledTimes(1);
    expect(listVersions).toHaveBeenCalledWith("main-js-id");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "blocked upload version history",
      expect.objectContaining({
        operationId: "field-upload-op",
        path: FIELD_PATH,
        expectedLocalSize: 3230255,
        intendedSizeSeen: true,
        intendedSizeVersionId: "356.0",
        mutations: 0,
      }),
    );
  });

  it("retries a failed probe instead of losing the evidence", async () => {
    const listVersions = vi
      .fn()
      .mockRejectedValueOnce(new Error("graph down"))
      .mockResolvedValueOnce(FIELD_MAIN_JS_VERSIONS);
    const log = vi.fn();
    const probe = new BlockedUploadVersionHistoryProbe({
      listVersions,
      isLoggingEnabled: () => true,
      log,
    });

    await probe.probe(makeIntent());
    await probe.probe(makeIntent());

    expect(listVersions).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "blocked upload version history unavailable",
      expect.objectContaining({ reason: "graph down", mutations: 0 }),
    );
    expect(log).toHaveBeenCalledWith(
      "blocked upload version history",
      expect.objectContaining({ intendedSizeVersionId: "356.0" }),
    );
  });

  it("never spends an API call when diagnostic logging is off", async () => {
    const listVersions = vi.fn(async () => FIELD_MAIN_JS_VERSIONS);
    const log = vi.fn();
    const probe = new BlockedUploadVersionHistoryProbe({
      listVersions,
      isLoggingEnabled: () => false,
      log,
    });

    await probe.probe(makeIntent());

    expect(listVersions).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("gives up on a slow probe without touching the blocked record", async () => {
    const log = vi.fn();
    const probe = new BlockedUploadVersionHistoryProbe({
      listVersions: () => new Promise<DriveItemVersion[]>(() => undefined),
      isLoggingEnabled: () => true,
      log,
      timeoutMs: 1,
    });

    await probe.probe(makeIntent());

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "blocked upload version history unavailable",
      expect.objectContaining({ reason: "timeout", mutations: 0 }),
    );
  });

  it("skips non-upload records and records without a remote identity", async () => {
    const listVersions = vi.fn(async () => FIELD_MAIN_JS_VERSIONS);
    const log = vi.fn();
    const probe = new BlockedUploadVersionHistoryProbe({
      listVersions,
      isLoggingEnabled: () => true,
      log,
    });

    await probe.probe(makeIntent({ action: "download" }));
    await probe.probe(makeIntent({ expectedRemote: { exists: false } }));

    expect(listVersions).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("blocked upload evidence wiring through the executor (C2 + C8)", () => {
  it("starts the probe from both blocked-upload exits", () => {
    // Wiring check, deliberately structural: the two blocked-upload exits in
    // settlement own this call (deleting either turns this red). The probe's
    // own behaviour is covered above; the executor-to-client seam is below.
    const source = readFileSync("src/sync/sync-executor.ts", "utf8");
    const evidenceCalls = source.match(
      /this\.logBlockedMutationEvidence\(record\);/g,
    ) ?? [];
    const probeCalls = source.match(
      /await this\.blockedUploadVersionHistory\.probe\(record\.intent\);/g,
    ) ?? [];

    expect(evidenceCalls).toHaveLength(2);
    expect(probeCalls).toHaveLength(2);
  });

  it("wires the probe to the read-only client call and the diag sink", async () => {
    const listVersions = vi.fn(async () => FIELD_MAIN_JS_VERSIONS);
    const log = vi.fn();
    const onedrive = {
      listDriveItemVersionsById: listVersions,
    } as unknown as OneDriveClient;
    const scanner = {
      vault: {
        configDir: ".obsidian",
        adapter: {},
        getFiles: () => [],
        getName: () => "testVault",
      },
    } as unknown as LocalScanner;
    const executor = new SyncExecutor(
      onedrive,
      scanner,
      {} as unknown as StateManager,
      "testVault",
      undefined,
      undefined,
      makeDiag(log),
    );

    await (executor as unknown as {
      blockedUploadVersionHistory: {
        probe(intent: MutationIntent): Promise<void>;
      };
    }).blockedUploadVersionHistory.probe(makeIntent());

    expect(listVersions).toHaveBeenCalledWith(
      "main-js-id",
      "blockedRecoveryVersionHistory",
    );
    expect(log).toHaveBeenCalledWith(
      "state",
      "blocked upload version history",
      expect.objectContaining({
        intendedSizeSeen: true,
        intendedSizeVersionId: "356.0",
      }),
    );
  });
});

describe("OneDriveClient.listDriveItemVersionsById", () => {
  const readBody = (value: unknown) =>
    JSON.stringify({ value });

  it("asks for the item's versions and returns the retained list", async () => {
    const { requestUrl } = await import("obsidian");
    const requestSpy = vi.spyOn(
      await import("obsidian"),
      "requestUrl",
    ).mockResolvedValue({
      status: 200,
      headers: {},
      json: JSON.parse(readBody(FIELD_MAIN_JS_VERSIONS)),
      text: "",
      arrayBuffer: new ArrayBuffer(0),
    } as never);
    const client = new OneDriveClient(async () => "token");

    const versions = await client.listDriveItemVersionsById(
      "main-js-id",
      "blockedRecoveryVersionHistory",
    );

    expect(versions).toHaveLength(3);
    expect(versions[0]).toMatchObject({ id: "357.0", size: 3237938 });
    const request = requestSpy.mock.calls[0][0];
    expect(request.url).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/items/main-js-id/versions",
    );
    expect(requestUrl).toBeDefined();
    requestSpy.mockRestore();
  });

  it("answers an empty list for a missing item and for a shapeless body", async () => {
    const obsidianModule = await import("obsidian");
    const requestSpy = vi.spyOn(obsidianModule, "requestUrl");
    const client = new OneDriveClient(async () => "token");

    requestSpy.mockResolvedValue({
      status: 404,
      headers: {},
      json: { error: { code: "itemNotFound", message: "missing" } },
      text: "",
      arrayBuffer: new ArrayBuffer(0),
    } as never);
    await expect(client.listDriveItemVersionsById("gone-id"))
      .resolves.toEqual([]);

    requestSpy.mockResolvedValue({
      status: 200,
      headers: {},
      json: { unexpected: true },
      text: "",
      arrayBuffer: new ArrayBuffer(0),
    } as never);
    await expect(client.listDriveItemVersionsById("odd-id"))
      .resolves.toEqual([]);
    requestSpy.mockRestore();
  });

  it("surfaces a transport failure instead of inventing history", async () => {
    const obsidianModule = await import("obsidian");
    const requestSpy = vi.spyOn(obsidianModule, "requestUrl")
      .mockRejectedValue(new Error("network down"));
    const client = new OneDriveClient(async () => "token");

    await expect(client.listDriveItemVersionsById("busy-id"))
      .rejects.toBeInstanceOf(OneDriveError);
    requestSpy.mockRestore();
  });
});
