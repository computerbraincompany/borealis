import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgePreviewStaleError, KnowledgeStore, type KnowledgeScanBounds } from "../db/stores/knowledgeStore.js";
import type { SqliteLedger } from "../db/types.js";
import { encodeJson } from "../db/codecs.js";
import {
  FileConnectionSecretStore,
  FileKeyCustody,
  type ConnectionSecretRead,
  type ConnectionSecretStore,
} from "../connections/secrets.js";
import {
  DeterministicKnowledgeAdapter,
  makeIngestionSimulator,
  promoteGeneration,
} from "./knowledgeTransportFixture.js";
import {
  KnowledgeRefreshService,
  KnowledgeScanFailureError,
  KnowledgeTransportUnavailableError,
  classifyKnowledgeScan,
  type KnowledgeTransportAdapter,
} from "../knowledgeRefresh.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: { ledger: TempSqliteLedger; staging: string }[] = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => {
      await resource.ledger.cleanup();
      await fs.rm(resource.staging, { recursive: true, force: true });
    })
  );
});

const hash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

const absentSecrets: ConnectionSecretStore = {
  read: async (): Promise<ConnectionSecretRead> => ({ state: "absent" }),
  put: async () => undefined,
  remove: async () => undefined,
};

const bounds: KnowledgeScanBounds = {
  maxEntries: 100,
  maxDepth: 8,
  maxVisited: 500,
  maxAggregateBytes: 10 * 1024 * 1024,
};

async function insertUser(ledger: SqliteLedger, id = randomUUID()): Promise<string> {
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, `${id}@example.test`, "hash"]);
  return id;
}

async function insertLibrary(ledger: SqliteLedger, account: string, name: string): Promise<string> {
  const id = randomUUID();
  await ledger.run("INSERT INTO libraries (id,account_id,name) VALUES (?,?,?)", [id, account, name]);
  return id;
}

