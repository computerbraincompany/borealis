import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/sqlite/", import.meta.url));
const fixturePattern = /^v(\d{3})\.sql$/;

function fixtureFilename(version: number): string {
  return `v${String(version).padStart(3, "0")}.sql`;
}

export const HISTORICAL_FIXTURE_SEED = {
  accountId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
  chatId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  email: "historical@example.test",
  sourceName: "historical-source",
  chatTitle: "Historical chat",
  chatModel: "fixture-model",
  messageContent: "Historical fixture question",
} as const;

/**
 * Pre-merge fixture-inventory exception. Schema v23 belongs to the parallel
 * in-flight M13 document_rewrites branch; until its `v023.sql` fixture merges,
 * exactly that one slot is legitimately absent (this branch's own allocation
 * is v24). This list is the single documented gap: the coordinator empties it
 * when v23 lands, and the inventory assertion becomes contiguous with no other
 * test edits. Nothing here fakes a v23 schema: unknown files and every other
 * missing version still fail closed.
 */
export const PENDING_MERGE_SCHEMA_VERSIONS: readonly number[] = Object.freeze([]);

/** Versions that must exist as historical fixtures on the current branch. */
export function expectedFixtureVersions(): number[] {
  const pending = new Set(PENDING_MERGE_SCHEMA_VERSIONS);
  return Array.from({ length: LATEST_SQLITE_SCHEMA_VERSION }, (_, index) => index + 1).filter(
    (version) => !pending.has(version)
  );
}

export interface HistoricalSqliteFixture {
  readonly directory: string;
  readonly filename: string;
  readonly startVersion: number;
  readonly seed: typeof HISTORICAL_FIXTURE_SEED & { messageId: number };
  cleanup(): Promise<void>;
}

export async function listHistoricalFixtureVersions(): Promise<number[]> {
  const versions: number[] = [];
  for (const entry of await fs.readdir(fixtureDirectory)) {
    const match = fixturePattern.exec(entry);
    if (!match) {
      throw new Error(`historical fixture inventory contains an unexpected file: ${entry}`);
    }
    versions.push(Number(match[1]));
  }
  versions.sort((left, right) => left - right);
  const expected = expectedFixtureVersions();
  if (versions.length !== expected.length || versions.some((version, index) => version !== expected[index])) {
    throw new Error(
      `historical fixture inventory ${JSON.stringify(versions)} must hold exactly one fixture for every ` +
        `schema version 1..${LATEST_SQLITE_SCHEMA_VERSION} except pending-merge ` +
        `${JSON.stringify(PENDING_MERGE_SCHEMA_VERSIONS)}`
    );
  }
  return versions;
}

function applyFixtureDelta(database: Database.Database, version: number, sql: string): void {
  database.exec("BEGIN IMMEDIATE");
  let inTransaction = true;
  try {
    database.exec(sql);
    database.pragma(`user_version = ${version}`);
    database.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the fixture failure; the caller removes the temporary directory.
      }
    }
    throw new Error(`historical fixture failed to apply schema version ${version}`, { cause: error });
  }
  if (Number(database.pragma("user_version", { simple: true })) !== version) {
    throw new Error(`historical fixture version ${version} was not recorded in user_version`);
  }
}

function seedHistoricalRows(database: Database.Database): HistoricalSqliteFixture["seed"] {
  const seed = HISTORICAL_FIXTURE_SEED;
  database.exec("BEGIN IMMEDIATE");
  let inTransaction = true;
  try {
    database
      .prepare("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)")
      .run(seed.accountId, seed.email, "fixture-hash");
    database
      .prepare(
        "INSERT INTO sources (id,account_id,name,kind,connector,display_name,status,meta) VALUES (?,?,?,?,?,?,?,?)"
      )
      .run(seed.sourceId, seed.accountId, seed.sourceName, "document", null, "Historical.csv", "ready", "{}");
    database
      .prepare("INSERT INTO chats (id,account_id,title,model) VALUES (?,?,?,?)")
      .run(seed.chatId, seed.accountId, seed.chatTitle, seed.chatModel);
    database
      .prepare("INSERT INTO chat_sources (chat_id,source_id,account_id) VALUES (?,?,?)")
      .run(seed.chatId, seed.sourceId, seed.accountId);
    const message = database
      .prepare("INSERT INTO messages (chat_id,role,content,meta) VALUES (?,'user',?,?)")
      .run(seed.chatId, seed.messageContent, "{}");
    const messageId = Number(message.lastInsertRowid);
    database
      .prepare("INSERT INTO chat_runs (id,account_id,chat_id,user_message_id,status) VALUES (?,?,?,?,'completed')")
      .run(seed.runId, seed.accountId, seed.chatId, messageId);
    database
      .prepare("INSERT INTO chat_run_sources (run_id,source_id,account_id) VALUES (?,?,?)")
      .run(seed.runId, seed.sourceId, seed.accountId);
    database.exec("COMMIT");
    inTransaction = false;
    return { ...seed, messageId };
  } catch (error) {
    if (inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the seeding failure; the caller removes the temporary directory.
      }
    }
    throw new Error("historical fixture failed to seed representative v1 rows", { cause: error });
  }
}

export async function createHistoricalSqliteFixture(startVersion: number): Promise<HistoricalSqliteFixture> {
  if (!Number.isInteger(startVersion) || startVersion < 1 || startVersion > LATEST_SQLITE_SCHEMA_VERSION) {
    throw new RangeError(
      `historical fixture start version must be an integer between 1 and ${LATEST_SQLITE_SCHEMA_VERSION}`
    );
  }
  if (PENDING_MERGE_SCHEMA_VERSIONS.includes(startVersion)) {
    throw new RangeError(`historical fixture start version ${startVersion} has no fixture before its merge`);
  }
  await listHistoricalFixtureVersions();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-sqlite-fixture-"));
  const filename = path.join(directory, "ledger.sqlite");
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const database = new Database(filename);
    try {
      database.pragma("foreign_keys = ON");
      for (let version = 1; version <= startVersion; version += 1) {
        // A historical installation never sits on a pending-merge version, so
        // the fixture chain walks exactly the contiguous history the shipped
        // migrations actually applied: pending slots are stepped over, never
        // faked.
        if (PENDING_MERGE_SCHEMA_VERSIONS.includes(version)) continue;
        const sql = await fs.readFile(path.join(fixtureDirectory, fixtureFilename(version)), "utf8");
        applyFixtureDelta(database, version, sql);
      }
      const seed = seedHistoricalRows(database);
      if (Number(database.pragma("user_version", { simple: true })) !== startVersion) {
        throw new Error(`historical fixture ended at the wrong start version ${startVersion}`);
      }
      return { directory, filename, startVersion, seed, cleanup };
    } finally {
      if (database.open) database.close();
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
}
