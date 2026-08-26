import fs from "node:fs/promises";
import path from "node:path";
import { parentPort } from "node:worker_threads";

import {
  DuckDBArrayValue,
  DuckDBBlobValue,
  DuckDBConnection,
  DuckDBDecimalValue,
  DuckDBInstance,
  DuckDBListValue,
  DuckDBMapValue,
  DuckDBStructValue,
  DuckDBUnionValue,
  DuckDBVariantValue,
  StatementType,
  type DuckDBValue,
} from "@duckdb/node-api";

import { DatasetOperationError, serializeDatasetError } from "./errors.js";
import { convertXlsxToCsv, DataProcessingError } from "./xlsx.js";

const TABLE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const EUROPEAN_DATE_RE = /(^|\D)\d{2}\.\d{2}\.\d{2,4}(?!\d)/;
const MAX_SCOPES_PER_ACCOUNT = 8;
const MAX_ALLOWED_TABLES = 100;
const MAX_QUERY_SQL_CHARS = 100_000;
const DUCKDB_THREADS = 4;
const DUCKDB_MEMORY_LIMIT = "512MB";
const DUCKDB_TEMP_LIMIT = "512MB";
const MAX_QUERY_ROWS = 500;
const MAX_QUERY_COLUMNS = 100;
const MAX_QUERY_CELLS = 50_000;
const MAX_QUERY_CHARS = 1_000_000;
const MAX_QUERY_CELL_CHARS = 10_000;
const MAX_QUERY_HEADER_CHARS = 100_000;
const MAX_QUERY_COLUMN_NAME_CHARS = 500;
const MAX_EXTRACT_ROWS = 2_000;
const MAX_EXTRACT_CELLS = 50_000;
const MAX_EXTRACT_CHARS = 1_000_000;
const MAX_EXTRACT_CELL_CHARS = 10_000;
const MAX_EXTRACT_COLUMNS = 500;
const MAX_EXTRACT_HEADER_CHARS = 100_000;
const MAX_EXTRACT_COLUMN_NAME_CHARS = 500;
const MAX_DESCRIBE_ROWS = 100_000;
const MAX_DESCRIBE_COLUMNS = 100;
const MAX_TOP_VALUE_COLUMNS = 20;
const MAX_DESCRIBE_VALUE_CHARS = 500;
const MAX_DESCRIBE_CHARS = 128_000;
const MAX_DATASET_COLUMNS = 500;
const MAX_DATASET_COLUMN_NAME_CHARS = 500;
const MAX_DATASET_TYPE_CHARS = 500;
const MAX_PREVIEW_ROWS = 5;
const MAX_PREVIEW_CELL_CHARS = 500;
const MAX_PREVIEW_CHARS = 100_000;
const MAX_CATALOG_CHARS = 256_000;
const JS_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

let queryTimeoutMs = 30_000;

type DatasetFormat = "csv" | "json";
type DatasetKind = "path" | "url";
type JsonCell = null | boolean | number | string | JsonCell[] | { [key: string]: JsonCell };

interface DatasetColumn {
  name: string;
  type: string;
}

interface DatasetMeta {
  name: string;
  location: string;
  safe_location: string;
  original_name: string;
  rows: number;
  columns: DatasetColumn[];
  preview: JsonCell[][];
  preview_truncated: boolean;
  size_bytes: number;
  file_signature: string;
  kind?: DatasetKind;
  url?: string | null;
  format?: DatasetFormat | null;
  previous_location?: string | null;
}

interface CatalogConnection {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}

interface ScopedCatalog extends CatalogConnection {
  accountId: string;
  tables: string[];
  signatures: Array<[string, string]>;
  metadata: Map<string, DatasetMeta>;
  ioMutex: Mutex;
  users: number;
  retired: boolean;
  closed: boolean;
}

interface RegistrySnapshotEntry {
  ref: DatasetMeta;
  meta: DatasetMeta;
}

interface RegistrySnapshot {
  accountId: string;
  tables: string[];
  entries: Map<string, RegistrySnapshotEntry>;
}

interface RequestContext {
  id: number;
  cancelled: boolean;
  interrupt?: () => void;
}

interface RequestMessage {
  type: "request";
  id: number;
  operation: string;
  payload: unknown;
}

interface CancelMessage {
  type: "cancel";
  id: number;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const registry = new Map<string, Map<string, DatasetMeta>>();
const accountMutexes = new Map<string, Mutex>();
const pendingPreparations = new Map<string, number>();
const pendingActivations = new Map<string, number>();
const cleanupReservations = new Map<string, number>();
// Map insertion order is the global LRU order. Eviction counts and removes
// scopes only within the account that just added a scope.
const scopes = new Map<string, ScopedCatalog>();
const requestContexts = new Map<number, RequestContext>();

function operationError(status: number, safeDetail: string): DatasetOperationError {
  return new DatasetOperationError(status, safeDetail);
}

function ensureActive(context: RequestContext): void {
  if (context.cancelled) throw operationError(499, "operation cancelled");
}

function accountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

function quoteIdentifier(value: string): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function scopeId(accountId: string, tables: readonly string[]): string {
  return JSON.stringify([accountId, tables]);
}

function locationKey(accountId: string, name: string, safeLocation: string): string {
  return JSON.stringify([accountId, name, safeLocation]);
}

function increment(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function decrement(counter: Map<string, number>, key: string): void {
  const remaining = (counter.get(key) ?? 1) - 1;
  if (remaining > 0) counter.set(key, remaining);
  else counter.delete(key);
}

async function createCatalog(): Promise<CatalogConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(`SET threads=${DUCKDB_THREADS}`);
    await connection.run(`SET memory_limit='${DUCKDB_MEMORY_LIMIT}'`);
    await connection.run(`SET max_temp_directory_size='${DUCKDB_TEMP_LIMIT}'`);
    return { instance, connection };
  } catch (error) {
    connection.closeSync();
    instance.closeSync();
    throw error;
  }
}

function closeCatalog(catalog: CatalogConnection): void {
  try {
    catalog.connection.closeSync();
  } finally {
    catalog.instance.closeSync();
  }
}

async function runInterruptible<T>(
  context: RequestContext,
  connection: DuckDBConnection,
  operation: () => Promise<T>
): Promise<T> {
  const previousInterrupt = context.interrupt;
  context.interrupt = () => connection.interrupt();
  if (context.cancelled) connection.interrupt();
  try {
    const result = await operation();
    ensureActive(context);
    return result;
  } catch (error) {
    if (context.cancelled) throw operationError(499, "operation cancelled");
    throw error;
  } finally {
    context.interrupt = previousInterrupt;
  }
}

async function runWithDeadline<T>(
  context: RequestContext,
  connection: DuckDBConnection,
  operation: () => Promise<T>
): Promise<T> {
  let expired = false;
  const previousInterrupt = context.interrupt;
  context.interrupt = () => connection.interrupt();
  if (context.cancelled) connection.interrupt();
  const timer = setTimeout(() => {
    expired = true;
    try {
      connection.interrupt();
    } catch {
      // The executing promise reports the stable timeout below.
    }
  }, queryTimeoutMs);
  timer.unref();
  try {
    const result = await operation();
    if (expired) throw operationError(504, "query execution timed out");
    ensureActive(context);
    return result;
  } catch (error) {
    if (expired) throw operationError(504, "query execution timed out");
    if (context.cancelled) throw operationError(499, "operation cancelled");
    throw error;
  } finally {
    clearTimeout(timer);
    context.interrupt = previousInterrupt;
  }
}

