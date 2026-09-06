import { randomUUID } from "node:crypto";

import {
  decodeBoolean,
  decodeIsoTimestamp,
  decodeJson,
  decodeSafeInteger,
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
import { parseChunkLocators, type ChunkLocator } from "../../sourceLocations.js";
import {
  classifyResearchCellPayload,
  RESEARCH_CELL_EXPLANATION_MAX_CHARS,
  RESEARCH_CLAIMS_PER_RUN_MAX,
  RESEARCH_CLAIM_TEXT_MAX_CHARS,
  RESEARCH_EVIDENCE_EXCERPT_MAX_CHARS,
  RESEARCH_EVIDENCE_MAX,
  RESEARCH_EVIDENCE_REFS_MAX,
  RESEARCH_EVIDENCE_TOTAL_MAX_CHARS,
  RESEARCH_GAPS_PER_RUN_MAX,
  RESEARCH_LABEL_MAX_CHARS,
  RESEARCH_NOTE_MAX_CHARS,
  RESEARCH_QUEUED_PER_ACCOUNT_MAX,
  RESEARCH_QUERY_MAX_CHARS,
  RESEARCH_STEPS_MAX,
  RESEARCH_TABLE_SERIALIZED_MAX_BYTES,
  RESEARCH_WALL_CLOCK_MS,
  RESEARCH_SEARCHES_MAX,
  RESEARCH_MODEL_REQUESTS_MAX,
  researchTableSerializedByteLength,
  researchUuid,
  validateResearchCellPayload,
  validateResearchTypedValue,
  type ResearchCellStatus,
  type ResearchClaimClassification,
  type ResearchColumnDeclaration,
  type ResearchDefinitionContent,
  type ResearchOutputKind,
  type ResearchPlan,
  type ResearchReviewOp,
  type ResearchRunStatus,
  type ResearchTableRowView,
  type ResearchTypedValue,
  normalizeResearchDefinitionContent,
  normalizeResearchReviewOps,
  ResearchValidationError,
} from "../../researchSchemas.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ResearchStoreErrorCode =
  | "RESEARCH_NOT_FOUND"
  | "RESEARCH_RUN_NOT_FOUND"
  | "RESEARCH_REVISION_CONFLICT"
  | "RESEARCH_ACTIVE_RUN"
  | "RESEARCH_QUEUE_FULL"
  | "RESEARCH_SCOPE_EMPTY"
  | "RESEARCH_INPUTS_NOT_READY"
  | "RESEARCH_RUN_STATE"
  | "RESEARCH_REVIEW_TARGET_NOT_FOUND"
  | "RESEARCH_EVIDENCE_NOT_FOUND"
  | "RESEARCH_EVIDENCE_CAP"
  | "RESEARCH_CLAIM_CAP"
  | "RESEARCH_GAP_CAP"
  | "RESEARCH_TABLE_LIMIT"
  | "RESEARCH_BUDGET_EXHAUSTED";

export class ResearchStoreError extends Error {
  constructor(
    readonly code: ResearchStoreErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "ResearchStoreError";
  }
}

export class ResearchNotFoundError extends ResearchStoreError {
  constructor(options: ErrorOptions = {}) {
    super("RESEARCH_NOT_FOUND", "research definition not found", options);
    this.name = "ResearchNotFoundError";
  }
}

export class ResearchRunNotFoundError extends ResearchStoreError {
  constructor(options: ErrorOptions = {}) {
    super("RESEARCH_RUN_NOT_FOUND", "research run not found", options);
    this.name = "ResearchRunNotFoundError";
  }
}

export class ResearchRevisionConflictError extends ResearchStoreError {
  constructor(options: ErrorOptions = {}) {
    super("RESEARCH_REVISION_CONFLICT", "research revision conflict", options);
    this.name = "ResearchRevisionConflictError";
  }
}

export class ResearchActiveRunError extends ResearchStoreError {
  constructor(
    readonly existingRunId: string | null,
    options: ErrorOptions = {}
  ) {
    super("RESEARCH_ACTIVE_RUN", "this research definition already has an active run", options);
    this.name = "ResearchActiveRunError";
  }
}

export class ResearchQueueFullError extends ResearchStoreError {
  constructor(options: ErrorOptions = {}) {
    super(
      "RESEARCH_QUEUE_FULL",
      `at most ${RESEARCH_QUEUED_PER_ACCOUNT_MAX} research runs may be queued per account`,
      options
    );
    this.name = "ResearchQueueFullError";
  }
}

export class ResearchScopeEmptyError extends ResearchStoreError {
  constructor(options: ErrorOptions = {}) {
    super(
      "RESEARCH_SCOPE_EMPTY",
      "the selected source set is empty; select at least one ready source before starting",
      options
    );
    this.name = "ResearchScopeEmptyError";
  }
}

/** Precise readiness conflict — offending ids, never silently dropped. */
export class ResearchInputsNotReadyError extends ResearchStoreError {
  constructor(readonly unreadySourceIds: readonly string[]) {
    super(
      "RESEARCH_INPUTS_NOT_READY",
      "one or more selected sources are not ready or no longer exist; revise the selection before starting",
      { cause: new Error(`unready sources: ${unreadySourceIds.join(",")}`) }
    );
    this.name = "ResearchInputsNotReadyError";
  }
}

export class ResearchRunStateError extends ResearchStoreError {
  constructor(message = "research run is not in a state that accepts this transition", options: ErrorOptions = {}) {
    super("RESEARCH_RUN_STATE", message, options);
    this.name = "ResearchRunStateError";
  }
}

export class ResearchReviewTargetNotFoundError extends ResearchStoreError {
  constructor(options: ErrorOptions = {}) {
    super("RESEARCH_REVIEW_TARGET_NOT_FOUND", "review target not found in this run", options);
    this.name = "ResearchReviewTargetNotFoundError";
  }
}

/** FK check: a claim/cell/correction may only reference this run's evidence. */
export class ResearchEvidenceRefError extends ResearchStoreError {
  constructor(options: ErrorOptions = {}) {
    super("RESEARCH_EVIDENCE_NOT_FOUND", "evidence reference is not captured in this run", options);
    this.name = "ResearchEvidenceRefError";
  }
}

export class ResearchEvidenceCapError extends ResearchStoreError {
  constructor(reason: string, options: ErrorOptions = {}) {
    super(
      "RESEARCH_EVIDENCE_CAP",
      `research evidence cap reached: ${reason} (max ${RESEARCH_EVIDENCE_MAX} items / ${RESEARCH_EVIDENCE_TOTAL_MAX_CHARS} characters)`,
      options
    );
    this.name = "ResearchEvidenceCapError";
  }
}

export class ResearchClaimCapError extends ResearchStoreError {
  constructor(gap: boolean, options: ErrorOptions = {}) {
    super(
      gap ? "RESEARCH_GAP_CAP" : "RESEARCH_CLAIM_CAP",
      gap
        ? `at most ${RESEARCH_GAPS_PER_RUN_MAX} gaps are allowed per run`
        : `at most ${RESEARCH_CLAIMS_PER_RUN_MAX} claims are allowed per run`,
      options
    );
    this.name = "ResearchClaimCapError";
  }
}

export class ResearchTableLimitError extends ResearchStoreError {
  constructor(options: ErrorOptions = {}) {
    super(
      "RESEARCH_TABLE_LIMIT",
      `the serialized comparison table exceeds the ${RESEARCH_TABLE_SERIALIZED_MAX_BYTES}-byte limit`,
      options
    );
    this.name = "ResearchTableLimitError";
  }
}

export class ResearchBudgetExhaustedError extends ResearchStoreError {
  constructor(field: string, options: ErrorOptions = {}) {
    super("RESEARCH_BUDGET_EXHAUSTED", `research run budget exhausted: ${field}`, options);
    this.name = "ResearchBudgetExhaustedError";
  }
}

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export interface StoredResearchRevision {
  readonly revision: number;
  readonly title: string;
  readonly question: string;
  readonly outputKind: ResearchOutputKind;
  readonly sourceIds: readonly string[];
  readonly libraryIds: readonly string[];
  readonly chatModel: string;
  readonly columns: readonly ResearchColumnDeclaration[];
  readonly plan: ResearchPlan;
  readonly createdAt: string;
}

export interface ResearchSourceAvailability {
  readonly sourceId: string;
  readonly availability: "ready" | "unready" | "missing";
  readonly readyGeneration: number | null;
}

export interface ResearchActiveRunRef {
  readonly id: string;
  readonly status: ResearchRunStatus;
}

export interface StoredResearchDefinition {
  readonly id: string;
  readonly accountId: string;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: StoredResearchRevision;
  readonly sources: readonly ResearchSourceAvailability[];
  readonly activeRun: ResearchActiveRunRef | null;
}

export interface ResearchDefinitionSummary {
  readonly id: string;
  readonly title: string;
  readonly outputKind: ResearchOutputKind;
  readonly currentRevision: number;
  readonly sourceCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResearchRunBudgets {
  readonly steps: number;
  readonly searches: number;
  readonly modelRequests: number;
  readonly evidence: number;
  readonly evidenceChars: number;
  readonly wallMs: number;
}

export interface ResearchRunSource {
  readonly sourceId: string;
  readonly generation: number;
}

export interface StoredResearchRun {
  readonly id: string;
  readonly accountId: string;
  readonly definitionId: string;
  readonly definitionRevision: number;
  readonly status: ResearchRunStatus;
  readonly cancelRequested: boolean;
  readonly chatModel: string;
  /** Internal identity of the captured authorization snapshot; never public. */
  readonly providerOrigin: string;
  readonly providerLocality: "local" | "private" | "remote";
  readonly providerRevision: number;
  readonly sources: readonly ResearchRunSource[];
  readonly budgets: ResearchRunBudgets;
  readonly searchesUsed: number;
  readonly modelRequestsUsed: number;
  readonly rerunOf: string | null;
  readonly rerunSelection: {
    readonly row_source_ids: readonly string[];
    readonly column_ids: readonly string[];
  } | null;
  readonly reviewRevision: number;
  readonly errorCode: string | null;
  readonly errorReason: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface ResearchRunSummary {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionRevision: number;
  readonly status: ResearchRunStatus;
  readonly cancelRequested: boolean;
  readonly chatModel: string;
  readonly providerLocality: "local" | "private" | "remote";
  readonly rerunOf: string | null;
  readonly reviewRevision: number;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export type ResearchStepStatus = "pending" | "running" | "done" | "source_changed" | "failed" | "skipped";

export interface StoredResearchStep {
  readonly ordinal: number;
  readonly objective: string;
  readonly questions: readonly string[];
  readonly status: ResearchStepStatus;
  readonly outcome: string | null;
  readonly attempts: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface StoredResearchEvidence {
  readonly id: string;
  readonly runId: string;
  readonly sourceId: string;
  readonly generation: number;
  readonly chunkId: string;
  readonly label: string;
  readonly locators: readonly ChunkLocator[];
  readonly excerpt: string;
  readonly contentHash: string;
  readonly retrievedAt: string;
  readonly stepOrdinal: number;
  readonly query: string;
  readonly irrelevant: boolean;
}

export type ResearchClaimKind = "claim" | "gap";

export interface StoredResearchClaim {
  readonly id: string;
  readonly runId: string;
  readonly kind: ResearchClaimKind;
  readonly text: string;
  readonly correctedText: string | null;
  readonly classification: ResearchClaimClassification | null;
  readonly evidenceRefs: readonly string[];
  readonly userNote: string | null;
  readonly reviewState: "pending" | "accepted" | "rejected";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredResearchCell {
  readonly columnId: string;
  readonly rowSourceId: string;
  readonly rowGeneration: number;
  readonly origin: "machine" | "correction";
  readonly value: ResearchTypedValue;
  readonly status: ResearchCellStatus;
  readonly evidenceRefs: readonly string[];
  readonly explanation: string | null;
  readonly correctedAt: string | null;
  readonly correctedFromRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredResearchReview {
  readonly seq: number;
  readonly reviewRevision: number;
  readonly op: string;
  readonly targetKind: string;
  readonly target: string;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ResearchRunCounts {
  readonly evidenceCount: number;
  readonly evidenceCharCount: number;
  readonly claimCount: number;
  readonly gapCount: number;
  readonly machineCellCount: number;
  readonly correctionCellCount: number;
  readonly tableSerializedBytes: number;
}

export interface ResearchRunInspection {
  readonly run: StoredResearchRun;
  readonly steps: readonly StoredResearchStep[];
  readonly counts: ResearchRunCounts;
  readonly claims: readonly StoredResearchClaim[];
  readonly runNotes: readonly string[];
}

export interface StartResearchRunInput {
  /** Optimistic guard against a concurrent definition edit. */
  readonly expectedRevision?: number | null;
  /** Pin a specific definition revision; defaults to the head. */
  readonly definitionRevision?: number | null;
  /** Route-captured provider authorization snapshot identity. */
  readonly authorization: {
    readonly providerOrigin: string;
    readonly providerLocality: "local" | "private" | "remote";
    readonly providerRevision: number;
  };
  /** Rerun lineage: prior run of the same definition. */
  readonly rerunOf?: string | null;
  readonly rerunSelection?: {
    readonly row_source_ids?: readonly string[];
    readonly column_ids?: readonly string[];
  } | null;
}

export interface InsertResearchEvidenceInput {
  readonly id?: string;
  readonly sourceId: string;
  readonly generation: number;
  readonly chunkId: string;
  readonly label: string;
  readonly locators?: readonly unknown[];
  readonly excerpt: string;
  readonly contentHash: string;
  readonly retrievedAt?: string;
  readonly stepOrdinal: number;
  readonly query: string;
}

export interface AddResearchClaimInput {
  readonly id?: string;
  readonly kind: ResearchClaimKind;
  readonly text: string;
  readonly classification?: ResearchClaimClassification | null;
  readonly evidenceRefs?: readonly string[];
  readonly userNote?: string | null;
}

export interface RecordResearchCellInput {
  readonly columnId: string;
  readonly rowSourceId: string;
  /** Raw model output; classified `invalid` verbatim when it does not type. */
  readonly rawValue?: unknown;
  readonly assertedStatus?: ResearchCellStatus | null;
  readonly evidenceRefs?: readonly string[];
  readonly explanation?: string | null;
}

export interface ResearchTableRowPageItem {
  readonly row_source_id: string;
  readonly row_generation: number;
  readonly cells: readonly StoredResearchCell[];
}

export interface ResearchTablePage {
  readonly columns: readonly ResearchColumnDeclaration[];
  readonly page: CatalogStorePage<ResearchTableRowPageItem>;
  readonly serializedBytes: number;
}

export interface ResearchStoreOptions {
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Row decoding helpers
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const RUN_COLUMNS = `id,account_id,definition_id,definition_revision,status,cancel_requested,chat_model,
                     provider_origin,provider_locality,provider_revision,sources,
                     budget_steps,budget_searches,budget_model_requests,budget_evidence,budget_evidence_chars,budget_wall_ms,
                     searches_used,model_requests_used,rerun_of,rerun_selection,review_revision,
                     error_code,error_reason,created_at,started_at,finished_at`;

interface RunRow {
  [column: string]: unknown;
}

function storeUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} violates the research store row contract`);
  }
  return value.toLowerCase();
}

function storedText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is not stored as text`);
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return storedText(value, field);
}

function optionalTimestamp(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return decodeIsoTimestamp(value, field);
}

function runStatus(value: unknown): ResearchRunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "cancelling" ||
    value === "needs_review" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new TypeError("research run status violates the research store contract");
}

function stepStatus(value: unknown): ResearchStepStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "done" ||
    value === "source_changed" ||
    value === "failed" ||
    value === "skipped"
  ) {
    return value;
  }
  throw new TypeError("research step status violates the research store contract");
}

function providerLocality(value: unknown): "local" | "private" | "remote" {
  if (value === "local" || value === "private" || value === "remote") return value;
  throw new TypeError("research provider locality violates the research store contract");
}

function cellStatusValue(value: unknown): ResearchCellStatus {
  if (value === "supported" || value === "conflicting" || value === "not_found" || value === "invalid") return value;
  throw new TypeError("research cell status violates the research store contract");
}

function decodeStringArray(value: unknown, field: string): readonly string[] {
  const parsed: unknown = decodeJson(value, field);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new TypeError(`${field} is not stored as a string array`);
  }
  return parsed as string[];
}

/** String array already decoded inside a parsed JSON envelope. */
function nestedStringArray(value: unknown, field: string): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${field} is not stored as a string array`);
  }
  return Object.freeze([...(value as string[])]);
}

function decodeColumns(value: unknown, field: string): readonly ResearchColumnDeclaration[] {
  const parsed: unknown = decodeJson(value, field);
  if (!Array.isArray(parsed)) throw new TypeError(`${field} is not stored as an array`);
  return Object.freeze(
    parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new TypeError(`${field} holds a malformed column declaration`);
      const record = entry as Record<string, unknown>;
      const type = record.type;
      if (type !== "text" && type !== "number" && type !== "date" && type !== "boolean" && type !== "enum") {
        throw new TypeError(`${field} holds an unsupported column type`);
      }
      return Object.freeze({
        id: storeUuid(record.id, `${field} column id`),
        label: storedText(record.label, `${field} column label`),
        question: storedText(record.question, `${field} column question`),
        type,
        unit: optionalText(record.unit, `${field} column unit`),
        choices: nestedStringArray(record.choices, `${field} column choices`),
      });
    })
  );
}

function decodePlan(value: unknown, field: string): ResearchPlan {
  const parsed: unknown = decodeJson(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError(`${field} is not an object`);
  const stepsValue = (parsed as Record<string, unknown>).steps;
  if (!Array.isArray(stepsValue)) throw new TypeError(`${field} steps are malformed`);
  return Object.freeze({
    steps: Object.freeze(
      stepsValue.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          throw new TypeError(`${field} step is malformed`);
        const record = entry as Record<string, unknown>;
        return Object.freeze({
          id: storeUuid(record.id, `${field} step id`),
          objective: storedText(record.objective, `${field} step objective`),
          questions: decodeStringArray(record.questions, `${field} step questions`),
        });
      })
    ),
  });
}

function decodeJsonValue(value: unknown, field: string): ResearchTypedValue {
  if (value === null || value === undefined) return null;
  const parsed: unknown = decodeJson(value, field);
  if (parsed === null || typeof parsed === "string" || typeof parsed === "boolean" || typeof parsed === "number") {
    return parsed;
  }
  throw new TypeError(`${field} is not stored as a JSON scalar`);
}

function decodeRunSources(value: unknown, field: string): readonly ResearchRunSource[] {
  const parsed: unknown = decodeJson(value, field);
  if (!Array.isArray(parsed)) throw new TypeError(`${field} is not stored as an array`);
  return Object.freeze(
    parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new TypeError(`${field} holds a malformed source`);
      const record = entry as Record<string, unknown>;
      return Object.freeze({
        sourceId: storeUuid(record.source_id, `${field} source id`),
        generation: decodeSafeInteger(record.generation, `${field} generation`),
      });
    })
  );
}

function decodeRerunSelection(value: unknown, field: string): StoredResearchRun["rerunSelection"] {
  if (value === null || value === undefined) return null;
  const parsed: unknown = decodeJson(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError(`${field} is malformed`);
  const record = parsed as Record<string, unknown>;
  return Object.freeze({
    row_source_ids: nestedStringArray(record.row_source_ids, `${field} rows`) ?? Object.freeze([]),
    column_ids: nestedStringArray(record.column_ids, `${field} columns`) ?? Object.freeze([]),
  });
}

function decodeRun(row: RunRow): StoredResearchRun {
  return Object.freeze({
    id: storeUuid(row.id, "research run id"),
    accountId: storeUuid(row.account_id, "research run account id"),
    definitionId: storeUuid(row.definition_id, "research run definition id"),
    definitionRevision: decodeSafeInteger(row.definition_revision, "research run definition revision"),
    status: runStatus(row.status),
    cancelRequested: decodeBoolean(row.cancel_requested, "research run cancel_requested"),
    chatModel: storedText(row.chat_model, "research run chat model"),
    providerOrigin: storedText(row.provider_origin, "research run provider origin"),
    providerLocality: providerLocality(row.provider_locality),
    providerRevision: decodeSafeInteger(row.provider_revision, "research run provider revision"),
    sources: decodeRunSources(row.sources, "research run sources"),
    budgets: Object.freeze({
      steps: decodeSafeInteger(row.budget_steps, "research run budget steps"),
      searches: decodeSafeInteger(row.budget_searches, "research run budget searches"),
      modelRequests: decodeSafeInteger(row.budget_model_requests, "research run budget model requests"),
      evidence: decodeSafeInteger(row.budget_evidence, "research run budget evidence"),
      evidenceChars: decodeSafeInteger(row.budget_evidence_chars, "research run budget evidence chars"),
      wallMs: decodeSafeInteger(row.budget_wall_ms, "research run budget wall ms"),
    }),
    searchesUsed: decodeSafeInteger(row.searches_used, "research run searches used"),
    modelRequestsUsed: decodeSafeInteger(row.model_requests_used, "research run model requests used"),
    rerunOf:
      row.rerun_of === null || row.rerun_of === undefined ? null : storeUuid(row.rerun_of, "research run rerun_of"),
    rerunSelection: decodeRerunSelection(row.rerun_selection, "research run rerun selection"),
    reviewRevision: decodeSafeInteger(row.review_revision, "research run review revision"),
    errorCode: optionalText(row.error_code, "research run error_code"),
    errorReason: optionalText(row.error_reason, "research run error_reason"),
    createdAt: decodeIsoTimestamp(row.created_at, "research run created_at"),
    startedAt: optionalTimestamp(row.started_at, "research run started_at"),
    finishedAt: optionalTimestamp(row.finished_at, "research run finished_at"),
  });
}

function decodeRunSummary(row: RunRow): ResearchRunSummary {
  const run = decodeRun(row);
  return Object.freeze({
    id: run.id,
    definitionId: run.definitionId,
    definitionRevision: run.definitionRevision,
    status: run.status,
    cancelRequested: run.cancelRequested,
    chatModel: run.chatModel,
    providerLocality: run.providerLocality,
    rerunOf: run.rerunOf,
    reviewRevision: run.reviewRevision,
    errorCode: run.errorCode,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });
}

function decodeCell(row: RunRow): StoredResearchCell {
  return Object.freeze({
    columnId: storeUuid(row.column_id, "research cell column id"),
    rowSourceId: storeUuid(row.row_source_id, "research cell row source id"),
    rowGeneration: decodeSafeInteger(row.row_generation, "research cell row generation"),
    origin:
      row.origin === "machine" || row.origin === "correction"
        ? row.origin
        : (() => {
            throw new TypeError("bad cell origin");
          })(),
    value: decodeJsonValue(row.value, "research cell value"),
    status: cellStatusValue(row.status),
    evidenceRefs: decodeStringArray(row.evidence_refs, "research cell evidence refs"),
    explanation: optionalText(row.explanation, "research cell explanation"),
    correctedAt: optionalTimestamp(row.corrected_at, "research cell corrected_at"),
    correctedFromRunId:
      row.corrected_from_run_id === null || row.corrected_from_run_id === undefined
        ? null
        : storeUuid(row.corrected_from_run_id, "research cell corrected_from_run_id"),
    createdAt: decodeIsoTimestamp(row.created_at, "research cell created_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "research cell updated_at"),
  });
}

function placeholders(length: number): string {
  return new Array<string>(length).fill("?").join(",");
}

function boundedInputText(value: unknown, field: string, maximum: number, required: boolean): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > maximum ||
    (required && (!value || !value.trim()))
  ) {
    throw new ResearchValidationError(`${field} violates the research contract`);
  }
  return value;
}

function inputRefs(value: readonly string[] | undefined): readonly string[] {
  const refs = [...new Set((value ?? []).map((ref) => researchUuid(ref, "evidence reference")))];
  if (refs.length > RESEARCH_EVIDENCE_REFS_MAX) {
    throw new ResearchValidationError(`at most ${RESEARCH_EVIDENCE_REFS_MAX} evidence references are allowed`);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ResearchStore {
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: ResearchStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // -- Definitions -----------------------------------------------------------

  async createResearchDefinition(accountIdValue: string, input: unknown): Promise<StoredResearchDefinition> {
    const accountId = storeUuid(accountIdValue, "account id");
    const content = normalizeResearchDefinitionContent(input);
    const definitionId = randomUUID();
    const timestamp = this.timestamp();
    await this.ledger.withImmediateTransaction((transaction) => {
      if (!transaction.get("SELECT 1 FROM users WHERE id=?", [accountId])) {
        throw new ResearchNotFoundError({ cause: new Error("account does not exist") });
      }
      this.assertIdsOwned(transaction, accountId, "sources", content.sourceIds, "selected source");
      this.assertIdsOwned(transaction, accountId, "libraries", content.libraryIds, "provenance library");
      transaction.run(
        `INSERT INTO research_definitions (id,account_id,title,output_kind,current_revision,created_at,updated_at)
         VALUES (?,?,?,?,1,?,?)`,
        [definitionId, accountId, content.title, content.outputKind, timestamp, timestamp]
      );
      this.insertRevision(transaction, accountId, definitionId, 1, content, timestamp);
    });
    const stored = await this.getResearchDefinition(accountId, definitionId);
    if (!stored) throw new ResearchNotFoundError({ cause: new Error("definition insert did not persist") });
    return stored;
  }

  async getResearchDefinition(
    accountIdValue: string,
    definitionIdValue: string
  ): Promise<StoredResearchDefinition | undefined> {
    const accountId = storeUuid(accountIdValue, "account id");
    const definitionId = storeUuid(definitionIdValue, "definition id");
    const row = await this.ledger.get<RunRow>(
      `SELECT d.id,d.account_id,d.current_revision,d.created_at,d.updated_at,
              r.revision,r.title,r.question,r.output_kind,r.source_ids,r.library_ids,r.chat_model,
              r.columns,r.plan,r.created_at AS rev_created_at
       -- The immutable revision row is the full-content snapshot; its title
       -- is the public title of the pinned revision.
       FROM research_definitions d
       JOIN research_definition_revisions r
         ON r.definition_id=d.id AND r.revision=d.current_revision AND r.account_id=d.account_id
       WHERE d.id=? AND d.account_id=?`,
      [definitionId, accountId]
    );
    if (!row) return undefined;
    const sourceIds = decodeStringArray(row.source_ids, "research revision source ids");
    const availability = await this.sourceAvailability(accountId, sourceIds);
    const active = await this.ledger.get<RunRow>(
      `SELECT id,status FROM research_runs
       WHERE definition_id=? AND account_id=? AND status IN ('queued','running','cancelling')
       ORDER BY created_at DESC LIMIT 1`,
      [definitionId, accountId]
    );
    return Object.freeze({
      id: storeUuid(row.id, "definition id"),
      accountId: storeUuid(row.account_id, "definition account id"),
      currentRevision: decodeSafeInteger(row.current_revision, "definition current revision"),
      createdAt: decodeIsoTimestamp(row.created_at, "definition created_at"),
      updatedAt: decodeIsoTimestamp(row.updated_at, "definition updated_at"),
      revision: Object.freeze({
        revision: decodeSafeInteger(row.revision, "definition revision number"),
        title: storedText(row.title, "definition title"),
        question: storedText(row.question, "definition question"),
        outputKind:
          row.output_kind === "memo" || row.output_kind === "comparison"
            ? row.output_kind
            : (() => {
                throw new TypeError("bad output kind");
              })(),
        sourceIds,
        libraryIds: decodeStringArray(row.library_ids, "definition library ids"),
        chatModel: storedText(row.chat_model, "definition chat model"),
        columns: decodeColumns(row.columns, "definition columns"),
        plan: decodePlan(row.plan, "definition plan"),
        createdAt: decodeIsoTimestamp(row.rev_created_at, "definition revision created_at"),
      }),
      sources: availability,
      activeRun: active
        ? Object.freeze({ id: storeUuid(active.id, "active run id"), status: runStatus(active.status) })
        : null,
    });
  }

  /**
   * Read-only pinned-revision content for the stage-2 executor. The runner
   * must execute exactly the revision the run captured — a later head move
   * can never change a running or historical run's plan or columns.
   */
  async getResearchRevisionContent(
    accountIdValue: string,
    definitionIdValue: string,
    revisionValue: number
  ): Promise<StoredResearchRevision | undefined> {
    const accountId = storeUuid(accountIdValue, "account id");
    const definitionId = storeUuid(definitionIdValue, "definition id");
    const revision = decodeSafeInteger(revisionValue, "definition revision");
    if (revision < 1) throw new RangeError("definition revision must be >= 1");
    const row = await this.ledger.get<RunRow>(
      `SELECT revision,title,question,output_kind,source_ids,library_ids,chat_model,columns,plan,created_at
       FROM research_definition_revisions WHERE definition_id=? AND revision=? AND account_id=?`,
      [definitionId, revision, accountId]
    );
    if (!row) return undefined;
    return Object.freeze({
      revision: decodeSafeInteger(row.revision, "definition revision number"),
      title: storedText(row.title, "definition title"),
      question: storedText(row.question, "definition question"),
      outputKind:
        row.output_kind === "memo" || row.output_kind === "comparison"
          ? row.output_kind
          : (() => {
              throw new TypeError("bad output kind");
            })(),
      sourceIds: decodeStringArray(row.source_ids, "definition source ids"),
      libraryIds: decodeStringArray(row.library_ids, "definition library ids"),
      chatModel: storedText(row.chat_model, "definition chat model"),
      columns: decodeColumns(row.columns, "definition columns"),
      plan: decodePlan(row.plan, "definition plan"),
      createdAt: decodeIsoTimestamp(row.created_at, "definition revision created_at"),
    });
  }

  async listResearchDefinitions(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<ResearchDefinitionSummary>> {
    const accountId = storeUuid(accountIdValue, "account id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId];
    const after = page.after ? " AND (d.created_at,d.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<RunRow>(
      `SELECT d.id,d.title,d.output_kind,d.current_revision,d.created_at,d.updated_at,
              r.source_ids
       FROM research_definitions d
       JOIN research_definition_revisions r
         ON r.definition_id=d.id AND r.revision=d.current_revision AND r.account_id=d.account_id
       WHERE d.account_id=?${after}
       ORDER BY d.created_at DESC,d.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) =>
        Object.freeze({
          id: storeUuid(row.id, "definition id"),
          title: storedText(row.title, "definition title"),
          outputKind: row.output_kind === "memo" ? ("memo" as const) : ("comparison" as const),
          currentRevision: decodeSafeInteger(row.current_revision, "definition current revision"),
          sourceCount: decodeStringArray(row.source_ids, "definition source ids").length,
          createdAt: decodeIsoTimestamp(row.created_at, "definition created_at"),
          updatedAt: decodeIsoTimestamp(row.updated_at, "definition updated_at"),
        })
      ),
      page,
      (item) => ({ timestamp: item.createdAt, id: item.id })
    );
  }

  /**
   * Optimistic revision-checked edit. The head CAS and the immutable revision
   * insert commit together; a lost race raises ResearchRevisionConflictError
   * and writes nothing. Passing `source_ids` rewrites the explicit selected
   * set — an empty array is stored as a legal selected-empty draft.
   */
  async updateResearchDefinition(
    accountIdValue: string,
    definitionIdValue: string,
    expectedRevision: number,
    patch: {
      title?: string;
      question?: string;
      output_kind?: ResearchOutputKind;
      source_ids?: readonly string[];
      library_ids?: readonly string[];
      chat_model?: string;
      columns?: readonly unknown[];
      plan?: unknown;
    }
  ): Promise<StoredResearchDefinition> {
    const accountId = storeUuid(accountIdValue, "account id");
    const definitionId = storeUuid(definitionIdValue, "definition id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new RangeError("expectedRevision must be a positive safe integer");
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("research definition edit must be an object");
    }
    for (const key of Object.keys(patch)) {
      if (
        !["title", "question", "output_kind", "source_ids", "library_ids", "chat_model", "columns", "plan"].includes(
          key
        )
      ) {
        throw new TypeError(`unknown research definition edit field "${key}"`);
      }
    }
    const timestamp = this.timestamp();
    await this.ledger.withImmediateTransaction((transaction) => {
      const head = transaction.get<RunRow>(
        "SELECT current_revision FROM research_definitions WHERE id=? AND account_id=?",
        [definitionId, accountId]
      );
      if (!head) throw new ResearchNotFoundError();
      const cas = transaction.run(
        `UPDATE research_definitions
         SET current_revision=current_revision+1,updated_at=?,
             title=COALESCE(?,title),output_kind=COALESCE(?,output_kind)
         WHERE id=? AND account_id=? AND current_revision=?`,
        [timestamp, patch.title ?? null, patch.output_kind ?? null, definitionId, accountId, expectedRevision]
      );
      if (cas.changes !== 1) throw new ResearchRevisionConflictError();
      const current = transaction.get<RunRow>(
        "SELECT * FROM research_definition_revisions WHERE definition_id=? AND revision=? AND account_id=?",
        [definitionId, expectedRevision, accountId]
      );
      if (!current) throw new ResearchRevisionConflictError({ cause: new Error("current revision row is missing") });
      const baseContent: ResearchDefinitionContent = {
        title: patch.title ?? storedText(current.title, "definition title"),
        question: patch.question ?? storedText(current.question, "definition question"),
        outputKind: patch.output_kind ?? (current.output_kind as ResearchOutputKind),
        sourceIds: patch.source_ids ?? decodeStringArray(current.source_ids, "definition source ids"),
        libraryIds: patch.library_ids ?? decodeStringArray(current.library_ids, "definition library ids"),
        chatModel: patch.chat_model ?? storedText(current.chat_model, "definition chat model"),
        columns:
          patch.columns === undefined ? decodeColumns(current.columns, "definition columns") : (patch.columns as never),
        plan: patch.plan === undefined ? decodePlan(current.plan, "definition plan") : (patch.plan as never),
      };
      const content = normalizeResearchDefinitionContent({
        title: baseContent.title,
        question: baseContent.question,
        output_kind: baseContent.outputKind,
        source_ids: baseContent.sourceIds,
        library_ids: baseContent.libraryIds,
        chat_model: baseContent.chatModel,
        columns: baseContent.columns,
        plan: baseContent.plan,
      });
      this.assertIdsOwned(transaction, accountId, "sources", content.sourceIds, "selected source");
      this.assertIdsOwned(transaction, accountId, "libraries", content.libraryIds, "provenance library");
      this.insertRevision(transaction, accountId, definitionId, expectedRevision + 1, content, timestamp);
    });
    const stored = await this.getResearchDefinition(accountId, definitionId);
    if (!stored) throw new ResearchNotFoundError();
    return stored;
  }

  /**
   * Owned deletion. An active (queued/running/cancelling) run is refused —
   * the caller must request durable cancellation first and retry after its
   * executor drains. Deleting the definition cascades run history and
   * dossiers; a terminal run's frozen provenance already lives only in its
   * own rows.
   */
  async deleteResearchDefinition(accountIdValue: string, definitionIdValue: string): Promise<boolean> {
    const accountId = storeUuid(accountIdValue, "account id");
    const definitionId = storeUuid(definitionIdValue, "definition id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const head = transaction.get("SELECT 1 FROM research_definitions WHERE id=? AND account_id=?", [
        definitionId,
        accountId,
      ]);
      if (!head) return false;
      const active = transaction.get<RunRow>(
        `SELECT id FROM research_runs
         WHERE definition_id=? AND account_id=? AND status IN ('queued','running','cancelling') LIMIT 1`,
        [definitionId, accountId]
      );
      if (active) throw new ResearchActiveRunError(storeUuid(active.id, "active run id"));
      return (
        transaction.run("DELETE FROM research_definitions WHERE id=? AND account_id=?", [definitionId, accountId])
          .changes === 1
      );
    });
  }

  // -- Start admission ---------------------------------------------------------

  /**
   * Atomic run acceptance. In ONE immediate transaction it pins the chosen
   * definition revision, captures the concrete ready (source, generation)
   * identities, refuses a selected-empty or unready/removed selection with a
   * precise conflict (never a silent drop), enforces one-active-per-definition
   * and the per-account queued cap, freezes the provider authorization
   * snapshot and budget copy, and links rerun lineage. Frozen provenance is
   * never re-read from mutable rows afterward.
   */
  async startResearchRun(
    accountIdValue: string,
    definitionIdValue: string,
    input: StartResearchRunInput
  ): Promise<StoredResearchRun> {
    const accountId = storeUuid(accountIdValue, "account id");
    const definitionId = storeUuid(definitionIdValue, "definition id");
    const authorization = input.authorization;
    if (
      !authorization ||
      typeof authorization !== "object" ||
      typeof authorization.providerOrigin !== "string" ||
      authorization.providerOrigin.length < 1 ||
      authorization.providerOrigin.length > 2_048 ||
      !["local", "private", "remote"].includes(authorization.providerLocality) ||
      !Number.isSafeInteger(authorization.providerRevision) ||
      authorization.providerRevision < 0
    ) {
      throw new TypeError("authorization snapshot violates the research store input contract");
    }
    const expectedRevision =
      input.expectedRevision === undefined || input.expectedRevision === null
        ? null
        : decodeSafeInteger(input.expectedRevision, "expected revision");
    if (expectedRevision !== null && expectedRevision < 1) throw new RangeError("expected revision must be >= 1");
    const pinnedRevision =
      input.definitionRevision === undefined || input.definitionRevision === null
        ? null
        : decodeSafeInteger(input.definitionRevision, "definition revision to pin");
    if (pinnedRevision !== null && pinnedRevision < 1) throw new RangeError("definition revision must be >= 1");
    const rerunOf = input.rerunOf === undefined || input.rerunOf === null ? null : storeUuid(input.rerunOf, "rerun_of");
    let rerunSelection: StartResearchRunInput["rerunSelection"] = null;
    if (input.rerunSelection) {
      const rowIds = (input.rerunSelection.row_source_ids ?? []).map((id) => researchUuid(id, "rerun row id"));
      const columnIds = (input.rerunSelection.column_ids ?? []).map((id) => researchUuid(id, "rerun column id"));
      if (rowIds.length > 100 || columnIds.length > 20) {
        throw new ResearchValidationError("rerun selection exceeds the row/column bounds");
      }
      rerunSelection = Object.freeze({
        row_source_ids: Object.freeze([...new Set(rowIds)]),
        column_ids: Object.freeze([...new Set(columnIds)]),
      });
    }
    const timestamp = this.timestamp();

    return this.ledger.withImmediateTransaction((transaction) => {
      const head = transaction.get<RunRow>(
        "SELECT current_revision FROM research_definitions WHERE id=? AND account_id=?",
        [definitionId, accountId]
      );
      if (!head) throw new ResearchNotFoundError();
      const headRevision = decodeSafeInteger(head.current_revision, "definition current revision");
      if (expectedRevision !== null && expectedRevision !== headRevision) throw new ResearchRevisionConflictError();
      const revisionNumber = pinnedRevision ?? headRevision;
      if (revisionNumber > headRevision) throw new ResearchRevisionConflictError();
      const revision = transaction.get<RunRow>(
        "SELECT * FROM research_definition_revisions WHERE definition_id=? AND revision=? AND account_id=?",
        [definitionId, revisionNumber, accountId]
      );
      if (!revision) throw new ResearchNotFoundError({ cause: new Error("pinned revision row is missing") });

      const sourceIds = decodeStringArray(revision.source_ids, "definition source ids");
      if (sourceIds.length === 0) throw new ResearchScopeEmptyError();

      // Precise readiness: missing or non-ready sources fail closed with the
      // offending ids; they are never silently dropped from the scope.
      const sourceRows = transaction.all<RunRow>(
        `SELECT id,status,ready_generation FROM sources WHERE account_id=? AND id IN (${placeholders(sourceIds.length)})`,
        [accountId, ...sourceIds]
      );
      const live = new Map(sourceRows.map((row) => [storeUuid(row.id, "source id"), row]));
      const unready: string[] = [];
      const frozen: ResearchRunSource[] = [];
      for (const sourceId of sourceIds) {
        const row = live.get(sourceId);
        if (!row || row.status !== "ready" || row.ready_generation === null || row.ready_generation === undefined) {
          unready.push(sourceId);
          continue;
        }
        frozen.push({ sourceId, generation: decodeSafeInteger(row.ready_generation, "source ready generation") });
      }
      if (unready.length) throw new ResearchInputsNotReadyError(Object.freeze(unready));

      const active = transaction.get<RunRow>(
        `SELECT id FROM research_runs
         WHERE definition_id=? AND account_id=? AND status IN ('queued','running','cancelling') LIMIT 1`,
        [definitionId, accountId]
      );
      if (active) throw new ResearchActiveRunError(storeUuid(active.id, "active run id"));

      const queued = transaction.get<RunRow>(
        "SELECT COUNT(*) AS count FROM research_runs WHERE account_id=? AND status='queued'",
        [accountId]
      );
      if (decodeSafeInteger(queued?.count ?? 0, "queued runs") >= RESEARCH_QUEUED_PER_ACCOUNT_MAX) {
        throw new ResearchQueueFullError();
      }

      let inheritedCorrections: RunRow[] = [];
      if (rerunOf !== null) {
        const prior = transaction.get<RunRow>("SELECT definition_id FROM research_runs WHERE id=? AND account_id=?", [
          rerunOf,
          accountId,
        ]);
        if (!prior) throw new ResearchRunNotFoundError({ cause: new Error("rerun lineage target is not owned") });
        if (storeUuid(prior.definition_id, "prior run definition id") !== definitionId) {
          throw new ResearchRunStateError("a rerun must reference a prior run of the same definition");
        }
        // Carry user overrides visibly into the new result revision.
        inheritedCorrections = transaction.all<RunRow>(
          `SELECT column_id,row_source_id,row_generation,value,status,evidence_refs,explanation
           FROM research_table_cells
           WHERE run_id=? AND account_id=? AND origin='correction'`,
          [rerunOf, accountId]
        );
      }

      const runId = randomUUID();
      transaction.run(
        `INSERT INTO research_runs
           (id,account_id,definition_id,definition_revision,status,cancel_requested,chat_model,
            provider_origin,provider_locality,provider_revision,sources,
            budget_steps,budget_searches,budget_model_requests,budget_evidence,budget_evidence_chars,budget_wall_ms,
            rerun_of,rerun_selection,review_revision,created_at)
         VALUES (?,?,?,?,'queued',0,?,?,?,?,?,?,?,?,?,?,?, ?,?,1,?)`,
        [
          runId,
          accountId,
          definitionId,
          revisionNumber,
          storedText(revision.chat_model, "definition chat model"),
          authorization.providerOrigin,
          authorization.providerLocality,
          authorization.providerRevision,
          encodeJson(
            frozen.map((source) => ({ source_id: source.sourceId, generation: source.generation })),
            "research run sources"
          ),
          RESEARCH_STEPS_MAX,
          RESEARCH_SEARCHES_MAX,
          RESEARCH_MODEL_REQUESTS_MAX,
          RESEARCH_EVIDENCE_MAX,
          RESEARCH_EVIDENCE_TOTAL_MAX_CHARS,
          RESEARCH_WALL_CLOCK_MS,
          rerunOf,
          rerunSelection === null ? null : encodeJson(rerunSelection, "research rerun selection"),
          timestamp,
        ]
      );
      for (const correction of inheritedCorrections) {
        // Never silently overwrite: the overlay rides with its provenance and
        // an explicit `corrected_from_run_id` pointing at the prior run.
        transaction.run(
          `INSERT INTO research_table_cells
             (run_id,column_id,row_source_id,row_generation,origin,account_id,value,status,evidence_refs,
              explanation,corrected_at,corrected_from_run_id,created_at,updated_at)
           VALUES (?,?,?,?, 'correction',?,?,?,?,?,?,?,?,?)
           ON CONFLICT(run_id,column_id,row_source_id,row_generation,origin) DO NOTHING`,
          [
            runId,
            storeUuid(correction.column_id, "correction column id"),
            storeUuid(correction.row_source_id, "correction row source id"),
            decodeSafeInteger(correction.row_generation, "correction row generation"),
            accountId,
            optionalText(correction.value, "inherited correction value"),
            cellStatusValue(correction.status),
            optionalText(correction.evidence_refs, "inherited correction refs") ?? "[]",
            optionalText(correction.explanation, "inherited correction explanation"),
            timestamp,
            rerunOf,
            timestamp,
            timestamp,
          ]
        );
      }
      const stored = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM research_runs WHERE id=? AND account_id=?`, [
        runId,
        accountId,
      ]);
      if (!stored) throw new ResearchRunStateError("accepted run vanished");
      return decodeRun(stored);
    });
  }

  // -- Run lifecycle ------------------------------------------------------------

  async getResearchRun(accountIdValue: string, runIdValue: string): Promise<StoredResearchRun | undefined> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const row = await this.ledger.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM research_runs WHERE id=? AND account_id=?`, [
      runId,
      accountId,
    ]);
    return row ? decodeRun(row) : undefined;
  }

  /** State, steps, counts, claims, and run-level notes for the detail route. */
  async inspectResearchRun(accountIdValue: string, runIdValue: string): Promise<ResearchRunInspection | undefined> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const run = await this.getResearchRun(accountId, runId);
    if (!run) return undefined;
    const [steps, claims, evidenceAgg, cells, notes] = await Promise.all([
      this.listResearchSteps(accountId, runId),
      this.listResearchClaims(accountId, runId),
      this.ledger.get<RunRow>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(length(excerpt)),0) AS chars FROM research_evidence WHERE run_id=? AND account_id=?",
        [runId, accountId]
      ),
      this.ledger.all<RunRow>(
        `SELECT column_id,row_source_id,row_generation,origin,value,status,evidence_refs,explanation,
                corrected_at,corrected_from_run_id,created_at,updated_at
         FROM research_table_cells WHERE run_id=? AND account_id=?
         ORDER BY row_source_id,column_id,origin`,
        [runId, accountId]
      ),
      this.ledger.all<RunRow>(
        `SELECT detail FROM research_reviews
         WHERE run_id=? AND account_id=? AND op='add_note' AND target_kind='run'
         ORDER BY seq DESC LIMIT 50`,
        [runId, accountId]
      ),
    ]);
    const tableRows = this.buildTableRowViews(
      run,
      cells.map((row) => decodeCell(row))
    );
    return Object.freeze({
      run,
      steps,
      claims,
      counts: Object.freeze({
        evidenceCount: decodeSafeInteger(evidenceAgg?.count ?? 0, "evidence count"),
        evidenceCharCount: decodeSafeInteger(evidenceAgg?.chars ?? 0, "evidence chars"),
        claimCount: claims.filter((claim) => claim.kind === "claim").length,
        gapCount: claims.filter((claim) => claim.kind === "gap").length,
        machineCellCount: cells.filter((cell) => cell.origin === "machine").length,
        correctionCellCount: cells.filter((cell) => cell.origin === "correction").length,
        tableSerializedBytes: researchTableSerializedByteLength(tableRows),
      }),
      runNotes: Object.freeze(
        notes
          .map((row) => {
            const detail = decodeJson<Record<string, unknown>>(row.detail, "research review detail");
            return typeof detail.note === "string" ? detail.note : "";
          })
          .filter((note) => note.length > 0)
      ),
    });
  }

  async listResearchRuns(
    accountIdValue: string,
    definitionIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<ResearchRunSummary>> {
    const accountId = storeUuid(accountIdValue, "account id");
    const definitionId = storeUuid(definitionIdValue, "definition id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [definitionId, accountId];
    const after = page.after ? " AND (created_at,id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM research_runs
       WHERE definition_id=? AND account_id=?${after}
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeRunSummary(row)),
      page,
      (item) => ({
        timestamp: item.createdAt,
        id: item.id,
      })
    );
  }

  /**
   * Durable cancellation. A queued run with no dispatched executor cancels
   * immediately; a running run records the durable request as `cancelling`
   * for its executor. Terminal states are absorbing (repeat is idempotent);
   * `null` means the run is not owned.
   */
  async requestResearchRunCancel(accountIdValue: string, runIdValue: string): Promise<ResearchRunStatus | null> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<RunRow>(
        "SELECT status,cancel_requested FROM research_runs WHERE id=? AND account_id=?",
        [runId, accountId]
      );
      if (!row) return null;
      const status = runStatus(row.status);
      if (status !== "queued" && status !== "running" && status !== "cancelling") return status;
      if (status === "queued") {
        transaction.run(
          `UPDATE research_runs
           SET status='cancelled',cancel_requested=1,finished_at=?,error_code='CANCELLED',error_reason=NULL
           WHERE id=? AND account_id=? AND status='queued'`,
          [this.timestamp(), runId, accountId]
        );
        return "cancelled" as const;
      }
      transaction.run("UPDATE research_runs SET status='cancelling',cancel_requested=1 WHERE id=? AND account_id=?", [
        runId,
        accountId,
      ]);
      return "cancelling" as const;
    });
  }

  /** Executor-facing transition: queued -> running; a pending cancel wins. */
  async markResearchRunRunning(accountIdValue: string, runIdValue: string): Promise<StoredResearchRun> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = this.requireRunRow(transaction, accountId, runId);
      const status = runStatus(row.status);
      if (status === "running" || status === "cancelling")
        return decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (status !== "queued") throw new ResearchRunStateError();
      if (decodeBoolean(row.cancel_requested, "cancel_requested")) {
        transaction.run(
          `UPDATE research_runs SET status='cancelled',cancel_requested=1,finished_at=?,error_code='CANCELLED'
           WHERE id=? AND account_id=? AND status='queued'`,
          [this.timestamp(), runId, accountId]
        );
        return decodeRun(this.requireRunRow(transaction, accountId, runId));
      }
      const updated = transaction.run(
        `UPDATE research_runs SET status='running',started_at=?
         WHERE id=? AND account_id=? AND status='queued' AND cancel_requested=0`,
        [this.timestamp(), runId, accountId]
      );
      if (updated.changes !== 1) throw new ResearchRunStateError();
      return decodeRun(this.requireRunRow(transaction, accountId, runId));
    });
  }

  /**
   * Durable terminal/computation-finish transition from `running`.
   * `completed` means computation finished (publication is a separate
   * reviewed action); `needs_review` preserves partial work; a retained
   * cancellation request always wins toward `cancelled`.
   */
  async finishResearchRun(
    accountIdValue: string,
    runIdValue: string,
    requestedStatus: "needs_review" | "completed" | "failed",
    errorCodeValue?: string,
    errorReasonValue?: string
  ): Promise<ResearchRunStatus> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    if (!["needs_review", "completed", "failed"].includes(requestedStatus)) {
      throw new TypeError("finishResearchRun may only settle a run to needs_review, completed, or failed");
    }
    const errorCode = errorCodeValue ? boundedInputText(errorCodeValue, "run error code", 128, true) : null;
    const errorReason = errorReasonValue ? boundedInputText(errorReasonValue, "run error reason", 500, true) : null;
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = this.requireRunRow(transaction, accountId, runId);
      const current = runStatus(row.status);
      if (current !== "running" && current !== "cancelling") {
        if (["needs_review", "completed", "failed", "cancelled"].includes(current)) return current;
        throw new ResearchRunStateError();
      }
      const status: ResearchRunStatus = decodeBoolean(row.cancel_requested, "cancel_requested")
        ? "cancelled"
        : requestedStatus;
      const updated = transaction.run(
        `UPDATE research_runs SET status=?,finished_at=?,error_code=?,error_reason=?
         WHERE id=? AND account_id=? AND status IN ('running','cancelling')`,
        [
          status,
          this.timestamp(),
          status === "cancelled" ? "CANCELLED" : errorCode,
          status === "cancelled" ? null : status === "failed" ? errorReason : null,
          runId,
          accountId,
        ]
      );
      if (updated.changes !== 1) throw new ResearchRunStateError();
      return status;
    });
  }

  /** Budget-bound usage accounting for the stage-2 runner. */
  async incrementResearchRunUsage(
    accountIdValue: string,
    runIdValue: string,
    usage: { searches?: number; modelRequests?: number }
  ): Promise<{ searchesUsed: number; modelRequestsUsed: number }> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const searches = usage.searches ?? 0;
    const modelRequests = usage.modelRequests ?? 0;
    if (![searches, modelRequests].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new RangeError("usage increments must be non-negative safe integers");
    }
    return this.ledger.withImmediateTransaction((transaction) => {
      const run = decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (run.status !== "running") throw new ResearchRunStateError();
      if (searches > 0 && run.searchesUsed + searches > run.budgets.searches) {
        throw new ResearchBudgetExhaustedError("searches");
      }
      if (modelRequests > 0 && run.modelRequestsUsed + modelRequests > run.budgets.modelRequests) {
        throw new ResearchBudgetExhaustedError("model_requests");
      }
      transaction.run(
        `UPDATE research_runs SET searches_used=searches_used+?, model_requests_used=model_requests_used+?
         WHERE id=? AND account_id=? AND status='running'`,
        [searches, modelRequests, runId, accountId]
      );
      const updated = decodeRun(this.requireRunRow(transaction, accountId, runId));
      return { searchesUsed: updated.searchesUsed, modelRequestsUsed: updated.modelRequestsUsed };
    });
  }

  /** Startup-resume claim: durable queued runs in acceptance order. */
  async listQueuedResearchRuns(limit = 100): Promise<readonly StoredResearchRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("claim limit must be a positive integer");
    const rows = await this.ledger.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM research_runs WHERE status='queued' ORDER BY created_at,id LIMIT ?`,
      [limit]
    );
    return rows.map((row) => decodeRun(row));
  }

  /**
   * Executor claim set in acceptance order: undispatched `queued` runs plus
   * dispatched `running` runs left behind by an interrupted process (after
   * `recoverInterruptedResearchRuns` reverted their steps to `pending`).
   * Cancel-requested rows are excluded — recovery settles those.
   */
  async listResumableResearchRuns(limit = 100): Promise<readonly StoredResearchRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("claim limit must be a positive integer");
    const rows = await this.ledger.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM research_runs
       WHERE status IN ('queued','running') AND cancel_requested=0 ORDER BY created_at,id LIMIT ?`,
      [limit]
    );
    return rows.map((row) => decodeRun(row));
  }

  /**
   * Startup recovery for an interrupted run. Cancel-requested runs settle as
   * `cancelled`. A running run stays active for the stage-2 runner to resume:
   * its interrupted (`running`) steps revert to `pending` under the SAME
   * identity with their attempt counter intact, so the restart retry happens
   * at most once; a step whose single restart retry was already consumed
   * settles `failed` with an honest interrupted outcome. Undispatched `queued`
   * runs are untouched and no partial output is ever settled as complete.
   */
  async recoverInterruptedResearchRuns(): Promise<{
    resumedRuns: number;
    cancelledRuns: number;
    retriedSteps: number;
    exhaustedSteps: number;
  }> {
    return this.ledger.withImmediateTransaction((transaction) => {
      const timestamp = this.timestamp();
      const cancelled = transaction.run(
        `UPDATE research_runs
         SET status='cancelled',finished_at=?,error_code='CANCELLED',error_reason=NULL
         WHERE status IN ('running','cancelling') AND cancel_requested=1`,
        [timestamp]
      ).changes;
      const running = transaction.all<RunRow>(
        `SELECT id,account_id FROM research_runs WHERE status='running' AND cancel_requested=0`
      );
      let retriedSteps = 0;
      let exhaustedSteps = 0;
      for (const run of running) {
        const runId = storeUuid(run.id, "run id");
        const accountId = storeUuid(run.account_id, "account id");
        const interrupted = transaction.all<RunRow>(
          "SELECT ordinal,attempts FROM research_steps WHERE run_id=? AND account_id=? AND status='running'",
          [runId, accountId]
        );
        for (const step of interrupted) {
          const attempts = decodeSafeInteger(step.attempts, "step attempts");
          if (attempts >= 2) {
            transaction.run(
              `UPDATE research_steps SET status='failed',outcome='interrupted retry budget exhausted',finished_at=?
               WHERE run_id=? AND account_id=? AND ordinal=? AND status='running'`,
              [timestamp, runId, accountId, decodeSafeInteger(step.ordinal, "step ordinal")]
            );
            exhaustedSteps += 1;
          } else {
            transaction.run(
              `UPDATE research_steps SET status='pending',started_at=NULL,finished_at=NULL
               WHERE run_id=? AND account_id=? AND ordinal=? AND status='running'`,
              [runId, accountId, decodeSafeInteger(step.ordinal, "step ordinal")]
            );
            retriedSteps += 1;
          }
        }
      }
      return { resumedRuns: running.length, cancelledRuns: cancelled, retriedSteps, exhaustedSteps };
    });
  }

  // -- Steps ---------------------------------------------------------------------

  /**
   * Idempotent plan materialization at dispatch time: steps are inserted in
   * ordinal order with their frozen objective/questions. Once present, the
   * materialized set is the durable plan — a retry never rewrites it.
   */
  async materializeResearchSteps(
    accountIdValue: string,
    runIdValue: string,
    steps: readonly { objective: string; questions: readonly string[] }[]
  ): Promise<readonly StoredResearchStep[]> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > RESEARCH_STEPS_MAX) {
      throw new ResearchValidationError(`a run executes 1-${RESEARCH_STEPS_MAX} steps`);
    }
    return this.ledger.withImmediateTransaction((transaction) => {
      const run = decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (run.status !== "running") throw new ResearchRunStateError("steps may only be materialized for a running run");
      const existing = transaction.all<RunRow>(
        `SELECT run_id,account_id,objective,questions,status,outcome,attempts,started_at,finished_at,ordinal
         FROM research_steps WHERE run_id=? AND account_id=? ORDER BY ordinal`,
        [runId, accountId]
      );
      if (existing.length > 0) {
        if (existing.length !== steps.length) throw new ResearchRunStateError("the durable step set already differs");
        return existing.map(decodeStep);
      }
      steps.forEach((step, ordinal) => {
        const objective = boundedInputText(step.objective, "step objective", 500, true);
        const questions = [...(step.questions ?? [])];
        if (questions.length < 1 || questions.length > 8) {
          throw new ResearchValidationError("a step holds 1-8 search questions");
        }
        transaction.run(
          `INSERT INTO research_steps (run_id,ordinal,account_id,objective,questions,status,attempts)
           VALUES (?,?,?,?,?, 'pending',0)`,
          [runId, ordinal, accountId, objective, encodeJson(questions, "step questions")]
        );
      });
      return transaction
        .all<RunRow>(
          `SELECT ordinal,objective,questions,status,outcome,attempts,started_at,finished_at
           FROM research_steps WHERE run_id=? AND account_id=? ORDER BY ordinal`,
          [runId, accountId]
        )
        .map((row) => decodeStep({ ...row, run_id: runId, account_id: accountId }));
    });
  }

  async listResearchSteps(accountIdValue: string, runIdValue: string): Promise<readonly StoredResearchStep[]> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const rows = await this.ledger.all<RunRow>(
      `SELECT ordinal,objective,questions,status,outcome,attempts,started_at,finished_at
       FROM research_steps WHERE run_id=? AND account_id=? ORDER BY ordinal`,
      [runId, accountId]
    );
    return rows.map((row) => decodeStep({ ...row, run_id: runId, account_id: accountId }));
  }

  /**
   * Step dispatch under the at-most-once restart retry identity: the attempt
   * counter may reach 2 only once (initial attempt + one restart retry).
   */
  async markResearchStepRunning(
    accountIdValue: string,
    runIdValue: string,
    ordinal: number
  ): Promise<StoredResearchStep> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= RESEARCH_STEPS_MAX) {
      throw new RangeError("step ordinal out of range");
    }
    return this.ledger.withImmediateTransaction((transaction) => {
      const run = decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (run.status !== "running") throw new ResearchRunStateError();
      const step = transaction.get<RunRow>(
        "SELECT ordinal,attempts,status FROM research_steps WHERE run_id=? AND account_id=? AND ordinal=?",
        [runId, accountId, ordinal]
      );
      if (!step) throw new ResearchRunStateError("step not found");
      if (step.status === "running") return this.requireStep(transaction, accountId, runId, ordinal);
      if (step.status !== "pending") throw new ResearchRunStateError("step already settled");
      if (decodeSafeInteger(step.attempts, "step attempts") >= 2) {
        throw new ResearchRunStateError("the at-most-once retry budget for this step is exhausted");
      }
      const updated = transaction.run(
        `UPDATE research_steps SET status='running',attempts=attempts+1,started_at=?
         WHERE run_id=? AND account_id=? AND ordinal=? AND status='pending'`,
        [this.timestamp(), runId, accountId, ordinal]
      );
      if (updated.changes !== 1) throw new ResearchRunStateError();
      return this.requireStep(transaction, accountId, runId, ordinal);
    });
  }

  /** Outcomes persist before the runner advances to the next step. */
  async recordResearchStepOutcome(
    accountIdValue: string,
    runIdValue: string,
    ordinal: number,
    status: Exclude<ResearchStepStatus, "pending" | "running">,
    outcome?: string | null
  ): Promise<StoredResearchStep> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    if (!["done", "source_changed", "failed", "skipped"].includes(status)) {
      throw new TypeError("step outcome status is unsupported");
    }
    const outcomeText =
      outcome === undefined || outcome === null ? null : boundedInputText(outcome, "step outcome", 2_000, true);
    return this.ledger.withImmediateTransaction((transaction) => {
      const run = decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (run.status !== "running" && run.status !== "cancelling") throw new ResearchRunStateError();
      const step = transaction.get<RunRow>(
        "SELECT status FROM research_steps WHERE run_id=? AND account_id=? AND ordinal=?",
        [runId, accountId, ordinal]
      );
      if (!step) throw new ResearchRunStateError("step not found");
      if (step.status === "pending") throw new ResearchRunStateError("step was never dispatched");
      transaction.run(
        `UPDATE research_steps SET status=?,outcome=?,finished_at=?
         WHERE run_id=? AND account_id=? AND ordinal=?`,
        [
          status,
          outcomeText ?? (status === "done" ? null : "no outcome recorded"),
          this.timestamp(),
          runId,
          accountId,
          ordinal,
        ]
      );
      return this.requireStep(transaction, accountId, runId, ordinal);
    });
  }

  // -- Evidence ---------------------------------------------------------------------

  /**
   * Immutable evidence capture with dedupe by (run, source, generation, chunk,
   * excerpt hash). Caps bind before the insert; a deduped retry counts
   * nothing. Only the run's frozen source/generation set is capturable.
   */
  async insertResearchEvidence(
    accountIdValue: string,
    runIdValue: string,
    input: InsertResearchEvidenceInput
  ): Promise<{ id: string; deduped: boolean }> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const evidenceId = input.id === undefined ? randomUUID() : storeUuid(input.id, "evidence id");
    const sourceId = storeUuid(input.sourceId, "evidence source id");
    const chunkId = storeUuid(input.chunkId, "evidence chunk id");
    const label = boundedInputText(input.label, "evidence label", RESEARCH_LABEL_MAX_CHARS, true);
    const excerpt = boundedInputText(input.excerpt, "evidence excerpt", RESEARCH_EVIDENCE_EXCERPT_MAX_CHARS, true);
    const query = boundedInputText(input.query, "evidence query", RESEARCH_QUERY_MAX_CHARS, true);
    if (
      typeof input.contentHash !== "string" ||
      !SHA256_PATTERN.test(input.contentHash) ||
      input.contentHash !== input.contentHash.toLowerCase()
    ) {
      throw new ResearchValidationError("evidence content hash must be a lowercase hex SHA-256");
    }
    const generation = decodeSafeInteger(input.generation, "evidence generation");
    if (generation < 0) throw new RangeError("evidence generation must be >= 0");
    if (!Number.isSafeInteger(input.stepOrdinal) || input.stepOrdinal < 0 || input.stepOrdinal >= RESEARCH_STEPS_MAX) {
      throw new ResearchValidationError("evidence step ordinal out of range");
    }
    // Reuse the M14 locator normalizer: malformed entries degrade to honest
    // omission, never a fabricated anchor; the result is capped again.
    const locators = parseChunkLocators({ loc: input.locators ?? [] });
    const retrievedAt =
      input.retrievedAt === undefined
        ? this.timestamp()
        : decodeIsoTimestamp(input.retrievedAt, "evidence retrieved_at");

    return this.ledger.withImmediateTransaction((transaction) => {
      const run = decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (run.status !== "running") throw new ResearchRunStateError("evidence may only be captured by a running run");
      if (!run.sources.some((source) => source.sourceId === sourceId && source.generation === generation)) {
        throw new ResearchRunStateError("evidence does not belong to the run's frozen source/generation scope");
      }
      const aggregate = transaction.get<RunRow>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(length(excerpt)),0) AS chars FROM research_evidence WHERE run_id=? AND account_id=?",
        [runId, accountId]
      );
      const count = decodeSafeInteger(aggregate?.count ?? 0, "evidence count");
      const chars = decodeSafeInteger(aggregate?.chars ?? 0, "evidence chars");
      // A deduped re-insert of an existing item is always allowed and counts
      // nothing; only a NEW item can breach the caps.
      const duplicate = transaction.get<RunRow>(
        `SELECT id FROM research_evidence
         WHERE run_id=? AND account_id=? AND source_id=? AND generation=? AND chunk_id=? AND content_hash=?`,
        [runId, accountId, sourceId, generation, chunkId, input.contentHash]
      );
      if (duplicate) return { id: storeUuid(duplicate.id, "evidence id"), deduped: true };
      if (count + 1 > RESEARCH_EVIDENCE_MAX) throw new ResearchEvidenceCapError(`item count ${count + 1}`);
      if (chars + excerpt.length > RESEARCH_EVIDENCE_TOTAL_MAX_CHARS) {
        throw new ResearchEvidenceCapError(`character total ${chars + excerpt.length}`);
      }
      transaction.run(
        `INSERT INTO research_evidence
           (id,account_id,run_id,source_id,generation,chunk_id,label,locators,excerpt,content_hash,
            retrieved_at,step_ordinal,query,irrelevant)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)
         ON CONFLICT(run_id,source_id,generation,chunk_id,content_hash) DO NOTHING`,
        [
          evidenceId,
          accountId,
          runId,
          sourceId,
          generation,
          chunkId,
          label,
          encodeJson(locators, "evidence locators"),
          excerpt,
          input.contentHash,
          retrievedAt,
          input.stepOrdinal,
          query,
        ]
      );
      const stored = transaction.get<RunRow>(
        `SELECT id FROM research_evidence
         WHERE run_id=? AND account_id=? AND source_id=? AND generation=? AND chunk_id=? AND content_hash=?`,
        [runId, accountId, sourceId, generation, chunkId, input.contentHash]
      );
      if (!stored) throw new ResearchRunStateError("evidence insert vanished");
      return { id: storeUuid(stored.id, "evidence id"), deduped: false };
    });
  }

  async listResearchEvidence(
    accountIdValue: string,
    runIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<StoredResearchEvidence>> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [runId, accountId];
    const after = page.after ? " AND (retrieved_at,id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<RunRow>(
      `SELECT id,run_id,source_id,generation,chunk_id,label,locators,excerpt,content_hash,
              retrieved_at,step_ordinal,query,irrelevant
       FROM research_evidence WHERE run_id=? AND account_id=?${after}
       ORDER BY retrieved_at DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) =>
        Object.freeze({
          id: storeUuid(row.id, "evidence id"),
          runId: storeUuid(row.run_id, "evidence run id"),
          sourceId: storeUuid(row.source_id, "evidence source id"),
          generation: decodeSafeInteger(row.generation, "evidence generation"),
          chunkId: storeUuid(row.chunk_id, "evidence chunk id"),
          label: storedText(row.label, "evidence label"),
          locators: parseChunkLocators({ loc: decodeJson(row.locators, "evidence locators") }),
          excerpt: storedText(row.excerpt, "evidence excerpt"),
          contentHash: storedText(row.content_hash, "evidence content hash"),
          retrievedAt: decodeIsoTimestamp(row.retrieved_at, "evidence retrieved_at"),
          stepOrdinal: decodeSafeInteger(row.step_ordinal, "evidence step ordinal"),
          query: storedText(row.query, "evidence query"),
          irrelevant: decodeBoolean(row.irrelevant, "evidence irrelevant"),
        })
      ),
      page,
      (item) => ({ timestamp: item.retrievedAt, id: item.id })
    );
  }

  // -- Claims and gaps ------------------------------------------------------------

  /**
   * Claims reference only evidence actually captured in this run (FK-checked
   * in the same transaction). Conflicting claims link at least two differing
   * excerpts; gaps are separate rows with no evidence references. The 100/50
   * per-run caps bind here.
   */
  async addResearchClaim(
    accountIdValue: string,
    runIdValue: string,
    input: AddResearchClaimInput
  ): Promise<StoredResearchClaim> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const claimId = input.id === undefined ? randomUUID() : storeUuid(input.id, "claim id");
    const kind = input.kind;
    if (kind !== "claim" && kind !== "gap") throw new ResearchValidationError("claim kind must be claim or gap");
    const text = boundedInputText(input.text, "claim text", RESEARCH_CLAIM_TEXT_MAX_CHARS, true);
    const refs = inputRefs(input.evidenceRefs);
    const timestamp = this.timestamp();
    await this.ledger.withImmediateTransaction((transaction) => {
      const run = decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (run.status !== "running" && run.status !== "needs_review") {
        throw new ResearchRunStateError("claims and gaps may only be recorded by an active or review-paused run");
      }
      const counts = transaction.get<RunRow>(
        `SELECT COALESCE(SUM(kind='claim'),0) AS claims, COALESCE(SUM(kind='gap'),0) AS gaps
         FROM research_claims WHERE run_id=? AND account_id=?`,
        [runId, accountId]
      );
      if (kind === "claim" && decodeSafeInteger(counts?.claims ?? 0, "claims") >= RESEARCH_CLAIMS_PER_RUN_MAX) {
        throw new ResearchClaimCapError(false);
      }
      if (kind === "gap" && decodeSafeInteger(counts?.gaps ?? 0, "gaps") >= RESEARCH_GAPS_PER_RUN_MAX) {
        throw new ResearchClaimCapError(true);
      }
      let classification: ResearchClaimClassification | null = null;
      if (kind === "claim") {
        classification = input.classification ?? null;
        if (classification === null) throw new ResearchValidationError("claims require a classification");
        if (classification === "conflicting" && refs.length < 2) {
          throw new ResearchValidationError("conflicting claims must link at least two evidence references");
        }
      } else if (input.classification !== undefined && input.classification !== null) {
        throw new ResearchValidationError("gaps carry no classification");
      }
      if (kind === "gap" && refs.length > 0) throw new ResearchValidationError("gaps carry no evidence references");
      if (refs.length > 0) this.assertRunEvidence(transaction, accountId, runId, refs);
      const userNote =
        input.userNote === undefined || input.userNote === null
          ? null
          : boundedInputText(input.userNote, "user note", RESEARCH_NOTE_MAX_CHARS, true);
      transaction.run(
        `INSERT INTO research_claims
           (id,account_id,run_id,kind,text,corrected_text,classification,evidence_refs,user_note,review_state,
            created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,COALESCE(?, '[]'),?, 'pending',?,?)`,
        [
          claimId,
          accountId,
          runId,
          kind,
          text,
          null,
          classification,
          refs.length ? encodeJson(refs, "claim evidence refs") : null,
          userNote,
          timestamp,
          timestamp,
        ]
      );
    });
    const stored = await this.getResearchClaim(accountId, runId, claimId);
    if (!stored) throw new ResearchRunStateError("claim insert vanished");
    return stored;
  }

  async getResearchClaim(
    accountIdValue: string,
    runIdValue: string,
    claimIdValue: string
  ): Promise<StoredResearchClaim | undefined> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const claimId = storeUuid(claimIdValue, "claim id");
    const row = await this.ledger.get<RunRow>(
      `SELECT id,run_id,kind,text,corrected_text,classification,evidence_refs,user_note,review_state,
              created_at,updated_at
       FROM research_claims WHERE id=? AND run_id=? AND account_id=?`,
      [claimId, runId, accountId]
    );
    return row ? decodeClaim(row) : undefined;
  }

  async listResearchClaims(accountIdValue: string, runIdValue: string): Promise<readonly StoredResearchClaim[]> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const rows = await this.ledger.all<RunRow>(
      `SELECT id,run_id,kind,text,corrected_text,classification,evidence_refs,user_note,review_state,
              created_at,updated_at
       FROM research_claims WHERE run_id=? AND account_id=? ORDER BY created_at,id`,
      [runId, accountId]
    );
    return rows.map(decodeClaim);
  }

  // -- Comparison table -------------------------------------------------------------

  /**
   * Machine cell write. The column must exist in the run's frozen revision
   * and the row must be one of the run's frozen source identities. Raw output
   * that does not validate against the column type is recorded `invalid`
   * verbatim — never coerced. The machine row is replaced (delete+insert) on
   * a legitimate retry; the user correction overlay is untouched and the
   * original machine row is UPDATE-immutable at the schema level. The 1 MiB
   * serialized table cap binds over the whole table, machine + overlay.
   */
  async recordResearchMachineCell(
    accountIdValue: string,
    runIdValue: string,
    input: RecordResearchCellInput
  ): Promise<StoredResearchCell> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const columnId = researchUuid(input.columnId, "column id");
    const rowSourceId = researchUuid(input.rowSourceId, "row source id");
    const refs = inputRefs(input.evidenceRefs);
    const explanation =
      input.explanation === undefined || input.explanation === null
        ? null
        : boundedInputText(input.explanation, "cell explanation", RESEARCH_CELL_EXPLANATION_MAX_CHARS, true);
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      const run = decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (run.status !== "running")
        throw new ResearchRunStateError("machine cells may only be written by a running run");
      const rowGeneration = this.frozenRowGeneration(run, rowSourceId);
      const column = this.frozenColumn(transaction, accountId, run, columnId);
      const cell =
        input.assertedStatus === undefined || input.assertedStatus === null
          ? // Raw model output: classify honestly, preserving originals as `invalid`.
            classifyResearchCellPayload(column, input.rawValue)
          : validateResearchCellPayload(column, input.assertedStatus, input.rawValue);
      if (refs.length > 0) this.assertRunEvidence(transaction, accountId, runId, refs);
      transaction.run(
        "DELETE FROM research_table_cells WHERE run_id=? AND account_id=? AND column_id=? AND row_source_id=? AND row_generation=? AND origin='machine'",
        [runId, accountId, columnId, rowSourceId, rowGeneration]
      );
      transaction.run(
        `INSERT INTO research_table_cells
           (run_id,column_id,row_source_id,row_generation,origin,account_id,value,status,evidence_refs,
            explanation,corrected_at,created_at,updated_at)
         VALUES (?,?,?,?, 'machine',?,?,?,?,?,NULL,?,?)`,
        [
          runId,
          columnId,
          rowSourceId,
          rowGeneration,
          accountId,
          cell.value === null ? null : encodeJson(cell.value, "cell value"),
          cell.status,
          refs.length ? encodeJson(refs, "cell evidence refs") : "[]",
          explanation,
          timestamp,
          timestamp,
        ]
      );
      this.assertTableWithinLimit(transaction, accountId, run);
      const stored = transaction.get<RunRow>(
        `SELECT column_id,row_source_id,row_generation,origin,value,status,evidence_refs,explanation,
                corrected_at,corrected_from_run_id,created_at,updated_at
         FROM research_table_cells
         WHERE run_id=? AND account_id=? AND column_id=? AND row_source_id=? AND row_generation=? AND origin='machine'`,
        [runId, accountId, columnId, rowSourceId, rowGeneration]
      );
      if (!stored) throw new ResearchRunStateError("cell insert vanished");
      return decodeCell(stored);
    });
  }

  /** Full bounded table: frozen column schema plus keyset rows (merged view). */
  async getResearchTable(
    accountIdValue: string,
    runIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<ResearchTablePage | undefined> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    const run = await this.getResearchRun(accountId, runId);
    if (!run) return undefined;
    const page = validateCatalogPageRequest(pageValue);
    const columns = await this.ledger.withImmediateTransaction(async (transaction) =>
      this.frozenColumns(transaction, accountId, run)
    );
    const sortedRows = [...run.sources]
      .sort((left, right) => (left.sourceId === right.sourceId ? 0 : left.sourceId < right.sourceId ? -1 : 1))
      .reverse();
    const afterId = page.after ? page.after.id : null;
    const window = afterId ? sortedRows.filter((source) => source.sourceId < afterId) : sortedRows;
    const pageRows = window.slice(0, page.limit);
    const sourceIds = pageRows.map((source) => source.sourceId);
    const cells = sourceIds.length
      ? await this.ledger.all<RunRow>(
          `SELECT column_id,row_source_id,row_generation,origin,value,status,evidence_refs,explanation,
                  corrected_at,corrected_from_run_id,created_at,updated_at
           FROM research_table_cells
           WHERE run_id=? AND account_id=? AND row_source_id IN (${placeholders(sourceIds.length)})
           ORDER BY row_source_id,column_id,origin`,
          [runId, accountId, ...sourceIds]
        )
      : [];
    const cellsByRow = new Map<string, StoredResearchCell[]>();
    for (const row of cells.map((row) => decodeCell(row))) {
      const list = cellsByRow.get(row.rowSourceId) ?? [];
      list.push(row);
      cellsByRow.set(row.rowSourceId, list);
    }
    const allCells = await this.ledger.all<RunRow>(
      `SELECT column_id,row_source_id,row_generation,origin,value,status,evidence_refs,explanation,
              corrected_at,corrected_from_run_id,created_at,updated_at
       FROM research_table_cells WHERE run_id=? AND account_id=?
       ORDER BY row_source_id,column_id,origin`,
      [runId, accountId]
    );
    const fullTable = this.buildTableRowViews(
      run,
      allCells.map((row) => decodeCell(row))
    );
    const items = pageRows.map((source) => {
      const rowCells = cellsByRow.get(source.sourceId) ?? [];
      return Object.freeze({
        row_source_id: source.sourceId,
        row_generation: source.generation,
        cells: rowCells,
      });
    });
    const nextItem = window.length > page.limit && items.length ? items[items.length - 1] : null;
    return Object.freeze({
      columns,
      page: Object.freeze({
        items,
        next: nextItem ? Object.freeze({ timestamp: run.createdAt, id: nextItem.row_source_id }) : null,
      }),
      serializedBytes: researchTableSerializedByteLength(fullTable),
    });
  }

  // -- Review -----------------------------------------------------------------------

  /**
   * Revision-CAS review batch. The run's `review_revision` head CAS commits
   * atomically with every state mutation and one append-only ledger row per
   * operation. Claim text is never rewritten by a correction (the original
   * stays; `corrected_text` is the user revision); cell corrections write the
   * overlay row with provenance and never touch machine history; notes are
   * review content and never become evidence.
   */
  async applyResearchReviewOps(
    accountIdValue: string,
    runIdValue: string,
    expectedRevision: number,
    opsValue: readonly unknown[] | unknown
  ): Promise<{ reviewRevision: number; applied: number; run: StoredResearchRun }> {
    const accountId = storeUuid(accountIdValue, "account id");
    const runId = storeUuid(runIdValue, "run id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new RangeError("expectedRevision must be a positive safe integer");
    }
    const ops = normalizeResearchReviewOps(opsValue);
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = this.requireRunRow(transaction, accountId, runId);
      const run = decodeRun(row);
      if (run.status !== "needs_review" && run.status !== "completed") {
        throw new ResearchRunStateError("only finished (completed or needs_review) runs accept review operations");
      }
      const cas = transaction.run(
        "UPDATE research_runs SET review_revision=review_revision+1 WHERE id=? AND account_id=? AND review_revision=?",
        [runId, accountId, expectedRevision]
      );
      if (cas.changes !== 1) throw new ResearchRevisionConflictError();
      const reviewRevision = expectedRevision + 1;
      const baseSeq = decodeSafeInteger(
        transaction.get<RunRow>(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM research_reviews WHERE run_id=? AND account_id=?",
          [runId, accountId]
        )?.seq ?? 0,
        "review seq"
      );
      let applied = 0;
      for (const op of ops) {
        applied += 1;
        this.applyReviewOp(transaction, accountId, run, op, timestamp);
        // One append-only ledger row per applied operation, in batch order.
        transaction.run(
          `INSERT INTO research_reviews (run_id,seq,account_id,review_revision,op,target_kind,target,detail,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            runId,
            baseSeq + applied,
            accountId,
            reviewRevision,
            op.op,
            reviewTargetKind(op),
            reviewTargetId(op),
            encodeJson(reviewDetail(op), "review detail"),
            timestamp,
          ]
        );
      }
      const updated = decodeRun(this.requireRunRow(transaction, accountId, runId));
      if (updated.reviewRevision !== reviewRevision) {
        throw new ResearchRunStateError("review revision CAS vanished");
      }
      return { reviewRevision, applied, run: updated };
    });
  }

  // -- Internals ----------------------------------------------------------------------

  private applyReviewOp(
    transaction: SqliteTransaction,
    accountId: string,
    run: StoredResearchRun,
    op: ResearchReviewOp,
    timestamp: string
  ): void {
    const runId = run.id;
    switch (op.op) {
      case "accept_claim":
      case "reject_claim": {
        this.requireClaimRow(transaction, accountId, runId, op.claim_id);
        transaction.run(
          "UPDATE research_claims SET review_state=?,updated_at=? WHERE id=? AND run_id=? AND account_id=?",
          [op.op === "accept_claim" ? "accepted" : "rejected", timestamp, op.claim_id, runId, accountId]
        );
        return;
      }
      case "add_note": {
        // The normalizer guarantees a target_id for claim/evidence notes and
        // forbids one for run notes.
        const targetId = op.target_kind === "run" ? "run" : researchUuid(op.target_id, "note target id");
        if (op.target_kind === "claim") {
          this.requireClaimRow(transaction, accountId, runId, targetId);
          transaction.run(
            "UPDATE research_claims SET user_note=?,updated_at=? WHERE id=? AND run_id=? AND account_id=?",
            [op.note, timestamp, targetId, runId, accountId]
          );
        } else if (op.target_kind === "evidence") {
          if (
            !transaction.get("SELECT 1 FROM research_evidence WHERE id=? AND run_id=? AND account_id=?", [
              targetId,
              runId,
              accountId,
            ])
          ) {
            throw new ResearchReviewTargetNotFoundError();
          }
        }
        // Notes are review content only: the ledger row carries the text and
        // nothing here can ever create an evidence row.
        return;
      }
      case "correct_claim": {
        this.requireClaimRow(transaction, accountId, runId, op.claim_id);
        transaction.run(
          "UPDATE research_claims SET corrected_text=?,updated_at=? WHERE id=? AND run_id=? AND account_id=?",
          [op.text, timestamp, op.claim_id, runId, accountId]
        );
        return;
      }
      case "correct_cell": {
        const rowGeneration = this.frozenRowGeneration(run, op.row_source_id);
        const column = this.frozenColumn(transaction, accountId, run, op.column_id);
        const machine = transaction.get<RunRow>(
          `SELECT value,status,evidence_refs FROM research_table_cells
           WHERE run_id=? AND account_id=? AND column_id=? AND row_source_id=? AND row_generation=? AND origin='machine'`,
          [runId, accountId, op.column_id, op.row_source_id, rowGeneration]
        );
        if (!machine) throw new ResearchReviewTargetNotFoundError({ cause: new Error("no machine cell to correct") });
        const nextValue = op.value === undefined ? decodeJsonValue(machine.value, "machine cell value") : op.value;
        // When the correction asserts a value, it must type against the
        // column — the user still cannot store a coerced fact.
        const assertedStatus: ResearchCellStatus =
          op.status ??
          (op.value !== undefined
            ? validateResearchTypedValue(column, op.value).ok
              ? "supported"
              : "invalid"
            : cellStatusValue(machine.status));
        const cell = validateResearchCellPayload(column, assertedStatus, nextValue);
        const refs = inputRefs(decodeStringArray(machine.evidence_refs, "machine cell refs"));
        transaction.run(
          `INSERT INTO research_table_cells
             (run_id,column_id,row_source_id,row_generation,origin,account_id,value,status,evidence_refs,
              explanation,corrected_at,created_at,updated_at)
           VALUES (?,?,?,?, 'correction',?,?,?,?,?,?,?,?)
           ON CONFLICT(run_id,column_id,row_source_id,row_generation,origin) DO UPDATE SET
             value=excluded.value,status=excluded.status,evidence_refs=excluded.evidence_refs,
             explanation=excluded.explanation,corrected_at=excluded.corrected_at,updated_at=excluded.updated_at`,
          [
            runId,
            op.column_id,
            op.row_source_id,
            rowGeneration,
            accountId,
            cell.value === null ? null : encodeJson(cell.value, "cell value"),
            cell.status,
            refs.length ? encodeJson(refs, "cell evidence refs") : "[]",
            op.explanation ?? null,
            timestamp,
            timestamp,
            timestamp,
          ]
        );
        this.assertTableWithinLimit(transaction, accountId, run);
        return;
      }
      case "flag_evidence": {
        if (
          !transaction.get("SELECT 1 FROM research_evidence WHERE id=? AND run_id=? AND account_id=?", [
            op.evidence_id,
            runId,
            accountId,
          ])
        ) {
          throw new ResearchReviewTargetNotFoundError();
        }
        transaction.run("UPDATE research_evidence SET irrelevant=? WHERE id=? AND run_id=? AND account_id=?", [
          op.irrelevant ? 1 : 0,
          op.evidence_id,
          runId,
          accountId,
        ]);
        return;
      }
    }
  }

  private requireRunRow(transaction: SqliteTransaction, accountId: string, runId: string): RunRow {
    const row = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM research_runs WHERE id=? AND account_id=?`, [
      runId,
      accountId,
    ]);
    if (!row) throw new ResearchRunNotFoundError();
    return row;
  }

  private requireStep(
    transaction: SqliteTransaction,
    accountId: string,
    runId: string,
    ordinal: number
  ): StoredResearchStep {
    const row = transaction.get<RunRow>(
      `SELECT ordinal,objective,questions,status,outcome,attempts,started_at,finished_at
       FROM research_steps WHERE run_id=? AND account_id=? AND ordinal=?`,
      [runId, accountId, ordinal]
    );
    if (!row) throw new ResearchRunStateError("step vanished");
    return decodeStep({ ...row, run_id: runId, account_id: accountId });
  }

  private requireClaimRow(transaction: SqliteTransaction, accountId: string, runId: string, claimId: string): void {
    if (
      !transaction.get("SELECT 1 FROM research_claims WHERE id=? AND run_id=? AND account_id=?", [
        claimId,
        runId,
        accountId,
      ])
    ) {
      throw new ResearchReviewTargetNotFoundError();
    }
  }

  private assertRunEvidence(
    transaction: SqliteTransaction,
    accountId: string,
    runId: string,
    refs: readonly string[]
  ): void {
    if (!refs.length) return;
    const rows = transaction.all<RunRow>(
      `SELECT id FROM research_evidence WHERE run_id=? AND account_id=? AND id IN (${placeholders(refs.length)})`,
      [runId, accountId, ...refs]
    );
    const owned = new Set(rows.map((row) => storeUuid(row.id, "owned evidence id")));
    if (refs.some((ref) => !owned.has(ref))) throw new ResearchEvidenceRefError();
  }

  private frozenRowGeneration(run: StoredResearchRun, rowSourceId: string): number {
    const frozen = run.sources.find((source) => source.sourceId === rowSourceId);
    if (!frozen) {
      throw new ResearchValidationError("comparison rows must be one of the run's selected documents");
    }
    return frozen.generation;
  }

  private frozenColumns(
    transaction: SqliteTransaction,
    accountId: string,
    run: StoredResearchRun
  ): readonly ResearchColumnDeclaration[] {
    const revision = transaction.get<RunRow>(
      "SELECT columns FROM research_definition_revisions WHERE definition_id=? AND revision=? AND account_id=?",
      [run.definitionId, run.definitionRevision, accountId]
    );
    if (!revision) throw new ResearchRunStateError("pinned revision row vanished");
    return decodeColumns(revision.columns, "pinned revision columns");
  }

  private frozenColumn(
    transaction: SqliteTransaction,
    accountId: string,
    run: StoredResearchRun,
    columnId: string
  ): ResearchColumnDeclaration {
    const column = this.frozenColumns(transaction, accountId, run).find((entry) => entry.id === columnId);
    if (!column) throw new ResearchValidationError("column is not declared by the run's pinned definition revision");
    return column;
  }

  /** The 1 MiB serialized comparison-table cap over machine + overlay rows. */
  private assertTableWithinLimit(transaction: SqliteTransaction, accountId: string, run: StoredResearchRun): void {
    const rows = transaction
      .all<RunRow>(
        `SELECT column_id,row_source_id,row_generation,origin,value,status,evidence_refs,explanation,
                corrected_at,corrected_from_run_id,created_at,updated_at
         FROM research_table_cells WHERE run_id=? AND account_id=?
         ORDER BY row_source_id,column_id,origin`,
        [run.id, accountId]
      )
      .map((row) => decodeCell(row));
    const bytes = researchTableSerializedByteLength(this.buildTableRowViews(run, rows));
    if (bytes > RESEARCH_TABLE_SERIALIZED_MAX_BYTES) throw new ResearchTableLimitError();
  }

  private buildTableRowViews(
    run: StoredResearchRun,
    cells: readonly StoredResearchCell[]
  ): readonly ResearchTableRowView[] {
    const byRow = new Map<string, StoredResearchCell[]>();
    for (const cell of cells) {
      const list = byRow.get(cell.rowSourceId) ?? [];
      list.push(cell);
      byRow.set(cell.rowSourceId, list);
    }
    const sources = [...run.sources].sort((left, right) => (left.sourceId < right.sourceId ? -1 : 1)).reverse();
    return sources.map((source) => {
      const rowCells = (byRow.get(source.sourceId) ?? []).sort((left, right) =>
        left.columnId === right.columnId
          ? left.origin.localeCompare(right.origin)
          : left.columnId < right.columnId
            ? -1
            : 1
      );
      const merged: Record<string, unknown> = {};
      for (const cell of rowCells) {
        const key = cell.columnId;
        const previous = merged[key] as Record<string, unknown> | undefined;
        const entry = Object.freeze({
          origin: cell.origin,
          value: cell.value,
          status: cell.status,
          evidence_refs: cell.evidenceRefs,
          explanation: cell.explanation,
          corrected_at: cell.correctedAt,
          corrected_from_run_id: cell.correctedFromRunId,
        });
        // Correction rows merge over machine rows for the merged view while
        // both stay individually present in the `cells` list of reads.
        if (previous === undefined || cell.origin === "correction") merged[key] = entry;
      }
      return Object.freeze({
        row_source_id: source.sourceId,
        row_generation: source.generation,
        cells: merged,
      });
    });
  }

  private async sourceAvailability(
    accountId: string,
    sourceIds: readonly string[]
  ): Promise<readonly ResearchSourceAvailability[]> {
    if (!sourceIds.length) return Object.freeze([]);
    const rows = await this.ledger.all<RunRow>(
      `SELECT id,status,ready_generation FROM sources WHERE account_id=? AND id IN (${placeholders(sourceIds.length)})`,
      [accountId, ...sourceIds]
    );
    const live = new Map(rows.map((row) => [storeUuid(row.id, "source id"), row]));
    return Object.freeze(
      sourceIds.map((sourceId) => {
        const row = live.get(sourceId);
        if (!row) return Object.freeze({ sourceId, availability: "missing" as const, readyGeneration: null });
        if (row.status === "ready" && row.ready_generation !== null && row.ready_generation !== undefined) {
          return Object.freeze({
            sourceId,
            availability: "ready" as const,
            readyGeneration: decodeSafeInteger(row.ready_generation, "source ready generation"),
          });
        }
        return Object.freeze({ sourceId, availability: "unready" as const, readyGeneration: null });
      })
    );
  }

  private assertIdsOwned(
    transaction: SqliteTransaction,
    accountId: string,
    table: "sources" | "libraries",
    ids: readonly string[],
    label: string
  ): void {
    if (!ids.length) return;
    const rows = transaction.all<RunRow>(
      `SELECT id FROM ${table} WHERE account_id=? AND id IN (${placeholders(ids.length)})`,
      [accountId, ...ids]
    );
    const owned = new Set(rows.map((row) => storeUuid(row.id, `${label} id`)));
    for (const id of ids) {
      if (!owned.has(id)) throw new ResearchNotFoundError({ cause: new Error(`${label} ${id} is not owned`) });
    }
  }

  private insertRevision(
    transaction: SqliteTransaction,
    accountId: string,
    definitionId: string,
    revision: number,
    content: ResearchDefinitionContent,
    timestamp: string
  ): void {
    transaction.run(
      `INSERT INTO research_definition_revisions
         (definition_id,revision,account_id,title,question,source_ids,library_ids,chat_model,output_kind,columns,plan,
          created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        definitionId,
        revision,
        accountId,
        content.title,
        content.question,
        encodeJson(content.sourceIds, "definition source ids"),
        encodeJson(content.libraryIds, "definition library ids"),
        content.chatModel,
        content.outputKind,
        encodeJson(content.columns, "definition columns"),
        encodeJson(content.plan, "definition plan"),
        timestamp,
      ]
    );
  }

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "research store clock");
  }
}

