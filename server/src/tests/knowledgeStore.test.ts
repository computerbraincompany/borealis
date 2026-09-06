import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SQLITE_SCHEMA_VERSION, SCHEMA_V19 } from "../db/migrations.js";
import {
  DuplicateKnowledgeConnectionError,
  KnowledgeConnectionConfigError,
  KnowledgeConnectionNotFoundError,
  KnowledgeConnectionRevisionConflictError,
  KnowledgeItemNotFoundError,
  KnowledgeLibraryUnavailableError,
  KnowledgePreviewExpiredError,
  KnowledgePreviewNotFoundError,
  KnowledgePreviewSelectionError,
  KnowledgePreviewStaleError,
  KnowledgeQuotaError,
  KnowledgeRefreshConflictError,
  KnowledgeRefreshNotFoundError,
  KnowledgeStore,
  MAX_MANAGED_ITEMS_PER_CONNECTION,
  MAX_REFRESH_HISTORY_PER_CONNECTION,
  decodeKnowledgeConnectionConfig,
  knowledgeSelectionToken,
  normalizeKnowledgeRelativePath,
  type KnowledgeScanBounds,
  type KnowledgeStoreOptions,
  type PreviewScanEntryInput,
  type StagedKnowledgeEntry,
} from "../db/stores/knowledgeStore.js";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import { encodeJson } from "../db/codecs.js";
import {
  createHistoricalSqliteFixture,
  expectedFixtureVersions,
  listHistoricalFixtureVersions,
} from "./sqliteMigrationFixture.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];

async function ledgerResource(): Promise<TempSqliteLedger> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  return resource;
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

const hash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

const webdavConfig = {
  url: "https://dav.example.test/collections/team",
  username: "ada",
};
const folderConfig = { root_path: "/Users/ada/notes", display_label: "Notes" };
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

