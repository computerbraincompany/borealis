/**
 * Shared, dependency-free contracts for saved analyses (M12).
 *
 * These types are the single definition of the analysis definition/revision/
 * run/result shapes for the durable store (`server/src/db/stores/analysisStore.ts`),
 * the full-query capture path (`server/src/tools.ts`, `runStore.ts`), and — from
 * stage 2/3 onward — the lifecycle service and routes. Validation here is
 * structural and bounded; it never executes SQL and never widens a source
 * scope. Positional `?` placeholder arity is verified by the DuckDB prepared
 * statement path at execution time (stage 2), not by text scanning here.
 */

// ---------------------------------------------------------------------------
// Definition bounds
// ---------------------------------------------------------------------------

export const ANALYSIS_TITLE_MAX_CHARS = 200;
export const ANALYSIS_DESCRIPTION_MAX_CHARS = 2_000;
/** Matches the `query_data` tool's executable-SQL ceiling. */
export const ANALYSIS_SQL_MAX_CHARS = 20_000;
export const ANALYSIS_PARAMETER_MAX_COUNT = 20;
export const ANALYSIS_PARAMETER_STRING_MAX_CHARS = 2_000;
export const ANALYSIS_SOURCE_MAX_COUNT = 100;
export const ANALYSIS_COMPARISON_KEY_MAX_COLUMNS = 3;
export const ANALYSIS_LABEL_MAX_CHARS = 200;

const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Persisted-result bounds (may lower, never raise, the worker ceilings)
// ---------------------------------------------------------------------------

export const ANALYSIS_RESULT_ROWS_MAX = 500;
export const ANALYSIS_RESULT_COLUMNS_MAX = 64;
export const ANALYSIS_RESULT_CELLS_MAX = 20_000;
export const ANALYSIS_RESULT_STRING_CELL_MAX_CHARS = 2_000;
/** 1 MiB of UTF-8 serialized row payload. */
export const ANALYSIS_RESULT_PAYLOAD_MAX_BYTES = 1_048_576;
export const ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS = 200;
/** Retained results per analysis before acceptance must fail with a quota error. */
export const ANALYSIS_RETAINED_RESULTS_MAX = 1_000;

// ---------------------------------------------------------------------------
// Full-query capture bounds
// ---------------------------------------------------------------------------

export const QUERY_CAPTURE_MAX_PER_TURN = 3;
export const QUERY_CAPTURE_SQL_MAX_CHARS = 20_000;
export const QUERY_CAPTURE_SOURCES_MAX = 100;

export interface QueryCaptureSourceProvenance {
  readonly source_id: string;
  readonly ready_generation: number;
}

/**
 * One promotable full-query capture drafted during a chat turn. It is kept in
 * memory until the run completes successfully; only `runStore.ts` persists it
 * (inside the completion transaction). Public receipt metadata carries only
 * `id` — never the SQL.
 */
export interface QueryCaptureDraft {
  readonly id: string;
  readonly sql: string;
  readonly sources: readonly QueryCaptureSourceProvenance[];
}

export interface StoredQueryCapture {
  readonly id: string;
  readonly accountId: string;
  readonly runId: string;
  readonly sql: string;
  readonly sources: readonly QueryCaptureSourceProvenance[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export type AnalysisParameterType = "string" | "number" | "integer" | "boolean" | "date";

/** A bound scalar value. `date` values are canonical `YYYY-MM-DD` strings. */
export type AnalysisParameterValue = string | number | boolean | null;

export interface AnalysisParameterDeclaration {
  readonly name: string;
  readonly type: AnalysisParameterType;
  readonly required: boolean;
  readonly nullable: boolean;
  /** Typed default used when the run supplies no value. */
  readonly default?: AnalysisParameterValue;
  readonly label?: string;
  readonly description?: string;
}

/** One ordered, validated parameter binding. Declaration order is binding order. */
export interface AnalysisParameterBinding {
  readonly name: string;
  readonly type: AnalysisParameterType;
  readonly value: AnalysisParameterValue;
}

export class AnalysisValidationError extends Error {
  readonly code = "ANALYSIS_VALIDATION";

  constructor(
    readonly reason: string,
    options: ErrorOptions = {}
  ) {
    super(`invalid analysis input: ${reason}`, options);
    this.name = "AnalysisValidationError";
  }
}

function fail(reason: string): never {
  throw new AnalysisValidationError(reason);
}

function boundedText(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    (!allowEmpty && value.length < 1) ||
    value.length > maximum
  ) {
    fail(`${field} must be a string of 1..${maximum} characters${allowEmpty ? " (empty allowed)" : ""}`);
  }
  return value;
}

function safeCalendarDate(value: string): string {
  if (!ISO_DATE_PATTERN.test(value)) fail(`date parameter "${value}" is not YYYY-MM-DD`);
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    year < 1 ||
    year > 9999
  ) {
    fail(`date parameter "${value}" is not a real calendar date`);
  }
  return value;
}

