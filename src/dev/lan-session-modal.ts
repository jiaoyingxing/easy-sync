/**
 * Dev-only LAN session modal (S2a data path, S2b2 cloud signaling).
 *
 * The default flow uses the same-account `.easy-sync` pairing/session records:
 * a host publishes an offer and waits for the joiner's answer, while the
 * joiner discovers the active session, answers, and injects a LAN content
 * source into the running OneDrive client. Manual SDP stays available only as
 * a diagnostic fallback. This is a test bridge, not product UI; it is not
 * shipped in the release line.
 */
import { App } from "obsidian";
import {
  describeError,
  hostPlatformFacts,
} from "../obsidian-compat";
import {
  addEasySyncFooterButton,
  bindModalKeyboardDismissal,
  createEasySyncModalFooter,
  EasySyncModal,
  keepModalFocusOnBody,
} from "../ui/easy-sync-modal";
import type { LanContentSource } from "../sync/lan-content-source";
import type { OneDriveClient } from "../onedrive/client";
import {
  createOneDriveLanSignalTransport,
  type LanSignalTransportOperation,
} from "../onedrive/lan-signal-transport";
import {
  cleanupExpiredLanSignalSessions,
  closeLanSignalSession,
  parseLanPairingRecord,
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
  type LanSignalCloseStatus,
  type LanSignalSession,
  type LanSignalTransport,
} from "../sync/lan-signaling";
import {
  LanPeerSession,
  createLanContentSource,
  normalizeSdp,
  waitForDataChannelOpen,
  waitForIceGathering,
  type LanServeRequest,
  type LanServeResult,
} from "./lan-session";

interface LanSessionHost {
  /** Localized strings: the modal has no user-visible hardcoded copy. */
  t(key: string, params?: Record<string, string | number>): string;
  resolveServeFile(
    request: LanServeRequest,
  ): Promise<LanServeResult | { error: string }>;
  injectSource(source: LanContentSource): boolean;
  startSync(): void;
  clearSource(): void;
  getOnedriveClient(): OneDriveClient | null;
  getVaultName(): string;
  loadLanPairingSecretRaw(): Promise<string | null>;
  saveLanPairingSecretRaw(value: string): Promise<void>;
  /** S5 throughput reading: one diagnostic line per completed transfer. */
  logServeComplete?(
    result: { path: string; bytes: number; contentMs: number },
  ): void;
  /** Sidebar chip phase: `null` when the session ends. Optional so a caller
   *  that only runs the modal (tests, older wiring) keeps its behaviour. */
  setLanPhase?(phase: "pairing" | "connected" | "transferring" | null): void;
  /** Byte progress of the transfer in flight, for the same chip's value slot. */
  reportLanProgress?(downloaded: number, total: number): void;
}

type Role = "sender" | "receiver";
type SignalMode = "cloud" | "manual";
type CloudRole = "host" | "joiner";

interface SignalStats {
  reads: number;
  writes: number;
  deletes: number;
  lists: number;
  errors: number;
  rateLimits: number;
  latencyTotalMs: number;
  latencyCount: number;
}

const CLOUD_POLL_TIMEOUT_MS = 60_000;
const CLOUD_POLL_INITIAL_MS = 500;
const CLOUD_POLL_MAX_MS = 2_000;
const CANDIDATE_POLL_DEADLINE_MS = 15_000;
const OFFER_POLL_TIMEOUT_MS = 10_000;
/** Early offer/answer: do not wait for full ICE gathering before signaling. */
const ICE_GATHER_WINDOW_MS = 500;
/** One late flush catches candidates gathered after the early SDP snapshot. */
const CANDIDATE_LATE_FLUSH_MS = 2_500;

export function openLanSessionModal(app: App, host: LanSessionHost): void {
  new LanSessionModal(app, host).open();
}

class LanSessionModal extends EasySyncModal<void> {
  private role: Role = "sender";
  private mode: SignalMode = "cloud";
  private cloudRole: CloudRole | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private session: LanPeerSession | null = null;
  private channelReady: Promise<RTCDataChannel> | null = null;
  private channelReadyResolve: ((dc: RTCDataChannel) => void) | null = null;
  private keyboardDisposer: (() => void) | null = null;

  private statusEl!: HTMLElement;
  private signalStatsEl!: HTMLElement;
  private senderPanel!: HTMLElement;
  private receiverPanel!: HTMLElement;
  private cloudSenderPanel!: HTMLElement;
  private cloudReceiverPanel!: HTMLElement;
  private manualSenderPanel!: HTMLElement;
  private manualReceiverPanel!: HTMLElement;
  private offerOut!: HTMLTextAreaElement;
  private answerIn!: HTMLTextAreaElement;
  private offerIn!: HTMLTextAreaElement;
  private answerOut!: HTMLTextAreaElement;
  private roleSenderButton!: HTMLButtonElement;
  private roleReceiverButton!: HTMLButtonElement;
  private modeCloudButton!: HTMLButtonElement;
  private modeManualButton!: HTMLButtonElement;
  private cloudPublishButton!: HTMLButtonElement;
  private cloudHostCancelButton!: HTMLButtonElement;
  private cloudJoinButton!: HTMLButtonElement;
  private cloudJoinerCancelButton!: HTMLButtonElement;
  private cloudStartSyncButton!: HTMLButtonElement;
  private manualStartSyncButton!: HTMLButtonElement;

  private signalTransport: LanSignalTransport | null = null;
  private pairing: LanPairingRecord | null = null;
  private signalSession: LanSignalSession | null = null;
  private cloudAbort: AbortController | null = null;
  private cloudSignalClosed = false;
  private candidateWriteChain: Promise<void> = Promise.resolve();
  private iceCandidates: string[] = [];
  private stats: SignalStats = emptyStats();

  constructor(app: App, private readonly host: LanSessionHost) {
    super(app);
  }

