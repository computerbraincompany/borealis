import { pool, q } from "./db.js";
import type { AgentCompletion } from "./agent.js";
import { removeReportArtifacts } from "./storageArtifacts.js";
import { appLog } from "./appLogger.js";

const activeControllers = new Map<string, AbortController>();
const terminalizationRetries = new Map<string, Promise<"completed" | "failed" | "cancelled">>();

export async function beginRun(accountId: string, chatId: string, runId: string): Promise<AbortController> {
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  try {
    const [row] = await q(
      `SELECT status, cancel_requested FROM chat_runs WHERE id=$1 AND chat_id=$2 AND account_id=$3`,
      [runId, chatId, accountId]
    );
    if (!row || row.cancel_requested || row.status === "cancelling" || row.status === "cancelled") controller.abort();
    return controller;
  } catch {
    // The accepted run is already durable and this process owns its executor.
    // A transient read failure must not orphan it: keep the controller mapped
    // so a later durable cancel can still abort execution. Completion's locked
    // transaction remains the authoritative terminal decision.
    return controller;
  }
}

export async function finishRun(
  accountId: string,
  chatId: string,
  runId: string,
  status: "completed" | "failed" | "cancelled",
  errorCode?: string
): Promise<"completed" | "failed" | "cancelled"> {
  const rows = await q(
    `UPDATE chat_runs
     SET status=CASE WHEN cancel_requested AND $4 IN ('completed','failed') THEN 'cancelled' ELSE $4 END,
         finished_at=now(),
         error_code=CASE WHEN cancel_requested AND $4 IN ('completed','failed') THEN 'CANCELLED' ELSE $5 END
     WHERE id=$1 AND chat_id=$2 AND account_id=$3 AND status IN ('running','cancelling')
     RETURNING status`,
    [runId, chatId, accountId, status, errorCode || null]
  );
  if (rows[0]?.status === "completed" || rows[0]?.status === "failed" || rows[0]?.status === "cancelled") {
    if (rows[0].status !== "completed") await cleanupPendingRunArtifacts(accountId, runId).catch(() => {});
    activeControllers.delete(runId);
    return rows[0].status;
  }
  const [existing] = await q(`SELECT status FROM chat_runs WHERE id=$1 AND chat_id=$2 AND account_id=$3`, [
    runId,
    chatId,
    accountId,
  ]);
  if (existing?.status === "running" || existing?.status === "cancelling") {
    throw new Error("durable chat run remains active");
  }
  const terminal =
    existing?.status === "completed" || existing?.status === "failed" || existing?.status === "cancelled"
      ? existing.status
      : status;
  if (terminal !== "completed") await cleanupPendingRunArtifacts(accountId, runId).catch(() => {});
  activeControllers.delete(runId);
  return terminal;
}

/**
 * Keep an accepted executor owned until a terminal database decision succeeds.
 * A transient outage must not strand a `running`/`cancelling` row until the
 * next process restart. The SQL in finishRun makes a concurrent cancellation
 * win over either completion or failure on every retry.
 */
export function finishRunDurably(
  accountId: string,
  chatId: string,
  runId: string,
  status: "completed" | "failed" | "cancelled",
  errorCode?: string
): Promise<"completed" | "failed" | "cancelled"> {
  const existing = terminalizationRetries.get(runId);
  if (existing) return existing;
  const retry = (async () => {
    let attempt = 0;
    while (true) {
      try {
        return await finishRun(accountId, chatId, runId, status, errorCode);
      } catch {
        attempt += 1;
        appLog.warn(
          { run_id: runId, error_code: "RUN_TERMINAL_RETRY", attempt },
          "durable run terminalization will retry"
        );
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 25 * 2 ** Math.min(attempt, 6))));
      }
    }
  })();
  terminalizationRetries.set(runId, retry);
  void retry.finally(() => {
    if (terminalizationRetries.get(runId) === retry) terminalizationRetries.delete(runId);
  });
  return retry;
}

