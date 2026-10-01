/**
 * RsMigrationOfferModal — the one new decision of the Remotely Save adoption
 * (carrier plan §11.2/§11.4): take over the detected foreign cloud repository
 * (adopted content seeds identical baselines, differences go to plan review)
 * or run a plain fresh sync. Closing means "not now": nothing syncs this
 * round and the choice is preserved for the next first-sync trigger.
 *
 * Shell and option rows are the auth-method modal's house pattern; neither
 * option is marked "recommended" (D1).
 */
import { type App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";

export type RsMigrationOfferResult =
  | { action: "migrate" }
  | { action: "fresh-sync" }
  | { action: "dismiss" };

export interface RsMigrationOfferViews {
  title: string;
  body: string;
  migrate: { title: string; description: string };
  fresh: { title: string; description: string };
  crossDeviceNote: string;
}

export class RsMigrationOfferModal extends EasySyncModal {
  private resolve: ((value: RsMigrationOfferResult) => void) | null = null;
  private finished = false;

  constructor(
    app: App,
    private views: RsMigrationOfferViews,
  ) {
    super(app);
  }

  awaitAction(): Promise<RsMigrationOfferResult> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(result: RsMigrationOfferResult): void {
    if (this.finished) return;
    this.finished = true;
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(result);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-sync-auth-method-modal");
    this.setTitle(this.views.title);

    contentEl.createEl("p", {
      text: this.views.body,
      cls: "setting-item-description",
    });
    const migrateButton = this.buildOptionButton(this.views.migrate);
    migrateButton.addEventListener("click", () => {
      this.finish({ action: "migrate" });
    });
    contentEl.appendChild(migrateButton);
    const freshButton = this.buildOptionButton(this.views.fresh);
    freshButton.addEventListener("click", () => {
      this.finish({ action: "fresh-sync" });
    });
    contentEl.appendChild(freshButton);

    contentEl.createEl("p", {
      text: this.views.crossDeviceNote,
      cls: "setting-item-description",
    });
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({ action: "dismiss" });
  }
}
