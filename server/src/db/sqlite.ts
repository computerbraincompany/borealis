import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { assertSqliteValue, decodeSafeInteger, normalizeSqliteError } from "./codecs.js";
import { migrateSqlite } from "./migrations.js";
import {
  SqliteClosedError,
  SqliteTransactionUsageError,
  type OpenSqliteLedgerOptions,
  type SqliteLedger,
  type SqliteParameters,
  type SqliteRunResult,
  type SqliteTransaction,
} from "./types.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 30_000;
const transactionContext = new AsyncLocalStorage<string>();

class SerialGate {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

interface SharedGate {
  readonly gate: SerialGate;
  references: number;
}

const writerGates = new Map<string, SharedGate>();

function retainWriterGate(key: string): { gate: SerialGate; release: () => void } {
  const shared = writerGates.get(key) ?? { gate: new SerialGate(), references: 0 };
  shared.references += 1;
  writerGates.set(key, shared);
  let retained = true;
  return {
    gate: shared.gate,
    release: () => {
      if (!retained) return;
      retained = false;
      shared.references -= 1;
      if (shared.references === 0 && writerGates.get(key) === shared) writerGates.delete(key);
    },
  };
}

function busyTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be an integer between 1 and ${MAX_BUSY_TIMEOUT_MS}`);
  }
  return timeout;
}

function assertParameters(parameters: SqliteParameters | undefined): void {
  if (parameters === undefined) return;
  if (Array.isArray(parameters)) {
    parameters.forEach((value, index) => assertSqliteValue(value, `parameter ${index + 1}`));
    return;
  }
  Object.entries(parameters).forEach(([key, value]) => assertSqliteValue(value, `parameter ${key}`));
}

function invokeStatement<T>(
  database: Database.Database,
  method: "all" | "get" | "run",
  sql: string,
  parameters?: SqliteParameters
): T {
  assertParameters(parameters);
  try {
    const statement = database.prepare(sql);
    const invoke = statement[method] as (...values: any[]) => unknown;
    if (parameters === undefined) return invoke.call(statement) as T;
    if (Array.isArray(parameters)) return invoke.call(statement, ...parameters) as T;
    return invoke.call(statement, parameters) as T;
  } catch (error) {
    throw normalizeSqliteError(error);
  }
}

function runStatement(database: Database.Database, sql: string, parameters?: SqliteParameters): SqliteRunResult {
  const result = invokeStatement<Database.RunResult>(database, "run", sql, parameters);
  return {
    changes: decodeSafeInteger(result.changes, "changes"),
    lastInsertRowid: decodeSafeInteger(result.lastInsertRowid, "lastInsertRowid"),
  };
}

function assertNoTransactionControl(sql: string): void {
  if (/(?:^|;)\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) {
    throw new SqliteTransactionUsageError("transaction control is available only through withImmediateTransaction");
  }
}

class Ledger implements SqliteLedger {
  private accepting = true;
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly path: string,
    private readonly database: Database.Database,
    private readonly writerGate: SerialGate,
    private readonly releaseWriterGate: () => void
  ) {}

  async all<T = Record<string, unknown>>(sql: string, parameters?: SqliteParameters): Promise<T[]> {
    return this.enqueue(() => invokeStatement<T[]>(this.database, "all", sql, parameters));
  }

  async get<T = Record<string, unknown>>(sql: string, parameters?: SqliteParameters): Promise<T | undefined> {
    return this.enqueue(() => invokeStatement<T | undefined>(this.database, "get", sql, parameters));
  }

  async run(sql: string, parameters?: SqliteParameters): Promise<SqliteRunResult> {
    return this.enqueue(() => runStatement(this.database, sql, parameters));
  }

  async exec(sql: string): Promise<void> {
    assertNoTransactionControl(sql);
    return this.enqueue(() => {
      try {
        this.database.exec(sql);
      } catch (error) {
        throw normalizeSqliteError(error);
      }
    });
  }

  async withImmediateTransaction<T>(work: (transaction: SqliteTransaction) => T | Promise<T>): Promise<T> {
    this.assertCallable();
    return this.writerGate.run(async () => {
      this.assertNativeOpen();
      try {
        this.database.exec("BEGIN IMMEDIATE");
      } catch (error) {
        throw normalizeSqliteError(error);
      }
      let inTransaction = true;
      let active = true;
      const assertActive = () => {
        if (!active || !this.database.inTransaction) {
          throw new SqliteTransactionUsageError("SQLite transaction handle is no longer active");
        }
      };
      const transaction: SqliteTransaction = {
        all: <Row = Record<string, unknown>>(sql: string, parameters?: SqliteParameters) => {
          assertActive();
          return invokeStatement<Row[]>(this.database, "all", sql, parameters);
        },
        get: <Row = Record<string, unknown>>(sql: string, parameters?: SqliteParameters) => {
          assertActive();
          return invokeStatement<Row | undefined>(this.database, "get", sql, parameters);
        },
        run: (sql: string, parameters?: SqliteParameters) => {
          assertActive();
          return runStatement(this.database, sql, parameters);
        },
        exec: (sql: string) => {
          assertActive();
          assertNoTransactionControl(sql);
          try {
            this.database.exec(sql);
          } catch (error) {
            throw normalizeSqliteError(error);
          }
        },
      };
      try {
        const result = await transactionContext.run(this.path, () => work(transaction));
        active = false;
        this.database.exec("COMMIT");
        inTransaction = false;
        return result;
      } catch (error) {
        active = false;
        if (inTransaction) {
          try {
            this.database.exec("ROLLBACK");
          } catch {
            // Preserve the operation failure; close/reopen recovery is authoritative.
          }
        }
        throw normalizeSqliteError(error);
      }
    });
  }

  async health(): Promise<boolean> {
    if (!this.accepting || !this.database.open) return false;
    try {
      const row = await this.get<{ ok: bigint }>("SELECT 1 AS ok");
      return row?.ok === 1n;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.assertNotReentrant();
    this.accepting = false;
    this.closePromise = this.writerGate
      .run(() => {
        if (this.database.open) this.database.close();
      })
      .finally(this.releaseWriterGate);
    return this.closePromise;
  }

  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    this.assertCallable();
    return this.writerGate.run(() => {
      this.assertNativeOpen();
      return work();
    });
  }

  private assertCallable(): void {
    this.assertNotReentrant();
    if (!this.accepting) throw new SqliteClosedError();
  }

  private assertNotReentrant(): void {
    if (transactionContext.getStore() === this.path) {
      throw new SqliteTransactionUsageError("use the transaction handle inside withImmediateTransaction");
    }
  }

  private assertNativeOpen(): void {
    if (!this.database.open) throw new SqliteClosedError();
  }
}

export async function openSqliteLedger(options: OpenSqliteLedgerOptions): Promise<SqliteLedger> {
  if (!options.path || options.path === ":memory:") {
    throw new TypeError("SQLite ledger requires a file path");
  }
  const timeout = busyTimeout(options.busyTimeoutMs);
  const requestedFilename = path.resolve(options.path);
  await fs.mkdir(path.dirname(requestedFilename), { recursive: true });
  const realParent = await fs.realpath(path.dirname(requestedFilename));
  const parentCanonicalFilename = path.join(realParent, path.basename(requestedFilename));
  const filename = await fs.realpath(parentCanonicalFilename).catch((error: unknown) => {
    if ((error as { code?: unknown })?.code === "ENOENT") return parentCanonicalFilename;
    throw error;
  });
  const retained = retainWriterGate(filename);
  try {
    return await retained.gate.run(() => {
      const database = new Database(filename, { timeout });
      try {
        database.pragma("foreign_keys = ON");
        database.pragma(`busy_timeout = ${timeout}`);
        database.pragma("trusted_schema = OFF");
        const journalMode = database.pragma("journal_mode = WAL", { simple: true });
        if (journalMode !== "wal") throw new Error("SQLite WAL mode is unavailable");
        database.pragma("synchronous = FULL");
        migrateSqlite(database);
        database.defaultSafeIntegers(true);
        return new Ledger(filename, database, retained.gate, retained.release);
      } catch (error) {
        if (database.open) database.close();
        throw error;
      }
    });
  } catch (error) {
    retained.release();
    throw normalizeSqliteError(error);
  }
}
