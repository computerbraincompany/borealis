import type { ReportArtifactCleanupIntent } from "./db/stores/runStore.js";
import { removeReportArtifacts } from "./storageArtifacts.js";
import { storageRuntime } from "./storageRuntime.js";

const CLEANUP_FAILURE_CODE = "REPORT_ARTIFACT_CLEANUP_FAILED";

export interface ReportCleanupSummary {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
}

/** Complete durable report deletion intents after the owning row is hidden. */
export async function completeReportArtifactCleanup(
  intents: readonly ReportArtifactCleanupIntent[]
): Promise<ReportCleanupSummary> {
  const runtime = storageRuntime();
  let completed = 0;
  let failed = 0;
  for (const intent of intents) {
    try {
      // A legacy or partially-created report can own no filesystem artifacts.
      // Its durable cleanup intent is already satisfied and must not retry
      // forever merely because there is no path whose ownership can be proven.
      const removed =
        intent.htmlPath === null && intent.pdfPath === null
          ? true
          : await removeReportArtifacts({
              accountId: intent.accountId,
              reportId: intent.id,
              htmlPath: intent.htmlPath,
              pdfPath: intent.pdfPath,
            });
      if (!removed) throw new Error("report artifact ownership could not be proven");
      await runtime.runs.clearReportArtifactCleanupIntent(intent.accountId, intent.id);
      completed += 1;
    } catch {
      failed += 1;
      await runtime.runs
        .recordReportArtifactCleanupFailure(intent.accountId, intent.id, CLEANUP_FAILURE_CODE)
        .catch(() => {});
    }
  }
  return Object.freeze({ attempted: intents.length, completed, failed });
}

export async function repairReportArtifactCleanup(limit = 100): Promise<ReportCleanupSummary> {
  return completeReportArtifactCleanup(await storageRuntime().runs.listReportArtifactCleanupIntents(limit));
}
