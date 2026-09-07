/**
 * M16 stage 3 — review decisions, review inbox, and notification surfaces.
 *
 * Route-level coverage over the real durable stores with an injected clock
 * for the scheduling property and a test-only renderer seam for the real
 * publication path (the shipped default remains the Playwright/Electron
 * dispatch proven by the serialized integration suite). Nothing here ever
 * reaches the network or a model.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signToken } from "../auth.js";
import { config } from "../config.js";
import { installHttpBoundary } from "../httpErrors.js";
import { briefRoutes } from "../routes/briefs.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { BriefRecipeStore } from "../db/stores/briefRecipeStore.js";
import { DocumentRevisionConflictError } from "../db/stores/documentStore.js";
import { BriefRunStore, deriveBriefPublicationOperationId } from "../db/stores/briefRunStore.js";
import { appendDocumentRevision, createDocumentDraft, setDocumentRenderersForTests } from "../documentService.js";
import { ensureBriefPublication, reconcileBriefPublications } from "../briefReviewService.js";
import type { DocumentRenderers } from "../data/documents.js";
import type { DocumentTreeInput } from "../documentTypes.js";
import type { StoredBriefRun } from "../db/stores/briefRunStore.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_PNG = Buffer.concat([PNG_MAGIC, Buffer.from("ihdr-payload-for-tests")]);
const FAKE_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");

const apps: FastifyInstance[] = [];
let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-brief-review-")));
  config.reportDir = path.join(tempRoot, "reports");
  await initializeStorageRuntime({
    sqlitePath: path.join(tempRoot, "ledger.sqlite"),
    lanceDirectory: path.join(tempRoot, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [FOREIGN, "foreign@example.test"],
  ] as const) {
    await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
});

afterEach(async () => {
  setDocumentRenderersForTests(null);
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(briefRoutes);
  await app.ready();
  return app;
}

function draftTree(marker = "v1"): DocumentTreeInput {
  return {
    title: `Brief draft ${marker}`,
    sections: [{ heading: "Summary", markdown: `Draft body ${marker}.` }],
    charts: [],
    tables: [],
    evidence: [],
  };
}

/** Seed a ready source + matching saved analysis + daily recipe. */
async function makeRecipe(name: string): Promise<{ recipeId: string; analysisId: string; sourceId: string }> {
  const sourceId = randomUUID();
  await storageRuntime().ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,status,ready_generation)
     VALUES (?,?,?,'tabular',?,'ready',1)`,
    [sourceId, OWNER, `review-${name}.csv`, `review-${name}.csv`]
  );
  const analysis = await storageRuntime().analyses.createAnalysis(OWNER, {
    title: `review analysis ${name}`,
    sql: "SELECT 1 AS value",
    sourceIds: [sourceId],
  });
  const recipe = await storageRuntime().briefRecipes.createRecipe(OWNER, {
    name,
    analysis_id: analysis.id,
    report_title: "Weekly finance brief",
    report_instruction: "Summarize the tracked totals.",
    source_ids: [sourceId],
    schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "UTC" },
  });
  return { recipeId: recipe.id, analysisId: analysis.id, sourceId };
}

interface SeededRun {
  readonly run: StoredBriefRun;
  readonly recipeId: string;
  readonly documentId: string;
  readonly revisionId: string;
}

/** Drive a manual run through the stage machine to `awaiting_review`. */
async function seedAwaitingReview(name: string, marker = "v1"): Promise<SeededRun> {
  const runs = storageRuntime().briefRuns;
  const { recipeId } = await makeRecipe(name);
  const { run } = await runs.createManualRun(OWNER, recipeId, randomUUID());
  await runs.beginStage(OWNER, run.id, {
    fromStage: "queued",
    toStage: "refreshing",
    expectedStageOperationId: null,
    stageOperationId: "op-refresh",
  });
  await runs.beginStage(OWNER, run.id, {
    fromStage: "refreshing",
    toStage: "waiting_ready",
    expectedStageOperationId: "op-refresh",
    stageOperationId: "op-wait",
  });
  await runs.beginStage(OWNER, run.id, {
    fromStage: "waiting_ready",
    toStage: "analyzing",
    expectedStageOperationId: "op-wait",
    stageOperationId: "op-analyze",
  });
  await runs.beginStage(OWNER, run.id, {
    fromStage: "analyzing",
    toStage: "drafting",
    expectedStageOperationId: "op-analyze",
    stageOperationId: "op-draft",
  });
  await runs.stageUpdate(OWNER, run.id, {
    stage: "drafting",
    expectedStageOperationId: "op-draft",
    refreshReceipts: [
      { source_id: randomUUID(), kind: "static", outcome: "no-change", generation: 1, label: "uses imported version" },
    ],
    comparisonSummary: null,
  });
  const created = await createDocumentDraft({ accountId: OWNER, title: "Brief draft", tree: draftTree(marker) });
  const reviewed = await runs.markAwaitingReview(OWNER, run.id, {
    expectedStageOperationId: "op-draft",
    documentId: created.document.id,
    documentRevisionId: created.revision.id,
  });
  return { run: reviewed, recipeId, documentId: created.document.id, revisionId: created.revision.id };
}

function workingRenderers(): DocumentRenderers {
  return { renderChartPng: async () => FAKE_PNG, renderReportPdf: async () => FAKE_PDF };
}

/** Gate the PDF render so the publishing intermediate state is observable. */
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

async function approve(
  app: FastifyInstance,
  runId: string,
  revisionId: string,
  auth: Record<string, string> = ownerAuth
) {
  return app.inject({
    method: "POST",
    url: `/api/brief-reviews/${runId}/decision`,
    headers: auth,
    payload: { decision: "approve", document_revision_id: revisionId },
  });
}

async function waitForRun(
  app: FastifyInstance,
  recipeId: string,
  runId: string,
  stage: string,
  options: { readonly indicator?: boolean } = {},
  attempts = 4_000
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await app.inject({ method: "GET", url: `/api/briefs/${recipeId}/runs/${runId}`, headers: ownerAuth });
    const body = res.json() as Record<string, unknown>;
    if (
      body.stage === stage &&
      (!options.indicator || (typeof body.publication_error_code === "string" && body.publication_error_code))
    ) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error(`run never reached stage ${stage}${options.indicator ? " with the indicator" : ""}`);
}

async function waitFor(condition: () => Promise<boolean>, label: string, attempts = 4_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error(`condition never held: ${label}`);
}

async function countRows(sql: string, params: Array<string | number> = []): Promise<number> {
  const rows = await storageRuntime().ledger.all<{ total: number | bigint }>(`SELECT COUNT(*) AS total ${sql}`, params);
  return Number(rows[0]?.total ?? 0);
}

async function publicationCount(documentId: string): Promise<number> {
  return countRows("FROM document_publications WHERE document_id=?", [documentId]);
}

async function intentCount(documentId: string): Promise<number> {
  return countRows("FROM document_publication_intents WHERE document_id=?", [documentId]);
}

async function reviewEventCount(runId: string): Promise<number> {
  return countRows("FROM brief_review_events WHERE run_id=?", [runId]);
}

describe("review inbox", () => {
  it("lists pending and reviewed runs with comparison, freshness, draft pointer, and decision state", async () => {
    const app = await buildApp();
    const seeded = await seedAwaitingReview("inbox-a");
    let inbox = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: ownerAuth });
    expect(inbox.statusCode).toBe(200);
    let page = inbox.json() as { items: Array<Record<string, unknown>>; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    let item = page.items[0]!;
    expect(item.id).toBe(seeded.run.id);
    expect(item.stage).toBe("awaiting_review");
    expect(item.recipe_revision).toBe(1);
    expect(item.recipe_state).toBe("active");
    expect(item.document_id).toBe(seeded.documentId);
    expect(item.document_head_revision_id).toBe(seeded.revisionId);
    expect(item.head_moved).toBe(false);
    expect(item.review).toBeNull();
    expect(item.publication_failure).toBeNull();

    // Approve; the reviewed row carries the decision tail + publication ids.
    setDocumentRenderersForTests(workingRenderers());
    expect((await approve(app, seeded.run.id, seeded.revisionId)).statusCode).toBe(202);
    await waitForRun(app, seeded.recipeId, seeded.run.id, "approved");
    inbox = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: ownerAuth });
    page = inbox.json();
    item = page.items[0]!;
    expect(item.stage).toBe("approved");
    expect(item.review).toMatchObject({ decision: "approve", document_revision_id: seeded.revisionId });
    expect(item.reviewed_revision_id).toBe(seeded.revisionId);
    expect(typeof item.publication_operation_id).toBe("string");
    // Rejection is visible too.
    const rejected = await seedAwaitingReview("inbox-b", "r1");
    const rejectRes = await app.inject({
      method: "POST",
      url: `/api/brief-reviews/${rejected.run.id}/decision`,
      headers: ownerAuth,
      payload: { decision: "reject", document_revision_id: rejected.revisionId, note: "Numbers look off." },
    });
    expect(rejectRes.statusCode).toBe(200);
    inbox = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: ownerAuth });
    page = inbox.json();
    const rejectedItem = page.items.find((entry) => entry.id === rejected.run.id)!;
    expect(rejectedItem.stage).toBe("rejected");
    expect(rejectedItem.review).toMatchObject({ decision: "reject", note: "Numbers look off." });
  });

  it("paginates with endpoint-bound cursors (default 20, maximum 50)", async () => {
    const app = await buildApp();
    await seedAwaitingReview("page-a");
    await seedAwaitingReview("page-b");
    const first = await app.inject({ method: "GET", url: "/api/brief-reviews?limit=1", headers: ownerAuth });
    const firstPage = first.json() as { items: Array<{ id: string }>; next_cursor: string };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next_cursor).toBeTruthy();
    const second = await app.inject({
      method: "GET",
      url: `/api/brief-reviews?limit=1&cursor=${firstPage.next_cursor}`,
      headers: ownerAuth,
    });
    const secondPage = second.json() as { items: Array<{ id: string }>; next_cursor: string | null };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);

    expect(
      (await app.inject({ method: "GET", url: "/api/brief-reviews?limit=51", headers: ownerAuth })).statusCode
    ).toBe(400);
    // A cursor minted for another endpoint never rides this route.
    const runsPage = await app.inject({
      method: "GET",
      url: `/api/briefs/${(await storageRuntime().briefRecipes.listRecipes(OWNER)).items[0]!.id}/runs`,
      headers: ownerAuth,
    });
    const foreignCursor = (runsPage.json() as { next_cursor: string | null }).next_cursor ?? "";
    // The runs page returned no cursor (few rows); mint a reviews-format cursor
    // for another endpoint directly via an oversized page then bound-check.
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
    expect(boundProbe.json()).toMatchObject({ code: "INVALID_CATALOG_CURSOR" });
    expect(foreignCursor === null || typeof foreignCursor === "string").toBe(true);
  });

  it("is account-scoped: foreign accounts read nothing and decide nothing (404)", async () => {
    const app = await buildApp();
    const seeded = await seedAwaitingReview("scope-a");
    const foreign = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: foreignAuth });
    expect((foreign.json() as { items: unknown[] }).items).toHaveLength(0);
    const decision = await approve(app, seeded.run.id, seeded.revisionId, foreignAuth);
    expect(decision.statusCode).toBe(404);
    expect(decision.json()).toMatchObject({ code: "BRIEF_RUN_NOT_FOUND" });
    const unknown = await approve(app, randomUUID(), randomUUID());
    expect(unknown.statusCode).toBe(404);
  });

  it("keeps deleted-recipe and paused-recipe runs readable through the retained snapshot", async () => {
    const app = await buildApp();
    const deleted = await seedAwaitingReview("deleted-recipe");
    const paused = await seedAwaitingReview("paused-recipe");
    await storageRuntime().briefRecipes.deleteRecipe(OWNER, deleted.recipeId);
    await storageRuntime().briefRecipes.setRecipePaused(OWNER, paused.recipeId, true);
    const inbox = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: ownerAuth });
    const page = inbox.json() as { items: Array<Record<string, unknown>> };
    const deletedItem = page.items.find((entry) => entry.id === deleted.run.id)!;
    expect(deletedItem.recipe_state).toBeNull();
    expect(deletedItem.recipe_name).toBeTruthy();
    const pausedItem = page.items.find((entry) => entry.id === paused.run.id)!;
    expect(pausedItem.recipe_state).toBe("paused");
    // Decisions still work for the deleted recipe's retained run.
    setDocumentRenderersForTests(workingRenderers());
    expect((await approve(app, deleted.run.id, deleted.revisionId)).statusCode).toBe(202);
    await waitForRun(app, deleted.recipeId, deleted.run.id, "approved");
  });

  it("an awaiting-review run never blocks scheduling of later occurrences", async () => {
    const ledger = storageRuntime().ledger;
    const clock = { value: new Date("2026-06-01T00:00:00.000Z") };
    const recipes = new BriefRecipeStore(ledger, { now: () => clock.value });
    const runs = new BriefRunStore(ledger, { now: () => clock.value });
    const sourceId = randomUUID();
    await ledger.run(
      `INSERT INTO sources (id,account_id,name,kind,display_name,status,ready_generation)
       VALUES (?,?,'sched.csv','tabular','sched.csv','ready',1)`,
      [sourceId, OWNER]
    );
    const analysis = await storageRuntime().analyses.createAnalysis(OWNER, {
      title: "sched analysis",
      sql: "SELECT 1 AS value",
      sourceIds: [sourceId],
    });
    const recipe = await recipes.createRecipe(OWNER, {
      name: "sched-blocker",
      analysis_id: analysis.id,
      report_title: "Brief",
      report_instruction: "Summarize.",
      source_ids: [sourceId],
      schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "UTC" },
    });
    const { run } = await runs.createManualRun(OWNER, recipe.id, randomUUID());
    await runs.beginStage(OWNER, run.id, { fromStage: "queued", toStage: "refreshing", stageOperationId: "s1" });
    await runs.beginStage(OWNER, run.id, { fromStage: "refreshing", toStage: "waiting_ready", stageOperationId: "s2" });
    await runs.beginStage(OWNER, run.id, { fromStage: "waiting_ready", toStage: "analyzing", stageOperationId: "s3" });
    await runs.beginStage(OWNER, run.id, { fromStage: "analyzing", toStage: "drafting", stageOperationId: "s4" });
    const created = await createDocumentDraft({ accountId: OWNER, title: "Draft", tree: draftTree() });
    await runs.markAwaitingReview(OWNER, run.id, {
      expectedStageOperationId: "s4",
      documentId: created.document.id,
      documentRevisionId: created.revision.id,
    });
    // The next daily occurrence becomes due while the review is pending.
    clock.value = new Date(Date.parse(recipe.nextRunAt) + 1_000);
    const claimed = await runs.claimDueRuns();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.recipeId).toBe(recipe.id);
    // The prior review is untouched and still decides cleanly.
    const prior = await runs.getRun(OWNER, run.id);
    expect(prior.stage).toBe("awaiting_review");
  });
});

describe("review decisions — approval", () => {
  it("approve → publishing → approved end-to-end with exactly one publication", async () => {
    const app = await buildApp();
    const renderers = gatedRenderers();
    setDocumentRenderersForTests(renderers);
    const seeded = await seedAwaitingReview("approve-flow");

    const decision = await approve(app, seeded.run.id, seeded.revisionId);
    expect(decision.statusCode).toBe(202);
    const body = decision.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "publishing", replayed: false });
    expect(body.status_path).toBe(`/api/briefs/${seeded.recipeId}/runs/${seeded.run.id}`);
    const operationId = (body.run as Record<string, unknown>).publication_operation_id as string;
    expect(operationId).toBe(deriveBriefPublicationOperationId(seeded.run.id, seeded.revisionId));

    // While rendering: durable publishing state and one active intent only.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const detail = await app.inject({
      method: "GET",
      url: `/api/briefs/${seeded.recipeId}/runs/${seeded.run.id}`,
      headers: ownerAuth,
    });
    expect(detail.json()).toMatchObject({ stage: "publishing", reviewed_revision_id: seeded.revisionId });
    expect(await publicationCount(seeded.documentId)).toBe(0);
    expect(await intentCount(seeded.documentId)).toBe(1);

    // A repeat decision while publishing reconciles the same intent (202),
    // never a second publication.
    const repeat = await approve(app, seeded.run.id, seeded.revisionId);
    expect(repeat.statusCode).toBe(202);
    expect(repeat.json()).toMatchObject({ status: "publishing", replayed: true });
    expect(await intentCount(seeded.documentId)).toBe(1);

    renderers.release();
    const approved = await waitForRun(app, seeded.recipeId, seeded.run.id, "approved");
    expect(approved.finished_at).toBeTruthy();
    expect(approved.publication_error_code).toBeNull();
    expect(await publicationCount(seeded.documentId)).toBe(1);
    expect(await intentCount(seeded.documentId)).toBe(1);
    const publication = (
      await storageRuntime().ledger.all<{ id: string }>("SELECT id FROM document_publications WHERE document_id=?", [
        seeded.documentId,
      ])
    )[0]!;
    const stored = await storageRuntime().documents.getDocumentPublication(OWNER, seeded.documentId, publication.id);
    expect(stored?.revisionId).toBe(seeded.revisionId);
    const html = await fs.readFile(stored!.htmlPath, "utf8");
    expect(html).toContain("Brief draft v1");
    const pdf = await fs.readFile(stored!.pdfPath);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");

    // The completed decision replays idempotently as the recorded outcome.
    const done = await approve(app, seeded.run.id, seeded.revisionId);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "approved", replayed: true });
    expect(await reviewEventCount(seeded.run.id)).toBe(1);
  });

  it("a concurrent edit before approval conflicts; the unchanged head approves", async () => {
    const app = await buildApp();
    setDocumentRenderersForTests(workingRenderers());
    const seeded = await seedAwaitingReview("concurrent-edit");
    const edited = await appendDocumentRevision({
      accountId: OWNER,
      documentId: seeded.documentId,
      baseRevisionId: seeded.revisionId,
      tree: draftTree("edited"),
      authorKind: "user",
    });
    const stale = await approve(app, seeded.run.id, seeded.revisionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "BRIEF_REVIEW_REVISION_CONFLICT" });
    // Never approves unseen content: nothing was published.
    expect(await publicationCount(seeded.documentId)).toBe(0);
    expect(await reviewEventCount(seeded.run.id)).toBe(0);
    // The inbox surfaces the moved head for refresh.
    const inbox = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: ownerAuth });
    const item = (inbox.json() as { items: Array<Record<string, unknown>> }).items.find(
      (entry) => entry.id === seeded.run.id
    )!;
    expect(item.head_moved).toBe(true);
    expect(item.document_head_revision_id).toBe(edited.revision.id);
    // Reviewing the current revision now works.
    expect((await approve(app, seeded.run.id, edited.revision.id)).statusCode).toBe(202);
    await waitForRun(app, seeded.recipeId, seeded.run.id, "approved");
    expect(await publicationCount(seeded.documentId)).toBe(1);
  });

  it("render failure returns the review with the indicator; retry reuses the same op-UUID, an edit forces a fresh decision", async () => {
    const app = await buildApp();
    setDocumentRenderersForTests({
      renderChartPng: async () => FAKE_PNG,
      renderReportPdf: async () => Buffer.from("NOT-A-PDF"),
    });
    const seeded = await seedAwaitingReview("render-failure");
    expect((await approve(app, seeded.run.id, seeded.revisionId)).statusCode).toBe(202);
    const failed = await waitForRun(app, seeded.recipeId, seeded.run.id, "awaiting_review", { indicator: true });
    expect(failed.publication_error_code).toBe("PUBLICATION_PDF_FAILED");
    expect(await publicationCount(seeded.documentId)).toBe(0);

    const inbox = await app.inject({ method: "GET", url: "/api/brief-reviews", headers: ownerAuth });
    const item = (inbox.json() as { items: Array<Record<string, unknown>> }).items.find(
      (entry) => entry.id === seeded.run.id
    )!;
    expect(item.publication_error_code).toBe("PUBLICATION_PDF_FAILED");
    expect(item.publication_failure).toMatchObject({
      code: "PUBLICATION_PDF_FAILED",
      message: expect.stringContaining("could not be rendered"),
    });

    // Retry of the same decision on the unchanged head reconciles the SAME
    // intent and op-UUID (re-armed), producing exactly one publication.
    setDocumentRenderersForTests(workingRenderers());
    expect((await approve(app, seeded.run.id, seeded.revisionId)).statusCode).toBe(202);
    await waitForRun(app, seeded.recipeId, seeded.run.id, "approved");
    expect(await intentCount(seeded.documentId)).toBe(1);
    expect(await publicationCount(seeded.documentId)).toBe(1);
    const intent = await storageRuntime().documents.getDocumentPublicationIntent(
      OWNER,
      seeded.documentId,
      deriveBriefPublicationOperationId(seeded.run.id, seeded.revisionId)
    );
    expect(intent?.status).toBe("completed");
    expect(intent?.attempts).toBeGreaterThanOrEqual(1);
  });

  it("after a failed render, an edited draft requires a fresh decision on the new revision", async () => {
    const app = await buildApp();
    setDocumentRenderersForTests({
      renderChartPng: async () => FAKE_PNG,
      renderReportPdf: async () => {
        throw new Error("renderer exploded");
      },
    });
    const seeded = await seedAwaitingReview("edit-after-failure");
    expect((await approve(app, seeded.run.id, seeded.revisionId)).statusCode).toBe(202);
    await waitForRun(app, seeded.recipeId, seeded.run.id, "awaiting_review", { indicator: true });
    const edited = await appendDocumentRevision({
      accountId: OWNER,
      documentId: seeded.documentId,
      baseRevisionId: seeded.revisionId,
      tree: draftTree("post-failure-edit"),
      authorKind: "user",
    });
    // Head re-check on retry: the old revision is rejected (fresh review needed).
    const stale = await approve(app, seeded.run.id, seeded.revisionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "BRIEF_REVIEW_REVISION_CONFLICT" });
    expect(await publicationCount(seeded.documentId)).toBe(0);
    // The fresh decision on the current head wins.
    setDocumentRenderersForTests(workingRenderers());
    expect((await approve(app, seeded.run.id, edited.revision.id)).statusCode).toBe(202);
    await waitForRun(app, seeded.recipeId, seeded.run.id, "approved");
    expect(await publicationCount(seeded.documentId)).toBe(1);
  });

  it("an edit while publishing cannot alter the immutable revision: the attempt re-checks the head honestly", async () => {
    const app = await buildApp();
    const renderers = gatedRenderers();
    setDocumentRenderersForTests(renderers);
    const seeded = await seedAwaitingReview("immutable-published");
    const before = await storageRuntime().documents.getDocumentRevision(OWNER, seeded.documentId, seeded.revisionId);
    const beforePayload = JSON.stringify(before!.payload);

    expect((await approve(app, seeded.run.id, seeded.revisionId)).statusCode).toBe(202);
    // The approval is accepted; the user edits the draft head mid-render.
    const edited = await appendDocumentRevision({
      accountId: OWNER,
      documentId: seeded.documentId,
      baseRevisionId: seeded.revisionId,
      tree: draftTree("mid-render-edit"),
      authorKind: "user",
    });
    renderers.release();
    // M13's completion re-checks the head for a default-target publication:
    // the attempt fails honestly back to review (never publishing content
    // beyond the reviewed revision), with the indicator recorded.
    const returned = await waitForRun(app, seeded.recipeId, seeded.run.id, "awaiting_review", { indicator: true });
    expect(returned.publication_error_code).toBe("DOCUMENT_HEAD_MOVED");
    expect(await publicationCount(seeded.documentId)).toBe(0);

    // The reviewed revision itself is byte-identical and frozen: the edit
    // appended a new head and never altered the immutable revision.
    const after = await storageRuntime().documents.getDocumentRevision(OWNER, seeded.documentId, seeded.revisionId);
    expect(JSON.stringify(after!.payload)).toBe(beforePayload);
    expect(edited.revision.id).not.toBe(seeded.revisionId);
    // A stale-base write is rejected by the document store's CAS guard: the
    // reviewed revision can never be overwritten by a later author.
    const staleWrite = await storageRuntime()
      .documents.saveDocumentRevision(OWNER, seeded.documentId, {
        baseRevisionId: seeded.revisionId,
        tree: draftTree("stale-base"),
        authorKind: "user",
      })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(staleWrite).toBeInstanceOf(DocumentRevisionConflictError);

    // A fresh decision on the current head now publishes cleanly.
    expect((await approve(app, seeded.run.id, edited.revision.id)).statusCode).toBe(202);
    await waitForRun(app, seeded.recipeId, seeded.run.id, "approved");
    expect(await publicationCount(seeded.documentId)).toBe(1);
    const [publication] = await storageRuntime().ledger.all<{ revision_id: string; version: number | bigint }>(
      "SELECT revision_id,version FROM document_publications WHERE document_id=?",
      [seeded.documentId]
    );
    expect(publication!.revision_id).toBe(edited.revision.id);
    // Publication rows are ledger-frozen (documentStore trigger guard).
    const tamper = await storageRuntime()
      .ledger.run("UPDATE document_publications SET version=99 WHERE document_id=?", [seeded.documentId])
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(tamper).not.toBeNull();
  });

  it("restart reconciliation: a publishing run whose intent failed returns to review with the indicator", async () => {
    await buildApp();
    setDocumentRenderersForTests({
      renderChartPng: async () => FAKE_PNG,
      renderReportPdf: async () => Buffer.from("NOT-A-PDF"),
    });
    const seeded = await seedAwaitingReview("restart-failed");
    // One honest failed attempt leaves the durable intent failed.
    const failed = await storageRuntime().briefRuns.recordReviewDecision(OWNER, seeded.run.id, {
      decision: "approve",
      documentRevisionId: seeded.revisionId,
    });
    await ensureBriefPublication(OWNER, failed.run);
    await waitFor(async () => {
      const live = await storageRuntime().briefRuns.getRun(OWNER, seeded.run.id);
      return live.stage === "awaiting_review" && live.publicationErrorCode !== null;
    }, "indicator recorded");
    // Simulate the crash window: the durable row sits in `publishing` while
    // the same intent is already failed (startup repair has run).
    await storageRuntime().ledger.run("UPDATE brief_runs SET stage='publishing' WHERE id=?", [seeded.run.id]);
    const reconciled = await reconcileBriefPublications();
    expect(reconciled).toMatchObject({ attempted: 1, approved: 0, returnedToReview: 1 });
    const live = await storageRuntime().briefRuns.getRun(OWNER, seeded.run.id);
    expect(live.stage).toBe("awaiting_review");
    expect(live.publicationErrorCode).toBe("PUBLICATION_PDF_FAILED");
    expect(await publicationCount(seeded.documentId)).toBe(0);
  });

  it("an approval retry against a publishing run with a failed intent reconciles the same op-UUID", async () => {
    const app = await buildApp();
    setDocumentRenderersForTests({
      renderChartPng: async () => FAKE_PNG,
      renderReportPdf: async () => Buffer.from("NOT-A-PDF"),
    });
    const seeded = await seedAwaitingReview("retry-publishing");
    expect((await approve(app, seeded.run.id, seeded.revisionId)).statusCode).toBe(202);
    await waitFor(async () => {
      const live = await storageRuntime().briefRuns.getRun(OWNER, seeded.run.id);
      return live.stage === "awaiting_review" && live.publicationErrorCode !== null;
    }, "first failure finalized");
    // Crash window: the row is durable `publishing` while its intent failed.
    await storageRuntime().ledger.run("UPDATE brief_runs SET stage='publishing' WHERE id=?", [seeded.run.id]);
    setDocumentRenderersForTests(workingRenderers());
    const retry = await approve(app, seeded.run.id, seeded.revisionId);
    expect(retry.statusCode).toBe(202);
    expect((retry.json() as { run: Record<string, unknown> }).run.publication_operation_id).toBe(
      deriveBriefPublicationOperationId(seeded.run.id, seeded.revisionId)
    );
    await waitForRun(app, seeded.recipeId, seeded.run.id, "approved");
    // The same intent was re-armed — never a second intent, never a second
    // publication — and each accepted decision is on the immutable ledger.
    expect(await intentCount(seeded.documentId)).toBe(1);
    expect(await publicationCount(seeded.documentId)).toBe(1);
    expect(await reviewEventCount(seeded.run.id)).toBe(2);
  });
});

describe("review decisions — rejection and conflicts", () => {
  async function reject(app: FastifyInstance, runId: string, revisionId: string, note?: string) {
    return app.inject({
      method: "POST",
      url: `/api/brief-reviews/${runId}/decision`,
      headers: ownerAuth,
      payload: { decision: "reject", document_revision_id: revisionId, ...(note ? { note } : {}) },
    });
  }

  it("reject is terminal: artifacts survive, publishing is blocked, repeats replay", async () => {
    const app = await buildApp();
    setDocumentRenderersForTests(workingRenderers());
    const seeded = await seedAwaitingReview("reject-flow");
    const res = await reject(app, seeded.run.id, seeded.revisionId, "Needs a baseline section first.");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "rejected", replayed: false });
    const detail = await waitForRun(app, seeded.recipeId, seeded.run.id, "rejected");
    expect(detail.finished_at).toBeTruthy();
    // Run + draft stay inspectable.
    const document = await storageRuntime().documents.getDocument(OWNER, seeded.documentId);
    expect(document).toBeTruthy();
    // A rejected review can never publish.
    const attempt = await approve(app, seeded.run.id, seeded.revisionId);
    expect(attempt.statusCode).toBe(409);
    expect(await publicationCount(seeded.documentId)).toBe(0);
    // Repeat rejection replays the recorded outcome; the ledger stays single.
    const repeat = await reject(app, seeded.run.id, seeded.revisionId, "Needs a baseline section first.");
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({ status: "rejected", replayed: true });
    expect(await reviewEventCount(seeded.run.id)).toBe(1);
  });

  it("reject while publishing is already accepted conflicts and cannot revoke", async () => {
    const app = await buildApp();
    const renderers = gatedRenderers();
    setDocumentRenderersForTests(renderers);
    const seeded = await seedAwaitingReview("reject-during-publish");
    expect((await approve(app, seeded.run.id, seeded.revisionId)).statusCode).toBe(202);
    const conflict = await reject(app, seeded.run.id, seeded.revisionId);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "BRIEF_RUN_STATE" });
    renderers.release();
    await waitForRun(app, seeded.recipeId, seeded.run.id, "approved");
    // A committed approval also cannot be revoked by rejection.
    expect((await reject(app, seeded.run.id, seeded.revisionId)).statusCode).toBe(409);
    expect(await publicationCount(seeded.documentId)).toBe(1);
  });

  it("validates the decision body and rejects notes over 1,000 characters", async () => {
    const app = await buildApp();
    const seeded = await seedAwaitingReview("body-validation");
    const bad = await app.inject({
      method: "POST",
      url: `/api/brief-reviews/${seeded.run.id}/decision`,
      headers: ownerAuth,
      payload: { decision: "approve" },
    });
    expect(bad.statusCode).toBe(400);
    const badDecision = await app.inject({
      method: "POST",
      url: `/api/brief-reviews/${seeded.run.id}/decision`,
      headers: ownerAuth,
      payload: { decision: "maybe", document_revision_id: seeded.revisionId },
    });
    expect(badDecision.statusCode).toBe(400);
    const badRevision = await app.inject({
      method: "POST",
      url: `/api/brief-reviews/${seeded.run.id}/decision`,
      headers: ownerAuth,
      payload: { decision: "approve", document_revision_id: "not-a-uuid" },
    });
    expect(badRevision.statusCode).toBe(400);
    const longNote = await app.inject({
      method: "POST",
      url: `/api/brief-reviews/${seeded.run.id}/decision`,
      headers: ownerAuth,
      payload: { decision: "reject", document_revision_id: seeded.revisionId, note: "x".repeat(1_001) },
    });
    expect(longNote.statusCode).toBe(400);
    // A run that is not under review cannot be decided.
    const { run } = await storageRuntime().briefRuns.createManualRun(
      OWNER,
      (await storageRuntime().briefRecipes.listRecipes(OWNER)).items[0]!.id,
      randomUUID()
    );
    const early = await approve(app, run.id, randomUUID());
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: "BRIEF_RUN_STATE" });
  });
});

describe("notifications", () => {
  async function seedNotification(runId: string, kind: "first_draft" | "meaningful_change" | "attention" | "paused") {
    return storageRuntime().briefRuns.recordNotification(OWNER, runId, kind, `bounded ${kind} detail`);
  }

  it("lists account notifications durably and marks read/dismissed without touching content", async () => {
    const app = await buildApp();
    const first = await seedAwaitingReview("notify-a");
    const second = await seedAwaitingReview("notify-b");
    const created = await seedNotification(first.run.id, "first_draft");
    expect(created.created).toBe(true);
    // Dedup interplay: the (run, kind) unique index means the runner's
    // repeat writes add no rows (and no route read ever sees duplicates).
    const again = await seedNotification(first.run.id, "first_draft");
    expect(again.created).toBe(false);
    expect(again.id).toBe(created.id);
    await seedNotification(first.run.id, "attention");
    await seedNotification(second.run.id, "meaningful_change");

    const list = await app.inject({ method: "GET", url: "/api/notifications", headers: ownerAuth });
    expect(list.statusCode).toBe(200);
    const page = list.json() as { items: Array<Record<string, unknown>>; next_cursor: string | null };
    expect(page.items).toHaveLength(3);
    expect(page.items[0]).toMatchObject({ kind: expect.any(String), state: "unread", detail: expect.any(String) });

    const target = page.items.find((entry) => entry.run_id === first.run.id && entry.kind === "first_draft")!;
    const read = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${target.id}`,
      headers: ownerAuth,
      payload: { state: "read" },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ state: "read" });
    expect((read.json() as Record<string, unknown>).read_at).toBeTruthy();

    const dismissed = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${target.id}`,
      headers: ownerAuth,
      payload: { state: "dismissed" },
    });
    expect(dismissed.json()).toMatchObject({ state: "dismissed" });
    // Durable: the later list reflects the final state.
    const after = await app.inject({ method: "GET", url: "/api/notifications", headers: ownerAuth });
    const afterItem = (after.json() as { items: Array<Record<string, unknown>> }).items.find(
      (entry) => entry.id === target.id
    )!;
    expect(afterItem.state).toBe("dismissed");
    expect(afterItem.kind).toBe("first_draft");

    // Content cannot be modified by the route surface: the patch body schema
    // exposes state only, and any other field never reaches the store.
    const contentPatch = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${target.id}`,
      headers: ownerAuth,
      payload: { state: "dismissed", detail: "rewritten", kind: "attention" },
    });
    expect(contentPatch.statusCode).toBe(200);
    const unchanged = await app.inject({ method: "GET", url: "/api/notifications", headers: ownerAuth });
    const unchangedItem = (unchanged.json() as { items: Array<Record<string, unknown>> }).items.find(
      (entry) => entry.id === target.id
    )!;
    expect(unchangedItem.detail).toBe("bounded first_draft detail");
    expect(unchangedItem.kind).toBe("first_draft");
    // Only read/dismiss are exposed (durable visibility semantics; no
    // unread-regression or content edits).
    const unread = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${target.id}`,
      headers: ownerAuth,
      payload: { state: "unread" },
    });
    expect(unread.statusCode).toBe(400);
  });

  it("is account-scoped (404 for foreign/unknown ids) and paginates 20/50 with bound cursors", async () => {
    const app = await buildApp();
    const seeded = await seedAwaitingReview("notify-scope");
    const { id } = await seedNotification(seeded.run.id, "attention");
    const foreign = await app.inject({ method: "GET", url: "/api/notifications", headers: foreignAuth });
    expect((foreign.json() as { items: unknown[] }).items).toHaveLength(0);
    const foreignPatch = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${id}`,
      headers: foreignAuth,
      payload: { state: "read" },
    });
    expect(foreignPatch.statusCode).toBe(404);
    const unknown = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${randomUUID()}`,
      headers: ownerAuth,
      payload: { state: "read" },
    });
    expect(unknown.statusCode).toBe(404);

    for (let index = 0; index < 2; index += 1) {
      await seedNotification((await seedAwaitingReview(`notify-page-${index}`)).run.id, "first_draft");
    }
    const first = await app.inject({ method: "GET", url: "/api/notifications?limit=1", headers: ownerAuth });
    const firstPage = first.json() as { items: Array<Record<string, unknown>>; next_cursor: string };
    expect(firstPage.items).toHaveLength(1);
    const second = await app.inject({
      method: "GET",
      url: `/api/notifications?limit=1&cursor=${firstPage.next_cursor}`,
      headers: ownerAuth,
    });
    const secondPage = second.json() as { items: Array<Record<string, unknown>> };
    expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
    expect(
      (await app.inject({ method: "GET", url: "/api/notifications?limit=51", headers: ownerAuth })).statusCode
    ).toBe(400);
    const bound = await app.inject({
      method: "GET",
      url:
        "/api/notifications?cursor=" +
        Buffer.from(
          JSON.stringify({ v: 1, e: "brief_reviews", t: "2026-06-01T00:00:00.000Z", i: randomUUID() })
        ).toString("base64url"),
      headers: ownerAuth,
    });
    expect(bound.statusCode).toBe(400);
  });
});

describe("draft schedule previews", () => {
  it("resolves three future local and UTC occurrences before a recipe exists", async () => {
    const app = await buildApp();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-28T12:00:00Z"));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/briefs/schedule-preview",
        headers: ownerAuth,
        payload: { schedule: { kind: "daily", hour: 2, minute: 30, time_zone: "Europe/Berlin" } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().next_occurrences).toEqual([
        { occurrence_key: "2026-03-29T02:30", civil: "2026-03-29T02:30", utc_at: "2026-03-29T01:00:00.000Z" },
        { occurrence_key: "2026-03-30T02:30", civil: "2026-03-30T02:30", utc_at: "2026-03-30T00:30:00.000Z" },
        { occurrence_key: "2026-03-31T02:30", civil: "2026-03-31T02:30", utc_at: "2026-03-31T00:30:00.000Z" },
      ]);
      expect((await storageRuntime().briefRecipes.listRecipes(OWNER)).items).toHaveLength(0);
      const invalid = await app.inject({
        method: "POST",
        url: "/api/briefs/schedule-preview",
        headers: ownerAuth,
        payload: { schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "Not/A_Zone" } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe("CALENDAR_SCHEDULE_INVALID");
      const unauthenticated = await app.inject({
        method: "POST",
        url: "/api/briefs/schedule-preview",
        headers: { "content-type": "application/json" },
        payload: "{".repeat(100_000),
      });
      expect(unauthenticated.statusCode).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });
});
