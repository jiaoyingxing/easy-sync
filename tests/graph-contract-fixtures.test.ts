import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  GRAPH_DELTA_PAGES,
  GRAPH_MUTATION_CONTRACTS,
  GRAPH_UPLOAD_SESSION_FIXTURES,
  collapseDeltaById,
} from "./fixtures/graph-contract-cases";
import type { DriveItem } from "../src/onedrive/types";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";

describe("Graph preflight contract fixtures", () => {
  it("preserves the redacted live quota-read versus namespace-create contradiction", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/graph-live-preflight-20260717.json",
      "utf8",
    ));

    expect(fixture.preflight).toEqual({ quota: "pass", namespaceCreate: "blocked" });
    expect(fixture.fatal).toMatchObject({ status: 507, code: "quotaLimitReached" });
    expect(fixture.readDiagnostics).toMatchObject({
      driveType: "personal",
      quotaState: "normal",
      remainingBucket: "ge-1GiB",
      usedRatioBucket: "lt-90pct",
      deletedPositive: false,
      appRootReportedChildCount: 1,
    });
    expect(fixture.fileCreateDiagnostic).toEqual({
      transport: "uploadSession",
      conflictBehavior: "fail",
      payloadBytes: 1,
      sessionStatus: 507,
      sessionCode: "quotaLimitReached",
      uploadStarted: false,
      itemCreated: false,
      cleanupRequired: false,
    });
    expect(fixture.smallPutDiagnostic).toEqual({
      preflightStatus: 404,
      payloadBytes: 1,
      putStatus: 507,
      errorCodes: ["quotaLimitReached"],
      detailCodes: [],
      hasRetryAfter: false,
      itemCreated: false,
      cleanupRequired: false,
      residualProbeCount: 0,
    });
    expect(fixture.independentResidualCheck).toEqual({ status: 200, probeCount: 0 });
    expect(JSON.stringify(fixture)).not.toMatch(/access[_-]?token|accountId|downloadUrl|driveId|eTag/i);
  });

  it("preserves the successful redacted live mutation and delta contract", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/graph-live-contract-success-20260717.json",
      "utf8",
    ));

    expect(fixture.preflight).toEqual({ quota: "pass", namespaceCreate: "pass" });
    expect(fixture.fatal).toBeNull();
    expect(fixture.observations.smallPutQueryConflictBehavior).toEqual({
      createStatus: 201,
      secondStatus: 409,
      secondCode: "nameAlreadyExists",
      preventedOverwrite: true,
    });
    expect(fixture.observations.smallPutIfMatchZero).toEqual({
      createStatus: 201,
      secondStatus: 412,
      secondCode: "notAllowed",
      preventedOverwrite: true,
    });
    expect(fixture.observations.uploadSessionCreateOnlyRace).toMatchObject({
      finalStatus: 404,
      finalCode: "itemNotFound",
      preventedOverwrite: true,
    });
    expect(fixture.observations.uploadSessionStaleIfMatchAtCreate).toEqual({
      status: 412,
      code: "notAllowed",
      preventedStaleSession: true,
    });
    expect(fixture.observations.uploadSessionConcurrentWriteAfterCreate).toMatchObject({
      finalStatus: 404,
      finalCode: "itemNotFound",
      preventedOverwrite: true,
    });
    expect(fixture.observations.interruptedUploadSession).toEqual({
      partialStatus: 202,
      nextExpectedRanges: ["327680-655359"],
      targetStatusBeforeCancel: 200,
      cancelStatus: 204,
      targetStatusAfterCancel: 404,
    });
    expect(fixture.observations.delta).toEqual({
      pageCount: 11,
      itemCount: 32,
      repeatedIdCount: 5,
      usesLastOccurrenceRule: true,
      parentPathPresentCount: 29,
      parentPathMissingCount: 3,
      staleDeleteStatus: 412,
      staleDeleteCode: "resourceModified",
      currentDeleteStatus: 204,
      deleteRecreateUsesNewId: true,
      specialEventCount: 4,
      descendantReturnedAfterFolderRename: true,
    });
    expect(fixture.deltaPages).toHaveLength(11);
    expect(fixture.deltaPages.flatMap((page: { value: unknown[] }) => page.value)).toHaveLength(32);
    expect(fixture.cleanup).toEqual({
      attempted: true,
      method: "permanentDelete",
      confirmedAbsent: true,
      verifyStatus: 404,
    });
    expect(fixture.independentResidualCheck).toEqual({
      status: 200,
      probeCount: 0,
      hasNext: false,
    });

    const serialized = JSON.stringify(fixture);
    expect(serialized).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    expect(serialized).not.toMatch(/access[_-]?token|accountId|downloadUrl|uploadUrl|webUrl|createdBy|lastModifiedBy|userPrincipalName|email/i);
    for (const match of serialized.matchAll(/"(?:id|driveId|siteId)":"([^"]+)"/g)) {
      expect(match[1]).toMatch(/^<item-\d+>$/);
    }
    for (const match of serialized.matchAll(/"(?:eTag|cTag)":"([^"]+)"/g)) {
      expect(match[1]).toMatch(/^<etag-\d+>$/);
    }
  });

  it("retains the real Graph QuickXor-only response in the V2 remote index", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/graph-live-contract-success-20260717.json",
      "utf8",
    )) as {
      deltaPages: Array<{ value: DriveItem[] }>;
    };
    const child = fixture.deltaPages
      .flatMap((page) => page.value)
      .find((item) => item.name === "child.md" && item.file?.hashes?.quickXorHash);

    expect(child?.file?.hashes).toEqual({
      quickXorHash: "Y0BDGthABgAAAAAABQAAAAAAAAA=",
    });
    const projection = buildRemoteIndexV2(
      [child!],
      child!.parentReference!.id!,
      null,
    );
    expect(projection.index.itemsById[child!.id]).toMatchObject({
      contentHash: undefined,
      quickXorHash: "Y0BDGthABgAAAAAABQAAAAAAAAA=",
    });
  });

  it("keeps live-only claims separate from official service guarantees", () => {
    const liveRequired = GRAPH_MUTATION_CONTRACTS
      .filter((entry) => entry.evidence === "live-required")
      .map((entry) => entry.id);
    expect(liveRequired).toEqual(["small-put-create-only"]);
  });

  it("models resumable, stale-precondition, and final-conflict responses", () => {
    expect(GRAPH_UPLOAD_SESSION_FIXTURES.partialAccepted.status).toBe(202);
    expect(GRAPH_UPLOAD_SESSION_FIXTURES.sessionStatus.body.nextExpectedRanges).toEqual(["327680-"]);
    expect(GRAPH_UPLOAD_SESSION_FIXTURES.cancelled.status).toBe(204);
    expect(GRAPH_UPLOAD_SESSION_FIXTURES.staleIfMatch.status).toBe(412);
    expect(GRAPH_UPLOAD_SESSION_FIXTURES.finalNameConflict).toMatchObject({
      status: 409,
      body: { error: { code: "nameAlreadyExists" } },
    });
  });

  it("collapses paginated delta by driveItem id using the last occurrence", () => {
    const collapsed = collapseDeltaById(GRAPH_DELTA_PAGES);
    expect(collapsed.get("file-repeat")).toMatchObject({
      name: "case-ä-中文 #%.md",
      eTag: "etag-after",
      parentReference: { id: "folder-target" },
    });
    expect(collapsed.get("folder-moved")?.name).toBe("MOVE SOURCE RENAMED");
    expect(collapsed.get("file-deleted")?.deleted).toEqual({});
    expect(collapsed.get("file-recreated-new-id")?.id).not.toBe("file-repeat");
  });

  it("does not depend on parentReference.path for hierarchy reconstruction", () => {
    const items = GRAPH_DELTA_PAGES.flatMap((page) => page.value);
    expect(items.every((item) => item.parentReference?.path === undefined)).toBe(true);
    expect(items.every((item) => item.parentReference?.id)).toBe(true);
  });

  it("keeps the live probe behind an exact test-vault and namespace guard", () => {
    const source = readFileSync("scripts/probes/graph-sync-contract-probe.js", "utf8");
    expect(source).toContain('const EXPECTED_VAULT = "iphone-test-vault"');
    expect(source).toContain('const PREFIX = "__easy_sync_probe__"');
    expect(source).toContain('probeName.includes("vaults")');
    expect(source).toContain("/permanentDelete");
    expect(source).toContain("finally");
  });

  it("refreshes the folder eTag before conditionally renaming a folder with descendants", () => {
    const source = readFileSync("scripts/probes/graph-sync-contract-probe.js", "utf8");
    const refreshFolder = source.indexOf('"read current source folder"');
    const renameFolder = source.indexOf('"rename folder with descendant"');

    expect(refreshFolder).toBeGreaterThan(-1);
    expect(renameFolder).toBeGreaterThan(refreshFolder);
    expect(source).toContain('{ "If-Match": currentSourceFolder.eTag }');
  });

  it("checks redacted drive quota before the first Graph mutation", () => {
    const source = readFileSync("scripts/probes/graph-sync-contract-probe.js", "utf8");
    const quotaRead = source.indexOf('/me/drive?$select=quota');
    const firstMutation = source.indexOf('"create probe root"');

    expect(quotaRead).toBeGreaterThan(-1);
    expect(quotaRead).toBeLessThan(firstMutation);
    expect(source).toContain("MIN_PROBE_HEADROOM_BYTES");
    expect(source).toContain('result.preflight.quota = hasHeadroom ? "pass" : "blocked"');
    expect(source).toContain('error.graphCode = "quotaPreflightBlocked"');
    expect(source).not.toContain("result.preflight.remaining");
    expect(source).toContain("globalThis.__easySyncGraphProbeResult = result");
    expect(source).toContain("return JSON.stringify({");
    expect(source).toContain("deltaPageCount: result.deltaPages.length");
    expect(source).toContain("sensitiveResponseKeys.has(childKey)");
    expect(source).toContain('"webUrl"');
    expect(source).toContain('"createdBy"');
    expect(source).toContain('"lastModifiedBy"');
    expect(source).toContain('key === "siteId"');
    expect(source).toContain("const fetchWithTimeout = async");
    expect(source).toContain("fetchWithTimeout(interrupted.uploadUrl, { method: \"GET\" })");
    expect(source).toContain("fetchWithTimeout(interrupted.uploadUrl, { method: \"DELETE\" })");
  });

  it("performs zero Graph mutations when the quota preflight is blocked", async () => {
    const source = readFileSync("scripts/probes/graph-sync-contract-probe.js", "utf8");
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/me/drive/special/approot")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-root", name: "App Root" }),
        };
      }
      if (url.includes("/me/drive?$select=quota")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ quota: { remaining: 0, state: "exceeded" } }),
        };
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });

    const context = {
      app: {
        vault: { getName: () => "iphone-test-vault" },
        plugins: {
          plugins: {
            "easy-sync": {
              onedrive: {},
              auth: {
                authStatus: "loggedIn",
                getAccessToken: async () => "test-token",
              },
            },
          },
        },
      },
      fetch: fetchMock,
      AbortController,
      TextEncoder,
      URL,
      setTimeout,
      clearTimeout,
    };
    const result = JSON.parse(await runInNewContext(source, context));

    expect(result.preflight.quota).toBe("blocked");
    expect(result.preflight.namespaceCreate).toBe("pending");
    expect(result.fatal).toMatchObject({ code: "quotaPreflightBlocked" });
    expect(result.cleanup).toMatchObject({ attempted: false, confirmedAbsent: false });
    expect(result).not.toHaveProperty("deltaPages");
    expect(result.deltaPageCount).toBe(0);
    expect((context as typeof context & { __easySyncGraphProbeResult: unknown }).__easySyncGraphProbeResult)
      .toMatchObject({ preflight: { quota: "blocked" }, deltaPages: [] });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  });

  it("treats a live namespace-create 507 as the authoritative quota block", async () => {
    const source = readFileSync("scripts/probes/graph-sync-contract-probe.js", "utf8");
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/me/drive/special/approot")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-root", name: "App Root" }),
        };
      }
      if (url.includes("/me/drive?$select=quota")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ quota: { remaining: 4 * 1024 * 1024, state: "normal" } }),
        };
      }
      if (url.includes("/me/drive/items/app-root/children") && init?.method === "POST") {
        return {
          ok: false,
          status: 507,
          json: async () => ({ error: { code: "quotaLimitReached", message: "Quota limit reached" } }),
        };
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });

    const result = JSON.parse(await runInNewContext(source, {
      app: {
        vault: { getName: () => "iphone-test-vault" },
        plugins: {
          plugins: {
            "easy-sync": {
              onedrive: {},
              auth: {
                authStatus: "loggedIn",
                getAccessToken: async () => "test-token",
              },
            },
          },
        },
      },
      fetch: fetchMock,
      AbortController,
      TextEncoder,
      URL,
      setTimeout,
      clearTimeout,
    }));

    expect(result.preflight).toEqual({ quota: "pass", namespaceCreate: "blocked" });
    expect(result.fatal).toMatchObject({ status: 507, code: "quotaLimitReached" });
    expect(result.cleanup).toMatchObject({ attempted: false, confirmedAbsent: false });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "POST"]);
  });

  it("contains no token, account id, download URL, or real drive id in offline fixtures", () => {
    const serialized = JSON.stringify({
      mutation: GRAPH_MUTATION_CONTRACTS,
      upload: GRAPH_UPLOAD_SESSION_FIXTURES,
      delta: GRAPH_DELTA_PAGES,
    });
    expect(serialized).not.toMatch(/access[_-]?token|accountId|downloadUrl/i);
    expect(serialized).not.toMatch(/graph\.microsoft\.com\/v1\.0\/drives\//i);
  });
});
