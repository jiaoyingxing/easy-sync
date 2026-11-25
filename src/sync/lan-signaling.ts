/**
 * Provider-neutral LAN signaling contract (S2b1, experimental).
 *
 * Route A from the LAN implementation sheet: the existing cloud `.easy-sync`
 * control directory carries a pairing record and short-lived session records.
 * This module owns the wire contract only; it imports no provider client and
 * performs no I/O by itself. A narrow transport interface keeps the same code
 * usable for OneDrive, S3, WebDAV or an in-memory fake.
 *
 * Trust boundary: reading and writing these files requires the same cloud
 * account and vault, so the cloud access-control chain is the room admission
 * control. The room secret additionally HMAC-binds every SDP/candidate record:
 * a foreign SDP written by a same-account but different-vault (or corrupted)
 * writer cannot pass verification. The room secret never leaves the vault
 * files and the caller-owned device-local SecretStorage copy.
 *
 * The signaling files are ephemeral coordination state, not sync authority.
 * A missing, stale, replayed or invalid record always fails closed to the
 * ordinary cloud download path; it never authorizes a file mutation.
 */

import { sha256Hex } from "../crypto";

/** C0 family version for `lan-pairing-v1.json` and `lan-signal/`. */
export const LAN_SIGNALING_FORMAT_VERSION = 1;
/** Wire protocol version carried by pairing and session records. */
export const LAN_SIGNAL_PROTOCOL_VERSION = 1;
/** Exact cloud control path of the pairing record. */
export const LAN_PAIRING_PATH = ".easy-sync/lan-pairing-v1.json";
/** Exact cloud control directory of session signaling. */
export const LAN_SIGNAL_ROOT = ".easy-sync/lan-signal";
/** Exact fixed pointer that advertises the current host session. */
export const LAN_SIGNAL_ACTIVE_PATH = `${LAN_SIGNAL_ROOT}/active.json`;
/** Default session lifetime; bounded by the maximum below. */
export const LAN_SIGNAL_TTL_MS = 120_000;
/** Hard upper bound for any accepted session lifetime. */
export const LAN_SIGNAL_MAX_TTL_MS = 10 * 60_000;
/** Maximum ICE candidates accepted per side. */
export const LAN_SIGNAL_MAX_CANDIDATES = 64;
/** Maximum length of one ICE candidate line. */
export const LAN_SIGNAL_MAX_CANDIDATE_CHARS = 1024;
/** Default polling start interval. */
export const LAN_SIGNAL_POLL_INITIAL_INTERVAL_MS = 1_000;
/** Default polling interval ceiling. */
export const LAN_SIGNAL_POLL_MAX_INTERVAL_MS = 5_000;

const LAN_PAIRING_KIND = "easy-sync-lan-pairing";
const LAN_SIGNAL_KIND = "easy-sync-lan-signal";
const LAN_SIGNAL_ACTIVE_KIND = "easy-sync-lan-signal-active";
const LAN_ROOM_SECRET_HEX_CHARS = 64;
const LAN_CLOCK_SKEW_MS = 5 * 60_000;
const LAN_POLL_MIN_INTERVAL_MS = 250;
const LAN_POLL_DEFAULT_TIMEOUT_MS = 120_000;
const LAN_POLL_DEFAULT_MAX_ATTEMPTS = 240;
const LAN_CLEANUP_DEFAULT_MAX_SESSIONS = 32;

const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_32 = /^[a-f0-9]{32}$/;
const SESSION_ID = /^[a-f0-9]{32}$/;

/** HMAC message domain prefix for protocol version 1. */
export const LAN_SIGNAL_MAC_MESSAGE_CONTEXT =
  "easy-sync-lan-signal-record-v1\n";

const MAC_KEY_CONTEXT = "easy-sync-lan-signal-v1/mac-key";
const OFFER_FILE = "offer.json";
const ANSWER_FILE = "answer.json";
const HOST_CANDIDATES_FILE = "host-candidates.json";
const JOINER_CANDIDATES_FILE = "joiner-candidates.json";
const CLOSED_FILE = "closed.json";

/** One exact control object returned by {@link LanSignalTransport.readText}. */
export interface LanSignalTextObject {
  /** Exact path that was read. */
  path: string;
  /** Provider version token used for compare-and-swap writes. */
  eTag: string;
  /** Full UTF-8 text. */
  text: string;
}

/** Optional write preconditions. */
export interface LanSignalWriteOptions {
  /** Fail when the exact path already exists. */
  createOnly?: boolean;
  /** Fail unless the current object still has this eTag. */
  ifMatch?: string;
}

/** Optional delete preconditions. */
export interface LanSignalDeleteOptions {
  /** Fail unless the current object still has this eTag. */
  ifMatch?: string;
}

/**
 * Narrow provider-neutral transport for `.easy-sync` control objects.
 *
 * `writeText` must create missing parent collections for the exact path.
 * `listPaths` returns object paths below a prefix and is used only by bounded
 * TTL cleanup; session reads and writes never browse directories.
 */
export interface LanSignalTransport {
  /** Read one exact known path; resolves `null` when it does not exist. */
  readText(path: string): Promise<LanSignalTextObject | null>;
  /** Write one exact known path, optionally create-only or eTag-guarded. */
  writeText(
    path: string,
    text: string,
    options?: LanSignalWriteOptions,
  ): Promise<{ path: string; eTag: string }>;
  /** Delete one exact known path; resolves `false` when already absent. */
  delete(path: string, options?: LanSignalDeleteOptions): Promise<boolean>;
  /** List object paths below a prefix (cleanup-only; never used to discover sessions). */
  listPaths(prefix: string): Promise<string[]>;
}

/** Typed precondition failure so callers can distinguish races from transport errors. */
export class LanSignalPreconditionError extends Error {
  constructor() {
    super("LAN signal write precondition failed");
    this.name = "LanSignalPreconditionError";
  }
}

/**
 * Device-local SecretStorage seam.
 *
 * The caller owns the actual SecretStorage read/write/clear implementation;
 * this module only defines the boundary and never stores a secret itself.
 */
export interface LanPairingSecretStore {
  /** Return the locally cached pairing record, or `null` when absent. */
  read(): Promise<LanPairingRecord | null>;
  /** Persist the pairing record in device-local SecretStorage. */
  write(record: LanPairingRecord): Promise<void>;
  /** Remove the local copy (pairing rotation or disable). */
  clear(): Promise<void>;
}

/** Cloud pairing record stored at {@link LAN_PAIRING_PATH}. */
export interface LanPairingRecord {
  schemaVersion: typeof LAN_SIGNALING_FORMAT_VERSION;
  kind: typeof LAN_PAIRING_KIND;
  protocolVersion: typeof LAN_SIGNAL_PROTOCOL_VERSION;
  /** 32 random bytes as 64 lowercase hex characters. */
  roomSecret: string;
  /** Non-secret key identifier derived from the room secret. */
  keyId: string;
  createdAt: number;
}

/** Result of reading the cloud pairing record. */
export type LanPairingReadResult =
  | { status: "ready"; record: LanPairingRecord; eTag: string }
  | { status: "missing" }
  | { status: "invalid" };

/** Result of provisioning the cloud pairing record. */
export type LanPairingProvisionResult =
  | {
    status: "ready";
    source: "existing" | "created" | "create-race";
    record: LanPairingRecord;
    eTag: string;
  }
  | { status: "invalid-existing" }
  | { status: "write-failed" };