async function insertReadySource(
  ledger: SqliteLedger,
  account: string,
  options: { name: string; id?: string; readyGeneration?: number } = { name: "outside" }
): Promise<string> {
  const id = options.id ?? randomUUID();
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta,ready_generation)
     VALUES (?,?,?,'document',?,?,?,?,?,?,?)`,
    [
      id,
      account,
      options.name,
      options.name,
      `/uploads/${account}/${id}/file.bin`,
      "text/markdown",
      5,
      "ready",
      encodeJson({}),
      options.readyGeneration ?? 1,
    ]
  );
  return id;
}

async function harness(
  options: {
    kind?: "desktop_folder" | "webdav";
    autoPromote?: boolean;
    secrets?: ConnectionSecretStore;
    registerAdapter?: boolean;
  } = {}
) {
  const ledgerResource = await createTempSqliteLedger();
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-knowledge-stage-"));
  resources.push({ ledger: ledgerResource, staging });
  const ledger = ledgerResource.ledger;
  const account = await insertUser(ledger);
  const libraryId = await insertLibrary(ledger, account, `Library ${account.slice(0, 6)}`);
  const store = new KnowledgeStore(ledger);
  const kind = options.kind ?? "desktop_folder";
  const adapter = new DeterministicKnowledgeAdapter(kind, staging);
  const ingestion = { calls: 0, generations: [] as number[], autoPromote: options.autoPromote ?? true };
  const service = new KnowledgeRefreshService({
    store: () => store,
    adapter: (candidate) => (options.registerAdapter === false ? undefined : candidate === kind ? adapter : undefined),
    reingest: makeIngestionSimulator(ledger, ingestion),
    secrets: () => options.secrets ?? absentSecrets,
    pollIntervalMs: 10,
  });
  const connection = await store.createConnection(account, {
    name: "Primary",
    kind,
    config:
      kind === "webdav"
        ? { url: "https://dav.example.test/collections/team", username: "ada" }
        : { root_path: "/Users/ada/notes", display_label: "Notes" },
    library_id: libraryId,
  });
  return { ledger, store, service, adapter, account, libraryId, connection, ingestion };
}

async function importAll(h: Awaited<ReturnType<typeof harness>>): Promise<{
  itemIds: string[];
  sourceIds: string[];
}> {
  const preview = await h.service.createPreview(h.account, h.connection.id, bounds);
  const applied = await h.service.applyPreview(h.account, preview.preview.id, {
    expected_revision: preview.preview.revision,
    selections: preview.entries
      .filter((entry) => ["new", "changed", "duplicate"].includes(entry.classification))
      .map((entry) => ({ entry_id: entry.entry_id, selection_token: entry.selection_token })),
  });
  return { itemIds: applied.items.map((item) => item.item_id), sourceIds: applied.items.map((item) => item.source_id) };
}

function refreshIdOf(result: Awaited<ReturnType<KnowledgeRefreshService["refreshAndWaitReady"]>>): string {
  const refreshId = result.refreshes[0]?.refresh_id;
  if (!refreshId) throw new Error("no durable refresh id in result");
  return refreshId;
}

function outcomeOf(result: Awaited<ReturnType<KnowledgeRefreshService["refreshAndWaitReady"]>>, pathName: string) {
  const item = result.refreshes[0]?.items.find((entry) => entry.relative_path === pathName);
  if (!item) throw new Error(`no outcome for ${pathName}`);
  return item;
}

describe("knowledge refresh service", () => {
  it("classifies scans by path identity, never by content", () => {
    const managed = [
      {
        id: "i1",
        connection_id: "c1",
        relative_path: "a.md",
        source_id: "s1",
        content_hash: hash("shared"),
        ingested_hash: hash("shared"),
        size_bytes: 6,
        lifecycle: "active" as const,
        stale: false,
        mtime_hint: null,
        etag_hint: null,
        last_refreshed_at: null,
        created_at: "2026-09-06T00:00:00.000Z",
        updated_at: "2026-09-06T00:00:00.000Z",
      },
    ];
    const classified = classifyKnowledgeScan(managed, {
      files: [
        { relative_path: "a.md", content_hash: hash("edited"), size_bytes: 7 },
        { relative_path: "b.md", content_hash: hash("shared"), size_bytes: 6 },
        { relative_path: "c.md", content_hash: hash("other"), size_bytes: 5 },
        { relative_path: "d.md", content_hash: hash("other"), size_bytes: 5 },
      ],
      unsupported: [{ relative_path: "raw.bin", size_bytes: 900 }],
      skipped: [{ relative_path: ".git/config", reason: "hidden" }],
      visited_entries: 6,
      directories: 2,
      aggregate_bytes: 920,
    });
    const byPath = new Map(classified.entries.map((entry) => [entry.relative_path, entry]));
    expect(byPath.get("a.md")?.classification).toBe("changed");
    // Same bytes as the managed item, different path: still `new`, never a
    // content-based identity match.
    expect(byPath.get("b.md")?.classification).toBe("new");
    expect(byPath.get("b.md")?.existing_source_id).toBeNull();
    // A repeat of another new path's hash is `duplicate`.
    expect(byPath.get("c.md")?.classification).toBe("new");
    expect(byPath.get("d.md")?.classification).toBe("duplicate");
    expect(byPath.get("raw.bin")?.classification).toBe("unsupported");
  });

  it("imports, refreshes, and promotes while leaving chat scope byte-identical", async () => {
    const h = await harness();
    const outside = await insertReadySource(h.ledger, h.account, { name: "outside" });
    const chatId = randomUUID();
    await h.ledger.run("INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,'m','selected')", [
      chatId,
      h.account,
      "Scoped",
    ]);
    await h.ledger.run("INSERT INTO chat_sources (chat_id,source_id,account_id) VALUES (?,?,?)", [
      chatId,
      outside,
      h.account,
    ]);
    const scopeBefore = JSON.stringify(
      await h.ledger.all("SELECT chat_id,source_id,account_id FROM chat_sources ORDER BY chat_id,source_id")
    );
    const scopeChatsBefore = JSON.stringify(
      await h.ledger.all("SELECT id,account_id,source_mode,model FROM chats ORDER BY id")
    );

    h.adapter.put("docs/a.md", "# Alpha");
    h.adapter.put("data/b.csv", "x,y");
    const imported = await importAll(h);
    expect(imported.itemIds).toHaveLength(2);

    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(result.fully_ready).toBe(true);
    expect(result.refreshes[0]?.status).toBe("completed");
    expect(result.promoted).toHaveLength(2);
    for (const pair of result.promoted) expect(pair.generation).toBe(1);
    expect(h.ingestion.calls).toBe(2);
    expect(outcomeOf(result, "docs/a.md").outcome).toBe("promoted");
    expect(outcomeOf(result, "data/b.csv").outcome).toBe("promoted");

    const members = await h.ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM library_sources WHERE library_id=?", [
      h.libraryId,
    ]);
    expect(members?.n).toBe(2n);
    // The refresh imported a new document; the chat's selected scope is
    // byte-identical — never widened, never narrowed.
    expect(
      JSON.stringify(
        await h.ledger.all("SELECT chat_id,source_id,account_id FROM chat_sources ORDER BY chat_id,source_id")
      )
    ).toBe(scopeBefore);
    expect(JSON.stringify(await h.ledger.all("SELECT id,account_id,source_mode,model FROM chats ORDER BY id"))).toBe(
      scopeChatsBefore
    );
    const connection = await h.store.requireConnection(h.account, h.connection.id);
    expect(connection.status).toBe("ready");
    expect(connection.credential_configured).toBe(false);
  });

  it("treats a rename as missing-plus-new, never identity-by-content", async () => {
    const h = await harness();
    h.adapter.put("a.md", "identical bytes");
    const imported = await importAll(h);
    await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    const oldSource = imported.sourceIds[0]!;

    h.adapter.rename("a.md", "moved/a.md");
    const preview = await h.service.createPreview(h.account, h.connection.id, bounds);
    const byPath = new Map(preview.entries.map((entry) => [entry.relative_path, entry]));
    expect(byPath.get("a.md")?.classification).toBe("missing");
    expect(byPath.get("moved/a.md")?.classification).toBe("new");
    expect(byPath.get("moved/a.md")?.existing_source_id).toBeNull();
    expect(byPath.get("moved/a.md")?.content_hash).toBe(hash("identical bytes"));

    const reimported = await importAll(h);
    const newSource = reimported.sourceIds[0]!;
    expect(newSource).not.toBe(oldSource);
    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(result.fully_ready).toBe(false);
    expect(outcomeOf(result, "moved/a.md").outcome).toBe("promoted");
    expect(outcomeOf(result, "a.md").outcome).toBe("missing");

    // The renamed-away path keeps its source and last ready content.
    const retained = await h.ledger.get<{ status: string; ready_generation: bigint }>(
      "SELECT status,ready_generation FROM sources WHERE id=?",
      [oldSource]
    );
    expect(retained).toEqual({ status: "ready", ready_generation: 1n });
    const items = await h.store.listItems(h.account, h.connection.id, { limit: 100, after: null });
    const missing = items.items.find((item) => item.relative_path === "a.md");
    expect(missing?.lifecycle).toBe("missing_upstream");
    expect(missing?.stale).toBe(true);
    expect(missing?.source_id).toBe(oldSource);
  });

  it("detects unchanged content by hash and reserves no re-ingestion", async () => {
    const h = await harness();
    h.adapter.put("stable.md", "frozen");
    await importAll(h);
    await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    h.ingestion.calls = 0;
    h.adapter.inspectCount = 0;

    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(result.fully_ready).toBe(true);
    expect(result.refreshes[0]?.status).toBe("completed");
    expect(outcomeOf(result, "stable.md").outcome).toBe("unchanged");
    expect(h.ingestion.calls).toBe(0);
    expect(h.ingestion.generations).toEqual([1]);
    expect(h.adapter.inspectCount).toBe(1);
    const source = await h.ledger.get<{ ready_generation: bigint }>("SELECT ready_generation FROM sources WHERE id=?", [
      await h.ledger
        .get<{ source_id: string }>("SELECT source_id FROM knowledge_items LIMIT 1")
        .then((row) => row!.source_id),
    ]);
    expect(source?.ready_generation).toBe(1n);
  });

  it("reuses the stable source id and bumps the generation for changed bytes", async () => {
    const h = await harness();
    h.adapter.put("live.md", "v1");
    const imported = await importAll(h);
    await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    h.adapter.put("live.md", "v2 content");
    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(outcomeOf(result, "live.md")).toMatchObject({
      outcome: "promoted",
      source_id: imported.sourceIds[0],
      generation: 2,
    });
    expect(result.promoted).toEqual([
      {
        connection_id: h.connection.id,
        item_id: imported.itemIds[0],
        source_id: imported.sourceIds[0],
        generation: 2,
      },
    ]);
    const sourceCount = await h.ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM sources WHERE account_id=?", [
      h.account,
    ]);
    expect(sourceCount?.n).toBe(1n);
    const item = await h.store.getItem(h.account, imported.itemIds[0]!);
    expect(item?.content_hash).toBe(hash("v2 content"));
    const members = await h.ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM library_sources WHERE library_id=?", [
      h.libraryId,
    ]);
    expect(members?.n).toBe(1n);
  });

  it("refuses a moving preview without committing anything", async () => {
    const h = await harness();
    h.adapter.put("base.md", "base");
    await importAll(h);
    await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });

    h.adapter.put("late.md", "first scan bytes");
    const preview = await h.service.createPreview(h.account, h.connection.id, bounds);
    const selection = preview.entries.filter((entry) => entry.classification === "new");
    expect(selection).toHaveLength(1);
    // The upstream file moves before the commit: the staged hash no longer
    // matches the scan, so the whole commit refuses.
    h.adapter.put("late.md", "bytes moved after the scan");
    await expect(
      h.service.applyPreview(h.account, preview.preview.id, {
        expected_revision: preview.preview.revision,
        selections: selection.map((entry) => ({ entry_id: entry.entry_id, selection_token: entry.selection_token })),
      })
    ).rejects.toBeInstanceOf(KnowledgePreviewStaleError);
    // A stale revision is also refused even with matching bytes.
    h.adapter.put("late.md", "first scan bytes");
    await expect(
      h.service.applyPreview(h.account, preview.preview.id, {
        expected_revision: preview.preview.revision + 5,
        selections: selection.map((entry) => ({ entry_id: entry.entry_id, selection_token: entry.selection_token })),
      })
    ).rejects.toBeInstanceOf(KnowledgePreviewStaleError);
    // No *active* refresh was registered by the refused commits (earlier
    // finished history rows are expected to remain).
    expect(await h.store.getActiveRefresh(h.account, h.connection.id)).toBeUndefined();
    await expect(h.store.getPreview(h.account, preview.preview.id)).resolves.toMatchObject({ status: "complete" });
  });

  it("survives restart: recovery retries only incomplete items and adopts the reserved generation", async () => {
    const h = await harness({ autoPromote: false });
    h.adapter.put("durable.md", "content");
    const imported = await importAll(h);

    // The first attempt's deadline cuts it short while the reserved
    // generation is still queued; the durable refresh must stay active.
    const timedOut = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
      deadlineMs: 80,
    });
    expect(timedOut.refreshes[0]?.status).toBe("failed");
    expect(timedOut.refreshes[0]?.error_code).toBe("KNOWLEDGE_REFRESH_TIMEOUT");
    expect(timedOut.fully_ready).toBe(false);
    expect(h.ingestion.calls).toBe(1);
    expect(h.ingestion.generations).toEqual([1]);
    const durableRefreshId = refreshIdOf(timedOut);
    const durableRefresh = await h.store.requireRefresh(h.account, durableRefreshId);
    expect(durableRefresh.status).toBe("active");
    const durableItem = await h.store.getRefreshItem(h.account, durableRefreshId, imported.itemIds[0]!);
    expect(durableItem?.status).toBe("committed");
    expect(durableItem?.expected_generation).toBe(1);

    // Simulated restart: a fresh service over the same ledger recovers.
    const recoveredStore = new KnowledgeStore(h.ledger);
    const lateIngestion = { calls: 0, generations: [] as number[], autoPromote: false };
    const recoveryAdapter = new DeterministicKnowledgeAdapter("desktop_folder", h.adapter.stagingDir);
    // Recovery must not re-read upstream for committed work and must not
    // reserve a second generation.
    recoveryAdapter.put("durable.md", "content");
    const recovery = new KnowledgeRefreshService({
      store: () => recoveredStore,
      adapter: (kind) => (kind === "desktop_folder" ? recoveryAdapter : undefined),
      reingest: makeIngestionSimulator(h.ledger, lateIngestion),
      secrets: () => absentSecrets,
      pollIntervalMs: 10,
    });
    const firstPass = await recovery.recoverInterrupted(h.account, { deadlineMs: 60 });
    expect(lateIngestion.calls).toBe(0);
    expect(recoveryAdapter.inspectCount).toBe(0);
    expect(firstPass.refreshes[0]?.items[0]?.outcome).toBe("pending");
    const job = await h.ledger.get<{ generation: bigint; status: string }>(
      "SELECT generation,status FROM ingestion_jobs WHERE source_id=?",
      [imported.sourceIds[0]!]
    );
    expect(job).toEqual({ generation: 1n, status: "pending" });

    // The durable worker promotes the single reserved generation; recovery
    // finishes with the exact promoted pair.
    await promoteGeneration(h.ledger, imported.sourceIds[0]!, 1);
    const secondPass = await recovery.recoverInterrupted(h.account);
    expect(secondPass.promoted).toEqual([
      {
        connection_id: h.connection.id,
        item_id: imported.itemIds[0],
        source_id: imported.sourceIds[0],
        generation: 1,
      },
    ]);
    expect(lateIngestion.calls).toBe(0);
    expect(await recoveredStore.listInterruptedRefreshes(h.account)).toEqual([]);
    const finished = await recoveredStore.requireRefresh(h.account, durableRefreshId);
    expect(finished.status).toBe("completed");
  });

  it("never turns partial success into a fully ready snapshot", async () => {
    const h = await harness();
    h.adapter.put("keep.md", "one");
    h.adapter.put("drop.md", "two");
    await importAll(h);
    await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    h.adapter.remove("drop.md");
    h.adapter.put("keep.md", "one edited");
    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(result.fully_ready).toBe(false);
    expect(result.refreshes[0]?.status).toBe("partial");
    expect(result.promoted).toHaveLength(1);
    expect(outcomeOf(result, "keep.md").outcome).toBe("promoted");
    expect(outcomeOf(result, "drop.md").outcome).toBe("missing");
    const dropSource = await h.ledger.get<{ status: string; ready_generation: bigint }>(
      "SELECT s.status,s.ready_generation FROM sources s JOIN knowledge_items i ON i.source_id=s.id WHERE i.relative_path='drop.md' AND s.account_id=?",
      [h.account]
    );
    expect(dropSource).toEqual({ status: "ready", ready_generation: 1n });
  });

  it("reports authorization failures as disconnected without touching ready content", async () => {
    const h = await harness();
    h.adapter.put("secure.md", "data");
    const imported = await importAll(h);
    await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    h.adapter.unauthorized = true;
    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(result.fully_ready).toBe(false);
    expect(outcomeOf(result, "secure.md")).toMatchObject({
      outcome: "failed",
      error_code: "KNOWLEDGE_UPSTREAM_UNAUTHORIZED",
    });
    const connection = await h.store.requireConnection(h.account, h.connection.id);
    expect(connection.status).toBe("disconnected");
    expect(connection.status_code).toBe("KNOWLEDGE_UPSTREAM_UNAUTHORIZED");
    const item = await h.store.getItem(h.account, imported.itemIds[0]!);
    expect(item?.content_hash).toBe(hash("data"));
    expect(item?.lifecycle).toBe("active");
  });

  it("refreshes only the exact managed-item allowlist", async () => {
    const h = await harness();
    h.adapter.put("a.md", "a1");
    h.adapter.put("b.md", "b1");
    const imported = await importAll(h);
    await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    h.adapter.put("a.md", "a2");
    h.adapter.put("b.md", "b2");
    h.adapter.inspectCount = 0;
    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [
        {
          connection_id: h.connection.id,
          expected_connection_revision: h.connection.revision,
          item_ids: [imported.itemIds[0]!],
        },
      ],
    });
    expect(result.refreshes[0]?.items).toHaveLength(1);
    expect(outcomeOf(result, "a.md").outcome).toBe("promoted");
    expect(h.adapter.inspectCount).toBe(1);
    const bItem = await h.store.getItem(h.account, imported.itemIds[1]!);
    expect(bItem?.content_hash).toBe(hash("b1"));
  });

  it("rejects stale connection revisions instead of refreshing", async () => {
    const h = await harness();
    await h.store.updateConnection(h.account, h.connection.id, {
      name: "Renamed",
      expected_revision: h.connection.revision,
    });
    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(result.fully_ready).toBe(false);
    expect(result.refreshes[0]?.status).toBe("rejected");
    expect(result.refreshes[0]?.error_code).toBe("KNOWLEDGE_CONNECTION_REVISION_CONFLICT");
  });

  it("keeps durable committed work across cancellation and dedupes the reservation on the next run", async () => {
    const h = await harness({ autoPromote: false });
    h.adapter.put("job.md", "bytes");
    const imported = await importAll(h);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("caller cancel")), 40);
    const cancelled = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
      signal: controller.signal,
      deadlineMs: 5_000,
    });
    expect(cancelled.refreshes[0]?.status).toBe("cancelled");
    const durableItem = await h.store.getRefreshItem(h.account, refreshIdOf(cancelled), imported.itemIds[0]!);
    expect(durableItem?.status).toBe("committed");
    expect(h.ingestion.calls).toBe(1);

    // A follow-up run adopts the still-queued generation rather than
    // reserving a second one; recovery then finishes the promoted pair.
    const followUp = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
      deadlineMs: 60,
    });
    expect(followUp.refreshes[0]?.items[0]?.outcome).toBe("pending");
    expect(h.ingestion.calls).toBe(1);
    await promoteGeneration(h.ledger, imported.sourceIds[0]!, 1);
    const recovered = await h.service.recoverInterrupted(h.account);
    expect(recovered.promoted).toEqual([
      {
        connection_id: h.connection.id,
        item_id: imported.itemIds[0],
        source_id: imported.sourceIds[0],
        generation: 1,
      },
    ]);
    expect(h.ingestion.calls).toBe(1);
  });

  it("fails closed when no transport is registered for the connection kind", async () => {
    const h = await harness({ registerAdapter: false });
    await expect(h.service.createPreview(h.account, h.connection.id, bounds)).rejects.toBeInstanceOf(
      KnowledgeTransportUnavailableError
    );
    const result = await h.service.refreshAndWaitReady({
      accountId: h.account,
      connections: [{ connection_id: h.connection.id, expected_connection_revision: h.connection.revision }],
    });
    expect(result.fully_ready).toBe(false);
    expect(result.refreshes[0]?.error_code).toBe("KNOWLEDGE_TRANSPORT_UNAVAILABLE");
  });

  it("webdav reads credentials exclusively through the shared connection secret store", async () => {
    const h = await harness({ kind: "webdav" });
    await expect(h.service.createPreview(h.account, h.connection.id, bounds)).rejects.toBeInstanceOf(
      KnowledgeScanFailureError
    );
    await expect(h.service.createPreview(h.account, h.connection.id, bounds)).rejects.toMatchObject({
      code: "KNOWLEDGE_CREDENTIALS_MISSING",
    });
    let connection = await h.store.requireConnection(h.account, h.connection.id);
    expect(connection.status).toBe("disconnected");
    expect(connection.credential_configured).toBe(false);

    // The shared v17 custody writes the record; a scan then succeeds and the
    // adapter receives the material in its transport context only.
    const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-knowledge-secrets-"));
    try {
      const shared = new FileConnectionSecretStore({
        directory: path.join(secretsDir, "secrets"),
        custody: new FileKeyCustody(path.join(secretsDir, "connections.key")),
      });
      await shared.put(h.account, h.connection.id, {
        headers: { authorization: "Bearer application-password" },
        env: {},
      });
      const serviceWithCustody = new KnowledgeRefreshService({
        store: () => h.store,
        adapter: (kind: KnowledgeTransportAdapter["kind"]) => (kind === "webdav" ? h.adapter : undefined),
        reingest: makeIngestionSimulator(h.ledger, h.ingestion),
        secrets: () => shared,
        pollIntervalMs: 10,
      });
      h.adapter.put("remote.md", "from webdav");
      const preview = await serviceWithCustody.createPreview(h.account, h.connection.id, bounds);
      expect(preview.entries[0]?.classification).toBe("new");
      expect(h.adapter.lastSecrets?.headers.authorization).toBe("Bearer application-password");
      connection = await h.store.requireConnection(h.account, h.connection.id);
      expect(connection.status).toBe("ready");
    } finally {
      await fs.rm(secretsDir, { recursive: true, force: true });
    }
  });
});
