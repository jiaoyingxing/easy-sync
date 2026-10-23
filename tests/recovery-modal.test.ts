/**
 * 找回弹框（`src/ui/recovery-modal.ts`）第一版：列表／搜索／详情／动作／只读边界。
 *
 * 无 jsdom（仓内既有约定）：`instrument()` 包装弹框容器，让 createEl／createDiv／
 * createSpan 记录子元素、标签名、类名与点击处理器，再按类名在记录树里查找。
 * 全部用例跑在真 `RecoveryIndexV1` ＋ 真恢复动作上，只把盘面／云面／状态面换成替身。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform, SearchComponent, ToggleComponent } from "obsidian";
import { I18n } from "../src/i18n";
import { NOTICE_PRIORITY } from "../src/ui/notice-center";
import {
  RecoveryModal,
  type RecoveryModalAdapterV1,
} from "../src/ui/recovery-modal";
import { parseLocalArchiveStampV1 } from "../src/sync/local-archive";
import type { DeletionLedgerEntryV1 } from "../src/sync/deletion-ledger";
import type { DriveItemVersion } from "../src/onedrive/types";

const PLUGIN_DIR = ".obsidian/plugins/easy-sync";
const TMP_DIR = `${PLUGIN_DIR}/tmp`;
const STAMP_NAME = "2026-10-18 1430";
const STAMP_AT = parseLocalArchiveStampV1(STAMP_NAME)!;
const NOTE_PATH = "notes/note.md";
const ARCHIVE_PATH = `${PLUGIN_DIR}/archive/${STAMP_NAME}/${NOTE_PATH}`;
const NOW = new Date(2026, 9, 19, 20, 0).getTime();
const DELETED_AT = new Date(2026, 9, 19, 9, 0).getTime();
const EXPIRED_AT = new Date(2026, 8, 1, 9, 0).getTime();
const REMOTE_ID = "remote-note-id";

/* ---------------- mock DOM instrumentation ---------------- */

type MockEl = HTMLElement & {
  __tag?: string;
  __click?: (event?: unknown) => void;
  classList: { contains(token: string): boolean };
  children: MockEl[];
  textContent: string;
};

/** 记录子元素、标签名、类名与点击处理器（宿主元素工厂不带这些能力）。 */
function instrument(el: HTMLElement): void {
  const target = el as unknown as Record<string, unknown> & {
    children: MockEl[];
  };
  if (target.__instrumented) return;
  target.__instrumented = true;
  const record = (child: MockEl): MockEl => {
    instrument(child);
    if (!target.children.includes(child)) target.children.push(child);
    return child;
  };
  const applyFields = (
    child: MockEl,
    fields?: string | { cls?: string; text?: string },
  ): void => {
    const cls = typeof fields === "string" ? fields : fields?.cls;
    if (cls) {
      for (const token of cls.split(" ")) child.classList.add(token);
    }
    const text = typeof fields === "string" ? undefined : fields?.text;
    if (text !== undefined) child.setText(text);
  };
  const origCreateEl = el.createEl.bind(el);
  target.createEl = (
    tag: string,
    options?: { cls?: string; text?: string },
  ): MockEl => {
    const child = origCreateEl() as MockEl;
    child.__tag = tag;
    applyFields(child, options);
    ensureListeners(child);
    return record(child);
  };
  // 还原真实 DOM 行为：清空子元素会把滚动位置带回顶部。没有这层，
  // 列表即使忘了保存/恢复 scrollTop，测试也会假绿。
  const origEmpty = (el as unknown as { empty?: () => HTMLElement }).empty;
  if (typeof origEmpty === "function") {
    target.empty = (): HTMLElement => {
      const result = origEmpty.call(el);
      (target as unknown as { scrollTop?: number }).scrollTop = 0;
      return result;
    };
  }
  const origCreateDiv = el.createDiv.bind(el);
  target.createDiv = (
    fields?: string | { cls?: string; text?: string },
  ): MockEl => {
    const child = origCreateDiv() as MockEl;
    child.__tag = "div";
    applyFields(child, fields);
    ensureListeners(child);
    return record(child);
  };
  const origCreateSpan = el.createSpan.bind(el);
  target.createSpan = (
    fields?: string | { cls?: string; text?: string },
  ): MockEl => {
    const child = origCreateSpan(fields) as MockEl;
    child.__tag = "span";
    ensureListeners(child);
    return record(child);
  };
  target.appendChild = (child: unknown): unknown => record(child as MockEl);
}

function ensureListeners(child: MockEl): void {
  const el = child as unknown as Record<string, unknown>;
  if (typeof el.addEventListener !== "function") {
    el.addEventListener = (type: string, handler: () => void) => {
      if (type === "click") child.__click = handler;
    };
  }
  // 宿主元素工厂的 style 是空壳：补上 setProperty（差异渲染器要用）。
  const style = el.style as Record<string, unknown> | undefined;
  if (style && typeof style.setProperty !== "function") {
    style.setProperty = (name: string, value: string) => {
      style[name] = value;
    };
  }
}

