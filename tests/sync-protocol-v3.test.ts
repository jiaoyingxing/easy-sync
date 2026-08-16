import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import type {
  SharedSyncProtocolBindingV2,
  SharedSyncProtocolObjectV2,
  SharedSyncProtocolV2,
} from "../src/sync/sync-protocol-v2";
import {
  ensureSharedSyncProtocolV3,
  isSharedSyncProtocolBindingTransitionAllowed,
  type SharedSyncProtocolBindingV3,
  type SharedSyncProtocolObjectV3,
  type SharedSyncProtocolTransportV3,
} from "../src/sync/sync-protocol-v3";

const generationA = "a".repeat(64);
const generationB = "b".repeat(64);

function predecessor(): SharedSyncProtocolObjectV2 {
  const value: SharedSyncProtocolV2 = {
    schemaVersion: 1,
    kind: "easy-sync-v2-protocol",
    protocolVersion: 2,
    migrationGeneration: generationA,
    scope: {
      accountId: "account-old",
      driveId: "drive-old",
      vaultFolderId: "vault-old",
      filesRootId: "files-old",
    },
    confirmedAllDevicesUpdatedAt: 100,
    createdAt: 110,
  };
  return {
    id: "protocol-v2-id",
    eTag: "protocol-v2-etag",
    content: JSON.stringify(value),
  };
}

function v2Binding(): SharedSyncProtocolBindingV2 {
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    migrationGeneration: generationA,
    confirmedAllDevicesUpdatedAt: 100,
    recordId: "protocol-v2-id",
    recordETag: "protocol-v2-etag",
  };
}

