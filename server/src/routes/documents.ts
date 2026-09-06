import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import {
  DocumentNotFoundError,
  DocumentPublicationActiveError,
  DocumentPublicationStateError,
  DocumentRevisionConflictError,
  DocumentRewriteNotFoundError,
  DocumentRewriteStaleError,
  DocumentRevisionNotFoundError,
  DocumentStoreError,
  DocumentUnavailableError,
  DocumentValidationError,
  type StoredDocument,
  type StoredDocumentPublication,
  type StoredDocumentRevision,
  type StoredDocumentRewrite,
} from "../db/stores/documentStore.js";
import {
  DocumentRewriteSelectionInvalidError,
  DocumentRewriteSelectionOversizeError,
  DOCUMENT_REWRITE_INSTRUCTION_MAX_CHARS,
} from "../documentRewriteTypes.js";
import { enforceRemoteEgressConsent } from "../egressPolicy.js";
import {
  DocumentTemplateConflictError,
  DocumentTemplateDuplicateNameError,
  DocumentTemplateNotFoundError,
  DocumentTemplateQuotaError,
  type StoredDocumentTemplate,
} from "../db/stores/documentTemplateStore.js";
import {
  acceptDocumentRewrite,
  createDocumentDraft,
  appendDocumentRevision,
  createTemplateFromDocument,
  deleteDocumentRewrite,
  deleteDocumentTemplate,
  deleteDocumentWithCleanup,
  getCustomDocumentTemplate,
  getDocument,
  getDocumentDiff,
  getDocumentRevision,
  getDocumentRewrite,
  listDocumentCatalog,
  listDocumentPublications,
  listDocumentRewrites,
  listDocumentRevisionHistory,
  listTemplateCatalog,
  requestDocumentRewrite,
  requestDocumentRewriteCancel,
  updateDocumentTemplate,
  DocumentCleanupDeferredError,
} from "../documentService.js";
import { getBuiltinDocumentTemplate, BUILTIN_DOCUMENT_TEMPLATES } from "../documentTemplates.js";
import {
  DOCUMENT_REVISION_JSON_BODY_LIMIT_BYTES,
  DOCUMENT_TEMPLATE_JSON_BODY_LIMIT_BYTES,
  COMPACT_JSON_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";
import { UUID_PATTERN, idParamsSchema } from "./schemas.js";

const revisionIdParamsSchema = {
  type: "object",
  required: ["id", "revisionId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    revisionId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const documentCreateBodySchema = {
  type: "object",
  propertyNames: { enum: ["title", "tree", "template_id", "copy_from_report_id"] },
  description:
    "Exactly one creation shape: an explicit `tree`, a `template_id`, or `copy_from_report_id` (owned published legacy report). Omitting all creates a blank draft.",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    // The tree is validated semantically by `normalizeDocumentTree`, the
    // single owner of every document bound; the parser only checks it is an
    // object so oversized structures reach the typed DOCUMENT_OVERSIZE/
    // DOCUMENT_INVALID envelope instead of a generic 400.
    tree: { type: "object" },
    template_id: { type: "string", pattern: UUID_PATTERN },
    copy_from_report_id: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const revisionSaveBodySchema = {
  type: "object",
  required: ["base_revision_id", "tree"],
  additionalProperties: false,
  properties: {
    base_revision_id: { type: "string", pattern: UUID_PATTERN },
    tree: { type: "object" },
  },
} as const;

const documentDiffQuerySchema = {
  type: "object",
  required: ["base", "target"],
  additionalProperties: false,
  properties: {
    base: { type: "string", pattern: UUID_PATTERN },
    target: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const rewriteIdParamsSchema = {
  type: "object",
  required: ["id", "rewriteId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    rewriteId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const rewriteCreateBodySchema = {
  type: "object",
  required: ["base_revision_id", "section_id", "selection_sha256", "instruction"],
  additionalProperties: false,
  properties: {
    base_revision_id: { type: "string", pattern: UUID_PATTERN },
    section_id: { type: "string", pattern: UUID_PATTERN },
    // Optional UTF-16 half-open range inside the section; both fields must
    // appear together. Omitting both selects the whole section.
    range_start: { type: "integer", minimum: 0, maximum: 50_000 },
    range_end: { type: "integer", minimum: 1, maximum: 50_000 },
    selection_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    instruction: { type: "string", minLength: 1, maxLength: DOCUMENT_REWRITE_INSTRUCTION_MAX_CHARS, pattern: "\\S" },
  },
} as const;

// Reserved shape for the stage-4 publication execution; the route returns
// 501 PUBLICATION_NOT_READY before any store work.
const publicationStartBodySchema = {
  type: "object",
  required: ["operation_id"],
  additionalProperties: false,
  properties: {
    operation_id: { type: "string", pattern: UUID_PATTERN },
    expected_revision_id: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const templateCreateBodySchema = {
  type: "object",
  required: ["name", "document_id"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    description: { type: "string", maxLength: 500 },
    document_id: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const templatePatchBodySchema = {
  type: "object",
  required: ["expected_revision"],
  propertyNames: { enum: ["name", "description", "expected_revision"] },
  description: "Revision-checked template edit. At least one of name/description alongside expected_revision.",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    description: { type: "string", maxLength: 500 },
    expected_revision: { type: "integer", minimum: 1 },
  },
} as const;

const templateDeleteBodySchema = {
  type: "object",
  required: ["expected_revision"],
  additionalProperties: false,
  properties: { expected_revision: { type: "integer", minimum: 1 } },
} as const;

// ---------------------------------------------------------------------------
// DTOs — never filesystem paths, never another account's data
// ---------------------------------------------------------------------------

function publicDocument(document: StoredDocument) {
  return {
    id: document.id,
    title: document.title,
    current_revision: document.currentRevision,
    current_revision_id: document.currentRevisionId,
    head_author_kind: document.headAuthorKind,
    origin: {
      report_id: document.origin.reportId,
      chat_id: document.origin.chatId,
      run_id: document.origin.runId,
      analysis_result_id: document.origin.analysisResultId,
    },
    latest_publication_version: document.latestPublicationVersion,
    revision_count: document.revisionCount,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  };
}

function publicRevision(revision: StoredDocumentRevision) {
  return {
    id: revision.id,
    document_id: revision.documentId,
    revision: revision.revision,
    title: revision.title,
    author_kind: revision.authorKind,
    base_revision_id: revision.baseRevisionId,
    payload: revision.payload,
    payload_chars: revision.payloadChars,
    created_at: revision.createdAt,
  };
}

function publicPublication(publication: StoredDocumentPublication) {
  return {
    id: publication.id,
    document_id: publication.documentId,
    revision_id: publication.revisionId,
    revision: publication.revision,
    version: publication.version,
    title: publication.title,
    supersedes: publication.supersedes,
    created_at: publication.createdAt,
  };
}

function publicCustomTemplate(template: StoredDocumentTemplate) {
  return {
    id: template.id,
    built_in: false,
    name: template.name,
    description: template.description,
    revision: template.revision,
    snapshot: template.snapshot,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  };
}

function publicRewrite(rewrite: StoredDocumentRewrite) {
  return {
    id: rewrite.id,
    document_id: rewrite.documentId,
    base_revision_id: rewrite.baseRevisionId,
    section_id: rewrite.sectionId,
    range_start: rewrite.rangeStart,
    range_end: rewrite.rangeEnd,
    selection_sha256: rewrite.selectionSha256,
    selection_chars: rewrite.selectionChars,
    instruction: rewrite.instruction,
    status: rewrite.status,
    replacement: rewrite.replacement,
    evidence_refs: rewrite.evidenceRefs,
    model: rewrite.model,
    error_code: rewrite.errorCode,
    error_reason: rewrite.errorReason,
    cancel_requested: rewrite.cancelRequested,
    applied_revision_id: rewrite.appliedRevisionId,
    created_at: rewrite.createdAt,
    started_at: rewrite.startedAt,
    finished_at: rewrite.finishedAt,
    updated_at: rewrite.updatedAt,
  };
}

function publicBuiltinTemplate(id: string) {
  const template = getBuiltinDocumentTemplate(id)!;
  return {
    id: template.id,
    built_in: true,
    name: template.name,
    description: template.description,
    snapshot: template.snapshot,
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function sendDocumentError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof DocumentRevisionConflictError) {
    reply.code(409).send({
      error: "the document changed since this draft was loaded",
      code: "DOCUMENT_REVISION_CONFLICT",
      current_head: {
        revision_id: error.currentHead.revisionId,
        revision: error.currentHead.revision,
        title: error.currentHead.title,
        author_kind: error.currentHead.authorKind,
        updated_at: error.currentHead.updatedAt,
      },
    });
    return true;
  }
  if (error instanceof DocumentUnavailableError) {
    reply.code(409).send({ error: "editable copy is unavailable for this report", code: "DOCUMENT_UNAVAILABLE" });
    return true;
  }
  if (error instanceof DocumentValidationError) {
    reply.code(400).send({ error: "document payload violates the document contract", code: error.code });
    return true;
  }
  if (
    error instanceof DocumentNotFoundError ||
    error instanceof DocumentTemplateNotFoundError ||
    (error instanceof DocumentStoreError && error.code === "DOCUMENT_NOT_FOUND")
  ) {
    reply.code(404).send({ error: "not found", code: "DOCUMENT_NOT_FOUND" });
    return true;
  }
  if (
    error instanceof DocumentRevisionNotFoundError ||
    (error instanceof DocumentStoreError && error.code === "DOCUMENT_REVISION_NOT_FOUND")
  ) {
    reply.code(404).send({ error: "document revision not found", code: "DOCUMENT_REVISION_NOT_FOUND" });
    return true;
  }
  if (error instanceof DocumentPublicationActiveError) {
    reply.code(409).send({ error: "a publication is already active for this document", code: error.code });
    return true;
  }
  if (error instanceof DocumentPublicationStateError) {
    reply.code(409).send({ error: "publication state does not allow this transition", code: error.code });
    return true;
  }
  if (error instanceof DocumentTemplateConflictError) {
    reply.code(409).send({
      error: "the template changed since this edit was loaded",
      code: "DOCUMENT_TEMPLATE_CONFLICT",
      current_revision: error.currentRevision,
    });
    return true;
  }
  if (error instanceof DocumentTemplateQuotaError) {
    reply.code(409).send({ error: "custom template quota reached", code: error.code });
    return true;
  }
  if (error instanceof DocumentTemplateDuplicateNameError) {
    reply.code(409).send({ error: "a template with this name already exists", code: error.code });
    return true;
  }
  if (error instanceof DocumentRewriteSelectionInvalidError) {
    // Malformed selection targeting: out of bounds, empty, or a range that
    // splits a surrogate pair. The request cannot describe a rewrite at all,
    // so it is a 400 — a content mismatch is the 409 below.
    reply.code(400).send({
      error: "the rewrite selection range is invalid (it may split a surrogate pair)",
      code: error.code,
    });
    return true;
  }
  if (error instanceof DocumentRewriteSelectionOversizeError) {
    reply.code(400).send({
      error: "the selected text exceeds the rewrite bound; select a smaller range",
      code: error.code,
    });
    return true;
  }
  if (error instanceof DocumentStoreError && error.code.startsWith("DOCUMENT_REWRITE")) {
    if (error.code === "DOCUMENT_REWRITE_NOT_FOUND") {
      reply.code(404).send({ error: "document rewrite not found", code: error.code });
      return true;
    }
    if (error instanceof DocumentRewriteStaleError) {
      reply.code(409).send({
        error: "this proposal is stale against the current document head; it stays inspectable and is never applied",
        code: error.code,
        current_head: {
          revision_id: error.currentHead.revisionId,
          revision: error.currentHead.revision,
          title: error.currentHead.title,
          author_kind: error.currentHead.authorKind,
          updated_at: error.currentHead.updatedAt,
        },
      });
      return true;
    }
    const messages: Record<string, string> = {
      DOCUMENT_REWRITE_ACTIVE: "this document already has an active rewrite",
      DOCUMENT_REWRITE_QUOTA_REACHED: "document rewrite proposal quota reached; delete a retained proposal first",
      DOCUMENT_REWRITE_SELECTION_MISMATCH: "the selected text no longer matches this revision",
      DOCUMENT_REWRITE_STATE: "document rewrite state does not allow this transition",
      DOCUMENT_REWRITE_ALREADY_APPLIED: "this proposal was already applied",
    };
    reply.code(409).send({ error: messages[error.code] ?? "document rewrite conflict", code: error.code });
    return true;
  }
  if (error instanceof DocumentCleanupDeferredError) {
    reply.code(503).send({ error: "document cleanup deferred" });
    return true;
  }
  return false;
}

async function guarded<T>(reply: FastifyReply, operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (sendDocumentError(reply, error)) return undefined;
    throw error;
  }
}

// A builtin template id is a server constant: never stored, never editable.
function isBuiltinTemplateId(id: string): boolean {
  return getBuiltinDocumentTemplate(id) !== undefined;
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  // -- Documents ---------------------------------------------------------------

  app.get(
    "/api/documents",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const page = await guarded(reply, async () =>
        listDocumentCatalog(getAccountId(req), parseCatalogPageQuery("documents", req.query))
      );
      if (!page) return;
      return reply.send(catalogResponse("documents", { items: page.items.map(publicDocument), next: page.next }));
    }
  );

  app.post(
    "/api/documents",
    {
      onRequest: requireAuth,
      bodyLimit: DOCUMENT_REVISION_JSON_BODY_LIMIT_BYTES,
      schema: { body: documentCreateBodySchema },
    },
    async (req, reply) => {
      const body = req.body as {
        title?: string;
        tree?: Record<string, unknown>;
        template_id?: string;
        copy_from_report_id?: string;
      };
      const result = await guarded(reply, () =>
        createDocumentDraft({
          accountId: getAccountId(req),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.tree === undefined ? {} : { tree: body.tree as never }),
          ...(body.template_id === undefined ? {} : { templateId: body.template_id }),
          ...(body.copy_from_report_id === undefined ? {} : { copyFromReportId: body.copy_from_report_id }),
        })
      );
      if (!result) return;
      return reply
        .code(201)
        .send({ document: publicDocument(result.document), revision: publicRevision(result.revision) });
    }
  );

  app.get("/api/documents/:id", { onRequest: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const accountId = getAccountId(req);
    const documentId = (req.params as any).id;
    const document = await guarded(reply, async () => {
      const found = await getDocument(accountId, documentId);
      if (!found) throw new DocumentNotFoundError();
      return found;
    });
    if (!document) return;
    return reply.send(publicDocument(document));
  });

  app.delete(
    "/api/documents/:id",
    { onRequest: requireAuth, bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const outcome = await guarded(reply, () => deleteDocumentWithCleanup(getAccountId(req), (req.params as any).id));
      if (outcome === undefined) return;
      if (outcome === "not-found") return reply.code(404).send({ error: "not found", code: "DOCUMENT_NOT_FOUND" });
      if (outcome !== "deleted") return reply.code(503).send({ error: "document cleanup deferred" });
      return reply.send({ ok: true });
    }
  );

  // -- Revisions ---------------------------------------------------------------

  app.get(
    "/api/documents/:id/revisions",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const page = await guarded(reply, async () =>
        listDocumentRevisionHistory(
          accountId,
          (req.params as any).id,
          parseCatalogPageQuery("document_revisions", req.query)
        )
      );
      if (!page) return;
      return reply.send(
        catalogResponse("document_revisions", {
          items: page.items.map((summary) => ({
            id: summary.id,
            revision: summary.revision,
            title: summary.title,
            author_kind: summary.authorKind,
            base_revision_id: summary.baseRevisionId,
            payload_chars: summary.payloadChars,
            published_version: summary.publishedVersion,
            created_at: summary.createdAt,
          })),
          next: page.next,
        })
      );
    }
  );

  app.post(
    "/api/documents/:id/revisions",
    {
      onRequest: requireAuth,
      bodyLimit: DOCUMENT_REVISION_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: revisionSaveBodySchema },
    },
    async (req, reply) => {
      const body = req.body as { base_revision_id: string; tree: Record<string, unknown> };
      const result = await guarded(reply, () =>
        appendDocumentRevision({
          accountId: getAccountId(req),
          documentId: (req.params as any).id,
          baseRevisionId: body.base_revision_id,
          tree: body.tree as never,
          authorKind: "user",
        })
      );
      if (!result) return;
      return reply
        .code(201)
        .send({ document: publicDocument(result.document), revision: publicRevision(result.revision) });
    }
  );

  app.get(
    "/api/documents/:id/revisions/:revisionId",
    { onRequest: requireAuth, schema: { params: revisionIdParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const revision = await guarded(reply, async () => {
        const found = await getDocumentRevision(accountId, (req.params as any).id, (req.params as any).revisionId);
        if (!found) throw new DocumentRevisionNotFoundError();
        return found;
      });
      if (!revision) return;
      return reply.send(publicRevision(revision));
    }
  );

  // -- Diff ---------------------------------------------------------------------

  app.get(
    "/api/documents/:id/diff",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: documentDiffQuerySchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const query = req.query as { base: string; target: string };
      const result = await guarded(reply, () =>
        getDocumentDiff(accountId, (req.params as any).id, query.base, query.target)
      );
      if (!result) return;
      return reply.send(result);
    }
  );

  // -- Publications (stage-4 execution reserved) -----------------------------------

  app.get(
    "/api/documents/:id/publications",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const page = await guarded(reply, async () =>
        listDocumentPublications(
          accountId,
          (req.params as any).id,
          parseCatalogPageQuery("document_publications", req.query)
        )
      );
      if (!page) return;
      return reply.send(
        catalogResponse("document_publications", {
          items: page.items.map(publicPublication),
          next: page.next,
        })
      );
    }
  );

  // Publication execution (render + immutable publish) lands in M13 stage 4.
  // The route shape is reserved and documented; the service contract exists
  // in `documentStore.ts`, and the execution wiring returns 501 until then.
  app.post(
    "/api/documents/:id/revisions/:revisionId/publish",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: revisionIdParamsSchema, body: publicationStartBodySchema },
    },
    async (_req, reply) =>
      reply.code(501).send({
        error: "document publication is not available yet",
        code: "PUBLICATION_NOT_READY",
      })
  );

  // -- Model-assisted rewrites ---------------------------------------------------

  app.post(
    "/api/documents/:id/rewrites",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: rewriteCreateBodySchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      // Remote-egress consent is enforced before any payload persistence,
      // mirroring the chat-message gate; the runner rechecks before its
      // single bounded transport.
      if (!(await enforceRemoteEgressConsent(reply, accountId))) return;
      const body = req.body as {
        base_revision_id: string;
        section_id: string;
        range_start?: number;
        range_end?: number;
        selection_sha256: string;
        instruction: string;
      };
      const rewrite = await guarded(reply, () =>
        requestDocumentRewrite(accountId, (req.params as any).id, {
          baseRevisionId: body.base_revision_id,
          sectionId: body.section_id,
          rangeStart: body.range_start ?? null,
          rangeEnd: body.range_end ?? null,
          selectionSha256: body.selection_sha256,
          instruction: body.instruction,
        })
      );
      if (!rewrite) return;
      return reply.code(202).send(publicRewrite(rewrite));
    }
  );

  app.get(
    "/api/documents/:id/rewrites",
    { onRequest: requireAuth, schema: { params: idParamsSchema, querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const page = await guarded(reply, async () =>
        listDocumentRewrites(accountId, (req.params as any).id, parseCatalogPageQuery("document_rewrites", req.query))
      );
      if (!page) return;
      return reply.send(
        catalogResponse("document_rewrites", { items: page.items.map(publicRewrite), next: page.next })
      );
    }
  );

  app.get(
    "/api/documents/:id/rewrites/:rewriteId",
    { onRequest: requireAuth, schema: { params: rewriteIdParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const rewrite = await guarded(reply, async () => {
        const found = await getDocumentRewrite(accountId, (req.params as any).id, (req.params as any).rewriteId);
        if (!found) throw new DocumentRewriteNotFoundError();
        return found;
      });
      if (!rewrite) return;
      return reply.send(publicRewrite(rewrite));
    }
  );

  // Active operations cancel; terminal proposals delete (frees one quota slot).
  app.delete(
    "/api/documents/:id/rewrites/:rewriteId",
    { onRequest: requireAuth, bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES, schema: { params: rewriteIdParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const outcome = await guarded(reply, async () => {
        const documentId = (req.params as any).id;
        const rewriteId = (req.params as any).rewriteId;
        const current = await getDocumentRewrite(accountId, documentId, rewriteId);
        if (!current) throw new DocumentRewriteNotFoundError();
        if (current.status === "queued" || current.status === "running") {
          const cancel = await requestDocumentRewriteCancel(accountId, documentId, rewriteId);
          return Object.freeze({ action: cancel.outcome, rewrite: cancel.rewrite });
        }
        const deleted = await deleteDocumentRewrite(accountId, documentId, rewriteId);
        if (!deleted) throw new DocumentRewriteNotFoundError();
        return Object.freeze({ action: "deleted" as const, rewrite: null });
      });
      if (!outcome) return;
      return reply.send({
        ok: true,
        action: outcome.action,
        ...(outcome.rewrite ? { rewrite: publicRewrite(outcome.rewrite) } : {}),
      });
    }
  );

  // Revision-CAS acceptance; stale/conflicting proposals reject with the
  // current head metadata and the durable `stale` mark.
  app.post(
    "/api/documents/:id/rewrites/:rewriteId/accept",
    { onRequest: requireAuth, bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES, schema: { params: rewriteIdParamsSchema } },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const result = await guarded(reply, () =>
        acceptDocumentRewrite(accountId, (req.params as any).id, (req.params as any).rewriteId)
      );
      if (!result) return;
      return reply.code(201).send({
        document: publicDocument(result.result.document),
        revision: publicRevision(result.result.revision),
        rewrite: publicRewrite(result.rewrite),
      });
    }
  );

  // -- Document templates ---------------------------------------------------------

  app.get(
    "/api/document-templates",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const { page } = await listTemplateCatalog(
        getAccountId(req),
        parseCatalogPageQuery("document_templates", req.query)
      );
      const items = [
        ...BUILTIN_DOCUMENT_TEMPLATES.map((template) => publicBuiltinTemplate(template.id)),
        ...page.items.map(publicCustomTemplate),
      ];
      return reply.send(catalogResponse("document_templates", { items, next: page.next }));
    }
  );

  app.post(
    "/api/document-templates",
    {
      onRequest: requireAuth,
      bodyLimit: DOCUMENT_TEMPLATE_JSON_BODY_LIMIT_BYTES,
      schema: { body: templateCreateBodySchema },
    },
    async (req, reply) => {
      const body = req.body as { name: string; description?: string; document_id: string };
      const template = await guarded(reply, () =>
        createTemplateFromDocument({
          accountId: getAccountId(req),
          documentId: body.document_id,
          name: body.name,
          ...(body.description === undefined ? {} : { description: body.description }),
        })
      );
      if (!template) return;
      return reply.code(201).send(publicCustomTemplate(template));
    }
  );

  app.get(
    "/api/document-templates/:id",
    { onRequest: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const templateId = (req.params as any).id as string;
      if (isBuiltinTemplateId(templateId)) return reply.send(publicBuiltinTemplate(templateId));
      const custom = await guarded(reply, async () => {
        const found = await getCustomDocumentTemplate(getAccountId(req), templateId);
        if (!found) throw new DocumentTemplateNotFoundError();
        return found;
      });
      if (!custom) return;
      return reply.send(publicCustomTemplate(custom));
    }
  );

  app.patch(
    "/api/document-templates/:id",
    {
      onRequest: requireAuth,
      bodyLimit: DOCUMENT_TEMPLATE_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: templatePatchBodySchema },
    },
    async (req, reply) => {
      const templateId = (req.params as any).id as string;
      if (isBuiltinTemplateId(templateId)) {
        return reply.code(409).send({ error: "built-in templates are read-only", code: "BUILTIN_TEMPLATE_IMMUTABLE" });
      }
      const body = req.body as { name?: string; description?: string; expected_revision: number };
      const updated = await guarded(reply, () =>
        updateDocumentTemplate(getAccountId(req), templateId, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
          expectedRevision: body.expected_revision,
        })
      );
      if (!updated) return;
      return reply.send(publicCustomTemplate(updated));
    }
  );

  app.delete(
    "/api/document-templates/:id",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: templateDeleteBodySchema },
    },
    async (req, reply) => {
      const templateId = (req.params as any).id as string;
      if (isBuiltinTemplateId(templateId)) {
        return reply.code(409).send({ error: "built-in templates are read-only", code: "BUILTIN_TEMPLATE_IMMUTABLE" });
      }
      const deleted = await guarded(reply, () =>
        deleteDocumentTemplate(getAccountId(req), templateId, (req.body as any).expected_revision)
      );
      if (deleted === undefined) return;
      if (!deleted) return reply.code(404).send({ error: "not found", code: "DOCUMENT_NOT_FOUND" });
      return reply.send({ ok: true });
    }
  );
}
