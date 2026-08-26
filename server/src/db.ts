import { config } from "./config.js";
import { closeStorageRuntime, initializeStorageRuntime } from "./storageRuntime.js";

/** Open the embedded relational ledger and vector index for this process. */
export async function initDb(): Promise<void> {
  await initializeStorageRuntime({
    sqlitePath: config.sqlitePath,
    lanceDirectory: config.lanceDir,
    embeddingDimension: config.embeddingDim,
  });
}

/** Close the paired embedded stores during an orderly shutdown. */
export async function closeDb(): Promise<void> {
  await closeStorageRuntime();
}
