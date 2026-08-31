import {
  ButtonComponent,
  ExtraButtonComponent,
  Notice,
  SearchComponent,
  Setting,
  ToggleComponent,
} from "obsidian";
import {
  SyncPathSettingsUpdateError,
  type SyncPathSettings,
} from "../main";
import type EasySyncPlugin from "../main";
import type { CommunityPluginInventoryItem } from "../sync/community-plugin-inventory";
import {
  cloneCommunityPluginSyncPolicy,
  isPluginSelected,
} from "../sync/community-plugin-sync-policy";
import {
  enableCommunityPluginDataWithFiles,
  updateAllCommunityPluginSelections,
  updateCommunityPluginSelection,
  type CommunityPluginSelectionColumn,
  type CommunityPluginSelectionSettings,
} from "../sync/community-plugin-selection-update";
import { EasySyncModal } from "./easy-sync-modal";
import { ConfirmModal } from "./confirm-modal";
import { SequentialSettingsUpdateQueue } from "./sequential-settings-update-queue";
import {
  isCommunityPluginCloudCleanupCandidateV1,
} from "../sync/community-plugin-cloud-cleanup-v1";

export type ConfigSyncView =
  | "scope"
  | "community-plugin-files"
  | "community-plugin-data";

type PluginColumn = CommunityPluginSelectionColumn;

/**
 * Rows of cloud-cleaned plugins stay hidden from both the files and the data
 * list while this device holds no local plugin files for them (the persisted
 * marker is only dropped by a resurrection notice). Reinstalling the plugin
 * locally (`local: true`) must bring the row back so the user can manage and
 * re-join it — there is no permanent blocklist. Counts derive from the same
 * visible rows, so a cleaned plugin no longer inflates totals.
 */
export function isPluginRowHiddenByCloudCleanup(
  column: PluginColumn | undefined,
  local: boolean | undefined,
  cleaned: boolean,
): boolean {
  return column !== undefined && local === false && cleaned;
}

interface ScopeToggleConfig {
  key: string;
  get: () => boolean;
  patch: (value: boolean) => Partial<SyncPathSettings>;
}

interface CommunityPluginScopeControls {
  toggle: ToggleComponent;
  manageButton: ButtonComponent;
  selectionChipEl: HTMLElement;
}

export class ConfigSyncModal extends EasySyncModal {
  private view: ConfigSyncView = "scope";
  private inventory: CommunityPluginInventoryItem[] = [];
  private scopeInventory: CommunityPluginInventoryItem[] = [];
  private scopeInventoryLoaded = false;
  private remoteInventoryAvailable = false;
  private inventoryLoading = false;
  private inventoryLoadFailed = false;
  private remoteCatalogRefreshFailed = false;
  private searchQuery = "";
  private loadGeneration = 0;
  private destroyed = false;
  private listScrollEl: HTMLElement | null = null;
  private communityPluginScopeControls = new Map<
    PluginColumn,
    CommunityPluginScopeControls
  >();
  private busyCommunityPluginScopeRows = new Set<PluginColumn>();
  private pendingCommunityPluginScopeValues = new Map<
    PluginColumn,
    boolean
  >();
  private busyPluginRows = new Set<string>();
  private confirmingDataRows = new Set<string>();
  private pendingPluginValues = new Map<string, boolean>();
  private cleanedPluginIds = new Set<string>();
  private settingsUpdateQueue = new SequentialSettingsUpdateQueue();
  private unsubscribeCommunityPluginInventoryRevision: (() => void) | null =
    null;
  private inventoryRevisionRefreshRunning = false;
  private inventoryRevisionRefreshPending = false;

  constructor(
    private plugin: EasySyncPlugin,
    private initialView: ConfigSyncView = "scope",
    private onCloseCallback?: () => void,
  ) {
    super(plugin.app);
    // Persisted cleanup markers keep cleaned rows hidden across modal
    // reopenings; a resurrection notice drops the marker, and the row (and
    // the cleanup affordance for it) comes back only then.
    for (const marker of plugin.getCommunityPluginCloudCleanupMarkers()) {
      this.cleanedPluginIds.add(marker.pluginId);
    }
  }

  onOpen(): void {
    this.destroyed = false;
    this.unsubscribeCommunityPluginInventoryRevision?.();
    this.unsubscribeCommunityPluginInventoryRevision =
      this.plugin.onCommunityPluginInventoryRevision((revision) => {
        this.handleCommunityPluginInventoryRevision(revision);
      });
    this.modalEl.addClass("easy-sync-settings-modal");
    if (this.initialView === "scope") {
      this.renderScope();
      return;
    }
    void this.openCommunityPluginManager(
      this.initialView === "community-plugin-files" ? "files" : "data",
    );
  }

