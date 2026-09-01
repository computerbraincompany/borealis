import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import Database from "better-sqlite3";

import { convertXlsxToCsv } from "./data/xlsx.js";
import { LanceVectorIndex } from "./vector/lance.js";

const MAX_VERIFIED_VECTOR_ROWS = 10_000_000;
const MAX_VERIFIED_DATASETS = 10_000;
const MAX_VERIFIED_DATASET_BYTES = 250 * 1024 * 1024;
const MAX_DATASET_VERIFY_MS = 60_000;
const MAX_TOTAL_DATASET_VERIFY_MS = 10 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TABLE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const CACHE_VERSION_RE = /^[0-9a-f]{32}\.(?:csv|json)$/;

export interface VerifyWorkspaceStoresOptions {
  readonly workspaceDirectory: string;
  readonly logicalWorkspaceDirectory?: string;
  readonly embeddingDimension?: number;
}

export interface WorkspaceStoreVerification {
  readonly sqlite_schema_version: number;
  readonly chunks: number;
  readonly vectors: number;
  readonly datasets: number;
  readonly embedding_dimension: number;
}

interface SqliteChunkIdentity {
  readonly chunk_id: string;
  readonly account_id: string;
  readonly source_id: string;
  readonly generation: number | bigint;
}

interface SqliteDatasetIdentity {
  readonly source_id: string;
  readonly account_id: string;
  readonly name: string;
  readonly file_path: string;
  readonly mime: string | null;
  readonly connector: string | null;
}

/** Open all three embedded engines without HTTP, workers, models, or egress. */
export async function verifyWorkspaceStores(
  options: VerifyWorkspaceStoresOptions
): Promise<WorkspaceStoreVerification> {
  const workspace = await exactDirectory(options.workspaceDirectory);
  const logicalWorkspace = options.logicalWorkspaceDirectory
    ? validateAbsolutePath(options.logicalWorkspaceDirectory)
    : workspace;
  const dimension = options.embeddingDimension ?? (await readPersistedEmbeddingDimension(workspace));
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 16_384) {
    throw new RangeError("embedding dimension is required for workspace verification");
  }
  const sqlitePath = path.join(workspace, "borealis.sqlite");
  const lancePath = path.join(workspace, "lancedb");
  await Promise.all([exactFile(sqlitePath), exactDirectory(lancePath)]);

  const database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  let chunks: SqliteChunkIdentity[];
  let datasets: SqliteDatasetIdentity[];
  let schemaVersion: number;
  try {
    database.pragma("foreign_keys = ON");
    const version = database.pragma("user_version", { simple: true });
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      throw new Error("SQLite schema version is invalid");
    }
    schemaVersion = version;
    const countRow = database
      .prepare(
        `SELECT
           (SELECT COUNT(*)
              FROM chunks c
              JOIN sources s ON s.id=c.source_id AND s.account_id=c.account_id
             WHERE s.status='ready' AND s.ready_generation=c.generation)
           + (SELECT COUNT(*) FROM ingestion_chunk_staging) AS count`
      )
      .get() as { count?: unknown } | undefined;
    const chunkCount = Number(countRow?.count);
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 0 || chunkCount > MAX_VERIFIED_VECTOR_ROWS) {
      throw new Error("workspace verification row limit exceeded");
    }
    chunks = database
      .prepare(
        `SELECT c.id AS chunk_id, c.account_id, c.source_id, c.generation
           FROM chunks c
           JOIN sources s ON s.id=c.source_id AND s.account_id=c.account_id
          WHERE s.status='ready' AND s.ready_generation=c.generation
         UNION ALL
         SELECT c.chunk_id, c.account_id, c.source_id, c.generation
           FROM ingestion_chunk_staging c`
      )
      .all() as SqliteChunkIdentity[];
    if (chunks.length !== chunkCount) throw new Error("workspace changed during verification");
    const datasetCount = Number(
      (
        database.prepare("SELECT COUNT(*) AS count FROM sources WHERE status='ready' AND kind='tabular'").get() as
          { count?: unknown } | undefined
      )?.count
    );
    if (!Number.isSafeInteger(datasetCount) || datasetCount < 0 || datasetCount > MAX_VERIFIED_DATASETS) {
      throw new Error("workspace dataset verification limit exceeded");
    }
    datasets = database
      .prepare(
        `SELECT id AS source_id, account_id, name, file_path, mime, connector
           FROM sources
          WHERE status='ready' AND kind='tabular'
          ORDER BY account_id, id`
      )
      .all() as SqliteDatasetIdentity[];
    if (datasets.length !== datasetCount || datasets.some((dataset) => typeof dataset.file_path !== "string")) {
      throw new Error("workspace tabular source identity is invalid");
    }
    const integrity = database.pragma("quick_check", { simple: true });
    if (integrity !== "ok") throw new Error("SQLite quick check failed");
  } finally {
    database.close();
  }

  const vectors = await LanceVectorIndex.open({
    directory: lancePath,
    dimension,
    requireExistingTable: true,
  });
  let vectorRows;
  try {
    const vectorCount = await vectors.countRows();
    if (vectorCount > MAX_VERIFIED_VECTOR_ROWS || vectorCount !== chunks.length) {
      throw new Error("SQLite and LanceDB row counts differ");
    }
    vectorRows = await vectors.scanRows();
  } finally {
    await vectors.close();
  }
  if (vectorRows.length > MAX_VERIFIED_VECTOR_ROWS || vectorRows.length !== chunks.length) {
    throw new Error("SQLite and LanceDB row counts differ");
  }
  const expected = new Map(
    chunks.map((chunk) => [
      chunk.chunk_id,
      `${chunk.account_id}\0${chunk.source_id}\0${safeGeneration(chunk.generation)}`,
    ])
  );
  if (expected.size !== chunks.length) throw new Error("SQLite chunk identities are duplicated");
  for (const row of vectorRows) {
    if (expected.get(row.chunkId) !== `${row.accountId}\0${row.sourceId}\0${row.generation}`) {
      throw new Error("SQLite and LanceDB identities differ");
    }
    expected.delete(row.chunkId);
  }
  if (expected.size) throw new Error("SQLite chunks are missing vectors");

  await verifyRestoredDatasets(workspace, logicalWorkspace, datasets);
  return Object.freeze({
    sqlite_schema_version: schemaVersion,
    chunks: chunks.length,
    vectors: vectorRows.length,
    datasets: datasets.length,
    embedding_dimension: dimension,
  });
}

