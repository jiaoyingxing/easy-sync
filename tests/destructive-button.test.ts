import { describe, expect, it, vi } from "vitest";
import { ButtonComponent } from "./__mocks__/obsidian";
import {
  applyDestructiveButton,
  applyDestructivePrimaryButton,
} from "../src/ui/destructive-button";

// Two tiers, chosen by consequence (2026-11-27 user decision):
// destructive → tinted (rebuildable state); destructive-primary → solid (files).

describe("applyDestructiveButton", () => {
  it("applies the tinted destructive style without the CTA fill", () => {
    const button = new ButtonComponent({} as HTMLElement);
    const setDestructive = vi.spyOn(button, "setDestructive");
    const setCta = vi.spyOn(button, "setCta");
    const setWarning = vi.spyOn(button, "setWarning");

    const result = applyDestructiveButton(button);

    expect(setDestructive).toHaveBeenCalledTimes(1);
    expect(setCta).not.toHaveBeenCalled();
    expect(setWarning).not.toHaveBeenCalled();
    expect(result).toBe(button);
  });
});

describe("applyDestructivePrimaryButton", () => {
  it("layers the solid CTA fill on top of destructive for file-destroying actions", () => {
    const button = new ButtonComponent({} as HTMLElement);
    const setDestructive = vi.spyOn(button, "setDestructive");
    const setCta = vi.spyOn(button, "setCta");
    const setWarning = vi.spyOn(button, "setWarning");

    const result = applyDestructivePrimaryButton(button);

    expect(setDestructive).toHaveBeenCalledTimes(1);
    expect(setCta).toHaveBeenCalledTimes(1);
    expect(setWarning).not.toHaveBeenCalled();
    expect(result).toBe(button);
  });
});
