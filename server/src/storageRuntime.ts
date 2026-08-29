import path from "node:path";

import { ChatStore } from "./db/stores/chatStore.js";
import { AgentStore } from "./db/stores/agentStore.js";
import { SqliteIngestionStore } from "./db/stores/ingestionStore.js";
import { LibraryStore } from "./db/stores/libraryStore.js";
import { RunStore } from "./db/stores/runStore.js";
import { SourceIngestionTransitions } from "./db/stores/sourceIngestionTransitions.js";
import { SourceStore } from "./db/stores/sourceStore.js";
import { openSqliteLedger } from "./db/sqlite.js";
import type { SqliteLedger } from "./db/types.js";
import { LanceVectorIndex } from "./vector/lance.js";
import { IngestionVectorLifecycle } from "./vector/lifecycle.js";

export interface StorageRuntimeOptions {
  readonly sqlitePath: string;
  readonly lanceDirectory: string;
  readonly embeddingDimension: number;
}

export interface StorageRuntime {
  readonly sqlitePath: string;
  readonly lanceDirectory: string;
  readonly ledger: SqliteLedger;
  readonly chats: ChatStore;
  readonly runs: RunStore;
  readonly sources: SourceStore;
  readonly libraries: LibraryStore;
  readonly agents: AgentStore;
  readonly sourceIngestion: SourceIngestionTransitions;
  readonly ingestion: SqliteIngestionStore;
  readonly vectors: LanceVectorIndex;
  readonly vectorLifecycle: IngestionVectorLifecycle;
}

let active: StorageRuntime | undefined;
let initializing: Promise<StorageRuntime> | undefined;

function normalizedOptions(options: StorageRuntimeOptions): StorageRuntimeOptions {
  if (!Number.isSafeInteger(options.embeddingDimension) || options.embeddingDimension < 1) {
    throw new RangeError("embeddingDimension must be a positive safe integer");
  }
  return Object.freeze({
    sqlitePath: path.resolve(options.sqlitePath),
    lanceDirectory: path.resolve(options.lanceDirectory),
    embeddingDimension: options.embeddingDimension,
  });
}

function sameRuntime(runtime: StorageRuntime, options: StorageRuntimeOptions): boolean {
  return (
    runtime.sqlitePath === options.sqlitePath &&
    runtime.lanceDirectory === options.lanceDirectory &&
    runtime.vectors.dimension === options.embeddingDimension
  );
}

export async function initializeStorageRuntime(optionsValue: StorageRuntimeOptions): Promise<StorageRuntime> {
  const options = normalizedOptions(optionsValue);
  if (active) {
    if (!sameRuntime(active, options)) throw new Error("storage runtime is already initialized with different paths");
    return active;
  }
  if (initializing) {
    const runtime = await initializing;
    if (!sameRuntime(runtime, options)) throw new Error("storage runtime is initializing with different paths");
    return runtime;
  }
  const opening = (async () => {
    const ledger = await openSqliteLedger({ path: options.sqlitePath });
    let vectors: LanceVectorIndex | undefined;
    try {
      vectors = await LanceVectorIndex.open({
        directory: options.lanceDirectory,
        dimension: options.embeddingDimension,
      });
      const ingestion = new SqliteIngestionStore(ledger);
      const runtime: StorageRuntime = Object.freeze({
        sqlitePath: ledger.path,
        lanceDirectory: vectors.directory,
        ledger,
        chats: new ChatStore(ledger),
        runs: new RunStore(ledger),
        libraries: new LibraryStore(ledger),
        agents: new AgentStore(ledger),
        sources: new SourceStore(ledger),
        sourceIngestion: new SourceIngestionTransitions(ledger),
        ingestion,
        vectors,
        vectorLifecycle: new IngestionVectorLifecycle(ingestion, vectors),
      });
      active = runtime;
      return runtime;
    } catch (error) {
      await vectors?.close().catch(() => {});
      await ledger.close().catch(() => {});
      throw error;
    }
  })();
  initializing = opening;
  try {
    return await opening;
  } finally {
    if (initializing === opening) initializing = undefined;
  }
}

export function storageRuntime(): StorageRuntime {
  if (!active) throw new Error("storage runtime is not initialized");
  return active;
}

export async function closeStorageRuntime(): Promise<void> {
  if (initializing) await initializing.catch(() => {});
  const runtime = active;
  if (!runtime) return;
  active = undefined;
  await runtime.vectors.close();
  await runtime.ledger.close();
}
