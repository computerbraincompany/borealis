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

describe("chat model persistence routes", () => {
  it("uses the configured default explicitly when creating a chat", async () => {
    qMock.mockResolvedValueOnce([
      { id: chatId, title: "Analysis", model: config.chatModel, source_mode: "all", created_at: "2026-08-23T00:00:00Z" },
    ]);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: authHeader,
      payload: { title: "Analysis" },
    });

    expect(response.statusCode).toBe(200);
    expect(qMock.mock.calls[0][0]).toContain("INSERT INTO chats (id, account_id, title, model, source_mode)");
    expect(qMock.mock.calls[0][1]?.slice(1)).toEqual([accountId, "Analysis", config.chatModel]);
    expect(response.json().model).toBe(config.chatModel);
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
  });

  it("returns 404 for another account's chat without changing a row", async () => {
    qMock.mockResolvedValueOnce([]);
    const app = await buildApp();
    const otherHeader = {
      authorization: `Bearer ${signToken({ userId: otherAccountId, email: "other@example.test" })}`,
    };

    const response = await app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}`,
      headers: otherHeader,
      payload: { model: "chat-b" },
    });

    expect(response.statusCode).toBe(404);
    expect(qMock).toHaveBeenCalledOnce();
    expect(qMock.mock.calls[0][1]).toEqual([chatId, otherAccountId, "chat-b"]);
  });

  it.each([
    undefined,
    {},
    { model: "" },
    { model: "x".repeat(257) },
    { model: "chat-b", extra: true },
    { model: 42 },
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
