/**
 * Durable research evidence + typed comparison (M15 stage 2, real stores).
 *
 * Where researchRunner.test.ts scripts the search boundary, this suite drives
 * the runner through the REAL M14 keyword search (SQLite FTS5 shadow) and the
 * REAL scoped LanceDB KNN over the storage runtime (the embedding transport is
 * the only seam), exactly like `sourceSearch.integration.test.ts`. It proves
 * the evidence-layer contracts only the real path can show: captured excerpts
 * are the actual pinned-generation chunk text, the content hash is the sha256
 * of the stored excerpt, typed locators survive, and evidence dedupes across
 * questions by (run, source, generation, chunk, hash).
 *
 * The typed comparison suite then drives per-column cell extraction through the
 * real ledger with a deterministic scripted provider transcript, proving values
 * are never coerced, enum/date/number typing is exact, an absent value is
 * `not_found`, a validated multi-excerpt conflict is `conflicting`, and cell
 * evidence references are capped at five.
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
import { SourceStore } from "../db/stores/sourceStore.js";
import { createResearchRunner, bindDefaultResearchRunner } from "../researchRunner.js";
import { routes } from "../routes.js";
import { IngestionExecutor, IngestionWorker, type IngestionDataOperations } from "../ingestionEngine.js";
import { extractDocument } from "../ingestSupport.js";
import { chunkTextWithLocators } from "../sourceLocations.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import type { SourceSearchResult } from "../sourceSearch.js";
import { assistantTextChunks, startScriptedOpenAiServer, type ScriptedOpenAiServer } from "./scriptedOpenAiServer.js";

const OWNER_ID = "66666666-6666-4666-8666-666666666666";
const CHAT_MODEL = "evidence-chat-model";
const EMBED_MODEL = "evidence-embed-model";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER_ID, email: "owner@example.test" })}` };

const apps: FastifyInstance[] = [];
const providers: ScriptedOpenAiServer[] = [];
const directories: string[] = [];
const runners: Array<ReturnType<typeof createResearchRunner>> = [];
const releaseHolds: Array<() => void> = [];

let runId: string | undefined;

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

async function bootWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-research-evidence-"));
  directories.push(directory);
  await initializeStorageRuntime({
    sqlitePath: path.join(directory, "ledger.sqlite"),
    lanceDirectory: path.join(directory, "lancedb"),
    embeddingDimension: 3,
    embeddingModel: EMBED_MODEL,
  });
  await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    OWNER_ID,
    "owner@example.test",
    "test-password-hash",
  ]);
  await initializeRuntimeSettings({ settingsFile: path.join(directory, "settings.json"), env: {} });
  return directory;
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

async function getRun(app: FastifyInstance, id: string): Promise<any> {
  const response = await app.inject({ method: "GET", url: `/api/research-runs/${id}`, headers: ownerAuth });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function waitForRunStatus(app: FastifyInstance, id: string, statuses: readonly string[], timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(app, id);
    if (statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${id} stalled in ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Real ingestion of a supplier markdown doc through the durable worker. */
async function ingestDocument(directory: string, displayName: string, body: string): Promise<string> {
  const runtime = storageRuntime();
  const ingestion = new SqliteIngestionStore(runtime.ledger);
  const sources = new SourceStore(runtime.ledger);
  const refresh = new ConnectorRefreshStore(runtime.ledger);
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
    refresh,
    data,
    embeddingDimension: 3,
    // Deterministic unit vectors keyed by the source token; same contract as
    // production, no transport.
    createEmbeddingSession: async () => async (texts) =>
      texts.map((text) => (text.includes(displayName) ? [1, 0, 0] : [0, 1, 0])),
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
    refresh,
    ingest: (input) => executor.ingest(input),
  });
  const sourceDirectory = path.join(directory, "uploads", OWNER_ID);
  await fs.mkdir(sourceDirectory, { recursive: true });
  const sourceId = randomUUID();
  const artifact = path.join(sourceDirectory, `${sourceId}.md`);
  await fs.writeFile(artifact, body);
  await sources.createSource(OWNER_ID, {
    id: sourceId,
    name: displayName.replace(/[^a-z0-9]+/gi, "_").toLowerCase(),
    kind: "document",
    displayName,
    filePath: artifact,
    mime: "text/markdown",
    status: "index",
  });
  await ingestion.reserveJob(OWNER_ID, sourceId);
  await worker.processOne();
  const ready = await sources.getSource(OWNER_ID, sourceId);
  expect(ready?.readyGeneration).toBe(1);
  return sourceId;
}

