// S5 形状序列测试台 —— 双设备真实形状的性质级基准（D6 四性质）。
//
// §收录边界（铁律）：只收录「现役引擎已达标」的形状，断言绿＝对现役行为的
// 性质保护；现役仍不达标的形状不写恒红／expected-failure 断言，列入文件头
// 「待转绿」清单，等对应切片转绿后回填为普通基准形状。
//
// §基准形状清单（判例号 → 形状序列一句话 → 断言性质）：
//   · 基线-双设备稳定轮（F29 真宿主双 Vault 实测 20261016-231225 §3.1–3.2 的
//     台面化）：两台预收敛设备先各自跑一轮（0 动作 0 账本）；A 本机新建文件
//     → A 一轮上传 → B 一轮下载 → 拉锯收敛；
//     断言：尾轮零动作、双设备三面（本地/远端/世界）一致、账本与待办清空。
//   · F17（renameRemote 回执形状门，已随 1.5.1 发布修复）：
//     云端 item 被三方触过且该次变更的 Graph 响应未携内容哈希（「意图远端
//     sha 未知」窗口）→ 用户在本机改名 → 引擎按身份规划 renameRemote 移动
//     同一云端 item；断言：本轮内回执成立并清账（合法形态＋真实哈希回写，
//     绝不取本机哈希）、身份连续、内容零改动、拉锯收敛。
//     （现役引擎在「远端单向移动＋本机未动」的兄弟形状选择跟随远端——那
//     一方向不做本条判例的断言对象；本条保护的是执行链回执可写这一面。）
//   · F27-A（大小写拼写分叉的规划层守卫，随 1.6.0 冻结、未发布）：
//     本机文件落入与索引只差大小写的父目录 → 计划层把身份移动扣成延后行，
//     绝不发射以本机拼写作父路径的 renameRemote；断言：零内容动作、待办行
//     位置可辨认、跨轮计数稳定不增账不停摆；其余文件照常同步。
//   · A1-乙（目的地父目录拼写别名闸，同上随 1.6.0 冻结）：
//     本机目录改名成只差大小写的别名，且在别名父目录下新建文件 → 整树被
//     目录层的 local-rename-evidence-conflict 延后行扣住，可执行动作全部
//     押后（A1-乙的目的地父拼写闸在别名形状下不发射）；断言：零上传、
//     行在、跨轮稳定不增账不停摆、内容零丢失。
//   · F24（云端同名目录重建，已随 1.5.8 发布修复）：
//     云端同路径目录被删除重建（全部 id 新生）→ 死锚点走「同名现役目录＋
//     后代证据」自动重建 / 共享身份确认链；断言：不产出「保留文件并重新上传」
//     必败的 deleteLocal 行发向现存路径、后代内容零丢失、多轮内收敛或行带
//     身份确认出口。
//   · F29-切片1（文件夹移动后代投影闸，随 1.6.0 冻结）：
//     云端已重组某文件夹子树（后代投影 ≠ 机械翻译）→ 计划层把该文件夹移动
//     扣成 remote-subtree-changed 延后行；断言：零文件夹移动、零账本、零停摆。
//   · F29-附录（真实移动＋无回执记录 一轮结清，20261016-231225 §3.2 实测）：
//     一条真实会做的无回执文件夹移动意图已被世界落实 → 恢复链一轮按现状把
//     记录结清到零；断言：账本轮内清空、锚点按新路径重投影、无停摆。
//
// §待转绿清单（引擎侧出口已收编、台面表达仍缺，不写断言）：
//   · F27 / F29 野外既有记录（别名拼写分叉、后代投影分歧已落成的
//     receiptPendingCommit 记录）——**出口已收编，台面表达仍缺**：
//     乙刀把拼写分叉的回执归一到索引拼写后重试提交（自动结清，
//     钉子＝tests/recovery-rename-remote-spelling-rebase.test.ts）；
//     甲刀＋S2 把「回执核验为真、共同状态结构性拒绝」的记录纳入记录级隔离
//     通道（钉子＝tests/folder-record-isolation-gate.test.ts 与
//     tests/isolation-channel-capsules.test.ts）；S4 给隔离子树一次结局
//     （tests/sync-item-termination.test.ts）——「重置同步状态」不再是这两类
//     存量记录的唯一出口。台面未收录的原因（还差什么）：两种形状都要求账本
//     里先存在**由执行链产生的回执**，而台面既有注入手法
//     `seedAppliedFolderMoveRecord` 只支持「无回执、世界已落实」的文件夹
//     移动；且真实轮会把回执当场提交成功——结构拒绝只发生在「世界在回执与
//     提交之间被再组织」的时序窗口，双设备真实轮无法确定制造。
//     ⇒ 候选＝台面注入手法（回执注入＋定向状态背离），不是本台的形状缺口。
//   · F22（迁移审阅确认空转）、F21（范围恢复预检停车）：判例在迁移/协议层
//     而非引擎轮，不在本台形状表达范围。
//   · F26「本机与远端都变过」的 upload 残余：明确不做（2026-10-13 边界）。
//   · F30（网络失败窗口：整轮错误属既有豁免族时不再暂停自动同步）：判据点
//     在主入口暂停门（main.ts），不在引擎轮形状台表达范围；执行器侧的失败
//     分账与熔断退避已有 sync-safety-breaker-and-network 主题承重，不重复。
//
// §变异要求：每个形状测试先绿后变异至少一发（把形状输入或守卫前提改坏 ⇒ 红），
// 变异的凭据随交付报告登记（变异本身不入库）。本文件出库时全部为绿。
//
// 文件按《测试与检查规范》§6 新主题独立成件；夹具全部来自
// tests/helpers/sync-shape-sequence-harness.ts（与现有用例零触碰）。

