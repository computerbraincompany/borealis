import { decodeIsoTimestamp, decodeSafeInteger, encodeIsoTimestamp } from "../codecs.js";
import { SqliteCodecError, type SqliteLedger, type SqliteTransaction } from "../types.js";

const MAX_ID_LENGTH = 256;
const MAX_VERSION_LENGTH = 512;
const MAX_LOCATION_LENGTH = 32_768;
const MAX_PAGE_LIMIT = 50;

/**
 * Plan 016's fixed connector-refresh repair page bound. One periodic
 * invocation reads at most this many rows; startup keyset pages use the same
 * bound. Later ticks make further progress.
 */
export const CONNECTOR_REFRESH_REPAIR_LIMIT = 20;

const STATE_COLUMNS = `
  repair_ordinal, source_id, account_id, connector_id, generation, refresh_version,
  phase, candidate_location, activation_previous_location, cleanup_previous_location,
  attempts, created_at, updated_at
`;

export const CONNECTOR_REFRESH_PHASES = [
  "preparing",
  "prepared",
  "activating",
  "activated",
  "cleanup_pending",
] as const;

export type ConnectorRefreshPhase = (typeof CONNECTOR_REFRESH_PHASES)[number];

interface ConnectorRefreshFields {
  readonly repairOrdinal: number;
  readonly accountId: string;
  readonly sourceId: string;
  readonly connectorId: string;
  readonly generation: number;
  readonly refreshVersion: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Durable prepare reservation: no candidate identities exist yet. */
export interface PreparingConnectorRefresh extends ConnectorRefreshFields {
  readonly phase: "preparing";
  readonly candidateLocation: null;
  readonly activationPreviousLocation: null;
  readonly cleanupPreviousLocation: null;
}

/** Exact immutable candidate plus the expected activation-previous identity. */
export interface PreparedConnectorRefresh extends ConnectorRefreshFields {
  readonly phase: "prepared";
  readonly candidateLocation: string;
  readonly activationPreviousLocation: string | null;
  readonly cleanupPreviousLocation: string | null;
}

/** The external exact-location compare-and-swap may be in flight or ambiguously completed. */
export interface ActivatingConnectorRefresh extends ConnectorRefreshFields {
  readonly phase: "activating";
  readonly candidateLocation: string;
  readonly activationPreviousLocation: string | null;
  readonly cleanupPreviousLocation: string | null;
}

/** The exact candidate is confirmed active; SQLite promotion has not committed. */
export interface ActivatedConnectorRefresh extends ConnectorRefreshFields {
  readonly phase: "activated";
  readonly candidateLocation: string;
  readonly activationPreviousLocation: string | null;
  readonly cleanupPreviousLocation: string | null;
}

/** SQLite/source promotion committed; the exact old location awaits cleanup. */
export interface CleanupPendingConnectorRefresh extends ConnectorRefreshFields {
  readonly phase: "cleanup_pending";
  readonly candidateLocation: string;
  readonly activationPreviousLocation: null;
  readonly cleanupPreviousLocation: string;
}

export type ConnectorRefreshState =
  | PreparingConnectorRefresh
  | PreparedConnectorRefresh
  | ActivatingConnectorRefresh
  | ActivatedConnectorRefresh
  | CleanupPendingConnectorRefresh;

/** The exact identities recorded when a prepare becomes durable `prepared`. */
export interface PreparedCandidate {
  readonly candidateLocation: string;
  readonly activationPreviousLocation: string | null;
  readonly cleanupPreviousLocation: string | null;
}

/** Full row identity used by every phase transition, touch, and delete CAS. */
export interface ConnectorRefreshIdentity {
  readonly accountId: string;
  readonly sourceId: string;
  readonly connectorId: string;
  readonly generation: number;
  readonly refreshVersion: string;
}

export type ConnectorRefreshStoreErrorCode = "CONNECTOR_REFRESH_INVALID_ARGUMENT" | "CONNECTOR_REFRESH_STATE_INVALID";

export class ConnectorRefreshStoreError extends Error {
  constructor(
    readonly code: ConnectorRefreshStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConnectorRefreshStoreError";
  }
}

/**
 * Strict ISO-millisecond successor: `max(clockNow, selectedUpdatedAt + 1 ms)`.
 * Invalid or overflowing inputs are rejected so a fixed or backward clock can
 * never produce a non-monotonic ordering key. Fairness still comes from
 * `attempts`, not from time alone.
 */
export function nextConnectorRefreshTimestamp(now: Date, previousUpdatedAt: string): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) invalid("now must be a valid date");
  const previousIso = decodeIsoTimestamp(previousUpdatedAt, "refresh updated_at");
  const previousMs = Date.parse(previousIso);
  if (!Number.isFinite(previousMs)) invalid("previous refresh timestamp is not usable");
  const successorMs = previousMs === Number.MAX_SAFE_INTEGER ? previousMs : previousMs + 1;
  const nextMs = Math.max(now.getTime(), successorMs);
  if (!Number.isFinite(nextMs) || nextMs > Date.UTC(9999, 11, 31, 23, 59, 59, 999)) {
    invalid("refresh timestamp would overflow");
  }
  return encodeIsoTimestamp(new Date(nextMs), "refresh timestamp");
}

