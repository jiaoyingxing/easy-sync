import { describe, expect, it } from "vitest";
import { describeError } from "../src/obsidian-compat";

describe("describeError", () => {
  it("returns the message of an Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("returns the message of an Error subclass", () => {
    class SyncFailure extends Error {
      constructor(message: string) {
        super(message);
        this.name = "SyncFailure";
      }
    }

    expect(describeError(new SyncFailure("subclass failure"))).toBe("subclass failure");
  });

  it("falls back to String(...) for non-Error values", () => {
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError(42)).toBe("42");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError(Symbol("token"))).toBe("Symbol(token)");
  });

  it("does not duck-type objects that merely have a message field", () => {
    expect(describeError({ message: "looks like an error" })).toBe("[object Object]");
  });
});
