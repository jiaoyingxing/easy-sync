import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../src/sync/state-manager";
import {
  envelope,
  hashA,
  makeHarness,
} from "./helpers/state-manager-v2-harness";

describe("StateManager diagnostics wiring (W4 probe)", () => {
  it("constructs the production store with the live plugin diagnostic logger", () => {
    // W4 2026-10-25: the probe reads this.plugin.diag. Tests may inject a
    // logger through the harness, so only the production construction site is
    // asserted here — a missing wiring made every state diagnostic silent.
    const source = readFileSync("src/main.ts", "utf8");
    const start = source.indexOf("new StateManager({");
    expect(start).toBeGreaterThan(0);
    const opening = source.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let index = opening; index < source.length; index++) {
      if (source[index] === "{") depth++;
      else if (source[index] === "}") {
        depth--;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(opening);
    const store = source.slice(opening, end + 1);
    expect(store).toMatch(/diag:\s*\{/);
    expect(store).toContain("this.diag.warn");
    expect(store).toContain("this.diag.log");
    expect(store).toContain("this.diag.isEnabled");
  });

  it("logs canonicalization and commit cost only while the state category is enabled", async () => {
    const log = vi.fn();
    const enabled = { value: true };
    const harness = makeHarness({
      committed: envelope(),
      diag: {
        warn: vi.fn(),
        log,
        isEnabled: () => enabled.value,
      },
    });
    const state = new StateManager(harness.plugin);
    await state.load();
    log.mockClear();

    await state.updateBaseEntry({
      path: "Notes/a.md",
      hash: hashA,
      size: 11,
      eTag: "etag-a",
    });

    expect(log).toHaveBeenCalledTimes(1);
    const [category, message, detail] = log.mock.calls[0] as [
      string,
      string,
      {
        elapsedMs: number;
        totalMs: number;
        remoteItems: number;
        anchors: number;
      },
    ];
    expect(category).toBe("state");
    expect(message).toBe("V2 content-facts canonicalization");
    expect(detail.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(detail.totalMs).toBeGreaterThanOrEqual(detail.elapsedMs);
    expect(detail.remoteItems).toBe(2);
    expect(detail.anchors).toBe(1);

    enabled.value = false;
    log.mockClear();
    await state.updateBaseEntry({
      path: "Notes/a.md",
      hash: hashA,
      size: 12,
      eTag: "etag-a",
    });
    expect(log).not.toHaveBeenCalled();
  });
});