import { describe, expect, it } from "vitest";
import { sha256Sync } from "./helpers/sync-shape-sequence-harness";
import {
  addShapeDevice,
  createShapeWorld,
  describePending,
  expectDeviceZeroActionRound,
  expectFleetConverged,
  roundHadZeroActions,
  settleFleet,
  worldView,
} from "./helpers/sync-shape-sequence-harness";
import type { ShapeDevice, ShapeWorld } from "./helpers/sync-shape-sequence-harness";
import type { SyncResult } from "../src/sync/sync-executor";

const textHash = (content: string): string =>
  sha256Sync(new TextEncoder().encode(content).buffer);

/** 六文件三目录的基线世界：形状序列的小改动都远低于计划审阅闸（>50%）。 */
function createBaselineWorld(): ShapeWorld {
  return createShapeWorld({
    files: {
      "doc/a.md": "alpha-a",
      "doc/b.md": "alpha-b",
      "log/c.md": "beta-c",
      "log/d.md": "beta-d",
      "g.md": "gamma-g",
      "h.md": "gamma-h",
    },
    folders: ["doc", "log"],
  });
}

async function addConvergedPair(
  world: ShapeWorld,
): Promise<{ a: ShapeDevice; b: ShapeDevice }> {
  const a = await addShapeDevice(world, "device-a");
  const b = await addShapeDevice(world, "device-b");
  await a.runRound();
  await b.runRound();
  expectDeviceZeroActionRound(a);
  expectDeviceZeroActionRound(b);
  await expectFleetConverged(world, [a, b]);
  return { a, b };
}

