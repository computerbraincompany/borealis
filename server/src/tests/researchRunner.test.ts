/**
 * Durable research execution — the M15 stage-2 runner suite.
 *
 * Like the document-rewrite vertical suite, this crosses every seam without
 * module mocks: the real research HTTP routes, the durable research ledger and
 * its transactions, the real account-authorized streaming client against a
 * protocol-minimal scripted provider on loopback, and the real runner
 * lifecycle. The single seam is the SEARCH boundary: `createResearchRunner`
 * accepts an injected search function so step/generation behavior is scripted
 * deterministically (the real `searchCapturedScope` wiring over real stores is
 * proven in researchEvidence.test.ts). Bodies are inspected in memory only and
 * never logged.
 *
 * The suite proves the contracts that matter: evidence is durably persisted
 * BEFORE any synthesis provider call (provider call log), budget exhaustion
 * ends `needs_review` with explicit gaps and preserved partial work, a lost
 * pinned generation stops the step `source_changed`, cancellation is observed
 * mid-step, restart retries at most once with the same step identity without
 * duplicate evidence (dedupe), one research run executes per account, the
 * consent gate refuses every transport, plan proposals never start execution,
 * and no provider reasoning ever reaches persisted summaries.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { ResearchQueueFullError } from "../db/stores/researchStore.js";
import { createResearchRunner, bindDefaultResearchRunner } from "../researchRunner.js";
import { routes } from "../routes.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import type { SourceSearchResult } from "../sourceSearch.js";
import { assistantTextChunks, startScriptedOpenAiServer, type ScriptedOpenAiServer } from "./scriptedOpenAiServer.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_MODEL = "research-chat-model";
const EMBED_MODEL = "research-embed-model";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER_ID, email: "owner@example.test" })}` };

const apps: FastifyInstance[] = [];
const providers: ScriptedOpenAiServer[] = [];
const directories: string[] = [];
const runners: Array<ReturnType<typeof createResearchRunner>> = [];
const releaseHolds: Array<() => void> = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releaseHolds.push(resolve);
  return { promise, resolve };
}

afterEach(async () => {
  for (const release of releaseHolds.splice(0)) release();
  for (const runner of runners.splice(0)) await runner.stop().catch(() => undefined);
  bindDefaultResearchRunner(undefined);
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(providers.splice(0).map((provider) => provider.close().catch(() => undefined)));
  closeRuntimeSettings();
  await closeStorageRuntime();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 4 }))
  );
});

async function bootWorkspace(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-research-runner-"));
  directories.push(directory);
  await initializeStorageRuntime({
    sqlitePath: path.join(directory, "ledger.sqlite"),
    lanceDirectory: path.join(directory, "lancedb"),
    embeddingDimension: 3,
  });
  await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    OWNER_ID,
    "owner@example.test",
    "test-password-hash",
  ]);
  await initializeRuntimeSettings({ settingsFile: path.join(directory, "settings.json"), env: {} });
}

async function pointProviderAt(provider: ScriptedOpenAiServer): Promise<void> {
  await runtimeSettingsStore().patch({ llmBaseUrl: provider.origin, chatModel: CHAT_MODEL, embedModel: EMBED_MODEL });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await app.register(routes);
  await app.ready();
  return app;
}

function ownRunner(
  search: (input: {
    accountId: string;
    scopes: readonly { sourceId: string; generation: number }[];
    query: string;
    mode: string;
    signal?: AbortSignal;
  }) => Promise<SourceSearchResult>
): ReturnType<typeof createResearchRunner> {
  const runner = createResearchRunner({
    store: storageRuntime().research,
    search: search as never,
    cancelPollIntervalMs: 30,
    claimIntervalMs: 120,
  });
  runners.push(runner);
  bindDefaultResearchRunner(runner);
  return runner;
}

async function insertSource(displayName: string, readyGeneration = 1): Promise<string> {
  const id = randomUUID();
  await storageRuntime().ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,size_bytes,status,ready_generation)
     VALUES (?,?,?,'document',?,?,100,'ready',?)`,
    [id, OWNER_ID, displayName, `${displayName}.md`, `/w/${id}.md`, readyGeneration]
  );
  return id;
}

function memoBody(sourceIds: readonly string[], plan: unknown, extra: Record<string, unknown> = {}) {
  return {
    title: "Supplier diligence",
    question: "Which supplier offers the best renewal terms?",
    output_kind: "memo",
    source_ids: sourceIds,
    chat_model: CHAT_MODEL,
    plan,
    ...extra,
  };
}

function steps(...objectives: [string, string[]][]) {
  return { steps: objectives.map(([objective, questions]) => ({ id: randomUUID(), objective, questions })) };
}

async function createDefinition(app: FastifyInstance, body: Record<string, unknown>): Promise<any> {
  const created = await app.inject({ method: "POST", url: "/api/research", headers: ownerAuth, body });
  expect(created.statusCode, created.body).toBe(201);
  return created.json();
}

async function getRun(app: FastifyInstance, runId: string): Promise<any> {
  const response = await app.inject({ method: "GET", url: `/api/research-runs/${runId}`, headers: ownerAuth });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function waitForRunStatus(
  app: FastifyInstance,
  runId: string,
  statuses: readonly string[],
  timeoutMs = 15_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(app, runId);
    if (statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} stalled in status ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Deterministic scripted search results; also records every requested scope. */
