import { describe, expect, it } from "vitest";
import {
  applyLocalDeleteDecisions,
  collectLocalDeleteDecisionCoveredPaths,
  localDeleteDecisionCompositionAuthorized,
  localDeleteDecisionPathHash,
  localDeleteDecisionRecordToken,
  localFolderDeleteDecisionPathHash,
  localFolderDeleteDecisionRecordToken,
  readLocalDeleteDecisions,
  resolveLocalDeleteReviewDisposition,
  serializeLocalDeleteDecisionHashes,
  type LocalDeleteDecisionScopeV1,
  type LocalDeleteDecisionV1,
} from "../src/sync/local-delete-decision";
import type { CanonicalPlanIdentityV2 } from "../src/sync/types";
import {
  SyncActionType,
  type SyncDecisionToken,
  type SyncPlanItem,
} from "../src/sync/types";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function token(input: {
  accountId?: string;
  hash?: string;
  size?: number;
  ancestorHash?: string | null;
} = {}): SyncDecisionToken {
  return {
    version: 1,
    vaultName: "Vault",
    accountId: input.accountId ?? "account",
    scope: {
      accountId: input.accountId ?? "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "root",
    },
    local: {
      exists: true,
      hash: input.hash ?? hashA,
      size: input.size ?? 10,
    },
    remote: { exists: false },
    ancestorHash: input.ancestorHash === undefined
      ? hashA
      : input.ancestorHash,
  };
}

function confirmItem(
  path: string,
  decisionToken: SyncDecisionToken = token(),
): SyncPlanItem {
  return {
    type: SyncActionType.ConfirmLocalDelete,
    path,
    local: {
      path,
      hash: decisionToken.local.exists
        ? decisionToken.local.hash
        : hashA,
      size: decisionToken.local.exists
        ? decisionToken.local.size
        : 10,
      mtime: 1,
      binary: false,
    },
    decisionToken,
  };
}

function decision(
  paths: string[],
  hashes: string[],
  tokenValue = "record",
): LocalDeleteDecisionV1 {
  return {
    kind: "file",
    token: tokenValue,
    paths,
    planDigest: serializeLocalDeleteDecisionHashes(hashes),
    createdAt: 1,
  };
}

function apply(input: {
  items: SyncPlanItem[];
  decisions: LocalDeleteDecisionV1[];
  localPaths?: string[];
  remotePaths?: string[];
}) {
  return applyLocalDeleteDecisions({
    items: input.items,
    decisions: input.decisions,
    localPathsPresent: new Set(input.localPaths ?? []),
    remotePathsPresent: new Set(input.remotePaths ?? []),
  });
}

