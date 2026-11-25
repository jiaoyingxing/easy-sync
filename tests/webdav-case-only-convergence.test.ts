import { describe, expect, it } from "vitest";
import { createWebDavColdStartHarness } from "./helpers/webdav-cold-start-harness";

async function firstSync(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
): Promise<void> {
  const round = await harness.runRound("manual");
  if (round.message === "result.pausedForReview") {
    await harness.confirmRound(harness.state.planReviewAuthorization!);
  }
}

async function renameBothSides(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
): Promise<void> {
  expect(await harness.moveRemote(
    `${harness.fake.rootPath}/docs`,
    `${harness.fake.rootPath}/Docs`,
  )).toBeLessThan(300);
  harness.renameLocalFolder("docs", "Docs");
}

function envelopeAnchors(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
) {
  const envelope = harness.state.getCommittedV2Envelope()!;
  return {
    folder: Object.values(envelope.folderAnchors!.byAnchorId)
      .map((anchor) => anchor.lastPath),
    file: Object.values(envelope.anchors.byAnchorId)
      .map((anchor) => anchor.lastPath),
  };
}

/**
 * Path-identity providers change the item id with the spelling, so after both
 * sides use the new spelling the old anchor id is gone and the ordinary
 * active-forget button can never rebuild its snapshot. The state-only re-claim
 * makes the row disappear without a user choice; a changed subtree shape keeps
 * the visible defer.
 */
describe("WebDAV both-sides case-only folder rename", () => {
  it("re-claims the current same-path folder and stays zero", async () => {
    const harness = await createWebDavColdStartHarness({
      localFiles: { "docs/a.md": "alpha" },
      localFolders: ["docs"],
    });
    try {
      await firstSync(harness);
      await renameBothSides(harness);

      const round = await harness.runRound("manual");

      expect(round).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        filesMoved: 0,
        conflicts: 0,
        errors: 0,
      });
      expect(harness.state.pendingIssues).toEqual([]);
      expect(harness.state.mutationLedger).toEqual([]);
      expect(envelopeAnchors(harness)).toEqual({
        folder: ["Docs"],
        file: ["Docs/a.md"],
      });
      expect(harness.remoteText(`${harness.fake.rootPath}/Docs/a.md`))
        .toBe("alpha");
      const stable = await harness.runRound("manual");
      expect(stable).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        conflicts: 0,
        errors: 0,
      });
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("keeps the visible defer when a descendant disappeared", async () => {
    const harness = await createWebDavColdStartHarness({
      localFiles: { "docs/a.md": "alpha" },
      localFolders: ["docs"],
    });
    try {
      await firstSync(harness);
      await renameBothSides(harness);
      expect(await harness.deleteRemote(
        `${harness.fake.rootPath}/Docs/a.md`,
      )).toBeLessThan(300);

      const round = await harness.runRound("manual");

      expect(harness.state.mutationLedger).toEqual([]);
      expect(harness.state.pendingIssues.length).toBeGreaterThan(0);
      expect(envelopeAnchors(harness).folder).toEqual(["docs"]);
      expect(round.errors).toBe(0);
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
