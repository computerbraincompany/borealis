import path from "node:path";
import { randomUUID } from "node:crypto";

import { decodeBoolean, decodeIsoTimestamp, decodeJson, decodeSafeInteger, encodeIsoTimestamp } from "../codecs.js";
import type { SqliteLedger, SqliteTransaction } from "../types.js";
import { SqliteConstraintError } from "../types.js";
import {
  catalogStorePage,
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../../catalogPagination.js";
import {
  DocumentValidationError,
  DOCUMENT_AUTHOR_KINDS,
  documentTreeFromLegacyReport,
  normalizeDocumentTree,
  parseDocumentTreePayload,
  type DocumentAuthorKind,
  type DocumentTree,
  type DocumentTreeInput,
} from "../../documentTypes.js";
import { documentPublicationDirectory } from "../../storageArtifacts.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DocumentStoreErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_REVISION_NOT_FOUND"
  | "DOCUMENT_REVISION_CONFLICT"
  | "DOCUMENT_UNAVAILABLE"
  | "DOCUMENT_PUBLICATION_ACTIVE"
  | "DOCUMENT_PUBLICATION_STATE"
  | "DOCUMENT_HEAD_MOVED"
  | "DOCUMENT_REVISION_SELECTION";

export class DocumentStoreError extends Error {
  constructor(
    readonly code: DocumentStoreErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "DocumentStoreError";
  }
}

export class DocumentNotFoundError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_NOT_FOUND", "document not found", options);
    this.name = "DocumentNotFoundError";
  }
}

export class DocumentRevisionNotFoundError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_REVISION_NOT_FOUND", "document revision not found", options);
    this.name = "DocumentRevisionNotFoundError";
  }
}

/** Metadata of the live head carried on every lost compare-and-swap. */
export interface DocumentHeadMetadata {
  readonly revisionId: string;
  readonly revision: number;
  readonly title: string;
  readonly authorKind: DocumentAuthorKind;
  readonly updatedAt: string;
}

/**
 * Stale write. The caller must preserve the local draft and offer a
 * diff/reload or explicit reapply; the server never merges onto newer text.
 * `currentHead` is authoritative head state at the moment the CAS failed.
 */
export class DocumentRevisionConflictError extends DocumentStoreError {
  constructor(
    readonly currentHead: DocumentHeadMetadata,
    options: ErrorOptions = {}
  ) {
    super("DOCUMENT_REVISION_CONFLICT", "document revision compare-and-swap failed", options);
    this.name = "DocumentRevisionConflictError";
  }
}

/** The origin exists but cannot produce an editable copy (legacy payload). */
export class DocumentUnavailableError extends DocumentStoreError {
  constructor(message = "editable copy is unavailable for this report", options: ErrorOptions = {}) {
    super("DOCUMENT_UNAVAILABLE", message, options);
    this.name = "DocumentUnavailableError";
  }
}

export class DocumentPublicationActiveError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_PUBLICATION_ACTIVE", "document already has an active publication", options);
    this.name = "DocumentPublicationActiveError";
  }
}

export class DocumentPublicationStateError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_PUBLICATION_STATE", "document publication intent is not in a state for this transition", options);
    this.name = "DocumentPublicationStateError";
  }
}

export class DocumentHeadMovedError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_HEAD_MOVED", "the document head changed since this publication was requested", options);
    this.name = "DocumentHeadMovedError";
  }
}

export class DocumentRevisionSelectionError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super(
      "DOCUMENT_REVISION_SELECTION",
      "publishing a non-head revision requires an explicit revision selection",
      options
    );
    this.name = "DocumentRevisionSelectionError";
  }
}

export { DocumentValidationError };

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export interface DocumentStoreOptions {
  readonly now?: () => Date;
  /**
   * Lexical (never filesystem-touching) derivation of the exact
   * account/document/publication artifact directory. Defaults to the shipped
   * report-directory `documents` namespace in `storageArtifacts.ts`.
   */
  readonly publicationDirectory?: (accountId: string, documentId: string, publicationId: string) => string;
}

export interface DocumentOriginLinks {
  readonly reportId: string | null;
  readonly chatId: string | null;
  readonly runId: string | null;
  readonly analysisResultId: string | null;
}

