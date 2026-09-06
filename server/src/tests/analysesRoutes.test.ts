import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { encodeCatalogCursor } from "../catalogPagination.js";
import { installHttpBoundary } from "../httpErrors.js";
import { analysisRoutes } from "../routes/analyses.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { bindDefaultAnalysisRunner, type RunAnalysisServiceInput } from "../analysisRunner.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-analyses-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
    lanceDirectory: path.join(runtimeDirectory, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [FOREIGN, "foreign@example.test"],
  ] as const) {
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
});

afterEach(async () => {
  bindDefaultAnalysisRunner(undefined);
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(analysisRoutes);
  await app.ready();
  return app;
}

/**
 * Route tests exercise acceptance/replay/quota/409 semantics through the
 * service composition point. DuckDB execution itself is proven against the
 * real worker in `analysisRunner.test.ts`; here the stub binds the durable
 * store's acceptance contract without dispatching an executor.
 */
function bindStubRunner(): void {
  bindDefaultAnalysisRunner({
    start: () => undefined,
    stop: async () => undefined,
    runAnalysisService: async (input: RunAnalysisServiceInput) =>
      await storageRuntime().analyses.acceptAnalysisRun(input.accountId, input.analysisId, {
        operationId: input.operationId ?? null,
        expectedRevision: input.expectedRevision ?? null,
        values: input.values,
      }),
    isRunning: () => true,
    activeRunCount: () => 0,
  });
}

async function createSource(
  id: string,
  accountId: string,
  name: string,
  options: { status?: "ready" | "index" | "error"; readyGeneration?: number | null } = {}
): Promise<void> {
  await storageRuntime().ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,size_bytes,status,ready_generation)
     VALUES (?,?,?,'tabular',?,?,0,?,?)`,
    [
      id,
      accountId,
      name,
      name,
      `/workspace/${id}.csv`,
      options.status ?? "ready",
      options.readyGeneration === undefined ? 1 : options.readyGeneration,
    ]
  );
}

interface CreatedResult {
  readonly runId: string;
  readonly resultId: string;
}

async function publishResult(
  accountId: string,
  analysisId: string,
  input: {
    columns: readonly string[];
    rows: readonly (readonly (string | number | boolean | null)[])[];
    values?: Record<string, unknown>;
    truncated?: boolean;
  }
): Promise<CreatedResult> {
  const store = storageRuntime().analyses;
  const { run } = await store.acceptAnalysisRun(accountId, analysisId, { values: input.values });
  await store.markAnalysisRunRunning(accountId, analysisId, run.id);
  const published = await store.publishAnalysisRunResult(accountId, analysisId, run.id, {
    id: randomUUID(),
    columns: [...input.columns],
    rows: input.rows.map((row) => [...row]),
    truncated: input.truncated ?? false,
  });
  if (published.status !== "published") throw new Error("expected publication");
  return { runId: run.id, resultId: published.result.id };
}

async function createDefinition(
  app: FastifyInstance,
  body: Record<string, unknown> = {}
): Promise<Record<string, any>> {
  const response = await app.inject({
    method: "POST",
    url: "/api/analyses",
    headers: ownerAuth,
    body: { title: "Monthly spend", sql: "SELECT 1", ...body },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function insertCapture(accountId: string, sql: string, sources: readonly unknown[]): Promise<string> {
  const chatId = randomUUID();
  const runId = randomUUID();
  const captureId = randomUUID();
  const ledger = storageRuntime().ledger;
  await ledger.run("INSERT INTO chats (id,account_id,title,model) VALUES (?,?,'Origin','test-model')", [
    chatId,
    accountId,
  ]);
  await ledger.run("INSERT INTO chat_runs (id,account_id,chat_id,status,finished_at) VALUES (?,?,?,'completed',?)", [
    runId,
    accountId,
    chatId,
    "2026-01-01T00:00:00.000Z",
  ]);
  await ledger.run("INSERT INTO query_captures (id,account_id,run_id,sql,sources) VALUES (?,?,?,?,?)", [
    captureId,
    accountId,
    runId,
    sql,
    JSON.stringify(sources),
  ]);
  return captureId;
}

describe("analysis routes — auth and body boundaries", () => {
  it("rejects every surface unauthenticated before any parsing or store work", async () => {
    const app = await buildApp();
    const bigBody = { title: "x", sql: "S".repeat(300_000) };
    const probes: Array<[string, string, unknown?]> = [
      ["GET", "/api/analyses"],
      ["POST", "/api/analyses", bigBody],
      ["GET", "/api/analyses/11111111-1111-4111-8111-111111111111"],
      ["POST", "/api/analyses/from-query", { capture_id: randomUUID(), title: "x" }],
      ["POST", "/api/analyses/11111111-1111-4111-8111-111111111111/runs", {}],
      ["GET", "/api/analyses/11111111-1111-4111-8111-111111111111/results"],
      [
        "GET",
        "/api/analyses/11111111-1111-4111-8111-111111111111/compare?left=11111111-1111-4111-8111-111111111111&right=22222222-2222-4222-8222-222222222222",
      ],
    ];
    for (const [method, url, body] of probes) {
      const response = await app.inject({
        method: method as "GET" | "POST",
        url,
        ...(body === undefined ? {} : { body: body as object }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("rejects oversized authenticated bodies at the derived ceiling", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/analyses",
      headers: ownerAuth,
      // Above the derived definition ceiling (≈1.1 MB) the parser boundary
      // refuses before schema or store work.
      body: { title: "x", sql: "S".repeat(1_500_000) },
    });
    expect(response.statusCode).toBe(413);
  });

  it("validates the definition contract before the store", async () => {
    const app = await buildApp();
    const badParam = await app.inject({
      method: "POST",
      url: "/api/analyses",
      headers: ownerAuth,
      body: { title: "x", sql: "SELECT ?", parameters: [{ name: "1bad", type: "string" }] },
    });
    expect(badParam.statusCode).toBe(400);

    const longSql = await app.inject({
      method: "POST",
      url: "/api/analyses",
      headers: ownerAuth,
      body: { title: "x", sql: "SELECT " + "1".repeat(20_000) },
    });
    expect(longSql.statusCode).toBe(400);

    const tooManyParams = await app.inject({
      method: "POST",
      url: "/api/analyses",
      headers: ownerAuth,
      body: {
        title: "x",
        sql: "SELECT ?",
        parameters: Array.from({ length: 21 }, (_, index) => ({ name: `p${index}`, type: "string" })),
      },
    });
    expect(tooManyParams.statusCode).toBe(400);
  });
});

describe("analysis routes — definitions", () => {
  it("creates, details, keyset-paginates, edits with CAS, and deletes", async () => {
    const app = await buildApp();
    const sourceId = randomUUID();
    await createSource(sourceId, OWNER, "ledger.csv");

    const created = await createDefinition(app, {
      sql: "SELECT month, amount FROM ledger WHERE month = ?",
      description: "Monthly totals",
      parameters: [{ name: "month", type: "string", required: true }],
      source_ids: [sourceId],
      comparison_key: ["month"],
    });
    expect(created.title).toBe("Monthly spend");

    const detail = await app.inject({ method: "GET", url: `/api/analyses/${created.id}`, headers: ownerAuth });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body).toMatchObject({
      id: created.id,
      current_revision: 1,
      sql: "SELECT month, amount FROM ledger WHERE month = ?",
      source_ids: [sourceId],
      comparison_key: ["month"],
    });
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({ source_id: sourceId, ready_generation: 1 });

    // Pagination is endpoint-bound.
    await createDefinition(app, { title: "Second" });
    await createDefinition(app, { title: "Third" });
    const firstPage = await app.inject({
      method: "GET",
      url: "/api/analyses?limit=2",
      headers: ownerAuth,
    });
    expect(firstPage.json().items).toHaveLength(2);
    const cursor = firstPage.json().next_cursor as string;
    expect(cursor).toBeTruthy();
    const secondPage = await app.inject({
      method: "GET",
      url: `/api/analyses?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: ownerAuth,
    });
    expect(secondPage.json().items).toHaveLength(1);

    const foreignCursor = encodeCatalogCursor("reports", { timestamp: "2026-01-01T00:00:00.000Z", id: randomUUID() });
    const wrongEndpoint = await app.inject({
      method: "GET",
      url: `/api/analyses?cursor=${encodeURIComponent(foreignCursor)}`,
      headers: ownerAuth,
    });
    expect(wrongEndpoint.statusCode).toBe(400);
    expect(wrongEndpoint.json()).toMatchObject({ code: "INVALID_CATALOG_CURSOR" });

    // CAS edit: bump then stale bump.
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/analyses/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, title: "Renamed", comparison_key: null },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ current_revision: 2, title: "Renamed", comparison_key: null });

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/analyses/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, title: "Conflict" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "ANALYSIS_REVISION_CONFLICT" });

    // Selected-empty survives an explicit empty rewrite and never widens.
    const emptied = await app.inject({
      method: "PATCH",
      url: `/api/analyses/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 2, source_ids: [] },
    });
    expect(emptied.json().source_ids).toEqual([]);

    const removed = await app.inject({ method: "DELETE", url: `/api/analyses/${created.id}`, headers: ownerAuth });
    expect(removed.statusCode).toBe(200);
    const afterDelete = await app.inject({ method: "GET", url: `/api/analyses/${created.id}`, headers: ownerAuth });
    expect(afterDelete.statusCode).toBe(404);
  });

  it("never binds a source owned by another account", async () => {
    const app = await buildApp();
    const foreignSource = randomUUID();
    await createSource(foreignSource, FOREIGN, "foreign.csv");
    const response = await app.inject({
      method: "POST",
      url: "/api/analyses",
      headers: ownerAuth,
      body: { title: "Stolen scope", sql: "SELECT 1", source_ids: [foreignSource] },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "ANALYSIS_NOT_FOUND" });
  });

  it("isolates every subresource from other accounts", async () => {
    const app = await buildApp();
    const created = await createDefinition(app);
    const probes: Array<[string, string]> = [
      ["GET", `/api/analyses/${created.id}`],
      ["DELETE", `/api/analyses/${created.id}`],
      ["GET", `/api/analyses/${created.id}/runs`],
      ["POST", `/api/analyses/${created.id}/runs`],
      ["GET", `/api/analyses/${created.id}/results`],
      [
        "GET",
        `/api/analyses/${created.id}/compare?left=11111111-1111-4111-8111-111111111111&right=22222222-2222-4222-8222-222222222222`,
      ],
    ];
    for (const [method, url] of probes) {
      const response = await app.inject({ method: method as "GET" | "POST", url, headers: foreignAuth, body: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    const foreignRuns = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/runs`,
      headers: foreignAuth,
    });
    expect(foreignRuns.statusCode).toBe(404);
  });
});

