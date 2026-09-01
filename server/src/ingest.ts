import { randomUUID } from "node:crypto";

import { appLog } from "./appLogger.js";
import { decodeJson } from "./db/codecs.js";
import type { DatasetCleanupJob, IngestionJob } from "./db/stores/ingestionStore.js";
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
  chunkText,
  datasetPreviewText,
  datasetRegistrationForSource,
  extractText,
  isTabularSource,
} from "./ingestSupport.js";
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

export type IngestSourceOptions = IngestionExecutionInput;

interface CachedEngine {
  readonly ledgerPath: string;
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
  meta: string | null;
}

let cachedEngine: CachedEngine | undefined;
let ingestionPump: Promise<void> | undefined;
let ingestionRepump = false;
let ingestionAbortController: AbortController | undefined;
let connectorPreparePump: Promise<void> | undefined;
let connectorPrepareRepump = false;
let workersStarted = false;
let workersStopping = false;
let leaseTimer: NodeJS.Timeout | undefined;
let reconciliationTimer: NodeJS.Timeout | undefined;

function engine(): CachedEngine {
  const runtime = storageRuntime();
  if (cachedEngine?.ledgerPath === runtime.ledger.path) return cachedEngine;
  const executor = new IngestionExecutor({
    store: runtime.ingestion,
    lifecycle: runtime.vectorLifecycle,
    data: dataService,
    embeddingDimension: runtime.vectors.dimension,
    createEmbeddingSession: createAuthorizedIngestionEmbeddingSession,
    resolveArtifact: resolveSourceArtifact,
    isTabular: isTabularSource,
    extractText,
    chunkText,
    datasetRegistration: datasetRegistrationForSource,
    datasetPreviewText,
  });
  cachedEngine = Object.freeze({
    ledgerPath: runtime.ledger.path,
    executor,
    worker: new IngestionWorker({
      store: runtime.ingestion,
      sources: runtime.sources,
      lifecycle: runtime.vectorLifecycle,
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

export async function processDatasetCacheCleanup(accountId?: string, name?: string): Promise<number> {
  const runtime = storageRuntime();
  const jobs = await runtime.ingestion.listDatasetCleanupJobs({ accountId, name });
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
  const runtime = storageRuntime();
  const worker =
    runIngest === ingestSource
      ? engine().worker
      : new IngestionWorker({
          store: runtime.ingestion,
          sources: runtime.sources,
          lifecycle: runtime.vectorLifecycle,
          ingest: runIngest,
        });
  return runSourceMaintenance(() => worker.processOne(signal), false);
}

function scheduleIngestionPump(): void {
  if (workersStopping) return;
  ingestionRepump = true;
  if (ingestionPump) return;
  const controller = ingestionAbortController ?? new AbortController();
  ingestionAbortController = controller;
  const signal = controller.signal;
  ingestionPump = Promise.resolve()
    .then(async () => {
      do {
        ingestionRepump = false;
        if (signal.aborted) return;
        await Promise.all(
          Array.from({ length: WORKER_CONCURRENCY }, async () => {
            while (!signal.aborted && (await processOneJob(ingestSource, signal))) {
              // Drain every currently available durable job.
            }
          })
        );
      } while (ingestionRepump && !signal.aborted);
    })
    .catch(() => appLog.warn({ error_code: "INGESTION_PUMP_FAILED" }, "ingestion worker pump failed"))
    .finally(() => {
      ingestionPump = undefined;
      if (ingestionRepump && !signal.aborted && !workersStopping) scheduleIngestionPump();
    });
}

export function wakeIngestionWorkers(): void {
  scheduleIngestionPump();
}

function scheduleConnectorPreparePump(): void {
  if (workersStopping) return;
  connectorPrepareRepump = true;
  if (connectorPreparePump) return;
  connectorPreparePump = Promise.resolve()
    .then(async () => {
      do {
        connectorPrepareRepump = false;
        await Promise.all(
          Array.from({ length: PREPARE_WORKER_CONCURRENCY }, async () => {
            while (await processOnePreparingConnectorRefresh()) {
              // Drain every currently available durable prepare job.
            }
          })
        );
      } while (connectorPrepareRepump);
    })
    .catch(() => appLog.warn({ error_code: "CONNECTOR_PREPARE_PUMP_FAILED" }, "connector prepare worker pump failed"))
    .finally(() => {
      connectorPreparePump = undefined;
      if (connectorPrepareRepump && !workersStopping) scheduleConnectorPreparePump();
    });
}

export function wakeConnectorPrepareWorkers(): void {
  scheduleConnectorPreparePump();
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
    const source = await runtime.sources.getSource(job.accountId, job.sourceId);
    const connector = source?.connectorId
      ? await runtime.sources.getConnector(job.accountId, source.connectorId)
      : undefined;
    const meta = objectRecord(source?.meta);
    const version = meta.connector_refresh_version;
    const connectorConfig = objectRecord(connector?.config);
    const url = connectorConfig.url;
    const expectedFormat: "csv" | "json" = connector?.type === "url_json" ? "json" : "csv";
    if (!source || !connector || typeof version !== "string" || !version || typeof url !== "string" || !url) {
      await failPreparingJob(job, connector?.id, "PREPARE_STATE_INVALID");
      return true;
    }

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

async function repairPendingSourceDeletes(): Promise<number> {
  const runtime = storageRuntime();
  const accounts = await runtime.ledger.all<{ account_id: string }>(
    "SELECT DISTINCT account_id FROM pending_source_deletes ORDER BY account_id"
  );
  let completed = 0;
  for (const row of accounts) {
    const intents = await runtime.sources.listPendingSourceDeletes(row.account_id, 1_000);
    const outcome = await completeSourceDeleteIntents(intents);
    if (outcome.completed) completed += outcome.intents;
  }
  return completed;
}

/** Recover durable state before opening the listening socket, then start bounded pumps. */
export async function startIngestionWorkers(): Promise<void> {
  if (workersStarted) return;
  await recoverExpiredIngestionLeases(true);
  await recoverPreparingConnectorLeases(true);
  await runSourceMaintenance(
    () => storageRuntime().vectorLifecycle.repair({ completePendingSourceDeletes: repairPendingSourceDeletes }),
    undefined
  );
  await processDatasetCacheCleanup();
  workersStopping = false;
  if (!ingestionAbortController || ingestionAbortController.signal.aborted) {
    ingestionAbortController = new AbortController();
  }
  workersStarted = true;
  wakeConnectorPrepareWorkers();
  wakeIngestionWorkers();

  leaseTimer = setInterval(() => {
    void recoverExpiredIngestionLeases()
      .then(() => recoverPreparingConnectorLeases())
      .then(() => {
        wakeConnectorPrepareWorkers();
        wakeIngestionWorkers();
      })
      .catch(() => appLog.warn({ error_code: "LEASE_RECOVERY_FAILED" }, "ingestion lease recovery failed"));
  }, 15_000);
  leaseTimer.unref();

  let reconciling = false;
  reconciliationTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void runWithRequestContext("storage-reconciliation.periodic", async () => {
      await runSourceMaintenance(
        () => storageRuntime().vectorLifecycle.repair({ completePendingSourceDeletes: repairPendingSourceDeletes }),
        undefined
      );
      await restoreDatasets(1);
      await processDatasetCacheCleanup();
    })
      .catch(() => appLog.warn({ error_code: "STORAGE_RECONCILIATION_FAILED" }, "storage reconciliation failed"))
      .finally(() => {
        reconciling = false;
      });
  }, 60_000);
  reconciliationTimer.unref();
}

export async function stopIngestionWorkers(): Promise<void> {
  if (leaseTimer) clearInterval(leaseTimer);
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  leaseTimer = undefined;
  reconciliationTimer = undefined;
  workersStarted = false;
  workersStopping = true;
  ingestionRepump = false;
  connectorPrepareRepump = false;
  const controller = ingestionAbortController;
  controller?.abort(new DOMException("ingestion workers stopped", "AbortError"));
  await Promise.allSettled([ingestionPump, connectorPreparePump].filter(Boolean) as Promise<void>[]);
  if (ingestionAbortController === controller) ingestionAbortController = undefined;
  cachedEngine = undefined;
  workersStopping = false;
}

export interface RestoreSummary {
  attempted: number;
  restored: number;
  failed: number;
  stale_attempted: number;
  removed: number;
  remove_failed: number;
}

/** Rebuild the in-memory DuckDB registry from exact ready SQLite identities. */
export async function restoreDatasets(_attempts = 8): Promise<RestoreSummary> {
  const runtime = storageRuntime();
  const rows = await runtime.ledger.all<RegistryRow>(
    `SELECT u.id AS account_id, s.id AS source_id, s.name, s.file_path, s.display_name,
            s.url, s.connector, s.mime, s.status, s.meta
       FROM users u
       LEFT JOIN sources s ON s.account_id=u.id AND s.kind='tabular'
       ORDER BY u.id,s.name`
  );
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
      const meta = source.meta ? decodeJson<Record<string, unknown>>(source.meta, "source meta") : {};
      let cleanupLocation =
        typeof meta.connector_previous_location === "string" && meta.connector_previous_location !== source.file_path
          ? meta.connector_previous_location
          : undefined;
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
