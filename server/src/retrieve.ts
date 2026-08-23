import { q } from "./db.js";
import { embed } from "./llm.js";

export async function retrieve(
  accountId: string,
  query: string,
  allowedSourceIds: readonly string[],
  topK = 6
): Promise<any[]> {
  if (!query.trim() || !allowedSourceIds.length) return [];
  const [vec] = await embed([query]);
  const rows = await q(
    `SELECT content, source_name,
            1 - (embedding <=> $2::vector) AS score
     FROM chunks
     WHERE account_id = $1
       AND source_id = ANY($3::uuid[])
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector
     LIMIT $4`,
    [accountId, `[${vec.join(",")}]`, [...allowedSourceIds], topK]
  );
  return rows.map((r) => ({ ...r, score: Number(r.score).toFixed(4) }));
}
