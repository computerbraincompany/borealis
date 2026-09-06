/**
 * Deterministic, bounded revision diff for editable documents (M13 stage 2).
 *
 * The diff is a pure function of two frozen revision trees: the same pair
 * always produces byte-identical output, so the client can cache and display
 * it without ordering or timing effects. Structure is diffed by the stable
 * document-local section/block UUIDs (never array offsets): sections are
 * classified added/removed/moved (LCS over the surviving-id order) and
 * modified. Modified sections get a line-level unified-style text diff
 * (Myers greedy with an explicit edit-distance cap) computed only within one
 * section's text. Everything beyond the caps is reported through `truncated`
 * flags — never silently dropped — and coarse fallbacks stay bounded, so the
 * response size is bounded regardless of revision size.
 */

import type { DocumentTree } from "./documentTypes.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Text ops emitted for one section before the section diff is truncated. */
export const DOCUMENT_DIFF_MAX_SECTION_OPS = 240;
/** Total characters of op text carried across all section diffs. */
export const DOCUMENT_DIFF_MAX_TOTAL_TEXT_CHARS = 48_000;
/** Maximum Myers edit distance before the coarse bounded fallback. */
export const DOCUMENT_DIFF_MAX_EDIT_DISTANCE = 2_000;
/** Lines beyond which a section never runs the full line diff. */
export const DOCUMENT_DIFF_MAX_SECTION_LINES = 2_000;
/** Equal lines kept on each side of a changed run. */
export const DOCUMENT_DIFF_CONTEXT_LINES = 3;

// ---------------------------------------------------------------------------
// Output shapes (JSON-safe, deterministic ordering)
// ---------------------------------------------------------------------------

export interface DocumentRevisionRef {
  readonly revision_id: string;
  readonly revision: number;
  readonly title: string;
}

export interface DocumentDiffSectionRef {
  readonly id: string;
  readonly heading: string;
  readonly index: number;
}

export interface DocumentDiffMovedSection {
  readonly id: string;
  readonly heading: string;
  readonly base_index: number;
  readonly target_index: number;
}

export type DocumentDiffOpKind = "equal" | "insert" | "delete";

export interface DocumentDiffOp {
  readonly kind: DocumentDiffOpKind;
  /** 1-based line number in the base text (null for inserts). */
  readonly old_line: number | null;
  /** 1-based line number in the target text (null for deletes). */
  readonly new_line: number | null;
  readonly text: string;
}

export interface DocumentSectionTextDiff {
  readonly section_id: string;
  readonly heading: string;
  readonly ops: readonly DocumentDiffOp[];
  readonly truncated: boolean;
}

export interface DocumentDiffEvidenceRef {
  readonly id: string;
  readonly source_name: string;
}

export interface DocumentDiffTableSummary {
  readonly index: number;
  readonly columns: readonly string[];
}

export interface DocumentRevisionDiff {
  readonly base: DocumentRevisionRef;
  readonly target: DocumentRevisionRef;
  readonly fields: {
    readonly title_changed: boolean;
    readonly subtitle_changed: boolean;
    readonly verified_changed: boolean;
  };
  readonly sections: {
    readonly added: readonly DocumentDiffSectionRef[];
    readonly removed: readonly DocumentDiffSectionRef[];
    readonly moved: readonly DocumentDiffMovedSection[];
    readonly modified: readonly DocumentDiffSectionRef[];
  };
  /** Text diffs in target document order; removed sections in base order. */
  readonly text_diffs: readonly DocumentSectionTextDiff[];
  readonly charts: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  readonly tables: {
    readonly added: readonly DocumentDiffTableSummary[];
    readonly removed: readonly DocumentDiffTableSummary[];
    readonly changed: readonly number[];
  };
  readonly evidence: {
    readonly added: readonly DocumentDiffEvidenceRef[];
    readonly removed: readonly DocumentDiffEvidenceRef[];
    readonly changed: readonly string[];
  };
  /** True when any per-section or aggregate bound trimmed the output. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

type EditOp = { kind: DocumentDiffOpKind; oldIndex: number; newIndex: number };

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

/**
 * Myers greedy edit script with an explicit D cap. Returns null when the edit
 * distance exceeds the cap or the section is larger than the line bound, so
 * callers fall back to the bounded coarse diff. Deterministic: ties follow the
 * greedy insertion-before-deletion convention with no randomness.
 */
function myersScript(a: readonly string[], b: readonly string[]): EditOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n > DOCUMENT_DIFF_MAX_SECTION_LINES || m > DOCUMENT_DIFF_MAX_SECTION_LINES) return null;
  const max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, DOCUMENT_DIFF_MAX_EDIT_DISTANCE);
  const offset = limit;
  const size = 2 * limit + 1;
  // trace[d] is the V vector that round d is computed from (V_{d-1}); the
  // final completed round is additionally appended at index finalD + 1.
  const trace: Int32Array[] = [];
  let v = new Int32Array(size).fill(-1);
  v[offset + 1] = 0;
  let finalD = -1;
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v);
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        finalD = d;
        break;
      }
    }
    if (finalD >= 0) {
      trace.push(next);
      break;
    }
    v = next;
  }
  if (finalD < 0) return null;
  // Backtrack round by round: the endpoint of round d lies on V_d, and the
  // preceding extreme comes from trace[d] = V_{d-1}.
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = finalD; d >= 1; d -= 1) {
    const vPrev = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal", oldIndex: x - 1, newIndex: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: "insert", oldIndex: -1, newIndex: prevY });
    } else {
      ops.push({ kind: "delete", oldIndex: prevX, newIndex: -1 });
    }
    x = prevX;
    y = prevY;
  }
  // Round 0 leaves only the initial diagonal snake back to the origin.
  while (x > 0 && y > 0) {
    ops.push({ kind: "equal", oldIndex: x - 1, newIndex: y - 1 });
    x -= 1;
    y -= 1;
  }
  ops.reverse();
  return ops;
}

