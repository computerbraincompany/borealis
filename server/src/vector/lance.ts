import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table, VectorQuery } from "@lancedb/lancedb";

import { normalizeEmbeddingVector } from "../embeddingVector.js";
import { resolveLlmModelId } from "../llmAliases.js";

const TABLE_NAME = "chunk_vectors";
const MAX_ID_LENGTH = 1_024;
const MAX_VECTOR_DIMENSION = 16_384;
const MAX_UPSERT_ROWS = 10_000;
const MAX_CHUNK_IDS = 10_000;
const MAX_CHUNK_IDS_PER_PREDICATE = 500;
const MAX_KEEP_GENERATIONS = 32;
const INDEX_IDENTITY_FILENAME = ".borealis-embedding-index.json";
const INDEX_BINDING_FILENAME = ".borealis-embedding-index-binding.json";
const INDEX_IDENTITY_VERSION = 1 as const;
const MAX_INDEX_IDENTITY_BYTES = 4 * 1024;

export const MAX_VECTOR_SOURCE_ALLOWLIST = 100;
export const MAX_VECTOR_SEARCH_RESULTS = 100;

export interface LanceVectorIndexOptions {
  directory: string;
  dimension: number;
  /** Logical or physical model id; persisted as its resolved outbound identity. */
  embeddingModel?: string;
  /** One-release compatibility path for a populated index created before identity markers. */
  allowLegacyIdentityAdoption?: boolean;
  /** Verification paths must never manufacture a table or accept an unbound existing index. */
  requireExistingTable?: boolean;
}

export interface LanceVectorRow {
  chunkId: string;
  accountId: string;
  sourceId: string;
  generation: number;
  vector: readonly number[] | Float32Array;
}

export interface LanceVectorSearchInput {
  accountId: string;
  sourceIds: readonly string[];
  /** Optional ready-generation filter. When present, every searched source must appear exactly once. */
  sourceGenerations?: readonly Readonly<{ sourceId: string; generation: number }>[];
  vector: readonly number[] | Float32Array;
  limit: number;
}

export interface LanceVectorSearchHit {
  chunkId: string;
  /** Cosine distance; lower values are nearer. */
  distance: number;
}

export interface LanceVectorMetadataRow {
  chunkId: string;
  accountId: string;
  sourceId: string;
  generation: number;
}

export class LanceVectorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanceVectorInputError";
  }
}

export class LanceVectorSchemaError extends Error {
  constructor() {
    super("LanceDB vector schema does not match the configured contract");
    this.name = "LanceVectorSchemaError";
  }
}

export class LanceVectorEmbeddingIdentityError extends Error {
  constructor() {
    super("LanceDB embedding identity does not match the configured model");
    this.name = "LanceVectorEmbeddingIdentityError";
  }
}

export class LanceVectorIdentityError extends Error {
  constructor() {
    super("A chunk id is already assigned to a different vector identity");
    this.name = "LanceVectorIdentityError";
  }
}

export class LanceVectorClosedError extends Error {
  constructor() {
    super("LanceDB vector index is not open");
    this.name = "LanceVectorClosedError";
  }
}

type ExpectedSchema = ReturnType<typeof lancedb.makeArrowTable>["schema"];

interface StoredVectorRow extends Record<string, unknown> {
  chunk_id: string;
  account_id: string;
  source_id: string;
  generation: number;
  vector: number[];
}

interface StoredMetadataRow {
  chunk_id?: unknown;
  account_id?: unknown;
  source_id?: unknown;
  generation?: unknown;
}

function positiveBoundedInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new LanceVectorInputError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function generationValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LanceVectorInputError("generation must be a non-negative safe integer");
  }
  return value;
}

function idValue(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ID_LENGTH || value.includes("\0")) {
    throw new LanceVectorInputError(`${label} must contain between 1 and ${MAX_ID_LENGTH} characters without NUL`);
  }
  return value;
}

/** SQL-standard string literal for LanceDB/DataFusion predicate strings. */
function stringLiteral(value: string, label: string): string {
  return `'${idValue(value, label).replaceAll("'", "''")}'`;
}

function generationLiteral(value: number): string {
  return String(generationValue(value));
}

