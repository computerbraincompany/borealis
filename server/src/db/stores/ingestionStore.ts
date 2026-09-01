import { randomUUID } from "node:crypto";

import { decodeJson, decodeSafeInteger, encodeIsoTimestamp, encodeJson } from "../codecs.js";
import type { SqliteLedger, SqliteTransaction } from "../types.js";

const MAX_STAGED_CHUNKS = 10_000;
const MAX_LOOKUP_IDS = 10_000;
const SQLITE_BIND_BATCH = 400;

export type IngestionJobStatus = "preparing" | "pending" | "running" | "done" | "error";

export interface IngestionJob {
  readonly sourceId: string;
  readonly accountId: string;
  readonly generation: number;
  readonly status: IngestionJobStatus;
  readonly attempts: number;
  readonly availableAt: string;
  readonly leasedAt: string | null;
  readonly leaseToken: string | null;
  readonly lastError: string | null;
}

export interface IngestionSource {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly kind: string;
  readonly connector: string | null;
  readonly displayName: string;
  readonly filePath: string | null;
  readonly url: string | null;
  readonly mime: string | null;
  readonly sizeBytes: number;
  readonly status: "ready" | "index" | "error";
  readonly meta: Record<string, unknown>;
  readonly readyGeneration: number | null;
}

export interface StagedChunkInput {
  readonly content: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface StagedChunk {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly accountId: string;
  readonly generation: number;
  readonly seq: number;
  readonly sourceName: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
}

export interface PendingVectorOperation {
  readonly sourceId: string;
  readonly accountId: string;
  readonly operation: "delete_generation" | "prune_except_generation";
  readonly generation: number;
  readonly attempts: number;
}

export interface VectorRepairLedgerState {
  readonly sources: ReadonlyMap<
    string,
    Readonly<{ accountId: string; readyGeneration: number | null; inProgressGenerations: ReadonlySet<number> }>
  >;
  readonly validChunkIds: ReadonlySet<string>;
}

export interface DatasetCleanupJob {
  readonly accountId: string;
  readonly name: string;
  readonly location: string;
  readonly attempts: number;
}

export interface PromoteGenerationInput {
  readonly accountId: string;
  readonly sourceId: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly sizeBytes: number;
  readonly promotedFilePath?: string;
  readonly verifyVectors: (chunkIds: readonly string[]) => Promise<boolean>;
}

export class IngestionStoreError extends Error {
  constructor(
    readonly code:
      "SOURCE_NOT_FOUND" | "INGESTION_SUPERSEDED" | "INGESTION_EMPTY" | "VECTOR_INCOMPLETE" | "INVALID_INPUT",
    message: string
  ) {
    super(message);
    this.name = "IngestionStoreError";
  }
}

interface JobRow {
  source_id: string;
  account_id: string;
  generation: bigint;
  status: IngestionJobStatus;
  attempts: bigint;
  available_at: string;
  leased_at: string | null;
  lease_token: string | null;
  last_error: string | null;
}

interface SourceRow {
  id: string;
  account_id: string;
  name: string;
  kind: string;
  connector: string | null;
  display_name: string;
  file_path: string | null;
  url: string | null;
  mime: string | null;
  size_bytes: bigint;
  status: "ready" | "index" | "error";
  meta: string;
  ready_generation: bigint | null;
}

interface StagingRow {
  chunk_id: string;
  source_id: string;
  account_id: string;
  generation: bigint;
  seq: bigint;
  source_name: string;
  content: string;
  meta: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IngestionStoreError("INVALID_INPUT", `${field} must be a non-negative safe integer`);
  }
  return value;
}

function positiveGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new IngestionStoreError("INVALID_INPUT", "generation must be a positive safe integer");
  }
  return value;
}

function requiredId(value: string, field: string, maximum = 1_024): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) {
    throw new IngestionStoreError("INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function jobFromRow(row: JobRow): IngestionJob {
  return Object.freeze({
    sourceId: row.source_id,
    accountId: row.account_id,
    generation: decodeSafeInteger(row.generation, "generation"),
    status: row.status,
    attempts: decodeSafeInteger(row.attempts, "attempts"),
    availableAt: encodeIsoTimestamp(row.available_at, "available_at"),
    leasedAt: row.leased_at === null ? null : encodeIsoTimestamp(row.leased_at, "leased_at"),
    leaseToken: row.lease_token,
    lastError: row.last_error,
  });
}

function sourceFromRow(row: SourceRow): IngestionSource {
  return Object.freeze({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    kind: row.kind,
    connector: row.connector,
    displayName: row.display_name,
    filePath: row.file_path,
    url: row.url,
    mime: row.mime,
    sizeBytes: decodeSafeInteger(row.size_bytes, "size_bytes"),
    status: row.status,
    meta: Object.freeze(decodeJson<Record<string, unknown>>(row.meta, "source meta")),
    readyGeneration: row.ready_generation === null ? null : decodeSafeInteger(row.ready_generation, "ready_generation"),
  });
}

function stagingFromRow(row: StagingRow): StagedChunk {
  return Object.freeze({
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    accountId: row.account_id,
    generation: decodeSafeInteger(row.generation, "generation"),
    seq: decodeSafeInteger(row.seq, "seq"),
    sourceName: row.source_name,
    content: row.content,
    meta: Object.freeze(decodeJson<Record<string, unknown>>(row.meta, "chunk meta")),
  });
}

function batches<T>(values: readonly T[], size = SQLITE_BIND_BATCH): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) result.push(values.slice(start, start + size));
  return result;
}

