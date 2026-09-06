import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  catalogStorePage,
  defaultCatalogPageRequest,
  validateCatalogPageRequest,
  type CatalogPageRequest,
  type CatalogStorePage,
} from "../catalogPagination.js";
import { SqliteConstraintError, type SqliteLedger, type SqliteTransaction } from "../db/types.js";

/**
 * Account-scoped MCP connection ledger (schema v17).
 *
 * Rows carry only validated non-secret configuration; credential material is
 * held by the connection secret store and never crosses this boundary. The
 * discovery snapshot table always holds exactly one published discovery per
 * connection; over-budget discoveries fail explicitly before any write rather
 * than silently dropping tools.
 */

export const CONNECTION_KINDS = ["mcp_http", "mcp_stdio"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const MAX_CONNECTIONS_PER_ACCOUNT = 20;
export const MAX_CONNECTION_NAME_CHARS = 80;
export const MAX_CONNECTION_URL_CHARS = 2_000;
export const MAX_STDIO_COMMAND_CHARS = 4_096;
export const MAX_STDIO_ARGS = 32;
export const MAX_STDIO_ARG_CHARS = 200;
export const MAX_DISCOVERY_TOOLS = 200;
export const MAX_TOOL_DESCRIPTOR_BYTES = 16 * 1024;
export const MAX_DISCOVERY_TOTAL_BYTES = 512 * 1024;
export const MAX_TOOL_NAME_CHARS = 128;
export const MAX_TOOL_DESCRIPTION_CHARS = 8_192;
export const MAX_CONNECTION_STATUS_CODE_CHARS = 64;

export type ConnectionStatus = "untested" | "ready" | "disconnected" | "error";
export const CONNECTION_STATUSES: readonly ConnectionStatus[] = ["untested", "ready", "disconnected", "error"];

export interface McpHttpConfig {
  readonly kind: "mcp_http";
  readonly url: string;
}

export interface McpStdioConfig {
  readonly kind: "mcp_stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
}

export type ConnectionConfig = McpHttpConfig | McpStdioConfig;

export interface Connection {
  readonly id: string;
  readonly name: string;
  readonly kind: ConnectionKind;
  readonly revision: number;
  readonly discovery_revision: number;
  readonly enabled: boolean;
  readonly status: ConnectionStatus;
  readonly status_code: string | null;
  readonly config: ConnectionConfig;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectionTool {
  readonly tool_id: string;
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export class ConnectionConfigError extends Error {
  readonly code = "CONNECTION_CONFIG_INVALID";
  readonly statusCode = 400;

  constructor(message = "connection configuration is invalid") {
    super(message);
    this.name = "ConnectionConfigError";
  }
}

export class DuplicateConnectionError extends Error {
  readonly code = "CONNECTION_NAME_TAKEN";
  readonly statusCode = 409;

  constructor() {
    super("a connection with this name already exists");
    this.name = "DuplicateConnectionError";
  }
}

export class ConnectionNotFoundError extends Error {
  readonly code = "CONNECTION_NOT_FOUND";
  readonly statusCode = 404;

  constructor() {
    super("connection not found");
    this.name = "ConnectionNotFoundError";
  }
}

export class ConnectionRevisionConflictError extends Error {
  readonly code = "CONNECTION_REVISION_CONFLICT";
  readonly statusCode = 409;

  constructor() {
    super("the connection changed since it was loaded");
    this.name = "ConnectionRevisionConflictError";
  }
}

export class ConnectionLimitError extends Error {
  readonly code = "CONNECTION_LIMIT_REACHED";
  readonly statusCode = 409;

  constructor() {
    super(`an account may hold at most ${MAX_CONNECTIONS_PER_ACCOUNT} connections`);
    this.name = "ConnectionLimitError";
  }
}

export class ConnectionStatusError extends Error {
  readonly code = "CONNECTION_INVALID_STATE";
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "ConnectionStatusError";
  }
}

/** The published catalog is over one of the fixed discovery budgets. */
export class ConnectionDiscoveryLimitError extends Error {
  readonly code = "CONNECTION_DISCOVERY_OVER_LIMIT";
  readonly statusCode = 502;

  constructor() {
    super("the discovered tool catalog exceeds the supported budgets");
    this.name = "ConnectionDiscoveryLimitError";
  }
}

/** A discovery descriptor is malformed rather than merely over budget. */
export class ConnectionDiscoveryInvalidError extends Error {
  readonly code = "CONNECTION_DISCOVERY_INVALID";
  readonly statusCode = 502;

  constructor(message = "a discovered tool descriptor is invalid") {
    super(message);
    this.name = "ConnectionDiscoveryInvalidError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\0")) {
    throw new TypeError(`${field} violates the connection store input contract`);
  }
  return UUID_PATTERN.test(value) ? value.toLowerCase() : value;
}

function connectionName(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > MAX_CONNECTION_NAME_CHARS || trimmed.includes("\0")) {
    throw new ConnectionConfigError("connection name must be 1-80 characters");
  }
  return trimmed;
}

