/**
 * Startup-window regression (journey-B defect, milestones/M12): after a
 * backend restart the ledger already reports ready tabular sources while
 * `restoreDatasets()` rehydrates the DuckDB dataset registry asynchronously
 * behind the server's ready line — yet `/api/health` used to compose as
 * operational and admitted analysis runs finalized durable `stale-inputs`
 * even though their inputs existed.
 *
 * These cases hold the restoration provably in flight through the test-only
 * restore gate and prove the honest admission/health contract over the real
 * SQLite ledger, real `dataService`/DuckDB worker, real `restoreDatasets`,
 * and the real `checkSystemHealth` composition:
 * - health reports not-operational (via the `data_service` prerequisite)
 *   while the restoration is in flight, then operational once hydrated;
 * - a run accepted inside the window AWAITS the restoration and then succeeds
 *   against its real pinned inputs (no false stale-inputs);
 * - a deadline exceedance still finalizes an honest durable `stale-inputs`,
 *   and a post-restoration run succeeds against the rebuilt registry.
 *
 * Runs only under `vitest.integration.config.ts` (serialized native stores).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalysisStore } from "../db/stores/analysisStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import type { SqliteLedger } from "../db/types.js";
import { config } from "../config.js";
import { dataService } from "../dataService.js";
import { __shutdownDatasetWorker } from "../data/datasets.js";
import { datasetRegistryRehydrationPending } from "../data/registryHydration.js";
import { __setDatasetRegistryRestoreGateForTests, restoreDatasets, type RestoreSummary } from "../ingest.js";
import { closeRuntimeSettings, initializeRuntimeSettings } from "../runtimeSettings.js";
import { createAnalysisRunner, type AnalysisRunner } from "../analysisRunner.js";
import { closeStorageRuntime, initializeStorageRuntime } from "../storageRuntime.js";
import { checkSystemHealth } from "../systemHealth.js";
import type { StoredAnalysisRun } from "../analysisTypes.js";

interface StartupState {
  ledger: SqliteLedger;
  store: AnalysisStore;
  sources: SourceStore;
  account: string;
  sourceId: string;
  table: string;
  file: string;
}

const runners: AnalysisRunner[] = [];
const directories: string[] = [];
let originalUploadDir = "";
let restoreRelease: (() => void) | undefined;

async function waitFor(condition: () => Promise<boolean> | boolean, label: string, attempts = 1_500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition never held: ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function temporaryDirectory(): Promise<string> {
  const created = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-startup-window-")));
  directories.push(created);
  return created;
}

beforeEach(async () => {
  originalUploadDir = config.uploadDir;
  const directory = await temporaryDirectory();
  config.uploadDir = path.join(directory, "uploads");
  await fs.mkdir(config.uploadDir, { recursive: true });
  await initializeRuntimeSettings({ settingsFile: path.join(directory, "settings.json"), env: {} });
  // The model-endpoint probe is unrelated readiness here; keep it deterministic
  // so the health assertions isolate exactly the data-service prerequisite.
  const cancel = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: { cancel } }));
});

afterEach(async () => {
  // Never leave a gated restoration, a live runner, or a mutated config behind.
  restoreRelease?.();
  restoreRelease = undefined;
  __setDatasetRegistryRestoreGateForTests(undefined);
  await Promise.all(runners.splice(0).map((runner) => runner.stop().catch(() => undefined)));
  await closeStorageRuntime().catch(() => undefined);
  vi.unstubAllGlobals();
  closeRuntimeSettings();
  config.uploadDir = originalUploadDir;
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
  await __shutdownDatasetWorker();
});

/**
 * Post-restart state: the real ledger reports a ready tabular source whose
 * bytes live in the exact account/source upload directory, while the DuckDB
 * worker registry is still empty for that fresh account — the restoration has
 * not registered anything yet.
 */
