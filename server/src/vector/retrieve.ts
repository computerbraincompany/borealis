import type { SqliteIngestionStore } from "../db/stores/ingestionStore.js";
import type { LanceVectorIndex } from "./lance.js";

export interface RetrievedPassage {
  readonly chunk_id: string;
  readonly source_id: string;
  readonly source: string;
  readonly content: string;
  readonly score: number;
}

/** Fail-closed LanceDB KNN followed by a tenant-scoped SQLite text join. */
export async function retrieveWithVector(
  store: SqliteIngestionStore,
  vectors: LanceVectorIndex,
  input: {
    accountId: string;
    allowedSourceIds: readonly string[];
    vector: readonly number[] | Float32Array;
    topK: number;
  }
): Promise<readonly RetrievedPassage[]> {
  if (!input.allowedSourceIds.length) return [];
  if (!Number.isSafeInteger(input.topK) || input.topK < 1 || input.topK > 100) {
    throw new RangeError("topK must be an integer between 1 and 100");
  }
  const sourceGenerations = await store.readyGenerationScopes(input.accountId, input.allowedSourceIds);
  if (!sourceGenerations.length) return [];
  const readySourceIds = sourceGenerations.map((scope) => scope.sourceId);
  const hits = await vectors.search({
    accountId: input.accountId,
    sourceIds: readySourceIds,
    sourceGenerations,
    vector: input.vector,
    limit: input.topK,
  });
  if (!hits.length) return [];
  const passages = await store.loadPassages({
    accountId: input.accountId,
    sourceIds: readySourceIds,
    chunkIds: hits.map((hit) => hit.chunkId),
  });
  return Object.freeze(
    hits.flatMap((hit): RetrievedPassage[] => {
      const passage = passages.get(hit.chunkId);
      if (!passage || !Number.isFinite(hit.distance)) return [];
      return [
        Object.freeze({
          chunk_id: hit.chunkId,
          source_id: passage.sourceId,
          source: passage.source,
          content: passage.content,
          score: 1 - hit.distance,
        }),
      ];
    })
  );
}
