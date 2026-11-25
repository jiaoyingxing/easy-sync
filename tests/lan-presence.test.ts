import { describe, expect, it } from "vitest";
import {
  LAN_SIGNAL_MAX_TTL_MS,
  LAN_SIGNAL_PROTOCOL_VERSION,
  LAN_SIGNALING_FORMAT_VERSION,
  deriveLanPairingKeyId,
  deriveLanSignalMacKey,
  type LanPairingRecord,
  type LanSignalDeleteOptions,
  type LanSignalTextObject,
  type LanSignalTransport,
  type LanSignalWriteOptions,
} from "../src/sync/lan-signaling";
import {
  LAN_PRESENCE_FORMAT_VERSION,
  LAN_PRESENCE_MAC_MESSAGE_CONTEXT,
  LAN_PRESENCE_NONCE_HEX_CHARS,
  LAN_PRESENCE_PROTOCOL_VERSION,
  LAN_PRESENCE_REQUEST_PATH,
  LAN_PRESENCE_REQUEST_TTL_MS,
  canonicalLanPresenceBytes,
  clearLanPresenceRequest,
  createLanPresenceRequest,
  parseLanPresenceRequest,
  readLanPresenceRequest,
  serializeLanPresenceRequest,
  verifyLanPresenceRequest,
  writeLanPresenceRequest,
  type LanPresenceReadResult,
  type LanPresenceRejectionReason,
  type LanPresenceRequest,
  type LanPresenceVerification,
  type LanPresenceWriteResult,
} from "../src/sync/lan-presence";

/**
 * Compile-time inventory of the presence contract, following the signaling
 * test: every public type is named once so surface drift is a compile error.
 */
type LanPresenceContractTypes = [
  LanPresenceReadResult,
  LanPresenceRejectionReason,
  LanPresenceRequest,
  LanPresenceVerification,
  LanPresenceWriteResult,
];

const ROOM_SECRET = "11".repeat(32);
const OTHER_ROOM_SECRET = "22".repeat(32);
const OTHER_NONCE = "cd".repeat(16);

async function pairing(
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

class FakeTransport implements LanSignalTransport {
  entry: { text: string; eTag: string } | null = null;
  readonly writes: Array<{
    path: string;
    options?: LanSignalWriteOptions;
  }> = [];
  readonly deletes: Array<{ path: string; options?: LanSignalDeleteOptions }> = [];
  private sequence = 0;

  async readText(path: string): Promise<LanSignalTextObject | null> {
    if (path !== LAN_PRESENCE_REQUEST_PATH || this.entry === null) return null;
    return { path, eTag: this.entry.eTag, text: this.entry.text };
  }

  async writeText(
    path: string,
    text: string,
    options?: LanSignalWriteOptions,
  ): Promise<{ path: string; eTag: string }> {
    this.writes.push({ path, options });
    if (path !== LAN_PRESENCE_REQUEST_PATH) throw new Error("wrong path");
    const eTag = `etag-${++this.sequence}`;
    this.entry = { text, eTag };
    return { path, eTag };
  }

  async delete(
    path: string,
    options?: LanSignalDeleteOptions,
  ): Promise<boolean> {
    this.deletes.push({ path, options });
    if (this.entry === null) return false;
    if (options?.ifMatch !== undefined && options.ifMatch !== this.entry.eTag) {
      return false;
    }
    this.entry = null;
    return true;
  }

  async listPaths(): Promise<string[]> {
    return [];
  }
}

async function resign(
  record: LanPresenceRequest,
  roomSecret: string,
): Promise<LanPresenceRequest> {
  const { mac: _mac, ...unsigned } = record;
  const key = await deriveLanSignalMacKey(roomSecret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `${LAN_PRESENCE_MAC_MESSAGE_CONTEXT}${canonicalLanPresenceBytes(unsigned)}`,
    ),
  );
  const bytes = new Uint8Array(signature);
  let mac = "";
  for (const byte of bytes) mac += byte.toString(16).padStart(2, "0");
  return { ...unsigned, mac };
}

