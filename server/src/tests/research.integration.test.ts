/**
 * M15 stage 5 — the complete durable research job over the real stores.
 *
 * Where `researchRunner.test.ts` scripts the search boundary and
 * `researchEvidence.test.ts` proves the evidence layer, this suite executes
 * the milestone's own end-to-end contract through the real HTTP routes:
 *
 * - the milestone's three-supplier synthetic corpus (differing dates, amounts
 *   and terms, one contradiction about the shared onboarding fee, and one
 *   missing fact — the termination notice period) is ingested FOR REAL through
 *   the upload-store transition, the durable ingestion worker, REAL SQLite
 *   FTS5 shadow rows, and REAL scoped LanceDB KNN (the embedding transport is
 *   the only seam, deterministic through the same session/port contract);
 * - memo and comparison runs execute over real keyword + semantic search with
 *   scripted provider transcripts: dossier entries carry real typed locators
 *   and sha256 content hashes; a conflicting claim requires (and proves) two
 *   differing excerpts; the missing fact lands in the gap ledger as
 *   "not found in selected evidence"; unresolvable evidence references are
 *   dropped and never resolve to another run's evidence;
 * - the typed comparison table proves exact numbers/dates/enums, an invalid
 *   verbatim machine value (never coerced), a cell-level conflict over two
 *   real excerpts, an absent-fact `not_found` cell, a user correction overlay
 *   with provenance, a scoped rerun that carries overrides visibly, and the
 *   `against` diff between result revisions;
 * - exports are byte-checked (UTF-8 BOM, formula-guarded CSV text, exact
 *   fixture numbers, manifest locators and correction provenance); the M13
 *   reviewed draft lands in the real document store with gap/conflict
 *   disclosures and projection labels; cross-account reads and finished-run
 *   state rules refuse honestly;
 * - restart mid-run resumes through the bounded at-most-once retry with
 *   evidence deduplication, and search-budget exhaustion ends `needs_review`
 *   with explicit gaps and preserved partial work.
 *
 * Only provider transport and the embedding session are scripted; every
 * ledger, search, runner, export, and document path below is production code.
 *
 * Runs only under `vitest.integration.config.ts` (serialized native stores).
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { ConnectorRefreshStore } from "../db/stores/connectorRefreshStore.js";
import { SqliteIngestionStore } from "../db/stores/ingestionStore.js";
import { createResearchRunner, bindDefaultResearchRunner } from "../researchRunner.js";
import { routes } from "../routes.js";
import { IngestionExecutor, IngestionWorker, type IngestionDataOperations } from "../ingestionEngine.js";
import { extractDocument } from "../ingestSupport.js";
import { chunkTextWithLocators } from "../sourceLocations.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { assistantTextChunks, startScriptedOpenAiServer, type ScriptedOpenAiServer } from "./scriptedOpenAiServer.js";

const OWNER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "66666666-7777-4888-8999-000000000000";
const CHAT_MODEL = "integration-research-chat";
const EMBED_MODEL = "integration-research-embed";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER_ID, email: "owner@example.test" })}` };
const otherAuth = { authorization: `Bearer ${signToken({ userId: OTHER_ID, email: "other@example.test" })}` };

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

// -- Fixtures -----------------------------------------------------------------
// The milestone's three synthetic supplier proposals: differing dates, amounts
// and terms, the shared-onboarding-fee contradiction (900 vs 950 USD across
// two suppliers), and one fact stated nowhere (termination notice period).
// BlueRiver's body is padded so the two renewal statements land in DIFFERENT
// 900-character chunks: "manual written approval" inside chunk one and the
// automatic-renewal addendum inside chunk two only (chunk windows are [0,900)
// and [780,end) after whitespace collapsing).
const BLUE_FILLER = "Delivery cadence is weekly with a monthly steering call. ".repeat(12);

const ACME_DOC = [
  "# Acme Logistics proposal",
  "Supplier: Acme Logistics",
  "Price: 12000 USD",
  "Effective: 2026-01-15",
  "Renewal: automatic on the anniversary date",
  "Tier: premium",
  "Exceptions: =volume discounts above 500 shipments per quarter",
  "The shared platform onboarding fee is 900 USD one time.",
  "Payment terms are net 30 days.",
  "Regional freight and last-mile delivery are covered.",
].join("\n");

const BLUERIVER_DOC = [
  "# BlueRiver Analytics proposal",
  "Supplier: BlueRiver Analytics",
  "Price: 8750 USD",
  "Effective: 2025-11-01",
  "Renewal: manual written approval",
  "Tier: standard",
  "Exceptions: none stated",
  "The shared platform onboarding fee is 950 USD one time.",
  "Payment terms are net 45 days.",
  BLUE_FILLER,
  "Renewal addendum: the renewal quote allows automatic renewal.",
  "Data feeds are provisioned within five business days.",
].join("\n");

const CEDAR_DOC = [
  "# CedarCloud Hosting proposal",
  "Supplier: CedarCloud Hosting",
  "Price: 21000 USD",
  "Effective: 2026-03-01",
  "Tier: enterprise",
  "Exceptions: EU data residency add-on excluded",
  "Payment terms are net 60 days.",
  "Compute and storage are metered monthly.",
].join("\n");

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function planSteps(entries: readonly (readonly [string, readonly string[]])[]) {
  return { steps: entries.map(([objective, questions]) => ({ id: randomUUID(), objective, questions })) };
}

// -- Workspace ----------------------------------------------------------------

async function bootWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-research-int-"));
  directories.push(directory);
  await initializeStorageRuntime({
    sqlitePath: path.join(directory, "ledger.sqlite"),
    lanceDirectory: path.join(directory, "lancedb"),
    embeddingDimension: 3,
    embeddingModel: EMBED_MODEL,
  });
  for (const [id, email] of [
    [OWNER_ID, "owner@example.test"],
    [OTHER_ID, "other@example.test"],
  ] as const) {
    await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      id,
      email,
      "test-password-hash",
    ]);
  }
  await initializeRuntimeSettings({ settingsFile: path.join(directory, "settings.json"), env: {} });
  return directory;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  await app.register(routes);
  await app.ready();
  return app;
}

async function pointProviderAt(provider: ScriptedOpenAiServer): Promise<void> {
  await runtimeSettingsStore().patch({ llmBaseUrl: provider.origin, chatModel: CHAT_MODEL, embedModel: EMBED_MODEL });
}

/**
 * Real durable ingestion through the same upload-store transition the HTTP
 * upload route performs, the real `IngestionWorker`/`IngestionExecutor`, real
 * FTS5 shadow rows, and real LanceDB vectors. The only seam is the embedding
 * transport (deterministic unit vectors through the session contract).
 */
