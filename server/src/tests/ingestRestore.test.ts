import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm.js", () => {
  const embed = vi.fn();
  return { embed, createEmbeddingExecutor: vi.fn(() => embed) };
});
vi.mock("../dataService.js", () => ({
  DataServiceError: class DataServiceError extends Error {},
  dataService: {
    registerDataset: vi.fn(),
    listDatasets: vi.fn(),
    deactivateDatasetLocation: vi.fn(),
    cleanupDatasetCache: vi.fn(),
    health: vi.fn(),
    extractDataset: vi.fn(),
    extractPreparedDataset: vi.fn(),
    prepareDatasetRefresh: vi.fn(),
    abortDatasetRefresh: vi.fn(),
    activateDatasetRefresh: vi.fn(),
  },
}));
vi.mock("../storageArtifacts.js", () => ({
  resolveSourceArtifact: vi.fn(async ({ filePath }: { filePath: string }) => filePath),
  removeSourceArtifact: vi.fn(async () => true),
}));

import { dataService } from "../dataService.js";
import { processDatasetCacheCleanup, restoreDatasets, stopIngestionWorkers } from "../ingest.js";
import { resolveSourceArtifact } from "../storageArtifacts.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const UPLOAD_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CONNECTOR_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const registerMock = vi.mocked(dataService.registerDataset);
const healthMock = vi.mocked(dataService.health);
const listMock = vi.mocked(dataService.listDatasets);
const deactivateMock = vi.mocked(dataService.deactivateDatasetLocation);
const cleanupMock = vi.mocked(dataService.cleanupDatasetCache);
const resolveSourceArtifactMock = vi.mocked(resolveSourceArtifact);
let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingest-restore-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(directory, "ledger.sqlite"),
    lanceDirectory: path.join(directory, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [UPLOAD_ACCOUNT, "upload@example.test"],
    [CONNECTOR_ACCOUNT, "connector@example.test"],
  ]) {
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
  registerMock.mockReset();
  registerMock.mockResolvedValue({});
  healthMock.mockReset();
  healthMock.mockResolvedValue(true);
  listMock.mockReset();
  listMock.mockResolvedValue([]);
  deactivateMock.mockReset();
  deactivateMock.mockResolvedValue({ status: "dropped" });
  cleanupMock.mockReset();
  cleanupMock.mockResolvedValue({ status: "deleted" });
  resolveSourceArtifactMock.mockClear();
});

