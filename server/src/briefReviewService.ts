/**
 * Reviewed-brief approval publication + review decisions (M16 stage 3).
 *
 * A review decision is durable first: `briefRunStore.recordReviewDecision`
 * records the immutable decision event, the exact reviewed revision (with an
 * in-transaction head CAS), and — for an approval — the stable
 * publication-operation UUID derived from (run, reviewed revision) in one
 * short SQLite transaction. Only afterwards does this service call M13's
 * `publishDocumentRevision` with that SAME operation UUID: retries reconcile
 * the same durable intent and can never produce a second publication. The
 * run reaches `approved` only after the publication commits (the completed
 * publication is read back through the store); a render failure returns the
 * run to `awaiting_review` with the bounded failed-publication indicator
 * (schema v28), and the retry decision re-checks the head — an edited draft
 * requires a fresh review. An accepted approval freezes the exact reviewed
 * immutable revision: later edits append new head revisions and never alter
 * the revision being published.
 *
 * The publication executes detached (the decision route answers 202 with
 * `publishing`; status is polled on the existing run-detail/inbox routes).
 * A restart where the render died is reconciled at startup
 * (`reconcileBriefPublications`, after M13's own intent repair) and on the
 * next approval retry: completed → `approved`; failed/absent → back to
 * `awaiting_review` with the indicator; still rendering/ready → the same
 * service call replays or idempotently completes the intent.
 *
 * No outbound delivery ever happens here: approval publishes locally only.
 * This is why the review-decision path is deliberately NOT behind the remote-
 * egress consent gate: publication renders an already-drafted revision with
 * the local M13 renderer over durable stored values — it sends nothing to the
 * model provider, and the run's only provider egress (the draft narrative)
 * was itself consent-gated at its transport boundary.
 */
import { storageRuntime } from "./storageRuntime.js";
import { publishDocumentRevision, DocumentPublicationRenderError } from "./documentService.js";
import { type BriefReviewDecision, type StoredBriefRun } from "./db/stores/briefRunStore.js";
import { DocumentStoreError } from "./db/stores/documentStore.js";

export interface BriefReviewDecisionInput {
  readonly decision: BriefReviewDecision;
  readonly documentRevisionId: string;
  readonly note?: string | null;
}

export interface BriefReviewDecisionResult {
  readonly run: StoredBriefRun;
  readonly status: "publishing" | "approved" | "rejected";
  readonly replayed: boolean;
}

/** In-process guard: at most one detached publication task per run. */
const activePublications = new Set<string>();

function publicationFailureCode(error: unknown): string {
  if (error instanceof DocumentPublicationRenderError) return error.code;
  if (error instanceof DocumentStoreError) {
    if (error.code === "DOCUMENT_HEAD_MOVED") return "DOCUMENT_HEAD_MOVED";
    if (error.code === "DOCUMENT_PUBLICATION_ACTIVE") return "PUBLICATION_ACTIVE";
    if (
      error.code === "DOCUMENT_NOT_FOUND" ||
      error.code === "DOCUMENT_REVISION_NOT_FOUND" ||
      error.code === "DOCUMENT_UNAVAILABLE"
    ) {
      return "BRIEF_DRAFT_UNAVAILABLE";
    }
    if (error.code === "DOCUMENT_PUBLICATION_STATE") return "PUBLICATION_STATE";
    return error.code.slice(0, 64);
  }
  return "BRIEF_PUBLICATION_FAILED";
}

/**
 * Drives the durable publication of the run's accepted approval through the
 * real M13 service path with the run's stable operation UUID and finalizes
 * the run stage from the committed publication. Idempotent per run while a
 * task is live; safe to call again for restart reconciliation.
 */
export function ensureBriefPublication(accountId: string, run: StoredBriefRun): Promise<void> {
  const runs = storageRuntime().briefRuns;
  if (run.stage !== "publishing") return Promise.resolve();
  if (!run.documentId || !run.reviewedRevisionId || !run.publicationOperationId) {
    return runs
      .failBriefPublication(accountId, run.id, { errorCode: "BRIEF_PUBLICATION_STATE" })
      .then(() => undefined)
      .catch(() => undefined);
  }
  if (activePublications.has(run.id)) return Promise.resolve();
  activePublications.add(run.id);
  const documentId = run.documentId;
  const reviewedRevisionId = run.reviewedRevisionId;
  const operationId = run.publicationOperationId;
  const task = (async () => {
    try {
      const outcome = await publishDocumentRevision({
        accountId,
        documentId,
        revisionId: reviewedRevisionId,
        operationId,
        expectedRevisionId: run.reviewedRevisionId,
        // The reviewed revision was explicitly selected by the reviewer; an
        // edit appended after the accepted approval cannot alter it (the
        // intent freezes it) and must not silently strand the approval.
        allowNonHeadRevision: true,
      });
      if (outcome.kind === "published") {
        // Approved only after the publication actually committed.
        await runs.completeBriefApproval(accountId, run.id);
        return;
      }
      // 'rendering': an M13-owned render is live for this document in this
      // process; the run stays `publishing` for the completing call/retry.
    } catch (error) {
      await runs
        .failBriefPublication(accountId, run.id, { errorCode: publicationFailureCode(error) })
        .catch(() => undefined);
    } finally {
      activePublications.delete(run.id);
    }
  })();
  void task.catch(() => undefined);
  return task;
}

