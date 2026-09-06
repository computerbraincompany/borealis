import { randomUUID } from "node:crypto";

import {
  decodeBoolean,
  decodeIsoTimestamp,
  decodeJson,
  decodeSafeInteger,
  encodeBoolean,
  encodeIsoTimestamp,
  encodeJson,
} from "../codecs.js";
import type { SqliteLedger, SqliteTransaction } from "../types.js";
import {
  catalogStorePage,
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../../catalogPagination.js";
import {
  ANALYSIS_RETAINED_RESULTS_MAX,
  analysisSourceContentIdentity,
  normalizeAnalysisDefinition,
  normalizeAnalysisResult,
  normalizeComparisonKey,
  normalizeParameterDeclarations,
  normalizeSourceIds,
  resolveParameterBindings,
  type AnalysisParameterBinding,
  type AnalysisParameterDeclaration,
  type AnalysisResultInput,
  type AnalysisRunStatus,
  type StoredAnalysis,
  type StoredAnalysisResult,
  type StoredAnalysisRevision,
  type StoredAnalysisRun,
  type StoredAnalysisRunSource,
  type StoredAnalysisSourceBinding,
} from "../../analysisTypes.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AnalysisStoreErrorCode =
  | "ANALYSIS_NOT_FOUND"
  | "ANALYSIS_RUN_NOT_FOUND"
  | "ANALYSIS_REVISION_CONFLICT"
  | "ANALYSIS_ACTIVE_RUN"
  | "ANALYSIS_RESULT_QUOTA_EXCEEDED"
  | "ANALYSIS_RUN_STATE";

export class AnalysisStoreError extends Error {
  constructor(
    readonly code: AnalysisStoreErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "AnalysisStoreError";
  }
}

export class AnalysisNotFoundError extends AnalysisStoreError {
  constructor(options: ErrorOptions = {}) {
    super("ANALYSIS_NOT_FOUND", "analysis not found", options);
    this.name = "AnalysisNotFoundError";
  }
}

export class AnalysisRunNotFoundError extends AnalysisStoreError {
  constructor(options: ErrorOptions = {}) {
    super("ANALYSIS_RUN_NOT_FOUND", "analysis run not found", options);
    this.name = "AnalysisRunNotFoundError";
  }
}

export class AnalysisRevisionConflictError extends AnalysisStoreError {
  constructor(options: ErrorOptions = {}) {
    super("ANALYSIS_REVISION_CONFLICT", "analysis revision conflict", options);
    this.name = "AnalysisRevisionConflictError";
  }
}

export class AnalysisActiveRunError extends AnalysisStoreError {
  constructor(options: ErrorOptions = {}) {
    super("ANALYSIS_ACTIVE_RUN", "analysis already has an active run", options);
    this.name = "AnalysisActiveRunError";
  }
}

export class AnalysisQuotaError extends AnalysisStoreError {
  constructor(options: ErrorOptions = {}) {
    super(
      "ANALYSIS_RESULT_QUOTA_EXCEEDED",
      `at most ${ANALYSIS_RETAINED_RESULTS_MAX} results are retained per analysis`,
      options
    );
    this.name = "AnalysisQuotaError";
  }
}

export class AnalysisRunStateError extends AnalysisStoreError {
  constructor(options: ErrorOptions = {}) {
    super("ANALYSIS_RUN_STATE", "analysis run is not in a state that accepts this transition", options);
    this.name = "AnalysisRunStateError";
  }
}

// ---------------------------------------------------------------------------
// Input/output shapes
// ---------------------------------------------------------------------------

export interface AnalysisStoreOptions {
  readonly now?: () => Date;
}

/** Expected source state captured by an earlier phase (M16 refresh, stage 2 lease probe). */
export interface ExpectedSourceSnapshotEntry {
  readonly sourceId: string;
  readonly readyGeneration: number;
  readonly contentIdentity?: string | null;
}

export interface AcceptAnalysisRunInput {
  /** Client operation UUID; a retried acceptance for the same owner+analysis replays. */
  readonly operationId?: string | null;
  /** Optional optimistic guard against a concurrent definition edit. */
  readonly expectedRevision?: number | null;
  /** Typed parameter values keyed by declared name. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** Optional generation/content snapshot CAS compared at this admission boundary. */
  readonly expectedSourceSnapshot?: readonly ExpectedSourceSnapshotEntry[] | null;
  readonly schemaFingerprint?: string | null;
}

export type AcceptAnalysisRunOutcome = "queued" | "replayed" | "stale-inputs";

export interface AcceptAnalysisRunResult {
  readonly run: StoredAnalysisRun;
  readonly outcome: AcceptAnalysisRunOutcome;
}

export interface PublishAnalysisRunResultInput extends AnalysisResultInput {
  readonly id: string;
}

export type PublishAnalysisRunResult =
  Readonly<{ status: "published"; result: StoredAnalysisResult }> | Readonly<{ status: "cancelled" }>;

export interface AnalysisSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly currentRevision: number;
  readonly sourceCount: number;
  readonly unavailableSourceCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AnalysisRunSummary {
  readonly id: string;
  readonly analysisId: string;
  readonly revision: number;
  readonly status: AnalysisRunStatus;
  readonly cancelRequested: boolean;
  readonly operationId: string | null;
  readonly schemaFingerprint: string | null;
  readonly errorCode: string | null;
  readonly errorReason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface AnalysisResultSummary {
  readonly id: string;
  readonly runId: string;
  readonly revision: number;
  readonly returnedRows: number;
  readonly sourceRowTotal: number | null;
  readonly rowCountExact: boolean;
  readonly complete: boolean;
  readonly completenessReasons: readonly string[];
  readonly schemaFingerprint: string | null;
  readonly createdAt: string;
}

export interface UpdateAnalysisPatch {
  readonly title?: string;
  readonly description?: string;
  readonly sql?: string;
  readonly parameters?: readonly unknown[];
  /** Presence (not emptiness) rewrites the explicit selected source set. */
  readonly sourceIds?: readonly string[];
  /** Explicit null clears the comparison key; omission preserves it. */
  readonly comparisonKey?: readonly string[] | null;
}

export interface PublishAnalysisRunResultTestHooks {
  /** Transaction barrier for behavior tests. Production callers must omit it. */
  readonly afterQuotaChecked?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Input hygiene and row decoding
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_COLUMNS = `id,account_id,analysis_id,revision,status,cancel_requested,operation_id,parameter_values,
                     schema_fingerprint,error_code,error_reason,created_at,started_at,finished_at`;

const RESULT_COLUMNS = `id,account_id,analysis_id,run_id,revision,columns,rows,returned_rows,source_row_total,
                        row_count_exact,completeness,parameter_values,source_provenance,schema_fingerprint,created_at`;

function uuidIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function textValue(value: string, field: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    (!allowEmpty && value.length < 1) ||
    value.length > maximum
  ) {
    throw new TypeError(`${field} violates the analysis store input contract`);
  }
  return value;
}

function optionalText(value: string | null | undefined, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return textValue(value, field, maximum);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is not stored as text`);
  return value;
}

function optionalStoredString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function runStatus(value: unknown): AnalysisRunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "stale-inputs"
  ) {
    return value;
  }
  throw new TypeError("analysis run status violates the analysis store contract");
}

function isTerminal(status: AnalysisRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "stale-inputs";
}

interface HeadRow {
  id?: unknown;
  account_id?: unknown;
  title?: unknown;
  description?: unknown;
  current_revision?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  source_count?: unknown;
  unavailable_count?: unknown;
}

interface AnalysisDetailRow {
  id?: unknown;
  account_id?: unknown;
  current_revision?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  revision?: unknown;
  rev_title?: unknown;
  rev_description?: unknown;
  sql?: unknown;
  parameters?: unknown;
  source_ids?: unknown;
  comparison_key?: unknown;
  origin_chat_id?: unknown;
  origin_run_id?: unknown;
  origin_capture_id?: unknown;
  rev_created_at?: unknown;
}

interface RevisionRow {
  revision?: unknown;
  account_id?: unknown;
  title?: unknown;
  description?: unknown;
  sql?: unknown;
  parameters?: unknown;
  source_ids?: unknown;
  comparison_key?: unknown;
  origin_chat_id?: unknown;
  origin_run_id?: unknown;
  origin_capture_id?: unknown;
}

interface BindingRow {
  source_id?: unknown;
  ready_generation?: unknown;
  content_identity?: unknown;
  unavailable_at?: unknown;
  bound_at?: unknown;
}

interface RunRow {
  id?: unknown;
  account_id?: unknown;
  analysis_id?: unknown;
  revision?: unknown;
  status?: unknown;
  cancel_requested?: unknown;
  operation_id?: unknown;
  parameter_values?: unknown;
  schema_fingerprint?: unknown;
  error_code?: unknown;
  error_reason?: unknown;
  created_at?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
}

interface RunSourceRow {
  source_id?: unknown;
  ready_generation?: unknown;
  content_identity?: unknown;
}

interface ResultRow {
  id?: unknown;
  account_id?: unknown;
  analysis_id?: unknown;
  run_id?: unknown;
  revision?: unknown;
  columns?: unknown;
  rows?: unknown;
  returned_rows?: unknown;
  source_row_total?: unknown;
  row_count_exact?: unknown;
  completeness?: unknown;
  parameter_values?: unknown;
  source_provenance?: unknown;
  schema_fingerprint?: unknown;
  created_at?: unknown;
}

interface SourceStateRow {
  id?: unknown;
  status?: unknown;
  ready_generation?: unknown;
  file_path?: unknown;
  size_bytes?: unknown;
}

interface CountRow {
  count?: unknown;
}

function decodeParameterDeclarations(value: unknown, field: string): readonly AnalysisParameterDeclaration[] {
  const parsed: unknown = decodeJson(value, field);
  if (!Array.isArray(parsed)) throw new TypeError(`${field} is not stored as an array`);
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new TypeError(`${field} holds a malformed declaration`);
    const record = candidate as Record<string, unknown>;
    const type = record.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "date") {
      throw new TypeError(`${field} holds an unsupported parameter type`);
    }
    const declaration: {
      name: string;
      type: AnalysisParameterDeclaration["type"];
      required: boolean;
      nullable: boolean;
      default?: AnalysisParameterBinding["value"];
      label?: string;
      description?: string;
    } = {
      name: requiredString(record.name, `${field} name`),
      type,
      required: record.required === true,
      nullable: record.nullable === true,
    };
    if (record.default !== undefined) declaration.default = record.default as AnalysisParameterBinding["value"];
    if (typeof record.label === "string") declaration.label = record.label;
    if (typeof record.description === "string") declaration.description = record.description;
    return Object.freeze(declaration);
  });
}

function decodeParameterBindings(value: unknown, field: string): readonly AnalysisParameterBinding[] {
  const parsed: unknown = decodeJson(value, field);
  if (!Array.isArray(parsed)) throw new TypeError(`${field} is not stored as an array`);
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new TypeError(`${field} holds a malformed binding`);
    const record = candidate as Record<string, unknown>;
    const type = record.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "date") {
      throw new TypeError(`${field} holds an unsupported parameter type`);
    }
    return Object.freeze({
      name: requiredString(record.name, `${field} name`),
      type,
      value: record.value as AnalysisParameterBinding["value"],
    });
  });
}

function decodeStringArray(value: unknown, field: string): readonly string[] {
  const parsed: unknown = decodeJson(value, field);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new TypeError(`${field} is not stored as a string array`);
  }
  return parsed as string[];
}

function decodeRunSource(row: RunSourceRow): StoredAnalysisRunSource {
  return Object.freeze({
    sourceId: uuidIdentity(row.source_id, "analysis run source id"),
    readyGeneration: decodeSafeInteger(row.ready_generation, "analysis run source ready generation"),
    contentIdentity: requiredString(row.content_identity, "analysis run source content identity"),
  });
}

function decodeRunSources(value: unknown, field: string): readonly StoredAnalysisRunSource[] {
  const parsed: unknown = decodeJson(value, field);
  if (!Array.isArray(parsed)) throw new TypeError(`${field} is not stored as an array`);
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new TypeError(`${field} holds a malformed provenance row`);
    const record = candidate as Record<string, unknown>;
    return decodeRunSource({
      source_id: record.source_id,
      ready_generation: record.ready_generation,
      content_identity: record.content_identity,
    });
  });
}

function decodeBinding(row: BindingRow): StoredAnalysisSourceBinding {
  return Object.freeze({
    sourceId: uuidIdentity(row.source_id, "analysis binding source id"),
    readyGeneration:
      row.ready_generation === null || row.ready_generation === undefined
        ? null
        : decodeSafeInteger(row.ready_generation, "analysis binding ready generation"),
    contentIdentity: optionalStoredString(row.content_identity, "analysis binding content identity"),
    unavailableAt:
      row.unavailable_at === null || row.unavailable_at === undefined
        ? null
        : decodeIsoTimestamp(row.unavailable_at, "analysis binding unavailable_at"),
    boundAt: decodeIsoTimestamp(row.bound_at, "analysis binding bound_at"),
  });
}

function decodeRun(row: RunRow): StoredAnalysisRun {
  return Object.freeze({
    id: uuidIdentity(row.id, "analysis run id"),
    accountId: uuidIdentity(row.account_id, "analysis run account id"),
    analysisId: uuidIdentity(row.analysis_id, "analysis run analysis id"),
    revision: decodeSafeInteger(row.revision, "analysis run revision"),
    status: runStatus(row.status),
    cancelRequested: decodeBoolean(row.cancel_requested, "analysis run cancel_requested"),
    operationId: optionalStoredString(row.operation_id, "analysis run operation id"),
    parameterBindings: decodeParameterBindings(row.parameter_values, "analysis run parameter values"),
    schemaFingerprint: optionalStoredString(row.schema_fingerprint, "analysis run schema fingerprint"),
    errorCode: optionalStoredString(row.error_code, "analysis run error_code"),
    errorReason: optionalStoredString(row.error_reason, "analysis run error_reason"),
    createdAt: decodeIsoTimestamp(row.created_at, "analysis run created_at"),
    startedAt:
      row.started_at === null || row.started_at === undefined
        ? null
        : decodeIsoTimestamp(row.started_at, "analysis run started_at"),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : decodeIsoTimestamp(row.finished_at, "analysis run finished_at"),
    sources: Object.freeze([]),
  });
}

function decodeRunSummary(row: RunRow): AnalysisRunSummary {
  return Object.freeze({
    id: uuidIdentity(row.id, "analysis run id"),
    analysisId: uuidIdentity(row.analysis_id, "analysis run analysis id"),
    revision: decodeSafeInteger(row.revision, "analysis run revision"),
    status: runStatus(row.status),
    cancelRequested: decodeBoolean(row.cancel_requested, "analysis run cancel_requested"),
    operationId: optionalStoredString(row.operation_id, "analysis run operation id"),
    schemaFingerprint: optionalStoredString(row.schema_fingerprint, "analysis run schema fingerprint"),
    errorCode: optionalStoredString(row.error_code, "analysis run error_code"),
    errorReason: optionalStoredString(row.error_reason, "analysis run error_reason"),
    createdAt: decodeIsoTimestamp(row.created_at, "analysis run created_at"),
    startedAt:
      row.started_at === null || row.started_at === undefined
        ? null
        : decodeIsoTimestamp(row.started_at, "analysis run started_at"),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : decodeIsoTimestamp(row.finished_at, "analysis run finished_at"),
  });
}

function decodeResult(row: ResultRow, includeRows: boolean): StoredAnalysisResult {
  const completeness = decodeJson<{ complete?: unknown; reasons?: unknown }>(
    row.completeness,
    "analysis result completeness"
  );
  const reasons = Array.isArray(completeness.reasons)
    ? completeness.reasons.map((reason) => requiredString(reason, "completeness reason"))
    : [];
  const columns = decodeJson<unknown[]>(row.columns, "analysis result columns").map((column) => {
    if (!column || typeof column !== "object" || Array.isArray(column))
      throw new TypeError("analysis result columns hold a malformed entry");
    const record = column as Record<string, unknown>;
    const type = record.type;
    if (type !== "empty" && type !== "number" && type !== "string" && type !== "boolean" && type !== "mixed") {
      throw new TypeError("analysis result columns hold an unsupported scalar type");
    }
    return Object.freeze({ name: requiredString(record.name, "analysis result column name"), type });
  });
  return Object.freeze({
    id: uuidIdentity(row.id, "analysis result id"),
    accountId: uuidIdentity(row.account_id, "analysis result account id"),
    analysisId: uuidIdentity(row.analysis_id, "analysis result analysis id"),
    runId: uuidIdentity(row.run_id, "analysis result run id"),
    revision: decodeSafeInteger(row.revision, "analysis result revision"),
    columns: Object.freeze(columns),
    rows: includeRows
      ? Object.freeze(
          decodeJson<unknown[]>(row.rows, "analysis result rows").map((storedRow) => {
            if (!Array.isArray(storedRow)) throw new TypeError("analysis result rows hold a malformed row");
            return Object.freeze([...storedRow]);
          })
        )
      : Object.freeze([]),
    returnedRows: decodeSafeInteger(row.returned_rows, "analysis result returned_rows"),
    sourceRowTotal:
      row.source_row_total === null || row.source_row_total === undefined
        ? null
        : decodeSafeInteger(row.source_row_total, "analysis result source_row_total"),
    rowCountExact: decodeBoolean(row.row_count_exact, "analysis result row_count_exact"),
    completeness: Object.freeze({ complete: completeness.complete === true, reasons: Object.freeze(reasons) }),
    parameterBindings: decodeParameterBindings(row.parameter_values, "analysis result parameter values"),
    sourceProvenance: decodeRunSources(row.source_provenance, "analysis result source provenance"),
    schemaFingerprint: optionalStoredString(row.schema_fingerprint, "analysis result schema fingerprint"),
    createdAt: decodeIsoTimestamp(row.created_at, "analysis result created_at"),
  });
}

function decodeResultSummary(row: ResultRow): AnalysisResultSummary {
  const result = decodeResult(row, false);
  return Object.freeze({
    id: result.id,
    runId: result.runId,
    revision: result.revision,
    returnedRows: result.returnedRows,
    sourceRowTotal: result.sourceRowTotal,
    rowCountExact: result.rowCountExact,
    complete: result.completeness.complete,
    completenessReasons: result.completeness.reasons,
    schemaFingerprint: result.schemaFingerprint,
    createdAt: result.createdAt,
  });
}

/**
 * Deterministic content/version identity for a live source row: the SQLite
 * authoritative generation plus the physical file identity. A connector
 * refresh that replaces bytes publishes a new location/generation pair, which
 * the run admission snapshot CAS compares against.
 */
function sourceContentIdentity(row: SourceStateRow): string {
  return analysisSourceContentIdentity({
    readyGeneration: decodeSafeInteger(row.ready_generation, "source ready generation"),
    sizeBytes: decodeSafeInteger(row.size_bytes, "source size bytes"),
    filePath: optionalStoredString(row.file_path, "source file path"),
  });
}

function placeholders(length: number): string {
  return new Array<string>(length).fill("?").join(",");
}

interface ResolvedSource {
  readonly sourceId: string;
  readonly readyGeneration: number;
  readonly contentIdentity: string;
}

function validateExpectedSnapshot(
  value: readonly ExpectedSourceSnapshotEntry[] | null | undefined
): readonly ExpectedSourceSnapshotEntry[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError("expectedSourceSnapshot must be an array of at most 100 entries");
  }
  return Object.freeze(
    value.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new TypeError("expectedSourceSnapshot holds a malformed entry");
      const sourceId = uuidIdentity(entry.sourceId, "expected snapshot source id");
      const readyGeneration = decodeSafeInteger(entry.readyGeneration, "expected snapshot ready generation");
      if (readyGeneration < 0) throw new RangeError("expected snapshot ready generation must be >= 0");
      return Object.freeze({
        sourceId,
        readyGeneration,
        contentIdentity:
          entry.contentIdentity === undefined || entry.contentIdentity === null
            ? null
            : textValue(entry.contentIdentity, "expected snapshot content identity", 33_000),
      });
    })
  );
}

interface RevisionContent {
  title: string;
  description: string;
  sql: string;
  parameters: readonly AnalysisParameterDeclaration[];
  sourceIds: readonly string[];
  comparisonKey: readonly string[] | null;
  originChatId: string | null;
  originRunId: string | null;
  originCaptureId: string | null;
}

function revisionFromRow(row: RevisionRow): RevisionContent {
  return {
    title: requiredString(row.title, "analysis revision title"),
    description: optionalStoredString(row.description, "analysis revision description") ?? "",
    sql: requiredString(row.sql, "analysis revision sql"),
    parameters: decodeParameterDeclarations(row.parameters, "analysis revision parameters"),
    sourceIds: decodeStringArray(row.source_ids, "analysis revision source ids"),
    comparisonKey:
      row.comparison_key === null || row.comparison_key === undefined
        ? null
        : decodeStringArray(row.comparison_key, "analysis revision comparison key"),
    originChatId: optionalStoredString(row.origin_chat_id, "analysis revision origin chat id"),
    originRunId: optionalStoredString(row.origin_run_id, "analysis revision origin run id"),
    originCaptureId: optionalStoredString(row.origin_capture_id, "analysis revision origin capture id"),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AnalysisStore {
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: AnalysisStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // -- Definitions -----------------------------------------------------------

  async createAnalysis(accountIdValue: string, input: unknown): Promise<StoredAnalysis> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const definition = normalizeAnalysisDefinition(input);
    const analysisId = randomUUID();
    const timestamp = this.timestamp();

    await this.ledger.withImmediateTransaction((transaction) => {
      const user = transaction.get("SELECT 1 FROM users WHERE id=?", [accountId]);
      if (!user) throw new AnalysisNotFoundError({ cause: new Error("account does not exist") });
      this.assertSourceIdsOwned(transaction, accountId, definition.sourceIds);
      transaction.run(
        `INSERT INTO analyses (id,account_id,title,description,current_revision,created_at,updated_at)
         VALUES (?,?,?,?,1,?,?)`,
        [analysisId, accountId, definition.title, definition.description, timestamp, timestamp]
      );
      this.insertRevision(transaction, accountId, analysisId, 1, definition, timestamp);
      this.rewriteBindings(transaction, accountId, analysisId, definition.sourceIds, timestamp);
    });

    const stored = await this.getAnalysis(accountId, analysisId);
    if (!stored) throw new AnalysisNotFoundError();
    return stored;
  }

  async getAnalysis(accountIdValue: string, analysisIdValue: string): Promise<StoredAnalysis | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const row = await this.ledger.get<AnalysisDetailRow>(
      `SELECT a.id,a.account_id,a.current_revision,a.created_at,a.updated_at,
              r.revision,r.title AS rev_title,r.description AS rev_description,r.sql,r.parameters,r.source_ids,
              r.comparison_key,r.origin_chat_id,r.origin_run_id,r.origin_capture_id,r.created_at AS rev_created_at
       FROM analyses a
       JOIN analysis_revisions r
         ON r.analysis_id=a.id AND r.revision=a.current_revision AND r.account_id=a.account_id
       WHERE a.id=? AND a.account_id=?`,
      [analysisId, accountId]
    );
    if (!row) return undefined;
    const bindings = await this.ledger.all<BindingRow>(
      `SELECT source_id,ready_generation,content_identity,unavailable_at,bound_at
       FROM analysis_sources WHERE analysis_id=? AND account_id=?`,
      [analysisId, accountId]
    );
    const revision = Object.freeze({
      revision: decodeSafeInteger(row.revision, "analysis revision number"),
      title: requiredString(row.rev_title, "analysis revision title"),
      description: optionalStoredString(row.rev_description, "analysis revision description") ?? "",
      sql: requiredString(row.sql, "analysis revision sql"),
      parameters: decodeParameterDeclarations(row.parameters, "analysis revision parameters"),
      sourceIds: decodeStringArray(row.source_ids, "analysis revision source ids"),
      comparisonKey:
        row.comparison_key === null || row.comparison_key === undefined
          ? null
          : Object.freeze([...decodeStringArray(row.comparison_key, "analysis revision comparison key")]),
      originChatId: optionalStoredString(row.origin_chat_id, "analysis origin chat id"),
      originRunId: optionalStoredString(row.origin_run_id, "analysis origin run id"),
      originCaptureId: optionalStoredString(row.origin_capture_id, "analysis origin capture id"),
      createdAt: decodeIsoTimestamp(row.rev_created_at, "analysis revision created_at"),
    }) satisfies StoredAnalysisRevision;
    const byId = new Map(
      bindings.map((binding) => [uuidIdentity(binding.source_id, "binding source id"), decodeBinding(binding)])
    );
    return Object.freeze({
      id: uuidIdentity(row.id, "analysis id"),
      accountId: uuidIdentity(row.account_id, "analysis account id"),
      currentRevision: decodeSafeInteger(row.current_revision, "analysis current revision"),
      createdAt: decodeIsoTimestamp(row.created_at, "analysis created_at"),
      updatedAt: decodeIsoTimestamp(row.updated_at, "analysis updated_at"),
      revision,
      sources: Object.freeze(
        revision.sourceIds
          .map((sourceId) => byId.get(sourceId))
          .filter((binding): binding is StoredAnalysisSourceBinding => binding !== undefined)
      ),
    });
  }

  async listAnalyses(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<AnalysisSummary>> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId];
    const after = page.after ? " AND (a.created_at,a.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<HeadRow>(
      `SELECT a.id,a.title,a.description,a.current_revision,a.created_at,a.updated_at,
              (SELECT COUNT(*) FROM analysis_sources s
                WHERE s.analysis_id=a.id AND s.account_id=a.account_id) AS source_count,
              (SELECT COUNT(*) FROM analysis_sources s
                WHERE s.analysis_id=a.id AND s.account_id=a.account_id AND s.unavailable_at IS NOT NULL) AS unavailable_count
       FROM analyses a
       WHERE a.account_id=?${after}
       ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) =>
        Object.freeze({
          id: uuidIdentity(row.id, "analysis id"),
          title: requiredString(row.title, "analysis title"),
          description: optionalStoredString(row.description, "analysis description") ?? "",
          currentRevision: decodeSafeInteger(row.current_revision, "analysis current revision"),
          sourceCount: decodeSafeInteger(row.source_count, "analysis source count"),
          unavailableSourceCount: decodeSafeInteger(row.unavailable_count, "analysis unavailable source count"),
          createdAt: decodeIsoTimestamp(row.created_at, "analysis created_at"),
          updatedAt: decodeIsoTimestamp(row.updated_at, "analysis updated_at"),
        })
      ),
      page,
      (item) => ({ timestamp: item.createdAt, id: item.id })
    );
  }

  /**
   * Optimistic revision-checked edit. The head CAS and the immutable revision
   * insert commit together; a lost race raises AnalysisRevisionConflictError
   * and never writes a revision row. Passing `sourceIds` rewrites the
   * explicit selected set (re-capturing identities for surviving sources) —
   * empty input yields a selected-empty definition that never widens.
   */
  async updateAnalysis(
    accountIdValue: string,
    analysisIdValue: string,
    expectedRevision: number,
    patch: UpdateAnalysisPatch
  ): Promise<StoredAnalysis> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new RangeError("expectedRevision must be a positive safe integer");
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("analysis edit must be an object");
    }
    for (const key of Object.keys(patch)) {
      if (!["title", "description", "sql", "parameters", "sourceIds", "comparisonKey"].includes(key)) {
        throw new TypeError(`unknown analysis edit field "${key}"`);
      }
    }
    const title = patch.title === undefined ? undefined : textValue(patch.title, "title", 200);
    const description =
      patch.description === undefined || patch.description === null
        ? undefined
        : textValue(patch.description, "description", 2_000, true);
    const sql = patch.sql === undefined ? undefined : textValue(patch.sql, "sql", 20_000);
    const parameters = patch.parameters === undefined ? undefined : normalizeParameterDeclarations(patch.parameters);
    const sourceIds = patch.sourceIds === undefined ? undefined : normalizeSourceIds(patch.sourceIds);
    const comparisonKey = patch.comparisonKey === undefined ? undefined : normalizeComparisonKey(patch.comparisonKey);
    const timestamp = this.timestamp();

    await this.ledger.withImmediateTransaction((transaction) => {
      const head = transaction.get<{ current_revision?: unknown }>(
        "SELECT current_revision FROM analyses WHERE id=? AND account_id=?",
        [analysisId, accountId]
      );
      if (!head) throw new AnalysisNotFoundError();
      const cas = transaction.run(
        `UPDATE analyses
         SET title=COALESCE(?,title),description=COALESCE(?,description),
             current_revision=current_revision+1,updated_at=?
         WHERE id=? AND account_id=? AND current_revision=?`,
        [title ?? null, description ?? null, timestamp, analysisId, accountId, expectedRevision]
      );
      if (cas.changes !== 1) throw new AnalysisRevisionConflictError();
      const current = transaction.get<RevisionRow>(
        "SELECT * FROM analysis_revisions WHERE analysis_id=? AND revision=? AND account_id=?",
        [analysisId, expectedRevision, accountId]
      );
      if (!current) throw new AnalysisRevisionConflictError({ cause: new Error("current revision row is missing") });
      const base = revisionFromRow(current);
      if (sourceIds !== undefined) this.assertSourceIdsOwned(transaction, accountId, sourceIds);
      this.insertRevision(
        transaction,
        accountId,
        analysisId,
        expectedRevision + 1,
        {
          title: title ?? base.title,
          description: description ?? base.description,
          sql: sql ?? base.sql,
          parameters: parameters ?? base.parameters,
          sourceIds: sourceIds ?? base.sourceIds,
          comparisonKey: comparisonKey === undefined ? base.comparisonKey : comparisonKey,
          originChatId: base.originChatId,
          originRunId: base.originRunId,
          originCaptureId: base.originCaptureId,
        },
        timestamp
      );
      if (sourceIds !== undefined) {
        this.rewriteBindings(transaction, accountId, analysisId, sourceIds, timestamp);
      }
    });

    const stored = await this.getAnalysis(accountId, analysisId);
    if (!stored) throw new AnalysisNotFoundError();
    return stored;
  }

  /**
   * Deletes the definition, revisions, bindings, run history, and results.
   * A run owned by a live executor (`running`) must be cancelled and drained
   * first — deletion refuses rather than orphan it. Undispatched `queued`
   * runs are cancelled by this cascade. Copied report/document snapshots
   * (M13) live in separate rows and survive this deletion.
   */
  async deleteAnalysis(accountIdValue: string, analysisIdValue: string): Promise<boolean> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const head = transaction.get("SELECT 1 FROM analyses WHERE id=? AND account_id=?", [analysisId, accountId]);
      if (!head) return false;
      const active = transaction.get(
        "SELECT 1 FROM analysis_runs WHERE analysis_id=? AND account_id=? AND status='running' LIMIT 1",
        [analysisId, accountId]
      );
      if (active) throw new AnalysisActiveRunError();
      return transaction.run("DELETE FROM analyses WHERE id=? AND account_id=?", [analysisId, accountId]).changes === 1;
    });
  }

  // -- Runs --------------------------------------------------------------------

  /**
   * Immutable run acceptance. Freezes the head revision, resolved parameter
   * bindings, the concrete ready source set with generations and content
   * identities, and the optional schema fingerprint inside ONE transaction —
   * mirroring `acceptChatTurn` atomicity. The frozen provenance never reads
   * the mutable definition or source rows again, so later edits, source
   * refresh, and source deletion cannot retarget an accepted run.
   *
   * Outcomes:
   * - `queued`: a durable active run for a later stage to dispatch.
   * - `replayed`: a retried acceptance with the same operation UUID for the
   *   same owner+analysis returns the original run unchanged.
   * - `stale-inputs`: an explicit durable terminal run recording unavailable
   *   inputs or a failed expected-snapshot CAS; never executed, never silent.
   */
  async acceptAnalysisRun(
    accountIdValue: string,
    analysisIdValue: string,
    input: AcceptAnalysisRunInput = {}
  ): Promise<AcceptAnalysisRunResult> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const operationId =
      input.operationId === undefined || input.operationId === null
        ? null
        : uuidIdentity(input.operationId, "operation id");
    const expectedRevision =
      input.expectedRevision === undefined || input.expectedRevision === null
        ? null
        : decodeSafeInteger(input.expectedRevision, "expected revision");
    if (expectedRevision !== null && expectedRevision < 1) throw new RangeError("expected revision must be >= 1");
    const schemaFingerprint = optionalText(input.schemaFingerprint, "schema fingerprint", 512);
    const expectedSnapshot = validateExpectedSnapshot(input.expectedSourceSnapshot);

    return this.ledger.withImmediateTransaction((transaction) => {
      const head = transaction.get<{ current_revision?: unknown }>(
        "SELECT current_revision FROM analyses WHERE id=? AND account_id=?",
        [analysisId, accountId]
      );
      if (!head) throw new AnalysisNotFoundError();

      if (operationId !== null) {
        const replay = transaction.get<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM analysis_runs WHERE account_id=? AND analysis_id=? AND operation_id=?`,
          [accountId, analysisId, operationId]
        );
        if (replay) {
          return Object.freeze({
            run: this.attachRunSources(transaction, decodeRun(replay)),
            outcome: "replayed" as const,
          });
        }
      }

      const headRevision = decodeSafeInteger(head.current_revision, "analysis current revision");
      if (expectedRevision !== null && expectedRevision !== headRevision) {
        throw new AnalysisRevisionConflictError();
      }
      const current = transaction.get<RevisionRow>(
        "SELECT * FROM analysis_revisions WHERE analysis_id=? AND revision=? AND account_id=?",
        [analysisId, headRevision, accountId]
      );
      if (!current) throw new AnalysisNotFoundError({ cause: new Error("current revision row is missing") });

      const bindings = resolveParameterBindings(
        decodeParameterDeclarations(current.parameters, "analysis revision parameters"),
        input.values
      );

      const retained = transaction.get<CountRow>(
        "SELECT COUNT(*) AS count FROM analysis_results WHERE analysis_id=? AND account_id=?",
        [analysisId, accountId]
      );
      if (decodeSafeInteger(retained?.count ?? 0, "retained results") >= ANALYSIS_RETAINED_RESULTS_MAX) {
        throw new AnalysisQuotaError();
      }
      const active = transaction.get(
        "SELECT 1 FROM analysis_runs WHERE analysis_id=? AND account_id=? AND status IN ('queued','running') LIMIT 1",
        [analysisId, accountId]
      );
      if (active) throw new AnalysisActiveRunError();

      const declaredSourceIds = decodeStringArray(current.source_ids, "analysis revision source ids");
      const live = new Map<string, SourceStateRow>();
      if (declaredSourceIds.length > 0) {
        const rows = transaction.all<SourceStateRow>(
          `SELECT id,status,ready_generation,file_path,size_bytes FROM sources
           WHERE account_id=? AND id IN (${placeholders(declaredSourceIds.length)})`,
          [accountId, ...declaredSourceIds]
        );
        for (const row of rows) live.set(uuidIdentity(row.id, "source id"), row);
      }
      const resolved: ResolvedSource[] = [];
      let staleReason: string | null = null;
      for (const sourceId of declaredSourceIds) {
        const row = live.get(sourceId);
        if (!row || row.status !== "ready" || row.ready_generation === null || row.ready_generation === undefined) {
          staleReason = "ANALYSIS_INPUTS_UNAVAILABLE";
          continue;
        }
        resolved.push({
          sourceId,
          readyGeneration: decodeSafeInteger(row.ready_generation, "source ready generation"),
          contentIdentity: sourceContentIdentity(row),
        });
      }
      if (staleReason === null && expectedSnapshot !== null) {
        const byId = new Map(resolved.map((source) => [source.sourceId, source]));
        if (
          expectedSnapshot.length !== resolved.length ||
          expectedSnapshot.some((entry) => {
            const source = byId.get(entry.sourceId);
            if (!source) return true;
            if (source.readyGeneration !== entry.readyGeneration) return true;
            return entry.contentIdentity !== null && entry.contentIdentity !== source.contentIdentity;
          })
        ) {
          staleReason = "ANALYSIS_SNAPSHOT_MISMATCH";
        }
      }

      const timestamp = this.timestamp();
      const status: AnalysisRunStatus = staleReason === null ? "queued" : "stale-inputs";
      const runId = randomUUID();
      transaction.run(
        `INSERT INTO analysis_runs
           (id,account_id,analysis_id,revision,status,cancel_requested,operation_id,parameter_values,
            schema_fingerprint,error_code,error_reason,created_at,started_at,finished_at)
         VALUES (?,?,?,?,?,0,?,?,?,?,?,?,NULL,?)`,
        [
          runId,
          accountId,
          analysisId,
          headRevision,
          status,
          operationId,
          encodeJson(bindings, "analysis run parameter values"),
          schemaFingerprint,
          staleReason,
          staleReason === null ? null : "saved analysis inputs are stale",
          timestamp,
          staleReason === null ? null : timestamp,
        ]
      );
      for (const source of resolved) {
        transaction.run(
          `INSERT INTO analysis_run_sources (run_id,source_id,account_id,ready_generation,content_identity)
           VALUES (?,?,?,?,?)`,
          [runId, source.sourceId, accountId, source.readyGeneration, source.contentIdentity]
        );
      }
      const stored = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM analysis_runs WHERE id=? AND account_id=?`, [
        runId,
        accountId,
      ]);
      if (!stored) throw new AnalysisRunStateError({ cause: new Error("accepted run vanished") });
      return Object.freeze({
        run: this.attachRunSources(transaction, decodeRun(stored)),
        outcome: (staleReason === null ? "queued" : "stale-inputs") as AcceptAnalysisRunOutcome,
      });
    });
  }

  async getAnalysisRun(
    accountIdValue: string,
    analysisIdValue: string,
    runIdValue: string
  ): Promise<StoredAnalysisRun | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const runId = uuidIdentity(runIdValue, "analysis run id");
    const row = await this.ledger.get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM analysis_runs WHERE id=? AND analysis_id=? AND account_id=?`,
      [runId, analysisId, accountId]
    );
    if (!row) return undefined;
    const sources = await this.ledger.all<RunSourceRow>(
      `SELECT source_id,ready_generation,content_identity FROM analysis_run_sources
       WHERE run_id=? AND account_id=? ORDER BY source_id`,
      [runId, accountId]
    );
    return Object.freeze({
      ...decodeRun(row),
      sources: Object.freeze(sources.map((sourceRow) => decodeRunSource(sourceRow))),
    });
  }

  async listAnalysisRuns(
    accountIdValue: string,
    analysisIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<AnalysisRunSummary>> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [analysisId, accountId];
    const after = page.after ? " AND (created_at,id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM analysis_runs
       WHERE analysis_id=? AND account_id=?${after}
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeRunSummary(row)),
      page,
      (item) => ({ timestamp: item.createdAt, id: item.id })
    );
  }

  /** queued -> running. A durable cancellation request cancels instead. */
  async markAnalysisRunRunning(
    accountIdValue: string,
    analysisIdValue: string,
    runIdValue: string
  ): Promise<StoredAnalysisRun> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const runId = uuidIdentity(runIdValue, "analysis run id");
    return this.ledger.withImmediateTransaction((transaction) => {
      let run = decodeRun(this.requireRunRow(transaction, accountId, analysisId, runId));
      if (run.status === "running") return this.attachRunSources(transaction, run);
      if (run.status !== "queued") throw new AnalysisRunStateError();
      if (run.cancelRequested) {
        this.cancelRunRow(transaction, accountId, analysisId, runId, this.timestamp());
        run = decodeRun(this.requireRunRow(transaction, accountId, analysisId, runId));
        return this.attachRunSources(transaction, run);
      }
      const updated = transaction.run(
        `UPDATE analysis_runs SET status='running',started_at=?
         WHERE id=? AND analysis_id=? AND account_id=? AND status='queued' AND cancel_requested=0`,
        [this.timestamp(), runId, analysisId, accountId]
      );
      if (updated.changes !== 1) throw new AnalysisRunStateError();
      return this.attachRunSources(
        transaction,
        decodeRun(this.requireRunRow(transaction, accountId, analysisId, runId))
      );
    });
  }

  /**
   * Requests cancellation. A queued run with no dispatched executor cancels
   * immediately; a running run records the durable request for its executor.
   * Terminal states are absorbing; `null` means the run is not owned.
   */
  async requestAnalysisRunCancel(
    accountIdValue: string,
    analysisIdValue: string,
    runIdValue: string
  ): Promise<AnalysisRunStatus | null> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const runId = uuidIdentity(runIdValue, "analysis run id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<RunRow>(
        "SELECT status,cancel_requested FROM analysis_runs WHERE id=? AND analysis_id=? AND account_id=?",
        [runId, analysisId, accountId]
      );
      if (!row) return null;
      const status = runStatus(row.status);
      if (isTerminal(status)) return status;
      if (status === "queued") {
        this.cancelRunRow(transaction, accountId, analysisId, runId, this.timestamp());
        return "cancelled" as const;
      }
      transaction.run(
        "UPDATE analysis_runs SET cancel_requested=1 WHERE id=? AND analysis_id=? AND account_id=? AND status='running'",
        [runId, analysisId, accountId]
      );
      return "running" as const;
    });
  }

  /** Durable terminal transition for failed/cancelled work; cancellation wins. */
  async finishAnalysisRun(
    accountIdValue: string,
    analysisIdValue: string,
    runIdValue: string,
    requestedStatus: "failed" | "cancelled",
    errorCodeValue?: string,
    errorReasonValue?: string
  ): Promise<AnalysisRunStatus> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const runId = uuidIdentity(runIdValue, "analysis run id");
    if (requestedStatus !== "failed" && requestedStatus !== "cancelled") {
      throw new TypeError("finishAnalysisRun may only fail or cancel a run");
    }
    const errorCode = errorCodeValue ? textValue(errorCodeValue, "run error code", 128) : null;
    const errorReason = optionalText(errorReasonValue, "run error reason", 500);
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = this.requireRunRow(transaction, accountId, analysisId, runId);
      const current = runStatus(row.status);
      if (isTerminal(current)) return current;
      const cancellationWins = decodeBoolean(row.cancel_requested, "analysis run cancel_requested");
      const status = cancellationWins ? "cancelled" : requestedStatus;
      const updated = transaction.run(
        `UPDATE analysis_runs SET status=?,cancel_requested=?,finished_at=?,error_code=?,error_reason=?
         WHERE id=? AND analysis_id=? AND account_id=? AND status IN ('queued','running')`,
        [
          status,
          encodeBoolean(cancellationWins || status === "cancelled"),
          this.timestamp(),
          status === "cancelled" ? "CANCELLED" : errorCode,
          status === "cancelled" ? null : errorReason,
          runId,
          analysisId,
          accountId,
        ]
      );
      if (updated.changes !== 1) throw new AnalysisRunStateError();
      return status;
    });
  }

  /** Executor-facing stale-inputs transition (lease-time snapshot drift). */
  async markAnalysisRunStaleInputs(
    accountIdValue: string,
    analysisIdValue: string,
    runIdValue: string,
    errorCodeValue = "ANALYSIS_INPUTS_STALE",
    errorReasonValue?: string
  ): Promise<AnalysisRunStatus> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const runId = uuidIdentity(runIdValue, "analysis run id");
    const errorCode = textValue(errorCodeValue, "stale error code", 128);
    const errorReason = optionalText(errorReasonValue, "stale error reason", 500) ?? "saved analysis inputs are stale";
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = this.requireRunRow(transaction, accountId, analysisId, runId);
      const current = runStatus(row.status);
      if (isTerminal(current)) return current;
      const updated = transaction.run(
        `UPDATE analysis_runs SET status='stale-inputs',finished_at=?,error_code=?,error_reason=?
         WHERE id=? AND analysis_id=? AND account_id=? AND status IN ('queued','running')`,
        [this.timestamp(), errorCode, errorReason, runId, analysisId, accountId]
      );
      if (updated.changes !== 1) throw new AnalysisRunStateError();
      return "stale-inputs" as const;
    });
  }

  // -- Results ------------------------------------------------------------------

  /**
   * A successful run publishes exactly one result transactionally: the quota
   * is checked, the immutable bounded snapshot is inserted, and the run flips
   * to `succeeded` inside the same immediate transaction. A retained
   * cancellation request wins and no result is ever published.
   */
  async publishAnalysisRunResult(
    accountIdValue: string,
    analysisIdValue: string,
    runIdValue: string,
    input: PublishAnalysisRunResultInput,
    hooks: PublishAnalysisRunResultTestHooks = {}
  ): Promise<PublishAnalysisRunResult> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const runId = uuidIdentity(runIdValue, "analysis run id");
    const resultId = uuidIdentity(input.id, "analysis result id");
    const normalized = normalizeAnalysisResult(input);
    const timestamp = this.timestamp();

    return this.ledger.withImmediateTransaction(async (transaction) => {
      const row = this.requireRunRow(transaction, accountId, analysisId, runId);
      const run = decodeRun(row);
      if (run.status === "succeeded") {
        const existing = transaction.get<ResultRow>(
          `SELECT ${RESULT_COLUMNS} FROM analysis_results WHERE run_id=? AND account_id=?`,
          [runId, accountId]
        );
        if (!existing) throw new AnalysisRunStateError({ cause: new Error("succeeded run has no result row") });
        return Object.freeze({ status: "published" as const, result: decodeResult(existing, true) });
      }
      if (run.status !== "running") throw new AnalysisRunStateError();
      if (run.cancelRequested) {
        this.cancelRunRow(transaction, accountId, analysisId, runId, timestamp);
        return Object.freeze({ status: "cancelled" as const });
      }
      const retained = transaction.get<CountRow>(
        "SELECT COUNT(*) AS count FROM analysis_results WHERE analysis_id=? AND account_id=?",
        [analysisId, accountId]
      );
      if (decodeSafeInteger(retained?.count ?? 0, "retained results") >= ANALYSIS_RETAINED_RESULTS_MAX) {
        throw new AnalysisQuotaError();
      }
      await hooks.afterQuotaChecked?.();
      const provenance = this.runSourcesInTransaction(transaction, accountId, runId);
      transaction.run(
        `INSERT INTO analysis_results
           (id,account_id,analysis_id,run_id,revision,columns,rows,returned_rows,source_row_total,
            row_count_exact,completeness,parameter_values,source_provenance,schema_fingerprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          resultId,
          accountId,
          analysisId,
          runId,
          run.revision,
          encodeJson(normalized.columns, "analysis result columns"),
          JSON.stringify(normalized.rows),
          normalized.returnedRows,
          normalized.sourceRowTotal,
          encodeBoolean(normalized.rowCountExact),
          encodeJson(normalized.completeness, "analysis result completeness"),
          encodeJson(run.parameterBindings, "analysis result parameter values"),
          encodeJson(
            provenance.map((source) => ({
              source_id: source.sourceId,
              ready_generation: source.readyGeneration,
              content_identity: source.contentIdentity,
            })),
            "analysis result source provenance"
          ),
          run.schemaFingerprint,
          timestamp,
        ]
      );
      const succeeded = transaction.run(
        `UPDATE analysis_runs SET status='succeeded',finished_at=?,error_code=NULL,error_reason=NULL
         WHERE id=? AND analysis_id=? AND account_id=? AND status='running' AND cancel_requested=0`,
        [timestamp, runId, analysisId, accountId]
      );
      if (succeeded.changes !== 1) throw new AnalysisRunStateError();
      const stored = transaction.get<ResultRow>(
        `SELECT ${RESULT_COLUMNS} FROM analysis_results WHERE id=? AND account_id=?`,
        [resultId, accountId]
      );
      if (!stored) throw new AnalysisRunStateError({ cause: new Error("published result vanished") });
      return Object.freeze({ status: "published" as const, result: decodeResult(stored, true) });
    });
  }

  async getAnalysisResult(
    accountIdValue: string,
    analysisIdValue: string,
    resultIdValue: string
  ): Promise<StoredAnalysisResult | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const resultId = uuidIdentity(resultIdValue, "analysis result id");
    const row = await this.ledger.get<ResultRow>(
      `SELECT ${RESULT_COLUMNS} FROM analysis_results WHERE id=? AND analysis_id=? AND account_id=?`,
      [resultId, analysisId, accountId]
    );
    return row ? decodeResult(row, true) : undefined;
  }

  async listAnalysisResults(
    accountIdValue: string,
    analysisIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<AnalysisResultSummary>> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [analysisId, accountId];
    const after = page.after ? " AND (created_at,id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<ResultRow>(
      `SELECT ${RESULT_COLUMNS} FROM analysis_results
       WHERE analysis_id=? AND account_id=?${after}
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeResultSummary(row)),
      page,
      (item) => ({ timestamp: item.createdAt, id: item.id })
    );
  }

  /**
   * Explicit user deletion of one retained result. Copied report/document
   * snapshots (M13) are separate rows and survive.
   */
  async deleteAnalysisResult(accountIdValue: string, analysisIdValue: string, resultIdValue: string): Promise<boolean> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const resultId = uuidIdentity(resultIdValue, "analysis result id");
    return (
      (
        await this.ledger.run("DELETE FROM analysis_results WHERE id=? AND analysis_id=? AND account_id=?", [
          resultId,
          analysisId,
          accountId,
        ])
      ).changes === 1
    );
  }

  async countAnalysisResults(accountIdValue: string, analysisIdValue: string): Promise<number> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const row = await this.ledger.get<CountRow>(
      "SELECT COUNT(*) AS count FROM analysis_results WHERE analysis_id=? AND account_id=?",
      [analysisId, accountId]
    );
    return decodeSafeInteger(row?.count ?? 0, "retained results");
  }

  /**
   * Startup repair: interrupted dispatched runs become durable terminal
   * records with a retryable error code; cancellation requests win.
   * Undispatched `queued` runs are untouched — repair never reruns a job
   * automatically, and no partial result is ever published.
   */
  async recoverInterruptedAnalysisRuns(): Promise<number> {
    return this.ledger.withImmediateTransaction(
      (transaction) =>
        transaction.run(
          `UPDATE analysis_runs
           SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'failed' END,
               finished_at=?,
               error_code=CASE WHEN cancel_requested=1 THEN 'CANCELLED' ELSE 'SERVER_RESTARTED' END,
               error_reason=NULL
           WHERE status='running'`,
          [this.timestamp()]
        ).changes
    );
  }

  /**
   * Startup-resume claim: durable `queued` runs in acceptance order. Repair
   * (`recoverInterruptedAnalysisRuns`) never reruns a dispatched job, and this
   * claim never returns `running` or terminal rows — it only hands undispatched
   * accepted runs to a live executor.
   */
  async listQueuedAnalysisRuns(limit = 100): Promise<readonly StoredAnalysisRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("claim limit must be a positive integer");
    const rows = await this.ledger.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM analysis_runs WHERE status='queued' ORDER BY created_at,id LIMIT ?`,
      [limit]
    );
    const runs: StoredAnalysisRun[] = [];
    for (const row of rows) {
      const run = decodeRun(row);
      const sources = await this.ledger.all<RunSourceRow>(
        `SELECT source_id,ready_generation,content_identity FROM analysis_run_sources
         WHERE run_id=? AND account_id=? ORDER BY source_id`,
        [run.id, run.accountId]
      );
      runs.push(Object.freeze({ ...run, sources: sources.map((sourceRow) => decodeRunSource(sourceRow)) }));
    }
    return runs;
  }

  /**
   * Exact immutable SQL for one run's frozen revision. The executor reads the
   * run's own revision number — never the mutable head — so a later definition
   * edit cannot change an accepted run. `null` means the analysis or revision
   * is gone (e.g. the analysis was deleted after acceptance).
   */
  async getAnalysisRevisionSql(
    accountIdValue: string,
    analysisIdValue: string,
    revision: number
  ): Promise<string | null> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError("revision must be a positive integer");
    const row = await this.ledger.get<{ sql?: unknown }>(
      "SELECT sql FROM analysis_revisions WHERE account_id=? AND analysis_id=? AND revision=?",
      [accountId, analysisId, revision]
    );
    return row ? requiredString(row.sql, "analysis revision sql") : null;
  }

  /**
   * Lightweight executor-facing cancel probe polled at safe points. Returns
   * `null` when the run is no longer owned (deletion cascade).
   */
  async getAnalysisRunCancelState(
    accountIdValue: string,
    analysisIdValue: string,
    runIdValue: string
  ): Promise<{ status: AnalysisRunStatus; cancelRequested: boolean } | null> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const analysisId = uuidIdentity(analysisIdValue, "analysis id");
    const runId = uuidIdentity(runIdValue, "analysis run id");
    const row = await this.ledger.get<RunRow>(
      "SELECT status,cancel_requested FROM analysis_runs WHERE id=? AND analysis_id=? AND account_id=?",
      [runId, analysisId, accountId]
    );
    if (!row) return null;
    return Object.freeze({
      status: runStatus(row.status),
      cancelRequested: decodeBoolean(row.cancel_requested, "analysis run cancel_requested"),
    });
  }

  // -- Internals ------------------------------------------------------------------

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "analysis store clock");
  }

  private assertSourceIdsOwned(transaction: SqliteTransaction, accountId: string, sourceIds: readonly string[]): void {
    if (sourceIds.length === 0) return;
    const rows = transaction.all<{ id?: unknown }>(
      `SELECT id FROM sources WHERE account_id=? AND id IN (${placeholders(sourceIds.length)})`,
      [accountId, ...sourceIds]
    );
    const owned = new Set(rows.map((row) => uuidIdentity(row.id, "owned source id")));
    for (const sourceId of sourceIds) {
      if (!owned.has(sourceId)) {
        throw new AnalysisNotFoundError({ cause: new Error(`selected source ${sourceId} is not owned`) });
      }
    }
  }

  private insertRevision(
    transaction: SqliteTransaction,
    accountId: string,
    analysisId: string,
    revision: number,
    content: RevisionContent,
    timestamp: string
  ): void {
    transaction.run(
      `INSERT INTO analysis_revisions
         (analysis_id,revision,account_id,title,description,sql,parameters,source_ids,comparison_key,
          origin_chat_id,origin_run_id,origin_capture_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        analysisId,
        revision,
        accountId,
        content.title,
        content.description,
        content.sql,
        encodeJson(content.parameters, "analysis parameters"),
        encodeJson(content.sourceIds, "analysis source ids"),
        content.comparisonKey === null ? null : encodeJson([...content.comparisonKey], "analysis comparison key"),
        content.originChatId,
        content.originRunId,
        content.originCaptureId,
        timestamp,
      ]
    );
  }

  private rewriteBindings(
    transaction: SqliteTransaction,
    accountId: string,
    analysisId: string,
    sourceIds: readonly string[],
    timestamp: string
  ): void {
    transaction.run("DELETE FROM analysis_sources WHERE analysis_id=? AND account_id=?", [analysisId, accountId]);
    for (const sourceId of sourceIds) {
      const row = transaction.get<SourceStateRow>(
        "SELECT id,status,ready_generation,file_path,size_bytes FROM sources WHERE account_id=? AND id=?",
        [accountId, sourceId]
      );
      const ready =
        row !== undefined &&
        row.status === "ready" &&
        row.ready_generation !== null &&
        row.ready_generation !== undefined;
      transaction.run(
        `INSERT INTO analysis_sources
           (analysis_id,source_id,account_id,ready_generation,content_identity,unavailable_at,bound_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          analysisId,
          sourceId,
          accountId,
          ready ? decodeSafeInteger(row.ready_generation, "source ready generation") : null,
          ready ? sourceContentIdentity(row) : null,
          // A selected id whose source row is already gone stays marked; the
          // deletion trigger cannot fire retroactively for a re-bound row.
          row ? null : timestamp,
          timestamp,
        ]
      );
    }
  }

  private requireRunRow(transaction: SqliteTransaction, accountId: string, analysisId: string, runId: string): RunRow {
    const row = transaction.get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM analysis_runs WHERE id=? AND analysis_id=? AND account_id=?`,
      [runId, analysisId, accountId]
    );
    if (!row) throw new AnalysisRunNotFoundError();
    return row;
  }

  private cancelRunRow(
    transaction: SqliteTransaction,
    accountId: string,
    analysisId: string,
    runId: string,
    timestamp: string
  ): void {
    transaction.run(
      `UPDATE analysis_runs
       SET status='cancelled',cancel_requested=1,finished_at=COALESCE(finished_at,?),
           error_code='CANCELLED',error_reason=NULL
       WHERE id=? AND analysis_id=? AND account_id=? AND status IN ('queued','running')`,
      [timestamp, runId, analysisId, accountId]
    );
  }

  private runSourcesInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    runId: string
  ): readonly StoredAnalysisRunSource[] {
    return Object.freeze(
      transaction
        .all<RunSourceRow>(
          `SELECT source_id,ready_generation,content_identity FROM analysis_run_sources
           WHERE run_id=? AND account_id=? ORDER BY source_id`,
          [runId, accountId]
        )
        .map((row) => decodeRunSource(row))
    );
  }

  private attachRunSources(transaction: SqliteTransaction, run: StoredAnalysisRun): StoredAnalysisRun {
    return Object.freeze({ ...run, sources: this.runSourcesInTransaction(transaction, run.accountId, run.id) });
  }
}

export function createAnalysisStore(ledger: SqliteLedger, options: AnalysisStoreOptions = {}): AnalysisStore {
  return new AnalysisStore(ledger, options);
}
