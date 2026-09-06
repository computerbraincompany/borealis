import { randomUUID } from "node:crypto";

import { appLog } from "./appLogger.js";
import {
  CONNECTOR_REFRESH_REPAIR_LIMIT,
  type ConnectorRefreshIdentity,
  type ConnectorRefreshState,
} from "./db/stores/connectorRefreshStore.js";
import type { DatasetCleanupJob, IngestionJob } from "./db/stores/ingestionStore.js";
import { beginDatasetRegistryRehydration, finishDatasetRegistryRehydration } from "./data/registryHydration.js";
import { DataServiceError, dataService } from "./dataService.js";
import { embeddingMigrationCoordinator, EmbeddingMigrationError } from "./embeddingMigration.js";
import {
  ConnectorRefreshActivatedError,
  IngestionExecutor,
  IngestionWorker,
  jobRequestContext,
  processDurableDatasetCleanupJob,
  type IngestionExecutionInput,
} from "./ingestionEngine.js";
import { publicIngestionFailure } from "./ingestionFailures.js";
import { createAuthorizedIngestionEmbeddingSession } from "./ingestionEmbedding.js";
import {
  datasetPreviewSegments,
  datasetRegistrationForSource,
  extractDocument,
  isTabularSource,
} from "./ingestSupport.js";
import { chunkTextWithLocators } from "./sourceLocations.js";
import { runWithRequestContext } from "./requestContext.js";
import { completeSourceDeleteIntents } from "./sourceCleanup.js";
import { resolveSourceArtifact } from "./storageArtifacts.js";
import { storageRuntime } from "./storageRuntime.js";

export {
  chunkText,
  datasetRegistrationForSource,
  extractText,
  isTabularSource,
  preflightDocxArchive,
  sanitizeDatasetName,
} from "./ingestSupport.js";

const WORKER_CONCURRENCY = 2;
const PREPARE_WORKER_CONCURRENCY = 2;
const LEASE_TIMEOUT_MS = 10 * 60_000;
const MAX_JOB_ATTEMPTS = 3;
// Fixed per-invocation bounds for the periodic storage reconciliation. One
// tick processes at most one page from each durable queue; later ticks make
// further progress. The whole-ledger/vector sweep never belongs here — it is
// the startup-only `repairAtStartup`.
const PERIODIC_PENDING_VECTOR_OPERATIONS = 100;
const PERIODIC_PENDING_SOURCE_DELETES = 100;
const PERIODIC_DATASET_CLEANUP_JOBS = 20;
const STARTUP_SOURCE_DELETE_PAGE = 100;
/**
 * True only once the post-registry startup typed refresh snapshot has
 * settled for the current ingestion lifecycle. While false, periodic
 * reconciliation runs the first three queues but never reads or mutates
 * typed refresh rows: an empty in-memory DuckDB catalog would otherwise
 * falsely classify an ambiguous activation.
 */
let connectorRefreshStartupSettled = false;

export type IngestSourceOptions = IngestionExecutionInput;

interface CachedEngine {
  readonly runtime: ReturnType<typeof storageRuntime>;
  readonly executor: IngestionExecutor;
  readonly worker: IngestionWorker;
}

interface RegistryRow {
  account_id: string;
  source_id: string | null;
  name: string | null;
  file_path: string | null;
  display_name: string | null;
  url: string | null;
  connector: string | null;
  mime: string | null;
  status: "ready" | "index" | "error" | null;
}

let cachedEngine: CachedEngine | undefined;
/** Monotonic ingestion-worker lifecycle epoch counter; never decreases. */
let workerEpochSequence = 0;
/** Published epoch for the active worker lifecycle; 0 before start/after stop. */
let activeWorkerEpoch = 0;
/**
 * True from the synchronous invalidation in `stopIngestionWorkers` until that
 * stop has drained every owned pump slot, and again whenever an epoch is
 * published. Epoch 0 is therefore the open direct-call epoch only while no
 * stop is in progress: the legacy path (`processOneJob` /
 * `processOnePreparingConnectorRefresh` waking a pump outside a start) keeps
 * draining durable queues, while every wake, pump, inner loop, and `finally`
 * captured before the invalidation is rejected for the whole drain window —
 * and a `finally` from a dead published epoch can never revive its epoch.
 */
let workersStopping = false;
let ingestionPump: Promise<void> | undefined;
let ingestionRepump = false;
let ingestionAbortController: AbortController | undefined;
let connectorPreparePump: Promise<void> | undefined;
let connectorPrepareRepump = false;
let leaseRecoveryPump: Promise<void> | undefined;
let reconciliationPump: Promise<void> | undefined;
let leaseTimer: NodeJS.Timeout | undefined;
let reconciliationTimer: NodeJS.Timeout | undefined;

