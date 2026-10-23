import { describe, it, expect } from "vitest";
import { findOneDriveInvalidNameIssue } from "../src/onedrive/types";

describe("findOneDriveInvalidNameIssue", () => {
  it("detects a trailing question mark in a file name (the diagnosed ?= case)", () => {
    expect(findOneDriveInvalidNameIssue("🇦🇺澳大利亚十四日游.pdf?=")).not.toBeNull();
  });

  it("accepts ordinary names that OneDrive can store", () => {
    expect(findOneDriveInvalidNameIssue("note.md")).toBeNull();
    expect(findOneDriveInvalidNameIssue("行程安排.md")).toBeNull();
    expect(findOneDriveInvalidNameIssue("🇦🇺澳大利亚十四日游.pdf")).toBeNull();
  });

  it("detects each reserved punctuation character", () => {
    for (const char of ["\"", "*", ":", "<", ">", "?", "/", "\\", "|"]) {
      expect(findOneDriveInvalidNameIssue(`file${char}name`), `char=${char}`).not.toBeNull();
    }
  });

  it("detects a trailing dot or space, and ASCII control characters", () => {
    expect(findOneDriveInvalidNameIssue("name.")).not.toBeNull();
    expect(findOneDriveInvalidNameIssue("name ")).not.toBeNull();
    expect(findOneDriveInvalidNameIssue("a\u0001b")).not.toBeNull();
  });

  it("treats the slash sign as invalid inside a name (segmenting is the caller's job)", () => {
    // A single name may never contain `/`; the caller segments a path with
    // path.split("/") and applies this helper per segment.
    expect(findOneDriveInvalidNameIssue("a/b.md")).not.toBeNull();
    expect(findOneDriveInvalidNameIssue("folder?/ok.md")).not.toBeNull();
    // A Unicode folder name without reserved characters remains valid.
    expect(findOneDriveInvalidNameIssue("文件夹")).toBeNull();
  });

  it("returns the exact offending character for reserved punctuation", () => {
    expect(findOneDriveInvalidNameIssue("行程?安排.md")).toEqual({ kind: "char", char: "?" });
    expect(findOneDriveInvalidNameIssue("a:b.txt")).toEqual({ kind: "char", char: ":" });
    expect(findOneDriveInvalidNameIssue("a\"b.txt")).toEqual({ kind: "char", char: "\"" });
  });

  it("reports the first offending character of several", () => {
    expect(findOneDriveInvalidNameIssue("a?b:c")).toEqual({ kind: "char", char: "?" });
  });

  it("distinguishes trailing dot, trailing space and control characters", () => {
    expect(findOneDriveInvalidNameIssue("note.")).toEqual({ kind: "trailing-dot" });
    expect(findOneDriveInvalidNameIssue("note ")).toEqual({ kind: "trailing-space" });
    expect(findOneDriveInvalidNameIssue("a\u0001b")).toEqual({ kind: "control-char" });
  });

  it("returns null for names OneDrive can store", () => {
    expect(findOneDriveInvalidNameIssue("note.md")).toBeNull();
    expect(findOneDriveInvalidNameIssue("文件夹")).toBeNull();
    expect(findOneDriveInvalidNameIssue("🇦🇺澳大利亚十四日游.pdf")).toBeNull();
  });
});
