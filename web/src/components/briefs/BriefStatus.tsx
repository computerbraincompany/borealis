import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  BRIEF_PIPELINE_STAGES,
  type BriefComparisonPayload,
  type BriefRefreshReceipt,
  type BriefRunStage,
} from "@/lib/api";

/**
 * Shared, honest rendering of reviewed-brief run state: the bounded stage
 * pipeline, the persisted comparison summary with its completeness flags, and
 * the server-owned freshness receipts. Everything here is display-only — the
 * server owns the stage machine, comparison, and receipts.
 */

const STAGE_STYLING: Record<
  BriefRunStage,
  { label: string; variant: "default" | "secondary" | "pending" | "success" | "destructive" | "outline" }
> = {
  queued: { label: "queued", variant: "secondary" },
  refreshing: { label: "refreshing inputs", variant: "pending" },
  waiting_ready: { label: "waiting for ready inputs", variant: "pending" },
  analyzing: { label: "analyzing", variant: "pending" },
  drafting: { label: "drafting report", variant: "pending" },
  awaiting_review: { label: "awaiting review", variant: "default" },
  publishing: { label: "publishing", variant: "pending" },
  approved: { label: "approved", variant: "success" },
  rejected: { label: "rejected", variant: "outline" },
  failed: { label: "failed", variant: "destructive" },
  cancelled: { label: "cancelled", variant: "outline" },
  skipped: { label: "skipped", variant: "pending" },
};

export function BriefStageBadge({ stage }: { stage: BriefRunStage }) {
  const styling = STAGE_STYLING[stage];
  return <Badge variant={styling.variant}>{styling.label}</Badge>;
}

const PIPELINE_DONE_STAGES: readonly BriefRunStage[] = ["awaiting_review", "publishing", "approved", "rejected"];

/**
 * Bounded stage pipeline: the seven progress stages in order with the current
 * position highlighted. Terminal outcomes (failed/cancelled/skipped) keep the
 * pipeline dimmed and badge the outcome honestly — never a green completion.
 */
