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
  type DocumentEvidenceRef,
  type DocumentTree,
  type DocumentTreeInput,
} from "../../documentTypes.js";
import {
  DOCUMENT_REWRITE_INSTRUCTION_MAX_CHARS,
  DOCUMENT_REWRITE_RETAINED_PER_DOCUMENT_MAX,
  DOCUMENT_REWRITE_STATUSES,
  DocumentRewriteSelectionInvalidError,
  isTerminalDocumentRewriteStatus,
  resolveRewriteSelectionText,
  sha256Hex,
  type DocumentRewriteStatus,
} from "../../documentRewriteTypes.js";
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
  | "DOCUMENT_REVISION_SELECTION"
  | "DOCUMENT_REWRITE_NOT_FOUND"
  | "DOCUMENT_REWRITE_ACTIVE"
  | "DOCUMENT_REWRITE_QUOTA_REACHED"
  | "DOCUMENT_REWRITE_SELECTION_MISMATCH"
  | "DOCUMENT_REWRITE_STATE"
  | "DOCUMENT_REWRITE_STALE"
  | "DOCUMENT_REWRITE_ALREADY_APPLIED";

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
// Rewrite errors (schema v23)
// ---------------------------------------------------------------------------

export class DocumentRewriteNotFoundError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_REWRITE_NOT_FOUND", "document rewrite not found", options);
    this.name = "DocumentRewriteNotFoundError";
  }
}

/** One active (queued/running) rewrite already exists for this document. */
export class DocumentRewriteActiveError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_REWRITE_ACTIVE", "this document already has an active rewrite", options);
    this.name = "DocumentRewriteActiveError";
  }
}

/** 100 retained proposals per document; explicit deletion frees a slot. */
export class DocumentRewriteQuotaError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_REWRITE_QUOTA_REACHED", "document rewrite proposal quota reached", options);
    this.name = "DocumentRewriteQuotaError";
  }
}

/** Server-side re-derivation of the selection disagrees with the submitted hash. */
export class DocumentRewriteSelectionMismatchError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_REWRITE_SELECTION_MISMATCH", "the selected text no longer matches this revision", options);
    this.name = "DocumentRewriteSelectionMismatchError";
  }
}

/** Transition attempted from a status that does not admit it. */
export class DocumentRewriteStateError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_REWRITE_STATE", "document rewrite state does not allow this transition", options);
    this.name = "DocumentRewriteStateError";
  }
}

/** Head moved or selection changed since the proposal completed; it stays inspectable. */
export class DocumentRewriteStaleError extends DocumentStoreError {
  constructor(
    readonly currentHead: DocumentHeadMetadata,
    options: ErrorOptions = {}
  ) {
    super("DOCUMENT_REWRITE_STALE", "this proposal is stale against the current document head", options);
    this.name = "DocumentRewriteStaleError";
  }
}

/** A proposal applies exactly once; later acceptance attempts fail closed. */
export class DocumentRewriteAlreadyAppliedError extends DocumentStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_REWRITE_ALREADY_APPLIED", "this proposal was already applied", options);
    this.name = "DocumentRewriteAlreadyAppliedError";
  }
}

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

