import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY,
  DownloadConcurrencyPolicy,
  MOBILE_DOWNLOAD_MAX_CONCURRENCY,
} from "../src/sync/download-concurrency-policy";

function healthyBatch(files = 1, elapsedMs = 100, transferMs = 100) {
  return {
    files,
    bytes: files * 1024 * 1024,
    elapsedMs,
    transferMs,
    failed: false,
    degradedPath: false,
  };
}

describe("DownloadConcurrencyPolicy", () => {
  it("starts at one and only rises to two/three after repeated healthy batches", () => {
    const policy = new DownloadConcurrencyPolicy();

    expect(policy.limit).toBe(1);
    policy.observeBatch(healthyBatch());
    expect(policy.limit).toBe(1);
    policy.observeBatch(healthyBatch());
    expect(policy.limit).toBe(2);
    policy.observeBatch(healthyBatch(2));
    expect(policy.limit).toBe(2);
    policy.observeBatch(healthyBatch(2));
    expect(policy.limit).toBe(3);
  });

  it("caps a mobile-bound policy at two (A2) while desktop still reaches three", () => {
    const mobile = new DownloadConcurrencyPolicy(
      MOBILE_DOWNLOAD_MAX_CONCURRENCY,
    );
    for (let index = 0; index < 6; index++) {
      mobile.observeBatch(healthyBatch(2));
    }
    expect(mobile.limit).toBe(MOBILE_DOWNLOAD_MAX_CONCURRENCY);

    const desktop = new DownloadConcurrencyPolicy(
      ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY,
    );
    for (let index = 0; index < 6; index++) {
      desktop.observeBatch(healthyBatch(2));
    }
    expect(desktop.limit).toBe(ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY);
  });

  it.each([
    { failed: true, degradedPath: false },
    { failed: false, degradedPath: true },
  ])("locks the download direction to serial on an unhealthy signal", (signal) => {
    const policy = new DownloadConcurrencyPolicy();
    policy.observeBatch(healthyBatch());
    policy.observeBatch(healthyBatch());
    expect(policy.limit).toBe(2);

    policy.observeBatch({ ...healthyBatch(2), ...signal });
    expect(policy.limit).toBe(1);
    expect(policy.isLockedSerial).toBe(true);
  });

  it("stays serial without enough byte/throughput evidence", () => {
    const policy = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 5; index++) {
      policy.observeBatch({
        files: 1,
        bytes: 32 * 1024,
        elapsedMs: 1000,
        transferMs: 1000,
        failed: false,
        degradedPath: false,
      });
    }
    expect(policy.limit).toBe(1);
  });

  it("locks back to one after a significant aggregate throughput drop", () => {
    const policy = new DownloadConcurrencyPolicy();
    policy.observeBatch(healthyBatch(1, 100));
    policy.observeBatch(healthyBatch(1, 100));
    expect(policy.limit).toBe(2);

    policy.observeBatch(healthyBatch(2, 1000));
    expect(policy.limit).toBe(1);
    expect(policy.isLockedSerial).toBe(true);
  });
});

describe("DownloadConcurrencyPolicy — 小文件档 (2026-10-27)", () => {
  function noteBatch(overrides: Record<string, unknown> = {}) {
    return {
      files: 1,
      bytes: 18,
      // Wall clock is dominated by metadata and the local commit; only the
      // transfer window itself is link evidence.
      elapsedMs: 2_000,
      transferMs: 410,
      failed: false,
      degradedPath: false,
      ...overrides,
    };
  }

  it("降档：18 字节批次没有带宽证据，但连续完成的传输让上限 1→2→3", () => {
    const policy = new DownloadConcurrencyPolicy();

    expect(policy.limit).toBe(1);
    policy.observeBatch(noteBatch());
    // One completed transfer is not yet a pattern.
    expect(policy.limit).toBe(1);
    policy.observeBatch(noteBatch());
    expect(policy.limit).toBe(2);
    policy.observeBatch(noteBatch());
    expect(policy.limit).toBe(2);
    policy.observeBatch(noteBatch());
    expect(policy.limit).toBe(3);
  });

  it("a failed small-file batch still drops straight back to serial", () => {
    const policy = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 4; index++) policy.observeBatch(noteBatch());
    expect(policy.limit).toBe(3);

    policy.observeBatch(noteBatch({ files: 2, bytes: 36, failed: true }));
    expect(policy.limit).toBe(1);
    expect(policy.isLockedSerial).toBe(true);

    // Two completed batches after the failure are not enough to climb; the
    // existing recovery window still governs the way back up.
    policy.observeBatch(noteBatch());
    policy.observeBatch(noteBatch());
    expect(policy.limit).toBe(1);
    policy.observeBatch(noteBatch());
    expect(policy.limit).toBe(2);
  });

  it("caps a mobile-bound small-file ramp at two", () => {
    const mobile = new DownloadConcurrencyPolicy(MOBILE_DOWNLOAD_MAX_CONCURRENCY);
    for (let index = 0; index < 8; index++) mobile.observeBatch(noteBatch());
    expect(mobile.limit).toBe(MOBILE_DOWNLOAD_MAX_CONCURRENCY);

    const desktop = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 8; index++) desktop.observeBatch(noteBatch());
    expect(desktop.limit).toBe(ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY);
  });

  it("keeps one file at a time when the small transfer itself is slow", () => {
    // 32 KiB over one second is 32 KiB/s: far below the 512 KiB/s bandwidth
    // floor, so it is not healthy small-file evidence even though it finished.
    const policy = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 6; index++) {
      policy.observeBatch(noteBatch({ bytes: 32 * 1024, transferMs: 1_000 }));
    }
    expect(policy.limit).toBe(1);
  });

  it("does not count a stalled transfer as healthy evidence", () => {
    const policy = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 6; index++) {
      policy.observeBatch(noteBatch({ transferMs: 5_000 }));
    }
    expect(policy.limit).toBe(1);
  });

  it("treats a completed 200 KiB transfer as small-file evidence", () => {
    const policy = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 4; index++) {
      // The measured medium-tier batch: 200 KiB in 1.32 s is 155 KiB/s, below
      // the 512 KiB/s gate, but a real transfer window at the tier's ceiling.
      policy.observeBatch(noteBatch({ bytes: 200 * 1024, transferMs: 1_320 }));
    }
    expect(policy.limit).toBe(3);
  });

  it("never lowers a ceiling already earned on bandwidth evidence", () => {
    const policy = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 4; index++) policy.observeBatch(healthyBatch(2));
    expect(policy.limit).toBe(3);

    for (let index = 0; index < 2; index++) policy.observeBatch(noteBatch());
    expect(policy.limit).toBe(3);
  });

  it("does not apply the small-file path above the small-file tier", () => {
    const policy = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 6; index++) {
      // 300 KiB in 1 s is 300 KiB/s (below the 512 KiB/s floor) and above the
      // 200 KiB per-file tier: no bandwidth evidence and no small-file credit.
      policy.observeBatch(noteBatch({ bytes: 300 * 1024, transferMs: 1_000 }));
    }
    expect(policy.limit).toBe(1);
  });
});

