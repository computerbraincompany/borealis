import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSqliteValue,
  decodeBoolean,
  decodeIsoTimestamp,
  decodeJson,
  decodeSafeInteger,
  encodeBoolean,
  encodeIsoTimestamp,
  encodeJson,
  encodeSafeInteger,
} from "../db/codecs.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  SqliteClosedError,
  SqliteCodecError,
  SqliteMigrationError,
  SqliteTransactionUsageError,
  type SqliteLedger,
} from "../db/types.js";
import {
  createHistoricalSqliteFixture,
  expectedFixtureVersions,
  listHistoricalFixtureVersions,
  PENDING_MERGE_SCHEMA_VERSIONS,
} from "./sqliteMigrationFixture.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const temporaryLedgers: TempSqliteLedger[] = [];

async function temporaryLedger(): Promise<TempSqliteLedger> {
  const resource = await createTempSqliteLedger();
  temporaryLedgers.push(resource);
  return resource;
}

afterEach(async () => {
  await Promise.all(temporaryLedgers.splice(0).map((resource) => resource.cleanup()));
});

describe("SQLite ledger foundation", () => {
  it("creates the complete versioned WAL schema without embedding columns", async () => {
    const { ledger } = await temporaryLedger();

    await expect(ledger.health()).resolves.toBe(true);
    await expect(ledger.get<{ foreign_keys: bigint }>("PRAGMA foreign_keys")).resolves.toEqual({ foreign_keys: 1n });
    await expect(ledger.get<{ journal_mode: string }>("PRAGMA journal_mode")).resolves.toEqual({
      journal_mode: "wal",
    });
    await expect(ledger.get<{ timeout: bigint }>("PRAGMA busy_timeout")).resolves.toEqual({
      timeout: 5_000n,
    });
    await expect(ledger.get<{ trusted_schema: bigint }>("PRAGMA trusted_schema")).resolves.toEqual({
      trusted_schema: 0n,
    });
    await expect(ledger.get<{ user_version: bigint }>("PRAGMA user_version")).resolves.toEqual({
      user_version: BigInt(LATEST_SQLITE_SCHEMA_VERSION),
    });

    const tables = new Set(
      (await ledger.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(
        (row) => row.name
      )
    );
    expect([...tables]).toEqual(
      expect.arrayContaining([
        "users",
        "sources",
        "chunks",
        "connectors",
        "chats",
        "chat_sources",
        "messages",
        "chat_runs",
        "chat_run_sources",
        "ingestion_jobs",
        "dataset_cache_cleanup_jobs",
        "ingestion_chunk_staging",
        "pending_source_deletes",
        "pending_vector_ops",
        "reports",
        "charts",
        "report_artifact_cleanup_jobs",
      ])
    );

    await expect(ledger.all("PRAGMA foreign_key_list(report_artifact_cleanup_jobs)")).resolves.toEqual([]);

    const sourceColumns = await columnNames(ledger, "sources");
    expect(sourceColumns).toContain("ready_generation");
    const chunkColumns = await columnNames(ledger, "chunks");
    expect(chunkColumns).toEqual(expect.arrayContaining(["id", "generation", "seq", "content"]));
    expect(chunkColumns).not.toContain("embedding");
    const stagingColumns = await columnNames(ledger, "ingestion_chunk_staging");
    expect(stagingColumns).toContain("chunk_id");
    expect(stagingColumns).not.toContain("embedding");

    const storageSql = await ledger.all<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('chunks','ingestion_chunk_staging')"
    );
    expect(storageSql.map((row) => row.sql.toLowerCase()).join("\n")).not.toMatch(/embedding|vector\s*\(/);

    const accountId = randomUUID();
    await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      accountId,
      "a@example.test",
      "hash",
    ]);
    const user = await ledger.get<{ created_at: string }>("SELECT created_at FROM users WHERE id=?", [accountId]);
    expect(user?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(decodeIsoTimestamp(user?.created_at)).toBe(user?.created_at);

    const userColumns = await columnNames(ledger, "users");
    expect(userColumns).toContain("default_chat_model");
  });

  it("enforces the personal default chat model column bounds", async () => {
    const { ledger } = await temporaryLedger();
    const account = randomUUID();
    await insertUser(ledger, account, "defaults@example.test");
    await expect(ledger.get("SELECT default_chat_model FROM users WHERE id=?", [account])).resolves.toEqual({
      default_chat_model: null,
    });

    await ledger.run("UPDATE users SET default_chat_model=? WHERE id=?", ["personal-model", account]);
    await expect(ledger.get("SELECT default_chat_model FROM users WHERE id=?", [account])).resolves.toEqual({
      default_chat_model: "personal-model",
    });
    await expect(
      ledger.run("UPDATE users SET default_chat_model=? WHERE id=?", ["x".repeat(201), account])
    ).rejects.toMatchObject({ kind: "check" });

    await ledger.run("UPDATE users SET default_chat_model=NULL WHERE id=?", [account]);
    await expect(ledger.get("SELECT default_chat_model FROM users WHERE id=?", [account])).resolves.toEqual({
      default_chat_model: null,
    });
  });

  it("ships schema v14 with the bounded nullable provider consent origin", async () => {
    const { ledger } = await temporaryLedger();
    const account = randomUUID();
    await insertUser(ledger, account, "consent-origin@example.test");

    expect(await columnNames(ledger, "users")).toContain("remote_egress_ack_origin");
    await expect(
      ledger.get("SELECT remote_egress_ack_at,remote_egress_ack_origin FROM users WHERE id=?", [account])
    ).resolves.toEqual({ remote_egress_ack_at: null, remote_egress_ack_origin: null });

    await ledger.run("UPDATE users SET remote_egress_ack_at=?,remote_egress_ack_origin=? WHERE id=?", [
      "2026-09-06T00:00:00.000Z",
      "https://api.provider.example",
      account,
    ]);
    await expect(ledger.get("SELECT remote_egress_ack_origin FROM users WHERE id=?", [account])).resolves.toEqual({
      remote_egress_ack_origin: "https://api.provider.example",
    });

    await ledger.run("UPDATE users SET remote_egress_ack_origin=? WHERE id=?", ["o".repeat(2048), account]);
    await expect(
      ledger.run("UPDATE users SET remote_egress_ack_origin=? WHERE id=?", ["o".repeat(2049), account])
    ).rejects.toMatchObject({ kind: "check" });

    await ledger.run("UPDATE users SET remote_egress_ack_origin=NULL WHERE id=?", [account]);
    await expect(ledger.get("SELECT remote_egress_ack_origin FROM users WHERE id=?", [account])).resolves.toEqual({
      remote_egress_ack_origin: null,
    });
  });

  it("ships schema v17 with account-scoped connections and bounded tool snapshots", async () => {
    const { ledger } = await temporaryLedger();
    const account = randomUUID();
    const foreign = randomUUID();
    await insertUser(ledger, account, "connections@example.test");
    await insertUser(ledger, foreign, "connections-foreign@example.test");

    expect(await columnNames(ledger, "connections")).toEqual(
      expect.arrayContaining([
        "id",
        "account_id",
        "name",
        "kind",
        "revision",
        "discovery_revision",
        "config",
        "enabled",
        "status",
        "status_code",
        "created_at",
        "updated_at",
      ])
    );

    await ledger.run("INSERT INTO connections (id,account_id,name,kind,config) VALUES (?,?,?,?,?)", [
      randomUUID(),
      account,
      "Local MCP",
      "mcp_http",
      '{"url":"https://mcp.example.test/mcp"}',
    ]);
    await expect(
      ledger.run("INSERT INTO connections (id,account_id,name,kind,config) VALUES (?,?,?,?,?)", [
        randomUUID(),
        account,
        "Future kind",
        "webdav",
        "{}",
      ])
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      ledger.run("INSERT INTO connections (id,account_id,name,kind,config) VALUES (?,?,?,?,?)", [
        randomUUID(),
        account,
        "x".repeat(81),
        "mcp_stdio",
        '{"command":"/usr/bin/true"}',
      ])
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      ledger.run("INSERT INTO connections (id,account_id,name,kind,config,status) VALUES (?,?,?,?,?,'bogus')", [
        randomUUID(),
        account,
        "Bad status",
        "mcp_http",
        "{}",
      ])
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      ledger.run("INSERT INTO connections (id,account_id,name,kind,config,status_code) VALUES (?,?,?,?,?,?)", [
        randomUUID(),
        account,
        "Long code",
        "mcp_http",
        "{}",
        "c".repeat(65),
      ])
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      ledger.run("INSERT INTO connections (id,account_id,name,kind,config) VALUES (?,?,?,?,?)", [
        randomUUID(),
        account,
        "Bad json",
        "mcp_http",
        "{not json",
      ])
    ).rejects.toMatchObject({ kind: "check" });
    // One name per account; another account may reuse it.
    await expect(
      ledger.run("INSERT INTO connections (id,account_id,name,kind,config) VALUES (?,?,?,?,?)", [
        randomUUID(),
        account,
        "Local MCP",
        "mcp_http",
        "{}",
      ])
    ).rejects.toMatchObject({ kind: "unique" });
    await expect(
      ledger.run("INSERT INTO connections (id,account_id,name,kind,config) VALUES (?,?,?,?,?)", [
        randomUUID(),
        foreign,
        "Local MCP",
        "mcp_http",
        "{}",
      ])
    ).resolves.toMatchObject({ changes: 1 });

    const connectionId = randomUUID();
    await ledger.run("INSERT INTO connections (id,account_id,name,kind,config) VALUES (?,?,?,?,?)", [
      connectionId,
      account,
      "Snapshot host",
      "mcp_stdio",
      '{"command":"/usr/bin/true"}',
    ]);
    await ledger.run(
      "INSERT INTO connection_tool_snapshots (connection_id,account_id,discovery_revision,position,tool_id,name,input_schema) VALUES (?,?,?,0,?,?,?)",
      [connectionId, account, 1, "a".repeat(36), "read_file", '{"type":"object"}']
    );
    // The composite tenancy FK refuses a foreign account pairing (distinct
    // position so the primary-key uniqueness cannot mask the FK failure).
    await expect(
      ledger.run(
        "INSERT INTO connection_tool_snapshots (connection_id,account_id,discovery_revision,position,tool_id,name,input_schema) VALUES (?,?,?,1,?,?,?)",
        [connectionId, foreign, 1, "b".repeat(36), "sneak", "{}"]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      ledger.run(
        "INSERT INTO connection_tool_snapshots (connection_id,account_id,discovery_revision,position,tool_id,name,input_schema) VALUES (?,?,?,200,?,?,?)",
        [connectionId, account, 1, "c".repeat(36), "over-position", "{}"]
      )
    ).rejects.toMatchObject({ kind: "check" });

    await ledger.run("DELETE FROM connections WHERE id=? AND account_id=?", [connectionId, account]);
    await expect(
      ledger.get("SELECT 1 FROM connection_tool_snapshots WHERE connection_id=?", [connectionId])
    ).resolves.toBeUndefined();

    await ledger.run("DELETE FROM users WHERE id=?", [account]);
    await expect(ledger.get("SELECT 1 FROM connections WHERE account_id=?", [account])).resolves.toBeUndefined();
  });

  it("ships schema v21 with the append-only frozen MCP run snapshot column", async () => {
    const { ledger } = await temporaryLedger();
    const account = randomUUID();
    await insertUser(ledger, account, "mcp-run@example.test");

    expect(await columnNames(ledger, "chat_runs")).toContain("agent_mcp_tools");

    const chatId = randomUUID();
    const runId = randomUUID();
    await ledger.run("INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,?,'selected')", [
      chatId,
      account,
      "MCP run",
      "m",
    ]);
    const message = await ledger.run("INSERT INTO messages (chat_id,role,content) VALUES (?,'user','q')", [chatId]);
    await ledger.run("INSERT INTO chat_runs (id,account_id,chat_id,user_message_id) VALUES (?,?,?,?)", [
      runId,
      account,
      chatId,
      message.lastInsertRowid,
    ]);
    // The column is nullable: turns without MCP tools store SQL NULL, never
    // empty JSON that a reader might mistake for a frozen mapping.
    await expect(ledger.get("SELECT agent_mcp_tools FROM chat_runs WHERE id=?", [runId])).resolves.toEqual({
      agent_mcp_tools: null,
    });

    const snapshot = JSON.stringify([
      {
        alias: "mcp_abcdef0123456789abcdef0123456789",
        connection_id: randomUUID(),
        tool_id: randomUUID(),
        discovery_revision: 3,
        name: "echo_query",
        description: 'echo_query (connected tool via "Local") Echo the provided text back.',
        input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        authorization_reference: "secret:0123456789abcdef0123456789abcdef",
      },
    ]);
    await ledger.run("UPDATE chat_runs SET agent_mcp_tools=? WHERE id=?", [snapshot, runId]);
    await expect(
      ledger.get<{ agent_mcp_tools: string }>("SELECT agent_mcp_tools FROM chat_runs WHERE id=?", [runId])
    ).resolves.toEqual({ agent_mcp_tools: snapshot });

    // The last-line durable guards: invalid JSON and the aggregate ceiling
    // fail closed on any write path, including direct SQL.
    await expect(
      ledger.run("UPDATE chat_runs SET agent_mcp_tools=? WHERE id=?", ["{not json", runId])
    ).rejects.toMatchObject({ kind: "check" });
    await expect(
      ledger.run("UPDATE chat_runs SET agent_mcp_tools=? WHERE id=?", [`"${"x".repeat(524_289)}"`, runId])
    ).rejects.toMatchObject({ kind: "check" });

    // Account deletion cascades the run (and with it the snapshot) — no MCP
    // state survives in the ledger afterward.
    await ledger.run("DELETE FROM users WHERE id=?", [account]);
    await expect(ledger.get("SELECT 1 FROM chat_runs WHERE id=?", [runId])).resolves.toBeUndefined();
  });

  it("keeps migrations idempotent and rejects a newer on-disk schema", async () => {
    const resource = await temporaryLedger();
    const accountId = randomUUID();
    await resource.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      accountId,
      "persisted@example.test",
      "hash",
    ]);
    await resource.ledger.close();

    const reopened = await openSqliteLedger({ path: resource.filename });
    await expect(reopened.get("SELECT id FROM users WHERE id=?", [accountId])).resolves.toMatchObject({
      id: accountId,
    });
    await reopened.close();

    const future = new Database(resource.filename);
    future.pragma(`user_version = ${LATEST_SQLITE_SCHEMA_VERSION + 1}`);
    future.close();
    await expect(openSqliteLedger({ path: resource.filename })).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("ships exactly one immutable historical fixture for every schema version", async () => {
    // PENDING_MERGE_SCHEMA_VERSIONS is the single documented pre-merge gap
    // (v19 belongs to the parallel M14 branch). When that fixture merges and
    // the list empties, this assertion is contiguous again.
    await expect(listHistoricalFixtureVersions()).resolves.toEqual(expectedFixtureVersions());
  });

  // A pending-merge slot also blocks fixture-built starts above it: replaying
  // deltas 1..start would need the missing v019.sql. Those installations are
  // still covered by upgrading to the latest schema from every start version
  // below the gap, which steps over it through the real migration array.
  const firstPendingMergeSlot = PENDING_MERGE_SCHEMA_VERSIONS.length
    ? Math.min(...PENDING_MERGE_SCHEMA_VERSIONS)
    : Number.POSITIVE_INFINITY;
  for (const startVersion of expectedFixtureVersions().filter(
    (version) => version < LATEST_SQLITE_SCHEMA_VERSION && version < firstPendingMergeSlot
  )) {
    it(`upgrades a historical v${startVersion} installation to schema v${LATEST_SQLITE_SCHEMA_VERSION}`, async () => {
      const fixture = await createHistoricalSqliteFixture(startVersion);
      try {
        const legacyAcknowledgedAt = "2026-09-05T00:00:00.000Z";
        const onDisk = new Database(fixture.filename);
        try {
          expect(onDisk.pragma("user_version", { simple: true })).toBe(startVersion);
          if (startVersion >= 4) {
            // A pre-v14 installation may hold a timestamp-only acknowledgment.
            // The v14 upgrade must keep the timestamp and leave the new origin
            // NULL, which keeps the account unacknowledged for every origin.
            onDisk
              .prepare("UPDATE users SET remote_egress_ack_at=? WHERE id=?")
              .run(legacyAcknowledgedAt, fixture.seed.accountId);
          }
        } finally {
          onDisk.close();
        }

        const ledger = await openSqliteLedger({ path: fixture.filename });
        try {
          await expect(ledger.get<{ user_version: bigint }>("PRAGMA user_version")).resolves.toEqual({
            user_version: BigInt(LATEST_SQLITE_SCHEMA_VERSION),
          });

          const { seed } = fixture;
          await expect(
            ledger.get("SELECT id,email,password_hash FROM users WHERE id=?", [seed.accountId])
          ).resolves.toMatchObject({ id: seed.accountId, email: seed.email, password_hash: "fixture-hash" });
          await expect(
            ledger.get("SELECT id,name,status FROM sources WHERE id=? AND account_id=?", [
              seed.sourceId,
              seed.accountId,
            ])
          ).resolves.toMatchObject({ id: seed.sourceId, name: seed.sourceName, status: "ready" });
          await expect(
            ledger.get("SELECT id,title,model FROM chats WHERE id=? AND account_id=?", [seed.chatId, seed.accountId])
          ).resolves.toMatchObject({ id: seed.chatId, title: seed.chatTitle, model: seed.chatModel });
          await expect(
            ledger.get("SELECT id,chat_id,role,content FROM messages WHERE id=?", [seed.messageId])
          ).resolves.toMatchObject({
            id: BigInt(seed.messageId),
            chat_id: seed.chatId,
            role: "user",
            content: seed.messageContent,
          });
          await expect(
            ledger.get("SELECT id,chat_id,user_message_id,status FROM chat_runs WHERE id=? AND account_id=?", [
              seed.runId,
              seed.accountId,
            ])
          ).resolves.toMatchObject({
            id: seed.runId,
            chat_id: seed.chatId,
            user_message_id: BigInt(seed.messageId),
            status: "completed",
          });
          await expect(
            ledger.get("SELECT chat_id FROM chat_sources WHERE chat_id=? AND source_id=? AND account_id=?", [
              seed.chatId,
              seed.sourceId,
              seed.accountId,
            ])
          ).resolves.toMatchObject({ chat_id: seed.chatId });
          await expect(
            ledger.get("SELECT run_id FROM chat_run_sources WHERE run_id=? AND source_id=? AND account_id=?", [
              seed.runId,
              seed.sourceId,
              seed.accountId,
            ])
          ).resolves.toMatchObject({ run_id: seed.runId });

          await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);

          const tables = new Set(
            (await ledger.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map(
              (row) => row.name
            )
          );
          expect([...tables]).toEqual(
            expect.arrayContaining([
              "report_shares",
              "automations",
              "automation_runs",
              "connector_syncs",
              "agent_skills",
              "agent_skill_revisions",
              "connections",
              "connection_tool_snapshots",
            ])
          );
          // v18 saved-analysis tables survive upgrades from every historical
          // installation, and the v20 document tables plus the v21 template
          // catalog land through this branch's documented step over the
          // pending-merge v19 slot.
          expect([...tables]).toEqual(
            expect.arrayContaining([
              "analyses",
              "analysis_revisions",
              "analysis_sources",
              "analysis_runs",
              "analysis_run_sources",
              "analysis_results",
              "query_captures",
              "documents",
              "document_revisions",
              "document_publications",
              "document_publication_intents",
              "document_artifact_cleanup_jobs",
              "document_publication_cleanup_jobs",
              "document_templates",
              "document_rewrites",
            ])
          );
          // v19 living-knowledge tables survive upgrades from every
          // historical installation: connections, stable-identity items,
          // bounded previews, and durable refreshes.
          expect([...tables]).toEqual(
            expect.arrayContaining([
              "knowledge_connections",
              "knowledge_items",
              "knowledge_previews",
              "knowledge_preview_entries",
              "knowledge_refreshes",
              "knowledge_refresh_items",
            ])
          );
          expect(await columnNames(ledger, "users")).toEqual(
            expect.arrayContaining(["default_chat_model", "remote_egress_ack_origin"])
          );
          if (startVersion >= 4) {
            await expect(
              ledger.get<{ remote_egress_ack_at: string; remote_egress_ack_origin: null }>(
                "SELECT remote_egress_ack_at,remote_egress_ack_origin FROM users WHERE id=?",
                [fixture.seed.accountId]
              )
            ).resolves.toEqual({
              remote_egress_ack_at: legacyAcknowledgedAt,
              remote_egress_ack_origin: null,
            });
          }
          expect(await columnNames(ledger, "agents")).toContain("configuration");
          expect(await columnNames(ledger, "agent_revisions")).toContain("configuration");
          expect(await columnNames(ledger, "chat_runs")).toEqual(
            expect.arrayContaining(["agent_instructions", "agent_tools"])
          );
          // VIRTUAL generated columns stay invisible to table_info; the
          // generated target_id itself is proven readable in the dedicated
          // automation ownership tests below.
          expect(await columnNames(ledger, "automations")).toEqual(expect.arrayContaining(["connector_id", "chat_id"]));

          const indexes = new Set(
            (
              await ledger.all<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
              )
            ).map((row) => row.name)
          );
          expect([...indexes]).toEqual(
            expect.arrayContaining([
              "sources_account_catalog_idx",
              "connectors_account_catalog_idx",
              "libraries_account_catalog_idx",
              "agents_account_catalog_idx",
              "automations_account_catalog_idx",
              "reports_account_catalog_idx",
              "connections_account_catalog_idx",
              "documents_account_catalog_idx",
              "knowledge_connections_account_catalog_idx",
              "knowledge_items_connection_catalog_idx",
              "knowledge_previews_connection_catalog_idx",
              "knowledge_refreshes_one_active_uidx",
              "knowledge_refreshes_connection_history_idx",
              "knowledge_refresh_items_recovery_idx",
              "document_templates_account_catalog_idx",
              "document_rewrites_one_active_uidx",
              "document_rewrites_document_catalog_idx",
              "document_rewrites_claim_idx",
            ])
          );
          const recipientIndex = await ledger.get<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='report_shares_recipient_idx'"
          );
          expect(recipientIndex?.sql).toContain("report_id");
        } finally {
          await ledger.close();
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }

  it("rebuilds v14 automations onto owned kind-specific target columns", async () => {
    const fixture = await createHistoricalSqliteFixture(14);
    try {
      const account = fixture.seed.accountId;
      const foreignAccount = "99999999-9999-4999-8999-999999999999";
      const ownedConnector = "c0000000-0000-4000-8000-0000000000c1";
      const foreignConnector = "c0000000-0000-4000-8000-0000000000f1";

      const onDisk = new Database(fixture.filename);
      try {
        onDisk.pragma("foreign_keys = ON");
        onDisk.exec("BEGIN IMMEDIATE");
        try {
          onDisk
            .prepare("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)")
            .run(foreignAccount, "foreign@fixture.test", "hash");
          const connector = onDisk.prepare(
            "INSERT INTO connectors (id,account_id,name,type,target_table) VALUES (?,?,?,'url_csv',?)"
          );
          connector.run(ownedConnector, account, "Owned feed", "v15_owned");
          connector.run(foreignConnector, foreignAccount, "Foreign feed", "v15_foreign");
          const automation = onDisk.prepare(
            `INSERT INTO automations
               (id,account_id,name,kind,target_id,prompt,schedule_minutes,state,
                consecutive_failures,last_run_at,next_run_at,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          );
          const run = onDisk.prepare(
            `INSERT INTO automation_runs (automation_id,account_id,outcome,detail,started_at,finished_at)
             VALUES (?,?,?,?,?,?)`
          );
          // Legacy connector-schedule multiples for the same owned connector.
          // Insertion order (old, new, tie-b, tie-a) ensures the survivor is
          // decided by created_at DESC then id DESC alone — never by rowid:
          // tie-b shares its created_at with tie-a yet wins despite the older
          // rowid, and neither insertion end matches the winner.
          automation.run(
            "old",
            account,
            "legacy-old",
            "connector_sync",
            ownedConnector,
            null,
            30,
            "active",
            0,
            null,
            "2026-09-06T00:00:00.000Z",
            "2026-08-30T00:00:00.000Z",
            "2026-08-30T00:00:00.000Z"
          );
          run.run("old", account, "succeeded", "drop-old", "2026-08-30T01:00:00.000Z", "2026-08-30T01:01:00.000Z");
          automation.run(
            "new",
            account,
            "legacy-new",
            "connector_sync",
            ownedConnector,
            null,
            60,
            "active",
            0,
            null,
            "2026-09-06T00:00:00.000Z",
            "2026-08-31T00:00:00.000Z",
            "2026-08-31T00:00:00.000Z"
          );
          run.run("new", account, "succeeded", "drop-new", "2026-08-31T01:00:00.000Z", "2026-08-31T01:01:00.000Z");
          automation.run(
            "tie-b",
            account,
            "legacy-tie-b",
            "connector_sync",
            ownedConnector,
            "Nightly refresh",
            30,
            "paused",
            4,
            "2026-09-01T01:00:00.000Z",
            "2026-09-01T01:30:00.000Z",
            "2026-09-01T00:00:00.000Z",
            "2026-09-01T01:00:00.000Z"
          );
          run.run("tie-b", account, "failed", "kept-tie-b-1", "2026-09-01T01:00:00.000Z", "2026-09-01T01:01:00.000Z");
          run.run(
            "tie-b",
            account,
            "succeeded",
            "kept-tie-b-2",
            "2026-09-01T02:00:00.000Z",
            "2026-09-01T02:01:00.000Z"
          );
          automation.run(
            "tie-a",
            account,
            "legacy-tie-a",
            "connector_sync",
            ownedConnector,
            null,
            45,
            "active",
            0,
            null,
            "2026-09-06T00:00:00.000Z",
            "2026-09-01T00:00:00.000Z",
            "2026-09-01T00:00:00.000Z"
          );
          run.run("tie-a", account, "succeeded", "drop-tie-a", "2026-09-01T03:00:00.000Z", "2026-09-01T03:01:00.000Z");
          // Valid agent-turn automation on the seeded fixture chat plus runs.
          automation.run(
            "agent-ok",
            account,
            "agent-ok",
            "agent_turn",
            fixture.seed.chatId,
            "Summarize the week",
            15,
            "active",
            1,
            null,
            "2026-09-06T00:00:00.000Z",
            "2026-08-29T00:00:00.000Z",
            "2026-08-29T00:00:00.000Z"
          );
          run.run("agent-ok", account, "skipped", "kept-agent", "2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z");
          // Discarded legacy rows and their history.
          automation.run(
            "dangling-conn",
            account,
            "legacy-dangling-conn",
            "connector_sync",
            "missing-connector",
            null,
            60,
            "active",
            0,
            null,
            "2026-09-06T00:00:00.000Z",
            "2026-08-28T00:00:00.000Z",
            "2026-08-28T00:00:00.000Z"
          );
          run.run("dangling-conn", account, "failed", "drop-dangling", "2026-08-28T01:00:00.000Z", null);
          automation.run(
            "xacct-conn",
            account,
            "legacy-xacct-conn",
            "connector_sync",
            foreignConnector,
            null,
            60,
            "active",
            0,
            null,
            "2026-09-06T00:00:00.000Z",
            "2026-08-27T00:00:00.000Z",
            "2026-08-27T00:00:00.000Z"
          );
          run.run("xacct-conn", account, "failed", "drop-xacct", "2026-08-27T01:00:00.000Z", null);
          automation.run(
            "dangling-agent",
            account,
            "legacy-dangling-agent",
            "agent_turn",
            "missing-chat",
            "Prompt",
            15,
            "paused",
            5,
            null,
            "2026-09-06T00:00:00.000Z",
            "2026-08-26T00:00:00.000Z",
            "2026-08-26T00:00:00.000Z"
          );
          run.run("dangling-agent", account, "failed", "drop-dangling-agent", "2026-08-26T01:00:00.000Z", null);
          // A run recorded under an account other than its parent's account.
          run.run("agent-ok", foreignAccount, "failed", "drop-run-account", "2026-08-29T02:00:00.000Z", null);
          onDisk.exec("COMMIT");
        } catch (error) {
          onDisk.exec("ROLLBACK");
          throw error;
        }
      } finally {
        onDisk.close();
      }

      const ledger = await openSqliteLedger({ path: fixture.filename });
      try {
        await expect(ledger.get<{ user_version: bigint }>("PRAGMA user_version")).resolves.toEqual({
          user_version: BigInt(LATEST_SQLITE_SCHEMA_VERSION),
        });

        await expect(
          ledger.all<{ id: string; target_id: string; connector_id: string | null; chat_id: string | null }>(
            "SELECT id,target_id,connector_id,chat_id FROM automations ORDER BY id"
          )
        ).resolves.toEqual([
          { id: "agent-ok", target_id: fixture.seed.chatId, connector_id: null, chat_id: fixture.seed.chatId },
          { id: "tie-b", target_id: ownedConnector, connector_id: ownedConnector, chat_id: null },
        ]);

        // The created_at DESC,id DESC survivor keeps every state field.
        await expect(
          ledger.get<Record<string, string | number | bigint | null>>(
            `SELECT name,prompt,schedule_minutes,state,consecutive_failures,last_run_at,next_run_at,created_at,updated_at
             FROM automations WHERE id='tie-b'`
          )
        ).resolves.toEqual({
          name: "legacy-tie-b",
          prompt: "Nightly refresh",
          schedule_minutes: 30n,
          state: "paused",
          consecutive_failures: 4n,
          last_run_at: "2026-09-01T01:00:00.000Z",
          next_run_at: "2026-09-01T01:30:00.000Z",
          created_at: "2026-09-01T00:00:00.000Z",
          updated_at: "2026-09-01T01:00:00.000Z",
        });

        // Only the survivor's and the valid agent automation's history is
        // retained; losing duplicates, dangling/cross-account parents, and the
        // account-mismatched run are all dropped.
        await expect(
          ledger.all<{ detail: string }>("SELECT detail FROM automation_runs ORDER BY detail")
        ).resolves.toEqual([{ detail: "kept-agent" }, { detail: "kept-tie-b-1" }, { detail: "kept-tie-b-2" }]);

        const indexes = new Set(
          (
            await ledger.all<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
            )
          ).map((row) => row.name)
        );
        expect([...indexes]).toEqual(
          expect.arrayContaining([
            "automations_account_catalog_idx",
            "automations_connector_target_uidx",
            "automation_runs_automation_idx",
          ])
        );
        // The public target_id is the generated projection, not a stored copy.
        const generatedColumns = (
          await ledger.all<{ name: string; hidden: bigint }>("PRAGMA table_xinfo(automations)")
        ).filter((column) => Number(column.hidden) !== 0);
        expect(generatedColumns.map((column) => column.name)).toEqual(["target_id"]);
        await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
      } finally {
        await ledger.close();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("makes automation target ownership a database invariant", async () => {
    const { ledger } = await temporaryLedger();
    const owner = randomUUID();
    const foreign = randomUUID();
    await insertUser(ledger, owner, "automation-owner@example.test");
    await insertUser(ledger, foreign, "automation-foreign@example.test");
    const connectorOne = randomUUID();
    const connectorTwo = randomUUID();
    const foreignConnector = randomUUID();
    for (const [id, account, table] of [
      [connectorOne, owner, "own1"],
      [connectorTwo, owner, "own2"],
      [foreignConnector, foreign, "foreign1"],
    ] as const) {
      await ledger.run("INSERT INTO connectors (id,account_id,name,type,target_table) VALUES (?,?,?,'url_csv',?)", [
        id,
        account,
        `Feed ${table}`,
        table,
      ]);
    }
    const chatOne = randomUUID();
    const chatTwo = randomUUID();
    const foreignChat = randomUUID();
    for (const [id, account, title] of [
      [chatOne, owner, "Chat one"],
      [chatTwo, owner, "Chat two"],
      [foreignChat, foreign, "Foreign chat"],
    ] as const) {
      await ledger.run("INSERT INTO chats (id,account_id,title,model) VALUES (?,?,?,'chat-model')", [
        id,
        account,
        title,
      ]);
    }
    const insertAutomation = (
      id: string,
      account: string,
      name: string,
      kind: string,
      connectorId: string | null,
      chatId: string | null
    ) =>
      ledger.run(
        `INSERT INTO automations (id,account_id,name,kind,connector_id,chat_id,schedule_minutes,next_run_at)
         VALUES (?,?,?,?,?,?,60,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        [id, account, name, kind, connectorId, chatId]
      );

    await insertAutomation("auto-conn-1", owner, "Owned sync", "connector_sync", connectorOne, null);
    await expect(
      ledger.get<{ target_id: string | null }>("SELECT target_id FROM automations WHERE id='auto-conn-1'")
    ).resolves.toEqual({ target_id: connectorOne });

    // The generated public projection is never directly writable.
    await expect(
      ledger.run(
        `INSERT INTO automations (id,account_id,name,kind,target_id,schedule_minutes,next_run_at)
         VALUES (?,?,?,?,?,60,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        ["auto-gen", owner, "Generated", "connector_sync", connectorTwo]
      )
    ).rejects.toThrow(/generated column/);

    // A CHECK ties each kind to exactly one canonical target column.
    await expect(insertAutomation("auto-bad-a", owner, "Bad a", "connector_sync", null, chatOne)).rejects.toMatchObject(
      {
        kind: "check",
      }
    );
    await expect(
      insertAutomation("auto-bad-b", owner, "Bad b", "agent_turn", connectorOne, null)
    ).rejects.toMatchObject({
      kind: "check",
    });
    await expect(
      insertAutomation("auto-bad-c", owner, "Bad c", "connector_sync", connectorOne, chatOne)
    ).rejects.toMatchObject({ kind: "check" });
    await expect(insertAutomation("auto-bad-d", owner, "Bad d", "agent_turn", null, null)).rejects.toMatchObject({
      kind: "check",
    });

    // Composite foreign keys demand a same-account target that exists.
    await expect(
      insertAutomation("auto-x-1", foreign, "Cross sync", "connector_sync", connectorOne, null)
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      insertAutomation("auto-x-2", foreign, "Cross digest", "agent_turn", null, chatOne)
    ).rejects.toMatchObject({
      kind: "foreign_key",
    });
    await expect(
      insertAutomation("auto-x-3", owner, "Cross digest", "agent_turn", null, foreignChat)
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      insertAutomation("auto-x-4", owner, "Missing sync", "connector_sync", "missing-connector", null)
    ).rejects.toMatchObject({ kind: "foreign_key" });

    // The partial unique index keeps at most one schedule per connector...
    await insertAutomation("auto-conn-2", owner, "Second name", "connector_sync", connectorTwo, null);
    await expect(
      insertAutomation("auto-conn-3", owner, "Third name", "connector_sync", connectorOne, null)
    ).rejects.toMatchObject({ kind: "unique" });
    // ...while multiple agent turns may target the same owned chat.
    await insertAutomation("auto-agent-1", owner, "Digest one", "agent_turn", null, chatOne);
    await insertAutomation("auto-agent-2", owner, "Digest two", "agent_turn", null, chatOne);
    await insertAutomation("auto-agent-3", owner, "Digest three", "agent_turn", null, chatTwo);

    // Run history cannot carry an account different from its parent's.
    await ledger.run(
      "INSERT INTO automation_runs (automation_id,account_id,outcome) VALUES ('auto-conn-1',?,'succeeded')",
      [owner]
    );
    await expect(
      ledger.run(
        "INSERT INTO automation_runs (automation_id,account_id,outcome) VALUES ('auto-conn-1',?,'succeeded')",
        [foreign]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      ledger.run("INSERT INTO automation_runs (automation_id,account_id,outcome) VALUES ('missing',?,'succeeded')", [
        owner,
      ])
    ).rejects.toMatchObject({ kind: "foreign_key" });

    // Connector deletion cascades exactly the bound automation and its runs.
    await ledger.run("DELETE FROM connectors WHERE id=? AND account_id=?", [connectorOne, owner]);
    await expect(ledger.get("SELECT 1 FROM automations WHERE id='auto-conn-1'")).resolves.toBeUndefined();
    await expect(ledger.all("SELECT 1 FROM automation_runs WHERE automation_id='auto-conn-1'")).resolves.toEqual([]);
    await expect(ledger.get("SELECT 1 FROM automations WHERE id='auto-conn-2'")).resolves.toEqual({ "1": 1n });
    await expect(ledger.get("SELECT 1 FROM automations WHERE id='auto-agent-1'")).resolves.toEqual({ "1": 1n });

    // Chat deletion cascades exactly its bound agent-turn automations.
    await ledger.run("DELETE FROM chats WHERE id=? AND account_id=?", [chatOne, owner]);
    await expect(ledger.get("SELECT 1 FROM automations WHERE id='auto-agent-1'")).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM automations WHERE id='auto-agent-2'")).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM automations WHERE id='auto-agent-3'")).resolves.toEqual({ "1": 1n });
    await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("enforces composite tenancy, active-run uniqueness, and connector delete reservations", async () => {
    const { ledger } = await temporaryLedger();
    const owner = randomUUID();
    const foreign = randomUUID();
    await insertUser(ledger, owner, "owner@example.test");
    await insertUser(ledger, foreign, "foreign@example.test");
    const connectorId = randomUUID();
    await ledger.run("INSERT INTO connectors (id,account_id,name,type,config,target_table) VALUES (?,?,?,?,?,?)", [
      connectorId,
      owner,
      "Ledger feed",
      "url_csv",
      encodeJson({ url: "https://example.test/data.csv" }),
      "ledger",
    ]);
    const source = randomUUID();
    const foreignSource = randomUUID();
    await insertSource(ledger, owner, source, "ledger", connectorId);
    await insertSource(ledger, foreign, foreignSource, "foreign");
    const chat = randomUUID();
    await ledger.run("INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,?,?)", [
      chat,
      owner,
      "Test chat",
      "chat-model",
      "selected",
    ]);
    const foreignChat = randomUUID();
    await ledger.run("INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,?,?)", [
      foreignChat,
      foreign,
      "Foreign chat",
      "chat-model",
      "selected",
    ]);
    const ownerOtherChat = randomUUID();
    await ledger.run("INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,?,?)", [
      ownerOtherChat,
      owner,
      "Other owner chat",
      "chat-model",
      "selected",
    ]);

    await expect(
      ledger.run("INSERT INTO chat_sources (chat_id,source_id,account_id) VALUES (?,?,?)", [chat, foreignSource, owner])
    ).rejects.toMatchObject({ kind: "foreign_key" });

    const message = await ledger.run("INSERT INTO messages (chat_id,role,content,meta) VALUES (?,'user',?,?)", [
      chat,
      "hello",
      encodeJson({ source_ids: [source] }),
    ]);
    const firstRun = randomUUID();
    await ledger.run(
      "INSERT INTO chat_runs (id,account_id,chat_id,user_message_id,status) VALUES (?,?,?,?, 'running')",
      [firstRun, owner, chat, message.lastInsertRowid]
    );
    await ledger.run("INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)", [
      firstRun,
      source,
      owner,
    ]);
    await expect(
      ledger.run("INSERT INTO chat_runs (id,account_id,chat_id,status) VALUES (?,?,?,'running')", [
        randomUUID(),
        owner,
        chat,
      ])
    ).rejects.toMatchObject({ kind: "unique" });

    await expect(
      ledger.run(
        `INSERT INTO charts (id,account_id,run_id,status,spec,echarts)
         VALUES (?,?,?,'pending','{}','{}')`,
        [randomUUID(), foreign, firstRun]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      ledger.run(
        `INSERT INTO reports (id,account_id,chat_id,run_id,status,title,html_path,pdf_path)
         VALUES (?,?,?,?,'pending',?,?,?)`,
        [randomUUID(), foreign, foreignChat, firstRun, "Wrong run tenant", "/safe/a.html", "/safe/a.pdf"]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      ledger.run(
        `INSERT INTO reports (id,account_id,chat_id,run_id,status,title,html_path,pdf_path)
         VALUES (?,?,?,?,'pending',?,?,?)`,
        [randomUUID(), owner, foreignChat, firstRun, "Wrong chat tenant", "/safe/b.html", "/safe/b.pdf"]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      ledger.run(
        `INSERT INTO reports (id,account_id,chat_id,run_id,status,title,html_path,pdf_path)
         VALUES (?,?,?,?,'pending',?,?,?)`,
        [randomUUID(), owner, ownerOtherChat, firstRun, "Wrong run chat", "/safe/c.html", "/safe/c.pdf"]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });

    const guardedChart = randomUUID();
    await ledger.run(
      `INSERT INTO charts (id,account_id,run_id,status,spec,echarts)
       VALUES (?,?,?,'pending','{}','{}')`,
      [guardedChart, owner, firstRun]
    );
    await ledger.run("UPDATE charts SET status='published',run_id=NULL WHERE id=?", [guardedChart]);
    await expect(
      ledger.run("UPDATE charts SET account_id=? WHERE id=?", [foreign, guardedChart])
    ).rejects.toMatchObject({ kind: "foreign_key" });

    const publishedReport = randomUUID();
    await ledger.run(
      `INSERT INTO reports (id,account_id,chat_id,status,title,html_path,pdf_path)
       VALUES (?,?,?,'published',?,?,?)`,
      [publishedReport, owner, chat, "Published", "/safe/published.html", "/safe/published.pdf"]
    );
    await expect(
      ledger.run("UPDATE reports SET account_id=? WHERE id=?", [foreign, publishedReport])
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(
      ledger.run("UPDATE reports SET id=? WHERE id=?", [randomUUID(), publishedReport])
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await ledger.run("DELETE FROM reports WHERE id=?", [publishedReport]);
    await expect(
      ledger.get<{ account_id: string; html_path: string }>(
        "SELECT account_id,html_path FROM report_artifact_cleanup_jobs WHERE report_id=?",
        [publishedReport]
      )
    ).resolves.toEqual({ account_id: owner, html_path: "/safe/published.html" });
    await expect(
      ledger.run(
        `INSERT INTO reports (id,account_id,chat_id,status,title,html_path,pdf_path)
         VALUES (?,?,?,'published',?,?,?)`,
        [publishedReport, owner, chat, "Reused too soon", "/safe/new.html", "/safe/new.pdf"]
      )
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);

    await expect(
      ledger.run("DELETE FROM connectors WHERE id=? AND account_id=?", [connectorId, owner])
    ).rejects.toMatchObject({ kind: "foreign_key" });
    await expect(ledger.get("SELECT id FROM sources WHERE id=?", [source])).resolves.toMatchObject({ id: source });
  });

  it("persists ready/staging generations and durable cleanup intents without vectors", async () => {
    const { ledger } = await temporaryLedger();
    const account = randomUUID();
    const source = randomUUID();
    const liveChunk = randomUUID();
    const stagedChunk = randomUUID();
    await insertUser(ledger, account, "generation@example.test");
    await insertSource(ledger, account, source, "generation");
    await ledger.run("UPDATE sources SET ready_generation=? WHERE id=? AND account_id=?", [3, source, account]);
    await ledger.run(
      "INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta) VALUES (?,?,?,?,?,?,?,?)",
      [liveChunk, account, source, 3, 0, "Generation", "live", encodeJson({ kind: "document" })]
    );
    await ledger.run(
      "INSERT INTO ingestion_chunk_staging (chunk_id,source_id,generation,seq,account_id,source_name,content,meta) VALUES (?,?,?,?,?,?,?,?)",
      [stagedChunk, source, 4, 0, account, "Generation", "staged", encodeJson({ kind: "document" })]
    );
    await ledger.run("INSERT INTO pending_vector_ops (source_id,account_id,operation,generation) VALUES (?,?,?,?)", [
      source,
      account,
      "delete_generation",
      4,
    ]);
    await ledger.run(
      "INSERT INTO pending_source_deletes (source_id,account_id,name,file_path,dataset_locations) VALUES (?,?,?,?,?)",
      [source, account, "generation", "/proven/path", encodeJson(["/proven/path"])]
    );

    await ledger.run("DELETE FROM sources WHERE id=? AND account_id=?", [source, account]);
    await expect(
      ledger.get("SELECT source_id FROM pending_source_deletes WHERE source_id=?", [source])
    ).resolves.toEqual({
      source_id: source,
    });
    await expect(ledger.get("SELECT source_id FROM pending_vector_ops WHERE source_id=?", [source])).resolves.toEqual({
      source_id: source,
    });
    await expect(ledger.get("SELECT id FROM chunks WHERE id=?", [liveChunk])).resolves.toBeUndefined();
    await expect(
      ledger.get("SELECT chunk_id FROM ingestion_chunk_staging WHERE chunk_id=?", [stagedChunk])
    ).resolves.toBeUndefined();
  });

  it("serializes async immediate transactions across connections and rolls back failures", async () => {
    const resource = await temporaryLedger();
    const aliasDirectory = path.join(resource.directory, "alias");
    await fs.symlink(resource.directory, aliasDirectory, "dir");
    const second = await openSqliteLedger({ path: path.join(aliasDirectory, "ledger.sqlite") });
    expect(second.path).toBe(resource.ledger.path);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const account = randomUUID();
    const transaction = resource.ledger.withImmediateTransaction(async (tx) => {
      tx.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [account, "held@example.test", "hash"]);
      enter();
      await held;
    });
    await entered;

    let readSettled = false;
    const blockedRead = second.get("SELECT id FROM users WHERE id=?", [account]).finally(() => {
      readSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readSettled).toBe(false);
    release();
    await transaction;
    await expect(blockedRead).resolves.toEqual({ id: account });

    await expect(
      resource.ledger.withImmediateTransaction(async (tx) => {
        tx.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
          randomUUID(),
          "rolled-back@example.test",
          "hash",
        ]);
        await Promise.resolve();
        throw new Error("rollback canary");
      })
    ).rejects.toThrow("rollback canary");
    await expect(
      resource.ledger.get("SELECT id FROM users WHERE email='rolled-back@example.test'")
    ).resolves.toBeUndefined();

    await expect(
      resource.ledger.withImmediateTransaction(async () => resource.ledger.get("SELECT 1"))
    ).rejects.toBeInstanceOf(SqliteTransactionUsageError);
    await second.close();
  });

  describe("schema v16 connector-refresh protocol state", () => {
    const ts = "2026-09-01T00:00:00.000Z";

    interface LegacySource {
      id: string;
      connectorId: string;
      table: string;
      status: "ready" | "index" | "error";
      filePath?: string | null;
      readyGeneration?: number | null;
      meta: Record<string, unknown>;
      job?: { generation: number; status: string };
    }

    function seedLegacy(
      database: Database.Database,
      account: string,
      sources: readonly LegacySource[],
      extraConnectors: readonly { id: string; table: string }[] = []
    ): void {
      const connector = database.prepare(
        `INSERT INTO connectors (id,account_id,name,type,config,target_table,sync_status)
         VALUES (?,?,?,'url_csv','{}',?,'idle')`
      );
      for (const spec of extraConnectors) connector.run(spec.id, account, `Feed ${spec.table}`, spec.table);
      for (const spec of sources) {
        connector.run(spec.connectorId, account, `Feed ${spec.table}`, spec.table);
        database
          .prepare(
            `INSERT INTO sources (id,account_id,name,kind,connector,display_name,file_path,status,meta,ready_generation)
             VALUES (?,?,?,'tabular',?,?,?,?,?,?)`
          )
          .run(
            spec.id,
            account,
            spec.table,
            spec.connectorId,
            `Feed ${spec.table}`,
            spec.filePath ?? null,
            spec.status,
            JSON.stringify(spec.meta),
            spec.readyGeneration ?? null
          );
        if (spec.job) {
          database
            .prepare(
              `INSERT INTO ingestion_jobs
                 (source_id,account_id,generation,status,attempts,available_at,created_at,updated_at)
               VALUES (?,?,?,?,1,?,?,?)`
            )
            .run(spec.id, account, spec.job.generation, spec.job.status, ts, ts, ts);
        }
      }
    }

    it("migrates valid v15 protocol metadata into typed rows and strips only the protocol keys", async () => {
      const fixture = await createHistoricalSqliteFixture(15);
      try {
        const account = fixture.seed.accountId;
        const onDisk = new Database(fixture.filename);
        try {
          onDisk.pragma("foreign_keys = ON");
          onDisk.exec("BEGIN IMMEDIATE");
          seedLegacy(onDisk, account, [
            {
              id: "a1000000-0000-4000-8000-000000000001",
              connectorId: "b1000000-0000-4000-8000-000000000001",
              table: "feed_a",
              status: "index",
              meta: {
                connector_refresh_version: "ver-a",
                error: "boom",
                error_code: "X",
                error_detail: "detail",
                error_stage: "prepare",
                display: { label: "keep me" },
              },
              job: { generation: 1, status: "preparing" },
            },
            {
              id: "a1000000-0000-4000-8000-000000000002",
              connectorId: "b1000000-0000-4000-8000-000000000002",
              table: "feed_b",
              status: "index",
              filePath: "/cache/live.csv",
              readyGeneration: 1,
              meta: {
                connector_refresh_version: "ver-b",
                connector_candidate_location: "/cache/candidate.csv",
                // An explicit JSON null activation-previous is the
                // "no current location" case and migrates as SQL NULL.
                connector_activation_previous_location: null,
                connector_previous_location: "/cache/old.csv",
                note: "keep",
              },
              job: { generation: 2, status: "pending" },
            },
            {
              id: "a1000000-0000-4000-8000-000000000003",
              connectorId: "b1000000-0000-4000-8000-000000000003",
              table: "feed_c",
              status: "ready",
              filePath: "/cache/active.csv",
              readyGeneration: 3,
              meta: { connector_previous_location: "/cache/retired.csv" },
              job: { generation: 3, status: "done" },
            },
            {
              id: "a1000000-0000-4000-8000-000000000004",
              connectorId: "b1000000-0000-4000-8000-000000000004",
              table: "feed_d",
              status: "ready",
              filePath: "/cache/plain.csv",
              readyGeneration: 1,
              meta: { keep: true },
              job: { generation: 1, status: "done" },
            },
          ]);
          onDisk.exec("COMMIT");
        } finally {
          onDisk.close();
        }

        const ledger = await openSqliteLedger({ path: fixture.filename });
        try {
          await expect(ledger.get<{ user_version: bigint }>("PRAGMA user_version")).resolves.toEqual({
            user_version: BigInt(LATEST_SQLITE_SCHEMA_VERSION),
          });
          // v16 protocol state is proven to survive upgrade into the exact
          // current latest schema (v17 connections, v18 analyses, v19 knowledge, the
          // v20 document tables, the v21 frozen MCP run-snapshot column, the v22
          // template catalog, and the v23 document-rewrite ledger ride on top).
          expect(LATEST_SQLITE_SCHEMA_VERSION).toBe(23);

          const rows = await ledger.all<Record<string, unknown>>(
            `SELECT source_id,phase,generation,refresh_version,candidate_location,
                    activation_previous_location,cleanup_previous_location,attempts,repair_ordinal
             FROM connector_refresh_states ORDER BY repair_ordinal`
          );
          expect(rows).toEqual([
            {
              source_id: "a1000000-0000-4000-8000-000000000001",
              phase: "preparing",
              generation: 1n,
              refresh_version: "ver-a",
              candidate_location: null,
              activation_previous_location: null,
              cleanup_previous_location: null,
              attempts: 0n,
              repair_ordinal: 1n,
            },
            {
              source_id: "a1000000-0000-4000-8000-000000000002",
              // A version plus candidate migrates to the ambiguous
              // `activating` phase, never `prepared`.
              phase: "activating",
              generation: 2n,
              refresh_version: "ver-b",
              candidate_location: "/cache/candidate.csv",
              activation_previous_location: null,
              cleanup_previous_location: "/cache/old.csv",
              attempts: 0n,
              repair_ordinal: 2n,
            },
            {
              source_id: "a1000000-0000-4000-8000-000000000003",
              phase: "cleanup_pending",
              generation: 3n,
              // The cleanup-only identity is deterministic and cleanup-only.
              refresh_version: "legacy:a1000000-0000-4000-8000-000000000003",
              candidate_location: "/cache/active.csv",
              activation_previous_location: null,
              cleanup_previous_location: "/cache/retired.csv",
              attempts: 0n,
              repair_ordinal: 3n,
            },
          ]);

          // Only the four protocol keys are stripped; every other key —
          // especially the error/display metadata — survives at the decoded
          // object level.
          await expect(
            ledger.get<{ meta: string }>(`SELECT meta FROM sources WHERE id='a1000000-0000-4000-8000-000000000001'`)
          ).resolves.toEqual({
            meta: JSON.stringify({
              error: "boom",
              error_code: "X",
              error_detail: "detail",
              error_stage: "prepare",
              display: { label: "keep me" },
            }),
          });
          await expect(
            ledger.get<{ meta: string }>(`SELECT meta FROM sources WHERE id='a1000000-0000-4000-8000-000000000002'`)
          ).resolves.toEqual({ meta: '{"note":"keep"}' });
          await expect(
            ledger.get<{ meta: string }>(`SELECT meta FROM sources WHERE id='a1000000-0000-4000-8000-000000000004'`)
          ).resolves.toEqual({ meta: '{"keep":true}' });

          await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);

          // Migration is idempotent: reopening never re-backfills or rewrites.
          await ledger.close();
          const reopened = await openSqliteLedger({ path: fixture.filename });
          try {
            await expect(
              reopened.all<{ count: bigint }>(`SELECT COUNT(*) AS count FROM connector_refresh_states`)
            ).resolves.toEqual([{ count: 3n }]);
            await expect(
              reopened.all<{ source_id: string }>(`SELECT source_id FROM connector_refresh_states ORDER BY source_id`)
            ).resolves.toEqual([
              { source_id: "a1000000-0000-4000-8000-000000000001" },
              { source_id: "a1000000-0000-4000-8000-000000000002" },
              { source_id: "a1000000-0000-4000-8000-000000000003" },
            ]);
          } finally {
            await reopened.close();
          }
        } catch (error) {
          await ledger.close().catch(() => undefined);
          throw error;
        }
      } finally {
        await fixture.cleanup();
      }
    });

    for (const [label, meta, jobStatus] of [
      ["a candidate without a version", { connector_candidate_location: "/c.csv" }, "preparing"],
      ["a version with no preparing job", { connector_refresh_version: "v" }, "done"],
      ["a non-text version", { connector_refresh_version: 42 }, "preparing"],
      [
        "a version with a cleanup key but no candidate",
        { connector_refresh_version: "v", connector_previous_location: "/x.csv" },
        "preparing",
      ],
      ["a cleanup-only marker on a non-ready source", { connector_previous_location: "/x.csv" }, "done"],
      ["a cleanup marker equal to the live file", { connector_previous_location: "/live.csv" }, "done"],
      [
        "a candidate equal to the cleanup location",
        {
          connector_refresh_version: "v",
          connector_candidate_location: "/same.csv",
          connector_previous_location: "/same.csv",
        },
        "pending",
      ],
    ] as const) {
      it(`rolls the v16 migration back to v15 for malformed legacy state: ${label}`, async () => {
        const fixture = await createHistoricalSqliteFixture(15);
        try {
          const onDisk = new Database(fixture.filename);
          try {
            onDisk.pragma("foreign_keys = ON");
            seedLegacy(onDisk, fixture.seed.accountId, [
              {
                id: "a2000000-0000-4000-8000-000000000001",
                connectorId: "b2000000-0000-4000-8000-000000000001",
                table: "malformed",
                status: label.includes("non-ready") ? "index" : "ready",
                filePath: "/live.csv",
                readyGeneration: 2,
                meta: { ...meta },
                job: { generation: 2, status: jobStatus },
              },
            ]);
          } finally {
            onDisk.close();
          }
          await expect(openSqliteLedger({ path: fixture.filename })).rejects.toBeInstanceOf(SqliteMigrationError);

          const after = new Database(fixture.filename);
          try {
            expect(after.pragma("user_version", { simple: true })).toBe(15);
            expect(
              (
                after
                  .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name='connector_refresh_states'`)
                  .get() as {
                  c: number;
                }
              ).c
            ).toBe(0);
            expect(
              (
                after
                  .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name='sources_id_connector_account_uidx'`)
                  .get() as {
                  c: number;
                }
              ).c
            ).toBe(0);
            expect(
              after.prepare(`SELECT meta FROM sources WHERE id='a2000000-0000-4000-8000-000000000001'`).get()
            ).toEqual({ meta: JSON.stringify({ ...meta }) });
          } finally {
            after.close();
          }
        } finally {
          await fixture.cleanup();
        }
      });
    }

    it("enforces three-column pairing and proves the four v16 repair indexes serve their selectors", async () => {
      const fixture = await createHistoricalSqliteFixture(15);
      try {
        const onDisk = new Database(fixture.filename);
        try {
          onDisk.pragma("foreign_keys = ON");
          seedLegacy(
            onDisk,
            fixture.seed.accountId,
            [
              {
                id: "a3000000-0000-4000-8000-000000000001",
                connectorId: "b3000000-0000-4000-8000-000000000001",
                table: "pair_a",
                status: "ready",
                filePath: "/cache/a.csv",
                readyGeneration: 1,
                meta: {},
                job: { generation: 1, status: "done" },
              },
              {
                id: "a3000000-0000-4000-8000-000000000002",
                connectorId: "b3000000-0000-4000-8000-000000000002",
                table: "pair_b",
                status: "ready",
                filePath: "/cache/b.csv",
                readyGeneration: 1,
                meta: {},
                job: { generation: 1, status: "done" },
              },
            ],
            []
          );
        } finally {
          onDisk.close();
        }
        const ledger = await openSqliteLedger({ path: fixture.filename });
        try {
          // Direct SQL may never pair a source with another connector of the
          // same account — in either direction.
          await expect(
            ledger.run(
              `INSERT INTO connector_refresh_states
                 (source_id,account_id,connector_id,generation,refresh_version,phase,candidate_location)
               VALUES (?,?,?,1,'x','activating','/c')`,
              ["a3000000-0000-4000-8000-000000000001", fixture.seed.accountId, "b3000000-0000-4000-8000-000000000002"]
            )
          ).rejects.toMatchObject({ kind: "foreign_key" });
          await expect(
            ledger.run(
              `INSERT INTO connector_refresh_states
                 (source_id,account_id,connector_id,generation,refresh_version,phase,candidate_location)
               VALUES (?,?,?,1,'x','activating','/c')`,
              ["a3000000-0000-4000-8000-000000000002", fixture.seed.accountId, "b3000000-0000-4000-8000-000000000001"]
            )
          ).rejects.toMatchObject({ kind: "foreign_key" });
          // The matching pairing succeeds.
          await expect(
            ledger.run(
              `INSERT INTO connector_refresh_states
                 (source_id,account_id,connector_id,generation,refresh_version,phase,candidate_location)
               VALUES (?,?,?,1,'x','activating','/c')`,
              ["a3000000-0000-4000-8000-000000000002", fixture.seed.accountId, "b3000000-0000-4000-8000-000000000002"]
            )
          ).resolves.toMatchObject({ changes: 1 });

          const indexes = new Set(
            (
              await ledger.all<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
              )
            ).map((row) => row.name)
          );
          expect([...indexes]).toEqual(
            expect.arrayContaining([
              "sources_id_connector_account_uidx",
              "connector_refresh_states_repair_idx",
              "pending_source_deletes_periodic_idx",
              "pending_vector_ops_periodic_idx",
              "dataset_cache_cleanup_jobs_periodic_idx",
            ])
          );

          const plans: Array<[string, string, string, readonly (string | number | null)[]]> = [
            [
              "connector refresh",
              "connector_refresh_states_repair_idx",
              `SELECT * FROM connector_refresh_states ORDER BY attempts, updated_at, source_id LIMIT ?`,
              [20],
            ],
            [
              "pending source deletes",
              "pending_source_deletes_periodic_idx",
              `SELECT source_id, account_id, name, file_path, connector_id, dataset_locations,
                      attempts, last_error, created_at, updated_at
               FROM pending_source_deletes ORDER BY attempts, updated_at, account_id, source_id LIMIT ?`,
              [100],
            ],
            [
              "pending vector operations",
              "pending_vector_ops_periodic_idx",
              `SELECT source_id, account_id, operation, generation, attempts
               FROM pending_vector_ops ORDER BY attempts, updated_at, source_id, operation, generation LIMIT ?`,
              [100],
            ],
            [
              "dataset cache cleanup",
              "dataset_cache_cleanup_jobs_periodic_idx",
              `SELECT account_id,name,location,attempts FROM dataset_cache_cleanup_jobs
               WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR name=?)
               ORDER BY attempts, updated_at, account_id, name, location LIMIT ?`,
              [null, null, null, null, 20],
            ],
          ];
          for (const [label, indexName, sql, params] of plans) {
            const plan = await ledger.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
            const text = plan.map((row) => row.detail).join(" | ");
            expect(text, label).toContain(indexName);
            expect(text, label).not.toContain("TEMP B-TREE");
          }
          await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
        } finally {
          await ledger.close();
        }
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("normalizes JSON, booleans, timestamps, safe integers, and invalid bind values", () => {
    expect(encodeBoolean(true)).toBe(1);
    expect(decodeBoolean(0n)).toBe(false);
    expect(decodeJson(encodeJson({ answer: 42 }))).toEqual({ answer: 42 });
    expect(encodeIsoTimestamp("2026-08-26T10:20:30+02:00")).toBe("2026-08-26T08:20:30.000Z");
    expect(decodeSafeInteger(42n)).toBe(42);
    expect(encodeSafeInteger(2n ** 63n - 1n)).toBe(2n ** 63n - 1n);
    expect(() => decodeBoolean(2)).toThrow(SqliteCodecError);
    expect(() => decodeJson("{")).toThrow(SqliteCodecError);
    expect(() => encodeSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow(SqliteCodecError);
    expect(() => decodeSafeInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(SqliteCodecError);
    expect(() => assertSqliteValue(Number.NaN)).toThrow(SqliteCodecError);
  });

  it("closes idempotently and rejects new operations without global state", async () => {
    const { ledger } = await temporaryLedger();
    await ledger.close();
    await ledger.close();
    await expect(ledger.health()).resolves.toBe(false);
    await expect(ledger.get("SELECT 1")).rejects.toBeInstanceOf(SqliteClosedError);
    await expect(openSqliteLedger({ path: ":memory:" })).rejects.toThrow("requires a file path");
    await expect(openSqliteLedger({ path: "/tmp/unused.sqlite", busyTimeoutMs: 30_001 })).rejects.toThrow(
      "busyTimeoutMs"
    );
  });
});

async function columnNames(ledger: SqliteLedger, table: string): Promise<string[]> {
  return (await ledger.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((column) => column.name);
}

async function insertUser(ledger: SqliteLedger, id: string, email: string): Promise<void> {
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
}

async function insertSource(
  ledger: SqliteLedger,
  accountId: string,
  id: string,
  name: string,
  connector: string | null = null
): Promise<void> {
  await ledger.run(
    "INSERT INTO sources (id,account_id,name,kind,connector,display_name,status,meta) VALUES (?,?,?,?,?,?,?,?)",
    [id, accountId, name, "tabular", connector, `${name}.csv`, "ready", encodeJson({})]
  );
}