function uniqueIds(values: readonly string[], label: string, maximum: number): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new LanceVectorInputError(`${label} must contain at most ${maximum} values`);
  }
  const normalized = values.map((value) => idValue(value, label));
  return [...new Set(normalized)];
}

function stringInPredicate(column: "chunk_id" | "source_id", values: readonly string[], label: string): string {
  if (!values.length) throw new LanceVectorInputError(`${label} must not be empty`);
  return `${column} IN (${values.map((value) => stringLiteral(value, label)).join(", ")})`;
}

function sourceGenerationPredicate(sourceId: string, generation: number): string {
  return `source_id = ${stringLiteral(sourceId, "source id")} AND generation = ${generationLiteral(generation)}`;
}

function sourceScopePredicate(
  accountId: string,
  sourceIds: readonly string[],
  sourceGenerations?: readonly Readonly<{ sourceId: string; generation: number }>[]
): string {
  const account = `account_id = ${stringLiteral(accountId, "account id")}`;
  if (!sourceGenerations) return `${account} AND ${stringInPredicate("source_id", sourceIds, "source ids")}`;
  if (sourceGenerations.length !== sourceIds.length) {
    throw new LanceVectorInputError("source generations must cover every searched source exactly once");
  }
  const allowed = new Set(sourceIds);
  const seen = new Set<string>();
  const generationPredicates = sourceGenerations.map((scope) => {
    const sourceId = idValue(scope.sourceId, "source generation id");
    if (!allowed.has(sourceId) || seen.has(sourceId)) {
      throw new LanceVectorInputError("source generations must cover every searched source exactly once");
    }
    seen.add(sourceId);
    return `(source_id = ${stringLiteral(sourceId, "source generation id")} AND generation = ${generationLiteral(
      scope.generation
    )})`;
  });
  if (seen.size !== allowed.size) {
    throw new LanceVectorInputError("source generations must cover every searched source exactly once");
  }
  return `${account} AND (${generationPredicates.join(" OR ")})`;
}

function normalizeVector(vector: readonly number[] | Float32Array, dimension: number): number[] {
  try {
    return normalizeEmbeddingVector(vector, dimension);
  } catch {
    throw new LanceVectorInputError(`vector must contain exactly ${dimension} usable float32 values`);
  }
}

function expectedSchema(dimension: number): ExpectedSchema {
  return lancedb.makeArrowTable([
    {
      chunk_id: "",
      account_id: "",
      source_id: "",
      generation: 0,
      vector: new Array<number>(dimension).fill(0),
    },
  ]).schema;
}

function schemaMatches(actual: Awaited<ReturnType<Table["schema"]>>, expected: ExpectedSchema): boolean {
  if (actual.fields.length !== expected.fields.length) return false;
  return actual.fields.every((field, index) => {
    const expectedField = expected.fields[index];
    return (
      expectedField !== undefined &&
      field.name === expectedField.name &&
      String(field.type) === String(expectedField.type) &&
      field.nullable === expectedField.nullable
    );
  });
}

function storedMetadata(row: StoredMetadataRow): LanceVectorMetadataRow {
  if (
    typeof row.chunk_id !== "string" ||
    typeof row.account_id !== "string" ||
    typeof row.source_id !== "string" ||
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 0
  ) {
    throw new LanceVectorSchemaError();
  }
  return {
    chunkId: row.chunk_id,
    accountId: row.account_id,
    sourceId: row.source_id,
    generation: row.generation,
  };
}

function deletedRowCount(result: { numDeletedRows: number }): number {
  if (!Number.isSafeInteger(result.numDeletedRows) || result.numDeletedRows < 0) {
    throw new LanceVectorSchemaError();
  }
  return result.numDeletedRows;
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

interface StoredEmbeddingIdentity {
  readonly version: typeof INDEX_IDENTITY_VERSION;
  readonly resolved_model: string;
  readonly dimension: number;
}

function embeddingModelValue(value: string): string {
  const normalized = typeof value === "string" ? resolveLlmModelId(value.trim()) : "";
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || normalized.length > 256 || hasControlCharacter) {
    throw new LanceVectorInputError("embedding model must be a bounded model id without control characters");
  }
  return normalized;
}

