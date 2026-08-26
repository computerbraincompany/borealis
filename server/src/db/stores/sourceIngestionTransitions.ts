import {
  decodeBoolean,
  decodeIsoTimestamp,
  decodeJson,
  decodeSafeInteger,
  encodeIsoTimestamp,
  encodeJson,
} from "../codecs.js";
import { SqliteCodecError, type SqliteLedger, type SqliteTransaction } from "../types.js";
import type { ConnectorRecord, ConnectorType, SourceRecord } from "./sourceStore.js";

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 32_768;
const MAX_URL_LENGTH = 2_000;
const MAX_DISPLAY_NAME_LENGTH = 180;
const MAX_SOURCE_SUMMARIES = 1_000;
const MAX_NAME_ATTEMPTS = 10_000;

const SOURCE_COLUMNS = `
  id, account_id, name, kind, connector, display_name, file_path, url, mime,
  size_bytes, status, meta, ready_generation, created_at
`;
const CONNECTOR_COLUMNS = `
  id, account_id, name, type, config, target_table, last_sync, sync_status,
  sync_error, created_at
`;

export interface IngestionSummary {
  readonly sourceId: string;
  readonly attempts: number;
  readonly updatedAt: string;
}

export interface ReservedSourceIngestion {
  readonly source: SourceRecord;
  readonly generation: number;
}

export interface ReservedConnectorPrepare extends ReservedSourceIngestion {
  readonly connector: ConnectorRecord;
  readonly refreshVersion: string;
  readonly leaseToken: string;
}

export interface CreateUploadSourceInput {
  readonly id: string;
  readonly baseName: string;
  readonly kind: string;
  readonly displayName: string;
  readonly filePath: string;
  readonly mime: string;
  readonly sizeBytes: number;
}

export interface CreateConnectorPrepareInput {
  readonly connectorId: string;
  readonly sourceId: string;
  readonly displayName: string;
  readonly targetTable: string;
  readonly type: ConnectorType;
  readonly url: string;
  readonly refreshVersion: string;
  readonly leaseToken: string;
}

export interface BeginConnectorRefreshInput {
  readonly accountId: string;
  readonly connectorId: string;
  readonly refreshVersion: string;
  readonly leaseToken: string;
}

export interface ActivatePreparedConnectorInput {
  readonly accountId: string;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly refreshVersion: string;
  readonly url: string;
  readonly displayName: string;
  readonly mime: string;
  readonly candidateLocation: string;
  readonly activationPreviousLocation: string | null;
  readonly cleanupPreviousLocation: string | null;
}

export interface FailConnectorPrepareInput {
  readonly accountId: string;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly errorCode: string;
}

export type SourceIngestionTransitionErrorCode =
  | "SOURCE_TRANSITION_INVALID_ARGUMENT"
  | "SOURCE_TRANSITION_ACCOUNT_NOT_FOUND"
  | "SOURCE_TRANSITION_SOURCE_NOT_FOUND"
  | "SOURCE_TRANSITION_SOURCE_NO_FILE"
  | "SOURCE_TRANSITION_CONNECTOR_NOT_FOUND"
  | "SOURCE_TRANSITION_SOURCE_ID_CONFLICT"
  | "SOURCE_TRANSITION_CONNECTOR_ID_CONFLICT"
  | "SOURCE_TRANSITION_TARGET_CONFLICT"
  | "SOURCE_TRANSITION_SOURCE_IN_USE"
  | "SOURCE_TRANSITION_CONNECTOR_SYNC_ACTIVE"
  | "SOURCE_TRANSITION_CONNECTOR_SOURCE_MISSING"
  | "SOURCE_TRANSITION_CONNECTOR_SOURCE_CONFLICT"
  | "SOURCE_TRANSITION_PREPARE_SUPERSEDED";

export class SourceIngestionTransitionError extends Error {
  constructor(
    readonly code: SourceIngestionTransitionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SourceIngestionTransitionError";
  }
}

interface SourceRow {
  id: unknown;
  account_id: unknown;
  name: unknown;
  kind: unknown;
  connector: unknown;
  display_name: unknown;
  file_path: unknown;
  url: unknown;
  mime: unknown;
  size_bytes: unknown;
  status: unknown;
  meta: unknown;
  ready_generation: unknown;
  created_at: unknown;
}