  onClose(): void {
    this.destroyed = true;
    this.loadGeneration += 1;
    this.inventoryRevisionRefreshPending = false;
    this.unsubscribeCommunityPluginInventoryRevision?.();
    this.unsubscribeCommunityPluginInventoryRevision = null;
    this.contentEl.empty();
    const onCloseCallback = this.onCloseCallback;
    this.onCloseCallback = undefined;
    if (onCloseCallback) {
      void this.settingsUpdateQueue.whenIdle().then(onCloseCallback);
    }
  }

  private renderScope(): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.view = "scope";
    this.scopeInventory = [];
    this.scopeInventoryLoaded = false;
    this.listScrollEl = null;
    this.communityPluginScopeControls.clear();
    this.busyCommunityPluginScopeRows.clear();
    this.pendingCommunityPluginScopeValues.clear();
    this.contentEl.empty();
    this.contentEl.removeClass("easy-sync-community-plugin-page");
    this.setTitle(t("settings.syncScope.title"));

    const leadingToggles: ScopeToggleConfig[] = [
      {
        key: "settings.syncPluginFiles",
        get: () => this.plugin.syncPluginFiles,
        patch: (value) => ({ syncPluginFiles: value }),
      },
      {
        key: "settings.syncCorePlugins",
        get: () => this.plugin.syncCorePlugins,
        patch: (value) => ({ syncCorePlugins: value }),
      },
    ];

    for (const toggleConfig of leadingToggles) {
      this.renderScopeToggle(toggleConfig);
    }

    this.renderCommunityPluginScopeSetting(
      "files",
      "settings.syncCommunityPlugins",
    );
    this.renderCommunityPluginScopeSetting(
      "data",
      "settings.syncPluginData",
    );

    const trailingToggles: ScopeToggleConfig[] = [
      {
        key: "settings.syncEditor",
        get: () => this.plugin.syncEditorSettings,
        patch: (value) => ({ syncEditorSettings: value }),
      },
      {
        key: "settings.syncAppearance",
        get: () => this.plugin.syncAppearance,
        patch: (value) => ({ syncAppearance: value }),
      },
      {
        key: "settings.syncThemes",
        get: () => this.plugin.syncThemes,
        patch: (value) => ({ syncThemes: value }),
      },
      {
        key: "settings.syncHotkeys",
        get: () => this.plugin.syncHotkeys,
        patch: (value) => ({ syncHotkeys: value }),
      },
      {
        key: "settings.syncBookmarks",
        get: () => this.plugin.syncBookmarks,
        patch: (value) => ({ syncBookmarks: value }),
      },
    ];

    for (const toggleConfig of trailingToggles) {
      this.renderScopeToggle(toggleConfig);
    }