function engine(): CachedEngine {
  const runtime = storageRuntime();
  if (cachedEngine?.runtime === runtime) return cachedEngine;
  const executor = new IngestionExecutor({
    store: runtime.ingestion,
    lifecycle: runtime.vectorLifecycle,
    data: dataService,
    refresh: runtime.connectorRefresh,
    embeddingDimension: runtime.vectors.dimension,
    createEmbeddingSession: createAuthorizedIngestionEmbeddingSession,
    resolveArtifact: resolveSourceArtifact,
    isTabular: isTabularSource,
    extractDocument,
    chunkTextWithLocators,
    datasetRegistration: datasetRegistrationForSource,
    datasetPreviewSegments,
  });
  cachedEngine = Object.freeze({
    runtime,
    executor,
    worker: new IngestionWorker({
      store: runtime.ingestion,
      sources: runtime.sources,
      lifecycle: runtime.vectorLifecycle,
      refresh: runtime.connectorRefresh,
      ingest: (input) => executor.ingest(input),
    }),
  });
  return cachedEngine;
}

/** Execute one already-claimed, exact SQLite ingestion lease. */
export async function ingestSource(options: IngestSourceOptions): Promise<void> {
  await engine().executor.ingest(options);
}

/** Reserve a fresh generation for an existing upload and wake the in-process worker. */
export async function enqueueIngestion(accountId: string, sourceId: string): Promise<number> {
  const reservation = await embeddingMigrationCoordinator().runSourceMutation(() =>
    storageRuntime().sourceIngestion.reserveSourceReingest(accountId, sourceId)
  );
  wakeIngestionWorkers();
  return reservation.generation;
}

/**
 * Drain a bounded dataset-cache cleanup page. Optional account/name filters
 * and the store-owned default limit remain unchanged for non-periodic
 * callers; the store retains limit validation.
 */
export async function processDatasetCacheCleanup(accountId?: string, name?: string, limit?: number): Promise<number> {
  const runtime = storageRuntime();
  const jobs = await runtime.ingestion.listDatasetCleanupJobs({ accountId, name, limit });
  let completed = 0;
  for (const job of jobs) {
    if (await processDurableDatasetCleanupJob(runtime.ingestion, dataService, job)) completed += 1;
  }
  return completed;
}

async function reserveReconciliationDatasetCleanup(
  accountId: string,
  name: string,
  location: string
): Promise<DatasetCleanupJob | undefined> {
  const reserved = await storageRuntime().ingestion.reserveReconciliationDatasetCleanup(accountId, name, location);
  return reserved ? Object.freeze({ accountId, name, location, attempts: 0 }) : undefined;
}

export async function processOneJob(
  runIngest: (input: IngestionExecutionInput) => Promise<void> = ingestSource,
  signal?: AbortSignal
): Promise<boolean> {
  return runSourceMaintenance(async () => {
    const runtime = storageRuntime();
    const worker =
      runIngest === ingestSource
        ? engine().worker
        : new IngestionWorker({
            store: runtime.ingestion,
            sources: runtime.sources,
            lifecycle: runtime.vectorLifecycle,
            refresh: runtime.connectorRefresh,
            ingest: runIngest,
          });
    return worker.processOne(signal);
  }, false);
}

/**
 * True while the captured epoch may still begin new store/data-service work.
 * A published epoch is active only while it remains the active one; epoch 0
 * (the pre-start legacy direct-call path) is active only until the first
 * stop invalidates admission. A later start never revives epoch 0 work.
 */
function isWorkerEpochActive(epoch: number): boolean {
  return epoch === 0 ? activeWorkerEpoch === 0 && !workersStopping : epoch === activeWorkerEpoch;
}

/**
 * Claims and processes durable ingestion jobs for exactly one worker
 * lifecycle epoch. Every inner loop, repump decision, and wake rechecks that
 * its captured epoch is still active before beginning another store
 * operation; a `finally` from an invalidated epoch can neither clear nor
 * repump a newer promise slot.
 */
function scheduleIngestionPump(epoch: number): void {
  if (!isWorkerEpochActive(epoch)) return;
  ingestionRepump = true;
  if (ingestionPump) return;
  const controller = ingestionAbortController ?? new AbortController();
  ingestionAbortController = controller;
  const signal = controller.signal;
  const pump = Promise.resolve()
    .then(async () => {
      do {
        ingestionRepump = false;
        if (signal.aborted || !isWorkerEpochActive(epoch)) return;
        await Promise.all(
          Array.from({ length: WORKER_CONCURRENCY }, async () => {
            while (!signal.aborted && isWorkerEpochActive(epoch) && (await processOneJob(ingestSource, signal))) {
              // Drain every currently available durable job within this epoch.
            }
          })
        );
      } while (ingestionRepump && !signal.aborted && isWorkerEpochActive(epoch));
    })
    .catch(() => appLog.warn({ error_code: "INGESTION_PUMP_FAILED" }, "ingestion worker pump failed"))
    .finally(() => {
      // Identity-checked: an older completion never erases a later promise.
      if (ingestionPump === pump) ingestionPump = undefined;
      if (ingestionRepump && !signal.aborted && isWorkerEpochActive(epoch)) scheduleIngestionPump(epoch);
    });
  ingestionPump = pump;
}

export function wakeIngestionWorkers(): void {
  // No wake can escape the synchronous epoch invalidation while a stop is
  // draining. Outside a stop, the direct-call epoch 0 path keeps the legacy
  // `processOneJob`/`processOnePreparingConnectorRefresh` pumps draining
  // durable queues before any start and after a settled stop, exactly as
  // before; a published epoch captures its own identity so a later start's
  // pumps can never be repumped by an old `finally`. Work reserved while
  // stopped is not lost: the next successful start wakes both durable
  // queues under its new epoch.
  if (!isWorkerEpochActive(activeWorkerEpoch)) return;
  scheduleIngestionPump(activeWorkerEpoch);
}

