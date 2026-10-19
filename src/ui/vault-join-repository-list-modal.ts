/**
 * VaultJoinRepositoryListModal — the second step of the EasySync repository
 * join offer (carrier 20261003-2128 R1): lists the joinable cloud repository
 * names so the user can copy one and rename this vault to it. The rows arrive
 * pre-loaded (the offer already ran the full detection), so there is no
 * loading state; clicking a row copies its name, with the same feedback
 * pattern as the login device-code modal (success / unavailable notices).
 */
import { setIcon, type App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";
import { NOTICE_PRIORITY, type EasySyncNoticeCenter } from "./notice-center";

interface VaultJoinRepositoryListViews {
  title: string;
  guide: string;
  empty: string;
  rows: string[];
  copiedNotice: string;
  copyUnavailableNotice: string;
}

export class VaultJoinRepositoryListModal extends EasySyncModal {
  private resolve: (() => void) | null = null;

  constructor(
    app: App,
    private views: VaultJoinRepositoryListViews,
    private noticeCenter: EasySyncNoticeCenter,
  ) {
    super(app);
  }

  awaitAction(): Promise<void> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-sync-auth-method-modal");
    this.setTitle(this.views.title);

    contentEl.createEl("p", {
      text: this.views.guide,
      cls: "setting-item-description",
    });
    if (this.views.rows.length === 0) {
      contentEl.createEl("p", {
        text: this.views.empty,
        cls: "setting-item-description",
      });
      return;
    }
    const list = contentEl.createDiv({ cls: "easy-sync-vault-join-list" });
    for (const name of this.views.rows) {
      const row = list.createEl("button", {
        cls: "easy-sync-vault-join-repo-row",
        type: "button",
      });
      row.createSpan({
        text: name,
        cls: "easy-sync-vault-join-repo-name",
      });
      const copyIcon = row.createSpan({
        cls: "easy-sync-vault-join-repo-copy",
      });
      setIcon(copyIcon, "copy");
      row.addEventListener("click", () => {
        void this.copyName(name);
      });
    }
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.();
  }

  private async copyName(name: string): Promise<void> {
    try {
      const clipboard = navigator?.clipboard;
      if (!clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable");
      }
      await clipboard.writeText(name);
      this.noticeCenter.show({
        key: "vault-join-name-copied",
        message: this.views.copiedNotice,
        priority: NOTICE_PRIORITY.action,
      });
    } catch {
      this.noticeCenter.show({
        key: "vault-join-name-copy-unavailable",
        message: this.views.copyUnavailableNotice,
        priority: NOTICE_PRIORITY.failure,
      });
    }
  }
}
