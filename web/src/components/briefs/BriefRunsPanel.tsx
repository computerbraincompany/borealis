import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Play, XCircle } from "lucide-react";
import {
  briefsApi,
  formatApiError,
  isBriefActiveRunStage,
  type BriefRecipe,
  type BriefRunDetail,
  type BriefRunSummary,
} from "@/lib/api";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { Button } from "@/components/ui/button";
import { BriefComparisonView, BriefFreshness, BriefPipeline, BriefStageBadge } from "@/components/briefs/BriefStatus";

/**
 * Bounded run history for one reviewed brief: keyset pages of run summaries,
 * the stage pipeline visualization with attempt counts, freshness receipts,
 * the persisted comparison, Run now (client-generated idempotency key; a
 * retried intent reuses the same key so the server replays rather than
 * doubles), idempotent cancellation, and visibility-aware exact-ID status
 * polling that backs off on consecutive failures.
 */

const RUNS_PAGE_LIMIT = 20;
const POLL_BASE_MS = 2_000;
const POLL_MAX_MS = 30_000;
const POLL_HIDDEN_MS = 10_000;
const MAX_POLLED_RUNS = 4;

function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function summaryFromDetail(detail: BriefRunDetail): BriefRunSummary {
  // Drop the detail-only payloads; the row keeps the bounded summary fields.
  return {
    id: detail.id,
    recipe_id: detail.recipe_id,
    trigger: detail.trigger,
    operation_id: detail.operation_id,
    occurrence_key: detail.occurrence_key,
    recipe_revision: detail.recipe_revision,
    stage: detail.stage,
    stage_attempts: detail.stage_attempts,
    cancel_requested: detail.cancel_requested,
    deadline_at: detail.deadline_at,
    refresh_deadline_at: detail.refresh_deadline_at,
    coalesced_count: detail.coalesced_count,
    missed_through_key: detail.missed_through_key,
    analysis_run_id: detail.analysis_run_id,
    baseline_run_id: detail.baseline_run_id,
    analysis_succeeded: detail.analysis_succeeded,
    document_id: detail.document_id,
    document_revision_id: detail.document_revision_id,
    reviewed_revision_id: detail.reviewed_revision_id,
    publication_operation_id: detail.publication_operation_id,
    publication_error_code: detail.publication_error_code,
    failure_code: detail.failure_code,
    failure_reason: detail.failure_reason,
    created_at: detail.created_at,
    started_at: detail.started_at,
    stage_updated_at: detail.stage_updated_at,
    finished_at: detail.finished_at,
  };
}