function transportWith(initial: SharedSyncProtocolObjectV3 | null): {
  transport: SharedSyncProtocolTransportV3;
  read: ReturnType<typeof vi.fn>;
  createOnly: ReturnType<typeof vi.fn>;
  readById: ReturnType<typeof vi.fn>;
  current(): SharedSyncProtocolObjectV3 | null;
} {
  let current = initial;
  const read = vi.fn(async () => current);
  const createOnly = vi.fn(async (content: string) => {
    if (current) throw new Error("conflict");
    current = {
      id: "protocol-v3-id",
      eTag: "protocol-v3-etag",
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
    read,
    createOnly,
    readById,
    current: () => current,
  };
}

async function digest(content: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(content).buffer);
}

describe("shared V3 sync protocol", () => {
  it("creates a scope-free generation from the exact V2 predecessor", async () => {
    const harness = transportWith(null);
    const old = predecessor();
    const result = await ensureSharedSyncProtocolV3(harness.transport, {
      predecessor: old,
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await harness.transport.read(),
      observeAfterCreateFailure: () => harness.transport.read(),
    });

    expect(result).toMatchObject({
      status: "ready",
      source: "created",
      protocol: {
        protocolVersion: 3,
        migrationGeneration: generationA,
        createdAt: 110,
      },
      binding: {
        protocolVersion: 3,
        migrationGeneration: generationA,
        predecessorConfirmedAllDevicesUpdatedAt: 100,
        recordId: "protocol-v3-id",
      },
    });
    expect(JSON.parse(harness.current()!.content)).not.toHaveProperty("scope");
    expect(JSON.parse(harness.current()!.content).predecessor).toEqual({
      protocolVersion: 2,
      contentSha256: await digest(old.content),
    });
    expect(harness.readById).toHaveBeenCalledWith("protocol-v3-id");
    expect(harness.read).toHaveBeenCalledTimes(1);
  });

  it("adopts an exact existing record without overwriting", async () => {
    const seed = transportWith(null);
    const created = await ensureSharedSyncProtocolV3(seed.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await seed.transport.read(),
      observeAfterCreateFailure: () => seed.transport.read(),
    });
    expect(created.status).toBe("ready");
    const harness = transportWith(seed.current());

    await expect(ensureSharedSyncProtocolV3(harness.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: false,
      observedCurrent: await harness.transport.read(),
      observeAfterCreateFailure: () => harness.transport.read(),
    })).resolves.toMatchObject({ status: "ready", source: "existing" });
    expect(harness.createOnly).not.toHaveBeenCalled();
    expect(harness.read).toHaveBeenCalledTimes(1);
  });

  it("recreates the exact protocol from an already-bound V3 authority", async () => {
    const first = transportWith(null);
    const created = await ensureSharedSyncProtocolV3(first.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await first.transport.read(),
      observeAfterCreateFailure: () => first.transport.read(),
    });
    if (created.status !== "ready") throw new Error("fixture creation failed");
    const target = transportWith(null);

    const recreated = await ensureSharedSyncProtocolV3(target.transport, {
      expectedBinding: created.binding,
      allowCreate: true,
      observedCurrent: await target.transport.read(),
      observeAfterCreateFailure: () => target.transport.read(),
    });

    expect(recreated).toMatchObject({
      status: "ready",
      source: "created",
      binding: {
        contentSha256: created.binding.contentSha256,
        predecessorContentSha256:
          created.binding.predecessorContentSha256,
      },
    });
    expect(target.current()!.content).toBe(first.current()!.content);
  });

  it("adopts the exact winner of a create-only race", async () => {
    const seed = transportWith(null);
    await ensureSharedSyncProtocolV3(seed.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await seed.transport.read(),
      observeAfterCreateFailure: () => seed.transport.read(),
    });
    const winner = seed.current();
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const transport: SharedSyncProtocolTransportV3 = {
      read,
      createOnly: vi.fn().mockRejectedValue(new Error("409")),
      readById: vi.fn(),
    };

    await expect(ensureSharedSyncProtocolV3(transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await transport.read(),
      observeAfterCreateFailure: () => transport.read(),
    })).resolves.toMatchObject({ status: "ready", source: "create-race" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails closed when create read-back changes the immutable content", async () => {
    const transport: SharedSyncProtocolTransportV3 = {
      read: vi.fn().mockResolvedValue(null),
      createOnly: vi.fn().mockResolvedValue({
        id: "protocol-v3-id",
        eTag: "protocol-v3-etag",
      }),
      readById: vi.fn().mockResolvedValue({
        id: "protocol-v3-id",
        eTag: "protocol-v3-etag",
        content: "{}",
      }),
    };

    await expect(ensureSharedSyncProtocolV3(transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await transport.read(),
      observeAfterCreateFailure: () => transport.read(),
    })).resolves.toEqual({ status: "blocked", reason: "readback-mismatch" });
  });

  it("blocks creation without predecessor or bound V3 authority", async () => {
    const harness = transportWith(null);
    await expect(ensureSharedSyncProtocolV3(harness.transport, {
      allowCreate: true,
      observedCurrent: await harness.transport.read(),
      observeAfterCreateFailure: () => harness.transport.read(),
    })).resolves.toEqual({
      status: "blocked",
      reason: "predecessor-required",
    });
    expect(harness.createOnly).not.toHaveBeenCalled();
  });

  it("does not derive V3 from a different V2 object than the local binding", async () => {
    const harness = transportWith(null);
    await expect(ensureSharedSyncProtocolV3(harness.transport, {
      predecessor: {
        ...predecessor(),
        id: "different-v2-id",
      },
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await harness.transport.read(),
      observeAfterCreateFailure: () => harness.transport.read(),
    })).resolves.toEqual({
      status: "blocked",
      reason: "predecessor-mismatch",
    });
    expect(harness.createOnly).not.toHaveBeenCalled();
  });

  it("blocks a conflicting generation and a non-canonical record", async () => {
    const first = transportWith(null);
    await ensureSharedSyncProtocolV3(first.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await first.transport.read(),
      observeAfterCreateFailure: () => first.transport.read(),
    });
    const conflicting = JSON.parse(first.current()!.content);
    conflicting.migrationGeneration = generationB;
    const generationConflict = transportWith({
      ...first.current()!,
      content: JSON.stringify(conflicting),
    });
    await expect(ensureSharedSyncProtocolV3(generationConflict.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: false,
      observedCurrent: await generationConflict.transport.read(),
      observeAfterCreateFailure: () => generationConflict.transport.read(),
    })).resolves.toEqual({ status: "blocked", reason: "generation-mismatch" });

    conflicting.migrationGeneration = generationA;
    conflicting.scope = { filesRootId: "must-not-exist" };
    const nonCanonical = transportWith({
      ...first.current()!,
      content: JSON.stringify(conflicting),
    });
    await expect(ensureSharedSyncProtocolV3(nonCanonical.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: false,
      observedCurrent: await nonCanonical.transport.read(),
      observeAfterCreateFailure: () => nonCanonical.transport.read(),
    })).resolves.toEqual({ status: "blocked", reason: "invalid-current" });
  });

  it("allows only monotonic exact V2 to V3 binding transitions", async () => {
    const harness = transportWith(null);
    const result = await ensureSharedSyncProtocolV3(harness.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await harness.transport.read(),
      observeAfterCreateFailure: () => harness.transport.read(),
    });
    if (result.status !== "ready") throw new Error("fixture creation failed");
    const v3 = result.binding;

    expect(isSharedSyncProtocolBindingTransitionAllowed(v2Binding(), v3))
      .toBe(true);
    expect(isSharedSyncProtocolBindingTransitionAllowed(v3, v2Binding()))
      .toBe(false);
    expect(isSharedSyncProtocolBindingTransitionAllowed(v3, {
      ...v3,
      contentSha256: "c".repeat(64),
    } satisfies SharedSyncProtocolBindingV3)).toBe(false);
  });

  it("allows an exact V3 record to move without changing its lineage", async () => {
    const first = transportWith(null);
    const created = await ensureSharedSyncProtocolV3(first.transport, {
      predecessor: predecessor(),
      expectedBinding: v2Binding(),
      allowCreate: true,
      observedCurrent: await first.transport.read(),
      observeAfterCreateFailure: () => first.transport.read(),
    });
    if (created.status !== "ready") throw new Error("fixture creation failed");
    const moved = transportWith({
      id: "protocol-v3-moved",
      eTag: "protocol-v3-moved-etag",
      content: first.current()!.content,
    });

    const adopted = await ensureSharedSyncProtocolV3(moved.transport, {
      expectedBinding: created.binding,
      allowCreate: false,
      observedCurrent: await moved.transport.read(),
      observeAfterCreateFailure: () => moved.transport.read(),
    });
    expect(adopted).toMatchObject({
      status: "ready",
      source: "existing",
      binding: {
        recordId: "protocol-v3-moved",
        contentSha256: created.binding.contentSha256,
      },
    });
    if (adopted.status !== "ready") throw new Error("adoption failed");
    expect(isSharedSyncProtocolBindingTransitionAllowed(
      created.binding,
      adopted.binding,
    )).toBe(true);
  });
});
