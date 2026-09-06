import { createHash, randomUUID } from "node:crypto";

import {
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  catalogStorePage,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../../catalogPagination.js";
import { isPlainHttpConnectionHost } from "../../connections/store.js";
import {
  decodeBoolean,
  decodeIsoTimestamp,
  decodeJson,
  decodeSafeInteger,
  encodeBoolean,
  encodeIsoTimestamp,
  encodeJson,
} from "../codecs.js";
import { SqliteConstraintError, type SqliteLedger, type SqliteTransaction } from "../types.js";
import { MAX_LIBRARY_MEMBERS } from "./libraryStore.js";

/**
 * Account-scoped living-knowledge ledger (schema v19).
 *
 * A knowledge connection is a desktop folder or a read-only WebDAV
 * collection whose files are managed as library sources with stable
 * identity `(account_id, connection_id, normalized relative_path)` and one
 * stable `source_id`. Identity is never content: a rename is a missing old
 * path plus a new path, and a same-path replacement reuses the source with a
 * new ingestion generation. mtime/size/etag columns are bounded hints; only
 * the lowercase SHA-256 `content_hash` decides unchanged.
 *
 * WebDAV credentials never cross this boundary: the ledger keeps the
 * `credential_configured` boolean only, and the material lives in the
 * shared connection secret store keyed by the same account/connection pair.
 * No table here references chats or chat scope — applying or refreshing a
 * connection can never change a chat's source selection.
 */

export const KNOWLEDGE_CONNECTION_KINDS = ["desktop_folder", "webdav"] as const;
export type KnowledgeConnectionKind = (typeof KNOWLEDGE_CONNECTION_KINDS)[number];

export const KNOWLEDGE_CONNECTION_STATUSES = ["untested", "ready", "disconnected", "error"] as const;
export type KnowledgeConnectionStatus = (typeof KNOWLEDGE_CONNECTION_STATUSES)[number];

export const KNOWLEDGE_ITEM_LIFECYCLES = ["active", "missing_upstream", "removed"] as const;
export type KnowledgeItemLifecycle = (typeof KNOWLEDGE_ITEM_LIFECYCLES)[number];

export const KNOWLEDGE_PREVIEW_STATUSES = ["pending", "complete", "failed", "applied", "expired"] as const;
export type KnowledgePreviewStatus = (typeof KNOWLEDGE_PREVIEW_STATUSES)[number];

export const KNOWLEDGE_PREVIEW_CLASSIFICATIONS = [
  "new",
  "changed",
  "unchanged",
  "duplicate",
  "missing",
  "unsupported",
] as const;
export type KnowledgePreviewClassification = (typeof KNOWLEDGE_PREVIEW_CLASSIFICATIONS)[number];

export const KNOWLEDGE_REFRESH_STATUSES = ["active", "completed", "partial", "failed", "cancelled"] as const;
export type KnowledgeRefreshStatus = (typeof KNOWLEDGE_REFRESH_STATUSES)[number];

export const KNOWLEDGE_REFRESH_REQUESTS = ["manual", "apply", "scheduled"] as const;
export type KnowledgeRefreshRequest = (typeof KNOWLEDGE_REFRESH_REQUESTS)[number];

export const KNOWLEDGE_REFRESH_ITEM_STATUSES = [
  "pending",
  "staged",
  "committed",
  "ready",
  "unchanged",
  "missing",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type KnowledgeRefreshItemStatus = (typeof KNOWLEDGE_REFRESH_ITEM_STATUSES)[number];

export const MAX_KNOWLEDGE_CONNECTION_NAME_CHARS = 120;
export const MAX_MANAGED_ITEMS_PER_CONNECTION = 100;
export const MAX_REFRESH_HISTORY_PER_CONNECTION = 100;
export const MAX_KNOWLEDGE_RELATIVE_PATH_CHARS = 1024;
export const MAX_PREVIEW_SCAN_ENTRIES = 1000;
export const MAX_PREVIEW_SCAN_DEPTH = 10;
export const MAX_PREVIEW_SCAN_VISITED = 1000;
export const MAX_PREVIEW_SCAN_BYTES = 100 * 1024 * 1024;
export const KNOWLEDGE_PREVIEW_TTL_MS = 10 * 60 * 1000;
export const MAX_KNOWLEDGE_SOURCE_NAME_CHARS = 63;

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_ATTEMPTS = 10_000;

export interface DesktopFolderConfig {
  readonly kind: "desktop_folder";
  readonly root_path: string;
  readonly display_label: string;
}

export interface WebDavConfig {
  readonly kind: "webdav";
  readonly url: string;
  readonly username: string;
}

export type KnowledgeConnectionConfig = DesktopFolderConfig | WebDavConfig;

export interface KnowledgeConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: KnowledgeConnectionKind;
  readonly library_id: string | null;
  readonly revision: number;
  readonly watch_enabled: boolean;
  readonly credential_configured: boolean;
  readonly status: KnowledgeConnectionStatus;
  readonly status_code: string | null;
  readonly config: KnowledgeConnectionConfig;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface KnowledgeItemRecord {
  readonly id: string;
  readonly connection_id: string;
  readonly relative_path: string;
  readonly source_id: string;
  /** Intended (last imported/staged) bytes identity. */
  readonly content_hash: string;
  /** What the source's current ready generation actually indexes. */
  readonly ingested_hash: string | null;
  readonly size_bytes: number;
  readonly lifecycle: KnowledgeItemLifecycle;
  readonly stale: boolean;
  readonly mtime_hint: string | null;
  readonly etag_hint: string | null;
  readonly last_refreshed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface KnowledgePreviewRecord {
  readonly id: string;
  readonly connection_id: string;
  readonly revision: number;
  readonly status: KnowledgePreviewStatus;
  readonly error_code: string | null;
  readonly scan_limit_entries: number;
  readonly scan_limit_depth: number;
  readonly scan_limit_visited: number;
  readonly scan_limit_bytes: number;
  readonly visited_entries: number;
  readonly directories: number;
  readonly aggregate_bytes: number;
  readonly new_count: number;
  readonly changed_count: number;
  readonly unchanged_count: number;
  readonly duplicate_count: number;
  readonly missing_count: number;
  readonly unsupported_count: number;
  readonly skipped_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly applied_at: string | null;
}

export interface KnowledgePreviewEntryRecord {
  readonly preview_id: string;
  readonly entry_id: string;
  readonly ordinal: number;
  readonly relative_path: string;
  readonly classification: KnowledgePreviewClassification;
  readonly content_hash: string | null;
  readonly size_bytes: number | null;
  readonly existing_source_id: string | null;
  readonly mtime_hint: string | null;
  readonly etag_hint: string | null;
  readonly selection_token: string;
}

export interface KnowledgeRefreshRecord {
  readonly id: string;
  readonly connection_id: string;
  readonly requested_by: KnowledgeRefreshRequest;
  readonly expected_connection_revision: number;
  readonly status: KnowledgeRefreshStatus;
  readonly cancel_requested: boolean;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly started_at: string;
  readonly finished_at: string | null;
}

export interface KnowledgeRefreshItemRecord {
  readonly refresh_id: string;
  readonly connection_id: string;
  readonly item_id: string;
  readonly source_id: string;
  readonly relative_path: string;
  readonly status: KnowledgeRefreshItemStatus;
  readonly target_hash: string | null;
  readonly candidate_path: string | null;
  readonly candidate_size_bytes: number | null;
  readonly current_ready_generation: number | null;
  readonly expected_generation: number | null;
  readonly promoted_generation: number | null;
  readonly attempts: number;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface KnowledgeScanBounds {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxVisited: number;
  readonly maxAggregateBytes: number;
}

export class KnowledgeConnectionConfigError extends Error {
  readonly code = "KNOWLEDGE_CONNECTION_CONFIG_INVALID";
  readonly statusCode = 400;

  constructor(message = "knowledge connection configuration is invalid") {
    super(message);
    this.name = "KnowledgeConnectionConfigError";
  }
}

export class DuplicateKnowledgeConnectionError extends Error {
  readonly code = "KNOWLEDGE_CONNECTION_NAME_TAKEN";
  readonly statusCode = 409;

  constructor() {
    super("a knowledge connection with this name already exists");
    this.name = "DuplicateKnowledgeConnectionError";
  }
}

export class KnowledgeConnectionNotFoundError extends Error {
  readonly code = "KNOWLEDGE_CONNECTION_NOT_FOUND";
  readonly statusCode = 404;

  constructor() {
    super("knowledge connection not found");
    this.name = "KnowledgeConnectionNotFoundError";
  }
}

export class KnowledgeConnectionRevisionConflictError extends Error {
  readonly code = "KNOWLEDGE_CONNECTION_REVISION_CONFLICT";
  readonly statusCode = 409;

  constructor() {
    super("the knowledge connection changed since it was loaded");
    this.name = "KnowledgeConnectionRevisionConflictError";
  }
}

export class KnowledgeItemNotFoundError extends Error {
  readonly code = "KNOWLEDGE_ITEM_NOT_FOUND";
  readonly statusCode = 404;

  constructor() {
    super("managed knowledge item not found");
    this.name = "KnowledgeItemNotFoundError";
  }
}

export class KnowledgeQuotaError extends Error {
  readonly code: string;
  readonly statusCode = 409;

  constructor(message: string, code = "KNOWLEDGE_QUOTA_EXCEEDED") {
    super(message);
    this.name = "KnowledgeQuotaError";
    this.code = code;
  }
}

export class KnowledgeLibraryUnavailableError extends Error {
  readonly code = "KNOWLEDGE_LIBRARY_UNAVAILABLE";
  readonly statusCode = 409;

  constructor(message = "the connection's target library is unavailable") {
    super(message);
    this.name = "KnowledgeLibraryUnavailableError";
  }
}

export class KnowledgePreviewNotFoundError extends Error {
  readonly code = "KNOWLEDGE_PREVIEW_NOT_FOUND";
  readonly statusCode = 404;

  constructor() {
    super("knowledge preview not found");
    this.name = "KnowledgePreviewNotFoundError";
  }
}

export class KnowledgePreviewStaleError extends Error {
  readonly code = "KNOWLEDGE_PREVIEW_STALE";
  readonly statusCode = 409;

  constructor(message = "the preview revision or a selected entry no longer matches the scan") {
    super(message);
    this.name = "KnowledgePreviewStaleError";
  }
}

export class KnowledgePreviewExpiredError extends Error {
  readonly code = "KNOWLEDGE_PREVIEW_EXPIRED";
  readonly statusCode = 410;

  constructor() {
    super("the knowledge preview expired");
    this.name = "KnowledgePreviewExpiredError";
  }
}

export class KnowledgePreviewSelectionError extends Error {
  readonly code = "KNOWLEDGE_PREVIEW_SELECTION_INVALID";
  readonly statusCode = 400;

  constructor(message = "the preview selection is invalid") {
    super(message);
    this.name = "KnowledgePreviewSelectionError";
  }
}

export class KnowledgeRefreshConflictError extends Error {
  readonly code = "KNOWLEDGE_REFRESH_ACTIVE";
  readonly statusCode = 409;

  constructor() {
    super("a refresh is already active for this connection");
    this.name = "KnowledgeRefreshConflictError";
  }
}

export class KnowledgeRefreshNotFoundError extends Error {
  readonly code = "KNOWLEDGE_REFRESH_NOT_FOUND";
  readonly statusCode = 404;

  constructor() {
    super("knowledge refresh not found");
    this.name = "KnowledgeRefreshNotFoundError";
  }
}

/** Deterministic per-entry selection token bound to the exact preview revision. */
export function knowledgeSelectionToken(
  previewId: string,
  revision: number,
  entryId: string,
  classification: KnowledgePreviewClassification,
  contentHash: string | null,
  existingSourceId: string | null
): string {
  return createHash("sha256")
    .update(
      `borealis-knowledge-preview:v1|${previewId}|${revision}|${entryId}|${classification}|${contentHash ?? ""}|${existingSourceId ?? ""}`,
      "utf8"
    )
    .digest("hex");
}

/**
 * Normalizes and validates a managed relative path. Identity is a POSIX
 * slash path: absolute paths, backslashes, traversal segments, empty or
 * hidden segments, and leading/trailing separators are refused. Returns
 * `null` for anything outside the identity contract.
 */
export function normalizeKnowledgeRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_KNOWLEDGE_RELATIVE_PATH_CHARS) return null;
  if (value.includes("\0") || /[\r\n]/.test(value) || value.includes("\\")) return null;
  if (value.trim() !== value || value.startsWith("/") || value.endsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(value)) return null;
  const segments = value.split("/");
  if (segments.length < 1 || segments.some((segment) => segment.length < 1)) return null;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return null;
    // Hidden segments are excluded by default; a scan reports them skipped.
    if (segment.startsWith(".")) return null;
  }
  return value;
}

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\0")) {
    throw new TypeError(`${field} violates the knowledge store input contract`);
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : value;
}

