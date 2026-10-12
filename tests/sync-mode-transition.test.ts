/**
 * 片⑥ 模式切换的纯事实与两道告知弹框的视图模型。
 *
 * 逐字断言定稿文案（`settings.syncMode.gate.*`／`disable.*`），并钉住两个状态：
 * 正常可切换／有待确认的云端删除时拦下；手输不符不生效。开启弹框结构＝首句＋
 * 三条编号要点＋收尾句＋数量行（不留空行）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { I18n } from "../src/i18n";
import {
  countLocalOnlyEditedFacts,
  countLocalOnlyRowFacts,
  syncModeGateInputLiteral,
} from "../src/sync/sync-mode-transition";
import { buildSyncModeGateView } from "../src/ui/sync-mode-gate-modal";
import { buildSyncModeDisableView } from "../src/ui/sync-mode-disable-modal";
import type { LocalOnlyEntryRowV1 } from "../src/sync/local-only-copies";

const zh = new I18n("zh-cn");
const en = new I18n("en");
const zhT = zh.t.bind(zh);

describe("sync mode gate view", () => {
  it("renders the approved copy verbatim with both states", () => {
    const normal = buildSyncModeGateView({
      t: zhT,
      counts: { edited: 3, blockedDeletes: 0 },
      expectedInput: "开启单向同步",
    });
    expect(normal.title).toBe("切换到单向同步");
    expect(normal.message).toBe("切换后，自下一次同步起：");
    // 2026-10-12 末轮定稿：三条要点（以云端为准／本机新建与修改／作用范围合一），
    // 收尾句单列（tail），数量行只说数字（0 件时不出现）。
    expect(normal.points).toEqual([
      "以云端为准：云端修改会覆盖本机，云端删除会同步删除本机。",
      "本机新建不主动上传；本机修改会另存副本。",
      "仅作用于笔记与附件；插件与其他配置不受影响，仍照常同步。",
    ]);
    expect(normal.tail).toBe(
      "上述“本机修改”和“本机新建”的文件会列在同步面板中，可选择上传到云端，或留在本机。",
    );
    expect(normal.counts).toEqual([
      "本机有 3 个文件修改过、尚未上传。",
    ]);
    expect(normal.blocked).toBe(false);
    expect(normal.inputLabel).toBe("请输入“开启单向同步”以继续。");
    expect(normal.confirmLabel).toBe("确认切换");
    expect(normal.cancelLabel).toBe("取消");
    // 手输一致之前确认不可用；一致后可切换。
    expect(normal.confirmDisabled).toBe(true);
    expect(buildSyncModeGateView({
      t: zhT,
      counts: { edited: 3, blockedDeletes: 0 },
      expectedInput: "开启单向同步",
      typed: "开启单向同步",
    }).confirmDisabled).toBe(false);
    expect(buildSyncModeGateView({
      t: zhT,
      counts: { edited: 3, blockedDeletes: 0 },
      expectedInput: "开启单向同步",
      typed: "开启单向同步 ",
    }).confirmDisabled).toBe(true);

    // 有待确认的云端删除：多一句引导，且确认保持不可用（拦下）。
    const blocked = buildSyncModeGateView({
      t: zhT,
      counts: { edited: 3, blockedDeletes: 2 },
      expectedInput: "开启单向同步",
      typed: "开启单向同步",
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.confirmDisabled).toBe(true);
    // 拦下态：数量行多一条引导；要点与收尾句不变。
    expect(blocked.counts).toEqual([
      "本机有 3 个文件修改过、尚未上传。",
      "本机还有 2 条待确认的云端删除。请先去同步面板处理，再切换。",
    ]);
    expect(blocked.points).toEqual(normal.points);
    expect(blocked.tail).toBe(normal.tail);
  });

  it("renders one sentence, the numbered points, the tail line, and the count lines", () => {
    const source = readFileSync("src/ui/sync-mode-gate-modal.ts", "utf8");
    const render = source.slice(
      source.indexOf("onOpen(): void {"),
      source.indexOf("onClose(): void {"),
    );
    // 首句、编号要点、收尾句与数量行同为正常字号（2026-10-12 用户反馈：弹框
    // 条目不要用系统次要小字）——渲染路径不再挂 `setting-item-description`。
    expect(render).toContain('contentEl.createEl("p", { text: view.message });');
    // 编号要点＝有序列表（编号由结构给出，文案稿不含编号）；列表项之间不留空行。
    expect(render).toContain('contentEl.createEl("ol");');
    expect(render).toContain('points.createEl("li", { text: point });');
    // 收尾句接在要点之后、数量行之前。
    expect(render).toContain("text: view.tail");
    expect(render.indexOf("view.tail")).toBeLessThan(
      render.indexOf("for (const line of view.counts)"),
    );
    expect(render).toContain("text: line");
    expect(render).not.toContain("setting-item-description");
    // 不留空行：渲染路径不插入空段落或换行元素。
    expect(render).not.toContain('text: ""');
    expect(render).not.toContain('createEl("br"');
  });

  it("uses the English copy and literal for the other locale", () => {
    const view = buildSyncModeGateView({
      t: en.t.bind(en),
      counts: { edited: 1, blockedDeletes: 0 },
      expectedInput: syncModeGateInputLiteral("en"),
    });
    expect(view.title).toBe("Switch to One-way sync");
    expect(view.inputLabel).toBe("Type “Turn on One-way sync” to continue.");
    expect(view.message).toBe("After you switch, from the next sync on:");
    expect(view.points).toEqual([
      "The cloud takes precedence: cloud edits overwrite this device, and cloud deletions delete the files here as well.",
      "Files created here are not uploaded automatically; files edited here are saved as a copy.",
      "This applies to notes and attachments only; plugins and other settings are unaffected and keep syncing as before.",
    ]);
    expect(view.tail).toBe(
      "The files you edited or created here are listed in the sync panel, where you can upload them to the cloud or keep them on this device.",
    );
    expect(view.counts).toEqual([
      "1 file(s) here have been edited and not uploaded yet.",
    ]);
    expect(syncModeGateInputLiteral("zh-cn")).toBe("开启单向同步");
    expect(syncModeGateInputLiteral("en")).toBe("Turn on One-way sync");
  });
});

describe("sync mode disable view", () => {
  it("renders the approved copy verbatim with both counts", () => {
    const view = buildSyncModeDisableView({
      t: zhT,
      counts: { pendingUploads: 4, dismissed: 2 },
    });
    expect(view.title).toBe("切换到双向同步");
    // 2026-10-12 末轮定稿：说明句只说模式变化（不再提"关闭"），数量行把数字与
    // 后果放一起，且"关闭后"随标题改口径为"切换后"。
    expect(view.lines).toEqual([
      "切换后，本机与云端将双向同步。",
      "本机有 4 个文件尚未上传，切换后会同步到云端。",
      "其中 2 个是你之前选择不再提醒的。",
    ]);
    expect(view.confirmLabel).toBe("确认切换");
    expect(view.cancelLabel).toBe("取消");
  });

  it("drops the count lines entirely when there is nothing local-only", () => {
    // 两个计数都为 0（用户 2026-10-12 指出的排布问题）：不再出现"本机有 0 个
    // 文件…"这类空话，只剩说明句与两个按钮。
    const empty = buildSyncModeDisableView({
      t: zhT,
      counts: { pendingUploads: 0, dismissed: 0 },
    });
    expect(empty.lines).toEqual(["切换后，本机与云端将双向同步。"]);

    // 有内容但没有"不再提醒"项：只少最后一句。
    const noDismissed = buildSyncModeDisableView({
      t: zhT,
      counts: { pendingUploads: 3, dismissed: 0 },
    });
    expect(noDismissed.lines).toEqual([
      "切换后，本机与云端将双向同步。",
      "本机有 3 个文件尚未上传，切换后会同步到云端。",
    ]);

    // 门槛弹框同一条原则：没有改过的文件时不出"本机有 0 个文件…"，
    // 拦下态仍然只报那条待确认删除。
    const gateEmpty = buildSyncModeGateView({
      t: zhT,
      counts: { edited: 0, blockedDeletes: 0 },
      expectedInput: "开启单向同步",
    });
    expect(gateEmpty.counts).toEqual([]);
    const gateBlockedOnly = buildSyncModeGateView({
      t: zhT,
      counts: { edited: 0, blockedDeletes: 2 },
      expectedInput: "开启单向同步",
    });
    expect(gateBlockedOnly.counts).toEqual([
      "本机还有 2 条待确认的云端删除。请先去同步面板处理，再切换。",
    ]);

    // 英文侧同一规则。
    const enEmpty = buildSyncModeDisableView({
      t: en.t.bind(en),
      counts: { pendingUploads: 0, dismissed: 0 },
    });
    expect(enEmpty.lines).toEqual([
      "After you switch, this device syncs both ways with the cloud again.",
    ]);
  });
});

describe("sync mode transition counts", () => {
  it("counts the files that will become copies", () => {
    // 有基线且本机改过／无基线但云端同名＝切换后会留副本的那些。
    expect(countLocalOnlyEditedFacts({
      localEntries: [
        { path: "edited.md", hash: "b".repeat(64), size: 10, mtime: 1, binary: false },
        { path: "unchanged.md", hash: "a".repeat(64), size: 10, mtime: 1, binary: false },
        { path: "same-name.md", hash: "c".repeat(64), size: 10, mtime: 1, binary: false },
        { path: "local-only.md", hash: "d".repeat(64), size: 10, mtime: 1, binary: false },
        { path: "resized.md", hash: "a".repeat(64), size: 11, mtime: 1, binary: false },
      ],
      baseEntries: [
        { path: "edited.md", hash: "a".repeat(64), size: 10, eTag: "etag-1" },
        { path: "unchanged.md", hash: "a".repeat(64), size: 10, eTag: "etag-2" },
        { path: "resized.md", hash: "a".repeat(64), size: 10, eTag: "etag-3" },
      ],
      remoteEntries: [
        {
          path: "same-name.md",
          driveId: "same-name",
          size: 10,
          mtime: 1,
          eTag: "etag-4",
        },
      ],
      configDir: ".obsidian",
    })).toBe(3);
  });

  it("leaves the excluded config/plugin blocks out of the copy count", () => {
    // 排除块（六个受管配置、themes/snippets 目录 owner、社区插件、自身构筑物）在
    // 模式内保持双向，不会变成副本，因此不进这个数字（2026-10-12 review 修正）。
    const local = (path: string) => ({
      path,
      hash: "b".repeat(64),
      size: 10,
      mtime: 1,
      binary: false,
    });
    const base = (path: string) => ({
      path,
      hash: "a".repeat(64),
      size: 10,
      eTag: `etag-${path}`,
    });
    expect(countLocalOnlyEditedFacts({
      localEntries: [
        local("note.md"),
        local(".obsidian/app.json"),
        local(".obsidian/themes/MyTheme/theme.css"),
        local(".obsidian/snippets/my-snippet.css"),
        local(".obsidian/plugins/calendar/main.js"),
        local(".obsidian/plugins/easy-sync/styles.css"),
      ],
      baseEntries: [
        base("note.md"),
        base(".obsidian/app.json"),
        base(".obsidian/themes/MyTheme/theme.css"),
        base(".obsidian/snippets/my-snippet.css"),
        base(".obsidian/plugins/calendar/main.js"),
        base(".obsidian/plugins/easy-sync/styles.css"),
      ],
      remoteEntries: [],
      configDir: ".obsidian",
    })).toBe(1);
  });

  it("counts local-only rows with and without the ignore memory", () => {
    const rows: LocalOnlyEntryRowV1[] = [
      { kind: "edited", path: "note.md", targetPath: "note（副本）.md" },
      { kind: "created", path: "new-note.md", targetPath: "new-note.md" },
    ];
    expect(countLocalOnlyRowFacts({ rows, memory: null })).toEqual({
      total: 2,
      dismissed: 0,
    });
    expect(countLocalOnlyRowFacts({
      rows,
      memory: {
        schemaVersion: 1,
        kind: "local-only-ignore-memory",
        ignoredPaths: ["new-note.md", "gone.md"],
      },
    })).toEqual({ total: 2, dismissed: 1 });
  });
});
