/**
 * Owner-authenticated document service layer (M13 stage 2).
 *
 * This is the single internal entry point for document drafts, revision
 * appends, reading, diffing, deletion cleanup, publication, exports, and the
 * template catalog. M16
 * recipe runs call `createDocumentDraft` / `appendDocumentRevision` here;
 * they never write document tables directly. Every operation is scoped to an
 * already-authenticated account ID, carries an immutable payload through the
 * `documentTypes.ts` normalizer, and uses the store's base-revision compare-
 * and-swap — there is no silent-merge path anywhere in this module, and no
 * operation here issues model or SQL calls. Publication compiles one frozen
 * revision through the existing bounded renderer pipeline only after the
 * durable publication intent protocol in `documentStore.ts` is satisfied.
 */

import fs from "node:fs/promises";

import {
  DocumentRevisionNotFoundError,
  DocumentStoreError,
  type AcceptDocumentRewriteRequestInput,
  type BeginPublicationResult,
  type CreateDocumentResult,
  type DocumentRevisionSummary,
  type StoredDocument,
  type StoredDocumentPublication,
  type StoredDocumentPublicationIntent,
  type StoredDocumentRevision,
  type StoredDocumentRewrite,
} from "./db/stores/documentStore.js";
import { defaultDocumentRewriteRunner } from "./documentRewriteRunner.js";
import type { CatalogPageRequest, CatalogStorePage } from "./catalogPagination.js";
import { diffDocumentTrees, type DocumentRevisionDiff } from "./documentDiff.js";
import { completeDocumentArtifactCleanup, type DocumentCleanupSummary } from "./documentCleanup.js";
import {
  getBuiltinDocumentTemplate,
  instantiateTemplateTree,
  templateSnapshotFromTree,
  type DocumentTemplateSnapshot,
} from "./documentTemplates.js";
import type { StoredDocumentTemplate } from "./db/stores/documentTemplateStore.js";
import { DocumentValidationError, type DocumentTreeInput } from "./documentTypes.js";
import {
  compileDocumentPublication,
  DocumentFormatError,
  DOCUMENT_ARTIFACT_FILENAMES,
  type DocumentExportFormat,
  type DocumentRenderers,
} from "./data/documents.js";
import {
  createDocumentPublicationDirectory,
  removeDocumentPublicationArtifacts,
  resolveDocumentPublicationFile,
} from "./storageArtifacts.js";
import { storageRuntime } from "./storageRuntime.js";

export class DocumentCleanupDeferredError extends Error {
  constructor() {
    super("document artifact cleanup deferred");
    this.name = "DocumentCleanupDeferredError";
  }
}

export interface CreateDocumentDraftInput {
  readonly accountId: string;
  /** Required for blank drafts; optional override for copies/templates. */
  readonly title?: string;
  /** Exactly one creation shape: raw tree, built-in template, or report copy. */
  readonly tree?: DocumentTreeInput;
  readonly templateId?: string;
  readonly copyFromReportId?: string;
}

/**
 * Creates a document with its revision 1: a blank draft, an instantiated
 * built-in/custom template draft (never auto-bound to sources or data), or an
 * editable copy of an owned legacy report through the store's copy protocol.
 */
export async function createDocumentDraft(input: CreateDocumentDraftInput): Promise<CreateDocumentResult> {
  const { accountId } = input;
  const shapes = [input.tree !== undefined, input.templateId !== undefined, input.copyFromReportId !== undefined];
  if (shapes.filter(Boolean).length > 1) {
    throw new DocumentValidationError("DOCUMENT_INVALID", "exactly one of tree, template_id, or copy source");
  }
  if (input.copyFromReportId !== undefined) {
    return storageRuntime().documents.createEditableCopy(accountId, input.copyFromReportId);
  }
  if (input.templateId !== undefined) {
    const snapshot = await resolveTemplateSnapshotForAccount(accountId, input.templateId);
    return storageRuntime().documents.createDocument(accountId, {
      title: input.title?.trim() || snapshot.title,
      tree: instantiateTemplateTree(snapshot, input.title),
    });
  }
  const title = (input.title ?? "").trim() || "Untitled document";
  const tree = input.tree ?? { title, sections: [], charts: [], tables: [], evidence: [] };
  return storageRuntime().documents.createDocument(accountId, { title, tree });
}