async function ingestSupplierDoc(directory: string, displayName: string, body: string): Promise<string> {
  const runtime = storageRuntime();
  const ingestion = new SqliteIngestionStore(runtime.ledger);
  const sources = runtime.sources;
  const lifecycle = runtime.vectorLifecycle;
  const data: IngestionDataOperations = {
    registerDataset: async () => ({}),
    extractDataset: async () => ({}),
    extractPreparedDataset: async () => ({}),
    activateDatasetRefresh: async () => ({}),
    deactivateDatasetLocation: async () => undefined,
    cleanupDatasetCache: async () => undefined,
    currentDatasetLocation: async () => null,
  };
  const executor = new IngestionExecutor({
    store: ingestion,
    lifecycle,
    refresh: new ConnectorRefreshStore(runtime.ledger),
    data,
    embeddingDimension: 3,
    createEmbeddingSession: async () => async (texts) =>
      texts.map((text) => (text.includes("onboarding") ? [1, 0, 0] : [0, 1, 0])),
    resolveArtifact: async ({ filePath }) => filePath,
    isTabular: () => false,
    extractDocument,
    chunkTextWithLocators,
    datasetRegistration: () => ({}),
    datasetPreviewSegments: () => ({ text: "preview", segments: [], separator: "" }),
  });
  const worker = new IngestionWorker({
    store: ingestion,
    sources,
    lifecycle,
    refresh: new ConnectorRefreshStore(runtime.ledger),
    ingest: (input) => executor.ingest(input),
  });
  const sourceDirectory = path.join(directory, "uploads", OWNER_ID);
  await fs.mkdir(sourceDirectory, { recursive: true });
  const sourceId = randomUUID();
  const artifact = path.join(sourceDirectory, `${sourceId}.md`);
  await fs.writeFile(artifact, body);
  const sizeBytes = (await fs.stat(artifact)).size;
  await runtime.sourceIngestion.createUploadSource(OWNER_ID, {
    id: sourceId,
    baseName: displayName.replace(/[^a-z0-9]+/gi, "_").toLowerCase(),
    kind: "document",
    displayName,
    filePath: artifact,
    mime: "text/markdown",
    sizeBytes,
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await worker.processOne())) break;
  }
  const ready = await sources.getSource(OWNER_ID, sourceId);
  expect(ready?.readyGeneration).toBe(1);
  expect(ready?.status).toBe("ready");
  return sourceId;
}

function realSearchRunner(): ReturnType<typeof createResearchRunner> {
  const runner = createResearchRunner({
    store: storageRuntime().research,
    searchPorts: () => ({
      // Semantic-query embedding seam only; the KNN, FTS, and joins are real.
      embedQuery: async (texts) => texts.map((text) => (text.includes("onboarding") ? [1, 0, 0] : [0, 1, 0])),
    }),
    cancelPollIntervalMs: 40,
    claimIntervalMs: 120,
  });
  runners.push(runner);
  bindDefaultResearchRunner(runner);
  return runner;
}