/** Durable connector-prepare pump for exactly one worker lifecycle epoch. */
function scheduleConnectorPreparePump(epoch: number): void {
  if (!isWorkerEpochActive(epoch)) return;
  connectorPrepareRepump = true;
  if (connectorPreparePump) return;
  const pump = Promise.resolve()
    .then(async () => {
      do {
        connectorPrepareRepump = false;
        if (!isWorkerEpochActive(epoch)) return;
        await Promise.all(
          Array.from({ length: PREPARE_WORKER_CONCURRENCY }, async () => {
            while (isWorkerEpochActive(epoch) && (await processOnePreparingConnectorRefresh())) {
              // Drain every currently available durable prepare job within this epoch.
            }
          })
        );
      } while (connectorPrepareRepump && isWorkerEpochActive(epoch));
    })
    .catch(() => appLog.warn({ error_code: "CONNECTOR_PREPARE_PUMP_FAILED" }, "connector prepare worker pump failed"))
    .finally(() => {
      if (connectorPreparePump === pump) connectorPreparePump = undefined;
      if (connectorPrepareRepump && isWorkerEpochActive(epoch)) scheduleConnectorPreparePump(epoch);
    });
  connectorPreparePump = pump;
}

export function wakeConnectorPrepareWorkers(): void {
  if (!isWorkerEpochActive(activeWorkerEpoch)) return;
  scheduleConnectorPreparePump(activeWorkerEpoch);
}

export async function resumePreparingConnectorRefreshes(): Promise<number> {
  const results = await Promise.all(
    Array.from({ length: PREPARE_WORKER_CONCURRENCY }, () => processOnePreparingConnectorRefresh())
  );
  return results.filter(Boolean).length;
}

export async function processOnePreparingConnectorRefresh(): Promise<boolean> {
  return runSourceMaintenance(processOnePreparingConnectorRefreshUnlocked, false);
}

async function processOnePreparingConnectorRefreshUnlocked(): Promise<boolean> {
  const runtime = storageRuntime();
  const job = await runtime.ingestion.claimNext("preparing");
  if (!job?.leaseToken) return false;
  const leaseToken = job.leaseToken;
  return runWithRequestContext(`connector-prepare.${job.sourceId}.${job.generation}`, async () => {
    const [refreshRow, source] = await Promise.all([
      runtime.connectorRefresh.getState(job.accountId, job.sourceId),
      runtime.sources.getSource(job.accountId, job.sourceId),
    ]);
    const connector = source?.connectorId
      ? await runtime.sources.getConnector(job.accountId, source.connectorId)
      : undefined;
    const connectorConfig = objectRecord(connector?.config);
    const url = connectorConfig.url;
    const expectedFormat: "csv" | "json" = connector?.type === "url_json" ? "json" : "csv";
    // The prepare pump reads the typed durable protocol row, never source
    // metadata. Anything that no longer matches the claimed lease fails the
    // exact preparing job closed.
    if (
      !refreshRow ||
      refreshRow.phase !== "preparing" ||
      refreshRow.generation !== job.generation ||
      !source ||
      !connector ||
      source.connectorId !== refreshRow.connectorId ||
      typeof url !== "string" ||
      !url
    ) {
      await failPreparingJob(job, connector?.id, "PREPARE_STATE_INVALID");
      return true;
    }
    const version = refreshRow.refreshVersion;

    try {
      const prepared = await dataService.prepareDatasetRefresh(
        job.accountId,
        source.name,
        version,
        url,
        source.displayName,
        expectedFormat
      );
      if (prepared.version !== version || typeof prepared.location !== "string" || !prepared.location) {
        throw new Error("connector returned an invalid prepared artifact");
      }
      const activationPrevious =
        typeof prepared.previous_location === "string" && prepared.previous_location
          ? prepared.previous_location
          : null;
      const cleanupPrevious =
        source.filePath && source.filePath !== prepared.location ? source.filePath : activationPrevious;
      await runtime.sourceIngestion.activatePreparedConnector({
        accountId: job.accountId,
        connectorId: connector.id,
        sourceId: source.id,
        generation: job.generation,
        leaseToken,
        refreshVersion: version,
        url,
        displayName: source.displayName,
        mime: expectedFormat === "json" ? "application/json" : "text/csv",
        candidateLocation: prepared.location,
        activationPreviousLocation: activationPrevious,
        cleanupPreviousLocation: cleanupPrevious,
      });
      wakeIngestionWorkers();
      return true;
    } catch (error) {
      const abortConfirmed = await dataService
        .abortDatasetRefresh(job.accountId, source.name, version, expectedFormat)
        .then(() => true)
        .catch(() => false);
      const retryable = error instanceof DataServiceError && (error.status === 429 || error.status >= 500);
      if (!abortConfirmed || (retryable && job.attempts < MAX_JOB_ATTEMPTS)) {
        const delay = Math.min(60_000, 2 ** Math.min(job.attempts, 8) * 1_000);
        await runtime.sourceIngestion.deferConnectorPrepare({
          accountId: job.accountId,
          sourceId: job.sourceId,
          generation: job.generation,
          leaseToken,
          retryDelayMs: delay,
        });
        return true;
      }
      await failPreparingJob(job, connector.id, "PREPARE_FAILED");
      return true;
    }
  });
}

