import { describe, expect, it, vi } from "vitest";
import type { SyncScope } from "../src/sync/types";
import {
  createMigrationGenerationV2,
  ensureSharedSyncProtocolV2,
  type SharedSyncProtocolObjectV2,
  type SharedSyncProtocolTransportV2,
  type SharedSyncProtocolV2,
} from "../src/sync/sync-protocol-v2";

const scope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};
const generationA = "a".repeat(64);
const generationB = "b".repeat(64);

function protocol(
  patch: Partial<SharedSyncProtocolV2> = {},
): SharedSyncProtocolV2 {
  return {
    schemaVersion: 1,
    kind: "easy-sync-v2-protocol",
    protocolVersion: 2,
    migrationGeneration: generationA,
    scope,
    confirmedAllDevicesUpdatedAt: 100,
    createdAt: 100,
    ...patch,
  };
}

function objectFor(
  value: unknown,
  id = "protocol-id",
): SharedSyncProtocolObjectV2 {
  return {
    id,
    eTag: "protocol-etag",
    content: JSON.stringify(value),
  };
}

function transportWith(
  initial: SharedSyncProtocolObjectV2 | null,
): {
  transport: SharedSyncProtocolTransportV2;
  spies: {
    read: ReturnType<typeof vi.fn>;
    createOnly: ReturnType<typeof vi.fn>;
    readById: ReturnType<typeof vi.fn>;
  };
  current: () => SharedSyncProtocolObjectV2 | null;
} {
  let current = initial;
  const read = vi.fn(async () => current);
  const createOnly = vi.fn(async (content: string) => {
    if (current) throw new Error("conflict");
    current = {
      id: "created-protocol-id",
      eTag: "created-protocol-etag",
      content,
    };
    return { id: current.id, eTag: current.eTag };
  });
  const readById = vi.fn(async (id: string) => {
    if (!current || current.id !== id) throw new Error("not found");
    return current;
  });
  return {
    transport: { read, createOnly, readById },
    spies: { read, createOnly, readById },
    current: () => current,
  };
}

