import {
  SqliteBusyError,
  SqliteCodecError,
  SqliteConstraintError,
  type SqliteConstraintKind,
  type SqliteValue,
} from "./types.js";

const SQLITE_INTEGER_MIN = -(2n ** 63n);
const SQLITE_INTEGER_MAX = 2n ** 63n - 1n;

export function encodeBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function decodeBoolean(value: unknown, field = "boolean"): boolean {
  if (value === 0 || value === 0n) return false;
  if (value === 1 || value === 1n) return true;
  throw new SqliteCodecError(`${field} is not a SQLite boolean`);
}

export function encodeJson(value: unknown, field = "JSON"): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new SqliteCodecError(`${field} is not JSON serializable`);
    return encoded;
  } catch (error) {
    if (error instanceof SqliteCodecError) throw error;
    throw new SqliteCodecError(`${field} is not JSON serializable`, { cause: error });
  }
}

export function decodeJson<T = unknown>(value: unknown, field = "JSON"): T {
  if (typeof value !== "string") throw new SqliteCodecError(`${field} is not stored as text`);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new SqliteCodecError(`${field} is invalid JSON`, { cause: error });
  }
}

export function encodeIsoTimestamp(value: Date | string, field = "timestamp"): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new SqliteCodecError(`${field} is not a valid timestamp`);
  return date.toISOString();
}

export function decodeIsoTimestamp(value: unknown, field = "timestamp"): string {
  if (typeof value !== "string") throw new SqliteCodecError(`${field} is not stored as text`);
  return encodeIsoTimestamp(value, field);
}

export function encodeSafeInteger(value: number | bigint, field = "integer"): number | bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new SqliteCodecError(`${field} is not a safe integer`);
    return value;
  }
  if (value < SQLITE_INTEGER_MIN || value > SQLITE_INTEGER_MAX) {
    throw new SqliteCodecError(`${field} is outside SQLite's signed 64-bit range`);
  }
  return value;
}

export function decodeSafeInteger(value: unknown, field = "integer"): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (
    typeof value === "bigint" &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  throw new SqliteCodecError(`${field} is not a safe integer`);
}

export function assertSqliteValue(value: unknown, field = "parameter"): asserts value is SqliteValue {
  if (value === null || typeof value === "string" || Buffer.isBuffer(value)) return;
  if (typeof value === "bigint") {
    encodeSafeInteger(value, field);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) encodeSafeInteger(value, field);
    return;
  }
  throw new SqliteCodecError(`${field} is not a supported SQLite value`);
}

export function normalizeSqliteError(error: unknown): unknown {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code.startsWith("SQLITE_BUSY_")) {
    return new SqliteBusyError({ cause: error });
  }
  if (!code.startsWith("SQLITE_CONSTRAINT")) return error;
  const kinds: Record<string, SqliteConstraintKind> = {
    SQLITE_CONSTRAINT_UNIQUE: "unique",
    SQLITE_CONSTRAINT_FOREIGNKEY: "foreign_key",
    SQLITE_CONSTRAINT_NOTNULL: "not_null",
    SQLITE_CONSTRAINT_CHECK: "check",
    SQLITE_CONSTRAINT_PRIMARYKEY: "primary_key",
    SQLITE_CONSTRAINT_TRIGGER: "foreign_key",
  };
  return new SqliteConstraintError(kinds[code] ?? "other", { cause: error });
}