  private t(key: string, params?: Record<string, string | number>): string {
    return this.host.t(key, params);
  }

  onOpen(): void {
    this.modalEl.addClass("easy-sync-modal-wide");
    this.titleEl.setText(this.t("lanSession.title"));
    this.contentEl.empty();

    const body = this.contentEl.createDiv({ cls: "easy-sync-lan-session-body" });
    body.createEl("p", { cls: "setting-item-description" }).setText(
      this.t("lanSession.intro"),
    );

    const roleRow = body.createDiv({ cls: "easy-sync-lan-session-role-row" });
    this.roleSenderButton = roleRow.createEl("button", {
      text: this.t("lanSession.role.sender"),
    });
    this.roleReceiverButton = roleRow.createEl("button", {
      text: this.t("lanSession.role.receiver"),
    });
    this.roleSenderButton.id = "lan-session-role-sender";
    this.roleReceiverButton.id = "lan-session-role-receiver";
    this.roleSenderButton.addEventListener("click", () => this.setRole("sender"));
    this.roleReceiverButton.addEventListener("click", () => this.setRole("receiver"));

    const modeRow = body.createDiv({ cls: "easy-sync-lan-session-role-row" });
    this.modeCloudButton = modeRow.createEl("button", {
      text: this.t("lanSession.mode.cloud"),
    });
    this.modeManualButton = modeRow.createEl("button", {
      text: this.t("lanSession.mode.manual"),
    });
    this.modeCloudButton.id = "lan-session-mode-cloud";
    this.modeManualButton.id = "lan-session-mode-manual";
    this.modeCloudButton.addEventListener("click", () => this.setMode("cloud"));
    this.modeManualButton.addEventListener("click", () => this.setMode("manual"));

    this.statusEl = body.createDiv({
      cls: "setting-item-description easy-sync-lan-session-status",
    });
    this.statusEl.id = "lan-session-status";
    this.signalStatsEl = body.createDiv({
      cls: "setting-item-description easy-sync-lan-session-status",
    });
    this.signalStatsEl.id = "lan-signal-stats";
    this.renderStats();

    this.senderPanel = body.createDiv();
    this.buildSenderPanel(this.senderPanel);
    this.receiverPanel = body.createDiv();
    this.buildReceiverPanel(this.receiverPanel);

    const footer = createEasySyncModalFooter(this.contentEl, { divided: true });
    addEasySyncFooterButton(footer, {
      label: this.t("lanSession.close"),
      variant: "plain",
      onClick: () => this.close(),
    });

    this.keyboardDisposer = bindModalKeyboardDismissal(this);
    this.setRole(hostPlatformFacts.isMobileApp ? "receiver" : "sender");
    this.setMode("cloud");
    keepModalFocusOnBody(this);
  }

  onClose(): void {
    this.keyboardDisposer?.();
    this.keyboardDisposer = null;
    void this.abortCloud("aborted");
    this.resetWebRtc();
    this.contentEl.empty();
    super.onClose();
  }

  private buildSenderPanel(parent: HTMLElement): void {
    this.cloudSenderPanel = parent.createDiv();
    this.buildCloudSenderPanel(this.cloudSenderPanel);
    this.manualSenderPanel = parent.createEl("details", {
      cls: "easy-sync-lan-session-manual",
    });
    this.manualSenderPanel.createEl("summary", {
      text: this.t("lanSession.manual.summary"),
    });
    this.buildManualSenderPanel(this.manualSenderPanel);
  }

  private buildReceiverPanel(parent: HTMLElement): void {
    this.cloudReceiverPanel = parent.createDiv();
    this.buildCloudReceiverPanel(this.cloudReceiverPanel);
    this.manualReceiverPanel = parent.createEl("details", {
      cls: "easy-sync-lan-session-manual",
    });
    this.manualReceiverPanel.createEl("summary", {
      text: this.t("lanSession.manual.summary"),
    });
    this.buildManualReceiverPanel(this.manualReceiverPanel);
  }

  private buildCloudSenderPanel(parent: HTMLElement): void {
    parent.createEl("h3", { text: this.t("lanSession.cloud.sender.heading") });
    parent.createEl("p", {
      text: this.t("lanSession.cloud.sender.desc"),
      cls: "setting-item-description",
    });
    this.cloudPublishButton = parent.createEl("button", {
      text: this.t("lanSession.cloud.sender.publish"),
      cls: "mod-cta",
    });
    this.cloudPublishButton.id = "lan-cloud-publish";
    this.cloudPublishButton.addEventListener("click", () => {
      void this.cloudHostPublish();
    });
    this.cloudHostCancelButton = parent.createEl("button", {
      text: this.t("lanSession.cloud.sender.cancel"),
    });
    this.cloudHostCancelButton.id = "lan-cloud-host-cancel";
    this.cloudHostCancelButton.disabled = true;
    this.cloudHostCancelButton.addEventListener("click", () => {
      void this.cancelCloud();
    });
  }

  private buildCloudReceiverPanel(parent: HTMLElement): void {
    parent.createEl("h3", { text: this.t("lanSession.cloud.receiver.heading") });
    parent.createEl("p", {
      text: this.t("lanSession.cloud.receiver.desc"),
      cls: "setting-item-description",
    });
    this.cloudJoinButton = parent.createEl("button", {
      text: this.t("lanSession.cloud.receiver.join"),
      cls: "mod-cta",
    });
    this.cloudJoinButton.id = "lan-cloud-join";
    this.cloudJoinButton.addEventListener("click", () => {
      void this.cloudJoinerJoin();
    });
    this.cloudJoinerCancelButton = parent.createEl("button", {
      text: this.t("lanSession.cloud.receiver.cancel"),
    });
    this.cloudJoinerCancelButton.id = "lan-cloud-joiner-cancel";
    this.cloudJoinerCancelButton.disabled = true;
    this.cloudJoinerCancelButton.addEventListener("click", () => {
      void this.cancelCloud();
    });
    this.cloudStartSyncButton = parent.createEl("button", {
      text: this.t("lanSession.cloud.receiver.start"),
    });
    this.cloudStartSyncButton.id = "lan-cloud-start-sync";
    this.cloudStartSyncButton.disabled = true;
    this.cloudStartSyncButton.addEventListener("click", () => {
      this.host.startSync();
      this.setStatus(this.t("lanSession.status.syncStarted"));
    });
  }

