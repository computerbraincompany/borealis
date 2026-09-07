import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ExternalLink, FileText, Loader2, StopCircle, X } from "lucide-react";
import {
  formatApiError,
  researchApi,
  isTerminalResearchRunStatus,
  RESEARCH_NOTE_MAX_CHARS,
  type ResearchDefinition,
  type ResearchEvidence,
  type ResearchPlanStep,
  type ResearchRunDetail,
  type ResearchRunStatus,
  type ResearchReviewOp,
  type ResearchStep,
} from "@/lib/api";
import { mergeCatalogContinuation } from "@/lib/catalogMerge";
import { cn, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { locatorBadges, PassagePanel } from "@/components/LibrarySearchPanel";

function runStatusTone(status: ResearchRunStatus): "success" | "pending" | "destructive" | "secondary" {
  if (status === "completed") return "success";
  if (status === "needs_review") return "pending";
  if (status === "failed" || status === "cancelled") return "destructive";
  return "secondary";
}

export function runStatusLabel(status: ResearchRunStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "cancelling":
      return "Cancelling";
    case "needs_review":
      return "Needs review";
    case "completed":
      return "Computation finished";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function stepStatusLabel(status: ResearchStep["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "source_changed":
      return "Stopped: source changed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    default:
      return status;
  }
}

function stepStatusTone(status: ResearchStep["status"]): "success" | "pending" | "destructive" | "secondary" {
  if (status === "done") return "success";
  if (status === "running") return "pending";
  if (status === "failed" || status === "source_changed") return "destructive";
  return "secondary";
}

/**
 * Run progress and evidence dossier (M15 stage 4). Shows only server-defined
 * task summaries, counts, and states — never provider reasoning or raw
 * transport payloads. `needs_review` runs are labelled honestly as partial:
 * this surface never calls a needs_review run "complete". Evidence rows keep
 * their captured excerpt readable even when source navigation is gone; the
 * passage panel opens the real location with bounded neighbors. Claims cite
 * only evidence ids actually captured in this run — a reference that does not
 * resolve is never rendered as a citation.
 */
export function RunPanel({
  definition,
  run,
  reviewBusy,
  reviewConflict,
  reviewError,
  onReview,
  onReloadRun,
  onCancelRun,
  cancelBusy,
  artifactSlot,
}: {
  definition: ResearchDefinition;
  run: ResearchRunDetail;
  reviewBusy: boolean;
  reviewConflict: boolean;
  reviewError: string | null;
  onReview: (ops: ResearchReviewOp[]) => Promise<boolean>;
  onReloadRun: () => void;
  onCancelRun: () => void;
  cancelBusy: boolean;
  artifactSlot: React.ReactNode;
}) {
  const [evidence, setEvidence] = useState<ResearchEvidence[]>([]);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [openEvidence, setOpenEvidence] = useState<ResearchEvidence | null>(null);
  const [claimNotes, setClaimNotes] = useState<Record<string, string>>({});
  const [runNote, setRunNote] = useState("");
  const requestRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const loadEvidence = useCallback(
    async (cursor?: string | null) => {
      const requestId = ++requestRef.current;
      setEvidenceError(null);
      setEvidenceLoading(true);
      try {
        const page = await researchApi.listEvidence(run.id, cursor ? { cursor } : {});
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setEvidence((current) => (cursor ? mergeCatalogContinuation(current, page.items) : page.items));
        setEvidenceCursor(page.next_cursor);
      } catch (error: unknown) {
        if (mountedRef.current && requestId === requestRef.current) {
          setEvidenceError(formatApiError(error, "Could not load the evidence dossier"));
        }
      } finally {
        if (mountedRef.current && requestId === requestRef.current) setEvidenceLoading(false);
      }
    },
    [run.id],
  );

  const dataPhase = isTerminalResearchRunStatus(run.status) ? "final" : "live";
  useEffect(() => {
    requestRef.current += 1;
    setEvidence([]);
    setEvidenceCursor(null);
    setOpenEvidence(null);
    setClaimNotes({});
    setRunNote("");
    void loadEvidence(null);
    // The dossier target is the exact run id; a new run reloads everything,
    // and a run reaching a terminal status while mounted gained its final
    // evidence/claims, so reload once at that transition too.
  }, [run.id, loadEvidence, dataPhase]);

  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  const claims = run.claims.filter((claim) => claim.kind === "claim");
  const gaps = run.claims.filter((claim) => claim.kind === "gap");
  const terminal = isTerminalResearchRunStatus(run.status);

  const applyReview = async (ops: ResearchReviewOp[]) => {
    // The parent owns the CAS executor; success triggers a claims reload.
    return onReview(ops);
  };

  return (
    <div className="space-y-4">
      {/* status banner */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
        <span className="text-xs text-muted-foreground">
          model {run.chat_model} · {run.provider_locality} provider · started{" "}
          {run.started_at ? formatDate(run.started_at) : "—"}
          {run.rerun_of ? ` · rerun of ${run.rerun_of.slice(0, 8)}…` : ""}
        </span>
        {!terminal && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={cancelBusy || run.cancel_requested}
            onClick={onCancelRun}
          >
            {run.cancel_requested ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <StopCircle className="h-3.5 w-3.5" />
            )}
            {run.cancel_requested ? "Cancellation requested" : "Cancel run"}
          </Button>
        )}
      </div>

      {run.status === "needs_review" && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4" /> This run needs review — it is partial, not complete research
          </p>
          <p className="mt-1 text-xs">
            A budget, a changed source, or unresolved gaps stopped this run. The evidence, claims, and tables below are
            preserved partial work; review the gaps and conflicts before trusting or publishing anything.
          </p>
        </div>
      )}
      {run.status === "completed" && (
        <p className="text-xs text-muted-foreground">
          Computation finished and validated. Publication is still an explicit human step: create the reviewed draft
          below when you have accepted or rejected the claims.
        </p>
      )}
      {(run.status === "failed" || run.status === "cancelled") && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {run.error_reason || run.error_code || "The run ended without output."}{" "}
          <span className="text-xs">
            Partial captures remain readable; failed or cancelled runs cannot publish output.
          </span>
        </div>
      )}

      {/* steps: server-defined summaries, counts, and states only */}
      <section aria-label="Plan steps">
        <h3 className="text-sm font-semibold">Steps</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Searches {run.usage.searches}/{run.budgets.searches} · model requests {run.usage.model_requests}/
          {run.budgets.model_requests} · evidence {run.counts.evidence_count}/{run.budgets.evidence} ·{" "}
          {run.counts.evidence_char_count.toLocaleString()} captured characters
        </p>
        <ol className="mt-2 space-y-1.5">
          {run.steps.map((step) => (
            <li key={step.ordinal} className="rounded-md border px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">
                  {step.ordinal}. {step.objective}
                </span>
                <Badge className="ml-auto shrink-0" variant={stepStatusTone(step.status)}>
                  {stepStatusLabel(step.status)}
                </Badge>
                {step.attempts > 1 && <span className="text-xs text-muted-foreground">attempt {step.attempts}</span>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {step.questions.length} search question{step.questions.length === 1 ? "" : "s"}
                {step.outcome ? ` — ${step.outcome}` : ""}
              </p>
            </li>
          ))}
          {run.steps.length === 0 && <li className="text-xs text-muted-foreground">No steps recorded.</li>}
        </ol>
      </section>

      {artifactSlot}

      {/* evidence dossier */}
      <section aria-label="Evidence dossier" className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Evidence <span className="text-xs font-normal text-muted-foreground">({evidence.length} loaded)</span>
          </h3>
          {evidenceCursor && (
            <Button
              variant="outline"
              size="sm"
              disabled={evidenceLoading}
              onClick={() => void loadEvidence(evidenceCursor)}
            >
              {evidenceLoading ? "Loading…" : "Load more evidence"}
            </Button>
          )}
        </div>
        {evidenceError && (
          <p className="text-xs text-destructive" role="alert">
            {evidenceError}
          </p>
        )}
        {openEvidence && (
          <PassagePanel
            sourceId={openEvidence.source_id}
            chunkId={openEvidence.chunk_id}
            label={openEvidence.label}
            query={openEvidence.query}
            onClose={() => setOpenEvidence(null)}
          />
        )}
        <ul className="space-y-2">
          {evidence.map((entry) => (
            <li key={entry.id} className={cn("rounded-md border px-3 py-2", entry.irrelevant && "opacity-60")}>
              <div className="flex items-center gap-2 text-sm">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                  onClick={() => setOpenEvidence(entry)}
                  aria-label={`Open captured passage in ${entry.label}`}
                >
                  <FileText className="mr-1 inline h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  {entry.label}
                </button>
                {entry.irrelevant && <Badge variant="destructive">flagged irrelevant</Badge>}
                <span className="shrink-0 text-xs text-muted-foreground">
                  generation {entry.generation} · step {entry.step_ordinal}
                </span>
              </div>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">{entry.excerpt}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {locatorBadges(entry.locators)}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={reviewBusy}
                  onClick={() =>
                    void applyReview([{ op: "flag_evidence", evidence_id: entry.id, irrelevant: !entry.irrelevant }])
                  }
                >
                  {entry.irrelevant ? "Mark relevant" : "Mark irrelevant"}
                </Button>
                <span>retrieved {formatDate(entry.retrieved_at)}</span>
              </div>
            </li>
          ))}
          {!evidenceLoading && evidence.length === 0 && !evidenceError && (
            <li className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              No evidence was captured in this run.
            </li>
          )}
        </ul>
      </section>

      {/* claims + gaps */}
      <section aria-label="Supported conclusions" className="space-y-2">
        <h3 className="text-sm font-semibold">Claims</h3>
        {reviewConflict && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
            role="alert"
          >
            <span>The review revision moved since this page loaded; your change was not applied.</span>
            <Button variant="outline" size="sm" onClick={onReloadRun}>
              Reload current review state
            </Button>
          </div>
        )}
        {reviewError && (
          <p className="text-xs text-destructive" role="alert">
            {reviewError}
          </p>
        )}
        <ul className="space-y-2">
          {claims.map((claim) => (
            <li key={claim.id} className="rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    claim.classification === "supported"
                      ? "success"
                      : claim.classification === "conflicting"
                        ? "pending"
                        : "destructive"
                  }
                >
                  {claim.classification}
                </Badge>
                <Badge variant="outline">{claim.review_state}</Badge>
                {claim.evidence_refs.map((ref) => {
                  const resolved = evidenceById.get(ref);
                  // References that do not resolve to this run's captured
                  // evidence are never rendered as citations.
                  if (!resolved) return null;
                  return (
                    <button
                      key={ref}
                      type="button"
                      className="text-xs text-primary underline underline-offset-2"
                      onClick={() => setOpenEvidence(resolved)}
                    >
                      evidence in {resolved.label}
                    </button>
                  );
                })}
                <span className="ml-auto text-[11px] text-muted-foreground">
                  review rev {run.review_revision} · updated {formatDate(claim.updated_at)}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm">{claim.text}</p>
              {claim.corrected_text && (
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  <span className="text-xs font-semibold uppercase tracking-wide">user revision</span> —{" "}
                  {claim.corrected_text}
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reviewBusy || claim.review_state === "accepted"}
                  onClick={() => void applyReview([{ op: "accept_claim", claim_id: claim.id }])}
                >
                  <Check className="h-3.5 w-3.5" /> Accept
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reviewBusy || claim.review_state === "rejected"}
                  onClick={() => void applyReview([{ op: "reject_claim", claim_id: claim.id }])}
                >
                  <X className="h-3.5 w-3.5" /> Reject
                </Button>
              </div>
              <div className="mt-1.5 flex items-end gap-2">
                <Textarea
                  aria-label={`Note for claim ${claim.id.slice(0, 8)}`}
                  className="min-h-8 text-sm"
                  maxLength={RESEARCH_NOTE_MAX_CHARS}
                  placeholder="Reviewer note (never becomes source evidence)"
                  defaultValue={claim.user_note ?? ""}
                  disabled={reviewBusy}
                  onChange={(event) => setClaimNotes((current) => ({ ...current, [claim.id]: event.target.value }))}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={reviewBusy || claimNotes[claim.id] === undefined || !claimNotes[claim.id].trim()}
                  onClick={() =>
                    void applyReview([
                      { op: "add_note", target_kind: "claim", target_id: claim.id, note: claimNotes[claim.id].trim() },
                    ])
                  }
                >
                  Save note
                </Button>
              </div>
            </li>
          ))}
          {claims.length === 0 && (
            <li className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              This run recorded no claims yet.
            </li>
          )}
        </ul>
      </section>

      <section aria-label="Gaps and conflicts" className="space-y-2">
        <h3 className="text-sm font-semibold">Gaps and conflicts</h3>
        <p className="text-xs text-muted-foreground">
          Missing facts are reported as “not found in selected evidence”, never as proof that a fact does not exist.
        </p>
        <ul className="space-y-1.5">
          {gaps.map((gap) => (
            <li key={gap.id} className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
              <span className="mr-2 text-xs font-semibold text-warning">gap</span>
              {gap.text}
            </li>
          ))}
          {gaps.length === 0 && <li className="text-xs text-muted-foreground">No explicit gaps recorded.</li>}
        </ul>
        {run.run_notes.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {run.run_notes.map((note, index) => (
              <li key={index} className="rounded border bg-muted/30 px-2 py-1">
                note: {note}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            aria-label="Run note"
            className="min-h-8 text-sm"
            maxLength={RESEARCH_NOTE_MAX_CHARS}
            placeholder="Run-level review note"
            value={runNote}
            disabled={reviewBusy}
            onChange={(event) => setRunNote(event.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={reviewBusy || !runNote.trim()}
            onClick={() =>
              void applyReview([{ op: "add_note", target_kind: "run", note: runNote.trim() }]).then((ok) => {
                if (ok) setRunNote("");
              })
            }
          >
            Save run note
          </Button>
        </div>
      </section>

      {/* plan provenance */}
      {definition.plan.steps.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Plan steps this run was pinned to</summary>
          <ol className="mt-1 list-inside list-decimal space-y-0.5">
            {definition.plan.steps.map((step: ResearchPlanStep) => (
              <li key={step.id}>{step.objective}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/**
 * Reviewed-artifact card: finished runs only. Failed or cancelled runs are
 * refused by the server (no committed child turn to publish through) and the
 * button says so instead of silently disabling.
 */
export function ArtifactCard({
  run,
  busy,
  error,
  result,
  onCreate,
}: {
  run: ResearchRunDetail;
  busy: boolean;
  error: string | null;
  result: {
    document_id: string;
    document_revision: number;
    labels: string[];
    omitted: { rows: number; claims: number; evidence: number };
  } | null;
  onCreate: () => void;
}) {
  const publishable = run.status === "completed" || run.status === "needs_review";
  return (
    <section aria-label="Reviewed artifact" className="rounded-md border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Create reviewed draft</h3>
        <Button
          type="button"
          size="sm"
          disabled={busy || !publishable}
          title={publishable ? undefined : "Only finished (completed or needs_review) runs can create reviewed drafts"}
          onClick={onCreate}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
          Create reviewed draft
        </Button>
        {!publishable && (
          <span className="text-xs text-muted-foreground">
            A failed or cancelled run cannot publish output through this action.
          </span>
        )}
      </div>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs">
          <p className="flex items-center gap-2 font-medium">
            <Check className="h-3.5 w-3.5 text-success" /> M13 draft created — revision {result.document_revision}
          </p>
          <p className="mt-1 text-muted-foreground">
            Document <code>{result.document_id.slice(0, 8)}…</code> (head revision {result.document_revision}) ·{" "}
            {result.labels.join(", ") || "no projection labels"}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            Omitted from the projection: {result.omitted.rows} rows, {result.omitted.claims} claims,{" "}
            {result.omitted.evidence} evidence entries — the full bounded dossier remains in this run and its exports.
          </p>
          <Button variant="outline" size="sm" className="mt-1.5" asChild>
            <a href={`#/documents/${result.document_id}`}>
              <ExternalLink className="h-3.5 w-3.5" /> Open in document workbench
            </a>
          </Button>
        </div>
      )}
    </section>
  );
}
