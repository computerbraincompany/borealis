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
    currentDatasetLocation: vi.fn(async () => null),
  },
}));
vi.mock("../storageArtifacts.js", () => ({
  resolveSourceArtifact: vi.fn(async ({ filePath }: { filePath: string }) => filePath),
  removeSourceArtifact: vi.fn(async () => true),
  isMissingOwnedSourceArtifact: vi.fn(async () => false),
}));

import { appLog } from "../appLogger.js";
import type { IngestionJob } from "../db/stores/ingestionStore.js";
import { PENDING_SOURCE_DELETE_SNAPSHOT_TABLE } from "../db/stores/sourceStore.js";
import { dataService } from "../dataService.js";
import {
  processDatasetCacheCleanup,
  repairPendingSourceDeletesAtStartup,
  restoreDatasets,
  runPeriodicStorageReconciliation,
  startIngestionWorkers,
  stopIngestionWorkers,
  triggerLeaseRecovery,
  triggerStorageReconciliation,
  wakeConnectorPrepareWorkers,
  wakeIngestionWorkers,
} from "../ingest.js";
import { resolveSourceArtifact, removeSourceArtifact } from "../storageArtifacts.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const UPLOAD_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CONNECTOR_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const registerMock = vi.mocked(dataService.registerDataset);
const healthMock = vi.mocked(dataService.health);
const listMock = vi.mocked(dataService.listDatasets);
const deactivateMock = vi.mocked(dataService.deactivateDatasetLocation);
const cleanupMock = vi.mocked(dataService.cleanupDatasetCache);
const resolveSourceArtifactMock = vi.mocked(resolveSourceArtifact);
const removeArtifactMock = vi.mocked(removeSourceArtifact);
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
  removeArtifactMock.mockReset();
  removeArtifactMock.mockResolvedValue(true);
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
    // The promotion transaction requires the exact durable `activated`
    // identity: drive the same typed CAS sequence the ingestion engine uses.
    const refreshIdentity = {
      accountId: CONNECTOR_ACCOUNT,
      sourceId,
      connectorId,
      generation: job.generation,
      refreshVersion,
    };
    await expect(storageRuntime().connectorRefresh.claimActivation(refreshIdentity)).resolves.toBe(true);
    await expect(storageRuntime().connectorRefresh.confirmActivation(refreshIdentity)).resolves.toBe(true);
    await storageRuntime().ingestion.promoteGeneration({
      accountId: CONNECTOR_ACCOUNT,
      sourceId,
      generation: job.generation,
      leaseToken: job.leaseToken,
      sizeBytes: 11,
      promotedFilePath: newLocation,
      refresh: refreshIdentity,
      verifyVectors: async () => true,
    });
    deactivateMock.mockImplementationOnce(async (accountId, name, exactLocation) => {
      await expect(storageRuntime().ingestion.listDatasetCleanupJobs({ accountId, name })).resolves.toEqual([
        { accountId, name, location: exactLocation, attempts: 0 },
      ]);
      return { status: "dropped" };
    });
    // The first delete (inline reconciliation retry) fails, and the typed
    // snapshot pass at the end of the same startup attempt also fails; the
    // row stays durable for the post-restart periodic retry.
    cleanupMock.mockRejectedValue(new Error("simulated cache delete failure"));
    registration.resolve({});

    await expect(restoring).resolves.toMatchObject({ attempted: 1, restored: 0, failed: 1 });
    await expect(
      storageRuntime().ingestion.listDatasetCleanupJobs({ accountId: CONNECTOR_ACCOUNT, name: "feed" })
    ).resolves.toEqual([{ accountId: CONNECTOR_ACCOUNT, name: "feed", location: oldLocation, attempts: 1 }]);
    await expect(storageRuntime().sources.getSource(CONNECTOR_ACCOUNT, sourceId)).resolves.toMatchObject({
      status: "ready",
      filePath: newLocation,
      // Protocol state is typed: the promotion moved it to cleanup_pending
      // and `sources.meta` never carries a protocol location.
      meta: {},
    });
    await expect(storageRuntime().connectorRefresh.getState(CONNECTOR_ACCOUNT, sourceId)).resolves.toMatchObject({
      phase: "cleanup_pending",
      generation: 2,
      refreshVersion,
      candidateLocation: newLocation,
      cleanupPreviousLocation: oldLocation,
      attempts: 1,
    });

    await closeStorageRuntime();
    await initializeStorageRuntime({
      sqlitePath: path.join(directory, "ledger.sqlite"),
      lanceDirectory: path.join(directory, "lancedb"),
      embeddingDimension: 3,
    });
    // Replace the default rejection without clearing call counts.
    cleanupMock.mockResolvedValue({ status: "deleted" });
    await expect(processDatasetCacheCleanup(CONNECTOR_ACCOUNT, "feed")).resolves.toBe(1);
    await expect(
      storageRuntime().ingestion.listDatasetCleanupJobs({ accountId: CONNECTOR_ACCOUNT, name: "feed" })
    ).resolves.toEqual([]);
    await expect(storageRuntime().sources.getSource(CONNECTOR_ACCOUNT, sourceId)).resolves.toMatchObject({
      status: "ready",
      filePath: newLocation,
      meta: {},
    });
    // The durable cleanup queue completing does not erase the typed protocol
    // row; only confirmed cleanup through the repair owner deletes it.
    await expect(storageRuntime().connectorRefresh.getState(CONNECTOR_ACCOUNT, sourceId)).resolves.toMatchObject({
      phase: "cleanup_pending",
    });
    // 1 reconciliation retry + 1 typed startup attempt + 1 post-restart pass.
    expect(deactivateMock).toHaveBeenCalledTimes(3);
    expect(cleanupMock).toHaveBeenCalledTimes(3);
  });
});

