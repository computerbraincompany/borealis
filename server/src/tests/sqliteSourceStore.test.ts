import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { encodeJson } from "../db/codecs.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  createSourceStore,
  type CreateConnectorInput,
  type CreateSourceInput,
  type SourceStore,
} from "../db/stores/sourceStore.js";
import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

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
    await expect(store.listSources(owner)).resolves.toEqual([created]);
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
    await expect(store.listSources(owner, 0)).rejects.toMatchObject({ code: "SOURCE_STORE_INVALID_ARGUMENT" });

    const foreignSource = await store.createSource(foreign, {
      id: randomUUID(),
      name: "monthly_budget",
      kind: "tabular",
      displayName: "Same name in another account.csv",
    });
    expect(foreignSource.accountId).toBe(foreign);
    await expect(store.listSources(owner)).resolves.toHaveLength(1);
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
    await expect(store.listConnectors(owner)).resolves.toEqual([created.connector]);
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
      meta: {
        connector_previous_location: "/cache/previous.csv",
        connector_candidate_location: "/cache/candidate.csv",
        connector_activation_previous_location: "/cache/activation.csv",
      },
    });
    await store.createConnector(owner, connector);
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
      "/cache/previous.csv",
      "/cache/candidate.csv",
      "/cache/activation.csv",
    ]);
    await expect(store.getSource(owner, connector.source.id)).resolves.toBeUndefined();
    await expect(store.getConnector(owner, connector.id)).resolves.toBeUndefined();
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
      meta: { connector_candidate_location: "/cache/retry-candidate.csv" },
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
        encodeJson({ connector_previous_location: "/cache/connector-delete-aux-old.csv" }),
      ]
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
    await expect(store.listSources(owner)).resolves.toEqual([]);
    await expect(store.deleteConnector(owner, input.id)).resolves.toMatchObject({
      connectorId: input.id,
      alreadyPending: true,
      intents: expect.arrayContaining([...deleted.intents]),
    });
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
