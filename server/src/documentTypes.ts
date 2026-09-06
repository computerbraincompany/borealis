/**
 * Shared, dependency-light contracts for editable documents (M13).
 *
 * A document revision stores one immutable full snapshot of the normalized
 * tree defined here: stable document-local UUIDs for sections/blocks, frozen
 * canonical chart values and table cells, an optional server-verified
 * analysis provenance envelope per table, and a versioned evidence snapshot.
 * Validation here is structural and bounded — it never executes SQL, never
 * performs retrieval, and never interprets source names, locators, or excerpt
 * text as commands or paths. Provenance-bearing fields (`analysis` on a
 * table, evidence `generation`/`content_identity` as numbers) may only be
 * populated from server-verified origin records by the document store/copy
 * services; model text can never mint verified evidence.
 *
 * The compiled form is the existing report contract: `compileDocumentTree`
 * maps a frozen revision to `NormalizedReport` (validated by
 * `data/reports.ts normalizeReport` as the compile-target validator) plus a
 * separately bounded evidence appendix, so every renderer/export format stays
 * inside the shipped 20-section / 200,000-Markdown-character / 20-chart /
 * 8-table (60 rows, 32 columns, 500-character cells) renderer bounds. The
 * section text budget is charged the appendix length at save time so a
 * 20-section draft can never fail only at export.
 */

import { randomUUID } from "node:crypto";

import { normalize, type CanonicalChartSpec } from "./data/charts.js";
import { normalizeReport, type ReportCell, type ReportTable } from "./data/reports.js";

// ---------------------------------------------------------------------------
// Versioned evidence contract
// ---------------------------------------------------------------------------

/** Version tag persisted inside every stored evidence snapshot envelope. */
export const DOCUMENT_EVIDENCE_CONTRACT_VERSION = 1 as const;

export const DOCUMENT_EVIDENCE_MAX_REFS = 100;
export const DOCUMENT_EVIDENCE_EXCERPT_MAX_CHARS = 800;
export const DOCUMENT_EVIDENCE_SERIALIZED_MAX_CHARS = 100_000;
export const DOCUMENT_EVIDENCE_SOURCE_NAME_MAX_CHARS = 200;
export const DOCUMENT_EVIDENCE_LOCATOR_MAX_CHARS = 500;

/** Sentinel for a generation/content identity that history never recorded. */
export const DOCUMENT_EVIDENCE_UNKNOWN = "unknown" as const;

// ---------------------------------------------------------------------------
// Tree and compile bounds (renderer bounds are ceilings, never raised)
// ---------------------------------------------------------------------------

export const DOCUMENT_TITLE_MAX_CHARS = 200;
export const DOCUMENT_SUBTITLE_MAX_CHARS = 500;
/** Matches the legacy report payload ceiling: evidence-inclusive revision. */
export const DOCUMENT_REVISION_PAYLOAD_MAX_CHARS = 400_000;
export const DOCUMENT_SECTIONS_MAX = 20;
export const DOCUMENT_SECTION_HEADING_MAX_CHARS = 200;
export const DOCUMENT_SECTION_MARKDOWN_MAX_CHARS = 50_000;
/** Total section Markdown; the evidence appendix is charged against it. */
export const DOCUMENT_MARKDOWN_TOTAL_MAX_CHARS = 200_000;
export const DOCUMENT_CHARTS_MAX = 20;
export const DOCUMENT_CHART_ID_MAX_CHARS = 200;
export const DOCUMENT_TABLES_MAX = 8;
export const DOCUMENT_TABLE_ROWS_MAX = 60;
export const DOCUMENT_TABLE_COLUMNS_MAX = 32;
export const DOCUMENT_TABLE_CELL_MAX_CHARS = 500;
export const DOCUMENT_TABLE_COLUMN_NAME_MAX_CHARS = 200;
export const DOCUMENT_AUTHOR_KINDS = Object.freeze(["user", "model", "automation"] as const);

export type DocumentAuthorKind = (typeof DOCUMENT_AUTHOR_KINDS)[number];

export class DocumentValidationError extends Error {
  readonly code: "DOCUMENT_INVALID" | "DOCUMENT_OVERSIZE";