async function verifyRestoredDatasets(
  workspace: string,
  logicalWorkspace: string,
  datasets: readonly SqliteDatasetIdentity[]
): Promise<void> {
  const duck = await DuckDBInstance.create(":memory:");
  const connection = await duck.connect();
  const deadlineAt = performance.now() + MAX_TOTAL_DATASET_VERIFY_MS;
  try {
    await connection.run("SET threads=4");
    await connection.run("SET memory_limit='512MB'");
    await connection.run("SET max_temp_directory_size='512MB'");
    for (const dataset of datasets) {
      if (performance.now() >= deadlineAt) throw new Error("workspace dataset verification timed out");
      const storedFile = dataset.file_path;
      if (!path.isAbsolute(storedFile) || storedFile.includes("\0")) {
        throw new Error("workspace tabular source identity is invalid");
      }
      const sourcePath = await restoredDatasetPath(workspace, logicalWorkspace, dataset);
      let converted: Awaited<ReturnType<typeof convertXlsxToCsv>> | undefined;
      try {
        const extension = path.extname(sourcePath).toLowerCase();
        let readablePath = sourcePath;
        if (extension === ".xlsx") {
          converted = await convertXlsxToCsv(sourcePath);
          readablePath = converted.path;
        }
        const reader = datasetReaderExpression(readablePath, dataset.connector ? dataset.mime : null);
        const remaining = Math.min(MAX_DATASET_VERIFY_MS, Math.max(1, deadlineAt - performance.now()));
        await runDuckDbWithDeadline(connection, remaining, () =>
          connection.runAndReadAll(`SELECT count(*) FROM ${reader}`, { source_path: readablePath })
        );
      } finally {
        await converted?.cleanup();
      }
    }
    await connection.run("SET enable_external_access=false");
    await connection.runAndReadAll("SELECT 1");
  } finally {
    connection.closeSync();
    duck.closeSync();
  }
}

