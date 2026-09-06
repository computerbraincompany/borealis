import { createHash } from "node:crypto";

import { encodeJson } from "../codecs.js";
import type { SqliteLedger } from "../types.js";
import { LibraryNotFoundError, MAX_LIBRARY_MEMBERS } from "./libraryStore.js";
import {
  MAX_KNOWLEDGE_RELATIVE_PATH_CHARS,
  MAX_PREVIEW_SCAN_BYTES,
  normalizeKnowledgeRelativePath,
} from "./knowledgeStore.js";

/**
 * Browser copied-directory import (M14 stage 2).
 *
 * A browser directory import is a one-shot copied snapshot: files arrive via
 * the ordinary `/api/sources/upload` flow, and this commit binds an explicit
 * manifest of owned, ready source IDs to a library together with their
 * normalized relative paths. It deliberately creates no refreshable folder
 * connection and no new durable kind: the durable result is exactly the
 * ordinary `library_sources` membership rows plus a content-free
 * `directory_import` provenance stamp on each source's meta.
 *
 * Contract:
 * - idempotence is carried by the operation UUID: a retry whose every item
 *   already carries that operation's stamp and membership is answered
 *   idempotently instead of failing its own stale revision;
 * - the first commit is a compare-and-swap against the exact derived library
 *   membership revision (a collision-resistant digest of the member set —
 *   no new column, no new table, and any membership change between the
 *   client's read and the commit yields 409);
 * - only ready, owned, upload-backed, non-connector sources commit; relative
 *   paths re-run the managed identity normalization; totals re-run the
 *   100-item and 100 MiB budgets;
 * - failed/cancelled imports leave sources visible and untouched in the
 *   Sources surface — nothing here ever deletes a source.
 */

export const MAX_DIRECTORY_IMPORT_ITEMS = MAX_LIBRARY_MEMBERS;
export const MAX_DIRECTORY_IMPORT_BYTES = MAX_PREVIEW_SCAN_BYTES;
export const DIRECTORY_IMPORT_META_KEY = "directory_import";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DirectoryImportError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = "DIRECTORY_IMPORT_INVALID", statusCode = 400) {
    super(message);
    this.name = "DirectoryImportError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class LibraryRevisionConflictError extends Error {
  readonly code = "LIBRARY_REVISION_CONFLICT";
  readonly statusCode = 409;

  constructor(message = "the library membership changed since it was loaded") {
    super(message);
    this.name = "LibraryRevisionConflictError";
  }
}

/**
 * Derived, collision-resistant membership revision: a digest of the exact
 * member set. Any replacement/add/remove produces a different revision;
 * repeated computations of the same set are stable across processes.
 */
export function libraryMembershipRevision(libraryId: string, memberSourceIds: Iterable<string>): number {
  const ids = [...memberSourceIds].sort();
  const digest = createHash("sha256")
    .update(`borealis-directory-import-membership:v1|${libraryId}|${ids.join(",")}`, "utf8")
    .digest("hex");
  return Number.parseInt(digest.slice(0, 13), 16);
}

export interface DirectoryImportItem {
  readonly source_id: unknown;
  readonly relative_path: unknown;
}

export interface CommitDirectoryImportInput {
  readonly operation_id: unknown;
  readonly expected_revision: unknown;
  readonly items: readonly DirectoryImportItem[];
}

export interface DirectoryImportCommitResult {
  readonly operation_id: string;
  readonly library_id: string;
  readonly revision: number;
  readonly added: number;
  readonly idempotent: boolean;
}

interface SourceRow {
  id?: unknown;
  status?: unknown;
  connector?: unknown;
  file_path?: unknown;
  size_bytes?: unknown;
  meta?: unknown;
}

