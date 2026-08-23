import type { QueryResult, QueryResultRow } from "pg";

export interface GuardQueryable {
  query<T extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<T>>;
}

/**
 * Active runs carry the exact accepted source ids on their user-message
 * snapshot. Resource mutation must check that immutable ledger, not mutable
 * chat_sources/current `all` membership.
 */
export async function sourceReferencedByActiveRun(
  client: GuardQueryable,
  accountId: string,
  sourceId: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM chat_runs r
     JOIN messages m ON m.id=r.user_message_id
     WHERE r.account_id=$1
       AND r.status IN ('running','cancelling')
       AND COALESCE(m.meta->'source_ids','[]'::jsonb) ? $2::text
     LIMIT 1`,
    [accountId, sourceId]
  );
  return result.rows.length > 0;
}
