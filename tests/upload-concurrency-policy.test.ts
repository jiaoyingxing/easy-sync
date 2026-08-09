import { describe, expect, it } from "vitest";
import { UploadConcurrencyPolicy } from "../src/sync/upload-concurrency-policy";

describe("UploadConcurrencyPolicy", () => {
  it("starts desktop at two and grows only after healthy full waves", () => {
    const policy = new UploadConcurrencyPolicy(false);

    expect(policy.limit).toBe(2);
    policy.observeBatch({ files: 2, elapsedMs: 100, failed: false });
    expect(policy.limit).toBe(2);
    policy.observeBatch({ files: 2, elapsedMs: 100, failed: false });
    expect(policy.limit).toBe(3);
    policy.observeBatch({ files: 3, elapsedMs: 100, failed: false });
    expect(policy.limit).toBe(3);
    policy.observeBatch({ files: 3, elapsedMs: 100, failed: false });
    expect(policy.limit).toBe(4);
  });

  it("starts mobile serial and permits only a bounded rise to two", () => {
    const policy = new UploadConcurrencyPolicy(true);

    expect(policy.limit).toBe(1);
    policy.observeBatch({ files: 1, elapsedMs: 100, failed: false });
    expect(policy.limit).toBe(1);
    policy.observeBatch({ files: 1, elapsedMs: 100, failed: false });
    expect(policy.limit).toBe(2);
    policy.observeBatch({ files: 2, elapsedMs: 100, failed: false });
    expect(policy.limit).toBe(2);
  });

  it("locks the rest of the run to serial after any failed wave", () => {
    const policy = new UploadConcurrencyPolicy(false);

    policy.observeBatch({ files: 2, elapsedMs: 100, failed: false });
    policy.observeBatch({ files: 2, elapsedMs: 100, failed: true });

    expect(policy.limit).toBe(1);
    expect(policy.isLockedSerial).toBe(true);
    policy.observeBatch({ files: 1, elapsedMs: 100, failed: false });
    expect(policy.limit).toBe(1);
  });

  it("locks serial after a pronounced throughput regression", () => {
    const policy = new UploadConcurrencyPolicy(false);

    policy.observeBatch({ files: 2, elapsedMs: 100, failed: false });
    policy.observeBatch({ files: 2, elapsedMs: 100, failed: false });
    policy.observeBatch({ files: 3, elapsedMs: 4_000, failed: false });

    expect(policy.limit).toBe(1);
    expect(policy.isLockedSerial).toBe(true);
  });
});