function placeholders(length: number): string {
  return new Array(length).fill("?").join(",");
}

function sourceRowInTransaction(tx: SqliteTransaction, accountId: string, sourceId: string): SourceRow | undefined {
  return tx.get<SourceRow>(
    `SELECT id, account_id, name, kind, connector, display_name, file_path, url, mime,
            size_bytes, status, meta, ready_generation
       FROM sources WHERE id=? AND account_id=?`,
    [sourceId, accountId]
  );
}

function enqueueDatasetCleanupTx(
  tx: SqliteTransaction,
  accountId: string,
  name: string,
  location: string,
  timestamp: string
): void {
  tx.run(
    `INSERT INTO dataset_cache_cleanup_jobs
       (account_id,name,location,attempts,created_at,updated_at)
     VALUES (?,?,?,0,?,?)
     ON CONFLICT(account_id,name,location) DO UPDATE SET updated_at=excluded.updated_at`,
    [accountId, name, location, timestamp, timestamp]
  );
}

/** Typed SQLite state machine for durable ingestion. External I/O belongs in the coordinator. */
export class SqliteIngestionStore {
  constructor(readonly ledger: SqliteLedger) {}

  async reserveJob(
    accountIdInput: string,
    sourceIdInput: string,
    initialStatus: "preparing" | "pending" = "pending"
  ): Promise<number> {
    const accountId = requiredId(accountIdInput, "account id");
    const sourceId = requiredId(sourceIdInput, "source id");
    return this.ledger.withImmediateTransaction((tx) => {
      const source = sourceRowInTransaction(tx, accountId, sourceId);
      if (!source) throw new IngestionStoreError("SOURCE_NOT_FOUND", "source not found");
      const prior = tx.get<{ generation: bigint }>("SELECT generation FROM ingestion_jobs WHERE source_id=?", [
        sourceId,
      ]);
      const generation = prior ? decodeSafeInteger(prior.generation, "generation") + 1 : 1;
      const timestamp = nowIso();
      tx.run(
        `INSERT INTO ingestion_jobs
           (source_id, account_id, generation, status, attempts, available_at, leased_at, lease_token,
            last_error, created_at, updated_at)
         VALUES (?,?,?,?,0,?,NULL,NULL,NULL,?,?)
         ON CONFLICT(source_id) DO UPDATE SET
           account_id=excluded.account_id,
           generation=excluded.generation,
           status=excluded.status,
           attempts=0,
           available_at=excluded.available_at,
           leased_at=NULL,
           lease_token=NULL,
           last_error=NULL,
           updated_at=excluded.updated_at`,
        [sourceId, accountId, generation, initialStatus, timestamp, timestamp, timestamp]
      );
      const stale = tx.all<{ generation: bigint }>(
        `SELECT DISTINCT generation FROM ingestion_chunk_staging
         WHERE source_id=? AND generation<?`,
        [sourceId, generation]
      );
      for (const row of stale) {
        const staleGeneration = decodeSafeInteger(row.generation, "generation");
        if (staleGeneration !== sourceFromRow(source).readyGeneration) {
          this.enqueueVectorOperationTx(tx, accountId, sourceId, "delete_generation", staleGeneration, timestamp);
        }
      }
      tx.run("DELETE FROM ingestion_chunk_staging WHERE source_id=? AND generation<?", [sourceId, generation]);
      if (prior) {
        const priorGeneration = decodeSafeInteger(prior.generation, "generation");
        if (priorGeneration !== sourceFromRow(source).readyGeneration) {
          this.enqueueVectorOperationTx(tx, accountId, sourceId, "delete_generation", priorGeneration, timestamp);
        }
      }
      return generation;
    });
  }

  async claimNext(status: "preparing" | "pending", at = new Date()): Promise<IngestionJob | undefined> {
    const timestamp = encodeIsoTimestamp(at, "claim time");
    return this.ledger.withImmediateTransaction((tx) => {
      const candidate = tx.get<JobRow>(
        `SELECT source_id, account_id, generation, status, attempts, available_at, leased_at, lease_token, last_error
         FROM ingestion_jobs
         WHERE status=? AND available_at<=?
           AND (?<>'preparing' OR (leased_at IS NULL AND lease_token IS NULL))
         ORDER BY updated_at, source_id LIMIT 1`,
        [status, timestamp, status]
      );
      if (!candidate) return undefined;
      const leaseToken = randomUUID();
      const nextStatus: IngestionJobStatus = status === "pending" ? "running" : "preparing";
      const changed = tx.run(
        `UPDATE ingestion_jobs SET status=?, attempts=attempts+1, leased_at=?, lease_token=?, updated_at=?
         WHERE source_id=? AND generation=? AND status=?`,
        [nextStatus, timestamp, leaseToken, timestamp, candidate.source_id, candidate.generation, status]
      );
      if (changed.changes !== 1) return undefined;
      const claimed = tx.get<JobRow>(
        `SELECT source_id, account_id, generation, status, attempts, available_at, leased_at, lease_token, last_error
         FROM ingestion_jobs WHERE source_id=?`,
        [candidate.source_id]
      );
      return claimed ? jobFromRow(claimed) : undefined;
    });
  }

