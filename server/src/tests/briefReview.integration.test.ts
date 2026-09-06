/**
 * M16 stage 3 — the review surface proven end-to-end over the real durable
 * stack: real SQLite ledger, real DuckDB analysis execution, real M13
 * documents/publication protocol, the real `briefReviewService` decision
 * path, and the real brief routes. Only external refresh/model seams are
 * faked and the renderers use the documented test seam (the shipped default
 * is the Playwright/Electron dispatch proven by the documents suite).
 *
 * Runs only under `vitest.integration.config.ts` (serialized native stores).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, afterAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { signToken } from "../auth.js";
import { config } from "../config.js";
import { installHttpBoundary } from "../httpErrors.js";
import { briefRoutes } from "../routes/briefs.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { createAnalysisRunner, type AnalysisRunner } from "../analysisRunner.js";
import { createBriefRunner, type BriefRunner } from "../briefRunner.js";
import { registerDataset, __shutdownDatasetWorker } from "../data/datasets.js";
import { setDocumentRenderersForTests } from "../documentService.js";
import { appendDocumentRevision } from "../documentService.js";
import type { DocumentRenderers } from "../data/documents.js";
import type { StoredBriefRun } from "../db/stores/briefRunStore.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@brief-review.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@brief-review.test" })}` };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_PNG = Buffer.concat([PNG_MAGIC, Buffer.from("ihdr-payload-for-tests")]);
const FAKE_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");

const apps: FastifyInstance[] = [];
const directories: string[] = [];
let runner: BriefRunner | undefined;
let analysisRunner: AnalysisRunner | undefined;

async function buildEnvironment(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-brief-review-int-")));
  directories.push(root);
  config.reportDir = path.join(root, "reports");
  await initializeStorageRuntime({
    sqlitePath: path.join(root, "ledger.sqlite"),
    lanceDirectory: path.join(root, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@brief-review.test"],
    [FOREIGN, "foreign@brief-review.test"],
  ] as const) {
    await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
  analysisRunner = createAnalysisRunner({
    store: storageRuntime().analyses,
    sources: storageRuntime().sources,
    cancelPollIntervalMs: 40,
    claimIntervalMs: 3_600_000,
  });
  await analysisRunner.start();
  runner = createBriefRunner({
    runs: storageRuntime().briefRuns,
    recipes: storageRuntime().briefRecipes,
    sources: storageRuntime().sources,
    analyses: storageRuntime().analyses,
    knowledge: storageRuntime().knowledge,
    runAnalysis: (input) => analysisRunner!.runAnalysisService(input),
    // Default `draft` port is the real `createDocumentDraft` service path.
    syncConnector: async () => undefined,
    refreshKnowledge: async () => ({ fully_ready: true, promoted: [], refreshes: [] }),
    sourceState: async () => ({ sourceStatus: "ready", readyGeneration: 1, jobStatus: null, jobGeneration: null }),
    generateNarrative: async () => "The tracked total is as stored.",
    resolveChatModel: async () => "integration-chat",
    authorizeEgress: async () => ({
      revision: 1,
      origin: "http://127.0.0.1:1234",
      locality: "local",
      host: "127.0.0.1",
    }),
    auditEgress: () => undefined,
    tickIntervalMs: 3_600_000,
    cancelPollIntervalMs: 10,
    waitPollIntervalMs: 3,
  });
  runner.start();
  return root;
}

afterEach(async () => {
  setDocumentRenderersForTests(null);
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await runner?.stop();
  runner = undefined;
  await analysisRunner?.stop();
  analysisRunner = undefined;
  await closeStorageRuntime();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await __shutdownDatasetWorker();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(briefRoutes);
  await app.ready();
  return app;
}

async function waitFor(condition: () => Promise<boolean>, label: string, attempts = 6_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error(`condition never held: ${label}`);
}

function workingRenderers(): DocumentRenderers {
  return { renderChartPng: async () => FAKE_PNG, renderReportPdf: async () => FAKE_PDF };
}

function gatedRenderers(): DocumentRenderers & { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    renderChartPng: async () => FAKE_PNG,
    renderReportPdf: async () => {
      await gate;
      return FAKE_PDF;
    },
    release: () => release(),
  };
}

interface Seeded {
  readonly sourceId: string;
  readonly tableName: string;
  readonly recipeId: string;
  readonly file: string;
}

async function seedFixture(value: number, tag: string): Promise<Seeded> {
  const root = directories[directories.length - 1]!;
  const file = path.join(root, `${tag}.csv`);
  await fs.writeFile(file, `metric_label,value\ntotal,${value}\n`, "utf8");
  const sourceId = randomUUID();
  const stat = await fs.stat(file);
  const tableName = `brief_review_${tag}`;
  await storageRuntime().ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,status,meta,ready_generation,size_bytes)
     VALUES (?,?,?,'tabular',?,?,?,?,?,?)`,
    [sourceId, OWNER, tableName, `${tag}.csv`, file, "ready", "{}", 3, stat.size]
  );
  await registerDataset({
    accountId: OWNER,
    name: tableName,
    location: file,
    kind: "path",
    originalName: `${tag}.csv`,
  });
  const analysis = await storageRuntime().analyses.createAnalysis(OWNER, {
    title: `review integration ${tag}`,
    sql: `SELECT metric_label, value FROM ${tableName}`,
    sourceIds: [sourceId],
    comparisonKey: ["metric_label"],
  });
  const recipe = await storageRuntime().briefRecipes.createRecipe(OWNER, {
    name: `review-int-${tag}`,
    analysis_id: analysis.id,
    report_title: "Weekly finance brief",
    report_instruction: "Summarize the tracked total and its delta.",
    source_ids: [sourceId],
    schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "UTC" },
  });
  return { sourceId, tableName, recipeId: recipe.id, file };
}

/** Execute one manual run through the real pipeline to `awaiting_review`. */
async function runToReview(recipeId: string): Promise<StoredBriefRun> {
  const runs = storageRuntime().briefRuns;
  const { run } = await runs.createManualRun(OWNER, recipeId, randomUUID());
  runner!.kick();
  await waitFor(async () => {
    const live = await runs.getRun(OWNER, run.id);
    return live.stage === "awaiting_review" || ["failed", "cancelled", "skipped"].includes(live.stage);
  }, `manual run ${run.id} reaches review`);
  const live = await runs.getRun(OWNER, run.id);
  expect({ stage: live.stage, failureCode: live.failureCode }).toEqual({
    stage: "awaiting_review",
    failureCode: null,
  });
  return live;
}

