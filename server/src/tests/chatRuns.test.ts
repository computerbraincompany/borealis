import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBeginStatus: vi.fn(),
  requestCancel: vi.fn(),
  finishRun: vi.fn(),
  completeRunWithAssistant: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
  listReportArtifactCleanupIntents: vi.fn(),
  listOrphanedPendingRunGroups: vi.fn(),
  listPendingReportCleanupPaths: vi.fn(),
  deletePendingArtifactRows: vi.fn(),
  completeReportArtifactCleanup: vi.fn(),
  removeReportArtifacts: vi.fn(),
}));

vi.mock("../storageRuntime.js", () => ({
  storageRuntime: () => ({
    runs: {
      readBeginStatus: mocks.readBeginStatus,
      requestCancel: mocks.requestCancel,
      finishRun: mocks.finishRun,
      completeRunWithAssistant: mocks.completeRunWithAssistant,
      recoverInterruptedRuns: mocks.recoverInterruptedRuns,
      listReportArtifactCleanupIntents: mocks.listReportArtifactCleanupIntents,
      listOrphanedPendingRunGroups: mocks.listOrphanedPendingRunGroups,
      listPendingReportCleanupPaths: mocks.listPendingReportCleanupPaths,
      deletePendingArtifactRows: mocks.deletePendingArtifactRows,
    },
  }),
}));
vi.mock("../reportCleanup.js", () => ({ completeReportArtifactCleanup: mocks.completeReportArtifactCleanup }));
vi.mock("../storageArtifacts.js", () => ({ removeReportArtifacts: mocks.removeReportArtifacts }));

import {
  beginRun,
  cancelRun,
  completeRunWithAssistant,
  finishRun,
  finishRunDurably,
  recoverInterruptedRuns,
  sweepOrphanedPendingArtifacts,
} from "../chatRuns.js";

const completion = Object.freeze({
  content: "durable answer",
  meta: Object.freeze({
    charts: [] as string[],
    report: null,
    model: "chat-model",
    source_mode: "selected" as const,
    source_ids: [] as string[],
    evidence: [],
    query_results: [],
  }),
});

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
  mocks.requestCancel.mockResolvedValue("cancelling");
  mocks.finishRun.mockResolvedValue("failed");
  mocks.recoverInterruptedRuns.mockResolvedValue(0);
  mocks.listReportArtifactCleanupIntents.mockResolvedValue([]);
  mocks.listOrphanedPendingRunGroups.mockResolvedValue([]);
  mocks.listPendingReportCleanupPaths.mockResolvedValue([]);
  mocks.deletePendingArtifactRows.mockResolvedValue({ reports: 0, charts: 0 });
  mocks.completeReportArtifactCleanup.mockResolvedValue({ attempted: 0, completed: 0, failed: 0 });
  mocks.removeReportArtifacts.mockResolvedValue(true);
});

