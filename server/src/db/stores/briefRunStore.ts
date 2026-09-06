import { createHash, randomUUID } from "node:crypto";
import {
  CatalogCursorError,
  catalogStorePage,
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../../catalogPagination.js";
import { decodeJson, decodeSafeInteger, encodeJson } from "../../db/codecs.js";
import { SqliteConstraintError, type SqliteLedger, type SqliteTransaction } from "../../db/types.js";
import { dueOccurrenceWindow, normalizeCalendarSchedule, type CalendarSchedule } from "../../calendarSchedule.js";
import {
  BRIEF_RECIPE_MAX_FAILURES_BEFORE_PAUSE,
  briefParameterHash,
  briefSourceSetHash,
  BriefRecipeNotFoundError,
  decodeBriefParameterBindings,
  decodeRefreshBindings,
  decodeStringArray,
  uuidIdentity,
  type BriefRecipeContent,
} from "./briefRecipeStore.js";
import type { AnalysisParameterBinding } from "../../analysisTypes.js";

export const BRIEF_CLAIM_BATCH_LIMIT = 20;
export const BRIEF_REFRESH_STAGE_DEADLINE_MS = 15 * 60_000;
export const BRIEF_REVIEW_DEADLINE_MS = 30 * 60_000;
export const BRIEF_FAILURE_REASON_MAX = 500;
export const BRIEF_NOTIFICATION_DETAIL_MAX = 500;

export type BriefRunStage =
  | "queued"
  | "refreshing"
  | "waiting_ready"
  | "analyzing"
  | "drafting"
  | "awaiting_review"
  | "publishing"
  | "failed"
  | "cancelled"
  | "skipped"
  | "approved"
  | "rejected";

/** Stages that occupy the recipe's single active execution slot. */
export const BRIEF_ACTIVE_STAGES: readonly BriefRunStage[] = Object.freeze([
  "queued",
  "refreshing",
  "waiting_ready",
  "analyzing",
  "drafting",
  "publishing",
] as const);

/**
 * Awaiting human review is terminal for execution scheduling: it never blocks
 * later occurrences and never counts as active.
 */
export const BRIEF_SCHEDULING_TERMINAL_STAGES: readonly BriefRunStage[] = Object.freeze([
  "failed",
  "cancelled",
  "skipped",
  "approved",
  "rejected",
  "awaiting_review",
] as const);

export const BRIEF_NOTIFICATION_KINDS = ["first_draft", "meaningful_change", "attention", "paused"] as const;
export type BriefNotificationKind = (typeof BRIEF_NOTIFICATION_KINDS)[number];
export type BriefNotificationState = "unread" | "read" | "dismissed";

/** Review-inbox and notification pages (M16 bounds: default 20, maximum 50). */
export const BRIEF_PAGE_DEFAULT_LIMIT = 20;
export const BRIEF_PAGE_MAX_LIMIT = 50;

export const BRIEF_REVIEW_DECISIONS = ["approve", "reject"] as const;
export type BriefReviewDecision = (typeof BRIEF_REVIEW_DECISIONS)[number];
export const BRIEF_REVIEW_NOTE_MAX = 1_000;
export const BRIEF_PUBLICATION_ERROR_CODE_MAX = 64;

/** Stages that appear in the review inbox: pending, publishing, and decided. */
export const BRIEF_REVIEW_INBOX_STAGES: readonly BriefRunStage[] = Object.freeze([
  "awaiting_review",
  "publishing",
  "approved",
  "rejected",
] as const);

/**
 * The decision was accepted against a draft revision that is no longer the
 * head (or the draft vanished): the client must refresh and review the
 * current revision. Never approves unseen content.
 */
export class BriefReviewRevisionConflictError extends Error {
  readonly code = "BRIEF_REVIEW_REVISION_CONFLICT";
  readonly statusCode = 409;

  constructor(
    message = "the brief draft changed since this review; decide again on the current revision",
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "BriefReviewRevisionConflictError";
  }
}

/**
 * Consent/migration/busy prerequisites surface as `skipped` or `blocked`
 * visibility states — never execution failures. Only `failed` feeds the
 * five-consecutive-failures pause; reaching `awaiting_review` counts as
 * execution success, and a rejected draft is never a failure.
 */
export type BriefExecutionOutcome = "succeeded" | "failed" | "skipped" | "blocked";

export interface StoredBriefRun {
  readonly id: string;
  readonly accountId: string;
  readonly recipeId: string;
  readonly trigger: "scheduled" | "manual";
  readonly operationId: string | null;
  readonly occurrenceKey: string;
  readonly recipeRevision: number;
  readonly recipeSnapshot: BriefRecipeContent & { readonly recipe_id: string; readonly revision: number };
  readonly stage: BriefRunStage;
  readonly stageOperationId: string | null;
  readonly stageAttempts: number;
  readonly cancelRequested: boolean;
  readonly deadlineAt: string;
  readonly refreshDeadlineAt: string | null;
  readonly refreshReceipts: readonly unknown[];
  readonly sourceSnapshot: readonly unknown[] | null;
  readonly analysisId: string | null;
  readonly analysisRevision: number | null;
  readonly parameterHash: string | null;
  readonly sourceSetHash: string | null;
  readonly analysisRunId: string | null;
  readonly baselineRunId: string | null;
  readonly analysisSucceeded: boolean;
  readonly comparisonSummary: unknown;
  readonly documentId: string | null;
  readonly documentRevisionId: string | null;
  readonly publicationOperationId: string | null;
  readonly reviewedRevisionId: string | null;
  /** Bounded code of the last failed publication render (schema v28). */
  readonly publicationErrorCode: string | null;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  readonly coalescedCount: number;
  readonly missedThroughKey: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly stageUpdatedAt: string;
  readonly finishedAt: string | null;
}

export class BriefRunNotFoundError extends Error {
  readonly code = "BRIEF_RUN_NOT_FOUND";
  readonly statusCode = 404;

  constructor(options: ErrorOptions = {}) {
    super("brief run not found", options);
    this.name = "BriefRunNotFoundError";
  }
}

export class BriefRunStateError extends Error {
  readonly code = "BRIEF_RUN_STATE";
  readonly statusCode = 409;

  constructor(message = "brief run is not in a state that accepts this transition", options: ErrorOptions = {}) {
    super(message, options);
    this.name = "BriefRunStateError";
  }
}

export class BriefActiveRunError extends Error {
  readonly code = "BRIEF_ACTIVE_RUN";
  readonly statusCode = 409;

  constructor(options: ErrorOptions = {}) {
    super("this brief recipe already has an active run", options);
    this.name = "BriefActiveRunError";
  }
}

// ---------------------------------------------------------------------------
// Row decoding
// ---------------------------------------------------------------------------

interface RunRow {
  [column: string]: unknown;
}

interface RecipeDueRow {
  [column: string]: unknown;
}

function optionalText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function decodeSnapshot(value: unknown): BriefRecipeContent & { recipe_id: string; revision: number } {
  const parsed = decodeJson<Record<string, unknown>>(value, "recipe snapshot");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BriefRunStateError("recipe snapshot is malformed", { cause: new Error("snapshot decode failed") });
  }
  return Object.freeze({
    recipe_id: String(parsed.recipe_id),
    revision: decodeSafeInteger(parsed.revision, "snapshot revision"),
    name: String(parsed.name),
    analysis_id: String(parsed.analysis_id),
    analysis_revision: decodeSafeInteger(parsed.analysis_revision, "snapshot analysis revision"),
    parameter_values: decodeBriefParameterBindings(parsed.parameter_values, "snapshot parameter values"),
    report_title: String(parsed.report_title),
    report_instruction: String(parsed.report_instruction),
    source_ids: decodeStringArray(parsed.source_ids, "snapshot source ids"),
    refresh_bindings: decodeRefreshBindings(parsed.refresh_bindings, "snapshot refresh bindings"),
    schedule: normalizeCalendarSchedule(parsed.schedule),
  });
}

