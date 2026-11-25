/**
 * Automatic LAN connection manager (S5a, experimental).
 *
 * One handshake, one long-lived data channel. The desktop keeps a watcher on
 * the fixed presence request; a device that needs bytes writes one request,
 * answers the offer once, and then reuses the same open channel for every
 * later file in this run and later runs. The channel is only dropped when it
 * actually closes or errors; the next transfer then acquires again.
 *
 * Boundaries that do not move:
 *   - the cloud stays authoritative; this module only chooses where bytes come
 *     from and never mutates sync state;
 *   - every serve request still goes through the shared six-check gate;
 *   - any failure is silent for the user and falls back to the cloud download;
 *   - logs carry step, byte count, elapsed time and route class only. Room
 *     secrets, endpoints and raw candidate text never leave this module.
 *
 * This whole module is dynamically imported by `main.ts`; it must not become
 * part of the static startup closure.
 */
import {
  cleanupExpiredLanSignalSessions,
  closeLanSignalSession,
  pollLanSignal,
  provisionLanPairing,
  publishLanSignalOffer,
  readLanPairing,
  readLanSignalActiveSession,
  readLanSignalAnswer,
  readLanSignalCandidates,
  readLanSignalOffer,
  serializeLanPairingRecord,
  verifyLanPairingRecord,
  writeLanSignalAnswer,
  writeLanSignalCandidates,
  type LanPairingRecord,
  type LanSignalSession,
  type LanSignalTransport,
} from "./lan-signaling";
import {
  clearLanPresenceRequest,
  generateLanPresenceNonce,
  isLanPresenceCleanupRejection,
  isLanPresenceRoomRejection,
  LanPresenceNonceCache,
  readLanPresenceRequest,
  writeLanPresenceRequest,
} from "./lan-presence";
import type { LanContentHint, LanContentSource } from "./lan-content-source";
import type { LanRouteType } from "./lan-diagnostics";
import {
  resolveLanServeFile,
  type LanServeGateDeps,
} from "./lan-serve-gate";
import type { LanTransferPhase } from "./lan-transfer-activity";
import {
  LanPeerSession,
  createLanContentSource,
  normalizeSdp,
} from "../dev/lan-session";
import {
  compatClearTimeout,
  compatSetTimeout,
  describeError,
  type HostPlatformFacts,
} from "../obsidian-compat";

/** Idle watcher period (cloud control read while nothing is happening). */
export const LAN_WATCHER_IDLE_INTERVAL_MS = 8_000;
/** Watcher period while a valid request was seen in the recent window. */
export const LAN_WATCHER_ACTIVE_INTERVAL_MS = 1_500;
/** How long one valid request keeps the watcher in the fast mode. */
export const LAN_WATCHER_ACTIVE_WINDOW_MS = 10 * 60_000;
/**
 * Acquirer: overall window to find the active pointer and its offer.
 *
 * Field measurement 2026-11-20 (Graph control plane ~1.4 s per request):
 * request write → watcher sees it (≤ idle poll) → offer + pointer publish
 * (~5 s) → active read → answer write → channel open lands at roughly 19–20 s.
 * A 15 s window gave up just before the peer could answer, and the phone then
 * spent minutes on a 79 KB/s cloud download that a 20 s wait would have
 * avoided. The window is deliberately larger than the handshake, not the
 * other way round.
 */
export const LAN_ACQUIRE_OFFER_WAIT_MS = 30_000;
/**
 * Acquirer: how long one download may wait before falling back to the cloud.
 *
 * This is the floor of `acquireAwaitMs`: for a small file a handshake cannot
 * pay for itself, so the download goes straight to the cloud while the
 * acquisition keeps running in the background for later files.
 */
export const LAN_ACQUIRE_AWAIT_MS = 2_500;
/** Files at or above this size may wait for the whole handshake window. */
export const LAN_ACQUIRE_WAIT_FULL_BYTES = 64 * 1024 * 1024;
/**
 * Per-download wait ceiling: the acquisition's own deadline (offer discovery
 * plus channel open, i.e. `LAN_ACQUIRE_OFFER_WAIT_MS +
 * LAN_ACQUIRE_CHANNEL_WAIT_MS`). Waiting longer than the acquisition can take
 * would only delay the cloud fallback the caller ends up using anyway.
 *
 * This is the number that matters in the field: on a slow cloud link a large
 * file waits out the full window rather than starting a minutes-long download
 * it will abandon.
 */
export const LAN_ACQUIRE_WAIT_MAX_MS =
  LAN_ACQUIRE_OFFER_WAIT_MS + 10_000;
/** Acquirer: fixed active-pointer poll period. */
export const LAN_ACQUIRE_POLL_MS = 1_000;
/** Acquirer: data channel open window after the answer is written. */
export const LAN_ACQUIRE_CHANNEL_WAIT_MS = 10_000;
/** After a failed acquire, do not stall the next files again for this long. */
export const LAN_ACQUIRE_FAILURE_COOLDOWN_MS = 60_000;
/** Host: how long the answer may take after publishing. */
export const LAN_HOST_ANSWER_WAIT_MS = 20_000;
/** Host: data channel open window. */
export const LAN_HOST_CHANNEL_WAIT_MS = 20_000;
/**
 * How long to wait for ICE gathering before publishing the SDP.
 *
 * With `iceServers: []` only host candidates are gathered, and on a LAN that
 * completes in tens of milliseconds. The old 500 ms "early SDP" window was a
 * trickle-ICE compromise, but trickle is a *negative* optimisation on a 1.4 s
 * control plane: every late candidate costs one cloud round trip to publish and
 * another to read, which measured as 3–5 s per handshake. Waiting out the
 * gather keeps every candidate inside the SDP, so no candidate file is ever
 * written on the critical path (RFC 8838 explicitly anticipates this trade-off
 * and says trickle pays off in proportion to signalling RTT).
 */
export const LAN_AUTO_CONNECT_ICE_WINDOW_MS = 3_000;
/**
 * Candidate poll deadline.
 *
 * Only a fallback for candidates that appear after the gather window closed
 * (a path change mid-handshake). The normal path has everything in the SDP, so
 * this loop is expected to sit idle.
 */
