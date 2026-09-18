import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  refreshedMetadataMatchesIdentity,
  resolveBatchMetadataClient,
} from "../src/sync/sync-executor";

// The batched metadata refresh had the same capability probe and the same
// identity gate copy-pasted at every refresh site (7 by 2026-09-18). These
// two rules now live in one place; each site keeps its own failure contract
// (fail-open / fail-closed / per-item error) and its own write-back target.

describe("resolveBatchMetadataClient", () => {
  it("returns a client-bound refresh function when the $batch API exists", async () => {
    const seen: Array<{ self: unknown; ids: readonly string[]; reason: string | undefined }> = [];
    const onedrive = {
      getDriveItemMetadataByIds(
        this: unknown,
        ids: readonly string[],
        reason?: string,
      ) {
        seen.push({ self: this, ids, reason });
        return Promise.resolve(new Map([["id-1", { id: "id-1" }]]));
      },
    };
    const refresh = resolveBatchMetadataClient(onedrive);
    expect(refresh).not.toBeNull();

    const result = await refresh!(["id-1"], "downloadUrlRefresh");
    expect(result.get("id-1")).toEqual({ id: "id-1" });
    // The wrapped call must keep the client as `this` (same as the former
    // property-access invocation at every site).
    expect(seen).toEqual([
      { self: onedrive, ids: ["id-1"], reason: "downloadUrlRefresh" },
    ]);
  });

  it("returns null when the client lacks the batch metadata capability", () => {
    expect(resolveBatchMetadataClient({})).toBeNull();
    expect(resolveBatchMetadataClient({ getDriveItemMetadataByIds: 42 })).toBeNull();
    expect(resolveBatchMetadataClient(undefined)).toBeNull();
  });
});

describe("refreshedMetadataMatchesIdentity", () => {
  it("accepts only an existing item matching both key and planned eTag", () => {
    expect(
      refreshedMetadataMatchesIdentity(
        { id: "drive-1", eTag: "etag-1" } as never,
        "drive-1",
        "etag-1",
      ),
    ).toBe(true);
  });

  it("rejects a missing item, a key mismatch and an eTag drift", () => {
    expect(refreshedMetadataMatchesIdentity(null, "drive-1", "etag-1")).toBe(false);
    expect(
      refreshedMetadataMatchesIdentity(
        { id: "other", eTag: "etag-1" } as never,
        "drive-1",
        "etag-1",
      ),
    ).toBe(false);
    expect(
      refreshedMetadataMatchesIdentity(
        { id: "drive-1", eTag: "etag-2" } as never,
        "drive-1",
        "etag-1",
      ),
    ).toBe(false);
  });

  it("keeps the former semantics: two absent eTags compare as equal", () => {
    expect(
      refreshedMetadataMatchesIdentity(
        { id: "drive-1", eTag: undefined } as never,
        "drive-1",
        undefined,
      ),
    ).toBe(true);
  });
});

describe("batch refresh sites share the two rules", () => {
  const source = readFileSync("src/sync/sync-executor.ts", "utf8");

  it("resolves the client through the shared probe at every refresh site", () => {
    const calls = source.match(/resolveBatchMetadataClient\(this\.onedrive\)/g) ?? [];
    // 6 probe sites: the Step-3b prep and its version-verify pass share one
    // probe (blk3/blk4 in the 2026-09-18 diff), the other five stand alone.
    expect(calls.length).toBe(6);
  });

  it("gates identity through the shared predicate instead of inline chains", () => {
    const calls = source.match(/(?<!function )refreshedMetadataMatchesIdentity\(/g) ?? [];
    // 7 call sites (site 3 and 4 use the negated form for per-item errors);
    // the definition line is excluded by the look-behind.
    expect(calls.length).toBe(7);
  });

  it("leaves no duplicated inline probe casts behind", () => {
    expect(source).not.toContain('"downloadUrlRefresh" | "downloadVersionVerify" | "other"');
    expect(source).not.toContain("BatchMetadataClient = this.onedrive as OneDriveClient & {");
  });
});
