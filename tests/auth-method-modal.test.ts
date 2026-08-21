import { describe, expect, it } from "vitest";
import { orderMethodOptions } from "../src/ui/auth-method-modal";

describe("orderMethodOptions", () => {
  it("puts the browser option first on desktop", () => {
    expect(
      orderMethodOptions(false, ["browser", "device"] as const),
    ).toEqual(["browser", "device"]);
  });

  it("puts the device option first on mobile (D1)", () => {
    expect(
      orderMethodOptions(true, ["browser", "device"] as const),
    ).toEqual(["device", "browser"]);
  });
});
