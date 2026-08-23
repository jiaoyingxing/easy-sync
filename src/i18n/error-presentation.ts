/**
 * Known-error presentation.
 *
 * Layers (see the project error-status copy rules):
 *  - user-facing main message: localized human text (this module);
 *  - stable code: the raw English Error.message itself (kept verbatim in
 *    diagnostic logs via diag.error, unchanged by this module);
 *  - unknown errors: returned as null so callers keep the raw message —
 *    never guess a cause for an unmapped error.
 *
 * English users always receive the raw message: `presentKnownError` returns
 * null for the file/internal tables when the locale is English, so the
 * English locale never displays template placeholders or fabricated copy.
 */

import type { LocaleStrings } from "./types";

export type PresentT = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export type PresentLocale = "en" | "zh-cn";

interface KnownErrorPattern {
  key: keyof LocaleStrings;
  /** Literal prefix of the raw Error.message (the stable code). */
  prefix: string;
}

const KNOWN_PLUGIN_ERROR_PATTERNS: readonly KnownErrorPattern[] = [
  {
    key: "error.present.plugin.identityAmbiguous",
    prefix: "Selected plugin identity is ambiguous: ",
  },
  {
    key: "error.present.plugin.identityChangedInDirectory",
    prefix: "Selected plugin manifest identity changed within directory: ",
  },
  {
    key: "error.present.plugin.manifestUnreadable",
    prefix: "Selected plugin manifest is unreadable: ",
  },
  {
    key: "error.present.plugin.manifestIdentityInvalid",
    prefix: "Selected plugin manifest identity is invalid: ",
  },
  {
    key: "error.present.plugin.manifestVersionInvalid",
    prefix: "Selected plugin manifest version is missing or invalid: ",
  },
  {
    key: "error.present.plugin.manifestMinAppVersionInvalid",
    prefix: "Selected plugin minimum app version is invalid: ",
  },
  {
    key: "error.present.plugin.bundleIncompleteLocal",
    prefix: "Selected plugin bundle is incomplete locally: ",
  },
  {
    key: "error.present.plugin.bundleIncompleteRemote",
    prefix: "Selected plugin bundle is incomplete remotely: ",
  },
  {
    key: "error.present.plugin.downgradeRemote",
    prefix: "Selected plugin upload would downgrade remote bundle: ",
  },
  {
    key: "error.present.plugin.manifestDownloadFailed",
    prefix: "Selected plugin manifest download failed: ",
  },
  {
    key: "error.present.plugin.localTargetChanged",
    prefix: "Selected plugin local target changed: ",
  },
];

const INCOMPATIBLE_PREFIX = "Selected plugin bundle is incompatible (";

const INCOMPATIBLE_KINDS: Record<string, keyof LocaleStrings> = {
  downgrade: "error.present.plugin.incompatibleDowngrade",
  "desktop-only": "error.present.plugin.incompatibleDesktopOnly",
  "minimum-app-version": "error.present.plugin.incompatibleMinAppVersion",
};

/**
 * User-meaningful file / recovery operation failures. Ordered by prefix
 * length (longest first) so overlapping prefixes (e.g. the generic catalog
 * prefix vs its member variants) match the most specific row.
 */
