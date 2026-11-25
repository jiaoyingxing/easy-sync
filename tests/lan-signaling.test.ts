import { describe, expect, it, vi } from "vitest";
import {
  LAN_PAIRING_PATH,
  LAN_SIGNAL_ACTIVE_PATH,
  LAN_SIGNAL_MAC_MESSAGE_CONTEXT,
  LAN_SIGNAL_MAX_CANDIDATE_CHARS,
  LAN_SIGNAL_MAX_CANDIDATES,
  LAN_SIGNAL_MAX_TTL_MS,
  LAN_SIGNAL_POLL_INITIAL_INTERVAL_MS,
  LAN_SIGNAL_POLL_MAX_INTERVAL_MS,
  LAN_SIGNAL_PROTOCOL_VERSION,
  LAN_SIGNAL_ROOT,
  LAN_SIGNAL_TTL_MS,
  LAN_SIGNALING_FORMAT_VERSION,
  LanSignalPreconditionError,
  canonicalLanSignalBytes,
  cleanupExpiredLanSignalSessions,
  closeLanSignalSession,
  createLanPairingRecord,
  createLanSignalSession,
  deriveLanPairingKeyId,
  deriveLanSignalMacKey,
  extractLanSignalFingerprint,
  normalizeLanSignalSdp,
  parseLanPairingRecord,
  pollLanSignal,
  provisionLanPairing,
  publishLanSignalOffer,
  readLanSignalActiveSession,
  readLanSignalAnswer,
  readLanSignalCandidates,
  readLanPairing,
  readLanSignalOffer,
  serializeLanPairingRecord,
  verifyLanPairingRecord,
  writeLanSignalAnswer,
  writeLanSignalCandidates,
  type LanPairingProvisionResult,
  type LanPairingReadResult,
  type LanPairingRecord,
  type LanPairingSecretStore,
  type LanSignalActiveReadResult,
  type LanSignalAnswerWriteResult,
  type LanSignalCandidatesPayload,
  type LanSignalCandidatesRecord,
  type LanSignalCandidatesWriteResult,
  type LanSignalCleanupOptions,
  type LanSignalCleanupResult,
  type LanSignalClosePayload,
  type LanSignalCloseRecord,
  type LanSignalCloseResult,
  type LanSignalCloseStatus,
  type LanSignalDeleteOptions,
  type LanSignalPayload,
  type LanSignalPollOptions,
  type LanSignalPublishResult,
  type LanSignalRecord,
  type LanSignalRecordReadResult,
  type LanSignalRejectionReason,
  type LanSignalRole,
  type LanSignalSdpPayload,
  type LanSignalSdpRecord,
  type LanSignalSession,
  type LanSignalTextObject,
  type LanSignalTransport,
  type LanSignalWriteOptions,
} from "../src/sync/lan-signaling";

/**
 * Compile-time inventory of the public signaling contract. Keeping every type
 * in one alias makes accidental surface drift visible and satisfies the
 * repository export gate with a named reference.
 */
type LanSignalingContractTypes = [
  LanPairingProvisionResult,
  LanPairingReadResult,
  LanPairingRecord,
  LanPairingSecretStore,
  LanSignalActiveReadResult,
  LanSignalAnswerWriteResult,
  LanSignalCandidatesPayload,
  LanSignalCandidatesRecord,
  LanSignalCandidatesWriteResult,
  LanSignalCleanupOptions,
  LanSignalCleanupResult,
  LanSignalClosePayload,
  LanSignalCloseRecord,
  LanSignalCloseResult,
  LanSignalCloseStatus,
  LanSignalDeleteOptions,
  LanSignalPayload,
  LanSignalPollOptions,
  LanSignalPublishResult,
  LanSignalRecord,
  LanSignalRecordReadResult,
  LanSignalRejectionReason,
  LanSignalRole,
  LanSignalSdpPayload,
  LanSignalSdpRecord,
  LanSignalSession,
  LanSignalTextObject,
  LanSignalTransport,
  LanSignalWriteOptions,
];

