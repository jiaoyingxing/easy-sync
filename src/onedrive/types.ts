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

/**
 * Encode a path for use in a Graph API URL.
 * Each path segment is encoded separately to preserve `/` separators.
 * Characters like #, ?, % in file/directory names would otherwise break the URL.
 */
function encodeUrlPath(path: string): string {
  return path.split("/").map((s) => encodeURIComponent(s)).join("/");
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
  /** Delta endpoint for files directory */
  filesDelta: (vaultName: string) =>
    `/me/drive/special/approot:/vaults/${encodeUrlPath(vaultName)}/files:/delta`,
  /** Single file: /vaults/<vault-name>/files/<path> */
  filePath: (vaultName: string, filePath: string) =>
    `/me/drive/special/approot:/vaults/${encodeUrlPath(vaultName)}/files/${encodeUrlPath(filePath)}`,
} as const;

/** Microsoft Graph base URL */
export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
