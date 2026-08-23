import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AcceptedChatTurn } from "../turnContext.js";

let pool: typeof import("../db.js").pool;
let initDb: typeof import("../db.js").initDb;
let replaceChatSourceScope: typeof import("../sourceScope.js").replaceChatSourceScope;
let resolveChatSourceScope: typeof import("../sourceScope.js").resolveChatSourceScope;
let acceptChatTurn: typeof import("../turnContext.js").acceptChatTurn;
let sourceReferencedByActiveRun: typeof import("../sourceMutationGuard.js").sourceReferencedByActiveRun;
let app: FastifyInstance;
let signToken: typeof import("../auth.js").signToken;

beforeAll(async () => {
  const db = await import("../db.js");
  ({ pool, initDb } = db);
  await initDb();
  await initDb(); // schema/migrations must remain boot-idempotent
  ({ replaceChatSourceScope, resolveChatSourceScope } = await import("../sourceScope.js"));
  ({ acceptChatTurn } = await import("../turnContext.js"));
  ({ sourceReferencedByActiveRun } = await import("../sourceMutationGuard.js"));
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
  await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'integration-only')`, [
    id,
    `${label}-${id}@example.test`,
  ]);
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

async function insertConnectorSource(
  accountId: string,
  label: string
): Promise<{
  connectorId: string;
  sourceId: string;
}> {
  const connectorId = randomUUID();
  const sourceId = randomUUID();
  const table = `t_${label}_${sourceId.replace(/-/g, "").slice(0, 10)}`;
  await pool.query(
    `INSERT INTO connectors (id, account_id, name, type, config, target_table)
     VALUES ($1,$2,$3,'url_csv',$4::jsonb,$5)`,
    [connectorId, accountId, `${label} connector`, JSON.stringify({ url: "https://example.test/data.csv" }), table]
  );
  await pool.query(
    `INSERT INTO sources (id, account_id, name, kind, display_name, status, connector)
     VALUES ($1,$2,$3,'tabular',$4,'ready',$5)`,
    [sourceId, accountId, table, `${label}.csv`, connectorId]
  );
  return { connectorId, sourceId };
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
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
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
        pool.query(`INSERT INTO chat_sources (chat_id, source_id, account_id) VALUES ($1,$2,$3)`, [
          chatId,
          foreignSource,
          owner,
        ])
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
      const rowCount = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM chat_sources WHERE chat_id=$1`, [
        selectedChat,
      ]);
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
      await pool.query(`INSERT INTO messages (chat_id, role, content) VALUES ($1,'assistant','seed')`, [chatId]);

      const snapshotAccepted = deferred();
      const allowAcceptance = deferred();
      const acceptedPromise = acceptChatTurn(accountId, chatId, "source snapshot", {
        afterSnapshot: async () => {
          snapshotAccepted.resolve();
          await allowAcceptance.promise;
        },
      });
      await snapshotAccepted.promise;
      let replacementSettled = false;
      const replacement = replaceChatSourceScope(accountId, chatId, {
        source_mode: "selected",
        source_ids: [sourceAfter],
      }).finally(() => {
        replacementSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(replacementSettled).toBe(false);
      allowAcceptance.resolve();
      const acceptedBefore = await acceptedPromise;
      await finishAcceptedRun(acceptedBefore);
      await replacement;
      const acceptedAfter = await acceptChatTurn(accountId, chatId, "source next turn");

      expect(acceptedBefore.sourceScope).toMatchObject({ mode: "selected", readySourceIds: [sourceBefore] });
      expect(acceptedBefore.userMessage.meta).toMatchObject({ source_mode: "selected", source_ids: [sourceBefore] });
      expect(acceptedAfter.sourceScope).toMatchObject({ mode: "selected", readySourceIds: [sourceAfter] });
      expect(acceptedAfter.userMessage.meta).toMatchObject({ source_mode: "selected", source_ids: [sourceAfter] });
      await expectMessageMetaMatches(acceptedBefore);
      await expectMessageMetaMatches(acceptedAfter);
      await finishAcceptedRun(acceptedAfter);

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
      let patchSettled = false;
      const patchPromise = app
        .inject({
          method: "PATCH",
          url: `/api/chats/${chatId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { model: "model-after" },
        })
        .finally(() => {
          patchSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(patchSettled).toBe(false);
      allowModelAcceptance.resolve();

      const modelBefore = await modelAcceptPromise;
      const patchResponse = await patchPromise;
      expect(patchResponse.statusCode).toBe(200);
      await finishAcceptedRun(modelBefore);
      const modelAfter = await acceptChatTurn(accountId, chatId, "model next turn");
      expect(modelBefore.model).toBe("model-before");
      expect(modelBefore.userMessage.meta.model).toBe("model-before");
      expect(modelAfter.model).toBe("model-after");
      expect(modelAfter.userMessage.meta.model).toBe("model-after");
      expect(modelBefore.sourceScope.readySourceIds).toEqual([sourceAfter]);
      expect(modelAfter.sourceScope.readySourceIds).toEqual([sourceAfter]);
      await expectMessageMetaMatches(modelBefore);
      await expectMessageMetaMatches(modelAfter);
      await finishAcceptedRun(modelAfter);
    } finally {
      await cleanupUsers(users);
    }
  });

  it("updates activity after commit without overwriting manual or explicit title provenance", async () => {
    const users: string[] = [];
    try {
      const accountId = await insertUser("history");
      users.push(accountId);
      const token = signToken({ userId: accountId, email: "history@example.test" });
      const headers = { authorization: `Bearer ${token}` };

      const automaticCreate = await app.inject({
        method: "POST",
        url: "/api/chats",
        headers,
        payload: {},
      });
      expect(automaticCreate.statusCode).toBe(200);
      const automaticId = automaticCreate.json().id as string;
      expect(automaticCreate.json()).toHaveProperty("updated_at");
      expect(automaticCreate.json()).not.toHaveProperty("title_is_manual");
      await pool.query(`UPDATE chats SET updated_at='2000-01-01T00:00:00Z' WHERE id=$1`, [automaticId]);

      const automaticTurn = await acceptChatTurn(accountId, automaticId, "Automatic title from first message");
      const automatic = await getChatState(automaticId);
      expect(automatic).toMatchObject({
        title: "Automatic title from first message",
        title_is_manual: false,
      });
      expect(automatic.updated_at.getTime()).toBeGreaterThanOrEqual(
        new Date(automaticTurn.userMessage.created_at).getTime()
      );

      const explicitCreate = await app.inject({
        method: "POST",
        url: "/api/chats",
        headers,
        payload: { title: "Explicit project title" },
      });
      expect(explicitCreate.statusCode).toBe(200);
      const explicitId = explicitCreate.json().id as string;
      expect((await getChatState(explicitId)).title_is_manual).toBe(true);
      await acceptChatTurn(accountId, explicitId, "First message must not replace explicit title");
      expect(await getChatState(explicitId)).toMatchObject({
        title: "Explicit project title",
        title_is_manual: true,
      });

      const renamed = await acceptFirstTurnWithConcurrentRename(accountId, headers, "Manual race winner");
      expect(await getChatState(renamed)).toMatchObject({
        title: "Manual race winner",
        title_is_manual: true,
      });

      const literal = await acceptFirstTurnWithConcurrentRename(accountId, headers, "New chat");
      expect(await getChatState(literal)).toMatchObject({
        title: "New chat",
        title_is_manual: true,
      });

      const monotonicId = await insertChat(accountId);
      await pool.query(`INSERT INTO messages (chat_id, role, content) VALUES ($1,'assistant','seed')`, [monotonicId]);
      const futureActivity = new Date("2099-01-01T00:00:00.000Z");
      await pool.query(`UPDATE chats SET updated_at=$2 WHERE id=$1`, [monotonicId, futureActivity]);
      await acceptChatTurn(accountId, monotonicId, "Activity must not move backward");
      expect((await getChatState(monotonicId)).updated_at.toISOString()).toBe(futureActivity.toISOString());
    } finally {
      await cleanupUsers(users);
    }
  });

  it("accepts exactly one of two overlapping turns for the same chat", async () => {
    const users: string[] = [];
    try {
      const accountId = await insertUser("overlap");
      users.push(accountId);
      const chatId = await insertChat(accountId, "selected");

      const results = await Promise.allSettled([
        acceptChatTurn(accountId, chatId, "first overlap"),
        acceptChatTurn(accountId, chatId, "second overlap"),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<AcceptedChatTurn> => result.status === "fulfilled"
      );
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ statusCode: 409, message: "a run is already active for this chat" });
      const messages = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM messages WHERE chat_id=$1 AND role='user'`,
        [chatId]
      );
      expect(messages.rows[0].n).toBe(1);
      await finishAcceptedRun(fulfilled[0].value);
    } finally {
      await cleanupUsers(users);
    }
  });

  it("serializes connector deletion with turn acceptance in both lock orderings", async () => {
    const users: string[] = [];
    try {
      const accountId = await insertUser("connector-delete-race");
      users.push(accountId);

      // Delete-first: the source UPDATE lock prevents acceptance from taking a
      // stale SHARE lock/snapshot. Once deletion commits, acceptance must fail
      // and its message/run transaction must roll back.
      const deleteFirst = await insertConnectorSource(accountId, "delete-first");
      const deleteFirstChat = await insertChat(accountId, "selected");
      await attach(accountId, deleteFirstChat, [deleteFirst.sourceId]);
      const sourceLocked = deferred();
      const allowDelete = deferred();
      const deletion = deleteConnectorLikeRoute(accountId, deleteFirst.connectorId, async () => {
        sourceLocked.resolve();
        await allowDelete.promise;
      });
      await sourceLocked.promise;
      let acceptanceSettled = false;
      const blockedAcceptance = acceptChatTurn(accountId, deleteFirstChat, "must not snapshot deleted source").finally(
        () => {
          acceptanceSettled = true;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(acceptanceSettled).toBe(false);
      allowDelete.resolve();
      await expect(deletion).resolves.toBe("deleted");
      await expect(blockedAcceptance).rejects.toBeTruthy();
      expect(
        (
          await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE chat_id=$1 AND role='user'`, [
            deleteFirstChat,
          ])
        ).rows[0].n
      ).toBe(0);

      // Accept-first: the accepted turn holds a SHARE lock through run commit.
      // Deletion waits, then its fresh active-run guard observes the committed
      // immutable source snapshot and returns a conflict without deleting.
      const acceptFirst = await insertConnectorSource(accountId, "accept-first");
      const acceptFirstChat = await insertChat(accountId, "selected");
      await attach(accountId, acceptFirstChat, [acceptFirst.sourceId]);
      const acceptancePaused = deferred();
      const allowAcceptance = deferred();
      const acceptedPromise = acceptChatTurn(accountId, acceptFirstChat, "holds source share lock", {
        afterSnapshot: async () => {
          acceptancePaused.resolve();
          await allowAcceptance.promise;
        },
      });
      await acceptancePaused.promise;
      let deletionSettled = false;
      const blockedDeletion = deleteConnectorLikeRoute(accountId, acceptFirst.connectorId).finally(() => {
        deletionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(deletionSettled).toBe(false);
      allowAcceptance.resolve();
      const accepted = await acceptedPromise;
      await expect(blockedDeletion).resolves.toBe("conflict");
      expect(
        (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM sources WHERE id=$1`, [acceptFirst.sourceId]))
          .rows[0].n
      ).toBe(1);
      await finishAcceptedRun(accepted);
    } finally {
      await cleanupUsers(users);
    }
  });
});