function scriptedSearch(script: {
  hits?: (
    scope: readonly { sourceId: string; generation: number }[],
    query: string,
    mode: string
  ) => SourceSearchResult;
}) {
  const requests: { scopes: readonly { sourceId: string; generation: number }[]; query: string; mode: string }[] = [];
  const search = async (input: {
    accountId: string;
    scopes: readonly { sourceId: string; generation: number }[];
    query: string;
    mode: string;
    signal?: AbortSignal;
  }): Promise<SourceSearchResult> => {
    requests.push({ scopes: input.scopes, query: input.query, mode: input.mode });
    return (
      script.hits?.(input.scopes, input.query, input.mode) ??
      emptyResult(input.scopes.map((scope) => readyScope(scope.sourceId, scope.generation)))
    );
  };
  return { search, requests };
}

function emptyResult(
  scope: readonly { source_id: string; generation: number; status: "ready" | "source_changed" | "unavailable" }[]
): SourceSearchResult {
  return Object.freeze({
    mode: "keyword",
    query_truncated: false,
    scope: Object.freeze(scope.map((entry) => Object.freeze(entry))),
    hits: Object.freeze([]),
    returned_char_count: 0,
    truncated: false,
  });
}

function readyScope(sourceId: string, generation: number) {
  return { source_id: sourceId, generation, status: "ready" as const };
}

function hit(
  sourceId: string,
  generation: number,
  chunkId: string,
  label: string,
  excerpt: string,
  rank = 1
): SourceSearchResult["hits"][number] {
  return Object.freeze({
    source_id: sourceId,
    generation,
    chunk_id: chunkId,
    label,
    excerpt,
    score: 1,
    rank,
    locators: Object.freeze([{ kind: "text_span", char_start: 0, char_len: excerpt.length } as const]),
  });
}

function resultWith(
  scope: readonly { source_id: string; generation: number; status: "ready" | "source_changed" | "unavailable" }[],
  hits: readonly SourceSearchResult["hits"][number][]
): SourceSearchResult {
  return Object.freeze({
    mode: "keyword",
    query_truncated: false,
    scope: Object.freeze([...scope]),
    hits: Object.freeze([...hits]),
    returned_char_count: hits.reduce((sum, item) => sum + item.excerpt.length, 0),
    truncated: false,
  });
}