interface ConnectorRow {
  id: unknown;
  account_id: unknown;
  name: unknown;
  type: unknown;
  config: unknown;
  target_table: unknown;
  last_sync: unknown;
  sync_status: unknown;
  sync_error: unknown;
  created_at: unknown;
}

export interface SourceIngestionTransitionOptions {
  readonly now?: () => Date;
}

/** Cross-domain source/job transitions. No external I/O is allowed in this class. */
export class SourceIngestionTransitions {
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: SourceIngestionTransitionOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async createUploadSource(accountIdInput: string, input: CreateUploadSourceInput): Promise<ReservedSourceIngestion> {
    const accountId = requiredId(accountIdInput, "accountId");
    const id = requiredId(input.id, "source id");
    const baseName = tableName(input.baseName, "source base name");
    const kind = requiredText(input.kind, "source kind", 32);
    const displayName = requiredText(input.displayName, "display name", MAX_DISPLAY_NAME_LENGTH);
    const filePath = requiredText(input.filePath, "file path", MAX_PATH_LENGTH);
    const mime = requiredText(input.mime, "MIME type", 256);
    const sizeBytes = nonNegativeInteger(input.sizeBytes, "sizeBytes");
    return this.ledger.withImmediateTransaction((transaction) => {
      ensureAccount(transaction, accountId);
      ensureSourceIdAvailable(transaction, id);
      const name = allocateSourceName(transaction, accountId, baseName);
      transaction.run(
        `INSERT INTO sources
           (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta)
         VALUES (?,?,?,?,?,?,?,?, 'index',?)`,
        [id, accountId, name, kind, displayName, filePath, mime, sizeBytes, encodeJson({}, "source meta")]
      );
      const generation = reserveGeneration(transaction, {
        accountId,
        sourceId: id,
        readyGeneration: null,
        status: "pending",
        attempts: 0,
        leaseToken: null,
        leasedAt: null,
        timestamp: this.timestamp(),
      });
      return Object.freeze({ source: requiredSource(transaction, accountId, id), generation });
    });
  }

  async reserveSourceReingest(accountIdInput: string, sourceIdInput: string): Promise<ReservedSourceIngestion> {
    const accountId = requiredId(accountIdInput, "accountId");
    const sourceId = requiredId(sourceIdInput, "sourceId");
    return this.ledger.withImmediateTransaction((transaction) => {
      const source = requiredSource(transaction, accountId, sourceId);
      if (!source.filePath) {
        throw new SourceIngestionTransitionError("SOURCE_TRANSITION_SOURCE_NO_FILE", "source has no uploaded file");
      }
      assertSourceNotInActiveRun(transaction, accountId, sourceId);
      if (source.connectorId) assertConnectorIdle(transaction, accountId, source.connectorId);
      const meta = objectMeta(source.meta);
      removeKeys(meta, ["error", "error_code", "error_detail", "error_stage"]);
      transaction.run(`UPDATE sources SET status='index',meta=? WHERE account_id=? AND id=?`, [
        encodeJson(meta, "source meta"),
        accountId,
        sourceId,
      ]);
      const generation = reserveGeneration(transaction, {
        accountId,
        sourceId,
        readyGeneration: source.readyGeneration,
        status: "pending",
        attempts: 0,
        leaseToken: null,
        leasedAt: null,
        timestamp: this.timestamp(),
      });
      return Object.freeze({ source: requiredSource(transaction, accountId, sourceId), generation });
    });
  }