function decodeEmbeddingIdentity(value: unknown): StoredEmbeddingIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LanceVectorEmbeddingIdentityError();
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "dimension,resolved_model,version" ||
    candidate.version !== INDEX_IDENTITY_VERSION ||
    typeof candidate.resolved_model !== "string" ||
    embeddingModelValue(candidate.resolved_model) !== candidate.resolved_model ||
    typeof candidate.dimension !== "number" ||
    !Number.isSafeInteger(candidate.dimension) ||
    candidate.dimension < 1 ||
    candidate.dimension > MAX_VECTOR_DIMENSION
  ) {
    throw new LanceVectorEmbeddingIdentityError();
  }
  return Object.freeze({
    version: INDEX_IDENTITY_VERSION,
    resolved_model: candidate.resolved_model,
    dimension: candidate.dimension,
  });
}

async function ensureEmbeddingIdentity(
  directory: string,
  expected: Omit<StoredEmbeddingIdentity, "version">,
  mayCreate: boolean
): Promise<void> {
  const filename = path.join(directory, INDEX_IDENTITY_FILENAME);
  const bindingFilename = path.join(directory, INDEX_BINDING_FILENAME);
  const [identity, binding] = await Promise.all([
    readOptionalEmbeddingIdentity(filename),
    readOptionalEmbeddingIdentity(bindingFilename),
  ]);
  if (identity) {
    assertEmbeddingIdentity(identity, expected);
    if (binding) {
      assertEmbeddingIdentity(binding, identity);
    } else {
      // Upgrade marker-only indexes without changing the identity the marker already authorizes.
      await publishEmbeddingIdentity(bindingFilename, identity);
      assertEmbeddingIdentity(await readEmbeddingIdentity(bindingFilename), identity);
    }
    return;
  }
  if (binding) {
    // The receipt is independent durable authority for the exact first-bound
    // identity. It can safely finish an interrupted marker publication (or
    // repair a missing marker) but can never authorize a relabel.
    assertEmbeddingIdentity(binding, expected);
    await publishEmbeddingIdentity(filename, binding);
    assertEmbeddingIdentity(await readEmbeddingIdentity(filename), binding);
    return;
  }
  if (!mayCreate) throw new LanceVectorEmbeddingIdentityError();
  const created = Object.freeze({
    version: INDEX_IDENTITY_VERSION,
    resolved_model: expected.resolved_model,
    dimension: expected.dimension,
  });
  // Publish the durable one-time receipt first. A crash before marker
  // publication can recover only the exact identity stored in this receipt.
  await publishEmbeddingIdentity(bindingFilename, created);
  await publishEmbeddingIdentity(filename, created);
  assertEmbeddingIdentity(await readEmbeddingIdentity(bindingFilename), created);
  assertEmbeddingIdentity(await readEmbeddingIdentity(filename), created);
}

async function validateOptionalEmbeddingIdentity(
  directory: string,
  dimension: number,
  requireIdentity: boolean
): Promise<void> {
  const [identity, binding] = await Promise.all([
    readOptionalEmbeddingIdentity(path.join(directory, INDEX_IDENTITY_FILENAME)),
    readOptionalEmbeddingIdentity(path.join(directory, INDEX_BINDING_FILENAME)),
  ]);
  if (!identity) {
    // Receipt-first publication makes this a legitimate crash state. Offline
    // verification may validate it read-only by schema dimension; only normal
    // startup has an expected model and may republish the public marker.
    if (!binding) {
      if (requireIdentity) throw new LanceVectorEmbeddingIdentityError();
      return;
    }
    if (binding.dimension !== dimension) throw new LanceVectorEmbeddingIdentityError();
    return;
  }
  if (identity.dimension !== dimension) throw new LanceVectorEmbeddingIdentityError();
  if (binding) assertEmbeddingIdentity(binding, identity);
}

function assertEmbeddingIdentity(
  actual: StoredEmbeddingIdentity,
  expected: Pick<StoredEmbeddingIdentity, "resolved_model" | "dimension">
): void {
  if (actual.resolved_model !== expected.resolved_model || actual.dimension !== expected.dimension) {
    throw new LanceVectorEmbeddingIdentityError();
  }
}

