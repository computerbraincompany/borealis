import type {
  PendingVectorOperation,
  SqliteIngestionStore,
  StagedChunk,
  StagedChunkInput,
} from "../db/stores/ingestionStore.js";
import type { LanceVectorIndex, LanceVectorRow } from "./lance.js";

interface SourceLock {
  tail: Promise<void>;
  references: number;
}

const sourceLocks = new Map<string, SourceLock>();

async function withSourceLock<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
  const lock = sourceLocks.get(sourceId) ?? { tail: Promise.resolve(), references: 0 };
  lock.references += 1;
  sourceLocks.set(sourceId, lock);
  const previous = lock.tail;
  let release!: () => void;
  lock.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
    lock.references -= 1;
    if (lock.references === 0 && sourceLocks.get(sourceId) === lock) sourceLocks.delete(sourceId);
  }
}

export interface IndexedChunkInput extends StagedChunkInput {
  readonly vector: readonly number[] | Float32Array;
}

export interface VectorRepairSummary {
  readonly repaired_vectors: number;
  readonly repaired_deletes: number;
  readonly failed_operations: number;
}

export interface PromoteHooks {
  /** Crash-injection barrier after the durable SQLite commit and before LanceDB pruning. */
  afterCommit?: () => Promise<void>;
}

/** Coordinates the SQLite/LanceDB crash protocol. It never stores passage text in LanceDB. */
export class IngestionVectorLifecycle {
  constructor(
    readonly store: SqliteIngestionStore,
    readonly vectors: LanceVectorIndex
  ) {}

