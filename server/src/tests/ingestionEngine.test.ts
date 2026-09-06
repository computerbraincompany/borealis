import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorRefreshStore } from "../db/stores/connectorRefreshStore.js";
import { SqliteIngestionStore } from "../db/stores/ingestionStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import { RemoteEgressConsentRequiredError } from "../egressPolicy.js";
import type { IngestionEmbeddingSession } from "../ingestionEmbedding.js";
import {
  IngestionExecutor,
  IngestionWorker,
  processDurableDatasetCleanupJob,
  type IngestionDataOperations,
} from "../ingestionEngine.js";
import { LanceVectorIndex } from "../vector/lance.js";
import { IngestionVectorLifecycle } from "../vector/lifecycle.js";

interface Resource {
  directory: string;
  ledger: SqliteLedger;
  vectors: LanceVectorIndex;
}

const resources: Resource[] = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => {
      await resource.vectors.close();
      await resource.ledger.close();
      await fs.rm(resource.directory, { recursive: true, force: true });
    })
  );
});

async function setup(
  embed: (texts: string[]) => Promise<number[][]>,
  createEmbeddingSession: (accountId: string) => Promise<IngestionEmbeddingSession> = async () => embed
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingestion-engine-test-"));
  const ledger = await openSqliteLedger({ path: path.join(directory, "ledger.sqlite") });
  const vectors = await LanceVectorIndex.open({ directory: path.join(directory, "lance"), dimension: 3 });
  resources.push({ directory, ledger, vectors });
  const sourceStore = new SourceStore(ledger);
  const ingestionStore = new SqliteIngestionStore(ledger);
  const refreshStore = new ConnectorRefreshStore(ledger);
  const lifecycle = new IngestionVectorLifecycle(ingestionStore, vectors);
  const artifact = path.join(directory, "document.txt");
  await fs.writeFile(artifact, "content");
  const data: IngestionDataOperations = {
    registerDataset: vi.fn(async () => ({})),
    extractDataset: vi.fn(async () => ({})),
    extractPreparedDataset: vi.fn(async () => ({})),
    activateDatasetRefresh: vi.fn(async () => ({})),
    deactivateDatasetLocation: vi.fn(async () => undefined),
    cleanupDatasetCache: vi.fn(async () => undefined),
    currentDatasetLocation: vi.fn(async () => null),
  };
  const executor = new IngestionExecutor({
    store: ingestionStore,
    lifecycle,
    refresh: refreshStore,
    data,
    embeddingDimension: 3,
    createEmbeddingSession,
    resolveArtifact: vi.fn(async ({ filePath }) => (filePath === artifact ? artifact : undefined)),
    isTabular: () => false,
    extractText: vi.fn(async () => "alpha beta gamma"),
    chunkText: (text) => [text],
    datasetRegistration: () => ({}),
    datasetPreviewText: () => "preview",
  });
  const worker = new IngestionWorker({
    store: ingestionStore,
    sources: sourceStore,
    lifecycle,
    refresh: refreshStore,
    ingest: (input) => executor.ingest(input),
  });
  return {
    directory,
    ledger,
    vectors,
    sourceStore,
    ingestionStore,
    refreshStore,
    lifecycle,
    artifact,
    data,
    executor,
    worker,
  };
}

async function seedSource(
  ledger: SqliteLedger,
  sourceStore: SourceStore,
  artifact: string
): Promise<{ accountId: string; sourceId: string }> {
  const accountId = randomUUID();
  const sourceId = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    accountId,
    `${accountId}@example.test`,
    "hash",
  ]);
  await sourceStore.createSource(accountId, {
    id: sourceId,
    name: "document",
    kind: "document",
    displayName: "document.txt",
    filePath: artifact,
    mime: "text/plain",
    status: "index",
  });
  return { accountId, sourceId };
}

