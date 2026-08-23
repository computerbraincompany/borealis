import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock("../llm.js", () => ({ embed: vi.fn() }));
vi.mock("../pythonClient.js", () => ({
  PythonServiceError: class PythonServiceError extends Error {
    constructor(readonly status: number) {
      super("data service failure");
    }
  },
  py: {
    health: vi.fn(),
    listDatasets: vi.fn(),
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

import { pool, q } from "../db.js";
import {
  enqueueIngestion,
  processOneJob,
  processOnePreparingConnectorRefresh,
  recoverPreparingConnectorLeases,
  startIngestionWorkers,
} from "../ingest.js";
import { py, PythonServiceError } from "../pythonClient.js";

const qMock = vi.mocked(q);
const connectMock = vi.mocked(pool.connect);
const prepareMock = vi.mocked(py.prepareDatasetRefresh);
const abortMock = vi.mocked(py.abortDatasetRefresh);
const job = {
  source_id: "source-1",
  account_id: "account-1",
  generation: 4,
  attempts: 1,
  lease_token: "11111111-1111-4111-8111-111111111111",
};
const source = {
  id: "source-1",
  account_id: "account-1",
  name: "ledger",
  file_path: "/safe/ledger.csv",
  mime: "text/csv",
  kind: "tabular",
  display_name: "Ledger.csv",
  url: null,
  connector: null,
};
const prepareSource = {
  id: job.source_id,
  account_id: job.account_id,
  name: "ledger",
  file_path: null,
  display_name: "Ledger feed",
  url: "https://example.invalid/ledger.csv",
  mime: "text/csv",
  meta: { connector_refresh_version: "44444444-4444-4444-8444-444444444444" },
  connector_id: "22222222-2222-4222-8222-222222222222",
  type: "url_csv",
  target_table: "ledger",
  config: { url: "https://example.invalid/ledger.csv" },
};

beforeEach(() => {
  qMock.mockReset();
  qMock.mockResolvedValue([]);
  connectMock.mockReset();
  prepareMock.mockReset();
  abortMock.mockReset();
  abortMock.mockResolvedValue({ status: "deleted" });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("durable ingestion worker", () => {
  it("claims with SKIP LOCKED and completes the same generation", async () => {
    const runIngest = vi.fn().mockResolvedValue(undefined);
    qMock.mockResolvedValueOnce([job]).mockResolvedValueOnce([source]).mockResolvedValueOnce([]);

    await expect(processOneJob(runIngest)).resolves.toBe(true);

    expect(qMock.mock.calls[0][0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(qMock.mock.calls[0][0]).toContain("j.attempts");
    expect(runIngest).toHaveBeenCalledWith(expect.objectContaining({ sourceId: source.id, generation: 4 }));
    expect(qMock.mock.calls[2]).toEqual([
      expect.stringContaining("status='done'"),
      [source.id, job.generation, job.lease_token],
    ]);
  });

  it("backs off a transient timeout while preserving prior ready chunks", async () => {
    const runIngest = vi.fn().mockRejectedValue(new Error("upstream request timed out"));
    qMock
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([{ source_id: source.id }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(processOneJob(runIngest)).resolves.toBe(true);

    expect(qMock.mock.calls[2]).toEqual([
      expect.stringContaining("status='pending'"),
      [source.id, job.generation, 2, job.lease_token],
    ]);
    expect(qMock.mock.calls[3][0]).toContain("THEN 'ready'");
    expect(qMock.mock.calls[3][0]).toContain("sources.connector IS NOT NULL THEN 'index'");
    expect(qMock.mock.calls[4][0]).toContain("sync_status='indexing'");
  });

  it("marks deterministic parsing failures terminal without retry", async () => {
    const runIngest = vi.fn().mockRejectedValue(new Error("no readable text extracted"));
    qMock.mockResolvedValueOnce([job]).mockResolvedValueOnce([source]).mockResolvedValueOnce([]);

    await expect(processOneJob(runIngest)).resolves.toBe(true);

    expect(qMock.mock.calls[2][0]).toContain("status='error'");
    expect(qMock.mock.calls.some(([sql]) => String(sql).includes("TRANSIENT_FAILURE"))).toBe(false);
  });

  it("terminates a claimed job whose source was deleted", async () => {
    qMock.mockResolvedValueOnce([job]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(processOneJob(vi.fn())).resolves.toBe(true);

    expect(qMock.mock.calls[2]).toEqual([
      expect.stringContaining("SOURCE_UNAVAILABLE"),
      [job.source_id, job.generation],
    ]);
  });

  it("ingests a first-time connector from its prepared candidate while file_path is still null", async () => {
    const candidatePath = "/safe/cache/connector-candidate.csv";
    const firstSyncSource = {
      ...source,
      file_path: null,
      connector: "22222222-2222-4222-8222-222222222222",
      meta: { connector_candidate_location: candidatePath },
    };
    const runIngest = vi.fn().mockResolvedValue(undefined);
    qMock.mockResolvedValueOnce([job]).mockResolvedValueOnce([firstSyncSource]).mockResolvedValueOnce([]);

    await expect(processOneJob(runIngest)).resolves.toBe(true);

    expect(runIngest).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: source.id, filePath: candidatePath, connector: firstSyncSource.connector })
    );
    expect(qMock.mock.calls.some(([sql]) => String(sql).includes("SOURCE_UNAVAILABLE"))).toBe(false);
  });

  it("serializes duplicate source claims even if a database mock returns the same job", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runIngest = vi.fn(() => held);
    qMock
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const first = processOneJob(runIngest);
    await vi.waitFor(() => expect(runIngest).toHaveBeenCalledOnce());
    await expect(processOneJob(runIngest)).resolves.toBe(true);
    release();
    await first;

    expect(runIngest).toHaveBeenCalledOnce();
    const noExecutionRequeue = qMock.mock.calls.find(([sql]) => String(sql).includes("interval '1 second'"));
    expect(noExecutionRequeue?.[0]).toContain("attempts=GREATEST(0,attempts-1)");
    expect(noExecutionRequeue?.[1]).toEqual([job.source_id, job.generation, job.lease_token]);
  });

  it("releases the in-process source claim when the source lookup itself fails", async () => {
    const runIngest = vi.fn().mockResolvedValue(undefined);
    qMock
      .mockResolvedValueOnce([job])
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([]);

    await expect(processOneJob(runIngest)).rejects.toThrow("database unavailable");
    await expect(processOneJob(runIngest)).resolves.toBe(true);

    expect(runIngest).toHaveBeenCalledOnce();
  });

  it("increments generation and resets attempts when superseded", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ generation: 7 }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client as any);

    await expect(enqueueIngestion("account-1", "source-1")).resolves.toBe(7);
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.query.mock.calls[0][0]).toContain("generation=ingestion_jobs.generation+1");
    expect(client.query.mock.calls[0][0]).toContain("attempts=0");
    expect(client.query.mock.calls[1][0]).toContain("DELETE FROM ingestion_chunk_staging");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("recovers every running lease immediately on single-process startup", async () => {
    vi.useFakeTimers();
    qMock.mockResolvedValue([]);

    await startIngestionWorkers();
    await Promise.resolve();

    expect(qMock.mock.calls[0][0]).toContain("WHERE status='running'");
    expect(qMock.mock.calls[0][0]).not.toContain("leased_at <");
    expect(qMock.mock.calls.some(([sql]) => String(sql).includes("WHERE status='preparing'"))).toBe(true);
    expect(qMock.mock.calls.some(([sql]) => String(sql).includes("WHERE status='index'"))).toBe(true);
  });

  it("reclaims every inherited prepare lease at startup but only expired leases periodically", async () => {
    qMock.mockResolvedValueOnce([{ source_id: job.source_id }]).mockResolvedValueOnce([]);

    await expect(recoverPreparingConnectorLeases(true)).resolves.toBe(1);
    await expect(recoverPreparingConnectorLeases()).resolves.toBe(0);

    const startupSql = String(qMock.mock.calls[0][0]);
    expect(startupSql).toContain("status='preparing'");
    expect(startupSql).toContain("PROCESS_RESTARTED");
    expect(startupSql).not.toContain("leased_at <");
    expect(qMock.mock.calls[0][1]).toBeUndefined();

    const periodicSql = String(qMock.mock.calls[1][0]);
    expect(periodicSql).toContain("status='preparing'");
    expect(periodicSql).toContain("PREPARE_LEASE_EXPIRED");
    expect(periodicSql).toContain("leased_at <");
    expect(qMock.mock.calls[1][1]).toEqual([10]);
  });

  it("backs off a transient prepare failure only while the exact lease remains owned", async () => {
    prepareMock.mockRejectedValueOnce(new PythonServiceError(503, "/datasets/prepare"));
    qMock.mockResolvedValueOnce([job]).mockResolvedValueOnce([prepareSource]).mockResolvedValueOnce([]);

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(true);

    expect(abortMock).toHaveBeenCalledWith(
      job.account_id,
      prepareSource.target_table,
      prepareSource.meta.connector_refresh_version,
      "csv"
    );
    expect(qMock.mock.calls[2]).toEqual([
      expect.stringContaining("status='preparing' AND lease_token=$4"),
      [job.source_id, job.account_id, job.generation, job.lease_token, "PREPARE_TRANSIENT"],
    ]);
    expect(qMock.mock.calls[2][0]).not.toContain("status='error'");
  });

  it("keeps an uncertain prepare outcome retryable under the exact ownership token", async () => {
    prepareMock.mockRejectedValueOnce(new Error("response lost"));
    abortMock.mockRejectedValueOnce(new Error("abort confirmation lost"));
    qMock.mockResolvedValueOnce([job]).mockResolvedValueOnce([prepareSource]).mockResolvedValueOnce([]);

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(true);

    expect(qMock.mock.calls[2]).toEqual([
      expect.stringContaining("status='preparing' AND lease_token=$4"),
      [job.source_id, job.account_id, job.generation, job.lease_token, "PREPARE_OUTCOME_UNCERTAIN"],
    ]);
  });

  it("terminalizes a permanent prepare failure only through the exact job ownership CTE", async () => {
    prepareMock.mockRejectedValueOnce(new PythonServiceError(400, "/datasets/prepare"));
    qMock
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([prepareSource])
      .mockResolvedValueOnce([{ id: prepareSource.connector_id }]);

    await expect(processOnePreparingConnectorRefresh()).resolves.toBe(true);

    expect(qMock.mock.calls[2]).toEqual([
      expect.stringContaining("status='error'"),
      [job.source_id, job.account_id, job.generation, job.lease_token, "PREPARE_FAILED"],
    ]);
    expect(qMock.mock.calls[2][0]).toContain("status='preparing' AND lease_token=$4");
    expect(qMock.mock.calls[2][0]).toContain("FROM failed_job");
  });
});
