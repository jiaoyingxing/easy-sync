/**
 * 片① 出站抑制（仅接收／单向同步）——计划生产链行为测试。
 *
 * 观测口径：方向＝单向时 `finalizeCanonicalPlanCandidateV2` 的输出里不出现任何
 * 出站用户内容动作（`Upload`／`DeleteRemote`／`RenameRemote`／远端目录动作），
 * 入站动作与「强制跟随删除」（`autoDeleteLocalFiles` 等效恒开）保持不变；
 * 排除三块（配置白名单／社区插件／EasySync 自同步）仍按双向输出；
 * 方向＝双向（默认与显式）时输出与改造前逐项一致（对拍）。
 *
 * 计划审阅影响计数与决策令牌都在抑制之后结算：被抑制的动作既不进影响计数，
 * 也不残留令牌。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import {
  buildCanonicalPlanCandidateV2,
  finalizeCanonicalPlanCandidateV2,
  summarizeCanonicalPlanReviewV2,
  type CanonicalPlanCandidateV2,
  type FinalizeCanonicalPlanInputV2,
} from "../src/sync/canonical-plan-v2";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import type {
  FolderAnchorV2,
  SyncAnchorV2,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
import type { AutomaticHandlingPolicy } from "../src/sync/automatic-handling-policy";
import en from "../src/i18n/en";
import zhCN from "../src/i18n/zh-cn";
import {
  emptyLocalOnlyCopiesV1,
  localOnlyCopyPathV1,
  projectLocalOnlyEntryRowsV1,
  readLocalOnlyCopiesV1,
  reconcileLocalOnlyEntriesV1,
  retireLocalOnlyEntriesV1,
  upsertLocalOnlyCopyEntryV1,
  type LocalOnlyCopyEntryV1,
} from "../src/sync/local-only-copies";
import {
  collectOneWayLocalOnlyPaths,
  isExcludedFromOneWaySyncPath,
} from "../src/sync/sync-direction";
import {
  SyncActionType,
  type LocalFileEntry,
  type LocalFolderEntry,
  type RemoteFileEntry,
  type SyncPlanItem,
} from "../src/sync/types";
import type { SyncDirection } from "../src/sync/sync-direction";
import { functionBody } from "./helpers/source-scope";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

const TWO_WAY_POLICY: AutomaticHandlingPolicy = {
  autoDeleteLocalFiles: false,
  mergeNonOverlappingText: true,
};
const FORCED_FOLLOW_POLICY: AutomaticHandlingPolicy = {
  autoDeleteLocalFiles: true,
  mergeNonOverlappingText: true,
};

const OUTBOUND_TYPES: readonly SyncActionType[] = [
  SyncActionType.Upload,
  SyncActionType.DeleteRemote,
  SyncActionType.RenameRemote,
  SyncActionType.CreateRemoteFolder,
  SyncActionType.MoveRemoteFolder,
  SyncActionType.DeleteRemoteFolder,
];

interface FolderSpec {
  id: string;
  name: string;
  parentId?: string;
}

interface FileSpec {
  id: string;
  name: string;
  parentId?: string;
  hash?: string | null;
  size?: number;
}

function envelope(input: {
  folders?: FolderSpec[];
  files?: FileSpec[];
  folderAnchors?: FolderAnchorV2[] | null;
  fileAnchors?: SyncAnchorV2[];
  commitSeq?: number;
}): SyncStateEnvelopeV2 {
  const items: DriveItem[] = [
    ...(input.folders ?? []).map((folder): DriveItem => ({
      id: folder.id,
      name: folder.name,
      folder: {},
      parentReference: {
        id: folder.parentId ?? scope.filesRootId,
      },
      eTag: `etag-${folder.id}`,
    })),
    ...(input.files ?? []).map((file): DriveItem => ({
      id: file.id,
      name: file.name,
      file: {
        hashes: file.hash === null
          ? {}
          : { sha256Hash: file.hash ?? hashA },
      },
      parentReference: {
        id: file.parentId ?? scope.filesRootId,
      },
      size: file.size ?? 10,
      eTag: `etag-${file.id}`,
    })),
  ];
  const result: SyncStateEnvelopeV2 = {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 1,
      commitSeq: input.commitSeq ?? 7,
      committedAt: 1,
    },
    scope,
    remoteIndex: buildRemoteIndexV2(items, scope.filesRootId, null, 2).index,
    anchors: {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(
        (input.fileAnchors ?? []).map((anchor) => [anchor.anchorId, anchor]),
      ),
    },
  };
  if (input.folderAnchors !== null) {
    result.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(
        (input.folderAnchors ?? []).map((anchor) => [anchor.anchorId, anchor]),
      ),
    };
  }
  return result;
}

function folderAnchor(
  remoteId: string,
  lastPath: string,
  parentRemoteId = scope.filesRootId,
): FolderAnchorV2 {
  return {
    anchorId: `folder:${remoteId}`,
    remoteId,
    lastPath,
    parentRemoteId,
    remoteETag: `etag-${remoteId}`,
    confirmedGeneration: 1,
    confirmedAt: 1,
  };
}

function fileAnchor(
  remoteId: string,
  lastPath: string,
  hash = hashA,
  size = 10,
): SyncAnchorV2 {
  return {
    anchorId: `file:${remoteId}`,
    remoteId,
    lastPath,
    contentHash: hash,
    size,
    remoteETag: `etag-${remoteId}`,
    confirmedAt: 1,
    confirmedBy: "equal-read",
  };
}

function localFile(
  path: string,
  hash = hashA,
  size = 10,
): LocalFileEntry {
  return { path, hash, size, mtime: 1, binary: false };
}

function localFolders(...paths: string[]): LocalFolderEntry[] {
  return paths.map((path) => ({ path }));
}

function remoteFile(
  path: string,
  driveId: string,
  hash = hashA,
  size = 10,
): RemoteFileEntry {
  return {
    path,
    driveId,
    parentId: scope.filesRootId,
    size,
    mtime: 1,
    eTag: `etag-${driveId}`,
    cTag: `ctag-${driveId}`,
    sha256Hash: hash,
  };
}

function build(input: {
  state: SyncStateEnvelopeV2;
  localFiles: LocalFileEntry[];
  localFolders?: LocalFolderEntry[];
}): CanonicalPlanCandidateV2 {
  return buildCanonicalPlanCandidateV2({
    envelope: input.state,
    localFiles: input.localFiles,
    localFolders: input.localFolders ?? [],
    localFolderScanComplete: true,
    skippedLarge: [],
    configDir: ".obsidian",
    automaticDeleteLocalFiles: false,
  });
}

/** Finalize one candidate for a direction; the default direction is two-way. */
function finalizeCanonicalPlan(input: {
  candidate: CanonicalPlanCandidateV2;
  envelope: SyncStateEnvelopeV2;
  direction?: SyncDirection;
  policy?: AutomaticHandlingPolicy;
}) {
  const request: FinalizeCanonicalPlanInputV2 = {
    candidate: input.candidate,
    envelope: input.envelope,
    vaultName: "Vault",
    accountId: scope.accountId,
    configDir: ".obsidian",
    automaticHandlingPolicy: input.policy ?? { ...TWO_WAY_POLICY },
    baselineReconstructionIncomplete: false,
    resolveRemoteContentHash: async () => {
      throw new Error("this fixture must not need a content download");
    },
    ...(input.direction === undefined ? {} : { syncDirection: input.direction }),
  };
  return finalizeCanonicalPlanCandidateV2(request);
}

/** Handcraft one candidate from a valid empty plan plus explicit items. */
function craftedCandidate(
  items: SyncPlanItem[],
): { candidate: CanonicalPlanCandidateV2; envelope: SyncStateEnvelopeV2 } {
  const state = envelope({ folderAnchors: [] });
  return {
    envelope: state,
    candidate: { ...build({ state, localFiles: [] }), items },
  };
}

function itemKeys(items: readonly SyncPlanItem[]): string[] {
  return items.map((item) => `${item.type}:${item.path}`);
}

function outboundItems(items: readonly SyncPlanItem[]): SyncPlanItem[] {
  return items.filter((item) => OUTBOUND_TYPES.includes(item.type));
}

