/**
 * EasySync i18n Types
 *
 * Defines the locale interface. Each locale file exports an object
 * conforming to this interface. English is the authoritative fallback.
 */

/** All user-visible strings in the plugin, keyed by semantic path */
export interface LocaleStrings {
  // ---- Status Bar ----
  "status.notLoggedIn": string;
  "status.connecting": string;
  "status.syncing": string;
  "status.conflicts": string;
  "status.pendingDeletes": string;
  "status.conflictsAndDeletes": string;
  "status.lastSync": string;
  "status.ready": string;

  // ---- Ribbon ----
  "ribbon.loggedOut": string;
  "ribbon.cancelling": string;
  "ribbon.syncing": string;
  "ribbon.syncingPhase": string;
  "ribbon.attention": string;
  "ribbon.success": string;
  "ribbon.ready": string;

  // ---- Settings Groups ----
  "settings.group.sync": string;
  "settings.group.maintenance": string;
  "settings.group.about": string;

  // ---- Settings ----
  "settings.account.name": string;
  "settings.account.desc.loggedIn": string;
  "settings.account.desc.notLoggedIn": string;
  "settings.account.desc.connecting": string;
  "settings.account.desc.pending": string;
  "settings.account.pendingTitle": string;
  "settings.account.pendingMessage": string;
  "settings.account.recheck": string;
  "settings.account.reopenAuth": string;
  "settings.account.loginSuccess": string;
  "settings.account.login": string;
  "settings.account.checking": string;
  "settings.account.logout": string;
  "settings.firstSync.name": string;
  "settings.firstSync.desc": string;
  "settings.firstSync.start": string;
  "settings.firstSync.sync": string;
  "settings.autoSync.name": string;
  "settings.autoSync.desc.disabled": string;
  "settings.autoSync.desc.enabled": string;
  "settings.autoSync.desc.paused": string;
  "settings.automaticHandling.button": string;
  "settings.automaticHandling.open": string;
  "settings.automaticHandling.name": string;
  "settings.automaticHandling.desc": string;
  "settings.automaticHandling.title": string;
  "settings.automaticHandling.intro": string;
  "settings.automaticHandling.autoDeleteLocalFiles.name": string;
  "settings.automaticHandling.autoDeleteLocalFiles.desc": string;
  "settings.automaticHandling.mergeNonOverlappingText.name": string;
  "settings.automaticHandling.mergeNonOverlappingText.desc": string;
  "settings.syncScope.name": string;
  "settings.syncScope.desc": string;
  "settings.syncScope.button": string;
  "settings.syncScope.title": string;
  "settings.syncExclusion.name": string;
  "settings.syncExclusion.desc": string;
  "settings.syncExclusion.button": string;
  "settings.syncExclusion.title": string;
  "settings.syncExclusion.intro": string;
  "settings.syncExclusion.folders.name": string;
  "settings.syncExclusion.add": string;
  "settings.syncExclusion.empty": string;
  "settings.syncExclusion.removeFolder": string;
  "settings.syncExclusion.pickerPlaceholder": string;
  "settings.syncPluginFiles.name": string;
  "settings.syncPluginFiles.desc": string;
  "settings.syncEditor.name": string;
  "settings.syncEditor.desc": string;
  "settings.syncAppearance.name": string;
  "settings.syncAppearance.desc": string;
  "settings.syncThemes.name": string;
  "settings.syncThemes.desc": string;
  "settings.syncHotkeys.name": string;
  "settings.syncHotkeys.desc": string;
  "settings.syncCorePlugins.name": string;
  "settings.syncCorePlugins.desc": string;
  "settings.syncCommunityPlugins.name": string;
  "settings.syncCommunityPlugins.desc": string;
  "settings.syncPluginData.name": string;
  "settings.syncPluginData.desc": string;
  "settings.diagLog.name": string;
  "settings.diagLog.desc": string;
  "settings.diagReport.name": string;
  "settings.diagReport.desc": string;
  "settings.diagReport.generate": string;
  "settings.syncInterval.name": string;
  "settings.syncInterval.desc": string;
  "settings.maxFileSize.name": string;
  "settings.maxFileSize.desc": string;
  "settings.reset.name": string;
  "settings.reset.desc": string;
  "settings.reset.button": string;
  "settings.reset.confirmTitle": string;
  "settings.reset.confirmMessage": string;
  "settings.reset.confirmWarning": string;
  "settings.reset.confirm": string;
  "settings.reset.done": string;
  "settings.about.product.name": string;
  "settings.about.product.desc": string;
  "settings.about.author.name": string;
  "settings.about.author.desc": string;
  "settings.about.contact.github": string;
  "settings.about.contact.xiaohongshu": string;
  "settings.about.usage.name": string;
  "settings.about.usage.desc": string;
  "settings.about.disclaimer.name": string;
  "settings.about.disclaimer.desc": string;