  async createConnectorPrepare(
    accountIdInput: string,
    input: CreateConnectorPrepareInput
  ): Promise<ReservedConnectorPrepare> {
    const accountId = requiredId(accountIdInput, "accountId");
    const connectorId = requiredId(input.connectorId, "connector id");
    const sourceId = requiredId(input.sourceId, "source id");
    const displayName = requiredText(input.displayName, "display name", 120);
    const targetTable = tableName(input.targetTable, "target table");
    const type = connectorType(input.type);
    const url = requiredText(input.url, "connector URL", MAX_URL_LENGTH);
    const refreshVersion = requiredId(input.refreshVersion, "refresh version");
    const leaseToken = requiredId(input.leaseToken, "prepare lease token");
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      ensureAccount(transaction, accountId);
      ensureConnectorIdAvailable(transaction, connectorId);
      ensureSourceIdAvailable(transaction, sourceId);
      ensureTargetAvailable(transaction, accountId, targetTable);
      transaction.run(
        `INSERT INTO connectors
           (id,account_id,name,type,config,target_table,sync_status,sync_error)
         VALUES (?,?,?,?,?,?,'syncing',NULL)`,
        [connectorId, accountId, displayName, type, encodeJson({ url }, "connector config"), targetTable]
      );
      transaction.run(
        `INSERT INTO sources
           (id,account_id,name,kind,connector,display_name,url,mime,status,meta)
         VALUES (?,?,?,'tabular',?,?,?,?,'index',?)`,
        [
          sourceId,
          accountId,
          targetTable,
          connectorId,
          displayName,
          url,
          type === "url_json" ? "application/json" : "text/csv",
          encodeJson({ connector_refresh_version: refreshVersion }, "source meta"),
        ]
      );
      const generation = reserveGeneration(transaction, {
        accountId,
        sourceId,
        readyGeneration: null,
        status: "preparing",
        attempts: 1,
        leaseToken,
        leasedAt: timestamp,
        timestamp,
      });
      return Object.freeze({
        connector: requiredConnector(transaction, accountId, connectorId),
        source: requiredSource(transaction, accountId, sourceId),
        generation,
        refreshVersion,
        leaseToken,
      });
    });
  }

  async beginConnectorRefresh(input: BeginConnectorRefreshInput): Promise<ReservedConnectorPrepare> {
    const accountId = requiredId(input.accountId, "accountId");
    const connectorId = requiredId(input.connectorId, "connector id");
    const refreshVersion = requiredId(input.refreshVersion, "refresh version");
    const leaseToken = requiredId(input.leaseToken, "prepare lease token");
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      const connector = requiredConnector(transaction, accountId, connectorId);
      if (connector.syncStatus === "syncing" || connector.syncStatus === "indexing") {
        throw new SourceIngestionTransitionError("SOURCE_TRANSITION_CONNECTOR_SYNC_ACTIVE", "connector sync is active");
      }
      const sources = connectorSources(transaction, accountId, connectorId);
      if (sources.length === 0) {
        throw new SourceIngestionTransitionError(
          "SOURCE_TRANSITION_CONNECTOR_SOURCE_MISSING",
          "connector source reservation missing"
        );
      }
      if (sources.length !== 1) {
        throw new SourceIngestionTransitionError(
          "SOURCE_TRANSITION_CONNECTOR_SOURCE_CONFLICT",
          "connector owns more than one source"
        );
      }
      const source = sources[0];
      assertSourceNotInActiveRun(transaction, accountId, source.id);
      const meta = objectMeta(source.meta);
      removeKeys(meta, [
        "error",
        "error_code",
        "error_detail",
        "error_stage",
        "connector_previous_location",
        "connector_candidate_location",
        "connector_activation_previous_location",
      ]);
      meta.connector_refresh_version = refreshVersion;
      transaction.run(`UPDATE sources SET status='index',meta=? WHERE account_id=? AND id=?`, [
        encodeJson(meta, "source meta"),
        accountId,
        source.id,
      ]);
      transaction.run(`UPDATE connectors SET sync_status='syncing',sync_error=NULL WHERE account_id=? AND id=?`, [
        accountId,
        connectorId,
      ]);
      const generation = reserveGeneration(transaction, {
        accountId,
        sourceId: source.id,
        readyGeneration: source.readyGeneration,
        status: "preparing",
        attempts: 1,
        leaseToken,
        leasedAt: timestamp,
        timestamp,
      });
      return Object.freeze({
        connector: requiredConnector(transaction, accountId, connectorId),
        source: requiredSource(transaction, accountId, source.id),
        generation,
        refreshVersion,
        leaseToken,
      });
    });
  }

  async activatePreparedConnector(input: ActivatePreparedConnectorInput): Promise<ReservedConnectorPrepare> {
    const values = preparedInput(input);
    return this.ledger.withImmediateTransaction((transaction) => {
      const job = transaction.get<{ generation: unknown }>(
        `SELECT generation FROM ingestion_jobs
         WHERE account_id=? AND source_id=? AND generation=? AND status='preparing' AND lease_token=?`,
        [values.accountId, values.sourceId, values.generation, values.leaseToken]
      );
      const source = findSource(transaction, values.accountId, values.sourceId);
      const connector = findConnector(transaction, values.accountId, values.connectorId);
      const sourceMeta = source ? objectMeta(source.meta) : undefined;
      if (
        !job ||
        !source ||
        source.connectorId !== values.connectorId ||
        sourceMeta?.connector_refresh_version !== values.refreshVersion ||
        !connector ||
        connector.syncStatus !== "syncing"
      ) {
        prepareSuperseded();
      }
      removeKeys(sourceMeta, [
        "error",
        "error_code",
        "error_detail",
        "error_stage",
        "connector_previous_location",
        "connector_candidate_location",
        "connector_activation_previous_location",
      ]);
      sourceMeta.connector_refresh_version = values.refreshVersion;
      sourceMeta.connector_candidate_location = values.candidateLocation;
      sourceMeta.connector_activation_previous_location = values.activationPreviousLocation;
      if (values.cleanupPreviousLocation) {
        sourceMeta.connector_previous_location = values.cleanupPreviousLocation;
      }
      const timestamp = this.timestamp();
      const jobChanged = transaction.run(
        `UPDATE ingestion_jobs
         SET status='pending',available_at=?,leased_at=NULL,lease_token=NULL,last_error=NULL,updated_at=?
         WHERE account_id=? AND source_id=? AND generation=? AND status='preparing' AND lease_token=?`,
        [timestamp, timestamp, values.accountId, values.sourceId, values.generation, values.leaseToken]
      );
      const sourceChanged = transaction.run(
        `UPDATE sources SET url=?,display_name=?,mime=?,status='index',meta=?
         WHERE account_id=? AND id=? AND connector=?`,
        [
          values.url,
          values.displayName,
          values.mime,
          encodeJson(sourceMeta, "source meta"),
          values.accountId,
          values.sourceId,
          values.connectorId,
        ]
      );
      const connectorChanged = transaction.run(
        `UPDATE connectors SET sync_status='indexing',sync_error=NULL
         WHERE account_id=? AND id=? AND sync_status='syncing'`,
        [values.accountId, values.connectorId]
      );
      if (jobChanged.changes !== 1 || sourceChanged.changes !== 1 || connectorChanged.changes !== 1) {
        prepareSuperseded();
      }
      return Object.freeze({
        connector: requiredConnector(transaction, values.accountId, values.connectorId),
        source: requiredSource(transaction, values.accountId, values.sourceId),
        generation: values.generation,
        refreshVersion: values.refreshVersion,
        leaseToken: values.leaseToken,
      });
    });
  }

  async deferConnectorPrepare(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken: string;
    retryDelayMs?: number;
  }): Promise<boolean> {
    const accountId = requiredId(input.accountId, "accountId");
    const sourceId = requiredId(input.sourceId, "sourceId");
    const leaseToken = requiredId(input.leaseToken, "leaseToken");
    const generation = positiveInteger(input.generation, "generation");
    const delay = input.retryDelayMs ?? 2_000;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60_000) invalid("retryDelayMs is invalid");
    const now = this.now();
    const availableAt = encodeIsoTimestamp(new Date(now.getTime() + delay), "retry time");
    const changed = await this.ledger.run(
      `UPDATE ingestion_jobs
       SET available_at=?,leased_at=NULL,lease_token=NULL,last_error='PREPARE_TRANSIENT',updated_at=?
       WHERE account_id=? AND source_id=? AND generation=? AND status='preparing' AND lease_token=?`,
      [availableAt, encodeIsoTimestamp(now, "now"), accountId, sourceId, generation, leaseToken]
    );
    return changed.changes === 1;
  }

  async failConnectorPrepare(input: FailConnectorPrepareInput): Promise<boolean> {
    const accountId = requiredId(input.accountId, "accountId");
    const connectorId = requiredId(input.connectorId, "connector id");
    const sourceId = requiredId(input.sourceId, "source id");
    const generation = positiveInteger(input.generation, "generation");
    const leaseToken = requiredId(input.leaseToken, "lease token");
    const errorCode = requiredText(input.errorCode, "prepare error code", 256);
    return this.ledger.withImmediateTransaction((transaction) => {
      const owned = transaction.get(
        `SELECT 1 FROM ingestion_jobs
         WHERE account_id=? AND source_id=? AND generation=? AND status='preparing' AND lease_token=?`,
        [accountId, sourceId, generation, leaseToken]
      );
      if (!owned) return false;
      const source = findSource(transaction, accountId, sourceId);
      const connector = findConnector(transaction, accountId, connectorId);
      if (!source || source.connectorId !== connectorId || !connector || connector.syncStatus !== "syncing") {
        return false;
      }

      const hasLiveGeneration =
        source.filePath !== null &&
        Boolean(
          transaction.get(`SELECT 1 FROM chunks WHERE account_id=? AND source_id=? LIMIT 1`, [accountId, sourceId])
        );
      const meta = objectMeta(source.meta);
      removeKeys(meta, [
        "error",
        "error_code",
        "error_detail",
        "error_stage",
        "connector_refresh_version",
        "connector_previous_location",
        "connector_candidate_location",
        "connector_activation_previous_location",
      ]);
      if (!hasLiveGeneration) meta.error_code = errorCode;

      const timestamp = this.timestamp();
      const jobChanged = transaction.run(
        `UPDATE ingestion_jobs
         SET status='error',leased_at=NULL,lease_token=NULL,last_error=?,updated_at=?
         WHERE account_id=? AND source_id=? AND generation=? AND status='preparing' AND lease_token=?`,
        [errorCode, timestamp, accountId, sourceId, generation, leaseToken]
      );
      const sourceChanged = transaction.run(
        `UPDATE sources SET status=?,meta=? WHERE account_id=? AND id=? AND connector=?`,
        [hasLiveGeneration ? "ready" : "error", encodeJson(meta, "source meta"), accountId, sourceId, connectorId]
      );
      const connectorChanged = transaction.run(
        `UPDATE connectors SET sync_status='error',sync_error='Connector sync failed.'
         WHERE account_id=? AND id=? AND sync_status='syncing'`,
        [accountId, connectorId]
      );
      if (jobChanged.changes !== 1 || sourceChanged.changes !== 1 || connectorChanged.changes !== 1) {
        throw new Error("connector prepare failure lost transaction ownership");
      }
      transaction.run(`DELETE FROM ingestion_chunk_staging WHERE source_id=? AND generation=?`, [sourceId, generation]);
      if (generation !== source.readyGeneration) {
        enqueueDeleteGeneration(transaction, accountId, sourceId, generation, timestamp);
      }
      return true;
    });
  }

  async ingestionSummaries(
    accountIdInput: string,
    sourceIdsInput: readonly string[]
  ): Promise<ReadonlyMap<string, IngestionSummary>> {
    const accountId = requiredId(accountIdInput, "accountId");
    if (!Array.isArray(sourceIdsInput) || sourceIdsInput.length > MAX_SOURCE_SUMMARIES) {
      invalid(`sourceIds must contain at most ${MAX_SOURCE_SUMMARIES} entries`);
    }
    const sourceIds = [...new Set(sourceIdsInput.map((sourceId) => requiredId(sourceId, "source id")))];
    if (sourceIds.length === 0) return new Map();
    const rows = await this.ledger.all<{ source_id: unknown; attempts: unknown; updated_at: unknown }>(
      `SELECT source_id,attempts,updated_at FROM ingestion_jobs
       WHERE account_id=? AND source_id IN (${placeholders(sourceIds.length)})`,
      [accountId, ...sourceIds]
    );
    return new Map(
      rows.map((row) => {
        const sourceId = storedText(row.source_id, "ingestion source id");
        return [
          sourceId,
          Object.freeze({
            sourceId,
            attempts: decodeSafeInteger(row.attempts, "ingestion attempts"),
            updatedAt: decodeIsoTimestamp(row.updated_at, "ingestion updated_at"),
          }),
        ];
      })
    );
  }

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "now");
  }
}

