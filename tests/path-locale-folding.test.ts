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
  // 超时分档（2026-10-17，B12 时基健康）：本条是**整仓扫描型**门——同步走遍
  // `src` 全部 `.ts`（实测 154 个文件 / 4.07 MiB）并逐行跑正则。耗时由仓库规模与
  // 磁盘／杀软负载决定，不属判据；给 30s 余量（实测 65–112ms，余量 ≳268x）。
  it("pins every path fold to en-US — no bare toLocaleLowerCase() in src", () => {
    const offenders: string[] = [];
    const scanned = listTsFiles("src");
    for (const file of scanned) {
      const normalized = file.replaceAll("\\", "/");
      if (UNPINNED_EXEMPT.some((p) => normalized.endsWith(p))) continue;
      const source = readFileSync(file, "utf8");
      source.split(/\r?\n/).forEach((line, i) => {
        if (/\.toLocaleLowerCase\(\s*\)/.test(line)) {
          offenders.push(`${normalized}:${i + 1}`);
        }
      });
    }
    // 反假绿（2026-10-16 检查体检轮）：扫描面必须非空——目录改名、递归断掉或
    // 扩展名规则写错时，"零违规"会变成什么都没看的假绿。
    expect(scanned.length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  }, 30_000);

  it("normalizeVaultPathKey folds with en-US (the OneDrive-namespace anchor)", () => {
    const source = readFileSync("src/obsidian-compat.ts", "utf8");
    const body = source.slice(source.indexOf("export function normalizeVaultPathKey"));
    const foldAt = body.indexOf('toLocaleLowerCase("en-US")');
    // 反假绿（同上）：必须是**那个函数体内**的锚。原来只断言"文件里某处有这个串"，
    // 命中的可能是注释、别的函数或未来新增的无关调用。
    expect(foldAt).toBeGreaterThan(0);
    expect(foldAt).toBeLessThan(body.indexOf("\n}"));
  });
});