function requiredRelativePath(value: string, field: string): string {
  const normalized = normalizeKnowledgeRelativePath(value);
  if (normalized === null) throw new KnowledgeConnectionConfigError(`${field} is not a valid relative path`);
  return normalized;
}

function requiredHash(value: string, field: string): string {
  if (typeof value !== "string" || !CONTENT_HASH_PATTERN.test(value)) {
    throw new KnowledgeConnectionConfigError(`${field} must be a lowercase sha256 hex digest`);
  }
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    Array.from(value).length > maximum ||
    value.includes("\0")
  ) {
    throw new KnowledgeConnectionConfigError(`${field} is invalid`);
  }
  return value;
}

function optionalHint(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || Array.from(value).length > maximum || /[\0\r\n]/.test(value)) {
    throw new KnowledgeConnectionConfigError(`${field} is invalid`);
  }
  return value;
}

function connectionName(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    trimmed.length < 1 ||
    trimmed.length > MAX_KNOWLEDGE_CONNECTION_NAME_CHARS ||
    trimmed.includes("\0") ||
    /[\r\n]/.test(trimmed)
  ) {
    throw new KnowledgeConnectionConfigError("knowledge connection name must be 1-120 characters");
  }
  return trimmed;
}

function desktopFolderConfig(value: Record<string, unknown>): DesktopFolderConfig {
  if (Object.keys(value).some((key) => key !== "root_path" && key !== "display_label")) {
    throw new KnowledgeConnectionConfigError("desktop folder configuration fields are invalid");
  }
  const rootPath = boundedText(value.root_path, "root_path", 32_768);
  if (!rootPath.startsWith("/")) {
    throw new KnowledgeConnectionConfigError("desktop folder root_path must be an absolute path");
  }
  if (/[\r\n]/.test(rootPath)) throw new KnowledgeConnectionConfigError("desktop folder root_path is invalid");
  return Object.freeze({
    kind: "desktop_folder",
    root_path: rootPath,
    display_label: boundedText(value.display_label, "display_label", MAX_KNOWLEDGE_CONNECTION_NAME_CHARS),
  });
}

function webDavConfig(value: Record<string, unknown>): WebDavConfig {
  if (Object.keys(value).some((key) => key !== "url" && key !== "username")) {
    throw new KnowledgeConnectionConfigError("webdav configuration fields are invalid");
  }
  const raw = boundedText(value.url, "url", 2_000);
  if (/[\r\n]/.test(raw)) throw new KnowledgeConnectionConfigError("webdav url is invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KnowledgeConnectionConfigError("webdav url is invalid");
  }
  // HTTPS except the operator-supported loopback/.local network policy; URL
  // credentials, queries, and fragments never reach a stored endpoint.
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isPlainHttpConnectionHost(url.hostname))) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length < 1 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new KnowledgeConnectionConfigError("webdav url is invalid");
  }
  return Object.freeze({
    kind: "webdav",
    url: raw,
    username: boundedText(value.username, "username", 256),
  });
}

function validatedConfig(kind: KnowledgeConnectionKind, value: unknown): KnowledgeConnectionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeConnectionConfigError("knowledge connection configuration must be an object");
  }
  const record = value as Record<string, unknown>;
  return kind === "desktop_folder" ? desktopFolderConfig(record) : webDavConfig(record);
}

function configWithoutKind(config: KnowledgeConnectionConfig): Record<string, unknown> {
  return config.kind === "desktop_folder"
    ? { root_path: config.root_path, display_label: config.display_label }
    : { url: config.url, username: config.username };
}

/** Revalidates stored JSON on every read; a damaged row fails closed. */
export function decodeKnowledgeConnectionConfig(
  kind: KnowledgeConnectionKind,
  raw: unknown
): KnowledgeConnectionConfig {
  const parsed = decodeJson<unknown>(raw, "knowledge connection config");
  const config = validatedConfig(kind, parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(configWithoutKind(config))) {
    throw new KnowledgeConnectionConfigError("stored knowledge connection configuration is unreadable");
  }
  return config;
}

export function validateKnowledgeScanBounds(bounds: KnowledgeScanBounds): KnowledgeScanBounds {
  const entries = bounds.maxEntries;
  const depth = bounds.maxDepth;
  const visited = bounds.maxVisited;
  const bytes = bounds.maxAggregateBytes;
  if (
    !Number.isSafeInteger(entries) ||
    entries < 1 ||
    entries > MAX_PREVIEW_SCAN_ENTRIES ||
    !Number.isSafeInteger(depth) ||
    depth < 1 ||
    depth > MAX_PREVIEW_SCAN_DEPTH ||
    !Number.isSafeInteger(visited) ||
    visited < 1 ||
    visited > MAX_PREVIEW_SCAN_VISITED ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_PREVIEW_SCAN_BYTES
  ) {
    throw new RangeError(
      `knowledge scan bounds must be within ${MAX_PREVIEW_SCAN_ENTRIES} entries, ${MAX_PREVIEW_SCAN_DEPTH} levels, ` +
        `${MAX_PREVIEW_SCAN_VISITED} visited entries, and ${MAX_PREVIEW_SCAN_BYTES} aggregate bytes`
    );
  }
  return Object.freeze({ maxEntries: entries, maxDepth: depth, maxVisited: visited, maxAggregateBytes: bytes });
}

interface ConnectionRow {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  library_id?: unknown;
  revision?: unknown;
  watch_enabled?: unknown;
  credential_configured?: unknown;
  status?: unknown;
  status_code?: unknown;
  config?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface ItemRow {
  id?: unknown;
  connection_id?: unknown;
  relative_path?: unknown;
  source_id?: unknown;
  content_hash?: unknown;
  ingested_hash?: unknown;
  size_bytes?: unknown;
  lifecycle?: unknown;
  stale?: unknown;
  mtime_hint?: unknown;
  etag_hint?: unknown;
  last_refreshed_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface PreviewRow {
  id?: unknown;
  connection_id?: unknown;
  revision?: unknown;
  status?: unknown;
  error_code?: unknown;
  scan_limit_entries?: unknown;
  scan_limit_depth?: unknown;
  scan_limit_visited?: unknown;
  scan_limit_bytes?: unknown;
  visited_entries?: unknown;
  directories?: unknown;
  aggregate_bytes?: unknown;
  new_count?: unknown;
  changed_count?: unknown;
  unchanged_count?: unknown;
  duplicate_count?: unknown;
  missing_count?: unknown;
  unsupported_count?: unknown;
  skipped_count?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  expires_at?: unknown;
  applied_at?: unknown;
}

interface PreviewEntryRow {
  preview_id?: unknown;
  entry_id?: unknown;
  ordinal?: unknown;
  relative_path?: unknown;
  classification?: unknown;
  content_hash?: unknown;
  size_bytes?: unknown;
  existing_source_id?: unknown;
  mtime_hint?: unknown;
  etag_hint?: unknown;
  selection_token?: unknown;
}

interface RefreshRow {
  id?: unknown;
  connection_id?: unknown;
  requested_by?: unknown;
  expected_connection_revision?: unknown;
  status?: unknown;
  cancel_requested?: unknown;
  error_code?: unknown;
  created_at?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
}

interface RefreshItemRow {
  refresh_id?: unknown;
  connection_id?: unknown;
  item_id?: unknown;
  source_id?: unknown;
  relative_path?: unknown;
  status?: unknown;
  target_hash?: unknown;
  candidate_path?: unknown;
  candidate_size_bytes?: unknown;
  current_ready_generation?: unknown;
  expected_generation?: unknown;
  promoted_generation?: unknown;
  attempts?: unknown;
  error_code?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function storedText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is not stored as text`);
  return value;
}

function optionalStoredText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return storedText(value, field);
}

function storedEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${field} is invalid`);
  return value as Values[number];
}

function optionalSafeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return decodeSafeInteger(value, field);
}

function decodeConnection(row: ConnectionRow): KnowledgeConnectionRecord {
  const kind = storedEnum(row.kind, KNOWLEDGE_CONNECTION_KINDS, "knowledge connection kind");
  return Object.freeze({
    id: storedText(row.id, "knowledge connection id"),
    name: storedText(row.name, "knowledge connection name"),
    kind,
    library_id: optionalStoredText(row.library_id, "knowledge connection library id"),
    revision: decodeSafeInteger(row.revision, "knowledge connection revision"),
    watch_enabled: decodeBoolean(row.watch_enabled, "knowledge connection watch"),
    credential_configured: decodeBoolean(row.credential_configured, "knowledge connection credential flag"),
    status: storedEnum(row.status, KNOWLEDGE_CONNECTION_STATUSES, "knowledge connection status"),
    status_code: optionalStoredText(row.status_code, "knowledge connection status code"),
    config: decodeKnowledgeConnectionConfig(kind, row.config),
    created_at: decodeIsoTimestamp(row.created_at, "knowledge connection created_at"),
    updated_at: decodeIsoTimestamp(row.updated_at, "knowledge connection updated_at"),
  });
}

function decodeItem(row: ItemRow): KnowledgeItemRecord {
  return Object.freeze({
    id: storedText(row.id, "knowledge item id"),
    connection_id: storedText(row.connection_id, "knowledge item connection id"),
    relative_path: storedText(row.relative_path, "knowledge item relative path"),
    source_id: storedText(row.source_id, "knowledge item source id"),
    content_hash: storedText(row.content_hash, "knowledge item content hash"),
    ingested_hash: optionalStoredText(row.ingested_hash, "knowledge item ingested hash"),
    size_bytes: decodeSafeInteger(row.size_bytes, "knowledge item size_bytes"),
    lifecycle: storedEnum(row.lifecycle, KNOWLEDGE_ITEM_LIFECYCLES, "knowledge item lifecycle"),
    stale: decodeBoolean(row.stale, "knowledge item stale flag"),
    mtime_hint: optionalStoredText(row.mtime_hint, "knowledge item mtime hint"),
    etag_hint: optionalStoredText(row.etag_hint, "knowledge item etag hint"),
    last_refreshed_at: optionalStoredText(row.last_refreshed_at, "knowledge item last_refreshed_at"),
    created_at: decodeIsoTimestamp(row.created_at, "knowledge item created_at"),
    updated_at: decodeIsoTimestamp(row.updated_at, "knowledge item updated_at"),
  });
}

function decodePreview(row: PreviewRow): KnowledgePreviewRecord {
  return Object.freeze({
    id: storedText(row.id, "knowledge preview id"),
    connection_id: storedText(row.connection_id, "knowledge preview connection id"),
    revision: decodeSafeInteger(row.revision, "knowledge preview revision"),
    status: storedEnum(row.status, KNOWLEDGE_PREVIEW_STATUSES, "knowledge preview status"),
    error_code: optionalStoredText(row.error_code, "knowledge preview error code"),
    scan_limit_entries: decodeSafeInteger(row.scan_limit_entries, "knowledge preview entry limit"),
    scan_limit_depth: decodeSafeInteger(row.scan_limit_depth, "knowledge preview depth limit"),
    scan_limit_visited: decodeSafeInteger(row.scan_limit_visited, "knowledge preview visited limit"),
    scan_limit_bytes: decodeSafeInteger(row.scan_limit_bytes, "knowledge preview byte limit"),
    visited_entries: decodeSafeInteger(row.visited_entries, "knowledge preview visited count"),
    directories: decodeSafeInteger(row.directories, "knowledge preview directory count"),
    aggregate_bytes: decodeSafeInteger(row.aggregate_bytes, "knowledge preview aggregate bytes"),
    new_count: decodeSafeInteger(row.new_count, "knowledge preview new count"),
    changed_count: decodeSafeInteger(row.changed_count, "knowledge preview changed count"),
    unchanged_count: decodeSafeInteger(row.unchanged_count, "knowledge preview unchanged count"),
    duplicate_count: decodeSafeInteger(row.duplicate_count, "knowledge preview duplicate count"),
    missing_count: decodeSafeInteger(row.missing_count, "knowledge preview missing count"),
    unsupported_count: decodeSafeInteger(row.unsupported_count, "knowledge preview unsupported count"),
    skipped_count: decodeSafeInteger(row.skipped_count, "knowledge preview skipped count"),
    created_at: decodeIsoTimestamp(row.created_at, "knowledge preview created_at"),
    updated_at: decodeIsoTimestamp(row.updated_at, "knowledge preview updated_at"),
    expires_at: decodeIsoTimestamp(row.expires_at, "knowledge preview expires_at"),
    applied_at: optionalStoredText(row.applied_at, "knowledge preview applied_at"),
  });
}