function descendants(root: MockEl): MockEl[] {
  const out: MockEl[] = [];
  const visit = (el: MockEl): void => {
    for (const child of el.children ?? []) {
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function allByClass(root: MockEl, cls: string): MockEl[] {
  return descendants(root).filter((el) => el.classList.contains(cls));
}

function byClass(root: MockEl, cls: string): MockEl | undefined {
  return allByClass(root, cls)[0];
}

function textOf(root: MockEl): string {
  return [root, ...descendants(root)]
    .map((el) => el.textContent ?? "")
    .join("\n");
}

/** Elements whose own text is exactly `text` (mock textContent is not inherited). */
function exactTextElements(root: MockEl, text: string): MockEl[] {
  return [root, ...descendants(root)].filter((el) => el.textContent === text);
}

function buttonsIn(root: MockEl): MockEl[] {
  return descendants(root).filter((el) => el.__tag === "button");
}

/* ---------------- fakes ---------------- */

function utf8(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

interface FakeAdapter extends RecoveryModalAdapterV1 {
  files: Map<string, ArrayBuffer>;
  calls: {
    mkdir: string[];
    write: string[];
    rename: string[];
    remove: string[];
    list: string[];
  };
}

/** 内存盘：目录由文件全路径反推；写动作全部记账，用于"打开不写东西"的证据。
    `statMtime`＝stat 吐出的时刻；`null`＝不给时刻（验图例兜底形态），
    缺省＝NOW。显式 undefined 不可用——会触发默认参数。 */
function makeAdapter(
  seed: Record<string, string | ArrayBuffer>,
  statMtime: number | null = NOW,
): FakeAdapter {
  const files = new Map<string, ArrayBuffer>();
  const dirs = new Set<string>();
  const rememberDirs = (path: string): void => {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      dirs.add(segments.slice(0, index).join("/"));
    }
  };
  for (const [path, value] of Object.entries(seed)) {
    files.set(path, typeof value === "string" ? utf8(value) : value);
    rememberDirs(path);
  }
  const calls: FakeAdapter["calls"] = {
    mkdir: [],
    write: [],
    rename: [],
    remove: [],
    list: [],
  };
  const adapter: FakeAdapter = {
    files,
    calls,
    async exists(path) {
      return files.has(path) || dirs.has(path);
    },
    async list(path) {
      calls.list.push(path);
      const childFiles: string[] = [];
      const childFolders = new Set<string>();
      for (const file of files.keys()) {
        if (!file.startsWith(`${path}/`)) continue;
        const rest = file.slice(path.length + 1);
        const slash = rest.indexOf("/");
        if (slash < 0) childFiles.push(file);
        else childFolders.add(`${path}/${rest.slice(0, slash)}`);
      }
      if (childFiles.length === 0 && childFolders.size === 0 && !dirs.has(path)) {
        throw new Error(`not a directory: ${path}`);
      }
      return {
        files: childFiles.sort(),
        folders: [...childFolders].sort(),
      };
    },
    async stat(path) {
      const bytes = files.get(path);
      if (!bytes) return null;
      return statMtime === null
        ? { size: bytes.byteLength }
        : { size: bytes.byteLength, mtime: statMtime };
    },
    async readBinary(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`missing: ${path}`);
      return bytes;
    },
    async mkdir(path) {
      calls.mkdir.push(path);
      dirs.add(path);
    },
    async writeBinary(path, content) {
      calls.write.push(path);
      files.set(path, content);
      rememberDirs(path);
    },
    async rename(from, to) {
      calls.rename.push(to);
      const bytes = files.get(from);
      if (!bytes) throw new Error(`missing: ${from}`);
      files.delete(from);
      files.set(to, bytes);
      rememberDirs(to);
    },
    async remove(path) {
      calls.remove.push(path);
      files.delete(path);
    },
  };
  return adapter;
}

function makeState(input: {
  ledger?: DeletionLedgerEntryV1[];
  remoteIds?: Record<string, string>;
  remoteEtags?: Record<string, string>;
}) {
  // 记录簿读取次数：全局列表的"重列"靠它观察（总列表不扫云端）。
  const reads = { ledger: 0 };
  return {
    reads,
    remoteIdForPath: vi.fn((path: string) => input.remoteIds?.[path]),
    remoteETagForPath: vi.fn((path: string) => input.remoteEtags?.[path]),
    get deletionLedgerEntries() {
      reads.ledger += 1;
      return (input.ledger ?? []) as readonly DeletionLedgerEntryV1[];
    },
    getBaseContent: vi.fn(async () => undefined),
    baselineFactsForPath: vi.fn(() => undefined),
  };
}

function makeCloud(input: { versions?: DriveItemVersion[] }) {
  return {
    listDriveItemVersionsById: vi.fn(
      async (_driveItemId: string) => input.versions ?? [],
    ),
    downloadDriveItemVersionContent: vi.fn(async () => utf8("云端版本内容")),
    restoreDeletedDriveItemById: vi.fn(async () => undefined),
  };
}

/* ---------------- harness ---------------- */

interface Harness {
  modal: RecoveryModal;
  adapter: FakeAdapter;
  cloud: ReturnType<typeof makeCloud>;
  state: ReturnType<typeof makeState>;
  show: ReturnType<typeof vi.fn>;
  i18n: I18n;
  content: MockEl;
}

function openModal(input: {
  archives?: Record<string, string | ArrayBuffer>;
  vaultFiles?: Record<string, string | ArrayBuffer>;
  ledger?: DeletionLedgerEntryV1[];
  versions?: DriveItemVersion[];
  remoteIds?: Record<string, string>;
  remoteEtags?: Record<string, string>;
  path?: string;
  pageSize?: number;
  /** stat 不吐 mtime 的变体：只服务于"图例兜底形态"一条用例。 */
  statNoMtime?: boolean;
} = {}): Harness {
  const adapter = makeAdapter(
    {
      ...(input.archives ?? {}),
      ...(input.vaultFiles ?? {}),
    },
    input.statNoMtime ? null : NOW,
  );
  const cloud = makeCloud({ versions: input.versions ?? [] });
  const state = makeState({
    ledger: input.ledger ?? [],
    remoteIds: input.remoteIds,
    remoteEtags: input.remoteEtags,
  });
  const i18n: I18n = new I18n("zh-cn");
  const show = vi.fn();
  const modal = new RecoveryModal({} as never, {
    i18n,
    noticeCenter: { show } as never,
    adapter,
    pluginDir: PLUGIN_DIR,
    tmpDir: TMP_DIR,
    state: state as never,
    cloud: cloud as never,
    now: () => NOW,
    pageSize: input.pageSize ?? 50,
    ...(input.path === undefined ? {} : { path: input.path }),
  });
  instrument(modal.contentEl);
  instrument(modal.titleEl as unknown as HTMLElement);
  modal.onOpen();
  return {
    modal,
    adapter,
    cloud,
    state,
    show,
    i18n,
    content: modal.contentEl as MockEl,
    title: modal.titleEl as unknown as MockEl,
  };
}

function rowsOf(content: MockEl): MockEl[] {
  return allByClass(content, "easy-sync-recovery-row");
}

function clickByText(content: MockEl, text: string): void {
  const target = descendants(content).find((el) => el.textContent === text);
  if (!target) throw new Error(`clickable element not found: ${text}`);
  target.__click?.();
}

/** 等首屏列完：列表滚动区里出现行或空态文案。 */
/** 等首屏列完：列表滚动区出现内容且不再挂着加载文案。 */
async function waitForList(content: MockEl, i18n: I18n): Promise<void> {
  await vi.waitFor(() => {
    const list = byClass(content, "easy-sync-recovery-list-scroll");
    expect(list).toBeDefined();
    expect(descendants(list!).length).toBeGreaterThan(0);
    expect(textOf(list!)).not.toContain(i18n.t("recovery.loading"));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Platform.isMobile = false;
  ToggleComponent.instances.length = 0;
  SearchComponent.instances.length = 0;
});

describe("RecoveryModal list", () => {
  it("renders one row per recoverable item with source chip, path, time and size", async () => {
    const { content, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
      ledger: [
        { remoteId: REMOTE_ID, path: NOTE_PATH, deletedAt: DELETED_AT, kind: "file" },
      ],
    });
    await waitForList(content, i18n);

    const rows = rowsOf(content);
    expect(rows).toHaveLength(2);
    // 最新事件在前（删除记录 09:00 晚于留档戳 14:30 的前一天）。
    expect(
      byClass(rows[0], "easy-sync-recovery-path")?.textContent,
    ).toBe(NOTE_PATH);
    expect(
      byClass(rows[0], "easy-sync-recovery-source")?.textContent,
    ).toBe(i18n.t("recovery.source.deletedRecord"));
    expect(
      byClass(rows[1], "easy-sync-recovery-source")?.textContent,
    ).toBe(i18n.t("recovery.source.localArchive"));
    expect(byClass(rows[1], "easy-sync-recovery-time")?.textContent)
      .toBe(new Date(STAMP_AT).toLocaleString());
    expect(byClass(rows[1], "easy-sync-recovery-size")?.textContent).toBe("12 B");
    // 行主体不是按钮：动作用户看得见的只有详情页脚。
    expect(rows[0].__tag).toBe("div");
    expect(allByClass(rows[0], "easy-sync-detail-actions")).toHaveLength(0);
  });

  it("marks an unusable row with its reason instead of hiding it", async () => {
    const { content, i18n } = openModal({
      ledger: [
        { remoteId: "old-id", path: "old.md", deletedAt: EXPIRED_AT, kind: "file" },
      ],
    });
    await waitForList(content, i18n);

    const rows = rowsOf(content);
    expect(rows).toHaveLength(1);
    expect(rows[0].classList.contains("is-unavailable")).toBe(true);
    expect(byClass(rows[0], "easy-sync-recovery-reason")?.textContent)
      .toBe(i18n.t("recovery.reason.expired"));
  });

  it("shows the empty state when nothing is recoverable", async () => {
    const { content, i18n } = openModal({});
    await waitForList(content, i18n);

    expect(rowsOf(content)).toHaveLength(0);
    expect(textOf(content)).toContain(i18n.t("recovery.empty"));
  });

  it("filters the list by the search box", async () => {
    const { content, i18n } = openModal({
      archives: {
        [`${PLUGIN_DIR}/archive/${STAMP_NAME}/notes/note.md`]: "笔记",
        [`${PLUGIN_DIR}/archive/${STAMP_NAME}/drafts/plan.md`]: "草稿",
      },
    });
    await waitForList(content, i18n);
    expect(rowsOf(content)).toHaveLength(2);

    const search = SearchComponent.instances.at(-1);
    expect(search).toBeDefined();
    await search!.triggerChange("plan");

    const rows = rowsOf(content);
    expect(rows).toHaveLength(1);
    expect(byClass(rows[0], "easy-sync-recovery-path")?.textContent)
      .toBe("drafts/plan.md");
  });

  it("caps the first screen and reveals the rest through 显示更多", async () => {
    const { content, i18n } = openModal({
      archives: {
        [`${PLUGIN_DIR}/archive/${STAMP_NAME}/a.md`]: "a",
        [`${PLUGIN_DIR}/archive/${STAMP_NAME}/b.md`]: "b",
        [`${PLUGIN_DIR}/archive/${STAMP_NAME}/c.md`]: "c",
      },
      pageSize: 2,
    });
    await waitForList(content, i18n);
    expect(rowsOf(content)).toHaveLength(2);

    const more = byClass(content, "easy-sync-recovery-show-more");
    expect(more?.textContent).toBe(i18n.t("recovery.showMore", { count: 1 }));
    more?.__click?.();
    expect(rowsOf(content)).toHaveLength(3);
  });
});

describe("RecoveryModal detail", () => {
  it("shows the selected version's text and offers the copy action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { content, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容第一行" },
    });
    await waitForList(content, i18n);

    // 桌面打开即自动选中首条并加载详情（无需再点行）。
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain("留档内容第一行");
    });
    // 内容只出现在预览里，动作只在内容区头部。
    expect(allByClass(content, "easy-sync-detail-actions")).toHaveLength(0);
    expect(byClass(content, "easy-sync-content-preview")).toBeDefined();
    clickByText(content, i18n.t("recovery.copyContent"));
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("留档内容第一行");
    });
  });

  it("keeps the reason and offers no action for an unusable entry", async () => {
    const { content, i18n } = openModal({
      ledger: [
        { remoteId: "old-id", path: "old.md", deletedAt: EXPIRED_AT, kind: "file" },
      ],
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain(i18n.t("recovery.reason.expired"));
    });
    expect(allByClass(content, "easy-sync-detail-actions")).toHaveLength(0);
    // 动作槽位是常驻骨架：按钮存在但全部隐藏（不可用条目不给任何可见动作）。
    const disabledButtons = buttonsIn(
      byClass(content, "easy-sync-recovery-header-actions")!,
    );
    expect(disabledButtons).toHaveLength(2);
    expect(disabledButtons.filter(
      (button) => !button.classList.contains("is-hidden"),
    )).toHaveLength(0);
  });

  it("restores a deleted record from the cloud recycle bin and re-lists", async () => {
    const { content, cloud, state, show, i18n } = openModal({
      ledger: [
        { remoteId: REMOTE_ID, path: NOTE_PATH, deletedAt: DELETED_AT, kind: "file" },
      ],
    });
    await waitForList(content, i18n);
    const ledgerReadsBefore = state.reads.ledger;
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain(i18n.t("recovery.sourceIntro.deletedRecord"));
    });

    clickByText(content, i18n.t("recovery.restoreFromCloud"));
    await vi.waitFor(() => {
      expect(cloud.restoreDeletedDriveItemById).toHaveBeenCalledTimes(1);
    });
    expect(cloud.restoreDeletedDriveItemById).toHaveBeenCalledWith(REMOTE_ID);
    await vi.waitFor(() => {
      expect(show).toHaveBeenCalledWith(expect.objectContaining({
        priority: NOTICE_PRIORITY.action,
      }));
    });
    await vi.waitFor(() => {
      expect(state.reads.ledger).toBeGreaterThan(ledgerReadsBefore);
    });
  });

  it("restores an archived version as a copy at the original path and re-lists", async () => {
    const { content, adapter, show, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);
    const listCallsBefore = adapter.calls.list.length;
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain("留档内容");
    });

    clickByText(content, i18n.t("recovery.restoreAsCopy"));
    await vi.waitFor(() => {
      expect(adapter.calls.rename).toEqual([NOTE_PATH]);
    });
    expect(adapter.files.get(NOTE_PATH)).toBeDefined();
    await vi.waitFor(() => {
      expect(show).toHaveBeenCalledWith(expect.objectContaining({
        priority: NOTICE_PRIORITY.action,
      }));
    });
    await vi.waitFor(() => {
      expect(adapter.calls.list.length).toBeGreaterThan(listCallsBefore);
    });
  });

  it("never overwrites an existing file when the original name is taken", async () => {
    const { content, adapter, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
      vaultFiles: { [NOTE_PATH]: "现在的内容" },
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-content-preview")).toBeDefined();
    });

    clickByText(content, i18n.t("recovery.restoreAsCopy"));
    await vi.waitFor(() => {
      expect(adapter.calls.rename).toHaveLength(1);
    });
    expect(adapter.calls.rename[0]).not.toBe(NOTE_PATH);
    expect(new TextDecoder().decode(adapter.files.get(NOTE_PATH))).toBe("现在的内容");
  });

  it("renders the bounded diff against the current file only when the toggle is on", async () => {
    const { content, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "旧版本内容\n第二行" },
      vaultFiles: { [NOTE_PATH]: "当前内容\n第二行" },
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      // 开关是常驻控件：可比较详情落地后行为可见（不可用条目不会显形）。
      expect(byClass(content, "easy-sync-recovery-diff-toggle")?.classList
        .contains("is-hidden")).toBe(false);
    });
    expect(byClass(content, "easy-sync-diff-view")).toBeUndefined();

    await ToggleComponent.instances.at(-1)!.triggerChange(true);
    const diff = byClass(content, "easy-sync-diff-view");
    expect(diff).toBeDefined();
    expect(textOf(diff!)).toContain("旧版本内容");
    expect(textOf(diff!)).toContain("当前内容");
    // 预览与 diff 融合：开关开着只给 diff（图例＋行色标），不再同屏展示整篇预览。
    expect(byClass(content, "easy-sync-content-preview")).toBeUndefined();
    // 图例按定案＝只写真时间戳：红＝现文件最后写入（假 mtime＝NOW）、
    // 绿＝所选版本时刻＋（历史）后缀；措辞句不再出现。
    expect(textOf(content)).toContain(new Date(NOW).toLocaleString());
    expect(textOf(content))
      .toContain(`${new Date(STAMP_AT).toLocaleString()}（历史）`);
    expect(textOf(content)).not.toContain("只在当前文件里");
    expect(textOf(content)).not.toContain("左＝");
  });

  it("keeps the diff legend pure timestamps when the current file has no mtime", async () => {
    const { content, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "旧版本内容\n第二行" },
      vaultFiles: { [NOTE_PATH]: "当前内容\n第二行" },
      statNoMtime: true,
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-recovery-diff-toggle")?.classList
        .contains("is-hidden")).toBe(false);
    });

    await ToggleComponent.instances.at(-1)!.triggerChange(true);
    // 兜底形态（2026-10-20 再定＝图例永远时间戳）：现文件的最后写入时刻读不到
    // ＝红行整行退场，绿行照常（版本时刻＋（历史））；措辞句已退役，不许回魂。
    const legend = allByClass(content, "easy-sync-recovery-diff-legend");
    expect(legend).toHaveLength(1);
    expect(textOf(legend[0]).trim())
      .toBe(`${new Date(STAMP_AT).toLocaleString()}（历史）`);
  });

  it("keeps the diff toggle on when switching entries in the same session", async () => {
    const stampB = "2026-10-18 1530";
    const { content, i18n } = openModal({
      path: NOTE_PATH,
      archives: {
        [ARCHIVE_PATH]: "甲版本\n第一段",
        [`${PLUGIN_DIR}/archive/${stampB}/${NOTE_PATH}`]: "乙版本\n第一段",
      },
      vaultFiles: { [NOTE_PATH]: "当前内容\n第一段" },
    });
    await waitForList(content, i18n);
    // 只挑可用的留档行（限定视图里排最前的还有"云端没有这个文件"说明行）。
    const archiveRows = rowsOf(content).filter((row) =>
      textOf(row).includes(i18n.t("recovery.source.localArchive")));
    expect(archiveRows.length).toBe(2);
    archiveRows[0].__click?.();
    // 等第一条详情就绪（默认不开 diff＝先有整篇预览）。
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain("乙版本");
    });
    await ToggleComponent.instances.at(-1)!.triggerChange(true);
    const diff = byClass(content, "easy-sync-diff-view");
    expect(diff).toBeDefined();
    expect(textOf(diff!)).toContain("乙版本");
    // 会话级偏好：换条目后不用再碰开关——新条目落地即直接给 diff。
    archiveRows[1].__click?.();
    await vi.waitFor(() => {
      const next = byClass(content, "easy-sync-diff-view");
      expect(next).toBeDefined();
      expect(textOf(next!)).toContain("甲版本");
    });
    expect(ToggleComponent.instances.at(-1)!.value).toBe(true);
    expect(byClass(content, "easy-sync-recovery-diff-toggle")?.classList
      .contains("is-hidden")).toBe(false);
  });

  it("keeps the header skeleton while switching between entries", async () => {
    const stampB = "2026-10-18 1530";
    const { content, i18n } = openModal({
      path: NOTE_PATH,
      archives: {
        [ARCHIVE_PATH]: "留档版本甲\n常驻行",
        [`${PLUGIN_DIR}/archive/${stampB}/${NOTE_PATH}`]: "留档版本乙\n常驻行",
      },
      vaultFiles: { [NOTE_PATH]: "当前内容\n常驻行" },
    });
    await waitForList(content, i18n);
    const rows = rowsOf(content).filter((row) =>
      textOf(row).includes(i18n.t("recovery.source.localArchive"))
    );
    expect(rows.length).toBe(2);

    rows[0].__click?.();
    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-recovery-diff-toggle")).toBeDefined();
    });
    const actionsBefore = byClass(content, "easy-sync-recovery-header-actions");
    const copyBefore = byClass(content, "easy-sync-recovery-copy-button");
    const restoreBefore = byClass(content, "easy-sync-recovery-restore-button");

    rows[1].__click?.();
    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-recovery-diff-toggle")).toBeDefined();
    });
    // 头部永不重建：切换条目后动作区仍是同一个常驻 DOM（按钮跟着页面刷新＝重建）。
    expect(byClass(content, "easy-sync-recovery-header-actions")).toBe(actionsBefore);
    expect(byClass(content, "easy-sync-recovery-copy-button")).toBe(copyBefore);
    expect(byClass(content, "easy-sync-recovery-restore-button")).toBe(restoreBefore);
    // 切换不再整排闪没：动作区在切换后保持可见（加载中也只是禁用）。
    expect(byClass(content, "easy-sync-recovery-header-actions")?.classList
      .contains("is-hidden")).toBe(false);
  });

  it("explains when there is no current version to compare with", async () => {
    const { content, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain("留档内容");
    });

    // 开关是常驻控件：不可比详情不提供开关＝槽位隐藏（控件本体仍在骨架里）。
    expect(byClass(content, "easy-sync-recovery-diff-toggle")?.classList
      .contains("is-hidden")).toBe(true);
    // 来源介绍句（2026-10-20 定案）：每个条目顶行一句"这是从哪拿回的"。
    expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
      .toContain(i18n.t("recovery.sourceIntro.localArchive"));
    expect(textOf(content)).toContain(i18n.t("recovery.noComparableVersion"));
  });

  it("reduces a binary version to a plain notice without copy or size echo", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { content, i18n } = openModal({
      archives: {
        [ARCHIVE_PATH]: new Uint8Array([0xff, 0xfe, 0x00, 0x41]).buffer as ArrayBuffer,
      },
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain(i18n.t("recovery.binaryNotice"));
    });

    // 二进制＝一条如实说明，其余不占场（2026-10-20 用户判退）：无预览、
    // 正文无大字体积（列表行已有）、复制键随"没有可复制文本"退场——宽松
    // 解码放进剪贴板的是乱码，与"无法预览"自相矛盾。
    const pane = byClass(content, "easy-sync-recovery-detail-pane")!;
    expect(byClass(pane, "easy-sync-content-preview")).toBeUndefined();
    expect(textOf(pane)).not.toContain("4 B");
    expect(byClass(content, "easy-sync-recovery-copy-button")?.classList
      .contains("is-hidden")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports a failed copy instead of touching the clipboard silently", async () => {
    const { content, show, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-content-preview")).toBeDefined();
    });

    vi.stubGlobal("navigator", {});
    clickByText(content, i18n.t("recovery.copyContent"));
    await vi.waitFor(() => {
      expect(show).toHaveBeenCalledWith(expect.objectContaining({
        priority: NOTICE_PRIORITY.failure,
      }));
    });
  });

  it("keeps the copy button in place (visible, disabled) while the detail loads", async () => {
    const { content, i18n, adapter } = openModal({
      archives: { [ARCHIVE_PATH]: "预览内容" },
    });
    // 拦截从第二次 reads 开始：列表期的一致过滤走过一次留档阅读，详情期的那
    // 一次才挂起（桌面打开即自动选中，加载在 waitForList 之前就已经上路）。
    let release!: () => void;
    const gate = new Promise<ArrayBuffer>((resolve) => {
      release = () => resolve(utf8("预览内容"));
    });
    const original = adapter.readBinary.bind(adapter);
    let archiveDetailReads = 0;
    adapter.readBinary = vi.fn(async (path: string) => {
      if (path === ARCHIVE_PATH) {
        archiveDetailReads += 1;
        if (archiveDetailReads >= 2) return await gate;
      }
      return await original(path);
    });
    await waitForList(content, i18n);
    const copy = byClass(content, "easy-sync-recovery-copy-button");
    const restore = byClass(content, "easy-sync-recovery-restore-button");
    // 加载中：复制不消失，与恢复一样只禁用。
    expect(copy?.classList.contains("is-hidden")).toBe(false);
    expect(copy?.disabled).toBe(true);
    expect(restore?.disabled).toBe(true);
    release();
    await vi.waitFor(() => {
      expect(copy?.disabled).toBe(false);
    });
  });

  it("never reveals the copy button for a deletion record", async () => {
    const { content, i18n } = openModal({
      ledger: [{
        remoteId: REMOTE_ID,
        path: NOTE_PATH,
        deletedAt: DELETED_AT,
        kind: "file",
      }],
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain(i18n.t("recovery.sourceIntro.deletedRecord"));
    });
    // 删除记录永远没有本机文本：含加载中一眼，复制都不该闪出来。
    expect(byClass(content, "easy-sync-recovery-copy-button")?.classList
      .contains("is-hidden")).toBe(true);
  });

  it("explains an identical pair instead of leaving an empty diff", async () => {
    const { content, i18n } = openModal({
      path: NOTE_PATH,
      vaultFiles: { [NOTE_PATH]: "云端版本内容" },
      versions: [{
        id: "1.0",
        size: 18,
        lastModifiedDateTime: new Date(NOW - 60_000).toISOString(),
        "@microsoft.graph.downloadUrl": "https://cdn/1.0",
      }],
      remoteIds: { [NOTE_PATH]: REMOTE_ID },
      remoteEtags: { [NOTE_PATH]: `"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},2"` },
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-recovery-diff-toggle")?.classList
        .contains("is-hidden")).toBe(false);
    });
    await ToggleComponent.instances.at(-1)!.triggerChange(true);
    // 零差异＝给一句兜底说明，不给一片空白。
    expect(byClass(content, "easy-sync-diff-view")).toBeUndefined();
    expect(textOf(content)).toContain("两边内容一致，没有差异");
  });
});