async function fileSignature(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath, { bigint: true });
    return stat.isFile() ? `${stat.size}:${stat.mtimeNs}` : "missing";
  } catch {
    return "missing";
  }
}

function signatureSize(signature: string): number {
  return Number(signature.slice(0, signature.indexOf(":")));
}

async function safeLocation(location: string): Promise<string> {
  try {
    const resolved = await fs.realpath(path.resolve(location));
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("not a file");
    return resolved;
  } catch {
    throw operationError(404, "dataset file not found");
  }
}

/** Canonicalize an exact existing file or a not-yet-created version path. */
async function canonicalLocation(location: string): Promise<string> {
  const lexical = path.resolve(location);
  let existingAncestor = lexical;
  const missingSuffix: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(existingAncestor), ...missingSuffix);
    } catch {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return lexical;
      missingSuffix.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function readPrefix(filePath: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isEuropeanSemicolonCsv(sample: string): boolean {
  const lines = sample
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => (line.match(/;/g) ?? []).length >= 2);
  if (lines.length < 2) return false;
  const counts = lines.map((line) => (line.match(/;/g) ?? []).length);
  const consistent = [...new Set(counts)].some((count) => counts.filter((value) => value === count).length >= 2);
  return consistent && lines.some((line) => EUROPEAN_DATE_RE.test(line));
}

async function validateExpectedFormat(filePath: string, expectedFormat?: DatasetFormat | null): Promise<void> {
  if (expectedFormat !== "csv" && expectedFormat !== "json") return;
  const prefix = (await readPrefix(filePath, 512))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (!prefix) throw operationError(422, "dataset file is empty");
  const lowered = prefix.toLowerCase();
  if (lowered.startsWith("<!doctype html") || lowered.startsWith("<html")) {
    throw operationError(422, "dataset file contains HTML, not tabular data");
  }
  const looksJson = prefix.startsWith("{") || prefix.startsWith("[");
  if (expectedFormat === "json" && !looksJson) {
    throw operationError(422, "dataset does not match expected JSON format");
  }
  if (expectedFormat === "csv" && looksJson) {
    throw operationError(422, "dataset does not match expected CSV format");
  }
}

async function readTableExpression(filePath: string, expectedFormat?: DatasetFormat | null): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".xls") {
    throw operationError(422, "legacy .xls spreadsheets are not supported; use .xlsx");
  }
  if (extension === ".xlsx") throw operationError(422, "xlsx input must be converted before loading");
  if (expectedFormat === "json") return "read_json_auto($source_path)";
  if (expectedFormat === "csv" || extension === ".csv") {
    const sample = (await readPrefix(filePath, 4096)).toString("utf8");
    if (isEuropeanSemicolonCsv(sample)) {
      return (
        "read_csv_auto($source_path, delim=';', dateformat='%d.%m.%y', decimal_separator=',', " +
        "thousands='.', auto_type_candidates=['BOOLEAN','BIGINT','DECIMAL','DATE','TIMESTAMP','VARCHAR'])"
      );
    }
    return "read_csv_auto($source_path)";
  }
  if (extension === ".parquet") return "read_parquet($source_path)";
  if (extension === ".json" || extension === ".jsonl") return "read_json_auto($source_path)";
  if (extension === ".tsv") return "read_csv_auto($source_path, delim='\\t')";
  return "read_csv_auto($source_path)";
}

async function loadTable(
  connection: DuckDBConnection,
  name: string,
  location: string,
  expectedFormat?: DatasetFormat | null
): Promise<void> {
  let sourcePath = location;
  let converted: Awaited<ReturnType<typeof convertXlsxToCsv>> | undefined;
  try {
    const extension = path.extname(location).toLowerCase();
    if (extension === ".xls") {
      throw operationError(422, "legacy .xls spreadsheets are not supported; use .xlsx");
    }
    if (extension === ".xlsx") {
      converted = await convertXlsxToCsv(location);
      sourcePath = converted.path;
    }
    const reader = await readTableExpression(sourcePath, expectedFormat);
    await connection.run(`CREATE TABLE ${quoteIdentifier(name)} AS SELECT * FROM ${reader}`, {
      source_path: sourcePath,
    });
  } catch (error) {
    if (error instanceof DataProcessingError) throw operationError(error.status, error.message);
    throw error;
  } finally {
    if (converted) await converted.cleanup();
  }
}

function decimalString(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const split = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const trimmed = split.includes(".") ? split.replace(/0+$/, "").replace(/\.$/, "") : split;
  const result = `${negative ? "-" : ""}${trimmed}`;
  return result === "-0" || result === "" ? "0" : result;
}

function normalizeBigInt(value: bigint): number | string {
  return value <= JS_MAX_SAFE_INTEGER && value >= -JS_MAX_SAFE_INTEGER ? Number(value) : value.toString();
}

function normalizeCell(value: DuckDBValue | unknown): JsonCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return normalizeBigInt(value);
  if (value instanceof DuckDBDecimalValue) return decimalString(value.value, value.scale);
  if (value instanceof DuckDBListValue || value instanceof DuckDBArrayValue) {
    return value.items.map((item) => normalizeCell(item));
  }
  if (value instanceof DuckDBStructValue) {
    return Object.fromEntries(Object.entries(value.entries).map(([key, item]) => [key, normalizeCell(item)]));
  }
  if (value instanceof DuckDBMapValue) {
    return value.entries.map(({ key, value: item }) => ({ key: normalizeCell(key), value: normalizeCell(item) }));
  }
  if (value instanceof DuckDBUnionValue || value instanceof DuckDBVariantValue) return normalizeCell(value.value);
  if (value instanceof DuckDBBlobValue) return Buffer.from(value.bytes).toString("hex");
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map((item) => normalizeCell(item));
  if (typeof value === "object") {
    const candidate = value as { toString?: () => string; constructor?: { name?: string } };
    if (candidate.constructor?.name?.startsWith("DuckDB") && typeof candidate.toString === "function") {
      return candidate.toString();
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeCell(item)])
    );
  }
  return String(value);
}

function renderedChars(value: JsonCell): number {
  if (value === null) return 0;
  return typeof value === "string" ? value.length : JSON.stringify(value).length;
}

function boundedValue(value: JsonCell, maxChars: number): [JsonCell, boolean] {
  let bounded = value;
  if (Array.isArray(bounded) || (bounded !== null && typeof bounded === "object")) bounded = JSON.stringify(bounded);
  if (typeof bounded === "string" && bounded.length > maxChars) {
    return [`${bounded.slice(0, Math.max(0, maxChars - 1))}…`, true];
  }
  return [bounded, false];
}

function baseColumnType(columnType: string): string {
  return columnType.toUpperCase().split("(", 1)[0]!.split("[", 1)[0]!.trim();
}

function isNumericColumnType(columnType: string): boolean {
  return new Set([
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "HUGEINT",
    "UTINYINT",
    "USMALLINT",
    "UINTEGER",
    "UBIGINT",
    "UHUGEINT",
    "DECIMAL",
    "FLOAT",
    "DOUBLE",
    "REAL",
  ]).has(baseColumnType(columnType));
}

function isBoundedScalarType(columnType: string): boolean {
  return (
    isNumericColumnType(columnType) ||
    new Set([
      "BOOLEAN",
      "DATE",
      "TIME",
      "TIME WITH TIME ZONE",
      "TIMESTAMP",
      "TIMESTAMP WITH TIME ZONE",
      "TIMESTAMP_NS",
      "TIMESTAMP_MS",
      "TIMESTAMP_S",
      "UUID",
    ]).has(baseColumnType(columnType))
  );
}