async function seedPendingSourceDeletes(
  accountId: string,
  specs: {
    sourceId: string;
    name?: string;
    filePath?: string | null;
    attempts?: number;
    createdAt?: string;
  }[]
): Promise<void> {
  const ledger = storageRuntime().ledger;
  await ledger.withImmediateTransaction((transaction) => {
    for (let start = 0; start < specs.length; start += 50) {
      const chunk = specs.slice(start, start + 50);
      const timestamp = new Date().toISOString();
      transaction.run(
        `INSERT INTO pending_source_deletes
           (source_id,account_id,name,file_path,dataset_locations,attempts,created_at,updated_at)
         VALUES ${chunk.map(() => "(?,?,?,?,'[]',?,?,?)").join(",")}`,
        chunk.flatMap((spec) => [
          spec.sourceId,
          accountId,
          spec.name ?? `source_${spec.sourceId.slice(0, 8)}`,
          spec.filePath ?? null,
          spec.attempts ?? 0,
          spec.createdAt ?? timestamp,
          spec.createdAt ?? timestamp,
        ])
      );
    }
  });
}

async function seedPendingSourceDelete(
  accountId: string,
  sourceId: string,
  options: { name?: string; filePath?: string; attempts?: number; createdAt?: string } = {}
): Promise<void> {
  await seedPendingSourceDeletes(accountId, [{ sourceId, ...options }]);
}

async function snapshotTablePresence(): Promise<boolean> {
  const row = await storageRuntime().ledger.get<{ name: string }>(`SELECT name FROM temp.sqlite_master WHERE name=?`, [
    PENDING_SOURCE_DELETE_SNAPSHOT_TABLE,
  ]);
  return row !== undefined;
}

