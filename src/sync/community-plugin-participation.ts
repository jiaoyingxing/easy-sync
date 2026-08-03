import {
  isPluginSelected,
  normalizePluginIds,
  type PluginScopeSelection,
} from "./community-plugin-sync-policy";

export type DeviceCommunityPluginPhase =
  | "never-participated"
  | "excluded"
  | "join-requested"
  | "restoring"
  | "participating"
  | "exit-requested"
  | "blocked";

export interface DeviceCommunityPluginParticipationEntryV1 {
  pluginId: string;
  phase: DeviceCommunityPluginPhase;
  operationId?: string;
  targetCatalogRevision?: number;
  targetBundleDigest?: string;
  joinedGeneration?: number;
  lastConfirmedLocalBundleDigest?: string;
  blockedReason?: string;
}

export interface DeviceCommunityPluginParticipationV1 {
  schemaVersion: 1;
  kind: "device-community-plugin-participation";
  scopeEnabled: boolean;
  pluginsById: Record<string, DeviceCommunityPluginParticipationEntryV1>;
}

export type DeviceCommunityPluginParticipationCommand =
  | { type: "set-scope-enabled"; enabled: boolean }
  | {
      type: "request-join";
      pluginId: string;
      operationId?: string;
      targetCatalogRevision?: number;
      targetBundleDigest?: string;
    }
  | { type: "begin-restore"; pluginId: string; operationId?: string }
  | {
      type: "confirm-participating";
      pluginId: string;
      joinedGeneration?: number;
      localBundleDigest?: string;
    }
  | { type: "request-exit"; pluginId: string; operationId?: string }
  | { type: "confirm-excluded"; pluginId: string }
  | { type: "mark-never-participated"; pluginId: string }
  | {
      type: "block";
      pluginId: string;
      reason: string;
      operationId?: string;
    };

export interface LegacyCommunityPluginParticipationMigrationInput {
  filesEnabled: boolean;
  selection: Readonly<PluginScopeSelection>;
  knownPluginIds: readonly string[];
  completeLocalBundlePluginIds: readonly string[];
  historicallyParticipatedPluginIds?: readonly string[];
  incompleteLocalBundlePluginIds?: readonly string[];
  ownPluginId?: string;
}

const ENABLED_PHASES = new Set<DeviceCommunityPluginPhase>([
  "join-requested",
  "restoring",
  "participating",
  "blocked",
]);
const PHASES = new Set<DeviceCommunityPluginPhase>([
  "never-participated",
  "excluded",
  "join-requested",
  "restoring",
  "participating",
  "exit-requested",
  "blocked",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function createEmptyDeviceCommunityPluginParticipation(
  scopeEnabled: boolean,
): DeviceCommunityPluginParticipationV1 {
  return {
    schemaVersion: 1,
    kind: "device-community-plugin-participation",
    scopeEnabled,
    pluginsById: {},
  };
}

export function readDeviceCommunityPluginParticipation(
  value: unknown,
  ownPluginId = "easy-sync",
): DeviceCommunityPluginParticipationV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "device-community-plugin-participation"
    || typeof value.scopeEnabled !== "boolean"
    || !isRecord(value.pluginsById)
    || !hasOnlyKeys(value, [
      "schemaVersion",
      "kind",
      "scopeEnabled",
      "pluginsById",
    ])) {
    throw new Error("Device community-plugin participation state is invalid");
  }
  const pluginsById: Record<
    string,
    DeviceCommunityPluginParticipationEntryV1
  > = {};
  for (const pluginId of Object.keys(value.pluginsById).sort(compareText)) {
    const normalized = normalizePluginIds([pluginId], ownPluginId)[0];
    const entry = value.pluginsById[pluginId];
    if (normalized !== pluginId || !isParticipationEntry(entry, pluginId)) {
      throw new Error(
        `Device community-plugin participation entry is invalid: ${pluginId}`,
      );
    }
    pluginsById[pluginId] = structuredClone(entry);
  }
  return {
    schemaVersion: 1,
    kind: "device-community-plugin-participation",
    scopeEnabled: value.scopeEnabled,
    pluginsById,
  };
}

