import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm.js", () => ({ embed: vi.fn() }));
vi.mock("../storageArtifacts.js", () => ({
  resolveSourceArtifact: vi.fn(async ({ filePath }: { filePath: string }) => filePath),
  removeSourceArtifact: vi.fn(async () => true),
}));
vi.mock("../dataService.js", () => ({
  DataServiceError: class DataServiceError extends Error {
    constructor(
      readonly status: number,
      readonly operation = "test"
    ) {
      super("data service failure");
    }
  },
  dataService: {
    health: vi.fn(async () => true),
    listDatasets: vi.fn(async () => []),
    registerDataset: vi.fn(),
    extractDataset: vi.fn(),
    extractPreparedDataset: vi.fn(),
    prepareDatasetRefresh: vi.fn(),
    abortDatasetRefresh: vi.fn(),
    activateDatasetRefresh: vi.fn(),
    deactivateDatasetLocation: vi.fn(),
    cleanupDatasetCache: vi.fn(),
  },
}));

import { encodeJson } from "../db/codecs.js";
import { DataServiceError, dataService } from "../dataService.js";
import {
  processOnePreparingConnectorRefresh,
  recoverPreparingConnectorLeases,
  stopIngestionWorkers,
} from "../ingest.js";
import { embed } from "../llm.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const prepareMock = vi.mocked(dataService.prepareDatasetRefresh);
const abortMock = vi.mocked(dataService.abortDatasetRefresh);
const extractPreparedMock = vi.mocked(dataService.extractPreparedDataset);
const activateMock = vi.mocked(dataService.activateDatasetRefresh);
const embedMock = vi.mocked(embed);
let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingestion-worker-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(directory, "ledger.sqlite"),
    lanceDirectory: path.join(directory, "lancedb"),
    embeddingDimension: 768,
  });
  await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    ACCOUNT,
    "owner@example.test",
    "hash",
  ]);
  prepareMock.mockReset();
  abortMock.mockReset();
  abortMock.mockResolvedValue({ status: "deleted" });
  extractPreparedMock.mockReset();
  extractPreparedMock.mockResolvedValue({
    columns: ["amount"],
    rows: [[42]],
    row_count: 1,
    total_row_count: 1,
    returned_row_count: 1,
    columns_truncated: false,
    truncated: false,
  });
  activateMock.mockReset();
  activateMock.mockImplementation(async (_account, _name, version, _url, _display, _format, _previous) => ({
    version,
    location: path.join(directory, `${version}.csv`),
  }));
  embedMock.mockReset();
  embedMock.mockImplementation(async (texts) => texts.map(() => Array(768).fill(0.01)));
});