async function deleteConnectorLikeRoute(
  accountId: string,
  connectorId: string,
  afterSourcesLocked?: () => Promise<void>
): Promise<"deleted" | "conflict"> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    await client.query(`SELECT id FROM connectors WHERE id=$1 AND account_id=$2 FOR UPDATE`, [connectorId, accountId]);
    const sources = await client.query<{ id: string }>(
      `SELECT id FROM sources WHERE connector=$1 AND account_id=$2 FOR UPDATE`,
      [connectorId, accountId]
    );
    await afterSourcesLocked?.();
    for (const source of sources.rows) {
      if (await sourceReferencedByActiveRun(client, accountId, source.id)) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return "conflict";
      }
    }
    await client.query(`DELETE FROM sources WHERE connector=$1 AND account_id=$2`, [connectorId, accountId]);
    await client.query(`DELETE FROM connectors WHERE id=$1 AND account_id=$2`, [connectorId, accountId]);
    await client.query("COMMIT");
    inTransaction = false;
    return "deleted";
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getChatState(chatId: string): Promise<{
  title: string;
  title_is_manual: boolean;
  updated_at: Date;
}> {
  const result = await pool.query<{
    title: string;
    title_is_manual: boolean;
    updated_at: Date;
  }>(`SELECT title, title_is_manual, updated_at FROM chats WHERE id=$1`, [chatId]);
  return result.rows[0];
}

