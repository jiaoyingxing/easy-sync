import {
  ButtonComponent,
  ExtraButtonComponent,
  Modal,
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
import type { PendingCommunityPluginEnablementDecision } from "../sync/state-manager";
import type {
  CommunityPluginEnablementDecisionResolution,
} from "../sync/community-plugin-enablement";
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
import { ConfirmModal } from "./confirm-modal";
import { SequentialSettingsUpdateQueue } from "./sequential-settings-update-queue";

export type ConfigSyncView =
  | "scope"
  | "community-plugin-files"
  | "community-plugin-data";

type PluginColumn = CommunityPluginSelectionColumn;

interface CommunityPluginScopeControls {
  toggle: ToggleComponent;
  manageButton: ButtonComponent;
  selectionChipEl: HTMLElement;
}

type CommunityPluginDecisionSide = "local" | "remote";

interface CommunityPluginDecisionItem {
  pluginName: string;
  decision: PendingCommunityPluginEnablementDecision;
}

class CommunityPluginEnablementDecisionModal extends Modal {
  private resolve: (
    (
      choices: CommunityPluginEnablementDecisionResolution[] | null,
    ) => void
  ) | null = null;
  private readonly choices = new Map<
    string,
    CommunityPluginDecisionSide
  >();
  private readonly optionButtons = new Map<string, {
    local: ButtonComponent;
    remote: ButtonComponent;
  }>();
  private saveButton: ButtonComponent | null = null;

  constructor(
    private plugin: EasySyncPlugin,
    private items: readonly CommunityPluginDecisionItem[],
  ) {
    super(plugin.app);
    for (const { decision } of items) {
      if (decision.resolvedEnabled === decision.localEnabled) {
        this.choices.set(decision.pluginId, "local");
      } else if (decision.resolvedEnabled === decision.remoteEnabled) {
        this.choices.set(decision.pluginId, "remote");
      }
    }
  }

  awaitChoices(): Promise<
    CommunityPluginEnablementDecisionResolution[] | null
  > {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(): void {
    if (this.choices.size !== this.items.length) return;
    const choices = this.items.map(({ decision }) => ({
      pluginId: decision.pluginId,
      localEnabled: decision.localEnabled,
      remoteEnabled: decision.remoteEnabled,
      enabled: this.choices.get(decision.pluginId) === "local"
        ? decision.localEnabled
        : decision.remoteEnabled,
    }));
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(choices);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const { contentEl } = this;
    contentEl.empty();
    this.optionButtons.clear();
    this.modalEl.addClass("easy-sync-plugin-decisions-modal");
    this.setTitle(t("settings.communityPlugins.decisions.title", {
      count: this.items.length,
    }));
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("settings.communityPlugins.decisions.message"),
    });

    const list = contentEl.createDiv("easy-sync-plugin-decisions-list");
    for (const item of this.items) {
      this.renderDecision(list, item);
    }

    const buttonRow = contentEl.createDiv(
      "modal-button-container easy-sync-plugin-decisions-actions",
    );
    new ButtonComponent(buttonRow)
      .setButtonText(t("confirm.cancel"))
      .onClick(() => this.close());
    this.saveButton = new ButtonComponent(buttonRow)
      .setButtonText(t("settings.communityPlugins.decisions.saveAndSync"))
      .setCta()
      .setDisabled(this.choices.size !== this.items.length)
      .onClick(() => this.finish());
  }

  private renderDecision(
    container: HTMLElement,
    item: CommunityPluginDecisionItem,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const { decision } = item;
    const row = container.createDiv("easy-sync-plugin-decision-row");
    row.createDiv("easy-sync-plugin-decision-name").setText(item.pluginName);
    row.createDiv("easy-sync-plugin-decision-state").setText(
      t("settings.communityPlugins.decisions.state", {
        local: t(
          decision.localEnabled
            ? "settings.communityPlugins.decisions.enabled"
            : "settings.communityPlugins.decisions.disabled",
        ),
        remote: t(
          decision.remoteEnabled
            ? "settings.communityPlugins.decisions.enabled"
            : "settings.communityPlugins.decisions.disabled",
        ),
      }),
    );
    const actions = row.createDiv("easy-sync-plugin-decision-options");
    const localButton = new ButtonComponent(actions)
      .setButtonText(t("settings.communityPlugins.decisions.local"))
      .onClick(() => this.choose(decision.pluginId, "local"));
    const remoteButton = new ButtonComponent(actions)
      .setButtonText(t("settings.communityPlugins.decisions.remote"))
      .onClick(() => this.choose(decision.pluginId, "remote"));
    this.optionButtons.set(decision.pluginId, {
      local: localButton,
      remote: remoteButton,
    });
    this.refreshChoice(decision.pluginId);
  }

  private choose(
    pluginId: string,
    side: CommunityPluginDecisionSide,
  ): void {
    this.choices.set(pluginId, side);
    this.refreshChoice(pluginId);
    this.saveButton?.setDisabled(this.choices.size !== this.items.length);
  }

  private refreshChoice(pluginId: string): void {
    const buttons = this.optionButtons.get(pluginId);
    if (!buttons) return;
    const selected = this.choices.get(pluginId);
    for (const [side, button] of Object.entries(buttons) as Array<[
      CommunityPluginDecisionSide,
      ButtonComponent,
    ]>) {
      const pressed = selected === side;
      button.buttonEl.classList.toggle("mod-cta", pressed);
      button.buttonEl.setAttribute("aria-pressed", String(pressed));
    }
  }

  onClose(): void {
    this.optionButtons.clear();
    this.saveButton = null;
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(null);
  }
}

