import { beforeEach, describe, expect, it, vi } from "vitest";
import { SliderComponent } from "./__mocks__/obsidian";
import { I18n } from "../src/i18n";
import type EasySyncPlugin from "../src/main";
import { AutoSyncModal } from "../src/ui/auto-sync-modal";

// The modal writes plugin fields and persists through the plugin's own
// save/restart methods; those are mocked here so the test can assert the
// save chain without touching state.
function createMockPlugin(): EasySyncPlugin {
  const i18n = new I18n("zh-cn");
  return {
    app: {} as never,
    i18n,
    syncInterval: 3,
    autoSyncChangeDelaySeconds: 5,
    saveSyncSettings: vi.fn().mockResolvedValue(undefined),
    restartAutoSync: vi.fn(),
    setAutoSyncChangeDelaySeconds: vi.fn(function (
      this: { autoSyncChangeDelaySeconds: number },
      value: number,
    ): void {
      this.autoSyncChangeDelaySeconds = value;
    }),
    isAutoSyncMasterEnabled: function (
      this: { syncInterval: number; autoSyncChangeDelaySeconds: number },
    ): boolean {
      return this.syncInterval > 0 || this.autoSyncChangeDelaySeconds > 0;
    },
    refreshSettingsTab: vi.fn(),
  } as unknown as EasySyncPlugin;
}

