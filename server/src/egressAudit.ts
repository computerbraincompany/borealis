import type { RemoteEgressTarget } from "./egressPolicy.js";
import { storageRuntime } from "./storageRuntime.js";

export type EgressEventKind = "consent_acknowledged" | "remote_turn" | "remote_ingest";

export interface EgressEvent {
  readonly id: number;
  readonly kind: EgressEventKind;
  readonly endpoint_host: string | null;
  readonly created_at: string;
}

export const MAX_EGRESS_HOST_CHARS = 255;

/**
 * Content-free egress audit: who, what kind, which endpoint host, when. Best
 * effort by design — an audit write failure must never fail the request that
 * produced it, and nothing recorded here may reach application logs.
 */
export async function recordEgressEvent(
  kind: EgressEventKind,
  accountId: string,
  endpointHost?: string | null
): Promise<void> {
  try {
    await storageRuntime().ledger.run("INSERT INTO egress_events (account_id,kind,endpoint_host) VALUES (?,?,?)", [
      accountId,
      kind,
      endpointHost ? String(endpointHost).slice(0, MAX_EGRESS_HOST_CHARS) : null,
    ]);
  } catch {
    // Best effort: durable audit is advisory, never load-bearing.
  }
}

/**
 * Records a remote-egress receipt for an operation already authorized against
 * this exact target. It never re-reads live Settings, so an A-authorized
 * operation can never be attributed to a later provider B. Local/private
 * targets emit nothing, matching the settled pre-plan behavior.
 */
export async function auditRemoteEgressTarget(
  kind: EgressEventKind,
  accountId: string,
  target: RemoteEgressTarget
): Promise<void> {
  if (target.locality !== "remote") return;
  await recordEgressEvent(kind, accountId, target.host);
}

export async function listEgressEvents(accountIdValue: string, limitValue: number): Promise<EgressEvent[]> {
  const limit = Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 200 ? limitValue : 50;
  const rows = await storageRuntime().ledger.all<{
    id?: unknown;
    kind?: unknown;
    endpoint_host?: unknown;
    created_at?: unknown;
  }>(
    `SELECT id,kind,endpoint_host,created_at FROM egress_events
     WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT ?`,
    [accountIdValue, limit]
  );
  return rows.map((row) =>
    Object.freeze({
      id: Number(row.id),
      kind: row.kind as EgressEventKind,
      endpoint_host: row.endpoint_host === null || row.endpoint_host === undefined ? null : String(row.endpoint_host),
      created_at: String(row.created_at),
    })
  );
}
