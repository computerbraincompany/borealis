/**
 * Durable local research resource routes (M15).
 *
 * Store-backed surface: definition CRUD with optimistic revision CAS, Start
 * admission (exact revision + concrete ready source/generation pinning in one
 * transaction; precise readiness conflicts; selected-empty refused with an
 * explanation), durable run history, run detail with steps/counts/claims,
 * keyset dossier and table reads (25 default; evidence max 50, others max
 * 100), idempotent cancellation, and revision-CAS review batches.
 *
 * The planner provides bounded, editable plan-proposal generation
 * (`POST /:id/plan`) and durable execution: a started run is dispatched to the
 * registered research runner (fire-and-forget; the durable `queued` row is the
 * contract, so a missing runner just defers to the next startup resume). Plan
 * generation performs one bounded model call and NEVER starts execution — the
 * proposal is returned for review and becomes durable only via an explicit
 * CAS `PATCH`.
 *
 * The comparison/output surface uses stored ledger rows through
 * `researchComparison.ts`:
 * - `GET /:id/table` gains bounded page-local sort/filter view options and an
 *   optional `against` run for the changed-cell diff between revisions
 *   (original/extracted/corrected views; the keyset cursor still rides the
 *   row identity and `view_state` discloses the ordering basis);
 * - `GET /research-runs/:id/export?format=csv|manifest` exports the exact
 *   stored result revision (formula-safe CSV plus the JSON evidence/locator
 *   manifest; zero-row/zero-cell runs are a successful export; the 1 MiB
 *   limit state is rendered explicitly and never silently truncated);
 * - `POST /research-runs/:id/artifacts` creates an M13 reviewed DRAFT from a
 *   COMPLETED or `needs_review` run only — never `failed`/`cancelled` (a
 *   cancelled/failed run has no committed child turn to publish through) —
 *   with the memo/comparison projection bounds, labeled omissions, and
 *   gap/conflict disclosures of `researchComparison.ts`. Drafts are
 *   owner-only and outside any publication chain.
 *
 * All routes authenticate in `onRequest` before body parsing and carry
 * schema-derived body ceilings. Responses never include the captured provider
 * origin or any credential material. Stable error codes: RESEARCH_VALIDATION,
 * RESEARCH_NOT_FOUND, RESEARCH_RUN_NOT_FOUND, RESEARCH_REVISION_CONFLICT,
 * RESEARCH_ACTIVE_RUN (with `existing_run_id`), RESEARCH_QUEUE_FULL,
 * RESEARCH_SCOPE_EMPTY, RESEARCH_INPUTS_NOT_READY (with `unready_source_ids`),
 * RESEARCH_RUN_STATE, RESEARCH_REVIEW_TARGET_NOT_FOUND, RESEARCH_EVIDENCE_NOT_FOUND,
 * RESEARCH_EVIDENCE_CAP, RESEARCH_CLAIM_CAP, RESEARCH_GAP_CAP, RESEARCH_TABLE_LIMIT,
 * RESEARCH_MODEL_UNAVAILABLE, INVALID_CATALOG_CURSOR, REMOTE_EGRESS_CONSENT_REQUIRED.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import {
  CatalogCursorError,
  catalogResponse,
  decodeCatalogCursor,
  encodeCatalogCursor,
  type CatalogEndpoint,
  type CatalogPageRequest,
} from "../catalogPagination.js";
import { enforceRemoteEgressConsent } from "../egressPolicy.js";
import {
  ResearchActiveRunError,
  ResearchInputsNotReadyError,
  ResearchRevisionConflictError,
  ResearchRunStateError,
  ResearchStoreError,
  type ResearchRunCounts,
  type ResearchRunSummary,
  type StoredResearchCell,
  type StoredResearchClaim,
  type StoredResearchDefinition,
  type StoredResearchEvidence,
  type StoredResearchRun,
  type StoredResearchStep,
} from "../db/stores/researchStore.js";
import { createDocumentDraft } from "../documentService.js";
import { discoverChatModels } from "../llm.js";
import { sameLlmModel } from "../llmAliases.js";
import {
  applyResearchTablePageView,
  buildResearchArtifactProjection,
  buildResearchComparisonCsv,
  buildResearchRunManifest,
  diffResearchRunTables,
  loadResearchRunEvidence,
  loadResearchRunTable,
  researchExportFilename,
  type ResearchTableViewOptions,
} from "../researchComparison.js";
import { generateResearchPlanProposal } from "../researchPlanner.js";
import {
  RESEARCH_CELL_STATUSES,
  RESEARCH_QUESTION_MAX_CHARS,
  RESEARCH_TITLE_MAX_CHARS,
  ResearchValidationError,
  researchTableLimitState,
  type ResearchCellStatus,
  type ResearchColumnDeclaration,
} from "../researchSchemas.js";
import { defaultResearchRunner } from "../researchRunner.js";
import { storageRuntime } from "../storageRuntime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
  RESEARCH_DEFINITION_JSON_BODY_LIMIT_BYTES,
  RESEARCH_REVIEW_JSON_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";
import { idParamsSchema, UUID_PATTERN } from "./schemas.js";

const DEFAULT_RESEARCH_PAGE_LIMIT = 25;
const MAX_RESEARCH_PAGE_LIMIT = 100;
const MAX_EVIDENCE_PAGE_LIMIT = 50;

const COLUMN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "question", "type"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    label: { type: "string", minLength: 1, maxLength: 80 },
    question: { type: "string", minLength: 1, maxLength: 500 },
    type: { type: "string", enum: ["text", "number", "date", "boolean", "enum"] },
    unit: { type: ["string", "null"], minLength: 1, maxLength: 40 },
    choices: {
      type: ["array", "null"],
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
} as const;

const DEFINITION_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "question", "output_kind", "source_ids", "chat_model"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: RESEARCH_TITLE_MAX_CHARS },
    question: { type: "string", minLength: 1, maxLength: RESEARCH_QUESTION_MAX_CHARS },
    output_kind: { type: "string", enum: ["memo", "comparison"] },
    source_ids: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", pattern: UUID_PATTERN } },
    library_ids: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", pattern: UUID_PATTERN } },
    chat_model: { type: "string", minLength: 1, maxLength: 256 },
    columns: { type: "array", maxItems: 20, items: COLUMN_SCHEMA },
    // The plan proposal shape is owned by `researchSchemas.ts` (8 steps,
    // bounded objectives/questions, serialized budget); the transport schema
    // stays open so a malformed plan answers RESEARCH_VALIDATION, not a
    // generic schema rejection.
    plan: true,
  },
} as const;

const DEFINITION_PATCH_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  required: ["expected_revision"],
  properties: {
    expected_revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    ...DEFINITION_BODY_SCHEMA.properties,
  },
} as const;

const START_RUN_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    expected_revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    definition_revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    rerun_of: { type: "string", pattern: UUID_PATTERN },
    rerun_selection: {
      type: "object",
      additionalProperties: false,
      properties: {
        row_source_ids: {
          type: "array",
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", pattern: UUID_PATTERN },
        },
        column_ids: {
          type: "array",
          maxItems: 20,
          uniqueItems: true,
          items: { type: "string", pattern: UUID_PATTERN },
        },
      },
    },
  },
} as const;

const REVIEW_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["expected_revision", "ops"],
  properties: {
    expected_revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    // Operation shapes and semantic bounds are owned by
    // `researchSchemas.normalizeResearchReviewOps` (stable target ids, bounded
    // note/correction text, typed cell values).
    ops: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } },
  },
} as const;

const CATALOG_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: MAX_RESEARCH_PAGE_LIMIT },
    cursor: { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" },
  },
} as const;

const EVIDENCE_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: MAX_EVIDENCE_PAGE_LIMIT },
    cursor: { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" },
  },
} as const;

const PLAN_PROPOSAL_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    expected_revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

/** Artifact creation takes no body: the projection is derived from stored rows. */
const ARTIFACT_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  maxProperties: 0,
} as const;