describe("AutoSyncModal", () => {
  beforeEach(() => {
    SliderComponent.instances.length = 0;
  });

  it("renders both sliders through onOpen", () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    // Two sliders: interval and change-delay.
    expect(SliderComponent.instances).toHaveLength(2);
  });

  it("persists a new interval and restarts auto sync on slider change", async () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    const intervalSlider = SliderComponent.instances[0];
    await intervalSlider.triggerChange(7);

    expect(plugin.syncInterval).toBe(7);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(plugin.restartAutoSync).toHaveBeenCalledTimes(1);
  });

  it("reads the scheduled slider as minutes with 0 as the off stop", async () => {
    const plugin = createMockPlugin();
    plugin.syncInterval = 0;
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    const intervalSlider = SliderComponent.instances[0];
    // Off parks the thumb on 0, matching the change-delay slider's readout.
    expect(intervalSlider.value).toBe(0);

    await intervalSlider.triggerChange(1);
    expect(plugin.syncInterval).toBe(1);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(plugin.restartAutoSync).toHaveBeenCalledTimes(1);

    await intervalSlider.triggerChange(0);
    expect(plugin.syncInterval).toBe(0);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(2);
  });

  it("persists a new change delay through the plugin setter on slider change", async () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    const delaySlider = SliderComponent.instances[1];
    await delaySlider.triggerChange(8);

    expect(plugin.setAutoSyncChangeDelaySeconds).toHaveBeenCalledWith(8);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
  });

  it("refreshes the settings page master row after either slider change", async () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    await SliderComponent.instances[0].triggerChange(7);
    expect(plugin.refreshSettingsTab).toHaveBeenCalledTimes(1);

    await SliderComponent.instances[1].triggerChange(8);
    expect(plugin.refreshSettingsTab).toHaveBeenCalledTimes(2);
  });

  it("re-arms auto sync when the change-delay slider turns the master on", async () => {
    const plugin = createMockPlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncChangeDelaySeconds = 0;
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    await SliderComponent.instances[1].triggerChange(7);

    // Master flipped off→on with the scheduled channel off: the join and
    // recovery surfaces must be armed through the shared restart entry.
    expect(plugin.restartAutoSync).toHaveBeenCalledTimes(1);
    expect(plugin.refreshSettingsTab).toHaveBeenCalledTimes(1);
  });

  it("does not restart auto sync for a delay adjustment that keeps the master on", async () => {
    const plugin = createMockPlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncChangeDelaySeconds = 5;
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    await SliderComponent.instances[1].triggerChange(8);

    // Plain delay adjustment: the pending dirty window must survive, so no
    // restart; only the settings row refresh runs.
    expect(plugin.restartAutoSync).not.toHaveBeenCalled();
    expect(plugin.refreshSettingsTab).toHaveBeenCalledTimes(1);
  });

  it("keeps the configured values as slider initial values", () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    expect(SliderComponent.instances[0].value).toBe(3);
    expect(SliderComponent.instances[1].value).toBe(5);
  });

  it("leads with the guidance line in the shared intro class", () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    const created: Array<{ tag: string; text?: string; cls?: string }> = [];
    const createEl = modal.contentEl.createEl.bind(modal.contentEl);
    modal.contentEl.createEl = ((
      tag: string,
      options?: { text?: string; cls?: string },
    ) => {
      created.push({ tag, text: options?.text, cls: options?.cls });
      return createEl(tag, options);
    }) as unknown as typeof modal.contentEl.createEl;

    modal.onOpen();

    // One paragraph, created before any Setting: zero is the off stop and a
    // pause only clears through a manual sync — neither is visible from the
    // two slider rows alone. The class keeps the line on phones (see
    // styles.css "easy-sync-modal-intro").
    expect(created).toEqual([
      {
        tag: "p",
        text: "拖到最左侧（归零）即关闭；自动同步若被特殊状态打断，须手动同步一次才继续。",
        cls: "setting-item-description easy-sync-modal-intro",
      },
    ]);
  });

  it("paints the slider fill ratio on open, change, and drag input", async () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    // Initial value 3 of 0..10 painted immediately: hosts without the
    // 1.13+ fill mechanism render a flat gray track otherwise.
    const intervalSlider = SliderComponent.instances[0];
    expect(intervalSlider.getInlineCssProp("--slider-fill-ratio")).toBe("0.3");

    await intervalSlider.triggerChange(7);
    expect(intervalSlider.getInlineCssProp("--slider-fill-ratio")).toBe("0.7");

    // Dragging fires input events before release; the fill follows live.
    intervalSlider.fireInput(1);
    expect(intervalSlider.getInlineCssProp("--slider-fill-ratio")).toBe("0.1");
  });

  it("renders a numeric readout beside the slider on hosts without one", async () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    // Mock sliders mirror the old-host shape: the control container starts
    // with just the input, so the plugin supplies the readout that 1.13+
    // hosts render natively — same class, before the input, initial value.
    const intervalSlider = SliderComponent.instances[0];
    const container = intervalSlider.sliderEl
      .parentElement as unknown as HTMLElement;
    const children = container.children as unknown as Array<{
      classList: { contains(token: string): boolean };
      textContent: string;
    }>;
    expect(children).toHaveLength(2);
    const valueEl = children[0];
    expect(valueEl.classList.contains("slider-value")).toBe(true);
    expect(valueEl.textContent).toBe("3");

    await intervalSlider.triggerChange(7);
    expect(valueEl.textContent).toBe("7");

    // Dragging fires input events before release; the readout follows live.
    intervalSlider.fireInput(1);
    expect(valueEl.textContent).toBe("1");

    // The second slider carries its own readout with its own value.
    const delaySlider = SliderComponent.instances[1];
    const delayChildren = (delaySlider.sliderEl.parentElement as unknown as {
      children: Array<{ textContent: string }>;
    }).children;
    expect(delayChildren[0].textContent).toBe("5");
  });

  it("leaves the host readout untouched when the host already renders one", async () => {
    SliderComponent.simulateHostValueReadout = true;
    try {
      const plugin = createMockPlugin();
      const modal = new AutoSyncModal(plugin);
      modal.onOpen();

      // 1.13+ shape: the host readout sits ahead of the input and the
      // plugin must not add a second one or write into the host's element.
      const intervalSlider = SliderComponent.instances[0];
      const container = intervalSlider.sliderEl
        .parentElement as unknown as HTMLElement;
      const children = container.children as unknown as Array<{
        classList: { contains(token: string): boolean };
        textContent: string;
      }>;
      expect(children).toHaveLength(2);
      expect(children[0].classList.contains("slider-value")).toBe(true);

      await intervalSlider.triggerChange(7);
      intervalSlider.fireInput(1);
      expect(children[0].textContent).toBe("");

      // The fill keeps painting through the same display sync.
      expect(intervalSlider.getInlineCssProp("--slider-fill-ratio")).toBe(
        "0.1",
      );
    } finally {
      SliderComponent.simulateHostValueReadout = false;
    }
  });
});
