/**
 * Dev-only LAN peer session for S2a (manual SDP, desktop↔desktop).
 *
 * The receiver asks for `{path, eTag, size}`. The sender's handler checks its
 * V2 base entry (local sha256 ↔ cloud eTag) and returns the bytes plus that
 * attested sha256. The receiver verifies the downloaded bytes against it; the
 * existing post-download eTag re-read confirms the cloud version. This module
 * is dynamically imported by the hidden `lan-session-dev` command and is not
 * product code.
 */
import { sha256Hex } from "../crypto";
import { StreamingSha256 } from "../onedrive/client";
import type {
  LanContentHint,
  LanContentResult,
  LanContentSource,
} from "../sync/lan-content-source";
import {
  normalizeLanRouteType,
  type LanRouteType,
} from "../sync/lan-diagnostics";

const LAN_SESSION_PROTOCOL = "easy-sync-lan-session-v1";
const TRANSPORT_CHUNK_BYTES = 256 * 1024;
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;

/** One appendBinary partition on the mobile receiver. */
export const LAN_PARTITION_BYTES = 1024 * 1024;

export interface LanPartitionSink {
  /** Create/overwrite the temporary file with the first partition. */
  write(bytes: ArrayBuffer): Promise<void>;
  /** Append one later partition. */
  append(bytes: ArrayBuffer): Promise<void>;
}

export interface LanPathResult {
  size: number;
  hash: string;
}

export interface LanServeRequest {
  path: string;
  eTag: string;
  size: number;
}

export interface LanServeResult {
  bytes: ArrayBuffer;
  sha256: string;
}

type LanServeHandler = (
  request: LanServeRequest,
) => Promise<LanServeResult | { error: string }>;

interface RequestFrame extends LanServeRequest {
  type: "request";
  protocol: string;
}

interface MetaFrame extends LanServeRequest {
  type: "meta";
  protocol: string;
  sha256: string;
}

interface DoneFrame {
  type: "done";
  size: number;
  sha256: string;
}

interface ResultFrame {
  type: "result";
  ok: boolean;
  size?: number;
  sha256?: string;
  error?: string;
}

/**
 * Application-level heartbeat.
 *
 * The transport's own timers are too slow for a file transfer: SCTP heartbeats
 * every 30 s, and Chromium waits about 30 s of silence before it declares the
 * peer dead, with roughly 2.5 s of "disconnected" jitter on top. For someone
 * watching a progress bar that is half a minute of apparent hang. A 2 s echo
 * lets both sides notice a real break within seconds and fall back to the cloud
 * instead of waiting for the transport to admit it. It rides the same ordered
 * channel as the payload, so a reply also proves the peer's receive path is
 * making progress.
 */
interface PingFrame {
  type: "ping";
  nonce: number;
}

interface PongFrame {
  type: "pong";
  nonce: number;
}

type ControlFrame =
  | RequestFrame
  | MetaFrame
  | DoneFrame
  | ResultFrame
  | PingFrame
  | PongFrame;

/**
 * Partitions incoming transport chunks into 1 MiB sink writes/appends and
 * hashes every byte incrementally. Sink calls are serialized so append order
 * matches the wire order even when transport frames arrive back-to-back.
 */
export class LanPartitionWriter {
  private readonly hasher = new StreamingSha256();
  private chunks: ArrayBuffer[] = [];
  private chunkBytes = 0;
  private queue: ArrayBuffer[] = [];
  private chain: Promise<void> = Promise.resolve();
  private failed: Error | null = null;
  private wrote = false;
  private totalBytes = 0;
  private closed = false;

  constructor(
    private readonly sink: LanPartitionSink,
    private readonly partitionBytes = LAN_PARTITION_BYTES,
  ) {
    if (!Number.isFinite(partitionBytes) || partitionBytes <= 0) {
      throw new Error("invalid LAN partition size");
    }
  }

