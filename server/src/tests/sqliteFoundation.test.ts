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