describe("local delete decision (S4)", () => {
  it("uses a stable scope record token and a path-bound fact hash", () => {
    const first = token();
    const sameScope = token();
    const otherScope = token({ accountId: "other" });
    expect(localDeleteDecisionRecordToken(first))
      .toContain("local-delete:");
    expect(localDeleteDecisionRecordToken(first))
      .toBe(localDeleteDecisionRecordToken(sameScope));
    expect(localDeleteDecisionRecordToken(first))
      .not.toBe(localDeleteDecisionRecordToken(otherScope));
    expect(localDeleteDecisionPathHash(first, "note.md"))
      .toBe(localDeleteDecisionPathHash(sameScope, "note.md"));
    expect(localDeleteDecisionPathHash(first, "note.md"))
      .not.toBe(localDeleteDecisionPathHash(first, "other.md"));
    expect(localDeleteDecisionPathHash(first, "note.md"))
      .not.toBe(localDeleteDecisionPathHash(token({ hash: hashB }), "note.md"));
  });

  it("converts exactly the row whose recorded facts still match", () => {
    const item = confirmItem("note.md");
    const record = decision(
      ["note.md"],
      [localDeleteDecisionPathHash(item.decisionToken!, "note.md")],
    );
    const result = apply({
      items: [item],
      decisions: [record],
      localPaths: ["note.md"],
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.DeleteLocal,
        path: "note.md",
      }),
    ]);
    expect(result.applied).toEqual([{ kind: "file", token: "record", path: "note.md" }]);
    expect(result.rejected).toEqual([]);
    expect(result.nextDecisions).toEqual([record]);
  });

  it("keeps the confirmation row and never consumes on a fact-hash mismatch", () => {
    const item = confirmItem("note.md");
    const result = apply({
      items: [item],
      decisions: [decision(["note.md"], ["0".repeat(16)])],
      localPaths: ["note.md"],
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path: "note.md",
      }),
    ]);
    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        path: "note.md",
        reason: "path facts changed since confirmation",
      }),
    ]);
    expect(result.nextDecisions).toHaveLength(1);
  });

  it("refuses the whole record when one path is mismatched", () => {
    const first = confirmItem("a.md");
    const second = confirmItem("b.md");
    const result = apply({
      items: [first, second],
      decisions: [decision(
        ["a.md", "b.md"],
        [
          localDeleteDecisionPathHash(first.decisionToken!, "a.md"),
          "f".repeat(16),
        ],
      )],
      localPaths: ["a.md", "b.md"],
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path: "a.md",
      }),
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path: "b.md",
      }),
    ]);
    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ path: "b.md" }),
    ]);
  });

  it("prunes only a path proven absent on both sides and keeps the rest applicable", () => {
    const first = confirmItem("a.md");
    const result = apply({
      items: [first],
      decisions: [decision(
        ["a.md", "gone.md"],
        [
          localDeleteDecisionPathHash(first.decisionToken!, "a.md"),
          "0".repeat(16),
        ],
      )],
      localPaths: ["a.md"],
      remotePaths: [],
    });
    expect(result.applied).toEqual([{ kind: "file", token: "record", path: "a.md" }]);
    expect(result.pruned).toEqual([
      expect.objectContaining({
        path: "gone.md",
        reason: "path is already absent locally and remotely",
      }),
    ]);
    expect(result.nextDecisions[0].paths).toEqual(["a.md"]);
    expect(result.nextDecisions[0].planDigest).toBe(
      serializeLocalDeleteDecisionHashes([
        localDeleteDecisionPathHash(first.decisionToken!, "a.md"),
      ]),
    );
  });

  it("does not prune a missing path while the local or remote side still exists", () => {
    const first = confirmItem("a.md");
    const result = apply({
      items: [first],
      decisions: [decision(
        ["a.md", "out-of-scope.md"],
        [
          localDeleteDecisionPathHash(first.decisionToken!, "a.md"),
          "0".repeat(16),
        ],
      )],
      localPaths: ["a.md", "out-of-scope.md"],
      remotePaths: [],
    });
    expect(result.applied).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ path: "out-of-scope.md" }),
    ]);
  });

  it("treats an unreadable or misaligned digest as never authorizing", () => {
    const item = confirmItem("note.md");
    const result = apply({
      items: [item],
      decisions: [{
        token: "record",
        paths: ["note.md"],
        planDigest: "not-json",
        createdAt: 1,
      }],
      localPaths: ["note.md"],
    });
    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ reason: "record digest is unreadable" }),
    ]);
  });

  it("drops a persisted record whose hash list does not align with its paths", () => {
    expect(readLocalDeleteDecisions([{
      token: "record",
      paths: ["a.md", "b.md"],
      planDigest: serializeLocalDeleteDecisionHashes(["0".repeat(16)]),
      createdAt: 1,
    }])).toEqual([]);
    expect(readLocalDeleteDecisions([{
      token: "record",
      paths: ["a.md"],
      planDigest: serializeLocalDeleteDecisionHashes(["0".repeat(16)]),
      createdAt: 1,
    }])).toHaveLength(1);
  });

  it("verifies the D0+decision composition against the live records and converted items", () => {
    const item = confirmItem("a.md");
    const appliedItem: SyncPlanItem = {
      ...item,
      type: SyncActionType.DeleteLocal,
    };
    const hash = localDeleteDecisionPathHash(item.decisionToken!, "a.md");
    const record = decision(["a.md"], [hash]);
    expect(localDeleteDecisionCompositionAuthorized({
      decisions: [record],
      applied: [{ token: "record", path: "a.md" }],
      items: [appliedItem],
    })).toBe(true);
    expect(localDeleteDecisionCompositionAuthorized({
      decisions: [],
      applied: [{ token: "record", path: "a.md" }],
      items: [appliedItem],
    })).toBe(false);
    expect(localDeleteDecisionCompositionAuthorized({
      decisions: [record],
      applied: [{ token: "record", path: "a.md" }],
      items: [{
        ...appliedItem,
        decisionToken: token({ hash: hashB }),
      }],
    })).toBe(false);
    expect(localDeleteDecisionCompositionAuthorized({
      decisions: [decision(["a.md"], ["0".repeat(16)])],
      applied: [{ token: "record", path: "a.md" }],
      items: [appliedItem],
    })).toBe(false);
  });

  it("classifies the reviewed plan as current, composed, threshold-re-review or changed", () => {
    const identity = (digest: string): CanonicalPlanIdentityV2 => ({
      version: 2,
      scope: token().scope,
      sourceCommitSeq: 1,
      digest,
    });
    const d0 = identity("d0");
    const d1 = identity("d1");
    const classify = (input: {
      reviewed?: CanonicalPlanIdentityV2;
      plan?: CanonicalPlanIdentityV2;
      pre?: CanonicalPlanIdentityV2;
      composition: boolean;
      threshold: boolean;
      preThreshold: boolean;
    }) => resolveLocalDeleteReviewDisposition({
      reviewedIdentity: input.reviewed,
      planIdentity: input.plan,
      preDecisionIdentity: input.pre,
      compositionAuthorized: input.composition,
      requiresThresholdConfirmation: input.threshold,
      preDecisionRequiresThresholdConfirmation: input.preThreshold,
    });

    expect(classify({
      reviewed: d1,
      plan: d1,
      pre: d0,
      composition: false,
      threshold: true,
      preThreshold: false,
    })).toBe("current");
    expect(classify({
      reviewed: d0,
      plan: d1,
      pre: d0,
      composition: true,
      threshold: false,
      preThreshold: false,
    })).toBe("compose");
    expect(classify({
      reviewed: d0,
      plan: d1,
      pre: d0,
      composition: true,
      threshold: true,
      preThreshold: false,
    })).toBe("threshold-re-review");
    expect(classify({
      reviewed: d0,
      plan: d1,
      pre: d0,
      composition: false,
      threshold: false,
      preThreshold: false,
    })).toBe("changed");
    expect(classify({
      reviewed: identity("other"),
      plan: d1,
      pre: d0,
      composition: true,
      threshold: false,
      preThreshold: false,
    })).toBe("changed");
    expect(classify({
      reviewed: undefined,
      plan: undefined,
      pre: undefined,
      composition: false,
      threshold: false,
      preThreshold: false,
    })).toBe("current");
  });
});