  // ---- Sync View ----
  "syncView.title": string;
  "syncView.lastSync": string;
  "syncView.never": string;
  "syncView.progress": string;
  "syncView.conflict.keepLocal": string;
  "syncView.conflict.keepRemote": string;
  "syncView.conflict.skip": string;
  "syncView.conflict.defaultReason": string;
  "syncView.delete.confirm": string;
  "syncView.delete.confirmAll": string;
  "syncView.delete.confirmAllTitle": string;
  "syncView.delete.confirmAllMessage": string;
  "syncView.delete.confirmAllWarning": string;
  "syncView.delete.reject": string;
  "syncView.delete.reason": string;

  // ---- Commands ----
  "command.syncNow": string;
  "command.showDetail": string;

  // ---- Sync Progress ----
  "progress.scanningLocal": string;
  "progress.preparingRemote": string;
  "progress.checkingRemote": string;
  "progress.loadingBaseline": string;
  "progress.generatingPlan": string;
  "progress.verifyingFiles": string;

  // ---- Sync Results ----
  "result.synced": string;
  "result.partial": string;
  "result.deferred": string;
  "result.firstSyncCancelled": string;
  "result.thresholdDeclined": string;
  "result.authExpired": string;
  "result.syncFailed": string;
  "result.alreadyRunning": string;
  "result.cancelled": string;
  "result.generationMismatch": string;
  "result.lockBusy": string;
  "result.scanIncomplete": string;
  "result.localRecoveryFailed": string;
  "result.legacyStateDisabled": string;

  // ---- Sync Lifecycle Notices ----
  "notice.sync.start": string;
  "notice.sync.stage": string;
  "notice.sync.progress": string;
  "notice.sync.cancelling": string;
  "notice.sync.completed": string;
  "notice.sync.conflicts": string;
  "notice.sync.review": string;
  "notice.sync.cancelled": string;
  "notice.sync.failed": string;
  "notice.sync.authExpired": string;
  "notice.accountMismatch": string;
  "notice.diagnosticReportGenerated": string;
  "notice.syncPathSettings.busy": string;
  "notice.syncPathSettings.recovery": string;
  "notice.syncPathSettings.failed": string;

  // ---- Sync Plan Reasons ----
  "reason.fileExceedsSizeLimit": string;
  "reason.newFileBothSides": string;
  "reason.localDeletedRemoteModified": string;
  "reason.fileDeletedLocally": string;
  "reason.remoteDeletedLocalModified": string;
  "reason.fileDeletedFromRemote": string;
  "reason.bothSidesModified": string;
  "reason.renameIdentityAmbiguous": string;
  "reason.scanUnhealthy": string;

  // ---- Auth Errors ----
  "auth.error.clientNotConfigured": string;
  "auth.error.stateMismatch": string;
  "auth.error.providerError": string;
  "auth.error.noCode": string;
  "auth.error.noRefreshToken": string;
  "auth.error.notLoggedIn": string;
  "auth.error.networkError": string;
  "auth.error.secretStorageUnavailable": string;
  "auth.error.refreshFailed": string;

  // ---- General ----
  "general.unknown": string;
  "general.notYetImplemented": string;


  // ---- Conflict/Delete Feedback Notices ----
  "notice.conflict.keptLocal": string;
  "notice.conflict.keptRemote": string;
  "notice.conflict.failed": string;
  "notice.conflict.downloadFailed": string;
  "notice.conflict.identical": string;
  "notice.localChangedSinceReview": string;
  "notice.localRecoveryFailed": string;
  "notice.sideActionRemotePrepareFailed": string;
  "notice.sideActionScopeChanged": string;
  "notice.sideActionMutationRecoveryFailed": string;
  "notice.configSyncDisabled": string;
  "notice.configSnapshotInvalid": string;
  "notice.decisionExpired": string;
  "notice.delete.confirmed": string;
  "notice.delete.rejected": string;
  "notice.delete.failed": string;

