import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LATEST_SQLITE_SCHEMA_VERSION, SCHEMA_V18 } from "../db/migrations.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  AnalysisActiveRunError,
  AnalysisNotFoundError,
  AnalysisQuotaError,
  AnalysisRevisionConflictError,
  AnalysisRunNotFoundError,
  AnalysisRunStateError,
  AnalysisStore,
  type AnalysisStoreOptions,
} from "../db/stores/analysisStore.js";
import type { SqliteLedger } from "../db/types.js";
import { AnalysisValidationError } from "../analysisTypes.js";
import { createHistoricalSqliteFixture, expectedFixtureVersions } from "./sqliteMigrationFixture.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];
const extraLedgers: SqliteLedger[] = [];
let clock = Date.parse("2026-09-06T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(extraLedgers.splice(0).map((ledger) => ledger.close()));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function setup(options: AnalysisStoreOptions = {}): Promise<{
  ledger: SqliteLedger;
  store: AnalysisStore;
  filename: string;
}> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const now = options.now ?? (() => new Date((clock += 1_000)));
  return { ledger: resource.ledger, store: new AnalysisStore(resource.ledger, { now }), filename: resource.filename };
}

async function secondStore(filename: string): Promise<{ ledger: SqliteLedger; store: AnalysisStore }> {
  const ledger = await openSqliteLedger({ path: filename });
  extraLedgers.push(ledger);
  return { ledger, store: new AnalysisStore(ledger) };
}

async function insertUser(ledger: SqliteLedger, label: string): Promise<string> {
  const id = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    id,
    `${label}-${id}@example.test`,
    "test-hash",
  ]);
  return id;
}

interface SourceSpec {
  status?: "ready" | "index" | "error";
  readyGeneration?: number | null;
  filePath?: string | null;
  sizeBytes?: number;
}

