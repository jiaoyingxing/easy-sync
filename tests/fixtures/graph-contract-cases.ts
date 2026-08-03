export type GraphContractEvidence = "official" | "live-required";

export const GRAPH_MUTATION_CONTRACTS = [
  {
    id: "small-put-create-only",
    evidence: "live-required" as GraphContractEvidence,
    expected: "An existing path must reject the request without replacing content.",
    reason: "The small-file PUT reference documents create-or-replace, but not a create-only precondition.",
  },
  {
    id: "upload-session-stale-if-match",
    evidence: "official" as GraphContractEvidence,
    expected: "A stale If-Match at session creation returns 412.",
  },
  {
    id: "upload-session-create-race",
    evidence: "official" as GraphContractEvidence,
    expected: "A competing item created before final commit returns 409.",
  },
  {
    id: "upload-session-interrupted",
    evidence: "official" as GraphContractEvidence,
    expected: "Completed fragments remain resumable until cancellation or expiry; an uncommitted target is not final.",
  },
] as const;

export const GRAPH_UPLOAD_SESSION_FIXTURES = {
  partialAccepted: {
    status: 202,
    body: {
      expirationDateTime: "<timestamp>",
      nextExpectedRanges: ["327680-"],
    },
  },
  sessionStatus: {
    status: 200,
    body: {
      expirationDateTime: "<timestamp>",
      nextExpectedRanges: ["327680-"],
    },
  },
  cancelled: { status: 204, body: {} },
  staleIfMatch: {
    status: 412,
    body: { error: { code: "preconditionFailed", message: "<redacted>" } },
  },
  finalNameConflict: {
    status: 409,
    body: { error: { code: "nameAlreadyExists", message: "<redacted>" } },
  },
} as const;

export interface DeltaFixtureItem {
  id: string;
  name?: string;
  eTag?: string;
  file?: Record<string, never>;
  folder?: Record<string, never>;
  deleted?: Record<string, never>;
  parentReference?: { id: string; path?: string };
}

export interface DeltaFixturePage {
  value: DeltaFixtureItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/**
 * Synthetic, redacted pages matching the service behaviors documented by the
 * Microsoft Graph delta reference: pagination, a repeated driveItem id whose
 * last occurrence wins, tombstones, and parentReference without path.
 */
export const GRAPH_DELTA_PAGES: DeltaFixturePage[] = [
  {
    value: [
      {
        id: "folder-moved",
        name: "Move Source",
        folder: {},
        parentReference: { id: "probe-root" },
      },
      {
        id: "file-repeat",
        name: "Case-Ä-中文 #%.md",
        eTag: "etag-before",
        file: {},
        parentReference: { id: "folder-source" },
      },
      {
        id: "file-deleted",
        deleted: {},
        parentReference: { id: "folder-source" },
      },
    ],
    "@odata.nextLink": "<next-link>",
  },
  {
    value: [
      {
        id: "file-repeat",
        name: "case-ä-中文 #%.md",
        eTag: "etag-after",
        file: {},
        parentReference: { id: "folder-target" },
      },
      {
        id: "folder-moved",
        name: "MOVE SOURCE RENAMED",
        folder: {},
        parentReference: { id: "probe-root" },
      },
      {
        id: "file-recreated-new-id",
        name: "case-ä-中文 #%.md",
        eTag: "etag-recreated",
        file: {},
        parentReference: { id: "folder-target" },
      },
    ],
    "@odata.deltaLink": "<delta-link>",
  },
];

export function collapseDeltaById(pages: DeltaFixturePage[]): Map<string, DeltaFixtureItem> {
  const result = new Map<string, DeltaFixtureItem>();
  for (const page of pages) {
    for (const item of page.value) result.set(item.id, item);
  }
  return result;
}
