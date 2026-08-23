import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AcceptedChatTurn } from "../turnContext.js";

let pool: typeof import("../db.js").pool;
let initDb: typeof import("../db.js").initDb;
let replaceChatSourceScope: typeof import("../sourceScope.js").replaceChatSourceScope;
let resolveChatSourceScope: typeof import("../sourceScope.js").resolveChatSourceScope;
let acceptChatTurn: typeof import("../turnContext.js").acceptChatTurn;
let app: FastifyInstance;
let signToken: typeof import("../auth.js").signToken;

beforeAll(async () => {
  const db = await import("../db.js");
  ({ pool, initDb } = db);
  await initDb();
  await initDb(); // schema/migrations must remain boot-idempotent
  ({ replaceChatSourceScope, resolveChatSourceScope } = await import("../sourceScope.js"));
  ({ acceptChatTurn } = await import("../turnContext.js"));
  ({ signToken } = await import("../auth.js"));
  const Fastify = (await import("fastify")).default;
  const { routes } = await import("../routes.js");
  app = Fastify();
  await routes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

async function insertUser(label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'integration-only')`,
    [id, `${label}-${id}@example.test`]
  );
  return id;
}

async function insertSource(accountId: string, label: string, status = "ready"): Promise<string> {
  const id = randomUUID();
  const name = `t_${label}_${id.replace(/-/g, "").slice(0, 10)}`;
  await pool.query(
    `INSERT INTO sources (id, account_id, name, kind, display_name, status)
     VALUES ($1,$2,$3,'tabular',$4,$5)`,
    [id, accountId, name, `${label}.csv`, status]
  );
  return id;
}

async function insertChat(
  accountId: string,
  sourceMode: "all" | "selected" = "all",
  model = "integration-chat-model"
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO chats (id, account_id, title, model, source_mode)
     VALUES ($1,$2,'Integration chat',$3,$4)`,
    [id, accountId, model, sourceMode]
  );
  return id;
}

async function attach(accountId: string, chatId: string, sourceIds: string[]): Promise<void> {
  if (!sourceIds.length) return;
  await pool.query(
    `INSERT INTO chat_sources (chat_id, source_id, account_id)
     SELECT $1, source_id, $2 FROM unnest($3::uuid[]) AS selected(source_id)`,
    [chatId, accountId, sourceIds]
  );
}

