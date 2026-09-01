export const DEFAULT_CATALOG_PAGE_LIMIT = 50;
export const MAX_CATALOG_PAGE_LIMIT = 100;
export const MAX_CATALOG_CURSOR_CHARS = 512;

const MAX_CURSOR_DECODED_BYTES = 256;
const CURSOR_VERSION = 1;
// Catalog cursors are emitted only from canonical, lower-case persisted UUIDs.
// Reject alternate spellings rather than normalizing attacker-controlled cursor
// fields into a different keyset position.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type CatalogEndpoint =
  "sources" | "connectors" | "chats" | "reports" | "shared_reports" | "agents" | "libraries" | "automations";

export interface CatalogPosition {
  readonly timestamp: string;
  readonly id: string;
}

export interface CatalogPageRequest {
  readonly limit: number;
  readonly after: CatalogPosition | null;
}

export interface CatalogStorePage<T> {
  readonly items: T[];
  readonly next: CatalogPosition | null;
}

export interface CatalogResponse<T> {
  readonly items: T[];
  readonly next_cursor: string | null;
}

export class CatalogCursorError extends Error {
  readonly code = "INVALID_CATALOG_CURSOR";
  readonly statusCode = 400;

  constructor() {
    super("invalid catalog cursor");
    this.name = "CatalogCursorError";
  }
}

export const catalogPageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: MAX_CATALOG_PAGE_LIMIT },
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: MAX_CATALOG_CURSOR_CHARS,
      pattern: "^[A-Za-z0-9_-]+$",
    },
  },
} as const;

export function parseCatalogPageQuery(endpoint: CatalogEndpoint, value: unknown): CatalogPageRequest {
  const query = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const limit = query.limit === undefined ? DEFAULT_CATALOG_PAGE_LIMIT : query.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_CATALOG_PAGE_LIMIT) {
    throw new CatalogCursorError();
  }
  if (query.cursor === undefined) return { limit: Number(limit), after: null };
  if (typeof query.cursor !== "string") throw new CatalogCursorError();
  return { limit: Number(limit), after: decodeCatalogCursor(endpoint, query.cursor) };
}

export function defaultCatalogPageRequest(): CatalogPageRequest {
  return { limit: DEFAULT_CATALOG_PAGE_LIMIT, after: null };
}

export function validateCatalogPageRequest(value: CatalogPageRequest): CatalogPageRequest {
  if (!value || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_CATALOG_PAGE_LIMIT) {
    throw new CatalogCursorError();
  }
  return { limit: value.limit, after: value.after === null ? null : validatePosition(value.after) };
}

export function catalogStorePage<T>(
  rows: readonly T[],
  requestValue: CatalogPageRequest,
  position: (item: T) => CatalogPosition
): CatalogStorePage<T> {
  const request = validateCatalogPageRequest(requestValue);
  const items = rows.slice(0, request.limit);
  return {
    items,
    next: rows.length > request.limit && items.length ? validatePosition(position(items[items.length - 1])) : null,
  };
}

export function catalogResponse<T>(endpoint: CatalogEndpoint, page: CatalogStorePage<T>): CatalogResponse<T> {
  return {
    items: page.items,
    next_cursor: page.next === null ? null : encodeCatalogCursor(endpoint, page.next),
  };
}

export function encodeCatalogCursor(endpoint: CatalogEndpoint, positionValue: CatalogPosition): string {
  const position = validatePosition(positionValue);
  const payload = JSON.stringify({ v: CURSOR_VERSION, e: endpoint, t: position.timestamp, i: position.id });
  if (Buffer.byteLength(payload, "utf8") > MAX_CURSOR_DECODED_BYTES) throw new CatalogCursorError();
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCatalogCursor(endpoint: CatalogEndpoint, cursor: string): CatalogPosition {
  if (
    typeof cursor !== "string" ||
    cursor.length < 1 ||
    cursor.length > MAX_CATALOG_CURSOR_CHARS ||
    !BASE64URL_PATTERN.test(cursor)
  ) {
    throw new CatalogCursorError();
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(cursor, "base64url");
  } catch {
    throw new CatalogCursorError();
  }
  if (bytes.length < 1 || bytes.length > MAX_CURSOR_DECODED_BYTES || bytes.toString("base64url") !== cursor) {
    throw new CatalogCursorError();
  }
  let payload: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    payload = JSON.parse(text);
  } catch {
    throw new CatalogCursorError();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new CatalogCursorError();
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "e,i,t,v" || record.v !== CURSOR_VERSION || record.e !== endpoint) {
    throw new CatalogCursorError();
  }
  return validatePosition({ timestamp: record.t as string, id: record.i as string });
}

function validatePosition(value: CatalogPosition): CatalogPosition {
  if (
    !value ||
    typeof value.timestamp !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value.timestamp) ||
    !Number.isFinite(new Date(value.timestamp).getTime()) ||
    new Date(value.timestamp).toISOString() !== value.timestamp ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id)
  ) {
    throw new CatalogCursorError();
  }
  return { timestamp: value.timestamp, id: value.id };
}