describe("periodic storage reconciliation", () => {
  it("drains exactly the three bounded durable queues and never sweeps the corpus", async () => {
    // The startup typed snapshot has not settled for this lifecycle (no
    // restoreDatasets call), so the fourth queue is skipped without ever
    // reading a typed refresh row.
    const runtime = storageRuntime();
    const drainSpy = vi.spyOn(runtime.vectorLifecycle, "drainPendingVectorOperations");
    const startupSpy = vi.spyOn(runtime.vectorLifecycle, "repairAtStartup");
    const scanSpy = vi.spyOn(runtime.vectors, "scanRows");
    const crossAccountSpy = vi.spyOn(runtime.sources, "listPendingSourceDeletesAcrossAccounts");
    const cleanupSpy = vi.spyOn(runtime.ingestion, "listDatasetCleanupJobs");
    const refreshSpy = vi.spyOn(runtime.connectorRefresh, "listRepairableStates");

    await runPeriodicStorageReconciliation();

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledWith(100);
    expect(crossAccountSpy).toHaveBeenCalledTimes(1);
    expect(crossAccountSpy).toHaveBeenCalledWith(100);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith({ accountId: undefined, name: undefined, limit: 20 });
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(startupSpy).not.toHaveBeenCalled();
    expect(scanSpy).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(healthMock).not.toHaveBeenCalled();
  });

  it(
    "processes at most one 100-intent page per invocation and progresses across invocations",
    { timeout: 30_000 },
    async () => {
      await seedPendingSourceDeletes(
        UPLOAD_ACCOUNT,
        Array.from({ length: 150 }, (_unused, index) => ({
          sourceId: randomUUID(),
          name: `page_source_${index}`,
          filePath: `/safe/uploads/page-${index}.csv`,
        }))
      );
      const runtime = storageRuntime();
      const realPage = runtime.sources.listPendingSourceDeletesAcrossAccounts.bind(runtime.sources);
      const pageSpy = vi
        .spyOn(runtime.sources, "listPendingSourceDeletesAcrossAccounts")
        .mockImplementation((limit) => realPage(limit));
      const realClear = runtime.sources.clearPendingSourceDelete.bind(runtime.sources);
      const clearSpy = vi
        .spyOn(runtime.sources, "clearPendingSourceDelete")
        .mockImplementation((account, source) => realClear(account, source));

      await runPeriodicStorageReconciliation();
      // One bounded page per invocation, even though 50 more rows are durable.
      expect(pageSpy).toHaveBeenCalledTimes(1);
      expect(pageSpy).toHaveBeenCalledWith(100);
      expect(clearSpy).toHaveBeenCalledTimes(100);
      await expect(realPage(200)).resolves.toHaveLength(50);

      await runPeriodicStorageReconciliation();
      expect(pageSpy).toHaveBeenCalledTimes(2);
      expect(clearSpy).toHaveBeenCalledTimes(150);
      await expect(realPage(200)).resolves.toHaveLength(0);
    }
  );

  it("isolates one permanently failing intent while successful peers clear", async () => {
    const goodFirst = randomUUID();
    const failing = randomUUID();
    const goodLast = randomUUID();
    for (const sourceId of [goodFirst, failing, goodLast]) {
      await seedPendingSourceDelete(UPLOAD_ACCOUNT, sourceId, { filePath: `/safe/uploads/${sourceId}.csv` });
    }
    // Ownership/missing-artifact proof is not weakened: removal is simply
    // unprovable for the failing intent, which keeps its marker durable.
    removeArtifactMock.mockImplementation(async ({ sourceId }) => sourceId !== failing);

    await runPeriodicStorageReconciliation();

    const remaining = await storageRuntime().sources.listPendingSourceDeletes(UPLOAD_ACCOUNT);
    expect(remaining.map((intent) => intent.sourceId)).toEqual([failing]);
    expect(remaining[0]).toMatchObject({ attempts: 1, lastError: "SOURCE_CLEANUP_RETRY" });

    // Later queued work still progresses on the next invocation.
    const newer = randomUUID();
    await seedPendingSourceDelete(UPLOAD_ACCOUNT, newer, { filePath: `/safe/uploads/${newer}.csv` });
    await runPeriodicStorageReconciliation();

    const afterRetry = await storageRuntime().sources.listPendingSourceDeletes(UPLOAD_ACCOUNT);
    expect(afterRetry.map((intent) => intent.sourceId)).toEqual([failing]);
    expect(afterRetry[0]).toMatchObject({ attempts: 2, lastError: "SOURCE_CLEANUP_RETRY" });
  });
});

