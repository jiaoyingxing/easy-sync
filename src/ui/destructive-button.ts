import { ButtonComponent } from "obsidian";

/**
 * Apply Obsidian's destructive-button style when the host supports it,
 * falling back to the legacy warning style otherwise.
 *
 * `ButtonComponent.setDestructive()` was added in Obsidian 1.13.0. Calling it
 * on 1.11.4–1.12.x would throw at render time, so the call is gated behind a
 * runtime capability check. On older hosts we apply the same visual style
 * (`mod-warning`) directly via the button element class — matching what
 * `setWarning()` does internally — so the deprecated API is never called and
 * the official lint stays clean.
 *
 * This keeps the minAppVersion contract (SecretStorage, 1.11.4) intact while
 * satisfying the official `setWarning`-deprecation lint on hosts that support
 * the new API.
 */
export function applyDestructiveButton(button: ButtonComponent): ButtonComponent {
  const candidate = button as unknown as {
    setDestructive?: () => unknown;
  };
  if (typeof candidate.setDestructive === "function") {
    candidate.setDestructive();
    return button;
  }
  button.buttonEl.classList.add("mod-warning");
  return button;
}
