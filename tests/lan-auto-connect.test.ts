import { describe, expect, it, vi } from "vitest";
import {
  LAN_PAIRING_PATH,
  LAN_SIGNAL_ACTIVE_PATH,
  LAN_SIGNAL_PROTOCOL_VERSION,
  LAN_SIGNALING_FORMAT_VERSION,
  createLanPairingRecord,
  publishLanSignalOffer,
  readLanSignalActiveSession,
  readLanSignalOffer,
  serializeLanPairingRecord,
  writeLanSignalAnswer,
  type LanPairingRecord,
  type LanSignalDeleteOptions,
  type LanSignalSession,
  type LanSignalTextObject,
  type LanSignalTransport,
  type LanSignalWriteOptions,
} from "../src/sync/lan-signaling";
import {
  LAN_PRESENCE_REQUEST_PATH,
  createLanPresenceRequest,
  serializeLanPresenceRequest,
} from "../src/sync/lan-presence";
import {
  LAN_ACQUIRE_AWAIT_MS,
  LAN_ACQUIRE_CHANNEL_WAIT_MS,
  LAN_ACQUIRE_FAILURE_COOLDOWN_MS,
  LAN_ACQUIRE_OFFER_WAIT_MS,
  LAN_ACQUIRE_POLL_MS,
  LAN_ACQUIRE_WAIT_FULL_BYTES,
  LAN_ACQUIRE_WAIT_MAX_MS,
  LAN_AUTO_CONNECT_CANDIDATE_WINDOW_MS,
  LAN_AUTO_CONNECT_ICE_WINDOW_MS,
  LAN_HEARTBEAT_INTERVAL_MS,
  LAN_HOST_ANSWER_WAIT_MS,
  LAN_HOST_CHANNEL_WAIT_MS,
  LAN_TRANSFER_SILENCE_MS,
  LAN_WATCHER_ACTIVE_INTERVAL_MS,
  LAN_WATCHER_ACTIVE_WINDOW_MS,
  LAN_WATCHER_IDLE_INTERVAL_MS,
  LanAutoConnectManager,
  acquireAwaitMs,
  type LanAutoConnectDeps,
  type LanAutoConnectLogEvent,
  type LanAutoConnectState,
  type LanAutoConnectTimers,
} from "../src/sync/lan-auto-connect";

/**
 * Compile-time inventory of the manager's public contract, mirroring the
 * signaling test: keeps accidental surface drift visible without exporting
 * unused runtime values.
 */
type LanAutoConnectContractTypes = [
  LanAutoConnectDeps,
  LanAutoConnectLogEvent,
  LanAutoConnectState,
  LanAutoConnectTimers,
];
import type { LanContentSource } from "../src/sync/lan-content-source";
import type { LanServeGateDeps } from "../src/sync/lan-serve-gate";

const ROOM_SECRET = "11".repeat(32);
const HOST_FINGERPRINT = "ab".repeat(32);
const JOINER_FINGERPRINT = "cd".repeat(32);
const HOST_SDP = sdpWithFingerprint(HOST_FINGERPRINT);
const JOINER_SDP = sdpWithFingerprint(JOINER_FINGERPRINT);
const HOST_CANDIDATE = "candidate:1 1 UDP 2122260223 192.168.1.10 50000 typ host";

function sdpWithFingerprint(fingerprint: string): string {
  const colonized = fingerprint.match(/.{2}/g)?.join(":").toUpperCase()
    ?? fingerprint;
  return [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    `a=fingerprint:sha-256 ${colonized}`,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "",
  ].join("\r\n");
}

/** Deterministic clock: every sleep advances it instead of waiting. */
class FakeClock implements LanAutoConnectTimers {
  value = 1_000_000;
  readonly scheduled: Array<{ id: number; at: number }> = [];
  private nextId = 1;
  readonly sleeps: number[] = [];

  now(): number {
    return this.value;
  }

