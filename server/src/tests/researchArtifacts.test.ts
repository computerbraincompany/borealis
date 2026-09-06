/**
 * M15 stage 3 — reviewed M13 artifacts and exact-revision exports over the
 * HTTP surface: completed/needs_review runs produce owner-only drafts (never
 * failed/cancelled), the projection stays inside the 60/32/1,000-cell/400k
 * budgets with labeled omissions and shortened-excerpt labels, evidence ids
 * and hashes are stable, rerun selections carry user overrides visibly, the
 * changed-cell diff is served over the table route, and the CSV/JSON exports
 * render the exact stored revision including zero-cell success.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { startScriptedOpenAiServer, type ScriptedOpenAiServer } from "./scriptedOpenAiServer.js";
import { installHttpBoundary } from "../httpErrors.js";
import { researchRoutes } from "../routes/research.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const AUTHORIZATION = Object.freeze({
  providerOrigin: "http://127.0.0.1:1234",
  providerLocality: "local" as const,
  providerRevision: 1,
});

const apps: FastifyInstance[] = [];
const providers: ScriptedOpenAiServer[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-research-artifacts-"));
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
  await initializeRuntimeSettings({ settingsFile: path.join(runtimeDirectory, "settings.json"), env: {} });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(providers.splice(0).map((provider) => provider.close().catch(() => undefined)));
  closeRuntimeSettings();
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(researchRoutes);
  await app.ready();
  return app;
}

async function startProvider(models: readonly string[]): Promise<ScriptedOpenAiServer> {
  const provider = await startScriptedOpenAiServer(models[0] ?? "chat-model", [], { models });
  providers.push(provider);
  await runtimeSettingsStore().patch({ llmBaseUrl: provider.origin, chatModel: models[0] ?? "chat-model" });
  return provider;
}

async function insertSource(id: string, accountId: string): Promise<string> {
  await storageRuntime().ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,size_bytes,status,ready_generation)
     VALUES (?,?,?,'document',?,?,100,'ready',4)`,
    [id, accountId, `src-${id.slice(0, 8)}`, `${id.slice(0, 8)}.md`, `/w/${id}.md`]
  );
  return id;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const priceColumn = Object.freeze({
  id: randomUUID(),
  label: "Price",
  question: "What is the quoted price?",
  type: "number",
  unit: "USD",
  choices: null,
});
const termsColumn = Object.freeze({
  id: randomUUID(),
  label: "Terms",
  question: "What are the renewal terms?",
  type: "text",
  unit: null,
  choices: null,
});

/** Seed a finished comparison run with every honest cell status. */
async function seedComparisonRun(options: { status?: "completed" | "needs_review" | "failed" } = {}) {
  const store = storageRuntime().research;
  const sources = [randomUUID(), randomUUID()];
  for (const id of sources) await insertSource(id, OWNER);
  const created = await store.createResearchDefinition(OWNER, {
    title: "Supplier table",
    question: "Compare supplier pricing tables",
    output_kind: "comparison",
    source_ids: sources,
    chat_model: "chat-model",
    columns: [priceColumn, termsColumn],
  });
  const run = await store.startResearchRun(OWNER, created.id, { authorization: AUTHORIZATION });
  await store.markResearchRunRunning(OWNER, run.id);
  const evidence = await store.insertResearchEvidence(OWNER, run.id, {
    sourceId: sources[0],
    generation: 4,
    chunkId: randomUUID(),
    label: "proposal-a.md",
    locators: [{ kind: "text_span", char_start: 4, char_len: 40, heading: "Pricing" }],
    excerpt: "Net-30 renewal with a 4% uplift.",
    contentHash: sha("Net-30 renewal with a 4% uplift."),
    stepOrdinal: 0,
    query: "renewal",
  });
  await store.recordResearchMachineCell(OWNER, run.id, {
    columnId: priceColumn.id,
    rowSourceId: sources[0],
    rawValue: 4.5,
    evidenceRefs: [evidence.id],
  });
  await store.recordResearchMachineCell(OWNER, run.id, {
    columnId: priceColumn.id,
    rowSourceId: sources[1],
    rawValue: "5", // number column, quoted → invalid verbatim
  });
  await store.recordResearchMachineCell(OWNER, run.id, {
    columnId: termsColumn.id,
    rowSourceId: sources[0],
    rawValue: "Net-30 renewal with a 4% uplift.",
    evidenceRefs: [evidence.id],
  });
  await store.recordResearchMachineCell(OWNER, run.id, {
    columnId: termsColumn.id,
    rowSourceId: sources[1],
    rawValue: null, // explicit not-found
  });
  const status = options.status ?? "completed";
  await store.finishResearchRun(OWNER, run.id, status, status === "failed" ? "RESEARCH_PROVIDER_FAILED" : undefined);
  return { definitionId: created.id, runId: run.id, sources, evidenceId: evidence.id };
}