/**
 * Records one review decision. Rejections are terminal; approvals persist
 * the durable intent and then reconcile the publication (route semantics:
 * 202 + status polling while rendering, idempotent repeats).
 */
export async function requestBriefReviewDecision(
  accountId: string,
  runId: string,
  input: BriefReviewDecisionInput
): Promise<BriefReviewDecisionResult> {
  const runs = storageRuntime().briefRuns;
  const documents = storageRuntime().documents;
  const run = await runs.getRun(accountId, runId);
  if (input.decision === "reject") {
    const { run: decided, replayed } = await runs.recordReviewDecision(accountId, runId, input);
    return Object.freeze({ run: decided, status: "rejected" as const, replayed });
  }
  if (run.stage === "publishing") {
    // The approval was already accepted: reconcile the SAME intent; never a
    // second publication and never a silent revoke.
    const intent =
      run.documentId && run.publicationOperationId
        ? await documents.getDocumentPublicationIntent(accountId, run.documentId, run.publicationOperationId)
        : undefined;
    if (intent?.status === "completed") {
      const approved = await runs.completeBriefApproval(accountId, run.id);
      return Object.freeze({ run: approved, status: "approved" as const, replayed: true });
    }
    if (!intent || intent.status === "failed") {
      // Crashed/unprovable attempt: the review returns (with the indicator),
      // and this same request retries the decision against the current head
      // (the retry CAS rejects with a revision conflict if it moved).
      await runs.failBriefPublication(accountId, run.id, {
        errorCode: intent?.errorCode ?? "BRIEF_PUBLICATION_FAILED",
      });
      const retry = await runs.recordReviewDecision(accountId, runId, input);
      void ensureBriefPublication(accountId, retry.run);
      return Object.freeze({ run: retry.run, status: "publishing" as const, replayed: false });
    }
    void ensureBriefPublication(accountId, run);
    return Object.freeze({ run, status: "publishing" as const, replayed: true });
  }
  const { run: decided, replayed } = await runs.recordReviewDecision(accountId, runId, input);
  if (decided.stage !== "publishing") {
    // Idempotent replay of the recorded approval outcome (already approved).
    return Object.freeze({ run: decided, status: "approved" as const, replayed });
  }
  void ensureBriefPublication(accountId, decided);
  return Object.freeze({ run: decided, status: "publishing" as const, replayed });
}

/**
 * Startup reconciliation for runs interrupted mid-publication (call AFTER
 * `repairDocumentPublications()`, which has already turned interrupted
 * renders into durable retryable failures): every `publishing` run is
 * finalized from its own durable intent — completed → approved, failed or
 * absent → `awaiting_review` with the bounded indicator, ready → the idempotent
 * service completion replays. Aggregate counts only; never IDs or content.
 */
export async function reconcileBriefPublications(limit = 20): Promise<{
  readonly attempted: number;
  readonly approved: number;
  readonly returnedToReview: number;
}> {
  const runs = storageRuntime().briefRuns;
  const documents = storageRuntime().documents;
  let attempted = 0;
  let approved = 0;
  let returnedToReview = 0;
  const rows = await runs.listPublishingRuns(limit).catch(() => []);
  for (const run of rows) {
    attempted += 1;
    const intent =
      run.documentId && run.publicationOperationId
        ? await documents
            .getDocumentPublicationIntent(run.accountId, run.documentId, run.publicationOperationId)
            .catch(() => undefined)
        : undefined;
    if (intent?.status === "completed") {
      const done = await runs.completeBriefApproval(run.accountId, run.id).catch(() => undefined);
      if (done) approved += 1;
      continue;
    }
    if (intent && (intent.status === "ready" || intent.status === "rendering")) {
      void ensureBriefPublication(run.accountId, run);
      continue;
    }
    const failed = await runs
      .failBriefPublication(run.accountId, run.id, { errorCode: intent?.errorCode ?? "BRIEF_PUBLICATION_FAILED" })
      .catch(() => undefined);
    if (failed) returnedToReview += 1;
  }
  return { attempted, approved, returnedToReview };
}
