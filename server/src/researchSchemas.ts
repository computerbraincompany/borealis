/**
 * Bounds, validation, and budgets for durable local research (M15).
 *
 * This module is the single semantic contract shared by the research store,
 * the runner (stage 2), and the routes: field bounds, typed column/value
 * validation, the fixed orchestration budgets, and the canonical 1 MiB
 * serialized comparison-table cap helpers. The SQLite CHECKs in schema v25
 * are the durable last-line shape bounds; everything stricter lives here and
 * is enforced by the store inside the same transaction as the write.
 *
 * Fail-closed rules that must never be relaxed:
 * - A stored draft definition may hold a selected-empty source set; ONLY run
 *   Start admission rejects it (with an explanation), never storage.
 * - Typed cell values are never string-coerced: a model value that does not
 *   validate against its column type is recorded `invalid` with the original
 *   machine output preserved, never rewritten into a string "fact".
 * - Review notes are review content: they never become evidence.
 */

// ---------------------------------------------------------------------------
// Budgets (independent research orchestration limits; the ordinary sixteen-
// round chat loop is untouched by these numbers)
// ---------------------------------------------------------------------------

export const RESEARCH_STEPS_MAX = 8;
export const RESEARCH_QUESTIONS_PER_STEP_MAX = 8;
/** Search operations per run; also the total plan question budget. */
export const RESEARCH_SEARCHES_MAX = 32;
/** Model requests per run, including planning and synthesis. */
export const RESEARCH_MODEL_REQUESTS_MAX = 40;
export const RESEARCH_EVIDENCE_MAX = 100;
export const RESEARCH_EVIDENCE_EXCERPT_MAX_CHARS = 2_000;
export const RESEARCH_EVIDENCE_TOTAL_MAX_CHARS = 200_000;
export const RESEARCH_WALL_CLOCK_MS = 15 * 60 * 1000;
/** Undispatched `queued` runs accepted per account before Start refuses. */
export const RESEARCH_QUEUED_PER_ACCOUNT_MAX = 10;

// ---------------------------------------------------------------------------
// Field bounds
// ---------------------------------------------------------------------------

export const RESEARCH_TITLE_MAX_CHARS = 120;
export const RESEARCH_QUESTION_MAX_CHARS = 4_000;
export const RESEARCH_MODEL_MAX_CHARS = 256;
export const RESEARCH_SOURCE_MAX_COUNT = 100;
export const RESEARCH_LIBRARY_PROVENANCE_MAX = 20;
export const RESEARCH_STEP_OBJECTIVE_MAX_CHARS = 500;
export const RESEARCH_STEP_QUESTION_MAX_CHARS = 1_000;
export const RESEARCH_STEP_OUTCOME_MAX_CHARS = 2_000;
export const RESEARCH_PLAN_SERIALIZED_MAX_CHARS = 32_768;
export const RESEARCH_COLUMN_MAX_COUNT = 20;
export const RESEARCH_COLUMN_LABEL_MAX_CHARS = 80;
export const RESEARCH_COLUMN_QUESTION_MAX_CHARS = 500;
export const RESEARCH_COLUMN_UNIT_MAX_CHARS = 40;
export const RESEARCH_ENUM_CHOICES_MAX = 20;
export const RESEARCH_ENUM_CHOICE_MAX_CHARS = 80;
export const RESEARCH_CLAIMS_PER_RUN_MAX = 100;
export const RESEARCH_GAPS_PER_RUN_MAX = 50;
export const RESEARCH_CLAIM_TEXT_MAX_CHARS = 2_000;
export const RESEARCH_NOTE_MAX_CHARS = 2_000;
export const RESEARCH_EVIDENCE_REFS_MAX = 5;
export const RESEARCH_LABEL_MAX_CHARS = 200;
export const RESEARCH_QUERY_MAX_CHARS = 1_000;
export const RESEARCH_CELL_EXPLANATION_MAX_CHARS = 1_000;
export const RESEARCH_REVIEW_OPS_MAX = 100;
/** Serialized comparison-table cap with an explicit limit state. */
export const RESEARCH_TABLE_SERIALIZED_MAX_BYTES = 1_048_576;