async function createArtifact(app: FastifyInstance, runId: string, headers = ownerAuth) {
  return app.inject({ method: "POST", url: `/api/research-runs/${runId}/artifacts`, headers, body: {} });
}

async function headPayload(documentId: string, revisionId: string) {
  const revision = await storageRuntime().documents.getDocumentRevision(OWNER, documentId, revisionId);
  expect(revision).toBeDefined();
  return revision!.payload;
}

describe("research artifacts — reviewed M13 drafts", () => {
  it("projects a completed comparison run into an analysis-backed draft with labeled states", async () => {
    const app = await buildApp();
    const seed = await seedComparisonRun();
    await storageRuntime().research.applyResearchReviewOps(OWNER, seed.runId, 1, [
      {
        op: "correct_cell",
        column_id: priceColumn.id,
        row_source_id: seed.sources[1],
        value: 5,
        explanation: "confirmed by phone",
      },
    ]);

    const response = await createArtifact(app, seed.runId);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.run_id).toBe(seed.runId);
    expect(body.document_revision).toBe(1);
    expect(body.projection).toMatchObject({
      output_kind: "comparison",
      run_status: "completed",
      projected: { rows: 2, columns: 3 },
    });
    expect(body.projection.omitted.rows).toEqual([]);

    const payload = await headPayload(body.document_id, body.document_revision_id);
    expect(payload.verified).toBe(true);
    expect(payload.tables).toHaveLength(1);
    const table = payload.tables[0];
    expect(table.columns).toEqual(["Document", "Price (USD)", "Terms"]);
    // Row identity keeps a human label, values render honestly.
    const byRow = new Map(table.rows.map((row) => [row[0] as string, row]));
    const sourceA = storageRuntime().sources;
    const records = await sourceA.getSourcesByIds(OWNER, seed.sources);
    const labels = records.map((record) => record.displayName);
    const rowA = byRow.get(labels[0]) ?? byRow.get(labels[1]);
    expect(rowA).toBeDefined();
    // correction overlay labeled, invalid verbatim labeled under the
    // correction, not-found rendered, evidence excerpt rendered.
    const allCells = table.rows
      .flat()
      .slice(1)
      .filter((cell): cell is string => typeof cell === "string");
    expect(allCells.some((cell) => cell === "4.5")).toBe(true);
    expect(allCells.some((cell) => cell === "5 (corrected)")).toBe(true);
    expect(allCells.some((cell) => cell === "not found")).toBe(true);

    // The envelope is analysis-backed and provenance identifies the run.
    const analysis = table.analysis;
    expect(analysis).not.toBeNull();
    expect(analysis!.analysis_id).toBe(seed.definitionId);
    expect(analysis!.result_id).toBe(seed.runId);
    expect(analysis!.source_generations).toHaveLength(2);
    expect(analysis!.schema_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(analysis!.columns[0]).toEqual({ name: "Document", type: "string" });

    // Evidence entries keep stable ids and hashes (evidence contract).
    const evidenceRef = payload.evidence.find((entry) => entry.id === seed.evidenceId);
    expect(evidenceRef).toBeDefined();
    expect(evidenceRef!.content_identity).toBe(sha("Net-30 renewal with a 4% uplift."));
    expect(evidenceRef!.generation).toBe(4);
    expect(evidenceRef!.locator).toContain("text span");

    // Draft, owner-only, outside the publication chain.
    const document = await storageRuntime().documents.getDocument(OWNER, body.document_id);
    expect(document?.latestPublicationVersion ?? null).toBeNull();
    const publications = await storageRuntime().documents.listDocumentPublications(OWNER, body.document_id, {
      limit: 25,
      after: null,
    });
    expect(publications.items).toEqual([]);
    expect(await storageRuntime().documents.getDocument(FOREIGN, body.document_id)).toBeUndefined();
  });

  it("allows needs_review with disclosure and refuses failed/cancelled runs", async () => {
    const app = await buildApp();
    const reviewSeed = await seedComparisonRun({ status: "needs_review" });
    const needsReview = await createArtifact(app, reviewSeed.runId);
    expect(needsReview.statusCode).toBe(201);
    expect(needsReview.json().projection.disclosures.needs_review).toBe(true);
    const payload = await headPayload(needsReview.json().document_id, needsReview.json().document_revision_id);
    expect(payload.subtitle).toContain("needs_review");
    expect(payload.sections[0].markdown).toContain("needs_review");
    expect(payload.sections.some((section) => section.markdown.includes("not labeled exhaustive"))).toBe(true);

    const failed = await seedComparisonRun({ status: "failed" });
    const failedResponse = await createArtifact(app, failed.runId);
    expect(failedResponse.statusCode).toBe(409);
    expect(failedResponse.json().code).toBe("RESEARCH_RUN_STATE");

    const store = storageRuntime().research;
    const sources = [randomUUID()];
    for (const id of sources) await insertSource(id, OWNER);
    const definition = await store.createResearchDefinition(OWNER, {
      title: "Diligence",
      question: "q?",
      output_kind: "memo",
      source_ids: sources,
      chat_model: "chat-model",
    });
    const queued = await store.startResearchRun(OWNER, definition.id, { authorization: AUTHORIZATION });
    await store.requestResearchRunCancel(OWNER, queued.id);
    const cancelled = await createArtifact(app, queued.id);
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json().code).toBe("RESEARCH_RUN_STATE");
  });

  it("maps memo narrative claims into the M13 evidence numbering and excludes rejected claims", async () => {
    const app = await buildApp();
    const store = storageRuntime().research;
    const source = randomUUID();
    await insertSource(source, OWNER);
    const definition = await store.createResearchDefinition(OWNER, {
      title: "Renewal memo",
      question: "Which supplier offers the best renewal terms?",
      output_kind: "memo",
      source_ids: [source],
      chat_model: "chat-model",
    });
    const run = await store.startResearchRun(OWNER, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(OWNER, run.id);
    const excerptA = "Net-30 renewal with a 4% uplift.";
    const excerptB = "Net-45 renewal with a 6% uplift.";
    const evA = await store.insertResearchEvidence(OWNER, run.id, {
      sourceId: source,
      generation: 4,
      chunkId: randomUUID(),
      label: "a.md",
      excerpt: excerptA,
      contentHash: sha(excerptA),
      stepOrdinal: 0,
      query: "renewal",
    });
    const evB = await store.insertResearchEvidence(OWNER, run.id, {
      sourceId: source,
      generation: 4,
      chunkId: randomUUID(),
      label: "b.md",
      excerpt: excerptB,
      contentHash: sha(excerptB),
      stepOrdinal: 0,
      query: "renewal",
    });
    const supported = await store.addResearchClaim(OWNER, run.id, {
      kind: "claim",
      text: "The uplift is four percent.",
      classification: "supported",
      evidenceRefs: [evA.id],
    });
    const conflicting = await store.addResearchClaim(OWNER, run.id, {
      kind: "claim",
      text: "One proposal says 4%, the other 6%.",
      classification: "conflicting",
      evidenceRefs: [evA.id, evB.id],
    });
    await store.addResearchClaim(OWNER, run.id, {
      kind: "gap",
      text: "Renewal cap: not found in selected evidence.",
    });
    await store.finishResearchRun(OWNER, run.id, "completed");

    await store.applyResearchReviewOps(OWNER, run.id, 1, [
      { op: "correct_claim", claim_id: supported.id, text: "The uplift is four percent net-30." },
      { op: "reject_claim", claim_id: conflicting.id },
    ]);

    const response = await createArtifact(app, run.id);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.projection.output_kind).toBe("memo");
    expect(body.projection.projected.gaps).toBe(1);

    const payload = await headPayload(body.document_id, body.document_revision_id);
    expect(payload.tables).toEqual([]);
    const joined = payload.sections.map((section) => section.markdown).join("\n");
    // The corrected text wins with an explicit label; the rejected claim is
    // excluded and disclosed.
    expect(joined).toContain("The uplift is four percent net-30.");
    expect(joined).toContain("(user correction)");
    expect(joined).toContain("user-rejected claim(s) excluded");
    expect(joined).toContain("not found in selected evidence");

    // `[n]` markers resolve against the revision's own evidence array.
    const position = payload.evidence.findIndex((entry) => entry.id === evA.id);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(joined).toContain(`net-30.[${position + 1}]`);
    expect(payload.evidence.every((entry) => typeof entry.generation === "number")).toBe(true);
  });

  it("stays inside the 60-row/32-column/1,000-cell projection with labeled omissions", async () => {
    const app = await buildApp();
    const store = storageRuntime().research;
    const sources: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const id = randomUUID();
      await insertSource(id, OWNER);
      sources.push(id);
    }
    const columns = Array.from({ length: 20 }, (_, index) => ({
      id: randomUUID(),
      label: `Column ${index}`,
      question: "value?",
      type: "text" as const,
      unit: null,
      choices: null,
    }));
    const definition = await store.createResearchDefinition(OWNER, {
      title: "Wide table",
      question: "wide",
      output_kind: "comparison",
      source_ids: sources,
      chat_model: "chat-model",
      columns,
    });
    const run = await store.startResearchRun(OWNER, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(OWNER, run.id);
    await store.finishResearchRun(OWNER, run.id, "completed");

    const response = await createArtifact(app, run.id);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    // 21 columns (Document + 20): the 1,000-cell cap binds at 47 rows.
    expect(body.projection.projected).toMatchObject({ columns: 21, rows: 47, cells: 0 });
    expect(body.projection.omitted.rows).toHaveLength(53);
    expect(body.projection.labels.some((label: string) => label.includes("53 row(s) exceeded"))).toBe(true);

    const payload = await headPayload(body.document_id, body.document_revision_id);
    expect(payload.tables[0].rows).toHaveLength(47);
    expect(payload.tables[0].analysis!.completeness.complete).toBe(false);
    expect(payload.tables[0].analysis!.completeness.reasons).toContain("rows_omitted:53");
  });

  it("shrinks deterministically into the 400k revision budget with excerpt shortening labels", async () => {
    const app = await buildApp();
    const store = storageRuntime().research;
    const source = randomUUID();
    await insertSource(source, OWNER);
    const definition = await store.createResearchDefinition(OWNER, {
      title: "Heavy memo",
      question: "big",
      output_kind: "memo",
      source_ids: [source],
      chat_model: "chat-model",
    });
    const run = await store.startResearchRun(OWNER, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(OWNER, run.id);
    for (let index = 0; index < 100; index += 1) {
      const excerpt = `passage ${index} ` + "x".repeat(1_989 - String(index).length);
      await store.insertResearchEvidence(OWNER, run.id, {
        sourceId: source,
        generation: 4,
        chunkId: randomUUID(),
        label: `doc-${index}.md`,
        excerpt,
        contentHash: sha(excerpt),
        stepOrdinal: 0,
        query: "q",
      });
      await store.addResearchClaim(OWNER, run.id, {
        kind: "claim",
        text: `Claim ${index}: ${"y".repeat(1_800)}`,
        classification: "supported",
      });
    }
    await store.finishResearchRun(OWNER, run.id, "completed");

    const response = await createArtifact(app, run.id);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.projection.payload_chars).toBeLessThanOrEqual(400_000);
    expect(body.projection.excerpt_chars_max).toBeLessThan(800);
    expect(body.projection.disclosures.excerpts_shortened).toBeGreaterThan(0);
    expect(body.projection.omitted.claims).toBeGreaterThan(0);
    expect(body.projection.labels.some((label: string) => label.includes("shortened"))).toBe(true);

    const payload = await headPayload(body.document_id, body.document_revision_id);
    expect(payload.evidence).toHaveLength(100);
    // Stable ids/hashes survive shortening; the label is explicit.
    expect(payload.evidence.every((entry) => /^[0-9a-f]{64}$/.test(entry.content_identity))).toBe(true);
    expect(payload.evidence.every((entry) => entry.excerpt.includes("[shortened]"))).toBe(true);
  });

  it("produces identical evidence identity when the same run is projected twice", async () => {
    const app = await buildApp();
    const seed = await seedComparisonRun();
    const first = await createArtifact(app, seed.runId);
    const second = await createArtifact(app, seed.runId);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const a = first.json();
    const b = second.json();
    expect(a.document_id).not.toBe(b.document_id);
    const payloadA = await headPayload(a.document_id, a.document_revision_id);
    const payloadB = await headPayload(b.document_id, b.document_revision_id);
    expect(payloadA.evidence.map((entry) => `${entry.id}:${entry.content_identity}`)).toEqual(
      payloadB.evidence.map((entry) => `${entry.id}:${entry.content_identity}`)
    );
  });

  it("refuses cross-account artifact and export requests", async () => {
    const app = await buildApp();
    const seed = await seedComparisonRun();
    const foreign = await createArtifact(app, seed.runId, foreignAuth);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("RESEARCH_RUN_NOT_FOUND");
    const foreignExport = await app.inject({
      method: "GET",
      url: `/api/research-runs/${seed.runId}/export?format=csv`,
      headers: foreignAuth,
    });
    expect(foreignExport.statusCode).toBe(404);
  });
});