function boundedSqlExpression(name: string, columnType: string, maxChars: number): string {
  const quoted = quoteIdentifier(name);
  return isBoundedScalarType(columnType) ? quoted : `left(CAST(${quoted} AS VARCHAR), ${maxChars + 1}) AS ${quoted}`;
}

async function columns(connection: DuckDBConnection, table: string): Promise<DatasetColumn[]> {
  const reader = await connection.runAndReadAll(`DESCRIBE ${quoteIdentifier(table)}`);
  const rows = reader.getRows();
  if (rows.length > MAX_DATASET_COLUMNS) throw operationError(413, "dataset has too many columns");
  return rows.map((row) => {
    const name = String(row[0]);
    const type = String(row[1]);
    if (name.length > MAX_DATASET_COLUMN_NAME_CHARS || type.length > MAX_DATASET_TYPE_CHARS) {
      throw operationError(413, "dataset column metadata exceeds the processing limit");
    }
    return { name, type };
  });
}

async function preview(
  connection: DuckDBConnection,
  table: string,
  tableColumns: readonly DatasetColumn[]
): Promise<[JsonCell[][], boolean]> {
  if (!tableColumns.length) return [[], false];
  const projection = tableColumns
    .map((column) => boundedSqlExpression(column.name, column.type, MAX_PREVIEW_CELL_CHARS))
    .join(", ");
  const reader = await connection.runAndReadAll(
    `SELECT ${projection} FROM ${quoteIdentifier(table)} LIMIT ${MAX_PREVIEW_ROWS}`
  );
  const rows = reader.getRows();
  const cellCount = Math.max(1, rows.length * tableColumns.length);
  const perCellCap = Math.min(MAX_PREVIEW_CELL_CHARS, Math.max(1, Math.floor(MAX_PREVIEW_CHARS / cellCount)));
  const result: JsonCell[][] = [];
  let usedChars = 0;
  let truncated = false;
  for (const row of rows) {
    const output: JsonCell[] = [];
    for (const rawValue of row) {
      let [value, valueTruncated] = boundedValue(normalizeCell(rawValue), perCellCap);
      let valueChars = renderedChars(value);
      const remaining = MAX_PREVIEW_CHARS - usedChars;
      if (valueChars > remaining) {
        [value] = boundedValue(value, Math.max(1, remaining));
        valueChars = renderedChars(value);
        valueTruncated = true;
      }
      output.push(value);
      usedChars += valueChars;
      truncated ||= valueTruncated;
    }
    result.push(output);
  }
  return [result, truncated];
}

