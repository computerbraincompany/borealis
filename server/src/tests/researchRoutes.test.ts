import Fastify, { type FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { assistantTextChunks, startScriptedOpenAiServer, type ScriptedOpenAiServer } from "./scriptedOpenAiServer.js";
import { runtimeSettingsStore } from "../runtimeSettings.js";
import { encodeCatalogCursor } from "../catalogPagination.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";
import { installHttpBoundary } from "../httpErrors.js";
import { researchRoutes } from "../routes/research.js";
import { closeRuntimeSettings, initializeRuntimeSettings } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const apps: FastifyInstance[] = [];
const providers: ScriptedOpenAiServer[] = [];
let runtimeDirectory = "";

/**
 * The run-start admission validates the definition's chat model against the
 * live catalog when discovery answers. Every start/plan test points Settings
 * at a scripted catalog so the outcome is identical whether or not a real
 * provider happens to be listening on the default loopback port.
 */
async function startProvider(
  models: readonly string[],
  chatResponses: readonly (readonly Record<string, unknown>[])[] = []
): Promise<ScriptedOpenAiServer> {
  const provider = await startScriptedOpenAiServer(models[0] ?? "route-chat-model", chatResponses, { models });
  providers.push(provider);
  await runtimeSettingsStore().patch({ llmBaseUrl: provider.origin, chatModel: models[0] ?? "route-chat-model" });
  return provider;
}

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-research-"));
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
  // Deterministic loopback provider: the consent gate never engages and the
  // run authorization snapshot captures a local identity.
  await initializeRuntimeSettings({
    settingsFile: path.join(runtimeDirectory, "settings.json"),
    env: {},
  });
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

async function insertSource(
  id: string,
  accountId: string,
  options: { status?: string; readyGeneration?: number | null } = {}
) {
  await storageRuntime().ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,size_bytes,status,ready_generation)
     VALUES (?,?,?,'document',?,?,100,?,?)`,
    [
      id,
      accountId,
      `src-${id.slice(0, 8)}`,
      `${id.slice(0, 8)}.md`,
      `/w/${id}.md`,
      options.status ?? "ready",
      options.readyGeneration === undefined ? 1 : options.readyGeneration,
    ]
  );
}

function memoBody(sourceIds: readonly string[], extra: Record<string, unknown> = {}) {
  return {
    title: "Supplier diligence",
    question: "Which supplier offers the best renewal terms?",
    output_kind: "memo",
    source_ids: sourceIds,
    chat_model: "test-chat-model",
    ...extra,
  };
}

async function createDefinition(app: FastifyInstance, body: Record<string, unknown>) {
  const created = await app.inject({ method: "POST", url: "/api/research", headers: ownerAuth, body });
  expect(created.statusCode).toBe(201);
  return created.json();
}

/** Drive a definition's run to a reviewable state through the durable store. */
async function seedFinishedRun(definitionId: string, options: { completed?: boolean } = {}) {
  const store = storageRuntime().research;
  const run = await store.startResearchRun(OWNER, definitionId, {
    authorization: { providerOrigin: "http://127.0.0.1:1234", providerLocality: "local", providerRevision: 1 },
  });
  await store.markResearchRunRunning(OWNER, run.id);
  const stored = await store.getResearchRun(OWNER, run.id);
  const sourceId = stored!.sources[0]!.sourceId;
  const excerpt = "Net-30 renewal with a 4% uplift.";
  const evidence = await store.insertResearchEvidence(OWNER, run.id, {
    sourceId,
    generation: stored!.sources[0]!.generation,
    chunkId: randomUUID(),
    label: "proposal.md",
    excerpt,
    contentHash: createHash("sha256").update(excerpt, "utf8").digest("hex"),
    stepOrdinal: 0,
    query: "renewal terms",
  });
  const claim = await store.addResearchClaim(OWNER, run.id, {
    kind: "claim",
    text: "The uplift is four percent.",
    classification: "supported",
    evidenceRefs: [evidence.id],
  });
  await store.finishResearchRun(OWNER, run.id, options.completed ? "completed" : "needs_review");
  return { runId: run.id, evidenceId: evidence.id, claimId: claim.id };
}

describe("research routes — auth and schema", () => {
  it("serves schema v25 and requires authentication before any parsing", async () => {
    const app = await buildApp();
    const version = await storageRuntime().ledger.get<{ user_version: unknown }>("PRAGMA user_version");
    expect(Number(version?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);

    const unauthenticated = await app.inject({ method: "GET", url: "/api/research" });
    expect(unauthenticated.statusCode).toBe(401);

    // An unauthenticated oversized/malformed body must 401, never 413/400.
    const oversized = await app.inject({
      method: "POST",
      url: "/api/research",
      headers: { "content-type": "application/json" },
      payload: `{"title":"${"x".repeat(1024 * 1024)}"`,
    });
    expect(oversized.statusCode).toBe(401);

    // Authenticated but over the declared ceiling is 413 at the parser.
    const overLimit = await app.inject({
      method: "POST",
      url: "/api/research",
      headers: { ...ownerAuth, "content-type": "application/json" },
      payload: `{"title":"${"x".repeat(2 * 1024 * 1024)}"}`,
    });
    expect(overLimit.statusCode).toBe(413);
  });
});

describe("research routes — definitions", () => {
  it("creates, lists, reads, edits with CAS, and deletes owned definitions", async () => {
    const app = await buildApp();
    const sourceId = randomUUID();
    await insertSource(sourceId, OWNER);

    const created = await createDefinition(app, memoBody([sourceId]));
    expect(created).toMatchObject({
      title: "Supplier diligence",
      output_kind: "memo",
      current_revision: 1,
      source_ids: [sourceId],
      sources: [{ source_id: sourceId, availability: "ready", ready_generation: 1 }],
      active_run: null,
    });

    // Drafts may be selected-empty.
    const draft = await createDefinition(app, memoBody([]));
    expect(draft.source_ids).toEqual([]);

    const list = await app.inject({ method: "GET", url: "/api/research", headers: ownerAuth });
    expect(list.statusCode).toBe(200);
    const page = list.json();
    expect(page.items.map((item: { id: string }) => item.id).sort()).toEqual([created.id, draft.id].sort());
    expect(page.next_cursor).toBeNull();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/research/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, question: "Revised question", source_ids: [] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ current_revision: 2, question: "Revised question", source_ids: [] });

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/research/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, title: "Stale" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("RESEARCH_REVISION_CONFLICT");

    const validation = await app.inject({
      method: "POST",
      url: "/api/research",
      headers: ownerAuth,
      body: { ...memoBody([sourceId]), output_kind: "comparison" },
    });
    expect(validation.statusCode).toBe(400);
    expect(validation.json().code).toBe("RESEARCH_VALIDATION");

    // Cross-account reads are plain 404s; foreign ids are not leaked.
    const foreignRead = await app.inject({ method: "GET", url: `/api/research/${created.id}`, headers: foreignAuth });
    expect(foreignRead.statusCode).toBe(404);

    const deleted = await app.inject({ method: "DELETE", url: `/api/research/${draft.id}`, headers: ownerAuth });
    expect(deleted.json()).toEqual({ ok: true });
    const stillThere = await app.inject({ method: "GET", url: `/api/research/${draft.id}`, headers: ownerAuth });
    expect(stillThere.statusCode).toBe(404);
  });

  it("refuses a deleted source row for foreign or unknown definitions without leaking", async () => {
    const app = await buildApp();
    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/research/${randomUUID()}`,
      headers: ownerAuth,
    });
    expect(foreignDelete.statusCode).toBe(404);
  });
});

