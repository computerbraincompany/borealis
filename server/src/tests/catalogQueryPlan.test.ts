import { afterEach, describe, expect, it } from "vitest";
import { AutomationStore } from "../automationStore.js";
import { createChatStore } from "../db/stores/chatStore.js";
import { AgentStore } from "../db/stores/agentStore.js";
import { LibraryStore } from "../db/stores/libraryStore.js";
import { createRunStore } from "../db/stores/runStore.js";
import { createSourceStore } from "../db/stores/sourceStore.js";
import type { SqliteLedger, SqliteParameters } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAGE = {
  limit: 100,
  after: { timestamp: "2026-08-31T12:00:00.000Z", id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
} as const;

const resources: TempSqliteLedger[] = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

describe("catalog query plans", () => {
  it("uses tenant/order indexes without temporary sorting beyond one maximum page", async () => {
    const resource = await createTempSqliteLedger();
    resources.push(resource);
    await seedLargeCatalogs(resource);

    const cases: Array<{
      name: string;
      index: string;
      run: (ledger: SqliteLedger) => Promise<{ readonly items: unknown[]; readonly next: unknown }>;
    }> = [
      {
        name: "sources",
        index: "sources_account_catalog_idx",
        run: (ledger) => createSourceStore(ledger).listSources(OWNER, PAGE),
      },
      {
        name: "connectors",
        index: "connectors_account_catalog_idx",
        run: (ledger) => createSourceStore(ledger).listConnectors(OWNER, PAGE),
      },
      {
        name: "chats",
        index: "chats_account_activity_idx",
        run: (ledger) => createChatStore(ledger).listChats(OWNER, PAGE),
      },
      {
        name: "reports",
        index: "reports_account_catalog_idx",
        run: (ledger) => createRunStore(ledger).listPublishedReports(OWNER, PAGE),
      },
      {
        name: "shared reports",
        index: "report_shares_recipient_idx",
        run: (ledger) => createRunStore(ledger).listSharedReports(RECIPIENT, PAGE),
      },
      {
        name: "agents",
        index: "agents_account_catalog_idx",
        run: (ledger) => new AgentStore(ledger).listAgents(OWNER, PAGE),
      },
      {
        name: "libraries",
        index: "libraries_account_catalog_idx",
        run: (ledger) => new LibraryStore(ledger).listLibraries(OWNER, PAGE),
      },
      {
        name: "automations",
        index: "automations_account_catalog_idx",
        run: (ledger) => new AutomationStore(ledger).list(OWNER, PAGE),
      },
    ];

    for (const testCase of cases) {
      const { statement, result } = await captureCatalogQuery(resource.ledger, testCase.run);
      expect(result.items, testCase.name).toHaveLength(100);
      expect(result.next, testCase.name).not.toBeNull();
      const plan = await resource.ledger.all<{ detail?: unknown }>(
        `EXPLAIN QUERY PLAN ${statement.sql}`,
        statement.parameters
      );
      const details = plan.map((row) => String(row.detail ?? ""));
      expect(
        details.some((detail) => detail.includes(testCase.index)),
        testCase.name
      ).toBe(true);
      expect(
        details.some((detail) => detail.includes("TEMP B-TREE")),
        testCase.name
      ).toBe(false);
    }
  });
});

async function captureCatalogQuery(
  ledger: SqliteLedger,
  run: (recordingLedger: SqliteLedger) => Promise<{ readonly items: unknown[]; readonly next: unknown }>
): Promise<{
  statement: { sql: string; parameters: SqliteParameters | undefined };
  result: { readonly items: unknown[]; readonly next: unknown };
}> {
  let statement: { sql: string; parameters: SqliteParameters | undefined } | undefined;
  const recordingLedger = new Proxy(ledger, {
    get(target, property) {
      if (property === "all") {
        return async (sql: string, parameters?: SqliteParameters) => {
          statement = { sql, parameters };
          return target.all(sql, parameters);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqliteLedger;
  const result = await run(recordingLedger);
  if (!statement) throw new Error("catalog query was not captured");
  return { statement, result };
}

async function seedLargeCatalogs(resource: TempSqliteLedger): Promise<void> {
  await resource.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    OWNER,
    "owner@example.test",
    "hash",
  ]);
  await resource.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    RECIPIENT,
    "recipient@example.test",
    "hash",
  ]);
  await resource.ledger.withImmediateTransaction((transaction) => {
    for (let index = 0; index <= 100; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 7, 30, 10, 0, index)).toISOString();
      transaction.run(
        `INSERT INTO sources (id,account_id,name,kind,display_name,status,meta,created_at)
         VALUES (?,?,?,'tabular',?,'ready','{}',?)`,
        [id, OWNER, `source_${index}`, `Source ${index}`, timestamp]
      );
      transaction.run(
        `INSERT INTO connectors
           (id,account_id,name,type,config,target_table,sync_status,created_at)
         VALUES (?,?,?,'url_csv','{}',?,'idle',?)`,
        [id, OWNER, `Connector ${index}`, `table_${index}`, timestamp]
      );
      transaction.run(
        `INSERT INTO chats (id,account_id,title,model,created_at,updated_at)
         VALUES (?,?,?,'model',?,?)`,
        [id, OWNER, `Chat ${index}`, timestamp, timestamp]
      );
      transaction.run(
        `INSERT INTO reports (id,account_id,status,title,created_at,updated_at)
         VALUES (?,?,'published',?,?,?)`,
        [id, OWNER, `Report ${index}`, timestamp, timestamp]
      );
      transaction.run(
        "INSERT INTO report_shares (report_id,owner_account_id,recipient_account_id,shared_at) VALUES (?,?,?,?)",
        [id, OWNER, RECIPIENT, timestamp]
      );
      transaction.run("INSERT INTO libraries (id,account_id,name,created_at,updated_at) VALUES (?,?,?,?,?)", [
        id,
        OWNER,
        `Library ${index}`,
        timestamp,
        timestamp,
      ]);
      transaction.run(
        "INSERT INTO agents (id,account_id,name,current_version,created_at,updated_at) VALUES (?,?,?,1,?,?)",
        [id, OWNER, `Agent ${index}`, timestamp, timestamp]
      );
      transaction.run(
        "INSERT INTO agent_revisions (agent_id,version,account_id,instructions,created_at) VALUES (?,1,?,?,?)",
        [id, OWNER, `Instruction ${index}`, timestamp]
      );
      transaction.run(
        `INSERT INTO automations
           (id,account_id,name,kind,target_id,prompt,schedule_minutes,next_run_at,created_at,updated_at)
         VALUES (?,?,?,'agent_turn',?,?,60,?,?,?)`,
        [id, OWNER, `Automation ${index}`, id, `Prompt ${index}`, timestamp, timestamp, timestamp]
      );
    }
  });
  await resource.ledger.exec("ANALYZE");
}
