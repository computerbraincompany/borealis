import {
  decodeBoolean,
  decodeIsoTimestamp,
  decodeJson,
  decodeSafeInteger,
  encodeBoolean,
  encodeIsoTimestamp,
  encodeJson,
  encodeSafeInteger,
} from "../codecs.js";
import { SqliteCodecError, type SqliteLedger, type SqliteTransaction } from "../types.js";

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1_000;
const MAX_CONNECTOR_SOURCES = 1_000;
const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 180;
const MAX_PATH_LENGTH = 32_768;
const MAX_URL_LENGTH = 2_000;
const MAX_META_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 8 * 1024;
const MAX_ERROR_LENGTH = 512;

const SOURCE_COLUMNS = `
  id, account_id, name, kind, connector, display_name, file_path, url, mime,
  size_bytes, status, meta, ready_generation, created_at
`;

const CONNECTOR_COLUMNS = `
  id, account_id, name, type, config, target_table, last_sync, sync_status,
  sync_error, created_at
`;

const PENDING_DELETE_COLUMNS = `
  source_id, account_id, name, file_path, connector_id, dataset_locations,
  attempts, last_error, created_at, updated_at
`;

export type SourceStatus = "ready" | "index" | "error";
export type ConnectorType = "url_csv" | "url_json";
export type ConnectorSyncStatus = "idle" | "syncing" | "indexing" | "error";

export interface SourceRecord {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly kind: string;
  readonly connectorId: string | null;
  readonly displayName: string;
  readonly filePath: string | null;
  readonly url: string | null;
  readonly mime: string | null;
  readonly sizeBytes: number;
  readonly status: SourceStatus;
  readonly meta: unknown;
  readonly readyGeneration: number | null;
  readonly createdAt: string;
}

export interface ConnectorRecord {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly type: ConnectorType;
  readonly config: unknown;
  readonly targetTable: string;
  readonly lastSync: string | null;
  readonly syncStatus: ConnectorSyncStatus;
  readonly syncError: string | null;
  readonly createdAt: string;
}

