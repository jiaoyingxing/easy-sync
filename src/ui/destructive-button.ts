import { ButtonComponent } from "obsidian";

/**
 * Two destructive tiers, chosen by consequence rather than by where the button
 * sits (2026-11-27 user decision):
 *
 * - `applyDestructivePrimaryButton` — the action deletes user files or
 *   overwrites the only surviving copy. Renders as the host's solid tier
 *   (`setDestructive().setCta()`: filled red, white label).
 * - `applyDestructiveButton` — the action only clears rebuildable local
 *   state, unbinds a cloud, or signs out. Renders as the host's tinted tier
 *   (`setDestructive()` alone: 10% red wash, red label).
 *
 * Both go through `ButtonComponent.setDestructive()`, which ships since
 * Obsidian 1.13.0 while minAppVersion is 1.13.4. The pre-1.13 `mod-warning`
 * class fallback is retired (2026-11-07 floor raise) and must not come back:
 * the host demotes `.is-mobile button.mod-warning` to a neutral fill, so the
 * same button reads as solid red on desktop and grey on phones.
 */
export function applyDestructiveButton(button: ButtonComponent): ButtonComponent {
  button.setDestructive();
  return button;
}

/** Solid destructive tier — for actions that destroy user files. */
export function applyDestructivePrimaryButton(
  button: ButtonComponent,
): ButtonComponent {
  button.setDestructive();
  button.setCta();
  return button;
}