export async function completeRunWithAssistant(
  accountId: string,
  chatId: string,
  runId: string,
  completion: AgentCompletion
): Promise<{
  status: "completed" | "cancelled";
  message?: { id: unknown; content: string; meta: AgentCompletion["meta"] };
}> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const selected = await client.query(
      `SELECT status, cancel_requested FROM chat_runs
       WHERE id=$1 AND chat_id=$2 AND account_id=$3 FOR UPDATE`,
      [runId, chatId, accountId]
    );
    const run = selected.rows[0];
    if (!run) throw new Error("durable chat run not found");
    if (run.cancel_requested || run.status === "cancelling" || run.status === "cancelled") {
      await client.query(
        `UPDATE chat_runs SET status='cancelled', finished_at=COALESCE(finished_at,now()), error_code='CANCELLED'
         WHERE id=$1 AND chat_id=$2 AND account_id=$3`,
        [runId, chatId, accountId]
      );
      await client.query("COMMIT");
      inTransaction = false;
      await cleanupPendingRunArtifacts(accountId, runId).catch(() => {});
      activeControllers.delete(runId);
      return { status: "cancelled" };
    }
    if (run.status === "completed") {
      await client.query("COMMIT");
      inTransaction = false;
      activeControllers.delete(runId);
      return { status: "completed" };
    }
    if (run.status !== "running") throw new Error("durable chat run is not completable");
    const chartIds = [...new Set(completion.meta.charts)];
    if (chartIds.length) {
      const publishedCharts = await client.query(
        `UPDATE charts SET status='published', run_id=NULL
         WHERE account_id=$1 AND run_id=$2 AND status='pending' AND id=ANY($3::uuid[])
         RETURNING id`,
        [accountId, runId, chartIds]
      );
      if (publishedCharts.rows.length !== chartIds.length) throw new Error("pending chart ownership mismatch");
    }
    await client.query(
      `DELETE FROM charts
       WHERE account_id=$1 AND run_id=$2 AND status='pending'
         AND ($3::uuid[] IS NULL OR NOT (id=ANY($3::uuid[])))`,
      [accountId, runId, chartIds.length ? chartIds : null]
    );
    if (completion.meta.report) {
      const publishedReport = await client.query(
        `UPDATE reports SET status='published', run_id=NULL
         WHERE id=$1 AND account_id=$2 AND run_id=$3 AND status='pending'
         RETURNING id`,
        [completion.meta.report, accountId, runId]
      );
      if (!publishedReport.rows.length) throw new Error("pending report ownership mismatch");
    }
    const inserted = await client.query(
      `INSERT INTO messages (chat_id, role, content, meta)
       VALUES ($1,'assistant',$2,$3::jsonb) RETURNING id`,
      [chatId, completion.content, JSON.stringify(completion.meta)]
    );
    const terminal = await client.query(
      `UPDATE chat_runs SET status='completed', finished_at=now(), error_code=NULL
       WHERE id=$1 AND chat_id=$2 AND account_id=$3 AND status='running' AND cancel_requested=false
       RETURNING id`,
      [runId, chatId, accountId]
    );
    if (!terminal.rows.length) throw new Error("durable chat completion lost ownership");
    await client.query("COMMIT");
    inTransaction = false;
    // Unreferenced pending artifacts remain recoverable until their files are
    // removed; a crash cannot erase the only durable cleanup paths.
    await cleanupPendingRunArtifacts(accountId, runId).catch(() => {});
    activeControllers.delete(runId);
    return {
      status: "completed",
      message: { id: inserted.rows[0]?.id, content: completion.content, meta: completion.meta },
    };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelRun(
  accountId: string,
  chatId: string,
  runId: string
): Promise<"cancelling" | "completed" | "failed" | "cancelled" | null> {
  const rows = await q(
    `UPDATE chat_runs
     SET cancel_requested=true, status='cancelling'
     WHERE id=$1 AND chat_id=$2 AND account_id=$3 AND status='running'
     RETURNING id`,
    [runId, chatId, accountId]
  );
  if (rows.length) {
    activeControllers.get(runId)?.abort();
    return "cancelling";
  }
  const [existing] = await q(`SELECT status FROM chat_runs WHERE id=$1 AND chat_id=$2 AND account_id=$3`, [
    runId,
    chatId,
    accountId,
  ]);
  if (!existing) return null;
  if (existing.status === "running" || existing.status === "cancelling") {
    activeControllers.get(runId)?.abort();
    return "cancelling";
  }
  if (["completed", "failed", "cancelled"].includes(existing.status)) return existing.status;
  return null;
}

export async function recoverInterruptedRuns(): Promise<number> {
  const rows = await q(
    `UPDATE chat_runs
     SET status='failed', finished_at=now(), error_code='SERVER_RESTARTED'
     WHERE status IN ('running','cancelling')
     RETURNING id, account_id`
  );
  await sweepOrphanedPendingArtifacts().catch(() => {});
  return rows.length;
}

async function cleanupPendingRunArtifacts(accountId: string, runId: string): Promise<void> {
  const reports = await q(
    `SELECT id, html_path, pdf_path FROM reports
     WHERE account_id=$1 AND run_id=$2 AND status='pending'`,
    [accountId, runId]
  );
  // Files go first. If the process crashes, the still-pending row lets startup
  // retry; missing files are an idempotent success at the storage boundary.
  await cleanupReportFiles(accountId, reports);
  await q(`DELETE FROM reports WHERE account_id=$1 AND run_id=$2 AND status='pending'`, [accountId, runId]);
  await q(`DELETE FROM charts WHERE account_id=$1 AND run_id=$2 AND status='pending'`, [accountId, runId]);
}

export async function sweepOrphanedPendingArtifacts(): Promise<number> {
  const rows = await q(
    `SELECT DISTINCT p.account_id, p.run_id
     FROM (
       SELECT account_id, run_id FROM reports WHERE status='pending'
       UNION ALL
       SELECT account_id, run_id FROM charts WHERE status='pending'
     ) p
     LEFT JOIN chat_runs r ON r.id=p.run_id AND r.account_id=p.account_id
     WHERE p.run_id IS NOT NULL AND (r.id IS NULL OR r.status NOT IN ('running','cancelling'))`
  );
  for (const row of rows) await cleanupPendingRunArtifacts(row.account_id, row.run_id);
  return rows.length;
}

async function cleanupReportFiles(accountId: string, reports: readonly any[]): Promise<void> {
  await Promise.all(
    reports.map((report) =>
      removeReportArtifacts({
        accountId,
        reportId: report.id,
        htmlPath: report.html_path,
        pdfPath: report.pdf_path,
      })
    )
  );
}

export function isRunCancellation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}