const hashD = "d".repeat(64);
const hashE = "e".repeat(64);
const hashF = "f".repeat(64);

/**
 * Mixed ordinary input: two baseline-only uploads, one remote rename, one local
 * deletion (DeleteRemote), one local-only new folder plus its file, one
 * both-sides-modified conflict, and one ordinary incoming download.
 */
function mixedOutboundFacts(): {
  state: SyncStateEnvelopeV2;
  localFiles: LocalFileEntry[];
  localFolders: LocalFolderEntry[];
} {
  const state = envelope({
    files: [
      { id: "edited", name: "edited.md", hash: hashA },
      { id: "gone-locally", name: "gone-locally.md", hash: hashD },
      { id: "old", name: "old.md", hash: hashE },
      { id: "conflict", name: "conflict.md", hash: hashC, size: 30 },
      { id: "remote-only", name: "remote-only.md", hash: hashB },
    ],
    folderAnchors: [],
    fileAnchors: [
      fileAnchor("edited", "edited.md", hashA),
      fileAnchor("gone-locally", "gone-locally.md", hashD),
      fileAnchor("old", "old.md", hashE),
      fileAnchor("conflict", "conflict.md", hashF),
    ],
  });
  return {
    state,
    localFiles: [
      localFile("edited.md", hashB),
      localFile("new.md", hashE),
      localFile("conflict.md", hashB, 20),
      localFile("new-folder/note.md", hashB, 20),
    ],
    localFolders: localFolders("new-folder"),
  };
}

