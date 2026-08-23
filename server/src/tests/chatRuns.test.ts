import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock("../storageArtifacts.js", () => ({ removeReportArtifacts: vi.fn() }));

import {
  beginRun,
  cancelRun,
  completeRunWithAssistant,
  finishRun,
  finishRunDurably,
  recoverInterruptedRuns,
  sweepOrphanedPendingArtifacts,
} from "../chatRuns.js";
import { pool, q } from "../db.js";
import { removeReportArtifacts } from "../storageArtifacts.js";

const qMock = vi.mocked(q);
const connectMock = vi.mocked(pool.connect);
const removeReportArtifactsMock = vi.mocked(removeReportArtifacts);

beforeEach(() => {
  qMock.mockReset();
  qMock.mockResolvedValue([]);
  connectMock.mockReset();
  removeReportArtifactsMock.mockReset();
  removeReportArtifactsMock.mockResolvedValue(undefined);
});

describe("durable chat run lifecycle", () => {
  it("cancels the in-memory signal only after an owned active row is updated", async () => {
    qMock.mockResolvedValueOnce([{ status: "running", cancel_requested: false }]);
    const controller = await beginRun("account-1", "chat-1", "run-1");
    qMock.mockResolvedValueOnce([{ id: "run-1" }]);

    await expect(cancelRun("account-1", "chat-1", "run-1")).resolves.toBe("cancelling");
    expect(controller.signal.aborted).toBe(true);
    expect(qMock.mock.calls[1][0]).toContain("account_id=$3");
  });

  it("does not abort an unowned or inactive run", async () => {
    qMock.mockResolvedValueOnce([{ status: "running", cancel_requested: false }]);
    const controller = await beginRun("account-1", "chat-1", "run-2");
    qMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(cancelRun("account-1", "chat-1", "run-2")).resolves.toBeNull();
    expect(controller.signal.aborted).toBe(false);
    qMock.mockResolvedValueOnce([{ status: "failed" }]);
    await finishRun("account-1", "chat-1", "run-2", "failed");
  });

  it("honors cancellation that was persisted before the controller was installed", async () => {
    qMock.mockResolvedValueOnce([{ status: "cancelling", cancel_requested: true }]);
    const controller = await beginRun("account-1", "chat-1", "run-before-cancel");
    expect(controller.signal.aborted).toBe(true);
  });

  it("keeps the accepted executor cancellable when its setup read fails", async () => {
    qMock.mockRejectedValueOnce(new Error("database unavailable"));
    const controller = await beginRun("account-1", "chat-1", "run-setup-failure");

    qMock.mockResolvedValueOnce([{ id: "run-setup-failure" }]);
    await expect(cancelRun("account-1", "chat-1", "run-setup-failure")).resolves.toBe("cancelling");
    expect(controller.signal.aborted).toBe(true);
  });

  it("retries a transient terminal write in-process and lets cancellation win", async () => {
    qMock.mockResolvedValueOnce([{ status: "running", cancel_requested: false }]);
    const controller = await beginRun("account-1", "chat-1", "run-terminal-retry");
    qMock.mockRejectedValueOnce(new Error("database temporarily unavailable"));
    const terminal = finishRunDurably("account-1", "chat-1", "run-terminal-retry", "failed", "AGENT_FAILED");
    await vi.waitFor(() => expect(qMock).toHaveBeenCalledTimes(2));

    qMock.mockResolvedValueOnce([{ id: "run-terminal-retry" }]);
    await expect(cancelRun("account-1", "chat-1", "run-terminal-retry")).resolves.toBe("cancelling");
    expect(controller.signal.aborted).toBe(true);

    qMock.mockResolvedValueOnce([{ status: "cancelled" }]);
    await expect(terminal).resolves.toBe("cancelled");
    expect(qMock.mock.calls[3][0]).toContain("cancel_requested");
  });

  it("does not overwrite a concurrently requested cancellation with completed", async () => {
    qMock.mockResolvedValueOnce([{ status: "cancelled" }]);
    await expect(finishRun("account-1", "chat-1", "run-race", "completed")).resolves.toBe("cancelled");
    expect(qMock.mock.calls[0][0]).toContain("cancel_requested");
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "returns terminal status %s idempotently for an owned run",
    async (status) => {
      qMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status }]);
      await expect(cancelRun("account-1", "chat-1", "run-terminal")).resolves.toBe(status);
    }
  );

  it("marks interrupted active runs failed during startup recovery", async () => {
    qMock.mockResolvedValueOnce([{ id: "one" }, { id: "two" }]);
    await expect(recoverInterruptedRuns()).resolves.toBe(2);
    expect(qMock.mock.calls[0][0]).toContain("SERVER_RESTARTED");
  });

  it("atomically refuses assistant publication when cancellation already owns the run", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "cancelling", cancel_requested: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    connectMock.mockResolvedValueOnce({ query, release: vi.fn() } as any);

    const result = await completeRunWithAssistant("account-1", "chat-1", "run-cancelled", {
      content: "must not persist",
      meta: {
        charts: ["11111111-1111-4111-8111-111111111111"],
        report: "22222222-2222-4222-8222-222222222222",
        model: "chat-model",
        source_mode: "selected",
        source_ids: [],
        evidence: [],
        query_results: [],
      },
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO messages"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='published'"))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("publishes referenced artifacts, assistant message, and completion in one locked transaction", async () => {
    const chartId = "11111111-1111-4111-8111-111111111111";
    const reportId = "22222222-2222-4222-8222-222222222222";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT status, cancel_requested")) {
        return { rows: [{ status: "running", cancel_requested: false }] };
      }
      if (sql.includes("UPDATE charts SET status='published'")) return { rows: [{ id: chartId }] };
      if (sql.includes("UPDATE reports SET status='published'")) return { rows: [{ id: reportId }] };
      if (sql.includes("INSERT INTO messages")) return { rows: [{ id: 42 }] };
      if (sql.includes("UPDATE chat_runs SET status='completed'")) return { rows: [{ id: "run-complete" }] };
      return { rows: [] };
    });
    connectMock.mockResolvedValueOnce({ query, release: vi.fn() } as any);

    const result = await completeRunWithAssistant("account-1", "chat-1", "run-complete", {
      content: "durable answer",
      meta: {
        charts: [chartId],
        report: reportId,
        model: "chat-model",
        source_mode: "selected",
        source_ids: [],
        evidence: [],
        query_results: [],
      },
    });

    expect(result).toMatchObject({ status: "completed", message: { id: 42, content: "durable answer" } });
    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining("UPDATE charts SET status='published'"),
        expect.stringContaining("UPDATE reports SET status='published'"),
        expect.stringContaining("INSERT INTO messages"),
        expect.stringContaining("UPDATE chat_runs SET status='completed'"),
      ])
    );
    expect(sql.findIndex((statement) => statement.includes("UPDATE charts SET status='published'"))).toBeLessThan(
      sql.findIndex((statement) => statement.includes("INSERT INTO messages"))
    );
    expect(sql.findIndex((statement) => statement.includes("INSERT INTO messages"))).toBeLessThan(
      sql.findIndex((statement) => statement.includes("UPDATE chat_runs SET status='completed'"))
    );
    expect(sql.at(-1)).toBe("COMMIT");
  });

  it("sweeps pre-existing terminal-run pending report files before deleting their rows", async () => {
    qMock
      .mockResolvedValueOnce([{ account_id: "account-1", run_id: "run-terminal" }])
      .mockResolvedValueOnce([{ id: "report-1", html_path: "/safe/report.html", pdf_path: "/safe/report.pdf" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(sweepOrphanedPendingArtifacts()).resolves.toBe(1);

    expect(removeReportArtifactsMock).toHaveBeenCalledWith({
      accountId: "account-1",
      reportId: "report-1",
      htmlPath: "/safe/report.html",
      pdfPath: "/safe/report.pdf",
    });
    expect(qMock.mock.calls[2][0]).toContain("DELETE FROM reports");
  });
});
