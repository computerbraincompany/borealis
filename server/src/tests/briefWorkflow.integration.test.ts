/**
 * M16 stage 2 — reviewed-brief workflow end-to-end over the real durable
 * stores: real SQLite ledger, real AnalysisStore execution through the real
 * DuckDB worker (the documented M16 hook: runAnalysisService with the
 * expected-source-generation snapshot), and the real M13 DocumentStore draft
 * path. The clock is injected and only the external refresh/model seams are
 * faked, so every CAS, snapshot, comparison, and artifact assertion is made
 * against genuinely executed SQL and genuinely persisted documents.
 *
 * Runs only under `vitest.integration.config.ts` (serialized native stores).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, afterAll, describe, expect, it } from "vitest";

import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";
import { registerDataset, __shutdownDatasetWorker } from "../data/datasets.js";
import type { SqliteLedger } from "../db/types.js";
import { AnalysisStore } from "../db/stores/analysisStore.js";
import { BriefRecipeStore } from "../db/stores/briefRecipeStore.js";
import { BriefRunStore } from "../db/stores/briefRunStore.js";
import { DocumentStore } from "../db/stores/documentStore.js";
import { KnowledgeStore } from "../db/stores/knowledgeStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import { createAnalysisRunner, type AnalysisRunner } from "../analysisRunner.js";
import { createBriefRunner, type BriefRunner } from "../briefRunner.js";

const resources: TempSqliteLedger[] = [];
const directories: string[] = [];
const briefRunners: BriefRunner[] = [];
const analysisRunners: AnalysisRunner[] = [];

afterEach(async () => {
  await Promise.all(briefRunners.splice(0).map((runner) => runner.stop().catch(() => undefined)));
  await Promise.all(analysisRunners.splice(0).map((runner) => runner.stop().catch(() => undefined)));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
  await __shutdownDatasetWorker();
});

async function waitFor(condition: () => Promise<boolean>, label: string, attempts = 4_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error(`condition never held: ${label}`);
}

interface Workflow {
  readonly ledger: SqliteLedger;
  readonly account: string;
  readonly directory: string;
  readonly analyses: AnalysisStore;
  readonly documents: DocumentStore;
  readonly recipes: BriefRecipeStore;
  readonly runs: BriefRunStore;
  clock: Date;
  readonly syncCalls: string[];
  syncBehavior: (connectorId: string) => Promise<void>;
  readonly draftCalls: number[];
  buildBriefRunner(): BriefRunner;
}

async function workflow(): Promise<Workflow> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const ledger = resource.ledger;
  const account = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    account,
    `${account.slice(0, 8)}@brief-workflow.test`,
    "hash",
  ]);
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-brief-wf-")));
  directories.push(directory);

  const analyses = new AnalysisStore(ledger);
  const sources = new SourceStore(ledger);
  const documents = new DocumentStore(ledger);
  const knowledge = new KnowledgeStore(ledger);
  const clock = { value: new Date("2026-06-01T00:00:00.000Z") };
  const recipes = new BriefRecipeStore(ledger, { now: () => clock.value });
  const runs = new BriefRunStore(ledger, { now: () => clock.value });

  const analysisRunner = createAnalysisRunner({
    store: analyses,
    sources,
    cancelPollIntervalMs: 40,
    claimIntervalMs: 3_600_000,
  });
  analysisRunners.push(analysisRunner);

  const state: Workflow = {
    ledger,
    account,
    directory,
    analyses,
    documents,
    recipes,
    runs,
    get clock() {
      return clock.value;
    },
    set clock(value: Date) {
      clock.value = value;
    },
    syncCalls: [],
    syncBehavior: async () => undefined,
    draftCalls: [],
    buildBriefRunner: () => {
      const runner = createBriefRunner({
        runs,
        recipes,
        sources,
        analyses,
        knowledge,
        // Real M12 execution service with the expected-generation snapshot.
        runAnalysis: (input) => analysisRunner.runAnalysisService(input),
        // Real M13 document service draft creation (store-level).
        draft: async (request) => {
          state.draftCalls.push(1);
          const created = await documents.createDocument(request.accountId, {
            title: request.title,
            tree: request.tree,
            origin: { analysisResultId: request.origin.analysisResultId },
          });
          return { documentId: created.document.id, documentRevisionId: created.revision.id };
        },
        syncConnector: async (_accountId, connectorId) => {
          state.syncCalls.push(connectorId);
          await state.syncBehavior(connectorId);
        },
        refreshKnowledge: async () => ({ fully_ready: true, promoted: [], refreshes: [] }),
        sourceState: async () => ({ sourceStatus: "ready", readyGeneration: 1, jobStatus: null, jobGeneration: null }),
        generateNarrative: async () => "The tracked total is as stored.",
        resolveChatModel: async () => "workflow-chat",
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
        now: () => clock.value,
      });
      briefRunners.push(runner);
      return runner;
    },
  };
  return state;
}

async function writeCsv(w: Workflow, name: string, value: number): Promise<string> {
  const file = path.join(w.directory, name);
  await fs.writeFile(file, `metric_label,value\ntotal,${value}\n`, "utf8");
  return file;
}

/** Insert a ready tabular source whose identity matches the physical CSV. */
async function attachDataset(
  w: Workflow,
  name: string,
  file: string,
  generation = 3
): Promise<{ sourceId: string; name: string }> {
  const sourceId = randomUUID();
  const stat = await fs.stat(file);
  await w.ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,status,meta,ready_generation,size_bytes)
     VALUES (?,?,?,'tabular',?,?,?,?,?,?)`,
    [sourceId, w.account, name, `${name}.csv`, file, "ready", "{}", generation, stat.size]
  );
  await registerDataset({ accountId: w.account, name, location: file, kind: "path", originalName: `${name}.csv` });
  return { sourceId, name };
}

async function advanceGeneration(w: Workflow, sourceId: string, file: string): Promise<void> {
  const stat = await fs.stat(file);
  const row = await w.ledger.get<{ ready_generation: number | bigint }>(
    "SELECT ready_generation FROM sources WHERE id=?",
    [sourceId]
  );
  await w.ledger.run("UPDATE sources SET ready_generation=?, size_bytes=?, file_path=? WHERE id=?", [
    Number(row?.ready_generation ?? 0) + 1,
    stat.size,
    file,
    sourceId,
  ]);
}

async function makeRecipe(w: Workflow, sourceId: string, tableName: string, name: string) {
  const analysis = await w.analyses.createAnalysis(w.account, {
    title: `wf ${name}`,
    sql: `SELECT metric_label, value FROM ${tableName}`,
    sourceIds: [sourceId],
    comparisonKey: ["metric_label"],
  });
  const recipe = await w.recipes.createRecipe(w.account, {
    name,
    analysis_id: analysis.id,
    report_title: "Weekly finance brief",
    report_instruction: "Summarize the tracked total and its delta.",
    source_ids: [sourceId],
    schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "UTC" },
  });
  return { analysisId: analysis.id, recipeId: recipe.id };
}

async function runDue(w: Workflow, recipeId: string, runner: BriefRunner) {
  const recipe = await w.recipes.getRecipe(w.account, recipeId);
  if (!recipe) throw new Error("recipe vanished");
  const dueMs = Date.parse(recipe.nextRunAt);
  if (dueMs > w.clock.getTime()) w.clock = new Date(dueMs);
  await runner.tick();
  await waitFor(async () => runner.activeRunCount() === 0, "execution settled");
  const page = await w.runs.listRuns(w.account, recipeId, { limit: 50, after: null });
  const run = page.items[0];
  if (!run) throw new Error("no run");
  return run;
}

async function notificationKinds(w: Workflow, runId: string): Promise<string[]> {
  const rows = await w.ledger.all<{ kind: string }>(
    "SELECT kind FROM brief_notifications WHERE run_id=? ORDER BY kind",
    [runId]
  );
  return rows.map((row) => row.kind);
}

describe("reviewed-brief workflow (real stores + real DuckDB execution + real documents)", () => {
  it("runs the full pipeline: executes SQL, drafts labeled tables, and signals first_draft then meaningful_change", async () => {
    const w = await workflow();
    const file = await writeCsv(w, "finance.csv", 100);
    const { sourceId, name } = await attachDataset(w, "wf_finance", file);
    const { recipeId } = await makeRecipe(w, sourceId, name, "wf-green");
    const runner = w.buildBriefRunner();

    const first = await runDue(w, recipeId, runner);
    expect(first.stage).toBe("awaiting_review");
    expect(first.analysisSucceeded).toBe(true);
    expect(first.baselineRunId).toBeNull();
    expect(await notificationKinds(w, first.id)).toEqual(["first_draft"]);

    // The draft is a real M13 document revision with a verified envelope.
    const revision = await w.documents.getDocumentRevision(w.account, first.documentId!, first.documentRevisionId!);
    expect(revision).toBeDefined();
    const payload = JSON.stringify(revision!.payload);
    expect(payload).toContain("100"); // current value
    expect(revision!.payload.tables).toHaveLength(1);
    expect(revision!.payload.tables[0].analysis).not.toBeNull();
    const markdown = JSON.stringify(revision!.payload.sections);
    expect(markdown).toContain("no baseline");
    expect(markdown).toContain("uses imported version");

    // Second week: same recipe, changed fixture. The baseline is the first run.
    await writeCsv(w, "finance.csv", 125);
    await advanceGeneration(w, sourceId, path.join(w.directory, "finance.csv"));
    w.clock = new Date(w.clock.getTime() + 25 * 60_000);
    const second = await runDue(w, recipeId, runner);
    expect(second.baselineRunId).toBe(first.id);
    const summary = second.comparisonSummary as Record<string, unknown>;
    expect(summary.mode).toBe("keyed");
    expect(summary.changed_total).toBe(1);
    expect(JSON.stringify(summary.changed_sample)).toContain("25");
    expect(await notificationKinds(w, second.id)).toEqual(["meaningful_change"]);

    const secondRevision = await w.documents.getDocumentRevision(
      w.account,
      second.documentId!,
      second.documentRevisionId!
    );
    const secondPayload = JSON.stringify(secondRevision!.payload);
    expect(secondPayload).toContain("125");
    expect(secondPayload).toContain("100"); // baseline preview retained
    expect(secondRevision!.payload.tables).toHaveLength(2);
    expect(JSON.stringify(secondRevision!.payload.sections)).toContain("Δ 25");

    // Run 1's draft revision is byte-stable (drafts never mutate).
    const firstAgain = await w.documents.getDocumentRevision(w.account, first.documentId!, first.documentRevisionId!);
    expect(JSON.stringify(firstAgain!.payload)).toBe(payload);

    // Third run, unchanged values: silent.
    w.clock = new Date(w.clock.getTime() + 25 * 60_000);
    const third = await runDue(w, recipeId, runner);
    expect(third.baselineRunId).toBe(second.id);
    expect((third.comparisonSummary as Record<string, unknown>).changed_total).toBe(0);
    expect(await notificationKinds(w, third.id)).toEqual([]);
  });

  it("a superseded generation becomes a durable stale-inputs in the real ledger; nothing drafts", async () => {
    const w = await workflow();
    const file = await writeCsv(w, "race.csv", 100);
    const { sourceId, name } = await attachDataset(w, "wf_race", file);
    const { recipeId } = await makeRecipe(w, sourceId, name, "wf-race");
    const runner = w.buildBriefRunner();
    const recipe = await w.recipes.getRecipe(w.account, recipeId);
    w.clock = new Date(Date.parse(recipe!.nextRunAt));
    await runner.tick();
    await waitFor(async () => runner.activeRunCount() === 0, "execution settled");
    // Race the generation forward just before acceptance via a fresh clock
    // bump is unnecessary here: bump after this claim's snapshot persisted is
    // nondeterministic — instead exercise the accept-time CAS directly with a
    // dedicated manual run whose snapshot is stale: bump first, then claim.
    await advanceGeneration(w, sourceId, path.join(w.directory, "race.csv"));
    await fs.writeFile(path.join(w.directory, "race.csv"), "metric_label,value\ntotal,100\n", "utf8");

    const manual = await w.runs.createManualRun(w.account, recipeId, randomUUID());
    // The manual run's snapshot will capture gen 4, but bump again first.
    await advanceGeneration(w, sourceId, path.join(w.directory, "race.csv"));
    const late = w.buildBriefRunner();
    // Force the analyze-phase snapshot to mismatch: patch the row's committed
    // snapshot back to gen 3 (simulating wait→accept drift on real systems).
    await w.ledger.run("UPDATE brief_runs SET source_snapshot=? WHERE id=?", [
      JSON.stringify([{ source_id: sourceId, ready_generation: 3, content_identity: "stale|identity" }]),
      manual.run.id,
    ]);
    late.kick();
    await waitFor(async () => (await w.runs.getRun(w.account, manual.run.id)).stage !== "queued", "manual run started");
    await waitFor(async () => late.activeRunCount() === 0, "manual settled");
    const final = await w.runs.getRun(w.account, manual.run.id);
    expect(final.stage).toBe("failed");
    expect(final.failureCode).toBe("BRIEF_STALE_INPUTS");
    const staleRow = await w.ledger.get<{ status: string }>(
      "SELECT status FROM analysis_runs ORDER BY created_at DESC LIMIT 1"
    );
    expect(staleRow?.status).toBe("stale-inputs");
    expect(final.documentId).toBeNull();
  });

  it("a refresh failure stops the run and leaves the stored input bytes untouched", async () => {
    const w = await workflow();
    const file = await writeCsv(w, "conn.csv", 100);
    const { sourceId, name } = await attachDataset(w, "wf_conn", file);
    const connectorId = randomUUID();
    await w.ledger.run(
      "INSERT INTO connectors (id,account_id,name,type,config,target_table) VALUES (?,?,?,'url_csv','{\"url\":\"http://127.0.0.1:9/c.csv\"}',?)",
      [connectorId, w.account, "wf_conn_table", "wf_conn_table"]
    );
    await w.ledger.run("UPDATE sources SET connector=? WHERE id=?", [connectorId, sourceId]);
    const analysis = await w.analyses.createAnalysis(w.account, {
      title: "wf conn",
      sql: `SELECT metric_label, value FROM ${name}`,
      sourceIds: [sourceId],
      comparisonKey: ["metric_label"],
    });
    const recipe = await w.recipes.createRecipe(w.account, {
      name: "wf-refresh-fail",
      analysis_id: analysis.id,
      report_title: "Conn brief",
      report_instruction: "Summarize.",
      source_ids: [sourceId],
      refresh_bindings: [{ source_id: sourceId, kind: "connector", connector_id: connectorId }],
      schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "UTC" },
    });
    w.syncBehavior = async () => {
      throw new Error("upstream refused the connection");
    };
    const runner = w.buildBriefRunner();
    const run = await runDue(w, recipe.id, runner);
    expect(run.stage).toBe("failed");
    expect(run.failureCode).toBe("BRIEF_REFRESH_FAILED");
    expect(w.syncCalls).toEqual([connectorId]);
    const row = await w.ledger.get<{ ready_generation: number | bigint; file_path: string }>(
      "SELECT ready_generation,file_path FROM sources WHERE id=?",
      [sourceId]
    );
    expect(Number(row?.ready_generation)).toBe(3); // unchanged
    expect(row?.file_path).toBe(file);
    expect(await w.ledger.all("SELECT id FROM analysis_runs WHERE status='succeeded'")).toHaveLength(0);
    expect(run.documentId).toBeNull();
  });

  it("restart resumes the same run: the real analysis operation replays and exactly one document drafts", async () => {
    const w = await workflow();
    const file = await writeCsv(w, "resume.csv", 100);
    const { sourceId, name } = await attachDataset(w, "wf_resume", file);
    const { recipeId } = await makeRecipe(w, sourceId, name, "wf-resume");

    const first = w.buildBriefRunner();
    first.armCrashAt("baseline-selected"); // crash after baseline persisted, before acceptance
    const recipe = await w.recipes.getRecipe(w.account, recipeId);
    w.clock = new Date(Date.parse(recipe!.nextRunAt));
    await first.tick();
    await waitFor(async () => first.activeRunCount() === 0, "crashed run unwound");
    const crashed = (await w.runs.listRuns(w.account, recipeId, { limit: 50, after: null })).items[0];
    expect(crashed.stage).toBe("analyzing");
    expect(crashed.analysisRunId).toBeNull();

    // Restart: the fresh runner resumes with the same run-derived operation id.
    const second = w.buildBriefRunner();
    await second.tick();
    await waitFor(async () => (await w.runs.getRun(w.account, crashed.id)).stage === "awaiting_review", "resumed");
    expect(await w.ledger.all("SELECT id FROM analysis_runs")).toHaveLength(1);
    expect(w.draftCalls).toHaveLength(1);
    expect(await notificationKinds(w, crashed.id)).toEqual(["first_draft"]);
    const opRow = await w.ledger.get<{ operation_id: string }>("SELECT operation_id FROM analysis_runs");
    expect(opRow?.operation_id).toBeTruthy();
  });

  it("a rejected draft keeps its artifacts and does not become the next baseline's failure", async () => {
    const w = await workflow();
    const file = await writeCsv(w, "reject.csv", 100);
    const { sourceId, name } = await attachDataset(w, "wf_reject", file);
    const { recipeId } = await makeRecipe(w, sourceId, name, "wf-reject");
    const runner = w.buildBriefRunner();
    const first = await runDue(w, recipeId, runner);
    await w.ledger.run(
      "UPDATE brief_runs SET stage='rejected', finished_at=?, reviewed_revision_id=document_revision_id WHERE id=?",
      [w.clock.toISOString(), first.id]
    );
    await writeCsv(w, "reject.csv", 125);
    await advanceGeneration(w, sourceId, path.join(w.directory, "reject.csv"));
    w.clock = new Date(w.clock.getTime() + 25 * 60_000);
    const second = await runDue(w, recipeId, runner);
    expect(second.baselineRunId).toBe(first.id);
    expect(second.stage).toBe("awaiting_review");
    expect((await w.recipes.getRecipe(w.account, recipeId))?.consecutiveFailures).toBe(0);
  });
});