/** One host-created signaling session. */
export interface LanSignalSession {
  /** 16 random bytes as 32 lowercase hex characters. */
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

/** Signaling participant role. */
export type LanSignalRole = "host" | "joiner";

/** Terminal state published by either participant. */
export type LanSignalCloseStatus = "completed" | "failed" | "aborted";

/** SDP payload for offers and answers. */
export interface LanSignalSdpPayload {
  /** Normalized SDP (trimmed, one trailing line break). */
  sdp: string;
  /** Lowercase sha-256 DTLS fingerprint without separators. */
  fingerprintSha256: string;
}

/** Cumulative ICE candidate payload for one role. */
export interface LanSignalCandidatesPayload {
  /** Unique trimmed candidate lines, in insertion order. */
  candidates: string[];
}

/** Terminal marker payload. */
export interface LanSignalClosePayload {
  status: LanSignalCloseStatus;
}

/** Payload union carried by a signaling record. */
export type LanSignalPayload =
  | LanSignalSdpPayload
  | LanSignalCandidatesPayload
  | LanSignalClosePayload;

/** Common signed-record fields. */
interface LanSignalRecordBase {
  schemaVersion: typeof LAN_SIGNALING_FORMAT_VERSION;
  kind: typeof LAN_SIGNAL_KIND;
  protocolVersion: typeof LAN_SIGNAL_PROTOCOL_VERSION;
  sessionId: string;
  keyId: string;
  role: LanSignalRole;
  createdAt: number;
  expiresAt: number;
}

/** Signed offer or answer record. */
export interface LanSignalSdpRecord extends LanSignalRecordBase {
  type: "offer" | "answer";
  payload: LanSignalSdpPayload;
  /** HMAC-SHA-256 over {@link canonicalLanSignalBytes}, 64 lowercase hex. */
  mac: string;
}

/** Signed cumulative candidate record. */
export interface LanSignalCandidatesRecord extends LanSignalRecordBase {
  type: "candidates";
  payload: LanSignalCandidatesPayload;
  mac: string;
}

/** Signed terminal marker. */
export interface LanSignalCloseRecord extends LanSignalRecordBase {
  type: "close";
  payload: LanSignalClosePayload;
  mac: string;
}

/** Any accepted signaling record. */
export type LanSignalRecord =
  | LanSignalSdpRecord
  | LanSignalCandidatesRecord
  | LanSignalCloseRecord;

/** Record shape before the MAC is attached. */
type LanSignalUnsignedRecord =
  | Omit<LanSignalSdpRecord, "mac">
  | Omit<LanSignalCandidatesRecord, "mac">
  | Omit<LanSignalCloseRecord, "mac">;

/** Enumerated failure reasons; no secret, IP or candidate text is ever included. */
export type LanSignalRejectionReason =
  | "invalid-pairing"
  | "invalid-record"
  | "invalid-sdp"
  | "invalid-candidates"
  | "invalid-existing"
  | "invalid-session"
  | "invalid-role"
  | "wrong-room"
  | "session-mismatch"
  | "session-inactive"
  | "record-type-mismatch"
  | "expired"
  | "not-yet-valid"
  | "ttl-too-long"
  | "signature-mismatch"
  | "sdp-fingerprint-mismatch";

/** Result of reading one session record while polling. */
export type LanSignalRecordReadResult =
  | { status: "pending" }
  | { status: "ready"; record: LanSignalRecord; eTag: string }
  | { status: "closed"; closeStatus: LanSignalCloseStatus }
  | { status: "rejected"; reason: LanSignalRejectionReason };

/** Result of reading the fixed active-session pointer. */
export type LanSignalActiveReadResult =
  | { status: "none" }
  | { status: "active"; session: LanSignalSession; eTag: string }
  | { status: "expired"; session: LanSignalSession; eTag: string }
  | { status: "rejected"; reason: LanSignalRejectionReason };

/** Result of publishing a host offer. */
export type LanSignalPublishResult =
  | { status: "published"; session: LanSignalSession; eTag: string }
  | { status: "busy"; sessionId: string }
  | { status: "rejected"; reason: LanSignalRejectionReason }
  | { status: "conflict" };

/** Result of writing a joiner answer. */
export type LanSignalAnswerWriteResult =
  | { status: "written"; eTag: string }
  | { status: "already-answered" }
  | { status: "rejected"; reason: LanSignalRejectionReason }
  | { status: "conflict" };

/** Result of writing one role's candidate batch. */
export type LanSignalCandidatesWriteResult =
  | { status: "written"; eTag: string; count: number }
  | { status: "unchanged"; eTag: string; count: number }
  | { status: "conflict" }
  | { status: "rejected"; reason: LanSignalRejectionReason };

/** Result of closing a session. */
export type LanSignalCloseResult =
  | { status: "closed"; eTag: string }
  | { status: "already-closed"; closeStatus: LanSignalCloseStatus }
  | { status: "conflict" }
  | { status: "rejected"; reason: LanSignalRejectionReason };

/** Bounded polling options; callers supply these only while transfer intent exists. */
export interface LanSignalPollOptions {
  /** Overall deadline from the first attempt. */
  timeoutMs?: number;
  /** First wait between empty attempts. */
  initialIntervalMs?: number;
  /** Hard interval ceiling. */
  maxIntervalMs?: number;
  /** Multiplier applied after each empty attempt. */
  backoffMultiplier?: number;
  /** Hard attempt bound, independent of the clock. */
  maxAttempts?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Stop polling when aborted. */
  signal?: AbortSignal;
}

/** Cleanup counters for one bounded TTL sweep. */
export interface LanSignalCleanupResult {
  /** Session ids whose expired files were deleted. */
  removedSessions: string[];
  /** Number of exact control objects actually deleted. */
  removedFiles: number;
  /** Session ids skipped because no verifiable record was found. */
  skippedSessions: number;
}

/** Options for bounded TTL cleanup. */
export interface LanSignalCleanupOptions {
  pairing: LanPairingRecord;
  now?: number;
  /** Upper bound of session directories examined per sweep. */
  maxSessions?: number;
}

/**
 * Create a pairing record with a fresh 32-byte room secret.
 *
 * `keyId` is derived from the secret, so any reader can detect a rotated or
 * mismatched room without learning the secret. The caller is responsible for
 * copying the returned record into device-local SecretStorage.
 */
export async function createLanPairingRecord(
  input: {
    now?: number;
    randomBytes?: (length: number) => Uint8Array;
  } = {},
): Promise<LanPairingRecord> {
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  const roomSecret = toHex(
    readRandomBytes(LAN_ROOM_SECRET_HEX_CHARS / 2, input.randomBytes),
  );
  return {
    schemaVersion: LAN_SIGNALING_FORMAT_VERSION,
    kind: LAN_PAIRING_KIND,
    protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION,
    roomSecret,
    keyId: await deriveLanPairingKeyId(roomSecret),
    createdAt: now,
  };
}

/** Derive the non-secret key id: first 16 bytes of sha256(roomSecret). */
export async function deriveLanPairingKeyId(
  roomSecret: string,
): Promise<string> {
  if (!HEX_64.test(roomSecret)) {
    throw new Error("invalid LAN room secret");
  }
  return (await sha256Hex(toArrayBuffer(hexToBytes(roomSecret)))).slice(0, 32);
}

/** Parse and structurally validate a pairing record. */
export function parseLanPairingRecord(
  text: string,
): LanPairingRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    return isLanPairingRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Serialize a pairing record with a fixed property order and final newline. */
export function serializeLanPairingRecord(record: LanPairingRecord): string {
  if (!isLanPairingRecord(record)) {
    throw new Error("cannot serialize an invalid LAN pairing record");
  }
  return `${JSON.stringify({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    protocolVersion: record.protocolVersion,
    roomSecret: record.roomSecret,
    keyId: record.keyId,
    createdAt: record.createdAt,
  })}\n`;
}

/** Verify that `keyId` really is derived from `roomSecret`. */
export async function verifyLanPairingRecord(
  record: LanPairingRecord,
): Promise<boolean> {
  if (!isLanPairingRecord(record)) return false;
  try {
    return (await deriveLanPairingKeyId(record.roomSecret)) === record.keyId;
  } catch {
    return false;
  }
}

/** Read and fully verify the cloud pairing record. */
export async function readLanPairing(
  transport: LanSignalTransport,
): Promise<LanPairingReadResult> {
  const object = await transport.readText(LAN_PAIRING_PATH);
  if (object === null) return { status: "missing" };
  const record = parseLanPairingRecord(object.text);
  if (record === null || !(await verifyLanPairingRecord(record))) {
    return { status: "invalid" };
  }
  return { status: "ready", record, eTag: object.eTag };
}

/**
 * Create the pairing record if absent, or adopt an existing valid one.
 *
 * An existing invalid record is never overwritten: the family is fail-closed
 * and a future format must arrive through a new C0 version, not a repair.
 */
export async function provisionLanPairing(
  transport: LanSignalTransport,
  input: {
    now?: number;
    randomBytes?: (length: number) => Uint8Array;
  } = {},
): Promise<LanPairingProvisionResult> {
  const observed = await readLanPairing(transport);
  if (observed.status === "ready") {
    return {
      status: "ready",
      source: "existing",
      record: observed.record,
      eTag: observed.eTag,
    };
  }
  if (observed.status === "invalid") {
    return { status: "invalid-existing" };
  }

  let record: LanPairingRecord;
  try {
    record = await createLanPairingRecord(input);
  } catch {
    return { status: "write-failed" };
  }
  const content = serializeLanPairingRecord(record);
  try {
    await transport.writeText(LAN_PAIRING_PATH, content, { createOnly: true });
  } catch (error) {
    if (!(error instanceof LanSignalPreconditionError)) throw error;
    const raced = await readLanPairing(transport);
    if (raced.status === "ready") {
      return {
        status: "ready",
        source: "create-race",
        record: raced.record,
        eTag: raced.eTag,
      };
    }
    return { status: "write-failed" };
  }

  const verified = await transport.readText(LAN_PAIRING_PATH);
  if (verified === null || verified.text !== content) {
    return { status: "write-failed" };
  }
  return {
    status: "ready",
    source: "created",
    record,
    eTag: verified.eTag,
  };
}

/**
 * Create one bounded session descriptor.
 *
 * The caller must publish the offer immediately; an unused descriptor has no
 * cloud effect. A caller-supplied session id exists for retry/idempotency
 * tests and is still validated as exactly 32 lowercase hex characters.
 */
export function createLanSignalSession(
  input: {
    now?: number;
    ttlMs?: number;
    sessionId?: string;
    randomBytes?: (length: number) => Uint8Array;
  } = {},
): LanSignalSession {
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  const ttlMs = input.ttlMs ?? LAN_SIGNAL_TTL_MS;
  if (
    !Number.isFinite(ttlMs)
    || ttlMs <= 0
    || ttlMs > LAN_SIGNAL_MAX_TTL_MS
  ) {
    throw new Error("invalid LAN signal session ttl");
  }
  const sessionId = input.sessionId
    ?? toHex(readRandomBytes(16, input.randomBytes));
  if (!SESSION_ID.test(sessionId)) {
    throw new Error("invalid LAN signal session id");
  }
  return { sessionId, createdAt: now, expiresAt: now + ttlMs };
}

/** Normalize SDP exactly as the transport contract expects. */
export function normalizeLanSignalSdp(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

/**
 * Extract the single sha-256 DTLS fingerprint from SDP.
 *
 * More than one distinct fingerprint is rejected: an SDP that claims two
 * identities cannot be bound to one HMAC payload.
 */
export function extractLanSignalFingerprint(sdp: string): string | null {
  const matches = Array.from(
    sdp.matchAll(/^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)\s*$/gm),
  );
  if (matches.length === 0) return null;
  const normalized = new Set(
    matches.map((match) => match[1].replace(/:/g, "").toLowerCase()),
  );
  if (normalized.size !== 1) return null;
  const fingerprint = Array.from(normalized)[0];
  return HEX_64.test(fingerprint) ? fingerprint : null;
}

/**
 * Canonical MAC input for one unsigned signaling record.
 *
 * Field order and payload shape are frozen for protocol version 1. The MAC
 * message prefix is prepended by {@link signLanSignalRecord}; both sides must
 * use this exact function so a field cannot be moved outside the signature.
 */
export function canonicalLanSignalBytes(
  record: LanSignalUnsignedRecord,
): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    protocolVersion: record.protocolVersion,
    sessionId: record.sessionId,
    keyId: record.keyId,
    role: record.role,
    type: record.type,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    payload: canonicalPayload(record.payload),
  });
}