  constructor(
    code: "DOCUMENT_INVALID" | "DOCUMENT_OVERSIZE" = "DOCUMENT_INVALID",
    message = "invalid document payload"
  ) {
    super(message);
    this.code = code;
    this.name = "DocumentValidationError";
  }
}

// ---------------------------------------------------------------------------
// Normalized shapes
// ---------------------------------------------------------------------------

export interface DocumentEvidenceRef {
  /** Stable document-local identity, distinct from chunk/run identities. */
  readonly id: string;
  readonly source_id: string;
  readonly source_name: string;
  /** Server-verified ready generation, or `unknown` for unverified history. */
  readonly generation: number | typeof DOCUMENT_EVIDENCE_UNKNOWN;
  /** Server-verified content identity, or `unknown` for unverified history. */
  readonly content_identity: string | typeof DOCUMENT_EVIDENCE_UNKNOWN;
  /** Optional page/locator label. Data only — never a path or command. */
  readonly locator: string | null;
  /** Bounded excerpt copied at creation time; survives source deletion. */
  readonly excerpt: string;
}

export interface DocumentAnalysisParameter {
  readonly name: string;
  readonly type: "string" | "number" | "integer" | "boolean" | "date";
  readonly value: string | number | boolean | null;
}

export interface DocumentAnalysisSourceGeneration {
  readonly source_id: string;
  readonly ready_generation: number;
  readonly content_identity: string;
}

/**
 * Server-verified provenance for a table copied from a saved-analysis result.
 * Populated exclusively by the copy/attach services from analysis ledger
 * rows; structural validation here only bounds the shape.
 */
export interface DocumentTableAnalysis {
  readonly analysis_id: string;
  readonly analysis_revision: number;
  readonly result_id: string;
  readonly parameters: readonly DocumentAnalysisParameter[];
  readonly source_generations: readonly DocumentAnalysisSourceGeneration[];
  readonly columns: ReadonlyArray<{ name: string; type: "empty" | "number" | "string" | "boolean" | "mixed" }>;
  readonly completeness: { complete: boolean; reasons: readonly string[] };
  readonly schema_fingerprint: string | null;
}

export interface DocumentSection {
  /** Stable document-local block UUID; mutation target, never an offset. */
  readonly id: string;
  readonly heading: string;
  readonly markdown: string;
}

export interface DocumentChart {
  /** Stable identity; legacy payloads keep model-garbled 12-char prefixes. */
  readonly id: string;
  readonly spec: CanonicalChartSpec;
}

export interface DocumentTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ReportCell[])[];
  readonly analysis: DocumentTableAnalysis | null;
}

export interface DocumentTree {
  readonly title: string;
  readonly subtitle: string;
  /** False when the originating evidence was unavailable at creation/copy. */
  readonly verified: boolean;
  readonly sections: readonly DocumentSection[];
  readonly charts: readonly DocumentChart[];
  readonly tables: readonly DocumentTable[];
  readonly evidence: readonly DocumentEvidenceRef[];
}

/** Loose input accepted by the store before normalization. */
export interface DocumentTreeInput {
  title: string;
  subtitle?: string;
  verified?: boolean;
  sections?: readonly { id?: string; heading?: string; markdown?: string }[];
  charts?: readonly { id: string; spec: unknown }[];
  tables?: readonly {
    columns: readonly string[];
    rows: readonly (readonly ReportCell[])[];
    analysis?: DocumentTableAnalysis | null;
  }[];
  evidence?: readonly unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message?: string): never {
  throw new DocumentValidationError("DOCUMENT_INVALID", message);
}

function oversize(message: string): never {
  throw new DocumentValidationError("DOCUMENT_OVERSIZE", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) invalid();
}

function boundedText(value: unknown, maximum: number, field: string, required = false): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > maximum || (required && !value)) {
    invalid(`${field} violates the document contract`);
  }
  return value;
}

function uuidValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(`${field} must be a UUID`);
  return value.toLowerCase();
}

