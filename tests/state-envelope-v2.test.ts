import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  StateEnvelopeV2Store,
  type StateEnvelopeV2Paths,
  type SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";

const paths: StateEnvelopeV2Paths = {
  committed: "plugin/state-v2.json",
  next: "plugin/state-v2.next.json",
  previous: "plugin/state-v2.previous.json",
  recovery: "plugin/state-v2.recovery.json",
};

function makeAdapter() {
  const files = new Map<string, string>();
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
  };
  return { adapter: adapter as unknown as DataAdapter, files, spies: adapter };
}

function envelope(commitSeq = 1): SyncStateEnvelopeV2 {
  const hash = "a".repeat(64);
  return {
    meta: { schemaVersion: 2, lifecycleEpoch: 3, commitSeq, committedAt: 1000 + commitSeq },
    scope: { accountId: "account", driveId: "drive", vaultFolderId: "vault", filesRootId: "root" },
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: "root",
      cursorRevision: commitSeq,
      deltaLink: `delta-${commitSeq}`,
      complete: true,
      itemsById: {
        folder: { id: "folder", parentId: "root", name: "notes", kind: "folder" },
        file: { id: "file", parentId: "folder", name: "a.md", kind: "file", eTag: `e${commitSeq}`, size: 1 },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        anchor: {
          anchorId: "anchor",
          remoteId: "file",
          lastPath: "notes/a.md",
          contentHash: hash,
          size: 1,
          remoteETag: `e${commitSeq}`,
          confirmedAt: 1000 + commitSeq,
          confirmedBy: "equal-read",
        },
      },
    },
  };
}

