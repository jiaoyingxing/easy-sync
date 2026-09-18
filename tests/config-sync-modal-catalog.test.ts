import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSyncModal } from "../src/ui/config-sync-modal";

// The danger confirm dialog is the user's intent gate; the flow under
// test starts after it resolves affirmative.
vi.mock("../src/ui/confirm-modal", () => ({
  ConfirmModal: class {
    awaitConfirm(): Promise<boolean> {
      return Promise.resolve(true);
    }
  },
}));

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

describe("community plugin cleanup confirm row visibility", () => {
  function createCleanupModal(cleanupResult: Promise<boolean>) {
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    const cleanup = vi.fn().mockReturnValue(cleanupResult);
    Object.assign(modal as object, {
      plugin: {
        app: {},
        i18n: { t: (key: string) => key },
        runCommunityPluginCloudCleanup: cleanup,
      },
      destroyed: false,
      cleanedPluginIds: new Set<string>(),
      renderPluginListArea: vi.fn(),
      requestCommunityPluginInventoryRefresh: vi.fn(),
    });
    return { modal, cleanup };
  }

  async function confirm(modal: ConfigSyncModal): Promise<void> {
    await (modal as unknown as {
      confirmCommunityPluginCloudCleanup(
        item: { id: string },
        displayName: string,
      ): Promise<void>;
    }).confirmCommunityPluginCloudCleanup({ id: "calendar" }, "Calendar");
  }

  it("removes the row from the list immediately after confirmation and keeps it hidden on success", async () => {
    const { modal, cleanup } = createCleanupModal(Promise.resolve(true));
    let hiddenAtCallTime = false;
    cleanup.mockImplementation(async () => {
      hiddenAtCallTime = (modal as unknown as {
        cleanedPluginIds: Set<string>;
      }).cleanedPluginIds.has("calendar");
      return true;
    });
    await confirm(modal);
    // 确认即放行: the row is optimistically hidden BEFORE the transaction
    // resolves, reusing the existing hiding mechanism.
    expect(hiddenAtCallTime).toBe(true);
    expect((modal as unknown as {
      cleanedPluginIds: Set<string>;
    }).cleanedPluginIds.has("calendar")).toBe(true);
    expect(modal.renderPluginListArea).toHaveBeenCalled();
    expect(modal.requestCommunityPluginInventoryRefresh).toHaveBeenCalled();
  });

  it("restores the row when the cleanup reports failure or blockage", async () => {
    const { modal } = createCleanupModal(Promise.resolve(false));
    await confirm(modal);
    expect((modal as unknown as {
      cleanedPluginIds: Set<string>;
    }).cleanedPluginIds.has("calendar")).toBe(false);
    expect(modal.renderPluginListArea).toHaveBeenCalled();
    expect(modal.requestCommunityPluginInventoryRefresh).not.toHaveBeenCalled();
  });
});

describe("community plugin manager render coalescing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createCoalescingModal() {
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: { app: {}, i18n: { t: (key: string) => key } },
      destroyed: false,
      searchQuery: "",
      searchRenderDebounce: null,
      lastInventoryReloadCompletedAt: 0,
      inventoryReloadGateTimer: null,
      inventoryRevisionRefreshRunning: false,
      inventoryRevisionRefreshPending: false,
      catalogRefreshSkippedWhileSyncing: false,
      view: "community-plugin-files" as const,
      renderPluginListArea: vi.fn(),
      reloadCommunityPluginManager: vi.fn(async () => {}),
      getManagerColumn: vi.fn(() => "files" as const),
    });
    return modal;
  }

  function reloadCalls(modal: ConfigSyncModal): ReturnType<typeof vi.fn> {
    return (modal as unknown as {
      reloadCommunityPluginManager: ReturnType<typeof vi.fn>;
    }).reloadCommunityPluginManager;
  }

  it("coalesces search keystrokes into one list re-render after the quiet gap", async () => {
    vi.useFakeTimers();
    const modal = createCoalescingModal();
    const handle = (modal as unknown as {
      handleSearchInput(value: string): void;
    });
    handle.handleSearchInput("a");
    handle.handleSearchInput("ap");
    handle.handleSearchInput("app");
    await vi.advanceTimersByTimeAsync(0);
    expect(modal.renderPluginListArea).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(modal.renderPluginListArea).toHaveBeenCalledTimes(1);
    expect(modal.searchQuery).toBe("app");
  });

  it("does not re-render the list after the modal is destroyed", async () => {
    vi.useFakeTimers();
    const modal = createCoalescingModal();
    modal.destroyed = true;
    (modal as unknown as {
      handleSearchInput(value: string): void;
    }).handleSearchInput("a");
    await vi.advanceTimersByTimeAsync(200);
    expect(modal.renderPluginListArea).not.toHaveBeenCalled();
  });

  it("gates inventory-event rebuilds to one full remount per quiet interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
    const modal = createCoalescingModal();
    // The previous reload just completed — directory events streamed inside
    // the quiet window must coalesce instead of remounting the list each time.
    modal.lastInventoryReloadCompletedAt = Date.now();
    const handle = (modal as unknown as {
      handleCommunityPluginInventoryRevision(_revision: number): void;
    });
    handle.handleCommunityPluginInventoryRevision(1);
    handle.handleCommunityPluginInventoryRevision(2);
    handle.handleCommunityPluginInventoryRevision(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(reloadCalls(modal)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(reloadCalls(modal)).toHaveBeenCalledTimes(1);
    expect(modal.inventoryRevisionRefreshPending).toBe(false);
  });

  it("rebuilds immediately when the last reload is outside the quiet window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
    const modal = createCoalescingModal();
    modal.lastInventoryReloadCompletedAt = Date.now() - 1000;
    (modal as unknown as {
      handleCommunityPluginInventoryRevision(_revision: number): void;
    }).handleCommunityPluginInventoryRevision(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(reloadCalls(modal)).toHaveBeenCalledTimes(1);
  });
});
