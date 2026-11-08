import { describe, expect, it, vi } from "vitest";
import { ButtonComponent } from "./__mocks__/obsidian";
import { applyDestructiveButton } from "../src/ui/destructive-button";

describe("applyDestructiveButton", () => {
  it("applies the official destructive style (minAppVersion 1.13.4 always has it)", () => {
    const button = new ButtonComponent({} as HTMLElement);
    const setDestructive = vi.spyOn(button, "setDestructive");
    const setWarning = vi.spyOn(button, "setWarning");

    const result = applyDestructiveButton(button);

    expect(setDestructive).toHaveBeenCalledTimes(1);
    expect(setWarning).not.toHaveBeenCalled();
    expect(result).toBe(button);
  });
});