function containsControlCharacter(value: string): boolean {
  // Control characters, CR, LF, and NUL are refused for spawn/path material.
  return /[\0\r\n]/.test(value);
}

/** True when the URL may legitimately be reached over plain HTTP. */
function isHttpAllowedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  if (isIP(normalized) === 6) return normalized === "::1";
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local");
}

function httpConfig(value: unknown): McpHttpConfig {
  const input = value as { url?: unknown };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConnectionConfigError();
  if (Object.keys(input).some((key) => key !== "url")) throw new ConnectionConfigError();
  const raw = input.url;
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > MAX_CONNECTION_URL_CHARS ||
    containsControlCharacter(raw)
  ) {
    throw new ConnectionConfigError("connection url is invalid");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectionConfigError("connection url is invalid");
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isHttpAllowedHost(url.hostname))) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length < 1 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    // HTTPS except explicit loopback/.local development targets; URL
    // credentials, queries, and fragments are never part of an endpoint.
    throw new ConnectionConfigError("connection url is invalid");
  }
  return Object.freeze({ kind: "mcp_http", url: raw });
}

function stdioConfig(value: unknown): McpStdioConfig {
  const input = value as { command?: unknown; args?: unknown; cwd?: unknown };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConnectionConfigError();
  if (Object.keys(input).some((key) => key !== "command" && key !== "args" && key !== "cwd")) {
    throw new ConnectionConfigError();
  }
  const command = input.command;
  if (
    typeof command !== "string" ||
    command.length < 1 ||
    command.length > MAX_STDIO_COMMAND_CHARS ||
    !command.startsWith("/") ||
    containsControlCharacter(command)
  ) {
    // Stdio is operator-only: an absolute installed executable, spawned
    // directly without a shell. Never a package name or `npx` recipe.
    throw new ConnectionConfigError("stdio command must be an absolute executable path");
  }
  const rawArgs = input.args === undefined ? [] : input.args;
  if (
    !Array.isArray(rawArgs) ||
    rawArgs.length > MAX_STDIO_ARGS ||
    rawArgs.some(
      (arg) =>
        typeof arg !== "string" || arg.length < 1 || arg.length > MAX_STDIO_ARG_CHARS || containsControlCharacter(arg)
    )
  ) {
    throw new ConnectionConfigError("stdio arguments must be at most 32 bounded strings");
  }
  const cwd = input.cwd === undefined || input.cwd === null ? null : input.cwd;
  if (
    cwd !== null &&
    (typeof cwd !== "string" ||
      cwd.length < 1 ||
      cwd.length > MAX_STDIO_COMMAND_CHARS ||
      !cwd.startsWith("/") ||
      containsControlCharacter(cwd))
  ) {
    throw new ConnectionConfigError("stdio working directory must be an absolute path");
  }
  return Object.freeze({
    kind: "mcp_stdio",
    command,
    args: Object.freeze([...(rawArgs as string[])]),
    cwd,
  });
}

/**
 * Kind adapters own the strict non-secret configuration shape. M14's webdav
 * integration registers an adapter here and ships its own migration widening
 * the v17 `kind` CHECK; nothing else in this module changes for a new kind.
 * That seam is the documented contract — registering an adapter without the
 * companion migration fails closed against the schema CHECK.
 */
export interface ConnectionKindAdapter {
  readonly kind: ConnectionKind;
  /** Validates and canonicalizes the stored non-secret configuration. */
  validateConfig(value: unknown): ConnectionConfig;
}

