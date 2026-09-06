import { createHash, randomUUID } from "node:crypto";
import {
  catalogStorePage,
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../../catalogPagination.js";
import { decodeJson, decodeSafeInteger, encodeJson } from "../../db/codecs.js";
import { SqliteConstraintError, type SqliteLedger, type SqliteTransaction } from "../../db/types.js";
import {
  CalendarScheduleError,
  nextOccurrence,
  normalizeCalendarSchedule,
  type CalendarSchedule,
} from "../../calendarSchedule.js";
import {
  normalizeSourceIds,
  resolveParameterBindings,
  type AnalysisParameterBinding,
  type AnalysisParameterDeclaration,
} from "../../analysisTypes.js";

export const BRIEF_RECIPE_NAME_MAX = 80;
export const BRIEF_REPORT_TITLE_MAX = 200;
export const BRIEF_REPORT_INSTRUCTION_MAX = 8_000;
export const BRIEF_RECIPE_SOURCE_MAX = 100;
export const BRIEF_RECIPE_PAUSED_REASON_MAX = 500;
export const BRIEF_RECIPE_MAX_FAILURES_BEFORE_PAUSE = 5;

export type BriefRecipeState = "active" | "paused";

export interface BriefRefreshBinding {
  readonly source_id: string;
  readonly kind: "connector" | "knowledge";
  readonly connector_id: string | null;
  readonly connection_id: string | null;
}

/** The full mutable recipe content; also the shape of one immutable revision. */
export interface BriefRecipeContent {
  readonly name: string;
  readonly analysis_id: string;
  readonly analysis_revision: number;
  readonly parameter_values: readonly AnalysisParameterBinding[];
  readonly report_title: string;
  readonly report_instruction: string;
  readonly source_ids: readonly string[];
  readonly refresh_bindings: readonly BriefRefreshBinding[];
  readonly schedule: CalendarSchedule;
}

export interface StoredBriefRecipe {
  readonly id: string;
  readonly accountId: string;
  readonly kind: "reviewed_brief";
  readonly revision: number;
  readonly state: BriefRecipeState;
  readonly pausedReason: string | null;
  /**
   * Per-recipe local-notification preference (schema v27, M16 step 8).
   * Head-only mutable state: toggling is not recipe revision content.
   */
  readonly notificationsEnabled: boolean;
  readonly consecutiveFailures: number;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string;
  readonly nextOccurrenceKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly content: BriefRecipeContent;
}

export class BriefValidationError extends Error {
  readonly code = "BRIEF_RECIPE_VALIDATION";
  readonly statusCode = 400;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "BriefValidationError";
  }
}

export class BriefRecipeNotFoundError extends Error {
  readonly code = "BRIEF_RECIPE_NOT_FOUND";
  readonly statusCode = 404;

  constructor(options: ErrorOptions = {}) {
    super("brief recipe not found", options);
    this.name = "BriefRecipeNotFoundError";
  }
}

export class BriefRevisionConflictError extends Error {
  readonly code = "BRIEF_REVISION_CONFLICT";
  readonly statusCode = 409;

  constructor(options: ErrorOptions = {}) {
    super("brief recipe revision conflict", options);
    this.name = "BriefRevisionConflictError";
  }
}

// ---------------------------------------------------------------------------
// Input hygiene
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BriefValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function parseStoredJson(value: unknown, field: string): unknown {
  return typeof value === "string" ? decodeJson(value, field) : value;
}

function textInput(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new BriefValidationError(`${field} must be a string of 1..${maximum} characters`);
  }
  return value;
}

export function normalizeBriefRecipeName(value: unknown): string {
  const name = textInput(value, "name", BRIEF_RECIPE_NAME_MAX).trim();
  if (name.length < 1) throw new BriefValidationError("name must contain between 1 and 80 characters");
  return name;
}