function normalizeEvidenceRef(value: unknown): DocumentEvidenceRef {
  if (!isRecord(value)) invalid("evidence entry must be an object");
  exactKeys(value, ["id", "source_id", "source_name", "generation", "content_identity", "locator", "excerpt"]);
  const generationValue = value.generation;
  let generation: number | typeof DOCUMENT_EVIDENCE_UNKNOWN;
  if (generationValue === DOCUMENT_EVIDENCE_UNKNOWN) {
    generation = DOCUMENT_EVIDENCE_UNKNOWN;
  } else if (typeof generationValue === "number" && Number.isSafeInteger(generationValue) && generationValue >= 0) {
    generation = generationValue;
  } else {
    invalid("evidence generation must be a non-negative integer or 'unknown'");
  }
  const contentValue = value.content_identity;
  let contentIdentity: string | typeof DOCUMENT_EVIDENCE_UNKNOWN;
  if (contentValue === DOCUMENT_EVIDENCE_UNKNOWN) {
    contentIdentity = DOCUMENT_EVIDENCE_UNKNOWN;
  } else if (typeof contentValue === "string" && contentValue.length >= 1 && contentValue.length <= 33_000) {
    contentIdentity = contentValue;
  } else {
    invalid("evidence content identity must be bounded text or 'unknown'");
  }
  return Object.freeze({
    id: uuidValue(value.id, "evidence id"),
    source_id: uuidValue(value.source_id, "evidence source id"),
    source_name: boundedText(value.source_name, DOCUMENT_EVIDENCE_SOURCE_NAME_MAX_CHARS, "evidence source name"),
    generation,
    content_identity: contentIdentity,
    locator:
      value.locator === undefined || value.locator === null
        ? null
        : boundedText(value.locator, DOCUMENT_EVIDENCE_LOCATOR_MAX_CHARS, "evidence locator"),
    excerpt: boundedText(value.excerpt ?? "", DOCUMENT_EVIDENCE_EXCERPT_MAX_CHARS, "evidence excerpt", true),
  });
}

function normalizeAnalysisParameters(value: unknown): readonly DocumentAnalysisParameter[] {
  if (!Array.isArray(value) || value.length > 20) invalid("analysis provenance parameters must bound to 20");
  return Object.freeze(
    value.map((entry) => {
      if (!isRecord(entry)) invalid("analysis provenance parameter is malformed");
      exactKeys(entry, ["name", "type", "value"]);
      const type = entry.type;
      if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "date") {
        invalid("analysis provenance parameter type is unsupported");
      }
      const bindingValue = entry.value;
      if (
        bindingValue !== null &&
        typeof bindingValue !== "string" &&
        typeof bindingValue !== "number" &&
        typeof bindingValue !== "boolean"
      ) {
        invalid("analysis provenance parameter value is unsupported");
      }
      return Object.freeze({
        name: boundedText(entry.name, 200, "analysis provenance parameter name", true),
        type,
        value: bindingValue as string | number | boolean | null,
      });
    })
  );
}