export class ConfigSyncModal extends Modal {
  private view: ConfigSyncView = "scope";
  private inventory: CommunityPluginInventoryItem[] = [];
  private scopeInventory: CommunityPluginInventoryItem[] = [];
  private scopeInventoryLoaded = false;
  private pendingDecisions: PendingCommunityPluginEnablementDecision[] = [];
  private pendingDecisionRevision = "";
  private remoteInventoryAvailable = false;
  private inventoryLoading = false;
  private inventoryLoadFailed = false;
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
  private decisionBatchSaving = false;
  private decisionModal: CommunityPluginEnablementDecisionModal | null = null;
  private settingsUpdateQueue = new SequentialSettingsUpdateQueue();
  private unsubscribeCommunityPluginInventoryRevision: (() => void) | null =
    null;
  private inventoryRevisionRefreshRunning = false;
  private inventoryRevisionRefreshPending = false;

  constructor(
    private plugin: EasySyncPlugin,
    private initialView: ConfigSyncView = "scope",
    private focusPendingDecision = false,
    private onCloseCallback?: () => void,
  ) {
    super(plugin.app);
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
    const decisionModal = this.decisionModal;
    this.decisionModal = null;
    decisionModal?.close();
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

    const toggles: Array<{
      key: string;
      get: () => boolean;
      patch: (value: boolean) => Partial<SyncPathSettings>;
    }> = [
      {
        key: "settings.syncPluginFiles",
        get: () => this.plugin.syncPluginFiles,
        patch: (value) => ({ syncPluginFiles: value }),
      },
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
        key: "settings.syncCorePlugins",
        get: () => this.plugin.syncCorePlugins,
        patch: (value) => ({ syncCorePlugins: value }),
      },
    ];