/** Validates one scalar candidate against a declared type without coercion. */
export function validateAnalysisParameterScalar(
  name: string,
  type: AnalysisParameterType,
  value: unknown
): AnalysisParameterValue {
  if (value === null) return null;
  switch (type) {
    case "string":
      return boundedText(value, `parameter "${name}"`, ANALYSIS_PARAMETER_STRING_MAX_CHARS, true);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(`parameter "${name}" must be a finite number`);
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`parameter "${name}" must be a safe integer`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail(`parameter "${name}" must be a boolean`);
      return value;
    case "date":
      return safeCalendarDate(boundedText(value, `parameter "${name}"`, 10));
    default:
      fail(`parameter "${name}" has an unsupported type`);
  }
}

/**
 * Normalizes ordered parameter declarations. Rejects duplicates, malformed
 * names, non-scalar or mistyped defaults, and required+nullable contradictions
 * (a required parameter without a default cannot also be nullable-empty).
 */
export function normalizeParameterDeclarations(
  value: readonly unknown[] | undefined
): readonly AnalysisParameterDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("parameters must be an array");
  if (value.length > ANALYSIS_PARAMETER_MAX_COUNT)
    fail(`at most ${ANALYSIS_PARAMETER_MAX_COUNT} parameters are allowed`);
  const names = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      fail("each parameter declaration must be an object");
    const record = candidate as Record<string, unknown>;
    const allowed = new Set(["name", "type", "required", "nullable", "default", "label", "description"]);
    for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`unknown parameter field "${key}"`);
    const name = boundedText(record.name, "parameter name", 64);
    if (!PARAMETER_NAME_PATTERN.test(name)) fail(`parameter name "${name}" is not [A-Za-z][A-Za-z0-9_]{0,63}`);
    if (names.has(name)) fail(`duplicate parameter name "${name}"`);
    names.add(name);
    const type = record.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "date")
      fail(`parameter "${name}" has an unsupported type`);
    const required = record.required === undefined ? true : record.required;
    const nullable = record.nullable === undefined ? false : record.nullable;
    if (typeof required !== "boolean" || typeof nullable !== "boolean")
      fail(`parameter "${name}" required/nullable must be booleans`);
    if (required && nullable) fail(`parameter "${name}" cannot be both required and nullable`);
    const declaration: {
      name: string;
      type: AnalysisParameterType;
      required: boolean;
      nullable: boolean;
      default?: AnalysisParameterValue;
      label?: string;
      description?: string;
    } = { name, type: type as AnalysisParameterType, required, nullable };
    if (record.default !== undefined) {
      declaration.default = validateAnalysisParameterScalar(name, type as AnalysisParameterType, record.default);
      if (declaration.default === null && !nullable && !required)
        fail(`parameter "${name}" cannot default to null while non-nullable`);
    }
    if (record.label !== undefined)
      declaration.label = boundedText(record.label, "parameter label", ANALYSIS_LABEL_MAX_CHARS);
    if (record.description !== undefined)
      declaration.description = boundedText(
        record.description,
        "parameter description",
        ANALYSIS_DESCRIPTION_MAX_CHARS,
        true
      );
    return Object.freeze(declaration);
  });
}

/**
 * Resolves supplied values against ordered declarations into positional
 * bindings. Rejects undeclared, missing-required, and mistyped values; a
 * nullable parameter with no supplied value binds null.
 */