describe("DownloadConcurrencyPolicy — 降级后爬回 (2026-10-27)", () => {
  it("does not unlock on one healthy batch but climbs one level after three", () => {
    const policy = new DownloadConcurrencyPolicy();
    policy.observeBatch({ ...healthyBatch(2), failed: true });
    expect(policy.limit).toBe(1);
    expect(policy.isLockedSerial).toBe(true);

    policy.observeBatch(healthyBatch());
    policy.observeBatch(healthyBatch());
    // Two usable batches are not yet a pattern.
    expect(policy.limit).toBe(1);

    policy.observeBatch(healthyBatch());
    expect(policy.limit).toBe(2);
    // The round stays under the degraded rule; recovery governs the limit.
    expect(policy.isLockedSerial).toBe(true);

    policy.observeBatch(healthyBatch(2));
    policy.observeBatch(healthyBatch(2));
    expect(policy.limit).toBe(2);
    policy.observeBatch(healthyBatch(2));
    expect(policy.limit).toBe(ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY);
  });

  it("climbs only to the platform ceiling (mobile stays at two)", () => {
    const mobile = new DownloadConcurrencyPolicy(
      MOBILE_DOWNLOAD_MAX_CONCURRENCY,
    );
    mobile.observeBatch({ ...healthyBatch(2), failed: true });
    for (let index = 0; index < 12; index++) {
      mobile.observeBatch(healthyBatch(2));
    }
    expect(mobile.limit).toBe(MOBILE_DOWNLOAD_MAX_CONCURRENCY);
  });

  it("reads the batch's own transfer time, not a wall clock inflated by metadata and hashing", () => {
    const policy = new DownloadConcurrencyPolicy();
    policy.observeBatch({ ...healthyBatch(2), failed: true });

    // 1 MiB in 30 s of wall clock looks like 34 KiB/s — the old signal, and the
    // C2 defect: metadata refresh, sha256 and remote verification live in
    // `elapsedMs` and the limit could never rise on mobile. The 100 ms of real
    // transfer time is what the recovery path reads.
    for (let index = 0; index < 3; index++) {
      policy.observeBatch(healthyBatch(1, 30_000, 100));
    }
    expect(policy.limit).toBe(2);
  });

  it("a failed batch returns to the floor and clears the streak", () => {
    const policy = new DownloadConcurrencyPolicy();
    policy.observeBatch({ ...healthyBatch(2), failed: true });
    policy.observeBatch(healthyBatch());
    policy.observeBatch(healthyBatch());

    policy.observeBatch({ ...healthyBatch(2), failed: true });
    expect(policy.limit).toBe(1);
    policy.observeBatch(healthyBatch());
    policy.observeBatch(healthyBatch());
    expect(policy.limit).toBe(1);
    policy.observeBatch(healthyBatch());
    expect(policy.limit).toBe(2);
  });

  it("counts a link that carried only tiny notes as healthy evidence", () => {
    const policy = new DownloadConcurrencyPolicy();
    policy.observeBatch({ ...healthyBatch(2), failed: true });

    // A batch of 18-byte notes moves no rate anyone can judge, but a link that
    // delivered every one of them is not a dead link.
    for (let index = 0; index < 3; index++) {
      policy.observeBatch({
        files: 2,
        bytes: 36,
        elapsedMs: 4_000,
        transferMs: 20,
        failed: false,
        degradedPath: true,
      });
    }
    expect(policy.limit).toBe(2);
  });

  it("a judgeable batch slower than the floor resets the streak without a further step down", () => {
    const policy = new DownloadConcurrencyPolicy();
    policy.observeBatch({ ...healthyBatch(2), failed: true });

    // 1 MiB over 4 s of transfer = 256 KiB/s, below the 512 KiB/s floor but a
    // live link: no recovery credit and no extra penalty beyond the floor.
    for (let index = 0; index < 6; index++) {
      policy.observeBatch(healthyBatch(1, 4_000, 4_000));
    }
    expect(policy.limit).toBe(1);
    expect(policy.isLockedSerial).toBe(true);
  });
});
