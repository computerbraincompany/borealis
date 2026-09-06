/**
 * The bounded honest-ready signal behind the startup rehydration gate.
 *
 * The window models the post-restart interval during which the ledger already
 * reports ready tabular sources while `restoreDatasets()` is still rebuilding
 * the DuckDB dataset registry. Waiters must either observe the window settle
 * (`ready`), hit their fixed bound and proceed honestly (`timeout`), or be
 * cancelled (`AbortError`); a settled or failed window is always honest
 * failed-open `ready`.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DATASET_REGISTRY_HYDRATION_WAIT_MS,
  beginDatasetRegistryRehydration,
  datasetRegistryRehydrationPending,
  finishDatasetRegistryRehydration,
  waitForDatasetRegistryHydration,
} from "../data/registryHydration.js";

afterEach(() => {
  finishDatasetRegistryRehydration();
});

describe("dataset-registry rehydration signal", () => {
  it("is ready by default and the fixed admission bound stays within 15 seconds", async () => {
    expect(datasetRegistryRehydrationPending()).toBe(false);
    await expect(waitForDatasetRegistryHydration()).resolves.toBe("ready");
    expect(DATASET_REGISTRY_HYDRATION_WAIT_MS).toBeGreaterThan(0);
    expect(DATASET_REGISTRY_HYDRATION_WAIT_MS).toBeLessThanOrEqual(15_000);
  });

  it("drives an in-flight window to the honest timeout outcome at its deadline", async () => {
    beginDatasetRegistryRehydration();
    expect(datasetRegistryRehydrationPending()).toBe(true);
    await expect(waitForDatasetRegistryHydration(30)).resolves.toBe("timeout");
    // A non-positive bound is an immediate honest timeout while in flight.
    await expect(waitForDatasetRegistryHydration(0)).resolves.toBe("timeout");
    await expect(waitForDatasetRegistryHydration(-1)).resolves.toBe("timeout");
  });

  it("resolves in-flight waiters as ready when the window settles", async () => {
    beginDatasetRegistryRehydration();
    const waiting = waitForDatasetRegistryHydration(5_000);
    expect(datasetRegistryRehydrationPending()).toBe(true);
    finishDatasetRegistryRehydration();
    await expect(waiting).resolves.toBe("ready");
    expect(datasetRegistryRehydrationPending()).toBe(false);
    await expect(waitForDatasetRegistryHydration(30)).resolves.toBe("ready");
  });

  it("joins an already-open window and closes idempotently (failed-open)", async () => {
    beginDatasetRegistryRehydration();
    beginDatasetRegistryRehydration();
    finishDatasetRegistryRehydration();
    finishDatasetRegistryRehydration();
    expect(datasetRegistryRehydrationPending()).toBe(false);
    await expect(waitForDatasetRegistryHydration(30)).resolves.toBe("ready");
  });

  it("rejects the wait with AbortError when the caller signal aborts", async () => {
    beginDatasetRegistryRehydration();
    const controller = new AbortController();
    const waiting = waitForDatasetRegistryHydration(5_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await expect(waitForDatasetRegistryHydration(5_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    // An aborted waiter never closes the window itself.
    expect(datasetRegistryRehydrationPending()).toBe(true);
  });
});
