import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));

import { runAgent, type AgentCompletion } from "../agent.js";
import { signToken } from "../auth.js";
import { createAutomationRunner } from "../automationRunner.js";
import { installHttpBoundary } from "../httpErrors.js";
import { automationRoutes } from "../routes/automations.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";
import { SourceScopeError } from "../sourceScope.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`,
};
const runAgentMock = vi.mocked(runAgent);

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runAgentMock.mockReset();
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

function agentCompletion(): AgentCompletion {
  return {
    content: "Durable scheduled answer",
    meta: {
      charts: [],
      report: null,
      model: "chat-model",
      source_mode: "selected",
      source_ids: [],
      citations: [],
      evidence: [],
      query_results: [],
    },
  };
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

  it("allows only one connector_sync automation per connector", async () => {
    const app = await buildApp();
    const connectorId = await insertConnector(OWNER);
    const first = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "First sync", kind: "connector_sync", target_id: connectorId, schedule_minutes: 60 },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Second sync", kind: "connector_sync", target_id: connectorId, schedule_minutes: 30 },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual({ error: "this connector already has a connector_sync automation" });
  });

  it("removes only the bound connector's connector_sync automations", async () => {
    const app = await buildApp();
    const connectorId = await insertConnector(OWNER);
    const otherConnectorId = await insertConnector(OWNER);
    const chatId = await insertChat(OWNER);
    async function createAutomation(body: Record<string, unknown>): Promise<string> {
      const response = await app.inject({ method: "POST", url: "/api/automations", headers: ownerAuth, body });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    }
    const boundSync = await createAutomation({
      name: "Bound sync",
      kind: "connector_sync",
      target_id: connectorId,
      schedule_minutes: 60,
    });
    const otherSync = await createAutomation({
      name: "Other sync",
      kind: "connector_sync",
      target_id: otherConnectorId,
      schedule_minutes: 60,
    });
    const digest = await createAutomation({
      name: "Digest",
      kind: "agent_turn",
      target_id: chatId,
      prompt: "Summarize the attached sources for the team.",
      schedule_minutes: 60,
    });

    await expect(storageRuntime().automations.deleteConnectorAutomations(OWNER, connectorId)).resolves.toBe(1);
    await expect(storageRuntime().automations.get(OWNER, boundSync)).resolves.toBeUndefined();
    await expect(storageRuntime().automations.get(OWNER, otherSync)).resolves.toBeDefined();
    await expect(storageRuntime().automations.get(OWNER, digest)).resolves.toBeDefined();
    await expect(storageRuntime().automations.deleteConnectorAutomations(OWNER, connectorId)).resolves.toBe(0);
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
    expect(listed.json().items[0]).toMatchObject({ state: "paused", consecutive_failures: 5 });

    // A paused automation is not claimed again.
    await runner.tick();
    expect(calls).toBe(5);
    void randomUUID;
  });

  it("records scheduled connector sync history for succeeded, failed, and skipped runs", async () => {
    const app = await buildApp();
    const connectorId = await insertConnector(OWNER);
    const created = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Scheduled sync", kind: "connector_sync", target_id: connectorId, schedule_minutes: 15 },
    });
    expect(created.statusCode).toBe(201);
    const automationId = created.json().id as string;

    const syncConnector = vi.fn<(accountId: string, connectorId: string) => Promise<unknown>>();
    const runner = createAutomationRunner({
      store: storageRuntime().automations,
      syncConnector,
      tickIntervalMs: 10_000,
      // Each tick's clock advances past the previous reschedule.
      now: (() => {
        let tick = Date.now() + 60 * 60 * 1000;
        return () => new Date((tick += 16 * 60_000));
      })(),
    });

    syncConnector.mockResolvedValueOnce({});
    await runner.tick();
    syncConnector.mockRejectedValueOnce(new SourceScopeError(409, "the connector could not be refreshed"));
    await runner.tick();
    await storageRuntime().ledger.run("UPDATE connectors SET sync_status='syncing' WHERE id=?", [connectorId]);
    await runner.tick();

    const history = await storageRuntime().ledger.all<{
      trigger: string;
      outcome: string;
      detail: string | null;
      finished_at: string | null;
    }>("SELECT trigger,outcome,detail,finished_at FROM connector_syncs ORDER BY id");
    expect(history).toEqual([
      { trigger: "scheduled", outcome: "succeeded", detail: null, finished_at: expect.any(String) },
      {
        trigger: "scheduled",
        outcome: "failed",
        detail: "the connector could not be refreshed",
        finished_at: expect.any(String),
      },
      {
        trigger: "scheduled",
        outcome: "skipped",
        detail: "a sync was already active",
        finished_at: expect.any(String),
      },
    ]);

    const runs = await app.inject({ method: "GET", url: `/api/automations/${automationId}/runs`, headers: ownerAuth });
    expect((runs.json() as Array<{ outcome: string }>).map((run) => run.outcome)).toEqual([
      "skipped",
      "failed",
      "succeeded",
    ]);
  });

  it("keeps scheduled history best effort when the bound connector is gone", async () => {
    const app = await buildApp();
    const connectorId = await insertConnector(OWNER);
    const created = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: { name: "Dangling sync", kind: "connector_sync", target_id: connectorId, schedule_minutes: 15 },
    });
    const automationId = created.json().id as string;
    await storageRuntime().ledger.run("DELETE FROM connectors WHERE id=?", [connectorId]);

    const runner = createAutomationRunner({
      store: storageRuntime().automations,
      syncConnector: vi.fn(),
      tickIntervalMs: 10_000,
      now: () => new Date(Date.now() + 60 * 60 * 1000),
    });
    await expect(runner.tick()).resolves.toBeUndefined();

    const runs = await app.inject({ method: "GET", url: `/api/automations/${automationId}/runs`, headers: ownerAuth });
    expect(runs.json()[0]).toMatchObject({ outcome: "failed", detail: "the bound connector no longer exists" });
    // The history foreign key rejects rows for a deleted connector; the write
    // is swallowed and records nothing.
    await expect(storageRuntime().ledger.all("SELECT 1 FROM connector_syncs")).resolves.toEqual([]);
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
    expect(listed.json().items[0]).toMatchObject({ state: "active", consecutive_failures: 0 });
  });

  it("records skipped when cancellation wins immediately before assistant persistence", async () => {
    const app = await buildApp();
    const chatId = await insertChat(OWNER);
    const created = await app.inject({
      method: "POST",
      url: "/api/automations",
      headers: ownerAuth,
      body: {
        name: "Cancellable digest",
        kind: "agent_turn",
        target_id: chatId,
        prompt: "Summarize the attached sources for the team.",
        schedule_minutes: 15,
      },
    });
    expect(created.statusCode).toBe(201);
    const automationId = created.json().id as string;
    await storageRuntime().ledger.run("UPDATE automations SET consecutive_failures=3 WHERE id=?", [automationId]);

    runAgentMock.mockImplementationOnce(async () => {
      const run = await storageRuntime().ledger.get<{ id: string }>(
        "SELECT id FROM chat_runs WHERE account_id=? AND chat_id=? AND status='running'",
        [OWNER, chatId]
      );
      expect(run).toBeDefined();
      await expect(storageRuntime().runs.requestCancel(OWNER, chatId, run!.id)).resolves.toBe("cancelling");
      return agentCompletion();
    });
    const runner = createAutomationRunner({
      store: storageRuntime().automations,
      syncConnector: vi.fn(),
      tickIntervalMs: 10_000,
      now: () => new Date(Date.now() + 60 * 60 * 1000),
    });

    await runner.tick();

    await expect(
      storageRuntime().ledger.get("SELECT status,cancel_requested,error_code FROM chat_runs WHERE chat_id=?", [chatId])
    ).resolves.toEqual({ status: "cancelled", cancel_requested: 1n, error_code: "CANCELLED" });
    await expect(
      storageRuntime().ledger.all("SELECT 1 FROM messages WHERE chat_id=? AND role='assistant'", [chatId])
    ).resolves.toEqual([]);
    const runs = await app.inject({ method: "GET", url: `/api/automations/${automationId}/runs`, headers: ownerAuth });
    expect(runs.json()).toHaveLength(1);
    expect(runs.json()[0]).toMatchObject({ outcome: "skipped", detail: "the run was cancelled" });
    const automation = await storageRuntime().automations.get(OWNER, automationId);
    expect(automation).toMatchObject({ state: "active", consecutive_failures: 3 });
    expect(runAgentMock).toHaveBeenCalledOnce();
  });

  it("records one skipped outcome when durable cancellation wins over a generic agent error", async () => {
    const chatId = await insertChat(OWNER);
    const automation = await storageRuntime().automations.create({
      accountId: OWNER,
      name: "Cancelled failing digest",
      kind: "agent_turn",
      targetId: chatId,
      prompt: "Summarize the attached sources for the team.",
      scheduleMinutes: 15,
    });
    await storageRuntime().ledger.run("UPDATE automations SET consecutive_failures=3 WHERE id=?", [automation.id]);

    runAgentMock.mockImplementationOnce(async () => {
      const run = await storageRuntime().ledger.get<{ id: string }>(
        "SELECT id FROM chat_runs WHERE account_id=? AND chat_id=? AND status='running'",
        [OWNER, chatId]
      );
      expect(run).toBeDefined();
      await expect(storageRuntime().runs.requestCancel(OWNER, chatId, run!.id)).resolves.toBe("cancelling");
      throw new Error("the provider failed after cancellation was requested");
    });
    const runner = createAutomationRunner({
      store: storageRuntime().automations,
      syncConnector: vi.fn(),
      tickIntervalMs: 10_000,
      now: () => new Date(Date.now() + 60 * 60 * 1000),
    });

    await runner.tick();

    await expect(
      storageRuntime().ledger.get("SELECT status,cancel_requested,error_code FROM chat_runs WHERE chat_id=?", [chatId])
    ).resolves.toEqual({ status: "cancelled", cancel_requested: 1n, error_code: "CANCELLED" });
    await expect(
      storageRuntime().ledger.all(
        "SELECT outcome,detail FROM automation_runs WHERE automation_id=? AND account_id=? ORDER BY id",
        [automation.id, OWNER]
      )
    ).resolves.toEqual([{ outcome: "skipped", detail: "the run was cancelled" }]);
    await expect(storageRuntime().automations.get(OWNER, automation.id)).resolves.toMatchObject({
      state: "active",
      consecutive_failures: 3,
    });
    expect(runAgentMock).toHaveBeenCalledOnce();
  });
});
