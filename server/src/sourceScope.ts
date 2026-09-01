import {
  MAX_CHAT_SOURCE_SCOPE,
  SourceScopeUnavailableError,
  StoreNotFoundError,
  type AttachedChatSource,
  type ChatSourceScopeInput,
  type ResolvedChatSourceScope,
} from "./db/stores/chatStore.js";
import { storageRuntime } from "./storageRuntime.js";

export type SourceScopeInput = { source_mode: "all" } | { source_mode: "selected"; source_ids: string[] };

export type AttachedSource = AttachedChatSource;
export type ResolvedSourceScope = ResolvedChatSourceScope;

export class SourceScopeError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string
  ) {
    super(message);
    this.name = "SourceScopeError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the exact public source-scope union and return a stable, deduped copy. */
export function parseSourceScopeInput(value: unknown): SourceScopeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceScopeError(400, "invalid source scope");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.source_mode === "all") {
    if (keys.length !== 1 || keys[0] !== "source_mode") {
      throw new SourceScopeError(400, "invalid source scope");
    }
    return { source_mode: "all" };
  }

  if (record.source_mode !== "selected") {
    throw new SourceScopeError(400, "invalid source scope");
  }
  if (keys.length !== 2 || keys[0] !== "source_ids" || keys[1] !== "source_mode") {
    throw new SourceScopeError(400, "invalid source scope");
  }
  if (!Array.isArray(record.source_ids) || record.source_ids.length > MAX_CHAT_SOURCE_SCOPE) {
    throw new SourceScopeError(400, "invalid source scope");
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of record.source_ids) {
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      throw new SourceScopeError(400, "invalid source scope");
    }
    const normalized = value.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduped.push(normalized);
    }
  }
  return { source_mode: "selected", source_ids: deduped };
}

export async function resolveChatSourceScope(accountId: string, chatId: string): Promise<ResolvedSourceScope> {
  try {
    return await storageRuntime().chats.resolveSourceScope(accountId, chatId);
  } catch (error) {
    throw publicSourceScopeError(error, "resolve");
  }
}

export interface ReplaceSourceScopeTestHooks {
  /** Behavior-test barrier. Production callers must omit this option. */
  readonly afterDelete?: () => Promise<void>;
}

/** Atomically replace a chat's source scope without exposing foreign IDs. */
export async function replaceChatSourceScope(
  accountId: string,
  chatId: string,
  rawInput: unknown,
  testHooks: ReplaceSourceScopeTestHooks = {}
): Promise<ResolvedSourceScope> {
  const input = parseSourceScopeInput(rawInput) as ChatSourceScopeInput;
  try {
    return await storageRuntime().chats.replaceSourceScope(accountId, chatId, input, testHooks);
  } catch (error) {
    throw publicSourceScopeError(error, "replace");
  }
}

export function publicSourceScopeError(error: unknown, operation: "resolve" | "replace" | "accept"): unknown {
  if (error instanceof SourceScopeError) return error;
  if (error instanceof StoreNotFoundError) return new SourceScopeError(404, "chat not found");
  if (error instanceof SourceScopeUnavailableError) {
    return new SourceScopeError(
      operation === "replace" && error.reason === "missing_sources" ? 400 : 409,
      error.message
    );
  }
  return error;
}