async function inspectDataset(
  input: { name: string; location: string; originalName: string; expectedFormat?: DatasetFormat | null },
  context: RequestContext
): Promise<DatasetMeta> {
  if (input.name === "schema_version") throw operationError(400, "reserved table name");
  if (!TABLE_RE.test(input.name)) throw operationError(400, "invalid table name");
  const resolved = await safeLocation(input.location);
  const signatureBefore = await fileSignature(resolved);
  if (signatureBefore === "missing") throw operationError(404, "dataset file not found");
  try {
    await validateExpectedFormat(resolved, input.expectedFormat);
  } catch (error) {
    if (error instanceof DatasetOperationError) throw error;
    throw operationError(409, "dataset changed while it was being parsed");
  }

  const catalog = await createCatalog();
  let rowCount = 0;
  let tableColumns: DatasetColumn[] = [];
  let tablePreview: JsonCell[][] = [];
  let previewTruncated = false;
  try {
    await runInterruptible(context, catalog.connection, async () => {
      await loadTable(catalog.connection, input.name, resolved, input.expectedFormat);
      const countReader = await catalog.connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(input.name)}`);
      rowCount = Number(countReader.getRows()[0]?.[0] ?? 0);
      tableColumns = await columns(catalog.connection, input.name);
      [tablePreview, previewTruncated] = await preview(catalog.connection, input.name, tableColumns);
    });
  } catch (error) {
    if (error instanceof DatasetOperationError) throw error;
    throw operationError(422, "dataset could not be parsed");
  } finally {
    closeCatalog(catalog);
  }
  const signatureAfter = await fileSignature(resolved);
  if (signatureAfter === "missing" || signatureAfter !== signatureBefore) {
    throw operationError(409, "dataset changed while it was being parsed");
  }
  return {
    name: input.name,
    location: input.location,
    safe_location: resolved,
    original_name: input.originalName,
    rows: rowCount,
    columns: tableColumns,
    preview: tablePreview,
    preview_truncated: previewTruncated,
    size_bytes: signatureSize(signatureAfter),
    file_signature: signatureAfter,
  };
}

function sameRegistration(
  meta: DatasetMeta | undefined,
  resolved: string,
  signature: string,
  kind: DatasetKind,
  url?: string | null,
  expectedFormat?: DatasetFormat | null
): boolean {
  return Boolean(
    meta &&
    meta.safe_location === resolved &&
    meta.file_signature === signature &&
    meta.kind === kind &&
    (meta.url ?? null) === (url ?? null) &&
    (meta.format ?? null) === (expectedFormat ?? null)
  );
}

function closeCatalogOnce(scope: ScopedCatalog): void {
  if (scope.closed) return;
  scope.closed = true;
  closeCatalog(scope);
}

function retireScope(scope: ScopedCatalog): ScopedCatalog | undefined {
  scope.retired = true;
  return scope.users === 0 ? scope : undefined;
}

function closeRetired(catalogs: readonly (ScopedCatalog | undefined)[]): void {
  for (const catalog of catalogs) if (catalog) closeCatalogOnce(catalog);
}

/** Remove account scopes from discoverability without closing an active lease. */
function invalidateAccount(accountId: string): ScopedCatalog[] {
  const closable: ScopedCatalog[] = [];
  for (const [key, scope] of [...scopes]) {
    if (scope.accountId !== accountId) continue;
    scopes.delete(key);
    const retired = retireScope(scope);
    if (retired) closable.push(retired);
  }
  return closable;
}

async function registerDataset(
  input: {
    accountId: string;
    name: string;
    location: string;
    kind: DatasetKind;
    originalName: string;
    url?: string | null;
    expectedFormat?: DatasetFormat | null;
  },
  context: RequestContext
): Promise<DatasetMeta> {
  if (input.kind !== "path" && input.kind !== "url") throw operationError(400, "invalid dataset kind");
  if (input.expectedFormat != null && input.expectedFormat !== "csv" && input.expectedFormat !== "json") {
    throw operationError(400, "invalid dataset format");
  }
  const resolved = await safeLocation(input.location);
  const signature = await fileSignature(resolved);
  const mutex = accountMutex(input.accountId);
  let original: DatasetMeta | undefined;
  const existing = await mutex.run(async () => {
    original = registry.get(input.accountId)?.get(input.name);
    if (!sameRegistration(original, resolved, signature, input.kind, input.url, input.expectedFormat)) return undefined;
    original!.original_name = input.originalName;
    return original!;
  });
  if (existing) return existing;

  const prepared = await inspectDataset(input, context);
  const meta: DatasetMeta = {
    ...prepared,
    kind: input.kind,
    url: input.url ?? null,
    format: input.expectedFormat ?? null,
  };
  const committed = await mutex.run(async () => {
    ensureActive(context);
    const cleanupKey = locationKey(input.accountId, input.name, meta.safe_location);
    if (cleanupReservations.has(cleanupKey)) {
      throw operationError(409, "dataset cache version is being deleted");
    }
    let accountRegistry = registry.get(input.accountId);
    if (!accountRegistry) {
      accountRegistry = new Map();
      registry.set(input.accountId, accountRegistry);
    }
    const current = accountRegistry.get(input.name);
    if (current !== original) {
      if (
        sameRegistration(current, meta.safe_location, meta.file_signature, input.kind, input.url, input.expectedFormat)
      ) {
        return { result: current!, retired: [] as ScopedCatalog[] };
      }
      throw operationError(409, "dataset changed during registration");
    }
    accountRegistry.set(input.name, meta);
    const retired = invalidateAccount(input.accountId);
    const result =
      original && original.location !== input.location ? { ...meta, previous_location: original.location } : meta;
    return { result, retired };
  });
  closeRetired(committed.retired);
  return committed.result;
}

function validateAllowedTables(accountId: string, allowedTables: unknown): string[] {
  if (!Array.isArray(allowedTables)) throw operationError(400, "allowed_tables must be a list");
  // Match the former Pydantic request boundary before de-duplicating. Repeated
  // entries still count toward the request-size cap.
  if (allowedTables.length > MAX_ALLOWED_TABLES) {
    throw operationError(422, `allowed_tables supports at most ${MAX_ALLOWED_TABLES} entries`);
  }
  if (allowedTables.some((name) => typeof name !== "string")) {
    throw operationError(400, "allowed_tables must be a list");
  }
  const tables = [...new Set(allowedTables as string[])].sort();
  const accountRegistry = registry.get(accountId);
  if (tables.some((name) => !accountRegistry?.has(name))) {
    throw operationError(400, "one or more allowed tables are unavailable");
  }
  return tables;
}

function cloneMetadata(meta: DatasetMeta): DatasetMeta {
  return structuredClone(meta);
}

async function registrySnapshot(accountId: string, allowedTables: unknown): Promise<RegistrySnapshot> {
  return accountMutex(accountId).run(async () => {
    const tables = validateAllowedTables(accountId, allowedTables);
    const accountRegistry = registry.get(accountId);
    const entries = new Map<string, RegistrySnapshotEntry>();
    for (const name of tables) {
      const ref = accountRegistry!.get(name)!;
      entries.set(name, { ref, meta: cloneMetadata(ref) });
    }
    return { accountId, tables, entries };
  });
}

function snapshotIsCurrent(snapshot: RegistrySnapshot): boolean {
  const accountRegistry = registry.get(snapshot.accountId);
  return snapshot.tables.every((name) => accountRegistry?.get(name) === snapshot.entries.get(name)?.ref);
}

async function scopeSignatures(snapshot: RegistrySnapshot): Promise<Array<[string, string]>> {
  return Promise.all(
    snapshot.tables.map(async (name): Promise<[string, string]> => [
      name,
      await fileSignature(snapshot.entries.get(name)!.meta.safe_location),
    ])
  );
}

function signaturesEqual(left: Array<[string, string]>, right: Array<[string, string]>): boolean {
  return (
    left.length === right.length &&
    left.every(([name, signature], index) => name === right[index]?.[0] && signature === right[index]?.[1])
  );
}

async function buildScope(
  snapshot: RegistrySnapshot,
  signatures: Array<[string, string]>,
  context: RequestContext
): Promise<ScopedCatalog> {
  const catalog = await createCatalog();
  const metadata = new Map<string, DatasetMeta>();
  try {
    await runInterruptible(context, catalog.connection, async () => {
      for (const [name, signature] of signatures) {
        if (signature === "missing") throw operationError(422, `dataset ${name} could not be reloaded`);
        const meta = cloneMetadata(snapshot.entries.get(name)!.meta);
        await loadTable(catalog.connection, name, meta.safe_location, meta.format);
        const countReader = await catalog.connection.runAndReadAll(`SELECT count(*) FROM ${quoteIdentifier(name)}`);
        meta.rows = Number(countReader.getRows()[0]?.[0] ?? 0);
        meta.columns = await columns(catalog.connection, name);
        [meta.preview, meta.preview_truncated] = await preview(catalog.connection, name, meta.columns);
        meta.size_bytes = signatureSize(signature);
        meta.file_signature = signature;
        metadata.set(name, meta);
      }
      if (!signaturesEqual(await scopeSignatures(snapshot), signatures)) {
        throw operationError(422, "dataset scope changed while loading");
      }
      // Uploaded files are loaded while trusted. This setting is deliberately
      // last and irreversible for the lifetime of this catalog.
      await catalog.connection.run("SET enable_external_access=false");
    });
    return {
      ...catalog,
      accountId: snapshot.accountId,
      tables: snapshot.tables,
      signatures,
      metadata,
      ioMutex: new Mutex(),
      users: 0,
      retired: false,
      closed: false,
    };
  } catch (error) {
    closeCatalog(catalog);
    if (error instanceof DatasetOperationError) throw error;
    throw operationError(422, "dataset scope could not be loaded");
  }
}

async function acquireScopedConnection(
  accountId: string,
  allowedTables: unknown,
  context: RequestContext
): Promise<{ key: string; scope: ScopedCatalog }> {
  // A concurrent registration can win while a catalog is loading. Retry from
  // a fresh registry snapshot; no registry/CAS mutex is held during file or
  // DuckDB work.
  for (;;) {
    ensureActive(context);
    const snapshot = await registrySnapshot(accountId, allowedTables);
    const key = scopeId(accountId, snapshot.tables);
    const signatures = await scopeSignatures(snapshot);
    const cachedOutcome = await accountMutex(accountId).run(async () => {
      if (!snapshotIsCurrent(snapshot)) return { retry: true, closable: [] as ScopedCatalog[] };
      const cached = scopes.get(key);
      if (cached && !cached.retired && signaturesEqual(cached.signatures, signatures)) {
        scopes.delete(key);
        scopes.set(key, cached);
        cached.users += 1;
        return { retry: false, lease: cached, closable: [] as ScopedCatalog[] };
      }
      const closable: ScopedCatalog[] = [];
      if (cached) {
        scopes.delete(key);
        const retired = retireScope(cached);
        if (retired) closable.push(retired);
      }
      return { retry: false, closable };
    });
    closeRetired(cachedOutcome.closable);
    if (cachedOutcome.retry) continue;
    if (cachedOutcome.lease) return { key, scope: cachedOutcome.lease };

    const built = await buildScope(snapshot, signatures, context);
    const installed = await accountMutex(accountId).run(async () => {
      if (!snapshotIsCurrent(snapshot)) return { retry: true, closable: [retireScope(built)] };
      const closable: Array<ScopedCatalog | undefined> = [];
      const winner = scopes.get(key);
      if (winner && !winner.retired && signaturesEqual(winner.signatures, signatures)) {
        winner.users += 1;
        scopes.delete(key);
        scopes.set(key, winner);
        closable.push(retireScope(built));
        return { retry: false, lease: winner, closable };
      }
      if (winner) {
        scopes.delete(key);
        closable.push(retireScope(winner));
      }
      for (const name of snapshot.tables) {
        Object.assign(snapshot.entries.get(name)!.ref, built.metadata.get(name)!);
      }
      scopes.set(key, built);
      built.users += 1;
      while (
        [...scopes.values()].filter((candidate) => candidate.accountId === accountId).length > MAX_SCOPES_PER_ACCOUNT
      ) {
        const evicted = [...scopes.entries()].find(([, candidate]) => candidate.accountId === accountId);
        if (!evicted) break;
        scopes.delete(evicted[0]);
        closable.push(retireScope(evicted[1]));
      }
      return { retry: false, lease: built, closable };
    });
    closeRetired(installed.closable);
    if (installed.retry) continue;
    return { key, scope: installed.lease! };
  }
}

function retireScopedConnection(key: string, scope: ScopedCatalog): void {
  if (scopes.get(key) === scope) scopes.delete(key);
  retireScope(scope);
}

function releaseScopedConnection(scope: ScopedCatalog): void {
  scope.users = Math.max(0, scope.users - 1);
  if (scope.retired && scope.users === 0) closeCatalogOnce(scope);
}

function leadingSqlKeyword(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    if (/\s/.test(sql[index]!)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      continue;
    }
    return /^[A-Za-z]+/.exec(sql.slice(index))?.[0]?.toUpperCase() ?? "";
  }
  return "";
}

function withoutStatementTerminator(sql: string): string {
  const normalSemicolons: number[] = [];
  let index = 0;
  let quote: "'" | '"' | undefined;
  let dollarQuote: string | undefined;
  let blockDepth = 0;
  let lineComment = false;
  while (index < sql.length) {
    if (lineComment) {
      if (sql[index] === "\n") lineComment = false;
      index += 1;
      continue;
    }
    if (blockDepth > 0) {
      if (sql.startsWith("/*", index)) {
        blockDepth += 1;
        index += 2;
      } else if (sql.startsWith("*/", index)) {
        blockDepth -= 1;
        index += 2;
      } else index += 1;
      continue;
    }
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length;
        dollarQuote = undefined;
      } else index += 1;
      continue;
    }
    if (quote) {
      if (sql[index] === quote) {
        if (sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      lineComment = true;
      index += 2;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      blockDepth = 1;
      index += 2;
      continue;
    }
    if (sql[index] === "'" || sql[index] === '"') {
      quote = sql[index] as "'" | '"';
      index += 1;
      continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
    if (dollar) {
      dollarQuote = dollar[0];
      index += dollarQuote.length;
      continue;
    }
    if (sql[index] === ";") normalSemicolons.push(index);
    index += 1;
  }
  const terminator = normalSemicolons.at(-1);
  return terminator === undefined ? sql : `${sql.slice(0, terminator)}${sql.slice(terminator + 1)}`;
}

async function assertReadOnlySql(connection: DuckDBConnection, sql: string): Promise<void> {
  let extracted;
  try {
    extracted = await connection.extractStatements(sql);
  } catch {
    throw operationError(400, "invalid SQL");
  }
  if (extracted.count !== 1) throw operationError(400, "exactly one read-only query is allowed");
  // Parsing succeeded; a binder/catalog error is a query failure, not a
  // reason to weaken or bypass the statement-type check.
  const prepared = await extracted.prepare(0);
  try {
    if (prepared.statementType !== StatementType.SELECT) {
      throw operationError(400, "exactly one read-only query is allowed");
    }
  } finally {
    prepared.destroySync();
  }
}

async function queryDataset(
  input: { accountId: string; sql: string; allowedTables: unknown },
  context: RequestContext
): Promise<Record<string, unknown>> {
  if (typeof input.sql !== "string" || input.sql.length > MAX_QUERY_SQL_CHARS) {
    throw operationError(422, `SQL supports at most ${MAX_QUERY_SQL_CHARS} characters`);
  }
  const sql = input.sql.trim();
  if (!sql) throw operationError(400, "empty SQL");
  if (!["SELECT", "WITH", "VALUES"].includes(leadingSqlKeyword(sql))) {
    throw operationError(400, "exactly one read-only query is allowed");
  }
  let scoped: Awaited<ReturnType<typeof acquireScopedConnection>> | undefined;
  try {
    scoped = await acquireScopedConnection(input.accountId, input.allowedTables, context);
    const lease = scoped;
    return await lease.scope.ioMutex.run(async () => {
      ensureActive(context);
      await assertReadOnlySql(lease.scope.connection, sql);
      const executableSql = withoutStatementTerminator(sql);
      const { schema, selected, rows } = await runWithDeadline(context, lease.scope.connection, async () => {
        const schemaReader = await lease.scope.connection.runAndReadAll(
          `DESCRIBE SELECT * FROM (${executableSql}\n) AS _q`
        );
        const schemaRows = schemaReader.getRows();
        const selectedRows = schemaRows.slice(0, MAX_QUERY_COLUMNS);
        if (!selectedRows.length) return { schema: schemaRows, selected: selectedRows, rows: [] as DuckDBValue[][] };
        const rowLimit = Math.min(MAX_QUERY_ROWS, Math.floor(MAX_QUERY_CELLS / selectedRows.length));
        const projection = selectedRows
          .map((column) => boundedSqlExpression(String(column[0]), String(column[1]), MAX_QUERY_CELL_CHARS))
          .join(", ");
        const rowReader = await lease.scope.connection.runAndReadUntil(
          `SELECT ${projection} FROM (${executableSql}\n) AS _q LIMIT ${rowLimit + 1}`,
          rowLimit + 1
        );
        return { schema: schemaRows, selected: selectedRows, rows: rowReader.getRows().slice(0, rowLimit + 1) };
      });

      const outputColumns: string[] = [];
      let headerChars = 0;
      let headersTruncated = false;
      for (const column of selected) {
        const remaining = MAX_QUERY_HEADER_CHARS - headerChars;
        if (remaining <= 0) {
          headersTruncated = true;
          break;
        }
        const [name, nameTruncated] = boundedValue(String(column[0]), Math.min(MAX_QUERY_COLUMN_NAME_CHARS, remaining));
        outputColumns.push(String(name));
        headerChars += String(name).length;
        headersTruncated ||= nameTruncated;
      }
      const columnCount = outputColumns.length;
      const rowLimit = columnCount ? Math.min(MAX_QUERY_ROWS, Math.floor(MAX_QUERY_CELLS / columnCount)) : 0;
      let truncated = headersTruncated || schema.length > columnCount || rows.length > rowLimit;
      const outputRows: JsonCell[][] = [];
      let usedChars = headerChars;
      for (const row of rows.slice(0, rowLimit)) {
        const remaining = MAX_QUERY_CHARS - usedChars;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const perCellCap = Math.min(MAX_QUERY_CELL_CHARS, Math.max(1, Math.floor(remaining / columnCount)));
        const output: JsonCell[] = [];
        let rowChars = 0;
        for (const rawValue of row.slice(0, columnCount)) {
          const [value, valueTruncated] = boundedValue(normalizeCell(rawValue), perCellCap);
          rowChars += renderedChars(value);
          output.push(value);
          truncated ||= valueTruncated;
        }
        if (usedChars + rowChars > MAX_QUERY_CHARS) {
          truncated = true;
          break;
        }
        outputRows.push(output);
        usedChars += rowChars;
      }
      return {
        columns: outputColumns,
        rows: outputRows,
        row_count: outputRows.length,
        returned_row_count: outputRows.length,
        columns_truncated: schema.length > outputColumns.length || headersTruncated,
        truncated,
      };
    });
  } catch (error) {
    if (error instanceof DatasetOperationError) {
      if ((error.status === 504 || error.status === 499) && scoped) {
        retireScopedConnection(scoped.key, scoped.scope);
      }
      throw error;
    }
    throw operationError(422, "query could not be completed");
  } finally {
    if (scoped) releaseScopedConnection(scoped.scope);
  }
}

function summaryNumericCell(value: unknown, columnType: string): JsonCell {
  if (value === null || value === undefined) return null;
  const text = value instanceof DuckDBDecimalValue ? decimalString(value.value, value.scale) : String(value);
  if (columnType.toUpperCase().includes("DECIMAL")) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const negative = text.startsWith("-");
    const unsigned = text.replace(/^[+-]/, "");
    const [whole = "0", fraction = ""] = unsigned.split(".");
    const normalizedFraction = fraction.replace(/0+$/, "");
    const normalized = `${negative ? "-" : ""}${whole.replace(/^0+(?=\d)/, "") || "0"}${normalizedFraction ? `.${normalizedFraction}` : ""}`;
    return normalized === "-0" ? "0" : normalized;
  }
  if (columnType.toUpperCase().includes("INT")) {
    if (/^[+-]?\d+(?:\.0+)?$/.test(text)) {
      const integer = BigInt(text.replace(/\.0+$/, ""));
      return normalizeBigInt(integer);
    }
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

const TEMPORAL_TYPES = new Set([
  "DATE",
  "TIME",
  "TIME WITH TIME ZONE",
  "TIMESTAMP",
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMP_NS",
  "TIMESTAMP_MS",
  "TIMESTAMP_S",
]);

async function describeDataset(
  input: { accountId: string; table: string; allowedTables: unknown },
  context: RequestContext
): Promise<Record<string, unknown>> {
  let scoped: Awaited<ReturnType<typeof acquireScopedConnection>> | undefined;
  try {
    scoped = await acquireScopedConnection(input.accountId, input.allowedTables, context);
    const lease = scoped;
    if (!lease.scope.tables.includes(input.table)) {
      throw operationError(400, `dataset ${input.table} is not allowed in this scope`);
    }
    const meta = lease.scope.metadata.get(input.table)!;
    return await lease.scope.ioMutex.run(async () => {
      ensureActive(context);
      return await runWithDeadline(context, lease.scope.connection, async () => {
        const selectedColumns = meta.columns.slice(0, MAX_DESCRIBE_COLUMNS);
        const projection = selectedColumns
          .map((column) => boundedSqlExpression(column.name, column.type, MAX_DESCRIBE_VALUE_CHARS))
          .join(", ");
        const sampledSql = projection
          ? `SELECT ${projection} FROM ${quoteIdentifier(input.table)} LIMIT ${MAX_DESCRIBE_ROWS}`
          : `SELECT * FROM ${quoteIdentifier(input.table)} LIMIT ${MAX_DESCRIBE_ROWS}`;
        const summaryReader = await lease.scope.connection.runAndReadAll(
          `SUMMARIZE SELECT * FROM (${sampledSql}) AS _sample`
        );
        const summaryNames = summaryReader.columnNames();
        const summaryRows = summaryReader.getRows();
        const summaries = summaryRows.map((row) =>
          Object.fromEntries(summaryNames.map((name, index) => [name, row[index]]))
        );
        let remainingChars = MAX_DESCRIBE_CHARS - input.table.length;
        let responseTruncated = meta.columns.length > MAX_DESCRIBE_COLUMNS;
        const boundedText = (raw: unknown, maxChars = MAX_DESCRIBE_VALUE_CHARS): JsonCell => {
          if (raw === null || raw === undefined) return null;
          if (remainingChars <= 0) {
            responseTruncated = true;
            return null;
          }
          const [value, wasTruncated] = boundedValue(String(normalizeCell(raw)), Math.min(maxChars, remainingChars));
          remainingChars -= String(value).length;
          responseTruncated ||= wasTruncated;
          return value;
        };
        const outputColumns: Array<Record<string, unknown>> = [];
        for (let index = 0; index < selectedColumns.length; index += 1) {
          const column = selectedColumns[index]!;
          const summary = summaries[index] ?? {};
          remainingChars -= column.name.length + column.type.length;
          if (remainingChars < 0) responseTruncated = true;
          const entry: Record<string, unknown> = { name: column.name, type: column.type };
          if (isNumericColumnType(column.type)) {
            entry.min = summaryNumericCell(summary.min, column.type);
            entry.max = summaryNumericCell(summary.max, column.type);
            entry.avg = summaryNumericCell(summary.avg, column.type);
            entry.distinct = Number(normalizeCell(summary.approx_unique) ?? 0);
          } else if (TEMPORAL_TYPES.has(baseColumnType(column.type))) {
            entry.min = boundedText(summary.min);
            entry.max = boundedText(summary.max);
            entry.distinct = Number(normalizeCell(summary.approx_unique) ?? 0);
          } else {
            entry.distinct = Number(normalizeCell(summary.approx_unique) ?? 0);
            if (index < MAX_TOP_VALUE_COLUMNS && remainingChars > 0) {
              const topReader = await lease.scope.connection.runAndReadAll(
                `SELECT ${quoteIdentifier(column.name)}, count(*) AS n FROM (${sampledSql}) AS _sample ` +
                  "GROUP BY 1 ORDER BY n DESC LIMIT 6"
              );
              const topValues: Array<{ value: JsonCell; count: number }> = [];
              for (const [rawValue, count] of topReader.getRows()) {
                const value = boundedText(rawValue);
                if (value === null && rawValue !== null) break;
                topValues.push({ value, count: Number(normalizeCell(count) ?? 0) });
              }
              entry.top_values = topValues;
            } else if (index < MAX_TOP_VALUE_COLUMNS) responseTruncated = true;
          }
          outputColumns.push(entry);
        }
        return {
          table: input.table,
          rows: meta.rows,
          profiled_rows: Math.min(meta.rows, MAX_DESCRIBE_ROWS),
          columns_truncated: meta.columns.length > MAX_DESCRIBE_COLUMNS,
          columns: outputColumns,
          truncated: responseTruncated,
        };
      });
    });
  } catch (error) {
    if (error instanceof DatasetOperationError) {
      if ((error.status === 504 || error.status === 499) && scoped) {
        retireScopedConnection(scoped.key, scoped.scope);
      }
      throw error;
    }
    throw operationError(422, "dataset could not be described");
  } finally {
    if (scoped) releaseScopedConnection(scoped.scope);
  }
}

async function extractLoaded(
  connection: DuckDBConnection,
  table: string,
  meta: DatasetMeta,
  maxRows: number,
  context: RequestContext
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_EXTRACT_ROWS) {
    throw operationError(400, `max_rows must be between 1 and ${MAX_EXTRACT_ROWS}`);
  }
  const allColumns = meta.columns.map((column) => column.name);
  const outputColumns: string[] = [];
  let headerChars = 0;
  let headersTruncated = false;
  for (const rawName of allColumns.slice(0, MAX_EXTRACT_COLUMNS)) {
    const remaining = MAX_EXTRACT_HEADER_CHARS - headerChars;
    if (remaining <= 0) {
      headersTruncated = true;
      break;
    }
    const [name, nameTruncated] = boundedValue(rawName, Math.min(MAX_EXTRACT_COLUMN_NAME_CHARS, remaining));
    outputColumns.push(String(name));
    headerChars += String(name).length;
    headersTruncated ||= nameTruncated;
  }
  const columnsTruncated = headersTruncated || outputColumns.length < allColumns.length;
  if (!outputColumns.length) throw operationError(422, "dataset has no extractable columns");
  const rowLimit = Math.min(maxRows, Math.floor(MAX_EXTRACT_CELLS / outputColumns.length));
  const projection = meta.columns
    .slice(0, outputColumns.length)
    .map((column) => boundedSqlExpression(column.name, column.type, MAX_EXTRACT_CELL_CHARS))
    .join(", ");
  const rows = await runWithDeadline(context, connection, async () => {
    const reader = await connection.runAndReadUntil(
      `SELECT ${projection} FROM ${quoteIdentifier(table)} LIMIT ${rowLimit + 1}`,
      rowLimit + 1
    );
    return reader.getRows().slice(0, rowLimit + 1);
  });
  const totalRows = meta.rows;
  let truncated = columnsTruncated || rows.length > rowLimit || rowLimit < Math.min(maxRows, totalRows);
  const outputRows: JsonCell[][] = [];
  let usedChars = headerChars;
  for (const row of rows.slice(0, rowLimit)) {
    const normalized = row.map((value) => normalizeCell(value));
    const perCellCap = Math.min(
      MAX_EXTRACT_CELL_CHARS,
      Math.max(32, Math.floor((MAX_EXTRACT_CHARS - usedChars) / outputColumns.length))
    );
    const output: JsonCell[] = [];
    let rowChars = 0;
    for (const rawValue of normalized) {
      const [value, valueTruncated] = boundedValue(rawValue, perCellCap);
      truncated ||= valueTruncated;
      rowChars += renderedChars(value);
      output.push(value);
    }
    if (usedChars + rowChars > MAX_EXTRACT_CHARS) {
      truncated = true;
      break;
    }
    outputRows.push(output);
    usedChars += rowChars;
    if (usedChars >= MAX_EXTRACT_CHARS) {
      truncated = true;
      break;
    }
  }
  return {
    columns: outputColumns,
    rows: outputRows,
    row_count: totalRows,
    total_row_count: totalRows,
    returned_row_count: outputRows.length,
    columns_truncated: columnsTruncated,
    truncated,
  };
}

async function extractDataset(
  input: { accountId: string; table: string; allowedTables: unknown; maxRows: number },
  context: RequestContext
): Promise<Record<string, unknown>> {
  let scoped: Awaited<ReturnType<typeof acquireScopedConnection>> | undefined;
  try {
    scoped = await acquireScopedConnection(input.accountId, input.allowedTables, context);
    if (!scoped.scope.tables.includes(input.table)) {
      throw operationError(400, "dataset is not allowed in this scope");
    }
    return await scoped.scope.ioMutex.run(async () => {
      ensureActive(context);
      return extractLoaded(
        scoped!.scope.connection,
        input.table,
        scoped!.scope.metadata.get(input.table)!,
        input.maxRows,
        context
      );
    });
  } catch (error) {
    if (error instanceof DatasetOperationError && (error.status === 504 || error.status === 499) && scoped) {
      retireScopedConnection(scoped.key, scoped.scope);
    }
    throw error;
  } finally {
    if (scoped) releaseScopedConnection(scoped.scope);
  }
}

async function extractCandidate(
  input: { name: string; location: string; expectedFormat: DatasetFormat; maxRows: number },
  context: RequestContext
): Promise<Record<string, unknown>> {
  const meta = await inspectDataset(
    {
      name: input.name,
      location: input.location,
      originalName: path.basename(input.location),
      expectedFormat: input.expectedFormat,
    },
    context
  );
  const catalog = await createCatalog();
  try {
    await runInterruptible(context, catalog.connection, () =>
      loadTable(catalog.connection, input.name, meta.safe_location, input.expectedFormat)
    );
    return await extractLoaded(catalog.connection, input.name, meta, input.maxRows, context);
  } catch (error) {
    if (error instanceof DatasetOperationError) throw error;
    throw operationError(422, "dataset candidate could not be extracted");
  } finally {
    closeCatalog(catalog);
  }
}

async function activatePrepared(
  input: {
    accountId: string;
    name: string;
    location: string;
    originalName: string;
    url: string;
    expectedFormat: DatasetFormat;
    expectedPreviousLocation: string | null;
  },
  context: RequestContext
): Promise<DatasetMeta> {
  const resolved = await safeLocation(input.location);
  const signature = await fileSignature(resolved);
  const expectedSafe = input.expectedPreviousLocation ? await canonicalLocation(input.expectedPreviousLocation) : null;
  const mutex = accountMutex(input.accountId);
  let original: DatasetMeta | undefined;
  let pendingKey = "";
  const idempotent = await mutex.run(async () => {
    original = registry.get(input.accountId)?.get(input.name);
    if (sameRegistration(original, resolved, signature, "url", input.url, input.expectedFormat)) {
      return { ...original!, previous_location: input.expectedPreviousLocation };
    }
    const currentSafe = original?.safe_location ?? null;
    if (currentSafe !== expectedSafe) throw operationError(409, "dataset changed before connector activation");
    pendingKey = locationKey(input.accountId, input.name, resolved);
    if (cleanupReservations.has(pendingKey)) {
      throw operationError(409, "dataset cache version is being deleted");
    }
    increment(pendingActivations, pendingKey);
    return undefined;
  });
  if (idempotent) return idempotent;

  try {
    const prepared = await inspectDataset(input, context);
    const meta: DatasetMeta = {
      ...prepared,
      kind: "url",
      url: input.url,
      format: input.expectedFormat,
    };
    const committed = await mutex.run(async () => {
      ensureActive(context);
      const current = registry.get(input.accountId)?.get(input.name);
      if (current !== original) {
        if (sameRegistration(current, resolved, meta.file_signature, "url", input.url, input.expectedFormat)) {
          return {
            result: { ...current!, previous_location: input.expectedPreviousLocation },
            retired: [] as ScopedCatalog[],
          };
        }
        throw operationError(409, "dataset changed during connector activation");
      }
      let accountRegistry = registry.get(input.accountId);
      if (!accountRegistry) {
        accountRegistry = new Map();
        registry.set(input.accountId, accountRegistry);
      }
      accountRegistry.set(input.name, meta);
      return {
        result: { ...meta, previous_location: input.expectedPreviousLocation },
        retired: invalidateAccount(input.accountId),
      };
    });
    closeRetired(committed.retired);
    return committed.result;
  } finally {
    await mutex.run(async () => decrement(pendingActivations, pendingKey));
  }
}

async function beginPreparation(input: { accountId: string; name: string; location: string }): Promise<void> {
  const resolved = await canonicalLocation(input.location);
  await accountMutex(input.accountId).run(async () => {
    const key = locationKey(input.accountId, input.name, resolved);
    if (cleanupReservations.has(key)) throw operationError(409, "dataset cache version is being deleted");
    increment(pendingPreparations, key);
  });
}

async function endPreparation(input: { accountId: string; name: string; location: string }): Promise<void> {
  const resolved = await canonicalLocation(input.location);
  await accountMutex(input.accountId).run(async () => {
    decrement(pendingPreparations, locationKey(input.accountId, input.name, resolved));
  });
}

async function beginInactiveCleanup(input: { accountId: string; name: string; location: string }): Promise<void> {
  const resolved = await canonicalLocation(input.location);
  await accountMutex(input.accountId).run(async () => {
    const key = locationKey(input.accountId, input.name, resolved);
    const meta = registry.get(input.accountId)?.get(input.name);
    if (meta?.safe_location === resolved) throw operationError(409, "active dataset cache versions cannot be deleted");
    if (pendingActivations.has(key)) {
      throw operationError(409, "activating dataset cache versions cannot be deleted");
    }
    if (pendingPreparations.has(key)) {
      throw operationError(409, "preparing dataset cache versions cannot be deleted");
    }
    if (cleanupReservations.has(key)) throw operationError(409, "dataset cache version is already being deleted");
    increment(cleanupReservations, key);
  });
}

async function endInactiveCleanup(input: { accountId: string; name: string; location: string }): Promise<void> {
  const resolved = await canonicalLocation(input.location);
  await accountMutex(input.accountId).run(async () => {
    decrement(cleanupReservations, locationKey(input.accountId, input.name, resolved));
  });
}

async function listDatasets(input: { accountId: string; summary: boolean }): Promise<Array<Record<string, unknown>>> {
  const snapshot = await accountMutex(input.accountId).run(async () => [
    ...(registry.get(input.accountId)?.values() ?? []),
  ]);
  return Promise.all(
    snapshot.map(async (item) => {
      const exists = (await fileSignature(item.location)) !== "missing";
      if (input.summary) {
        return { table: item.name, original_name: item.original_name, rows: item.rows, exists };
      }
      return {
        table: item.name,
        original_name: item.original_name,
        rows: item.rows,
        location: item.location,
        kind: item.kind,
        format: item.format ?? null,
        exists,
      };
    })
  );
}

async function catalogDatasets(input: { accountId: string; allowedTables: unknown }): Promise<Record<string, unknown>> {
  return accountMutex(input.accountId).run(async () => {
    const tables = validateAllowedTables(input.accountId, input.allowedTables);
    const accountRegistry = registry.get(input.accountId)!;
    const items: Array<Record<string, unknown>> = [];
    let usedChars = 0;
    let omitted = 0;
    for (const name of tables) {
      const meta = accountRegistry.get(name)!;
      const item = { table: name, original_name: meta.original_name, rows: meta.rows, columns: meta.columns };
      const itemChars = JSON.stringify(item).length;
      if (usedChars + itemChars > MAX_CATALOG_CHARS) {
        omitted += 1;
        continue;
      }
      items.push(item);
      usedChars += itemChars;
    }
    return {
      datasets: items,
      total: tables.length,
      returned: items.length,
      omitted,
      truncated: omitted > 0,
    };
  });
}

async function dropDataset(input: { accountId: string; name: string }): Promise<void> {
  const retired = await accountMutex(input.accountId).run(async () => {
    const accountRegistry = registry.get(input.accountId);
    if (!accountRegistry?.has(input.name)) throw operationError(404, `dataset ${input.name} not found`);
    const invalidated = invalidateAccount(input.accountId);
    accountRegistry.delete(input.name);
    if (!accountRegistry.size) registry.delete(input.accountId);
    return invalidated;
  });
  closeRetired(retired);
}

async function deactivateIfLocation(input: { accountId: string; name: string; location: string }): Promise<boolean> {
  const resolved = await canonicalLocation(input.location);
  const result = await accountMutex(input.accountId).run(async () => {
    const accountRegistry = registry.get(input.accountId);
    const meta = accountRegistry?.get(input.name);
    if (!meta || meta.safe_location !== resolved) return { dropped: false, retired: [] as ScopedCatalog[] };
    const retired = invalidateAccount(input.accountId);
    accountRegistry!.delete(input.name);
    if (!accountRegistry!.size) registry.delete(input.accountId);
    return { dropped: true, retired };
  });
  closeRetired(result.retired);
  return result.dropped;
}

async function currentLocation(input: { accountId: string; name: string }): Promise<string | null> {
  return accountMutex(input.accountId).run(
    async () => registry.get(input.accountId)?.get(input.name)?.location ?? null
  );
}

async function health(context: RequestContext): Promise<boolean> {
  const catalog = await createCatalog();
  try {
    await runInterruptible(context, catalog.connection, async () => {
      await catalog.connection.run("SET enable_external_access=false");
      const reader = await catalog.connection.runAndReadAll("SELECT 1 AS healthy");
      if (reader.getRows()[0]?.[0] !== 1) throw new Error("unexpected smoke-test result");
    });
    return true;
  } finally {
    closeCatalog(catalog);
  }
}

async function shutdown(): Promise<void> {
  for (const scope of scopes.values()) closeCatalog(scope);
  scopes.clear();
  registry.clear();
  pendingPreparations.clear();
  pendingActivations.clear();
  cleanupReservations.clear();
}

function objectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw operationError(400, "invalid request");
  return payload as Record<string, unknown>;
}

async function dispatch(operation: string, rawPayload: unknown, context: RequestContext): Promise<unknown> {
  const payload = objectPayload(rawPayload);
  switch (operation) {
    case "health":
      return health(context);
    case "register":
      return registerDataset(payload as Parameters<typeof registerDataset>[0], context);
    case "inspect":
      return inspectDataset(payload as Parameters<typeof inspectDataset>[0], context);
    case "currentLocation":
      return currentLocation(payload as Parameters<typeof currentLocation>[0]);
    case "beginPreparation":
      return beginPreparation(payload as Parameters<typeof beginPreparation>[0]);
    case "endPreparation":
      return endPreparation(payload as Parameters<typeof endPreparation>[0]);
    case "activatePrepared":
      return activatePrepared(payload as Parameters<typeof activatePrepared>[0], context);
    case "beginInactiveLocationCleanup":
      return beginInactiveCleanup(payload as Parameters<typeof beginInactiveCleanup>[0]);
    case "endInactiveLocationCleanup":
      return endInactiveCleanup(payload as Parameters<typeof endInactiveCleanup>[0]);
    case "query":
      return queryDataset(payload as Parameters<typeof queryDataset>[0], context);
    case "describe":
      return describeDataset(payload as Parameters<typeof describeDataset>[0], context);
    case "extract":
      return extractDataset(payload as Parameters<typeof extractDataset>[0], context);
    case "extractCandidate":
      return extractCandidate(payload as Parameters<typeof extractCandidate>[0], context);
    case "list":
      return listDatasets(payload as Parameters<typeof listDatasets>[0]);
    case "catalog":
      return catalogDatasets(payload as Parameters<typeof catalogDatasets>[0]);
    case "drop":
      return dropDataset(payload as Parameters<typeof dropDataset>[0]);
    case "deactivateIfLocation":
      return deactivateIfLocation(payload as Parameters<typeof deactivateIfLocation>[0]);
    case "debugState":
      return {
        scopes: [...scopes.values()].map((scope) => ({ accountId: scope.accountId, tables: scope.tables })),
        pendingPreparations: pendingPreparations.size,
        pendingActivations: pendingActivations.size,
        cleanupReservations: cleanupReservations.size,
      };
    case "configureForTests": {
      if (process.env.NODE_ENV !== "test") throw operationError(403, "test configuration is unavailable");
      const timeout = payload.queryTimeoutMs;
      if (timeout !== undefined) {
        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) {
          throw operationError(400, "invalid test query timeout");
        }
        queryTimeoutMs = timeout;
      }
      return undefined;
    }
    case "shutdown":
      return shutdown();
    default:
      throw operationError(400, "unknown dataset operation");
  }
}

if (!parentPort) throw new Error("datasetsWorker must run in a worker thread");
const workerPort = parentPort;

workerPort.on("message", (message: RequestMessage | CancelMessage) => {
  if (!message || !Number.isSafeInteger(message.id)) return;
  if (message.type === "cancel") {
    const context = requestContexts.get(message.id);
    if (!context) return;
    context.cancelled = true;
    try {
      context.interrupt?.();
    } catch {
      // The request promise reports cancellation.
    }
    return;
  }
  if (message.type !== "request") return;
  const context: RequestContext = { id: message.id, cancelled: false };
  requestContexts.set(message.id, context);
  void dispatch(message.operation, message.payload, context)
    .then((result) => {
      workerPort.postMessage({ type: "response", id: message.id, result });
      if (message.operation === "shutdown") workerPort.close();
    })
    .catch((error: unknown) => {
      workerPort.postMessage({ type: "response", id: message.id, error: serializeDatasetError(error) });
    })
    .finally(() => requestContexts.delete(message.id));
});