describe("analysis routes — durable runs", () => {
  it("accepts with 202, replays by operation UUID, enforces one-active, and cancels idempotently", async () => {
    const app = await buildApp();
    bindStubRunner();
    const created = await createDefinition(app, {
      sql: "SELECT ? AS month",
      parameters: [{ name: "month", type: "string", required: true }],
    });

    const operationId = randomUUID();
    const accepted = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: { values: { month: "2026-01" }, operation_id: operationId },
    });
    expect(accepted.statusCode).toBe(202);
    const run = accepted.json();
    expect(run.outcome).toBe("queued");
    expect(run.run.status).toBe("queued");
    expect(run.run.parameter_values).toEqual([{ name: "month", type: "string", value: "2026-01" }]);

    const replay = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: { values: { month: "2026-01" }, operation_id: operationId },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ outcome: "replayed" });
    expect(replay.json().run.id).toBe(run.run.id);

    const second = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: { values: { month: "2026-02" } },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "ANALYSIS_ACTIVE_RUN" });

    const state = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/runs/${run.run.id}`,
      headers: ownerAuth,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ status: "queued" });

    const cancel = await app.inject({
      method: "DELETE",
      url: `/api/analyses/${created.id}/runs/${run.run.id}`,
      headers: ownerAuth,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ ok: true, status: "cancelled" });

    const cancelAgain = await app.inject({
      method: "DELETE",
      url: `/api/analyses/${created.id}/runs/${run.run.id}`,
      headers: ownerAuth,
    });
    expect(cancelAgain.statusCode).toBe(200);
    expect(cancelAgain.json()).toMatchObject({ ok: true, status: "cancelled" });
  });

  it("validates typed values and the expected revision at acceptance", async () => {
    const app = await buildApp();
    bindStubRunner();
    const created = await createDefinition(app, {
      sql: "SELECT ?",
      parameters: [{ name: "month", type: "string", required: true }],
    });
    const missing = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "ANALYSIS_VALIDATION" });

    const badRevision = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: { values: { month: "2026-01" }, expected_revision: 99 },
    });
    expect(badRevision.statusCode).toBe(409);
    expect(badRevision.json()).toMatchObject({ code: "ANALYSIS_REVISION_CONFLICT" });

    const mistyped = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: { values: { month: 5 } },
    });
    expect(mistyped.statusCode).toBe(400);
    expect(mistyped.json()).toMatchObject({ code: "ANALYSIS_VALIDATION" });
  });

  it("records stale inputs durably when a bound source is not ready", async () => {
    const app = await buildApp();
    bindStubRunner();
    const sourceId = randomUUID();
    await createSource(sourceId, OWNER, "wip.csv", { status: "index", readyGeneration: null });
    const created = await createDefinition(app, { source_ids: [sourceId] });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      outcome: "stale-inputs",
      run: { status: "stale-inputs", error_code: "ANALYSIS_INPUTS_UNAVAILABLE" },
    });
  });

  it("fails with the quota error before execution when 1,000 results are retained", async () => {
    const app = await buildApp();
    bindStubRunner();
    const created = await createDefinition(app);
    const ledger = storageRuntime().ledger;
    // Set-based seeding keeps the quota boundary fast under parallel load.
    await ledger.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
         INSERT INTO analysis_runs
           (id,account_id,analysis_id,revision,status,cancel_requested,parameter_values,created_at,finished_at)
         SELECT printf('00000000-0000-4000-8000-%012x', i),?,?,1,'succeeded',0,'[]',
                '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z'
         FROM n`,
      [OWNER, created.id]
    );
    await ledger.run(
      `INSERT INTO analysis_results
           (id,account_id,analysis_id,run_id,revision,columns,rows,returned_rows,row_count_exact,
            completeness,parameter_values,source_provenance,created_at)
         SELECT printf('f0000000-0000-4000-8000-%012x', r.rn),?,?,r.id,1,
                '[{"name":"a","type":"number"}]','[[1]]',1,1,
                '{"complete":true,"reasons":[]}','[]','[]','2026-01-01T00:00:01.000Z'
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM analysis_runs WHERE analysis_id=?) r`,
      [OWNER, created.id, created.id]
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ANALYSIS_RESULT_QUOTA_EXCEEDED" });
  }, 30_000);

  it("cancels and drains active work before deleting an analysis", async () => {
    const app = await buildApp();
    bindStubRunner();
    const created = await createDefinition(app);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    const runId = accepted.json().run.id as string;
    const store = storageRuntime().analyses;
    await store.markAnalysisRunRunning(OWNER, created.id, runId);

    // The "executor" observes the durable cancellation shortly after the
    // DELETE requests it; the route's bounded drain then completes the delete.
    setTimeout(() => {
      void store.finishAnalysisRun(OWNER, created.id, runId, "failed").catch(() => undefined);
    }, 250);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/analyses/${created.id}`,
      headers: ownerAuth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("reports the execution service as unavailable (503) when none is registered", async () => {
    const app = await buildApp();
    const created = await createDefinition(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/analyses/${created.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "ANALYSIS_SERVICE_UNAVAILABLE" });
  });
});

describe("analysis routes — results, compare, export, chart", () => {
  it("lists and serves result details without leaking raw rows into summaries, then deletes", async () => {
    const app = await buildApp();
    const created = await createDefinition(app, { comparison_key: ["label"] });
    const { resultId } = await publishResult(OWNER, created.id, {
      columns: ["label", "amount"],
      rows: [
        ["a", 1],
        ["b", 2],
      ],
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/results`,
      headers: ownerAuth,
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: resultId, returned_rows: 2, complete: true });
    expect(items[0]).not.toHaveProperty("rows");

    const detail = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/results/${resultId}`,
      headers: ownerAuth,
    });
    expect(detail.json().rows).toEqual([
      ["a", 1],
      ["b", 2],
    ]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/analyses/${created.id}/results/${resultId}`,
      headers: ownerAuth,
    });
    expect(removed.statusCode).toBe(200);
    const again = await app.inject({
      method: "DELETE",
      url: `/api/analyses/${created.id}/results/${resultId}`,
      headers: ownerAuth,
    });
    expect(again.statusCode).toBe(404);
  });

  it("compares keyed results with deltas and always reports provenance diffs", async () => {
    const app = await buildApp();
    const created = await createDefinition(app, {
      comparison_key: ["label"],
      parameters: [{ name: "month", type: "string", required: true, nullable: false }],
    });
    const left = await publishResult(OWNER, created.id, {
      columns: ["label", "amount"],
      rows: [["a", 10]],
      values: { month: "2026-01" },
    });
    const right = await publishResult(OWNER, created.id, {
      columns: ["label", "amount"],
      rows: [
        ["a", 14],
        ["c", 7],
      ],
      values: { month: "2026-02" },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/compare?left=${left.resultId}&right=${right.resultId}`,
      headers: ownerAuth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: "keyed",
      key_columns: ["label"],
      reason_code: null,
      exhaustive: true,
      parameters: { changed: [{ name: "month", left: "2026-01", right: "2026-02" }] },
      changed: [{ key: ["a"], changes: [{ column: "amount", before: 10, after: 14, delta: 4 }] }],
      added: [["c", 7]],
    });
  });

  it("surfaces explicit unsupported reasons and side-by-side previews", async () => {
    const app = await buildApp();
    const keyed = await createDefinition(app, { title: "Dup key", comparison_key: ["label"] });
    const dupLeft = await publishResult(OWNER, keyed.id, { columns: ["label", "v"], rows: [["x", 1]] });
    const dupRight = await publishResult(OWNER, keyed.id, {
      columns: ["label", "v"],
      rows: [
        ["x", 1],
        ["x", 2],
      ],
    });
    const dup = await app.inject({
      method: "GET",
      url: `/api/analyses/${keyed.id}/compare?left=${dupLeft.resultId}&right=${dupRight.resultId}`,
      headers: ownerAuth,
    });
    expect(dup.json()).toMatchObject({ mode: "side-by-side", reason_code: "key-value-duplicate" });
    expect(dup.json().right_table.rows).toHaveLength(2);

    // A changed stored column type is unsupported for keyed diffs too.
    const typedRight = await publishResult(OWNER, keyed.id, {
      columns: ["label", "v"],
      rows: [["x", "text"]],
    });
    const typed = await app.inject({
      method: "GET",
      url: `/api/analyses/${keyed.id}/compare?left=${dupLeft.resultId}&right=${typedRight.resultId}`,
      headers: ownerAuth,
    });
    expect(typed.json()).toMatchObject({ mode: "side-by-side", reason_code: "column-type-changed" });

    // No key configured: side-by-side only, no invented identity.
    const unkeyed = await createDefinition(app, { title: "No key" });
    const uLeft = await publishResult(OWNER, unkeyed.id, { columns: ["a"], rows: [[1]] });
    const uRight = await publishResult(OWNER, unkeyed.id, { columns: ["a"], rows: [[2]] });
    const unkeyedCompare = await app.inject({
      method: "GET",
      url: `/api/analyses/${unkeyed.id}/compare?left=${uLeft.resultId}&right=${uRight.resultId}`,
      headers: ownerAuth,
    });
    expect(unkeyedCompare.json()).toMatchObject({
      mode: "side-by-side",
      reason_code: "no-comparison-key",
    });
    expect(unkeyedCompare.json().added).toBeUndefined();
  });

  it("labels truncated results as previews in comparisons", async () => {
    const app = await buildApp();
    const created = await createDefinition(app, { comparison_key: ["id"] });
    const left = await publishResult(OWNER, created.id, {
      columns: ["id", "v"],
      rows: [["a", 1]],
      truncated: true,
    });
    const right = await publishResult(OWNER, created.id, {
      columns: ["id", "v"],
      rows: [["a", 2]],
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/compare?left=${left.resultId}&right=${right.resultId}`,
      headers: ownerAuth,
    });
    const comparison = response.json();
    expect(comparison.exhaustive).toBe(false);
    expect(comparison.changed_total).toBeNull();
    expect(comparison.left_table.complete).toBe(false);
  });

  it("exports the stored snapshot only, with CSV formula safety and typed JSON", async () => {
    const app = await buildApp();
    const created = await createDefinition(app, { title: "Formula check" });
    const { resultId } = await publishResult(OWNER, created.id, {
      columns: ["label", "amount"],
      rows: [
        ["=cmd|'/C calc'!A0", 3],
        [null, -4.5],
      ],
    });

    const csv = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/results/${resultId}/export?format=csv`,
      headers: ownerAuth,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain('attachment; filename="');
    expect(csv.body).toContain("'=cmd|'/C calc'!A0,3");
    expect(csv.body).toContain("null,-4.5");

    const json = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/results/${resultId}/export?format=json`,
      headers: ownerAuth,
    });
    const parsed = JSON.parse(json.body) as { rows: unknown[][]; partial: boolean };
    expect(parsed.rows[0]).toEqual(["=cmd|'/C calc'!A0", 3]);
    expect(parsed.partial).toBe(false);

    const manifest = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/results/${resultId}/export?format=manifest`,
      headers: ownerAuth,
    });
    const manifestBody = JSON.parse(manifest.body) as Record<string, unknown>;
    expect(manifestBody.artifact).toBe("analysis_result_manifest");
    expect(manifestBody.rows).toBeUndefined();

    const badFormat = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/results/${resultId}/export?format=xlsx`,
      headers: ownerAuth,
    });
    expect(badFormat.statusCode).toBe(400);
  });

  it("serves a canonical chart-spec copy bound to the result id", async () => {
    const app = await buildApp();
    const created = await createDefinition(app, { title: "Chart me" });
    const chartable = await publishResult(OWNER, created.id, {
      columns: ["month", "spend"],
      rows: [
        ["2026-01", 10],
        ["2026-02", 15],
      ],
    });
    const chart = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/results/${chartable.resultId}/chart`,
      headers: ownerAuth,
    });
    expect(chart.statusCode).toBe(200);
    const payload = chart.json();
    expect(payload.result_id).toBe(chartable.resultId);
    expect(payload.spec).toMatchObject({
      type: "bar",
      title: "Chart me",
      categories: ["2026-01", "2026-02"],
    });
    expect(payload.spec.series).toEqual([
      { name: "spend", data: [10, 15], color: expect.stringMatching(/^#[0-9a-fA-F]{6}$/) },
    ]);

    const textOnly = await publishResult(OWNER, created.id, { columns: ["note"], rows: [["nope"]] });
    const unchartable = await app.inject({
      method: "GET",
      url: `/api/analyses/${created.id}/results/${textOnly.resultId}/chart`,
      headers: ownerAuth,
    });
    expect(unchartable.statusCode).toBe(400);
    expect(unchartable.json()).toMatchObject({ code: "ANALYSIS_RESULT_NOT_CHARTABLE" });
  });
});

describe("analysis routes — full-query capture promotion", () => {
  it("promotes only a verified capture, preserving full SQL and exact provenance", async () => {
    const app = await buildApp();
    const sourceId = randomUUID();
    await createSource(sourceId, OWNER, "ledger.csv");
    const fullSql =
      "SELECT month, SUM(amount) AS total FROM ledger WHERE month >= '2025-01' GROUP BY month " +
      "HAVING SUM(amount) > 0 ORDER BY total DESC LIMIT 500".padEnd(
        1_600,
        " /* padding proves the capture is stored and served whole, never sliced to the display receipt */"
      );
    const captureId = await insertCapture(OWNER, fullSql, [{ source_id: sourceId, ready_generation: 1 }]);

    const promoted = await app.inject({
      method: "POST",
      url: "/api/analyses/from-query",
      headers: ownerAuth,
      body: { capture_id: captureId, title: "From chat", comparison_key: ["month"] },
    });
    expect(promoted.statusCode).toBe(201);
    const analysis = promoted.json();
    expect(analysis.sql.length).toBeGreaterThan(1_500);
    expect(analysis.sql).toBe(fullSql);
    expect(analysis).toMatchObject({
      title: "From chat",
      source_ids: [sourceId],
      comparison_key: ["month"],
      origin: { capture_id: captureId },
    });
    expect(analysis.origin.run_id).toBeTruthy();
  });

  it("refuses unknown captures — the display-receipt flag alone is never promotable", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/analyses/from-query",
      headers: ownerAuth,
      body: { capture_id: randomUUID(), title: "Legacy receipt" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "ANALYSIS_CAPTURE_NOT_PROMOTABLE" });
  });

  it("never widens or silently drops a captured source that was deleted", async () => {
    const app = await buildApp();
    const sourceId = randomUUID();
    await createSource(sourceId, OWNER, "gone.csv");
    const captureId = await insertCapture(OWNER, "SELECT 1", [{ source_id: sourceId, ready_generation: 1 }]);
    await storageRuntime().ledger.run("DELETE FROM sources WHERE id=?", [sourceId]);
    const response = await app.inject({
      method: "POST",
      url: "/api/analyses/from-query",
      headers: ownerAuth,
      body: { capture_id: captureId, title: "Stale capture" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "ANALYSIS_INPUTS_UNAVAILABLE" });
  });

  it("rejects another account's capture id without revealing existence", async () => {
    const app = await buildApp();
    const captureId = await insertCapture(OWNER, "SELECT 1", []);
    const response = await app.inject({
      method: "POST",
      url: "/api/analyses/from-query",
      headers: foreignAuth,
      body: { capture_id: captureId, title: "Mine?" },
    });
    expect(response.statusCode).toBe(404);
  });
});