describe("IngestionExecutor and worker", () => {
  it("claims, incrementally indexes, and atomically publishes one exact generation", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const { accountId, sourceId } = await seedSource(runtime.ledger, runtime.sourceStore, runtime.artifact);
    await expect(runtime.ingestionStore.reserveJob(accountId, sourceId)).resolves.toBe(1);

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    await expect(runtime.worker.processOne()).resolves.toBe(false);
    await expect(runtime.ingestionStore.getJob(accountId, sourceId)).resolves.toMatchObject({
      generation: 1,
      status: "done",
      leaseToken: null,
    });
    await expect(runtime.sourceStore.getSource(accountId, sourceId)).resolves.toMatchObject({
      status: "ready",
      readyGeneration: 1,
    });
    const chunks = await runtime.ledger.all<{ id: string; content: string; generation: bigint }>(
      "SELECT id,content,generation FROM chunks WHERE source_id=?",
      [sourceId]
    );
    expect(chunks).toMatchObject([{ content: "alpha beta gamma", generation: 1n }]);
    await expect(runtime.vectors.hasAll([chunks[0]!.id], sourceId, 1)).resolves.toBe(true);
  });

  it("preserves staged UUIDs through a transient retry of the same generation", async () => {
    let attempt = 0;
    const runtime = await setup(async (texts) => {
      attempt += 1;
      if (attempt === 1) throw new Error("model temporarily unavailable");
      return texts.map(() => [0, 1, 0]);
    });
    const { accountId, sourceId } = await seedSource(runtime.ledger, runtime.sourceStore, runtime.artifact);
    await runtime.ingestionStore.reserveJob(accountId, sourceId);

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    const staged = await runtime.ledger.get<{ chunk_id: string }>(
      "SELECT chunk_id FROM ingestion_chunk_staging WHERE source_id=? AND generation=1",
      [sourceId]
    );
    expect(staged?.chunk_id).toMatch(/^[0-9a-f-]{36}$/);
    await runtime.ledger.run("UPDATE ingestion_jobs SET available_at=? WHERE source_id=?", [
      new Date(0).toISOString(),
      sourceId,
    ]);

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    await expect(runtime.ledger.get("SELECT id FROM chunks WHERE id=?", [staged!.chunk_id])).resolves.toMatchObject({
      id: staged!.chunk_id,
    });
    await expect(runtime.ingestionStore.getJob(accountId, sourceId)).resolves.toMatchObject({ status: "done" });
  });

  it("terminalizes an invalid embedding response without leaving staged text or vectors", async () => {
    const runtime = await setup(async () => [[Number.NaN, 0, 0]]);
    const { accountId, sourceId } = await seedSource(runtime.ledger, runtime.sourceStore, runtime.artifact);
    await runtime.ingestionStore.reserveJob(accountId, sourceId);

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    await expect(runtime.ingestionStore.getJob(accountId, sourceId)).resolves.toMatchObject({
      status: "error",
      lastError: "EMBEDDING_INVALID_RESPONSE",
    });
    await expect(runtime.sourceStore.getSource(accountId, sourceId)).resolves.toMatchObject({
      status: "error",
      meta: { error_code: "EMBEDDING_INVALID_RESPONSE" },
    });
    await expect(
      runtime.ledger.get("SELECT chunk_id FROM ingestion_chunk_staging WHERE source_id=?", [sourceId])
    ).resolves.toBeUndefined();
    await expect(runtime.vectors.scanRows()).resolves.toEqual([]);
  });

  it.each([
    ["float32 overflow", [1e100, 1, 0]],
    ["float32 underflow to an all-zero vector", [1e-100, 0, 0]],
    ["float32 norm underflow", [1e-23, 0, 0]],
    ["float32 norm overflow", [1e20, 0, 0]],
  ])("terminalizes %s as an invalid embedding response", async (_label, vector) => {
    const runtime = await setup(async () => [vector]);
    const { accountId, sourceId } = await seedSource(runtime.ledger, runtime.sourceStore, runtime.artifact);
    await runtime.ingestionStore.reserveJob(accountId, sourceId);

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    await expect(runtime.ingestionStore.getJob(accountId, sourceId)).resolves.toMatchObject({
      status: "error",
      lastError: "EMBEDDING_INVALID_RESPONSE",
    });
    await expect(runtime.vectors.scanRows()).resolves.toEqual([]);
  });

  it("fails a durable job closed when worker-time remote egress is not acknowledged", async () => {
    const transport = vi.fn(async () => [[1, 0, 0]]);
    const runtime = await setup(transport, async () => {
      throw new RemoteEgressConsentRequiredError();
    });
    const { accountId, sourceId } = await seedSource(runtime.ledger, runtime.sourceStore, runtime.artifact);
    await runtime.ingestionStore.reserveJob(accountId, sourceId);

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    expect(transport).not.toHaveBeenCalled();
    await expect(runtime.ingestionStore.getJob(accountId, sourceId)).resolves.toMatchObject({
      status: "error",
      lastError: "REMOTE_EGRESS_CONSENT_REQUIRED",
    });
    await expect(runtime.sourceStore.getSource(accountId, sourceId)).resolves.toMatchObject({
      status: "error",
      meta: { error_code: "REMOTE_EGRESS_CONSENT_REQUIRED" },
    });
    await expect(runtime.vectors.scanRows()).resolves.toEqual([]);
  });

  it("fails closed before extraction when the UUID-scoped artifact cannot be proven", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const { accountId, sourceId } = await seedSource(runtime.ledger, runtime.sourceStore, runtime.artifact);
    await runtime.ingestionStore.reserveJob(accountId, sourceId);
    await runtime.ledger.run("UPDATE sources SET file_path=? WHERE id=?", [
      path.join(runtime.directory, "outside.txt"),
      sourceId,
    ]);

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    await expect(runtime.ingestionStore.getJob(accountId, sourceId)).resolves.toMatchObject({
      status: "error",
      lastError: "SOURCE_UNAVAILABLE",
    });
    await expect(runtime.vectors.scanRows()).resolves.toEqual([]);
  });

  it("heartbeats the exact lease while a long ingestion is running", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const { accountId, sourceId } = await seedSource(runtime.ledger, runtime.sourceStore, runtime.artifact);
    await runtime.ingestionStore.reserveJob(accountId, sourceId);
    const heartbeat = vi.spyOn(runtime.ingestionStore, "heartbeat");
    const worker = new IngestionWorker({
      store: runtime.ingestionStore,
      sources: runtime.sourceStore,
      lifecycle: runtime.lifecycle,
      refresh: runtime.refreshStore,
      heartbeatIntervalMs: 5,
      ingest: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await runtime.executor.ingest(input);
      },
    });

    await expect(worker.processOne()).resolves.toBe(true);
    expect(heartbeat).toHaveBeenCalledWith(accountId, sourceId, 1, expect.any(String));
    await expect(runtime.ingestionStore.getJob(accountId, sourceId)).resolves.toMatchObject({ status: "done" });
  });

  it("coalesces exact cleanup workers and never replays stale completed authority", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const { accountId } = await seedSource(runtime.ledger, runtime.sourceStore, runtime.artifact);
    const job = Object.freeze({
      accountId,
      name: "document",
      location: path.join(runtime.directory, "retired.csv"),
      attempts: 0,
    });
    await runtime.ledger.run(
      `INSERT INTO dataset_cache_cleanup_jobs (account_id,name,location)
       VALUES (?,?,?)`,
      [job.accountId, job.name, job.location]
    );
    const deactivation = deferred<void>();
    const deactivate = vi.mocked(runtime.data.deactivateDatasetLocation);
    const cleanup = vi.mocked(runtime.data.cleanupDatasetCache);
    deactivate.mockImplementation(async () => deactivation.promise);

    const first = processDurableDatasetCleanupJob(runtime.ingestionStore, runtime.data, job);
    const concurrent = processDurableDatasetCleanupJob(runtime.ingestionStore, runtime.data, job);
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    deactivation.resolve(undefined);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(runtime.ingestionStore.getDatasetCleanupJob(job.accountId, job.name, job.location)).resolves.toBe(
      undefined
    );

    await expect(processDurableDatasetCleanupJob(runtime.ingestionStore, runtime.data, job)).resolves.toBe(false);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

interface RefreshContext {
  readonly accountId: string;
  readonly sourceId: string;
  readonly connectorId: string;
  readonly refreshVersion: string;
  readonly candidate: string;
  readonly oldLocation: string;
  readonly generation: number;
}

async function seedRefreshJob(
  runtime: Awaited<ReturnType<typeof setup>>,
  options: {
    phase: "prepared" | "activating";
    activationPreviousLocation?: string | null;
    cleanupPreviousLocation?: string | null;
  }
): Promise<RefreshContext> {
  const resolve = (value: string | null | undefined): string | null => (value === "old" ? null : (value ?? null));
  const accountId = randomUUID();
  const sourceId = randomUUID();
  const connectorId = randomUUID();
  const refreshVersion = randomUUID();
  const oldLocation = path.join(runtime.directory, "previous-active.csv");
  await fs.writeFile(oldLocation, "amount\n1\n");
  await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    accountId,
    `${accountId}@example.test`,
    "hash",
  ]);
  await runtime.ledger.run(
    `INSERT INTO connectors (id,account_id,name,type,config,target_table,sync_status)
     VALUES (?,?,?,'url_csv','{}','feed_x','indexing')`,
    [connectorId, accountId, "Feed"]
  );
  await runtime.ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,connector,display_name,file_path,url,mime,status,meta,ready_generation)
     VALUES (?,?,?,'tabular',?,?,?,?,?,'index',?,1)`,
    [sourceId, accountId, "feed_x", connectorId, "Feed", oldLocation, "https://example.test/feed.csv", "text/csv", "{}"]
  );
  await runtime.ingestionStore.reserveJob(accountId, sourceId);
  await runtime.ledger.run(
    `INSERT INTO connector_refresh_states
       (source_id,account_id,connector_id,generation,refresh_version,phase,
        candidate_location,activation_previous_location,cleanup_previous_location)
     VALUES (?,?,?,1,?,?,?,?,?)`,
    [
      sourceId,
      accountId,
      connectorId,
      refreshVersion,
      options.phase,
      runtime.artifact,
      options.activationPreviousLocation === "old" ? oldLocation : resolve(options.activationPreviousLocation),
      options.cleanupPreviousLocation === "old" ? oldLocation : resolve(options.cleanupPreviousLocation),
    ]
  );
  return { accountId, sourceId, connectorId, refreshVersion, candidate: runtime.artifact, oldLocation, generation: 1 };
}

describe("connector refresh protocol in the executor", () => {
  it("drives prepared→activating→activated with the exact expected-previous CAS and typed cleanup", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const ctx = await seedRefreshJob(runtime, {
      phase: "prepared",
      activationPreviousLocation: "old",
      cleanupPreviousLocation: "old",
    });
    const oldLocation = ctx.oldLocation;
    const activate = vi.mocked(runtime.data.activateDatasetRefresh);
    activate.mockImplementation(async (_account, _name, version, _url, _original, _format, previous) => {
      // The immutable-cache CAS receives the exact expected previous location.
      expect(previous).toBe(oldLocation);
      return { version, location: runtime.artifact };
    });
    const currentLocation = vi.mocked(runtime.data.currentDatasetLocation);

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    // A clean prepared→activated flow never needs the current-location probe.
    expect(currentLocation).not.toHaveBeenCalled();
    await expect(runtime.refreshStore.getState(ctx.accountId, ctx.sourceId)).resolves.toBeUndefined();
    await expect(runtime.ingestionStore.getJob(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      status: "done",
    });
    await expect(runtime.sourceStore.getSource(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      status: "ready",
      filePath: runtime.artifact,
      readyGeneration: 1,
      meta: {},
    });
    // The engine ran the exact old-location cleanup and confirmed it, so the
    // typed row completed; no protocol metadata ever appeared in `meta`.
    expect(vi.mocked(runtime.data.deactivateDatasetLocation)).toHaveBeenCalledWith(
      ctx.accountId,
      "feed_x",
      oldLocation
    );
    expect(vi.mocked(runtime.data.cleanupDatasetCache)).toHaveBeenCalledWith(ctx.accountId, "feed_x", oldLocation);
  });

  it("survives a crash after the activation claim and resolves it without blindly re-activating", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    // Start from `prepared`: the executor claims the activation itself, so
    // a throw from the external call leaves the claim durable.
    const ctx = await seedRefreshJob(runtime, {
      phase: "prepared",
      activationPreviousLocation: "old",
      cleanupPreviousLocation: "old",
    });
    const activate = vi.mocked(runtime.data.activateDatasetRefresh);
    const oldLocation = ctx.oldLocation;
    activate.mockImplementation(async (_account, _name, version, _url, _original, _format, _previous) => {
      expect(version).toBe(ctx.refreshVersion);
      throw new Error("connection reset after the activation CAS");
    });

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    await expect(runtime.ingestionStore.getJob(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
    });
    // The claim is durable and no chunks were promoted.
    await expect(runtime.refreshStore.getState(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      phase: "activating",
    });
    await expect(runtime.ledger.all("SELECT id FROM chunks")).resolves.toEqual([]);
    expect(activate).toHaveBeenCalledTimes(1);

    await runtime.ledger.run("UPDATE ingestion_jobs SET available_at='1970-01-01T00:00:00.000Z' WHERE source_id=?", [
      ctx.sourceId,
    ]);
    // The retry proves the activation actually completed externally.
    vi.mocked(runtime.data.currentDatasetLocation).mockResolvedValue(runtime.artifact);
    await expect(runtime.worker.processOne()).resolves.toBe(true);
    // Never re-activated or aborted blindly: the candidate was confirmed.
    expect(activate).toHaveBeenCalledTimes(1);
    await expect(runtime.refreshStore.getState(ctx.accountId, ctx.sourceId)).resolves.toBeUndefined();
    await expect(runtime.ingestionStore.getJob(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      status: "done",
    });
    await expect(runtime.sourceStore.getSource(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      status: "ready",
      filePath: runtime.artifact,
      meta: {},
    });
    expect(oldLocation).toBeTruthy();
  });

  it("keeps a third-location ambiguity durable and fail-closed", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const ctx = await seedRefreshJob(runtime, {
      phase: "activating",
      activationPreviousLocation: "/never/matched.csv",
      cleanupPreviousLocation: null,
    });
    vi.mocked(runtime.data.currentDatasetLocation).mockResolvedValue("/some/third/location.csv");

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    expect(vi.mocked(runtime.data.activateDatasetRefresh)).not.toHaveBeenCalled();
    await expect(runtime.refreshStore.getState(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      phase: "activating",
      attempts: 0,
    });
    await expect(runtime.ledger.all("SELECT id FROM chunks")).resolves.toEqual([]);
    await expect(runtime.ingestionStore.getJob(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("returns a provably unactivated activating row to prepared before activating again", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const ctx = await seedRefreshJob(runtime, {
      phase: "activating",
      activationPreviousLocation: "old",
      cleanupPreviousLocation: null,
    });
    vi.mocked(runtime.data.currentDatasetLocation).mockResolvedValue(ctx.oldLocation);
    const activate = vi.mocked(runtime.data.activateDatasetRefresh);
    activate.mockImplementation(async (_account, _name, version) => ({ version, location: runtime.artifact }));

    await expect(runtime.worker.processOne()).resolves.toBe(true);
    await expect(runtime.refreshStore.getState(ctx.accountId, ctx.sourceId)).resolves.toBeUndefined();
    await expect(runtime.ingestionStore.getJob(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      status: "done",
    });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("requires the exact activated refresh identity inside the promotion transaction", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const ctx = await seedRefreshJob(runtime, {
      phase: "prepared",
      activationPreviousLocation: "old",
      cleanupPreviousLocation: "old",
    });
    const identity = {
      accountId: ctx.accountId,
      sourceId: ctx.sourceId,
      connectorId: ctx.connectorId,
      generation: 1,
      refreshVersion: ctx.refreshVersion,
    };
    await expect(runtime.refreshStore.claimActivation(identity)).resolves.toBe(true);
    await expect(runtime.refreshStore.confirmActivation(identity)).resolves.toBe(true);
    const job = await runtime.ingestionStore.claimNext("pending");
    if (!job?.leaseToken) throw new Error("test refresh job was not leased");
    await runtime.ingestionStore.stageChunks({
      accountId: ctx.accountId,
      sourceId: ctx.sourceId,
      generation: job.generation,
      leaseToken: job.leaseToken,
      sourceName: "Feed",
      chunks: [{ content: "candidate preview", meta: {} }],
    });

    // A different refresh version cannot borrow the activated identity.
    await expect(
      runtime.ingestionStore.promoteGeneration({
        accountId: ctx.accountId,
        sourceId: ctx.sourceId,
        generation: job.generation,
        leaseToken: job.leaseToken,
        sizeBytes: 10,
        promotedFilePath: runtime.artifact,
        refresh: { ...identity, refreshVersion: "other-version" },
        verifyVectors: async () => true,
      })
    ).rejects.toMatchObject({ code: "INGESTION_SUPERSEDED" });
    await expect(runtime.refreshStore.getState(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      phase: "activated",
    });
    await expect(runtime.ledger.all("SELECT id FROM chunks")).resolves.toEqual([]);

    // The exact activated identity promotes and finalizes the typed row.
    await expect(
      runtime.ingestionStore.promoteGeneration({
        accountId: ctx.accountId,
        sourceId: ctx.sourceId,
        generation: job.generation,
        leaseToken: job.leaseToken,
        sizeBytes: 10,
        promotedFilePath: runtime.artifact,
        refresh: identity,
        verifyVectors: async () => true,
      })
    ).resolves.toEqual({ chunkCount: 1 });
    await expect(runtime.refreshStore.getState(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      phase: "cleanup_pending",
      candidateLocation: runtime.artifact,
      cleanupPreviousLocation: ctx.oldLocation,
    });
  });

  it("refuses a run whose typed refresh identity does not match the lease", async () => {
    const runtime = await setup(async (texts) => texts.map(() => [1, 0, 0]));
    const ctx = await seedRefreshJob(runtime, { phase: "prepared", activationPreviousLocation: null });
    const job = await runtime.ingestionStore.claimNext("pending");
    if (!job?.leaseToken) throw new Error("test refresh job was not leased");
    // A concurrently bumped generation invalidates the running attempt.
    await runtime.ledger.run(`UPDATE connector_refresh_states SET generation=5 WHERE source_id=?`, [ctx.sourceId]);
    await expect(
      runtime.executor.ingest({
        accountId: ctx.accountId,
        sourceId: ctx.sourceId,
        name: "feed_x",
        filePath: ctx.oldLocation,
        mime: "text/csv",
        kind: "tabular",
        displayName: "Feed",
        url: "https://example.test/feed.csv",
        connector: ctx.connectorId,
        generation: job.generation,
        leaseToken: job.leaseToken,
      })
    ).rejects.toThrow(/superseded/i);
    await expect(runtime.refreshStore.getState(ctx.accountId, ctx.sourceId)).resolves.toMatchObject({
      phase: "prepared",
      generation: 5,
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