async function failPreparingJob(job: IngestionJob, connectorId: string | undefined, errorCode: string): Promise<void> {
  const runtime = storageRuntime();
  if (connectorId && job.leaseToken) {
    const failed = await runtime.sourceIngestion.failConnectorPrepare({
      accountId: job.accountId,
      connectorId,
      sourceId: job.sourceId,
      generation: job.generation,
      leaseToken: job.leaseToken,
      errorCode,
    });
    if (failed) {
      await runtime.vectorLifecycle.drainPendingVectorOperations();
      return;
    }
  }
  await runtime.vectorLifecycle.failGeneration({
    accountId: job.accountId,
    sourceId: job.sourceId,
    generation: job.generation,
    leaseToken: job.leaseToken ?? undefined,
    errorCode,
    failure: publicIngestionFailure("INGEST_FAILED"),
  });
}

export async function recoverExpiredIngestionLeases(startup = false): Promise<number> {
  return runSourceMaintenance(async () => {
    const runtime = storageRuntime();
    const recovered = await runtime.ingestion.recoverRunningLeases({
      startup,
      expiredBefore: new Date(Date.now() - LEASE_TIMEOUT_MS),
      maxAttempts: MAX_JOB_ATTEMPTS,
    });
    await runtime.vectorLifecycle.drainPendingVectorOperations();
    return recovered.length;
  }, 0);
}

export async function recoverPreparingConnectorLeases(startup = false): Promise<number> {
  return runSourceMaintenance(
    () =>
      storageRuntime().ingestion.recoverPreparingLeases({
        startup,
        expiredBefore: new Date(Date.now() - LEASE_TIMEOUT_MS),
      }),
    0
  );
}

/**
 * Startup-only pending source deletion pass over one frozen connection-local
 * identity snapshot. Every intent present at capture time is attempted at
 * most once through bounded pages: a concurrently inserted intent waits for
 * periodic repair, a failed intent remains durable for periodic retry, and a
 * deleted captured row cannot stall the cursor because the ordinal is
 * advanced regardless. Invoked per intent so one permanent failure cannot
 * retain otherwise-good markers through the batch-all-or-nothing cleanup
 * coordinator (plan 011). The TEMP snapshot is dropped in `finally`; it is
 * disposable control state, never the recovery record.
 */
export async function repairPendingSourceDeletesAtStartup(): Promise<number> {
  const runtime = storageRuntime();
  const snapshot = await runtime.sources.capturePendingSourceDeleteSnapshot();
  let completed = 0;
  try {
    let cursor = 0;
    for (;;) {
      const page = await snapshot.read(cursor, STARTUP_SOURCE_DELETE_PAGE);
      if (page.length === 0) break;
      for (const entry of page) {
        if (!entry.intent) continue;
        const outcome = await completeSourceDeleteIntents([entry.intent]);
        if (outcome.completed) completed += outcome.intents;
      }
      cursor = page[page.length - 1].ordinal;
    }
  } finally {
    await snapshot.close();
  }
  return completed;
}

/**
 * One bounded steady-state reconciliation pass. It performs only: (1) at most
 * 100 pending vector operations, (2) one globally bounded 100-intent pending
 * source-delete page with each intent cleaned individually for failure
 * isolation, (3) at most 20 dataset-cache cleanup jobs, and (4) at most one
 * global 20-row page of typed connector-refresh protocol states. It never
 * calls the startup sweep, the whole-ledger vector state read, the LanceDB
 * row scan, the DuckDB registry restoration, or any distinct-account scan.
 * At most one page per queue is processed per invocation even when successful
 * cleanup frees room for more; durable attempts-first ordering provides
 * progress on later ticks. The fourth queue is skipped (without reading or
 * changing typed rows) until the post-registry startup snapshot settles.
 */
export async function runPeriodicStorageReconciliation(): Promise<void> {
  await runSourceMaintenance(async () => {
    const runtime = storageRuntime();
    await runtime.vectorLifecycle.drainPendingVectorOperations(PERIODIC_PENDING_VECTOR_OPERATIONS);
    const intents = await runtime.sources.listPendingSourceDeletesAcrossAccounts(PERIODIC_PENDING_SOURCE_DELETES);
    // Per-intent isolation is required, not unbounded fan-out:
    // completeSourceDeleteIntents deliberately retains every marker in a
    // failed input batch.
    for (const intent of intents) await completeSourceDeleteIntents([intent]);
    await processDatasetCacheCleanup(undefined, undefined, PERIODIC_DATASET_CLEANUP_JOBS);
    await runPeriodicConnectorRefreshRepair();
  }, undefined);
}