function decodeMeta(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stampOf(
  meta: Record<string, unknown>
): { operation_id?: unknown; relative_path?: unknown; library_id?: unknown } | null {
  const stamp = meta[DIRECTORY_IMPORT_META_KEY];
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return null;
  return stamp as { operation_id?: unknown; relative_path?: unknown; library_id?: unknown };
}

/**
 * Validate the manifest shape purely (no store access): operation UUID, 1..100
 * unique items, UUID source ids, managed-identity relative paths. Returns the
 * normalized items so the route and the store share one normalization pass.
 */
export function normalizeDirectoryImportManifest(input: CommitDirectoryImportInput): {
  operationId: string;
  expectedRevision: number | null;
  items: Array<{ sourceId: string; relativePath: string }>;
} {
  const operationId =
    typeof input.operation_id === "string" && UUID_PATTERN.test(input.operation_id)
      ? input.operation_id.toLowerCase()
      : null;
  if (!operationId) throw new DirectoryImportError("operation_id must be a canonical UUID");
  let expectedRevision: number | null = null;
  if (input.expected_revision !== undefined && input.expected_revision !== null) {
    if (
      typeof input.expected_revision !== "number" ||
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0
    ) {
      throw new DirectoryImportError("expected_revision is invalid");
    }
    expectedRevision = input.expected_revision;
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_DIRECTORY_IMPORT_ITEMS) {
    throw new DirectoryImportError(`the manifest holds between 1 and ${MAX_DIRECTORY_IMPORT_ITEMS} items`);
  }
  const seenSource = new Set<string>();
  const seenPath = new Set<string>();
  const items: Array<{ sourceId: string; relativePath: string }> = [];
  for (const item of input.items) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new DirectoryImportError("manifest item is invalid");
    const rawId = (item as DirectoryImportItem).source_id;
    if (typeof rawId !== "string" || !UUID_PATTERN.test(rawId))
      throw new DirectoryImportError("source_id must be a canonical UUID");
    const sourceId = rawId.toLowerCase();
    if (seenSource.has(sourceId)) throw new DirectoryImportError("manifest source ids must be unique");
    seenSource.add(sourceId);
    const rawPath = (item as DirectoryImportItem).relative_path;
    if (typeof rawPath !== "string" || rawPath.length > MAX_KNOWLEDGE_RELATIVE_PATH_CHARS) {
      throw new DirectoryImportError("relative_path is invalid");
    }
    const relativePath = normalizeKnowledgeRelativePath(rawPath);
    if (relativePath === null) throw new DirectoryImportError("relative_path is not a safe normalized relative path");
    if (seenPath.has(relativePath)) throw new DirectoryImportError("manifest relative paths must be unique");
    seenPath.add(relativePath);
    items.push({ sourceId, relativePath });
  }
  return { operationId, expectedRevision, items };
}

/**
 * Commit one browser directory-import manifest. The whole commit is a single
 * immediate transaction: revision CAS (or idempotent retry), ownership/ready
 * revalidation, capacity and byte budgets, membership inserts, and provenance
 * stamps all land together or not at all.
 */