describe("one-way plan suppression", () => {
  it("drops all outbound user-content actions and keeps the two-way plan unchanged", async () => {
    const facts = mixedOutboundFacts();
    const candidate = build(facts);

    // Precondition: this input really does exercise the outbound set.
    const twoWay = await finalizeCanonicalPlan({
      candidate,
      envelope: facts.state,
      direction: "two-way",
    });
    const twoWayTypes = twoWay.items.map((item) => item.type);
    expect(twoWayTypes).toContain(SyncActionType.Upload);
    expect(twoWayTypes).toContain(SyncActionType.DeleteRemote);
    expect(twoWayTypes).toContain(SyncActionType.RenameRemote);
    expect(twoWayTypes).toContain(SyncActionType.CreateRemoteFolder);

    const explicitTwoWay = await finalizeCanonicalPlan({
      candidate,
      envelope: facts.state,
      direction: "two-way",
    });
    expect(explicitTwoWay.items).toEqual(twoWay.items);
    expect(explicitTwoWay.baseUpserts).toEqual(twoWay.baseUpserts);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: facts.state,
      direction: "one-way",
    });
    expect(outboundItems(oneWay.items)).toEqual([]);
    // 片②：本机改（edited.md）与两端都改（conflict.md）改成"留副本＋云端接管"；
    // 本机删除（gone-locally.md）改成从云端拉回；本机新建（new-folder 与其
    // note.md）继续不出站。
    expect(itemKeys(oneWay.items)).toEqual([
      "download:edited.md",
      "download:remote-only.md",
      "download:conflict.md",
      "download:gone-locally.md",
    ]);
    expect(oneWay.items.map((item) => item.localOnlyCopyKind)).toEqual([
      "edited",
      undefined,
      "edited",
      undefined,
    ]);
    expect(itemKeys(twoWay.items)).toEqual([
      "createRemoteFolder:new-folder",
      "renameRemote:new.md",
      "upload:edited.md",
      "upload:new-folder/note.md",
      "download:remote-only.md",
      "conflict:conflict.md",
      "deleteRemote:gone-locally.md",
    ]);
  });

  it("freezes the round's copy count into the review counts, keeping the two-way shape (件①)", async () => {
    const facts = mixedOutboundFacts();

    // 双向：计数对象形状不变（不落 localOnlyCopies 字段）——activation hold 的
    // 严格比对要求"同一份汇总函数在两处算出同形对象"。
    const twoWay = await finalizeCanonicalPlan({
      candidate: build(facts),
      envelope: facts.state,
      direction: "two-way",
    });
    expect("localOnlyCopies" in summarizeCanonicalPlanReviewV2(twoWay.items).counts)
      .toBe(false);

    // 单向：本轮真会"先留副本、再由云端版本接管原路径"的两条进审阅计数，其余
    // 入站动作不计。侧栏的事前告知句读的就是这份冻结值。
    const oneWay = await finalizeCanonicalPlan({
      candidate: build(facts),
      envelope: facts.state,
      direction: "one-way",
    });
    expect(
      oneWay.items.filter((item) => item.localOnlyCopyKind !== undefined),
    ).toHaveLength(2);
    expect(summarizeCanonicalPlanReviewV2(oneWay.items).counts.localOnlyCopies)
      .toBe(2);
    // 同一事实再算一次逐项相同（审阅计数是计划事实，不是运行期观察）。
    expect(summarizeCanonicalPlanReviewV2(oneWay.items).counts.localOnlyCopies)
      .toBe(2);
  });

  it("keeps every local-only shape out of the plan and out of the confirmation list", async () => {
    // Three shapes that are all "no baseline, no cloud copy": a plain new file,
    // a 片② copy ("副本"), and the new path left behind by a local rename.
    const state = envelope({ folderAnchors: [] });
    const localOnlyPaths = [
      "new-note.md",
      "note（副本 2026-10-11 2345）.md",
      "renamed-new-path.md",
    ];
    const candidate = build({
      state,
      localFiles: localOnlyPaths.map((path) => localFile(path)),
    });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual(localOnlyPaths.map(
      (path) => `upload:${path}`,
    ));

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([]);
    expect(oneWay.baseUpserts).toEqual([]);
    // 不进"待确认删除"，也不产生任何其它出站动作。
    expect(oneWay.items.filter((item) =>
      item.type === SyncActionType.ConfirmLocalDelete
      || item.type === SyncActionType.Upload
      || item.type === SyncActionType.DeleteRemote)).toEqual([]);

    // 下一轮同样（同一事实再算一次，逐项相同）：本机独有内容原地不动。
    const secondRound = await finalizeCanonicalPlan({
      candidate: build({
        state,
        localFiles: localOnlyPaths.map((path) => localFile(path)),
      }),
      envelope: state,
      direction: "one-way",
    });
    expect(secondRound.items).toEqual([]);
  });

  it("keeps the activation review free of upload rows for local-only files", async () => {
    // The activation hold stores the sealed plan's items and its canonical
    // review (see the wiring assertions below), so these are the exact numbers
    // the review face gets.
    const freshState = envelope({ folderAnchors: [] });
    const freshCandidate = build({
      state: freshState,
      localFiles: [localFile("new-note.md"), localFile("new-note-2.md")],
    });

    const twoWayFresh = await finalizeCanonicalPlan({
      candidate: freshCandidate,
      envelope: freshState,
    });
    expect(twoWayFresh.items.map((item) => item.type))
      .toEqual([SyncActionType.Upload, SyncActionType.Upload]);
    // 全新设备没有已登记文件：lastTotalFiles＝0，阈值门本就不触发（两个方向都
    // 一样）——首同步审阅是 activation hold，不经阈值门。
    expect(twoWayFresh.lastTotalFiles).toBe(0);
    expect(twoWayFresh.requiresThresholdConfirmation).toBe(false);

    const oneWayFresh = await finalizeCanonicalPlan({
      candidate: freshCandidate,
      envelope: freshState,
      direction: "one-way",
    });
    expect(oneWayFresh.items).toEqual([]);
    const freshReview = summarizeCanonicalPlanReviewV2(oneWayFresh.items);
    expect(freshReview.counts.uploads).toBe(0);
    expect(freshReview.impactCount).toBe(0);
    expect(oneWayFresh.requiresThresholdConfirmation).toBe(false);

    // 有一份已登记文件的设备：双向会因上传而暂停审阅，单向不会。
    const knownState = envelope({
      files: [{ id: "known", name: "known.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("known", "known.md")],
    });
    const candidate = build({
      state: knownState,
      localFiles: [localFile("known.md"), localFile("new-note.md")],
    });
    const twoWay = await finalizeCanonicalPlan({
      candidate,
      envelope: knownState,
    });
    expect(twoWay.requiresThresholdConfirmation).toBe(true);
    expect(summarizeCanonicalPlanReviewV2(twoWay.items).counts.uploads).toBe(1);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: knownState,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([]);
    expect(summarizeCanonicalPlanReviewV2(oneWay.items)).toEqual({
      counts: {
        uploads: 0,
        downloads: 0,
        folders: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      impactCount: 0,
    });
    expect(oneWay.requiresThresholdConfirmation).toBe(false);
  });

  it("stays stable once the renamed-away old path is back and the new path stays local", async () => {
    // Post-round facts of the 片② rename scenario: the old cloud path exists on
    // both sides again, the renamed local file is still a local-only file.
    const state = envelope({
      files: [{ id: "old", name: "old.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("old", "old.md")],
    });
    const candidate = build({
      state,
      localFiles: [
        localFile("old.md"),
        localFile("renamed-new-path.md"),
      ],
    });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual(["upload:renamed-new-path.md"]);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([]);
  });

  it("never plans an upload for a local-only file without a baseline, and no remote-side file or folder writes", async () => {
    const state = envelope({ folderAnchors: [] });
    const candidate = build({
      state,
      localFiles: [localFile("local-only.md")],
    });
    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(twoWay.items.map((item) => item.type))
      .toEqual([SyncActionType.Upload]);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([]);
    expect(oneWay.baseUpserts).toEqual([]);

    const facts = mixedOutboundFacts();
    const mixedOneWay = await finalizeCanonicalPlan({
      candidate: build(facts),
      envelope: facts.state,
      direction: "one-way",
    });
    for (const type of [
      SyncActionType.DeleteRemote,
      SyncActionType.RenameRemote,
      SyncActionType.CreateRemoteFolder,
      SyncActionType.MoveRemoteFolder,
      SyncActionType.DeleteRemoteFolder,
    ]) {
      expect(mixedOneWay.items.filter((item) => item.type === type)).toEqual([]);
    }
  });

  it("forces the remote delete follow in one-way mode even with the default policy", async () => {
    const state = envelope({
      files: [],
      folderAnchors: [],
      fileAnchors: [fileAnchor("removed", "removed.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("removed.md")],
    });

    const twoWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      policy: { ...TWO_WAY_POLICY },
    });
    expect(twoWay.items.map((item) => item.type))
      .toEqual([SyncActionType.ConfirmLocalDelete]);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
      policy: { ...TWO_WAY_POLICY },
    });
    expect(oneWay.items.map((item) => item.type))
      .toEqual([SyncActionType.DeleteLocal]);
    expect(oneWay.items[0].decisionToken).toBeUndefined();

    // The explicit two-way policy keeps today's confirmation row.
    const twoWayForced = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      policy: { ...FORCED_FOLLOW_POLICY },
    });
    expect(twoWayForced.items.map((item) => item.type))
      .toEqual([SyncActionType.DeleteLocal]);
  });

  it("keeps suppressed actions out of the plan review impact count", async () => {
    const facts = mixedOutboundFacts();
    const candidate = build(facts);
    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: facts.state });
    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: facts.state,
      direction: "one-way",
    });

    const twoWayReview = summarizeCanonicalPlanReviewV2(twoWay.items);
    const oneWayReview = summarizeCanonicalPlanReviewV2(oneWay.items);
    expect(oneWayReview.impactCount).toBeLessThan(twoWayReview.impactCount);
    // Only the surviving (inbound) actions count in one-way mode; 片② 把本机改与
    // 两端都改换成"留副本＋云端接管"的下载，因此它们仍计入审阅影响（取代原先
    // 的 upload 计数与不计入的 conflict 行）。
    expect(twoWayReview.impactCount).toBe(5);
    expect(oneWayReview.impactCount).toBe(4);
    expect(oneWayReview.counts.uploads).toBe(0);
    expect(oneWayReview.counts.deletes).toBe(0);
    expect(oneWayReview.counts.downloads).toBe(4);
    expect(twoWayReview.counts.uploads).toBe(2);
  });

  it("binds no decision token to a suppressed action", async () => {
    const state = envelope({
      files: [
        { id: "edited", name: "edited.md" },
        { id: "conflict", name: "conflict.md", hash: hashC, size: 30 },
      ],
      folderAnchors: [],
      fileAnchors: [
        fileAnchor("edited", "edited.md"),
        fileAnchor("conflict", "conflict.md"),
      ],
    });
    const candidate = build({
      state,
      localFiles: [
        localFile("edited.md", hashB),
        localFile("conflict.md", hashB, 20),
      ],
    });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual([
      "upload:edited.md",
      "conflict:conflict.md",
    ]);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    // 片② 后两条都不再是 Conflict/Upload，而是"留副本＋云端接管"的下载；决策
    // 令牌只绑 Conflict／ConfirmLocalDelete，因此这里一条令牌都不该残留（抑制
    // 与改写都发生在 bindCanonicalDecisionTokensV2 之前）。
    expect(itemKeys(oneWay.items)).toEqual([
      "download:edited.md",
      "download:conflict.md",
    ]);
    expect(
      oneWay.items.filter((item) => item.decisionToken !== undefined),
    ).toEqual([]);
    expect(oneWay.items.map((item) => item.localOnlyCopyKind))
      .toEqual(["edited", "edited"]);
  });

  it("keeps the three excluded blocks on their two-way output", async () => {
    const stateWithNote: SyncStateEnvelopeV2 = envelope({
      folders: [
        { id: "obsidian", name: ".obsidian" },
        { id: "plugins", name: "plugins", parentId: "obsidian" },
        { id: "easy-sync", name: "easy-sync", parentId: "plugins" },
        { id: "calendar", name: "calendar", parentId: "plugins" },
      ],
      files: [
        { id: "app", name: "app.json", parentId: "obsidian" },
        { id: "self-main", name: "main.js", parentId: "easy-sync" },
        { id: "calendar-main", name: "main.js", parentId: "calendar" },
        { id: "note", name: "note.md" },
      ],
      folderAnchors: [
        folderAnchor("obsidian", ".obsidian"),
        folderAnchor("plugins", ".obsidian/plugins", "obsidian"),
        folderAnchor("easy-sync", ".obsidian/plugins/easy-sync", "plugins"),
        folderAnchor("calendar", ".obsidian/plugins/calendar", "plugins"),
      ],
      fileAnchors: [
        fileAnchor("app", ".obsidian/app.json"),
        fileAnchor("self-main", ".obsidian/plugins/easy-sync/main.js"),
        fileAnchor("calendar-main", ".obsidian/plugins/calendar/main.js"),
        fileAnchor("note", "note.md"),
      ],
    });
    const candidate = build({
      state: stateWithNote,
      localFiles: [
        localFile(".obsidian/app.json", hashB),
        localFile(".obsidian/plugins/easy-sync/main.js", hashB),
        localFile(".obsidian/plugins/calendar/main.js", hashB),
        localFile("note.md", hashB),
      ],
      localFolders: localFolders(
        ".obsidian",
        ".obsidian/plugins",
        ".obsidian/plugins/easy-sync",
        ".obsidian/plugins/calendar",
      ),
    });

    const twoWay = await finalizeCanonicalPlan({
      candidate,
      envelope: stateWithNote,
    });
    expect(itemKeys(twoWay.items)).toEqual([
      "upload:.obsidian/app.json",
      "upload:.obsidian/plugins/easy-sync/main.js",
      "upload:.obsidian/plugins/calendar/main.js",
      "upload:note.md",
    ]);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: stateWithNote,
      direction: "one-way",
    });
    // The three excluded blocks keep their two-way output (片② 的"留副本＋接管"
    // 改写同样不落在它们身上)，普通笔记改成留副本＋云端接管。
    expect(itemKeys(oneWay.items)).toEqual([
      "upload:.obsidian/app.json",
      "upload:.obsidian/plugins/easy-sync/main.js",
      "upload:.obsidian/plugins/calendar/main.js",
      "download:note.md",
    ]);
    expect(oneWay.items.map((item) => item.localOnlyCopyKind))
      .toEqual([undefined, undefined, undefined, "edited"]);

    // Folder actions inside the excluded subtrees (EasySync bundle dir and
    // community-plugin dirs) keep their two-way output too.
    const fileEntry = localFile("x.md");
    const folderCrafted = craftedCandidate([
      {
        type: SyncActionType.Upload,
        path: ".obsidian/plugins/easy-sync/styles.css",
        local: fileEntry,
      },
      {
        type: SyncActionType.CreateRemoteFolder,
        path: ".obsidian/plugins/easy-sync",
        folder: { parentRemoteId: "plugins", parentPath: ".obsidian/plugins" },
      },
      {
        type: SyncActionType.CreateRemoteFolder,
        path: ".obsidian/plugins/calendar",
        folder: { parentRemoteId: "plugins", parentPath: ".obsidian/plugins" },
      },
      {
        type: SyncActionType.DeleteRemote,
        path: ".obsidian/appearance.json",
        remote: remoteFile(".obsidian/appearance.json", "appearance"),
      },
      // 片② 的"拉回"改写也不落在排除三块上：排除块的本机删除仍按双向处理。
      {
        type: SyncActionType.DeleteRemote,
        path: ".obsidian/app.json",
        remote: remoteFile(".obsidian/app.json", "app"),
        reason: "reason.fileDeletedLocally",
      },
      {
        type: SyncActionType.Conflict,
        path: ".obsidian/plugins/calendar/main.js",
        remote: remoteFile(".obsidian/plugins/calendar/main.js", "calendar-main"),
        reason: "reason.localDeletedRemoteModified",
      },
      {
        type: SyncActionType.DeleteRemoteFolder,
        path: ".obsidian/plugins/calendar",
        folder: { remoteId: "calendar", parentPath: ".obsidian/plugins" },
      },
    ]);
    const folderOneWay = await finalizeCanonicalPlan({
      candidate: folderCrafted.candidate,
      envelope: folderCrafted.envelope,
      direction: "one-way",
    });
    expect(itemKeys(folderOneWay.items)).toEqual(
      itemKeys(folderCrafted.candidate.items),
    );
  });

  it("keeps every inbound action identical to two-way", async () => {
    const state = envelope({
      folders: [{ id: "cloud-new", name: "cloud-new" }],
      files: [{ id: "remote-only", name: "remote-only.md", hash: hashB }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("removed", "removed.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("removed.md")],
    });

    const twoWayForced = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      policy: { ...FORCED_FOLLOW_POLICY },
    });
    const twoWayTypes = twoWayForced.items.map((item) => item.type);
    expect(twoWayTypes).toContain(SyncActionType.Download);
    expect(twoWayTypes).toContain(SyncActionType.CreateLocalFolder);
    expect(twoWayTypes).toContain(SyncActionType.DeleteLocal);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
      policy: { ...TWO_WAY_POLICY },
    });
    expect(itemKeys(oneWay.items)).toEqual(itemKeys(twoWayForced.items));

    // Against the default two-way policy the only difference is the forced
    // delete follow: ConfirmLocalDelete becomes DeleteLocal.
    const twoWayDefault = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      policy: { ...TWO_WAY_POLICY },
    });
    expect(itemKeys(twoWayDefault.items)).toContain(
      `confirmLocalDelete:removed.md`,
    );
    expect(itemKeys(oneWay.items)).toEqual(
      itemKeys(twoWayDefault.items).map((key) =>
        key === "confirmLocalDelete:removed.md"
          ? `deleteLocal:removed.md`
          : key,
      ),
    );
  });

  it("forces the folder delete follow in one-way mode instead of keeping the confirm marker", async () => {
    // Remote still owns "notes"; the two nested folders were deleted on another
    // device while this device still has them.
    const state = envelope({
      folders: [{ id: "notes", name: "notes" }],
      folderAnchors: [
        folderAnchor("notes", "notes"),
        folderAnchor("notes-sub", "notes/sub", "notes"),
        folderAnchor("notes-sub-inner", "notes/sub/inner", "notes-sub"),
      ],
    });
    const candidate = build({
      state,
      localFiles: [],
      localFolders: localFolders("notes", "notes/sub", "notes/sub/inner"),
    });
    const expectedKeys = [
      "deleteLocalFolder:notes/sub/inner",
      "deleteLocalFolder:notes/sub",
    ];

    // Two-way keeps today's marker (the planner's autoDeleteLocalFiles switch
    // is off), for the default and for the explicit direction alike.
    for (const direction of [undefined, "two-way"] as const) {
      const twoWay = await finalizeCanonicalPlan({
        candidate,
        envelope: state,
        ...(direction === undefined ? {} : { direction }),
      });
      expect(itemKeys(twoWay.items)).toEqual(expectedKeys);
      expect(
        twoWay.items.map((item) => item.requiresConfirmation),
      ).toEqual([true, true]);
    }

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    // Same inbound actions, but the follow is forced: no confirm marker left.
    expect(itemKeys(oneWay.items)).toEqual(expectedKeys);
    expect(
      oneWay.items.map((item) => item.requiresConfirmation),
    ).toEqual([false, false]);
  });

  it("keeps the local edit as a copy directive and lets the cloud version take over", async () => {
    const state = envelope({
      files: [{ id: "edited", name: "edited.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("edited", "edited.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("edited.md", hashB)],
    });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual(["upload:edited.md"]);
    expect(twoWay.items[0].localOnlyCopyKind).toBeUndefined();

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "edited.md",
        local: expect.objectContaining({ hash: hashB, size: 10 }),
        remote: expect.objectContaining({ driveId: "edited" }),
        localOnlyCopyKind: "edited",
      }),
    ]);
    expect(oneWay.items[0].reason).toBeUndefined();
    expect(oneWay.items[0].baseEtag).toBeUndefined();
  });

  it("redirects a both-sides-modified conflict into the same copy-and-take-over action", async () => {
    const facts = mixedOutboundFacts();
    const candidate = build(facts);
    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: facts.state,
      direction: "one-way",
    });

    expect(
      oneWay.items.filter((item) => item.type === SyncActionType.Conflict),
    ).toEqual([]);
    expect(
      oneWay.items.filter((item) => item.path === "conflict.md"),
    ).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        localOnlyCopyKind: "edited",
        local: expect.objectContaining({
          path: "conflict.md",
          size: 20,
        }),
        remote: expect.objectContaining({ path: "conflict.md", size: 30 }),
      }),
    ]);
    // The remote version really did change: the local copy keeps 20 bytes, the
    // cloud version (30 bytes) takes the path over.
    expect(itemKeys(oneWay.items)).toContain("download:conflict.md");
  });

  it("redirects a no-baseline same-name pair into the same action", async () => {
    const state = envelope({
      files: [{ id: "same", name: "same.md", hash: hashC, size: 30 }],
      folderAnchors: [],
    });
    const candidate = build({
      state,
      localFiles: [localFile("same.md", hashB, 20)],
    });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual(["conflict:same.md"]);
    expect(twoWay.items[0].reason).toBe("reason.newFileBothSides");

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "same.md",
        localOnlyCopyKind: "new-file-both-sides",
        local: expect.objectContaining({ hash: hashB, size: 20 }),
        remote: expect.objectContaining({ driveId: "same", size: 30 }),
      }),
    ]);
  });

  it("keeps the remote-deleted-local-modified conflict manual in one-way mode", async () => {
    const state = envelope({
      files: [],
      folderAnchors: [],
      fileAnchors: [fileAnchor("removed", "removed.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("removed.md", hashB)],
    });

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: "removed.md",
        reason: "reason.remoteDeletedLocalModified",
        local: expect.objectContaining({ hash: hashB }),
      }),
    ]);
    expect(oneWay.items[0].remote).toBeUndefined();
    // No automatic copy/restore for this shape, in either direction.
    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual(
      itemKeys(oneWay.items).map((key) => key.replace("Conflict", "Conflict")),
    );
    expect(oneWay.items[0].localOnlyCopyKind).toBeUndefined();
    expect(twoWay.items[0].localOnlyCopyKind).toBeUndefined();
  });

  it("pulls a locally deleted file back from the cloud in one-way mode", async () => {
    // Remote unchanged, ancestor exists, no local copy: two-way deletes the
    // cloud file; one-way must bring the cloud version back instead.
    const state = envelope({
      files: [{ id: "gone", name: "gone.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("gone", "gone.md")],
    });
    const candidate = build({ state, localFiles: [] });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual(["deleteRemote:gone.md"]);
    expect(twoWay.items[0].reason).toBe("reason.fileDeletedLocally");

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "gone.md",
        remote: expect.objectContaining({ driveId: "gone" }),
      }),
    ]);
    expect(oneWay.items[0].local).toBeUndefined();
    expect(oneWay.items[0].localOnlyCopyKind).toBeUndefined();
  });

  it("pulls a locally deleted file back when the cloud changed it", async () => {
    const state = envelope({
      files: [{ id: "gone", name: "gone.md", hash: hashC, size: 30 }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("gone", "gone.md", hashA, 10)],
    });
    const candidate = build({ state, localFiles: [] });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual(["conflict:gone.md"]);
    expect(twoWay.items[0].reason).toBe("reason.localDeletedRemoteModified");

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "gone.md",
        remote: expect.objectContaining({ driveId: "gone", size: 30 }),
      }),
    ]);
    expect(oneWay.items[0].localOnlyCopyKind).toBeUndefined();
  });

  it("pulls the old cloud path back when the local file was renamed away", async () => {
    const state = envelope({
      files: [{ id: "old", name: "old.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("old", "old.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("copy-1.md", hashA), localFile("copy-2.md", hashA)],
    });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual([
      "upload:copy-1.md",
      "upload:copy-2.md",
    ]);
    expect(twoWay.items).not.toContainEqual(expect.objectContaining({
      type: SyncActionType.Conflict,
      reason: "reason.renameIdentityAmbiguous",
    }));

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    // 旧路径拉回；重命名后的两个纯本机文件留在原地（片③ 的"本机新建保留"），
    // 本片不给它们造条目、更不留副本。
    expect(oneWay.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "old.md",
        remote: expect.objectContaining({ driveId: "old" }),
      }),
    ]);
    expect(oneWay.items[0].localOnlyCopyKind).toBeUndefined();
  });

  it("recreates a remote folder whose local copy was deleted", async () => {
    const state = envelope({
      folders: [{ id: "notes", name: "notes" }],
      folderAnchors: [folderAnchor("notes", "notes")],
    });
    const folderGone = build({ state, localFiles: [] });

    const twoWay = await finalizeCanonicalPlan({
      candidate: folderGone,
      envelope: state,
    });
    expect(itemKeys(twoWay.items)).toEqual(["deleteRemoteFolder:notes"]);

    const oneWay = await finalizeCanonicalPlan({
      candidate: folderGone,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.CreateLocalFolder,
        path: "notes",
        folder: expect.objectContaining({
          remoteId: "notes",
          parentPath: "",
        }),
      }),
    ]);

    // 第二轮不循环：本机目录回来后两个方向都没有动作。
    const folderBack = build({
      state,
      localFiles: [],
      localFolders: localFolders("notes"),
    });
    for (const direction of [undefined, "one-way"] as const) {
      const settled = await finalizeCanonicalPlan({
        candidate: folderBack,
        envelope: state,
        ...(direction === undefined ? {} : { direction }),
      });
      expect(settled.items).toEqual([]);
    }
  });

  it("recreates a remote folder with content whose local copy was deleted", async () => {
    const state = envelope({
      folders: [{ id: "notes", name: "notes" }],
      files: [{ id: "note", name: "note.md", parentId: "notes" }],
      folderAnchors: [folderAnchor("notes", "notes")],
      fileAnchors: [fileAnchor("note", "notes/note.md")],
    });
    const candidate = build({ state, localFiles: [] });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items)).toEqual([
      "deleteRemote:notes/note.md",
      "deleteRemoteFolder:notes",
    ]);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    // 文件靠下载拉回（父目录由下载路径自动重建），空目录形态另由创建补齐。
    expect(itemKeys(oneWay.items)).toEqual([
      "download:notes/note.md",
      "createLocalFolder:notes",
    ]);
  });

  it("suppresses exactly the six outbound types and leaves every other type in place", async () => {
    const { candidate, envelope: state } = craftedCandidate([
      { type: SyncActionType.Upload, path: "up.md", local: localFile("up.md") },
      {
        type: SyncActionType.DeleteRemote,
        path: "del-remote.md",
        remote: remoteFile("del-remote.md", "del-remote"),
      },
      {
        type: SyncActionType.RenameRemote,
        path: "renamed.md",
        renameFrom: "old.md",
        local: localFile("renamed.md"),
        remote: remoteFile("old.md", "old"),
      },
      {
        type: SyncActionType.CreateRemoteFolder,
        path: "out-folder",
        folder: { parentRemoteId: "root", parentPath: "" },
      },
      {
        type: SyncActionType.MoveRemoteFolder,
        path: "moved-folder",
        renameFrom: "moved-folder-old",
        folder: { remoteId: "folder-moved", parentPath: "" },
      },
      {
        type: SyncActionType.DeleteRemoteFolder,
        path: "deleted-folder",
        folder: { remoteId: "folder-deleted", parentPath: "" },
      },
      {
        type: SyncActionType.Download,
        path: "down.md",
        remote: remoteFile("down.md", "down"),
      },
      {
        type: SyncActionType.DeleteLocal,
        path: "del-local.md",
        local: localFile("del-local.md"),
      },
      {
        type: SyncActionType.CreateLocalFolder,
        path: "in-folder",
        folder: { remoteId: "folder-in", parentPath: "" },
      },
      {
        type: SyncActionType.MoveLocalFolder,
        path: "moved-in-folder",
        renameFrom: "moved-in-folder-old",
        folder: { remoteId: "folder-moved-in", parentPath: "" },
      },
      {
        type: SyncActionType.MoveLocalFile,
        path: "moved.md",
        renameFrom: "moved-old.md",
        local: localFile("moved.md"),
      },
      {
        type: SyncActionType.ConfirmLocalDelete,
        path: "confirm.md",
        local: localFile("confirm.md"),
      },
      {
        type: SyncActionType.Conflict,
        path: "conflict.md",
        local: localFile("conflict.md", hashB, 20),
        remote: remoteFile("conflict.md", "conflict", hashC, 30),
        reason: "reason.bothSidesModified",
      },
      {
        type: SyncActionType.Conflict,
        path: "conflict-manual.md",
        local: localFile("conflict-manual.md", hashB, 20),
        reason: "reason.remoteDeletedLocalModified",
      },
      {
        type: SyncActionType.SkipLargeFile,
        path: "large.bin",
        reason: "reason.fileExceedsSizeLimit",
      },
      { type: SyncActionType.RetryLater, path: "retry.md" },
      { type: SyncActionType.AuthExpired, path: "" },
      {
        type: SyncActionType.RecreateRemoteScope,
        path: ".obsidian/plugins/easy-sync/state/v2/state-v2.json",
      },
    ]);

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(twoWay.items.map((item) => item.type)).toEqual([
      SyncActionType.Upload,
      SyncActionType.DeleteRemote,
      SyncActionType.RenameRemote,
      SyncActionType.CreateRemoteFolder,
      SyncActionType.MoveRemoteFolder,
      SyncActionType.DeleteRemoteFolder,
      SyncActionType.Download,
      SyncActionType.DeleteLocal,
      SyncActionType.CreateLocalFolder,
      SyncActionType.MoveLocalFolder,
      SyncActionType.MoveLocalFile,
      SyncActionType.ConfirmLocalDelete,
      SyncActionType.Conflict,
      SyncActionType.Conflict,
      SyncActionType.SkipLargeFile,
      SyncActionType.RetryLater,
      SyncActionType.AuthExpired,
      SyncActionType.RecreateRemoteScope,
    ]);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(oneWay.items.map((item) => item.type)).toEqual([
      // 片②：本机删除的目录改成"重建本机目录"（复用同一 folder 事实）。
      SyncActionType.CreateLocalFolder,
      SyncActionType.Download,
      SyncActionType.DeleteLocal,
      SyncActionType.CreateLocalFolder,
      SyncActionType.MoveLocalFolder,
      SyncActionType.MoveLocalFile,
      SyncActionType.DeleteLocal,
      // 片②：bothSidesModified 改写成"留副本＋云端接管"的下载；
      // remoteDeletedLocalModified 保持人工冲突行。
      SyncActionType.Download,
      SyncActionType.Conflict,
      SyncActionType.SkipLargeFile,
      SyncActionType.RetryLater,
      SyncActionType.AuthExpired,
      SyncActionType.RecreateRemoteScope,
    ]);
    expect(oneWay.items[0]).toMatchObject({
      type: SyncActionType.CreateLocalFolder,
      path: "deleted-folder",
      folder: { remoteId: "folder-deleted", parentPath: "" },
    });
    expect(oneWay.items[6].path).toBe("confirm.md");
    expect(oneWay.items[7]).toMatchObject({
      path: "conflict.md",
      localOnlyCopyKind: "edited",
    });
    expect(oneWay.items[8]).toMatchObject({
      path: "conflict-manual.md",
      reason: "reason.remoteDeletedLocalModified",
    });
  });
});