/**
 * Derive the signaling HMAC key from the room secret.
 *
 * `roomSecret` -> HMAC-SHA-256 key -> fixed context bytes -> derived key.
 * The derivation context is part of the v1 wire contract.
 */
export async function deriveLanSignalMacKey(
  roomSecret: string,
): Promise<CryptoKey> {
  if (!HEX_64.test(roomSecret)) {
    throw new Error("invalid LAN room secret");
  }
  const roomKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(hexToBytes(roomSecret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    roomKey,
    new TextEncoder().encode(MAC_KEY_CONTEXT),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Read the fixed active-session pointer. */
export async function readLanSignalActiveSession(
  transport: LanSignalTransport,
  input: { pairing: LanPairingRecord; now?: number },
): Promise<LanSignalActiveReadResult> {
  const now = input.now ?? Date.now();
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  const object = await transport.readText(LAN_SIGNAL_ACTIVE_PATH);
  if (object === null) return { status: "none" };
  const pointer = parseActivePointer(object.text);
  if (pointer === null) {
    return { status: "rejected", reason: "invalid-record" };
  }
  if (pointer.keyId !== input.pairing.keyId) {
    return { status: "rejected", reason: "wrong-room" };
  }
  const session = pointerToSession(pointer);
  if (pointer.createdAt > now + LAN_CLOCK_SKEW_MS) {
    return { status: "rejected", reason: "not-yet-valid" };
  }
  if (pointer.expiresAt <= now) {
    return { status: "expired", session, eTag: object.eTag };
  }
  const ttlMs = pointer.expiresAt - pointer.createdAt;
  if (ttlMs <= 0 || ttlMs > LAN_SIGNAL_MAX_TTL_MS) {
    return { status: "rejected", reason: "ttl-too-long" };
  }
  return { status: "active", session, eTag: object.eTag };
}

/**
 * Host: publish the offer and the fixed active-session pointer.
 *
 * The pointer is written first so a concurrent joiner can discover the exact
 * session directory without browsing. If the offer write then fails, the
 * pointer is rolled back with its own eTag. A second live session returns
 * `busy`; an expired pointer is replaced with CAS.
 */
export async function publishLanSignalOffer(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    sdp: string;
    session?: LanSignalSession;
    now?: number;
    ttlMs?: number;
    randomBytes?: (length: number) => Uint8Array;
  },
): Promise<LanSignalPublishResult> {
  const now = input.now ?? Date.now();
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  const sdp = normalizeLanSignalSdp(input.sdp);
  const fingerprint = extractLanSignalFingerprint(sdp);
  if (sdp.length === 0 || fingerprint === null) {
    return { status: "rejected", reason: "invalid-sdp" };
  }

  let session: LanSignalSession;
  try {
    session = input.session ?? createLanSignalSession({
      now,
      ttlMs: input.ttlMs,
      randomBytes: input.randomBytes,
    });
  } catch {
    return { status: "rejected", reason: "invalid-session" };
  }
  if (!isLanSignalSession(session)) {
    return { status: "rejected", reason: "invalid-session" };
  }
  if (session.expiresAt <= now) {
    return { status: "rejected", reason: "expired" };
  }
  if (session.createdAt > now + LAN_CLOCK_SKEW_MS) {
    return { status: "rejected", reason: "not-yet-valid" };
  }

  const pointerText = serializeActivePointer(buildActivePointer(
    session,
    input.pairing.keyId,
  ));
  let record: LanSignalRecord;
  try {
    record = await signLanSignalRecord({
      schemaVersion: LAN_SIGNALING_FORMAT_VERSION,
      kind: LAN_SIGNAL_KIND,
      protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      keyId: input.pairing.keyId,
      role: "host",
      type: "offer",
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      payload: { sdp, fingerprintSha256: fingerprint },
    }, input.pairing);
  } catch {
    return { status: "rejected", reason: "invalid-pairing" };
  }

  // Discovery pointer and offer are independent; write them together. The
  // joiner tolerates a pointer that appears before its offer (offer polling).
  const offerPath = signalObjectPath(session.sessionId, "offer", "host");
  const offerText = serializeSignalRecord(record);
  const offerOutcome = transport.writeText(offerPath, offerText, {
    createOnly: true,
  }).then(
    (written) => ({ written, error: null as unknown }),
    (error: unknown) => ({ written: null, error }),
  );
  let pointer: Awaited<ReturnType<typeof commitActivePointer>>;
  try {
    pointer = await commitActivePointer(transport, {
      pairing: input.pairing,
      session,
      pointerText,
      now,
    });
  } catch (error) {
    const outcome = await offerOutcome;
    if (outcome.written) {
      await deleteIfMatching(transport, offerPath, outcome.written.eTag);
    }
    throw error;
  }
  const outcome = await offerOutcome;
  if (pointer.status !== "ready") {
    if (outcome.written) {
      await deleteIfMatching(transport, offerPath, outcome.written.eTag);
    }
    if (
      outcome.error !== null
      && !(outcome.error instanceof LanSignalPreconditionError)
    ) {
      throw outcome.error instanceof Error
        ? outcome.error
        : new Error("LAN signal offer write failed");
    }
    return pointer;
  }
  if (outcome.written) {
    return { status: "published", session, eTag: outcome.written.eTag };
  }
  if (!(outcome.error instanceof LanSignalPreconditionError)) {
    if (pointer.wrote) {
      await deleteIfMatching(transport, LAN_SIGNAL_ACTIVE_PATH, pointer.eTag);
    }
    throw outcome.error instanceof Error
      ? outcome.error
      : new Error("LAN signal offer write failed");
  }
  const existing = await transport.readText(offerPath);
  if (existing !== null && existing.text === offerText) {
    return { status: "published", session, eTag: existing.eTag };
  }
  if (pointer.wrote) {
    await deleteIfMatching(transport, LAN_SIGNAL_ACTIVE_PATH, pointer.eTag);
  }
  return { status: "conflict" };
}

/** Joiner: read and verify the current host offer. */
export async function readLanSignalOffer(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    now?: number;
    /** Session just read from the active pointer; skips a second pointer read. */
    activeSession?: LanSignalSession;
  },
): Promise<LanSignalRecordReadResult> {
  const now = input.now ?? Date.now();
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  if (!isLanSignalSession(input.session)) {
    return { status: "rejected", reason: "invalid-session" };
  }
  if (input.activeSession !== undefined) {
    if (
      input.activeSession.sessionId !== input.session.sessionId
      || !isLanSignalSession(input.activeSession)
    ) {
      return { status: "rejected", reason: "session-inactive" };
    }
  } else {
    const active = await readLanSignalActiveSession(transport, {
      pairing: input.pairing,
      now,
    });
    if (active.status === "rejected") {
      return { status: "rejected", reason: active.reason };
    }
    if (
      active.status === "expired"
      || active.status !== "active"
      || active.session.sessionId !== input.session.sessionId
    ) {
      // The pointer is gone/changed: check the terminal marker only on this
      // slow path, so a normal join still reads one pointer + one offer.
      const closed = await readCloseMarker(transport, {
        pairing: input.pairing,
        session: input.session,
        now,
      });
      if (closed.status === "closed" || closed.status === "rejected") {
        return closed;
      }
      return {
        status: "rejected",
        reason: active.status === "expired" ? "expired" : "session-inactive",
      };
    }
  }
  return readSessionRecord(transport, {
    pairing: input.pairing,
    session: input.session,
    role: "host",
    type: "offer",
    now,
  });
}

/** Joiner: publish the answer exactly once. */
export async function writeLanSignalAnswer(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    sdp: string;
    now?: number;
    /** Session just read from the active pointer; skips a second pointer read. */
    activeSession?: LanSignalSession;
  },
): Promise<LanSignalAnswerWriteResult> {
  const now = input.now ?? Date.now();
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  if (!isLanSignalSession(input.session)) {
    return { status: "rejected", reason: "invalid-session" };
  }
  if (input.session.expiresAt <= now) {
    return { status: "rejected", reason: "expired" };
  }
  const sdp = normalizeLanSignalSdp(input.sdp);
  const fingerprint = extractLanSignalFingerprint(sdp);
  if (sdp.length === 0 || fingerprint === null) {
    return { status: "rejected", reason: "invalid-sdp" };
  }

  if (input.activeSession !== undefined) {
    if (
      !isLanSignalSession(input.activeSession)
      || input.activeSession.sessionId !== input.session.sessionId
    ) {
      return { status: "rejected", reason: "session-inactive" };
    }
  } else {
    const active = await readLanSignalActiveSession(transport, {
      pairing: input.pairing,
      now,
    });
    if (active.status === "none" || active.status === "expired") {
      return { status: "rejected", reason: "session-inactive" };
    }
    if (active.status === "rejected") {
      return { status: "rejected", reason: active.reason };
    }
    if (active.session.sessionId !== input.session.sessionId) {
      return { status: "rejected", reason: "session-inactive" };
    }
  }

  let record: LanSignalRecord;
  try {
    record = await signLanSignalRecord({
      schemaVersion: LAN_SIGNALING_FORMAT_VERSION,
      kind: LAN_SIGNAL_KIND,
      protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION,
      sessionId: input.session.sessionId,
      keyId: input.pairing.keyId,
      role: "joiner",
      type: "answer",
      createdAt: now,
      expiresAt: input.session.expiresAt,
      payload: { sdp, fingerprintSha256: fingerprint },
    }, input.pairing);
  } catch {
    return { status: "rejected", reason: "invalid-pairing" };
  }

  try {
    const written = await transport.writeText(
      signalObjectPath(input.session.sessionId, "answer", "joiner"),
      serializeSignalRecord(record),
      { createOnly: true },
    );
    return { status: "written", eTag: written.eTag };
  } catch (error) {
    if (!(error instanceof LanSignalPreconditionError)) throw error;
    return { status: "already-answered" };
  }
}

