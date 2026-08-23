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
      client.query.mockReset()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: CHAT }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      connectMock.mockResolvedValueOnce(client as any);
      const response = await app.inject({
        method: "PUT",
        url: `/api/chats/${CHAT}/sources`,
        headers: auth,
        payload: { source_mode: "selected", source_ids: [attempt === 0 ? SOURCE : "44444444-4444-4444-8444-444444444444"] },
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
});
