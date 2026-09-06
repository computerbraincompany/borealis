import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import {
  CatalogCursorError,
  catalogPageQuerySchema,
  catalogResponse,
  parseCatalogPageQuery,
} from "../catalogPagination.js";
import { idParamsSchema, UUID_PATTERN } from "./schemas.js";
import {
  BriefRecipeNotFoundError,
  BriefRevisionConflictError,
  BriefValidationError,
  type StoredBriefRecipe,
} from "../db/stores/briefRecipeStore.js";
import {
  BriefActiveRunError,
  BriefRunNotFoundError,
  BriefRunStateError,
  type StoredBriefRun,
} from "../db/stores/briefRunStore.js";
import { nextOccurrences, CALENDAR_MAX_PREVIEW } from "../calendarSchedule.js";
import { defaultBriefRunner } from "../briefRunner.js";
import { enforceRemoteEgressConsent } from "../egressPolicy.js";
import { storageRuntime } from "../storageRuntime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  BRIEF_RECIPE_JSON_BODY_LIMIT_BYTES,
  COMPACT_JSON_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";

/**
 * Reviewed-brief recipe API (M16 stage 1: store/calendar/recipe CRUD; stage 2:
 * the execution pipeline wakes manual runs and exposes bounded run detail and
 * idempotent cancellation). The review inbox, decision, and notification
 * routes arrive with stage 3.
 */