/** Host: read and verify the joiner answer. */
export async function readLanSignalAnswer(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    now?: number;
    /** Polling fast path: skip the terminal marker until a later attempt. */
    skipCloseCheck?: boolean;
  },
): Promise<LanSignalRecordReadResult> {
  return readSessionRecord(transport, {
    pairing: input.pairing,
    session: input.session,
    role: "joiner",
    type: "answer",
    now: input.now,
    skipCloseCheck: input.skipCloseCheck,
  });
}

/** Read one role's cumulative candidate batch. */
export async function readLanSignalCandidates(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    role: LanSignalRole;
    now?: number;
  },
): Promise<LanSignalRecordReadResult> {
  if (!isLanSignalRole(input.role)) {
    return { status: "rejected", reason: "invalid-role" };
  }
  return readSessionRecord(transport, {
    pairing: input.pairing,
    session: input.session,
    role: input.role,
    type: "candidates",
    now: input.now,
  });
}

/**
 * Append one role's ICE candidates with read-merge-CAS.
 *
 * A stale eTag returns `conflict`; the caller re-polls and retries with the
 * peer's accepted set. The list is deduplicated and bounded.
 */
export async function writeLanSignalCandidates(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    role: LanSignalRole;
    candidates: string[];
    now?: number;
  },
): Promise<LanSignalCandidatesWriteResult> {
  const now = input.now ?? Date.now();
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  if (!isLanSignalSession(input.session)) {
    return { status: "rejected", reason: "invalid-session" };
  }
  if (!isLanSignalRole(input.role)) {
    return { status: "rejected", reason: "invalid-role" };
  }
  if (input.session.expiresAt <= now) {
    return { status: "rejected", reason: "expired" };
  }
  const incoming = normalizeCandidateList(input.candidates);
  if (incoming === null) {
    return { status: "rejected", reason: "invalid-candidates" };
  }

  const path = signalObjectPath(input.session.sessionId, "candidates", input.role);
  const existing = await transport.readText(path);
  if (existing === null) {
    const record = await signLanSignalRecord({
      schemaVersion: LAN_SIGNALING_FORMAT_VERSION,
      kind: LAN_SIGNAL_KIND,
      protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION,
      sessionId: input.session.sessionId,
      keyId: input.pairing.keyId,
      role: input.role,
      type: "candidates",
      createdAt: now,
      expiresAt: input.session.expiresAt,
      payload: { candidates: incoming },
    }, input.pairing);
    try {
      const written = await transport.writeText(path, serializeSignalRecord(record), {
        createOnly: true,
      });
      return { status: "written", eTag: written.eTag, count: incoming.length };
    } catch (error) {
      if (!(error instanceof LanSignalPreconditionError)) throw error;
      return { status: "conflict" };
    }
  }

  const current = parseSignalRecord(existing.text);
  if (current === null || current.type !== "candidates") {
    return { status: "rejected", reason: "invalid-existing" };
  }
  const verified = await verifyRecordSemantics(current, {
    pairing: input.pairing,
    session: input.session,
    role: input.role,
    type: "candidates",
    now,
  });
  if (verified !== null) {
    return { status: "rejected", reason: verified };
  }
  const merged = normalizeCandidateList([
    ...current.payload.candidates,
    ...incoming,
  ]);
  if (merged === null) {
    return { status: "rejected", reason: "invalid-candidates" };
  }
  if (merged.length === current.payload.candidates.length) {
    return { status: "unchanged", eTag: existing.eTag, count: merged.length };
  }
  const record = await signLanSignalRecord({
    schemaVersion: LAN_SIGNALING_FORMAT_VERSION,
    kind: LAN_SIGNAL_KIND,
    protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION,
    sessionId: input.session.sessionId,
    keyId: input.pairing.keyId,
    role: input.role,
    type: "candidates",
    createdAt: now,
    expiresAt: input.session.expiresAt,
    payload: { candidates: merged },
  }, input.pairing);
  try {
    const written = await transport.writeText(path, serializeSignalRecord(record), {
      ifMatch: existing.eTag,
    });
    return { status: "written", eTag: written.eTag, count: merged.length };
  } catch (error) {
    if (!(error instanceof LanSignalPreconditionError)) throw error;
    return { status: "conflict" };
  }
}