function reserveGeneration(
  transaction: SqliteTransaction,
  input: {
    accountId: string;
    sourceId: string;
    readyGeneration: number | null;
    status: "pending" | "preparing";
    attempts: number;
    leaseToken: string | null;
    leasedAt: string | null;
    timestamp: string;
  }
): number {
  const prior = transaction.get<{ generation: unknown }>(
    `SELECT generation FROM ingestion_jobs WHERE account_id=? AND source_id=?`,
    [input.accountId, input.sourceId]
  );
  const priorGeneration = prior ? decodeSafeInteger(prior.generation, "ingestion generation") : undefined;
  const generation = priorGeneration === undefined ? 1 : priorGeneration + 1;
  const stale = transaction.all<{ generation: unknown }>(
    `SELECT DISTINCT generation FROM ingestion_chunk_staging WHERE source_id=? AND generation<?`,
    [input.sourceId, generation]
  );
  const cleanupGenerations = new Set(stale.map((row) => decodeSafeInteger(row.generation, "staging generation")));
  if (priorGeneration !== undefined) cleanupGenerations.add(priorGeneration);
  for (const staleGeneration of cleanupGenerations) {
    if (staleGeneration !== input.readyGeneration) {
      enqueueDeleteGeneration(transaction, input.accountId, input.sourceId, staleGeneration, input.timestamp);
    }
  }
  transaction.run(`DELETE FROM ingestion_chunk_staging WHERE source_id=? AND generation<?`, [
    input.sourceId,
    generation,
  ]);
  transaction.run(
    `INSERT INTO ingestion_jobs
       (source_id,account_id,generation,status,attempts,available_at,leased_at,lease_token,
        last_error,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,NULL,?,?)
     ON CONFLICT(source_id) DO UPDATE SET
       account_id=excluded.account_id,generation=excluded.generation,status=excluded.status,
       attempts=excluded.attempts,available_at=excluded.available_at,leased_at=excluded.leased_at,
       lease_token=excluded.lease_token,last_error=NULL,updated_at=excluded.updated_at`,
    [
      input.sourceId,
      input.accountId,
      generation,
      input.status,
      input.attempts,
      input.timestamp,
      input.leasedAt,
      input.leaseToken,
      input.timestamp,
      input.timestamp,
    ]
  );
  return generation;
}

