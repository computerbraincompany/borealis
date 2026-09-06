/**
 * Typed comparison projection, review-overlay views, exports, and the M13
 * artifact adapter for durable local research (M15 stage 3).
 *
 * This module is the single semantic home for everything that READS a
 * comparison table and its dossier and turns it into another representation:
 *
 * - cell view triples (`original` machine output / `extracted` classification
 *   / `corrected` overlay / `effective` merged view) built on the typed-value
 *   contract owned by `researchSchemas.ts` — nothing here coerces a value; an
 *   `invalid` machine cell keeps its verbatim original everywhere it is
 *   projected, and the JSON manifest is the typed-exact companion;
 * - correction OVERLAY semantics: machine rows are immutable history, a
 *   correction overlay never touches them, and a rerun carries user overrides
 *   visibly with `corrected_from_run_id` provenance (the store inherits them
 *   at accept time with `DO NOTHING` — never a silent overwrite);
 * - changed-cell diffing between run revisions (row identity is the source
 *   id; cells are keyed by column + row), bounded and truncation-flagged;
 * - bounded server-side sort/filter over a keyset page with an explicit
 *   `view_state` (the keyset cursor always rides the row identity, so a
 *   page-local sort/filter never pretends to be a global ordering);
 * - CSV export (formula-safe escaping incl. leading `=+-@`, TAB, and CR
 *   guards, RFC-style quote/comma escaping, UTF-8 BOM consistent with the
 *   M12 analysis exports, literal `null` for absent values) and the
 *   companion JSON evidence/locator MANIFEST. Both render the 1 MiB
 *   serialized limit state explicitly; nothing is silently truncated;
 * - the M13 projection: a memo becomes narrative sections with `[n]` markers
 *   mapped into the revision's own evidence array (≤100 refs, ≤800-char
 *   quoted excerpts — shortened excerpts carry an explicit label and keep
 *   stable ids and content hashes); a comparison becomes one analysis-backed
 *   table envelope within 60 rows / 32 columns / 1,000 cells and the
 *   400,000-character revision budget, with labeled omitted rows/columns and
 *   preview-truncation flags in the provenance completeness reasons.
 *
 * Fail-closed rules: exports and projections read only stored ledger rows
 * (no retrieval, no model, no source re-read); the 1 MiB table cap and the
 * document payload cap are enforced with explicit limit/omission labels,
 * never silent drops; an over-budget final projection fails closed rather
 * than publishing mutated data.
 */

import { createHash } from "node:crypto";

import {
  DOCUMENT_EVIDENCE_EXCERPT_MAX_CHARS,
  DOCUMENT_EVIDENCE_MAX_REFS,
  DOCUMENT_MARKDOWN_TOTAL_MAX_CHARS,
  DOCUMENT_TABLE_CELL_MAX_CHARS,
  DOCUMENT_TABLE_COLUMNS_MAX,
  DOCUMENT_TABLE_ROWS_MAX,
  DocumentValidationError,
  buildEvidenceAppendix,
  normalizeDocumentTree,
  type DocumentEvidenceRef,
  type DocumentTableAnalysis,
  type DocumentTreeInput,
} from "./documentTypes.js";
import type {
  ResearchTablePage,
  ResearchTableRowPageItem,
  StoredResearchCell,
  StoredResearchClaim,
  StoredResearchEvidence,
  StoredResearchRevision,
  StoredResearchRun,
  ResearchStore,
} from "./db/stores/researchStore.js";
import {
  RESEARCH_TABLE_SERIALIZED_MAX_BYTES,
  ResearchValidationError,
  researchTableLimitState,
  type ResearchCellStatus,
  type ResearchColumnDeclaration,
  type ResearchTableLimitState,
  type ResearchTypedValue,
} from "./researchSchemas.js";
import type { ChunkLocator } from "./sourceLocations.js";

// ---------------------------------------------------------------------------
// Constants (M13 projection ceilings; renderer bounds are ceilings, never
// raised — the research side may be smaller, the document side never bigger)
// ---------------------------------------------------------------------------

/** Task-fixed projection cap on projected table cells. */
export const RESEARCH_ARTIFACT_TABLE_CELLS_MAX = 1_000;
/** Changed-cell diff cap per response; overflow is truncation-flagged. */
export const RESEARCH_DIFF_CELLS_MAX = 200;
/** Case-insensitive substring bound for the page-local cell filter. */
export const RESEARCH_TABLE_FILTER_TEXT_MAX_CHARS = 200;
/** Deterministic shortening label for projected evidence excerpts. */
export const RESEARCH_EXCERPT_SHORTEN_LABEL = " [shortened]";
/** Deterministic truncation label for projected table cell previews. */
export const RESEARCH_CELL_TRUNCATE_LABEL = "…[truncated]";

const UTF8_BOM = "\uFEFF";
const CSV_LINE = "\r\n";
/**
 * Formula-safe guard: a leading `=`, `+`, `-`, `@`, TAB, or CR is prefixed
 * with an apostrophe; the M12 whitespace-prefixed `=+-@` rule is kept too.
 */
const FORMULA_LEADING = /^[=+\-@\t\r]/u;
const FORMULA_AFTER_WHITESPACE = /^\s*[=+\-@]/u;

// ---------------------------------------------------------------------------
// Cell view triples — original / extracted / corrected / effective
// ---------------------------------------------------------------------------

/**
 * The immutable-history triple for one (column,row) slot: the machine row is
 * the original machine output (`invalid` values preserved verbatim), the
 * correction row is the user overlay, and `effective` is what the merged
 * table read shows. Nothing here mutates or coerces: views only select.
 */
export interface ResearchCellTriple {
  readonly machine: StoredResearchCell | null;
  readonly correction: StoredResearchCell | null;
  readonly effective: StoredResearchCell | null;
}

export function researchCellTriple(cells: readonly StoredResearchCell[]): ResearchCellTriple {
  let machine: StoredResearchCell | null = null;
  let correction: StoredResearchCell | null = null;
  for (const cell of cells) {
    if (cell.origin === "machine") machine = cell;
    else if (cell.origin === "correction") correction = cell;
  }
  return Object.freeze({ machine, correction, effective: correction ?? machine });
}

export interface ResearchCellValueSnapshot {
  readonly value: ResearchTypedValue;
  readonly status: ResearchCellStatus | null;
}

export interface ResearchCellViews {
  /** Original machine output, verbatim (`invalid` values included). */
  readonly original: ResearchCellValueSnapshot | null;
  /** The classified machine extraction (status + typed value). */
  readonly extracted: ResearchCellValueSnapshot | null;
  /** The user overlay, when one exists. */
  readonly corrected: ResearchCellValueSnapshot | null;
  /** What the merged read shows: the correction, else the machine row. */
  readonly effective: ResearchCellValueSnapshot | null;
}