/**
 * Publish a terminal marker, then delete the session's transient records.
 *
 * The marker stays until TTL cleanup so a peer that polls late still learns
 * the outcome instead of mistaking deletion for "not created yet".
 */
export async function closeLanSignalSession(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    role: LanSignalRole;
    status: LanSignalCloseStatus;
    now?: number;
  },
): Promise<LanSignalCloseResult> {
  const now = input.now ?? Date.now();
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  if (!isLanSignalSession(input.session)) {
    return { status: "rejected", reason: "invalid-session" };
  }
  if (!isLanSignalRole(input.role)) {
    return { status: "rejected", reason: "invalid-role" };
  }
  if (!isLanSignalCloseStatus(input.status)) {
    return { status: "rejected", reason: "invalid-record" };
  }
  if (input.session.expiresAt <= now) {
    return { status: "rejected", reason: "expired" };
  }

  const closedPath = signalObjectPath(input.session.sessionId, "close", input.role);
  const existing = await transport.readText(closedPath);
  if (existing !== null) {
    return existingCloseResult(existing, input);
  }

  const record = await signLanSignalRecord({
    schemaVersion: LAN_SIGNALING_FORMAT_VERSION,
    kind: LAN_SIGNAL_KIND,
    protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION,
    sessionId: input.session.sessionId,
    keyId: input.pairing.keyId,
    role: input.role,
    type: "close",
    createdAt: now,
    expiresAt: input.session.expiresAt,
    payload: { status: input.status },
  }, input.pairing);
  let eTag: string;
  try {
    const written = await transport.writeText(
      closedPath,
      serializeSignalRecord(record),
      { createOnly: true },
    );
    eTag = written.eTag;
  } catch (error) {
    if (!(error instanceof LanSignalPreconditionError)) throw error;
    const raced = await transport.readText(closedPath);
    if (raced === null) return { status: "conflict" };
    return existingCloseResult(raced, input);
  }

  for (const path of [
    signalObjectPath(input.session.sessionId, "offer", "host"),
    signalObjectPath(input.session.sessionId, "answer", "joiner"),
    signalObjectPath(input.session.sessionId, "candidates", "host"),
    signalObjectPath(input.session.sessionId, "candidates", "joiner"),
  ]) {
    await bestEffortDelete(transport, path);
  }

  const active = await transport.readText(LAN_SIGNAL_ACTIVE_PATH);
  if (active !== null) {
    const pointer = parseActivePointer(active.text);
    if (
      pointer !== null
      && pointer.sessionId === input.session.sessionId
      && pointer.keyId === input.pairing.keyId
    ) {
      await deleteIfMatching(transport, LAN_SIGNAL_ACTIVE_PATH, active.eTag);
    }
  }
  return { status: "closed", eTag };
}

