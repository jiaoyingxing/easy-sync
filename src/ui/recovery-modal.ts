/**
 * 找回弹框（文件版本找回刀三之一）：文件菜单项／命令打开的找回入口第一版。
 *
 * 约束：
 * - 打开只读：列表与详情都只走读面（`RecoveryIndexV1`），不写本机、不写云端、
 *   不动同步状态；唯一的写动作是用户点「恢复为副本」或「从云端恢复」。
 * - 恢复永不覆盖任何现有文件：写盘全部交给 `restoreRecoveryEntryV1`。
 * - 行主体只做选中（纯展示态，不是按钮、不挂任何写动作）；写动作只在内容区
 *   头部（`.easy-sync-recovery-header-actions`），列表与详情正文都不带动作。
 * - 路径限定模式的路径只在头部出现一次；全局模式的路径只在列表行与详情顶部
 *   各出现一次。
 * - 单一滚动面：列表列与详情列各自滚动；列表重绘保持同一个容器并恢复 scrollTop。
 * - 文案一律走 i18n（`recovery.*`），本文件不出现硬编码的用户可见文案。
 */

import {
  Platform,
  SearchComponent,
  ToggleComponent,
  setIcon,
  type App,
} from "obsidian";
import type { I18n } from "../i18n";
import {
  RecoveryIndexV1,
  type RecoveryContentV1,
  type RecoveryEntryV1,
  type RecoveryIndexDepsV1,
  type RecoverySource,
  type RecoveryUnavailableReason,
} from "../sync/recovery-index";
import {
  restoreRecoveryEntryV1,
  type RecoveryCopyAdapterV1,
  type RecoveryRestoreCloudV1,
  type RecoveryRestoreUnavailableReasonV1,
} from "../sync/recovery-restore";
import { computeDisplayDiff } from "./diff-engine";
import {
  MAX_FALLBACK_PREVIEW_LINES,
  MAX_TEXT_DIFF_BYTES_PER_SIDE,
  decodeUtf8,
  renderDisplayDiff,
} from "./diff-view-renderer";
import { EasySyncModal } from "./easy-sync-modal";
import { formatFileSize } from "./file-comparison-modal";
import { NOTICE_PRIORITY, type EasySyncNoticeCenter } from "./notice-center";

/** 列表首屏条数：超出的部分由「显示更多」逐页放出（v1 不做窗口化）。 */
const RECOVERY_PAGE_SIZE = 50;

/** 弹框需要的文件面动作（读面 ＋ 写副本，与 `DataAdapter` 同形）。 */
export interface RecoveryModalAdapterV1 extends RecoveryCopyAdapterV1 {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ size: number; mtime?: number } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

interface RecoveryModalOptionsV1 {
  i18n: I18n;
  noticeCenter: EasySyncNoticeCenter;
  adapter: RecoveryModalAdapterV1;
  /** 插件目录：留档夹 `<pluginDir>/archive/<戳>/` 落在它下面。 */
  pluginDir: string;
  /** 插件运行时临时目录：恢复副本的暂存落点。 */
  tmpDir: string;
  state: RecoveryIndexDepsV1["state"];
  cloud: RecoveryIndexDepsV1["cloud"] & RecoveryRestoreCloudV1;
  /** 打开时预选的库内路径（文件菜单项进入）；缺省＝总列表（命令进入）。 */
  path?: string;
  /** 本机时钟：列表读取的可找回窗口判定用（测试可钉住）。落名时刻不取这里。 */
  now?: () => number;
  pageSize?: number;
}

/** 详情里与「当前文件」的对比可行性：不可比时只给说明，不伪造差异。 */
type RecoveryComparisonV1 =
  | { kind: "comparable"; currentText: string; currentMtime?: number }
  | { kind: "unavailable" }
  | { kind: "too-large" };

type RecoveryDetailStateV1 =
  | { key: string; status: "loading" }
  | RecoveryDetailReadyV1;

interface RecoveryDetailReadyV1 {
  key: string;
  status: "ready";
  content: RecoveryContentV1;
  comparison: RecoveryComparisonV1;
  /** 该版本内容里可当文本看的一面；null＝二进制。 */
  text: string | null;
  showDiff: boolean;
}

