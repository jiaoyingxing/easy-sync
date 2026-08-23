import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import type { SyncScope } from "../src/sync/types";
import {
  createMigrationGenerationV2,
  ensureCanonicalSharedSyncProtocolV2,
  ensureSharedSyncProtocolV2,
  repairCanonicalSharedSyncProtocolV2,
  serializeSharedSyncProtocolV2,
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
    overwriteOnly: ReturnType<typeof vi.fn>;
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
  const overwriteOnly = vi.fn(async (
    id: string,
    eTag: string,
    content: string,
  ) => {
    if (!current || current.id !== id || current.eTag !== eTag) {
      throw new Error("overwrite conflict");
    }
    current = { id, eTag: `${eTag}-overwritten`, content };
    return { id: current.id, eTag: current.eTag };
  });
  const readById = vi.fn(async (id: string) => {
    if (!current || current.id !== id) throw new Error("not found");
    return current;
  });
  return {
    transport: { read, createOnly, overwriteOnly, readById },
    spies: { read, createOnly, overwriteOnly, readById },
    current: () => current,
  };
}

async function ensureObservedV2(
  transport: SharedSyncProtocolTransportV2,
  input: Omit<
    Parameters<typeof ensureSharedSyncProtocolV2>[1],
    "observedCurrent" | "observeAfterCreateFailure"
  >,
) {
  const observedCurrent = await transport.read();
  return ensureSharedSyncProtocolV2(transport, {
    ...input,
    observedCurrent,
    observeAfterCreateFailure: () => transport.read(),
  });
}

async function ensureObservedCanonicalV2(
  transport: SharedSyncProtocolTransportV2,
  input: Omit<
    Parameters<typeof ensureCanonicalSharedSyncProtocolV2>[1],
    "observedCurrent" | "observeAfterCreateFailure"
  >,
) {
  const observedCurrent = await transport.read();
  return ensureCanonicalSharedSyncProtocolV2(transport, {
    ...input,
    observedCurrent,
    observeAfterCreateFailure: () => transport.read(),
  });
}

