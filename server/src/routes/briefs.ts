import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import {
  CatalogCursorError,
  catalogPageQuerySchema,
  catalogResponse,
  decodeCatalogCursor,
  encodeCatalogCursor,
  parseCatalogPageQuery,
  type CatalogEndpoint,
  type CatalogPageRequest,
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
  BRIEF_PAGE_DEFAULT_LIMIT,
  BRIEF_PAGE_MAX_LIMIT,
  BriefReviewRevisionConflictError,
  BriefRunNotFoundError,
  BriefRunStateError,
  type StoredBriefNotification,
  type StoredBriefReviewRow,
  type StoredBriefRun,
} from "../db/stores/briefRunStore.js";
import { requestBriefReviewDecision } from "../briefReviewService.js";
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
 * Reviewed-brief API (M16 stage 1: store/calendar/recipe CRUD; stage 2: the
 * execution pipeline wakes manual runs and exposes bounded run detail and
 * idempotent cancellation; stage 3: the account-scoped review inbox, the
 * exact-revision decision with durable publication-intent approval, and the
 * local notification read/dismiss surfaces).
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

const NOTIFICATIONS_BODY_SCHEMA = {
  type: "object",
  required: ["enabled"],
  additionalProperties: false,
  properties: { enabled: { type: "boolean" } },
} as const;

/** Review inbox / notification pages: default 20, maximum 50 (M16 bounds). */
const BRIEF_PAGE_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: BRIEF_PAGE_MAX_LIMIT },
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^[A-Za-z0-9_-]+$",
    },
  },
} as const;

const REVIEW_DECISION_BODY_SCHEMA = {
  type: "object",
  required: ["decision", "document_revision_id"],
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    document_revision_id: { type: "string", pattern: UUID_PATTERN },
    note: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} as const;

const NOTIFICATION_PATCH_BODY_SCHEMA = {
  type: "object",
  required: ["state"],
  additionalProperties: false,
  properties: { state: { type: "string", enum: ["read", "dismissed"] } },
} as const;

/** Content-free generic text paired with the failed-publication indicator. */
const BRIEF_PUBLICATION_FAILURE_MESSAGE =
  "the draft could not be rendered for publication; review the current revision again to retry publication";

function parseBriefPageQuery(endpoint: CatalogEndpoint, value: unknown): CatalogPageRequest {
  const query = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const limit = query.limit === undefined ? BRIEF_PAGE_DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > BRIEF_PAGE_MAX_LIMIT) {
    throw new CatalogCursorError();
  }
  if (query.cursor === undefined) return { limit: Number(limit), after: null };
  if (typeof query.cursor !== "string") throw new CatalogCursorError();
  return { limit: Number(limit), after: decodeCatalogCursor(endpoint, query.cursor) };
}

function briefPageResponse<T>(
  endpoint: CatalogEndpoint,
  page: { items: T[]; next: { timestamp: string; id: string } | null }
) {
  return {
    items: page.items,
    next_cursor: page.next === null ? null : encodeCatalogCursor(endpoint, page.next),
  };
}

function publicBriefNotification(notification: StoredBriefNotification) {
  return {
    id: notification.id,
    kind: notification.kind,
    state: notification.state,
    detail: notification.detail,
    recipe_id: notification.recipeId,
    run_id: notification.runId,
    created_at: notification.createdAt,
    updated_at: notification.updatedAt,
    read_at: notification.readAt,
  };
}

