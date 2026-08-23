import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock("../pythonClient.js", () => ({
  PythonServiceError: class PythonServiceError extends Error {},
  py: {
    registerDataset: vi.fn(),
    listDatasets: vi.fn(),
    deactivateDatasetLocation: vi.fn(),
    cleanupDatasetCache: vi.fn(),
    health: vi.fn(),
  },
}));
vi.mock("../storageArtifacts.js", () => ({
  resolveSourceArtifact: vi.fn(async ({ filePath }: { filePath: string }) => filePath),
}));

import { pool, q } from "../db.js";
import { restoreDatasets } from "../ingest.js";
import { py } from "../pythonClient.js";
import { resolveSourceArtifact } from "../storageArtifacts.js";

const qMock = vi.mocked(q);
const registerMock = vi.mocked(py.registerDataset);
const healthMock = vi.mocked(py.health);
const listMock = vi.mocked(py.listDatasets);
const deactivateMock = vi.mocked(py.deactivateDatasetLocation);
const cleanupMock = vi.mocked(py.cleanupDatasetCache);
const connectMock = vi.mocked(pool.connect);
const resolveSourceArtifactMock = vi.mocked(resolveSourceArtifact);

beforeEach(() => {
  qMock.mockReset();
  registerMock.mockReset();
  healthMock.mockReset();
  listMock.mockReset();
  deactivateMock.mockReset();
  deactivateMock.mockResolvedValue({ status: "dropped" });
  cleanupMock.mockReset();
  cleanupMock.mockResolvedValue({ status: "deleted" });
  connectMock.mockReset();
  resolveSourceArtifactMock.mockClear();
  connectMock.mockResolvedValue({
    query: vi.fn(async (sql: string) => ({ rows: sql.includes("SELECT id FROM sources") ? [{ id: "source" }] : [] })),
    release: vi.fn(),
  } as any);
  healthMock.mockResolvedValue(true);
  listMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dataset restoration", () => {
  it("restores uploads as paths and connectors with URL provenance", async () => {
    qMock.mockResolvedValueOnce([
      {
        account_id: "acct-upload",
        source_id: "11111111-1111-4111-8111-111111111111",
        name: "ledger",
        file_path: "/safe/uploads/ledger.json",
        display_name: "Ledger.json",
        url: null,
        connector: null,
        status: "ready",
      },
      {
        account_id: "acct-connector",
        source_id: "22222222-2222-4222-8222-222222222222",
        name: "balances",
        file_path: "/safe/cache/balances.csv",
        display_name: "Balances feed",
        url: "https://example.invalid/balances.csv?signature=secret",
        connector: "connector-id",
        mime: "text/csv",
        status: "ready",
      },
    ]);
    registerMock.mockResolvedValue([] as any);
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await restoreDatasets()).toEqual({
      attempted: 2,
      restored: 2,
      failed: 0,
      stale_attempted: 0,
      removed: 0,
      remove_failed: 0,
    });

    expect(registerMock).toHaveBeenNthCalledWith(1, "acct-upload", "ledger", {
      location: "/safe/uploads/ledger.json",
      kind: "path",
      originalName: "Ledger.json",
      sourceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(resolveSourceArtifactMock).toHaveBeenCalledTimes(2);
    expect(registerMock).toHaveBeenNthCalledWith(2, "acct-connector", "balances", {
      location: "/safe/cache/balances.csv",
      kind: "url",
      url: "https://example.invalid/balances.csv?signature=secret",
      originalName: "Balances feed",
      expectedFormat: "csv",
    });
  });

  it("performs no registrations when the healthy registry already matches", async () => {
    qMock.mockResolvedValueOnce([
      {
        account_id: "acct-upload",
        name: "ledger",
        file_path: "/safe/uploads/ledger.json",
        display_name: "Ledger.json",
        url: null,
        connector: null,
        status: "ready",
      },
    ]);
    listMock.mockResolvedValueOnce([{ table: "ledger", location: "/safe/uploads/ledger.json", exists: true }]);

    expect(await restoreDatasets()).toEqual({
      attempted: 0,
      restored: 0,
      failed: 0,
      stale_attempted: 0,
      removed: 0,
      remove_failed: 0,
    });
    expect(registerMock).not.toHaveBeenCalled();
  });

  it("removes stale Python identities that no longer exist in the account ledger", async () => {
    qMock.mockResolvedValueOnce([
      {
        account_id: "acct-upload",
        name: null,
        file_path: null,
        display_name: null,
        url: null,
        connector: null,
        mime: null,
        status: null,
      },
    ]);
    listMock.mockResolvedValueOnce([{ table: "deleted_table", location: "/stale.csv", kind: "url", exists: true }]);

    expect(await restoreDatasets()).toEqual({
      attempted: 0,
      restored: 0,
      failed: 0,
      stale_attempted: 1,
      removed: 1,
      remove_failed: 0,
    });
    expect(deactivateMock).toHaveBeenCalledWith("acct-upload", "deleted_table", "/stale.csv");
    expect(cleanupMock).toHaveBeenCalledWith("acct-upload", "deleted_table", "/stale.csv");
  });

  it("removes a terminal-error table while preserving an actively indexing identity", async () => {
    qMock.mockResolvedValueOnce([
      {
        account_id: "acct-upload",
        name: "failed_table",
        file_path: "/safe/failed.csv",
        display_name: "Failed.csv",
        status: "error",
      },
      {
        account_id: "acct-upload",
        name: "active_table",
        file_path: "/safe/active.csv",
        display_name: "Active.csv",
        status: "index",
      },
    ]);
    listMock.mockResolvedValueOnce([
      { table: "failed_table", location: "/safe/failed.csv", kind: "url", exists: true },
      { table: "active_table", location: "/safe/active.csv", exists: true },
    ]);

    expect(await restoreDatasets()).toMatchObject({ stale_attempted: 1, removed: 1, remove_failed: 0 });
    expect(deactivateMock).toHaveBeenCalledTimes(1);
    expect(deactivateMock).toHaveBeenCalledWith("acct-upload", "failed_table", "/safe/failed.csv");
  });
});