describe("RecoveryModal read-only opening", () => {
  it("loads the global list without a single write call", async () => {
    const { content, adapter, cloud, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
      ledger: [
        { remoteId: REMOTE_ID, path: NOTE_PATH, deletedAt: DELETED_AT, kind: "file" },
      ],
    });
    await waitForList(content, i18n);

    expect(adapter.calls.mkdir).toEqual([]);
    expect(adapter.calls.write).toEqual([]);
    expect(adapter.calls.rename).toEqual([]);
    expect(adapter.calls.remove).toEqual([]);
    expect(cloud.restoreDeletedDriveItemById).not.toHaveBeenCalled();
    // 总列表不扫云端（定案）。
    expect(cloud.listDriveItemVersionsById).not.toHaveBeenCalled();
  });

  it("reads one path's cloud versions without writing when opened preselected", async () => {
    const { content, adapter, cloud, i18n } = openModal({
      path: NOTE_PATH,
      remoteIds: { [NOTE_PATH]: REMOTE_ID },
      remoteEtags: { [NOTE_PATH]: `"{0B72376E-BD3F-4056-8290-B8ABC68F0B66},2"` },
      versions: [
        {
          id: "1.0",
          size: 1024,
          lastModifiedDateTime: new Date(2026, 9, 18, 10, 0).toISOString(),
        },
      ],
    });
    await vi.waitFor(() => {
      expect(cloud.listDriveItemVersionsById).toHaveBeenCalledWith(REMOTE_ID);
    });
    await vi.waitFor(() => {
      expect(rowsOf(content).length).toBeGreaterThan(0);
    });

    expect(adapter.calls.write).toEqual([]);
    expect(adapter.calls.rename).toEqual([]);
    expect(adapter.calls.remove).toEqual([]);
    expect(cloud.restoreDeletedDriveItemById).not.toHaveBeenCalled();

    // 窗口诚实：云端版本详情如实说时限口径（内容读取本身也仍然是只读）。
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(textOf(byClass(content, "easy-sync-recovery-detail-pane")!))
        .toContain(i18n.t("recovery.windowHint"));
    });
    expect(adapter.calls.write).toEqual([]);
    expect(adapter.calls.rename).toEqual([]);
    expect(adapter.calls.remove).toEqual([]);
  });
});

