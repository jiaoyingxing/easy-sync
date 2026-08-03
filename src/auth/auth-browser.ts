type AuthWindowOpener = (
  url: string,
  target: string,
  features?: string,
) => Window | null;

interface AuthBrowserLauncherOptions {
  isDesktopApp: boolean;
  openWindow?: AuthWindowOpener;
}

export interface AuthBrowserLauncher {
  openUrl(url: string): void;
}

export function createAuthBrowserLauncher(
  options: AuthBrowserLauncherOptions,
): AuthBrowserLauncher {
  const openWindow: AuthWindowOpener = options.openWindow
    ?? ((url, target, features) => window.open(url, target, features));

  return {
    openUrl: (url: string) => {
      if (options.isDesktopApp) {
        // Obsidian uses this target for its own "Open in default browser"
        // action. Keep the named target intact: `noopener` makes custom target
        // names behave like `_blank`, so Obsidian may no longer route it out.
        openWindow(url, "_external");
        return;
      }

      openWindow(url, "_blank");
    },
  };
}
