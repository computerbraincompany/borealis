import { useId } from "react";
import { ChevronRight, Download, Table2 } from "lucide-react";
import type { QueryResultArtifact, QueryResultCell } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { Button } from "@/components/ui/button";

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
    <section className="overflow-hidden rounded-xl border bg-card text-sm" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-surface-subtle text-aurora-teal">
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
