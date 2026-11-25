import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../src/crypto";
import {
  LAN_PARTITION_BYTES,
  LanPartitionWriter,
  LanPeerSession,
  createLanContentSource,
  type LanPartitionSink,
  type LanPathResult,
} from "../src/dev/lan-session";
import type { LanContentHint } from "../src/sync/lan-content-source";

const MIB = 1024 * 1024;
const HINT: LanContentHint = {
  path: "LanS3a/payload.bin",
  eTag: "etag-1",
  size: 2.5 * MIB,
};

function bytes(size: number): ArrayBuffer {
  const value = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) value[index] = index % 251;
  return value.buffer;
}

function exact(buffer: ArrayBuffer, offset: number, length: number): ArrayBuffer {
  return buffer.slice(offset, offset + length);
}

class RecordingSink implements LanPartitionSink {
  readonly order: string[] = [];
  readonly parts: ArrayBuffer[] = [];

  async write(value: ArrayBuffer): Promise<void> {
    this.order.push(`write:${value.byteLength}`);
    this.parts.push(value);
  }

  async append(value: ArrayBuffer): Promise<void> {
    this.order.push(`append:${value.byteLength}`);
    this.parts.push(value);
  }
}

class FakeDataChannel {
  binaryType = "";
  bufferedAmountLowThreshold = 0;
  readyState = "open";
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, current.filter((entry) => entry !== listener));
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = "closed";
  }

  emit(type: string, event: { data: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakePeerConnection {
  stats = new Map<string, Record<string, unknown>>();
  statsError: Error | null = null;

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    if (this.statsError !== null) throw this.statsError;
    return this.stats;
  }

  close(): void {}
}

describe("LAN partition writer", () => {
  it("writes exactly one partition at 1 MiB and no append", async () => {
    const sink = new RecordingSink();
    const writer = new LanPartitionWriter(sink);
    const payload = bytes(MIB);
    writer.push(payload);

    const result = await writer.finish();
    expect(sink.order).toEqual([`write:${MIB}`]);
    expect(await sha256Hex(payload)).toBe(result.hash);
    expect(result.size).toBe(MIB);
  });

  it("appends the last partial partition and hashes the whole stream", async () => {
    const sink = new RecordingSink();
    const writer = new LanPartitionWriter(sink);
    const payload = bytes(2.5 * MIB);
    for (let offset = 0; offset < payload.byteLength; offset += 256 * 1024) {
      writer.push(exact(payload, offset, Math.min(256 * 1024, payload.byteLength - offset)));
    }

    const result = await writer.finish();
    expect(sink.order).toEqual([
      `write:${MIB}`,
      `append:${MIB}`,
      `append:${0.5 * MIB}`,
    ]);
    expect(result.size).toBe(2.5 * MIB);
    expect(result.hash).toBe(await sha256Hex(payload));
  });

  it("splits a chunk that crosses the partition boundary", async () => {
    const sink = new RecordingSink();
    const writer = new LanPartitionWriter(sink);
    const payload = bytes(600 * 1024 + 600 * 1024);
    writer.push(exact(payload, 0, 600 * 1024));
    writer.push(exact(payload, 600 * 1024, 600 * 1024));

    const result = await writer.finish();
    expect(sink.order).toEqual([
      `write:${MIB}`,
      `append:${176 * 1024}`,
    ]);
    expect(result.hash).toBe(await sha256Hex(payload));
  });

  it("creates an empty file for a zero-byte payload", async () => {
    const sink = new RecordingSink();
    const writer = new LanPartitionWriter(sink);
    const result = await writer.finish();
    expect(sink.order).toEqual(["write:0"]);
    expect(result).toEqual({ size: 0, hash: await sha256Hex(new ArrayBuffer(0)) });
  });

  it("rejects when a sink append fails", async () => {
    const sink: LanPartitionSink = {
      write: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    const writer = new LanPartitionWriter(sink);
    const payload = bytes(2 * MIB);
    writer.push(payload);
    await expect(writer.finish()).rejects.toThrow("disk full");
  });

  it("uses the exported 1 MiB partition size", () => {
    expect(LAN_PARTITION_BYTES).toBe(MIB);
  });
});

describe("LAN content source streaming path", () => {
  it("writes the first partition and appends later partitions", async () => {
    const writes: string[] = [];
    const adapter = {
      writeBinary: vi.fn(async (_path: string, value: ArrayBuffer) => {
        writes.push(`write:${value.byteLength}`);
      }),
      appendBinary: vi.fn(async (_path: string, value: ArrayBuffer) => {
        writes.push(`append:${value.byteLength}`);
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as DataAdapter;
    const requestToSink = vi.fn(async (
      _hint: LanContentHint,
      sink: LanPartitionSink,
    ) => {
      await sink.write(bytes(MIB));
      await sink.append(bytes(0.5 * MIB));
      return { size: 1.5 * MIB, hash: "ab".repeat(32) };
    });
    const source = createLanContentSource({
      requestBytes: vi.fn(),
      requestToSink,
    } as unknown as LanPeerSession);

    const result: LanPathResult = await source.downloadFileToPath(
      { ...HINT, size: 1.5 * MIB },
      ".easy-sync/tmp/downloads/payload.part",
      adapter,
    );

    expect(result).toEqual({ size: 1.5 * MIB, hash: "ab".repeat(32) });
    expect(writes).toEqual([`write:${MIB}`, `append:${0.5 * MIB}`]);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("removes the temporary file when the sink request rejects", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      writeBinary: vi.fn(),
      appendBinary: vi.fn(),
      remove,
    } as unknown as DataAdapter;
    const source = createLanContentSource({
      requestBytes: vi.fn(),
      requestToSink: vi.fn().mockRejectedValue(new Error("LAN hash mismatch")),
    } as unknown as LanPeerSession);

    await expect(source.downloadFileToPath(
      HINT,
      ".easy-sync/tmp/downloads/payload.part",
      adapter,
    )).rejects.toThrow("LAN hash mismatch");
    expect(remove).toHaveBeenCalledWith(".easy-sync/tmp/downloads/payload.part");
  });
});

describe("LanPeerSession streaming request", () => {
  it("streams transport chunks through 1 MiB partitions and verifies the hash", async () => {
    const pc = new FakePeerConnection();
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      pc as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );
    const sink = new RecordingSink();
    const payload = bytes(2.5 * MIB);
    const payloadHash = await sha256Hex(payload);
    const hint = { ...HINT, size: payload.byteLength };

    const pending = session.requestToSink(hint, sink);
    expect(JSON.parse(String(dc.sent[0]))).toMatchObject({
      type: "request",
      path: hint.path,
      eTag: hint.eTag,
      size: hint.size,
    });
    dc.emit("message", {
      data: JSON.stringify({
        type: "meta",
        protocol: "easy-sync-lan-session-v1",
        path: hint.path,
        eTag: hint.eTag,
        size: hint.size,
        sha256: payloadHash,
      }),
    });
    for (let offset = 0; offset < payload.byteLength; offset += 256 * 1024) {
      dc.emit("message", {
        data: exact(payload, offset, Math.min(256 * 1024, payload.byteLength - offset)),
      });
    }
    dc.emit("message", {
      data: JSON.stringify({
        type: "done",
        size: hint.size,
        sha256: payloadHash,
      }),
    });

    await expect(pending).resolves.toEqual({
      size: hint.size,
      hash: payloadHash,
    });
    expect(sink.order).toEqual([
      `write:${MIB}`,
      `append:${MIB}`,
      `append:${0.5 * MIB}`,
    ]);
    expect(JSON.parse(String(dc.sent.at(-1)))).toMatchObject({
      type: "result",
      ok: true,
      size: hint.size,
      sha256: payloadHash,
    });
  });

  it("rejects and aborts the writer when the session closes mid-transfer", async () => {
    const pc = new FakePeerConnection();
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      pc as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );
    const sink = new RecordingSink();
    const pending = session.requestToSink({ ...HINT, size: MIB }, sink);
    dc.emit("message", {
      data: JSON.stringify({
        type: "meta",
        protocol: "easy-sync-lan-session-v1",
        path: HINT.path,
        eTag: HINT.eTag,
        size: MIB,
        sha256: "ab".repeat(32),
      }),
    });
    dc.emit("message", { data: bytes(256 * 1024) });
    session.close();

    await expect(pending).rejects.toThrow("LAN session closed");
  });

  it("serves several files in a row over one open session", async () => {
    // Field report 2026-11-20: the modal handshake worked but only one file
    // moved before the channel looked dead. One session must keep accepting
    // requests; the single-flight guard only serialises them, it must not
    // latch after the first completion.
    const pc = new FakePeerConnection();
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      pc as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );
    const served: string[] = [];
    session.serveRequests(
      async (request) => {
        served.push(request.path);
        return { bytes: bytes(MIB), sha256: await sha256Hex(bytes(MIB)) };
      },
      undefined,
      (done) => served.push(`done:${done.path}`),
    );

    const payloadHash = await sha256Hex(bytes(MIB));
    const sendRequest = (name: string): void => {
      dc.emit("message", {
        data: JSON.stringify({
          type: "request",
          protocol: "easy-sync-lan-session-v1",
          path: `LanS3a/${name}`,
          eTag: "etag-1",
          size: MIB,
        }),
      });
    };
    const ack = (): void => {
      dc.emit("message", {
        data: JSON.stringify({
          type: "result",
          ok: true,
          size: MIB,
          sha256: payloadHash,
        }),
      });
    };
    const settle = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 0));
    const waitFor = async (
      predicate: () => boolean,
      label: string,
    ): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await settle();
      }
      throw new Error(`condition never became true: ${label}`);
    };

    // File 1: request → served. Wait until its payload and `done` frame are on
    // the wire, because only then is the receiver's ack meaningful.
    sendRequest("first.bin");
    await waitFor(() => served.length === 1, "first serve started");
    await waitFor(() => dc.sent.some((entry) =>
      typeof entry === "string"
      && (JSON.parse(entry) as { type?: string }).type === "done"),
      "first done frame sent");

    // File 2 arrives while file 1 is still unacknowledged. It must be queued,
    // not started: starting it would drop file 1's completion callback.
    sendRequest("second.bin");
    for (let i = 0; i < 20; i += 1) await settle();
    expect(served).toEqual(["LanS3a/first.bin"]);

    // Acknowledging file 1 releases the slot, and the queued file 2 runs.
    ack();
    await waitFor(() => served.includes("done:LanS3a/first.bin"), "first done");
    await waitFor(
      () => served.includes("LanS3a/second.bin"),
      "second serve started",
    );

    // One more round proves the slot keeps cycling rather than latching.
    await waitFor(() => dc.sent.filter((entry) =>
      typeof entry === "string"
      && (JSON.parse(entry) as { type?: string }).type === "done").length === 2,
      "second done frame sent");
    ack();
    await waitFor(() => served.includes("done:LanS3a/second.bin"), "second done");
    sendRequest("third.bin");
    await waitFor(
      () => served.includes("LanS3a/third.bin"),
      "third serve started",
    );
    await waitFor(() => dc.sent.filter((entry) =>
      typeof entry === "string"
      && (JSON.parse(entry) as { type?: string }).type === "done").length === 3,
      "third done frame sent");
    ack();
    await waitFor(() => served.includes("done:LanS3a/third.bin"), "third done");
    expect(served).toEqual([
      "LanS3a/first.bin",
      "done:LanS3a/first.bin",
      "LanS3a/second.bin",
      "done:LanS3a/second.bin",
      "LanS3a/third.bin",
      "done:LanS3a/third.bin",
    ]);
    expect(session).toBeDefined();
  });
});

