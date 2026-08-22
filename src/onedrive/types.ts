/**
 * OneDrive / Microsoft Graph API Types
 * Subset focused on App Folder file operations for MVP.
 */

/** OneDrive driveItem (file or folder metadata) */
export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  file?: {
    mimeType?: string;
    hashes?: {
      quickXorHash?: string;
      sha1Hash?: string;
      sha256Hash?: string;
    };
  };
  folder?: { childCount?: number };
  parentReference?: {
    driveId?: string;
    id?: string;
    path?: string;
  };
  lastModifiedDateTime?: string;
  createdDateTime?: string;
  eTag?: string;
  cTag?: string;
  /** App Folder special folder marker */
  specialFolder?: { name?: string };
  /** Download URL for file content */
  "@microsoft.graph.downloadUrl"?: string;
  /** Delta token for change tracking */
  "@odata.deltaLink"?: string;
  "@odata.nextLink"?: string;
  /** Deleted marker in delta responses */
  deleted?: { state?: string };
}

/** Delta query response */
export interface DeltaResponse {
  value: DriveItem[];
  "@odata.deltaLink"?: string;
  "@odata.nextLink"?: string;
}

/** Stable Graph identities that define the remote side of one vault. */
export interface RemoteVaultScope {
  driveId: string;
  vaultFolderId: string;
  filesRootId: string;
}

/** Upload response for small file PUT */
export interface UploadResult {
  id: string;
  name: string;
  size: number;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  parentReference?: DriveItem["parentReference"];
}

/** Strict byte read-back for one immutable object below the plugin-control root. */
export interface CommunityPluginGenerationCloudObjectV1 {
  id: string;
  name: string;
  parentId: string;
  size: number;
  eTag: string;
  cTag: string;
  content: ArrayBuffer;
}

/** OneDrive-specific error types for classification */
export enum OneDriveErrorType {
  Unauthorized = "Unauthorized",
  Forbidden = "Forbidden",
  NotFound = "NotFound",
  Conflict = "Conflict",
  RateLimited = "RateLimited",
  InsufficientStorage = "InsufficientStorage",
  ServerError = "ServerError",
  NetworkError = "NetworkError",
  AuthExpired = "AuthExpired",
  PreconditionFailed = "PreconditionFailed",
  RangeNotSatisfiable = "RangeNotSatisfiable",
  Unknown = "Unknown",
}

export class OneDriveError extends Error {
  public readonly type: OneDriveErrorType;
  public readonly statusCode: number;
  public readonly retryAfterSeconds: number | null;
  public readonly graphCode: string | null;

  constructor(
    type: OneDriveErrorType,
    message: string,
    statusCode: number = 0,
    retryAfterSeconds: number | null = null,
    graphCode: string | null = null,
  ) {
    super(message);
    this.name = "OneDriveError";
    this.type = type;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.graphCode = graphCode;
  }
}

/** A client-side deadline elapsed while Obsidian's requestUrl promise may
 * still be running. This is not an HTTP response and must never be reported
 * as status 0 or used to authorize an in-call resend. */
export class SyntheticRequestTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly source: "deadline" | "prior-request-in-flight" = "deadline",
  ) {
    super(source === "deadline"
      ? `Request timed out after ${timeoutMs}ms`
      : `Previous requestUrl is still running after its ${timeoutMs}ms local deadline`);
    this.name = "SyntheticRequestTimeoutError";
  }
}

export type SharedSyncProtocolObservationComponent =
  | "directory"
  | "v2"
  | "v3";

/** Preserve which part of one logical V2+V3 observation failed without
 * making the Graph client responsible for protocol-lineage decisions. */
export class SharedSyncProtocolObservationError extends Error {
  constructor(
    public readonly component: SharedSyncProtocolObservationComponent,
    public readonly observationCause: unknown,
  ) {
    super(
      `Shared sync protocol ${component} observation failed: ${
        observationCause instanceof Error
          ? observationCause.message
          : String(observationCause)
      }`,
    );
    this.name = "SharedSyncProtocolObservationError";
  }
}

export type RemoteVaultScopeIdentityFailureReason =
  | "scope-incomplete"
  | "vault-folder-invalid"
  | "files-root-invalid"
  | "drive-invalid";

/** Stable client-side classification for committed Graph scope metadata that
 * was reachable but no longer represents the committed vault/files tree. */