export interface StoredDocumentRewrite {
  readonly id: string;
  readonly accountId: string;
  readonly documentId: string;
  readonly baseRevisionId: string;
  readonly sectionId: string;
  /** UTF-16 half-open selection bounds; null pair means the whole section. */
  readonly rangeStart: number | null;
  readonly rangeEnd: number | null;
  readonly selectionSha256: string;
  readonly selectionChars: number;
  readonly instruction: string;
  readonly status: DocumentRewriteStatus;
  /** Proposed replacement; present only once the model call completed. */
  readonly replacement: string | null;
  /** Document-local evidence UUIDs copied from the base revision. */
  readonly evidenceRefs: readonly string[];
  readonly model: string | null;
  readonly errorCode: string | null;
  readonly errorReason: string | null;
  readonly cancelRequested: boolean;
  readonly appliedRevisionId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

export interface AcceptDocumentRewriteRequestInput {
  /** Exact base revision the selection was taken from. */
  readonly baseRevisionId: string;
  /** Stable document-local section UUID in the base revision. */
  readonly sectionId: string;
  /** Optional UTF-16 half-open range; both absent selects the whole section. */
  readonly rangeStart?: number | null;
  readonly rangeEnd?: number | null;
  /** Lowercase hex SHA-256 of the selected text as the client saw it. */
  readonly selectionSha256: string;
  readonly instruction: string;
}

export interface DocumentRewritePromptContext {
  readonly instruction: string;
  /** Selection re-derived from the immutable base revision, hash re-verified. */
  readonly selectionText: string;
  /** Copied evidence subset in base-revision order (context material). */
  readonly evidence: readonly DocumentEvidenceRef[];
  readonly model: string | null;
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

interface RewriteRow {
  id?: unknown;
  account_id?: unknown;
  document_id?: unknown;
  base_revision_id?: unknown;
  section_id?: unknown;
  range_start?: unknown;
  range_end?: unknown;
  selection_sha256?: unknown;
  selection_chars?: unknown;
  instruction?: unknown;
  status?: unknown;
  replacement?: unknown;
  evidence_refs?: unknown;
  model?: unknown;
  error_code?: unknown;
  error_reason?: unknown;
  cancel_requested?: unknown;
  applied_revision_id?: unknown;
  created_at?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  updated_at?: unknown;
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

const REWRITE_COLUMNS = `id,account_id,document_id,base_revision_id,section_id,range_start,range_end,
  selection_sha256,selection_chars,instruction,status,replacement,evidence_refs,model,error_code,
  error_reason,cancel_requested,applied_revision_id,created_at,started_at,finished_at,updated_at`;

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

function rewriteStatus(value: unknown): DocumentRewriteStatus {
  if ((DOCUMENT_REWRITE_STATUSES as readonly string[]).includes(String(value))) return value as DocumentRewriteStatus;
  throw new TypeError("document rewrite status violates the document store contract");
}

function optionalIntegerValue(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return decodeSafeInteger(value, field);
}

function optionalIsoValue(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return decodeIsoTimestamp(value, field);
}

function decodeRewriteEvidenceRefs(value: unknown): readonly string[] {
  const parsed = decodeJson<unknown>(value, "rewrite evidence refs");
  if (!Array.isArray(parsed)) throw new TypeError("document rewrite evidence refs must be a JSON array");
  return Object.freeze(parsed.map((entry) => uuidIdentity(entry, "rewrite evidence ref")));
}

function decodeRewrite(row: RewriteRow): StoredDocumentRewrite {
  return Object.freeze({
    id: uuidIdentity(row.id, "rewrite id"),
    accountId: uuidIdentity(row.account_id, "rewrite account id"),
    documentId: uuidIdentity(row.document_id, "rewrite document id"),
    baseRevisionId: uuidIdentity(row.base_revision_id, "rewrite base revision id"),
    sectionId: uuidIdentity(row.section_id, "rewrite section id"),
    rangeStart: optionalIntegerValue(row.range_start, "rewrite range start"),
    rangeEnd: optionalIntegerValue(row.range_end, "rewrite range end"),
    selectionSha256: requiredString(row.selection_sha256, "rewrite selection hash"),
    selectionChars: decodeSafeInteger(row.selection_chars, "rewrite selection chars"),
    instruction: requiredString(row.instruction, "rewrite instruction"),
    status: rewriteStatus(row.status),
    replacement: optionalStoredString(row.replacement, "rewrite replacement"),
    evidenceRefs: decodeRewriteEvidenceRefs(row.evidence_refs),
    model: optionalStoredString(row.model, "rewrite model"),
    errorCode: optionalStoredString(row.error_code, "rewrite error_code"),
    errorReason: optionalStoredString(row.error_reason, "rewrite error_reason"),
    cancelRequested: decodeBoolean(row.cancel_requested, "rewrite cancel_requested"),
    appliedRevisionId:
      row.applied_revision_id === null || row.applied_revision_id === undefined
        ? null
        : uuidIdentity(row.applied_revision_id, "rewrite applied revision id"),
    createdAt: decodeIsoTimestamp(row.created_at, "rewrite created_at"),
    startedAt: optionalIsoValue(row.started_at, "rewrite started_at"),
    finishedAt: optionalIsoValue(row.finished_at, "rewrite finished_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "rewrite updated_at"),
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

  private headMetadataInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    documentId: string
  ): DocumentHeadMetadata | null {
    const head = transaction.get<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS},
              ${DOCUMENT_AGGREGATES}
       FROM documents d
       JOIN document_revisions h
         ON h.document_id=d.id AND h.revision=d.current_revision AND h.account_id=d.account_id
       WHERE d.id=? AND d.account_id=?`,
      [documentId, accountId]
    );
    if (!head) return null;
    const document = decodeDocument(head);
    return Object.freeze({
      revisionId: document.currentRevisionId,
      revision: document.currentRevision,
      title: document.title,
      authorKind: document.headAuthorKind,
      updatedAt: document.updatedAt,
    });
  }

  private conflictInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    documentId: string
  ): DocumentRevisionConflictError | DocumentNotFoundError {
    const head = this.headMetadataInTransaction(transaction, accountId, documentId);
    if (!head) return new DocumentNotFoundError();
    return new DocumentRevisionConflictError(head);
  }

  private requireRewriteRowInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    documentId: string,
    rewriteId: string
  ): StoredDocumentRewrite {
    const row = transaction.get<RewriteRow>(
      `SELECT ${REWRITE_COLUMNS} FROM document_rewrites
       WHERE id=? AND document_id=? AND account_id=?`,
      [rewriteId, documentId, accountId]
    );
    if (!row) throw new DocumentRewriteNotFoundError();
    return decodeRewrite(row);
  }

  // -- Rewrites (schema v23) ------------------------------------------------------

  /**
   * Durably accepts one "rewrite selection" request. The selection is
   * re-derived from the immutable base-revision payload and its SHA-256 must
   * equal the submitted hash — a mismatch, an invalid/surrogate-split range,
   * or an over-bound selection never persists a row. At most one active
   * rewrite per document (partial unique index) and at most
   * `DOCUMENT_REWRITE_RETAINED_PER_DOCUMENT_MAX` retained rows; the evidence
   * references of the base revision are copied by stable UUID at request time.
   */
  async acceptDocumentRewriteRequest(
    accountIdValue: string,
    documentIdValue: string,
    input: AcceptDocumentRewriteRequestInput
  ): Promise<StoredDocumentRewrite> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const baseRevisionId = uuidIdentity(input.baseRevisionId, "rewrite base revision id");
    const sectionId = uuidIdentity(input.sectionId, "rewrite section id");
    const selectionHash = input.selectionSha256;
    if (
      typeof selectionHash !== "string" ||
      selectionHash.length !== 64 ||
      selectionHash !== selectionHash.toLowerCase() ||
      !/^[0-9a-f]{64}$/.test(selectionHash)
    ) {
      throw new TypeError("rewrite selection hash must be a lowercase SHA-256 hex digest");
    }
    const instruction = textValue(input.instruction, "rewrite instruction", DOCUMENT_REWRITE_INSTRUCTION_MAX_CHARS);
    if (!instruction.trim()) {
      throw new DocumentValidationError("DOCUMENT_INVALID", "rewrite instruction must not be blank");
    }
    if (input.rangeStart !== undefined && input.rangeStart !== null && !Number.isSafeInteger(input.rangeStart)) {
      throw new TypeError("rewrite range start must be an integer");
    }
    if (input.rangeEnd !== undefined && input.rangeEnd !== null && !Number.isSafeInteger(input.rangeEnd)) {
      throw new TypeError("rewrite range end must be an integer");
    }
    const rangeStart = input.rangeStart ?? null;
    const rangeEnd = input.rangeEnd ?? null;
    if ((rangeStart === null) !== (rangeEnd === null)) {
      throw new DocumentRewriteSelectionInvalidError("invalid-range", "range start and end must be supplied together");
    }
    const timestamp = this.timestamp();
    const rewriteId = randomUUID();

    await this.ledger.withImmediateTransaction((transaction) => {
      this.headInTransaction(transaction, accountId, documentId);
      const revision = this.requireRevisionRow(transaction, accountId, documentId, baseRevisionId);
      const payload = parseDocumentTreePayload(requiredString(revision.payload, "document revision payload"));
      const section = payload.sections.find((entry) => entry.id === sectionId);
      if (!section)
        throw new DocumentRewriteSelectionMismatchError({ cause: new Error("section not in base revision") });
      const selectionText = resolveRewriteSelectionText(section.markdown, rangeStart, rangeEnd);
      if (sha256Hex(selectionText) !== selectionHash) {
        throw new DocumentRewriteSelectionMismatchError({ cause: new Error("selection hash mismatch") });
      }
      const retained = transaction.get<{ count?: unknown }>(
        "SELECT COUNT(*) AS count FROM document_rewrites WHERE document_id=? AND account_id=?",
        [documentId, accountId]
      );
      if (
        decodeSafeInteger(retained?.count ?? 0, "retained rewrite count") >= DOCUMENT_REWRITE_RETAINED_PER_DOCUMENT_MAX
      ) {
        throw new DocumentRewriteQuotaError();
      }
      const evidenceRefs = JSON.stringify(payload.evidence.map((entry) => entry.id));
      try {
        transaction.run(
          `INSERT INTO document_rewrites
             (id,account_id,document_id,base_revision_id,section_id,range_start,range_end,
              selection_sha256,selection_chars,instruction,status,evidence_refs,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
          [
            rewriteId,
            accountId,
            documentId,
            baseRevisionId,
            sectionId,
            rangeStart,
            rangeEnd,
            selectionHash,
            selectionText.length,
            instruction.trim(),
            evidenceRefs,
            timestamp,
            timestamp,
          ]
        );
      } catch (error) {
        if (
          error instanceof SqliteConstraintError &&
          error.kind === "unique" &&
          /document_rewrites\.document_id/.test(String((error.cause as Error | undefined)?.message ?? ""))
        ) {
          throw new DocumentRewriteActiveError({ cause: error });
        }
        throw error;
      }
    });