describe("LanPeerSession liveness", () => {
  it("answers a ping with the same nonce", async () => {
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      new FakePeerConnection() as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );
    session.ping();
    const sent = JSON.parse(String(dc.sent.at(-1))) as {
      type: string;
      nonce: number;
    };
    expect(sent.type).toBe("ping");

    // Peer side echoes; the receiving session records the pong.
    dc.emit("message", {
      data: JSON.stringify({ type: "pong", nonce: sent.nonce }),
    });
    expect(session.getHealth(5_000).healthy).toBe(true);
  });

  it("counts running transfers as liveness while pongs lag", async () => {
    const dc = new FakeDataChannel();
    let clock = 1_000;
    const session = new LanPeerSession(
      new FakePeerConnection() as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
      () => clock,
    );
    // No pong ever arrives, but a chunk does: the peer is clearly alive.
    const pending = session.requestToSink(
      { ...HINT, size: 256 * 1024 },
      new RecordingSink(),
    );
    dc.emit("message", {
      data: JSON.stringify({
        type: "meta",
        protocol: "easy-sync-lan-session-v1",
        path: HINT.path,
        eTag: HINT.eTag,
        size: 256 * 1024,
        sha256: "ab".repeat(32),
      }),
    });
    dc.emit("message", { data: bytes(256 * 1024) });
    clock += 4_000;
    expect(session.getHealth(6_000).healthy).toBe(true);
    session.close();
    await expect(pending).rejects.toThrow();
  });

  it("reports unhealthy once the peer has been silent past the tolerance", async () => {
    const dc = new FakeDataChannel();
    let clock = 1_000;
    const session = new LanPeerSession(
      new FakePeerConnection() as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
      () => clock,
    );
    session.ping();
    dc.emit("message", {
      data: JSON.stringify({
        type: "pong",
        nonce: (JSON.parse(String(dc.sent.at(-1))) as { nonce: number }).nonce,
      }),
    });
    clock += 2_000;
    expect(session.getHealth(6_000).healthy).toBe(true);
    clock += 10_000;
    const health = session.getHealth(6_000);
    expect(health.healthy).toBe(false);
    expect(health.silentMs).toBeGreaterThan(6_000);
  });

  it("treats a closed channel as unhealthy regardless of pongs", async () => {
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      new FakePeerConnection() as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );
    dc.close();
    expect(session.getHealth(6_000).healthy).toBe(false);
  });
});