function scheduleFromRow(row: RecipeDueRow): CalendarSchedule {
  return normalizeCalendarSchedule({
    kind: row.schedule_kind,
    weekday: row.weekday == null ? undefined : decodeSafeInteger(row.weekday, "weekday"),
    day_of_month: row.day_of_month == null ? undefined : decodeSafeInteger(row.day_of_month, "day_of_month"),
    hour: decodeSafeInteger(row.hour, "hour"),
    minute: decodeSafeInteger(row.minute, "minute"),
    time_zone: String(row.time_zone),
  });
}

function snapshotFromRows(head: RecipeDueRow, revision: RunRow): string {
  return encodeJson(
    {
      recipe_id: String(head.id),
      revision: decodeSafeInteger(head.revision, "recipe revision"),
      name: String(revision.name),
      analysis_id: String(revision.analysis_id),
      analysis_revision: decodeSafeInteger(revision.analysis_revision, "analysis revision"),
      parameter_values: decodeJson(revision.parameter_values, "revision parameter values"),
      report_title: String(revision.report_title),
      report_instruction: String(revision.report_instruction),
      source_ids: decodeJson(revision.source_ids, "revision source ids"),
      refresh_bindings: decodeJson(revision.refresh_bindings, "revision refresh bindings"),
      schedule: {
        kind: String(revision.schedule_kind),
        weekday: revision.weekday == null ? null : decodeSafeInteger(revision.weekday, "weekday"),
        day_of_month: revision.day_of_month == null ? null : decodeSafeInteger(revision.day_of_month, "day_of_month"),
        hour: decodeSafeInteger(revision.hour, "hour"),
        minute: decodeSafeInteger(revision.minute, "minute"),
        time_zone: String(revision.time_zone),
      },
    },
    "recipe snapshot"
  );
}

export function decodeBriefRun(row: RunRow): StoredBriefRun {
  return Object.freeze({
    id: String(row.id),
    accountId: String(row.account_id),
    recipeId: String(row.recipe_id),
    trigger: row.trigger === "manual" ? "manual" : "scheduled",
    operationId: optionalText(row.operation_id),
    occurrenceKey: String(row.occurrence_key),
    recipeRevision: decodeSafeInteger(row.recipe_revision, "recipe revision"),
    recipeSnapshot: decodeSnapshot(row.recipe_snapshot),
    stage: String(row.stage) as BriefRunStage,
    stageOperationId: optionalText(row.stage_operation_id),
    stageAttempts: decodeSafeInteger(row.stage_attempts ?? 0, "stage attempts"),
    cancelRequested: decodeSafeInteger(row.cancel_requested ?? 0, "cancel requested") === 1,
    deadlineAt: String(row.deadline_at),
    refreshDeadlineAt: optionalText(row.refresh_deadline_at),
    refreshReceipts: decodeJson<readonly unknown[]>(row.refresh_receipts ?? "[]", "refresh receipts"),
    sourceSnapshot:
      row.source_snapshot == null ? null : decodeJson<readonly unknown[]>(row.source_snapshot, "source snapshot"),
    analysisId: optionalText(row.analysis_id),
    analysisRevision:
      row.analysis_revision == null ? null : decodeSafeInteger(row.analysis_revision, "analysis revision"),
    parameterHash: optionalText(row.parameter_hash),
    sourceSetHash: optionalText(row.source_set_hash),
    analysisRunId: optionalText(row.analysis_run_id),
    baselineRunId: optionalText(row.baseline_run_id),
    analysisSucceeded: decodeSafeInteger(row.analysis_succeeded ?? 0, "analysis succeeded") === 1,
    comparisonSummary: row.comparison_summary == null ? null : decodeJson(row.comparison_summary, "comparison summary"),
    documentId: optionalText(row.document_id),
    documentRevisionId: optionalText(row.document_revision_id),
    publicationOperationId: optionalText(row.publication_operation_id),
    reviewedRevisionId: optionalText(row.reviewed_revision_id),
    publicationErrorCode: optionalText(row.publication_error_code),
    failureCode: optionalText(row.failure_code),
    failureReason: optionalText(row.failure_reason),
    coalescedCount: decodeSafeInteger(row.coalesced_count ?? 1, "coalesced count"),
    missedThroughKey: optionalText(row.missed_through_key),
    createdAt: String(row.created_at),
    startedAt: optionalText(row.started_at),
    stageUpdatedAt: String(row.stage_updated_at),
    finishedAt: optionalText(row.finished_at),
  });
}

const RUN_COLUMNS = `id,account_id,recipe_id,trigger,operation_id,occurrence_key,recipe_revision,recipe_snapshot,
  stage,stage_operation_id,stage_attempts,cancel_requested,deadline_at,refresh_deadline_at,refresh_receipts,
  source_snapshot,analysis_id,analysis_revision,parameter_hash,source_set_hash,analysis_run_id,baseline_run_id,
  analysis_succeeded,comparison_summary,document_id,document_revision_id,publication_operation_id,
  reviewed_revision_id,publication_error_code,failure_code,failure_reason,coalesced_count,missed_through_key,
  created_at,started_at,stage_updated_at,finished_at`;

const RUN_COLUMNS_R = (RUN_COLUMNS.match(/[a-z_]+/g) ?? []).map((column) => `r.${column}`).join(",");

function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(",");
}

/**
 * UUIDv4-shaped deterministic publication operation id per
 * (run, reviewed revision). An approval retry reconciles the same durable
 * publication intent; the only way to a new operation UUID is a new decision
 * on a different revision.
 */
export function deriveBriefPublicationOperationId(runId: string, revisionId: string): string {
  const hex = createHash("sha256").update(`borealis-brief-publication:${runId}:${revisionId}`, "utf8").digest("hex");
  const digits = (start: number, length: number) => hex.slice(start, start + length);
  return `${digits(0, 8)}-${digits(8, 4)}-4${digits(13, 3)}-a${digits(17, 3)}-${digits(20, 12)}`.toLowerCase();
}

/** Review/notification pages are bounded tighter than generic catalogs. */
export function validateBriefPageRequest(value: CatalogPageRequest): CatalogPageRequest {
  const validated = validateCatalogPageRequest(value);
  if (validated.limit > BRIEF_PAGE_MAX_LIMIT) throw new CatalogCursorError();
  return validated;
}

interface ReviewRow {
  [column: string]: unknown;
}

interface NotificationRow {
  [column: string]: unknown;
}

export interface StoredBriefReviewEvent {
  readonly decision: BriefReviewDecision;
  readonly note: string | null;
  readonly documentRevisionId: string;
  readonly createdAt: string;
}