function snapshot(cell: StoredResearchCell | null): ResearchCellValueSnapshot | null {
  return cell === null ? null : Object.freeze({ value: cell.value, status: cell.status });
}

export function researchCellViews(triple: ResearchCellTriple): ResearchCellViews {
  return Object.freeze({
    original: snapshot(triple.machine),
    extracted: snapshot(triple.machine),
    corrected: snapshot(triple.correction),
    effective: snapshot(triple.effective),
  });
}

export function researchCellValueViews(cells: readonly StoredResearchCell[]): ResearchCellViews {
  return researchCellViews(researchCellTriple(cells));
}

// ---------------------------------------------------------------------------
// Materialized run views (bounded keyset paging over the store reads)
// ---------------------------------------------------------------------------

export interface ResearchRunTableView {
  readonly run: StoredResearchRun;
  readonly columns: readonly ResearchColumnDeclaration[];
  /** All rows in keyset order (row_source_id descending), all cell origins. */
  readonly rows: readonly ResearchTableRowPageItem[];
  /** UTF-8 byte length of the canonical serialized table (the capped quantity). */
  readonly serializedBytes: number;
  readonly limitState: ResearchTableLimitState;
}

/**
 * Materializes the full bounded table through the store's keyset page reads
 * (≤100 rows per run by contract, so this terminates within two pages).
 */
export async function loadResearchRunTable(
  store: ResearchStore,
  accountId: string,
  runId: string
): Promise<ResearchRunTableView | undefined> {
  const run = await store.getResearchRun(accountId, runId);
  if (!run) return undefined;
  let after: { timestamp: string; id: string } | null = null;
  const rows: ResearchTableRowPageItem[] = [];
  let last: ResearchTablePage | undefined;
  for (;;) {
    const table = await store.getResearchTable(accountId, runId, { limit: 100, after });
    if (!table) throw new ResearchValidationError("research run table vanished mid-read");
    last = table;
    rows.push(...table.page.items);
    after = table.page.next;
    if (!after) break;
  }
  const serializedBytes = last!.serializedBytes;
  return Object.freeze({
    run,
    columns: last!.columns,
    rows: Object.freeze(rows),
    serializedBytes,
    limitState: researchTableLimitState(serializedBytes),
  });
}

/** Materializes every captured evidence row (≤100 by contract; pages ≤50). */
export async function loadResearchRunEvidence(
  store: ResearchStore,
  accountId: string,
  runId: string
): Promise<readonly StoredResearchEvidence[]> {
  let after: { timestamp: string; id: string } | null = null;
  const evidence: StoredResearchEvidence[] = [];
  for (;;) {
    const page = await store.listResearchEvidence(accountId, runId, { limit: 50, after });
    evidence.push(...page.items);
    after = page.next;
    if (!after) break;
  }
  return Object.freeze(evidence);
}

// ---------------------------------------------------------------------------
// Bounded page-local sort/filter over keyset rows
// ---------------------------------------------------------------------------

export type ResearchTableViewSortView = "effective" | "machine" | "correction";

export interface ResearchTableViewOptions {
  readonly sortColumnId?: string | null;
  readonly sortDir?: "asc" | "desc";
  readonly sortView?: ResearchTableViewSortView;
  readonly filterColumnId?: string | null;
  readonly filterStatus?: ResearchCellStatus | null;
  readonly filterText?: string | null;
}

export interface ResearchTableViewState {
  readonly sort_applied: boolean;
  readonly filter_applied: boolean;
  /** Honest ordering basis: the keyset cursor always rides the row identity. */
  readonly basis: "row_source_id_keyset";
  readonly sort_column_id: string | null;
  readonly sort_dir: "asc" | "desc";
  readonly sort_view: ResearchTableViewSortView;
}

export interface ResearchTablePageViewResult {
  readonly items: readonly ResearchTableRowPageItem[];
  readonly viewState: ResearchTableViewState;
}

/**
 * Validates the view options against the run's frozen column schema (a stale
 * column id is an honest validation failure, never a silent no-op) and
 * applies the bounded sort/filter to the returned keyset page. The cursor is
 * untouched: the page remains a window over the row-id keyset, so
 * `sort_applied`/`filter_applied` disclose that ordering is page-local.
 */
export function applyResearchTablePageView(
  items: readonly ResearchTableRowPageItem[],
  columns: readonly ResearchColumnDeclaration[],
  options: ResearchTableViewOptions
): ResearchTablePageViewResult {
  const sortColumnId = options.sortColumnId ?? null;
  const filterColumnId = options.filterColumnId ?? null;
  if (sortColumnId !== null && !columns.some((column) => column.id === sortColumnId)) {
    throw new ResearchValidationError("sort_column is not declared by the run's pinned revision");
  }
  if (filterColumnId !== null && !columns.some((column) => column.id === filterColumnId)) {
    throw new ResearchValidationError("filter_column is not declared by the run's pinned revision");
  }
  const filterText = options.filterText ?? null;
  if (filterText !== null && filterText.length > RESEARCH_TABLE_FILTER_TEXT_MAX_CHARS) {
    throw new ResearchValidationError(`filter_text exceeds ${RESEARCH_TABLE_FILTER_TEXT_MAX_CHARS} characters`);
  }
  const filterStatus = options.filterStatus ?? null;

  const filterApplied = filterColumnId !== null || filterStatus !== null || filterText !== null;
  let filtered = [...items];
  if (filterApplied) {
    filtered = filtered.filter((row) => rowMatchesFilter(row, filterColumnId, filterStatus, filterText));
  }

  const sortApplied = sortColumnId !== null;
  let sorted = filtered;
  if (sortApplied && sortColumnId !== null) {
    const dir = options.sortDir === "desc" ? -1 : 1;
    const view = options.sortView ?? "effective";
    const valueAt = (row: ResearchTableRowPageItem): ResearchTypedValue | undefined => {
      const triple = researchCellTriple(row.cells.filter((cell) => cell.columnId === sortColumnId));
      const cell = view === "machine" ? triple.machine : view === "correction" ? triple.correction : triple.effective;
      return cell ? cell.value : undefined;
    };
    sorted = [...filtered].sort((left, right) => {
      const leftValue = valueAt(left);
      const rightValue = valueAt(right);
      const leftMissing = leftValue === undefined || leftValue === null;
      const rightMissing = rightValue === undefined || rightValue === null;
      const tie = left.row_source_id < right.row_source_id ? 1 : left.row_source_id > right.row_source_id ? -1 : 0;
      if (leftMissing && rightMissing) return tie;
      // Nulls sort last in BOTH directions (never a direction-dependent
      // silent reordering of "no value").
      if (leftMissing) return 1;
      if (rightMissing) return -1;
      const order = compareSortValue(leftValue, rightValue);
      if (order !== 0) return order * dir;
      // Deterministic tie-break on the row identity (matches keyset order).
      return tie;
    });
  }

  return Object.freeze({
    items: Object.freeze(sorted),
    viewState: Object.freeze({
      sort_applied: sortApplied,
      filter_applied: filterApplied,
      basis: "row_source_id_keyset" as const,
      sort_column_id: sortColumnId,
      sort_dir: (options.sortDir === "desc" ? "desc" : "asc") as "asc" | "desc",
      sort_view: (options.sortView ?? "effective") as ResearchTableViewSortView,
    }),
  });
}

