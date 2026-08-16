import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  classifySharedSyncProtocolProfile,
} from "../src/sync/shared-sync-protocol-profile";
import {
  serializeSharedSyncProtocolV2,
  type SharedSyncProtocolObjectV2,
  type SharedSyncProtocolV2,
} from "../src/sync/sync-protocol-v2";
import type {
  SharedSyncProtocolBindingV3,
  SharedSyncProtocolObjectV3,
  SharedSyncProtocolV3,
} from "../src/sync/sync-protocol-v3";
import type { SyncScope } from "../src/sync/types";

const generationA = "a".repeat(64);
const generationB = "b".repeat(64);
const oldScope: SyncScope = {
  accountId: "account",
  driveId: "drive-old",
  vaultFolderId: "vault-old",
  filesRootId: "files-old",
};
const targetScope: SyncScope = {
  accountId: "account",
  driveId: "drive-new",
  vaultFolderId: "vault-new",
  filesRootId: "files-new",
};

function v2Protocol(
  patch: Partial<SharedSyncProtocolV2> = {},
): SharedSyncProtocolV2 {
  return {
    schemaVersion: 1,
    kind: "easy-sync-v2-protocol",
    protocolVersion: 2,
    migrationGeneration: generationA,
    scope: oldScope,
    confirmedAllDevicesUpdatedAt: 100,
    createdAt: 110,
    ...patch,
  };
}

function v2Object(
  value: SharedSyncProtocolV2 = v2Protocol(),
): SharedSyncProtocolObjectV2 {
  return {
    id: "v2-id",
    eTag: "v2-etag",
    content: serializeSharedSyncProtocolV2(value),
  };
}

async function lineageFixture(): Promise<{
  v2: SharedSyncProtocolObjectV2;
  v3: SharedSyncProtocolObjectV3;
  binding: SharedSyncProtocolBindingV3;
}> {
  const v2 = v2Object();
  const predecessorContentSha256 = await digest(v2.content);
  const protocol: SharedSyncProtocolV3 = {
    schemaVersion: 1,
    kind: "easy-sync-generation-protocol",
    protocolVersion: 3,
    migrationGeneration: generationA,
    predecessor: {
      protocolVersion: 2,
      contentSha256: predecessorContentSha256,
    },
    createdAt: 110,
  };
  const v3: SharedSyncProtocolObjectV3 = {
    id: "v3-id",
    eTag: "v3-etag",
    content: JSON.stringify(protocol),
  };
  return {
    v2,
    v3,
    binding: {
      schemaVersion: 1,
      protocolVersion: 3,
      migrationGeneration: generationA,
      predecessorProtocolVersion: 2,
      predecessorContentSha256,
      predecessorConfirmedAllDevicesUpdatedAt: 100,
      createdAt: 110,
      contentSha256: await digest(v3.content),
      recordId: v3.id,
      recordETag: v3.eTag,
    },
  };
}