describe("S5 shape sequence test bench (dual-device)", () => {
  it("baseline: converged fleet stays idle, then device A upload converges through B", async () => {
    const world = createBaselineWorld();
    const { a, b } = await addConvergedPair(world);
    const beforeView = worldView(world);

    // A 本机新建文件：用户在设备 A 动手。
    await a.writeLocalFile("doc/new.md", "brand-new-content");
    const aRound = await a.runRound();

    expect(aRound.success).not.toBe(false);
    expect(aRound.uploaded).toBe(1);
    expect(aRound.errors).toBe(0);
    expect(aRound.foldersCreated).toBe(0);
    // 上传已落到世界里：内容哈希级事实（D6 ②）。
    expect(world.snapshot().files.get("doc/new.md")).toBe(
      textHash("brand-new-content"),
    );
    expect(a.ledger()).toHaveLength(0);

    // 拉锯收敛：B 的下一轮应看到并吸收该文件，队内三面（本地/远端/世界）一致。
    await settleFleet(world, [a, b], { maxSweeps: 2 });
    expect(a.committedBasePaths()).toContain("doc/new.md");
    expect(b.committedBasePaths()).toContain("doc/new.md");
    // 其余文件零改动（D6 ②）。
    for (const [path, hash] of beforeView.files) {
      expect(world.snapshot().files.get(path)).toBe(hash);
    }
  });

  it("F27-A: local file dropped into a case-spelling alias parent defers instead of a doomed remote move", async () => {
    const world = createShapeWorld({
      files: {
        "videos/notes.md": "stored-notes",
        "root.md": "root-content",
        "doc/plain.md": "plain",
      },
      folders: ["videos", "doc"],
    });
    const { a, b } = await addConvergedPair(world);

    // 本机：把 `videos` 目录改名成只差大小写的 `Videos`（野外案的动作形状），
    // 再把根部文件挪进去。
    await a.renameLocalFolder("videos", "Videos");
    await a.renameLocalFile("root.md", "Videos/root.md");

    const aRound = await a.runRound();
    expect(aRound.errors).toBe(0);
    expect(aRound.uploaded).toBe(0);
    expect(aRound.downloaded).toBe(0);
    expect(aRound.deleted).toBe(0);
    expect(aRound.filesMoved).toBe(0);

    // D6 ③：被扣下的形状以可辨认的延后/冲突行呈现；世界零移动（云端文件
    // 仍按旧路径驻留），账本零记录——绝不出现以本机拼写发射、注定回执不可
    // 提交的 renameRemote。
    const pending = describePending(a);
    expect(
      pending.some((row) =>
        row.actionType === "folderDeferred"
        && row.path === "videos"
        && row.issueCode === "local-rename-evidence-conflict"),
    ).toBe(true);
    const ids = world.snapshot().ids;
    expect(ids.has("root.md")).toBe(true);
    expect(ids.has("Videos/root.md")).toBe(false);
    expect(a.ledger()).toHaveLength(0);
    expect(a.syncCalls.moves).toHaveLength(0);
    // 零内容动作被扣下不等于数据丢失：字节两侧原样（D6 ②）。
    expect(world.snapshot().files.get("videos/notes.md")).toBe(
      textHash("stored-notes"),
    );

    // 拉锯轮：不增账、不停摆，其余文件照常（B 一轮照样零动作）。
    const bRound = await b.runRound();
    expect(bRound.errors).toBe(0);
    expect(bRound.uploaded + bRound.downloaded + bRound.deleted).toBe(0);
    const aRound2 = await a.runRound();
    expect(aRound2.errors).toBe(0);
    expect(aRound2.uploaded + aRound2.downloaded + aRound2.deleted).toBe(0);
  });

  it("A1-B: creation inside a case-spelling alias parent stays withheld while the rename defers", async () => {
    const world = createShapeWorld({
      files: {
        "videos/notes.md": "stored-notes",
      },
      folders: ["videos"],
    });
    const { a, b } = await addConvergedPair(world);

    // 本机：目录改名成只差大小写的 `Videos`，并在其中新建一个文件
    //（野外案「目的地父目录拼写别名」家族的创建半边）。
    await a.renameLocalFolder("videos", "Videos");
    await a.writeLocalFile("Videos/composition.md", "fresh-initial");

    const aRound = await a.runRound();
    expect(aRound.errors).toBe(0);
    // A1 乙：别ч父目录下不得发射任何带本机父拼写的可执行动作
    //（CreateRemoteFolder／Upload）；新文件被扣在本地，等待目录层收口。
    expect(aRound.uploaded).toBe(0);
    expect(aRound.foldersCreated).toBe(0);
    const pending = describePending(a);
    expect(
      pending.some((row) =>
        row.actionType === "folderDeferred"
        && row.issueCode === "local-rename-evidence-conflict"),
    ).toBe(true);
    expect(world.snapshot().files.has("Videos/composition.md")).toBe(false);
    expect(a.ledger()).toHaveLength(0);
    // 拉锯稳定：不增账、不停摆、内容零丢失。
    const bRound = await b.runRound();
    expect(bRound.errors).toBe(0);
    const aRound2 = await a.runRound();
    expect(aRound2.errors).toBe(0);
    expect(aRound2.uploaded).toBe(0);
    expect(world.snapshot().files.get("videos/notes.md")).toBe(
      textHash("stored-notes"),
    );
  });

  it("F24: same-path remote folder rebuild defers to a confirmable identity row instead of a doomed delete row", async () => {
    const world = createShapeWorld({
      files: {
        "Albums/pic.png": "PIXELDATA",
        "Albums/info.md": "caption",
        "other/keep.md": "keep-me",
      },
      folders: ["Albums", "other"],
    });
    const { a, b } = await addConvergedPair(world);

    // 云端第三方：删除整棵目录树再在原路径原内容重建（全部 id 新生）。
    world.recreateRemoteFolderAt("Albums");

    const aRound = await a.runRound();
    expect(aRound.errors).toBe(0);
    // F24 属性①：绝不发射可执行内容动作（尤其不是向现存路径发 deleteLocal，
    // 也不整树重传）；世代破断只经身份快照整体重建吸收。
    expect(a.syncCalls.uploads).toHaveLength(0);
    expect(a.syncCalls.downloads).toHaveLength(0);
    expect(a.syncCalls.deletes).toHaveLength(0);
    expect(a.syncCalls.moves).toHaveLength(0);
    expect(a.ledger()).toHaveLength(0);
    // 属性②：死锚点交接到共享文件夹身份确认行（可点出口），而不是
    // 「保留文件并重新上传」必败行。
    expect(describePending(a)).toEqual([
      expect.objectContaining({
        path: "Albums",
        actionType: "folderDeferred",
        issueCode: "unanchored-shared-folder",
      }),
    ]);
    // 属性③（零数据流）：B 的树未动；后代文件字节两侧原样。
    expect(b.ledger()).toHaveLength(0);
    expect(b.pendingIssues()).toHaveLength(0);
    expect(world.snapshot().files.get("Albums/pic.png")).toBe(
      textHash("PIXELDATA"),
    );
    expect(world.snapshot().files.get("other/keep.md")).toBe(
      textHash("keep-me"),
    );

    // 属性④：行形状跨轮稳定、账本清空、无执行重演。
    await a.runRound();
    await b.runRound();
    const rowTypology = (device: ShapeDevice) =>
      describePending(device).map((row) => `${row.path}:${row.issueCode}`);
    expect(rowTypology(a)).toEqual(rowTypology(b));
    expect(rowTypology(a)).toEqual(["Albums:unanchored-shared-folder"]);
    expect(a.lastResult!.errors).toBe(0);
    expect(b.lastResult!.errors).toBe(0);
  });

  it("F29 slice1: cloud subtree reorganization defers the folder move instead of a doomed receipt", async () => {
    const world = createShapeWorld({
      files: {
        "proj/readme.md": "readme-content",
        "proj/sub/todo.md": "todo-content",
        "other/keep.md": "keep-me",
      },
      folders: ["proj", "proj/sub", "other"],
    });
    const { a, b } = await addConvergedPair(world);

    // 云端第三方：把 proj 改名成 projX，并把子目录搬去 other（后代身份锚点
    // 的投影 ≠ 机械翻译——野外案 2026-10-16 的结构性死路形状）。
    world.renameRemoteFolder("proj", "projX");
    world.moveRemoteFolder("projX/sub", "other");

    const aRound = await a.runRound();
    expect(aRound.errors).toBe(0);
    // 切片1：计划层不发射任何可执行文件夹移动（回执必然结构性不可提交）。
    expect(a.syncCalls.moves).toHaveLength(0);
    expect(a.ledger()).toHaveLength(0);
    expect(describePending(a)).toEqual([
      expect.objectContaining({
        path: "projX",
        actionType: "folderDeferred",
        issueCode: "remote-subtree-changed",
      }),
    ]);
    // 零误写零丢失：字节两侧原样（D6 ②）。
    expect(world.snapshot().files.get("projX/readme.md")).toBe(
      textHash("readme-content"),
    );
    expect(world.snapshot().files.get("other/sub/todo.md")).toBe(
      textHash("todo-content"),
    );

    // 拉锯稳定：延后行形状逐轮稳定、零账本、零停摆。
    for (let index = 0; index < 3; index++) {
      await b.runRound();
      const next = await a.runRound();
      expect(next.errors).toBe(0);
      expect(next.uploaded + next.downloaded + next.deleted).toBe(0);
      expect(a.syncCalls.moves).toHaveLength(0);
      expect(
        describePending(a)
          .some((row) => row.path === "projX"
            && row.issueCode === "remote-subtree-changed"),
      ).toBe(true);
      expect(a.ledger()).toHaveLength(0);
    }
  });

  it("F29 appendix: an unreceipted folder move already carried out by the world settles in one round", async () => {
    const world = createShapeWorld({
      files: {
        "F/x.md": "inner-content",
        "anchor.md": "rootfile",
      },
      folders: ["F"],
    });
    const { a, b } = await addConvergedPair(world);

    // 一条真实会做的移动：本机把 F 改名 FX，云端第三方也已把同一文件夹搬到
    // FX——但回执从未落地（引擎会写的意图记录已在账本里）。
    //
    // §机制归属（验收轮修正 2026-10-17）：本形状（意图未回执＋世界已落实）
    // 由**普通恢复结算路径**一轮结清——验收变异证实：短路
    // `settlePersistedMutationRecord` 调用 ⇒ 本条红；禁用第二刀
    // `tryAutoSettleFolderMutationRecovery` ⇒ 本条**不**红 ⇒ 本条不是第二刀
    // 「零写入结案」（初始态要求「回执已写＋提交被结构性拒绝」）的钉子，
    // 后者由实施日志 `20261016-205048` 的 3 条钉子在其既有主题内承重，本台
    // 不重复。本条价值＝把 20261016-231225 §3.2 真宿主实测的「真实移动＋无
    // 回执记录 ⇒ 一轮自行结清到零＋锚点正确重投影」台面化为性质保护。
    const record = a.seedAppliedFolderMoveRecord({
      sourcePath: "F",
      targetPath: "FX",
    });
    await a.renameLocalFolder("F", "FX");
    world.renameRemoteFolder("F", "FX");
    expect(a.ledger()).toHaveLength(1);

    const aRound = await a.runRound();
    expect(aRound.errors).toBe(0);
    expect(roundHadZeroActions(aRound)).toBe(true);
    expect(record.receipt).not.toBeNull();
    // 普通恢复结算路径按现状认出动作已完成：记录结清、账本清零、零停摆。
    expect(a.ledger()).toHaveLength(0);
    expect(describePending(a)).toHaveLength(0);
    // 锚点按新路径重投影（机制面）。
    const envelope = a.state.getCommittedV2Envelope()!;
    const folderAnchors = Object.values(
      envelope.folderAnchors?.byAnchorId ?? {},
    ).map((anchor) => `${anchor.lastPath}:${anchor.remoteId}`);
    expect(folderAnchors).toContain(`FX:${world.snapshot().ids.get("FX")}`);

    // 双设备拉锯收敛：B 在下一轮把本地文件随文件夹改写归位（动作零损失），
    // 之后全队三面一致。
    await settleFleet(world, [a, b]);
  });

  it("F17: hash-blind republish keeps the renameRemote receipt committable in-round", async () => {
    const world = createShapeWorld({
      files: {
        "Hold/note.md": "kept-note-content",
        "other/keep.md": "keep-me",
        "flat.md": "flat-content",
      },
      folders: ["Hold", "other"],
    });
    const { a, b } = await addConvergedPair(world);
    const noteId = world.snapshot().ids.get("Hold/note.md")!;

    // 云端第三方触过云端 item，而这次变更的 Graph 响应未携内容哈希
    // （野外案 renameRemote「意图远端 sha 未知」的来源窗口）。
    world.editRemoteFileHashBlind("Hold/note.md", "kept-note-content");

    // 用户在本机把文件改名：引擎按身份规划 renameRemote（移动云端 item）。
    await a.renameLocalFile("Hold/note.md", "Hold/renamed.md");

    const aRound = await a.runRound();
    expect(aRound.errors).toBe(0);
    // F17 三刀：合法回执形态＋真实哈希回写（绝不取本机哈希）＋分类器
    // size 保持锚 ⇒ renameRemote 回执在本轮成立、账本清零。
    expect(a.ledger()).toHaveLength(0);
    expect(a.syncCalls.moves).toEqual(["Hold/note.md->renamed.md"]);
    // 身份连续（同一 Graph id 被移动，未替换）＋内容零改动（D6 ②）。
    expect(world.snapshot().ids.get("Hold/renamed.md")).toBe(noteId);
    expect(world.snapshot().files.get("Hold/renamed.md")).toBe(
      textHash("kept-note-content"),
    );

    // 双设备拉锯收敛：B 对齐云端新路径后全队三面一致、账本皆空。
    await settleFleet(world, [a, b], { maxSweeps: 2 });
  });
});
