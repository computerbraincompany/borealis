import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../turnContext.js", () => ({ acceptChatTurn: vi.fn() }));
vi.mock("../chatRuns.js", () => ({
  beginRun: vi.fn(() => new AbortController()),
  completeRunWithAssistant: vi.fn(),
  finishRunDurably: vi.fn(),
  cancelRun: vi.fn(),
  isRunCancellation: vi.fn(() => false),
}));
vi.mock("../systemHealth.js", () => ({ checkSystemHealth: vi.fn() }));

import { signToken } from "../auth.js";
import { config } from "../config.js";
import { getLlmClient } from "../llm.js";
import { resolveLlmModelId } from "../llmAliases.js";
import { runAgent } from "../agent.js";
import { routes } from "../routes.js";
import { acceptChatTurn } from "../turnContext.js";
import { beginRun, cancelRun, completeRunWithAssistant, finishRunDurably, isRunCancellation } from "../chatRuns.js";
import { checkSystemHealth } from "../systemHealth.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import {
  closeRuntimeSettings,
  getRuntimeSettings,
  initializeRuntimeSettings,
  runtimeSettingsStore,
} from "../runtimeSettings.js";

const runAgentMock = vi.mocked(runAgent);
const acceptChatTurnMock = vi.mocked(acceptChatTurn);
const beginRunMock = vi.mocked(beginRun);
const completeRunMock = vi.mocked(completeRunWithAssistant);
const finishRunMock = vi.mocked(finishRunDurably);
const cancelRunMock = vi.mocked(cancelRun);
const isRunCancellationMock = vi.mocked(isRunCancellation);
const checkSystemHealthMock = vi.mocked(checkSystemHealth);
const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const chatId = "33333333-3333-4333-8333-333333333333";
const authHeader = {
  authorization: `Bearer ${signToken({ userId: accountId, email: "owner@example.test" })}`,
};
const apps: FastifyInstance[] = [];
const tempDirectories: string[] = [];

function completion() {
  return {
    content: "Complete",
    meta: {
      charts: [],
      report: null,
      model: "saved-chat-model",
      source_mode: "selected" as const,
      source_ids: [],
      citations: [],
      evidence: [],
      query_results: [],
    },
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "borealis-model-routes-"));
  tempDirectories.push(directory);
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(directory, "ledger.sqlite"),
    lanceDirectory: path.join(directory, "lance"),
    embeddingDimension: config.embeddingDim,
  });
  await runtime.ledger.run("INSERT OR IGNORE INTO users (id,email,password_hash) VALUES (?,?,?)", [
    accountId,
    "owner@example.test",
    "test-password-hash",
  ]);
  await runtime.ledger.run("INSERT OR IGNORE INTO users (id,email,password_hash) VALUES (?,?,?)", [
    otherAccountId,
    "other@example.test",
    "test-password-hash",
  ]);
  await initializeRuntimeSettings({ settingsFile: path.join(directory, "settings.json"), env: {} });
  const app = Fastify();
  apps.push(app);
  await routes(app);
  await app.ready();
  return app;
}