interface StateRow {
  repair_ordinal: unknown;
  source_id: unknown;
  account_id: unknown;
  connector_id: unknown;
  generation: unknown;
  refresh_version: unknown;
  phase: unknown;
  candidate_location: unknown;
  activation_previous_location: unknown;
  cleanup_previous_location: unknown;
  attempts: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface ConnectorRefreshStoreOptions {
  readonly now?: () => Date;
}

/**
 * Typed durable protocol state for connector refresh (schema v16). Every
 * update/delete is an
 * account/source/connector/generation/refresh-version/expected-phase
 * compare-and-swap that reports lost ownership (`false`) instead of widening.
 * Nothing here may be keyed on the source ID alone; the account-scoped
 * snapshot read is the single documented exception and is read-only.
 */
export class ConnectorRefreshStore {
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: ConnectorRefreshStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Read-only snapshot of the exact account/source row for orchestration
   * (worker path selection, startup/periodic reconciliation). It is never a
   * mutation authority: callers must supply the returned row's full identity
   * to every state-changing operation.
   */
  async getState(accountIdInput: string, sourceIdInput: string): Promise<ConnectorRefreshState | undefined> {
    const accountId = requiredId(accountIdInput, "accountId");
    const sourceId = requiredId(sourceIdInput, "sourceId");
    const row = await this.ledger.get<StateRow>(
      `SELECT ${STATE_COLUMNS} FROM connector_refresh_states WHERE account_id=? AND source_id=?`,
      [accountId, sourceId]
    );
    return row ? decodeState(row) : undefined;
  }

  /** Exact-identity read; the returned row is also the CAS proof of identity. */
  async getStateForIdentity(identity: ConnectorRefreshIdentity): Promise<ConnectorRefreshState | undefined> {
    const values = identityInput(identity);
    const row = await this.ledger.get<StateRow>(
      `SELECT ${STATE_COLUMNS} FROM connector_refresh_states
       WHERE account_id=? AND source_id=? AND connector_id=? AND generation=? AND refresh_version=?`,
      [values.accountId, values.sourceId, values.connectorId, values.generation, values.refreshVersion]
    );
    return row ? decodeState(row) : undefined;
  }

  /**
   * One globally ordered bounded page of repairable states. Untouched or
   * lower-attempt work always sorts ahead of repeated failures regardless of
   * tied or backward timestamps.
   */
  async listRepairableStates(limit: number): Promise<readonly ConnectorRefreshState[]> {
    const pageLimit = pageLimitValue(limit);
    const rows = await this.ledger.all<StateRow>(
      `SELECT ${STATE_COLUMNS} FROM connector_refresh_states
       ORDER BY attempts, updated_at, source_id LIMIT ?`,
      [pageLimit]
    );
    return Object.freeze(rows.map(decodeState));
  }