export interface PendingSourceDelete {
  readonly sourceId: string;
  readonly accountId: string;
  readonly name: string;
  readonly filePath: string | null;
  readonly connectorId: string | null;
  readonly datasetLocations: readonly string[];
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSourceInput {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly connectorId?: string | null;
  readonly displayName: string;
  readonly filePath?: string | null;
  readonly url?: string | null;
  readonly mime?: string | null;
  readonly sizeBytes?: number;
  readonly status?: SourceStatus;
  readonly meta?: unknown;
  readonly readyGeneration?: number | null;
}

export interface CreateConnectorInput {
  readonly id: string;
  readonly name: string;
  readonly type: ConnectorType;
  readonly config: unknown;
  readonly targetTable: string;
  readonly syncStatus?: ConnectorSyncStatus;
  readonly syncError?: string | null;
  readonly lastSync?: Date | string | null;
  readonly source: {
    readonly id: string;
    readonly displayName?: string;
    readonly url: string;
    readonly mime?: string;
    readonly filePath?: string | null;
    readonly sizeBytes?: number;
    readonly status?: SourceStatus;
    readonly meta?: unknown;
    readonly readyGeneration?: number | null;
  };
}

export interface UpdateSourceStatusInput {
  readonly status: SourceStatus;
  readonly meta?: unknown;
  readonly readyGeneration?: number | null;
  readonly requireNotReferencedByActiveRun?: boolean;
}

export interface UpdateConnectorSyncInput {
  readonly status: ConnectorSyncStatus;
  readonly syncError?: string | null;
  readonly lastSync?: Date | string | null;
  readonly expectedStatuses?: readonly ConnectorSyncStatus[];
}

export interface UpdatePendingSourceDeleteInput {
  readonly lastError: string | null;
  readonly incrementAttempts?: boolean;
  readonly updatedAt?: Date | string;
}

export interface SourceDeleteReservation {
  readonly intent: PendingSourceDelete;
  readonly alreadyPending: boolean;
  readonly connectorDeleted: boolean;
}

export interface ConnectorDeleteReservation {
  readonly connectorId: string;
  readonly intents: readonly PendingSourceDelete[];
  readonly alreadyPending: boolean;
}

export type SourceStoreErrorCode =
  | "SOURCE_STORE_INVALID_ARGUMENT"
  | "SOURCE_STORE_ACCOUNT_NOT_FOUND"
  | "SOURCE_STORE_SOURCE_NOT_FOUND"
  | "SOURCE_STORE_CONNECTOR_NOT_FOUND"
  | "SOURCE_STORE_PENDING_DELETE_NOT_FOUND"
  | "SOURCE_STORE_SOURCE_ID_CONFLICT"
  | "SOURCE_STORE_CONNECTOR_ID_CONFLICT"
  | "SOURCE_STORE_SOURCE_NAME_CONFLICT"
  | "SOURCE_STORE_CONNECTOR_TARGET_CONFLICT"
  | "SOURCE_STORE_CONNECTOR_SOURCE_CONFLICT"
  | "SOURCE_STORE_CONNECTOR_SOURCE_MISSING"
  | "SOURCE_STORE_SOURCE_IN_USE"
  | "SOURCE_STORE_CONNECTOR_SYNC_ACTIVE"
  | "SOURCE_STORE_CONNECTOR_STATE_CONFLICT";

export class SourceStoreError extends Error {
  constructor(
    readonly code: SourceStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SourceStoreError";
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

interface PendingDeleteRow {
  source_id: unknown;
  account_id: unknown;
  name: unknown;
  file_path: unknown;
  connector_id: unknown;
  dataset_locations: unknown;
  attempts: unknown;
  last_error: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface SourceStoreOptions {
  readonly now?: () => Date;
}

export class SourceStore {
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: SourceStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async listSources(accountId: string, limit = DEFAULT_LIST_LIMIT): Promise<SourceRecord[]> {
    const account = requiredId(accountId, "accountId");
    const boundedLimit = listLimit(limit);
    const rows = await this.ledger.all<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM sources
       WHERE account_id=? ORDER BY created_at DESC, id DESC LIMIT ?`,
      [account, boundedLimit]
    );
    return rows.map(decodeSource);
  }

  async getSource(accountId: string, sourceId: string): Promise<SourceRecord | undefined> {
    const row = await this.ledger.get<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE account_id=? AND id=?`, [
      requiredId(accountId, "accountId"),
      requiredId(sourceId, "sourceId"),
    ]);
    return row ? decodeSource(row) : undefined;
  }

  async createSource(accountId: string, input: CreateSourceInput): Promise<SourceRecord> {
    const account = requiredId(accountId, "accountId");
    const values = sourceInput(input);
    return this.ledger.withImmediateTransaction((transaction) => {
      ensureAccount(transaction, account);
      ensureSourceIdentityAvailable(transaction, values.id);
      ensureSourceNameAvailable(transaction, account, values.name, values.connectorId);
      if (values.connectorId) ensureConnectorCanOwnSource(transaction, account, values.connectorId, values.name);
      transaction.run(
        `INSERT INTO sources
           (id,account_id,name,kind,connector,display_name,file_path,url,mime,size_bytes,status,meta,ready_generation)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          values.id,
          account,
          values.name,
          values.kind,
          values.connectorId,
          values.displayName,
          values.filePath,
          values.url,
          values.mime,
          values.sizeBytes,
          values.status,
          values.meta,
          values.readyGeneration,
        ]
      );
      return requiredSource(transaction, account, values.id);
    });
  }

  async updateSourceStatus(accountId: string, sourceId: string, input: UpdateSourceStatusInput): Promise<SourceRecord> {
    const account = requiredId(accountId, "accountId");
    const id = requiredId(sourceId, "sourceId");
    const status = sourceStatus(input.status);
    if (
      input.requireNotReferencedByActiveRun !== undefined &&
      typeof input.requireNotReferencedByActiveRun !== "boolean"
    ) {
      invalid("requireNotReferencedByActiveRun must be a boolean");
    }
    return this.ledger.withImmediateTransaction((transaction) => {
      const current = requiredSource(transaction, account, id);
      if (input.requireNotReferencedByActiveRun) assertSourceNotInActiveRun(transaction, account, id);
      const encodedMeta = Object.hasOwn(input, "meta")
        ? boundedObjectJson(input.meta, "source meta", MAX_META_BYTES)
        : null;
      const readyGeneration = Object.hasOwn(input, "readyGeneration")
        ? optionalGeneration(input.readyGeneration, "readyGeneration")
        : current.readyGeneration;
      transaction.run(
        `UPDATE sources
         SET status=?, meta=CASE WHEN ?=1 THEN ? ELSE meta END, ready_generation=?
         WHERE account_id=? AND id=?`,
        [status, encodeBoolean(Object.hasOwn(input, "meta")), encodedMeta, readyGeneration, account, id]
      );
      return requiredSource(transaction, account, id);
    });
  }

  async listConnectors(accountId: string, limit = DEFAULT_LIST_LIMIT): Promise<ConnectorRecord[]> {
    const rows = await this.ledger.all<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS} FROM connectors
       WHERE account_id=? ORDER BY created_at DESC, id DESC LIMIT ?`,
      [requiredId(accountId, "accountId"), listLimit(limit)]
    );
    return rows.map(decodeConnector);
  }

  async getConnector(accountId: string, connectorId: string): Promise<ConnectorRecord | undefined> {
    const row = await this.ledger.get<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE account_id=? AND id=?`,
      [requiredId(accountId, "accountId"), requiredId(connectorId, "connectorId")]
    );
    return row ? decodeConnector(row) : undefined;
  }

  async createConnector(
    accountId: string,
    input: CreateConnectorInput
  ): Promise<{ connector: ConnectorRecord; source: SourceRecord }> {
    const account = requiredId(accountId, "accountId");
    const connector = connectorInput(input);
    return this.ledger.withImmediateTransaction((transaction) => {
      ensureAccount(transaction, account);
      ensureConnectorIdentityAvailable(transaction, connector.id);
      ensureSourceIdentityAvailable(transaction, connector.source.id);
      ensureConnectorTargetAvailable(transaction, account, connector.targetTable);
      transaction.run(
        `INSERT INTO connectors
           (id,account_id,name,type,config,target_table,last_sync,sync_status,sync_error)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          connector.id,
          account,
          connector.name,
          connector.type,
          connector.config,
          connector.targetTable,
          connector.lastSync,
          connector.syncStatus,
          connector.syncError,
        ]
      );
      transaction.run(
        `INSERT INTO sources
           (id,account_id,name,kind,connector,display_name,file_path,url,mime,size_bytes,status,meta,ready_generation)
         VALUES (?,? ,?,'tabular',?,?,?,?,?,?,?,?,?)`,
        [
          connector.source.id,
          account,
          connector.targetTable,
          connector.id,
          connector.source.displayName,
          connector.source.filePath,
          connector.source.url,
          connector.source.mime,
          connector.source.sizeBytes,
          connector.source.status,
          connector.source.meta,
          connector.source.readyGeneration,
        ]
      );
      return {
        connector: requiredConnector(transaction, account, connector.id),
        source: requiredSource(transaction, account, connector.source.id),
      };
    });
  }

