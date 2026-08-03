import {
  type BaseFileEntry,
  type LocalFileEntry,
  type RemoteFileEntry,
  SyncActionType,
  type SyncPlan,
  type SyncPlanItem,
} from "../../src/sync/types";

/**
 * Independent behavior snapshot of the ordinary anchored-file classification
 * in the public 1.1.3 SyncEngine.
 *
 * Source: easy-sync-public tag 1.1.3
 * Commit: 01a4ac30936a89c53ddbf521e7ea9399d71e79c4
 * src/sync/sync-engine.ts SHA-256:
 * ad708214a0421025889cd334f8d3e91b885b7df4747d55ecd425fe8a2a8aa581
 * src/sync/sync-executor.ts SHA-256:
 * d24af74247d08256454c14524559fcc7e03e0a65b3e9c2ee6475c70dca8fdde5
 *
 * Keep this fixture independent from the active V2 planner. It is deliberately
 * scoped to the anchored ordinary-file states needed to verify mixed-version
 * reentry; it is not a complete copy of the released planner.
 */
export const PUBLIC_113_REENTRY_PROVENANCE = Object.freeze({
  sourceCommit: "01a4ac30936a89c53ddbf521e7ea9399d71e79c4",
  syncEngineSha256:
    "ad708214a0421025889cd334f8d3e91b885b7df4747d55ecd425fe8a2a8aa581",
  syncExecutorSha256:
    "d24af74247d08256454c14524559fcc7e03e0a65b3e9c2ee6475c70dca8fdde5",
});

export function buildPublic113AnchoredFilePlan(input: {
  path: string;
  local?: LocalFileEntry;
  remote?: RemoteFileEntry;
  base: BaseFileEntry;
}): SyncPlan {
  const item = classifyPublic113AnchoredFile(input);
  return {
    items: item ? [item] : [],
    lastTotalFiles: 1,
    confirmed: false,
  };
}

function classifyPublic113AnchoredFile(input: {
  path: string;
  local?: LocalFileEntry;
  remote?: RemoteFileEntry;
  base: BaseFileEntry;
}): SyncPlanItem | null {
  const {
    path,
    local,
    remote,
    base,
  } = input;
  const localChanged = Boolean(
    local && (local.hash !== base.hash || local.size !== base.size),
  );
  const remoteChanged = Boolean(
    remote && (
      remote.sha256Hash
        ? !remoteContentMatchesBase(remote, base)
        : remote.eTag !== base.eTag
    ),
  );

  if (!local && remote) {
    if (remoteChanged) {
      return {
        type: SyncActionType.Conflict,
        path,
        remote,
        reason: "reason.localDeletedRemoteModified",
      };
    }
    return {
      type: SyncActionType.DeleteRemote,
      path,
      remote,
      reason: "reason.fileDeletedLocally",
    };
  }

  if (local && !remote) {
    if (localChanged) {
      return {
        type: SyncActionType.Conflict,
        path,
        local,
        reason: "reason.remoteDeletedLocalModified",
      };
    }
    return {
      type: SyncActionType.ConfirmLocalDelete,
      path,
      local,
      reason: "reason.fileDeletedFromRemote",
    };
  }

  if (!local && !remote) return null;

  if (local && remote) {
    if (localChanged && remoteChanged) {
      return {
        type: SyncActionType.Conflict,
        path,
        local,
        remote,
        reason: "reason.bothSidesModified",
      };
    }
    if (localChanged && !remoteChanged) {
      return {
        type: SyncActionType.Upload,
        path,
        local,
        remote,
        baseEtag: base.eTag,
      };
    }
    if (!localChanged && remoteChanged) {
      return {
        type: SyncActionType.Download,
        path,
        local,
        remote,
      };
    }
  }

  return null;
}

function remoteContentMatchesBase(
  remote: RemoteFileEntry,
  base: BaseFileEntry,
): boolean {
  return Boolean(
    remote.sha256Hash
      && remote.size === base.size
      && remote.sha256Hash.toLowerCase() === base.hash,
  );
}