/**
 * Poll one read until it yields non-null, the deadline expires, or the attempt
 * bound is reached. Interval growth is capped; nothing runs in the background.
 */
export async function pollLanSignal<T>(
  attempt: () => Promise<T | null>,
  options: LanSignalPollOptions = {},
): Promise<T | null> {
  const timeoutMs = clampPositive(
    options.timeoutMs,
    LAN_POLL_DEFAULT_TIMEOUT_MS,
  );
  const initial = clampInterval(
    options.initialIntervalMs ?? LAN_SIGNAL_POLL_INITIAL_INTERVAL_MS,
  );
  const maxInterval = Math.max(
    initial,
    clampInterval(options.maxIntervalMs ?? LAN_SIGNAL_POLL_MAX_INTERVAL_MS),
  );
  const multiplier = clampPositive(options.backoffMultiplier, 1.5);
  const maxAttempts = Math.floor(clampPositive(
    options.maxAttempts,
    LAN_POLL_DEFAULT_MAX_ATTEMPTS,
  ));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  let interval = initial;
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (options.signal?.aborted === true) return null;
    const value = await attempt();
    attempts += 1;
    if (value !== null) return value;
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) return null;
    const wait = Math.max(
      0,
      Math.min(interval, timeoutMs - elapsed, maxInterval),
    );
    if (wait === 0) return null;
    await sleep(wait);
    interval = Math.min(
      maxInterval,
      Math.max(initial, Math.ceil(interval * Math.max(1, multiplier))),
    );
  }
  return null;
}

/**
 * Delete expired signaling objects in one bounded sweep.
 *
 * This is the only consumer of `listPaths`. It examines at most
 * `maxSessions` immediate child directories, accepts only valid session ids,
 * verifies every record's MAC before trusting its expiry, and deletes only
 * the five known file names. Unknown names and nested paths are ignored.
 */
export async function cleanupExpiredLanSignalSessions(
  transport: LanSignalTransport,
  input: LanSignalCleanupOptions,
): Promise<LanSignalCleanupResult> {
  const now = input.now ?? Date.now();
  const maxSessions = Math.floor(clampPositive(
    input.maxSessions,
    LAN_CLEANUP_DEFAULT_MAX_SESSIONS,
  ));
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { removedSessions: [], removedFiles: 0, skippedSessions: 0 };
  }

  const prefix = `${LAN_SIGNAL_ROOT}/`;
  const listed = await transport.listPaths(prefix);
  const sessionIds = new Set<string>();
  for (const path of listed) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    const segment = remainder.split("/")[0];
    if (SESSION_ID.test(segment)) sessionIds.add(segment);
  }

  const removedSessions: string[] = [];
  let removedFiles = 0;
  let skippedSessions = 0;
  for (const sessionId of Array.from(sessionIds).sort().slice(0, maxSessions)) {
    const session: LanSignalSession = {
      sessionId,
      createdAt: 0,
      expiresAt: 0,
    };
    const expiry = await findVerifiedExpiry(transport, input.pairing, session, now);
    if (expiry === null) {
      skippedSessions += 1;
      continue;
    }
    if (expiry > now) continue;
    let deletedForSession = 0;
    for (const path of [
      signalObjectPath(sessionId, "close", "host"),
      signalObjectPath(sessionId, "close", "joiner"),
      signalObjectPath(sessionId, "offer", "host"),
      signalObjectPath(sessionId, "answer", "joiner"),
      signalObjectPath(sessionId, "candidates", "host"),
      signalObjectPath(sessionId, "candidates", "joiner"),
    ]) {
      if (await bestEffortDelete(transport, path)) deletedForSession += 1;
    }
    removedFiles += deletedForSession;
    if (deletedForSession > 0) removedSessions.push(sessionId);
  }

  const active = await transport.readText(LAN_SIGNAL_ACTIVE_PATH);
  if (active !== null) {
    const pointer = parseActivePointer(active.text);
    if (pointer !== null && pointer.expiresAt <= now) {
      if (await deleteIfMatching(transport, LAN_SIGNAL_ACTIVE_PATH, active.eTag)) {
        removedFiles += 1;
      }
    }
  }

  return { removedSessions, removedFiles, skippedSessions };
}

interface LanSignalActivePointer {
  schemaVersion: typeof LAN_SIGNALING_FORMAT_VERSION;
  kind: typeof LAN_SIGNAL_ACTIVE_KIND;
  protocolVersion: typeof LAN_SIGNAL_PROTOCOL_VERSION;
  keyId: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

async function commitActivePointer(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    pointerText: string;
    now: number;
  },
): Promise<
  | { status: "ready"; eTag: string; wrote: boolean }
  | { status: "busy"; sessionId: string }
  | { status: "rejected"; reason: LanSignalRejectionReason }
  | { status: "conflict" }
> {
  const existing = await transport.readText(LAN_SIGNAL_ACTIVE_PATH);
  if (existing === null) {
    try {
      const created = await transport.writeText(
        LAN_SIGNAL_ACTIVE_PATH,
        input.pointerText,
        { createOnly: true },
      );
      return { status: "ready", eTag: created.eTag, wrote: true };
    } catch (error) {
      if (!(error instanceof LanSignalPreconditionError)) throw error;
      return resolveActiveConflict(transport, input);
    }
  }

  const pointer = parseActivePointer(existing.text);
  if (pointer === null) {
    return { status: "rejected", reason: "invalid-record" };
  }
  if (pointer.keyId !== input.pairing.keyId) {
    return { status: "rejected", reason: "wrong-room" };
  }
  if (pointer.sessionId === input.session.sessionId) {
    if (pointer.expiresAt <= input.now) {
      return { status: "rejected", reason: "expired" };
    }
    if (
      pointer.createdAt !== input.session.createdAt
      || pointer.expiresAt !== input.session.expiresAt
    ) {
      return { status: "rejected", reason: "session-mismatch" };
    }
    return { status: "ready", eTag: existing.eTag, wrote: false };
  }
  if (pointer.expiresAt > input.now) {
    return { status: "busy", sessionId: pointer.sessionId };
  }

  try {
    const replaced = await transport.writeText(
      LAN_SIGNAL_ACTIVE_PATH,
      input.pointerText,
      { ifMatch: existing.eTag },
    );
    return { status: "ready", eTag: replaced.eTag, wrote: true };
  } catch (error) {
    if (!(error instanceof LanSignalPreconditionError)) throw error;
    return resolveActiveConflict(transport, input);
  }
}

async function resolveActiveConflict(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    pointerText: string;
    now: number;
  },
): Promise<
  | { status: "ready"; eTag: string; wrote: boolean }
  | { status: "busy"; sessionId: string }
  | { status: "rejected"; reason: LanSignalRejectionReason }
  | { status: "conflict" }
