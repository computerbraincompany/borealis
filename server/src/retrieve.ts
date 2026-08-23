import { q } from "./db.js";
import { embed } from "./llm.js";

export interface RetrievedPassage {
  chunk_id: string;
  source_id: string;
  source: string;
  content: string;
  score: number;
}

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
  const rows = await q(
    `SELECT chunks.id::text AS chunk_id,
            chunks.source_id::text AS source_id,
            chunks.content,
            COALESCE(NULLIF(sources.display_name, ''), chunks.source_name, 'Source') AS source,
            1 - (chunks.embedding <=> $2::vector) AS score
     FROM chunks
     LEFT JOIN sources
       ON sources.id = chunks.source_id
      AND sources.account_id = chunks.account_id
     WHERE chunks.account_id = $1
       AND chunks.source_id = ANY($3::uuid[])
       AND chunks.embedding IS NOT NULL
     ORDER BY chunks.embedding <=> $2::vector
     LIMIT $4`,
    [accountId, `[${vec.join(",")}]`, [...allowedSourceIds], topK]
  );
  return rows.flatMap((row): RetrievedPassage[] => {
    const chunkId = typeof row.chunk_id === "string" ? row.chunk_id : "";
    const sourceId = typeof row.source_id === "string" ? row.source_id : "";
    const source = typeof row.source === "string" ? row.source : "";
    const content = typeof row.content === "string" ? row.content : "";
    const score = Number(row.score);
    if (!chunkId || !sourceId || !source || !content || !Number.isFinite(score)) return [];
    return [{ chunk_id: chunkId, source_id: sourceId, source, content, score }];
  });
}