// ---------------------------------------------------------------------------
// Row decoders (step/claim) and review projections
// ---------------------------------------------------------------------------

function decodeStep(row: RunRow): StoredResearchStep {
  return Object.freeze({
    ordinal: decodeSafeInteger(row.ordinal, "step ordinal"),
    objective: storedText(row.objective, "step objective"),
    questions: decodeStringArray(row.questions, "step questions"),
    status: stepStatus(row.status),
    outcome: optionalText(row.outcome, "step outcome"),
    attempts: decodeSafeInteger(row.attempts, "step attempts"),
    startedAt: optionalTimestamp(row.started_at, "step started_at"),
    finishedAt: optionalTimestamp(row.finished_at, "step finished_at"),
  });
}

function decodeClaim(row: RunRow): StoredResearchClaim {
  const kind =
    row.kind === "claim" || row.kind === "gap"
      ? row.kind
      : (() => {
          throw new TypeError("bad claim kind");
        })();
  const reviewState =
    row.review_state === "pending" || row.review_state === "accepted" || row.review_state === "rejected"
      ? row.review_state
      : (() => {
          throw new TypeError("bad review state");
        })();
  const classification = optionalText(row.classification, "claim classification");
  if (classification !== null && !["supported", "conflicting", "unsupported"].includes(classification)) {
    throw new TypeError("bad claim classification");
  }
  return Object.freeze({
    id: storeUuid(row.id, "claim id"),
    runId: storeUuid(row.run_id, "claim run id"),
    kind,
    text: storedText(row.text, "claim text"),
    correctedText: optionalText(row.corrected_text, "claim corrected text"),
    classification: classification as ResearchClaimClassification | null,
    evidenceRefs: decodeStringArray(row.evidence_refs, "claim evidence refs"),
    userNote: optionalText(row.user_note, "claim user note"),
    reviewState,
    createdAt: decodeIsoTimestamp(row.created_at, "claim created_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "claim updated_at"),
  });
}

function reviewTargetKind(op: ResearchReviewOp): string {
  switch (op.op) {
    case "accept_claim":
    case "reject_claim":
    case "correct_claim":
      return "claim";
    case "add_note":
      return op.target_kind;
    case "correct_cell":
      return "cell";
    case "flag_evidence":
      return "evidence";
  }
}

function reviewTargetId(op: ResearchReviewOp): string {
  switch (op.op) {
    case "accept_claim":
    case "reject_claim":
      return op.claim_id;
    case "add_note":
      return op.target_kind === "run" ? "run" : (op.target_id as string);
    case "correct_claim":
      return op.claim_id;
    case "correct_cell":
      return `${op.column_id}:${op.row_source_id}`;
    case "flag_evidence":
      return op.evidence_id;
  }
}

function reviewDetail(op: ResearchReviewOp): Record<string, unknown> {
  switch (op.op) {
    case "accept_claim":
    case "reject_claim":
      return {};
    case "add_note":
      return { note: op.note };
    case "correct_claim":
      return { text: op.text };
    case "correct_cell":
      return {
        ...(op.value === undefined ? {} : { value: op.value }),
        ...(op.status === undefined ? {} : { status: op.status }),
        ...(op.explanation === undefined ? {} : { explanation: op.explanation }),
      };
    case "flag_evidence":
      return { irrelevant: op.irrelevant };
  }
}

export function createResearchStore(ledger: SqliteLedger, options: ResearchStoreOptions = {}): ResearchStore {
  return new ResearchStore(ledger, options);
}
