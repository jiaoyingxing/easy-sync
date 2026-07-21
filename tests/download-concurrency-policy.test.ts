import { describe, expect, it } from "vitest";
import { DownloadConcurrencyPolicy } from "../src/sync/download-concurrency-policy";

function healthyBatch(files = 1, elapsedMs = 100) {
  return {
    files,
    bytes: files * 1024 * 1024,
    elapsedMs,
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

  it.each([
    { failed: true, degradedPath: false },
    { failed: false, degradedPath: true },
  ])("locks the rest of the round to serial after an unhealthy signal", (signal) => {
    const policy = new DownloadConcurrencyPolicy();
    policy.observeBatch(healthyBatch());
    policy.observeBatch(healthyBatch());
    expect(policy.limit).toBe(2);

    policy.observeBatch({ ...healthyBatch(2), ...signal });
    expect(policy.limit).toBe(1);
    expect(policy.isLockedSerial).toBe(true);

    policy.observeBatch(healthyBatch());
    expect(policy.limit).toBe(1);
  });

  it("stays serial without enough byte/throughput evidence", () => {
    const policy = new DownloadConcurrencyPolicy();
    for (let index = 0; index < 5; index++) {
      policy.observeBatch({
        files: 1,
        bytes: 32 * 1024,
        elapsedMs: 1000,
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
