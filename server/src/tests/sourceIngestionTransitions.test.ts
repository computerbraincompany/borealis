import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { encodeJson } from "../db/codecs.js";
import { SqliteIngestionStore } from "../db/stores/ingestionStore.js";
import {
  SourceIngestionTransitions,
  type CreateConnectorPrepareInput,
} from "../db/stores/sourceIngestionTransitions.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];
const NOW = new Date("2026-08-26T10:00:00.000Z");

interface Fixture {
  readonly ledger: SqliteLedger;
  readonly transitions: SourceIngestionTransitions;
  readonly sources: SourceStore;
  readonly accountId: string;
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

describe("source/ingestion SQLite transitions", () => {
  it("atomically creates an upload and pending generation with collision-safe naming", async () => {
    const { ledger, transitions, sources, accountId } = await fixture();
    await sources.createSource(accountId, {
      id: randomUUID(),
      name: "ledger",
      kind: "tabular",
      displayName: "Existing.csv",
    });
    await ledger.run(
      `INSERT INTO connectors (id,account_id,name,type,config,target_table,sync_status)
       VALUES (?,?,?,?,?,?,'idle')`,
      [randomUUID(), accountId, "Reserved", "url_csv", encodeJson({ url: "https://example.test/a.csv" }), "ledger_1"]
    );

    const sourceId = randomUUID();
    const reserved = await transitions.createUploadSource(accountId, {
      id: sourceId,
      baseName: "ledger",
      kind: "tabular",
      displayName: "Ledger.csv",
      filePath: "/uploads/ledger.csv",
      mime: "text/csv",
      sizeBytes: 19,
    });
    expect(reserved).toMatchObject({ generation: 1, source: { id: sourceId, name: "ledger_2", status: "index" } });
    await expect(
      ledger.get(`SELECT generation,status,attempts,lease_token FROM ingestion_jobs WHERE source_id=?`, [sourceId])
    ).resolves.toEqual({ generation: 1n, status: "pending", attempts: 0n, lease_token: null });

    const unknownAccount = randomUUID();
    const rolledBackId = randomUUID();
    await expect(
      transitions.createUploadSource(unknownAccount, {
        id: rolledBackId,
        baseName: "missing",
        kind: "document",
        displayName: "Missing.txt",
        filePath: "/uploads/missing.txt",
        mime: "text/plain",
        sizeBytes: 1,
      })
    ).rejects.toMatchObject({ code: "SOURCE_TRANSITION_ACCOUNT_NOT_FOUND" });
    await expect(ledger.get(`SELECT id FROM sources WHERE id=?`, [rolledBackId])).resolves.toBeUndefined();
  });

  it("linearizes reingest against active snapshots and reserves a fresh generation with cleanup intents", async () => {
    const { ledger, transitions, accountId } = await fixture();
    const sourceId = randomUUID();
    await transitions.createUploadSource(accountId, {
      id: sourceId,
      baseName: "history",
      kind: "tabular",
      displayName: "History.csv",
      filePath: "/uploads/history.csv",
      mime: "text/csv",
      sizeBytes: 20,
    });
    await ledger.run(`UPDATE sources SET status='ready',ready_generation=1,meta=? WHERE id=? AND account_id=?`, [
      encodeJson({ error: "raw", error_code: "OLD", keep: true }),
      sourceId,
      accountId,
    ]);
    await ledger.run(`UPDATE ingestion_jobs SET generation=3,status='done' WHERE source_id=?`, [sourceId]);
    for (const generation of [2, 3]) {
      await ledger.run(
        `INSERT INTO ingestion_chunk_staging
           (chunk_id,source_id,generation,seq,account_id,source_name,content,meta)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), sourceId, generation, 0, accountId, "history", `generation ${generation}`, encodeJson({})]
      );
    }
    const chatId = randomUUID();
    const runId = randomUUID();
    await ledger.run(`INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,?,'selected')`, [
      chatId,
      accountId,
      "History",
      "qwen-chat",
    ]);
    await ledger.run(`INSERT INTO chat_runs (id,account_id,chat_id,status) VALUES (?,?,?,'running')`, [
      runId,
      accountId,
      chatId,
    ]);
    await ledger.run(`INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)`, [
      runId,
      sourceId,
      accountId,
    ]);

    await expect(transitions.reserveSourceReingest(accountId, sourceId)).rejects.toMatchObject({
      code: "SOURCE_TRANSITION_SOURCE_IN_USE",
    });
    await expect(ledger.get(`SELECT generation FROM ingestion_jobs WHERE source_id=?`, [sourceId])).resolves.toEqual({
      generation: 3n,
    });
    await ledger.run(`UPDATE chat_runs SET status='completed',finished_at=? WHERE id=?`, [NOW.toISOString(), runId]);

    const reservation = await transitions.reserveSourceReingest(accountId, sourceId);
    expect(reservation).toMatchObject({
      generation: 4,
      source: { status: "index", meta: { keep: true }, readyGeneration: 1 },
    });
    await expect(
      ledger.all(`SELECT generation FROM ingestion_chunk_staging WHERE source_id=?`, [sourceId])
    ).resolves.toEqual([]);
    const cleanup = await ledger.all<{ generation: bigint }>(
      `SELECT generation FROM pending_vector_ops WHERE source_id=? ORDER BY generation`,
      [sourceId]
    );
    expect(cleanup).toEqual([{ generation: 2n }, { generation: 3n }]);
  });

  it("atomically creates connector/source/preparing lease and rejects occupied targets without partial rows", async () => {
    const { ledger, transitions, sources, accountId } = await fixture();
    const input = connectorInput("transactions");
    const reserved = await transitions.createConnectorPrepare(accountId, input);
    expect(reserved).toMatchObject({
      generation: 1,
      refreshVersion: input.refreshVersion,
      leaseToken: input.leaseToken,
      connector: { id: input.connectorId, syncStatus: "syncing", targetTable: "transactions" },
      source: {
        id: input.sourceId,
        connectorId: input.connectorId,
        status: "index",
        // Protocol state is typed; `sources.meta` carries none of it.
        meta: {},
      },
    });
    await expect(
      ledger.get(`SELECT generation,status,attempts,lease_token,leased_at FROM ingestion_jobs WHERE source_id=?`, [
        input.sourceId,
      ])
    ).resolves.toEqual({
      generation: 1n,
      status: "preparing",
      attempts: 1n,
      lease_token: input.leaseToken,
      leased_at: NOW.toISOString(),
    });
    // The `preparing` protocol row is reserved in the same transaction.
    await expect(
      ledger.get(
        `SELECT account_id,connector_id,generation,refresh_version,phase,candidate_location
         FROM connector_refresh_states WHERE source_id=?`,
        [input.sourceId]
      )
    ).resolves.toEqual({
      account_id: accountId,
      connector_id: input.connectorId,
      generation: 1n,
      refresh_version: input.refreshVersion,
      phase: "preparing",
      candidate_location: null,
    });

    await sources.createSource(accountId, {
      id: randomUUID(),
      name: "occupied",
      kind: "tabular",
      displayName: "Occupied.csv",
    });
    const collision = connectorInput("occupied");
    await expect(transitions.createConnectorPrepare(accountId, collision)).rejects.toMatchObject({
      code: "SOURCE_TRANSITION_TARGET_CONFLICT",
    });
    await expect(sources.getConnector(accountId, collision.connectorId)).resolves.toBeUndefined();
    await expect(sources.getSource(accountId, collision.sourceId)).resolves.toBeUndefined();
    await expect(
      ledger.get(`SELECT 1 FROM connector_refresh_states WHERE source_id=?`, [collision.sourceId])
    ).resolves.toBeUndefined();
  });

  it("guards connector refresh and reserves its exact next preparing generation", async () => {
    const { ledger, transitions, sources, accountId } = await fixture();
    const input = connectorInput("refreshable");
    await transitions.createConnectorPrepare(accountId, input);
    await sources.updateConnectorSyncState(accountId, input.connectorId, {
      status: "idle",
      expectedStatuses: ["syncing"],
    });
    await sources.updateSourceStatus(accountId, input.sourceId, {
      status: "ready",
      readyGeneration: 1,
      meta: { error: "old", keep: true },
    });
    await ledger.run(`UPDATE ingestion_jobs SET status='done',leased_at=NULL,lease_token=NULL WHERE source_id=?`, [
      input.sourceId,
    ]);
    const chatId = randomUUID();
    const runId = randomUUID();
    await ledger.run(`INSERT INTO chats (id,account_id,title,model) VALUES (?,?,?,?)`, [
      chatId,
      accountId,
      "Refresh",
      "qwen-chat",
    ]);
    await ledger.run(`INSERT INTO chat_runs (id,account_id,chat_id,status) VALUES (?,?,?,'cancelling')`, [
      runId,
      accountId,
      chatId,
    ]);
    await ledger.run(`INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)`, [
      runId,
      input.sourceId,
      accountId,
    ]);
    const refresh = {
      accountId,
      connectorId: input.connectorId,
      refreshVersion: randomUUID(),
      leaseToken: randomUUID(),
    };
    await expect(transitions.beginConnectorRefresh(refresh)).rejects.toMatchObject({
      code: "SOURCE_TRANSITION_SOURCE_IN_USE",
    });
    await ledger.run(`UPDATE chat_runs SET status='cancelled',finished_at=? WHERE id=?`, [NOW.toISOString(), runId]);

    const reserved = await transitions.beginConnectorRefresh(refresh);
    expect(reserved).toMatchObject({
      generation: 2,
      refreshVersion: refresh.refreshVersion,
      leaseToken: refresh.leaseToken,
      connector: { syncStatus: "syncing" },
      source: {
        status: "index",
        readyGeneration: 1,
        // Error metadata is cleared; the refresh identity lives only in the
        // typed protocol row.
        meta: { keep: true },
      },
    });
    await expect(
      ledger.get(`SELECT generation,status,attempts,lease_token FROM ingestion_jobs WHERE source_id=?`, [
        input.sourceId,
      ])
    ).resolves.toEqual({
      generation: 2n,
      status: "preparing",
      attempts: 1n,
      lease_token: refresh.leaseToken,
    });
    // The superseded first-generation preparing row was replaced, not stacked.
    await expect(
      ledger.get(
        `SELECT connector_id,generation,refresh_version,phase FROM connector_refresh_states WHERE source_id=?`,
        [input.sourceId]
      )
    ).resolves.toEqual({
      connector_id: input.connectorId,
      generation: 2n,
      refresh_version: refresh.refreshVersion,
      phase: "preparing",
    });
    await expect(ledger.get(`SELECT COUNT(*) AS rows FROM connector_refresh_states`)).resolves.toEqual({ rows: 1n });
  });

  it("refuses a begin that would discard ambiguous durable activation state", async () => {
    const { ledger, transitions, sources, accountId } = await fixture();
    const input = connectorInput("ambiguous_begin");
    const first = await transitions.createConnectorPrepare(accountId, input);
    // Simulate a terminal prepare-failure that never happened: instead leave
    // an `activating` row (the CAS-in-flight uncertainty state) with the
    // connector reset so only the typed row can refuse the begin.
    await transitions.activatePreparedConnector({
      accountId,
      connectorId: input.connectorId,
      sourceId: input.sourceId,
      generation: first.generation,
      leaseToken: input.leaseToken,
      refreshVersion: input.refreshVersion,
      url: input.url,
      displayName: "Ambiguous feed",
      mime: "text/csv",
      candidateLocation: "/cache/ambiguous-candidate.csv",
      activationPreviousLocation: "/cache/ambiguous-previous.csv",
      cleanupPreviousLocation: null,
    });
    await ledger.run(`UPDATE connector_refresh_states SET phase='activating' WHERE source_id=?`, [input.sourceId]);
    await sources.updateConnectorSyncState(accountId, input.connectorId, {
      status: "idle",
      expectedStatuses: ["indexing"],
    });
    await ledger.run(`UPDATE ingestion_jobs SET status='error',leased_at=NULL,lease_token=NULL WHERE source_id=?`, [
      input.sourceId,
    ]);

    await expect(
      transitions.beginConnectorRefresh({
        accountId,
        connectorId: input.connectorId,
        refreshVersion: randomUUID(),
        leaseToken: randomUUID(),
      })
    ).rejects.toMatchObject({ code: "SOURCE_TRANSITION_CONNECTOR_SYNC_ACTIVE" });
    // The ambiguous row and its candidate identities are untouched.
    await expect(
      ledger.get(
        `SELECT phase,candidate_location,activation_previous_location FROM connector_refresh_states WHERE source_id=?`,
        [input.sourceId]
      )
    ).resolves.toEqual({
      phase: "activating",
      candidate_location: "/cache/ambiguous-candidate.csv",
      activation_previous_location: "/cache/ambiguous-previous.csv",
    });
  });

  it("activates a prepared candidate only for the exact source/generation/version/lease", async () => {
    const { ledger, transitions, accountId } = await fixture();
    const input = connectorInput("activation");
    const reserved = await transitions.createConnectorPrepare(accountId, input);
    const activation = {
      accountId,
      connectorId: input.connectorId,
      sourceId: input.sourceId,
      generation: reserved.generation,
      leaseToken: input.leaseToken,
      refreshVersion: input.refreshVersion,
      url: "https://example.test/activation-new.csv",
      displayName: "Activation feed",
      mime: "text/csv",
      candidateLocation: "/cache/candidate.csv",
      activationPreviousLocation: "/cache/activation-previous.csv",
      cleanupPreviousLocation: "/cache/cleanup-previous.csv",
    };

    await expect(
      transitions.activatePreparedConnector({ ...activation, leaseToken: randomUUID() })
    ).rejects.toMatchObject({ code: "SOURCE_TRANSITION_PREPARE_SUPERSEDED" });
    await expect(ledger.get(`SELECT status FROM ingestion_jobs WHERE source_id=?`, [input.sourceId])).resolves.toEqual({
      status: "preparing",
    });

    await ledger.run(
      `INSERT INTO dataset_cache_cleanup_jobs (account_id,name,location)
       VALUES (?,?,?)`,
      [accountId, input.targetTable, activation.candidateLocation]
    );
    await expect(transitions.activatePreparedConnector(activation)).rejects.toMatchObject({
      code: "SOURCE_TRANSITION_PREPARE_SUPERSEDED",
    });
    await expect(ledger.get(`SELECT status FROM ingestion_jobs WHERE source_id=?`, [input.sourceId])).resolves.toEqual({
      status: "preparing",
    });
    await ledger.run(
      `DELETE FROM dataset_cache_cleanup_jobs
       WHERE account_id=? AND name=? AND location=?`,
      [accountId, input.targetTable, activation.candidateLocation]
    );

    const activated = await transitions.activatePreparedConnector(activation);
    expect(activated).toMatchObject({
      generation: 1,
      connector: { syncStatus: "indexing" },
      source: {
        status: "index",
        url: activation.url,
        // Adoption writes the typed protocol row, never `sources.meta`.
        meta: {},
      },
    });
    await expect(
      ledger.get(`SELECT status,lease_token,leased_at FROM ingestion_jobs WHERE source_id=?`, [input.sourceId])
    ).resolves.toEqual({ status: "pending", lease_token: null, leased_at: null });
    await expect(
      ledger.get(
        `SELECT phase,generation,refresh_version,candidate_location,activation_previous_location,cleanup_previous_location
         FROM connector_refresh_states WHERE source_id=?`,
        [input.sourceId]
      )
    ).resolves.toEqual({
      phase: "prepared",
      generation: 1n,
      refresh_version: input.refreshVersion,
      candidate_location: activation.candidateLocation,
      activation_previous_location: activation.activationPreviousLocation,
      cleanup_previous_location: activation.cleanupPreviousLocation,
    });

    // A second adoption of a different version against the same exact
    // prepared row loses its CAS and must not mutate the adopted state.
    await expect(
      transitions.activatePreparedConnector({ ...activation, refreshVersion: randomUUID() })
    ).rejects.toMatchObject({ code: "SOURCE_TRANSITION_PREPARE_SUPERSEDED" });
    await expect(
      ledger.get(`SELECT phase,refresh_version,candidate_location FROM connector_refresh_states WHERE source_id=?`, [
        input.sourceId,
      ])
    ).resolves.toEqual({
      phase: "prepared",
      refresh_version: input.refreshVersion,
      candidate_location: activation.candidateLocation,
    });
  });

  it("defers only an exactly-owned preparing lease and exposes bounded ingestion summaries", async () => {
    const { ledger, transitions, accountId } = await fixture();
    const input = connectorInput("deferred");
    const reserved = await transitions.createConnectorPrepare(accountId, input);

    await expect(
      transitions.deferConnectorPrepare({
        accountId,
        sourceId: input.sourceId,
        generation: reserved.generation,
        leaseToken: randomUUID(),
      })
    ).resolves.toBe(false);
    await expect(
      transitions.deferConnectorPrepare({
        accountId,
        sourceId: input.sourceId,
        generation: reserved.generation,
        leaseToken: input.leaseToken,
      })
    ).resolves.toBe(true);
    await expect(
      ledger.get(`SELECT status,lease_token,leased_at,last_error,available_at FROM ingestion_jobs WHERE source_id=?`, [
        input.sourceId,
      ])
    ).resolves.toEqual({
      status: "preparing",
      lease_token: null,
      leased_at: null,
      last_error: "PREPARE_TRANSIENT",
      available_at: "2026-08-26T10:00:02.000Z",
    });

    const summaries = await transitions.ingestionSummaries(accountId, [input.sourceId, input.sourceId]);
    expect(summaries.get(input.sourceId)).toEqual({
      sourceId: input.sourceId,
      attempts: 1,
      updatedAt: NOW.toISOString(),
    });
    await expect(transitions.ingestionSummaries(accountId, [])).resolves.toEqual(new Map());
  });

  it("terminalizes only an exactly-owned connector prepare and preserves a last-good generation", async () => {
    const { ledger, transitions, sources, accountId } = await fixture();
    const first = connectorInput("failed_first_sync");
    await transitions.createConnectorPrepare(accountId, first);
    await ledger.run(
      `INSERT INTO ingestion_chunk_staging
         (chunk_id,source_id,generation,seq,account_id,source_name,content,meta)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomUUID(), first.sourceId, 1, 0, accountId, first.targetTable, "partial", encodeJson({})]
    );

    await expect(
      transitions.failConnectorPrepare({
        accountId,
        connectorId: first.connectorId,
        sourceId: first.sourceId,
        generation: 1,
        leaseToken: randomUUID(),
        errorCode: "PREPARE_FAILED",
      })
    ).resolves.toBe(false);
    await expect(
      transitions.failConnectorPrepare({
        accountId,
        connectorId: first.connectorId,
        sourceId: first.sourceId,
        generation: 1,
        leaseToken: first.leaseToken,
        errorCode: "PREPARE_FAILED",
      })
    ).resolves.toBe(true);
    await expect(sources.getSource(accountId, first.sourceId)).resolves.toMatchObject({
      status: "error",
      meta: { error_code: "PREPARE_FAILED" },
    });
    await expect(sources.getConnector(accountId, first.connectorId)).resolves.toMatchObject({
      syncStatus: "error",
      syncError: "Connector sync failed.",
    });
    await expect(
      ledger.get(`SELECT status,last_error,lease_token FROM ingestion_jobs WHERE source_id=?`, [first.sourceId])
    ).resolves.toEqual({ status: "error", last_error: "PREPARE_FAILED", lease_token: null });
    await expect(
      ledger.all(`SELECT chunk_id FROM ingestion_chunk_staging WHERE source_id=?`, [first.sourceId])
    ).resolves.toEqual([]);
    await expect(
      ledger.get(`SELECT operation,generation FROM pending_vector_ops WHERE source_id=?`, [first.sourceId])
    ).resolves.toEqual({ operation: "delete_generation", generation: 1n });

    const later = connectorInput("failed_refresh");
    await transitions.createConnectorPrepare(accountId, later);
    await ledger.run(`UPDATE sources SET status='ready',file_path=?,ready_generation=1,meta=? WHERE id=?`, [
      "/cache/live.csv",
      encodeJson({ keep: true }),
      later.sourceId,
    ]);
    await ledger.run(
      `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
       VALUES (?,?,?,?,?,?,?,?)`,
      [randomUUID(), accountId, later.sourceId, 1, 0, later.targetTable, "last good", encodeJson({})]
    );
    await ledger.run(`UPDATE ingestion_jobs SET status='done',leased_at=NULL,lease_token=NULL WHERE source_id=?`, [
      later.sourceId,
    ]);
    await sources.updateConnectorSyncState(accountId, later.connectorId, {
      status: "idle",
      expectedStatuses: ["syncing"],
    });
    const refresh = await transitions.beginConnectorRefresh({
      accountId,
      connectorId: later.connectorId,
      refreshVersion: randomUUID(),
      leaseToken: randomUUID(),
    });
    await expect(
      transitions.failConnectorPrepare({
        accountId,
        connectorId: later.connectorId,
        sourceId: later.sourceId,
        generation: refresh.generation,
        leaseToken: refresh.leaseToken,
        errorCode: "PREPARE_FAILED",
      })
    ).resolves.toBe(true);
    await expect(sources.getSource(accountId, later.sourceId)).resolves.toMatchObject({
      status: "ready",
      readyGeneration: 1,
      meta: { keep: true },
    });
  });
});

