import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../ingest.js", () => ({
  wakeConnectorPrepareWorkers: vi.fn(),
  wakeIngestionWorkers: vi.fn(),
  isTabularSource: vi.fn(() => true),
  sanitizeDatasetName: vi.fn((name: string) => name),
}));
vi.mock("../dataService.js", () => ({
  DataServiceError: class DataServiceError extends Error {
    constructor(readonly status: number) {
      super("data service error");
    }
  },
  dataService: {
    prepareDatasetRefresh: vi.fn(),
    abortDatasetRefresh: vi.fn(),
    deactivateDatasetLocation: vi.fn(),
    cleanupDatasetCache: vi.fn(),
    listDatasetSummaries: vi.fn(async () => []),
  },
}));

import { signToken } from "../auth.js";
import { recordConnectorSync } from "../connectorSyncHistory.js";
import { encodeJson } from "../db/codecs.js";
import type { CreateConnectorInput } from "../db/stores/sourceStore.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";
import { DataServiceError, dataService } from "../dataService.js";
import { wakeConnectorPrepareWorkers, wakeIngestionWorkers } from "../ingest.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { routes } from "../routes.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTOR = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const auth = { authorization: `Bearer ${signToken({ userId: ACCOUNT, email: "owner@example.test" })}` };
const prepareMock = vi.mocked(dataService.prepareDatasetRefresh);
const abortMock = vi.mocked(dataService.abortDatasetRefresh);
const deactivateMock = vi.mocked(dataService.deactivateDatasetLocation);
const cacheCleanupMock = vi.mocked(dataService.cleanupDatasetCache);
const wakeMock = vi.mocked(wakeIngestionWorkers);
const wakePrepareMock = vi.mocked(wakeConnectorPrepareWorkers);
const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await routes(app);
  await app.ready();
  return app;
}

beforeEach(async () => {
  prepareMock.mockReset();
  prepareMock.mockImplementation(async (_account, _name, version, _url, _original, expectedFormat) => ({
    version,
    location: `/safe/cache/${version.replaceAll("-", "")}.${expectedFormat}`,
    previous_location: "/safe/cache/previous.csv",
    rows: 1,
    size_bytes: 10,
  }));
  abortMock.mockReset();
  abortMock.mockResolvedValue({ status: "deleted" });
  deactivateMock.mockReset();
  deactivateMock.mockResolvedValue({ status: "unchanged" });
  cacheCleanupMock.mockReset();
  cacheCleanupMock.mockResolvedValue({ status: "missing" });
  wakeMock.mockReset();
  wakePrepareMock.mockReset();
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-connector-routes-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
    lanceDirectory: path.join(runtimeDirectory, "lancedb"),
    embeddingDimension: 3,
  });
  await runtime.ledger.run(`INSERT INTO users (id,email,password_hash) VALUES (?,?,?)`, [
    ACCOUNT,
    "owner@example.test",
    "hash",
  ]);
  await runtime.ledger.run(`INSERT INTO users (id,email,password_hash) VALUES (?,?,?)`, [
    FOREIGN,
    "foreign@example.test",
    "hash",
  ]);
  await initializeRuntimeSettings({ settingsFile: path.join(runtimeDirectory, "settings.json"), env: {} });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  closeRuntimeSettings();
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