async function startupState(table: string): Promise<StartupState> {
  const directory = await temporaryDirectory();
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(directory, "borealis.sqlite"),
    lanceDirectory: path.join(directory, "lancedb"),
    embeddingDimension: 3,
  });
  const ledger = runtime.ledger;
  const account = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    account,
    `${account}@example.test`,
    "test-hash",
  ]);
  const sourceId = randomUUID();
  const sourceDirectory = path.join(config.uploadDir, account, sourceId);
  await fs.mkdir(sourceDirectory, { recursive: true });
  const file = path.join(sourceDirectory, "data.csv");
  await fs.writeFile(file, "d,amount\n2026-01-15,10\n2026-02-15,20\n2026-03-15,30\n", "utf8");
  const stat = await fs.stat(file);
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,status,meta,ready_generation,size_bytes)
     VALUES (?,?,?,'tabular',?,?,?,?,?,?)`,
    [sourceId, account, table, `${table}.csv`, file, "ready", "{}", 3, stat.size]
  );
  return {
    ledger,
    store: new AnalysisStore(ledger),
    sources: new SourceStore(ledger),
    account,
    sourceId,
    table,
    file,
  };
}

function ownedRunner(state: StartupState, registryHydrationDeadlineMs?: number): AnalysisRunner {
  const runner = createAnalysisRunner({
    store: state.store,
    sources: state.sources,
    claimIntervalMs: 3_600_000,
    claimBatchLimit: 10,
    ...(registryHydrationDeadlineMs === undefined ? {} : { registryHydrationDeadlineMs }),
  });
  runners.push(runner);
  return runner;
}

function definitionOf(state: StartupState) {
  return {
    title: "Startup window analysis",
    description: "",
    sql: `SELECT count(*) AS kept FROM ${state.table} WHERE amount >= ?`,
    parameters: [{ name: "floor", type: "integer", required: true }],
    sourceIds: [state.sourceId],
  };
}

async function runStatus(state: StartupState, run: StoredAnalysisRun): Promise<StoredAnalysisRun | undefined> {
  return state.store.getAnalysisRun(run.accountId, run.analysisId, run.id);
}

async function settle(state: StartupState, run: StoredAnalysisRun): Promise<StoredAnalysisRun> {
  let live = run;
  await waitFor(async () => {
    const current = await runStatus(state, run);
    if (current) live = current;
    return current === undefined || !["queued", "running"].includes(current.status);
  }, "analysis run reached a terminal status");
  return live;
}

/** Starts a gated restoration; the window is provably in flight on return. */
function gateRestoration(): Promise<RestoreSummary> {
  const gate = new Promise<void>((resolve) => {
    restoreRelease = resolve;
  });
  __setDatasetRegistryRestoreGateForTests(() => gate);
  const restoration = restoreDatasets();
  expect(datasetRegistryRehydrationPending()).toBe(true);
  return restoration;
}

describe("startup dataset-registry rehydration window", () => {
  it(
    "awaits the in-flight restoration, executes against the real inputs, and flips health operational",
    { timeout: 90_000 },
    async () => {
      const state = await startupState("window_ok");
      const analysis = await state.store.createAnalysis(state.account, definitionOf(state));
      const restoration = gateRestoration();
      try {
        // Health is honest during the window: the worker itself is healthy,
        // only the pending rehydration degrades the data-service prerequisite.
        const during = await checkSystemHealth();
        expect(during.status).toBe("degraded");
        expect(during.services.find((service) => service.id === "data_service")?.status).toBe("unavailable");

        // The registry is still empty while the restoration waits at the gate.
        const listed = await dataService.listDatasets(state.account);
        expect(listed.find((dataset) => String(dataset.table) === state.table)).toBeUndefined();

        const runner = ownedRunner(state);
        const accepted = await runner.runAnalysisService({
          accountId: state.account,
          analysisId: analysis.id,
          values: { floor: 15 },
        });
        expect(accepted.outcome).toBe("queued");
        await waitFor(async () => (await runStatus(state, accepted.run))?.status === "running", "run entered running");
        await sleep(500);
        // The run is waiting on the restoration, not finalizing falsely.
        expect((await runStatus(state, accepted.run))?.status).toBe("running");
        expect(await state.store.countAnalysisResults(state.account, analysis.id)).toBe(0);

        restoreRelease?.();
        restoreRelease = undefined;
        const summary = await restoration;
        expect(summary.restored).toBe(1);

        const settled = await settle(state, accepted.run);
        expect(settled.status).toBe("succeeded");
        expect(settled.errorCode).toBeFalsy();
        const results = await state.store.listAnalysisResults(state.account, analysis.id);
        expect(results.items).toHaveLength(1);
        const result = await state.store.getAnalysisResult(state.account, analysis.id, results.items[0]!.id);
        // Independent expectation: only the two rows with amount >= 15 qualify.
        expect(result?.rows).toEqual([[2]]);

        const after = await checkSystemHealth();
        expect(after.status).toBe("operational");
        expect(after.services.find((service) => service.id === "data_service")?.status).toBe("operational");
      } finally {
        await restoration.catch(() => undefined);
      }
    }
  );

  it(
    "finalizes an honest durable stale-inputs when the bounded wait times out, then recovers",
    { timeout: 90_000 },
    async () => {
      const state = await startupState("window_stale");
      const analysis = await state.store.createAnalysis(state.account, definitionOf(state));
      const restoration = gateRestoration();
      try {
        // A composition-level short bound stands in for the fixed 15-second
        // ceiling; the production bound is config-fixed, never env-driven.
        const runner = ownedRunner(state, 150);
        const accepted = await runner.runAnalysisService({
          accountId: state.account,
          analysisId: analysis.id,
          values: { floor: 15 },
        });
        const settled = await settle(state, accepted.run);
        // The restoration never completed, so proceeding is the honest path:
        // durable stale-inputs, no published result, no silent widening.
        expect(settled.status).toBe("stale-inputs");
        expect(settled.errorCode).toBe("ANALYSIS_INPUTS_STALE");
        expect(await state.store.countAnalysisResults(state.account, analysis.id)).toBe(0);

        restoreRelease?.();
        restoreRelease = undefined;
        const summary = await restoration;
        expect(summary.restored).toBe(1);

        // Failed-open honesty: once hydrated, the identical definition runs.
        const retried = await runner.runAnalysisService({
          accountId: state.account,
          analysisId: analysis.id,
          values: { floor: 15 },
          waitForCompletion: true,
        });
        const settledRetry = await settle(state, retried.run);
        expect(settledRetry.status).toBe("succeeded");
        const results = await state.store.listAnalysisResults(state.account, analysis.id);
        expect(results.items).toHaveLength(1);
        const result = await state.store.getAnalysisResult(state.account, analysis.id, results.items[0]!.id);
        expect(result?.rows).toEqual([[2]]);
      } finally {
        await restoration.catch(() => undefined);
      }
    }
  );
});