export class RecoveryModal extends EasySyncModal {
  private readonly index: RecoveryIndexV1;
  private readonly pageSize: number;
  private entries: RecoveryEntryV1[] = [];
  private listState: "loading" | "ready" | "error" = "loading";
  private filter = "";
  private shown: number;
  private selectedKey: string | null = null;
  private detail: RecoveryDetailStateV1 | null = null;
  private busy = false;
  private headerEl: HTMLElement | null = null;
  /** 头部常驻骨架：整头只建一次，状态更新全部就地改属性（不重建 DOM）。 */
  private headerBackEl: HTMLElement | null = null;
  private headerActionsEl: HTMLElement | null = null;
  private diffToggleWrapEl: HTMLElement | null = null;
  private diffToggleComponent: ToggleComponent | null = null;
  /** 当次弹框会话的「显示变更」偏好：换行阅览不重置，重开弹框才归零。 */
  private diffPreference = false;
  private copyButtonEl: HTMLButtonElement | null = null;
  private restoreButtonEl: HTMLButtonElement | null = null;
  private restoreButtonLabel: string | null = null;
  /** 宿主标题槽的文本子节点（官方形状：返回键＋文本分家，见 buildTitleSlot）。 */
  private titleTextEl: HTMLElement | null = null;
  private layoutEl: HTMLElement | null = null;
  private listScrollEl: HTMLElement | null = null;
  private detailPaneEl: HTMLElement | null = null;
  /** 桌面打开时自动选中首条；手机不选（避免自动跳详情）。 */
  private autoSelectPending = false;

  constructor(app: App, private readonly options: RecoveryModalOptionsV1) {
    super(app);
    // 宿主官方侧栏式弹框：宿主隐藏标题栏、手机全屏；自有类只做尺寸兜底。
    this.modalEl.addClass("mod-sidebar-layout", "easy-sync-recovery-shell");
    this.index = new RecoveryIndexV1({
      adapter: options.adapter,
      pluginDir: options.pluginDir,
      state: options.state,
      cloud: options.cloud,
    });
    this.pageSize = options.pageSize ?? RECOVERY_PAGE_SIZE;
    this.shown = this.pageSize;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("easy-sync-recovery-modal");
    this.autoSelectPending = !Platform.isMobile;

    // 手机端宿主把 modal-content 的直接子节点全部绝对叠放（`.is-phone …
    // .modal-content > *`，2026-10-20 真机两处错位的根因）：头部与双栏布局
    // 两个直接子节点会互相盖住（按钮摸不到、被压住的标题透底）。收进唯一的
    // 框架子节点，内部恢复正常文档流；桌面端该框架就是一个普通弹性满高容器。
    const frame = this.contentEl.createDiv("easy-sync-recovery-frame");

    // 内容区头部：开关与动作（宿主关闭 × 在右上角，右侧留白避开）；标题文字
    // 由 renderDetail 按"当前目标"写进宿主标题槽。
    this.headerEl = frame.createDiv("easy-sync-recovery-header");
    this.buildHeader();

    const layout = frame.createDiv("easy-sync-recovery-layout");
    this.layoutEl = layout;

    const listPane = layout.createDiv("easy-sync-recovery-list-pane");
    // 搜索框只属于全库模式：单文件进来的限定视图里，列表只会有这一个文件，
    // 搜索没有对象（死控件的文案再诚实也是多余的界面）。
    const search = this.options.path === undefined
      ? new SearchComponent(listPane.createDiv("easy-sync-recovery-search"))
        .setPlaceholder(this.t("recovery.searchPlaceholder"))
        .onChange((value) => {
          this.filter = value;
          this.shown = this.pageSize;
          this.renderList();
        })
      : null;
    if (search !== null) {
      search.inputEl.id = "easy-sync-recovery-search";
      search.inputEl.setAttribute(
        "aria-label",
        this.t("recovery.searchPlaceholder"),
      );
    }
    this.listScrollEl = listPane.createDiv("easy-sync-recovery-list-scroll");
    this.detailPaneEl = layout.createDiv("easy-sync-recovery-detail-pane");

    this.renderList();
    this.renderDetail();
    // 桌面打开即定位搜索框（仅全库模式有搜索框）；手机不聚焦，避免一打开就弹键盘。
    if (search !== null && !Platform.isMobile) {
      search.inputEl.focus({ preventScroll: true });
    }
    void this.loadEntries();
  }