export interface AppendDocumentRevisionInput {
  readonly accountId: string;
  readonly documentId: string;
  /** Must equal the current head revision UUID; a stale write conflicts. */
  readonly baseRevisionId: string;
  readonly tree: DocumentTreeInput;
  readonly authorKind?: "user" | "model" | "automation";
}

/**
 * Appends one immutable full-snapshot revision under base-revision CAS. The
 * title carried by the payload becomes the document title, so exports and
 * listings always agree with the revision they came from.
 */
export async function appendDocumentRevision(input: AppendDocumentRevisionInput): Promise<CreateDocumentResult> {
  return storageRuntime().documents.saveDocumentRevision(input.accountId, input.documentId, {
    baseRevisionId: input.baseRevisionId,
    tree: input.tree,
    authorKind: input.authorKind ?? "user",
  });
}

export async function listDocumentCatalog(
  accountId: string,
  page: CatalogPageRequest
): Promise<CatalogStorePage<StoredDocument>> {
  return storageRuntime().documents.listDocuments(accountId, page);
}

export async function getDocument(accountId: string, documentId: string): Promise<StoredDocument | undefined> {
  return storageRuntime().documents.getDocument(accountId, documentId);
}

export async function listDocumentRevisionHistory(
  accountId: string,
  documentId: string,
  page: CatalogPageRequest
): Promise<CatalogStorePage<DocumentRevisionSummary>> {
  return storageRuntime().documents.listDocumentRevisions(accountId, documentId, page);
}

export async function getDocumentRevision(
  accountId: string,
  documentId: string,
  revisionId: string
): Promise<StoredDocumentRevision | undefined> {
  return storageRuntime().documents.getDocumentRevision(accountId, documentId, revisionId);
}

export async function listDocumentPublications(
  accountId: string,
  documentId: string,
  page: CatalogPageRequest
): Promise<CatalogStorePage<StoredDocumentPublication>> {
  return storageRuntime().documents.listDocumentPublications(accountId, documentId, page);
}

export async function getLatestDocumentPublicationIntent(
  accountId: string,
  documentId: string
): Promise<StoredDocumentPublicationIntent | undefined> {
  return storageRuntime().documents.getLatestDocumentPublicationIntent(accountId, documentId);
}

// ---------------------------------------------------------------------------
// Publication (M13 stage 4)
// ---------------------------------------------------------------------------

/**
 * In-process render ownership map enforcing one active render/publication per
 * document within this process. The durable one-active-intent guarantee is the
 * store's partial unique index; this map is what makes a replay of the same
 * operation UUID while the render is still running return status instead of
 * starting a second render.
 */
const activeRenderings = new Set<string>();

/**
 * Test-only renderer override (mirrors the `__renderIsolatedHtmlPdfForTests`
 * seam): lets route-level tests exercise the full publication protocol
 * deterministically without launching a real browser. The shipped default
 * remains the Playwright/Electron dispatch in `data/documents.ts`, which the
 * serialized integration suite proves end-to-end.
 */
let testRenderers: DocumentRenderers | null = null;

export function setDocumentRenderersForTests(renderers: DocumentRenderers | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only renderer seam");
  testRenderers = renderers;
}

export interface PublishDocumentRevisionInput {
  readonly accountId: string;
  readonly documentId: string;
  /** Explicit revision target (the route path). */
  readonly revisionId: string;
  readonly operationId: string;
  readonly expectedRevisionId?: string | null;
  readonly allowNonHeadRevision?: boolean;
  readonly renderers?: DocumentRenderers;
}

export type PublishDocumentOutcome =
  | { readonly kind: "published"; readonly publication: StoredDocumentPublication; readonly replayed: boolean }
  | { readonly kind: "rendering"; readonly intent: StoredDocumentPublicationIntent };