function decodeParameterDeclarations(value: unknown, field: string): readonly AnalysisParameterDeclaration[] {
  const parsed: unknown = parseStoredJson(value, field);
  if (!Array.isArray(parsed)) throw new BriefValidationError(`${field} is not stored as an array`);
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new BriefValidationError(`${field} holds a malformed declaration`);
    }
    const record = candidate as Record<string, unknown>;
    const type = record.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "date") {
      throw new BriefValidationError(`${field} holds an unsupported parameter type`);
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
      name:
        typeof record.name === "string"
          ? record.name
          : (() => {
              throw new BriefValidationError(`${field} name is malformed`);
            })(),
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

export function decodeBriefParameterBindings(value: unknown, field: string): readonly AnalysisParameterBinding[] {
  const parsed: unknown = parseStoredJson(value, field);
  if (!Array.isArray(parsed)) throw new BriefValidationError(`${field} is not stored as an array`);
  return parsed.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new BriefValidationError(`${field} holds a malformed binding`);
    }
    const record = candidate as Record<string, unknown>;
    const type = record.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "date") {
      throw new BriefValidationError(`${field} holds an unsupported parameter type`);
    }
    if (typeof record.name !== "string") throw new BriefValidationError(`${field} name is malformed`);
    const value = record.value;
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new BriefValidationError(`${field} value is malformed`);
    }
    return Object.freeze({ name: record.name, type, value: value as AnalysisParameterBinding["value"] });
  });
}

export function decodeStringArray(value: unknown, field: string): readonly string[] {
  const parsed: unknown = parseStoredJson(value, field);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new BriefValidationError(`${field} is not stored as a string array`);
  }
  return parsed as string[];
}

export function decodeRefreshBindings(value: unknown, field: string): readonly BriefRefreshBinding[] {
  const parsed: unknown = parseStoredJson(value, field);
  if (!Array.isArray(parsed)) throw new BriefValidationError(`${field} is not stored as an array`);
  return parsed.map((candidate) => validateRefreshBindingEntry(candidate, field));
}

function validateRefreshBindingEntry(candidate: unknown, field: string): BriefRefreshBinding {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new BriefValidationError(`${field} holds a malformed binding`);
  }
  const record = candidate as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["source_id", "kind", "connector_id", "connection_id"].includes(key)) {
      throw new BriefValidationError(`${field} holds an unknown binding field "${key}"`);
    }
  }
  const sourceId = uuidIdentity(record.source_id, `${field} source_id`);
  const kind = record.kind;
  if (kind !== "connector" && kind !== "knowledge") {
    throw new BriefValidationError(`${field} kind must be connector or knowledge`);
  }
  const connectorId =
    record.connector_id === undefined || record.connector_id === null
      ? null
      : uuidIdentity(record.connector_id, `${field} connector_id`);
  const connectionId =
    record.connection_id === undefined || record.connection_id === null
      ? null
      : uuidIdentity(record.connection_id, `${field} connection_id`);
  if (kind === "connector" && (connectorId === null || connectionId !== null)) {
    throw new BriefValidationError(`connector refresh bindings carry exactly a connector_id`);
  }
  if (kind === "knowledge" && (connectionId === null || connectorId !== null)) {
    throw new BriefValidationError(`knowledge refresh bindings carry exactly a connection_id`);
  }
  return Object.freeze({
    source_id: sourceId,
    kind,
    connector_id: connectorId,
    connection_id: connectionId,
  });
}

/** Deterministic hashes used for baseline-compatibility selection. */
export function briefParameterHash(bindings: readonly AnalysisParameterBinding[]): string {
  return createHash("sha256").update(encodeJson(bindings, "parameter bindings"), "utf8").digest("hex");
}

