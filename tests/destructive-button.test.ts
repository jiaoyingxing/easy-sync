import { describe, expect, it, vi } from "vitest";
import { ButtonComponent } from "./__mocks__/obsidian";
import { applyDestructiveButton } from "../src/ui/destructive-button";

describe("applyDestructiveButton", () => {
  it("uses setDestructive when the host supports it (Obsidian 1.13.0+)", () => {
    const button = new ButtonComponent({} as HTMLElement);
    const setDestructive = vi.spyOn(button, "setDestructive");
    const setWarning = vi.spyOn(button, "setWarning");

    const result = applyDestructiveButton(button);

    expect(setDestructive).toHaveBeenCalledTimes(1);
    expect(setWarning).not.toHaveBeenCalled();
    expect(result).toBe(button);
  });

  it("falls back to the mod-warning class on hosts without setDestructive (1.11.4–1.12.x)", () => {
    const button = new ButtonComponent({} as HTMLElement);
    // Simulate an older host where setDestructive does not exist at all
    // (it lives on the prototype as a class method).
    delete (Object.getPrototypeOf(button) as unknown as { setDestructive?: unknown }).setDestructive;
    const addClass = vi.fn();
    (button as unknown as { buttonEl: { classList: { add: (c: string) => void } } }).buttonEl = {
      classList: { add: addClass },
    };
    const setWarning = vi.spyOn(button, "setWarning");

    const result = applyDestructiveButton(button);

    // The runtime capability gate must not call the new API on old hosts.
    expect((button as unknown as { setDestructive?: unknown }).setDestructive).toBeUndefined();
    // The legacy fallback applies the same visual style setWarning() uses,
    // without calling the deprecated API.
    expect(setWarning).not.toHaveBeenCalled();
    expect(addClass).toHaveBeenCalledWith("mod-warning");
    expect(result).toBe(button);
  });
});
