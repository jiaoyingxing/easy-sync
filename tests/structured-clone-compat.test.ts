import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installStructuredCloneCompatibility,
} from "../src/structured-clone-compat";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("structuredClone compatibility", () => {
  it("keeps the native implementation when the host provides it", () => {
    const native = globalThis.structuredClone;

    expect(installStructuredCloneCompatibility()).toBe("native");
    expect(globalThis.structuredClone).toBe(native);
  });

  it("installs a graph-preserving fallback on an older host", () => {
    vi.stubGlobal("structuredClone", undefined);

    expect(installStructuredCloneCompatibility()).toBe("polyfill");
    const shared = { value: 1 };
    const source: {
      shared: { value: number };
      repeated: { value: number };
      optional: undefined;
      self?: unknown;
    } = {
      shared,
      repeated: shared,
      optional: undefined,
    };
    source.self = source;

    const cloned = globalThis.structuredClone(source);

    expect(cloned).not.toBe(source);
    expect(cloned.shared).not.toBe(shared);
    expect(cloned.repeated).toBe(cloned.shared);
    expect(cloned.self).toBe(cloned);
    expect(Object.hasOwn(cloned, "optional")).toBe(true);
  });

  it("preserves an own __proto__ field without changing the clone prototype", () => {
    vi.stubGlobal("structuredClone", undefined);
    installStructuredCloneCompatibility();
    const source = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"value":1}}',
    ) as Record<string, unknown>;

    const cloned = globalThis.structuredClone(source);

    expect(Object.hasOwn(cloned, "__proto__")).toBe(true);
    expect(cloned["__proto__"]).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
    expect((cloned as { polluted?: boolean }).polluted).toBeUndefined();
    expect(cloned["constructor"]).toEqual({ value: 1 });
  });
});