describe("local-only copy label", () => {
  it("pins the copy label in both locales", () => {
    expect(zhCN["syncView.localOnly.copyLabel"]).toBe("副本");
    expect(en["syncView.localOnly.copyLabel"]).toBe("Copy");
  });

  it("pins the keep-on-device action label in both locales", () => {
    expect(zhCN["syncView.localOnly.keep"]).toBe("留在本机");
    expect(en["syncView.localOnly.keep"]).toBe("Keep on this device");
  });
});

describe("local-only copy records", () => {
  it("reduces entries commandedly and degrades corrupt storage to empty", () => {
    expect(readLocalOnlyCopiesV1(undefined)).toEqual({
      schemaVersion: 1,
      kind: "local-only-copies",
      entries: [],
      created: [],
    });
    for (const corrupt of [
      null,
      "nope",
      42,
      [],
      { schemaVersion: 2, kind: "local-only-copies", entries: [] },
      { schemaVersion: 1, kind: "something-else", entries: [] },
    ]) {
      expect(readLocalOnlyCopiesV1(corrupt)).toBeNull();
    }

    const entry: LocalOnlyCopyEntryV1 = {
      version: 1,
      path: "note.md",
      copyPath: "note（副本 2026-10-11 2345）.md",
      kind: "edited",
      recordedAt: 1,
    };
    const first = upsertLocalOnlyCopyEntryV1(
      readLocalOnlyCopiesV1(undefined),
      entry,
    );
    expect(first.entries).toEqual([entry]);
    // Same original path + same copy path is one record, not two.
    const repeated = upsertLocalOnlyCopyEntryV1(first, { ...entry, recordedAt: 9 });
    expect(repeated.entries).toEqual([{ ...entry, recordedAt: 9 }]);
    // A second copy of the same path is a second record ("可留多份").
    const second = upsertLocalOnlyCopyEntryV1(repeated, {
      ...entry,
      copyPath: "note（副本 2026-10-12 0830）.md",
      recordedAt: 2,
    });
    expect(second.entries.map((item) => item.copyPath)).toEqual([
      entry.copyPath,
      "note（副本 2026-10-12 0830）.md",
    ]);
    // Corrupt entries inside a valid container are dropped, never thrown on.
    expect(readLocalOnlyCopiesV1({
      schemaVersion: 1,
      kind: "local-only-copies",
      entries: [entry, { path: "x" }, null, { ...entry, copyPath: "" }],
    })?.entries).toEqual([entry]);
  });

  it("builds the documented copy name with a stable, collision-avoiding suffix", () => {
    const changedAt = new Date(2026, 9, 11, 23, 45, 59).getTime();
    expect(localOnlyCopyPathV1({
      path: "folder/note.md",
      label: "副本",
      changedAt,
    })).toBe("folder/note（副本 2026-10-11 2345）.md");
    expect(localOnlyCopyPathV1({
      path: "folder/note.md",
      label: "副本",
      changedAt,
      attempt: 1,
    })).toBe("folder/note（副本 2026-10-11 2345 2）.md");
    // No extension and dotfiles stay intact.
    expect(localOnlyCopyPathV1({
      path: "README",
      label: "副本",
      changedAt,
    })).toBe("README（副本 2026-10-11 2345）");
    expect(localOnlyCopyPathV1({
      path: ".gitignore",
      label: "副本",
      changedAt,
    })).toBe(".gitignore（副本 2026-10-11 2345）");
  });
});

