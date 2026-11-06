type StartupPlatform = "desktop" | "mobile";
type StartupReadyOutcome = "ready" | "failed";

export interface StartupStateEvidence {
  outcome: StartupReadyOutcome;
  activeV2: boolean;
  authorityBlocked: boolean;
  blockReason: string | null;
  remoteFiles: number;
  remoteFolders: number;
  mutationLedger: number;
  pendingReview: boolean;
}

export interface StartupAuthEvidence {
  outcome: StartupReadyOutcome;
  loggedIn: boolean;
  accountVerified: boolean;
}

/** One ordered mark inside a startup session (milliseconds since onload start). */
export interface StartupStageMark {
  stage: string;
  atMs: number;
}

/** Coarse host facts carried into the observation record; no paths or identities. */
interface StartupHostFacts {
  apiVersion: string;
  pluginVersion: string;
  visibilityAtOnload: string;
}

export interface PluginColdStartSummary {
  schemaVersion: 1;
  platform: StartupPlatform;
  readyMs: {
    ui: number;
    state: number;
    auth: number;
    total: number;
  };
  pluginData: {
    physicalReads: number;
    readMs: number;
    topLevelKeys: number | null;
    writesBeforeReady: number;
    writeMs: number;
  };
  state: StartupStateEvidence;
  auth: StartupAuthEvidence;
  /** Ordered startup marks; parallel work is sorted by `atMs` on export. */
  stages: StartupStageMark[];
  /** onload start → onload return (the plugin's own synchronous segment). */
  onloadReturnedMs: number | null;
  /** onload start → host layout-ready callback. */
  layoutReadyMs: number | null;
  /** Host layout-ready wait after the plugin returned (layoutReady − return). */
  hostLayoutWaitMs: number | null;
  host: StartupHostFacts | null;
}

const MAX_STAGES = 32;
const MAX_STAGE_NAME_LENGTH = 48;
const MAX_HOST_FACT_LENGTH = 64;

/**
 * One plugin-instance cold-start measurement.
 *
 * This owner stores only aggregate timings, operation counts, coarse state and
 * ordered stage marks. It has no paths, account identifiers, tokens, settings,
 * persistence or mutation capability.
 */
export class StartupPerformanceTracker {
  private startedAt = 0;
  private platform: StartupPlatform = "desktop";
  private uiReadyAt: number | null = null;
  private stateReadyAt: number | null = null;
  private authReadyAt: number | null = null;
  private onloadReturnedAt: number | null = null;
  private layoutReadyAt: number | null = null;
  private stateEvidence: StartupStateEvidence | null = null;
  private authEvidence: StartupAuthEvidence | null = null;
  private hostFacts: StartupHostFacts | null = null;
  private stages: StartupStageMark[] = [];
  private pluginDataPhysicalReads = 0;
  private pluginDataReadMs = 0;
  private pluginDataTopLevelKeys: number | null = null;
  private pluginDataWritesBeforeReady = 0;
  private pluginDataWriteMs = 0;
  private active = false;
  private emitted = false;

  constructor(
    private readonly now: () => number = () => performance.now(),
  ) {}

  begin(platform: StartupPlatform): void {
    this.startedAt = this.now();
    this.platform = platform;
    this.uiReadyAt = null;
    this.stateReadyAt = null;
    this.authReadyAt = null;
    this.onloadReturnedAt = null;
    this.layoutReadyAt = null;
    this.stateEvidence = null;
    this.authEvidence = null;
    this.hostFacts = null;
    this.stages = [];
    this.pluginDataPhysicalReads = 0;
    this.pluginDataReadMs = 0;
    this.pluginDataTopLevelKeys = null;
    this.pluginDataWritesBeforeReady = 0;
    this.pluginDataWriteMs = 0;
    this.active = true;
    this.emitted = false;
  }

  cancel(): void {
    this.active = false;
  }

  get isCollecting(): boolean {
    return this.active && !this.emitted;
  }

  /** Coarse host facts for attribution (versions and first visibility only). */
  setHostFacts(facts: StartupHostFacts): void {
    if (!this.isCollecting) return;
    this.hostFacts = {
      apiVersion: cleanFact(facts.apiVersion),
      pluginVersion: cleanFact(facts.pluginVersion),
      visibilityAtOnload: cleanFact(facts.visibilityAtOnload),
    };
  }

