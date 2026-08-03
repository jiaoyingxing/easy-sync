/*!
 * core-js-pure 3.49.0 (structuredClone ponyfill)
 * Copyright (c) 2013–2025 Denis Pushkarev (zloirock.ru)
 * Copyright (c) 2025–2026 CoreJS Company (core-js.io)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import structuredClonePolyfill from "core-js-pure/actual/structured-clone";

export type StructuredCloneImplementation = "native" | "polyfill";

const EASY_SYNC_POLYFILL_BRAND = Symbol.for(
  "easy-sync.structured-clone-polyfill",
);

const structuredCloneCompat: typeof globalThis.structuredClone = (
  value,
  options,
) => structuredClonePolyfill(value, options);

Object.defineProperty(structuredCloneCompat, EASY_SYNC_POLYFILL_BRAND, {
  value: true,
});

function isEasySyncPolyfill(value: unknown): boolean {
  return typeof value === "function"
    && (value as unknown as Record<PropertyKey, unknown>)[
      EASY_SYNC_POLYFILL_BRAND
    ]
      === true;
}

/**
 * Android's OS version does not determine its installed WebView version.
 * Older WebViews can support IndexedDB while still lacking the global
 * structuredClone() helper used by EasySync's immutable state transitions.
 */
export function installStructuredCloneCompatibility():
  StructuredCloneImplementation {
  if (typeof globalThis.structuredClone === "function") {
    return isEasySyncPolyfill(globalThis.structuredClone)
      ? "polyfill"
      : "native";
  }
  Object.defineProperty(globalThis, "structuredClone", {
    configurable: true,
    enumerable: false,
    value: structuredCloneCompat,
    writable: true,
  });
  return "polyfill";
}

export const structuredCloneImplementation =
  installStructuredCloneCompatibility();