  private buildManualSenderPanel(parent: HTMLElement): void {
    parent.createEl("p", {
      text: this.t("lanSession.manual.sender.desc"),
      cls: "setting-item-description",
    });

    const generateButton = parent.createEl("button", {
      text: this.t("lanSession.manual.sender.generateOffer"),
      cls: "mod-cta",
    });
    generateButton.id = "lan-session-generate-offer";
    generateButton.addEventListener("click", () => {
      void this.generateOffer();
    });

    parent.createEl("p", {
      text: this.t("lanSession.manual.sender.offerLabel"),
      cls: "setting-item-description",
    });
    this.offerOut = this.createTextArea(parent, 4, true);
    this.offerOut.id = "lan-session-offer-out";
    const copyOfferButton = parent.createEl("button", {
      text: this.t("lanSession.manual.sender.copyOffer"),
    });
    copyOfferButton.id = "lan-session-copy-offer";
    copyOfferButton.addEventListener("click", () => {
      void this.copyText(
        this.offerOut.value,
        this.t("lanSession.copyLabel.offer"),
      );
    });

    parent.createEl("p", {
      text: this.t("lanSession.manual.sender.answerLabel"),
      cls: "setting-item-description",
    });
    this.answerIn = this.createTextArea(parent, 4, false);
    this.answerIn.id = "lan-session-answer-in";
    const connectButton = parent.createEl("button", {
      text: this.t("lanSession.manual.sender.connect"),
      cls: "mod-cta",
    });
    connectButton.id = "lan-session-connect";
    connectButton.addEventListener("click", () => {
      void this.senderConnect();
    });
  }

  private buildManualReceiverPanel(parent: HTMLElement): void {
    parent.createEl("p", {
      text: this.t("lanSession.manual.receiver.desc"),
      cls: "setting-item-description",
    });
    this.offerIn = this.createTextArea(parent, 4, false);
    this.offerIn.id = "lan-session-offer-in";
    const answerButton = parent.createEl("button", {
      text: this.t("lanSession.manual.receiver.generateAnswer"),
      cls: "mod-cta",
    });
    answerButton.id = "lan-session-generate-answer";
    answerButton.addEventListener("click", () => {
      void this.generateAnswer();
    });

    parent.createEl("p", {
      text: this.t("lanSession.manual.receiver.answerLabel"),
      cls: "setting-item-description",
    });
    this.answerOut = this.createTextArea(parent, 4, true);
    this.answerOut.id = "lan-session-answer-out";
    const copyAnswerButton = parent.createEl("button", {
      text: this.t("lanSession.manual.receiver.copyAnswer"),
    });
    copyAnswerButton.id = "lan-session-copy-answer";
    copyAnswerButton.addEventListener("click", () => {
      void this.copyText(
        this.answerOut.value,
        this.t("lanSession.copyLabel.answer"),
      );
    });

    const injectButton = parent.createEl("button", {
      text: this.t("lanSession.manual.receiver.inject"),
      cls: "mod-cta",
    });
    injectButton.id = "lan-session-inject";
    injectButton.addEventListener("click", () => {
      void this.receiverInject();
    });
    this.manualStartSyncButton = parent.createEl("button", {
      text: this.t("lanSession.cloud.receiver.start"),
    });
    this.manualStartSyncButton.id = "lan-session-start-sync";
    this.manualStartSyncButton.disabled = true;
    this.manualStartSyncButton.addEventListener("click", () => {
      this.host.startSync();
      this.setStatus(this.t("lanSession.status.syncStarted"));
    });
  }

  private createTextArea(
    parent: HTMLElement,
    rows: number,
    readOnly: boolean,
  ): HTMLTextAreaElement {
    const textArea = parent.createEl("textarea", {
      cls: "easy-sync-lan-session-textarea",
    });
    textArea.rows = rows;
    textArea.readOnly = readOnly;
    textArea.spellcheck = false;
    return textArea;
  }

  private setRole(role: Role): void {
    if (
      this.role !== role
      && (this.signalSession !== null || this.session !== null)
    ) {
      void this.abortCloud("aborted");
    }
    this.role = role;
    this.senderPanel.classList.toggle(
      "easy-sync-lan-session-hidden",
      role !== "sender",
    );
    this.receiverPanel.classList.toggle(
      "easy-sync-lan-session-hidden",
      role !== "receiver",
    );
    this.roleSenderButton.classList.toggle("mod-cta", role === "sender");
    this.roleReceiverButton.classList.toggle("mod-cta", role === "receiver");
    this.setStatus(this.t(
      role === "sender"
        ? "lanSession.status.senderHint"
        : "lanSession.status.receiverHint",
    ));
  }

  private setMode(mode: SignalMode): void {
    if (
      this.mode !== mode
      && (this.signalSession !== null || this.session !== null)
    ) {
      void this.abortCloud("aborted");
    }
    this.mode = mode;
    const cloud = mode === "cloud";
    this.cloudSenderPanel.classList.toggle("easy-sync-lan-session-hidden", !cloud);
    this.cloudReceiverPanel.classList.toggle("easy-sync-lan-session-hidden", !cloud);
    this.manualSenderPanel.classList.toggle("easy-sync-lan-session-hidden", cloud);
    this.manualReceiverPanel.classList.toggle("easy-sync-lan-session-hidden", cloud);
    this.modeCloudButton.classList.toggle("mod-cta", cloud);
    this.modeManualButton.classList.toggle("mod-cta", !cloud);
    this.setStatus(this.t(
      cloud
        ? "lanSession.status.modeCloud"
        : "lanSession.status.modeManual",
    ));
  }

