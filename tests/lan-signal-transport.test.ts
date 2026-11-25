import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";
import {
  MAX_LAN_SIGNAL_CONTROL_BYTES,
  createOneDriveLanSignalTransport,
  type LanSignalTransportObserver,
  type LanSignalTransportOperation,
} from "../src/onedrive/lan-signal-transport";
import {
  LAN_PAIRING_PATH,
  LAN_SIGNAL_ACTIVE_PATH,
  LAN_SIGNAL_ROOT,
  LanSignalPreconditionError,
} from "../src/sync/lan-signaling";
import { LAN_PRESENCE_REQUEST_PATH } from "../src/sync/lan-presence";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";

const SESSION_ID = "a".repeat(32);
const OFFER_PATH = `${LAN_SIGNAL_ROOT}/${SESSION_ID}/offer.json`;
const ANSWER_PATH = `${LAN_SIGNAL_ROOT}/${SESSION_ID}/answer.json`;

class FakeLanSignalClient {
  readonly reads: Array<{ vault: string; relativePath: string; maxBytes: number }> = [];
  readonly writes: Array<{
    vault: string;
    relativePath: string;
    content: string;
    options: { createOnly?: boolean; ifMatch?: string };
  }> = [];
  readonly deletes: Array<{ vault: string; relativePath: string; ifMatch?: string }> = [];
  readonly lists: Array<{ vault: string; relativePath: string }> = [];
  readonly ensuredFolders: string[] = [];
  files = new Map<string, string>();
  listedChildren: Array<{ name: string; file?: object; folder?: object }> = [];
  writeError: Error | null = null;
  deleteError: Error | null = null;

  async readPluginControlText(
    vault: string,
    relativePath: string,
    maxBytes: number,
  ): Promise<{ id: string; eTag: string; text: string } | null> {
    this.reads.push({ vault, relativePath, maxBytes });
    const text = this.files.get(relativePath);
    return text === undefined
      ? null
      : { id: `id-${relativePath}`, eTag: `etag-${relativePath}`, text };
  }

  async writePluginControlText(
    vault: string,
    relativePath: string,
    content: string,
    options: { createOnly?: boolean; ifMatch?: string },
  ): Promise<{ id: string; eTag: string }> {
    this.writes.push({ vault, relativePath, content, options });
    if (this.writeError) throw this.writeError;
    this.files.set(relativePath, content);
    return { id: `id-${relativePath}`, eTag: `etag-${relativePath}` };
  }

  async deletePluginControlItem(
    vault: string,
    relativePath: string,
    ifMatch?: string,
  ): Promise<boolean> {
    this.deletes.push({ vault, relativePath, ifMatch });
    if (this.deleteError) throw this.deleteError;
    return this.files.delete(relativePath);
  }

  async listPluginControlChildren(
    vault: string,
    relativePath: string,
  ): Promise<Array<{ name: string; file?: object; folder?: object }>> {
    this.lists.push({ vault, relativePath });
    return this.listedChildren;
  }

  async ensurePluginControlFolder(
    vault: string,
    relativePath: string,
  ): Promise<void> {
    const segments = relativePath.split("/").filter((segment) => segment.length > 0);
    for (let index = 1; index <= segments.length; index += 1) {
      this.ensuredFolders.push(`${vault}:${segments.slice(0, index).join("/")}`);
    }
  }

  asClient(): OneDriveClient {
    return this as unknown as OneDriveClient;
  }
}

function transportFor(client: FakeLanSignalClient, observer?: LanSignalTransportObserver) {
  return createOneDriveLanSignalTransport(client.asClient(), "TestVault", observer);
}