afterEach(async () => {
  runAgentMock.mockReset();
  acceptChatTurnMock.mockReset();
  beginRunMock.mockReset();
  beginRunMock.mockReturnValue(Promise.resolve(new AbortController()));
  completeRunMock.mockReset();
  completeRunMock.mockResolvedValue({
    status: "completed",
    message: { id: 99, content: "Complete", meta: completion().meta },
  });
  finishRunMock.mockReset();
  finishRunMock.mockResolvedValue("completed");
  cancelRunMock.mockReset();
  isRunCancellationMock.mockReset();
  isRunCancellationMock.mockReturnValue(false);
  checkSystemHealthMock.mockReset();
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  closeRuntimeSettings();
  await closeStorageRuntime();
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("model catalog route", () => {
  it("requires authentication without touching the upstream catalog", async () => {
    const app = await buildApp();
    const client = await getLlmClient();
    const list = vi.spyOn(client.models, "list");

    const response = await app.inject({ method: "GET", url: "/api/models" });

    expect(response.statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("returns only the stable catalog fields", async () => {
    const app = await buildApp();
    const client = await getLlmClient();
    vi.spyOn(client.models, "list").mockResolvedValue({
      data: [
        { id: "chat-b", owned_by: "local" },
        { id: resolveLlmModelId("nomic-embed") },
        { id: "qwen/qwen3.6-35b-a3b" },
      ],
    } as any);
    const response = await app.inject({
      method: "GET",
      url: "/api/models?refresh=1",
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual([
      "account_default_model",
      "default_model",
      "discovery",
      "models",
    ]);
    expect(response.json()).toEqual({
      models: [{ id: "chat-b", owned_by: "local" }, { id: "qwen-chat" }],
      default_model: "qwen-chat",
      account_default_model: null,
      discovery: "live",
    });
  });

  it("exposes the account default model alongside the workspace default", async () => {
    const app = await buildApp();
    const client = await getLlmClient();
    vi.spyOn(client.models, "list").mockResolvedValue({
      data: [{ id: "personal-default" }],
    } as any);
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: authHeader,
      payload: { default_chat_model: "personal-default" },
    });
    expect(saved.statusCode).toBe(200);

    const catalog = await app.inject({ method: "GET", url: "/api/models?refresh=1", headers: authHeader });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      default_model: "qwen-chat",
      account_default_model: "personal-default",
    });

    const otherHeader = {
      authorization: `Bearer ${signToken({ userId: otherAccountId, email: "other@example.test" })}`,
    };
    const otherCatalog = await app.inject({ method: "GET", url: "/api/models?refresh=1", headers: otherHeader });
    expect(otherCatalog.json()).toMatchObject({ default_model: "qwen-chat", account_default_model: null });
  });

  it("publishes protected API security with explicit public auth and health overrides", async () => {
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/openapi.json", headers: authHeader });

    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/health",
        "/api/register",
        "/api/login",
        "/api/me",
        "/api/settings",
        "/api/settings/test",
        "/api/chats",
        "/api/chats/{id}",
        "/api/chats/{id}/messages",
        "/api/sources",
        "/api/sources/upload",
        "/api/connectors",
        "/api/reports/{id}",
      ])
    );
    expect(document.paths["/health"].get.security).toEqual([]);
    expect(document.paths["/api/register"].post.security).toEqual([]);
    expect(document.paths["/api/login"].post.security).toEqual([]);
  });
});

describe("system health route", () => {
  const systemHealth = {
    status: "operational" as const,
    checked_at: "2026-08-26T09:30:00.000Z",
    services: [
      {
        id: "api" as const,
        name: "Borealis API",
        description: "The application server is accepting requests.",
        status: "operational" as const,
        latency_ms: 0,
      },
    ],
  };

  it("requires authentication before probing dependencies", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(401);
    expect(checkSystemHealthMock).not.toHaveBeenCalled();
  });

  it("returns the protected readiness result", async () => {
    checkSystemHealthMock.mockResolvedValue(systemHealth);
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health", headers: authHeader });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(systemHealth);
    expect(checkSystemHealthMock).toHaveBeenCalledOnce();
  });
});

