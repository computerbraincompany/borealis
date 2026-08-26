import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeJson } from "../db/codecs.js";
import { IngestionStoreError, SqliteIngestionStore, type IngestionJob } from "../db/stores/ingestionStore.js";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import { LanceVectorIndex } from "../vector/lance.js";
import { IngestionVectorLifecycle } from "../vector/lifecycle.js";
import { retrieveWithVector } from "../vector/retrieve.js";

interface TestStores {
  readonly directory: string;
  readonly ledger: SqliteLedger;
  readonly store: SqliteIngestionStore;
  readonly vectors: LanceVectorIndex;
  readonly lifecycle: IngestionVectorLifecycle;
}

const resources: TestStores[] = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => {
      await resource.vectors.close();
      await resource.ledger.close();
      await fs.rm(resource.directory, { recursive: true, force: true });
    })
  );
});

async function stores(): Promise<TestStores> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-two-store-test-"));
  const ledger = await openSqliteLedger({ path: path.join(directory, "ledger.sqlite") });
  const vectors = await LanceVectorIndex.open({ directory: path.join(directory, "lance"), dimension: 3 });
  const store = new SqliteIngestionStore(ledger);
  const resource = { directory, ledger, store, vectors, lifecycle: new IngestionVectorLifecycle(store, vectors) };
  resources.push(resource);
  return resource;
}

async function seedUser(ledger: SqliteLedger, accountId: string, email: string): Promise<void> {
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [accountId, email, "hash"]);
}

async function seedSource(
  ledger: SqliteLedger,
  accountId: string,
  sourceId: string,
  options: { name?: string; readyGeneration?: number | null; status?: "ready" | "index" | "error" } = {}
): Promise<void> {
  const name = options.name ?? sourceId;
  await ledger.run(
    `INSERT INTO sources
       (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta,ready_generation)
     VALUES (?,?,?,'document',?,?,'text/plain',1,?,?,?)`,
    [
      sourceId,
      accountId,
      name,
      `${name}.txt`,
      `/proven/${sourceId}.txt`,
      options.status ?? "ready",
      encodeJson({}),
      options.readyGeneration ?? 1,
    ]
  );
}

async function seedLiveChunk(
  resource: TestStores,
  input: {
    accountId: string;
    sourceId: string;
    generation: number;
    chunkId?: string;
    content: string;
    vector: readonly number[];
  }
): Promise<string> {
  const chunkId = input.chunkId ?? randomUUID();
  await resource.ledger.run(
    `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
     VALUES (?,?,?,?,0,?,?,?)`,
    [chunkId, input.accountId, input.sourceId, input.generation, input.sourceId, input.content, encodeJson({})]
  );
  await resource.vectors.upsert([
    {
      chunkId,
      accountId: input.accountId,
      sourceId: input.sourceId,
      generation: input.generation,
      vector: input.vector,
    },
  ]);
  return chunkId;
}

async function nextRunningJob(resource: TestStores, accountId: string, sourceId: string): Promise<IngestionJob> {
  await resource.ledger.run(
    `INSERT INTO ingestion_jobs
       (source_id,account_id,generation,status,attempts,available_at,created_at,updated_at)
     VALUES (?,?,1,'done',1,?,?,?)`,
    [sourceId, accountId, new Date(0).toISOString(), new Date(0).toISOString(), new Date(0).toISOString()]
  );
  await expect(resource.store.reserveJob(accountId, sourceId)).resolves.toBe(2);
  const job = await resource.store.claimNext("pending");
  expect(job).toMatchObject({ accountId, sourceId, generation: 2, status: "running" });
  if (!job?.leaseToken) throw new Error("test job was not leased");
  return job;
}

async function stageNew(resource: TestStores, job: IngestionJob, vector = [1, 0, 0]): Promise<string> {
  const ids = await resource.lifecycle.stageAndIndex({
    accountId: job.accountId,
    sourceId: job.sourceId,
    generation: job.generation,
    leaseToken: job.leaseToken!,
    sourceName: "New",
    chunks: [{ content: "new passage", meta: {}, vector }],
  });
  return ids[0]!;
}