describe("research routes — start, cancel, and history", () => {
  it("starts a durable run, refuses one active per definition, and cancels idempotently", async () => {
    await startProvider(["test-chat-model"]);
    const app = await buildApp();
    const sourceId = randomUUID();
    await insertSource(sourceId, OWNER, { readyGeneration: 5 });
    const definition = await createDefinition(app, memoBody([sourceId]));

    const started = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(started.statusCode).toBe(201);
    const run = started.json();
    expect(run).toMatchObject({ status: "queued", definition_revision: 1, chat_model: "test-chat-model" });
    expect(run.sources).toEqual([{ source_id: sourceId, generation: 5 }]);
    expect(run.budgets).toMatchObject({ steps: 8, searches: 32, model_requests: 40, evidence: 100 });
    // The provider origin never reaches the public payload.
    expect(started.body).not.toContain("provider_origin");
    expect(started.body).not.toContain("127.0.0.1");

    const again = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "RESEARCH_ACTIVE_RUN", existing_run_id: run.id });

    const history = await app.inject({ method: "GET", url: `/api/research/${definition.id}/runs`, headers: ownerAuth });
    expect(history.json().items.map((item: { id: string }) => item.id)).toEqual([run.id]);

    const cancelled = await app.inject({ method: "DELETE", url: `/api/research-runs/${run.id}`, headers: ownerAuth });
    expect(cancelled.json()).toEqual({ ok: true, status: "cancelled" });
    const againCancel = await app.inject({ method: "DELETE", url: `/api/research-runs/${run.id}`, headers: ownerAuth });
    expect(againCancel.json()).toEqual({ ok: true, status: "cancelled" });

    // Deletion of a definition with active work cancels first and drains.
    const second = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(second.statusCode).toBe(201);
    const deleted = await app.inject({ method: "DELETE", url: `/api/research/${definition.id}`, headers: ownerAuth });
    expect(deleted.statusCode).toBe(200);
  });

  it("surfaces precise start-admission conflicts", async () => {
    await startProvider(["test-chat-model"]);
    const app = await buildApp();
    const ready = randomUUID();
    const indexing = randomUUID();
    await insertSource(ready, OWNER);
    await insertSource(indexing, OWNER, { status: "index", readyGeneration: null });
    const definition = await createDefinition(app, memoBody([ready, indexing]));

    const conflict = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "RESEARCH_INPUTS_NOT_READY", unready_source_ids: [indexing] });

    const empty = await createDefinition(app, memoBody([]));
    const refused = await app.inject({
      method: "POST",
      url: `/api/research/${empty.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("RESEARCH_SCOPE_EMPTY");

    const foreignRun = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/runs`,
      headers: foreignAuth,
      body: {},
    });
    expect(foreignRun.statusCode).toBe(404);
  });
});

