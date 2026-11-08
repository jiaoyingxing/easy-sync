import { ButtonComponent } from "obsidian";

/**
 * Apply Obsidian's destructive-button style. `ButtonComponent.setDestructive()`
 * ships since Obsidian 1.13.0 and minAppVersion is 1.13.4, so the official API
 * is always available; the pre-1.13 `mod-warning` class fallback is retired
 * (2026-11-07 floor raise). This keeps the official `setWarning`-deprecation
 * lint clean.
 */
export function applyDestructiveButton(button: ButtonComponent): ButtonComponent {
  button.setDestructive();
  return button;
}
