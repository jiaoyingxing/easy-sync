// Shared release-minification config.
//
// Both the production post-processor (`minify-release-artifacts.mjs`) and the
// startup-budget measurement (`check-startup-budget.mjs`) must use the same
// options; otherwise the budget would compare against a different artifact
// shape than the one that ships. Keep this file the single source of truth.
export const RELEASE_JS_MINIFY_CONFIG = Object.freeze({
  loader: "js",
  target: "es2020",
  format: "cjs",
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: "none",
  charset: "utf8",
  keepNames: false,
});
