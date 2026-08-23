import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  q: vi.fn(),
  pool: { connect: vi.fn(), query: vi.fn() },
}));
vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));
vi.mock("../ingest.js", () => ({
  ingestSource: vi.fn(),
  isTabularSource: vi.fn(() => true),
  sanitizeDatasetName: vi.fn((name: string) => name),
}));
vi.mock("../pythonClient.js", () => ({
  py: {
    registerDataset: vi.fn(),
    resync: vi.fn(),
  },
}));

import { signToken } from "../auth.js";
import { q } from "../db.js";
import { ingestSource } from "../ingest.js";
import { py } from "../pythonClient.js";
import { routes } from "../routes.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CONNECTOR = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const auth = { authorization: `Bearer ${signToken({ userId: ACCOUNT, email: "owner@example.test" })}` };
const qMock = vi.mocked(q);
const registerMock = vi.mocked(py.registerDataset);
const resyncMock = vi.mocked(py.resync);
const ingestMock = vi.mocked(ingestSource);
const apps: FastifyInstance[] = [];

async function buildApp() {
  const app = Fastify();
  apps.push(app);
  await routes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  qMock.mockReset();
  registerMock.mockReset();
  resyncMock.mockReset();
  ingestMock.mockReset();
  ingestMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("connector synchronization", () => {
  it("restores missing URL metadata then force-resyncs an existing JSON connector", async () => {
    const connector = {
      id: CONNECTOR,
      account_id: ACCOUNT,
      name: "Events feed",
      type: "url_json",
      config: { url: "https://example.invalid/events.json?signature=secret", name: "Events" },
      target_table: "events",
    };
    const source = {
      id: SOURCE,
      file_path: "/safe/cache/events.json",
      name: "events",
      kind: "tabular",
    };
    qMock
      .mockResolvedValueOnce([connector])
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    resyncMock.mockResolvedValueOnce({ location: "/safe/cache/events.csv" } as any);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(registerMock).not.toHaveBeenCalled();
    expect(resyncMock).toHaveBeenCalledWith(ACCOUNT, "events", connector.config.url, "Events");
    expect(qMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE sources SET file_path=$2"),
      [SOURCE, "/safe/cache/events.csv", ACCOUNT]
    );
    expect(ingestMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: SOURCE,
      filePath: "/safe/cache/events.csv",
      kind: "tabular",
      url: connector.config.url,
      connector: CONNECTOR,
    }));
  });

  it("force-resyncs an existing CSV connector when the Python registry is warm", async () => {
    const connector = {
      id: CONNECTOR,
      account_id: ACCOUNT,
      name: "Ledger",
      type: "url_csv",
      config: { url: "https://example.invalid/ledger.csv" },
      target_table: "ledger",
    };
    const source = { id: SOURCE, file_path: "/safe/cache/ledger.csv", name: "ledger", kind: "tabular" };
    qMock
      .mockResolvedValueOnce([connector])
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([]);
    resyncMock.mockResolvedValueOnce({ location: source.file_path } as any);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${CONNECTOR}/sync`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(registerMock).not.toHaveBeenCalled();
    expect(resyncMock).toHaveBeenCalledWith(ACCOUNT, "ledger", connector.config.url, "Ledger");
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
      file_path: "/safe/cache/events.json",
      name: "events_feed",
      kind: "tabular",
      status: "index",
    };
    qMock
      .mockResolvedValueOnce([connector])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdSource])
      .mockResolvedValueOnce([]);
    registerMock.mockResolvedValueOnce({ location: createdSource.file_path } as any);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      headers: auth,
      payload: {
        name: connector.name,
        type: connector.type,
        config: connector.config,
      },
    });

    expect(response.statusCode).toBe(200);
    const sourceInsert = qMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sources"));
    expect(sourceInsert?.[0]).toContain("'index'");
    expect(sourceInsert?.[0]).not.toContain("'ready'");
    expect(ingestMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: SOURCE,
      kind: "tabular",
    }));
  });
});
