import type { AgentCompletion } from "./agent.js";
import { appLog } from "./appLogger.js";
import type { PendingReportCleanupPath } from "./db/stores/runStore.js";
import { completeReportArtifactCleanup } from "./reportCleanup.js";
import { storageRuntime } from "./storageRuntime.js";
import { removeReportArtifacts } from "./storageArtifacts.js";

interface ActiveRunController {
  readonly accountId: string;
  readonly chatId: string;
  readonly controller: AbortController;
}

const activeControllers = new Map<string, ActiveRunController>();
const terminalizationRetries = new Map<string, Promise<"completed" | "failed" | "cancelled">>();
const PENDING_REPORT_CLEANUP_BATCH = 100;

/** Includes executors whose chat/run row may have been deleted during cancellation. */
export function hasActiveRunExecutors(): boolean {
  return activeControllers.size > 0;
}

export async function beginRun(accountId: string, chatId: string, runId: string): Promise<AbortController> {
  const controller = new AbortController();
  activeControllers.set(runId, { accountId, chatId, controller });
  try {
    const status = await storageRuntime().runs.readBeginStatus(accountId, chatId, runId);
    if (!status || status.shouldAbort) controller.abort();
  } catch {
    // Execution is permitted only after the durable active state is proven.
    controller.abort();
  }
  return controller;
}

export async function finishRun(
  accountId: string,
  chatId: string,
  runId: string,
  status: "failed" | "cancelled",
  errorCode?: string
): Promise<"completed" | "failed" | "cancelled"> {
  const terminal = await storageRuntime().runs.finishRun(accountId, chatId, runId, status, errorCode);
  if (terminal !== "completed") await cleanupPendingRunArtifacts(accountId, runId).catch(() => {});
  activeControllers.delete(runId);
  return terminal;
}

/** Keep an accepted executor owned until a terminal database decision succeeds. */
export function finishRunDurably(
  accountId: string,
  chatId: string,
  runId: string,
  status: "failed" | "cancelled",
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
  const result = await storageRuntime().runs.completeRunWithAssistant(accountId, chatId, runId, completion);
  activeControllers.delete(runId);
  if (result.status === "completed") {
    await completeReportArtifactCleanup(result.reportCleanupIntents);
    return { status: "completed", ...(result.message ? { message: result.message } : {}) };
  }
  await cleanupPendingRunArtifacts(accountId, runId).catch(() => {});
  return { status: "cancelled" };
}

export async function cancelRun(
  accountId: string,
  chatId: string,
  runId: string
): Promise<"cancelling" | "completed" | "failed" | "cancelled" | null> {
  const status = await storageRuntime().runs.requestCancel(accountId, chatId, runId);
  if (status === "cancelling") activeControllers.get(runId)?.controller.abort();
  return status;
}

/**
 * Stop every executor owned by this process and make its durable run terminal
 * before the embedded ledger closes. Fastify is closed first by the caller, so
 * no new run can enter the registry while this snapshot is drained.
 */
export async function shutdownActiveRuns(): Promise<number> {
  const active = [...activeControllers.entries()];
  for (const [, entry] of active) entry.controller.abort();
  await Promise.allSettled(
    active.map(([runId, entry]) => finishRunDurably(entry.accountId, entry.chatId, runId, "cancelled"))
  );
  return active.length;
}

/** Startup reconciliation only; this function never starts timers or workers. */
export async function recoverInterruptedRuns(): Promise<number> {
  const recovered = await storageRuntime().runs.recoverInterruptedRuns();
  await repairQueuedReportArtifacts().catch(() => {});
  await sweepOrphanedPendingArtifacts().catch(() => {});
  return recovered;
}

export async function sweepOrphanedPendingArtifacts(): Promise<number> {
  const groups = await storageRuntime().runs.listOrphanedPendingRunGroups();
  for (const group of groups) {
    await cleanupPendingRunArtifacts(group.accountId, group.runId).catch(() => {});
  }
  return groups.length;
}

async function cleanupPendingRunArtifacts(accountId: string, runId: string | null): Promise<void> {
  const runs = storageRuntime().runs;
  while (true) {
    const reports = await runs.listPendingReportCleanupPaths(accountId, runId, PENDING_REPORT_CLEANUP_BATCH);
    const removed: PendingReportCleanupPath[] = [];
    for (const report of reports) {
      try {
        if (
          (!report.htmlPath && !report.pdfPath) ||
          (await removeReportArtifacts({
            accountId,
            reportId: report.id,
            htmlPath: report.htmlPath,
            pdfPath: report.pdfPath,
          }))
        ) {
          removed.push(report);
        }
      } catch {
        // Keep the exact pending row for the next boot or terminal retry.
      }
    }
    await runs.deletePendingArtifactRows(accountId, runId, removed);
    if (reports.length < PENDING_REPORT_CLEANUP_BATCH || removed.length === 0) return;
  }
}

async function repairQueuedReportArtifacts(): Promise<void> {
  const seenBatches = new Set<string>();
  while (true) {
    const intents = await storageRuntime().runs.listReportArtifactCleanupIntents(PENDING_REPORT_CLEANUP_BATCH);
    if (!intents.length) return;
    const fingerprint = intents.map((intent) => `${intent.accountId}:${intent.id}`).join("|");
    if (seenBatches.has(fingerprint)) return;
    seenBatches.add(fingerprint);
    await completeReportArtifactCleanup(intents);
    if (intents.length < PENDING_REPORT_CLEANUP_BATCH) return;
  }
}

export function isRunCancellation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}