afterEach(async () => {
  await stopIngestionWorkers();
  await closeStorageRuntime();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("dataset restoration", () => {
  it("restores uploads as paths and connectors with URL provenance", async () => {
    const uploadId = randomUUID();
    await storageRuntime().sources.createSource(UPLOAD_ACCOUNT, {
      id: uploadId,
      name: "ledger",
      kind: "tabular",
      displayName: "Ledger.json",
      filePath: "/safe/uploads/ledger.json",
      mime: "application/json",
      status: "ready",
      readyGeneration: 1,
    });
    const connectorId = randomUUID();
    const connectorSourceId = randomUUID();
    await storageRuntime().sources.createConnector(CONNECTOR_ACCOUNT, {
      id: connectorId,
      name: "Balances feed",
      type: "url_csv",
      config: { url: "https://example.invalid/balances.csv?signature=secret" },
      targetTable: "balances",
      syncStatus: "idle",
      source: {
        id: connectorSourceId,
        displayName: "Balances feed",
        url: "https://example.invalid/balances.csv?signature=secret",
        mime: "text/csv",
        filePath: "/safe/cache/balances.csv",
        status: "ready",
        readyGeneration: 1,
      },
    });

    await expect(restoreDatasets()).resolves.toEqual({
      attempted: 2,
      restored: 2,
      failed: 0,
      stale_attempted: 0,
      removed: 0,
      remove_failed: 0,
    });
    expect(registerMock).toHaveBeenNthCalledWith(1, UPLOAD_ACCOUNT, "ledger", {
      location: "/safe/uploads/ledger.json",
      kind: "path",
      originalName: "Ledger.json",
      sourceId: uploadId,
    });
    expect(registerMock).toHaveBeenNthCalledWith(2, CONNECTOR_ACCOUNT, "balances", {
      location: "/safe/cache/balances.csv",
      kind: "url",
      url: "https://example.invalid/balances.csv?signature=secret",
      originalName: "Balances feed",
      expectedFormat: "csv",
    });
    expect(resolveSourceArtifactMock).toHaveBeenCalledTimes(2);
  });

  it("performs no registrations when the healthy registry already matches", async () => {
    await storageRuntime().sources.createSource(UPLOAD_ACCOUNT, {
      id: randomUUID(),
      name: "ledger",
      kind: "tabular",
      displayName: "Ledger.json",
      filePath: "/safe/uploads/ledger.json",
      status: "ready",
      readyGeneration: 1,
    });
    listMock.mockImplementation(async (accountId) =>
      accountId === UPLOAD_ACCOUNT ? [{ table: "ledger", location: "/safe/uploads/ledger.json", exists: true }] : []
    );

    await expect(restoreDatasets()).resolves.toMatchObject({ attempted: 0, restored: 0, failed: 0 });
    expect(registerMock).not.toHaveBeenCalled();
  });

  it("removes stale registry identities while preserving an actively indexing table name", async () => {
    await storageRuntime().sources.createSource(UPLOAD_ACCOUNT, {
      id: randomUUID(),
      name: "active_table",
      kind: "tabular",
      displayName: "Active.csv",
      filePath: "/safe/active.csv",
      status: "index",
    });
    listMock.mockImplementation(async (accountId) =>
      accountId === UPLOAD_ACCOUNT
        ? [
            { table: "orphaned_table", location: "/safe/orphaned.csv", kind: "url", exists: true },
            { table: "active_table", location: "/safe/active.csv", exists: true },
          ]
        : []
    );

    await expect(restoreDatasets()).resolves.toMatchObject({
      stale_attempted: 1,
      removed: 1,
      remove_failed: 0,
    });
    expect(deactivateMock).toHaveBeenCalledWith(UPLOAD_ACCOUNT, "orphaned_table", "/safe/orphaned.csv");
    expect(cleanupMock).toHaveBeenCalledWith(UPLOAD_ACCOUNT, "orphaned_table", "/safe/orphaned.csv");
    expect(deactivateMock).not.toHaveBeenCalledWith(UPLOAD_ACCOUNT, "active_table", expect.anything());
  });

  it("persists stale URL cleanup before deactivation and repairs a failed deletion after restart", async () => {
    const location = "/safe/cache/orphaned-feed.csv";
    listMock.mockImplementation(async (accountId) =>
      accountId === UPLOAD_ACCOUNT ? [{ table: "orphaned_feed", location, kind: "url", exists: true }] : []
    );
    deactivateMock.mockImplementationOnce(async (accountId, name, exactLocation) => {
      await expect(storageRuntime().ingestion.listDatasetCleanupJobs({ accountId, name })).resolves.toEqual([
        { accountId, name, location: exactLocation, attempts: 0 },
      ]);
      return { status: "dropped" };
    });
    cleanupMock.mockRejectedValueOnce(new Error("simulated cache removal failure"));

    await expect(restoreDatasets()).resolves.toMatchObject({
      stale_attempted: 1,
      removed: 0,
      remove_failed: 1,
    });
    await expect(
      storageRuntime().ingestion.listDatasetCleanupJobs({ accountId: UPLOAD_ACCOUNT, name: "orphaned_feed" })
    ).resolves.toEqual([{ accountId: UPLOAD_ACCOUNT, name: "orphaned_feed", location, attempts: 1 }]);

    await closeStorageRuntime();
    await initializeStorageRuntime({
      sqlitePath: path.join(directory, "ledger.sqlite"),
      lanceDirectory: path.join(directory, "lancedb"),
      embeddingDimension: 3,
    });
    await expect(processDatasetCacheCleanup(UPLOAD_ACCOUNT, "orphaned_feed")).resolves.toBe(1);
    await expect(
      storageRuntime().ingestion.listDatasetCleanupJobs({ accountId: UPLOAD_ACCOUNT, name: "orphaned_feed" })
    ).resolves.toEqual([]);
    expect(deactivateMock).toHaveBeenCalledTimes(2);
    expect(cleanupMock).toHaveBeenCalledTimes(2);
  });

  it("undoes a stale registration if the durable source identity changes during external I/O", async () => {
    const sourceId = randomUUID();
    await storageRuntime().sources.createSource(UPLOAD_ACCOUNT, {
      id: sourceId,
      name: "ledger",
      kind: "tabular",
      displayName: "Ledger.csv",
      filePath: "/safe/old.csv",
      status: "ready",
      readyGeneration: 1,
    });
    registerMock.mockImplementationOnce(async () => {
      await storageRuntime().ledger.run("UPDATE sources SET status='index',file_path=? WHERE id=?", [
        "/safe/new.csv",
        sourceId,
      ]);
      return {};
    });

    await expect(restoreDatasets()).resolves.toMatchObject({ attempted: 1, restored: 0, failed: 0 });
    expect(deactivateMock).toHaveBeenCalledWith(UPLOAD_ACCOUNT, "ledger", "/safe/old.csv");
  });

  it("preserves the last-good connector cache when a refresh begins during reconciliation and then fails", async () => {
    const connectorId = randomUUID();
    const sourceId = randomUUID();
    const oldLocation = "/safe/cache/last-good.csv";
    await storageRuntime().sources.createConnector(CONNECTOR_ACCOUNT, {
      id: connectorId,
      name: "Feed",
      type: "url_csv",
      config: { url: "https://example.invalid/feed.csv" },
      targetTable: "feed",
      syncStatus: "idle",
      source: {
        id: sourceId,
        displayName: "Feed",
        url: "https://example.invalid/feed.csv",
        mime: "text/csv",
        filePath: oldLocation,
        status: "ready",
        readyGeneration: 1,
      },
    });
    await storageRuntime().ledger.run(
      `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomUUID(), CONNECTOR_ACCOUNT, sourceId, 1, 0, "Feed", "last good", "{}"]
    );
    const registration = deferred<Record<string, unknown>>();
    registerMock.mockReturnValueOnce(registration.promise);

    const restoring = restoreDatasets();
    await vi.waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    const refreshVersion = randomUUID();
    const prepareLeaseToken = randomUUID();
    const refresh = await storageRuntime().sourceIngestion.beginConnectorRefresh({
      accountId: CONNECTOR_ACCOUNT,
      connectorId,
      refreshVersion,
      leaseToken: prepareLeaseToken,
    });
    registration.resolve({});

    await expect(restoring).resolves.toMatchObject({ attempted: 1, restored: 0, failed: 0 });
    expect(registerMock).toHaveBeenCalledWith(CONNECTOR_ACCOUNT, "feed", {
      location: oldLocation,
      kind: "url",
      url: "https://example.invalid/feed.csv",
      originalName: "Feed",
      expectedFormat: "csv",
    });
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(cleanupMock).not.toHaveBeenCalled();
    await expect(
      storageRuntime().ingestion.listDatasetCleanupJobs({ accountId: CONNECTOR_ACCOUNT, name: "feed" })
    ).resolves.toEqual([]);

    await expect(
      storageRuntime().sourceIngestion.failConnectorPrepare({
        accountId: CONNECTOR_ACCOUNT,
        connectorId,
        sourceId,
        generation: refresh.generation,
        leaseToken: prepareLeaseToken,
        errorCode: "PREPARE_FAILED",
      })
    ).resolves.toBe(true);
    await expect(storageRuntime().sources.getSource(CONNECTOR_ACCOUNT, sourceId)).resolves.toMatchObject({
      status: "ready",
      filePath: oldLocation,
      readyGeneration: 1,
    });
  });

  it("reserves exact stale connector cleanup after a raced promotion and retries it after restart", async () => {
    const connectorId = randomUUID();
    const sourceId = randomUUID();
    const oldLocation = "/safe/cache/old-version.csv";
    const newLocation = "/safe/cache/new-version.csv";
    await storageRuntime().sources.createConnector(CONNECTOR_ACCOUNT, {
      id: connectorId,
      name: "Feed",
      type: "url_csv",
      config: { url: "https://example.invalid/feed.csv" },
      targetTable: "feed",
      syncStatus: "idle",
      source: {
        id: sourceId,
        displayName: "Feed",
        url: "https://example.invalid/feed.csv",
        mime: "text/csv",
        filePath: oldLocation,
        status: "ready",
        readyGeneration: 1,
      },
    });
    const timestamp = new Date(0).toISOString();
    await storageRuntime().ledger.run(
      `INSERT INTO ingestion_jobs
         (source_id,account_id,generation,status,attempts,available_at,created_at,updated_at)
       VALUES (?,?,1,'done',1,?,?,?)`,
      [sourceId, CONNECTOR_ACCOUNT, timestamp, timestamp, timestamp]
    );
    const registration = deferred<Record<string, unknown>>();
    registerMock.mockReturnValueOnce(registration.promise);

    const restoring = restoreDatasets();
    await vi.waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    const refreshVersion = randomUUID();
    const prepareLeaseToken = randomUUID();
    const refresh = await storageRuntime().sourceIngestion.beginConnectorRefresh({
      accountId: CONNECTOR_ACCOUNT,
      connectorId,
      refreshVersion,
      leaseToken: prepareLeaseToken,
    });
    await storageRuntime().sourceIngestion.activatePreparedConnector({
      accountId: CONNECTOR_ACCOUNT,
      connectorId,
      sourceId,
      generation: refresh.generation,
      leaseToken: prepareLeaseToken,
      refreshVersion,
      url: "https://example.invalid/feed.csv",
      displayName: "Feed",
      mime: "text/csv",
      candidateLocation: newLocation,
      activationPreviousLocation: oldLocation,
      cleanupPreviousLocation: oldLocation,
    });
    const job = await storageRuntime().ingestion.claimNext("pending");
    if (!job?.leaseToken) throw new Error("test ingestion job was not leased");
    await storageRuntime().ingestion.stageChunks({
      accountId: CONNECTOR_ACCOUNT,
      sourceId,
      generation: job.generation,
      leaseToken: job.leaseToken,
      sourceName: "Feed",
      chunks: [{ content: "new version", meta: {} }],
    });
    await storageRuntime().ingestion.promoteGeneration({
      accountId: CONNECTOR_ACCOUNT,
      sourceId,
      generation: job.generation,
      leaseToken: job.leaseToken,
      sizeBytes: 11,
      promotedFilePath: newLocation,
      verifyVectors: async () => true,
    });
    deactivateMock.mockImplementationOnce(async (accountId, name, exactLocation) => {
      await expect(storageRuntime().ingestion.listDatasetCleanupJobs({ accountId, name })).resolves.toEqual([
        { accountId, name, location: exactLocation, attempts: 0 },
      ]);
      return { status: "dropped" };
    });
    cleanupMock.mockRejectedValueOnce(new Error("simulated first delete failure"));
    registration.resolve({});

    await expect(restoring).resolves.toMatchObject({ attempted: 1, restored: 0, failed: 1 });
    await expect(
      storageRuntime().ingestion.listDatasetCleanupJobs({ accountId: CONNECTOR_ACCOUNT, name: "feed" })
    ).resolves.toEqual([{ accountId: CONNECTOR_ACCOUNT, name: "feed", location: oldLocation, attempts: 1 }]);
    await expect(storageRuntime().sources.getSource(CONNECTOR_ACCOUNT, sourceId)).resolves.toMatchObject({
      status: "ready",
      filePath: newLocation,
      meta: { connector_previous_location: oldLocation },
    });

    await closeStorageRuntime();
    await initializeStorageRuntime({
      sqlitePath: path.join(directory, "ledger.sqlite"),
      lanceDirectory: path.join(directory, "lancedb"),
      embeddingDimension: 3,
    });
    await expect(processDatasetCacheCleanup(CONNECTOR_ACCOUNT, "feed")).resolves.toBe(1);
    await expect(
      storageRuntime().ingestion.listDatasetCleanupJobs({ accountId: CONNECTOR_ACCOUNT, name: "feed" })
    ).resolves.toEqual([]);
    await expect(storageRuntime().sources.getSource(CONNECTOR_ACCOUNT, sourceId)).resolves.toMatchObject({
      status: "ready",
      filePath: newLocation,
      meta: {},
    });
    expect(deactivateMock).toHaveBeenCalledTimes(2);
    expect(cleanupMock).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