const SCHEDULE_BODY_SCHEMA = {
  type: "object",
  required: ["kind", "hour", "minute", "time_zone"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["daily", "weekly", "monthly"] },
    weekday: { type: "integer", minimum: 0, maximum: 6 },
    day_of_month: { type: "integer", minimum: 1, maximum: 28 },
    hour: { type: "integer", minimum: 0, maximum: 23 },
    minute: { type: "integer", minimum: 0, maximum: 59 },
    time_zone: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

const REFRESH_BINDING_SCHEMA = {
  type: "object",
  required: ["source_id", "kind"],
  additionalProperties: false,
  properties: {
    source_id: { type: "string", pattern: UUID_PATTERN },
    kind: { type: "string", enum: ["connector", "knowledge"] },
    connector_id: { type: "string", pattern: UUID_PATTERN },
    connection_id: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const RECIPE_CREATE_BODY_SCHEMA = {
  type: "object",
  required: ["name", "analysis_id", "report_title", "report_instruction", "source_ids", "schedule"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    analysis_id: { type: "string", pattern: UUID_PATTERN },
    parameter_values: {
      type: "object",
      maxProperties: 20,
      additionalProperties: { type: ["string", "number", "boolean", "null"] },
    },
    report_title: { type: "string", minLength: 1, maxLength: 200 },
    report_instruction: { type: "string", minLength: 1, maxLength: 8_000 },
    source_ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", pattern: UUID_PATTERN } },
    refresh_bindings: { type: "array", maxItems: 100, items: REFRESH_BINDING_SCHEMA },
    schedule: SCHEDULE_BODY_SCHEMA,
  },
} as const;

const RECIPE_PATCH_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["expected_revision"],
  minProperties: 2,
  additionalProperties: false,
  properties: {
    expected_revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    name: { type: "string", minLength: 1, maxLength: 80 },
    analysis_id: { type: "string", pattern: UUID_PATTERN },
    parameter_values: {
      type: "object",
      maxProperties: 20,
      additionalProperties: { type: ["string", "number", "boolean", "null"] },
    },
    report_title: { type: "string", minLength: 1, maxLength: 200 },
    report_instruction: { type: "string", minLength: 1, maxLength: 8_000 },
    source_ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", pattern: UUID_PATTERN } },
    refresh_bindings: { type: "array", maxItems: 100, items: REFRESH_BINDING_SCHEMA },
    schedule: SCHEDULE_BODY_SCHEMA,
  },
};

const RUN_CREATE_BODY_SCHEMA = {
  type: "object",
  required: ["operation_id"],
  additionalProperties: false,
  properties: { operation_id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const RUN_PARAMS_SCHEMA = {
  type: "object",
  required: ["id", "runId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    runId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

function publicBriefRecipe(recipe: StoredBriefRecipe) {
  return {
    id: recipe.id,
    kind: recipe.kind,
    name: recipe.content.name,
    revision: recipe.revision,
    state: recipe.state,
    paused_reason: recipe.pausedReason,
    consecutive_failures: recipe.consecutiveFailures,
    analysis_id: recipe.content.analysis_id,
    analysis_revision: recipe.content.analysis_revision,
    parameter_values: recipe.content.parameter_values,
    report_title: recipe.content.report_title,
    report_instruction: recipe.content.report_instruction,
    source_ids: recipe.content.source_ids,
    refresh_bindings: recipe.content.refresh_bindings,
    schedule: {
      kind: recipe.content.schedule.kind,
      weekday: recipe.content.schedule.weekday,
      day_of_month: recipe.content.schedule.day_of_month,
      hour: recipe.content.schedule.hour,
      minute: recipe.content.schedule.minute,
      time_zone: recipe.content.schedule.time_zone,
    },
    next_occurrence_key: recipe.nextOccurrenceKey,
    next_run_at: recipe.nextRunAt,
    last_run_at: recipe.lastRunAt,
    created_at: recipe.createdAt,
    updated_at: recipe.updatedAt,
  };
}

function publicBriefRunSummary(run: StoredBriefRun) {
  return {
    id: run.id,
    recipe_id: run.recipeId,
    trigger: run.trigger,
    operation_id: run.operationId,
    occurrence_key: run.occurrenceKey,
    recipe_revision: run.recipeRevision,
    stage: run.stage,
    stage_attempts: run.stageAttempts,
    cancel_requested: run.cancelRequested,
    deadline_at: run.deadlineAt,
    refresh_deadline_at: run.refreshDeadlineAt,
    coalesced_count: run.coalescedCount,
    missed_through_key: run.missedThroughKey,
    analysis_run_id: run.analysisRunId,
    baseline_run_id: run.baselineRunId,
    analysis_succeeded: run.analysisSucceeded,
    document_id: run.documentId,
    document_revision_id: run.documentRevisionId,
    reviewed_revision_id: run.reviewedRevisionId,
    failure_code: run.failureCode,
    failure_reason: run.failureReason,
    created_at: run.createdAt,
    started_at: run.startedAt,
    stage_updated_at: run.stageUpdatedAt,
    finished_at: run.finishedAt,
  };
}

/**
 * Bounded stage detail for one run: the durable summary plus the server-owned
 * refresh receipts (kind/label/generation — codes and bounded labels only),
 * the committed source-generation snapshot, and the persisted comparison
 * summary (already bounded ≤32 KiB at write). Linked artifact identities are
 * part of the base summary (analysis/baseline/document ids).
 */
function publicBriefRunDetail(run: StoredBriefRun) {
  return {
    ...publicBriefRunSummary(run),
    refresh_receipts: run.refreshReceipts,
    source_snapshot: run.sourceSnapshot,
    comparison_summary: run.comparisonSummary,
  };
}

function sendBriefError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof CatalogCursorError || error instanceof BriefValidationError) {
    reply.code(400).send({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof BriefRecipeNotFoundError || error instanceof BriefRunNotFoundError) {
    reply.code(404).send({ error: "not found", code: error.code });
    return true;
  }
  if (
    error instanceof BriefRevisionConflictError ||
    error instanceof BriefActiveRunError ||
    error instanceof BriefRunStateError
  ) {
    reply.code(409).send({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

function schedulePreviews(recipe: StoredBriefRecipe) {
  try {
    return nextOccurrences(recipe.content.schedule, Date.now(), CALENDAR_MAX_PREVIEW);
  } catch {
    // A schedule with no upcoming occurrence (only possible for corrupt
    // durable state — writes always validate) degrades to an empty preview.
    return [];
  }
}

export async function briefRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/briefs",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      try {
        const page = await storageRuntime().briefRecipes.listRecipes(
          getAccountId(req),
          parseCatalogPageQuery("brief_recipes", req.query)
        );
        return reply.send(
          catalogResponse("brief_recipes", { items: page.items.map(publicBriefRecipe), next: page.next })
        );
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/briefs",
    {
      onRequest: requireAuth,
      bodyLimit: BRIEF_RECIPE_JSON_BODY_LIMIT_BYTES,
      schema: { body: RECIPE_CREATE_BODY_SCHEMA },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      try {
        const body = req.body as Record<string, unknown>;
        // A brief with refresh bindings performs payload-bearing scheduled
        // remote refreshes; creation gates on consent exactly like a
        // connector_sync automation. Refresh-less briefs recheck at execution.
        const refreshBindings = Array.isArray(body.refresh_bindings) ? (body.refresh_bindings as unknown[]) : [];
        if (refreshBindings.length > 0) {
          if (!(await enforceRemoteEgressConsent(reply, accountId))) return;
        }
        const recipe = await storageRuntime().briefRecipes.createRecipe(accountId, {
          name: body.name,
          analysis_id: body.analysis_id,
          parameter_values: body.parameter_values,
          report_title: body.report_title,
          report_instruction: body.report_instruction,
          source_ids: body.source_ids,
          refresh_bindings: body.refresh_bindings,
          schedule: body.schedule,
        });
        return reply.code(201).send(publicBriefRecipe(recipe));
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  // Detail carries the next three civil + UTC run times so the editor can
  // confirm the resolved calendar (DST-shifted instants included) before save.
  app.get("/api/briefs/:id", { onRequest: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    try {
      const recipe = await storageRuntime().briefRecipes.getRecipe(
        getAccountId(req),
        (req.params as { id: string }).id
      );
      if (!recipe) return reply.code(404).send({ error: "not found", code: "BRIEF_RECIPE_NOT_FOUND" });
      return reply.send({ ...publicBriefRecipe(recipe), next_occurrences: schedulePreviews(recipe) });
    } catch (error) {
      if (sendBriefError(reply, error)) return;
      throw error;
    }
  });

  app.patch(
    "/api/briefs/:id",
    {
      onRequest: requireAuth,
      bodyLimit: BRIEF_RECIPE_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: RECIPE_PATCH_BODY_SCHEMA },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      try {
        const body = req.body as Record<string, unknown>;
        const id = (req.params as { id: string }).id;
        const existing = await storageRuntime().briefRecipes.getRecipe(accountId, id);
        if (!existing) return reply.code(404).send({ error: "not found", code: "BRIEF_RECIPE_NOT_FOUND" });
        if (body.refresh_bindings !== undefined || existing.content.refresh_bindings.length > 0) {
          if (!(await enforceRemoteEgressConsent(reply, accountId))) return;
        }
        const recipe = await storageRuntime().briefRecipes.updateRecipe(
          accountId,
          id,
          body.expected_revision as number,
          {
            name: body.name,
            analysis_id: body.analysis_id,
            parameter_values: body.parameter_values,
            report_title: body.report_title,
            report_instruction: body.report_instruction,
            source_ids: body.source_ids,
            refresh_bindings: body.refresh_bindings,
            schedule: body.schedule,
          }
        );
        return reply.send(publicBriefRecipe(recipe));
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  for (const action of ["pause", "resume"] as const) {
    app.post(
      `/api/briefs/:id/${action}`,
      { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
      async (req, reply) => {
        try {
          const recipe = await storageRuntime().briefRecipes.setRecipePaused(
            getAccountId(req),
            (req.params as { id: string }).id,
            action === "pause"
          );
          return reply.send(publicBriefRecipe(recipe));
        } catch (error) {
          if (sendBriefError(reply, error)) return;
          throw error;
        }
      }
    );
  }

  app.delete(
    "/api/briefs/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        const deleted = await storageRuntime().briefRecipes.deleteRecipe(
          getAccountId(req),
          (req.params as { id: string }).id
        );
        if (!deleted) return reply.code(404).send({ error: "not found", code: "BRIEF_RECIPE_NOT_FOUND" });
        return reply.send({ ok: true });
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  // Manual "Run now": 202 with the durable run identity. The operation id is
  // the idempotency key — a retried request replays the original run. The
  // owned brief runner executes the durable row through the same pipeline as
  // scheduled claims; without a live executor the row simply waits.
  app.post(
    "/api/briefs/:id/runs",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: RUN_CREATE_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const body = req.body as { operation_id: string };
        const { run, replayed } = await storageRuntime().briefRuns.createManualRun(
          getAccountId(req),
          (req.params as { id: string }).id,
          body.operation_id
        );
        // The durable 202 is the contract; when an executor is live this wake
        // only shortens the queue delay — the row is the fallback.
        defaultBriefRunner()?.kick();
        return reply.code(202).send({ run: publicBriefRunSummary(run), replayed });
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  // Run detail: bounded stage detail, refresh receipts, the committed
  // generation snapshot, the comparison summary, and linked artifact ids.
  app.get(
    "/api/briefs/:id/runs/:runId",
    { onRequest: requireAuth, schema: { params: RUN_PARAMS_SCHEMA } },
    async (req, reply) => {
      try {
        const { id, runId } = req.params as { id: string; runId: string };
        const run = await storageRuntime().briefRuns.getRun(getAccountId(req), runId);
        if (run.recipeId !== id) return reply.code(404).send({ error: "not found", code: "BRIEF_RUN_NOT_FOUND" });
        return reply.send(publicBriefRunDetail(run));
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  // Cancellation request: durable and idempotent. Repeated calls — including
  // after the run finalized — return the current run; artifacts-to-date and
  // committed review artifacts are preserved by the runner's stage rules.
  app.delete(
    "/api/briefs/:id/runs/:runId",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: RUN_PARAMS_SCHEMA } },
    async (req, reply) => {
      try {
        const { id, runId } = req.params as { id: string; runId: string };
        const { run, cancelRequested } = await storageRuntime().briefRuns.requestRunCancel(getAccountId(req), runId);
        if (run.recipeId !== id) return reply.code(404).send({ error: "not found", code: "BRIEF_RUN_NOT_FOUND" });
        return reply.send({ ...publicBriefRunDetail(run), cancel_requested: cancelRequested });
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/briefs/:id/runs",
    {
      onRequest: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: catalogPageQuerySchema,
      },
    },
    async (req, reply) => {
      try {
        const page = await storageRuntime().briefRuns.listRuns(
          getAccountId(req),
          (req.params as { id: string }).id,
          parseCatalogPageQuery("brief_runs", req.query)
        );
        return reply.send(
          catalogResponse("brief_runs", { items: page.items.map(publicBriefRunSummary), next: page.next })
        );
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );
}
