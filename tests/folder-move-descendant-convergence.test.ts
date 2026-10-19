import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import { planFolderStateV2 } from "../src/sync/folder-state-v2";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import type {
  FolderAnchorV2,
  SyncAnchorV2,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
import type { LocalFileEntry, LocalFolderEntry, SyncScope } from "../src/sync/types";

/**
 * F29 家族第二刀（零写入结案）的前置取证：**一次文件夹移动没有把后代一起
 * 落账之后，下一轮规划会给出什么。**
 *
 * 场景＝判例 F29 的现场形状，但把「另一台设备做过什么」当作已经发生的外部事实
 * 直接建模（云端已在新位置），所以单设备的下一轮规划就要回答这个问题。
 *
 * **这不替代真宿主可销毁双 Vault 协议**（归档 `20260815-1237` 的 F5 手法：同账号
 * 同云目录两个 Vault、冷重载、连续稳定轮归零），只用来说明「结案之后用户会看到
 * 什么」——本文件测的是规划器输出，不是宿主行为。
 *
 * 与恢复链的关系（读码确认，决定了第二刀的重要性）：
 * - `isolatableOrdinaryFileRecovery`（`sync-executor.ts:4533`）第一行即排除文件夹
 *   意图（`conservative-reset-recovery.ts:241-242`）⇒ **文件夹记录永远无法被隔离**；
 * - `:11532-11533` 对「不可隔离且非网络受阻」**直接重抛** ⇒ 普通规划整段被跳过；
 * - ⇒ 一条受阻的文件夹记录会**一直冻结整库规划**，规划器根本不跑。零写入结案正是
 *   让该记录进入「已隔离」集合、从而让规划重新开始的那一步。
 * 本文件证明的是：**一旦规划能跑，这个形状不会无声卡住，而是给出带出口的冲突行。**
 */

const scope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};

const hashA = "a".repeat(64);

interface FolderSpec {
  id: string;
  name: string;
  parentId?: string;
}

interface FileSpec {
  id: string;
  name: string;
  parentId: string;
  hash?: string;
  size?: number;
}

function envelope(input: {
  folders?: FolderSpec[];
  files?: FileSpec[];
  folderAnchors?: FolderAnchorV2[];
  fileAnchors?: SyncAnchorV2[];
  commitSeq?: number;
}): SyncStateEnvelopeV2 {
  const remoteItems: DriveItem[] = [
    ...(input.folders ?? []).map((folder): DriveItem => ({
      id: folder.id,
      name: folder.name,
      parentReference: { id: folder.parentId ?? scope.filesRootId },
      folder: {},
      eTag: `etag-${folder.id}`,
      cTag: `ctag-${folder.id}`,
    })),
    ...(input.files ?? []).map((file): DriveItem => ({
      id: file.id,
      name: file.name,
      parentReference: { id: file.parentId },
      file: { hashes: { sha256Hash: file.hash ?? hashA } },
      size: file.size ?? 10,
      eTag: `etag-${file.id}`,
      cTag: `ctag-${file.id}`,
    })),
  ];
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 1,
      commitSeq: input.commitSeq ?? 3,
      committedAt: 1,
    },
    scope,
    remoteIndex: buildRemoteIndexV2(remoteItems, scope.filesRootId, null, 1).index,
    anchors: {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(
        (input.fileAnchors ?? []).map((anchor) => [anchor.anchorId, anchor]),
      ),
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(
        (input.folderAnchors ?? []).map((anchor) => [anchor.anchorId, anchor]),
      ),
    },
  };
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

function localFile(path: string, hash = hashA, size = 10): LocalFileEntry {
  return { path, hash, size, mtime: 1, binary: false };
}

function localFolders(...paths: string[]): LocalFolderEntry[] {
  return paths.map((path) => ({ path }));
}

describe("a folder move whose descendants were not reprojected (F29 post-settlement)", () => {
  // 云端事实：父文件夹 F 已搬到 root/Videos/F，里面还有子文件夹 F/Child 与文件。
  // 已提交状态：文件夹锚点**还在旧路径** F（上一次移动的结算被拒绝、整批没落账），
  // 后代锚点同样停在旧路径。这就是「零写入结案之后」的形状。
  const remoteFolders: FolderSpec[] = [
    { id: "videos", name: "Videos" },
    { id: "f", name: "F", parentId: "videos" },
    { id: "child", name: "Child", parentId: "f" },
  ];
  const remoteFiles: FileSpec[] = [
    { id: "x", name: "x.md", parentId: "f" },
    { id: "y", name: "y.md", parentId: "child" },
  ];

  const buildReport = () => planFolderStateV2({
    envelope: envelope({
      folders: remoteFolders,
      files: remoteFiles,
      folderAnchors: [
        folderAnchor("f", "F"),
        folderAnchor("child", "F/Child", "f"),
      ],
      fileAnchors: [
        fileAnchor("x", "F/x.md"),
        fileAnchor("y", "F/Child/y.md"),
      ],
    }),
    // 本机：文件也确实跟着父文件夹搬到了 Videos/F 下。
    localFiles: [localFile("Videos/F/x.md"), localFile("Videos/F/Child/y.md")],
    localFolders: localFolders("Videos", "Videos/F", "Videos/F/Child"),
    localFolderScanComplete: true,
  });

  it("plans instead of stalling: the shape routes to review, never to silence", () => {
    const report = buildReport();

    // 关键性质（第二刀的准入判据）：这个形状**不允许**是「零项且零冲突」——
    // 那才是真正的静默不前进。规划可以收敛、也可以转人工，但必须给出一个归宿。
    expect(report.status).toBe("planned");
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.counts.conflicts).toBeGreaterThan(0);
    // 没有任何自动动作：分歧形状不自动选边（与「不丢数据 > 不损坏文件」一致）。
    expect(report.counts.moveRemote + report.counts.moveLocal).toBe(0);
  });

  it("gives every produced row a resolution exit", () => {
    const report = buildReport();

    // 这些冲突行在侧栏要靠 `PendingIssue.issueCode` 找到出口；规划器把
    // `reason.folder.*` 映射成具体 code（`sync-executor.ts` 的 reason→issueCode 表），
    // 而每个 code 在 `sync-view.ts:3233-3284` 都有对应 chip。
    // 这里只钉住「产生了行、且不是自动动作」；具体 code 的映射与 chip 由既有
    // 展现层测试与源码守卫承接，不在本文件重复。
    expect(report.items.every((item) => item.type === "conflict")).toBe(true);
    expect(report.items.map((item) => item.path).sort()).toEqual([
      "F",
      "F/Child",
      "Videos",
    ]);
  });

  it("anti-false-green control: without the committed folder identity no row names the moved anchor", () => {
    // 反假绿控制项：去掉**已提交的文件夹锚点**（文件锚点保留），规划器就不该再
    // 产出以 `F` 为锚的那一行——那一行正是「按身份认出这个文件夹搬到哪去了」的
    // 结论。若它仍然出现，说明上面两条断言没有在测身份推断，而是恒真。
    const report = planFolderStateV2({
      envelope: envelope({
        folders: remoteFolders,
        files: remoteFiles,
        folderAnchors: [],
        fileAnchors: [
          fileAnchor("x", "F/x.md"),
          fileAnchor("y", "F/Child/y.md"),
        ],
      }),
      localFiles: [localFile("Videos/F/x.md"), localFile("Videos/F/Child/y.md")],
      localFolders: localFolders("Videos", "Videos/F", "Videos/F/Child"),
      localFolderScanComplete: true,
    });

    expect(report.items.map((item) => item.path)).not.toContain("F/Child");
  });
});