afterEach(async () => {
  await stopIngestionWorkers();
  await closeStorageRuntime();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("durable connector prepare worker", () => {
  it("never steals a live prepare lease created by the request path", async () => {
    await createPreparingConnector();

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(false);
    expect(prepareMock).not.toHaveBeenCalled();
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, sourceId())).resolves.toMatchObject({
      status: "preparing",
      attempts: 1,
      leaseToken: expect.any(String),
    });
  });

  it("reclaims inherited prepare leases at startup and promotes the exact candidate to pending indexing", async () => {
    const reserved = await createPreparingConnector();
    await expect(recoverPreparingConnectorLeases(true)).resolves.toBe(1);
    prepareMock.mockImplementation(async (_account, _name, version) => {
      const location = path.join(directory, `${version}.csv`);
      await fs.writeFile(location, "amount\n42\n");
      return {
        version,
        location,
        previous_location: null,
        rows: 1,
        size_bytes: 20,
      };
    });

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(true);

    await vi.waitFor(async () => {
      await expect(storageRuntime().ingestion.getJob(ACCOUNT, reserved.source.id)).resolves.toMatchObject({
        status: "done",
      });
    });
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, reserved.source.id)).resolves.toMatchObject({
      generation: 1,
      status: "done",
      attempts: 3,
      leaseToken: null,
    });
    await expect(storageRuntime().sources.getConnector(ACCOUNT, reserved.connector.id)).resolves.toMatchObject({
      syncStatus: "idle",
    });
    await expect(storageRuntime().sources.getSource(ACCOUNT, reserved.source.id)).resolves.toMatchObject({
      status: "ready",
      filePath: path.join(directory, `${reserved.refreshVersion}.csv`),
      readyGeneration: 1,
      meta: {},
    });
  });

  it("defers a transient prepare failure only while its exact lease is owned", async () => {
    const reserved = await createPreparingConnector();
    await recoverPreparingConnectorLeases(true);
    prepareMock.mockRejectedValue(new DataServiceError(503, "/datasets/refresh/prepare"));

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(true);

    expect(abortMock).toHaveBeenCalledWith(ACCOUNT, "ledger", reserved.refreshVersion, "csv");
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, reserved.source.id)).resolves.toMatchObject({
      status: "preparing",
      attempts: 2,
      leaseToken: null,
      lastError: "PREPARE_TRANSIENT",
    });
  });

  it("keeps an uncertain prepare outcome retryable even after the nominal attempt budget", async () => {
    const reserved = await createPreparingConnector();
    await storageRuntime().ledger.run("UPDATE ingestion_jobs SET attempts=9 WHERE source_id=?", [reserved.source.id]);
    await recoverPreparingConnectorLeases(true);
    prepareMock.mockRejectedValue(new Error("response lost"));
    abortMock.mockRejectedValue(new Error("abort confirmation lost"));

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(true);
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, reserved.source.id)).resolves.toMatchObject({
      status: "preparing",
      attempts: 10,
      leaseToken: null,
      lastError: "PREPARE_TRANSIENT",
    });
  });

  it("terminalizes a permanent first-sync failure and preserves no partial vector/text state", async () => {
    const reserved = await createPreparingConnector();
    await recoverPreparingConnectorLeases(true);
    prepareMock.mockRejectedValue(new DataServiceError(400, "/datasets/refresh/prepare"));

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(true);

    await expect(storageRuntime().ingestion.getJob(ACCOUNT, reserved.source.id)).resolves.toMatchObject({
      status: "error",
      lastError: "PREPARE_FAILED",
    });
    await expect(storageRuntime().sources.getSource(ACCOUNT, reserved.source.id)).resolves.toMatchObject({
      status: "error",
      meta: { error_code: "PREPARE_FAILED" },
    });
    await expect(storageRuntime().vectors.scanRows()).resolves.toEqual([]);
  });

  it("keeps a last-good generation ready when a later connector prepare fails permanently", async () => {
    const connectorId = randomUUID();
    const source = randomUUID();
    await storageRuntime().sources.createConnector(ACCOUNT, {
      id: connectorId,
      name: "Feed",
      type: "url_csv",
      config: { url: "https://example.invalid/ledger.csv" },
      targetTable: "ledger",
      syncStatus: "idle",
      source: {
        id: source,
        displayName: "Ledger feed",
        url: "https://example.invalid/ledger.csv",
        mime: "text/csv",
        filePath: "/safe/cache/live.csv",
        status: "ready",
        readyGeneration: 1,
      },
    });
    await storageRuntime().ledger.run(
      `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomUUID(), ACCOUNT, source, 1, 0, "ledger", "last good", encodeJson({})]
    );
    await storageRuntime().sourceIngestion.beginConnectorRefresh({
      accountId: ACCOUNT,
      connectorId,
      refreshVersion: randomUUID(),
      leaseToken: randomUUID(),
    });
    await recoverPreparingConnectorLeases(true);
    prepareMock.mockRejectedValue(new DataServiceError(422, "/datasets/refresh/prepare"));

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(true);

    await expect(storageRuntime().sources.getSource(ACCOUNT, source)).resolves.toMatchObject({
      status: "ready",
      readyGeneration: 1,
    });
    await expect(storageRuntime().sources.getConnector(ACCOUNT, connectorId)).resolves.toMatchObject({
      syncStatus: "error",
    });
  });
});

async function createPreparingConnector() {
  return storageRuntime().sourceIngestion.createConnectorPrepare(ACCOUNT, {
    connectorId: connectorId(),
    sourceId: sourceId(),
    displayName: "Ledger feed",
    targetTable: "ledger",
    type: "url_csv",
    url: "https://example.invalid/ledger.csv",
    refreshVersion: randomUUID(),
    leaseToken: randomUUID(),
  });
}

function connectorId(): string {
  return "22222222-2222-4222-8222-222222222222";
}

function sourceId(): string {
  return "33333333-3333-4333-8333-333333333333";
}
