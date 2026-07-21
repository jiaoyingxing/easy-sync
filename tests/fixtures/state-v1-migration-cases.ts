export const HASH_A = "aa".repeat(32);
export const HASH_B = "bb".repeat(32);

export interface V1BaseEntryFixture {
  path: string;
  hash: string;
  size: number;
  eTag: string;
}

export interface LocalEntryFixture {
  path: string;
  hash: string;
  size: number;
}

export interface RemoteNodeFixture {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  kind: "file" | "folder";
  eTag?: string;
  size?: number;
  contentHash?: string;
}

export interface CloudAnchorFixture {
  remoteId?: string;
  lastPath: string;
  contentHash: string;
  size: number;
  remoteETag?: string;
}

export interface MigrationFixture {
  id: string;
  accountId: string;
  driveId: string;
  vaultFolderId: string;
  filesRootId: string;
  v1Generation: number;
  v1DeltaLink: string | null;
  deltaLinkValid: boolean;
  localScanComplete: boolean;
  remoteScanComplete: boolean;
  v1Base: V1BaseEntryFixture[];
  local: LocalEntryFixture[];
  remote: RemoteNodeFixture[];
  cloudAnchors?: CloudAnchorFixture[];
}

const root: RemoteNodeFixture = {
  id: "vault-root",
  parentId: null,
  name: "files",
  path: "",
  kind: "folder",
};

export const STATE_V1_MIGRATION_CASES: MigrationFixture[] = [
  {
    id: "normal-v1",
    accountId: "account-a",
    driveId: "drive-a",
    vaultFolderId: "vault-folder",
    filesRootId: "vault-root",
    v1Generation: 7,
    v1DeltaLink: "<delta-valid>",
    deltaLinkValid: true,
    localScanComplete: true,
    remoteScanComplete: true,
    v1Base: [{ path: "notes/a.md", hash: HASH_A, size: 10, eTag: "etag-a" }],
    local: [{ path: "notes/a.md", hash: HASH_A, size: 10 }],
    remote: [
      root,
      { id: "folder-notes", parentId: "vault-root", name: "notes", path: "notes", kind: "folder" },
      { id: "remote-a", parentId: "folder-notes", name: "a.md", path: "notes/a.md", kind: "file", eTag: "etag-a", size: 10 },
    ],
  },
  {
    id: "missing-drive-id",
    accountId: "account-a",
    driveId: "drive-a",
    vaultFolderId: "vault-folder",
    filesRootId: "vault-root",
    v1Generation: 2,
    v1DeltaLink: null,
    deltaLinkValid: true,
    localScanComplete: true,
    remoteScanComplete: true,
    v1Base: [{ path: "missing.md", hash: HASH_A, size: 5, eTag: "etag-missing" }],
    local: [{ path: "missing.md", hash: HASH_A, size: 5 }],
    remote: [
      root,
      { id: "", parentId: "vault-root", name: "missing.md", path: "missing.md", kind: "file", eTag: "etag-missing", size: 5 },
    ],
  },
  {
    id: "same-hash-multiple-paths",
    accountId: "account-a",
    driveId: "drive-a",
    vaultFolderId: "vault-folder",
    filesRootId: "vault-root",
    v1Generation: 3,
    v1DeltaLink: null,
    deltaLinkValid: true,
    localScanComplete: true,
    remoteScanComplete: true,
    v1Base: [{ path: "old.md", hash: HASH_A, size: 8, eTag: "etag-old" }],
    local: [
      { path: "copy-a.md", hash: HASH_A, size: 8 },
      { path: "copy-b.md", hash: HASH_A, size: 8 },
    ],
    remote: [
      root,
      { id: "remote-copy-a", parentId: "vault-root", name: "copy-a.md", path: "copy-a.md", kind: "file", eTag: "etag-copy-a", size: 8, contentHash: HASH_A },
      { id: "remote-copy-b", parentId: "vault-root", name: "copy-b.md", path: "copy-b.md", kind: "file", eTag: "etag-copy-b", size: 8, contentHash: HASH_A },
    ],
  },
  {
    id: "path-already-moved",
    accountId: "account-a",
    driveId: "drive-a",
    vaultFolderId: "vault-folder",
    filesRootId: "vault-root",
    v1Generation: 4,
    v1DeltaLink: "<delta-valid>",
    deltaLinkValid: true,
    localScanComplete: true,
    remoteScanComplete: true,
    v1Base: [{ path: "old/path.md", hash: HASH_A, size: 12, eTag: "etag-old" }],
    local: [{ path: "new/path.md", hash: HASH_A, size: 12 }],
    remote: [
      root,
      { id: "folder-new", parentId: "vault-root", name: "new", path: "new", kind: "folder" },
      { id: "remote-moved", parentId: "folder-new", name: "path.md", path: "new/path.md", kind: "file", eTag: "etag-new", size: 12, contentHash: HASH_A },
    ],
  },
  {
    id: "cloud-baseline-only",
    accountId: "account-a",
    driveId: "drive-a",
    vaultFolderId: "vault-folder",
    filesRootId: "vault-root",
    v1Generation: 0,
    v1DeltaLink: null,
    deltaLinkValid: true,
    localScanComplete: true,
    remoteScanComplete: true,
    v1Base: [],
    local: [{ path: "cloud.md", hash: HASH_B, size: 20 }],
    remote: [
      root,
      { id: "remote-cloud", parentId: "vault-root", name: "cloud.md", path: "cloud.md", kind: "file", eTag: "etag-cloud", size: 20, contentHash: HASH_B },
    ],
    cloudAnchors: [{ remoteId: "remote-cloud", lastPath: "cloud.md", contentHash: HASH_B, size: 20, remoteETag: "etag-cloud" }],
  },
  {
    id: "invalid-delta-link",
    accountId: "account-a",
    driveId: "drive-a",
    vaultFolderId: "vault-folder",
    filesRootId: "vault-root",
    v1Generation: 5,
    v1DeltaLink: "<delta-expired>",
    deltaLinkValid: false,
    localScanComplete: true,
    remoteScanComplete: true,
    v1Base: [{ path: "fresh.md", hash: HASH_B, size: 21, eTag: "etag-fresh" }],
    local: [{ path: "fresh.md", hash: HASH_B, size: 21 }],
    remote: [
      root,
      { id: "remote-fresh", parentId: "vault-root", name: "fresh.md", path: "fresh.md", kind: "file", eTag: "etag-fresh", size: 21 },
    ],
  },
];

export function migrationCase(id: string): MigrationFixture {
  const fixture = STATE_V1_MIGRATION_CASES.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`Missing migration fixture: ${id}`);
  return structuredClone(fixture);
}