/**
 * Table reads extend the keyset catalog query with bounded page-local
 * view options (server-side sort/filter over the returned keyset page,
 * disclosed by `view_state`) and an optional `against` run identity for the
 * changed-cell diff between result revisions.
 */
const TABLE_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: CATALOG_QUERY_SCHEMA.properties.limit,
    cursor: CATALOG_QUERY_SCHEMA.properties.cursor,
    sort_column: { type: "string", pattern: UUID_PATTERN },
    sort_dir: { type: "string", enum: ["asc", "desc"] },
    sort_view: { type: "string", enum: ["effective", "machine", "correction"] },
    filter_column: { type: "string", pattern: UUID_PATTERN },
    filter_status: { type: "string", enum: [...RESEARCH_CELL_STATUSES] },
    filter_text: { type: "string", minLength: 1, maxLength: 200 },
    against: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const EXPORT_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format"],
  properties: { format: { type: "string", enum: ["csv", "manifest"] } },
} as const;

/** Keyset parsing with a research-specific default (25) and per-table max. */
function parseResearchPage(endpoint: CatalogEndpoint, query: unknown, maxLimit: number): CatalogPageRequest {
  const record = query && typeof query === "object" && !Array.isArray(query) ? (query as Record<string, unknown>) : {};
  const limit = record.limit === undefined ? DEFAULT_RESEARCH_PAGE_LIMIT : record.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > maxLimit) {
    throw new CatalogCursorError();
  }
  const after = record.cursor === undefined ? null : decodeCatalogCursor(endpoint, String(record.cursor));
  return { limit: Number(limit), after };
}

