import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, GitCompareArrows, Loader2, RefreshCw } from "lucide-react";
import {
  downloadBlob,
  formatApiError,
  isTerminalResearchRunStatus,
  researchApi,
  RESEARCH_CELL_EXPLANATION_MAX_CHARS,
  type ResearchCellStatus,
  type ResearchColumnDeclaration,
  type ResearchEvidence,
  type ResearchRunDetail,
  type ResearchRunSummary,
  type ResearchReviewOp,
  type ResearchTableRow,
  type ResearchTableView,
  type ResearchTypedValue,
} from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PassagePanel } from "@/components/LibrarySearchPanel";

const CELL_STATUSES: readonly ResearchCellStatus[] = ["supported", "conflicting", "not_found", "invalid"];

function cellStatusTone(status: ResearchCellStatus): "success" | "pending" | "secondary" | "destructive" {
  if (status === "supported") return "success";
  if (status === "conflicting") return "pending";
  if (status === "invalid") return "destructive";
  return "secondary";
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Typed display text — never a string-coerced claim about the value. */
export function cellDisplayValue(column: ResearchColumnDeclaration, value: ResearchTypedValue): string {
  if (value === null) return "—";
  switch (column.type) {
    case "number":
      return typeof value === "number" ? `${value}${column.unit ? ` ${column.unit}` : ""}` : String(value);
    case "boolean":
      return typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
    default:
      return `${String(value)}${column.type === "enum" && column.unit ? ` ${column.unit}` : ""}`;
  }
}

/** Parse the correction editor input against the column type without coercion. */
function parseCorrectionValue(
  column: ResearchColumnDeclaration,
  raw: string,
): { ok: true; value: ResearchTypedValue } | { ok: false; message: string } {
  if (column.type === "boolean") {
    if (raw === "true") return { ok: true, value: true };
    if (raw === "false") return { ok: true, value: false };
    return { ok: false, message: "Choose true or false." };
  }
  if (column.type === "number") {
    const numeric = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(numeric)) return { ok: false, message: "Enter a finite number." };
    return { ok: true, value: numeric };
  }
  if (column.type === "date") {
    if (!isIsoCalendarDate(raw.trim())) return { ok: false, message: "Enter a real ISO calendar date (YYYY-MM-DD)." };
    return { ok: true, value: raw.trim() };
  }
  if (column.type === "enum") {
    if (!(column.choices ?? []).includes(raw)) return { ok: false, message: "Pick one of the allowed choices." };
    return { ok: true, value: raw };
  }
  return { ok: true, value: raw };
}

/**
 * Typed comparison table review surface (M15 stage 4): typed cells with status
 * badges, evidence-on-click for refs actually captured in this run,
 * labeled correction overlays with provenance (machine originals always
 * shown), page-local sort/filter disclosed by the server `view_state`, the
 * revision diff (`against`), rerun of selected columns/rows with carried-
 * overrides disclosure, and CSV/manifest exports via authenticated blob
 * downloads. Corrections are review content stored as overlays — the machine
 * extraction is never mutated.
 */
