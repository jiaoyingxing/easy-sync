import type { AuthPopupHandle } from "./auth-module";

interface AuthBrowserWindow {
  location: { href: string };
  close(): void;
}

type AuthWindowOpener = (
  url: string,
  target: string,
  features?: string,
) => AuthBrowserWindow | null;

interface AuthBrowserLauncherOptions {
  isDesktopApp: boolean;
  openWindow?: AuthWindowOpener;
  onPopupNavigationError?: (error: unknown) => void;
}

export interface AuthBrowserLauncher {
  openAuthPopup(): AuthPopupHandle | null;
  openUrl(url: string): void;
}

export function createAuthBrowserLauncher(
  options: AuthBrowserLauncherOptions,
): AuthBrowserLauncher {
  const openWindow: AuthWindowOpener = options.openWindow
    ?? ((url, target, features) => window.open(url, target, features));

  return {
    openAuthPopup: () => {
      if (options.isDesktopApp) return null;

      const popup = openWindow("about:blank", "_blank");
      if (!popup) return null;

      return {
        navigate: (url: string) => {
          try {
            popup.location.href = url;
            return true;
          } catch (error) {
            options.onPopupNavigationError?.(error);
            return false;
          }
        },
        close: () => {
          try {
            popup.close();
          } catch {
            // Ignore popup close failures.
          }
        },
      };
    },
    openUrl: (url: string) => {
      if (options.isDesktopApp) {
        // Obsidian uses this target for its own "Open in default browser"
        // action. It bypasses Web Viewer without changing the user's setting.
        openWindow(url, "_external", "noopener,noreferrer");
        return;
      }

      openWindow(url, "_blank");
    },
  };
}