export const LAN_AUTO_CONNECT_CANDIDATE_WINDOW_MS = 5_000;

const CHANNEL_LABEL = "easy-sync-lan-session";
const CANDIDATE_POLL_MS = 1_000;
/**
 * How long a peer may stay silent before a transfer is abandoned.
 *
 * SCTP heartbeats every 30 s and Chromium waits 30 s before declaring a dead
 * connection, so without this the user watches a frozen progress bar for half a
 * minute. Pings are 2 s apart and any payload byte also counts as liveness, so
 * 6 s is comfortably above one missed cadence yet far below the transport's own
 * timer.
 */
export const LAN_TRANSFER_SILENCE_MS = 6_000;
/** Sender-side heartbeat cadence on an idle open channel. */
export const LAN_HEARTBEAT_INTERVAL_MS = 2_000;

/** Timer seam so tests can drive both roles without real waits. */
export interface LanAutoConnectTimers {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(ms: number): Promise<void>;
}

/** One diagnostic line: no secret, no endpoint, no candidate text. */
export interface LanAutoConnectLogEvent {
  /** Machine-readable step name, e.g. "request-seen" or "acquire-failed". */
  step: string;
  /** Bytes moved, when the step moved bytes. */
  bytes?: number;
  /** Wall time of the step, when meaningful. */
  elapsedMs?: number;
  /** Route class only (host/srflx/prflx/relay/unknown). */
  route?: LanRouteType;
  /** Stable result word: ok / fallback / error / timeout. */
  result?: string;
}

/** Dependency seam owned by `main.ts`. */
export interface LanAutoConnectDeps {
  /** Build the provider-neutral cloud signaling transport for this vault. */
  createTransport(): LanSignalTransport;
  /** Shared six-check sender gate (the dev modal uses the same implementation). */
  serveGate: LanServeGateDeps;
  /** Install a reusable source into the running client. */
  injectSource(source: LanContentSource): boolean;
  /** Remove the source; called when the reusable channel is gone. */
  clearSource(): void;
  /** Desktop runs the watcher; mobile only acquires. */
  platform: HostPlatformFacts;
  /** Timers (tests inject a fake; production uses host timers). */
  timers?: LanAutoConnectTimers;
  /** Peer connection factory (tests inject a fake). */
  createPeerConnection?: () => RTCPeerConnection;
  /** Diagnostic sink; never called with secrets. */
  log?(event: LanAutoConnectLogEvent, message: string): void;
  /** Device-local pairing cache (SecretStorage); the cloud copy stays authoritative. */
  savePairing?(raw: string): Promise<void>;
  /** Sidebar chip lifecycle: pairing → connected → transferring, `null` when the
   *  session is gone. Optional so headless callers keep their behaviour; a throw
   *  from this sink must never affect the transfer. */
  reportPhase?(phase: LanTransferPhase | null): void;
  /** Sidebar chip byte progress (sender: bytes on the wire; receiver: bytes
   *  received). Same failure isolation as `reportPhase`. */
  reportProgress?(downloaded: number, total: number): void;
}

/** Read-only snapshot for host verification. */
export interface LanAutoConnectState {
  started: boolean;
  watcher: boolean;
  polling: boolean;
  watcherIntervalMs: number;
  lastRequestSeenAt: number | null;
  hostSessionActive: boolean;
  acquirerSessionActive: boolean;
  lastStep: string | null;
}

/**
 * Owns both roles. `start()` begins polling; `stop()` cancels it and closes
 * every channel. All failures stay inside this class and fall back to cloud.
 */
export class LanAutoConnectManager {
  private readonly timers: LanAutoConnectTimers;
  private stopped = true;
  private watcherTimer: unknown = null;
  /**
   * The signaling adapter, created once per manager.
   *
   * Each transport instance caches "the control directories exist", so
   * building a new one per poll threw that away and re-created already existing
   * folders with a PUT that answers 409 — two cloud round trips per poll, on a
   * ~1.4 s control plane. One adapter for the whole manager keeps the cache
   * meaningful. It holds no socket and no session; recreating it was never a
   * correctness requirement, only an accident of the wiring.
   */
  private transport: LanSignalTransport | null = null;
  /** Sender-side liveness timer; one per open host session. */
  private hostHeartbeat: unknown = null;
  private watcherPolling = false;
  private lastRequestSeenAt: number | null = null;
  private watcherIntervalMs = LAN_WATCHER_IDLE_INTERVAL_MS;
  private readonly nonces = new LanPresenceNonceCache();
  /** Nonces this manager wrote as the acquirer; its watcher must ignore them. */
  private readonly ownNonces = new LanPresenceNonceCache();
  private pairing: LanPairingRecord | null = null;
  /** The cached record already passed `verifyLanPairingRecord` when it was
   *  read/provisioned; it is immutable for the session, so the 8 s watcher
   *  tick must not re-derive its HMAC every time. */
  private pairingVerified = false;
  private lastStep: string | null = null;

  private hostSession: LanHostSession | null = null;
  private acquireInFlight: Promise<LanContentSource | null> | null = null;
  private acquirerSession: LanAcquirerSession | null = null;
  private lastAcquireFailureAt: number | null = null;
  private transferChain: Promise<void> = Promise.resolve();
  /** Last phase handed to the sidebar sink; `undefined` = never reported.
   *  Repeats are skipped: the sink is a per-session display, not an event log. */
  private reportedPhase: LanTransferPhase | null | undefined = undefined;