  async claimConnectorRefresh(
    accountId: string,
    connectorId: string
  ): Promise<{ connector: ConnectorRecord; source: SourceRecord }> {
    const account = requiredId(accountId, "accountId");
    const id = requiredId(connectorId, "connectorId");
    return this.ledger.withImmediateTransaction((transaction) => {
      const connector = requiredConnector(transaction, account, id);
      if (connector.syncStatus === "syncing" || connector.syncStatus === "indexing") {
        throw new SourceStoreError("SOURCE_STORE_CONNECTOR_SYNC_ACTIVE", "connector sync is active");
      }
      const sources = connectorSources(transaction, account, id);
      if (sources.length === 0) {
        throw new SourceStoreError("SOURCE_STORE_CONNECTOR_SOURCE_MISSING", "connector has no owned source");
      }
      if (sources.length !== 1) {
        throw new SourceStoreError("SOURCE_STORE_CONNECTOR_SOURCE_CONFLICT", "connector owns more than one source");
      }
      assertSourceNotInActiveRun(transaction, account, sources[0].id);
      transaction.run(
        `UPDATE connectors SET sync_status='syncing', sync_error=NULL
         WHERE account_id=? AND id=?`,
        [account, id]
      );
      return { connector: requiredConnector(transaction, account, id), source: sources[0] };
    });
  }