function enqueueDeleteGeneration(
  transaction: SqliteTransaction,
  accountId: string,
  sourceId: string,
  generation: number,
  timestamp: string
): void {
  if (generation < 1) return;
  transaction.run(
    `INSERT INTO pending_vector_ops
       (source_id,account_id,operation,generation,attempts,last_error,created_at,updated_at)
     VALUES (?,?,'delete_generation',?,0,NULL,?,?)
     ON CONFLICT(source_id,operation,generation) DO UPDATE SET updated_at=excluded.updated_at`,
    [sourceId, accountId, generation, timestamp, timestamp]
  );
}

function allocateSourceName(transaction: SqliteTransaction, accountId: string, baseName: string): string {
  for (let suffix = 0; suffix < MAX_NAME_ATTEMPTS; suffix += 1) {
    const suffixText = suffix === 0 ? "" : `_${suffix}`;
    const candidate = `${baseName.slice(0, 63 - suffixText.length)}${suffixText}`;
    if (!targetExists(transaction, accountId, candidate)) return candidate;
  }
  throw new SourceIngestionTransitionError("SOURCE_TRANSITION_TARGET_CONFLICT", "no source name is available");
}

function ensureTargetAvailable(transaction: SqliteTransaction, accountId: string, targetTable: string): void {
  if (targetExists(transaction, accountId, targetTable)) {
    throw new SourceIngestionTransitionError("SOURCE_TRANSITION_TARGET_CONFLICT", "target_table is already in use");
  }
}