describe("RecoveryModal instance dedup", () => {
  function makeBareModal(path?: string): RecoveryModal {
    return new RecoveryModal({} as never, {
      i18n: new I18n("zh-cn"),
      noticeCenter: { show: vi.fn() } as never,
      adapter: makeAdapter({}),
      pluginDir: PLUGIN_DIR,
      tmpDir: TMP_DIR,
      state: makeState() as never,
      cloud: makeCloud() as never,
      now: () => NOW,
      ...(path === undefined ? {} : { path }),
    });
  }

  it("refuses a duplicate open of the same target instead of stacking", () => {
    const first = makeBareModal(NOTE_PATH);
    const closeSpy = vi.spyOn(first, "close");
    first.open();
    first.open();
    // 同目标＝拒绝重复打开：既有实例保持唯一，不叠第二层。
    expect(closeSpy).not.toHaveBeenCalled();

    // 换目标＝关旧开新。
    const global = makeBareModal();
    global.open();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    global.close();
    first.close();
  });
});

describe("RecoveryModal mobile switch", () => {
  it("switches to the detail with a back control and returns to the list", async () => {
    Platform.isMobile = true;
    const { content, title, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);
    const layout = byClass(content, "easy-sync-recovery-layout")!;
    expect(layout.classList.contains("is-detail-open")).toBe(false);
    // 返回键＝官方锚点挂在宿主标题槽：列表态隐藏，详情态显形（骨架不重建）。
    const back = byClass(title, "modal-setting-back-button")!;
    expect(back).toBeDefined();
    expect(back.classList.contains("is-hidden")).toBe(true);

    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(back.classList.contains("is-hidden")).toBe(false);
    });
    expect(layout.classList.contains("is-detail-open")).toBe(true);
    // 标题随当前目标写入宿主槽的文本子节点：详情态＝该条目路径
    // （mock 的 textContent 不聚合子节点，按子孙文本找）。
    expect(exactTextElements(title, NOTE_PATH).length).toBeGreaterThan(0);

    back.__click?.();
    expect(byClass(content, "easy-sync-recovery-layout")!.classList
      .contains("is-detail-open")).toBe(false);
    expect(exactTextElements(title, i18n.t("recovery.recentTitle")).length)
      .toBeGreaterThan(0);
  });

  it("keeps the desktop two-pane layout without the back control visible", async () => {
    const { content, title, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);
    rowsOf(content)[0].__click?.();
    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-content-preview")).toBeDefined();
    });

    expect(byClass(content, "easy-sync-recovery-layout")!.classList
      .contains("is-detail-open")).toBe(false);
    // 桌面端：宿主隐藏标题栏，返回锚点常驻骨架但保持隐藏。
    expect(byClass(title, "modal-setting-back-button")?.classList
      .contains("is-hidden")).toBe(true);
    expect(rowsOf(content)).toHaveLength(1);
  });
});