describe("activation review wiring", () => {
  it("feeds the migration hold from the sealed plan and projects its items", () => {
    const read = (relative: string): string =>
      readFileSync(new URL(relative, import.meta.url), "utf8");

    // 审阅面（迁移 hold）的 items 只能来自"封存后的计划"：执行器把 seal 的结果
    // 写回 plan.items，再把同一个 plan 交给 stageV2MigrationHold。
    const executor = read("../src/sync/sync-executor.ts");
    expect(executor).toContain("plan.items = sealed.items;");
    expect(executor).toContain("await this.state.stageV2MigrationHold({");

    // 状态层强制"封存后的计划"，并按同一份 items 投影审阅行。
    const stateManager = read("../src/sync/state-manager.ts");
    expect(stateManager).toContain(
      "V2 migration hold requires a sealed canonical plan",
    );
    expect(stateManager).toContain("items: input.plan.items,");

    // 投影只做字段搬运，不新增类型、不过滤（单向模式下因此不会冒出上传行）。
    const holdStore = read("../src/sync/migration-hold-v2.ts");
    expect(holdStore).toContain("items: projectReviewItems(input.items),");
    expect(holdStore).toContain("function projectReviewItems(");
    const projection = holdStore.slice(
      holdStore.indexOf("function projectReviewItems("),
    );
    const projectionBody = projection.slice(0, projection.indexOf("\n}"));
    expect(projectionBody).toContain("items.map(");
    // 只搬字段：不按类型过滤，也不新增类别。
    expect(projectionBody).not.toContain(".filter(");
  });
});