describe("local folder delete decision (S5)", () => {
  const scope: LocalDeleteDecisionScopeV1 = {
    vaultName: "Vault",
    accountId: "account",
    scope: {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "root",
    },
  };

  function folderItem(overrides: Partial<SyncPlanItem> = {}): SyncPlanItem {
    return {
      type: SyncActionType.DeleteLocalFolder,
      path: "Folder",
      requiresConfirmation: true,
      reviewImpactCount: 1,
      folder: {
        remoteId: "folder-id",
        remoteETag: "etag",
        parentRemoteId: "root",
        parentPath: "",
        parentRemoteETag: "root-etag",
        sourceParentRemoteId: "root",
      },
      ...overrides,
    };
  }

  function folderDecision(item: SyncPlanItem): LocalDeleteDecisionV1 {
    const hash = localFolderDeleteDecisionPathHash(item, scope);
    if (hash === null) throw new Error("folder item has no decision hash");
    return {
      kind: "folder",
      token: localFolderDeleteDecisionRecordToken(scope),
      paths: [item.path],
      planDigest: serializeLocalDeleteDecisionHashes([hash]),
      createdAt: 1,
    };
  }

  it("applies a folder decision only to the exact row and clears the confirmation", () => {
    const item = folderItem();
    const record = folderDecision(item);
    const result = applyLocalDeleteDecisions({
      items: [item],
      decisions: [record],
      localPathsPresent: new Set(),
      remotePathsPresent: new Set(),
      localFolderPathsPresent: new Set([item.path]),
      remoteFolderPathsPresent: new Set([item.path]),
      decisionScope: scope,
    });
    expect(result.items[0]).toEqual(expect.objectContaining({
      type: SyncActionType.DeleteLocalFolder,
      path: "Folder",
      requiresConfirmation: false,
    }));
    expect(result.applied).toEqual([{
      kind: "folder",
      token: record.token,
      path: "Folder",
    }]);
    expect(result.nextDecisions).toEqual([record]);
  });

  it("rejects a folder decision when the committed anchor facts changed", () => {
    const item = folderItem();
    const record = folderDecision(item);
    const changed = folderItem({
      folder: { ...item.folder!, remoteETag: "other-etag" },
    });
    const result = applyLocalDeleteDecisions({
      items: [changed],
      decisions: [record],
      localPathsPresent: new Set(),
      remotePathsPresent: new Set(),
      localFolderPathsPresent: new Set([changed.path]),
      remoteFolderPathsPresent: new Set([changed.path]),
      decisionScope: scope,
    });
    expect(result.items[0].requiresConfirmation).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        kind: "folder",
        path: "Folder",
        reason: "path facts changed since confirmation",
      }),
    ]);
  });

  it("hides only a folder row whose facts still match the record", () => {
    const item = folderItem();
    const record = folderDecision(item);
    expect([
      ...collectLocalDeleteDecisionCoveredPaths({
        decisions: [record],
        items: [item],
        decisionScope: scope,
      }),
    ]).toEqual(["Folder"]);
    const changed = folderItem({
      folder: { ...item.folder!, parentRemoteId: "other-parent" },
    });
    expect(collectLocalDeleteDecisionCoveredPaths({
      decisions: [record],
      items: [changed],
      decisionScope: scope,
    }).size).toBe(0);
  });

  it("authorizes the converted folder row in the reviewed-plan composition", () => {
    const item = folderItem();
    const record = folderDecision(item);
    const converted = { ...item, requiresConfirmation: false };
    const entry = {
      kind: "folder" as const,
      token: record.token,
      path: "Folder",
    };
    expect(localDeleteDecisionCompositionAuthorized({
      decisions: [record],
      applied: [entry],
      items: [converted],
      decisionScope: scope,
    })).toBe(true);
    expect(localDeleteDecisionCompositionAuthorized({
      decisions: [record],
      applied: [entry],
      items: [converted],
    })).toBe(false);
  });
});
