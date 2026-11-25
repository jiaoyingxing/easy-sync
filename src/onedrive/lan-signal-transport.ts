/**
 * OneDrive-backed LAN signaling transport (S2b2, experimental).
 *
 * This module is the only bridge between the provider-neutral S2b1 signaling
 * contract and the Graph client. It accepts exactly the two registered C0
 * paths (`.easy-sync/lan-pairing-v1.json` and `.easy-sync/lan-signal/**`),
 * maps create-only/CAS to Graph preconditions, and keeps all signaling traffic
 * out of file-transfer metrics. Every other `.easy-sync` path is rejected
 * before a request is made.
 */

import {
  LAN_PAIRING_PATH,
  LAN_SIGNAL_ROOT,
  LanSignalPreconditionError,
  type LanSignalTransport,
  type LanSignalWriteOptions,
} from "../sync/lan-signaling";
import { LAN_PRESENCE_REQUEST_PATH } from "../sync/lan-presence";
import type { OneDriveClient } from "./client";
import { OneDriveError, OneDriveErrorType } from "./types";

/** Upper bound for one signaling control file (pairing or one session record). */
export const MAX_LAN_SIGNAL_CONTROL_BYTES = 256 * 1024;

/** Exact non-session control records this transport may touch (C0 members). */
const EXACT_CONTROL_PATHS = new Set<string>([
  LAN_PAIRING_PATH,
  LAN_PRESENCE_REQUEST_PATH,
]);
const SIGNAL_FILES = new Set([
  "offer.json",
  "answer.json",
  "host-candidates.json",
  "joiner-candidates.json",
  "closed.json",
]);
const SESSION_ID = /^[a-f0-9]{32}$/;
const CONTROL_PREFIX = ".easy-sync/";

/** One observed top-level signaling transport operation. */
export interface LanSignalTransportOperation {
  method: "read" | "write" | "delete" | "list";
  /** Exact control path (never contains a room secret). */
  path: string;
  outcome: "ok" | "missing" | "precondition" | "error";
  latencyMs: number;
  statusCode?: number;
}

/** Optional dev/diagnostic sink; it must not log record contents. */
export interface LanSignalTransportObserver {
  onOperation?(event: LanSignalTransportOperation): void;
}

/**
 * Build the real `.easy-sync` transport for one vault.
 *
 * `client` must be authenticated and initialized for `vaultName`; a missing
 * parent collection is created lazily by `writeText`.
 */
export function createOneDriveLanSignalTransport(
  client: OneDriveClient,
  vaultName: string,
  observer?: LanSignalTransportObserver,
): LanSignalTransport {
  // One pass per transport: a transport instance serves exactly one session
  // attempt, so this is "ensure once per handshake", not "assume forever".
  const folderState = { ensured: false };
  return {
    readText: (path) => {
      assertLanSignalObjectPath(path);
      return observe(
        observer,
        "read",
        path,
        async () => {
          const object = await client.readPluginControlText(
            vaultName,
            toControlRelativePath(path),
            MAX_LAN_SIGNAL_CONTROL_BYTES,
            "LAN signal",
          );
          return object === null
            ? null
            : { path, eTag: object.eTag, text: object.text };
        },
        (result) => result === null ? "missing" : "ok",
      );
    },

    writeText: (path, text, options) => {
      assertLanSignalObjectPath(path);
      assertWriteOptions(options);
      return observe(
        observer,
        "write",
        path,
        async () => {
          const relativePath = toControlRelativePath(path);
          await ensureParentFolder(client, vaultName, relativePath, folderState);
          const written = await client.writePluginControlText(
            vaultName,
            relativePath,
            text,
            options,
          );
          return { path, eTag: written.eTag };
        },
      );
    },

    delete: (path, options) => {
      assertLanSignalObjectPath(path);
      return observe(
        observer,
        "delete",
        path,
        () => client.deletePluginControlItem(
          vaultName,
          toControlRelativePath(path),
          options?.ifMatch,
        ),
        (deleted) => deleted ? "ok" : "missing",
      );
    },

    listPaths: (prefix) => {
      if (prefix !== `${LAN_SIGNAL_ROOT}/`) {
        throw new Error("LAN signal listing is limited to the signaling root");
      }
      return observe(
        observer,
        "list",
        prefix,
        async () => {
          const children = await client.listPluginControlChildren(
            vaultName,
            "lan-signal",
          );
          return children
            .filter((child) => typeof child.name === "string" && child.name.length > 0)
            .map((child) => `${LAN_SIGNAL_ROOT}/${child.name}`);
        },
      );
    },
  };
}

function assertLanSignalObjectPath(path: string): void {
  if (EXACT_CONTROL_PATHS.has(path)) return;
  const prefix = `${LAN_SIGNAL_ROOT}/`;
  if (!path.startsWith(prefix)) {
    throw new Error("LAN signal path is outside the registered control paths");
  }
  if (path === `${prefix}active.json`) return;
  const segments = path.slice(prefix.length).split("/");
  if (
    segments.length !== 2
    || !SESSION_ID.test(segments[0])
    || !SIGNAL_FILES.has(segments[1])
  ) {
    throw new Error("LAN signal path is outside the registered control paths");
  }
}

function assertWriteOptions(options?: LanSignalWriteOptions): void {
  if (options?.createOnly === true && options.ifMatch !== undefined) {
    throw new Error("LAN signal write cannot be both create-only and If-Match");
  }
}

function toControlRelativePath(path: string): string {
  if (!path.startsWith(CONTROL_PREFIX)) {
    throw new Error("LAN signal path is outside .easy-sync");
  }
  return path.slice(CONTROL_PREFIX.length);
}

/**
 * Ensure the parent collection exists, at most once per transport instance.
 *
 * Every signaling write used to PUT-create its parent chain first, and on an
 * established session every one of those PUTs answered 409 "already exists".
 * With a ~1.4 s control-plane RTT that is pure latency on the critical path of
 * a handshake: six of them in one measured connect. The directories belong to
 * the room, not to a record, so one successful pass per transport (one per
 * session attempt) is enough; a later 404/409 from a concurrent cleanup is
 * handled by the write's own fallback.
 */
async function ensureParentFolder(
  client: OneDriveClient,
  vaultName: string,
  relativePath: string,
  state: { ensured: boolean },
): Promise<void> {
  if (state.ensured) return;
  const segments = relativePath.split("/");
  segments.pop();
  if (segments.length === 0) {
    state.ensured = true;
    return;
  }
  await client.ensurePluginControlFolder(vaultName, segments.join("/"));
  state.ensured = true;
}

async function observe<T>(
  observer: LanSignalTransportObserver | undefined,
  method: LanSignalTransportOperation["method"],
  path: string,
  run: () => Promise<T>,
  outcomeOf?: (result: T) => LanSignalTransportOperation["outcome"],
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    observer?.onOperation?.({
      method,
      path,
      outcome: outcomeOf?.(result) ?? "ok",
      latencyMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const precondition = isPreconditionFailure(error);
    observer?.onOperation?.({
      method,
      path,
      outcome: precondition ? "precondition" : "error",
      latencyMs: Date.now() - startedAt,
      statusCode: error instanceof OneDriveError ? error.statusCode : undefined,
    });
    if (precondition) throw new LanSignalPreconditionError();
    throw error;
  }
}

function isPreconditionFailure(error: unknown): boolean {
  return error instanceof OneDriveError
    && (
      error.type === OneDriveErrorType.Conflict
      || error.type === OneDriveErrorType.PreconditionFailed
    );
}