  /** 重新拉一次列表（打开时一次；恢复动作落地后再来一次）。 */
  private async loadEntries(): Promise<void> {
    this.listState = "loading";
    this.renderList();
    try {
      this.entries = await this.index.listRecoveryEntries({
        scope: this.options.path === undefined
          ? "global"
          : { path: this.options.path },
        now: this.now(),
      });
      this.listState = "ready";
    } catch {
      this.entries = [];
      this.listState = "error";
    }
    let autoSelected: RecoveryEntryV1 | null = null;
    if (this.autoSelectPending) {
      this.autoSelectPending = false;
      autoSelected = this.listState === "ready"
        ? this.matchedEntries()[0] ?? null
        : null;
      if (autoSelected !== null) {
        this.selectedKey = recoveryEntryKeyV1(autoSelected);
        this.detail = null;
      }
    }
    if (
      this.selectedKey !== null
      && !this.entries.some(
        (entry) => recoveryEntryKeyV1(entry) === this.selectedKey,
      )
    ) {
      this.selectedKey = null;
      this.detail = null;
      autoSelected = null;
    }
    this.renderList();
    this.renderDetail();
    if (autoSelected !== null) void this.loadDetail(this.selectedKey!);
  }

  private renderList(): void {
    const list = this.listScrollEl;
    if (!list) return;
    // 选中只重绘列表：容器保持同一个 DOM，滚动位置原样还回去。
    const scrollTop = list.scrollTop;
    list.empty();
    try {
      if (this.listState === "loading") {
        this.renderMessage(list, this.t("recovery.loading"));
        return;
      }
      if (this.listState === "error") {
        this.renderMessage(list, this.t("recovery.loadFailed"));
        return;
      }
      if (this.entries.length === 0) {
        this.renderMessage(list, this.t("recovery.empty"));
        return;
      }
      const matched = this.matchedEntries();
      if (matched.length === 0) {
        this.renderMessage(list, this.t("recovery.noMatches"));
        return;
      }
      const page = matched.slice(0, this.shown);
      for (const entry of page) this.renderRow(list, entry);
      if (matched.length > page.length) {
        const more = list.createEl("button", {
          cls: "easy-sync-recovery-show-more",
          type: "button",
          text: this.t("recovery.showMore", {
            count: matched.length - page.length,
          }),
        });
        more.addEventListener("click", () => {
          this.shown += this.pageSize;
          this.renderList();
        });
      }
    } finally {
      list.scrollTop = scrollTop;
    }
  }

  private renderRow(list: HTMLElement, entry: RecoveryEntryV1): void {
    const key = recoveryEntryKeyV1(entry);
    const scoped = this.options.path !== undefined;
    const row = list.createDiv("easy-sync-recovery-row");
    if (key === this.selectedKey) row.addClass("is-selected");
    if (entry.availability === "unavailable") row.addClass("is-unavailable");

    // 路径限定模式＝时间优先（路径只在头部）；全局模式＝路径优先。
    const head = row.createDiv("easy-sync-recovery-row-head");
    if (scoped) {
      head.createSpan({
        cls: "easy-sync-recovery-time",
        text: new Date(entry.at).toLocaleString(),
      });
    } else {
      head.createSpan({ cls: "easy-sync-recovery-path", text: entry.path });
    }

    const meta = row.createDiv("easy-sync-recovery-row-meta");
    if (!scoped) {
      meta.createSpan({
        cls: "easy-sync-recovery-time",
        text: new Date(entry.at).toLocaleString(),
      });
    }
    if (typeof entry.size === "number") {
      meta.createSpan({
        cls: "easy-sync-recovery-size",
        text: formatFileSize(entry.size),
      });
    }
    meta.createSpan({
      cls: "easy-sync-tree-chip easy-sync-recovery-source",
      text: this.t(recoverySourceKeyV1(entry.source)),
    });
    if (entry.availability === "unavailable") {
      meta.createSpan({
        cls: "easy-sync-recovery-reason",
        text: this.t(recoveryReasonKeyV1(entry.reason ?? "content-unavailable")),
      });
    }
    // 行点击只切换选中（纯展示态）；写动作一律在内容区头部。
    row.addEventListener("click", () => {
      this.selectEntry(key);
    });
  }