async function readOptionalEmbeddingIdentity(filename: string): Promise<StoredEmbeddingIdentity | undefined> {
  try {
    return await readEmbeddingIdentity(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readEmbeddingIdentity(filename: string): Promise<StoredEmbeddingIdentity> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INDEX_IDENTITY_BYTES) {
      throw new LanceVectorEmbeddingIdentityError();
    }
    if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    const body = await handle.readFile("utf8");
    if (Buffer.byteLength(body, "utf8") > MAX_INDEX_IDENTITY_BYTES) {
      throw new LanceVectorEmbeddingIdentityError();
    }
    return decodeEmbeddingIdentity(JSON.parse(body));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw error;
    if (error instanceof LanceVectorEmbeddingIdentityError) throw error;
    throw new LanceVectorEmbeddingIdentityError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function publishEmbeddingIdentity(filename: string, identity: StoredEmbeddingIdentity): Promise<void> {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporary, filename);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // The marker file fsync remains authoritative where directory fsync is unavailable.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class LanceVectorIndex {
  readonly directory: string;
  readonly dimension: number;
  readonly embeddingModel: string | undefined;

  private readonly allowLegacyIdentityAdoption: boolean;
  private readonly requireExistingTable: boolean;

  private connection: Connection | undefined;
  private table: Table | undefined;
  private initialization: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: LanceVectorIndexOptions) {
    if (typeof options.directory !== "string" || !options.directory.trim() || options.directory.includes("\0")) {
      throw new LanceVectorInputError("LanceDB directory must be a non-empty local path");
    }
    this.directory = path.resolve(options.directory);
    this.dimension = positiveBoundedInteger(options.dimension, "dimension", MAX_VECTOR_DIMENSION);
    this.embeddingModel =
      options.embeddingModel === undefined ? undefined : embeddingModelValue(options.embeddingModel);
    this.allowLegacyIdentityAdoption = options.allowLegacyIdentityAdoption === true;
    this.requireExistingTable = options.requireExistingTable === true;
  }

  static async open(options: LanceVectorIndexOptions): Promise<LanceVectorIndex> {
    const index = new LanceVectorIndex(options);
    await index.init();
    return index;
  }

  isOpen(): boolean {
    return Boolean(this.connection?.isOpen() && this.table?.isOpen() && !this.closing);
  }

  async init(): Promise<void> {
    if (this.isOpen()) return;
    if (this.closing) await this.closing;
    if (this.initialization) return this.initialization;

    const initialization = this.initialize();
    this.initialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.initialization === initialization) this.initialization = undefined;
    }
  }

  private async initialize(): Promise<void> {
    const connection = await lancedb.connect(this.directory);
    let table: Table | undefined;
    try {
      const schema = expectedSchema(this.dimension);
      const names = await connection.tableNames();
      const tableExisted = names.includes(TABLE_NAME);
      if (!tableExisted && this.requireExistingTable) throw new LanceVectorSchemaError();
      table = tableExisted
        ? await connection.openTable(TABLE_NAME)
        : await connection.createEmptyTable(TABLE_NAME, schema);
      if (!schemaMatches(await table.schema(), schema)) throw new LanceVectorSchemaError();
      if (this.embeddingModel !== undefined) {
        const empty = (await table.countRows()) === 0;
        await ensureEmbeddingIdentity(
          this.directory,
          { resolved_model: this.embeddingModel, dimension: this.dimension },
          !tableExisted || empty || this.allowLegacyIdentityAdoption
        );
      } else {
        await validateOptionalEmbeddingIdentity(this.directory, this.dimension, this.requireExistingTable);
      }
      this.connection = connection;
      this.table = table;
    } catch (error) {
      table?.close();
      connection.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.connection && !this.table) return;

    const table = this.table;
    const connection = this.connection;
    const closing = (async () => {
      await this.writeTail;
      table?.close();
      connection?.close();
      if (this.table === table) this.table = undefined;
      if (this.connection === connection) this.connection = undefined;
    })();
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = undefined;
    }
  }

  async upsert(rows: readonly LanceVectorRow[]): Promise<void> {
    if (!Array.isArray(rows) || rows.length > MAX_UPSERT_ROWS) {
      throw new LanceVectorInputError(`upsert accepts at most ${MAX_UPSERT_ROWS} rows`);
    }
    if (!rows.length) return;

    const normalized: StoredVectorRow[] = [];
    const byChunkId = new Map<string, LanceVectorMetadataRow>();
    for (const row of rows) {
      const metadata = {
        chunkId: idValue(row.chunkId, "chunk id"),
        accountId: idValue(row.accountId, "account id"),
        sourceId: idValue(row.sourceId, "source id"),
        generation: generationValue(row.generation),
      };
      if (byChunkId.has(metadata.chunkId)) {
        throw new LanceVectorInputError("an upsert batch must not contain duplicate chunk ids");
      }
      byChunkId.set(metadata.chunkId, metadata);
      normalized.push({
        chunk_id: metadata.chunkId,
        account_id: metadata.accountId,
        source_id: metadata.sourceId,
        generation: metadata.generation,
        vector: normalizeVector(row.vector, this.dimension),
      });
    }

    await this.enqueueWrite(async (table) => {
      const existing = await this.metadataForChunkIds(table, [...byChunkId.keys()]);
      const seen = new Set<string>();
      for (const row of existing) {
        if (seen.has(row.chunkId)) throw new LanceVectorIdentityError();
        seen.add(row.chunkId);
        const incoming = byChunkId.get(row.chunkId);
        if (
          !incoming ||
          incoming.accountId !== row.accountId ||
          incoming.sourceId !== row.sourceId ||
          incoming.generation !== row.generation
        ) {
          throw new LanceVectorIdentityError();
        }
      }

      await table.mergeInsert("chunk_id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(normalized);

      const groups = new Map<string, { sourceId: string; generation: number; chunkIds: string[] }>();
      for (const row of normalized) {
        const key = `${row.source_id}\0${row.generation}`;
        const group = groups.get(key) ?? { sourceId: row.source_id, generation: row.generation, chunkIds: [] };
        group.chunkIds.push(row.chunk_id);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        if (!(await this.hasAllUsingTable(table, group.chunkIds, group.sourceId, group.generation))) {
          throw new LanceVectorSchemaError();
        }
      }
    });
  }

  async search(input: LanceVectorSearchInput): Promise<LanceVectorSearchHit[]> {
    const sourceIds = uniqueIds(input.sourceIds, "source ids", MAX_VECTOR_SOURCE_ALLOWLIST);
    if (!sourceIds.length) return [];
    const accountId = idValue(input.accountId, "account id");
    const vector = normalizeVector(input.vector, this.dimension);
    const limit = positiveBoundedInteger(input.limit, "search limit", MAX_VECTOR_SEARCH_RESULTS);
    const rows = await this.scopedSearchQuery(
      this.requireTable(),
      accountId,
      sourceIds,
      vector,
      limit,
      input.sourceGenerations
    ).toArray();
    return rows.map((row): LanceVectorSearchHit => {
      if (typeof row.chunk_id !== "string" || typeof row._distance !== "number" || !Number.isFinite(row._distance)) {
        throw new LanceVectorSchemaError();
      }
      return { chunkId: row.chunk_id, distance: row._distance };
    });
  }

  async hasAll(chunkIds: readonly string[], sourceId: string, generation: number): Promise<boolean> {
    const normalized = uniqueIds(chunkIds, "chunk ids", MAX_CHUNK_IDS);
    if (!normalized.length) return true;
    return this.hasAllUsingTable(
      this.requireTable(),
      normalized,
      idValue(sourceId, "source id"),
      generationValue(generation)
    );
  }

  async scanRows(): Promise<LanceVectorMetadataRow[]> {
    const rows = await this.requireTable()
      .query()
      .select(["chunk_id", "account_id", "source_id", "generation"])
      .toArray();
    return rows.map((row) => storedMetadata(row));
  }

  async countRows(): Promise<number> {
    const count = await this.requireTable().countRows();
    if (!Number.isSafeInteger(count) || count < 0) throw new LanceVectorSchemaError();
    return count;
  }

  async deleteGeneration(sourceId: string, generation: number): Promise<number> {
    const predicate = sourceGenerationPredicate(sourceId, generation);
    return this.enqueueWrite(async (table) => deletedRowCount(await table.delete(predicate)));
  }

  async deleteSource(sourceId: string): Promise<number> {
    const predicate = `source_id = ${stringLiteral(sourceId, "source id")}`;
    return this.enqueueWrite(async (table) => deletedRowCount(await table.delete(predicate)));
  }

  /** Delete exact vector ids that ledger repair has already proven missing. */
  async deleteMissing(chunkIds: readonly string[]): Promise<number> {
    const normalized = uniqueIds(chunkIds, "chunk ids", MAX_CHUNK_IDS);
    if (!normalized.length) return 0;
    return this.enqueueWrite(async (table) => {
      let removed = 0;
      for (const batch of batches(normalized, MAX_CHUNK_IDS_PER_PREDICATE)) {
        removed += deletedRowCount(await table.delete(stringInPredicate("chunk_id", batch, "chunk ids")));
      }
      return removed;
    });
  }

  /** Delete every generation for one source except the explicitly live/in-progress set. */
  async prune(sourceId: string, keepGenerations: readonly number[]): Promise<number> {
    if (!Array.isArray(keepGenerations) || keepGenerations.length > MAX_KEEP_GENERATIONS) {
      throw new LanceVectorInputError(`keep generations must contain at most ${MAX_KEEP_GENERATIONS} values`);
    }
    const normalized = [...new Set(keepGenerations.map(generationValue))];
    const sourcePredicate = `source_id = ${stringLiteral(sourceId, "source id")}`;
    const predicate = normalized.length
      ? `${sourcePredicate} AND generation NOT IN (${normalized.map(generationLiteral).join(", ")})`
      : sourcePredicate;
    return this.enqueueWrite(async (table) => deletedRowCount(await table.delete(predicate)));
  }

  /** Physical-plan hook retained only for the tenant-prefilter regression. */
  async __explainSearchPlanForTests(input: LanceVectorSearchInput): Promise<string> {
    if (process.env.NODE_ENV !== "test") throw new Error("test-only LanceDB query-plan hook");
    const sourceIds = uniqueIds(input.sourceIds, "source ids", MAX_VECTOR_SOURCE_ALLOWLIST);
    if (!sourceIds.length) return "";
    return this.scopedSearchQuery(
      this.requireTable(),
      idValue(input.accountId, "account id"),
      sourceIds,
      normalizeVector(input.vector, this.dimension),
      positiveBoundedInteger(input.limit, "search limit", MAX_VECTOR_SEARCH_RESULTS),
      input.sourceGenerations
    ).explainPlan(true);
  }

  private requireTable(): Table {
    if (!this.isOpen() || !this.table) throw new LanceVectorClosedError();
    return this.table;
  }

  private enqueueWrite<T>(operation: (table: Table) => Promise<T>): Promise<T> {
    const table = this.requireTable();
    const run = this.writeTail.then(
      () => operation(table),
      () => operation(table)
    );
    this.writeTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private scopedSearchQuery(
    table: Table,
    accountId: string,
    sourceIds: readonly string[],
    vector: number[],
    limit: number,
    sourceGenerations?: readonly Readonly<{ sourceId: string; generation: number }>[]
  ): VectorQuery {
    return table
      .vectorSearch(vector)
      .where(sourceScopePredicate(accountId, sourceIds, sourceGenerations))
      .distanceType("cosine")
      .select(["chunk_id", "_distance"])
      .limit(limit);
  }

  private async metadataForChunkIds(table: Table, chunkIds: readonly string[]): Promise<LanceVectorMetadataRow[]> {
    const rows: LanceVectorMetadataRow[] = [];
    for (const batch of batches(chunkIds, MAX_CHUNK_IDS_PER_PREDICATE)) {
      const matches = await table
        .query()
        .where(stringInPredicate("chunk_id", batch, "chunk ids"))
        .select(["chunk_id", "account_id", "source_id", "generation"])
        .toArray();
      rows.push(...matches.map((row) => storedMetadata(row)));
    }
    return rows;
  }

  private async hasAllUsingTable(
    table: Table,
    chunkIds: readonly string[],
    sourceId: string,
    generation: number
  ): Promise<boolean> {
    for (const batch of batches(chunkIds, MAX_CHUNK_IDS_PER_PREDICATE)) {
      const predicate = `${sourceGenerationPredicate(sourceId, generation)} AND ${stringInPredicate(
        "chunk_id",
        batch,
        "chunk ids"
      )}`;
      const matches = await table.query().where(predicate).select(["chunk_id"]).toArray();
      if (matches.length !== batch.length) return false;
      const returned = new Set(matches.map((row) => row.chunk_id));
      if (returned.size !== batch.length || batch.some((chunkId) => !returned.has(chunkId))) return false;
    }
    return true;
  }
}