describe("research exports and rerun lineage over the wire", () => {
  it("reruns selected columns/rows, carrying corrections visibly, and diffs revisions", async () => {
    await startProvider(["chat-model"]);
    const app = await buildApp();
    const seed = await seedComparisonRun();
    const store = storageRuntime().research;
    await store.applyResearchReviewOps(OWNER, seed.runId, 1, [
      { op: "correct_cell", column_id: priceColumn.id, row_source_id: seed.sources[1], value: 5 },
    ]);

    const rerun = await app.inject({
      method: "POST",
      url: `/api/research/${seed.definitionId}/runs`,
      headers: ownerAuth,
      body: {
        rerun_of: seed.runId,
        rerun_selection: { row_source_ids: [seed.sources[0]], column_ids: [priceColumn.id] },
      },
    });
    expect(rerun.statusCode).toBe(201);
    const rerunBody = rerun.json();
    expect(rerunBody.rerun_of).toBe(seed.runId);
    expect(rerunBody.status).toBe("queued");

    // The queued rerun already carries the overlay with provenance and never
    // a silent overwrite; the prior revision is untouched.
    const rerunTable = await app.inject({
      method: "GET",
      url: `/api/research-runs/${rerunBody.id}/table`,
      headers: ownerAuth,
    });
    const carried = rerunTable
      .json()
      .items.flatMap(
        (item: {
          row_source_id: string;
          cells: { origin: string; value: unknown; corrected_from_run_id: string | null }[];
        }) => item.cells.map((cell) => ({ ...cell, row: item.row_source_id }))
      )
      .filter((cell: { origin: string }) => cell.origin === "correction");
    expect(carried).toHaveLength(1);
    expect(carried[0].row).toBe(seed.sources[1]);
    expect(carried[0].corrected_from_run_id).toBe(seed.runId);

    const priorTable = await app.inject({
      method: "GET",
      url: `/api/research-runs/${seed.runId}/table`,
      headers: ownerAuth,
    });
    expect(
      priorTable
        .json()
        .items.flatMap((item: { cells: { origin: string }[] }) => item.cells)
        .filter((cell: { origin: string }) => cell.origin === "machine")
    ).toHaveLength(4);

    // Complete the rerun with a new extraction and diff the revisions.
    await store.markResearchRunRunning(OWNER, rerunBody.id);
    await store.recordResearchMachineCell(OWNER, rerunBody.id, {
      columnId: priceColumn.id,
      rowSourceId: seed.sources[0],
      rawValue: 5.25,
    });
    await store.finishResearchRun(OWNER, rerunBody.id, "completed");

    const compared = await app.inject({
      method: "GET",
      url: `/api/research-runs/${rerunBody.id}/table?against=${seed.runId}`,
      headers: ownerAuth,
    });
    expect(compared.statusCode).toBe(200);
    const comparison = compared.json().comparison;
    expect(comparison.from_run_id).toBe(seed.runId);
    expect(comparison.to_run_id).toBe(rerunBody.id);
    expect(comparison.carried_overrides).toEqual([
      { column_id: priceColumn.id, row_source_id: seed.sources[1], corrected_from_run_id: seed.runId },
    ]);
    const moved = comparison.changed_cells.find(
      (change: { row_source_id: string; column_id: string }) =>
        change.row_source_id === seed.sources[0] && change.column_id === priceColumn.id
    );
    expect(moved.machine_changed).toBe(true);
    expect(moved.correction_changed).toBe(false);
    expect(moved.before.effective.value).toBe(4.5);
    expect(moved.after.effective.value).toBe(5.25);

    // An `against` run from another definition or account fails honestly.
    const foreignAgainst = await app.inject({
      method: "GET",
      url: `/api/research-runs/${rerunBody.id}/table?against=${randomUUID()}`,
      headers: ownerAuth,
    });
    expect(foreignAgainst.statusCode).toBe(404);

    // Page view options are served with an honest view_state.
    const sorted = await app.inject({
      method: "GET",
      url: `/api/research-runs/${rerunBody.id}/table?sort_column=${priceColumn.id}&sort_dir=desc`,
      headers: ownerAuth,
    });
    expect(sorted.json().view_state).toMatchObject({
      sort_applied: true,
      filter_applied: false,
      basis: "row_source_id_keyset",
      sort_dir: "desc",
    });
    expect(sorted.json().items[0].row_source_id).toBe(seed.sources[0]);

    const filtered = await app.inject({
      method: "GET",
      url: `/api/research-runs/${rerunBody.id}/table?filter_column=${priceColumn.id}&filter_status=conflicting`,
      headers: ownerAuth,
    });
    expect(filtered.json().view_state.filter_applied).toBe(true);
    expect(filtered.json().items).toEqual([]);

    const badSort = await app.inject({
      method: "GET",
      url: `/api/research-runs/${rerunBody.id}/table?sort_column=${randomUUID()}`,
      headers: ownerAuth,
    });
    expect(badSort.statusCode).toBe(400);
    expect(badSort.json().code).toBe("RESEARCH_VALIDATION");
  });

  it("exports the exact stored revision: CSV with both origins and provenance, manifest with limit states", async () => {
    const app = await buildApp();
    const seed = await seedComparisonRun();
    const store = storageRuntime().research;
    await store.applyResearchReviewOps(OWNER, seed.runId, 1, [
      { op: "correct_cell", column_id: priceColumn.id, row_source_id: seed.sources[1], value: 5 },
    ]);

    const csv = await app.inject({
      method: "GET",
      url: `/api/research-runs/${seed.runId}/export?format=csv`,
      headers: ownerAuth,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain(".csv");
    expect(csv.headers["cache-control"]).toBe("no-store");
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    // Machine original and correction overlay coexist in the CSV.
    expect(csv.body).toContain(",machine,5,invalid,");
    expect(csv.body).toContain(",correction,5,supported,");

    const manifest = await app.inject({
      method: "GET",
      url: `/api/research-runs/${seed.runId}/export?format=manifest`,
      headers: ownerAuth,
    });
    expect(manifest.statusCode).toBe(200);
    const document = manifest.json();
    expect(document.artifact).toBe("research_run_export_manifest");
    expect(document.run.id).toBe(seed.runId);
    expect(document.limits.table.limit_bytes).toBe(1_048_576);
    expect(document.limits.export_truncated).toBe(false);
    expect(document.evidence[0].locators[0].kind).toBe("text_span");
    const corrections = document.cells.filter((cell: { origin: string }) => cell.origin === "correction");
    expect(corrections).toHaveLength(1);
    expect(corrections[0].corrected_at).not.toBeNull();
    expect(corrections[0].corrected_from_run_id).toBeNull();
  });
});
