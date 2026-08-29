import { config } from "./config.js";
import { closeStorageRuntime, initializeStorageRuntime } from "./storageRuntime.js";
import { engineManager } from "./contained/runtime.js";

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
  // The contained engine is a child process of this backend: stop it before
  // the ledger and vector index close, bounded like every other shutdown step.
  await engineManager.stop().catch(() => undefined);
  await closeStorageRuntime();
}
