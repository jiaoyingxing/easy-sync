/**
 * Failure-stage classification for Microsoft CDN pre-signed download
 * requests (shared sync protocol slot content reads).
 *
 * The transport layer surfaces DNS, TLS, TCP and timeout failures as an
 * error without any HTTP status; Obsidian's requestUrl error shape gives us
 * only the raw message and an optional status. These helpers classify the
 * observable evidence at the diagnostic boundary so a real-device or
 * real-network report can tell which layer failed and whether the
 * pre-signed host itself was reachable. They never change control flow.
 *
 * Both error vocabularies are recognized: Node-style codes (ENOTFOUND,
 * ECONNRESET) and Chromium network names (net::ERR_*). A message in neither
 * vocabulary stays "unknown" — the staging is evidence, not a guess.
 */

export type CdnDownloadFailureStage =
  /** No error object. */
  | "none"
  /** An HTTP status was received (the error carries status > 0). */
  | "http"
  /** DNS name resolution failure (getaddrinfo / ENOTFOUND / EAI_* family). */
  | "dns"
  /** TLS/SSL handshake or certificate failure. */
  | "tls"
  /** TCP-level failure (reset / refused / unreachable). */
  | "tcp"
  /** Network timeout or local deadline. */
  | "timeout"
  /** Transport failure without a recognizable signal. */
  | "unknown";

const DNS_MESSAGE_PATTERN =
  /getaddrinfo|enotfound|eai_again|eai_noname|eai_nodata|eai_fail|eai_service|name or service not known|name not resolved|no address associated|enodata|eservfail|net::err_(name_not_resolved|name_resolution_failed|icann_name_collision)/i;

// TLS also covers the Chromium forms via the "ssl" and "cert_" substrings
// (net::ERR_SSL_PROTOCOL_ERROR, net::ERR_CERT_AUTHORITY_INVALID).
const TLS_MESSAGE_PATTERN =
  /ssl|tls|certificate|cert_|unable to verify|handshake|self[ _-]?signed|leaf[ _-]?signature|eproto/i;

// Chromium's connection/"address"/"socket"/"quic" families; a connection
// timeout lands here (tcp layer) rather than under "timeout".
const TCP_MESSAGE_PATTERN =
  /econnreset|epipe|econnrefused|enetunreach|ehostunreach|enetdown|ehostdown|enotconn|econnaborted|eaddrinuse|eaddrnotavail|connection reset|connection refused|connection aborted|net::err_(connection_[a-z0-9_]*|address_[a-z0-9_]*|socket_[a-z0-9_]*|quic_[a-z0-9_]*)/i;

const TIMEOUT_MESSAGE_PATTERN =
  /etimedout|esockettimedout|timed? ?out|timeout|deadline|net::err_timed_out/i;

function rawErrorText(error: unknown): { message: string; status: number } {
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    return {
      message: error.message || "",
      status: typeof record.status === "number" && record.status > 0
        ? record.status
        : typeof record.statusCode === "number" && record.statusCode > 0
          ? record.statusCode
          : 0,
    };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      message: typeof record.message === "string" ? record.message : "",
      status: typeof record.status === "number" && record.status > 0
        ? record.status
        : typeof record.statusCode === "number" && record.statusCode > 0
          ? record.statusCode
          : 0,
    };
  }
  return { message: "", status: 0 };
}

export function classifyCdnDownloadFailure(error: unknown): CdnDownloadFailureStage {
  if (error == null) return "none";
  const { message, status } = rawErrorText(error);
  if (status > 0) return "http";
  if (DNS_MESSAGE_PATTERN.test(message)) return "dns";
  if (TLS_MESSAGE_PATTERN.test(message)) return "tls";
  if (TCP_MESSAGE_PATTERN.test(message)) return "tcp";
  if (TIMEOUT_MESSAGE_PATTERN.test(message)) return "timeout";
  return "unknown";
}

/** Hostname of a pre-signed download URL; null when the URL is invalid. */
export function cdnHostOfDownloadUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export interface CdnDownloadFailureFingerprint {
  stage: CdnDownloadFailureStage;
  /** Generic pre-signed host example: my.microsoftpersonalcontent.com — no
   *  URL, query, token or account identifier. */
  host: string | null;
  elapsedMs: number;
}

/** Structured fingerprint for a slot content read failure; null only when
 *  there is no error object. The staging is evidence-class, not a verdict:
 *  "unknown" means no recognizable signal was present. */
export function fingerprintCdnDownloadFailure(
  error: unknown,
  context: { elapsedMs: number; url: string },
): CdnDownloadFailureFingerprint | null {
  const stage = classifyCdnDownloadFailure(error);
  if (stage === "none") return null;
  return {
    stage,
    host: cdnHostOfDownloadUrl(context.url),
    elapsedMs: context.elapsedMs,
  };
}