  private async cloudHostPublish(): Promise<void> {
    this.cloudPublishButton.disabled = true;
    this.cloudHostCancelButton.disabled = false;
    try {
      await this.abortCloud("aborted");
      this.beginCloudRun();
      const transport = this.requireSignalTransport();
      const pairing = await this.ensurePairing(transport, true);
      this.pairing = pairing;

      this.setStatus(this.t("lanSession.status.pairingReady"));
      const pc = this.createPeerConnection();
      const dc = pc.createDataChannel("easy-sync-lan-session", { ordered: true });
      this.dc = dc;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const gathering = await waitForIceGathering(pc, ICE_GATHER_WINDOW_MS);
      if (this.isCloudAborted()) {
        await this.closeCloudSignal("aborted");
        return;
      }
      const sdp = pc.localDescription?.sdp ?? "";
      if (sdp.length === 0) {
        throw new Error(this.t("lanSession.error.offerSdpEmpty"));
      }

      const published = await publishLanSignalOffer(transport, {
        pairing,
        sdp,
        now: Date.now(),
      });
      if (this.isCloudAborted()) {
        await this.closeCloudSignal("aborted");
        return;
      }
      if (published.status === "busy") {
        throw new Error(this.t("lanSession.error.activeSession"));
      }
      if (published.status === "conflict") {
        throw new Error(this.t("lanSession.error.publishConflict"));
      }
      if (published.status === "rejected") {
        throw new Error(this.t("lanSession.error.publishRejected", {
          reason: published.reason,
        }));
      }
      this.signalSession = published.session;
      this.cloudRole = "host";
      this.cloudSignalClosed = false;
      this.setStatus(this.t("lanSession.status.offerPublished", {
        session: shortSession(published.session),
        ice: this.t(gathering === "complete"
          ? "lanSession.ice.complete"
          : "lanSession.ice.short"),
      }));
      this.queueLocalCandidates(
        transport,
        pairing,
        published.session,
        "host",
      );
      this.scheduleLateCandidateFlush(
        transport,
        pairing,
        published.session,
        "host",
      );

      const answer = await this.waitForHostAnswer(
        transport,
        pairing,
        published.session,
      );
      if (answer === null) {
        if (this.isCloudAborted()) return;
        this.setStatus(this.t("lanSession.status.waitAnswerTimeout"));
        await this.closeCloudSignal("failed");
        return;
      }
      await this.connectHost(transport, pairing, published.session, pc, dc, answer);
    } catch (error) {
      if (this.isCloudAborted()) return;
      await this.failCloud(this.t("lanSession.label.host"), error);
    } finally {
      this.cloudPublishButton.disabled = false;
      this.cloudHostCancelButton.disabled = true;
    }
  }

  private async cloudJoinerJoin(): Promise<void> {
    this.cloudJoinButton.disabled = true;
    this.cloudJoinerCancelButton.disabled = false;
    try {
      await this.abortCloud("aborted");
      this.beginCloudRun();
      const transport = this.requireSignalTransport();
      const pairing = await this.ensurePairing(transport, false);
      this.pairing = pairing;

      this.setStatus(this.t("lanSession.status.findingOffer"));
      const active = await pollLanSignal(async () => {
        const read = await readLanSignalActiveSession(transport, {
          pairing,
          now: Date.now(),
        });
        if (read.status === "none" || read.status === "expired") return null;
        if (read.status === "rejected") {
          throw new Error(this.t("lanSession.error.activeInvalid", {
            reason: read.reason,
          }));
        }
        return read;
      }, {
        timeoutMs: CLOUD_POLL_TIMEOUT_MS,
        initialIntervalMs: CLOUD_POLL_INITIAL_MS,
        maxIntervalMs: CLOUD_POLL_MAX_MS,
        signal: this.cloudAbort?.signal,
      });
      if (active === null) {
        if (this.isCloudAborted()) return;
        throw new Error(this.t("lanSession.error.waitOfferTimeout"));
      }

      this.setStatus(this.t("lanSession.status.offerFound"));
      const offer = await pollLanSignal(async () => {
        const read = await readLanSignalOffer(transport, {
          pairing,
          session: active.session,
          now: Date.now(),
          activeSession: active.session,
        });
        if (read.status === "pending") return null;
        if (read.status === "closed") {
          throw new Error(this.t("lanSession.error.offerClosed", {
            status: read.closeStatus,
          }));
        }
        if (read.status === "rejected") {
          throw new Error(this.t("lanSession.error.offerValidation", {
            reason: read.reason,
          }));
        }
        return read;
      }, {
        timeoutMs: OFFER_POLL_TIMEOUT_MS,
        initialIntervalMs: 250,
        maxIntervalMs: 1_000,
        signal: this.cloudAbort?.signal,
      });
      if (offer === null) {
        if (this.isCloudAborted()) return;
        throw new Error(this.t("lanSession.error.offerWriteTimeout"));
      }
      if (offer.record.type !== "offer") {
        throw new Error(this.t("lanSession.error.offerType"));
      }

      const pc = this.createPeerConnection();
      this.channelReady = new Promise((resolve) => {
        this.channelReadyResolve = resolve;
      });
      pc.ondatachannel = (event) => {
        this.dc = event.channel;
        this.channelReadyResolve?.(event.channel);
        this.channelReadyResolve = null;
      };
      await pc.setRemoteDescription({
        type: "offer",
        sdp: normalizeSdp(offer.record.payload.sdp),
      });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const gathering = await waitForIceGathering(pc, ICE_GATHER_WINDOW_MS);
      if (this.isCloudAborted()) {
        await this.closeCloudSignal("aborted");
        return;
      }
      const sdp = pc.localDescription?.sdp ?? "";
      if (sdp.length === 0) {
        throw new Error(this.t("lanSession.error.answerSdpEmpty"));
      }

      const written = await writeLanSignalAnswer(transport, {
        pairing,
        session: active.session,
        sdp,
        now: Date.now(),
        activeSession: active.session,
      });
      if (this.isCloudAborted()) {
        await this.closeCloudSignal("aborted");
        return;
      }
      if (written.status === "rejected") {
        throw new Error(this.t("lanSession.error.answerRejected", {
          reason: written.reason,
        }));
      }
      if (written.status === "already-answered") {
        throw new Error(this.t("lanSession.error.alreadyAnswered"));
      }
      this.signalSession = active.session;
      this.cloudRole = "joiner";
      this.cloudSignalClosed = false;
      this.setStatus(this.t("lanSession.status.answerPublished", {
        session: shortSession(active.session),
        ice: this.t(gathering === "complete"
          ? "lanSession.ice.complete"
          : "lanSession.ice.short"),
      }));
      this.queueLocalCandidates(
        transport,
        pairing,
        active.session,
        "joiner",
      );
      this.scheduleLateCandidateFlush(
        transport,
        pairing,
        active.session,
        "joiner",
      );
      void this.pollPeerCandidates(
        transport,
        pairing,
        active.session,
        pc,
        "host",
        this.cloudAbort?.signal,
      );

      const dc = await this.awaitDataChannel(active.session);
      await waitForDataChannelOpen(dc, 20_000);
      this.session = new LanPeerSession(pc, dc);
      const source = createLanContentSource(this.session, (downloaded, total) => {
        this.host.reportLanProgress?.(downloaded, total);
        this.setStatus(this.t("lanSession.status.receiving", {
          downloaded,
          total,
        }));
      });
      if (!this.host.injectSource(source)) {
        this.session.close();
        throw new Error(this.t("lanSession.error.clientNotReady"));
      }
      this.cloudStartSyncButton.disabled = false;
      // Channel open and source injected: the next event is a peer request.
      this.setLanPhase("connected");
      this.setStatus(this.t("lanSession.status.receiverReady"));
      void this.closeCloudSignal("completed")
        .then(() => this.cleanupStale(transport, pairing));
    } catch (error) {
      if (this.isCloudAborted()) return;
      await this.failCloud(this.t("lanSession.label.joiner"), error);
    } finally {
      this.cloudJoinButton.disabled = false;
      this.cloudJoinerCancelButton.disabled = true;
    }
  }