async function cleanupUsers(ids: string[]): Promise<void> {
  if (ids.length) await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("source-scope database isolation", () => {
  it("rejects foreign and missing replacements identically, atomically, and at the FK layer", async () => {
    const users: string[] = [];
    try {
      const owner = await insertUser("owner");
      const foreign = await insertUser("foreign");
      users.push(owner, foreign);
      const ownedSource = await insertSource(owner, "owned");
      const foreignSource = await insertSource(foreign, "foreign");
      const chatId = await insertChat(owner, "selected");
      await attach(owner, chatId, [ownedSource]);

      let foreignError: unknown;
      let missingError: unknown;
      try {
        await replaceChatSourceScope(owner, chatId, {
          source_mode: "selected",
          source_ids: [ownedSource, foreignSource],
        });
      } catch (error) {
        foreignError = error;
      }
      try {
        await replaceChatSourceScope(owner, chatId, {
          source_mode: "selected",
          source_ids: [ownedSource, randomUUID()],
        });
      } catch (error) {
        missingError = error;
      }
      expect(foreignError).toMatchObject({ statusCode: 400, message: "one or more sources are unavailable" });
      expect(missingError).toMatchObject({ statusCode: 400, message: "one or more sources are unavailable" });
      expect(await resolveChatSourceScope(pool, owner, chatId)).toMatchObject({
        mode: "selected",
        readySourceIds: [ownedSource],
      });

      await expect(
        pool.query(
          `INSERT INTO chat_sources (chat_id, source_id, account_id) VALUES ($1,$2,$3)`,
          [chatId, foreignSource, owner]
        )
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await cleanupUsers(users);
    }
  });

  it("preserves explicit none, cascades safely, and keeps all dynamic", async () => {
    const users: string[] = [];
    try {
      const accountId = await insertUser("lifecycle");
      users.push(accountId);
      const first = await insertSource(accountId, "first");
      const selectedChat = await insertChat(accountId, "selected");

      let selected = await resolveChatSourceScope(pool, accountId, selectedChat);
      expect(selected.mode).toBe("selected");
      expect(selected.attached).toEqual([]);

      await replaceChatSourceScope(accountId, selectedChat, {
        source_mode: "selected",
        source_ids: [first],
      });
      await pool.query(`DELETE FROM sources WHERE id=$1`, [first]);
      selected = await resolveChatSourceScope(pool, accountId, selectedChat);
      expect(selected).toMatchObject({ mode: "selected", attached: [], readySourceIds: [] });

      const second = await insertSource(accountId, "second");
      await replaceChatSourceScope(accountId, selectedChat, {
        source_mode: "selected",
        source_ids: [second],
      });
      await replaceChatSourceScope(accountId, selectedChat, { source_mode: "all" });
      const rowCount = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM chat_sources WHERE chat_id=$1`,
        [selectedChat]
      );
      expect(rowCount.rows[0].n).toBe(0);

      const later = await insertSource(accountId, "later");
      const allScope = await resolveChatSourceScope(pool, accountId, selectedChat);
      expect(allScope.readySourceIds).toEqual(expect.arrayContaining([second, later]));

      const subsetChat = await insertChat(accountId, "selected");
      await attach(accountId, subsetChat, [second]);
      const newest = await insertSource(accountId, "newest");
      const subset = await resolveChatSourceScope(pool, accountId, subsetChat);
      expect(subset.readySourceIds).toEqual([second]);
      expect(subset.readySourceIds).not.toContain(newest);

      await pool.query(`DELETE FROM chats WHERE id=$1`, [subsetChat]);
      const memberships = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM chat_sources WHERE chat_id=$1`,
        [subsetChat]
      );
      expect(memberships.rows[0].n).toBe(0);
    } finally {
      await cleanupUsers(users);
    }
  });

  it("accepts source and model provenance from whole repeatable-read snapshots", async () => {
    const users: string[] = [];
    try {
      const accountId = await insertUser("concurrency");
      users.push(accountId);
      const sourceBefore = await insertSource(accountId, "before");
      const sourceAfter = await insertSource(accountId, "after");
      const chatId = await insertChat(accountId, "selected", "model-before");
      await attach(accountId, chatId, [sourceBefore]);
      await pool.query(
        `INSERT INTO messages (chat_id, role, content) VALUES ($1,'assistant','seed')`,
        [chatId]
      );

      const replacementPaused = deferred();
      const allowReplacement = deferred();
      const replacement = replaceChatSourceScope(
        accountId,
        chatId,
        { source_mode: "selected", source_ids: [sourceAfter] },
        {
          afterDelete: async () => {
            replacementPaused.resolve();
            await allowReplacement.promise;
          },
        }
      );
      await replacementPaused.promise;

      const snapshotAccepted = deferred();
      const allowAcceptance = deferred();
      const acceptedPromise = acceptChatTurn(accountId, chatId, "source snapshot", {
        afterSnapshot: async () => {
          snapshotAccepted.resolve();
          await allowAcceptance.promise;
        },
      });
      await snapshotAccepted.promise;
      allowReplacement.resolve();
      await replacement;
      allowAcceptance.resolve();
      const acceptedBefore = await acceptedPromise;
      const acceptedAfter = await acceptChatTurn(accountId, chatId, "source next turn");

      expect(acceptedBefore.sourceScope).toMatchObject({ mode: "selected", readySourceIds: [sourceBefore] });
      expect(acceptedBefore.userMessage.meta).toMatchObject({ source_mode: "selected", source_ids: [sourceBefore] });
      expect(acceptedAfter.sourceScope).toMatchObject({ mode: "selected", readySourceIds: [sourceAfter] });
      expect(acceptedAfter.userMessage.meta).toMatchObject({ source_mode: "selected", source_ids: [sourceAfter] });
      await expectMessageMetaMatches(acceptedBefore);
      await expectMessageMetaMatches(acceptedAfter);

      const token = signToken({ userId: accountId, email: "concurrency@example.test" });
      const modelSnapshotAccepted = deferred();
      const allowModelAcceptance = deferred();
      const modelAcceptPromise = acceptChatTurn(accountId, chatId, "model snapshot", {
        afterSnapshot: async () => {
          modelSnapshotAccepted.resolve();
          await allowModelAcceptance.promise;
        },
      });
      await modelSnapshotAccepted.promise;
      const patchResponse = await app.inject({
        method: "PATCH",
        url: `/api/chats/${chatId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { model: "model-after" },
      });
      expect(patchResponse.statusCode).toBe(200);
      allowModelAcceptance.resolve();

      const modelBefore = await modelAcceptPromise;
      const modelAfter = await acceptChatTurn(accountId, chatId, "model next turn");
      expect(modelBefore.model).toBe("model-before");
      expect(modelBefore.userMessage.meta.model).toBe("model-before");
      expect(modelAfter.model).toBe("model-after");
      expect(modelAfter.userMessage.meta.model).toBe("model-after");
      expect(modelBefore.sourceScope.readySourceIds).toEqual([sourceAfter]);
      expect(modelAfter.sourceScope.readySourceIds).toEqual([sourceAfter]);
      await expectMessageMetaMatches(modelBefore);
      await expectMessageMetaMatches(modelAfter);
    } finally {
      await cleanupUsers(users);
    }
  });
});

async function expectMessageMetaMatches(turn: AcceptedChatTurn): Promise<void> {
  const result = await pool.query<{ meta: Record<string, unknown> }>(
    `SELECT meta FROM messages WHERE id=$1`,
    [turn.userMessage.id]
  );
  expect(result.rows[0].meta).toEqual({
    model: turn.model,
    source_mode: turn.sourceScope.mode,
    source_ids: [...turn.sourceScope.readySourceIds],
  });
}