describe("SQLite + LanceDB ingestion lifecycle", () => {
  it("prefilters account, source, and ready generation before the KNN text join", async () => {
    const resource = await stores();
    const accountA = randomUUID();
    const accountB = randomUUID();
    const sourceA = randomUUID();
    const sourceAOther = randomUUID();
    const sourceB = randomUUID();
    await seedUser(resource.ledger, accountA, "a@example.test");
    await seedUser(resource.ledger, accountB, "b@example.test");
    await seedSource(resource.ledger, accountA, sourceA);
    await seedSource(resource.ledger, accountA, sourceAOther);
    await seedSource(resource.ledger, accountB, sourceB);
    await seedLiveChunk(resource, {
      accountId: accountA,
      sourceId: sourceA,
      generation: 1,
      content: "allowed",
      vector: [0.7, 0.3, 0],
    });
    await seedLiveChunk(resource, {
      accountId: accountA,
      sourceId: sourceAOther,
      generation: 1,
      content: "wrong source",
      vector: [1, 0, 0],
    });
    await seedLiveChunk(resource, {
      accountId: accountB,
      sourceId: sourceB,
      generation: 1,
      content: "wrong account",
      vector: [1, 0, 0],
    });
    await resource.vectors.upsert([
      {
        chunkId: randomUUID(),
        accountId: accountA,
        sourceId: sourceA,
        generation: 2,
        vector: [1, 0, 0],
      },
    ]);

    const passages = await retrieveWithVector(resource.store, resource.vectors, {
      accountId: accountA,
      allowedSourceIds: [sourceA],
      vector: [1, 0, 0],
      topK: 1,
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({ source_id: sourceA, content: "allowed" });
  });

  it("returns on an empty allowlist without calling LanceDB", async () => {
    const resource = await stores();
    const search = vi.spyOn(resource.vectors, "search");
    await expect(
      retrieveWithVector(resource.store, resource.vectors, {
        accountId: randomUUID(),
        allowedSourceIds: [],
        vector: [],
        topK: 6,
      })
    ).resolves.toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps the old generation visible after vector upsert and cleans a failed new generation", async () => {
    const resource = await stores();
    const accountId = randomUUID();
    const sourceId = randomUUID();
    await seedUser(resource.ledger, accountId, "before-commit@example.test");
    await seedSource(resource.ledger, accountId, sourceId);
    const oldChunk = await seedLiveChunk(resource, {
      accountId,
      sourceId,
      generation: 1,
      content: "old passage",
      vector: [0.8, 0.2, 0],
    });
    const job = await nextRunningJob(resource, accountId, sourceId);
    const newChunk = await stageNew(resource, job);

    await expect(
      retrieveWithVector(resource.store, resource.vectors, {
        accountId,
        allowedSourceIds: [sourceId],
        vector: [1, 0, 0],
        topK: 1,
      })
    ).resolves.toMatchObject([{ chunk_id: oldChunk, content: "old passage" }]);

    await resource.lifecycle.failGeneration({
      accountId,
      sourceId,
      generation: job.generation,
      leaseToken: job.leaseToken!,
      errorCode: "CRASH_BEFORE_COMMIT",
    });
    await expect(resource.vectors.hasAll([newChunk], sourceId, 2)).resolves.toBe(false);
    await expect(resource.vectors.hasAll([oldChunk], sourceId, 1)).resolves.toBe(true);
  });

  it("commits the new generation before prune and boot repair removes the old vectors", async () => {
    const resource = await stores();
    const accountId = randomUUID();
    const sourceId = randomUUID();
    await seedUser(resource.ledger, accountId, "after-commit@example.test");
    await seedSource(resource.ledger, accountId, sourceId);
    const oldChunk = await seedLiveChunk(resource, {
      accountId,
      sourceId,
      generation: 1,
      content: "old passage",
      vector: [0.8, 0.2, 0],
    });
    const job = await nextRunningJob(resource, accountId, sourceId);
    const newChunk = await stageNew(resource, job);

    await expect(
      resource.lifecycle.promote(
        {
          accountId,
          sourceId,
          generation: job.generation,
          leaseToken: job.leaseToken!,
          sizeBytes: 12,
        },
        { afterCommit: async () => Promise.reject(new Error("crash after commit")) }
      )
    ).rejects.toThrow("crash after commit");

    await expect(resource.vectors.hasAll([oldChunk], sourceId, 1)).resolves.toBe(true);
    await expect(
      retrieveWithVector(resource.store, resource.vectors, {
        accountId,
        allowedSourceIds: [sourceId],
        vector: [1, 0, 0],
        topK: 1,
      })
    ).resolves.toMatchObject([{ chunk_id: newChunk, content: "new passage" }]);

    const repaired = await resource.lifecycle.repair();
    expect(repaired.repaired_vectors).toBeGreaterThanOrEqual(1);
    await expect(resource.vectors.hasAll([oldChunk], sourceId, 1)).resolves.toBe(false);
    await expect(resource.vectors.hasAll([newChunk], sourceId, 2)).resolves.toBe(true);
  });

  it("rolls back promotion when a staged vector is missing", async () => {
    const resource = await stores();
    const accountId = randomUUID();
    const sourceId = randomUUID();
    await seedUser(resource.ledger, accountId, "incomplete@example.test");
    await seedSource(resource.ledger, accountId, sourceId);
    const oldChunk = await seedLiveChunk(resource, {
      accountId,
      sourceId,
      generation: 1,
      content: "old",
      vector: [0, 1, 0],
    });
    const job = await nextRunningJob(resource, accountId, sourceId);
    const newChunk = await stageNew(resource, job);
    await resource.vectors.deleteMissing([newChunk]);

    await expect(
      resource.lifecycle.promote({
        accountId,
        sourceId,
        generation: 2,
        leaseToken: job.leaseToken!,
        sizeBytes: 2,
      })
    ).rejects.toMatchObject({ code: "VECTOR_INCOMPLETE" } satisfies Partial<IngestionStoreError>);
    await expect(resource.ledger.get("SELECT id FROM chunks WHERE id=?", [oldChunk])).resolves.toMatchObject({
      id: oldChunk,
    });
    await expect(
      resource.ledger.get("SELECT chunk_id FROM ingestion_chunk_staging WHERE chunk_id=?", [newChunk])
    ).resolves.toMatchObject({ chunk_id: newChunk });
  });

  it("repairs a durable source-delete crash and removes every source vector", async () => {
    const resource = await stores();
    const accountId = randomUUID();
    const sourceId = randomUUID();
    await seedUser(resource.ledger, accountId, "delete@example.test");
    await seedSource(resource.ledger, accountId, sourceId);
    const chunkId = await seedLiveChunk(resource, {
      accountId,
      sourceId,
      generation: 1,
      content: "deleted",
      vector: [1, 0, 0],
    });
    await resource.ledger.withImmediateTransaction((tx) => {
      tx.run(
        `INSERT INTO pending_source_deletes
           (source_id,account_id,name,file_path,dataset_locations)
         VALUES (?,?,?,?,?)`,
        [sourceId, accountId, sourceId, `/proven/${sourceId}.txt`, encodeJson([])]
      );
      tx.run("DELETE FROM sources WHERE id=? AND account_id=?", [sourceId, accountId]);
    });

    const repaired = await resource.lifecycle.repair();
    expect(repaired.repaired_vectors).toBe(1);
    await expect(resource.vectors.hasAll([chunkId], sourceId, 1)).resolves.toBe(false);
    await expect(
      retrieveWithVector(resource.store, resource.vectors, {
        accountId,
        allowedSourceIds: [sourceId],
        vector: [1, 0, 0],
        topK: 1,
      })
    ).resolves.toEqual([]);
  });

  it("never returns a Lance hit whose SQLite chunk row is gone", async () => {
    const resource = await stores();
    const accountId = randomUUID();
    const sourceId = randomUUID();
    await seedUser(resource.ledger, accountId, "join@example.test");
    await seedSource(resource.ledger, accountId, sourceId);
    const chunkId = await seedLiveChunk(resource, {
      accountId,
      sourceId,
      generation: 1,
      content: "must disappear",
      vector: [1, 0, 0],
    });
    await resource.ledger.run("DELETE FROM chunks WHERE id=? AND account_id=?", [chunkId, accountId]);

    await expect(
      retrieveWithVector(resource.store, resource.vectors, {
        accountId,
        allowedSourceIds: [sourceId],
        vector: [1, 0, 0],
        topK: 1,
      })
    ).resolves.toEqual([]);
    await expect(resource.lifecycle.repair()).resolves.toMatchObject({ repaired_vectors: 1 });
    await expect(resource.vectors.hasAll([chunkId], sourceId, 1)).resolves.toBe(false);
  });

  it("reuses stable chunk UUIDs when retrying the same generation", async () => {
    const resource = await stores();
    const accountId = randomUUID();
    const sourceId = randomUUID();
    await seedUser(resource.ledger, accountId, "stable@example.test");
    await seedSource(resource.ledger, accountId, sourceId);
    const job = await nextRunningJob(resource, accountId, sourceId);
    const first = await resource.lifecycle.stageAndIndex({
      accountId,
      sourceId,
      generation: 2,
      leaseToken: job.leaseToken!,
      sourceName: "Stable",
      chunks: [
        { content: "first", meta: {}, vector: [1, 0, 0] },
        { content: "second", meta: {}, vector: [0, 1, 0] },
      ],
    });
    await expect(
      resource.lifecycle.failGeneration({
        accountId,
        sourceId,
        generation: 2,
        leaseToken: job.leaseToken!,
        errorCode: "TRANSIENT_FAILURE",
        terminal: false,
        retryAt: new Date(0),
      })
    ).resolves.toBe(true);
    const reclaimed = await resource.store.claimNext("pending", new Date());
    expect(reclaimed).toMatchObject({ sourceId, generation: 2, status: "running" });
    const second = await resource.lifecycle.stageAndIndex({
      accountId,
      sourceId,
      generation: 2,
      leaseToken: reclaimed!.leaseToken!,
      sourceName: "Stable",
      chunks: [{ content: "first revised", meta: {}, vector: [0, 0, 1] }],
    });
    expect(second).toEqual([first[0]]);
    await expect(resource.vectors.hasAll([first[1]!], sourceId, 2)).resolves.toBe(false);
  });

  it("recovers inherited running leases and purges only the abandoned generation", async () => {
    const resource = await stores();
    const accountId = randomUUID();
    const sourceId = randomUUID();
    await seedUser(resource.ledger, accountId, "recovery@example.test");
    await seedSource(resource.ledger, accountId, sourceId);
    const live = await seedLiveChunk(resource, {
      accountId,
      sourceId,
      generation: 1,
      content: "live",
      vector: [0, 1, 0],
    });
    const abandoned = randomUUID();
    await resource.ledger.run(
      `INSERT INTO ingestion_jobs
         (source_id,account_id,generation,status,attempts,available_at,leased_at,lease_token,created_at,updated_at)
       VALUES (?,?,2,'running',1,?,?,?,?,?)`,
      [
        sourceId,
        accountId,
        new Date(0).toISOString(),
        new Date(0).toISOString(),
        randomUUID(),
        new Date(0).toISOString(),
        new Date(0).toISOString(),
      ]
    );
    await resource.ledger.run(
      `INSERT INTO ingestion_chunk_staging
         (chunk_id,source_id,generation,seq,account_id,source_name,content,meta)
       VALUES (?,?,2,0,?,?,?,?)`,
      [abandoned, sourceId, accountId, "Abandoned", "staged", encodeJson({})]
    );
    await resource.vectors.upsert([{ chunkId: abandoned, accountId, sourceId, generation: 2, vector: [1, 0, 0] }]);

    const recovered = await resource.store.recoverRunningLeases({ startup: true, maxAttempts: 3 });
    expect(recovered).toMatchObject([{ sourceId, generation: 3, status: "pending", leaseToken: null }]);
    await resource.lifecycle.drainPendingVectorOperations();
    await expect(resource.vectors.hasAll([abandoned], sourceId, 2)).resolves.toBe(false);
    await expect(resource.vectors.hasAll([live], sourceId, 1)).resolves.toBe(true);
    await expect(
      resource.ledger.get("SELECT chunk_id FROM ingestion_chunk_staging WHERE chunk_id=?", [abandoned])
    ).resolves.toBeUndefined();
  });
});