async function acceptFirstTurnWithConcurrentRename(
  accountId: string,
  headers: { authorization: string },
  title: string
): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/api/chats", headers, payload: {} });
  expect(created.statusCode).toBe(200);
  const chatId = created.json().id as string;
  const snapshotAccepted = deferred();
  const allowAcceptance = deferred();
  const acceptance = acceptChatTurn(accountId, chatId, "Generated title must lose", {
    afterSnapshot: async () => {
      snapshotAccepted.resolve();
      await allowAcceptance.promise;
    },
  });
  await snapshotAccepted.promise;

  const rename = app.inject({
    method: "PATCH",
    url: `/api/chats/${chatId}`,
    headers,
    payload: { title },
  });
  allowAcceptance.resolve();
  const [renamed] = await Promise.all([rename, acceptance]);
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json()).not.toHaveProperty("title_is_manual");
  return chatId;
}

async function expectMessageMetaMatches(turn: AcceptedChatTurn): Promise<void> {
  const result = await pool.query<{ meta: Record<string, unknown> }>(`SELECT meta FROM messages WHERE id=$1`, [
    turn.userMessage.id,
  ]);
  expect(result.rows[0].meta).toEqual({
    model: turn.model,
    source_mode: turn.sourceScope.mode,
    source_ids: [...turn.sourceScope.readySourceIds],
  });
}

async function finishAcceptedRun(turn: AcceptedChatTurn): Promise<void> {
  await pool.query(`UPDATE chat_runs SET status='completed', finished_at=now() WHERE id=$1`, [turn.runId]);
}
