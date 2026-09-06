/**
 * Owner-authenticated document service layer (M13 stage 2).
 *
 * This is the single internal entry point for document drafts, revision
 * appends, reading, diffing, deletion cleanup, and the template catalog. M16
 * recipe runs call `createDocumentDraft` / `appendDocumentRevision` here;
 * they never write document tables directly. Every operation is scoped to an
 * already-authenticated account ID, carries an immutable payload through the
 * `documentTypes.ts` normalizer, and uses the store's base-revision compare-
 * and-swap — there is no silent-merge path anywhere in this module, and no
 * operation here issues model or SQL calls.
 */

import {
  DocumentStoreError,
  type AcceptDocumentRewriteRequestInput,
  type BeginPublicationResult,
  type CreateDocumentResult,
  type DocumentRevisionSummary,
  type StoredDocument,
  type StoredDocumentPublication,
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