  constructor(private readonly deps: LanAutoConnectDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  /** Start the role this platform is eligible for. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastStep = "started";
    if (!this.deps.platform.isDesktopApp || this.deps.platform.isMobileApp) {
      // Mobile is acquisition-only: it must never publish an offer.
      this.lastStep = "acquirer-only";
      return;
    }
    this.lastStep = "watcher-started";
    this.scheduleWatcher(0);
  }

  /**
   * Poll now instead of waiting out the current timer.
   *
   * Foreground/online events and the end of a sync round call this: those are
   * the moments a peer is most likely to have just written a request, and
   * waiting up to a full idle interval there would lose the request.
   */
  pokeWatcher(): void {
    if (this.stopped) return;
    if (!this.deps.platform.isDesktopApp || this.deps.platform.isMobileApp) {
      return;
    }
    if (this.hostSession !== null || this.watcherPolling) return;
    this.scheduleWatcher(0);
  }

  /**
   * Stop immediately: cancel polling, close both channels and remove the
   * injected source. The cloud call shape is restored before this returns.
   */
  stop(): void {
    this.stopped = true;
    if (this.watcherTimer !== null) {
      this.timers.clearTimeout(this.watcherTimer);
      this.watcherTimer = null;
    }
    this.watcherPolling = false;
    this.nonces.clear();
    this.ownNonces.clear();
    this.lastRequestSeenAt = null;
    this.watcherIntervalMs = LAN_WATCHER_IDLE_INTERVAL_MS;
    this.closeHostSession("stopped");
    this.closeAcquirerSession("stopped");
    // The adapter caches "directories exist"; a stopped manager has no reason
    // to trust it next time (another device may have cleaned the room up).
    this.transport = null;
    // The indicator must never outlive the sessions it describes.
    this.syncPhaseFromSessions();
    this.pairing = null;
    this.pairingVerified = false;
    this.lastStep = "stopped";
  }

  /** Read-only state for host-side verification. */
  getState(): LanAutoConnectState {
    return {
      started: !this.stopped,
      watcher: this.deps.platform.isDesktopApp
        && !this.deps.platform.isMobileApp,
      polling: this.watcherPolling,
      watcherIntervalMs: this.watcherIntervalMs,
      lastRequestSeenAt: this.lastRequestSeenAt,
      hostSessionActive: this.hostSession !== null,
      acquirerSessionActive: this.acquirerSession !== null,
      lastStep: this.lastStep,
    };
  }

  /**
   * Run exactly one watcher poll (scheduling-independent; used by tests and by
   * host verification). Never throws: every failure is a diagnostic line.
   */
  async pollOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.watcherPolling) return;
    await this.watcherTick();
  }

  /**
   * Start acquiring without waiting.
   *
   * Called when a sync round is about to scan, so the handshake overlaps
   * planning instead of starting only after the first download is already
   * waiting. Safe to call repeatedly; never waits and never throws.
   *
   * Desktop never prewarms. One manager owns one acquisition slot, and a
   * desktop that acquires is unavailable to answer a peer: the 2026-11-20
   * field run lost a whole round exactly that way. The desktop's job in this
   * feature is to stay free as the sender; only the receive-only mobile side
   * starts a handshake on its own.
   */
  prewarm(): void {
    if (this.stopped) return;
    if (!this.deps.platform.isMobileApp) return;
    if (this.acquirerSession !== null
      && this.acquirerSession.dc.readyState === "open") {
      return;
    }
    if (this.acquireInFlight !== null) return;
    const now = this.timers.now();
    if (
      this.lastAcquireFailureAt !== null
      && now - this.lastAcquireFailureAt < LAN_ACQUIRE_FAILURE_COOLDOWN_MS
    ) {
      return;
    }
    // An empty hint is safe: `doAcquire` only uses the size for logging, and
    // the real per-file size check still happens in the sender gate.
    this.acquireInFlight = this.runAcquire({
      path: "",
      eTag: "",
      size: 0,
    });
  }

  /**
   * Return a live reusable source, acquiring one only when needed.
   *
   * A cached source whose channel is no longer open is discarded, never
   * reused. Concurrent callers share one in-flight acquisition. A failed
   * acquisition starts a short cooldown so later files of the same round do not
   * each pay the same wait.
   *
   * Desktop never acquires, for the same reason it never prewarms: a desktop
   * that holds the joiner half stops being the sender. `acquire()` used to be
   * the one entry without that gate, and it is the entry a real download calls
   * (`OnedriveClient.resolveLanSource`), so a desktop downloading a file above
   * the threshold opened its own handshake. Signalling carries no device
   * identity — one room, one key — so that handshake could then read back the
   * `active.json` the same machine had just published as a host and answer it,
   * burning the whole offer window before falling back to the cloud
   * (2026-11-22 review).
   */
  acquire(hint: LanContentHint): Promise<LanContentSource | null> {
    if (this.stopped) return Promise.resolve(null);
    if (!this.deps.platform.isMobileApp) {
      // Same one-way rule as `prewarm`: only the receive-only side starts a
      // handshake on its own. `lastStep` keeps the reason visible to host
      // verification instead of a silent null.
      this.lastStep = "acquirer-only";
      return Promise.resolve(null);
    }
    const cached = this.acquirerSession;
    if (cached !== null) {
      if (cached.dc.readyState === "open") return Promise.resolve(cached.source);
      this.closeAcquirerSession("channel-not-open");
    }
    if (this.acquireInFlight === null) {
      const now = this.timers.now();
      if (
        this.lastAcquireFailureAt !== null
        && now - this.lastAcquireFailureAt < LAN_ACQUIRE_FAILURE_COOLDOWN_MS
      ) {
        return Promise.resolve(null);
      }
      this.acquireInFlight = this.runAcquire(hint);
    }
    // Waiting only pays off when the LAN transfer can still beat the cloud
    // one, so the window scales with file size and is capped by the handshake
    // deadline. A file that the cloud would finish in seconds is not worth a
    // handshake: it falls back immediately and a later file reuses whatever
    // the background acquisition finishes.
    const inFlight = this.acquireInFlight;
    return waitBounded(inFlight, acquireAwaitMs(hint.size), this.timers)
      .then(() => this.isAcquirerReady() ? this.currentSource() : null);
  }

  private async runAcquire(hint: LanContentHint): Promise<LanContentSource | null> {
    let source: LanContentSource | null = null;
    try {
      source = await this.doAcquire(hint);
      return source;
    } catch (error) {
      this.recordAcquireFailure("error");
      this.deps.log?.({
        step: "acquire-error",
        result: "error",
      }, `LAN acquire failed: ${describeError(error)}`);
      return null;
    } finally {
      this.acquireInFlight = null;
      // A failed handshake must not leave the chip parked on "pairing"; a
      // successful one leaves a live acquirer session and this is a no-op.
      if (source === null) this.syncPhaseFromSessions();
    }
  }

  /** True when a live channel is cached and safe to hand out. */
  private isAcquirerReady(): boolean {
    return this.acquirerSession !== null
      && this.acquirerSession.dc.readyState === "open";
  }

  private currentSource(): LanContentSource | null {
    return this.acquirerSession?.source ?? null;
  }

  private signalTransport(): LanSignalTransport {
    this.transport ??= this.deps.createTransport();
    return this.transport;
  }

  private async doAcquire(hint: LanContentHint): Promise<LanContentSource | null> {
    const startedAt = this.timers.now();
    // Everything until the data channel opens is pairing: request write,
    // active-pointer discovery, offer read, answer write and ICE/DTLS. A live
    // session (the desktop sender role) outranks this state: acquiring next
    // to it must not wipe the chip that describes the open channel.
    this.reportTransferPhase(this.hasLiveSession() ? "connected" : "pairing");
    this.log("acquire-start", "LAN acquire started", {
      bytes: hint.size,
      result: "ok",
    });
    let transport: LanSignalTransport;
    try {
      transport = this.signalTransport();
    } catch {
      this.recordAcquireFailure("transport");
      return null;
    }
    const pairing = await this.ensurePairing(transport, true);
    if (pairing === null) {
      this.recordAcquireFailure("pairing");
      return null;
    }
    const nonce = generateLanPresenceNonce();
    // Remember before the write: the watcher tick can observe the cloud object
    // the instant the write lands, and a post-write registration would lose
    // that race and publish an offer for this device's own request.
    this.ownNonces.remember(nonce);
    const written = await writeLanPresenceRequest(transport, {
      pairing,
      now: this.timers.now(),
      nonce,
    });
    if (written.status !== "written") {
      this.recordAcquireFailure("request-write");
      return null;
    }
    this.lastStep = "request-written";
    // One absolute deadline covers discovery, the offer read and the answer:
    // per-step windows would add to ~30 s on a slow control plane.
    const offerDeadline = this.timers.now() + LAN_ACQUIRE_OFFER_WAIT_MS;
    const remainingOfferMs = (): number => Math.max(
      0,
      offerDeadline - this.timers.now(),
    );
    let pc: RTCPeerConnection | null = null;
    let session: LanPeerSession | null = null;
    try {
      const active = await pollLanSignal(async () => {
        const read = await readLanSignalActiveSession(transport, {
          pairing,
          now: this.timers.now(),
        });
        if (read.status === "none" || read.status === "expired") return null;
        if (read.status === "rejected") {
          throw new Error(`LAN active session rejected: ${read.reason}`);
        }
        return read;
      }, {
        timeoutMs: remainingOfferMs(),
        initialIntervalMs: LAN_ACQUIRE_POLL_MS,
        maxIntervalMs: LAN_ACQUIRE_POLL_MS,
        backoffMultiplier: 1,
        now: () => this.timers.now(),
        sleep: (ms) => this.timers.sleep(ms),
      });
      if (active === null || this.stopped) {
        this.recordAcquireFailure("no-offer");
        return null;
      }
      const offer = await pollLanSignal(async () => {
        const read = await readLanSignalOffer(transport, {
          pairing,
          session: active.session,
          now: this.timers.now(),
          activeSession: active.session,
        });
        if (read.status === "pending") return null;
        if (read.status === "closed") {
          throw new Error(`LAN offer closed: ${read.closeStatus}`);
        }
        if (read.status === "rejected") {
          throw new Error(`LAN offer rejected: ${read.reason}`);
        }
        return read;
      }, {
        timeoutMs: remainingOfferMs(),
        initialIntervalMs: 250,
        maxIntervalMs: 500,
        now: () => this.timers.now(),
        sleep: (ms) => this.timers.sleep(ms),
      });
      if (offer === null || this.stopped) {
        this.recordAcquireFailure("no-offer");
        return null;
      }
      if (offer.record.type !== "offer") {
        this.recordAcquireFailure("offer-type");
        return null;
      }

      pc = this.createPeerConnection();
      const channelReady = createChannelPromise();
      pc.ondatachannel = (event) => {
        channelReady.resolve(event.channel);
      };
      const candidates = collectCandidates(pc);
      await pc.setRemoteDescription({
        type: "offer",
        sdp: normalizeSdp(offer.record.payload.sdp),
      });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIce(pc, LAN_AUTO_CONNECT_ICE_WINDOW_MS, this.timers);
      if (this.stopped) return null;
      const sdp = pc.localDescription?.sdp ?? "";
      if (sdp.length === 0) {
        this.recordAcquireFailure("answer-sdp");
        return null;
      }
      const answerWritten = await writeLanSignalAnswer(transport, {
        pairing,
        session: active.session,
        sdp,
        now: this.timers.now(),
        activeSession: active.session,
      });
      if (answerWritten.status !== "written") {
        this.recordAcquireFailure("answer-write");
        return null;
      }
      this.lastStep = "answer-written";
      const candidateState = { applied: 0 };
      void this.pushCandidates(
        transport, pairing, active.session, "joiner", candidates, sdp,
      );
      void this.pollPeerCandidates(
        transport, pairing, active.session, pc, "host", candidateState,
      );
      const dc = await channelReady.wait(LAN_ACQUIRE_CHANNEL_WAIT_MS, this.timers);
      if (dc === null || this.stopped) {
        this.recordAcquireFailure("no-channel");
        return null;
      }
      try {
        await waitForChannelOpen(dc, LAN_ACQUIRE_CHANNEL_WAIT_MS, this.timers);
      } catch {
        this.recordAcquireFailure("channel-open");
        return null;
      }
      session = new LanPeerSession(pc, dc);
      const source = this.wrapSource(
        createLanContentSource(session, (downloaded, total) => {
          this.reportTransferProgress(downloaded, total);
        }),
        dc,
        session,
      );
      const record: LanAcquirerSession = {
        session,
        dc,
        source,
      };
      this.acquirerSession = record;
      dc.addEventListener("close", () => {
        if (this.acquirerSession === record) {
          this.closeAcquirerSession("channel-closed");
        }
        // Another session may still own the chip; the helper decides.
        this.syncPhaseFromSessions();
      });
      if (!this.deps.injectSource(source)) {
        this.closeAcquirerSession("inject-failed");
        this.recordAcquireFailure("inject");
        return null;
      }
      this.lastStep = "acquirer-ready";
      this.reportTransferPhase("connected");
      this.log("acquirer-ready", "LAN auto connect ready", {
        result: "ok",
        elapsedMs: this.timers.now() - startedAt,
      });
      void closeLanSignalSession(transport, {
        pairing,
        session: active.session,
        role: "joiner",
        status: "completed",
        now: this.timers.now(),
      }).catch(() => undefined)
        .then(() => this.cleanupStale(transport, pairing));
      return source;
    } catch (error) {
      this.recordAcquireFailure("error");
      this.deps.log?.({
        step: "acquire-error",
        result: "error",
      }, `LAN acquire failed: ${describeError(error)}`);
      session?.close();
      try {
        pc?.close();
      } catch {
        // Already closed.
      }
      return null;
    } finally {
      // Only this caller's request: the eTag guard keeps a newer request from
      // another device safe.
      await clearLanPresenceRequest(transport, { eTag: written.eTag })
        .catch(() => undefined);
    }
  }

  private recordAcquireFailure(step: string): void {
    this.lastAcquireFailureAt = this.timers.now();
    this.lastStep = `acquire-${step}`;
    this.log(`acquire-${step}`, "LAN auto connect acquire failed", {
      result: "fallback",
      elapsedMs: 0,
    });
  }

  private scheduleWatcher(delayMs: number): void {
    if (this.stopped) return;
    if (this.watcherTimer !== null) {
      this.timers.clearTimeout(this.watcherTimer);
      this.watcherTimer = null;
    }
    this.watcherTimer = this.timers.setTimeout(() => {
      this.watcherTimer = null;
      void this.watcherTick();
    }, delayMs);
  }

  private async watcherTick(): Promise<void> {
    if (this.stopped) return;
    this.watcherPolling = true;
    try {
      if (this.hostSession !== null) {
        // A live session already covers this room; new requests are ignored
        // until it closes (the receiver reuses the same channel).
        this.lastStep = "watcher-session-active";
        return;
      }
      if (this.acquireInFlight !== null) {
        // Acquiring does NOT close the sending role.
        //
        // The old guard skipped the whole tick while this device was acquiring,
        // on the theory that two handshakes would race. They do not: the host
        // and acquirer halves are separate fields, and the acquirer's own
        // request is filtered out by the `ownNonces` check below. What the
        // guard actually did was make the desktop — the only side that can
        // serve bytes — unreachable for however long its own download took.
        // Field log 2026-11-21 05:45: 17 consecutive skips over 23 s while the
        // phone's request aged out, then the acquire failed anyway.
        this.lastStep = "watcher-acquiring-concurrently";
      }
      const transport = this.signalTransport();
      const pairing = await this.ensurePairing(transport, false);
      if (pairing === null) {
        this.lastStep = "watcher-no-pairing";
        return;
      }
      const read = await readLanPresenceRequest(transport, {
        pairing,
        now: this.timers.now(),
      });
      if (read.status === "none") {
        this.lastStep = "no-request";
        return;
      }
      if (read.status === "ready") {
        if (this.ownNonces.has(read.record.nonce)) {
          // This device wrote the request: the peer is the receiver, so this
          // watcher must stay passive or both desktops would publish an offer.
          this.lastStep = "own-request";
          return;
        }
        if (!this.nonces.remember(read.record.nonce)) {
          this.lastStep = "request-replay";
          return;
        }
        this.lastRequestSeenAt = this.timers.now();
        this.lastStep = "request-seen";
        this.log("request-seen", "LAN presence request seen", { result: "ok" });
        await this.hostOnce(transport, pairing);
        return;
      }
      this.lastStep = `request-${read.reason}`;
      if (isLanPresenceCleanupRejection(read.reason) && read.eTag !== undefined) {
        // Expired/future-dated requests can never become valid; deleting this
        // exact version keeps the fast-mode window from polling a dead file.
        await clearLanPresenceRequest(transport, { eTag: read.eTag })
          .catch(() => undefined);
        return;
      }
      if (isLanPresenceRoomRejection(read.reason)) {
        // The room may have rotated; the next tick re-reads the cloud copy.
        this.pairing = null;
        this.pairingVerified = false;
      }
    } catch (error) {
      this.deps.log?.({
        step: "watcher-error",
        result: "error",
      }, `LAN watcher tick failed: ${describeError(error)}`);
    } finally {
      this.watcherPolling = false;
      const recent = this.lastRequestSeenAt !== null
        && this.timers.now() - this.lastRequestSeenAt
          <= LAN_WATCHER_ACTIVE_WINDOW_MS;
      this.watcherIntervalMs = recent
        ? LAN_WATCHER_ACTIVE_INTERVAL_MS
        : LAN_WATCHER_IDLE_INTERVAL_MS;
      if (!this.stopped && this.hostSession === null) {
        this.scheduleWatcher(this.watcherIntervalMs);
      }
    }
  }

  private async hostOnce(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
  ): Promise<void> {
    const startedAt = this.timers.now();
    // Pairing starts when this side begins publishing an offer; it ends when
    // the data channel is open and the serve handler is installed. Same rule
    // as the acquirer: an already-open channel keeps the "connected" icon.
    this.reportTransferPhase(this.hasLiveSession() ? "connected" : "pairing");
    let pc: RTCPeerConnection | null = null;
    let session: LanPeerSession | null = null;
    try {
      pc = this.createPeerConnection();
      const dc = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
      const candidates = collectCandidates(pc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc, LAN_AUTO_CONNECT_ICE_WINDOW_MS, this.timers);
      if (this.stopped) return;
      const sdp = pc.localDescription?.sdp ?? "";
      if (sdp.length === 0) throw new Error("empty LAN offer SDP");
      const published = await publishLanSignalOffer(transport, {
        pairing,
        sdp,
        now: this.timers.now(),
      });
      if (this.stopped) return;
      if (published.status === "busy") {
        this.lastStep = "publish-busy";
        return;
      }
      if (published.status !== "published") {
        this.lastStep = `publish-${published.status}`;
        return;
      }
      this.lastStep = "offer-published";
      const candidateState = { applied: 0 };
      void this.pushCandidates(
        transport, pairing, published.session, "host", candidates, sdp,
      );
      void this.pollPeerCandidates(
        transport, pairing, published.session, pc, "joiner", candidateState,
      );
      const answer = await pollLanSignal(async () => {
        const read = await readLanSignalAnswer(transport, {
          pairing,
          session: published.session,
          now: this.timers.now(),
        });
        if (read.status === "pending") return null;
        if (read.status === "closed") {
          throw new Error(`LAN answer closed: ${read.closeStatus}`);
        }
        if (read.status === "rejected") {
          throw new Error(`LAN answer rejected: ${read.reason}`);
        }
        return read;
      }, {
        timeoutMs: LAN_HOST_ANSWER_WAIT_MS,
        initialIntervalMs: 500,
        maxIntervalMs: 1_000,
        now: () => this.timers.now(),
        sleep: (ms) => this.timers.sleep(ms),
      });
      if (answer === null || this.stopped) {
        this.lastStep = "answer-timeout";
        await closeLanSignalSession(transport, {
          pairing,
          session: published.session,
          role: "host",
          status: "failed",
          now: this.timers.now(),
        }).catch(() => undefined);
        return;
      }
      if (answer.record.type !== "answer") return;
      await pc.setRemoteDescription({
        type: "answer",
        sdp: normalizeSdp(answer.record.payload.sdp),
      });
      try {
        await waitForChannelOpen(dc, LAN_HOST_CHANNEL_WAIT_MS, this.timers);
      } catch {
        this.lastStep = "host-channel-timeout";
        return;
      }
      if (this.stopped) return;
      session = new LanPeerSession(pc, dc);
      const record: LanHostSession = {
        session,
        dc,
      };
      this.hostSession = record;
      dc.addEventListener("close", () => {
        if (this.hostSession === record) this.closeHostSession("channel-closed");
        // Another session may still own the chip; the helper decides.
        this.syncPhaseFromSessions();
      });
      session.serveRequests(
        (serveRequest) => resolveLanServeFile(this.deps.serveGate, serveRequest),
        (sent, total) => {
          this.reportTransferProgress(sent, total);
        },
        (served) => {
          void (async () => {
            const route = await session!.getRouteType();
            this.log("served", "LAN serve complete", {
              result: "ok",
              bytes: served.size,
              elapsedMs: served.elapsedMs,
              route,
            });
          })();
        },
      );
      // Sender-side liveness: while this channel is idle between files the
      // receiver may disappear (backgrounded, Wi-Fi change). Pinging keeps the
      // session's health current so the next request does not start on a dead
      // channel, and a silent peer tears the session down early.
      this.startHostHeartbeat(record);
      this.lastStep = "host-ready";
      this.reportTransferPhase("connected");
      this.log("host-ready", "LAN auto connect host ready", {
        result: "ok",
        elapsedMs: this.timers.now() - startedAt,
      });
      void closeLanSignalSession(transport, {
        pairing,
        session: published.session,
        role: "host",
        status: "completed",
        now: this.timers.now(),
      }).catch(() => undefined)
        .then(() => this.cleanupStale(transport, pairing));
    } catch (error) {
      session?.close();
      try {
        pc?.close();
      } catch {
        // Already closed.
      }
      this.deps.log?.({
        step: "host-error",
        result: "error",
      }, `LAN host session failed: ${describeError(error)}`);
      this.lastStep = "host-error";
    } finally {
      // Every host handshake ends on this tick either with a live session
      // (`connected`) or with nothing to show (`null`); without this a failed
      // publish/answer timeout would leave the chip parked on "pairing".
      this.syncPhaseFromSessions();
    }
  }

  private closeHostSession(reason: string): void {
    const host = this.hostSession;
    if (host === null) return;
    this.hostSession = null;
    this.stopHostHeartbeat();
    host.session.close();
    this.lastStep = `host-closed:${reason}`;
    this.syncPhaseFromSessions();
    if (!this.stopped) this.scheduleWatcher(LAN_WATCHER_ACTIVE_INTERVAL_MS);
  }

  /**
   * Periodic liveness probe for the sender's open channel.
   *
   * One timer for the whole session, not one per file: the point is to notice a
   * peer that vanished between files. A silent peer closes the session so the
   * receiver's next request pays for a fresh handshake instead of stalling on a
   * dead channel.
   */
  private startHostHeartbeat(record: LanHostSession): void {
    this.stopHostHeartbeat();
    const tick = (): void => {
      this.hostHeartbeat = null;
      if (this.stopped || this.hostSession !== record) return;
      const health = record.session.getHealth(LAN_TRANSFER_SILENCE_MS);
      if (!health.healthy) {
        this.closeHostSession("peer-silent");
        return;
      }
      record.session.ping();
      this.hostHeartbeat = this.timers.setTimeout(
        tick,
        LAN_HEARTBEAT_INTERVAL_MS,
      );
    };
    this.hostHeartbeat = this.timers.setTimeout(
      tick,
      LAN_HEARTBEAT_INTERVAL_MS,
    );
  }

  private stopHostHeartbeat(): void {
    if (this.hostHeartbeat === null) return;
    this.timers.clearTimeout(this.hostHeartbeat);
    this.hostHeartbeat = null;
  }

  private closeAcquirerSession(reason: string): void {
    const acquirer = this.acquirerSession;
    if (acquirer === null) return;
    this.acquirerSession = null;
    acquirer.session.close();
    this.deps.clearSource();
    this.lastStep = `acquirer-closed:${reason}`;
    this.syncPhaseFromSessions();
  }

  /** True when either role currently owns an open-channel session record. */
  private hasLiveSession(): boolean {
    return this.hostSession !== null || this.acquirerSession !== null;
  }

  /**
   * Recompute the chip phase from what this manager actually owns.
   *
   * A live session (either role) is "connected"; a handshake in flight with no
   * session yet is "pairing"; otherwise there is nothing to show. Called after
   * every lifecycle edge so a channel close cannot leave a stale icon behind,
   * and skipped in favour of `null` once the manager is stopped.
   */
  private syncPhaseFromSessions(): void {
    if (this.stopped) {
      this.reportTransferPhase(null);
      return;
    }
    if (this.hostSession !== null || this.acquirerSession !== null) {
      this.reportTransferPhase("connected");
      return;
    }
    this.reportTransferPhase(this.acquireInFlight !== null ? "pairing" : null);
  }

  /** One chip phase report. The sink is display-only, so a throwing callback
   *  (a broken host hook) must never disturb the session itself. */
  private reportTransferPhase(phase: LanTransferPhase | null): void {
    if (phase === this.reportedPhase) return;
    this.reportedPhase = phase;
    try {
      this.deps.reportPhase?.(phase);
    } catch {
      // Display-only sink; the transfer never depends on it.
    }
  }

  /** One byte-progress report; same isolation as `reportTransferPhase`.
   *
   *  Bytes moving is itself the "transferring" phase, so the phase is reported
   *  here rather than guessed from a timer; the last callback of a payload
   *  returns the chip to "connected" while the channel stays open. */
  private reportTransferProgress(downloaded: number, total: number): void {
    if (!(downloaded > 0)) return;
    this.reportTransferPhase("transferring");
    try {
      this.deps.reportProgress?.(downloaded, total);
    } catch {
      // Display-only sink; the transfer never depends on it.
    }
    if (total > 0 && downloaded >= total) {
      this.reportTransferPhase("connected");
    }
  }

  /**
   * Publish only the candidates that are NOT already inside the sent SDP.
   *
   * The SDP is published after a full gather window, so the normal case is
   * "nothing to send": every candidate the peer needs is already in the SDP it
   * reads. Writing a candidate file anyway cost one cloud RTT per role per
   * handshake for no information. Only a candidate that appears after the SDP
   * snapshot (a path change mid-handshake) is worth a round trip, and that is
   * exactly what this publishes.
   *
   * Failures stay advisory: the SDP remains the authoritative copy.
   */
  private async pushCandidates(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
    session: LanSignalSession,
    role: "host" | "joiner",
    candidates: CandidateCollector,
    sdp: string,
  ): Promise<void> {
    const publish = async (values: string[]): Promise<void> => {
      const late = values.filter((candidate) => !sdp.includes(candidate));
      if (late.length === 0) return;
      try {
        await writeLanSignalCandidates(transport, {
          pairing,
          session,
          role,
          candidates: late,
          now: this.timers.now(),
        });
      } catch {
        // Advisory only.
      }
    };
    await publish(candidates.read());
    // One late flush catches a path change after the SDP snapshot.
    await this.timers.sleep(2_500);
    if (this.stopped) return;
    await publish(candidates.read());
  }

  private async pollPeerCandidates(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
    session: LanSignalSession,
    pc: RTCPeerConnection,
    role: "host" | "joiner",
    state: { applied: number },
  ): Promise<void> {
    const deadline = this.timers.now() + LAN_AUTO_CONNECT_CANDIDATE_WINDOW_MS;
    while (!this.stopped && this.timers.now() < deadline) {
      try {
        const read = await readLanSignalCandidates(transport, {
          pairing,
          session,
          role,
          now: this.timers.now(),
        });
        if (read.status === "ready" && read.record.type === "candidates") {
          const values = read.record.payload.candidates;
          for (const candidate of values.slice(state.applied)) {
            await addRemoteCandidate(pc, candidate);
          }
          state.applied = values.length;
        } else if (read.status === "closed" || read.status === "rejected") {
          return;
        }
      } catch {
        // The SDP snapshot remains the fallback.
      }
      await this.timers.sleep(CANDIDATE_POLL_MS);
    }
  }

  private async ensurePairing(
    transport: LanSignalTransport,
    create: boolean,
  ): Promise<LanPairingRecord | null> {
    if (this.pairing !== null && this.pairingVerified) return this.pairing;
    if (this.pairing !== null && await verifyLanPairingRecord(this.pairing)) {
      this.pairingVerified = true;
      return this.pairing;
    }
    this.pairing = null;
    this.pairingVerified = false;
    try {
      const cloud = await readLanPairing(transport);
      if (cloud.status === "ready") {
        this.pairing = cloud.record;
        this.pairingVerified = true;
        await this.saveLocalPairing(cloud.record);
        return cloud.record;
      }
      if (cloud.status === "invalid") return null;
      if (!create) return null;
      const provisioned = await provisionLanPairing(transport);
      if (provisioned.status !== "ready") return null;
      this.pairing = provisioned.record;
      this.pairingVerified = true;
      await this.saveLocalPairing(provisioned.record);
      return provisioned.record;
    } catch {
      return null;
    }
  }

  private async saveLocalPairing(record: LanPairingRecord): Promise<void> {
    if (this.deps.savePairing === undefined) return;
    try {
      await this.deps.savePairing(serializeLanPairingRecord(record));
    } catch {
      // The cloud copy is authoritative; the local one is only a cache.
    }
  }

  private async cleanupStale(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
  ): Promise<void> {
    try {
      await cleanupExpiredLanSignalSessions(transport, {
        pairing,
        maxSessions: 8,
      });
    } catch {
      // Best-effort; never blocks a session.
    }
  }

  /**
   * Serialize transfers over the single channel and drop the cached source as
   * soon as the channel is no longer open.
   */
  private wrapSource(
    source: LanContentSource,
    dc: RTCDataChannel,
    peer: LanPeerSession | null = null,
  ): LanContentSource {
    const run = <T>(task: () => Promise<T>): Promise<T> => {
      const next = this.transferChain.then(task);
      this.transferChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
    /**
     * Fail a transfer as soon as the peer provably stopped answering, instead
     * of waiting for SCTP's 30 s dead-connection timer. The caller then falls
     * back to the cloud within seconds; the session is torn down so the next
     * file re-acquires a fresh channel instead of reusing a half-dead one.
     */
    const guarded = <T>(task: () => Promise<T>): Promise<T> => run(async () => {
      if (peer !== null) {
        const health = peer.getHealth(LAN_TRANSFER_SILENCE_MS);
        if (!health.healthy) {
          this.closeAcquirerSession("peer-silent");
          throw new Error("LAN peer stopped responding");
        }
        peer.ping();
      }
      return task();
    });
    return {
      downloadFile: (hint, progress, signal) => guarded(() =>
        source.downloadFile(hint, progress, signal)),
      downloadFileToPath: (hint, localPath, adapter, progress, signal) =>
        guarded(() => source.downloadFileToPath(
          hint,
          localPath,
          adapter,
          progress,
          signal,
        )),
      getRouteType: async (): Promise<LanRouteType> => {
        if (dc.readyState !== "open" && this.acquirerSession !== null) {
          this.closeAcquirerSession("channel-not-open");
        }
        return source.getRouteType?.() ?? "unknown";
      },
    };
  }

  private createPeerConnection(): RTCPeerConnection {
    if (this.deps.createPeerConnection !== undefined) {
      return this.deps.createPeerConnection();
    }
    return new RTCPeerConnection({ iceServers: [] });
  }

  private log(
    step: string,
    message: string,
    details: Pick<LanAutoConnectLogEvent, "bytes" | "elapsedMs" | "result" | "route">,
  ): void {
    this.deps.log?.({
      step,
      ...details,
    }, message);
  }
}