describe("dataset-cache cleanup retry order", () => {
  it("keeps untouched cleanup jobs ahead of retried work even at a tied clock", async () => {
    const { ledger, accountId } = await fixture();
    const ingestion = new SqliteIngestionStore(ledger);
    const fixed = NOW.toISOString();
    for (const [name, location] of [
      ["jobs_a", "/cache/fair-a.csv"],
      ["jobs_b", "/cache/fair-b.csv"],
      ["jobs_c", "/cache/fair-c.csv"],
    ]) {
      await ledger.run(
        `INSERT INTO dataset_cache_cleanup_jobs (account_id,name,location,attempts,created_at,updated_at)
         VALUES (?,?,?,0,?,?)`,
        [accountId, name, location, fixed, fixed]
      );
    }

    await expect(ingestion.listDatasetCleanupJobs({ limit: 1 })).resolves.toEqual([
      { accountId, name: "jobs_a", location: "/cache/fair-a.csv", attempts: 0 },
    ]);

    await ingestion.resolveDatasetCleanupJob(
      { accountId, name: "jobs_a", location: "/cache/fair-a.csv", attempts: 0 },
      "failed"
    );
    await expect(ingestion.getDatasetCleanupJob(accountId, "jobs_a", "/cache/fair-a.csv")).resolves.toMatchObject({
      attempts: 1,
    });
    // Simulate a wall clock that ties or moves backward: every row shares
    // one updated_at, so only the attempts key can keep fairness.
    await ledger.run("UPDATE dataset_cache_cleanup_jobs SET updated_at=?", [fixed]);

    // A bounded page takes the untouched work first; the failed row waits.
    await expect(ingestion.listDatasetCleanupJobs({ limit: 2 })).resolves.toEqual([
      { accountId, name: "jobs_b", location: "/cache/fair-b.csv", attempts: 0 },
      { accountId, name: "jobs_c", location: "/cache/fair-c.csv", attempts: 0 },
    ]);
    await expect(ingestion.listDatasetCleanupJobs({ limit: 3 })).resolves.toEqual([
      { accountId, name: "jobs_b", location: "/cache/fair-b.csv", attempts: 0 },
      { accountId, name: "jobs_c", location: "/cache/fair-c.csv", attempts: 0 },
      { accountId, name: "jobs_a", location: "/cache/fair-a.csv", attempts: 1 },
    ]);
  });
});

async function fixture(): Promise<Fixture> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const accountId = randomUUID();
  await resource.ledger.run(`INSERT INTO users (id,email,password_hash) VALUES (?,?,?)`, [
    accountId,
    `${accountId}@example.test`,
    "hash",
  ]);
  return {
    ledger: resource.ledger,
    transitions: new SourceIngestionTransitions(resource.ledger, { now: () => new Date(NOW) }),
    sources: new SourceStore(resource.ledger),
    accountId,
  };
}

function connectorInput(targetTable: string): CreateConnectorPrepareInput {
  return {
    connectorId: randomUUID(),
    sourceId: randomUUID(),
    displayName: `${targetTable} feed`,
    targetTable,
    type: "url_csv",
    url: `https://example.test/${targetTable}.csv`,
    refreshVersion: randomUUID(),
    leaseToken: randomUUID(),
  };
}
