import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  q: vi.fn(),
  pool: { connect: vi.fn(), query: vi.fn() },
}));
vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));

import { signToken } from "../auth.js";
import { pool, q } from "../db.js";
import { routes } from "../routes.js";
import { buildHistoryPage } from "../routes/chats.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const auth = { authorization: `Bearer ${signToken({ userId: ACCOUNT, email: "owner@example.test" })}` };
const qMock = vi.mocked(q);
const connectMock = vi.mocked(pool.connect);
const apps: FastifyInstance[] = [];

function clientWith(rows: any[][]) {
  const query = vi.fn();
  for (const resultRows of rows) query.mockResolvedValueOnce({ rows: resultRows });
  query.mockResolvedValue({ rows: [] });
  return { query, release: vi.fn() };
}

async function buildApp() {
  const app = Fastify();
  apps.push(app);
  await routes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  qMock.mockReset();
  connectMock.mockReset();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("chat source-scope routes", () => {
  it("preserves accepted astral characters when enforcing the history message boundary", () => {
    const emoji = "😀".repeat(4);
    const page = buildHistoryPage([{ id: 1, role: "user", content: emoji, meta: {} }], 1, 10_000, 4);
    expect(page.messages[0].content).toBe(emoji);
    expect(page.messages[0].meta).toEqual({});

    const oversized = buildHistoryPage([{ id: 2, role: "user", content: "😀".repeat(5), meta: {} }], 1, 10_000, 4);
    expect(oversized.messages[0].content).toBe("😀".repeat(4));
    expect(oversized.messages[0].meta).toEqual({ content_truncated: true });
  });

  it("returns a cursor-bearing bounded row when legal control characters expand during JSON serialization", () => {
    const page = buildHistoryPage(
      [{ id: 77, role: "user", content: "\u0001".repeat(32_000), meta: {}, created_at: "now" }],
      80,
      120_000,
      32_000
    );

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].id).toBe(77);
    expect(page.messages[0].content.length).toBeGreaterThan(0);
    expect(page.messages[0].content.length).toBeLessThan(32_000);
    expect(page.messages[0].meta).toEqual({ content_truncated: true });
    expect(JSON.stringify(page.messages).length).toBeLessThanOrEqual(120_000);
    expect(page.hasMore).toBe(false);
  });

  it("bounds default history while returning active-run state", async () => {
    const messages = [
      { id: 1, role: "user", content: "one", meta: {}, created_at: "now" },
      { id: 2, role: "assistant", content: "two", meta: {}, created_at: "now" },
    ];
    const activeRun = { id: "44444444-4444-4444-8444-444444444444", status: "running" };
    const client = clientWith([
      [],
      [{ id: CHAT, title: "Chat", model: "model", created_at: "now", updated_at: "now" }],
      [{ source_mode: "selected" }],
      [],
      messages,
      [activeRun],
      [],
    ]);
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/api/chats/${CHAT}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      messages,
      messages_page: { has_more: false, next_before_message_id: null },
      active_run: activeRun,
    });
    const messageCall = client.query.mock.calls.find(([sql]) => String(sql).includes("FROM messages"));
    expect(messageCall?.[0]).toContain("LIMIT");
    expect(messageCall?.[0]).toContain("octet_length(meta::text)");
    expect(messageCall?.[0]).not.toContain("pg_column_size(meta)");
    expect(messageCall?.[1]).toEqual([CHAT, null, 81, 32_000, 32_000]);
  });

  it("returns deterministic newest-page cursor metadata", async () => {
    const client = clientWith([
      [],
      [{ id: CHAT, title: "Chat", model: "model", created_at: "now", updated_at: "now" }],
      [{ source_mode: "selected" }],
      [],
      [
        { id: 2, role: "assistant", content: "two", meta: {}, created_at: "now" },
        { id: 3, role: "user", content: "three", meta: {}, created_at: "now" },
        { id: 4, role: "assistant", content: "four", meta: {}, created_at: "now" },
      ],
      [],
      [],
    ]);
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/chats/${CHAT}?before_message_id=5&limit=2`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages.map((message: any) => message.id)).toEqual([3, 4]);
    expect(response.json().messages_page).toEqual({ has_more: true, next_before_message_id: 3 });
    const messageCall = client.query.mock.calls.find(([sql]) => String(sql).includes("FROM messages"));
    expect(messageCall?.[1]).toEqual([CHAT, 5, 3, 32_000, 32_000]);
  });

  it.each([
    { source_ids: [] },
    { source_mode: "all", source_ids: [] },
    { source_mode: "selected" },
    { source_mode: "selected", source_ids: [], extra: true },
  ])("rejects malformed create scope before database access", async (payload) => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/chats", headers: auth, payload });
    expect(response.statusCode).toBe(400);
    expect(qMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("creates selected plus empty atomically without falling back to all", async () => {
    const client = clientWith([
      [],
      [{ id: CHAT, title: "New chat", model: "qwen-chat", source_mode: "selected", created_at: "now" }],
      [],
    ]);
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth,
      payload: { source_mode: "selected", source_ids: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().source_mode).toBe("selected");
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO chats"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns the same generic 400 for a foreign or missing source and rolls back", async () => {
    const app = await buildApp();
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = clientWith([[], [{ id: CHAT }], []]);
      // BEGIN, owned chat, unavailable-source lookup, ROLLBACK
      client.query
        .mockReset()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: CHAT }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      connectMock.mockResolvedValueOnce(client as any);
      const response = await app.inject({
        method: "PUT",
        url: `/api/chats/${CHAT}/sources`,
        headers: auth,
        payload: {
          source_mode: "selected",
          source_ids: [attempt === 0 ? SOURCE : "44444444-4444-4444-8444-444444444444"],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "one or more sources are unavailable" });
      expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
      expect(client.release).toHaveBeenCalledOnce();
    }
  });

  it("returns the same 404 for a missing or foreign chat", async () => {
    const client = clientWith([[], [], []]);
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();
    const response = await app.inject({
      method: "PUT",
      url: `/api/chats/${CHAT}/sources`,
      headers: auth,
      payload: { source_mode: "all" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "chat not found" });
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rejects deleting a chat while its durable run is active", async () => {
    const client = clientWith([[], [{ id: CHAT }], [{ id: "active-run" }], []]);
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/chats/${CHAT}`, headers: auth });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "chat has an active run" });
    expect(client.query.mock.calls[2][0]).toContain("status IN ('running','cancelling')");
    expect(client.query.mock.calls[2][1]).toEqual([CHAT, ACCOUNT]);
  });
});
