import { randomUUID } from "node:crypto";

import {
  decodeBoolean,
  decodeIsoTimestamp,
  decodeJson,
  decodeSafeInteger,
  encodeBoolean,
  encodeIsoTimestamp,
  encodeJson,
} from "../codecs.js";
import { SqliteConstraintError, type SqliteLedger, type SqliteTransaction } from "../types.js";

export const MAX_CHAT_SOURCE_SCOPE = 100;
export const MAX_CHAT_HISTORY_PAGE = 100;
export const MAX_AGENT_HISTORY_MESSAGES = 500;
export const MAX_DEFAULT_CHAT_MODEL_CHARS = 200;

const DEFAULT_HISTORY_LIMIT = 80;
const DEFAULT_MAX_HISTORY_CHARS = 120_000;
const DEFAULT_MAX_MESSAGE_CHARS = 32_000;
const DEFAULT_MAX_HISTORY_META_CHARS = 32_000;
const MAX_ID_CHARS = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChatSourceMode = "all" | "selected";
export type ChatSourceScopeInput =
  { readonly source_mode: "all" } | { readonly source_mode: "selected"; readonly source_ids: readonly string[] };

export type ChatStoreErrorCode =
  "DUPLICATE_EMAIL" | "ACTIVE_CHAT_RUN" | "STORE_NOT_FOUND" | "SOURCE_SCOPE_UNAVAILABLE" | "AGENT_BINDING_UNAVAILABLE";

export class ChatStoreError extends Error {
  constructor(
    readonly code: ChatStoreErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "ChatStoreError";
  }
}

export class DuplicateEmailError extends ChatStoreError {
  constructor(options: ErrorOptions = {}) {
    super("DUPLICATE_EMAIL", "email already registered", options);
    this.name = "DuplicateEmailError";
  }
}

export class ActiveChatRunError extends ChatStoreError {
  constructor(message = "a run is already active for this chat", options: ErrorOptions = {}) {
    super("ACTIVE_CHAT_RUN", message, options);
    this.name = "ActiveChatRunError";
  }
}

export class StoreNotFoundError extends ChatStoreError {
  constructor(
    readonly resource: "chat" | "run" | "user",
    options: ErrorOptions = {}
  ) {
    super("STORE_NOT_FOUND", `${resource} not found`, options);
    this.name = "StoreNotFoundError";
  }
}

/** The chat-creation body referenced an unknown or foreign agent. */
export class AgentBindingUnavailableError extends ChatStoreError {
  constructor() {
    super("AGENT_BINDING_UNAVAILABLE", "invalid agent_id");
    this.name = "AgentBindingUnavailableError";
  }
}

export class SourceScopeUnavailableError extends ChatStoreError {
  readonly reason: "missing_sources" | "scope_limit";

  constructor(
    message = "one or more sources are unavailable",
    options: ErrorOptions & { readonly reason?: "missing_sources" | "scope_limit" } = {}
  ) {
    super("SOURCE_SCOPE_UNAVAILABLE", message, options);
    this.name = "SourceScopeUnavailableError";
    this.reason = options.reason ?? "missing_sources";
  }
}

export interface ChatStoreOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

export interface CreateUserInput {
  readonly email: string;
  readonly passwordHash: string;
}

export interface StoredUser {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly created_at: string;
}

export interface ChatSummary {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly source_mode: ChatSourceMode;
  /** Write-once agent binding from chat creation; null when unbound. */
  readonly agent: Readonly<{ id: string; name: string }> | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateChatInput {
  readonly accountId: string;
  readonly title: string;
  readonly titleIsManual: boolean;
  readonly model: string;
  readonly sourceScope: ChatSourceScopeInput;
  readonly agentId?: string | null;
}

export interface AttachedChatSource {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
  readonly kind: string;
  readonly status: string;
}

export interface ResolvedChatSourceScope {
  readonly mode: ChatSourceMode;
  readonly attached: readonly Readonly<AttachedChatSource>[];
  readonly readySourceIds: readonly string[];
  readonly readyTableNames: readonly string[];
}

export interface ChatHistoryMessage {
  readonly id: number;
  readonly role: "user" | "assistant" | "system";
  readonly content: string | null;
  readonly meta: unknown;
  readonly created_at: string;
}

export interface ActiveChatRun {
  readonly id: string;
  readonly status: "running" | "cancelling";
}

export interface ChatSnapshot extends ChatSummary {
  readonly sources: readonly Readonly<AttachedChatSource>[];
  readonly messages: readonly Readonly<ChatHistoryMessage>[];
  readonly active_run: Readonly<ActiveChatRun> | null;
  readonly messages_page: Readonly<{
    has_more: boolean;
    next_before_message_id: number | null;
  }>;
}

export interface ChatSnapshotOptions {
  readonly beforeMessageId?: number;
  readonly limit?: number;
  readonly maxHistoryChars?: number;
  readonly maxMessageChars?: number;
  readonly maxHistoryMetaChars?: number;
}

export interface AgentHistoryOptions {
  readonly limit?: number;
  readonly maxMessageChars?: number;
}

export interface AgentHistoryMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string | null;
}