  /**
   * 内容区头部骨架（只建一次）：桌面＝左路径/轻量标题、右＝差异开关＋复制＋
   * 恢复；手机＝标题与返回键都由宿主标题槽承担，头部只放动作排（不留空壳
   * 行）。这里不放任何状态判断——显隐/禁用/文案统一由 `updateHeader` 就地
   * 维护，切换页面不再整头重建。
   */
  private buildHeader(): void {
    const header = this.headerEl;
    if (!header) return;

    this.buildTitleSlot();
    if (!Platform.isMobile) {
      const main = header.createDiv("easy-sync-recovery-header-main");
      main.createSpan({
        cls: "easy-sync-recovery-header-title",
        text: this.options.path ?? this.t("recovery.recentTitle"),
      });
    }

    const actions = header.createDiv("easy-sync-recovery-header-actions");
    this.headerActionsEl = actions;

    const toggleWrap = actions.createDiv("easy-sync-recovery-diff-toggle");
    this.diffToggleWrapEl = toggleWrap;
    toggleWrap.createSpan({
      cls: "easy-sync-recovery-diff-label",
      text: this.t("recovery.showDiff"),
    });
    // 开关随骨架一次成型：切换条目只改值与显隐，不再重建控件本体。
    const toggle = new ToggleComponent(toggleWrap).setValue(false);
    toggle.onChange((value) => {
      // 开关是会话级偏好：先记下来，换条目后保持（用户 2026-10-20 定案）。
      this.diffPreference = value;
      const current = this.readyDetail();
      if (current === null || current.comparison.kind !== "comparable") {
        return;
      }
      this.detail = { ...current, showDiff: value };
      this.renderDetail();
    });
    this.diffToggleComponent = toggle;

    const copyButton = actions.createEl("button", {
      cls: "easy-sync-recovery-copy-button",
      type: "button",
    });
    copyButton.setText(this.t("recovery.copyContent"));
    copyButton.addEventListener("click", () => void this.copyCurrentContent());
    this.copyButtonEl = copyButton;

    const restoreButton = actions.createEl("button", {
      cls: "easy-sync-recovery-restore-button mod-cta",
      type: "button",
    });
    restoreButton.addEventListener("click", () => void this.restoreSelected());
    this.restoreButtonEl = restoreButton;
  }

  /** 手机端返回键（官方锚点）＋标题文本子节点：官方核心的标题槽形状正是
     "返回键 div＋独立文本 div"——直接写 titleEl 的 textContent 会整体抹掉
     返回键（真宿主实证），所以文本永远写自己的子节点。 */
  private buildTitleSlot(): void {
    const back = this.titleEl.createDiv(
      "clickable-icon modal-setting-back-button mod-raised is-hidden",
    );
    this.headerBackEl = back;
    setIcon(back, "arrow-left");
    back.addEventListener("click", () => {
      this.selectedKey = null;
      this.detail = null;
      this.renderList();
      this.renderDetail();
    });
    this.titleTextEl = this.titleEl.createDiv();
  }

  /** 就地更新常驻头部：显隐／禁用／文案／开关值，不重建任何 DOM。 */
  private updateHeader(): void {
    const entry = this.selectedEntry();
    if (this.headerBackEl !== null) {
      this.headerBackEl.toggleClass(
        "is-hidden",
        !Platform.isMobile || entry === null,
      );
    }
    const detail = this.readyDetail();
    // 动作整排常驻：选中且行内容可用＝整排保持（详情加载中＝按钮就位但禁用，
    // 切换不再整排消失重现）；无选中或行本身不可用才隐藏。
    const actionable = entry !== null && entry.availability !== "unavailable";
    this.headerActionsEl?.toggleClass("is-hidden", !actionable);
    if (!actionable) {
      this.diffToggleWrapEl?.toggleClass("is-hidden", true);
      this.copyButtonEl?.toggleClass("is-hidden", true);
      this.restoreButtonEl?.toggleClass("is-hidden", true);
      return;
    }

    // 开关：详情没落地＝保持可见并读会话偏好（点击会被守卫拦住）；
    // 落地后按可比性显隐、按偏好显示。
    const comparable = detail !== null && detail.comparison.kind === "comparable";
    this.diffToggleWrapEl?.toggleClass(
      "is-hidden",
      detail !== null && !comparable,
    );
    this.diffToggleComponent?.setValue(
      comparable ? detail.showDiff : this.diffPreference,
    );

    // 复制按钮与恢复同住一排：详情加载中＝可见但禁用，切换不再单独消失；
    // 确定没有可复制文本＝藏（删除记录永远没有本机文本，加载中就直接藏；
    // 二进制内容严格解不出文本＝同样整键退场，不往剪贴板放硬解的乱码）。
    const copyText = detail !== null ? detail.text : null;
    const copyPossible = detail !== null
      ? copyText !== null
      : entry?.handle !== undefined && entry.handle.kind !== "deleted-record";
    if (this.copyButtonEl !== null) {
      this.copyButtonEl.toggleClass("is-hidden", !copyPossible);
      this.copyButtonEl.disabled = this.busy || detail === null;
    }

    const restoreLabel = entry?.handle?.kind === "deleted-record"
      ? this.t("recovery.restoreFromCloud")
      : this.t("recovery.restoreAsCopy");
    const restoreButton = this.restoreButtonEl;
    if (restoreButton !== null) {
      if (this.restoreButtonLabel !== restoreLabel) {
        restoreButton.setText(restoreLabel);
        this.restoreButtonLabel = restoreLabel;
      }
      restoreButton.toggleClass("is-hidden", false);
      restoreButton.disabled = this.busy
        || detail === null
        || !recoveryActionsAllowedV1(detail);
    }
  }