function targetExists(transaction: SqliteTransaction, accountId: string, name: string): boolean {
  return Boolean(
    transaction.get(
      `SELECT name FROM sources WHERE account_id=? AND name=?
       UNION ALL SELECT target_table AS name FROM connectors WHERE account_id=? AND target_table=? LIMIT 1`,
      [accountId, name, accountId, name]
    )
  );
}

function ensureAccount(transaction: SqliteTransaction, accountId: string): void {
  if (!transaction.get(`SELECT id FROM users WHERE id=?`, [accountId])) {
    throw new SourceIngestionTransitionError("SOURCE_TRANSITION_ACCOUNT_NOT_FOUND", "account not found");
  }
}

function ensureSourceIdAvailable(transaction: SqliteTransaction, sourceId: string): void {
  if (
    transaction.get(
      `SELECT id FROM sources WHERE id=?
       UNION ALL SELECT source_id AS id FROM pending_source_deletes WHERE source_id=? LIMIT 1`,
      [sourceId, sourceId]
    )
  ) {
    throw new SourceIngestionTransitionError("SOURCE_TRANSITION_SOURCE_ID_CONFLICT", "source id is in use");
  }
}

function ensureConnectorIdAvailable(transaction: SqliteTransaction, connectorId: string): void {
  if (
    transaction.get(
      `SELECT id FROM connectors WHERE id=?
       UNION ALL SELECT connector_id AS id FROM pending_source_deletes WHERE connector_id=? LIMIT 1`,
      [connectorId, connectorId]
    )
  ) {
    throw new SourceIngestionTransitionError("SOURCE_TRANSITION_CONNECTOR_ID_CONFLICT", "connector id is in use");
  }
}