/** Fourth bounded queue: one global attempts-first page of typed refresh states. */
async function runPeriodicConnectorRefreshRepair(): Promise<void> {
  if (!connectorRefreshStartupSettled) return;
  const runtime = storageRuntime();
  const page = await runtime.connectorRefresh.listRepairableStates(CONNECTOR_REFRESH_REPAIR_LIMIT);
  let failed = 0;
  for (const state of page) {
    if (!(await repairOneConnectorRefreshState(state))) failed += 1;
  }
  // Aggregate, content-free logging only: stable error codes and counts,
  // never account/source IDs, URLs, table names, or paths.
  if (failed > 0) {
    appLog.warn(
      { error_code: "CONNECTOR_REFRESH_REPAIR_RETRYING", failed_refresh_states: failed },
      "connector refresh periodic repair left rows for retry"
    );
  }
}

function refreshIdentityOf(state: ConnectorRefreshState): ConnectorRefreshIdentity {
  return Object.freeze({
    accountId: state.accountId,
    sourceId: state.sourceId,
    connectorId: state.connectorId,
    generation: state.generation,
    refreshVersion: state.refreshVersion,
  });
}

/**
 * Attempt exactly one typed refresh state. A protocol/data-service failure
 * for one row must not abort its peers: the row is retained, only a stable
 * aggregate error code is recorded, and the exact still-current attempt is
 * CAS-touched so attempts increments even under a fixed or backward clock.
 * Any successful action that intentionally leaves the same phase is no
 * progress and uses the same incrementing touch.
 */
async function repairOneConnectorRefreshState(state: ConnectorRefreshState): Promise<boolean> {
  const runtime = storageRuntime();
  const identity = refreshIdentityOf(state);
  const touch = async (): Promise<boolean> => {
    await runtime.connectorRefresh
      .touchFailedAttempt({
        identity,
        expectedPhase: state.phase,
        expectedAttempts: state.attempts,
        expectedUpdatedAt: state.updatedAt,
      })
      .catch(() => false);
    return false;
  };
  try {
    switch (state.phase) {
      case "preparing": {
        // Validate the exact job/source/connector identity and make the
        // prepare pump eligible. The row intentionally keeps its phase.
        const [job, source] = await Promise.all([
          runtime.ingestion.getJob(state.accountId, state.sourceId),
          runtime.sources.getSource(state.accountId, state.sourceId),
        ]);
        if (
          !job ||
          job.generation !== state.generation ||
          job.status !== "preparing" ||
          job.leaseToken !== null ||
          !source ||
          source.connectorId !== state.connectorId
        ) {
          return await touch();
        }
        wakeConnectorPrepareWorkers();
        return await touch();
      }
      case "prepared": {
        // Validate the exact pending generation and queue it; the worker
        // owns candidate-file validation through artifact proof.
        const job = await runtime.ingestion.getJob(state.accountId, state.sourceId);
        if (!job || job.generation !== state.generation || job.status !== "pending" || job.leaseToken !== null) {
          return await touch();
        }
        wakeIngestionWorkers();
        return await touch();
      }
      case "activating": {
        const source = await runtime.sources.getSource(state.accountId, state.sourceId);
        if (!source || source.connectorId !== state.connectorId) return await touch();
        const current = await dataService.currentDatasetLocation(state.accountId, source.name);
        if (current !== null && current === state.candidateLocation) {
          if (await runtime.connectorRefresh.confirmActivation(identity)) {
            wakeIngestionWorkers();
            return true;
          }
          return await touch();
        }
        const unactivated =
          (current === null && state.activationPreviousLocation === null) ||
          (current !== null && current === state.activationPreviousLocation);
        if (unactivated) {
          if (await runtime.connectorRefresh.returnActivatingToPrepared(identity)) {
            wakeIngestionWorkers();
            return true;
          }
          return await touch();
        }
        // A third location is an invariant failure: durable, fail-closed,
        // retryable only through this bounded fairness touch.
        return await touch();
      }
      case "activated": {
        // Resume only this exact generation's promotion path; never activate
        // again. The row keeps its phase until the promotion transaction
        // finalizes it.
        const job = await runtime.ingestion.getJob(state.accountId, state.sourceId);
        if (job && job.generation === state.generation && job.status === "pending" && job.leaseToken === null) {
          wakeIngestionWorkers();
        }
        return await touch();
      }
      case "cleanup_pending": {
        const source = await runtime.sources.getSource(state.accountId, state.sourceId);
        if (!source || source.status !== "ready" || source.filePath !== state.candidateLocation) {
          return await touch();
        }
        // Exact-location deactivation + cache cleanup only. Never the
        // candidate, never a table-name-only drop, never a remote fetch.
        await dataService.deactivateDatasetLocation(state.accountId, source.name, state.cleanupPreviousLocation);
        await dataService.cleanupDatasetCache(state.accountId, source.name, state.cleanupPreviousLocation);
        const queued = await runtime.ingestion.getDatasetCleanupJob(
          state.accountId,
          source.name,
          state.cleanupPreviousLocation
        );
        if (queued) await runtime.ingestion.resolveDatasetCleanupJob(queued, "complete");
        if (
          await runtime.connectorRefresh.completeExactCleanup({
            identity,
            cleanupLocation: state.cleanupPreviousLocation,
          })
        ) {
          return true;
        }
        return await touch();
      }
    }
  } catch {
    return await touch();
  }
}