function decodePreviewEntry(row: PreviewEntryRow): KnowledgePreviewEntryRecord {
  return Object.freeze({
    preview_id: storedText(row.preview_id, "knowledge preview entry preview id"),
    entry_id: storedText(row.entry_id, "knowledge preview entry id"),
    ordinal: decodeSafeInteger(row.ordinal, "knowledge preview entry ordinal"),
    relative_path: storedText(row.relative_path, "knowledge preview entry relative path"),
    classification: storedEnum(
      row.classification,
      KNOWLEDGE_PREVIEW_CLASSIFICATIONS,
      "knowledge preview classification"
    ),
    content_hash: optionalStoredText(row.content_hash, "knowledge preview entry content hash"),
    size_bytes: optionalSafeInteger(row.size_bytes, "knowledge preview entry size_bytes"),
    existing_source_id: optionalStoredText(row.existing_source_id, "knowledge preview entry source id"),
    mtime_hint: optionalStoredText(row.mtime_hint, "knowledge preview entry mtime hint"),
    etag_hint: optionalStoredText(row.etag_hint, "knowledge preview entry etag hint"),
    selection_token: storedText(row.selection_token, "knowledge preview entry selection token"),
  });
}

function decodeRefresh(row: RefreshRow): KnowledgeRefreshRecord {
  return Object.freeze({
    id: storedText(row.id, "knowledge refresh id"),
    connection_id: storedText(row.connection_id, "knowledge refresh connection id"),
    requested_by: storedEnum(row.requested_by, KNOWLEDGE_REFRESH_REQUESTS, "knowledge refresh requested_by"),
    expected_connection_revision: decodeSafeInteger(
      row.expected_connection_revision,
      "knowledge refresh expected connection revision"
    ),
    status: storedEnum(row.status, KNOWLEDGE_REFRESH_STATUSES, "knowledge refresh status"),
    cancel_requested: decodeBoolean(row.cancel_requested, "knowledge refresh cancel flag"),
    error_code: optionalStoredText(row.error_code, "knowledge refresh error code"),
    created_at: decodeIsoTimestamp(row.created_at, "knowledge refresh created_at"),
    started_at: decodeIsoTimestamp(row.started_at, "knowledge refresh started_at"),
    finished_at: optionalStoredText(row.finished_at, "knowledge refresh finished_at"),
  });
}

function decodeRefreshItem(row: RefreshItemRow): KnowledgeRefreshItemRecord {
  return Object.freeze({
    refresh_id: storedText(row.refresh_id, "knowledge refresh item refresh id"),
    connection_id: storedText(row.connection_id, "knowledge refresh item connection id"),
    item_id: storedText(row.item_id, "knowledge refresh item item id"),
    source_id: storedText(row.source_id, "knowledge refresh item source id"),
    relative_path: storedText(row.relative_path, "knowledge refresh item relative path"),
    status: storedEnum(row.status, KNOWLEDGE_REFRESH_ITEM_STATUSES, "knowledge refresh item status"),
    target_hash: optionalStoredText(row.target_hash, "knowledge refresh item target hash"),
    candidate_path: optionalStoredText(row.candidate_path, "knowledge refresh item candidate path"),
    candidate_size_bytes: optionalSafeInteger(row.candidate_size_bytes, "knowledge refresh item candidate size"),
    current_ready_generation: optionalSafeInteger(row.current_ready_generation, "knowledge refresh item ready gen"),
    expected_generation: optionalSafeInteger(row.expected_generation, "knowledge refresh item expected gen"),
    promoted_generation: optionalSafeInteger(row.promoted_generation, "knowledge refresh item promoted gen"),
    attempts: decodeSafeInteger(row.attempts, "knowledge refresh item attempts"),
    error_code: optionalStoredText(row.error_code, "knowledge refresh item error code"),
    created_at: decodeIsoTimestamp(row.created_at, "knowledge refresh item created_at"),
    updated_at: decodeIsoTimestamp(row.updated_at, "knowledge refresh item updated_at"),
  });
}

const CONNECTION_COLUMNS = `id,name,kind,library_id,revision,watch_enabled,credential_configured,status,status_code,config,created_at,updated_at`;
const ITEM_COLUMNS = `id,connection_id,relative_path,source_id,content_hash,ingested_hash,size_bytes,lifecycle,stale,mtime_hint,etag_hint,last_refreshed_at,created_at,updated_at`;
const PREVIEW_COLUMNS = `id,connection_id,revision,status,error_code,scan_limit_entries,scan_limit_depth,scan_limit_visited,scan_limit_bytes,visited_entries,directories,aggregate_bytes,new_count,changed_count,unchanged_count,duplicate_count,missing_count,unsupported_count,skipped_count,created_at,updated_at,expires_at,applied_at`;
const PREVIEW_ENTRY_COLUMNS = `preview_id,entry_id,ordinal,relative_path,classification,content_hash,size_bytes,existing_source_id,mtime_hint,etag_hint,selection_token`;
const REFRESH_COLUMNS = `id,connection_id,requested_by,expected_connection_revision,status,cancel_requested,error_code,created_at,started_at,finished_at`;
const REFRESH_ITEM_COLUMNS = `refresh_id,connection_id,item_id,source_id,relative_path,status,target_hash,candidate_path,candidate_size_bytes,current_ready_generation,expected_generation,promoted_generation,attempts,error_code,created_at,updated_at`;

export interface CreateKnowledgeConnectionInput {
  readonly name: string;
  readonly kind: unknown;
  readonly config: unknown;
  readonly library_id: string;
  readonly watch_enabled?: boolean;
}

export interface UpdateKnowledgeConnectionPatch {
  readonly name?: string;
  readonly config?: unknown;
  readonly watch_enabled?: boolean;
  readonly expected_revision: number;
}

export interface PreviewScanEntryInput {
  readonly relative_path: string;
  readonly classification: KnowledgePreviewClassification;
  readonly content_hash: string | null;
  readonly size_bytes: number | null;
  readonly existing_source_id?: string | null;
  readonly mtime_hint?: string | null;
  readonly etag_hint?: string | null;
}

export interface CompletePreviewInput {
  readonly visited_entries: number;
  readonly directories: number;
  readonly aggregate_bytes: number;
  /**
   * Entries the upstream scan reported as skipped (hidden, symlink, excluded,
   * depth, or limit). Persisted on the preview row so the preview surface can
   * show what the scan did NOT ingest; skipped paths themselves never become
   * selectable entries.
   */
  readonly skipped_count: number;
  readonly entries: readonly PreviewScanEntryInput[];
}

export interface StagedKnowledgeEntry {
  /** Durable path the transport staged for this entry's current bytes. */
  readonly file_path: string;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly mime: string;
  readonly kind: "document" | "tabular";
}

export interface PreviewSelection {
  readonly entry_id: string;
  readonly selection_token: string;
  readonly staged: StagedKnowledgeEntry;
  /**
   * Transport-staged new sources carry the preallocated UUID whose
   * account/source upload directory already owns the bytes; the commit binds
   * that exact id. Absent falls back to a freshly allocated source UUID.
   */
  readonly proposed_source_id?: string | null;
}

export interface ApplyPreviewInput {
  readonly expected_revision: number;
  readonly selections: readonly PreviewSelection[];
}

export interface AppliedPreviewItem {
  readonly entry_id: string;
  readonly item_id: string;
  readonly source_id: string;
  readonly relative_path: string;
  readonly action: "created" | "updated";
}

export interface AppliedPreview {
  readonly preview: KnowledgePreviewRecord;
  readonly items: readonly AppliedPreviewItem[];
}

export interface BeginRefreshInput {
  readonly connection_id: string;
  readonly expected_connection_revision: number;
  readonly requested_by?: KnowledgeRefreshRequest;
  /** Exact managed-item allowlist; omit to refresh all non-removed items. */
  readonly item_ids?: readonly string[];
}

export interface BegunRefresh {
  readonly refresh: KnowledgeRefreshRecord;
  readonly items: readonly KnowledgeRefreshItemRecord[];
}

export interface SourceIngestionState {
  readonly sourceId: string;
  readonly sourceStatus: "ready" | "index" | "error";
  readonly readyGeneration: number | null;
  readonly jobStatus: "preparing" | "pending" | "running" | "done" | "error" | null;
  readonly jobGeneration: number | null;
  /** Internal durable path: transport staging only, never a public DTO. */
  readonly filePath: string | null;
}

export interface RefreshItemOutcomeUpdate {
  readonly status: "unchanged" | "missing" | "failed" | "blocked" | "cancelled";
  readonly error_code?: string | null;
  readonly content_hash?: string | null;
  readonly size_bytes?: number | null;
  readonly mtime_hint?: string | null;
  readonly etag_hint?: string | null;
}

export interface KnowledgeStoreOptions {
  readonly now?: () => Date;
}

/**
 * Typed ledger operations for knowledge connections, managed items,
 * previews, and durable refreshes. Every method is account-scoped; every
 * mutation is either a revision/generation CAS or a quota-bounded
 * transaction. This store never touches chats, chat_sources, ingestion
 * internals, or secret material.
 */