async function restoredDatasetPath(
  workspace: string,
  logicalWorkspace: string,
  dataset: SqliteDatasetIdentity
): Promise<string> {
  if (!UUID_RE.test(dataset.account_id) || !UUID_RE.test(dataset.source_id) || !TABLE_RE.test(dataset.name)) {
    throw new Error("workspace tabular source identity is invalid");
  }
  const basename = path.basename(dataset.file_path);
  if (!basename || basename !== path.basename(basename) || basename.includes("\0")) {
    throw new Error("workspace tabular source identity is invalid");
  }
  const stored = path.resolve(dataset.file_path);
  const relative = path.relative(logicalWorkspace, stored);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("workspace tabular source identity is invalid");
  }
  const segments = relative.split(path.sep);
  if (dataset.connector) {
    if (!CACHE_VERSION_RE.test(basename)) throw new Error("workspace tabular source identity is invalid");
    const accountKey = createHash("sha256").update(dataset.account_id, "utf8").digest("hex").slice(0, 24);
    if (!endsWithSegments(segments, [accountKey, dataset.name, basename])) {
      throw new Error("workspace tabular source identity is invalid");
    }
  } else {
    if (!endsWithSegments(segments, [dataset.account_id, dataset.source_id, basename])) {
      throw new Error("workspace tabular source identity is invalid");
    }
  }
  const candidate = path.join(workspace, relative);
  await exactFile(candidate);
  const stat = await fs.stat(candidate);
  if (stat.size > MAX_VERIFIED_DATASET_BYTES) throw new Error("workspace dataset verification byte limit exceeded");
  return candidate;
}

async function runDuckDbWithDeadline<T>(
  connection: DuckDBConnection,
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    try {
      connection.interrupt();
    } catch {
      // The native query reports its own failure below.
    }
  }, timeoutMs);
  timer.unref();
  try {
    const result = await operation();
    if (expired) throw new Error("workspace dataset verification timed out");
    return result;
  } catch (error) {
    if (expired) throw new Error("workspace dataset verification timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function endsWithSegments(value: readonly string[], suffix: readonly string[]): boolean {
  return (
    value.length >= suffix.length &&
    suffix.every((segment, index) => segment === value[value.length - suffix.length + index])
  );
}

function datasetReaderExpression(filename: string, connectorMime: string | null): string {
  const extension = path.extname(filename).toLowerCase();
  if (connectorMime?.toLowerCase().includes("json") || extension === ".json" || extension === ".jsonl") {
    return "read_json_auto($source_path)";
  }
  if (extension === ".parquet") return "read_parquet($source_path)";
  if (extension === ".tsv") return "read_csv_auto($source_path, delim='\\t')";
  if (extension === ".csv") return "read_csv_auto($source_path)";
  throw new Error("workspace tabular source format is invalid");
}

async function readPersistedEmbeddingDimension(workspace: string): Promise<number> {
  const filename = path.join(workspace, "settings.json");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024) throw new Error("settings file is invalid");
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as { embedding_dimension?: unknown }).embedding_dimension !== "number"
    ) {
      throw new RangeError("embedding dimension is required for workspace verification");
    }
    return (value as { embedding_dimension: number }).embedding_dimension;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function exactDirectory(input: string): Promise<string> {
  const resolved = validateAbsolutePath(input);
  const [stat, real] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workspace directory is unsafe");
  return real;
}

function validateAbsolutePath(input: string): string {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) {
    throw new TypeError("workspace path must be absolute");
  }
  return path.resolve(input);
}

async function exactFile(input: string): Promise<void> {
  const [stat, real] = await Promise.all([fs.lstat(input), fs.realpath(input)]);
  if (!stat.isFile() || stat.isSymbolicLink() || real !== input) throw new Error("workspace file is unsafe");
}

function safeGeneration(value: number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("workspace generation is invalid");
  return result;
}
