/**
 * The version baked into this bundle by `scripts/build-bundle.mjs`.
 *
 * A vault can end up holding a `main.js` from one install and a `manifest.json`
 * from another (2026-10-13 field report: a store-installed 1.5.0 bundle ran
 * under a 1.5.7 version label). The report can only expose that split if the
 * code knows its own generation, so the build injects it.
 *
 * Builds that do not inject it (unit tests, ad-hoc esbuild runs) must degrade
 * to null instead of throwing: the report then says 不可用 rather than guessing.
 */
declare const __EASY_SYNC_BUILD_VERSION__: string | undefined;

export function readBakedBuildVersion(): string | null {
  const baked = typeof __EASY_SYNC_BUILD_VERSION__ === "string"
    ? __EASY_SYNC_BUILD_VERSION__
    : undefined;
  const trimmed = baked?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