describe("research runner (vertical)", () => {
  it(
    "runs a memo end-to-end: evidence is persisted before the synthesis call and claims cite only this run's dossier",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const sourceA = await insertSource("alpha-proposal.md");
      const sourceB = await insertSource("beta-proposal.md");
      const chunkA = randomUUID();
      const chunkB = randomUUID();

      let evidenceBeforeSynthesis = -1;
      let dossierIds: string[] = [];
      const runRef: { id?: string } = {};
      const synthFrames = assistantTextChunks(CHAT_MODEL, ["SYNTH-MARKER"]);
      const provider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [
          [
            // A reasoning frame must never reach any persisted summary.
            {
              id: "chatcmpl-reasoning",
              object: "chat.completion.chunk",
              created: 1,
              model: CHAT_MODEL,
              choices: [{ index: 0, delta: { reasoning_content: "SECRET-REASONING" }, finish_reason: null }],
            },
            ...assistantTextChunks(CHAT_MODEL, ["Alpha pricing evidence: ", "net-30 renewal at 4% uplift.  "]),
          ],
          assistantTextChunks(CHAT_MODEL, ["Beta renewal terms are longer but pricier."]),
          synthFrames,
        ],
        {
          onCall: async (index) => {
            if (index === 2) {
              // Proof of ordering: at the synthesis provider call, the dossier
              // is already durable.
              const page = await storageRuntime().research.listResearchEvidence(OWNER_ID, runRef.id!, {
                limit: 50,
                after: null,
              });
              evidenceBeforeSynthesis = page.items.length;
              dossierIds = page.items.map((item) => item.id);
              (synthFrames[0] as any).choices[0].delta.content = JSON.stringify({
                claims: [
                  {
                    text: "Alpha offers net-30 renewal at 4%.",
                    classification: "supported",
                    evidence_ids: [dossierIds[0]],
                  },
                  {
                    text: "Alpha terms mix a valid and a foreign citation.",
                    classification: "supported",
                    evidence_ids: [randomUUID(), dossierIds[0]],
                  },
                  {
                    text: "The two proposals disagree on renewal cost.",
                    classification: "conflicting",
                    evidence_ids: [dossierIds[0], dossierIds[1]],
                  },
                  {
                    text: "A lone-source conflict cannot stand.",
                    classification: "conflicting",
                    evidence_ids: [dossierIds[0]],
                  },
                ],
                gaps: ["No termination-notice evidence was captured."],
              });
            }
          },
        }
      );
      providers.push(provider);
      await pointProviderAt(provider);

      const scripted = scriptedSearch({
        hits: (scopes, query, mode) => {
          if (mode === "semantic")
            return emptyResult(scopes.map((scope) => readyScope(scope.sourceId, scope.generation)));
          if (query.includes("alpha")) {
            return resultWith(
              scopes.map((scope) => readyScope(scope.sourceId, scope.generation)),
              [hit(sourceA, 1, chunkA, "alpha-proposal.md", "Alpha renewal: net-30 at 4% uplift.")]
            );
          }
          if (query.includes("beta")) {
            return resultWith(
              scopes.map((scope) => readyScope(scope.sourceId, scope.generation)),
              [hit(sourceB, 1, chunkB, "beta-proposal.md", "Beta renewal: annual lock at 7% uplift.")]
            );
          }
          return emptyResult(scopes.map((scope) => readyScope(scope.sourceId, scope.generation)));
        },
      });
      const runner = ownRunner(scripted.search);
      const app = await buildApp();
      const plan = steps(["Establish alpha pricing", ["alpha pricing"]], ["Establish beta pricing", ["beta pricing"]]);
      const definition = await createDefinition(app, memoBody([sourceA, sourceB], plan));
      const started = await app.inject({
        method: "POST",
        url: `/api/research/${definition.id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(started.statusCode).toBe(201);
      const runIdFromResponse = started.json().id as string;
      runRef.id = runIdFromResponse;

      const run = await waitForRunStatus(app, runIdFromResponse, ["completed", "needs_review", "failed", "cancelled"]);
      expect(run.status).toBe("completed");
      expect(run.steps.map((step: { status: string }) => step.status)).toEqual(["done", "done"]);
      expect(run.steps[0].attempts).toBe(1);
      // Reasoning never leaks into persisted summaries.
      expect(run.steps[0].outcome).toBe("Alpha pricing evidence: net-30 renewal at 4% uplift.");

      // Three provider calls: two step summaries, then synthesis — and at the
      // synthesis call the dossier was already durable (evidence-before-
      // synthesis ordering proof).
      expect(provider.calls).toHaveLength(3);
      expect(evidenceBeforeSynthesis).toBe(2);
      const evidence = await storageRuntime().research.listResearchEvidence(OWNER_ID, runIdFromResponse, {
        limit: 50,
        after: null,
      });
      expect(evidence.items).toHaveLength(2);
      expect(dossierIds).toHaveLength(2);

      const claims = run.claims as any[];
      const byText = (needle: string) => claims.find((claim) => claim.text.includes(needle));
      expect(byText("Alpha offers").classification).toBe("supported");
      expect(byText("Alpha offers").evidence_refs).toEqual([dossierIds[0]]);
      // The foreign citation is REJECTED; the claim survives on valid refs.
      expect(byText("foreign citation").evidence_refs).toEqual([dossierIds[0]]);
      // A two-source conflict with differing excerpts stands as conflicting.
      expect(byText("disagree on renewal").classification).toBe("conflicting");
      expect(byText("disagree on renewal").evidence_refs).toHaveLength(2);
      // A "conflict" citing one source cannot stand — honestly unsupported.
      expect(byText("lone-source conflict").classification).toBe("unsupported");
      expect(claims.filter((claim) => claim.kind === "gap").map((claim) => claim.text)).toEqual([
        "No termination-notice evidence was captured.",
      ]);

      // Each step prompt only ever saw its OWN step's evidence (bounded, never
      // the whole dossier): step 1 carries the alpha excerpt only, step 2 the
      // beta excerpt only.
      const firstStepPrompt = JSON.stringify((provider.calls[0] as any).messages);
      const secondStepPrompt = JSON.stringify((provider.calls[1] as any).messages);
      expect(firstStepPrompt).toContain("net-30 at 4% uplift");
      expect(firstStepPrompt).not.toContain("annual lock at 7%");
      expect(secondStepPrompt).toContain("annual lock at 7%");
      expect(secondStepPrompt).not.toContain("net-30 at 4% uplift");
      // Search used exactly the run's pinned source/generation contract.
      expect(scripted.requests[0].scopes).toEqual([
        { sourceId: sourceA, generation: 1 },
        { sourceId: sourceB, generation: 1 },
      ]);
      void runner;
    }
  );

  it(
    "searches every planned question and reports honest needs_review with gaps when the search budget is exhausted",
    { timeout: 90_000 },
    async () => {
      await bootWorkspace();
      const source = await insertSource("wide.md");
      // Empty search results: the exhaustion is entirely search-budget driven,
      // so no step summary or synthesis provider call is ever attempted.
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, []);
      providers.push(provider);
      await pointProviderAt(provider);

      const scripted = scriptedSearch({});
      const runner = ownRunner(scripted.search);
      const app = await buildApp();
      // 8 steps × 4 keyword questions, plus one optional semantic pass per
      // step, is far more than the 32-op search budget.
      const plan = steps(
        ...Array.from({ length: 8 }, (_, index): [string, string[]] => [
          `step ${index}`,
          Array.from({ length: 4 }, (_, q) => `wide question ${index}-${q}`),
        ])
      );
      const definition = await createDefinition(app, memoBody([source], plan));
      const started = await app.inject({
        method: "POST",
        url: `/api/research/${definition.id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      const run = await waitForRunStatus(app, started.json().id, ["needs_review", "completed", "failed"]);
      expect(run.status).toBe("needs_review");
      expect(run.error_code).toBe("RESEARCH_BUDGET_EXHAUSTED");
      // The store's CAS spent exactly the 32-operation budget, never more.
      expect(run.usage.searches).toBe(32);
      // Explicit gaps record the honest stop reason; never a false completion.
      const gaps = (run.claims as any[]).filter((claim) => claim.kind === "gap");
      expect(gaps.some((gap) => gap.text.includes("search budget exhausted"))).toBe(true);
      // Partial plan work is preserved: earlier steps ran, one stopped at the
      // budget, and the remaining planned steps are honestly left pending (not
      // silently marked complete).
      const statuses = run.steps.map((step: { status: string }) => step.status);
      expect(statuses).toContain("skipped");
      expect(statuses).toContain("pending");
      // No provider transport was reached (empty dossier → no synthesis).
      expect(provider.calls).toHaveLength(0);
      void runner;
    }
  );

  it(
    "stops the affected step source_changed when a pinned generation drifts, retaining partial work",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const source = await insertSource("drift.md");
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [
        assistantTextChunks(CHAT_MODEL, ["Step one captured stable evidence."]),
        assistantTextChunks(CHAT_MODEL, ["Synthesis over retained evidence."]),
      ]);
      providers.push(provider);
      await pointProviderAt(provider);

      let stepTwoAttempted = false;
      const scripted = scriptedSearch({
        hits: (scopes, query, mode) => {
          if (mode === "semantic") {
            return emptyResult(scopes.map((scope) => readyScope(scope.sourceId, scope.generation)));
          }
          if (query.includes("step-two")) {
            stepTwoAttempted = true;
            return resultWith([{ source_id: source, generation: 1, status: "source_changed" }], []);
          }
          return resultWith(
            scopes.map((scope) => readyScope(scope.sourceId, scope.generation)),
            [hit(source, 1, randomUUID(), "drift.md", "Stable evidence captured before the refresh.")]
          );
        },
      });
      const runner = ownRunner(scripted.search);
      const app = await buildApp();
      const plan = steps(["Step one", ["step-one"]], ["Step two", ["step-two"]], ["Step three", ["step-three"]]);
      const definition = await createDefinition(app, memoBody([source], plan));
      const started = await app.inject({
        method: "POST",
        url: `/api/research/${definition.id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      const run = await waitForRunStatus(app, started.json().id, ["needs_review", "completed", "failed"]);
      expect(stepTwoAttempted).toBe(true);
      expect(run.status).toBe("needs_review");
      expect(run.error_code).toBe("RESEARCH_SOURCE_CHANGED");
      // Step 1 completed with evidence, step 2 stopped at the drift, and the
      // never-dispatched step 3 is honestly left pending (the store forbids
      // settling a step that never ran) — never a false completion.
      expect(run.steps.map((step: { status: string }) => step.status)).toEqual(["done", "source_changed", "pending"]);
      // Partial work retained: step one's evidence survived the drift stop, and
      // synthesis over it ran (evidence-before-synthesis still holds).
      const evidence = await storageRuntime().research.listResearchEvidence(OWNER_ID, started.json().id, {
        limit: 50,
        after: null,
      });
      expect(evidence.items).toHaveLength(1);
      const gaps = (run.claims as any[]).filter((claim) => claim.kind === "gap");
      expect(gaps.some((gap: { text: string }) => gap.text.includes("generation changed"))).toBe(true);
      void runner;
    }
  );

  it(
    "cancels a running model call mid-step; the interrupted step settles and no synthesis follows",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const source = await insertSource("cancel.md");
      const hold = deferred();
      const arrived = deferred();
      const provider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [assistantTextChunks(CHAT_MODEL, ["must not land"])],
        {
          onCall: async () => {
            arrived.resolve();
            await hold.promise;
          },
        }
      );
      providers.push(provider);
      await pointProviderAt(provider);

      const cancelChunk = randomUUID();
      const scripted = scriptedSearch({
        hits: (scopes, _query, mode) =>
          mode === "semantic"
            ? emptyResult(scopes.map((scope) => readyScope(scope.sourceId, scope.generation)))
            : resultWith(
                scopes.map((scope) => readyScope(scope.sourceId, scope.generation)),
                [hit(source, 1, cancelChunk, "cancel.md", "Evidence captured before the cancellation.")]
              ),
      });
      const runner = ownRunner(scripted.search);
      const app = await buildApp();
      const definition = await createDefinition(app, memoBody([source], steps(["Capture", ["cancel question"]])));
      const started = await app.inject({
        method: "POST",
        url: `/api/research/${definition.id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      const runId = started.json().id;
      await waitForRunStatus(app, runId, ["running"]);
      await arrived.promise;

      const cancelled = await app.inject({ method: "DELETE", url: `/api/research-runs/${runId}`, headers: ownerAuth });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().status).toBe("cancelling");
      // The cancellation is observed at the transport boundary.
      await waitForRunStatus(app, runId, ["cancelled"]);
      hold.resolve();

      const settled = await getRun(app, runId);
      expect(settled.status).toBe("cancelled");
      expect(settled.steps[0].status).toBe("skipped");
      // Exactly one provider call (the interrupted step summary); no synthesis.
      expect(provider.calls).toHaveLength(1);
      // The captured evidence remains durable for review.
      const evidence = await storageRuntime().research.listResearchEvidence(OWNER_ID, runId, {
        limit: 50,
        after: null,
      });
      expect(evidence.items).toHaveLength(1);
      void runner;
    }
  );

  it(
    "restart resumes an interrupted run once with the same step identity and dedupes re-captured evidence",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const source = await insertSource("resume.md");
      const chunk = randomUUID();
      const hold = deferred();
      const arrived = deferred();
      const provider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [
          assistantTextChunks(CHAT_MODEL, ["interrupted attempt"]),
          assistantTextChunks(CHAT_MODEL, ["Retry completed the summary."]),
          assistantTextChunks(CHAT_MODEL, [
            JSON.stringify({
              claims: [{ text: "Resume claim.", classification: "supported", evidence_ids: ["$"] }],
              gaps: [],
            }),
          ]),
        ],
        {
          onCall: async (index) => {
            if (index === 0) {
              arrived.resolve();
              await hold.promise;
            }
          },
        }
      );
      providers.push(provider);
      await pointProviderAt(provider);

      const fixedHit = hit(source, 1, chunk, "resume.md", "Stable excerpt captured once and deduped on retry.");
      const scripted = scriptedSearch({
        hits: (scopes, _query, mode) =>
          mode === "semantic"
            ? emptyResult(scopes.map((scope) => readyScope(scope.sourceId, scope.generation)))
            : resultWith(
                scopes.map((scope) => readyScope(scope.sourceId, scope.generation)),
                [fixedHit]
              ),
      });

      const firstRunner = ownRunner(scripted.search);
      const app = await buildApp();
      const definition = await createDefinition(app, memoBody([source], steps(["Capture once", ["resume question"]])));
      const started = await app.inject({
        method: "POST",
        url: `/api/research/${definition.id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      const runId = started.json().id;
      await waitForRunStatus(app, runId, ["running"]);
      await arrived.promise;

      // An orderly shutdown interrupts the transport; the run stays durable
      // `running` for the bounded startup resume (never orphaned, never rerun).
      await firstRunner.stop();
      hold.resolve();
      const interrupted = await getRun(app, runId);
      expect(interrupted.status).toBe("running");
      expect(interrupted.steps[0].status).toBe("running");
      expect(interrupted.steps[0].attempts).toBe(1);
      const evidenceAfterCrash = await storageRuntime().research.listResearchEvidence(OWNER_ID, runId, {
        limit: 50,
        after: null,
      });
      expect(evidenceAfterCrash.items).toHaveLength(1);

      // A fresh runner recovers the interrupted step to `pending` (same
      // identity), retries it exactly once (attempts reach 2), and the re-search
      // re-captures the same hit — deduped, no duplicate evidence.
      const secondRunner = createResearchRunner({
        store: storageRuntime().research,
        search: scripted.search as never,
        cancelPollIntervalMs: 30,
        claimIntervalMs: 120,
      });
      runners.push(secondRunner);
      bindDefaultResearchRunner(secondRunner);
      secondRunner.start();
      const resumed = await waitForRunStatus(app, runId, ["completed", "needs_review", "failed"]);
      expect(resumed.status).not.toBe("failed");
      expect(resumed.steps[0].status).toBe("done");
      expect(resumed.steps[0].attempts).toBe(2);
      const evidenceAfterResume = await storageRuntime().research.listResearchEvidence(OWNER_ID, runId, {
        limit: 50,
        after: null,
      });
      expect(evidenceAfterResume.items).toHaveLength(1);
      // First attempt's provider call + retry summary + synthesis = 3, with the
      // single evidence row never duplicated.
      expect(provider.calls).toHaveLength(3);
    }
  );

  it("executes one research run per account at a time while the queue waits", { timeout: 60_000 }, async () => {
    await bootWorkspace();
    const source = await insertSource("serial.md");
    const hold = deferred();
    const arrived = deferred();
    const callOrder: number[] = [];
    const provider = await startScriptedOpenAiServer(
      CHAT_MODEL,
      [
        assistantTextChunks(CHAT_MODEL, ["A summary."]),
        assistantTextChunks(CHAT_MODEL, [JSON.stringify({ claims: [], gaps: ["gap a"] })]),
        assistantTextChunks(CHAT_MODEL, ["B summary."]),
        assistantTextChunks(CHAT_MODEL, [JSON.stringify({ claims: [], gaps: ["gap b"] })]),
      ],
      {
        onCall: async (index) => {
          callOrder.push(index);
          if (index === 0) {
            arrived.resolve();
            await hold.promise;
          }
        },
      }
    );
    providers.push(provider);
    await pointProviderAt(provider);

    const scripted = scriptedSearch({
      hits: (scopes, _query, mode) =>
        mode === "semantic"
          ? emptyResult(scopes.map((scope) => readyScope(scope.sourceId, scope.generation)))
          : resultWith(
              scopes.map((scope) => readyScope(scope.sourceId, scope.generation)),
              [hit(source, 1, randomUUID(), "serial.md", "Evidence for the serialized queue test.")]
            ),
    });
    const runner = ownRunner(scripted.search);
    runner.start();
    const app = await buildApp();
    const definitionA = await createDefinition(app, memoBody([source], steps(["A", ["qa"]])));
    const definitionB = await createDefinition(app, memoBody([source], steps(["B", ["qb"]])));
    const runA = await storageRuntime().research.startResearchRun(OWNER_ID, definitionA.id, {
      authorization: { providerOrigin: provider.origin, providerLocality: "local", providerRevision: 1 },
    });
    await waitForRunStatus(app, runA.id, ["running"]);
    await arrived.promise;
    // While A executes, B may be accepted into the queue but never executes.
    const runB = await storageRuntime().research.startResearchRun(OWNER_ID, definitionB.id, {
      authorization: { providerOrigin: provider.origin, providerLocality: "local", providerRevision: 1 },
    });
    runner.dispatch(runB);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await getRun(app, runB.id)).status).toBe("queued");

    hold.resolve();
    const doneA = await waitForRunStatus(app, runA.id, ["completed", "needs_review"]);
    expect(doneA.status).toBe("completed");
    const doneB = await waitForRunStatus(app, runB.id, ["completed", "needs_review", "failed"]);
    expect(doneB.status).toBe("completed");
    // Strict serialization: B's calls only start after A's finished.
    expect(callOrder).toEqual([0, 1, 2, 3]);
  });

  it("refuses an eleventh queued run per account and never executes it", async () => {
    await bootWorkspace();
    const source = await insertSource("cap.md");
    const store = storageRuntime().research;
    const authorization = {
      providerOrigin: "http://127.0.0.1:9",
      providerLocality: "local",
      providerRevision: 1,
    } as const;
    for (let index = 0; index < 10; index += 1) {
      const definition = await store.createResearchDefinition(OWNER_ID, {
        title: `cap ${index}`,
        question: "q",
        output_kind: "memo",
        source_ids: [source],
        chat_model: CHAT_MODEL,
      });
      await store.startResearchRun(OWNER_ID, definition.id, { authorization });
    }
    const definition = await store.createResearchDefinition(OWNER_ID, {
      title: "cap overflow",
      question: "q",
      output_kind: "memo",
      source_ids: [source],
      chat_model: CHAT_MODEL,
    });
    await expect(store.startResearchRun(OWNER_ID, definition.id, { authorization })).rejects.toBeInstanceOf(
      ResearchQueueFullError
    );
  });

  it(
    "answers 403 at the plan route before any provider transport and unblocks after acknowledgment",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, []);
      providers.push(provider);
      const app = await buildApp();
      const source = await insertSource("remote.md");
      const definition = await createDefinition(app, memoBody([source], undefined));

      await runtimeSettingsStore().patch({ llmBaseUrl: "https://remote-provider.example.test", chatModel: CHAT_MODEL });
      const blocked = await app.inject({
        method: "POST",
        url: `/api/research/${definition.id}/plan`,
        headers: ownerAuth,
        body: {},
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe("REMOTE_EGRESS_CONSENT_REQUIRED");
      expect(provider.calls).toHaveLength(0);

      const ack = await app.inject({
        method: "POST",
        url: "/api/consent/remote-egress",
        headers: ownerAuth,
        body: {},
      });
      expect(ack.statusCode).toBeLessThan(300);
      await pointProviderAt(provider);
      const proposal = await app.inject({
        method: "POST",
        url: `/api/research/${definition.id}/plan`,
        headers: ownerAuth,
        body: {},
      });
      // No scripted chat response: the deterministic fallback plan answers — no
      // execution is ever started by the plan route.
      expect(proposal.statusCode).toBe(200);
      expect(proposal.json().fallback).toBe(true);
      expect(proposal.json().plan.steps).toHaveLength(4);
      const history = await app.inject({
        method: "GET",
        url: `/api/research/${definition.id}/runs`,
        headers: ownerAuth,
      });
      expect(history.json().items).toEqual([]);
    }
  );

  it(
    "fails a claimed run with the consent code and zero transport when a remote provider appears before dispatch",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const provider = await startScriptedOpenAiServer(CHAT_MODEL, [assistantTextChunks(CHAT_MODEL, ["must not run"])]);
      providers.push(provider);
      await pointProviderAt(provider);
      const app = await buildApp();
      const source = await insertSource("queued.md");
      const definition = await createDefinition(app, memoBody([source], steps(["One", ["q"]])));

      // Queue under the local provider, then Settings switches to an
      // unacknowledged remote provider before the claim dispatches.
      const store = storageRuntime().research;
      const queued = await store.startResearchRun(OWNER_ID, definition.id, {
        authorization: { providerOrigin: provider.origin, providerLocality: "local", providerRevision: 1 },
      });
      await runtimeSettingsStore().patch({ llmBaseUrl: "https://remote-provider.example.test", chatModel: CHAT_MODEL });

      const scripted = scriptedSearch({});
      const runner = ownRunner(scripted.search);
      runner.start();
      const failed = await waitForRunStatus(app, queued.id, ["failed"]);
      expect(failed.error_code).toBe("REMOTE_EGRESS_CONSENT_REQUIRED");
      expect(provider.calls).toHaveLength(0);
    }
  );

  it(
    "refuses Start for a model the live catalog does not offer but admits while discovery is unavailable",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      // A catalog that answers, but without the definition's model.
      const catalog = await startScriptedOpenAiServer(CHAT_MODEL, [], { models: [CHAT_MODEL] });
      providers.push(catalog);
      await pointProviderAt(catalog);
      const app = await buildApp();
      const source = await insertSource("known.md");
      const known = await createDefinition(app, memoBody([source], undefined));
      const unknown = await createDefinition(app, memoBody([source], undefined, { chat_model: "missing-model" }));

      const refused = await app.inject({
        method: "POST",
        url: `/api/research/${unknown.id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("RESEARCH_MODEL_UNAVAILABLE");

      const admitted = await app.inject({
        method: "POST",
        url: `/api/research/${known.id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(admitted.statusCode).toBe(201);
      await app.inject({ method: "DELETE", url: `/api/research-runs/${admitted.json().id}`, headers: ownerAuth });

      // Discovery unavailable (catalog endpoint gone): admission defers to the
      // durable convention and does NOT refuse the start.
      await catalog.close();
      providers.splice(providers.indexOf(catalog), 1);
      const deferredAdmission = await app.inject({
        method: "POST",
        url: `/api/research/${known.id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(deferredAdmission.statusCode).toBe(201);
    }
  );
});

describe("research extraction output contract", () => {
  it("requires same-row evidence for non-null cells and retains unsupported output as invalid", async () => {
    await bootWorkspace();
    const source = await insertSource("supplier.md");
    const frames = Array.from({ length: 3 }, () => assistantTextChunks(CHAT_MODEL, ["placeholder"]));
    let runId = "";
    const provider = await startScriptedOpenAiServer(CHAT_MODEL, frames, {
      models: [CHAT_MODEL],
      onCall: async (index, body) => {
        expect((body as any).max_tokens).toBe(8192);
        if (index === 0) {
          frames[index] = assistantTextChunks(CHAT_MODEL, ["Captured the listed annual price."]);
          return;
        }
        expect(JSON.stringify((body as any).messages)).toContain("evidence_ids");
        const evidence = await storageRuntime().research.listResearchEvidence(OWNER_ID, runId, {
          limit: 50,
          after: null,
        });
        const reply = JSON.stringify({
          cells: [
            { source_id: source, value: 12000, evidence_ids: index === 1 ? [randomUUID()] : [evidence.items[0]!.id] },
          ],
        });
        const replacement = assistantTextChunks(CHAT_MODEL, [reply]);
        frames[index]!.splice(0, frames[index]!.length, ...replacement);
      },
    });
    providers.push(provider);
    await pointProviderAt(provider);
    const search = scriptedSearch({
      hits: (scopes) =>
        resultWith(
          scopes.map((scope) => readyScope(scope.sourceId, scope.generation)),
          [hit(source, 1, "aaaaaaaa-1111-4111-8111-111111111111", "supplier.md", "The annual price is 12000 USD.")]
        ),
    });
    ownRunner(search.search);
    const app = await buildApp();
    const columns = ["Uncited price", "Cited price"].map((label) => ({
      id: randomUUID(),
      label,
      question: "What is the annual price?",
      type: "number",
      unit: "USD",
    }));
    const definition = await createDefinition(
      app,
      memoBody([source], steps(["Find price", ["price"]]), {
        output_kind: "comparison",
        columns,
      })
    );
    const started = await app.inject({
      method: "POST",
      url: `/api/research/${definition.id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    expect(started.statusCode).toBe(201);
    runId = started.json().id;
    const run = await waitForRunStatus(app, runId, ["needs_review", "completed", "failed"]);
    expect(run.status).toBe("needs_review");
    const cells = await storageRuntime().ledger.all<{
      column_id: string;
      status: string;
      value: string;
      evidence_refs: string;
    }>("SELECT column_id,status,value,evidence_refs FROM research_table_cells WHERE run_id=?", [runId]);
    const uncited = cells.find((cell) => cell.column_id === columns[0]!.id)!;
    const cited = cells.find((cell) => cell.column_id === columns[1]!.id)!;
    expect(uncited).toMatchObject({ status: "invalid", value: "12000", evidence_refs: "[]" });
    expect(cited).toMatchObject({ status: "supported", value: "12000" });
    expect(JSON.parse(cited.evidence_refs)).toHaveLength(1);
  });
});