describe("OneDrive LAN signal transport wrapper", () => {
  it("reads only registered exact paths and returns null for missing objects", async () => {
    const client = new FakeLanSignalClient();
    const transport = transportFor(client);

    expect(await transport.readText(LAN_PAIRING_PATH)).toBeNull();
    client.files.set("lan-signal/active.json", "active");
    const active = await transport.readText(LAN_SIGNAL_ACTIVE_PATH);
    expect(active).toEqual({
      path: LAN_SIGNAL_ACTIVE_PATH,
      eTag: "etag-lan-signal/active.json",
      text: "active",
    });
    client.files.set(`lan-signal/${SESSION_ID}/offer.json`, "offer");
    expect(await transport.readText(OFFER_PATH)).toMatchObject({ text: "offer" });

    expect(client.reads.map((entry) => entry.relativePath)).toEqual([
      "lan-pairing-v1.json",
      "lan-signal/active.json",
      `lan-signal/${SESSION_ID}/offer.json`,
    ]);
    expect(client.reads[0].maxBytes).toBe(MAX_LAN_SIGNAL_CONTROL_BYTES);
  });

  it("rejects every path outside the registered control records", async () => {
    const client = new FakeLanSignalClient();
    const transport = transportFor(client);
    const invalid = [
      ".easy-sync/other.json",
      ".easy-sync/lan-signal/../secret.json",
      ".easy-sync/lan-signal/not-a-session/offer.json",
      `.easy-sync/lan-signal/${SESSION_ID.toUpperCase()}/offer.json`,
      `.easy-sync/lan-signal/${SESSION_ID}/nested/offer.json`,
      `.easy-sync/lan-signal/${SESSION_ID}/unknown.json`,
      `.easy-sync/lan-signal/${SESSION_ID}`,
      // S5a: the presence request is one exact file, not a browsable folder.
      ".easy-sync/lan-presence/",
      ".easy-sync/lan-presence/request.json.bak",
      ".easy-sync/lan-presence/other.json",
      ".easy-sync/lan-presence/request.json/child",
    ];

    for (const path of invalid) {
      expect(() => transport.readText(path)).toThrow("outside the registered control paths");
      expect(() => transport.writeText(path, "x")).toThrow("outside the registered control paths");
      expect(() => transport.delete(path)).toThrow("outside the registered control paths");
    }
    expect(() => transport.listPaths(`${LAN_SIGNAL_ROOT}/x/`)).toThrow(
      "limited to the signaling root",
    );
    expect(client.reads).toEqual([]);
    expect(client.writes).toEqual([]);
    expect(client.deletes).toEqual([]);
    expect(client.lists).toEqual([]);
  });

  it("allows exactly the registered presence request path and nothing around it", async () => {
    const client = new FakeLanSignalClient();
    const transport = transportFor(client);

    await transport.writeText(LAN_PRESENCE_REQUEST_PATH, "request");
    expect(client.writes.at(-1)).toMatchObject({
      vault: "TestVault",
      relativePath: "lan-presence/request.json",
      options: {},
    });
    expect(client.ensuredFolders).toContain("TestVault:lan-presence");
    expect(await transport.readText(LAN_PRESENCE_REQUEST_PATH)).toMatchObject({
      path: LAN_PRESENCE_REQUEST_PATH,
      text: "request",
    });
    expect(await transport.delete(LAN_PRESENCE_REQUEST_PATH)).toBe(true);
  });

  it("creates the session folders lazily and passes create-only/If-Match preconditions", async () => {
    const client = new FakeLanSignalClient();
    const transport = transportFor(client);

    await transport.writeText(OFFER_PATH, "offer", { createOnly: true });
    expect(client.ensuredFolders).toEqual([
      `TestVault:lan-signal`,
      `TestVault:lan-signal/${SESSION_ID}`,
    ]);
    expect(client.writes).toEqual([{
      vault: "TestVault",
      relativePath: `lan-signal/${SESSION_ID}/offer.json`,
      content: "offer",
      options: { createOnly: true },
    }]);

    await transport.writeText(LAN_SIGNAL_ACTIVE_PATH, "active", { ifMatch: "etag-1" });
    expect(client.ensuredFolders).toContain("TestVault:lan-signal");
    expect(client.writes.at(-1)).toMatchObject({
      relativePath: "lan-signal/active.json",
      options: { ifMatch: "etag-1" },
    });

    // One ensure pass per transport instance: the third write to the same room
    // must not PUT-create the already existing chain again. Field measurement
    // 2026-11-21: those redundant PUTs answered 409 after a ~1.4 s RTT each and
    // were a measurable share of an 18–25 s handshake.
    const ensuredAfterSessionWrites = client.ensuredFolders.length;
    await transport.writeText(LAN_PAIRING_PATH, "pairing");
    expect(client.ensuredFolders).toHaveLength(ensuredAfterSessionWrites);
    expect(client.writes.at(-1)).toMatchObject({
      relativePath: "lan-pairing-v1.json",
      options: {},
    });

    expect(() => transport.writeText(LAN_PAIRING_PATH, "x", {
      createOnly: true,
      ifMatch: "etag-1",
    })).toThrow("cannot be both create-only and If-Match");
    expect(client.writes).toHaveLength(3);
  });

  it("maps Graph conflict and precondition failures to the transport error", async () => {
    for (const type of [
      OneDriveErrorType.Conflict,
      OneDriveErrorType.PreconditionFailed,
    ]) {
      const client = new FakeLanSignalClient();
      client.writeError = new OneDriveError(type, "rejected", type === OneDriveErrorType.Conflict ? 409 : 412);
      const events: LanSignalTransportOperation[] = [];
      const transport = transportFor(client, { onOperation: (event) => events.push(event) });

      await expect(transport.writeText(ANSWER_PATH, "answer", {
        ifMatch: "stale",
      })).rejects.toBeInstanceOf(LanSignalPreconditionError);
      expect(events.at(-1)).toMatchObject({
        method: "write",
        path: ANSWER_PATH,
        outcome: "precondition",
        statusCode: type === OneDriveErrorType.Conflict ? 409 : 412,
      });
    }

    const client = new FakeLanSignalClient();
    client.writeError = new OneDriveError(OneDriveErrorType.ServerError, "boom", 500);
    const transport = transportFor(client);
    await expect(transport.writeText(OFFER_PATH, "offer")).rejects.toMatchObject({
      type: OneDriveErrorType.ServerError,
    });
  });

  it("deletes exact paths, returns false when absent, and passes If-Match", async () => {
    const client = new FakeLanSignalClient();
    const transport = transportFor(client);
    expect(await transport.delete(ANSWER_PATH, { ifMatch: "etag-1" })).toBe(false);
    expect(client.deletes).toEqual([{
      vault: "TestVault",
      relativePath: `lan-signal/${SESSION_ID}/answer.json`,
      ifMatch: "etag-1",
    }]);
  });

  it("lists only the signaling root and returns child paths", async () => {
    const client = new FakeLanSignalClient();
    client.listedChildren = [
      { name: "active.json", file: {} },
      { name: SESSION_ID, folder: {} },
    ];
    const transport = transportFor(client);

    expect(await transport.listPaths(`${LAN_SIGNAL_ROOT}/`)).toEqual([
      `${LAN_SIGNAL_ROOT}/active.json`,
      `${LAN_SIGNAL_ROOT}/${SESSION_ID}`,
    ]);
    expect(client.lists).toEqual([{ vault: "TestVault", relativePath: "lan-signal" }]);
  });

  it("reports operation outcomes and latency without record contents", async () => {
    const client = new FakeLanSignalClient();
    const events: LanSignalTransportOperation[] = [];
    const transport = transportFor(client, { onOperation: (event) => events.push(event) });

    await transport.readText(LAN_PAIRING_PATH);
    await transport.writeText(LAN_PAIRING_PATH, "secret-ish content");
    await transport.delete(LAN_PAIRING_PATH);
    await transport.listPaths(`${LAN_SIGNAL_ROOT}/`);

    expect(events).toHaveLength(4);
    expect(events.map((event) => event.method)).toEqual([
      "read",
      "write",
      "delete",
      "list",
    ]);
    expect(events[0].outcome).toBe("missing");
    expect(events[1].outcome).toBe("ok");
    expect(events[2].outcome).toBe("ok");
    for (const event of events) {
      expect(event.latencyMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(event)).not.toContain("secret-ish content");
    }
  });
});

