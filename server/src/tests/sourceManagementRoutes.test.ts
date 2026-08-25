import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ uploadDir: `/tmp/borealis-upload-route-vitest-${process.pid}` }));
vi.mock("../config.js", () => ({
  config: {
    jwtSecret: "vitest-secret-that-is-longer-than-32-chars-123456",
    pythonServiceToken: "vitest-python-token-that-is-longer-than-32-chars",
    llmApiKey: "vitest-litellm-token-that-is-longer-than-32-chars",
    pythonServiceUrl: "http://127.0.0.1:8000",
    llmBaseUrl: "http://127.0.0.1:4000",
    chatModel: "qwen-chat",
    embedModel: "nomic-embed",
    embeddingDim: 768,
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
vi.mock("../db.js", () => ({ q: vi.fn(), pool: { connect: vi.fn(), query: vi.fn() } }));
vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../ingest.js", () => ({
  reserveIngestionJob: vi.fn(),
  reserveDatasetCacheCleanup: vi.fn(),
  processDatasetCacheCleanup: vi.fn(),
  wakeIngestionWorkers: vi.fn(),
  isTabularSource: vi.fn((filePath: string) => filePath.endsWith(".csv")),
  sanitizeDatasetName: vi.fn(() => "ledger"),
}));
vi.mock("../pythonClient.js", () => ({
  py: {
    listDatasetSummaries: vi.fn(),
    registerDataset: vi.fn(),
  },
}));
vi.mock("../storageArtifacts.js", () => ({
  createUploadResourceDirectory: vi.fn(),
  cleanupCreatedUploadResource: vi.fn(),
  removeSourceArtifact: vi.fn(),
  removeReportArtifacts: vi.fn(),
  resolveReportArtifact: vi.fn(),
}));

import { signToken } from "../auth.js";
import { pool, q } from "../db.js";
import {
  processDatasetCacheCleanup,
  reserveDatasetCacheCleanup,
  reserveIngestionJob,
  wakeIngestionWorkers,
} from "../ingest.js";
import { routes } from "../routes.js";
import {
  cleanupCreatedUploadResource,
  createUploadResourceDirectory,
  removeReportArtifacts,
  removeSourceArtifact,
} from "../storageArtifacts.js";
import { py } from "../pythonClient.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const auth = { authorization: `Bearer ${signToken({ userId: ACCOUNT, email: "owner@example.test" })}` };
const qMock = vi.mocked(q);
const connectMock = vi.mocked(pool.connect);
const reserveMock = vi.mocked(reserveIngestionJob);
const reserveCleanupMock = vi.mocked(reserveDatasetCacheCleanup);
const processCleanupMock = vi.mocked(processDatasetCacheCleanup);
const wakeMock = vi.mocked(wakeIngestionWorkers);
const removeArtifactMock = vi.mocked(removeSourceArtifact);
const removeReportArtifactsMock = vi.mocked(removeReportArtifacts);
const createDirectoryMock = vi.mocked(createUploadResourceDirectory);
const cleanupCreatedMock = vi.mocked(cleanupCreatedUploadResource);
const listDatasetSummariesMock = vi.mocked(py.listDatasetSummaries);
const apps: FastifyInstance[] = [];

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
  qMock.mockReset();
  connectMock.mockReset();
  reserveMock.mockReset();
  reserveMock.mockResolvedValue(1);
  reserveCleanupMock.mockReset();
  reserveCleanupMock.mockResolvedValue(undefined);
  processCleanupMock.mockReset();
  processCleanupMock.mockResolvedValue(0);
  wakeMock.mockReset();
  removeArtifactMock.mockReset();
  removeArtifactMock.mockResolvedValue(true);
  removeReportArtifactsMock.mockReset();
  removeReportArtifactsMock.mockResolvedValue(undefined);
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
  await fs.rm(testState.uploadDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await fs.rm(testState.uploadDir, { recursive: true, force: true });
});