  /** `MAX(repair_ordinal)` of persisted state; zero means the startup snapshot is empty. */
  async captureMaxRepairOrdinal(): Promise<number> {
    const row = await this.ledger.get<{ max_ordinal: unknown }>(
      `SELECT COALESCE(MAX(repair_ordinal), 0) AS max_ordinal FROM connector_refresh_states`
    );
    return row ? decodeSafeInteger(row.max_ordinal, "repair_ordinal") : 0;
  }

  /**
   * Bounded startup keyset page: `repair_ordinal <= capturedMax` and
   * `repair_ordinal > priorCursor`, ordered by the immutable AUTOINCREMENT
   * ordinal. Never offsets, never a wall-clock cutoff.
   */
  async listRepairableStatesUpTo(
    maxOrdinal: number,
    afterOrdinal: number,
    limit: number
  ): Promise<readonly ConnectorRefreshState[]> {
    if (!Number.isSafeInteger(maxOrdinal) || maxOrdinal < 0) invalid("maxOrdinal must be a non-negative integer");
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) invalid("afterOrdinal must be a non-negative integer");
    const pageLimit = pageLimitValue(limit);
    const rows = await this.ledger.all<StateRow>(
      `SELECT ${STATE_COLUMNS} FROM connector_refresh_states
       WHERE repair_ordinal<=? AND repair_ordinal>? ORDER BY repair_ordinal LIMIT ?`,
      [maxOrdinal, afterOrdinal, pageLimit]
    );
    return Object.freeze(rows.map(decodeState));
  }

  /** preparing → prepared with the exact candidate/previous identities. */
  async recordPrepared(identity: ConnectorRefreshIdentity, candidate: PreparedCandidate): Promise<boolean> {
    const values = identityInput(identity);
    return this.ledger.withImmediateTransaction((transaction) =>
      markPreparedTx(
        transaction,
        values,
        candidate.candidateLocation,
        candidate.activationPreviousLocation,
        candidate.cleanupPreviousLocation,
        this.now()
      )
    );
  }

  /** prepared → activating immediately before the external exact-location CAS. */
  async claimActivation(identity: ConnectorRefreshIdentity): Promise<boolean> {
    const values = identityInput(identity);
    return this.ledger.withImmediateTransaction((transaction) =>
      phaseCasTx(transaction, values, "prepared", "activating", [], [], this.now())
    );
  }

  /** activating → activated after the external call returned the expected version/candidate. */
  async confirmActivation(identity: ConnectorRefreshIdentity): Promise<boolean> {
    const values = identityInput(identity);
    return this.ledger.withImmediateTransaction((transaction) =>
      phaseCasTx(transaction, values, "activating", "activated", [], [], this.now())
    );
  }

  /**
   * activating → prepared for a row whose activation is proven unactivated
   * against the authoritative external current location.
   */
  async returnActivatingToPrepared(identity: ConnectorRefreshIdentity): Promise<boolean> {
    const values = identityInput(identity);
    return this.ledger.withImmediateTransaction((transaction) =>
      phaseCasTx(transaction, values, "activating", "prepared", [], [], this.now())
    );
  }

  /**
   * Failure/no-progress touch: accepts the selected row's old
   * attempts/`updated_at` as part of its expected identity, increments
   * attempts, and advances `updated_at` to the monotonic successor. A fixed or
   * backward clock still moves the failed row behind untouched work.
   */
  async touchFailedAttempt(input: {
    identity: ConnectorRefreshIdentity;
    expectedPhase: ConnectorRefreshPhase;
    expectedAttempts: number;
    expectedUpdatedAt: string;
  }): Promise<boolean> {
    const values = identityInput(input.identity);
    const expectedPhase = phaseValue(input.expectedPhase);
    if (!Number.isSafeInteger(input.expectedAttempts) || input.expectedAttempts < 0) {
      invalid("expectedAttempts must be a non-negative integer");
    }
    const expectedUpdatedAt = decodeIsoTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
    return this.ledger.withImmediateTransaction((transaction) => {
      const timestamp = nextConnectorRefreshTimestamp(this.now(), expectedUpdatedAt);
      const changed = transaction.run(
        `UPDATE connector_refresh_states
         SET attempts=attempts+1, updated_at=?
         WHERE account_id=? AND source_id=? AND connector_id=? AND generation=?
           AND refresh_version=? AND phase=? AND attempts=? AND updated_at=?`,
        [
          timestamp,
          values.accountId,
          values.sourceId,
          values.connectorId,
          values.generation,
          values.refreshVersion,
          expectedPhase,
          input.expectedAttempts,
          expectedUpdatedAt,
        ]
      );
      return changed.changes === 1;
    });
  }

