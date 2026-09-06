import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeJson } from "../db/codecs.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  createSourceStore,
  PENDING_SOURCE_DELETE_SNAPSHOT_TABLE,
  type CreateConnectorInput,
  type CreateSourceInput,
  type PendingSourceDeleteSnapshot,
  type SourceStore,
} from "../db/stores/sourceStore.js";
import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const REPAIR_CLOCK = "2026-08-26T10:00:00.000Z";

const resources: TempSqliteLedger[] = [];

interface Fixture {
  readonly resource: TempSqliteLedger;
  readonly ledger: SqliteLedger;
  readonly store: SourceStore;
  readonly owner: string;
  readonly foreign: string;
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

describe("SQLite SourceStore", () => {
  it("provides bounded, decoded, tenant-scoped source CRUD and semantic conflicts", async () => {
    const { store, owner, foreign } = await fixture();
    const sourceId = randomUUID();
    const created = await store.createSource(owner, {
      id: sourceId,
      name: "monthly_budget",
      kind: "tabular",
      displayName: "Monthly budget.csv",
      filePath: "/owned/monthly-budget.csv",
      mime: "text/csv",
      sizeBytes: 42,
      status: "index",
      meta: { preview: true },
    });

    expect(created).toMatchObject({
      id: sourceId,
      accountId: owner,
      name: "monthly_budget",
      sizeBytes: 42,
      status: "index",
      meta: { preview: true },
      readyGeneration: null,
    });
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(store.listSources(owner)).resolves.toEqual({ items: [created], next: null });
    await expect(store.getSource(foreign, sourceId)).resolves.toBeUndefined();
    await expect(store.updateSourceStatus(foreign, sourceId, { status: "error" })).rejects.toMatchObject({
      code: "SOURCE_STORE_SOURCE_NOT_FOUND",
    });
    await expect(store.deleteSource(foreign, sourceId)).rejects.toMatchObject({
      code: "SOURCE_STORE_SOURCE_NOT_FOUND",
    });

    const updated = await store.updateSourceStatus(owner, sourceId, {
      status: "ready",
      readyGeneration: 7,
      meta: { rows: 17, complete: true },
    });
    expect(updated).toMatchObject({ status: "ready", readyGeneration: 7, meta: { rows: 17, complete: true } });

    await expect(
      store.createSource(owner, {
        id: randomUUID(),
        name: "monthly_budget",
        kind: "tabular",
        displayName: "Duplicate.csv",
      })
    ).rejects.toMatchObject({ code: "SOURCE_STORE_SOURCE_NAME_CONFLICT" });
    await expect(store.listSources(owner, { limit: 0, after: null })).rejects.toMatchObject({
      code: "INVALID_CATALOG_CURSOR",
    });

    const foreignSource = await store.createSource(foreign, {
      id: randomUUID(),
      name: "monthly_budget",
      kind: "tabular",
      displayName: "Same name in another account.csv",
    });
    expect(foreignSource.accountId).toBe(foreign);
    await expect(store.listSources(owner)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: sourceId })],
    });
  });

  it("creates connector and source identity atomically and enforces the shared target namespace", async () => {
    const { store, owner, foreign } = await fixture();
    await store.createSource(owner, sourceInput("reserved_table"));

    const colliding = connectorInput("reserved_table", "idle");
    await expect(store.createConnector(owner, colliding)).rejects.toMatchObject({
      code: "SOURCE_STORE_CONNECTOR_TARGET_CONFLICT",
    });
    await expect(store.getConnector(owner, colliding.id)).resolves.toBeUndefined();
    await expect(store.getSource(owner, colliding.source.id)).resolves.toBeUndefined();

    const input = connectorInput("transactions_feed", "idle");
    const created = await store.createConnector(owner, input);
    expect(created.connector).toMatchObject({
      id: input.id,
      accountId: owner,
      type: "url_csv",
      targetTable: "transactions_feed",
      syncStatus: "idle",
      config: { url: "https://example.test/transactions_feed.csv" },
    });
    expect(created.source).toMatchObject({
      id: input.source.id,
      accountId: owner,
      connectorId: input.id,
      name: "transactions_feed",
      status: "index",
    });
    await expect(store.listConnectors(owner)).resolves.toEqual({ items: [created.connector], next: null });
    await expect(store.getConnector(foreign, input.id)).resolves.toBeUndefined();
    await expect(
      store.createSource(owner, {
        ...sourceInput("transactions_feed"),
        id: randomUUID(),
      })
    ).rejects.toMatchObject({ code: "SOURCE_STORE_SOURCE_NAME_CONFLICT" });

    const foreignConnector = await store.createConnector(foreign, {
      ...connectorInput("transactions_feed", "idle"),
      id: randomUUID(),
      source: { ...connectorInput("transactions_feed", "idle").source, id: randomUUID() },
    });
    expect(foreignConnector.connector.accountId).toBe(foreign);
  });

  it("uses guarded connector refresh claims and exact compare-and-set state updates", async () => {
    const { ledger, store, owner, foreign } = await fixture();
    const input = connectorInput("refreshable", "error");
    await store.createConnector(owner, { ...input, syncError: "previous failure" });

    const chatId = await selectedChat(ledger, owner, input.source.id);
    const runId = await runSnapshot(ledger, owner, chatId, input.source.id, "running");
    await expect(store.claimConnectorRefresh(owner, input.id)).rejects.toMatchObject({
      code: "SOURCE_STORE_SOURCE_IN_USE",
    });
    await ledger.run(`UPDATE chat_runs SET status='completed', finished_at=? WHERE account_id=? AND id=?`, [
      "2026-08-26T09:00:00.000Z",
      owner,
      runId,
    ]);

    const claimed = await store.claimConnectorRefresh(owner, input.id);
    expect(claimed.connector).toMatchObject({ syncStatus: "syncing", syncError: null });
    expect(claimed.source.id).toBe(input.source.id);
    await expect(store.claimConnectorRefresh(owner, input.id)).rejects.toMatchObject({
      code: "SOURCE_STORE_CONNECTOR_SYNC_ACTIVE",
    });

    const indexing = await store.updateConnectorSyncState(owner, input.id, {
      status: "indexing",
      expectedStatuses: ["syncing"],
    });
    expect(indexing.syncStatus).toBe("indexing");
    await expect(
      store.updateConnectorSyncState(owner, input.id, { status: "idle", expectedStatuses: ["syncing"] })
    ).rejects.toMatchObject({ code: "SOURCE_STORE_CONNECTOR_STATE_CONFLICT" });

    const completed = await store.updateConnectorSyncState(owner, input.id, {
      status: "idle",
      syncError: null,
      lastSync: "2026-08-26T12:30:00+02:00",
      expectedStatuses: ["indexing"],
    });
    expect(completed).toMatchObject({ syncStatus: "idle", syncError: null, lastSync: "2026-08-26T10:30:00.000Z" });
    await expect(
      store.updateConnectorSyncState(foreign, input.id, { status: "error", syncError: "no access" })
    ).rejects.toMatchObject({ code: "SOURCE_STORE_CONNECTOR_NOT_FOUND" });
  });

  it("guards active run snapshots and atomically preserves cleanup metadata before source deletion", async () => {
    const { resource, ledger, store, owner, foreign } = await fixture();
    const connector = connectorInput("guarded_source", "idle", {
      filePath: "/cache/current.csv",
      meta: {},
    });
    await store.createConnector(owner, connector);
    // The exact refresh locations are typed protocol state.
    await ledger.run(
      `INSERT INTO connector_refresh_states
         (source_id,account_id,connector_id,generation,refresh_version,phase,
          candidate_location,activation_previous_location,cleanup_previous_location)
       VALUES (?,?,?,1,'typed-refresh','activating',?,?,?)`,
      [connector.source.id, owner, connector.id, "/cache/candidate.csv", "/cache/activation.csv", "/cache/previous.csv"]
    );
    const chatId = await selectedChat(ledger, owner, connector.source.id);
    const runId = await runSnapshot(ledger, owner, chatId, connector.source.id, "running");

    await expect(store.deleteSource(foreign, connector.source.id)).rejects.toMatchObject({
      code: "SOURCE_STORE_SOURCE_NOT_FOUND",
    });
    await expect(store.deleteSource(owner, connector.source.id)).rejects.toMatchObject({
      code: "SOURCE_STORE_SOURCE_IN_USE",
    });
    await expect(store.deleteConnector(owner, connector.id)).rejects.toMatchObject({
      code: "SOURCE_STORE_SOURCE_IN_USE",
    });
    await expect(store.listPendingSourceDeletes(owner)).resolves.toEqual([]);
    await expect(store.getSource(owner, connector.source.id)).resolves.toBeDefined();

    await ledger.run(`UPDATE chat_runs SET status='completed', finished_at=? WHERE account_id=? AND id=?`, [
      "2026-08-26T10:00:00.000Z",
      owner,
      runId,
    ]);
    const deleted = await store.deleteSource(owner, connector.source.id);
    expect(deleted).toMatchObject({ alreadyPending: false, connectorDeleted: true });
    expect(deleted.intent).toMatchObject({
      sourceId: connector.source.id,
      connectorId: connector.id,
      filePath: "/cache/current.csv",
      attempts: 0,
      lastError: null,
    });
    expect(deleted.intent.datasetLocations).toEqual([
      "/cache/current.csv",
      "/cache/candidate.csv",
      "/cache/activation.csv",
      "/cache/previous.csv",
    ]);
    await expect(store.getSource(owner, connector.source.id)).resolves.toBeUndefined();
    await expect(store.getConnector(owner, connector.id)).resolves.toBeUndefined();
    // The typed refresh row cascaded away only after the intent captured it.
    await expect(
      ledger.get(`SELECT 1 FROM connector_refresh_states WHERE source_id=?`, [connector.source.id])
    ).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM chat_sources WHERE chat_id=?", [chatId])).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM chat_run_sources WHERE run_id=?", [runId])).resolves.toBeUndefined();
    await expect(ledger.get("SELECT source_mode FROM chats WHERE id=?", [chatId])).resolves.toEqual({
      source_mode: "selected",
    });

    await resource.ledger.close();
    const reopened = await openSqliteLedger({ path: resource.filename });
    try {
      const recovered = createSourceStore(reopened);
      await expect(recovered.listPendingSourceDeletes(owner)).resolves.toEqual([deleted.intent]);
    } finally {
      await reopened.close();
    }
  });

  it("keeps pending source deletions idempotent and supports bounded failure/clear retries", async () => {
    const { store, owner, foreign } = await fixture();
    const input = sourceInput("retry_delete", {
      filePath: "/uploads/retry-delete.csv",
      meta: {},
    });
    await store.createSource(owner, input);

    const first = await store.deleteSource(owner, input.id);
    expect(first.alreadyPending).toBe(false);
    const failed = await store.updatePendingSourceDelete(owner, input.id, {
      lastError: "VECTOR_DELETE_RETRY",
      incrementAttempts: true,
      updatedAt: "2026-08-26T11:00:00Z",
    });
    expect(failed).toMatchObject({ attempts: 1, lastError: "VECTOR_DELETE_RETRY" });

    const retried = await store.deleteSource(owner, input.id);
    expect(retried).toMatchObject({ alreadyPending: true, intent: failed });
    await expect(store.createSource(owner, { ...sourceInput("new_name"), id: input.id })).rejects.toMatchObject({
      code: "SOURCE_STORE_SOURCE_ID_CONFLICT",
    });
    const replacement = await store.createSource(owner, { ...sourceInput("retry_delete"), id: randomUUID() });
    expect(replacement.name).toBe("retry_delete");

    const unchangedAttempts = await store.updatePendingSourceDelete(owner, input.id, {
      lastError: null,
      incrementAttempts: false,
    });
    expect(unchangedAttempts).toMatchObject({ attempts: 1, lastError: null });
    await expect(store.clearPendingSourceDelete(foreign, input.id)).resolves.toBe(false);
    await expect(store.clearPendingSourceDelete(owner, input.id)).resolves.toBe(true);
    await expect(store.clearPendingSourceDelete(owner, input.id)).resolves.toBe(false);
  });

  it("deletes connector-owned sources only through durable per-source reservations", async () => {
    const { ledger, store, owner, foreign } = await fixture();
    const input = connectorInput("connector_delete", "idle", {
      filePath: "/cache/connector-delete.csv",
    });
    await store.createConnector(owner, input);
    const secondSource = randomUUID();
    await ledger.run(
      `INSERT INTO sources
         (id,account_id,name,kind,connector,display_name,file_path,status,meta)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        secondSource,
        owner,
        "connector_delete_aux",
        "tabular",
        input.id,
        "Auxiliary feed",
        "/cache/connector-delete-aux.csv",
        "ready",
        encodeJson({}),
      ]
    );
    await ledger.run(
      `INSERT INTO connector_refresh_states
         (source_id,account_id,connector_id,generation,refresh_version,phase,
          candidate_location,cleanup_previous_location)
       VALUES (?,?,?,1,'aux-cleanup','cleanup_pending',?,?)`,
      [secondSource, owner, input.id, "/cache/connector-delete-aux.csv", "/cache/connector-delete-aux-old.csv"]
    );

    await expect(
      ledger.run(`DELETE FROM connectors WHERE account_id=? AND id=?`, [owner, input.id])
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(store.deleteConnector(foreign, input.id)).rejects.toMatchObject({
      code: "SOURCE_STORE_CONNECTOR_NOT_FOUND",
    });
    const deleted = await store.deleteConnector(owner, input.id);
    expect(deleted.alreadyPending).toBe(false);
    expect(deleted.intents.map((intent) => intent.sourceId).sort()).toEqual([input.source.id, secondSource].sort());
    await expect(store.getConnector(owner, input.id)).resolves.toBeUndefined();
    await expect(store.listSources(owner)).resolves.toEqual({ items: [], next: null });
    await expect(
      ledger.get(`SELECT 1 FROM connector_refresh_states WHERE source_id=?`, [secondSource])
    ).resolves.toBeUndefined();
    await expect(store.deleteConnector(owner, input.id)).resolves.toMatchObject({
      connectorId: input.id,
      alreadyPending: true,
      intents: expect.arrayContaining([...deleted.intents]),
    });
  });

  it("snapshots every legal typed refresh phase into the durable intent before cascade", async () => {
    const { ledger, store, owner } = await fixture();
    const cases: Array<{
      table: string;
      filePath: string;
      phase: "preparing" | "prepared" | "activating" | "cleanup_pending";
      candidate: string | null;
      activation: string | null;
      cleanup: string | null;
      expected: string[];
    }> = [
      {
        table: "phase_preparing",
        filePath: "/cache/p-live.csv",
        phase: "preparing",
        candidate: null,
        activation: null,
        cleanup: null,
        expected: ["/cache/p-live.csv"],
      },
      {
        table: "phase_prepared",
        filePath: "/cache/q-live.csv",
        phase: "prepared",
        candidate: "/cache/q-candidate.csv",
        activation: "/cache/q-activation.csv",
        cleanup: null,
        expected: ["/cache/q-live.csv", "/cache/q-candidate.csv", "/cache/q-activation.csv"],
      },
      {
        table: "phase_activating",
        filePath: "/cache/r-live.csv",
        phase: "activating",
        candidate: "/cache/r-candidate.csv",
        activation: "/cache/r-activation.csv",
        cleanup: "/cache/r-cleanup.csv",
        expected: ["/cache/r-live.csv", "/cache/r-candidate.csv", "/cache/r-activation.csv", "/cache/r-cleanup.csv"],
      },
      {
        table: "phase_cleanup",
        filePath: "/cache/s-live.csv",
        phase: "cleanup_pending",
        // The candidate equals the live path: the union must de-duplicate it.
        candidate: "/cache/s-live.csv",
        activation: null,
        cleanup: "/cache/s-retired.csv",
        expected: ["/cache/s-live.csv", "/cache/s-retired.csv"],
      },
    ];
    const created: Array<(typeof cases)[number] & { sourceId: string; connectorId: string }> = [];
    for (const testCase of cases) {
      const connector = connectorInput(testCase.table, "idle", { filePath: testCase.filePath, status: "ready" });
      await store.createConnector(owner, connector);
      await ledger.run(
        `INSERT INTO connector_refresh_states
           (source_id,account_id,connector_id,generation,refresh_version,phase,
            candidate_location,activation_previous_location,cleanup_previous_location)
         VALUES (?,?,?,1,?,?,?,?,?)`,
        [
          connector.source.id,
          owner,
          connector.id,
          `v-${testCase.table}`,
          testCase.phase,
          testCase.candidate,
          testCase.activation,
          testCase.cleanup,
        ]
      );
      await ledger.run(`UPDATE sources SET ready_generation=1 WHERE id=?`, [connector.source.id]);
      created.push({ ...testCase, sourceId: connector.source.id, connectorId: connector.id });
    }

    for (const item of created) {
      const deleted = await store.deleteSource(owner, item.sourceId);
      expect(deleted.intent.datasetLocations, item.table).toEqual(item.expected);
      await expect(
        ledger.get(`SELECT 1 FROM connector_refresh_states WHERE source_id=?`, [item.sourceId])
      ).resolves.toBeUndefined();
    }
    // The durable Plan-011 intents are the surviving cleanup authority.
    const pending = await store.listPendingSourceDeletes(owner);
    expect(pending).toHaveLength(created.length);

    // A connector-level bulk delete snapshots its source's activating row.
    const bulk = connectorInput("phase_bulk", "idle", { filePath: "/cache/b-live.csv", status: "ready" });
    await store.createConnector(owner, bulk);
    await ledger.run(
      `INSERT INTO connector_refresh_states
         (source_id,account_id,connector_id,generation,refresh_version,phase,
          candidate_location,activation_previous_location,cleanup_previous_location)
       VALUES (?,?,?,1,'v-bulk','activating',?,?,?)`,
      [bulk.source.id, owner, bulk.id, "/cache/b-candidate.csv", "/cache/b-activation.csv", "/cache/b-cleanup.csv"]
    );
    const bulkDelete = await store.deleteConnector(owner, bulk.id);
    expect(bulkDelete.intents[0]!.datasetLocations).toEqual([
      "/cache/b-live.csv",
      "/cache/b-candidate.csv",
      "/cache/b-activation.csv",
      "/cache/b-cleanup.csv",
    ]);
    await expect(
      ledger.get(`SELECT 1 FROM connector_refresh_states WHERE source_id=?`, [bulk.source.id])
    ).resolves.toBeUndefined();
  });

  it("rolls back a deletion transaction after reservation, changing neither source, typed state, nor intent", async () => {
    const { ledger, store, owner } = await fixture();
    const connector = connectorInput("rollback_delete", "idle", {
      filePath: "/cache/rollback-live.csv",
      status: "ready",
    });
    await store.createConnector(owner, connector);
    await ledger.run(
      `INSERT INTO connector_refresh_states
         (source_id,account_id,connector_id,generation,refresh_version,phase,candidate_location)
       VALUES (?,?,?,1,'v-rollback','prepared',?)`,
      [connector.source.id, owner, connector.id, "/cache/rollback-candidate.csv"]
    );

    const original = ledger.withImmediateTransaction.bind(ledger);
    const spy = vi.spyOn(ledger, "withImmediateTransaction").mockImplementation(async (callback) =>
      original(async (transaction) => {
        await callback(transaction);
        // Fail after the reservation ran so the whole BEGIN IMMEDIATE rolls back.
        throw new Error("injected post-reservation failure");
      })
    );

    await expect(store.deleteSource(owner, connector.source.id)).rejects.toThrow("injected post-reservation failure");
    spy.mockRestore();

    await expect(store.getSource(owner, connector.source.id)).resolves.toBeDefined();
    await expect(
      ledger.get(`SELECT phase FROM connector_refresh_states WHERE source_id=?`, [connector.source.id])
    ).resolves.toEqual({ phase: "prepared" });
    await expect(store.listPendingSourceDeletes(owner)).resolves.toEqual([]);

    // The un-injected path still reserves exactly the typed locations.
    const deleted = await store.deleteSource(owner, connector.source.id);
    expect(deleted.intent.datasetLocations).toEqual(["/cache/rollback-live.csv", "/cache/rollback-candidate.csv"]);
  });

  it("linearizes active-run acceptance before source mutation through the shared writer gate", async () => {
    const { resource, ledger, store, owner } = await fixture();
    const source = sourceInput("ordered_source");
    await store.createSource(owner, source);
    const chatId = await selectedChat(ledger, owner, source.id);
    const second = await openSqliteLedger({ path: resource.filename });
    let entered!: () => void;
    const transactionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runId = randomUUID();
    const accepting = second.withImmediateTransaction(async (transaction) => {
      transaction.run(`INSERT INTO chat_runs (id,account_id,chat_id,status) VALUES (?,?,?,'running')`, [
        runId,
        owner,
        chatId,
      ]);
      transaction.run(`INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)`, [
        runId,
        source.id,
        owner,
      ]);
      entered();
      await held;
    });
    await transactionEntered;

    let deletionSettled = false;
    const deleting = store.deleteSource(owner, source.id).finally(() => {
      deletionSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deletionSettled).toBe(false);
    release();
    await accepting;
    await expect(deleting).rejects.toMatchObject({ code: "SOURCE_STORE_SOURCE_IN_USE" });
    await expect(store.getSource(owner, source.id)).resolves.toBeDefined();
    await expect(store.listPendingSourceDeletes(owner)).resolves.toEqual([]);
    await second.close();
  });
});

describe("global pending source-delete repair page", () => {
  it("bounds the total across accounts and orders by attempts, then time, then identity", async () => {
    const { ledger, store } = await fixture();
    await seedRepairIntent(ledger, "acct-a", "s-01");
    await seedRepairIntent(ledger, "acct-a", "s-02");
    await seedRepairIntent(ledger, "acct-b", "b-01");

    const full = await store.listPendingSourceDeletesAcrossAccounts(10);
    expect(full.map((intent) => [intent.accountId, intent.sourceId])).toEqual([
      ["acct-a", "s-01"],
      ["acct-a", "s-02"],
      ["acct-b", "b-01"],
    ]);
    expect(full[2]).toMatchObject({ accountId: "acct-b", name: "t_b-01", attempts: 0, lastError: null });

    // The global limit bounds the returned total across every account.
    await expect(store.listPendingSourceDeletesAcrossAccounts(2)).resolves.toMatchObject([
      { accountId: "acct-a", sourceId: "s-01" },
      { accountId: "acct-a", sourceId: "s-02" },
    ]);

    // A failed row moves behind every untouched row even at a tied clock.
    const failed = await store.updatePendingSourceDelete("acct-a", "s-01", {
      lastError: "SOURCE_CLEANUP_RETRY",
      incrementAttempts: true,
      updatedAt: REPAIR_CLOCK,
    });
    expect(failed).toMatchObject({ attempts: 1, updatedAt: REPAIR_CLOCK });
    await expect(store.listPendingSourceDeletesAcrossAccounts(3)).resolves.toMatchObject([
      { accountId: "acct-a", sourceId: "s-02", attempts: 0 },
      { accountId: "acct-b", sourceId: "b-01", attempts: 0 },
      { accountId: "acct-a", sourceId: "s-01", attempts: 1 },
    ]);

    await expect(store.listPendingSourceDeletesAcrossAccounts(0)).rejects.toMatchObject({
      code: "SOURCE_STORE_INVALID_ARGUMENT",
    });
    await expect(store.listPendingSourceDeletesAcrossAccounts(1_001)).rejects.toMatchObject({
      code: "SOURCE_STORE_INVALID_ARGUMENT",
    });

    // The account-scoped method stays tenant-isolated.
    const scoped = await store.listPendingSourceDeletes("acct-a", 10);
    expect(scoped.map((intent) => intent.sourceId)).toEqual(["s-01", "s-02"]);
    expect(scoped.every((intent) => intent.accountId === "acct-a")).toBe(true);
  });
});

describe("startup pending source-delete snapshot boundary", () => {
  interface PassResult {
    pages: number[];
    intents: [string, string][];
    missingOrdinals: number[];
    maxOrdinal: number;
  }

  async function drainSnapshot(
    snapshot: PendingSourceDeleteSnapshot,
    afterSecondPage?: () => Promise<void>
  ): Promise<PassResult> {
    const pages: number[] = [];
    const intents: [string, string][] = [];
    const missingOrdinals: number[] = [];
    let cursor = 0;
    let maxOrdinal = 0;
    try {
      for (;;) {
        const page = await snapshot.read(cursor, 100);
        pages.push(page.length);
        if (page.length === 0) break;
        for (const entry of page) {
          maxOrdinal = entry.ordinal;
          if (entry.intent) intents.push([entry.intent.accountId, entry.intent.sourceId]);
          else missingOrdinals.push(entry.ordinal);
        }
        cursor = page[page.length - 1].ordinal;
        if (pages.length === 2 && afterSecondPage) await afterSecondPage();
      }
    } finally {
      await snapshot.close();
    }
    return { pages, intents, missingOrdinals, maxOrdinal };
  }

  async function snapshotTablePresent(ledger: SqliteLedger): Promise<boolean> {
    const row = await ledger.get<{ name: string }>(`SELECT name FROM temp.sqlite_master WHERE name=?`, [
      PENDING_SOURCE_DELETE_SNAPSHOT_TABLE,
    ]);
    return row !== undefined;
  }

  it("pages every captured identity exactly once while concurrent churn cannot extend or pin it", async () => {
    const { ledger, store } = await fixture();
    const base = Date.parse(REPAIR_CLOCK);
    const captured: string[] = [];
    for (let index = 0; index < 250; index += 1) {
      const sourceId = `src-${String(index).padStart(3, "0")}`;
      captured.push(sourceId);
      await seedRepairIntent(ledger, index % 2 === 0 ? "acct-a" : "acct-b", sourceId, {
        createdAt: new Date(base + index * 1_000).toISOString(),
      });
    }
    const deletedCaptured = "src-249";
    const insertedLate = "src-late";

    const snapshot = await store.capturePendingSourceDeleteSnapshot();
    expect(await snapshotTablePresent(ledger)).toBe(true);

    const pass = await drainSnapshot(snapshot, async () => {
      // A concurrent cleanup clears one captured future row, and a new
      // durable insert appears after the snapshot was frozen.
      await ledger.run("DELETE FROM pending_source_deletes WHERE source_id=?", [deletedCaptured]);
      await seedRepairIntent(ledger, "acct-b", insertedLate, {
        createdAt: new Date(base + 9_999_000).toISOString(),
      });
    });

    expect(pass.pages).toEqual([100, 100, 50, 0]);
    expect(pass.maxOrdinal).toBe(250);
    // Every surviving captured intent is returned once; the deleted captured
    // row still advances the cursor (its ordinal is present with no intent).
    expect(pass.intents).toHaveLength(249);
    expect(pass.missingOrdinals).toEqual([250]);
    expect(pass.intents.map(([, sourceId]) => sourceId)).toEqual(
      captured.filter((sourceId) => sourceId !== deletedCaptured)
    );
    // The late insert is outside the frozen snapshot and waits for periodic repair.
    expect(pass.intents.some(([, sourceId]) => sourceId === insertedLate)).toBe(false);
    await expect(
      ledger.get(`SELECT source_id FROM pending_source_deletes WHERE source_id=?`, [insertedLate])
    ).resolves.toMatchObject({ source_id: insertedLate });
    expect(await snapshotTablePresent(ledger)).toBe(false);
  });

  it("drops the TEMP snapshot when a pass throws mid-page and leaves durable rows intact", async () => {
    const { ledger, store } = await fixture();
    for (let index = 0; index < 120; index += 1) {
      await seedRepairIntent(ledger, "acct-a", `abort-${String(index).padStart(3, "0")}`);
    }
    const snapshot = await store.capturePendingSourceDeleteSnapshot();
    const before = await ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM pending_source_deletes");

    let failure: unknown;
    try {
      await snapshot.read(0, 100);
      throw new Error("injected cleanup failure");
    } catch (error) {
      failure = error;
    } finally {
      await snapshot.close();
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("injected cleanup failure");
    expect(await snapshotTablePresent(ledger)).toBe(false);
    const after = await ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM pending_source_deletes");
    expect(after).toEqual(before);
    // The durable intents remain retryable by the next capture/periodic page.
    await expect(store.listPendingSourceDeletesAcrossAccounts(10)).resolves.toHaveLength(10);
  });

  it("admits only one active snapshot, fails closed on a second capture, and rejects reads after close", async () => {
    const { ledger, store } = await fixture();
    for (let index = 0; index < 15; index += 1) {
      await seedRepairIntent(ledger, "acct-a", `solo-${String(index).padStart(2, "0")}`);
    }

    const first = await store.capturePendingSourceDeleteSnapshot();
    await expect(store.capturePendingSourceDeleteSnapshot()).rejects.toMatchObject({
      code: "SOURCE_STORE_INVALID_ARGUMENT",
    });
    // The failed second capture dropped/changed nothing.
    await expect(first.read(0, 10)).resolves.toHaveLength(10);
    await first.close();
    await first.close(); // idempotent
    await expect(first.read(0, 10)).rejects.toMatchObject({ code: "SOURCE_STORE_INVALID_ARGUMENT" });

    // A stale fixed-name table left with no active token is dropped by the
    // next capture before repopulating.
    await ledger.run(`CREATE TEMP TABLE ${PENDING_SOURCE_DELETE_SNAPSHOT_TABLE} (junk TEXT)`);
    expect(await snapshotTablePresent(ledger)).toBe(true);
    const second = await store.capturePendingSourceDeleteSnapshot();
    await expect(second.read(0, 100)).resolves.toHaveLength(15);
    await second.close();
    expect(await snapshotTablePresent(ledger)).toBe(false);

    await expect(second.read(0, 0)).rejects.toMatchObject({ code: "SOURCE_STORE_INVALID_ARGUMENT" });
  });
});

async function seedRepairIntent(
  ledger: SqliteLedger,
  accountId: string,
  sourceId: string,
  options: { attempts?: number; createdAt?: string; updatedAt?: string; name?: string } = {}
): Promise<void> {
  await ledger.run(
    `INSERT INTO pending_source_deletes
       (source_id,account_id,name,file_path,dataset_locations,attempts,created_at,updated_at)
     VALUES (?,?,?,NULL,'[]',?,?,?)`,
    [
      sourceId,
      accountId,
      options.name ?? `t_${sourceId}`,
      options.attempts ?? 0,
      options.createdAt ?? REPAIR_CLOCK,
      options.updatedAt ?? REPAIR_CLOCK,
    ]
  );
}

async function fixture(): Promise<Fixture> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const owner = randomUUID();
  const foreign = randomUUID();
  await resource.ledger.run(`INSERT INTO users (id,email,password_hash) VALUES (?,?,?)`, [
    owner,
    `${owner}@example.test`,
    "hash",
  ]);
  await resource.ledger.run(`INSERT INTO users (id,email,password_hash) VALUES (?,?,?)`, [
    foreign,
    `${foreign}@example.test`,
    "hash",
  ]);
  return {
    resource,
    ledger: resource.ledger,
    store: createSourceStore(resource.ledger),
    owner,
    foreign,
  };
}

function sourceInput(name: string, overrides: Partial<CreateSourceInput> = {}): CreateSourceInput {
  return {
    id: randomUUID(),
    name,
    kind: "tabular",
    displayName: `${name}.csv`,
    mime: "text/csv",
    meta: {},
    ...overrides,
  };
}

function connectorInput(
  targetTable: string,
  syncStatus: CreateConnectorInput["syncStatus"],
  sourceOverrides: Partial<CreateConnectorInput["source"]> = {}
): CreateConnectorInput {
  return {
    id: randomUUID(),
    name: `${targetTable} feed`,
    type: "url_csv",
    config: { url: `https://example.test/${targetTable}.csv` },
    targetTable,
    syncStatus,
    source: {
      id: randomUUID(),
      displayName: `${targetTable}.csv`,
      url: `https://example.test/${targetTable}.csv`,
      mime: "text/csv",
      status: "index",
      meta: {},
      ...sourceOverrides,
    },
  };
}

async function selectedChat(ledger: SqliteLedger, accountId: string, sourceId: string): Promise<string> {
  const chatId = randomUUID();
  await ledger.run(`INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,?, 'selected')`, [
    chatId,
    accountId,
    "Selected source chat",
    "qwen-chat",
  ]);
  await ledger.run(`INSERT INTO chat_sources (chat_id,source_id,account_id) VALUES (?,?,?)`, [
    chatId,
    sourceId,
    accountId,
  ]);
  return chatId;
}

async function runSnapshot(
  ledger: SqliteLedger,
  accountId: string,
  chatId: string,
  sourceId: string,
  status: "running" | "cancelling" | "completed"
): Promise<string> {
  const runId = randomUUID();
  await ledger.run(`INSERT INTO chat_runs (id,account_id,chat_id,status) VALUES (?,?,?,?)`, [
    runId,
    accountId,
    chatId,
    status,
  ]);
  await ledger.run(`INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)`, [
    runId,
    sourceId,
    accountId,
  ]);
  return runId;
}