describe("shared V2 sync protocol", () => {
  it("keeps the published canonical V2 bytes unchanged", () => {
    expect(serializeSharedSyncProtocolV2(protocol())).toBe(
      `{"schemaVersion":1,"kind":"easy-sync-v2-protocol","protocolVersion":2,"migrationGeneration":"${generationA}","scope":{"accountId":"account","driveId":"drive","vaultFolderId":"vault","filesRootId":"files"},"confirmedAllDevicesUpdatedAt":100,"createdAt":100}`,
    );
  });

  it("publishes or adopts only the exact proven canonical predecessor", async () => {
    const content = serializeSharedSyncProtocolV2(protocol());
    const contentSha256 = await sha256Hex(
      new TextEncoder().encode(content).buffer,
    );
    for (const [initial, source] of [
      [objectFor(protocol()), "existing"],
      [null, "created"],
    ] as const) {
      const harness = transportWith(initial);
      await expect(ensureObservedCanonicalV2(
        harness.transport,
        {
          canonicalContent: content,
          expectedMigrationGeneration: generationA,
          expectedContentSha256: contentSha256,
        },
      )).resolves.toMatchObject({
        status: "ready",
        source,
        object: { content },
        protocol: { migrationGeneration: generationA },
      });
      expect(harness.spies.readById).toHaveBeenCalledOnce();
      expect(harness.spies.read).toHaveBeenCalledOnce();
    }
  });

  it("adopts only an exact create-race winner by identity readback", async () => {
    const content = serializeSharedSyncProtocolV2(protocol());
    const contentSha256 = await sha256Hex(
      new TextEncoder().encode(content).buffer,
    );
    const winner = objectFor(protocol(), "winner-id");
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const readById = vi.fn().mockResolvedValue(winner);
    const transport: SharedSyncProtocolTransportV2 = {
      read,
      createOnly: vi.fn().mockRejectedValue(new Error("unknown outcome")),
      readById,
    };

    await expect(ensureObservedCanonicalV2(transport, {
      canonicalContent: content,
      expectedMigrationGeneration: generationA,
      expectedContentSha256: contentSha256,
    })).resolves.toMatchObject({ status: "ready", source: "create-race" });
    expect(readById).toHaveBeenCalledWith("winner-id");
    expect(read).toHaveBeenCalledTimes(2);

    const wrong = objectFor(protocol({ migrationGeneration: generationB }));
    read.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(wrong);
    await expect(ensureObservedCanonicalV2(transport, {
      canonicalContent: content,
      expectedMigrationGeneration: generationA,
      expectedContentSha256: contentSha256,
    })).resolves.toEqual({
      status: "blocked",
      reason: "target-slot-occupied",
    });
  });

  it("blocks invalid proof, occupied slots, and changed identity readback", async () => {
    const content = serializeSharedSyncProtocolV2(protocol());
    const contentSha256 = await sha256Hex(
      new TextEncoder().encode(content).buffer,
    );
    const input = {
      canonicalContent: content,
      expectedMigrationGeneration: generationA,
      expectedContentSha256: contentSha256,
    };
    await expect(ensureObservedCanonicalV2(
      transportWith(null).transport,
      { ...input, expectedContentSha256: "f".repeat(64) },
    )).resolves.toEqual({
      status: "blocked",
      reason: "canonical-proof-mismatch",
    });
    await expect(ensureObservedCanonicalV2(
      transportWith(objectFor(protocol({ migrationGeneration: generationB })))
        .transport,
      input,
    )).resolves.toEqual({
      status: "blocked",
      reason: "target-slot-occupied",
    });

    const changedReadback = transportWith(objectFor(protocol()));
    changedReadback.spies.readById.mockResolvedValueOnce({
      ...objectFor(protocol()),
      eTag: "changed-etag",
    });
    await expect(ensureObservedCanonicalV2(
      changedReadback.transport,
      input,
    )).resolves.toEqual({
      status: "blocked",
      reason: "readback-mismatch",
    });
  });

  it("requires explicit migration-risk acknowledgement before first creation", async () => {
    const harness = transportWith(null);

    await expect(ensureObservedV2(harness.transport, {
      scope,
      acknowledgeMigrationRisk: false,
    })).resolves.toEqual({ status: "acknowledgement-required" });
    expect(harness.spies.createOnly).not.toHaveBeenCalled();
    expect(harness.spies.readById).not.toHaveBeenCalled();
  });

  it("creates one immutable generation and verifies the exact content by ID", async () => {
    const harness = transportWith(null);

    await expect(ensureObservedV2(harness.transport, {
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

    await expect(ensureObservedV2(harness.transport, {
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
    expect(harness.spies.read).toHaveBeenCalledOnce();
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

    await expect(ensureObservedV2(transport, {
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
      await expect(ensureObservedV2(harness.transport, {
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

    await expect(ensureObservedV2(harness.transport, {
      scope,
      acknowledgeMigrationRisk: true,
      now: 100,
      createMigrationGeneration: () => generationA,
    })).resolves.toEqual({
      status: "blocked",
      reason: "readback-mismatch",
    });
  });

  it("preserves authentication and cancellation semantics during create and exact readback", async () => {
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";
    const authExpired = new OneDriveError(
      OneDriveErrorType.AuthExpired,
      "token expired",
      401,
    );

    for (const terminalError of [abortError, authExpired]) {
      const createHarness = transportWith(null);
      createHarness.spies.createOnly.mockRejectedValueOnce(terminalError);
      await expect(ensureObservedV2(createHarness.transport, {
        scope,
        acknowledgeMigrationRisk: true,
        now: 100,
        createMigrationGeneration: () => generationA,
      })).rejects.toBe(terminalError);
      expect(createHarness.spies.read).toHaveBeenCalledOnce();

      const readbackHarness = transportWith(null);
      readbackHarness.spies.readById.mockRejectedValueOnce(terminalError);
      await expect(ensureObservedV2(readbackHarness.transport, {
        scope,
        acknowledgeMigrationRisk: true,
        now: 100,
        createMigrationGeneration: () => generationA,
      })).rejects.toBe(terminalError);
      expect(readbackHarness.spies.read).toHaveBeenCalledOnce();
    }
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

    await expect(ensureObservedV2(harness.transport, {
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

    await expect(ensureObservedV2(harness.transport, {
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

describe("shared V2 protocol slot repair", () => {
  async function canonicalOf(
    patch: Partial<SharedSyncProtocolV2> = {},
  ): Promise<string> {
    return serializeSharedSyncProtocolV2(protocol(patch));
  }

  it("CAS-overwrites a deviant occupied slot and verifies the read-back", async () => {
    const canonicalContent = await canonicalOf();
    const harness = transportWith(objectFor(protocol({
      migrationGeneration: generationB,
    })));
    const observed = await harness.transport.read();

    const result = await repairCanonicalSharedSyncProtocolV2(
      harness.transport,
      {
        observedCurrent: observed!,
        canonicalContent,
        expectedMigrationGeneration: generationA,
        expectedContentSha256:
          await sha256Hex(new TextEncoder().encode(canonicalContent).buffer),
      },
    );

    expect(result).toMatchObject({
      status: "ready",
      source: "created",
      object: {
        id: "protocol-id",
        eTag: "protocol-etag-overwritten",
        content: canonicalContent,
      },
    });
    expect(harness.spies.overwriteOnly).toHaveBeenCalledOnce();
    expect(harness.spies.overwriteOnly.mock.calls[0]).toEqual([
      "protocol-id",
      "protocol-etag",
      canonicalContent,
    ]);
  });

  it("keeps an already-canonical slot without overwriting", async () => {
    const canonicalContent = await canonicalOf();
    const harness = transportWith(objectFor(JSON.parse(canonicalContent)));

    const result = await repairCanonicalSharedSyncProtocolV2(
      harness.transport,
      {
        observedCurrent: (await harness.transport.read())!,
        canonicalContent,
        expectedMigrationGeneration: generationA,
        expectedContentSha256:
          await sha256Hex(new TextEncoder().encode(canonicalContent).buffer),
      },
    );

    expect(result).toMatchObject({
      status: "ready",
      source: "existing",
    });
    expect(harness.spies.overwriteOnly).not.toHaveBeenCalled();
  });

  it("rejects canonical content that fails the generation proof", async () => {
    const canonicalContent = await canonicalOf({ migrationGeneration: generationB });
    const harness = transportWith(objectFor(protocol({
      migrationGeneration: generationB,
    })));

    const result = await repairCanonicalSharedSyncProtocolV2(
      harness.transport,
      {
        observedCurrent: (await harness.transport.read())!,
        canonicalContent,
        expectedMigrationGeneration: generationA,
        expectedContentSha256:
          await sha256Hex(new TextEncoder().encode(canonicalContent).buffer),
      },
    );

    expect(result).toEqual({
      status: "blocked",
      reason: "canonical-proof-mismatch",
    });
    expect(harness.spies.overwriteOnly).not.toHaveBeenCalled();
  });

  it("fails closed when the CAS overwrite loses its race", async () => {
    const canonicalContent = await canonicalOf();
    const harness = transportWith(objectFor(protocol({
      migrationGeneration: generationB,
    })));
    const observed = await harness.transport.read();
    // Another writer changes the eTag before the repair's overwrite lands.
    harness.spies.overwriteOnly.mockRejectedValueOnce(
      new Error("overwrite conflict"),
    );

    const result = await repairCanonicalSharedSyncProtocolV2(
      harness.transport,
      {
        observedCurrent: observed!,
        canonicalContent,
        expectedMigrationGeneration: generationA,
        expectedContentSha256:
          await sha256Hex(new TextEncoder().encode(canonicalContent).buffer),
      },
    );

    expect(result).toEqual({
      status: "blocked",
      reason: "write-failed",
    });
  });
});