describe("startup source-delete snapshot repair", () => {
  it(
    "pages one frozen snapshot once, excludes late inserts, and never pins the cursor",
    { timeout: 60_000 },
    async () => {
      const base = 1_758_000_000_000;
      const sourceIds = Array.from({ length: 250 }, () => randomUUID());
      await seedPendingSourceDeletes(
        UPLOAD_ACCOUNT,
        sourceIds.map((sourceId, index) => ({
          sourceId,
          name: `snap_source_${index}`,
          filePath: `/safe/uploads/snap-${index}.csv`,
          createdAt: new Date(base + index * 1_000).toISOString(),
        }))
      );
      const failing = sourceIds[3]!;
      const deletedCaptured = sourceIds[249]!;
      const insertedLate = randomUUID();
      removeArtifactMock.mockImplementation(async ({ sourceId }) => sourceId !== failing);

      const store = storageRuntime().sources;
      const originalCapture = store.capturePendingSourceDeleteSnapshot.bind(store);
      let readCount = 0;
      const cursors: number[] = [];
      vi.spyOn(store, "capturePendingSourceDeleteSnapshot").mockImplementation(async () => {
        const snapshot = await originalCapture();
        return {
          read: async (afterOrdinal, limit) => {
            const rows = await snapshot.read(afterOrdinal, limit);
            readCount += 1;
            cursors.push(afterOrdinal);
            if (readCount === 2) {
              await seedPendingSourceDelete(UPLOAD_ACCOUNT, insertedLate, {
                name: "inserted_late",
                filePath: `/safe/uploads/${insertedLate}.csv`,
              });
              await storageRuntime().ledger.run("DELETE FROM pending_source_deletes WHERE source_id=?", [
                deletedCaptured,
              ]);
            }
            return rows;
          },
          close: () => snapshot.close(),
        };
      });

      await expect(repairPendingSourceDeletesAtStartup()).resolves.toBe(250 - 2);

      // The frozen pass attempted every surviving captured intent exactly once.
      expect(readCount).toBe(4);
      expect(cursors).toEqual([0, 100, 200, 250]);
      const remaining = await storageRuntime().sources.listPendingSourceDeletes(UPLOAD_ACCOUNT);
      expect(remaining.map((intent) => intent.sourceId).sort()).toEqual([failing, insertedLate].sort());
      expect(remaining.find((intent) => intent.sourceId === failing)).toMatchObject({
        attempts: 1,
        lastError: "SOURCE_CLEANUP_RETRY",
      });
      expect(remaining.find((intent) => intent.sourceId === insertedLate)).toMatchObject({ attempts: 0 });
      await expect(snapshotTablePresence()).resolves.toBe(false);

      // A subsequent periodic page observes both the late insert and the retry.
      await runPeriodicStorageReconciliation();
      const afterPeriodic = await storageRuntime().sources.listPendingSourceDeletes(UPLOAD_ACCOUNT);
      expect(afterPeriodic.map((intent) => intent.sourceId)).toEqual([failing]);
      expect(afterPeriodic[0]).toMatchObject({ attempts: 2 });
    }
  );

  it(
    "drops the TEMP snapshot when a page read throws mid-pass and leftovers stay durable",
    { timeout: 30_000 },
    async () => {
      await seedPendingSourceDeletes(
        UPLOAD_ACCOUNT,
        Array.from({ length: 150 }, (_unused, index) => ({
          sourceId: randomUUID(),
          name: `abort_source_${index}`,
          filePath: `/safe/uploads/abort-${index}.csv`,
        }))
      );
      const store = storageRuntime().sources;
      const originalCapture = store.capturePendingSourceDeleteSnapshot.bind(store);
      let readCount = 0;
      vi.spyOn(store, "capturePendingSourceDeleteSnapshot").mockImplementation(async () => {
        const snapshot = await originalCapture();
        return {
          read: async (afterOrdinal, limit) => {
            readCount += 1;
            if (readCount === 2) throw new Error("simulated snapshot page read failure");
            return snapshot.read(afterOrdinal, limit);
          },
          close: () => snapshot.close(),
        };
      });

      await expect(repairPendingSourceDeletesAtStartup()).rejects.toThrow("simulated snapshot page read failure");

      expect(await snapshotTablePresence()).toBe(false);
      await expect(storageRuntime().sources.listPendingSourceDeletesAcrossAccounts(200)).resolves.toHaveLength(50);
      // The durable intents remain periodically retryable after the failed pass.
      await runPeriodicStorageReconciliation();
      await expect(storageRuntime().sources.listPendingSourceDeletesAcrossAccounts(200)).resolves.toHaveLength(0);
    }
  );
});