  private async waitForHostAnswer(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
    session: LanSignalSession,
  ): Promise<Awaited<ReturnType<typeof readLanSignalAnswer>> | null> {
    const timeoutMs = Math.max(1_000, session.expiresAt - Date.now());
    let attempts = 0;
    return pollLanSignal(async () => {
      attempts += 1;
      // Fast path: one control read per attempt; the terminal marker is
      // checked every fourth attempt instead of doubling every poll.
      const read = await readLanSignalAnswer(transport, {
        pairing,
        session,
        now: Date.now(),
        skipCloseCheck: attempts % 4 !== 0,
      });
      if (read.status === "pending") return null;
      if (read.status === "closed") {
        throw new Error(this.t("lanSession.error.answerClosed", {
          status: read.closeStatus,
        }));
      }
      if (read.status === "rejected") {
        throw new Error(this.t("lanSession.error.answerValidation", {
          reason: read.reason,
        }));
      }
      return read;
    }, {
      timeoutMs,
      initialIntervalMs: CLOUD_POLL_INITIAL_MS,
      maxIntervalMs: CLOUD_POLL_MAX_MS,
      signal: this.cloudAbort?.signal,
    });
  }

  private async connectHost(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
    session: LanSignalSession,
    pc: RTCPeerConnection,
    dc: RTCDataChannel,
    answer: Awaited<ReturnType<typeof readLanSignalAnswer>>,
  ): Promise<void> {
    if (answer?.status !== "ready") return;
    if (answer.record.type !== "answer") return;
    await pc.setRemoteDescription({
      type: "answer",
      sdp: normalizeSdp(answer.record.payload.sdp),
    });
    this.setStatus(this.t("lanSession.status.answerReceived"));
    void this.pollPeerCandidates(
      transport,
      pairing,
      session,
      pc,
      "joiner",
      this.cloudAbort?.signal,
    );
    await waitForDataChannelOpen(dc, 20_000);
    this.session = new LanPeerSession(pc, dc);
    this.session.serveRequests(
      async (request) => {
        const result = await this.host.resolveServeFile(request);
        if ("error" in result) {
          this.setStatus(this.t("lanSession.status.refusedPath", {
            path: request.path,
            error: result.error,
          }));
        } else {
          this.setStatus(this.t("lanSession.status.servingPath", {
            path: request.path,
            bytes: result.bytes.byteLength,
          }));
        }
        return result;
      },
      (sent, total) => {
        this.host.reportLanProgress?.(sent, total);
        this.setStatus(this.t("lanSession.status.sending", { sent, total }));
      },
      (served) => {
        // The transfer duration belongs next to the byte count: a real device
        // run then yields a throughput reading without a separate probe.
        this.host.logServeComplete?.({
          path: served.path,
          bytes: served.size,
          contentMs: served.elapsedMs,
        });
        this.setStatus(this.t("lanSession.status.servedPath", {
          path: served.path,
          bytes: served.size,
          seconds: (served.elapsedMs / 1000).toFixed(2),
          mibPerSecond: served.elapsedMs > 0
            ? (served.size / 1024 / 1024 / (served.elapsedMs / 1000)).toFixed(2)
            : "0.00",
        }));
      },
    );
    // Channel open, serve handler armed: waiting for the receiver's request.
    this.setLanPhase("connected");
    this.setStatus(this.t("lanSession.status.connected"));
    void this.closeCloudSignal("completed")
      .then(() => this.cleanupStale(transport, pairing));
  }