  /**
   * Record one stage completion. Marks are relative to the onload start and are
   * sorted on export, so stages may complete out of declaration order.
   */
  markStage(stage: string): void {
    if (!this.isCollecting) return;
    if (this.stages.length >= MAX_STAGES) return;
    this.stages.push({
      stage: cleanFact(stage).slice(0, MAX_STAGE_NAME_LENGTH),
      atMs: elapsed(this.startedAt, this.now()),
    });
  }

  markOnloadReturned(): void {
    if (!this.isCollecting || this.onloadReturnedAt !== null) return;
    this.onloadReturnedAt = this.now();
    this.markStage("onload:returned");
  }

  markLayoutReady(): void {
    if (!this.isCollecting || this.layoutReadyAt !== null) return;
    this.layoutReadyAt = this.now();
    this.markStage("host:layout-ready");
  }

  recordPluginDataRead(elapsedMs: number, topLevelKeys: number | null): void {
    if (!this.isCollecting) return;
    this.pluginDataPhysicalReads += 1;
    this.pluginDataReadMs += nonNegative(elapsedMs);
    if (this.pluginDataTopLevelKeys === null && topLevelKeys !== null) {
      this.pluginDataTopLevelKeys = Math.max(0, Math.trunc(topLevelKeys));
    }
  }

  recordPluginDataWrite(elapsedMs: number): void {
    if (!this.isCollecting) return;
    this.pluginDataWritesBeforeReady += 1;
    this.pluginDataWriteMs += nonNegative(elapsedMs);
  }

  markUiReady(): void {
    if (!this.isCollecting || this.uiReadyAt !== null) return;
    this.uiReadyAt = this.now();
    this.markStage("onload:ui-ready");
  }

  markStateReady(evidence: StartupStateEvidence): void {
    if (!this.isCollecting || this.stateReadyAt !== null) return;
    this.stateReadyAt = this.now();
    this.stateEvidence = { ...evidence };
    this.markStage("state:ready");
  }

  markAuthReady(evidence: StartupAuthEvidence): void {
    if (!this.isCollecting || this.authReadyAt !== null) return;
    this.authReadyAt = this.now();
    this.authEvidence = { ...evidence };
    this.markStage("auth:ready");
  }

  takeCompletedSummary(): PluginColdStartSummary | null {
    if (
      !this.isCollecting
      || this.uiReadyAt === null
      || this.stateReadyAt === null
      || this.authReadyAt === null
      || this.stateEvidence === null
      || this.authEvidence === null
    ) {
      return null;
    }
    this.emitted = true;
    this.active = false;
    const stateMs = elapsed(this.startedAt, this.stateReadyAt);
    const authMs = elapsed(this.startedAt, this.authReadyAt);
    const onloadReturnedMs = this.onloadReturnedAt === null
      ? null
      : elapsed(this.startedAt, this.onloadReturnedAt);
    const layoutReadyMs = this.layoutReadyAt === null
      ? null
      : elapsed(this.startedAt, this.layoutReadyAt);
    return {
      schemaVersion: 1,
      platform: this.platform,
      readyMs: {
        ui: elapsed(this.startedAt, this.uiReadyAt),
        state: stateMs,
        auth: authMs,
        total: Math.max(stateMs, authMs),
      },
      pluginData: {
        physicalReads: this.pluginDataPhysicalReads,
        readMs: rounded(this.pluginDataReadMs),
        topLevelKeys: this.pluginDataTopLevelKeys,
        writesBeforeReady: this.pluginDataWritesBeforeReady,
        writeMs: rounded(this.pluginDataWriteMs),
      },
      state: { ...this.stateEvidence },
      auth: { ...this.authEvidence },
      stages: this.stages
        .slice()
        .sort((left, right) =>
          left.atMs - right.atMs || left.stage.localeCompare(right.stage)
        ),
      onloadReturnedMs,
      layoutReadyMs,
      hostLayoutWaitMs:
        onloadReturnedMs === null || layoutReadyMs === null
          ? null
          : rounded(Math.max(0, layoutReadyMs - onloadReturnedMs)),
      host: this.hostFacts === null ? null : { ...this.hostFacts },
    };
  }
}

function cleanFact(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, MAX_HOST_FACT_LENGTH)
    : "";
}

function elapsed(startedAt: number, finishedAt: number): number {
  return rounded(Math.max(0, finishedAt - startedAt));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function rounded(value: number): number {
  return Number(nonNegative(value).toFixed(3));
}