/**
 * A row is kept when the effective cell of the filtered column (or of any
 * column, when none is named) matches BOTH the asserted status and the
 * text predicate. The text predicate reads the effective value plus the
 * effective explanation; it never reaches into excerpt text.
 */
function rowMatchesFilter(
  row: ResearchTableRowPageItem,
  columnId: string | null,
  status: ResearchCellStatus | null,
  text: string | null
): boolean {
  const targetColumns = columnId === null ? row.cells.map((cell) => cell.columnId) : [columnId];
  for (const id of new Set(targetColumns)) {
    const triple = researchCellTriple(row.cells.filter((cell) => cell.columnId === id));
    if (columnId !== null && triple.effective === null && row.cells.some((cell) => cell.columnId === id) === false) {
      return false;
    }
    const effective = triple.effective;
    if (status !== null && effective?.status !== status) continue;
    if (text !== null) {
      const haystack =
        `${effective === null ? "" : researchDisplayValue(effective.value)}\n${effective?.explanation ?? ""}`.toLowerCase();
      if (!haystack.includes(text.toLowerCase())) continue;
    }
    return true;
  }
  return false;
}

/** Nulls sort last in both directions; types never coerce. */
function compareSortValue(left: ResearchTypedValue | undefined, right: ResearchTypedValue | undefined): number {
  const leftNull = left === undefined || left === null;
  const rightNull = right === undefined || right === null;
  if (leftNull && rightNull) return 0;
  if (leftNull) return 1;
  if (rightNull) return -1;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  const leftText = researchDisplayValue(left);
  const rightText = researchDisplayValue(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

/** Deterministic display rendering for one stored typed scalar. */
export function researchDisplayValue(value: ResearchTypedValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  return String(value);
}

// ---------------------------------------------------------------------------
// Changed-cell diff between run revisions
// ---------------------------------------------------------------------------

export interface ResearchCellChangeSnapshot {
  readonly value: ResearchTypedValue;
  readonly status: ResearchCellStatus;
}

export interface ResearchCellChangeSlot {
  readonly machine: ResearchCellChangeSnapshot | null;
  readonly correction: ResearchCellChangeSnapshot | null;
  readonly effective: ResearchCellChangeSnapshot | null;
}

export interface ResearchCellChange {
  readonly row_source_id: string;
  readonly column_id: string;
  readonly before: ResearchCellChangeSlot;
  readonly after: ResearchCellChangeSlot;
  readonly machine_changed: boolean;
  readonly correction_changed: boolean;
}

export interface ResearchRunTableDiff {
  readonly from_run_id: string;
  readonly to_run_id: string;
  readonly rows_added: readonly string[];
  readonly rows_removed: readonly string[];
  readonly changed_cells: readonly ResearchCellChange[];
  readonly changed_total: number;
  readonly truncated: boolean;
  /** Overlays in the target revision that were carried from the prior run. */
  readonly carried_overrides: ReadonlyArray<{
    column_id: string;
    row_source_id: string;
    corrected_from_run_id: string;
  }>;
}

function changeSnapshot(cell: StoredResearchCell | null): ResearchCellChangeSnapshot | null {
  if (cell === null) return null;
  return Object.freeze({ value: cell.value, status: cell.status });
}

function changeSlot(triple: ResearchCellTriple): ResearchCellChangeSlot {
  return Object.freeze({
    machine: changeSnapshot(triple.machine),
    correction: changeSnapshot(triple.correction),
    effective: changeSnapshot(triple.effective),
  });
}

function slotsEqual(left: ResearchCellChangeSnapshot | null, right: ResearchCellChangeSnapshot | null): boolean {
  if (left === null || right === null) return left === right;
  return left.status === right.status && JSON.stringify(left.value) === JSON.stringify(right.value);
}

const EMPTY_TRIPLE: ResearchCellTriple = Object.freeze({ machine: null, correction: null, effective: null });

/**
 * Deterministic changed-cell diff between two materialized revisions of the
 * same definition. Rows are keyed by source id (a generation bump is a rerun
 * fact, not a new row identity); cells are keyed by (column, row). A change
 * is reported when the effective, machine, or correction view differs, and
 * each change carries the original/extracted/corrected slots for BOTH sides,
 * so a carried user override is never mistaken for a new extraction.
 */
export function diffResearchRunTables(from: ResearchRunTableView, to: ResearchRunTableView): ResearchRunTableDiff {
  const fromRows = new Map(from.rows.map((row) => [row.row_source_id, row]));
  const toRows = new Map(to.rows.map((row) => [row.row_source_id, row]));
  const allRowIds = [...new Set([...fromRows.keys(), ...toRows.keys()])].sort().reverse();

  const columnIds = [...new Set([...from.columns.map((c) => c.id), ...to.columns.map((c) => c.id)])].sort();

  const rowsAdded = [...toRows.keys()]
    .filter((id) => !fromRows.has(id))
    .sort()
    .reverse();
  const rowsRemoved = [...fromRows.keys()]
    .filter((id) => !toRows.has(id))
    .sort()
    .reverse();

  const changed: ResearchCellChange[] = [];
  let changedTotal = 0;
  let truncated = false;
  const carried: Array<{ column_id: string; row_source_id: string; corrected_from_run_id: string }> = [];

  for (const rowSourceId of allRowIds) {
    const beforeRow = fromRows.get(rowSourceId);
    const afterRow = toRows.get(rowSourceId);
    for (const columnId of columnIds) {
      const before = beforeRow
        ? researchCellTriple(beforeRow.cells.filter((cell) => cell.columnId === columnId))
        : EMPTY_TRIPLE;
      const after = afterRow
        ? researchCellTriple(afterRow.cells.filter((cell) => cell.columnId === columnId))
        : EMPTY_TRIPLE;
      if (after.correction?.correctedFromRunId === from.run.id) {
        carried.push(
          Object.freeze({
            column_id: columnId,
            row_source_id: rowSourceId,
            corrected_from_run_id: from.run.id,
          })
        );
      }
      const beforeSlot = changeSlot(before);
      const afterSlot = changeSlot(after);
      const machineChanged = !slotsEqual(beforeSlot.machine, afterSlot.machine);
      const correctionChanged = !slotsEqual(beforeSlot.correction, afterSlot.correction);
      const effectiveChanged = !slotsEqual(beforeSlot.effective, afterSlot.effective);
      if (!machineChanged && !correctionChanged && !effectiveChanged) continue;
      changedTotal += 1;
      if (changed.length < RESEARCH_DIFF_CELLS_MAX) {
        changed.push(
          Object.freeze({
            row_source_id: rowSourceId,
            column_id: columnId,
            before: beforeSlot,
            after: afterSlot,
            machine_changed: machineChanged,
            correction_changed: correctionChanged,
          })
        );
      } else {
        truncated = true;
      }
    }
  }

  return Object.freeze({
    from_run_id: from.run.id,
    to_run_id: to.run.id,
    rows_added: Object.freeze(rowsAdded),
    rows_removed: Object.freeze(rowsRemoved),
    changed_cells: Object.freeze(changed),
    changed_total: changedTotal,
    truncated,
    carried_overrides: Object.freeze(carried),
  });
}

// ---------------------------------------------------------------------------
// CSV export (formula-safe, BOM, full bounded table, explicit limit state)
// ---------------------------------------------------------------------------

export const RESEARCH_CSV_HEADER = Object.freeze([
  "run_id",
  "run_status",
  "definition_id",
  "definition_revision",
  "row_source_id",
  "row_generation",
  "column_id",
  "column_label",
  "column_type",
  "column_unit",
  "origin",
  "value",
  "status",
  "evidence_ids",
  "explanation",
  "corrected_at",
  "corrected_from_run_id",
] as const);

/**
 * Mirrors the M12/web receipt CSV rules with the additional TAB/CR leading
 * guards: `null` renders as the literal `null` text, formula-leading strings
 * get an apostrophe prefix, and quote/comma/CR/LF require RFC quoting.
 */
export function researchCsvField(value: string | number | boolean | null): string {
  let text: string;
  if (value === null) {
    text = "null";
  } else if (typeof value === "string") {
    text = FORMULA_LEADING.test(value) || FORMULA_AFTER_WHITESPACE.test(value) ? `'${value}` : value;
  } else {
    text = String(value);
  }
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/**
 * Full stored table in long form: one line per (row, column, origin) so the
 * machine original and the correction overlay are both exported, never
 * merged away. `invalid` cells export their verbatim machine value with the
 * `invalid` status label; absent values are the literal `null`. The 1 MiB
 * limit state is rendered as an explicit comment line; the export itself is
 * never truncated (the stored table is already the bounded quantity).
 */
export function buildResearchComparisonCsv(view: ResearchRunTableView): string {
  const { run, columns, rows } = view;
  const comment = `# limit_state: serialized_bytes=${view.limitState.serialized_bytes},limit_bytes=${view.limitState.limit_bytes},at_limit=${view.limitState.at_limit}`;
  const lines: string[] = [comment, RESEARCH_CSV_HEADER.map((field) => researchCsvField(field)).join(",")];
  for (const row of rows) {
    for (const column of columns) {
      const triple = researchCellTriple(row.cells.filter((cell) => cell.columnId === column.id));
      for (const cell of [triple.machine, triple.correction]) {
        if (cell === null) continue;
        lines.push(
          [
            researchCsvField(run.id),
            researchCsvField(run.status),
            researchCsvField(run.definitionId),
            run.definitionRevision,
            researchCsvField(row.row_source_id),
            row.row_generation,
            researchCsvField(column.id),
            researchCsvField(column.label),
            researchCsvField(column.type),
            column.unit === null ? "" : researchCsvField(column.unit),
            researchCsvField(cell.origin),
            cell.value === null ? "null" : researchCsvField(cell.value),
            researchCsvField(cell.status),
            researchCsvField(cell.evidenceRefs.join(",")),
            cell.explanation === null ? "" : researchCsvField(cell.explanation),
            cell.correctedAt === null ? "" : researchCsvField(cell.correctedAt),
            cell.correctedFromRunId === null ? "" : researchCsvField(cell.correctedFromRunId),
          ].join(",")
        );
      }
    }
  }
  return `${UTF8_BOM}${lines.join(CSV_LINE)}${CSV_LINE}`;
}

/** Deterministic ASCII-safe download stem, mirroring the M12 rules. */
export function researchExportFilename(title: string, runId: string, format: "csv" | "manifest"): string {
  const stem = title
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 64)
    .toLowerCase();
  const extension = format === "manifest" ? "json" : format;
  const suffix = format === "manifest" ? "-manifest" : "";
  return `${stem || "research"}-${runId.slice(0, 8)}${suffix}.${extension}`;
}

// ---------------------------------------------------------------------------
// JSON evidence/locator manifest
// ---------------------------------------------------------------------------

export interface ResearchRunManifest {
  readonly artifact: "research_run_export_manifest";
  readonly run: Record<string, unknown>;
  readonly limits: Record<string, unknown>;
  readonly columns: readonly Record<string, unknown>[];
  readonly rows: readonly Record<string, unknown>[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly cells: readonly Record<string, unknown>[];
}

/**
 * Companion manifest for the CSV: stable evidence ids with source/generation,
 * sanitized labels, the typed M14 locators verbatim, content hashes, full
 * cell bindings including correction provenance (`corrected_at`,
 * `corrected_from_run_id`), and the exact run/revision identity plus limit
 * and budget states. Zero rows/zero cells are a valid, complete manifest —
 * never a failure and never a silently dropped section.
 */
export function buildResearchRunManifest(
  view: ResearchRunTableView,
  evidence: readonly StoredResearchEvidence[]
): ResearchRunManifest {
  const { run, columns, rows, serializedBytes, limitState } = view;
  return Object.freeze({
    artifact: "research_run_export_manifest" as const,
    run: {
      id: run.id,
      definition_id: run.definitionId,
      definition_revision: run.definitionRevision,
      status: run.status,
      cancel_requested: run.cancelRequested,
      review_revision: run.reviewRevision,
      chat_model: run.chatModel,
      provider_locality: run.providerLocality,
      rerun_of: run.rerunOf,
      rerun_selection: run.rerunSelection,
      sources: run.sources.map((source) => ({ source_id: source.sourceId, generation: source.generation })),
      budgets: {
        steps: run.budgets.steps,
        searches: run.budgets.searches,
        model_requests: run.budgets.modelRequests,
        evidence: run.budgets.evidence,
        evidence_chars: run.budgets.evidenceChars,
        wall_ms: run.budgets.wallMs,
      },
      usage: { searches: run.searchesUsed, model_requests: run.modelRequestsUsed },
      error_code: run.errorCode,
      created_at: run.createdAt,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
    },
    limits: {
      table: {
        serialized_bytes: serializedBytes,
        limit_bytes: RESEARCH_TABLE_SERIALIZED_MAX_BYTES,
        at_limit: limitState.at_limit,
        truncated: false,
      },
      evidence_count_at_cap: evidence.length >= run.budgets.evidence,
      evidence_chars: evidence.reduce((total, item) => total + item.excerpt.length, 0),
      evidence_chars_limit: run.budgets.evidenceChars,
      // The export renders the full stored (already bounded) table; nothing
      // on this path truncates. These flags disclose how close it is.
      export_truncated: false,
    },
    columns: columns.map((column) => ({
      id: column.id,
      label: column.label,
      question: column.question,
      type: column.type,
      unit: column.unit,
      choices: column.choices,
    })),
    rows: rows.map((row) => ({ row_source_id: row.row_source_id, row_generation: row.row_generation })),
    evidence: evidence.map((item) => ({
      id: item.id,
      source_id: item.sourceId,
      generation: item.generation,
      chunk_id: item.chunkId,
      label: item.label,
      locators: item.locators,
      excerpt: item.excerpt,
      content_hash: item.contentHash,
      retrieved_at: item.retrievedAt,
      step_ordinal: item.stepOrdinal,
      query: item.query,
      irrelevant: item.irrelevant,
    })),
    cells: rows.flatMap((row) =>
      columns.flatMap((column) => {
        const triple = researchCellTriple(row.cells.filter((cell) => cell.columnId === column.id));
        return [triple.machine, triple.correction].flatMap((cell) =>
          cell === null
            ? []
            : [
                {
                  run_id: run.id,
                  column_id: column.id,
                  row_source_id: row.row_source_id,
                  row_generation: row.row_generation,
                  origin: cell.origin,
                  value: cell.value,
                  status: cell.status,
                  evidence_refs: cell.evidenceRefs,
                  explanation: cell.explanation,
                  corrected_at: cell.correctedAt,
                  corrected_from_run_id: cell.correctedFromRunId,
                },
              ]
        );
      })
    ),
  });
}

// ---------------------------------------------------------------------------
// M13 artifact projection
// ---------------------------------------------------------------------------

interface ProjectionTier {
  readonly rows: number;
  readonly cellChars: number;
  readonly excerptChars: number;
  readonly claimMarkdown: number;
}

/**
 * Deterministic shrinking tiers. The projection only ever trims through this
 * ladder, and every trim is labeled (cell `…[truncated]`, excerpt
 * `[shortened]`, omitted rows/columns/claims listed explicitly), so a saved
 * document is always a disclosed preview of the full dossier — never a
 * silent mutation of it.
 */
const PROJECTION_TIERS: readonly ProjectionTier[] = Object.freeze([
  {
    rows: DOCUMENT_TABLE_ROWS_MAX,
    cellChars: DOCUMENT_TABLE_CELL_MAX_CHARS,
    excerptChars: DOCUMENT_EVIDENCE_EXCERPT_MAX_CHARS,
    claimMarkdown: 150_000,
  },
  { rows: DOCUMENT_TABLE_ROWS_MAX, cellChars: 300, excerptChars: 600, claimMarkdown: 150_000 },
  { rows: 50, cellChars: 200, excerptChars: 400, claimMarkdown: 120_000 },
  { rows: 40, cellChars: 120, excerptChars: 240, claimMarkdown: 100_000 },
  { rows: 30, cellChars: 80, excerptChars: 160, claimMarkdown: 80_000 },
  { rows: 20, cellChars: 40, excerptChars: 80, claimMarkdown: 60_000 },
  { rows: 10, cellChars: 40, excerptChars: 40, claimMarkdown: 40_000 },
]);

/** Total section Markdown plus the compiled appendix stays under this. */
const SECTION_MARKDOWN_RESERVE = 10_000;
const SECTION_CHUNK_MAX_CHARS = 45_000;

export interface ResearchProjectionCounts {
  readonly evidence: number;
  readonly rows: number;
  readonly columns: number;
  readonly cells: number;
  readonly claims: number;
  readonly gaps: number;
}

export interface ResearchProjectionSummary {
  readonly output_kind: "memo" | "comparison";
  readonly run_status: StoredResearchRun["status"];
  readonly cell_chars_max: number;
  readonly excerpt_chars_max: number;
  readonly payload_chars: number;
  readonly projected: ResearchProjectionCounts;
  readonly omitted: {
    readonly rows: readonly string[];
    readonly columns: ReadonlyArray<{ id: string; label: string }>;
    readonly claims: number;
    readonly gaps: number;
    readonly evidence: number;
  };
  readonly labels: readonly string[];
  readonly disclosures: {
    readonly needs_review: boolean;
    readonly conflicting_cells: number;
    readonly invalid_cells: number;
    readonly not_found_cells: number;
    readonly correction_cells: number;
    readonly excerpts_shortened: number;
    readonly cells_truncated: number;
    readonly table_at_limit: boolean;
  };
}

export interface ResearchArtifactProjection {
  readonly title: string;
  readonly subtitle: string;
  readonly tree: DocumentTreeInput;
  readonly projection: ResearchProjectionSummary;
}

export interface ResearchArtifactProjectionInput {
  readonly run: StoredResearchRun;
  readonly revision: StoredResearchRevision;
  readonly claims: readonly StoredResearchClaim[];
  readonly evidence: readonly StoredResearchEvidence[];
  readonly rows: readonly ResearchTableRowPageItem[];
  readonly serializedBytes: number;
  /** Optional display names for row sources; absent rows keep captured labels. */
  readonly sourceNames?: ReadonlyMap<string, string>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic ≤500-char display text for the M14 typed locators. */
export function formatResearchLocator(locators: readonly ChunkLocator[]): string | null {
  const parts: string[] = [];
  for (const locator of locators) {
    if (locator.kind === "pdf_page") {
      parts.push(
        `pdf page ${locator.page}${locator.ocr ? " (OCR)" : ""} · chars ${locator.char_start}+${locator.char_len}`
      );
    } else if (locator.kind === "text_span") {
      const heading = locator.heading === undefined ? "" : ` · heading "${locator.heading}"`;
      parts.push(`text span · chars ${locator.char_start}+${locator.char_len}${heading}`);
    } else {
      const sheet = locator.sheet === undefined ? "" : `sheet "${locator.sheet}" · `;
      const rows =
        locator.row_start === undefined || locator.row_end === undefined
          ? "rows unknown"
          : `rows ${locator.row_start}-${locator.row_end}`;
      parts.push(`tabular ${sheet}${rows}`);
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join(" | ");
  return joined.length <= 500 ? joined : `${joined.slice(0, 486)}…[truncated]`;
}

function shortenExcerpt(excerpt: string, budget: number): { text: string; shortened: boolean } {
  if (excerpt.length <= budget) return { text: excerpt, shortened: false };
  const content = Math.max(1, budget - RESEARCH_EXCERPT_SHORTEN_LABEL.length);
  return {
    text: `${excerpt.slice(0, content)}${RESEARCH_EXCERPT_SHORTEN_LABEL}`.slice(0, budget),
    shortened: true,
  };
}

/**
 * Honest cell text for the projected document table. A correction is always
 * labeled `(corrected)` over the extracted value; `conflicting` and `invalid`
 * states stay visible instead of being flattened into a single "fact"; a
 * never-extracted cell stays empty. Truncation is explicit.
 */
export function researchCellDisplayText(
  cells: readonly StoredResearchCell[],
  cellBudget: number
): { text: string; truncated: boolean } {
  const triple = researchCellTriple(cells);
  let text: string;
  if (triple.correction !== null) {
    const base = triple.correction.value === null ? "(cleared)" : researchDisplayValue(triple.correction.value);
    const suffix = triple.correction.status === "invalid" ? " (corrected, invalid)" : " (corrected)";
    text = `${base}${suffix}`;
  } else if (triple.machine === null) {
    text = "";
  } else {
    switch (triple.machine.status) {
      case "supported":
        text = researchDisplayValue(triple.machine.value);
        break;
      case "not_found":
        text = "not found";
        break;
      case "conflicting":
        text =
          triple.machine.value === null ? "conflicting" : `${researchDisplayValue(triple.machine.value)} (conflicting)`;
        break;
      case "invalid":
        text = `${researchDisplayValue(triple.machine.value)} (invalid machine output)`;
        break;
    }
  }
  if (text.length <= cellBudget) return { text, truncated: false };
  const content = Math.max(1, cellBudget - RESEARCH_CELL_TRUNCATE_LABEL.length);
  return { text: `${text.slice(0, content)}${RESEARCH_CELL_TRUNCATE_LABEL}`.slice(0, cellBudget), truncated: true };
}

function columnHeader(column: ResearchColumnDeclaration): string {
  const header = column.unit === null ? column.label : `${column.label} (${column.unit})`;
  return header.length <= 200 ? header : `${header.slice(0, 199)}…`;
}

function projectionTitle(revision: StoredResearchRevision): string {
  return revision.title.slice(0, 200);
}

function projectionSubtitle(run: StoredResearchRun): string {
  const lineage = run.rerunOf === null ? "" : ` · rerun of ${run.rerunOf}`;
  const selection =
    run.rerunSelection === null
      ? ""
      : ` · rerun scope ${run.rerunSelection.row_source_ids.length} rows / ${run.rerunSelection.column_ids.length} columns`;
  return `Research run ${run.id} · ${run.status}${lineage}${selection} · projected from the durable dossier`.slice(
    0,
    500
  );
}

/**
 * Builds the M13 reviewed-DRAFT projection for one finished run. Memo output
 * becomes narrative sections whose `[n]` markers address the revision's own
 * evidence array (the M13 numbering convention); comparison output becomes a
 * single analysis-backed table envelope whose provenance identifies the
 * research run and its pinned source generations. The result is the loose
 * `DocumentTreeInput` plus an explicit projection summary of what was
 * included, omitted, shortened, and disclosed. The final tree is normalized
 * here so an over-budget projection fails closed instead of persisting.
 */
export function buildResearchArtifactProjection(input: ResearchArtifactProjectionInput): ResearchArtifactProjection {
  let lastError: DocumentValidationError | null = null;
  for (const tier of PROJECTION_TIERS) {
    try {
      return buildAtTier(input, tier);
    } catch (error) {
      if (error instanceof DocumentValidationError && error.code === "DOCUMENT_OVERSIZE") {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw new ResearchValidationError(
    `research output cannot fit the M13 projection budget (${lastError?.message ?? "oversize"})`
  );
}

function buildAtTier(input: ResearchArtifactProjectionInput, tier: ProjectionTier): ResearchArtifactProjection {
  const { run, revision, claims, evidence, rows, serializedBytes } = input;
  const labels: string[] = [];

  // -- Evidence projection (stable ids and hashes preserved) -------------------
  const projectedEvidence: DocumentEvidenceRef[] = [];
  let excerptsShortened = 0;
  let evidenceOmitted = 0;
  for (const item of evidence.slice(0, DOCUMENT_EVIDENCE_MAX_REFS)) {
    const shortened = shortenExcerpt(item.excerpt, tier.excerptChars);
    if (shortened.shortened) excerptsShortened += 1;
    projectedEvidence.push({
      id: item.id,
      source_id: item.sourceId,
      source_name: item.label,
      generation: item.generation,
      content_identity: item.contentHash,
      locator: formatResearchLocator(item.locators),
      excerpt: shortened.text,
    });
  }
  if (evidence.length > DOCUMENT_EVIDENCE_MAX_REFS) {
    evidenceOmitted = evidence.length - DOCUMENT_EVIDENCE_MAX_REFS;
    labels.push(
      `${evidenceOmitted} evidence entries exceeded the ${DOCUMENT_EVIDENCE_MAX_REFS}-reference document cap and were omitted from this projection`
    );
  }
  if (excerptsShortened > 0) {
    labels.push(
      `${excerptsShortened} evidence excerpts were shortened to ${tier.excerptChars} characters and labeled; their stable ids and content hashes are preserved (the CSV/JSON export carries the full excerpts)`
    );
  }
  const evidenceIndex = new Map(projectedEvidence.map((entry, index) => [entry.id, index + 1] as const));
  const appendixChars = buildEvidenceAppendix(projectedEvidence).length;

  // -- Comparison table projection ----------------------------------------------
  const isComparison = revision.outputKind === "comparison";
  const columnLimit = Math.min(revision.columns.length, DOCUMENT_TABLE_COLUMNS_MAX - 1);
  const projectedColumns = revision.columns.slice(0, Math.max(0, columnLimit));
  const omittedColumns = revision.columns
    .slice(Math.max(0, columnLimit))
    .map((column) => ({ id: column.id, label: column.label }));
  if (omittedColumns.length > 0) {
    labels.push(
      `${omittedColumns.length} column(s) exceeded the ${DOCUMENT_TABLE_COLUMNS_MAX}-column document cap and were omitted`
    );
  }

  const columnCap = Math.max(1, projectedColumns.length + 1);
  const rowLimit = Math.min(
    rows.length,
    DOCUMENT_TABLE_ROWS_MAX,
    Math.floor(RESEARCH_ARTIFACT_TABLE_CELLS_MAX / columnCap)
  );
  const projectedRowsInput = rows.slice(0, rowLimit);
  const omittedRows = rows.slice(rowLimit).map((row) => row.row_source_id);
  if (omittedRows.length > 0) {
    labels.push(
      `${omittedRows.length} row(s) exceeded the ${DOCUMENT_TABLE_ROWS_MAX}-row / ${RESEARCH_ARTIFACT_TABLE_CELLS_MAX}-cell document projection and were omitted`
    );
  }

  let cellsTruncated = 0;
  let notFoundCells = 0;
  let conflictingCells = 0;
  let invalidCells = 0;
  let correctionCells = 0;
  let cellCount = 0;
  const rowLabelById = rowLabels(rows, evidence, input.sourceNames);
  const tableRows: (readonly (string | number | boolean | null)[])[] = [];
  for (const row of projectedRowsInput) {
    const cells: (string | number | boolean | null)[] = [rowLabelById.get(row.row_source_id) ?? row.row_source_id];
    for (const column of projectedColumns) {
      const slotCells = row.cells.filter((cell) => cell.columnId === column.id);
      const triple = researchCellTriple(slotCells);
      if (triple.effective !== null) {
        cellCount += 1;
        if (triple.correction !== null) correctionCells += 1;
        const status = triple.effective.status;
        if (status === "not_found") notFoundCells += 1;
        else if (status === "conflicting") conflictingCells += 1;
        else if (status === "invalid") invalidCells += 1;
      }
      const display = researchCellDisplayText(slotCells, tier.cellChars);
      if (display.truncated) cellsTruncated += 1;
      cells.push(display.text);
    }
    tableRows.push(cells);
  }

  const reasons: string[] = [];
  if (omittedRows.length > 0) reasons.push(`rows_omitted:${omittedRows.length}`);
  if (omittedColumns.length > 0) reasons.push(`columns_omitted:${omittedColumns.length}`);
  if (cellsTruncated > 0) reasons.push(`cell_previews_truncated:${cellsTruncated}`);
  if (excerptsShortened > 0) reasons.push(`evidence_excerpts_shortened:${excerptsShortened}`);
  if (run.status === "needs_review") reasons.push("run_needs_review");
  if (researchTableLimitState(serializedBytes).at_limit) reasons.push("table_serialized_limit_reached");

  const tableAnalysis: DocumentTableAnalysis = {
    analysis_id: run.definitionId,
    analysis_revision: run.definitionRevision,
    result_id: run.id,
    parameters: [
      { name: "research_run_id", type: "string", value: run.id },
      { name: "research_run_status", type: "string", value: run.status },
      { name: "rerun_of", type: "string", value: run.rerunOf },
    ],
    source_generations: run.sources.map((source) => ({
      source_id: source.sourceId,
      ready_generation: source.generation,
      // Research pins generations at Start but does not byte-verify source
      // content; the identity is the immutable run binding itself.
      content_identity: `research-run:${run.id}`,
    })),
    columns: [
      { name: "Document", type: "string" },
      ...projectedColumns.map((column) => ({
        name: columnHeader(column),
        type: analysisColumnKind(column.type),
      })),
    ],
    completeness: {
      complete:
        omittedRows.length === 0 &&
        omittedColumns.length === 0 &&
        cellsTruncated === 0 &&
        excerptsShortened === 0 &&
        run.status === "completed",
      reasons,
    },
    schema_fingerprint: sha256(
      revision.columns.map((column) => `${column.id}:${column.type}:${column.unit ?? ""}`).join("|")
    ),
  };

  // -- Sections -----------------------------------------------------------------
  const sections: { heading: string; markdown: string }[] = [];
  const questionLines = [
    revision.question,
    "",
    `Definition revision: ${run.definitionRevision}. Run: \`${run.id}\` (${run.status}).`,
    `Chat model: ${run.chatModel}; provider locality: ${run.providerLocality}.`,
    run.rerunOf === null ? "Original run (no rerun lineage)." : `Rerun of \`${run.rerunOf}\`.`,
  ];
  if (run.status === "needs_review") {
    questionLines.push(
      "",
      "**Run state:** `needs_review` — computation finished with disclosed gaps; this is not labeled exhaustive."
    );
  }
  pushSections(sections, "Research question", questionLines.join("\n"));

  const includedClaims = claims.filter((claim) => claim.kind === "claim" && claim.reviewState !== "rejected");
  const rejectedClaims = claims.filter((claim) => claim.kind === "claim" && claim.reviewState === "rejected");
  const gapClaims = claims.filter((claim) => claim.kind === "gap");
  const excludedClaims = claims.length - includedClaims.length - gapClaims.length - rejectedClaims.length;

  const claimLine = (claim: StoredResearchClaim): string => {
    const text = claim.correctedText ?? claim.text;
    const markers = claim.evidenceRefs
      .map((ref) => evidenceIndex.get(ref))
      .filter((position): position is number => position !== undefined)
      .map((position) => `[${position}]`)
      .join("");
    const unresolved = claim.evidenceRefs.filter((ref) => !evidenceIndex.has(ref)).length;
    const note = unresolved > 0 ? " (some references had no captured evidence)" : "";
    const corrected = claim.correctedText !== null ? " *(user correction)*" : "";
    return `- ${text}${markers}${corrected}${note}`;
  };

  let claimsOmitted = 0;
  if (!isComparison) {
    const groups: { heading: string; items: readonly StoredResearchClaim[] }[] = [
      { heading: "Findings", items: includedClaims.filter((claim) => claim.classification === "supported") },
      {
        heading: "Conflicting claims",
        items: includedClaims.filter((claim) => claim.classification === "conflicting"),
      },
      {
        heading: "Unsupported claims",
        items: includedClaims.filter((claim) => claim.classification === "unsupported"),
      },
    ];
    const sectionBudget = Math.max(
      2_000,
      Math.min(tier.claimMarkdown, DOCUMENT_MARKDOWN_TOTAL_MAX_CHARS - appendixChars - SECTION_MARKDOWN_RESERVE)
    );
    let used = sections.reduce((total, section) => total + section.markdown.length, 0);
    for (const group of groups) {
      const lines: string[] = [];
      let groupOmitted = 0;
      for (const claim of group.items) {
        const line = claimLine(claim);
        if (used + lines.join("\n").length + line.length + 1 > sectionBudget) {
          groupOmitted += 1;
          continue;
        }
        lines.push(line);
      }
      if (lines.length === 0 && group.items.length > 0) {
        claimsOmitted += group.items.length;
        continue;
      }
      if (groupOmitted > 0) {
        lines.push(`*(${groupOmitted} further ${group.heading.toLowerCase()} omitted from this projection)*`);
        claimsOmitted += groupOmitted;
      }
      used += lines.join("\n").length;
      pushSections(sections, group.heading, lines.join("\n"));
    }
  }

  let gapsOmitted = 0;
  {
    const gapLines = gapClaims.map(
      (claim) => `- ${claim.text}${claim.correctedText === null ? "" : " *(user correction)*"}`
    );
    const kept: string[] = [];
    const usedSoFar = sections.reduce((total, section) => total + section.markdown.length, 0);
    const gapBudget = Math.max(
      1_000,
      Math.min(tier.claimMarkdown, DOCUMENT_MARKDOWN_TOTAL_MAX_CHARS - appendixChars - SECTION_MARKDOWN_RESERVE) -
        usedSoFar
    );
    for (const line of gapLines) {
      if (kept.join("\n").length + line.length + 1 > gapBudget) {
        gapsOmitted += 1;
        continue;
      }
      kept.push(line);
    }
    if (kept.length > 0) pushSections(sections, "Gaps and not-found", kept.join("\n"));
    if (gapsOmitted > 0) {
      labels.push(`${gapsOmitted} gap disclosure(s) exceeded the document Markdown budget and were omitted`);
    }
  }

  // -- Disclosures section (always present) --------------------------------------
  const disclosureLines: string[] = [];
  if (isComparison) {
    disclosureLines.push(
      `Comparison projection: ${tableRows.length} row(s) × ${columnCap} column(s); ${cellCount} extracted/corrected cell(s).`
    );
    disclosureLines.push(
      `Disclosed states — conflicting: ${conflictingCells}; invalid machine outputs: ${invalidCells}; not found: ${notFoundCells}; user corrections: ${correctionCells}. Conflicting cells keep both excerpts in the review surface and the JSON manifest.`
    );
    disclosureLines.push(
      "Cells shown blank were never extracted (partial run); `not found` means not found in selected evidence, never proof a fact does not exist."
    );
  }
  if (rejectedClaims.length > 0)
    disclosureLines.push(`${rejectedClaims.length} user-rejected claim(s) excluded from this projection.`);
  if (excludedClaims > 0)
    disclosureLines.push(`${excludedClaims} claim(s) excluded (no captured evidence); see the review surface.`);
  for (const label of labels) disclosureLines.push(`Projection limit: ${label}.`);
  const limitState = researchTableLimitState(serializedBytes);
  disclosureLines.push(
    `Full comparison table: ${limitState.serialized_bytes} serialized bytes of the ${limitState.limit_bytes}-byte cap${limitState.at_limit ? " (at limit)" : ""}; the CSV/JSON export carries the complete bounded table.`
  );
  pushSections(sections, "Disclosures and projection limits", disclosureLines.join("\n"));

  const tree: DocumentTreeInput = {
    title: projectionTitle(revision),
    subtitle: projectionSubtitle(run),
    verified: true,
    sections,
    charts: [],
    tables: isComparison
      ? [
          {
            columns: ["Document", ...projectedColumns.map(columnHeader)],
            rows: tableRows,
            analysis: tableAnalysis,
          },
        ]
      : [],
    evidence: projectedEvidence,
  };

  const normalized = normalizeDocumentTree(tree);
  const projectedCounts: ResearchProjectionCounts = {
    evidence: projectedEvidence.length,
    rows: tableRows.length,
    columns: isComparison ? columnCap : 0,
    cells: cellCount,
    claims: includedClaims.length - claimsOmitted,
    gaps: gapClaims.length - gapsOmitted,
  };

  return {
    title: normalized.tree.title,
    subtitle: normalized.tree.subtitle,
    tree,
    projection: Object.freeze({
      output_kind: revision.outputKind,
      run_status: run.status,
      cell_chars_max: tier.cellChars,
      excerpt_chars_max: tier.excerptChars,
      payload_chars: normalized.serialized.length,
      projected: Object.freeze(projectedCounts),
      omitted: Object.freeze({
        rows: Object.freeze(omittedRows),
        columns: Object.freeze(omittedColumns),
        claims: claimsOmitted,
        gaps: gapsOmitted,
        evidence: evidenceOmitted,
      }),
      labels: Object.freeze(labels),
      disclosures: Object.freeze({
        needs_review: run.status === "needs_review",
        conflicting_cells: conflictingCells,
        invalid_cells: invalidCells,
        not_found_cells: notFoundCells,
        correction_cells: correctionCells,
        excerpts_shortened: excerptsShortened,
        cells_truncated: cellsTruncated,
        table_at_limit: limitState.at_limit,
      }),
    }),
  };
}

/**
 * Deterministic analysis-envelope column kind. Research `date`/`enum`/`text`
 * all project as string cells; `number`/`boolean` keep their kinds.
 */
function analysisColumnKind(type: ResearchColumnDeclaration["type"]): DocumentTableAnalysis["columns"][number]["type"] {
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  return "string";
}

function rowLabels(
  rows: readonly ResearchTableRowPageItem[],
  evidence: readonly StoredResearchEvidence[],
  sourceNames?: ReadonlyMap<string, string>
): Map<string, string> {
  const labelBySource = new Map<string, string>();
  for (const item of evidence) {
    if (!labelBySource.has(item.sourceId)) labelBySource.set(item.sourceId, item.label);
  }
  const out = new Map<string, string>();
  for (const row of rows) {
    out.set(
      row.row_source_id,
      sourceNames?.get(row.row_source_id) ??
        labelBySource.get(row.row_source_id) ??
        `document ${row.row_source_id.slice(0, 8)}`
    );
  }
  return out;
}

/** Appends one bounded Markdown section, chunking over the 50k section cap. */
function pushSections(sections: { heading: string; markdown: string }[], heading: string, markdown: string): void {
  if (markdown.length === 0) return;
  if (markdown.length <= SECTION_CHUNK_MAX_CHARS) {
    sections.push({ heading, markdown });
    return;
  }
  let part = 1;
  let rest = markdown;
  while (rest.length > 0 && sections.length < 20) {
    const chunk = rest.slice(0, SECTION_CHUNK_MAX_CHARS);
    rest = rest.slice(SECTION_CHUNK_MAX_CHARS);
    sections.push({ heading: `${heading} (part ${part})`, markdown: chunk });
    part += 1;
  }
}
