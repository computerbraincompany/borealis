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
import { encodeJson } from "../db/codecs.js";
import type { CreateConnectorInput } from "../db/stores/sourceStore.js";
import { DataServiceError, dataService } from "../dataService.js";
import { wakeConnectorPrepareWorkers, wakeIngestionWorkers } from "../ingest.js";
import { routes } from "../routes.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
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
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
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

function connectorPayload(targetTable: string) {
  return {
    display_name: "Ledger",
    target_table: targetTable,
    type: "url_csv",
    config: { url: "https://example.invalid/ledger.csv" },
  };
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