  async updateConnectorSyncState(
    accountId: string,
    connectorId: string,
    input: UpdateConnectorSyncInput
  ): Promise<ConnectorRecord> {
    const account = requiredId(accountId, "accountId");
    const id = requiredId(connectorId, "connectorId");
    const status = connectorSyncStatus(input.status);
    if (
      input.expectedStatuses !== undefined &&
      (!Array.isArray(input.expectedStatuses) ||
        input.expectedStatuses.length === 0 ||
        input.expectedStatuses.length > 4)
    ) {
      invalid("expectedStatuses must contain between one and four connector states");
    }
    const expected = input.expectedStatuses?.map(connectorSyncStatus);
    if (expected && new Set(expected).size !== expected.length) {
      invalid("expectedStatuses must contain distinct connector states");
    }
    return this.ledger.withImmediateTransaction((transaction) => {
      const current = requiredConnector(transaction, account, id);
      if (expected && !expected.includes(current.syncStatus)) {
        throw new SourceStoreError(
          "SOURCE_STORE_CONNECTOR_STATE_CONFLICT",
          "connector state changed before the update"
        );
      }
      const syncError = Object.hasOwn(input, "syncError")
        ? optionalText(input.syncError, "syncError", MAX_ERROR_LENGTH)
        : current.syncError;
      const lastSync = Object.hasOwn(input, "lastSync")
        ? input.lastSync === null
          ? null
          : encodeIsoTimestamp(requiredDate(input.lastSync, "lastSync"), "lastSync")
        : current.lastSync;
      transaction.run(
        `UPDATE connectors SET sync_status=?, sync_error=?, last_sync=?
         WHERE account_id=? AND id=?`,
        [status, syncError, lastSync, account, id]
      );
      return requiredConnector(transaction, account, id);
    });
  }

  async deleteSource(accountId: string, sourceId: string): Promise<SourceDeleteReservation> {
    const account = requiredId(accountId, "accountId");
    const id = requiredId(sourceId, "sourceId");
    return this.ledger.withImmediateTransaction((transaction) => {
      const source = findSource(transaction, account, id);
      if (!source) {
        const pending = findPendingDelete(transaction, account, id);
        if (!pending) sourceNotFound();
        return {
          intent: pending,
          alreadyPending: true,
          connectorDeleted: pending.connectorId
            ? findConnector(transaction, account, pending.connectorId) === undefined
            : false,
        };
      }
      assertSourceNotInActiveRun(transaction, account, id);
      if (source.connectorId) assertConnectorCanBeDeleted(transaction, account, source.connectorId);
      const intent = reservePendingDelete(transaction, source, this.timestamp());
      const deleted = transaction.run(`DELETE FROM sources WHERE account_id=? AND id=?`, [account, id]);
      if (deleted.changes !== 1) throw new Error("source deletion lost transaction ownership");
      let connectorDeleted = false;
      if (source.connectorId && connectorSources(transaction, account, source.connectorId).length === 0) {
        connectorDeleted =
          transaction.run(`DELETE FROM connectors WHERE account_id=? AND id=?`, [account, source.connectorId])
            .changes === 1;
      }
      return { intent, alreadyPending: false, connectorDeleted };
    });
  }

  async deleteConnector(accountId: string, connectorId: string): Promise<ConnectorDeleteReservation> {
    const account = requiredId(accountId, "accountId");
    const id = requiredId(connectorId, "connectorId");
    return this.ledger.withImmediateTransaction((transaction) => {
      const connector = findConnector(transaction, account, id);
      if (!connector) {
        const pending = pendingDeletesForConnector(transaction, account, id, MAX_LIST_LIMIT);
        if (pending.length === 0) connectorNotFound();
        return { connectorId: id, intents: pending, alreadyPending: true };
      }
      assertConnectorCanBeDeleted(transaction, account, id);
      const sources = connectorSources(transaction, account, id);
      for (const source of sources) assertSourceNotInActiveRun(transaction, account, source.id);
      const timestamp = this.timestamp();
      const intents = sources.map((source) => reservePendingDelete(transaction, source, timestamp));
      const deletedSources = transaction.run(`DELETE FROM sources WHERE account_id=? AND connector=?`, [account, id]);
      if (deletedSources.changes !== sources.length) {
        throw new Error("connector source deletion lost transaction ownership");
      }
      const deletedConnector = transaction.run(`DELETE FROM connectors WHERE account_id=? AND id=?`, [account, id]);
      if (deletedConnector.changes !== 1) throw new Error("connector deletion lost transaction ownership");
      return { connectorId: id, intents, alreadyPending: false };
    });
  }

  async listPendingSourceDeletes(accountId: string, limit = DEFAULT_LIST_LIMIT): Promise<PendingSourceDelete[]> {
    const rows = await this.ledger.all<PendingDeleteRow>(
      `SELECT ${PENDING_DELETE_COLUMNS} FROM pending_source_deletes
       WHERE account_id=? ORDER BY created_at, source_id LIMIT ?`,
      [requiredId(accountId, "accountId"), listLimit(limit)]
    );
    return rows.map(decodePendingDelete);
  }

