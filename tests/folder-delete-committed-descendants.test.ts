// 同轮「先删子文件、再删父文件夹」的提交前退让（2026-10-27 真机 perf-share 现场）
//
// 现场链条（iphone-test-vault 2026-10-27 12:32–12:36 轮，2000 个 deleteRemote ＋ 1 个
// deleteRemoteFolder）：
//   ① 子文件 s1552.md 的 DELETE 在客户端 15s 超时，服务端稍后仍把它删掉了；
//   ② 同一轮的超时核销在服务端生效前读了一次元数据 ⇒ 判「未应用」并撤销意图，
//      已提交索引里因此仍留着这条文件身份（节点＋锚点）；
//   ③ 父目录的实时空壳核验通过（服务端确实已空），DELETE 成功、回执落盘；
//   ④ 归约层按已提交状态仍看到那条子项 ⇒ `V2 folder delete still has committed
//      descendants: perf-share`，回执永远提交不了，轮末报
//      `Mutation recovery is unresolved; shared state checkpoint stopped`。
//
// 本条钉住的合同：**执行远端文件夹删除之前，必须用归约层同一份已提交状态
// 证明子树里没有无法退休的已提交子项**；证明不了就零写入延后（复用既有
// `reason.folder.remote-subtree-changed`），让下一轮先按 delta 吸收真实删除，
// 而不是先删云端再让回执结构性无法提交。修复前本用例停在上述第④步（红）。

import { describe, expect, it, vi } from "vitest";
import {
  addShapeDevice,
  createShapeWorld,
} from "./helpers/sync-shape-sequence-harness";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";

const TIMED_OUT_CHILD = "perf-share/s1552.md";

describe("folder delete after in-round child deletions", () => {
  it("defers the parent instead of deleting it while a timed-out child DELETE is still committed", async () => {
    const world = createShapeWorld({
      files: {
        "perf-share/s1550.md": "child-1550",
        "perf-share/s1551.md": "child-1551",
        [TIMED_OUT_CHILD]: "child-1552",
      },
      folders: ["perf-share"],
    });
    const device = await addShapeDevice(world, "device-a");
    const firstRound = await device.runRound();
    expect(firstRound.errors).toBe(0);
    await device.deleteLocalFolder("perf-share");

    // 现场时序：DELETE 已在服务端生效，但客户端等待超时；超时后的同一轮
    // 核销仍读到删除前的版本（服务端回执/读副本尚未刷新）⇒ 判「未应用」并
    // 撤销意图，已提交索引保留这条子项。这里用一次性陈旧读复刻该窗口。
    const onedrive = (device.executor as unknown as {
      onedrive: {
        deleteItem: (
          vaultName: string,
          path: string,
          eTag?: string,
          driveItemId?: string,
        ) => Promise<void>;
        getFileMetadata: (
          vaultName: string,
          path: string,
          reason?: string,
        ) => Promise<{
          path: string;
          driveId: string;
          parentId: string;
          size: number;
          mtime: number;
          eTag: string;
          sha256Hash?: string;
        } | null>;
      };
    }).onedrive;
    const originalDelete = onedrive.deleteItem.bind(onedrive);
    const originalMetadata = onedrive.getFileMetadata.bind(onedrive);
    const snapshot = world.snapshot();
    const timedOutId = snapshot.ids.get(TIMED_OUT_CHILD)!;
    const timedOutParentId = snapshot.ids.get("perf-share")!;
    let staleReadPending = false;
    onedrive.getFileMetadata = vi.fn(async (
      vaultName: string,
      path: string,
      reason?: string,
    ) => {
      if (path === TIMED_OUT_CHILD && staleReadPending) {
        staleReadPending = false;
        return {
          path,
          driveId: timedOutId,
          parentId: timedOutParentId,
          size: 11,
          mtime: 1,
          eTag: `w-etag-${timedOutId}`,
          sha256Hash: snapshot.files.get(TIMED_OUT_CHILD),
        };
      }
      return originalMetadata(vaultName, path, reason);
    }) as never;
    onedrive.deleteItem = vi.fn(async (
      vaultName: string,
      path: string,
      eTag?: string,
      driveItemId?: string,
    ) => {
      await originalDelete(vaultName, path, eTag, driveItemId);
      if (path === TIMED_OUT_CHILD) {
        staleReadPending = true;
        throw new OneDriveError(
          OneDriveErrorType.NetworkError,
          "Request timed out after 15000ms",
        );
      }
    }) as never;

    const round = await device.runRound();

    // 修复前这里是现场第④步的失败形状：云端文件夹已被删掉，但回执提交不了，
    // 账本留着一条 deleteRemoteFolder，轮末升级成整库恢复阻塞。修复后必须
    // 在发出文件夹 DELETE 之前就零写入延后。
    expect(round.mutationRecovery).toBeUndefined();
    expect(device.ledger()).toHaveLength(0);
    expect(round.message).not.toContain("Mutation recovery is unresolved");
    // 文件夹一行必须是零写入延后：云端空壳还在，等下一轮用 delta 吸收
    // 那条已真实删除、但本机尚未记账的子文件。
    expect(round.foldersDeleted ?? 0).toBe(0);
    expect(round.deferred).toBe(1);
    expect(world.snapshot().folders).toContain("perf-share");
    expect(device.syncCalls.deletes).not.toContain("perf-share");
    expect(device.recentDiagnostics.some((entry) =>
      entry.message.includes("still has committed descendants"))).toBe(false);
    expect(device.recentDiagnostics.some((entry) =>
      entry.message.includes("folder delete deferred — committed descendants"))).toBe(true);
  });

  // 控制项（反假绿）：子项删除全部提交后，同轮父目录仍必须照删——前置闸读的
  // 是本轮清理波已提交的结果，不是计划时的旧快照。70 个子项跨两个 64 的清理波，
  // 同时钉住「多波提交后再校验」这一面。
  it("still deletes the parent in the same round when every child checkpoint committed", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 70; index++) {
      files[`perf-share/s${index}.md`] = `child-${index}`;
    }
    const world = createShapeWorld({ files, folders: ["perf-share"] });
    const device = await addShapeDevice(world, "device-a");
    expect((await device.runRound()).errors).toBe(0);
    await device.deleteLocalFolder("perf-share");

    const round = await device.runRound();

    expect(round.errors).toBe(0);
    expect(round.foldersDeleted).toBe(1);
    expect(round.deferred).toBe(0);
    expect(round.mutationRecovery).toBeUndefined();
    expect(device.ledger()).toHaveLength(0);
    expect(world.snapshot().folders).not.toContain("perf-share");
  });
});
