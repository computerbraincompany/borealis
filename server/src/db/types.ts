export type SqliteValue = string | number | bigint | Buffer | null;

export type SqliteParameters = readonly SqliteValue[] | Readonly<Record<string, SqliteValue>>;

export interface SqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export interface SqliteTransaction {
  all<T = Record<string, unknown>>(sql: string, parameters?: SqliteParameters): T[];
  get<T = Record<string, unknown>>(sql: string, parameters?: SqliteParameters): T | undefined;
  run(sql: string, parameters?: SqliteParameters): SqliteRunResult;
  exec(sql: string): void;
}

export interface OpenSqliteLedgerOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

export interface SqliteLedger {
  readonly path: string;
  all<T = Record<string, unknown>>(sql: string, parameters?: SqliteParameters): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, parameters?: SqliteParameters): Promise<T | undefined>;
  run(sql: string, parameters?: SqliteParameters): Promise<SqliteRunResult>;
  exec(sql: string): Promise<void>;
  withImmediateTransaction<T>(work: (transaction: SqliteTransaction) => T | Promise<T>): Promise<T>;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

export type SqliteConstraintKind = "unique" | "foreign_key" | "not_null" | "check" | "primary_key" | "other";

export class SqliteConstraintError extends Error {
  readonly code: string;

  constructor(
    readonly kind: SqliteConstraintKind,
    options: ErrorOptions = {}
  ) {
    super(`${kind.replaceAll("_", " ")} constraint violated`, options);
    this.name = "SqliteConstraintError";
    this.code = `LEDGER_CONSTRAINT_${kind.toUpperCase()}`;
  }
}

export class SqliteBusyError extends Error {
  readonly code = "LEDGER_BUSY";

  constructor(options: ErrorOptions = {}) {
    super("SQLite ledger is busy", options);
    this.name = "SqliteBusyError";
  }
}

export class SqliteClosedError extends Error {
  readonly code = "LEDGER_CLOSED";

  constructor() {
    super("SQLite ledger is closed");
    this.name = "SqliteClosedError";
  }
}

export class SqliteTransactionUsageError extends Error {
  readonly code = "LEDGER_TRANSACTION_USAGE";

  constructor(message: string) {
    super(message);
    this.name = "SqliteTransactionUsageError";
  }
}

export class SqliteMigrationError extends Error {
  readonly code = "LEDGER_MIGRATION";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "SqliteMigrationError";
  }
}

export class SqliteCodecError extends Error {
  readonly code = "LEDGER_CODEC";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "SqliteCodecError";
  }
}