    const stored = await this.getDocumentRewrite(accountId, documentId, rewriteId);
    if (!stored) throw new DocumentRewriteNotFoundError({ cause: new Error("rewrite append vanished") });
    return stored;
  }

  async getDocumentRewrite(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string
  ): Promise<StoredDocumentRewrite | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    const row = await this.ledger.get<RewriteRow>(
      `SELECT ${REWRITE_COLUMNS} FROM document_rewrites WHERE id=? AND document_id=? AND account_id=?`,
      [rewriteId, documentId, accountId]
    );
    return row ? decodeRewrite(row) : undefined;
  }

  async listDocumentRewrites(
    accountIdValue: string,
    documentIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<StoredDocumentRewrite>> {
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
    const rows = await this.ledger.all<RewriteRow>(
      `SELECT ${REWRITE_COLUMNS} FROM document_rewrites
       WHERE document_id=? AND account_id=?${after}
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeRewrite(row)),
      page,
      (item) => ({ timestamp: item.createdAt, id: item.id })
    );
  }

  async getDocumentRewriteCancelState(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string
  ): Promise<{ status: DocumentRewriteStatus; cancelRequested: boolean } | null> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    const row = await this.ledger.get<{ status?: unknown; cancel_requested?: unknown }>(
      "SELECT status,cancel_requested FROM document_rewrites WHERE id=? AND document_id=? AND account_id=?",
      [rewriteId, documentId, accountId]
    );
    if (!row) return null;
    return { status: rewriteStatus(row.status), cancelRequested: decodeBoolean(row.cancel_requested, "cancel flag") };
  }

  /**
   * The runner's prompt material: instruction plus the selection re-derived
   * (and hash re-verified) from the immutable base revision, plus the copied
   * evidence subset in base-revision order. Nothing else may reach the model.
   */
  async getDocumentRewritePromptContext(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string
  ): Promise<DocumentRewritePromptContext | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    const rewrite = await this.getDocumentRewrite(accountId, documentId, rewriteId);
    if (!rewrite) return undefined;
    const revision = await this.getDocumentRevision(accountId, documentId, rewrite.baseRevisionId);
    if (!revision) throw new DocumentRewriteNotFoundError({ cause: new Error("rewrite base revision vanished") });
    const section = revision.payload.sections.find((entry) => entry.id === rewrite.sectionId);
    if (!section) throw new DocumentRewriteSelectionMismatchError({ cause: new Error("section not in base revision") });
    const selectionText = resolveRewriteSelectionText(section.markdown, rewrite.rangeStart, rewrite.rangeEnd);
    if (sha256Hex(selectionText) !== rewrite.selectionSha256) {
      throw new DocumentRewriteSelectionMismatchError({ cause: new Error("selection hash mismatch") });
    }
    const copied = new Set(rewrite.evidenceRefs);
    return Object.freeze({
      instruction: rewrite.instruction,
      selectionText,
      evidence: Object.freeze(revision.payload.evidence.filter((entry) => copied.has(entry.id))),
      model: rewrite.model,
    });
  }

  /**
   * Claim transition: `queued → running` under status CAS. A pending durable
   * cancellation wins instead and finalizes the row as `cancelled`.
   */
  async markDocumentRewriteRunning(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string,
    model: string
  ): Promise<StoredDocumentRewrite> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    const modelName = textValue(model.trim(), "rewrite model", 256);
    return this.ledger.withImmediateTransaction((transaction) => {
      const rewrite = this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      if (rewrite.status !== "queued") return rewrite;
      if (rewrite.cancelRequested) {
        this.finalizeRewriteInTransaction(transaction, rewriteId, "cancelled", this.timestamp());
        return this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      }
      const started = transaction.run(
        `UPDATE document_rewrites
         SET status='running',started_at=?,model=?,updated_at=?
         WHERE id=? AND account_id=? AND status='queued' AND cancel_requested=0`,
        [this.timestamp(), modelName, this.timestamp(), rewriteId, accountId]
      );
      if (started.changes !== 1)
        return this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      return this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
    });
  }

  /** Records the model's bounded proposal: `running → completed`. */
  async completeDocumentRewrite(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string,
    proposal: { replacement: string; model?: string }
  ): Promise<StoredDocumentRewrite> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    const replacement = textValue(proposal.replacement, "rewrite replacement", 20_000);
    if (!replacement.trim())
      throw new DocumentValidationError("DOCUMENT_INVALID", "rewrite replacement must not be blank");
    const model = proposal.model === undefined ? null : textValue(proposal.model.trim(), "rewrite model", 256);
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      const rewrite = this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      if (rewrite.status !== "running") throw new DocumentRewriteStateError();
      if (rewrite.cancelRequested) {
        // Cancellation-wins: the DELETE-side flag observed at this final
        // boundary outranks the provider result; the proposal is never stored
        // for a run the owner cancelled.
        this.finalizeRewriteInTransaction(transaction, rewriteId, "cancelled", this.timestamp());
        return this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      }
      const completed = transaction.run(
        `UPDATE document_rewrites
         SET status='completed',replacement=?,model=COALESCE(?,model),finished_at=?,error_code=NULL,
             error_reason=NULL,updated_at=?
         WHERE id=? AND account_id=? AND status='running'`,
        [replacement, model, timestamp, timestamp, rewriteId, accountId]
      );
      if (completed.changes !== 1) throw new DocumentRewriteStateError();
      return this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
    });
  }

  /** Generic bounded failure: `running → failed`. Terminal rows settle unchanged. */
  async failDocumentRewrite(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string,
    failure: { errorCode: string; errorReason?: string; model?: string }
  ): Promise<StoredDocumentRewrite | null> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    const errorCode = textValue(failure.errorCode, "rewrite error code", 128);
    const errorReason = optionalText(failure.errorReason, "rewrite error reason", 500);
    const model = failure.model === undefined ? null : textValue(failure.model.trim(), "rewrite model", 256);
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      const rewrite = this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      if (isTerminalDocumentRewriteStatus(rewrite.status)) return rewrite;
      const failed = transaction.run(
        `UPDATE document_rewrites
         SET status='failed',error_code=?,error_reason=?,model=COALESCE(?,model),finished_at=?,updated_at=?
         WHERE id=? AND account_id=? AND status='running'`,
        [errorCode, errorReason, model, timestamp, timestamp, rewriteId, accountId]
      );
      if (failed.changes !== 1)
        return this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      return this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
    });
  }

  /** Runner-side interruption settlement: `running → cancelled`. */
  async cancelDocumentRewrite(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string
  ): Promise<StoredDocumentRewrite | null> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const rewrite = this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      if (isTerminalDocumentRewriteStatus(rewrite.status)) return rewrite;
      this.finalizeRewriteInTransaction(transaction, rewriteId, "cancelled", this.timestamp());
      return this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
    });
  }

  /**
   * Durable cancellation request: `queued` finalizes immediately; `running`
   * only records the flag for the runner's safe-point observation; terminal
   * rows settle idempotently.
   */
  async requestDocumentRewriteCancel(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string
  ): Promise<{ rewrite: StoredDocumentRewrite; outcome: "cancelled" | "cancelling" | "terminal" }> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const rewrite = this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      if (rewrite.status === "queued") {
        const settled = transaction.run(
          `UPDATE document_rewrites
           SET status='cancelled',cancel_requested=1,finished_at=?,updated_at=?
           WHERE id=? AND account_id=? AND status='queued'`,
          [this.timestamp(), this.timestamp(), rewriteId, accountId]
        );
        if (settled.changes !== 1) throw new DocumentRewriteStateError();
        return {
          rewrite: this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId),
          outcome: "cancelled" as const,
        };
      }
      if (rewrite.status === "running") {
        transaction.run(
          "UPDATE document_rewrites SET cancel_requested=1,updated_at=? WHERE id=? AND account_id=? AND status='running'",
          [this.timestamp(), rewriteId, accountId]
        );
        return {
          rewrite: this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId),
          outcome: "cancelling" as const,
        };
      }
      return { rewrite, outcome: "terminal" as const };
    });
  }

  /**
   * Explicit deletion of a retained proposal (frees one slot of the 100-per-
   * document quota). Active rows refuse: cancellation goes through the
   * cancel path, deletion only after the row is terminal.
   */
  async deleteDocumentRewrite(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string
  ): Promise<boolean> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const rewrite = this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      if (!isTerminalDocumentRewriteStatus(rewrite.status)) throw new DocumentRewriteStateError();
      return (
        transaction.run("DELETE FROM document_rewrites WHERE id=? AND document_id=? AND account_id=?", [
          rewriteId,
          documentId,
          accountId,
        ]).changes === 1
      );
    });
  }

  /**
   * Revision-CAS acceptance. Creates one new draft revision (author kind
   * `model`) only while the proposal's base revision is still the head AND
   * the stored selection still matches it byte-for-byte. Any drift durably
   * marks the proposal `stale` — inspectable forever, never auto-applied —
   * and rejects with the current head metadata. A `stale` proposal can never
   * replace newer content, and an applied proposal applies exactly once.
   */
  async applyDocumentRewriteProposal(
    accountIdValue: string,
    documentIdValue: string,
    rewriteIdValue: string
  ): Promise<{ rewrite: StoredDocumentRewrite; result: CreateDocumentResult }> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const documentId = uuidIdentity(documentIdValue, "document id");
    const rewriteId = uuidIdentity(rewriteIdValue, "rewrite id");
    const revisionId = randomUUID();

    const outcome = await this.ledger.withImmediateTransaction((transaction) => {
      const rewrite = this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId);
      if (rewrite.appliedRevisionId !== null) return Object.freeze({ kind: "already-applied" as const });
      if (rewrite.status === "stale") return Object.freeze({ kind: "stale" as const });
      if (rewrite.status !== "completed" || rewrite.replacement === null) {
        return Object.freeze({ kind: "state" as const });
      }
      const head = this.headInTransaction(transaction, accountId, documentId);
      if (head.id !== rewrite.baseRevisionId) {
        return Object.freeze({ kind: "needs-stale" as const });
      }
      const revision = this.requireRevisionRow(transaction, accountId, documentId, head.id);
      const payload = parseDocumentTreePayload(requiredString(revision.payload, "document revision payload"));
      const section = payload.sections.find((entry) => entry.id === rewrite.sectionId);
      if (!section) return Object.freeze({ kind: "needs-stale" as const });
      let selectionText: string;
      try {
        selectionText = resolveRewriteSelectionText(section.markdown, rewrite.rangeStart, rewrite.rangeEnd);
      } catch {
        return Object.freeze({ kind: "needs-stale" as const });
      }
      if (sha256Hex(selectionText) !== rewrite.selectionSha256) {
        return Object.freeze({ kind: "needs-stale" as const });
      }

      const replaced = `${section.markdown.slice(0, rewrite.rangeStart ?? 0)}${rewrite.replacement}${section.markdown.slice(
        rewrite.rangeEnd ?? section.markdown.length
      )}`;
      const normalized = normalizeDocumentTree({
        title: payload.title,
        subtitle: payload.subtitle,
        verified: payload.verified,
        sections: payload.sections.map((entry) => (entry.id === section.id ? { ...entry, markdown: replaced } : entry)),
        charts: payload.charts,
        tables: payload.tables,
        evidence: payload.evidence,
      });
      const timestamp = this.timestamp();
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
        authorKind: "model",
        baseRevisionId: head.id,
        timestamp,
      });
      const applied = transaction.run(
        `UPDATE document_rewrites SET applied_revision_id=?,updated_at=?
         WHERE id=? AND account_id=? AND status='completed' AND applied_revision_id IS NULL`,
        [revisionId, timestamp, rewriteId, accountId]
      );
      if (applied.changes !== 1) throw new DocumentRewriteStateError();
      return Object.freeze({
        kind: "applied" as const,
        rewrite: this.requireRewriteRowInTransaction(transaction, accountId, documentId, rewriteId),
      });
    });

    if (outcome.kind === "already-applied") throw new DocumentRewriteAlreadyAppliedError();
    if (outcome.kind === "stale") {
      const currentHead = await this.currentHeadMetadata(accountId, documentId);
      if (!currentHead) throw new DocumentNotFoundError();
      throw new DocumentRewriteStaleError(currentHead);
    }
    if (outcome.kind === "state") throw new DocumentRewriteStateError();
    if (outcome.kind === "needs-stale") {
      // Mark outside the deciding transaction so the durable stale mark
      // commits even though acceptance then rejects.
      await this.ledger.run(
        `UPDATE document_rewrites SET status='stale',updated_at=?
         WHERE id=? AND account_id=? AND status='completed' AND applied_revision_id IS NULL`,
        [this.timestamp(), rewriteId, accountId]
      );
      const currentHead = await this.currentHeadMetadata(accountId, documentId);
      if (!currentHead) throw new DocumentNotFoundError();
      throw new DocumentRewriteStaleError(currentHead);
    }
    const document = await this.getDocument(accountId, documentId);
    const newRevision = await this.getDocumentRevision(accountId, documentId, revisionId);
    if (!document || !newRevision) throw new DocumentStoreError("DOCUMENT_NOT_FOUND", "rewrite application vanished");
    return Object.freeze({ rewrite: outcome.rewrite, result: Object.freeze({ document, revision: newRevision }) });
  }

  private finalizeRewriteInTransaction(
    transaction: SqliteTransaction,
    rewriteId: string,
    status: "cancelled",
    timestamp: string
  ): void {
    transaction.run(
      `UPDATE document_rewrites SET status=?,cancel_requested=1,finished_at=?,updated_at=?
       WHERE id=? AND status IN ('queued','running')`,
      [status, timestamp, timestamp, rewriteId]
    );
  }

  private async currentHeadMetadata(accountId: string, documentId: string): Promise<DocumentHeadMetadata | null> {
    const document = await this.getDocument(accountId, documentId);
    if (!document) return null;
    return Object.freeze({
      revisionId: document.currentRevisionId,
      revision: document.currentRevision,
      title: document.title,
      authorKind: document.headAuthorKind,
      updatedAt: document.updatedAt,
    });
  }

  /**
   * Crash recovery: `running` rows become durable `failed` records with a
   * generic code. The provider call is never replayed — a fresh request is
   * required — and no half-applied rewrite can exist because mutation only
   * ever happens at acceptance.
   */
  async recoverInterruptedDocumentRewrites(): Promise<number> {
    return this.ledger.withImmediateTransaction((transaction) => {
      const interrupted = transaction.all<{ id?: unknown }>(
        "SELECT id FROM document_rewrites WHERE status='running' ORDER BY updated_at,id"
      );
      for (const row of interrupted) {
        transaction.run(
          `UPDATE document_rewrites
           SET status='failed',error_code='SERVER_RESTARTED',error_reason=NULL,finished_at=?,updated_at=?
           WHERE id=? AND status='running'`,
          [this.timestamp(), this.timestamp(), uuidIdentity(row.id, "rewrite id")]
        );
      }
      return interrupted.length;
    });
  }

  async listQueuedDocumentRewrites(limit = 50): Promise<readonly StoredDocumentRewrite[]> {
    const bounded = decodeSafeInteger(limit, "rewrite claim limit");
    if (bounded < 1 || bounded > 1_000) throw new RangeError("rewrite claim limit violates the store contract");
    const rows = await this.ledger.all<RewriteRow>(
      `SELECT ${REWRITE_COLUMNS} FROM document_rewrites
       WHERE status='queued' ORDER BY created_at,id LIMIT ?`,
      [bounded]
    );
    return Object.freeze(rows.map((row) => decodeRewrite(row)));
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
