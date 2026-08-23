import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  q: vi.fn(),
  pool: { connect: vi.fn(), query: vi.fn() },
}));
vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../ingest.js", () => ({
  processDatasetCacheCleanup: vi.fn(),
  reserveDatasetCacheCleanup: vi.fn(),
  wakeConnectorPrepareWorkers: vi.fn(),
  wakeIngestionWorkers: vi.fn(),
  isTabularSource: vi.fn(() => true),
  sanitizeDatasetName: vi.fn((name: string) => name),
}));
vi.mock("../pythonClient.js", () => ({
  PythonServiceError: class PythonServiceError extends Error {
    constructor(readonly status: number) {
      super("data service error");
    }
  },
  py: {
    prepareDatasetRefresh: vi.fn(),
    abortDatasetRefresh: vi.fn(),
    deactivateDatasetLocation: vi.fn(),
    cleanupDatasetCache: vi.fn(),
  },
}));

import { signToken } from "../auth.js";
import { q } from "../db.js";
import { pool } from "../db.js";
import { processDatasetCacheCleanup, reserveDatasetCacheCleanup, wakeIngestionWorkers } from "../ingest.js";
import { py } from "../pythonClient.js";
import { routes } from "../routes.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CONNECTOR = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const auth = { authorization: `Bearer ${signToken({ userId: ACCOUNT, email: "owner@example.test" })}` };
const qMock = vi.mocked(q);
const prepareMock = vi.mocked(py.prepareDatasetRefresh);
const abortMock = vi.mocked(py.abortDatasetRefresh);
const reserveCleanupMock = vi.mocked(reserveDatasetCacheCleanup);
const processCleanupMock = vi.mocked(processDatasetCacheCleanup);
const wakeMock = vi.mocked(wakeIngestionWorkers);
const connectMock = vi.mocked(pool.connect);
const apps: FastifyInstance[] = [];

async function buildApp() {
  const app = Fastify();
  apps.push(app);
  await routes(app);
  await app.ready();
  return app;
}