  async updatePendingSourceDelete(
    accountId: string,
    sourceId: string,
    input: UpdatePendingSourceDeleteInput
  ): Promise<PendingSourceDelete> {
    const account = requiredId(accountId, "accountId");
    const id = requiredId(sourceId, "sourceId");
    const lastError = optionalText(input.lastError, "lastError", MAX_ERROR_LENGTH);
    if (input.incrementAttempts !== undefined && typeof input.incrementAttempts !== "boolean") {
      invalid("incrementAttempts must be a boolean");
    }
    const updatedAt = encodeIsoTimestamp(input.updatedAt ?? this.now(), "updatedAt");
    return this.ledger.withImmediateTransaction((transaction) => {
      const updated = transaction.run(
        `UPDATE pending_source_deletes
         SET attempts=attempts + CASE WHEN ?=1 THEN 1 ELSE 0 END,
             last_error=?, updated_at=?
         WHERE account_id=? AND source_id=?`,
        [encodeBoolean(input.incrementAttempts ?? true), lastError, updatedAt, account, id]
      );
      if (updated.changes !== 1) pendingDeleteNotFound();
      return requiredPendingDelete(transaction, account, id);
    });
  }

  async clearPendingSourceDelete(accountId: string, sourceId: string): Promise<boolean> {
    const result = await this.ledger.run(`DELETE FROM pending_source_deletes WHERE account_id=? AND source_id=?`, [
      requiredId(accountId, "accountId"),
      requiredId(sourceId, "sourceId"),
    ]);
    return result.changes === 1;
  }

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "now");
  }
}

export function createSourceStore(ledger: SqliteLedger, options: SourceStoreOptions = {}): SourceStore {
  return new SourceStore(ledger, options);
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
  if (!source) sourceNotFound();
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
  if (!connector) connectorNotFound();
  return connector;
}

