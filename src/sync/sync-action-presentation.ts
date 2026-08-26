import type { LocaleStrings } from "../i18n/types";
import { SyncActionType } from "./types";

export type SyncActionGroup =
  | "remotePreparation"
  | "upload"
  | "download"
  | "folderCreate"
  | "moveRename"
  | "delete"
  | "conflict"
  | "deferred"
  | "skip"
  | "authExpired";

export type SyncActionActivityKind =
  | "preparing"
  | "uploading"
  | "downloading"
  | "creating"
  | "renaming"
  | "deleting"
  | "conflicting"
  | "deferring"
  | "skipping"
  | "authExpired";

export type SyncActionProgressStatus =
  | "upload"
  | "download"
  | "folder"
  | "delete"
  | "conflict"
  | "skip"
  | "error";

export interface SyncActionPresentation {
  group: SyncActionGroup;
  groupLabelKey: keyof LocaleStrings;
  groupOrder: number;
  labelKey: keyof LocaleStrings;
  activeLabelKey: keyof LocaleStrings;
  activityKind: SyncActionActivityKind;
  progressStatus: SyncActionProgressStatus;
  icon: string;
}

export function resolveSyncActionPresentation(
  type: SyncActionType,
): SyncActionPresentation {
  switch (type) {
    case SyncActionType.RecreateRemoteScope:
      return action(
        "remotePreparation",
        "syncAction.group.remotePreparation",
        0,
        "syncAction.recreateRemoteScope.label",
        "syncAction.recreateRemoteScope.active",
        "preparing",
        "folder",
        "cloud-upload",
      );
    case SyncActionType.Upload:
      return action(
        "upload",
        "syncAction.group.upload",
        1,
        "syncAction.upload.label",
        "syncAction.upload.active",
        "uploading",
        "upload",
        "arrow-up",
      );
    case SyncActionType.Download:
      return action(
        "download",
        "syncAction.group.download",
        2,
        "syncAction.download.label",
        "syncAction.download.active",
        "downloading",
        "download",
        "arrow-down",
      );
    case SyncActionType.CreateRemoteFolder:
      return action(
        "folderCreate",
        "syncAction.group.folderCreate",
        3,
        "syncAction.createRemoteFolder.label",
        "syncAction.createRemoteFolder.active",
        "creating",
        "folder",
        "folder-up",
      );
    case SyncActionType.CreateLocalFolder:
      return action(
        "folderCreate",
        "syncAction.group.folderCreate",
        3,
        "syncAction.createLocalFolder.label",
        "syncAction.createLocalFolder.active",
        "creating",
        "folder",
        "folder-down",
      );
    case SyncActionType.MoveRemoteFolder:
      return action(
        "moveRename",
        "syncAction.group.moveRename",
        4,
        "syncAction.moveRemoteFolder.label",
        "syncAction.moveRemoteFolder.active",
        "renaming",
        "folder",
        "folder-input",
      );
    case SyncActionType.MoveLocalFolder:
      return action(
        "moveRename",
        "syncAction.group.moveRename",
        4,
        "syncAction.moveLocalFolder.label",
        "syncAction.moveLocalFolder.active",
        "renaming",
        "folder",
        "folder-output",
      );
    case SyncActionType.RenameRemote:
      return action(
        "moveRename",
        "syncAction.group.moveRename",
        4,
        "syncAction.renameRemote.label",
        "syncAction.renameRemote.active",
        "renaming",
        "upload",
        "move",
      );
    case SyncActionType.MoveLocalFile:
      return action(
        "moveRename",
        "syncAction.group.moveRename",
        4,
        "syncAction.moveLocalFile.label",
        "syncAction.moveLocalFile.active",
        "renaming",
        "download",
        "move",
      );
    case SyncActionType.DeleteRemoteFolder:
      return action(
        "delete",
        "syncAction.group.delete",
        5,
        "syncAction.deleteRemoteFolder.label",
        "syncAction.deleteRemoteFolder.active",
        "deleting",
        "delete",
        "folder-x",
      );
    case SyncActionType.DeleteLocalFolder:
      return action(
        "delete",
        "syncAction.group.delete",
        5,
        "syncAction.deleteLocalFolder.label",
        "syncAction.deleteLocalFolder.active",
        "deleting",
        "delete",
        "folder-x",
      );
    case SyncActionType.DeleteRemote:
      return action(
        "delete",
        "syncAction.group.delete",
        5,
        "syncAction.deleteRemote.label",
        "syncAction.deleteRemote.active",
        "deleting",
        "delete",
        "trash-2",
      );
    case SyncActionType.DeleteLocal:
      return action(
        "delete",
        "syncAction.group.delete",
        5,
        "syncAction.deleteLocal.label",
        "syncAction.deleteLocal.active",
        "deleting",
        "delete",
        "trash-2",
      );
    case SyncActionType.ConfirmLocalDelete:
      return action(
        "delete",
        "syncAction.group.delete",
        5,
        "syncAction.confirmLocalDelete.label",
        "syncAction.confirmLocalDelete.active",
        "deleting",
        "conflict",
        "circle-help",
      );
    case SyncActionType.Conflict:
      return action(
        "conflict",
        "syncAction.group.conflict",
        6,
        "syncAction.conflict.label",
        "syncAction.conflict.active",
        "conflicting",
        "conflict",
        "triangle-alert",
      );
    case SyncActionType.RetryLater:
      return action(
        "deferred",
        "syncAction.group.deferred",
        7,
        "syncAction.retryLater.label",
        "syncAction.retryLater.active",
        "deferring",
        "skip",
        "rotate-cw",
      );
    case SyncActionType.FolderDeferred:
      return action(
        "deferred",
        "syncAction.group.deferred",
        7,
        "syncAction.folderDeferred.label",
        "syncAction.folderDeferred.active",
        "deferring",
        "skip",
        "folder-clock",
      );
    case SyncActionType.SkipLargeFile:
      return action(
        "skip",
        "syncAction.group.skip",
        8,
        "syncAction.skipLargeFile.label",
        "syncAction.skipLargeFile.active",
        "skipping",
        "skip",
        "circle-slash-2",
      );
    case SyncActionType.SkipIgnoredPath:
      return action(
        "skip",
        "syncAction.group.skip",
        8,
        "syncAction.skipIgnoredPath.label",
        "syncAction.skipIgnoredPath.active",
        "skipping",
        "skip",
        "circle-slash-2",
      );
    case SyncActionType.SkipOneDriveInvalidName:
      return action(
        "skip",
        "syncAction.group.skip",
        8,
        "syncAction.skipOneDriveInvalidName.label",
        "syncAction.skipOneDriveInvalidName.active",
        "skipping",
        "skip",
        "circle-slash-2",
      );
    case SyncActionType.AuthExpired:
      return action(
        "authExpired",
        "syncAction.group.authExpired",
        9,
        "syncAction.authExpired.label",
        "syncAction.authExpired.active",
        "authExpired",
        "error",
        "log-in",
      );
    default:
      return assertNever(type);
  }
}

function action(
  group: SyncActionGroup,
  groupLabelKey: keyof LocaleStrings,
  groupOrder: number,
  labelKey: keyof LocaleStrings,
  activeLabelKey: keyof LocaleStrings,
  activityKind: SyncActionActivityKind,
  progressStatus: SyncActionProgressStatus,
  icon: string,
): SyncActionPresentation {
  return {
    group,
    groupLabelKey,
    groupOrder,
    labelKey,
    activeLabelKey,
    activityKind,
    progressStatus,
    icon,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled sync action type: ${String(value)}`);
}
