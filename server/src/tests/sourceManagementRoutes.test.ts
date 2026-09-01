import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ uploadDir: `/tmp/borealis-upload-route-vitest-${process.pid}` }));
vi.mock("../config.js", () => ({
  serviceOriginsEquivalent: vi.fn(() => true),
  config: {
    jwtSecret: "vitest-secret-that-is-longer-than-32-chars-123456",
    llmApiKey: "vitest-model-token-that-is-longer-than-32-chars",
    llmBaseUrl: "http://127.0.0.1:1234",
    lmStudioBaseUrl: "http://localhost:1234",
    chatModel: "qwen-chat",
    embedModel: "nomic-embed",
    embeddingDim: 3,
    maxUploadBytes: 16,
    maxMessageChars: 32_000,
    maxHistoryMessages: 80,
    maxHistoryChars: 120_000,
    maxExtractedChars: 2_000_000,
    maxIngestChunks: 2_500,
    uploadDir: testState.uploadDir,
    reportDir: `${testState.uploadDir}/reports`,
  },
}));
vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../ingest.js", () => ({
  wakeConnectorPrepareWorkers: vi.fn(),
  wakeIngestionWorkers: vi.fn(),
  isTabularSource: vi.fn((filePath: string) => filePath.endsWith(".csv")),
  sanitizeDatasetName: vi.fn(() => "ledger"),
}));
vi.mock("../dataService.js", () => ({
  DataServiceError: class DataServiceError extends Error {
    constructor(readonly status: number) {
      super("data service error");
    }
  },
  dataService: {
    listDatasetSummaries: vi.fn(),
    prepareDatasetRefresh: vi.fn(),
    abortDatasetRefresh: vi.fn(),
    deactivateDatasetLocation: vi.fn(),
    cleanupDatasetCache: vi.fn(),
  },
}));
vi.mock("../storageArtifacts.js", () => ({
  createUploadResourceDirectory: vi.fn(),
  cleanupCreatedUploadResource: vi.fn(),
  removeSourceArtifact: vi.fn(),
}));

import { signToken } from "../auth.js";
import { encodeJson } from "../db/codecs.js";
import { dataService } from "../dataService.js";
import { closeEmbeddingMigrationCoordinator } from "../embeddingMigration.js";
import { wakeIngestionWorkers } from "../ingest.js";
import { routes } from "../routes.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import {
  cleanupCreatedUploadResource,
  createUploadResourceDirectory,
  removeSourceArtifact,
} from "../storageArtifacts.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const auth = { authorization: `Bearer ${signToken({ userId: ACCOUNT, email: "owner@example.test" })}` };
const wakeMock = vi.mocked(wakeIngestionWorkers);
const removeArtifactMock = vi.mocked(removeSourceArtifact);
const createDirectoryMock = vi.mocked(createUploadResourceDirectory);
const cleanupCreatedMock = vi.mocked(cleanupCreatedUploadResource);
const listDatasetSummariesMock = vi.mocked(dataService.listDatasetSummaries);
const deactivateMock = vi.mocked(dataService.deactivateDatasetLocation);
const cacheCleanupMock = vi.mocked(dataService.cleanupDatasetCache);
const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  apps.push(app);
  await routes(app);
  await app.ready();
  return app;
}

