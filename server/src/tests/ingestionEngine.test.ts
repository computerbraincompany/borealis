import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteIngestionStore } from "../db/stores/ingestionStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import { IngestionExecutor, IngestionWorker, type IngestionDataOperations } from "../ingestionEngine.js";
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

async function setup(embed: (texts: string[]) => Promise<number[][]>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingestion-engine-test-"));
  const ledger = await openSqliteLedger({ path: path.join(directory, "ledger.sqlite") });
  const vectors = await LanceVectorIndex.open({ directory: path.join(directory, "lance"), dimension: 3 });
  resources.push({ directory, ledger, vectors });
  const sourceStore = new SourceStore(ledger);
  const ingestionStore = new SqliteIngestionStore(ledger);
  const lifecycle = new IngestionVectorLifecycle(ingestionStore, vectors);
  const artifact = path.join(directory, "document.txt");
  await fs.writeFile(artifact, "content");
  const data: IngestionDataOperations = {
    registerDataset: vi.fn(async () => ({})),
    extractDataset: vi.fn(async () => ({})),
    extractPreparedDataset: vi.fn(async () => ({})),
    activateDatasetRefresh: vi.fn(async () => ({})),
    cleanupDatasetCache: vi.fn(async () => undefined),
  };
  const executor = new IngestionExecutor({
    store: ingestionStore,
    lifecycle,
    data,
    embeddingDimension: 3,
    embed,
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
    ingest: (input) => executor.ingest(input),
  });
  return { directory, ledger, vectors, sourceStore, ingestionStore, lifecycle, artifact, data, executor, worker };
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
});