export function resolveParameterBindings(
  declarations: readonly AnalysisParameterDeclaration[],
  values: Readonly<Record<string, unknown>> | undefined
): readonly AnalysisParameterBinding[] {
  const supplied = values ?? {};
  if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied))
    fail("parameter values must be an object keyed by declared name");
  const declared = new Set(declarations.map((declaration) => declaration.name));
  for (const key of Object.keys(supplied)) {
    if (!declared.has(key)) fail(`parameter "${key}" is not declared`);
  }
  return declarations.map((declaration) => {
    const hasValue = Object.prototype.hasOwnProperty.call(supplied, declaration.name);
    const raw = hasValue ? supplied[declaration.name] : undefined;
    if (!hasValue || raw === undefined) {
      if (declaration.default !== undefined)
        return Object.freeze({
          name: declaration.name,
          type: declaration.type,
          value: declaration.default,
        });
      if (declaration.nullable) return Object.freeze({ name: declaration.name, type: declaration.type, value: null });
      if (declaration.required) fail(`required parameter "${declaration.name}" is missing`);
      return fail(`parameter "${declaration.name}" has no value, default, or nullability`);
    }
    if (raw === null) {
      if (!declaration.nullable) fail(`parameter "${declaration.name}" does not accept null`);
      return Object.freeze({ name: declaration.name, type: declaration.type, value: null });
    }
    return Object.freeze({
      name: declaration.name,
      type: declaration.type,
      value: validateAnalysisParameterScalar(declaration.name, declaration.type, raw),
    });
  });
}

// ---------------------------------------------------------------------------
// Definition input
// ---------------------------------------------------------------------------

export interface AnalysisProvenanceInput {
  readonly chatId?: string | null;
  readonly runId?: string | null;
  readonly captureId?: string | null;
}

export interface AnalysisDefinitionInput {
  readonly title: string;
  readonly description?: string;
  readonly sql: string;
  readonly parameters?: readonly AnalysisParameterDeclaration[];
  /** Explicit selected source ids. Omission and empty both mean selected-empty. */
  readonly sourceIds?: readonly string[];
  /** Optional row comparison key: 1..3 column names. */
  readonly comparisonKey?: readonly string[] | null;
  readonly origin?: AnalysisProvenanceInput;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeSourceIds(value: readonly unknown[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("sourceIds must be an array");
  if (value.length > ANALYSIS_SOURCE_MAX_COUNT) fail(`at most ${ANALYSIS_SOURCE_MAX_COUNT} sources are allowed`);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate)) fail("every selected source id must be a UUID");
    const id = candidate.toLowerCase();
    if (seen.has(id)) fail(`duplicate source id "${id}"`);
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeProvenance(value: AnalysisProvenanceInput | undefined): {
  originChatId: string | null;
  originRunId: string | null;
  originCaptureId: string | null;
} {
  const id = (field: string, candidate: unknown): string | null => {
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate) || candidate !== candidate.toLowerCase())
      fail(`provenance ${field} must be a lowercase UUID`);
    return candidate;
  };
  return {
    originChatId: id("chat id", value?.chatId),
    originRunId: id("run id", value?.runId),
    originCaptureId: id("capture id", value?.captureId),
  };
}

export function normalizeComparisonKey(value: readonly unknown[] | null | undefined): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > ANALYSIS_COMPARISON_KEY_MAX_COLUMNS)
    fail(`comparisonKey must hold 1..${ANALYSIS_COMPARISON_KEY_MAX_COLUMNS} columns`);
  const names = new Set<string>();
  return value.map((column) => {
    const name = boundedText(column, "comparison key column", ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS);
    if (names.has(name)) fail(`duplicate comparison key column "${name}"`);
    names.add(name);
    return name;
  });
}

export interface NormalizedAnalysisDefinition {
  readonly title: string;
  readonly description: string;
  readonly sql: string;
  readonly parameters: readonly AnalysisParameterDeclaration[];
  readonly sourceIds: readonly string[];
  readonly comparisonKey: readonly string[] | null;
  readonly originChatId: string | null;
  readonly originRunId: string | null;
  readonly originCaptureId: string | null;
}

export function normalizeAnalysisDefinition(input: unknown): NormalizedAnalysisDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("definition must be an object");
  const record = input as Record<string, unknown>;
  const allowed = new Set(["title", "description", "sql", "parameters", "sourceIds", "comparisonKey", "origin"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`unknown definition field "${key}"`);
  const origin = record.origin;
  if (origin !== undefined && origin !== null && (typeof origin !== "object" || Array.isArray(origin)))
    fail("origin must be an object");
  return Object.freeze({
    title: boundedText(record.title, "title", ANALYSIS_TITLE_MAX_CHARS),
    description:
      record.description === undefined || record.description === null
        ? ""
        : boundedText(record.description, "description", ANALYSIS_DESCRIPTION_MAX_CHARS, true),
    sql: boundedText(record.sql, "sql", ANALYSIS_SQL_MAX_CHARS),
    parameters: normalizeParameterDeclarations(record.parameters as readonly unknown[] | undefined),
    sourceIds: normalizeSourceIds(record.sourceIds as readonly unknown[] | undefined),
    comparisonKey: normalizeComparisonKey(record.comparisonKey as readonly unknown[] | null | undefined),
    ...normalizeProvenance(origin as AnalysisProvenanceInput | undefined),
  });
}

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export type AnalysisRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "stale-inputs";