function normalizeTableAnalysis(value: unknown): DocumentTableAnalysis {
  if (!isRecord(value)) invalid("analysis table provenance must be an object");
  exactKeys(value, [
    "analysis_id",
    "analysis_revision",
    "result_id",
    "parameters",
    "source_generations",
    "columns",
    "completeness",
    "schema_fingerprint",
  ]);
  if (
    typeof value.analysis_revision !== "number" ||
    !Number.isSafeInteger(value.analysis_revision) ||
    value.analysis_revision < 1
  ) {
    invalid("analysis provenance revision is malformed");
  }
  if (!Array.isArray(value.source_generations) || value.source_generations.length > 100) {
    invalid("analysis provenance source generations are malformed");
  }
  const sourceGenerations = Object.freeze(
    value.source_generations.map((entry) => {
      if (!isRecord(entry)) invalid("analysis provenance source generation is malformed");
      exactKeys(entry, ["source_id", "ready_generation", "content_identity"]);
      if (
        typeof entry.ready_generation !== "number" ||
        !Number.isSafeInteger(entry.ready_generation) ||
        entry.ready_generation < 0
      ) {
        invalid("analysis provenance ready generation is malformed");
      }
      return Object.freeze({
        source_id: uuidValue(entry.source_id, "analysis provenance source id"),
        ready_generation: entry.ready_generation,
        content_identity: boundedText(entry.content_identity, 33_000, "analysis provenance content identity", true),
      });
    })
  );
  if (!Array.isArray(value.columns) || value.columns.length > DOCUMENT_TABLE_COLUMNS_MAX) {
    invalid("analysis provenance columns are malformed");
  }
  const columns = Object.freeze(
    value.columns.map((entry) => {
      if (!isRecord(entry)) invalid("analysis provenance column is malformed");
      exactKeys(entry, ["name", "type"]);
      const type = entry.type;
      if (type !== "empty" && type !== "number" && type !== "string" && type !== "boolean" && type !== "mixed") {
        invalid("analysis provenance column type is unsupported");
      }
      return Object.freeze({
        name: boundedText(entry.name, DOCUMENT_TABLE_COLUMN_NAME_MAX_CHARS, "analysis provenance column name"),
        type,
      });
    })
  );
  const completeness = isRecord(value.completeness) ? value.completeness : invalid("completeness is malformed");
  exactKeys(completeness, ["complete", "reasons"]);
  if (typeof completeness.complete !== "boolean" || !Array.isArray(completeness.reasons)) {
    invalid("analysis provenance completeness is malformed");
  }
  return Object.freeze({
    analysis_id: uuidValue(value.analysis_id, "analysis provenance analysis id"),
    analysis_revision: value.analysis_revision,
    result_id: uuidValue(value.result_id, "analysis provenance result id"),
    parameters: normalizeAnalysisParameters(value.parameters),
    source_generations: sourceGenerations,
    columns,
    completeness: Object.freeze({
      complete: completeness.complete,
      reasons: Object.freeze(
        completeness.reasons.map((reason) => boundedText(reason, 500, "completeness reason", true))
      ),
    }),
    schema_fingerprint:
      value.schema_fingerprint === undefined || value.schema_fingerprint === null
        ? null
        : boundedText(value.schema_fingerprint, 512, "analysis provenance schema fingerprint", true),
  });
}

/**
 * Normalizes loose input into the frozen tree, assigning stable UUIDs to any
 * section that omits one. Every bound that later export must respect is
 * enforced here so oversize edits are rejected before they are ever saved.
 */