  async getJob(accountId: string, sourceId: string): Promise<IngestionJob | undefined> {
    const row = await this.ledger.get<JobRow>(
      `SELECT source_id, account_id, generation, status, attempts, available_at, leased_at, lease_token, last_error
       FROM ingestion_jobs WHERE source_id=? AND account_id=?`,
      [sourceId, accountId]
    );
    return row ? jobFromRow(row) : undefined;
  }

  async getSource(accountId: string, sourceId: string): Promise<IngestionSource | undefined> {
    const row = await this.ledger.get<SourceRow>(
      `SELECT id, account_id, name, kind, connector, display_name, file_path, url, mime,
              size_bytes, status, meta, ready_generation
       FROM sources WHERE id=? AND account_id=?`,
      [sourceId, accountId]
    );
    return row ? sourceFromRow(row) : undefined;
  }

  async assertLease(accountId: string, sourceId: string, generation: number, leaseToken: string): Promise<void> {
    const row = await this.ledger.get<{ ok: bigint }>(
      `SELECT 1 AS ok FROM ingestion_jobs
       WHERE source_id=? AND account_id=? AND generation=? AND status='running' AND lease_token=?`,
      [sourceId, accountId, positiveGeneration(generation), requiredId(leaseToken, "lease token")]
    );
    if (!row) throw new IngestionStoreError("INGESTION_SUPERSEDED", "source ingestion superseded");
  }

  async markSourceProcessing(
    accountId: string,
    sourceId: string,
    generation: number,
    leaseToken: string
  ): Promise<void> {
    await this.ledger.withImmediateTransaction((tx) => {
      this.assertLeaseTx(tx, accountId, sourceId, positiveGeneration(generation), leaseToken);
      const updated = tx.run(
        `UPDATE sources SET status=CASE WHEN status='ready' THEN 'ready' ELSE 'index' END
         WHERE id=? AND account_id=?`,
        [sourceId, accountId]
      );
      if (updated.changes !== 1) {
        throw new IngestionStoreError("INGESTION_SUPERSEDED", "source ingestion superseded");
      }
    });
  }

