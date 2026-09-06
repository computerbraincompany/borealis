import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  ChevronRight,
  Download,
  FlaskConical,
  GitCompareArrows,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  StopCircle,
  Trash2,
  X,
} from "lucide-react";
import {
  analysesApi,
  formatApiError,
  isTerminalAnalysisRunStatus,
  sourcesApi,
  type Analysis,
  type AnalysisComparison,
  type AnalysisParameterDeclaration,
  type AnalysisParameterValue,
  type AnalysisResultDetail,
  type AnalysisResultSummary,
  type AnalysisRun,
  type AnalysisRunSummary,
  type AnalysisSummaryItem,
  type QueryResultCell,
  type Source,
} from "@/lib/api";
import { takePromotionStash } from "@/lib/analysisPromotion";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const ChartCard = lazy(() => import("@/components/ChartCard").then((module) => ({ default: module.ChartCard })));

const RUN_POLL_BASE_MS = 1_000;
const RUN_POLL_MAX_MS = 15_000;
const RUN_POLL_HIDDEN_MS = 5_000;

function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback UUIDv4 for non-secure contexts; never reuse across clicks.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function runStatusLabel(status: AnalysisRunSummary["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "stale-inputs":
      return "Stale inputs";
    default:
      return status;
  }
}

function runStatusTone(status: AnalysisRunSummary["status"]): "success" | "secondary" | "destructive" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "stale-inputs") return "destructive";
  return "secondary";
}

function cellText(value: QueryResultCell): string {
  if (value === null) return "null";
  return String(value);
}