const kindAdapters = new Map<ConnectionKind, ConnectionKindAdapter>([
  [
    "mcp_http",
    {
      kind: "mcp_http",
      validateConfig: (value) => httpConfig(value),
    },
  ],
  [
    "mcp_stdio",
    {
      kind: "mcp_stdio",
      validateConfig: (value) => stdioConfig(value),
    },
  ],
]);

export function registerConnectionKindAdapter(adapter: ConnectionKindAdapter): void {
  kindAdapters.set(adapter.kind, adapter);
}

export function connectionKindAdapter(kind: unknown): ConnectionKindAdapter {
  const adapter = typeof kind === "string" ? kindAdapters.get(kind as ConnectionKind) : undefined;
  if (!adapter) throw new ConnectionConfigError("connection kind is unsupported");
  return adapter;
}

export function connectionKind(value: unknown): ConnectionKind {
  return connectionKindAdapter(value).kind;
}

function validatedConfig(kind: ConnectionKind, value: unknown): ConnectionConfig {
  return connectionKindAdapter(kind).validateConfig(value);
}

/** Revalidates stored JSON on every read; a damaged row fails closed. */
export function decodeConnectionConfig(kind: ConnectionKind, raw: unknown): ConnectionConfig {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : undefined;
  } catch {
    throw new ConnectionConfigError("stored connection configuration is unreadable");
  }
  const config = validatedConfig(kind, parsed);
  // Stored rows must round-trip through the same canonical shape they
  // arrived with; drift means the row was not written through this store.
  const canonical =
    kind === "mcp_http"
      ? { url: (config as McpHttpConfig).url }
      : {
          command: (config as McpStdioConfig).command,
          args: [...(config as McpStdioConfig).args],
          cwd: (config as McpStdioConfig).cwd,
        };
  if (JSON.stringify(parsed) !== JSON.stringify(canonical)) {
    throw new ConnectionConfigError("stored connection configuration is unreadable");
  }
  return config;
}

function toolDescriptorBytes(tool: { name: string; description: string; input_schema: unknown }): number {
  return Buffer.byteLength(
    JSON.stringify({ name: tool.name, description: tool.description, tool_input_schema: tool.input_schema }),
    "utf8"
  );
}