describe("one-way suppression wiring", () => {
  it("keeps the outbound suppression predicate in the plan production chain only", () => {
    const read = (relative: string): string =>
      readFileSync(new URL(relative, import.meta.url), "utf8");

    const planSource = read("../src/sync/canonical-plan-v2.ts");
    expect(planSource).toContain("suppressOutboundUserContentActions");
    expect(planSource).toContain("applyOneWayLocalOnlyCopyPlan");
    expect(planSource).toContain("applyOneWayLocalDeletedPullBackPlan");

    const executorSource = read("../src/sync/sync-executor.ts");
    for (const planChainOnly of [
      "suppressOutboundUserContentActions",
      "applyOneWayLocalOnlyCopyPlan",
      "applyOneWayLocalDeletedPullBackPlan",
    ]) {
      expect(executorSource).not.toContain(planChainOnly);
    }
    // 侧栏动作入口只允许使用"哪些路径属于排除三块"的分面谓词（用于把排除块
    // 留在双向行为里），不得使用任何计划层改写/抑制。
    expect(executorSource).toContain("isExcludedFromOneWaySyncPath");

    // Side-action-shared recognizers must stay direction-agnostic: a mode
    // check inside them would also hit user-initiated actions.
    for (const relative of [
      "../src/sync/file-decision-planner-v2.ts",
      "../src/sync/local-scanner.ts",
      "../src/sync/community-plugin-deletion-boundary.ts",
    ]) {
      const source = read(relative);
      expect(source).not.toContain("syncDirection");
      expect(source).not.toContain("suppressOutboundUserContentActions");
    }
  });
});

