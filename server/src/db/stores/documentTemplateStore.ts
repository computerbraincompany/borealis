import { randomUUID } from "node:crypto";

import { decodeIsoTimestamp, decodeJson, decodeSafeInteger, encodeIsoTimestamp } from "../codecs.js";
import type { SqliteLedger } from "../types.js";
import { SqliteConstraintError } from "../types.js";
import {
  catalogStorePage,
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../../catalogPagination.js";
import {
  DOCUMENT_TEMPLATE_DESCRIPTION_MAX_CHARS,
  DOCUMENT_TEMPLATE_NAME_MAX_CHARS,
  DOCUMENT_TEMPLATES_MAX_PER_ACCOUNT,
  normalizeTemplateSnapshot,
  serializeTemplateSnapshot,
  type DocumentTemplateSnapshot,
} from "../../documentTemplates.js";
import { DocumentValidationError } from "../../documentTypes.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DocumentTemplateStoreErrorCode =
  | "DOCUMENT_TEMPLATE_NOT_FOUND"
  | "DOCUMENT_TEMPLATE_CONFLICT"
  | "DOCUMENT_TEMPLATE_QUOTA_REACHED"
  | "DOCUMENT_TEMPLATE_NAME_TAKEN";

export class DocumentTemplateStoreError extends Error {
  constructor(
    readonly code: DocumentTemplateStoreErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "DocumentTemplateStoreError";
  }
}

export class DocumentTemplateNotFoundError extends DocumentTemplateStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_TEMPLATE_NOT_FOUND", "document template not found", options);
    this.name = "DocumentTemplateNotFoundError";
  }
}

/** Stale `expected_revision` edit/delete. `currentRevision` is authoritative. */
export class DocumentTemplateConflictError extends DocumentTemplateStoreError {
  constructor(readonly currentRevision: number) {
    super("DOCUMENT_TEMPLATE_CONFLICT", "document template revision compare-and-swap failed");
    this.name = "DocumentTemplateConflictError";
  }
}

export class DocumentTemplateQuotaError extends DocumentTemplateStoreError {
  constructor() {
    super(
      "DOCUMENT_TEMPLATE_QUOTA_REACHED",
      `at most ${DOCUMENT_TEMPLATES_MAX_PER_ACCOUNT} custom document templates per account`,
      {}
    );
    this.name = "DocumentTemplateQuotaError";
  }
}

export class DocumentTemplateDuplicateNameError extends DocumentTemplateStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DOCUMENT_TEMPLATE_NAME_TAKEN", "a document template with this name already exists", options);
    this.name = "DocumentTemplateDuplicateNameError";
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface DocumentTemplateStoreOptions {
  readonly now?: () => Date;
}

export interface StoredDocumentTemplate {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly snapshot: DocumentTemplateSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TemplateRow {
  id?: unknown;
  account_id?: unknown;
  name?: unknown;
  description?: unknown;
  revision?: unknown;
  snapshot?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function textValue(value: string, field: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    (!allowEmpty && value.length < 1) ||
    value.length > maximum
  ) {
    throw new TypeError(`${field} violates the document template input contract`);
  }
  return value;
}

const TEMPLATE_COLUMNS = "id,account_id,name,description,revision,snapshot,created_at,updated_at";

function decodeTemplate(row: TemplateRow): StoredDocumentTemplate {
  return Object.freeze({
    id: uuidIdentity(row.id, "template id"),
    accountId: uuidIdentity(row.account_id, "template account id"),
    name: String(row.name),
    description: typeof row.description === "string" ? row.description : "",
    revision: decodeSafeInteger(row.revision, "template revision"),
    snapshot: normalizeTemplateSnapshot(decodeJson(row.snapshot, "template snapshot")),
    createdAt: decodeIsoTimestamp(row.created_at, "template created_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "template updated_at"),
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Owner-scoped custom template catalog (schema v22, M13 stage 2).
 *
 * - Snapshots arrive normalized through the `documentTemplates.ts` codec, so
 *   the durable row can only ever contain structure — never excerpts, table
 *   results, chart values, provenance, credentials, or source bindings.
 * - The 100-per-account quota and name uniqueness are checked inside the
 *   creation transaction, so concurrent creations cannot exceed either.
 * - Edits and deletes carry `expected_revision`; a lost race raises
 *   `DocumentTemplateConflictError` with the live revision and writes
 *   nothing. Built-in templates are server constants and never rows.
 */
export class DocumentTemplateStore {
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: DocumentTemplateStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "document template store clock");
  }

  async listTemplates(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<StoredDocumentTemplate>> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId];
    const after = page.after ? " AND (created_at,id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM document_templates
       WHERE account_id=?${after}
       ORDER BY created_at DESC,id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => decodeTemplate(row)),
      page,
      (item) => ({ timestamp: item.createdAt, id: item.id })
    );
  }