> {
  const observed = await transport.readText(LAN_SIGNAL_ACTIVE_PATH);
  if (observed === null) return { status: "conflict" };
  const pointer = parseActivePointer(observed.text);
  if (pointer === null) {
    return { status: "rejected", reason: "invalid-record" };
  }
  if (pointer.keyId !== input.pairing.keyId) {
    return { status: "rejected", reason: "wrong-room" };
  }
  if (pointer.sessionId === input.session.sessionId) {
    if (pointer.expiresAt <= input.now) {
      return { status: "rejected", reason: "expired" };
    }
    if (pointer.createdAt !== input.session.createdAt
      || pointer.expiresAt !== input.session.expiresAt) {
      return { status: "rejected", reason: "session-mismatch" };
    }
    return { status: "ready", eTag: observed.eTag, wrote: false };
  }
  if (pointer.expiresAt > input.now) {
    return { status: "busy", sessionId: pointer.sessionId };
  }
  return { status: "conflict" };
}

async function readSessionRecord(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    role: LanSignalRole;
    type: "offer" | "answer" | "candidates";
    now?: number;
    skipCloseCheck?: boolean;
  },
): Promise<LanSignalRecordReadResult> {
  const now = input.now ?? Date.now();
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  if (!isLanSignalSession(input.session)) {
    return { status: "rejected", reason: "invalid-session" };
  }

  const path = signalObjectPath(input.session.sessionId, input.type, input.role);
  const object = await transport.readText(path);
  if (object === null) {
    if (input.skipCloseCheck === true) return { status: "pending" };
    const closed = await readCloseMarker(transport, {
      pairing: input.pairing,
      session: input.session,
      now,
    });
    if (closed.status === "closed") return closed;
    if (closed.status === "rejected") return closed;
    return { status: "pending" };
  }
  const record = parseSignalRecord(object.text);
  if (record === null) {
    return { status: "rejected", reason: "invalid-record" };
  }
  const rejection = await verifyRecordSemantics(record, {
    pairing: input.pairing,
    session: input.session,
    role: input.role,
    type: input.type,
    now,
  });
  if (rejection !== null) {
    return { status: "rejected", reason: rejection };
  }
  return { status: "ready", record, eTag: object.eTag };
}

async function readCloseMarker(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    now: number;
  },
): Promise<LanSignalRecordReadResult> {
  const object = await transport.readText(
    signalObjectPath(input.session.sessionId, "close", "host"),
  );
  if (object === null) return { status: "pending" };
  const record = parseSignalRecord(object.text);
  if (record === null || record.type !== "close") {
    return { status: "rejected", reason: "invalid-record" };
  }
  const rejection = await verifyRecordSemantics(record, {
    pairing: input.pairing,
    session: input.session,
    role: record.role,
    type: "close",
    now: input.now,
  });
  if (rejection === "expired") return { status: "pending" };
  if (rejection !== null) {
    return { status: "rejected", reason: rejection };
  }
  return { status: "closed", closeStatus: record.payload.status };
}

async function verifyRecordSemantics(
  record: LanSignalRecord,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    role: LanSignalRole;
    type: LanSignalRecord["type"];
    now: number;
  },
): Promise<LanSignalRejectionReason | null> {
  if (record.sessionId !== input.session.sessionId) {
    return "session-mismatch";
  }
  if (record.keyId !== input.pairing.keyId) {
    return "wrong-room";
  }
  const roleMatches = record.type === "close" || record.role === input.role;
  if (record.type !== input.type || !roleMatches) {
    return "record-type-mismatch";
  }
  const key = await deriveLanSignalMacKey(input.pairing.roomSecret);
  const signedBytes = new TextEncoder().encode(
    `${LAN_SIGNAL_MAC_MESSAGE_CONTEXT}${canonicalLanSignalBytes(stripMac(record))}`,
  );
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      toArrayBuffer(hexToBytes(record.mac)),
      signedBytes,
    );
  } catch {
    valid = false;
  }
  if (!valid) return "signature-mismatch";
  if (record.createdAt > input.now + LAN_CLOCK_SKEW_MS) {
    return "not-yet-valid";
  }
  const ttlMs = record.expiresAt - record.createdAt;
  if (ttlMs <= 0 || ttlMs > LAN_SIGNAL_MAX_TTL_MS) {
    return "ttl-too-long";
  }
  if (record.expiresAt <= input.now) {
    return "expired";
  }
  if (record.type === "offer" || record.type === "answer") {
    if (
      extractLanSignalFingerprint(record.payload.sdp)
      !== record.payload.fingerprintSha256
    ) {
      return "sdp-fingerprint-mismatch";
    }
  }
  return null;
}

async function findVerifiedExpiry(
  transport: LanSignalTransport,
  pairing: LanPairingRecord,
  session: LanSignalSession,
  now: number,
): Promise<number | null> {
  const candidates: Array<{
    role: LanSignalRole;
    type: LanSignalRecord["type"];
  }> = [
    { role: "host", type: "close" },
    { role: "host", type: "offer" },
    { role: "joiner", type: "answer" },
    { role: "host", type: "candidates" },
    { role: "joiner", type: "candidates" },
  ];
  for (const candidate of candidates) {
    const object = await transport.readText(
      signalObjectPath(session.sessionId, candidate.type, candidate.role),
    );
    if (object === null) continue;
    const record = parseSignalRecord(object.text);
    if (record === null) continue;
    const rejection = await verifyRecordSemantics(record, {
      pairing,
      session,
      role: record.type === "close" ? record.role : candidate.role,
      type: candidate.type,
      now,
    });
    if (rejection === "expired") return record.expiresAt;
    if (rejection === null) return record.expiresAt;
  }
  return null;
}

async function existingCloseResult(
  object: LanSignalTextObject,
  input: {
    pairing: LanPairingRecord;
    session: LanSignalSession;
    role: LanSignalRole;
    status: LanSignalCloseStatus;
    now?: number;
  },
): Promise<LanSignalCloseResult> {
  const record = parseSignalRecord(object.text);
  if (record === null || record.type !== "close") {
    return { status: "rejected", reason: "invalid-existing" };
  }
  const now = input.now ?? Date.now();
  const rejection = await verifyRecordSemantics(record, {
    pairing: input.pairing,
    session: input.session,
    role: record.role,
    type: "close",
    now,
  });
  if (rejection !== null && rejection !== "expired") {
    return { status: "rejected", reason: rejection };
  }
  return { status: "already-closed", closeStatus: record.payload.status };
}

async function signLanSignalRecord(
  unsigned: LanSignalUnsignedRecord,
  pairing: LanPairingRecord,
): Promise<LanSignalRecord> {
  const key = await deriveLanSignalMacKey(pairing.roomSecret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `${LAN_SIGNAL_MAC_MESSAGE_CONTEXT}${canonicalLanSignalBytes(unsigned)}`,
    ),
  );
  return { ...unsigned, mac: toHex(new Uint8Array(signature)) };
}