  /**
   * Complete exact cleanup: delete only when the full identity still names
   * `cleanup_pending` and the same distinct cleanup location. The data
   * service must have positively confirmed cleanup first.
   */
  async completeExactCleanup(input: { identity: ConnectorRefreshIdentity; cleanupLocation: string }): Promise<boolean> {
    const values = identityInput(input.identity);
    const cleanupLocation = requiredText(input.cleanupLocation, "cleanup location");
    const changed = await this.ledger.run(
      `DELETE FROM connector_refresh_states
       WHERE account_id=? AND source_id=? AND connector_id=? AND generation=?
         AND refresh_version=? AND phase='cleanup_pending' AND cleanup_previous_location=?`,
      [values.accountId, values.sourceId, values.connectorId, values.generation, values.refreshVersion, cleanupLocation]
    );
    return changed.changes === 1;
  }

  /**
   * Fail/clear a superseded prepare: delete only the exact
   * account/source/connector/generation row still in `preparing`. Later
   * phases are never cleared here; their locations stay durable.
   */
  async clearPreparing(input: {
    accountId: string;
    sourceId: string;
    connectorId: string;
    generation: number;
  }): Promise<boolean> {
    return this.ledger.withImmediateTransaction((transaction) =>
      clearPreparingTx(transaction, {
        accountId: requiredId(input.accountId, "accountId"),
        sourceId: requiredId(input.sourceId, "sourceId"),
        connectorId: requiredId(input.connectorId, "connectorId"),
        generation: positiveGeneration(input.generation),
      })
    );
  }
}

export function createConnectorRefreshStore(
  ledger: SqliteLedger,
  options: ConnectorRefreshStoreOptions = {}
): ConnectorRefreshStore {
  return new ConnectorRefreshStore(ledger, options);
}

/* ------------------------------------------------------------------ */
/* Transaction-level primitives shared with the transition/promotion   */
/* paths. They take the caller's active transaction; nothing nests.    */
/* ------------------------------------------------------------------ */

export interface ReservePreparingInput {
  readonly accountId: string;
  readonly sourceId: string;
  readonly connectorId: string;
  readonly generation: number;
  readonly refreshVersion: string;
  readonly timestamp: string;
}

/**
 * Insert the `preparing` reservation inside the caller's reservation
 * transaction. It may replace an existing row only when the old refresh is
 * definitively superseded: a `preparing` or `prepared` row (a prepare that
 * never activated — the same supersession the legacy metadata overwrite
 * performed, now typed), or a `cleanup_pending` row whose exact cleanup
 * location is still durably queued in `dataset_cache_cleanup_jobs` (Plan 011
 * retains sole cleanup authority there). Anything else — ambiguous
 * `activating` or un-promoted `activated` — fails the CAS so the caller
 * refuses the mutation instead of discarding durable uncertainty.
 */