export interface StoredBriefReviewRow {
  readonly run: StoredBriefRun;
  /** Live draft head at read time; null when the draft row is gone. */
  readonly headRevisionId: string | null;
  readonly headRevision: number | null;
  /** Retained-recipe visibility: 'active' | 'paused' | null (deleted). */
  readonly recipeState: string | null;
  readonly recipePausedReason: string | null;
  /** Latest decision from the immutable ledger; null while pending. */
  readonly lastEvent: StoredBriefReviewEvent | null;
}

export interface StoredBriefNotification {
  readonly id: string;
  readonly accountId: string;
  readonly recipeId: string;
  readonly runId: string;
  readonly kind: BriefNotificationKind;
  readonly state: BriefNotificationState;
  readonly detail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readAt: string | null;
}

function decodeReviewRow(row: ReviewRow): StoredBriefReviewRow {
  return Object.freeze({
    run: decodeBriefRun(row),
    headRevisionId: optionalText(row.head_revision_id),
    headRevision: row.head_revision == null ? null : decodeSafeInteger(row.head_revision, "head revision"),
    recipeState: optionalText(row.recipe_state),
    recipePausedReason: optionalText(row.recipe_paused_reason),
    lastEvent:
      row.last_decision == null
        ? null
        : Object.freeze({
            decision: String(row.last_decision) as BriefReviewDecision,
            note: optionalText(row.last_note),
            documentRevisionId: String(row.last_decision_revision_id),
            createdAt: String(row.last_decision_at),
          }),
  });
}