  async stageAndIndex(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken: string;
    sourceName: string;
    chunks: readonly IndexedChunkInput[];
  }): Promise<readonly string[]> {
    return withSourceLock(input.sourceId, async () => {
      const staged = await this.stageTextUnlocked({
        ...input,
        chunks: input.chunks.map(({ content, meta }) => ({ content, meta })),
      });
      await this.indexBatchUnlocked({
        accountId: input.accountId,
        sourceId: input.sourceId,
        generation: input.generation,
        leaseToken: input.leaseToken,
        chunks: staged.map((chunk, index) => ({ chunk, vector: input.chunks[index]!.vector })),
      });
      return Object.freeze(staged.map((chunk) => chunk.chunkId));
    });
  }

  async stageText(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken: string;
    sourceName: string;
    chunks: readonly StagedChunkInput[];
  }): Promise<readonly StagedChunk[]> {
    return withSourceLock(input.sourceId, () => this.stageTextUnlocked(input));
  }

  async indexBatch(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken: string;
    chunks: readonly Readonly<{ chunk: StagedChunk; vector: readonly number[] | Float32Array }>[];
  }): Promise<void> {
    return withSourceLock(input.sourceId, () => this.indexBatchUnlocked(input));
  }

  async promote(
    input: {
      accountId: string;
      sourceId: string;
      generation: number;
      leaseToken: string;
      sizeBytes: number;
      promotedFilePath?: string;
    },
    hooks: PromoteHooks = {}
  ): Promise<{ readonly chunkCount: number }> {
    return withSourceLock(input.sourceId, async () => {
      const result = await this.store.promoteGeneration({
        ...input,
        verifyVectors: (chunkIds) => this.vectors.hasAll(chunkIds, input.sourceId, input.generation),
      });
      await hooks.afterCommit?.();
      await this.drainSourceVectorOperations(input.sourceId);
      return result;
    });
  }

  async failGeneration(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken?: string;
    errorCode: string;
    failure?: Readonly<{ summary: string; detail: string; stage: string }>;
    terminal?: boolean;
    retryAt?: Date;
  }): Promise<boolean> {
    return withSourceLock(input.sourceId, async () => {
      const owned = await this.store.failGeneration(input);
      await this.drainSourceVectorOperations(input.sourceId);
      return owned;
    });
  }

  async drainPendingVectorOperations(limit = 100): Promise<VectorRepairSummary> {
    let repairedVectors = 0;
    let failedOperations = 0;
    const operations = await this.store.listPendingVectorOperations(limit);
    for (const operation of operations) {
      const outcome = await withSourceLock(operation.sourceId, () => this.applyVectorOperation(operation));
      repairedVectors += outcome.repaired;
      failedOperations += outcome.failed;
    }
    return Object.freeze({
      repaired_vectors: repairedVectors,
      repaired_deletes: 0,
      failed_operations: failedOperations,
    });
  }

  async repair(options: { completePendingSourceDeletes?: () => Promise<number> } = {}): Promise<VectorRepairSummary> {
    const pending = await this.drainPendingVectorOperations();
    let repairedDeletes = 0;
    let failedOperations = pending.failed_operations;
    if (options.completePendingSourceDeletes) {
      try {
        repairedDeletes = await options.completePendingSourceDeletes();
      } catch {
        failedOperations += 1;
      }
    }

    const state = await this.store.vectorRepairState();
    const vectorRows = await this.vectors.scanRows();
    const missingSources = new Set<string>();
    const invalidGenerations = new Map<string, Set<number>>();
    const missingChunkIds: string[] = [];
    for (const row of vectorRows) {
      const source = state.sources.get(row.sourceId);
      if (!source) {
        missingSources.add(row.sourceId);
        continue;
      }
      if (source.accountId !== row.accountId) {
        missingChunkIds.push(row.chunkId);
        continue;
      }
      const generationAllowed =
        source.readyGeneration === row.generation || source.inProgressGenerations.has(row.generation);
      if (!generationAllowed) {
        const generations = invalidGenerations.get(row.sourceId) ?? new Set<number>();
        generations.add(row.generation);
        invalidGenerations.set(row.sourceId, generations);
        continue;
      }
      if (!state.validChunkIds.has(row.chunkId)) missingChunkIds.push(row.chunkId);
    }

    let repairedVectors = pending.repaired_vectors;
    for (const sourceId of missingSources) {
      try {
        repairedVectors += await withSourceLock(sourceId, () => this.vectors.deleteSource(sourceId));
      } catch {
        failedOperations += 1;
      }
    }
    for (const [sourceId, generations] of invalidGenerations) {
      if (missingSources.has(sourceId)) continue;
      for (const generation of generations) {
        try {
          repairedVectors += await withSourceLock(sourceId, () => this.vectors.deleteGeneration(sourceId, generation));
        } catch {
          failedOperations += 1;
        }
      }
    }
    for (let start = 0; start < missingChunkIds.length; start += 10_000) {
      try {
        repairedVectors += await this.vectors.deleteMissing(missingChunkIds.slice(start, start + 10_000));
      } catch {
        failedOperations += 1;
      }
    }
    return Object.freeze({
      repaired_vectors: repairedVectors,
      repaired_deletes: repairedDeletes,
      failed_operations: failedOperations,
    });
  }

  private async drainSourceVectorOperations(sourceId: string): Promise<void> {
    const operations = (await this.store.listPendingVectorOperations(1_000)).filter(
      (operation) => operation.sourceId === sourceId
    );
    for (const operation of operations) await this.applyVectorOperation(operation);
  }

  private async stageTextUnlocked(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken: string;
    sourceName: string;
    chunks: readonly StagedChunkInput[];
  }): Promise<readonly StagedChunk[]> {
    const staged = await this.store.stageChunks(input);
    if (staged.obsoleteChunkIds.length) await this.vectors.deleteMissing(staged.obsoleteChunkIds);
    return staged.chunks;
  }

  private async indexBatchUnlocked(input: {
    accountId: string;
    sourceId: string;
    generation: number;
    leaseToken: string;
    chunks: readonly Readonly<{ chunk: StagedChunk; vector: readonly number[] | Float32Array }>[];
  }): Promise<void> {
    await this.store.assertLease(input.accountId, input.sourceId, input.generation, input.leaseToken);
    const rows: LanceVectorRow[] = input.chunks.map(({ chunk, vector }) => {
      if (
        chunk.accountId !== input.accountId ||
        chunk.sourceId !== input.sourceId ||
        chunk.generation !== input.generation
      ) {
        throw new Error("staged chunk identity mismatch");
      }
      return {
        chunkId: chunk.chunkId,
        accountId: chunk.accountId,
        sourceId: chunk.sourceId,
        generation: chunk.generation,
        vector,
      };
    });
    await this.vectors.upsert(rows);
    await this.store.assertLease(input.accountId, input.sourceId, input.generation, input.leaseToken);
  }

  private async applyVectorOperation(
    operation: PendingVectorOperation
  ): Promise<{ readonly repaired: number; readonly failed: number }> {
    try {
      const keepOrAction = await this.store.vectorOperationKeepGenerations(operation);
      let repaired = 0;
      if (keepOrAction === null) {
        repaired = await this.vectors.deleteSource(operation.sourceId);
      } else if (operation.operation === "delete_generation") {
        if (keepOrAction.includes(operation.generation)) {
          repaired = await this.vectors.deleteGeneration(operation.sourceId, operation.generation);
        }
      } else if (keepOrAction.length) {
        repaired = await this.vectors.prune(operation.sourceId, keepOrAction);
      }
      await this.store.resolveVectorOperation(operation, "complete");
      return Object.freeze({ repaired, failed: 0 });
    } catch {
      await this.store.resolveVectorOperation(operation, "failed").catch(() => {});
      return Object.freeze({ repaired: 0, failed: 1 });
    }
  }
}