/**
 * Finite startup snapshot pass over the typed refresh states. The
 * `MAX(repair_ordinal)` bound is captured once; every row at or below it is
 * attempted at most once through bounded keyset pages (never offsets, never
 * a wall-clock cutoff). A concurrently inserted row has a larger ordinal and
 * waits for periodic repair; a lost CAS or failure still counts as that
 * snapshot row's attempt and the cursor advances regardless, so the pass
 * always terminates.
 */
async function repairConnectorRefreshStatesAtStartup(): Promise<number> {
  const runtime = storageRuntime();
  const capturedMax = await runtime.connectorRefresh.captureMaxRepairOrdinal();
  if (capturedMax === 0) return 0;
  let cursor = 0;
  let attempted = 0;
  let retried = 0;
  for (;;) {
    const page = await runtime.connectorRefresh.listRepairableStatesUpTo(
      capturedMax,
      cursor,
      CONNECTOR_REFRESH_REPAIR_LIMIT
    );
    if (page.length === 0) break;
    for (const state of page) {
      attempted += 1;
      if (!(await repairOneConnectorRefreshState(state))) retried += 1;
    }
    cursor = page[page.length - 1]!.repairOrdinal;
    if (page.length < CONNECTOR_REFRESH_REPAIR_LIMIT) break;
  }
  if (retried > 0) {
    appLog.warn(
      {
        error_code: "CONNECTOR_REFRESH_STARTUP_RETRYING",
        attempted_refresh_states: attempted,
        retrying_refresh_states: retried,
      },
      "connector refresh startup reconciliation left rows for periodic retry"
    );
  }
  return attempted;
}

/**
 * Coalesced 60-second reconciliation pump for exactly one worker epoch. The
 * bounded pass belongs only to a published epoch; the pre-start direct-call
 * epoch never earns timer work.
 */
function scheduleReconciliationPump(epoch: number): void {
  if (epoch === 0 || !isWorkerEpochActive(epoch)) return;
  if (reconciliationPump) return;
  const pump = runWithRequestContext("storage-reconciliation.periodic", () => runPeriodicStorageReconciliation())
    .catch(() => appLog.warn({ error_code: "STORAGE_RECONCILIATION_FAILED" }, "storage reconciliation failed"))
    .finally(() => {
      if (reconciliationPump === pump) reconciliationPump = undefined;
    });
  reconciliationPump = pump;
}

/**
 * Narrow package-internal epoch-gated trigger for the periodic
 * reconciliation callback. It shares the interval's production helper, is
 * never reachable through a route or runtime dependency, and exists because
 * the 60-second interval cannot be driven deterministically in tests.
 */
export function triggerStorageReconciliation(): void {
  scheduleReconciliationPump(activeWorkerEpoch);
}

/** Coalesced 15-second lease-recovery pump for exactly one worker epoch. */
function scheduleLeaseRecoveryPump(epoch: number): void {
  if (epoch === 0 || !isWorkerEpochActive(epoch)) return;
  if (leaseRecoveryPump) return;
  const pump = Promise.resolve()
    .then(async () => {
      // Finish an already-started call, then stop on epoch invalidation: no
      // later recovery call and no wake join the dead epoch.
      await recoverExpiredIngestionLeases();
      if (!isWorkerEpochActive(epoch)) return;
      await recoverPreparingConnectorLeases();
      if (!isWorkerEpochActive(epoch)) return;
      wakeConnectorPrepareWorkers();
      wakeIngestionWorkers();
    })
    .catch(() => appLog.warn({ error_code: "LEASE_RECOVERY_FAILED" }, "ingestion lease recovery failed"))
    .finally(() => {
      if (leaseRecoveryPump === pump) leaseRecoveryPump = undefined;
    });
  leaseRecoveryPump = pump;
}

/** Narrow package-internal epoch-gated trigger mirroring the lease timer. */
export function triggerLeaseRecovery(): void {
  scheduleLeaseRecoveryPump(activeWorkerEpoch);
}

/** Recover durable state before opening the listening socket, then start bounded pumps. */
export async function startIngestionWorkers(): Promise<void> {
  if (activeWorkerEpoch !== 0) return;
  // A fresh lifecycle never inherits typed-repair readiness; the fourth
  // periodic queue stays gated until this runtime's post-registry snapshot
  // attempt settles inside `restoreDatasets()`.
  connectorRefreshStartupSettled = false;
  // Open the dataset-registry rehydration window synchronously, before this
  // composition publishes analysis/chat admission (the analysis runner resumes
  // before the socket listens, while `restoreDatasets()` runs behind the ready
  // line after `app.listen`). Work admitted in that gap awaits the window
  // instead of finalizing false durable `stale-inputs` against an empty
  // registry. `restoreDatasets()` closes the window; this failure path fails
  // open honestly because this lifecycle never scheduled a restoration.
  beginDatasetRegistryRehydration();
  try {
    await recoverExpiredIngestionLeases(true);
    await recoverPreparingConnectorLeases(true);
    await runSourceMaintenance(
      () =>
        storageRuntime().vectorLifecycle.repairAtStartup({
          completePendingSourceDeletes: repairPendingSourceDeletesAtStartup,
        }),
      undefined
    );
    await processDatasetCacheCleanup();
    if (!ingestionAbortController || ingestionAbortController.signal.aborted) {
      ingestionAbortController = new AbortController();
    }
    // Publish a fresh active epoch (reopening wake admission) before the
    // initial wakes and timers. Work reserved while stopped is not lost: these
    // wakes drain both durable queues under the new epoch.
    activeWorkerEpoch = ++workerEpochSequence;
    workersStopping = false;
    const epoch = activeWorkerEpoch;
    wakeConnectorPrepareWorkers();
    wakeIngestionWorkers();

    leaseTimer = setInterval(() => scheduleLeaseRecoveryPump(epoch), 15_000);
    leaseTimer.unref();
    reconciliationTimer = setInterval(() => scheduleReconciliationPump(epoch), 60_000);
    reconciliationTimer.unref();
  } catch (error) {
    finishDatasetRegistryRehydration();
    throw error;
  }
}