export async function commitDirectoryImport(
  ledger: SqliteLedger,
  accountIdValue: string,
  libraryIdValue: string,
  input: CommitDirectoryImportInput
): Promise<DirectoryImportCommitResult> {
  const accountId =
    typeof accountIdValue === "string" && UUID_PATTERN.test(accountIdValue) ? accountIdValue.toLowerCase() : null;
  const libraryId =
    typeof libraryIdValue === "string" && UUID_PATTERN.test(libraryIdValue) ? libraryIdValue.toLowerCase() : null;
  if (!accountId || !libraryId) throw new LibraryNotFoundError();
  const manifest = normalizeDirectoryImportManifest(input);
  return ledger.withImmediateTransaction((transaction): DirectoryImportCommitResult => {
    const library = transaction.get("SELECT 1 FROM libraries WHERE id=? AND account_id=?", [libraryId, accountId]);
    if (!library) throw new LibraryNotFoundError();
    const memberRows = transaction.all<{ source_id: unknown }>(
      "SELECT source_id FROM library_sources WHERE library_id=? AND account_id=?",
      [libraryId, accountId]
    );
    const memberIds = memberRows.map((row) => String(row.source_id));
    const memberSet = new Set(memberIds);
    const revision = libraryMembershipRevision(libraryId, memberIds);

    const sources = new Map<string, SourceRow>();
    for (const item of manifest.items) {
      const source = transaction.get<SourceRow>(
        "SELECT id,status,connector,file_path,size_bytes,meta FROM sources WHERE id=? AND account_id=?",
        [item.sourceId, accountId]
      );
      if (!source) {
        throw new DirectoryImportError(
          "one or more manifest sources do not exist in this account",
          "SOURCE_NOT_FOUND",
          404
        );
      }
      sources.set(item.sourceId, source);
    }

    // Idempotent retry: every item is stamped by this exact operation, still
    // a member of this library, and its stamped path matches the manifest.
    const everyStamped = manifest.items.every((item) => {
      const source = sources.get(item.sourceId)!;
      const stamp = stampOf(decodeMeta(source.meta));
      return (
        memberSet.has(item.sourceId) &&
        stamp?.operation_id === manifest.operationId &&
        stamp?.relative_path === item.relativePath &&
        stamp?.library_id === libraryId
      );
    });
    if (everyStamped) {
      return Object.freeze({
        operation_id: manifest.operationId,
        library_id: libraryId,
        revision,
        added: 0,
        idempotent: true,
      });
    }

    if (manifest.expectedRevision === null) {
      throw new DirectoryImportError("expected_revision is required for a first commit");
    }
    if (manifest.expectedRevision !== revision) throw new LibraryRevisionConflictError();

    let aggregate = 0;
    for (const item of manifest.items) {
      const source = sources.get(item.sourceId)!;
      const stamp = stampOf(decodeMeta(source.meta));
      if (stamp && stamp.operation_id !== manifest.operationId) {
        throw new DirectoryImportError(
          "a manifest source already belongs to another directory import",
          "DIRECTORY_IMPORT_SOURCE_STAMPED"
        );
      }
      if (source.status !== "ready") {
        throw new DirectoryImportError(
          "only ready sources can be committed to a library",
          "DIRECTORY_IMPORT_SOURCE_NOT_READY",
          409
        );
      }
      if (source.file_path === null || source.file_path === undefined) {
        throw new DirectoryImportError(
          "only upload-backed sources can be committed to a library",
          "DIRECTORY_IMPORT_SOURCE_NOT_READY",
          409
        );
      }
      if (source.connector !== null && source.connector !== undefined) {
        throw new DirectoryImportError(
          "connector sources cannot join a directory import",
          "DIRECTORY_IMPORT_SOURCE_CONNECTOR"
        );
      }
      const size = typeof source.size_bytes === "number" ? source.size_bytes : Number(source.size_bytes ?? 0);
      aggregate += Number.isSafeInteger(size) ? size : 0;
    }
    if (aggregate > MAX_DIRECTORY_IMPORT_BYTES) {
      throw new DirectoryImportError(
        "the manifest exceeds the 100 MiB aggregate directory-import budget",
        "DIRECTORY_IMPORT_SIZE_EXCEEDED",
        413
      );
    }
    const additions = manifest.items.filter((item) => !memberSet.has(item.sourceId)).length;
    if (memberSet.size + additions > MAX_LIBRARY_MEMBERS) {
      throw new DirectoryImportError(
        `the target library may hold at most ${MAX_LIBRARY_MEMBERS} sources`,
        "DIRECTORY_IMPORT_LIBRARY_FULL",
        409
      );
    }

    const timestamp = new Date().toISOString();
    let added = 0;
    for (const item of manifest.items) {
      const changed = transaction.run(
        "INSERT INTO library_sources (library_id,source_id,account_id,added_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
        [libraryId, item.sourceId, accountId, timestamp]
      );
      added += changed.changes;
      const source = sources.get(item.sourceId)!;
      const meta = decodeMeta(source.meta);
      meta[DIRECTORY_IMPORT_META_KEY] = {
        operation_id: manifest.operationId,
        relative_path: item.relativePath,
        library_id: libraryId,
        committed_at: timestamp,
      };
      transaction.run("UPDATE sources SET meta=? WHERE id=? AND account_id=?", [
        encodeJson(meta, "source meta"),
        item.sourceId,
        accountId,
      ]);
    }
    const nextMembers = new Set(memberSet);
    for (const item of manifest.items) nextMembers.add(item.sourceId);
    return Object.freeze({
      operation_id: manifest.operationId,
      library_id: libraryId,
      revision: libraryMembershipRevision(libraryId, nextMembers),
      added,
      idempotent: false,
    });
  });
}