export const RESEARCH_OUTPUT_KINDS = Object.freeze(["memo", "comparison"] as const);
export const RESEARCH_COLUMN_TYPES = Object.freeze(["text", "number", "date", "boolean", "enum"] as const);
export const RESEARCH_CLAIM_CLASSIFICATIONS = Object.freeze(["supported", "conflicting", "unsupported"] as const);
export const RESEARCH_CELL_STATUSES = Object.freeze(["supported", "conflicting", "not_found", "invalid"] as const);
export const RESEARCH_RUN_STATUSES = Object.freeze([
  "queued",
  "running",
  "cancelling",
  "needs_review",
  "completed",
  "failed",
  "cancelled",
] as const);

export type ResearchOutputKind = (typeof RESEARCH_OUTPUT_KINDS)[number];
export type ResearchColumnType = (typeof RESEARCH_COLUMN_TYPES)[number];
export type ResearchClaimClassification = (typeof RESEARCH_CLAIM_CLASSIFICATIONS)[number];
export type ResearchCellStatus = (typeof RESEARCH_CELL_STATUSES)[number];
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export class ResearchValidationError extends Error {
  readonly code = "RESEARCH_VALIDATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "ResearchValidationError";
  }
}

// ---------------------------------------------------------------------------
// Normalized shapes
// ---------------------------------------------------------------------------

export interface ResearchColumnDeclaration {
  readonly id: string;
  readonly label: string;
  readonly question: string;
  readonly type: ResearchColumnType;
  readonly unit: string | null;
  readonly choices: readonly string[] | null;
}

export interface ResearchPlanStep {
  readonly id: string;
  readonly objective: string;
  readonly questions: readonly string[];
}

export interface ResearchPlan {
  readonly steps: readonly ResearchPlanStep[];
}

export interface ResearchDefinitionContent {
  readonly title: string;
  readonly question: string;
  readonly outputKind: ResearchOutputKind;
  readonly sourceIds: readonly string[];
  readonly libraryIds: readonly string[];
  readonly chatModel: string;
  readonly columns: readonly ResearchColumnDeclaration[];
  readonly plan: ResearchPlan;
}

export type ResearchTypedValue = string | number | boolean | null;

export interface ResearchLooseDefinitionInput {
  readonly title?: unknown;
  readonly question?: unknown;
  readonly output_kind?: unknown;
  readonly source_ids?: unknown;
  readonly library_ids?: unknown;
  readonly chat_model?: unknown;
  readonly columns?: unknown;
  readonly plan?: unknown;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalid(message: string): never {
  throw new ResearchValidationError(message);
}

function uuidList(value: unknown, field: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(`${field} must be an array of at most ${maximum} ids`);
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !UUID_PATTERN.test(entry)) {
      invalid(`${field} holds a malformed id`);
    }
    const id = entry.toLowerCase();
    if (seen.has(id)) invalid(`${field} must not contain duplicate ids`);
    seen.add(id);
    ids.push(id);
  }
  return Object.freeze(ids);
}

function boundedText(value: unknown, field: string, maximum: number, required: boolean): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > maximum ||
    (required && (!value || !value.trim()))
  ) {
    invalid(`${field} violates the research contract`);
  }
  return value;
}

function optionalBoundedText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, field, maximum, true);
}

export function researchUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(`${field} must be a UUID`);
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Column declarations
// ---------------------------------------------------------------------------

/**
 * Normalizes one column declaration. Enum columns require 1–20 unique exact
 * choices; non-enum columns must not carry choices. Ids are stable across
 * revisions by contract (the user keeps them when editing) and unique within
 * one revision.
 */
