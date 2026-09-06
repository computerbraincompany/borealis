import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteIngestionStore } from "../db/stores/ingestionStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import { ConnectorRefreshStore } from "../db/stores/connectorRefreshStore.js";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import { IngestionExecutor, IngestionWorker, type IngestionDataOperations } from "../ingestionEngine.js";
import { extractDocument } from "../ingestSupport.js";
import { chunkTextWithLocators } from "../sourceLocations.js";
import { searchCapturedScope, searchLibraryScope } from "../sourceSearch.js";
import { LanceVectorIndex } from "../vector/lance.js";
import { IngestionVectorLifecycle } from "../vector/lifecycle.js";

/**
 * Real-store search integration (M14 stage 3): durable ingestion through the
 * real executor stages REAL FTS5 shadow rows and REAL LanceDB vectors, and
 * both search modes then run against those stores end to end. The embedding
 * transport is the only seam (a deterministic fake through the same
 * session/port contracts).
 */

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const CORPUS = path.join(REPO_ROOT, "data/e2e/supplier-corpus");

interface Resource {
  directory: string;
  ledger: SqliteLedger;
  vectors: LanceVectorIndex;
}

const resources: Resource[] = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ directory, ledger, vectors }) => {
      await vectors.close();
      await ledger.close();
      await fs.rm(directory, { recursive: true, force: true });
    })
  );
});

