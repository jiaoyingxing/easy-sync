import { describe, expect, it, vi } from "vitest";
import { ConfigSyncModal } from "../src/ui/config-sync-modal";

/**
 * Behavior contract for the community-plugin manager's remote catalog refresh:
 * an in-flight sync round defers the refresh once (notice + automatic retry
 * after the round), while a refresh failure stays silent — the manager shows
 * the last trusted catalog and the next manager open retries.
 *
 * Construction pattern mirrors settings-tab.test.ts modal tests: prototype
 * instance with mocks injected for plugin services and render entry points.
 */
function createManagerModal(overrides: {
  hasActivityInFlight?: boolean;
  refreshResult?: Promise<null> | Promise<never>;
} = {}) {
  const refresh = vi.fn()
    .mockReturnValue(overrides.refreshResult ?? Promise.resolve(null));
  const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
  Object.assign(modal as object, {
    plugin: {
      app: {},
      i18n: { t: (key: string) => key },
      syncExecutor: {
        hasActivityInFlight: overrides.hasActivityInFlight ?? false,
      },
      refreshCommunityPluginRemoteCatalog: refresh,
    },
    destroyed: false,
    listScrollEl: null,
    inventory: [],
    remoteInventoryAvailable: false,
    inventoryLoading: true,
    inventoryLoadFailed: false,
    catalogRefreshSkippedWhileSyncing: false,
    renderCommunityPluginManager: vi.fn(),
    requestCommunityPluginInventoryRefresh: vi.fn(),
    renderPluginListArea: vi.fn(),
  });
  return { modal, refresh };
}

describe("community plugin manager catalog refresh visibility", () => {
  it("skips the refresh while a sync round is in flight and marks the follow-up", async () => {
    const { modal, refresh } = createManagerModal({
      hasActivityInFlight: true,
    });
    await (modal as unknown as {
      openCommunityPluginManager(column: "files" | "data"): Promise<void>;
    }).openCommunityPluginManager("files");
    expect(modal.catalogRefreshSkippedWhileSyncing).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes immediately when no sync round is in flight", async () => {
    const { modal, refresh } = createManagerModal({
      hasActivityInFlight: false,
    });
    await (modal as unknown as {
      openCommunityPluginManager(column: "files" | "data"): Promise<void>;
    }).openCommunityPluginManager("files");
    expect(modal.catalogRefreshSkippedWhileSyncing).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retries the skipped refresh once the in-flight sync ends (revision arrives)", async () => {
    const { modal, refresh } = createManagerModal();
    modal.catalogRefreshSkippedWhileSyncing = true;
    (modal as unknown as {
      handleCommunityPluginInventoryRevision(_revision: number): void;
    }).handleCommunityPluginInventoryRevision(1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(modal.catalogRefreshSkippedWhileSyncing).toBe(false);
  });

  it("keeps waiting when the revision arrives while sync is still running", async () => {
    const { modal, refresh } = createManagerModal();
    modal.catalogRefreshSkippedWhileSyncing = true;
    (modal.plugin as unknown as {
      syncExecutor: { hasActivityInFlight: boolean };
    }).syncExecutor.hasActivityInFlight = true;
    (modal as unknown as {
      handleCommunityPluginInventoryRevision(_revision: number): void;
    }).handleCommunityPluginInventoryRevision(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(modal.catalogRefreshSkippedWhileSyncing).toBe(true);
  });

  it("keeps a failed refresh silent: no row, no flag — the next manager open retries", async () => {
    const { modal, refresh } = createManagerModal();
    modal.catalogRefreshSkippedWhileSyncing = true;
    refresh.mockReturnValue(Promise.reject(new Error("delta failed")));
    (modal as unknown as {
      refreshRemoteCatalogOnce(): void;
    }).refreshRemoteCatalogOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    // The deferred-after-sync marker survives the failed follow-up, so a later
    // inventory revision still triggers the retry once the round has ended.
    expect(modal.catalogRefreshSkippedWhileSyncing).toBe(true);
    expect(modal.renderPluginListArea).not.toHaveBeenCalled();
  });
});
