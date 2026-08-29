import { describe, expect, it } from "vitest";
import {
  classifyCdnDownloadFailure,
  cdnHostOfDownloadUrl,
  fingerprintCdnDownloadFailure,
} from "../src/onedrive/cdn-download-failure";

describe("classifyCdnDownloadFailure", () => {
  it("reports no error object as none", () => {
    expect(classifyCdnDownloadFailure(null)).toBe("none");
    expect(classifyCdnDownloadFailure(undefined)).toBe("none");
  });

  it.each([
    [{ status: 403 }, "http"],
    [{ statusCode: 500, message: "oops" }, "http"],
    [Object.assign(new Error("forbidden"), { status: 401 }), "http"],
  ] as const)("classifies an HTTP status-carrying error as http (%#)", (error, expected) => {
    expect(classifyCdnDownloadFailure(error)).toBe(expected);
  });

  it.each([
    "getaddrinfo ENOTFOUND my.microsoftpersonalcontent.com",
    "getaddrinfo EAI_AGAIN my.microsoftpersonalcontent.com",
    "queryA ENODATA my.microsoftpersonalcontent.com",
    "name not resolved",
  ])("classifies DNS-style messages as dns (%s)", (message) => {
    expect(classifyCdnDownloadFailure(new Error(message))).toBe("dns");
    expect(classifyCdnDownloadFailure({ message })).toBe("dns");
  });

  it.each([
    "error:14094410:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure",
    "unable to verify the first certificate",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "self-signed certificate in certificate chain",
  ])("classifies TLS-style messages as tls (%s)", (message) => {
    expect(classifyCdnDownloadFailure(new Error(message))).toBe("tls");
  });

  it.each([
    "connect ECONNREFUSED 1.2.3.4:443",
    "read ECONNRESET",
    "connect ENETUNREACH 1.2.3.4:443",
    "socket hang up with connection reset",
    "connect EHOSTUNREACH",
  ])("classifies TCP-style messages as tcp (%s)", (message) => {
    expect(classifyCdnDownloadFailure(new Error(message))).toBe("tcp");
  });

  it.each([
    "connect ETIMEDOUT 1.2.3.4:443",
    "ESOCKETTIMEDOUT",
    "request timed out",
    "timeout of 8000ms exceeded",
  ])("classifies timeout-style messages as timeout (%s)", (message) => {
    expect(classifyCdnDownloadFailure(new Error(message))).toBe("timeout");
  });

  it("classifies a no-signal transport failure as unknown", () => {
    expect(classifyCdnDownloadFailure(
      new Error("socket closed before response"),
    )).toBe("unknown");
    expect(classifyCdnDownloadFailure({ status: 0, message: "transport result unknown" }))
      .toBe("unknown");
  });
});

describe("cdnHostOfDownloadUrl", () => {
  it("returns the bare hostname without path, query or fragment", () => {
    expect(cdnHostOfDownloadUrl(
      "https://my.microsoftpersonalcontent.com/personal/abc/_layouts/15/download.aspx?tempauth=x&ct=1",
    )).toBe("my.microsoftpersonalcontent.com");
  });

  it("returns null for an invalid URL", () => {
    expect(cdnHostOfDownloadUrl("not a url")).toBeNull();
    expect(cdnHostOfDownloadUrl("")).toBeNull();
  });
});

describe("fingerprintCdnDownloadFailure", () => {
  it("returns null without an error object", () => {
    expect(fingerprintCdnDownloadFailure(null, { elapsedMs: 5, url: "https://download.example/f" }))
      .toBeNull();
  });

  it("carries stage, bare host and elapsed time", () => {
    const fingerprint = fingerprintCdnDownloadFailure(
      Object.assign(new Error("getaddrinfo ENOTFOUND download.example"), { status: 0 }),
      {
        elapsedMs: 42,
        url: "https://download.example/protocol-v2.json?token=secret",
      },
    );
    expect(fingerprint).toEqual({
      stage: "dns",
      host: "download.example",
      elapsedMs: 42,
    });
  });
});