export function reduceDeviceCommunityPluginParticipation(
  current: Readonly<DeviceCommunityPluginParticipationV1>,
  command: Readonly<DeviceCommunityPluginParticipationCommand>,
  ownPluginId = "easy-sync",
): DeviceCommunityPluginParticipationV1 {
  const committed = readDeviceCommunityPluginParticipation(current, ownPluginId);
  if (command.type === "set-scope-enabled") {
    if (committed.scopeEnabled === command.enabled) return committed;
    return { ...committed, scopeEnabled: command.enabled };
  }
  const pluginId = requirePluginId(command.pluginId, ownPluginId);
  let entry: DeviceCommunityPluginParticipationEntryV1;
  switch (command.type) {
    case "request-join":
      entry = {
        pluginId,
        phase: "join-requested",
        ...optionalOperationId(command.operationId),
        ...optionalRevision(command.targetCatalogRevision),
        ...optionalDigest("targetBundleDigest", command.targetBundleDigest),
      };
      break;
    case "begin-restore": {
      const previous = committed.pluginsById[pluginId];
      entry = {
        pluginId,
        phase: "restoring",
        ...optionalOperationId(command.operationId ?? previous?.operationId),
        ...optionalRevision(previous?.targetCatalogRevision),
        ...optionalDigest("targetBundleDigest", previous?.targetBundleDigest),
      };
      break;
    }
    case "confirm-participating":
      entry = {
        pluginId,
        phase: "participating",
        ...optionalGeneration(command.joinedGeneration),
        ...optionalDigest(
          "lastConfirmedLocalBundleDigest",
          command.localBundleDigest,
        ),
      };
      break;
    case "request-exit": {
      const previous = committed.pluginsById[pluginId];
      entry = {
        pluginId,
        phase: "exit-requested",
        ...optionalOperationId(command.operationId),
        ...optionalGeneration(previous?.joinedGeneration),
        ...optionalDigest(
          "lastConfirmedLocalBundleDigest",
          previous?.lastConfirmedLocalBundleDigest,
        ),
      };
      break;
    }
    case "confirm-excluded":
      entry = { pluginId, phase: "excluded" };
      break;
    case "mark-never-participated":
      entry = { pluginId, phase: "never-participated" };
      break;
    case "block": {
      if (!command.reason.trim()) {
        throw new Error("Device community-plugin blocked reason is required");
      }
      const previous = committed.pluginsById[pluginId];
      entry = {
        pluginId,
        phase: "blocked",
        blockedReason: command.reason.trim(),
        ...optionalOperationId(command.operationId ?? previous?.operationId),
        ...optionalRevision(previous?.targetCatalogRevision),
        ...optionalDigest("targetBundleDigest", previous?.targetBundleDigest),
      };
      break;
    }
  }
  if (sameJson(committed.pluginsById[pluginId], entry)) return committed;
  return {
    ...committed,
    pluginsById: sortPluginEntries({
      ...committed.pluginsById,
      [pluginId]: entry,
    }),
  };
}

export function isDeviceCommunityPluginEnabled(
  state: Readonly<DeviceCommunityPluginParticipationV1>,
  pluginId: string,
): boolean {
  return state.scopeEnabled
    && ENABLED_PHASES.has(state.pluginsById[pluginId]?.phase ?? "excluded");
}

export function migrateLegacyCommunityPluginParticipation(
  input: Readonly<LegacyCommunityPluginParticipationMigrationInput>,
): DeviceCommunityPluginParticipationV1 {
  const ownPluginId = input.ownPluginId ?? "easy-sync";
  const knownPluginIds = normalizePluginIds(input.knownPluginIds, ownPluginId);
  const local = normalizedIdSet(input.completeLocalBundlePluginIds, ownPluginId);
  const historical = normalizedIdSet(
    input.historicallyParticipatedPluginIds ?? [],
    ownPluginId,
  );
  const incomplete = normalizedIdSet(
    input.incompleteLocalBundlePluginIds ?? [],
    ownPluginId,
  );
  const ignored = normalizedIdSet(
    input.selection.ignoredPluginIds ?? [],
    ownPluginId,
  );
  const restoring = normalizedIdSet(
    input.selection.restoringPluginIds ?? [],
    ownPluginId,
  );
  const pluginsById: Record<
    string,
    DeviceCommunityPluginParticipationEntryV1
  > = {};
  for (const pluginId of knownPluginIds) {
    if (ignored.has(pluginId)
      || !isPluginSelected(input.selection, pluginId)) {
      pluginsById[pluginId] = { pluginId, phase: "excluded" };
    } else if (restoring.has(pluginId)) {
      pluginsById[pluginId] = { pluginId, phase: "join-requested" };
    } else if (incomplete.has(pluginId)) {
      pluginsById[pluginId] = {
        pluginId,
        phase: "blocked",
        blockedReason: "local-bundle-incomplete",
      };
    } else if (local.has(pluginId)) {
      pluginsById[pluginId] = { pluginId, phase: "participating" };
    } else if (historical.has(pluginId)) {
      pluginsById[pluginId] = { pluginId, phase: "excluded" };
    } else {
      pluginsById[pluginId] = { pluginId, phase: "never-participated" };
    }
  }
  return {
    schemaVersion: 1,
    kind: "device-community-plugin-participation",
    scopeEnabled: input.filesEnabled,
    pluginsById,
  };
}

