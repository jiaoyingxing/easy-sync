/**
 * VaultJoinOfferModal — the first-sync decision of the EasySync repository
 * join offer (carrier 20261003-2128 R1): the cloud already holds sync
 * repositories and none of their names matches this vault. The offer names
 * only the count — the concrete names live one step deeper, in
 * VaultJoinRepositoryListModal, which the caller opens on "join". Closing
 * means "not now": nothing syncs this round and the choice stays available
 * at the next first-sync trigger.
 *
 * Shell and option rows are the same house pattern as the migration offer.
 */
import { type App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";

type VaultJoinOfferResult =
  | { action: "join" }
  | { action: "fresh-sync" }
  | { action: "dismiss" };

interface VaultJoinOfferViews {
  title: string;
  body: string;
  join: { title: string; description: string };
  fresh: { title: string; description: string };
}

export class VaultJoinOfferModal extends EasySyncModal {
  private resolve: ((value: VaultJoinOfferResult) => void) | null = null;
  private finished = false;

  constructor(
    app: App,
    private views: VaultJoinOfferViews,
  ) {
    super(app);
  }

  awaitAction(): Promise<VaultJoinOfferResult> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(result: VaultJoinOfferResult): void {
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
    const joinButton = this.buildOptionButton(this.views.join);
    joinButton.addEventListener("click", () => {
      this.finish({ action: "join" });
    });
    contentEl.appendChild(joinButton);
    const freshButton = this.buildOptionButton(this.views.fresh);
    freshButton.addEventListener("click", () => {
      this.finish({ action: "fresh-sync" });
    });
    contentEl.appendChild(freshButton);
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({ action: "dismiss" });
  }
}
