import type { PendingSourceDelete } from "./db/stores/sourceStore.js";
import { dataService } from "./dataService.js";
import { storageRuntime } from "./storageRuntime.js";
import { removeSourceArtifact } from "./storageArtifacts.js";

const MAX_DELETE_BATCH = 1_000;
const CLEANUP_RETRY_CODE = "SOURCE_CLEANUP_RETRY";

export interface SourceCleanupDependencies {
  deleteVectors(sourceId: string): Promise<number>;
  deactivateDatasetLocation(accountId: string, name: string, location: string): Promise<unknown>;
  cleanupDatasetCache(accountId: string, name: string, location: string): Promise<unknown>;
  removeUploadArtifact(intent: PendingSourceDelete): Promise<unknown>;
  markFailure(intent: PendingSourceDelete): Promise<unknown>;
  clearIntent(intent: PendingSourceDelete): Promise<unknown>;
}

export interface SourceCleanupResult {
  readonly completed: boolean;
  readonly intents: number;
}

/**
 * Complete durable source deletions outside SQLite transactions. Every LanceDB
 * purge finishes before filesystem or DuckDB cleanup begins. A failed batch
 * keeps all remaining markers for idempotent boot repair.
 */
export async function completeSourceDeleteIntents(
  intentsInput: readonly PendingSourceDelete[],
  dependencies: SourceCleanupDependencies = runtimeDependencies()
): Promise<SourceCleanupResult> {
  if (!Array.isArray(intentsInput) || intentsInput.length > MAX_DELETE_BATCH) {
    throw new RangeError(`source cleanup accepts at most ${MAX_DELETE_BATCH} intents`);
  }
  const intents = uniqueIntents(intentsInput);
  if (intents.length === 0) return Object.freeze({ completed: true, intents: 0 });
  try {
    for (const intent of intents) await dependencies.deleteVectors(intent.sourceId);
    for (const intent of intents) await cleanupExternalArtifacts(intent, dependencies);
    for (const intent of intents) await dependencies.clearIntent(intent);
    return Object.freeze({ completed: true, intents: intents.length });
  } catch {
    await Promise.allSettled(intents.map((intent) => dependencies.markFailure(intent)));
    return Object.freeze({ completed: false, intents: intents.length });
  }
}

function uniqueIntents(intents: readonly PendingSourceDelete[]): PendingSourceDelete[] {
  const bySource = new Map<string, PendingSourceDelete>();
  for (const intent of intents) {
    if (!intent || typeof intent.sourceId !== "string" || !intent.sourceId) {
      throw new TypeError("source cleanup intent is invalid");
    }
    bySource.set(intent.sourceId, intent);
  }
  return [...bySource.values()];
}

async function cleanupExternalArtifacts(
  intent: PendingSourceDelete,
  dependencies: SourceCleanupDependencies
): Promise<void> {
  if (intent.connectorId) {
    for (const location of intent.datasetLocations) {
      await dependencies.deactivateDatasetLocation(intent.accountId, intent.name, location);
      await dependencies.cleanupDatasetCache(intent.accountId, intent.name, location);
    }
    return;
  }
  if (!intent.filePath) return;
  await dependencies.deactivateDatasetLocation(intent.accountId, intent.name, intent.filePath);
  await dependencies.removeUploadArtifact(intent);
}

function runtimeDependencies(): SourceCleanupDependencies {
  const runtime = storageRuntime();
  return {
    deleteVectors: (sourceId) => runtime.vectors.deleteSource(sourceId),
    deactivateDatasetLocation: (accountId, name, location) =>
      dataService.deactivateDatasetLocation(accountId, name, location),
    cleanupDatasetCache: (accountId, name, location) => dataService.cleanupDatasetCache(accountId, name, location),
    removeUploadArtifact: (intent) =>
      removeSourceArtifact({
        accountId: intent.accountId,
        sourceId: intent.sourceId,
        name: intent.name,
        filePath: intent.filePath ?? "",
        connector: null,
      }),
    markFailure: (intent) =>
      runtime.sources.updatePendingSourceDelete(intent.accountId, intent.sourceId, {
        lastError: CLEANUP_RETRY_CODE,
        incrementAttempts: true,
      }),
    clearIntent: (intent) => runtime.sources.clearPendingSourceDelete(intent.accountId, intent.sourceId),
  };
}