function isParticipationEntry(
  value: unknown,
  pluginId: string,
): value is DeviceCommunityPluginParticipationEntryV1 {
  if (!isRecord(value)
    || value.pluginId !== pluginId
    || typeof value.phase !== "string"
    || !PHASES.has(value.phase as DeviceCommunityPluginPhase)
    || !isOptionalNonEmptyString(value.operationId)
    || !isOptionalSafeInteger(value.targetCatalogRevision, 0)
    || !isOptionalDigest(value.targetBundleDigest)
    || !isOptionalSafeInteger(value.joinedGeneration, 1)
    || !isOptionalDigest(value.lastConfirmedLocalBundleDigest)) {
    return false;
  }
  switch (value.phase) {
    case "never-participated":
    case "excluded":
      return hasOnlyKeys(value, ["pluginId", "phase"]);
    case "join-requested":
    case "restoring":
      return hasOnlyKeys(value, [
        "pluginId",
        "phase",
        "operationId",
        "targetCatalogRevision",
        "targetBundleDigest",
      ]);
    case "participating":
      return hasOnlyKeys(value, [
        "pluginId",
        "phase",
        "joinedGeneration",
        "lastConfirmedLocalBundleDigest",
      ]);
    case "exit-requested":
      return hasOnlyKeys(value, [
        "pluginId",
        "phase",
        "operationId",
        "joinedGeneration",
        "lastConfirmedLocalBundleDigest",
      ]);
    case "blocked":
      return typeof value.blockedReason === "string"
        && value.blockedReason.trim().length > 0
        && hasOnlyKeys(value, [
          "pluginId",
          "phase",
          "operationId",
          "targetCatalogRevision",
          "targetBundleDigest",
          "blockedReason",
        ]);
    default:
      return false;
  }
}

function requirePluginId(value: string, ownPluginId: string): string {
  const normalized = normalizePluginIds([value], ownPluginId)[0];
  if (!normalized || normalized !== value) {
    throw new Error(`Device community-plugin ID is invalid: ${value}`);
  }
  return normalized;
}

function optionalOperationId(operationId: string | undefined):
  { operationId?: string } {
  if (operationId === undefined) return {};
  if (!operationId.trim()) {
    throw new Error("Device community-plugin operation ID is invalid");
  }
  return { operationId: operationId.trim() };
}

function optionalRevision(value: number | undefined):
  { targetCatalogRevision?: number } {
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Device community-plugin catalog revision is invalid");
  }
  return { targetCatalogRevision: value };
}

function optionalGeneration(value: number | undefined):
  { joinedGeneration?: number } {
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Device community-plugin generation is invalid");
  }
  return { joinedGeneration: value };
}

function optionalDigest<Key extends
  "targetBundleDigest" | "lastConfirmedLocalBundleDigest">(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  if (value === undefined) return {};
  if (!SHA256_PATTERN.test(value)) {
    throw new Error("Device community-plugin bundle digest is invalid");
  }
  return { [key]: value } as Partial<Record<Key, string>>;
}

function normalizedIdSet(
  values: readonly string[],
  ownPluginId: string,
): Set<string> {
  return new Set(normalizePluginIds(values, ownPluginId));
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined
    || (typeof value === "string" && value.trim().length > 0);
}

function isOptionalSafeInteger(value: unknown, minimum: number): boolean {
  return value === undefined
    || (Number.isSafeInteger(value) && Number(value) >= minimum);
}

function isOptionalDigest(value: unknown): boolean {
  return value === undefined
    || (typeof value === "string" && SHA256_PATTERN.test(value));
}

function sortPluginEntries(
  entries: Readonly<Record<string, DeviceCommunityPluginParticipationEntryV1>>,
): Record<string, DeviceCommunityPluginParticipationEntryV1> {
  return Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => compareText(left, right)),
  );
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
