/**
 * LAN presence request (S5a, experimental).
 *
 * The desktop watcher and the acquiring device need one tiny coordination
 * record before a session exists: "someone in this room wants to download".
 * It lives at one fixed cloud path and carries no secret, no IP and no file
 * name. The room secret HMAC-binds it, so a same-account writer from another
 * vault (or a corrupted/replayed copy) cannot make a watcher publish an offer.
 *
 * The record is ephemeral coordination state, never sync authority. Every
 * malformed, replayed, expired, future-dated or wrong-room record is rejected
 * and simply means "fall back to the ordinary cloud download". TTL cleanup
 * deletes only this exact file.
 */

import {
  LAN_SIGNAL_MAX_TTL_MS,
  deriveLanSignalMacKey,
  verifyLanPairingRecord,
  type LanPairingRecord,
  type LanSignalTransport,
  type LanSignalTextObject,
} from "./lan-signaling";

/** C0 family version for the presence request. */
export const LAN_PRESENCE_FORMAT_VERSION = 1;
/** Wire protocol version carried by the presence request. */
export const LAN_PRESENCE_PROTOCOL_VERSION = 1;
/** Exact cloud control path of the presence request (no directory browsing). */
export const LAN_PRESENCE_REQUEST_PATH = ".easy-sync/lan-presence/request.json";
/** Default request lifetime; bounded by `LAN_SIGNAL_MAX_TTL_MS`. */
export const LAN_PRESENCE_REQUEST_TTL_MS = 90_000;
/** Request nonce length: 16 random bytes as 32 lowercase hex characters. */
export const LAN_PRESENCE_NONCE_HEX_CHARS = 32;

const LAN_PRESENCE_KIND = "easy-sync-lan-presence-request";
/** Distinct HMAC domain so a presence request cannot be replayed as a signal record. */
export const LAN_PRESENCE_MAC_MESSAGE_CONTEXT =
  "easy-sync-lan-presence-request-v1\n";
const LAN_CLOCK_SKEW_MS = 5 * 60_000;
const HEX_32 = /^[a-f0-9]{32}$/;
const HEX_64 = /^[a-f0-9]{64}$/;

/** One signed "wants to download" request. */
export interface LanPresenceRequest {
  schemaVersion: typeof LAN_PRESENCE_FORMAT_VERSION;
  kind: typeof LAN_PRESENCE_KIND;
  protocolVersion: typeof LAN_PRESENCE_PROTOCOL_VERSION;
  /** Non-secret room identifier derived from the room secret. */
  keyId: string;
  createdAt: number;
  expiresAt: number;
  /** 16 random bytes as 32 lowercase hex characters (replay discriminator). */
  nonce: string;
  /** HMAC-SHA-256 over {@link canonicalLanPresenceBytes}, 64 lowercase hex. */
  mac: string;
}

/** Enumerated rejection reasons; never carries a secret or request body. */
export type LanPresenceRejectionReason =
  | "invalid-pairing"
  | "invalid-record"
  | "wrong-room"
  | "expired"
  | "not-yet-valid"
  | "ttl-too-long"
  | "signature-mismatch";

/** Result of verifying one parsed request. */
export type LanPresenceVerification =
  | { status: "valid" }
  | { status: "rejected"; reason: LanPresenceRejectionReason };

/** Result of reading the fixed request path. */
export type LanPresenceReadResult =
  | { status: "none" }
  | { status: "ready"; record: LanPresenceRequest; eTag: string }
  | {
    status: "rejected";
    reason: LanPresenceRejectionReason;
    /** Present when the object exists; lets a watcher clear an expired file. */
    eTag?: string;
  };

/** Result of a create-or-replace request write. */
export type LanPresenceWriteResult =
  | { status: "written"; record: LanPresenceRequest; eTag: string }
  | { status: "rejected"; reason: LanPresenceRejectionReason }
  | { status: "conflict" };

/** Canonical signed field order; frozen for protocol version 1. */
export function canonicalLanPresenceBytes(
  record: Omit<LanPresenceRequest, "mac">,
): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    protocolVersion: record.protocolVersion,
    keyId: record.keyId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    nonce: record.nonce,
  });
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

function isLanPresenceRequest(value: unknown): value is LanPresenceRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "protocolVersion",
      "keyId",
      "createdAt",
      "expiresAt",
      "nonce",
      "mac",
    ])
    && value.schemaVersion === LAN_PRESENCE_FORMAT_VERSION
    && value.kind === LAN_PRESENCE_KIND
    && value.protocolVersion === LAN_PRESENCE_PROTOCOL_VERSION
    && typeof value.keyId === "string"
    && HEX_32.test(value.keyId)
    && isNonNegativeFinite(value.createdAt)
    && isNonNegativeFinite(value.expiresAt)
    && typeof value.nonce === "string"
    && HEX_32.test(value.nonce)
    && typeof value.mac === "string"
    && HEX_64.test(value.mac);
}