export async function stopIngestionWorkers(): Promise<void> {
  // Synchronously, before the first await: invalidate the epoch and close
  // wake admission (including the pre-start epoch 0), clear both unref'd
  // timers, and reset both repump flags so queued wakes cannot escape the
  // old epoch. Typed-refresh readiness is likewise never inherited by a
  // sequential runtime.
  activeWorkerEpoch = 0;
  workersStopping = true;
  connectorRefreshStartupSettled = false;
  // This lifecycle's registry-rehydration window never outlives its owner:
  // close it honestly so health/admission never gate on a restoration whose
  // owning composition is being torn down. The server's own drain still
  // awaits the in-flight `startupReconciliation` promise before granting the
  // external-consumer proof; a later composition reopens a fresh window.
  finishDatasetRegistryRehydration();
  if (leaseTimer) clearInterval(leaseTimer);
  leaseTimer = undefined;
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = undefined;
  ingestionRepump = false;
  connectorPrepareRepump = false;
  const controller = ingestionAbortController;
  controller?.abort(new DOMException("ingestion workers stopped", "AbortError"));
  // Drain every owned pump slot until none remains. The epoch gates make the
  // loop converge; the repeated snapshot also covers a promise published by
  // an already-queued microtask just before quiescence.
  for (;;) {
    const pending = [leaseRecoveryPump, reconciliationPump, ingestionPump, connectorPreparePump].filter(
      (pump): pump is Promise<void> => pump !== undefined
    );
    if (pending.length === 0) break;
    await Promise.allSettled(pending);
  }
  // Only now that all four slots are empty may this owner release the
  // cached engine and return to the application-runtime close sequence.
  // Reopening admission after the full drain preserves the pre-existing
  // direct-call contract (the legacy epoch-0 pumps of `processOneJob` and
  // `processOnePreparingConnectorRefresh`); dead published epochs stay dead
  // because their identity no longer matches, and `start` republishes.
  workersStopping = false;
  if (ingestionAbortController === controller) ingestionAbortController = undefined;
  cachedEngine = undefined;
}

export interface RestoreSummary {
  attempted: number;
  restored: number;
  failed: number;
  stale_attempted: number;
  removed: number;
  remove_failed: number;
}

/**
 * Test-only delay seam inside `restoreDatasets()`: when installed, the
 * restoration awaits this gate immediately after reading the ledger's ready
 * identities and before touching the worker registry, so a startup-window
 * regression can deterministically hold the rehydration provably in flight.
 */
let datasetRegistryRestoreGate: (() => Promise<void>) | undefined;

export function __setDatasetRegistryRestoreGateForTests(gate: (() => Promise<void>) | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only seam");
  datasetRegistryRestoreGate = gate;
}

/** Rebuild the in-memory DuckDB registry from exact ready SQLite identities. */
export async function restoreDatasets(_attempts = 8): Promise<RestoreSummary> {
  // Honest-window bookkeeping for admission and health: the registry is being
  // rebuilt from here. Joining a window already opened by
  // `startIngestionWorkers()` is a no-op; a direct call opens its own.
  beginDatasetRegistryRehydration();
  try {
    return await restoreDatasetsUnlocked();
  } finally {
    // Honest failed-open: a completed, aborted, or failed restoration all land
    // on ready, so a later admission evaluates genuinely absent inputs with
    // the existing stale-inputs semantics rather than waiting forever.
    finishDatasetRegistryRehydration();
  }
}

