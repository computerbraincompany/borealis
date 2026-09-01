import { randomUUID } from "node:crypto";
import {
  catalogStorePage,
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../../catalogPagination.js";
import { SqliteConstraintError } from "../types.js";
import type { SqliteLedger } from "../types.js";
import { SOURCE_COLUMNS, decodeSource, type SourceRecord } from "./sourceStore.js";

export const MAX_LIBRARY_NAME_CHARS = 120;
export const MAX_LIBRARY_MEMBERS = 100;

export interface LibraryRecord {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LibrarySummary extends LibraryRecord {
  readonly member_count: number;
}

export class DuplicateLibraryError extends Error {
  constructor() {
    super("a library with this name already exists");
    this.name = "DuplicateLibraryError";
  }
}

export class LibraryMemberMissingError extends Error {
  constructor() {
    super("one or more sources do not exist in this account");
    this.name = "LibraryMemberMissingError";
  }
}

export class LibraryNotFoundError extends Error {
  constructor() {
    super("library not found");
    this.name = "LibraryNotFoundError";
  }
}

interface LibraryRow {
  id?: unknown;
  name?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  member_count?: unknown;
}

interface MemberRow {
  [column: string]: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\0")) {
    throw new TypeError(`${field} violates the library store input contract`);
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : value;
}

function libraryName(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > MAX_LIBRARY_NAME_CHARS || trimmed.includes("\0")) {
    throw new TypeError("library name violates the library store input contract");
  }
  return trimmed;
}

function decodeTimestamp(row: LibraryRow, field: "created_at" | "updated_at"): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} is not stored as text`);
  return value;
}

function decodeLibrary(row: LibraryRow): LibraryRecord {
  return Object.freeze({
    id: requiredId(row.id as string, "library id"),
    name: row.name as string,
    created_at: decodeTimestamp(row, "created_at"),
    updated_at: decodeTimestamp(row, "updated_at"),
  });
}

export class LibraryStore {
  constructor(private readonly ledger: SqliteLedger) {}

  async listLibraries(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<LibrarySummary>> {
    const accountId = requiredId(accountIdValue, "account id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId];
    const after = page.after ? " AND (l.created_at,l.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<LibraryRow>(
      `SELECT l.id,l.name,l.created_at,l.updated_at,
              (SELECT COUNT(*) FROM library_sources s
               WHERE s.library_id=l.id AND s.account_id=l.account_id) AS member_count
       FROM libraries l
       WHERE l.account_id=?${after}
       ORDER BY l.created_at DESC,l.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(
      rows.map((row) => ({
        ...decodeLibrary(row),
        member_count: typeof row.member_count === "number" ? row.member_count : Number(row.member_count ?? 0),
      })),
      page,
      (library) => ({ timestamp: library.created_at, id: library.id })
    );
  }

  async createLibrary(accountIdValue: string, nameValue: string): Promise<LibraryRecord> {
    const accountId = requiredId(accountIdValue, "account id");
    const name = libraryName(nameValue);
    const id = randomUUID();
    try {
      await this.ledger.run("INSERT INTO libraries (id,account_id,name) VALUES (?,?,?)", [id, accountId, name]);
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") throw new DuplicateLibraryError();
      throw error;
    }
    const row = await this.ledger.get<LibraryRow>(
      "SELECT id,name,created_at,updated_at FROM libraries WHERE id=? AND account_id=?",
      [id, accountId]
    );
    if (!row) throw new Error("library insert did not persist");
    return decodeLibrary(row);
  }

  async getLibrary(accountIdValue: string, libraryIdValue: string): Promise<LibraryRecord | undefined> {
    const row = await this.ledger.get<LibraryRow>(
      "SELECT id,name,created_at,updated_at FROM libraries WHERE id=? AND account_id=?",
      [requiredId(libraryIdValue, "library id"), requiredId(accountIdValue, "account id")]
    );
    return row ? decodeLibrary(row) : undefined;
  }

  async renameLibrary(
    accountIdValue: string,
    libraryIdValue: string,
    nameValue: string
  ): Promise<LibraryRecord | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const libraryId = requiredId(libraryIdValue, "library id");
    const name = libraryName(nameValue);
    try {
      const updated = await this.ledger.run(
        "UPDATE libraries SET name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND account_id=?",
        [name, libraryId, accountId]
      );
      if (updated.changes !== 1) return undefined;
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") throw new DuplicateLibraryError();
      throw error;
    }
    const row = await this.ledger.get<LibraryRow>(
      "SELECT id,name,created_at,updated_at FROM libraries WHERE id=? AND account_id=?",
      [libraryId, accountId]
    );
    return row ? decodeLibrary(row) : undefined;
  }

  async deleteLibrary(accountIdValue: string, libraryIdValue: string): Promise<boolean> {
    const updated = await this.ledger.run("DELETE FROM libraries WHERE id=? AND account_id=?", [
      requiredId(libraryIdValue, "library id"),
      requiredId(accountIdValue, "account id"),
    ]);
    return updated.changes === 1;
  }

  async listMembers(accountIdValue: string, libraryIdValue: string): Promise<SourceRecord[]> {
    const rows = await this.ledger.all<MemberRow>(
      `SELECT s.${SOURCE_COLUMNS.split(",")
        .map((column) => column.trim())
        .join(",s.")}
       FROM library_sources ls
       JOIN sources s ON s.id=ls.source_id AND s.account_id=ls.account_id
       WHERE ls.library_id=? AND ls.account_id=?
       ORDER BY ls.added_at DESC,ls.source_id DESC`,
      [requiredId(libraryIdValue, "library id"), requiredId(accountIdValue, "account id")]
    );
    return rows.map((row) => decodeSource(row as never));
  }

  async replaceMembers(accountIdValue: string, libraryIdValue: string, sourceIds: readonly string[]): Promise<void> {
    const accountId = requiredId(accountIdValue, "account id");
    const libraryId = requiredId(libraryIdValue, "library id");
    const sourceIds_ = [...new Set(sourceIds.map((id) => requiredId(id, "source id")))];
    if (sourceIds_.length > MAX_LIBRARY_MEMBERS) {
      throw new RangeError(`a library may hold at most ${MAX_LIBRARY_MEMBERS} sources`);
    }
    await this.ledger.withImmediateTransaction((transaction) => {
      const library = transaction.get("SELECT 1 FROM libraries WHERE id=? AND account_id=?", [libraryId, accountId]);
      if (!library) throw new LibraryNotFoundError();
      for (const sourceId of sourceIds_) {
        const owned = transaction.get("SELECT 1 FROM sources WHERE id=? AND account_id=?", [sourceId, accountId]);
        if (!owned) throw new LibraryMemberMissingError();
      }
      transaction.run("DELETE FROM library_sources WHERE library_id=? AND account_id=?", [libraryId, accountId]);
      const addedAt = new Date().toISOString();
      for (const sourceId of sourceIds_) {
        transaction.run("INSERT INTO library_sources (library_id,source_id,account_id,added_at) VALUES (?,?,?,?)", [
          libraryId,
          sourceId,
          accountId,
          addedAt,
        ]);
      }
    });
  }
}