  private renderDetail(): void {
    this.updateHeader();
    // 宿主标题槽（手机端显形）：标题随当前目标——路径限定＝该文件，全局＝
    // 最近可找回，条目选中＝该条目路径。桌面端宿主隐藏标题栏，写字无副作用。
    this.titleTextEl?.setText(
      this.options.path ?? (this.selectedEntry()?.path ?? this.t("recovery.recentTitle")),
    );
    const pane = this.detailPaneEl;
    if (!pane) return;
    pane.empty();
    const entry = this.selectedEntry();
    if (entry === null) {
      this.renderMessage(
        pane.createDiv("easy-sync-recovery-detail-scroll"),
        this.t("recovery.selectHint"),
      );
      this.syncMobilePane();
      return;
    }

    const scroll = pane.createDiv("easy-sync-recovery-detail-scroll");
    // 全局模式的路径只在详情顶部出现一次（时间/体积留在列表行）；
    // 路径限定模式的路径已经在头部，详情不再重复。
    if (this.options.path === undefined) {
      scroll.createDiv({
        cls: "easy-sync-recovery-detail-path",
        text: entry.path,
      });
    }
    // 来源介绍句（2026-10-20 定案）：每源一行"这是从哪拿回的"；删除记录的
    // 文件夹行只在唯一钥匙场景出现，分句说明整树退回。
    scroll.createDiv({
      cls: "easy-sync-recovery-note",
      text: this.t(
        entry.handle?.kind === "deleted-record"
          && entry.handle.entryKind === "folder"
          ? "recovery.sourceIntro.deletedRecordFolder"
          : recoverySourceIntroKeyV1(entry.source),
      ),
    });
    // 窗口诚实：云端版本的可拿回时限是微软口径，如实写一行小字。
    if (entry.source === "cloud-version") {
      scroll.createDiv({
        cls: "easy-sync-recovery-note",
        text: this.t("recovery.windowHint"),
      });
    }

    if (entry.availability === "unavailable") {
      this.renderMessage(
        scroll,
        this.t(recoveryReasonKeyV1(entry.reason ?? "content-unavailable")),
      );
      this.syncMobilePane();
      return;
    }

    const detail = this.detail;
    if (
      detail === null
      || detail.key !== this.selectedKey
      || detail.status === "loading"
    ) {
      this.renderMessage(scroll, this.t("recovery.loading"));
      this.syncMobilePane();
      return;
    }

    this.renderContent(scroll, entry, detail);
    this.syncMobilePane();
  }