  async getTemplate(accountIdValue: string, templateIdValue: string): Promise<StoredDocumentTemplate | undefined> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const templateId = uuidIdentity(templateIdValue, "template id");
    const row = await this.ledger.get<TemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM document_templates WHERE id=? AND account_id=?`,
      [templateId, accountId]
    );
    return row ? decodeTemplate(row) : undefined;
  }

  async createTemplate(
    accountIdValue: string,
    input: { name: string; description?: string; snapshot: DocumentTemplateSnapshot }
  ): Promise<StoredDocumentTemplate> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const name = textValue(input.name, "template name", DOCUMENT_TEMPLATE_NAME_MAX_CHARS);
    if (!name.trim()) throw new DocumentValidationError("DOCUMENT_INVALID", "template name must not be blank");
    const description =
      input.description === undefined
        ? ""
        : textValue(input.description, "template description", DOCUMENT_TEMPLATE_DESCRIPTION_MAX_CHARS, true);
    const snapshot = normalizeTemplateSnapshot(input.snapshot);
    const serialized = serializeTemplateSnapshot(snapshot);
    const templateId = randomUUID();
    const timestamp = this.timestamp();

    await this.ledger.withImmediateTransaction((transaction) => {
      const existing = transaction.get<{ count?: number }>(
        "SELECT COUNT(*) AS count FROM document_templates WHERE account_id=?",
        [accountId]
      );
      if ((existing?.count ?? 0) >= DOCUMENT_TEMPLATES_MAX_PER_ACCOUNT) throw new DocumentTemplateQuotaError();
      try {
        transaction.run(
          `INSERT INTO document_templates (id,account_id,name,description,revision,snapshot,created_at,updated_at)
           VALUES (?,?,?,?,1,?,?,?)`,
          [templateId, accountId, name, description, serialized, timestamp, timestamp]
        );
      } catch (error) {
        if (error instanceof SqliteConstraintError) throw new DocumentTemplateDuplicateNameError({ cause: error });
        throw error;
      }
    });

    const stored = await this.getTemplate(accountId, templateId);
    if (!stored) throw new DocumentTemplateNotFoundError({ cause: new Error("template append vanished") });
    return stored;
  }

  async updateTemplate(
    accountIdValue: string,
    templateIdValue: string,
    input: { name?: string; description?: string; expectedRevision: number }
  ): Promise<StoredDocumentTemplate> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const templateId = uuidIdentity(templateIdValue, "template id");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new TypeError("expected revision violates the document template input contract");
    }
    const name =
      input.name === undefined ? null : textValue(input.name, "template name", DOCUMENT_TEMPLATE_NAME_MAX_CHARS);
    if (name !== null && !name.trim()) {
      throw new DocumentValidationError("DOCUMENT_INVALID", "template name must not be blank");
    }
    const description =
      input.description === undefined
        ? null
        : textValue(input.description, "template description", DOCUMENT_TEMPLATE_DESCRIPTION_MAX_CHARS, true);
    if (name === null && description === null) {
      throw new DocumentValidationError("DOCUMENT_INVALID", "template update carries no fields");
    }
    const timestamp = this.timestamp();

    await this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<TemplateRow>("SELECT revision FROM document_templates WHERE id=? AND account_id=?", [
        templateId,
        accountId,
      ]);
      if (!row) throw new DocumentTemplateNotFoundError();
      const cas = transaction.run(
        `UPDATE document_templates
         SET name=COALESCE(?,name), description=COALESCE(?,description), revision=revision+1, updated_at=?
         WHERE id=? AND account_id=? AND revision=?`,
        [name, description, timestamp, templateId, accountId, input.expectedRevision]
      );
      if (cas.changes !== 1) {
        const current = transaction.get<{ revision?: number }>(
          "SELECT revision FROM document_templates WHERE id=? AND account_id=?",
          [templateId, accountId]
        );
        if (!current) throw new DocumentTemplateNotFoundError();
        throw new DocumentTemplateConflictError(decodeSafeInteger(current.revision, "template revision"));
      }
    });

    const stored = await this.getTemplate(accountId, templateId);
    if (!stored) throw new DocumentTemplateNotFoundError();
    return stored;
  }

  async deleteTemplate(accountIdValue: string, templateIdValue: string, expectedRevision: number): Promise<boolean> {
    const accountId = uuidIdentity(accountIdValue, "account id");
    const templateId = uuidIdentity(templateIdValue, "template id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new TypeError("expected revision violates the document template input contract");
    }
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<TemplateRow>("SELECT revision FROM document_templates WHERE id=? AND account_id=?", [
        templateId,
        accountId,
      ]);
      if (!row) return false;
      const deleted = transaction.run("DELETE FROM document_templates WHERE id=? AND account_id=? AND revision=?", [
        templateId,
        accountId,
        expectedRevision,
      ]);
      if (deleted.changes !== 1) {
        const current = transaction.get<{ revision?: number }>(
          "SELECT revision FROM document_templates WHERE id=? AND account_id=?",
          [templateId, accountId]
        );
        if (!current) return false;
        throw new DocumentTemplateConflictError(decodeSafeInteger(current.revision, "template revision"));
      }
      return true;
    });
  }
}

export function createDocumentTemplateStore(
  ledger: SqliteLedger,
  options: DocumentTemplateStoreOptions = {}
): DocumentTemplateStore {
  return new DocumentTemplateStore(ledger, options);
}