describe("chat persistence routes", () => {
  async function seedChat(owner = accountId, title = "Analysis") {
    return storageRuntime().chats.createChat({
      accountId: owner,
      title,
      titleIsManual: true,
      model: "chat-a",
      sourceScope: { source_mode: "selected", source_ids: [] },
    });
  }

  it("lists chats by deterministic activity order and includes updated_at", async () => {
    const app = await buildApp();
    const older = await seedChat(accountId, "Older");
    const recent = await seedChat(accountId, "Recently active");
    await storageRuntime().ledger.run("UPDATE chats SET updated_at=? WHERE id=?", [
      "2026-08-20T00:00:00.000Z",
      older.id,
    ]);
    await storageRuntime().ledger.run("UPDATE chats SET updated_at=? WHERE id=?", [
      "2026-08-23T00:00:00.000Z",
      recent.id,
    ]);

    const response = await app.inject({ method: "GET", url: "/api/chats", headers: authHeader });

    expect(response.statusCode).toBe(200);
    expect(response.json().map((chat: { title: string }) => chat.title)).toEqual(["Recently active", "Older"]);
    expect(response.json()[0].updated_at).toBe("2026-08-23T00:00:00.000Z");
  });

  it("marks an explicit create title as manual while using the configured model", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: authHeader,
      payload: { title: "Analysis" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe("qwen-chat");
    expect(response.json()).toMatchObject({ title: "Analysis", source_mode: "all" });
    await expect(
      storageRuntime().ledger.get("SELECT title_is_manual FROM chats WHERE id=?", [response.json().id])
    ).resolves.toEqual({ title_is_manual: 1n });
  });

  it("stamps the account default chat model on new chats while other accounts keep the workspace default", async () => {
    const app = await buildApp();
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: authHeader,
      payload: { default_chat_model: "personal-default" },
    });
    expect(saved.statusCode).toBe(200);

    const created = await app.inject({ method: "POST", url: "/api/chats", headers: authHeader, payload: {} });
    expect(created.statusCode).toBe(200);
    expect(created.json().model).toBe("personal-default");

    const otherHeader = {
      authorization: `Bearer ${signToken({ userId: otherAccountId, email: "other@example.test" })}`,
    };
    const otherCreated = await app.inject({ method: "POST", url: "/api/chats", headers: otherHeader, payload: {} });
    expect(otherCreated.statusCode).toBe(200);
    expect(otherCreated.json().model).toBe("qwen-chat");

    // The configured model of an existing chat never changes implicitly.
    const reread = await app.inject({ method: "GET", url: `/api/chats/${created.json().id}`, headers: authHeader });
    expect(reread.json().model).toBe("personal-default");
  });

  it("hot-applies saved model defaults to discovery, new chats, and embedding-role rejection", async () => {
    const app = await buildApp();
    const beforeRevision = (await getRuntimeSettings()).revision;

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: authHeader,
      payload: {
        default_chat_model: "saved-default-chat",
        default_embed_model: "saved-default-embed",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      default_chat_model: "saved-default-chat",
      default_embed_model: "saved-default-embed",
    });
    expect((await getRuntimeSettings()).revision).toBeGreaterThan(beforeRevision);

    const client = await getLlmClient();
    vi.spyOn(client.models, "list").mockResolvedValue({
      data: [{ id: "saved-default-chat" }, { id: "saved-default-embed" }],
    } as any);
    const catalog = await app.inject({ method: "GET", url: "/api/models?refresh=1", headers: authHeader });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual({
      models: [{ id: "saved-default-chat" }],
      default_model: "saved-default-chat",
      account_default_model: null,
      discovery: "live",
    });

    const created = await app.inject({ method: "POST", url: "/api/chats", headers: authHeader, payload: {} });
    expect(created.statusCode).toBe(200);
    expect(created.json().model).toBe("saved-default-chat");

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/chats/${created.json().id}`,
      headers: authHeader,
      payload: { model: "saved-default-embed" },
    });
    expect(rejected.statusCode).toBe(400);
    await expect(storageRuntime().chats.getChatSnapshot(accountId, created.json().id)).resolves.toMatchObject({
      model: "saved-default-chat",
    });
  });

  it("distinguishes an omitted title from an intentional manual title of New chat", async () => {
    const app = await buildApp();

    const automatic = await app.inject({ method: "POST", url: "/api/chats", headers: authHeader, payload: {} });
    const manual = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: authHeader,
      payload: { title: "  New chat  " },
    });

    expect(automatic.statusCode).toBe(200);
    expect(manual.statusCode).toBe(200);
    await expect(storageRuntime().ledger.all("SELECT title_is_manual FROM chats ORDER BY rowid")).resolves.toEqual([
      { title_is_manual: 0n },
      { title_is_manual: 1n },
    ]);
  });

  it.each([{ title: "" }, { title: "   " }, { title: "x".repeat(81) }, { title: 42 }])(
    "rejects an invalid explicit create title",
    async (payload) => {
      const app = await buildApp();
      const response = await app.inject({ method: "POST", url: "/api/chats", headers: authHeader, payload });

      expect(response.statusCode).toBe(400);
      await expect(storageRuntime().chats.listChats(accountId)).resolves.toEqual([]);
    }
  );

  it("trims and updates a model without advancing chat activity", async () => {
    const app = await buildApp();
    const chat = await seedChat();
    const before = await storageRuntime().chats.getChatSnapshot(accountId, chat.id);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: authHeader,
      payload: { model: "  chat-b  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe("chat-b");
    expect(response.json().updated_at).toBe(before.updated_at);
  });

  it("trims and manually renames an owned chat while advancing activity", async () => {
    const app = await buildApp();
    const chat = await seedChat();
    await storageRuntime().ledger.run("UPDATE chats SET updated_at=? WHERE id=?", [
      "2000-01-01T00:00:00.000Z",
      chat.id,
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: authHeader,
      payload: { title: "  Quarterly budget review  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("Quarterly budget review");
    expect(response.json().updated_at).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it.each([{ model: "chat-b" }, { title: "Private rename" }])(
    "returns 404 for another account's chat without changing a row",
    async (payload) => {
      const app = await buildApp();
      const chat = await seedChat();
      const otherHeader = {
        authorization: `Bearer ${signToken({ userId: otherAccountId, email: "other@example.test" })}`,
      };

      const response = await app.inject({
        method: "PATCH",
        url: `/api/chats/${chat.id}`,
        headers: otherHeader,
        payload,
      });

      expect(response.statusCode).toBe(404);
      await expect(storageRuntime().chats.getChatSnapshot(accountId, chat.id)).resolves.toMatchObject({
        title: "Analysis",
        model: "chat-a",
      });
    }
  );

  it.each([
    undefined,
    [],
    {},
    { model: "" },
    { model: "x".repeat(257) },
    { model: "chat-b", extra: true },
    { model: 42 },
    { title: "" },
    { title: "   " },
    { title: "x".repeat(81) },
    { title: 42 },
    { title: "Valid", extra: true },
    { model: "chat-b", title: "Valid" },
  ])("rejects invalid or non-exact mutation bodies", async (payload) => {
    const app = await buildApp();
    const chat = await seedChat();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: authHeader,
      ...(payload === undefined ? {} : { payload }),
    });

    expect(response.statusCode).toBe(400);
    await expect(storageRuntime().chats.getChatSnapshot(accountId, chat.id)).resolves.toMatchObject({
      title: "Analysis",
      model: "chat-a",
    });
  });

  it("counts title limits by Unicode characters rather than UTF-16 code units", async () => {
    const title = "🧊".repeat(80);
    const app = await buildApp();
    const chat = await seedChat();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: authHeader,
      payload: { title },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe(title);
  });

  it("rejects the configured embedding model", async () => {
    const app = await buildApp();
    const chat = await seedChat();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: authHeader,
      payload: { model: "nomic-embed" },
    });

    expect(response.statusCode).toBe(400);
    await expect(storageRuntime().chats.getChatSnapshot(accountId, chat.id)).resolves.toMatchObject({
      model: "chat-a",
    });
  });

  it("rejects the physical target of the configured embedding alias", async () => {
    const app = await buildApp();
    const chat = await seedChat();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chat.id}`,
      headers: authHeader,
      payload: { model: resolveLlmModelId("nomic-embed") },
    });

    expect(response.statusCode).toBe(400);
    await expect(storageRuntime().chats.getChatSnapshot(accountId, chat.id)).resolves.toMatchObject({
      model: "chat-a",
    });
  });

  it("snapshots the saved chat model before accepting a turn", async () => {
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "saved-chat-model",
      agent: null,
      sourceScope,
      userMessage: {
        id: 10,
        role: "user",
        content: "Use my data",
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-23T00:00:00Z",
      },
    });
    runAgentMock.mockResolvedValueOnce(completion());
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Use my data" },
    });

    expect(response.statusCode).toBe(200);
    expect(acceptChatTurnMock).toHaveBeenCalledWith(accountId, chatId, "Use my data");
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        chatId,
        content: "Use my data",
        model: "saved-chat-model",
        sourceScope,
      })
    );
    expect(beginRunMock).toHaveBeenCalledWith(accountId, chatId, "55555555-5555-4555-8555-555555555555");
    expect(beginRunMock.mock.invocationCallOrder[0]).toBeLessThan(runAgentMock.mock.invocationCallOrder[0]);
    expect(response.body).toContain('"type":"run-started"');
    expect(response.body).toContain('"type":"run-ended"');
    expect(response.body).toContain('"status":"completed"');
  });

  it("accepts a maximum-length message whose JSON transport uses control escapes", async () => {
    const content = "\u0001".repeat(config.maxMessageChars);
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "saved-chat-model",
      agent: null,
      sourceScope,
      userMessage: {
        id: 11,
        role: "user",
        content,
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-23T00:00:00Z",
      },
    });
    runAgentMock.mockResolvedValueOnce(completion());
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content },
    });

    expect(response.statusCode).toBe(200);
    expect(acceptChatTurnMock).toHaveBeenCalledWith(accountId, chatId, content);
    expect(response.body).toContain('"type":"run-ended"');
  });

  it("accepts maximum decoded astral content encoded as JSON surrogate escapes", async () => {
    const content = "😀".repeat(config.maxMessageChars);
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "saved-chat-model",
      agent: null,
      sourceScope,
      userMessage: {
        id: 12,
        role: "user",
        content,
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-23T00:00:00Z",
      },
    });
    runAgentMock.mockResolvedValueOnce(completion());
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: { ...authHeader, "content-type": "application/json" },
      payload: `{"content":"${"\\ud83d\\ude00".repeat(config.maxMessageChars)}"}`,
    });

    expect(response.statusCode).toBe(200);
    expect(acceptChatTurnMock).toHaveBeenCalledWith(accountId, chatId, content);
    expect(response.body).toContain('"type":"run-ended"');
  });

  it("emits terminal cancellation without presenting cancellation as an error", async () => {
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "saved-chat-model",
      agent: null,
      sourceScope,
      userMessage: {
        id: 12,
        role: "user",
        content: "Cancel me",
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-23T00:00:00Z",
      },
    });
    const cancelled = new Error("cancelled");
    cancelled.name = "AbortError";
    runAgentMock.mockRejectedValueOnce(cancelled);
    isRunCancellationMock.mockReturnValueOnce(true);
    finishRunMock.mockResolvedValueOnce("cancelled");
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Cancel me" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"run-ended"');
    expect(response.body).toContain('"status":"cancelled"');
    expect(response.body).not.toContain('"type":"error"');
    expect(finishRunMock).toHaveBeenCalledWith(
      accountId,
      chatId,
      "55555555-5555-4555-8555-555555555555",
      "cancelled",
      "CANCELLED"
    );
  });

  it("never emits success done before durable run completion succeeds", async () => {
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "saved-chat-model",
      agent: null,
      sourceScope,
      userMessage: {
        id: 13,
        role: "user",
        content: "Finish safely",
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-23T00:00:00Z",
      },
    });
    runAgentMock.mockResolvedValueOnce(completion());
    completeRunMock.mockRejectedValueOnce(new Error("database unavailable"));
    finishRunMock.mockResolvedValueOnce("failed");
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Finish safely" },
    });

    expect(response.body).not.toContain('"type":"done"');
    expect(response.body).not.toContain('"status":"completed"');
    expect(response.body).toContain('"status":"failed"');
    expect(finishRunMock).toHaveBeenCalledWith(
      accountId,
      chatId,
      "55555555-5555-4555-8555-555555555555",
      "failed",
      "AGENT_FAILED"
    );
  });

  it("emits cancellation, not a provider error, when cancel wins the terminal failure race", async () => {
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "saved-chat-model",
      agent: null,
      sourceScope,
      userMessage: {
        id: 14,
        role: "user",
        content: "Cancel during failure",
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-23T00:00:00Z",
      },
    });
    runAgentMock.mockRejectedValueOnce(new Error("provider unavailable"));
    finishRunMock.mockResolvedValueOnce("cancelled");
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Cancel during failure" },
    });

    expect(response.body).toContain('"type":"run-ended"');
    expect(response.body).toContain('"status":"cancelled"');
    expect(response.body).not.toContain('"type":"error"');
  });

  it("returns an owned terminal run status idempotently from cancellation", async () => {
    cancelRunMock.mockResolvedValueOnce("cancelled");
    const app = await buildApp();
    const runId = "55555555-5555-4555-8555-555555555555";

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chatId}/runs/${runId}`,
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, run_id: runId, status: "cancelled" });
  });

  it("does not expose raw provider failures in the SSE stream", async () => {
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "unavailable-model",
      agent: null,
      sourceScope,
      userMessage: {
        id: 11,
        role: "user",
        content: "Use this model",
        meta: { model: "unavailable-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-23T00:00:00Z",
      },
    });
    const upstreamError = new Error("raw upstream https://provider.invalid/v1 sk-sensitive response body") as Error & {
      code: string;
    };
    upstreamError.name = "https://provider.invalid/sk-sensitive";
    upstreamError.code = "sk-sensitive response body";
    runAgentMock.mockRejectedValueOnce(upstreamError);
    finishRunMock.mockResolvedValueOnce("failed");
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Use this model" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("The selected model could not complete this turn");
    expect(response.body).not.toContain("provider.invalid");
    expect(response.body).not.toContain("sk-sensitive");
  });
});

describe("remote egress consent gate", () => {
  it("fails chat sends closed until remote egress is acknowledged, then resumes", async () => {
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValue({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "saved-chat-model",
      agent: null,
      sourceScope,
      userMessage: {
        id: 12,
        role: "user",
        content: "Use my data",
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-29T00:00:00Z",
      },
    });
    runAgentMock.mockResolvedValue(completion());
    const app = await buildApp();
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider.example" });

    const blocked = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Use my data" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "REMOTE_EGRESS_CONSENT_REQUIRED" });
    expect(acceptChatTurnMock).not.toHaveBeenCalled();
    expect(beginRunMock).not.toHaveBeenCalled();

    const consentState = await app.inject({
      method: "GET",
      url: "/api/consent/remote-egress",
      headers: authHeader,
    });
    expect(consentState.json()).toEqual({
      required: true,
      acknowledged_at: null,
      endpoint_host: "api.provider.example",
    });

    const acknowledged = await app.inject({
      method: "POST",
      url: "/api/consent/remote-egress",
      headers: authHeader,
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toMatchObject({
      required: true,
      endpoint_host: "api.provider.example",
      acknowledged_at: expect.any(String),
    });

    const resumed = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Use my data" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).toContain('"type":"run-started"');
    expect(acceptChatTurnMock).toHaveBeenCalledOnce();
  });

  it("never gates loopback providers", async () => {
    acceptChatTurnMock.mockResolvedValue({
      runId: "55555555-5555-4555-8555-555555555555",
      chatId,
      model: "saved-chat-model",
      agent: null,
      sourceScope: Object.freeze({
        mode: "selected" as const,
        attached: Object.freeze([]),
        readySourceIds: Object.freeze([]),
        readyTableNames: Object.freeze([]),
      }),
      userMessage: {
        id: 13,
        role: "user",
        content: "Local turn",
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-29T00:00:00Z",
      },
    });
    runAgentMock.mockResolvedValue(completion());
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Local turn" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"run-started"');

    const consentState = await app.inject({
      method: "GET",
      url: "/api/consent/remote-egress",
      headers: authHeader,
    });
    expect(consentState.json()).toEqual({ required: false, acknowledged_at: null, endpoint_host: null });
  });
});
