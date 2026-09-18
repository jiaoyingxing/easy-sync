import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

// Path-identity folding must be locale-independent: OneDrive's
// case-insensitive namespace folds like en-US, not like the host locale.
// A bare toLocaleLowerCase() drifts identity on special locales (Turkish
// I→ı) across devices and locale changes — the folding anchor is the
// cloud namespace, not the user's UI language.
// Exempt: UI search filtering (config-sync-modal) — matches user input
// against displayed names, not a path identity key.
const UNPINNED_EXEMPT = ["src/ui/config-sync-modal.ts"];

describe("path locale folding", () => {
  it("pins every path fold to en-US — no bare toLocaleLowerCase() in src", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles("src")) {
      const normalized = file.replaceAll("\\", "/");
      if (UNPINNED_EXEMPT.some((p) => normalized.endsWith(p))) continue;
      const source = readFileSync(file, "utf8");
      source.split(/\r?\n/).forEach((line, i) => {
        if (/\.toLocaleLowerCase\(\s*\)/.test(line)) {
          offenders.push(`${normalized}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("normalizeVaultPathKey folds with en-US (the OneDrive-namespace anchor)", () => {
    const source = readFileSync("src/obsidian-compat.ts", "utf8");
    expect(source).toContain('toLocaleLowerCase("en-US")');
  });
});
