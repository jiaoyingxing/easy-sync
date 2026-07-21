import type {
  CloudAnchorFixture,
  LocalEntryFixture,
  MigrationFixture,
  RemoteNodeFixture,
  V1BaseEntryFixture,
} from "../fixtures/state-v1-migration-cases";

export type MigrationFault = "none" | "interrupt-before-publish" | "save-failure";
export type ProhibitedMigrationMutation = "delete" | "move" | "rename" | "merge" | "upload" | "download";

export interface MigratedAnchor {
  anchorId: string;
  remoteId: string;
  lastPath: string;
  contentHash: string;
  size: number;
  remoteETag: string;
  confirmedBy: "v1-exact" | "v1-unique-content" | "cloud-verified";
}

export interface MigrationEnvelope {
  meta: { schemaVersion: 2; lifecycleEpoch: number; commitSeq: number };
  scope: { accountId: string; driveId: string; vaultFolderId: string; filesRootId: string };
  remoteIndex: {
    schemaVersion: 2;
    filesRootId: string;
    cursorRevision: number;
    deltaLink: null;
    complete: true;
    itemsById: Record<string, RemoteNodeFixture>;
  };
  anchors: { schemaVersion: 2; byAnchorId: Record<string, MigratedAnchor> };
}

export interface MigrationResult {
  status: "committed" | "aborted" | "interrupted";
  reason?: "scan-incomplete" | "remote-identity-incomplete" | "save-failure" | "interrupted";
  fullScanUsed: boolean;
  publishedEnvelope: MigrationEnvelope | null;
  stagedEnvelope: MigrationEnvelope | null;
  pending: Array<{ sourcePath: string; reason: string }>;
  mutations: ProhibitedMigrationMutation[];
  v1BackupRetained: true;
  legacyAutoSyncAllowed: boolean;
}

function sameCurrentPathAnchor(
  base: V1BaseEntryFixture,
  local: LocalEntryFixture[],
  remote: RemoteNodeFixture[],
): MigratedAnchor | null {
  const localEntry = local.find((entry) => entry.path === base.path);
  const remoteEntry = remote.find((entry) => entry.kind === "file" && entry.path === base.path);
  if (!localEntry || !remoteEntry?.id || !remoteEntry.eTag) return null;
  const localMatches = localEntry.hash === base.hash && localEntry.size === base.size;
  const remoteMatches = remoteEntry.eTag === base.eTag
    || remoteEntry.contentHash === base.hash;
  if (!localMatches || !remoteMatches) return null;
  return {
    anchorId: `migrated:${remoteEntry.id}`,
    remoteId: remoteEntry.id,
    lastPath: remoteEntry.path,
    contentHash: base.hash,
    size: base.size,
    remoteETag: remoteEntry.eTag,
    confirmedBy: "v1-exact",
  };
}

function uniqueContentAnchor(
  base: V1BaseEntryFixture,
  local: LocalEntryFixture[],
  remote: RemoteNodeFixture[],
): MigratedAnchor | null {
  const localCandidates = local.filter((entry) => entry.hash === base.hash && entry.size === base.size);
  const remoteCandidates = remote.filter((entry) =>
    entry.kind === "file"
    && !!entry.id
    && !!entry.eTag
    && entry.contentHash === base.hash
    && entry.size === base.size,
  );
  if (localCandidates.length !== 1 || remoteCandidates.length !== 1) return null;
  if (localCandidates[0]!.path !== remoteCandidates[0]!.path) return null;
  const remoteEntry = remoteCandidates[0]!;
  return {
    anchorId: `migrated:${remoteEntry.id}`,
    remoteId: remoteEntry.id,
    lastPath: remoteEntry.path,
    contentHash: base.hash,
    size: base.size,
    remoteETag: remoteEntry.eTag!,
    confirmedBy: "v1-unique-content",
  };
}

