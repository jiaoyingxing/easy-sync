import { afterEach, describe, expect, it, vi } from "vitest";
import { OneDriveClient } from "../src/onedrive/client";
import { sha256Hex } from "../src/crypto";
import type { LanContentSource } from "../src/sync/lan-content-source";
import {
  LanDiagnostics,
  type LanRouteType,
} from "../src/sync/lan-diagnostics";

const HINT_SIZE = 11;

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function makeSource(
  downloadFile: ReturnType<typeof vi.fn>,
  getRouteType?: () => Promise<LanRouteType>,
): LanContentSource {
  return {
    downloadFile,
    downloadFileToPath: vi.fn(async () => ({ size: 0, hash: "0".repeat(64) })),
    ...(getRouteType ? { getRouteType } : {}),
  } as unknown as LanContentSource;
}

function enableLan(client: OneDriveClient, thresholdBytes = 0): void {
  client.setLanAcceleration({ enabled: true, thresholdBytes });
}

describe("OneDriveClient LAN content seam (S2a)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns verified LAN bytes and keeps Graph metrics empty", async () => {
    const lanBytes = bytes("lan payload");
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: lanBytes.byteLength,
    };
    const attestation = await sha256Hex(lanBytes);
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(bytes("cloud"));
    const source = makeSource(vi.fn().mockResolvedValue({
      bytes: lanBytes,
      sha256: attestation,
    }));
    client.setLanContentSource(source);
    enableLan(client);
    client.beginRunMetrics();

    const result = await client.downloadFileWithLan(
      "vault",
      "note.bin",
      undefined,
      undefined,
      HINT_SIZE,
      undefined,
      hint,
    );

    const summary = client.finishRunMetrics();
    expect(new Uint8Array(result)).toEqual(new Uint8Array(lanBytes));
    expect(cloudSpy).not.toHaveBeenCalled();
    expect(summary?.endpoints).toEqual({});
  });

  it("falls back to the cloud when the LAN bytes do not match the attestation", async () => {
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: HINT_SIZE,
    };
    const cloud = bytes("cloud");
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(cloud);
    client.setLanContentSource(makeSource(vi.fn().mockResolvedValue({
      bytes: bytes("wrong"),
      sha256: await sha256Hex(bytes("expected")),
    })));
    enableLan(client);

    const result = await client.downloadFileWithLan(
      "vault",
      "note.bin",
      undefined,
      undefined,
      HINT_SIZE,
      undefined,
      hint,
    );

    expect(result).toBe(cloud);
    expect(cloudSpy).toHaveBeenCalledOnce();
  });

  it("falls back to the cloud when the LAN source throws", async () => {
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: HINT_SIZE,
    };
    const cloud = bytes("cloud");
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(cloud);
    client.setLanContentSource(makeSource(
      vi.fn().mockRejectedValue(new Error("peer gone")),
    ));
    enableLan(client);

    const result = await client.downloadFileWithLan(
      "vault",
      "note.bin",
      undefined,
      undefined,
      HINT_SIZE,
      undefined,
      hint,
    );

    expect(result).toBe(cloud);
    expect(cloudSpy).toHaveBeenCalledOnce();
  });

  it("uses the cloud path when no LAN source is installed", async () => {
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: HINT_SIZE,
    };
    const cloud = bytes("cloud");
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(cloud);
    client.setLanContentSource(null);
    enableLan(client);

    const result = await client.downloadFileWithLan(
      "vault",
      "note.bin",
      undefined,
      undefined,
      HINT_SIZE,
      undefined,
      hint,
    );

    expect(result).toBe(cloud);
    expect(cloudSpy).toHaveBeenCalledOnce();
  });

  it("an explicit off keeps an installed source unused and records the skip", async () => {
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: HINT_SIZE,
    };
    const cloud = bytes("cloud");
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(cloud);
    const downloadFile = vi.fn().mockResolvedValue({
      bytes: bytes("lan"),
      sha256: await sha256Hex(bytes("lan")),
    });
    const diagnostics = new LanDiagnostics();
    client.setLanDiagnostics(diagnostics);
    client.setLanContentSource(makeSource(downloadFile));
    client.setLanAcceleration({ enabled: false, thresholdBytes: 8 * 1024 * 1024 });

    expect(client.shouldAttemptLan(HINT_SIZE)).toBe(false);
    const result = await client.downloadFileWithLan(
      "vault",
      "note.bin",
      undefined,
      undefined,
      HINT_SIZE,
      undefined,
      hint,
    );

    expect(result).toBe(cloud);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(cloudSpy).toHaveBeenCalledOnce();
    expect(diagnostics.getLast()).toMatchObject({
      outcome: "skipped",
      reason: "disabled",
      route: "unknown",
      bytes: 0,
    });
  });

  it("skips a file below the configured threshold", async () => {
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: HINT_SIZE,
    };
    const cloud = bytes("cloud");
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(cloud);
    const downloadFile = vi.fn();
    const diagnostics = new LanDiagnostics();
    client.setLanDiagnostics(diagnostics);
    client.setLanContentSource(makeSource(downloadFile));
    enableLan(client, 64 * 1024 * 1024);

    expect(client.shouldAttemptLan(HINT_SIZE)).toBe(false);
    const result = await client.downloadFileWithLan(
      "vault",
      "note.bin",
      undefined,
      undefined,
      HINT_SIZE,
      undefined,
      hint,
    );

    expect(result).toBe(cloud);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(diagnostics.getLast()).toMatchObject({
      outcome: "skipped",
      reason: "below-threshold",
    });
  });

  it("records a hit with the selected route", async () => {
    const lanBytes = bytes("lan payload");
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: lanBytes.byteLength,
    };
    const client = new OneDriveClient(async () => "token");
    vi.spyOn(client, "downloadFile").mockResolvedValue(bytes("cloud"));
    const diagnostics = new LanDiagnostics();
    client.setLanDiagnostics(diagnostics);
    client.setLanContentSource(makeSource(
      vi.fn().mockResolvedValue({
        bytes: lanBytes,
        sha256: await sha256Hex(lanBytes),
      }),
      async () => "host",
    ));
    enableLan(client, 0);

    const result = await client.downloadFileWithLan(
      "vault",
      "note.bin",
      undefined,
      undefined,
      lanBytes.byteLength,
      undefined,
      hint,
    );

    expect(new Uint8Array(result)).toEqual(new Uint8Array(lanBytes));
    expect(diagnostics.getLast()).toMatchObject({
      outcome: "hit",
      route: "host",
      bytes: lanBytes.byteLength,
    });
  });

  it("rejects a relay route and falls back to the cloud", async () => {
    const lanBytes = bytes("lan payload");
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: lanBytes.byteLength,
    };
    const cloud = bytes("cloud");
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(cloud);
    const diagnostics = new LanDiagnostics();
    client.setLanDiagnostics(diagnostics);
    client.setLanContentSource(makeSource(
      vi.fn().mockResolvedValue({
        bytes: lanBytes,
        sha256: await sha256Hex(lanBytes),
      }),
      async () => "relay",
    ));
    enableLan(client, 0);

    const result = await client.downloadFileWithLan(
      "vault",
      "note.bin",
      undefined,
      undefined,
      lanBytes.byteLength,
      undefined,
      hint,
    );

    expect(result).toBe(cloud);
    expect(cloudSpy).toHaveBeenCalledOnce();
    expect(diagnostics.getLast()).toMatchObject({
      outcome: "fallback",
      reason: "route-relay",
      route: "relay",
    });
  });

  it("records the mobile path hit and its route", async () => {
    const hint = {
      path: "note.bin",
      eTag: "etag-1",
      size: HINT_SIZE,
    };
    const hash = "cc".repeat(32);
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFileToPath");
    const adapter = {
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const diagnostics = new LanDiagnostics();
    client.setLanDiagnostics(diagnostics);
    client.setLanContentSource({
      downloadFile: vi.fn(),
      downloadFileToPath: vi.fn().mockResolvedValue({ size: HINT_SIZE, hash }),
      getRouteType: async () => "srflx",
    });
    enableLan(client, 0);

    const result = await client.downloadFileToPathWithLan(
      "vault",
      "note.bin",
      ".easy-sync/tmp/note.part",
      adapter as never,
      undefined,
      undefined,
      HINT_SIZE,
      undefined,
      undefined,
      hint,
    );

    expect(result).toEqual({ size: HINT_SIZE, hash });
    expect(cloudSpy).not.toHaveBeenCalled();
    expect(diagnostics.getLast()).toMatchObject({
      outcome: "hit",
      route: "srflx",
      bytes: HINT_SIZE,
    });
  });
});
