import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn(), pool: { connect: vi.fn(), query: vi.fn() } }));
vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../turnContext.js", () => ({ acceptChatTurn: vi.fn() }));

import { signToken } from "../auth.js";
import { config } from "../config.js";
import { q } from "../db.js";
import { client } from "../llm.js";
import { runAgent } from "../agent.js";
import { routes } from "../routes.js";
import { acceptChatTurn } from "../turnContext.js";

const qMock = vi.mocked(q);
const runAgentMock = vi.mocked(runAgent);
const acceptChatTurnMock = vi.mocked(acceptChatTurn);
const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const chatId = "33333333-3333-4333-8333-333333333333";
const authHeader = {
  authorization: `Bearer ${signToken({ userId: accountId, email: "owner@example.test" })}`,
};
const apps: FastifyInstance[] = [];

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await routes(app);
  await app.ready();
  return app;
}

afterEach(async () => {
  qMock.mockReset();
  runAgentMock.mockReset();
  acceptChatTurnMock.mockReset();
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("model catalog route", () => {
  it("requires authentication without touching the upstream catalog", async () => {
    const list = vi.spyOn(client.models, "list");
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/models" });

    expect(response.statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("returns only the stable catalog fields", async () => {
    vi.spyOn(client.models, "list").mockResolvedValue({
      data: [{ id: "chat-b", owned_by: "local" }, { id: config.embedModel }, { id: "chat-a" }],
    } as any);
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/models?refresh=1",
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(["default_model", "discovery", "models"]);
    expect(response.json()).toEqual({
      models: [{ id: "chat-a" }, { id: "chat-b", owned_by: "local" }],
      default_model: config.chatModel,
      discovery: "live",
    });
  });
});

describe("chat persistence routes", () => {
  it("lists chats by deterministic activity order and includes updated_at", async () => {
    qMock.mockResolvedValueOnce([{
      id: chatId,
      title: "Recently active",
      model: "chat-b",
      source_mode: "all",
      created_at: "2026-08-20T00:00:00Z",
      updated_at: "2026-08-23T00:00:00Z",
    }]);
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/chats", headers: authHeader });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0].updated_at).toBe("2026-08-23T00:00:00Z");
    expect(qMock).toHaveBeenCalledWith(expect.stringContaining("ORDER BY updated_at DESC, id DESC"), [accountId]);
  });

  it("marks an explicit create title as manual while using the configured model", async () => {
    qMock.mockResolvedValueOnce([
      {
        id: chatId,
        title: "Analysis",
        model: config.chatModel,
        source_mode: "all",
        created_at: "2026-08-23T00:00:00Z",
        updated_at: "2026-08-23T00:00:00Z",
      },
    ]);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: authHeader,
      payload: { title: "Analysis" },
    });

    expect(response.statusCode).toBe(200);
    expect(qMock.mock.calls[0][0]).toContain(
      "INSERT INTO chats (id, account_id, title, title_is_manual, model, source_mode)"
    );
    expect(qMock.mock.calls[0][1]?.slice(1)).toEqual([accountId, "Analysis", true, config.chatModel]);
    expect(response.json().model).toBe(config.chatModel);
    expect(response.json().updated_at).toBe("2026-08-23T00:00:00Z");
  });

  it("distinguishes an omitted title from an intentional manual title of New chat", async () => {
    qMock
      .mockResolvedValueOnce([{
        id: chatId,
        title: "New chat",
        model: config.chatModel,
        source_mode: "all",
        created_at: "2026-08-23T00:00:00Z",
        updated_at: "2026-08-23T00:00:00Z",
      }])
      .mockResolvedValueOnce([{
        id: chatId,
        title: "New chat",
        model: config.chatModel,
        source_mode: "all",
        created_at: "2026-08-23T00:00:00Z",
        updated_at: "2026-08-23T00:00:00Z",
      }]);
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
    expect(qMock.mock.calls[0][1]?.slice(1)).toEqual([accountId, "New chat", false, config.chatModel]);
    expect(qMock.mock.calls[1][1]?.slice(1)).toEqual([accountId, "New chat", true, config.chatModel]);
  });

  it.each([
    { title: "" },
    { title: "   " },
    { title: "x".repeat(81) },
    { title: 42 },
  ])("rejects an invalid explicit create title", async (payload) => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/chats", headers: authHeader, payload });

    expect(response.statusCode).toBe(400);
    expect(qMock).not.toHaveBeenCalled();
  });

  it("trims and updates a model with the account predicate", async () => {
    qMock.mockResolvedValueOnce([
      { id: chatId, title: "Analysis", model: "chat-b", created_at: "2026-08-23T00:00:00Z" },
    ]);
    const app = await buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}`,
      headers: authHeader,
      payload: { model: "  chat-b  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe("chat-b");
    expect(qMock).toHaveBeenCalledWith(expect.stringContaining("WHERE id=$1 AND account_id=$2"), [chatId, accountId, "chat-b"]);
    expect(qMock.mock.calls[0][0]).not.toContain("title_is_manual");
    expect(qMock.mock.calls[0][0]).not.toContain("updated_at=now()");
  });

  it("trims and manually renames an owned chat while advancing activity", async () => {
    qMock.mockResolvedValueOnce([{
      id: chatId,
      title: "Quarterly budget review",
      model: "chat-b",
      source_mode: "selected",
      created_at: "2026-08-20T00:00:00Z",
      updated_at: "2026-08-23T00:00:00Z",
    }]);
    const app = await buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}`,
      headers: authHeader,
      payload: { title: "  Quarterly budget review  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: "Quarterly budget review", updated_at: "2026-08-23T00:00:00Z" });
    expect(qMock).toHaveBeenCalledWith(
      expect.stringMatching(/title_is_manual=true, updated_at=now\(\)/),
      [chatId, accountId, "Quarterly budget review"]
    );
  });

  it.each([{ model: "chat-b" }, { title: "Private rename" }])(
    "returns 404 for another account's chat without changing a row",
    async (payload) => {
      qMock.mockResolvedValueOnce([]);
      const app = await buildApp();
      const otherHeader = {
        authorization: `Bearer ${signToken({ userId: otherAccountId, email: "other@example.test" })}`,
      };

      const response = await app.inject({
        method: "PATCH",
        url: `/api/chats/${chatId}`,
        headers: otherHeader,
        payload,
      });

      expect(response.statusCode).toBe(404);
      expect(qMock).toHaveBeenCalledOnce();
      expect(qMock.mock.calls[0][1]).toEqual([chatId, otherAccountId, Object.values(payload)[0]]);
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
    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}`,
      headers: authHeader,
      ...(payload === undefined ? {} : { payload }),
    });

    expect(response.statusCode).toBe(400);
    expect(qMock).not.toHaveBeenCalled();
  });

  it("counts title limits by Unicode characters rather than UTF-16 code units", async () => {
    const title = "🧊".repeat(80);
    qMock.mockResolvedValueOnce([{
      id: chatId,
      title,
      model: "chat-b",
      source_mode: "all",
      created_at: "2026-08-20T00:00:00Z",
      updated_at: "2026-08-23T00:00:00Z",
    }]);
    const app = await buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}`,
      headers: authHeader,
      payload: { title },
    });

    expect(response.statusCode).toBe(200);
    expect(qMock.mock.calls[0][1]).toEqual([chatId, accountId, title]);
  });

  it("rejects the configured embedding model", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}`,
      headers: authHeader,
      payload: { model: config.embedModel },
    });

    expect(response.statusCode).toBe(400);
    expect(qMock).not.toHaveBeenCalled();
  });

  it("snapshots the saved chat model before accepting a turn", async () => {
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      chatId,
      model: "saved-chat-model",
      sourceScope,
      userMessage: {
        id: 10,
        role: "user",
        content: "Use my data",
        meta: { model: "saved-chat-model", source_mode: "selected", source_ids: [] },
        created_at: "2026-08-23T00:00:00Z",
      },
    });
    runAgentMock.mockResolvedValueOnce();
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: authHeader,
      payload: { content: "Use my data" },
    });

    expect(response.statusCode).toBe(200);
    expect(acceptChatTurnMock).toHaveBeenCalledWith(accountId, chatId, "Use my data");
    expect(qMock).not.toHaveBeenCalled();
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        chatId,
        content: "Use my data",
        model: "saved-chat-model",
        sourceScope,
      })
    );
  });

  it("does not expose raw provider failures in the SSE stream", async () => {
    const sourceScope = Object.freeze({
      mode: "selected" as const,
      attached: Object.freeze([]),
      readySourceIds: Object.freeze([]),
      readyTableNames: Object.freeze([]),
    });
    acceptChatTurnMock.mockResolvedValueOnce({
      chatId,
      model: "unavailable-model",
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    expect(warn).toHaveBeenCalledWith("agent run failed", { name: "Error" });
  });
});