const KNOWN_FILE_ERROR_PATTERNS: readonly KnownErrorPattern[] = [
  { key: "error.present.file.pluginBundleRemoteProofIncomplete", prefix: "Community plugin bundle remote proof is incomplete: " },
  { key: "error.present.file.pluginBundleRemoteFactsChanged", prefix: "Community plugin bundle remote facts changed: " },
  { key: "error.present.file.pluginBundleLocalSourceChanged", prefix: "Community plugin bundle local source changed: " },
  { key: "error.present.file.pluginBundleLocalFactsChanged", prefix: "Community plugin bundle local facts changed: " },
  { key: "error.present.file.catalogItemAnotherDrive", prefix: "Remote plugin catalog item belongs to another drive" },
  { key: "error.present.file.catalogScopeChanged", prefix: "Remote plugin catalog scope changed during refresh" },
  { key: "error.present.file.catalogMemberInvalid", prefix: "Remote plugin catalog member facts are invalid: " },
  { key: "error.present.file.catalogMemberNoVersion", prefix: "Remote plugin catalog member has no version: " },
  { key: "error.present.file.catalogScopeInvalid", prefix: "Remote plugin catalog scope is invalid" },
  { key: "error.present.file.catalogPathMissing", prefix: "Remote plugin catalog path is missing: " },
  // 动态字段校验（Remote plugin catalog {field} is invalid）及未来未知
  // catalog 串继续由该通配前缀兜底；可枚举的具体串都在上行列出。
  { key: "error.present.file.catalogFieldInvalid", prefix: "Remote plugin catalog " },
  { key: "error.present.file.downloadTempVerification", prefix: "Downloaded temp file verification failed: " },
  { key: "error.present.file.downloadSizeMismatch", prefix: "Downloaded size mismatch: " },
  { key: "error.present.file.downloadHashMismatch", prefix: "Downloaded SHA-256 mismatch: " },
  { key: "error.present.file.downloadTargetVerification", prefix: "Downloaded target verification failed: " },
  { key: "error.present.file.localMergedCommit", prefix: "Local adapter cannot commit a merged file safely: " },
  { key: "error.present.file.configMoveFolder", prefix: "Local adapter cannot move a config folder safely: " },
  { key: "error.present.file.configMoveFile", prefix: "Local adapter cannot move a config file safely: " },
  { key: "error.present.file.emptyFolderRestoreReadback", prefix: "Local empty-folder restore read-back failed: " },
  { key: "error.present.file.localIdentityBeforeMove", prefix: "Local file identity changed before move: " },
  { key: "error.present.file.localMoveReadback", prefix: "Local file move read-back failed: " },
  { key: "error.present.file.trashMove", prefix: "Local folder cannot be moved to trash safely: " },
  { key: "error.present.file.folderMissingRemoteIdentity", prefix: "Local folder create has no remote identity: " },
  { key: "error.present.file.localFolderDeleteReadback", prefix: "Local folder delete read-back failed: " },
  { key: "error.present.file.localFolderIdentityBeforeMove", prefix: "Local folder identity changed before move: " },
  { key: "error.present.file.folderNotConfirmedEmpty", prefix: "Local folder is not confirmed empty: " },
  { key: "error.present.file.localFolderMoveReadback", prefix: "Local folder move read-back failed: " },
  { key: "error.present.file.localMergeVerify", prefix: "Local version could not be verified after automatic merge: " },
  { key: "error.present.file.writeLocalVerify", prefix: "Local version could not be verified before write: " },
  { key: "error.present.file.mergeVerify", prefix: "Merged local version could not be verified: " },
  { key: "error.present.file.autoMergeRemoteReadback", prefix: "Automatic merge remote read-back failed: " },
  { key: "error.present.file.uploadMissingVersion", prefix: "Upload response is missing stable identity/version: " },
  { key: "error.present.file.remoteCacheMissingParent", prefix: "Remote cache upsert is missing parent identity: " },
  { key: "error.present.file.remoteEmptyFolderDeleteReadback", prefix: "Remote empty-folder delete read-back failed: " },
  { key: "error.present.file.remoteMoveLostIdentity", prefix: "Remote file move lost its identity: " },
  { key: "error.present.file.remoteFileMoveReadback", prefix: "Remote file move read-back failed: " },
  { key: "error.present.file.remoteFolderDeleteReadback", prefix: "Remote folder delete read-back failed: " },
  { key: "error.present.file.remoteFolderIdentityIncomplete", prefix: "Remote folder identity is incomplete: " },
  { key: "error.present.file.remoteFolderMoveReadback", prefix: "Remote folder move read-back failed: " },
  { key: "error.present.file.remoteFolderReadbackIncomplete", prefix: "Remote folder read-back is incomplete: " },
  { key: "error.present.file.remoteRecreateParentChanged", prefix: "Remote folder recreate parent changed: " },
  { key: "error.present.file.remoteIdentityIncomplete", prefix: "Remote identity incomplete: " },
  { key: "error.present.file.recoveryReviewSizeChanged", prefix: "Remote recovery review size changed: " },
  { key: "error.present.file.recoveryReviewChanged", prefix: "Remote recovery review changed: " },
  { key: "error.present.file.folderLocationNoIntent", prefix: "Reviewed folder location did not create a folder intent: " },
  { key: "error.present.file.folderLocationSourceChanged", prefix: "Reviewed folder location source changed: " },
  { key: "error.present.file.subtreeDeleteReadback", prefix: "Reviewed remote subtree delete read-back failed: " },
  { key: "error.present.file.subtreeDeleteReceiptIncomplete", prefix: "Reviewed subtree delete receipt is incomplete: " },
  { key: "error.present.file.subtreeDeleteSourceChanged", prefix: "Reviewed subtree delete source changed: " },
  { key: "error.present.file.subtreeDeleteRootChanged", prefix: "Reviewed subtree delete root changed: " },
  { key: "error.present.file.scopeRecoveryItemDisappeared", prefix: "V2 scope recovery remote item disappeared: " },
  { key: "error.present.file.pluginDownloadNoSource", prefix: "Selected plugin download has no source: " },
  { key: "error.present.file.pluginManifestEncoding", prefix: "Selected plugin manifest is not canonical UTF-8: " },
  { key: "error.present.file.missingInitializedScope", prefix: "Missing initialized vault scope: " },
  { key: "error.present.file.missingDriveIdentity", prefix: "Missing drive identity for vault: " },
  { key: "error.present.file.mutationAlreadyPending", prefix: "Mutation already pending for path: " },
  { key: "error.present.file.recoveryVerifyFailed", prefix: "Recovery verification failed: " },
  { key: "error.present.file.recoverySourceMissing", prefix: "Recovery source missing: " },
  { key: "error.present.file.protectedConfigDelete", prefix: "Protected config folder cannot be deleted by folder sync: " },
];