export function BriefRunsPanel({ recipe }: { recipe: BriefRecipe }) {
  const [runs, setRuns] = useState<BriefRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [runNowError, setRunNowError] = useState<string | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, BriefRunDetail>>({});

  const mountedRef = useRef(false);
  const catalogRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreOwnerRef = useRef<number | null>(null);
  const detailRequestRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const runNowRequestRef = useRef(0);
  const pendingOperationIdRef = useRef<string | null>(null);
  const pollFailuresRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      loadingMoreOwnerRef.current = null;
      detailRequestRef.current += 1;
      detailAbortRef.current?.abort();
      runNowRequestRef.current += 1;
      pendingOperationIdRef.current = null;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = ++catalogRequestRef.current;
    loadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    setPageError(null);
    try {
      const page = await briefsApi.listRuns(recipe.id, { limit: RUNS_PAGE_LIMIT });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setRuns((current) => mergeCatalogHead(page.items, current));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current)
        setPageError(formatApiError(failure, "Could not load brief runs"));
    } finally {
      if (mountedRef.current && requestId === catalogRequestRef.current) setLoading(false);
    }
  }, [recipe.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingMoreOwnerRef.current !== null) return;
    const requestId = ++catalogRequestRef.current;
    loadingMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await briefsApi.listRuns(recipe.id, { cursor, limit: RUNS_PAGE_LIMIT });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setRuns((current) => mergeCatalogContinuation(current, page.items));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current)
        setPageError(formatApiError(failure, "Could not load older runs"));
    } finally {
      if (loadingMoreOwnerRef.current === requestId) {
        loadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  };

  const runNow = async () => {
    if (runNowBusy) return;
    const requestId = ++runNowRequestRef.current;
    // Reuse the retained operation id until the server durably accepts it:
    // the key is the idempotency contract, so a retry can never double-run.
    const operationId = pendingOperationIdRef.current ?? newOperationId();
    pendingOperationIdRef.current = operationId;
    setRunNowBusy(true);
    setRunNowError(null);
    try {
      const accepted = await briefsApi.run(recipe.id, { operation_id: operationId });
      if (!mountedRef.current || requestId !== runNowRequestRef.current) return;
      pendingOperationIdRef.current = null;
      setRuns((current) => mergeCatalogHead([accepted.run], current));
      void load();
    } catch (failure: unknown) {
      if (!mountedRef.current || requestId !== runNowRequestRef.current) return;
      const code = (failure as { data?: { code?: unknown } }).data?.code;
      if (code === "BRIEF_ACTIVE_RUN") {
        pendingOperationIdRef.current = null;
        setRunNowError("A run is already executing for this brief.");
      } else if (code === "BRIEF_RECIPE_NOT_FOUND") {
        pendingOperationIdRef.current = null;
        setRunNowError(formatApiError(failure, "This brief no longer exists."));
      } else {
        // The accepted 202 may have been lost in transit; keep the key so the
        // next attempt replays the same durable run instead of minting one.
        setRunNowError(formatApiError(failure, "Could not start the run. Retry replays the same request."));
      }
    } finally {
      if (mountedRef.current && requestId === runNowRequestRef.current) setRunNowBusy(false);
    }
  };

  const cancelRun = async (run: BriefRunSummary) => {
    if (cancelBusyId === run.id) return;
    const requestId = ++catalogRequestRef.current;
    setCancelBusyId(run.id);
    try {
      const updated = await briefsApi.cancelRun(recipe.id, run.id);
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setRuns((current) => current.map((entry) => (entry.id === run.id ? summaryFromDetail(updated) : entry)));
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current)
        setPageError(formatApiError(failure, "Could not request cancellation"));
    } finally {
      if (mountedRef.current) setCancelBusyId((current) => (current === run.id ? null : current));
    }
  };

  const toggleDetails = async (runId: string) => {
    if (expandedId === runId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(runId);
    if (details[runId]) return;
    const requestId = ++detailRequestRef.current;
    detailAbortRef.current?.abort();
    const abort = new AbortController();
    detailAbortRef.current = abort;
    try {
      const detail = await briefsApi.getRun(recipe.id, runId, abort.signal);
      if (!mountedRef.current || requestId !== detailRequestRef.current || abort.signal.aborted) return;
      setDetails((current) => ({ ...current, [runId]: detail }));
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === detailRequestRef.current && !abort.signal.aborted)
        setPageError(formatApiError(failure, "Could not load the run detail"));
    }
  };

  const activeIds = runs.filter((run) => isBriefActiveRunStage(run.stage)).map((run) => run.id);
  const activeSignature = activeIds.slice(0, MAX_POLLED_RUNS).join(",");

  // Exact-ID status polling while a run occupies the pipeline: visibility
  // aware, self-rescheduling, widening on consecutive failures.
  useEffect(() => {
    if (!activeSignature) return;
    let cancelled = false;
    let timer = 0;
    const ids = activeSignature.split(",");
    const tick = async () => {
      if (document.visibilityState !== "visible") {
        if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_HIDDEN_MS);
        return;
      }
      let failed = false;
      try {
        const updates = await Promise.all(ids.map((id) => briefsApi.getRun(recipe.id, id).catch(() => null)));
        const fresh = updates.filter((update): update is BriefRunDetail => update !== null);
        if (fresh.length > 0 && !cancelled) {
          setRuns((current) =>
            current.map((run) => {
              const update = fresh.find((candidate) => candidate.id === run.id);
              return update ? summaryFromDetail(update) : run;
            }),
          );
          pollFailuresRef.current = 0;
        } else if (fresh.length === 0) {
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
  }, [activeSignature, recipe.id]);

  const hasActive = activeIds.length > 0;

  return (
    <div className="space-y-3" aria-label={`Runs for ${recipe.name}`} aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {hasActive
            ? "A run is executing — status refreshes while this window is open."
            : "Run history and manual runs."}
        </p>
        <div className="flex items-center gap-2">
          {runNowError && (
            <span className="text-xs text-destructive" role="alert">
              {runNowError}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => void runNow()} disabled={runNowBusy || hasActive}>
            {runNowBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run now
          </Button>
        </div>
      </div>
      {pageError && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {pageError}
        </p>
      )}
      <ol className="max-h-80 space-y-2 overflow-y-auto" aria-label="Brief run history">
        {loading && (
          <li className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
            Loading runs…
          </li>
        )}
        {!loading && runs.length === 0 && (
          <li className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
            No runs yet. Run now, or wait for the next scheduled occurrence.
          </li>
        )}
        {!loading &&
          runs.map((run) => {
            const detail = details[run.id];
            const active = isBriefActiveRunStage(run.stage);
            return (
              <li key={run.id} className="space-y-2 rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <BriefStageBadge stage={run.stage} />
                    <span className="text-xs text-muted-foreground">{run.trigger}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{run.occurrence_key}</span>
                    {run.coalesced_count > 0 && (
                      <span
                        className="text-xs text-warning"
                        title="Missed occurrences coalesced into this catch-up run"
                      >
                        coalesced {run.coalesced_count} missed occurrence{run.coalesced_count === 1 ? "" : "s"}
                        {run.missed_through_key ? ` through ${run.missed_through_key}` : ""}
                      </span>
                    )}
                    {run.cancel_requested && <span className="text-xs text-muted-foreground">cancelling…</span>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {active && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Cancel run"
                        aria-label={`Cancel run ${run.id.slice(0, 8)}`}
                        className="text-muted-foreground hover:text-destructive"
                        disabled={cancelBusyId === run.id}
                        onClick={() => void cancelRun(run)}
                      >
                        {cancelBusyId === run.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <XCircle className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={expandedId === run.id}
                      onClick={() => void toggleDetails(run.id)}
                    >
                      {expandedId === run.id ? (
                        <ChevronDown className="h-4 w-4" aria-hidden />
                      ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      )}
                      Details
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span>recipe rev {run.recipe_revision}</span>
                  <span>attempt {run.stage_attempts}</span>
                  <span>{new Date(run.created_at).toLocaleString()}</span>
                </div>
                {run.failure_reason && <p className="text-xs text-destructive">{run.failure_reason}</p>}
                {expandedId === run.id && (
                  <div className="space-y-2 border-t pt-2">
                    {run.operation_id && (
                      <p className="text-[11px] text-muted-foreground">
                        operation <span className="font-mono">{run.operation_id.slice(0, 8)}</span>
                      </p>
                    )}
                    {detail ? (
                      <>
                        <BriefPipeline
                          stage={detail.stage}
                          attempts={detail.stage_attempts}
                          cancelRequested={detail.cancel_requested}
                        />
                        {detail.refresh_receipts.length > 0 && (
                          <div>
                            <p className="text-[11px] font-medium text-muted-foreground">
                              Freshness ({detail.refresh_receipts.length} receipts)
                            </p>
                            <BriefFreshness receipts={detail.refresh_receipts} />
                          </div>
                        )}
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground">Comparison</p>
                          <BriefComparisonView summary={detail.comparison_summary} />
                        </div>
                        {detail.document_id && (
                          <a className="text-xs text-primary underline" href={`#/documents/${detail.document_id}`}>
                            Open report draft
                          </a>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">Loading bounded stage detail…</p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
      </ol>
      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            Load older runs
          </Button>
        </div>
      )}
    </div>
  );
}
