import { afterEach, describe, expect, it, vi } from "vitest";
import { OneDriveClient } from "../src/onedrive/client";
import { sha256Hex } from "../src/crypto";
import type {
  LanContentHint,
  LanContentSource,
  LanSourceProvider,
} from "../src/sync/lan-content-source";
import { LanDiagnostics } from "../src/sync/lan-diagnostics";

const MIB = 1024 * 1024;

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  );
}

function hint(size = MIB): LanContentHint {
  return { path: "big.bin", eTag: "etag-1", size };
}

function sourceFor(payload: ArrayBuffer, hash?: string): LanContentSource {
  return {
    downloadFile: vi.fn(async () => ({
      bytes: payload,
      sha256: hash ?? await sha256Hex(payload),
    })),
    downloadFileToPath: vi.fn(async () => ({
      size: payload.byteLength,
      hash: hash ?? await sha256Hex(payload),
    })),
    getRouteType: async () => "host",
  };
}

function provider(acquired: LanContentSource | null): {
  provider: LanSourceProvider;
  acquire: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const acquire = vi.fn(async () => acquired);
  const stop = vi.fn();
  return {
    provider: { acquire, stop } as LanSourceProvider,
    acquire,
    stop,
  };
}

describe("OneDriveClient LAN provider seam (S5a)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never acquires while the switch is off and keeps the cloud call shape", async () => {
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(bytes("cloud"));
    const { provider: seam, acquire } = provider(sourceFor(bytes("lan")));
    client.setLanSourceProvider(seam);
    client.setLanAcceleration({ enabled: false, thresholdBytes: 0 });

    expect(client.shouldAttemptLan(MIB)).toBe(false);
    const result = await client.downloadFileWithLan(
      "vault",
      "big.bin",
      undefined,
      undefined,
      MIB,
      undefined,
      hint(),
    );

    expect(result).toBe(await cloudSpy.mock.results[0].value);
    expect(acquire).not.toHaveBeenCalled();
    expect(cloudSpy).toHaveBeenCalledOnce();
    expect(cloudSpy.mock.calls[0]).toEqual([
      "vault",
      "big.bin",
      undefined,
      undefined,
      MIB,
      undefined,
    ]);
  });

  it("defaults to on at the product 8 MiB threshold", () => {
    const client = new OneDriveClient(async () => "token");
    client.setLanContentSource(sourceFor(bytes("lan")));

    expect(client.shouldAttemptLan(8 * MIB - 1)).toBe(false);
    expect(client.shouldAttemptLan(8 * MIB)).toBe(true);
  });

  it("never acquires below the threshold", async () => {
    const client = new OneDriveClient(async () => "token");
    vi.spyOn(client, "downloadFile").mockResolvedValue(bytes("cloud"));
    const { provider: seam, acquire } = provider(sourceFor(bytes("lan")));
    client.setLanSourceProvider(seam);
    client.setLanAcceleration({ enabled: true, thresholdBytes: 8 * MIB });

    expect(client.shouldAttemptLan(MIB)).toBe(false);
    await client.downloadFileWithLan(
      "vault",
      "big.bin",
      undefined,
      undefined,
      MIB,
      undefined,
      hint(),
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it("acquires once when eligible, then reuses the same source for the next file", async () => {
    const lanBytes = bytes("lan payload");
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(bytes("cloud"));
    const source = sourceFor(lanBytes);
    const { provider: seam, acquire } = provider(source);
    client.setLanSourceProvider(seam);
    client.setLanAcceleration({ enabled: true, thresholdBytes: 0 });

    expect(client.shouldAttemptLan(MIB)).toBe(true);
    const first = await client.downloadFileWithLan(
      "vault",
      "big.bin",
      undefined,
      undefined,
      lanBytes.byteLength,
      undefined,
      { ...hint(lanBytes.byteLength) },
    );
    expect(new Uint8Array(first)).toEqual(new Uint8Array(lanBytes));
    expect(acquire).toHaveBeenCalledOnce();
    expect(cloudSpy).not.toHaveBeenCalled();

    // Second file: the installed source is reused without a new acquisition.
    const second = await client.downloadFileWithLan(
      "vault",
      "big2.bin",
      undefined,
      undefined,
      lanBytes.byteLength,
      undefined,
      { path: "big2.bin", eTag: "etag-2", size: lanBytes.byteLength },
    );
    expect(new Uint8Array(second)).toEqual(new Uint8Array(lanBytes));
    expect(acquire).toHaveBeenCalledOnce();
    expect(cloudSpy).not.toHaveBeenCalled();
  });

  it("falls back to the cloud when acquisition returns null", async () => {
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(bytes("cloud"));
    const diagnostics = new LanDiagnostics();
    client.setLanDiagnostics(diagnostics);
    const { provider: seam, acquire } = provider(null);
    client.setLanSourceProvider(seam);
    client.setLanAcceleration({ enabled: true, thresholdBytes: 0 });

    const result = await client.downloadFileWithLan(
      "vault",
      "big.bin",
      undefined,
      undefined,
      MIB,
      undefined,
      hint(),
    );

    expect(result).toBe(await cloudSpy.mock.results[0].value);
    expect(acquire).toHaveBeenCalledOnce();
    expect(cloudSpy).toHaveBeenCalledOnce();
    expect(diagnostics.getLast()).toMatchObject({
      outcome: "skipped",
      reason: "no-source",
    });
  });

  it("records a source error and falls back when acquisition throws", async () => {
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFile").mockResolvedValue(bytes("cloud"));
    const diagnostics = new LanDiagnostics();
    client.setLanDiagnostics(diagnostics);
    const acquire = vi.fn(async () => {
      throw new Error("transport down");
    });
    client.setLanSourceProvider({ acquire, stop: vi.fn() });
    client.setLanAcceleration({ enabled: true, thresholdBytes: 0 });

    const result = await client.downloadFileWithLan(
      "vault",
      "big.bin",
      undefined,
      undefined,
      MIB,
      undefined,
      hint(),
    );

    expect(result).toBe(await cloudSpy.mock.results[0].value);
    expect(cloudSpy).toHaveBeenCalledOnce();
    expect(diagnostics.getLast()).toMatchObject({
      outcome: "fallback",
      reason: "source-error",
    });
  });

  it("clears the injected source when the provider is removed", async () => {
    const client = new OneDriveClient(async () => "token");
    vi.spyOn(client, "downloadFile").mockResolvedValue(bytes("cloud"));
    const source = sourceFor(bytes("lan"));
    client.setLanContentSource(source);
    client.setLanAcceleration({ enabled: true, thresholdBytes: 0 });
    expect(client.shouldAttemptLan(MIB)).toBe(true);

    client.setLanSourceProvider(null);
    expect(client.shouldAttemptLan(MIB)).toBe(false);
    const result = await client.downloadFileWithLan(
      "vault",
      "big.bin",
      undefined,
      undefined,
      MIB,
      undefined,
      hint(),
    );
    expect(new Uint8Array(result)).toEqual(new Uint8Array(bytes("cloud")));
    expect(source.downloadFile).not.toHaveBeenCalled();
  });

  it("uses the acquired source on the mobile path lane too", async () => {
    const lanBytes = bytes("lan payload");
    const client = new OneDriveClient(async () => "token");
    const cloudSpy = vi.spyOn(client, "downloadFileToPath");
    const adapter = { remove: vi.fn().mockResolvedValue(undefined) } as never;
    const source = sourceFor(lanBytes);
    const { provider: seam, acquire } = provider(source);
    client.setLanSourceProvider(seam);
    client.setLanAcceleration({ enabled: true, thresholdBytes: 0 });

    const result = await client.downloadFileToPathWithLan(
      "vault",
      "big.bin",
      ".easy-sync/tmp/big.part",
      adapter,
      undefined,
      undefined,
      lanBytes.byteLength,
      undefined,
      undefined,
      hint(lanBytes.byteLength),
    );

    expect(result).toEqual({
      size: lanBytes.byteLength,
      hash: await sha256Hex(lanBytes),
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(cloudSpy).not.toHaveBeenCalled();
  });
});