const ROOM_SECRET = "11".repeat(32);
const OTHER_ROOM_SECRET = "22".repeat(32);
const HOST_FINGERPRINT = "ab".repeat(32);
const JOINER_FINGERPRINT = "cd".repeat(32);
const HOST_SDP = sdpWithFingerprint(HOST_FINGERPRINT);
const JOINER_SDP = sdpWithFingerprint(JOINER_FINGERPRINT);
const HOST_CANDIDATE = "candidate:1 1 UDP 2122260223 192.168.1.10 50000 typ host";
const JOINER_CANDIDATE = "candidate:2 1 UDP 2122260223 192.168.1.11 50001 typ host";

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

async function fixedPairing(
  roomSecret = ROOM_SECRET,
  createdAt = 1_000,
): Promise<LanPairingRecord> {
  return {
    schemaVersion: LAN_SIGNALING_FORMAT_VERSION,
    kind: "easy-sync-lan-pairing",
    protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION,
    roomSecret,
    keyId: await deriveLanPairingKeyId(roomSecret),
    createdAt,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class FakeLanSignalTransport implements LanSignalTransport {
  readonly files = new Map<string, { text: string; eTag: string }>();
  readonly readPaths: string[] = [];
  readonly writePaths: string[] = [];
  readonly deletePaths: string[] = [];
  readonly listPrefixes: string[] = [];
  readonly operations: string[] = [];
  failWrites: Array<{ path: string; options?: LanSignalWriteOptions }> = [];
  failDeletes: string[] = [];
  private sequence = 0;

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
    this.operations.push(`write:${path}`);
    const rejected = this.failWrites.find((entry) => entry.path === path
      && (entry.options?.createOnly === undefined
        || entry.options.createOnly === options?.createOnly)
      && (entry.options?.ifMatch === undefined
        || entry.options.ifMatch === options?.ifMatch));
    if (rejected !== undefined) throw new LanSignalPreconditionError();
    const existing = this.files.get(path);
    if (options?.createOnly === true && existing !== undefined) {
      throw new LanSignalPreconditionError();
    }
    if (options?.ifMatch !== undefined && existing?.eTag !== options.ifMatch) {
      throw new LanSignalPreconditionError();
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
    this.operations.push(`delete:${path}`);
    if (this.failDeletes.includes(path)) throw new Error("delete failed");
    const existing = this.files.get(path);
    if (existing === undefined) return false;
    if (options?.ifMatch !== undefined && existing.eTag !== options.ifMatch) {
      throw new LanSignalPreconditionError();
    }
    this.files.delete(path);
    return true;
  }

  async listPaths(prefix: string): Promise<string[]> {
    this.listPrefixes.push(prefix);
    return Array.from(this.files.keys()).filter((path) => path.startsWith(prefix));
  }

  putRaw(path: string, text: string): string {
    const eTag = `raw-${++this.sequence}`;
    this.files.set(path, { text, eTag });
    return eTag;
  }

  text(path: string): string | null {
    return this.files.get(path)?.text ?? null;
  }

  paths(): string[] {
    return Array.from(this.files.keys()).sort();
  }
}

function offerPath(session: LanSignalSession): string {
  return `${LAN_SIGNAL_ROOT}/${session.sessionId}/offer.json`;
}

function answerPath(session: LanSignalSession): string {
  return `${LAN_SIGNAL_ROOT}/${session.sessionId}/answer.json`;
}

function candidatesPath(session: LanSignalSession, role: LanSignalRole): string {
  return `${LAN_SIGNAL_ROOT}/${session.sessionId}/${role}-candidates.json`;
}

function closedPath(session: LanSignalSession): string {
  return `${LAN_SIGNAL_ROOT}/${session.sessionId}/closed.json`;
}

async function reSignRecord(
  record: LanSignalRecord,
  roomSecret: string,
): Promise<LanSignalRecord> {
  const { mac: _mac, ...unsigned } = record;
  const key = await deriveLanSignalMacKey(roomSecret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `${LAN_SIGNAL_MAC_MESSAGE_CONTEXT}${canonicalLanSignalBytes(unsigned)}`,
    ),
  );
  return { ...unsigned, mac: bytesToHex(new Uint8Array(signature)) };
}

async function publishedOffer(
  transport: FakeLanSignalTransport,
  input: {
    pairing?: LanPairingRecord;
    now?: number;
    sdp?: string;
  } = {},
): Promise<{ pairing: LanPairingRecord; session: LanSignalSession }> {
  const pairing = input.pairing ?? await fixedPairing();
  const result = await publishLanSignalOffer(transport, {
    pairing,
    sdp: input.sdp ?? HOST_SDP,
    now: input.now ?? 1_000,
  });
  if (result.status !== "published") {
    throw new Error(`expected published offer, got ${result.status}`);
  }
  return { pairing, session: result.session };
}

describe("LAN pairing contract", () => {
  it("creates a fresh 32-byte secret, derives keyId, and round-trips strictly", async () => {
    const first = await createLanPairingRecord({
      now: 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const second = await createLanPairingRecord({
      now: 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(8),
    });

    expect(first.roomSecret).toHaveLength(64);
    expect(first.roomSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(first.keyId).toBe(await deriveLanPairingKeyId(first.roomSecret));
    expect(first.roomSecret).not.toBe(second.roomSecret);
    expect(first.keyId).not.toBe(second.keyId);
    expect(await verifyLanPairingRecord(first)).toBe(true);

    const serialized = serializeLanPairingRecord(first);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(parseLanPairingRecord(serialized)).toEqual(first);
    expect(parseLanPairingRecord(JSON.stringify({
      ...first,
      protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION + 1,
    }))).toBeNull();
    expect(parseLanPairingRecord(JSON.stringify({
      ...first,
      roomSecret: "short",
    }))).toBeNull();
    expect(parseLanPairingRecord(JSON.stringify({
      ...first,
      extra: true,
    }))).toBeNull();
    expect(await verifyLanPairingRecord({
      ...first,
      keyId: "00".repeat(16),
    })).toBe(false);
  });

  it("provisions create-only, adopts existing, and never repairs an invalid record", async () => {
    const transport = new FakeLanSignalTransport();
    expect(await readLanPairing(transport)).toEqual({ status: "missing" });

    const created = await provisionLanPairing(transport, { now: 1_000 });
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;
    expect(created.source).toBe("created");
    expect(transport.paths()).toEqual([LAN_PAIRING_PATH]);

    const existing = await provisionLanPairing(transport);
    expect(existing.status).toBe("ready");
    if (existing.status !== "ready") return;
    expect(existing.source).toBe("existing");
    expect(existing.eTag).toBe(created.eTag);
    expect(existing.record.roomSecret).toBe(created.record.roomSecret);

    const read = await readLanPairing(transport);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.record).toEqual(created.record);

    const corrupt = new FakeLanSignalTransport();
    corrupt.putRaw(LAN_PAIRING_PATH, "{not-json");
    expect(await provisionLanPairing(corrupt)).toEqual({
      status: "invalid-existing",
    });
    expect(corrupt.text(LAN_PAIRING_PATH)).toBe("{not-json");
  });

  it("defines the device-local SecretStorage seam without owning it", async () => {
    const pairing = await fixedPairing();
    let stored: LanPairingRecord | null = null;
    const store: LanPairingSecretStore = {
      read: async () => stored,
      write: async (record) => {
        stored = record;
      },
      clear: async () => {
        stored = null;
      },
    };

    await store.write(pairing);
    expect(await store.read()).toEqual(pairing);
    await store.clear();
    expect(await store.read()).toBeNull();
  });
});

describe("LAN signaling contract", () => {
  it("publishes an offer, advertises the session, and verifies MAC bytes", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const published = await publishLanSignalOffer(transport, {
      pairing,
      sdp: HOST_SDP,
      now: 1_000,
    });
    expect(published.status).toBe("published");
    if (published.status !== "published") return;
    const { session } = published;

    expect(session.expiresAt).toBe(1_000 + LAN_SIGNAL_TTL_MS);
    expect(transport.paths()).toEqual([
      LAN_SIGNAL_ACTIVE_PATH,
      offerPath(session),
    ].sort());

    const active = await readLanSignalActiveSession(transport, {
      pairing,
      now: 1_000,
    });
    expect(active.status).toBe("active");
    if (active.status !== "active") return;
    expect(active.session).toEqual(session);

    const offer = await readLanSignalOffer(transport, {
      pairing,
      session,
      now: 1_000,
    });
    expect(offer.status).toBe("ready");
    if (offer.status !== "ready") return;
    expect(offer.record.type).toBe("offer");
    expect(offer.record.role).toBe("host");
    if (offer.record.type !== "offer") return;
    expect(offer.record.payload.fingerprintSha256).toBe(HOST_FINGERPRINT);
    expect(offer.record.payload.sdp).toBe(normalizeLanSignalSdp(HOST_SDP));

    const { mac: _mac, ...unsigned } = offer.record;
    const canonical = canonicalLanSignalBytes(unsigned);
    expect(canonical).toContain(`"sessionId":"${session.sessionId}"`);
    expect(canonical).toContain(`"fingerprintSha256":"${HOST_FINGERPRINT}"`);
    expect(canonical).not.toContain("\"mac\"");
    expect(offer.record.mac).toMatch(/^[a-f0-9]{64}$/);
  });

  it("normalizes SDP and rejects ambiguous DTLS fingerprints", () => {
    expect(normalizeLanSignalSdp("  v=0\r\n\r\n")).toBe("v=0\n");
    expect(extractLanSignalFingerprint(HOST_SDP)).toBe(HOST_FINGERPRINT);
    expect(extractLanSignalFingerprint("v=0\r\n")).toBeNull();
    expect(extractLanSignalFingerprint(
      `${HOST_SDP}a=fingerprint:sha-256 ${"ef".repeat(32)}\r\n`,
    )).toBeNull();
  });

  it("rejects a wrong room secret before exposing SDP", async () => {
    const transport = new FakeLanSignalTransport();
    const hostPairing = await fixedPairing();
    const otherPairing = await fixedPairing(OTHER_ROOM_SECRET);
    const { session } = await publishedOffer(transport, {
      pairing: hostPairing,
    });

    const active = await readLanSignalActiveSession(transport, {
      pairing: otherPairing,
      now: 1_000,
    });
    expect(active).toEqual({ status: "rejected", reason: "wrong-room" });

    const offer = await readLanSignalOffer(transport, {
      pairing: otherPairing,
      session,
      now: 1_000,
    });
    expect(offer).toEqual({ status: "rejected", reason: "wrong-room" });
    expect(JSON.stringify(offer)).not.toContain(HOST_FINGERPRINT);
    expect(JSON.stringify(offer)).not.toContain(ROOM_SECRET);
  });

  it("reads an early offer from the cached active session and accepts later candidate batches", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const { session } = await publishedOffer(transport, { pairing });
    transport.readPaths.length = 0;

    const offer = await readLanSignalOffer(transport, {
      pairing,
      session,
      now: 1_000,
      activeSession: session,
    });
    expect(offer.status).toBe("ready");
    expect(transport.readPaths).not.toContain(LAN_SIGNAL_ACTIVE_PATH);

    expect(await readLanSignalOffer(transport, {
      pairing,
      session,
      now: 1_000,
      activeSession: { ...session, sessionId: "b".repeat(32) },
    })).toEqual({ status: "rejected", reason: "session-inactive" });

    // The early offer carries no candidates yet; later batches are additive.
    const first = await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: [HOST_CANDIDATE],
      now: 1_001,
    });
    expect(first).toMatchObject({ status: "written", count: 1 });
    const second = await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: [HOST_CANDIDATE, `${HOST_CANDIDATE} typ srflx`],
      now: 1_002,
    });
    expect(second).toMatchObject({ status: "written", count: 2 });
    const candidates = await readLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      now: 1_003,
    });
    expect(candidates.status).toBe("ready");
    if (candidates.status !== "ready" || candidates.record.type !== "candidates") return;
    expect(candidates.record.payload.candidates).toHaveLength(2);
  });

  it("supports answer and candidate reads in parallel", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const { session } = await publishedOffer(transport, { pairing });

    const [pendingAnswer, pendingCandidates] = await Promise.all([
      readLanSignalAnswer(transport, { pairing, session, now: 1_000 }),
      readLanSignalCandidates(transport, {
        pairing,
        session,
        role: "joiner",
        now: 1_000,
      }),
    ]);
    expect(pendingAnswer).toEqual({ status: "pending" });
    expect(pendingCandidates).toEqual({ status: "pending" });

    await writeLanSignalAnswer(transport, {
      pairing,
      session,
      sdp: JOINER_SDP,
      now: 1_001,
    });
    await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "joiner",
      candidates: [JOINER_CANDIDATE],
      now: 1_002,
    });
    const [answer, candidates] = await Promise.all([
      readLanSignalAnswer(transport, { pairing, session, now: 1_003 }),
      readLanSignalCandidates(transport, {
        pairing,
        session,
        role: "joiner",
        now: 1_003,
      }),
    ]);
    expect(answer.status).toBe("ready");
    expect(candidates.status).toBe("ready");
  });

  it("rejects a tampered MAC, a swapped session, and an expired session", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const { session } = await publishedOffer(transport, { pairing });

    const original = JSON.parse(transport.text(offerPath(session)) ?? "{}") as LanSignalRecord;
    if (original.type !== "offer") throw new Error("expected an offer fixture");
    transport.putRaw(offerPath(session), `${JSON.stringify({
      ...original,
      payload: {
        ...original.payload,
        sdp: original.payload.sdp.replace("m=application", "m=application "),
      },
    })}\n`);
    expect(await readLanSignalOffer(transport, {
      pairing,
      session,
      now: 1_000,
    })).toEqual({ status: "rejected", reason: "signature-mismatch" });

    const mismatch = await reSignRecord({
      ...original,
      payload: {
        ...original.payload,
        fingerprintSha256: JOINER_FINGERPRINT,
      },
    }, ROOM_SECRET);
    transport.putRaw(offerPath(session), `${JSON.stringify(mismatch)}\n`);
    expect(await readLanSignalOffer(transport, {
      pairing,
      session,
      now: 1_000,
    })).toEqual({ status: "rejected", reason: "sdp-fingerprint-mismatch" });

    expect(await readLanSignalOffer(transport, {
      pairing,
      session,
      now: session.expiresAt,
    })).toEqual({ status: "rejected", reason: "expired" });

    const otherTransport = new FakeLanSignalTransport();
    const otherOffer = await publishedOffer(otherTransport, { pairing });
    otherTransport.putRaw(
      offerPath(otherOffer.session),
      transport.text(offerPath(session)) ?? "",
    );
    expect(await readLanSignalOffer(otherTransport, {
      pairing,
      session: otherOffer.session,
      now: 1_000,
    })).toEqual({ status: "rejected", reason: "session-mismatch" });
  });

  it("completes offer, answer, candidate exchange, and terminal close", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const { session } = await publishedOffer(transport, { pairing });

    expect(await readLanSignalAnswer(transport, {
      pairing,
      session,
      now: 1_000,
    })).toEqual({ status: "pending" });

    const answer = await writeLanSignalAnswer(transport, {
      pairing,
      session,
      sdp: JOINER_SDP,
      now: 1_001,
    });
    expect(answer.status).toBe("written");
    expect(await writeLanSignalAnswer(transport, {
      pairing,
      session,
      sdp: JOINER_SDP,
      now: 1_002,
    })).toEqual({ status: "already-answered" });

    const hostAnswer = await readLanSignalAnswer(transport, {
      pairing,
      session,
      now: 1_003,
    });
    expect(hostAnswer.status).toBe("ready");
    if (hostAnswer.status !== "ready") return;
    expect(hostAnswer.record.type).toBe("answer");
    expect(hostAnswer.record.role).toBe("joiner");
    if (hostAnswer.record.type !== "answer") return;
    expect(hostAnswer.record.payload.fingerprintSha256).toBe(JOINER_FINGERPRINT);

    const hostCandidates = await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: [HOST_CANDIDATE],
      now: 1_004,
    });
    expect(hostCandidates).toMatchObject({
      status: "written",
      count: 1,
    });
    const hostMore = await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: [HOST_CANDIDATE, `${HOST_CANDIDATE} typ srflx`],
      now: 1_005,
    });
    expect(hostMore).toMatchObject({ status: "written", count: 2 });
    const hostRead = await readLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      now: 1_006,
    });
    expect(hostRead.status).toBe("ready");
    if (hostRead.status !== "ready" || hostRead.record.type !== "candidates") return;
    expect(hostRead.record.payload.candidates).toEqual([
      HOST_CANDIDATE,
      `${HOST_CANDIDATE} typ srflx`,
    ]);

    const joinerCandidates = await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "joiner",
      candidates: [JOINER_CANDIDATE],
      now: 1_007,
    });
    expect(joinerCandidates).toMatchObject({ status: "written", count: 1 });
    expect(transport.paths()).toEqual(expect.arrayContaining([
      LAN_SIGNAL_ACTIVE_PATH,
      offerPath(session),
      answerPath(session),
      candidatesPath(session, "host"),
      candidatesPath(session, "joiner"),
    ]));

    const closed = await closeLanSignalSession(transport, {
      pairing,
      session,
      role: "host",
      status: "completed",
      now: 1_008,
    });
    expect(closed.status).toBe("closed");
    expect(transport.files.has(closedPath(session))).toBe(true);
    expect(transport.files.has(offerPath(session))).toBe(false);
    expect(transport.files.has(answerPath(session))).toBe(false);
    expect(transport.files.has(candidatesPath(session, "host"))).toBe(false);
    expect(transport.files.has(candidatesPath(session, "joiner"))).toBe(false);
    expect(transport.files.has(LAN_SIGNAL_ACTIVE_PATH)).toBe(false);

    expect(await readLanSignalOffer(transport, {
      pairing,
      session,
      now: 1_009,
    })).toEqual({ status: "closed", closeStatus: "completed" });
    expect(await closeLanSignalSession(transport, {
      pairing,
      session,
      role: "joiner",
      status: "failed",
      now: 1_010,
    })).toEqual({ status: "already-closed", closeStatus: "completed" });
  });

  it("returns a terminal marker to a peer that polls after cleanup", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const { session } = await publishedOffer(transport, { pairing });

    await closeLanSignalSession(transport, {
      pairing,
      session,
      role: "joiner",
      status: "aborted",
      now: 1_001,
    });
    expect(await readLanSignalAnswer(transport, {
      pairing,
      session,
      now: 1_002,
    })).toEqual({ status: "closed", closeStatus: "aborted" });
  });
});