function sendResearchError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof CatalogCursorError) {
    reply.code(400).send({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof ResearchValidationError) {
    reply.code(400).send({ error: error.message, code: "RESEARCH_VALIDATION" });
    return true;
  }
  if (error instanceof ResearchInputsNotReadyError) {
    reply.code(409).send({ error: error.message, code: error.code, unready_source_ids: error.unreadySourceIds });
    return true;
  }
  if (error instanceof ResearchActiveRunError) {
    reply.code(409).send({
      error: error.message,
      code: error.code,
      ...(error.existingRunId ? { existing_run_id: error.existingRunId } : {}),
    });
    return true;
  }
  if (error instanceof ResearchStoreError) {
    const notFound = [
      "RESEARCH_NOT_FOUND",
      "RESEARCH_RUN_NOT_FOUND",
      "RESEARCH_REVIEW_TARGET_NOT_FOUND",
      "RESEARCH_EVIDENCE_NOT_FOUND",
    ].includes(error.code);
    if (notFound) {
      // Reference failures keep their stable code; plain resource misses stay
      // content-free.
      const detail = error.code === "RESEARCH_EVIDENCE_NOT_FOUND" || error.code === "RESEARCH_REVIEW_TARGET_NOT_FOUND";
      reply.code(404).send({ error: detail ? error.message : "not found", code: error.code });
      return true;
    }
    reply.code(409).send({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

function publicColumns(columns: readonly ResearchColumnDeclaration[]) {
  return columns.map((column) => ({
    id: column.id,
    label: column.label,
    question: column.question,
    type: column.type,
    unit: column.unit,
    choices: column.choices,
  }));
}

function publicDefinition(definition: StoredResearchDefinition) {
  return {
    id: definition.id,
    title: definition.revision.title,
    question: definition.revision.question,
    output_kind: definition.revision.outputKind,
    current_revision: definition.currentRevision,
    source_ids: definition.revision.sourceIds,
    library_ids: definition.revision.libraryIds,
    chat_model: definition.revision.chatModel,
    columns: publicColumns(definition.revision.columns),
    plan: definition.revision.plan,
    sources: definition.sources.map((source) => ({
      source_id: source.sourceId,
      availability: source.availability,
      ready_generation: source.readyGeneration,
    })),
    active_run: definition.activeRun,
    revision_created_at: definition.revision.createdAt,
    created_at: definition.createdAt,
    updated_at: definition.updatedAt,
  };
}

function publicRunSummary(run: ResearchRunSummary) {
  return {
    id: run.id,
    definition_id: run.definitionId,
    definition_revision: run.definitionRevision,
    status: run.status,
    cancel_requested: run.cancelRequested,
    chat_model: run.chatModel,
    provider_locality: run.providerLocality,
    rerun_of: run.rerunOf,
    review_revision: run.reviewRevision,
    error_code: run.errorCode,
    created_at: run.createdAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };
}

/** Frozen run DTO. `provider_origin` never appears; locality only is public. */
function publicRun(run: StoredResearchRun) {
  return {
    ...publicRunSummary({
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
    }),
    error_reason: run.errorReason,
    sources: run.sources.map((source) => ({ source_id: source.sourceId, generation: source.generation })),
    budgets: {
      steps: run.budgets.steps,
      searches: run.budgets.searches,
      model_requests: run.budgets.modelRequests,
      evidence: run.budgets.evidence,
      evidence_chars: run.budgets.evidenceChars,
      wall_ms: run.budgets.wallMs,
    },
    usage: { searches: run.searchesUsed, model_requests: run.modelRequestsUsed },
    rerun_selection: run.rerunSelection,
  };
}

function publicCounts(counts: ResearchRunCounts) {
  return {
    evidence_count: counts.evidenceCount,
    evidence_char_count: counts.evidenceCharCount,
    claim_count: counts.claimCount,
    gap_count: counts.gapCount,
    machine_cell_count: counts.machineCellCount,
    correction_cell_count: counts.correctionCellCount,
    table_serialized_bytes: counts.tableSerializedBytes,
  };
}

function publicStep(step: StoredResearchStep) {
  return {
    ordinal: step.ordinal,
    objective: step.objective,
    questions: step.questions,
    status: step.status,
    outcome: step.outcome,
    attempts: step.attempts,
    started_at: step.startedAt,
    finished_at: step.finishedAt,
  };
}

function publicEvidence(evidence: StoredResearchEvidence) {
  return {
    id: evidence.id,
    run_id: evidence.runId,
    source_id: evidence.sourceId,
    generation: evidence.generation,
    chunk_id: evidence.chunkId,
    label: evidence.label,
    locators: evidence.locators,
    excerpt: evidence.excerpt,
    content_hash: evidence.contentHash,
    retrieved_at: evidence.retrievedAt,
    step_ordinal: evidence.stepOrdinal,
    query: evidence.query,
    irrelevant: evidence.irrelevant,
  };
}

function publicClaim(claim: StoredResearchClaim) {
  return {
    id: claim.id,
    run_id: claim.runId,
    kind: claim.kind,
    text: claim.text,
    corrected_text: claim.correctedText,
    classification: claim.classification,
    evidence_refs: claim.evidenceRefs,
    user_note: claim.userNote,
    review_state: claim.reviewState,
    created_at: claim.createdAt,
    updated_at: claim.updatedAt,
  };
}

function publicCell(cell: StoredResearchCell) {
  return {
    column_id: cell.columnId,
    row_source_id: cell.rowSourceId,
    row_generation: cell.rowGeneration,
    origin: cell.origin,
    value: cell.value,
    status: cell.status,
    evidence_refs: cell.evidenceRefs,
    explanation: cell.explanation,
    corrected_at: cell.correctedAt,
    corrected_from_run_id: cell.correctedFromRunId,
    created_at: cell.createdAt,
    updated_at: cell.updatedAt,
  };
}

const DELETE_DRAIN_ATTEMPTS = 20;
const DELETE_DRAIN_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function researchRoutes(app: FastifyInstance): Promise<void> {
  // -- Definitions ------------------------------------------------------------

  app.get(
    "/api/research",
    { onRequest: requireAuth, schema: { querystring: CATALOG_QUERY_SCHEMA } },
    async (req, reply) => {
      try {
        const page = await storageRuntime().research.listResearchDefinitions(
          getAccountId(req),
          parseResearchPage("research", req.query, MAX_RESEARCH_PAGE_LIMIT)
        );
        return reply.send(
          catalogResponse("research", {
            items: page.items.map((item) => ({
              id: item.id,
              title: item.title,
              output_kind: item.outputKind,
              current_revision: item.currentRevision,
              source_count: item.sourceCount,
              created_at: item.createdAt,
              updated_at: item.updatedAt,
            })),
            next: page.next,
          })
        );
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/research",
    {
      onRequest: requireAuth,
      bodyLimit: RESEARCH_DEFINITION_JSON_BODY_LIMIT_BYTES,
      schema: { body: DEFINITION_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const definition = await storageRuntime().research.createResearchDefinition(getAccountId(req), req.body);
        return reply.code(201).send(publicDefinition(definition));
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get("/api/research/:id", { onRequest: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const definition = await storageRuntime().research.getResearchDefinition(
      getAccountId(req),
      (req.params as { id: string }).id
    );
    if (!definition) return reply.code(404).send({ error: "not found", code: "RESEARCH_NOT_FOUND" });
    return reply.send(publicDefinition(definition));
  });

  app.patch(
    "/api/research/:id",
    {
      onRequest: requireAuth,
      bodyLimit: RESEARCH_DEFINITION_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: DEFINITION_PATCH_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const body = req.body as Record<string, unknown> & { expected_revision: number };
        const patch: Record<string, unknown> = {};
        for (const key of [
          "title",
          "question",
          "output_kind",
          "source_ids",
          "library_ids",
          "chat_model",
          "columns",
          "plan",
        ]) {
          if (body[key] !== undefined) patch[key] = body[key];
        }
        const definition = await storageRuntime().research.updateResearchDefinition(
          getAccountId(req),
          (req.params as { id: string }).id,
          body.expected_revision,
          patch
        );
        return reply.send(publicDefinition(definition));
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  // Deletion cancels own active work first: request durable cancellation and
  // retry the owned deletion within a bounded drain window.
  app.delete(
    "/api/research/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const definitionId = (req.params as { id: string }).id;
        const store = storageRuntime().research;
        try {
          const deleted = await store.deleteResearchDefinition(accountId, definitionId);
          if (!deleted) return reply.code(404).send({ error: "not found", code: "RESEARCH_NOT_FOUND" });
          return reply.send({ ok: true });
        } catch (error) {
          if (!(error instanceof ResearchActiveRunError)) throw error;
          if (error.existingRunId) await store.requestResearchRunCancel(accountId, error.existingRunId);
          for (let attempt = 0; attempt < DELETE_DRAIN_ATTEMPTS; attempt += 1) {
            await sleep(DELETE_DRAIN_INTERVAL_MS);
            try {
              const deleted = await store.deleteResearchDefinition(accountId, definitionId);
              if (deleted) return reply.send({ ok: true });
              return reply.code(404).send({ error: "not found", code: "RESEARCH_NOT_FOUND" });
            } catch (retryError) {
              if (!(retryError instanceof ResearchActiveRunError) || attempt === DELETE_DRAIN_ATTEMPTS - 1) {
                throw retryError;
              }
            }
          }
          throw error;
        }
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  // -- Plan generation (bounded editable proposal; never starts execution) --------

  app.post(
    "/api/research/:id/plan",
    {
      onRequest: requireAuth,
      // The proposal sends the question and selected-source labels to the
      // configured provider, so the remote-egress consent gate applies.
      bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: PLAN_PROPOSAL_BODY_SCHEMA },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const target = await enforceRemoteEgressConsent(reply, accountId);
      if (!target) return;
      const store = storageRuntime().research;
      const definitionId = (req.params as { id: string }).id;
      try {
        const owned = await store.getResearchDefinition(accountId, definitionId);
        if (!owned) return reply.code(404).send({ error: "not found", code: "RESEARCH_NOT_FOUND" });
        const body = (req.body ?? {}) as { expected_revision?: number };
        // The proposal is generated against the revision the user is editing;
        // a stale `expected_revision` is an honest conflict, never a silent
        // regeneration against a different head.
        if (body.expected_revision !== undefined && body.expected_revision !== owned.currentRevision) {
          throw new ResearchRevisionConflictError();
        }
        const controller = new AbortController();
        req.raw.once("aborted", () => controller.abort());
        const proposal = await generateResearchPlanProposal({
          accountId,
          definition: owned,
          target,
          signal: controller.signal,
        });
        // The proposal is returned for review only. It creates no run and
        // approves nothing; the user persists it through a CAS PATCH.
        return reply.send({
          definition_id: owned.id,
          base_revision: owned.currentRevision,
          model: proposal.model,
          model_used: proposal.modelUsed,
          fallback: proposal.fallback,
          error_code: proposal.errorCode,
          plan: proposal.plan,
        });
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  // -- Runs ---------------------------------------------------------------------

  app.get(
    "/api/research/:id/runs",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: CATALOG_QUERY_SCHEMA } },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const definitionId = (req.params as { id: string }).id;
        // Subresource lists must 404 (not empty-list) for an unowned definition.
        const owned = await storageRuntime().research.getResearchDefinition(accountId, definitionId);
        if (!owned) return reply.code(404).send({ error: "not found", code: "RESEARCH_NOT_FOUND" });
        const page = await storageRuntime().research.listResearchRuns(
          accountId,
          definitionId,
          parseResearchPage("research_runs", req.query, MAX_RESEARCH_PAGE_LIMIT)
        );
        return reply.send(
          catalogResponse("research_runs", { items: page.items.map(publicRunSummary), next: page.next })
        );
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/research/:id/runs",
    {
      onRequest: requireAuth,
      // A research run sends the question and selected-source content to the
      // configured provider, so the remote-egress consent gate applies to
      // Start exactly as it does to a chat turn.
      bodyLimit: IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: START_RUN_BODY_SCHEMA },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const target = await enforceRemoteEgressConsent(reply, accountId);
      if (!target) return;
      try {
        const body = (req.body ?? {}) as {
          expected_revision?: number;
          definition_revision?: number;
          rerun_of?: string;
          rerun_selection?: { row_source_ids?: readonly string[]; column_ids?: readonly string[] };
        };
        // Validate the pinned definition's explicit chat model against the
        // live catalog when discovery answers. An unavailable provider does
        // NOT refuse admission — the durable row is the contract and the
        // runner revalidates/ settles honestly at transport time (the same
        // durable-run convention as a provider switch mid-queue).
        const store = storageRuntime().research;
        const pinned =
          body.definition_revision !== undefined
            ? await store.getResearchRevisionContent(
                accountId,
                (req.params as { id: string }).id,
                body.definition_revision
              )
            : (await store.getResearchDefinition(accountId, (req.params as { id: string }).id))?.revision;
        if (pinned) {
          const catalog = await discoverChatModels();
          if (
            catalog.discovery === "live" &&
            !catalog.available_models.some((model) => sameLlmModel(model.id, pinned.chatModel))
          ) {
            return reply.code(409).send({
              error: "the definition's chat model is not available on the provider",
              code: "RESEARCH_MODEL_UNAVAILABLE",
            });
          }
        }
        const run = await store.startResearchRun(accountId, (req.params as { id: string }).id, {
          expectedRevision: body.expected_revision ?? null,
          definitionRevision: body.definition_revision ?? null,
          rerunOf: body.rerun_of ?? null,
          rerunSelection: body.rerun_selection ?? null,
          authorization: {
            providerOrigin: target.origin,
            providerLocality: target.locality,
            providerRevision: target.revision,
          },
        });
        // Fire-and-forget dispatch through the registered executor. The
        // accepted `queued` row is the contract: with no live runner (or a
        // busy account) the durable claim loop resumes it at the next pass.
        defaultResearchRunner()?.dispatch(run);
        return reply.code(201).send(publicRun(run));
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  // -- Run detail, dossier, table --------------------------------------------------

  app.get(
    "/api/research-runs/:id",
    { onRequest: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        const inspection = await storageRuntime().research.inspectResearchRun(
          getAccountId(req),
          (req.params as { id: string }).id
        );
        if (!inspection) return reply.code(404).send({ error: "not found", code: "RESEARCH_RUN_NOT_FOUND" });
        return reply.send({
          ...publicRun(inspection.run),
          steps: inspection.steps.map(publicStep),
          claims: inspection.claims.map(publicClaim),
          counts: publicCounts(inspection.counts),
          run_notes: inspection.runNotes,
        });
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/research-runs/:id/evidence",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: EVIDENCE_QUERY_SCHEMA } },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const runId = (req.params as { id: string }).id;
        const run = await storageRuntime().research.getResearchRun(accountId, runId);
        if (!run) return reply.code(404).send({ error: "not found", code: "RESEARCH_RUN_NOT_FOUND" });
        const page = await storageRuntime().research.listResearchEvidence(
          accountId,
          runId,
          parseResearchPage("research_evidence", req.query, MAX_EVIDENCE_PAGE_LIMIT)
        );
        return reply.send(
          catalogResponse("research_evidence", { items: page.items.map(publicEvidence), next: page.next })
        );
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/research-runs/:id/table",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: TABLE_QUERY_SCHEMA } },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const runId = (req.params as { id: string }).id;
        const store = storageRuntime().research;
        const run = await store.getResearchRun(accountId, runId);
        if (!run) return reply.code(404).send({ error: "not found", code: "RESEARCH_RUN_NOT_FOUND" });
        const table = await store.getResearchTable(
          accountId,
          runId,
          parseResearchPage("research_table", req.query, MAX_RESEARCH_PAGE_LIMIT)
        );
        if (!table) return reply.code(404).send({ error: "not found", code: "RESEARCH_RUN_NOT_FOUND" });
        const query = (req.query ?? {}) as Record<string, unknown>;
        const viewOptions: ResearchTableViewOptions = {
          sortColumnId: typeof query.sort_column === "string" ? query.sort_column : null,
          sortDir: query.sort_dir === "desc" ? "desc" : query.sort_dir === "asc" ? "asc" : undefined,
          sortView:
            query.sort_view === "machine" || query.sort_view === "correction" || query.sort_view === "effective"
              ? query.sort_view
              : undefined,
          filterColumnId: typeof query.filter_column === "string" ? query.filter_column : null,
          filterStatus:
            typeof query.filter_status === "string" &&
            (RESEARCH_CELL_STATUSES as readonly string[]).includes(query.filter_status)
              ? (query.filter_status as ResearchCellStatus)
              : null,
          filterText: typeof query.filter_text === "string" ? query.filter_text : null,
        };
        const view = applyResearchTablePageView(table.page.items, table.columns, viewOptions);
        // Rows are keyed by source identity, not timestamps; the cursor rides
        // the endpoint binding with the run creation time as the stable tuple.
        const nextCursor = table.page.next ? encodeCatalogCursor("research_table", table.page.next) : null;
        let comparison: ReturnType<typeof diffResearchRunTables> | null = null;
        if (typeof query.against === "string") {
          const target = await loadResearchRunTable(store, accountId, query.against);
          if (!target) return reply.code(404).send({ error: "not found", code: "RESEARCH_RUN_NOT_FOUND" });
          if (target.run.definitionId !== run.definitionId) {
            throw new ResearchValidationError("the comparison target must be a run of the same definition");
          }
          // The revision diff is always over the FULL stored table; the
          // page-local sort/filter view never mutates what is compared.
          const current = await loadResearchRunTable(store, accountId, runId);
          if (!current) throw new ResearchValidationError("the run vanished mid-comparison");
          comparison = diffResearchRunTables(target, current);
        }
        return reply.send({
          run_id: runId,
          columns: publicColumns(table.columns),
          items: view.items.map((item) => ({
            row_source_id: item.row_source_id,
            row_generation: item.row_generation,
            cells: item.cells.map(publicCell),
          })),
          next_cursor: nextCursor,
          limit_state: researchTableLimitState(table.serializedBytes),
          view_state: view.viewState,
          ...(comparison === null ? {} : { comparison }),
        });
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  // Cancellation request is idempotent: terminal states are absorbing and a
  // repeated DELETE returns the same durable status.
  app.delete(
    "/api/research-runs/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const status = await storageRuntime().research.requestResearchRunCancel(
        getAccountId(req),
        (req.params as { id: string }).id
      );
      if (status === null) return reply.code(404).send({ error: "not found", code: "RESEARCH_RUN_NOT_FOUND" });
      return reply.send({ ok: true, status });
    }
  );

  // -- Review ---------------------------------------------------------------------

  app.patch(
    "/api/research-runs/:id/review",
    {
      onRequest: requireAuth,
      bodyLimit: RESEARCH_REVIEW_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: REVIEW_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const body = req.body as { expected_revision: number; ops: readonly unknown[] };
        const result = await storageRuntime().research.applyResearchReviewOps(
          getAccountId(req),
          (req.params as { id: string }).id,
          body.expected_revision,
          body.ops
        );
        return reply.send({
          review_revision: result.reviewRevision,
          ops_applied: result.applied,
          run: publicRun(result.run),
        });
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  // -- Artifacts (M13 reviewed draft) and export (CSV/JSON manifest) ---------------

  /**
   * Creates an M13 reviewed DRAFT (revision 1, no publication chain) from a
   * finished run's stored rows. `failed`/`cancelled` runs are refused: they
   * have no committed child turn to publish through. The response states
   * exactly what was projected and what was omitted.
   */
  app.post(
    "/api/research-runs/:id/artifacts",
    {
      onRequest: requireAuth,
      bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: ARTIFACT_BODY_SCHEMA },
    },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const runId = (req.params as { id: string }).id;
        const store = storageRuntime().research;
        const run = await store.getResearchRun(accountId, runId);
        if (!run) return reply.code(404).send({ error: "not found", code: "RESEARCH_RUN_NOT_FOUND" });
        if (run.status !== "completed" && run.status !== "needs_review") {
          throw new ResearchRunStateError(
            "only finished (completed or needs_review) runs can create reviewed artifacts"
          );
        }
        const revision = await store.getResearchRevisionContent(accountId, run.definitionId, run.definitionRevision);
        if (!revision) throw new ResearchRunStateError("the run's pinned definition revision row vanished");
        const view = await loadResearchRunTable(store, accountId, runId);
        if (!view) throw new ResearchRunStateError("the run vanished mid-projection");
        const [evidence, claims] = await Promise.all([
          loadResearchRunEvidence(store, accountId, runId),
          store.listResearchClaims(accountId, runId),
        ]);
        const sourceRecords = await storageRuntime().sources.getSourcesByIds(
          accountId,
          run.sources.map((source) => source.sourceId)
        );
        const sourceNames = new Map(sourceRecords.map((source) => [source.id, source.displayName || source.name]));
        const projection = buildResearchArtifactProjection({
          run,
          revision,
          claims,
          evidence,
          rows: view.rows,
          serializedBytes: view.serializedBytes,
          sourceNames,
        });
        const created = await createDocumentDraft({ accountId, title: projection.title, tree: projection.tree });
        return reply.code(201).send({
          run_id: runId,
          document_id: created.document.id,
          document_revision_id: created.revision.id,
          document_revision: created.revision.revision,
          projection: projection.projection,
        });
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );

  /**
   * Exact stored-revision export. CSV is the full long-form bounded table
   * (machine originals and correction overlays side by side, formula-safe
   * escaping, UTF-8 BOM, explicit limit-state comment); the manifest is the
   * typed-exact JSON companion with locators, hashes, cell bindings,
   * correction provenance, and limit/budget states. Zero rows/zero cells is
   * a valid successful export. No retrieval, model, or source read happens
   * on this path.
   */
  app.get(
    "/api/research-runs/:id/export",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: EXPORT_QUERY_SCHEMA } },
    async (req, reply) => {
      try {
        const accountId = getAccountId(req);
        const runId = (req.params as { id: string }).id;
        const store = storageRuntime().research;
        const view = await loadResearchRunTable(store, accountId, runId);
        if (!view) return reply.code(404).send({ error: "not found", code: "RESEARCH_RUN_NOT_FOUND" });
        const evidence = await loadResearchRunEvidence(store, accountId, runId);
        const format = (req.query as { format: "csv" | "manifest" }).format;
        const definition = await store.getResearchDefinition(accountId, view.run.definitionId);
        const filename = researchExportFilename(definition?.revision.title ?? "Research", runId, format);
        const body =
          format === "csv"
            ? buildResearchComparisonCsv(view)
            : `${JSON.stringify(buildResearchRunManifest(view, evidence), null, 2)}\n`;
        return reply
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .header("Cache-Control", "no-store")
          .type(format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8")
          .send(body);
      } catch (error) {
        if (sendResearchError(reply, error)) return;
        throw error;
      }
    }
  );
}
