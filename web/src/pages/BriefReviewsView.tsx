import { useCallback, useEffect, useRef, useState } from "react";
import { Inbox, Loader2, RefreshCw } from "lucide-react";
import { briefReviewsApi, briefsApi, formatApiError, type BriefReviewRow, type BriefRunStage } from "@/lib/api";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BriefComparisonView,
  BriefFailedPublication,
  BriefFreshness,
  BriefStageBadge,
} from "@/components/briefs/BriefStatus";

/**
 * The M16 review inbox: every `awaiting_review`, publishing, and decided brief
 * run, pending-first. Rows carry the recipe/run identity, the current-vs-
 * baseline comparison with explicit completeness flags, freshness receipts,
 * the draft pointer (opened in the M13 workbench), failed-publication
 * indicators with honest retry guidance, and the read-only decision ledger
 * tail. Approvals are pinned to the exact draft revision and reach `approved`
 * only after the publication commits (202 + exact-ID polling). Nothing here
 * ever auto-approves, auto-publishes, or sends anything outbound.
 */

const REVIEWS_PAGE_LIMIT = 20;
const POLL_BASE_MS = 2_000;
const POLL_MAX_MS = 30_000;
const POLL_HIDDEN_MS = 10_000;
const MAX_POLLED_RUNS = 4;
const REVIEW_NOTE_MAX = 1_000;

const PENDING_STAGES: readonly BriefRunStage[] = ["awaiting_review", "publishing"];

function isPendingRow(row: BriefReviewRow): boolean {
  return PENDING_STAGES.includes(row.stage);
}

const CONFLICT_GUIDANCE =
  "The draft changed since this review pointer. Refresh the inbox and decide again on the current revision — unseen content is never approved.";
const RUN_STATE_GUIDANCE =
  "An approval for this draft is already accepted or committed and cannot be revoked or re-decided here. Refresh the inbox to see its durable state.";

