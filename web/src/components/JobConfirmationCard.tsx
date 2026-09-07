import { CheckCircle2, ClipboardList, LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sourceStatusPresentation } from "@/lib/sourceStatus";
import type { ChatJobProjection } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Chat-creation-from-job confirmation (Connected agents stage 5).
 *
 * A job-created chat is created `selected` with NO attached sources. This card
 * is the explicit confirmation gate before the first message: it shows the
 * server-expanded ready-source list (from the suggested libraries), the
 * starter prompts as composer suggestions, and the output template note.
 * Confirming applies the exact expanded list; starting without them keeps the
 * chat selected-empty. Neither path ever widens the scope to `all`.
 */

export type JobConfirmState = "pending" | "confirming" | "confirmed" | "dismissed";

interface JobSourceRow {
  id: string;
  name: string;
  status: string;
}

export function JobConfirmationCard({
  agentName,
  job,
  state,
  sources,
  error,
  busy,
  onConfirm,
  onDismiss,
  onUsePrompt,
}: {
  agentName: string;
  job: ChatJobProjection;
  state: JobConfirmState;
  /** Catalog rows for the suggested source ids (best-effort lookup). */
  sources: JobSourceRow[];
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  onUsePrompt: (prompt: string) => void;
}) {
  if (state === "dismissed") return null;
  const confirmed = state === "confirmed";
  return (
    <div
      className="mb-3 rounded-xl border bg-card p-4 shadow-sm"
      aria-labelledby="job-confirmation-heading"
      role="region"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="job-confirmation-heading" className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 text-primary" aria-hidden="true" />
            Job “{agentName}” — confirm sources before the first message
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            This chat currently has no attached sources. The job suggested{" "}
            {job.suggested_library_ids.length > 0
              ? `${job.suggested_library_ids.length} librar${job.suggested_library_ids.length === 1 ? "y" : "ies"}`
              : "no libraries"}
            {job.suggested_source_ids.length > 0
              ? `, which expand to ${job.suggested_source_ids.length} ready source${job.suggested_source_ids.length === 1 ? "" : "s"}`
              : " and therefore no sources"}
            . Nothing is attached and nothing is sent until you confirm.
          </p>
        </div>
        {confirmed && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> Sources confirmed
          </span>
        )}
      </div>

      {job.suggested_source_ids.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          This job suggests no attached sources. You can attach sources yourself, start the chat without any, or switch
          to another agent first.
        </p>
      ) : (
        <ul className="mt-3 max-h-44 space-y-1 overflow-y-auto rounded-lg border p-2" aria-label="Suggested sources">
          {job.suggested_source_ids.map((id) => {
            const row = sources.find((candidate) => candidate.id === id);
            const presentation = sourceStatusPresentation(row?.status ?? "missing");
            return (
              <li key={id} className="flex items-center justify-between gap-2 px-1 text-sm">
                <span className="min-w-0 break-words">{row?.name ?? "Source no longer available"}</span>
                {row && (
                  <span
                    className={cn(
                      "shrink-0 text-xs",
                      presentation.tone === "success"
                        ? "text-success"
                        : presentation.tone === "pending"
                          ? "text-warning"
                          : "text-destructive",
                    )}
                  >
                    {presentation.label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {job.output_template && (
        <p className="mt-3 rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Output template:</span>{" "}
          <span className="line-clamp-3 whitespace-pre-wrap break-words">
            {job.output_template.kind === "instruction"
              ? job.output_template.instruction
              : "Uses the document template selected in this agent’s Job tab. Its structure is captured when you send a message."}
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {job.starter_prompts.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted-foreground">Starter prompts — click to use</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {job.starter_prompts.map((prompt, index) => (
              <button
                key={index}
                type="button"
                disabled={busy}
                onClick={() => onUsePrompt(prompt)}
                className="group inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3 shrink-0 text-primary" />
                <span className="truncate">{prompt}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!confirmed && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || job.suggested_source_ids.length === 0}
            onClick={onConfirm}
            title={
              job.suggested_source_ids.length === 0
                ? "This job suggests no sources; start without them or attach sources manually"
                : "Attach the expanded ready-source list"
            }
          >
            {state === "confirming" && <LoaderCircle className="h-4 w-4 animate-spin" />}
            {state === "confirming"
              ? "Confirming…"
              : `Attach ${job.suggested_source_ids.length} suggested source${job.suggested_source_ids.length === 1 ? "" : "s"}`}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
            Start without these sources
          </Button>
        </div>
      )}
    </div>
  );
}