export function reservePreparingTx(transaction: SqliteTransaction, input: ReservePreparingInput): boolean {
  const generation = positiveGeneration(input.generation);
  const timestamp = decodeIsoTimestamp(input.timestamp, "timestamp");
  const version = requiredText(input.refreshVersion, "refresh version", MAX_VERSION_LENGTH);
  const changed = transaction.run(
    `INSERT INTO connector_refresh_states
       (source_id, account_id, connector_id, generation, refresh_version, phase,
        candidate_location, activation_previous_location, cleanup_previous_location,
        attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,'preparing',NULL,NULL,NULL,0,?,?)
     ON CONFLICT(source_id) DO UPDATE SET
       connector_id=excluded.connector_id,
       generation=excluded.generation,
       refresh_version=excluded.refresh_version,
       phase='preparing',
       candidate_location=NULL,
       activation_previous_location=NULL,
       cleanup_previous_location=NULL,
       attempts=0,
       updated_at=excluded.updated_at
     WHERE connector_refresh_states.phase IN ('preparing','prepared')
        OR (
          connector_refresh_states.phase='cleanup_pending'
          AND EXISTS (
            SELECT 1 FROM dataset_cache_cleanup_jobs
            WHERE account_id=connector_refresh_states.account_id
              AND name=(SELECT name FROM sources WHERE id=connector_refresh_states.source_id)
              AND location=connector_refresh_states.cleanup_previous_location
          )
        )`,
    [
      requiredId(input.sourceId, "sourceId"),
      requiredId(input.accountId, "accountId"),
      requiredId(input.connectorId, "connectorId"),
      generation,
      version,
      timestamp,
      timestamp,
    ]
  );
  return changed.changes === 1;
}

/** preparing → prepared inside the caller's transaction. */
export function markPreparedTx(
  transaction: SqliteTransaction,
  identity: ConnectorRefreshIdentity,
  candidateLocation: string,
  activationPreviousLocation: string | null,
  cleanupPreviousLocation: string | null,
  now: Date
): boolean {
  const values = identityInput(identity);
  const candidate = requiredText(candidateLocation, "candidate location", MAX_LOCATION_LENGTH);
  const activationPrevious = optionalText(
    activationPreviousLocation,
    "activation previous location",
    MAX_LOCATION_LENGTH
  );
  const cleanupPrevious = optionalText(cleanupPreviousLocation, "cleanup previous location", MAX_LOCATION_LENGTH);
  return phaseCasTx(
    transaction,
    values,
    "preparing",
    "prepared",
    ["candidate_location=?", "activation_previous_location=?", "cleanup_previous_location=?"],
    [candidate, activationPrevious, cleanupPrevious],
    now
  );
}

/**
 * Assert the exact `activated` identity inside the promotion transaction and
 * return the still-pending exact cleanup location (or null). Returns
 * undefined when the identity/phase is not the exact activated row.
 */
export function requireActivatedForPromotionTx(
  transaction: SqliteTransaction,
  identity: ConnectorRefreshIdentity
): { cleanupPreviousLocation: string | null } | undefined {
  const values = identityInput(identity);
  const row = transaction.get<{ cleanup_previous_location: unknown }>(
    `SELECT cleanup_previous_location FROM connector_refresh_states
     WHERE account_id=? AND source_id=? AND connector_id=? AND generation=? AND refresh_version=?
       AND phase='activated'`,
    [values.accountId, values.sourceId, values.connectorId, values.generation, values.refreshVersion]
  );
  if (!row) return undefined;
  return Object.freeze({
    cleanupPreviousLocation:
      row.cleanup_previous_location === null ? null : storedText(row.cleanup_previous_location, "cleanup location"),
  });
}

/**
 * activated → cleanup_pending (when an exact distinct previous location
 * remains) or delete (when no cleanup is needed), inside the same promotion
 * transaction. The expected activated identity is part of the CAS.
 */
export function finalizePromotionTx(
  transaction: SqliteTransaction,
  identity: ConnectorRefreshIdentity,
  cleanupPreviousLocation: string | null,
  now: Date
): boolean {
  const values = identityInput(identity);
  if (cleanupPreviousLocation === null) {
    const changed = transaction.run(
      `DELETE FROM connector_refresh_states
       WHERE account_id=? AND source_id=? AND connector_id=? AND generation=? AND refresh_version=?
         AND phase='activated'`,
      [values.accountId, values.sourceId, values.connectorId, values.generation, values.refreshVersion]
    );
    return changed.changes === 1;
  }
  const cleanup = requiredText(cleanupPreviousLocation, "cleanup previous location", MAX_LOCATION_LENGTH);
  return phaseCasTx(
    transaction,
    values,
    "activated",
    "cleanup_pending",
    ["cleanup_previous_location=?", "activation_previous_location=NULL"],
    [cleanup],
    now
  );
}