describe("LAN signaling safety boundaries", () => {
  it("keeps candidate updates bounded and reports CAS conflicts", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const { session } = await publishedOffer(transport, { pairing });

    const tooMany = Array.from(
      { length: LAN_SIGNAL_MAX_CANDIDATES + 1 },
      (_value, index) => `candidate:${index} 1 UDP 1 192.168.1.1 5000 typ host`,
    );
    expect(await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: tooMany,
      now: 1_001,
    })).toEqual({ status: "rejected", reason: "invalid-candidates" });

    expect(await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: ["x".repeat(LAN_SIGNAL_MAX_CANDIDATE_CHARS + 1)],
      now: 1_001,
    })).toEqual({ status: "rejected", reason: "invalid-candidates" });

    const first = await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: [HOST_CANDIDATE],
      now: 1_002,
    });
    expect(first.status).toBe("written");

    transport.failWrites.push({
      path: candidatesPath(session, "host"),
      options: { ifMatch: transport.files.get(candidatesPath(session, "host"))?.eTag },
    });
    expect(await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: [`${HOST_CANDIDATE} typ srflx`],
      now: 1_003,
    })).toEqual({ status: "conflict" });
  });

  it("rolls back a newly created active pointer when the offer write fails", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const session = createLanSignalSession({
      now: 1_000,
      sessionId: "a".repeat(32),
    });
    transport.failWrites.push({
      path: offerPath(session),
      options: { createOnly: true },
    });

    expect(await publishLanSignalOffer(transport, {
      pairing,
      session,
      sdp: HOST_SDP,
      now: 1_000,
    })).toEqual({ status: "conflict" });
    expect(transport.files.has(LAN_SIGNAL_ACTIVE_PATH)).toBe(false);
    expect(transport.files.has(offerPath(session))).toBe(false);
  });

  it("reports a busy session instead of overwriting a live pointer", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const first = await publishedOffer(transport, { pairing, now: 1_000 });

    expect(await publishLanSignalOffer(transport, {
      pairing,
      sdp: JOINER_SDP,
      now: 1_001,
    })).toEqual({ status: "busy", sessionId: first.session.sessionId });
    expect(transport.readPaths).not.toContain(
      `${LAN_SIGNAL_ROOT}/../escape/offer.json`,
    );
  });

  it("rejects unknown roles and terminal statuses at runtime", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const session: LanSignalSession = {
      sessionId: "c".repeat(32),
      createdAt: 1_000,
      expiresAt: 2_000,
    };
    expect(await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "admin" as unknown as LanSignalRole,
      candidates: [HOST_CANDIDATE],
      now: 1_000,
    })).toEqual({ status: "rejected", reason: "invalid-role" });
    expect(await readLanSignalCandidates(transport, {
      pairing,
      session,
      role: "admin" as unknown as LanSignalRole,
      now: 1_000,
    })).toEqual({ status: "rejected", reason: "invalid-role" });
    expect(await closeLanSignalSession(transport, {
      pairing,
      session,
      role: "host",
      status: "done" as unknown as LanSignalCloseStatus,
      now: 1_000,
    })).toEqual({ status: "rejected", reason: "invalid-record" });
    expect(transport.readPaths).toEqual([]);
    expect(transport.writePaths).toEqual([]);
  });

  it("rejects path traversal inputs without touching an outside path", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();

    expect(await publishLanSignalOffer(transport, {
      pairing,
      sdp: HOST_SDP,
      session: {
        sessionId: "../escape",
        createdAt: 1_000,
        expiresAt: 2_000,
      },
      now: 1_000,
    })).toEqual({ status: "rejected", reason: "invalid-session" });

    const malicious = {
      sessionId: "..\\escape",
      createdAt: 1_000,
      expiresAt: 2_000,
    };
    expect(await writeLanSignalAnswer(transport, {
      pairing,
      session: malicious,
      sdp: JOINER_SDP,
      now: 1_000,
    })).toEqual({ status: "rejected", reason: "invalid-session" });
    expect(await readLanSignalOffer(transport, {
      pairing,
      session: malicious,
      now: 1_000,
    })).toMatchObject({ status: "rejected" });
    expect(transport.writePaths).toEqual([]);
    expect(transport.readPaths.every(
      (path) => path === LAN_SIGNAL_ACTIVE_PATH,
    )).toBe(true);
    expect(() => createLanSignalSession({
      now: 1_000,
      sessionId: "A".repeat(32),
    })).toThrow("invalid LAN signal session id");
  });

  it("cleans up only verified expired sessions and exact known files", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const expired = await publishedOffer(transport, { pairing, now: 1_000 });
    const live = await publishedOffer(transport, {
      pairing,
      now: expired.session.expiresAt,
    });
    expect(live.session.sessionId).not.toBe(expired.session.sessionId);

    transport.putRaw(
      `${LAN_SIGNAL_ROOT}/${"z".repeat(32)}/unknown.txt`,
      "keep me",
    );
    transport.putRaw(`${LAN_SIGNAL_ROOT}/not-a-session/offer.json`, "{}");
    transport.putRaw(`${LAN_SIGNAL_ROOT}/../escape/offer.json`, "{}");
    transport.putRaw(
      `${LAN_SIGNAL_ROOT}/${expired.session.sessionId}/notes.txt`,
      "keep me too",
    );

    const cleanup = await cleanupExpiredLanSignalSessions(transport, {
      pairing,
      now: expired.session.expiresAt,
    });
    expect(cleanup.removedSessions).toEqual([expired.session.sessionId]);
    expect(cleanup.removedFiles).toBeGreaterThan(0);
    expect(transport.listPrefixes).toEqual([`${LAN_SIGNAL_ROOT}/`]);
    expect(transport.files.has(offerPath(expired.session))).toBe(false);
    expect(transport.files.has(LAN_SIGNAL_ACTIVE_PATH)).toBe(true);
    expect(transport.text(
      `${LAN_SIGNAL_ROOT}/${expired.session.sessionId}/notes.txt`,
    )).toBe("keep me too");
    expect(transport.files.has(
      `${LAN_SIGNAL_ROOT}/${"z".repeat(32)}/unknown.txt`,
    )).toBe(true);
    expect(transport.files.has(
      `${LAN_SIGNAL_ROOT}/not-a-session/offer.json`,
    )).toBe(true);
    expect(transport.files.has(
      `${LAN_SIGNAL_ROOT}/../escape/offer.json`,
    )).toBe(true);

    const finalCleanup = await cleanupExpiredLanSignalSessions(transport, {
      pairing,
      now: live.session.expiresAt,
      maxSessions: 2,
    });
    expect(finalCleanup.removedSessions).toEqual([live.session.sessionId]);
    expect(transport.files.has(LAN_SIGNAL_ACTIVE_PATH)).toBe(false);
  });

  it("skips sessions whose records cannot be verified", async () => {
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const { session } = await publishedOffer(transport, { pairing, now: 1_000 });

    const record = JSON.parse(transport.text(offerPath(session)) ?? "{}") as LanSignalRecord;
    if (record.type !== "offer") throw new Error("expected an offer fixture");
    const tampered = await reSignRecord({
      ...record,
      payload: { ...record.payload, fingerprintSha256: JOINER_FINGERPRINT },
    }, OTHER_ROOM_SECRET);
    transport.putRaw(offerPath(session), `${JSON.stringify(tampered)}\n`);

    const cleanup = await cleanupExpiredLanSignalSessions(transport, {
      pairing,
      now: session.expiresAt,
    });
    expect(cleanup.skippedSessions).toBe(1);
    expect(cleanup.removedSessions).toEqual([]);
    expect(transport.files.has(offerPath(session))).toBe(true);
  });
});