/**
 * Internal invariant / assertion failures. Never translated row-by-row:
 * they carry no user action and mis-attribution is worse than a neutral
 * summary. The raw message stays in diagnostic logs as the stable code.
 */
const INTERNAL_ERROR_PREFIXES: readonly string[] = [
  "V2 ",
  "Manual mutation ",
  "Mutation ",
  "Remote hierarchy ",
  "Shared sync protocol ",
  "sealed generation ",
  "Generation restore ",
  "Unsupported ",
  "Unhandled ",
];

/**
 * Map a known community-plugin bundle error message to its localized
 * user-facing text. Returns null for unknown messages so callers fall back
 * to the raw message (stable code + original details).
 */
export function presentKnownPluginBundleError(
  message: string,
  t: PresentT,
): string | null {
  if (message.startsWith(INCOMPATIBLE_PREFIX)) {
    const rest = message.slice(INCOMPATIBLE_PREFIX.length);
    const close = rest.indexOf("): ");
    if (close < 0) return null;
    const kind = rest.slice(0, close);
    const pluginId = rest.slice(close + 3).trim();
    const key = INCOMPATIBLE_KINDS[kind];
    if (!key) return null;
    return t(key, { pluginId });
  }
  for (const pattern of KNOWN_PLUGIN_ERROR_PATTERNS) {
    if (!message.startsWith(pattern.prefix)) continue;
    const pluginId = message.slice(pattern.prefix.length).trim();
    return t(pattern.key, { pluginId });
  }
  return null;
}

/**
 * Map known file / recovery operation errors and internal invariant
 * failures. English users keep the raw message (this returns null), so the
 * English locale never shows template placeholders or fabricated copy.
 */
export function presentKnownFileError(
  message: string,
  t: PresentT,
  locale: PresentLocale,
): string | null {
  if (locale === "en") return null;
  for (const pattern of KNOWN_FILE_ERROR_PATTERNS) {
    if (message.startsWith(pattern.prefix)) return t(pattern.key);
  }
  for (const prefix of INTERNAL_ERROR_PREFIXES) {
    if (message.startsWith(prefix)) return t("error.present.internal");
  }
  return null;
}

/**
 * Single entry point used by failureReason: plugin bundle errors first
 * (parameterized, both locales), then file / recovery and internal errors
 * (localized main messages, English pass-through).
 */
export function presentKnownError(
  message: string,
  t: PresentT,
  locale: PresentLocale,
): string | null {
  return presentKnownPluginBundleError(message, t)
    ?? presentKnownFileError(message, t, locale);
}