export class RemoteVaultScopeIdentityError extends Error {
  constructor(
    readonly reason: RemoteVaultScopeIdentityFailureReason,
  ) {
    super(`Committed remote scope identity is invalid: ${reason}`);
    this.name = "RemoteVaultScopeIdentityError";
  }
}

/**
 * Encode a path for use in a Graph API URL.
 * Each path segment is encoded separately to preserve `/` separators.
 * Characters like #, ?, % in file/directory names would otherwise break the URL.
 */
function encodeUrlPath(path: string): string {
  return path.split("/").map((s) => encodeURIComponent(s)).join("/");
}

/**
 * Characters OneDrive / SharePoint does not accept in an item (file or folder)
 * name. Even when percent-encoded in a Graph URL (`%3F` for `?`, `%23` for `#`,
 * …), the server rejects the item because the decoded name is invalid, so the
 * request can never succeed regardless of client-side encoding.
 *
 * Surface (the `?` etc. literally break) plus trailing-space / trailing-dot /
 * reserved range that Microsoft documents as invalid in a file name.
 */
const ONE_DRIVE_INVALID_NAME_CHARACTERS = new Set([
  '"', "*", ":", "<", ">", "?", "/", "\\", "|",
]);

/** What exactly makes a OneDrive item name unacceptable. */
export type OneDriveInvalidNameIssue =
  /** A visible reserved character, e.g. `?`, `:`, `"`. The offending char is returned for display. */
  | { kind: "char"; char: string }
  /** The name ends with a dot (`.`), which OneDrive treats as an extension-signature. */
  | { kind: "trailing-dot" }
  /** The name ends with a space. */
  | { kind: "trailing-space" }
  /** An ASCII control character that cannot even be shown to the user. */
  | { kind: "control-char" };

/** Find the first reason a *name* (not path) can never be stored on OneDrive, or null when storable. */
export function findOneDriveInvalidNameIssue(fileName: string): OneDriveInvalidNameIssue | null {
  for (const char of fileName) {
    if (ONE_DRIVE_INVALID_NAME_CHARACTERS.has(char)) return { kind: "char", char };
  }
  // Reserved by OneDrive: a name may not end with a dot or a space, and may not
  // contain ASCII control characters.
  if (fileName.endsWith(".")) return { kind: "trailing-dot" };
  if (fileName.endsWith(" ")) return { kind: "trailing-space" };
  // eslint-disable-next-line no-control-regex -- the class intentionally spans ASCII control characters (U+0000-U+001F, U+007F), which OneDrive forbids in item names
  if (/[\u0000-\u001f\u007f]/.test(fileName)) return { kind: "control-char" };
  return null;
}

/** True when the file/directory *name* (not path) can never be stored on OneDrive. */
export function hasOneDriveInvalidNameCharacters(fileName: string): boolean {
  return findOneDriveInvalidNameIssue(fileName) !== null;
}

/** App Folder directory structure */
export const APP_FOLDER_PATHS = {
  /** App Folder root, accessed via /me/drive/special/approot */
  appRoot: "/me/drive/special/approot",
  /** Vault directory: /vaults/<vault-name>/ */
  vaultDir: (vaultName: string) =>
    `/me/drive/special/approot:/vaults/${encodeUrlPath(vaultName)}`,
  /** Files directory: /vaults/<vault-name>/files/ */
  filesDir: (vaultName: string) =>
    `/me/drive/special/approot:/vaults/${encodeUrlPath(vaultName)}/files`,
  /** Plugin state directory: /vaults/<vault-name>/.easy-sync/ */
  pluginDir: (vaultName: string) =>
    `/me/drive/special/approot:/vaults/${encodeUrlPath(vaultName)}/.easy-sync`,
  /** Immutable generation content below the plugin state directory. */
  pluginItem: (vaultName: string, relativePath: string) =>
    `/me/drive/special/approot:/vaults/${encodeUrlPath(vaultName)}/.easy-sync/${encodeUrlPath(relativePath)}`,
  /** Delta endpoint for files directory */
  filesDelta: (vaultName: string) =>
    `/me/drive/special/approot:/vaults/${encodeUrlPath(vaultName)}/files:/delta`,
  /** Single file: /vaults/<vault-name>/files/<path> */
  filePath: (vaultName: string, filePath: string) =>
    `/me/drive/special/approot:/vaults/${encodeUrlPath(vaultName)}/files/${encodeUrlPath(filePath)}`,
} as const;

/** Microsoft Graph base URL */
export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
