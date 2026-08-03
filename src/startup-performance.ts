export type StartupPlatform = "desktop" | "mobile";
export type StartupReadyOutcome = "ready" | "failed";

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
}

/**
 * One plugin-instance cold-start measurement.
 *
 * This owner stores only aggregate timings, operation counts and coarse state.
 * It has no paths, account identifiers, tokens, settings, persistence or
 * mutation capability.
 */
export class StartupPerformanceTracker {
  private startedAt = 0;
  private platform: StartupPlatform = "desktop";
  private uiReadyAt: number | null = null;
  private stateReadyAt: number | null = null;
  private authReadyAt: number | null = null;
  private stateEvidence: StartupStateEvidence | null = null;
  private authEvidence: StartupAuthEvidence | null = null;
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
    this.stateEvidence = null;
    this.authEvidence = null;
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
  }

  markStateReady(evidence: StartupStateEvidence): void {
    if (!this.isCollecting || this.stateReadyAt !== null) return;
    this.stateReadyAt = this.now();
    this.stateEvidence = { ...evidence };
  }

  markAuthReady(evidence: StartupAuthEvidence): void {
    if (!this.isCollecting || this.authReadyAt !== null) return;
    this.authReadyAt = this.now();
    this.authEvidence = { ...evidence };
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
    };
  }
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