export class KnowledgeStore {
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: KnowledgeStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "now");
  }

  // ---------------------------------------------------------------- connections

  async listConnections(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<KnowledgeConnectionRecord>> {
    const accountId = requiredId(accountIdValue, "account id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId];
    const after = page.after ? " AND (c.created_at,c.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM knowledge_connections c
       WHERE c.account_id=?${after}
       ORDER BY c.created_at DESC,c.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(rows.map(decodeConnection), page, (connection) => ({
      timestamp: connection.created_at,
      id: connection.id,
    }));
  }

  async createConnection(
    accountIdValue: string,
    input: CreateKnowledgeConnectionInput
  ): Promise<KnowledgeConnectionRecord> {
    const accountId = requiredId(accountIdValue, "account id");
    const name = connectionName(input.name);
    const kind = storedEnum(input.kind, KNOWLEDGE_CONNECTION_KINDS, "knowledge connection kind");
    const config = validatedConfig(kind, input.config);
    // Watch is a desktop-only capability; WebDAV connections never default it on.
    const watchEnabled = input.watch_enabled === undefined ? false : input.watch_enabled === true;
    if (kind === "webdav" && watchEnabled) {
      throw new KnowledgeConnectionConfigError("webdav connections cannot enable automatic watching");
    }
    const libraryId = requiredId(input.library_id, "library id");
    const id = randomUUID();
    const timestamp = this.timestamp();
    try {
      await this.ledger.withImmediateTransaction((transaction) => {
        const library = transaction.get("SELECT 1 FROM libraries WHERE id=? AND account_id=?", [libraryId, accountId]);
        if (!library) throw new KnowledgeLibraryUnavailableError("target library does not exist in this account");
        transaction.run(
          `INSERT INTO knowledge_connections
             (id,account_id,library_id,kind,name,config,watch_enabled,credential_configured,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,0,'untested',?,?)`,
          [
            id,
            accountId,
            libraryId,
            kind,
            name,
            encodeJson(configWithoutKind(config), "knowledge connection config"),
            encodeBoolean(watchEnabled),
            timestamp,
            timestamp,
          ]
        );
      });
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique")
        throw new DuplicateKnowledgeConnectionError();
      throw error;
    }
    return this.requireConnection(accountId, id);
  }

  async getConnection(
    accountIdValue: string,
    connectionIdValue: string
  ): Promise<KnowledgeConnectionRecord | undefined> {
    const row = await this.ledger.get<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM knowledge_connections WHERE id=? AND account_id=?`,
      [requiredId(connectionIdValue, "knowledge connection id"), requiredId(accountIdValue, "account id")]
    );
    return row ? decodeConnection(row) : undefined;
  }

  async requireConnection(accountId: string, connectionId: string): Promise<KnowledgeConnectionRecord> {
    const connection = await this.getConnection(accountId, connectionId);
    if (!connection) throw new KnowledgeConnectionNotFoundError();
    return connection;
  }

  /**
   * Optimistic edit with `expected_revision`. Name and configuration edits are
   * a new revision (and a configuration edit resets the status evidence); the
   * watch toggle is durable state a runtime reads per call and never rewrites
   * the configuration lineage.
   */
  async updateConnection(
    accountIdValue: string,
    connectionIdValue: string,
    patch: UpdateKnowledgeConnectionPatch
  ): Promise<KnowledgeConnectionRecord> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(connectionIdValue, "knowledge connection id");
    const expected = patch.expected_revision;
    if (!Number.isSafeInteger(expected) || expected < 1) {
      throw new KnowledgeConnectionConfigError("expected_revision is invalid");
    }
    try {
      await this.ledger.withImmediateTransaction((transaction) => {
        const row = transaction.get<{ kind: string; revision: unknown }>(
          "SELECT kind,revision FROM knowledge_connections WHERE id=? AND account_id=?",
          [connectionId, accountId]
        );
        if (!row) throw new KnowledgeConnectionNotFoundError();
        if (decodeSafeInteger(row.revision, "revision") !== expected)
          throw new KnowledgeConnectionRevisionConflictError();
        const kind = storedEnum(row.kind, KNOWLEDGE_CONNECTION_KINDS, "knowledge connection kind");
        const name = patch.name === undefined ? undefined : connectionName(patch.name);
        const config = patch.config === undefined ? undefined : validatedConfig(kind, patch.config);
        const updates: string[] = [];
        const values: Array<string | number> = [];
        if (name !== undefined) {
          updates.push("name=?");
          values.push(name);
        }
        if (config !== undefined) {
          updates.push("config=?", "status='untested'", "status_code=NULL");
          values.push(encodeJson(configWithoutKind(config), "knowledge connection config"));
        }
        if (patch.watch_enabled !== undefined) {
          if (kind === "webdav" && patch.watch_enabled) {
            throw new KnowledgeConnectionConfigError("webdav connections cannot enable automatic watching");
          }
          updates.push("watch_enabled=?");
          values.push(encodeBoolean(patch.watch_enabled));
        }
        const editsConfiguration = name !== undefined || config !== undefined;
        if (editsConfiguration) updates.push("revision=revision+1");
        updates.push("updated_at=?");
        values.push(this.timestamp());
        const changed = transaction.run(
          `UPDATE knowledge_connections SET ${updates.join(",")} WHERE id=? AND account_id=? AND revision=?`,
          [...values, connectionId, accountId, expected]
        );
        if (changed.changes !== 1) throw new KnowledgeConnectionRevisionConflictError();
      });
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique")
        throw new DuplicateKnowledgeConnectionError();
      throw error;
    }
    return this.requireConnection(accountId, connectionId);
  }

  /** Records the boolean evidence that credentials reached/lost shared custody. */
  async setCredentialConfigured(accountIdValue: string, connectionIdValue: string, configured: boolean): Promise<void> {
    if (typeof configured !== "boolean") throw new TypeError("configured must be a boolean");
    const changed = await this.ledger.run(
      `UPDATE knowledge_connections SET credential_configured=?,updated_at=?
       WHERE id=? AND account_id=? AND kind='webdav'`,
      [
        encodeBoolean(configured),
        this.timestamp(),
        requiredId(connectionIdValue, "knowledge connection id"),
        requiredId(accountIdValue, "account id"),
      ]
    );
    if (changed.changes !== 1) throw new KnowledgeConnectionNotFoundError();
  }

  async recordConnectionStatus(
    accountIdValue: string,
    connectionIdValue: string,
    status: KnowledgeConnectionStatus,
    code?: string | null
  ): Promise<void> {
    if (!KNOWLEDGE_CONNECTION_STATUSES.includes(status)) {
      throw new KnowledgeConnectionConfigError("knowledge connection status is invalid");
    }
    const statusCode = code === undefined ? null : code;
    if (statusCode !== null && (typeof statusCode !== "string" || statusCode.length < 1 || statusCode.length > 64)) {
      throw new KnowledgeConnectionConfigError("knowledge connection status code is invalid");
    }
    await this.ledger.run(
      `UPDATE knowledge_connections SET status=?,status_code=?,updated_at=?
       WHERE id=? AND account_id=?`,
      [
        status,
        statusCode,
        this.timestamp(),
        requiredId(connectionIdValue, "knowledge connection id"),
        requiredId(accountIdValue, "account id"),
      ]
    );
  }

  /**
   * Removes the connection and cascades its items/previews/refresh mappings.
   * Sources, library membership, reports, and captured evidence are never
   * touched; the caller best-effort removes shared-store credentials after.
   */
  async deleteConnection(accountIdValue: string, connectionIdValue: string): Promise<boolean> {
    const changed = await this.ledger.run("DELETE FROM knowledge_connections WHERE id=? AND account_id=?", [
      requiredId(connectionIdValue, "knowledge connection id"),
      requiredId(accountIdValue, "account id"),
    ]);
    return changed.changes === 1;
  }

  // --------------------------------------------------------------------- items

  async listItems(
    accountIdValue: string,
    connectionIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<KnowledgeItemRecord>> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(connectionIdValue, "knowledge connection id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId, connectionId];
    const after = page.after ? " AND (i.created_at,i.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM knowledge_items i
       WHERE i.account_id=? AND i.connection_id=?${after}
       ORDER BY i.created_at DESC,i.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(rows.map(decodeItem), page, (item) => ({ timestamp: item.created_at, id: item.id }));
  }

  async getItem(accountIdValue: string, itemIdValue: string): Promise<KnowledgeItemRecord | undefined> {
    const row = await this.ledger.get<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE id=? AND account_id=?`,
      [requiredId(itemIdValue, "knowledge item id"), requiredId(accountIdValue, "account id")]
    );
    return row ? decodeItem(row) : undefined;
  }

  async getItemsByIds(
    accountIdValue: string,
    itemIdsValue: readonly string[]
  ): Promise<readonly KnowledgeItemRecord[]> {
    const accountId = requiredId(accountIdValue, "account id");
    if (!Array.isArray(itemIdsValue) || itemIdsValue.length > MAX_MANAGED_ITEMS_PER_CONNECTION) {
      throw new RangeError(`an item allowlist may hold at most ${MAX_MANAGED_ITEMS_PER_CONNECTION} ids`);
    }
    const itemIds = [...new Set(itemIdsValue.map((id) => requiredId(id, "knowledge item id")))];
    if (itemIds.length === 0) return [];
    const rows = await this.ledger.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM knowledge_items
       WHERE account_id=? AND id IN (${itemIds.map(() => "?").join(",")})`,
      [accountId, ...itemIds]
    );
    return rows.map(decodeItem);
  }

  /**
   * The explicit remove-from-library action: the mapping becomes `removed`
   * and library membership goes away. The source and its content are never
   * deleted here; that is the separate normal source-deletion action.
   */
  async removeItem(accountIdValue: string, itemIdValue: string): Promise<KnowledgeItemRecord | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const itemId = requiredId(itemIdValue, "knowledge item id");
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction): KnowledgeItemRecord | undefined => {
      const row = transaction.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE id=? AND account_id=?`, [
        itemId,
        accountId,
      ]);
      if (!row || row.lifecycle === "removed") return row ? decodeItem(row) : undefined;
      const sourceId = storedText(row.source_id, "knowledge item source id");
      transaction.run("DELETE FROM library_sources WHERE source_id=? AND account_id=?", [sourceId, accountId]);
      const changed = transaction.run(
        `UPDATE knowledge_items SET lifecycle='removed',stale=0,mtime_hint=NULL,etag_hint=NULL,last_refreshed_at=?,updated_at=?
         WHERE id=? AND account_id=?`,
        [timestamp, timestamp, itemId, accountId]
      );
      if (changed.changes !== 1) throw new Error("knowledge item removal lost transaction ownership");
      const updated = transaction.get<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE id=? AND account_id=?`,
        [itemId, accountId]
      );
      if (!updated) throw new Error("knowledge item removal did not persist");
      return decodeItem(updated);
    });
  }

  async countManagedItems(accountIdValue: string, connectionIdValue: string): Promise<number> {
    const row = await this.ledger.get<{ n: number | bigint }>(
      "SELECT COUNT(*) AS n FROM knowledge_items WHERE account_id=? AND connection_id=?",
      [requiredId(accountIdValue, "account id"), requiredId(connectionIdValue, "knowledge connection id")]
    );
    return decodeSafeInteger(row?.n ?? 0, "managed item count");
  }

  // ----------------------------------------------------------------- previews

  async createPreview(
    accountIdValue: string,
    connectionIdValue: string,
    boundsValue: KnowledgeScanBounds
  ): Promise<KnowledgePreviewRecord> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(connectionIdValue, "knowledge connection id");
    const bounds = validateKnowledgeScanBounds(boundsValue);
    const id = randomUUID();
    const timestamp = this.timestamp();
    const expiresAt = encodeIsoTimestamp(new Date(this.now().getTime() + KNOWLEDGE_PREVIEW_TTL_MS), "expiry");
    await this.ledger.withImmediateTransaction((transaction) => {
      if (
        !transaction.get("SELECT 1 FROM knowledge_connections WHERE id=? AND account_id=?", [connectionId, accountId])
      ) {
        throw new KnowledgeConnectionNotFoundError();
      }
      transaction.run(
        `INSERT INTO knowledge_previews
           (id,account_id,connection_id,scan_limit_entries,scan_limit_depth,scan_limit_visited,scan_limit_bytes,
            created_at,updated_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          accountId,
          connectionId,
          bounds.maxEntries,
          bounds.maxDepth,
          bounds.maxVisited,
          bounds.maxAggregateBytes,
          timestamp,
          timestamp,
          expiresAt,
        ]
      );
    });
    const preview = await this.getPreview(accountId, id);
    if (!preview) throw new Error("knowledge preview insert did not persist");
    return preview;
  }

  /** Reads the account's preview, lazily recording expiry of uncommitted scans. */
  async getPreview(accountIdValue: string, previewIdValue: string): Promise<KnowledgePreviewRecord | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const previewId = requiredId(previewIdValue, "knowledge preview id");
    const row = await this.ledger.get<PreviewRow>(
      `SELECT ${PREVIEW_COLUMNS} FROM knowledge_previews WHERE id=? AND account_id=?`,
      [previewId, accountId]
    );
    if (!row) return undefined;
    if (
      (row.status === "pending" || row.status === "complete") &&
      decodeIsoTimestamp(row.expires_at, "expiry") <= this.timestamp()
    ) {
      await this.ledger.run("UPDATE knowledge_previews SET status='expired',updated_at=? WHERE id=? AND account_id=?", [
        this.timestamp(),
        previewId,
        accountId,
      ]);
      const expired = await this.ledger.get<PreviewRow>(
        `SELECT ${PREVIEW_COLUMNS} FROM knowledge_previews WHERE id=? AND account_id=?`,
        [previewId, accountId]
      );
      return expired ? decodePreview(expired) : undefined;
    }
    return decodePreview(row);
  }

  async listPreviews(
    accountIdValue: string,
    connectionIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<KnowledgePreviewRecord>> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(connectionIdValue, "knowledge connection id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId, connectionId];
    const after = page.after ? " AND (p.created_at,p.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<PreviewRow>(
      `SELECT ${PREVIEW_COLUMNS} FROM knowledge_previews p
       WHERE p.account_id=? AND p.connection_id=?${after}
       ORDER BY p.created_at DESC,p.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(rows.map(decodePreview), page, (preview) => ({
      timestamp: preview.created_at,
      id: preview.id,
    }));
  }

  /**
   * Completes one pending scan: the diff entries are persisted with their
   * deterministic selection tokens, counts are derived here as the single
   * authority, and the preview advances to the exact revision that apply
   * must present.
   */
  async completePreview(
    accountIdValue: string,
    previewIdValue: string,
    input: CompletePreviewInput
  ): Promise<{ preview: KnowledgePreviewRecord; entries: readonly KnowledgePreviewEntryRecord[] }> {
    const accountId = requiredId(accountIdValue, "account id");
    const previewId = requiredId(previewIdValue, "knowledge preview id");
    if (!Array.isArray(input.entries) || input.entries.length > MAX_PREVIEW_SCAN_ENTRIES) {
      throw new KnowledgePreviewSelectionError(`a preview may hold at most ${MAX_PREVIEW_SCAN_ENTRIES} entries`);
    }
    const counts: Record<KnowledgePreviewClassification, number> = {
      new: 0,
      changed: 0,
      unchanged: 0,
      duplicate: 0,
      missing: 0,
      unsupported: 0,
    };
    const prepared = input.entries.map((entry) => {
      const relativePath = requiredRelativePath(entry.relative_path, "preview entry relative path");
      const classification = storedEnum(
        entry.classification,
        KNOWLEDGE_PREVIEW_CLASSIFICATIONS,
        "preview entry classification"
      );
      const contentHash =
        entry.content_hash === null || entry.content_hash === undefined
          ? null
          : requiredHash(entry.content_hash, "preview entry content hash");
      if (classification === "unsupported" && contentHash !== null) {
        throw new KnowledgePreviewSelectionError("unsupported entries carry no content hash");
      }
      if (classification !== "unsupported" && classification !== "missing" && contentHash === null) {
        throw new KnowledgePreviewSelectionError(`${classification} entries require a content hash`);
      }
      if (entry.size_bytes !== null && entry.size_bytes !== undefined) {
        const size = entry.size_bytes;
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PREVIEW_SCAN_BYTES) {
          throw new KnowledgePreviewSelectionError("preview entry size_bytes is invalid");
        }
      }
      counts[classification] += 1;
      return {
        relativePath,
        classification,
        contentHash,
        sizeBytes: entry.size_bytes ?? null,
        existingSourceId:
          entry.existing_source_id === null || entry.existing_source_id === undefined
            ? null
            : requiredId(entry.existing_source_id, "preview existing source id"),
        mtimeHint: optionalHint(entry.mtime_hint, "preview mtime hint", 128),
        etagHint: optionalHint(entry.etag_hint, "preview etag hint", 512),
      };
    });
    const paths = new Set(prepared.map((entry) => entry.relativePath));
    if (paths.size !== prepared.length) throw new KnowledgePreviewSelectionError("preview entry paths must be unique");
    const visited = input.visited_entries;
    const directories = input.directories;
    const aggregateBytes = input.aggregate_bytes;
    const skippedCount = input.skipped_count;
    for (const [field, value] of [
      ["visited_entries", visited],
      ["directories", directories],
      ["aggregate_bytes", aggregateBytes],
      ["skipped_count", skippedCount],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} is invalid`);
    }
    const timestamp = this.timestamp();
    const outcome = await this.ledger.withImmediateTransaction(
      (transaction): readonly KnowledgePreviewEntryRecord[] => {
        const row = transaction.get<PreviewRow>(
          `SELECT ${PREVIEW_COLUMNS} FROM knowledge_previews WHERE id=? AND account_id=?`,
          [previewId, accountId]
        );
        if (!row) throw new KnowledgePreviewNotFoundError();
        const preview = decodePreview(row);
        if (preview.status !== "pending") throw new KnowledgePreviewStaleError("only a pending scan can be completed");
        if (preview.expires_at <= timestamp) throw new KnowledgePreviewExpiredError();
        if (
          visited > preview.scan_limit_visited ||
          directories > preview.scan_limit_depth ||
          aggregateBytes > preview.scan_limit_bytes
        ) {
          throw new KnowledgeQuotaError(
            "the scan exceeded the preview bounds recorded on this preview",
            "KNOWLEDGE_SCAN_OVER_LIMIT"
          );
        }
        const supported = counts.new + counts.changed + counts.unchanged + counts.duplicate;
        if (supported > preview.scan_limit_entries) {
          throw new KnowledgeQuotaError(
            `a preview may classify at most ${preview.scan_limit_entries} selectable entries`,
            "KNOWLEDGE_SCAN_OVER_LIMIT"
          );
        }
        const revision = preview.revision + 1;
        // The single-column source FK enforces existence; account tenancy of
        // an entry's existing source is proven here (the FK alone could bind
        // a foreign account's source by id).
        for (const entry of prepared) {
          if (
            entry.existingSourceId &&
            !transaction.get("SELECT 1 FROM sources WHERE id=? AND account_id=?", [entry.existingSourceId, accountId])
          ) {
            throw new KnowledgePreviewSelectionError("a preview entry references a source outside this account");
          }
        }
        const entries: KnowledgePreviewEntryRecord[] = [];
        prepared.forEach((entry, ordinal) => {
          const entryId = randomUUID();
          const token = knowledgeSelectionToken(
            previewId,
            revision,
            entryId,
            entry.classification,
            entry.contentHash,
            entry.existingSourceId
          );
          entries.push(
            Object.freeze({
              preview_id: previewId,
              entry_id: entryId,
              ordinal,
              relative_path: entry.relativePath,
              classification: entry.classification,
              content_hash: entry.contentHash,
              size_bytes: entry.sizeBytes,
              existing_source_id: entry.existingSourceId,
              mtime_hint: entry.mtimeHint,
              etag_hint: entry.etagHint,
              selection_token: token,
            })
          );
          transaction.run(
            `INSERT INTO knowledge_preview_entries
               (preview_id,account_id,entry_id,ordinal,relative_path,classification,content_hash,size_bytes,
                existing_source_id,mtime_hint,etag_hint,selection_token,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              previewId,
              accountId,
              entryId,
              ordinal,
              entry.relativePath,
              entry.classification,
              entry.contentHash,
              entry.sizeBytes,
              entry.existingSourceId,
              entry.mtimeHint,
              entry.etagHint,
              token,
              timestamp,
            ]
          );
        });
        const changed = transaction.run(
          `UPDATE knowledge_previews
             SET status='complete',revision=?,visited_entries=?,directories=?,aggregate_bytes=?,
                 new_count=?,changed_count=?,unchanged_count=?,duplicate_count=?,missing_count=?,
                 unsupported_count=?,skipped_count=?,updated_at=?
           WHERE id=? AND account_id=? AND revision=? AND status='pending'`,
          [
            revision,
            visited,
            directories,
            aggregateBytes,
            counts.new,
            counts.changed,
            counts.unchanged,
            counts.duplicate,
            counts.missing,
            counts.unsupported,
            skippedCount,
            timestamp,
            previewId,
            accountId,
            preview.revision,
          ]
        );
        if (changed.changes !== 1) throw new KnowledgePreviewStaleError();
        return entries;
      }
    );
    const preview = await this.getPreview(accountId, previewId);
    if (!preview) throw new KnowledgePreviewNotFoundError();
    return { preview, entries: outcome };
  }

  async failPreview(
    accountIdValue: string,
    previewIdValue: string,
    errorCode: string
  ): Promise<KnowledgePreviewRecord | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const previewId = requiredId(previewIdValue, "knowledge preview id");
    const code = boundedText(errorCode, "preview error code", 64);
    await this.ledger.withImmediateTransaction((transaction) => {
      const changed = transaction.run(
        "UPDATE knowledge_previews SET status='failed',error_code=?,updated_at=? WHERE id=? AND account_id=? AND status='pending'",
        [code, this.timestamp(), previewId, accountId]
      );
      if (changed.changes !== 1) {
        const row = transaction.get("SELECT 1 FROM knowledge_previews WHERE id=? AND account_id=?", [
          previewId,
          accountId,
        ]);
        if (!row) throw new KnowledgePreviewNotFoundError();
        throw new KnowledgePreviewStaleError("only a pending scan can fail");
      }
    });
    return this.getPreview(accountId, previewId);
  }

  /** The complete entry page for a preview (bounded to the schema's 1,000 rows). */
  async listPreviewEntries(
    accountIdValue: string,
    previewIdValue: string
  ): Promise<readonly KnowledgePreviewEntryRecord[]> {
    const accountId = requiredId(accountIdValue, "account id");
    const preview = await this.getPreview(accountId, previewIdValue);
    if (!preview) throw new KnowledgePreviewNotFoundError();
    const rows = await this.ledger.all<PreviewEntryRow>(
      `SELECT ${PREVIEW_ENTRY_COLUMNS} FROM knowledge_preview_entries WHERE preview_id=? AND account_id=? ORDER BY ordinal`,
      [preview.id, accountId]
    );
    return rows.map(decodePreviewEntry);
  }

  /** Housekeeping: expire every uncommitted preview past its TTL. Returns the count. */
  async sweepExpiredPreviews(accountIdValue?: string): Promise<number> {
    const timestamp = this.timestamp();
    if (accountIdValue === undefined) {
      const changed = await this.ledger.run(
        "UPDATE knowledge_previews SET status='expired',updated_at=? WHERE expires_at<=? AND status IN ('pending','complete')",
        [timestamp, timestamp]
      );
      return changed.changes;
    }
    const changed = await this.ledger.run(
      "UPDATE knowledge_previews SET status='expired',updated_at=? WHERE account_id=? AND expires_at<=? AND status IN ('pending','complete')",
      [timestamp, requiredId(accountIdValue, "account id"), timestamp]
    );
    return changed.changes;
  }

  /**
   * Commits the selected preview entries against the exact preview revision.
   *
   * New entries allocate a stable source (normal unique-name allocation),
   * bind it to a managed item, and join the target library through normal
   * membership rules — only after the preview revision, per-connection item
   * quota, and library capacity are proven. Changed/reactivated entries
   * record the staged candidate for the durable refresh to swap and
   * re-ingest under the same source. Everything lands in one active refresh
   * for the connection. A stale revision, an expired preview, a foreign or
   * unsupported selection, or any over-quota condition activates nothing.
   */
  async applyPreview(
    accountIdValue: string,
    previewIdValue: string,
    input: ApplyPreviewInput
  ): Promise<AppliedPreview> {
    const accountId = requiredId(accountIdValue, "account id");
    const previewId = requiredId(previewIdValue, "knowledge preview id");
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) {
      throw new KnowledgePreviewSelectionError("expected_revision is invalid");
    }
    if (!Array.isArray(input.selections) || input.selections.length < 1) {
      throw new KnowledgePreviewSelectionError("at least one entry must be selected");
    }
    if (input.selections.length > MAX_PREVIEW_SCAN_ENTRIES) {
      throw new KnowledgePreviewSelectionError("the selection is over the preview entry budget");
    }
    const seen = new Set<string>();
    for (const selection of input.selections) {
      const entryId = requiredId(selection.entry_id, "preview entry id");
      if (seen.has(entryId)) throw new KnowledgePreviewSelectionError("selected entry ids must be unique");
      seen.add(entryId);
      if (typeof selection.selection_token !== "string" || !CONTENT_HASH_PATTERN.test(selection.selection_token)) {
        throw new KnowledgePreviewSelectionError("selection tokens are invalid");
      }
      const staged = selection.staged;
      if (!staged || typeof staged !== "object") throw new KnowledgePreviewSelectionError("staged content is required");
      if (typeof staged.file_path !== "string" || staged.file_path.length < 1 || staged.file_path.length > 32_768) {
        throw new KnowledgePreviewSelectionError("staged file_path is invalid");
      }
      requiredHash(staged.content_hash, "staged content hash");
      if (!Number.isSafeInteger(staged.size_bytes) || staged.size_bytes < 0) {
        throw new KnowledgePreviewSelectionError("staged size_bytes is invalid");
      }
      boundedText(staged.mime, "staged mime", 256);
      if (staged.kind !== "document" && staged.kind !== "tabular") {
        throw new KnowledgePreviewSelectionError("staged kind must be document or tabular");
      }
      if (selection.proposed_source_id !== undefined && selection.proposed_source_id !== null) {
        if (typeof selection.proposed_source_id !== "string" || !UUID_PATTERN.test(selection.proposed_source_id)) {
          throw new KnowledgePreviewSelectionError("proposed_source_id must be a canonical UUID");
        }
      }
    }
    const timestamp = this.timestamp();

    return this.ledger.withImmediateTransaction((transaction): AppliedPreview => {
      const previewRow = transaction.get<PreviewRow>(
        `SELECT ${PREVIEW_COLUMNS} FROM knowledge_previews WHERE id=? AND account_id=?`,
        [previewId, accountId]
      );
      if (!previewRow) throw new KnowledgePreviewNotFoundError();
      const preview = decodePreview(previewRow);
      if (preview.status === "expired" || preview.expires_at <= timestamp) {
        transaction.run("UPDATE knowledge_previews SET status='expired',updated_at=? WHERE id=? AND account_id=?", [
          timestamp,
          previewId,
          accountId,
        ]);
        throw new KnowledgePreviewExpiredError();
      }
      if (preview.status !== "complete" || preview.revision !== input.expected_revision) {
        throw new KnowledgePreviewStaleError();
      }

      const connectionRow = transaction.get<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM knowledge_connections WHERE id=? AND account_id=?`,
        [preview.connection_id, accountId]
      );
      if (!connectionRow) throw new KnowledgeConnectionNotFoundError();
      const connection = decodeConnection(connectionRow);

      // Verify every selection against its stored entry before any write.
      const entriesById = new Map<string, KnowledgePreviewEntryRecord>();
      for (const selection of input.selections) {
        const row = transaction.get<PreviewEntryRow>(
          `SELECT ${PREVIEW_ENTRY_COLUMNS} FROM knowledge_preview_entries WHERE preview_id=? AND account_id=? AND entry_id=?`,
          [previewId, accountId, selection.entry_id]
        );
        if (!row) throw new KnowledgePreviewStaleError("a selected entry is not part of this preview");
        const entry = decodePreviewEntry(row);
        const expectedToken = knowledgeSelectionToken(
          previewId,
          preview.revision,
          entry.entry_id,
          entry.classification,
          entry.content_hash,
          entry.existing_source_id
        );
        if (expectedToken !== selection.selection_token)
          throw new KnowledgePreviewStaleError("a selection token no longer matches");
        if (
          entry.classification !== "new" &&
          entry.classification !== "changed" &&
          entry.classification !== "duplicate"
        ) {
          throw new KnowledgePreviewSelectionError(`${entry.classification} entries are not selectable`);
        }
        if (entry.content_hash !== selection.staged.content_hash) {
          throw new KnowledgePreviewStaleError("staged content no longer matches the scanned hash");
        }
        entriesById.set(entry.entry_id, entry);
      }

      // Identity may have moved since the scan: refuse the whole apply if an
      // entry's expected managed item is missing/present in another shape.
      const changedPlans: Array<{
        selection: PreviewSelection;
        entry: KnowledgePreviewEntryRecord;
        item: ItemRow;
        reactivate: boolean;
      }> = [];
      const newPlans: Array<{ selection: PreviewSelection; entry: KnowledgePreviewEntryRecord }> = [];
      for (const selection of input.selections) {
        const entry = entriesById.get(selection.entry_id)!;
        const itemRow = transaction.get<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE account_id=? AND connection_id=? AND relative_path=?`,
          [accountId, preview.connection_id, entry.relative_path]
        );
        if (entry.classification === "new" || entry.classification === "duplicate") {
          if (itemRow && itemRow.lifecycle !== "removed") {
            throw new KnowledgePreviewStaleError("the managed identity for a selected new path already exists");
          }
          if (itemRow) {
            // The explicit remove action retained the identity and its
            // source; re-importing the same path reactivates it rather than
            // allocating a second source.
            changedPlans.push({ selection, entry, item: itemRow, reactivate: true });
            continue;
          }
          newPlans.push({ selection, entry });
          continue;
        }
        // changed
        if (!itemRow) throw new KnowledgePreviewStaleError("the managed item for a selected change disappeared");
        const item = decodeItem(itemRow);
        if (item.source_id !== entry.existing_source_id)
          throw new KnowledgePreviewStaleError("the managed item's source no longer matches");
        changedPlans.push({ selection, entry, item: itemRow, reactivate: item.lifecycle === "removed" });
      }

      const newCount = newPlans.length;
      const managedCount = decodeSafeInteger(
        transaction.get<{ n: number | bigint }>(
          "SELECT COUNT(*) AS n FROM knowledge_items WHERE account_id=? AND connection_id=?",
          [accountId, preview.connection_id]
        )?.n ?? 0,
        "managed item count"
      );
      if (managedCount + newCount > MAX_MANAGED_ITEMS_PER_CONNECTION) {
        throw new KnowledgeQuotaError(
          `a knowledge connection may hold at most ${MAX_MANAGED_ITEMS_PER_CONNECTION} managed entries`
        );
      }
      let libraryId: string | null = null;
      // Membership additions include new sources and reactivated identities
      // (whose explicit remove action had taken them out of the library).
      // The capacity check must count BOTH: a reactivation restores a
      // `library_sources` row below, so ignoring it let a preview commit push
      // the target library past the 100-member limit.
      const reactivationCount = changedPlans.filter((plan) => plan.reactivate).length;
      if (newCount > 0) {
        if (!connection.library_id) throw new KnowledgeLibraryUnavailableError();
      }
      if (newCount + reactivationCount > 0 && connection.library_id) {
        const library = transaction.get("SELECT 1 FROM libraries WHERE id=? AND account_id=?", [
          connection.library_id,
          accountId,
        ]);
        if (!library) {
          if (newCount > 0) throw new KnowledgeLibraryUnavailableError();
        } else {
          const members = decodeSafeInteger(
            transaction.get<{ n: number | bigint }>(
              "SELECT COUNT(*) AS n FROM library_sources WHERE library_id=? AND account_id=?",
              [connection.library_id, accountId]
            )?.n ?? 0,
            "library member count"
          );
          if (members + newCount + reactivationCount > MAX_LIBRARY_MEMBERS) {
            throw new KnowledgeQuotaError(
              `the target library may hold at most ${MAX_LIBRARY_MEMBERS} sources`,
              "KNOWLEDGE_LIBRARY_FULL"
            );
          }
          libraryId = connection.library_id;
        }
      }

      // Apply commits durable state only: it does NOT open a refresh. All
      // re-ingestion reservations belong to refreshAndWaitReady so a caller
      // deadline or restart has exactly one durable work row to resume. For
      // new entries the source is created `index` with its ready_generation
      // null and `ingested_hash` null; for changed/reactivated entries the
      // source swaps to the staged bytes and the intended `content_hash`
      // advances while `ingested_hash` stays at the last indexed content.
      // The next refresh reserves one generation for every such delta.
      const applied: AppliedPreviewItem[] = [];

      for (const plan of newPlans) {
        const itemId = randomUUID();
        // Bind the transport's preallocated id when the bytes were already
        // staged into that source's upload directory; otherwise allocate one.
        const sourceId = plan.selection.proposed_source_id?.toLowerCase() ?? randomUUID();
        const name = allocateKnowledgeSourceName(transaction, accountId, plan.entry.relative_path);
        const displayName = knowledgeDisplayName(plan.entry.relative_path);
        transaction.run(
          `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta)
           VALUES (?,?,?,?,?,?,?,?, 'index', ?)`,
          [
            sourceId,
            accountId,
            name,
            plan.selection.staged.kind,
            displayName,
            plan.selection.staged.file_path,
            plan.selection.staged.mime,
            plan.selection.staged.size_bytes,
            encodeJson({}, "source meta"),
          ]
        );
        transaction.run(
          `INSERT INTO knowledge_items
             (id,account_id,connection_id,relative_path,source_id,content_hash,ingested_hash,size_bytes,mtime_hint,etag_hint,created_at,updated_at)
           VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)`,
          [
            itemId,
            accountId,
            preview.connection_id,
            plan.entry.relative_path,
            sourceId,
            plan.entry.content_hash,
            plan.entry.size_bytes ?? plan.selection.staged.size_bytes,
            plan.entry.mtime_hint,
            plan.entry.etag_hint,
            timestamp,
            timestamp,
          ]
        );
        if (libraryId) {
          transaction.run(
            "INSERT INTO library_sources (library_id,source_id,account_id,added_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
            [libraryId, sourceId, accountId, timestamp]
          );
        }
        applied.push({
          entry_id: plan.entry.entry_id,
          item_id: itemId,
          source_id: sourceId,
          relative_path: plan.entry.relative_path,
          action: "created",
        });
      }

      for (const plan of changedPlans) {
        const item = decodeItem(plan.item);
        const source = transaction.get<{ ready_generation: unknown }>(
          "SELECT ready_generation FROM sources WHERE id=? AND account_id=?",
          [item.source_id, accountId]
        );
        if (!source) throw new KnowledgePreviewStaleError("the managed item's source disappeared");
        // Swap the source onto the staged bytes and advance the intended
        // content identity; `ingested_hash` is left untouched until the
        // promotion that actually indexes these bytes.
        transaction.run("UPDATE sources SET file_path=?,size_bytes=?,mime=? WHERE id=? AND account_id=?", [
          plan.selection.staged.file_path,
          plan.selection.staged.size_bytes,
          plan.selection.staged.mime,
          item.source_id,
          accountId,
        ]);
        transaction.run(
          `UPDATE knowledge_items
             SET content_hash=?,size_bytes=?,mtime_hint=?,etag_hint=?,
                 lifecycle=CASE WHEN lifecycle='missing_upstream' THEN 'active' ELSE lifecycle END,
                 stale=CASE WHEN lifecycle='missing_upstream' THEN 0 ELSE stale END,
                 updated_at=?
           WHERE id=? AND account_id=?`,
          [
            plan.selection.staged.content_hash,
            plan.selection.staged.size_bytes,
            plan.entry.mtime_hint,
            plan.entry.etag_hint,
            timestamp,
            item.id,
            accountId,
          ]
        );
        if (plan.reactivate) {
          // Re-importing a removed identity lifts it back to active and
          // restores membership through normal rules.
          transaction.run(
            "UPDATE knowledge_items SET lifecycle='active',stale=0,updated_at=? WHERE id=? AND account_id=?",
            [timestamp, item.id, accountId]
          );
          if (libraryId) {
            transaction.run(
              "INSERT INTO library_sources (library_id,source_id,account_id,added_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
              [libraryId, item.source_id, accountId, timestamp]
            );
          }
        }
        applied.push({
          entry_id: plan.entry.entry_id,
          item_id: item.id,
          source_id: item.source_id,
          relative_path: item.relative_path,
          action: "updated",
        });
      }

      const marked = transaction.run(
        "UPDATE knowledge_previews SET status='applied',revision=revision+1,applied_at=?,updated_at=? WHERE id=? AND account_id=? AND revision=? AND status='complete'",
        [timestamp, timestamp, previewId, accountId, input.expected_revision]
      );
      if (marked.changes !== 1) throw new KnowledgePreviewStaleError();

      const previewUpdatedRow = transaction.get<PreviewRow>(
        `SELECT ${PREVIEW_COLUMNS} FROM knowledge_previews WHERE id=? AND account_id=?`,
        [previewId, accountId]
      );
      if (!previewUpdatedRow) throw new Error("knowledge preview apply did not persist");
      return Object.freeze({
        preview: decodePreview(previewUpdatedRow),
        items: Object.freeze(applied.map((entry) => Object.freeze(entry))),
      });
    });
  }

  // ---------------------------------------------------------------- refreshes

  /**
   * Commits one durable refresh: the connection revision must match exactly,
   * at most one active refresh may exist per connection, and each snapshotted
   * managed item records its current ready generation for the later CAS.
   */
  async beginRefresh(accountIdValue: string, input: BeginRefreshInput): Promise<BegunRefresh> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(input.connection_id, "knowledge connection id");
    if (!Number.isSafeInteger(input.expected_connection_revision) || input.expected_connection_revision < 1) {
      throw new KnowledgeConnectionConfigError("expected_connection_revision is invalid");
    }
    const requestedBy = input.requested_by ?? "manual";
    const timestamp = this.timestamp();
    const allowlist =
      input.item_ids === undefined
        ? null
        : [...new Set(input.item_ids.map((id) => requiredId(id, "knowledge item id")))];
    if (allowlist && allowlist.length > MAX_MANAGED_ITEMS_PER_CONNECTION) {
      throw new RangeError(`an item allowlist may hold at most ${MAX_MANAGED_ITEMS_PER_CONNECTION} ids`);
    }
    const refreshId = randomUUID();
    return this.ledger.withImmediateTransaction((transaction): BegunRefresh => {
      const connection = transaction.get<{ revision: unknown }>(
        "SELECT revision FROM knowledge_connections WHERE id=? AND account_id=?",
        [connectionId, accountId]
      );
      if (!connection) throw new KnowledgeConnectionNotFoundError();
      if (decodeSafeInteger(connection.revision, "connection revision") !== input.expected_connection_revision) {
        throw new KnowledgeConnectionRevisionConflictError();
      }
      let items: ItemRow[];
      if (allowlist !== null && allowlist.length === 0) {
        items = [];
      } else if (allowlist === null) {
        items = transaction.all<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM knowledge_items
           WHERE account_id=? AND connection_id=? AND lifecycle<>'removed' ORDER BY created_at,id`,
          [accountId, connectionId]
        );
      } else {
        items = transaction.all<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM knowledge_items
           WHERE account_id=? AND id IN (${allowlist.map(() => "?").join(",")}) ORDER BY created_at,id`,
          [accountId, ...allowlist]
        );
        if (items.length !== allowlist.length) throw new KnowledgeItemNotFoundError();
        if (items.some((item) => item.connection_id !== connectionId)) throw new KnowledgeItemNotFoundError();
        if (items.some((item) => item.lifecycle === "removed")) {
          throw new KnowledgePreviewSelectionError("removed items cannot be refreshed; re-import them explicitly");
        }
      }
      try {
        transaction.run(
          `INSERT INTO knowledge_refreshes
             (id,account_id,connection_id,requested_by,expected_connection_revision,status,cancel_requested,created_at,started_at)
           VALUES (?,?,?,?,?,'active',0,?,?)`,
          [refreshId, accountId, connectionId, requestedBy, input.expected_connection_revision, timestamp, timestamp]
        );
      } catch (error) {
        if (error instanceof SqliteConstraintError && error.kind === "unique")
          throw new KnowledgeRefreshConflictError();
        throw error;
      }
      const refreshItems: KnowledgeRefreshItemRecord[] = [];
      for (const item of items.map(decodeItem)) {
        const source = transaction.get<{ ready_generation: unknown }>(
          "SELECT ready_generation FROM sources WHERE id=? AND account_id=?",
          [item.source_id, accountId]
        );
        if (!source) throw new KnowledgeItemNotFoundError();
        transaction.run(
          `INSERT INTO knowledge_refresh_items
             (refresh_id,account_id,item_id,connection_id,source_id,relative_path,status,current_ready_generation,created_at,updated_at)
           VALUES (?,?,?,?,?,?,'pending',?,?,?)`,
          [
            refreshId,
            accountId,
            item.id,
            connectionId,
            item.source_id,
            item.relative_path,
            optionalSafeInteger(source.ready_generation, "source ready_generation"),
            timestamp,
            timestamp,
          ]
        );
        refreshItems.push(
          Object.freeze({
            refresh_id: refreshId,
            connection_id: connectionId,
            item_id: item.id,
            source_id: item.source_id,
            relative_path: item.relative_path,
            status: "pending",
            target_hash: null,
            candidate_path: null,
            candidate_size_bytes: null,
            current_ready_generation: optionalSafeInteger(source.ready_generation, "source ready_generation"),
            expected_generation: null,
            promoted_generation: null,
            attempts: 0,
            error_code: null,
            created_at: timestamp,
            updated_at: timestamp,
          })
        );
      }
      const refreshRow = transaction.get<RefreshRow>(
        `SELECT ${REFRESH_COLUMNS} FROM knowledge_refreshes WHERE id=? AND account_id=?`,
        [refreshId, accountId]
      );
      if (!refreshRow) throw new Error("knowledge refresh insert did not persist");
      return Object.freeze({ refresh: decodeRefresh(refreshRow), items: Object.freeze(refreshItems) });
    });
  }

  /** The single active refresh for a connection, if one is in flight. */
  async getActiveRefresh(
    accountIdValue: string,
    connectionIdValue: string
  ): Promise<KnowledgeRefreshRecord | undefined> {
    const row = await this.ledger.get<RefreshRow>(
      `SELECT ${REFRESH_COLUMNS} FROM knowledge_refreshes
       WHERE account_id=? AND connection_id=? AND status='active'`,
      [requiredId(accountIdValue, "account id"), requiredId(connectionIdValue, "knowledge connection id")]
    );
    return row ? decodeRefresh(row) : undefined;
  }

  async getRefresh(accountIdValue: string, refreshIdValue: string): Promise<KnowledgeRefreshRecord | undefined> {
    const row = await this.ledger.get<RefreshRow>(
      `SELECT ${REFRESH_COLUMNS} FROM knowledge_refreshes WHERE id=? AND account_id=?`,
      [requiredId(refreshIdValue, "knowledge refresh id"), requiredId(accountIdValue, "account id")]
    );
    return row ? decodeRefresh(row) : undefined;
  }

  async requireRefresh(accountId: string, refreshId: string): Promise<KnowledgeRefreshRecord> {
    const refresh = await this.getRefresh(accountId, refreshId);
    if (!refresh) throw new KnowledgeRefreshNotFoundError();
    return refresh;
  }

  async listRefreshes(
    accountIdValue: string,
    connectionIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<KnowledgeRefreshRecord>> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(connectionIdValue, "knowledge connection id");
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [accountId, connectionId];
    const after = page.after ? " AND (r.created_at,r.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<RefreshRow>(
      `SELECT ${REFRESH_COLUMNS} FROM knowledge_refreshes r
       WHERE r.account_id=? AND r.connection_id=?${after}
       ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(rows.map(decodeRefresh), page, (refresh) => ({
      timestamp: refresh.created_at,
      id: refresh.id,
    }));
  }

  async listRefreshItems(
    accountIdValue: string,
    refreshIdValue: string
  ): Promise<readonly KnowledgeRefreshItemRecord[]> {
    const accountId = requiredId(accountIdValue, "account id");
    const refreshId = requiredId(refreshIdValue, "knowledge refresh id");
    if (!(await this.getRefresh(accountId, refreshId))) throw new KnowledgeRefreshNotFoundError();
    const rows = await this.ledger.all<RefreshItemRow>(
      `SELECT ${REFRESH_ITEM_COLUMNS} FROM knowledge_refresh_items
       WHERE refresh_id=? AND account_id=? ORDER BY created_at,item_id`,
      [refreshId, accountId]
    );
    return rows.map(decodeRefreshItem);
  }

  /** The durable restart-recovery scan: incomplete items of interrupted runs. */
  async listInterruptedRefreshes(accountIdValue: string): Promise<readonly KnowledgeRefreshRecord[]> {
    const accountId = requiredId(accountIdValue, "account id");
    const rows = await this.ledger.all<RefreshRow>(
      `SELECT ${REFRESH_COLUMNS} FROM knowledge_refreshes
       WHERE account_id=? AND status='active' ORDER BY created_at,id`,
      [accountId]
    );
    return rows.map(decodeRefresh);
  }

  async getRefreshItem(
    accountIdValue: string,
    refreshIdValue: string,
    itemIdValue: string
  ): Promise<KnowledgeRefreshItemRecord | undefined> {
    const row = await this.ledger.get<RefreshItemRow>(
      `SELECT ${REFRESH_ITEM_COLUMNS} FROM knowledge_refresh_items WHERE refresh_id=? AND item_id=? AND account_id=?`,
      [
        requiredId(refreshIdValue, "knowledge refresh id"),
        requiredId(itemIdValue, "knowledge item id"),
        requiredId(accountIdValue, "account id"),
      ]
    );
    return row ? decodeRefreshItem(row) : undefined;
  }

  async markRefreshItemAttempted(
    accountIdValue: string,
    refreshIdValue: string,
    itemIdValue: string
  ): Promise<boolean> {
    const changed = await this.ledger.run(
      `UPDATE knowledge_refresh_items SET attempts=attempts+1,updated_at=?
       WHERE refresh_id=? AND item_id=? AND account_id=? AND status IN ('pending','staged','committed')
         AND attempts<32`,
      [
        this.timestamp(),
        requiredId(refreshIdValue, "knowledge refresh id"),
        requiredId(itemIdValue, "knowledge item id"),
        requiredId(accountIdValue, "account id"),
      ]
    );
    return changed.changes === 1;
  }

  /**
   * Publishes one staged candidate: the item becomes `staged` and its source
   * adopts the candidate location/size/mime atomically. The durable
   * generation CAS later promotes exactly once.
   */
  async stageRefreshItem(
    accountIdValue: string,
    input: {
      refresh_id: string;
      item_id: string;
      candidate_path: string;
      candidate_size_bytes: number;
      target_hash: string;
      readonly mime?: string | null;
    }
  ): Promise<boolean> {
    const accountId = requiredId(accountIdValue, "account id");
    const refreshId = requiredId(input.refresh_id, "knowledge refresh id");
    const itemId = requiredId(input.item_id, "knowledge item id");
    const targetHash = requiredHash(input.target_hash, "target hash");
    const candidatePath = boundedText(input.candidate_path, "candidate path", 32_768);
    if (!Number.isSafeInteger(input.candidate_size_bytes) || input.candidate_size_bytes < 0) {
      throw new RangeError("candidate_size_bytes is invalid");
    }
    const mime = input.mime === undefined || input.mime === null ? null : boundedText(input.mime, "mime", 256);
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      const item = transaction.get<{ source_id: string }>(
        `SELECT ri.source_id FROM knowledge_refresh_items ri
         JOIN knowledge_refreshes r ON r.id=ri.refresh_id AND r.account_id=ri.account_id
         WHERE ri.refresh_id=? AND ri.item_id=? AND ri.account_id=? AND ri.status='pending' AND r.status='active'`,
        [refreshId, itemId, accountId]
      );
      if (!item) return false;
      transaction.run(`UPDATE sources SET file_path=?,size_bytes=?,mime=COALESCE(?,mime) WHERE id=? AND account_id=?`, [
        candidatePath,
        input.candidate_size_bytes,
        mime,
        item.source_id,
        accountId,
      ]);
      const changed = transaction.run(
        `UPDATE knowledge_refresh_items
           SET status='staged',candidate_path=?,candidate_size_bytes=?,target_hash=?,updated_at=?
         WHERE refresh_id=? AND item_id=? AND account_id=? AND status='pending'`,
        [candidatePath, input.candidate_size_bytes, targetHash, timestamp, refreshId, itemId, accountId]
      );
      return changed.changes === 1;
    });
  }

  /**
   * Transitions `pending`/`staged` work to durable `committed` with the exact
   * reserved generation. Recovery adopts an already-queued generation through
   * the same CAS, so an interrupted attempt never reserves a second one.
   */
  async commitRefreshItem(
    accountIdValue: string,
    refreshIdValue: string,
    itemIdValue: string,
    expectedGeneration: number
  ): Promise<boolean> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new RangeError("expected_generation must be a positive safe integer");
    }
    const changed = await this.ledger.run(
      `UPDATE knowledge_refresh_items
         SET status='committed',expected_generation=?,updated_at=?
       WHERE refresh_id=? AND item_id=? AND account_id=? AND status IN ('pending','staged')`,
      [
        expectedGeneration,
        this.timestamp(),
        requiredId(refreshIdValue, "knowledge refresh id"),
        requiredId(itemIdValue, "knowledge item id"),
        requiredId(accountIdValue, "account id"),
      ]
    );
    return changed.changes === 1;
  }

  /**
   * Promotion CAS. The item may only become `ready` while its committed
   * generation is at most the source's authoritative `ready_generation`; the
   * exact promoted pair is returned. The managed item's content identity is
   * updated only by a promotion that actually happened.
   */
  async readyRefreshItem(
    accountIdValue: string,
    input: {
      refresh_id: string;
      item_id: string;
      content_hash?: string | null;
      size_bytes?: number | null;
      mtime_hint?: string | null;
      etag_hint?: string | null;
    }
  ): Promise<{ source_id: string; item_id: string; generation: number } | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const refreshId = requiredId(input.refresh_id, "knowledge refresh id");
    const itemId = requiredId(input.item_id, "knowledge item id");
    const contentHash =
      input.content_hash === null || input.content_hash === undefined
        ? null
        : requiredHash(input.content_hash, "content hash");
    const mtimeHint = optionalHint(input.mtime_hint, "mtime hint", 128);
    const etagHint = optionalHint(input.etag_hint, "etag hint", 512);
    const sizeBytes = input.size_bytes === null || input.size_bytes === undefined ? null : input.size_bytes;
    if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
      throw new RangeError("size_bytes is invalid");
    }
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction(
      (transaction): { source_id: string; item_id: string; generation: number } | undefined => {
        const item = transaction.get<{
          source_id: string;
          target_hash: string | null;
          expected_generation: number | bigint | null;
        }>(
          `SELECT source_id,target_hash,expected_generation FROM knowledge_refresh_items
           WHERE refresh_id=? AND item_id=? AND account_id=? AND status='committed'`,
          [refreshId, itemId, accountId]
        );
        if (!item || item.expected_generation === null) return undefined;
        const expected = decodeSafeInteger(item.expected_generation, "expected generation");
        const source = transaction.get<{ ready_generation: unknown }>(
          "SELECT ready_generation FROM sources WHERE id=? AND account_id=?",
          [item.source_id, accountId]
        );
        const ready = source ? optionalSafeInteger(source.ready_generation, "ready generation") : null;
        if (ready === null || ready < expected) return undefined;
        const changed = transaction.run(
          `UPDATE knowledge_refresh_items SET status='ready',promoted_generation=?,updated_at=?
           WHERE refresh_id=? AND item_id=? AND account_id=? AND status='committed'`,
          [ready, timestamp, refreshId, itemId, accountId]
        );
        if (changed.changes !== 1) return undefined;
        transaction.run(
          `UPDATE knowledge_items
             SET content_hash=COALESCE(?,content_hash),ingested_hash=COALESCE(?,ingested_hash),
                 size_bytes=COALESCE(?,size_bytes),
                 mtime_hint=COALESCE(?,mtime_hint),etag_hint=COALESCE(?,etag_hint),
                 lifecycle='active',stale=0,last_refreshed_at=?,updated_at=?
           WHERE id=? AND account_id=?`,
          [
            item.target_hash ?? contentHash,
            item.target_hash ?? contentHash,
            sizeBytes,
            mtimeHint,
            etagHint,
            timestamp,
            timestamp,
            itemId,
            accountId,
          ]
        );
        return Object.freeze({ source_id: item.source_id, item_id: itemId, generation: ready });
      }
    );
  }

  /**
   * Resolves an item to a terminal non-promotion outcome. `unchanged` proves
   * the content hash already matched, so no generation was reserved;
   * `missing` marks the managed item `missing_upstream` and stale while
   * retaining its last ready content; failures/blocking never rewrite the
   * managed identity or content.
   */
  async resolveRefreshItem(
    accountIdValue: string,
    refreshIdValue: string,
    itemIdValue: string,
    outcome: RefreshItemOutcomeUpdate
  ): Promise<boolean> {
    const accountId = requiredId(accountIdValue, "account id");
    const refreshId = requiredId(refreshIdValue, "knowledge refresh id");
    const itemId = requiredId(itemIdValue, "knowledge item id");
    const errorCode = outcome.error_code === undefined || outcome.error_code === null ? null : outcome.error_code;
    if (errorCode !== null && (typeof errorCode !== "string" || errorCode.length < 1 || errorCode.length > 64)) {
      throw new RangeError("error_code is invalid");
    }
    const mtimeHint = optionalHint(outcome.mtime_hint, "mtime hint", 128);
    const etagHint = optionalHint(outcome.etag_hint, "etag hint", 512);
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      const changed = transaction.run(
        `UPDATE knowledge_refresh_items SET status=?,error_code=?,updated_at=?
         WHERE refresh_id=? AND item_id=? AND account_id=? AND status IN ('pending','staged','committed')`,
        [outcome.status, errorCode, timestamp, refreshId, itemId, accountId]
      );
      if (changed.changes !== 1) return false;
      if (outcome.status === "unchanged") {
        transaction.run(
          `UPDATE knowledge_items
             SET size_bytes=COALESCE(?,size_bytes),mtime_hint=COALESCE(?,mtime_hint),etag_hint=COALESCE(?,etag_hint),
                 lifecycle='active',stale=0,last_refreshed_at=?,updated_at=?
           WHERE id=? AND account_id=? AND lifecycle<>'removed'`,
          [outcome.size_bytes ?? null, mtimeHint, etagHint, timestamp, timestamp, itemId, accountId]
        );
      } else if (outcome.status === "missing") {
        transaction.run(
          `UPDATE knowledge_items
             SET lifecycle='missing_upstream',stale=1,last_refreshed_at=?,updated_at=?
           WHERE id=? AND account_id=? AND lifecycle<>'removed'`,
          [timestamp, timestamp, itemId, accountId]
        );
      }
      return true;
    });
  }

  async requestRefreshCancellation(accountIdValue: string, refreshIdValue: string): Promise<boolean> {
    const changed = await this.ledger.run(
      "UPDATE knowledge_refreshes SET cancel_requested=1 WHERE id=? AND account_id=? AND status='active'",
      [requiredId(refreshIdValue, "knowledge refresh id"), requiredId(accountIdValue, "account id")]
    );
    return changed.changes === 1;
  }

  /** Finalizes one refresh and trims connection history to the newest 100. */
  async finishRefresh(
    accountIdValue: string,
    refreshIdValue: string,
    status: Exclude<KnowledgeRefreshStatus, "active">,
    errorCode?: string | null
  ): Promise<KnowledgeRefreshRecord | undefined> {
    const accountId = requiredId(accountIdValue, "account id");
    const refreshId = requiredId(refreshIdValue, "knowledge refresh id");
    const code = errorCode === undefined || errorCode === null ? null : errorCode;
    if (code !== null && (typeof code !== "string" || code.length < 1 || code.length > 64)) {
      throw new RangeError("error_code is invalid");
    }
    const timestamp = this.timestamp();
    await this.ledger.withImmediateTransaction((transaction) => {
      const refresh = transaction.get<{ connection_id: string }>(
        "SELECT connection_id FROM knowledge_refreshes WHERE id=? AND account_id=?",
        [refreshId, accountId]
      );
      if (!refresh) throw new KnowledgeRefreshNotFoundError();
      const changed = transaction.run(
        "UPDATE knowledge_refreshes SET status=?,error_code=?,finished_at=? WHERE id=? AND account_id=? AND status='active'",
        [status, code, timestamp, refreshId, accountId]
      );
      if (changed.changes !== 1) throw new KnowledgeRefreshConflictError();
      transaction.run(
        `DELETE FROM knowledge_refreshes
         WHERE account_id=? AND connection_id=? AND status<>'active'
           AND id IN (
             SELECT id FROM knowledge_refreshes
             WHERE account_id=? AND connection_id=? AND status<>'active'
             ORDER BY created_at DESC,id DESC
             LIMIT -1 OFFSET ?
           )`,
        [accountId, refresh.connection_id, accountId, refresh.connection_id, MAX_REFRESH_HISTORY_PER_CONNECTION]
      );
    });
    return this.getRefresh(accountId, refreshId);
  }

  /**
   * Adopts a pending item whose managed source already points at staged
   * durable bytes that were never ingested (a cancelled first import): the
   * item moves to `staged` using the source's current file as candidate and
   * the managed item's recorded hash as target, so the next step only has to
   * reserve one generation.
   */
  async adoptStagedSourceItem(accountIdValue: string, refreshIdValue: string, itemIdValue: string): Promise<boolean> {
    const accountId = requiredId(accountIdValue, "account id");
    const refreshId = requiredId(refreshIdValue, "knowledge refresh id");
    const itemId = requiredId(itemIdValue, "knowledge item id");
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<{
        source_path: unknown;
        source_size: unknown;
        content_hash: unknown;
      }>(
        `SELECT s.file_path AS source_path,s.size_bytes AS source_size,i.content_hash
         FROM knowledge_refresh_items ri
         JOIN knowledge_items i ON i.id=ri.item_id AND i.account_id=ri.account_id
         JOIN sources s ON s.id=ri.source_id AND s.account_id=ri.account_id
         JOIN knowledge_refreshes r ON r.id=ri.refresh_id AND r.account_id=ri.account_id
         WHERE ri.refresh_id=? AND ri.item_id=? AND ri.account_id=? AND ri.status='pending' AND r.status='active'`,
        [refreshId, itemId, accountId]
      );
      if (!row || row.source_path === null || row.source_path === undefined) return false;
      const changed = transaction.run(
        `UPDATE knowledge_refresh_items
           SET status='staged',candidate_path=?,candidate_size_bytes=?,target_hash=?,updated_at=?
         WHERE refresh_id=? AND item_id=? AND account_id=? AND status='pending'`,
        [
          storedText(row.source_path, "source path"),
          decodeSafeInteger(row.source_size, "source size_bytes"),
          storedText(row.content_hash, "item content hash"),
          timestamp,
          refreshId,
          itemId,
          accountId,
        ]
      );
      return changed.changes === 1;
    });
  }

  /** Read-only join against the durable ingestion ledger (never writes there). */
  async sourceIngestionState(accountIdValue: string, sourceIdValue: string): Promise<SourceIngestionState | undefined> {
    const row = await this.ledger.get<{
      source_status: unknown;
      ready_generation: unknown;
      job_status: unknown;
      job_generation: unknown;
      file_path: unknown;
    }>(
      `SELECT s.status AS source_status,s.ready_generation,s.file_path,
              j.status AS job_status,j.generation AS job_generation
       FROM sources s
       LEFT JOIN ingestion_jobs j ON j.source_id=s.id AND j.account_id=s.account_id
       WHERE s.id=? AND s.account_id=?`,
      [requiredId(sourceIdValue, "source id"), requiredId(accountIdValue, "account id")]
    );
    if (!row) return undefined;
    return Object.freeze({
      sourceId: requiredId(sourceIdValue, "source id"),
      sourceStatus: storedEnum(row.source_status, ["ready", "index", "error"] as const, "source status"),
      readyGeneration: optionalSafeInteger(row.ready_generation, "ready generation"),
      filePath:
        row.file_path === null || row.file_path === undefined ? null : storedText(row.file_path, "source file path"),
      jobStatus:
        row.job_status === null || row.job_status === undefined
          ? null
          : storedEnum(
              row.job_status,
              ["preparing", "pending", "running", "done", "error"] as const,
              "ingestion job status"
            ),
      jobGeneration: optionalSafeInteger(row.job_generation, "job generation"),
    });
  }
}

function allocateKnowledgeSourceName(transaction: SqliteTransaction, accountId: string, relativePath: string): string {
  const slug = relativePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `kn_${slug}`.slice(0, MAX_KNOWLEDGE_SOURCE_NAME_CHARS - 4) || "kn_document";
  for (let suffix = 0; suffix < MAX_NAME_ATTEMPTS; suffix += 1) {
    const suffixText = suffix === 0 ? "" : `_${suffix}`;
    const candidate = `${base.slice(0, MAX_KNOWLEDGE_SOURCE_NAME_CHARS - suffixText.length)}${suffixText}`;
    const taken = transaction.get(
      `SELECT name FROM sources WHERE account_id=? AND name=?
       UNION ALL SELECT target_table AS name FROM connectors WHERE account_id=? AND target_table=? LIMIT 1`,
      [accountId, candidate, accountId, candidate]
    );
    if (!taken) return candidate;
  }
  throw new KnowledgeQuotaError("no source name is available for the managed import", "KNOWLEDGE_NAME_EXHAUSTED");
}

function knowledgeDisplayName(relativePath: string): string {
  const basename = relativePath.split("/").at(-1) ?? relativePath;
  return Array.from(basename).slice(0, 180).join("");
}