async function restoreDatasetsUnlocked(): Promise<RestoreSummary> {
  const runtime = storageRuntime();
  const rows = await runtime.ledger.all<RegistryRow>(
    `SELECT u.id AS account_id, s.id AS source_id, s.name, s.file_path, s.display_name,
            s.url, s.connector, s.mime, s.status
       FROM users u
       LEFT JOIN sources s ON s.account_id=u.id AND s.kind='tabular'
       ORDER BY u.id,s.name`
  );
  if (datasetRegistryRestoreGate) await datasetRegistryRestoreGate();
  const readyCount = rows.filter((row) => row.status === "ready" && row.file_path).length;
  if (!(await dataService.health())) {
    return {
      attempted: readyCount,
      restored: 0,
      failed: readyCount,
      stale_attempted: 0,
      removed: 0,
      remove_failed: 0,
    };
  }

  const accounts = new Map<string, { protectedNames: Set<string>; ready: RegistryRow[] }>();
  for (const row of rows) {
    const account = accounts.get(row.account_id) ?? { protectedNames: new Set<string>(), ready: [] };
    if (row.name && (row.status === "ready" || row.status === "index")) account.protectedNames.add(row.name);
    if (row.status === "ready" && row.file_path && row.source_id && row.name) account.ready.push(row);
    accounts.set(row.account_id, account);
  }

  let attempted = 0;
  let restored = 0;
  let failed = 0;
  let staleAttempted = 0;
  let removed = 0;
  let removeFailed = 0;
  for (const [accountId, ledger] of accounts) {
    let registered: any[];
    try {
      registered = await dataService.listDatasets(accountId);
    } catch {
      failed += ledger.ready.length;
      continue;
    }
    const current = new Map(registered.map((dataset) => [String(dataset.table), dataset]));
    for (const dataset of registered) {
      const table = String(dataset.table ?? "");
      if (!table || ledger.protectedNames.has(table)) continue;
      staleAttempted += 1;
      try {
        if (typeof dataset.location !== "string" || !dataset.location) throw new Error("missing dataset identity");
        if (dataset.kind === "url") {
          const job = await reserveReconciliationDatasetCleanup(accountId, table, dataset.location);
          if (!job) continue;
          if (!(await processDurableDatasetCleanupJob(runtime.ingestion, dataService, job))) {
            throw new Error("dataset cache cleanup failed");
          }
        } else {
          await dataService.deactivateDatasetLocation(accountId, table, dataset.location);
        }
        removed += 1;
      } catch {
        removeFailed += 1;
      }
    }

    for (const source of ledger.ready) {
      // Protocol cleanup locations are typed state, never metadata; the
      // typed snapshot pass below owns them. Only a fresh previous location
      // observed from the rebuilt registry is cleaned inline here.
      let cleanupLocation: string | undefined;
      const existing = current.get(source.name!);
      if (existing?.exists === false || existing?.location !== source.file_path) {
        attempted += 1;
        try {
          const ownedLocation = await resolveSourceArtifact({
            accountId,
            sourceId: source.source_id!,
            name: source.name!,
            filePath: source.file_path!,
            connector: source.connector,
          });
          if (!ownedLocation) throw new Error("source artifact is unavailable");
          const registration = await dataService.registerDataset(
            accountId,
            source.name!,
            datasetRegistrationForSource({
              sourceId: source.source_id!,
              filePath: ownedLocation,
              displayName: source.display_name ?? source.name!,
              url: source.url ?? undefined,
              connector: source.connector ?? undefined,
              expectedFormat: source.connector
                ? (source.mime ?? "").toLowerCase().includes("json")
                  ? "json"
                  : "csv"
                : undefined,
            })
          );
          const fresh = await runtime.sources.getSource(accountId, source.source_id!);
          if (fresh?.filePath === source.file_path) {
            if (fresh.status !== "ready") continue;
          } else {
            if (source.connector) {
              const job = await reserveReconciliationDatasetCleanup(accountId, source.name!, ownedLocation);
              if (job && !(await processDurableDatasetCleanupJob(runtime.ingestion, dataService, job))) {
                throw new Error("dataset cache cleanup failed");
              }
            } else {
              await dataService.deactivateDatasetLocation(accountId, source.name!, ownedLocation);
            }
            continue;
          }
          if (
            typeof registration?.previous_location === "string" &&
            registration.previous_location !== source.file_path
          ) {
            cleanupLocation = registration.previous_location;
          }
          restored += 1;
        } catch {
          failed += 1;
          continue;
        }
      }
      if (source.connector && cleanupLocation) {
        try {
          const fresh = await runtime.sources.getSource(accountId, source.source_id!);
          if (fresh?.status !== "ready" || fresh.filePath !== source.file_path) continue;
          const job = await reserveReconciliationDatasetCleanup(accountId, source.name!, cleanupLocation);
          if (!job || !(await processDurableDatasetCleanupJob(runtime.ingestion, dataService, job))) continue;
        } catch {
          // The durable marker keeps cleanup retryable on the next reconciliation.
        }
      }
    }
  }
  // The ready DuckDB registry is rebuilt only once the per-account loop has
  // settled. Invoke the finite typed startup snapshot pass here (never from
  // `startIngestionWorkers`) so an ambiguous activation is reconciled against
  // a populated catalog, then release the periodic fourth-queue gate.
  try {
    await repairConnectorRefreshStatesAtStartup();
  } finally {
    connectorRefreshStartupSettled = true;
  }
  return { attempted, restored, failed, stale_attempted: staleAttempted, removed, remove_failed: removeFailed };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function newConnectorPrepareIdentity(): Readonly<{ refreshVersion: string; leaseToken: string }> {
  return Object.freeze({ refreshVersion: randomUUID(), leaseToken: randomUUID() });
}

export function requestContextForIngestionJob(job: IngestionJob): string {
  return jobRequestContext(job);
}

export { ConnectorRefreshActivatedError };

async function runSourceMaintenance<T>(operation: () => Promise<T>, paused: T): Promise<T> {
  try {
    return await embeddingMigrationCoordinator().runSourceMutation(operation);
  } catch (error) {
    if (error instanceof EmbeddingMigrationError && error.code === "SOURCE_MUTATION_BLOCKED") return paused;
    throw error;
  }
}
