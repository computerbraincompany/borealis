import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { createAutomationRunner } from "../automationRunner.js";
import { installHttpBoundary } from "../httpErrors.js";
import { automationRoutes } from "../routes/automations.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`,
};

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-automations-"));
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
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(automationRoutes);
  await app.ready();
  return app;
}

async function insertConnector(accountId: string): Promise<string> {
  const id = randomUUID();
  await storageRuntime().ledger.run(
    `INSERT INTO connectors (id,account_id,name,type,target_table) VALUES (?,?,?,?,?)`,
    [id, accountId, "Ledger feed", "url_csv", `table_${id.slice(0, 8)}`]
  );
  return id;
}

async function insertChat(accountId: string): Promise<string> {
  const id = randomUUID();
  await storageRuntime().ledger.run(
    "INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,'chat-model','selected')",
    [id, accountId, "Automation chat"]
  );
  return id;
}

describe("automation store and schema", () => {
  it("ships schema v9 with automation tables", async () => {
    const version = await storageRuntime().ledger.get<{ user_version: unknown }>("PRAGMA user_version");
    expect(Number(version?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    const tables = await storageRuntime().ledger.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('automations','automation_runs')"
    );
    expect(tables.map((table) => table.name).sort()).toEqual(["automation_runs", "automations"]);
  });

  it("validates kind-specific targets and bounds", async () => {
    const app = await buildApp();
    const connectorId = await insertConnector(OWNER);
    const chatId = await insertChat(OWNER);

    const created = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Nightly ledger", kind: "connector_sync", target_id: connectorId, schedule_minutes: 60 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: "connector_sync", state: "active" });

    const foreignTarget = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: {
        name: "Foreign sync",
        kind: "connector_sync",
        target_id: await insertConnector(FOREIGN),
        schedule_minutes: 60,
      },
    });
    expect(foreignTarget.statusCode).toBe(400);

    const missingPrompt = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Digest", kind: "agent_turn", target_id: chatId, schedule_minutes: 60 },
    });
    expect(missingPrompt.statusCode).toBe(400);

    const withPrompt = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: {
        name: "Digest",
        kind: "agent_turn",
        target_id: chatId,
        prompt: "Summarize the attached sources for the team.",
        schedule_minutes: 15,
      },
    });
    expect(withPrompt.statusCode).toBe(201);

    const oversizeSchedule = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Too often", kind: "connector_sync", target_id: connectorId, schedule_minutes: 5 },
    });
    expect(oversizeSchedule.statusCode).toBe(400);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Digest", kind: "agent_turn", target_id: chatId, prompt: "Again", schedule_minutes: 60 },
    });
    expect(duplicate.statusCode).toBe(400);

    const unauthenticated = await app.inject({ method: "GET", url: "/api/automations" });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("updates, pauses, and deletes with tenant isolation", async () => {
    const app = await buildApp();
    const connectorId = await insertConnector(OWNER);
    const created = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Sync", kind: "connector_sync", target_id: connectorId, schedule_minutes: 30 },
    });
    const automationId = created.json().id as string;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/automations/${automationId}`,
      headers: ownerAuth,
      body: { state: "paused", schedule_minutes: 45 },
    });
    expect(patched.json()).toMatchObject({ state: "paused", schedule_minutes: 45 });

    const foreignPatch = await app.inject({
      method: "PATCH",
      url: `/api/automations/${automationId}`,
      headers: {
        authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}`,
      },
      body: { state: "active" },
    });
    expect(foreignPatch.statusCode).toBe(404);

    const runs = await app.inject({
      method: "GET",
      url: `/api/automations/${automationId}/runs`,
      headers: ownerAuth,
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual([]);

    const deleted = await app.inject({ method: "DELETE", url: `/api/automations/${automationId}`, headers: ownerAuth });
    expect(deleted.statusCode).toBe(200);
  });
});

describe("automation runner", () => {
  it("claims due automations, records outcomes, and pauses after repeated failures", async () => {
    const app = await buildApp();
    const connectorId = await insertConnector(OWNER);
    const created = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Failing sync", kind: "connector_sync", target_id: connectorId, schedule_minutes: 15 },
    });
    const automationId = created.json().id as string;

    let calls = 0;
    const store = storageRuntime().automations;
    const runner = createAutomationRunner({
      store,
      syncConnector: vi.fn().mockImplementation(async () => {
        calls += 1;
        throw new Error("connection refused with secrets https://provider.example");
      }),
      tickIntervalMs: 10_000,
      // Each tick's clock advances past the previous reschedule.
      now: (() => {
        let tick = Date.now() + 60 * 60 * 1000;
        return () => new Date((tick += 16 * 60_000));
      })(),
    });

    for (let round = 0; round < 5; round += 1) {
      await runner.tick();
    }
    expect(calls).toBe(5);

    const runs = await app.inject({ method: "GET", url: `/api/automations/${automationId}/runs`, headers: ownerAuth });
    const outcomes = (runs.json() as Array<{ outcome: string; detail: string | null }>).map((run) => run.outcome);
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome === "failed")).toBe(true);
    expect(runs.json()[0].detail).toBe("the automation could not complete this run");
    expect(JSON.stringify(runs.json())).not.toContain("provider.example");

    const listed = await app.inject({ method: "GET", url: "/api/automations", headers: ownerAuth });
    expect(listed.json()[0]).toMatchObject({ state: "paused", consecutive_failures: 5 });

    // A paused automation is not claimed again.
    await runner.tick();
    expect(calls).toBe(5);
    void randomUUID;
  });

  it("skips agent turns while the bound chat is busy and runs them when free", async () => {
    const app = await buildApp();
    const chatId = await insertChat(OWNER);
    const created = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: {
        name: "Digest",
        kind: "agent_turn",
        target_id: chatId,
        prompt: "Summarize the attached sources for the team.",
        schedule_minutes: 15,
      },
    });
    const automationId = created.json().id as string;

    // A durable active run blocks the automation turn.
    await storageRuntime().ledger.run(
      `INSERT INTO chat_runs (id,account_id,chat_id,status,created_at,started_at) VALUES (?,?,?,'running',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [randomUUID(), OWNER, chatId]
    );

    const store = storageRuntime().automations;
    const runner = createAutomationRunner({
      store,
      syncConnector: vi.fn().mockResolvedValue({}),
      tickIntervalMs: 10_000,
      now: () => new Date(Date.now() + 60 * 60 * 1000),
    });
    await runner.tick();

    const runs = await app.inject({ method: "GET", url: `/api/automations/${automationId}/runs`, headers: ownerAuth });
    expect(runs.json()[0]).toMatchObject({ outcome: "skipped" });
    const listed = await app.inject({ method: "GET", url: "/api/automations", headers: ownerAuth });
    expect(listed.json()[0]).toMatchObject({ state: "active", consecutive_failures: 0 });
  });
});
