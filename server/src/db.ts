import { config } from "./config.js";
import {
  closeEmbeddingMigrationCoordinator,
  embeddingMigrationCoordinator,
  EmbeddingMigrationError,
} from "./embeddingMigration.js";
import { getRuntimeSettings } from "./runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, mayAdoptLegacyEmbeddingIdentity } from "./storageRuntime.js";
import { engineManager } from "./contained/runtime.js";

/** Open the embedded relational ledger and vector index for this process. */
export async function initDb(): Promise<void> {
  const migration = embeddingMigrationCoordinator();
  await migration.recoverBeforeStorageOpen();
  try {
    await openConfiguredStorage();
  } catch (error) {
    if (!(await migration.rollbackStartupFailure("STARTUP_OPEN_FAILED"))) throw error;
    await openConfiguredStorage();
    return;
  }
  try {
    await migration.finalizeAfterStorageOpen();
  } catch (error) {
    if (!(error instanceof EmbeddingMigrationError) || error.code !== "STARTUP_SMOKE_FAILED") {
      await closeStorageRuntime().catch(() => undefined);
      throw error;
    }
    await closeStorageRuntime();
    if (!(await migration.rollbackStartupFailure("STARTUP_SMOKE_FAILED"))) throw error;
    await openConfiguredStorage();
  }
}

/** Close the paired embedded stores during an orderly shutdown. */
export async function closeDb(): Promise<void> {
  // The contained engine is a child process of this backend: stop it before
  // the ledger and vector index close, bounded like every other shutdown step.
  await engineManager.stop().catch(() => undefined);
  await closeEmbeddingMigrationCoordinator();
  await closeStorageRuntime();
}

async function openConfiguredStorage(): Promise<void> {
  const settings = await getRuntimeSettings();
  await initializeStorageRuntime({
    sqlitePath: config.sqlitePath,
    lanceDirectory: config.lanceDir,
    embeddingDimension: settings.settings.embeddingDimension,
    embeddingModel: settings.settings.embedModel,
    allowLegacyEmbeddingIdentityAdoption: mayAdoptLegacyEmbeddingIdentity(settings),
  });
}