/** Parse and structurally validate one request (no signature check). */
export function parseLanPresenceRequest(
  text: string,
): LanPresenceRequest | null {
  try {
    const value: unknown = JSON.parse(text);
    return isLanPresenceRequest(value) ? value : null;
  } catch {
    return null;
  }
}

/** Serialize with a fixed property order and a final newline. */
export function serializeLanPresenceRequest(record: LanPresenceRequest): string {
  if (!isLanPresenceRequest(record)) {
    throw new Error("cannot serialize an invalid LAN presence request");
  }
  return `${JSON.stringify({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    protocolVersion: record.protocolVersion,
    keyId: record.keyId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    nonce: record.nonce,
    mac: record.mac,
  })}\n`;
}

async function signPresence(
  unsigned: Omit<LanPresenceRequest, "mac">,
  pairing: LanPairingRecord,
): Promise<LanPresenceRequest> {
  const key = await deriveLanSignalMacKey(pairing.roomSecret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `${LAN_PRESENCE_MAC_MESSAGE_CONTEXT}${canonicalLanPresenceBytes(unsigned)}`,
    ),
  );
  const bytes = new Uint8Array(signature);
  let mac = "";
  for (let index = 0; index < bytes.length; index += 1) {
    mac += bytes[index].toString(16).padStart(2, "0");
  }
  return { ...unsigned, mac };
}

/**
 * Create a signed request for this room.
 *
 * `now`, `ttlMs`, `nonce` and `randomBytes` are injectable for deterministic
 * tests; production callers omit them. A TTL outside `(0, LAN_SIGNAL_MAX_TTL_MS]`
 * is refused instead of being clamped.
 */
export async function createLanPresenceRequest(input: {
  pairing: LanPairingRecord;
  now?: number;
  ttlMs?: number;
  nonce?: string;
  randomBytes?: (length: number) => Uint8Array;
}): Promise<LanPresenceRequest | null> {
  if (!(await verifyLanPairingRecord(input.pairing))) return null;
  const now = input.now ?? Date.now();
  if (!isNonNegativeFinite(now)) return null;
  const ttlMs = input.ttlMs ?? LAN_PRESENCE_REQUEST_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > LAN_SIGNAL_MAX_TTL_MS) {
    return null;
  }
  const nonce = input.nonce ?? readNonce(input.randomBytes);
  if (!HEX_32.test(nonce)) return null;
  return signPresence({
    schemaVersion: LAN_PRESENCE_FORMAT_VERSION,
    kind: LAN_PRESENCE_KIND,
    protocolVersion: LAN_PRESENCE_PROTOCOL_VERSION,
    keyId: input.pairing.keyId,
    createdAt: now,
    expiresAt: now + ttlMs,
    nonce,
  }, input.pairing);
}

/**
 * Fully verify one parsed request: room, signature, clock and lifetime.
 *
 * The order is fixed so a foreign record is rejected before any timing claim
 * is trusted. A future `createdAt` beyond the skew window is `not-yet-valid`.
 */
export async function verifyLanPresenceRequest(
  record: LanPresenceRequest,
  input: { pairing: LanPairingRecord; now?: number },
): Promise<LanPresenceVerification> {
  if (!isLanPresenceRequest(record)) {
    return { status: "rejected", reason: "invalid-record" };
  }
  if (!(await verifyLanPairingRecord(input.pairing))) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  if (record.keyId !== input.pairing.keyId) {
    return { status: "rejected", reason: "wrong-room" };
  }
  const ttlMs = record.expiresAt - record.createdAt;
  if (ttlMs <= 0 || ttlMs > LAN_SIGNAL_MAX_TTL_MS) {
    return { status: "rejected", reason: "ttl-too-long" };
  }
  const now = input.now ?? Date.now();
  if (record.createdAt > now + LAN_CLOCK_SKEW_MS) {
    return { status: "rejected", reason: "not-yet-valid" };
  }
  if (record.expiresAt <= now) {
    return { status: "rejected", reason: "expired" };
  }
  const { mac: actualMac, ...unsigned } = record;
  const expected = await signPresence(unsigned, input.pairing);
  if (expected.mac !== actualMac) {
    return { status: "rejected", reason: "signature-mismatch" };
  }
  return { status: "valid" };
}

