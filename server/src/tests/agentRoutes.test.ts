import { agentSkillRoutes } from "../routes/agentSkills.js";
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
  await app.register(agentSkillRoutes);
  await app.ready();
  return app;
}

describe("agent schema and routes", () => {
  it("saves identity and capabilities atomically and preserves explicit empty tools", async () => {
    const store = storageRuntime().agents;
    const first = await store.createAgent(OWNER, "First", "Original");
    await store.createAgent(OWNER, "Taken", "Other");
    expect(first.tools).toHaveLength(7);
    await expect(
      store.updateAgent(OWNER, first.id, { name: "Taken", instructions: "Should roll back", tools: [] })
    ).rejects.toThrow();
    expect(await store.getAgentDetail(OWNER, first.id)).toMatchObject({
      name: "First",
      instructions: "Original",
      current_version: 1,
    });
    const changed = await store.updateAgent(OWNER, first.id, {
      name: "Changed",
      icon: "chart",
      color: "teal",
      tools: [],
    });
    expect(changed).toMatchObject({ name: "Changed", icon: "chart", color: "teal", tools: [], current_version: 2 });
    const detail = await store.getAgentDetail(OWNER, first.id);
    expect(detail?.revisions[0].tools).toEqual([]);
    expect(detail?.revisions[1].tools).toHaveLength(7);
  });

  it("captures skills and tools for a running turn, then uses edits on the next turn", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-skills",
      headers: ownerAuth,
      body: { name: "Checklist", content: "Old checklist" },
    });
    const skill = response.json();
    const runtime = storageRuntime();
    const agent = await runtime.agents.createAgent(OWNER, "Snapshot", "Prompt", { tools: [], skill_ids: [skill.id] });
    const chat = await runtime.chats.createChat({
      accountId: OWNER,
      title: "Snapshot",
      titleIsManual: true,
      model: "test-model",
      agentId: agent.id,
      sourceScope: { source_mode: "selected", source_ids: [] },
    });
    const first = await runtime.chats.acceptChatTurn(OWNER, chat.id, "First");
    const editedSkill = await app.inject({
      method: "PUT",
      url: `/api/agent-skills/${skill.id}`,
      headers: ownerAuth,
      body: { name: "Checklist", content: "New checklist" },
    });
    expect(editedSkill.statusCode, editedSkill.body).toBe(200);
    await runtime.agents.updateAgent(OWNER, agent.id, { tools: ["retrieve"] });
    expect(first.agent?.instructions).toContain("Old checklist");
    expect(first.agent?.tools).toEqual([]);
    const stored = await runtime.ledger.get<{ agent_instructions: string; agent_tools: string }>(
      "SELECT agent_instructions,agent_tools FROM chat_runs WHERE id=?",
      [first.runId]
    );
    expect(stored?.agent_instructions).toContain("Old checklist");
    expect(JSON.parse(stored!.agent_tools)).toEqual([]);
    await runtime.ledger.run("UPDATE chat_runs SET status='completed',finished_at=? WHERE id=?", [
      new Date().toISOString(),
      first.runId,
    ]);
    const second = await runtime.chats.acceptChatTurn(OWNER, chat.id, "Second");
    expect(second.agent?.instructions).toContain("New checklist");
    expect(second.agent?.tools).toEqual(["retrieve"]);
  });

  it("enforces skill ownership and aggregate instruction limits", async () => {
    const app = await buildApp();
    const saved = await app.inject({
      method: "POST",
      url: "/api/agent-skills",
      headers: ownerAuth,
      body: { name: "Research", content: "Verify your sources." },
    });
    expect(saved.statusCode).toBe(201);
    const id = saved.json().id;
    const foreignList = await app.inject({ method: "GET", url: "/api/agent-skills", headers: foreignAuth });
    expect(foreignList.json().items).toEqual([]);
    await expect(
      storageRuntime().agents.createAgent(FOREIGN, "Foreign", "Prompt", { skill_ids: [id] })
    ).rejects.toThrow("unavailable");
    const owned = await storageRuntime().agents.createAgent(OWNER, "Owned skill", "Prompt", { skill_ids: [id] });
    expect(owned.skill_ids).toEqual([id]);
    const largeIds: string[] = [];
    for (let n = 0; n < 4; n++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-skills",
        headers: ownerAuth,
        body: { name: `Large ${n}`, content: "x".repeat(8000) },
      });
      largeIds.push(response.json().id);
    }
    await expect(storageRuntime().agents.updateAgent(OWNER, owned.id, { skill_ids: largeIds })).rejects.toThrow(
      "32,000"
    );
    const foreignDelete = await app.inject({ method: "DELETE", url: `/api/agent-skills/${id}`, headers: foreignAuth });
    expect(foreignDelete.statusCode).toBe(404);
  });

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
    expect(renamed.json()).toMatchObject({ name: "Diligence analyst", current_version: 3 });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: ownerAuth,
      body: { name: "Diligence analyst", instructions: "Second" },
    });
    expect(duplicate.statusCode).toBe(409);

    const list = await app.inject({ method: "GET", url: "/api/agents", headers: ownerAuth });
    expect(list.json()).toMatchObject({ items: [expect.objectContaining({ id: agent.id })], next_cursor: null });

    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers: ownerAuth });
    expect(deleted.statusCode).toBe(200);
    const empty = await app.inject({ method: "GET", url: "/api/agents", headers: ownerAuth });
    expect(empty.json()).toEqual({ items: [], next_cursor: null });
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

  it("continues the bounded list through opaque cursors", async () => {
    const app = await buildApp();
    const createdIds: string[] = [];
    for (const name of ["First", "Second", "Third"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: ownerAuth,
        body: { name, instructions: `${name} instructions` },
      });
      createdIds.push(created.json().id as string);
    }

    const traversed: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/agents?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        headers: ownerAuth,
      });
      expect(response.statusCode).toBe(200);
      const page = response.json() as { items: Array<{ id: string }>; next_cursor: string | null };
      expect(page.items).toHaveLength(1);
      traversed.push(page.items[0].id);
      cursor = page.next_cursor;
    }
    expect(cursor).toBeNull();
    expect(new Set(traversed)).toEqual(new Set(createdIds));

    const excessive = await app.inject({ method: "GET", url: "/api/agents?limit=101", headers: ownerAuth });
    expect(excessive.statusCode).toBe(400);
  });
});