describe("source upload boundaries", () => {
  it("returns bounded, actionable ingestion details without exposing stored raw errors", async () => {
    qMock.mockResolvedValueOnce([
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "ledger",
        kind: "tabular",
        display_name: "Ledger.csv",
        mime: "text/csv",
        size_bytes: 42,
        status: "error",
        meta: {
          error: "raw provider trace must not escape",
          error_code: "EMBEDDING_UNAVAILABLE",
          error_detail: "raw detail must not escape",
        },
        created_at: "2026-08-25T21:34:12.000Z",
        ingestion_attempts: 3,
        ingestion_updated_at: "2026-08-25T21:34:47.000Z",
      },
    ]);
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/sources", headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
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
    ]);
    expect(response.body).not.toContain("raw provider trace");
    expect(response.body).not.toContain("raw detail");
  });

  it("persists the authoritative streamed file size", async () => {
    let insertedPath = "";
    const client = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        if (sql.includes("SELECT 1 FROM sources")) return { rows: [] };
        if (sql.includes("INSERT INTO sources")) {
          insertedPath = String(params?.[5]);
          return {
            rows: [
              {
                id: params?.[0],
                account_id: params?.[1],
                name: params?.[2],
                display_name: params?.[4],
                file_path: params?.[5],
                size_bytes: params?.[7],
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();
    const upload = multipart("ledger.csv", Buffer.from("1234567890"));

    const response = await app.inject({ method: "POST", url: "/api/sources/upload", ...upload });

    expect(response.statusCode).toBe(200);
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sources"));
    expect(insert?.[0]).toContain("size_bytes");
    expect(insert?.[1]?.[7]).toBe(10);
    expect(await fs.stat(insertedPath).then((stat) => stat.size)).toBe(10);
    expect(reserveMock).toHaveBeenCalledWith(client, ACCOUNT, response.json().id);
    expect(wakeMock).toHaveBeenCalledOnce();
  });

  it("detects multipart truncation and removes the partial upload", async () => {
    const app = await buildApp();
    const upload = multipart("too-large.csv", Buffer.from("12345678901234567"));

    const response = await app.inject({ method: "POST", url: "/api/sources/upload", ...upload });

    expect(response.statusCode).toBe(413);
    expect(connectMock).not.toHaveBeenCalled();
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
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported upload extension before filesystem or database persistence", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sources/upload",
      ...multipart("payload.bin", Buffer.from("not a supported document"), "application/octet-stream"),
    });
    expect(response.statusCode).toBe(422);
    expect(connectMock).not.toHaveBeenCalled();
    const accountEntries = await fs.readdir(path.join(testState.uploadDir, ACCOUNT)).catch(() => []);
    expect(accountEntries).toEqual([]);
  });

  it("does not reject a supported text upload solely for ambiguous Word MIME", async () => {
    const client = {
      query: vi.fn(async (sql: string, params?: any[]) => ({
        rows: sql.includes("INSERT INTO sources")
          ? [{ id: params?.[0], account_id: params?.[1], name: params?.[2], file_path: params?.[5] }]
          : [],
      })),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sources/upload",
      ...multipart("renamed.txt", Buffer.from("legacy"), "application/msword"),
    });
    expect(response.statusCode).toBe(200);
    expect(connectMock).toHaveBeenCalledOnce();
  });

  it("deletes source identity with the account predicate before artifact cleanup", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const connectorId = "33333333-3333-4333-8333-333333333333";
    const filePath = path.join(testState.uploadDir, ACCOUNT, sourceId, "ledger.csv");
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ id: sourceId, account_id: ACCOUNT, name: "ledger", connector: connectorId, file_path: filePath }],
        })
        .mockResolvedValueOnce({ rows: [{ sync_status: "idle" }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: sourceId }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/sources/${sourceId}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(client.query.mock.calls[4]).toEqual([
      expect.stringContaining("DELETE FROM sources WHERE id=$1 AND account_id=$2 RETURNING"),
      [sourceId, ACCOUNT],
    ]);
    expect(client.query.mock.calls[5]).toEqual([
      expect.stringContaining("DELETE FROM connectors WHERE id=$1 AND account_id=$2"),
      [connectorId, ACCOUNT],
    ]);
    expect(reserveCleanupMock).toHaveBeenCalledWith(client, ACCOUNT, "ledger", [filePath, "", "", ""]);
  });

  it("rejects deleting a connector-backed source while sync or indexing is active", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const connectorId = "33333333-3333-4333-8333-333333333333";
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ id: sourceId, account_id: ACCOUNT, name: "ledger", connector: connectorId }],
        })
        .mockResolvedValueOnce({ rows: [{ sync_status: "indexing" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/sources/${sourceId}`, headers: auth });

    expect(response.statusCode).toBe(409);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM sources"))).toBe(false);
    expect(removeArtifactMock).not.toHaveBeenCalled();
  });

  it("rejects reingesting a connector source while its connector lifecycle is active", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const connectorId = "33333333-3333-4333-8333-333333333333";
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: sourceId,
              account_id: ACCOUNT,
              name: "ledger",
              file_path: "/safe/cache/ledger.csv",
              connector: connectorId,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ sync_status: "syncing" }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({ method: "POST", url: `/api/sources/${sourceId}/reingest`, headers: auth });

    expect(response.statusCode).toBe(409);
    expect(reserveMock).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE sources"))).toBe(false);
  });
});

describe("report cleanup durability", () => {
  it("keeps the durable row locked until exact files are removed, then deletes it", async () => {
    const reportId = "22222222-2222-4222-8222-222222222222";
    const htmlPath = path.join(testState.uploadDir, "reports", ACCOUNT, reportId, "report.html");
    const pdfPath = path.join(testState.uploadDir, "reports", ACCOUNT, reportId, "report.pdf");
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: reportId, html_path: htmlPath, pdf_path: pdfPath }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/reports/${reportId}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(client.query.mock.calls[1][0]).toContain("FOR UPDATE");
    expect(removeReportArtifactsMock).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      reportId,
      htmlPath,
      pdfPath,
    });
    expect(client.query.mock.calls[2]).toEqual([expect.stringContaining("DELETE FROM reports"), [reportId, ACCOUNT]]);
    expect(removeReportArtifactsMock.mock.invocationCallOrder[0]).toBeLessThan(
      client.query.mock.invocationCallOrder[2]
    );
    expect(client.query.mock.calls[3][0]).toBe("COMMIT");
  });
});