export class DocumentPublicationRenderError extends Error {
  readonly code: string;

  constructor(code: string, options: ErrorOptions = {}) {
    super("document publication render failed", options);
    this.name = "DocumentPublicationRenderError";
    this.code = code;
  }
}

function publicationTimestamp(value = new Date()): string {
  return value
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

/**
 * Publishes one frozen revision: begin (or idempotently replay) the durable
 * intent, compile the SAME revision into all four artifacts through the
 * existing bounded renderer pipeline into the exact
 * account/document/publication UUID-scoped directory, verify every magic
 * byte, then transactionally assign the next publication version only after
 * all required artifacts exist. Any per-format failure records a durable
 * retryable failure, removes the exact partial directory best-effort, and
 * leaves the draft, the head, and the previous publication untouched.
 * Startup `repairDocumentPublications()` recovers interrupted renders.
 */
export async function publishDocumentRevision(input: PublishDocumentRevisionInput): Promise<PublishDocumentOutcome> {
  const { accountId, documentId } = input;
  const documents = storageRuntime().documents;
  const begin = await documents.beginDocumentPublication(accountId, documentId, {
    operationId: input.operationId,
    revisionId: input.revisionId,
    expectedRevisionId: input.expectedRevisionId ?? null,
    allowNonHeadRevision: input.allowNonHeadRevision === true,
  });
  const intent = begin.intent;
  if (intent.status === "completed") {
    const publication = await documents.getDocumentPublication(accountId, documentId, intent.publicationId ?? "");
    if (publication) return { kind: "published", publication, replayed: true };
  }
  if (intent.status === "ready") {
    // Artifacts were recorded but completion was interrupted in-process; the
    // completion transaction is idempotent.
    const done = await documents.completeDocumentPublication(accountId, documentId, input.operationId);
    return { kind: "published", publication: done.publication, replayed: true };
  }
  const renderKey = `${accountId}:${documentId}`;
  if (activeRenderings.has(renderKey)) return { kind: "rendering", intent };
  activeRenderings.add(renderKey);
  try {
    const revision = await documents.getDocumentRevision(accountId, documentId, intent.revisionId);
    if (!revision) throw new DocumentRevisionNotFoundError();
    const history = await documents.listDocumentPublications(accountId, documentId);
    const nextVersion = (history.items[0]?.version ?? 0) + 1;
    const directory = await createDocumentPublicationDirectory(accountId, documentId, intent.id);
    if (directory !== intent.artifactDirectory) {
      throw new DocumentPublicationRenderError("PUBLICATION_RENDER_FAILED");
    }
    let compiled;
    try {
      compiled = await compileDocumentPublication({
        accountId,
        directory,
        tree: revision.payload,
        meta: { documentId, revisionId: intent.revisionId, revision: intent.revision, version: nextVersion },
        generatedAt: publicationTimestamp(),
        ...(input.renderers ? { renderers: input.renderers } : testRenderers ? { renderers: testRenderers } : {}),
      });
    } catch (error) {
      throw error instanceof DocumentFormatError
        ? new DocumentPublicationRenderError(error.code, { cause: error })
        : new DocumentPublicationRenderError("PUBLICATION_RENDER_FAILED", { cause: error });
    }
    await fs.writeFile(compiled.htmlPath, compiled.html);
    await fs.writeFile(compiled.pdfPath, compiled.pdf);
    await fs.writeFile(compiled.markdownPath, compiled.markdownZip);
    await fs.writeFile(compiled.docxPath, compiled.docx);
    await documents.markDocumentPublicationReady(accountId, documentId, input.operationId, {
      htmlPath: compiled.htmlPath,
      pdfPath: compiled.pdfPath,
    });
    const done = await documents.completeDocumentPublication(accountId, documentId, input.operationId);
    return { kind: "published", publication: done.publication, replayed: done.replayed };
  } catch (error) {
    const code = error instanceof DocumentPublicationRenderError ? error.code : "PUBLICATION_RENDER_FAILED";
    await documents
      .failDocumentPublication(accountId, documentId, input.operationId, { errorCode: code })
      .catch(() => {});
    // Exact-directory cleanup of the partial attempt; if this removal fails
    // the durable document deletion (or the next retry reusing the exact
    // intent directory) still owns every byte.
    await removeDocumentPublicationArtifacts({
      accountId,
      documentId,
      publicationId: intent.id,
      directory: intent.artifactDirectory,
    }).catch(() => {});
    throw error;
  } finally {
    activeRenderings.delete(renderKey);
  }
}

export interface DocumentPublicationExport {
  readonly publication: StoredDocumentPublication;
  readonly filePath: string;
  readonly fileName: string;
}

/** Resolves one frozen publication's artifact for an owner-only download. */
export async function getDocumentPublicationExport(
  accountId: string,
  documentId: string,
  publicationId: string,
  format: DocumentExportFormat
): Promise<DocumentPublicationExport | undefined> {
  const publication = await storageRuntime().documents.getDocumentPublication(accountId, documentId, publicationId);
  if (!publication) return undefined;
  const fileName = DOCUMENT_ARTIFACT_FILENAMES[format];
  const filePath = await resolveDocumentPublicationFile({
    accountId,
    documentId,
    recordedHtmlPath: publication.htmlPath,
    fileName,
  });
  if (!filePath) return undefined;
  return { publication, filePath, fileName };
}

/**
 * Deterministic bounded diff between two revisions of the same document.
 * Both endpoints must exist in this account's scope; a missing endpoint is a
 * revision-not-found failure, never a partial diff.
 */
export async function getDocumentDiff(
  accountId: string,
  documentId: string,
  baseRevisionId: string,
  targetRevisionId: string
): Promise<DocumentRevisionDiff> {
  const [base, target] = await Promise.all([
    getDocumentRevision(accountId, documentId, baseRevisionId),
    getDocumentRevision(accountId, documentId, targetRevisionId),
  ]);
  if (!base || !target) {
    throw new DocumentStoreError("DOCUMENT_REVISION_NOT_FOUND", "document revision not found");
  }
  return diffDocumentTrees(base.payload, target.payload, {
    base: { revision_id: base.id, revision: base.revision, title: base.title },
    target: { revision_id: target.id, revision: target.revision, title: target.title },
  });
}

/**
 * Hides the document and completes its durable artifact cleanup eagerly; a
 * failed filesystem cleanup keeps the intent durable and raises
 * `DocumentCleanupDeferredError` (mirrors the legacy report deletion route).
 */
export async function deleteDocumentWithCleanup(
  accountId: string,
  documentId: string
): Promise<"deleted" | "not-found" | DocumentCleanupSummary> {
  const intent = await storageRuntime().documents.deleteDocument(accountId, documentId);
  if (!intent) return "not-found";
  const cleanup = await completeDocumentArtifactCleanup([intent]);
  if (cleanup.failed) return cleanup;
  return "deleted";
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplateCatalog(
  accountId: string,
  page: CatalogPageRequest
): Promise<{ page: CatalogStorePage<StoredDocumentTemplate> }> {
  return { page: await storageRuntime().documentTemplates.listTemplates(accountId, page) };
}

/** Resolves a built-in (server constant) or account-owned custom snapshot. */
export async function resolveTemplateSnapshotForAccount(
  accountId: string,
  templateId: string
): Promise<DocumentTemplateSnapshot> {
  const builtin = getBuiltinDocumentTemplate(templateId);
  if (builtin) return builtin.snapshot;
  const custom = await storageRuntime().documentTemplates.getTemplate(accountId, templateId);
  if (!custom) throw new DocumentStoreError("DOCUMENT_NOT_FOUND", "document template not found");
  return custom.snapshot;
}

/**
 * "Save as template": snapshots the document's current head revision through
 * the codec, which strips every derived field (evidence excerpts, table
 * results, chart values, provenance, bindings) before the store sees it.
 */
export async function createTemplateFromDocument(input: {
  accountId: string;
  documentId: string;
  name: string;
  description?: string;
}): Promise<StoredDocumentTemplate> {
  const { accountId, documentId } = input;
  const document = await storageRuntime().documents.getDocument(accountId, documentId);
  if (!document) throw new DocumentStoreError("DOCUMENT_NOT_FOUND", "document not found");
  const head = await storageRuntime().documents.getDocumentRevision(accountId, documentId, document.currentRevisionId);
  if (!head) throw new DocumentStoreError("DOCUMENT_REVISION_NOT_FOUND", "document head revision not found");
  const snapshot = templateSnapshotFromTree(head.payload);
  return storageRuntime().documentTemplates.createTemplate(accountId, {
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    snapshot,
  });
}

export async function getCustomDocumentTemplate(
  accountId: string,
  templateId: string
): Promise<StoredDocumentTemplate | undefined> {
  return storageRuntime().documentTemplates.getTemplate(accountId, templateId);
}

export async function updateDocumentTemplate(
  accountId: string,
  templateId: string,
  input: { name?: string; description?: string; expectedRevision: number }
): Promise<StoredDocumentTemplate> {
  return storageRuntime().documentTemplates.updateTemplate(accountId, templateId, input);
}

export async function deleteDocumentTemplate(
  accountId: string,
  templateId: string,
  expectedRevision: number
): Promise<boolean> {
  return storageRuntime().documentTemplates.deleteTemplate(accountId, templateId, expectedRevision);
}

// ---------------------------------------------------------------------------
// Model-assisted rewrites (M13 stage 3)
// ---------------------------------------------------------------------------

/**
 * Durably accepts one rewrite request against an exact base revision and
 * selection, then dispatches it to the registered rewrite executor when one
 * is live. The durable `queued` row is the contract: without a live executor
 * the request simply waits for the next startup resume. This function itself
 * performs no model call; the consent gate lives on the route (before any
 * payload persistence) and is rechecked by the runner before its single
 * bounded transport.
 */
export async function requestDocumentRewrite(
  accountId: string,
  documentId: string,
  input: AcceptDocumentRewriteRequestInput
): Promise<StoredDocumentRewrite> {
  const rewrite = await storageRuntime().documents.acceptDocumentRewriteRequest(accountId, documentId, input);
  defaultDocumentRewriteRunner()?.dispatch(rewrite);
  return rewrite;
}

export async function listDocumentRewrites(
  accountId: string,
  documentId: string,
  page: CatalogPageRequest
): Promise<CatalogStorePage<StoredDocumentRewrite>> {
  return storageRuntime().documents.listDocumentRewrites(accountId, documentId, page);
}

export async function getDocumentRewrite(
  accountId: string,
  documentId: string,
  rewriteId: string
): Promise<StoredDocumentRewrite | undefined> {
  return storageRuntime().documents.getDocumentRewrite(accountId, documentId, rewriteId);
}

export async function requestDocumentRewriteCancel(
  accountId: string,
  documentId: string,
  rewriteId: string
): Promise<{ rewrite: StoredDocumentRewrite; outcome: "cancelled" | "cancelling" | "terminal" }> {
  return storageRuntime().documents.requestDocumentRewriteCancel(accountId, documentId, rewriteId);
}

export async function deleteDocumentRewrite(
  accountId: string,
  documentId: string,
  rewriteId: string
): Promise<boolean> {
  return storageRuntime().documents.deleteDocumentRewrite(accountId, documentId, rewriteId);
}

/**
 * Revision-CAS acceptance of a completed proposal into a new model-authored
 * draft revision. Stale proposals reject with the current head metadata and
 * are durably marked inspectable-only; applied proposals apply exactly once.
 */
export async function acceptDocumentRewrite(
  accountId: string,
  documentId: string,
  rewriteId: string
): Promise<{ rewrite: StoredDocumentRewrite; result: CreateDocumentResult }> {
  return storageRuntime().documents.applyDocumentRewriteProposal(accountId, documentId, rewriteId);
}

// Re-exported so callers (and the reserved publication routes) can name the
// store result shape without importing the store module directly.
export type { BeginPublicationResult };