function publicBriefReview(review: StoredBriefReviewRow) {
  const run = review.run;
  return {
    id: run.id,
    recipe_id: run.recipeId,
    recipe_name: run.recipeSnapshot.name,
    recipe_revision: run.recipeRevision,
    // Deleted recipes read back as null state: run history and review stay
    // readable through the retained run snapshot.
    recipe_state: review.recipeState,
    recipe_paused_reason: review.recipePausedReason,
    trigger: run.trigger,
    occurrence_key: run.occurrenceKey,
    coalesced_count: run.coalescedCount,
    missed_through_key: run.missedThroughKey,
    stage: run.stage,
    created_at: run.createdAt,
    stage_updated_at: run.stageUpdatedAt,
    finished_at: run.finishedAt,
    // Current/baseline comparison and freshness (receipts are the durable
    // refresh labels/generations committed by the runner).
    analysis_run_id: run.analysisRunId,
    baseline_run_id: run.baselineRunId,
    comparison_summary: run.comparisonSummary,
    refresh_receipts: run.refreshReceipts,
    // Rendered-draft pointer: the draft revision reviewed plus the live head.
    document_id: run.documentId,
    document_revision_id: run.documentRevisionId,
    document_head_revision_id: review.headRevisionId,
    head_moved:
      review.headRevisionId !== null &&
      run.documentRevisionId !== null &&
      review.headRevisionId !== run.documentRevisionId,
    // Decision state: durable ledger tail plus publication progress.
    reviewed_revision_id: run.reviewedRevisionId,
    publication_operation_id: run.publicationOperationId,
    publication_error_code: run.publicationErrorCode,
    publication_failure:
      run.publicationErrorCode === null
        ? null
        : { code: run.publicationErrorCode, message: BRIEF_PUBLICATION_FAILURE_MESSAGE },
    review:
      review.lastEvent === null
        ? null
        : {
            decision: review.lastEvent.decision,
            note: review.lastEvent.note,
            document_revision_id: review.lastEvent.documentRevisionId,
            created_at: review.lastEvent.createdAt,
          },
  };
}

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
    notifications_enabled: recipe.notificationsEnabled,
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
    publication_operation_id: run.publicationOperationId,
    publication_error_code: run.publicationErrorCode,
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
    error instanceof BriefRunStateError ||
    error instanceof BriefReviewRevisionConflictError
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

  // Per-recipe local-notification preference (M16 step 8). Head-only state:
  // not a content revision, no reschedule; suppression covers every future
  // notification kind, while the automatic five-failure pause still happens.
  app.patch(
    "/api/briefs/:id/notifications",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: NOTIFICATIONS_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const body = req.body as { enabled: boolean };
        const recipe = await storageRuntime().briefRecipes.setNotificationsEnabled(
          getAccountId(req),
          (req.params as { id: string }).id,
          body.enabled === true
        );
        return reply.send(publicBriefRecipe(recipe));
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

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

  // ---------------------------------------------------------------------------
  // Review inbox + decisions + notifications (M16 stage 3).
  // ---------------------------------------------------------------------------

  // Account-scoped pending/reviewed inbox: current/baseline comparison
  // summaries, freshness receipts, recipe revision, evidence/draft
  // references, the rendered-draft pointer (document id + revision + live
  // head), decision state, and the failed-publication indicator. Endpoint-
  // bound keyset pagination (default 20, maximum 50). Deleted recipes stay
  // readable through the retained run snapshot.
  app.get(
    "/api/brief-reviews",
    { onRequest: requireAuth, schema: { querystring: BRIEF_PAGE_QUERY_SCHEMA } },
    async (req, reply) => {
      try {
        const page = await storageRuntime().briefRuns.listReviewInbox(
          getAccountId(req),
          parseBriefPageQuery("brief_reviews", req.query)
        );
        return reply.send(
          briefPageResponse("brief_reviews", { items: page.items.map(publicBriefReview), next: page.next })
        );
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  // Exact-revision review decision. Approval: head-revision CAS + the stable
  // publication operation UUID persisted durably first (retries reconcile
  // the same intent and can never create a second publication), then the
  // real M13 publish service renders — 202 with `publishing` while rendering,
  // status via the run-detail/inbox routes, `approved` only after the
  // publication commits; render failure returns the run to `awaiting_review`
  // with the indicator. Reject is terminal, preserves run+draft, and can
  // never publish; reject during an accepted approval answers 409. A
  // concurrent edit before the decision answers 409
  // BRIEF_REVIEW_REVISION_CONFLICT — unseen content is never approved. A
  // repeat decision returns the recorded outcome.
  app.post(
    "/api/brief-reviews/:id/decision",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: REVIEW_DECISION_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const body = req.body as { decision: "approve" | "reject"; document_revision_id: string; note?: string };
        const result = await requestBriefReviewDecision(getAccountId(req), (req.params as { id: string }).id, {
          decision: body.decision,
          documentRevisionId: body.document_revision_id,
          note: body.note ?? null,
        });
        return reply.code(result.status === "publishing" ? 202 : 200).send({
          status: result.status,
          replayed: result.replayed,
          status_path: `/api/briefs/${result.run.recipeId}/runs/${result.run.id}`,
          run: publicBriefRunSummary(result.run),
        });
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  // Local in-app notification inbox: durable read/dismiss state, content
  // immutable. Every ready draft is also discoverable through the review
  // inbox; notifications are deduplicated per (run, kind) at write and never
  // delivered anywhere outbound. Keyset default 20, maximum 50.
  app.get(
    "/api/notifications",
    { onRequest: requireAuth, schema: { querystring: BRIEF_PAGE_QUERY_SCHEMA } },
    async (req, reply) => {
      try {
        const page = await storageRuntime().briefRuns.listNotifications(
          getAccountId(req),
          parseBriefPageQuery("brief_notifications", req.query)
        );
        return reply.send(
          briefPageResponse("brief_notifications", {
            items: page.items.map(publicBriefNotification),
            next: page.next,
          })
        );
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );

  // Durable read/dismiss transition only; the event content (kind/detail)
  // cannot be modified. Cross-account or unknown ids answer 404.
  app.patch(
    "/api/notifications/:id",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: NOTIFICATION_PATCH_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const id = (req.params as { id: string }).id;
        const body = req.body as { state: "read" | "dismissed" };
        const updated = await storageRuntime().briefRuns.setNotificationState(accountId, id, body.state);
        if (!updated) return reply.code(404).send({ error: "not found", code: "BRIEF_NOTIFICATION_NOT_FOUND" });
        const notification = await storageRuntime().briefRuns.getNotification(accountId, id);
        if (!notification) return reply.code(404).send({ error: "not found", code: "BRIEF_NOTIFICATION_NOT_FOUND" });
        return reply.send(publicBriefNotification(notification));
      } catch (error) {
        if (sendBriefError(reply, error)) return;
        throw error;
      }
    }
  );
}