  /** Enqueue one transport frame; safe to call before earlier writes settle. */
  push(chunk: ArrayBuffer): void {
    if (this.closed || this.failed !== null) return;
    this.totalBytes += chunk.byteLength;
    this.hasher.update(new Uint8Array(chunk));
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(
        this.partitionBytes - this.chunkBytes,
        chunk.byteLength - offset,
      );
      this.chunks.push(chunk.slice(offset, offset + take));
      this.chunkBytes += take;
      offset += take;
      if (this.chunkBytes === this.partitionBytes) {
        this.enqueuePartition();
      }
    }
  }

  /** Flush the final partial partition and return the whole-stream hash. */
  async finish(): Promise<LanPathResult> {
    const initialFailure = this.failed;
    if (initialFailure !== null) throw initialFailure;
    this.closed = true;
    if (this.chunkBytes > 0) this.enqueuePartition();
    await this.chain;
    const failure = this.failed;
    if (failure !== null) throw failure;
    if (!this.wrote) {
      await this.sink.write(new ArrayBuffer(0));
      this.wrote = true;
    }
    return { size: this.totalBytes, hash: this.hasher.digestHex() };
  }

  /** Stop accepting frames and discard queued partitions. */
  abort(error = new Error("LAN partition writer aborted")): void {
    this.closed = true;
    this.failed = error;
    this.chunks = [];
    this.chunkBytes = 0;
    this.queue = [];
  }

  private enqueuePartition(): void {
    const part = concatChunks(this.chunks, this.chunkBytes);
    this.chunks = [];
    this.chunkBytes = 0;
    this.queue.push(part);
    this.chain = this.chain.then(() => this.drain()).catch((error: unknown) => {
      this.failed = error instanceof Error
        ? error
        : new Error(String(error));
      this.queue = [];
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && this.failed === null) {
      const part = this.queue.shift()!;
      if (!this.wrote) {
        await this.sink.write(part);
        this.wrote = true;
      } else {
        await this.sink.append(part);
      }
    }
  }
}

interface PendingBase {
  hint: LanContentHint;
  onProgress?: (downloaded: number, total: number) => void;
  received: number;
  attestedSha256: string | null;
  reject: (error: Error) => void;
}

interface PendingBytesRequest extends PendingBase {
  mode: "bytes";
  chunks: ArrayBuffer[];
  resolve: (result: LanContentResult) => void;
}

interface PendingSinkRequest extends PendingBase {
  mode: "sink";
  writer: LanPartitionWriter;
  resolve: (result: LanPathResult) => void;
}

type PendingRequest = PendingBytesRequest | PendingSinkRequest;

interface ActiveServe {
  request: RequestFrame;
  resolve: (result: { size: number; sha256: string }) => void;
  reject: (error: Error) => void;
  onProgress?: (sent: number, total: number) => void;
}

