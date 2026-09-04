import bcrypt from "bcryptjs";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ storageRuntime: vi.fn() }));
vi.mock("../storageRuntime.js", () => ({ storageRuntime: mocks.storageRuntime }));
vi.mock("../config.js", () => ({
  config: { jwtSecret: "vitest-secret-that-is-longer-than-32-chars-123456" },
}));

import { authRoutes } from "../auth.js";
import { ChatStore } from "../db/stores/chatStore.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

// 30 code points pass the route schema's 72-character maximum while the UTF-8
// encoding reaches 120 bytes, exercising the handler's byte-length boundary.
const OVER_LENGTH_PASSWORD = "🔐".repeat(30);

let temporary: TempSqliteLedger;
let apps: FastifyInstance[] = [];

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await authRoutes(app);
  await app.ready();
  return app;
}

beforeEach(async () => {
  temporary = await createTempSqliteLedger();
  const chats = new ChatStore(temporary.ledger);
  mocks.storageRuntime.mockReset();
  mocks.storageRuntime.mockReturnValue({ chats });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  apps = [];
  await temporary.cleanup();
});

describe("auth password messaging", () => {
  it("registers an account and returns a usable session", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: { email: "owner@example.test", password: "secret-password" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { token: string; user: { email: string } };
    expect(body.user).toMatchObject({ email: "owner@example.test" });
    expect(body.token).toEqual(expect.any(String));
    expect(body.token.split(".")).toHaveLength(3);
  });

  it("rejects over-length registration passwords by characters, not bytes", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: { email: "owner@example.test", password: OVER_LENGTH_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "password must contain between 6 and 72 characters" });
    await expect(temporary.ledger.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM users")).resolves.toEqual({
      count: 0n,
    });
  });

  it("returns 400 for an over-length login password without probing the account", async () => {
    const app = await buildApp();
    const user = await (mocks.storageRuntime().chats as ChatStore).createUser({
      email: "owner@example.test",
      passwordHash: await bcrypt.hash("secret-password", 4),
    });
    expect(user).toBeDefined();

    for (const email of ["owner@example.test", "unknown@example.test"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { email, password: OVER_LENGTH_PASSWORD },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "password must contain at most 72 characters" });
    }
  });

  it("keeps a wrong short password an opaque 401 invalid-credentials response", async () => {
    const app = await buildApp();
    await (mocks.storageRuntime().chats as ChatStore).createUser({
      email: "owner@example.test",
      passwordHash: await bcrypt.hash("secret-password", 4),
    });

    for (const email of ["owner@example.test", "unknown@example.test"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/login",
        payload: { email, password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid credentials" });
    }

    const accepted = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: "owner@example.test", password: "secret-password" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ user: { email: "owner@example.test" } });
  });
});
