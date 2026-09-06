/**
 * M12 stage 2 — durable saved-analysis execution against real stores.
 *
 * Every case drives the actual `analysisRunner` over a real SQLite ledger
 * (analysis + source stores) and the real DuckDB worker through the exact
 * `dataService` RPC path: prepared typed binding, exact-location pins,
 * deadline/cancellation behavior, lease-boundary staleness, restart recovery,
 * operation replay, quota-before-execution, shutdown drain, and truthful
 * persisted-result ceilings. Independent expected values are computed from
 * fixture data, never from the implementation.
 *
 * Runs only under `vitest.integration.config.ts` (serialized native stores).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, afterAll, describe, expect, it } from "vitest";

import { AnalysisActiveRunError, AnalysisQuotaError, AnalysisStore } from "../db/stores/analysisStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";
import {
  __configureDatasetWorkerForTests,
  __datasetWorkerDebugState,
  __shutdownDatasetWorker,
  registerDataset,
} from "../data/datasets.js";
import { boundResultForPersistence, createAnalysisRunner, type AnalysisRunner } from "../analysisRunner.js";
import type { StoredAnalysisRun } from "../analysisTypes.js";

const resources: TempSqliteLedger[] = [];
const directories: string[] = [];
const runners: AnalysisRunner[] = [];
const extraLedgers: SqliteLedger[] = [];

async function waitFor(condition: () => Promise<boolean> | boolean, label: string, attempts = 600): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition never held: ${label}`);
}

async function temporaryDirectory(): Promise<string> {
  const created = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-analysis-runner-")));
  directories.push(created);
  return created;
}

async function csvFile(directory: string, name: string, content: string): Promise<string> {
  const file = path.join(directory, name);
  await fs.writeFile(file, content, "utf8");
  return file;
}

async function setup(): Promise<{ ledger: SqliteLedger; store: AnalysisStore; sources: SourceStore; account: string }> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const ledger = resource.ledger;
  const account = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    account,
    `${account}@example.test`,
    "test-hash",
  ]);
  return { ledger, store: new AnalysisStore(ledger), sources: new SourceStore(ledger), account };
}

function ownedRunner(store: AnalysisStore, sources: SourceStore): AnalysisRunner {
  const runner = createAnalysisRunner({
    store,
    sources,
    cancelPollIntervalMs: 40,
    claimIntervalMs: 3_600_000,
    claimBatchLimit: 10,
  });
  runners.push(runner);
  return runner;
}

/**
 * Inserts a ready tabular source row whose stored identity fields
 * (generation/size/path) match the physical CSV, and registers the same
 * exact location with the real DuckDB worker under the source name.
 */