  /** 详情正文：预览／差异／说明；动作不在正文里。 */
  private renderContent(
    scroll: HTMLElement,
    entry: RecoveryEntryV1,
    detail: RecoveryDetailReadyV1,
  ): void {
    if (detail.content.kind === "requiresCloudRestore") {
      // 回收站位置已在来源介绍句里说清楚（顶行），这里不再复读。
      return;
    }
    if (detail.content.kind === "unavailable") {
      this.renderMessage(scroll, this.t(recoveryReasonKeyV1(detail.content.reason)));
      return;
    }
    if (detail.text === null) {
      // 二进制：如实说不能预览。体积列表行已有，不再在正文里重复占场；
      // 复制按钮随"没有可复制文本"在 updateHeader 整体隐藏。
      this.renderMessage(scroll, this.t("recovery.binaryNotice"));
      return;
    }

    if (detail.comparison.kind === "comparable") {
      // 单一内容块：开关开着＝图例＋diff，关着＝整篇预览；两者不再同屏
      // （同屏时预览与 diff 是同一份内容的两次展示，重复无意义）。
      if (detail.showDiff) {
        this.renderDiffLegend(scroll, entry, detail.comparison);
        const diff = computeDisplayDiff(
          detail.comparison.currentText,
          detail.text,
        );
        // 零行＝两边内容一致（罕见残余：云端版本照列、本机可比对的已在列表
        // 摘除）；不再留一片图例下的空白，给一句兜底说明。
        if (diff.parts.length === 0) {
          this.renderMessage(scroll, this.t("recovery.diffIdentical"));
        } else {
          // 对侧＝库内当前文件（红），本侧＝这一版本（绿）。
          renderDisplayDiff(
            scroll.createDiv("easy-sync-recovery-diff"),
            diff,
          );
        }
        return;
      }
      this.renderPlainPreview(scroll, detail.text);
      return;
    }
    // 没有可比的当前文件：整篇预览（截断如实说明）＋对应说明。
    this.renderPlainPreview(scroll, detail.text);
    this.renderMessage(
      scroll,
      this.t(
        detail.comparison.kind === "too-large"
          ? "recovery.diffTooLarge"
          : "recovery.noComparableVersion",
      ),
    );
  }

  /** 整篇预览（有边界）：超过行数上限截断并如实说明。 */
  private renderPlainPreview(
    scroll: HTMLElement,
    text: string,
  ): void {
    const lines = text.split("\n");
    scroll
      .createDiv("easy-sync-content-preview")
      .createEl("pre")
      .createEl("code", {
        text: lines.slice(0, MAX_FALLBACK_PREVIEW_LINES).join("\n"),
      });
    if (lines.length > MAX_FALLBACK_PREVIEW_LINES) {
      this.renderMessage(scroll, this.t("recovery.previewTruncated"));
    }
  }

  /**
   * 差异图例（2026-10-20 再定＝永远只写时间戳）：红行＝库里现文件最后写入
   * 时刻，绿行＝所选版本生成时刻＋（历史）后缀。红时刻读不到＝红行整行退场，
   * 只留绿行——不拿措辞句顶替，也不放假时间。
   */
  private renderDiffLegend(
    scroll: HTMLElement,
    entry: RecoveryEntryV1,
    comparison: RecoveryComparisonV1 & { kind: "comparable" },
  ): void {
    const caption = scroll.createDiv("easy-sync-recovery-diff-caption");
    const currentMtime = comparison.currentMtime;
    if (currentMtime !== undefined) {
      this.renderLegendRow(
        caption,
        "easy-sync-diff-removed",
        new Date(currentMtime).toLocaleString(),
      );
    }
    this.renderLegendRow(
      caption,
      "easy-sync-diff-added",
      `${new Date(entry.at).toLocaleString()}${this.t("recovery.diffLegend.historySuffix")}`,
    );
  }

  private renderLegendRow(
    caption: HTMLElement,
    swatchClass: string,
    text: string,
  ): void {
    const row = caption.createDiv("easy-sync-recovery-diff-legend");
    row.createSpan(`easy-sync-recovery-legend-swatch ${swatchClass}`);
    // 文字样式继承图例容器（颜色／字号），无需单独类。
    row.createSpan({ text });
  }

  /** 单实例门：同一目标已开＝拒绝重复打开（不叠层）；换目标＝关旧开新。 */
  private static activeInstance: RecoveryModal | null = null;

  override open(): void {
    const active = RecoveryModal.activeInstance;
    if (active !== null && active !== this) {
      if (active.options.path === this.options.path) return;
      active.close();
    }
    RecoveryModal.activeInstance = this;
    super.open();
  }

  override close(): void {
    if (RecoveryModal.activeInstance === this) {
      RecoveryModal.activeInstance = null;
    }
    super.close();
  }

  override onClose(): void {
    if (RecoveryModal.activeInstance === this) {
      RecoveryModal.activeInstance = null;
    }
  }