export function normalizeResearchColumnDeclaration(value: unknown): ResearchColumnDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("column declaration must be an object");
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !(RESEARCH_COLUMN_TYPES as readonly string[]).includes(type)) {
    invalid("column type is unsupported");
  }
  const choices =
    record.choices === undefined || record.choices === null
      ? null
      : (() => {
          if (!Array.isArray(record.choices) || record.choices.length > RESEARCH_ENUM_CHOICES_MAX) {
            invalid(`enum columns allow at most ${RESEARCH_ENUM_CHOICES_MAX} choices`);
          }
          const seen = new Set<string>();
          const normalized = record.choices.map((choice) => {
            const text = boundedText(choice, "enum choice", RESEARCH_ENUM_CHOICE_MAX_CHARS, true);
            if (seen.has(text)) invalid("enum choices must be unique");
            seen.add(text);
            return text;
          });
          if (!normalized.length) invalid("enum columns require at least one choice");
          return Object.freeze(normalized);
        })();
  if (type === "enum" && choices === null) invalid("enum columns require explicit choices");
  if (type !== "enum" && choices !== null) invalid("only enum columns may carry choices");
  return Object.freeze({
    id: researchUuid(record.id, "column id"),
    label: boundedText(record.label, "column label", RESEARCH_COLUMN_LABEL_MAX_CHARS, true),
    question: boundedText(record.question, "column question", RESEARCH_COLUMN_QUESTION_MAX_CHARS, true),
    type: type as ResearchColumnType,
    unit: optionalBoundedText(record.unit, "column unit", RESEARCH_COLUMN_UNIT_MAX_CHARS),
    choices,
  });
}

export function normalizeResearchColumns(value: unknown): readonly ResearchColumnDeclaration[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > RESEARCH_COLUMN_MAX_COUNT) {
    invalid(`at most ${RESEARCH_COLUMN_MAX_COUNT} columns are allowed`);
  }
  const columns = value.map(normalizeResearchColumnDeclaration);
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.id)) invalid("column ids must be unique");
    seen.add(column.id);
  }
  return Object.freeze(columns);
}

// ---------------------------------------------------------------------------
// Plan proposals
// ---------------------------------------------------------------------------

/**
 * A plan proposal is user-editable structure only: ordered steps (≤8), each
 * with a user-facing objective and 1–8 search questions. Total questions are
 * capped at the whole-run search budget so a plan can never promise work the
 * run cannot perform. Serialized form is bounded so it fits the durable CHECK.
 */