interface LanHostSession {
  session: LanPeerSession;
  dc: RTCDataChannel;
}

interface LanAcquirerSession {
  session: LanPeerSession;
  dc: RTCDataChannel;
  source: LanContentSource;
}

interface CandidateCollector {
  read(): string[];
}

const defaultTimers: LanAutoConnectTimers = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => compatSetTimeout(handler, ms),
  clearTimeout: (handle) => compatClearTimeout(handle as number | null),
  sleep: (ms) => new Promise((resolve) => {
    compatSetTimeout(resolve, ms);
  }),
};

/**
 * How long a download may block on the handshake before using the cloud.
 *
 * Waiting only wins when the LAN copy would still finish earlier than the
 * cloud copy, and the cloud cost grows with size. Small files therefore get the
 * floor (fall back at once, let the background handshake finish) while files at
 * or above `LAN_ACQUIRE_WAIT_FULL_BYTES` may wait out the whole window. The
 * curve is deliberately linear and monotonic: no tuning knob, no per-file
 * special case, and the ceiling stays below the handshake deadline.
 */
export function acquireAwaitMs(fileSize: number): number {
  if (!Number.isFinite(fileSize) || fileSize <= 0) return LAN_ACQUIRE_AWAIT_MS;
  if (fileSize >= LAN_ACQUIRE_WAIT_FULL_BYTES) return LAN_ACQUIRE_WAIT_MAX_MS;
  const ratio = fileSize / LAN_ACQUIRE_WAIT_FULL_BYTES;
  return Math.round(
    LAN_ACQUIRE_AWAIT_MS
      + (LAN_ACQUIRE_WAIT_MAX_MS - LAN_ACQUIRE_AWAIT_MS) * ratio,
  );
}