export function normalizeDocumentTree(input: unknown): { tree: DocumentTree; serialized: string } {
  if (!isRecord(input)) invalid("document tree must be an object");
  exactKeys(input, ["title", "subtitle", "verified", "sections", "charts", "tables", "evidence"]);

  const title = boundedText(input.title, DOCUMENT_TITLE_MAX_CHARS, "document title", true);
  if (!title.trim()) invalid("document title must not be blank");
  const subtitle = boundedText(input.subtitle ?? "", DOCUMENT_SUBTITLE_MAX_CHARS, "document subtitle");
  const verified = input.verified === undefined ? true : input.verified === true;
  if (input.verified !== undefined && typeof input.verified !== "boolean") invalid("verified must be a boolean");

  const sectionValues = input.sections ?? [];
  if (!Array.isArray(sectionValues) || sectionValues.length > DOCUMENT_SECTIONS_MAX) invalid("section list is bounded");
  let markdownTotal = 0;
  const seenSectionIds = new Set<string>();
  const sections: DocumentSection[] = sectionValues.map((section) => {
    if (!isRecord(section)) invalid("section must be an object");
    exactKeys(section, ["id", "heading", "markdown"]);
    const markdown = boundedText(section.markdown, DOCUMENT_SECTION_MARKDOWN_MAX_CHARS, "section markdown");
    markdownTotal += markdown.length;
    if (markdownTotal > DOCUMENT_MARKDOWN_TOTAL_MAX_CHARS) {
      oversize("total section Markdown exceeds the compiled renderer budget");
    }
    let id: string;
    if (section.id === undefined || section.id === null) {
      id = randomUUID();
    } else {
      id = uuidValue(section.id, "section id");
      if (seenSectionIds.has(id)) invalid("section ids must be unique");
      seenSectionIds.add(id);
    }
    return Object.freeze({
      id,
      heading: boundedText(section.heading ?? "", DOCUMENT_SECTION_HEADING_MAX_CHARS, "section heading"),
      markdown,
    });
  });

  const chartValues = input.charts ?? [];
  if (!Array.isArray(chartValues) || chartValues.length > DOCUMENT_CHARTS_MAX) invalid("chart list is bounded");
  const seenChartIds = new Set<string>();
  const charts: DocumentChart[] = chartValues.map((chart) => {
    if (!isRecord(chart)) invalid("chart must be an object");
    exactKeys(chart, ["id", "spec"]);
    const id = boundedText(chart.id, DOCUMENT_CHART_ID_MAX_CHARS, "chart id", true);
    if (seenChartIds.has(id)) invalid("chart ids must be unique");
    seenChartIds.add(id);
    return Object.freeze({ id, spec: normalize(chart.spec) });
  });

  const tableValues = input.tables ?? [];
  if (!Array.isArray(tableValues) || tableValues.length > DOCUMENT_TABLES_MAX) invalid("table list is bounded");
  const tables: DocumentTable[] = tableValues.map((table) => {
    if (!isRecord(table)) invalid("table must be an object");
    exactKeys(table, ["columns", "rows", "analysis"]);
    if (!Array.isArray(table.columns) || table.columns.length > DOCUMENT_TABLE_COLUMNS_MAX) invalid();
    const columns = Object.freeze(
      table.columns.map((column) => boundedText(column, DOCUMENT_TABLE_COLUMN_NAME_MAX_CHARS, "table column"))
    );
    if (!Array.isArray(table.rows) || table.rows.length > DOCUMENT_TABLE_ROWS_MAX) invalid();
    const rows = Object.freeze(
      table.rows.map((row): readonly ReportCell[] => {
        if (!Array.isArray(row) || row.length !== columns.length) invalid();
        return Object.freeze(
          row.map((cell) => {
            if (cell === null || typeof cell === "boolean") return cell;
            if (typeof cell === "string") return boundedText(cell, DOCUMENT_TABLE_CELL_MAX_CHARS, "table cell");
            if (
              typeof cell === "number" &&
              Number.isFinite(cell) &&
              String(cell).length <= DOCUMENT_TABLE_CELL_MAX_CHARS
            ) {
              return cell;
            }
            return invalid("table cell type is unsupported");
          })
        );
      })
    );
    const analysis =
      table.analysis === undefined || table.analysis === null ? null : normalizeTableAnalysis(table.analysis);
    return Object.freeze({ columns, rows, analysis });
  });

  const evidenceValues = input.evidence ?? [];
  if (!Array.isArray(evidenceValues) || evidenceValues.length > DOCUMENT_EVIDENCE_MAX_REFS) {
    invalid(`at most ${DOCUMENT_EVIDENCE_MAX_REFS} evidence references are allowed`);
  }
  const evidence = Object.freeze(evidenceValues.map((entry) => normalizeEvidenceRef(entry)));
  if (JSON.stringify(evidence).length > DOCUMENT_EVIDENCE_SERIALIZED_MAX_CHARS) {
    oversize("serialized evidence exceeds the document evidence budget");
  }

  const tree: DocumentTree = Object.freeze({
    title,
    subtitle,
    verified,
    sections: Object.freeze(sections),
    charts: Object.freeze(charts),
    tables: Object.freeze(tables),
    evidence,
  });
  const serialized = serializeDocumentTree(tree);
  if (serialized.length > DOCUMENT_REVISION_PAYLOAD_MAX_CHARS) {
    oversize("document revision exceeds the evidence-inclusive payload bound");
  }
  // Reserve appendix room inside the same text budget the compiler charges,
  // so a saved tree is always exportable without an extra post-save failure.
  const appendix = buildEvidenceAppendix(evidence);
  if (markdownTotal + appendix.length > DOCUMENT_MARKDOWN_TOTAL_MAX_CHARS) {
    oversize("section Markdown plus the evidence appendix exceeds the compiled renderer budget");
  }
  return { tree, serialized };
}

