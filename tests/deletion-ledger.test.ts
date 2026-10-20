// 删除记录簿（文件版本找回刀一之二）：纯记录族合同。
//
// 族形状＝`{ schemaVersion ＋ kind ＋ entries }`，身份＝远端 item id（同 id 重放＝
// 更新，不重复）；读回损坏降级；30 天摘除边界；无变化不产生新对象（调用方据此
// 跳过写入）。

import { describe, expect, it } from "vitest";
import {
  DELETION_LEDGER_RETENTION_MS,
  deletionLedgerCutoffV1,
  emptyDeletionLedgerV1,
  pruneDeletionLedgerV1,
  readDeletionLedgerV1,
  sameDeletionLedgerV1,
  upsertDeletionLedgerEntryV1,
} from "../src/sync/deletion-ledger";
import type {
  DeletionLedgerEntryV1,
  DeletionLedgerV1,
} from "../src/sync/deletion-ledger";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function entry(
  overrides: Partial<DeletionLedgerEntryV1> = {},
): DeletionLedgerEntryV1 {
  return {
    remoteId: "remote-1",
    path: "notes/a.md",
    deletedAt: 1000,
    kind: "file",
    ...overrides,
  };
}

function container(
  entries: DeletionLedgerEntryV1[],
): DeletionLedgerV1 {
  return {
    schemaVersion: 1,
    kind: "easy-sync-deletion-ledger",
    entries,
  };
}

describe("deletion ledger family (文件版本找回刀一之二)", () => {
  it("round-trips the family and treats a missing container as empty", () => {
    const family = container([entry(), entry({
      remoteId: "remote-2",
      path: "notes/folder",
      deletedAt: 2000,
      kind: "folder",
    })]);

    expect(readDeletionLedgerV1(family)).toEqual(family);
    expect(readDeletionLedgerV1(undefined)).toEqual(emptyDeletionLedgerV1());
    // 读→写→再读稳定：落盘形状就是读回形状。
    const roundTripped = readDeletionLedgerV1(
      JSON.parse(JSON.stringify(readDeletionLedgerV1(family))),
    );
    expect(roundTripped).toEqual(family);
  });

  it("degrades a corrupt container to null so the store keeps an empty family", () => {
    for (const corrupt of [
      "nope",
      42,
      null,
      [entry()],
      { schemaVersion: 7, kind: "easy-sync-deletion-ledger", entries: [] },
      { schemaVersion: 1, kind: "local-only-copies", entries: [] },
      { schemaVersion: 1, kind: "easy-sync-deletion-ledger", entries: "nope" },
      { schemaVersion: 1, kind: "easy-sync-deletion-ledger" },
    ]) {
      expect(readDeletionLedgerV1(corrupt)).toBeNull();
    }
  });

  it("drops only the malformed entries inside a valid container", () => {
    const read = readDeletionLedgerV1(container([
      entry(),
      { remoteId: "", path: "notes/a.md", deletedAt: 1, kind: "file" },
      { remoteId: "remote-3", path: "", deletedAt: 1, kind: "file" },
      { remoteId: "remote-4", path: "notes/b.md", deletedAt: Number.NaN, kind: "file" },
      { remoteId: "remote-5", path: "notes/c.md", deletedAt: 1, kind: "other" },
      { remoteId: "remote-6", path: "notes/d.md", deletedAt: 1 },
      entry({ remoteId: "remote-7", path: "notes/e.md" }),
    ]));

    expect(read?.entries).toEqual([
      entry(),
      entry({ remoteId: "remote-7", path: "notes/e.md" }),
    ]);
  });

  it("deduplicates by remote id: a replay updates instead of appending", () => {
    const family = container([entry()]);
    const updated = upsertDeletionLedgerEntryV1(family, entry({
      path: "notes/renamed.md",
      deletedAt: 5000,
      kind: "folder",
    }));

    expect(updated.entries).toEqual([
      entry({ path: "notes/renamed.md", deletedAt: 5000, kind: "folder" }),
    ]);

    const appended = upsertDeletionLedgerEntryV1(updated, entry({
      remoteId: "remote-9",
      path: "notes/b.md",
    }));
    expect(appended.entries.map((item) => item.remoteId))
      .toEqual(["remote-1", "remote-9"]);
    // 原对象不被改写。
    expect(family.entries).toEqual([entry()]);
  });

  it("returns the same family object when nothing changes", () => {
    const inside = entry({ deletedAt: NOW - 1000 });
    const second = entry({ remoteId: "remote-2", deletedAt: NOW - 2000 });
    const family = container([inside, second]);

    expect(upsertDeletionLedgerEntryV1(family, inside)).toBe(family);
    expect(pruneDeletionLedgerV1(family, { now: NOW })).toBe(family);
    expect(sameDeletionLedgerV1(family, container([inside, second]))).toBe(true);
  });

  it("prunes entries past the 30-day window and keeps the ones inside it", () => {
    expect(DELETION_LEDGER_RETENTION_MS).toBe(30 * DAY);
    const family = container([
      entry({ remoteId: "29-days", deletedAt: NOW - 29 * DAY }),
      entry({ remoteId: "30-days", deletedAt: NOW - 30 * DAY }),
      entry({ remoteId: "31-days", deletedAt: NOW - 31 * DAY }),
      entry({ remoteId: "31-days-plus", deletedAt: NOW - 31 * DAY - 1 }),
    ]);

    const pruned = pruneDeletionLedgerV1(family, { now: NOW });

    // 边界＝`deletedAt < now - 30 天` 才摘除：整 30 天仍留。
    expect(pruned.entries.map((item) => item.remoteId))
      .toEqual(["29-days", "30-days"]);
    expect(deletionLedgerCutoffV1(NOW)).toBe(NOW - DELETION_LEDGER_RETENTION_MS);
  });

  it("prunes an empty or missing family without inventing entries", () => {
    expect(pruneDeletionLedgerV1(null, { now: NOW })).toEqual(emptyDeletionLedgerV1());
    expect(pruneDeletionLedgerV1(emptyDeletionLedgerV1(), { now: NOW }).entries)
      .toEqual([]);
    const empty = emptyDeletionLedgerV1();
    expect(pruneDeletionLedgerV1(empty, { now: NOW })).toBe(empty);
  });
});