  // ---- Conflict Detail Modal ----
  "conflictDetail.title": string;
  "conflictDetail.modifiedTime": string;
  "conflictDetail.fileSize": string;
  "conflictDetail.localLabel": string;
  "conflictDetail.remoteLabel": string;
  "conflictDetail.newer": string;
  "conflictDetail.larger": string;
  "conflictDetail.localPreview": string;
  "conflictDetail.diffTitle": string;
  "conflictDetail.diffAdded": string;
  "conflictDetail.diffRemoved": string;
  "conflictDetail.summaryComparing": string;
  "conflictDetail.summaryComparisonUnavailable": string;
  "conflictDetail.summaryLocalExtra": string;
  "conflictDetail.summaryRemoteExtra": string;
  "conflictDetail.summaryBothModified": string;
  "conflictDetail.summaryBothExistDifferent": string;
  "conflictDetail.summaryDifferent": string;
  "conflictDetail.summaryBytesDifferentNoLineDiff": string;
  "conflictDetail.remoteComparisonUnavailable": string;
  "conflictDetail.loading": string;
  "conflictDetail.fetchingRemote": string;
  "conflictDetail.computingDiff": string;
  "conflictDetail.localReadUnavailable": string;
  "conflictDetail.loadUnavailable": string;
  "conflictDetail.binaryFile": string;
  "conflictDetail.diffRegionsLocated": string;
  "conflictDetail.diffChangeBudget": string;
  "conflictDetail.diffAlignmentLimit": string;
  "conflictDetail.diffDisplayBudget": string;
  "conflictDetail.diffRegionRange": string;
  "conflictDetail.diffOmitted": string;
  "conflictDetail.textDiffByteLimit": string;
  "conflictDetail.previewTruncated": string;
  "conflictDetail.identical": string;
  "conflictDetail.textSameBytesDifferent": string;

  // ---- Sync View extras ----
  "syncView.merge.autoMerged": string;
  "syncView.conflict.viewDetail": string;
  "syncView.conflict.processing": string;

  // ---- Sync Progress Display ----
  "syncView.fileStatus.upload": string;
  "syncView.fileStatus.download": string;
  "syncView.fileStatus.delete": string;
  "syncView.fileStatus.conflict": string;
  "syncView.fileStatus.skip": string;
  "syncView.fileStatus.deferred": string;
  "syncView.fileStatus.error": string;
  "syncView.progress.current": string;
  "syncView.progress.items": string;
  "syncView.progress.completed": string;
  "syncView.cancelSync": string;
  "syncView.cancelling": string;
  "syncView.active.upload": string;
  "syncView.active.download": string;
  "syncView.active.delete": string;
  "syncView.active.rename": string;
  "syncView.failure.contentUnavailable": string;
  "syncView.failure.network": string;
  "syncView.failure.rateLimited": string;
  "syncView.failure.storageFull": string;
  "syncView.failure.authExpired": string;
  "syncView.failure.remote": string;
  "syncView.failure.local": string;
  "syncView.status.synced": string;
  "syncView.issues.title": string;
  "syncView.issues.notSynced": string;
  "syncView.issues.lastAttempt": string;
  "syncView.issues.openFile": string;
  "syncView.issues.retry": string;
  "syncView.issues.awaitingConfirmation": string;
  "syncView.collapseAll": string;
  "syncView.expandAll": string;
  "syncView.history.title": string;
  "syncView.openSettings": string;
  "syncView.history.empty": string;
  "syncView.history.omitted": string;
  "syncView.history.status.success": string;
  "syncView.history.status.partial": string;
  "syncView.history.status.cancelled": string;
  "syncView.history.status.authExpired": string;
  "syncView.history.status.failed": string;
  "syncView.history.mode.manual": string;
  "syncView.history.mode.auto": string;
  "syncView.history.mode.first": string;
  "syncView.history.duration": string;

  // ---- Confirm Modal ----
  "confirm.firstSyncTitle": string;
  "confirm.thresholdTitle": string;
  "confirm.confirm": string;
  "confirm.cancel": string;
  "confirm.deleteWarning": string;

  // ---- Sync Plan Alert & Review ----
  "syncPlan.readyTitle": string;
  "syncPlan.readyMessage": string;
  "syncPlan.viewButton": string;
  "syncPlan.sectionTitle": string;
  "syncPlan.confirmExecute": string;
  "syncPlan.recalculate": string;
  "syncPlan.detailsUnavailable": string;
  "syncPlan.noChanges": string;

  // ---- Status Bar Plan Review ----
  "status.planReview": string;

  // ---- Paused for Review ----
  "result.pausedForReview": string;
}

/** Language tag to locale mapping */
export type LocaleMap = Record<string, LocaleStrings>;