  private enumerate: undefined;
  private readyDetail(): RecoveryDetailReadyV1 | null {
    const detail = this.detail;
    if (
      detail === null
      || detail.status !== "ready"
      || detail.key !== this.selectedKey
    ) {
      return null;
    }
    return detail;
  }

  /** 常驻「复制内容」按钮的派发：复制当前选中项的文本面。 */
  private async copyCurrentContent(): Promise<void> {
    if (this.busy) return;
    const detail = this.readyDetail();
    if (detail === null) return;
    if (detail.text === null) return;
    await this.copyContent(detail.text);
  }

  /** 常驻「恢复」按钮的派发：对当前选中项执行恢复。 */
  private async restoreSelected(): Promise<void> {
    const entry = this.selectedEntry();
    if (entry === null) return;
    await this.restore(entry);
  }

  private selectEntry(key: string): void {
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    this.renderList();
    void this.loadDetail(key);
  }

  private async loadDetail(key: string): Promise<void> {
    const entry = this.selectedEntry();
    if (entry === null) return;
    this.detail = { key, status: "loading" };
    this.renderDetail();

    let content: RecoveryContentV1;
    try {
      content = await this.index.readRecoveryContent(entry);
    } catch {
      content = { kind: "unavailable", reason: "content-unavailable" };
    }
    const text = recoveryTextV1(content);
    const comparison = await this.resolveComparison(entry.path, content, text);
    if (this.selectedKey !== key) return;
    this.detail = {
      key,
      status: "ready",
      content,
      comparison,
      text,
      showDiff: this.diffPreference,
    };
    this.renderDetail();
  }

  /**
   * 差异对侧＝库内当前文件（只读）。文件不在、任一侧不是 UTF-8 文本、或超出
   * 行级对比预算时不提供开关，只给对应说明。
   */
  private async resolveComparison(
    path: string,
    content: RecoveryContentV1,
    text: string | null,
  ): Promise<RecoveryComparisonV1> {
    if (text === null) return { kind: "unavailable" };
    if (recoveryContentBytesV1(content) > MAX_TEXT_DIFF_BYTES_PER_SIDE) {
      return { kind: "too-large" };
    }
    let bytes: ArrayBuffer | null = null;
    try {
      if (await this.options.adapter.exists(path)) {
        bytes = await this.options.adapter.readBinary(path);
      }
    } catch {
      return { kind: "unavailable" };
    }
    if (bytes === null) return { kind: "unavailable" };
    if (bytes.byteLength > MAX_TEXT_DIFF_BYTES_PER_SIDE) {
      return { kind: "too-large" };
    }
    const currentText = decodeUtf8(bytes);
    if (currentText === null) return { kind: "unavailable" };
    // 图例"现在"一侧用文件真实时刻：读得到就写时间戳；读不到红行整行退场
    // （不猜测、不放假时间），图例只剩绿行。
    let currentMtime: number | undefined;
    try {
      currentMtime = (await this.options.adapter.stat(path))?.mtime;
    } catch {
      currentMtime = undefined;
    }
    return {
      kind: "comparable",
      currentText,
      ...(currentMtime === undefined ? {} : { currentMtime }),
    };
  }

