import type {
  LocalFileEntry,
  MutationLedgerEntryV1,
  SyncScope,
} from "../../src/sync/types";

/**
 * Sanitized facts from the two public 1.1.3 reports that motivated V2-60f.
 * No real account, path, item, or operation identity is retained here.
 */
export const PUBLIC_113_NETWORK_RECOVERY_INCIDENT = {
  singleIntentCount: 1,
  batchIntentCount: 23,
  requestFailure: {
    type: "NetworkError",
    statusCode: 0,
    graphCode: null,
  },
} as const;

export function makePublic113InterruptedUploadBatch(
  scope: SyncScope,
  count = PUBLIC_113_NETWORK_RECOVERY_INCIDENT.batchIntentCount,
): {
  ledger: MutationLedgerEntryV1[];
  localEntries: LocalFileEntry[];
} {
  const localEntries = Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const hash = sequence.toString(16).padStart(2, "0").repeat(32);
    return {
      path: `network-recovery-entry-${sequence.toString().padStart(2, "0")}.md`,
      hash,
      size: 3,
      mtime: sequence,
      binary: false,
    } satisfies LocalFileEntry;
  });
  return {
    localEntries,
    ledger: localEntries.map((entry, index) => ({
      intent: {
        version: 1,
        operationId: `sanitized-network-op-${index + 1}`,
        planRevision: 1,
        scope: { ...scope },
        action: "upload",
        path: entry.path,
        expectedLocal: {
          exists: true,
          hash: entry.hash,
          size: entry.size,
        },
        expectedRemote: { exists: false },
        createdAt: index + 1,
      },
      receipt: null,
    })),
  };
}