function serializeSignalRecord(record: LanSignalRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function parseSignalRecord(text: string): LanSignalRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    return isLanSignalRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function stripMac(record: LanSignalRecord): LanSignalUnsignedRecord {
  const { mac: _mac, ...unsigned } = record;
  return unsigned;
}

function canonicalPayload(
  payload: LanSignalRecord["payload"],
): Record<string, unknown> {
  if ("sdp" in payload) {
    return {
      sdp: payload.sdp,
      fingerprintSha256: payload.fingerprintSha256,
    };
  }
  if ("candidates" in payload) {
    return { candidates: payload.candidates };
  }
  return { status: payload.status };
}

function buildActivePointer(
  session: LanSignalSession,
  keyId: string,
): LanSignalActivePointer {
  return {
    schemaVersion: LAN_SIGNALING_FORMAT_VERSION,
    kind: LAN_SIGNAL_ACTIVE_KIND,
    protocolVersion: LAN_SIGNAL_PROTOCOL_VERSION,
    keyId,
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function serializeActivePointer(pointer: LanSignalActivePointer): string {
  return `${JSON.stringify(pointer)}\n`;
}

function parseActivePointer(text: string): LanSignalActivePointer | null {
  try {
    const value: unknown = JSON.parse(text);
    return isLanSignalActivePointer(value) ? value : null;
  } catch {
    return null;
  }
}

function pointerToSession(pointer: LanSignalActivePointer): LanSignalSession {
  return {
    sessionId: pointer.sessionId,
    createdAt: pointer.createdAt,
    expiresAt: pointer.expiresAt,
  };
}

function signalObjectPath(
  sessionId: string,
  type: LanSignalRecord["type"],
  role: LanSignalRole,
): string {
  if (!SESSION_ID.test(sessionId)) {
    throw new Error("invalid LAN signal session id");
  }
  const directory = `${LAN_SIGNAL_ROOT}/${sessionId}`;
  if (type === "offer") return `${directory}/${OFFER_FILE}`;
  if (type === "answer") return `${directory}/${ANSWER_FILE}`;
  if (type === "close") return `${directory}/${CLOSED_FILE}`;
  return `${directory}/${role === "host"
    ? HOST_CANDIDATES_FILE
    : JOINER_CANDIDATES_FILE}`;
}

function normalizeCandidateList(values: string[]): string[] | null {
  if (!Array.isArray(values)) return null;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (
      trimmed.length === 0
      || trimmed.length > LAN_SIGNAL_MAX_CANDIDATE_CHARS
      || /[\r\n]/.test(trimmed)
    ) {
      return null;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  if (unique.length === 0 || unique.length > LAN_SIGNAL_MAX_CANDIDATES) {
    return null;
  }
  return unique;
}

function isLanPairingRecord(value: unknown): value is LanPairingRecord {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "protocolVersion",
      "roomSecret",
      "keyId",
      "createdAt",
    ])
    && value.schemaVersion === LAN_SIGNALING_FORMAT_VERSION
    && value.kind === LAN_PAIRING_KIND
    && value.protocolVersion === LAN_SIGNAL_PROTOCOL_VERSION
    && typeof value.roomSecret === "string"
    && HEX_64.test(value.roomSecret)
    && typeof value.keyId === "string"
    && HEX_32.test(value.keyId)
    && isNonNegativeFinite(value.createdAt);
}

function isLanSignalActivePointer(
  value: unknown,
): value is LanSignalActivePointer {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "protocolVersion",
      "keyId",
      "sessionId",
      "createdAt",
      "expiresAt",
    ])
    && value.schemaVersion === LAN_SIGNALING_FORMAT_VERSION
    && value.kind === LAN_SIGNAL_ACTIVE_KIND
    && value.protocolVersion === LAN_SIGNAL_PROTOCOL_VERSION
    && typeof value.keyId === "string"
    && HEX_32.test(value.keyId)
    && typeof value.sessionId === "string"
    && SESSION_ID.test(value.sessionId)
    && isNonNegativeFinite(value.createdAt)
    && isNonNegativeFinite(value.expiresAt);
}

function isLanSignalRecord(value: unknown): value is LanSignalRecord {
  if (!isPlainRecord(value) || typeof value.type !== "string") return false;
  if (!hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "protocolVersion",
    "sessionId",
    "keyId",
    "role",
    "type",
    "createdAt",
    "expiresAt",
    "payload",
    "mac",
  ])) return false;
  if (
    value.schemaVersion !== LAN_SIGNALING_FORMAT_VERSION
    || value.kind !== LAN_SIGNAL_KIND
    || value.protocolVersion !== LAN_SIGNAL_PROTOCOL_VERSION
    || typeof value.sessionId !== "string"
    || !SESSION_ID.test(value.sessionId)
    || typeof value.keyId !== "string"
    || !HEX_32.test(value.keyId)
    || (value.role !== "host" && value.role !== "joiner")
    || !isNonNegativeFinite(value.createdAt)
    || !isNonNegativeFinite(value.expiresAt)
    || typeof value.mac !== "string"
    || !HEX_64.test(value.mac)
    || !isPlainRecord(value.payload)
  ) {
    return false;
  }
  if (value.type === "offer" || value.type === "answer") {
    return hasExactKeys(value.payload, ["sdp", "fingerprintSha256"])
      && typeof value.payload.sdp === "string"
      && value.payload.sdp.length > 0
      && typeof value.payload.fingerprintSha256 === "string"
      && HEX_64.test(value.payload.fingerprintSha256);
  }
  if (value.type === "candidates") {
    if (!hasExactKeys(value.payload, ["candidates"])) return false;
    const candidates = value.payload.candidates;
    return Array.isArray(candidates)
      && candidates.length > 0
      && candidates.length <= LAN_SIGNAL_MAX_CANDIDATES
      && candidates.every((candidate) => typeof candidate === "string"
        && candidate.length > 0
        && candidate.length <= LAN_SIGNAL_MAX_CANDIDATE_CHARS
        && !/[\r\n]/.test(candidate));
  }
  if (value.type === "close") {
    return hasExactKeys(value.payload, ["status"])
      && (value.payload.status === "completed"
        || value.payload.status === "failed"
        || value.payload.status === "aborted");
  }
  return false;
}

function isLanSignalSession(value: unknown): value is LanSignalSession {
  return isPlainRecord(value)
    && typeof value.sessionId === "string"
    && SESSION_ID.test(value.sessionId)
    && isNonNegativeFinite(value.createdAt)
    && isNonNegativeFinite(value.expiresAt)
    && value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= LAN_SIGNAL_MAX_TTL_MS;
}

function isLanSignalRole(value: unknown): value is LanSignalRole {
  return value === "host" || value === "joiner";
}

function isLanSignalCloseStatus(value: unknown): value is LanSignalCloseStatus {
  return value === "completed" || value === "failed" || value === "aborted";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertTimestamp(value: number): void {
  if (!isNonNegativeFinite(value)) {
    throw new Error("invalid LAN signal timestamp");
  }
}

function readRandomBytes(
  length: number,
  source?: (length: number) => Uint8Array,
): Uint8Array {
  const bytes = source === undefined
    ? randomBytes(length)
    : source(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error("unexpected random byte length");
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || /[^0-9a-f]/.test(value)) {
    throw new Error("invalid hex input");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Copy into a plain ArrayBuffer so WebCrypto typings accept the input. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return LAN_SIGNAL_POLL_INITIAL_INTERVAL_MS;
  return Math.max(LAN_POLL_MIN_INTERVAL_MS, Math.floor(value));
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

async function bestEffortDelete(
  transport: LanSignalTransport,
  path: string,
): Promise<boolean> {
  try {
    return await transport.delete(path);
  } catch {
    return false;
  }
}

async function deleteIfMatching(
  transport: LanSignalTransport,
  path: string,
  eTag: string,
): Promise<boolean> {
  try {
    return await transport.delete(path, { ifMatch: eTag });
  } catch (error) {
    if (error instanceof LanSignalPreconditionError) return false;
    throw error;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