/** Fail/clear the exact superseded preparing row inside the caller's transaction. */
export function clearPreparingTx(
  transaction: SqliteTransaction,
  identity: { accountId: string; sourceId: string; connectorId: string; generation: number }
): boolean {
  const changed = transaction.run(
    `DELETE FROM connector_refresh_states
     WHERE account_id=? AND source_id=? AND connector_id=? AND generation=? AND phase='preparing'`,
    [
      requiredId(identity.accountId, "accountId"),
      requiredId(identity.sourceId, "sourceId"),
      requiredId(identity.connectorId, "connectorId"),
      positiveGeneration(identity.generation),
    ]
  );
  return changed.changes === 1;
}

/**
 * Read-only location snapshot for the source-deletion reservation. Returns
 * the exact typed candidate/activation-previous/cleanup-previous locations
 * (nulls omitted by the caller) or undefined when no typed row exists. This
 * is the plan-011 coexistence read: the durable pending intent is built from
 * these values inside the same `BEGIN IMMEDIATE` transaction before the
 * typed row cascades away.
 */
export function readRefreshLocationsForDeleteTx(
  transaction: SqliteTransaction,
  accountIdInput: string,
  sourceIdInput: string
): {
  candidateLocation: string | null;
  activationPreviousLocation: string | null;
  cleanupPreviousLocation: string | null;
} {
  const accountId = requiredId(accountIdInput, "accountId");
  const sourceId = requiredId(sourceIdInput, "sourceId");
  const row = transaction.get<{
    candidate_location: unknown;
    activation_previous_location: unknown;
    cleanup_previous_location: unknown;
  }>(
    `SELECT candidate_location, activation_previous_location, cleanup_previous_location
     FROM connector_refresh_states WHERE account_id=? AND source_id=?`,
    [accountId, sourceId]
  );
  if (!row)
    return Object.freeze({ candidateLocation: null, activationPreviousLocation: null, cleanupPreviousLocation: null });
  return Object.freeze({
    candidateLocation:
      row.candidate_location === null ? null : storedText(row.candidate_location, "candidate location"),
    activationPreviousLocation:
      row.activation_previous_location === null
        ? null
        : storedText(row.activation_previous_location, "activation previous location"),
    cleanupPreviousLocation:
      row.cleanup_previous_location === null
        ? null
        : storedText(row.cleanup_previous_location, "cleanup previous location"),
  });
}

function phaseCasTx(
  transaction: SqliteTransaction,
  values: Required<ConnectorRefreshIdentity>,
  expectedPhase: ConnectorRefreshPhase,
  nextPhase: ConnectorRefreshPhase,
  extraAssignments: readonly string[],
  extraValues: readonly (string | null)[],
  now: Date
): boolean {
  const current = transaction.get<{ updated_at: unknown }>(
    `SELECT updated_at FROM connector_refresh_states
     WHERE account_id=? AND source_id=? AND connector_id=? AND generation=? AND refresh_version=? AND phase=?`,
    [values.accountId, values.sourceId, values.connectorId, values.generation, values.refreshVersion, expectedPhase]
  );
  if (!current) return false;
  const timestamp = nextConnectorRefreshTimestamp(now, storedText(current.updated_at, "refresh updated_at"));
  const assignments = ["phase=?", ...extraAssignments, "attempts=0", "updated_at=?"];
  const changed = transaction.run(
    `UPDATE connector_refresh_states
     SET ${assignments.join(", ")}
     WHERE account_id=? AND source_id=? AND connector_id=? AND generation=?
       AND refresh_version=? AND phase=?`,
    [
      nextPhase,
      ...extraValues,
      timestamp,
      values.accountId,
      values.sourceId,
      values.connectorId,
      values.generation,
      values.refreshVersion,
      expectedPhase,
    ]
  );
  return changed.changes === 1;
}

