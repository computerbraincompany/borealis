import { useEffect, useId, useRef, useState } from "react";
import { BookMarked, ChevronRight, Download, PencilLine, Table2 } from "lucide-react";
import { analysesApi, formatApiError, type QueryResultArtifact, type QueryResultCell } from "@/lib/api";
import { stashPromotionSql } from "@/lib/analysisPromotion";
import { downloadCsv } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Promotion affordance keyed strictly off `capture_id`/`can_save_analysis`
 * (M12). A verified capture promotes server-side from the durable full-query
 * capture; a legacy receipt never replays its sliced SQL and instead hands a
 * draft to the Analyses editor, which requires the complete statement.
 */
function AnalysisPromotion({ artifact }: { artifact: QueryResultArtifact }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  const closeDialog = () => {
    if (saving) return; // busy-dialog rule: never hide the failure slot
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setDialogError(null);
    setDialogOpen(false);
  };

  const save = async () => {
    const name = title.trim();
    if (!name || !artifact.capture_id || saving) return;
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setSaving(true);
    setDialogError(null);
    try {
      await analysesApi.fromQuery(artifact.capture_id, name, abort.signal);
      if (!mountedRef.current || requestRef.current !== requestId || abort.signal.aborted) return;
      setSaved(true);
      setDialogOpen(false);
    } catch (failure: unknown) {
      if (mountedRef.current && requestRef.current === requestId && !abort.signal.aborted) {
        setDialogError(formatApiError(failure, "Could not save this query as an analysis"));
      }
    } finally {
      if (mountedRef.current && requestRef.current === requestId) setSaving(false);
    }
  };

  const promoteInEditor = () => {
    // Explicit editor path for receipts without a verified capture: the
    // sliced SQL is a draft only; the editor requires the complete statement.
    stashPromotionSql(artifact.sql);
    window.location.hash = "/analyses?promote=1";
  };

  if (artifact.can_save_analysis && artifact.capture_id) {
    if (saved) {
      return (
        <a
          href="#/analyses"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-primary/25 bg-primary/5 px-2 py-1 text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BookMarked className="h-3 w-3" aria-hidden="true" />
          Saved — open in Analyses
        </a>
      );
    }
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => {
            setTitle("");
            setDialogError(null);
            setDialogOpen(true);
          }}
          aria-label="Save query as analysis"
        >
          <BookMarked aria-hidden="true" />
          Save as analysis
        </Button>
        <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
          <DialogContent className="max-w-md" aria-busy={saving}>
            <DialogHeader>
              <DialogTitle>Save query as analysis</DialogTitle>
              <DialogDescription>
                The saved analysis runs the complete captured SQL against the query's exact sources — outside chat, with
                typed parameters.
              </DialogDescription>
            </DialogHeader>
            {dialogError && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {dialogError}
              </p>
            )}
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                placeholder="Analysis title"
                aria-label="Analysis title"
                autoFocus
              />
              <DialogFooter>
                <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={closeDialog}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={saving || !title.trim()}>
                  {saving ? "Saving…" : "Save analysis"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={promoteInEditor}
      title="This receipt has no verified full-query capture; the editor requires the complete SQL"
      aria-label="Save as analysis (requires complete SQL)"
    >
      <PencilLine aria-hidden="true" />
      Save as analysis
    </Button>
  );
}

function CellValue({ value }: { value: QueryResultCell }) {
  if (value === null) {
    return (
      <span
        className="inline-flex rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        aria-label="Null value"
      >
        null
      </span>
    );
  }

  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

export function DataResultCard({ artifact, index }: { artifact: QueryResultArtifact; index: number }) {
  const headingId = useId();
  const resultNumber = index + 1;

  return (
    <section className="overflow-hidden rounded-lg border bg-card text-sm" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-surface-subtle text-primary">
          <Table2 className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="font-semibold text-foreground">
            Query result {resultNumber}
          </h3>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {artifact.row_count.toLocaleString()} returned · {artifact.rows.length.toLocaleString()} stored
          </p>
        </div>
        {artifact.truncated && (
          <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
            Preview truncated
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => downloadCsv(artifact.columns, artifact.rows, `borealis-query-${resultNumber}.csv`)}
          aria-label={`Download query result ${resultNumber} as CSV`}
        >
          <Download aria-hidden="true" />
          Download CSV
        </Button>
        <AnalysisPromotion artifact={artifact} />
      </div>

      <div
        className="max-h-80 overflow-auto border-y"
        tabIndex={0}
        aria-label={`Scrollable table for query result ${resultNumber}`}
      >
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <caption className="sr-only">
            Stored rows for query result {resultNumber}. {artifact.row_count} rows returned and {artifact.rows.length}{" "}
            rows stored.
          </caption>
          <thead>
            <tr>
              {artifact.columns.map((column, columnIndex) => (
                <th
                  key={`${column}-${columnIndex}`}
                  scope="col"
                  className="sticky top-0 z-10 whitespace-nowrap border-b border-r bg-muted px-3 py-2 font-mono text-[11px] font-semibold text-foreground last:border-r-0"
                >
                  {column || <span className="italic text-muted-foreground">Unnamed column</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {artifact.rows.length === 0 ? (
              <tr>
                <td colSpan={artifact.columns.length} className="px-3 py-5 text-center text-xs text-muted-foreground">
                  The query returned no rows.
                </td>
              </tr>
            ) : (
              artifact.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="even:bg-surface-subtle/70">
                  {row.map((value, columnIndex) => (
                    <td
                      key={columnIndex}
                      className="max-w-80 border-b border-r px-3 py-2 align-top text-foreground/85 last:border-r-0"
                    >
                      <CellValue value={value} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <details className="group/sql">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 transition-transform group-open/sql:rotate-90"
            aria-hidden="true"
          />
          SQL
        </summary>
        <pre className="max-h-48 overflow-auto border-t bg-surface-subtle px-3 py-2.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
          {artifact.sql}
        </pre>
      </details>
    </section>
  );
}
