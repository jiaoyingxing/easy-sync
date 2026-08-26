import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import {
  resolveSyncActionPresentation,
  type SyncActionGroup,
} from "../src/sync/sync-action-presentation";
import { SyncProgressStore } from "../src/sync/sync-progress";
import { SyncActionType } from "../src/sync/types";

const EXPECTED: Record<
  SyncActionType,
  { group: SyncActionGroup; zh: string; en: string }
> = {
  [SyncActionType.Upload]: { group: "upload", zh: "上传", en: "Upload" },
  [SyncActionType.Download]: { group: "download", zh: "下载", en: "Download" },
  [SyncActionType.RecreateRemoteScope]: {
    group: "remotePreparation",
    zh: "准备云端同步目录",
    en: "Prepare remote sync folder",
  },
  [SyncActionType.CreateRemoteFolder]: {
    group: "folderCreate",
    zh: "创建云端文件夹",
    en: "Create remote folder",
  },
  [SyncActionType.CreateLocalFolder]: {
    group: "folderCreate",
    zh: "创建本机文件夹",
    en: "Create local folder",
  },
  [SyncActionType.MoveRemoteFolder]: {
    group: "moveRename",
    zh: "移动/重命名云端文件夹",
    en: "Move/Rename remote folder",
  },
  [SyncActionType.MoveLocalFolder]: {
    group: "moveRename",
    zh: "移动/重命名本机文件夹",
    en: "Move/Rename local folder",
  },
  [SyncActionType.DeleteRemoteFolder]: {
    group: "delete",
    zh: "删除云端文件夹",
    en: "Delete remote folder",
  },
  [SyncActionType.DeleteLocalFolder]: {
    group: "delete",
    zh: "删除本机文件夹",
    en: "Delete local folder",
  },
  [SyncActionType.MoveLocalFile]: {
    group: "moveRename",
    zh: "移动/重命名本机文件",
    en: "Move/Rename local file",
  },
  [SyncActionType.FolderDeferred]: {
    group: "deferred",
    zh: "延后文件夹变更",
    en: "Defer folder change",
  },
  [SyncActionType.DeleteRemote]: {
    group: "delete",
    zh: "删除云端文件",
    en: "Delete remote file",
  },
  [SyncActionType.DeleteLocal]: {
    group: "delete",
    zh: "删除本机文件",
    en: "Delete local file",
  },
  [SyncActionType.ConfirmLocalDelete]: {
    group: "delete",
    zh: "确认删除本机文件",
    en: "Confirm local file deletion",
  },
  [SyncActionType.RenameRemote]: {
    group: "moveRename",
    zh: "移动/重命名云端文件",
    en: "Move/Rename remote file",
  },
  [SyncActionType.Conflict]: {
    group: "conflict",
    zh: "冲突",
    en: "Conflict",
  },
  [SyncActionType.SkipLargeFile]: {
    group: "skip",
    zh: "跳过大文件",
    en: "Skip large file",
  },
  [SyncActionType.SkipIgnoredPath]: {
    group: "skip",
    zh: "跳过已忽略路径",
    en: "Skip ignored path",
  },
  [SyncActionType.SkipOneDriveInvalidName]: {
    group: "skip",
    zh: "跳过无法同步的文件名",
    en: "Skip unsyncable file name",
  },
  [SyncActionType.RetryLater]: {
    group: "deferred",
    zh: "稍后重试",
    en: "Retry later",
  },
  [SyncActionType.AuthExpired]: {
    group: "authExpired",
    zh: "登录过期",
    en: "Login expired",
  },
};

describe("sync action presentation", () => {
  it("maps every SyncActionType to one bilingual user-visible action", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const actionTypes = Object.values(SyncActionType);

    expect(Object.keys(EXPECTED)).toHaveLength(actionTypes.length);
    for (const type of actionTypes) {
      const presentation = resolveSyncActionPresentation(type);
      expect(presentation.group).toBe(EXPECTED[type].group);
      expect(zh.t(presentation.labelKey)).toBe(EXPECTED[type].zh);
      expect(en.t(presentation.labelKey)).toBe(EXPECTED[type].en);
      expect(zh.t(presentation.activeLabelKey)).not.toBe(presentation.activeLabelKey);
      expect(en.t(presentation.activeLabelKey)).not.toBe(presentation.activeLabelKey);
      expect(presentation.icon).not.toBe("");
    }
  });

  it("keeps direction and object identity in move/rename activity labels", () => {
    const zh = new I18n("zh-cn");
    const labels = [
      SyncActionType.MoveRemoteFolder,
      SyncActionType.MoveLocalFolder,
      SyncActionType.RenameRemote,
      SyncActionType.MoveLocalFile,
    ].map((type) =>
      zh.t(resolveSyncActionPresentation(type).activeLabelKey));

    expect(labels).toEqual([
      "正在移动或重命名云端文件夹…",
      "正在移动或重命名本机文件夹…",
      "正在移动或重命名云端文件…",
      "正在移动或重命名本机文件…",
    ]);
  });

  it("keeps coarse progress status subordinate to the exact action type", () => {
    for (const type of Object.values(SyncActionType)) {
      expect(SyncProgressStore.actionToStatus(type))
        .toBe(resolveSyncActionPresentation(type).progressStatus);
    }
    expect(SyncProgressStore.actionToStatus(SyncActionType.RetryLater)).toBe("skip");
    expect(SyncProgressStore.actionToStatus(SyncActionType.FolderDeferred)).toBe("skip");
    expect(SyncProgressStore.actionToStatus(SyncActionType.AuthExpired)).toBe("error");
  });

  it("uses a short truthful run result instead of zero-valued file-only counts", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    expect(zh.t("result.synced", {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    })).toBe("同步完成");
    expect(en.t("result.synced", {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    })).toBe("Sync complete");
    expect(zh.t("result.conflictsPending", { conflicts: 2 }))
      .toBe("本轮有 2 项冲突待处理");
    expect(en.t("result.conflictsPending", { conflicts: 2 }))
      .toBe("2 conflict(s) still need attention");
    expect(zh.t("result.skipped", { skipped: 3 }))
      .toBe("本轮有 3 项未同步，请查看详情");
    expect(en.t("result.skipped", { skipped: 3 }))
      .toBe("3 item(s) were not synced. See details.");
  });
});