export interface AcceptedUserMessage {
  readonly id: number;
  readonly role: "user";
  readonly content: string;
  readonly meta: Readonly<{
    model: string;
    source_mode: ChatSourceMode;
    source_ids: readonly string[];
  }>;
  readonly created_at: string;
}

export interface AcceptedChatTurn {
  readonly chatId: string;
  readonly model: string;
  readonly sourceScope: ResolvedChatSourceScope;
  /** Snapshot of the chat's bound agent at accept time; null when unbound. */
  readonly agent: Readonly<{ id: string; name: string; version: number; instructions: string }> | null;
  readonly userMessage: AcceptedUserMessage;
  readonly runId: string;
}

export interface AcceptChatTurnTestHooks {
  /** Transaction barrier for behavior tests. Production callers must omit it. */
  readonly afterSnapshot?: (turn: Omit<AcceptedChatTurn, "userMessage">) => Promise<void>;
}

export interface ReplaceSourceScopeTestHooks {
  /** Transaction barrier for behavior tests. Production callers must omit it. */
  readonly afterDelete?: () => Promise<void>;
}

export interface DeleteChatTestHooks {
  /** Transaction barrier for behavior tests. Production callers must omit it. */
  readonly afterDelete?: () => Promise<void>;
}

interface UserRow {
  id?: unknown;
  email?: unknown;
  password_hash?: unknown;
  created_at?: unknown;
}

interface ChatRow {
  id?: unknown;
  title?: unknown;
  title_is_manual?: unknown;
  model?: unknown;
  source_mode?: unknown;
  agent_id?: unknown;
  agent_name?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface SourceRow {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  kind?: unknown;
  status?: unknown;
}

interface MessageRow {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  content_was_truncated?: unknown;
  meta?: unknown;
  created_at?: unknown;
}

interface ActiveRunRow {
  id?: unknown;
  status?: unknown;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is not stored as text`);
  return value;
}

function inputString(value: string, field: string, maximum = MAX_ID_CHARS): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${field} must contain between 1 and ${maximum} characters without NUL`);
  }
  return value;
}

function inputCodePointString(value: string, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || Array.from(value).length > maximum || value.includes("\0")) {
    throw new TypeError(`${field} must contain between 1 and ${maximum} characters without NUL`);
  }
  return value;
}

function identity(value: string, field: string): string {
  const normalized = inputString(value, field);
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
}

function sourceMode(value: unknown): ChatSourceMode {
  if (value === "all" || value === "selected") return value;
  throw new TypeError("source_mode violates the chat store contract");
}

function historyRole(value: unknown): ChatHistoryMessage["role"] {
  if (value === "user" || value === "assistant" || value === "system") return value;
  throw new TypeError("role violates the chat store contract");
}

function decodeUser(row: UserRow): StoredUser {
  return Object.freeze({
    id: requiredString(row.id, "user id"),
    email: requiredString(row.email, "email"),
    password_hash: requiredString(row.password_hash, "password hash"),
    created_at: decodeIsoTimestamp(row.created_at, "user created_at"),
  });
}

function decodeChat(row: ChatRow): ChatSummary {
  const agentId =
    row.agent_id === null || row.agent_id === undefined ? null : requiredString(row.agent_id, "chat agent id");
  return Object.freeze({
    id: requiredString(row.id, "chat id"),
    title: requiredString(row.title, "chat title"),
    model: requiredString(row.model, "chat model"),
    source_mode: sourceMode(row.source_mode),
    agent:
      agentId === null ? null : Object.freeze({ id: agentId, name: requiredString(row.agent_name, "chat agent name") }),
    created_at: decodeIsoTimestamp(row.created_at, "chat created_at"),
    updated_at: decodeIsoTimestamp(row.updated_at, "chat updated_at"),
  });
}

function decodeSource(row: SourceRow): AttachedChatSource {
  return Object.freeze({
    id: requiredString(row.id, "source id"),
    name: requiredString(row.name, "source name"),
    display_name: requiredString(row.display_name, "source display name"),
    kind: requiredString(row.kind, "source kind"),
    status: requiredString(row.status, "source status"),
  });
}