/**
 * Semantic KNN seam only: the keyword FTS search, the scoped LanceDB KNN, and
 * the SQLite text join all run for real against the storage runtime.
 */
function realSearchRunner(): ReturnType<typeof createResearchRunner> {
  const runner = createResearchRunner({
    store: storageRuntime().research,
    searchPorts: () => ({ embedQuery: async () => [[1, 0, 0]] }),
    cancelPollIntervalMs: 40,
    claimIntervalMs: 150,
  });
  runners.push(runner);
  bindDefaultResearchRunner(runner);
  return runner;
}

function steps(...objectives: [string, string[]][]) {
  return { steps: objectives.map(([objective, questions]) => ({ id: randomUUID(), objective, questions })) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("research evidence — real stores", () => {
  it(
    "captures real pinned-generation text with typed locators and cites only this run's dossier",
    { timeout: 90_000 },
    async () => {
      const directory = await bootWorkspace();
      const sourceA = await ingestDocument(
        directory,
        "alpha-cloud.md",
        "# Alpha proposal\n\nAlpha Cloud renews annually at a four percent uplift with net-30 payment terms."
      );
      const sourceB = await ingestDocument(
        directory,
        "beta-data.md",
        "# Beta proposal\n\nBeta Data renews annually at seven percent."
      );

      let dossierIds: string[] = [];
      let evidenceAtSynthesis = -1;
      const synthFrames = assistantTextChunks(CHAT_MODEL, ["SYNTH"]);
      const provider = await startScriptedOpenAiServer(
        CHAT_MODEL,
        [assistantTextChunks(CHAT_MODEL, ["Alpha renews at four percent net-30."]), synthFrames],
        {
          onCall: async (index) => {
            if (index === 1) {
              const page = await storageRuntime().research.listResearchEvidence(OWNER_ID, runId!, {
                limit: 50,
                after: null,
              });
              evidenceAtSynthesis = page.items.length;
              dossierIds = page.items.map((item) => item.id);
              (synthFrames[0] as any).choices[0].delta.content = JSON.stringify({
                claims: [
                  {
                    text: "Alpha renews at four percent.",
                    classification: "supported",
                    evidence_ids: [dossierIds[0]],
                  },
                ],
                gaps: ["No security addendum was captured."],
              });
            }
          },
        }
      );
      providers.push(provider);
      await pointProviderAt(provider);
      const runner = realSearchRunner();
      const app = await buildApp();

      const created = await app.inject({
        method: "POST",
        url: "/api/research",
        headers: ownerAuth,
        body: {
          title: "Supplier memo",
          question: "Which supplier renews cheaper?",
          output_kind: "memo",
          source_ids: [sourceA, sourceB],
          chat_model: CHAT_MODEL,
          plan: steps(["Establish alpha terms", ["alpha cloud renewal uplift"]]),
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
      runId = started.json().id;

      const run = await waitForRunStatus(app, runId!, ["completed", "needs_review", "failed"]);
      expect(run.status).toBe("completed");
      expect(evidenceAtSynthesis).toBeGreaterThan(0);

      const evidence = await storageRuntime().research.listResearchEvidence(OWNER_ID, runId!, {
        limit: 50,
        after: null,
      });
      const alphaHit = evidence.items.find((item) => item.sourceId === sourceA);
      expect(alphaHit).toBeDefined();
      expect(alphaHit!.excerpt).toContain("four percent");
      expect(alphaHit!.label).toBe("alpha-cloud.md");
      expect(alphaHit!.contentHash).toBe(sha256(alphaHit!.excerpt));
      expect(alphaHit!.generation).toBe(1);
      expect(alphaHit!.locators.length).toBeGreaterThan(0);

      const claims = (run.claims as any[]).filter((claim) => claim.kind === "claim");
      expect(claims).toHaveLength(1);
      expect(claims[0].evidence_refs.every((ref: string) => dossierIds.includes(ref))).toBe(true);
      void runner;
    }
  );

  it("dedupes the same chunk across questions by (run,source,generation,chunk,hash)", { timeout: 90_000 }, async () => {
    const directory = await bootWorkspace();
    // One chunk answers BOTH planned questions with identical stored text.
    const source = await ingestDocument(
      directory,
      "shared.md",
      "# Shared\n\nSHAREDDOC renewal terms are net-45 with a five percent annual cap."
    );
    const provider = await startScriptedOpenAiServer(CHAT_MODEL, [
      assistantTextChunks(CHAT_MODEL, ["One summary for the shared chunk."]),
      assistantTextChunks(CHAT_MODEL, [JSON.stringify({ claims: [], gaps: ["g"] })]),
    ]);
    providers.push(provider);
    await pointProviderAt(provider);
    const runner = realSearchRunner();
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/research",
      headers: ownerAuth,
      body: {
        title: "Shared chunk",
        question: "What are the terms?",
        output_kind: "memo",
        source_ids: [source],
        chat_model: CHAT_MODEL,
        plan: steps(["Terms", ["SHAREDDOC net-45", "SHAREDDOC five percent cap"]]),
      },
    });
    const started = await app.inject({
      method: "POST",
      url: `/api/research/${created.json().id}/runs`,
      headers: ownerAuth,
      body: {},
    });
    runId = started.json().id;
    const run = await waitForRunStatus(app, runId!, ["completed", "needs_review", "failed"]);
    expect(run.status).toBe("completed");
    const evidence = await storageRuntime().research.listResearchEvidence(OWNER_ID, runId!, { limit: 50, after: null });
    const shared = evidence.items.filter((item) => item.sourceId === source);
    // Two questions matched the same chunk with the same excerpt → one row.
    expect(shared.length).toBe(new Set(shared.map((item) => item.contentHash)).size);
    expect(shared.length).toBeGreaterThan(0);
    void runner;
  });
});

describe("research comparison — typed extraction", () => {
  interface AuthoredCell {
    value?: unknown;
    status?: string;
    refs?: "all" | "first2" | "none";
    explanation?: string;
  }
  interface ColumnSpec {
    label: string;
    type: "text" | "number" | "date" | "boolean" | "enum";
    question: string;
    choices?: string[];
    // Cells keyed by row slot 0/1; absent slot → not_found.
    cells: [AuthoredCell | null, AuthoredCell | null];
  }

  // Deterministic search: row 0 yields 6 distinct chunks (to prove the 5-ref
  // cap), row 1 yields 1 chunk.
  const ROW0_CHUNKS = 6;
  function comparisonSearch(rowIds: [string, string]) {
    const cache = new Map<string, readonly SourceSearchResult["hits"][number][]>();
    const build = (scope: readonly { sourceId: string; generation: number }[]) => {
      const hits: SourceSearchResult["hits"][number][] = [];
      for (const s of scope) {
        const count = s.sourceId === rowIds[0] ? ROW0_CHUNKS : 1;
        for (let i = 0; i < count; i += 1) {
          hits.push(
            Object.freeze({
              source_id: s.sourceId,
              generation: s.generation,
              chunk_id: randomUUID(),
              label: "row.md",
              excerpt: `${s.sourceId.slice(0, 4)} evidence ${i}`,
              score: 1,
              rank: i + 1,
              locators: Object.freeze([]),
            })
          );
        }
      }
      return Object.freeze(hits);
    };
    const search = async (input: {
      scopes: readonly { sourceId: string; generation: number }[];
      mode: string;
    }): Promise<SourceSearchResult> => {
      const scope = input.scopes.map((s) => ({
        source_id: s.sourceId,
        generation: s.generation,
        status: "ready" as const,
      }));
      if (input.mode === "semantic") {
        return Object.freeze({
          mode: "semantic",
          query_truncated: false,
          scope: Object.freeze(scope),
          hits: Object.freeze([]),
          returned_char_count: 0,
          truncated: false,
        });
      }
      let hits = cache.get("hits");
      if (!hits) {
        hits = build(input.scopes);
        cache.set("hits", hits);
      }
      return Object.freeze({
        mode: "keyword",
        query_truncated: false,
        scope: Object.freeze(scope),
        hits,
        returned_char_count: 0,
        truncated: false,
      });
    };
    return search as never;
  }

  it(
    "writes typed cells: never coerces, exact enum/date/number, not_found, conflicting, and the 5-ref cap",
    { timeout: 60_000 },
    async () => {
      await bootWorkspace();
      const rowOne = randomUUID();
      const rowTwo = randomUUID();
      for (const [slot, id] of [rowOne, rowTwo].entries()) {
        await storageRuntime().ledger.run(
          `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,size_bytes,status,ready_generation)
         VALUES (?,?,?,'document','row.md',?,10,'ready',1)`,
          [id, OWNER_ID, `row_${slot}`, `/w/${id}.md`]
        );
      }
      const columns: ColumnSpec[] = [
        { label: "Price", type: "number", question: "Annual price?", cells: [{ value: 1200 }, { value: "1200" }] },
        {
          label: "Date",
          type: "date",
          question: "Effective?",
          cells: [{ value: "2026-02-30" }, { value: "2026-03-01" }],
        },
        {
          label: "Tier",
          type: "enum",
          question: "Tier?",
          choices: ["Pro", "Enterprise"],
          cells: [{ value: "pro" }, { value: "Enterprise" }],
        },
        { label: "Renewal", type: "boolean", question: "Auto-renews?", cells: [{ value: true }, null] },
        {
          label: "Conflict",
          type: "number",
          question: "Any conflict?",
          cells: [{ value: 5, status: "conflicting", refs: "first2" }, { value: 7 }],
        },
        { label: "Notes", type: "text", question: "Notes?", cells: [{ value: "memo", refs: "all" }, { value: null }] },
      ];
      const columnDecls = columns.map((column) => ({
        id: randomUUID(),
        label: column.label,
        question: column.question,
        type: column.type,
        ...(column.choices ? { choices: column.choices } : {}),
      }));

      // Dossier ids per row, resolved from the real store at the first
      // extraction call.
      const dossierByRow: string[][] = [[], []];
      let dossierLoaded = false;

      const responses: (readonly Record<string, unknown>[])[] = [assistantTextChunks(CHAT_MODEL, ["row summary."])];
      for (const _column of columns) responses.push(assistantTextChunks(CHAT_MODEL, ["PLACEHOLDER"]));

      const onCall = async (index: number) => {
        if (index === 0) return; // step summary (evidence already durable)
        const column = columns[index - 1];
        const frame = responses[index][0] as any;
        if (!dossierLoaded) {
          const page = await storageRuntime().research.listResearchEvidence(OWNER_ID, runId!, {
            limit: 50,
            after: null,
          });
          for (const item of page.items) {
            if (item.sourceId === rowOne) dossierByRow[0].push(item.id);
            else if (item.sourceId === rowTwo) dossierByRow[1].push(item.id);
          }
          dossierLoaded = true;
        }
        const cells: Record<string, unknown>[] = [];
        ([rowOne, rowTwo] as const).forEach((rowId, slot) => {
          const authored = column.cells[slot];
          if (authored === null) return; // absent → runner writes not_found
          const ids = dossierByRow[slot];
          const refs = authored.refs === "all" ? ids : authored.refs === "first2" ? ids.slice(0, 2) : ids.slice(0, 1);
          cells.push({
            source_id: rowId,
            value: authored.value ?? null,
            ...(authored.status ? { status: authored.status } : {}),
            evidence_ids: refs,
            ...(authored.explanation ? { explanation: authored.explanation } : {}),
          });
        });
        frame.choices[0].delta.content = JSON.stringify({ cells });
      };

      const provider = await startScriptedOpenAiServer(CHAT_MODEL, responses, { onCall });
      providers.push(provider);
      await pointProviderAt(provider);
      const runner = createResearchRunner({
        store: storageRuntime().research,
        search: comparisonSearch([rowOne, rowTwo]),
        cancelPollIntervalMs: 40,
        claimIntervalMs: 150,
      });
      runners.push(runner);
      bindDefaultResearchRunner(runner);
      const app = await buildApp();

      const created = await app.inject({
        method: "POST",
        url: "/api/research",
        headers: ownerAuth,
        body: {
          title: "Comparison",
          question: "Compare the suppliers",
          output_kind: "comparison",
          source_ids: [rowOne, rowTwo],
          chat_model: CHAT_MODEL,
          columns: columnDecls,
          plan: steps(["Gather row evidence", ["row evidence"]]),
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
      runId = started.json().id;
      const run = await waitForRunStatus(app, runId!, ["completed", "needs_review", "failed"]);
      expect(run.status).toBe("completed");

      const table = await storageRuntime().research.getResearchTable(OWNER_ID, runId!, { limit: 100, after: null });
      const cellAt = (rowId: string, columnId: string) => {
        const row = table!.page.items.find((item) => item.row_source_id === rowId);
        const cell = row?.cells.find((c) => c.columnId === columnId);
        return cell ? { value: cell.value, status: cell.status, refs: cell.evidenceRefs } : undefined;
      };
      const [priceCol, dateCol, tierCol, renewCol, conflictCol, notesCol] = columnDecls;

      // number: valid 1200 supported; string "1200" invalid, value preserved,
      // never coerced.
      expect(cellAt(rowOne, priceCol.id)).toMatchObject({ value: 1200, status: "supported" });
      expect(cellAt(rowTwo, priceCol.id)).toMatchObject({ value: "1200", status: "invalid" });

      // date: 2026-02-30 is not a real calendar date → invalid; valid ISO date
      // supported.
      expect(cellAt(rowOne, dateCol.id)!.status).toBe("invalid");
      expect(cellAt(rowTwo, dateCol.id)).toMatchObject({ value: "2026-03-01", status: "supported" });

      // enum: "pro" is not an exact allowed member → invalid (never case-folded);
      // "Enterprise" supported.
      expect(cellAt(rowOne, tierCol.id)!.status).toBe("invalid");
      expect(cellAt(rowTwo, tierCol.id)).toMatchObject({ value: "Enterprise", status: "supported" });

      // boolean supported; the omitted cell is not_found with a null value.
      expect(cellAt(rowOne, renewCol.id)).toMatchObject({ value: true, status: "supported" });
      expect(cellAt(rowTwo, renewCol.id)).toMatchObject({ value: null, status: "not_found" });

      // A validated multi-excerpt conflict is stored conflicting with its refs.
      const conflict = cellAt(rowOne, conflictCol.id);
      expect(conflict!.status).toBe("conflicting");
      expect(conflict!.refs).toHaveLength(2);

      // The text cell requested all six row evidence ids but the store caps
      // references at five.
      expect(cellAt(rowOne, notesCol.id)!.refs).toHaveLength(5);
    }
  );
});