function decodeState(row: StateRow): ConnectorRefreshState {
  const fields: ConnectorRefreshFields = {
    repairOrdinal: decodeSafeInteger(row.repair_ordinal, "refresh repair_ordinal"),
    accountId: storedText(row.account_id, "refresh account id"),
    sourceId: storedText(row.source_id, "refresh source id"),
    connectorId: storedText(row.connector_id, "refresh connector id"),
    generation: decodeSafeInteger(row.generation, "refresh generation"),
    refreshVersion: storedText(row.refresh_version, "refresh version"),
    attempts: decodeSafeInteger(row.attempts, "refresh attempts"),
    createdAt: decodeIsoTimestamp(row.created_at, "refresh created_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "refresh updated_at"),
  };
  const phase = storedEnum(row.phase, CONNECTOR_REFRESH_PHASES, "refresh phase");
  const candidate = optionalStoredText(row.candidate_location, "refresh candidate location");
  const activationPrevious = optionalStoredText(
    row.activation_previous_location,
    "refresh activation previous location"
  );
  const cleanupPrevious = optionalStoredText(row.cleanup_previous_location, "refresh cleanup previous location");
  if (phase === "preparing") {
    if (candidate !== null || activationPrevious !== null || cleanupPrevious !== null) {
      throw new SqliteCodecError("preparing connector refresh state carries a location");
    }
    return Object.freeze({
      ...fields,
      phase,
      candidateLocation: null,
      activationPreviousLocation: null,
      cleanupPreviousLocation: null,
    });
  }
  if (candidate === null) throw new SqliteCodecError("connector refresh state lacks its candidate");
  if (phase === "cleanup_pending") {
    if (activationPrevious !== null || cleanupPrevious === null || cleanupPrevious === candidate) {
      throw new SqliteCodecError("cleanup_pending connector refresh state is inconsistent");
    }
    return Object.freeze({
      ...fields,
      phase,
      candidateLocation: candidate,
      activationPreviousLocation: null,
      cleanupPreviousLocation: cleanupPrevious,
    });
  }
  if (cleanupPrevious !== null && cleanupPrevious === candidate) {
    throw new SqliteCodecError("connector refresh cleanup location matches its candidate");
  }
  return Object.freeze({
    ...fields,
    phase,
    candidateLocation: candidate,
    activationPreviousLocation: activationPrevious,
    cleanupPreviousLocation: cleanupPrevious,
  });
}

function identityInput(identity: ConnectorRefreshIdentity): Required<ConnectorRefreshIdentity> {
  return {
    accountId: requiredId(identity.accountId, "accountId"),
    sourceId: requiredId(identity.sourceId, "sourceId"),
    connectorId: requiredId(identity.connectorId, "connectorId"),
    generation: positiveGeneration(identity.generation),
    refreshVersion: requiredText(identity.refreshVersion, "refreshVersion", MAX_VERSION_LENGTH),
  };
}

function pageLimitValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    invalid(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return value;
}

function positiveGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid("generation must be positive");
  return value;
}

function phaseValue(value: unknown): ConnectorRefreshPhase {
  return storedEnum(value, CONNECTOR_REFRESH_PHASES, "phase");
}

function requiredId(value: unknown, field: string): string {
  const id = requiredText(value, field, MAX_ID_LENGTH);
  if (id.trim() !== id || id.includes("\0")) invalid(`${field} is invalid`);
  return id;
}

function requiredText(value: unknown, field: string, maxLength = MAX_LOCATION_LENGTH): string {
  if (typeof value !== "string" || value.trim().length === 0 || Array.from(value).length > maxLength) {
    invalid(`${field} is invalid`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maxLength = MAX_LOCATION_LENGTH): string | null {
  if (value === null) return null;
  return requiredText(value, field, maxLength);
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

function invalid(message: string): never {
  throw new ConnectorRefreshStoreError("CONNECTOR_REFRESH_INVALID_ARGUMENT", message);
}