function assertSourceNotInActiveRun(transaction: SqliteTransaction, accountId: string, sourceId: string): void {
  const result = transaction.get<{ referenced: unknown }>(
    `SELECT EXISTS (
       SELECT 1 FROM chat_run_sources AS snapshot
       JOIN chat_runs AS run ON run.id=snapshot.run_id AND run.account_id=snapshot.account_id
       WHERE snapshot.account_id=? AND snapshot.source_id=?
         AND run.status IN ('running','cancelling')
     ) AS referenced`,
    [accountId, sourceId]
  );
  if (decodeBoolean(result?.referenced, "active source reference")) {
    throw new SourceIngestionTransitionError("SOURCE_TRANSITION_SOURCE_IN_USE", "source is in use by an active run");
  }
}

function assertConnectorIdle(transaction: SqliteTransaction, accountId: string, connectorId: string): void {
  const connector = requiredConnector(transaction, accountId, connectorId);
  if (connector.syncStatus === "syncing" || connector.syncStatus === "indexing") {
    throw new SourceIngestionTransitionError("SOURCE_TRANSITION_CONNECTOR_SYNC_ACTIVE", "connector sync is active");
  }
}

function connectorSources(transaction: SqliteTransaction, accountId: string, connectorId: string): SourceRecord[] {
  return transaction
    .all<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE account_id=? AND connector=? ORDER BY id LIMIT 2`, [
      accountId,
      connectorId,
    ])
    .map(decodeSource);
}

function findSource(transaction: SqliteTransaction, accountId: string, sourceId: string): SourceRecord | undefined {
  const row = transaction.get<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE account_id=? AND id=?`, [
    accountId,
    sourceId,
  ]);
  return row ? decodeSource(row) : undefined;
}

function requiredSource(transaction: SqliteTransaction, accountId: string, sourceId: string): SourceRecord {
  const source = findSource(transaction, accountId, sourceId);
  if (!source) {
    throw new SourceIngestionTransitionError("SOURCE_TRANSITION_SOURCE_NOT_FOUND", "source not found");
  }
  return source;
}

function findConnector(
  transaction: SqliteTransaction,
  accountId: string,
  connectorId: string
): ConnectorRecord | undefined {
  const row = transaction.get<ConnectorRow>(`SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE account_id=? AND id=?`, [
    accountId,
    connectorId,
  ]);
  return row ? decodeConnector(row) : undefined;
}

function requiredConnector(transaction: SqliteTransaction, accountId: string, connectorId: string): ConnectorRecord {
  const connector = findConnector(transaction, accountId, connectorId);
  if (!connector) {
    throw new SourceIngestionTransitionError("SOURCE_TRANSITION_CONNECTOR_NOT_FOUND", "connector not found");
  }
  return connector;
}