export function BriefPipeline({
  stage,
  attempts,
  cancelRequested,
}: {
  stage: BriefRunStage;
  attempts: number;
  cancelRequested: boolean;
}) {
  const terminal = stage === "failed" || stage === "cancelled" || stage === "skipped";
  const currentIndex = BRIEF_PIPELINE_STAGES.indexOf(stage === "publishing" ? "awaiting_review" : stage);
  const allDone = PIPELINE_DONE_STAGES.includes(stage) || stage === "publishing";
  return (
    <div className={cn("flex flex-wrap items-center gap-1 text-[11px]", terminal && "opacity-60")}>
      <ol className="flex flex-wrap items-center gap-1" aria-label={`Run pipeline, current stage: ${stage}`}>
        {BRIEF_PIPELINE_STAGES.map((step, index) => {
          const reached = allDone || (!terminal && currentIndex >= 0 && index <= currentIndex);
          const isCurrent = !terminal && stage === step;
          return (
            <li key={step} className="flex items-center gap-1">
              <span
                className={cn(
                  "rounded-md border px-1.5 py-0.5",
                  isCurrent
                    ? "border-primary bg-primary/10 font-semibold text-primary"
                    : reached
                      ? "border-primary/30 bg-primary/5 text-foreground"
                      : "border-dashed text-muted-foreground",
                )}
              >
                {step.replaceAll("_", " ")}
              </span>
              {index < BRIEF_PIPELINE_STAGES.length - 1 && (
                <span aria-hidden className="text-muted-foreground/50">
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {stage === "publishing" && (
        <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-semibold text-warning">
          publishing
        </span>
      )}
      {terminal && <BriefStageBadge stage={stage} />}
      {attempts > 1 && <span className="text-muted-foreground">attempt {attempts}</span>}
      {cancelRequested && <span className="text-muted-foreground">cancellation requested</span>}
    </div>
  );
}

const UNAVAILABLE_LABELS: Record<
  NonNullable<Extract<BriefComparisonPayload, { kind: "unavailable" }>["reason"]>,
  { badge: string; detail: string; tone: "pending" | "destructive" }
> = {
  "baseline-missing": {
    badge: "first run / new series",
    detail: "No earlier successful run in this comparison series — there is nothing to compare yet.",
    tone: "pending",
  },
  "baseline-result-deleted": {
    badge: "no comparison",
    detail: "The baseline result was deleted; this run cannot be compared against it.",
    tone: "destructive",
  },
  "current-result-deleted": {
    badge: "no comparison",
    detail: "This run's stored result is unavailable; no comparison can be shown.",
    tone: "destructive",
  },
};

/**
 * The persisted comparison with explicit completeness flags. Unsupported or
 * truncated comparisons are labeled — never presented as a proven no-change.
 */
export function BriefComparisonView({ summary }: { summary: BriefComparisonPayload }) {
  if (summary === null) {
    return <p className="text-xs text-muted-foreground">No comparison committed for this run yet.</p>;
  }
  if (summary.kind === "unavailable") {
    const label = UNAVAILABLE_LABELS[summary.reason] ?? UNAVAILABLE_LABELS["baseline-missing"];
    return (
      <div className="space-y-1 text-xs">
        <Badge variant={label.tone === "pending" ? "pending" : "destructive"}>{label.badge}</Badge>
        <p className="text-muted-foreground">{label.detail}</p>
      </div>
    );
  }
  const totals = [
    `added ${summary.added_total ?? "—"}`,
    `removed ${summary.removed_total ?? "—"}`,
    `changed ${summary.changed_total ?? "—"}`,
  ].join(" · ");
  return (
    <div className="space-y-1 text-xs">
      <p className="text-foreground">
        {summary.mode === "keyed"
          ? `Keyed comparison${summary.key_columns.length ? ` on ${summary.key_columns.join(", ")}` : ""}: ${totals}`
          : "Side-by-side (unkeyed) — change totals are not claimed."}
      </p>
      <div className="flex flex-wrap gap-1">
        <Badge variant={summary.exhaustive ? "secondary" : "pending"}>
          {summary.exhaustive ? "exhaustive" : "partial (not exhaustive)"}
        </Badge>
        {summary.truncated && <Badge variant="pending">truncated totals</Badge>}
        {summary.mode !== "keyed" && <Badge variant="pending">unkeyed mode</Badge>}
        {summary.reason_code && <Badge variant="outline">{summary.reason_code}</Badge>}
      </div>
      {summary.reason_detail && <p className="text-muted-foreground">{summary.reason_detail}</p>}
      {summary.changed_sample.length > 0 && (
        <ul className="space-y-0.5 text-muted-foreground" aria-label="Changed rows sample">
          {summary.changed_sample.map((change, index) => (
            <li key={index}>
              <span className="font-mono">{change.key.map((part) => String(part)).join(" · ")}</span>{" "}
              {change.changes
                .map(
                  (cell) =>
                    `${cell.column} ${cell.delta === null ? "Δ—" : `${cell.delta >= 0 ? "+" : ""}${cell.delta}`}`,
                )
                .join(", ")}
            </li>
          ))}
        </ul>
      )}
      {summary.mode === "keyed" && summary.exhaustive && !summary.truncated && summary.changed_total === 0 && (
        <p className="text-muted-foreground">Deterministically unchanged from the baseline.</p>
      )}
    </div>
  );
}

/** Server-committed refresh receipts — the durable freshness labels. */
export function BriefFreshness({ receipts }: { receipts: readonly BriefRefreshReceipt[] }) {
  if (receipts.length === 0) {
    return <p className="text-xs text-muted-foreground">No refresh receipts committed yet.</p>;
  }
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground" aria-label="Input freshness receipts">
      {receipts.map((receipt) => (
        <li key={receipt.source_id}>
          <span className="text-foreground">{receipt.label}</span> · {receipt.kind} · {receipt.outcome} · gen{" "}
          {receipt.generation}
        </li>
      ))}
    </ul>
  );
}

export function BriefFailedPublication({ code }: { code: string }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <Badge variant="destructive">failed publication ({code})</Badge>
      <p className="mt-1">
        Nothing was published. Re-review the current draft revision and approve again to retry the same publication
        operation — a retry never creates a second one.
      </p>
    </div>
  );
}