describe("source search over real stores", () => {
  it("ingests the corpus with locators and answers keyword and semantic search honestly", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-source-search-int-"));
    const ledger = await openSqliteLedger({ path: path.join(directory, "ledger.sqlite") });
    const vectors = await LanceVectorIndex.open({ directory: path.join(directory, "lancedb"), dimension: 3 });
    resources.push({ directory, ledger, vectors });
    const ingestion = new SqliteIngestionStore(ledger);
    const sources = new SourceStore(ledger);
    const lifecycle = new IngestionVectorLifecycle(ingestion, vectors);
    const accountId = randomUUID();
    await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      accountId,
      `${accountId}@example.test`,
      "hash",
    ]);

    const data: IngestionDataOperations = {
      registerDataset: async () => ({}),
      extractDataset: async () => ({}),
      extractPreparedDataset: async () => ({}),
      activateDatasetRefresh: async () => ({}),
      deactivateDatasetLocation: async () => undefined,
      cleanupDatasetCache: async () => undefined,
      currentDatasetLocation: async () => null,
    };
    const executor = new IngestionExecutor({
      store: ingestion,
      lifecycle,
      refresh: new ConnectorRefreshStore(ledger),
      data,
      embeddingDimension: 3,
      // Deterministic unit vectors keyed by a corpus token; same contract as
      // production sessions, no transport.
      createEmbeddingSession: async () => async (texts) =>
        texts.map((text) => (text.includes("CEDARCLOUD") ? [1, 0, 0] : [0, 1, 0])),
      resolveArtifact: async ({ filePath }) => filePath,
      isTabular: () => false,
      extractDocument,
      chunkTextWithLocators,
      datasetRegistration: () => ({}),
      datasetPreviewSegments: () => ({ text: "preview", segments: [], separator: "" }),
    });
    const worker = new IngestionWorker({
      store: ingestion,
      sources,
      lifecycle,
      refresh: new ConnectorRefreshStore(ledger),
      ingest: (input) => executor.ingest(input),
    });

    const sourceDirectory = path.join(directory, "uploads", accountId);
    await fs.mkdir(sourceDirectory, { recursive: true });
    const artifact = path.join(sourceDirectory, "cedar.pdf.md");
    const original = await fs.readFile(path.join(CORPUS, "06_cedarcloud_summary.md"), "utf8");
    await fs.writeFile(artifact, original);
    const sourceId = randomUUID();
    await sources.createSource(accountId, {
      id: sourceId,
      name: "cedarcloud_summary",
      kind: "document",
      displayName: "cedarcloud_summary.md",
      filePath: artifact,
      mime: "text/markdown",
      status: "index",
    });
    await ingestion.reserveJob(accountId, sourceId);
    await expect(worker.processOne()).resolves.toBe(true);
    const readyOne = await sources.getSource(accountId, sourceId);
    expect(readyOne?.readyGeneration).toBe(1);

    // Stage 3 records typed locators in chunk meta for the new pipeline.
    const metaRows = await ledger.all<{ meta: string }>(
      "SELECT meta FROM chunks WHERE source_id=? AND generation=1 ORDER BY seq",
      [sourceId]
    );
    expect(metaRows.length).toBeGreaterThan(0);
    const located = metaRows.filter((row) => row.meta.includes('"loc"'));
    expect(located.length).toBe(metaRows.length);

    const ports = {
      store: () => ingestion,
      vectors: () => vectors,
      embedQuery: async () => [[1, 0, 0]],
    };

    const keyword = await searchLibraryScope(
      { accountId, sourceIds: [sourceId], query: "cedarcloud hosting", mode: "keyword" },
      ports
    );
    expect(keyword.scope).toEqual([{ source_id: sourceId, generation: 1, status: "ready" }]);
    expect(keyword.hits.length).toBeGreaterThan(0);
    expect(keyword.hits[0]!.excerpt.toLowerCase()).toContain("cedarcloud");
    expect(keyword.hits[0]!.locators.length).toBeGreaterThan(0);

    const semantic = await searchLibraryScope(
      { accountId, sourceIds: [sourceId], query: "which supplier hosts data", mode: "semantic" },
      ports
    );
    expect(semantic.hits.length).toBeGreaterThan(0);
    expect(semantic.hits[0]!.excerpt.toLowerCase()).toContain("cedarcloud");

    // Modify upstream bytes and refresh: generation two promotes; the old
    // captured pairs must report source_changed and never match newer text.
    await fs.writeFile(artifact, `${original}\n# Revised\n\nCEDARCLOUD hosting terms revised sentence.\n`);
    await ingestion.reserveJob(accountId, sourceId);
    await expect(worker.processOne()).resolves.toBe(true);
    expect((await sources.getSource(accountId, sourceId))?.readyGeneration).toBe(2);

    const stale = await searchCapturedScope(
      {
        accountId,
        scopes: [{ sourceId, generation: 1 }],
        query: "revised",
        mode: "keyword",
      },
      ports
    );
    expect(stale.scope).toEqual([{ source_id: sourceId, generation: 1, status: "source_changed" }]);
    expect(stale.hits).toEqual([]);

    const fresh = await searchLibraryScope(
      { accountId, sourceIds: [sourceId], query: "revised", mode: "keyword" },
      ports
    );
    expect(fresh.scope).toEqual([{ source_id: sourceId, generation: 2, status: "ready" }]);
    expect(fresh.hits.length).toBe(1);
    expect(fresh.hits[0]!.excerpt).toContain("revised sentence");
    expect(fresh.hits[0]!.locators.length).toBeGreaterThan(0);

    // Passage panel: the promoted chunk resolves with its locator, and the
    // FTS shadow rows followed promotion (one generation only).
    const chunkCount = await ledger.get<{ n: bigint }>(
      // chunks_fts stores the generation column as TEXT (the shadow schema's
      // unindexed column); the store's search path binds it as text too.
      "SELECT COUNT(*) AS n FROM chunks_fts WHERE source_id=? AND generation='2'",
      [sourceId]
    );
    const allFts = await ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM chunks_fts WHERE source_id=?", [
      sourceId,
    ]);
    expect(chunkCount?.n).toBe(allFts?.n);

    const firstChunk = await ledger.get<{ id: string }>(
      "SELECT id FROM chunks WHERE source_id=? AND generation=2 ORDER BY seq LIMIT 1",
      [sourceId]
    );
    const passage = await ingestion.getChunkPassage({ accountId, sourceId, chunkId: firstChunk!.id });
    expect(passage.found).toBe(true);
    if (passage.found) {
      expect(passage.chunk.generation).toBe(2);
      expect(passage.source.readyGeneration).toBe(2);
    }
    const stalePassage = await ingestion.getChunkPassage({
      accountId,
      sourceId,
      chunkId:
        (
          await ledger.get<{ id: string }>("SELECT id FROM chunks WHERE source_id=? AND generation=1 LIMIT 1", [
            sourceId,
          ])
        )?.id ?? randomUUID(),
    });
    expect(stalePassage.found).toBe(false);

    // Source deletion removes FTS text with the ledger rows.
    await ledger.run("DELETE FROM sources WHERE id=? AND account_id=?", [sourceId, accountId]);
    expect(
      await ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM chunks_fts WHERE source_id=?", [sourceId])
    ).toMatchObject({ n: 0n });
  });
});