  private async restore(entry: RecoveryEntryV1): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.renderDetail();
    const result = await restoreRecoveryEntryV1({
      index: this.index,
      entry,
      adapter: this.options.adapter,
      cloud: this.options.cloud,
      tmpDir: this.options.tmpDir,
    });
    this.busy = false;
    if (result.kind === "copy") {
      this.notify(
        "recovery-copy-restored",
        this.t("recovery.restoreCopySuccess", { path: result.newPath }),
        NOTICE_PRIORITY.action,
      );
      this.selectedKey = null;
      this.detail = null;
    } else if (result.kind === "cloud-restored") {
      this.notify(
        "recovery-cloud-restored",
        this.t("recovery.restoreCloudSuccess"),
        NOTICE_PRIORITY.action,
      );
      this.selectedKey = null;
      this.detail = null;
    } else {
      this.notify(
        "recovery-restore-unavailable",
        this.t("recovery.restoreFailed", {
          reason: this.t(recoveryReasonKeyV1(result.reason)),
        }),
        NOTICE_PRIORITY.failure,
      );
    }
    await this.loadEntries();
  }

  private async copyContent(text: string): Promise<void> {
    try {
      const clipboard = navigator?.clipboard;
      if (!clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable");
      }
      await clipboard.writeText(text);
      this.notify(
        "recovery-content-copied",
        this.t("recovery.copySuccess"),
        NOTICE_PRIORITY.action,
      );
    } catch {
      this.notify(
        "recovery-copy-unavailable",
        this.t("recovery.copyUnavailable"),
        NOTICE_PRIORITY.failure,
      );
    }
  }

  /** 手机端单栏切换（列表／详情，不做滑动动画）；头部同步翻转详情态，
     让内容区标题让位给宿主标题槽。 */
  private syncMobilePane(): void {
    const layout = this.layoutEl;
    if (!layout) return;
    const detailOpen = Platform.isMobile && this.selectedEntry() !== null;
    layout.toggleClass("is-detail-open", detailOpen);
    this.headerEl?.toggleClass("is-detail-open", detailOpen);
  }

  private matchedEntries(): RecoveryEntryV1[] {
    const needle = this.filter.trim().toLowerCase();
    if (needle.length === 0) return this.entries;
    return this.entries.filter(
      (entry) => entry.path.toLowerCase().includes(needle),
    );
  }

  private selectedEntry(): RecoveryEntryV1 | null {
    if (this.selectedKey === null) return null;
    return this.entries.find(
      (entry) => recoveryEntryKeyV1(entry) === this.selectedKey,
    ) ?? null;
  }

  private renderMessage(container: HTMLElement, text: string): void {
    container.createDiv({
      cls: "easy-sync-recovery-message easy-sync-empty-state",
      text,
    });
  }

  private notify(key: string, message: string, priority: number): void {
    this.options.noticeCenter.show({ key, message, priority });
  }

  private t(key: string, params?: Record<string, string | number>): string {
    return this.options.i18n.t(key, params);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** 写动作只属于可读内容：不可读的条目一个动作都不给。 */
function recoveryActionsAllowedV1(detail: RecoveryDetailReadyV1): boolean {
  return detail.content.kind !== "unavailable";
}

/** 选中身份：跨重列稳定（来源＋路径＋时刻＋句柄身份）。 */
function recoveryEntryKeyV1(entry: RecoveryEntryV1): string {
  const handle = entry.handle;
  const identity = handle === undefined
    ? ""
    : handle.kind === "local-archive"
      ? handle.archivePath
      : handle.kind === "deleted-record"
        ? handle.remoteId
        : handle.kind === "cloud-version"
          ? handle.versionId
          : handle.hash;
  return `${entry.source}\u0000${entry.path}\u0000${entry.at}\u0000${identity}`;
}

function recoverySourceKeyV1(source: RecoverySource): string {
  switch (source) {
    case "local-archive":
      return "recovery.source.localArchive";
    case "deleted-record":
      return "recovery.source.deletedRecord";
    case "cloud-version":
      return "recovery.source.cloudVersion";
    case "sync-baseline":
      return "recovery.source.syncBaseline";
  }
}

/** 来源介绍句（详情页顶行）＝同一来源一人口径；文件夹行有专属分句。 */
function recoverySourceIntroKeyV1(source: RecoverySource): string {
  switch (source) {
    case "local-archive":
      return "recovery.sourceIntro.localArchive";
    case "deleted-record":
      return "recovery.sourceIntro.deletedRecord";
    case "cloud-version":
      return "recovery.sourceIntro.cloudVersion";
    case "sync-baseline":
      return "recovery.sourceIntro.syncBaseline";
  }
}

function recoveryReasonKeyV1(
  reason: RecoveryRestoreUnavailableReasonV1 | RecoveryUnavailableReason,
): string {
  switch (reason) {
    case "no-remote-identity":
      return "recovery.reason.noRemoteIdentity";
    case "no-version-history":
      return "recovery.reason.noVersionHistory";
    case "expired":
      return "recovery.reason.expired";
    case "write-failed":
      return "recovery.reason.writeFailed";
    case "content-unavailable":
      return "recovery.reason.contentUnavailable";
  }
}

/** 内容里可当文本看的一面；二进制返回 null（不假装能预览成文本）。 */
function recoveryTextV1(content: RecoveryContentV1): string | null {
  if (content.kind === "text") return content.text;
  if (content.kind === "bytes") return decodeUtf8(content.bytes);
  return null;
}

function recoveryContentBytesV1(content: RecoveryContentV1): number {
  return content.kind === "bytes" ? content.bytes.byteLength : 0;
}