    for (const toggleConfig of toggles) {
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

    this.renderCommunityPluginScopeSetting(
      "files",
      "settings.syncCommunityPlugins",
    );
    this.renderCommunityPluginScopeSetting(
      "data",
      "settings.syncPluginData",
    );
    this.requestCommunityPluginInventoryRefresh();
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
      false,
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
      ? this.scopeInventory
      : this.scopeInventory.filter((item) =>
          this.isPluginEffectivelyEnabled(item.id, "files")
        );
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
    this.pendingDecisions = [];
    this.pendingDecisionRevision = "";
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
        new Notice(this.plugin.i18n.t(
          "notice.communityPlugins.remoteCatalogFailed",
        ));
      });
    }
  }

  private async reloadCommunityPluginManager(
    column: PluginColumn,
    generation: number,
  ): Promise<void> {
    this.inventoryLoading = true;
    this.inventoryLoadFailed = false;
    this.renderPluginListArea();
    try {
      const [inventory, remoteInventoryAvailable, pendingSnapshot] =
        await Promise.all([
          this.plugin.getCommunityPluginInventory(),
          this.plugin.hasTrustedCommunityPluginRemoteInventory(column),
          column === "files"
            ? this.plugin.getCommunityPluginEnablementDecisionSnapshot()
            : Promise.resolve({ revision: "", decisions: [] }),
        ]);
      if (
        generation !== this.loadGeneration
        || this.destroyed
        || this.getManagerColumn() !== column
      ) return;
      this.inventory = inventory;
      this.remoteInventoryAvailable = remoteInventoryAvailable;
      this.pendingDecisions = pendingSnapshot.decisions;
      this.pendingDecisionRevision = pendingSnapshot.revision;
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
        this.focusPendingDecisionIfRequested();
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
      normalizedQuery.length === 0
      || (
        item.name !== null
        && item.name.toLocaleLowerCase().includes(normalizedQuery)
      )
      || item.id.toLocaleLowerCase().includes(normalizedQuery)
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
    const pendingValue = this.pendingPluginValues.get(rowKey);
    const toggleCell = row.createDiv("easy-sync-plugin-toggle-cell");
    if (column === "files") {
      const decision = this.pendingDecisions.find(
        (candidate) => candidate.pluginId === item.id,
      );
      if (decision) {
        this.renderDecisionTrigger(toggleCell, displayName, decision);
      }
    }
    const toggle = new ToggleComponent(toggleCell)
      .setValue(
        pendingValue
        ?? this.isPluginEffectivelyEnabled(item.id, column),
      )
      .setDisabled(busy)
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

  private renderDecisionTrigger(
    toggleCell: HTMLElement,
    pluginName: string,
    _decision: PendingCommunityPluginEnablementDecision,
  ): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const label = t("settings.communityPlugins.decisions.open", {
      plugin: pluginName,
    });
    const trigger = new ExtraButtonComponent(toggleCell)
      .setIcon("triangle-alert")
      .setTooltip(label)
      .setDisabled(this.decisionBatchSaving)
      .onClick(() => {
        void this.openDecisionModal();
      });
    trigger.extraSettingsEl.addClass("easy-sync-plugin-decision-trigger");
    trigger.extraSettingsEl.setAttribute("aria-label", label);
  }

  private async openDecisionModal(): Promise<void> {
    if (
      this.destroyed
      || this.decisionModal
      || this.decisionBatchSaving
      || this.pendingDecisions.length === 0
    ) return;
    const modal = new CommunityPluginEnablementDecisionModal(
      this.plugin,
      this.pendingDecisions.map((decision) => ({
        decision,
        pluginName: this.getCommunityPluginDecisionDisplayName(decision),
      })),
    );
    const expectedRevision = this.pendingDecisionRevision;
    this.decisionModal = modal;
    const choices = await modal.awaitChoices();
    if (this.decisionModal === modal) this.decisionModal = null;
    if (!choices || this.destroyed) return;
    await this.resolvePendingDecisions(expectedRevision, choices);
  }

  private async resolvePendingDecisions(
    expectedRevision: string,
    choices: readonly CommunityPluginEnablementDecisionResolution[],
  ): Promise<void> {
    if (this.decisionBatchSaving) return;
    this.decisionBatchSaving = true;
    this.renderPluginListArea();
    let resolved = false;
    try {
      resolved = await this.plugin.resolveCommunityPluginEnablementDecisions(
        expectedRevision,
        choices,
      );
    } catch {
      resolved = false;
    } finally {
      this.decisionBatchSaving = false;
    }
    if (!resolved) {
      new Notice(this.plugin.i18n.t(
        "notice.communityPlugins.decisionUnavailable",
      ));
      this.requestCommunityPluginInventoryRefresh();
    } else {
      this.pendingDecisions = [];
      this.pendingDecisionRevision = "";
      this.close();
      await this.plugin.startManualSync();
      return;
    }
    if (!this.destroyed) this.renderPluginListArea();
  }

  private getCommunityPluginDecisionDisplayName(
    decision: PendingCommunityPluginEnablementDecision,
  ): string {
    const item = this.inventory.find(
      (candidate) => candidate.id === decision.pluginId,
    );
    return item
      ? this.getCommunityPluginDisplayName(item)
      : decision.pluginId;
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

  private focusPendingDecisionIfRequested(): void {
    if (
      !this.focusPendingDecision
      || this.getManagerColumn() !== "files"
      || this.pendingDecisions.length === 0
    ) return;
    this.focusPendingDecision = false;
    void this.openDecisionModal();
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