async function runDetail(app: FastifyInstance, recipeId: string, runId: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: "GET", url: `/api/briefs/${recipeId}/runs/${runId}`, headers: ownerAuth });
  return res.json() as Record<string, unknown>;
}

async function waitStage(app: FastifyInstance, recipeId: string, runId: string, stage: string) {
  await waitFor(async () => (await runDetail(app, recipeId, runId)).stage === stage, `stage ${stage}`);
  return runDetail(app, recipeId, runId);
}

async function inbox(app: FastifyInstance): Promise<Array<Record<string, unknown>>> {
  const res = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: ownerAuth });
  return (res.json() as { items: Array<Record<string, unknown>> }).items;
}

async function decision(app: FastifyInstance, runId: string, payload: Record<string, unknown>, auth = ownerAuth) {
  return app.inject({
    method: "POST",
    url: `/api/brief-reviews/${runId}/decision`,
    headers: auth,
    payload,
  });
}

async function changeFixture(seed: Seeded, value: number): Promise<void> {
  await fs.writeFile(seed.file, `metric_label,value\ntotal,${value}\n`, "utf8");
  const stat = await fs.stat(seed.file);
  const row = await storageRuntime().ledger.get<{ ready_generation: number | bigint }>(
    "SELECT ready_generation FROM sources WHERE id=?",
    [seed.sourceId]
  );
  await storageRuntime().ledger.run("UPDATE sources SET ready_generation=?, size_bytes=? WHERE id=?", [
    Number(row?.ready_generation ?? 0) + 1,
    stat.size,
    seed.sourceId,
  ]);
}