function collectCandidates(pc: RTCPeerConnection): CandidateCollector {
  const values: string[] = [];
  pc.addEventListener("icecandidate", (event) => {
    const candidate = event.candidate?.candidate;
    if (typeof candidate === "string" && candidate.length > 0) {
      values.push(candidate);
    }
  });
  return {
    read: () => [...values],
  };
}

function createChannelPromise(): {
  resolve(channel: RTCDataChannel): void;
  wait(timeoutMs: number, timers: LanAutoConnectTimers): Promise<RTCDataChannel | null>;
} {
  let settled = false;
  let resolveValue: (channel: RTCDataChannel | null) => void = () => undefined;
  const promise = new Promise<RTCDataChannel | null>((resolve) => {
    resolveValue = resolve;
  });
  return {
    resolve: (channel) => {
      if (settled) return;
      settled = true;
      resolveValue(channel);
    },
    wait: (timeoutMs, timers) => {
      let timer: unknown = null;
      const timeout = new Promise<RTCDataChannel | null>((resolve) => {
        timer = timers.setTimeout(() => resolve(null), timeoutMs);
      });
      return Promise.race([promise, timeout]).finally(() => {
        if (timer !== null) timers.clearTimeout(timer);
      });
    },
  };
}

async function addRemoteCandidate(
  pc: RTCPeerConnection,
  candidate: string,
): Promise<void> {
  try {
    await pc.addIceCandidate({ candidate });
    return;
  } catch {
    // Fall through to an explicit data-channel m-line binding.
  }
  const mid = pc.getTransceivers?.()[0]?.mid ?? "0";
  try {
    await pc.addIceCandidate({ candidate, sdpMid: mid, sdpMLineIndex: 0 });
  } catch {
    // The early SDP snapshot remains the fallback.
  }
}


