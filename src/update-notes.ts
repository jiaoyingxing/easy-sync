/**
 * Release-notes reader for the sidebar update row (2026-11-27).
 *
 * The version check only learns "a newer stable release exists"; this module
 * reads that release's public notes so the row can show them inline. It is
 * deliberately prompt-only in the same sense as `update-check.ts`: notes are
 * rendered, never downloaded as plugin files, and failures degrade to an
 * inline retry / browser exit instead of a Notice.
 *
 * Transport: GitHub's public Releases API. No token, no headers, no telemetry;
 * the request runs only when the update row actually renders, and the caller
 * caches one result per `latest` version. The API is a single source (unlike
 * the version check's raw + jsDelivr pair) because a failure is visible in the
 * row and the browser link remains a usable fallback.
 */
import { isNewerVersion, isStableVersion, withTimeout } from "./update-check";

/** One pending stable release, in the order the row shows them. */
export interface UpdateReleaseNote {
  version: string;
  body: string;
}

/** What the inline notes block renders right now. */
export type UpdateNotesDisplayState =
  | { status: "loading" }
  | { status: "ready"; notes: readonly UpdateReleaseNote[] }
  | { status: "empty" }
  | { status: "error" };

interface UpdateNotesFetcher {
  (opts: { url: string; method?: string }): Promise<{
    status: number;
    text: string;
  }>;
}

const UPDATE_NOTES_TIMEOUT_MS = 15_000;

/** First page is enough for the usual one-or-few-versions-behind case. */
const UPDATE_NOTES_URL =
  "https://api.github.com/repos/jiaoyingxing/easy-sync/releases?per_page=30";

const RELEASE_PAGE_BASE =
  "https://github.com/jiaoyingxing/easy-sync/releases/tag/";

export function releasePageUrl(version: string): string {
  return `${RELEASE_PAGE_BASE}${encodeURIComponent(version)}`;
}

/**
 * Parse the Releases API payload. A non-array payload is a failure (null);
 * malformed entries inside a valid array are skipped so one odd release
 * cannot blank the whole block. Drafts, prereleases and non-stable tags are
 * never part of the update prompt. Duplicate tags keep the first entry.
 */
export function parseUpdateReleaseNotes(
  text: string,
): UpdateReleaseNote[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const notes: UpdateReleaseNote[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.draft === true || record.prerelease === true) continue;
    const tag = record.tag_name;
    if (typeof tag !== "string" || !isStableVersion(tag)) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    notes.push({
      version: tag,
      body: typeof record.body === "string" ? record.body : "",
    });
  }
  return notes;
}

/**
 * Pending releases for the installed running version: strictly newer than
 * `current`, never newer than the prompt's `latest`, newest first. The upper
 * bound keeps a release published between the version check and this read out
 * of a row that still says the older `latest`.
 */
export function selectPendingUpdateNotes(
  notes: readonly UpdateReleaseNote[],
  current: string,
  latest: string,
): UpdateReleaseNote[] {
  return notes
    .filter((note) =>
      isNewerVersion(note.version, current)
      && (note.version === latest || isNewerVersion(latest, note.version)),
    )
    .sort((a, b) => {
      if (isNewerVersion(a.version, b.version)) return -1;
      if (isNewerVersion(b.version, a.version)) return 1;
      return 0;
    });
}

/**
 * Fetch and select the notes for `current < tag <= latest`. Every failure is
 * null (the row shows retry + browser); a successful read with no pending
 * notes is an empty array (the row shows the "no notes" line).
 */
export async function fetchPendingUpdateNotes(
  fetcher: UpdateNotesFetcher,
  current: string,
  latest: string,
): Promise<UpdateReleaseNote[] | null> {
  try {
    const response = await withTimeout(
      fetcher({ url: UPDATE_NOTES_URL, method: "GET" }),
      UPDATE_NOTES_TIMEOUT_MS,
    );
    if (response.status < 200 || response.status >= 300) return null;
    const notes = parseUpdateReleaseNotes(response.text);
    if (notes === null) return null;
    return selectPendingUpdateNotes(notes, current, latest);
  } catch {
    return null;
  }
}

/** Cache/error facts the main instance holds for one latest version. */
interface UpdateNotesStateInput {
  latest: string;
  cache: { latest: string; notes: readonly UpdateReleaseNote[] } | null;
  error: { latest: string } | null;
}

/**
 * Cache wins over a stale error marker for another version. The no-record
 * case reports loading because the caller starts the request immediately
 * after asking.
 */
export function resolveUpdateNotesDisplayState(
  input: UpdateNotesStateInput,
): UpdateNotesDisplayState {
  if (input.cache?.latest === input.latest) {
    return input.cache.notes.length > 0
      ? { status: "ready", notes: input.cache.notes }
      : { status: "empty" };
  }
  if (input.error?.latest === input.latest) return { status: "error" };
  return { status: "loading" };
}