function DataTable({
  columns,
  rows,
  caption,
}: {
  columns: readonly string[];
  rows: readonly (readonly QueryResultCell[])[];
  caption: string;
}) {
  return (
    <div className="max-h-80 overflow-auto rounded-md border" tabIndex={0} aria-label={caption}>
      <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                scope="col"
                className="sticky top-0 z-10 whitespace-nowrap border-b border-r bg-muted px-3 py-2 font-mono text-[11px] font-semibold last:border-r-0"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={Math.max(1, columns.length)} className="px-3 py-4 text-center text-xs text-muted-foreground">
                No rows.
              </td>
            </tr>
          ) : (
            rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="even:bg-surface-subtle/70">
                {row.map((value, columnIndex) => (
                  <td key={columnIndex} className="max-w-80 border-b border-r px-3 py-1.5 align-top last:border-r-0">
                    <span className="block max-w-80 truncate" title={cellText(value)}>
                      {cellText(value)}
                    </span>
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor dialog
// ---------------------------------------------------------------------------

interface EditorParameterRow {
  name: string;
  type: AnalysisParameterDeclaration["type"];
  required: boolean;
  nullable: boolean;
  defaultRaw: string;
  label: string;
}

function serializeParameterRows(rows: readonly EditorParameterRow[]): AnalysisParameterDeclaration[] | null {
  const declarations: AnalysisParameterDeclaration[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const declaration: AnalysisParameterDeclaration = {
      name,
      type: row.type,
      required: row.required,
      nullable: row.nullable,
    };
    if (row.defaultRaw !== "") {
      if (row.type === "number" || row.type === "integer") {
        const numeric = Number(row.defaultRaw);
        if (!Number.isFinite(numeric)) return null;
        declaration.default = numeric;
      } else if (row.type === "boolean") {
        if (row.defaultRaw !== "true" && row.defaultRaw !== "false") return null;
        declaration.default = row.defaultRaw === "true";
      } else {
        declaration.default = row.defaultRaw;
      }
    }
    if (row.label.trim()) declaration.label = row.label.trim();
    declarations.push(declaration);
  }
  return declarations;
}

function parseComparisonKey(text: string): string[] | null | undefined {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length > 3) return undefined; // invalid signal
  return parts;
}

interface EditorInitial {
  mode: "create" | "edit";
  analysis?: Analysis;
  prefillSql?: string;
  promotionDraft?: boolean;
}

function AnalysisEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: EditorInitial;
  onClose: () => void;
  onSaved: (analysis: Analysis) => void;
}) {
  const editing = initial.mode === "edit" ? initial.analysis : undefined;
  const [title, setTitle] = useState(editing?.title ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [sql, setSql] = useState(editing?.sql ?? initial.prefillSql ?? "");
  const [parameterRows, setParameterRows] = useState<EditorParameterRow[]>(
    (editing?.parameters ?? []).map((declaration) => ({
      name: declaration.name,
      type: declaration.type,
      required: declaration.required,
      nullable: declaration.nullable,
      defaultRaw: declaration.default === undefined ? "" : String(declaration.default),
      label: declaration.label ?? "",
    })),
  );
  const [comparisonKeyText, setComparisonKeyText] = useState((editing?.comparison_key ?? []).join(", "));
  const [selectedSources, setSelectedSources] = useState<string[]>(editing?.source_ids ?? []);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [formNote, setFormNote] = useState<string | null>(null);
  // Busy-dialog rule: while a create/rename request is in flight the dialog
  // cannot be dismissed, because a failure slot would go invisible.
  const savingRef = useRef(false);
  savingRef.current = saving;
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sourcesRequestRef = useRef(0);
  const sourcesAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++sourcesRequestRef.current;
    const abort = new AbortController();
    sourcesAbortRef.current = abort;
    void sourcesApi
      .list({ limit: 100, signal: abort.signal })
      .then((page) => {
        if (!mountedRef.current || requestId !== sourcesRequestRef.current) return;
        setSources(page.items.filter((source) => source.kind === "tabular"));
        setSourcesLoading(false);
      })
      .catch(() => {
        if (!mountedRef.current || requestId !== sourcesRequestRef.current) return;
        setSources([]);
        setSourcesLoading(false);
      });
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abortRef.current?.abort();
      sourcesRequestRef.current += 1;
      sourcesAbortRef.current?.abort();
    };
  }, []);

  const requestClose = () => {
    if (savingRef.current) return;
    onClose();
  };

  const save = async () => {
    if (savingRef.current) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !sql.trim()) {
      setFormNote("A title and the complete SQL text are required.");
      return;
    }
    const comparisonKey = parseComparisonKey(comparisonKeyText);
    if (comparisonKey === undefined) {
      setFormNote("The comparison key holds at most 3 columns.");
      return;
    }
    const parameters = serializeParameterRows(parameterRows);
    if (parameters === null) {
      setFormNote("A parameter default does not match its declared type.");
      return;
    }
    setFormNote(null);
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setSaving(true);
    setDialogError(null);
    const body = {
      title: trimmedTitle,
      description,
      sql: sql.trim(),
      parameters,
      // Presence of source_ids rewrites the explicit set; empty stays
      // selected-empty and never widens.
      source_ids: selectedSources,
      comparison_key: comparisonKey,
    };
    try {
      const saved = editing
        ? await analysesApi.update(editing.id, { ...body, expected_revision: editing.current_revision }, abort.signal)
        : await analysesApi.create(body, abort.signal);
      if (!mountedRef.current || requestRef.current !== requestId || abort.signal.aborted) return;
      onSaved(saved);
    } catch (failure: unknown) {
      if (mountedRef.current && requestRef.current === requestId && !abort.signal.aborted) {
        setDialogError(formatApiError(failure, editing ? "Could not save the edit" : "Could not create the analysis"));
      }
    } finally {
      if (mountedRef.current && requestRef.current === requestId) setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="max-h-[92dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto" aria-busy={saving}>
        <DialogHeader>
          <DialogTitle>{editing ? `Edit “${editing.title}”` : "New analysis"}</DialogTitle>
          <DialogDescription>
            Saved analyses run their complete SQL against an explicit source set. Parameters bind as values only — never
            identifiers or SQL fragments.
          </DialogDescription>
        </DialogHeader>

        {initial.promotionDraft && (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" role="alert">
            This draft came from a chat receipt without a verified full-query capture. Receipt SQL may be a truncated
            preview — a saved analysis must contain the complete statement. Review the text and select the sources.
          </p>
        )}

        {dialogError && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {dialogError}
          </p>
        )}
        {formNote && (
          <p role="alert" className="rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
            {formNote}
          </p>
        )}

        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="analysis-title">Title</Label>
              <Input
                id="analysis-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="analysis-comparison-key">Comparison key (up to 3 columns, comma-separated)</Label>
              <Input
                id="analysis-comparison-key"
                value={comparisonKeyText}
                onChange={(event) => setComparisonKeyText(event.target.value)}
                placeholder="month"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="analysis-description">Description</Label>
            <Input
              id="analysis-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2_000}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="analysis-sql">SQL (read-only SELECT; ? placeholders bind typed parameters in order)</Label>
            <Textarea
              id="analysis-sql"
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              rows={10}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Parameters (max 20)</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={parameterRows.length >= 20}
                onClick={() =>
                  setParameterRows((rows) => [
                    ...rows,
                    { name: "", type: "string", required: true, nullable: false, defaultRaw: "", label: "" },
                  ])
                }
              >
                <Plus className="h-3.5 w-3.5" /> Add parameter
              </Button>
            </div>
            {parameterRows.map((row, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
                <Input
                  value={row.name}
                  onChange={(event) =>
                    setParameterRows((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)),
                    )
                  }
                  placeholder="name"
                  aria-label={`Parameter ${index + 1} name`}
                  className="w-40"
                />
                <select
                  value={row.type}
                  aria-label={`Parameter ${index + 1} type`}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  onChange={(event) =>
                    setParameterRows((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, type: event.target.value as EditorParameterRow["type"] } : r,
                      ),
                    )
                  }
                >
                  {(["string", "number", "integer", "boolean", "date"] as const).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={row.required}
                    aria-label={`Parameter ${index + 1} required`}
                    onChange={(event) =>
                      setParameterRows((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, required: event.target.checked } : r)),
                      )
                    }
                  />
                  required
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={row.nullable}
                    aria-label={`Parameter ${index + 1} nullable`}
                    onChange={(event) =>
                      setParameterRows((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, nullable: event.target.checked } : r)),
                      )
                    }
                  />
                  nullable
                </label>
                <Input
                  value={row.defaultRaw}
                  onChange={(event) =>
                    setParameterRows((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, defaultRaw: event.target.value } : r)),
                    )
                  }
                  placeholder="default"
                  aria-label={`Parameter ${index + 1} default`}
                  className="w-32"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove parameter ${index + 1}`}
                  onClick={() => setParameterRows((rows) => rows.filter((_, i) => i !== index))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <Label>
              Sources
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {selectedSources.length === 0
                  ? "Selected-empty: runs execute against an empty scope and never widen automatically."
                  : `${selectedSources.length} selected`}
              </span>
            </Label>
            {editing && editing.sources.some((binding) => binding.unavailable_at !== null) && (
              <p className="text-xs text-destructive" role="alert">
                A previously selected source was deleted (marked unavailable). Update the selection to rerun.
              </p>
            )}
            {sourcesLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : sources.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                No tabular sources in this workspace yet. Upload one on the Sources page.
              </p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                {sources.map((source) => {
                  const tableName = source.tabular?.table ?? source.name;
                  const checked = selectedSources.includes(source.id);
                  return (
                    <label
                      key={source.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-secondary/60"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-label={`Select source ${tableName}`}
                        onChange={(event) =>
                          setSelectedSources((current) =>
                            event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id),
                          )
                        }
                      />
                      <span className="font-mono">{tableName}</span>
                      <span className="truncate text-muted-foreground">{source.display_name}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {selectedSources.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Query table names for the current selection:{" "}
                <span className="font-mono">
                  {sources
                    .filter((source) => selectedSources.includes(source.id))
                    .map((source) => source.tabular?.table ?? source.name)
                    .join(", ")}
                </span>
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={requestClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : editing ? "Save edit" : "Create analysis"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Comparison view
// ---------------------------------------------------------------------------

function ComparisonView({ comparison }: { comparison: AnalysisComparison }) {
  return (
    <div className="space-y-4" aria-label="Comparison result">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={comparison.mode === "keyed" ? "success" : "secondary"}>
          {comparison.mode === "keyed" ? `Keyed on ${comparison.key_columns.join(", ")}` : "Side by side"}
        </Badge>
        {comparison.reason_code && comparison.reason_code !== "no-comparison-key" && (
          <Badge variant="destructive">
            Row diff unsupported: {comparison.reason_code}
            {comparison.reason_detail ? ` (${comparison.reason_detail})` : ""}
          </Badge>
        )}
        {!comparison.exhaustive && (
          <Badge variant="secondary">Preview only — a stored input is truncated; totals are not claimed</Badge>
        )}
        {comparison.exhaustive && comparison.truncated && (
          <Badge variant="secondary">Diff list truncated — totals are exact</Badge>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parameters</h4>
          {comparison.parameters.same ? (
            <p className="mt-1 text-xs text-muted-foreground">Identical</p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs">
              {comparison.parameters.changed.map((change) => (
                <li key={change.name} className="font-mono">
                  {change.name}: {cellText(change.left)} → {cellText(change.right)}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Schema</h4>
          {comparison.schema.same ? (
            <p className="mt-1 text-xs text-muted-foreground">Identical</p>
          ) : (
            <ul className="mt-1 space-y-1 text-xs">
              {comparison.schema.left_only.length > 0 && <li>Only left: {comparison.schema.left_only.join(", ")}</li>}
              {comparison.schema.right_only.length > 0 && (
                <li>Only right: {comparison.schema.right_only.join(", ")}</li>
              )}
              {comparison.schema.changed_types.map((change) => (
                <li key={change.name}>
                  Type of {change.name}: {change.from} → {change.to}
                </li>
              ))}
              {comparison.schema.order_changed && <li>Column order changed</li>}
            </ul>
          )}
        </Card>
        <Card className="p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Source versions</h4>
          <ul className="mt-1 space-y-1 text-xs">
            {comparison.sources.length === 0 && <li className="text-muted-foreground">No attached sources</li>}
            {comparison.sources.map((entry) => (
              <li key={entry.source_id} className="font-mono">
                {entry.source_id.slice(0, 8)}: {entry.status}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {comparison.mode === "keyed" ? (
        <div className="space-y-4">
          <section aria-label="Removed rows">
            <h4 className="mb-1 text-sm font-semibold">
              Removed ({comparison.exhaustive ? comparison.removed_total : "preview"}):
            </h4>
            <DataTable
              caption="Rows only in the left result"
              columns={comparison.left_table.columns}
              rows={comparison.removed ?? []}
            />
          </section>
          <section aria-label="Added rows">
            <h4 className="mb-1 text-sm font-semibold">
              Added ({comparison.exhaustive ? comparison.added_total : "preview"}):
            </h4>
            <DataTable
              caption="Rows only in the right result"
              columns={comparison.right_table.columns}
              rows={comparison.added ?? []}
            />
          </section>
          <section aria-label="Changed rows">
            <h4 className="mb-1 text-sm font-semibold">
              Changed ({comparison.exhaustive ? comparison.changed_total : "preview"}):
            </h4>
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {(comparison.changed ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">No changed rows in this diff.</p>
              )}
              {(comparison.changed ?? []).map((entry, index) => (
                <div key={index} className="rounded-md border p-2 text-xs">
                  <span className="font-mono font-semibold">key: {entry.key.map(cellText).join(" · ")}</span>
                  <ul className="mt-1 space-y-0.5">
                    {entry.changes.map((change) => (
                      <li key={change.column} className="font-mono">
                        {change.column}: {cellText(change.before)} → {cellText(change.after)}
                        {change.delta !== null && (
                          <span className={cn("ml-2", change.delta > 0 ? "text-success" : "text-destructive")}>
                            Δ {change.delta}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {[
            { table: comparison.left_table, label: "Left result", id: comparison.left_result_id },
            { table: comparison.right_table, label: "Right result", id: comparison.right_result_id },
          ].map((side) => (
            <section key={side.id} aria-label={side.label}>
              <h4 className="mb-1 text-sm font-semibold">
                {side.label} · {side.table.returned_rows} stored rows
                {!side.table.complete && (
                  <span className="ml-2 text-[10px] uppercase text-warning">
                    preview ({side.table.completeness_reasons.join(", ")})
                  </span>
                )}
                {side.table.preview_truncated && (
                  <span className="ml-2 text-[10px] text-muted-foreground">display truncated</span>
                )}
              </h4>
              <DataTable caption={`${side.label} preview`} columns={side.table.columns} rows={side.table.rows} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function AnalysesView() {
  // -- catalog ----------------------------------------------------------------
  const [analyses, setAnalyses] = useState<AnalysisSummaryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const catalogRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const loadMoreOwnerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  // -- selection / detail ------------------------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [runs, setRuns] = useState<AnalysisRunSummary[]>([]);
  const [results, setResults] = useState<AnalysisResultSummary[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);

  // -- selected result / chart / compare ---------------------------------------
  const [resultDetail, setResultDetail] = useState<AnalysisResultDetail | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const resultRequestRef = useRef(0);
  const resultAbortRef = useRef<AbortController | null>(null);
  const [chartResultId, setChartResultId] = useState<string | null>(null);
  const chartAbortRef = useRef<AbortController | null>(null);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const [comparison, setComparison] = useState<AnalysisComparison | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const compareRequestRef = useRef(0);
  const compareAbortRef = useRef<AbortController | null>(null);

  // -- run execution -----------------------------------------------------------
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [paramInvalidNote, setParamInvalidNote] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<AnalysisRun | null>(null);
  const activeRunRef = useRef<AnalysisRun | null>(null);
  activeRunRef.current = activeRun;
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const runSubmitRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);
  const pollTargetRef = useRef<{ analysisId: string; runId: string } | null>(null);

  // -- dialogs -----------------------------------------------------------------
  const [editor, setEditor] = useState<EditorInitial | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AnalysisSummaryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteRequestRef = useRef(0);
  const deleteAbortRef = useRef<AbortController | null>(null);
  const [deleteResultTarget, setDeleteResultTarget] = useState<string | null>(null);
  const [deletingResult, setDeletingResult] = useState(false);
  const deleteResultRequestRef = useRef(0);
  const deleteResultAbortRef = useRef<AbortController | null>(null);
  const [exportBusy, setExportBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const requestId = ++catalogRequestRef.current;
    loadMoreOwnerRef.current = null;
    setLoadingMore(false);
    setPageError(null);
    try {
      const page = await analysesApi.list();
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      setAnalyses((current) => mergeCatalogHead(page.items, current));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current) {
        setPageError(formatApiError(failure, "Could not load analyses"));
      }
    } finally {
      if (mountedRef.current && requestId === catalogRequestRef.current) setLoading(false);
    }
  }, []);

  const loadMore = async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadMoreOwnerRef.current !== null) return;
    const requestId = ++catalogRequestRef.current;
    loadMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await analysesApi.list({ cursor });
      if (!mountedRef.current || requestId !== catalogRequestRef.current) return;
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
      setAnalyses((current) => mergeCatalogContinuation(current, page.items));
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === catalogRequestRef.current) {
        setPageError(formatApiError(failure, "Could not load older analyses"));
      }
    } finally {
      if (loadMoreOwnerRef.current === requestId) {
        loadMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  };

  const refreshDetail = useCallback(async (targetId: string, options: { quiet?: boolean } = {}) => {
    const requestId = ++detailRequestRef.current;
    detailAbortRef.current?.abort();
    const abort = new AbortController();
    detailAbortRef.current = abort;
    if (!options.quiet) setDetailLoading(true);
    try {
      const [detailPage, runPage, resultPage] = await Promise.all([
        analysesApi.get(targetId, abort.signal),
        analysesApi.listRuns(targetId),
        analysesApi.listResults(targetId),
      ]);
      if (!mountedRef.current || detailRequestRef.current !== requestId || abort.signal.aborted) return;
      setAnalysis(detailPage);
      setRuns(runPage.items);
      setResults(resultPage.items);
      setDetailError(null);
      const active = runPage.items.find((run) => run.status === "queued" || run.status === "running");
      // The tracked run owns the run panel: a refresh adopts a different
      // active run but never clobbers the current target (including its
      // terminal summary), and clears only when nothing was tracked.
      if (active && activeRunRef.current?.id !== active.id) {
        pollTargetRef.current = { analysisId: targetId, runId: active.id };
        setActiveRun({ ...active, parameter_values: [], sources: [] });
      } else if (!active && !activeRunRef.current) {
        pollTargetRef.current = null;
        setActiveRun(null);
      }
    } catch (failure: unknown) {
      if (mountedRef.current && detailRequestRef.current === requestId && !abort.signal.aborted) {
        setDetailError(formatApiError(failure, "Could not load the analysis"));
      }
    } finally {
      if (mountedRef.current && detailRequestRef.current === requestId && !abort.signal.aborted) {
        setDetailLoading(false);
      }
    }
  }, []);

  const selectAnalysis = (id: string | null) => {
    detailRequestRef.current += 1;
    detailAbortRef.current?.abort();
    pollTargetRef.current = null;
    setActiveRun(null);
    resultRequestRef.current += 1;
    resultAbortRef.current?.abort();
    setResultDetail(null);
    chartAbortRef.current?.abort();
    setChartResultId(null);
    compareRequestRef.current += 1;
    compareAbortRef.current?.abort();
    setComparison(null);
    setCompareError(null);
    setCompareSelection([]);
    setDetailError(null);
    setRunError(null);
    setParamValues({});
    setParamInvalidNote(null);
    setSelectedId(id);
    if (id) void refreshDetail(id);
  };

  // Callers of refreshResults are already target-guarded; a failed refresh is
  // corrected by the next detail reload.
  const refreshResults = useCallback(async (targetId: string) => {
    try {
      const page = await analysesApi.listResults(targetId);
      if (pollTargetRef.current?.analysisId !== targetId && selectedIdRef.current !== targetId) return;
      setResults(page.items);
    } catch {
      // best-effort
    }
  }, []);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  // -- visibility-aware run polling with failure backoff ------------------------
  useEffect(() => {
    if (!selectedId || !activeRun || isTerminalAnalysisRunStatus(activeRun.status)) return;
    const analysisId = selectedId;
    const runId = activeRun.id;
    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;

    const delayFor = () =>
      document.hidden ? RUN_POLL_HIDDEN_MS : Math.min(RUN_POLL_MAX_MS, RUN_POLL_BASE_MS * 2 ** failures);

    const schedule = () => {
      timer = setTimeout(tick, delayFor());
    };
    const onVisible = () => schedule();

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        schedule();
        return;
      }
      abort?.abort();
      abort = new AbortController();
      try {
        const run = await analysesApi.getRun(analysisId, runId, abort.signal);
        if (cancelled || pollTargetRef.current?.runId !== runId) return;
        failures = 0;
        setActiveRun(run);
        if (isTerminalAnalysisRunStatus(run.status)) {
          void refreshDetail(analysisId, { quiet: true });
          void refreshResults(analysisId);
          return;
        }
        schedule();
      } catch (failure: unknown) {
        if (cancelled || abort?.signal.aborted || pollTargetRef.current?.runId !== runId) return;
        failures += 1;
        if (failures >= 6) {
          setRunError(formatApiError(failure, "Could not reach the analysis run; retrying more slowly"));
        }
        schedule();
      }
    };

    window.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      cancelled = true;
      window.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
      abort?.abort();
    };
    // The loop is owned by the exact (analysisId, runId) target and restarts
    // only when the tracked run identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, activeRun?.id, activeRun?.status, refreshDetail, refreshResults]);

  const buildRunValues = (): Record<string, AnalysisParameterValue> | null => {
    const values: Record<string, AnalysisParameterValue> = {};
    for (const declaration of analysis?.parameters ?? []) {
      const raw = paramValues[declaration.name];
      if (raw === undefined || raw === "unset" || raw === "") continue; // default/nullable handled by server
      if (declaration.type === "boolean") {
        if (raw !== "true" && raw !== "false") {
          setParamInvalidNote(`Parameter “${declaration.name}” needs true or false.`);
          return null;
        }
        values[declaration.name] = raw === "true";
        continue;
      }
      if (declaration.type === "number" || declaration.type === "integer") {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric) || (declaration.type === "integer" && !Number.isSafeInteger(numeric))) {
          setParamInvalidNote(`Parameter “${declaration.name}” needs a valid ${declaration.type} value.`);
          return null;
        }
        values[declaration.name] = numeric;
        continue;
      }
      values[declaration.name] = raw;
    }
    setParamInvalidNote(null);
    return values;
  };

  const submitRun = async () => {
    if (!analysis || runBusy) return;
    const values = buildRunValues();
    if (values === null) return;
    const targetId = analysis.id;
    const requestId = ++runSubmitRef.current;
    runAbortRef.current?.abort();
    const abort = new AbortController();
    runAbortRef.current = abort;
    setRunBusy(true);
    setRunError(null);
    try {
      const accepted = await analysesApi.run(
        targetId,
        { values, operation_id: newOperationId(), expected_revision: analysis.current_revision },
        abort.signal,
      );
      if (!mountedRef.current || runSubmitRef.current !== requestId || abort.signal.aborted) return;
      pollTargetRef.current = { analysisId: targetId, runId: accepted.run.id };
      setActiveRun(accepted.run);
      void refreshDetail(targetId, { quiet: true });
    } catch (failure: unknown) {
      if (mountedRef.current && runSubmitRef.current === requestId && !abort.signal.aborted) {
        setRunError(formatApiError(failure, "Could not start the run"));
      }
    } finally {
      if (mountedRef.current && runSubmitRef.current === requestId) setRunBusy(false);
    }
  };

  const cancelActiveRun = async () => {
    if (!analysis || !activeRun) return;
    const targetId = analysis.id;
    const runId = activeRun.id;
    try {
      await analysesApi.cancelRun(targetId, runId);
      // The polling loop observes the durable terminal state; keep the target.
      void refreshDetail(targetId, { quiet: true });
    } catch (failure: unknown) {
      setRunError(formatApiError(failure, "Could not cancel the run"));
    }
  };

  const openResult = (resultId: string) => {
    if (!selectedId) return;
    const targetId = selectedId;
    const requestId = ++resultRequestRef.current;
    resultAbortRef.current?.abort();
    const abort = new AbortController();
    resultAbortRef.current = abort;
    setResultLoading(true);
    setResultDetail(null);
    void analysesApi
      .getResult(targetId, resultId, abort.signal)
      .then((detail) => {
        if (!mountedRef.current || resultRequestRef.current !== requestId || abort.signal.aborted) return;
        setResultDetail(detail);
      })
      .catch((failure: unknown) => {
        if (mountedRef.current && resultRequestRef.current === requestId && !abort.signal.aborted) {
          setPageError(formatApiError(failure, "Could not load the result"));
        }
      })
      .finally(() => {
        if (mountedRef.current && resultRequestRef.current === requestId) setResultLoading(false);
      });
  };

  const toggleChart = (resultId: string) => {
    chartAbortRef.current?.abort();
    if (chartResultId === resultId) {
      setChartResultId(null);
      return;
    }
    const abort = new AbortController();
    chartAbortRef.current = abort;
    setChartResultId(resultId);
  };

  const toggleCompare = (resultId: string) => {
    setCompareSelection((current) => {
      if (current.includes(resultId)) return current.filter((id) => id !== resultId);
      if (current.length >= 2) return [current[1], resultId];
      return [...current, resultId];
    });
  };

  const runCompare = async () => {
    if (!selectedId || compareSelection.length !== 2) return;
    const [left, right] = compareSelection;
    const targetId = selectedId;
    const requestId = ++compareRequestRef.current;
    compareAbortRef.current?.abort();
    const abort = new AbortController();
    compareAbortRef.current = abort;
    setComparing(true);
    setCompareError(null);
    setComparison(null);
    try {
      const payload = await analysesApi.compare(targetId, left, right, abort.signal);
      if (!mountedRef.current || compareRequestRef.current !== requestId || abort.signal.aborted) return;
      setComparison(payload);
    } catch (failure: unknown) {
      if (mountedRef.current && compareRequestRef.current === requestId && !abort.signal.aborted) {
        setCompareError(formatApiError(failure, "Could not compare these results"));
      }
    } finally {
      if (mountedRef.current && compareRequestRef.current === requestId) setComparing(false);
    }
  };

  const downloadExport = async (format: "csv" | "json" | "manifest") => {
    if (!selectedId || !resultDetail) return;
    setExportBusy(format);
    setPageError(null);
    try {
      await analysesApi.downloadExport(selectedId, resultDetail.id, format);
    } catch (failure: unknown) {
      setPageError(formatApiError(failure, "Could not export the stored result"));
    } finally {
      setExportBusy(null);
    }
  };

  const confirmDeleteAnalysis = async () => {
    if (!deleteTarget || deleting) return;
    const targetId = deleteTarget.id;
    const requestId = ++deleteRequestRef.current;
    deleteAbortRef.current?.abort();
    const abort = new AbortController();
    deleteAbortRef.current = abort;
    setDeleting(true);
    try {
      await analysesApi.remove(targetId, abort.signal);
      if (deleteRequestRef.current !== requestId || abort.signal.aborted) return;
      if (selectedIdRef.current === targetId) selectAnalysis(null);
      setDeleteTarget(null);
      setAnalyses((current) => current.filter((item) => item.id !== targetId));
      void load();
    } catch (failure: unknown) {
      if (deleteRequestRef.current === requestId && !abort.signal.aborted) {
        setPageError(formatApiError(failure, "Could not delete the analysis"));
      }
    } finally {
      if (deleteRequestRef.current === requestId) setDeleting(false);
    }
  };

  const confirmDeleteResult = async () => {
    if (!selectedId || !deleteResultTarget || deletingResult) return;
    const targetId = selectedId;
    const resultId = deleteResultTarget;
    const requestId = ++deleteResultRequestRef.current;
    deleteResultAbortRef.current?.abort();
    const abort = new AbortController();
    deleteResultAbortRef.current = abort;
    setDeletingResult(true);
    try {
      await analysesApi.removeResult(targetId, resultId, abort.signal);
      if (deleteResultRequestRef.current !== requestId || abort.signal.aborted) return;
      // Bump the result request generation first so a stale in-flight detail
      // response cannot resurrect the deleted row.
      resultRequestRef.current += 1;
      resultAbortRef.current?.abort();
      setResultDetail(null);
      setResults((current) => current.filter((item) => item.id !== resultId));
      setCompareSelection((current) => current.filter((id) => id !== resultId));
      if (chartResultId === resultId) setChartResultId(null);
      setDeleteResultTarget(null);
    } catch (failure: unknown) {
      if (deleteResultRequestRef.current === requestId && !abort.signal.aborted) {
        setPageError(formatApiError(failure, "Could not delete the result"));
      }
    } finally {
      if (deleteResultRequestRef.current === requestId) setDeletingResult(false);
    }
  };

  // -- promotion draft from a chat receipt --------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    void load();
    if (window.location.hash.includes("promote")) {
      const stash = takePromotionStash();
      if (stash) {
        setEditor({ mode: "create", prefillSql: stash.sql, promotionDraft: true });
        window.location.hash = "/analyses";
      }
    }
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current += 1;
      loadMoreOwnerRef.current = null;
      detailRequestRef.current += 1;
      detailAbortRef.current?.abort();
      resultRequestRef.current += 1;
      resultAbortRef.current?.abort();
      compareRequestRef.current += 1;
      compareAbortRef.current?.abort();
      runSubmitRef.current += 1;
      runAbortRef.current?.abort();
      deleteRequestRef.current += 1;
      deleteAbortRef.current?.abort();
      deleteResultRequestRef.current += 1;
      deleteResultAbortRef.current?.abort();
      chartAbortRef.current?.abort();
    };
  }, [load]);

  // -- render -------------------------------------------------------------------
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        {deleteTarget && (
          <ConfirmDialog
            title={`Delete “${deleteTarget.title}”`}
            description="This permanently removes the definition, its run history, and every retained result. Copied report snapshots stay intact. This cannot be undone."
            busy={deleting}
            onConfirm={() => void confirmDeleteAnalysis()}
            onCancel={() => {
              if (!deleting) setDeleteTarget(null);
            }}
          />
        )}
        {deleteResultTarget && (
          <ConfirmDialog
            title="Delete this result?"
            description="The immutable stored snapshot and its export are removed. Copied report snapshots stay intact."
            busy={deletingResult}
            onConfirm={() => void confirmDeleteResult()}
            onCancel={() => {
              if (!deletingResult) setDeleteResultTarget(null);
            }}
          />
        )}

        {editor && (
          <AnalysisEditor
            initial={editor}
            onClose={() => setEditor(null)}
            onSaved={(saved) => {
              setEditor(null);
              void load();
              if (selectedIdRef.current === saved.id) void refreshDetail(saved.id);
              else selectAnalysis(saved.id);
            }}
          />
        )}

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <FlaskConical className="h-6 w-6 text-primary" aria-hidden /> Analyses
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Saved queries with typed parameters. Rerun them outside chat, compare immutable results, and export the
              stored table with its provenance.
            </p>
          </div>
          <div className="flex gap-2">
            {selectedId && (
              <Button variant="ghost" size="sm" onClick={() => selectAnalysis(null)}>
                <ArrowLeft className="h-4 w-4" /> All analyses
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Refresh
            </Button>
            <Button size="sm" onClick={() => setEditor({ mode: "create" })}>
              <Plus className="h-4 w-4" /> New analysis
            </Button>
          </div>
        </div>

        {pageError && (
          <div
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {pageError}
          </div>
        )}

        {!selectedId ? (
          loading ? (
            <div className="mt-8 space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-24 w-full rounded-lg" />
              ))}
            </div>
          ) : analyses.length === 0 ? (
            <Card className="mt-8 flex flex-col items-center gap-3 py-16 text-center">
              <FlaskConical className="h-10 w-10 text-muted-foreground/40" />
              <p className="max-w-md text-sm text-muted-foreground">
                No saved analyses yet. Create one in the editor, or save a query from a chat answer that offers “Save as
                analysis”.
              </p>
            </Card>
          ) : (
            <div className="mt-8 space-y-3">
              {analyses.map((item) => (
                <Card
                  key={item.id}
                  className="flex cursor-pointer items-center gap-4 p-4 transition-colors hover:border-foreground/20"
                  onClick={() => selectAnalysis(item.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectAnalysis(item.id);
                    }
                  }}
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FlaskConical className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{item.title}</span>
                      <Badge variant="secondary">r{item.current_revision}</Badge>
                      {item.unavailable_source_count > 0 && (
                        <Badge variant="destructive">{item.unavailable_source_count} source(s) unavailable</Badge>
                      )}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.description}</p>
                    )}
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {item.source_count} source(s) · Updated {formatDate(item.updated_at)}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Card>
              ))}
              {nextCursor && (
                <div className="flex justify-center pt-2">
                  <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore && <Loader2 className="animate-spin" />}
                    Load older analyses
                  </Button>
                </div>
              )}
            </div>
          )
        ) : detailLoading && !analysis ? (
          <div className="mt-8 space-y-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : detailError ? (
          <div
            className="mt-8 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {detailError}
          </div>
        ) : analysis ? (
          <div className="mt-6 space-y-8">
            {/* definition header */}
            <section aria-label="Analysis definition" className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 break-words text-xl font-semibold">{analysis.title}</h2>
                <Badge variant="secondary">revision {analysis.current_revision}</Badge>
                {analysis.source_ids.length === 0 && <Badge variant="secondary">selected-empty scope</Badge>}
                {analysis.comparison_key && (
                  <Badge variant="secondary">key: {analysis.comparison_key.join(", ")}</Badge>
                )}
                <div className="ml-auto flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditor({ mode: "edit", analysis })}
                    disabled={activeRun !== null && !isTerminalAnalysisRunStatus(activeRun.status)}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${analysis.title}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      setDeleteTarget({
                        id: analysis.id,
                        title: analysis.title,
                        description: analysis.description,
                        current_revision: analysis.current_revision,
                        source_count: analysis.source_ids.length,
                        unavailable_source_count: 0,
                        created_at: analysis.created_at,
                        updated_at: analysis.updated_at,
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {analysis.description && <p className="text-sm text-muted-foreground">{analysis.description}</p>}
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                  <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden />
                  SQL and source bindings
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto rounded-md border bg-surface-subtle px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-words">
                  {analysis.sql}
                </pre>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {analysis.sources.map((binding) => (
                    <li key={binding.source_id} className="font-mono">
                      {binding.source_id.slice(0, 8)} · gen {binding.ready_generation ?? "—"}
                      {binding.unavailable_at && <span className="text-destructive"> · unavailable</span>}
                    </li>
                  ))}
                  {analysis.sources.length === 0 && <li>No explicit sources (selected-empty scope).</li>}
                </ul>
              </details>
            </section>

            {/* run panel */}
            <section aria-label="Run" className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Run</h3>
              {analysis.parameters.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {analysis.parameters.map((declaration) => (
                    <div key={declaration.name} className="space-y-1">
                      <Label htmlFor={`run-param-${declaration.name}`}>
                        {declaration.label || declaration.name}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          ({declaration.type}
                          {declaration.required ? ", required" : declaration.nullable ? ", nullable" : ", optional"})
                        </span>
                      </Label>
                      {declaration.type === "boolean" ? (
                        <select
                          id={`run-param-${declaration.name}`}
                          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                          value={paramValues[declaration.name] ?? "unset"}
                          onChange={(event) =>
                            setParamValues((values) => ({ ...values, [declaration.name]: event.target.value }))
                          }
                        >
                          <option value="unset">
                            {declaration.default === undefined
                              ? "— use default —"
                              : `default: ${String(declaration.default)}`}
                          </option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <Input
                          id={`run-param-${declaration.name}`}
                          type={
                            declaration.type === "number"
                              ? "number"
                              : declaration.type === "integer"
                                ? "number"
                                : declaration.type === "date"
                                  ? "date"
                                  : "text"
                          }
                          step={declaration.type === "number" ? "any" : undefined}
                          value={paramValues[declaration.name] ?? ""}
                          placeholder={
                            declaration.default === undefined
                              ? declaration.type
                              : `default: ${String(declaration.default)}`
                          }
                          onChange={(event) =>
                            setParamValues((values) => ({ ...values, [declaration.name]: event.target.value }))
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
              {paramInvalidNote && (
                <p role="alert" className="text-sm text-destructive">
                  {paramInvalidNote}
                </p>
              )}
              {runError && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {runError}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void submitRun()}
                  disabled={runBusy || (activeRun !== null && !isTerminalAnalysisRunStatus(activeRun.status))}
                >
                  <Play className="h-3.5 w-3.5" />
                  {runBusy ? "Starting…" : "Run now"}
                </Button>
                {activeRun && !isTerminalAnalysisRunStatus(activeRun.status) && (
                  <>
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      {runStatusLabel(activeRun.status)}…
                    </span>
                    <Button variant="outline" size="sm" onClick={() => void cancelActiveRun()}>
                      <StopCircle className="h-3.5 w-3.5" /> Cancel
                    </Button>
                  </>
                )}
                {activeRun && isTerminalAnalysisRunStatus(activeRun.status) && (
                  <span className="text-xs text-muted-foreground">
                    Last run {activeRun.id.slice(0, 8)}: {runStatusLabel(activeRun.status)}
                    {activeRun.error_code ? ` (${activeRun.error_code})` : ""}
                  </span>
                )}
              </div>
            </section>

            {/* results */}
            <section aria-label="Results" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Results</h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runCompare()}
                  disabled={compareSelection.length !== 2 || comparing}
                >
                  <GitCompareArrows className="h-3.5 w-3.5" />
                  {comparing ? "Comparing…" : `Compare selected (${compareSelection.length}/2)`}
                </Button>
              </div>
              {compareError && (
                <p role="alert" className="text-sm text-destructive">
                  {compareError}
                </p>
              )}
              {comparison && <ComparisonView comparison={comparison} />}
              {results.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  No stored results yet. Run the analysis to publish one.
                </p>
              ) : (
                <ul className="space-y-1">
                  {results.map((result) => (
                    <li
                      key={result.id}
                      className={cn(
                        "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs",
                        resultDetail?.id === result.id && "border-primary/40 bg-primary/5",
                      )}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select result ${result.id.slice(0, 8)} for comparison`}
                        checked={compareSelection.includes(result.id)}
                        onChange={() => toggleCompare(result.id)}
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                        onClick={() => openResult(result.id)}
                      >
                        {formatDate(result.created_at)} · {result.returned_rows} rows · r{result.revision}
                      </button>
                      {!result.complete && (
                        <Badge variant="secondary">partial: {result.completeness_reasons.join(", ")}</Badge>
                      )}
                      <Badge variant={result.row_count_exact ? "success" : "secondary"}>
                        {result.row_count_exact ? "exact count" : "returned rows"}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete result ${result.id.slice(0, 8)}`}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteResultTarget(result.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {resultLoading && <Skeleton className="h-32 w-full" />}
              {resultDetail && (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold">Result {resultDetail.id.slice(0, 8)}</h4>
                    {!resultDetail.completeness.complete && (
                      <Badge variant="destructive">
                        partial export ({resultDetail.completeness.reasons.join(", ")})
                      </Badge>
                    )}
                    <div className="ml-auto flex flex-wrap gap-1.5">
                      {(["csv", "json", "manifest"] as const).map((format) => (
                        <Button
                          key={format}
                          variant="outline"
                          size="sm"
                          disabled={exportBusy !== null}
                          onClick={() => void downloadExport(format)}
                          title="Exports the stored snapshot only"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {exportBusy === format ? "Preparing…" : format}
                        </Button>
                      ))}
                      <Button variant="outline" size="sm" onClick={() => toggleChart(resultDetail.id)}>
                        <BarChart3 className="h-3.5 w-3.5" />
                        {chartResultId === resultDetail.id ? "Hide chart" : "Chart"}
                      </Button>
                    </div>
                  </div>
                  {(resultDetail.parameter_values.length > 0 || resultDetail.source_provenance.length > 0) && (
                    <p className="text-[11px] text-muted-foreground">
                      {resultDetail.parameter_values
                        .map((binding) => `${binding.name}=${cellText(binding.value)}`)
                        .join(" · ") || "no parameters"}{" "}
                      · sources:{" "}
                      {resultDetail.source_provenance
                        .map((source) => `${source.source_id.slice(0, 8)}@g${source.ready_generation}`)
                        .join(", ") || "none"}
                    </p>
                  )}
                  <DataTable
                    caption={`Stored rows for result ${resultDetail.id.slice(0, 8)}`}
                    columns={resultDetail.columns.map((column) => column.name)}
                    rows={resultDetail.rows}
                  />
                  {chartResultId === resultDetail.id && (
                    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                      <ChartCard
                        chartId={`result:${resultDetail.id}`}
                        loadChart={async () => {
                          const payload = await analysesApi.resultChart(resultDetail.analysis_id, resultDetail.id);
                          return { id: payload.result_id, spec: payload.spec };
                        }}
                      />
                    </Suspense>
                  )}
                </div>
              )}
            </section>

            {/* run history */}
            <section aria-label="Run history" className="space-y-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Run history</h3>
              {runs.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  No runs recorded yet.
                </p>
              ) : (
                <ul className="space-y-1">
                  {runs.map((run) => (
                    <li key={run.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
                      <span className="font-mono">{run.id.slice(0, 8)}</span>
                      <Badge variant={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
                      <span className="text-muted-foreground">
                        r{run.revision} · {formatDate(run.created_at)}
                      </span>
                      {run.operation_id && (
                        <span className="font-mono text-muted-foreground">op {run.operation_id.slice(0, 8)}</span>
                      )}
                      {run.error_code && <span className="text-destructive">{run.error_code}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