function connectorSources(transaction: SqliteTransaction, accountId: string, connectorId: string): SourceRecord[] {
  const sources = transaction
    .all<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM sources
       WHERE account_id=? AND connector=? ORDER BY created_at, id LIMIT ?`,
      [accountId, connectorId, MAX_CONNECTOR_SOURCES + 1]
    )
    .map(decodeSource);
  if (sources.length > MAX_CONNECTOR_SOURCES) {
    throw new SourceStoreError(
      "SOURCE_STORE_CONNECTOR_SOURCE_CONFLICT",
      "connector owns too many sources for one mutation"
    );
  }
  return sources;
}

function assertSourceNotInActiveRun(transaction: SqliteTransaction, accountId: string, sourceId: string): void {
  const row = transaction.get<{ referenced: unknown }>(
    `SELECT EXISTS (
       SELECT 1
       FROM chat_run_sources AS snapshot
       JOIN chat_runs AS run
         ON run.id=snapshot.run_id AND run.account_id=snapshot.account_id
       WHERE snapshot.account_id=? AND snapshot.source_id=?
         AND run.status IN ('running','cancelling')
     ) AS referenced`,
    [accountId, sourceId]
  );
  if (decodeBoolean(row?.referenced, "active source reference")) {
    throw new SourceStoreError("SOURCE_STORE_SOURCE_IN_USE", "source is in use by an active run");
  }
}

function assertConnectorCanBeDeleted(transaction: SqliteTransaction, accountId: string, connectorId: string): void {
  const connector = requiredConnector(transaction, accountId, connectorId);
  if (connector.syncStatus === "syncing" || connector.syncStatus === "indexing") {
    throw new SourceStoreError("SOURCE_STORE_CONNECTOR_SYNC_ACTIVE", "connector sync is active");
  }
}

function ensureAccount(transaction: SqliteTransaction, accountId: string): void {
  if (!transaction.get(`SELECT id FROM users WHERE id=?`, [accountId])) {
    throw new SourceStoreError("SOURCE_STORE_ACCOUNT_NOT_FOUND", "account not found");
  }
}

function ensureSourceIdentityAvailable(transaction: SqliteTransaction, sourceId: string): void {
  const collision = transaction.get(
    `SELECT id FROM sources WHERE id=?
     UNION ALL SELECT source_id AS id FROM pending_source_deletes WHERE source_id=? LIMIT 1`,
    [sourceId, sourceId]
  );
  if (collision) throw new SourceStoreError("SOURCE_STORE_SOURCE_ID_CONFLICT", "source id is already in use");
}

function ensureConnectorIdentityAvailable(transaction: SqliteTransaction, connectorId: string): void {
  const collision = transaction.get(
    `SELECT id FROM connectors WHERE id=?
     UNION ALL SELECT connector_id AS id FROM pending_source_deletes WHERE connector_id=? LIMIT 1`,
    [connectorId, connectorId]
  );
  if (collision) {
    throw new SourceStoreError("SOURCE_STORE_CONNECTOR_ID_CONFLICT", "connector id is already in use");
  }
}

function ensureSourceNameAvailable(
  transaction: SqliteTransaction,
  accountId: string,
  name: string,
  connectorId: string | null
): void {
  if (transaction.get(`SELECT id FROM sources WHERE account_id=? AND name=?`, [accountId, name])) {
    throw new SourceStoreError("SOURCE_STORE_SOURCE_NAME_CONFLICT", "source name is already in use");
  }
  const connector = transaction.get<{ id: string }>(
    `SELECT id FROM connectors WHERE account_id=? AND target_table=? AND id<>COALESCE(?, '')`,
    [accountId, name, connectorId]
  );
  if (connector) {
    throw new SourceStoreError("SOURCE_STORE_SOURCE_NAME_CONFLICT", "source name is reserved by a connector");
  }
}

function ensureConnectorCanOwnSource(
  transaction: SqliteTransaction,
  accountId: string,
  connectorId: string,
  sourceName: string
): void {
  const connector = findConnector(transaction, accountId, connectorId);
  if (!connector) connectorNotFound();
  if (connector.targetTable !== sourceName) {
    throw new SourceStoreError(
      "SOURCE_STORE_CONNECTOR_TARGET_CONFLICT",
      "source name does not match the connector target"
    );
  }
  if (transaction.get(`SELECT id FROM sources WHERE account_id=? AND connector=?`, [accountId, connectorId])) {
    throw new SourceStoreError("SOURCE_STORE_CONNECTOR_SOURCE_CONFLICT", "connector already owns a source");
  }
}

function ensureConnectorTargetAvailable(transaction: SqliteTransaction, accountId: string, targetTable: string): void {
  const collision = transaction.get(
    `SELECT name AS target FROM sources WHERE account_id=? AND name=?
     UNION ALL SELECT target_table AS target FROM connectors WHERE account_id=? AND target_table=? LIMIT 1`,
    [accountId, targetTable, accountId, targetTable]
  );
  if (collision) {
    throw new SourceStoreError("SOURCE_STORE_CONNECTOR_TARGET_CONFLICT", "connector target table is already in use");
  }
}

function reservePendingDelete(
  transaction: SqliteTransaction,
  source: SourceRecord,
  timestamp: string
): PendingSourceDelete {
  const datasetLocations = cleanupLocations(source);
  transaction.run(
    `INSERT INTO pending_source_deletes
       (source_id,account_id,name,file_path,connector_id,dataset_locations,attempts,last_error,created_at,updated_at)
     VALUES (?,?,?,?,?,?,0,NULL,?,?)
     ON CONFLICT(source_id) DO NOTHING`,
    [
      source.id,
      source.accountId,
      source.name,
      source.filePath,
      source.connectorId,
      encodeJson(datasetLocations, "dataset cleanup locations"),
      timestamp,
      timestamp,
    ]
  );
  return requiredPendingDelete(transaction, source.accountId, source.id);
}

function cleanupLocations(source: SourceRecord): string[] {
  const meta = isRecord(source.meta) ? source.meta : {};
  const candidates = [
    source.filePath,
    meta.connector_previous_location,
    meta.connector_candidate_location,
    meta.connector_activation_previous_location,
  ];
  const locations: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    if (!locations.includes(candidate)) locations.push(candidate);
  }
  return locations;
}

function findPendingDelete(
  transaction: SqliteTransaction,
  accountId: string,
  sourceId: string
): PendingSourceDelete | undefined {
  const row = transaction.get<PendingDeleteRow>(
    `SELECT ${PENDING_DELETE_COLUMNS} FROM pending_source_deletes WHERE account_id=? AND source_id=?`,
    [accountId, sourceId]
  );
  return row ? decodePendingDelete(row) : undefined;
}

function requiredPendingDelete(
  transaction: SqliteTransaction,
  accountId: string,
  sourceId: string
): PendingSourceDelete {
  const pending = findPendingDelete(transaction, accountId, sourceId);
  if (!pending) pendingDeleteNotFound();
  return pending;
}

function pendingDeletesForConnector(
  transaction: SqliteTransaction,
  accountId: string,
  connectorId: string,
  limit: number
): PendingSourceDelete[] {
  return transaction
    .all<PendingDeleteRow>(
      `SELECT ${PENDING_DELETE_COLUMNS} FROM pending_source_deletes
       WHERE account_id=? AND connector_id=? ORDER BY created_at, source_id LIMIT ?`,
      [accountId, connectorId, limit]
    )
    .map(decodePendingDelete);
}

function decodeSource(row: SourceRow): SourceRecord {
  return {
    id: storedText(row.id, "source id"),
    accountId: storedText(row.account_id, "source account id"),
    name: storedText(row.name, "source name"),
    kind: storedText(row.kind, "source kind"),
    connectorId: storedOptionalText(row.connector, "source connector id"),
    displayName: storedText(row.display_name, "source display name"),
    filePath: storedOptionalText(row.file_path, "source file path"),
    url: storedOptionalText(row.url, "source URL"),
    mime: storedOptionalText(row.mime, "source MIME type"),
    sizeBytes: decodeSafeInteger(row.size_bytes, "source size_bytes"),
    status: decodeEnum(row.status, ["ready", "index", "error"] as const, "source status"),
    meta: decodeJson(row.meta, "source meta"),
    readyGeneration:
      row.ready_generation === null ? null : decodeSafeInteger(row.ready_generation, "source ready_generation"),
    createdAt: decodeIsoTimestamp(row.created_at, "source created_at"),
  };
}

function decodeConnector(row: ConnectorRow): ConnectorRecord {
  return {
    id: storedText(row.id, "connector id"),
    accountId: storedText(row.account_id, "connector account id"),
    name: storedText(row.name, "connector name"),
    type: decodeEnum(row.type, ["url_csv", "url_json"] as const, "connector type"),
    config: decodeJson(row.config, "connector config"),
    targetTable: storedText(row.target_table, "connector target table"),
    lastSync: row.last_sync === null ? null : decodeIsoTimestamp(row.last_sync, "connector last_sync"),
    syncStatus: decodeEnum(row.sync_status, ["idle", "syncing", "indexing", "error"] as const, "connector sync status"),
    syncError: storedOptionalText(row.sync_error, "connector sync error"),
    createdAt: decodeIsoTimestamp(row.created_at, "connector created_at"),
  };
}

function decodePendingDelete(row: PendingDeleteRow): PendingSourceDelete {
  const locations = decodeJson<unknown>(row.dataset_locations, "pending delete dataset_locations");
  if (!Array.isArray(locations) || locations.some((location) => typeof location !== "string")) {
    throw new SqliteCodecError("pending delete dataset_locations is not a string array");
  }
  return {
    sourceId: storedText(row.source_id, "pending delete source id"),
    accountId: storedText(row.account_id, "pending delete account id"),
    name: storedText(row.name, "pending delete source name"),
    filePath: storedOptionalText(row.file_path, "pending delete file path"),
    connectorId: storedOptionalText(row.connector_id, "pending delete connector id"),
    datasetLocations: locations,
    attempts: decodeSafeInteger(row.attempts, "pending delete attempts"),
    lastError: storedOptionalText(row.last_error, "pending delete last_error"),
    createdAt: decodeIsoTimestamp(row.created_at, "pending delete created_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "pending delete updated_at"),
  };
}

function sourceInput(input: CreateSourceInput) {
  return {
    id: requiredId(input.id, "source id"),
    name: sourceName(input.name),
    kind: requiredText(input.kind, "source kind", 32),
    connectorId: optionalId(input.connectorId, "connector id"),
    displayName: requiredText(input.displayName, "source display name", MAX_DISPLAY_NAME_LENGTH),
    filePath: optionalText(input.filePath, "source file path", MAX_PATH_LENGTH),
    url: optionalText(input.url, "source URL", MAX_URL_LENGTH),
    mime: optionalText(input.mime, "source MIME type", 256),
    sizeBytes: nonNegativeInteger(input.sizeBytes ?? 0, "source sizeBytes"),
    status: sourceStatus(input.status ?? "ready"),
    meta: boundedObjectJson(input.meta ?? {}, "source meta", MAX_META_BYTES),
    readyGeneration: optionalGeneration(input.readyGeneration, "source readyGeneration"),
  };
}

function connectorInput(input: CreateConnectorInput) {
  const type = connectorType(input.type);
  return {
    id: requiredId(input.id, "connector id"),
    name: requiredText(input.name, "connector name", 120),
    type,
    config: boundedObjectJson(input.config, "connector config", MAX_CONFIG_BYTES),
    targetTable: sourceName(input.targetTable),
    syncStatus: connectorSyncStatus(input.syncStatus ?? "syncing"),
    syncError: optionalText(input.syncError, "connector sync error", MAX_ERROR_LENGTH),
    lastSync:
      input.lastSync === null || input.lastSync === undefined
        ? null
        : encodeIsoTimestamp(requiredDate(input.lastSync, "connector lastSync"), "connector lastSync"),
    source: {
      id: requiredId(input.source.id, "connector source id"),
      displayName: requiredText(
        input.source.displayName ?? input.name,
        "connector source display name",
        MAX_DISPLAY_NAME_LENGTH
      ),
      url: requiredText(input.source.url, "connector source URL", MAX_URL_LENGTH),
      mime: requiredText(
        input.source.mime ?? (type === "url_json" ? "application/json" : "text/csv"),
        "connector source MIME type",
        256
      ),
      filePath: optionalText(input.source.filePath, "connector source file path", MAX_PATH_LENGTH),
      sizeBytes: nonNegativeInteger(input.source.sizeBytes ?? 0, "connector source sizeBytes"),
      status: sourceStatus(input.source.status ?? "index"),
      meta: boundedObjectJson(input.source.meta ?? {}, "connector source meta", MAX_META_BYTES),
      readyGeneration: optionalGeneration(input.source.readyGeneration, "connector source readyGeneration"),
    },
  };
}

function requiredId(value: unknown, field: string): string {
  const id = requiredText(value, field, MAX_ID_LENGTH);
  if (id.trim() !== id) invalid(`${field} must not have surrounding whitespace`);
  return id;
}

function optionalId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredId(value, field);
}

function sourceName(value: unknown): string {
  const name = requiredText(value, "source name", 63);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    invalid("source name must start with a letter and contain only lowercase letters, digits, and underscores");
  }
  return name;
}

function sourceStatus(value: unknown): SourceStatus {
  return inputEnum(value, ["ready", "index", "error"] as const, "source status");
}

function connectorType(value: unknown): ConnectorType {
  return inputEnum(value, ["url_csv", "url_json"] as const, "connector type");
}

function connectorSyncStatus(value: unknown): ConnectorSyncStatus {
  return inputEnum(value, ["idle", "syncing", "indexing", "error"] as const, "connector sync status");
}

function optionalGeneration(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeInteger(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") invalid(`${field} must be a non-negative integer`);
  const encoded = encodeSafeInteger(value, field);
  const decoded = typeof encoded === "bigint" ? decodeSafeInteger(encoded, field) : encoded;
  if (decoded < 0) invalid(`${field} must be a non-negative integer`);
  return decoded;
}

function listLimit(value: unknown): number {
  const limit = nonNegativeInteger(value, "limit");
  if (limit < 1 || limit > MAX_LIST_LIMIT) invalid(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
  return limit;
}

function boundedJson(value: unknown, field: string, maxBytes: number): string {
  const encoded = encodeJson(value, field);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) invalid(`${field} exceeds its storage limit`);
  return encoded;
}

function boundedObjectJson(value: unknown, field: string, maxBytes: number): string {
  if (!isRecord(value)) invalid(`${field} must be a JSON object`);
  return boundedJson(value, field, maxBytes);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || Array.from(value).length > maxLength) {
    invalid(`${field} must contain between 1 and ${maxLength} characters`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, field, maxLength);
}

function requiredDate(value: unknown, field: string): Date | string {
  if (!(value instanceof Date) && typeof value !== "string") invalid(`${field} must be a timestamp`);
  return value;
}

function storedText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new SqliteCodecError(`${field} is not stored as text`);
  return value;
}

function storedOptionalText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return storedText(value, field);
}

function inputEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(`${field} is invalid`);
  return value as Values[number];
}

function decodeEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new SqliteCodecError(`${field} is invalid`);
  }
  return value as Values[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceNotFound(): never {
  throw new SourceStoreError("SOURCE_STORE_SOURCE_NOT_FOUND", "source not found");
}

function connectorNotFound(): never {
  throw new SourceStoreError("SOURCE_STORE_CONNECTOR_NOT_FOUND", "connector not found");
}

function pendingDeleteNotFound(): never {
  throw new SourceStoreError("SOURCE_STORE_PENDING_DELETE_NOT_FOUND", "pending source deletion not found");
}

function invalid(message: string): never {
  throw new SourceStoreError("SOURCE_STORE_INVALID_ARGUMENT", message);
}