function decodeSource(row: SourceRow): SourceRecord {
  return Object.freeze({
    id: storedText(row.id, "source id"),
    accountId: storedText(row.account_id, "source account id"),
    name: storedText(row.name, "source name"),
    kind: storedText(row.kind, "source kind"),
    connectorId: optionalStoredText(row.connector, "source connector"),
    displayName: storedText(row.display_name, "source display name"),
    filePath: optionalStoredText(row.file_path, "source file path"),
    url: optionalStoredText(row.url, "source URL"),
    mime: optionalStoredText(row.mime, "source MIME"),
    sizeBytes: decodeSafeInteger(row.size_bytes, "source size_bytes"),
    status: storedEnum(row.status, ["ready", "index", "error"] as const, "source status"),
    meta: decodeJson(row.meta, "source meta"),
    readyGeneration:
      row.ready_generation === null ? null : decodeSafeInteger(row.ready_generation, "source ready_generation"),
    createdAt: decodeIsoTimestamp(row.created_at, "source created_at"),
  });
}

function decodeConnector(row: ConnectorRow): ConnectorRecord {
  return Object.freeze({
    id: storedText(row.id, "connector id"),
    accountId: storedText(row.account_id, "connector account id"),
    name: storedText(row.name, "connector name"),
    type: storedEnum(row.type, ["url_csv", "url_json"] as const, "connector type"),
    config: decodeJson(row.config, "connector config"),
    targetTable: storedText(row.target_table, "connector target table"),
    lastSync: row.last_sync === null ? null : decodeIsoTimestamp(row.last_sync, "connector last_sync"),
    syncStatus: storedEnum(row.sync_status, ["idle", "syncing", "indexing", "error"] as const, "connector status"),
    syncError: optionalStoredText(row.sync_error, "connector sync error"),
    createdAt: decodeIsoTimestamp(row.created_at, "connector created_at"),
  });
}

function preparedInput(input: ActivatePreparedConnectorInput) {
  return {
    accountId: requiredId(input.accountId, "accountId"),
    connectorId: requiredId(input.connectorId, "connector id"),
    sourceId: requiredId(input.sourceId, "source id"),
    generation: positiveInteger(input.generation, "generation"),
    leaseToken: requiredId(input.leaseToken, "lease token"),
    refreshVersion: requiredId(input.refreshVersion, "refresh version"),
    url: requiredText(input.url, "connector URL", MAX_URL_LENGTH),
    displayName: requiredText(input.displayName, "display name", MAX_DISPLAY_NAME_LENGTH),
    mime: requiredText(input.mime, "MIME type", 256),
    candidateLocation: requiredText(input.candidateLocation, "candidate location", MAX_PATH_LENGTH),
    activationPreviousLocation: optionalText(
      input.activationPreviousLocation,
      "activation previous location",
      MAX_PATH_LENGTH
    ),
    cleanupPreviousLocation: optionalText(input.cleanupPreviousLocation, "cleanup previous location", MAX_PATH_LENGTH),
  };
}

function objectMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SqliteCodecError("source meta is not a JSON object");
  }
  return { ...(value as Record<string, unknown>) };
}

function removeKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) delete record[key];
}

function placeholders(length: number): string {
  return new Array(length).fill("?").join(",");
}

function requiredId(value: unknown, field: string): string {
  const id = requiredText(value, field, MAX_ID_LENGTH);
  if (id.trim() !== id || id.includes("\0")) invalid(`${field} is invalid`);
  return id;
}

function tableName(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) invalid(`${field} is invalid`);
  return value;
}

function connectorType(value: unknown): ConnectorType {
  if (value !== "url_csv" && value !== "url_json") invalid("connector type is invalid");
  return value;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || Array.from(value).length > maxLength) {
    invalid(`${field} is invalid`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  return requiredText(value, field, maxLength);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${field} is invalid`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${field} is invalid`);
  return value;
}

function storedText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new SqliteCodecError(`${field} is not stored as text`);
  return value;
}

function optionalStoredText(value: unknown, field: string): string | null {
  return value === null ? null : storedText(value, field);
}

function storedEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new SqliteCodecError(`${field} is invalid`);
  return value as Values[number];
}

function prepareSuperseded(): never {
  throw new SourceIngestionTransitionError(
    "SOURCE_TRANSITION_PREPARE_SUPERSEDED",
    "connector prepare reservation was superseded"
  );
}

function invalid(message: string): never {
  throw new SourceIngestionTransitionError("SOURCE_TRANSITION_INVALID_ARGUMENT", message);
}