describe("LAN presence request", () => {
  it("keeps the declared TTL and nonce bounds", () => {
    expect(LAN_PRESENCE_REQUEST_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(LAN_PRESENCE_REQUEST_TTL_MS).toBeLessThanOrEqual(120_000);
    expect(LAN_PRESENCE_NONCE_HEX_CHARS).toBe(32);
    const inventory: LanPresenceContractTypes = [
      {} as LanPresenceReadResult,
      "wrong-room" as LanPresenceRejectionReason,
      {} as LanPresenceRequest,
      {} as LanPresenceVerification,
      {} as LanPresenceWriteResult,
    ];
    expect(inventory).toHaveLength(5);
  });

  it("round-trips the strict schema and ignores unrelated shapes", async () => {
    const record = await createLanPresenceRequest({
      pairing: await pairing(),
      now: 10_000,
      ttlMs: 60_000,
    });
    expect(record).not.toBeNull();
    if (!record) return;

    const text = serializeLanPresenceRequest(record);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseLanPresenceRequest(text)).toEqual(record);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "schemaVersion",
      "kind",
      "protocolVersion",
      "keyId",
      "createdAt",
      "expiresAt",
      "nonce",
      "mac",
    ]);
    expect(record.schemaVersion).toBe(LAN_PRESENCE_FORMAT_VERSION);
    expect(record.protocolVersion).toBe(LAN_PRESENCE_PROTOCOL_VERSION);

    expect(parseLanPresenceRequest("not json")).toBeNull();
    expect(parseLanPresenceRequest("{}")).toBeNull();
    expect(parseLanPresenceRequest(JSON.stringify({
      ...record,
      extra: true,
    }))).toBeNull();
    expect(parseLanPresenceRequest(JSON.stringify({
      ...record,
      nonce: "short",
    }))).toBeNull();
  });

  it("rejects a tampered HMAC", async () => {
    const room = await pairing();
    const record = await createLanPresenceRequest({
      pairing: room,
      now: 10_000,
    });
    expect(record).not.toBeNull();
    if (!record) return;

    const flipped = `${record.mac.slice(0, -1)}${record.mac.endsWith("0")
      ? "1"
      : "0"}`;
    const tampered = { ...record, mac: flipped };
    expect(await verifyLanPresenceRequest(tampered, {
      pairing: room,
      now: 10_000,
    })).toEqual({ status: "rejected", reason: "signature-mismatch" });

    // A field change also breaks the signature.
    expect(await verifyLanPresenceRequest({
      ...record,
      createdAt: record.createdAt + 1,
    }, { pairing: room, now: 10_000 })).toEqual({
      status: "rejected",
      reason: "signature-mismatch",
    });
  });

  it("rejects expired and future-dated requests", async () => {
    const room = await pairing();
    const record = await createLanPresenceRequest({
      pairing: room,
      now: 10_000,
      ttlMs: 60_000,
    });
    expect(record).not.toBeNull();
    if (!record) return;

    expect(await verifyLanPresenceRequest(record, {
      pairing: room,
      now: record.expiresAt,
    })).toEqual({ status: "rejected", reason: "expired" });

    expect(await verifyLanPresenceRequest(record, {
      pairing: room,
      now: record.createdAt - 10 * 60_000,
    })).toEqual({ status: "rejected", reason: "not-yet-valid" });
  });

  it("rejects a request signed by another room even with a valid MAC", async () => {
    const other = await pairing(OTHER_ROOM_SECRET);
    const record = await createLanPresenceRequest({
      pairing: other,
      now: 10_000,
    });
    expect(record).not.toBeNull();
    if (!record) return;

    expect(await verifyLanPresenceRequest(record, {
      pairing: await pairing(),
      now: 10_000,
    })).toEqual({ status: "rejected", reason: "wrong-room" });

    // Key id swap alone cannot pass: the signature is bound to the same keyId.
    const forged = { ...record, keyId: (await pairing()).keyId };
    expect(await verifyLanPresenceRequest(forged, {
      pairing: await pairing(),
      now: 10_000,
    })).toEqual({ status: "rejected", reason: "signature-mismatch" });
  });

  it("refuses a TTL beyond the shared upper bound", async () => {
    const room = await pairing();
    expect(await createLanPresenceRequest({
      pairing: room,
      now: 10_000,
      ttlMs: LAN_SIGNAL_MAX_TTL_MS + 1,
    })).toBeNull();

    const record = await createLanPresenceRequest({ pairing: room, now: 10_000 });
    expect(record).not.toBeNull();
    if (!record) return;
    expect(await verifyLanPresenceRequest({
      ...record,
      expiresAt: record.createdAt + LAN_SIGNAL_MAX_TTL_MS + 1,
    }, { pairing: room, now: 10_000 })).toEqual({
      status: "rejected",
      reason: "ttl-too-long",
    });
  });

  it("writes the exact fixed path and reads back only a verified record", async () => {
    const transport = new FakeTransport();
    const room = await pairing();
    const written = await writeLanPresenceRequest(transport, {
      pairing: room,
      now: 10_000,
    });
    expect(written.status).toBe("written");
    expect(transport.writes[0]).toEqual({
      path: LAN_PRESENCE_REQUEST_PATH,
      options: { createOnly: true },
    });

    const read = await readLanPresenceRequest(transport, {
      pairing: room,
      now: 10_000,
    });
    expect(read.status).toBe("ready");

    // Another room's watcher must not accept this request.
    expect(await readLanPresenceRequest(transport, {
      pairing: await pairing(OTHER_ROOM_SECRET),
      now: 10_000,
    })).toMatchObject({ status: "rejected", reason: "wrong-room" });
  });

  it("replaces an existing request with a CAS write", async () => {
    const transport = new FakeTransport();
    const room = await pairing();
    await writeLanPresenceRequest(transport, { pairing: room, now: 10_000 });
    const second = await writeLanPresenceRequest(transport, {
      pairing: room,
      now: 10_001,
      nonce: OTHER_NONCE,
    });
    expect(second.status).toBe("written");
    expect(transport.writes[1].options).toEqual({ ifMatch: "etag-1" });
  });

  it("deletes only this caller's request via the eTag guard", async () => {
    const transport = new FakeTransport();
    const room = await pairing();
    const written = await writeLanPresenceRequest(transport, {
      pairing: room,
      now: 10_000,
    });
    expect(written.status).toBe("written");
    if (written.status !== "written") return;

    // A newer writer replaces the object; the old eTag must not delete it.
    await writeLanPresenceRequest(transport, { pairing: room, now: 10_001 });
    expect(await clearLanPresenceRequest(transport, {
      eTag: written.eTag,
    })).toBe(false);
    expect(transport.entry).not.toBeNull();

    const current = transport.entry!.eTag;
    expect(await clearLanPresenceRequest(transport, { eTag: current })).toBe(true);
    expect(transport.entry).toBeNull();
  });

  it("surfaces a failed verification instead of the record", async () => {
    const transport = new FakeTransport();
    const room = await pairing();
    const record = await createLanPresenceRequest({ pairing: room, now: 10_000 });
    expect(record).not.toBeNull();
    if (!record) return;
    await transport.writeText(
      LAN_PRESENCE_REQUEST_PATH,
      serializeLanPresenceRequest(await resign(record, OTHER_ROOM_SECRET)),
      { createOnly: true },
    );

    expect(await readLanPresenceRequest(transport, {
      pairing: room,
      now: 10_000,
    })).toMatchObject({ status: "rejected", reason: "signature-mismatch" });
  });
});