/**
 * Wait at most `timeoutMs` for early ICE gathering; the SDP snapshot taken
 * afterwards is complete enough because the candidate batches follow it.
 */
async function waitForIce(
  pc: RTCPeerConnection,
  timeoutMs: number,
  timers: LanAutoConnectTimers,
): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      pc.removeEventListener("icegatheringstatechange", onChange);
      if (timer !== null) timers.clearTimeout(timer);
      resolve();
    };
    const onChange = (): void => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = timers.setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

/** Wait for a data channel to open; a close or the deadline rejects. */
async function waitForChannelOpen(
  dc: RTCDataChannel,
  timeoutMs: number,
  timers: LanAutoConnectTimers,
): Promise<void> {
  if (dc.readyState === "open") return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      dc.removeEventListener("open", onOpen);
      dc.removeEventListener("close", onClose);
      if (timer !== null) timers.clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onOpen = (): void => finish();
    const onClose = (): void => finish(new Error("LAN data channel closed"));
    const timer = timers.setTimeout(
      () => finish(new Error("LAN data channel open timeout")),
      timeoutMs,
    );
    dc.addEventListener("open", onOpen);
    dc.addEventListener("close", onClose);
  });
}

/**
 * Await `promise` for at most `timeoutMs`, then resolve `undefined` without
 * cancelling the work. Timer-seam driven so tests stay deterministic.
 */
async function waitBounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timers: LanAutoConnectTimers,
): Promise<T | undefined> {
  let timer: unknown = null;
  const timeout = new Promise<undefined>((resolve) => {
    timer = timers.setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
  }
}