describe("one-way local-only pipeline wiring", () => {
  it("reconciles once per one-way round from the pre-finalize candidate facts", () => {
    const executor = readFileSync(
      new URL("../src/sync/sync-executor.ts", import.meta.url),
      "utf8",
    );
    // 快照必须在 finalize 之前取：改写与抑制之后计划里就没有这个事实了。
    const snapshotAt = executor.indexOf("collectOneWayLocalOnlyPaths(plan.items");
    const sealAt = executor.indexOf("plan.items = sealed.items;");
    expect(snapshotAt).toBeGreaterThanOrEqual(0);
    expect(sealAt).toBeGreaterThan(snapshotAt);
    expect(executor).toContain('this.syncDirection === "one-way"');
    expect(executor).toContain(
      "reconcileLocalOnlyEntries(localOnlyPathsForReview)",
    );
    // 上传动作：路径式（不带版本锁）＋成功后条目退场＋成功 Notice。
    const action = executor.slice(
      executor.indexOf("async uploadLocalOnlyEntry("),
      executor.indexOf("async resolveConflictKeepLocal("),
    );
    expect(action).toContain('this.syncDirection !== "one-way"');
    expect(action).toContain("this.onedrive.uploadFile(");
    expect(action).toContain('expectedRemote: { exists: false }');
    expect(action).toContain("retireLocalOnlyEntries({");
    expect(action).toContain('this.notice("notice.localOnly.uploaded"');
    // 父目录链只在用户主动上传时创建：整仓唯一调用点就在这个动作里，
    // 自动轮次（计划执行）不得建目录。
    const chainCalls = executor.match(
      /ensureRemoteParentChainForLocalOnlyUpload\(/g,
    ) ?? [];
    expect(chainCalls).toHaveLength(2); // 定义 + 唯一调用
    expect(action).toContain(
      "this.ensureRemoteParentChainForLocalOnlyUpload(",
    );
    expect(action).toContain("const parentsReady =");
    // 目录链走现役目录 mutation（父目录必须先进 V2 索引，文件收据才成立）。
    expect(executor).toContain("folderMutationCheckpoint(");
    expect(executor).toContain("createFolderMutationIntent({");
    expect(executor).toContain("createFolderPath(this.vaultName, path)");
  });

  it("keeps the ignore memory out of the sync chain", () => {
    // 忽略只影响提醒：执行器、记录族与方向策略都不认识这份记忆。
    for (const relative of [
      "../src/sync/sync-executor.ts",
      "../src/sync/local-only-copies.ts",
      "../src/sync/sync-direction.ts",
    ]) {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      expect(source).not.toContain("localOnlyIgnoreMemory");
      expect(source).not.toContain("ignoredPaths");
      expect(source).not.toContain("isLocalOnlyPathIgnored");
    }
    // 过滤只发生在单一真源（行投影）里。
    const main = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    const accessor = main.slice(
      main.indexOf("getLocalOnlyRows():"),
      main.indexOf("ignoreLocalOnlyEntry("),
    );
    expect(accessor).toContain(
      "isLocalOnlyPathIgnored(memory, entry.targetPath)",
    );
  });

  it("keeps one record family as the only source for rows and counts", () => {
    const main = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    const accessor = main.slice(
      main.indexOf("getLocalOnlyRows():"),
      main.indexOf("getLocalOnlyEntryCount():"),
    );
    expect(accessor).toContain('this.syncDirection !== "one-way"');
    expect(accessor).toContain("projectLocalOnlyEntryRowsV1({");
    expect(main).toContain("this.getLocalOnlyEntryCount()");
    const view = readFileSync(
      new URL("../src/ui/sync-view.ts", import.meta.url),
      "utf8",
    );
    // 侧栏不自己读记录、不扫盘、不建第二份列表：只消费插件暴露的那一份投影。
    // 收窄：该句在视图文件里两处出现（渲染主流程与待处理区）——两处都要钉住。
    const renderBody = functionBody(view, "private doRender(): void");
    const pendingBody = functionBody(view, "private renderPendingSection(");
    expect(renderBody).toContain("localOnlyRows: this.plugin.getLocalOnlyRows()");
    expect(pendingBody).toContain("localOnlyRows: this.plugin.getLocalOnlyRows()");
    expect(view).not.toContain("localOnlyCopyEntries");
  });
});

describe("local-only sidebar rows", () => {
  it("collects exactly the non-excluded local-only uploads of a one-way round", () => {
    const configDir = ".obsidian";
    const items: SyncPlanItem[] = [
      // 无基线、云端没有：planner 的无基线本机独有分支。
      { type: SyncActionType.Upload, path: "new-note.md", local: localFile("new-note.md") },
      { type: SyncActionType.Upload, path: "copy（副本 2026-10-11 2345）.md", local: localFile("x.md") },
      // 有基线（带 remote＋baseEtag）的本机改：不算本机独有。
      {
        type: SyncActionType.Upload,
        path: "edited.md",
        local: localFile("edited.md", hashB),
        remote: remoteFile("edited.md", "edited"),
        baseEtag: "etag-edited",
      },
      // 排除三块继续按双向运行。
      {
        type: SyncActionType.Upload,
        path: ".obsidian/plugins/calendar/main.js",
        local: localFile(".obsidian/plugins/calendar/main.js"),
      },
      // 其它类型不参与。
      { type: SyncActionType.Download, path: "down.md", remote: remoteFile("down.md", "down") },
      { type: SyncActionType.Conflict, path: "c.md", local: localFile("c.md"), remote: remoteFile("c.md", "c") },
    ];
    const collected = collectOneWayLocalOnlyPaths(items, configDir);
    expect([...collected].sort()).toEqual([
      "copy（副本 2026-10-11 2345）.md",
      "new-note.md",
    ]);
    expect(isExcludedFromOneWaySyncPath(".obsidian/plugins/calendar/main.js", configDir))
      .toBe(true);
  });

  it("projects one row per record: copies keep the original path, created files themselves", () => {
    const copy: LocalOnlyCopyEntryV1 = {
      version: 1,
      path: "note.md",
      copyPath: "note（副本 2026-10-11 2345）.md",
      kind: "edited",
      recordedAt: 1,
    };
    const rows = projectLocalOnlyEntryRowsV1({
      copies: [copy],
      created: [
        { version: 1, path: "new-note.md", recordedAt: 2 },
        // 副本路径不得重复登记为本机新建。
        { version: 1, path: copy.copyPath, recordedAt: 3 },
      ],
    });
    expect(rows).toEqual([
      {
        kind: "edited",
        path: "note.md",
        targetPath: "note（副本 2026-10-11 2345）.md",
      },
      { kind: "created", path: "new-note.md", targetPath: "new-note.md" },
    ]);
  });

  it("reconciles the record family from the round's local-only paths", () => {
    const copy: LocalOnlyCopyEntryV1 = {
      version: 1,
      path: "note.md",
      copyPath: "note（副本 2026-10-11 2345）.md",
      kind: "edited",
      recordedAt: 1,
    };
    const family = { ...emptyLocalOnlyCopiesV1(), entries: [copy] };

    // 副本仍是本机独有：记录保留；新建类＝本机独有路径里不属于副本的那些。
    const first = reconcileLocalOnlyEntriesV1(family, {
      localOnlyPaths: new Set([copy.copyPath, "new-note.md"]),
      now: 10,
    });
    expect(first.entries).toEqual([copy]);
    expect(first.created).toEqual([
      { version: 1, path: "new-note.md", recordedAt: 10 },
    ]);

    // 同一事实再核一次：时间戳保留，不重写。
    const again = reconcileLocalOnlyEntriesV1(first, {
      localOnlyPaths: new Set([copy.copyPath, "new-note.md"]),
      now: 20,
    });
    expect(again.created).toEqual(first.created);

    // 副本被上传（不再本机独有）：记录退场，只留新建类。
    const uploaded = reconcileLocalOnlyEntriesV1(again, {
      localOnlyPaths: new Set(["new-note.md"]),
      now: 30,
    });
    expect(uploaded.entries).toEqual([]);
    expect(uploaded.created.map((entry) => entry.path)).toEqual(["new-note.md"]);

    // 新建文件消失：整条退场；上传成功后按路径退场。
    const gone = reconcileLocalOnlyEntriesV1(uploaded, {
      localOnlyPaths: new Set(),
      now: 40,
    });
    expect(gone.created).toEqual([]);
    expect(retireLocalOnlyEntriesV1(first, {
      paths: ["new-note.md"],
    }).created).toEqual([]);
    expect(retireLocalOnlyEntriesV1(first, {
      copyPaths: [copy.copyPath],
    }).entries).toEqual([]);
  });

  it("keeps the created class out of the record when it is a copy", () => {
    const copy: LocalOnlyCopyEntryV1 = {
      version: 1,
      path: "note.md",
      copyPath: "note（副本 2026-10-11 2345）.md",
      kind: "new-file-both-sides",
      recordedAt: 1,
    };
    const family = reconcileLocalOnlyEntriesV1(
      { ...emptyLocalOnlyCopiesV1(), entries: [copy] },
      {
        localOnlyPaths: new Set([copy.copyPath, "other-new.md"]),
        now: 10,
      },
    );
    expect(family.entries).toEqual([copy]);
    expect(family.created.map((entry) => entry.path)).toEqual(["other-new.md"]);
  });
});

/**
 * 2026-10-12 review 修正：配置白名单的成员面＝六个受管配置文件 **加上**
 * `<configDir>/themes/`、`<configDir>/snippets/`（功能矩阵的「主题与代码片段」
 * owner，与其它配置项同处一个设置界面）。用户可见承诺＝「本模式只作用于笔记与
 * 附件；插件与其他配置不受影响，继续照常同步」，因此这两个目录在单向模式下必须
 * 保持双向输出：写入方向不被抑制、不出副本、不进本机独有清单，云端删除也不被
 * 模式统一强制跟随。
 */
describe("one-way config whitelist directory owners (themes/ snippets/)", () => {
  const configDir = ".obsidian";

  it("recognizes the whole config-whitelist owner surface", () => {
    const expected: ReadonlyArray<readonly [string, boolean]> = [
      [".obsidian/app.json", true],
      [".obsidian/appearance.json", true],
      [".obsidian/hotkeys.json", true],
      [".obsidian/core-plugins.json", true],
      [".obsidian/community-plugins.json", true],
      [".obsidian/bookmarks.json", true],
      // 「主题与代码片段」owner：目录本身与后代都算配置面。
      [".obsidian/themes", true],
      [".obsidian/themes/MyTheme", true],
      [".obsidian/themes/MyTheme/theme.css", true],
      [".obsidian/snippets", true],
      [".obsidian/snippets/my-snippet.css", true],
      // 社区插件与自同步照旧。
      [".obsidian/plugins/calendar/main.js", true],
      [".obsidian/plugins/easy-sync/styles.css", true],
      // 邻近但不在白名单内的对象仍是内容面/未授权面。
      [".obsidian/workspace.json", false],
      ["note.md", false],
      ["themes/note.md", false],
      ["snippets/note.md", false],
    ];
    for (const [path, excluded] of expected) {
      expect([path, isExcludedFromOneWaySyncPath(path, configDir)])
        .toEqual([path, excluded]);
    }
  });

  it("keeps an edited theme CSS on its two-way upload in one-way mode", async () => {
    const state = envelope({
      folders: [
        { id: "obsidian", name: ".obsidian" },
        { id: "themes", name: "themes", parentId: "obsidian" },
        { id: "mytheme", name: "MyTheme", parentId: "themes" },
      ],
      files: [{ id: "css", name: "theme.css", parentId: "mytheme" }],
      folderAnchors: [
        folderAnchor("obsidian", ".obsidian"),
        folderAnchor("themes", ".obsidian/themes", "obsidian"),
        folderAnchor("mytheme", ".obsidian/themes/MyTheme", "themes"),
      ],
      fileAnchors: [fileAnchor("css", ".obsidian/themes/MyTheme/theme.css")],
    });
    const candidate = build({
      state,
      localFiles: [localFile(".obsidian/themes/MyTheme/theme.css", hashB)],
      localFolders: localFolders(
        ".obsidian",
        ".obsidian/themes",
        ".obsidian/themes/MyTheme",
      ),
    });

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    expect(itemKeys(oneWay.items))
      .toEqual(["upload:.obsidian/themes/MyTheme/theme.css"]);
    expect(oneWay.items[0].localOnlyCopyKind).toBeUndefined();
    expect(collectOneWayLocalOnlyPaths(candidate.items, configDir).size).toBe(0);
  });

  it("keeps a new snippet and a new theme folder on their two-way output", async () => {
    const state = envelope({
      folders: [
        { id: "obsidian", name: ".obsidian" },
        { id: "snippets", name: "snippets", parentId: "obsidian" },
        { id: "themes", name: "themes", parentId: "obsidian" },
      ],
      folderAnchors: [
        folderAnchor("obsidian", ".obsidian"),
        folderAnchor("snippets", ".obsidian/snippets", "obsidian"),
        folderAnchor("themes", ".obsidian/themes", "obsidian"),
      ],
    });
    const candidate = build({
      state,
      localFiles: [localFile(".obsidian/snippets/new.css", hashB)],
      localFolders: localFolders(
        ".obsidian",
        ".obsidian/snippets",
        ".obsidian/themes",
        ".obsidian/themes/NewTheme",
      ),
    });

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    // 与双向输出逐项相同（含顺序）：新建片段照常上传、新建主题目录照常建远端。
    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(oneWay.items)).toEqual(itemKeys(twoWay.items));
    expect(itemKeys(oneWay.items).sort()).toEqual([
      "createRemoteFolder:.obsidian/themes/NewTheme",
      "upload:.obsidian/snippets/new.css",
    ]);
    // 本机独有清单也不收配置面路径（不出侧栏条目）。
    expect([...collectOneWayLocalOnlyPaths(candidate.items, configDir)].sort())
      .toEqual([]);
  });

  it("keeps themes/snippets out of the forced remote-delete follow", async () => {
    const state = envelope({
      files: [],
      folderAnchors: [],
      fileAnchors: [
        fileAnchor("css", ".obsidian/themes/MyTheme/theme.css"),
        fileAnchor("snippet", ".obsidian/snippets/old.css"),
        fileAnchor("note", "removed.md"),
      ],
    });
    const candidate = build({
      state,
      localFiles: [
        localFile(".obsidian/themes/MyTheme/theme.css"),
        localFile(".obsidian/snippets/old.css"),
        localFile("removed.md"),
      ],
    });

    const twoWay = await finalizeCanonicalPlan({ candidate, envelope: state });
    expect(itemKeys(twoWay.items).sort()).toEqual([
      "confirmLocalDelete:.obsidian/snippets/old.css",
      "confirmLocalDelete:.obsidian/themes/MyTheme/theme.css",
      "confirmLocalDelete:removed.md",
    ]);

    const oneWay = await finalizeCanonicalPlan({
      candidate,
      envelope: state,
      direction: "one-way",
    });
    // 配置面保留双向的确认行；普通笔记仍按模式强制跟随。
    expect(itemKeys(oneWay.items).sort()).toEqual([
      "confirmLocalDelete:.obsidian/snippets/old.css",
      "confirmLocalDelete:.obsidian/themes/MyTheme/theme.css",
      "deleteLocal:removed.md",
    ]);
  });

  it("keeps the folder delete confirmation marker on config-whitelist paths", async () => {
    const fileEntry = localFile("x.md");
    const crafted = craftedCandidate([
      {
        type: SyncActionType.DeleteLocalFolder,
        path: ".obsidian/themes/OldTheme",
        folder: { remoteId: "old", parentPath: ".obsidian/themes" },
        requiresConfirmation: true,
      },
      {
        type: SyncActionType.DeleteLocalFolder,
        path: "Notes",
        folder: { remoteId: "notes", parentPath: "" },
        requiresConfirmation: true,
      },
      {
        type: SyncActionType.DeleteRemoteFolder,
        path: ".obsidian/snippets",
        folder: {
          remoteId: "snippets",
          parentRemoteId: "obsidian",
          parentPath: ".obsidian",
        },
      },
      {
        type: SyncActionType.DeleteRemote,
        path: ".obsidian/themes/MyTheme/theme.css",
        remote: remoteFile(".obsidian/themes/MyTheme/theme.css", "css"),
      },
      {
        type: SyncActionType.Upload,
        path: ".obsidian/snippets/new.css",
        local: fileEntry,
      },
    ]);
    const oneWay = await finalizeCanonicalPlan({
      candidate: crafted.candidate,
      envelope: crafted.envelope,
      direction: "one-way",
    });
    expect(itemKeys(oneWay.items)).toEqual(
      itemKeys(crafted.candidate.items),
    );
    expect(oneWay.items[0].requiresConfirmation).toBe(true);
    expect(oneWay.items[1].requiresConfirmation).toBe(false);
  });
});
