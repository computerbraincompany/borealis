import { pool } from "./db.js";
import {
  resolveChatSourceScope,
  SourceScopeError,
  type ResolvedSourceScope,
} from "./sourceScope.js";

export interface AcceptedUserMessage {
  readonly id: number | string;
  readonly role: "user";
  readonly content: string;
  readonly meta: Readonly<{
    model: string;
    source_mode: "all" | "selected";
    source_ids: readonly string[];
  }>;
  readonly created_at: string | Date;
}

export interface AcceptedChatTurn {
  readonly chatId: string;
  readonly model: string;
  readonly sourceScope: ResolvedSourceScope;
  readonly userMessage: AcceptedUserMessage;
}

export interface AcceptChatTurnTestHooks {
  /** Integration-test barrier. Production callers must omit this option. */
  afterSnapshot?: (turn: Omit<AcceptedChatTurn, "userMessage">) => Promise<void>;
}

/**
 * Accept one user message and its immutable model/source provenance from a
 * single repeatable-read database snapshot.
 */
export async function acceptChatTurn(
  accountId: string,
  chatId: string,
  content: string,
  testHooks: AcceptChatTurnTestHooks = {}
): Promise<AcceptedChatTurn> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    inTransaction = true;

    const chatResult = await client.query<{ id: string; model: string }>(
      `SELECT id, model FROM chats WHERE id=$1 AND account_id=$2`,
      [chatId, accountId]
    );
    const chat = chatResult.rows[0];
    if (!chat) throw new SourceScopeError(404, "chat not found");

    const sourceScope = await resolveChatSourceScope(client, accountId, chatId);
    const snapshot = Object.freeze({ chatId, model: chat.model, sourceScope });
    const meta = Object.freeze({
      model: chat.model,
      source_mode: sourceScope.mode,
      source_ids: Object.freeze([...sourceScope.readySourceIds]),
    });
    const messageResult = await client.query<{
      id: number | string;
      role: "user";
      content: string;
      meta: AcceptedUserMessage["meta"];
      created_at: string | Date;
    }>(
      `INSERT INTO messages (chat_id, role, content, meta)
       VALUES ($1,'user',$2,$3::jsonb)
       RETURNING id, role, content, meta, created_at`,
      [chatId, content, JSON.stringify(meta)]
    );
    // The accepted message is now staged with the same snapshot. Keeping the
    // test barrier after this insert lets concurrent non-key chat updates
    // commit without forcing a repeatable-read retry or changing provenance.
    await testHooks.afterSnapshot?.(snapshot);

    const countResult = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE chat_id=$1`,
      [chatId]
    );
    const isFirst = countResult.rows[0]?.n === 1;

    await client.query("COMMIT");
    inTransaction = false;
    const row = messageResult.rows[0];
    const userMessage = Object.freeze({ ...row, meta });
    // Title generation is presentation state, not accepted-turn provenance.
    // Run it after the load-bearing snapshot transaction so a concurrent
    // source/model update cannot abort or rewrite an already accepted turn.
    if (isFirst) {
      await client.query(
        `UPDATE chats SET title=$2 WHERE id=$1 AND account_id=$3`,
        [chatId, content.slice(0, 80), accountId]
      ).catch(() => {});
    }
    return Object.freeze({ ...snapshot, userMessage });
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