    this.requestCommunityPluginInventoryRefresh();
  }

  private renderScopeToggle(toggleConfig: ScopeToggleConfig): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    new Setting(this.contentEl)
      .setName(t(`${toggleConfig.key}.name`))
      .setDesc(t(`${toggleConfig.key}.desc`))
      .addToggle((toggle) => {
        toggle
          .setValue(toggleConfig.get())
          .onChange(async (value) => {
            const previous = toggleConfig.get();
            toggle.setDisabled(true);
            try {
              await this.plugin.updateSyncPathSettings(
                toggleConfig.patch(value),
              );
            } catch (error) {
              toggle.setValue(previous);
              this.showSyncPathSettingsError(error);
            } finally {
              toggle.setDisabled(false);
            }
          });
      });
  }

  private renderCommunityPluginScopeSetting(
    column: PluginColumn,
    key: string,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    let manageButton: ButtonComponent | null = null;
    let toggleComponent: ToggleComponent | null = null;
    const setting = new Setting(this.contentEl)
      .setName(t(`${key}.name`))
      .setDesc(t(`${key}.desc`))
      .addButton((button) => {
        manageButton = button
          .setIcon("settings")
          .setTooltip(t(
            column === "files"
              ? "settings.communityPlugins.manage.files"
              : "settings.communityPlugins.manage.data",
          ))
          .onClick(() => {
            this.openCommunityPluginManagerModal(column);
          });
        button.buttonEl.addClass("clickable-icon");
        button.buttonEl.setAttribute(
          "aria-label",
          t(
            column === "files"
              ? "settings.communityPlugins.manage.files"
              : "settings.communityPlugins.manage.data",
          ),
        );
      })
      .addToggle((toggle) => {
        toggleComponent = toggle
          .setValue(this.getCommunityPluginScopeEnabled(column))
          .onChange((value) => {
            void this.updateCommunityPluginScopeSetting(column, value);
          });
      });
    setting.settingEl.addClass("easy-sync-community-plugin-scope-setting");
    if (column === "data") {
      this.appendExperimentalPluginDataChip(setting.nameEl);
    }
    const selectionChipEl = setting.nameEl.createSpan(
      "easy-sync-plugin-selection-chip",
    );
    selectionChipEl.addClass("is-hidden");
    if (!manageButton || !toggleComponent) return;
    this.communityPluginScopeControls.set(column, {
      toggle: toggleComponent,
      manageButton,
      selectionChipEl,
    });
    this.refreshCommunityPluginScopeControls();
  }

  private openCommunityPluginManagerModal(column: PluginColumn): void {
    new ConfigSyncModal(
      this.plugin,
      column === "files"
        ? "community-plugin-files"
        : "community-plugin-data",
      () => this.refreshCommunityPluginScopeControls(),
    ).open();
  }

  private getCommunityPluginScopeEnabled(column: PluginColumn): boolean {
    return column === "files"
      ? this.plugin.syncCommunityPlugins
      : this.plugin.syncPluginData;
  }

  private async updateCommunityPluginScopeSetting(
    column: PluginColumn,
    value: boolean,
  ): Promise<void> {
    if (this.busyCommunityPluginScopeRows.has(column)) return;
    // Obsidian's ToggleComponent.setValue() invokes onChange when a repaint
    // changes the visual value. Returning from the per-plugin page therefore
    // reaches this handler even though the committed outer value is already
    // correct. Treat that callback as a repaint, not as a user bulk action.
    if (value === this.getCommunityPluginScopeEnabled(column)) return;
    if (
      column === "data"
      && value
      && !this.plugin.syncCommunityPlugins
    ) {
      this.refreshCommunityPluginScopeControls();
      new Notice(this.plugin.i18n.t(
        "notice.communityPlugins.enableFilesFirst",
      ));
      return;
    }
    const requiresExperimentalConfirmation = column === "data" && value;
    if (!requiresExperimentalConfirmation) {
      this.pendingCommunityPluginScopeValues.set(column, value);
    }
    this.busyCommunityPluginScopeRows.add(column);
    this.refreshCommunityPluginScopeControls();
    try {
      if (column === "files") {
        await this.plugin.updateCommunityPluginFilesScope(value);
        return;
      }
      let inventory = this.scopeInventoryLoaded
        ? this.scopeInventory
        : [];
      if (value && !this.scopeInventoryLoaded) {
        inventory = await this.plugin.getCommunityPluginInventory();
        this.scopeInventory = inventory;
        this.scopeInventoryLoaded = true;
      }
      const knownPluginIds = inventory
        .filter((item) =>
          this.isPluginEffectivelyEnabled(item.id, "files")
          && (
            item.dataLocally
            || item.dataRemotely
            || item.dataHistoricallyPresent === true
          )
        )
        .map((item) => item.id);
      if (
        requiresExperimentalConfirmation
        && !await this.confirmExperimentalPluginData(
          "settings.communityPlugins.data.experimentalBulkMessage",
          { count: knownPluginIds.length },
        )
      ) return;
      if (requiresExperimentalConfirmation) {
        this.pendingCommunityPluginScopeValues.set(column, value);
        this.refreshCommunityPluginScopeControls();
      }
      const next = updateAllCommunityPluginSelections(
        this.captureSelectionSettings(),
        column,
        value,
        knownPluginIds,
      );
      await this.plugin.updateSyncPathSettings(
        this.toSyncPathSettingsPatch(next),
      );
    } catch (error) {
      this.showSyncPathSettingsError(error);
    } finally {
      this.pendingCommunityPluginScopeValues.delete(column);
      this.busyCommunityPluginScopeRows.delete(column);
      this.refreshCommunityPluginScopeControls();
    }
  }

  private refreshCommunityPluginScopeControls(): void {
    for (const [column, controls] of this.communityPluginScopeControls) {
      const enabled = this.pendingCommunityPluginScopeValues.get(column)
        ?? this.getCommunityPluginScopeEnabled(column);
      const busy = this.busyCommunityPluginScopeRows.has(column);
      controls.toggle
        .setValue(enabled)
        .setDisabled(busy);
      controls.manageButton.setDisabled(busy);
      this.renderCommunityPluginSelectionChip(
        column,
        controls.selectionChipEl,
        enabled && !busy,
      );
    }
  }

  private async loadScopeInventory(generation: number): Promise<void> {
    try {
      const inventory = await this.plugin.getCommunityPluginInventory();
      if (
        this.destroyed
        || generation !== this.loadGeneration
        || this.view !== "scope"
      ) return;
      this.scopeInventory = inventory;
      this.scopeInventoryLoaded = true;
      this.refreshCommunityPluginScopeControls();
    } catch {
      // The manager remains the authoritative place for inventory errors.
      // Keep the scope chip hidden rather than showing an untrusted count.
    }
  }

  private renderCommunityPluginSelectionChip(
    column: PluginColumn,
    chipEl: HTMLElement,
    scopeEnabled: boolean,
  ): void {
    if (
      !scopeEnabled
      || !this.scopeInventoryLoaded
    ) {
      chipEl.setText("");
      chipEl.addClass("is-hidden");
      return;
    }
    const items = column === "files"
      ? this.scopeInventory.filter((item) =>
          !isPluginRowHiddenByCloudCleanup(
            column,
            item.local,
            this.cleanedPluginIds.has(item.id),
          ))
      : this.scopeInventory.filter((item) =>
          this.isPluginEffectivelyEnabled(item.id, "files")
          && !isPluginRowHiddenByCloudCleanup(
            column,
            item.local,
            this.cleanedPluginIds.has(item.id),
          ));
    if (items.length === 0) {
      chipEl.setText("");
      chipEl.addClass("is-hidden");
      return;
    }
    const enabledCount = items.filter((item) =>
      this.isPluginEffectivelyEnabled(item.id, column)
    ).length;
    chipEl.setText(this.plugin.i18n.t(
      "settings.communityPlugins.selectionSummary",
      { enabled: enabledCount, total: items.length },
    ));
    chipEl.removeClass("is-hidden");
  }

  private async openCommunityPluginManager(
    column: PluginColumn,
  ): Promise<void> {
    this.view = column === "files"
      ? "community-plugin-files"
      : "community-plugin-data";
    this.inventory = [];
    this.remoteInventoryAvailable = false;
    this.inventoryLoading = true;
    this.inventoryLoadFailed = false;
    this.searchQuery = "";
    this.renderCommunityPluginManager(column);

    this.requestCommunityPluginInventoryRefresh();
    if (
      typeof this.plugin.refreshCommunityPluginRemoteCatalog === "function"
    ) {
      void this.plugin.refreshCommunityPluginRemoteCatalog().catch(() => {
        if (this.destroyed) return;
        // Inline retry affordance instead of a one-shot blocking Notice: a
        // transient delta failure must not turn the fine-grained manager into
        // "reopen to retry the same failing request".
        this.remoteCatalogRefreshFailed = true;
        this.renderPluginListArea();
      });
    }
  }

  private async reloadCommunityPluginManager(
    column: PluginColumn,
    generation: number,
  ): Promise<void> {
    this.inventoryLoading = true;
    this.inventoryLoadFailed = false;
    try {
      const [inventory, remoteInventoryAvailable] =
        await Promise.all([
          this.plugin.getCommunityPluginInventory(),
          this.plugin.hasTrustedCommunityPluginRemoteInventory(column),
        ]);
      if (
        generation !== this.loadGeneration
        || this.destroyed
        || this.getManagerColumn() !== column
      ) return;
      this.inventory = inventory;
      this.remoteInventoryAvailable = remoteInventoryAvailable;
      this.remoteCatalogRefreshFailed = false;
    } catch {
      if (generation !== this.loadGeneration || this.destroyed) return;
      this.inventoryLoadFailed = true;
      new Notice(this.plugin.i18n.t("notice.communityPlugins.loadFailed"));
    } finally {
      if (
        generation === this.loadGeneration
        && !this.destroyed
        && this.getManagerColumn() === column
      ) {
        this.inventoryLoading = false;
        this.renderPluginListArea();
      }
    }
  }

  private handleCommunityPluginInventoryRevision(_revision: number): void {
    if (this.destroyed) return;
    this.requestCommunityPluginInventoryRefresh();
  }

  private requestCommunityPluginInventoryRefresh(): void {
    if (this.destroyed) return;
    this.inventoryRevisionRefreshPending = true;
    if (this.inventoryRevisionRefreshRunning) return;
    void this.drainCommunityPluginInventoryRefresh();
  }

  private async drainCommunityPluginInventoryRefresh(): Promise<void> {
    if (this.inventoryRevisionRefreshRunning || this.destroyed) return;
    this.inventoryRevisionRefreshRunning = true;
    try {
      while (this.inventoryRevisionRefreshPending && !this.destroyed) {
        this.inventoryRevisionRefreshPending = false;
        const generation = ++this.loadGeneration;
        if (this.view === "scope") {
          this.scopeInventoryLoaded = false;
          this.refreshCommunityPluginScopeControls();
          await this.loadScopeInventory(generation);
          continue;
        }
        const column = this.getManagerColumn();
        if (!column) return;
        await this.reloadCommunityPluginManager(column, generation);
      }
    } finally {
      this.inventoryRevisionRefreshRunning = false;
      if (this.inventoryRevisionRefreshPending && !this.destroyed) {
        void this.drainCommunityPluginInventoryRefresh();
      }
    }
  }

  private renderCommunityPluginManager(column: PluginColumn): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.contentEl.empty();
    this.contentEl.addClass("easy-sync-community-plugin-page");
    this.setTitle(t(
      column === "files"
        ? "settings.communityPlugins.files.title"
        : "settings.communityPlugins.data.title",
    ));
    this.titleEl.toggleClass(
      "easy-sync-community-plugin-data-title",
      column === "data",
    );
    if (column === "data") {
      this.appendExperimentalPluginDataChip(this.titleEl);
    }

    const search = new SearchComponent(this.contentEl)
      .setPlaceholder(t("settings.communityPlugins.search"))
      .setValue(this.searchQuery)
      .onChange((value) => {
        this.searchQuery = value;
        this.renderPluginListArea();
      });
    search.inputEl.id = "easy-sync-community-plugin-search";
    search.inputEl.setAttribute(
      "aria-label",
      t("settings.communityPlugins.search"),
    );
    search.inputEl.parentElement?.addClass("easy-sync-plugin-search");

    this.listScrollEl = this.contentEl.createDiv(
      "easy-sync-plugin-list-scroll",
    );
    this.renderPluginListArea();
  }

  private renderPluginListArea(): void {
    if (!this.listScrollEl) return;
    const column = this.getManagerColumn();
    if (!column) return;
    if (this.inventoryLoading && this.inventory.length > 0) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const previousScrollTop = this.listScrollEl.scrollTop;
    this.listScrollEl.empty();

    if (this.inventoryLoading) {
      this.listScrollEl.createEl("p", {
        cls: "setting-item-description easy-sync-plugin-list-message",
        text: t("settings.communityPlugins.loading"),
      });
      return;
    }
    if (this.inventoryLoadFailed) {
      this.listScrollEl.createEl("p", {
        cls: "setting-item-description easy-sync-plugin-list-message",
        text: t("notice.communityPlugins.loadFailed"),
      });
      return;
    }
    const normalizedQuery = this.searchQuery.trim().toLocaleLowerCase();
    const visibleItems = this.inventory.filter((item) =>
      (
        normalizedQuery.length === 0
        || (
          item.name !== null
          && item.name.toLocaleLowerCase().includes(normalizedQuery)
        )
        || item.id.toLocaleLowerCase().includes(normalizedQuery)
      )
      && !isPluginRowHiddenByCloudCleanup(
        column,
        item.local,
        this.cleanedPluginIds.has(item.id),
      )
    );
    if (visibleItems.length === 0) {
      this.listScrollEl.createEl("p", {
        cls: "setting-item-description easy-sync-plugin-list-message",
        text: t(
          this.inventory.length === 0
            ? "settings.communityPlugins.empty"
            : "settings.communityPlugins.noMatch",
        ),
      });
      return;
    }

    const guidance = this.describeInventoryGuidance(visibleItems, column);
    if (guidance.length > 0) {
      this.listScrollEl.createEl("p", {
        cls: "setting-item-description easy-sync-plugin-list-guidance",
        text: guidance.join(" "),
      });
    }

    if (this.remoteCatalogRefreshFailed) {
      const row = this.listScrollEl.createDiv(
        "setting-item-description easy-sync-plugin-list-guidance",
      );
      row.setText(t("notice.communityPlugins.remoteCatalogFailed"));
      new ButtonComponent(row)
        .setButtonText(t("settings.communityPlugins.retry"))
        .onClick(() => {
          if (this.destroyed) return;
          this.remoteCatalogRefreshFailed = false;
          this.renderPluginListArea();
          void this.plugin.refreshCommunityPluginRemoteCatalog().catch(() => {
            if (this.destroyed) return;
            this.remoteCatalogRefreshFailed = true;
            this.renderPluginListArea();
          });
        });
    }

    for (const item of visibleItems) {
      this.renderPluginRow(item, column);
    }
    this.listScrollEl.scrollTop = previousScrollTop;
  }

  private renderPluginRow(
    item: CommunityPluginInventoryItem,
    column: PluginColumn,
  ): void {
    if (!this.listScrollEl) return;
    const restricted = column === "data"
      && !this.isPluginEffectivelyEnabled(item.id, "files");
    const displayName = this.getCommunityPluginDisplayName(item);
    const row = this.listScrollEl.createDiv("easy-sync-plugin-row");
    row.dataset.easySyncPluginId = item.id;
    const identity = row.createDiv("easy-sync-plugin-identity");
    identity.createDiv({
      cls: "easy-sync-plugin-name",
      text: displayName,
    });
    const status = this.describeInventoryItem(item, column);
    if (status) {
      identity.createDiv({
        cls: "easy-sync-plugin-status",
        text: status,
      });
    }
    const rowKey = this.getRowKey(column, item.id);
    const busy = this.busyPluginRows.has(rowKey)
      || this.confirmingDataRows.has(item.id);
    const scopeDisabled = !this.getCommunityPluginScopeEnabled(column)
      || (column === "data"
        && !this.getCommunityPluginScopeEnabled("files"));
    const pendingValue = this.pendingPluginValues.get(rowKey);
    const toggleCell = row.createDiv("easy-sync-plugin-toggle-cell");
    if (
      column === "files"
      && isCommunityPluginCloudCleanupCandidateV1({
        phase: item.participationPhase,
        local: item.local,
        remote: item.remote,
      })
      && !busy
      && !this.cleanedPluginIds.has(item.id)
    ) {
      const cleanup = new ExtraButtonComponent(toggleCell)
        .setIcon("trash-2")
        .setTooltip(this.plugin.i18n.t(
          "settings.communityPlugins.cleanup.tooltip",
          { plugin: displayName },
        ))
        .onClick(() => {
          void this.confirmCommunityPluginCloudCleanup(item, displayName);
        });
      cleanup.extraSettingsEl.addClass(
        "easy-sync-plugin-cloud-cleanup-trigger",
      );
      cleanup.extraSettingsEl.setAttribute(
        "aria-label",
        this.plugin.i18n.t(
          "settings.communityPlugins.cleanup.tooltip",
          { plugin: displayName },
        ),
      );
    }
    const toggle = new ToggleComponent(toggleCell)
      .setValue(
        pendingValue
        ?? this.isPluginEffectivelyEnabled(item.id, column),
      )
      .setDisabled(busy || scopeDisabled)
      .onChange((enabled) => {
        if (column === "data" && enabled) {
          void this.confirmPluginDataSelection(item, restricted);
          return;
        }
        this.queuePluginSelectionUpdate(
          column,
          item.id,
          enabled,
        );
      });
    toggle.toggleEl.setAttribute(
      "aria-label",
      this.plugin.i18n.t(
        restricted
          ? "settings.communityPlugins.data.restrictedAria"
          : column === "data"
            ? "settings.communityPlugins.data.toggleAria"
            : "settings.communityPlugins.toggleAria",
        { plugin: displayName },
      ),
    );
  }

  private async confirmCommunityPluginCloudCleanup(
    item: CommunityPluginInventoryItem,
    displayName: string,
  ): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const confirmed = await new ConfirmModal(
      this.plugin.app,
      t("settings.communityPlugins.cleanup.confirmTitle"),
      null,
      t("settings.communityPlugins.cleanup.confirmAction"),
      t("confirm.cancel"),
      t,
      {
        message: t("settings.communityPlugins.cleanup.confirmMessage", {
          plugin: displayName,
        }),
        warning: t("settings.communityPlugins.cleanup.confirmWarning"),
        danger: true,
      },
    ).awaitConfirm();
    if (!confirmed) return;
    const ok = await this.plugin.runCommunityPluginCloudCleanup(item.id);
    if (ok) {
      this.cleanedPluginIds.add(item.id);
      this.requestCommunityPluginInventoryRefresh();
    }
  }

  private getCommunityPluginDisplayName(
    item: Pick<CommunityPluginInventoryItem, "id" | "name">,
  ): string {
    const name = item.name?.trim();
    return name && name.length > 0
      ? name
      : item.id;
  }

  private describeInventoryItem(
    item: CommunityPluginInventoryItem,
    column: PluginColumn,
  ): string | null {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const restricted = column === "data"
      && !this.isPluginEffectivelyEnabled(item.id, "files");
    if (
      column === "files"
      && item.participationPhase === "blocked"
    ) {
      const blockedStatusKey =
        item.participationBlockedReason === "local-bundle-incomplete"
          ? "settings.communityPlugins.status.localBundleIncomplete"
          : item.participationBlockedReason === "manifest-incompatible"
            ? "settings.communityPlugins.status.restoreIncompatible"
            : item.participationBlockedReason === "remote-bundle-changed"
              ? "settings.communityPlugins.status.restoreTargetChanged"
              : item.participationBlockedReason === "scope-changed"
                ? "settings.communityPlugins.status.restoreScopeChanged"
                : "settings.communityPlugins.status.restoreBlocked";
      return t(blockedStatusKey);
    }
    if (
      column === "files"
      && (
        item.participationPhase === "join-requested"
        || item.participationPhase === "restoring"
      )
    ) {
      return t("settings.communityPlugins.status.joinRequested");
    }
    if (column === "files" && item.remoteCatalogStale) {
      return t("settings.communityPlugins.status.remoteCatalogStale");
    }
    if (
      !restricted
      && column === "data"
      && !item.dataLocally
      && !(this.remoteInventoryAvailable && item.dataRemotely)
    ) {
      return t("settings.communityPlugins.status.dataMissing");
    }
    if (
      !item.local
      && !item.remote
      && item.participationPhase !== "join-requested"
      && item.participationPhase !== "restoring"
      && item.participationPhase !== "blocked"
    ) {
      return t("settings.communityPlugins.status.unavailable");
    }
    if (
      item.desktopOnly
      && item.participationBlockedReason !== "manifest-incompatible"
    ) {
      return t("settings.communityPlugins.status.desktopOnly");
    }
    if (item.manifestIssue) {
      return t("settings.communityPlugins.status.manifestIssue");
    }
    if (this.remoteInventoryAvailable && item.local && !item.remote) {
      return t("settings.communityPlugins.status.localOnly");
    }
    if (
      this.remoteInventoryAvailable && item.remote && !item.local
      && !item.remoteCatalogStale
    ) {
      return t("settings.communityPlugins.status.remoteOnly");
    }
    return null;
  }

  private describeInventoryGuidance(
    items: CommunityPluginInventoryItem[],
    column: PluginColumn,
  ): string[] {
    if (column !== "files") return [];
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    let needsContentReview = false;
    let needsReinstall = false;
    let needsRecheck = false;
    let needsRetry = false;
    for (const item of items) {
      if (item.participationPhase === "blocked") {
        needsContentReview ||=
          item.participationBlockedReason === "local-bundle-incomplete";
        needsRecheck ||= item.participationBlockedReason === "remote-bundle-changed"
          || item.participationBlockedReason === "scope-changed";
        needsRetry ||= item.participationBlockedReason !== "local-bundle-incomplete"
          && item.participationBlockedReason !== "manifest-incompatible"
          && item.participationBlockedReason !== "remote-bundle-changed"
          && item.participationBlockedReason !== "scope-changed";
        continue;
      }
      needsReinstall ||= item.manifestIssue && !item.desktopOnly;
    }
    return [
      needsContentReview
        ? t("settings.communityPlugins.guidance.reviewIncomplete")
        : null,
      needsReinstall ? t("settings.communityPlugins.guidance.reinstall") : null,
      needsRecheck ? t("settings.communityPlugins.guidance.reconfirm") : null,
      needsRetry ? t("settings.communityPlugins.guidance.retry") : null,
    ].filter((value): value is string => value !== null);
  }

  private async confirmPluginDataSelection(
    item: CommunityPluginInventoryItem,
    enablePluginFiles: boolean,
  ): Promise<void> {
    if (this.confirmingDataRows.has(item.id)) return;
    this.confirmingDataRows.add(item.id);
    if (!this.destroyed) this.renderPluginListArea();
    const confirmed = await this.confirmExperimentalPluginData(
      enablePluginFiles
        ? "settings.communityPlugins.data.experimentalItemWithFilesMessage"
        : "settings.communityPlugins.data.experimentalItemMessage",
      { plugin: this.getCommunityPluginDisplayName(item) },
    );
    this.confirmingDataRows.delete(item.id);
    if (!confirmed) {
      if (!this.destroyed) this.renderPluginListArea();
      return;
    }
    if (enablePluginFiles) {
      this.queueSelectionUpdate(
        this.getRowKey("data", item.id),
        true,
        async () => {
          await this.plugin.updateCommunityPluginFilesSelection(
            item.id,
            true,
          );
          const next = enableCommunityPluginDataWithFiles(
            this.captureSelectionSettings(),
            item.id,
            this.getKnownPluginIds(),
            this.plugin.manifest.id,
          );
          await this.plugin.updateSyncPathSettings(
            this.toSyncPathSettingsPatch(next),
          );
        },
      );
      return;
    }
    this.queuePluginSelectionUpdate("data", item.id, true);
  }

  private confirmExperimentalPluginData(
    messageKey: string,
    params: Record<string, string | number>,
  ): Promise<boolean> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    return new ConfirmModal(
      this.plugin.app,
      t("settings.communityPlugins.data.experimentalConfirmTitle"),
      null,
      t("settings.communityPlugins.data.experimentalConfirm"),
      t("confirm.cancel"),
      t,
      {
        message: t(messageKey, params),
        warning: t("settings.communityPlugins.data.experimentalWarning"),
        danger: true,
      },
    ).awaitConfirm();
  }

  private appendExperimentalPluginDataChip(containerEl: HTMLElement): void {
    containerEl.createSpan({
      cls: "easy-sync-plugin-selection-chip is-experimental",
      text: this.plugin.i18n.t("settings.communityPlugins.experimental"),
    });
  }

  private queuePluginSelectionUpdate(
    column: PluginColumn,
    pluginId: string,
    enabled: boolean,
  ): void {
    const rowKey = this.getRowKey(column, pluginId);
    if (column === "files") {
      this.queueSelectionUpdate(
        rowKey,
        enabled,
        () => this.plugin.updateCommunityPluginFilesSelection(
          pluginId,
          enabled,
        ),
      );
      return;
    }
    this.queueSelectionUpdate(
      rowKey,
      enabled,
      async () => {
        const next = updateCommunityPluginSelection(
          this.captureSelectionSettings(),
          column,
          pluginId,
          enabled,
          this.getKnownPluginIds(),
          this.plugin.manifest.id,
        );
        await this.plugin.updateSyncPathSettings(
          this.toSyncPathSettingsPatch(next),
        );
      },
    );
  }

  private queueSelectionUpdate(
    rowKey: string,
    pendingValue: boolean,
    commit: () => Promise<void>,
  ): void {
    if (this.busyPluginRows.has(rowKey)) return;
    this.busyPluginRows.add(rowKey);
    this.pendingPluginValues.set(rowKey, pendingValue);
    if (!this.destroyed) {
      this.renderPluginListArea();
    }
    void this.settingsUpdateQueue.enqueue(async () => {
      try {
        await commit();
      } catch (error) {
        this.showSyncPathSettingsError(error);
      } finally {
        this.busyPluginRows.delete(rowKey);
        this.pendingPluginValues.delete(rowKey);
        if (!this.destroyed) {
          this.renderPluginListArea();
        }
      }
    });
  }

  private captureSelectionSettings(): CommunityPluginSelectionSettings {
    return {
      filesEnabled: this.plugin.syncCommunityPlugins,
      dataEnabled: this.plugin.syncPluginData,
      policy: cloneCommunityPluginSyncPolicy(
        this.plugin.communityPluginSyncPolicy,
      ),
    };
  }

  private toSyncPathSettingsPatch(
    next: Readonly<CommunityPluginSelectionSettings>,
  ): Partial<SyncPathSettings> {
    return {
      syncCommunityPlugins: next.filesEnabled,
      syncPluginData: next.dataEnabled,
      communityPluginSyncPolicy: next.policy,
    };
  }

  private getKnownPluginIds(): string[] {
    return this.inventory.map((item) => item.id);
  }

  private isPluginEffectivelyEnabled(
    pluginId: string,
    column: PluginColumn,
  ): boolean {
    if (column === "files") {
      return this.plugin.isCommunityPluginFilesParticipationEnabled(pluginId);
    }
    const filesEnabled =
      this.plugin.isCommunityPluginFilesParticipationEnabled(pluginId);
    return this.plugin.syncPluginData
      && filesEnabled
      && isPluginSelected(
        this.plugin.communityPluginSyncPolicy.data,
        pluginId,
      );
  }

  private getManagerColumn(): PluginColumn | null {
    return this.view === "community-plugin-files"
      ? "files"
      : this.view === "community-plugin-data"
        ? "data"
        : null;
  }

  private getRowKey(column: PluginColumn, pluginId: string): string {
    return `${column}:${pluginId}`;
  }

  private showSyncPathSettingsError(error: unknown): void {
    const key = error instanceof SyncPathSettingsUpdateError
      ? error.code === "busy"
        ? "notice.syncPathSettings.busy"
        : "notice.syncPathSettings.recovery"
      : "notice.syncPathSettings.failed";
    new Notice(this.plugin.i18n.t(key));
  }
}
