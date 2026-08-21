import { describe, it, expect } from "vitest";
import {
  findOneDriveInvalidNameIssue,
  hasOneDriveInvalidNameCharacters,
} from "../src/onedrive/types";

describe("hasOneDriveInvalidNameCharacters", () => {
  it("detects a trailing question mark in a file name (the diagnosed ?= case)", () => {
    expect(hasOneDriveInvalidNameCharacters("🇦🇺澳大利亚十四日游.pdf?=")).toBe(true);
  });

  it("accepts ordinary names that OneDrive can store", () => {
    expect(hasOneDriveInvalidNameCharacters("note.md")).toBe(false);
    expect(hasOneDriveInvalidNameCharacters("行程安排.md")).toBe(false);
    expect(hasOneDriveInvalidNameCharacters("🇦🇺澳大利亚十四日游.pdf")).toBe(false);
  });

  it("detects each reserved punctuation character", () => {
    for (const char of ["\"", "*", ":", "<", ">", "?", "/", "\\", "|"]) {
      expect(hasOneDriveInvalidNameCharacters(`file${char}name`), `char=${char}`).toBe(true);
    }
  });

  it("detects a trailing dot or space, and ASCII control characters", () => {
    expect(hasOneDriveInvalidNameCharacters("name.")).toBe(true);
    expect(hasOneDriveInvalidNameCharacters("name ")).toBe(true);
    expect(hasOneDriveInvalidNameCharacters("a\u0001b")).toBe(true);
  });

  it("treats the slash sign as invalid inside a name (segmenting is the caller's job)", () => {
    // A single name may never contain `/`; the caller segments a path with
    // path.split("/") and applies this helper per segment.
    expect(hasOneDriveInvalidNameCharacters("a/b.md")).toBe(true);
    expect(hasOneDriveInvalidNameCharacters("folder?/ok.md")).toBe(true);
    // A Unicode folder name without reserved characters remains valid.
    expect(hasOneDriveInvalidNameCharacters("文件夹")).toBe(false);
  });
});

describe("findOneDriveInvalidNameIssue", () => {
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