  setTimeout(_handler: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.scheduled.push({ id, at: this.value + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const index = this.scheduled.findIndex((entry) => entry.id === handle);
    if (index >= 0) this.scheduled.splice(index, 1);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.value += ms;
    // Yield to the real event loop so a background test peer can observe the
    // cloud objects this role just wrote. Without this the whole fake-clock
    // window can elapse inside one microtask chain and the peer never runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

class FakeDataChannel {
  binaryType = "";
  bufferedAmountLowThreshold = 0;
  bufferedAmount = 0;
  readyState = "connecting";
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.emit("close", {});
  }

  open(): void {
    if (this.readyState === "open") return;
    this.readyState = "open";
    this.emit("open", {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakePeerConnection {
  iceGatheringState: RTCIceGatheringState = "complete";
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  channel: FakeDataChannel | null = null;
  private candidateListeners: Array<(event: { candidate?: { candidate: string } }) => void> = [];

  createDataChannel(): FakeDataChannel {
    this.channel = new FakeDataChannel();
    return this.channel;
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: HOST_SDP };
  }

  async createAnswer(): Promise<{ type: "answer"; sdp: string }> {
    return { type: "answer", sdp: JOINER_SDP };
  }

  async setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description;
    queueMicrotask(() => {
      for (const listener of this.candidateListeners) {
        listener({ candidate: { candidate: HOST_CANDIDATE } });
      }
    });
  }

  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
    if (description.type === "offer") {
      const channel = new FakeDataChannel();
      this.channel = channel;
      this.ondatachannel?.({ channel });
      queueMicrotask(() => channel.open());
      return;
    }
    const channel = this.channel;
    queueMicrotask(() => channel?.open());
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === "icecandidate") {
      this.candidateListeners.push(listener as never);
    }
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    if (type === "icecandidate") {
      this.candidateListeners = this.candidateListeners.filter(
        (entry) => entry !== listener,
      );
    }
  }

  getTransceivers(): Array<{ mid: string }> {
    return [{ mid: "0" }];
  }

  async addIceCandidate(): Promise<void> {}

  close(): void {
    this.channel?.close();
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return new Map();
  }
}

class FakeSignalTransport implements LanSignalTransport {
  readonly files = new Map<string, { text: string; eTag: string }>();
  readonly readPaths: string[] = [];
  readonly writePaths: string[] = [];
  readonly deletePaths: string[] = [];
  private sequence = 0;
  failAllWrites = false;

  async readText(path: string): Promise<LanSignalTextObject | null> {
    this.readPaths.push(path);
    const entry = this.files.get(path);
    return entry === undefined ? null : { path, eTag: entry.eTag, text: entry.text };
  }

  async writeText(
    path: string,
    text: string,
    options?: LanSignalWriteOptions,
  ): Promise<{ path: string; eTag: string }> {
    this.writePaths.push(path);
    if (this.failAllWrites) throw new Error("cloud write failed");
    const existing = this.files.get(path);
    if (options?.createOnly === true && existing !== undefined) {
      throw new Error("already exists");
    }
    if (options?.ifMatch !== undefined && existing?.eTag !== options.ifMatch) {
      throw new Error("stale eTag");
    }
    const eTag = `etag-${++this.sequence}`;
    this.files.set(path, { text, eTag });
    return { path, eTag };
  }

  async delete(
    path: string,
    options?: LanSignalDeleteOptions,
  ): Promise<boolean> {
    this.deletePaths.push(path);
    const existing = this.files.get(path);
    if (existing === undefined) return false;
    if (options?.ifMatch !== undefined && existing.eTag !== options.ifMatch) {
      return false;
    }
    this.files.delete(path);
    return true;
  }

  async listPaths(): Promise<string[]> {
    return [];
  }

  put(path: string, text: string): string {
    const eTag = `raw-${++this.sequence}`;
    this.files.set(path, { text, eTag });
    return eTag;
  }
}

async function pairing(): Promise<LanPairingRecord> {
  return createLanPairingRecord({
    now: 900_000,
    randomBytes: (length) => new Uint8Array(length).fill(0x11),
  });
}

async function seedPairing(
  transport: FakeSignalTransport,
  record: LanPairingRecord,
): Promise<void> {
  transport.put(LAN_PAIRING_PATH, serializeLanPairingRecord(record));
}

async function seedPresence(
  transport: FakeSignalTransport,
  room: LanPairingRecord,
  clock: FakeClock,
): Promise<void> {
  const request = await createLanPresenceRequest({
    pairing: room,
    now: clock.now(),
    ttlMs: 60_000,
  });
  if (request === null) throw new Error("presence request was rejected");
  transport.put(LAN_PRESENCE_REQUEST_PATH, serializeLanPresenceRequest(request));
}

function serveGate(): LanServeGateDeps {
  return {
    isReady: () => true,
    getBaseEntry: () => undefined,
    shouldSyncPath: () => false,
    inspectFile: async () => ({ status: "missing" }),
    readRemoteETag: async () => null,
    readLocalBytes: async () => new ArrayBuffer(0),
    hashBytes: async () => "",
  };
}

interface HarnessOptions {
  mobile?: boolean;
  transport?: FakeSignalTransport;
  clock?: FakeClock;
  /** Throw from the sidebar sinks to prove they are display-only. */
  brokenSink?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const transport = options.transport ?? new FakeSignalTransport();
  const clock = options.clock ?? new FakeClock();
  const logs: Array<{ event: LanAutoConnectLogEvent; message: string }> = [];
  const injected: LanContentSource[] = [];
  const phases: Array<"pairing" | "connected" | "transferring" | null> = [];
  const progress: Array<{ downloaded: number; total: number }> = [];
  let clears = 0;
  const manager = new LanAutoConnectManager({
    createTransport: () => transport,
    serveGate: serveGate(),
    injectSource: (source) => {
      injected.push(source);
      return true;
    },
    clearSource: () => {
      clears += 1;
    },
    platform: {
      isDesktopApp: !options.mobile,
      isMobileApp: options.mobile === true,
      isIosApp: false,
      isAndroidApp: false,
      isDesktop: !options.mobile,
      isMobile: options.mobile === true,
    },
    timers: clock,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    log: (event, message) => logs.push({ event, message }),
    // A throwing sink must never disturb the session (S5b).
    reportPhase: (phase) => {
      phases.push(phase);
      if (options.brokenSink === true) throw new Error("sidebar sink is gone");
    },
    reportProgress: (downloaded, total) => {
      progress.push({ downloaded, total });
      if (options.brokenSink === true) throw new Error("sidebar sink is gone");
    },
  });
  return {
    manager,
    transport,
    clock,
    logs,
    injected,
    phases,
    progress,
    clears: () => clears,
  };
}

/** Background test peer: find the active session, read its offer, answer once. */
async function answerOnce(
  transport: FakeSignalTransport,
  room: LanPairingRecord,
  clock: FakeClock,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const active = await readLanSignalActiveSession(transport, {
      pairing: room,
      now: clock.now(),
    });
    if (active.status === "active") {
      const offer = await readLanSignalOffer(transport, {
        pairing: room,
        session: active.session,
        now: clock.now(),
        activeSession: active.session,
      });
      if (offer.status === "ready" && offer.record.type === "offer") {
        await writeLanSignalAnswer(transport, {
          pairing: room,
          session: active.session,
          sdp: JOINER_SDP,
          now: clock.now(),
          activeSession: active.session,
        });
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("test peer never saw an offer");
}

/** Background test host: wait for a presence request, then publish one offer. */
async function publishOnce(
  transport: FakeSignalTransport,
  room: LanPairingRecord,
  clock: FakeClock,
): Promise<LanSignalSession> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const entry = transport.files.get(LAN_PRESENCE_REQUEST_PATH);
    if (entry !== undefined) {
      const published = await publishLanSignalOffer(transport, {
        pairing: room,
        sdp: HOST_SDP,
        now: clock.now(),
      });
      if (published.status === "published") return published.session;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("test host never saw a presence request");
}

describe("LAN auto connect watcher", () => {
  it("keeps polling and handshake budgets inside the agreed bounds", () => {
    // Cadence is the cost/benefit stop condition for this slice. Idle polls
    // must stay cheap enough to leave running all day, while the active
    // cadence has to be fast enough that a request written at the start of a
    // peer's sync round is seen while that round is still planning.
    expect(LAN_WATCHER_IDLE_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    expect(LAN_WATCHER_IDLE_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    expect(LAN_WATCHER_ACTIVE_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    expect(LAN_WATCHER_ACTIVE_INTERVAL_MS).toBeLessThanOrEqual(2_000);
    expect(LAN_WATCHER_ACTIVE_WINDOW_MS).toBe(10 * 60_000);
    // The acquisition window must exceed the real handshake (~19–20 s on the
    // field control plane), otherwise the peer answers after the phone gave up.
    expect(LAN_ACQUIRE_OFFER_WAIT_MS).toBeGreaterThanOrEqual(30_000);
    expect(LAN_ACQUIRE_OFFER_WAIT_MS).toBeLessThanOrEqual(45_000);
    // Small files still fall back at once; waiting only pays off once the
    // cloud copy would itself take longer than a handshake.
    expect(LAN_ACQUIRE_AWAIT_MS).toBeGreaterThan(0);
    expect(LAN_ACQUIRE_AWAIT_MS).toBeLessThanOrEqual(5_000);
    expect(LAN_ACQUIRE_POLL_MS).toBe(1_000);
    expect(LAN_ACQUIRE_CHANNEL_WAIT_MS).toBeGreaterThan(0);
    expect(LAN_ACQUIRE_FAILURE_COOLDOWN_MS).toBeGreaterThan(0);
    expect(LAN_HOST_ANSWER_WAIT_MS).toBeGreaterThan(0);
    expect(LAN_HOST_CHANNEL_WAIT_MS).toBeGreaterThan(0);
    // A full gather before publishing is what keeps candidates off the cloud
    // control plane: at a 1.4 s signalling RTT every late candidate costs two
    // round trips, which measured as 3–5 s per handshake.
    expect(LAN_AUTO_CONNECT_ICE_WINDOW_MS).toBeGreaterThanOrEqual(2_000);
    expect(LAN_AUTO_CONNECT_CANDIDATE_WINDOW_MS).toBeGreaterThan(0);
    expect(LAN_AUTO_CONNECT_CANDIDATE_WINDOW_MS).toBeLessThanOrEqual(10_000);
    // Heartbeats must fire well inside SCTP's own 30 s dead-peer timer.
    expect(LAN_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    expect(LAN_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(3_000);
    expect(LAN_TRANSFER_SILENCE_MS).toBeGreaterThan(
      LAN_HEARTBEAT_INTERVAL_MS,
    );
    expect(LAN_TRANSFER_SILENCE_MS).toBeLessThan(30_000);
    // The contract type inventory is referenced so a rename breaks here too.
    const inventory: LanAutoConnectContractTypes = [
      {} as LanAutoConnectDeps,
      {} as LanAutoConnectLogEvent,
      {} as LanAutoConnectState,
      {} as LanAutoConnectTimers,
    ];
    expect(inventory).toHaveLength(4);
  });

  it("scales the per-download wait with size and caps it at the handshake", () => {
    // Small files never block: a handshake cannot pay for itself there.
    expect(acquireAwaitMs(0)).toBe(LAN_ACQUIRE_AWAIT_MS);
    expect(acquireAwaitMs(256 * 1024)).toBeLessThanOrEqual(
      LAN_ACQUIRE_AWAIT_MS + 500,
    );
    // The curve is monotonic, so a larger file may wait longer.
    const mid = acquireAwaitMs(LAN_ACQUIRE_WAIT_FULL_BYTES / 2);
    expect(mid).toBeGreaterThan(LAN_ACQUIRE_AWAIT_MS);
    expect(mid).toBeLessThan(LAN_ACQUIRE_WAIT_MAX_MS);
    const quarter = acquireAwaitMs(LAN_ACQUIRE_WAIT_FULL_BYTES / 4);
    expect(quarter).toBeLessThan(mid);
    // At and above the full size the ceiling applies, and it never exceeds
    // the acquire deadline it is meant to cover.
    expect(acquireAwaitMs(LAN_ACQUIRE_WAIT_FULL_BYTES)).toBe(
      LAN_ACQUIRE_WAIT_MAX_MS,
    );
    expect(acquireAwaitMs(2 * 1024 * 1024 * 1024)).toBe(
      LAN_ACQUIRE_WAIT_MAX_MS,
    );
    expect(LAN_ACQUIRE_WAIT_MAX_MS).toBeLessThanOrEqual(
      LAN_ACQUIRE_OFFER_WAIT_MS + LAN_ACQUIRE_CHANNEL_WAIT_MS,
    );
  });

  it("still serves a peer while its own acquire is in flight", async () => {
    // Field log 2026-11-21 05:45: a desktop skipped 17 watcher ticks over 23 s
    // because it was acquiring itself, so the phone's request aged out before
    // anyone could answer it. Acquiring must not close the sending role. The
    // self-request guard (next test) is what prevents answering our own ask.
    const room = await pairing();
    const h = harness({ mobile: true });
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    (h.manager as unknown as { acquireInFlight: Promise<unknown> })
      .acquireInFlight = new Promise(() => undefined);

    h.manager.start();
    await h.manager.pollOnce();
    // It got past the acquirer guard and reached the request itself.
    expect(h.manager.getState().lastStep).not.toBe("watcher-acquire-in-flight");
    h.manager.stop();
  });

  it("ignores a request this same manager wrote as the acquirer", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    h.manager.start();
    // Mark the seeded nonce as this device's own request; a desktop receiver
    // must stay passive so both sides cannot publish an offer for one request.
    const record = h.transport.files.get(LAN_PRESENCE_REQUEST_PATH);
    const nonce = JSON.parse(record!.text).nonce as string;
    (h.manager as unknown as { ownNonces: { remember(value: string): boolean } })
      .ownNonces.remember(nonce);

    await h.manager.pollOnce();
    expect(h.manager.getState().lastStep).toBe("own-request");
    expect(h.transport.writePaths).toEqual([]);
    expect(h.manager.getState().hostSessionActive).toBe(false);
    h.manager.stop();
  });

  it("clears an expired request instead of polling it forever", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    // Move the clock past the request's lifetime without changing the file.
    h.clock.value += 10 * 60_000;

    h.manager.start();
    await h.manager.pollOnce();
    expect(h.manager.getState().lastStep).toBe("request-expired");
    expect(h.transport.files.has(LAN_PRESENCE_REQUEST_PATH)).toBe(false);
    expect(h.transport.writePaths).toEqual([]);
    expect(h.manager.getState().watcherIntervalMs).toBe(LAN_WATCHER_IDLE_INTERVAL_MS);
    h.manager.stop();
  });

  it("does nothing while no request exists", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    h.manager.start();
    await h.manager.pollOnce();

    expect(h.transport.writePaths).toEqual([]);
    expect(h.transport.readPaths).toContain(LAN_PRESENCE_REQUEST_PATH);
    expect(h.manager.getState()).toMatchObject({
      hostSessionActive: false,
      watcherIntervalMs: LAN_WATCHER_IDLE_INTERVAL_MS,
    });
    h.manager.stop();
  });

  it("keeps the verified pairing for the session instead of re-reading the room", async () => {
    // The room read used to run (with an HMAC verify pass) on every watcher
    // tick. A session that already read the cloud copy keeps it; only a room
    // rejection or stop clears the trust marker.
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    h.manager.start();
    const ensurePairing = (h.manager as unknown as {
      ensurePairing(
        transport: FakeSignalTransport,
        create: boolean,
      ): Promise<LanPairingRecord | null>;
    }).ensurePairing.bind(h.manager);

    expect(await ensurePairing(h.transport, false)).toEqual(room);
    const readsAfterFirst = h.transport.readPaths
      .filter((path) => path === LAN_PAIRING_PATH).length;
    expect(readsAfterFirst).toBeGreaterThan(0);
    // The cloud copy vanishes between ticks; the cached record still serves.
    h.transport.files.delete(LAN_PAIRING_PATH);
    expect(await ensurePairing(h.transport, false)).toEqual(room);
    expect(h.transport.readPaths
      .filter((path) => path === LAN_PAIRING_PATH)).toHaveLength(readsAfterFirst);
    // stop() clears the marker, so the next session reads the cloud again
    // (and finds it gone) instead of reusing a room from the previous run.
    h.manager.stop();
    h.manager.start();
    expect(await ensurePairing(h.transport, false)).toBeNull();
    h.manager.stop();
  });

  it("publishes exactly one offer for a valid request and keeps the channel", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    const joiner = answerOnce(h.transport, room, h.clock);

    h.manager.start();
    await h.manager.pollOnce();
    await joiner;

    const state = h.manager.getState();
    expect(state.hostSessionActive).toBe(true);
    expect(state.watcherIntervalMs).toBe(LAN_WATCHER_ACTIVE_INTERVAL_MS);
    expect(h.transport.writePaths.filter((path) => path.endsWith("/offer.json")))
      .toHaveLength(1);

    // A live session already serves this room: a second tick must not read or
    // write any cloud signaling object again.
    const writesBefore = h.transport.writePaths.length;
    const readsBefore = h.transport.readPaths.length;
    await h.manager.pollOnce();
    expect(h.transport.writePaths.length).toBe(writesBefore);
    expect(h.transport.readPaths.length).toBe(readsBefore);

    h.manager.stop();
    expect(h.manager.getState().hostSessionActive).toBe(false);
  });

  it("stops polling immediately and never resumes on its own", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    h.manager.start();
    h.manager.stop();
    const readsBefore = h.transport.readPaths.length;

    await h.manager.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.transport.readPaths.length).toBe(readsBefore);
    expect(h.clock.scheduled).toEqual([]);
    expect(h.manager.getState().started).toBe(false);
  });

  it("contains a publish failure instead of throwing into the sync chain", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    h.transport.failAllWrites = true;

    h.manager.start();
    await expect(h.manager.pollOnce()).resolves.toBeUndefined();
    expect(h.manager.getState().hostSessionActive).toBe(false);
    expect(h.logs.some((entry) => entry.event.step === "host-error"
      || entry.event.step === "publish-conflict")).toBe(true);
    h.manager.stop();
  });

  it("never logs the room secret or candidate text", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    const joiner = answerOnce(h.transport, room, h.clock);
    h.manager.start();
    await h.manager.pollOnce();
    await joiner;

    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toContain(ROOM_SECRET);
    expect(serialized).not.toContain("candidate:");
    expect(serialized).not.toContain("192.168.");
    h.manager.stop();
  });
});

describe("LAN auto connect sidebar reports", () => {
  it("reports pairing → connected in order and returns null after stop", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    const joiner = answerOnce(h.transport, room, h.clock);

    h.manager.start();
    expect(h.phases).toEqual([]);
    await h.manager.pollOnce();
    await joiner;

    // The chip must show pairing while the handshake runs and connected once
    // the channel is open; nothing else may appear in between.
    expect(h.phases[0]).toBe("pairing");
    expect(h.phases.at(-1)).toBe("connected");
    expect(h.phases).toEqual(["pairing", "connected"]);

    h.manager.stop();
    expect(h.phases.at(-1)).toBeNull();
    expect(h.manager.getState().hostSessionActive).toBe(false);
  });

  it("returns to connected after a payload finishes transferring", async () => {
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    const joiner = answerOnce(h.transport, room, h.clock);
    h.manager.start();
    await h.manager.pollOnce();
    await joiner;

    // Drive the served-progress callback the manager installs: bytes moved is
    // "transferring", and the last callback settles back to "connected".
    const host = (h.manager as unknown as {
      hostSession: {
        session: {
          serveProgress?: (sent: number, total: number) => void;
        };
      };
    }).hostSession;
    host.session.serveProgress?.(1, 2);
    expect(h.phases.at(-1)).toBe("transferring");
    host.session.serveProgress?.(2, 2);
    expect(h.phases.at(-1)).toBe("connected");
    h.manager.stop();
  });

  it("clears the indicator when a failed acquire never opens a channel", async () => {
    const room = await pairing();
    const h = harness({ mobile: true });
    await seedPairing(h.transport, room);
    h.manager.start();
    // No peer publishes an offer: the bounded window elapses and the manager
    // must not leave the chip parked on "pairing" forever.
    expect(await h.manager.acquire({
      path: "note.bin",
      eTag: "etag-1",
      size: 11,
    })).toBeNull();
    expect(h.phases[0]).toBe("pairing");
    expect(h.phases.at(-1)).toBeNull();
    h.manager.stop();
  });

  it("isolates a throwing sidebar sink from the session itself", async () => {
    const room = await pairing();
    const h = harness({ mobile: true, brokenSink: true });
    await seedPairing(h.transport, room);
    const host = publishOnce(h.transport, room, h.clock);
    h.manager.start();

    const source = await h.manager.acquire({
      path: "note.bin",
      eTag: "etag-1",
      size: 11,
    });
    await host;
    // The display hook threw on every call; the handshake and the channel are
    // unaffected, so a broken sidebar can never break LAN/cloud downloads.
    expect(source).not.toBeNull();
    expect(h.manager.getState().acquirerSessionActive).toBe(true);
    expect(h.phases.length).toBeGreaterThan(0);
    h.manager.stop();
  });
});

describe("LAN auto connect acquirer", () => {
  it("acquires one source and reuses it without a second handshake", async () => {
    const room = await pairing();
    const h = harness({ mobile: true });
    await seedPairing(h.transport, room);
    const host = publishOnce(h.transport, room, h.clock);

    h.manager.start();
    const hint = { path: "note.bin", eTag: "etag-1", size: 11 };
    const first = await h.manager.acquire(hint);
    await host;
    expect(first).not.toBeNull();
    expect(h.manager.getState()).toMatchObject({
      acquirerSessionActive: true,
      lastStep: "acquirer-ready",
    });

    const offerWrites = h.transport.writePaths.filter(
      (path) => path.endsWith("/offer.json"),
    ).length;
    const second = await h.manager.acquire(hint);
    expect(second).toBe(first);
    expect(h.transport.writePaths.filter(
      (path) => path.endsWith("/offer.json"),
    )).toHaveLength(offerWrites);
    expect(h.transport.files.has(LAN_PRESENCE_REQUEST_PATH)).toBe(false);
    expect(h.injected).toHaveLength(1);
    h.manager.stop();
  });

  it("returns null on timeout and deletes only its own request", async () => {
    const room = await pairing();
    const h = harness({ mobile: true });
    await seedPairing(h.transport, room);
    h.manager.start();

    const result = await h.manager.acquire({
      path: "note.bin",
      eTag: "etag-1",
      size: 11,
    });

    expect(result).toBeNull();
    expect(h.injected).toHaveLength(0);
    expect(h.transport.files.has(LAN_PRESENCE_REQUEST_PATH)).toBe(false);
    expect(h.manager.getState().lastStep).toBe("acquire-no-offer");

    // A second file immediately after a failure must not pay the same wait.
    const readsBefore = h.transport.readPaths.length;
    expect(await h.manager.acquire({
      path: "note2.bin",
      eTag: "etag-2",
      size: 12,
    })).toBeNull();
    expect(h.transport.readPaths.length).toBe(readsBefore);
    expect(h.clock.now()).toBeGreaterThan(0);
    expect(LAN_ACQUIRE_FAILURE_COOLDOWN_MS).toBeGreaterThan(0);
    h.manager.stop();
  });

  it("drops the cached source when the channel closes", async () => {
    const room = await pairing();
    const h = harness({ mobile: true });
    await seedPairing(h.transport, room);
    const host = publishOnce(h.transport, room, h.clock);
    h.manager.start();
    const source = await h.manager.acquire({
      path: "note.bin",
      eTag: "etag-1",
      size: 11,
    });
    await host;
    expect(source).not.toBeNull();
    expect(h.manager.getState().acquirerSessionActive).toBe(true);

    // The peer goes away: the manager must forget the cached channel.
    const dc = (h.manager as unknown as {
      acquirerSession: { dc: FakeDataChannel };
    }).acquirerSession.dc;
    dc.close();
    expect(h.manager.getState().acquirerSessionActive).toBe(false);
    expect(h.clears()).toBeGreaterThanOrEqual(1);
    h.manager.stop();
  });

  it("does not acquire while the manager is stopped", async () => {
    const h = harness({ mobile: true });
    expect(await h.manager.acquire({
      path: "note.bin",
      eTag: "etag-1",
      size: 11,
    })).toBeNull();
    expect(h.transport.readPaths).toEqual([]);
  });

  it("prewarms without waiting and never starts a second acquisition", async () => {
    const room = await pairing();
    const h = harness({ mobile: true });
    await seedPairing(h.transport, room);
    const host = publishOnce(h.transport, room, h.clock);

    // The sync entry calls this before planning. It must return immediately,
    // not block on the handshake.
    h.manager.start();
    const startedAt = h.clock.now();
    h.manager.prewarm();
    expect(h.clock.now()).toBe(startedAt);
    // A second call while the first is in flight must not double the work.
    h.manager.prewarm();

    await host;
    // Wait for the background acquisition to land, then the next file finds a
    // ready channel instead of paying for a handshake.
    await vi.waitFor(() => {
      expect(h.manager.getState().acquirerSessionActive).toBe(true);
    });
    const writes = h.transport.writePaths.filter((path) =>
      path === LAN_PRESENCE_REQUEST_PATH);
    expect(writes).toHaveLength(1);
    h.manager.stop();
  });

  it("prewarm is a no-op once a channel is open or the manager stopped", async () => {
    const room = await pairing();
    const h = harness({ mobile: true });
    await seedPairing(h.transport, room);
    const host = publishOnce(h.transport, room, h.clock);
    h.manager.start();
    h.manager.prewarm();
    await host;
    await vi.waitFor(() => {
      expect(h.manager.getState().acquirerSessionActive).toBe(true);
    });
    const before = h.transport.writePaths.length;
    h.manager.prewarm();
    expect(h.transport.writePaths.length).toBe(before);

    h.manager.stop();
    h.manager.prewarm();
    expect(h.transport.writePaths.length).toBe(before);
  });

  it("never prewarms on desktop: that would block the sender role", async () => {
    // 2026-11-20 field failure: a desktop that prewarmed held its single
    // acquisition slot for 20 s, could not answer the phone's request, and the
    // phone fell back to a 79 KB/s cloud download. Desktop must stay a sender.
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    h.manager.start();
    h.manager.prewarm();
    // Give the (forbidden) acquisition a chance to write anything at all.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(h.transport.writePaths).toEqual([]);
    expect(h.manager.getState().acquirerSessionActive).toBe(false);
    h.manager.stop();
  });

  it("never acquires on desktop: a desktop that acquires loses the sender role", async () => {
    // 2026-11-22 review finding. `prewarm()` refused to run on desktop, but the
    // per-download entry `acquire()` had no platform gate: the desktop does
    // register a LAN source provider (`src/main.ts`), so a desktop download
    // above the threshold did start a handshake as the joiner. The signalling
    // carries no device identity, so the same desktop could then read back the
    // active pointer it had just published as a host and answer itself.
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    h.manager.start();

    const acquired = await h.manager.acquire({
      path: "note.bin",
      eTag: "etag-1",
      size: 11,
    });

    expect(acquired).toBeNull();
    // The acquirer half never opened: no presence request, no pointer read.
    expect(h.transport.writePaths).toEqual([]);
    expect(h.manager.getState()).toMatchObject({
      acquirerSessionActive: false,
      lastStep: "acquirer-only",
    });
    h.manager.stop();
  });

  it("keeps the desktop acquirer slot closed while the watcher is serving", async () => {
    // Same platform gate, but with the sender role live: a desktop holding an
    // open host channel must not also start a joiner handshake and overwrite
    // the shared `active.json` with its own offer.
    const room = await pairing();
    const h = harness();
    await seedPairing(h.transport, room);
    await seedPresence(h.transport, room, h.clock);
    const joiner = answerOnce(h.transport, room, h.clock);
    h.manager.start();
    await h.manager.pollOnce();
    await joiner;
    expect(h.manager.getState().hostSessionActive).toBe(true);

    const writesBefore = h.transport.writePaths.length;
    const acquired = await h.manager.acquire({
      path: "note.bin",
      eTag: "etag-1",
      size: 11,
    });

    expect(acquired).toBeNull();
    expect(h.manager.getState().acquirerSessionActive).toBe(false);
    // The open host channel is untouched: no new cloud writes from a joiner.
    expect(h.transport.writePaths.length).toBe(writesBefore);
    h.manager.stop();
  });
});