export function normalizeResearchPlan(value: unknown): ResearchPlan {
  if (value === undefined || value === null) return Object.freeze({ steps: Object.freeze([]) });
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("plan must be an object");
  const stepsValue = (value as Record<string, unknown>).steps;
  if (!Array.isArray(stepsValue) || stepsValue.length > RESEARCH_STEPS_MAX) {
    invalid(`a plan holds at most ${RESEARCH_STEPS_MAX} steps`);
  }
  const seenStepIds = new Set<string>();
  let totalQuestions = 0;
  const steps: ResearchPlanStep[] = stepsValue.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("plan step must be an object");
    const record = entry as Record<string, unknown>;
    const questionsValue = record.questions;
    if (
      !Array.isArray(questionsValue) ||
      questionsValue.length < 1 ||
      questionsValue.length > RESEARCH_QUESTIONS_PER_STEP_MAX
    ) {
      invalid(`a plan step holds 1-${RESEARCH_QUESTIONS_PER_STEP_MAX} questions`);
    }
    const questions = questionsValue.map((question) =>
      boundedText(question, "plan question", RESEARCH_STEP_QUESTION_MAX_CHARS, true)
    );
    totalQuestions += questions.length;
    if (totalQuestions > RESEARCH_SEARCHES_MAX) {
      invalid(`a plan holds at most ${RESEARCH_SEARCHES_MAX} total search questions`);
    }
    const id = researchUuid(record.id, "plan step id");
    if (seenStepIds.has(id)) invalid("plan step ids must be unique");
    seenStepIds.add(id);
    return Object.freeze({
      id,
      objective: boundedText(record.objective, "plan step objective", RESEARCH_STEP_OBJECTIVE_MAX_CHARS, true),
      questions: Object.freeze(questions),
    });
  });
  const plan = Object.freeze({ steps: Object.freeze(steps) });
  if (JSON.stringify(plan).length > RESEARCH_PLAN_SERIALIZED_MAX_CHARS) {
    invalid("plan exceeds the serialized plan budget");
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Definition content
// ---------------------------------------------------------------------------

/**
 * Normalizes loose definition input into the frozen revision content.
 * Comparison output requires 1–20 column declarations; memo output must not
 * carry columns. An empty `source_ids` is a legal stored draft (Start rejects
 * it); a missing key is an error at create time because the scope must be an
 * explicit selected set.
 */
export function normalizeResearchDefinitionContent(input: unknown): ResearchDefinitionContent {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("definition must be an object");
  const record = input as Record<string, unknown>;
  const outputKind = record.output_kind;
  if (typeof outputKind !== "string" || !(RESEARCH_OUTPUT_KINDS as readonly string[]).includes(outputKind)) {
    invalid("output_kind must be memo or comparison");
  }
  const sourceIds =
    record.source_ids === undefined
      ? invalid("source_ids is required (an explicit empty array is legal)")
      : uuidList(record.source_ids, "source_ids", RESEARCH_SOURCE_MAX_COUNT);
  const libraryIds =
    record.library_ids === undefined || record.library_ids === null
      ? Object.freeze([] as string[])
      : uuidList(record.library_ids, "library_ids", RESEARCH_LIBRARY_PROVENANCE_MAX);
  const columns = normalizeResearchColumns(record.columns);
  if (outputKind === "comparison" && columns.length === 0) {
    invalid("comparison output requires at least one column declaration");
  }
  if (outputKind === "memo" && columns.length > 0) {
    invalid("only comparison output may carry column declarations");
  }
  return Object.freeze({
    title: boundedText(record.title, "title", RESEARCH_TITLE_MAX_CHARS, true),
    question: boundedText(record.question, "question", RESEARCH_QUESTION_MAX_CHARS, true),
    outputKind: outputKind as ResearchOutputKind,
    sourceIds,
    libraryIds,
    chatModel: boundedText(record.chat_model, "chat_model", RESEARCH_MODEL_MAX_CHARS, true),
    columns,
    plan: normalizeResearchPlan(record.plan),
  });
}

// ---------------------------------------------------------------------------
// Typed cell values — never coerced
// ---------------------------------------------------------------------------

/** True for real ISO calendar dates (`2026-02-30` and `2026-13-01` fail). */
export function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Validates a raw candidate value against one column declaration WITHOUT any
 * coercion: a numeric string is not a number, `true` is not text, an enum
 * value must be an exact allowed member, and numbers must be finite. Dates are
 * real ISO calendar dates. Text respects the 2,000-character cell bound.
 */
export function validateResearchTypedValue(
  column: ResearchColumnDeclaration,
  raw: unknown
): { readonly ok: true; readonly value: ResearchTypedValue } | { readonly ok: false } {
  switch (column.type) {
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false };
    case "date":
      return typeof raw === "string" && isIsoCalendarDate(raw) ? { ok: true, value: raw } : { ok: false };
    case "boolean":
      return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false };
    case "enum":
      return typeof raw === "string" && (column.choices ?? []).includes(raw) ? { ok: true, value: raw } : { ok: false };
    case "text":
      return typeof raw === "string" && raw.length <= RESEARCH_EVIDENCE_EXCERPT_MAX_CHARS
        ? { ok: true, value: raw }
        : { ok: false };
  }
}

/** True when `raw` may be stored at all (JSON scalar, never an object/array). */
export function isResearchJsonValueScalar(raw: unknown): raw is ResearchTypedValue {
  return raw === null || typeof raw === "string" || typeof raw === "boolean" || typeof raw === "number";
}

export interface ClassifiedResearchCell {
  readonly status: ResearchCellStatus;
  readonly value: ResearchTypedValue;
}

