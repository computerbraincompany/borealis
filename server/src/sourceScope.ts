import type { QueryResult, QueryResultRow } from "pg";
import { pool } from "./db.js";

export type SourceScopeInput =
  | { source_mode: "all" }
  | { source_mode: "selected"; source_ids: string[] };

export interface AttachedSource {
  id: string;
  name: string;
  display_name: string;
  kind: string;
  status: string;
}

export interface ResolvedSourceScope {
  readonly mode: "all" | "selected";
  readonly attached: readonly Readonly<AttachedSource>[];
  readonly readySourceIds: readonly string[];
  readonly readyTableNames: readonly string[];
}

export interface ScopeQueryable {
  query<T extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<T>>;
}

export class SourceScopeError extends Error {
  constructor(
    readonly statusCode: 400 | 404,
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
  if (!Array.isArray(record.source_ids) || record.source_ids.length > 100) {
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

function freezeResolved(
  mode: "all" | "selected",
  rows: AttachedSource[]
): ResolvedSourceScope {
  const attached = rows.map((row) => Object.freeze({ ...row }));
  const ready = attached.filter((source) => source.status === "ready");
  return Object.freeze({
    mode,
    attached: Object.freeze(attached),
    readySourceIds: Object.freeze(ready.map((source) => source.id)),
    readyTableNames: Object.freeze(
      ready.filter((source) => source.kind === "tabular").map((source) => source.name)
    ),
  });
}

/** Resolve a chat's source state through the caller's database snapshot. */
export async function resolveChatSourceScope(
  client: ScopeQueryable,
  accountId: string,
  chatId: string
): Promise<ResolvedSourceScope> {
  const chatResult = await client.query<{ source_mode: "all" | "selected" }>(
    `SELECT source_mode FROM chats WHERE id=$1 AND account_id=$2`,
    [chatId, accountId]
  );
  const mode = chatResult.rows[0]?.source_mode;
  if (!mode) throw new SourceScopeError(404, "chat not found");

  const sourceResult = mode === "all"
    ? await client.query<AttachedSource>(
        `SELECT id, name, display_name, kind, status
         FROM sources
         WHERE account_id=$1
         ORDER BY lower(display_name), display_name, id`,
        [accountId]
      )
    : await client.query<AttachedSource>(
        `SELECT s.id, s.name, s.display_name, s.kind, s.status
         FROM chat_sources cs
         JOIN sources s
           ON s.id=cs.source_id AND s.account_id=cs.account_id
         WHERE cs.chat_id=$1 AND cs.account_id=$2
         ORDER BY lower(s.display_name), s.display_name, s.id`,
        [chatId, accountId]
      );

  return freezeResolved(mode, sourceResult.rows);
}

async function assertSourcesAvailable(
  client: ScopeQueryable,
  accountId: string,
  sourceIds: readonly string[]
): Promise<void> {
  if (!sourceIds.length) return;
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM sources
     WHERE account_id=$1 AND id = ANY($2::uuid[])
     FOR KEY SHARE`,
    [accountId, [...sourceIds]]
  );
  const available = new Set(result.rows.map((row) => row.id.toLowerCase()));
  if (sourceIds.some((id) => !available.has(id.toLowerCase()))) {
    throw new SourceScopeError(400, "one or more sources are unavailable");
  }
}

export interface ReplaceSourceScopeTestHooks {
  /** Integration-test barrier. Production callers must omit this option. */
  afterDelete?: () => Promise<void>;
}

/** Atomically replace a chat's source scope without exposing foreign IDs. */
export async function replaceChatSourceScope(
  accountId: string,
  chatId: string,
  rawInput: unknown,
  testHooks: ReplaceSourceScopeTestHooks = {}
): Promise<ResolvedSourceScope> {
  const input = parseSourceScopeInput(rawInput);
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const owned = await client.query(
      `SELECT id FROM chats WHERE id=$1 AND account_id=$2 FOR NO KEY UPDATE`,
      [chatId, accountId]
    );
    if (!owned.rows.length) throw new SourceScopeError(404, "chat not found");

    if (input.source_mode === "selected") {
      await assertSourcesAvailable(client, accountId, input.source_ids);
    }

    await client.query(`DELETE FROM chat_sources WHERE chat_id=$1 AND account_id=$2`, [chatId, accountId]);
    await testHooks.afterDelete?.();

    if (input.source_mode === "selected" && input.source_ids.length) {
      await client.query(
        `INSERT INTO chat_sources (chat_id, source_id, account_id)
         SELECT $1, source_id, $2 FROM unnest($3::uuid[]) AS selected(source_id)`,
        [chatId, accountId, input.source_ids]
      );
    }
    await client.query(`UPDATE chats SET source_mode=$3 WHERE id=$1 AND account_id=$2`, [
      chatId,
      accountId,
      input.source_mode,
    ]);

    const resolved = await resolveChatSourceScope(client, accountId, chatId);
    await client.query("COMMIT");
    inTransaction = false;
    return resolved;
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function assertSelectedSourcesAvailable(
  client: ScopeQueryable,
  accountId: string,
  sourceIds: readonly string[]
): Promise<void> {
  await assertSourcesAvailable(client, accountId, sourceIds);
}