describe("LAN signaling polling", () => {
  it("backs off with a bounded interval and stops at the deadline", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const result = await pollLanSignal(async () => null, {
      timeoutMs: 5_000,
      initialIntervalMs: 1_000,
      maxIntervalMs: 2_000,
      backoffMultiplier: 2,
      maxAttempts: 20,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(result).toBeNull();
    expect(sleeps).toEqual([1_000, 2_000, 2_000]);
  });

  it("returns the first non-null result without a background loop", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await pollLanSignal(async () => {
      attempts += 1;
      return attempts === 3 ? "ready" : null;
    }, {
      timeoutMs: 10_000,
      initialIntervalMs: LAN_SIGNAL_POLL_INITIAL_INTERVAL_MS,
      maxIntervalMs: LAN_SIGNAL_POLL_MAX_INTERVAL_MS,
      now: () => attempts * 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toBe("ready");
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("honors abort and a hard attempt bound with a frozen clock", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    expect(await pollLanSignal(async () => {
      attempts += 1;
      return null;
    }, {
      signal: controller.signal,
      now: () => 0,
      sleep: async () => undefined,
    })).toBeNull();
    expect(attempts).toBe(0);

    attempts = 0;
    expect(await pollLanSignal(async () => {
      attempts += 1;
      return null;
    }, {
      maxAttempts: 3,
      timeoutMs: 10_000,
      now: () => 0,
      sleep: async () => undefined,
    })).toBeNull();
    expect(attempts).toBe(3);
  });
});

describe("LAN signaling diagnostics", () => {
  it("never logs a room secret, an IP, or candidate text", async () => {
    const consoleSpies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "debug"),
    ];
    const transport = new FakeLanSignalTransport();
    const pairing = await fixedPairing();
    const { session } = await publishedOffer(transport, { pairing });
    const results: unknown[] = [];

    results.push(await writeLanSignalCandidates(transport, {
      pairing,
      session,
      role: "host",
      candidates: [HOST_CANDIDATE],
      now: 1_001,
    }));
    results.push(await readLanSignalOffer(transport, {
      pairing: await fixedPairing(OTHER_ROOM_SECRET),
      session,
      now: 1_002,
    }));
    results.push(await closeLanSignalSession(transport, {
      pairing,
      session,
      role: "host",
      status: "failed",
      now: 1_003,
    }));

    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(ROOM_SECRET);
    expect(serialized).not.toContain("192.168.1.10");
    expect(serialized).not.toContain("candidate:");
    expect(serialized).not.toContain("a=fingerprint");
  });
});