/**
 * Maps a raw machine extraction to the stored cell status. An unvalidatable
 * scalar becomes `invalid` with the original output preserved verbatim — never
 * a string-coerced fact. Absence is `not_found` with a null value.
 */
export function classifyResearchCellPayload(column: ResearchColumnDeclaration, raw: unknown): ClassifiedResearchCell {
  if (raw === undefined || raw === null) return Object.freeze({ status: "not_found", value: null });
  if (!isResearchJsonValueScalar(raw)) invalid("cell values must be JSON scalars");
  const validated = validateResearchTypedValue(column, raw);
  if (validated.ok) return Object.freeze({ status: "supported", value: validated.value });
  if (typeof raw === "number" && !Number.isFinite(raw)) invalid("cell values must be JSON scalars");
  // Preserve the original machine output under `invalid` (provenance first).
  return Object.freeze({ status: "invalid", value: raw as ResearchTypedValue });
}

/** Validates a status/value pair the caller asserts (machine or correction). */
export function validateResearchCellPayload(
  column: ResearchColumnDeclaration,
  status: unknown,
  raw: unknown
): ClassifiedResearchCell {
  if (typeof status !== "string" || !(RESEARCH_CELL_STATUSES as readonly string[]).includes(status)) {
    invalid("cell status is unsupported");
  }
  if (raw !== undefined && raw !== null && !isResearchJsonValueScalar(raw)) {
    invalid("cell values must be JSON scalars");
  }
  const value = (raw ?? null) as ResearchTypedValue;
  switch (status as ResearchCellStatus) {
    case "not_found":
      if (value !== null) invalid("not_found cells must carry a null value");
      return Object.freeze({ status: "not_found" as const, value: null });
    case "supported": {
      if (value === null) invalid("supported cells require a non-null value");
      const validated = validateResearchTypedValue(column, value);
      if (!validated.ok) invalid("supported cell value does not match the column type");
      return Object.freeze({ status: "supported" as const, value: validated.value });
    }
    case "conflicting":
      if (value !== null) {
        const validated = validateResearchTypedValue(column, value);
        if (!validated.ok) invalid("conflicting cell value does not match the column type");
        return Object.freeze({ status: "conflicting" as const, value: validated.value });
      }
      return Object.freeze({ status: "conflicting" as const, value: null });
    case "invalid":
      if (value === null) invalid("invalid cells must preserve the original machine output");
      return Object.freeze({ status: "invalid" as const, value });
  }
}

// ---------------------------------------------------------------------------
// Comparison-table serialization cap (1 MiB, explicit limit state)
// ---------------------------------------------------------------------------

export interface ResearchTableRowView {
  readonly row_source_id: string;
  readonly row_generation: number;
  readonly cells: Readonly<Record<string, unknown>>;
}

/** Canonical deterministic serialization for one page/full table view. */
export function serializeResearchTableRows(rows: readonly ResearchTableRowView[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      row_source_id: row.row_source_id,
      row_generation: row.row_generation,
      cells: row.cells,
    }))
  );
}

/** UTF-8 byte length of the canonical serialization (the capped quantity). */
export function researchTableSerializedByteLength(rows: readonly ResearchTableRowView[]): number {
  return Buffer.byteLength(serializeResearchTableRows(rows), "utf8");
}

export interface ResearchTableLimitState {
  readonly serialized_bytes: number;
  readonly limit_bytes: number;
  readonly at_limit: boolean;
}

/** The explicit limit state carried by every table read response. */
export function researchTableLimitState(serializedBytes: number): ResearchTableLimitState {
  return Object.freeze({
    serialized_bytes: serializedBytes,
    limit_bytes: RESEARCH_TABLE_SERIALIZED_MAX_BYTES,
    at_limit: serializedBytes >= RESEARCH_TABLE_SERIALIZED_MAX_BYTES,
  });
}

// ---------------------------------------------------------------------------
// Review operations
// ---------------------------------------------------------------------------