async function getRun(app: FastifyInstance, runId: string): Promise<any> {
  const response = await app.inject({ method: "GET", url: `/api/research-runs/${runId}`, headers: ownerAuth });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function waitForRunStatus(app: FastifyInstance, runId: string, statuses: readonly string[], timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(app, runId);
    if (statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} stalled in ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function dossierOf(runId: string) {
  const store = storageRuntime().research;
  const items: Awaited<ReturnType<typeof store.listResearchEvidence>>["items"] = [];
  let after: { timestamp: string; id: string } | null = null;
  for (;;) {
    const page = await store.listResearchEvidence(OWNER_ID, runId, { limit: 50, after });
    items.push(...page.items);
    after = page.next;
    if (!after) break;
  }
  return items;
}

async function tableOf(app: FastifyInstance, runId: string, query = "limit=100") {
  const response = await app.inject({
    method: "GET",
    url: `/api/research-runs/${runId}/table?${query}`,
    headers: ownerAuth,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function cellFor(table: any, columnId: string, rowSourceId: string, origin: "machine" | "correction") {
  const row = table.items.find((item: any) => item.row_source_id === rowSourceId);
  expect(row, `row ${rowSourceId}`).toBeDefined();
  return row.cells.find((cell: any) => cell.column_id === columnId && cell.origin === origin) ?? null;
}

function columnDeclarations() {
  return [
    { id: randomUUID(), label: "Price", question: "What is the annual price?", type: "number", unit: "USD" },
    { id: randomUUID(), label: "Effective", question: "What is the effective date?", type: "date", unit: null },
    { id: randomUUID(), label: "Renewal", question: "Is renewal automatic?", type: "boolean", unit: null },
    {
      id: randomUUID(),
      label: "Tier",
      question: "Which service tier is offered?",
      type: "enum",
      unit: null,
      choices: ["standard", "premium", "enterprise"],
    },
    { id: randomUUID(), label: "Exceptions", question: "Which exceptions apply?", type: "text", unit: null },
  ];
}

function firstUserText(body: Readonly<Record<string, unknown>>): string {
  const messages = (body.messages as { role: string; content: string }[]) ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return messages[index]!.content;
  }
  return "";
}

function setFrameContent(frames: Record<string, unknown>[], content: string): void {
  const first = frames[0] as { choices: { delta: { content?: string } }[] };
  first.choices[0]!.delta.content = content;
}

// -- Suite ---------------------------------------------------------------------

describe("M15 complete research job (real FTS + real LanceDB + scripted provider)", () => {
  it(
    "memo and comparison over the three-supplier corpus: locators, conflict, missing fact, exports, artifact, cross-account",
    { timeout: 240_000 },
    async () => {
      const directory = await bootWorkspace();
      const acme = await ingestSupplierDoc(directory, "acme-proposal.md", ACME_DOC);
      const blue = await ingestSupplierDoc(directory, "blueriver-proposal.md", BLUERIVER_DOC);
      const cedar = await ingestSupplierDoc(directory, "cedarcloud-proposal.md", CEDAR_DOC);
      const runner = realSearchRunner();
      const app = await buildApp();
      void runner;

      // ---- Memo run over real keyword + semantic search -----------------------
      let memoRunId = "";
      const synthFrames = assistantTextChunks(CHAT_MODEL, ["MEMO-SYNTH"]);
      const memoProvider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [
          assistantTextChunks(CHAT_MODEL, ["Captured the onboarding fee statements."]),
          assistantTextChunks(CHAT_MODEL, ["No termination notice period matched."]),
          synthFrames,
        ],
        {
          models: [CHAT_MODEL],
          onCall: async (index) => {
            if (index !== 2) return;
            const items = await dossierOf(memoRunId);
            const e900 = items.find((item) => item.sourceId === acme && item.excerpt.includes("900 USD one time"));
            const e950 = items.find((item) => item.sourceId === blue && item.excerpt.includes("950 USD one time"));
            const ePrice = items.find((item) => item.sourceId === acme && item.excerpt.includes("12000 USD"));
            expect(e900).toBeDefined();
            expect(e950).toBeDefined();
            expect(ePrice).toBeDefined();
            const foreign = randomUUID();
            setFrameContent(
              synthFrames,
              JSON.stringify({
                claims: [
                  {
                    text: "The suppliers state different one-time onboarding fees.",
                    classification: "conflicting",
                    // The trailing foreign id must be dropped, never resolved.
                    evidence_ids: [e900!.id, e950!.id, foreign],
                  },
                  {
                    text: "Acme lists 12000 USD as the annual price.",
                    classification: "supported",
                    evidence_ids: [ePrice!.id, randomUUID()],
                  },
                  {
                    text: "A statement nothing in this corpus captures.",
                    classification: "supported",
                    evidence_ids: [randomUUID()],
                  },
                ],
                gaps: ["The termination notice period is not found in selected evidence."],
              })
            );
          },
        }
      );
      providers.push(memoProvider);
      await pointProviderAt(memoProvider);

      const memoCreated = await app.inject({
        method: "POST",
        url: "/api/research",
        headers: ownerAuth,
        body: {
          title: "Supplier renewal diligence",
          question: "Which renewal terms and onboarding fees do the suppliers state?",
          output_kind: "memo",
          source_ids: [acme, blue, cedar],
          chat_model: CHAT_MODEL,
          plan: planSteps([
            ["Find the shared onboarding fee statements", ["onboarding"]],
            ["Establish the termination notice period", ["termination"]],
          ]),
        },
      });
      expect(memoCreated.statusCode).toBe(201);
      const memoDefinitionId = memoCreated.json().id as string;
      const memoStarted = await app.inject({
        method: "POST",
        url: `/api/research/${memoDefinitionId}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(memoStarted.statusCode).toBe(201);
      memoRunId = memoStarted.json().id as string;

      const memoRun = await waitForRunStatus(app, memoRunId, ["completed", "needs_review", "failed"]);
      expect(memoRun.status).toBe("completed");
      expect(memoRun.error_code).toBeNull();

      // Dossier: real typed locators and real content hashes.
      const memoEvidence = await dossierOf(memoRunId);
      expect(memoEvidence.length).toBeGreaterThan(0);
      for (const item of memoEvidence) {
        expect(item.contentHash).toBe(sha256(item.excerpt));
        expect(item.generation).toBe(1);
        expect(item.label).toBeTruthy();
      }
      const located = memoEvidence.filter(
        (item) => item.locators.length > 0 && item.locators.every((locator) => locator.kind === "text_span")
      );
      expect(located.length).toBe(memoEvidence.length);

      // Claims: conflict requires two differing excerpts; foreign refs dropped.
      const claims = memoRun.claims as any[];
      const conflicting = claims.find((claim) => claim.kind === "claim" && claim.classification === "conflicting");
      expect(conflicting, "conflicting claim persisted").toBeDefined();
      const memoEvidenceById = new Map(memoEvidence.map((item) => [item.id, item]));
      expect(conflicting.evidence_refs.length).toBeGreaterThanOrEqual(2);
      const conflictExcerpts = new Set<string | undefined>(
        (conflicting.evidence_refs as string[]).map((id) => memoEvidenceById.get(id)?.excerpt)
      );
      expect(conflictExcerpts.size).toBe(conflicting.evidence_refs.length);
      expect([...conflicting.evidence_refs].every((id: string) => memoEvidenceById.has(id))).toBe(true);
      expect(
        [...conflictExcerpts].some((excerpt) => excerpt!.includes("900 USD one time")) &&
          [...conflictExcerpts].some((excerpt) => excerpt!.includes("950 USD one time"))
      ).toBe(true);
      const supported = claims.find((claim) => claim.classification === "supported");
      expect(supported).toBeDefined();
      expect(supported.evidence_refs.length).toBe(1);
      const downgraded = claims.find((claim) => claim.text.startsWith("A statement nothing"));
      expect(downgraded).toBeDefined();
      expect(downgraded.classification).toBe("unsupported");
      expect(downgraded.evidence_refs).toEqual([]);
      // Missing fact: the gap ledger records it as not found, not as impossible.
      const gaps = claims.filter((claim) => claim.kind === "gap");
      expect(gaps.some((gap: any) => gap.text.includes("termination notice period"))).toBe(true);
      expect(memoRun.counts.gap_count).toBeGreaterThanOrEqual(1);

      // ---- Memo artifact into the real document store --------------------------
      const memoArtifact = await app.inject({
        method: "POST",
        url: `/api/research-runs/${memoRunId}/artifacts`,
        headers: ownerAuth,
        body: {},
      });
      expect(memoArtifact.statusCode).toBe(201);
      const memoDocId = memoArtifact.json().document_id as string;
      const memoDocRevId = memoArtifact.json().document_revision_id as string;
      const memoRevision = await app.inject({
        method: "GET",
        url: `/api/documents/${memoDocId}/revisions/${memoDocRevId}`,
        headers: ownerAuth,
      });
      expect(memoRevision.statusCode).toBe(200);
      const memoPayload = JSON.stringify(memoRevision.json().payload);
      expect(memoPayload).toContain("Conflicting claims");
      expect(memoPayload).toContain("Gaps and not-found");
      expect(memoPayload).toContain("termination notice period");
      expect(memoPayload).toContain("different one-time onboarding fees");
      // M13 [n] markers address the projected evidence array.
      expect(/\[\d+\]\[?\d*\]?/.test(memoPayload)).toBe(true);

      // ---- Comparison run over the same real corpus ----------------------------
      const columns = columnDeclarations();
      const [colPrice, colEffective, colRenewal, colTier, colExceptions] = columns.map((column) => column.id);
      let compRunId = "";
      // Call order: two step summaries, then one extraction per column in
      // frozen schema order: Price, Effective, Renewal, Tier, Exceptions.
      const compFrames = Array.from({ length: 7 }, () => assistantTextChunks(CHAT_MODEL, ["PLACEHOLDER"]));
      const compProvider = await startScriptedOpenAiServer(CHAT_MODEL, compFrames, {
        models: [CHAT_MODEL],
        onCall: async (index, body) => {
          const frames = compFrames[index]!;
          if (index < 2) {
            setFrameContent(frames, "Step evidence summarized.");
            return;
          }
          const items = await dossierOf(compRunId);
          const bySource = (sourceId: string, token: string) =>
            items.find((item) => item.sourceId === sourceId && item.excerpt.includes(token));
          const userText = firstUserText(body);
          const cell = (
            sourceId: string,
            value: unknown,
            excerptToken: string,
            extra: Record<string, unknown> = {}
          ) => {
            const evidence = bySource(sourceId, excerptToken);
            return {
              source_id: sourceId,
              value,
              ...(evidence ? { evidence_ids: [evidence.id] } : {}),
              explanation: `Extracted for ${sourceId.slice(0, 8)}.`,
              ...extra,
            };
          };
          let cells: Record<string, unknown>[];
          if (userText.includes('Column "Price"')) {
            cells = [
              // Number column, quoted string answer: must store `invalid`
              // VERBATIM, never coerced to a number.
              cell(acme, "12000 dollars", "Price: 12000 USD"),
              cell(blue, 8750, "Price: 8750 USD"),
              cell(cedar, 21000, "Price: 21000 USD"),
            ];
          } else if (userText.includes('Column "Effective"')) {
            cells = [
              cell(acme, "2026-01-15", "Effective: 2026-01-15"),
              cell(blue, "2025-11-01", "Effective: 2025-11-01"),
              cell(cedar, "2026-03-01", "Effective: 2026-03-01"),
            ];
          } else if (userText.includes('Column "Renewal"')) {
            const blueRefs = items.filter(
              (item) =>
                item.sourceId === blue &&
                (item.excerpt.includes("manual written approval") || item.excerpt.includes("automatic renewal"))
            );
            const distinctExcerpts = new Set(blueRefs.map((item) => item.excerpt));
            expect(distinctExcerpts.size).toBeGreaterThanOrEqual(2);
            cells = [
              cell(acme, true, "Renewal: automatic"),
              {
                source_id: blue,
                value: false,
                status: "conflicting",
                evidence_ids: blueRefs.map((item) => item.id),
                explanation: "The proposal body and the renewal addendum disagree.",
              },
              // Cedar states no renewal line at all: honest null.
              { source_id: cedar, value: null, explanation: "The proposal does not state renewal." },
            ];
          } else if (userText.includes('Column "Tier"')) {
            cells = [
              cell(acme, "premium", "Tier: premium"),
              cell(blue, "standard", "Tier: standard"),
              cell(cedar, "enterprise", "Tier: enterprise"),
            ];
          } else {
            cells = [
              cell(acme, "=volume discounts above 500 shipments per quarter", "=volume discounts"),
              // Text column, number answer: invalid verbatim, never coerced.
              cell(blue, 42, "Exceptions: none stated"),
              cell(cedar, "EU data residency add-on excluded", "EU data residency"),
            ];
          }
          setFrameContent(frames, JSON.stringify({ cells }));
        },
      });
      providers.push(compProvider);
      await pointProviderAt(compProvider);

      const compCreated = await app.inject({
        method: "POST",
        url: "/api/research",
        headers: ownerAuth,
        body: {
          title: "Supplier comparison",
          question: "Compare the supplier proposals across price, effective date, renewal, tier, and exceptions.",
          output_kind: "comparison",
          source_ids: [acme, blue, cedar],
          chat_model: CHAT_MODEL,
          columns,
          plan: planSteps([
            ["Establish which suppliers renew and how", ["renewal"]],
            ["Capture the priced terms for every supplier", ["payment"]],
          ]),
        },
      });
      expect(compCreated.statusCode).toBe(201);
      const compDefinitionId = compCreated.json().id as string;
      const compStarted = await app.inject({
        method: "POST",
        url: `/api/research/${compDefinitionId}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(compStarted.statusCode).toBe(201);
      compRunId = compStarted.json().id as string;
      const compRun = await waitForRunStatus(app, compRunId, ["completed", "needs_review", "failed"]);
      expect(compRun.status).toBe("completed");

      // Typed cells: exact values, invalid verbatim, conflict, not_found.
      let compTable = await tableOf(app, compRunId);
      expect(compTable.items).toHaveLength(3);
      expect(cellFor(compTable, colPrice, acme, "machine").value).toBe("12000 dollars");
      expect(cellFor(compTable, colPrice, acme, "machine").status).toBe("invalid");
      expect(cellFor(compTable, colPrice, blue, "machine").value).toBe(8750);
      expect(cellFor(compTable, colPrice, blue, "machine").status).toBe("supported");
      expect(cellFor(compTable, colPrice, cedar, "machine").value).toBe(21000);
      expect(cellFor(compTable, colEffective, blue, "machine").value).toBe("2025-11-01");
      expect(cellFor(compTable, colEffective, cedar, "machine").value).toBe("2026-03-01");
      expect(cellFor(compTable, colTier, acme, "machine").value).toBe("premium");
      const renewalBlue = cellFor(compTable, colRenewal, blue, "machine");
      expect(renewalBlue.status).toBe("conflicting");
      expect(renewalBlue.evidence_refs.length).toBeGreaterThanOrEqual(2);
      const compEvidence = await dossierOf(compRunId);
      const compEvidenceById = new Map(compEvidence.map((item) => [item.id, item]));
      const renewalExcerpts = new Set(renewalBlue.evidence_refs.map((id: string) => compEvidenceById.get(id)?.excerpt));
      expect(renewalExcerpts.size).toBe(renewalBlue.evidence_refs.length);
      const renewalCedar = cellFor(compTable, colRenewal, cedar, "machine");
      expect(renewalCedar.status).toBe("not_found");
      expect(renewalCedar.value).toBeNull();
      const exceptionsBlue = cellFor(compTable, colExceptions, blue, "machine");
      expect(exceptionsBlue.status).toBe("invalid");
      expect(exceptionsBlue.value).toBe(42);
      expect(compRun.counts.machine_cell_count).toBe(15);

      // ---- Correction overlay (revision CAS) -----------------------------------
      const correction = await app.inject({
        method: "PATCH",
        url: `/api/research-runs/${compRunId}/review`,
        headers: ownerAuth,
        body: {
          expected_revision: 1,
          ops: [
            {
              op: "correct_cell",
              column_id: colPrice,
              row_source_id: acme,
              value: 12000,
              status: "supported",
              explanation: "Verified against the signed order form.",
            },
          ],
        },
      });
      expect(correction.statusCode).toBe(200);
      expect(correction.json().review_revision).toBe(2);
      const staleCorrection = await app.inject({
        method: "PATCH",
        url: `/api/research-runs/${compRunId}/review`,
        headers: ownerAuth,
        body: { expected_revision: 1, ops: [{ op: "add_note", target_kind: "run", note: "stale" }] },
      });
      expect(staleCorrection.statusCode).toBe(409);
      expect(staleCorrection.json().code).toBe("RESEARCH_REVISION_CONFLICT");

      compTable = await tableOf(app, compRunId);
      const acmeCorrection = cellFor(compTable, colPrice, acme, "correction");
      expect(acmeCorrection.value).toBe(12000);
      expect(acmeCorrection.status).toBe("supported");
      expect(acmeCorrection.corrected_at).toBeTruthy();
      // The machine original survives the overlay verbatim.
      expect(cellFor(compTable, colPrice, acme, "machine").value).toBe("12000 dollars");

      // ---- Exports, byte-checked ------------------------------------------------
      const csv = await app.inject({
        method: "GET",
        url: `/api/research-runs/${compRunId}/export?format=csv`,
        headers: ownerAuth,
      });
      expect(csv.statusCode).toBe(200);
      expect(csv.body.startsWith("﻿")).toBe(true);
      expect(csv.body).toContain("# limit_state:");
      // Formula guard: the leading `=` exception text is apostrophe-prefixed.
      expect(csv.body).toContain("'=volume discounts above 500 shipments per quarter");
      // Invalid machine values export verbatim with the `invalid` label.
      expect(csv.body).toContain("12000 dollars,invalid,");
      expect(csv.body).toContain(",correction,12000,supported,");
      expect(csv.body).toContain("Verified against the signed order form.");
      const manifest = await app.inject({
        method: "GET",
        url: `/api/research-runs/${compRunId}/export?format=manifest`,
        headers: ownerAuth,
      });
      expect(manifest.statusCode).toBe(200);
      const manifestJson = manifest.json();
      expect(manifestJson.artifact).toBe("research_run_export_manifest");
      expect(manifestJson.run.budgets).toEqual({
        steps: 8,
        searches: 32,
        model_requests: 40,
        evidence: 100,
        evidence_chars: 200000,
        wall_ms: 900000,
      });
      expect(manifestJson.evidence.length).toBe(compEvidence.length);
      for (const entry of manifestJson.evidence as any[]) {
        const stored = compEvidenceById.get(entry.id);
        expect(stored).toBeDefined();
        expect(entry.locators).toEqual(stored!.locators);
        expect(entry.content_hash).toBe(stored!.contentHash);
      }
      const manifestCorrection = (manifestJson.cells as any[]).find(
        (entry) => entry.origin === "correction" && entry.row_source_id === acme && entry.column_id === colPrice
      );
      expect(manifestCorrection).toBeDefined();
      expect(manifestCorrection.corrected_at).toBeTruthy();
      expect(manifestCorrection.corrected_from_run_id).toBeNull();

      // ---- Cross-account refusals ----------------------------------------------
      for (const [method, url] of [
        ["GET", `/api/research/${compDefinitionId}`],
        ["GET", `/api/research-runs/${compRunId}`],
        ["GET", `/api/research-runs/${compRunId}/evidence`],
        ["GET", `/api/research-runs/${compRunId}/table`],
        ["GET", `/api/research-runs/${compRunId}/export?format=csv`],
        ["POST", `/api/research-runs/${compRunId}/artifacts`],
        ["PATCH", `/api/research-runs/${compRunId}/review`],
      ] as const) {
        const refused = await app.inject({ method, url, headers: otherAuth, body: method === "POST" ? {} : undefined });
        expect([404, 400], `${method} ${url} refuses foreign account`).contains(refused.statusCode);
      }
      const otherCatalog = await app.inject({ method: "GET", url: "/api/research", headers: otherAuth });
      expect(otherCatalog.json().items).toEqual([]);

      // ---- Comparison artifact with disclosures and projection labels ----------
      const compArtifact = await app.inject({
        method: "POST",
        url: `/api/research-runs/${compRunId}/artifacts`,
        headers: ownerAuth,
        body: {},
      });
      expect(compArtifact.statusCode).toBe(201);
      const compArtifactRevision = await app.inject({
        method: "GET",
        url: `/api/documents/${compArtifact.json().document_id}/revisions/${compArtifact.json().document_revision_id}`,
        headers: ownerAuth,
      });
      const compPayload = JSON.stringify(compArtifactRevision.json().payload);
      expect(compPayload).toContain("(corrected)");
      expect(compPayload).toContain("(invalid machine output)");
      expect(compPayload).toContain("not found");
      expect(compPayload).toContain("conflicting: 1; invalid machine outputs: 1; not found: 1; user corrections: 1");
      expect(compArtifact.json().projection.disclosures).toMatchObject({
        conflicting_cells: 1,
        invalid_cells: 1,
        not_found_cells: 1,
        correction_cells: 1,
      });

      // ---- Scoped rerun: overrides carry, against-diff is honest ----------------
      let rerunId = "";
      const rerunFrames = assistantTextChunks(CHAT_MODEL, ["RERUN-PRICE"]);
      const rerunProvider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [assistantTextChunks(CHAT_MODEL, ["step one"]), assistantTextChunks(CHAT_MODEL, ["step two"]), rerunFrames],
        {
          models: [CHAT_MODEL],
          onCall: async (index, body) => {
            if (index !== 2 || !firstUserText(body).includes('Column "Price"')) return;
            const items = await dossierOf(rerunId);
            const evidence = items.find((item) => item.sourceId === blue && item.excerpt.includes("8750"));
            setFrameContent(
              rerunFrames,
              JSON.stringify({
                cells: [
                  {
                    source_id: blue,
                    value: 9000,
                    ...(evidence ? { evidence_ids: [evidence.id] } : {}),
                    explanation: "Refreshed quote supersedes the prior rate.",
                  },
                ],
              })
            );
          },
        }
      );
      providers.push(rerunProvider);
      await pointProviderAt(rerunProvider);
      const rerunStarted = await app.inject({
        method: "POST",
        url: `/api/research/${compDefinitionId}/runs`,
        headers: ownerAuth,
        body: {
          rerun_of: compRunId,
          rerun_selection: { row_source_ids: [blue], column_ids: [colPrice] },
        },
      });
      expect(rerunStarted.statusCode).toBe(201);
      rerunId = rerunStarted.json().id as string;
      expect(rerunStarted.json().rerun_of).toBe(compRunId);
      const rerun = await waitForRunStatus(app, rerunId, ["completed", "needs_review", "failed"]);
      expect(rerun.status).toBe("completed");

      const rerunTable = await tableOf(app, rerunId);
      // Rows are the run's pinned sources; un-rerun slots stay honestly blank.
      expect(rerunTable.items).toHaveLength(3);
      expect(cellFor(rerunTable, colPrice, blue, "machine").value).toBe(9000);
      const carried = cellFor(rerunTable, colPrice, acme, "correction");
      expect(carried.value).toBe(12000);
      expect(carried.corrected_from_run_id).toBe(compRunId);
      expect(cellFor(rerunTable, colTier, cedar, "machine")).toBeNull();

      const diffTable = await tableOf(app, rerunId, `limit=100&against=${compRunId}`);
      expect(diffTable.comparison.from_run_id).toBe(compRunId);
      expect(diffTable.comparison.to_run_id).toBe(rerunId);
      expect(diffTable.comparison.rows_removed).toEqual([]);
      expect(
        diffTable.comparison.carried_overrides.some(
          (entry: any) =>
            entry.column_id === colPrice && entry.row_source_id === acme && entry.corrected_from_run_id === compRunId
        )
      ).toBe(true);
      const changedPriceBlue = diffTable.comparison.changed_cells.find(
        (entry: any) => entry.row_source_id === blue && entry.column_id === colPrice
      );
      expect(changedPriceBlue).toBeDefined();
      expect(changedPriceBlue.machine_changed).toBe(true);
      expect(changedPriceBlue.before.machine.value).toBe(8750);
      expect(changedPriceBlue.after.machine.value).toBe(9000);

      // ---- Cancel mid-step: active-run rule, durable cancel, state refusal -----
      const hang = deferred();
      const hangProvider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [assistantTextChunks(CHAT_MODEL, ["NEVER-ANSWERED"])],
        {
          models: [CHAT_MODEL],
          onCall: async (index) => {
            if (index === 0) await hang.promise;
          },
        }
      );
      providers.push(hangProvider);
      await pointProviderAt(hangProvider);
      const cancelCreated = await app.inject({
        method: "POST",
        url: "/api/research",
        headers: ownerAuth,
        body: {
          title: "Cancelled diligence",
          question: "Which supplier has the lowest price?",
          output_kind: "memo",
          source_ids: [acme],
          chat_model: CHAT_MODEL,
          plan: planSteps([["Establish the price statements", ["price"]]]),
        },
      });
      expect(cancelCreated.statusCode).toBe(201);
      const cancelStarted = await app.inject({
        method: "POST",
        url: `/api/research/${cancelCreated.json().id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(cancelStarted.statusCode).toBe(201);
      const cancelRunId = cancelStarted.json().id as string;
      const store = storageRuntime().research;
      for (;;) {
        const steps = await store.listResearchSteps(OWNER_ID, cancelRunId);
        if (steps.some((step) => step.status === "running")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const activeRefusal = await app.inject({
        method: "POST",
        url: `/api/research/${cancelCreated.json().id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(activeRefusal.statusCode).toBe(409);
      expect(activeRefusal.json().code).toBe("RESEARCH_ACTIVE_RUN");
      expect(activeRefusal.json().existing_run_id).toBe(cancelRunId);

      const cancelFirst = await app.inject({
        method: "DELETE",
        url: `/api/research-runs/${cancelRunId}`,
        headers: ownerAuth,
      });
      expect(cancelFirst.statusCode).toBe(200);
      const cancelledRun = await waitForRunStatus(app, cancelRunId, ["cancelled", "needs_review"]);
      expect(cancelledRun.status).toBe("cancelled");
      expect(cancelledRun.claims).toEqual([]);
      const cancelRepeat = await app.inject({
        method: "DELETE",
        url: `/api/research-runs/${cancelRunId}`,
        headers: ownerAuth,
      });
      expect(cancelRepeat.statusCode).toBe(200);
      expect(cancelRepeat.json()).toEqual({ ok: true, status: "cancelled" });
      const artifactRefusal = await app.inject({
        method: "POST",
        url: `/api/research-runs/${cancelRunId}/artifacts`,
        headers: ownerAuth,
        body: {},
      });
      expect(artifactRefusal.statusCode).toBe(409);
      expect(artifactRefusal.json().code).toBe("RESEARCH_RUN_STATE");
      hang.resolve();
    }
  );

  it(
    "restart mid-run: bounded at-most-once resume, deduped evidence, honest needs_review",
    { timeout: 240_000 },
    async () => {
      const directory = await bootWorkspace();
      const acme = await ingestSupplierDoc(directory, "acme-proposal.md", ACME_DOC);
      const blue = await ingestSupplierDoc(directory, "blueriver-proposal.md", BLUERIVER_DOC);
      const app = await buildApp();
      const store = storageRuntime().research;

      async function startRun(): Promise<string> {
        const created = await app.inject({
          method: "POST",
          url: "/api/research",
          headers: ownerAuth,
          body: {
            title: "Restart diligence",
            question: "Which terms do the suppliers state?",
            output_kind: "memo",
            source_ids: [acme, blue],
            chat_model: CHAT_MODEL,
            plan: planSteps([
              ["Establish the price statements", ["price"]],
              ["Establish the payment statements", ["payment"]],
            ]),
          },
        });
        expect(created.statusCode).toBe(201);
        const started = await app.inject({
          method: "POST",
          url: `/api/research/${created.json().id}/runs`,
          headers: ownerAuth,
          body: {},
        });
        expect(started.statusCode).toBe(201);
        return started.json().id as string;
      }

      // First executor: step one answers, step two's summary hangs.
      const firstHang = deferred();
      const provider1 = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [assistantTextChunks(CHAT_MODEL, ["step one done."]), assistantTextChunks(CHAT_MODEL, ["NEVER"])],
        {
          models: [CHAT_MODEL],
          onCall: async (index) => {
            if (index === 1) await firstHang.promise;
          },
        }
      );
      providers.push(provider1);
      await pointProviderAt(provider1);
      const runner1 = realSearchRunner();
      const runId = await startRun();
      for (;;) {
        const steps = await store.listResearchSteps(OWNER_ID, runId);
        const stepTwo = steps.find((step) => step.ordinal === 1);
        if (stepTwo?.status === "running" && provider1.calls.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runner1.stop();
      const interruptedRun = await store.getResearchRun(OWNER_ID, runId);
      expect(interruptedRun?.status).toBe("running"); // durable, not silently settled
      const interruptedSteps = await store.listResearchSteps(OWNER_ID, runId);
      expect(interruptedSteps.find((step) => step.ordinal === 0)?.status).toBe("done");
      const interruptedStep = interruptedSteps.find((step) => step.ordinal === 1)!;
      expect(interruptedStep.status).toBe("running");
      expect(interruptedStep.attempts).toBe(1);
      const evidenceAfterCrash = await dossierOf(runId);
      expect(evidenceAfterCrash.length).toBeGreaterThan(0);

      // Startup recovery: one bounded retry under the same step identity.
      const recovery = await store.recoverInterruptedResearchRuns();
      expect(recovery).toMatchObject({ resumedRuns: 1, cancelledRuns: 0, retriedSteps: 1, exhaustedSteps: 0 });

      // Second executor: retries step two and is interrupted mid-summary again.
      const secondHang = deferred();
      const provider2 = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [assistantTextChunks(CHAT_MODEL, ["NEVER-AGAIN"])],
        {
          models: [CHAT_MODEL],
          onCall: async (index) => {
            if (index === 0) await secondHang.promise;
          },
        }
      );
      providers.push(provider2);
      await pointProviderAt(provider2);
      const runner2 = realSearchRunner();
      runner2.start();
      for (;;) {
        const steps = await store.listResearchSteps(OWNER_ID, runId);
        const stepTwo = steps.find((step) => step.ordinal === 1);
        if (stepTwo?.status === "running" && stepTwo.attempts === 2 && provider2.calls.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runner2.stop();
      // The re-run of step two recaptured the same chunks: no duplicate rows.
      const evidenceAfterRetry = await dossierOf(runId);
      expect(evidenceAfterRetry.length).toBe(evidenceAfterCrash.length);
      const tuples = new Set(
        evidenceAfterRetry.map((item) => `${item.sourceId}|${item.generation}|${item.chunkId}|${item.contentHash}`)
      );
      expect(tuples.size).toBe(evidenceAfterRetry.length);

      // The single restart retry is spent: recovery fails the step honestly.
      const secondRecovery = await store.recoverInterruptedResearchRuns();
      expect(secondRecovery).toMatchObject({ retriedSteps: 0, exhaustedSteps: 1 });
      const exhaustedStep = (await store.listResearchSteps(OWNER_ID, runId)).find((step) => step.ordinal === 1)!;
      expect(exhaustedStep.status).toBe("failed");
      expect(exhaustedStep.attempts).toBe(2);
      expect(exhaustedStep.outcome).toContain("interrupted");

      // Third executor: synthesis only; the run must never claim completion.
      const synthFrames = assistantTextChunks(CHAT_MODEL, ["MEMO"]);
      const provider3 = await startScriptedOpenAiServer(CHAT_MODEL, [synthFrames], {
        models: [CHAT_MODEL],
        onCall: async (index) => {
          if (index !== 0) return;
          const items = await dossierOf(runId);
          setFrameContent(
            synthFrames,
            JSON.stringify({
              claims: [{ text: "Acme lists 12000 USD.", classification: "supported", evidence_ids: [items[0]!.id] }],
              gaps: ["Step two never finished after the bounded retry."],
            })
          );
        },
      });
      providers.push(provider3);
      await pointProviderAt(provider3);
      const runner3 = realSearchRunner();
      runner3.start();
      const finalRun = await waitForRunStatus(app, runId, ["needs_review", "completed", "failed", "cancelled"]);
      expect(finalRun.status).toBe("needs_review");
      expect(finalRun.error_code).toBeTruthy();
      const finalSteps = await store.listResearchSteps(OWNER_ID, runId);
      expect(finalSteps.find((step) => step.ordinal === 1)?.attempts).toBe(2);
      expect((finalRun.claims as any[]).some((claim) => claim.text === "Acme lists 12000 USD.")).toBe(true);
      firstHang.resolve();
      secondHang.resolve();
    }
  );

  it(
    "search-budget exhaustion ends needs_review with explicit gaps and preserved partial work",
    { timeout: 240_000 },
    async () => {
      const directory = await bootWorkspace();
      const acme = await ingestSupplierDoc(directory, "acme-proposal.md", ACME_DOC);
      const blue = await ingestSupplierDoc(directory, "blueriver-proposal.md", BLUERIVER_DOC);
      const app = await buildApp();
      let runId = "";

      // Six step summaries (steps 0-5), then the synthesis call is the seventh.
      const synthFrames = assistantTextChunks(CHAT_MODEL, ["BUDGET-SYNTH"]);
      const provider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [...Array.from({ length: 6 }, () => assistantTextChunks(CHAT_MODEL, ["step summary"])), synthFrames],
        {
          models: [CHAT_MODEL],
          onCall: async (index) => {
            if (index !== 6) return;
            const items = await dossierOf(runId);
            const priced = items.find((item) => item.excerpt.includes("12000 USD"));
            setFrameContent(
              synthFrames,
              JSON.stringify({
                claims: priced
                  ? [{ text: "Acme lists 12000 USD.", classification: "supported", evidence_ids: [priced.id] }]
                  : [],
                gaps: [],
              })
            );
          },
        }
      );
      providers.push(provider);
      await pointProviderAt(provider);
      const runner = realSearchRunner();

      // 8 steps × 4 keyword questions + one semantic pass each: the mandatory
      // keyword search of step seven is the 33rd search operation — one past
      // the durable 32-search budget.
      const tokens = ["price", "payment", "renewal", "tier", "exceptions"] as const;
      const plan = {
        steps: Array.from({ length: 8 }, (_unused, index) => ({
          id: randomUUID(),
          objective: `Sweep the supplier terms (${index + 1})`,
          questions: [0, 1, 2, 3].map((offset) => tokens[(index + offset) % tokens.length]!),
        })),
      };
      const created = await app.inject({
        method: "POST",
        url: "/api/research",
        headers: ownerAuth,
        body: {
          title: "Budget sweep",
          question: "Sweep every term in the supplier corpus.",
          output_kind: "memo",
          source_ids: [acme, blue],
          chat_model: CHAT_MODEL,
          plan,
        },
      });
      expect(created.statusCode).toBe(201);
      const started = await app.inject({
        method: "POST",
        url: `/api/research/${created.json().id}/runs`,
        headers: ownerAuth,
        body: {},
      });
      expect(started.statusCode).toBe(201);
      runId = started.json().id as string;
      expect(started.json().budgets.searches).toBe(32);

      const run = await waitForRunStatus(app, runId, ["needs_review", "completed", "failed"]);
      expect(run.status).toBe("needs_review");
      expect(run.error_code).toBe("RESEARCH_BUDGET_EXHAUSTED");
      expect(run.usage.searches).toBe(32);
      const gaps = (run.claims as any[]).filter((claim) => claim.kind === "gap");
      expect(gaps.some((gap: any) => gap.text.startsWith("search budget exhausted"))).toBe(true);
      // Partial work is preserved and reviewable, never a fake completion.
      const evidence = await dossierOf(runId);
      expect(evidence.length).toBeGreaterThan(0);
      expect(run.counts.evidence_count).toBe(evidence.length);
      expect((run.claims as any[]).some((claim) => claim.text === "Acme lists 12000 USD.")).toBe(true);
      const steps = await storageRuntime().research.listResearchSteps(OWNER_ID, runId);
      expect(steps.filter((step) => step.status === "done").length).toBe(6);
      expect(steps.find((step) => step.ordinal === 6)?.status).toBe("skipped");
      expect(steps.find((step) => step.ordinal === 7)?.status).toBe("pending");
      void runner;
    }
  );
});