export const TERMINAL_ANALYSIS_RUN_STATUSES: readonly AnalysisRunStatus[] = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "stale-inputs",
]);

export interface StoredAnalysisSourceBinding {
  readonly sourceId: string;
  /** Ready generation captured when the binding was (re)bound; null while unready. */
  readonly readyGeneration: number | null;
  /** Content/version identity captured at binding time. */
  readonly contentIdentity: string | null;
  /** Set exactly once by the source-deletion path; never reset. */
  readonly unavailableAt: string | null;
  readonly boundAt: string;
}

export interface StoredAnalysisRevision {
  readonly revision: number;
  readonly title: string;
  readonly description: string;
  readonly sql: string;
  readonly parameters: readonly AnalysisParameterDeclaration[];
  readonly sourceIds: readonly string[];
  readonly comparisonKey: readonly string[] | null;
  readonly originChatId: string | null;
  readonly originRunId: string | null;
  readonly originCaptureId: string | null;
  readonly createdAt: string;
}

export interface StoredAnalysis {
  readonly id: string;
  readonly accountId: string;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: StoredAnalysisRevision;
  readonly sources: readonly StoredAnalysisSourceBinding[];
}

export interface StoredAnalysisRunSource {
  readonly sourceId: string;
  readonly readyGeneration: number;
  readonly contentIdentity: string;
}

export interface StoredAnalysisRun {
  readonly id: string;
  readonly accountId: string;
  readonly analysisId: string;
  readonly revision: number;
  readonly status: AnalysisRunStatus;
  readonly cancelRequested: boolean;
  readonly operationId: string | null;
  readonly parameterBindings: readonly AnalysisParameterBinding[];
  readonly schemaFingerprint: string | null;
  readonly errorCode: string | null;
  readonly errorReason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly sources: readonly StoredAnalysisRunSource[];
}

export type AnalysisResultCell = string | number | boolean | null;

export type AnalysisColumnScalarType = "empty" | "number" | "string" | "boolean" | "mixed";

export interface AnalysisResultColumn {
  readonly name: string;
  readonly type: AnalysisColumnScalarType;
}

export interface AnalysisResultCompleteness {
  readonly complete: boolean;
  /** Bounded generic reasons, e.g. `rows-truncated`, `values-truncated`. */
  readonly reasons: readonly string[];
}

export interface StoredAnalysisResult {
  readonly id: string;
  readonly accountId: string;
  readonly analysisId: string;
  readonly runId: string;
  readonly revision: number;
  readonly columns: readonly AnalysisResultColumn[];
  readonly rows: readonly (readonly AnalysisResultCell[])[];
  readonly returnedRows: number;
  /** Worker-reported total when it could establish one. */
  readonly sourceRowTotal: number | null;
  /** True only when the worker proved `returnedRows === sourceRowTotal`. */
  readonly rowCountExact: boolean;
  readonly completeness: AnalysisResultCompleteness;
  readonly parameterBindings: readonly AnalysisParameterBinding[];
  readonly sourceProvenance: readonly StoredAnalysisRunSource[];
  readonly schemaFingerprint: string | null;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Captured-result validation (enforced before persistence)
// ---------------------------------------------------------------------------

export interface AnalysisResultInput {
  readonly columns: readonly unknown[];
  readonly rows: readonly unknown[];
  /** Worker-reported row total if it established one; null otherwise. */
  readonly sourceRowTotal?: number | null;
  /** Worker completeness signals; any one forces an incomplete result. */
  readonly truncated?: boolean;
  readonly reasons?: readonly string[];
}

export interface NormalizedAnalysisResult {
  readonly columns: readonly AnalysisResultColumn[];
  readonly rows: readonly (readonly AnalysisResultCell[])[];
  readonly returnedRows: number;
  readonly sourceRowTotal: number | null;
  readonly rowCountExact: boolean;
  readonly completeness: AnalysisResultCompleteness;
  /** UTF-8 byte length of the serialized row payload. */
  readonly payloadBytes: number;
}

function inferColumnType(rows: readonly (readonly AnalysisResultCell[])[], index: number): AnalysisColumnScalarType {
  let seen: AnalysisColumnScalarType = "empty";
  for (const row of rows) {
    const cell = row[index];
    if (cell === null) continue;
    const kind: AnalysisColumnScalarType =
      typeof cell === "number" ? "number" : typeof cell === "boolean" ? "boolean" : "string";
    seen = seen === "empty" ? kind : seen === kind ? seen : "mixed";
  }
  return seen;
}

function validateResultCell(value: unknown): AnalysisResultCell {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("result cells must be finite numbers");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > ANALYSIS_RESULT_STRING_CELL_MAX_CHARS)
      fail(`string cells must be <= ${ANALYSIS_RESULT_STRING_CELL_MAX_CHARS} characters`);
    return value;
  }
  fail("result cells must be scalar string|number|boolean|null");
}