describe("connector synchronization", () => {
  it.each(["", "2026_ledger", "bad-name", "x".repeat(64)])(
    "rejects invalid explicit target table %j before reserving identity",
    async (targetTable) => {
      const app = await buildApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        headers: auth,
        payload: connectorPayload(targetTable),
      });
      expect(response.statusCode).toBe(400);
      expect(prepareMock).not.toHaveBeenCalled();
      await expect(storageRuntime().sources.listConnectors(ACCOUNT)).resolves.toEqual([]);
    }
  );

  it("returns a conflict before dataset mutation when the table identity exists", async () => {
    await storageRuntime().sources.createSource(ACCOUNT, {
      id: SOURCE,
      name: "ledger",
      kind: "tabular",
      displayName: "Ledger.csv",
    });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: connectorPayload("ledger"),
    });

    expect(response.statusCode).toBe(409);
    expect(prepareMock).not.toHaveBeenCalled();
    await expect(storageRuntime().sources.listConnectors(ACCOUNT)).resolves.toEqual([]);
  });

  it.each([
    ["url_json", "events", "https://example.invalid/events.json?signature=secret", "json"],
    ["url_csv", "ledger", "https://example.invalid/ledger.csv", "csv"],
  ] as const)("stages an immutable %s refresh before durable indexing", async (type, table, url, format) => {
    await storageRuntime().sources.createConnector(ACCOUNT, {
      ...connectorStoreInput(table, "idle"),
      type,
      config: { url },
      source: { ...connectorStoreInput(table, "idle").source, url },
    });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(prepareMock).toHaveBeenCalledWith(
      ACCOUNT,
      table,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      url,
      "Feed",
      format
    );
    await expect(storageRuntime().sources.getConnector(ACCOUNT, CONNECTOR)).resolves.toMatchObject({
      syncStatus: "indexing",
    });
    const source = await storageRuntime().sources.getSource(ACCOUNT, SOURCE);
    expect(source).toMatchObject({
      status: "index",
      meta: expect.objectContaining({
        connector_candidate_location: expect.stringContaining(`/safe/cache/`),
        connector_activation_previous_location: "/safe/cache/previous.csv",
      }),
    });
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, SOURCE)).resolves.toMatchObject({
      generation: 1,
      status: "pending",
      leaseToken: null,
    });
    expect(wakeMock).toHaveBeenCalledOnce();
  });

  it("terminalizes a sync without name-only mutation when the owned source is missing", async () => {
    await storageRuntime().ledger.run(
      `INSERT INTO connectors (id,account_id,name,type,config,target_table,sync_status)
       VALUES (?,?,?,?,?,?,'idle')`,
      [CONNECTOR, ACCOUNT, "Ledger", "url_csv", encodeJson({ url: "https://example.invalid/ledger.csv" }), "ledger"]
    );
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });

    expect(response.statusCode).toBe(422);
    expect(prepareMock).not.toHaveBeenCalled();
    await expect(storageRuntime().sources.getConnector(ACCOUNT, CONNECTOR)).resolves.toMatchObject({
      syncStatus: "error",
      syncError: "Connector sync failed.",
    });
  });

  it("keeps a new connector source non-ready until ingestion commits", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: {
        display_name: "Events feed",
        target_table: "events_feed",
        type: "url_json",
        config: { url: "https://example.invalid/events.json" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ target_table: "events_feed", sync_status: "indexing" });
    const connectors = await storageRuntime().sources.listConnectors(ACCOUNT);
    const source = (await storageRuntime().sources.listSources(ACCOUNT))[0];
    expect(connectors).toHaveLength(1);
    expect(source).toMatchObject({ name: "events_feed", status: "index", connectorId: connectors[0].id });
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, source.id)).resolves.toMatchObject({
      generation: 1,
      status: "pending",
    });
    expect(prepareMock).toHaveBeenCalledWith(
      ACCOUNT,
      "events_feed",
      expect.any(String),
      "https://example.invalid/events.json",
      "Events feed",
      "json"
    );
    expect(wakeMock).toHaveBeenCalledOnce();
  });

  it("defers an exactly-owned preparing generation after transient service failure", async () => {
    await storageRuntime().sources.createConnector(ACCOUNT, connectorStoreInput("transient", "idle"));
    prepareMock.mockRejectedValueOnce(new DataServiceError(503, "/datasets/refresh/prepare"));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });

    expect(response.statusCode).toBe(422);
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, SOURCE)).resolves.toMatchObject({
      generation: 1,
      status: "preparing",
      leaseToken: null,
      lastError: "PREPARE_TRANSIENT",
    });
    await expect(storageRuntime().sources.getConnector(ACCOUNT, CONNECTOR)).resolves.toMatchObject({
      syncStatus: "syncing",
    });
    expect(wakePrepareMock).toHaveBeenCalledOnce();
  });

  it("reserves cleanup, removes all connector vectors, and clears markers after exact cache cleanup", async () => {
    const input = connectorStoreInput("ledger", "idle", {
      filePath: "/safe/cache/current.csv",
      meta: {
        connector_previous_location: "/safe/cache/previous.csv",
        connector_candidate_location: "/safe/cache/candidate.csv",
        connector_activation_previous_location: "/safe/cache/activation-previous.csv",
      },
    });
    await storageRuntime().sources.createConnector(ACCOUNT, input);
    await storageRuntime().vectors.upsert([
      { chunkId: randomUUIDLike(), accountId: ACCOUNT, sourceId: SOURCE, generation: 1, vector: [1, 0, 0] },
    ]);
    const vectorDelete = vi.spyOn(storageRuntime().vectors, "deleteSource");
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/connectors/${CONNECTOR}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(vectorDelete).toHaveBeenCalledWith(SOURCE);
    expect(deactivateMock.mock.calls.map((call) => call[2])).toEqual([
      "/safe/cache/current.csv",
      "/safe/cache/previous.csv",
      "/safe/cache/candidate.csv",
      "/safe/cache/activation-previous.csv",
    ]);
    expect(cacheCleanupMock.mock.calls.map((call) => call[2])).toEqual(
      deactivateMock.mock.calls.map((call) => call[2])
    );
    expect(vectorDelete.mock.invocationCallOrder[0]).toBeLessThan(deactivateMock.mock.invocationCallOrder[0]);
    await expect(storageRuntime().sources.getConnector(ACCOUNT, CONNECTOR)).resolves.toBeUndefined();
    await expect(storageRuntime().sources.getSource(ACCOUNT, SOURCE)).resolves.toBeUndefined();
    await expect(storageRuntime().sources.listPendingSourceDeletes(ACCOUNT)).resolves.toEqual([]);
  });

  it("rejects connector deletion while its exact source snapshot is active", async () => {
    await storageRuntime().sources.createConnector(ACCOUNT, connectorStoreInput("active_delete", "idle"));
    const chatId = "44444444-4444-4444-8444-444444444444";
    const runId = "55555555-5555-4555-8555-555555555555";
    await storageRuntime().ledger.run(`INSERT INTO chats (id,account_id,title,model) VALUES (?,?,?,?)`, [
      chatId,
      ACCOUNT,
      "Active",
      "qwen-chat",
    ]);
    await storageRuntime().ledger.run(`INSERT INTO chat_runs (id,account_id,chat_id,status) VALUES (?,?,?,'running')`, [
      runId,
      ACCOUNT,
      chatId,
    ]);
    await storageRuntime().ledger.run(`INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)`, [
      runId,
      SOURCE,
      ACCOUNT,
    ]);
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/connectors/${CONNECTOR}`, headers: auth });

    expect(response.statusCode).toBe(409);
    await expect(storageRuntime().sources.getConnector(ACCOUNT, CONNECTOR)).resolves.toBeDefined();
    await expect(storageRuntime().sources.listPendingSourceDeletes(ACCOUNT)).resolves.toEqual([]);
  });
});

describe("connector schedule and sync history", () => {
  it("ships schema v10 with the connector sync history table and cascade", async () => {
    const version = await storageRuntime().ledger.get<{ user_version: unknown }>("PRAGMA user_version");
    expect(Number(version?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    const columns = await storageRuntime().ledger.all<{ name: string }>("PRAGMA table_info(connector_syncs)");
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "connector_id",
      "account_id",
      "trigger",
      "outcome",
      "detail",
      "started_at",
      "finished_at",
    ]);
    const indexes = await storageRuntime().ledger.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='connector_syncs_connector_idx'"
    );
    expect(indexes).toHaveLength(1);
    const connectorId = await insertConnectorRow(ACCOUNT);
    await recordHistory(ACCOUNT, connectorId, "manual", "succeeded");
    await storageRuntime().ledger.run("DELETE FROM connectors WHERE id=?", [connectorId]);
    await expect(historyRows()).resolves.toEqual([]);
  });

  it("records create history on the auto-sync success and failure paths", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: connectorPayload("ledger"),
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ target_table: "ledger", schedule: null });
    await expect(historyRows()).resolves.toEqual([
      { trigger: "create", outcome: "succeeded", detail: null, finished_at: expect.any(String) },
    ]);

    prepareMock.mockRejectedValueOnce(new DataServiceError(400, "/datasets/refresh/prepare"));
    const failed = await app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: connectorPayload("second"),
    });
    expect(failed.statusCode).toBe(422);
    await expect(historyRows()).resolves.toEqual([
      { trigger: "create", outcome: "failed", detail: null, finished_at: expect.any(String) },
      { trigger: "create", outcome: "succeeded", detail: null, finished_at: expect.any(String) },
    ]);
  });

  it("records manual history for succeeded, failed, and already-active syncs", async () => {
    await storageRuntime().sources.createConnector(ACCOUNT, connectorStoreInput("ledger", "idle"));
    const app = await buildApp();

    const succeeded = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });
    expect(succeeded.statusCode).toBe(200);
    const first = (await historyRows())[0];
    expect(first).toMatchObject({ trigger: "manual", outcome: "succeeded", detail: null });
    expect(String(first.finished_at)).toBeTruthy();

    // The succeeded sync leaves the connector indexing; reset it for a fresh run.
    await storageRuntime().ledger.run("UPDATE connectors SET sync_status='idle' WHERE id=?", [CONNECTOR]);
    prepareMock.mockRejectedValueOnce(new DataServiceError(400, "/datasets/refresh/prepare"));
    const failed = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });
    expect(failed.statusCode).toBe(422);
    expect((await historyRows())[0]).toMatchObject({ trigger: "manual", outcome: "failed", detail: null });

    await storageRuntime().ledger.run("UPDATE connectors SET sync_status='syncing' WHERE id=?", [CONNECTOR]);
    const skipped = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });
    expect(skipped.statusCode).toBe(409);
    expect((await historyRows())[0]).toMatchObject({
      trigger: "manual",
      outcome: "skipped",
      detail: "a sync was already active",
    });
  });

  it("serves the bounded, newest-first, account-scoped sync history", async () => {
    const connectorId = await insertConnectorRow(ACCOUNT);
    for (const [index, outcome] of ["succeeded", "failed", "skipped"].entries()) {
      await storageRuntime().ledger.run(
        `INSERT INTO connector_syncs (connector_id,account_id,trigger,outcome,detail,started_at,finished_at)
         VALUES (?,?,?,?,?,?,?)`,
        [connectorId, ACCOUNT, "scheduled", outcome, `run ${index}`, `2026-08-29T00:00:0${index}.000Z`, null]
      );
    }
    await insertConnectorRow(FOREIGN);
    await recordHistory(FOREIGN, await foreignConnectorId(), "manual", "succeeded");
    const app = await buildApp();

    const bounded = await app.inject({
      method: "GET",
      url: `/api/connectors/${connectorId}/syncs?limit=2`,
      headers: auth,
    });
    expect(bounded.statusCode).toBe(200);
    expect(bounded.json()).toHaveLength(2);
    expect((bounded.json() as Array<{ outcome: string }>).map((row) => row.outcome)).toEqual(["skipped", "failed"]);

    const unauthenticated = await app.inject({ method: "GET", url: `/api/connectors/${connectorId}/syncs` });
    expect(unauthenticated.statusCode).toBe(401);

    const unknown = await app.inject({
      method: "GET",
      url: `/api/connectors/99999999-9999-4999-8999-999999999999/syncs`,
      headers: auth,
    });
    expect(unknown.statusCode).toBe(404);

    const foreignConnector = await foreignConnectorId();
    const foreign = await app.inject({
      method: "GET",
      url: `/api/connectors/${foreignConnector}/syncs`,
      headers: auth,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("creates, updates, and removes the derived schedule round-trip", async () => {
    await storageRuntime().sources.createConnector(ACCOUNT, connectorStoreInput("ledger", "idle"));
    const app = await buildApp();

    const created = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: 60 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().schedule).toMatchObject({
      schedule_minutes: 60,
      state: "active",
      automation_id: expect.any(String),
      last_run_at: null,
    });
    const automationRows = await connectorSyncAutomationRows();
    expect(automationRows).toHaveLength(1);
    expect(automationRows[0]).toMatchObject({ name: "Connector: Feed", schedule_minutes: 60 });

    const listed = await app.inject({ method: "GET", url: "/api/connectors", headers: auth });
    expect(listed.json()[0].schedule).toMatchObject({ schedule_minutes: 60 });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: 30 },
    });
    expect(updated.json().schedule).toMatchObject({ schedule_minutes: 30 });
    await expect(connectorSyncAutomationRows()).resolves.toHaveLength(1);

    const removed = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: null },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().schedule).toBeNull();
    await expect(connectorSyncAutomationRows()).resolves.toEqual([]);

    const removedAgain = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: null },
    });
    expect(removedAgain.statusCode).toBe(200);

    const outOfRange = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: 5 },
    });
    expect(outOfRange.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "PUT",
      url: `/api/connectors/99999999-9999-4999-8999-999999999999/schedule`,
      headers: auth,
      payload: { schedule_minutes: 60 },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("gates the schedule behind remote egress consent", async () => {
    await storageRuntime().sources.createConnector(ACCOUNT, connectorStoreInput("ledger", "idle"));
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider.example" });
    const app = await buildApp();

    const blocked = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: 60 },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "REMOTE_EGRESS_CONSENT_REQUIRED" });
    await expect(connectorSyncAutomationRows()).resolves.toEqual([]);

    await storageRuntime().ledger.run(
      "UPDATE users SET remote_egress_ack_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      [ACCOUNT]
    );
    const allowed = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: 60 },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().schedule).toMatchObject({ schedule_minutes: 60 });
  });

  it("refuses to guess when multiple connector_sync automations target the connector", async () => {
    await storageRuntime().sources.createConnector(ACCOUNT, connectorStoreInput("ledger", "idle"));
    for (const name of ["Connector: Feed", "Legacy sync"]) {
      await storageRuntime().ledger.run(
        `INSERT INTO automations (id,account_id,name,kind,target_id,schedule_minutes,next_run_at)
         VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        [randomUUID(), ACCOUNT, name, "connector_sync", CONNECTOR, 60]
      );
    }
    const app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: 60 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "multiple connector_sync automations target this connector; clean up in Automations",
    });
    const listed = await app.inject({ method: "GET", url: "/api/connectors", headers: auth });
    expect(listed.json()[0].schedule).toBeNull();
  });

  it("suffixes the derived automation name when it collides with an unrelated automation", async () => {
    await storageRuntime().sources.createConnector(ACCOUNT, connectorStoreInput("ledger", "idle"));
    const chatId = randomUUID();
    await storageRuntime().ledger.run(`INSERT INTO chats (id,account_id,title,model) VALUES (?,?,?,?)`, [
      chatId,
      ACCOUNT,
      "Digest",
      "chat-model",
    ]);
    await storageRuntime().ledger.run(
      `INSERT INTO automations (id,account_id,name,kind,target_id,prompt,schedule_minutes,next_run_at)
       VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [randomUUID(), ACCOUNT, "Connector: Feed", "agent_turn", chatId, "Summarize", 30]
    );
    const app = await buildApp();

    const response = await app.inject({
      method: "PUT",
      url: `/api/connectors/${CONNECTOR}/schedule`,
      headers: auth,
      payload: { schedule_minutes: 60 },
    });
    expect(response.statusCode).toBe(200);
    const automationRows = await connectorSyncAutomationRows();
    expect(automationRows).toHaveLength(1);
    expect(automationRows[0]).toMatchObject({ name: "Connector: Feed (2)", target_id: CONNECTOR });
  });

  it("cascades schedule automations and history rows on connector deletion", async () => {
    await storageRuntime().sources.createConnector(ACCOUNT, connectorStoreInput("ledger", "idle"));
    await storageRuntime().ledger.run(
      `INSERT INTO automations (id,account_id,name,kind,target_id,schedule_minutes,next_run_at)
       VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [randomUUID(), ACCOUNT, "Connector: Feed", "connector_sync", CONNECTOR, 60]
    );
    await recordHistory(ACCOUNT, CONNECTOR, "manual", "succeeded");
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/connectors/${CONNECTOR}`, headers: auth });
    expect(response.statusCode).toBe(200);
    await expect(
      storageRuntime().ledger.all("SELECT 1 FROM automations WHERE target_id=?", [CONNECTOR])
    ).resolves.toEqual([]);
    await expect(historyRows()).resolves.toEqual([]);
  });

  it("never lets a history write fail its caller", async () => {
    await closeStorageRuntime();
    await expect(
      recordConnectorSync({
        accountId: ACCOUNT,
        connectorId: CONNECTOR,
        trigger: "manual",
        outcome: "succeeded",
      })
    ).resolves.toBeUndefined();
  });
});

function connectorPayload(targetTable: string) {
  return {
    display_name: "Ledger",
    target_table: targetTable,
    type: "url_csv",
    config: { url: "https://example.invalid/ledger.csv" },
  };
}

async function historyRows(): Promise<
  Array<{ trigger: string; outcome: string; detail: string | null; finished_at: string | null }>
> {
  return storageRuntime().ledger.all<{
    trigger: string;
    outcome: string;
    detail: string | null;
    finished_at: string | null;
  }>("SELECT trigger,outcome,detail,finished_at FROM connector_syncs ORDER BY started_at DESC,id DESC");
}

async function recordHistory(accountId: string, connectorId: string, trigger: string, outcome: string): Promise<void> {
  await storageRuntime().ledger.run(
    `INSERT INTO connector_syncs (connector_id,account_id,trigger,outcome,started_at,finished_at)
     VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    [connectorId, accountId, trigger, outcome]
  );
}