describe("RecoveryModal official shell", () => {
  it("uses the host sidebar shell class next to its own fallback class", () => {
    const { modal } = openModal({});
    expect(modal.modalEl.classList.contains("mod-sidebar-layout")).toBe(true);
    expect(modal.modalEl.classList.contains("easy-sync-recovery-shell")).toBe(true);
  });

  it("shows the path once in the header and never in scoped rows", async () => {
    const { content, i18n } = openModal({
      path: NOTE_PATH,
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);

    expect(byClass(content, "easy-sync-recovery-header-title")?.textContent)
      .toBe(NOTE_PATH);
    expect(exactTextElements(content, NOTE_PATH)).toHaveLength(1);
    expect(allByClass(content, "easy-sync-recovery-path")).toHaveLength(0);
    expect(rowsOf(content).length).toBeGreaterThan(0);
    // 时间优先：第一行是时间，来源与原因在第二行。
    const head = byClass(rowsOf(content)[0], "easy-sync-recovery-row-head")!;
    expect(byClass(head, "easy-sync-recovery-time")).toBeDefined();
    expect(byClass(rowsOf(content)[0], "easy-sync-recovery-source")).toBeDefined();
  });

  it("keeps the path in global rows and shows it once in the detail", async () => {
    const { content, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);

    const row = rowsOf(content)[0];
    expect(byClass(row, "easy-sync-recovery-path")?.textContent).toBe(NOTE_PATH);
    const head = byClass(row, "easy-sync-recovery-row-head")!;
    expect(byClass(head, "easy-sync-recovery-path")).toBeDefined();
    expect(byClass(row, "easy-sync-recovery-time")).toBeDefined();
    expect(byClass(row, "easy-sync-recovery-source")).toBeDefined();
    expect(byClass(content, "easy-sync-recovery-header-title")?.textContent)
      .toBe(i18n.t("recovery.recentTitle"));

    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-recovery-detail-path")).toBeDefined();
    });
    expect(allByClass(content, "easy-sync-recovery-detail-path")).toHaveLength(1);
    expect(byClass(content, "easy-sync-recovery-detail-path")?.textContent)
      .toBe(NOTE_PATH);
  });

  it("puts copy left, the primary restore right and nothing in a footer", async () => {
    const { content, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "旧版本内容\n第二行" },
      vaultFiles: { [NOTE_PATH]: "当前内容\n第二行" },
    });
    await waitForList(content, i18n);
    await vi.waitFor(() => {
      expect(byClass(content, "easy-sync-recovery-diff-toggle")).toBeDefined();
    });

    const header = byClass(content, "easy-sync-recovery-header")!;
    const actions = byClass(header, "easy-sync-recovery-header-actions")!;
    expect(byClass(actions, "easy-sync-recovery-diff-toggle")).toBeDefined();
    const buttons = buttonsIn(actions);
    expect(buttons.map((button) => button.textContent)).toEqual([
      i18n.t("recovery.copyContent"),
      i18n.t("recovery.restoreAsCopy"),
    ]);
    expect(buttons[0].classList.contains("mod-cta")).toBe(false);
    expect(buttons[1].classList.contains("mod-cta")).toBe(true);
    expect(buttonsIn(content)).toHaveLength(2);
    expect(allByClass(content, "easy-sync-detail-actions")).toHaveLength(0);
  });

  it("auto-selects and loads the first item on desktop without writing", async () => {
    const { content, adapter, cloud, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);
    await vi.waitFor(() => {
      expect(rowsOf(content)[0].classList.contains("is-selected")).toBe(true);
      expect(byClass(content, "easy-sync-content-preview")).toBeDefined();
    });

    expect(adapter.calls.mkdir).toEqual([]);
    expect(adapter.calls.write).toEqual([]);
    expect(adapter.calls.rename).toEqual([]);
    expect(adapter.calls.remove).toEqual([]);
    expect(cloud.restoreDeletedDriveItemById).not.toHaveBeenCalled();
  });

  it("keeps the list scroll position when a selection redraws the list", async () => {
    const archives: Record<string, string> = {};
    for (let index = 0; index < 30; index++) {
      archives[`${PLUGIN_DIR}/archive/${STAMP_NAME}/n${index}.md`] = `内容 ${index}`;
    }
    const { content, i18n } = openModal({ archives, pageSize: 100 });
    await waitForList(content, i18n);
    expect(rowsOf(content)).toHaveLength(30);

    const list = byClass(content, "easy-sync-recovery-list-scroll")!;
    list.scrollTop = 420;
    rowsOf(content)[3].__click?.();

    // 同一个列表容器，位置不被重绘带回顶部。
    expect(byClass(content, "easy-sync-recovery-list-scroll")).toBe(list);
    expect(list.scrollTop).toBe(420);
  });

  it("focuses the search box when desktop opens", async () => {
    const { content, i18n } = openModal({});
    const search = SearchComponent.instances.at(-1);
    expect(search?.inputEl.focus).toHaveBeenCalledWith({ preventScroll: true });
    await waitForList(content, i18n);
  });

  it("does not auto-select, show the detail or focus on mobile", async () => {
    Platform.isMobile = true;
    const { content, i18n } = openModal({
      archives: { [ARCHIVE_PATH]: "留档内容" },
    });
    await waitForList(content, i18n);

    expect(rowsOf(content)).toHaveLength(1);
    expect(rowsOf(content)[0].classList.contains("is-selected")).toBe(false);
    expect(byClass(content, "easy-sync-content-preview")).toBeUndefined();
    expect(textOf(content)).toContain(i18n.t("recovery.selectHint"));
    expect(SearchComponent.instances.at(-1)?.inputEl.focus)
      .not.toHaveBeenCalled();
  });
});