describe("StateEnvelopeV2Store", () => {
  it("publishes remote identity and anchors through one verified commit", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());

    expect(await store.load(envelope().scope)).toEqual(envelope());
    expect(files.has(paths.next)).toBe(false);
    expect(files.has(paths.previous)).toBe(false);
    expect(await store.hasRecoveryJournal()).toBe(false);
  });

  it("round-trips optional remote content-version evidence without requiring it", async () => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const committed = envelope();
    committed.remoteIndex.itemsById.file!.cTag = "ctag-content-1";
    committed.anchors.byAnchorId.anchor!.remoteCTag = "ctag-content-1";

    await store.publish(committed);

    expect((await store.load(committed.scope))!.anchors.byAnchorId.anchor)
      .toMatchObject({ remoteCTag: "ctag-content-1" });
  });

  it("round-trips device community-plugin participation inside the V2 envelope", async () => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const committed = envelope();
    committed.communityPluginParticipation = {
      schemaVersion: 1,
      kind: "device-community-plugin-participation",
      scopeEnabled: true,
      pluginsById: {
        calendar: {
          pluginId: "calendar",
          phase: "join-requested",
          operationId: "join-calendar-1",
        },
      },
    };

    await store.publish(committed);

    expect(await store.load(committed.scope)).toEqual(committed);
  });

  it("materializes a verified external V2 owner across a commit-sequence gap", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope(1));

    await store.replaceFromVerifiedExternalAuthority(envelope(4));

    expect(await store.load(envelope().scope)).toEqual(envelope(4));
    expect(files.has(paths.next)).toBe(false);
    expect(files.has(paths.previous)).toBe(false);
    expect(await store.hasRecoveryJournal()).toBe(false);
  });

  it("binds stable remote-index corruption to the exact committed bytes", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corrupt = envelope(4);
    corrupt.remoteIndex.itemsById.file!.parentId = "missing-parent";
    const rawEnvelope = JSON.stringify(corrupt);
    files.set(paths.committed, rawEnvelope);

    await expect(store.inspectCorruptCommitted({
      expectedScope: corrupt.scope,
      minimumCommitSeq: 1,
      minimumLifecycleEpoch: 3,
    })).resolves.toMatchObject({
      version: 1,
      kind: "v2-corrupt-state-evidence",
      scope: corrupt.scope,
      sourceCommitSeq: 4,
      sourceLifecycleEpoch: 3,
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      corruption: "remote-index",
      rawEnvelope,
    });
  });

  it("distinguishes anchor-only and mixed corruption", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const anchorCorrupt = envelope(4);
    anchorCorrupt.anchors.byAnchorId.anchor!.anchorId = "wrong-anchor";
    files.set(paths.committed, JSON.stringify(anchorCorrupt));

    await expect(store.inspectCorruptCommitted({
      expectedScope: anchorCorrupt.scope,
      minimumCommitSeq: 1,
      minimumLifecycleEpoch: 3,
    })).resolves.toMatchObject({ corruption: "anchors" });

    const mixed = structuredClone(anchorCorrupt);
    mixed.remoteIndex.itemsById.file!.parentId = "missing-parent";
    files.set(paths.committed, JSON.stringify(mixed));
    await expect(store.inspectCorruptCommitted({
      expectedScope: mixed.scope,
      minimumCommitSeq: 1,
      minimumLifecycleEpoch: 3,
    })).resolves.toMatchObject({
      corruption: "remote-index-and-anchors",
    });
  });

  it("does not classify metadata, scope-control, or publication ambiguity as rebuildable", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const invalidMeta = envelope(4) as SyncStateEnvelopeV2 & {
      meta: SyncStateEnvelopeV2["meta"] & { commitSeq: number };
    };
    invalidMeta.meta.commitSeq = 0;
    files.set(paths.committed, JSON.stringify(invalidMeta));
    await expect(store.inspectCorruptCommitted({
      expectedScope: envelope().scope,
      minimumCommitSeq: 1,
      minimumLifecycleEpoch: 3,
    })).resolves.toBeNull();

    const held = envelope(4);
    held.remoteIndex.itemsById.file!.parentId = "missing-parent";
    held.remoteScopeRecovery = {
      schemaVersion: 1,
      kind: "v2-remote-scope-recovery",
      reason: "committed-scope-unreachable",
      sourceCommitSeq: 4,
      observedScope: null,
      observedAt: 4,
    };
    files.set(paths.committed, JSON.stringify(held));
    await expect(store.inspectCorruptCommitted({
      expectedScope: held.scope,
      minimumCommitSeq: 1,
      minimumLifecycleEpoch: 3,
    })).resolves.toBeNull();

    const remoteCorrupt = envelope(4);
    remoteCorrupt.remoteIndex.itemsById.file!.parentId = "missing-parent";
    files.set(paths.committed, JSON.stringify(remoteCorrupt));
    files.set(paths.recovery, JSON.stringify({ status: "unknown" }));
    await expect(store.inspectCorruptCommitted({
      expectedScope: remoteCorrupt.scope,
      minimumCommitSeq: 1,
      minimumLifecycleEpoch: 3,
    })).resolves.toBeNull();
  });

  it("requires the corrupt source revision to be compatible with the selected manifest", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corrupt = envelope(4);
    corrupt.remoteIndex.itemsById.file!.parentId = "missing-parent";
    files.set(paths.committed, JSON.stringify(corrupt));

    await expect(store.inspectCorruptCommitted({
      expectedScope: {
        ...corrupt.scope,
        filesRootId: "other-root",
      },
      minimumCommitSeq: 1,
      minimumLifecycleEpoch: 3,
    })).resolves.toBeNull();
    await expect(store.inspectCorruptCommitted({
      expectedScope: corrupt.scope,
      minimumCommitSeq: 5,
      minimumLifecycleEpoch: 3,
    })).resolves.toBeNull();
    await expect(store.inspectCorruptCommitted({
      expectedScope: corrupt.scope,
      minimumCommitSeq: 1,
      minimumLifecycleEpoch: 4,
    })).resolves.toBeNull();
  });

  it("rolls an interrupted final rename back and allows the durable receipt to retry", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
    spies.rename.mockImplementationOnce(async (from: string, to: string) => {
      const value = files.get(from)!;
      files.delete(from);
      files.set(to, value);
    }).mockImplementationOnce(async () => { throw new Error("rename failed"); });

    await expect(store.publish(envelope(2))).rejects.toThrow("rename failed");
    expect(await store.load(envelope().scope)).toEqual(envelope());
    expect(await store.hasRecoveryJournal()).toBe(false);
    await expect(store.publish(envelope(2))).resolves.toBeUndefined();
    expect(await store.load(envelope().scope)).toEqual(envelope(2));
  });

  it("does not replace committed state when staged read-back is corrupt and cleans the failed stage", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
    spies.read.mockImplementation(async (path: string) => {
      if (path === paths.next) return "{broken";
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    });

    await expect(store.publish(envelope(2))).rejects.toThrow("unreadable");
    expect(JSON.parse(files.get(paths.committed)!)).toEqual(envelope());
    await expect(store.recoverInterruptedPublish(envelope().scope)).resolves.toBe("rolled-back");
    expect(await store.hasRecoveryJournal()).toBe(false);
    expect(files.has(paths.next)).toBe(false);
  });

  it("accepts a fully renamed candidate after cleanup was interrupted", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
    files.set(paths.previous, JSON.stringify(envelope()));
    files.set(paths.committed, JSON.stringify(envelope(2)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope)).resolves.toBe("published");
    expect(await store.load(envelope().scope)).toEqual(envelope(2));
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("accepts a committed next sequence when the retired previous envelope is corrupt", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corruptPrevious = envelope();
    corruptPrevious.anchors.byAnchorId.anchor!.anchorId = "wrong-anchor";
    files.set(paths.previous, JSON.stringify(corruptPrevious));
    files.set(paths.committed, JSON.stringify(envelope(2)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("published");
    expect(await store.load(envelope().scope)).toEqual(envelope(2));
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("rolls a corrupt committed candidate back only from the journal-bound previous sequence", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corruptCommitted = envelope(2);
    corruptCommitted.remoteIndex.itemsById.file!.parentId = "missing-parent";
    files.set(paths.previous, JSON.stringify(envelope()));
    files.set(paths.committed, JSON.stringify(corruptCommitted));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("rolled-back");
    expect(await store.load(envelope().scope)).toEqual(envelope());
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("preserves corrupt publication slots when no valid sequence proves recovery", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corruptCommitted = JSON.stringify({
      ...envelope(2),
      remoteIndex: {
        ...envelope(2).remoteIndex,
        filesRootId: "wrong-root",
      },
    });
    const corruptPrevious = "{broken";
    files.set(paths.committed, corruptCommitted);
    files.set(paths.previous, corruptPrevious);
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .rejects.toMatchObject({ reason: "envelope-unsupported" });
    expect(files.get(paths.committed)).toBe(corruptCommitted);
    expect(files.get(paths.previous)).toBe(corruptPrevious);
    expect(files.has(paths.recovery)).toBe(true);
  });

  it("does not discard a corrupt first committed envelope without a prior V2 authority", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corruptCommitted = "{broken";
    files.set(paths.committed, corruptCommitted);
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: null,
      nextCommitSeq: 1,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .rejects.toMatchObject({ reason: "envelope-unreadable" });
    expect(files.get(paths.committed)).toBe(corruptCommitted);
    expect(files.has(paths.recovery)).toBe(true);
  });

  it("does not roll a readable unexpected commit back through an older previous slot", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.committed, JSON.stringify(envelope(3)));
    files.set(paths.previous, JSON.stringify(envelope()));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .rejects.toMatchObject({ reason: "publication-state-ambiguous" });
    expect(JSON.parse(files.get(paths.committed)!)).toEqual(envelope(3));
    expect(JSON.parse(files.get(paths.previous)!)).toEqual(envelope());
    expect(files.has(paths.recovery)).toBe(true);
  });

  it("promotes a journal-bound staged candidate when no readable old slot survives", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corruptPrevious = envelope();
    corruptPrevious.anchors.byAnchorId.anchor!.anchorId = "wrong-anchor";
    files.set(paths.previous, JSON.stringify(corruptPrevious));
    files.set(paths.next, JSON.stringify(envelope(2)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("published");
    expect(await store.load(envelope().scope)).toEqual(envelope(2));
    expect(files.has(paths.next)).toBe(false);
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("promotes a staged first V2 envelope when the committed rename never started", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.next, JSON.stringify(envelope()));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: null,
      nextCommitSeq: 1,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("published");
    expect(await store.load(envelope().scope)).toEqual(envelope());
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("keeps a staged candidate whose sequence does not match the journal", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.previous, "{broken");
    files.set(paths.next, JSON.stringify(envelope(3)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .rejects.toMatchObject({ reason: "envelope-unreadable" });
    expect(JSON.parse(files.get(paths.next)!)).toEqual(envelope(3));
    expect(files.get(paths.previous)).toBe("{broken");
    expect(files.has(paths.recovery)).toBe(true);
  });

  it("finishes cleanup on restart when staged promotion succeeded but rename reported failure", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.previous, "{broken");
    files.set(paths.next, JSON.stringify(envelope(2)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));
    spies.rename.mockImplementationOnce(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
      throw new Error("rename response lost");
    });

    // F31 第九层：对已实际落地的改名，响应丢失不再要求中止本轮——现场
    // 已证实删除/改名被拒与响应丢失都常态出现，恢复日志本来就按「已生效」
    // 收敛，改名之后的行为与其一致（观察到目标在位即收口，尽力清除源）。
    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("published");
    expect(JSON.parse(files.get(paths.committed)!)).toEqual(envelope(2));
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);

    // 二次调用＝干净态（响应丢失那轮已顺带收口清理）。
    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("none");
  });

  it("keeps load convergent when cleanup deletion is refused outright", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.previous, JSON.stringify(envelope(1)));
    files.set(paths.committed, JSON.stringify(envelope(2)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));
    spies.remove.mockRejectedValue(new Error("Unable to delete file"));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("published");
    expect(await store.load(envelope().scope)).toEqual(envelope(2));
    // 删除被拒＝残档留职；状态照旧由可读槽裁决，下一轮清屋照旧进行。
    expect(files.has(paths.previous)).toBe(true);
    expect(files.has(paths.recovery)).toBe(true);
  });

  it("restores previous through the write channel when rename is refused", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.previous, JSON.stringify(envelope(1)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));
    spies.rename.mockRejectedValue(new Error("Unable to rename, unknown reason"));

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("rolled-back");
    expect(JSON.parse(files.get(paths.committed)!)).toEqual(envelope(1));
    expect(await store.load(envelope().scope)).toEqual(envelope(1));
    expect(files.has(paths.previous)).toBe(false);
  });

  it("never trusts the write channel substitution readback", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.previous, JSON.stringify(envelope(1)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));
    spies.rename.mockRejectedValue(new Error("Unable to rename, unknown reason"));
    // 写通道被挂载层篡改（读回与写入源不一致）：必须拒绝，宁可本轮失败、
    // 下一轮恢复，也不能让不可信内容占住已提交槽。
    spies.write.mockImplementation(async (path: string, value: string) => {
      if (path === paths.committed) {
        const tampered = JSON.parse(value);
        tampered.remoteIndex.cursorRevision = 999;
        files.set(path, JSON.stringify(tampered));
        return;
      }
      files.set(path, value);
    });

    await expect(store.recoverInterruptedPublish(envelope().scope))
      .rejects.toThrow("Unable to rename, unknown reason");
    expect(files.has(paths.committed)).toBe(true);
    expect(JSON.parse(files.get(paths.committed)!).remoteIndex.cursorRevision)
      .toBe(999);
  });

  it("publishes over a converged leftover journal when its cleanup was refused", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.previous, JSON.stringify(envelope(1)));
    files.set(paths.committed, JSON.stringify(envelope(2)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));
    spies.remove.mockRejectedValue(new Error("Unable to delete file"));

    // 恢复读场先收敛 journal；清理被拒后残留。load 已裁决、publish 不应
    // 再被残账本拦下（F31：celebrated 尽力而为语义下删不掉＝留职）。
    await expect(store.recoverInterruptedPublish(envelope().scope))
      .resolves.toBe("published");

    const next = envelope(3);
    next.remoteIndex.deltaLink = "delta-3";
    next.remoteIndex.cursorRevision = 3;
    next.meta.commitSeq = 3;
    next.meta.committedAt = 3000;
    next.anchors.byAnchorId.anchor!.remoteETag = "e3";
    await expect(store.publish(next)).resolves.toBeUndefined();
    expect(JSON.parse(files.get(paths.committed)!)).toEqual(next);
    expect(files.has(paths.previous)).toBe(true);
  });

  it("repairs only invalid cursor metadata in an otherwise valid committed envelope", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    corrupt.remoteIndex.deltaLink = "stale-delta";
    files.set(paths.committed, JSON.stringify(corrupt));

    const repaired = await store.repairCursorOnly(envelope().scope, 2000);

    expect(repaired).toEqual({
      ...envelope(),
      meta: {
        ...envelope().meta,
        commitSeq: 2,
        committedAt: 2000,
      },
      remoteIndex: {
        ...envelope().remoteIndex,
        cursorRevision: 0,
        deltaLink: null,
      },
    });
    expect(await store.load(envelope().scope)).toEqual(repaired);
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.next)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("resumes an interrupted cursor repair from its dedicated journal", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corrupt = envelope();
    corrupt.remoteIndex.deltaLink = 42 as unknown as string;
    files.set(paths.committed, JSON.stringify(corrupt));
    files.set(paths.recovery, JSON.stringify({
      version: 2,
      status: "repairing-cursor",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 2000,
    }));

    const repaired = await store.repairCursorOnly(envelope().scope, 2000);

    expect(repaired?.meta.commitSeq).toBe(2);
    expect(repaired?.remoteIndex).toMatchObject({
      cursorRevision: 0,
      deltaLink: null,
      itemsById: envelope().remoteIndex.itemsById,
    });
    expect(await store.load(envelope().scope)).toEqual(repaired);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("accepts a cursor-repair journal write whose response was lost", async () => {
    const { adapter, files, spies } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    files.set(paths.committed, JSON.stringify(corrupt));
    spies.write.mockImplementationOnce(async (path: string, value: string) => {
      files.set(path, value);
      throw new Error("journal response lost");
    });

    await expect(store.repairCursorOnly(envelope().scope, 2000))
      .resolves.toMatchObject({
        meta: { commitSeq: 2 },
        remoteIndex: { cursorRevision: 0, deltaLink: null },
      });
    expect(await store.load(envelope().scope)).toMatchObject({
      meta: { commitSeq: 2 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
    });
  });

  it("retries cursor repair after the journal write failed before persistence", async () => {
    const { adapter, files, spies } = makeAdapter();
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    const raw = JSON.stringify(corrupt);
    files.set(paths.committed, raw);
    spies.write.mockRejectedValueOnce(new Error("journal write failed"));

    await expect(
      new StateEnvelopeV2Store(adapter, paths)
        .repairCursorOnly(envelope().scope, 2000),
    ).rejects.toThrow("journal write failed");
    expect(files.get(paths.committed)).toBe(raw);
    expect(files.has(paths.recovery)).toBe(false);

    const restarted = new StateEnvelopeV2Store(adapter, paths);
    await expect(restarted.repairCursorOnly(envelope().scope, 2001))
      .resolves.toMatchObject({
        meta: { commitSeq: 2, committedAt: 2001 },
        remoteIndex: { cursorRevision: 0, deltaLink: null },
      });
    expect(await restarted.load(envelope().scope)).toMatchObject({
      meta: { commitSeq: 2 },
    });
  });

  it("resumes cursor repair after the staged write failed before persistence", async () => {
    const { adapter, files, spies } = makeAdapter();
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    files.set(paths.committed, JSON.stringify(corrupt));
    spies.write
      .mockImplementationOnce(async (path: string, value: string) => {
        files.set(path, value);
      })
      .mockRejectedValueOnce(new Error("staged write failed"));

    await expect(
      new StateEnvelopeV2Store(adapter, paths)
        .repairCursorOnly(envelope().scope, 2000),
    ).rejects.toThrow("staged write failed");
    expect(files.has(paths.recovery)).toBe(true);
    expect(files.has(paths.next)).toBe(false);

    const restarted = new StateEnvelopeV2Store(adapter, paths);
    await expect(restarted.repairCursorOnly(envelope().scope, 2001))
      .resolves.toMatchObject({
        meta: { commitSeq: 2, committedAt: 2001 },
        remoteIndex: { cursorRevision: 0, deltaLink: null },
      });
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("accepts a staged cursor candidate whose write response was lost", async () => {
    const { adapter, files, spies } = makeAdapter();
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    files.set(paths.committed, JSON.stringify(corrupt));
    spies.write
      .mockImplementationOnce(async (path: string, value: string) => {
        files.set(path, value);
      })
      .mockImplementationOnce(async (path: string, value: string) => {
        files.set(path, value);
        throw new Error("staged write response lost");
      });

    await expect(
      new StateEnvelopeV2Store(adapter, paths)
        .repairCursorOnly(envelope().scope, 2000),
    ).resolves.toMatchObject({
      meta: { commitSeq: 2 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
    });
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("rolls cursor repair forward after committed-to-previous rename response loss", async () => {
    const { adapter, files, spies } = makeAdapter();
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    files.set(paths.committed, JSON.stringify(corrupt));
    spies.rename.mockImplementationOnce(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
      throw new Error("first rename response lost");
    });

    await expect(
      new StateEnvelopeV2Store(adapter, paths)
        .repairCursorOnly(envelope().scope, 2000),
    ).rejects.toThrow("first rename response lost");
    expect(files.has(paths.committed)).toBe(false);
    expect(files.has(paths.previous)).toBe(true);
    expect(files.has(paths.next)).toBe(true);
    expect(files.has(paths.recovery)).toBe(true);

    const restarted = new StateEnvelopeV2Store(adapter, paths);
    await expect(restarted.load(envelope().scope)).resolves.toMatchObject({
      meta: { commitSeq: 2 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
    });
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.next)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("rolls cursor repair forward when staged promotion failed before applying", async () => {
    const { adapter, files, spies } = makeAdapter();
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    files.set(paths.committed, JSON.stringify(corrupt));
    spies.rename
      .mockImplementationOnce(async (from: string, to: string) => {
        const value = files.get(from);
        if (value === undefined) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, value);
      })
      .mockRejectedValueOnce(new Error("promotion failed"));

    await expect(
      new StateEnvelopeV2Store(adapter, paths)
        .repairCursorOnly(envelope().scope, 2000),
    ).rejects.toThrow("promotion failed");
    expect(files.has(paths.committed)).toBe(false);
    expect(files.has(paths.previous)).toBe(true);
    expect(files.has(paths.next)).toBe(true);

    const restarted = new StateEnvelopeV2Store(adapter, paths);
    await expect(restarted.load(envelope().scope)).resolves.toMatchObject({
      meta: { commitSeq: 2 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
    });
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("accepts staged-to-committed rename response loss without a restart", async () => {
    const { adapter, files, spies } = makeAdapter();
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    files.set(paths.committed, JSON.stringify(corrupt));
    spies.rename
      .mockImplementationOnce(async (from: string, to: string) => {
        const value = files.get(from);
        if (value === undefined) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, value);
      })
      .mockImplementationOnce(async (from: string, to: string) => {
        const value = files.get(from);
        if (value === undefined) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, value);
        throw new Error("promotion response lost");
      });

    await expect(
      new StateEnvelopeV2Store(adapter, paths)
        .repairCursorOnly(envelope().scope, 2000),
    ).resolves.toMatchObject({
      meta: { commitSeq: 2 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
    });
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("finishes cursor repair after committed read-back failed transiently", async () => {
    const { adapter, files, spies } = makeAdapter();
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    files.set(paths.committed, JSON.stringify(corrupt));
    let committedReads = 0;
    spies.read.mockImplementation(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      if (path === paths.committed && ++committedReads === 2) {
        throw new Error("committed read-back unavailable");
      }
      return value;
    });

    await expect(
      new StateEnvelopeV2Store(adapter, paths)
        .repairCursorOnly(envelope().scope, 2000),
    ).rejects.toMatchObject({ reason: "envelope-unreadable" });
    expect(JSON.parse(files.get(paths.committed)!)).toMatchObject({
      meta: { commitSeq: 2 },
    });
    expect(files.has(paths.recovery)).toBe(true);

    const restarted = new StateEnvelopeV2Store(adapter, paths);
    await expect(restarted.load(envelope().scope)).resolves.toMatchObject({
      meta: { commitSeq: 2 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
    });
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it.each([
    { name: "previous cleanup", failAtRemoveCall: 1 },
    { name: "journal cleanup", failAtRemoveCall: 2 },
  ])("converges when $name cleanup reports lost response", async ({ failAtRemoveCall }) => {
    const { adapter, files, spies } = makeAdapter();
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    files.set(paths.committed, JSON.stringify(corrupt));
    let removeCalls = 0;
    spies.remove.mockImplementation(async (path: string) => {
      files.delete(path);
      removeCalls += 1;
      if (removeCalls === failAtRemoveCall) {
        throw new Error("cleanup response lost");
      }
    });

    // F31 第九层：清理删除尽力而为——响应丢失（实际已删）不再中止本轮，
    // 直接返回修复结果；终态与下一轮收敛后的状态一致。
    const repaired = await new StateEnvelopeV2Store(adapter, paths)
      .repairCursorOnly(envelope().scope, 2000);
    expect(repaired).toMatchObject({
      meta: { commitSeq: 2 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
    });
    expect(JSON.parse(files.get(paths.committed)!)).toMatchObject({
      meta: { commitSeq: 2 },
    });
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.next)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);

    const restarted = new StateEnvelopeV2Store(adapter, paths);
    await expect(restarted.load(envelope().scope)).resolves.toMatchObject({
      meta: { commitSeq: 2 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
    });
  });

  it("preserves unknown envelope fields while repairing only cursor metadata", async () => {
    const { adapter, files } = makeAdapter();
    const corrupt = envelope() as SyncStateEnvelopeV2 & {
      futureEnvelopeField: { token: string };
    };
    corrupt.remoteIndex.cursorRevision = -1;
    corrupt.futureEnvelopeField = { token: "keep-envelope" };
    Object.assign(corrupt.remoteIndex, {
      futureRemoteIndexField: { token: "keep-index" },
    });
    Object.assign(corrupt.anchors.byAnchorId.anchor!, {
      futureAnchorField: { token: "keep-anchor" },
    });
    files.set(paths.committed, JSON.stringify(corrupt));

    const repaired = await new StateEnvelopeV2Store(adapter, paths)
      .repairCursorOnly(envelope().scope, 2000);

    expect(repaired).toMatchObject({
      futureEnvelopeField: { token: "keep-envelope" },
      remoteIndex: {
        futureRemoteIndexField: { token: "keep-index" },
        cursorRevision: 0,
        deltaLink: null,
      },
      anchors: {
        byAnchorId: {
          anchor: {
            futureAnchorField: { token: "keep-anchor" },
          },
        },
      },
    });
  });

  it("does not repair cursor metadata when any identity or anchor fact is invalid", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const corrupt = envelope();
    corrupt.remoteIndex.cursorRevision = -1;
    corrupt.anchors.byAnchorId.anchor!.anchorId = "wrong-anchor";
    const raw = JSON.stringify(corrupt);
    files.set(paths.committed, raw);

    await expect(store.repairCursorOnly(envelope().scope, 2000))
      .resolves.toBeNull();
    expect(files.get(paths.committed)).toBe(raw);
    expect(files.has(paths.previous)).toBe(false);
    expect(files.has(paths.next)).toBe(false);
    expect(files.has(paths.recovery)).toBe(false);
  });

  it("fails closed when the journal does not match either committed sequence", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    files.set(paths.committed, JSON.stringify(envelope(3)));
    files.set(paths.recovery, JSON.stringify({
      version: 1,
      status: "publishing",
      scope: envelope().scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 5,
    }));

    await expect(store.load(envelope().scope)).rejects.toThrow(
      "does not match local publication state",
    );
    expect(files.has(paths.recovery)).toBe(true);
  });

  it("allows a tombstoned remote identity but rejects folder identity, duplicate anchors and stale sequences", async () => {
    const { adapter, files } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const tombstoned = envelope();
    tombstoned.anchors.byAnchorId.anchor!.remoteId = "missing";
    await expect(store.publish(tombstoned)).resolves.toBeUndefined();
    expect(await store.load(tombstoned.scope)).toEqual(tombstoned);

    const { adapter: folderAdapter, files: folderFiles } = makeAdapter();
    const folderIdentity = envelope();
    folderIdentity.anchors.byAnchorId.anchor!.remoteId = "folder";
    await expect(new StateEnvelopeV2Store(folderAdapter, paths).publish(folderIdentity))
      .rejects.toThrow("non-file");
    expect(folderFiles.size).toBe(0);

    const { adapter: duplicateAdapter, files: duplicateFiles } = makeAdapter();
    const duplicate = envelope();
    duplicate.anchors.byAnchorId.second = { ...duplicate.anchors.byAnchorId.anchor!, anchorId: "second" };
    await expect(new StateEnvelopeV2Store(duplicateAdapter, paths).publish(duplicate))
      .rejects.toThrow("multiple anchors");
    expect(duplicateFiles.size).toBe(0);

    const { adapter: lineageAdapter, files: lineageFiles } = makeAdapter();
    const brokenLineage = envelope();
    brokenLineage.anchors.byAnchorId.anchor!.remoteIdentityLineage = [{
      fromRemoteId: "old-file",
      toRemoteId: "not-current-file",
      path: "note.md",
      contentHash: brokenLineage.anchors.byAnchorId.anchor!.contentHash,
      size: brokenLineage.anchors.byAnchorId.anchor!.size,
      confirmedAt: 2,
      confirmedBy: "equal-read",
    }];
    await expect(
      new StateEnvelopeV2Store(lineageAdapter, paths).publish(brokenLineage),
    ).rejects.toThrow("anchor is invalid");
    expect(lineageFiles.size).toBe(0);

    await expect(store.publish(envelope(3))).rejects.toThrow("must be 2");
  });

  it("loads pre-S5 envelopes but validates initialized folder identity generations", async () => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const initialized = envelope();
    initialized.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: {
        "folder:folder": {
          anchorId: "folder:folder",
          remoteId: "folder",
          lastPath: "notes",
          parentRemoteId: "root",
          confirmedGeneration: 1,
          confirmedAt: 1001,
        },
      },
    };
    await expect(store.publish(initialized)).resolves.toBeUndefined();
    expect((await store.load(initialized.scope))?.folderAnchors).toEqual(
      initialized.folderAnchors,
    );

    const { adapter: invalidAdapter } = makeAdapter();
    const invalid = envelope();
    invalid.folderAnchors = structuredClone(initialized.folderAnchors);
    invalid.folderAnchors.byAnchorId["folder:folder"]!.confirmedGeneration = 2;
    await expect(new StateEnvelopeV2Store(invalidAdapter, paths).publish(invalid))
      .rejects.toThrow("folder anchor is invalid");

    const { adapter: wrongKindAdapter } = makeAdapter();
    const wrongKind = envelope();
    wrongKind.folderAnchors = structuredClone(initialized.folderAnchors);
    wrongKind.folderAnchors.byAnchorId["folder:folder"]!.remoteId = "file";
    await expect(new StateEnvelopeV2Store(wrongKindAdapter, paths).publish(wrongKind))
      .rejects.toThrow("both file and folder anchors");
  });

  it("persists only a scope-recovery hold bound to the previous commit and same account", async () => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
    const held = envelope(2);
    held.remoteScopeRecovery = {
      schemaVersion: 1,
      kind: "v2-remote-scope-recovery",
      reason: "committed-scope-unreachable",
      sourceCommitSeq: 1,
      observedScope: {
        ...held.scope,
        vaultFolderId: "replacement-vault",
        filesRootId: "replacement-root",
      },
      observedAt: 2000,
    };

    await expect(store.publish(held)).resolves.toBeUndefined();
    expect((await store.load(held.scope))?.remoteScopeRecovery)
      .toEqual(held.remoteScopeRecovery);

    for (const corrupt of [
      { sourceCommitSeq: 2 },
      { sourceCommitSeq: 0 },
      { observedAt: Number.NaN },
      { observedAt: -1 },
      { observedScope: held.scope },
      {
        observedScope: {
          ...held.remoteScopeRecovery.observedScope,
          accountId: "other-account",
        },
      },
    ]) {
      const { adapter: invalidAdapter } = makeAdapter();
      const invalid = structuredClone(held);
      Object.assign(invalid.remoteScopeRecovery!, corrupt);
      await expect(
        new StateEnvelopeV2Store(invalidAdapter, paths).publish(invalid),
      ).rejects.toThrow("scope recovery hold is invalid");
    }
  });

  it("accepts only revision-bound bootstrap review phases while the path is absent", async () => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
    const pending = envelope(2);
    pending.remoteScopeRecovery = {
      schemaVersion: 1,
      kind: "v2-remote-scope-recovery",
      reason: "committed-scope-unreachable",
      sourceCommitSeq: 1,
      observedScope: null,
      observedAt: 2000,
      scopeBootstrap: {
        schemaVersion: 1,
        kind: "v2-remote-scope-bootstrap-review",
        phase: "pending",
        reviewSourceCommitSeq: 2,
        requestedAt: 2001,
      },
    };
    await expect(store.publish(pending)).resolves.toBeUndefined();

    const { adapter: confirmedAdapter } = makeAdapter();
    const confirmedStore = new StateEnvelopeV2Store(
      confirmedAdapter,
      paths,
    );
    await confirmedStore.publish(envelope());
    await confirmedStore.publish(pending);
    const confirmed = structuredClone(pending);
    confirmed.meta.commitSeq = 3;
    confirmed.remoteScopeRecovery!.sourceCommitSeq = 2;
    confirmed.remoteScopeRecovery!.scopeBootstrap = {
      ...confirmed.remoteScopeRecovery!.scopeBootstrap!,
      phase: "confirmed",
      confirmedAt: 2002,
    };
    await expect(confirmedStore.publish(confirmed)).resolves.toBeUndefined();

    for (const corrupt of [
      {
        ...structuredClone(pending),
        remoteScopeRecovery: {
          ...structuredClone(pending.remoteScopeRecovery!),
          observedScope: {
            ...pending.scope,
            vaultFolderId: "other-vault",
            filesRootId: "other-root",
          },
        },
      },
      {
        ...structuredClone(pending),
        remoteScopeRecovery: {
          ...structuredClone(pending.remoteScopeRecovery!),
          scopeBootstrap: {
            ...structuredClone(
              pending.remoteScopeRecovery!.scopeBootstrap!,
            ),
            reviewSourceCommitSeq: 1,
          },
        },
      },
      {
        ...structuredClone(confirmed),
        remoteScopeRecovery: {
          ...structuredClone(confirmed.remoteScopeRecovery!),
          scopeBootstrap: {
            ...structuredClone(
              confirmed.remoteScopeRecovery!.scopeBootstrap!,
            ),
            confirmedAt: undefined,
          },
        },
      },
    ]) {
      const { adapter: invalidAdapter } = makeAdapter();
      const invalidStore = new StateEnvelopeV2Store(
        invalidAdapter,
        paths,
      );
      await invalidStore.publish(envelope());
      if (corrupt.meta.commitSeq === 3) {
        await invalidStore.publish(pending);
      }
      await expect(
        invalidStore.publish(corrupt),
      ).rejects.toThrow("scope recovery hold is invalid");
    }
  });

  it.each(["accountId", "driveId", "vaultFolderId", "filesRootId"] as const)(
    "refuses to load an envelope when %s differs",
    async (field) => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    await store.publish(envelope());
      await expect(store.load({ ...envelope().scope, [field]: `other-${field}` })).rejects.toThrow("scope");
    },
  );

  it("rejects an index rooted at the outer vault folder instead of files/", async () => {
    const { adapter } = makeAdapter();
    const store = new StateEnvelopeV2Store(adapter, paths);
    const candidate = envelope();
    candidate.remoteIndex.filesRootId = candidate.scope.vaultFolderId;
    await expect(store.publish(candidate)).rejects.toThrow("remote index");
  });
});
