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
import { routes } from "../routes.js";
import { closeRuntimeSettings, initializeRuntimeSettings } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const authHeader = {
  authorization: `Bearer ${signToken({ userId: accountId, email: "owner@example.test" })}`,
};
const otherAuthHeader = {
  authorization: `Bearer ${signToken({ userId: otherAccountId, email: "other@example.test" })}`,
};
const apps: FastifyInstance[] = [];
const tempDirectories: string[] = [];

async function buildApp(): Promise<FastifyInstance> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "borealis-preferences-"));
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
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  closeRuntimeSettings();
  await closeStorageRuntime();
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("preferences routes", () => {
  it("requires authentication for reads and writes", async () => {
    const app = await buildApp();

    const read = await app.inject({ method: "GET", url: "/api/preferences" });
    const write = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      payload: { default_chat_model: "personal-model" },
    });

    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
    await expect(storageRuntime().chats.getDefaultChatModel(accountId)).resolves.toBeNull();
  });

  it("returns a null default before anything is saved", async () => {
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/preferences", headers: authHeader });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ default_chat_model: null });
  });

  it("trims and persists a personal default, then clears it with null", async () => {
    const app = await buildApp();

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: authHeader,
      payload: { default_chat_model: "  personal-model  " },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ default_chat_model: "personal-model" });
    await expect(storageRuntime().chats.getDefaultChatModel(accountId)).resolves.toBe("personal-model");

    const reread = await app.inject({ method: "GET", url: "/api/preferences", headers: authHeader });
    expect(reread.statusCode).toBe(200);
    expect(reread.json()).toEqual({ default_chat_model: "personal-model" });

    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: authHeader,
      payload: { default_chat_model: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ default_chat_model: null });
    await expect(storageRuntime().chats.getDefaultChatModel(accountId)).resolves.toBeNull();
  });

  it.each([
    {},
    { default_chat_model: "" },
    { default_chat_model: "   " },
    { default_chat_model: "x".repeat(201) },
    { default_chat_model: { nested: true } },
    { default_chat_model: ["personal-model"] },
  ])("rejects invalid preference bodies without storing a default", async (payload) => {
    const app = await buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: authHeader,
      payload,
    });

    expect(response.statusCode).toBe(400);
    await expect(storageRuntime().chats.getDefaultChatModel(accountId)).resolves.toBeNull();
  });

  it("rejects an over-schema preference without misclassifying it as a parser overflow", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: authHeader,
      payload: { default_chat_model: "x".repeat(1024) },
    });

    expect(response.statusCode).toBe(400);
    await expect(storageRuntime().chats.getDefaultChatModel(accountId)).resolves.toBeNull();
  });

  it("keeps personal defaults account-scoped", async () => {
    const app = await buildApp();

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: authHeader,
      payload: { default_chat_model: "owner-model" },
    });
    expect(saved.statusCode).toBe(200);

    const otherRead = await app.inject({ method: "GET", url: "/api/preferences", headers: otherAuthHeader });
    expect(otherRead.statusCode).toBe(200);
    expect(otherRead.json()).toEqual({ default_chat_model: null });

    const otherSaved = await app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: otherAuthHeader,
      payload: { default_chat_model: "other-model" },
    });
    expect(otherSaved.statusCode).toBe(200);

    const ownerRead = await app.inject({ method: "GET", url: "/api/preferences", headers: authHeader });
    expect(ownerRead.json()).toEqual({ default_chat_model: "owner-model" });
    const otherReread = await app.inject({ method: "GET", url: "/api/preferences", headers: otherAuthHeader });
    expect(otherReread.json()).toEqual({ default_chat_model: "other-model" });
  });
});

it("rejects sessions for removed accounts before catalog work or body parsing", async () => {
  const app = await buildApp();
  await storageRuntime().ledger.run("DELETE FROM users WHERE id=?", [accountId]);
  for (const url of ["/api/models", "/api/preferences", "/api/me"]) {
    const response = await app.inject({ method: "GET", url, headers: authHeader });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("SESSION_ACCOUNT_UNAVAILABLE");
  }
  const malformed = await app.inject({
    method: "PATCH",
    url: "/api/preferences",
    headers: { ...authHeader, "content-type": "application/json" },
    payload: "{",
  });
  expect(malformed.statusCode).toBe(401);
});