function decodeNotification(row: NotificationRow): StoredBriefNotification {
  return Object.freeze({
    id: String(row.id),
    accountId: String(row.account_id),
    recipeId: String(row.recipe_id),
    runId: String(row.run_id),
    kind: String(row.kind) as BriefNotificationKind,
    state: String(row.state) as BriefNotificationState,
    detail: optionalText(row.detail),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    readAt: optionalText(row.read_at),
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class BriefRunStore {
  constructor(
    private readonly ledger: SqliteLedger,
    private readonly options: { readonly now?: () => Date } = {}
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private activeGuard(transaction: SqliteTransaction, recipeId: string): void {
    const active = transaction.get(
      `SELECT 1 FROM brief_runs WHERE recipe_id=? AND stage IN (${placeholders(BRIEF_ACTIVE_STAGES.length)}) LIMIT 1`,
      [recipeId, ...BRIEF_ACTIVE_STAGES]
    );
    if (active) throw new BriefActiveRunError();
  }

  // -- Claim -----------------------------------------------------------------

  /**
   * Atomically claims due scheduled occurrences and advances each recipe's
   * civil cursor in one short transaction (no I/O is ever held across it).
   * Coalescing rules from the M16 contract:
   * - Missed occurrences collapse into ONE catch-up run keyed by the first
   *   missed civil occurrence; the cursor jumps to the next future occurrence,
   *   so a restart cannot double-run the same window.
   * - While a run is active (non-terminal, not awaiting review), due
   *   occurrences are left for a single later catch-up claim — at most one
   *   pending catch-up exists at any time.
   * - The UNIQUE (recipe, occurrence key) index is the duplicate-claim guard:
   *   a repeated autumn civil key already exists and inserts nothing.
   */
  async claimDueRuns(): Promise<readonly StoredBriefRun[]> {
    const now = this.now();
    const nowMs = now.getTime();
    return this.ledger.withImmediateTransaction((transaction) => {
      const recipes = transaction.all<RecipeDueRow>(
        `SELECT * FROM brief_recipes
         WHERE state='active' AND next_run_at<=? ORDER BY next_run_at,id LIMIT ?`,
        [now.toISOString(), BRIEF_CLAIM_BATCH_LIMIT]
      );
      const claimed: StoredBriefRun[] = [];
      for (const recipe of recipes) {
        const recipeId = String(recipe.id);
        const accountId = String(recipe.account_id);
        const active = transaction.get(
          `SELECT 1 FROM brief_runs WHERE recipe_id=? AND stage IN (${placeholders(BRIEF_ACTIVE_STAGES.length)}) LIMIT 1`,
          [recipeId, ...BRIEF_ACTIVE_STAGES]
        );
        if (active) continue;
        let schedule: CalendarSchedule;
        let window: ReturnType<typeof dueOccurrenceWindow>;
        try {
          schedule = scheduleFromRow(recipe);
          window = dueOccurrenceWindow(schedule, String(recipe.next_occurrence_key), nowMs);
        } catch {
          // A corrupt schedule/cursor pauses the recipe visibly instead of
          // spinning the claim loop.
          transaction.run(
            `UPDATE brief_recipes SET state='paused',paused_reason='the recipe schedule state is inconsistent',updated_at=?
             WHERE id=? AND account_id=?`,
            [now.toISOString(), recipeId, accountId]
          );
          continue;
        }
        if (window.due.length === 0) {
          // Cursor drift (e.g. a schedule edit recomputed the cursor): advance
          // without producing a run.
          transaction.run("UPDATE brief_recipes SET next_run_at=?,next_occurrence_key=?,updated_at=? WHERE id=?", [
            window.next.utc_at,
            window.next.occurrence_key,
            now.toISOString(),
            recipeId,
          ]);
          continue;
        }
        const revision = transaction.get<RunRow>(
          "SELECT * FROM brief_recipe_revisions WHERE recipe_id=? AND revision=? AND account_id=?",
          [recipeId, decodeSafeInteger(recipe.revision, "recipe revision"), accountId]
        );
        if (!revision) {
          transaction.run(
            `UPDATE brief_recipes SET state='paused',paused_reason='the recipe revision snapshot is missing',updated_at=?
             WHERE id=? AND account_id=?`,
            [now.toISOString(), recipeId, accountId]
          );
          continue;
        }
        const runId = randomUUID();
        const timestamp = now.toISOString();
        const deadline = new Date(nowMs + BRIEF_REVIEW_DEADLINE_MS).toISOString();
        const snapshot = snapshotFromRows(recipe, revision);
        const bindings = decodeBriefParameterBindings(revision.parameter_values, "revision parameter values");
        const sourceIds = decodeStringArray(revision.source_ids, "revision source ids");
        const insert = transaction.run(
          `INSERT INTO brief_runs (
             id,account_id,recipe_id,trigger,occurrence_key,recipe_revision,recipe_snapshot,
             stage,deadline_at,analysis_id,analysis_revision,parameter_hash,source_set_hash,
             coalesced_count,missed_through_key,created_at,stage_updated_at)
           VALUES (?,?,?,'scheduled',?,?,?,'queued',?,?,?,?,?,?,?,?,?)`,
          [
            runId,
            accountId,
            recipeId,
            window.due[0].occurrence_key,
            decodeSafeInteger(recipe.revision, "recipe revision"),
            snapshot,
            deadline,
            String(revision.analysis_id),
            decodeSafeInteger(revision.analysis_revision, "analysis revision"),
            briefParameterHash(bindings),
            briefSourceSetHash(sourceIds),
            window.due.length,
            window.due[window.due.length - 1].occurrence_key,
            timestamp,
            timestamp,
          ]
        );
        if (insert.changes !== 1) continue;
        transaction.run(
          "UPDATE brief_recipes SET next_run_at=?,next_occurrence_key=?,last_run_at=?,updated_at=? WHERE id=?",
          [window.next.utc_at, window.next.occurrence_key, timestamp, timestamp, recipeId]
        );
        const stored = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM brief_runs WHERE id=?`, [runId]);
        if (stored) claimed.push(decodeBriefRun(stored));
      }
      return claimed;
    });
  }

  /**
   * Manual "Run now": the same pipeline and stage machine as a scheduled
   * claim, keyed `manual:<operation UUID>` so a retried request replays the
   * original durable run instead of double-claiming. Returns 202 semantics —
   * the row stays `queued` for the (stage-2) runner.
   */
  async createManualRun(
    accountIdValue: string,
    recipeIdValue: string,
    operationIdValue: string
  ): Promise<{
    readonly run: StoredBriefRun;
    readonly replayed: boolean;
  }> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const recipeId = uuidIdentity(recipeIdValue, "recipe id");
    const operationId = uuidIdentity(operationIdValue, "operation id");
    const now = this.now();
    const timestamp = now.toISOString();
    return this.ledger.withImmediateTransaction((transaction) => {
      const head = transaction.get<RecipeDueRow>("SELECT * FROM brief_recipes WHERE id=? AND account_id=?", [
        recipeId,
        accountId,
      ]);
      if (!head) throw new BriefRecipeNotFoundError();
      const replay = transaction.get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM brief_runs WHERE recipe_id=? AND operation_id=?`,
        [recipeId, operationId]
      );
      if (replay) return Object.freeze({ run: decodeBriefRun(replay), replayed: true });
      this.activeGuard(transaction, recipeId);
      const revision = transaction.get<RunRow>(
        "SELECT * FROM brief_recipe_revisions WHERE recipe_id=? AND revision=? AND account_id=?",
        [recipeId, decodeSafeInteger(head.revision, "recipe revision"), accountId]
      );
      if (!revision) throw new BriefRecipeNotFoundError({ cause: new Error("recipe revision snapshot is missing") });
      const runId = randomUUID();
      const bindings = decodeBriefParameterBindings(revision.parameter_values, "revision parameter values");
      const sourceIds = decodeStringArray(revision.source_ids, "revision source ids");
      try {
        transaction.run(
          `INSERT INTO brief_runs (
             id,account_id,recipe_id,trigger,operation_id,occurrence_key,recipe_revision,recipe_snapshot,
             stage,deadline_at,analysis_id,analysis_revision,parameter_hash,source_set_hash,
             coalesced_count,created_at,stage_updated_at)
           VALUES (?,?,?,'manual',?,?,?,?,'queued',?,?,?,?,?,1,?,?)`,
          [
            runId,
            accountId,
            recipeId,
            operationId,
            `manual:${operationId}`,
            decodeSafeInteger(head.revision, "recipe revision"),
            snapshotFromRows(head, revision),
            new Date(now.getTime() + BRIEF_REVIEW_DEADLINE_MS).toISOString(),
            String(revision.analysis_id),
            decodeSafeInteger(revision.analysis_revision, "analysis revision"),
            briefParameterHash(bindings),
            briefSourceSetHash(sourceIds),
            timestamp,
            timestamp,
          ]
        );
      } catch (error) {
        if (error instanceof SqliteConstraintError && error.kind === "unique") {
          // Lost a race with an equal operation id or a live active run:
          // replay the winner or surface the active-run conflict.
          const raced = transaction.get<RunRow>(
            `SELECT ${RUN_COLUMNS} FROM brief_runs WHERE recipe_id=? AND operation_id=?`,
            [recipeId, operationId]
          );
          if (raced) return Object.freeze({ run: decodeBriefRun(raced), replayed: true });
          throw new BriefActiveRunError({ cause: error });
        }
        throw error;
      }
      const stored = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM brief_runs WHERE id=?`, [runId]);
      if (!stored) throw new BriefRunStateError("manual run insert did not persist");
      return Object.freeze({ run: decodeBriefRun(stored), replayed: false });
    });
  }

  // -- Stage machine -----------------------------------------------------------

  /**
   * One short conditional stage transition. The write only lands when the run
   * still sits in `fromStage` (and, when supplied, carries the expected
   * current stage operation id), so a stale or replayed worker can never
   * advance a newer attempt. Entering `refreshing` persists the 15-minute
   * stage deadline exactly once; leaving `queued` stamps `started_at`. The
   * 30-minute total-to-review deadline never moves and review time is
   * excluded by construction (the deadline is checked only until
   * `awaiting_review`).
   */
  async beginStage(
    accountIdValue: string,
    runIdValue: string,
    input: {
      readonly fromStage: BriefRunStage;
      readonly toStage: BriefRunStage;
      readonly expectedStageOperationId?: string | null;
      readonly stageOperationId?: string | null;
    }
  ): Promise<StoredBriefRun> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    const timestamp = this.now().toISOString();
    const expectedOp = input.expectedStageOperationId ?? null;
    const cas = await this.ledger.run(
      `UPDATE brief_runs
       SET stage=?,stage_operation_id=?,stage_attempts=stage_attempts+1,
           started_at=CASE WHEN ?='queued' THEN COALESCE(started_at,?) ELSE started_at END,
           refresh_deadline_at=CASE
             WHEN ?='refreshing' AND refresh_deadline_at IS NULL THEN ?
             ELSE refresh_deadline_at END,
           stage_updated_at=?
       WHERE id=? AND account_id=? AND stage=?
         AND (? IS NULL OR stage_operation_id=?)`,
      [
        input.toStage,
        input.stageOperationId ?? null,
        input.fromStage,
        timestamp,
        input.toStage,
        new Date(Date.parse(timestamp) + BRIEF_REFRESH_STAGE_DEADLINE_MS).toISOString(),
        timestamp,
        runId,
        accountId,
        input.fromStage,
        expectedOp,
        expectedOp,
      ]
    );
    if (cas.changes !== 1) {
      const exists = await this.ledger.get("SELECT 1 FROM brief_runs WHERE id=? AND account_id=?", [runId, accountId]);
      if (!exists) throw new BriefRunNotFoundError();
      throw new BriefRunStateError();
    }
    return this.getRun(accountId, runId);
  }

  /** Terminal failure/cancellation/skip with the bounded content-free reason. */
  async finishRun(
    accountIdValue: string,
    runIdValue: string,
    input: {
      readonly fromStage: BriefRunStage;
      readonly outcome: "failed" | "cancelled" | "skipped";
      readonly expectedStageOperationId?: string | null;
      readonly failureCode?: string | null;
      readonly failureReason?: string | null;
    }
  ): Promise<StoredBriefRun> {
    const reason = input.failureReason == null ? null : input.failureReason.slice(0, BRIEF_FAILURE_REASON_MAX);
    if (input.outcome === "failed" && reason === null) {
      throw new BriefRunStateError("a failed brief run must record a bounded failure reason");
    }
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    const timestamp = this.now().toISOString();
    const expectedOp = input.expectedStageOperationId ?? null;
    const cas = await this.ledger.run(
      `UPDATE brief_runs
       SET stage=?,stage_operation_id=NULL,stage_attempts=stage_attempts+1,
           failure_code=?,failure_reason=?,finished_at=?,stage_updated_at=?
       WHERE id=? AND account_id=? AND stage=?
         AND (? IS NULL OR stage_operation_id=?)`,
      [
        input.outcome,
        input.failureCode ?? null,
        reason,
        timestamp,
        timestamp,
        runId,
        accountId,
        input.fromStage,
        expectedOp,
        expectedOp,
      ]
    );
    if (cas.changes !== 1) {
      const exists = await this.ledger.get("SELECT 1 FROM brief_runs WHERE id=? AND account_id=?", [runId, accountId]);
      if (!exists) throw new BriefRunNotFoundError();
      throw new BriefRunStateError();
    }
    return this.getRun(accountId, runId);
  }

  /**
   * Atomically moves a run to `awaiting_review` only with the draft and its
   * exact revision recorded — the durable CHECK enforces the references exist
   * in the same write, and the transition is a plain stage CAS.
   */
  async markAwaitingReview(
    accountIdValue: string,
    runIdValue: string,
    input: {
      readonly expectedStageOperationId?: string | null;
      readonly documentId: string;
      readonly documentRevisionId: string;
    }
  ): Promise<StoredBriefRun> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    const documentId = uuidIdentity(input.documentId, "document id");
    const documentRevisionId = uuidIdentity(input.documentRevisionId, "document revision id");
    const timestamp = this.now().toISOString();
    const expectedOp = input.expectedStageOperationId ?? null;
    const cas = await this.ledger.run(
      `UPDATE brief_runs
       SET stage='awaiting_review',stage_operation_id=NULL,stage_attempts=stage_attempts+1,
           document_id=?,document_revision_id=?,stage_updated_at=?
       WHERE id=? AND account_id=? AND stage='drafting'
         AND (? IS NULL OR stage_operation_id=?)`,
      [documentId, documentRevisionId, timestamp, runId, accountId, expectedOp, expectedOp]
    );
    if (cas.changes !== 1) {
      const exists = await this.ledger.get("SELECT 1 FROM brief_runs WHERE id=? AND account_id=?", [runId, accountId]);
      if (!exists) throw new BriefRunNotFoundError();
      throw new BriefRunStateError();
    }
    return this.getRun(accountId, runId);
  }

  /** Bounded stage-data write guarded by the current stage attempt. */
  async stageUpdate(
    accountIdValue: string,
    runIdValue: string,
    input: {
      readonly stage: BriefRunStage;
      readonly expectedStageOperationId?: string | null;
      readonly refreshReceipts?: readonly unknown[];
      readonly sourceSnapshot?: readonly unknown[];
      readonly analysisRunId?: string | null;
      readonly baselineRunId?: string | null;
      readonly analysisSucceeded?: boolean;
      readonly comparisonSummary?: unknown;
      readonly documentId?: string | null;
      readonly documentRevisionId?: string | null;
      readonly publicationOperationId?: string | null;
      readonly reviewedRevisionId?: string | null;
      readonly cancelRequested?: boolean;
    }
  ): Promise<StoredBriefRun> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (input.refreshReceipts !== undefined) {
      assignments.push("refresh_receipts=?");
      values.push(encodeJson(input.refreshReceipts, "refresh receipts"));
    }
    if (input.sourceSnapshot !== undefined) {
      assignments.push("source_snapshot=?");
      values.push(encodeJson(input.sourceSnapshot, "source snapshot"));
    }
    if (input.analysisRunId !== undefined) {
      assignments.push("analysis_run_id=?");
      values.push(input.analysisRunId === null ? null : uuidIdentity(input.analysisRunId, "analysis run id"));
    }
    if (input.baselineRunId !== undefined) {
      assignments.push("baseline_run_id=?");
      values.push(input.baselineRunId === null ? null : uuidIdentity(input.baselineRunId, "baseline run id"));
    }
    if (input.analysisSucceeded !== undefined) {
      assignments.push("analysis_succeeded=?");
      values.push(input.analysisSucceeded ? 1 : 0);
    }
    if (input.comparisonSummary !== undefined) {
      assignments.push("comparison_summary=?");
      values.push(input.comparisonSummary === null ? null : encodeJson(input.comparisonSummary, "comparison summary"));
    }
    if (input.documentId !== undefined) {
      assignments.push("document_id=?");
      values.push(input.documentId === null ? null : uuidIdentity(input.documentId, "document id"));
    }
    if (input.documentRevisionId !== undefined) {
      assignments.push("document_revision_id=?");
      values.push(
        input.documentRevisionId === null ? null : uuidIdentity(input.documentRevisionId, "document revision id")
      );
    }
    if (input.publicationOperationId !== undefined) {
      assignments.push("publication_operation_id=?");
      values.push(
        input.publicationOperationId === null
          ? null
          : uuidIdentity(input.publicationOperationId, "publication operation id")
      );
    }
    if (input.reviewedRevisionId !== undefined) {
      assignments.push("reviewed_revision_id=?");
      values.push(
        input.reviewedRevisionId === null ? null : uuidIdentity(input.reviewedRevisionId, "reviewed revision id")
      );
    }
    if (input.cancelRequested !== undefined) {
      assignments.push("cancel_requested=?");
      values.push(input.cancelRequested ? 1 : 0);
    }
    if (assignments.length < 1) throw new BriefRunStateError("stage update carries no fields");
    const timestamp = this.now().toISOString();
    assignments.push("stage_updated_at=?");
    values.push(timestamp);
    const expectedOp = input.expectedStageOperationId ?? null;
    const cas = await this.ledger.run(
      `UPDATE brief_runs SET ${assignments.join(",")}
       WHERE id=? AND account_id=? AND stage=? AND (? IS NULL OR stage_operation_id=?)`,
      [...values, runId, accountId, input.stage, expectedOp, expectedOp]
    );
    if (cas.changes !== 1) {
      const exists = await this.ledger.get("SELECT 1 FROM brief_runs WHERE id=? AND account_id=?", [runId, accountId]);
      if (!exists) throw new BriefRunNotFoundError();
      throw new BriefRunStateError();
    }
    return this.getRun(accountId, runId);
  }

  // -- Outcome accounting ------------------------------------------------------

  /**
   * Applies execution-outcome accounting to the recipe in one short CAS
   * transaction. Only `failed` increments the consecutive-failure counter,
   * and the fifth consecutive failure pauses the recipe with a bounded reason
   * plus a durable `paused` notification (never a repeated one). `skipped`
   * and `blocked` are consent/migration visibility states; `succeeded`
   * (reaching review) resets the counter. A rejected draft is never routed
   * here as a failure. A deleted recipe makes this a silent no-op.
   */
  async applyExecutionOutcome(
    accountIdValue: string,
    runIdValue: string,
    outcome: BriefExecutionOutcome
  ): Promise<{ readonly paused: boolean; readonly consecutiveFailures: number }> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const run = transaction.get<RunRow>("SELECT recipe_id FROM brief_runs WHERE id=? AND account_id=?", [
        runId,
        accountId,
      ]);
      if (!run) throw new BriefRunNotFoundError();
      const recipeId = String(run.recipe_id);
      const notificationsEnabled =
        decodeSafeInteger(
          transaction.get<{ notifications_enabled?: unknown }>(
            "SELECT notifications_enabled FROM brief_recipes WHERE id=? AND account_id=?",
            [recipeId, accountId]
          )?.notifications_enabled ?? 1,
          "notifications enabled"
        ) !== 0;
      if (outcome === "failed") {
        const cas = transaction.run(
          `UPDATE brief_recipes SET
             consecutive_failures=consecutive_failures+1,
             state=CASE WHEN consecutive_failures+1>=? THEN 'paused' ELSE state END,
             paused_reason=CASE WHEN consecutive_failures+1>=? THEN 'paused after 5 consecutive execution failures' ELSE paused_reason END,
             updated_at=?
           WHERE id=? AND account_id=?`,
          [
            BRIEF_RECIPE_MAX_FAILURES_BEFORE_PAUSE,
            BRIEF_RECIPE_MAX_FAILURES_BEFORE_PAUSE,
            new Date().toISOString(),
            recipeId,
            accountId,
          ]
        );
        if (cas.changes !== 1) return { paused: false, consecutiveFailures: 0 };
        const head = transaction.get<{ consecutive_failures?: unknown; state?: unknown }>(
          "SELECT consecutive_failures,state FROM brief_recipes WHERE id=? AND account_id=?",
          [recipeId, accountId]
        );
        const failures = decodeSafeInteger(head?.consecutive_failures ?? 0, "consecutive failures");
        const paused = head?.state === "paused";
        if (paused && notificationsEnabled) {
          transaction.run(
            `INSERT INTO brief_notifications (id,account_id,recipe_id,run_id,kind,detail)
             VALUES (?,?,?,?, 'paused','the recipe was paused after 5 consecutive execution failures')
             ON CONFLICT(run_id,kind) DO NOTHING`,
            [randomUUID(), accountId, recipeId, runId]
          );
        }
        return { paused, consecutiveFailures: failures };
      }
      if (outcome === "succeeded") {
        transaction.run("UPDATE brief_recipes SET consecutive_failures=0,updated_at=? WHERE id=? AND account_id=?", [
          new Date().toISOString(),
          recipeId,
          accountId,
        ]);
      }
      // skipped/blocked: visibility only — the counter never moves.
      const head = transaction.get<{ consecutive_failures?: unknown }>(
        "SELECT consecutive_failures FROM brief_recipes WHERE id=? AND account_id=?",
        [recipeId, accountId]
      );
      return { paused: false, consecutiveFailures: decodeSafeInteger(head?.consecutive_failures ?? 0, "failures") };
    });
  }

  /**
   * Durable cancellation request for one run, idempotent across repeats and
   * terminals: an active run gets `cancel_requested=1` (the runner observes it
   * at stage boundaries and finalizes `cancelled`); an already-terminal run
   * simply returns unchanged. There is no silent undo.
   */
  async requestRunCancel(
    accountIdValue: string,
    runIdValue: string
  ): Promise<{ readonly run: StoredBriefRun; readonly cancelRequested: boolean }> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const current = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM brief_runs WHERE id=? AND account_id=?`, [
        runId,
        accountId,
      ]);
      if (!current) throw new BriefRunNotFoundError();
      const stage = String(current.stage) as BriefRunStage;
      if (!(BRIEF_ACTIVE_STAGES as readonly string[]).includes(stage)) {
        return Object.freeze({
          run: decodeBriefRun(current),
          cancelRequested: decodeSafeInteger(current.cancel_requested ?? 0, "cancel requested") === 1,
        });
      }
      transaction.run("UPDATE brief_runs SET cancel_requested=1 WHERE id=? AND account_id=?", [runId, accountId]);
      const updated = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM brief_runs WHERE id=? AND account_id=?`, [
        runId,
        accountId,
      ]);
      if (!updated) throw new BriefRunNotFoundError();
      return Object.freeze({ run: decodeBriefRun(updated), cancelRequested: true });
    });
  }

  /** Deduplicated local notification: at most one row per (run, kind). */
  async recordNotification(
    accountIdValue: string,
    runIdValue: string,
    kind: BriefNotificationKind,
    detail?: string
  ): Promise<{ readonly id: string; readonly created: boolean }> {
    if (!BRIEF_NOTIFICATION_KINDS.includes(kind)) throw new RangeError("unknown brief notification kind");
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    const bounded = detail == null ? null : detail.slice(0, BRIEF_NOTIFICATION_DETAIL_MAX);
    return this.ledger.withImmediateTransaction((transaction) => {
      const run = transaction.get<RunRow>("SELECT recipe_id FROM brief_runs WHERE id=? AND account_id=?", [
        runId,
        accountId,
      ]);
      if (!run) throw new BriefRunNotFoundError();
      // Per-recipe notification disable (schema v27): a live recipe with the
      // knob off records nothing new (the (run, kind) dedupe is untouched);
      // a deleted recipe no longer carries a preference, so the event still
      // lands on the retained run for inspection.
      const preference = transaction.get<{ notifications_enabled?: unknown }>(
        "SELECT notifications_enabled FROM brief_recipes WHERE id=? AND account_id=?",
        [String(run.recipe_id), accountId]
      );
      if (preference && decodeSafeInteger(preference.notifications_enabled ?? 1, "notifications enabled") === 0) {
        return { id: "", created: false };
      }
      const existing = transaction.get<{ id?: unknown }>(
        "SELECT id FROM brief_notifications WHERE run_id=? AND kind=?",
        [runId, kind]
      );
      if (existing) return { id: String(existing.id), created: false };
      const id = randomUUID();
      transaction.run(
        "INSERT INTO brief_notifications (id,account_id,recipe_id,run_id,kind,detail) VALUES (?,?,?,?,?,?)",
        [id, accountId, String(run.recipe_id), runId, kind, bounded]
      );
      return { id, created: true };
    });
  }

  async getNotification(
    accountIdValue: string,
    notificationIdValue: string
  ): Promise<StoredBriefNotification | undefined> {
    const row = await this.ledger.get<NotificationRow>(
      `SELECT id,account_id,recipe_id,run_id,kind,state,detail,created_at,updated_at,read_at
       FROM brief_notifications WHERE id=? AND account_id=?`,
      [uuidIdentity(notificationIdValue, "notification id"), uuidIdentity(accountIdValue, "account id")]
    );
    return row ? decodeNotification(row) : undefined;
  }

  async setNotificationState(
    accountIdValue: string,
    notificationIdValue: string,
    state: BriefNotificationState
  ): Promise<boolean> {
    if (!["unread", "read", "dismissed"].includes(state)) throw new RangeError("unknown notification state");
    const accountId = uuidIdentity(accountIdValue, "account id");
    const id = uuidIdentity(notificationIdValue, "notification id");
    const updated = await this.ledger.run(
      `UPDATE brief_notifications SET state=?,read_at=CASE WHEN ?='unread' THEN NULL ELSE COALESCE(read_at,?) END,updated_at=?
       WHERE id=? AND account_id=?`,
      [state, state, new Date().toISOString(), new Date().toISOString(), id, accountId]
    );
    return updated.changes === 1;
  }

  // -- Review decisions (M16 stage 3) ---------------------------------------------

  /**
   * Records one review decision for an `awaiting_review` run in a single
   * immediate transaction: the decision is accepted only against the exact
   * draft revision that is also the document head at that instant (head CAS —
   * a concurrent edit makes this fail with a revision conflict, so unseen
   * content is never approved). Approval persists the decision intent: the
   * immutable `brief_review_events` row, the exact reviewed revision, and the
   * stable publication operation UUID, then moves the run to `publishing`
   * (the durable CHECK requires the operation UUID in the same write). The
   * derived-from-run operation UUID is deterministic per (run, reviewed
   * revision), so an approval retry reconciles the SAME publication intent
   * and can never create a second publication. Rejection is terminal: it
   * preserves the run and draft for inspection and can never publish. A
   * repeat decision against the recorded terminal state replays the recorded
   * outcome; it never rewrites the ledger.
   */
  async recordReviewDecision(
    accountIdValue: string,
    runIdValue: string,
    input: {
      readonly decision: BriefReviewDecision;
      readonly documentRevisionId: string;
      readonly note?: string | null;
    }
  ): Promise<{ readonly run: StoredBriefRun; readonly replayed: boolean }> {
    if (!(BRIEF_REVIEW_DECISIONS as readonly string[]).includes(input.decision)) {
      throw new RangeError("unknown brief review decision");
    }
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    const revisionId = uuidIdentity(input.documentRevisionId, "reviewed document revision id");
    const note =
      input.note == null || input.note.trim() === "" ? null : input.note.trim().slice(0, BRIEF_REVIEW_NOTE_MAX);
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM brief_runs WHERE id=? AND account_id=?`, [
        runId,
        accountId,
      ]);
      if (!row) throw new BriefRunNotFoundError();
      const run = decodeBriefRun(row);
      const timestamp = this.now().toISOString();
      if (input.decision === "reject") {
        if (run.stage === "rejected") return Object.freeze({ run, replayed: true });
        if (run.stage === "publishing" || run.stage === "approved") {
          throw new BriefRunStateError(
            "an approval decision for this brief has already been accepted and cannot be revoked",
            { cause: new Error(`stage ${run.stage}`) }
          );
        }
        if (run.stage !== "awaiting_review") throw new BriefRunStateError();
        this.assertHeadInTransaction(transaction, accountId, run, revisionId);
        const updated = transaction.run(
          `UPDATE brief_runs
           SET stage='rejected',stage_operation_id=NULL,reviewed_revision_id=?,document_revision_id=?,
               publication_error_code=NULL,finished_at=?,stage_updated_at=?
           WHERE id=? AND account_id=? AND stage='awaiting_review'`,
          [revisionId, revisionId, timestamp, timestamp, runId, accountId]
        );
        if (updated.changes !== 1) throw new BriefRunStateError();
        this.appendReviewEventInTransaction(transaction, run, revisionId, "reject", note, timestamp);
        const decided = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM brief_runs WHERE id=? AND account_id=?`, [
          runId,
          accountId,
        ]);
        if (!decided) throw new BriefRunNotFoundError();
        return Object.freeze({ run: decodeBriefRun(decided), replayed: false });
      }
      // Approval.
      if (run.stage === "approved") {
        if (run.reviewedRevisionId !== revisionId) {
          throw new BriefRunStateError("this brief was approved against a different draft revision", {
            cause: new Error("reviewed revision drift"),
          });
        }
        return Object.freeze({ run, replayed: true });
      }
      if (run.stage === "publishing") {
        throw new BriefRunStateError("an approval decision for this brief is already publishing", {
          cause: new Error("stage publishing"),
        });
      }
      if (run.stage !== "awaiting_review") throw new BriefRunStateError();
      if (run.documentId === null) {
        throw new BriefRunStateError("a review approval requires the run's report draft", {
          cause: new Error("missing draft"),
        });
      }
      this.assertHeadInTransaction(transaction, accountId, run, revisionId);
      // Deterministic per (run, reviewed revision): an approval retry of the
      // same decision reconciles the SAME publication intent — a re-review
      // after an edit gets a fresh intent on purpose.
      const operationId = deriveBriefPublicationOperationId(runId, revisionId);
      const updated = transaction.run(
        `UPDATE brief_runs
         SET stage='publishing',stage_operation_id=NULL,reviewed_revision_id=?,document_revision_id=?,
             publication_operation_id=?,publication_error_code=NULL,stage_updated_at=?
         WHERE id=? AND account_id=? AND stage='awaiting_review'`,
        [revisionId, revisionId, operationId, timestamp, runId, accountId]
      );
      if (updated.changes !== 1) throw new BriefRunStateError();
      this.appendReviewEventInTransaction(transaction, run, revisionId, "approve", note, timestamp);
      const decided = transaction.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM brief_runs WHERE id=? AND account_id=?`, [
        runId,
        accountId,
      ]);
      if (!decided) throw new BriefRunNotFoundError();
      return Object.freeze({ run: decodeBriefRun(decided), replayed: false });
    });
  }

  /** Current head revision of the run's draft; a moved/vanished head conflicts. */
  private assertHeadInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    run: StoredBriefRun,
    revisionId: string
  ): void {
    if (run.documentId === null) {
      throw new BriefReviewRevisionConflictError("the brief draft is no longer available", {
        cause: new Error("missing draft reference"),
      });
    }
    const head = transaction.get<{ head_revision_id?: unknown }>(
      `SELECT h.id AS head_revision_id
       FROM documents d
       JOIN document_revisions h
         ON h.document_id=d.id AND h.revision=d.current_revision AND h.account_id=d.account_id
       WHERE d.id=? AND d.account_id=?`,
      [run.documentId, accountId]
    );
    if (!head || String(head.head_revision_id) !== revisionId) {
      throw new BriefReviewRevisionConflictError();
    }
  }

  private appendReviewEventInTransaction(
    transaction: SqliteTransaction,
    run: StoredBriefRun,
    revisionId: string,
    decision: BriefReviewDecision,
    note: string | null,
    timestamp: string
  ): void {
    if (run.documentId === null) throw new BriefRunStateError("review events require the run's draft reference");
    transaction.run(
      `INSERT INTO brief_review_events (id,account_id,run_id,recipe_id,document_id,document_revision_id,decision,note,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), run.accountId, run.id, run.recipeId, run.documentId, revisionId, decision, note, timestamp]
    );
  }

  /** publishing → approved, only after the publication committed. */
  async completeBriefApproval(accountIdValue: string, runIdValue: string): Promise<StoredBriefRun> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    const timestamp = this.now().toISOString();
    const cas = await this.ledger.run(
      `UPDATE brief_runs
       SET stage='approved',finished_at=?,publication_error_code=NULL,stage_updated_at=?
       WHERE id=? AND account_id=? AND stage='publishing'`,
      [timestamp, timestamp, runId, accountId]
    );
    if (cas.changes !== 1) {
      const exists = await this.ledger.get("SELECT 1 FROM brief_runs WHERE id=? AND account_id=?", [runId, accountId]);
      if (!exists) throw new BriefRunNotFoundError();
      throw new BriefRunStateError();
    }
    return this.getRun(accountId, runId);
  }

  /**
   * publishing → awaiting_review after a failed (or unrecoverable) render:
   * the run returns to review with the bounded failed-publication indicator
   * and keeps its stable publication operation UUID, so the retry decision
   * reconciles the same intent. The retry's own head CAS requires a fresh
   * review when the draft was edited in the meantime.
   */
  async failBriefPublication(
    accountIdValue: string,
    runIdValue: string,
    input: { readonly errorCode: string }
  ): Promise<StoredBriefRun> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const runId = uuidIdentity(runIdValue, "run id");
    const code = input.errorCode.slice(0, BRIEF_PUBLICATION_ERROR_CODE_MAX) || "BRIEF_PUBLICATION_FAILED";
    const timestamp = this.now().toISOString();
    const cas = await this.ledger.run(
      `UPDATE brief_runs
       SET stage='awaiting_review',stage_operation_id=NULL,publication_error_code=?,stage_updated_at=?
       WHERE id=? AND account_id=? AND stage='publishing'`,
      [code, timestamp, runId, accountId]
    );
    if (cas.changes !== 1) {
      const exists = await this.ledger.get("SELECT 1 FROM brief_runs WHERE id=? AND account_id=?", [runId, accountId]);
      if (!exists) throw new BriefRunNotFoundError();
      throw new BriefRunStateError();
    }
    return this.getRun(accountId, runId);
  }

  /** Publishing-stage rows for restart reconciliation (bounded, cross-account). */
  async listPublishingRuns(limit = BRIEF_CLAIM_BATCH_LIMIT): Promise<readonly StoredBriefRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BRIEF_CLAIM_BATCH_LIMIT) {
      throw new RangeError(`reconciliation limit must be between 1 and ${BRIEF_CLAIM_BATCH_LIMIT}`);
    }
    const rows = await this.ledger.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM brief_runs WHERE stage='publishing' ORDER BY stage_updated_at,id LIMIT ?`,
      [limit]
    );
    return rows.map((row) => decodeBriefRun(row));
  }

  /**
   * Account-scoped review inbox: pending, publishing, and decided runs with
   * the live document head, the retained recipe state, and the latest
   * decision from the immutable ledger. Keyset-ordered by creation (stable
   * across in-flight stage transitions); deleted recipes stay readable
   * through the retained run snapshot.
   */
  async listReviewInbox(
    accountIdValue: string,
    pageValue: CatalogPageRequest = { limit: BRIEF_PAGE_DEFAULT_LIMIT, after: null }
  ): Promise<CatalogStorePage<StoredBriefReviewRow>> {
    const page = validateBriefPageRequest(pageValue);
    const accountId = uuidIdentity(accountIdValue, "account id");
    const parameters: Array<string | number> = [accountId, ...BRIEF_REVIEW_INBOX_STAGES];
    const after = page.after ? " AND (r.created_at,r.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<ReviewRow>(
      `SELECT ${RUN_COLUMNS_R},
              hrev.id AS head_revision_id,
              hrev.revision AS head_revision,
              rec.state AS recipe_state,
              rec.paused_reason AS recipe_paused_reason,
              ev.decision AS last_decision,
              ev.note AS last_note,
              ev.document_revision_id AS last_decision_revision_id,
              ev.created_at AS last_decision_at
       FROM brief_runs r
       LEFT JOIN documents d
         ON d.id=r.document_id AND d.account_id=r.account_id
       LEFT JOIN document_revisions hrev
         ON hrev.document_id=d.id AND hrev.revision=d.current_revision AND hrev.account_id=r.account_id
       LEFT JOIN brief_recipes rec
         ON rec.id=r.recipe_id AND rec.account_id=r.account_id
       LEFT JOIN brief_review_events ev
         ON ev.id=(SELECT e.id FROM brief_review_events e
                   WHERE e.run_id=r.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1)
       WHERE r.account_id=? AND r.stage IN (${placeholders(BRIEF_REVIEW_INBOX_STAGES.length)})${after}
       ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeReviewRow(row)),
      page,
      (review) => ({
        timestamp: review.run.createdAt,
        id: review.run.id,
      })
    );
  }

  /** Account-scoped local-notification keyset page (durable read/dismiss state). */
  async listNotifications(
    accountIdValue: string,
    pageValue: CatalogPageRequest = { limit: BRIEF_PAGE_DEFAULT_LIMIT, after: null }
  ): Promise<CatalogStorePage<StoredBriefNotification>> {
    const page = validateBriefPageRequest(pageValue);
    const accountId = uuidIdentity(accountIdValue, "account id");
    const parameters: Array<string | number> = [accountId];
    const after = page.after ? " AND (created_at,id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<NotificationRow>(
      `SELECT id,account_id,recipe_id,run_id,kind,state,detail,created_at,updated_at,read_at
       FROM brief_notifications
       WHERE account_id=?${after}
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeNotification(row)),
      page,
      (item) => ({
        timestamp: item.createdAt,
        id: item.id,
      })
    );
  }

  // -- Baseline selection --------------------------------------------------------

  /**
   * Selects the comparison baseline for a new run: the newest earlier run of
   * THIS recipe whose recorded analysis succeeded and whose
   * definition revision, resolved parameter bindings, and exact source set all
   * equal the current run's (M12 compatibility rules — differing ready
   * generations are the intended comparison). Any definition/parameter/
   * membership change simply matches nothing and begins a new series; a
   * missing baseline is a clearly labeled first run.
   */
  async selectBaselineRun(
    accountIdValue: string,
    recipeIdValue: string,
    excludeRunIdValue: string,
    compatibility: {
      readonly analysisId: string;
      readonly analysisRevision: number;
      readonly parameterValues: readonly AnalysisParameterBinding[];
      readonly sourceIds: readonly string[];
    }
  ): Promise<StoredBriefRun | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const recipeId = uuidIdentity(recipeIdValue, "recipe id");
    const excludeRunId = uuidIdentity(excludeRunIdValue, "run id");
    if (!Number.isSafeInteger(compatibility.analysisRevision) || compatibility.analysisRevision < 1) {
      throw new RangeError("analysis revision must be a positive safe integer");
    }
    const row = await this.ledger.get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM brief_runs
       WHERE account_id=? AND recipe_id=? AND id<>?
         AND analysis_succeeded=1
         AND analysis_id=? AND analysis_revision=?
         AND parameter_hash=? AND source_set_hash=?
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [
        accountId,
        recipeId,
        excludeRunId,
        uuidIdentity(compatibility.analysisId, "analysis id"),
        compatibility.analysisRevision,
        briefParameterHash(compatibility.parameterValues),
        briefSourceSetHash(compatibility.sourceIds),
      ]
    );
    return row ? decodeBriefRun(row) : undefined;
  }

  // -- Reads / recovery ----------------------------------------------------------

  async getRun(accountIdValue: string, runIdValue: string): Promise<StoredBriefRun> {
    const row = await this.ledger.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM brief_runs WHERE id=? AND account_id=?`, [
      uuidIdentity(runIdValue, "run id"),
      uuidIdentity(accountIdValue, "account id"),
    ]);
    if (!row) throw new BriefRunNotFoundError();
    return decodeBriefRun(row);
  }

  async listRuns(
    accountIdValue: string,
    recipeIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<StoredBriefRun>> {
    const page = validateCatalogPageRequest(pageValue);
    const accountId = uuidIdentity(accountIdValue, "account id");
    const recipeId = uuidIdentity(recipeIdValue, "recipe id");
    const parameters: Array<string | number> = [accountId, recipeId];
    const after = page.after ? " AND (created_at,id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM brief_runs
       WHERE account_id=? AND recipe_id=?${after}
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeBriefRun(row)),
      page,
      (run) => ({ timestamp: run.createdAt, id: run.id })
    );
  }

  /**
   * Durable recovery records for restart: every non-terminal run with its
   * committed stage attempt, persisted deadlines, receipts, and artifact
   * references. Restart resumes from these rows; nothing here re-creates an
   * already committed artifact (each stage's at-most-one write is guarded by
   * the stage CAS and the referenced ids).
   */
  async recoverActiveRuns(limit = BRIEF_CLAIM_BATCH_LIMIT): Promise<readonly StoredBriefRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BRIEF_CLAIM_BATCH_LIMIT) {
      throw new RangeError(`recovery limit must be between 1 and ${BRIEF_CLAIM_BATCH_LIMIT}`);
    }
    const rows = await this.ledger.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM brief_runs
       WHERE stage IN (${placeholders(BRIEF_ACTIVE_STAGES.length)})
       ORDER BY stage_updated_at,id LIMIT ?`,
      [...BRIEF_ACTIVE_STAGES, limit]
    );
    return rows.map((row) => decodeBriefRun(row));
  }
}
