import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm.js", () => ({ embed: vi.fn() }));
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
import { restoreDatasets, stopIngestionWorkers } from "../ingest.js";
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
    await storageRuntime().sources.createSource(UPLOAD_ACCOUNT, {
      id: randomUUID(),
      name: "failed_table",
      kind: "tabular",
      displayName: "Failed.csv",
      filePath: "/safe/failed.csv",
      status: "error",
    });
    listMock.mockImplementation(async (accountId) =>
      accountId === UPLOAD_ACCOUNT
        ? [
            { table: "failed_table", location: "/safe/failed.csv", kind: "url", exists: true },
            { table: "active_table", location: "/safe/active.csv", exists: true },
          ]
        : []
    );

    await expect(restoreDatasets()).resolves.toMatchObject({
      stale_attempted: 1,
      removed: 1,
      remove_failed: 0,
    });
    expect(deactivateMock).toHaveBeenCalledWith(UPLOAD_ACCOUNT, "failed_table", "/safe/failed.csv");
    expect(cleanupMock).toHaveBeenCalledWith(UPLOAD_ACCOUNT, "failed_table", "/safe/failed.csv");
    expect(deactivateMock).not.toHaveBeenCalledWith(UPLOAD_ACCOUNT, "active_table", expect.anything());
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
});
