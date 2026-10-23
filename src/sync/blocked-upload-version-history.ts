/**
 * Blocked-upload version-history probe — read-only recovery evidence.
 *
 * When an unreceipted upload record cannot be settled, the *current* remote
 * facts cannot tell "our write landed and someone replaced it afterwards"
 * apart from "our write never landed". The retained version history does: the
 * version written inside the intent's window carrying the intended byte size
 * proves the upload landed, and any version after it shows that another writer
 * took the path over since (2026-10-13 field case: version `356.0`, size
 * exactly `intent.expectedLocal.size`, written 2.8 s after the intent).
 *
 * Deliberately evidence-only: this module never feeds settlement, never writes
 * to the remote or the vault, and never becomes user-visible copy. Settlement
 * keeps its own gates (see the C1 discussion in `docs/dev-logs/2026-10/
 * 20261013-115449 …`). The probe stays bounded: at most one *successful* probe
 * per operation per session, short local deadline, best-effort on failure.
 */

import type { DriveItemVersion } from "../onedrive/types";
import {
  compatClearTimeout,
  compatSetTimeout,
  describeError,
  type TimeoutHandle,
} from "../obsidian-compat";
import type { RemoteNodeV2 } from "./remote-index-v2";
import type { MutationIntent, MutationIntentV1 } from "./types";

/** Newest versions kept in the diagnostic payload; the rest is counted only. */
const EVIDENCE_VERSION_LIMIT = 8;

/** Local deadline for the whole probe. This is diagnostics: it must never
 *  delay the blocked round by the transport's own metadata budget. */
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

interface DriveItemVersionFacts {
  versionId: string;
  size: number | null;
  mtimeMs: number | null;
  lastModifiedBy: string | null;
}

interface BlockedUploadVersionHistoryEvidence {
  retainedCount: number;
  /** Newest first, capped at EVIDENCE_VERSION_LIMIT. */
  newest: DriveItemVersionFacts[];
  /** A retained version carries exactly the byte size we tried to upload. */
  intendedSizeSeen: boolean;
  intendedSizeVersionId: string | null;
  intendedSizeVersionAtMs: number | null;
  /** Retained versions written at/after the intent (includes our own write). */
  versionsAtOrAfterIntent: number;
}

interface BlockedUploadVersionHistoryProbeDeps {
  listVersions(driveItemId: string): Promise<DriveItemVersion[]>;
  isLoggingEnabled(): boolean;
  log(message: string, data: Record<string, unknown>): void;
  timeoutMs?: number;
}

/** OneDrive eTags look like `"{GUID},355"`; the trailing number is the write
 *  sequence (it matches the `N.0` version id), so a later remote eTag with a
 *  higher number means further writes happened after the recorded base. */