describe("shared sync protocol profile", () => {
  it("classifies an unbound empty target and a current-scope V2 predecessor", async () => {
    await expect(classifySharedSyncProtocolProfile({
      v2: null,
      v3: null,
      targetScope,
    })).resolves.toEqual({ status: "empty" });

    await expect(classifySharedSyncProtocolProfile({
      v2: v2Object(v2Protocol({ scope: targetScope })),
      v3: null,
      targetScope,
    })).resolves.toMatchObject({
      status: "legacy-v2",
      migrationGeneration: generationA,
    });
  });

  it("accepts a closed V2 and V3 lineage across scope changes", async () => {
    const fixture = await lineageFixture();

    await expect(classifySharedSyncProtocolProfile({
      v2: fixture.v2,
      v3: fixture.v3,
      targetScope,
    })).resolves.toMatchObject({
      status: "healthy",
      migrationGeneration: generationA,
    });

    await expect(classifySharedSyncProtocolProfile({
      v2: fixture.v2,
      v3: fixture.v3,
      targetScope,
      expectedBinding: {
        ...fixture.binding,
        predecessorConfirmedAllDevicesUpdatedAt: 99,
      },
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "binding-mismatch",
    });
  });

  it("reconstructs only missing slots from a current trusted binding", async () => {
    const fixture = await lineageFixture();

    await expect(classifySharedSyncProtocolProfile({
      v2: null,
      v3: fixture.v3,
      targetScope,
      expectedBinding: fixture.binding,
      predecessorScope: oldScope,
    })).resolves.toMatchObject({
      status: "recoverable",
      missing: ["v2"],
      migrationGeneration: generationA,
      canonicalV2Content: fixture.v2.content,
    });

    await expect(classifySharedSyncProtocolProfile({
      v2: fixture.v2,
      v3: null,
      targetScope,
      expectedBinding: fixture.binding,
      predecessorScope: oldScope,
    })).resolves.toMatchObject({
      status: "recoverable",
      missing: ["v3"],
    });

    await expect(classifySharedSyncProtocolProfile({
      v2: null,
      v3: null,
      targetScope,
      expectedBinding: fixture.binding,
      predecessorScope: oldScope,
    })).resolves.toMatchObject({
      status: "recoverable",
      missing: ["v2", "v3"],
    });
  });

  it("keeps an unbound V3-only target and an unbound historical V2 fail closed", async () => {
    const fixture = await lineageFixture();

    await expect(classifySharedSyncProtocolProfile({
      v2: null,
      v3: fixture.v3,
      targetScope,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "v3-only-unbound",
    });
    await expect(classifySharedSyncProtocolProfile({
      v2: fixture.v2,
      v3: null,
      targetScope,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "v2-scope-mismatch",
    });
  });

  it("rejects wrong generations and predecessor digests", async () => {
    const fixture = await lineageFixture();
    const wrongGeneration = {
      ...JSON.parse(fixture.v3.content),
      migrationGeneration: generationB,
    };
    const wrongPredecessor = structuredClone(JSON.parse(fixture.v3.content));
    wrongPredecessor.predecessor.contentSha256 = "c".repeat(64);

    await expect(classifySharedSyncProtocolProfile({
      v2: fixture.v2,
      v3: { ...fixture.v3, content: JSON.stringify(wrongGeneration) },
      targetScope,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "generation-mismatch",
    });
    await expect(classifySharedSyncProtocolProfile({
      v2: fixture.v2,
      v3: { ...fixture.v3, content: JSON.stringify(wrongPredecessor) },
      targetScope,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "predecessor-mismatch",
    });
  });

  it("returns only bounded diagnostic evidence for an inconsistent lineage", async () => {
    const fixture = await lineageFixture();
    const wrongGeneration = {
      ...JSON.parse(fixture.v3.content),
      migrationGeneration: generationB,
    };

    await expect(classifySharedSyncProtocolProfile({
      v2: fixture.v2,
      v3: { ...fixture.v3, content: JSON.stringify(wrongGeneration) },
      targetScope,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "generation-mismatch",
      evidence: {
        status: "inconsistent",
        reason: "generation-mismatch",
        v2Generation: generationA.slice(0, 12),
        v3Generation: generationB.slice(0, 12),
        predecessor: "match",
      },
    });
  });

  it("rejects occupied recovery slots and incomplete binding proof", async () => {
    const fixture = await lineageFixture();

    await expect(classifySharedSyncProtocolProfile({
      v2: v2Object(v2Protocol({ migrationGeneration: generationB })),
      v3: fixture.v3,
      targetScope,
      expectedBinding: fixture.binding,
      predecessorScope: oldScope,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "target-slot-occupied",
    });
    await expect(classifySharedSyncProtocolProfile({
      v2: null,
      v3: fixture.v3,
      targetScope,
      expectedBinding: {
        ...fixture.binding,
        predecessorContentSha256: "d".repeat(64),
      },
      predecessorScope: oldScope,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "binding-mismatch",
    });
    await expect(classifySharedSyncProtocolProfile({
      v2: null,
      v3: fixture.v3,
      targetScope,
      expectedBinding: fixture.binding,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "recovery-proof-incomplete",
    });
    await expect(classifySharedSyncProtocolProfile({
      v2: null,
      v3: fixture.v3,
      targetScope,
      expectedBinding: {
        ...fixture.binding,
        recordETag: "stale-etag",
      },
      predecessorScope: oldScope,
    })).resolves.toMatchObject({
      status: "inconsistent",
      reason: "binding-mismatch",
    });
  });

  it.each([
    ["damaged V2", { id: "v2", eTag: "etag", content: "{" }, null,
      "invalid-v2"],
    ["future V2", { id: "v2", eTag: "etag", content: JSON.stringify({
      ...v2Protocol(), protocolVersion: 4,
    }) }, null, "unsupported-v2"],
    ["damaged V3", null, { id: "v3", eTag: "etag", content: "{" },
      "invalid-v3"],
    ["future V3", null, { id: "v3", eTag: "etag", content: JSON.stringify({
      schemaVersion: 1,
      kind: "easy-sync-generation-protocol",
      protocolVersion: 4,
    }) }, "unsupported-v3"],
  ] as const)("rejects %s", async (_label, v2, v3, reason) => {
    await expect(classifySharedSyncProtocolProfile({
      v2,
      v3,
      targetScope,
    })).resolves.toMatchObject({ status: "inconsistent", reason });
  });
});

async function digest(content: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(content).buffer);
}
