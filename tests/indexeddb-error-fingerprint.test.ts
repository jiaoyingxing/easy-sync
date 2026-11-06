import { describe, expect, it } from "vitest";
import {
  classifyIndexedDbError,
  fingerprintIndexedDbError,
} from "../src/sync/indexeddb-error-fingerprint";

describe("classifyIndexedDbError", () => {
  it("classifies the iOS WebKit auto-committed transaction error by message", () => {
    const error = new Error(
      "Attempt to delete range from database without an in-progress transaction",
    );
    expect(classifyIndexedDbError(error)).toBe("webkit-transaction");
  });

  it("classifies UnknownError / TransactionInactiveError as webkit-transaction", () => {
    const unknown = new Error("The request failed");
    unknown.name = "UnknownError";
    expect(classifyIndexedDbError(unknown)).toBe("webkit-transaction");

    const inactive = new Error("transaction is inactive");
    inactive.name = "TransactionInactiveError";
    expect(classifyIndexedDbError(inactive)).toBe("webkit-transaction");
  });

  it("classifies other IndexedDB-family errors separately", () => {
    for (const name of [
      "AbortError",
      "ConstraintError",
      "DataError",
      "InvalidStateError",
      "NotFoundError",
      "QuotaExceededError",
      "ReadOnlyError",
      "VersionError",
    ]) {
      const error = new Error("db error");
      error.name = name;
      expect(classifyIndexedDbError(error)).toBe("indexeddb");
    }
  });

  it("does not misclassify unrelated platform errors as retryable database errors", () => {
    expect(classifyIndexedDbError(new TypeError("x is not a function")))
      .toBe("other");
    expect(classifyIndexedDbError(new Error("Request timed out after 15000ms")))
      .toBe("other");
    expect(classifyIndexedDbError(new Error("Precondition failed")))
      .toBe("other");
    expect(classifyIndexedDbError(null)).toBe("none");
    expect(classifyIndexedDbError(undefined)).toBe("none");
    expect(classifyIndexedDbError("plain string")).toBe("other");
  });

  it("classifies a host-wrapped adapter failure through its cause chain", () => {
    // Obsidian adapter failures surface as "Unable to delete file" with the
    // database error attached as the cause.
    const wrapped = new Error("Unable to delete file", {
      cause: new DOMException(
        "Attempt to delete range from database without an in-progress transaction",
        "UnknownError",
      ),
    });
    expect(classifyIndexedDbError(wrapped)).toBe("webkit-transaction");
  });

  it("keeps an unrelated cause unrelated", () => {
    const wrapped = new TypeError("cannot read properties of undefined", {
      cause: new Error("Precondition failed"),
    });
    expect(classifyIndexedDbError(wrapped)).toBe("other");
  });
});

describe("fingerprintIndexedDbError", () => {
  it("returns null for non-database errors to keep ordinary diag details unchanged", () => {
    expect(fingerprintIndexedDbError(new TypeError("boom"))).toBeNull();
    expect(fingerprintIndexedDbError(null)).toBeNull();
    expect(fingerprintIndexedDbError("plain string")).toBeNull();
  });

  it("exposes message, kind, name and the first stack frame for database errors", () => {
    const error = new Error(
      "Attempt to delete range from database without an in-progress transaction",
    );
    const fingerprint = fingerprintIndexedDbError(error);
    expect(fingerprint).not.toBeNull();
    expect(fingerprint!.dbErrorKind).toBe("webkit-transaction");
    expect(fingerprint!.message).toContain("in-progress transaction");
    expect(fingerprint!.name).toBe("Error");
    expect(typeof fingerprint!.stackFirstFrame).toBe("string");
  });

  it("reads name and stack from a DOMException that is not an Error instance", () => {
    // WebKit raises IndexedDB failures as DOMException; the first stack frame
    // is the only field that tells the adapter layer apart from the store.
    const domError = {
      name: "UnknownError",
      message: "Attempt to delete range from database without an in-progress transaction",
      stack: [
        "writeRecord@plugin:main.js:1200:16",
        "delete@[native code]",
      ].join("\n"),
    };
    const fingerprint = fingerprintIndexedDbError(domError);
    expect(fingerprint).not.toBeNull();
    expect(fingerprint!.dbErrorKind).toBe("webkit-transaction");
    expect(fingerprint!.name).toBe("UnknownError");
    expect(fingerprint!.stackFirstFrame).toContain("writeRecord");
  });

  it("points name and stack at the wrapped database error, not the host wrapper", () => {
    const wrapped = new Error("Unable to delete file", {
      cause: {
        name: "UnknownError",
        message: "Attempt to delete range from database without an in-progress transaction",
        stack: "at removeRecord (plugin:main.js:900:8)",
      },
    });
    const fingerprint = fingerprintIndexedDbError(wrapped);
    expect(fingerprint).not.toBeNull();
    expect(fingerprint!.dbErrorKind).toBe("webkit-transaction");
    expect(fingerprint!.message).toBe("Unable to delete file");
    expect(fingerprint!.name).toBe("UnknownError");
    expect(fingerprint!.stackFirstFrame).toContain("removeRecord");
  });
});