async function insertSource(
  ledger: SqliteLedger,
  account: string,
  options: {
    id?: string;
    name?: string;
    status?: "ready" | "index" | "error";
    readyGeneration?: number | null;
    filePath?: string | null;
  } = {}
): Promise<string> {
  const id = options.id ?? randomUUID();
  const name = options.name ?? `source-${id.slice(0, 8)}`;
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta,ready_generation)
     VALUES (?,?,?,'document',?,?,?,?,?,?,?)`,
    [
      id,
      account,
      name,
      name,
      options.filePath ?? `/uploads/${account}/${id}/file.bin`,
      "text/markdown",
      10,
      options.status ?? "ready",
      encodeJson({}),
      options.readyGeneration === undefined ? 1 : options.readyGeneration,
    ]
  );
  return id;
}

async function insertItem(
  ledger: SqliteLedger,
  account: string,
  connectionId: string,
  relativePath: string,
  sourceId: string,
  contentHash: string
): Promise<string> {
  const id = randomUUID();
  await ledger.run(
    `INSERT INTO knowledge_items (id,account_id,connection_id,relative_path,source_id,content_hash)
     VALUES (?,?,?,?,?,?)`,
    [id, account, connectionId, relativePath, sourceId, contentHash]
  );
  return id;
}

function staged(
  relativePath: string,
  content: string,
  kind: "document" | "tabular" = "document"
): StagedKnowledgeEntry {
  return Object.freeze({
    file_path: `/uploads/staged/${relativePath}-${hash(content).slice(0, 8)}`,
    content_hash: hash(content),
    size_bytes: Buffer.byteLength(content, "utf8"),
    mime: kind === "tabular" ? "text/csv" : "text/markdown",
    kind,
  });
}

async function seed(
  now: KnowledgeStoreOptions = {},
  kind: "webdav" | "desktop_folder" = "webdav"
): Promise<{
  ledger: SqliteLedger;
  store: KnowledgeStore;
  account: string;
  foreign: string;
  libraryId: string;
  connectionId: string;
  revision: number;
}> {
  const { ledger } = await ledgerResource();
  const account = await insertUser(ledger);
  const foreign = await insertUser(ledger);
  const libraryId = await insertLibrary(ledger, account, `Library ${account.slice(0, 6)}`);
  const store = new KnowledgeStore(ledger, now);
  const connection = await store.createConnection(account, {
    name: "Primary",
    kind,
    config: kind === "webdav" ? webdavConfig : folderConfig,
    library_id: libraryId,
  });
  return { ledger, store, account, foreign, libraryId, connectionId: connection.id, revision: connection.revision };
}

function scanEntries(entries: readonly PreviewScanEntryInput[]) {
  return { visited_entries: entries.length, directories: 2, aggregate_bytes: 1_000, entries };
}

describe("knowledge store", () => {
  it("ships a byte-identical v019 fixture that upgrades a seeded v18 installation", async () => {
    expect(LATEST_SQLITE_SCHEMA_VERSION).toBe(22); // merged later slots: v20 documents, v21 MCP run snapshot, v22 templates
    await expect(listHistoricalFixtureVersions()).resolves.toEqual(expectedFixtureVersions());
    const fixtureSql = await fs.readFile(fileURLToPath(new URL("./fixtures/sqlite/v019.sql", import.meta.url)), "utf8");
    expect(fixtureSql).toBe(SCHEMA_V19);

    const historical = await createHistoricalSqliteFixture(18);
    try {
      const ledger = await openSqliteLedger({ path: historical.filename });
      try {
        await expect(ledger.get<{ user_version: bigint }>("PRAGMA user_version")).resolves.toEqual({
          user_version: BigInt(LATEST_SQLITE_SCHEMA_VERSION),
        });
        await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
        const store = new KnowledgeStore(ledger);
        const libraryId = randomUUID();
        await ledger.run("INSERT INTO libraries (id,account_id,name) VALUES (?,?,?)", [
          libraryId,
          historical.seed.accountId,
          "Upgraded library",
        ]);
        const connection = await store.createConnection(historical.seed.accountId, {
          name: "Upgraded folder",
          kind: "desktop_folder",
          config: folderConfig,
          library_id: libraryId,
        });
        expect(connection.revision).toBe(1);
        expect(await store.countManagedItems(historical.seed.accountId, connection.id)).toBe(0);
      } finally {
        await ledger.close();
      }
    } finally {
      await historical.cleanup();
    }
  });

  it("normalizes relative-path identity and refuses unsafe forms", () => {
    expect(normalizeKnowledgeRelativePath("docs/a.md")).toBe("docs/a.md");
    expect(normalizeKnowledgeRelativePath("notes/2026/week 3.txt")).toBe("notes/2026/week 3.txt");
    for (const bad of [
      "",
      " ",
      " /a",
      "/a",
      "a/",
      "a//b",
      "..",
      "../a",
      "a/../b",
      "a/..",
      "./a",
      "a/./b",
      ".hidden",
      "a/.git/config",
      "C:\\Users\\a.md",
      "a\\b.md",
      "a\0b",
      `a\nb`,
      " padded ",
      `x/${"y".repeat(1024)}`,
    ]) {
      expect(normalizeKnowledgeRelativePath(bad), bad).toBeNull();
    }
  });

  it("validates kind-specific configuration and re-decodes the canonical shape", () => {
    expect(decodeKnowledgeConnectionConfig("webdav", JSON.stringify(webdavConfig))).toEqual({
      kind: "webdav",
      ...webdavConfig,
    });
    expect(decodeKnowledgeConnectionConfig("desktop_folder", JSON.stringify(folderConfig))).toEqual({
      kind: "desktop_folder",
      ...folderConfig,
    });
    // Loopback/.local may use plain HTTP; public hosts must be HTTPS.
    expect(() =>
      decodeKnowledgeConnectionConfig("webdav", JSON.stringify({ url: "http://127.0.0.1:8008/d", username: "u" }))
    ).not.toThrow();
    expect(() =>
      decodeKnowledgeConnectionConfig("webdav", JSON.stringify({ url: "http://nas.local/d", username: "u" }))
    ).not.toThrow();
    for (const bad of [
      { url: "http://dav.example.test/coll", username: "u" },
      { url: "https://dav.example.test/coll?x=1", username: "u" },
      { url: "https://dav.example.test/coll#frag", username: "u" },
      { url: "https://u:p@dav.example.test/coll", username: "u" },
      { url: "https://dav.example.test/coll", username: "" },
      { url: "https://dav.example.test/coll" },
      { root_path: "notes", display_label: "N" },
      { root_path: "/Users/ada/notes", display_label: "" },
      { root_path: "/Users/ada/notes\n", display_label: "N" },
    ]) {
      const kind = "url" in bad ? "webdav" : "desktop_folder";
      expect(() => decodeKnowledgeConnectionConfig(kind, JSON.stringify(bad)), JSON.stringify(bad)).toThrow(
        KnowledgeConnectionConfigError
      );
    }
    // A stored row that did not round-trip through the canonical shape fails closed.
    expect(() => decodeKnowledgeConnectionConfig("webdav", JSON.stringify({ ...webdavConfig, extra: true }))).toThrow(
      KnowledgeConnectionConfigError
    );
  });

  it("enforces the v19 DDL invariants directly through SQL", async () => {
    const { ledger } = await ledgerResource();
    const account = await insertUser(ledger);
    const foreign = await insertUser(ledger);
    const libraryId = await insertLibrary(ledger, account, "DDL library");
    const foreignLibrary = await insertLibrary(ledger, foreign, "Foreign library");
    const sourceId = await insertSource(ledger, account);
    const foreignSource = await insertSource(ledger, foreign);
    const store = new KnowledgeStore(ledger);
    const connection = await store.createConnection(account, {
      name: "DDL",
      kind: "desktop_folder",
      config: folderConfig,
      library_id: libraryId,
    });
    const foreignConnection = await store.createConnection(foreign, {
      name: "DDL",
      kind: "webdav",
      config: webdavConfig,
      library_id: foreignLibrary,
    });

    await expect(
      ledger.run(
        "INSERT INTO knowledge_connections (id,account_id,kind,name,config,credential_configured) VALUES (?,?,?,?,?,1)",
        [randomUUID(), account, "desktop_folder", "Credited", "{}"]
      )
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      ledger.run("INSERT INTO knowledge_connections (id,account_id,kind,name,config) VALUES (?,?,?,?,?)", [
        randomUUID(),
        account,
        "ftp",
        "Wrong kind",
        "{}",
      ])
    ).rejects.toMatchObject({ kind: "check" });
    // Like v6 chats.agent_id, library_id/source bindings are single-column
    // SET NULL FKs: existence is enforced in the ledger, account tenancy of
    // the bound row is enforced by the store on every write path.
    await expect(
      ledger.run("INSERT INTO knowledge_connections (id,account_id,library_id,kind,name,config) VALUES (?,?,?,?,?,?)", [
        randomUUID(),
        account,
        randomUUID(),
        "webdav",
        "Missing library",
        "{}",
      ])
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      store.createConnection(account, {
        name: "Cross lib",
        kind: "webdav",
        config: webdavConfig,
        library_id: foreignLibrary,
      })
    ).rejects.toBeInstanceOf(KnowledgeLibraryUnavailableError);

    const badPaths = ["../a", "a/", "/a", "a/../b", "a//b"];
    for (const badPath of badPaths) {
      await expect(
        ledger.run(
          "INSERT INTO knowledge_items (id,account_id,connection_id,relative_path,source_id,content_hash) VALUES (?,?,?,?,?,?)",
          [randomUUID(), account, connection.id, badPath, sourceId, hash(badPath)]
        )
      ).rejects.toMatchObject({ kind: "check" });
    }
    await expect(
      ledger.run(
        "INSERT INTO knowledge_items (id,account_id,connection_id,relative_path,source_id,content_hash) VALUES (?,?,?,?,?,?)",
        [randomUUID(), account, connection.id, "ok.md", sourceId, "A".repeat(64)]
      )
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      ledger.run(
        "INSERT INTO knowledge_items (id,account_id,connection_id,relative_path,source_id,content_hash) VALUES (?,?,?,?,?,?)",
        [randomUUID(), account, foreignConnection.id, "cross.md", sourceId, hash("x")]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      ledger.run(
        "INSERT INTO knowledge_items (id,account_id,connection_id,relative_path,source_id,content_hash) VALUES (?,?,?,?,?,?)",
        [randomUUID(), account, connection.id, "steal.md", foreignSource, hash("x")]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    const itemId = await insertItem(ledger, account, connection.id, "ok.md", sourceId, hash("ok"));
    await expect(ledger.run("UPDATE knowledge_items SET stale=1 WHERE id=?", [itemId])).rejects.toMatchObject({
      kind: "check",
    });
    await ledger.run("UPDATE knowledge_items SET lifecycle='missing_upstream',stale=1 WHERE id=?", [itemId]);

    // One active refresh per connection; committed/ready CAS preconditions.
    await ledger.run(
      "INSERT INTO knowledge_refreshes (id,account_id,connection_id,expected_connection_revision) VALUES (?,?,?,1)",
      ["r-active", account, connection.id]
    );
    await expect(
      ledger.run(
        "INSERT INTO knowledge_refreshes (id,account_id,connection_id,expected_connection_revision) VALUES (?,?,?,1)",
        ["r-two", account, connection.id]
      )
    ).rejects.toMatchObject({ kind: "unique" });
    await ledger.run(
      `INSERT INTO knowledge_refresh_items (refresh_id,account_id,item_id,connection_id,source_id,relative_path)
       VALUES ('r-active',?,?,?,?,'ok.md')`,
      [account, itemId, connection.id, sourceId]
    );
    await expect(
      ledger.run("UPDATE knowledge_refresh_items SET status='committed' WHERE refresh_id='r-active'", [])
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      ledger.run(
        "UPDATE knowledge_refresh_items SET status='ready',promoted_generation=NULL WHERE refresh_id='r-active'",
        []
      )
    ).rejects.toMatchObject({ kind: "check" });
    // A refresh item may never borrow another account's managed item.
    await expect(
      ledger.run(
        `INSERT INTO knowledge_refresh_items (refresh_id,account_id,item_id,connection_id,source_id,relative_path)
         VALUES ('r-active',?,?,?,?,'x.md')`,
        [foreign, "elsewhere", connection.id, sourceId]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });

    // Cascades: connection removal keeps sources; source removal cascades items.
    await ledger.run(
      `INSERT INTO knowledge_previews (id,account_id,connection_id,scan_limit_entries,scan_limit_depth,scan_limit_visited,scan_limit_bytes,expires_at)
       VALUES ('p1',?,?,1000,10,1000,104857600,'2099-01-01T00:00:00.000Z')`,
      [account, connection.id]
    );
    await ledger.run("DELETE FROM knowledge_connections WHERE id=? AND account_id=?", [connection.id, account]);
    await expect(ledger.get("SELECT 1 FROM knowledge_items WHERE id=?", [itemId])).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM knowledge_previews WHERE id='p1'")).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM knowledge_refreshes WHERE id='r-active'")).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM sources WHERE id=?", [sourceId])).resolves.toMatchObject({ "1": 1n });

    // Library removal SET NULLs the connection binding, never the connection.
    const orphan = await store.createConnection(account, {
      name: "Orphan",
      kind: "desktop_folder",
      config: folderConfig,
      library_id: libraryId,
    });
    await ledger.run("DELETE FROM libraries WHERE id=? AND account_id=?", [libraryId, account]);
    expect((await store.requireConnection(account, orphan.id)).library_id).toBeNull();
    // Account cascade clears everything knowledge-scoped.
    await ledger.run("DELETE FROM users WHERE id=?", [account]);
    await expect(
      ledger.get("SELECT 1 FROM knowledge_connections WHERE account_id=?", [account])
    ).resolves.toBeUndefined();
  });

  it("manages connections with revision CAS, credential booleans, and account isolation", async () => {
    const { ledger, store, account, foreign, libraryId } = await seed();
    const connection = await store.requireConnection(account, (await store.listConnections(account)).items[0]!.id);
    expect(connection.status).toBe("untested");
    expect(connection.credential_configured).toBe(false);
    expect(connection.config).toEqual({ kind: "webdav", ...webdavConfig });

    await expect(
      store.createConnection(account, { name: "Primary", kind: "webdav", config: webdavConfig, library_id: libraryId })
    ).rejects.toBeInstanceOf(DuplicateKnowledgeConnectionError);
    // Another account may reuse the name with its own library.
    const foreignLibrary = await insertLibrary(ledger, foreign, "Foreign library");
    const foreignConnection = await store.createConnection(foreign, {
      name: "Primary",
      kind: "webdav",
      config: webdavConfig,
      library_id: foreignLibrary,
    });
    expect(foreignConnection.id).not.toBe(connection.id);

    await expect(store.getConnection(foreign, connection.id)).resolves.toBeUndefined();
    await expect(
      store.updateConnection(foreign, connection.id, { name: "Hijack", expected_revision: 1 })
    ).rejects.toBeInstanceOf(KnowledgeConnectionNotFoundError);
    // The foreign account's own catalog only ever holds its own connection.
    const foreignCatalog = await store.listConnections(foreign);
    expect(foreignCatalog.items.map((entry) => entry.id)).toEqual([foreignConnection.id]);

    const renamed = await store.updateConnection(account, connection.id, { name: "Renamed", expected_revision: 1 });
    expect(renamed.revision).toBe(2);
    await store.recordConnectionStatus(account, connection.id, "ready", null);
    const folder = await store.createConnection(account, {
      name: "Folder",
      kind: "desktop_folder",
      config: folderConfig,
      library_id: libraryId,
    });
    // Watch is a desktop-only capability; WebDAV connections refuse the toggle.
    await expect(
      store.updateConnection(account, connection.id, { watch_enabled: true, expected_revision: 2 })
    ).rejects.toBeInstanceOf(KnowledgeConnectionConfigError);
    // Watch toggles on a desktop folder are durable state and never bump the
    // configuration revision, nor do they rewrite the status evidence.
    const watched = await store.updateConnection(account, folder.id, { watch_enabled: true, expected_revision: 1 });
    expect(watched.watch_enabled).toBe(true);
    expect(watched.revision).toBe(1);
    // A repeated watch toggle is idempotent durable state (no lineage bump)...
    await expect(
      store.updateConnection(account, folder.id, { watch_enabled: true, expected_revision: 1 })
    ).resolves.toMatchObject({ watch_enabled: true, revision: 1 });
    // ...while a stale connection revision still conflicts on any patch.
    await expect(
      store.updateConnection(account, connection.id, { watch_enabled: true, expected_revision: 1 })
    ).rejects.toBeInstanceOf(KnowledgeConnectionRevisionConflictError);

    // A configuration edit is a new revision and resets the status evidence.
    const edited = await store.updateConnection(account, connection.id, {
      config: { url: "https://dav.example.test/other", username: "ada" },
      expected_revision: 2,
    });
    expect(edited.revision).toBe(3);
    expect(edited.status).toBe("untested");
    expect(edited.config).toEqual({ kind: "webdav", url: "https://dav.example.test/other", username: "ada" });

    // WebDAV credentials never enter the ledger: only the boolean moves.
    await store.setCredentialConfigured(account, connection.id, true);
    expect((await store.requireConnection(account, connection.id)).credential_configured).toBe(true);
    await expect(store.setCredentialConfigured(account, folder.id, true)).rejects.toBeInstanceOf(
      KnowledgeConnectionNotFoundError
    );
    await expect(
      store.createConnection(account, {
        name: "Foreign lib",
        kind: "webdav",
        config: webdavConfig,
        library_id: randomUUID(),
      })
    ).rejects.toBeInstanceOf(KnowledgeLibraryUnavailableError);
    await expect(
      store.createConnection(account, {
        name: "Watch webdav",
        kind: "webdav",
        config: webdavConfig,
        library_id: libraryId,
        watch_enabled: true,
      })
    ).rejects.toBeInstanceOf(KnowledgeConnectionConfigError);
  });

  it("runs the preview lifecycle: exact revision apply, stale/expired refusal, and quota gates", async () => {
    const clock = { value: new Date("2026-09-06T00:00:00.000Z") };
    const { ledger, store, account, connectionId } = await seed({ now: () => clock.value });
    const existingSource = await insertSource(ledger, account);
    await insertItem(ledger, account, connectionId, "keep/a.md", existingSource, hash("old"));

    const preview = await store.createPreview(account, connectionId, bounds);
    expect(preview.status).toBe("pending");
    expect(preview.revision).toBe(1);
    expect(preview.expires_at).toBe("2026-09-06T00:10:00.000Z");
    // An untouched second preview gives the sweep something to expire after
    // the clock moves; the first preview expires lazily via getPreview.
    const untouchedPreview = await store.createPreview(account, connectionId, bounds);
    expect(untouchedPreview.status).toBe("pending");

    const completed = await store.completePreview(
      account,
      preview.id,
      scanEntries([
        { relative_path: "docs/new.md", classification: "new", content_hash: hash("new"), size_bytes: 3 },
        {
          relative_path: "keep/a.md",
          classification: "changed",
          content_hash: hash("edited"),
          size_bytes: 6,
          existing_source_id: existingSource,
        },
        { relative_path: "dup/b.md", classification: "duplicate", content_hash: hash("new"), size_bytes: 3 },
        { relative_path: "same/c.md", classification: "unchanged", content_hash: hash("same"), size_bytes: 4 },
        {
          relative_path: "gone.md",
          classification: "missing",
          content_hash: null,
          size_bytes: 9,
          existing_source_id: existingSource,
        },
        { relative_path: "raw.bin", classification: "unsupported", content_hash: null, size_bytes: 500 },
      ])
    );
    expect(completed.preview.status).toBe("complete");
    expect(completed.preview.revision).toBe(2);
    expect({
      new: completed.preview.new_count,
      changed: completed.preview.changed_count,
      unchanged: completed.preview.unchanged_count,
      duplicate: completed.preview.duplicate_count,
      missing: completed.preview.missing_count,
      unsupported: completed.preview.unsupported_count,
    }).toEqual({ new: 1, changed: 1, unchanged: 1, duplicate: 1, missing: 1, unsupported: 1 });
    for (const entry of completed.entries) {
      expect(entry.selection_token).toBe(
        knowledgeSelectionToken(
          preview.id,
          2,
          entry.entry_id,
          entry.classification,
          entry.content_hash,
          entry.existing_source_id
        )
      );
    }

    const selectable = completed.entries.filter((entry) =>
      ["new", "changed", "duplicate"].includes(entry.classification)
    );
    await expect(
      store.applyPreview(account, preview.id, {
        expected_revision: 1,
        selections: selectable.map((entry) => ({
          entry_id: entry.entry_id,
          selection_token: entry.selection_token,
          staged: staged(entry.relative_path, entry.content_hash!),
        })),
      })
    ).rejects.toBeInstanceOf(KnowledgePreviewStaleError);

    const unchangedEntry = completed.entries.find((entry) => entry.classification === "unchanged")!;
    await expect(
      store.applyPreview(account, preview.id, {
        expected_revision: 2,
        selections: [
          {
            entry_id: unchangedEntry.entry_id,
            selection_token: unchangedEntry.selection_token,
            staged: staged(unchangedEntry.relative_path, "same"),
          },
        ],
      })
    ).rejects.toBeInstanceOf(KnowledgePreviewSelectionError);

    const newEntry = selectable.find((entry) => entry.classification === "new")!;
    await expect(
      store.applyPreview(account, preview.id, {
        expected_revision: 2,
        selections: [
          {
            entry_id: newEntry.entry_id,
            selection_token: newEntry.selection_token,
            staged: staged(newEntry.relative_path, "content that moved after the scan"),
          },
        ],
      })
    ).rejects.toBeInstanceOf(KnowledgePreviewStaleError);

    // Expired previews fail closed and are recorded as expired.
    clock.value = new Date("2026-09-06T00:10:00.001Z");
    await expect(store.getPreview(account, preview.id)).resolves.toMatchObject({ status: "expired" });
    await expect(
      store.applyPreview(account, preview.id, {
        expected_revision: 2,
        selections: [
          {
            entry_id: newEntry.entry_id,
            selection_token: newEntry.selection_token,
            staged: staged(newEntry.relative_path, "new"),
          },
        ],
      })
    ).rejects.toBeInstanceOf(KnowledgePreviewExpiredError);

    await expect(store.sweepExpiredPreviews()).resolves.toBeGreaterThanOrEqual(1);
    await expect(store.completePreview(account, preview.id, scanEntries([]))).rejects.toBeInstanceOf(
      KnowledgePreviewStaleError
    );
    await expect(store.getPreview(account, randomUUID())).resolves.toBeUndefined();
    await expect(
      store.applyPreview(account, randomUUID(), {
        expected_revision: 2,
        selections: [
          {
            entry_id: randomUUID(),
            selection_token: "0".repeat(64),
            staged: staged("x.md", "x"),
          },
        ],
      })
    ).rejects.toBeInstanceOf(KnowledgePreviewNotFoundError);
    await expect(
      store.applyPreview(account, preview.id, {
        expected_revision: 2,
        selections: selectable.map((entry) => ({
          entry_id: entry.entry_id,
          selection_token: "0".repeat(64),
          staged: staged(entry.relative_path, entry.content_hash!),
        })),
      })
    ).rejects.toBeInstanceOf(KnowledgePreviewExpiredError);
  });

  it("commits selected entries with normal membership rules and one durable refresh", async () => {
    const { ledger, store, account, connectionId, libraryId } = await seed();
    const existingSource = await insertSource(ledger, account, { readyGeneration: 2 });
    await ledger.run("INSERT INTO library_sources (library_id,source_id,account_id) VALUES (?,?,?)", [
      libraryId,
      existingSource,
      account,
    ]);
    await insertItem(ledger, account, connectionId, "keep/a.md", existingSource, hash("old"));
    // A chat explicitly selects the existing source; apply must not touch it.
    const chatId = randomUUID();
    await ledger.run("INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,'m','selected')", [
      chatId,
      account,
      "Scoped chat",
    ]);
    await ledger.run("INSERT INTO chat_sources (chat_id,source_id,account_id) VALUES (?,?,?)", [
      chatId,
      existingSource,
      account,
    ]);
    const chatScopeBefore = JSON.stringify(
      await ledger.all("SELECT chat_id,source_id,account_id FROM chat_sources ORDER BY chat_id,source_id")
    );

    const preview = await store.createPreview(account, connectionId, bounds);
    const completed = await store.completePreview(
      account,
      preview.id,
      scanEntries([
        { relative_path: "docs/new note.md", classification: "new", content_hash: hash("new"), size_bytes: 3 },
        {
          relative_path: "keep/a.md",
          classification: "changed",
          content_hash: hash("edited"),
          size_bytes: 6,
          existing_source_id: existingSource,
        },
      ])
    );
    const applied = await store.applyPreview(account, preview.id, {
      expected_revision: 2,
      selections: completed.entries.map((entry) => ({
        entry_id: entry.entry_id,
        selection_token: entry.selection_token,
        staged: staged(entry.relative_path, entry.classification === "new" ? "new" : "edited"),
      })),
    });
    expect(applied.preview.status).toBe("applied");
    expect(applied.preview.revision).toBe(3);
    expect(applied.items.map((item) => item.action)).toEqual(["created", "updated"]);
    expect(applied.items[1]!.source_id).toBe(existingSource);
    // Apply commits durable state but opens no refresh: re-ingestion is owned
    // entirely by refreshAndWaitReady.
    expect(await store.getActiveRefresh(account, connectionId)).toBeUndefined();

    const createdSource = await ledger.get<{
      name: string;
      status: string;
      file_path: string;
      ready_generation: number | null;
    }>("SELECT name,status,file_path,ready_generation FROM sources WHERE id=?", [applied.items[0]!.source_id]);
    expect(createdSource?.name).toBe("kn_docs_new_note_md");
    expect(createdSource?.status).toBe("index");
    expect(createdSource?.ready_generation).toBeNull();
    // The changed source swapped to the staged bytes and advanced its
    // intended content while its ingested content (last indexed) is untouched.
    const changedItem = await store.getItem(account, applied.items[1]!.item_id);
    expect(changedItem?.content_hash).toBe(hash("edited"));
    expect(changedItem?.ingested_hash).toBeNull();

    expect(await store.countManagedItems(account, connectionId)).toBe(2);
    const members = await ledger.all<{ source_id: string }>(
      "SELECT source_id FROM library_sources WHERE library_id=? ORDER BY source_id",
      [libraryId]
    );
    expect(members.map((member) => member.source_id).sort()).toEqual(
      [existingSource, applied.items[0]!.source_id].sort()
    );

    // A refresh now snapshots both committed items with their current ready
    // generations; nothing is reserved until the caller drives it.
    const begun = await store.beginRefresh(account, {
      connection_id: connectionId,
      expected_connection_revision: 1,
    });
    const refreshItems = await store.listRefreshItems(account, begun.refresh.id);
    expect(refreshItems).toHaveLength(2);
    for (const item of refreshItems) {
      expect(item.status).toBe("pending");
    }
    const changedRow = refreshItems.find((item) => item.item_id === applied.items[1]!.item_id)!;
    expect(changedRow.current_ready_generation).toBe(2);
    const newRow = refreshItems.find((item) => item.item_id === applied.items[0]!.item_id)!;
    expect(newRow.current_ready_generation).toBeNull();
    // A second begin while a refresh is active conflicts on the one-active
    // index even though the connection revision still matches.
    await expect(
      store.beginRefresh(account, { connection_id: connectionId, expected_connection_revision: 1 })
    ).rejects.toBeInstanceOf(KnowledgeRefreshConflictError);
    await expect(
      store.beginRefresh(account, {
        connection_id: connectionId,
        expected_connection_revision: 1,
        requested_by: "scheduled",
      })
    ).rejects.toBeInstanceOf(KnowledgeRefreshConflictError);

    // The chat's explicit selection is byte-identical after the import.
    expect(
      JSON.stringify(
        await ledger.all("SELECT chat_id,source_id,account_id FROM chat_sources ORDER BY chat_id,source_id")
      )
    ).toBe(chatScopeBefore);
  });

  it("enforces the per-connection item quota and the library capacity atomically", async () => {
    const { ledger, store, account, connectionId } = await seed();
    for (let index = 0; index < MAX_MANAGED_ITEMS_PER_CONNECTION - 1; index += 1) {
      const sourceId = await insertSource(ledger, account, { name: `q-${index}` });
      await insertItem(ledger, account, connectionId, `f${index}.md`, sourceId, hash(`q${index}`));
    }
    const preview = await store.createPreview(account, connectionId, bounds);
    const completed = await store.completePreview(
      account,
      preview.id,
      scanEntries([
        { relative_path: "extra-1.md", classification: "new", content_hash: hash("x1"), size_bytes: 2 },
        { relative_path: "extra-2.md", classification: "new", content_hash: hash("x2"), size_bytes: 2 },
      ])
    );
    await expect(
      store.applyPreview(account, preview.id, {
        expected_revision: 2,
        selections: completed.entries.map((entry, index) => ({
          entry_id: entry.entry_id,
          selection_token: entry.selection_token,
          staged: staged(entry.relative_path, `x${index + 1}`),
        })),
      })
    ).rejects.toBeInstanceOf(KnowledgeQuotaError);
    // Nothing activated: no refresh row, no third source, preview untouched.
    expect(await store.countManagedItems(account, connectionId)).toBe(MAX_MANAGED_ITEMS_PER_CONNECTION - 1);
    expect((await store.getPreview(account, preview.id))?.status).toBe("complete");
    expect(await ledger.get("SELECT 1 FROM knowledge_refreshes WHERE connection_id=?", [connectionId])).toBeUndefined();
  });

  it("drives item lifecycle through missing, remove, and re-import reactivation", async () => {
    const { ledger, store, account, connectionId, libraryId } = await seed();
    const sourceId = await insertSource(ledger, account, { readyGeneration: 4 });
    await ledger.run("INSERT INTO library_sources (library_id,source_id,account_id) VALUES (?,?,?)", [
      libraryId,
      sourceId,
      account,
    ]);
    const itemId = await insertItem(ledger, account, connectionId, "solo.md", sourceId, hash("v1"));

    const begun = await store.beginRefresh(account, {
      connection_id: connectionId,
      expected_connection_revision: 1,
    });
    expect(begun.items).toHaveLength(1);
    expect(await store.resolveRefreshItem(account, begun.refresh.id, itemId, { status: "missing" })).toBe(true);
    let item = await store.getItem(account, itemId);
    expect(item?.lifecycle).toBe("missing_upstream");
    expect(item?.stale).toBe(true);
    expect(item?.last_refreshed_at).not.toBeNull();
    // The source and its last ready content are retained by the scan alone.
    expect(ledger.get("SELECT 1 FROM sources WHERE id=?", [sourceId])).resolves.toMatchObject({ "1": 1n });
    await store.finishRefresh(account, begun.refresh.id, "partial", null);
    // A `missing_upstream` item may be refreshed again — it can reappear.
    const revivalRun = await store.beginRefresh(account, {
      connection_id: connectionId,
      expected_connection_revision: 1,
      item_ids: [itemId],
    });
    expect(revivalRun.items).toHaveLength(1);
    await store.resolveRefreshItem(account, revivalRun.refresh.id, itemId, { status: "missing" });
    await store.finishRefresh(account, revivalRun.refresh.id, "partial", null);

    // The explicit remove-from-library action keeps the source row.
    const removed = await store.removeItem(account, itemId);
    expect(removed?.lifecycle).toBe("removed");
    expect(removed?.stale).toBe(false);
    expect(await ledger.get("SELECT 1 FROM library_sources WHERE source_id=?", [sourceId])).toBeUndefined();
    expect(ledger.get("SELECT 1 FROM sources WHERE id=?", [sourceId])).resolves.toMatchObject({ "1": 1n });
    await expect(store.removeItem(account, itemId)).resolves.toMatchObject({ lifecycle: "removed" });
    // A `removed` item cannot be refreshed; re-importing is explicit.
    await expect(
      store.beginRefresh(account, { connection_id: connectionId, expected_connection_revision: 1, item_ids: [itemId] })
    ).rejects.toBeInstanceOf(KnowledgePreviewSelectionError);

    // Re-importing the same path reactivates the retained identity — the same
    // source id is reused rather than allocated again.
    const preview = await store.createPreview(account, connectionId, bounds);
    const completed = await store.completePreview(
      account,
      preview.id,
      scanEntries([{ relative_path: "solo.md", classification: "new", content_hash: hash("v2"), size_bytes: 2 }])
    );
    const applied = await store.applyPreview(account, preview.id, {
      expected_revision: 2,
      selections: [
        {
          entry_id: completed.entries[0]!.entry_id,
          selection_token: completed.entries[0]!.selection_token,
          staged: staged("solo.md", "v2"),
        },
      ],
    });
    expect(applied.items[0]!.action).toBe("updated");
    expect(applied.items[0]!.item_id).toBe(itemId);
    expect(applied.items[0]!.source_id).toBe(sourceId);
    item = await store.getItem(account, itemId);
    expect(item?.lifecycle).toBe("active");
    // Membership is restored by normal rules through the reactivation path.
    expect(
      (await ledger.get<{ n: bigint }>("SELECT COUNT(*) AS n FROM library_sources WHERE source_id=?", [sourceId]))?.n
    ).toBe(1n);
    expect(item?.content_hash).toBe(hash("v2"));

    // The next refresh adopts the staged bytes and reserves one generation.
    const rerun = await store.beginRefresh(account, {
      connection_id: connectionId,
      expected_connection_revision: 1,
    });
    const refreshItems = await store.listRefreshItems(account, rerun.refresh.id);
    expect(refreshItems).toHaveLength(1);
    expect(await store.adoptStagedSourceItem(account, rerun.refresh.id, itemId)).toBe(true);
    await store.commitRefreshItem(account, rerun.refresh.id, itemId, 5);
    const promoted = await store.readyRefreshItem(account, {
      refresh_id: rerun.refresh.id,
      item_id: itemId,
      size_bytes: 2,
    });
    expect(promoted).toBeUndefined();
    await ledger.run("UPDATE sources SET ready_generation=5,status='ready' WHERE id=?", [sourceId]);
    const promotedPair = await store.readyRefreshItem(account, {
      refresh_id: rerun.refresh.id,
      item_id: itemId,
      size_bytes: 2,
    });
    expect(promotedPair).toEqual({ source_id: sourceId, item_id: itemId, generation: 5 });
    item = await store.getItem(account, itemId);
    expect(item?.content_hash).toBe(hash("v2"));
    expect(item?.ingested_hash).toBe(hash("v2"));
    await store.finishRefresh(account, rerun.refresh.id, "completed", null);
  });

  it("drives the refresh CAS: stage, commit, promote, cancel, finalize, and newest-100 history", async () => {
    const { ledger, store, account, connectionId } = await seed();
    const sourceId = await insertSource(ledger, account, { readyGeneration: 7, filePath: "/live/old.bin" });
    await insertItem(ledger, account, connectionId, "c.md", sourceId, hash("v1"));

    const begun = await store.beginRefresh(account, {
      connection_id: connectionId,
      expected_connection_revision: 1,
    });
    const refreshId = begun.refresh.id;
    const itemId = begun.items[0]!.item_id;
    expect(begun.items[0]!.current_ready_generation).toBe(7);
    await expect(
      store.beginRefresh(account, { connection_id: connectionId, expected_connection_revision: 1 })
    ).rejects.toBeInstanceOf(KnowledgeRefreshConflictError);
    await expect(
      store.beginRefresh(account, {
        connection_id: connectionId,
        expected_connection_revision: 1,
        item_ids: [randomUUID()],
      })
    ).rejects.toBeInstanceOf(KnowledgeItemNotFoundError);

    // CAS ladder: pending -> staged -> committed -> ready.
    const staged = await store.stageRefreshItem(account, {
      refresh_id: refreshId,
      item_id: itemId,
      candidate_path: "/live/candidate.bin",
      candidate_size_bytes: 11,
      target_hash: hash("v2"),
      mime: "text/csv",
    });
    expect(staged).toBe(true);
    expect(
      await store.stageRefreshItem(account, {
        refresh_id: refreshId,
        item_id: itemId,
        candidate_path: "/live/other.bin",
        candidate_size_bytes: 1,
        target_hash: hash("v3"),
      })
    ).toBe(false);
    const sourceRow = await ledger.get<{ file_path: string; size_bytes: bigint; mime: string }>(
      "SELECT file_path,size_bytes,mime FROM sources WHERE id=?",
      [sourceId]
    );
    expect(sourceRow).toEqual({ file_path: "/live/candidate.bin", size_bytes: 11n, mime: "text/csv" });

    expect(await store.commitRefreshItem(account, refreshId, itemId, 8)).toBe(true);
    expect(await store.commitRefreshItem(account, refreshId, itemId, 9)).toBe(false);
    expect(await store.readyRefreshItem(account, { refresh_id: refreshId, item_id: itemId })).toBeUndefined();
    const state = await store.sourceIngestionState(account, sourceId);
    expect(state).toMatchObject({ sourceStatus: "ready", readyGeneration: 7, jobStatus: null, jobGeneration: null });
    expect(state?.filePath).toBe("/live/candidate.bin");
    await ledger.run("UPDATE sources SET ready_generation=8 WHERE id=?", [sourceId]);
    const promoted = await store.readyRefreshItem(account, {
      refresh_id: refreshId,
      item_id: itemId,
      size_bytes: 11,
      mtime_hint: "mtime-2",
      etag_hint: "etag-2",
    });
    expect(promoted).toEqual({ source_id: sourceId, item_id: itemId, generation: 8 });
    expect(await store.readyRefreshItem(account, { refresh_id: refreshId, item_id: itemId })).toBeUndefined();
    // A promoted row cannot be re-resolved; the item identity moved to v2.
    expect(await store.resolveRefreshItem(account, refreshId, itemId, { status: "missing" })).toBe(false);
    const item = await store.getItem(account, itemId);
    expect(item?.content_hash).toBe(hash("v2"));
    expect(item?.mtime_hint).toBe("mtime-2");

    expect(await store.requestRefreshCancellation(account, refreshId)).toBe(true);
    const finished = await store.finishRefresh(account, refreshId, "completed", null);
    expect(finished).toMatchObject({ status: "completed", cancel_requested: true });
    await expect(store.finishRefresh(account, refreshId, "failed", null)).rejects.toBeInstanceOf(
      KnowledgeRefreshConflictError
    );
    expect(await store.listInterruptedRefreshes(account)).toEqual([]);

    // History trims to the newest 100 while an active run is never trimmed.
    for (let index = 0; index < MAX_REFRESH_HISTORY_PER_CONNECTION + 2; index += 1) {
      const run = await store.beginRefresh(account, {
        connection_id: connectionId,
        expected_connection_revision: 1,
        item_ids: [],
      });
      await store.finishRefresh(account, run.refresh.id, "completed", null);
    }
    const history = await ledger.get<{ n: bigint }>(
      "SELECT COUNT(*) AS n FROM knowledge_refreshes WHERE connection_id=? AND status<>'active'",
      [connectionId]
    );
    expect(history?.n).toBe(BigInt(MAX_REFRESH_HISTORY_PER_CONNECTION));
    const keepActive = await store.beginRefresh(account, {
      connection_id: connectionId,
      expected_connection_revision: 1,
      item_ids: [],
    });
    const after = await store.finishRefresh(account, keepActive.refresh.id, "cancelled", null);
    expect(after?.status).toBe("cancelled");
    const activeHistory = await ledger.get<{ n: bigint }>(
      "SELECT COUNT(*) AS n FROM knowledge_refreshes WHERE connection_id=?",
      [connectionId]
    );
    expect(activeHistory?.n).toBe(BigInt(MAX_REFRESH_HISTORY_PER_CONNECTION));
    const foreignSeed = await seed();
    const foreignPage = await store.listRefreshes(foreignSeed.account, connectionId);
    expect(foreignPage.items).toEqual([]);
  });

  it("keeps every account-scoped read and write closed to foreign accounts", async () => {
    const { ledger, store, account, foreign, connectionId } = await seed();
    const sourceId = await insertSource(ledger, account);
    const itemId = await insertItem(ledger, account, connectionId, "a.md", sourceId, hash("a"));
    const preview = await store.createPreview(account, connectionId, bounds);
    const refresh = await store.beginRefresh(account, {
      connection_id: connectionId,
      expected_connection_revision: 1,
    });

    await expect(store.getItem(foreign, itemId)).resolves.toBeUndefined();
    await expect(store.listItems(foreign, connectionId)).resolves.toMatchObject({ items: [] });
    await expect(store.getPreview(foreign, preview.id)).resolves.toBeUndefined();
    await expect(store.listPreviewEntries(foreign, preview.id)).rejects.toBeInstanceOf(KnowledgePreviewNotFoundError);
    await expect(store.getRefresh(foreign, refresh.refresh.id)).resolves.toBeUndefined();
    await expect(store.listRefreshItems(foreign, refresh.refresh.id)).rejects.toBeInstanceOf(
      KnowledgeRefreshNotFoundError
    );
    await expect(store.sourceIngestionState(foreign, sourceId)).resolves.toBeUndefined();
    await expect(store.removeItem(foreign, itemId)).resolves.toBeUndefined();
    await expect(
      store.applyPreview(foreign, preview.id, { expected_revision: 1, selections: [] })
    ).rejects.toBeInstanceOf(KnowledgePreviewSelectionError);
    await expect(
      store.beginRefresh(foreign, { connection_id: connectionId, expected_connection_revision: 1 })
    ).rejects.toBeInstanceOf(KnowledgeConnectionNotFoundError);
    await expect(store.commitRefreshItem(foreign, refresh.refresh.id, itemId, 2)).resolves.toBe(false);
    await expect(
      store.stageRefreshItem(foreign, {
        refresh_id: refresh.refresh.id,
        item_id: itemId,
        candidate_path: "/x",
        candidate_size_bytes: 1,
        target_hash: hash("x"),
      })
    ).resolves.toBe(false);
    await expect(store.requestRefreshCancellation(foreign, refresh.refresh.id)).resolves.toBe(false);
    await expect(store.finishRefresh(foreign, refresh.refresh.id, "cancelled", null)).rejects.toBeInstanceOf(
      KnowledgeRefreshNotFoundError
    );
    // Source deletion cascades the managed identity (the separate normal
    // source-deletion action), leaving the connection and refresh untouched.
    await ledger.run("DELETE FROM sources WHERE id=? AND account_id=?", [sourceId, account]);
    expect(await store.getItem(account, itemId)).toBeUndefined();
    expect(await store.countManagedItems(account, connectionId)).toBe(0);
  });
});