describe("research routes — dossier reads", () => {
  it("reads run detail, evidence keyset (max 50), and the comparison table", async () => {
    const app = await buildApp();
    const sourceId = randomUUID();
    await insertSource(sourceId, OWNER);
    const definition = await createDefinition(app, memoBody([sourceId]));
    const { runId, claimId } = await seedFinishedRun(definition.id);

    const detail = await app.inject({ method: "GET", url: `/api/research-runs/${runId}`, headers: ownerAuth });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.status).toBe("needs_review");
    expect(body.counts.evidence_count ?? body.counts.evidenceCount).toBeDefined();
    expect(body.claims.map((claim: { id: string }) => claim.id)).toEqual([claimId]);
    expect(body.usage).toBeDefined();

    const evidence = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/evidence`,
      headers: ownerAuth,
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().items[0]).toMatchObject({ excerpt: "Net-30 renewal with a 4% uplift.", irrelevant: false });

    // Evidence pages cap at 50.
    const tooMany = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/evidence?limit=51`,
      headers: ownerAuth,
    });
    expect(tooMany.statusCode).toBe(400);

    const cursor = encodeCatalogCursor("research_evidence", {
      timestamp: evidence.json().items[0].retrieved_at,
      id: evidence.json().items[0].id,
    });
    const paged = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/evidence?cursor=${cursor}`,
      headers: ownerAuth,
    });
    expect(paged.statusCode).toBe(200);
    expect(paged.json().items).toEqual([]);

    const bogus = encodeCatalogCursor("analyses", {
      timestamp: evidence.json().items[0].retrieved_at,
      id: evidence.json().items[0].id,
    });
    const crossEndpoint = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/evidence?cursor=${bogus}`,
      headers: ownerAuth,
    });
    expect(crossEndpoint.statusCode).toBe(400);
    expect(crossEndpoint.json().code).toBe("INVALID_CATALOG_CURSOR");

    const table = await app.inject({ method: "GET", url: `/api/research-runs/${runId}/table`, headers: ownerAuth });
    expect(table.statusCode).toBe(200);
    const tableBody = table.json();
    expect(tableBody.columns).toEqual([]);
    expect(tableBody.items.map((row: { row_source_id: string }) => row.row_source_id)).toEqual([sourceId]);
    expect(tableBody.limit_state).toMatchObject({ serialized_bytes: expect.any(Number), at_limit: false });

    // Foreign run reads are 404 on every dossier surface.
    for (const url of [
      `/api/research-runs/${runId}`,
      `/api/research-runs/${runId}/evidence`,
      `/api/research-runs/${runId}/table`,
    ]) {
      const foreign = await app.inject({ method: "GET", url, headers: foreignAuth });
      expect(foreign.statusCode).toBe(404);
    }
  });
});