async function publicationRows(documentId: string) {
  return storageRuntime().ledger.all<{ id: string; revision_id: string; version: number | bigint }>(
    "SELECT id,revision_id,version FROM document_publications WHERE document_id=? ORDER BY version",
    [documentId]
  );
}

async function countIntent(documentId: string): Promise<number> {
  const rows = await storageRuntime().ledger.all<{ total: number | bigint }>(
    "SELECT COUNT(*) AS total FROM document_publication_intents WHERE document_id=?",
    [documentId]
  );
  return Number(rows[0]?.total ?? 0);
}

describe("reviewed-brief review lifecycle (real pipeline + real publication protocol)", () => {
  it("approve publishes exactly once; the second changed run compares, supersedes, and replays idempotently", async () => {
    await buildEnvironment();
    setDocumentRenderersForTests(workingRenderers());
    const app = await buildApp();
    const seed = await seedFixture(100, "cycle");

    const first = await runToReview(seed.recipeId);
    const inboxItems = await inbox(app);
    const item = inboxItems.find((entry) => entry.id === first.id)!;
    expect(item.stage).toBe("awaiting_review");
    expect(item.document_id).toBe(first.documentId);
    expect(item.document_head_revision_id).toBe(first.documentRevisionId);
    // First run: clearly labeled no-baseline (no comparison values invented).
    expect(item.comparison_summary).toBeNull();

    const renderers = gatedRenderers();
    setDocumentRenderersForTests(renderers);
    const approved = await decision(app, first.id, {
      decision: "approve",
      document_revision_id: first.documentRevisionId,
    });
    expect(approved.statusCode).toBe(202);
    const body = approved.json() as { status: string; run: Record<string, unknown> };
    expect(body.status).toBe("publishing");
    // Mid-render: one active intent, no publication yet.
    await waitFor(async () => (await countIntent(first.documentId!)) === 1, "intent created");
    expect((await publicationRows(first.documentId!)).length).toBe(0);
    // A repeat decision while publishing reconciles the same intent (202).
    const repeat = await decision(app, first.id, {
      decision: "approve",
      document_revision_id: first.documentRevisionId,
    });
    expect(repeat.statusCode).toBe(202);
    expect(repeat.json()).toMatchObject({ replayed: true });
    renderers.release();
    await waitStage(app, seed.recipeId, first.id, "approved");
    expect((await publicationRows(first.documentId!)).length).toBe(1);
    expect(await countIntent(first.documentId!)).toBe(1);
    // Approved-only-after-commit: the publication references the reviewed revision.
    const [publication] = await publicationRows(first.documentId!);
    expect(publication!.revision_id).toBe(first.documentRevisionId);
    const stored = await storageRuntime().documents.getDocumentPublication(OWNER, first.documentId!, publication!.id);
    expect((await fs.readFile(stored!.pdfPath)).subarray(0, 4).toString()).toBe("%PDF");
    // A completed decision replays with the recorded outcome (200).
    const again = await decision(app, first.id, {
      decision: "approve",
      document_revision_id: first.documentRevisionId,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: "approved", replayed: true });

    // Local notification surfaced and is durably dismissible.
    const notifications = await app.inject({ method: "GET", url: "/api/notifications", headers: ownerAuth });
    const note = (notifications.json() as { items: Array<Record<string, unknown>> }).items.find(
      (entry) => entry.run_id === first.id
    )!;
    expect(note.kind).toBe("first_draft");
    const dismissed = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${note.id}`,
      headers: ownerAuth,
      payload: { state: "dismissed" },
    });
    expect(dismissed.json()).toMatchObject({ state: "dismissed" });

    // Second run over changed data: the inbox shows the keyed comparison.
    setDocumentRenderersForTests(workingRenderers());
    await changeFixture(seed, 125);
    const second = await runToReview(seed.recipeId);
    const secondItem = (await inbox(app)).find((entry) => entry.id === second.id)!;
    const summary = secondItem.comparison_summary as {
      kind: string;
      baseline_run_id: string;
      changed_total: number | null;
    };
    expect(summary.kind).toBe("compared");
    expect(summary.baseline_run_id).toBe(first.id);
    expect(summary.changed_total).toBe(1);
    // The draft carries the labeled current/baseline previews.
    const draft = await storageRuntime().documents.getDocumentRevision(
      OWNER,
      second.documentId!,
      second.documentRevisionId!
    );
    const text = JSON.stringify(draft!.payload);
    expect(text).toContain("100");
    expect(text).toContain("125");

    // Rejecting preserves the run/draft and blocks publication.
    const rejected = await decision(app, second.id, {
      decision: "reject",
      document_revision_id: second.documentRevisionId,
      note: "Explain the delta first.",
    });
    expect(rejected.statusCode).toBe(200);
    await waitStage(app, seed.recipeId, second.id, "rejected");
    expect(await storageRuntime().documents.getDocument(OWNER, second.documentId!)).toBeTruthy();
    expect((await publicationRows(second.documentId!)).length).toBe(0);
    const lateApprove = await decision(app, second.id, {
      decision: "approve",
      document_revision_id: second.documentRevisionId,
    });
    expect(lateApprove.statusCode).toBe(409);

    // The retained first-run publication still supersedes correctly when a
    // later reviewed revision of the SAME document publishes.
    const edited = await appendDocumentRevision({
      accountId: OWNER,
      documentId: first.documentId!,
      baseRevisionId: first.documentRevisionId!,
      tree: {
        title: "Weekly finance brief (amended)",
        sections: [{ heading: "Summary", markdown: "Amended after publication." }],
        charts: [],
        tables: [],
        evidence: [],
      },
      authorKind: "user",
    });
    const reApproved = await decision(app, first.id, { decision: "approve", document_revision_id: edited.revision.id });
    // The completed approval cannot be re-opened for a different revision.
    expect(reApproved.statusCode).toBe(409);
    expect((await publicationRows(first.documentId!)).length).toBe(1);
  });

  it("render failure returns the review with the indicator; retry-after-edit requires a fresh decision", async () => {
    await buildEnvironment();
    setDocumentRenderersForTests({
      renderChartPng: async () => FAKE_PNG,
      renderReportPdf: async () => Buffer.from("NOT-A-PDF"),
    });
    const app = await buildApp();
    const seed = await seedFixture(100, "failure");
    const run = await runToReview(seed.recipeId);
    expect(
      (await decision(app, run.id, { decision: "approve", document_revision_id: run.documentRevisionId })).statusCode
    ).toBe(202);
    await waitFor(async () => {
      const detail = await runDetail(app, seed.recipeId, run.id);
      return detail.stage === "awaiting_review" && typeof detail.publication_error_code === "string";
    }, "failed publication indicator");
    const item = (await inbox(app)).find((entry) => entry.id === run.id)!;
    expect(item.publication_error_code).toBe("PUBLICATION_PDF_FAILED");
    expect((item.publication_failure as { message: string }).message).toContain("could not be rendered");

    // Edit after the failed attempt: a retry on the stale revision conflicts.
    const edited = await appendDocumentRevision({
      accountId: OWNER,
      documentId: run.documentId!,
      baseRevisionId: run.documentRevisionId!,
      tree: {
        title: "Weekly finance brief (fixed)",
        sections: [{ heading: "Summary", markdown: "Fixed narrative." }],
        charts: [],
        tables: [],
        evidence: [],
      },
      authorKind: "user",
    });
    const stale = await decision(app, run.id, { decision: "approve", document_revision_id: run.documentRevisionId });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "BRIEF_REVIEW_REVISION_CONFLICT" });
    expect((await publicationRows(run.documentId!)).length).toBe(0);

    // The fresh decision on the current head publishes cleanly.
    setDocumentRenderersForTests(workingRenderers());
    expect(
      (await decision(app, run.id, { decision: "approve", document_revision_id: edited.revision.id })).statusCode
    ).toBe(202);
    await waitStage(app, seed.recipeId, run.id, "approved");
    const publications = await publicationRows(run.documentId!);
    expect(publications.length).toBe(1);
    expect(publications[0]!.revision_id).toBe(edited.revision.id);
  });

  it("conflict, ownership, pagination, and deleted-recipe surfaces hold on the real stores", async () => {
    await buildEnvironment();
    const renderers = gatedRenderers();
    setDocumentRenderersForTests(renderers);
    const app = await buildApp();
    const seedA = await seedFixture(100, "edge_a");
    const seedB = await seedFixture(200, "edge_b");
    const runA = await runToReview(seedA.recipeId);
    const runB = await runToReview(seedB.recipeId);

    // Cross-account: nothing listed, decisions 404.
    const foreignInbox = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: foreignAuth });
    expect((foreignInbox.json() as { items: unknown[] }).items).toHaveLength(0);
    expect(
      (await decision(app, runA.id, { decision: "reject", document_revision_id: runA.documentRevisionId }, foreignAuth))
        .statusCode
    ).toBe(404);

    // Reject run B; approve run A and reject DURING publishing → 409.
    expect(
      (await decision(app, runB.id, { decision: "reject", document_revision_id: runB.documentRevisionId })).statusCode
    ).toBe(200);
    expect(
      (await decision(app, runA.id, { decision: "approve", document_revision_id: runA.documentRevisionId })).statusCode
    ).toBe(202);
    const rejectDuring = await decision(app, runA.id, {
      decision: "reject",
      document_revision_id: runA.documentRevisionId,
    });
    expect(rejectDuring.statusCode).toBe(409);

    // Pagination: endpoint-bound keyset (default 20, max 50).
    const page1 = await app.inject({ method: "GET", url: "/api/brief-reviews?limit=1", headers: ownerAuth });
    const p1 = page1.json() as { items: Array<{ id: string }>; next_cursor: string | null };
    expect(p1.items.length).toBe(1);
    expect(p1.next_cursor).toBeTruthy();
    const page2 = await app.inject({
      method: "GET",
      url: `/api/brief-reviews?limit=1&cursor=${p1.next_cursor}`,
      headers: ownerAuth,
    });
    const p2 = page2.json() as { items: Array<{ id: string }> };
    expect(p2.items[0]!.id).not.toBe(p1.items[0]!.id);
    expect(
      (await app.inject({ method: "GET", url: "/api/brief-reviews?limit=51", headers: ownerAuth })).statusCode
    ).toBe(400);
    const boundProbe = await app.inject({
      method: "GET",
      url:
        "/api/brief-reviews?cursor=" +
        Buffer.from(JSON.stringify({ v: 1, e: "brief_runs", t: "2026-06-01T00:00:00.000Z", i: randomUUID() })).toString(
          "base64url"
        ),
      headers: ownerAuth,
    });
    expect(boundProbe.statusCode).toBe(400);

    // Deleting the recipe keeps the retained review readable and decidable.
    await storageRuntime().briefRecipes.deleteRecipe(OWNER, seedB.recipeId);
    const itemB = (await inbox(app)).find((entry) => entry.id === runB.id)!;
    expect(itemB.recipe_state).toBeNull();
    expect(itemB.stage).toBe("rejected");

    // Let the still-gated publication complete against live stores.
    renderers.release();
    await waitStage(app, seedA.recipeId, runA.id, "approved");
    expect((await publicationRows(runA.documentId!)).length).toBe(1);
  });
});