/** Bounded prefix/suffix common-run fallback when the line diff is skipped. */
function coarseOps(a: readonly string[], b: readonly string[]): EditOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const ops: EditOp[] = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ kind: "equal", oldIndex: i, newIndex: i });
  for (let i = prefix; i < a.length - suffix; i += 1) ops.push({ kind: "delete", oldIndex: i, newIndex: -1 });
  for (let i = prefix; i < b.length - suffix; i += 1) ops.push({ kind: "insert", oldIndex: -1, newIndex: i });
  for (let i = 0; i < suffix; i += 1) {
    ops.push({ kind: "equal", oldIndex: a.length - suffix + i, newIndex: b.length - suffix + i });
  }
  return ops;
}

/** Collapse long equal runs into bounded context around changed lines. */
function withContext(ops: readonly EditOp[]): EditOp[] {
  if (ops.length === 0) return [];
  const changed = ops.some((op) => op.kind !== "equal");
  if (!changed) return [];
  const keep = new Set<number>();
  ops.forEach((op, index) => {
    if (op.kind === "equal") return;
    for (let i = Math.max(0, index - DOCUMENT_DIFF_CONTEXT_LINES); i < index; i += 1) keep.add(i);
    for (let i = index + 1; i < Math.min(ops.length, index + 1 + DOCUMENT_DIFF_CONTEXT_LINES); i += 1) keep.add(i);
  });
  return ops.filter((_, index) => keep.has(index));
}

class DiffBudget {
  private textChars = 0;
  private exhaustedFlag = false;

  get exhausted(): boolean {
    return this.exhaustedFlag || this.textChars >= DOCUMENT_DIFF_MAX_TOTAL_TEXT_CHARS;
  }

  get remainingChars(): number {
    return Math.max(0, DOCUMENT_DIFF_MAX_TOTAL_TEXT_CHARS - this.textChars);
  }

  charge(chars: number): boolean {
    if (this.exhausted || chars > this.remainingChars) {
      this.exhaustedFlag = true;
      return false;
    }
    this.textChars += chars;
    return true;
  }
}

function sectionTextDiff(
  sectionId: string,
  heading: string,
  baseText: string | null,
  targetText: string | null,
  budget: DiffBudget
): DocumentSectionTextDiff {
  const a = splitLines(baseText ?? "");
  const b = splitLines(targetText ?? "");
  let script: EditOp[] | null = null;
  let coarse = false;
  if (baseText === null) {
    script = b.map((_, index) => ({ kind: "insert" as const, oldIndex: -1, newIndex: index }));
    coarse = true;
  } else if (targetText === null) {
    script = a.map((_, index) => ({ kind: "delete" as const, oldIndex: index, newIndex: -1 }));
    coarse = true;
  } else {
    script = myersScript(a, b);
    if (script === null) {
      script = coarseOps(a, b);
      coarse = true;
    }
  }
  const windowed = withContext(script);
  const ops: DocumentDiffOp[] = [];
  let truncated = coarse;
  let emitted = 0;
  for (const op of windowed) {
    const text = op.kind === "insert" ? b[op.newIndex] : a[op.oldIndex];
    if (emitted >= DOCUMENT_DIFF_MAX_SECTION_OPS || budget.exhausted) {
      truncated = true;
      break;
    }
    if (!budget.charge(text.length)) {
      truncated = true;
      break;
    }
    ops.push(
      Object.freeze({
        kind: op.kind,
        old_line: op.kind === "insert" ? null : op.oldIndex + 1,
        new_line: op.kind === "delete" ? null : op.newIndex + 1,
        text,
      })
    );
    emitted += 1;
  }
  return Object.freeze({ section_id: sectionId, heading, ops: Object.freeze(ops), truncated });
}