export interface StoredDocument {
  readonly id: string;
  readonly accountId: string;
  readonly title: string;
  readonly currentRevision: number;
  readonly currentRevisionId: string;
  readonly headAuthorKind: DocumentAuthorKind;
  readonly origin: DocumentOriginLinks;
  readonly latestPublicationVersion: number | null;
  readonly revisionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredDocumentRevision {
  readonly id: string;
  readonly documentId: string;
  readonly accountId: string;
  readonly revision: number;
  readonly title: string;
  readonly authorKind: DocumentAuthorKind;
  readonly baseRevisionId: string | null;
  readonly payload: DocumentTree;
  readonly payloadChars: number;
  readonly createdAt: string;
}

export interface DocumentRevisionSummary {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly authorKind: DocumentAuthorKind;
  readonly baseRevisionId: string | null;
  readonly payloadChars: number;
  readonly publishedVersion: number | null;
  readonly createdAt: string;
}

export type DocumentPublicationStatus = "rendering" | "ready" | "completed" | "failed";

export interface StoredDocumentPublicationIntent {
  readonly id: string;
  readonly accountId: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly operationId: string;
  readonly explicitRevisionSelection: boolean;
  readonly status: DocumentPublicationStatus;
  readonly artifactDirectory: string;
  readonly htmlPath: string | null;
  readonly pdfPath: string | null;
  readonly errorCode: string | null;
  readonly errorReason: string | null;
  readonly publicationId: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredDocumentPublication {
  readonly id: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly version: number;
  readonly title: string;
  readonly supersedes: string | null;
  readonly htmlPath: string;
  readonly pdfPath: string;
  readonly createdAt: string;
}

export interface DocumentArtifactCleanupIntent {
  readonly documentId: string;
  readonly accountId: string;
  readonly attempts: number;
}

export interface DocumentPublicationCleanupJob {
  readonly id: string;
  readonly accountId: string;
  readonly documentId: string;
  readonly artifactDirectory: string;
  readonly attempts: number;
}

export interface BeginPublicationInput {
  /** Client operation UUID; a retry with the same UUID is idempotent. */
  readonly operationId: string;
  /** Omitted or null publishes the current head revision. */
  readonly revisionId?: string | null;
  /** Optional optimistic head guard for the request that starts the render. */
  readonly expectedRevisionId?: string | null;
  /** Required to start a publication of an explicitly selected non-head revision. */
  readonly allowNonHeadRevision?: boolean;
}

export interface BeginPublicationResult {
  readonly intent: StoredDocumentPublicationIntent;
  /** True when an existing non-failed intent for the operation was replayed. */
  readonly replayed: boolean;
}

export interface CreateDocumentInput {
  readonly title: string;
  /** Full tree input; absent creates a blank document with this title. */
  readonly tree?: DocumentTreeInput;
  readonly origin?: Partial<DocumentOriginLinks>;
}

export interface SaveDocumentRevisionInput {
  /** Must equal the current head revision UUID; a stale write conflicts. */
  readonly baseRevisionId: string;
  readonly tree: DocumentTreeInput;
  readonly authorKind: DocumentAuthorKind;
}

export interface CreateDocumentResult {
  readonly document: StoredDocument;
  readonly revision: StoredDocumentRevision;
}

// ---------------------------------------------------------------------------
// Row decoding
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function optionalUuid(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  return uuidIdentity(value, field);
}

function textValue(value: string, field: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    (!allowEmpty && value.length < 1) ||
    value.length > maximum
  ) {
    throw new TypeError(`${field} violates the document store input contract`);
  }
  return value;
}

function optionalText(value: string | null | undefined, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return textValue(value, field, maximum);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is not stored as text`);
  return value;
}

function optionalStoredString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function authorKind(value: unknown): DocumentAuthorKind {
  if ((DOCUMENT_AUTHOR_KINDS as readonly string[]).includes(String(value))) return value as DocumentAuthorKind;
  throw new TypeError("document author kind violates the document store contract");
}

function publicationStatus(value: unknown): DocumentPublicationStatus {
  if (value === "rendering" || value === "ready" || value === "completed" || value === "failed") return value;
  throw new TypeError("document publication status violates the document store contract");
}

interface DocumentRow {
  id?: unknown;
  account_id?: unknown;
  title?: unknown;
  current_revision?: unknown;
  head_revision_id?: unknown;
  head_author_kind?: unknown;
  origin_report_id?: unknown;
  origin_chat_id?: unknown;
  origin_run_id?: unknown;
  origin_analysis_result_id?: unknown;
  latest_publication_version?: unknown;
  revision_count?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface RevisionRow {
  id?: unknown;
  document_id?: unknown;
  account_id?: unknown;
  revision?: unknown;
  title?: unknown;
  payload?: unknown;
  author_kind?: unknown;
  base_revision_id?: unknown;
  payload_chars?: unknown;
  published_version?: unknown;
  created_at?: unknown;
}

interface PublicationRow {
  id?: unknown;
  document_id?: unknown;
  revision_id?: unknown;
  revision?: unknown;
  version?: unknown;
  title?: unknown;
  supersedes?: unknown;
  html_path?: unknown;
  pdf_path?: unknown;
  created_at?: unknown;
}

interface IntentRow {
  id?: unknown;
  account_id?: unknown;
  document_id?: unknown;
  revision_id?: unknown;
  revision?: unknown;
  operation_id?: unknown;
  explicit_revision_selection?: unknown;
  status?: unknown;
  artifact_directory?: unknown;
  html_path?: unknown;
  pdf_path?: unknown;
  error_code?: unknown;
  error_reason?: unknown;
  publication_id?: unknown;
  attempts?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface CleanupJobRow {
  document_id?: unknown;
  id?: unknown;
  account_id?: unknown;
  artifact_directory?: unknown;
  attempts?: unknown;
}

interface ReportPayloadRow {
  id?: unknown;
  account_id?: unknown;
  title?: unknown;
  chat_id?: unknown;
  payload?: unknown;
}

const DOCUMENT_COLUMNS = `d.id,d.account_id,d.title,d.current_revision,d.origin_report_id,d.origin_chat_id,
  d.origin_run_id,d.origin_analysis_result_id,d.created_at,d.updated_at,
  h.id AS head_revision_id,h.author_kind AS head_author_kind`;

const DOCUMENT_AGGREGATES = `(SELECT MAX(p.version) FROM document_publications p
                WHERE p.document_id=d.id AND p.account_id=d.account_id) AS latest_publication_version,
              (SELECT COUNT(*) FROM document_revisions r
                WHERE r.document_id=d.id AND r.account_id=d.account_id) AS revision_count`;

const INTENT_COLUMNS = `id,account_id,document_id,revision_id,revision,operation_id,explicit_revision_selection,
  status,artifact_directory,html_path,pdf_path,error_code,error_reason,publication_id,attempts,created_at,updated_at`;

const PUBLICATION_COLUMNS = `id,document_id,revision_id,revision,version,title,supersedes,html_path,pdf_path,created_at`;

function decodeDocument(row: DocumentRow): StoredDocument {
  return Object.freeze({
    id: uuidIdentity(row.id, "document id"),
    accountId: uuidIdentity(row.account_id, "document account id"),
    title: requiredString(row.title, "document title"),
    currentRevision: decodeSafeInteger(row.current_revision, "document current revision"),
    currentRevisionId: uuidIdentity(row.head_revision_id, "document head revision id"),
    headAuthorKind: authorKind(row.head_author_kind),
    origin: Object.freeze({
      reportId: optionalStoredString(row.origin_report_id, "document origin report id"),
      chatId: optionalStoredString(row.origin_chat_id, "document origin chat id"),
      runId: optionalStoredString(row.origin_run_id, "document origin run id"),
      analysisResultId: optionalStoredString(row.origin_analysis_result_id, "document origin analysis result id"),
    }),
    latestPublicationVersion:
      row.latest_publication_version === null || row.latest_publication_version === undefined
        ? null
        : decodeSafeInteger(row.latest_publication_version, "document latest publication version"),
    revisionCount: decodeSafeInteger(row.revision_count ?? 0, "document revision count"),
    createdAt: decodeIsoTimestamp(row.created_at, "document created_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "document updated_at"),
  });
}

function decodeRevision(row: RevisionRow): StoredDocumentRevision {
  const payloadText = requiredString(row.payload, "document revision payload");
  return Object.freeze({
    id: uuidIdentity(row.id, "document revision id"),
    documentId: uuidIdentity(row.document_id, "document revision document id"),
    accountId: uuidIdentity(row.account_id, "document revision account id"),
    revision: decodeSafeInteger(row.revision, "document revision number"),
    title: requiredString(row.title, "document revision title"),
    authorKind: authorKind(row.author_kind),
    baseRevisionId:
      row.base_revision_id === null || row.base_revision_id === undefined
        ? null
        : uuidIdentity(row.base_revision_id, "document revision base id"),
    payload: parseDocumentTreePayload(payloadText),
    payloadChars: payloadText.length,
    createdAt: decodeIsoTimestamp(row.created_at, "document revision created_at"),
  });
}

function decodeRevisionSummary(row: RevisionRow): DocumentRevisionSummary {
  return Object.freeze({
    id: uuidIdentity(row.id, "document revision id"),
    revision: decodeSafeInteger(row.revision, "document revision number"),
    title: requiredString(row.title, "document revision title"),
    authorKind: authorKind(row.author_kind),
    baseRevisionId:
      row.base_revision_id === null || row.base_revision_id === undefined
        ? null
        : uuidIdentity(row.base_revision_id, "document revision base id"),
    payloadChars: decodeSafeInteger(row.payload_chars, "document revision payload characters"),
    publishedVersion:
      row.published_version === null || row.published_version === undefined
        ? null
        : decodeSafeInteger(row.published_version, "document revision published version"),
    createdAt: decodeIsoTimestamp(row.created_at, "document revision created_at"),
  });
}

function decodePublication(row: PublicationRow): StoredDocumentPublication {
  return Object.freeze({
    id: uuidIdentity(row.id, "document publication id"),
    documentId: uuidIdentity(row.document_id, "publication document id"),
    revisionId: uuidIdentity(row.revision_id, "publication revision id"),
    revision: decodeSafeInteger(row.revision, "publication revision number"),
    version: decodeSafeInteger(row.version, "publication version"),
    title: requiredString(row.title, "publication title"),
    supersedes:
      row.supersedes === null || row.supersedes === undefined
        ? null
        : uuidIdentity(row.supersedes, "publication supersedes id"),
    htmlPath: requiredString(row.html_path, "publication html_path"),
    pdfPath: requiredString(row.pdf_path, "publication pdf_path"),
    createdAt: decodeIsoTimestamp(row.created_at, "publication created_at"),
  });
}

function decodeIntent(row: IntentRow): StoredDocumentPublicationIntent {
  return Object.freeze({
    id: uuidIdentity(row.id, "publication intent id"),
    accountId: uuidIdentity(row.account_id, "publication intent account id"),
    documentId: uuidIdentity(row.document_id, "publication intent document id"),
    revisionId: uuidIdentity(row.revision_id, "publication intent revision id"),
    revision: decodeSafeInteger(row.revision, "publication intent revision number"),
    operationId: requiredString(row.operation_id, "publication operation id"),
    explicitRevisionSelection: decodeBoolean(row.explicit_revision_selection, "explicit revision selection"),
    status: publicationStatus(row.status),
    artifactDirectory: requiredString(row.artifact_directory, "publication artifact directory"),
    htmlPath: optionalStoredString(row.html_path, "publication html_path"),
    pdfPath: optionalStoredString(row.pdf_path, "publication pdf_path"),
    errorCode: optionalStoredString(row.error_code, "publication error_code"),
    errorReason: optionalStoredString(row.error_reason, "publication error_reason"),
    publicationId:
      row.publication_id === null || row.publication_id === undefined
        ? null
        : uuidIdentity(row.publication_id, "publication id"),
    attempts: decodeSafeInteger(row.attempts, "publication attempts"),
    createdAt: decodeIsoTimestamp(row.created_at, "publication intent created_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "publication intent updated_at"),
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Owner-scoped document ledger (schema v20).
 *
 * Concurrency and durability contract:
 * - Revisions append with `base_revision_id` compare-and-swap against the
 *   head; a stale write raises `DocumentRevisionConflictError` carrying the
 *   current head metadata and never persists a revision row (each append is
 *   one immediate transaction). There is no silent merge path.
 * - Revision and publication rows are immutable: SQL UPDATE statements fail
 *   on the schema v20 triggers, and the store itself never issues them. A
 *   rename or title edit appends a new revision; no published revision is
 *   rewritten by rename or editing.
 * - Title updates are revision-checked and every revision payload carries
 *   its own title, so an export's title always agrees with the revision it
 *   was exported from.
 * - Per-document publication versions are assigned only inside the
 *   completion transaction, after the render recorded both required artifact
 *   paths; the one-active-intent partial index serializes this per document.
 * - Retention is unlimited at the payload/compile bounds; no count quota is
 *   applied here (the 100-proposal limit is a separate stage-3 table).
 * - Copies from legacy reports freeze the stored payload plus server-verified
 *   origin links; the legacy report row, its per-chat version chain, and its
 *   shares are never rewritten, and the copy survives later source/report/
 *   chat deletion because origin links are opaque bounded text.
 */
export class DocumentStore {
  private readonly now: () => Date;
  private readonly publicationDirectory:
    ((accountId: string, documentId: string, publicationId: string) => string) | null;

  constructor(
    private readonly ledger: SqliteLedger,
    options: DocumentStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    // Resolved lazily at begin time so composing the runtime never depends
    // on `storageArtifacts` module state; injected overrides stay testable.
    this.publicationDirectory = options.publicationDirectory ?? null;
  }

  private resolvePublicationDirectory(accountId: string, documentId: string, publicationId: string): string {
    return (this.publicationDirectory ?? documentPublicationDirectory)(accountId, documentId, publicationId);
  }

  // -- Documents ---------------------------------------------------------------

  async createDocument(accountIdValue: string, input: CreateDocumentInput): Promise<CreateDocumentResult> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("document creation must be an object");
    }
    const title = textValue(input.title, "document title", 200);
    const normalized = normalizeDocumentTree(
      input.tree ?? { title, sections: [], charts: [], tables: [], evidence: [] }
    );
    const origin = input.origin ?? {};
    const originReportId = optionalUuid(origin.reportId, "origin report id");
    const originChatId = optionalUuid(origin.chatId, "origin chat id");
    const originRunId = optionalUuid(origin.runId, "origin run id");
    const originAnalysisResultId = optionalUuid(origin.analysisResultId, "origin analysis result id");
    const timestamp = this.timestamp();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await this.ledger.withImmediateTransaction((transaction) => {
      if (!transaction.get("SELECT 1 FROM users WHERE id=?", [accountId])) {
        throw new DocumentNotFoundError({ cause: new Error("account does not exist") });
      }
      this.assertOriginLinks(transaction, accountId, {
        reportId: originReportId,
        chatId: originChatId,
        runId: originRunId,
        analysisResultId: originAnalysisResultId,
      });
      transaction.run(
        `INSERT INTO documents
           (id,account_id,title,current_revision,origin_report_id,origin_chat_id,origin_run_id,
            origin_analysis_result_id,created_at,updated_at)
         VALUES (?,?,?,1,?,?,?,?,?,?)`,
        [
          documentId,
          accountId,
          normalized.tree.title,
          originReportId,
          originChatId,
          originRunId,
          originAnalysisResultId,
          timestamp,
          timestamp,
        ]
      );
      transaction.run(
        `INSERT INTO document_revisions
           (id,document_id,revision,account_id,title,payload,author_kind,base_revision_id,created_at)
         VALUES (?,?,1,?,?,?,'user',NULL,?)`,
        [revisionId, documentId, accountId, normalized.tree.title, normalized.serialized, timestamp]
      );
    });

    return this.requireComposed(accountId, documentId, revisionId);
  }

  async getDocument(accountIdValue: string, documentIdValue: string): Promise<StoredDocument | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const row = await this.ledger.get<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS},
              ${DOCUMENT_AGGREGATES}
       FROM documents d
       JOIN document_revisions h
         ON h.document_id=d.id AND h.revision=d.current_revision AND h.account_id=d.account_id
       WHERE d.id=? AND d.account_id=?`,
      [documentId, accountId]
    );
    return row ? decodeDocument(row) : undefined;
  }

  async listDocuments(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<StoredDocument>> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId];
    const after = page.after ? " AND (d.created_at,d.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS},
              ${DOCUMENT_AGGREGATES}
       FROM documents d
       JOIN document_revisions h
         ON h.document_id=d.id AND h.revision=d.current_revision AND h.account_id=d.account_id
       WHERE d.account_id=?${after}
       ORDER BY d.created_at DESC,d.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeDocument(row)),
      page,
      (item) => ({ timestamp: item.createdAt, id: item.id })
    );
  }

  // -- Revisions -------------------------------------------------------------

  /**
   * Appends one immutable full-snapshot revision under base-revision CAS.
   * Oversize trees (evidence-inclusive 400,000-character bound) and trees
   * that cannot compile into the renderer bounds are rejected before the
   * transaction; unlike optional legacy report payloads, the tree is never
   * silently dropped or truncated. A lost race writes nothing.
   */
  async saveDocumentRevision(
    accountIdValue: string,
    documentIdValue: string,
    input: SaveDocumentRevisionInput
  ): Promise<CreateDocumentResult> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("document revision save must be an object");
    }
    const baseRevisionId = uuidIdentity(input.baseRevisionId, "base revision id");
    authorKind(input.authorKind);
    const normalized = normalizeDocumentTree(input.tree);
    const timestamp = this.timestamp();
    const revisionId = randomUUID();

    await this.ledger.withImmediateTransaction((transaction) => {
      const head = this.headInTransaction(transaction, accountId, documentId);
      if (head.id !== baseRevisionId) {
        throw this.conflictInTransaction(transaction, accountId, documentId);
      }
      const cas = transaction.run(
        `UPDATE documents SET title=?,current_revision=?,updated_at=?
         WHERE id=? AND account_id=? AND current_revision=?`,
        [normalized.tree.title, head.revision + 1, timestamp, documentId, accountId, head.revision]
      );
      if (cas.changes !== 1) {
        throw this.conflictInTransaction(transaction, accountId, documentId);
      }
      this.insertRevisionInTransaction(transaction, {
        revisionId,
        documentId,
        accountId,
        revision: head.revision + 1,
        title: normalized.tree.title,
        payload: normalized.serialized,
        authorKind: input.authorKind,
        baseRevisionId,
        timestamp,
      });
    });

    return this.requireComposed(accountId, documentId, revisionId);
  }

  /**
   * Revision-checked title update. The rename appends a title-only revision
   * carrying the identical tree, so the head title, the payload title, and
   * every later export agree, and no published revision is rewritten.
   */
  async renameDocument(
    accountIdValue: string,
    documentIdValue: string,
    input: { expectedRevisionId: string; title: string }
  ): Promise<CreateDocumentResult> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const expectedRevisionId = uuidIdentity(input.expectedRevisionId, "expected revision id");
    const title = textValue(input.title, "document title", 200);
    if (!title.trim()) throw new DocumentValidationError("DOCUMENT_INVALID", "document title must not be blank");
    const timestamp = this.timestamp();
    const revisionId = randomUUID();

    await this.ledger.withImmediateTransaction((transaction) => {
      const head = this.headInTransaction(transaction, accountId, documentId);
      if (head.id !== expectedRevisionId) {
        throw this.conflictInTransaction(transaction, accountId, documentId);
      }
      const expected = this.requireRevisionRow(transaction, accountId, documentId, expectedRevisionId);
      const renamed = normalizeDocumentTree({
        ...parseDocumentTreePayload(requiredString(expected.payload, "document revision payload")),
        title,
      });
      const cas = transaction.run(
        `UPDATE documents SET title=?,current_revision=?,updated_at=?
         WHERE id=? AND account_id=? AND current_revision=?`,
        [renamed.tree.title, head.revision + 1, timestamp, documentId, accountId, head.revision]
      );
      if (cas.changes !== 1) {
        throw this.conflictInTransaction(transaction, accountId, documentId);
      }
      this.insertRevisionInTransaction(transaction, {
        revisionId,
        documentId,
        accountId,
        revision: head.revision + 1,
        title: renamed.tree.title,
        payload: renamed.serialized,
        authorKind: "user",
        baseRevisionId: head.id,
        timestamp,
      });
    });

    return this.requireComposed(accountId, documentId, revisionId);
  }

  async getDocumentRevision(
    accountIdValue: string,
    documentIdValue: string,
    revisionIdValue: string
  ): Promise<StoredDocumentRevision | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const revisionId = uuidIdentity(revisionIdValue, "revision id");
    const row = await this.ledger.get<RevisionRow>(
      `SELECT id,document_id,account_id,revision,title,payload,author_kind,base_revision_id,created_at
       FROM document_revisions WHERE id=? AND document_id=? AND account_id=?`,
      [revisionId, documentId, accountId]
    );
    return row ? decodeRevision(row) : undefined;
  }

  async listDocumentRevisions(
    accountIdValue: string,
    documentIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<DocumentRevisionSummary>> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    if (!(await this.ledger.get("SELECT 1 FROM documents WHERE id=? AND account_id=?", [documentId, accountId]))) {
      throw new DocumentNotFoundError();
    }
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [documentId, accountId];
    const after = page.after ? " AND (r.created_at,r.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<RevisionRow>(
      `SELECT r.id,r.revision,r.title,r.author_kind,r.base_revision_id,r.created_at,
              length(r.payload) AS payload_chars,
              (SELECT MAX(p.version) FROM document_publications p WHERE p.revision_id=r.id) AS published_version
       FROM document_revisions r
       WHERE r.document_id=? AND r.account_id=?${after}
       ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeRevisionSummary(row)),
      page,
      (item) => ({ timestamp: item.createdAt, id: item.id })
    );
  }

  // -- Deletion and durable artifact cleanup ------------------------------------

  /**
   * Hides the document and reserves durable filesystem cleanup through the
   * v20 delete trigger. An interrupted render with an active intent is
   * refused so a renderer can never complete against a vanished document;
   * its artifacts stay covered by this same intent once it becomes terminal.
   */
  async deleteDocument(
    accountIdValue: string,
    documentIdValue: string
  ): Promise<Readonly<DocumentArtifactCleanupIntent> | null> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    return this.ledger.withImmediateTransaction((transaction) => {
      if (!transaction.get("SELECT 1 FROM documents WHERE id=? AND account_id=?", [documentId, accountId])) {
        return null;
      }
      this.assertNoActivePublication(transaction, accountId, documentId);
      const deleted = transaction.run("DELETE FROM documents WHERE id=? AND account_id=?", [documentId, accountId]);
      if (deleted.changes !== 1) return null;
      return Object.freeze({ documentId, accountId, attempts: 0 });
    });
  }

  async listDocumentArtifactCleanupIntents(limit = 100): Promise<readonly Readonly<DocumentArtifactCleanupIntent>[]> {
    const bounded = decodeSafeInteger(limit, "cleanup limit");
    if (bounded < 1 || bounded > 1_000) throw new RangeError("document cleanup limit violates the store contract");
    const rows = await this.ledger.all<CleanupJobRow>(
      `SELECT document_id,account_id,attempts FROM document_artifact_cleanup_jobs
       ORDER BY attempts,updated_at,document_id LIMIT ?`,
      [bounded]
    );
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          documentId: uuidIdentity(row.document_id, "cleanup document id"),
          accountId: uuidIdentity(row.account_id, "cleanup account id"),
          attempts: decodeSafeInteger(row.attempts, "cleanup attempts"),
        })
      )
    );
  }

  async clearDocumentArtifactCleanupIntent(accountIdValue: string, documentIdValue: string): Promise<boolean> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "cleanup document id");
    return (
      (
        await this.ledger.run("DELETE FROM document_artifact_cleanup_jobs WHERE document_id=? AND account_id=?", [
          documentId,
          accountId,
        ])
      ).changes === 1
    );
  }

  async recordDocumentArtifactCleanupFailure(
    accountIdValue: string,
    documentIdValue: string,
    errorCode: string
  ): Promise<void> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "cleanup document id");
    await this.ledger.run(
      `UPDATE document_artifact_cleanup_jobs
       SET attempts=attempts+1,last_error=?,updated_at=? WHERE document_id=? AND account_id=?`,
      [textValue(errorCode, "cleanup error code", 128), this.timestamp(), documentId, accountId]
    );
  }

  // -- Publication ----------------------------------------------------------------

  /**
   * Opens (or idempotently replays) the single active publication intent for
   * a document. Publishing defaults to the current head; a non-head revision
   * requires `allowNonHeadRevision`, and the completion step re-checks the
   * head so unseen content is never published by the default action.
   */
  async beginDocumentPublication(
    accountIdValue: string,
    documentIdValue: string,
    input: BeginPublicationInput
  ): Promise<BeginPublicationResult> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const operationId = uuidIdentity(input.operationId, "operation id");
    const revisionId = optionalUuid(input.revisionId, "publication revision id");
    const expectedRevisionId = optionalUuid(input.expectedRevisionId, "expected revision id");
    const allowNonHead = input.allowNonHeadRevision === true;

    return this.ledger.withImmediateTransaction((transaction) => {
      if (!transaction.get("SELECT 1 FROM documents WHERE id=? AND account_id=?", [documentId, accountId])) {
        throw new DocumentNotFoundError();
      }
      const existing = transaction.get<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM document_publication_intents
         WHERE account_id=? AND document_id=? AND operation_id=?`,
        [accountId, documentId, operationId]
      );
      if (existing) {
        const intent = decodeIntent(existing);
        if (intent.status !== "failed") {
          return Object.freeze({ intent, replayed: true });
        }
        // Retry of a failed attempt: re-validate the head rule before re-arming.
        const head = this.headInTransaction(transaction, accountId, documentId);
        if (head.id !== intent.revisionId && !intent.explicitRevisionSelection) {
          throw new DocumentHeadMovedError();
        }
        const rearmed = transaction.run(
          `UPDATE document_publication_intents
           SET status='rendering',attempts=attempts+1,error_code=NULL,error_reason=NULL,
               html_path=NULL,pdf_path=NULL,updated_at=?
           WHERE id=? AND account_id=? AND status='failed'`,
          [this.timestamp(), intent.id, accountId]
        );
        if (rearmed.changes !== 1) throw new DocumentPublicationStateError();
        return Object.freeze({
          intent: this.readIntentInTransaction(transaction, accountId, intent.id),
          replayed: false,
        });
      }

      const head = this.headInTransaction(transaction, accountId, documentId);
      if (expectedRevisionId !== null && expectedRevisionId !== head.id) {
        throw this.conflictInTransaction(transaction, accountId, documentId);
      }
      const targetRevisionId = revisionId ?? head.id;
      const explicitSelection = targetRevisionId !== head.id;
      if (explicitSelection && !allowNonHead) throw new DocumentRevisionSelectionError();
      const revision = this.requireRevisionRow(transaction, accountId, documentId, targetRevisionId);
      this.assertNoActivePublication(transaction, accountId, documentId);

      const intentId = randomUUID();
      const timestamp = this.timestamp();
      const artifactDirectory = this.resolvePublicationDirectory(accountId, documentId, intentId);
      textValue(artifactDirectory, "publication artifact directory", 32_768, true);
      try {
        transaction.run(
          `INSERT INTO document_publication_intents
             (id,account_id,document_id,revision_id,revision,operation_id,explicit_revision_selection,status,
              artifact_directory,publication_id,attempts,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,'rendering',?,NULL,0,?,?)`,
          [
            intentId,
            accountId,
            documentId,
            uuidIdentity(revision.id, "revision id"),
            decodeSafeInteger(revision.revision, "revision number"),
            operationId,
            explicitSelection ? 1 : 0,
            artifactDirectory,
            timestamp,
            timestamp,
          ]
        );
      } catch (error) {
        if (error instanceof SqliteConstraintError) throw new DocumentPublicationActiveError({ cause: error });
        throw error;
      }
      return Object.freeze({
        intent: this.readIntentInTransaction(transaction, accountId, intentId),
        replayed: false,
      });
    });
  }

  async getDocumentPublicationIntent(
    accountIdValue: string,
    documentIdValue: string,
    operationIdValue: string
  ): Promise<StoredDocumentPublicationIntent | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const operationId = uuidIdentity(operationIdValue, "operation id");
    const row = await this.ledger.get<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM document_publication_intents
       WHERE account_id=? AND document_id=? AND operation_id=?`,
      [accountId, documentId, operationId]
    );
    return row ? decodeIntent(row) : undefined;
  }

  /**
   * Renderer-facing transition: only paths inside the intent's exact
   * UUID-scoped directory are accepted. The caller has verified the artifacts
   * exist (the store never touches the filesystem); version assignment waits
   * for `completeDocumentPublication`.
   */
  async markDocumentPublicationReady(
    accountIdValue: string,
    documentIdValue: string,
    operationIdValue: string,
    artifacts: { htmlPath: string; pdfPath: string }
  ): Promise<StoredDocumentPublicationIntent> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const operationId = uuidIdentity(operationIdValue, "operation id");
    const htmlPath = textValue(artifacts.htmlPath, "publication html path", 32_768, true);
    const pdfPath = textValue(artifacts.pdfPath, "publication pdf path", 32_768, true);
    return this.ledger.withImmediateTransaction((transaction) => {
      const intent = this.requireIntentInTransaction(transaction, accountId, documentId, operationId);
      if (intent.status !== "rendering") throw new DocumentPublicationStateError();
      if (
        htmlPath !== path.join(intent.artifactDirectory, "document.html") ||
        pdfPath !== path.join(intent.artifactDirectory, "document.pdf")
      ) {
        throw new DocumentPublicationStateError({ cause: new Error("artifact paths escaped the intent directory") });
      }
      const updated = transaction.run(
        `UPDATE document_publication_intents
         SET status='ready',html_path=?,pdf_path=?,updated_at=?
         WHERE id=? AND account_id=? AND status='rendering'`,
        [htmlPath, pdfPath, this.timestamp(), intent.id, accountId]
      );
      if (updated.changes !== 1) throw new DocumentPublicationStateError();
      return this.readIntentInTransaction(transaction, accountId, intent.id);
    });
  }

  /** Records a retryable render failure; the draft and head are untouched. */
  async failDocumentPublication(
    accountIdValue: string,
    documentIdValue: string,
    operationIdValue: string,
    failure: { errorCode?: string; errorReason?: string } = {}
  ): Promise<StoredDocumentPublicationIntent> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const operationId = uuidIdentity(operationIdValue, "operation id");
    const errorCode = optionalText(failure.errorCode, "publication error code", 128) ?? "PUBLICATION_RENDER_FAILED";
    const errorReason = optionalText(failure.errorReason, "publication error reason", 500);
    return this.ledger.withImmediateTransaction((transaction) => {
      const intent = this.requireIntentInTransaction(transaction, accountId, documentId, operationId);
      if (intent.status === "failed") return intent;
      if (intent.status === "completed") throw new DocumentPublicationStateError();
      const failed = transaction.run(
        `UPDATE document_publication_intents
         SET status='failed',error_code=?,error_reason=?,updated_at=?
         WHERE id=? AND account_id=? AND status IN ('rendering','ready')`,
        [errorCode, errorReason, this.timestamp(), intent.id, accountId]
      );
      if (failed.changes !== 1) throw new DocumentPublicationStateError();
      return this.readIntentInTransaction(transaction, accountId, intent.id);
    });
  }

  /**
   * Assigns the next per-document publication version and freezes the
   * immutable publication row, only after the render recorded both required
   * artifacts. A default (head) publication whose head moved fails closed
   * with `DocumentHeadMovedError`; an explicitly selected revision publishes
   * because the user reviewed exactly that content. Replays with the same
   * operation UUID return the original publication unchanged.
   */
  async completeDocumentPublication(
    accountIdValue: string,
    documentIdValue: string,
    operationIdValue: string
  ): Promise<{ publication: StoredDocumentPublication; replayed: boolean }> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const operationId = uuidIdentity(operationIdValue, "operation id");
    const timestamp = this.timestamp();

    const outcome = await this.ledger.withImmediateTransaction((transaction) => {
      const intent = this.requireIntentInTransaction(transaction, accountId, documentId, operationId);
      if (intent.status === "completed") {
        const row = transaction.get<PublicationRow>(
          `SELECT ${PUBLICATION_COLUMNS} FROM document_publications WHERE id=? AND account_id=?`,
          [intent.publicationId, accountId]
        );
        if (!row)
          throw new DocumentPublicationStateError({ cause: new Error("completed intent lost its publication") });
        return Object.freeze({ kind: "published" as const, publication: decodePublication(row), replayed: true });
      }
      if (intent.status !== "ready") throw new DocumentPublicationStateError();
      if (!intent.htmlPath || !intent.pdfPath) {
        throw new DocumentPublicationStateError({ cause: new Error("required artifacts were never recorded") });
      }
      const head = this.headInTransaction(transaction, accountId, documentId);
      if (head.id !== intent.revisionId && !intent.explicitRevisionSelection) {
        // The head-moved rejection must COMMIT its failed-attempt marker
        // before the error surfaces (throwing inside this transaction would
        // roll the record back), so the decision is returned and applied by
        // `failDocumentPublication` after this transaction commits.
        return Object.freeze({ kind: "head-moved" as const });
      }
      const revisionRow = this.requireRevisionRow(transaction, accountId, documentId, intent.revisionId);
      const previous = transaction.get<{ id?: unknown; version?: unknown }>(
        `SELECT id,version FROM document_publications
         WHERE document_id=? AND account_id=? ORDER BY version DESC LIMIT 1`,
        [documentId, accountId]
      );
      const version = previous ? decodeSafeInteger(previous.version, "publication version") + 1 : 1;
      const supersedes = previous ? uuidIdentity(previous.id, "publication supersedes id") : null;
      const publicationId = randomUUID();
      transaction.run(
        `INSERT INTO document_publications
           (id,account_id,document_id,revision_id,revision,version,title,supersedes,html_path,pdf_path,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          publicationId,
          accountId,
          documentId,
          intent.revisionId,
          decodeSafeInteger(revisionRow.revision, "revision number"),
          version,
          requiredString(revisionRow.title, "revision title"),
          supersedes,
          intent.htmlPath,
          intent.pdfPath,
          timestamp,
        ]
      );
      const finalized = transaction.run(
        `UPDATE document_publication_intents
         SET status='completed',publication_id=?,error_code=NULL,error_reason=NULL,updated_at=?
         WHERE id=? AND account_id=? AND status='ready'`,
        [publicationId, timestamp, intent.id, accountId]
      );
      if (finalized.changes !== 1) throw new DocumentPublicationStateError();
      const stored = transaction.get<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS} FROM document_publications WHERE id=? AND account_id=?`,
        [publicationId, accountId]
      );
      if (!stored) throw new DocumentPublicationStateError({ cause: new Error("publication vanished") });
      return Object.freeze({ kind: "published" as const, publication: decodePublication(stored), replayed: false });
    });
    if (outcome.kind === "head-moved") {
      // Commit the retryable failure record outside the rejected attempt's
      // transaction, then reject. The draft and the previous publication
      // stay intact; the active slot frees for a fresh reviewed request.
      await this.failDocumentPublication(accountId, documentId, operationId, {
        errorCode: "DOCUMENT_HEAD_MOVED",
      });
      throw new DocumentHeadMovedError();
    }
    return Object.freeze({ publication: outcome.publication, replayed: outcome.replayed });
  }

  async listDocumentPublications(
    accountIdValue: string,
    documentIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<StoredDocumentPublication>> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    if (!(await this.ledger.get("SELECT 1 FROM documents WHERE id=? AND account_id=?", [documentId, accountId]))) {
      throw new DocumentNotFoundError();
    }
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [documentId, accountId];
    const after = page.after ? " AND (created_at,id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS} FROM document_publications
       WHERE document_id=? AND account_id=?${after}
       ORDER BY version DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodePublication(row)),
      page,
      (item) => ({
        // Publication history is version-ordered; the keyset rides the version.
        timestamp: `${String(item.version).padStart(12, "0")}`,
        id: item.id,
      })
    );
  }

  /**
   * Crash recovery: interrupted renders become durable retryable failures and
   * reserve exact-directory artifact cleanup. No partial result ever becomes
   * a publication and the previous published version stays current.
   */
  async recoverInterruptedDocumentPublications(): Promise<number> {
    return this.ledger.withImmediateTransaction((transaction) => {
      const interrupted = transaction.all<IntentRow>(
        `SELECT id,account_id,document_id,artifact_directory FROM document_publication_intents
         WHERE status IN ('rendering','ready') ORDER BY updated_at,id`
      );
      for (const intent of interrupted) {
        transaction.run(
          `UPDATE document_publication_intents
           SET status='failed',error_code='SERVER_RESTARTED',error_reason=NULL,updated_at=?
           WHERE id=? AND status IN ('rendering','ready')`,
          [this.timestamp(), uuidIdentity(intent.id, "intent id")]
        );
        transaction.run(
          `INSERT INTO document_publication_cleanup_jobs (id,account_id,document_id,artifact_directory)
           VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`,
          [
            uuidIdentity(intent.id, "intent id"),
            uuidIdentity(intent.account_id, "account id"),
            uuidIdentity(intent.document_id, "document id"),
            requiredString(intent.artifact_directory, "artifact directory"),
          ]
        );
      }
      return interrupted.length;
    });
  }

  // -- Publication artifact cleanup jobs ---------------------------------------------

  async listDocumentPublicationCleanupJobs(limit = 100): Promise<readonly Readonly<DocumentPublicationCleanupJob>[]> {
    const bounded = decodeSafeInteger(limit, "cleanup limit");
    if (bounded < 1 || bounded > 1_000) throw new RangeError("document cleanup limit violates the store contract");
    const rows = await this.ledger.all<CleanupJobRow>(
      `SELECT id,account_id,document_id,artifact_directory,attempts FROM document_publication_cleanup_jobs
       ORDER BY attempts,updated_at,id LIMIT ?`,
      [bounded]
    );
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: uuidIdentity(row.id, "publication cleanup id"),
          accountId: uuidIdentity(row.account_id, "cleanup account id"),
          documentId: uuidIdentity(row.document_id, "cleanup document id"),
          artifactDirectory: requiredString(row.artifact_directory, "cleanup artifact directory"),
          attempts: decodeSafeInteger(row.attempts, "cleanup attempts"),
        })
      )
    );
  }

  async clearDocumentPublicationCleanupJob(accountIdValue: string, jobIdValue: string): Promise<boolean> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const jobId = uuidIdentity(jobIdValue, "publication cleanup id");
    return (
      (
        await this.ledger.run("DELETE FROM document_publication_cleanup_jobs WHERE id=? AND account_id=?", [
          jobId,
          accountId,
        ])
      ).changes === 1
    );
  }

  async recordDocumentPublicationCleanupFailure(
    accountIdValue: string,
    jobIdValue: string,
    errorCode: string
  ): Promise<void> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const jobId = uuidIdentity(jobIdValue, "publication cleanup id");
    await this.ledger.run(
      `UPDATE document_publication_cleanup_jobs
       SET attempts=attempts+1,last_error=?,updated_at=? WHERE id=? AND account_id=?`,
      [textValue(errorCode, "cleanup error code", 128), this.timestamp(), jobId, accountId]
    );
  }

  // -- Legacy editable copy ----------------------------------------------------------

  /**
   * "Create editable copy" of an OWNED published legacy report: snapshots the
   * stored normalized payload plus the server-verified origin links (report
   * and its owning chat) into document revision 1. The report row, its
   * per-chat version chain, and its shares are read-only inputs here. Legacy
   * payloads carry no document-level evidence, so the copy is explicitly
   * unverified; a missing normalized payload is a typed unavailable state —
   * rendered HTML is never scraped and no provenance is invented.
   */
  async createEditableCopy(accountIdValue: string, reportIdValue: string): Promise<CreateDocumentResult> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const reportId = uuidIdentity(reportIdValue, "report id");
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await this.ledger.withImmediateTransaction((transaction) => {
      const report = transaction.get<ReportPayloadRow>(
        "SELECT id,account_id,title,chat_id,payload FROM reports WHERE id=? AND account_id=? AND status='published'",
        [reportId, accountId]
      );
      if (!report) throw new DocumentNotFoundError({ cause: new Error("no owned published report") });
      if (report.payload === null || report.payload === undefined) {
        throw new DocumentUnavailableError("legacy report has no stored normalized payload");
      }
      const tree = documentTreeFromLegacyReport(
        decodeJson(report.payload, "report payload"),
        requiredString(report.title, "report title")
      );
      const timestamp = this.timestamp();
      transaction.run(
        `INSERT INTO documents
           (id,account_id,title,current_revision,origin_report_id,origin_chat_id,origin_run_id,
            origin_analysis_result_id,created_at,updated_at)
         VALUES (?,?,?,1,?,?,NULL,NULL,?,?)`,
        [
          documentId,
          accountId,
          tree.title,
          reportId,
          report.chat_id === null || report.chat_id === undefined ? null : requiredString(report.chat_id, "chat id"),
          timestamp,
          timestamp,
        ]
      );
      this.insertRevisionInTransaction(transaction, {
        revisionId,
        documentId,
        accountId,
        revision: 1,
        title: tree.title,
        payload: JSON.stringify(tree),
        authorKind: "user",
        baseRevisionId: null,
        timestamp,
      });
    });

    return this.requireComposed(accountId, documentId, revisionId);
  }

  // -- Internals ----------------------------------------------------------------------

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "document store clock");
  }

  private assertOriginLinks(transaction: SqliteTransaction, accountId: string, links: DocumentOriginLinks): void {
    if (links.reportId !== null) {
      const row = transaction.get("SELECT 1 FROM reports WHERE id=? AND account_id=? AND status='published'", [
        links.reportId,
        accountId,
      ]);
      if (!row) throw new DocumentNotFoundError({ cause: new Error("origin report is not owned or published") });
    }
    if (links.chatId !== null) {
      if (!transaction.get("SELECT 1 FROM chats WHERE id=? AND account_id=?", [links.chatId, accountId])) {
        throw new DocumentNotFoundError({ cause: new Error("origin chat is not owned") });
      }
    }
    if (links.runId !== null) {
      if (!transaction.get("SELECT 1 FROM chat_runs WHERE id=? AND account_id=?", [links.runId, accountId])) {
        throw new DocumentNotFoundError({ cause: new Error("origin run is not owned") });
      }
    }
    if (links.analysisResultId !== null) {
      if (
        !transaction.get("SELECT 1 FROM analysis_results WHERE id=? AND account_id=?", [
          links.analysisResultId,
          accountId,
        ])
      ) {
        throw new DocumentNotFoundError({ cause: new Error("origin analysis result is not owned") });
      }
    }
  }

  private insertRevisionInTransaction(
    transaction: SqliteTransaction,
    revision: {
      revisionId: string;
      documentId: string;
      accountId: string;
      revision: number;
      title: string;
      payload: string;
      authorKind: DocumentAuthorKind;
      baseRevisionId: string | null;
      timestamp: string;
    }
  ): void {
    transaction.run(
      `INSERT INTO document_revisions
         (id,document_id,revision,account_id,title,payload,author_kind,base_revision_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        revision.revisionId,
        revision.documentId,
        revision.revision,
        revision.accountId,
        revision.title,
        revision.payload,
        revision.authorKind,
        revision.baseRevisionId,
        revision.timestamp,
      ]
    );
  }

  private headInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    documentId: string
  ): { id: string; revision: number; title: string } {
    const row = transaction.get<{ id?: unknown; revision?: unknown; title?: unknown }>(
      `SELECT r.id,r.revision,r.title
       FROM documents d
       JOIN document_revisions r
         ON r.document_id=d.id AND r.revision=d.current_revision AND r.account_id=d.account_id
       WHERE d.id=? AND d.account_id=?`,
      [documentId, accountId]
    );
    if (!row) throw new DocumentNotFoundError();
    return {
      id: uuidIdentity(row.id, "head revision id"),
      revision: decodeSafeInteger(row.revision, "head revision number"),
      title: requiredString(row.title, "head revision title"),
    };
  }

  private requireRevisionRow(
    transaction: SqliteTransaction,
    accountId: string,
    documentId: string,
    revisionId: string
  ): RevisionRow {
    const row = transaction.get<RevisionRow>(
      `SELECT id,document_id,account_id,revision,title,payload,author_kind,base_revision_id,created_at
       FROM document_revisions WHERE id=? AND document_id=? AND account_id=?`,
      [revisionId, documentId, accountId]
    );
    if (!row) throw new DocumentRevisionNotFoundError();
    return row;
  }

  private conflictInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    documentId: string
  ): DocumentRevisionConflictError | DocumentNotFoundError {
    const head = transaction.get<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS},
              ${DOCUMENT_AGGREGATES}
       FROM documents d
       JOIN document_revisions h
         ON h.document_id=d.id AND h.revision=d.current_revision AND h.account_id=d.account_id
       WHERE d.id=? AND d.account_id=?`,
      [documentId, accountId]
    );
    if (!head) return new DocumentNotFoundError();
    const document = decodeDocument(head);
    return new DocumentRevisionConflictError(
      Object.freeze({
        revisionId: document.currentRevisionId,
        revision: document.currentRevision,
        title: document.title,
        authorKind: document.headAuthorKind,
        updatedAt: document.updatedAt,
      })
    );
  }

  private requireIntentInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    documentId: string,
    operationId: string
  ): StoredDocumentPublicationIntent {
    const row = transaction.get<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM document_publication_intents
       WHERE account_id=? AND document_id=? AND operation_id=?`,
      [accountId, documentId, operationId]
    );
    if (!row) throw new DocumentPublicationStateError({ cause: new Error("unknown publication operation") });
    return decodeIntent(row);
  }

  private readIntentInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    intentId: string
  ): StoredDocumentPublicationIntent {
    const row = transaction.get<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM document_publication_intents WHERE id=? AND account_id=?`,
      [intentId, accountId]
    );
    if (!row) throw new DocumentPublicationStateError({ cause: new Error("publication intent vanished") });
    return decodeIntent(row);
  }

  private assertNoActivePublication(transaction: SqliteTransaction, accountId: string, documentId: string): void {
    const active = transaction.get(
      `SELECT 1 FROM document_publication_intents
       WHERE account_id=? AND document_id=? AND status IN ('rendering','ready') LIMIT 1`,
      [accountId, documentId]
    );
    if (active) throw new DocumentPublicationActiveError();
  }

  private async requireComposed(
    accountId: string,
    documentId: string,
    revisionId: string
  ): Promise<CreateDocumentResult> {
    const document = await this.getDocument(accountId, documentId);
    const revision = await this.getDocumentRevision(accountId, documentId, revisionId);
    if (!document || !revision) throw new DocumentStoreError("DOCUMENT_NOT_FOUND", "document append vanished");
    return Object.freeze({ document, revision });
  }
}

export function createDocumentStore(ledger: SqliteLedger, options: DocumentStoreOptions = {}): DocumentStore {
  return new DocumentStore(ledger, options);
}
