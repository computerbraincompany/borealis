import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";
import { installHttpBoundary } from "../httpErrors.js";
import { agentRoutes } from "../routes/agents.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ownerAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`,
};
const foreignAuth = {
  authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}`,
};

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-agents-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
    lanceDirectory: path.join(runtimeDirectory, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [FOREIGN, "foreign@example.test"],
  ] as const) {
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(agentRoutes);
  await app.ready();
  return app;
}

describe("agent schema and routes", () => {
  it("ships schema v6 with agent tables and nullable chat binding", async () => {
    const version = await storageRuntime().ledger.get<{ user_version: unknown }>("PRAGMA user_version");
    expect(Number(version?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    const tables = await storageRuntime().ledger.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','agent_revisions')"
    );
    expect(tables.map((table) => table.name).sort()).toEqual(["agent_revisions", "agents"]);
    const columns = await storageRuntime().ledger.all<{ name: string }>("PRAGMA table_info(chats)");
    expect(columns.map((column) => column.name)).toContain("agent_id");
    const runColumns = await storageRuntime().ledger.all<{ name: string }>("PRAGMA table_info(chat_runs)");
    expect(runColumns.map((column) => column.name)).toContain("agent_instructions");
  });

  it("creates, revises immutably, renames, and deletes agents", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: ownerAuth,
      body: { name: "Finance analyst", instructions: "Always reconcile totals against the ledger before answering." },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent).toMatchObject({ name: "Finance analyst", current_version: 1, instructions_chars: 60 });

    const revised = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers: ownerAuth,
      body: { instructions: "Show a chart for every numeric answer." },
    });
    expect(revised.json()).toMatchObject({ current_version: 2 });

    const detail = await app.inject({ method: "GET", url: `/api/agents/${agent.id}`, headers: ownerAuth });
    expect(detail.json().revisions.map((revision: { version: number }) => revision.version)).toEqual([2, 1]);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      headers: ownerAuth,
      body: { name: "Diligence analyst" },
    });
    expect(renamed.json()).toMatchObject({ name: "Diligence analyst", current_version: 2 });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: ownerAuth,
      body: { name: "Diligence analyst", instructions: "Second" },
    });
    expect(duplicate.statusCode).toBe(409);

    const list = await app.inject({ method: "GET", url: "/api/agents", headers: ownerAuth });
    expect(list.json()).toHaveLength(1);

    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers: ownerAuth });
    expect(deleted.statusCode).toBe(200);
    const empty = await app.inject({ method: "GET", url: "/api/agents", headers: ownerAuth });
    expect(empty.json()).toEqual([]);
  });

  it("keeps agents tenant-scoped and validates bodies", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: ownerAuth,
      body: { name: "Owned", instructions: "Owned instructions." },
    });
    const agentId = created.json().id as string;

    const foreignGet = await app.inject({ method: "GET", url: `/api/agents/${agentId}`, headers: foreignAuth });
    expect(foreignGet.statusCode).toBe(404);
    const foreignDelete = await app.inject({ method: "DELETE", url: `/api/agents/${agentId}`, headers: foreignAuth });
    expect(foreignDelete.statusCode).toBe(404);
    const foreignRevise = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: foreignAuth,
      body: { instructions: "Hijack" },
    });
    expect(foreignRevise.statusCode).toBe(404);

    const unauthenticated = await app.inject({ method: "GET", url: "/api/agents" });
    expect(unauthenticated.statusCode).toBe(401);

    const blank = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: ownerAuth,
      body: { name: "  ", instructions: "x" },
    });
    expect(blank.statusCode).toBe(400);

    const oversize = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: ownerAuth,
      body: { name: "Valid", instructions: "x".repeat(8_001) },
    });
    expect(oversize.statusCode).toBe(400);

    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: ownerAuth,
      body: {},
    });
    expect(emptyPatch.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH",
      url: `/api/agents/${randomUUID()}`,
      headers: ownerAuth,
      body: { instructions: "No such agent" },
    });
    expect(missing.statusCode).toBe(404);
  });
});
