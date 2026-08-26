import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table, VectorQuery } from "@lancedb/lancedb";

const TABLE_NAME = "chunk_vectors";
const MAX_ID_LENGTH = 1_024;
const MAX_VECTOR_DIMENSION = 16_384;
const MAX_UPSERT_ROWS = 10_000;
const MAX_CHUNK_IDS = 10_000;
const MAX_CHUNK_IDS_PER_PREDICATE = 500;
const MAX_KEEP_GENERATIONS = 32;

export const MAX_VECTOR_SOURCE_ALLOWLIST = 100;
export const MAX_VECTOR_SEARCH_RESULTS = 100;

export interface LanceVectorIndexOptions {
  directory: string;
  dimension: number;
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
  if (!(Array.isArray(vector) || vector instanceof Float32Array) || vector.length !== dimension) {
    throw new LanceVectorInputError(`vector must contain exactly ${dimension} values`);
  }
  return Array.from(vector, (value) => {
    const normalized = Math.fround(value);
    if (!Number.isFinite(value) || !Number.isFinite(normalized)) {
      throw new LanceVectorInputError("vector values must be finite float32 numbers");
    }
    return normalized;
  });
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

export class LanceVectorIndex {
  readonly directory: string;
  readonly dimension: number;

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
      table = names.includes(TABLE_NAME)
        ? await connection.openTable(TABLE_NAME)
        : await connection.createEmptyTable(TABLE_NAME, schema);
      if (!schemaMatches(await table.schema(), schema)) throw new LanceVectorSchemaError();
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
