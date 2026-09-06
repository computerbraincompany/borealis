/**
 * Saved-analysis resource routes (M12 stage 3).
 *
 * Owner-scoped definitions with optimistic revisions, durable run acceptance
 * through the registered analysis execution service (202 + operation-UUID
 * replay), immutable result catalogs, deterministic comparison, stored-
 * snapshot export, and a canonical chart-spec copy bound to a result.
 *
 * All routes authenticate in `onRequest` before body parsing and carry
 * schema-derived body ceilings. Stable error codes: ANALYSIS_VALIDATION,
 * ANALYSIS_NOT_FOUND, ANALYSIS_RUN_NOT_FOUND, ANALYSIS_REVISION_CONFLICT,
 * ANALYSIS_ACTIVE_RUN, ANALYSIS_RESULT_QUOTA_EXCEEDED, ANALYSIS_RUN_STATE,
 * ANALYSIS_INPUTS_UNAVAILABLE, ANALYSIS_SERVICE_UNAVAILABLE,
 * ANALYSIS_RESULT_NOT_CHARTABLE, INVALID_CATALOG_CURSOR.
 *
 * Chart-creation design choice: the canonical chart machinery persists chart
 * rows through the chat-run artifact lifecycle (`runStore.insertPendingChart`
 * requires an active run), and stage 3 adds no migrations. So a chart "from a
 * result" is a canonical `data/charts.ts` spec COPY computed deterministically
 * from the immutable stored snapshot and bound to the result id (GET
 * `/results/:resultId/chart`), never a re-query and never a row in the chat-
 * run artifact tables.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import {
  catalogPageQuerySchema,
  catalogResponse,
  parseCatalogPageQuery,
  CatalogCursorError,
} from "../catalogPagination.js";
import { idParamsSchema, UUID_PATTERN } from "./schemas.js";
import {
  ANALYSIS_COMPARISON_KEY_MAX_COLUMNS,
  ANALYSIS_DESCRIPTION_MAX_CHARS,
  ANALYSIS_LABEL_MAX_CHARS,
  ANALYSIS_PARAMETER_MAX_COUNT,
  ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS,
  ANALYSIS_SQL_MAX_CHARS,
  ANALYSIS_TITLE_MAX_CHARS,
  type StoredAnalysis,
  type StoredAnalysisResult,
  type StoredAnalysisRun,
} from "../analysisTypes.js";
import {
  AnalysisNotFoundError,
  AnalysisStoreError,
  type AnalysisRunSummary,
  type AnalysisResultSummary,
} from "../db/stores/analysisStore.js";
import { AnalysisServiceUnavailableError, runAnalysisService } from "../analysisRunner.js";
import { AnalysisValidationError } from "../analysisTypes.js";
import {
  buildResultChartSpec,
  compareAnalysisResults,
  exportAnalysisResult,
  ResultChartError,
  type AnalysisExportFormat,
} from "../analysisCompare.js";
import { ChartSpecError } from "../data/charts.js";
import { storageRuntime } from "../storageRuntime.js";
import {
  ANALYSIS_DEFINITION_JSON_BODY_LIMIT_BYTES,
  ANALYSIS_PROMOTION_JSON_BODY_LIMIT_BYTES,
  ANALYSIS_RUN_JSON_BODY_LIMIT_BYTES,
  BODYLESS_MUTATION_LIMIT_BYTES,
} from "./bodyLimits.js";

const RUN_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "runId"],
  properties: { id: { type: "string", pattern: UUID_PATTERN }, runId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const RESULT_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "resultId"],
  properties: { id: { type: "string", pattern: UUID_PATTERN }, resultId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const PARAMETER_DECLARATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
    type: { type: "string", enum: ["string", "number", "integer", "boolean", "date"] },
    required: { type: "boolean" },
    nullable: { type: "boolean" },
    default: { type: ["string", "number", "boolean", "null"] },
    label: { type: "string", minLength: 1, maxLength: ANALYSIS_LABEL_MAX_CHARS },
    description: { type: "string", maxLength: ANALYSIS_DESCRIPTION_MAX_CHARS },
  },
} as const;

const DEFINITION_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "sql"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: ANALYSIS_TITLE_MAX_CHARS },
    description: { type: "string", maxLength: ANALYSIS_DESCRIPTION_MAX_CHARS },
    sql: { type: "string", minLength: 1, maxLength: ANALYSIS_SQL_MAX_CHARS },
    parameters: {
      type: "array",
      maxItems: ANALYSIS_PARAMETER_MAX_COUNT,
      items: PARAMETER_DECLARATION_SCHEMA,
    },
    source_ids: {
      type: "array",
      maxItems: 100,
      items: { type: "string", pattern: UUID_PATTERN },
    },
    comparison_key: {
      type: ["array", "null"],
      minItems: 1,
      maxItems: ANALYSIS_COMPARISON_KEY_MAX_COLUMNS,
      items: { type: "string", minLength: 1, maxLength: ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS },
    },
  },
} as const;

function publicAnalysisSource(binding: StoredAnalysis["sources"][number]) {
  return {
    source_id: binding.sourceId,
    ready_generation: binding.readyGeneration,
    content_identity: binding.contentIdentity,
    unavailable_at: binding.unavailableAt,
    bound_at: binding.boundAt,
  };
}

function publicAnalysis(analysis: StoredAnalysis) {
  return {
    id: analysis.id,
    current_revision: analysis.currentRevision,
    title: analysis.revision.title,
    description: analysis.revision.description,
    sql: analysis.revision.sql,
    parameters: analysis.revision.parameters,
    source_ids: analysis.revision.sourceIds,
    comparison_key: analysis.revision.comparisonKey,
    origin: {
      chat_id: analysis.revision.originChatId,
      run_id: analysis.revision.originRunId,
      capture_id: analysis.revision.originCaptureId,
    },
    revision_created_at: analysis.revision.createdAt,
    sources: analysis.sources.map(publicAnalysisSource),
    created_at: analysis.createdAt,
    updated_at: analysis.updatedAt,
  };
}

function publicRunSummary(run: AnalysisRunSummary) {
  return {
    id: run.id,
    analysis_id: run.analysisId,
    revision: run.revision,
    status: run.status,
    cancel_requested: run.cancelRequested,
    operation_id: run.operationId,
    schema_fingerprint: run.schemaFingerprint,
    error_code: run.errorCode,
    error_reason: run.errorReason,
    created_at: run.createdAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };
}

function publicRun(run: StoredAnalysisRun) {
  return {
    ...publicRunSummary(run),
    parameter_values: run.parameterBindings,
    sources: run.sources.map((source) => ({
      source_id: source.sourceId,
      ready_generation: source.readyGeneration,
      content_identity: source.contentIdentity,
    })),
  };
}

function publicResultSummary(result: AnalysisResultSummary) {
  return {
    id: result.id,
    run_id: result.runId,
    revision: result.revision,
    returned_rows: result.returnedRows,
    source_row_total: result.sourceRowTotal,
    row_count_exact: result.rowCountExact,
    complete: result.complete,
    completeness_reasons: result.completenessReasons,
    schema_fingerprint: result.schemaFingerprint,
    created_at: result.createdAt,
  };
}

function publicResultDetail(result: StoredAnalysisResult) {
  return {
    id: result.id,
    analysis_id: result.analysisId,
    run_id: result.runId,
    revision: result.revision,
    columns: result.columns,
    rows: result.rows,
    returned_rows: result.returnedRows,
    source_row_total: result.sourceRowTotal,
    row_count_exact: result.rowCountExact,
    completeness: result.completeness,
    parameter_values: result.parameterBindings,
    source_provenance: result.sourceProvenance.map((source) => ({
      source_id: source.sourceId,
      ready_generation: source.readyGeneration,
      content_identity: source.contentIdentity,
    })),
    schema_fingerprint: result.schemaFingerprint,
    created_at: result.createdAt,
  };
}

function sendAnalysisError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof AnalysisValidationError) {
    reply.code(400).send({ error: error.message, code: "ANALYSIS_VALIDATION" });
    return true;
  }
  if (error instanceof CatalogCursorError) {
    reply.code(400).send({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof AnalysisServiceUnavailableError) {
    reply.code(503).send({ error: "the analysis execution service is not available", code: error.code });
    return true;
  }
  if (error instanceof ResultChartError) {
    reply.code(400).send({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof ChartSpecError) {
    reply.code(400).send({ error: "the stored result cannot be charted", code: "ANALYSIS_RESULT_NOT_CHARTABLE" });
    return true;
  }
  if (error instanceof AnalysisStoreError) {
    const notFound = error.code === "ANALYSIS_NOT_FOUND" || error.code === "ANALYSIS_RUN_NOT_FOUND";
    const body = { error: notFound ? "not found" : error.message, code: error.code };
    reply.code(notFound ? 404 : 409).send(body);
    return true;
  }
  return false;
}

const DELETE_DRAIN_ATTEMPTS = 20;
const DELETE_DRAIN_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function analysisRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/analyses",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const page = await storageRuntime().analyses.listAnalyses(
        getAccountId(req),
        parseCatalogPageQuery("analyses", req.query)
      );
      return reply.send(
        catalogResponse("analyses", {
          items: page.items.map((item) => ({
            id: item.id,
            title: item.title,
            description: item.description,
            current_revision: item.currentRevision,
            source_count: item.sourceCount,
            unavailable_source_count: item.unavailableSourceCount,
            created_at: item.createdAt,
            updated_at: item.updatedAt,
          })),
          next: page.next,
        })
      );
    }
  );

  app.post(
    "/api/analyses",
    {
      onRequest: requireAuth,
      bodyLimit: ANALYSIS_DEFINITION_JSON_BODY_LIMIT_BYTES,
      schema: { body: DEFINITION_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          title: string;
          description?: string;
          sql: string;
          parameters?: readonly unknown[];
          source_ids?: readonly string[];
          comparison_key?: readonly string[] | null;
        };
        const analysis = await storageRuntime().analyses.createAnalysis(getAccountId(req), {
          title: body.title,
          description: body.description,
          sql: body.sql,
          parameters: body.parameters,
          sourceIds: body.source_ids,
          comparisonKey: body.comparison_key,
        });
        return reply.code(201).send(publicAnalysis(analysis));
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );

  // Promotion of a VERIFIED full-query capture only. A missing capture row is
  // the authoritative "not promotable" answer: legacy sliced display receipts
  // never have one, and a `truncated: false` display flag is not an
  // authoritative capture contract. Sources come from the capture's exact
  // ready provenance and are never widened.
  app.post(
    "/api/analyses/from-query",
    {
      onRequest: requireAuth,
      bodyLimit: ANALYSIS_PROMOTION_JSON_BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["capture_id", "title"],
          properties: {
            capture_id: { type: "string", pattern: UUID_PATTERN },
            title: { type: "string", minLength: 1, maxLength: ANALYSIS_TITLE_MAX_CHARS },
            description: { type: "string", maxLength: ANALYSIS_DESCRIPTION_MAX_CHARS },
            comparison_key: {
              type: ["array", "null"],
              minItems: 1,
              maxItems: ANALYSIS_COMPARISON_KEY_MAX_COLUMNS,
              items: { type: "string", minLength: 1, maxLength: ANALYSIS_RESULT_COLUMN_NAME_MAX_CHARS },
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const body = req.body as {
          capture_id: string;
          title: string;
          description?: string;
          comparison_key?: readonly string[] | null;
        };
        const capture = await storageRuntime().runs.readQueryCapture(accountId, body.capture_id);
        if (!capture) {
          return reply.code(404).send({
            error: "query capture not found; this receipt predates verified capture and needs the editor",
            code: "ANALYSIS_CAPTURE_NOT_PROMOTABLE",
          });
        }
        try {
          const analysis = await storageRuntime().analyses.createAnalysis(accountId, {
            title: body.title,
            description: body.description,
            sql: capture.sql,
            sourceIds: capture.sources.map((source) => source.source_id),
            comparisonKey: body.comparison_key,
            origin: { runId: capture.runId, captureId: capture.id },
          });
          return reply.code(201).send(publicAnalysis(analysis));
        } catch (error) {
          // A captured source deleted after the turn is an explicit stale-input
          // failure; promotion never drops it and never widens the scope.
          if (error instanceof AnalysisNotFoundError) {
            return reply.code(409).send({
              error: "one or more captured sources are no longer available for this analysis",
              code: "ANALYSIS_INPUTS_UNAVAILABLE",
            });
          }
          throw error;
        }
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get("/api/analyses/:id", { onRequest: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const analysis = await storageRuntime().analyses.getAnalysis(getAccountId(req), (req.params as any).id);
    if (!analysis) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
    return reply.send(publicAnalysis(analysis));
  });

  app.patch(
    "/api/analyses/:id",
    {
      onRequest: requireAuth,
      bodyLimit: ANALYSIS_DEFINITION_JSON_BODY_LIMIT_BYTES,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          required: ["expected_revision"],
          properties: {
            expected_revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            ...DEFINITION_BODY_SCHEMA.properties,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          expected_revision: number;
          title?: string;
          description?: string;
          sql?: string;
          parameters?: readonly unknown[];
          source_ids?: readonly string[];
          comparison_key?: readonly string[] | null;
        };
        const patch: Record<string, unknown> = {};
        if (body.title !== undefined) patch.title = body.title;
        if (body.description !== undefined) patch.description = body.description;
        if (body.sql !== undefined) patch.sql = body.sql;
        if (body.parameters !== undefined) patch.parameters = body.parameters;
        if (body.source_ids !== undefined) patch.sourceIds = body.source_ids;
        if (body.comparison_key !== undefined) patch.comparisonKey = body.comparison_key;
        const analysis = await storageRuntime().analyses.updateAnalysis(
          getAccountId(req),
          (req.params as any).id,
          body.expected_revision,
          patch
        );
        return reply.send(publicAnalysis(analysis));
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/analyses/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const analysisId = (req.params as any).id;
        const store = storageRuntime().analyses;
        try {
          const deleted = await store.deleteAnalysis(accountId, analysisId);
          if (!deleted) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
          return reply.send({ ok: true });
        } catch (error) {
          if (!(error instanceof AnalysisStoreError) || error.code !== "ANALYSIS_ACTIVE_RUN") throw error;
          // Deletion cancels/drains active work first: request durable
          // cancellation of the active run and retry the owned deletion for a
          // bounded drain window. A still-running executor that has not yet
          // observed the request keeps the row intact for a later retry.
          const history = await store.listAnalysisRuns(accountId, analysisId);
          for (const run of history.items) {
            if (run.status === "queued" || run.status === "running") {
              await store.requestAnalysisRunCancel(accountId, analysisId, run.id);
            }
          }
          for (let attempt = 0; attempt < DELETE_DRAIN_ATTEMPTS; attempt += 1) {
            await sleep(DELETE_DRAIN_INTERVAL_MS);
            try {
              const deleted = await store.deleteAnalysis(accountId, analysisId);
              if (deleted) return reply.send({ ok: true });
              return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
            } catch (retryError) {
              if (
                !(retryError instanceof AnalysisStoreError) ||
                retryError.code !== "ANALYSIS_ACTIVE_RUN" ||
                attempt === DELETE_DRAIN_ATTEMPTS - 1
              ) {
                throw retryError;
              }
            }
          }
          throw error;
        }
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );

  // -- Runs -------------------------------------------------------------------

  app.get(
    "/api/analyses/:id/runs",
    {
      onRequest: requireAuth,
      schema: { params: idParamsSchema, querystring: catalogPageQuerySchema },
    },
    async (req, reply) => {
      try {
        const page = await storageRuntime().analyses.listAnalysisRuns(
          getAccountId(req),
          (req.params as any).id,
          parseCatalogPageQuery("analysis_runs", req.query)
        );
        return reply.send(
          catalogResponse("analysis_runs", { items: page.items.map(publicRunSummary), next: page.next })
        );
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/analyses/:id/runs",
    {
      onRequest: requireAuth,
      bodyLimit: ANALYSIS_RUN_JSON_BODY_LIMIT_BYTES,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            values: { type: "object", maxProperties: ANALYSIS_PARAMETER_MAX_COUNT },
            operation_id: { type: "string", pattern: UUID_PATTERN },
            expected_revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = (req.body ?? {}) as {
          values?: Record<string, unknown>;
          operation_id?: string;
          expected_revision?: number;
        };
        const accepted = await runAnalysisService({
          accountId: getAccountId(req),
          analysisId: (req.params as any).id,
          values: body.values,
          operationId: body.operation_id ?? null,
          expectedRevision: body.expected_revision ?? null,
        });
        return reply.code(202).send({ outcome: accepted.outcome, run: publicRun(accepted.run) });
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/analyses/:id/runs/:runId",
    { onRequest: requireAuth, schema: { params: RUN_PARAMS_SCHEMA } },
    async (req, reply) => {
      const params = req.params as { id: string; runId: string };
      const run = await storageRuntime().analyses.getAnalysisRun(getAccountId(req), params.id, params.runId);
      if (!run) return reply.code(404).send({ error: "not found", code: "ANALYSIS_RUN_NOT_FOUND" });
      return reply.send(publicRun(run));
    }
  );

  // Cancellation request is idempotent: terminal states are absorbing and a
  // repeated DELETE returns the same durable status.
  app.delete(
    "/api/analyses/:id/runs/:runId",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: RUN_PARAMS_SCHEMA } },
    async (req, reply) => {
      const params = req.params as { id: string; runId: string };
      const status = await storageRuntime().analyses.requestAnalysisRunCancel(
        getAccountId(req),
        params.id,
        params.runId
      );
      if (status === null) return reply.code(404).send({ error: "not found", code: "ANALYSIS_RUN_NOT_FOUND" });
      return reply.send({ ok: true, status });
    }
  );

  // -- Results ----------------------------------------------------------------

  app.get(
    "/api/analyses/:id/results",
    {
      onRequest: requireAuth,
      schema: { params: idParamsSchema, querystring: catalogPageQuerySchema },
    },
    async (req, reply) => {
      try {
        const page = await storageRuntime().analyses.listAnalysisResults(
          getAccountId(req),
          (req.params as any).id,
          parseCatalogPageQuery("analysis_results", req.query)
        );
        return reply.send(
          catalogResponse("analysis_results", { items: page.items.map(publicResultSummary), next: page.next })
        );
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/analyses/:id/results/:resultId",
    { onRequest: requireAuth, schema: { params: RESULT_PARAMS_SCHEMA } },
    async (req, reply) => {
      const params = req.params as { id: string; resultId: string };
      const result = await storageRuntime().analyses.getAnalysisResult(getAccountId(req), params.id, params.resultId);
      if (!result) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
      return reply.send(publicResultDetail(result));
    }
  );

  app.delete(
    "/api/analyses/:id/results/:resultId",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: RESULT_PARAMS_SCHEMA } },
    async (req, reply) => {
      const params = req.params as { id: string; resultId: string };
      const deleted = await storageRuntime().analyses.deleteAnalysisResult(
        getAccountId(req),
        params.id,
        params.resultId
      );
      if (!deleted) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
      return reply.send({ ok: true });
    }
  );

  // -- Compare, export, and chart ----------------------------------------------

  app.get(
    "/api/analyses/:id/compare",
    {
      onRequest: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["left", "right"],
          properties: {
            left: { type: "string", pattern: UUID_PATTERN },
            right: { type: "string", pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const analysisId = (req.params as any).id;
        const query = req.query as { left: string; right: string };
        const analysis = await storageRuntime().analyses.getAnalysis(accountId, analysisId);
        if (!analysis) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
        const left = await storageRuntime().analyses.getAnalysisResult(accountId, analysisId, query.left);
        const right = await storageRuntime().analyses.getAnalysisResult(accountId, analysisId, query.right);
        if (!left || !right) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
        // The configured key is the analysis's current comparison key; the
        // diff itself only ever reads the two stored snapshots.
        return reply.send(compareAnalysisResults(left, right, analysis.revision.comparisonKey));
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/analyses/:id/results/:resultId/export",
    {
      onRequest: requireAuth,
      schema: {
        params: RESULT_PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: { format: { type: "string", enum: ["csv", "json", "manifest"] } },
        },
      },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const params = req.params as { id: string; resultId: string };
      const analysis = await storageRuntime().analyses.getAnalysis(accountId, params.id);
      if (!analysis) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
      const result = await storageRuntime().analyses.getAnalysisResult(accountId, params.id, params.resultId);
      if (!result) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
      // Stored-snapshot-only export: the payload is the persisted bounded
      // table; no query executes on this path.
      const format = (req.query as { format: AnalysisExportFormat }).format;
      const file = exportAnalysisResult(result, analysis.revision.title, format);
      return reply
        .header("Content-Disposition", `attachment; filename="${file.filename}"`)
        .header("Cache-Control", "no-store")
        .type(file.contentType)
        .send(file.body);
    }
  );

  // Canonical chart-spec copy bound to the result id (see the module header
  // for why this is a read-only helper instead of a chat-run chart row).
  app.get(
    "/api/analyses/:id/results/:resultId/chart",
    { onRequest: requireAuth, schema: { params: RESULT_PARAMS_SCHEMA } },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const params = req.params as { id: string; resultId: string };
        const analysis = await storageRuntime().analyses.getAnalysis(accountId, params.id);
        if (!analysis) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
        const result = await storageRuntime().analyses.getAnalysisResult(accountId, params.id, params.resultId);
        if (!result) return reply.code(404).send({ error: "not found", code: "ANALYSIS_NOT_FOUND" });
        const spec = buildResultChartSpec(result, analysis.revision.title);
        return reply.send({ result_id: result.id, spec });
      } catch (error) {
        if (sendAnalysisError(reply, error)) return;
        throw error;
      }
    }
  );
}