async function attachDataset(
  ledger: SqliteLedger,
  account: string,
  file: string,
  name = `t_${randomUUID().slice(0, 8)}`
): Promise<{ sourceId: string; name: string }> {
  const sourceId = randomUUID();
  const stat = await fs.stat(file);
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,status,meta,ready_generation,size_bytes)
     VALUES (?,?,?,'tabular',?,?,?,?,?,?)`,
    [sourceId, account, name, `${name}.csv`, file, "ready", "{}", 3, stat.size]
  );
  await registerDataset({ accountId: account, name, location: file, kind: "path", originalName: `${name}.csv` });
  return { sourceId, name };
}

async function runStatus(store: AnalysisStore, run: StoredAnalysisRun): Promise<StoredAnalysisRun | undefined> {
  return store.getAnalysisRun(run.accountId, run.analysisId, run.id);
}

async function settle(run: StoredAnalysisRun, store: AnalysisStore): Promise<StoredAnalysisRun> {
  let live = run;
  await waitFor(async () => {
    const current = await runStatus(store, run);
    if (current) live = current;
    return current === undefined || !["queued", "running"].includes(current.status);
  }, "analysis run reached a terminal status");
  return live;
}

function definitionOf(sql: string, parameters: readonly unknown[], sourceIds: readonly string[]) {
  return { title: "Runner analysis", description: "", sql, parameters, sourceIds };
}

const MONTHLY_SQL =
  "SELECT sum(amount) AS total, count(*) AS kept, ? AS marker FROM __TABLE__ WHERE d >= ? AND amount >= ?";
const MONTHLY_PARAMS = [
  { name: "marker", type: "string", required: true },
  { name: "from", type: "date", required: true },
  { name: "floor", type: "integer", required: true },
];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.stop().catch(() => undefined)));
  await __configureDatasetWorkerForTests({ queryTimeoutMs: 30_000, queryPreflightDelay: null }).catch(() => undefined);
  await Promise.all(extraLedgers.splice(0).map((ledger) => ledger.close()));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
  await __shutdownDatasetWorker();
});

describe("saved-analysis runner (real stores + real DuckDB worker)", () => {
  it("executes an accepted run end-to-end with typed values and publishes one bounded result", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "monthly.csv", "d,amount\n2026-01-15,10\n2026-02-15,20\n2026-03-15,30\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_monthly");
    const analysis = await store.createAnalysis(
      account,
      definitionOf(MONTHLY_SQL.replace("__TABLE__", name), MONTHLY_PARAMS, [sourceId])
    );
    const runner = ownedRunner(store, sources);

    const operationId = randomUUID();
    const accepted = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: { marker: "q?1", from: "2026-02-01", floor: 25 },
      operationId,
      waitForCompletion: true,
    });
    expect(accepted.outcome).toBe("queued");
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("succeeded");

    // Independent expectation: only the 2026-03-15 row satisfies both filters.
    const published = await store.listAnalysisResults(account, analysis.id);
    expect(published.items).toHaveLength(1);
    const result = await store.getAnalysisResult(account, analysis.id, published.items[0]!.id);
    expect(result?.rows).toEqual([[30, 1, "q?1"]]);
    expect(result?.columns.map((column) => column.name)).toEqual(["total", "kept", "marker"]);
    expect(result?.returnedRows).toBe(1);
    expect(result?.sourceRowTotal).toBeNull();
    expect(result?.rowCountExact).toBe(false);
    expect(result?.completeness.complete).toBe(true);
    expect(result?.parameterBindings).toEqual([
      { name: "marker", type: "string", value: "q?1" },
      { name: "from", type: "date", value: "2026-02-01" },
      { name: "floor", type: "integer", value: 25 },
    ]);
    expect(result?.sourceProvenance).toEqual(settled.sources);
    expect((await __datasetWorkerDebugState()).analysisPins).toBe(0);
  });

  it("runs a selected-empty definition with typed scalars and zero sources", async () => {
    const { store, sources, account } = await setup();
    const analysis = await store.createAnalysis(
      account,
      definitionOf(
        "SELECT ? AS flag, ? AS ratio, ? AS whole, ? AS day, ? AS greeting, ? AS missing",
        [
          { name: "flag", type: "boolean", required: true },
          { name: "ratio", type: "number", required: true },
          { name: "whole", type: "integer", required: true },
          { name: "day", type: "date", required: true },
          { name: "greeting", type: "string", required: true },
          { name: "missing", type: "string", required: false, nullable: true },
        ],
        []
      )
    );
    const runner = ownedRunner(store, sources);
    const accepted = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: { flag: true, ratio: 0.5, whole: 7, day: "2024-02-29", greeting: "ok?", missing: null },
      waitForCompletion: true,
    });
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("succeeded");
    expect(settled.sources).toEqual([]);

    const results = await store.listAnalysisResults(account, analysis.id);
    const result = await store.getAnalysisResult(account, analysis.id, results.items[0]!.id);
    expect(result?.rows).toEqual([[true, 0.5, 7, "2024-02-29", "ok?", null]]);
  });

  it("treats a zero-row result as a complete success", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "small.csv", "d,amount\n2026-01-15,10\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_zero");
    const analysis = await store.createAnalysis(
      account,
      definitionOf(
        `SELECT d AS month FROM ${name} WHERE d >= ?`,
        [{ name: "from", type: "date", required: true }],
        [sourceId]
      )
    );
    const runner = ownedRunner(store, sources);
    const accepted = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: { from: "2030-01-01" },
      waitForCompletion: true,
    });
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("succeeded");

    const results = await store.listAnalysisResults(account, analysis.id);
    const result = await store.getAnalysisResult(account, analysis.id, results.items[0]!.id);
    expect(result?.returnedRows).toBe(0);
    expect(result?.rows).toEqual([]);
    expect(result?.completeness.complete).toBe(true);
    expect(result?.rowCountExact).toBe(false);
  });

  it("clips the worker result to the persisted ceilings with truthful completeness flags", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const rows = Array.from({ length: 505 }, (_, index) => `${index + 1}`).join("\n");
    const file = await csvFile(directory, "many.csv", `value\n${rows}\n`);
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_many");
    const analysis = await store.createAnalysis(
      account,
      definitionOf(
        `SELECT value FROM ${name} WHERE value >= ? ORDER BY value`,
        [{ name: "floor", type: "integer", required: true }],
        [sourceId]
      )
    );
    const runner = ownedRunner(store, sources);
    const accepted = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: { floor: 1 },
      waitForCompletion: true,
    });
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("succeeded");

    const results = await store.listAnalysisResults(account, analysis.id);
    const result = await store.getAnalysisResult(account, analysis.id, results.items[0]!.id);
    expect(result?.returnedRows).toBe(500);
    expect(result?.completeness.complete).toBe(false);
    expect(result?.completeness.reasons).toContain("worker-truncated");
    expect(result?.rowCountExact).toBe(false);
    expect(result?.sourceRowTotal).toBeNull();
  });

  it("enforces the retained-result quota before execution and creates no run", async () => {
    const { ledger, store, sources, account } = await setup();
    const analysis = await store.createAnalysis(account, definitionOf("SELECT 1 AS one", [], []));
    // Fill the retained-result quota with durable (run, result) pairs.
    for (let index = 0; index < 1000; index += 1) {
      const runId = randomUUID();
      await ledger.run(
        `INSERT INTO analysis_runs (id,account_id,analysis_id,revision,status,parameter_values,finished_at)
         VALUES (?,?,?,1,'succeeded','[]','2026-09-06T10:00:00.000Z')`,
        [runId, account, analysis.id]
      );
      await ledger.run(
        `INSERT INTO analysis_results
           (id,account_id,analysis_id,run_id,revision,columns,rows,returned_rows,source_row_total,row_count_exact)
         VALUES (?,?,?,?,1,'[]','[]',0,NULL,0)`,
        [randomUUID(), account, analysis.id, runId]
      );
    }
    const runner = ownedRunner(store, sources);
    await expect(
      runner.runAnalysisService({ accountId: account, analysisId: analysis.id, values: {} })
    ).rejects.toBeInstanceOf(AnalysisQuotaError);
    expect(await store.listQueuedAnalysisRuns()).toEqual([]);
  });

  it("replays an accepted run for a repeated operation UUID without re-executing", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "replay.csv", "value\n5\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_replay");
    const analysis = await store.createAnalysis(
      account,
      definitionOf(
        `SELECT value * ? AS doubled FROM ${name}`,
        [{ name: "factor", type: "integer", required: true }],
        [sourceId]
      )
    );
    const runner = ownedRunner(store, sources);
    const operationId = randomUUID();
    const first = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: { factor: 2 },
      operationId,
      waitForCompletion: true,
    });
    expect((await settle(first.run, store)).status).toBe("succeeded");

    const second = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: { factor: 2 },
      operationId,
      waitForCompletion: true,
    });
    expect(second.outcome).toBe("replayed");
    expect(second.run.id).toBe(first.run.id);
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(1);
  });

  it("keeps one active run per analysis", async () => {
    const { store, sources, account } = await setup();
    const analysis = await store.createAnalysis(account, definitionOf("SELECT 1 AS one", [], []));
    const accepted = await store.acceptAnalysisRun(account, analysis.id, {});
    expect(accepted.outcome).toBe("queued");
    const runner = ownedRunner(store, sources);
    await expect(
      runner.runAnalysisService({ accountId: account, analysisId: analysis.id, values: {} })
    ).rejects.toBeInstanceOf(AnalysisActiveRunError);
  });

  it("records a durable stale-inputs run when the expected snapshot CAS fails at admission", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "snap.csv", "value\n1\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_snap");
    const analysis = await store.createAnalysis(account, definitionOf(`SELECT value FROM ${name}`, [], [sourceId]));
    const runner = ownedRunner(store, sources);
    const frozen = analysis.sources[0]!;
    const accepted = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: {},
      expectedSourceSnapshot: [{ sourceId, readyGeneration: frozen.readyGeneration! + 1 }],
      waitForCompletion: true,
    });
    expect(accepted.outcome).toBe("stale-inputs");
    expect(accepted.run.status).toBe("stale-inputs");
    expect(accepted.run.errorCode).toBe("ANALYSIS_SNAPSHOT_MISMATCH");
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
  });

  it("marks stale-inputs at the lease boundary when the ledger identity drifted after acceptance", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "drift.csv", "value\n1\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_drift");
    const analysis = await store.createAnalysis(account, definitionOf(`SELECT value FROM ${name}`, [], [sourceId]));
    const accepted = await store.acceptAnalysisRun(account, analysis.id, {});
    expect(accepted.outcome).toBe("queued");

    // The physical bytes changed underneath the accepted snapshot (a refresh
    // landed in the ledger after acceptance).
    await fs.writeFile(file, "value\n1\n2\n", "utf8");
    const stat = await fs.stat(file);
    await ledger.run("UPDATE sources SET size_bytes=? WHERE id=?", [stat.size, sourceId]);

    const runner = ownedRunner(store, sources);
    runner.start();
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("stale-inputs");
    expect(settled.errorCode).toBe("ANALYSIS_INPUTS_STALE");
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
  });

  it("marks stale-inputs when the dataset registry swapped locations after acceptance", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const v1 = await csvFile(directory, "v1.csv", "value\n1\n");
    const v2 = await csvFile(directory, "v2.csv", "value\n99\n");
    const { sourceId, name } = await attachDataset(ledger, account, v1, "runner_swap");
    const analysis = await store.createAnalysis(account, definitionOf(`SELECT value FROM ${name}`, [], [sourceId]));
    const accepted = await store.acceptAnalysisRun(account, analysis.id, {});

    // A refresh activated a new immutable version while the run sat queued;
    // the ledger row advanced too, so this exercises the worker CAS because
    // the run is claimed right at the swapped boundary.
    await registerDataset({ accountId: account, name, location: v2, kind: "path", originalName: "v2.csv" });
    const stat = await fs.stat(v2);
    await ledger.run("UPDATE sources SET file_path=?, size_bytes=?, ready_generation=2 WHERE id=?", [
      v2,
      stat.size,
      sourceId,
    ]);

    const runner = ownedRunner(store, sources);
    runner.start();
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("stale-inputs");
    // The run must not have executed the substituted bytes.
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
  });

  it("cancels a running execution through the durable DELETE-side flag and publishes nothing", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "cancel.csv", "value\n1\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_cancel");
    const analysis = await store.createAnalysis(account, definitionOf(`SELECT value FROM ${name}`, [], [sourceId]));
    await __configureDatasetWorkerForTests({
      queryTimeoutMs: 30_000,
      queryPreflightDelay: { phase: "scope_load", delayMs: 5_000 },
    });
    const runner = ownedRunner(store, sources);
    const accepted = await runner.runAnalysisService({ accountId: account, analysisId: analysis.id, values: {} });
    await waitFor(
      async () => (await __datasetWorkerDebugState()).activeQueryPreflightTestDelays > 0,
      "pinned scope load delay entered"
    );
    expect(await store.requestAnalysisRunCancel(account, analysis.id, accepted.run.id)).toBe("running");
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("cancelled");
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
    await waitFor(async () => (await __datasetWorkerDebugState()).analysisPins === 0, "pins released");
  }, 20_000);

  it("requests durable cancellation when the caller signal aborts mid-run", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "signal.csv", "value\n1\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_signal");
    const analysis = await store.createAnalysis(account, definitionOf(`SELECT value FROM ${name}`, [], [sourceId]));
    await __configureDatasetWorkerForTests({
      queryTimeoutMs: 30_000,
      queryPreflightDelay: { phase: "scope_load", delayMs: 5_000 },
    });
    const runner = ownedRunner(store, sources);
    const controller = new AbortController();
    const dispatched = runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: {},
      signal: controller.signal,
      waitForCompletion: true,
    });
    await waitFor(
      async () => (await __datasetWorkerDebugState()).activeQueryPreflightTestDelays > 0,
      "pinned scope load delay entered"
    );
    controller.abort();
    const accepted = await dispatched;
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("cancelled");
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
  }, 20_000);

  it("fails an interrupted dispatched run on restart without republishing or rerunning it", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "crash.csv", "value\n1\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_crash");
    const analysis = await store.createAnalysis(account, definitionOf(`SELECT value FROM ${name}`, [], [sourceId]));
    const interrupted = await store.acceptAnalysisRun(account, analysis.id, {});
    // Simulate a process crash after dispatch: the row is durably `running`
    // with no in-memory executor, with and without a cancellation request.
    await store.markAnalysisRunRunning(account, analysis.id, interrupted.run.id);
    const cancellingAnalysis = await store.createAnalysis(account, definitionOf("SELECT 8 AS eight", [], []));
    const cancelledToo = await store.acceptAnalysisRun(account, cancellingAnalysis.id, {});
    await store.markAnalysisRunRunning(account, cancellingAnalysis.id, cancelledToo.run.id);
    await store.requestAnalysisRunCancel(account, cancellingAnalysis.id, cancelledToo.run.id);

    const runner = ownedRunner(store, sources);
    runner.start();
    const settled = await settle(interrupted.run, store);
    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("SERVER_RESTARTED");
    const settledCancel = await settle({ ...cancelledToo.run, analysisId: cancellingAnalysis.id }, store);
    expect(settledCancel.status).toBe("cancelled");
    expect(settledCancel.errorCode).toBe("CANCELLED");

    // Recovery must not rerun either interrupted job: no results exist and
    // the rows stay terminal even after the resume loop settles.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
    expect((await runStatus(store, interrupted.run))?.status).toBe("failed");

    // Undispatched queued runs ARE claimed on resume: accept a fresh run
    // (different analysis to dodge the one-active constraint) and start it.
    const second = await store.createAnalysis(account, definitionOf("SELECT 7 AS seven", [], []));
    const queued = await store.acceptAnalysisRun(account, second.id, {});
    const secondRunner = ownedRunner(store, sources);
    secondRunner.start();
    const settledSecond = await settle(queued.run, store);
    expect(settledSecond.status).toBe("succeeded");
    expect(await store.countAnalysisResults(account, second.id)).toBe(1);
  });

  it("finalizes active runs on shutdown drain so no run row is orphaned", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "shutdown.csv", "value\n1\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_shutdown");
    const analysis = await store.createAnalysis(account, definitionOf(`SELECT value FROM ${name}`, [], [sourceId]));
    await __configureDatasetWorkerForTests({
      queryTimeoutMs: 30_000,
      queryPreflightDelay: { phase: "scope_load", delayMs: 5_000 },
    });
    const runner = ownedRunner(store, sources);
    const accepted = await runner.runAnalysisService({ accountId: account, analysisId: analysis.id, values: {} });
    await waitFor(
      async () => (await __datasetWorkerDebugState()).activeQueryPreflightTestDelays > 0,
      "pinned scope load delay entered"
    );
    await runner.stop();
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("SERVER_RESTARTED");
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
    await waitFor(async () => (await __datasetWorkerDebugState()).analysisPins === 0, "pins released");
  }, 20_000);

  it("fails the run with the bounded rejection code when the saved SQL is not executable", async () => {
    const { store, sources, account } = await setup();
    const analysis = await store.createAnalysis(account, definitionOf("DROP TABLE definitely_missing", [], []));
    const runner = ownedRunner(store, sources);
    const accepted = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: {},
      waitForCompletion: true,
    });
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("ANALYSIS_QUERY_REJECTED");
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
  });

  it("surfaces the query deadline as a bounded failure, not staleness", async () => {
    const { ledger, store, sources, account } = await setup();
    const directory = await temporaryDirectory();
    const file = await csvFile(directory, "slow.csv", "value\n1\n");
    const { sourceId, name } = await attachDataset(ledger, account, file, "runner_slow");
    const analysis = await store.createAnalysis(account, definitionOf(`SELECT value FROM ${name}`, [], [sourceId]));
    await __configureDatasetWorkerForTests({
      queryTimeoutMs: 250,
      queryPreflightDelay: { phase: "scope_load", delayMs: 5_000 },
    });
    const runner = ownedRunner(store, sources);
    const accepted = await runner.runAnalysisService({
      accountId: account,
      analysisId: analysis.id,
      values: {},
      waitForCompletion: true,
    });
    const settled = await settle(accepted.run, store);
    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("ANALYSIS_QUERY_TIMEOUT");
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
    await waitFor(async () => (await __datasetWorkerDebugState()).analysisPins === 0, "pins released");
  }, 20_000);

  it("throws before accepting when the caller signal is already aborted", async () => {
    const { store, sources, account } = await setup();
    const analysis = await store.createAnalysis(account, definitionOf("SELECT 1 AS one", [], []));
    const controller = new AbortController();
    controller.abort();
    const runner = ownedRunner(store, sources);
    await expect(
      runner.runAnalysisService({ accountId: account, analysisId: analysis.id, values: {}, signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.listQueuedAnalysisRuns()).toEqual([]);
  });
});

describe("persisted-result bounding (boundResultForPersistence)", () => {
  function result(
    overrides: Partial<{
      columns: string[];
      rows: unknown[][];
      truncated: boolean;
      columns_truncated: boolean;
    }>
  ) {
    return {
      columns: [],
      rows: [],
      row_count: 0,
      returned_row_count: 0,
      columns_truncated: false,
      truncated: false,
      ...overrides,
    } as Parameters<typeof boundResultForPersistence>[0];
  }

  it("passes a complete result through unchanged with a null source total", () => {
    const bounded = boundResultForPersistence(result({ columns: ["a"], rows: [[1], [2]] }));
    expect(bounded.columns).toEqual(["a"]);
    expect(bounded.rows).toEqual([[1], [2]]);
    expect(bounded.sourceRowTotal).toBeNull();
    expect(bounded.truncated).toBeFalsy();
    expect(bounded.reasons).toEqual([]);
  });

  it("clips columns, rows, cells, values, and payload with explicit reasons", () => {
    const manyColumns = Array.from({ length: 70 }, (_, index) => `c${index}`);
    const wideRows = Array.from({ length: 400 }, () => manyColumns.map(() => 1));
    const wide = boundResultForPersistence(result({ columns: manyColumns, rows: wideRows }));
    expect(wide.columns).toHaveLength(64);
    // 20,000 cells / 64 columns ⇒ at most 312 rows.
    expect(wide.rows).toHaveLength(312);
    expect(wide.reasons).toContain("columns-truncated");
    expect(wide.reasons).toContain("cells-truncated");
    expect(wide.truncated).toBe(true);

    const longValue = boundResultForPersistence(result({ columns: ["text"], rows: [["x".repeat(3_000)]] }));
    expect((longValue.rows[0] as readonly unknown[])[0]).toHaveLength(2_000);
    expect(longValue.reasons).toContain("values-truncated");

    const tooManyRows = boundResultForPersistence(
      result({ columns: ["value"], rows: Array.from({ length: 505 }, (_, index) => [index]) })
    );
    expect(tooManyRows.rows).toHaveLength(500);
    expect(tooManyRows.reasons).toContain("rows-truncated");

    const bigCell = "y".repeat(1_900);
    const payloadHeavy = boundResultForPersistence(
      result({
        columns: ["a", "b"],
        rows: Array.from({ length: 500 }, () => [bigCell, bigCell]),
      })
    );
    expect(payloadHeavy.rows.length).toBeLessThan(500);
    expect(payloadHeavy.reasons).toContain("payload-truncated");
  });

  it("merges worker truncation flags into completeness reasons", () => {
    const bounded = boundResultForPersistence(
      result({ columns: ["a"], rows: [[1]], truncated: true, columns_truncated: true })
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.reasons).toContain("columns-truncated");
  });

  it("keeps zero-row results a complete success", () => {
    const bounded = boundResultForPersistence(result({ columns: ["a"], rows: [] }));
    expect(bounded.rows).toEqual([]);
    expect(bounded.truncated).toBeFalsy();
    expect(bounded.reasons).toEqual([]);
  });
});