function resolveRows(mode: ChatSourceMode, rows: readonly SourceRow[]): ResolvedChatSourceScope {
  if (rows.length > MAX_CHAT_SOURCE_SCOPE) {
    throw new SourceScopeUnavailableError(
      `chat source scope exceeds ${MAX_CHAT_SOURCE_SCOPE} sources; select a smaller set`,
      { reason: "scope_limit" }
    );
  }
  const attached = Object.freeze(rows.map((row) => decodeSource(row)));
  const ready = attached.filter((source) => source.status === "ready");
  return Object.freeze({
    mode,
    attached,
    readySourceIds: Object.freeze(ready.map((source) => source.id)),
    readyTableNames: Object.freeze(ready.filter((source) => source.kind === "tabular").map((source) => source.name)),
  });
}

function normalizedScope(input: ChatSourceScopeInput): ChatSourceScopeInput {
  if (!input || typeof input !== "object") throw new SourceScopeUnavailableError();
  if (input.source_mode === "all") return Object.freeze({ source_mode: "all" });
  if (input.source_mode !== "selected" || !Array.isArray(input.source_ids)) {
    throw new SourceScopeUnavailableError();
  }
  if (input.source_ids.length > MAX_CHAT_SOURCE_SCOPE) {
    throw new SourceScopeUnavailableError(`source scope must contain at most ${MAX_CHAT_SOURCE_SCOPE} sources`, {
      reason: "scope_limit",
    });
  }
  const ids = input.source_ids.map((id) => identity(id, "source id"));
  return Object.freeze({ source_mode: "selected", source_ids: Object.freeze([...new Set(ids)]) });
}

function placeholders(length: number): string {
  return new Array<string>(length).fill("?").join(",");
}

function boundedPositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function historyMessage(row: MessageRow): ChatHistoryMessage {
  const content = row.content === null ? null : requiredString(row.content, "message content");
  let meta = decodeJson(row.meta, "message meta");
  if (decodeBoolean(row.content_was_truncated, "content_was_truncated")) meta = markContentTruncated(meta);
  return Object.freeze({
    id: decodeSafeInteger(row.id, "message id"),
    role: historyRole(row.role),
    content,
    meta,
    created_at: decodeIsoTimestamp(row.created_at, "message created_at"),
  });
}

function markContentTruncated(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? { ...(meta as Record<string, unknown>), content_truncated: true }
    : { content_truncated: true };
}