// ---------------------------------------------------------------------------
// Structure diff helpers
// ---------------------------------------------------------------------------

function lcsKeepSet(baseIds: readonly string[], targetIds: readonly string[]): Set<string> {
  // Common ids only; the LCS of the surviving order marks sections that kept
  // their relative order. Everything else moved. Deterministic DP.
  const common = targetIds.filter((id) => baseIds.includes(id));
  const baseCommon = baseIds.filter((id) => targetIds.includes(id));
  if (common.length === 0) return new Set();
  const dp: number[][] = Array.from({ length: baseCommon.length + 1 }, () => new Array(common.length + 1).fill(0));
  for (let i = baseCommon.length - 1; i >= 0; i -= 1) {
    for (let j = common.length - 1; j >= 0; j -= 1) {
      dp[i][j] = baseCommon[i] === common[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < baseCommon.length && j < common.length) {
    if (baseCommon[i] === common[j]) {
      keep.add(baseCommon[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return keep;
}

function chartSignature(spec: unknown): string {
  return JSON.stringify(spec);
}

function tableSignature(table: DocumentTree["tables"][number]): string {
  return JSON.stringify({ columns: table.columns, rows: table.rows });
}

function evidenceSignature(entry: DocumentTree["evidence"][number]): string {
  return JSON.stringify([
    entry.source_id,
    entry.source_name,
    entry.generation,
    entry.content_identity,
    entry.locator,
    entry.excerpt,
  ]);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Diff two frozen revision trees. Pure and deterministic; every aggregate list
 * follows base/target document order and every bound reports itself through
 * `truncated` (per section and aggregate).
 */
export function diffDocumentTrees(
  base: DocumentTree,
  target: DocumentTree,
  refs: { base: DocumentRevisionRef; target: DocumentRevisionRef }
): DocumentRevisionDiff {
  const baseSections = base.sections;
  const targetSections = target.sections;
  const baseById = new Map(baseSections.map((section) => [section.id, section]));
  const targetById = new Map(targetSections.map((section) => [section.id, section]));

  const added = targetSections
    .filter((section) => !baseById.has(section.id))
    .map((section) => ({
      id: section.id,
      heading: section.heading,
      index: targetSections.indexOf(section),
    }));
  const removed = baseSections
    .filter((section) => !targetById.has(section.id))
    .map((section) => ({
      id: section.id,
      heading: section.heading,
      index: baseSections.indexOf(section),
    }));
  const keep = lcsKeepSet(
    baseSections.map((section) => section.id),
    targetSections.map((section) => section.id)
  );
  const moved = targetSections
    .filter((section) => baseById.has(section.id) && !keep.has(section.id))
    .map((section) => ({
      id: section.id,
      heading: section.heading,
      base_index: baseSections.findIndex((entry) => entry.id === section.id),
      target_index: targetSections.findIndex((entry) => entry.id === section.id),
    }));
  const modified = targetSections
    .filter((section) => {
      const previous = baseById.get(section.id);
      return previous !== undefined && (previous.heading !== section.heading || previous.markdown !== section.markdown);
    })
    .map((section) => ({
      id: section.id,
      heading: section.heading,
      index: targetSections.findIndex((entry) => entry.id === section.id),
    }));

  const budget = new DiffBudget();
  const textDiffs: DocumentSectionTextDiff[] = [];
  // Added and modified sections in target order, removed sections in base
  // order — the only two orderings that are both stable and reviewable.
  for (const section of targetSections) {
    if (added.some((entry) => entry.id === section.id)) {
      textDiffs.push(sectionTextDiff(section.id, section.heading, null, section.markdown, budget));
    } else if (modified.some((entry) => entry.id === section.id)) {
      textDiffs.push(
        sectionTextDiff(section.id, section.heading, baseById.get(section.id)!.markdown, section.markdown, budget)
      );
    }
  }
  for (const section of removed) {
    textDiffs.push(
      sectionTextDiff(section.id, section.heading, baseById.get(section.id)!.markdown, null, budget)
    );
  }

  const chartIds = new Map(base.charts.map((chart) => [chart.id, chartSignature(chart.spec)]));
  const chartsAdded: string[] = [];
  const chartsChanged: string[] = [];
  for (const chart of target.charts) {
    const previous = chartIds.get(chart.id);
    if (previous === undefined) chartsAdded.push(chart.id);
    else if (previous !== chartSignature(chart.spec)) chartsChanged.push(chart.id);
  }
  const targetChartIds = new Set(target.charts.map((chart) => chart.id));
  const chartsRemoved = base.charts.filter((chart) => !targetChartIds.has(chart.id)).map((chart) => chart.id);

  // Tables have no stable identity, so pairing is positional. Same columns at
  // the same position with different cells is a content change; a different
  // column set is an added/removed table.
  const baseTableSignatures = base.tables.map(tableSignature);
  const targetTableSignatures = target.tables.map(tableSignature);
  const sameColumns = (index: number) =>
    index < base.tables.length &&
    base.tables[index].columns.length === target.tables[index].columns.length &&
    base.tables[index].columns.every((column, position) => column === target.tables[index].columns[position]);
  const tablesAdded: DocumentDiffTableSummary[] = [];
  const tablesChanged: number[] = [];
  target.tables.forEach((table, index) => {
    if (targetTableSignatures[index] === baseTableSignatures[index]) return;
    if (index < base.tables.length && sameColumns(index)) tablesChanged.push(index);
    else tablesAdded.push(Object.freeze({ index, columns: Object.freeze([...table.columns]) }));
  });
  const tablesRemoved: DocumentDiffTableSummary[] = [];
  base.tables.forEach((table, index) => {
    if (baseTableSignatures[index] === targetTableSignatures[index]) return;
    if (index < target.tables.length && sameColumns(index)) return;
    tablesRemoved.push(Object.freeze({ index, columns: Object.freeze([...table.columns]) }));
  });

  const baseEvidence = new Map(base.evidence.map((entry) => [entry.id, evidenceSignature(entry)]));
  const evidenceAdded: DocumentDiffEvidenceRef[] = [];
  const evidenceChanged: string[] = [];
  for (const entry of target.evidence) {
    const previous = baseEvidence.get(entry.id);
    if (previous === undefined) {
      evidenceAdded.push(Object.freeze({ id: entry.id, source_name: entry.source_name }));
    } else if (previous !== evidenceSignature(entry)) {
      evidenceChanged.push(entry.id);
    }
  }
  const targetEvidenceIds = new Set(target.evidence.map((entry) => entry.id));
  const evidenceRemoved = base.evidence
    .filter((entry) => !targetEvidenceIds.has(entry.id))
    .map((entry) => Object.freeze({ id: entry.id, source_name: entry.source_name }));

  const truncated = budget.exhausted || textDiffs.some((diff) => diff.truncated);

  return Object.freeze({
    base: Object.freeze({ ...refs.base }),
    target: Object.freeze({ ...refs.target }),
    fields: Object.freeze({
      title_changed: base.title !== target.title,
      subtitle_changed: base.subtitle !== target.subtitle,
      verified_changed: base.verified !== target.verified,
    }),
    sections: Object.freeze({
      added: Object.freeze(added.map((entry) => Object.freeze(entry))),
      removed: Object.freeze(removed.map((entry) => Object.freeze(entry))),
      moved: Object.freeze(moved.map((entry) => Object.freeze(entry))),
      modified: Object.freeze(modified.map((entry) => Object.freeze(entry))),
    }),
    text_diffs: Object.freeze(textDiffs),
    charts: Object.freeze({
      added: Object.freeze(chartsAdded),
      removed: Object.freeze(chartsRemoved),
      changed: Object.freeze(chartsChanged),
    }),
    tables: Object.freeze({
      added: Object.freeze(tablesAdded),
      removed: Object.freeze(tablesRemoved),
      changed: Object.freeze(tablesChanged),
    }),
    evidence: Object.freeze({
      added: Object.freeze(evidenceAdded),
      removed: Object.freeze(evidenceRemoved),
      changed: Object.freeze(evidenceChanged),
    }),
    truncated,
  });
}