interface ConnectionRow {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  revision?: unknown;
  discovery_revision?: unknown;
  config?: unknown;
  enabled?: unknown;
  status?: unknown;
  status_code?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface SnapshotRow {
  tool_id?: unknown;
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
}

function decodeRow(row: ConnectionRow): Connection {
  const kind = row.kind as ConnectionKind;
  if (!CONNECTION_KINDS.includes(kind)) throw new ConnectionConfigError("stored connection kind is unsupported");
  const status = row.status as ConnectionStatus;
  if (!CONNECTION_STATUSES.includes(status)) throw new ConnectionConfigError("stored connection status is invalid");
  const statusCode = row.status_code;
  if (statusCode !== null && typeof statusCode !== "string") {
    throw new ConnectionConfigError("stored connection status code is invalid");
  }
  return Object.freeze({
    id: requiredId(row.id as string, "connection id"),
    name: row.name as string,
    kind,
    revision: Number(row.revision),
    discovery_revision: Number(row.discovery_revision),
    enabled: Number(row.enabled) === 1,
    status,
    status_code: statusCode === null ? null : statusCode,
    config: decodeConnectionConfig(kind, row.config),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  });
}

function decodeTool(row: SnapshotRow): ConnectionTool {
  let schema: unknown;
  try {
    schema = typeof row.input_schema === "string" ? JSON.parse(row.input_schema) : undefined;
  } catch {
    throw new ConnectionDiscoveryInvalidError();
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new ConnectionDiscoveryInvalidError();
  return Object.freeze({
    tool_id: row.tool_id as string,
    name: row.name as string,
    description: row.description as string,
    input_schema: schema as Record<string, unknown>,
  });
}

/**
 * Runs inside the connection-deletion transaction before the row is removed.
 * Stage 4's agent-store wiring uses this to mark bindings that referenced the
 * connection as visibly unavailable; a throwing hook rolls the whole delete
 * back (fail closed) so no binding can point at a half-deleted connection.
 */
export type ConnectionDeletionHook = (transaction: SqliteTransaction, accountId: string, connectionId: string) => void;

export interface CreateConnectionInput {
  readonly name: string;
  readonly kind: unknown;
  readonly config: unknown;
  readonly enabled?: boolean;
}

export interface UpdateConnectionPatch {
  readonly name?: string;
  readonly config?: unknown;
  readonly enabled?: boolean;
  /** Client's loaded revision; a mismatch is an optimistic-concurrency conflict. */
  readonly expected_revision: number;
}

export interface DiscoveredToolInput {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface PublishedDiscovery {
  readonly discovery_revision: number;
  readonly tools: readonly ConnectionTool[];
}

export class ConnectionStore {
  private readonly deletionHooks: ConnectionDeletionHook[] = [];

  constructor(private readonly ledger: SqliteLedger) {}

  /** Documented stage-4 seam; hooks run inside the delete transaction. */
  registerConnectionDeletionHook(hook: ConnectionDeletionHook): void {
    this.deletionHooks.push(hook);
  }

  async listConnections(
    accountIdValue: string,
    pageValue: CatalogPageRequest = defaultCatalogPageRequest()
  ): Promise<CatalogStorePage<Connection>> {
    const page = validateCatalogPageRequest(pageValue);
    const parameters: Array<string | number> = [requiredId(accountIdValue, "account id")];
    const after = page.after ? " AND (c.created_at,c.id) < (?,?)" : "";
    if (page.after) parameters.push(page.after.timestamp, page.after.id);
    parameters.push(page.limit + 1);
    const rows = await this.ledger.all<ConnectionRow>(
      `SELECT c.id,c.name,c.kind,c.revision,c.discovery_revision,c.config,c.enabled,c.status,c.status_code,c.created_at,c.updated_at
       FROM connections c
       WHERE c.account_id=?${after}
       ORDER BY c.created_at DESC,c.id DESC LIMIT ?`,
      parameters
    );
    return catalogStorePage(rows.map(decodeRow), page, (connection) => ({
      timestamp: connection.created_at,
      id: connection.id,
    }));
  }

  async createConnection(accountIdValue: string, input: CreateConnectionInput): Promise<Connection> {
    const accountId = requiredId(accountIdValue, "account id");
    const name = connectionName(input.name);
    const kind = connectionKind(input.kind);
    const config = validatedConfig(kind, input.config);
    const enabled = input.enabled === undefined ? true : input.enabled === true;
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      await this.ledger.withImmediateTransaction((transaction) => {
        const count = transaction.get<{ n: number | bigint }>(
          "SELECT COUNT(*) AS n FROM connections WHERE account_id=?",
          [accountId]
        );
        if (Number(count?.n ?? 0) >= MAX_CONNECTIONS_PER_ACCOUNT) throw new ConnectionLimitError();
        transaction.run(
          `INSERT INTO connections (id,account_id,name,kind,config,enabled,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,'untested',?,?)`,
          // revision and discovery_revision keep their schema defaults of 1 and 0.
          [id, accountId, name, kind, JSON.stringify(stripKind(config)), enabled ? 1 : 0, timestamp, timestamp]
        );
      });
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") throw new DuplicateConnectionError();
      throw error;
    }
    return this.requireConnection(accountId, id);
  }

  async getConnection(accountIdValue: string, connectionIdValue: string): Promise<Connection | undefined> {
    const row = await this.ledger.get<ConnectionRow>(
      `SELECT id,name,kind,revision,discovery_revision,config,enabled,status,status_code,created_at,updated_at
       FROM connections WHERE id=? AND account_id=?`,
      [requiredId(connectionIdValue, "connection id"), requiredId(accountIdValue, "account id")]
    );
    return row ? decodeRow(row) : undefined;
  }

  async requireConnection(accountId: string, connectionId: string): Promise<Connection> {
    const connection = await this.getConnection(accountId, connectionId);
    if (!connection) throw new ConnectionNotFoundError();
    return connection;
  }

  /**
   * Optimistic edit: the caller's `expected_revision` must match or nothing
   * changes. A name/config edit is a new revision and resets the bounded
   * status evidence; an enabled toggle is state checked per call by runtimes
   * and never rewrites the configuration lineage.
   */
  async updateConnection(
    accountIdValue: string,
    connectionIdValue: string,
    patch: UpdateConnectionPatch
  ): Promise<Connection> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(connectionIdValue, "connection id");
    const expected = patch.expected_revision;
    if (!Number.isSafeInteger(expected) || expected < 1)
      throw new ConnectionConfigError("expected_revision is invalid");
    try {
      await this.ledger.withImmediateTransaction((transaction) => {
        const row = transaction.get<ConnectionRow>(
          "SELECT id,kind,revision FROM connections WHERE id=? AND account_id=?",
          [connectionId, accountId]
        );
        if (!row) throw new ConnectionNotFoundError();
        if (Number(row.revision) !== expected) throw new ConnectionRevisionConflictError();
        const kind = row.kind as ConnectionKind;
        const name = patch.name === undefined ? undefined : connectionName(patch.name);
        const config = patch.config === undefined ? undefined : validatedConfig(kind, patch.config);
        const updates: string[] = [];
        const values: Array<string | number> = [];
        if (name !== undefined) {
          updates.push("name=?");
          values.push(name);
        }
        if (config !== undefined) {
          updates.push("config=?", "status='untested'", "status_code=NULL");
          values.push(JSON.stringify(stripKind(config)));
        }
        if (patch.enabled !== undefined) {
          updates.push("enabled=?");
          values.push(patch.enabled ? 1 : 0);
        }
        const editsConfiguration = name !== undefined || config !== undefined;
        if (editsConfiguration) updates.push("revision=revision+1");
        updates.push("updated_at=?");
        values.push(new Date().toISOString());
        if (updates.length === 1) return;
        const result = transaction.run(
          `UPDATE connections SET ${updates.join(",")}
           WHERE id=? AND account_id=? AND revision=?`,
          [...values, connectionId, accountId, expected]
        );
        if (result.changes !== 1) throw new ConnectionRevisionConflictError();
      });
    } catch (error) {
      if (error instanceof SqliteConstraintError && error.kind === "unique") throw new DuplicateConnectionError();
      throw error;
    }
    return this.requireConnection(accountId, connectionId);
  }

  async deleteConnection(accountIdValue: string, connectionIdValue: string): Promise<boolean> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(connectionIdValue, "connection id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<{ id: string }>("SELECT id FROM connections WHERE id=? AND account_id=?", [
        connectionId,
        accountId,
      ]);
      if (!row) return false;
      for (const hook of this.deletionHooks) hook(transaction, accountId, connectionId);
      const result = transaction.run("DELETE FROM connections WHERE id=? AND account_id=?", [connectionId, accountId]);
      return result.changes === 1;
    });
  }

  /** Bounded lifecycle status update; codes are stable identifiers, never content. */
  async recordStatus(
    accountIdValue: string,
    connectionIdValue: string,
    status: ConnectionStatus,
    code?: string | null
  ): Promise<void> {
    if (!CONNECTION_STATUSES.includes(status)) throw new ConnectionStatusError("connection status is invalid");
    const statusCode = code === undefined ? null : code;
    if (
      statusCode !== null &&
      (typeof statusCode !== "string" || statusCode.length < 1 || statusCode.length > MAX_CONNECTION_STATUS_CODE_CHARS)
    ) {
      throw new ConnectionStatusError("connection status code is invalid");
    }
    await this.ledger.run(
      `UPDATE connections SET status=?,status_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=? AND account_id=?`,
      [status, statusCode, requiredId(connectionIdValue, "connection id"), requiredId(accountIdValue, "account id")]
    );
  }

  /**
   * Publishes one validated discovery: every budget (count, per-descriptor,
   * aggregate) is proven before any write, tool identities are preserved by
   * original name, prior snapshots are replaced, and the connection's
   * `discovery_revision` advances exactly once.
   */
  async publishDiscovery(
    accountIdValue: string,
    connectionIdValue: string,
    tools: readonly DiscoveredToolInput[]
  ): Promise<PublishedDiscovery> {
    const accountId = requiredId(accountIdValue, "account id");
    const connectionId = requiredId(connectionIdValue, "connection id");
    const validated = tools.map((tool) => {
      if (
        !tool ||
        typeof tool.name !== "string" ||
        tool.name.length < 1 ||
        tool.name.length > MAX_TOOL_NAME_CHARS ||
        containsControlCharacter(tool.name) ||
        typeof tool.description !== "string" ||
        tool.description.length > MAX_TOOL_DESCRIPTION_CHARS ||
        !tool.input_schema ||
        typeof tool.input_schema !== "object" ||
        Array.isArray(tool.input_schema)
      ) {
        throw new ConnectionDiscoveryInvalidError();
      }
      return tool;
    });
    if (new Set(validated.map((tool) => tool.name)).size !== validated.length) {
      throw new ConnectionDiscoveryInvalidError("discovered tool names must be unique");
    }
    let totalBytes = 0;
    for (const tool of validated) {
      const bytes = toolDescriptorBytes(tool);
      if (bytes > MAX_TOOL_DESCRIPTOR_BYTES) throw new ConnectionDiscoveryLimitError();
      totalBytes += bytes;
    }
    if (validated.length > MAX_DISCOVERY_TOOLS || totalBytes > MAX_DISCOVERY_TOTAL_BYTES) {
      throw new ConnectionDiscoveryLimitError();
    }
    const timestamp = new Date().toISOString();
    const published = await this.ledger.withImmediateTransaction((transaction): PublishedDiscovery => {
      const row = transaction.get<{ discovery_revision: number | bigint }>(
        "SELECT discovery_revision FROM connections WHERE id=? AND account_id=?",
        [connectionId, accountId]
      );
      if (!row) throw new ConnectionNotFoundError();
      const previous = transaction.all<{ name: string; tool_id: string }>(
        "SELECT name,tool_id FROM connection_tool_snapshots WHERE connection_id=? AND account_id=?",
        [connectionId, accountId]
      );
      const idsByName = new Map(previous.map((tool) => [tool.name, tool.tool_id]));
      const discoveryRevision = Number(row.discovery_revision) + 1;
      const toolsOut: ConnectionTool[] = [];
      transaction.run("DELETE FROM connection_tool_snapshots WHERE connection_id=?", [connectionId]);
      validated.forEach((tool, position) => {
        const toolId = idsByName.get(tool.name) ?? randomUUID();
        toolsOut.push(
          Object.freeze({
            tool_id: toolId,
            name: tool.name,
            description: tool.description,
            input_schema: Object.freeze({ ...tool.input_schema }),
          })
        );
        transaction.run(
          `INSERT INTO connection_tool_snapshots (connection_id,account_id,discovery_revision,position,tool_id,name,description,input_schema,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            connectionId,
            accountId,
            discoveryRevision,
            position,
            toolId,
            tool.name,
            tool.description,
            JSON.stringify(tool.input_schema),
            timestamp,
          ]
        );
      });
      const updated = transaction.run(
        `UPDATE connections SET discovery_revision=?,status='ready',status_code=NULL,updated_at=?
         WHERE id=? AND account_id=?`,
        [discoveryRevision, timestamp, connectionId, accountId]
      );
      if (updated.changes !== 1) throw new ConnectionNotFoundError();
      return Object.freeze({ discovery_revision: discoveryRevision, tools: Object.freeze(toolsOut) });
    });
    return published;
  }

  /** The tools of the current published discovery, in stable discovery order. */
  async listTools(accountIdValue: string, connectionIdValue: string): Promise<ConnectionTool[]> {
    const rows = await this.ledger.all<SnapshotRow>(
      `SELECT s.tool_id,s.name,s.description,s.input_schema
       FROM connection_tool_snapshots s
       JOIN connections c ON c.id=s.connection_id AND c.account_id=s.account_id AND c.discovery_revision=s.discovery_revision
       WHERE s.connection_id=? AND s.account_id=?
       ORDER BY s.position`,
      [requiredId(connectionIdValue, "connection id"), requiredId(accountIdValue, "account id")]
    );
    return rows.map(decodeTool);
  }
}

function stripKind(config: ConnectionConfig): Record<string, unknown> {
  return config.kind === "mcp_http"
    ? { url: config.url }
    : { command: config.command, args: [...config.args], cwd: config.cwd };
}