function aggregateBoundedHistory(
  newestFirstRows: readonly MessageRow[],
  limit: number,
  maxHistoryChars: number
): { messages: readonly Readonly<ChatHistoryMessage>[]; hasMore: boolean } {
  const newestFirst = newestFirstRows.slice(0, limit).map((row) => historyMessage(row));
  const accepted: ChatHistoryMessage[] = [];
  let used = 2;
  let hasMore = newestFirstRows.length > limit;
  for (let index = 0; index < newestFirst.length; index += 1) {
    const message = newestFirst[index];
    const cost = JSON.stringify(message).length + (accepted.length ? 1 : 0);
    if (used + cost > maxHistoryChars) {
      if (!accepted.length && typeof message.content === "string") {
        const points = Array.from(message.content);
        const meta = markContentTruncated(message.meta);
        let low = 0;
        let high = points.length;
        let fitting: ChatHistoryMessage | undefined;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const candidate = Object.freeze({ ...message, content: points.slice(0, middle).join(""), meta });
          if (2 + JSON.stringify(candidate).length <= maxHistoryChars) {
            fitting = candidate;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        if (fitting) accepted.push(fitting);
      }
      hasMore = accepted.length === 0 || index + 1 < newestFirst.length || newestFirstRows.length > limit;
      break;
    }
    accepted.push(message);
    used += cost;
  }
  if (accepted.length < newestFirstRows.length) hasMore = true;
  return { messages: Object.freeze(accepted.reverse()), hasMore };
}

export class ChatStore {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: ChatStoreOptions = {}
  ) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async createUser(input: CreateUserInput): Promise<StoredUser> {
    const email = inputString(input.email.trim().toLowerCase(), "email", 254);
    const passwordHash = inputString(input.passwordHash, "password hash", 4_096);
    const id = identity(this.createId(), "generated user id");
    const createdAt = this.timestamp();
    try {
      return await this.ledger.withImmediateTransaction((transaction) => {
        if (transaction.get("SELECT 1 FROM users WHERE email=?", [email])) throw new DuplicateEmailError();
        const row = transaction.get<UserRow>(
          `INSERT INTO users (id,email,password_hash,created_at)
           VALUES (?,?,?,?) RETURNING id,email,password_hash,created_at`,
          [id, email, passwordHash, createdAt]
        );
        if (!row) throw new StoreNotFoundError("user");
        return decodeUser(row);
      });
    } catch (error) {
      if (error instanceof DuplicateEmailError) throw error;
      if (error instanceof SqliteConstraintError && error.kind === "unique") {
        const duplicate = await this.ledger.get("SELECT 1 FROM users WHERE email=?", [email]);
        if (duplicate) throw new DuplicateEmailError({ cause: error });
      }
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<StoredUser | undefined> {
    const normalized = inputString(email.trim().toLowerCase(), "email", 254);
    const row = await this.ledger.get<UserRow>("SELECT id,email,password_hash,created_at FROM users WHERE email=?", [
      normalized,
    ]);
    return row ? decodeUser(row) : undefined;
  }

  async findUserById(id: string): Promise<StoredUser | undefined> {
    const row = await this.ledger.get<UserRow>("SELECT id,email,password_hash,created_at FROM users WHERE id=?", [
      identity(id, "user id"),
    ]);
    return row ? decodeUser(row) : undefined;
  }

  async getRemoteEgressAckAt(accountIdValue: string): Promise<string | null> {
    const row = await this.ledger.get<{ remote_egress_ack_at?: unknown }>(
      "SELECT remote_egress_ack_at FROM users WHERE id=?",
      [identity(accountIdValue, "account id")]
    );
    if (!row) throw new StoreNotFoundError("user");
    const raw = row.remote_egress_ack_at;
    return raw === null || raw === undefined ? null : requiredString(raw, "remote egress acknowledgment");
  }

  async acknowledgeRemoteEgress(accountIdValue: string, acknowledgedAtValue: string): Promise<void> {
    const acknowledgedAt = inputString(acknowledgedAtValue, "remote egress acknowledgment", 64);
    const updated = await this.ledger.run("UPDATE users SET remote_egress_ack_at=? WHERE id=?", [
      acknowledgedAt,
      identity(accountIdValue, "account id"),
    ]);
    if (updated.changes !== 1) throw new StoreNotFoundError("user");
  }

  async getDefaultChatModel(accountIdValue: string): Promise<string | null> {
    const row = await this.ledger.get<{ default_chat_model?: unknown }>(
      "SELECT default_chat_model FROM users WHERE id=?",
      [identity(accountIdValue, "account id")]
    );
    if (!row) throw new StoreNotFoundError("user");
    const raw = row.default_chat_model;
    return raw === null || raw === undefined ? null : requiredString(raw, "default chat model");
  }

  async setDefaultChatModel(accountIdValue: string, model: string | null): Promise<string | null> {
    const trimmed = model === null ? null : model.trim();
    const normalized =
      trimmed === null || trimmed.length === 0
        ? null
        : inputString(trimmed, "default chat model", MAX_DEFAULT_CHAT_MODEL_CHARS);
    const updated = await this.ledger.run("UPDATE users SET default_chat_model=? WHERE id=?", [
      normalized,
      identity(accountIdValue, "account id"),
    ]);
    if (updated.changes !== 1) throw new StoreNotFoundError("user");
    return normalized;
  }

  async listChats(accountId: string): Promise<ChatSummary[]> {
    const rows = await this.ledger.all<ChatRow>(
      `SELECT c.id,c.title,c.model,c.source_mode,c.agent_id,ag.name AS agent_name,c.created_at,c.updated_at
       FROM chats c
       LEFT JOIN agents ag ON ag.id=c.agent_id AND ag.account_id=c.account_id
       WHERE c.account_id=? ORDER BY c.updated_at DESC,c.id DESC`,
      [identity(accountId, "account id")]
    );
    return rows.map((row) => decodeChat(row));
  }

  async createChat(input: CreateChatInput): Promise<ChatSummary> {
    const accountId = identity(input.accountId, "account id");
    const title = inputCodePointString(input.title, "chat title", 80);
    const model = inputString(input.model, "chat model", 256);
    const scope = normalizedScope(input.sourceScope);
    const id = identity(this.createId(), "generated chat id");
    const timestamp = this.timestamp();
    return this.ledger.withImmediateTransaction((transaction) => {
      this.assertUserExists(transaction, accountId);
      if (scope.source_mode === "selected") this.assertSourcesAvailable(transaction, accountId, scope.source_ids);
      if (input.agentId) {
        const owned = transaction.get("SELECT 1 FROM agents WHERE id=? AND account_id=?", [input.agentId, accountId]);
        if (!owned) throw new AgentBindingUnavailableError();
      }
      transaction.run(
        `INSERT INTO chats
           (id,account_id,title,title_is_manual,model,source_mode,agent_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          id,
          accountId,
          title,
          encodeBoolean(input.titleIsManual),
          model,
          scope.source_mode,
          input.agentId ?? null,
          timestamp,
          timestamp,
        ]
      );
      const row = transaction.get<ChatRow>(
        `SELECT c.id,c.title,c.model,c.source_mode,c.agent_id,ag.name AS agent_name,c.created_at,c.updated_at
         FROM chats c
         LEFT JOIN agents ag ON ag.id=c.agent_id AND ag.account_id=c.account_id
         WHERE c.id=? AND c.account_id=?`,
        [id, accountId]
      );
      if (!row) throw new StoreNotFoundError("chat");
      if (scope.source_mode === "selected") this.insertChatSources(transaction, id, accountId, scope.source_ids);
      return decodeChat(row);
    });
  }

  async getChatSnapshot(
    accountIdValue: string,
    chatIdValue: string,
    options: ChatSnapshotOptions = {}
  ): Promise<ChatSnapshot> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const limit = boundedPositiveInteger(
      options.limit ?? DEFAULT_HISTORY_LIMIT,
      "history limit",
      MAX_CHAT_HISTORY_PAGE
    );
    const maxHistoryChars = boundedPositiveInteger(
      options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS,
      "max history characters",
      500_000
    );
    const maxMessageChars = boundedPositiveInteger(
      options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS,
      "max message characters",
      100_000
    );
    const maxHistoryMetaChars = boundedPositiveInteger(
      options.maxHistoryMetaChars ?? DEFAULT_MAX_HISTORY_META_CHARS,
      "max history metadata characters",
      100_000
    );
    const beforeMessageId =
      options.beforeMessageId === undefined
        ? null
        : boundedPositiveInteger(options.beforeMessageId, "before message id", Number.MAX_SAFE_INTEGER);

    return this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<ChatRow>(
        `SELECT c.id,c.title,c.model,c.source_mode,c.agent_id,ag.name AS agent_name,c.created_at,c.updated_at
         FROM chats c
         LEFT JOIN agents ag ON ag.id=c.agent_id AND ag.account_id=c.account_id
         WHERE c.id=? AND c.account_id=?`,
        [chatId, accountId]
      );
      if (!row) throw new StoreNotFoundError("chat");
      const chat = decodeChat(row);
      const scope = this.resolveSourceScopeInTransaction(transaction, accountId, chatId, chat.source_mode);
      const messages = transaction.all<MessageRow>(
        `SELECT id,role,
                CASE WHEN content IS NULL THEN NULL ELSE substr(content,1,?) END AS content,
                CASE WHEN content IS NOT NULL AND length(content)>? THEN 1 ELSE 0 END AS content_was_truncated,
                CASE WHEN length(meta)<=? THEN meta ELSE '{"metadata_truncated":true}' END AS meta,
                created_at
         FROM messages
         WHERE chat_id=? AND (? IS NULL OR id<?)
         ORDER BY id DESC LIMIT ?`,
        [maxMessageChars, maxMessageChars, maxHistoryMetaChars, chatId, beforeMessageId, beforeMessageId, limit + 1]
      );
      const bounded = aggregateBoundedHistory(messages, limit, maxHistoryChars);
      const active = transaction.get<ActiveRunRow>(
        `SELECT id,status FROM chat_runs
         WHERE chat_id=? AND account_id=? AND status IN ('running','cancelling')
         ORDER BY created_at DESC LIMIT 1`,
        [chatId, accountId]
      );
      const activeRun = active ? this.decodeActiveRun(active) : null;
      return Object.freeze({
        ...chat,
        source_mode: scope.mode,
        sources: scope.attached,
        messages: bounded.messages,
        active_run: activeRun,
        messages_page: Object.freeze({
          has_more: bounded.hasMore,
          next_before_message_id: bounded.hasMore ? (bounded.messages[0]?.id ?? null) : null,
        }),
      });
    });
  }

  /**
   * Load the bounded conversation strictly before this run's accepted user
   * message. The account/chat/run join is the authorization boundary; callers
   * cannot accidentally widen history by supplying a mutable cursor.
   */
  async listAgentHistoryForRun(
    accountIdValue: string,
    chatIdValue: string,
    runIdValue: string,
    options: AgentHistoryOptions = {}
  ): Promise<readonly Readonly<AgentHistoryMessage>[]> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const runId = identity(runIdValue, "run id");
    const limit = boundedPositiveInteger(
      options.limit ?? DEFAULT_HISTORY_LIMIT,
      "agent history limit",
      MAX_AGENT_HISTORY_MESSAGES
    );
    const maxMessageChars = boundedPositiveInteger(
      options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS,
      "max message characters",
      100_000
    );
    return this.ledger.withImmediateTransaction((transaction) => {
      const run = transaction.get<{ user_message_id?: unknown }>(
        `SELECT user_message_id FROM chat_runs
         WHERE id=? AND account_id=? AND chat_id=?`,
        [runId, accountId, chatId]
      );
      if (!run) throw new StoreNotFoundError("run");
      const userMessageId = decodeSafeInteger(run.user_message_id, "run user message id");
      const rows = transaction.all<Pick<MessageRow, "role" | "content">>(
        `SELECT role,
                CASE WHEN content IS NULL THEN NULL ELSE substr(content,1,?) END AS content
         FROM messages
         WHERE chat_id=? AND id<?
         ORDER BY id DESC LIMIT ?`,
        [maxMessageChars, chatId, userMessageId, limit]
      );
      return Object.freeze(
        rows.reverse().map((row) =>
          Object.freeze({
            role: historyRole(row.role),
            content: row.content === null ? null : requiredString(row.content, "message content"),
          })
        )
      );
    });
  }

  async updateTitle(accountIdValue: string, chatIdValue: string, titleValue: string): Promise<ChatSummary> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const title = inputCodePointString(titleValue, "chat title", 80);
    const timestamp = this.timestamp();
    const updated = await this.ledger.run(
      `UPDATE chats
       SET title=?,title_is_manual=1,
           updated_at=CASE WHEN updated_at<? THEN ? ELSE updated_at END
       WHERE id=? AND account_id=?`,
      [title, timestamp, timestamp, chatId, accountId]
    );
    if (updated.changes !== 1) throw new StoreNotFoundError("chat");
    return this.getChatSummaryRow(accountId, chatId);
  }

  async updateModel(accountIdValue: string, chatIdValue: string, modelValue: string): Promise<ChatSummary> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const model = inputString(modelValue, "chat model", 256);
    const updated = await this.ledger.run("UPDATE chats SET model=? WHERE id=? AND account_id=?", [
      model,
      chatId,
      accountId,
    ]);
    if (updated.changes !== 1) throw new StoreNotFoundError("chat");
    return this.getChatSummaryRow(accountId, chatId);
  }

  private async getChatSummaryRow(accountId: string, chatId: string): Promise<ChatSummary> {
    const row = await this.ledger.get<ChatRow>(
      `SELECT c.id,c.title,c.model,c.source_mode,c.agent_id,ag.name AS agent_name,c.created_at,c.updated_at
       FROM chats c
       LEFT JOIN agents ag ON ag.id=c.agent_id AND ag.account_id=c.account_id
       WHERE c.id=? AND c.account_id=?`,
      [chatId, accountId]
    );
    if (!row) throw new StoreNotFoundError("chat");
    return decodeChat(row);
  }

  async deleteChat(accountIdValue: string, chatIdValue: string, hooks: DeleteChatTestHooks = {}): Promise<void> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    return this.ledger.withImmediateTransaction(async (transaction) => {
      if (!transaction.get("SELECT 1 FROM chats WHERE id=? AND account_id=?", [chatId, accountId])) {
        throw new StoreNotFoundError("chat");
      }
      if (this.activeRunExists(transaction, accountId, chatId)) {
        throw new ActiveChatRunError("chat has an active run");
      }
      transaction.run("DELETE FROM chats WHERE id=? AND account_id=?", [chatId, accountId]);
      await hooks.afterDelete?.();
    });
  }

  async resolveSourceScope(accountIdValue: string, chatIdValue: string): Promise<ResolvedChatSourceScope> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const chat = transaction.get<Pick<ChatRow, "source_mode">>(
        "SELECT source_mode FROM chats WHERE id=? AND account_id=?",
        [chatId, accountId]
      );
      if (!chat) throw new StoreNotFoundError("chat");
      return this.resolveSourceScopeInTransaction(transaction, accountId, chatId, sourceMode(chat.source_mode));
    });
  }

  async replaceSourceScope(
    accountIdValue: string,
    chatIdValue: string,
    input: ChatSourceScopeInput,
    hooks: ReplaceSourceScopeTestHooks = {}
  ): Promise<ResolvedChatSourceScope> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const scope = normalizedScope(input);
    return this.ledger.withImmediateTransaction(async (transaction) => {
      if (!transaction.get("SELECT 1 FROM chats WHERE id=? AND account_id=?", [chatId, accountId])) {
        throw new StoreNotFoundError("chat");
      }
      if (scope.source_mode === "selected") this.assertSourcesAvailable(transaction, accountId, scope.source_ids);
      transaction.run("DELETE FROM chat_sources WHERE chat_id=? AND account_id=?", [chatId, accountId]);
      await hooks.afterDelete?.();
      if (scope.source_mode === "selected") {
        this.insertChatSources(transaction, chatId, accountId, scope.source_ids);
      }
      transaction.run("UPDATE chats SET source_mode=? WHERE id=? AND account_id=?", [
        scope.source_mode,
        chatId,
        accountId,
      ]);
      return this.resolveSourceScopeInTransaction(transaction, accountId, chatId, scope.source_mode);
    });
  }

  async acceptChatTurn(
    accountIdValue: string,
    chatIdValue: string,
    contentValue: string,
    hooks: AcceptChatTurnTestHooks = {}
  ): Promise<AcceptedChatTurn> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const content = inputCodePointString(contentValue, "message content", 100_000);
    try {
      return await this.ledger.withImmediateTransaction(async (transaction) => {
        const chat = transaction.get<ChatRow>(
          "SELECT model,source_mode,title,title_is_manual,agent_id FROM chats WHERE id=? AND account_id=?",
          [chatId, accountId]
        );
        if (!chat) throw new StoreNotFoundError("chat");
        if (this.activeRunExists(transaction, accountId, chatId)) throw new ActiveChatRunError();

        const model = requiredString(chat.model, "chat model");
        const mode = sourceMode(chat.source_mode);
        const sourceScope = this.resolveSourceScopeInTransaction(transaction, accountId, chatId, mode);
        // The agent binding is write-once at chat creation. Snapshot the exact
        // current revision onto the run inside this transaction so later agent
        // edits or deletion can never change a running turn's prompt.
        let agent: AcceptedChatTurn["agent"] = null;
        if (chat.agent_id !== null && chat.agent_id !== undefined) {
          const bound = transaction.get<{ id?: unknown; name?: unknown; version?: unknown; instructions?: unknown }>(
            `SELECT a.id,a.name,a.current_version AS version,r.instructions
             FROM agents a
             JOIN agent_revisions r ON r.agent_id=a.id AND r.version=a.current_version AND r.account_id=a.account_id
             WHERE a.id=? AND a.account_id=?`,
            [requiredString(chat.agent_id, "chat agent id"), accountId]
          );
          if (bound) {
            agent = Object.freeze({
              id: requiredString(bound.id, "agent id"),
              name: requiredString(bound.name, "agent name"),
              version: decodeSafeInteger(bound.version, "agent version"),
              instructions: requiredString(bound.instructions, "agent instructions"),
            });
          }
        }
        const runId = identity(this.createId(), "generated run id");
        const createdAt = this.timestamp();
        const meta = Object.freeze({
          model,
          source_mode: mode,
          source_ids: Object.freeze([...sourceScope.readySourceIds]),
          ...(agent ? { agent: Object.freeze({ id: agent.id, name: agent.name, version: agent.version }) } : {}),
        });
        const hadMessages = Boolean(transaction.get("SELECT 1 FROM messages WHERE chat_id=? LIMIT 1", [chatId]));
        const messageResult = transaction.run(
          `INSERT INTO messages (chat_id,role,content,meta,created_at)
           VALUES (?,'user',?,?,?)`,
          [chatId, content, encodeJson(meta, "accepted turn metadata"), createdAt]
        );
        transaction.run(
          `INSERT INTO chat_runs
             (id,account_id,chat_id,user_message_id,status,agent_instructions,created_at,started_at)
           VALUES (?,?,?,?,'running',?,?,?)`,
          [
            runId,
            accountId,
            chatId,
            messageResult.lastInsertRowid,
            agent ? agent.instructions : null,
            createdAt,
            createdAt,
          ]
        );
        for (const sourceId of sourceScope.readySourceIds) {
          transaction.run("INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)", [
            runId,
            sourceId,
            accountId,
          ]);
        }

        const snapshot = Object.freeze({ chatId, model, sourceScope, agent, runId });
        await hooks.afterSnapshot?.(snapshot);

        const title = requiredString(chat.title, "chat title");
        const titleIsManual = decodeBoolean(chat.title_is_manual, "title_is_manual");
        const automaticTitle = Array.from(content).slice(0, 80).join("");
        transaction.run(
          `UPDATE chats
           SET updated_at=CASE WHEN updated_at<? THEN ? ELSE updated_at END,
               title=CASE
                 WHEN ?=1 AND title='New chat' AND title_is_manual=0 THEN ?
                 ELSE title
               END
           WHERE id=? AND account_id=?`,
          [
            createdAt,
            createdAt,
            encodeBoolean(!hadMessages && title === "New chat" && !titleIsManual),
            automaticTitle,
            chatId,
            accountId,
          ]
        );

        const userMessage = Object.freeze({
          id: messageResult.lastInsertRowid,
          role: "user" as const,
          content,
          meta,
          created_at: createdAt,
        });
        return Object.freeze({ ...snapshot, userMessage });
      });
    } catch (error) {
      if (error instanceof ChatStoreError) throw error;
      if (error instanceof SqliteConstraintError && error.kind === "foreign_key") {
        throw new SourceScopeUnavailableError(undefined, { cause: error });
      }
      throw error;
    }
  }

  async sourceReferencedByActiveRun(
    accountIdValue: string,
    sourceIdValue: string,
    transaction?: SqliteTransaction
  ): Promise<boolean> {
    const accountId = identity(accountIdValue, "account id");
    const sourceId = identity(sourceIdValue, "source id");
    const sql = `SELECT 1
                 FROM chat_run_sources rs
                 JOIN chat_runs r ON r.id=rs.run_id AND r.account_id=rs.account_id
                 WHERE rs.account_id=? AND rs.source_id=?
                   AND r.status IN ('running','cancelling')
                 LIMIT 1`;
    if (transaction) return Boolean(transaction.get(sql, [accountId, sourceId]));
    return Boolean(await this.ledger.get(sql, [accountId, sourceId]));
  }

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "chat store clock");
  }

  private assertUserExists(transaction: SqliteTransaction, accountId: string): void {
    if (!transaction.get("SELECT 1 FROM users WHERE id=?", [accountId])) throw new StoreNotFoundError("user");
  }

  private assertSourcesAvailable(
    transaction: SqliteTransaction,
    accountId: string,
    sourceIds: readonly string[]
  ): void {
    if (!sourceIds.length) return;
    const rows = transaction.all<{ id?: unknown }>(
      `SELECT id FROM sources WHERE account_id=? AND id IN (${placeholders(sourceIds.length)})`,
      [accountId, ...sourceIds]
    );
    const available = new Set(rows.map((row) => requiredString(row.id, "source id")));
    if (sourceIds.some((sourceId) => !available.has(sourceId))) throw new SourceScopeUnavailableError();
  }

  private insertChatSources(
    transaction: SqliteTransaction,
    chatId: string,
    accountId: string,
    sourceIds: readonly string[]
  ): void {
    for (const sourceId of sourceIds) {
      transaction.run("INSERT INTO chat_sources (chat_id,source_id,account_id) VALUES (?,?,?)", [
        chatId,
        sourceId,
        accountId,
      ]);
    }
  }

  private resolveSourceScopeInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    chatId: string,
    mode: ChatSourceMode
  ): ResolvedChatSourceScope {
    const rows =
      mode === "all"
        ? transaction.all<SourceRow>(
            `SELECT id,name,display_name,kind,status
             FROM sources WHERE account_id=?
             ORDER BY lower(display_name),display_name,id LIMIT ?`,
            [accountId, MAX_CHAT_SOURCE_SCOPE + 1]
          )
        : transaction.all<SourceRow>(
            `SELECT s.id,s.name,s.display_name,s.kind,s.status
             FROM chat_sources cs
             JOIN sources s ON s.id=cs.source_id AND s.account_id=cs.account_id
             WHERE cs.chat_id=? AND cs.account_id=?
             ORDER BY lower(s.display_name),s.display_name,s.id LIMIT ?`,
            [chatId, accountId, MAX_CHAT_SOURCE_SCOPE + 1]
          );
    return resolveRows(mode, rows);
  }

  private activeRunExists(transaction: SqliteTransaction, accountId: string, chatId: string): boolean {
    return Boolean(
      transaction.get(
        `SELECT 1 FROM chat_runs
         WHERE chat_id=? AND account_id=? AND status IN ('running','cancelling') LIMIT 1`,
        [chatId, accountId]
      )
    );
  }

  private decodeActiveRun(row: ActiveRunRow): Readonly<ActiveChatRun> {
    const status = row.status;
    if (status !== "running" && status !== "cancelling") {
      throw new TypeError("active run status violates the chat store contract");
    }
    return Object.freeze({ id: requiredString(row.id, "run id"), status });
  }
}

export function createChatStore(ledger: SqliteLedger, options: ChatStoreOptions = {}): ChatStore {
  return new ChatStore(ledger, options);
}