  private async pollPeerCandidates(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
    session: LanSignalSession,
    pc: RTCPeerConnection,
    role: "host" | "joiner",
    signal?: AbortSignal,
  ): Promise<void> {
    let applied = 0;
    const deadline = Date.now() + Math.min(
      CANDIDATE_POLL_DEADLINE_MS,
      Math.max(1_000, session.expiresAt - Date.now()),
    );
    while (Date.now() < deadline && signal?.aborted !== true) {
      try {
        const read = await readLanSignalCandidates(transport, {
          pairing,
          session,
          role,
          now: Date.now(),
        });
        if (read.status === "ready" && read.record.type === "candidates") {
          const candidates = read.record.payload.candidates;
          for (const candidate of candidates.slice(applied)) {
            await this.addRemoteCandidate(pc, candidate);
          }
          applied = candidates.length;
        } else if (read.status === "closed" || read.status === "rejected") {
          return;
        }
      } catch {
        // Candidate records are advisory; SDP carries the full ICE set.
      }
      await delay(500);
    }
  }

  private async addRemoteCandidate(
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
      await pc.addIceCandidate({
        candidate,
        sdpMid: mid,
        sdpMLineIndex: 0,
      });
    } catch {
      // The early SDP snapshot remains the fallback.
    }
  }

  private queueLocalCandidates(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
    session: LanSignalSession,
    role: "host" | "joiner",
  ): void {
    this.candidateWriteChain = this.candidateWriteChain
      .catch(() => undefined)
      .then(() => this.writeLocalCandidates(transport, pairing, session, role))
      .catch(() => undefined);
  }

  private scheduleLateCandidateFlush(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
    session: LanSignalSession,
    role: "host" | "joiner",
  ): void {
    window.setTimeout(() => {
      if (this.isCloudAborted()) return;
      this.queueLocalCandidates(transport, pairing, session, role);
    }, CANDIDATE_LATE_FLUSH_MS);
  }

  private async writeLocalCandidates(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
    session: LanSignalSession,
    role: "host" | "joiner",
  ): Promise<void> {
    if (this.isCloudAborted() || this.iceCandidates.length === 0) return;
    try {
      const result = await writeLanSignalCandidates(transport, {
        pairing,
        session,
        role,
        candidates: [...this.iceCandidates],
        now: Date.now(),
      });
      if (result.status === "written" && !this.isCloudAborted()) {
        this.setStatus(this.t("lanSession.status.candidatesPublished", {
          count: result.count,
        }));
      }
    } catch {
      // Non-trickle SDP already contains these candidates.
    }
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    this.iceCandidates = [];
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate?.candidate) {
        this.iceCandidates.push(event.candidate.candidate);
      }
    });
    return pc;
  }

  private async awaitDataChannel(
    session: LanSignalSession,
  ): Promise<RTCDataChannel> {
    if (this.channelReady === null) {
      throw new Error(this.t("lanSession.error.dcNotInitialized"));
    }
    const timeoutMs = Math.min(
      20_000,
      Math.max(1_000, session.expiresAt - Date.now()),
    );
    return Promise.race([
      this.channelReady,
      new Promise<never>((_resolve, reject) => {
        window.setTimeout(
          () => reject(new Error(this.t("lanSession.error.dcTimeout"))),
          timeoutMs,
        );
      }),
    ]);
  }

  private requireSignalTransport(): LanSignalTransport {
    if (this.signalTransport !== null) return this.signalTransport;
    const client = this.host.getOnedriveClient();
    if (client === null) {
      throw new Error(this.t("lanSession.error.clientNotReady"));
    }
    this.signalTransport = createOneDriveLanSignalTransport(
      client,
      this.host.getVaultName(),
      {
        onOperation: (event) => this.recordSignalOperation(event),
      },
    );
    return this.signalTransport;
  }

  private async ensurePairing(
    transport: LanSignalTransport,
    create: boolean,
  ): Promise<LanPairingRecord> {
    // The local copy is a cache only; the cloud record is the authority.
    // Reusing an in-memory record is safe only after this modal has verified
    // or provisioned the cloud copy once, so a stale SecretStorage entry from
    // another vault/device cannot silently become the room key.
    if (
      this.pairing !== null
      && await verifyLanPairingRecord(this.pairing)
    ) {
      return this.pairing;
    }
    const cloud = await readLanPairing(transport);
    if (cloud.status === "ready") {
      await this.saveLocalPairing(cloud.record);
      return cloud.record;
    }
    if (cloud.status === "invalid") {
      throw new Error(this.t("lanSession.error.pairingCorrupt"));
    }
    if (!create) {
      this.setStatus(this.t("lanSession.status.waitingPairing"));
      const waited = await pollLanSignal(async () => {
        const read = await readLanPairing(transport);
        if (read.status === "ready") return read;
        if (read.status === "invalid") {
          throw new Error(this.t("lanSession.error.pairingCorrupt"));
        }
        return null;
      }, {
        timeoutMs: CLOUD_POLL_TIMEOUT_MS,
        initialIntervalMs: CLOUD_POLL_INITIAL_MS,
        maxIntervalMs: CLOUD_POLL_MAX_MS,
        signal: this.cloudAbort?.signal,
      });
      if (this.isCloudAborted()) {
        throw new Error(this.t("lanSession.error.cancelled"));
      }
      if (waited !== null) {
        await this.saveLocalPairing(waited.record);
        return waited.record;
      }
      // A local-only record is not accepted here: the sender may have rotated
      // the room or the record may belong to another vault. Without a cloud
      // record the receiver has no way to prove which room the offer used.
      throw new Error(this.t("lanSession.error.noPairing"));
    }
    const provisioned = await provisionLanPairing(transport);
    if (provisioned.status !== "ready") {
      throw new Error(this.t(
        provisioned.status === "invalid-existing"
          ? "lanSession.error.pairingCorrupt"
          : "lanSession.error.pairingCreate",
      ));
    }
    await this.saveLocalPairing(provisioned.record);
    return provisioned.record;
  }

  private async loadLocalPairing(): Promise<LanPairingRecord | null> {
    try {
      const raw = await this.host.loadLanPairingSecretRaw();
      if (raw === null) return null;
      const record = parseLanPairingRecord(raw);
      if (record === null || !(await verifyLanPairingRecord(record))) {
        return null;
      }
      return record;
    } catch {
      return null;
    }
  }

  private async saveLocalPairing(record: LanPairingRecord): Promise<void> {
    try {
      await this.host.saveLanPairingSecretRaw(
        serializeLanPairingRecord(record),
      );
    } catch {
      // SecretStorage is the caller-owned copy; the cloud record still works.
    }
  }

  private async cleanupStale(
    transport: LanSignalTransport,
    pairing: LanPairingRecord,
  ): Promise<void> {
    try {
      await cleanupExpiredLanSignalSessions(transport, {
        pairing,
        maxSessions: 32,
      });
    } catch {
      // Cleanup is best-effort; a failed sweep must not block this session.
    }
  }

  private beginCloudRun(): void {
    this.cloudSignalClosed = false;
    this.cloudAbort = new AbortController();
    this.stats = emptyStats();
    this.renderStats();
    this.cloudStartSyncButton.disabled = true;
    // The sidebar chip's LAN phase starts here: everything until the data
    // channel opens is pairing (pairing record, offer/answer, ICE).
    this.setLanPhase("pairing");
  }

  /** Sidebar chip phase (single authority: the host's activity sampler). */
  private setLanPhase(
    phase: "pairing" | "connected" | "transferring" | null,
  ): void {
    this.host.setLanPhase?.(phase);
  }

  private async closeCloudSignal(status: LanSignalCloseStatus): Promise<void> {
    if (this.cloudSignalClosed) return;
    this.cloudSignalClosed = true;
    this.cloudAbort?.abort();
    try {
      await this.candidateWriteChain;
    } catch {
      // The terminal cleanup below is the authority.
    }
    const transport = this.signalTransport;
    const pairing = this.pairing;
    const session = this.signalSession;
    const role = this.cloudRole;
    if (transport !== null && pairing !== null && session !== null && role !== null) {
      try {
        await closeLanSignalSession(transport, {
          pairing,
          session,
          role,
          status,
          now: Date.now(),
        });
      } catch {
        // The terminal record and TTL cleanup are best-effort at this layer.
      }
    }
    this.signalSession = null;
    this.cloudRole = null;
  }

  private async cancelCloud(): Promise<void> {
    await this.abortCloud("aborted");
    this.setStatus(this.t("lanSession.status.cancelled"));
  }

  private async abortCloud(status: LanSignalCloseStatus): Promise<void> {
    this.cloudAbort?.abort();
    await this.closeCloudSignal(status);
    this.resetWebRtc();
  }

  private isCloudAborted(): boolean {
    return this.cloudAbort?.signal.aborted === true;
  }

  private async failCloud(label: string, error: unknown): Promise<void> {
    await this.closeCloudSignal("failed");
    if (this.signalTransport !== null && this.pairing !== null) {
      void this.cleanupStale(this.signalTransport, this.pairing);
    }
    this.resetWebRtc();
    this.setStatus(this.t("lanSession.status.failed", {
      label,
      error: describeError(error),
    }));
  }

  private recordSignalOperation(event: LanSignalTransportOperation): void {
    if (event.method === "read") this.stats.reads += 1;
    else if (event.method === "write") this.stats.writes += 1;
    else if (event.method === "delete") this.stats.deletes += 1;
    else this.stats.lists += 1;
    if (event.outcome === "error") this.stats.errors += 1;
    if (event.statusCode === 429) this.stats.rateLimits += 1;
    this.stats.latencyTotalMs += event.latencyMs;
    this.stats.latencyCount += 1;
    this.renderStats();
  }

  private renderStats(): void {
    if (!this.signalStatsEl) return;
    const average = this.stats.latencyCount === 0
      ? 0
      : Math.round(this.stats.latencyTotalMs / this.stats.latencyCount);
    this.signalStatsEl.setText(this.t("lanSession.stats", {
      reads: this.stats.reads,
      writes: this.stats.writes,
      deletes: this.stats.deletes,
      lists: this.stats.lists,
      errors: this.stats.errors,
      rateLimits: this.stats.rateLimits,
      latency: average,
      count: this.stats.latencyCount,
    }));
  }

  private async generateOffer(): Promise<void> {
    try {
      await this.abortCloud("aborted");
      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      const dc = pc.createDataChannel("easy-sync-lan-session", { ordered: true });
      this.dc = dc;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.setStatus(this.t("lanSession.status.iceGathering"));
      const gathering = await waitForIceGathering(pc);
      this.offerOut.value = pc.localDescription?.sdp ?? "";
      if (this.offerOut.value.length === 0) {
        throw new Error(this.t("lanSession.error.offerSdpEmpty"));
      }
      this.setStatus(this.t("lanSession.status.offerGenerated", {
        ice: this.t(gathering === "complete"
          ? "lanSession.ice.complete"
          : "lanSession.ice.timeout"),
      }));
      // Manual SDP counts as pairing until the peer answer opens the channel.
      this.setLanPhase("pairing");
    } catch (error) {
      this.setStatus(this.t("lanSession.status.generateOfferFailed", {
        error: describeError(error),
      }));
    }
  }

  private async senderConnect(): Promise<void> {
    try {
      if (this.pc === null || this.dc === null) {
        throw new Error(this.t("lanSession.error.manualNeedOffer"));
      }
      const answer = normalizeSdp(this.answerIn.value);
      if (answer.length === 0) {
        throw new Error(this.t("lanSession.error.manualAnswerInput"));
      }
      this.setStatus(this.t("lanSession.status.dcWaiting"));
      await this.pc.setRemoteDescription({ type: "answer", sdp: answer });
      await waitForDataChannelOpen(this.dc);
      this.session = new LanPeerSession(this.pc, this.dc);
      this.session.serveRequests(
        async (request) => {
          const result = await this.host.resolveServeFile(request);
          if ("error" in result) {
            this.setStatus(this.t("lanSession.status.refusedPath", {
              path: request.path,
              error: result.error,
            }));
          } else {
            this.setStatus(this.t("lanSession.status.servingPath", {
              path: request.path,
              bytes: result.bytes.byteLength,
            }));
          }
          return result;
        },
        (sent, total) => {
          this.host.reportLanProgress?.(sent, total);
          this.setStatus(this.t("lanSession.status.sending", { sent, total }));
        },
        (served) => {
          this.host.logServeComplete?.({
            path: served.path,
            bytes: served.size,
            contentMs: served.elapsedMs,
          });
          this.setStatus(this.t("lanSession.status.servedPath", {
            path: served.path,
            bytes: served.size,
            seconds: (served.elapsedMs / 1000).toFixed(2),
            mibPerSecond: served.elapsedMs > 0
              ? (served.size / 1024 / 1024 / (served.elapsedMs / 1000)).toFixed(2)
              : "0.00",
          }));
        },
      );
      this.setLanPhase("connected");
      this.setStatus(this.t("lanSession.status.connected"));
    } catch (error) {
      this.setStatus(this.t("lanSession.status.connectFailed", {
        error: describeError(error),
      }));
    }
  }

  private async generateAnswer(): Promise<void> {
    try {
      await this.abortCloud("aborted");
      const offer = normalizeSdp(this.offerIn.value);
      if (offer.length === 0) {
        throw new Error(this.t("lanSession.error.manualOfferInput"));
      }
      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      this.channelReady = new Promise((resolve) => {
        this.channelReadyResolve = resolve;
      });
      pc.ondatachannel = (event) => {
        this.dc = event.channel;
        this.channelReadyResolve?.(event.channel);
        this.channelReadyResolve = null;
      };
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.setStatus(this.t("lanSession.status.iceGathering"));
      const gathering = await waitForIceGathering(pc);
      this.answerOut.value = pc.localDescription?.sdp ?? "";
      if (this.answerOut.value.length === 0) {
        throw new Error(this.t("lanSession.error.answerSdpEmpty"));
      }
      this.setStatus(this.t("lanSession.status.answerGenerated", {
        ice: this.t(gathering === "complete"
          ? "lanSession.ice.complete"
          : "lanSession.ice.timeout"),
      }));
      // Manual SDP (receiver): pairing until the sender's channel opens.
      this.setLanPhase("pairing");
    } catch (error) {
      this.setStatus(this.t("lanSession.status.generateAnswerFailed", {
        error: describeError(error),
      }));
    }
  }

  private async receiverInject(): Promise<void> {
    try {
      if (this.pc === null) {
        throw new Error(this.t("lanSession.error.manualNeedAnswer"));
      }
      const dc = this.dc ?? await this.channelReady;
      if (dc === null) {
        throw new Error(this.t("lanSession.error.dcNotEstablished"));
      }
      this.session = new LanPeerSession(this.pc, dc);
      const source = createLanContentSource(this.session, (downloaded, total) => {
        this.host.reportLanProgress?.(downloaded, total);
        this.setStatus(this.t("lanSession.status.receiving", {
          downloaded,
          total,
        }));
      });
      if (!this.host.injectSource(source)) {
        this.session.close();
        throw new Error(this.t("lanSession.error.clientNotReady"));
      }
      this.manualStartSyncButton.disabled = false;
      this.setLanPhase("connected");
      this.setStatus(this.t("lanSession.status.sourceInjected"));
    } catch (error) {
      this.setStatus(this.t("lanSession.status.injectFailed", {
        error: describeError(error),
      }));
    }
  }

  private resetWebRtc(): void {
    this.session?.close();
    this.session = null;
    this.host.clearSource();
    // No session, no chip: the sidebar falls back to its cloud reading.
    this.setLanPhase(null);
    this.channelReady = null;
    this.channelReadyResolve = null;
    try {
      this.dc?.close();
    } catch {
      // Already closed.
    }
    try {
      this.pc?.close();
    } catch {
      // Already closed.
    }
    this.dc = null;
    this.pc = null;
    this.cloudStartSyncButton.disabled = true;
    this.manualStartSyncButton.disabled = true;
  }

  private setStatus(text: string): void {
    this.statusEl.setText(text);
  }

  private async copyText(text: string, label: string): Promise<void> {
    if (text.length === 0) {
      this.setStatus(this.t("lanSession.status.copyEmpty", { label }));
      return;
    }
    try {
      const clipboard = navigator?.clipboard;
      if (clipboard === undefined || typeof clipboard.writeText !== "function") {
        throw new Error("clipboard API unavailable");
      }
      await clipboard.writeText(text);
      this.setStatus(this.t("lanSession.status.copied", { label }));
    } catch (error) {
      this.setStatus(this.t("lanSession.status.copyFailed", {
        label,
        error: describeError(error),
      }));
    }
  }
}

function emptyStats(): SignalStats {
  return {
    reads: 0,
    writes: 0,
    deletes: 0,
    lists: 0,
    errors: 0,
    rateLimits: 0,
    latencyTotalMs: 0,
    latencyCount: 0,
  };
}

function shortSession(session: LanSignalSession): string {
  return session.sessionId.slice(0, 8);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