export function BriefReviewsView() {
  const [rows, setRows] = useState<BriefReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowGuidance, setRowGuidance] = useState<Record<string, string>>({});
  const [rejectDraftId, setRejectDraftId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const mountedRef = useRef(false);
  const catalogRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreOwnerRef = useRef<number | null>(null);
  const decisionRequestRef = useRef(0);
  const pollFailuresRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++catalogRequestRef.current;
    loadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setPageError(null);
    try {
      const page = await briefReviewsApi.list({ limit: REVIEWS_PAGE_LIMIT });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setRows((current) => mergeCatalogHead(page.items, current));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current)
        setPageError(formatApiError(failure, "Could not load the review inbox"));
    } finally {
      if (mountedRef.current && requestId === catalogRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      loadingMoreOwnerRef.current = null;
      decisionRequestRef.current += 1;
    };
  }, [load]);

  const loadMore = async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingMoreOwnerRef.current !== null) return;
    const requestId = ++catalogRequestRef.current;
    loadingMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await briefReviewsApi.list({ cursor, limit: REVIEWS_PAGE_LIMIT });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setRows((current) => mergeCatalogContinuation(current, page.items));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current)
        setPageError(formatApiError(failure, "Could not load older reviews"));
    } finally {
      if (loadingMoreOwnerRef.current === requestId) {
        loadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  };

  const applyRunStatus = (runId: string, stage: BriefRunStage) => {
    setRows((current) => current.map((row) => (row.id === runId ? { ...row, stage } : row)));
  };

  const decide = async (row: BriefReviewRow, decision: "approve" | "reject") => {
    if (busyId === row.id) return;
    if (!row.document_revision_id) {
      setRowGuidance((current) => ({ ...current, [row.id]: "This run carries no draft revision to decide on." }));
      return;
    }
    const requestId = ++decisionRequestRef.current;
    setBusyId(row.id);
    setRowGuidance((current) => ({ ...current, [row.id]: "" }));
    try {
      const result = await briefReviewsApi.decide(row.id, {
        decision,
        document_revision_id: row.document_revision_id,
        ...(decision === "reject" && rejectNote.trim() ? { note: rejectNote.trim() } : {}),
      });
      if (!mountedRef.current || requestId !== decisionRequestRef.current) return;
      if (result.status === "publishing") {
        // 202 while rendering: the row is durably `publishing`; the approved
        // confirmation arrives only after the publication commits (polled).
        applyRunStatus(row.id, "publishing");
      } else if (result.status === "approved") {
        applyRunStatus(row.id, "approved");
      } else {
        applyRunStatus(row.id, "rejected");
      }
      setRejectDraftId(null);
      setRejectNote("");
      void load();
    } catch (failure: unknown) {
      if (!mountedRef.current || requestId !== decisionRequestRef.current) return;
      const code = (failure as { data?: { code?: unknown } }).data?.code;
      if (code === "BRIEF_REVIEW_REVISION_CONFLICT")
        setRowGuidance((current) => ({ ...current, [row.id]: CONFLICT_GUIDANCE }));
      else if (code === "BRIEF_RUN_STATE") setRowGuidance((current) => ({ ...current, [row.id]: RUN_STATE_GUIDANCE }));
      else
        setRowGuidance((current) => ({
          ...current,
          [row.id]: formatApiError(failure, "The decision was not recorded."),
        }));
    } finally {
      if (mountedRef.current && requestId === decisionRequestRef.current) {
        setBusyId((current) => (current === row.id ? null : current));
      }
    }
  };

  const publishingRows = rows.filter((row) => row.stage === "publishing");
  const publishingSignature = publishingRows
    .slice(0, MAX_POLLED_RUNS)
    .map((row) => `${row.recipe_id}:${row.id}`)
    .join(",");

  // Exact-ID publication status polling while any row renders: visibility
  // aware and widening on consecutive failures, per the M16 polling bounds.
  useEffect(() => {
    if (!publishingSignature) return;
    let cancelled = false;
    let timer = 0;
    const targets = publishingSignature.split(",").map((entry) => {
      const [recipeId, runId] = entry.split(":");
      return { recipeId, runId };
    });
    const tick = async () => {
      if (document.visibilityState !== "visible") {
        if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_HIDDEN_MS);
        return;
      }
      let failed = false;
      try {
        const updates = await Promise.all(
          targets.map((target) => briefsApi.getRun(target.recipeId, target.runId).catch(() => null)),
        );
        const fresh = updates.filter((update) => update !== null);
        if (cancelled) return;
        if (fresh.length > 0) {
          pollFailuresRef.current = 0;
          let settled = false;
          for (const update of fresh) {
            if (update.stage !== "publishing") settled = true;
            applyRunStatus(update.id, update.stage);
          }
          if (settled) void load();
        } else {
          failed = true;
        }
      } catch {
        failed = true;
      }
      if (failed) pollFailuresRef.current += 1;
      if (cancelled) return;
      const widened = Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** pollFailuresRef.current);
      timer = window.setTimeout(() => void tick(), widened);
    };
    timer = window.setTimeout(() => void tick(), POLL_BASE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [publishingSignature, load]);

  const pendingRows = rows.filter(isPendingRow);
  const decidedRows = rows.filter((row) => !isPendingRow(row));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Reviews</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Reviewed-brief drafts waiting on you, pending first. Approval publishes the exact reviewed revision as an
              app-internal report — never an email, webhook, or anything outbound. Pending reviews never block later
              scheduled runs and are never auto-approved.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Refresh
          </Button>
        </div>

        {pageError && (
          <div
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {pageError}
          </div>
        )}

        {loading ? (
          <div className="mt-8 space-y-3">
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <Card className="mt-8 flex flex-col items-center gap-3 py-16 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No reviews yet. Drafts appear here after a brief finishes its run pipeline.
            </p>
          </Card>
        ) : (
          <div className="mt-8 space-y-8">
            <section aria-labelledby="pending-reviews-heading" className="space-y-3">
              <h2 id="pending-reviews-heading" className="text-lg font-semibold">
                Awaiting review{" "}
                {pendingRows.length > 0 && <span className="text-muted-foreground">({pendingRows.length})</span>}
              </h2>
              {pendingRows.length === 0 && (
                <p className="text-sm text-muted-foreground">Nothing is waiting. Decided drafts stay below.</p>
              )}
              {pendingRows.map((row) => (
                <ReviewRow
                  key={row.id}
                  row={row}
                  busyId={busyId}
                  guidance={rowGuidance[row.id] ?? ""}
                  rejecting={rejectDraftId === row.id}
                  rejectNote={rejectNote}
                  setRejectNote={setRejectNote}
                  onStartReject={(id) => {
                    setRejectDraftId(id);
                    setRejectNote("");
                    setRowGuidance((current) => ({ ...current, [id]: "" }));
                  }}
                  onCancelReject={() => {
                    setRejectDraftId(null);
                    setRejectNote("");
                  }}
                  onDecide={(decision) => void decide(row, decision)}
                  onRefresh={() => void load()}
                />
              ))}
            </section>

            {decidedRows.length > 0 && (
              <section aria-labelledby="decided-reviews-heading" className="space-y-3">
                <h2 id="decided-reviews-heading" className="text-lg font-semibold">
                  Decided
                </h2>
                {decidedRows.map((row) => (
                  <ReviewRow
                    key={row.id}
                    row={row}
                    busyId={busyId}
                    guidance={rowGuidance[row.id] ?? ""}
                    rejecting={false}
                    rejectNote=""
                    setRejectNote={() => undefined}
                    onStartReject={undefined}
                    onCancelReject={() => undefined}
                    onDecide={undefined}
                    onRefresh={() => void load()}
                  />
                ))}
              </section>
            )}

            {nextCursor && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                  Load older reviews
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewRow({
  row,
  busyId,
  guidance,
  rejecting,
  rejectNote,
  setRejectNote,
  onStartReject,
  onCancelReject,
  onDecide,
  onRefresh,
}: {
  row: BriefReviewRow;
  busyId: string | null;
  guidance: string;
  rejecting: boolean;
  rejectNote: string;
  setRejectNote: (value: string) => void;
  onStartReject: ((id: string) => void) | undefined;
  onCancelReject: () => void;
  onDecide: ((decision: "approve" | "reject") => void) | undefined;
  onRefresh: () => void;
}) {
  const busy = busyId === row.id;
  const decided = row.review !== null || row.stage === "approved" || row.stage === "rejected";
  const canDecide = row.stage === "awaiting_review" && Boolean(row.document_revision_id);
  return (
    <Card className="space-y-3 p-4" aria-label={`Review for ${row.recipe_name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.recipe_name}</span>
        <Badge variant="secondary">rev {row.recipe_revision}</Badge>
        {row.recipe_state === null && <Badge variant="outline">recipe deleted</Badge>}
        {row.recipe_state === "paused" && row.recipe_paused_reason && (
          <Badge variant="pending" title={row.recipe_paused_reason}>
            recipe paused
          </Badge>
        )}
        <BriefStageBadge stage={row.stage} />
        {row.stage === "publishing" && <span className="text-xs text-muted-foreground">rendering publication…</span>}
        <span className="ml-auto text-xs text-muted-foreground">{formatDate(row.created_at)}</span>
      </div>
      <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        <span>{row.trigger}</span>
        <span className="font-mono">{row.occurrence_key}</span>
        <span>run {row.id.slice(0, 8)}</span>
        {row.coalesced_count > 0 && (
          <span className="text-warning">
            coalesced {row.coalesced_count} missed occurrence{row.coalesced_count === 1 ? "" : "s"}
            {row.missed_through_key ? ` through ${row.missed_through_key}` : ""}
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-medium text-muted-foreground">Current vs baseline</p>
          <BriefComparisonView summary={row.comparison_summary} />
        </div>
        <div>
          <p className="text-[11px] font-medium text-muted-foreground">Input freshness</p>
          <BriefFreshness receipts={row.refresh_receipts} />
        </div>
      </div>

      {row.publication_failure && <BriefFailedPublication code={row.publication_failure.code} />}

      {row.document_id && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <a
            className="inline-flex items-center gap-1 text-primary underline"
            href={`#/documents/${row.document_id}`}
            aria-label={`Open draft for ${row.recipe_name} in the editor`}
          >
            Open draft in the workbench
          </a>
          {row.document_revision_id && (
            <span className="font-mono text-muted-foreground">rev {row.document_revision_id.slice(0, 8)}</span>
          )}
          {row.head_moved && (
            <span className="text-warning">the draft was edited after this pointer — refresh before deciding</span>
          )}
        </div>
      )}

      {guidance && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" role="alert">
          {guidance}{" "}
          <Button variant="link" size="sm" className="h-auto p-0 underline" onClick={onRefresh}>
            Refresh inbox
          </Button>
        </div>
      )}

      {canDecide && !decided && onStartReject ? (
        <div className="space-y-2 border-t pt-3">
          {rejecting ? (
            <div className="space-y-2">
              <textarea
                value={rejectNote}
                onChange={(event) => setRejectNote(event.target.value)}
                maxLength={REVIEW_NOTE_MAX}
                aria-label="Rejection note (optional)"
                placeholder="Optional note preserved with the decision (max 1,000 characters)."
                className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={onCancelReject}>
                  Keep reviewing
                </Button>
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => onDecide?.("reject")}>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Reject (keeps the run and draft)
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onStartReject?.(row.id)}>
                Reject…
              </Button>
              <Button size="sm" disabled={busy || !canDecide} onClick={() => onDecide?.("approve")}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Approve this revision
              </Button>
            </div>
          )}
          {row.head_moved && (
            <p className="text-[11px] text-warning">
              Approving will conflict until the inbox is refreshed to the edited head.
            </p>
          )}
        </div>
      ) : null}

      {row.review && (
        <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
          <p>
            Decision ledger (read-only):{" "}
            <Badge variant={row.review.decision === "approve" ? "success" : "outline"}>{row.review.decision}</Badge>{" "}
            <time dateTime={row.review.created_at}>{formatDate(row.review.created_at)}</time>{" "}
            <span className="font-mono">rev {row.review.document_revision_id.slice(0, 8)}</span>
          </p>
          {row.review.note && <p className="text-foreground">“{row.review.note}”</p>}
          {row.stage === "approved" && (
            <p className="text-success">Approved — the publication committed for this revision.</p>
          )}
          {row.review.decision === "reject" ? (
            <p>Rejection preserved the run and draft for inspection; it cannot publish.</p>
          ) : (
            <p>Approval publishes inside the app only — no sharing, email, webhook, or other outbound delivery.</p>
          )}
        </div>
      )}
    </Card>
  );
}
