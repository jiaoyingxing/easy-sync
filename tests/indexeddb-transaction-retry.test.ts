import { describe, expect, it, vi } from "vitest";
import { retryIndexedDbTransaction } from "../src/sync/indexeddb-transaction-retry";

function webkitTransactionError(): Error {
  return new Error(
    "Attempt to delete range from database without an in-progress transaction",
  );
}

describe("retryIndexedDbTransaction", () => {
  it("retries one iOS WebKit auto-committed transaction error", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(webkitTransactionError())
      .mockResolvedValueOnce("ok");

    await expect(retryIndexedDbTransaction(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("classifies UnknownError and TransactionInactiveError as retryable", async () => {
    for (const name of ["UnknownError", "TransactionInactiveError"]) {
      const error = new Error("transaction is inactive");
      error.name = name;
      const operation = vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce("ok");

      await expect(retryIndexedDbTransaction(operation)).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
    }
  });

  it("does not retry an unrelated error", async () => {
    const error = new Error("IndexedDB recovery target already contains different bytes");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(retryIndexedDbTransaction(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("gives up after the bounded second attempt and rethrows", async () => {
    const operation = vi.fn().mockRejectedValue(webkitTransactionError());

    await expect(retryIndexedDbTransaction(operation)).rejects.toThrow(
      "without an in-progress transaction",
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("honours an explicit attempt budget", async () => {
    const operation = vi.fn().mockRejectedValue(webkitTransactionError());

    await expect(
      retryIndexedDbTransaction(operation, { maxAttempts: 1 }),
    ).rejects.toThrow("without an in-progress transaction");
    expect(operation).toHaveBeenCalledOnce();
  });
});