/** Canonical serialization for the frozen revision payload. */
export function serializeDocumentTree(tree: DocumentTree): string {
  return JSON.stringify({
    title: tree.title,
    subtitle: tree.subtitle,
    verified: tree.verified,
    sections: tree.sections,
    charts: tree.charts,
    tables: tree.tables,
    evidence: tree.evidence,
  });
}

/** Strict re-decode of a persisted payload; fails closed on any drift. */
export function parseDocumentTreePayload(value: unknown): DocumentTree {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  return normalizeDocumentTree(parsed).tree;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DocumentValidationError("DOCUMENT_INVALID", "stored document payload is not valid JSON");
  }
}

// ---------------------------------------------------------------------------
// Compile to the existing renderer contract
// ---------------------------------------------------------------------------

export interface CompiledDocument {
  /** Validated with `normalizeReport`; charts/tables reuse the live bounds. */
  readonly report: ReturnType<typeof normalizeReport>;
  /** Deterministic evidence appendix rendered as a separately bounded block. */
  readonly appendix: string;
}

/**
 * Compiles a frozen revision into the current report contract. The evidence
 * appendix is NOT appended as a section (a 21st section could never render);
 * it is returned separately under the shared text budget, which the compiler
 * re-checks even though the normalizer already charged it at save time.
 */
export function compileDocumentTree(tree: DocumentTree, generatedAt = ""): CompiledDocument {
  const markdownTotal = tree.sections.reduce((total, section) => total + section.markdown.length, 0);
  const appendix = buildEvidenceAppendix(tree.evidence);
  if (markdownTotal + appendix.length > DOCUMENT_MARKDOWN_TOTAL_MAX_CHARS) {
    oversize("compiled document exceeds the renderer text budget");
  }
  const report = normalizeReport({
    title: tree.title,
    subtitle: tree.subtitle,
    generated_at: generatedAt,
    sections: tree.sections.map((section) => ({ heading: section.heading, markdown: section.markdown })),
    charts: tree.charts.map((chart) => ({ id: chart.id, spec: chart.spec })),
    tables: tree.tables.map((table) => ({
      columns: [...table.columns],
      rows: table.rows.map((row) => [...row]),
    })),
  });
  return Object.freeze({ report, appendix });
}

// ---------------------------------------------------------------------------
// Evidence appendix and deterministic display numbers
// ---------------------------------------------------------------------------

/**
 * Deterministic appendix text for one revision. Display numbers are the
 * 1-based positions in the revision's own evidence array — the single source
 * of truth, mirroring `citations.ts` conventions — so a reorder produces a
 * new deterministic numbering while the document-local UUIDs stay stable.
 */
export function buildEvidenceAppendix(evidence: readonly DocumentEvidenceRef[]): string {
  if (evidence.length === 0) return "";
  const lines: string[] = ["## Evidence"];
  evidence.forEach((ref, index) => {
    const parts = [`[${index + 1}] ${ref.source_name}`];
    if (ref.locator) parts.push(`· ${ref.locator}`);
    if (typeof ref.generation === "number") parts.push(`· generation ${ref.generation}`);
    lines.push(`${parts.join(" ")}\n${ref.excerpt}`);
  });
  return lines.join("\n\n");
}

/** True when a copied evidence reference carries server-verified provenance. */
export function isVerifiedEvidenceRef(ref: DocumentEvidenceRef): boolean {
  return typeof ref.generation === "number" && ref.content_identity !== DOCUMENT_EVIDENCE_UNKNOWN;
}

/**
 * Deterministic one-line validity state for one revision, shown in every
 * export and the workbench. Manual/unverified claims stay explicitly
 * distinguished from verified citations; nothing is ever upgraded here.
 */
export function buildPublicationValidity(tree: Pick<DocumentTree, "verified" | "evidence">): string {
  const total = tree.evidence.length;
  if (!total) {
    return tree.verified
      ? "Evidence: verified origin — no evidence references in this revision"
      : "Unverified document — manual claims, no evidence references";
  }
  const verified = tree.evidence.filter(isVerifiedEvidenceRef).length;
  const unverified = total - verified;
  const origin = tree.verified ? "Evidence" : "Unverified document";
  if (!unverified) return `${origin}: ${total} reference${total === 1 ? "" : "s"}, provenance verified`;
  if (!verified) return `${origin}: ${total} reference${total === 1 ? "" : "s"}, provenance unknown`;
  return `${origin}: ${verified} provenance verified, ${unverified} unknown`;
}