/**
 * True when a rejection means the room identity no longer matches.
 *
 * The watcher uses this to drop its cached pairing once, so the next tick
 * re-reads the cloud copy instead of trusting a rotated/foreign room forever.
 */
export function isLanPresenceRoomRejection(
  reason: LanPresenceRejectionReason,
): boolean {
  return reason === "wrong-room" || reason === "invalid-record";
}

/**
 * True when a watcher should delete the exact file it just rejected.
 *
 * Only the owning watcher does this, and only for records that can never
 * become valid again (expired / future-dated / stale TTL). A wrong-room or
 * unsigned record is left in place: deleting it would let any same-account
 * writer erase another room's coordination state.
 */
export function isLanPresenceCleanupRejection(
  reason: LanPresenceRejectionReason,
): boolean {
  return reason === "expired"
    || reason === "not-yet-valid"
    || reason === "ttl-too-long";
}

/** Read and fully verify the fixed presence request path. */
export async function readLanPresenceRequest(
  transport: LanSignalTransport,
  input: { pairing: LanPairingRecord; now?: number },
): Promise<LanPresenceReadResult> {
  const object = await transport.readText(LAN_PRESENCE_REQUEST_PATH);
  if (object === null) return { status: "none" };
  const record = parseLanPresenceRequest(object.text);
  if (record === null) {
    return { status: "rejected", reason: "invalid-record", eTag: object.eTag };
  }
  const verified = await verifyLanPresenceRequest(record, input);
  if (verified.status === "rejected") {
    return { ...verified, eTag: object.eTag };
  }
  return { status: "ready", record, eTag: object.eTag };
}

/** 16 random bytes as 32 lowercase hex characters, for one request. */
export function generateLanPresenceNonce(
  randomBytes?: (length: number) => Uint8Array,
): string {
  return readNonce(randomBytes);
}

/**
 * Create the request, or replace an existing one with a CAS write.
 *
 * Only one request is meaningful at a time; a later writer wins. A stale eTag
 * returns `conflict` and the caller simply treats it as a failed acquire.
 */
export async function writeLanPresenceRequest(
  transport: LanSignalTransport,
  input: {
    pairing: LanPairingRecord;
    now?: number;
    ttlMs?: number;
    nonce?: string;
    randomBytes?: (length: number) => Uint8Array;
  },
): Promise<LanPresenceWriteResult> {
  const record = await createLanPresenceRequest(input);
  if (record === null) {
    return { status: "rejected", reason: "invalid-pairing" };
  }
  const text = serializeLanPresenceRequest(record);
  let existing: LanSignalTextObject | null;
  try {
    existing = await transport.readText(LAN_PRESENCE_REQUEST_PATH);
  } catch {
    return { status: "conflict" };
  }
  try {
    const written = existing === null
      ? await transport.writeText(LAN_PRESENCE_REQUEST_PATH, text, {
        createOnly: true,
      })
      : await transport.writeText(LAN_PRESENCE_REQUEST_PATH, text, {
        ifMatch: existing.eTag,
      });
    return { status: "written", record, eTag: written.eTag };
  } catch {
    return { status: "conflict" };
  }
}

/**
 * Delete this caller's own request only.
 *
 * The eTag is mandatory: without it a slow writer could delete a newer request
 * that another device wrote after this one started. Missing/raced records are
 * reported as `false`, never repaired.
 */
export async function clearLanPresenceRequest(
  transport: LanSignalTransport,
  input: { eTag: string },
): Promise<boolean> {
  try {
    return await transport.delete(LAN_PRESENCE_REQUEST_PATH, {
      ifMatch: input.eTag,
    });
  } catch {
    return false;
  }
}

/**
 * Bounded replay discriminator for one watcher.
 *
 * A repeated nonce means the same request was already handled (poll overlap or
 * a replayed cloud object); it must not start a second session. Only the nonce
 * is kept, never the record body, and the set is bounded by insertion order.
 */
export class LanPresenceNonceCache {
  private readonly seen = new Set<string>();

  constructor(private readonly capacity = 64) {}

  /** True when this nonce was already recorded. */
  has(nonce: string): boolean {
    return this.seen.has(nonce);
  }

  /** True when this nonce is new; false for a replay. */
  remember(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    while (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}

function readNonce(
  source?: (length: number) => Uint8Array,
): string {
  const bytes = source === undefined
    ? crypto.getRandomValues(new Uint8Array(LAN_PRESENCE_NONCE_HEX_CHARS / 2))
    : source(LAN_PRESENCE_NONCE_HEX_CHARS / 2);
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes[index].toString(16).padStart(2, "0");
  }
  return hex;
}