export function briefSourceSetHash(sourceIds: readonly string[]): string {
  const canonical = encodeJson([...sourceIds].sort(), "source ids");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Normalized write input
// ---------------------------------------------------------------------------

export interface BriefRecipeWriteInput {
  readonly name: unknown;
  readonly analysis_id: unknown;
  readonly parameter_values?: unknown;
  readonly report_title: unknown;
  readonly report_instruction: unknown;
  readonly source_ids: unknown;
  readonly refresh_bindings?: unknown;
  readonly schedule: unknown;
}

interface ResolvedWrite {
  readonly content: BriefRecipeContent;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface RecipeRow {
  [column: string]: unknown;
}

export class BriefRecipeStore {
  constructor(
    private readonly ledger: SqliteLedger,
    private readonly options: { readonly now?: () => Date } = {}
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  // -- Write -----------------------------------------------------------------

  /**
   * Normalizes and validates one write against the live ledger state inside
   * the caller's transaction: the bound analysis is owned and its bound
   * revision is the current head; typed parameter values resolve against that
   * revision's declarations; recipe membership must equal the bound revision's
   * selected source set exactly (reject, never truncate or widen); refresh
   * bindings are validated kind-specific ids of this account over bound
   * sources only.
   */
  private async resolveWriteInput(
    transaction: SqliteTransaction,
    accountId: string,
    input: BriefRecipeWriteInput
  ): Promise<ResolvedWrite> {
    const name = normalizeBriefRecipeName(input.name);
    const reportTitle = textInput(input.report_title, "report_title", BRIEF_REPORT_TITLE_MAX);
    const reportInstruction = textInput(input.report_instruction, "report_instruction", BRIEF_REPORT_INSTRUCTION_MAX);
    const schedule = normalizeCalendarSchedule(input.schedule);

    const analysisId = uuidIdentity(input.analysis_id, "analysis_id");
    const head = transaction.get<{ current_revision?: unknown }>(
      "SELECT current_revision FROM analyses WHERE id=? AND account_id=?",
      [analysisId, accountId]
    );
    if (!head) throw new BriefValidationError("analysis_id must reference a saved analysis of this account");
    const analysisRevision = decodeSafeInteger(head.current_revision, "analysis current revision");
    const revisionRow = transaction.get<RecipeRow>(
      "SELECT parameters, source_ids FROM analysis_revisions WHERE analysis_id=? AND revision=? AND account_id=?",
      [analysisId, analysisRevision, accountId]
    );
    if (!revisionRow) throw new BriefValidationError("the bound analysis revision is missing");

    const declarations = decodeParameterDeclarations(revisionRow.parameters, "analysis revision parameters");
    const suppliedValues = input.parameter_values;
    if (
      suppliedValues !== undefined &&
      (typeof suppliedValues !== "object" || suppliedValues === null || Array.isArray(suppliedValues))
    ) {
      throw new BriefValidationError("parameter_values must be an object keyed by declared name");
    }
    // `resolveParameterBindings` throws AnalysisValidationError for undeclared,
    // missing-required, or mistyped values; map to the brief 400 contract.
    let bindings: readonly AnalysisParameterBinding[];
    try {
      bindings = resolveParameterBindings(declarations, suppliedValues as Record<string, unknown> | undefined);
    } catch (error) {
      throw new BriefValidationError(error instanceof Error ? error.message : "invalid parameter values", {
        cause: error,
      });
    }

    let sourceIds: readonly string[];
    try {
      sourceIds = normalizeSourceIds(input.source_ids as readonly unknown[] | undefined);
    } catch (error) {
      throw new BriefValidationError(error instanceof Error ? error.message : "invalid source_ids", { cause: error });
    }
    if (sourceIds.length < 1)
      throw new BriefValidationError("recipe source membership must contain at least one source");
    const revisionSourceIds = decodeStringArray(revisionRow.source_ids, "analysis revision source ids").map((id) =>
      id.toLowerCase()
    );
    const membershipMatches =
      revisionSourceIds.length === sourceIds.length &&
      [...revisionSourceIds].sort().join(",") === [...sourceIds].sort().join(",");
    if (!membershipMatches) {
      throw new BriefValidationError(
        "recipe source membership must equal the bound analysis revision's selected source set"
      );
    }
    if (sourceIds.length > 0) {
      const placeholders = sourceIds.map(() => "?").join(",");
      const owned = transaction.get<{ count?: unknown }>(
        `SELECT COUNT(*) AS count FROM sources WHERE account_id=? AND id IN (${placeholders})`,
        [accountId, ...sourceIds]
      );
      if (decodeSafeInteger(owned?.count ?? 0, "owned sources") !== sourceIds.length) {
        throw new BriefValidationError("every recipe source must belong to this account");
      }
    }

    const suppliedBindings =
      input.refresh_bindings === undefined || input.refresh_bindings === null ? [] : input.refresh_bindings;
    if (!Array.isArray(suppliedBindings)) throw new BriefValidationError("refresh_bindings must be an array");
    if (suppliedBindings.length > BRIEF_RECIPE_SOURCE_MAX) {
      throw new BriefValidationError(`at most ${BRIEF_RECIPE_SOURCE_MAX} refresh bindings are allowed`);
    }
    const bound = new Set<string>();
    const bindingsBySource = new Map<string, BriefRefreshBinding>();
    for (const candidate of suppliedBindings) {
      const entry = validateRefreshBindingEntry(candidate, "refresh_bindings");
      if (bindingsBySource.has(entry.source_id)) {
        throw new BriefValidationError("a source may carry at most one refresh binding");
      }
      if (!sourceIds.includes(entry.source_id)) {
        throw new BriefValidationError("refresh bindings may only reference recipe sources");
      }
      if (entry.kind === "connector") {
        if (!transaction.get("SELECT 1 FROM connectors WHERE id=? AND account_id=?", [entry.connector_id, accountId])) {
          throw new BriefValidationError("connector refresh bindings must reference a connector of this account");
        }
      } else if (
        !transaction.get("SELECT 1 FROM knowledge_connections WHERE id=? AND account_id=?", [
          entry.connection_id,
          accountId,
        ])
      ) {
        throw new BriefValidationError(
          "knowledge refresh bindings must reference a knowledge connection of this account"
        );
      }
      bound.add(entry.source_id);
      bindingsBySource.set(entry.source_id, entry);
    }
    const refreshBindings = sourceIds
      .filter((id) => bindingsBySource.has(id))
      .map((id) => bindingsBySource.get(id) as BriefRefreshBinding);

    return {
      content: Object.freeze({
        name,
        analysis_id: analysisId,
        analysis_revision: analysisRevision,
        parameter_values: bindings,
        report_title: reportTitle,
        report_instruction: reportInstruction,
        source_ids: Object.freeze([...sourceIds]),
        refresh_bindings: Object.freeze(refreshBindings),
        schedule,
      }),
    };
  }

  private insertRevision(
    transaction: SqliteTransaction,
    accountId: string,
    recipeId: string,
    revision: number,
    content: BriefRecipeContent,
    timestamp: string
  ): void {
    transaction.run(
      `INSERT INTO brief_recipe_revisions (
         recipe_id,revision,account_id,name,analysis_id,analysis_revision,parameter_values,
         report_title,report_instruction,source_ids,refresh_bindings,
         schedule_kind,weekday,day_of_month,hour,minute,time_zone,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        recipeId,
        revision,
        accountId,
        content.name,
        content.analysis_id,
        content.analysis_revision,
        encodeJson(content.parameter_values, "recipe parameter values"),
        content.report_title,
        content.report_instruction,
        encodeJson(content.source_ids, "recipe source ids"),
        encodeJson(content.refresh_bindings, "recipe refresh bindings"),
        content.schedule.kind,
        content.schedule.weekday,
        content.schedule.day_of_month,
        content.schedule.hour,
        content.schedule.minute,
        content.schedule.time_zone,
        timestamp,
      ]
    );
  }

  private static scheduleColumns(content: BriefRecipeContent): (string | number | null)[] {
    return [
      content.schedule.kind,
      content.schedule.weekday,
      content.schedule.day_of_month,
      content.schedule.hour,
      content.schedule.minute,
      content.schedule.time_zone,
    ];
  }

  private headWrite(
    content: BriefRecipeContent,
    timestamp: string,
    nextKey: string,
    nextUtc: string
  ): (string | number | null)[] {
    return [
      content.name,
      content.analysis_id,
      content.analysis_revision,
      encodeJson(content.parameter_values, "recipe parameter values"),
      content.report_title,
      content.report_instruction,
      encodeJson(content.source_ids, "recipe source ids"),
      encodeJson(content.refresh_bindings, "recipe refresh bindings"),
      ...BriefRecipeStore.scheduleColumns(content),
      nextKey,
      nextUtc,
      timestamp,
    ];
  }

  async createRecipe(accountIdValue: string, input: BriefRecipeWriteInput): Promise<StoredBriefRecipe> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const recipeId = randomUUID();
    const now = this.now();
    try {
      await this.ledger.withImmediateTransaction(async (transaction) => {
        const { content } = await this.resolveWriteInput(transaction, accountId, input);
        const timestamp = now.toISOString();
        let next: { occurrence_key: string; utc_at: string };
        try {
          next = nextOccurrence(content.schedule, now.getTime());
        } catch (error) {
          throw new BriefValidationError("schedule produced no upcoming occurrence", { cause: error });
        }
        transaction.run(
          `INSERT INTO brief_recipes (
             id,account_id,name,kind,analysis_id,analysis_revision,parameter_values,
             report_title,report_instruction,source_ids,refresh_bindings,
             schedule_kind,weekday,day_of_month,hour,minute,time_zone,
             next_occurrence_key,next_run_at,revision,state,consecutive_failures,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            recipeId,
            accountId,
            content.name,
            "reviewed_brief",
            content.analysis_id,
            content.analysis_revision,
            encodeJson(content.parameter_values, "recipe parameter values"),
            content.report_title,
            content.report_instruction,
            encodeJson(content.source_ids, "recipe source ids"),
            encodeJson(content.refresh_bindings, "recipe refresh bindings"),
            ...BriefRecipeStore.scheduleColumns(content),
            next.occurrence_key,
            next.utc_at,
            1,
            "active",
            0,
            timestamp,
            timestamp,
          ]
        );
        this.insertRevision(transaction, accountId, recipeId, 1, content, timestamp);
      });
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") {
        throw new BriefValidationError("a brief recipe with this name already exists");
      }
      if (error instanceof CalendarScheduleError) throw new BriefValidationError(error.message, { cause: error });
      throw error;
    }
    const recipe = await this.getRecipe(accountId, recipeId);
    if (!recipe) throw new BriefRecipeNotFoundError({ cause: new Error("recipe insert did not persist") });
    return recipe;
  }

  /**
   * Optimistic edit: every mutable field change appends one immutable revision
   * and bumps the head inside the same transaction; a stale `expectedRevision`
   * conflicts and writes nothing. Editing the calendar reschedules the civil
   * cursor strictly after now; older runs keep their frozen snapshots.
   */
  async updateRecipe(
    accountIdValue: string,
    recipeIdValue: string,
    expectedRevision: number,
    patch: Partial<BriefRecipeWriteInput>
  ): Promise<StoredBriefRecipe> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const recipeId = uuidIdentity(recipeIdValue, "recipe id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new RangeError("expectedRevision must be a positive safe integer");
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new BriefValidationError("recipe edit must be an object");
    }
    for (const key of Object.keys(patch)) {
      if (
        ![
          "name",
          "analysis_id",
          "parameter_values",
          "report_title",
          "report_instruction",
          "source_ids",
          "refresh_bindings",
          "schedule",
        ].includes(key)
      ) {
        throw new BriefValidationError(`unknown recipe edit field "${key}"`);
      }
    }
    if (Object.keys(patch).length < 1) throw new BriefValidationError("recipe edit must change at least one field");
    const now = this.now();
    try {
      await this.ledger.withImmediateTransaction(async (transaction) => {
        const head = transaction.get<RecipeRow>(
          `SELECT head.*, rev.analysis_id AS rev_analysis_id, rev.analysis_revision AS rev_analysis_revision
           FROM brief_recipes head
           JOIN brief_recipe_revisions rev
             ON rev.recipe_id=head.id AND rev.revision=head.revision AND rev.account_id=head.account_id
           WHERE head.id=? AND head.account_id=?`,
          [recipeId, accountId]
        );
        if (!head) throw new BriefRecipeNotFoundError();
        if (decodeSafeInteger(head.revision, "recipe revision") !== expectedRevision) {
          throw new BriefRevisionConflictError();
        }
        const base: BriefRecipeContent = {
          name: String(head.name),
          analysis_id: String(head.rev_analysis_id ?? head.analysis_id ?? ""),
          analysis_revision: decodeSafeInteger(
            head.rev_analysis_revision ?? head.analysis_revision,
            "analysis revision"
          ),
          parameter_values: decodeBriefParameterBindings(head.parameter_values, "recipe parameter values"),
          report_title: String(head.report_title),
          report_instruction: String(head.report_instruction),
          source_ids: decodeStringArray(head.source_ids, "recipe source ids"),
          refresh_bindings: decodeRefreshBindings(head.refresh_bindings, "recipe refresh bindings"),
          schedule: normalizeCalendarSchedule({
            kind: head.schedule_kind,
            weekday: head.weekday === null ? undefined : decodeSafeInteger(head.weekday, "weekday"),
            day_of_month: head.day_of_month === null ? undefined : decodeSafeInteger(head.day_of_month, "day_of_month"),
            hour: decodeSafeInteger(head.hour, "hour"),
            minute: decodeSafeInteger(head.minute, "minute"),
            time_zone: String(head.time_zone),
          }),
        };
        const { content } = await this.resolveWriteInput(transaction, accountId, {
          name: patch.name ?? base.name,
          analysis_id: patch.analysis_id ?? base.analysis_id,
          parameter_values: patch.parameter_values ?? toValueMap(base.parameter_values),
          report_title: patch.report_title ?? base.report_title,
          report_instruction: patch.report_instruction ?? base.report_instruction,
          source_ids: patch.source_ids ?? base.source_ids,
          refresh_bindings: patch.refresh_bindings ?? base.refresh_bindings,
          schedule: patch.schedule ?? toScheduleInput(base.schedule),
        });
        const timestamp = now.toISOString();
        let next: { occurrence_key: string; utc_at: string };
        try {
          next = nextOccurrence(content.schedule, now.getTime());
        } catch (error) {
          throw new BriefValidationError("schedule produced no upcoming occurrence", { cause: error });
        }
        const cas = transaction.run(
          `UPDATE brief_recipes SET
             name=?,analysis_id=?,analysis_revision=?,parameter_values=?,report_title=?,report_instruction=?,
             source_ids=?,refresh_bindings=?,schedule_kind=?,weekday=?,day_of_month=?,hour=?,minute=?,time_zone=?,
             next_occurrence_key=?,next_run_at=?,revision=revision+1,updated_at=?
           WHERE id=? AND account_id=? AND revision=?`,
          [
            ...this.headWrite(content, timestamp, next.occurrence_key, next.utc_at),
            recipeId,
            accountId,
            expectedRevision,
          ]
        );
        if (cas.changes !== 1) throw new BriefRevisionConflictError();
        this.insertRevision(transaction, accountId, recipeId, expectedRevision + 1, content, timestamp);
      });
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") {
        throw new BriefValidationError("a brief recipe with this name already exists");
      }
      if (error instanceof CalendarScheduleError) throw new BriefValidationError(error.message, { cause: error });
      throw error;
    }
    const updated = await this.getRecipe(accountId, recipeId);
    if (!updated) throw new BriefRecipeNotFoundError();
    return updated;
  }

  /**
   * Manual pause/resume. Resume advances the civil cursor strictly after now
   * — paused calendars never replay their paused window automatically; missed
   * coalescing applies only while a recipe stayed active.
   */
  async setRecipePaused(
    accountIdValue: string,
    recipeIdValue: string,
    paused: boolean,
    reason?: string
  ): Promise<StoredBriefRecipe> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const recipeId = uuidIdentity(recipeIdValue, "recipe id");
    const boundedReason =
      reason === undefined || reason === null
        ? null
        : textInput(reason, "paused reason", BRIEF_RECIPE_PAUSED_REASON_MAX);
    const now = this.now();
    await this.ledger.withImmediateTransaction(async (transaction) => {
      const head = transaction.get<RecipeRow>(
        "SELECT schedule_kind,weekday,day_of_month,hour,minute,time_zone FROM brief_recipes WHERE id=? AND account_id=?",
        [recipeId, accountId]
      );
      if (!head) throw new BriefRecipeNotFoundError();
      let nextKey: string | null = null;
      let nextUtc: string | null = null;
      if (!paused) {
        const schedule = normalizeCalendarSchedule({
          kind: head.schedule_kind,
          weekday: head.weekday === null ? undefined : decodeSafeInteger(head.weekday, "weekday"),
          day_of_month: head.day_of_month === null ? undefined : decodeSafeInteger(head.day_of_month, "day_of_month"),
          hour: decodeSafeInteger(head.hour, "hour"),
          minute: decodeSafeInteger(head.minute, "minute"),
          time_zone: String(head.time_zone),
        });
        const next = nextOccurrence(schedule, now.getTime());
        nextKey = next.occurrence_key;
        nextUtc = next.utc_at;
      }
      const cas = paused
        ? transaction.run(
            `UPDATE brief_recipes SET state='paused',paused_reason=?,updated_at=?
             WHERE id=? AND account_id=? AND state='active'`,
            [boundedReason ?? "paused manually", now.toISOString(), recipeId, accountId]
          )
        : transaction.run(
            `UPDATE brief_recipes SET state='active',paused_reason=NULL,next_occurrence_key=?,next_run_at=?,updated_at=?
             WHERE id=? AND account_id=? AND state='paused'`,
            [nextKey, nextUtc, now.toISOString(), recipeId, accountId]
          );
      if (cas.changes !== 1) {
        const exists = transaction.get("SELECT 1 FROM brief_recipes WHERE id=? AND account_id=?", [
          recipeId,
          accountId,
        ]);
        if (!exists) throw new BriefRecipeNotFoundError();
        // Already in the requested state: idempotent no-op for the route layer.
        return;
      }
    });
    const recipe = await this.getRecipe(accountId, recipeId);
    if (!recipe) throw new BriefRecipeNotFoundError();
    return recipe;
  }

  /**
   * Per-recipe notification toggle (M16 step 8). Head-only: it appends no
   * revision, changes no frozen content, and reschedules nothing. Suppression
   * happens in `briefRunStore` at notification-record time; the automatic
   * five-failure pause transition is unaffected (pausing is state, not a
   * notification).
   */
  async setNotificationsEnabled(
    accountIdValue: string,
    recipeIdValue: string,
    enabled: boolean
  ): Promise<StoredBriefRecipe> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const recipeId = uuidIdentity(recipeIdValue, "recipe id");
    const updated = await this.ledger.run(
      "UPDATE brief_recipes SET notifications_enabled=?,updated_at=? WHERE id=? AND account_id=?",
      [enabled ? 1 : 0, this.now().toISOString(), recipeId, accountId]
    );
    if (updated.changes !== 1) {
      const exists = await this.ledger.get("SELECT 1 FROM brief_recipes WHERE id=? AND account_id=?", [
        recipeId,
        accountId,
      ]);
      if (!exists) throw new BriefRecipeNotFoundError();
    }
    const recipe = await this.getRecipe(accountId, recipeId);
    if (!recipe) throw new BriefRecipeNotFoundError();
    return recipe;
  }

  async deleteRecipe(accountIdValue: string, recipeIdValue: string): Promise<boolean> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const recipeId = uuidIdentity(recipeIdValue, "recipe id");
    const deleted = await this.ledger.run("DELETE FROM brief_recipes WHERE id=? AND account_id=?", [
      recipeId,
      accountId,
    ]);
    return deleted.changes === 1;
  }

  // -- Reads -----------------------------------------------------------------

  async getRecipe(accountIdValue: string, recipeIdValue: string): Promise<StoredBriefRecipe | undefined> {
    const row = await this.ledger.get<RecipeRow>(
      `SELECT head.*, rev.analysis_id AS rev_analysis_id, rev.analysis_revision AS rev_analysis_revision
       FROM brief_recipes head
       JOIN brief_recipe_revisions rev
         ON rev.recipe_id=head.id AND rev.revision=head.revision AND rev.account_id=head.account_id
       WHERE head.id=? AND head.account_id=?`,
      [uuidIdentity(recipeIdValue, "recipe id"), uuidIdentity(accountIdValue, "account id")]
    );
    return row ? this.decode(row) : undefined;
  }

  async listRecipes(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<StoredBriefRecipe>> {
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [uuidIdentity(accountIdValue, "account id")];
    const after = page.after ? " AND (head.created_at,head.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<RecipeRow>(
      `SELECT head.*, rev.analysis_id AS rev_analysis_id, rev.analysis_revision AS rev_analysis_revision
       FROM brief_recipes head
       JOIN brief_recipe_revisions rev
         ON rev.recipe_id=head.id AND rev.revision=head.revision AND rev.account_id=head.account_id
       WHERE head.account_id=?${after}
       ORDER BY head.created_at DESC,head.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => this.decode(row)),
      page,
      (recipe) => ({ timestamp: recipe.createdAt, id: recipe.id })
    );
  }

  decode(row: RecipeRow): StoredBriefRecipe {
    return Object.freeze({
      id: String(row.id),
      accountId: String(row.account_id),
      kind: "reviewed_brief",
      revision: decodeSafeInteger(row.revision, "recipe revision"),
      state: row.state === "paused" ? "paused" : "active",
      pausedReason: row.paused_reason == null ? null : String(row.paused_reason),
      notificationsEnabled: decodeSafeInteger(row.notifications_enabled ?? 1, "notifications enabled") !== 0,
      consecutiveFailures: decodeSafeInteger(row.consecutive_failures ?? 0, "consecutive failures"),
      lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
      nextRunAt: String(row.next_run_at),
      nextOccurrenceKey: String(row.next_occurrence_key),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      content: Object.freeze({
        name: String(row.name),
        analysis_id: String(row.rev_analysis_id ?? row.analysis_id),
        analysis_revision: decodeSafeInteger(row.rev_analysis_revision ?? row.analysis_revision, "analysis revision"),
        parameter_values: decodeBriefParameterBindings(row.parameter_values, "recipe parameter values"),
        report_title: String(row.report_title),
        report_instruction: String(row.report_instruction),
        source_ids: decodeStringArray(row.source_ids, "recipe source ids"),
        refresh_bindings: decodeRefreshBindings(row.refresh_bindings, "recipe refresh bindings"),
        schedule: normalizeCalendarSchedule({
          kind: row.schedule_kind,
          weekday: row.weekday == null ? undefined : decodeSafeInteger(row.weekday, "weekday"),
          day_of_month: row.day_of_month == null ? undefined : decodeSafeInteger(row.day_of_month, "day_of_month"),
          hour: decodeSafeInteger(row.hour, "hour"),
          minute: decodeSafeInteger(row.minute, "minute"),
          time_zone: String(row.time_zone),
        }),
      }),
    });
  }
}

function toValueMap(bindings: readonly AnalysisParameterBinding[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const binding of bindings) values[binding.name] = binding.value;
  return values;
}

function toScheduleInput(schedule: CalendarSchedule): Record<string, unknown> {
  return {
    kind: schedule.kind,
    ...(schedule.weekday === null ? {} : { weekday: schedule.weekday }),
    ...(schedule.day_of_month === null ? {} : { day_of_month: schedule.day_of_month }),
    hour: schedule.hour,
    minute: schedule.minute,
    time_zone: schedule.time_zone,
  };
}