async function insertConnectorRow(accountId: string): Promise<string> {
  const id = randomUUID();
  await storageRuntime().ledger.run(
    `INSERT INTO connectors (id,account_id,name,type,config,target_table) VALUES (?,?,?,?,?,?)`,
    [
      id,
      accountId,
      "Feed",
      "url_csv",
      encodeJson({ url: "https://example.invalid/feed.csv" }),
      `table_${id.slice(0, 8)}`,
    ]
  );
  return id;
}

async function foreignConnectorId(): Promise<string> {
  const rows = await storageRuntime().ledger.all<{ id: string }>("SELECT id FROM connectors WHERE account_id=?", [
    FOREIGN,
  ]);
  return rows[0].id;
}

async function connectorSyncAutomationRows(): Promise<Array<Record<string, unknown>>> {
  const rows = await storageRuntime().ledger.all<{
    name: unknown;
    kind: unknown;
    target_id: unknown;
    schedule_minutes: unknown;
  }>("SELECT name,kind,target_id,schedule_minutes FROM automations WHERE kind='connector_sync' ORDER BY created_at,id");
  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    target_id: row.target_id,
    schedule_minutes: Number(row.schedule_minutes),
  }));
}

function connectorStoreInput(
  targetTable: string,
  syncStatus: CreateConnectorInput["syncStatus"],
  sourceOverrides: Partial<CreateConnectorInput["source"]> = {}
): CreateConnectorInput {
  return {
    id: CONNECTOR,
    name: "Feed",
    type: "url_csv",
    config: { url: `https://example.invalid/${targetTable}.csv` },
    targetTable,
    syncStatus,
    source: {
      id: SOURCE,
      displayName: "Feed",
      url: `https://example.invalid/${targetTable}.csv`,
      mime: "text/csv",
      status: "ready",
      meta: {},
      ...sourceOverrides,
    },
  };
}

function randomUUIDLike(): string {
  return "66666666-6666-4666-8666-666666666666";
}
