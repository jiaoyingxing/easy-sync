import { isRecord } from "../obsidian-compat";

export const KEY_PUBLIC_113_CUTOVER =
  "easy-sync-public-1.1.3-cutover-v2";

const KEY_PENDING_CONFLICTS = "easy-sync-pending-conflicts";
const KEY_BASE_SNAPSHOT = "easy-sync-base-snapshot";
const KEY_PENDING_DELETES = "easy-sync-pending-remote-deletes";
const KEY_PENDING_ISSUES = "easy-sync-pending-issues";
const KEY_PLAN_REVIEW_ACTIVE = "easy-sync-plan-review-active";
const KEY_PLAN_REVIEW_COUNTS = "easy-sync-plan-review-counts";
const KEY_PLAN_REVIEW_ITEMS = "easy-sync-plan-review-items";
const KEY_PLAN_REVIEW_DIGEST = "easy-sync-plan-review-digest";
const KEY_PLAN_REVIEW_REVISION = "easy-sync-plan-review-revision";
const KEY_PLAN_REVIEW_SCOPE = "easy-sync-plan-review-scope";
const KEY_PLAN_REVIEW_CANONICAL_IDENTITY =
  "easy-sync-plan-review-canonical-identity-v2";
const KEY_PUBLIC_MUTATION_LEDGER = "easy-sync-mutation-ledger";
const KEY_V2_MUTATION_LEDGER = "easy-sync-v2-mutation-ledger";
const KEY_LOCAL_FOLDER_MOVE_HINTS = "easy-sync-local-folder-move-hints";
const KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE =
  "community-plugin-enablement-state";

export interface Public113CutoverMarkerV2 {
  version: 2;
  kind: "public-1.1.3-cutover";
  sourceStateDigest: string;
  finalizedAt: number;
  importedLegacyMutationRecords: number;
  retired: {
    conflicts: number;
    remoteDeletes: number;
    issues: number;
    reviewActive: boolean;
    localFolderMoveHints: number;
  };
}

/**
 * Retire only device-local V1 decisions after V2 authority is durable.
 *
 * Settings, account/profile data, history and unknown keys are deliberately
 * untouched. The public ledger moves to the V2 recovery key in the same
 * PluginData publication. The legacy base snapshot is converted to V2 anchors
 * and retained in state-v1.backup.json, then removed from live PluginData so
 * it cannot remain a second common-state owner.
 */
export function finalizePublic113PluginDataCutover(input: {
  pluginData: Readonly<Record<string, unknown>>;
  sourceStateDigest: string;
  finalizedAt: number;
}): {
  pluginData: Record<string, unknown>;
  marker: Public113CutoverMarkerV2;
} {
  if (!/^[a-f0-9]{64}$/.test(input.sourceStateDigest)) {
    throw new Error("Public 1.1.3 cutover requires a valid source digest");
  }
  const existing = readPublic113CutoverMarker(
    input.pluginData[KEY_PUBLIC_113_CUTOVER],
  );
  if (existing) {
    if (existing.sourceStateDigest !== input.sourceStateDigest) {
      throw new Error(
        "Public 1.1.3 cutover marker belongs to another migration input",
      );
    }
    const pluginData = structuredClone(
      input.pluginData,
    ) as Record<string, unknown>;
    pluginData[KEY_BASE_SNAPSHOT] = {};
    delete pluginData[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE];
    migrateMutationLedgerKey(pluginData);
    return { pluginData, marker: existing };
  }

  const marker: Public113CutoverMarkerV2 = {
    version: 2,
    kind: "public-1.1.3-cutover",
    sourceStateDigest: input.sourceStateDigest,
    finalizedAt: input.finalizedAt,
    importedLegacyMutationRecords: arrayLength(
      input.pluginData[KEY_PUBLIC_MUTATION_LEDGER],
    ),
    retired: {
      conflicts: arrayLength(input.pluginData[KEY_PENDING_CONFLICTS]),
      remoteDeletes: arrayLength(input.pluginData[KEY_PENDING_DELETES]),
      issues: arrayLength(input.pluginData[KEY_PENDING_ISSUES]),
      reviewActive: input.pluginData[KEY_PLAN_REVIEW_ACTIVE] === true,
      localFolderMoveHints: arrayLength(
        input.pluginData[KEY_LOCAL_FOLDER_MOVE_HINTS],
      ),
    },
  };
  const pluginData = structuredClone(
    input.pluginData,
  ) as Record<string, unknown>;
  pluginData[KEY_PENDING_CONFLICTS] = [];
  pluginData[KEY_BASE_SNAPSHOT] = {};
  pluginData[KEY_PENDING_DELETES] = [];
  pluginData[KEY_PENDING_ISSUES] = [];
  pluginData[KEY_PLAN_REVIEW_ACTIVE] = false;
  pluginData[KEY_PLAN_REVIEW_COUNTS] = null;
  pluginData[KEY_PLAN_REVIEW_ITEMS] = [];
  pluginData[KEY_PLAN_REVIEW_DIGEST] = "";
  pluginData[KEY_PLAN_REVIEW_REVISION] =
    safeNonNegativeInteger(pluginData[KEY_PLAN_REVIEW_REVISION]) + 1;
  pluginData[KEY_PLAN_REVIEW_SCOPE] = null;
  pluginData[KEY_PLAN_REVIEW_CANONICAL_IDENTITY] = null;
  pluginData[KEY_LOCAL_FOLDER_MOVE_HINTS] = [];
  delete pluginData[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE];
  migrateMutationLedgerKey(pluginData);
  pluginData[KEY_PUBLIC_113_CUTOVER] = marker;
  return { pluginData, marker };
}

function migrateMutationLedgerKey(pluginData: Record<string, unknown>): void {
  const publicLedger = Array.isArray(pluginData[KEY_PUBLIC_MUTATION_LEDGER])
    ? pluginData[KEY_PUBLIC_MUTATION_LEDGER]
    : [];
  const activeLedger = Array.isArray(pluginData[KEY_V2_MUTATION_LEDGER])
    ? pluginData[KEY_V2_MUTATION_LEDGER]
    : [];
  if (
    publicLedger.length > 0
    && activeLedger.length > 0
    && JSON.stringify(publicLedger) !== JSON.stringify(activeLedger)
  ) {
    throw new Error("Public and V2 mutation ledgers disagree during cutover");
  }
  pluginData[KEY_V2_MUTATION_LEDGER] = structuredClone(
    activeLedger.length > 0 ? activeLedger : publicLedger,
  );
  pluginData[KEY_PUBLIC_MUTATION_LEDGER] = [];
}

export function readPublic113CutoverMarker(
  value: unknown,
): Public113CutoverMarkerV2 | null {
  if (
    !isRecord(value)
    || value.version !== 2
    || value.kind !== "public-1.1.3-cutover"
    || typeof value.sourceStateDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceStateDigest)
    || typeof value.finalizedAt !== "number"
    || !Number.isFinite(value.finalizedAt)
    || !Number.isSafeInteger(value.importedLegacyMutationRecords)
    || Number(value.importedLegacyMutationRecords) < 0
    || !isRecord(value.retired)
    || !isCount(value.retired.conflicts)
    || !isCount(value.retired.remoteDeletes)
    || !isCount(value.retired.issues)
    || typeof value.retired.reviewActive !== "boolean"
    || !isCount(value.retired.localFolderMoveHints)
  ) return null;
  return structuredClone(value) as unknown as Public113CutoverMarkerV2;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function safeNonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : 0;
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