export class LanPeerSession {
  private pending: PendingRequest | null = null;
  private handler: LanServeHandler | null = null;
  private serveProgress: ((sent: number, total: number) => void) | undefined;
  private serveComplete:
    | ((result: {
      path: string;
      size: number;
      sha256: string;
      elapsedMs: number;
    }) => void)
    | undefined;
  private queuedRequest: RequestFrame | null = null;
  private activeServe: ActiveServe | null = null;
  /**
   * Set synchronously when a request starts, before the async handler runs.
   * `activeServe` only exists after the handler returns, so without this a
   * second request arriving during the handler's await would start a second
   * concurrent serve and overwrite the first one's completion callback.
   */
  private serveInProgress = false;
  private closed = false;
  /** Last pong seen (ms) and its nonce; `null` until the peer ever replied. */
  private lastPongAt: number | null = null;
  private lastPongNonce = 0;
  private pingNonce = 0;
  /** Last time bytes moved in either direction; counts as liveness. */
  private lastProgressAt: number | null = null;
  private readonly handleMessageEvent = (event: MessageEvent): void => {
    this.handleMessage(event.data as unknown);
  };
  private readonly handleClose = (): void => {
    this.close(new Error("LAN data channel closed"));
  };

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly dc: RTCDataChannel,
    private readonly now: () => number = () => Date.now(),
  ) {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    dc.addEventListener("message", this.handleMessageEvent);
    dc.addEventListener("close", this.handleClose);
  }

  /** Send one heartbeat; the reply updates `getHealth()`. Never throws. */
  ping(): void {
    this.pingNonce += 1;
    this.sendControl({ type: "ping", nonce: this.pingNonce });
  }

  /**
   * Whether this channel is still carrying the peer's traffic.
   *
   * `silentMs` is the tolerance for "no pong AND no payload progress". A
   * transfer in flight legitimately produces no pongs when the payload is
   * flowing, so `lastProgressAt` counts as liveness too. Returns `false` only
   * when the channel is closed or the peer has been silent past the tolerance.
   */
  getHealth(silentMs: number): {
    open: boolean;
    silentMs: number | null;
    healthy: boolean;
  } {
    const open = !this.closed && this.dc.readyState === "open";
    const lastSign = Math.max(
      this.lastPongAt ?? 0,
      this.lastProgressAt ?? 0,
    );
    if (lastSign === 0) {
      // Nothing to judge yet: a freshly opened channel is healthy.
      return { open, silentMs: null, healthy: open };
    }
    const silent = this.now() - lastSign;
    return { open, silentMs: silent, healthy: open && silent <= silentMs };
  }

  /**
   * Selected pair's local candidate type for S4 diagnostics. Only the type
   * leaves this method: the stats report also carries addresses and ports,
   * which must never reach logs or the settings page.
   */
  async getRouteType(): Promise<LanRouteType> {
    try {
      const stats = await this.pc.getStats();
      let selectedPairId: string | null = null;
      stats.forEach((report: Record<string, unknown>) => {
        if (
          report.type === "transport"
          && typeof report.selectedCandidatePairId === "string"
        ) {
          selectedPairId = report.selectedCandidatePairId;
        }
      });
      let pair: Record<string, unknown> | undefined;
      if (selectedPairId !== null) {
        pair = stats.get(selectedPairId) as
          | Record<string, unknown>
          | undefined;
      }
      if (pair === undefined) {
        stats.forEach((report: Record<string, unknown>) => {
          if (report.type === "candidate-pair" && report.selected === true) {
            pair = report;
          }
        });
      }
      const localCandidateId = typeof pair?.localCandidateId === "string"
        ? pair.localCandidateId
        : null;
      const local = localCandidateId === null
        ? undefined
        : stats.get(localCandidateId) as Record<string, unknown> | undefined;
      return normalizeLanRouteType(local?.candidateType);
    } catch {
      // Stats are advisory; a missing report must not turn a working transfer
      // into a failure.
      return "unknown";
    }
  }

  close(error = new Error("LAN session closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.dc.removeEventListener("message", this.handleMessageEvent);
    this.dc.removeEventListener("close", this.handleClose);
    this.pending?.reject(error);
    if (this.pending?.mode === "sink") this.pending.writer.abort(error);
    this.pending = null;
    this.activeServe?.reject(error);
    this.activeServe = null;
    this.queuedRequest = null;
    this.handler = null;
    try {
      this.dc.close();
    } catch {
      // Already closed.
    }
    try {
      this.pc.close();
    } catch {
      // Already closed.
    }
  }

  /**
   * Sender: handle requests from the receiver against the V2 base receipt.
   *
   * `onServed` fires after the receiver acknowledged the whole payload, so the
   * UI can leave "sending 100%" instead of looking stuck at the last byte;
   * bytes reaching the wire is not the same fact as the peer accepting them.
   */
  serveRequests(
    handler: LanServeHandler,
    onProgress?: (sent: number, total: number) => void,
    onServed?: (result: {
      path: string;
      size: number;
      sha256: string;
      /** Meta frame → receiver ack: content transfer plus the peer's verify. */
      elapsedMs: number;
    }) => void,
  ): void {
    this.handler = handler;
    this.serveProgress = onProgress;
    this.serveComplete = onServed;
    const queued = this.queuedRequest;
    this.queuedRequest = null;
    if (queued !== null) {
      void this.processRequest(queued);
    }
  }

  /** Receiver: request one authorized payload by path + cloud eTag + size. */
  requestBytes(
    hint: LanContentHint,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<LanContentResult> {
    if (this.pending !== null || this.activeServe !== null) {
      return Promise.reject(new Error("a LAN transfer is already in flight"));
    }
    if (this.closed) return Promise.reject(new Error("LAN session is closed"));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.close(new Error("LAN request aborted"));
      };
      if (signal?.aborted === true) {
        onAbort();
        reject(new Error("LAN request aborted"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        mode: "bytes",
        hint,
        onProgress,
        received: 0,
        chunks: [],
        attestedSha256: null,
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const request: RequestFrame = {
        type: "request",
        protocol: LAN_SESSION_PROTOCOL,
        path: hint.path,
        eTag: hint.eTag,
        size: hint.size,
      };
      this.dc.send(JSON.stringify(request));
    });
  }

  /**
   * Receiver (mobile): stream partitions to a sink instead of buffering the
   * whole payload. The sink decides how to persist write/append; this method
   * verifies size and the sender-attested sha256 before resolving.
   */
  requestToSink(
    hint: LanContentHint,
    sink: LanPartitionSink,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<LanPathResult> {
    if (this.pending !== null || this.activeServe !== null) {
      return Promise.reject(new Error("a LAN transfer is already in flight"));
    }
    if (this.closed) return Promise.reject(new Error("LAN session is closed"));
    return new Promise((resolve, reject) => {
      const writer = new LanPartitionWriter(sink);
      const onAbort = (): void => {
        writer.abort(new Error("LAN request aborted"));
        this.close(new Error("LAN request aborted"));
      };
      if (signal?.aborted === true) {
        onAbort();
        reject(new Error("LAN request aborted"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        mode: "sink",
        hint,
        onProgress,
        received: 0,
        writer,
        attestedSha256: null,
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const request: RequestFrame = {
        type: "request",
        protocol: LAN_SESSION_PROTOCOL,
        path: hint.path,
        eTag: hint.eTag,
        size: hint.size,
      };
      this.dc.send(JSON.stringify(request));
    });
  }

  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      let frame: ControlFrame;
      try {
        frame = JSON.parse(data) as ControlFrame;
      } catch {
        return;
      }
      if (frame.type === "request") {
        void this.handleRequest(frame);
      } else if (frame.type === "meta") {
        this.handleMeta(frame);
      } else if (frame.type === "done") {
        void this.handleDone(frame);
      } else if (frame.type === "result") {
        this.handleResult(frame);
      } else if (frame.type === "ping") {
        // Echo immediately: the round trip is the health signal, not the value.
        this.sendControl({ type: "pong", nonce: frame.nonce });
      } else if (frame.type === "pong") {
        this.lastPongAt = this.now();
        this.lastPongNonce = frame.nonce;
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.handleChunk(data);
    }
  }

  private async handleRequest(frame: RequestFrame): Promise<void> {
    if (frame.protocol !== LAN_SESSION_PROTOCOL) {
      this.sendResult({ type: "result", ok: false, error: "protocol mismatch" });
      return;
    }
    if (this.handler === null) {
      if (this.serveInProgress || this.queuedRequest !== null) {
        this.sendResult({ type: "result", ok: false, error: "LAN sender is busy" });
        return;
      }
      this.queuedRequest = frame;
      return;
    }
    // One serve at a time. A request that arrives while the previous payload is
    // still being prepared or awaiting the receiver's ack is queued, not
    // started: two concurrent serves would overwrite `activeServe` and lose the
    // earlier completion callback (field report 2026-11-20: the channel looked
    // like it served one file and then went dead).
    if (this.serveInProgress || this.activeServe !== null
      || this.queuedRequest !== null) {
      this.queuedRequest = frame;
      return;
    }
    await this.processRequest(frame);
  }

  private async processRequest(frame: RequestFrame): Promise<void> {
    const handler = this.handler;
    if (handler === null) {
      this.queuedRequest = frame;
      return;
    }
    // Synchronous claim: the handler below awaits, and a request arriving in
    // that window must queue instead of starting a second serve.
    this.serveInProgress = true;
    try {
      const served = await handler({
        path: frame.path,
        eTag: frame.eTag,
        size: frame.size,
      });
      if ("error" in served) {
        this.sendResult({ type: "result", ok: false, error: served.error });
        return;
      }
      const resultPromise = new Promise<{ size: number; sha256: string }>(
        (resolve, reject) => {
          this.activeServe = {
            request: frame,
            resolve,
            reject,
            onProgress: this.serveProgress,
          };
        },
      );
      const meta: MetaFrame = {
        type: "meta",
        protocol: LAN_SESSION_PROTOCOL,
        path: frame.path,
        eTag: frame.eTag,
        size: served.bytes.byteLength,
        sha256: served.sha256.toLowerCase(),
      };
      this.dc.send(JSON.stringify(meta));
      const transferStartedAt = Date.now();
      try {
        await this.sendBytes(served.bytes, this.serveProgress);
      } catch (error) {
        this.activeServe?.reject(error instanceof Error ? error : new Error(String(error)));
        this.activeServe = null;
        throw error;
      }
      const done: DoneFrame = {
        type: "done",
        size: served.bytes.byteLength,
        sha256: served.sha256.toLowerCase(),
      };
      this.dc.send(JSON.stringify(done));
      const acknowledged = await resultPromise;
      this.serveComplete?.({
        path: frame.path,
        size: acknowledged.size,
        sha256: acknowledged.sha256,
        elapsedMs: Date.now() - transferStartedAt,
      });
    } catch (error) {
      this.sendResult({
        type: "result",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Release the claim and start whatever queued up behind this one, so a
      // long-lived session keeps serving file after file.
      this.serveInProgress = false;
      this.drainQueuedRequest();
    }
  }

  private async sendBytes(
    bytes: ArrayBuffer,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.dc.readyState !== "open") throw new Error("LAN data channel closed");
      if (this.dc.bufferedAmount > HIGH_WATER_BYTES) {
        await waitForDrain(this.dc);
      }
      const length = Math.min(TRANSPORT_CHUNK_BYTES, bytes.byteLength - offset);
      this.dc.send(bytes.slice(offset, offset + length));
      offset += length;
      this.lastProgressAt = this.now();
      onProgress?.(offset, bytes.byteLength);
    }
  }

  private handleMeta(frame: MetaFrame): void {
    const pending = this.pending;
    if (pending === null) return;
    if (frame.protocol !== LAN_SESSION_PROTOCOL
      || frame.path !== pending.hint.path
      || frame.eTag !== pending.hint.eTag
      || frame.size !== pending.hint.size
      || frame.sha256.length === 0) {
      this.failPending(new Error("LAN meta does not match the request"));
      return;
    }
    pending.attestedSha256 = frame.sha256.toLowerCase();
  }

  private handleChunk(data: ArrayBuffer): void {
    const pending = this.pending;
    if (pending === null) return;
    if (pending.received + data.byteLength > pending.hint.size) {
      this.failPending(new Error("LAN peer sent more bytes than requested"));
      return;
    }
    if (pending.mode === "bytes") {
      pending.chunks.push(data);
    } else {
      pending.writer.push(data);
    }
    pending.received += data.byteLength;
    this.lastProgressAt = this.now();
    pending.onProgress?.(pending.received, pending.hint.size);
  }

  private async handleDone(frame: DoneFrame): Promise<void> {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    try {
      if (pending.attestedSha256 === null
        || frame.size !== pending.hint.size
        || pending.received !== pending.hint.size) {
        throw new Error("LAN size/meta mismatch");
      }
      if (pending.mode === "bytes") {
        const bytes = concatChunks(pending.chunks, pending.received);
        const hash = await sha256Hex(bytes);
        if (hash !== pending.attestedSha256) {
          throw new Error("LAN sha256 mismatch");
        }
        this.sendResult({
          type: "result",
          ok: true,
          size: pending.received,
          sha256: hash,
        });
        pending.resolve({ bytes, sha256: hash });
        return;
      }
      const result = await pending.writer.finish();
      if (result.size !== pending.hint.size
        || result.hash !== pending.attestedSha256) {
        throw new Error("LAN sha256 mismatch");
      }
      this.sendResult({
        type: "result",
        ok: true,
        size: result.size,
        sha256: result.hash,
      });
      pending.resolve(result);
    } catch (error) {
      if (pending.mode === "sink") pending.writer.abort(
        error instanceof Error ? error : new Error(String(error)),
      );
      const message = error instanceof Error ? error.message : String(error);
      this.sendResult({ type: "result", ok: false, error: message });
      pending.reject(error instanceof Error ? error : new Error(message));
    }
  }

  private handleResult(frame: ResultFrame): void {
    const active = this.activeServe;
    this.activeServe = null;
    if (active === null) return;
    if (frame.ok) {
      active.resolve({
        size: frame.size ?? 0,
        sha256: frame.sha256 ?? "",
      });
    } else {
      active.reject(new Error(frame.error ?? "LAN receiver rejected the transfer"));
    }
    // The slot is free again: start whatever request arrived while this one was
    // waiting for its ack, so a session keeps serving file after file.
    this.drainQueuedRequest();
  }

  /** Start a request that arrived while the previous serve was still open. */
  private drainQueuedRequest(): void {
    if (this.serveInProgress || this.activeServe !== null) return;
    const queued = this.queuedRequest;
    if (queued === null) return;
    this.queuedRequest = null;
    void this.processRequest(queued);
  }

  private sendResult(frame: ResultFrame): void {
    this.sendControl(frame);
  }

  /** Any JSON control frame; a closed channel simply drops it. */
  private sendControl(frame: ControlFrame): void {
    if (this.dc.readyState !== "open") return;
    try {
      this.dc.send(JSON.stringify(frame));
    } catch {
      // The peer may already be gone.
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (pending?.mode === "sink") pending.writer.abort(error);
    this.sendResult({ type: "result", ok: false, error: error.message });
    pending?.reject(error);
  }
}

export function createLanContentSource(
  session: LanPeerSession,
  onProgress?: (downloaded: number, total: number) => void,
): LanContentSource {
  return {
    downloadFile: (hint, progress, signal) => session.requestBytes(
      hint,
      (downloaded, total) => {
        onProgress?.(downloaded, total);
        progress?.(downloaded, total);
      },
      signal,
    ),
    getRouteType: () => session.getRouteType(),
    downloadFileToPath: async (hint, localPath, adapter, progress, signal) => {
      let wrote = false;
      const sink: LanPartitionSink = {
        write: async (bytes) => {
          await adapter.writeBinary(localPath, bytes);
          wrote = true;
        },
        append: async (bytes) => {
          if (!wrote) {
            await adapter.writeBinary(localPath, bytes);
            wrote = true;
            return;
          }
          await adapter.appendBinary(localPath, bytes);
        },
      };
      try {
        return await session.requestToSink(
          hint,
          sink,
          (downloaded, total) => {
            onProgress?.(downloaded, total);
            progress?.(downloaded, total);
          },
          signal,
        );
      } catch (error) {
        await adapter.remove(localPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

export async function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = 12000,
): Promise<"complete" | "timeout"> {
  if (pc.iceGatheringState === "complete") return "complete";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "complete" | "timeout"): void => {
      if (settled) return;
      settled = true;
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      window.clearTimeout(timer);
      resolve(result);
    };
    const onStateChange = (): void => {
      if (pc.iceGatheringState === "complete") finish("complete");
    };
    const timer = window.setTimeout(() => finish("timeout"), timeoutMs);
    pc.addEventListener("icegatheringstatechange", onStateChange);
  });
}

export async function waitForDataChannelOpen(
  dc: RTCDataChannel,
  timeoutMs = 20000,
): Promise<void> {
  if (dc.readyState === "open") return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      dc.removeEventListener("open", onOpen);
      dc.removeEventListener("close", onClose);
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = (): void => finish();
    const onClose = (): void => finish(new Error("LAN data channel closed before open"));
    const timer = window.setTimeout(
      () => finish(new Error("LAN data channel open timeout")),
      timeoutMs,
    );
    dc.addEventListener("open", onOpen, { once: true });
    dc.addEventListener("close", onClose, { once: true });
  });
}

/** Keep the parser's required final line break (S1 probe finding). */
export function normalizeSdp(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

async function waitForDrain(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount <= LOW_WATER_BYTES) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      dc.removeEventListener("bufferedamountlow", onLow);
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onLow = (): void => finish();
    const timer = window.setTimeout(
      () => finish(new Error("LAN data channel drain timeout")),
      30000,
    );
    dc.addEventListener("bufferedamountlow", onLow, { once: true });
    if (dc.bufferedAmount <= LOW_WATER_BYTES) finish();
  });
}

function concatChunks(chunks: ArrayBuffer[], totalBytes: number): ArrayBuffer {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