/**
 * Applies the persisted-result ceilings — 500 rows, 64 columns, 20,000 cells,
 * 2,000 characters per string cell, and 1 MiB UTF-8 serialized payload,
 * whichever binds first — and rejects nonfinite/object cells. A zero-row
 * result is a success. `rowCountExact` is derived, never claimed from a
 * bounded worker that could not establish the total.
 */
export function normalizeAnalysisResult(input: AnalysisResultInput): NormalizedAnalysisResult {
  if (!Array.isArray(input.columns)) fail("result columns must be an array");
  if (!Array.isArray(input.rows)) fail("result rows must be an array");
  if (input.columns.length > ANALYSIS_RESULT_COLUMNS_MAX)
    fail(`at most ${ANALYSIS_RESULT_COLUMNS_MAX} columns are persistable`);
  if (input.rows.length > ANALYSIS_RESULT_ROWS_MAX) fail(`at most ${ANALYSIS_RESULT_ROWS_MAX} rows are persistable`);
  const columns = input.columns.map((column) => {
    const name = typeof column === "string" ? column : String(column ?? "");
    if (typeof column !== "string" || name.length < 1 || name.length > ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS)
      fail(`column names must be 1..${ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS} characters`);
    return name;
  });

  const rows: AnalysisResultCell[][] = [];
  let cells = 0;
  for (const candidate of input.rows) {
    if (!Array.isArray(candidate)) fail("every result row must be an array");
    if (candidate.length !== columns.length) fail("every result row must match the column count");
    cells += candidate.length;
    if (cells > ANALYSIS_RESULT_CELLS_MAX) fail(`at most ${ANALYSIS_RESULT_CELLS_MAX} cells are persistable`);
    rows.push(candidate.map((cell) => validateResultCell(cell)));
  }

  const serialized = JSON.stringify(rows);
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  if (payloadBytes > ANALYSIS_RESULT_PAYLOAD_MAX_BYTES)
    fail(`serialized row payload exceeds ${ANALYSIS_RESULT_PAYLOAD_MAX_BYTES} bytes`);

  let sourceRowTotal: number | null = null;
  if (input.sourceRowTotal !== undefined && input.sourceRowTotal !== null) {
    if (
      typeof input.sourceRowTotal !== "number" ||
      !Number.isSafeInteger(input.sourceRowTotal) ||
      input.sourceRowTotal < 0
    )
      fail("sourceRowTotal must be a nonnegative safe integer or null");
    sourceRowTotal = input.sourceRowTotal;
  }
  const workerTruncated = Boolean(input.truncated);
  const declaredReasons = (Array.isArray(input.reasons) ? input.reasons : []).map((reason) =>
    boundedText(reason, "completeness reason", 80)
  );
  const reasons = [...new Set([...declaredReasons, ...(workerTruncated ? ["worker-truncated"] : [])])].slice(0, 8);
  // The exact-total label is only claimed when the worker established the
  // total and no truncation was signaled; a null total never implies exactness.
  const rowCountExact = !workerTruncated && sourceRowTotal !== null && sourceRowTotal === rows.length;
  const complete =
    reasons.length === 0 && !workerTruncated && (sourceRowTotal === null || sourceRowTotal === rows.length);

  return Object.freeze({
    columns: Object.freeze(columns.map((name, index) => Object.freeze({ name, type: inferColumnType(rows, index) }))),
    rows: Object.freeze(rows.map((row) => Object.freeze([...row]))),
    returnedRows: rows.length,
    sourceRowTotal,
    rowCountExact,
    completeness: Object.freeze({ complete, reasons: Object.freeze(reasons) }),
    payloadBytes,
  });
}