describe("OneDrive client LAN signal control methods", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function downloadResponse(text: string) {
    return { status: 200, headers: {}, text };
  }

  function metadataResponse(overrides: Record<string, unknown> = {}) {
    return {
      status: 200,
      headers: {},
      json: {
        id: "control-id",
        name: "lan-pairing-v1.json",
        size: 10,
        eTag: "control-etag",
        file: {},
        "@microsoft.graph.downloadUrl": "https://download.example/control",
        ...overrides,
      },
    };
  }

  it("reads a control text file without touching file-transfer or token metrics", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce(metadataResponse() as never)
      .mockResolvedValueOnce(downloadResponse('{"ok":true}') as never);
    const client = new OneDriveClient(async () => "token");
    client.beginRunMetrics();

    const result = await client.readPluginControlText(
      "TestVault",
      "lan-pairing-v1.json",
      1024,
      "LAN signal",
    );
    const summary = client.finishRunMetrics();

    expect(result).toEqual({
      id: "control-id",
      eTag: "control-etag",
      text: '{"ok":true}',
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({
      method: "GET",
      url: expect.stringContaining(".easy-sync/lan-pairing-v1.json"),
    });
    expect(summary?.endpoints).toEqual({});
    expect(summary?.tokenAcquisition.attempts).toBe(0);
  });

  it("writes create-only and If-Match control files on exact Graph paths", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "written-id", eTag: "written-etag" },
    } as never);
    const client = new OneDriveClient(async () => "token");

    expect(await client.writePluginControlText(
      "TestVault",
      "lan-signal/active.json",
      "{}",
      { createOnly: true },
    )).toEqual({ id: "written-id", eTag: "written-etag" });
    expect(requestSpy.mock.calls[0][0]).toMatchObject({
      method: "PUT",
      url: expect.stringContaining(
        ".easy-sync/lan-signal/active.json:/content?@microsoft.graph.conflictBehavior=fail",
      ),
    });

    await client.writePluginControlText(
      "TestVault",
      `lan-signal/${SESSION_ID}/answer.json`,
      "{}",
      { ifMatch: "etag-1" },
    );
    expect(requestSpy.mock.calls[1][0]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ "If-Match": "etag-1" }),
      url: expect.stringContaining(
        `.easy-sync/lan-signal/${SESSION_ID}/answer.json:/content`,
      ),
    });
  });

  it("deletes a control item and reports a missing item as false", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({ status: 204, headers: {} } as never)
      .mockResolvedValueOnce({
        status: 404,
        headers: {},
        json: { error: { code: "itemNotFound", message: "missing" } },
      } as never);
    const client = new OneDriveClient(async () => "token");

    expect(await client.deletePluginControlItem(
      "TestVault",
      `lan-signal/${SESSION_ID}/closed.json`,
      "etag-1",
    )).toBe(true);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ "If-Match": "etag-1" }),
      url: expect.stringContaining(
        `.easy-sync/lan-signal/${SESSION_ID}/closed.json`,
      ),
    });

    expect(await client.deletePluginControlItem(
      "TestVault",
      `lan-signal/${SESSION_ID}/closed.json`,
    )).toBe(false);
  });

  it("lists control children through one paginated exact folder", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        value: [
          { id: "active-id", name: "active.json", file: {}, eTag: "e1" },
          { id: "session-id", name: SESSION_ID, folder: {}, eTag: "e2" },
        ],
      },
    } as never);
    const client = new OneDriveClient(async () => "token");

    expect(await client.listPluginControlChildren("TestVault", "lan-signal")).toEqual([
      { id: "active-id", name: "active.json", file: {}, eTag: "e1" },
      { id: "session-id", name: SESSION_ID, folder: {}, eTag: "e2" },
    ]);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({
      method: "GET",
      url: expect.stringContaining(
        ".easy-sync/lan-signal:/children?$select=id,name,size,eTag,file,folder",
      ),
    });
  });

  it("ensures each control folder level with metric suppression", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "folder-id", name: "session", folder: {} },
    } as never);
    const client = new OneDriveClient(async () => "token");
    client.beginRunMetrics();

    await client.ensurePluginControlFolder("TestVault", `lan-signal/${SESSION_ID}`);
    const summary = client.finishRunMetrics();

    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls[0][0]).toMatchObject({
      method: "PUT",
      url: expect.stringContaining(".easy-sync/lan-signal"),
    });
    expect(requestSpy.mock.calls[1][0]).toMatchObject({
      method: "PUT",
      url: expect.stringContaining(`.easy-sync/lan-signal/${SESSION_ID}`),
    });
    expect(summary?.endpoints).toEqual({});
    expect(summary?.tokenAcquisition.attempts).toBe(0);
  });
});