describe("durable chat run lifecycle", () => {
  it("aborts only after the owned cancellation transition succeeds", async () => {
    const controller = await beginRun("account-1", "chat-1", "run-1");
    const transition = deferred<"cancelling">();
    mocks.requestCancel.mockReturnValueOnce(transition.promise);

    const cancelling = cancelRun("account-1", "chat-1", "run-1");
    expect(controller.signal.aborted).toBe(false);
    transition.resolve("cancelling");
    await expect(cancelling).resolves.toBe("cancelling");
    expect(controller.signal.aborted).toBe(true);
    expect(mocks.requestCancel).toHaveBeenCalledWith("account-1", "chat-1", "run-1");
  });

  it("does not abort an unowned or already-terminal run", async () => {
    const controller = await beginRun("account-1", "chat-1", "run-unowned");
    mocks.requestCancel.mockResolvedValueOnce(null);
    await expect(cancelRun("account-1", "chat-1", "run-unowned")).resolves.toBeNull();
    expect(controller.signal.aborted).toBe(false);
    mocks.finishRun.mockResolvedValueOnce("failed");
    await finishRun("account-1", "chat-1", "run-unowned", "failed");

    const terminal = await beginRun("account-1", "chat-1", "run-terminal");
    mocks.requestCancel.mockResolvedValueOnce("completed");
    await expect(cancelRun("account-1", "chat-1", "run-terminal")).resolves.toBe("completed");
    expect(terminal.signal.aborted).toBe(false);
  });

  it("refuses execution when persisted cancellation exists or the setup read fails", async () => {
    mocks.readBeginStatus.mockResolvedValueOnce({
      status: "cancelling",
      cancelRequested: true,
      shouldAbort: true,
    });
    expect((await beginRun("account-1", "chat-1", "run-cancelled")).signal.aborted).toBe(true);

    mocks.readBeginStatus.mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await beginRun("account-1", "chat-1", "run-unproven")).signal.aborted).toBe(true);
  });

  it("retries terminalization in-process and preserves the store's cancellation decision", async () => {
    mocks.finishRun.mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce("cancelled");
    await expect(finishRunDurably("account-1", "chat-1", "run-retry", "failed", "AGENT_FAILED")).resolves.toBe(
      "cancelled"
    );
    expect(mocks.finishRun).toHaveBeenCalledTimes(2);
  });

  it("publishes the store result and completes its durable report cleanup intents", async () => {
    const intent = {
      id: "report-1",
      accountId: "account-1",
      runId: "run-complete",
      htmlPath: "/safe/report.html",
      pdfPath: "/safe/report.pdf",
      attempts: 0,
      lastError: null,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    mocks.completeRunWithAssistant.mockResolvedValueOnce({
      status: "completed",
      message: { id: 42, content: completion.content, meta: completion.meta },
      reportCleanupIntents: [intent],
    });

    await expect(completeRunWithAssistant("account-1", "chat-1", "run-complete", completion)).resolves.toMatchObject({
      status: "completed",
      message: { id: 42, content: "durable answer" },
    });
    expect(mocks.completeReportArtifactCleanup).toHaveBeenCalledWith([intent]);
  });

  it("never publishes after cancellation and sweeps only observed pending paths", async () => {
    const pending = {
      id: "report-pending",
      accountId: "account-1",
      runId: "run-cancelled",
      htmlPath: "/safe/report.html",
      pdfPath: "/safe/report.pdf",
    };
    mocks.completeRunWithAssistant.mockResolvedValueOnce({ status: "cancelled", pendingReportCleanup: [pending] });
    mocks.listPendingReportCleanupPaths.mockResolvedValueOnce([pending]);
    mocks.deletePendingArtifactRows.mockResolvedValueOnce({ reports: 1, charts: 0 });

    await expect(completeRunWithAssistant("account-1", "chat-1", "run-cancelled", completion)).resolves.toEqual({
      status: "cancelled",
    });
    expect(mocks.completeReportArtifactCleanup).not.toHaveBeenCalled();
    expect(mocks.removeReportArtifacts).toHaveBeenCalledWith({
      accountId: "account-1",
      reportId: "report-pending",
      htmlPath: "/safe/report.html",
      pdfPath: "/safe/report.pdf",
    });
    expect(mocks.deletePendingArtifactRows).toHaveBeenCalledWith("account-1", "run-cancelled", [pending]);
  });

  it("acknowledges only successful pending report removals and retains failures", async () => {
    const success = {
      id: "success",
      accountId: "account-1",
      runId: "run-terminal",
      htmlPath: "/safe/success.html",
      pdfPath: null,
    };
    const failure = { ...success, id: "failure", htmlPath: "/unsafe/failure.html" };
    mocks.listOrphanedPendingRunGroups.mockResolvedValueOnce([
      { accountId: "account-1", runId: "run-terminal", reportCount: 2, chartCount: 1 },
    ]);
    mocks.listPendingReportCleanupPaths.mockResolvedValueOnce([success, failure]);
    mocks.removeReportArtifacts.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.deletePendingArtifactRows.mockResolvedValueOnce({ reports: 1, charts: 1 });

    await expect(sweepOrphanedPendingArtifacts()).resolves.toBe(1);
    expect(mocks.deletePendingArtifactRows).toHaveBeenCalledWith("account-1", "run-terminal", [success]);
  });

  it("treats a legacy pending report with no paths as already removed", async () => {
    const pending = { id: "pathless", accountId: "account-1", runId: null, htmlPath: null, pdfPath: null };
    mocks.listOrphanedPendingRunGroups.mockResolvedValueOnce([
      { accountId: "account-1", runId: null, reportCount: 1, chartCount: 0 },
    ]);
    mocks.listPendingReportCleanupPaths.mockResolvedValueOnce([pending]);

    await sweepOrphanedPendingArtifacts();
    expect(mocks.removeReportArtifacts).not.toHaveBeenCalled();
    expect(mocks.deletePendingArtifactRows).toHaveBeenCalledWith("account-1", null, [pending]);
  });

  it("recovers runs without starting a pump and paginates the durable cleanup queue", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: `report-${index}`,
      accountId: "account-1",
    }));
    const second = [{ id: "report-100", accountId: "account-1" }];
    mocks.recoverInterruptedRuns.mockResolvedValueOnce(2);
    mocks.listReportArtifactCleanupIntents.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await expect(recoverInterruptedRuns()).resolves.toBe(2);
    expect(mocks.completeReportArtifactCleanup).toHaveBeenNthCalledWith(1, first);
    expect(mocks.completeReportArtifactCleanup).toHaveBeenNthCalledWith(2, second);
    expect(mocks.listOrphanedPendingRunGroups).toHaveBeenCalledOnce();
  });
});
