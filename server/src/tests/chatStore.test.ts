import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { decodeBoolean, encodeJson } from "../db/codecs.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  ActiveChatRunError,
  ChatStore,
  DuplicateEmailError,
  MAX_CHAT_SOURCE_SCOPE,
  SourceScopeUnavailableError,
  StoreNotFoundError,
} from "../db/stores/chatStore.js";
import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];
const extraLedgers: SqliteLedger[] = [];

afterEach(async () => {
  await Promise.all(extraLedgers.splice(0).map((ledger) => ledger.close()));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function setup(): Promise<{ ledger: SqliteLedger; store: ChatStore; filename: string }> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  return { ledger: resource.ledger, store: new ChatStore(resource.ledger), filename: resource.filename };
}

async function secondStore(filename: string): Promise<{ ledger: SqliteLedger; store: ChatStore }> {
  const ledger = await openSqliteLedger({ path: filename });
  extraLedgers.push(ledger);
  return { ledger, store: new ChatStore(ledger) };
}

async function createUser(store: ChatStore, label: string): Promise<string> {
  return (await store.createUser({ email: `${label}@example.test`, passwordHash: `hash-${label}` })).id;
}

async function insertSource(
  ledger: SqliteLedger,
  accountId: string,
  label: string,
  status: "ready" | "index" | "error" = "ready"
): Promise<string> {
  const id = randomUUID();
  await ledger.run(
    `INSERT INTO sources
       (id,account_id,name,kind,display_name,status,meta)
     VALUES (?,?,?,'tabular',?,?,?)`,
    [id, accountId, `table_${label}`, `${label}.csv`, status, encodeJson({ label })]
  );
  return id;
}

async function createChat(
  store: ChatStore,
  accountId: string,
  sourceIds: readonly string[] = [],
  model = "chat-model"
): Promise<string> {
  return (
    await store.createChat({
      accountId,
      title: "New chat",
      titleIsManual: false,
      model,
      sourceScope: { source_mode: "selected", source_ids: sourceIds },
    })
  ).id;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ChatStore", () => {
  it("creates and finds normalized users while preserving duplicate-email semantics", async () => {
    const { store } = await setup();

    const created = await store.createUser({ email: "  OWNER@Example.Test ", passwordHash: "a-password-hash" });
    expect(created).toMatchObject({ email: "owner@example.test", password_hash: "a-password-hash" });
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await expect(store.findUserByEmail("OWNER@example.test")).resolves.toEqual(created);
    await expect(store.findUserById(created.id.toUpperCase())).resolves.toEqual(created);
    await expect(store.findUserByEmail("missing@example.test")).resolves.toBeUndefined();
    await expect(
      store.createUser({ email: "owner@EXAMPLE.test", passwordHash: "different-hash" })
    ).rejects.toBeInstanceOf(DuplicateEmailError);
  });

  it("creates all, selected, and selected-empty chats atomically without exposing foreign source ids", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "scope-owner");
    const foreign = await createUser(store, "scope-foreign");
    const ready = await insertSource(ledger, owner, "ready");
    const indexing = await insertSource(ledger, owner, "indexing", "index");
    const foreignSource = await insertSource(ledger, foreign, "foreign");

    const selected = await store.createChat({
      accountId: owner.toUpperCase(),
      title: "Selected",
      titleIsManual: true,
      model: "model-selected",
      sourceScope: {
        source_mode: "selected",
        source_ids: [ready.toUpperCase(), indexing.toUpperCase(), ready],
      },
    });
    const resolved = await store.resolveSourceScope(owner.toUpperCase(), selected.id.toUpperCase());
    expect(resolved).toMatchObject({ mode: "selected", readySourceIds: [ready] });
    expect(resolved.attached.map((source) => source.id)).toEqual(expect.arrayContaining([ready, indexing]));

    const empty = await createChat(store, owner);
    await expect(store.resolveSourceScope(owner, empty)).resolves.toMatchObject({
      mode: "selected",
      attached: [],
      readySourceIds: [],
    });

    const all = await store.createChat({
      accountId: owner,
      title: "All",
      titleIsManual: true,
      model: "model-all",
      sourceScope: { source_mode: "all" },
    });
    const later = await insertSource(ledger, owner, "later");
    expect((await store.resolveSourceScope(owner, all.id)).readySourceIds).toEqual(
      expect.arrayContaining([ready, later])
    );

    const unavailable = randomUUID();
    for (const sourceId of [foreignSource, unavailable]) {
      await expect(
        store.createChat({
          accountId: owner,
          title: "Must roll back",
          titleIsManual: true,
          model: "model",
          sourceScope: { source_mode: "selected", source_ids: [sourceId] },
        })
      ).rejects.toMatchObject({
        code: "SOURCE_SCOPE_UNAVAILABLE",
        message: "one or more sources are unavailable",
      });
    }
    expect(await store.listChats(owner)).toHaveLength(3);
  });

  it("enforces the 100-source boundary and preserves exact replacement semantics", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "boundary");
    const sourceIds: string[] = [];
    await ledger.withImmediateTransaction((transaction) => {
      for (let index = 0; index < MAX_CHAT_SOURCE_SCOPE; index += 1) {
        const id = randomUUID();
        sourceIds.push(id);
        transaction.run(
          `INSERT INTO sources
             (id,account_id,name,kind,display_name,status,meta)
           VALUES (?,?,?,'tabular',?,'ready','{}')`,
          [id, owner, `boundary_${index}`, `Boundary ${index}`]
        );
      }
    });

    const chatId = await createChat(store, owner, sourceIds);
    expect((await store.resolveSourceScope(owner, chatId)).attached).toHaveLength(MAX_CHAT_SOURCE_SCOPE);
    await expect(
      store.replaceSourceScope(owner, chatId, {
        source_mode: "selected",
        source_ids: [...sourceIds, randomUUID()],
      })
    ).rejects.toBeInstanceOf(SourceScopeUnavailableError);
    expect((await store.resolveSourceScope(owner, chatId)).attached).toHaveLength(MAX_CHAT_SOURCE_SCOPE);

    await expect(
      store.replaceSourceScope(owner, chatId, { source_mode: "selected", source_ids: [] })
    ).resolves.toMatchObject({
      mode: "selected",
      attached: [],
      readySourceIds: [],
    });
    await expect(store.replaceSourceScope(owner, chatId, { source_mode: "all" })).resolves.toMatchObject({
      mode: "all",
    });
  });

  it("returns a single bounded chat, source, history, and active-run snapshot", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "snapshot");
    const ready = await insertSource(ledger, owner, "ready");
    const indexing = await insertSource(ledger, owner, "indexing", "index");
    const chatId = await createChat(store, owner, [ready, indexing]);
    const first = await ledger.run(
      "INSERT INTO messages (chat_id,role,content,meta,created_at) VALUES (?,'assistant',?,?,?)",
      [chatId, "first message", encodeJson({ first: true }), "2026-08-26T10:00:00.000Z"]
    );
    const second = await ledger.run(
      "INSERT INTO messages (chat_id,role,content,meta,created_at) VALUES (?,'user',?,?,?)",
      [chatId, "second message", encodeJson({ large: "x".repeat(200) }), "2026-08-26T10:01:00.000Z"]
    );
    const third = await ledger.run(
      "INSERT INTO messages (chat_id,role,content,meta,created_at) VALUES (?,'assistant',?,?,?)",
      [chatId, "third message is deliberately long", encodeJson({ third: true }), "2026-08-26T10:02:00.000Z"]
    );
    const runId = randomUUID();
    await ledger.run(
      `INSERT INTO chat_runs
         (id,account_id,chat_id,user_message_id,status,created_at,started_at)
       VALUES (?,?,?,?,'cancelling',?,?)`,
      [runId, owner, chatId, third.lastInsertRowid, "2026-08-26T10:02:00.000Z", "2026-08-26T10:02:00.000Z"]
    );

    const page = await store.getChatSnapshot(owner, chatId, {
      limit: 2,
      maxMessageChars: 6,
      maxHistoryChars: 10_000,
      maxHistoryMetaChars: 40,
    });
    expect(page.source_mode).toBe("selected");
    expect(page.sources).toHaveLength(2);
    expect(page.messages.map((message) => message.id)).toEqual([second.lastInsertRowid, third.lastInsertRowid]);
    expect(page.messages.map((message) => message.content)).toEqual(["second", "third "]);
    expect(page.messages[0].meta).toEqual({ metadata_truncated: true, content_truncated: true });
    expect(page.messages[1].meta).toEqual({ third: true, content_truncated: true });
    expect(page.active_run).toEqual({ id: runId, status: "cancelling" });
    expect(page.messages_page).toEqual({ has_more: true, next_before_message_id: second.lastInsertRowid });
    expect(JSON.stringify(page.messages).length).toBeLessThan(10_000);

    const aggregateBounded = await store.getChatSnapshot(owner, chatId, {
      beforeMessageId: third.lastInsertRowid + 1,
      limit: 3,
      maxMessageChars: 100,
      maxHistoryChars: 260,
      maxHistoryMetaChars: 40,
    });
    expect(JSON.stringify(aggregateBounded.messages).length).toBeLessThanOrEqual(260);
    expect(aggregateBounded.messages_page.has_more).toBe(true);
    expect(first.lastInsertRowid).toBeLessThan(second.lastInsertRowid);
  });

  it("does not advertise an older page when only one oversized message was content-truncated", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "single-history");
    const chatId = await createChat(store, owner);
    await ledger.run("INSERT INTO messages (chat_id,role,content,meta) VALUES (?,'user',?,'{}')", [
      chatId,
      "x".repeat(2_000),
    ]);

    const page = await store.getChatSnapshot(owner, chatId, {
      limit: 10,
      maxMessageChars: 2_000,
      maxHistoryChars: 240,
    });

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.meta).toMatchObject({ content_truncated: true });
    expect(page.messages_page).toEqual({ has_more: false, next_before_message_id: null });
  });

  it("loads agent history only through the exact account, chat, and run boundary", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "agent-history-owner");
    const foreign = await createUser(store, "agent-history-foreign");
    const chatId = await createChat(store, owner);
    await ledger.run("INSERT INTO messages (chat_id,role,content,meta) VALUES (?,'user',?,'{}')", [
      chatId,
      "before 😀😀",
    ]);
    await ledger.run("INSERT INTO messages (chat_id,role,content,meta) VALUES (?,'assistant',?,'{}')", [
      chatId,
      "prior answer",
    ]);
    const accepted = await store.acceptChatTurn(owner, chatId, "current turn");
    await ledger.run("INSERT INTO messages (chat_id,role,content,meta) VALUES (?,'assistant',?,'{}')", [
      chatId,
      "must not enter this run's prompt",
    ]);

    await expect(
      store.listAgentHistoryForRun(owner, chatId, accepted.runId, { limit: 500, maxMessageChars: 8 })
    ).resolves.toEqual([
      { role: "user", content: "before 😀" },
      { role: "assistant", content: "prior an" },
    ]);
    await expect(store.listAgentHistoryForRun(foreign, chatId, accepted.runId)).rejects.toMatchObject({
      code: "STORE_NOT_FOUND",
      resource: "run",
    });
    await expect(store.listAgentHistoryForRun(owner, chatId, randomUUID())).rejects.toMatchObject({
      code: "STORE_NOT_FOUND",
      resource: "run",
    });
  });

  it("applies title and accepted-message limits in Unicode code points", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "unicode-limits");
    const title = "😀".repeat(80);
    const chatId = (
      await store.createChat({
        accountId: owner,
        title,
        titleIsManual: true,
        model: "chat-model",
        sourceScope: { source_mode: "selected", source_ids: [] },
      })
    ).id;
    await expect(store.updateTitle(owner, chatId, title)).resolves.toMatchObject({ title });

    const content = "😀".repeat(100_000);
    const accepted = await store.acceptChatTurn(owner, chatId, content);
    expect(accepted.userMessage.content).toBe(content);
    await ledger.run("UPDATE chat_runs SET status='completed',finished_at=? WHERE id=?", [
      new Date().toISOString(),
      accepted.runId,
    ]);
    const otherChat = await createChat(store, owner);
    await expect(store.acceptChatTurn(owner, otherChat, `${content}😀`)).rejects.toThrow(
      "message content must contain between 1 and 100000 characters"
    );
  });

  it("updates presentation state and deletes only chats without active runs", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "updates");
    const foreign = await createUser(store, "updates-foreign");
    const chatId = await createChat(store, owner);

    await expect(store.updateTitle(owner, chatId, "Manual title")).resolves.toMatchObject({ title: "Manual title" });
    await expect(store.updateModel(owner, chatId, "new-model")).resolves.toMatchObject({ model: "new-model" });
    const storedManual = await ledger.get<{ title_is_manual: bigint }>("SELECT title_is_manual FROM chats WHERE id=?", [
      chatId,
    ]);
    expect(decodeBoolean(storedManual?.title_is_manual)).toBe(true);
    await expect(store.updateTitle(foreign, chatId, "Foreign rename")).rejects.toBeInstanceOf(StoreNotFoundError);

    const accepted = await store.acceptChatTurn(owner, chatId, "keep this chat");
    await expect(store.deleteChat(owner, chatId)).rejects.toBeInstanceOf(ActiveChatRunError);
    await ledger.run("UPDATE chat_runs SET status='completed',finished_at=? WHERE id=?", [
      new Date().toISOString(),
      accepted.runId,
    ]);
    await expect(store.deleteChat(owner, chatId)).resolves.toBeUndefined();
    await expect(store.getChatSnapshot(owner, chatId)).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it("accepts one immutable ready-source turn and normalizes its active-run ledger", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "accept");
    const ready = await insertSource(ledger, owner, "ready");
    const indexing = await insertSource(ledger, owner, "indexing", "index");
    const chatId = await createChat(store, owner, [ready, indexing], "snapshot-model");

    const accepted = await store.acceptChatTurn(
      owner.toUpperCase(),
      chatId.toUpperCase(),
      "Automatic title from first message"
    );
    expect(accepted).toMatchObject({ chatId, model: "snapshot-model" });
    expect(accepted.sourceScope).toMatchObject({ mode: "selected", readySourceIds: [ready] });
    expect(accepted.userMessage.meta).toEqual({
      model: "snapshot-model",
      source_mode: "selected",
      source_ids: [ready],
    });
    await expect(store.sourceReferencedByActiveRun(owner.toUpperCase(), ready.toUpperCase())).resolves.toBe(true);
    await expect(store.sourceReferencedByActiveRun(owner, indexing)).resolves.toBe(false);
    await expect(
      ledger.all("SELECT source_id FROM chat_run_sources WHERE run_id=? ORDER BY source_id", [accepted.runId])
    ).resolves.toEqual([{ source_id: ready }]);
    const message = await ledger.get<{ meta: string }>("SELECT meta FROM messages WHERE id=?", [
      accepted.userMessage.id,
    ]);
    expect(JSON.parse(message?.meta ?? "null")).toEqual(accepted.userMessage.meta);
    await expect(store.getChatSnapshot(owner, chatId)).resolves.toMatchObject({
      title: "Automatic title from first message",
      active_run: { id: accepted.runId, status: "running" },
    });

    await store.replaceSourceScope(owner, chatId, { source_mode: "selected", source_ids: [indexing] });
    await expect(store.resolveSourceScope(owner, chatId)).resolves.toMatchObject({
      mode: "selected",
      attached: [{ id: indexing }],
      readySourceIds: [],
    });
    await expect(
      ledger.all("SELECT source_id FROM chat_run_sources WHERE run_id=? ORDER BY source_id", [accepted.runId])
    ).resolves.toEqual([{ source_id: ready }]);
    await expect(
      ledger.withImmediateTransaction(async (transaction) => {
        if (await store.sourceReferencedByActiveRun(owner, ready, transaction)) return "active";
        transaction.run("DELETE FROM sources WHERE id=? AND account_id=?", [ready, owner]);
        return "deleted";
      })
    ).resolves.toBe("active");
    await expect(ledger.get("SELECT id FROM sources WHERE id=?", [ready])).resolves.toEqual({ id: ready });

    await expect(store.acceptChatTurn(owner, chatId, "overlapping turn")).rejects.toBeInstanceOf(ActiveChatRunError);
    const userMessages = await ledger.get<{ count: bigint }>(
      "SELECT count(*) AS count FROM messages WHERE chat_id=? AND role='user'",
      [chatId]
    );
    expect(userMessages?.count).toBe(1n);
  });

  it("accepts exactly one of two concurrent turns across SQLite connections", async () => {
    const { ledger, store, filename } = await setup();
    const other = await secondStore(filename);
    const owner = await createUser(store, "overlap");
    const chatId = await createChat(store, owner);

    const results = await Promise.allSettled([
      store.acceptChatTurn(owner, chatId, "first overlap"),
      other.store.acceptChatTurn(owner, chatId, "second overlap"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ActiveChatRunError);
    await expect(
      ledger.get<{ messages: bigint; runs: bigint }>(
        `SELECT
           (SELECT count(*) FROM messages WHERE chat_id=?) AS messages,
           (SELECT count(*) FROM chat_runs WHERE chat_id=?) AS runs`,
        [chatId, chatId]
      )
    ).resolves.toEqual({ messages: 1n, runs: 1n });
  });

  it("rolls back the whole accepted-turn ledger when a transaction hook fails", async () => {
    const { ledger, store } = await setup();
    const owner = await createUser(store, "accept-rollback");
    const source = await insertSource(ledger, owner, "rollback-source");
    const chatId = await createChat(store, owner, [source]);

    await expect(
      store.acceptChatTurn(owner, chatId, "must roll back", {
        afterSnapshot: async () => {
          throw new Error("accept rollback canary");
        },
      })
    ).rejects.toThrow("accept rollback canary");
    await expect(
      ledger.get<{ messages: bigint; runs: bigint; run_sources: bigint }>(
        `SELECT
           (SELECT count(*) FROM messages WHERE chat_id=?) AS messages,
           (SELECT count(*) FROM chat_runs WHERE chat_id=?) AS runs,
           (SELECT count(*) FROM chat_run_sources) AS run_sources`,
        [chatId, chatId]
      )
    ).resolves.toEqual({ messages: 0n, runs: 0n, run_sources: 0n });
    await expect(store.acceptChatTurn(owner, chatId, "retry succeeds")).resolves.toMatchObject({
      sourceScope: { readySourceIds: [source] },
    });
  });

  it("serializes accept and source-scope replacement in both orderings", async () => {
    const { ledger, store, filename } = await setup();
    const other = await secondStore(filename);
    const owner = await createUser(store, "replace-race");
    const before = await insertSource(ledger, owner, "before");
    const after = await insertSource(ledger, owner, "after");
    const chatId = await createChat(store, owner, [before], "model-before");

    const acceptedBarrier = deferred();
    const releaseAcceptance = deferred();
    const accepting = store.acceptChatTurn(owner, chatId, "accept first", {
      afterSnapshot: async () => {
        acceptedBarrier.resolve();
        await releaseAcceptance.promise;
      },
    });
    await acceptedBarrier.promise;
    let replacementSettled = false;
    const replacing = other.store
      .replaceSourceScope(owner, chatId, { source_mode: "selected", source_ids: [after] })
      .finally(() => {
        replacementSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replacementSettled).toBe(false);
    releaseAcceptance.resolve();
    const acceptedBefore = await accepting;
    await replacing;
    expect(acceptedBefore.sourceScope.readySourceIds).toEqual([before]);
    expect(await store.sourceReferencedByActiveRun(owner, before)).toBe(true);
    expect(await store.sourceReferencedByActiveRun(owner, after)).toBe(false);
    await ledger.run("UPDATE chat_runs SET status='completed',finished_at=? WHERE id=?", [
      new Date().toISOString(),
      acceptedBefore.runId,
    ]);

    const replacedBarrier = deferred();
    const releaseReplacement = deferred();
    const replacementFirst = other.store.replaceSourceScope(
      owner,
      chatId,
      { source_mode: "selected", source_ids: [before] },
      {
        afterDelete: async () => {
          replacedBarrier.resolve();
          await releaseReplacement.promise;
        },
      }
    );
    await replacedBarrier.promise;
    let acceptanceSettled = false;
    const acceptanceAfter = store.acceptChatTurn(owner, chatId, "replace first").finally(() => {
      acceptanceSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acceptanceSettled).toBe(false);
    releaseReplacement.resolve();
    await replacementFirst;
    await expect(acceptanceAfter).resolves.toMatchObject({
      sourceScope: { mode: "selected", readySourceIds: [before] },
    });
  });

  it("serializes accept and chat deletion without orphan messages", async () => {
    const { ledger, store, filename } = await setup();
    const other = await secondStore(filename);
    const owner = await createUser(store, "chat-delete-race");
    const acceptFirstChat = await createChat(store, owner);

    const acceptedBarrier = deferred();
    const releaseAcceptance = deferred();
    const accepting = store.acceptChatTurn(owner, acceptFirstChat, "accept first", {
      afterSnapshot: async () => {
        acceptedBarrier.resolve();
        await releaseAcceptance.promise;
      },
    });
    await acceptedBarrier.promise;
    let deletionSettled = false;
    const blockedDeletion = other.store.deleteChat(owner, acceptFirstChat).finally(() => {
      deletionSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deletionSettled).toBe(false);
    releaseAcceptance.resolve();
    const accepted = await accepting;
    await expect(blockedDeletion).rejects.toBeInstanceOf(ActiveChatRunError);
    await ledger.run("UPDATE chat_runs SET status='completed',finished_at=? WHERE id=?", [
      new Date().toISOString(),
      accepted.runId,
    ]);

    const deleteFirstChat = await createChat(store, owner);
    const deletedBarrier = deferred();
    const releaseDeletion = deferred();
    const deleting = other.store.deleteChat(owner, deleteFirstChat, {
      afterDelete: async () => {
        deletedBarrier.resolve();
        await releaseDeletion.promise;
      },
    });
    await deletedBarrier.promise;
    let acceptanceSettled = false;
    const rejectedAcceptance = store.acceptChatTurn(owner, deleteFirstChat, "must roll back").finally(() => {
      acceptanceSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acceptanceSettled).toBe(false);
    releaseDeletion.resolve();
    await deleting;
    await expect(rejectedAcceptance).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(ledger.get("SELECT 1 FROM messages WHERE chat_id=?", [deleteFirstChat])).resolves.toBeUndefined();
  });

  it("uses normalized run sources to serialize source deletion in both orderings", async () => {
    const { ledger, store, filename } = await setup();
    const other = await secondStore(filename);
    const owner = await createUser(store, "source-delete-race");
    const acceptFirstSource = await insertSource(ledger, owner, "accept-first");
    const acceptFirstChat = await createChat(store, owner, [acceptFirstSource]);

    const acceptedBarrier = deferred();
    const releaseAcceptance = deferred();
    const accepting = store.acceptChatTurn(owner, acceptFirstChat, "accept before source delete", {
      afterSnapshot: async () => {
        acceptedBarrier.resolve();
        await releaseAcceptance.promise;
      },
    });
    await acceptedBarrier.promise;
    let deletionSettled = false;
    const blockedDeletion = other.ledger
      .withImmediateTransaction(async (transaction) => {
        if (await other.store.sourceReferencedByActiveRun(owner, acceptFirstSource, transaction)) return "active";
        transaction.run("DELETE FROM sources WHERE id=? AND account_id=?", [acceptFirstSource, owner]);
        return "deleted";
      })
      .finally(() => {
        deletionSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deletionSettled).toBe(false);
    releaseAcceptance.resolve();
    const accepted = await accepting;
    await expect(blockedDeletion).resolves.toBe("active");
    await expect(ledger.get("SELECT id FROM sources WHERE id=?", [acceptFirstSource])).resolves.toEqual({
      id: acceptFirstSource,
    });
    await ledger.run("UPDATE chat_runs SET status='completed',finished_at=? WHERE id=?", [
      new Date().toISOString(),
      accepted.runId,
    ]);

    const deleteFirstSource = await insertSource(ledger, owner, "delete-first");
    const deleteFirstChat = await createChat(store, owner, [deleteFirstSource]);
    const sourceDeleted = deferred();
    const releaseDeletion = deferred();
    const deleteFirst = other.ledger.withImmediateTransaction(async (transaction) => {
      transaction.run("DELETE FROM sources WHERE id=? AND account_id=?", [deleteFirstSource, owner]);
      sourceDeleted.resolve();
      await releaseDeletion.promise;
    });
    await sourceDeleted.promise;
    let acceptanceSettled = false;
    const acceptedAfterDelete = store.acceptChatTurn(owner, deleteFirstChat, "delete before accept").finally(() => {
      acceptanceSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acceptanceSettled).toBe(false);
    releaseDeletion.resolve();
    await deleteFirst;
    await expect(acceptedAfterDelete).resolves.toMatchObject({
      sourceScope: { mode: "selected", attached: [], readySourceIds: [] },
      userMessage: { meta: { source_mode: "selected", source_ids: [] } },
    });
    await expect(store.sourceReferencedByActiveRun(owner, deleteFirstSource)).resolves.toBe(false);
  });
});
