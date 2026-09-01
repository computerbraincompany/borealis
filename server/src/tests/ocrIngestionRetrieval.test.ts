import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCitations } from "../citations.js";
import { SqliteIngestionStore } from "../db/stores/ingestionStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import { IngestionExecutor, IngestionWorker, type IngestionDataOperations } from "../ingestionEngine.js";
import { chunkText, extractPdfText } from "../ingestSupport.js";
import { recognizeLocalPdfPages, type PdfOcrPage } from "../localPdfOcr.js";
import { buildRasterOnlyOcrSmokePdf } from "../ocrSmokePdf.js";
import { sanitizeRetrievedEvidence } from "../tools.js";
import { LanceVectorIndex } from "../vector/lance.js";
import { IngestionVectorLifecycle } from "../vector/lifecycle.js";
import { retrieveWithVector } from "../vector/retrieve.js";

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

describe("OCR ingestion composition", () => {
  it("takes recognized PDF text through durable ingestion, scoped retrieval, and citation metadata", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ocr-composition-"));
    const artifact = path.join(directory, "scan.pdf");
    const pdf = buildRasterOnlyOcrSmokePdf();
    expect(pdf.includes(Buffer.from("/Font", "ascii"))).toBe(false);
    expect(pdf.includes(Buffer.from("BOREALIS OCR", "ascii"))).toBe(false);
    await fs.writeFile(artifact, pdf);
    const ledger = await openSqliteLedger({ path: path.join(directory, "ledger.sqlite") });
    const vectors = await LanceVectorIndex.open({ directory: path.join(directory, "lance"), dimension: 3 });
    resources.push({ directory, ledger, vectors });
    const sources = new SourceStore(ledger);
    const ingestion = new SqliteIngestionStore(ledger);
    const lifecycle = new IngestionVectorLifecycle(ingestion, vectors);
    const accountId = randomUUID();
    const sourceId = randomUUID();
    await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      accountId,
      `${accountId}@example.test`,
      "hash",
    ]);
    await sources.createSource(accountId, {
      id: sourceId,
      name: "scan",
      kind: "document",
      displayName: "scan.pdf",
      filePath: artifact,
      mime: "application/pdf",
      status: "index",
    });
    const fallbackRecognize = async (): Promise<readonly PdfOcrPage[]> => [{ page: 1, text: "BOREALIS OCR" }];
    const recognize = vi.fn(process.platform === "darwin" ? recognizeLocalPdfPages : fallbackRecognize);
    const data: IngestionDataOperations = {
      registerDataset: vi.fn(async () => ({})),
      extractDataset: vi.fn(async () => ({})),
      extractPreparedDataset: vi.fn(async () => ({})),
      activateDatasetRefresh: vi.fn(async () => ({})),
      deactivateDatasetLocation: vi.fn(async () => undefined),
      cleanupDatasetCache: vi.fn(async () => undefined),
    };
    const executor = new IngestionExecutor({
      store: ingestion,
      lifecycle,
      data,
      embeddingDimension: 3,
      createEmbeddingSession: async () => async (texts) => texts.map(() => [1, 0, 0]),
      resolveArtifact: async ({ filePath }) => (filePath === artifact ? artifact : undefined),
      isTabular: () => false,
      extractText: async (filePath, _mime, signal) =>
        extractPdfText(filePath, await fs.readFile(filePath), recognize, signal),
      chunkText,
      datasetRegistration: () => ({}),
      datasetPreviewText: () => "preview",
    });
    const worker = new IngestionWorker({
      store: ingestion,
      sources,
      lifecycle,
      ingest: (input) => executor.ingest(input),
    });
    await ingestion.reserveJob(accountId, sourceId);

    await expect(worker.processOne()).resolves.toBe(true);
    expect(recognize).toHaveBeenCalledWith(artifact, [1], expect.any(AbortSignal));
    await expect(sources.getSource(accountId, sourceId)).resolves.toMatchObject({
      status: "ready",
      readyGeneration: 1,
    });

    const passages = await retrieveWithVector(ingestion, vectors, {
      accountId,
      allowedSourceIds: [sourceId],
      vector: [1, 0, 0],
      topK: 1,
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]).toMatchObject({
      source_id: sourceId,
      source: "scan.pdf",
      content: expect.stringMatching(/BOREALIS\s+OCR/i),
    });
    const evidence = sanitizeRetrievedEvidence(passages);
    expect(buildCitations("The OCR marker is supported by the scan [1].", evidence)).toEqual([
      { n: 1, source_id: sourceId, chunk_id: passages[0]!.chunk_id, source: "scan.pdf" },
    ]);
  });
});
