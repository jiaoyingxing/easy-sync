import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";

describe("OneDriveClient.getFileMetadataByPaths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads vault-relative file metadata per path through one checked Graph batch", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        responses: [
          {
            id: "1",
            status: 200,
            headers: {},
            body: {
              id: "file-a",
              name: "a.md",
              eTag: "etag-a",
              file: {},
              "@microsoft.graph.downloadUrl": "https://download.example/a",
            },
          },
          {
            id: "2",
            status: 404,
            headers: {},
            body: { error: { code: "itemNotFound", message: "missing" } },
          },
        ],
      },
    });
    const client = new OneDriveClient(async () => "token");

    const result = await client.getFileMetadataByPaths(
      "testVault",
      ["notes/a.md", "notes/b.md", "notes/a.md"],
    );

    expect(result.get("notes/a.md")).toMatchObject({
      id: "file-a",
      eTag: "etag-a",
    });
    expect(result.get("notes/b.md")).toBeNull();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const request = requestSpy.mock.calls[0][0];
    expect(request.url).toBe("https://graph.microsoft.com/v1.0/$batch");
    const body = JSON.parse(request.body as string) as {
      requests: Array<{ id: string; method: string; url: string }>;
    };
    expect(body.requests).toHaveLength(2);
    for (const [index, path] of ["notes/a.md", "notes/b.md"].entries()) {
      expect(body.requests[index].id).toBe(String(index + 1));
      expect(body.requests[index].method).toBe("GET");
      expect(body.requests[index].url).toContain("approot:/vaults/");
      expect(body.requests[index].url).toContain("/files/");
      expect(body.requests[index].url).toContain(path.split("/")[1]);
    }
  });

  it("isolates a failed 20-path chunk so only its own paths degrade to per-item reads", async () => {
    const paths = Array.from({ length: 25 }, (_unused, index) => `chunk-${index}.md`);
    let batchPosts = 0;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(
      async (request) => {
        const body = JSON.parse(request.body as string) as {
          requests: Array<{ id: string; url: string }>;
        };
        batchPosts++;
        if (body.requests[0].url.includes("chunk-0.md")) {
          // The first chunk's POST fails with a gateway timeout; the client
          // retries it, then isolates it.
          return {
            status: 504,
            headers: {},
            json: { error: { code: "gatewayTimeout", message: "timeout" } },
          };
        }
        return {
          status: 200,
          headers: {},
          json: {
            responses: body.requests.map((entry) => ({
              id: entry.id,
              status: 404,
              headers: {},
              body: { error: { code: "itemNotFound", message: "missing" } },
            })),
          },
        };
      },
    );
    const client = new OneDriveClient(async () => "token");

    const result = await client.getFileMetadataByPaths("testVault", paths);

    // Chunk 1 (20 paths) is left unresolved: the caller re-verifies exactly
    // those items one by one. Chunk 2 (5 paths) still resolves in one read.
    expect(result.size).toBe(5);
    for (const path of paths.slice(20)) {
      expect(result.get(path)).toBeNull();
    }
    for (const path of paths.slice(0, 20)) {
      expect(result.has(path)).toBe(false);
    }
    // One POST for the healthy chunk plus the failed chunk's own attempts.
    expect(batchPosts).toBeGreaterThan(1);
    expect(requestSpy).toHaveBeenCalledTimes(batchPosts);
  });
});