async function insertSource(ledger: SqliteLedger, accountId: string, spec: SourceSpec = {}): Promise<string> {
  const id = randomUUID();
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,status,meta,ready_generation,size_bytes)
     VALUES (?,?,?,'tabular',?,?,?,?,?,?)`,
    [
      id,
      accountId,
      `src-${id.slice(0, 8)}`,
      `${id.slice(0, 8)}.csv`,
      spec.filePath === undefined ? `/data/${id}/table.csv` : spec.filePath,
      spec.status ?? "ready",
      "{}",
      spec.readyGeneration === undefined ? 3 : spec.readyGeneration,
      spec.sizeBytes ?? 128,
    ]
  );
  return id;
}

function definition(sourceIds: readonly string[] = []) {
  return {
    title: "Monthly spend",
    description: "Spend per month",
    sql: "SELECT month, sum(amount) FROM transactions WHERE month >= ? GROUP BY month",
    parameters: [
      { name: "month", type: "string", required: true },
      { name: "limit", type: "integer", required: false, default: 5 },
      { name: "flag", type: "boolean", required: false, nullable: true },
    ],
    sourceIds,
  };
}

async function createReadyAnalysis(store: AnalysisStore, account: string, ledger: SqliteLedger) {
  const source = await insertSource(ledger, account, {
    readyGeneration: 7,
    filePath: "/data/a/live.csv",
    sizeBytes: 100,
  });
  const analysis = await store.createAnalysis(account, definition([source]));
  return { analysis, source };
}

function acceptInput(values: Record<string, unknown> = { month: "2026-08" }) {
  return { operationId: randomUUID(), values };
}

async function markRunning(
  store: AnalysisStore,
  account: string,
  analysisId: string,
  accepted: { run: { id: string } }
) {
  return store.markAnalysisRunRunning(account, analysisId, accepted.run.id);
}

describe("AnalysisStore", () => {
  it("ships a byte-identical v018 fixture that upgrades a seeded v16 installation", async () => {
    // The v018.sql fixture is byte-identical to the migration delta. The
    // inventory holds exactly one fixture per version with the single
    // documented pending-merge v17 gap; the coordinator empties
    // PENDING_MERGE_SCHEMA_VERSIONS after the v17 merge and this assertion
    // becomes contiguous with no other test edits.
    expect(expectedFixtureVersions()).toEqual([...Array.from({ length: 16 }, (_, index) => index + 1), 18]);
    const fixtureSql = await fs.readFile(fileURLToPath(new URL("./fixtures/sqlite/v018.sql", import.meta.url)), "utf8");
    expect(fixtureSql).toBe(SCHEMA_V18);

    const historical = await createHistoricalSqliteFixture(16);
    try {
      const ledger = await openSqliteLedger({ path: historical.filename });
      try {
        await expect(ledger.get<{ user_version: bigint }>("PRAGMA user_version")).resolves.toEqual({
          user_version: BigInt(LATEST_SQLITE_SCHEMA_VERSION),
        });
        await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
        const store = new AnalysisStore(ledger);
        const analysis = await store.createAnalysis(historical.seed.accountId, {
          title: "Upgraded analysis",
          sql: "SELECT 1",
          sourceIds: [],
        });
        const accepted = await store.acceptAnalysisRun(historical.seed.accountId, analysis.id, { values: {} });
        expect(accepted.outcome).toBe("queued");
      } finally {
        await ledger.close();
      }
    } finally {
      await historical.cleanup();
    }
  });

  it("creates owner-scoped definitions with captured binding identity and selected-empty semantics", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const foreign = await insertUser(ledger, "foreign");
    const source = await insertSource(ledger, account, {
      readyGeneration: 7,
      filePath: "/data/live.csv",
      sizeBytes: 2048,
    });
    const foreignSource = await insertSource(ledger, foreign);

    await expect(store.createAnalysis(`${foreign}!`, definition())).rejects.toBeInstanceOf(TypeError);
    await expect(store.createAnalysis(randomUUID(), definition())).rejects.toBeInstanceOf(AnalysisNotFoundError);
    await expect(store.createAnalysis(account, definition([foreignSource]))).rejects.toBeInstanceOf(
      AnalysisNotFoundError
    );
    await expect(store.createAnalysis(account, definition(["not-a-uuid"]))).rejects.toBeInstanceOf(
      AnalysisValidationError
    );
    await expect(store.createAnalysis(account, { ...definition(), sql: "x".repeat(20_001) })).rejects.toBeInstanceOf(
      AnalysisValidationError
    );
    await expect(
      store.createAnalysis(account, {
        ...definition(),
        parameters: Array.from({ length: 21 }, (_, index) => ({ name: `p${index}`, type: "string" })),
      })
    ).rejects.toBeInstanceOf(AnalysisValidationError);
    await expect(
      store.createAnalysis(account, {
        ...definition(),
        parameters: [
          { name: "month", type: "string", required: true },
          { name: "month", type: "number", required: true },
        ],
      })
    ).rejects.toBeInstanceOf(AnalysisValidationError);

    const analysis = await store.createAnalysis(account, {
      ...definition([source]),
      comparisonKey: ["month"],
      origin: { chatId: randomUUID(), runId: randomUUID(), captureId: randomUUID() },
    });
    expect(analysis).toMatchObject({
      accountId: account,
      currentRevision: 1,
      revision: {
        revision: 1,
        title: "Monthly spend",
        comparisonKey: ["month"],
      },
      sources: [
        {
          sourceId: source,
          readyGeneration: 7,
          contentIdentity: "g7|s2048|p/data/live.csv",
          unavailableAt: null,
        },
      ],
    });
    expect(analysis.revision.parameters.map((parameter) => parameter.name)).toEqual(["month", "limit", "flag"]);
    expect(analysis.revision.originChatId).toHaveLength(36);
    await expect(store.getAnalysis(foreign, analysis.id)).resolves.toBeUndefined();

    // Selected-empty: zero source ids is a durable empty scope, never widened.
    const emptyScope = await store.createAnalysis(account, definition());
    expect(emptyScope.sources).toEqual([]);
    await expect(
      ledger.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM analysis_sources WHERE analysis_id=?", [
        emptyScope.id,
      ])
    ).resolves.toEqual({ count: 0n });

    // Keyset pagination orders by (created_at DESC, id DESC) per account.
    const page = await store.listAnalyses(account);
    expect(page.items.map((item) => item.id)).toEqual([emptyScope.id, analysis.id]);
    expect(page.items[1]).toMatchObject({ sourceCount: 1, unavailableSourceCount: 0, currentRevision: 1 });
    await expect(store.listAnalyses(foreign)).resolves.toMatchObject({ items: [] });
  });

  it("edits definitions with optimistic CAS over immutable revisions", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "cas");
    const first = await insertSource(ledger, account, { readyGeneration: 2 });
    const second = await insertSource(ledger, account, { readyGeneration: 9, sizeBytes: 7 });
    const analysis = await store.createAnalysis(account, definition([first]));

    const edited = await store.updateAnalysis(account, analysis.id, 1, {
      title: "Monthly spend v2",
      sql: "SELECT 2",
      sourceIds: [second],
      comparisonKey: null,
    });
    expect(edited.currentRevision).toBe(2);
    expect(edited.revision).toMatchObject({
      revision: 2,
      title: "Monthly spend v2",
      sql: "SELECT 2",
      comparisonKey: null,
    });
    expect(edited.sources[0]).toMatchObject({
      sourceId: second,
      readyGeneration: 9,
      contentIdentity: `g9|s7|p/data/${second}/table.csv`,
    });

    // Both revisions are durable and immutable.
    await expect(
      ledger.all<{ revision: bigint; sql: string }>(
        "SELECT revision,sql FROM analysis_revisions WHERE analysis_id=? ORDER BY revision",
        [analysis.id]
      )
    ).resolves.toEqual([
      { revision: 1n, sql: definition().sql },
      { revision: 2n, sql: "SELECT 2" },
    ]);

    // A stale expected revision loses the CAS race and writes nothing.
    await expect(store.updateAnalysis(account, analysis.id, 1, { title: "stale" })).rejects.toBeInstanceOf(
      AnalysisRevisionConflictError
    );
    await expect(
      ledger.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM analysis_revisions WHERE analysis_id=?", [
        analysis.id,
      ])
    ).resolves.toEqual({ count: 2n });
    // A concurrent edit through a second connection beats the older token.
    const other = await secondStore(ledger.path);
    await other.store.updateAnalysis(account, analysis.id, 2, { title: "concurrent" });
    await expect(store.updateAnalysis(account, analysis.id, 2, { title: "loser" })).rejects.toBeInstanceOf(
      AnalysisRevisionConflictError
    );
    const head = await store.getAnalysis(account, analysis.id);
    expect(head).toMatchObject({ currentRevision: 3, revision: { revision: 3, title: "concurrent" } });
  });

  it("freezes provenance atomically and never retargets a frozen run on refresh or deletion", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "freeze");
    const { analysis, source } = await createReadyAnalysis(store, account, ledger);

    const accepted = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    expect(accepted).toMatchObject({
      outcome: "queued",
      run: {
        status: "queued",
        revision: 1,
        cancelRequested: false,
        startedAt: null,
        finishedAt: null,
        parameterBindings: [
          { name: "month", type: "string", value: "2026-08" },
          { name: "limit", type: "integer", value: 5 },
          { name: "flag", type: "boolean", value: null },
        ],
        sources: [{ sourceId: source, readyGeneration: 7, contentIdentity: "g7|s100|p/data/a/live.csv" }],
      },
    });

    // A later connector-style refresh and a later source deletion can never
    // retarget or erase the frozen run provenance.
    await ledger.run(
      "UPDATE sources SET ready_generation=9, file_path='/data/a/refreshed.csv', size_bytes=512 WHERE id=?",
      [source]
    );
    const afterRefresh = await store.getAnalysisRun(account, analysis.id, accepted.run.id);
    expect(afterRefresh?.sources).toEqual([
      { sourceId: source, readyGeneration: 7, contentIdentity: "g7|s100|p/data/a/live.csv" },
    ]);

    await ledger.run("DELETE FROM sources WHERE id=? AND account_id=?", [source, account]);
    const afterDelete = await store.getAnalysisRun(account, analysis.id, accepted.run.id);
    expect(afterDelete?.sources).toEqual([
      { sourceId: source, readyGeneration: 7, contentIdentity: "g7|s100|p/data/a/live.csv" },
    ]);
    // The definition binding is marked unavailable, not retargeted.
    const definitionNow = await store.getAnalysis(account, analysis.id);
    expect(definitionNow?.sources[0]).toMatchObject({
      sourceId: source,
      readyGeneration: 7,
      contentIdentity: "g7|s100|p/data/a/live.csv",
    });
    expect(definitionNow?.sources[0]?.unavailableAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("rejects unavailable or drifted inputs as explicit stale-inputs runs", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "stale");
    const { analysis, source } = await createReadyAnalysis(store, account, ledger);

    // Snapshot CAS compares at the same admission boundary: a later refresh
    // cannot silently substitute inputs for an M16-style expected snapshot.
    const drifted = await store.acceptAnalysisRun(account, analysis.id, {
      values: { month: "2026-08" },
      expectedSourceSnapshot: [{ sourceId: source, readyGeneration: 6 }],
    });
    expect(drifted).toMatchObject({
      outcome: "stale-inputs",
      run: { status: "stale-inputs", errorCode: "ANALYSIS_SNAPSHOT_MISMATCH", finishedAt: expect.any(String) },
    });
    await expect(
      ledger.get("SELECT 1 FROM analysis_results WHERE run_id=?", [drifted.run.id])
    ).resolves.toBeUndefined();

    // A matching snapshot accepts cleanly with the frozen identity.
    const matched = await store.acceptAnalysisRun(account, analysis.id, {
      values: { month: "2026-08" },
      expectedSourceSnapshot: [{ sourceId: source, readyGeneration: 7, contentIdentity: "g7|s100|p/data/a/live.csv" }],
    });
    expect(matched.outcome).toBe("queued");

    // Deleting the source makes later acceptances explicit stale-inputs runs;
    // the earlier accepted run is untouched and the binding stays marked.
    expect(await store.requestAnalysisRunCancel(account, analysis.id, matched.run.id)).toBe("cancelled");
    await ledger.run("DELETE FROM sources WHERE id=? AND account_id=?", [source, account]);
    const stale = await store.acceptAnalysisRun(account, analysis.id, { values: { month: "2026-08" } });
    expect(stale).toMatchObject({
      outcome: "stale-inputs",
      run: { status: "stale-inputs", errorCode: "ANALYSIS_INPUTS_UNAVAILABLE", sources: [] },
    });
    const frozen = await store.getAnalysisRun(account, analysis.id, matched.run.id);
    expect(frozen?.sources).toHaveLength(1);

    // Selected-empty never widens at acceptance: zero bindings queue an
    // explicitly zero-source run.
    const emptyAnalysis = await store.createAnalysis(account, definition());
    const emptyRun = await store.acceptAnalysisRun(account, emptyAnalysis.id, { values: { month: "2026-08" } });
    expect(emptyRun).toMatchObject({ outcome: "queued", run: { sources: [] } });
    await expect(
      ledger.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM analysis_sources WHERE analysis_id=?", [
        emptyAnalysis.id,
      ])
    ).resolves.toEqual({ count: 0n });
  });

  it("enforces one active run per analysis and idempotent operation acceptance", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "active");
    const foreign = await insertUser(ledger, "active-foreign");
    const { analysis } = await createReadyAnalysis(store, account, ledger);
    const operationId = randomUUID();

    const first = await store.acceptAnalysisRun(account, analysis.id, { operationId, values: { month: "2026-08" } });
    expect(first.outcome).toBe("queued");

    // A concurrent acceptance is rejected as a conflict.
    await expect(store.acceptAnalysisRun(account, analysis.id, acceptInput())).rejects.toBeInstanceOf(
      AnalysisActiveRunError
    );

    // A retried acceptance with the same operation UUID replays the original.
    const retry = await store.acceptAnalysisRun(account, analysis.id, {
      operationId,
      values: { month: "2026-08" },
    });
    expect(retry).toEqual({ run: first.run, outcome: "replayed" });
    // The same operation id on another analysis is a distinct acceptance key.
    const otherAnalysis = await store.createAnalysis(account, definition());
    const other = await store.acceptAnalysisRun(account, otherAnalysis.id, {
      operationId,
      values: { month: "2026-08" },
    });
    expect(other.outcome).toBe("queued");
    await expect(store.acceptAnalysisRun(foreign, analysis.id, { operationId })).rejects.toBeInstanceOf(
      AnalysisNotFoundError
    );

    // Running also holds the single active slot.
    const running = await markRunning(store, account, analysis.id, first);
    expect(running.status).toBe("running");
    await expect(store.acceptAnalysisRun(account, analysis.id, acceptInput())).rejects.toBeInstanceOf(
      AnalysisActiveRunError
    );
    expect(await store.requestAnalysisRunCancel(account, otherAnalysis.id, other.run.id)).toBe("cancelled");

    // Cancellation requests land durably; only a terminal run frees the slot.
    expect(await store.requestAnalysisRunCancel(account, analysis.id, first.run.id)).toBe("running");
    await expect(store.acceptAnalysisRun(account, analysis.id, acceptInput())).rejects.toBeInstanceOf(
      AnalysisActiveRunError
    );
    await expect(store.finishAnalysisRun(account, analysis.id, first.run.id, "failed")).resolves.toBe("cancelled");

    const next = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    expect(next.outcome).toBe("queued");
    expect(await store.requestAnalysisRunCancel(account, analysis.id, next.run.id)).toBe("cancelled");
    expect(await store.requestAnalysisRunCancel(account, analysis.id, randomUUID())).toBeNull();
  });

  it("publishes one bounded immutable result per succeeded run with honest completeness", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "publish");
    const { analysis, source } = await createReadyAnalysis(store, account, ledger);
    const accepted = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    await expect(
      store.publishAnalysisRunResult(account, analysis.id, accepted.run.id, {
        id: randomUUID(),
        columns: ["c"],
        rows: [["x"]],
      })
    ).rejects.toBeInstanceOf(AnalysisRunStateError); // queued cannot publish
    await markRunning(store, account, analysis.id, accepted);

    const published = await store.publishAnalysisRunResult(account, analysis.id, accepted.run.id, {
      id: randomUUID(),
      columns: ["month", "total", "ok", "note", "mixed"],
      rows: [
        ["2026-08", 12.5, true, "aug", 1],
        ["2026-09", 20, false, "sep", "x"],
      ],
      sourceRowTotal: 2,
    });
    expect(published.status).toBe("published");
    if (published.status !== "published") return;
    expect(published.result).toMatchObject({
      analysisId: analysis.id,
      runId: accepted.run.id,
      revision: 1,
      returnedRows: 2,
      sourceRowTotal: 2,
      rowCountExact: true,
      completeness: { complete: true, reasons: [] },
      parameterBindings: [
        { name: "month", value: "2026-08" },
        { name: "limit", value: 5 },
        { name: "flag", value: null },
      ],
    });
    expect(published.result.sourceProvenance).toEqual([
      { sourceId: source, readyGeneration: 7, contentIdentity: "g7|s100|p/data/a/live.csv" },
    ]);
    expect(published.result.columns.map((column) => [column.name, column.type])).toEqual([
      ["month", "string"],
      ["total", "number"],
      ["ok", "boolean"],
      ["note", "string"],
      ["mixed", "mixed"],
    ]);
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(1);
    await expect(store.getAnalysisRun(account, analysis.id, accepted.run.id)).resolves.toMatchObject({
      status: "succeeded",
      finishedAt: expect.any(String),
    });

    // A retried publish on the succeeded run returns the same single result.
    const replay = await store.publishAnalysisRunResult(account, analysis.id, accepted.run.id, {
      id: randomUUID(),
      columns: [],
      rows: [],
    });
    expect(replay.status).toBe("published");
    if (replay.status === "published") expect(replay.result.id).toBe(published.result.id);

    // Zero rows is a success; a null worker total is never labeled exact.
    const secondRun = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    await markRunning(store, account, analysis.id, secondRun);
    const zero = await store.publishAnalysisRunResult(account, analysis.id, secondRun.run.id, {
      id: randomUUID(),
      columns: ["month"],
      rows: [],
    });
    expect(zero.status).toBe("published");
    if (zero.status === "published") {
      expect(zero.result).toMatchObject({ returnedRows: 0, sourceRowTotal: null, rowCountExact: false });
      expect(zero.result.completeness.complete).toBe(true);
    }

    // Truncated worker output is honestly incomplete and never claims exact.
    const thirdRun = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    await markRunning(store, account, analysis.id, thirdRun);
    const truncated = await store.publishAnalysisRunResult(account, analysis.id, thirdRun.run.id, {
      id: randomUUID(),
      columns: ["month"],
      rows: [["2026-08"]],
      sourceRowTotal: 5,
      truncated: true,
    });
    expect(truncated.status).toBe("published");
    if (truncated.status === "published") {
      expect(truncated.result.rowCountExact).toBe(false);
      expect(truncated.result.completeness.complete).toBe(false);
      expect(truncated.result.completeness.reasons).toContain("worker-truncated");
    }
    const summaries = await store.listAnalysisResults(account, analysis.id);
    expect(summaries.items.map((item) => item.rowCountExact)).toEqual([false, false, true]);
  });

  it("rejects over-ceiling results and invalid cells before persistence", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "ceilings");
    const { analysis } = await createReadyAnalysis(store, account, ledger);
    const accepted = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    await markRunning(store, account, analysis.id, accepted);

    const reject = (input: { id?: string; columns: readonly unknown[]; rows: readonly unknown[] }) =>
      store.publishAnalysisRunResult(account, analysis.id, accepted.run.id, {
        id: input.id ?? randomUUID(),
        columns: input.columns,
        rows: input.rows,
      });
    await expect(
      reject({ columns: Array.from({ length: 65 }, (_, index) => `c${index}`), rows: [] })
    ).rejects.toBeInstanceOf(AnalysisValidationError);
    await expect(reject({ columns: ["c"], rows: Array.from({ length: 501 }, () => ["x"]) })).rejects.toBeInstanceOf(
      AnalysisValidationError
    );
    await expect(reject({ columns: ["c"], rows: [["x".repeat(2_001)]] })).rejects.toBeInstanceOf(
      AnalysisValidationError
    );
    await expect(reject({ columns: ["c"], rows: [[Number.NaN]] })).rejects.toBeInstanceOf(AnalysisValidationError);
    await expect(reject({ columns: ["c"], rows: [[{ nested: 1 }]] })).rejects.toBeInstanceOf(AnalysisValidationError);
    await expect(
      reject({ columns: Array.from({ length: 129 }, (_, index) => `c${index}`), rows: [] })
    ).rejects.toBeInstanceOf(AnalysisValidationError);
    // 500 rows x 40 cells of maximum-length strings busts 1 MiB before the
    // cell and row ceilings bind: the serialized ceiling must reject it.
    await expect(
      store.publishAnalysisRunResult(account, analysis.id, accepted.run.id, {
        id: randomUUID(),
        columns: Array.from({ length: 40 }, (_, index) => `c${index}`),
        rows: Array.from({ length: 500 }, () => new Array<string>(40).fill("x".repeat(2_000))),
      })
    ).rejects.toBeInstanceOf(AnalysisValidationError);
    // The failed attempts left no partial result and the run is untouched.
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
    await expect(store.getAnalysisRun(account, analysis.id, accepted.run.id)).resolves.toMatchObject({
      status: "running",
    });
    await expect(store.getAnalysisResult(account, analysis.id, randomUUID())).resolves.toBeUndefined();
  });

  it("lets cancellation linearize against publication and never publish partial results", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "cancel-publish");
    const { analysis } = await createReadyAnalysis(store, account, ledger);
    const accepted = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    await markRunning(store, account, analysis.id, accepted);

    expect(await store.requestAnalysisRunCancel(account, analysis.id, accepted.run.id)).toBe("running");
    const outcome = await store.publishAnalysisRunResult(account, analysis.id, accepted.run.id, {
      id: randomUUID(),
      columns: ["c"],
      rows: [["x"]],
    });
    expect(outcome).toEqual({ status: "cancelled" });
    await expect(store.getAnalysisRun(account, analysis.id, accepted.run.id)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      errorCode: "CANCELLED",
    });
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);

    // A running executor that finds its inputs stale records stale-inputs.
    const next = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    await markRunning(store, account, analysis.id, next);
    expect(await store.markAnalysisRunStaleInputs(account, analysis.id, next.run.id)).toBe("stale-inputs");
    await expect(store.finishAnalysisRun(account, analysis.id, next.run.id, "failed")).resolves.toBe("stale-inputs");
    await expect(
      store.publishAnalysisRunResult(account, analysis.id, next.run.id, { id: randomUUID(), columns: [], rows: [] })
    ).rejects.toBeInstanceOf(AnalysisRunStateError);
  });

  it("enforces the 1000-retained-results quota before execution and on publication", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "quota");
    const { analysis } = await createReadyAnalysis(store, account, ledger);

    await ledger.run(
      `INSERT INTO analysis_runs (id,account_id,analysis_id,revision,status,parameter_values,finished_at,created_at,started_at)
       WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n < 1000)
       SELECT printf('%08x',n)||'-0000-4000-8000-000000000000',?,?,1,'succeeded','[]',
              '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'
       FROM cnt`,
      [account, analysis.id]
    );
    await ledger.run(
      `INSERT INTO analysis_results (id,account_id,analysis_id,run_id,revision,columns,rows,returned_rows,created_at)
       WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n < 1000)
       SELECT printf('%08x',n+4096)||'-0000-4000-8000-000000000000',?,?,
              printf('%08x',n)||'-0000-4000-8000-000000000000',1,'[]','[]',0,'2026-09-01T00:00:00.000Z'
       FROM cnt`,
      [account, analysis.id]
    );
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(1000);

    await expect(store.acceptAnalysisRun(account, analysis.id, acceptInput())).rejects.toBeInstanceOf(
      AnalysisQuotaError
    );
    await expect(
      ledger.get<{ count: bigint }>(
        "SELECT COUNT(*) AS count FROM analysis_runs WHERE analysis_id=? AND status='queued'",
        [analysis.id]
      )
    ).resolves.toEqual({ count: 0n });

    // An accepted-earlier run cannot publish past the cap either.
    const [candidate] = await ledger.all<{ id: string }>(
      "SELECT id FROM analysis_runs WHERE analysis_id=? AND account_id=? ORDER BY id LIMIT 1",
      [analysis.id, account]
    );
    await ledger.run("UPDATE analysis_runs SET status='running',finished_at=NULL WHERE id=? AND account_id=?", [
      candidate.id,
      account,
    ]);
    await expect(
      store.publishAnalysisRunResult(account, analysis.id, candidate.id, {
        id: randomUUID(),
        columns: ["c"],
        rows: [["x"]],
      })
    ).rejects.toBeInstanceOf(AnalysisQuotaError);
    await expect(store.getAnalysisRun(account, analysis.id, candidate.id)).resolves.toMatchObject({
      status: "running",
    });
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(1000);
  });

  it("recovers interrupted runs on restart without rerunning or publishing", async () => {
    const { ledger, store, filename } = await setup();
    const account = await insertUser(ledger, "restart");
    const first = await createReadyAnalysis(store, account, ledger);
    const runningCancelled = await store.acceptAnalysisRun(account, first.analysis.id, acceptInput());
    await markRunning(store, account, first.analysis.id, runningCancelled);
    expect(await store.requestAnalysisRunCancel(account, first.analysis.id, runningCancelled.run.id)).toBe("running");
    const second = await createReadyAnalysis(store, account, ledger);
    const runningPlain = await store.acceptAnalysisRun(account, second.analysis.id, acceptInput());
    await markRunning(store, account, second.analysis.id, runningPlain);
    const third = await createReadyAnalysis(store, account, ledger);
    const queued = await store.acceptAnalysisRun(account, third.analysis.id, acceptInput());
    expect(queued.outcome).toBe("queued");

    const afterRestart = await secondStore(filename);
    expect(await afterRestart.store.recoverInterruptedAnalysisRuns()).toBe(2);
    await expect(
      afterRestart.store.getAnalysisRun(account, first.analysis.id, runningCancelled.run.id)
    ).resolves.toMatchObject({ status: "cancelled", errorCode: "CANCELLED" });
    await expect(
      afterRestart.store.getAnalysisRun(account, second.analysis.id, runningPlain.run.id)
    ).resolves.toMatchObject({ status: "failed", errorCode: "SERVER_RESTARTED" });
    await expect(afterRestart.store.getAnalysisRun(account, third.analysis.id, queued.run.id)).resolves.toMatchObject({
      status: "queued",
    });
    expect(await afterRestart.store.countAnalysisResults(account, first.analysis.id)).toBe(0);
  });

  it("deletes analyses only after active work drains and cascades all owned rows", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "delete");
    const foreign = await insertUser(ledger, "delete-foreign");
    const { analysis } = await createReadyAnalysis(store, account, ledger);
    const accepted = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    await markRunning(store, account, analysis.id, accepted);
    await expect(store.deleteAnalysis(account, analysis.id)).rejects.toBeInstanceOf(AnalysisActiveRunError);

    await store.requestAnalysisRunCancel(account, analysis.id, accepted.run.id);
    await store.finishAnalysisRun(account, analysis.id, accepted.run.id, "cancelled");
    expect(await store.deleteAnalysis(account, analysis.id)).toBe(true);
    expect(await store.deleteAnalysis(account, analysis.id)).toBe(false);
    expect(await store.deleteAnalysis(foreign, analysis.id)).toBe(false);
    await expect(store.getAnalysisRun(account, analysis.id, accepted.run.id)).resolves.toBeUndefined();
    await expect(
      ledger.all(
        `SELECT (SELECT COUNT(*) FROM analyses) a,
                (SELECT COUNT(*) FROM analysis_revisions) r,
                (SELECT COUNT(*) FROM analysis_sources) s,
                (SELECT COUNT(*) FROM analysis_runs) ru,
                (SELECT COUNT(*) FROM analysis_run_sources) rs`
      )
    ).resolves.toEqual([{ a: 0n, r: 0n, s: 0n, ru: 0n, rs: 0n }]);

    // Account deletion cascades everything owned by the account.
    const doomed = await store.createAnalysis(account, definition());
    await store.acceptAnalysisRun(account, doomed.id, acceptInput());
    await ledger.run("DELETE FROM users WHERE id=?", [account]);
    await expect(store.getAnalysis(account, doomed.id)).resolves.toBeUndefined();
    await expect(
      ledger.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM analysis_runs WHERE analysis_id=?", [doomed.id])
    ).resolves.toEqual({ count: 0n });
  });

  it("deletes one retained result while keeping the run and history intact", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "result-delete");
    const { analysis } = await createReadyAnalysis(store, account, ledger);
    const accepted = await store.acceptAnalysisRun(account, analysis.id, acceptInput());
    await markRunning(store, account, analysis.id, accepted);
    const published = await store.publishAnalysisRunResult(account, analysis.id, accepted.run.id, {
      id: randomUUID(),
      columns: ["c"],
      rows: [["kept"]],
    });
    expect(published.status).toBe("published");
    if (published.status !== "published") return;

    expect(await store.deleteAnalysisResult(account, analysis.id, published.result.id)).toBe(true);
    expect(await store.deleteAnalysisResult(account, analysis.id, published.result.id)).toBe(false);
    expect(await store.countAnalysisResults(account, analysis.id)).toBe(0);
    await expect(store.getAnalysisRun(account, analysis.id, accepted.run.id)).resolves.toMatchObject({
      status: "succeeded",
    });
    const summaries = await store.listAnalysisResults(account, analysis.id);
    expect(summaries.items).toEqual([]);
  });

  it("validates parameter values against declarations without coercion", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "params");
    const { analysis } = await createReadyAnalysis(store, account, ledger);
    const dateAnalysis = await store.createAnalysis(account, {
      title: "Date check",
      sql: "SELECT ?",
      parameters: [
        { name: "since", type: "date", required: true },
        { name: "ratio", type: "number", required: false, nullable: true },
      ],
      sourceIds: [],
    });

    const reject = async (values: Record<string, unknown>, analysisId = analysis.id) => {
      await expect(store.acceptAnalysisRun(account, analysisId, { values })).rejects.toBeInstanceOf(
        AnalysisValidationError
      );
    };
    await reject({}); // missing required
    await reject({ month: "2026-08", undeclared: 1 }); // undeclared
    await reject({ month: 5 }); // mistyped
    await reject({ month: "2026-08", limit: 5.5 }); // non-integer for integer
    await reject({ month: "x".repeat(2_001) }); // oversized string
    await reject({ month: "2026-08", flag: "yes" }); // mistyped boolean
    await reject({ since: "2026-02-30" }, dateAnalysis.id); // impossible calendar date
    await reject({ since: "2026-1-1" }, dateAnalysis.id); // not canonical ISO

    const ok = await store.acceptAnalysisRun(account, dateAnalysis.id, {
      values: { since: "2026-02-28", ratio: 1.5 },
    });
    expect(ok.outcome).toBe("queued");
    expect(ok.run.parameterBindings).toEqual([
      { name: "since", type: "date", value: "2026-02-28" },
      { name: "ratio", type: "number", value: 1.5 },
    ]);
    expect(await store.requestAnalysisRunCancel(account, dateAnalysis.id, ok.run.id)).toBe("cancelled");
    const nullBinding = await store.acceptAnalysisRun(account, dateAnalysis.id, {
      values: { since: "2026-01-01", ratio: null },
    });
    expect(nullBinding.run.parameterBindings[1].value).toBeNull();
    await expect(store.markAnalysisRunRunning(account, analysis.id, randomUUID())).rejects.toBeInstanceOf(
      AnalysisRunNotFoundError
    );
    await expect(store.getAnalysisRun(randomUUID(), analysis.id, ok.run.id)).resolves.toBeUndefined();
  });
});
