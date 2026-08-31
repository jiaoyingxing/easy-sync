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
    setAutoSyncChangeDelaySeconds: vi.fn(),
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

  it("persists a new change delay through the plugin setter on slider change", async () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    const delaySlider = SliderComponent.instances[1];
    await delaySlider.triggerChange(8);

    expect(plugin.setAutoSyncChangeDelaySeconds).toHaveBeenCalledWith(8);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the configured values as slider initial values", () => {
    const plugin = createMockPlugin();
    const modal = new AutoSyncModal(plugin);
    modal.onOpen();

    expect(SliderComponent.instances[0].value).toBe(3);
    expect(SliderComponent.instances[1].value).toBe(5);
  });
});