describe("typed connector-refresh reconciliation", () => {
  const REFRESH_PAGE_LIMIT = 20;

  interface SeededRefreshRow {
    readonly accountId: string;
    readonly sourceId: string;
    readonly connectorId: string;
    readonly name: string;
    readonly candidate: string;
    readonly identity: {
      accountId: string;
      sourceId: string;
      connectorId: string;
      generation: number;
      refreshVersion: string;
    };
  }

  async function seedRefreshRow(options: {
    account: string;
    idPrefix: string;
    index: number;
    phase: "activating" | "cleanup_pending";
    updatedAt: string;
    activationPrevious?: string;
    cleanup?: string;
  }): Promise<SeededRefreshRow> {
    const runtime = storageRuntime();
    const sourceId = `${options.idPrefix}${String(options.index).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(
      0,
      36
    );
    const connectorId = randomUUID();
    const name = `refresh_${options.idPrefix.slice(0, 1)}${String(options.index).padStart(4, "0")}`.slice(0, 63);
    const candidate = `/safe/cache/${name}-candidate.csv`;
    await runtime.ledger.run(
      `INSERT INTO connectors (id,account_id,name,type,config,target_table,sync_status)
       VALUES (?,?,?,'url_csv','{}',?,'idle')`,
      [connectorId, options.account, `Feed ${name}`, name]
    );
    await runtime.ledger.run(
      `INSERT INTO sources (id,account_id,name,kind,connector,display_name,file_path,status,meta,ready_generation)
       VALUES (?,?,?,'tabular',?,?,?,?,?,1)`,
      [
        sourceId,
        options.account,
        name,
        connectorId,
        `Feed ${name}`,
        options.phase === "cleanup_pending" ? candidate : `/safe/cache/${name}-previous.csv`,
        options.phase === "cleanup_pending" ? "ready" : "index",
        "{}",
      ]
    );
    await runtime.ledger.run(
      `INSERT INTO connector_refresh_states
         (source_id,account_id,connector_id,generation,refresh_version,phase,
          candidate_location,activation_previous_location,cleanup_previous_location,
          created_at,updated_at)
       VALUES (?,?,?,1,?,?,?,?,?,?,?)`,
      [
        sourceId,
        options.account,
        connectorId,
        `version-${options.idPrefix}-${options.index}`,
        options.phase,
        candidate,
        options.activationPrevious ?? null,
        options.cleanup ?? null,
        options.updatedAt,
        options.updatedAt,
      ]
    );
    return {
      accountId: options.account,
      sourceId,
      connectorId,
      name,
      candidate,
      identity: {
        accountId: options.account,
        sourceId,
        connectorId,
        generation: 1,
        refreshVersion: `version-${options.idPrefix}-${options.index}`,
      },
    };
  }

  async function seedActivatingFailures(
    count: number,
    idPrefix: string,
    updatedAt: string
  ): Promise<SeededRefreshRow[]> {
    const rows: SeededRefreshRow[] = [];
    for (let index = 0; index < count; index += 1) {
      // `activationPrevious` never matches, so every repair pass reaches the
      // durable third-location invariant failure for this row.
      rows.push(
        await seedRefreshRow({
          account: CONNECTOR_ACCOUNT,
          idPrefix,
          index,
          phase: "activating",
          updatedAt,
          activationPrevious: "/safe/cache/never-active.csv",
        })
      );
    }
    return rows;
  }

  it("runs the first three queues while the startup typed pass is in flight and reads no refresh rows", async () => {
    await storageRuntime().sources.createSource(UPLOAD_ACCOUNT, {
      id: randomUUID(),
      name: "inflight_source",
      kind: "tabular",
      displayName: "In-flight.csv",
      filePath: "/safe/uploads/inflight.csv",
      status: "ready",
      readyGeneration: 1,
    });
    const registration = deferred<Record<string, unknown>>();
    registerMock.mockReturnValueOnce(registration.promise);

    const restoring = restoreDatasets();
    await vi.waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));

    const runtime = storageRuntime();
    const refreshSpy = vi.spyOn(runtime.connectorRefresh, "listRepairableStates");
    const drainSpy = vi.spyOn(runtime.vectorLifecycle, "drainPendingVectorOperations");
    const crossAccountSpy = vi.spyOn(runtime.sources, "listPendingSourceDeletesAcrossAccounts");
    const cleanupSpy = vi.spyOn(runtime.ingestion, "listDatasetCleanupJobs");

    await runPeriodicStorageReconciliation();
    // First three queues run; the typed fourth queue is not even read.
    expect(drainSpy).toHaveBeenCalledWith(100);
    expect(crossAccountSpy).toHaveBeenCalledWith(100);
    expect(cleanupSpy).toHaveBeenCalledWith({ accountId: undefined, name: undefined, limit: 20 });
    expect(refreshSpy).not.toHaveBeenCalled();

    registration.resolve({});
    await restoring;

    // Settled: all four bounded queues run, exactly one refresh page.
    refreshSpy.mockClear();
    await runPeriodicStorageReconciliation();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith(REFRESH_PAGE_LIMIT);
  });

  it("gates the fourth queue again across stop/start until the new runtime settles", async () => {
    await restoreDatasets();
    const runtime = storageRuntime();
    const refreshSpy = vi.spyOn(runtime.connectorRefresh, "listRepairableStates");
    await runPeriodicStorageReconciliation();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    await stopIngestionWorkers();
    await runPeriodicStorageReconciliation();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    await startIngestionWorkers();
    await runPeriodicStorageReconciliation();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    await restoreDatasets();
    await runPeriodicStorageReconciliation();
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });

  it(
    "moves a complete failing refresh page behind untouched work under fixed and backward clocks",
    { timeout: 30_000 },
    async () => {
      const pinned = "2026-09-04T00:00:00.000Z";
      // Settle the fourth-queue gate with an empty registry pass before the
      // deterministic fake-clock section.
      await restoreDatasets();
      // idPrefix "a..." sorts before "f...", so the equal-timestamp page is
      // taken by the failing rows first.
      const failing = await seedActivatingFailures(20, "a000000", pinned);
      const untouched = await seedActivatingFailures(5, "f000000", pinned);

      vi.useFakeTimers({ now: new Date("2026-09-05T12:00:00.000Z") });
      try {
        await runPeriodicStorageReconciliation();
        for (const row of failing) {
          await expect(storageRuntime().connectorRefresh.getState(row.accountId, row.sourceId)).resolves.toMatchObject({
            attempts: 1,
            updatedAt: "2026-09-05T12:00:00.000Z",
          });
        }
        for (const row of untouched) {
          await expect(storageRuntime().connectorRefresh.getState(row.accountId, row.sourceId)).resolves.toMatchObject({
            attempts: 0,
            updatedAt: pinned,
          });
        }

        // A backward clock still advances the touched rows strictly forward,
        // and the attempt-zero untouched work is selected before any
        // attempts-1 row even though its timestamps are older than the
        // failed page's touched timestamps.
        vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
        await runPeriodicStorageReconciliation();
        for (const row of untouched) {
          const state = await storageRuntime().connectorRefresh.getState(row.accountId, row.sourceId);
          expect(state).toMatchObject({ attempts: 1 });
          expect(state!.updatedAt).toBe("2026-09-04T00:00:00.001Z");
        }
        const stillDurable = await storageRuntime().connectorRefresh.getState(
          failing[19]!.accountId,
          failing[19]!.sourceId
        );
        expect(stillDurable!.attempts).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("isolates one failing cleanup row from its valid peers and logs only aggregate codes", async () => {
    const pinned = "2026-09-04T00:00:00.000Z";
    const good: SeededRefreshRow[] = [];
    for (const index of [0, 1]) {
      good.push(
        await seedRefreshRow({
          account: CONNECTOR_ACCOUNT,
          idPrefix: "b000000",
          index,
          phase: "cleanup_pending",
          updatedAt: pinned,
          cleanup: `/safe/cache/good-${index}-retired.csv`,
        })
      );
    }
    const bad = await seedRefreshRow({
      account: CONNECTOR_ACCOUNT,
      idPrefix: "c000000",
      index: 9,
      phase: "cleanup_pending",
      updatedAt: pinned,
      cleanup: "/safe/cache/bad-retired.csv",
    });
    cleanupMock.mockImplementation(async (_accountId, _name, location) => {
      if (location === "/safe/cache/bad-retired.csv") throw new Error("simulated cleanup failure");
      return { status: "deleted" };
    });
    const warnSpy = vi.spyOn(appLog, "warn");

    // The startup typed snapshot pass attempts each captured row once.
    await restoreDatasets();

    for (const row of good) {
      await expect(storageRuntime().connectorRefresh.getState(row.accountId, row.sourceId)).resolves.toBeUndefined();
    }
    await expect(storageRuntime().connectorRefresh.getState(bad.accountId, bad.sourceId)).resolves.toMatchObject({
      phase: "cleanup_pending",
      attempts: 1,
      cleanupPreviousLocation: "/safe/cache/bad-retired.csv",
    });
    // Aggregate logging only: stable codes/counts, never IDs, paths, or URLs.
    for (const call of warnSpy.mock.calls) {
      const text = JSON.stringify(call[0] ?? {});
      expect(text).not.toContain(CONNECTOR_ACCOUNT);
      expect(text).not.toContain(bad.sourceId);
      expect(text).not.toContain("bad-retired");
    }
    expect(
      warnSpy.mock.calls.some(
        (call) => (call[0] as { error_code?: string })?.error_code === "CONNECTOR_REFRESH_STARTUP_RETRYING"
      )
    ).toBe(true);
    warnSpy.mockRestore();

    // Periodic retry keeps failing the bad row while it stays durable.
    await runPeriodicStorageReconciliation();
    await expect(storageRuntime().connectorRefresh.getState(bad.accountId, bad.sourceId)).resolves.toMatchObject({
      attempts: 2,
    });
  });

  it(
    "attempts every captured startup ordinal at most once and never reuses a deleted ordinal",
    { timeout: 30_000 },
    async () => {
      const pinned = "2026-09-04T00:00:00.000Z";
      const rows = await seedActivatingFailures(45, "d000000", pinned);
      const capturedMax = await storageRuntime().connectorRefresh.captureMaxRepairOrdinal();
      expect(capturedMax).toBe(45);

      const runtime = storageRuntime();
      const originalPage = runtime.connectorRefresh.listRepairableStatesUpTo.bind(runtime.connectorRefresh);
      let reads = 0;
      const cursors: number[] = [];
      let mutated = false;
      vi.spyOn(runtime.connectorRefresh, "listRepairableStatesUpTo").mockImplementation(async (max, after, limit) => {
        reads += 1;
        cursors.push(after);
        const page = await originalPage(max, after, limit);
        if (!mutated) {
          mutated = true;
          // A row created during the pass has a larger ordinal: it waits for
          // periodic repair. A captured high row is deleted: the pass must
          // simply never attempt it and the ordinal is never reused.
          await seedRefreshRow({
            account: CONNECTOR_ACCOUNT,
            idPrefix: "e000000",
            index: 99,
            phase: "activating",
            updatedAt: "2026-09-04T00:00:00.000Z",
            activationPrevious: "/safe/cache/never-active.csv",
          });
          await runtime.ledger.run(`DELETE FROM connector_refresh_states WHERE source_id LIKE 'd0000000044%'`);
        }
        return page;
      });

      await restoreDatasets();

      // The row inserted mid-pass waits for periodic repair untouched.
      await expect(
        runtime.ledger.get<{ attempts: bigint }>(
          `SELECT attempts FROM connector_refresh_states WHERE refresh_version='version-e000000-99'`
        )
      ).resolves.toEqual({ attempts: 0n });

      // More than two ordinal pages with a non-starving finite keyset cursor.
      expect(reads).toBe(3);
      expect(cursors).toEqual([0, 20, 40]);
      let attempted = 0;
      for (const row of rows.slice(0, 44)) {
        const state = await runtime.connectorRefresh.getState(row.accountId, row.sourceId);
        if (state && state.attempts === 1) attempted += 1;
      }
      expect(attempted).toBe(44);
      // The deleted captured row is gone and its ordinal is not reused: a
      // fresh insert continues strictly above the captured maximum.
      const late = await seedRefreshRow({
        account: CONNECTOR_ACCOUNT,
        idPrefix: "e000000",
        index: 98,
        phase: "activating",
        updatedAt: pinned,
        activationPrevious: "/safe/cache/never-active.csv",
      });
      const lateState = await runtime.connectorRefresh.getState(late.accountId, late.sourceId);
      expect(lateState!.repairOrdinal).toBeGreaterThan(45);
    }
  );
});

describe("worker lifecycle ownership", () => {
  const emptyDrain = Object.freeze({ repaired_vectors: 0, repaired_deletes: 0, failed_operations: 0 });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  // Empty durable queues make the startup wake deterministic: exactly two
  // ingestion and two connector-prepare claims, each settling immediately.
  // Waiting for that complete barrier (then a quiet boundary) makes any
  // later claim difference attributable solely to the tested wake.
  async function settleStartupClaims(claimSpy: { mock: { calls: readonly unknown[] } }): Promise<number> {
    await vi.waitFor(() => expect(claimSpy).toHaveBeenCalledTimes(4));
    let previous = -1;
    let current = claimSpy.mock.calls.length;
    while (current !== previous) {
      previous = current;
      await tick();
      current = claimSpy.mock.calls.length;
    }
    return current;
  }

  it("coalesces overlapping periodic triggers within one epoch", async () => {
    await startIngestionWorkers();
    const runtime = storageRuntime();
    const gate = deferred<typeof emptyDrain>();
    let settled = false;
    const drainSpy = vi.spyOn(runtime.vectorLifecycle, "drainPendingVectorOperations").mockImplementation(async () => {
      await gate.promise;
      settled = true;
      return emptyDrain;
    });

    triggerStorageReconciliation();
    triggerStorageReconciliation();
    await vi.waitFor(() => expect(drainSpy).toHaveBeenCalledTimes(1));

    gate.resolve(emptyDrain);
    await vi.waitFor(() => expect(settled).toBe(true));
    // The cleared slot lets the next trigger start a fresh pass.
    triggerStorageReconciliation();
    await vi.waitFor(() => expect(drainSpy).toHaveBeenCalledTimes(2));
    gate.resolve(emptyDrain);
  });

  it("holds stop until the deferred reconciliation finishes and a wake during stop does no work", async () => {
    const runtime = storageRuntime();
    const claimSpy = vi.spyOn(runtime.ingestion, "claimNext");
    await startIngestionWorkers();
    const gate = deferred<typeof emptyDrain>();
    const drainSpy = vi
      .spyOn(runtime.vectorLifecycle, "drainPendingVectorOperations")
      .mockImplementation(() => gate.promise);
    const claimsAtStop = await settleStartupClaims(claimSpy);

    triggerStorageReconciliation();
    await vi.waitFor(() => expect(drainSpy).toHaveBeenCalledTimes(1));

    try {
      const stopped = stopIngestionWorkers();
      let stopSettled = false;
      void stopped.finally(() => {
        stopSettled = true;
      });
      wakeIngestionDuringStop();
      await tick();
      expect(stopSettled).toBe(false);
      expect(claimSpy.mock.calls.length).toBe(claimsAtStop);

      gate.resolve(emptyDrain);
      await stopped;
      expect(stopSettled).toBe(true);
      await tick();
      expect(claimSpy.mock.calls.length).toBe(claimsAtStop);
      expect(drainSpy.mock.calls.length).toBe(1);
    } finally {
      gate.resolve(emptyDrain);
    }
  });

  it("drains lease recovery on stop and the dead epoch recovers nothing further", async () => {
    const runtime = storageRuntime();
    const gate = deferred<readonly IngestionJob[]>();
    const claimSpy = vi.spyOn(runtime.ingestion, "claimNext");
    await startIngestionWorkers();
    const preparingSpy = vi.spyOn(runtime.ingestion, "recoverPreparingLeases");
    const runningSpy = vi.spyOn(runtime.ingestion, "recoverRunningLeases").mockImplementation(() => gate.promise);
    const claimsAtStop = await settleStartupClaims(claimSpy);
    const preparingAtStop = preparingSpy.mock.calls.length;

    triggerLeaseRecovery();
    await vi.waitFor(() => expect(runningSpy).toHaveBeenCalledTimes(1));

    try {
      const stopped = stopIngestionWorkers();
      let stopSettled = false;
      void stopped.finally(() => {
        stopSettled = true;
      });
      await tick();
      expect(stopSettled).toBe(false);

      gate.resolve(Object.freeze([]));
      await stopped;
      expect(stopSettled).toBe(true);
      // The invalidated old epoch prevented the second recovery call and both wakes.
      expect(preparingSpy.mock.calls.length).toBe(preparingAtStop);
      await tick();
      expect(claimSpy.mock.calls.length).toBe(claimsAtStop);
    } finally {
      gate.resolve(Object.freeze([]));
    }
  });

  it("lets one in-flight prepare claim finish but blocks the inner loop and repump after stop", async () => {
    const runtime = storageRuntime();
    const claimSpy = vi.spyOn(runtime.ingestion, "claimNext");
    const prepareClaims = () => claimSpy.mock.calls.filter(([status]) => status === "preparing").length;
    await startIngestionWorkers();
    // The startup claims have fully settled; a fresh wake installs the next
    // prepare pump. The prepare pump has no abort signal, so only the epoch
    // gate can stop its workers.
    await settleStartupClaims(claimSpy);
    const preparesBeforeWake = prepareClaims();
    const gate = deferred<undefined>();
    claimSpy.mockImplementation(() => gate.promise);
    wakeConnectorPrepareWorkers();
    // The first worker's claim is in flight; the second worker waits on the
    // migration coordinator's source-mutation gate behind it.
    await vi.waitFor(() => expect(prepareClaims()).toBe(preparesBeforeWake + 1));

    try {
      const stopped = stopIngestionWorkers();
      let stopSettled = false;
      void stopped.finally(() => {
        stopSettled = true;
      });
      wakeIngestionDuringStop();
      await tick();
      expect(stopSettled).toBe(false);
      expect(prepareClaims()).toBe(preparesBeforeWake + 1);

      gate.resolve(undefined);
      await stopped;
      expect(stopSettled).toBe(true);
      // Both already-started claims settle, but the inner-loop `while` and
      // the `finally` repump see the dead epoch and claim nothing further.
      await vi.waitFor(() => expect(prepareClaims()).toBe(preparesBeforeWake + 2));
      await tick();
      await tick();
      expect(prepareClaims()).toBe(preparesBeforeWake + 2);
    } finally {
      gate.resolve(undefined);
    }
  });

  it("restarts under a fresh epoch after a settled stop and drains queued work once", async () => {
    await startIngestionWorkers();
    await stopIngestionWorkers();
    const runtime = storageRuntime();
    const claimSpy = vi.spyOn(runtime.ingestion, "claimNext").mockResolvedValue(undefined);

    await startIngestionWorkers();
    // The fresh epoch drains the empty ingestion and prepare queues exactly
    // once (two workers each); no stale finally from the dead epoch can add
    // or remove a claim.
    await vi.waitFor(() => expect(claimSpy).toHaveBeenCalledTimes(4));
    await tick();
    expect(claimSpy).toHaveBeenCalledTimes(4);
    expect(await stopIngestionWorkers()).toBeUndefined();
  });
});

function wakeIngestionDuringStop(): void {
  wakeIngestionWorkers();
  wakeConnectorPrepareWorkers();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