describe("LanPeerSession route diagnostics", () => {
  it("returns only the selected local candidate type", async () => {
    const pc = new FakePeerConnection();
    pc.stats = new Map<string, Record<string, unknown>>([
      ["transport", { type: "transport", selectedCandidatePairId: "pair-1" }],
      ["pair-1", {
        type: "candidate-pair",
        localCandidateId: "local-1",
        selected: true,
      }],
      ["local-1", {
        type: "local-candidate",
        candidateType: "srflx",
        address: "203.0.113.7",
        port: 5000,
      }],
    ]);
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      pc as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );

    await expect(session.getRouteType()).resolves.toBe("srflx");
  });

  it("falls back to an unknown route when stats are unavailable", async () => {
    const pc = new FakePeerConnection();
    pc.statsError = new Error("stats failed");
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      pc as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );

    await expect(session.getRouteType()).resolves.toBe("unknown");
  });
});

describe("LanPeerSession sender completion", () => {
  it("reports served only after the receiver acknowledges the payload", async () => {
    const pc = new FakePeerConnection();
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      pc as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );
    const payload = bytes(MIB);
    const payloadHash = await sha256Hex(payload);
    const served: Array<{
      path: string;
      size: number;
      sha256: string;
      elapsedMs: number;
    }> = [];
    session.serveRequests(
      async () => ({ bytes: payload, sha256: payloadHash }),
      undefined,
      (result) => served.push(result),
    );

    dc.emit("message", {
      data: JSON.stringify({
        type: "request",
        protocol: "easy-sync-lan-session-v1",
        path: HINT.path,
        eTag: HINT.eTag,
        size: MIB,
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    // Bytes are on the wire but the receiver has not acknowledged them yet.
    expect(JSON.parse(String(dc.sent.at(-1)))).toMatchObject({ type: "done" });
    expect(served).toEqual([]);

    dc.emit("message", {
      data: JSON.stringify({
        type: "result",
        ok: true,
        size: MIB,
        sha256: payloadHash,
      }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(served).toEqual([{
      path: HINT.path,
      size: MIB,
      sha256: payloadHash,
      elapsedMs: expect.any(Number),
    }]);
  });

  it("does not report served when the receiver rejects the payload", async () => {
    const pc = new FakePeerConnection();
    const dc = new FakeDataChannel();
    const session = new LanPeerSession(
      pc as unknown as RTCPeerConnection,
      dc as unknown as RTCDataChannel,
    );
    const payload = bytes(MIB);
    const payloadHash = await sha256Hex(payload);
    const served: unknown[] = [];
    session.serveRequests(
      async () => ({ bytes: payload, sha256: payloadHash }),
      undefined,
      (result) => served.push(result),
    );

    dc.emit("message", {
      data: JSON.stringify({
        type: "request",
        protocol: "easy-sync-lan-session-v1",
        path: HINT.path,
        eTag: HINT.eTag,
        size: MIB,
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    dc.emit("message", {
      data: JSON.stringify({ type: "result", ok: false, error: "LAN sha256 mismatch" }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(served).toEqual([]);
  });
});