export type ResearchReviewOp =
  | { readonly op: "accept_claim"; readonly claim_id: string }
  | { readonly op: "reject_claim"; readonly claim_id: string }
  | {
      readonly op: "add_note";
      readonly target_kind: "claim" | "evidence" | "run";
      readonly target_id?: string;
      readonly note: string;
    }
  | { readonly op: "correct_claim"; readonly claim_id: string; readonly text: string }
  | {
      readonly op: "correct_cell";
      readonly column_id: string;
      readonly row_source_id: string;
      readonly value?: ResearchTypedValue;
      readonly status?: ResearchCellStatus;
      readonly explanation?: string;
    }
  | { readonly op: "flag_evidence"; readonly evidence_id: string; readonly irrelevant: boolean };

/**
 * Normalizes and bounds a review operation batch (≤100 ops, stable target
 * ids, bounded note text). Notes stay review content — nothing here can
 * produce an evidence row.
 */
export function normalizeResearchReviewOps(value: unknown): readonly ResearchReviewOp[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > RESEARCH_REVIEW_OPS_MAX) {
    invalid(`a review request holds 1-${RESEARCH_REVIEW_OPS_MAX} operations`);
  }
  return Object.freeze(
    value.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("review operation must be an object");
      const record = entry as Record<string, unknown>;
      const op = record.op;
      switch (op) {
        case "accept_claim":
        case "reject_claim":
          return Object.freeze({ op, claim_id: researchUuid(record.claim_id, "claim id") });
        case "add_note": {
          const targetKind = record.target_kind;
          if (targetKind !== "claim" && targetKind !== "evidence" && targetKind !== "run") {
            invalid("note target_kind must be claim, evidence, or run");
          }
          const note = boundedText(record.note, "note", RESEARCH_NOTE_MAX_CHARS, true);
          if (targetKind === "run") {
            if (record.target_id !== undefined) invalid("run notes must not carry a target_id");
            return Object.freeze({ op: "add_note", target_kind: "run", note });
          }
          return Object.freeze({
            op: "add_note",
            target_kind: targetKind,
            target_id: researchUuid(record.target_id, "note target id"),
            note,
          });
        }
        case "correct_claim":
          return Object.freeze({
            op: "correct_claim",
            claim_id: researchUuid(record.claim_id, "claim id"),
            text: boundedText(record.text, "corrected text", RESEARCH_CLAIM_TEXT_MAX_CHARS, true),
          });
        case "correct_cell": {
          if (record.status === undefined && record.value === undefined) {
            invalid("a cell correction must change the value or the status");
          }
          const corrected: Record<string, unknown> = {
            op: "correct_cell",
            column_id: researchUuid(record.column_id, "column id"),
            row_source_id: researchUuid(record.row_source_id, "row source id"),
          };
          if (record.value !== undefined) {
            if (!isResearchJsonValueScalar(record.value)) invalid("cell correction values must be JSON scalars");
            corrected.value = record.value ?? null;
          }
          if (record.status !== undefined) {
            if (
              typeof record.status !== "string" ||
              !(RESEARCH_CELL_STATUSES as readonly string[]).includes(record.status)
            ) {
              invalid("cell correction status is unsupported");
            }
            corrected.status = record.status;
          }
          if (record.explanation !== undefined) {
            corrected.explanation = boundedText(
              record.explanation,
              "cell correction explanation",
              RESEARCH_CELL_EXPLANATION_MAX_CHARS,
              true
            );
          }
          return Object.freeze(corrected) as ResearchReviewOp;
        }
        case "flag_evidence": {
          if (typeof record.irrelevant !== "boolean") invalid("flag_evidence requires a boolean irrelevant flag");
          return Object.freeze({
            op: "flag_evidence",
            evidence_id: researchUuid(record.evidence_id, "evidence id"),
            irrelevant: record.irrelevant,
          });
        }
        default:
          return invalid("review operation is unsupported");
      }
    })
  );
}