function verifiedCloudAnchor(
  hint: CloudAnchorFixture,
  local: LocalEntryFixture[],
  remote: RemoteNodeFixture[],
): MigratedAnchor | null {
  if (!hint.remoteId) return null;
  const localEntry = local.find((entry) => entry.path === hint.lastPath);
  const remoteEntry = remote.find((entry) => entry.id === hint.remoteId && entry.kind === "file");
  if (!localEntry || !remoteEntry?.eTag) return null;
  if (localEntry.hash !== hint.contentHash || localEntry.size !== hint.size) return null;
  if (remoteEntry.path !== hint.lastPath || remoteEntry.contentHash !== hint.contentHash) return null;
  return {
    anchorId: `cloud:${remoteEntry.id}`,
    remoteId: remoteEntry.id,
    lastPath: remoteEntry.path,
    contentHash: hint.contentHash,
    size: hint.size,
    remoteETag: remoteEntry.eTag,
    confirmedBy: "cloud-verified",
  };
}

export function simulateV1ToV2Migration(
  fixture: MigrationFixture,
  fault: MigrationFault = "none",
): MigrationResult {
  // Migration never trusts a V1 cursor, even when it still looks valid.
  const fullScanUsed = true;
  const baseResult = {
    fullScanUsed,
    pending: [] as Array<{ sourcePath: string; reason: string }>,
    mutations: [] as ProhibitedMigrationMutation[],
    v1BackupRetained: true as const,
  };

  if (!fixture.localScanComplete || !fixture.remoteScanComplete) {
    return {
      ...baseResult,
      status: "aborted",
      reason: "scan-incomplete",
      publishedEnvelope: null,
      stagedEnvelope: null,
      legacyAutoSyncAllowed: true,
    };
  }

  if (fixture.remote.some((entry) => !entry.id)) {
    return {
      ...baseResult,
      status: "aborted",
      reason: "remote-identity-incomplete",
      publishedEnvelope: null,
      stagedEnvelope: null,
      legacyAutoSyncAllowed: true,
    };
  }

  const anchors: Record<string, MigratedAnchor> = {};
  for (const base of fixture.v1Base) {
    const anchor = sameCurrentPathAnchor(base, fixture.local, fixture.remote)
      ?? uniqueContentAnchor(base, fixture.local, fixture.remote);
    if (anchor) {
      anchors[anchor.anchorId] = anchor;
    } else {
      baseResult.pending.push({ sourcePath: base.path, reason: "identity-not-unique-or-unverified" });
    }
  }
  for (const hint of fixture.cloudAnchors ?? []) {
    const anchor = verifiedCloudAnchor(hint, fixture.local, fixture.remote);
    if (anchor) {
      anchors[anchor.anchorId] = anchor;
    } else {
      baseResult.pending.push({ sourcePath: hint.lastPath, reason: "cloud-hint-not-verified" });
    }
  }

  const itemsById = Object.fromEntries(fixture.remote.map((entry) => [entry.id, entry]));
  const envelope: MigrationEnvelope = {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: fixture.v1Generation + 1,
      commitSeq: 1,
    },
    scope: {
      accountId: fixture.accountId,
      driveId: fixture.driveId,
      vaultFolderId: fixture.vaultFolderId,
      filesRootId: fixture.filesRootId,
    },
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: fixture.filesRootId,
      cursorRevision: 1,
      deltaLink: null,
      complete: true,
      itemsById,
    },
    anchors: { schemaVersion: 2, byAnchorId: anchors },
  };

  if (fault === "interrupt-before-publish") {
    return {
      ...baseResult,
      status: "interrupted",
      reason: "interrupted",
      publishedEnvelope: null,
      stagedEnvelope: envelope,
      legacyAutoSyncAllowed: true,
    };
  }
  if (fault === "save-failure") {
    return {
      ...baseResult,
      status: "aborted",
      reason: "save-failure",
      publishedEnvelope: null,
      stagedEnvelope: envelope,
      legacyAutoSyncAllowed: true,
    };
  }
  return {
    ...baseResult,
    status: "committed",
    publishedEnvelope: envelope,
    stagedEnvelope: null,
    legacyAutoSyncAllowed: false,
  };
}

export function v1BackupCleanupAllowed(input: {
  desktopHealthy: boolean;
  mobileHealthy: boolean;
  cloudBootstrapV2Published: boolean;
  recoveryJournalsEmpty: boolean;
}): boolean {
  return input.desktopHealthy
    && input.mobileHealthy
    && input.cloudBootstrapV2Published
    && input.recoveryJournalsEmpty;
}