/**
 * Export-facing appendix text: the deterministic shared numbering with the
 * same entry lines as `buildEvidenceAppendix` plus one explicit
 * `provenance verified|unknown` marker per reference, so the verified/unknown
 * distinction survives into HTML, PDF, Markdown, and DOCX.
 */
export function buildPublicationAppendix(tree: Pick<DocumentTree, "verified" | "evidence">): string {
  if (tree.evidence.length === 0) return "";
  const lines: string[] = ["## Evidence"];
  tree.evidence.forEach((ref, index) => {
    const parts = [`[${index + 1}] ${ref.source_name}`];
    if (ref.locator) parts.push(`· ${ref.locator}`);
    parts.push(isVerifiedEvidenceRef(ref) ? `· provenance verified` : `· provenance unknown`);
    if (typeof ref.generation === "number") parts.push(`· generation ${ref.generation}`);
    lines.push(`${parts.join(" ")}\n${ref.excerpt}`);
  });
  return lines.join("\n\n");
}

// The marker grammar admits at most the distinct values 0..99, so the scan
// bound is the grammar itself (mirrors citations.ts; never widened per model).
const MAX_DISTINCT_MARKERS = 100;
const EVIDENCE_MARKER_PATTERN = /\[(\d{1,2})\]/g;

/** Distinct bracketed markers in ascending order, including unresolved ones. */
export function extractDocumentEvidenceMarkers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(EVIDENCE_MARKER_PATTERN)) {
    found.add(Number(match[1]));
    if (found.size >= MAX_DISTINCT_MARKERS) break;
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * Resolve markers against one revision's own evidence array. Markers outside
 * `1..evidence.length` (including 0) stay plain text in the UI: they are
 * never matched against arbitrary workspace chunks, and a model cannot mint
 * a verified citation by writing a number.
 */
export function resolveDocumentEvidenceMarkers(
  text: string,
  evidence: readonly DocumentEvidenceRef[]
): ReadonlyArray<{ n: number; evidence: DocumentEvidenceRef }> {
  if (!evidence.length) return Object.freeze([]);
  const resolved: Array<{ n: number; evidence: DocumentEvidenceRef }> = [];
  for (const n of extractDocumentEvidenceMarkers(text)) {
    if (n < 1 || n > evidence.length) continue;
    resolved.push(Object.freeze({ n, evidence: evidence[n - 1] }));
  }
  return Object.freeze(resolved);
}

// ---------------------------------------------------------------------------
// Legacy report copy
// ---------------------------------------------------------------------------

/**
 * Builds the copied tree for "create editable copy" of an owned legacy
 * report. The stored normalized payload is validated with the live legacy
 * `normalizeReport` (preserving model-garbled 12-character chart-id prefixes
 * verbatim); sections get fresh document-local UUIDs and no evidence exists
 * for legacy payloads, so the copy is explicitly marked unverified. Rendered
 * HTML is never scraped and no field is invented.
 */
export function documentTreeFromLegacyReport(payloadValue: unknown, title: string): DocumentTree {
  const report = normalizeReport(payloadValue);
  return normalizeDocumentTree({
    title: title.trim() || report.title,
    subtitle: report.subtitle,
    verified: false,
    sections: report.sections.map((section) => ({ heading: section.heading, markdown: section.markdown })),
    charts: report.charts.map((chart) => ({ id: chart.id, spec: chart.spec })),
    tables: report.tables.map((table) => ({
      columns: [...table.columns],
      rows: table.rows.map((row) => [...row]),
      analysis: null,
    })),
    evidence: [],
  } satisfies DocumentTreeInput).tree;
}

// Re-exported so importers do not reach into `data/reports.js` for the cell
// type when typing document tables.
export type { ReportCell, ReportTable };
