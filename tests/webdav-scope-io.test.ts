import { describe, expect, it } from "vitest";
import {
  WebDavClient,
  type WebDavClientCredentials,
} from "../src/providers/webdav/webdav-client";
import {
  buildWebDavScopeFields,
  buildWebDavScopeId,
  buildWebDavScopeMarker,
  ensureWebDavScopeMarker,
  readWebDavScopeMarker,
  serializeWebDavScopeMarker,
  webDavScopeMarkerPath,
  type WebDavScopeMarkerV1,
  type WebDavScopeRemoteIo,
} from "../src/providers/webdav/webdav-scope";
import { WebDavClientScopeIo } from "../src/providers/webdav/webdav-scope-io";
import type { FakeWebDavProfile } from "./helpers/fake-webdav";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const credentials: WebDavClientCredentials = {
  username: WEBDAV_TEST_USERNAME,
  password: WEBDAV_TEST_PASSWORD,
};

const NUTSTORE_PROFILE: readonly FakeWebDavProfile[] = [
  "ignore-if-none-match",
  "ignore-delete-if-match",
  "move-conflict-on-overwrite",
  "depth-infinity-as-one",
  "no-head-length",
  "mkcol-existing-201",
];

const CREATED_AT = new Date("2026-11-19T00:00:00.000Z");

async function makeClient(): Promise<WebDavClient> {
  fixture.fake.setProfiles(NUTSTORE_PROFILE);
  const client = new WebDavClient({
    endpoint,
    credentials,
    transport: fixture.transport,
  });
  await client.initialize();
  return client;
}

async function markerFor(overrides: { endpoint?: string } = {}): Promise<WebDavScopeMarkerV1> {
  const fields = await buildWebDavScopeFields({
    endpoint: overrides.endpoint ?? "https://dav.jianguoyun.com/dav/Vault",
    username: "alice",
  });
  const scopeId = await buildWebDavScopeId(fields);
  return buildWebDavScopeMarker({
    vaultName: "MyVault",
    scopeId,
    createdAt: CREATED_AT,
  });
}

function requestsTo(method: string, path: string) {
  return fixture.fake.requests.filter(
    (request) => request.method === method && request.decodedPath === path,
  );
}

describe("WebDavClientScopeIo", () => {
  it("creates the scope marker through staged PUT+MOVE, never a direct overwriting PUT", async () => {
    const client = await makeClient();
    const io = new WebDavClientScopeIo(client);
    const marker = await markerFor();
    const markerPath = webDavScopeMarkerPath("/vault");

    const result = await ensureWebDavScopeMarker({
      io,
      rootPath: "/vault",
      marker,
      localStatePresent: false,
    });

    expect(result.action).toBe("initialize");
    expect(result.markerStyle).toBe("directory");
    expect(result.markerPath).toBe(markerPath);
    expect(fixture.fake.readText(markerPath)).toBe(serializeWebDavScopeMarker(marker));
    expect(requestsTo("PUT", markerPath)).toHaveLength(0);
    const moves = fixture.fake.requests.filter(
      (request) => request.method === "MOVE"
        && request.destination !== null
        && new URL(request.destination).pathname === markerPath,
    );
    expect(moves).toHaveLength(1);
    expect((await client.list(".easy-sync/tmp")).length).toBe(0);
  });

  it("returns 412 for create-only when the marker already exists and keeps its bytes", async () => {
    const client = await makeClient();
    const io = new WebDavClientScopeIo(client);
    const markerPath = webDavScopeMarkerPath("/vault");
    fixture.fake.seedFile(markerPath, "existing-marker");

    const status = await io.putText(markerPath, "replacement", { createOnly: true });

    expect(status).toBe(412);
    expect(fixture.fake.readText(markerPath)).toBe("existing-marker");
    expect((await client.list(".easy-sync/tmp")).length).toBe(0);
  });

  it("fails closed when replacing without an ETag and when the ETag is stale", async () => {
    const client = await makeClient();
    const io = new WebDavClientScopeIo(client);
    const markerPath = webDavScopeMarkerPath("/vault");
    fixture.fake.seedFile(markerPath, "old-marker");

    const withoutETag = await io.putText(markerPath, "new-marker", { createOnly: false });
    expect(withoutETag).toBe(428);
    expect(requestsTo("PUT", markerPath)).toHaveLength(0);
    expect(fixture.fake.readText(markerPath)).toBe("old-marker");

    const read = await io.getText(markerPath);
    expect(read).toMatchObject({ status: 200, text: "old-marker" });
    expect(read.eTag).not.toBeNull();

    const stale = await io.putText(markerPath, "new-marker", {
      createOnly: false,
      ifMatch: '"stale-etag"',
    });
    expect(stale).toBe(412);
    expect(fixture.fake.readText(markerPath)).toBe("old-marker");

    const applied = await io.putText(markerPath, "new-marker", {
      createOnly: false,
      ifMatch: read.eTag,
    });
    expect(applied).toBe(204);
    expect(fixture.fake.readText(markerPath)).toBe("new-marker");
  });

  it("refuses a takeover when the marker changes between read and replace", async () => {
    const client = await makeClient();
    const inner = new WebDavClientScopeIo(client);
    const markerPath = webDavScopeMarkerPath("/vault");
    const otherMarker = await markerFor({ endpoint: "https://other.example.com/dav/Vault" });
    const marker = await markerFor();
    fixture.fake.seedFile(markerPath, serializeWebDavScopeMarker(otherMarker));

    let changed = false;
    const racing: WebDavScopeRemoteIo = {
      stat: (path) => inner.stat(path),
      mkcol: (path) => inner.mkcol(path),
      putText: (path, text, options) => inner.putText(path, text, options),
      getText: async (path) => {
        const read = await inner.getText(path);
        if (!changed) {
          changed = true;
          fixture.fake.seedFile(markerPath, "changed-by-another-writer");
        }
        return read;
      },
      list: (path) => inner.list(path),
    };

    const result = await ensureWebDavScopeMarker({
      io: racing,
      rootPath: "/vault",
      marker,
      localStatePresent: false,
      confirmTakeover: true,
    });

    expect(result.action).toBe("refuse");
    expect(result.mayWrite).toBe(false);
    expect(result.reason).toContain("412");
    expect(fixture.fake.readText(markerPath)).toBe("changed-by-another-writer");
  });

  it("completes a takeover with If-Match after explicit confirmation", async () => {
    const client = await makeClient();
    const io = new WebDavClientScopeIo(client);
    const otherMarker = await markerFor({ endpoint: "https://other.example.com/dav/Vault" });
    const marker = await markerFor();
    fixture.fake.seedFile(webDavScopeMarkerPath("/vault"), serializeWebDavScopeMarker(otherMarker));

    const result = await ensureWebDavScopeMarker({
      io,
      rootPath: "/vault",
      marker,
      localStatePresent: false,
      confirmTakeover: true,
    });

    expect(result.action).toBe("takeover");
    expect(result.markerWritten).toBe(true);
    expect((await readWebDavScopeMarker(io, "/vault"))?.marker).toEqual(marker);
  });
});
