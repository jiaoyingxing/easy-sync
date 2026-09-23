import { Notice, Setting, SliderComponent } from "obsidian";
import type EasySyncPlugin from "../main";
import { EasySyncModal } from "./easy-sync-modal";

/**
 * Paint the accent fill left of the thumb. Host 1.13+ drives this itself
 * (SliderComponent writes `--slider-fill-ratio` and its CSS paints the
 * gradient); older hosts — several Android builds included — ship no fill
 * and leave a flat gray track. Writing the same inline property on every
 * host is idempotent, so one code path covers both; the matching gradient
 * lives in styles.css "Auto-sync slider fill". `value` overrides the DOM
 * readout when the caller already knows the authoritative value (onChange).
 */
function paintSliderFill(slider: SliderComponent, value?: number): void {
  const el = slider.sliderEl;
  const min = Number.parseFloat(el.min) || 0;
  const max = Number.parseFloat(el.max) || 100;
  const current = value ?? el.valueAsNumber;
  const ratio = max > min ? (current - min) / (max - min) : 0;
  el.style.setProperty("--slider-fill-ratio", `${ratio}`);
}

/**
 * Numeric readout beside the track. Host 1.13+ renders this itself
 * (SliderComponent creates a `.slider-value` span before the input and keeps
 * its text in sync); older hosts — several Android builds included — ship no
 * readout at all: their value tooltip was hover-only, which touch screens
 * never trigger. ensureSliderValueEl() creates the same span in the same
 * position only when the host didn't, and syncSliderValue() mirrors the
 * value at the same three points paintSliderFill covers; formatting mirrors
 * the host's getValuePretty(). On 1.13+ hosts both are no-ops, so the native
 * element is what users see. Matching styles live in styles.css "Auto-sync
 * slider value".
 */
const sliderValueEls = new WeakMap<SliderComponent, HTMLElement>();

function ensureSliderValueEl(slider: SliderComponent): void {
  const container = slider.sliderEl.parentElement;
  if (!container || container.querySelector(":scope > .slider-value")) return;
  const valueEl = container.createSpan("slider-value");
  slider.sliderEl.before(valueEl);
  sliderValueEls.set(slider, valueEl);
  syncSliderValue(slider);
}

function syncSliderValue(slider: SliderComponent, value?: number): void {
  const valueEl = sliderValueEls.get(slider);
  if (!valueEl) return;
  const el = slider.sliderEl;
  const current = value ?? el.valueAsNumber;
  const pretty =
    el.step === "any" || Number.parseFloat(el.step) < 1
      ? current.toFixed(2)
      : String(current);
  valueEl.setText(pretty);
}

/** Fill + numeric readout in one call at each sync point. */
function paintSliderDisplay(slider: SliderComponent, value?: number): void {
  paintSliderFill(slider, value);
  syncSliderValue(slider, value);
}

export class AutoSyncModal extends EasySyncModal {
  constructor(private plugin: EasySyncPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    contentEl.empty();
    contentEl.addClass("easy-sync-auto-sync");
    this.setTitle(t("settings.autoSync.title"));
    contentEl.createEl("p", {
      text: t("settings.autoSync.intro"),
      cls: "setting-item-description easy-sync-modal-intro",
    });

    const describeSyncInterval = (minutes: number): string =>
      minutes === 0
        ? t("settings.syncInterval.disabledDesc")
        : t("settings.syncInterval.desc", { minutes });

    const describeAutoSyncChangeDelay = (seconds: number): string =>
      seconds === 0
        ? t("settings.autoSyncChangeDelay.disabledDesc")
        : t("settings.autoSyncChangeDelay.desc", { seconds });

    new Setting(contentEl)
      .setName(t("settings.syncInterval.name"))
      .setDesc(describeSyncInterval(this.plugin.syncInterval))
      .addSlider((slider) => {
        // Scheduled sync reads minutes directly: 0 = off (persisted as
        // syncInterval 0), 1–10 = minutes — same shape as the change-delay
        // slider, so the off state displays as 0 on both.
        slider
          .setLimits(0, 10, 1)
          .setValue(this.plugin.syncInterval)
          .onChange(async (value) => {
            paintSliderDisplay(slider, value);
            const previous = this.plugin.syncInterval;
            this.plugin.syncInterval = value;
            try {
              await this.plugin.saveSyncSettings();
            } catch {
              this.plugin.syncInterval = previous;
              slider.setValue(previous);
              new Notice(t("notice.settingsSaveFailed"));
              return;
            }
            this.plugin.restartAutoSync();
            this.plugin.refreshSettingsTab();
            const desc = slider.sliderEl
              .closest(".setting-item")
              ?.querySelector(".setting-item-description");
            if (desc) {
              desc.textContent = describeSyncInterval(value);
            }
          });
        ensureSliderValueEl(slider);
        paintSliderDisplay(slider);
        slider.sliderEl.addEventListener("input", () =>
          paintSliderDisplay(slider),
        );
      });

    new Setting(contentEl)
      .setName(t("settings.autoSyncChangeDelay.name"))
      .setDesc(describeAutoSyncChangeDelay(this.plugin.autoSyncChangeDelaySeconds))
      .addSlider((slider) => {
        slider
          .setLimits(0, 10, 1)
          .setValue(this.plugin.autoSyncChangeDelaySeconds)
          .onChange(async (value) => {
            paintSliderDisplay(slider, value);
            const previous = this.plugin.autoSyncChangeDelaySeconds;
            const masterWasOn = this.plugin.isAutoSyncMasterEnabled();
            this.plugin.setAutoSyncChangeDelaySeconds(value);
            try {
              await this.plugin.saveSyncSettings();
            } catch {
              this.plugin.setAutoSyncChangeDelaySeconds(previous);
              slider.setValue(previous);
              new Notice(t("notice.settingsSaveFailed"));
              return;
            }
            // A delay turn can flip the master switch (last channel on/off);
            // re-arm or release the join/recovery/timer surfaces with it. A
            // plain adjustment keeps the pending dirty window — no restart.
            if (this.plugin.isAutoSyncMasterEnabled() !== masterWasOn) {
              this.plugin.restartAutoSync();
            }
            this.plugin.refreshSettingsTab();
            const desc = slider.sliderEl
              .closest(".setting-item")
              ?.querySelector(".setting-item-description");
            if (desc) {
              desc.textContent = describeAutoSyncChangeDelay(value);
            }
          });
        ensureSliderValueEl(slider);
        paintSliderDisplay(slider);
        slider.sliderEl.addEventListener("input", () =>
          paintSliderDisplay(slider),
        );
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