function syncReservationClient(source: any) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE connectors SET sync_status='syncing'")) {
        return { rows: [{ id: CONNECTOR, sync_status: "syncing" }] };
      }
      if (sql.includes("SELECT id, file_path")) return { rows: [source] };
      if (sql.includes("FROM chat_runs")) return { rows: [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

beforeEach(() => {
  qMock.mockReset();
  prepareMock.mockReset();
  prepareMock.mockImplementation(async (_account, _name, version, _url, _original, expectedFormat) => ({
    version,
    location: `/safe/cache/${version.replaceAll("-", "")}.${expectedFormat}`,
    previous_location: "/safe/cache/previous.csv",
    rows: 1,
    size_bytes: 10,
  }));
  abortMock.mockReset();
  abortMock.mockResolvedValue({ status: "deleted" });
  reserveCleanupMock.mockReset();
  reserveCleanupMock.mockResolvedValue(undefined);
  processCleanupMock.mockReset();
  processCleanupMock.mockResolvedValue(0);
  wakeMock.mockReset();
  connectMock.mockReset();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("connector synchronization", () => {
  it.each(["", "2026_ledger", "bad-name", "x".repeat(64)])(
    "rejects invalid explicit target table %j before reserving identity",
    async (targetTable) => {
      const app = await buildApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/connectors",
        headers: auth,
        payload: {
          display_name: "Ledger",
          target_table: targetTable,
          type: "url_csv",
          config: { url: "https://example.invalid/ledger.csv" },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(connectMock).not.toHaveBeenCalled();
      expect(qMock).not.toHaveBeenCalled();
    }
  );

  it("returns a conflict before Python mutation when the reserved table identity already exists", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: {
        display_name: "Ledger",
        target_table: "ledger",
        type: "url_csv",
        config: { url: "https://example.invalid/ledger.csv" },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["url_json", "events", "https://example.invalid/events.json?signature=secret", "json"],
    ["url_csv", "ledger", "https://example.invalid/ledger.csv", "csv"],
  ] as const)("stages an immutable %s refresh before durable indexing", async (type, table, url, format) => {
    const connector = {
      id: CONNECTOR,
      account_id: ACCOUNT,
      name: "Feed",
      type,
      config: { url },
      target_table: table,
      sync_status: "idle",
    };
    const source = {
      id: SOURCE,
      file_path: `/safe/cache/previous.${format}`,
      name: table,
      kind: "tabular",
      status: "ready",
    };
    const client = syncReservationClient(source);
    connectMock.mockResolvedValueOnce(client as any);
    qMock.mockResolvedValueOnce([connector]).mockResolvedValueOnce([{ id: CONNECTOR }]);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(prepareMock).toHaveBeenCalledWith(
      ACCOUNT,
      table,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      url,
      "Feed",
      format
    );
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("status='index'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("status='preparing'"))).toBe(true);
    const preparingCall = client.query.mock.calls.findIndex(([sql]) => String(sql).includes("status='preparing'"));
    const commitCall = client.query.mock.calls.findIndex(([sql]) => sql === "COMMIT");
    expect(preparingCall).toBeGreaterThan(-1);
    expect(commitCall).toBeGreaterThan(preparingCall);
    expect(client.query.mock.invocationCallOrder[commitCall]).toBeLessThan(prepareMock.mock.invocationCallOrder[0]);
    expect(qMock.mock.calls[1][0]).toContain("status='pending'");
    expect(wakeMock).toHaveBeenCalledOnce();
  });

  it("terminalizes sync without a name-only mutation when the reserved source disappeared", async () => {
    const connector = {
      id: CONNECTOR,
      account_id: ACCOUNT,
      name: "Ledger",
      type: "url_csv",
      config: { url: "https://example.invalid/ledger.csv" },
      target_table: "ledger",
      sync_status: "idle",
    };
    const client = syncReservationClient(undefined);
    connectMock.mockResolvedValueOnce(client as any);
    qMock
      .mockResolvedValueOnce([connector])
      .mockResolvedValueOnce([{ id: CONNECTOR }])
      .mockResolvedValueOnce([]);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });

    expect(response.statusCode).toBe(422);
    expect(qMock.mock.calls[1][0]).toContain("sync_status='error'");
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("keeps a new connector source non-ready until ingestion commits", async () => {
    const connector = {
      id: CONNECTOR,
      account_id: ACCOUNT,
      name: "Events feed",
      type: "url_json",
      config: { url: "https://example.invalid/events.json", name: "Events" },
      target_table: "events_feed",
    };
    const createdSource = {
      id: SOURCE,
      file_path: null,
      name: "events_feed",
      kind: "tabular",
      status: "index",
    };
    const createClient = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("INSERT INTO connectors")
          ? [connector]
          : sql.includes("INSERT INTO sources")
            ? [createdSource]
            : [],
      })),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(createClient as any);
    qMock.mockResolvedValueOnce([{ id: CONNECTOR }]).mockResolvedValueOnce([{ ...connector, sync_status: "indexing" }]);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: {
        display_name: connector.name,
        target_table: connector.target_table,
        type: connector.type,
        config: { url: connector.config.url },
      },
    });

    expect(response.statusCode).toBe(200);
    const sourceInsert = createClient.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sources"));
    expect(sourceInsert?.[0]).toContain("'index'");
    expect(sourceInsert?.[0]).not.toContain("'ready'");
    const preparingCall = createClient.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("INSERT INTO ingestion_jobs")
    );
    const commitCall = createClient.query.mock.calls.findIndex(([sql]) => sql === "COMMIT");
    const preparingInvocation = createClient.query.mock.calls[preparingCall] as unknown as [string, unknown[]?];
    expect(preparingCall).toBeGreaterThan(-1);
    expect(preparingInvocation[0]).toContain("'preparing'");
    expect(preparingInvocation[1]).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      ACCOUNT,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ]);
    expect(commitCall).toBeGreaterThan(preparingCall);
    expect(createClient.query.mock.invocationCallOrder[commitCall]).toBeLessThan(
      prepareMock.mock.invocationCallOrder[0]
    );
    expect(connectMock).toHaveBeenCalledOnce();
    expect(prepareMock).toHaveBeenCalledWith(
      ACCOUNT,
      "events_feed",
      expect.any(String),
      connector.config.url,
      connector.name,
      "json"
    );
    expect(wakeMock).toHaveBeenCalledOnce();
  });

  it("deletes account-scoped source identity before deleting its connector", async () => {
    const connector = {
      id: CONNECTOR,
      account_id: ACCOUNT,
      target_table: "ledger",
      sync_status: "idle",
    };
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [connector] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: SOURCE,
              account_id: ACCOUNT,
              name: "ledger",
              connector: CONNECTOR,
              file_path: "/safe/cache/current.csv",
              meta: {
                connector_previous_location: "/safe/cache/previous.csv",
                connector_candidate_location: "/safe/cache/candidate.csv",
                connector_activation_previous_location: "/safe/cache/activation-previous.csv",
              },
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);
    const app = await buildApp();

    const response = await app.inject({ method: "DELETE", url: `/api/connectors/${CONNECTOR}`, headers: auth });

    expect(response.statusCode).toBe(200);
    expect(reserveCleanupMock).toHaveBeenCalledWith(client, ACCOUNT, "ledger", [
      "/safe/cache/current.csv",
      "/safe/cache/previous.csv",
      "/safe/cache/candidate.csv",
      "/safe/cache/activation-previous.csv",
    ]);
    expect(client.query.mock.calls[2]).toEqual([
      expect.stringContaining("WHERE connector=$1 AND account_id=$2 FOR UPDATE"),
      [CONNECTOR, ACCOUNT],
    ]);
    expect(client.query.mock.calls[4]).toEqual([
      expect.stringContaining("DELETE FROM sources WHERE connector=$1 AND account_id=$2"),
      [CONNECTOR, ACCOUNT],
    ]);
    expect(client.query.mock.calls[5]).toEqual([
      expect.stringContaining("DELETE FROM connectors WHERE id=$1 AND account_id=$2"),
      [CONNECTOR, ACCOUNT],
    ]);
  });
});
