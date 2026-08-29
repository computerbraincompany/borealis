import { storageRuntime } from "./storageRuntime.js";

export type ConnectorSyncTrigger = "create" | "manual" | "scheduled";
export type ConnectorSyncOutcome = "succeeded" | "failed" | "skipped";

export interface ConnectorSyncRecord {
  readonly id: number;
  readonly trigger: ConnectorSyncTrigger;
  readonly outcome: ConnectorSyncOutcome;
  readonly detail: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

const MAX_DETAIL_CHARS = 200;
const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;

/**
 * Content-free connector sync history: which trigger, which outcome, when.
 * Best effort by design — a history write failure must never fail the request
 * or automation run that produced it. No URLs, no row counts, no error bodies.
 * Rows cascade away with their connector through the schema v10 foreign key.
 */
export async function recordConnectorSync(input: {
  readonly accountId: string;
  readonly connectorId: string;
  readonly trigger: ConnectorSyncTrigger;
  readonly outcome: ConnectorSyncOutcome;
  readonly detail?: string | null;
  /** When the sync attempt began; omit to stamp the write time. */
  readonly startedAt?: string;
}): Promise<void> {
  try {
    const startedAt = input.startedAt ?? new Date().toISOString();
    await storageRuntime().ledger.run(
      `INSERT INTO connector_syncs (connector_id,account_id,trigger,outcome,detail,started_at,finished_at)
       VALUES (?,?,?,?,?,?,?)`,
      [
        input.connectorId,
        input.accountId,
        input.trigger,
        input.outcome,
        input.detail === null || input.detail === undefined ? null : String(input.detail).slice(0, MAX_DETAIL_CHARS),
        startedAt,
        new Date().toISOString(),
      ]
    );
  } catch {
    // Best effort: history is advisory, never load-bearing (including unknown
    // or just-deleted connectors, where the foreign key rejects the row).
  }
}

/** The connector's history, newest first, bounded; unknown connectors resolve empty. */
export async function listConnectorSyncs(
  accountIdValue: string,
  connectorIdValue: string,
  limitValue: number
): Promise<ConnectorSyncRecord[]> {
  const limit =
    Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= MAX_LIST_LIMIT
      ? limitValue
      : DEFAULT_LIST_LIMIT;
  const rows = await storageRuntime().ledger.all<{
    id?: unknown;
    trigger?: unknown;
    outcome?: unknown;
    detail?: unknown;
    started_at?: unknown;
    finished_at?: unknown;
  }>(
    `SELECT id,trigger,outcome,detail,started_at,finished_at FROM connector_syncs
     WHERE connector_id=? AND account_id=?
     ORDER BY started_at DESC,id DESC LIMIT ?`,
    [connectorIdValue, accountIdValue, limit]
  );
  return rows.map((row) =>
    Object.freeze({
      id: Number(row.id),
      trigger: row.trigger as ConnectorSyncTrigger,
      outcome: row.outcome as ConnectorSyncOutcome,
      detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
      started_at: String(row.started_at),
      finished_at: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    })
  );
}