export function parseDriveItemETagVersion(
  eTag: string | undefined,
): number | null {
  if (!eTag) return null;
  const match = /,(\d+)"?\s*$/.exec(eTag);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Writes observed after the recorded base, when both eTags carry a sequence
 *  (our own write included; undefined when a side has no readable sequence). */
export function computeETagVersionDelta(
  currentETag: string | undefined,
  baseETag: string | undefined,
): number | undefined {
  const current = parseDriveItemETagVersion(currentETag);
  const base = parseDriveItemETagVersion(baseETag);
  return current !== null && base !== null ? current - base : undefined;
}

interface BlockedUploadRemoteFacts {
  intentExpectedLocalSize: number | null;
  remoteSize: number | undefined;
  remoteSha256: string | undefined;
  remoteETag: string | undefined;
  remoteVersion: number | null;
  remoteVersionDelta: number | undefined;
  remoteMatchesExpectedRemote: boolean;
  remoteMatchesIntendedLocal: boolean;
}

/**
 * Pure: the remote-side facts a blocked upload needs in order to be readable in
 * one screen — "is the remote still the base we recorded", "is it still what we
 * tried to send", and "how many writes happened after that base".
 *
 * The 2026-10-13 incident needed exactly these dimensions and had to gather
 * them by hand from three sources (the ledger's intent, two evidence lines
 * hours apart, and another record's receipt timing). The local-side hash is
 * only compared when the committed index carries one; size alone is reported
 * otherwise.
 */
export function buildBlockedUploadRemoteFacts(
  node: RemoteNodeV2 | undefined,
  intent: MutationIntentV1,
): BlockedUploadRemoteFacts {
  const expectedRemote = intent.expectedRemote;
  const baseETag = expectedRemote.exists ? expectedRemote.eTag : undefined;
  return {
    intentExpectedLocalSize: intent.expectedLocal.exists
      ? intent.expectedLocal.size
      : null,
    remoteSize: node?.size,
    remoteSha256: node?.contentHash,
    remoteETag: node?.eTag,
    remoteVersion: parseDriveItemETagVersion(node?.eTag),
    remoteVersionDelta: computeETagVersionDelta(node?.eTag, baseETag),
    remoteMatchesExpectedRemote: node !== undefined
      && baseETag !== undefined
      && node.eTag === baseETag,
    remoteMatchesIntendedLocal: node !== undefined
      && intent.expectedLocal.exists
      && node.size === intent.expectedLocal.size
      && (
        node.contentHash === undefined
        || node.contentHash.toLowerCase()
          === intent.expectedLocal.hash.toLowerCase()
      ),
  };
}

function toFacts(version: DriveItemVersion): DriveItemVersionFacts | null {
  if (typeof version.id !== "string" || version.id.length === 0) return null;
  const parsedTime = typeof version.lastModifiedDateTime === "string"
    ? Date.parse(version.lastModifiedDateTime)
    : Number.NaN;
  return {
    versionId: version.id,
    size: typeof version.size === "number" ? version.size : null,
    mtimeMs: Number.isFinite(parsedTime) ? parsedTime : null,
    lastModifiedBy: version.lastModifiedBy?.user?.displayName ?? null,
  };
}

/** Pure: turn a raw version list into the compact evidence payload. */
export function buildVersionHistoryEvidence(
  versions: readonly DriveItemVersion[],
  intent: MutationIntentV1,
): BlockedUploadVersionHistoryEvidence {
  const facts = versions
    .map(toFacts)
    .filter((entry): entry is DriveItemVersionFacts => entry !== null)
    .sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0));
  const intendedSize = intent.expectedLocal.exists
    ? intent.expectedLocal.size
    : null;
  const intended = intendedSize === null
    ? undefined
    : facts.find((entry) => entry.size === intendedSize);
  return {
    retainedCount: facts.length,
    newest: facts.slice(0, EVIDENCE_VERSION_LIMIT),
    intendedSizeSeen: intended !== undefined,
    intendedSizeVersionId: intended?.versionId ?? null,
    intendedSizeVersionAtMs: intended?.mtimeMs ?? null,
    versionsAtOrAfterIntent: facts.filter(
      (entry) => entry.mtimeMs !== null && entry.mtimeMs >= intent.createdAt,
    ).length,
  };
}

/**
 * One probe per executor (session): remembers the operations whose history was
 * already captured so a record blocked for hours cannot re-spend API calls
 * every round. Failures are not remembered, so a transport hiccup is retried
 * by the next round instead of losing the evidence for good.
 */
export class BlockedUploadVersionHistoryProbe {
  private readonly captured = new Set<string>();

  constructor(private readonly deps: BlockedUploadVersionHistoryProbeDeps) {}

  async probe(intent: MutationIntent): Promise<void> {
    if (intent.version !== 1) return;
    if (intent.action !== "upload" || !intent.expectedRemote.exists) return;
    const driveId = intent.expectedRemote.driveId;
    if (!driveId) return;
    if (this.captured.has(intent.operationId)) return;
    if (!this.deps.isLoggingEnabled()) return;

    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    let timer: TimeoutHandle | null = null;
    try {
      const versions = await Promise.race([
        this.deps.listVersions(driveId),
        new Promise<null>((resolve) => {
          timer = compatSetTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (versions === null) {
        this.deps.log("blocked upload version history unavailable", {
          operationId: intent.operationId,
          path: intent.path,
          reason: "timeout",
          mutations: 0,
        });
        return;
      }
      const evidence = buildVersionHistoryEvidence(versions, intent);
      this.captured.add(intent.operationId);
      this.deps.log("blocked upload version history", {
        operationId: intent.operationId,
        path: intent.path,
        expectedLocalSize: intent.expectedLocal.exists
          ? intent.expectedLocal.size
          : null,
        ...evidence,
        mutations: 0,
      });
    } catch (error) {
      // Evidence must never turn the blocked path itself into a failure.
      this.deps.log("blocked upload version history unavailable", {
        operationId: intent.operationId,
        path: intent.path,
        reason: describeError(error),
        mutations: 0,
      });
    } finally {
      if (timer !== null) compatClearTimeout(timer);
    }
  }
}
