import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBeginStatus: vi.fn(),
  finishRun: vi.fn(),
  listPendingReportCleanupPaths: vi.fn(),
  deletePendingArtifactRows: vi.fn(),
}));

vi.mock("../storageRuntime.js", () => ({
  storageRuntime: () => ({
    runs: {
      readBeginStatus: mocks.readBeginStatus,
      finishRun: mocks.finishRun,
      listPendingReportCleanupPaths: mocks.listPendingReportCleanupPaths,
      deletePendingArtifactRows: mocks.deletePendingArtifactRows,
    },
  }),
}));
vi.mock("../reportCleanup.js", () => ({ completeReportArtifactCleanup: vi.fn() }));
vi.mock("../storageArtifacts.js", () => ({ removeReportArtifacts: vi.fn() }));

import { beginRun, shutdownActiveRuns } from "../chatRuns.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.readBeginStatus.mockResolvedValue({ status: "running", cancelRequested: false, shouldAbort: false });
  mocks.finishRun.mockResolvedValue("cancelled");
  mocks.listPendingReportCleanupPaths.mockResolvedValue([]);
  mocks.deletePendingArtifactRows.mockResolvedValue({ reports: 0, charts: 0 });
});

describe("embedded server active-run shutdown", () => {
  it("aborts every owned executor before waiting for durable cancellation", async () => {
    const firstController = await beginRun("account-1", "chat-1", "run-1");
    const secondController = await beginRun("account-2", "chat-2", "run-2");
    const firstFinished = deferred<"cancelled">();
    const secondFinished = deferred<"completed">();
    mocks.finishRun.mockReset();
    mocks.finishRun.mockReturnValueOnce(firstFinished.promise).mockReturnValueOnce(secondFinished.promise);

    const shutdown = shutdownActiveRuns();
    expect(firstController.signal.aborted).toBe(true);
    expect(secondController.signal.aborted).toBe(true);
    expect(mocks.finishRun).toHaveBeenCalledTimes(2);
    expect(mocks.finishRun).toHaveBeenCalledWith("account-1", "chat-1", "run-1", "cancelled", undefined);
    expect(mocks.finishRun).toHaveBeenCalledWith("account-2", "chat-2", "run-2", "cancelled", undefined);

    firstFinished.resolve("cancelled");
    secondFinished.resolve("completed");
    await expect(shutdown).resolves.toBe(2);
    await expect(shutdownActiveRuns()).resolves.toBe(0);
  });

  it("owns and drains an accepted run even while its durable begin-status read is pending", async () => {
    const beginStatus = deferred<{ status: "running"; cancelRequested: false; shouldAbort: false }>();
    mocks.readBeginStatus.mockReturnValueOnce(beginStatus.promise);

    const beginning = beginRun("account-1", "chat-1", "run-pending");
    const shutdown = shutdownActiveRuns();
    beginStatus.resolve({ status: "running", cancelRequested: false, shouldAbort: false });

    const controller = await beginning;
    expect(controller.signal.aborted).toBe(true);
    await expect(shutdown).resolves.toBe(1);
    expect(mocks.finishRun).toHaveBeenCalledWith("account-1", "chat-1", "run-pending", "cancelled", undefined);
  });
});