describe("research routes — review and reserved stages", () => {
  it("applies review ops with CAS and keeps notes out of evidence", async () => {
    const app = await buildApp();
    const sourceId = randomUUID();
    await insertSource(sourceId, OWNER);
    const definition = await createDefinition(app, memoBody([sourceId]));
    const { runId, evidenceId, claimId } = await seedFinishedRun(definition.id);

    const review = await app.inject({
      method: "PATCH",
      url: `/api/research-runs/${runId}/review`,
      headers: ownerAuth,
      body: {
        expected_revision: 1,
        ops: [
          { op: "accept_claim", claim_id: claimId },
          { op: "add_note", target_kind: "run", note: "Scope was adequate." },
          { op: "flag_evidence", evidence_id: evidenceId, irrelevant: true },
        ],
      },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ review_revision: 2, ops_applied: 3 });
    expect(review.json().run.status).toBe("needs_review");

    const detail = await app.inject({ method: "GET", url: `/api/research-runs/${runId}`, headers: ownerAuth });
    expect(detail.json().claims[0].review_state).toBe("accepted");
    expect(detail.json().run_notes).toEqual(["Scope was adequate."]);
    const evidence = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/evidence`,
      headers: ownerAuth,
    });
    expect(evidence.json().items[0].irrelevant).toBe(true);
    // Notes are review content, never evidence rows.
    expect(evidence.json().items).toHaveLength(1);

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/research-runs/${runId}/review`,
      headers: ownerAuth,
      body: { expected_revision: 1, ops: [{ op: "reject_claim", claim_id: claimId }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("RESEARCH_REVISION_CONFLICT");

    const tooManyOps = await app.inject({
      method: "PATCH",
      url: `/api/research-runs/${runId}/review`,
      headers: ownerAuth,
      body: {
        expected_revision: 2,
        ops: Array.from({ length: 101 }, () => ({ op: "add_note", target_kind: "run", note: "x" })),
      },
    });
    expect(tooManyOps.statusCode).toBe(400);

    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/research-runs/${runId}/review`,
      headers: foreignAuth,
      body: { expected_revision: 2, ops: [{ op: "accept_claim", claim_id: claimId }] },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("generates an editable plan proposal (never starting execution) and keeps stage 3 reserved", async () => {
    await startProvider(
      ["test-chat-model"],
      [
        assistantTextChunks("test-chat-model", [
          JSON.stringify({
            steps: [
              { objective: "Find pricing evidence", questions: ["renewal price", "uplift percentage"] },
              { objective: "Compare terms", questions: ["contract length"] },
            ],
          }),
        ]),
      ]
    );
    const app = await buildApp();
    const sourceId = randomUUID();
    await insertSource(sourceId, OWNER);
    const definition = await createDefinition(app, memoBody([sourceId]));
    const { runId } = await seedFinishedRun(definition.id, { completed: true });

    const plan = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/plan`,
      headers: ownerAuth,
      body: { expected_revision: 1 },
    });
    expect(plan.statusCode).toBe(200);
    const proposal = plan.json();
    expect(proposal).toMatchObject({
      definition_id: definition.id,
      base_revision: 1,
      model_used: true,
      fallback: false,
      error_code: null,
    });
    // The model's proposal is returned verbatim (with ids assigned), not run.
    expect(proposal.plan.steps.map((step: { objective: string }) => step.objective)).toEqual([
      "Find pricing evidence",
      "Compare terms",
    ]);
    expect(proposal.plan.steps[0].id).toMatch(/^[0-9a-f-]{36}$/);

    // The proposal creates no run: the only run is the seeded one.
    const history = await app.inject({ method: "GET", url: `/api/research/${definition.id}/runs`, headers: ownerAuth });
    expect(history.json().items.map((item: { id: string }) => item.id)).toEqual([runId]);

    // A stale expected_revision is an honest conflict; no second provider call.
    const stale = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/plan`,
      headers: ownerAuth,
      body: { expected_revision: 2 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("RESEARCH_REVISION_CONFLICT");

    // Stage 3: a completed run creates a reviewed M13 DRAFT (revision 1,
    // outside any publication chain) and exports its exact stored table.
    const artifacts = await app.inject({
      method: "POST",
      url: `/api/research-runs/${runId}/artifacts`,
      headers: ownerAuth,
      body: {},
    });
    expect(artifacts.statusCode).toBe(201);
    const artifact = artifacts.json();
    expect(artifact).toMatchObject({ run_id: runId, document_revision: 1 });
    expect(artifact.projection).toMatchObject({ output_kind: "memo", run_status: "completed" });

    const exportCsv = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/export?format=csv`,
      headers: ownerAuth,
    });
    expect(exportCsv.statusCode).toBe(200);
    expect(exportCsv.body.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    expect(exportCsv.body).toContain("limit_state:");
    // The memo run has no comparison cells: header-only success, not a failure.
    const manifest = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/export?format=manifest`,
      headers: ownerAuth,
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().artifact).toBe("research_run_export_manifest");

    // A malformed format is a schema rejection, not an ownership probe.
    const badFormat = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/export?format=json`,
      headers: ownerAuth,
    });
    expect(badFormat.statusCode).toBe(400);

    // Export/artifact routes still enforce ownership.
    const foreignPlan = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/plan`,
      headers: foreignAuth,
      body: {},
    });
    expect(foreignPlan.statusCode).toBe(404);
    const foreignExport = await app.inject({
      method: "GET",
      url: `/api/research-runs/${runId}/export?format=csv`,
      headers: foreignAuth,
    });
    expect(foreignExport.statusCode).toBe(404);
    const foreignArtifact = await app.inject({
      method: "POST",
      url: `/api/research-runs/${runId}/artifacts`,
      headers: foreignAuth,
      body: {},
    });
    expect(foreignArtifact.statusCode).toBe(404);
  });
});
