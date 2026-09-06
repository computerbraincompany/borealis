import type { DocumentArtifactCleanupIntent, DocumentPublicationCleanupJob } from "./db/stores/documentStore.js";
import { removeDocumentArtifacts, removeDocumentPublicationArtifacts } from "./storageArtifacts.js";
import { storageRuntime } from "./storageRuntime.js";

const CLEANUP_FAILURE_CODE = "DOCUMENT_ARTIFACT_CLEANUP_FAILED";

export interface DocumentCleanupSummary {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
}

/**
 * Complete durable document deletion intents after the owning row is hidden.
 * A document's export artifacts live under one exact
 * `reports/documents/<account>/<document>` namespace, so removal proves that
 * containment and removes nothing else. A document that never published has
 * no filesystem directory and its intent is already satisfied.
 */
export async function completeDocumentArtifactCleanup(
  intents: readonly Readonly<DocumentArtifactCleanupIntent>[]
): Promise<DocumentCleanupSummary> {
  const runtime = storageRuntime();
  let completed = 0;
  let failed = 0;
  for (const intent of intents) {
    try {
      const removed = await removeDocumentArtifacts({ accountId: intent.accountId, documentId: intent.documentId });
      if (!removed) throw new Error("document artifact ownership could not be proven");
      await runtime.documents.clearDocumentArtifactCleanupIntent(intent.accountId, intent.documentId);
      completed += 1;
    } catch {
      failed += 1;
      await runtime.documents
        .recordDocumentArtifactCleanupFailure(intent.accountId, intent.documentId, CLEANUP_FAILURE_CODE)
        .catch(() => {});
    }
  }
  return Object.freeze({ attempted: intents.length, completed, failed });
}

export async function repairDocumentArtifactCleanup(limit = 100): Promise<DocumentCleanupSummary> {
  return completeDocumentArtifactCleanup(await storageRuntime().documents.listDocumentArtifactCleanupIntents(limit));
}

/** Remove partial artifacts reserved by crash-recovered render intents. */
export async function completeDocumentPublicationCleanup(
  jobs: readonly Readonly<DocumentPublicationCleanupJob>[]
): Promise<DocumentCleanupSummary> {
  const runtime = storageRuntime();
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const removed = await removeDocumentPublicationArtifacts({
        accountId: job.accountId,
        documentId: job.documentId,
        publicationId: job.id,
        directory: job.artifactDirectory,
      });
      if (!removed) throw new Error("publication artifact ownership could not be proven");
      await runtime.documents.clearDocumentPublicationCleanupJob(job.accountId, job.id);
      completed += 1;
    } catch {
      failed += 1;
      await runtime.documents
        .recordDocumentPublicationCleanupFailure(job.accountId, job.id, CLEANUP_FAILURE_CODE)
        .catch(() => {});
    }
  }
  return Object.freeze({ attempted: jobs.length, completed, failed });
}

/**
 * Startup repair for the document publication protocol: interrupted renders
 * become durable retryable failures (their drafts and the previous
 * publication stay intact) and reserve exact-directory artifact cleanup.
 */
export async function repairDocumentPublications(limit = 100): Promise<DocumentCleanupSummary> {
  const runtime = storageRuntime();
  await runtime.documents.recoverInterruptedDocumentPublications();
  return completeDocumentPublicationCleanup(await runtime.documents.listDocumentPublicationCleanupJobs(limit));
}