describe("RecoveryModal 定稿文案钉子（2026-10-20 用户圈定）", () => {
  it("恢复失败前缀与写失败原因双语文本逐字", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    expect(zh.t("recovery.restoreFailed")).toBe("恢复失败：{reason}");
    expect(zh.t("recovery.reason.writeFailed")).toBe("副本未能写入仓库");
    expect(en.t("recovery.restoreFailed")).toBe("Restore failed: {reason}");
    expect(en.t("recovery.reason.writeFailed")).toBe(
      "The copy couldn’t be written to the vault",
    );
  });

  it("外来粒子不再回魂：失败通知不带「此刻」，写失败不带「没能/本机」", () => {
    const zh = new I18n("zh-cn");
    expect(zh.t("recovery.restoreFailed")).not.toContain("此刻");
    expect(zh.t("recovery.reason.writeFailed")).not.toContain("没能");
    expect(zh.t("recovery.reason.writeFailed")).not.toContain("本机");
  });
});

describe("RecoveryModal 搜索框归属（2026-10-20 用户判退死控件）", () => {
  it("global view keeps the search box, scoped view drops it", async () => {
    const global = openModal({ vaultFiles: { [NOTE_PATH]: "当前内容" } });
    await waitForList(global.content, global.i18n);
    expect(byClass(global.content, "easy-sync-recovery-search")).toBeDefined();

    const scoped = openModal({ path: NOTE_PATH });
    await waitForList(scoped.content, scoped.i18n);
    expect(byClass(scoped.content, "easy-sync-recovery-search")).toBeUndefined();
  });

  it("desktop scoped open skips the search focus without crash", async () => {
    Platform.isMobile = false;
    const scoped = openModal({ path: NOTE_PATH });
    await waitForList(scoped.content, scoped.i18n);
    expect(SearchComponent.instances).toHaveLength(0);
  });
});