  async rememberConnectorPreviousLocation(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken: string;
    location: string;
  }): Promise<void> {
    await this.ledger.withImmediateTransaction((tx) => {
      this.assertLeaseTx(tx, input.accountId, input.sourceId, positiveGeneration(input.generation), input.leaseToken);
      const source = sourceRowInTransaction(tx, input.accountId, input.sourceId);
      if (!source) throw new IngestionStoreError("INGESTION_SUPERSEDED", "source ingestion superseded");
      const meta = decodeJson<Record<string, unknown>>(source.meta, "source meta");
      meta.connector_previous_location = requiredId(input.location, "connector previous location", 32_768);
      tx.run("UPDATE sources SET meta=? WHERE id=? AND account_id=?", [
        encodeJson(meta, "source meta"),
        input.sourceId,
        input.accountId,
      ]);
    });
  }

  async clearSourceMetaValue(input: {
    accountId: string;
    sourceId: string;
    key: string;
    expectedValue: string;
  }): Promise<boolean> {
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(input.key)) {
      throw new IngestionStoreError("INVALID_INPUT", "metadata key is invalid");
    }
    return this.ledger.withImmediateTransaction((tx) => {
      const source = sourceRowInTransaction(tx, input.accountId, input.sourceId);
      if (!source) return false;
      const meta = decodeJson<Record<string, unknown>>(source.meta, "source meta");
      if (meta[input.key] !== input.expectedValue) return false;
      delete meta[input.key];
      tx.run("UPDATE sources SET meta=? WHERE id=? AND account_id=?", [
        encodeJson(meta, "source meta"),
        input.sourceId,
        input.accountId,
      ]);
      return true;
    });
  }

  async heartbeat(
    accountId: string,
    sourceId: string,
    generation: number,
    leaseToken: string,
    at = new Date()
  ): Promise<boolean> {
    const timestamp = encodeIsoTimestamp(at, "heartbeat time");
    const result = await this.ledger.run(
      `UPDATE ingestion_jobs SET leased_at=?, updated_at=?
       WHERE source_id=? AND account_id=? AND generation=? AND status='running' AND lease_token=?`,
      [timestamp, timestamp, sourceId, accountId, positiveGeneration(generation), leaseToken]
    );
    return result.changes === 1;
  }

  async recoverRunningLeases(input: {
    startup: boolean;
    expiredBefore?: Date;
    maxAttempts: number;
  }): Promise<readonly IngestionJob[]> {
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100) {
      throw new IngestionStoreError("INVALID_INPUT", "maxAttempts is invalid");
    }
    const expiredBefore = input.startup
      ? null
      : encodeIsoTimestamp(input.expiredBefore ?? new Date(), "lease expiration boundary");
    return this.ledger.withImmediateTransaction((tx) => {
      const rows = tx.all<JobRow>(
        `SELECT source_id, account_id, generation, status, attempts, available_at, leased_at, lease_token, last_error
         FROM ingestion_jobs
         WHERE status='running' AND (? IS NULL OR leased_at IS NULL OR leased_at<?)
         ORDER BY updated_at,source_id`,
        [expiredBefore, expiredBefore]
      );
      const recovered: IngestionJob[] = [];
      for (const row of rows) {
        const previousGeneration = decodeSafeInteger(row.generation, "generation");
        const generation = previousGeneration + 1;
        const attempts = decodeSafeInteger(row.attempts, "attempts");
        const status: IngestionJobStatus = attempts >= input.maxAttempts ? "error" : "pending";
        const timestamp = nowIso();
        tx.run(
          `UPDATE ingestion_jobs SET generation=?,status=?,leased_at=NULL,lease_token=NULL,
             available_at=?,last_error=?,updated_at=?
           WHERE source_id=? AND account_id=? AND generation=? AND status='running'`,
          [
            generation,
            status,
            timestamp,
            input.startup ? "PROCESS_RESTARTED" : "LEASE_EXPIRED",
            timestamp,
            row.source_id,
            row.account_id,
            previousGeneration,
          ]
        );
        tx.run("DELETE FROM ingestion_chunk_staging WHERE source_id=? AND generation=?", [
          row.source_id,
          previousGeneration,
        ]);
        const source = sourceRowInTransaction(tx, row.account_id, row.source_id);
        const readyGeneration = source ? sourceFromRow(source).readyGeneration : null;
        if (readyGeneration !== previousGeneration) {
          this.enqueueVectorOperationTx(
            tx,
            row.account_id,
            row.source_id,
            "delete_generation",
            previousGeneration,
            timestamp
          );
        }
        if (source) {
          const hasLive = Boolean(
            tx.get("SELECT 1 FROM chunks WHERE source_id=? AND account_id=? LIMIT 1", [row.source_id, row.account_id])
          );
          const nextSourceStatus = status === "error" && !hasLive ? "error" : hasLive ? "ready" : "index";
          tx.run("UPDATE sources SET status=? WHERE id=? AND account_id=?", [
            nextSourceStatus,
            row.source_id,
            row.account_id,
          ]);
          if (source.connector) {
            tx.run("UPDATE connectors SET sync_status=?,sync_error=? WHERE id=? AND account_id=?", [
              status === "error" ? "error" : "indexing",
              status === "error" ? "Connector indexing failed." : null,
              source.connector,
              row.account_id,
            ]);
          }
        }
        const updated = tx.get<JobRow>(
          `SELECT source_id, account_id, generation, status, attempts, available_at, leased_at, lease_token, last_error
           FROM ingestion_jobs WHERE source_id=?`,
          [row.source_id]
        );
        if (updated) recovered.push(jobFromRow(updated));
      }
      return Object.freeze(recovered);
    });
  }

  async recoverPreparingLeases(input: { startup: boolean; expiredBefore?: Date }): Promise<number> {
    const boundary = input.startup
      ? null
      : encodeIsoTimestamp(input.expiredBefore ?? new Date(), "prepare lease expiration boundary");
    const timestamp = nowIso();
    const result = await this.ledger.run(
      `UPDATE ingestion_jobs SET leased_at=NULL,lease_token=NULL,available_at=?,last_error=?,updated_at=?
       WHERE status='preparing' AND (leased_at IS NOT NULL OR lease_token IS NOT NULL)
         AND (? IS NULL OR leased_at IS NULL OR leased_at<?)`,
      [timestamp, input.startup ? "PROCESS_RESTARTED" : "PREPARE_LEASE_EXPIRED", timestamp, boundary, boundary]
    );
    return result.changes;
  }

  /**
   * Revalidate reconciliation's stale registry observation against the current
   * source transition state and reserve exact cleanup authority atomically.
   * A current source file or prepared candidate always wins over reconciliation.
   */
  async reserveReconciliationDatasetCleanup(accountIdInput: string, nameInput: string, locationInput: string) {
    const accountId = requiredId(accountIdInput, "account id");
    const name = requiredId(nameInput, "dataset name", 256);
    const location = requiredId(locationInput, "dataset location", 32_768);
    return this.ledger.withImmediateTransaction((tx) => {
      const sources = tx.all<SourceRow>(
        `SELECT id, account_id, name, kind, connector, display_name, file_path, url, mime,
                size_bytes, status, meta, ready_generation
           FROM sources WHERE account_id=? AND name=?`,
        [accountId, name]
      );
      for (const row of sources) {
        const source = sourceFromRow(row);
        const candidate = source.meta.connector_candidate_location;
        if (source.filePath === location || candidate === location) return false;
      }
      enqueueDatasetCleanupTx(tx, accountId, name, location, nowIso());
      return true;
    });
  }

  async listDatasetCleanupJobs(
    input: {
      accountId?: string;
      name?: string;
      limit?: number;
    } = {}
  ): Promise<readonly DatasetCleanupJob[]> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new IngestionStoreError("INVALID_INPUT", "dataset cleanup limit is invalid");
    }
    const rows = await this.ledger.all<{
      account_id: string;
      name: string;
      location: string;
      attempts: bigint;
    }>(
      `SELECT account_id,name,location,attempts FROM dataset_cache_cleanup_jobs
       WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR name=?)
       ORDER BY updated_at LIMIT ?`,
      [input.accountId ?? null, input.accountId ?? null, input.name ?? null, input.name ?? null, limit]
    );
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          accountId: row.account_id,
          name: row.name,
          location: row.location,
          attempts: decodeSafeInteger(row.attempts, "attempts"),
        })
      )
    );
  }

  async getDatasetCleanupJob(
    accountIdInput: string,
    nameInput: string,
    locationInput: string
  ): Promise<DatasetCleanupJob | undefined> {
    const accountId = requiredId(accountIdInput, "account id");
    const name = requiredId(nameInput, "dataset name", 256);
    const location = requiredId(locationInput, "dataset location", 32_768);
    const row = await this.ledger.get<{ attempts: bigint }>(
      `SELECT attempts FROM dataset_cache_cleanup_jobs
       WHERE account_id=? AND name=? AND location=?`,
      [accountId, name, location]
    );
    return row
      ? Object.freeze({ accountId, name, location, attempts: decodeSafeInteger(row.attempts, "attempts") })
      : undefined;
  }

  async resolveDatasetCleanupJob(job: DatasetCleanupJob, outcome: "complete" | "failed"): Promise<void> {
    if (outcome === "complete") {
      await this.ledger.withImmediateTransaction((tx) => {
        tx.run("DELETE FROM dataset_cache_cleanup_jobs WHERE account_id=? AND name=? AND location=?", [
          job.accountId,
          job.name,
          job.location,
        ]);
        const rows = tx.all<{ id: string; meta: string }>("SELECT id,meta FROM sources WHERE account_id=? AND name=?", [
          job.accountId,
          job.name,
        ]);
        for (const row of rows) {
          const meta = decodeJson<Record<string, unknown>>(row.meta, "source meta");
          if (meta.connector_previous_location !== job.location) continue;
          delete meta.connector_previous_location;
          tx.run("UPDATE sources SET meta=? WHERE id=? AND account_id=?", [
            encodeJson(meta, "source meta"),
            row.id,
            job.accountId,
          ]);
        }
      });
      return;
    }
    await this.ledger.run(
      `UPDATE dataset_cache_cleanup_jobs SET attempts=attempts+1,updated_at=?
       WHERE account_id=? AND name=? AND location=?`,
      [nowIso(), job.accountId, job.name, job.location]
    );
  }

  async stageChunks(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken: string;
    sourceName: string;
    chunks: readonly StagedChunkInput[];
  }): Promise<{ chunks: readonly StagedChunk[]; obsoleteChunkIds: readonly string[] }> {
    if (!Array.isArray(input.chunks) || input.chunks.length < 1 || input.chunks.length > MAX_STAGED_CHUNKS) {
      throw new IngestionStoreError("INVALID_INPUT", `chunks must contain between 1 and ${MAX_STAGED_CHUNKS} rows`);
    }
    const generation = positiveGeneration(input.generation);
    return this.ledger.withImmediateTransaction((tx) => {
      this.assertLeaseTx(tx, input.accountId, input.sourceId, generation, input.leaseToken);
      const source = sourceRowInTransaction(tx, input.accountId, input.sourceId);
      if (!source) throw new IngestionStoreError("INGESTION_SUPERSEDED", "source ingestion superseded");
      const existing = tx.all<StagingRow>(
        `SELECT chunk_id, source_id, account_id, generation, seq, source_name, content, meta
         FROM ingestion_chunk_staging WHERE source_id=? AND generation=? ORDER BY seq`,
        [input.sourceId, generation]
      );
      const bySequence = new Map(existing.map((row) => [decodeSafeInteger(row.seq, "seq"), row]));
      for (let seq = 0; seq < input.chunks.length; seq += 1) {
        const chunk = input.chunks[seq];
        if (!chunk || typeof chunk.content !== "string" || !chunk.content) {
          throw new IngestionStoreError("INVALID_INPUT", "staged chunk content must not be empty");
        }
        const chunkId = bySequence.get(seq)?.chunk_id ?? randomUUID();
        tx.run(
          `INSERT INTO ingestion_chunk_staging
             (chunk_id, source_id, generation, seq, account_id, source_name, content, meta)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(source_id,generation,seq) DO UPDATE SET
             account_id=excluded.account_id,
             source_name=excluded.source_name,
             content=excluded.content,
             meta=excluded.meta`,
          [
            chunkId,
            input.sourceId,
            generation,
            seq,
            input.accountId,
            input.sourceName,
            chunk.content,
            encodeJson(chunk.meta, "chunk meta"),
          ]
        );
      }
      const obsoleteChunkIds = existing
        .filter((row) => decodeSafeInteger(row.seq, "seq") >= input.chunks.length)
        .map((row) => row.chunk_id);
      tx.run("DELETE FROM ingestion_chunk_staging WHERE source_id=? AND generation=? AND seq>=?", [
        input.sourceId,
        generation,
        input.chunks.length,
      ]);
      const rows = tx.all<StagingRow>(
        `SELECT chunk_id, source_id, account_id, generation, seq, source_name, content, meta
         FROM ingestion_chunk_staging WHERE source_id=? AND generation=? ORDER BY seq`,
        [input.sourceId, generation]
      );
      return Object.freeze({
        chunks: Object.freeze(rows.map(stagingFromRow)),
        obsoleteChunkIds: Object.freeze(obsoleteChunkIds),
      });
    });
  }

  async promoteGeneration(input: PromoteGenerationInput): Promise<{ readonly chunkCount: number }> {
    const generation = positiveGeneration(input.generation);
    const sizeBytes = nonNegativeInteger(input.sizeBytes, "sizeBytes");
    return this.ledger.withImmediateTransaction(async (tx) => {
      this.assertLeaseTx(tx, input.accountId, input.sourceId, generation, input.leaseToken);
      const source = sourceRowInTransaction(tx, input.accountId, input.sourceId);
      if (!source) throw new IngestionStoreError("INGESTION_SUPERSEDED", "source ingestion superseded");
      // Defense in depth for every caller: a durable cleanup owner prevents
      // the exact location from becoming authoritative at promotion time.
      if (
        input.promotedFilePath &&
        tx.get(
          `SELECT 1 FROM dataset_cache_cleanup_jobs
           WHERE account_id=? AND name=? AND location=?`,
          [input.accountId, source.name, input.promotedFilePath]
        )
      ) {
        throw new IngestionStoreError("INGESTION_SUPERSEDED", "source artifact is reserved for cleanup");
      }
      const staged = tx.all<StagingRow>(
        `SELECT chunk_id, source_id, account_id, generation, seq, source_name, content, meta
         FROM ingestion_chunk_staging WHERE source_id=? AND generation=? ORDER BY seq`,
        [input.sourceId, generation]
      );
      if (!staged.length) throw new IngestionStoreError("INGESTION_EMPTY", "ingestion has no staged chunks");
      if (!(await input.verifyVectors(Object.freeze(staged.map((row) => row.chunk_id))))) {
        throw new IngestionStoreError("VECTOR_INCOMPLETE", "ingestion vectors are incomplete");
      }
      tx.run("DELETE FROM chunks WHERE source_id=? AND account_id=?", [input.sourceId, input.accountId]);
      tx.run(
        `INSERT INTO chunks (id, account_id, source_id, generation, seq, source_name, content, meta)
         SELECT chunk_id, account_id, source_id, generation, seq, source_name, content, meta
         FROM ingestion_chunk_staging WHERE source_id=? AND generation=? ORDER BY seq`,
        [input.sourceId, generation]
      );
      tx.run("DELETE FROM ingestion_chunk_staging WHERE source_id=? AND generation=?", [input.sourceId, generation]);
      const currentMeta = decodeJson<Record<string, unknown>>(source.meta, "source meta");
      const cleanedMeta = { ...currentMeta };
      for (const key of [
        "error",
        "error_code",
        "error_detail",
        "error_stage",
        "connector_refresh_version",
        "connector_candidate_location",
        "connector_activation_previous_location",
      ]) {
        delete cleanedMeta[key];
      }
      const cleanupLocation = currentMeta.connector_previous_location;
      const promotedFilePath = input.promotedFilePath ?? source.file_path;
      if (
        source.connector &&
        typeof cleanupLocation === "string" &&
        cleanupLocation &&
        cleanupLocation !== promotedFilePath
      ) {
        enqueueDatasetCleanupTx(tx, input.accountId, source.name, cleanupLocation, nowIso());
      }
      tx.run(
        `UPDATE sources SET status='ready', ready_generation=?, size_bytes=?,
             file_path=COALESCE(?,file_path), meta=?
         WHERE id=? AND account_id=?`,
        [
          generation,
          sizeBytes,
          input.promotedFilePath ?? null,
          encodeJson(cleanedMeta, "source meta"),
          input.sourceId,
          input.accountId,
        ]
      );
      if (source.connector) {
        tx.run(
          `UPDATE connectors SET sync_status='idle', sync_error=NULL, last_sync=?
           WHERE id=? AND account_id=?`,
          [nowIso(), source.connector, input.accountId]
        );
      }
      const completed = tx.run(
        `UPDATE ingestion_jobs SET status='done', leased_at=NULL, lease_token=NULL, last_error=NULL, updated_at=?
         WHERE source_id=? AND account_id=? AND generation=? AND status='running' AND lease_token=?`,
        [nowIso(), input.sourceId, input.accountId, generation, input.leaseToken]
      );
      if (completed.changes !== 1) {
        throw new IngestionStoreError("INGESTION_SUPERSEDED", "source ingestion superseded");
      }
      this.enqueueVectorOperationTx(
        tx,
        input.accountId,
        input.sourceId,
        "prune_except_generation",
        generation,
        nowIso()
      );
      return Object.freeze({ chunkCount: staged.length });
    });
  }

  async failGeneration(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken?: string;
    errorCode: string;
    failure?: Readonly<{ summary: string; detail: string; stage: string }>;
    terminal?: boolean;
    retryAt?: Date;
  }): Promise<boolean> {
    const generation = positiveGeneration(input.generation);
    return this.ledger.withImmediateTransaction((tx) => {
      const job = tx.get<{ generation: bigint; status: IngestionJobStatus; lease_token: string | null }>(
        `SELECT generation, status, lease_token FROM ingestion_jobs WHERE source_id=? AND account_id=?`,
        [input.sourceId, input.accountId]
      );
      const owned =
        job !== undefined &&
        decodeSafeInteger(job.generation, "generation") === generation &&
        (!input.leaseToken || job.lease_token === input.leaseToken);
      if (owned) {
        const timestamp = nowIso();
        tx.run(
          `UPDATE ingestion_jobs SET status=?, leased_at=NULL, lease_token=NULL, last_error=?,
             available_at=?, updated_at=? WHERE source_id=? AND account_id=? AND generation=?`,
          [
            input.terminal === false ? "pending" : "error",
            input.errorCode.slice(0, 256),
            input.retryAt ? encodeIsoTimestamp(input.retryAt, "retryAt") : timestamp,
            timestamp,
            input.sourceId,
            input.accountId,
            generation,
          ]
        );
        const source = sourceRowInTransaction(tx, input.accountId, input.sourceId);
        if (source) {
          const hasLiveChunks = Boolean(
            tx.get("SELECT 1 FROM chunks WHERE source_id=? AND account_id=? LIMIT 1", [input.sourceId, input.accountId])
          );
          const terminal = input.terminal !== false;
          const nextStatus = hasLiveChunks ? "ready" : terminal ? "error" : "index";
          const meta = decodeJson<Record<string, unknown>>(source.meta, "source meta");
          for (const key of ["error", "error_code", "error_detail", "error_stage"]) delete meta[key];
          if (terminal && input.failure && !hasLiveChunks) {
            meta.error = input.failure.summary;
            meta.error_code = input.errorCode.slice(0, 256);
            meta.error_detail = input.failure.detail;
            meta.error_stage = input.failure.stage;
          }
          tx.run("UPDATE sources SET status=?,meta=? WHERE id=? AND account_id=?", [
            nextStatus,
            encodeJson(meta, "source meta"),
            input.sourceId,
            input.accountId,
          ]);
          if (source.connector) {
            tx.run("UPDATE connectors SET sync_status=?,sync_error=? WHERE id=? AND account_id=?", [
              terminal ? "error" : "indexing",
              terminal ? "Connector indexing failed." : null,
              source.connector,
              input.accountId,
            ]);
          }
        }
      }
      if (owned && input.terminal === false) return true;
      tx.run("DELETE FROM ingestion_chunk_staging WHERE source_id=? AND generation=?", [input.sourceId, generation]);
      this.enqueueVectorOperationTx(tx, input.accountId, input.sourceId, "delete_generation", generation, nowIso());
      return owned;
    });
  }

  async listPendingVectorOperations(limit = 100): Promise<readonly PendingVectorOperation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new IngestionStoreError("INVALID_INPUT", "pending vector operation limit is invalid");
    }
    const rows = await this.ledger.all<{
      source_id: string;
      account_id: string;
      operation: PendingVectorOperation["operation"];
      generation: bigint;
      attempts: bigint;
    }>(
      `SELECT source_id, account_id, operation, generation, attempts
       FROM pending_vector_ops ORDER BY updated_at, source_id, operation, generation LIMIT ?`,
      [limit]
    );
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          sourceId: row.source_id,
          accountId: row.account_id,
          operation: row.operation,
          generation: decodeSafeInteger(row.generation, "generation"),
          attempts: decodeSafeInteger(row.attempts, "attempts"),
        })
      )
    );
  }

  async resolveVectorOperation(operation: PendingVectorOperation, outcome: "complete" | "failed"): Promise<void> {
    if (outcome === "complete") {
      await this.ledger.run(
        `DELETE FROM pending_vector_ops
         WHERE source_id=? AND account_id=? AND operation=? AND generation=?`,
        [operation.sourceId, operation.accountId, operation.operation, operation.generation]
      );
      return;
    }
    await this.ledger.run(
      `UPDATE pending_vector_ops SET attempts=attempts+1, last_error='VECTOR_OPERATION_FAILED', updated_at=?
       WHERE source_id=? AND account_id=? AND operation=? AND generation=?`,
      [nowIso(), operation.sourceId, operation.accountId, operation.operation, operation.generation]
    );
  }

  async vectorOperationKeepGenerations(operation: PendingVectorOperation): Promise<readonly number[] | null> {
    const state = await this.ledger.get<{
      ready_generation: bigint | null;
      job_generation: bigint | null;
      job_status: IngestionJobStatus | null;
    }>(
      `SELECT s.ready_generation,
              j.generation AS job_generation,
              j.status AS job_status
       FROM sources s
       LEFT JOIN ingestion_jobs j ON j.source_id=s.id AND j.account_id=s.account_id
       WHERE s.id=? AND s.account_id=?`,
      [operation.sourceId, operation.accountId]
    );
    if (!state) return null;
    const ready =
      state.ready_generation === null ? null : decodeSafeInteger(state.ready_generation, "ready_generation");
    const inProgress =
      state.job_generation !== null && ["preparing", "pending", "running"].includes(state.job_status ?? "")
        ? decodeSafeInteger(state.job_generation, "generation")
        : null;
    if (operation.operation === "delete_generation") {
      if (ready === operation.generation || inProgress === operation.generation) return Object.freeze([]);
      return Object.freeze([operation.generation]);
    }
    if (ready !== operation.generation) return Object.freeze([]);
    return Object.freeze([...new Set([ready, inProgress].filter((value): value is number => value !== null))]);
  }

  async vectorRepairState(): Promise<VectorRepairLedgerState> {
    const sourceRows = await this.ledger.all<{
      id: string;
      account_id: string;
      ready_generation: bigint | null;
      job_generation: bigint | null;
      job_status: IngestionJobStatus | null;
    }>(
      `SELECT s.id, s.account_id, s.ready_generation,
              j.generation AS job_generation, j.status AS job_status
       FROM sources s LEFT JOIN ingestion_jobs j ON j.source_id=s.id AND j.account_id=s.account_id`
    );
    const sources = new Map<
      string,
      { accountId: string; readyGeneration: number | null; inProgressGenerations: ReadonlySet<number> }
    >();
    for (const row of sourceRows) {
      const inProgress = new Set<number>();
      if (row.job_generation !== null && ["preparing", "pending", "running"].includes(row.job_status ?? "")) {
        inProgress.add(decodeSafeInteger(row.job_generation, "generation"));
      }
      sources.set(
        row.id,
        Object.freeze({
          accountId: row.account_id,
          readyGeneration:
            row.ready_generation === null ? null : decodeSafeInteger(row.ready_generation, "ready_generation"),
          inProgressGenerations: inProgress,
        })
      );
    }
    const validChunkIds = new Set<string>();
    for (const table of ["chunks", "ingestion_chunk_staging"] as const) {
      const idColumn = table === "chunks" ? "id" : "chunk_id";
      const rows = await this.ledger.all<{ chunk_id: string }>(`SELECT ${idColumn} AS chunk_id FROM ${table}`);
      rows.forEach((row) => validChunkIds.add(row.chunk_id));
    }
    return Object.freeze({ sources, validChunkIds });
  }

  async loadPassages(input: {
    accountId: string;
    sourceIds: readonly string[];
    chunkIds: readonly string[];
  }): Promise<ReadonlyMap<string, Readonly<{ sourceId: string; source: string; content: string }>>> {
    if (!input.sourceIds.length || !input.chunkIds.length) return new Map();
    if (input.sourceIds.length > 100 || input.chunkIds.length > MAX_LOOKUP_IDS) {
      throw new IngestionStoreError("INVALID_INPUT", "passage lookup exceeds its bounded scope");
    }
    const sourceIds = [...new Set(input.sourceIds)];
    const allowedSources = new Set(sourceIds);
    const result = new Map<string, Readonly<{ sourceId: string; source: string; content: string }>>();
    for (const chunkBatch of batches([...new Set(input.chunkIds)])) {
      const rows = await this.ledger.all<{
        chunk_id: string;
        source_id: string;
        source: string;
        content: string;
      }>(
        `SELECT c.id AS chunk_id, c.source_id,
                COALESCE(NULLIF(s.display_name,''),c.source_name,'Source') AS source,
                c.content
         FROM chunks c
         JOIN sources s ON s.id=c.source_id AND s.account_id=c.account_id
         WHERE c.account_id=?
           AND c.source_id IN (${placeholders(sourceIds.length)})
           AND c.id IN (${placeholders(chunkBatch.length)})`,
        [input.accountId, ...sourceIds, ...chunkBatch]
      );
      for (const row of rows) {
        if (!allowedSources.has(row.source_id) || !row.content) continue;
        result.set(
          row.chunk_id,
          Object.freeze({ sourceId: row.source_id, source: row.source || "Source", content: row.content })
        );
      }
    }
    return result;
  }

  async readyGenerationScopes(
    accountId: string,
    sourceIds: readonly string[]
  ): Promise<readonly Readonly<{ sourceId: string; generation: number }>[]> {
    const normalized = [...new Set(sourceIds)];
    if (!normalized.length) return Object.freeze([]);
    if (normalized.length > 100) {
      throw new IngestionStoreError("INVALID_INPUT", "ready source scope exceeds 100 sources");
    }
    const rows = await this.ledger.all<{ id: string; ready_generation: bigint }>(
      `SELECT id, ready_generation FROM sources
       WHERE account_id=? AND status='ready' AND ready_generation IS NOT NULL
         AND id IN (${placeholders(normalized.length)})`,
      [accountId, ...normalized]
    );
    const byId = new Map(rows.map((row) => [row.id, decodeSafeInteger(row.ready_generation, "ready_generation")]));
    return Object.freeze(
      normalized.flatMap((sourceId) => {
        const generation = byId.get(sourceId);
        return generation === undefined ? [] : [Object.freeze({ sourceId, generation })];
      })
    );
  }

  private assertLeaseTx(
    tx: SqliteTransaction,
    accountId: string,
    sourceId: string,
    generation: number,
    leaseToken: string
  ): void {
    const row = tx.get<{ ok: bigint }>(
      `SELECT 1 AS ok FROM ingestion_jobs
       WHERE source_id=? AND account_id=? AND generation=? AND status='running' AND lease_token=?`,
      [sourceId, accountId, generation, leaseToken]
    );
    if (!row) throw new IngestionStoreError("INGESTION_SUPERSEDED", "source ingestion superseded");
  }

  private enqueueVectorOperationTx(
    tx: SqliteTransaction,
    accountId: string,
    sourceId: string,
    operation: PendingVectorOperation["operation"],
    generation: number,
    timestamp: string
  ): void {
    tx.run(
      `INSERT INTO pending_vector_ops
         (source_id, account_id, operation, generation, attempts, last_error, created_at, updated_at)
       VALUES (?,?,?,?,0,NULL,?,?)
       ON CONFLICT(source_id,operation,generation) DO UPDATE SET
         account_id=excluded.account_id, updated_at=excluded.updated_at`,
      [sourceId, accountId, operation, generation, timestamp, timestamp]
    );
  }
}