describe("shared V2 sync protocol", () => {
  it("requires explicit migration-risk acknowledgement before first creation", async () => {
    const harness = transportWith(null);

    await expect(ensureSharedSyncProtocolV2(harness.transport, {
      scope,
      acknowledgeMigrationRisk: false,
    })).resolves.toEqual({ status: "acknowledgement-required" });
    expect(harness.spies.createOnly).not.toHaveBeenCalled();
    expect(harness.spies.readById).not.toHaveBeenCalled();
  });

  it("creates one immutable generation and verifies the exact content by ID", async () => {
    const harness = transportWith(null);

    await expect(ensureSharedSyncProtocolV2(harness.transport, {
      scope,
      acknowledgeMigrationRisk: true,
      now: 100,
      createMigrationGeneration: () => generationA,
    })).resolves.toEqual({
      status: "ready",
      source: "created",
      protocol: protocol(),
      binding: {
        schemaVersion: 1,
        protocolVersion: 2,
        migrationGeneration: generationA,
        confirmedAllDevicesUpdatedAt: 100,
        recordId: "created-protocol-id",
        recordETag: "created-protocol-etag",
      },
    });
    expect(harness.spies.createOnly).toHaveBeenCalledTimes(1);
    expect(harness.spies.readById).toHaveBeenCalledWith(
      "created-protocol-id",
    );
    expect(JSON.parse(harness.current()!.content)).toEqual(protocol());
  });

  it("adopts an existing compatible generation without overwriting it", async () => {
    const harness = transportWith(objectFor(protocol()));

    await expect(ensureSharedSyncProtocolV2(harness.transport, {
      scope,
      acknowledgeMigrationRisk: false,
      createMigrationGeneration: () => generationB,
    })).resolves.toMatchObject({
      status: "ready",
      source: "existing",
      protocol: { migrationGeneration: generationA },
      binding: { migrationGeneration: generationA },
    });
    expect(harness.spies.createOnly).not.toHaveBeenCalled();
  });

  it("adopts the compatible winner of a create-only race", async () => {
    const winner = objectFor(protocol(), "winner-id");
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const transport: SharedSyncProtocolTransportV2 = {
      read,
      createOnly: vi.fn().mockRejectedValue(new Error("409 conflict")),
      readById: vi.fn(),
    };

    await expect(ensureSharedSyncProtocolV2(transport, {
      scope,
      acknowledgeMigrationRisk: true,
      now: 200,
      createMigrationGeneration: () => generationB,
    })).resolves.toMatchObject({
      status: "ready",
      source: "create-race",
      protocol: { migrationGeneration: generationA },
      binding: { recordId: "winner-id" },
    });
  });

  it("blocks invalid, unsupported and scope-mismatched existing records", async () => {
    const otherScope = { ...scope, filesRootId: "other-files" };
    for (const [value, reason] of [
      ["not-json", "invalid-current"],
      [JSON.stringify({ ...protocol(), protocolVersion: 3 }), "unsupported-protocol"],
      [JSON.stringify(protocol({ scope: otherScope })), "scope-mismatch"],
    ] as const) {
      const harness = transportWith({
        id: "protocol-id",
        eTag: "etag",
        content: value,
      });
      await expect(ensureSharedSyncProtocolV2(harness.transport, {
        scope,
        acknowledgeMigrationRisk: true,
      })).resolves.toEqual({ status: "blocked", reason });
      expect(harness.spies.createOnly).not.toHaveBeenCalled();
    }
  });

  it("does not accept a mismatched creation readback", async () => {
    const harness = transportWith(null);
    harness.spies.readById.mockImplementationOnce(async (id: string) => ({
      id,
      eTag: "changed",
      content: JSON.stringify(protocol({
        migrationGeneration: generationB,
      })),
    }));

    await expect(ensureSharedSyncProtocolV2(harness.transport, {
      scope,
      acknowledgeMigrationRisk: true,
      now: 100,
      createMigrationGeneration: () => generationA,
    })).resolves.toEqual({
      status: "blocked",
      reason: "readback-mismatch",
    });
  });

  it("relocates the same generation into a recovered scope without another user confirmation", async () => {
    const harness = transportWith(null);
    const expectedBinding = {
      schemaVersion: 1 as const,
      protocolVersion: 2 as const,
      migrationGeneration: generationA,
      confirmedAllDevicesUpdatedAt: 100,
      recordId: "old-protocol-id",
      recordETag: "old-protocol-etag",
    };

    await expect(ensureSharedSyncProtocolV2(harness.transport, {
      scope: { ...scope, vaultFolderId: "recovered-vault" },
      acknowledgeMigrationRisk: false,
      expectedBinding,
      now: 300,
    })).resolves.toMatchObject({
      status: "ready",
      source: "created",
      protocol: {
        migrationGeneration: generationA,
        confirmedAllDevicesUpdatedAt: 100,
        createdAt: 300,
        scope: { vaultFolderId: "recovered-vault" },
      },
      binding: {
        migrationGeneration: generationA,
        confirmedAllDevicesUpdatedAt: 100,
        recordId: "created-protocol-id",
      },
    });
  });

  it("blocks a recovered scope that already advertises another generation", async () => {
    const harness = transportWith(objectFor(protocol({
      migrationGeneration: generationB,
    })));

    await expect(ensureSharedSyncProtocolV2(harness.transport, {
      scope,
      acknowledgeMigrationRisk: false,
      expectedBinding: {
        schemaVersion: 1,
        protocolVersion: 2,
        migrationGeneration: generationA,
        confirmedAllDevicesUpdatedAt: 100,
        recordId: "old-id",
        recordETag: "old-etag",
      },
    })).resolves.toEqual({
      status: "blocked",
      reason: "generation-mismatch",
    });
    expect(harness.spies.createOnly).not.toHaveBeenCalled();
  });

  it("generates a cryptographically random lowercase 256-bit identifier", () => {
    expect(createMigrationGenerationV2()).toMatch(/^[a-f0-9]{64}$/);
    expect(createMigrationGenerationV2()).not.toBe(createMigrationGenerationV2());
  });
});