export function TablePanel({
  title,
  run,
  runHistory,
  sourceLabels,
  reviewBusy,
  rerunBusy,
  onReview,
  onRerun,
}: {
  title: string;
  run: ResearchRunDetail;
  runHistory: ResearchRunSummary[];
  sourceLabels: Map<string, string>;
  reviewBusy: boolean;
  rerunBusy: boolean;
  onReview: (ops: ResearchReviewOp[]) => Promise<boolean>;
  onRerun: (selection: { row_source_ids: string[]; column_ids: string[] }) => Promise<void>;
}) {
  const [table, setTable] = useState<ResearchTableView | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [items, setItems] = useState<ResearchTableRow[]>([]);
  const [sortColumn, setSortColumn] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [sortView, setSortView] = useState<"effective" | "machine" | "correction">("effective");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterText, setFilterText] = useState("");
  const [filterColumn, setFilterColumn] = useState("");
  const [against, setAgainst] = useState("");
  const [evidenceById, setEvidenceById] = useState<Map<string, ResearchEvidence>>(new Map());
  const [openEvidence, setOpenEvidence] = useState<ResearchEvidence | null>(null);
  const [editing, setEditing] = useState<{ row: string; column: ResearchColumnDeclaration } | null>(null);
  const [selectedRows, setSelectedRows] = useState<Record<string, boolean>>({});
  const [selectedColumns, setSelectedColumns] = useState<Record<string, boolean>>({});
  const requestRef = useRef(0);
  const evidenceRequestRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      evidenceRequestRef.current += 1;
    };
  }, []);

  const fetchTable = useCallback(
    async (cursor?: string | null) => {
      const requestId = ++requestRef.current;
      const abort = new AbortController();
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setTableError(null);
      try {
        const view = await researchApi.getTable(run.id, {
          cursor: cursor ?? null,
          sortColumn: sortColumn || null,
          sortDir,
          sortView,
          filterColumn: filterColumn || null,
          filterStatus: (filterStatus || null) as ResearchCellStatus | null,
          filterText: filterText.trim() || null,
          against: against || null,
          signal: abort.signal,
        });
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setTable(view);
        setItems((current) => (cursor ? [...current, ...view.items] : view.items));
        setNextCursor(view.next_cursor);
      } catch (error: unknown) {
        if (mountedRef.current && requestId === requestRef.current) {
          setTableError(formatApiError(error, "Could not load the comparison table"));
        }
      } finally {
        if (mountedRef.current && requestId === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [run.id, sortColumn, sortDir, sortView, filterColumn, filterStatus, filterText, against],
  );

  // Applied corrections refetch the stored page without widening deps.
  const [reloadKey, setReloadKey] = useState(0);
  // A run completed while this view is mounted materialized its table cells;
  // refetch once when the run reaches a terminal status (the parent's
  // exact-ID poll updates run.status in place, so run.id alone never rekeys).
  const dataPhase = isTerminalResearchRunStatus(run.status) ? "final" : "live";
  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    void fetchTable(null);
  }, [fetchTable, reloadKey, dataPhase]);

  // Resolve cell evidence refs: load the run's captured evidence pages so a
  // cell click always opens a real captured entry (unresolved refs render no
  // citation at all). Its own request generation keeps the table page fetch
  // and the evidence sweep from invalidating each other.
  useEffect(() => {
    evidenceRequestRef.current += 1;
    const requestId = evidenceRequestRef.current;
    const abort = new AbortController();
    void (async () => {
      const map = new Map<string, ResearchEvidence>();
      let cursor: string | null = null;
      for (;;) {
        const page = await researchApi.listEvidence(run.id, {
          ...(cursor ? { cursor } : {}),
          limit: 50,
          signal: abort.signal,
        });
        for (const entry of page.items) map.set(entry.id, entry);
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      if (mountedRef.current && requestId === evidenceRequestRef.current) setEvidenceById(map);
    })().catch((error: unknown) => {
      if (mountedRef.current && requestId === evidenceRequestRef.current && !abort.signal.aborted) {
        setEvidenceById(new Map());
        setTableError(formatApiError(error, "Could not load run evidence"));
      }
    });
    return () => {
      evidenceRequestRef.current += 1;
      abort.abort();
    };
  }, [run.id]);

  const rowLabel = (rowSourceId: string): string =>
    sourceLabels.get(rowSourceId) ?? rowHistoryLabel(rowSourceId) ?? `Source ${rowSourceId.slice(0, 8)}…`;

  function rowHistoryLabel(rowSourceId: string): string | null {
    const pinned = run.sources.find((source) => source.source_id === rowSourceId);
    return pinned ? `Row ${rowSourceId.slice(0, 8)}…` : null;
  }

  const columns = table?.columns ?? [];
  const comparison = table?.comparison;

  return (
    <div className="space-y-3" aria-label="Comparison table">
      {/* view options */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          aria-label="Sort column"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={sortColumn}
          onChange={(event) => setSortColumn(event.target.value)}
        >
          <option value="">Sort: none</option>
          {columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort direction"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={sortDir}
          disabled={!sortColumn}
          onChange={(event) => setSortDir(event.target.value as "asc" | "desc")}
        >
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
        <select
          aria-label="Sort value basis"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={sortView}
          disabled={!sortColumn}
          onChange={(event) => setSortView(event.target.value as "effective" | "machine" | "correction")}
        >
          <option value="effective">effective</option>
          <option value="machine">machine</option>
          <option value="correction">correction</option>
        </select>
        <select
          aria-label="Filter column"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={filterColumn}
          onChange={(event) => setFilterColumn(event.target.value)}
        >
          <option value="">Filter: any column</option>
          {columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter status"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={filterStatus}
          onChange={(event) => setFilterStatus(event.target.value)}
        >
          <option value="">Any status</option>
          {CELL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <Input
          aria-label="Filter text"
          className="h-8 w-36 text-xs"
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder="contains…"
          maxLength={200}
        />
        <select
          aria-label="Compare against run revision"
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={against}
          onChange={(event) => setAgainst(event.target.value)}
        >
          <option value="">Diff: off</option>
          {runHistory
            .filter((entry) => entry.id !== run.id)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                against {formatDate(entry.created_at)} ({entry.status})
              </option>
            ))}
        </select>
        <Button variant="outline" size="sm" onClick={() => void fetchTable(null)} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Reload page
        </Button>
      </div>

      {(table?.view_state.sort_applied || table?.view_state.filter_applied) && (
        <p className="text-xs text-warning" role="status">
          Sort/filter is page-local: it applies to this loaded keyset page only, and paging continues over the row-id
          keyset basis.
        </p>
      )}
      {table?.limit_state.at_limit && (
        <p className="flex items-center gap-1.5 text-xs text-warning" role="alert">
          <AlertTriangle className="h-3.5 w-3.5" /> The serialized table is at its{" "}
          {Math.round(table.limit_state.limit_bytes / 1024)} KiB limit (
          {table.limit_state.serialized_bytes.toLocaleString()} bytes); exports show exactly this stored revision.
        </p>
      )}
      {tableError && (
        <p className="text-xs text-destructive" role="alert">
          {tableError}
        </p>
      )}

      {openEvidence && (
        <PassagePanel
          sourceId={openEvidence.source_id}
          chunkId={openEvidence.chunk_id}
          label={openEvidence.label}
          query=""
          onClose={() => setOpenEvidence(null)}
        />
      )}

      {/* grid */}
      <div className="max-h-[28rem] overflow-auto rounded-md border" tabIndex={0}>
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <thead>
            <tr>
              <th scope="col" className="sticky top-0 z-10 border-b border-r bg-muted px-2 py-1.5">
                <input
                  type="checkbox"
                  aria-label="Select all rows for rerun"
                  checked={items.length > 0 && items.every((row) => selectedRows[row.row_source_id])}
                  onChange={(event) => {
                    const next: Record<string, boolean> = {};
                    if (event.target.checked) for (const row of items) next[row.row_source_id] = true;
                    setSelectedRows(next);
                  }}
                />
              </th>
              <th scope="col" className="sticky top-0 z-10 border-b border-r bg-muted px-2 py-1.5 font-semibold">
                Row
              </th>
              {columns.map((column) => (
                <th key={column.id} scope="col" className="sticky top-0 z-10 border-b border-r bg-muted px-2 py-1.5">
                  <label className="flex items-center gap-1.5 font-semibold">
                    <input
                      type="checkbox"
                      aria-label={`Select column ${column.label} for rerun`}
                      checked={!!selectedColumns[column.id]}
                      onChange={(event) =>
                        setSelectedColumns((current) => ({ ...current, [column.id]: event.target.checked }))
                      }
                    />
                    {column.label}
                    <span className="font-normal text-muted-foreground">
                      ({column.type}
                      {column.unit ? ` · ${column.unit}` : ""})
                    </span>
                  </label>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.row_source_id}>
                <td className="border-b border-r px-2 py-1.5 align-top">
                  <input
                    type="checkbox"
                    aria-label={`Select row ${rowLabel(row.row_source_id)} for rerun`}
                    checked={!!selectedRows[row.row_source_id]}
                    onChange={(event) =>
                      setSelectedRows((current) => ({ ...current, [row.row_source_id]: event.target.checked }))
                    }
                  />
                </td>
                <td className="border-b border-r px-2 py-1.5 align-top font-medium">
                  {rowLabel(row.row_source_id)}
                  <div className="text-[10px] font-normal text-muted-foreground">gen {row.row_generation}</div>
                </td>
                {columns.map((column) => {
                  const machine = row.cells.find((cell) => cell.column_id === column.id && cell.origin === "machine");
                  const correction = row.cells.find(
                    (cell) => cell.column_id === column.id && cell.origin === "correction",
                  );
                  const effective = correction ?? machine;
                  const isEditing = editing?.row === row.row_source_id && editing.column.id === column.id;
                  return (
                    <td key={column.id} className="border-b border-r px-2 py-1.5 align-top">
                      {effective ? (
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className={cn(correction && "italic")}>
                              {cellDisplayValue(column, effective.value)}
                            </span>
                            <Badge variant={cellStatusTone(effective.status)}>{effective.status}</Badge>
                            {correction && <Badge variant="outline">corrected</Badge>}
                          </div>
                          {correction && machine && (
                            <p className="text-[10px] text-muted-foreground">
                              machine original: {cellDisplayValue(column, machine.value)} ({machine.status})
                              {correction.corrected_at ? ` · corrected ${formatDate(correction.corrected_at)}` : ""}
                              {correction.corrected_from_run_id ? " · carried from an earlier run" : ""}
                            </p>
                          )}
                          {effective.explanation && (
                            <p className="text-[10px] text-muted-foreground">{effective.explanation}</p>
                          )}
                          <div className="flex flex-wrap items-center gap-1.5">
                            {effective.evidence_refs
                              .map((ref) => evidenceById.get(ref))
                              .filter((entry): entry is ResearchEvidence => entry !== undefined)
                              .map((entry, index) => (
                                <button
                                  key={entry.id}
                                  type="button"
                                  className="text-[10px] text-primary underline underline-offset-2"
                                  onClick={() => setOpenEvidence(entry)}
                                >
                                  evidence {index + 1}
                                </button>
                              ))}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 px-1 text-[10px]"
                              disabled={reviewBusy}
                              onClick={() => setEditing(isEditing ? null : { row: row.row_source_id, column })}
                            >
                              {isEditing ? "close" : "correct"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground underline underline-offset-2"
                          disabled={reviewBusy}
                          onClick={() => setEditing({ row: row.row_source_id, column })}
                        >
                          empty — add correction
                        </button>
                      )}
                      {isEditing && (
                        <CorrectionEditor
                          run={run}
                          row={row}
                          column={column}
                          busy={reviewBusy}
                          machine={machine ?? null}
                          onClose={() => setEditing(null)}
                          onApply={async (op) => {
                            const ok = await onReview([op]);
                            if (ok) {
                              setEditing(null);
                              setReloadKey((key) => key + 1);
                            }
                          }}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {loading && items.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="px-3 py-6 text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading table revision…
                </td>
              </tr>
            )}
            {!loading && items.length === 0 && !tableError && (
              <tr>
                <td colSpan={columns.length + 2} className="px-3 py-6 text-center text-muted-foreground">
                  This run produced no table rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void fetchTable(nextCursor)}>
          {loadingMore ? "Loading…" : "Load more rows"}
        </Button>
      )}

      {/* revision diff */}
      {comparison && (
        <section aria-label="Revision diff" className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
          <p className="flex items-center gap-1.5 font-semibold">
            <GitCompareArrows className="h-3.5 w-3.5" /> Revision diff vs {comparison.from_run_id.slice(0, 8)}…:{" "}
            {comparison.changed_total} changed cell{comparison.changed_total === 1 ? "" : "s"}
            {comparison.truncated ? " (list truncated)" : ""}
          </p>
          {comparison.carried_overrides.length > 0 && (
            <p className="mt-1 text-warning">
              {comparison.carried_overrides.length} user correction overlay(s) were carried over from an earlier run and
              are preserved, not overwritten.
            </p>
          )}
          <ul className="mt-1 space-y-0.5">
            {comparison.rows_added.map((id) => (
              <li key={`add-${id}`}>+ row {rowLabel(id)}</li>
            ))}
            {comparison.rows_removed.map((id) => (
              <li key={`rem-${id}`}>− row {rowLabel(id)}</li>
            ))}
            {comparison.changed_cells.map((change, index) => (
              <li key={`${change.row_source_id}-${change.column_id}-${index}`}>
                {rowLabel(change.row_source_id)} ·{" "}
                {columns.find((column) => column.id === change.column_id)?.label ?? change.column_id.slice(0, 8)}:{" "}
                {change.before.effective
                  ? cellDisplayValue(
                      columns.find((c) => c.id === change.column_id) ?? {
                        id: "",
                        label: "",
                        question: "",
                        type: "text",
                        unit: null,
                        choices: null,
                      },
                      change.before.effective.value,
                    )
                  : "—"}{" "}
                ({change.before.effective?.status ?? "—"}) →{" "}
                {change.after.effective
                  ? cellDisplayValue(
                      columns.find((c) => c.id === change.column_id) ?? {
                        id: "",
                        label: "",
                        question: "",
                        type: "text",
                        unit: null,
                        choices: null,
                      },
                      change.after.effective.value,
                    )
                  : "—"}{" "}
                ({change.after.effective?.status ?? "—"}){change.correction_changed ? " · correction changed" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* rerun + exports */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={
            rerunBusy ||
            (Object.values(selectedRows).every((checked) => !checked) &&
              Object.values(selectedColumns).every((checked) => !checked))
          }
          onClick={() =>
            void onRerun({
              row_source_ids: Object.entries(selectedRows)
                .filter(([, checked]) => checked)
                .map(([id]) => id),
              column_ids: Object.entries(selectedColumns)
                .filter(([, checked]) => checked)
                .map(([id]) => id),
            })
          }
        >
          {rerunBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Rerun selected rows/columns
        </Button>
        <span className="text-xs text-muted-foreground">
          A rerun captures current generations and links to this run. Your corrections are carried over and stay labeled
          as corrections — nothing is silently overwritten.
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void downloadBlob(researchApi.exportPath(run.id, "csv"), `${title.slice(0, 40) || "research"}.csv`)
          }
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void downloadBlob(
              researchApi.exportPath(run.id, "manifest"),
              `${title.slice(0, 40) || "research"}.manifest.json`,
            )
          }
        >
          <Download className="h-3.5 w-3.5" /> Export evidence manifest
        </Button>
      </div>
    </div>
  );
}

function CorrectionEditor({
  run,
  row,
  column,
  machine,
  busy,
  onClose,
  onApply,
}: {
  run: ResearchRunDetail;
  row: ResearchTableRow;
  column: ResearchColumnDeclaration;
  machine: { value: ResearchTypedValue; status: ResearchCellStatus } | null;
  busy: boolean;
  onClose: () => void;
  onApply: (op: ResearchReviewOp) => Promise<void>;
}) {
  const [valueText, setValueText] = useState(
    column.type === "boolean"
      ? String(machine?.value ?? "")
      : machine?.value === null || machine?.value === undefined
        ? ""
        : String(machine.value),
  );
  const [status, setStatus] = useState<ResearchCellStatus>(machine?.status ?? "supported");
  const [explanation, setExplanation] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-1 space-y-1.5 rounded-md border bg-background p-2" aria-label={`Correct ${column.label}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        User correction (review overlay)
      </p>
      {column.type === "boolean" ? (
        <select
          aria-label="Corrected value"
          className="h-7 w-full rounded-md border bg-background px-2 text-xs"
          value={valueText}
          onChange={(event) => setValueText(event.target.value)}
        >
          <option value="">(choose)</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : column.type === "enum" ? (
        <select
          aria-label="Corrected value"
          className="h-7 w-full rounded-md border bg-background px-2 text-xs"
          value={valueText}
          onChange={(event) => setValueText(event.target.value)}
        >
          <option value="">(choose)</option>
          {(column.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : (
        <Input
          aria-label="Corrected value"
          className="h-7 text-xs"
          value={valueText}
          onChange={(event) => setValueText(event.target.value)}
          placeholder={
            column.type === "date"
              ? "YYYY-MM-DD"
              : column.type === "number"
                ? `number${column.unit ? ` (${column.unit})` : ""}`
                : "text"
          }
        />
      )}
      <select
        aria-label="Corrected status"
        className="h-7 w-full rounded-md border bg-background px-2 text-xs"
        value={status}
        onChange={(event) => setStatus(event.target.value as ResearchCellStatus)}
      >
        {CELL_STATUSES.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>
      <Textarea
        aria-label="Correction explanation"
        className="min-h-8 text-xs"
        maxLength={RESEARCH_CELL_EXPLANATION_MAX_CHARS}
        placeholder="Why this is a correction (provenance)"
        value={explanation}
        onChange={(event) => setExplanation(event.target.value)}
      />
      {error && (
        <p className="text-[10px] text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setError(null);
            if (status === "not_found") {
              void onApply({
                op: "correct_cell",
                column_id: column.id,
                row_source_id: row.row_source_id,
                value: null,
                status,
                ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
              });
              return;
            }
            const parsed = parseCorrectionValue(column, valueText);
            if (!parsed.ok) {
              setError(parsed.message);
              return;
            }
            void onApply({
              op: "correct_cell",
              column_id: column.id,
              row_source_id: row.row_source_id,
              value: parsed.value,
              status,
              ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
            });
          }}
        >
          Apply correction
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Discard
        </Button>
        <span className="self-end text-[10px] text-muted-foreground">review rev {run.review_revision}</span>
      </div>
    </div>
  );
}