function multipart(
  filename: string,
  content: Buffer,
  mime = "text/csv"
): { body: Buffer; headers: Record<string, string> } {
  const boundary = "borealis-test-boundary";
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mime}\r\n\r\n`
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

beforeEach(async () => {
  wakeMock.mockReset();
  removeArtifactMock.mockReset();
  removeArtifactMock.mockResolvedValue(true);
  createDirectoryMock.mockReset();
  createDirectoryMock.mockImplementation(async (accountId, sourceId) => {
    const directory = path.join(testState.uploadDir, accountId, sourceId);
    await fs.mkdir(directory, { recursive: true });
    return directory;
  });
  cleanupCreatedMock.mockReset();
  cleanupCreatedMock.mockImplementation(async (_accountId, _sourceId, filePath) => {
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });
  listDatasetSummariesMock.mockReset();
  listDatasetSummariesMock.mockResolvedValue([]);
  deactivateMock.mockReset();
  deactivateMock.mockResolvedValue({ status: "unchanged" });
  cacheCleanupMock.mockReset();
  cacheCleanupMock.mockResolvedValue({ status: "missing" });
  await fs.rm(testState.uploadDir, { recursive: true, force: true });
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-source-routes-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
    lanceDirectory: path.join(runtimeDirectory, "lancedb"),
    embeddingDimension: 3,
  });
  await runtime.ledger.run(`INSERT INTO users (id,email,password_hash) VALUES (?,?,?)`, [
    ACCOUNT,
    "owner@example.test",
    "hash",
  ]);
  await runtime.ledger.run(`INSERT INTO users (id,email,password_hash) VALUES (?,?,?)`, [
    FOREIGN,
    "foreign@example.test",
    "hash",
  ]);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeEmbeddingMigrationCoordinator();
  await closeStorageRuntime();
  await fs.rm(testState.uploadDir, { recursive: true, force: true });
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

describe("source upload boundaries", () => {
  it("rejects an upload before multipart parsing while an embedding migration is active", async () => {
    await writeActiveMigrationState();
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/sources/upload",
      ...multipart("ledger.csv", Buffer.from("amount\n42\n")),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "source changes are paused during embedding migration",
      code: "SOURCE_MUTATION_BLOCKED",
    });
    expect(createDirectoryMock).not.toHaveBeenCalled();
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it("keeps reingest and deletion identities unchanged while migration state is active", async () => {
    const sourceId = "66666666-6666-4666-8666-666666666666";
    await storageRuntime().sourceIngestion.createUploadSource(ACCOUNT, {
      id: sourceId,
      baseName: "notes",
      kind: "document",
      displayName: "Notes.txt",
      filePath: "/safe/notes.txt",
      mime: "text/plain",
      sizeBytes: 5,
    });
    await writeActiveMigrationState();
    const app = await buildApp();

    for (const request of [
      { method: "POST" as const, url: `/api/sources/${sourceId}/reingest` },
      { method: "DELETE" as const, url: `/api/sources/${sourceId}` },
    ]) {
      const response = await app.inject({ ...request, headers: auth });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "SOURCE_MUTATION_BLOCKED" });
    }
    await expect(storageRuntime().sources.getSource(ACCOUNT, sourceId)).resolves.toMatchObject({ id: sourceId });
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it("returns bounded, actionable ingestion details without exposing stored raw errors", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    await storageRuntime().sourceIngestion.createUploadSource(ACCOUNT, {
      id: sourceId,
      baseName: "ledger",
      kind: "tabular",
      displayName: "Ledger.csv",
      filePath: "/safe/ledger.csv",
      mime: "text/csv",
      sizeBytes: 42,
    });
    await storageRuntime().ledger.run(`UPDATE sources SET status='error',meta=? WHERE id=? AND account_id=?`, [
      encodeJson({
        error: "raw provider trace must not escape",
        error_code: "EMBEDDING_UNAVAILABLE",
        error_detail: "raw detail must not escape",
      }),
      sourceId,
      ACCOUNT,
    ]);
    await storageRuntime().ledger.run(`UPDATE ingestion_jobs SET attempts=3,updated_at=? WHERE source_id=?`, [
      "2026-08-25T21:34:47.000Z",
      sourceId,
    ]);
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/sources", headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        expect.objectContaining({
          meta: {
            error: "The embedding service was unavailable.",
            error_code: "EMBEDDING_UNAVAILABLE",
            error_detail:
              "Borealis read the file but could not reach the configured embedding model. Start the model service, then retry.",
            error_stage: "embedding",
          },
          ingestion: { attempts: 3, updated_at: "2026-08-25T21:34:47.000Z" },
        }),
      ],
      next_cursor: null,
    });
    expect(response.body).not.toContain("raw provider trace");
    expect(response.body).not.toContain("raw detail");
    expect(listDatasetSummariesMock).toHaveBeenCalledWith(ACCOUNT, ["ledger"]);
  });

  it("returns a bounded exact source-status batch scoped to the authenticated account", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const foreignId = "33333333-3333-4333-8333-333333333333";
    const missingId = "44444444-4444-4444-8444-444444444444";
    await storageRuntime().sourceIngestion.createUploadSource(ACCOUNT, {
      id: sourceId,
      baseName: "notes",
      kind: "document",
      displayName: "Notes.txt",
      filePath: "/safe/notes.txt",
      mime: "text/plain",
      sizeBytes: 5,
    });
    await storageRuntime().sourceIngestion.createUploadSource(FOREIGN, {
      id: foreignId,
      baseName: "foreign_notes",
      kind: "document",
      displayName: "Foreign.txt",
      filePath: "/safe/foreign.txt",
      mime: "text/plain",
      sizeBytes: 7,
    });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/sources/status",
      headers: auth,
      payload: { ids: [sourceId, foreignId, missingId] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [expect.objectContaining({ id: sourceId, display_name: "Notes.txt", status: "index" })],
      missing_ids: [foreignId, missingId],
    });
    expect(response.body).not.toContain("Foreign.txt");

    const overLimit = await app.inject({
      method: "POST",
      url: "/api/sources/status",
      headers: auth,
      payload: { ids: Array.from({ length: 51 }, () => randomUUID()) },
    });
    expect(overLimit.statusCode).toBe(400);
  });

  it("persists the authoritative streamed file size with its pending generation", async () => {
    const app = await buildApp();
    const upload = multipart("ledger.csv", Buffer.from("1234567890"));

    const response = await app.inject({ method: "POST", url: "/api/sources/upload", ...upload });

    expect(response.statusCode).toBe(200);
    const source = await storageRuntime().sources.getSource(ACCOUNT, response.json().id);
    expect(source).toMatchObject({ sizeBytes: 10, status: "index", name: "ledger" });
    expect(await fs.stat(source?.filePath ?? "").then((stat) => stat.size)).toBe(10);
    await expect(storageRuntime().ingestion.getJob(ACCOUNT, response.json().id)).resolves.toMatchObject({
      generation: 1,
      status: "pending",
      attempts: 0,
    });
    expect(wakeMock).toHaveBeenCalledOnce();
  });

  it("detects multipart truncation and removes the partial upload", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sources/upload",
      ...multipart("too-large.csv", Buffer.from("12345678901234567")),
    });
    expect(response.statusCode).toBe(413);
    await expect(storageRuntime().sources.listSources(ACCOUNT)).resolves.toEqual({ items: [], next: null });
    const accountEntries = await fs.readdir(path.join(testState.uploadDir, ACCOUNT)).catch(() => []);
    expect(accountEntries).toEqual([]);
  });

  it.each(["legacy.xls", "legacy.doc"])("rejects unsupported legacy upload %s before persistence", async (filename) => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sources/upload",
      ...multipart(filename, Buffer.from("legacy")),
    });
    expect(response.statusCode).toBe(422);
    await expect(storageRuntime().sources.listSources(ACCOUNT)).resolves.toEqual({ items: [], next: null });
  });

  it("rejects an unsupported upload extension before filesystem or ledger persistence", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sources/upload",
      ...multipart("payload.bin", Buffer.from("not supported"), "application/octet-stream"),
    });
    expect(response.statusCode).toBe(422);
    await expect(storageRuntime().sources.listSources(ACCOUNT)).resolves.toEqual({ items: [], next: null });
  });

  it("does not reject a supported text upload solely for ambiguous Word MIME", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sources/upload",
      ...multipart("renamed.txt", Buffer.from("legacy"), "application/msword"),
    });
    expect(response.statusCode).toBe(200);
    await expect(storageRuntime().sources.getSource(ACCOUNT, response.json().id)).resolves.toMatchObject({
      kind: "document",
      mime: "application/msword",
    });
  });

  it("deletes relational identity, purges LanceDB, then clears the durable marker", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const filePath = path.join(testState.uploadDir, ACCOUNT, sourceId, "ledger.csv");
    await storageRuntime().sourceIngestion.createUploadSource(ACCOUNT, {
      id: sourceId,
      baseName: "ledger",
      kind: "tabular",
      displayName: "Ledger.csv",
      filePath,
      mime: "text/csv",
      sizeBytes: 10,
    });
    await storageRuntime().vectors.upsert([
      { chunkId: randomChunkId(), accountId: ACCOUNT, sourceId, generation: 1, vector: [1, 0, 0] },
    ]);
    const deleteSpy = vi.spyOn(storageRuntime().vectors, "deleteSource");
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/sources/${sourceId}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(deleteSpy).toHaveBeenCalledWith(sourceId);
    expect(deleteSpy.mock.invocationCallOrder[0]).toBeLessThan(removeArtifactMock.mock.invocationCallOrder[0]);
    await expect(storageRuntime().sources.getSource(ACCOUNT, sourceId)).resolves.toBeUndefined();
    await expect(storageRuntime().sources.listPendingSourceDeletes(ACCOUNT)).resolves.toEqual([]);
    expect((await storageRuntime().vectors.scanRows()).filter((row) => row.sourceId === sourceId)).toEqual([]);
  });

  it("leaves a durable retry marker when cleanup fails after vector purge", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    await storageRuntime().sourceIngestion.createUploadSource(ACCOUNT, {
      id: sourceId,
      baseName: "ledger",
      kind: "tabular",
      displayName: "Ledger.csv",
      filePath: path.join(testState.uploadDir, ACCOUNT, sourceId, "ledger.csv"),
      mime: "text/csv",
      sizeBytes: 10,
    });
    removeArtifactMock.mockRejectedValueOnce(new Error("raw filesystem failure"));
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/sources/${sourceId}`, headers: auth });

    expect(response.statusCode).toBe(200);
    await expect(storageRuntime().sources.listPendingSourceDeletes(ACCOUNT)).resolves.toEqual([
      expect.objectContaining({
        sourceId,
        attempts: 1,
        lastError: "SOURCE_CLEANUP_RETRY",
      }),
    ]);
    expect(response.body).not.toContain("raw filesystem failure");
  });

  it("rejects deletion and reingest mutations while their exact source is unavailable", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    await storageRuntime().sourceIngestion.createUploadSource(ACCOUNT, {
      id: sourceId,
      baseName: "ledger",
      kind: "tabular",
      displayName: "Ledger.csv",
      filePath: "/safe/ledger.csv",
      mime: "text/csv",
      sizeBytes: 10,
    });
    const chatId = "33333333-3333-4333-8333-333333333333";
    const runId = "44444444-4444-4444-8444-444444444444";
    await storageRuntime().ledger.run(`INSERT INTO chats (id,account_id,title,model) VALUES (?,?,?,?)`, [
      chatId,
      ACCOUNT,
      "Active",
      "qwen-chat",
    ]);
    await storageRuntime().ledger.run(`INSERT INTO chat_runs (id,account_id,chat_id,status) VALUES (?,?,?,'running')`, [
      runId,
      ACCOUNT,
      chatId,
    ]);
    await storageRuntime().ledger.run(`INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)`, [
      runId,
      sourceId,
      ACCOUNT,
    ]);
    const app = await buildApp();

    const deletion = await app.inject({ method: "DELETE", url: `/api/sources/${sourceId}`, headers: auth });
    const reingest = await app.inject({ method: "POST", url: `/api/sources/${sourceId}/reingest`, headers: auth });

    expect(deletion.statusCode).toBe(409);
    expect(reingest.statusCode).toBe(409);
    await expect(storageRuntime().sources.getSource(ACCOUNT, sourceId)).resolves.toBeDefined();
    await expect(storageRuntime().sources.listPendingSourceDeletes(ACCOUNT)).resolves.toEqual([]);
  });
});

async function writeActiveMigrationState(): Promise<void> {
  await fs.writeFile(
    path.join(runtimeDirectory, "embedding-migration.json"),
    `${JSON.stringify({
      version: 1,
      id: "33333333-3333-4333-8333-333333333333",
      phase: "building",
      target_model: "new-embed",
      target_dimension: 5,
      old_model: "old-embed",
      old_dimension: 3,
      provider_revision: "a".repeat(64),
      snapshot_hash: null,
      source_count: 0,
      chunk_count: 0,
      indexed_count: 0,
      error_code: null,
      created_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 }
  );
}

function randomChunkId(): string {
  return "55555555-5555-4555-8555-555555555555";
}
