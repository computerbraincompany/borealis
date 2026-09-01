import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recognizeMock = vi.hoisted(() => vi.fn());

vi.mock("../localPdfOcr.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../localPdfOcr.js")>();
  return { ...actual, recognizeLocalPdfPages: recognizeMock };
});
vi.mock("../llm.js", () => {
  const embed = vi.fn();
  return { embed, createEmbeddingExecutor: vi.fn(() => embed) };
});
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

import { closeEmbeddingMigrationCoordinator } from "../embeddingMigration.js";
import { startIngestionWorkers, stopIngestionWorkers } from "../ingest.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-ingestion-shutdown-"));
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
  recognizeMock.mockReset();
});

afterEach(async () => {
  await stopIngestionWorkers();
  await closeEmbeddingMigrationCoordinator();
  await closeStorageRuntime();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("ingestion worker shutdown", () => {
  it("aborts the exact deferred local OCR child and leaves its durable job retryable", async () => {
    let childSignal: AbortSignal | undefined;
    let observedAbort = false;
    recognizeMock.mockImplementation(
      async (_filePath: string, _pages: readonly number[], signal: AbortSignal | undefined) => {
        childSignal = signal;
        if (!signal) throw new Error("missing ingestion job signal");
        return new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            observedAbort = true;
            reject(signal.reason);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    );

    const sourceId = randomUUID();
    const filePath = path.join(directory, "scan.pdf");
    const pdf = minimalPdf("");
    await fs.writeFile(filePath, pdf);
    await storageRuntime().sourceIngestion.createUploadSource(ACCOUNT, {
      id: sourceId,
      baseName: "scan",
      kind: "document",
      displayName: "Scan.pdf",
      filePath,
      mime: "application/pdf",
      sizeBytes: pdf.length,
    });

    await startIngestionWorkers();
    await vi.waitFor(() => {
      expect(recognizeMock).toHaveBeenCalledOnce();
      expect(childSignal).toBeDefined();
    });
    const exactChildSignal = childSignal!;
    expect(recognizeMock.mock.calls[0]?.[2]).toBe(exactChildSignal);
    expect(exactChildSignal.aborted).toBe(false);

    const stopped = stopIngestionWorkers();
    await vi.waitFor(() => expect(exactChildSignal.aborted).toBe(true));
    await expect(stopped).resolves.toBeUndefined();

    expect(observedAbort).toBe(true);
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, sourceId)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      leaseToken: null,
      lastError: "INGEST_FAILED",
    });
    await expect(storageRuntime().sources.getSource(ACCOUNT, sourceId)).resolves.toMatchObject({ status: "index" });
  });
});

function minimalPdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const content = escaped ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n%\xFF\xFF\xFF\xFF\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "binary"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}
