import { embed } from "./llm.js";
import { storageRuntime } from "./storageRuntime.js";
import { retrieveWithVector, type RetrievedPassage } from "./vector/retrieve.js";

export type { RetrievedPassage } from "./vector/retrieve.js";

export async function retrieve(
  accountId: string,
  query: string,
  allowedSourceIds: readonly string[],
  topK = 6,
  signal?: AbortSignal
): Promise<RetrievedPassage[]> {
  if (!query.trim() || !allowedSourceIds.length) return [];
  const [vec] = await embed([query], signal);
  if (signal?.aborted) throw signal.reason;
  const runtime = storageRuntime();
  return [
    ...(await retrieveWithVector(runtime.ingestion, runtime.vectors, {
      accountId,
      allowedSourceIds,
      vector: vec,
      topK,
    })),
  ] satisfies RetrievedPassage[];
}
