/**
 * M16 stage 2 — reviewed-brief runner: durable stage machine against the real
 * v26 ledger stores with injected clocks, fake service adapters, and crash
 * injection at every committed boundary.
 *
 * The ledger side (recipe/run/analysis stores) is real SQLite so every CAS,
 * dedupe, CHECK, and recovery record is genuinely exercised; the external
 * services (connector sync, knowledge refresh, narrative model, draft creation)
 * are deterministic fakes. Independent expectations are computed from fixture
 * data, never from the implementation. The real-service workflow (real DuckDB
 * execution + real document store) lives in `briefWorkflow.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";
import { AnalysisStore } from "../db/stores/analysisStore.js";
import { BriefRecipeStore } from "../db/stores/briefRecipeStore.js";
import { BriefRunStore, type StoredBriefRun } from "../db/stores/briefRunStore.js";
import { SourceStore } from "../db/stores/sourceStore.js";
import { KnowledgeStore } from "../db/stores/knowledgeStore.js";
import type { DocumentTreeInput } from "../documentTypes.js";
import { RemoteEgressConsentRequiredError, type RemoteEgressTarget } from "../egressPolicy.js";
import {
  createBriefRunner,
  deriveBriefAnalysisOperationId,
  type BriefNarrativeRequest,
  type BriefRunner,
  type BriefSourceState,
  type BriefStageBoundary,
} from "../briefRunner.js";
import type { RunAnalysisServiceInput, RunAnalysisServiceResult } from "../analysisRunner.js";
import type { RefreshAndWaitReadyResult, RefreshTarget } from "../knowledgeRefresh.js";

const LOCAL_TARGET: RemoteEgressTarget = Object.freeze({
  revision: 1,
  origin: "http://127.0.0.1:1234",
  locality: "local" as const,
  host: "127.0.0.1",
});

const resources: TempSqliteLedger[] = [];
const runners: BriefRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.stop()));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function waitFor(condition: () => Promise<boolean> | boolean, label: string, attempts = 2_400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`condition never held: ${label}`);
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface DraftCall {
  readonly title: string;
  readonly tree: DocumentTreeInput;
  readonly origin: { analysisResultId: string | null };
}

type SourceStateValue = BriefSourceState;

interface Harness {
  readonly ledger: SqliteLedger;
  readonly account: string;
  clock: Date;
  readonly recipes: BriefRecipeStore;
  readonly runs: BriefRunStore;
  readonly analyses: AnalysisStore;
  readonly sources: SourceStore;
  readonly knowledge: KnowledgeStore;
  readonly fakes: {
    syncCalls: string[];
    syncBehavior: (accountId: string, connectorId: string) => Promise<void>;
    sourceState: (accountId: string, sourceId: string) => Promise<SourceStateValue | undefined>;
    refreshCalls: RefreshTarget[];
    refreshBehavior: (target: RefreshTarget) => Promise<RefreshAndWaitReadyResult>;
    analysisRows: Array<readonly [string, number]>;
    beforeAccept: (() => Promise<void>) | null;
    narrativeCalls: number;
    narrativeBehavior: (request: BriefNarrativeRequest) => Promise<string>;
    authorizeCalls: number;
    authorizeBehavior: () => Promise<RemoteEgressTarget>;
    draftCalls: DraftCall[];
  };
  advance(ms: number): void;
  notificationKinds(runId: string): Promise<string[]>;
  analysisRunCount(): Promise<number>;
  buildRunner(overrides?: Partial<Parameters<typeof createBriefRunner>[0]>): BriefRunner;
}

async function harness(): Promise<Harness> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const ledger = resource.ledger;
  const account = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    account,
    `${account.slice(0, 8)}@brief-runner.test`,
    "hash",
  ]);
  const clock = { value: new Date("2026-06-01T00:00:00.000Z") };
  const analyses = new AnalysisStore(ledger);
  const recipes = new BriefRecipeStore(ledger, { now: () => clock.value });
  const runs = new BriefRunStore(ledger, { now: () => clock.value });
  const sources = new SourceStore(ledger);
  const knowledge = new KnowledgeStore(ledger);

  const fakes: Harness["fakes"] = {
    syncCalls: [],
    syncBehavior: async () => undefined,
    sourceState: async () => ({ sourceStatus: "ready", readyGeneration: 1, jobStatus: null, jobGeneration: null }),
    refreshCalls: [],
    refreshBehavior: async () => ({ fully_ready: true, promoted: [], refreshes: [] }),
    analysisRows: [["total", 100] as [string, number]],
    beforeAccept: null,
    narrativeCalls: 0,
    narrativeBehavior: async () => "Totals moved as expected.",
    authorizeCalls: 0,
    authorizeBehavior: async () => LOCAL_TARGET,
    draftCalls: [],
  };

  const fakeRunAnalysis = async (input: RunAnalysisServiceInput): Promise<RunAnalysisServiceResult> => {
    if (fakes.beforeAccept) {
      const hook = fakes.beforeAccept;
      fakes.beforeAccept = null;
      await hook();
    }
    const accepted = await analyses.acceptAnalysisRun(input.accountId, input.analysisId, {
      operationId: input.operationId ?? null,
      expectedRevision: input.expectedRevision ?? null,
      values: input.values,
      expectedSourceSnapshot: input.expectedSourceSnapshot ?? null,
    });
    if (accepted.outcome !== "queued" || accepted.run.status !== "queued") {
      return { run: accepted.run, outcome: accepted.outcome };
    }
    await analyses.markAnalysisRunRunning(accepted.run.accountId, accepted.run.analysisId, accepted.run.id);
    await analyses.publishAnalysisRunResult(accepted.run.accountId, accepted.run.analysisId, accepted.run.id, {
      id: randomUUID(),
      columns: ["metric_label", "value"],
      rows: fakes.analysisRows.map((row) => [...row]),
    });
    const live = await analyses.getAnalysisRun(accepted.run.accountId, accepted.run.analysisId, accepted.run.id);
    if (!live) throw new Error("analysis run vanished after publish");
    return { run: live, outcome: "queued" };
  };

  const harnessValue: Harness = {
    ledger,
    account,
    get clock() {
      return clock.value;
    },
    set clock(value: Date) {
      clock.value = value;
    },
    recipes,
    runs,
    analyses,
    sources,
    knowledge,
    fakes,
    advance: (ms) => {
      clock.value = new Date(clock.value.getTime() + ms);
    },
    notificationKinds: async (runId) => {
      const rows = await ledger.all<{ kind: string }>(
        "SELECT kind FROM brief_notifications WHERE run_id=? ORDER BY kind",
        [runId]
      );
      return rows.map((row) => row.kind);
    },
    analysisRunCount: async () => {
      const row = await ledger.get<{ count: number }>("SELECT COUNT(*) AS count FROM analysis_runs");
      return Number(row?.count ?? 0);
    },
    buildRunner: (overrides = {}) => {
      const runner = createBriefRunner({
        runs,
        recipes,
        sources,
        analyses,
        knowledge,
        syncConnector: async (accountId, connectorId) => {
          fakes.syncCalls.push(connectorId);
          await fakes.syncBehavior(accountId, connectorId);
        },
        refreshKnowledge: async (input) => {
          const [target] = input.connections;
          fakes.refreshCalls.push(target);
          return fakes.refreshBehavior(target);
        },
        runAnalysis: fakeRunAnalysis,
        sourceState: (accountId, sourceId) => fakes.sourceState(accountId, sourceId),
        generateNarrative: async (request) => {
          fakes.narrativeCalls += 1;
          return fakes.narrativeBehavior(request);
        },
        resolveChatModel: async () => "test-chat-model",
        authorizeEgress: async () => {
          fakes.authorizeCalls += 1;
          return fakes.authorizeBehavior();
        },
        auditEgress: () => undefined,
        draft: async (request) => {
          fakes.draftCalls.push({ title: request.title, tree: request.tree, origin: request.origin });
          return { documentId: randomUUID(), documentRevisionId: randomUUID() };
        },
        tickIntervalMs: 3_600_000,
        cancelPollIntervalMs: 5,
        waitPollIntervalMs: 2,
        now: () => clock.value,
        ...overrides,
      });
      runners.push(runner);
      return runner;
    },
  };
  return harnessValue;
}

async function seedTabularSource(h: Harness, name: string, connectorId: string | null = null): Promise<string> {
  const sourceId = randomUUID();
  await h.ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,connector,display_name,file_path,status,meta,ready_generation,size_bytes)
     VALUES (?,?,?,'tabular',?,?,?,?,?,1,1024)`,
    [
      sourceId,
      h.account,
      name,
      connectorId,
      `${name}.csv`,
      `/uploads/${h.account}/${sourceId}/${name}.csv`,
      "ready",
      "{}",
    ]
  );
  return sourceId;
}

async function seedConnector(h: Harness, table: string): Promise<string> {
  const connectorId = randomUUID();
  await h.ledger.run(
    "INSERT INTO connectors (id,account_id,name,type,config,target_table) VALUES (?,?,?,'url_csv','{\"url\":\"http://127.0.0.1:9/x.csv\"}',?)",
    [connectorId, h.account, table, table]
  );
  return connectorId;
}

async function seedKnowledgeItem(
  h: Harness,
  name: string
): Promise<{ connectionId: string; itemId: string; sourceId: string }> {
  const connectionId = randomUUID();
  await h.ledger.run(
    `INSERT INTO knowledge_connections (id,account_id,kind,name,config)
     VALUES (?,?,'desktop_folder',?,'{"root_path":"/tmp/brief-test-folder","display_label":"seed"}')`,
    [connectionId, h.account, name]
  );
  const sourceId = await seedTabularSource(h, name);
  const itemId = randomUUID();
  await h.ledger.run(
    `INSERT INTO knowledge_items (id,account_id,connection_id,relative_path,source_id,content_hash,ingested_hash,size_bytes)
     VALUES (?,?,?,?,?,?,?,1024)`,
    [itemId, h.account, connectionId, `${name}.csv`, sourceId, "a".repeat(64), "a".repeat(64)]
  );
  return { connectionId, itemId, sourceId };
}

async function bumpSourceGeneration(h: Harness, sourceId: string, generation: number): Promise<void> {
  await h.ledger.run("UPDATE sources SET ready_generation=?,status='ready' WHERE id=?", [generation, sourceId]);
}

async function makeRecipe(
  h: Harness,
  options: {
    sourceIds: readonly string[];
    refreshBindings?: readonly Record<string, unknown>[];
    comparisonKey?: readonly string[] | null;
    parameterValues?: Record<string, unknown>;
    analysisParameters?: readonly Record<string, unknown>[];
    name?: string;
  }
): Promise<{ analysisId: string; recipeId: string }> {
  const analysis = await h.analyses.createAnalysis(h.account, {
    title: `analysis ${options.name ?? randomUUID().slice(0, 6)}`,
    sql: "SELECT metric_label, value FROM finance",
    sourceIds: [...options.sourceIds],
    ...(options.comparisonKey !== undefined ? { comparisonKey: options.comparisonKey } : {}),
    ...(options.analysisParameters ? { parameters: options.analysisParameters } : {}),
  });
  const recipe = await h.recipes.createRecipe(h.account, {
    name: options.name ?? `recipe-${randomUUID().slice(0, 8)}`,
    analysis_id: analysis.id,
    report_title: "Weekly finance brief",
    report_instruction: "Summarize the monthly totals and deltas.",
    source_ids: [...options.sourceIds],
    ...(options.parameterValues ? { parameter_values: options.parameterValues } : {}),
    ...(options.refreshBindings ? { refresh_bindings: options.refreshBindings } : {}),
    schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "UTC" },
  });
  return { analysisId: analysis.id, recipeId: recipe.id };
}

/** Advance to the recipe's next scheduled instant, tick once, and settle. */
async function dueAndRun(h: Harness, recipeId: string, runner: BriefRunner): Promise<StoredBriefRun> {
  const recipe = await h.recipes.getRecipe(h.account, recipeId);
  if (!recipe) throw new Error("recipe vanished");
  const dueMs = Date.parse(recipe.nextRunAt);
  if (dueMs > h.clock.getTime()) h.clock = new Date(dueMs);
  await runner.tick();
  await waitFor(() => runner.activeRunCount() === 0, "runner executions settled");
  await waitFor(async () => {
    const page = await h.runs.listRuns(h.account, recipeId, { limit: 50, after: null });
    const run = page.items[0];
    // Every claim settles to a terminal-or-review stage; never stays queued.
    return run !== undefined && run.stage !== "queued";
  }, "claimed run left the queued stage");
  const page = await h.runs.listRuns(h.account, recipeId, { limit: 50, after: null });
  const newest = page.items[0];
  if (!newest) throw new Error("no run claimed");
  if (
    newest.stage === "failed" &&
    ![
      "BRIEF_REFRESH_FAILED",
      "BRIEF_STALE_INPUTS",
      "BRIEF_NARRATIVE_FAILED",
      "BRIEF_DEADLINE_EXCEEDED",
      "BRIEF_REFRESH_TIMEOUT",
      "BRIEF_DRAFT_REJECTED",
      "BRIEF_ANALYSIS_FAILED",
    ].includes(newest.failureCode ?? "")
  ) {
    throw new Error(`run failed unexpectedly: ${newest.failureCode} :: ${newest.failureReason}`);
  }
  return newest;
}

// ---------------------------------------------------------------------------
// Full green path
// ---------------------------------------------------------------------------

describe("brief runner green path", () => {
  it("runs static + connector + knowledge inputs through every stage to awaiting_review", async () => {
    const h = await harness();
    const staticSource = await seedTabularSource(h, "static-csv");
    const connectorId = await seedConnector(h, "conn_table");
    const connectorSource = await seedTabularSource(h, "conn_csv", connectorId);
    const { connectionId, itemId, sourceId: knowledgeSource } = await seedKnowledgeItem(h, "folder_csv");

    h.fakes.syncBehavior = async () => {
      await bumpSourceGeneration(h, connectorSource, 2);
    };
    h.fakes.sourceState = async (_accountId, sourceId) =>
      sourceId === connectorSource && h.fakes.syncCalls.length > 0
        ? { sourceStatus: "ready", readyGeneration: 2, jobStatus: "done", jobGeneration: 2 }
        : sourceId === connectorSource
          ? { sourceStatus: "index", readyGeneration: 1, jobStatus: "running", jobGeneration: 2 }
          : { sourceStatus: "ready", readyGeneration: 1, jobStatus: null, jobGeneration: null };
    h.fakes.refreshBehavior = async (target) => {
      const promoted = target.item_ids?.includes(itemId) ?? false;
      if (promoted) await bumpSourceGeneration(h, knowledgeSource, 4);
      return {
        fully_ready: true,
        promoted: promoted
          ? [{ connection_id: target.connection_id, item_id: itemId, source_id: knowledgeSource, generation: 4 }]
          : [],
        refreshes: [
          {
            connection_id: target.connection_id,
            refresh_id: randomUUID(),
            status: "completed",
            error_code: null,
            items: [
              {
                item_id: itemId,
                source_id: knowledgeSource,
                relative_path: "folder_csv.csv",
                outcome: promoted ? "promoted" : "unchanged",
                generation: promoted ? 4 : 1,
                error_code: null,
              },
            ],
          },
        ],
      };
    };
    h.fakes.narrativeBehavior = async () => "Totals rose to 125 [7] per source [12].";

    const { recipeId } = await makeRecipe(h, {
      sourceIds: [staticSource, connectorSource, knowledgeSource],
      comparisonKey: ["metric_label"],
      refreshBindings: [
        { source_id: connectorSource, kind: "connector", connector_id: connectorId },
        { source_id: knowledgeSource, kind: "knowledge", connection_id: connectionId },
      ],
    });
    const runner = h.buildRunner();
    const run = await dueAndRun(h, recipeId, runner);
    const final = await h.runs.getRun(h.account, run.id);

    expect(final.stage).toBe("awaiting_review");
    expect(final.analysisSucceeded).toBe(true);
    expect(final.baselineRunId).toBeNull();
    expect(final.documentId).not.toBeNull();
    expect(final.documentRevisionId).not.toBeNull();
    expect(final.failureCode).toBeNull();

    // Exact persisted generation snapshot.
    const snapshot = final.sourceSnapshot as ReadonlyArray<Record<string, unknown>>;
    expect(snapshot.map((entry) => [entry.source_id, entry.ready_generation]).sort()).toEqual(
      [
        [connectorSource, 2],
        [knowledgeSource, 4],
        [staticSource, 1],
      ].sort()
    );

    // Refresh receipts: static label, connector promotion, knowledge promotion.
    const receipts = final.refreshReceipts as ReadonlyArray<Record<string, unknown>>;
    expect(receipts.map((receipt) => [receipt.source_id, receipt.kind, receipt.generation]).sort()).toEqual(
      [
        [connectorSource, "connector", 2],
        [knowledgeSource, "knowledge", 4],
        [staticSource, "static", 1],
      ].sort()
    );
    expect(receipts.find((receipt) => receipt.source_id === staticSource)?.label).toBe("uses imported version");

    // The knowledge refresh carried the exact managed-item allowlist and the
    // live expected connection revision.
    expect(h.fakes.refreshCalls[0]).toMatchObject({ connection_id: connectionId, expected_connection_revision: 1 });
    expect(h.fakes.refreshCalls[0].item_ids).toEqual([itemId]);

    // Draft: origin links, honest labels, stripped citation markers, preview
    // tables with server-verified provenance.
    expect(h.fakes.draftCalls).toHaveLength(1);
    const draft = h.fakes.draftCalls[0];
    // The authoritative run↔document link is `brief_runs.document_id`.
    expect(draft.origin.analysisResultId).not.toBeNull();
    const markdown = JSON.stringify(draft.tree.sections);
    expect(markdown).not.toContain("[7]");
    expect(markdown).not.toContain("[12]");
    expect(markdown).toContain("uses imported version");
    expect(markdown).toContain("no baseline");
    expect(draft.tree.tables).toHaveLength(1);
    expect(draft.tree.tables?.[0]?.analysis).not.toBeNull();
    expect(JSON.stringify(draft.tree.tables?.[0]?.analysis)).toContain('"ready_generation":2');

    // Step-8: exactly one first-draft notification, nothing else.
    expect(await h.notificationKinds(final.id)).toEqual(["first_draft"]);
    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    expect(recipe?.consecutiveFailures).toBe(0);
    expect(recipe?.state).toBe("active");
    expect(h.fakes.narrativeCalls).toBe(1);
  });

  it("a knowledge no-change receipt keeps the ready generation and completes the run", async () => {
    const h = await harness();
    const { connectionId, itemId, sourceId } = await seedKnowledgeItem(h, "stable_csv");
    h.fakes.refreshBehavior = async (target) => ({
      fully_ready: true,
      promoted: [],
      refreshes: [
        {
          connection_id: target.connection_id,
          refresh_id: randomUUID(),
          status: "completed",
          error_code: null,
          items: [
            {
              item_id: itemId,
              source_id: sourceId,
              relative_path: "stable_csv.csv",
              outcome: "unchanged",
              generation: 1,
              error_code: null,
            },
          ],
        },
      ],
    });
    const { recipeId } = await makeRecipe(h, {
      sourceIds: [sourceId],
      comparisonKey: ["metric_label"],
      refreshBindings: [{ source_id: sourceId, kind: "knowledge", connection_id: connectionId }],
    });
    const runner = h.buildRunner();
    const run = await dueAndRun(h, recipeId, runner);
    expect(run.stage).toBe("awaiting_review");
    const receipt = (run.refreshReceipts as ReadonlyArray<Record<string, unknown>>)[0];
    expect(receipt.outcome).toBe("unchanged");
    expect(receipt.generation).toBe(1);
    const snapshot = (run.sourceSnapshot as ReadonlyArray<Record<string, unknown>>)[0];
    expect(snapshot.ready_generation).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Baselines, comparison series, and step-8 signals
// ---------------------------------------------------------------------------

describe("brief runner baselines and notifications", () => {
  it("selects the last compatible successful run, signals meaningful_change, and stays silent on no-change", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "series_csv");
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const runner = h.buildRunner();

    const first = await dueAndRun(h, recipeId, runner);
    expect(first.baselineRunId).toBeNull();

    h.fakes.analysisRows = [["total", 125]];
    h.advance(25 * 60_000);
    const second = await dueAndRun(h, recipeId, runner);
    expect(second.baselineRunId).toBe(first.id);
    const summary = second.comparisonSummary as Record<string, unknown>;
    expect(summary.mode).toBe("keyed");
    expect(summary.changed_total).toBe(1);
    expect(JSON.stringify(summary.changed_sample)).toContain("25");
    expect(await h.notificationKinds(second.id)).toEqual(["meaningful_change"]);

    h.advance(25 * 60_000);
    const third = await dueAndRun(h, recipeId, runner);
    expect(third.baselineRunId).toBe(second.id);
    const thirdSummary = third.comparisonSummary as Record<string, unknown>;
    expect(thirdSummary.changed_total).toBe(0);
    expect(await h.notificationKinds(third.id)).toEqual([]);
  });

  it("a changed parameter begins a new series with a labeled first run", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "param_csv");
    const { recipeId } = await makeRecipe(h, {
      sourceIds: [source],
      comparisonKey: ["metric_label"],
      analysisParameters: [{ name: "threshold", type: "integer", required: false, default: 5 }],
      parameterValues: { threshold: 5 },
    });
    const runner = h.buildRunner();
    await dueAndRun(h, recipeId, runner);

    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    await h.recipes.updateRecipe(h.account, recipeId, recipe!.revision, { parameter_values: { threshold: 6 } });
    h.advance(25 * 60_000);
    const second = await dueAndRun(h, recipeId, runner);
    expect(second.baselineRunId).toBeNull();
    expect(await h.notificationKinds(second.id)).toEqual(["first_draft"]);
  });

  it("a rejected draft is not an execution failure and does not move the next baseline", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "reject_csv");
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const runner = h.buildRunner();
    const first = await dueAndRun(h, recipeId, runner);

    // Stage 3 owns the rejection transition; emulate its ledger effect directly.
    await h.ledger.run(
      "UPDATE brief_runs SET stage='rejected', finished_at=?, reviewed_revision_id=document_revision_id WHERE id=?",
      [h.clock.toISOString(), first.id]
    );
    expect((await h.recipes.getRecipe(h.account, recipeId))?.consecutiveFailures).toBe(0);

    h.fakes.analysisRows = [["total", 130]];
    h.advance(25 * 60_000);
    const second = await dueAndRun(h, recipeId, runner);
    expect(second.baselineRunId).toBe(first.id);
    expect(second.stage).toBe("awaiting_review");
  });

  it("an unsupported comparison is labeled and raises attention, never proven no-change", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "nokey_csv");
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: null });
    const runner = h.buildRunner();
    await dueAndRun(h, recipeId, runner);
    h.fakes.analysisRows = [["total", 125]];
    h.advance(25 * 60_000);
    const second = await dueAndRun(h, recipeId, runner);
    const summary = second.comparisonSummary as Record<string, unknown>;
    expect(summary.mode).toBe("side-by-side");
    expect(summary.reason_code).toBe("no-comparison-key");
    expect(await h.notificationKinds(second.id)).toEqual(["attention"]);
    expect(JSON.stringify(h.fakes.draftCalls[1].tree)).toContain("never be read as proof of no change");
  });
});

// ---------------------------------------------------------------------------
// Refresh classification and prerequisite visibility
// ---------------------------------------------------------------------------

describe("brief runner refresh outcomes", () => {
  it("connector refresh failure stops the run with a visible reason, attention, and a counted failure — old data untouched", async () => {
    const h = await harness();
    const connectorId = await seedConnector(h, "fail_table");
    const source = await seedTabularSource(h, "fail_csv", connectorId);
    h.fakes.syncBehavior = async () => {
      throw new Error("connector exploded");
    };
    const { recipeId } = await makeRecipe(h, {
      sourceIds: [source],
      comparisonKey: ["metric_label"],
      refreshBindings: [{ source_id: source, kind: "connector", connector_id: connectorId }],
    });
    const runner = h.buildRunner();
    const run = await dueAndRun(h, recipeId, runner);
    expect(run.stage).toBe("failed");
    expect(run.failureCode).toBe("BRIEF_REFRESH_FAILED");
    expect(run.failureReason).not.toBeNull();
    expect(run.failureReason!.length).toBeLessThanOrEqual(500);
    expect(await h.analysisRunCount()).toBe(0);
    expect(h.fakes.draftCalls).toHaveLength(0);
    expect(await h.notificationKinds(run.id)).toEqual(["attention"]);
    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    expect(recipe?.consecutiveFailures).toBe(1);
    const row = await h.ledger.get<{ ready_generation: number | bigint }>(
      "SELECT ready_generation FROM sources WHERE id=?",
      [source]
    );
    expect(Number(row?.ready_generation)).toBe(1);
  });

  it("revoked remote-egress consent skips the run with a visible code and never counts a failure", async () => {
    const h = await harness();
    const connectorId = await seedConnector(h, "gated_table");
    const source = await seedTabularSource(h, "gated_csv", connectorId);
    h.fakes.authorizeBehavior = async () => {
      throw new RemoteEgressConsentRequiredError();
    };
    const { recipeId } = await makeRecipe(h, {
      sourceIds: [source],
      comparisonKey: ["metric_label"],
      refreshBindings: [{ source_id: source, kind: "connector", connector_id: connectorId }],
    });
    const runner = h.buildRunner();
    const run = await dueAndRun(h, recipeId, runner);
    expect(run.stage).toBe("skipped");
    expect(run.failureCode).toBe("BRIEF_EGRESS_CONSENT_REQUIRED");
    expect(h.fakes.syncCalls).toEqual([]);
    expect(await h.notificationKinds(run.id)).toEqual([]);
    expect((await h.recipes.getRecipe(h.account, recipeId))?.consecutiveFailures).toBe(0);
  });

  it("a busy knowledge input blocks visibly without counting a failure", async () => {
    const h = await harness();
    const { connectionId, itemId, sourceId } = await seedKnowledgeItem(h, "busy_csv");
    h.fakes.refreshBehavior = async (target) => ({
      fully_ready: false,
      promoted: [],
      refreshes: [
        {
          connection_id: target.connection_id,
          refresh_id: randomUUID(),
          status: "completed",
          error_code: null,
          items: [
            {
              item_id: itemId,
              source_id: sourceId,
              relative_path: "busy_csv.csv",
              outcome: "blocked",
              generation: null,
              error_code: "KNOWLEDGE_SOURCE_IN_ACTIVE_RUN",
            },
          ],
        },
      ],
    });
    const { recipeId } = await makeRecipe(h, {
      sourceIds: [sourceId],
      comparisonKey: ["metric_label"],
      refreshBindings: [{ source_id: sourceId, kind: "knowledge", connection_id: connectionId }],
    });
    const runner = h.buildRunner();
    const run = await dueAndRun(h, recipeId, runner);
    expect(run.stage).toBe("skipped");
    expect(run.failureCode).toBe("BRIEF_INPUT_BUSY");
    expect((await h.recipes.getRecipe(h.account, recipeId))?.consecutiveFailures).toBe(0);
  });

  it("five consecutive failures pause the recipe once with a paused notification", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "storm_csv");
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    h.fakes.narrativeBehavior = async () => {
      throw new Error("model down");
    };
    const runner = h.buildRunner();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const run = await dueAndRun(h, recipeId, runner);
      expect(run.stage).toBe("failed");
      expect(run.failureCode).toBe("BRIEF_NARRATIVE_FAILED");
      h.advance(25 * 60_000);
    }
    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    expect(recipe?.state).toBe("paused");
    expect(recipe?.consecutiveFailures).toBe(5);
    const paused = await h.ledger.get("SELECT 1 AS hit FROM brief_notifications WHERE kind='paused'");
    expect(paused).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Wait/supersession and deadlines
// ---------------------------------------------------------------------------

describe("brief runner wait, supersession, and deadlines", () => {
  it("supersession while waiting fails honestly as stale-inputs and never analyzes", async () => {
    const h = await harness();
    const connectorId = await seedConnector(h, "jump_table");
    const source = await seedTabularSource(h, "jump_csv", connectorId);
    // Sync reserves generation 2, but the row raced ahead to generation 3.
    h.fakes.syncBehavior = async () => {
      await bumpSourceGeneration(h, source, 3);
    };
    h.fakes.sourceState = async () => ({
      sourceStatus: "ready",
      readyGeneration: 3,
      jobStatus: "done",
      jobGeneration: 2,
    });
    const { recipeId } = await makeRecipe(h, {
      sourceIds: [source],
      comparisonKey: ["metric_label"],
      refreshBindings: [{ source_id: source, kind: "connector", connector_id: connectorId }],
    });
    const runner = h.buildRunner();
    const run = await dueAndRun(h, recipeId, runner);
    expect(run.stage).toBe("failed");
    expect(run.failureCode).toBe("BRIEF_STALE_INPUTS");
    expect(await h.analysisRunCount()).toBe(0);
    expect(h.fakes.draftCalls).toHaveLength(0);
  });

  it("a generation superseded after the wait becomes a durable stale-inputs, never a current-data rerun", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "race_csv");
    h.fakes.beforeAccept = async () => {
      await bumpSourceGeneration(h, source, 9);
    };
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const runner = h.buildRunner();
    const run = await dueAndRun(h, recipeId, runner);
    expect(run.stage).toBe("failed");
    expect(run.failureCode).toBe("BRIEF_STALE_INPUTS");
    const stale = await h.ledger.get<{ status: string }>("SELECT status FROM analysis_runs LIMIT 1");
    expect(stale?.status).toBe("stale-inputs");
    expect(h.fakes.draftCalls).toHaveLength(0);
    const snapshot = (run.sourceSnapshot as ReadonlyArray<Record<string, unknown>>)[0];
    expect(snapshot.ready_generation).toBe(1);
  });

  it("the 15-minute refresh/wait stage deadline aborts with a bounded failure", async () => {
    const h = await harness();
    const connectorId = await seedConnector(h, "stall_table");
    const source = await seedTabularSource(h, "stall_csv", connectorId);
    h.fakes.syncBehavior = async () => {
      // The sync succeeds but the reserved generation never promotes.
    };
    h.fakes.sourceState = async () => ({
      sourceStatus: "index",
      readyGeneration: 1,
      jobStatus: "running",
      jobGeneration: 2,
    });
    const { recipeId } = await makeRecipe(h, {
      sourceIds: [source],
      comparisonKey: ["metric_label"],
      refreshBindings: [{ source_id: source, kind: "connector", connector_id: connectorId }],
    });
    // Each runner-clock read burns 2 simulated minutes; the cancel observer is
    // parked so the stage-boundary guard is what observes the 15-minute budget.
    const runner = h.buildRunner({
      cancelPollIntervalMs: 3_600_000,
      now: () => {
        h.advance(2 * 60_000);
        return h.clock;
      },
    });
    const run = await dueAndRun(h, recipeId, runner);
    expect(run.stage).toBe("failed");
    expect(run.failureCode).toBe("BRIEF_REFRESH_TIMEOUT");
    expect(await h.analysisRunCount()).toBe(0);
  });

  it("the 30-minute total deadline aborts before drafting", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "late_csv");
    h.fakes.narrativeBehavior = async () => {
      h.advance(31 * 60_000);
      return "late";
    };
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const runner = h.buildRunner();
    const run = await dueAndRun(h, recipeId, runner);
    expect(run.stage).toBe("failed");
    expect(run.failureCode).toBe("BRIEF_DEADLINE_EXCEEDED");
    expect(h.fakes.draftCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cancellation and admission
// ---------------------------------------------------------------------------

describe("brief runner cancellation and admission", () => {
  it("cancellation at a stage boundary stops the run and preserves artifacts-to-date", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "cancel_csv");
    let releaseNarrative: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseNarrative = resolve;
    });
    h.fakes.narrativeBehavior = async () => {
      await gate;
      return "released";
    };
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const runner = h.buildRunner();
    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    h.clock = new Date(Date.parse(recipe!.nextRunAt));
    await runner.tick();
    const page = await h.runs.listRuns(h.account, recipeId);
    const run = page.items[0];
    await waitFor(async () => (await h.runs.getRun(h.account, run.id)).stage === "drafting", "run reached drafting");
    await h.runs.requestRunCancel(h.account, run.id);
    releaseNarrative();
    await waitFor(() => runner.activeRunCount() === 0, "execution settled");
    const final = await h.runs.getRun(h.account, run.id);
    expect(final.stage).toBe("cancelled");
    expect(final.failureCode).toBeNull();
    expect(final.analysisRunId).not.toBeNull();
    expect(final.analysisSucceeded).toBe(true);
    expect(h.fakes.draftCalls).toHaveLength(0);
    expect((await h.recipes.getRecipe(h.account, recipeId))?.consecutiveFailures).toBe(0);
    // Cancellation requests are idempotent, including after terminalization.
    const again = await h.runs.requestRunCancel(h.account, run.id);
    expect(again.run.stage).toBe("cancelled");
  });

  it("executes at most one brief per account and two globally", async () => {
    const h = await harness();
    const accountB = randomUUID();
    await h.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      accountB,
      "b@brief-runner.test",
      "hash",
    ]);
    const sourceB = randomUUID();
    await h.ledger.run(
      `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,status,meta,ready_generation,size_bytes)
       VALUES (?,?,?,'tabular',?,?,?,?,1,1024)`,
      [sourceB, accountB, "gate_b", "gate_b.csv", `/uploads/${accountB}/${sourceB}/gate_b.csv`, "ready", "{}"]
    );

    const recipeA1 = await makeRecipe(h, { sourceIds: [await seedTabularSource(h, "gate_a1")], name: "gate-a1" });
    const recipeA2 = await makeRecipe(h, { sourceIds: [await seedTabularSource(h, "gate_a2")], name: "gate-a2" });
    const analysisB = await h.analyses.createAnalysis(accountB, {
      title: "analysis b",
      sql: "SELECT metric_label, value FROM finance",
      sourceIds: [sourceB],
      comparisonKey: ["metric_label"],
    });
    const recipeB = await h.recipes.createRecipe(accountB, {
      name: "gate-b",
      analysis_id: analysisB.id,
      report_title: "B brief",
      report_instruction: "Summarize.",
      source_ids: [sourceB],
      schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "UTC" },
    });

    const accountsInNarrative = new Set<string>();
    let sameAccountOverlap = false;
    let globalMax = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fakes.narrativeBehavior = async (request) => {
      if (accountsInNarrative.has(request.accountId)) sameAccountOverlap = true;
      accountsInNarrative.add(request.accountId);
      globalMax = Math.max(globalMax, accountsInNarrative.size);
      await gate;
      accountsInNarrative.delete(request.accountId);
      return "ok";
    };

    h.advance(48 * 60 * 60_000); // all three recipes are due
    const runner = h.buildRunner();
    await runner.tick();
    await waitFor(() => runner.activeRunCount() === 2, "two executions active", 1_500);
    expect(runner.activeRunCount()).toBe(2);
    expect(globalMax).toBeLessThanOrEqual(2);
    expect(sameAccountOverlap).toBe(false);

    release();
    await waitFor(() => runner.activeRunCount() === 0, "first batch settled");
    await runner.tick();
    await waitFor(() => runner.activeRunCount() === 0, "second batch settled");
    await waitFor(async () => {
      const a1 = (await h.runs.listRuns(h.account, recipeA1.recipeId)).items[0];
      const a2 = (await h.runs.listRuns(h.account, recipeA2.recipeId)).items[0];
      const b = (await h.runs.listRuns(accountB, recipeB.id)).items[0];
      return a1?.stage === "awaiting_review" && a2?.stage === "awaiting_review" && b?.stage === "awaiting_review";
    }, "all three briefs reviewed");
    expect(sameAccountOverlap).toBe(false);
    expect(globalMax).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Claim/dedupe/coalescing and restart recovery
// ---------------------------------------------------------------------------

describe("brief runner claim, coalescing, and recovery", () => {
  it("deduplicates the same occurrence across restart and coalesces missed windows to one catch-up", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "coalesce_csv");
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    h.clock = new Date(Date.parse(recipe!.nextRunAt));

    const first = h.buildRunner();
    await first.tick();
    await waitFor(() => first.activeRunCount() === 0, "run 1 settled");
    expect(await h.ledger.all("SELECT id FROM brief_runs")).toHaveLength(1);

    // Restart: a fresh runner must not duplicate the already-claimed occurrence.
    const second = h.buildRunner();
    await second.tick();
    expect(await h.ledger.all("SELECT id FROM brief_runs")).toHaveLength(1);

    h.advance(3 * 24 * 60 * 60_000);
    await second.tick();
    await waitFor(() => second.activeRunCount() === 0, "catch-up settled");
    const runs = (await h.runs.listRuns(h.account, recipeId, { limit: 50, after: null })).items;
    expect(runs).toHaveLength(2);
    const catchUp = runs[0];
    expect(catchUp.coalescedCount).toBe(3);
    expect(catchUp.stage).toBe("awaiting_review");
    const refreshed = await h.recipes.getRecipe(h.account, recipeId);
    expect(Date.parse(refreshed!.nextRunAt)).toBeGreaterThan(h.clock.getTime());
  });

  it("a run under execution coalesces later due occurrences into at most one pending catch-up, and awaiting_review never blocks", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "overlap_csv");
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fakes.narrativeBehavior = async () => {
      await gate;
      return "ok";
    };
    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    h.clock = new Date(Date.parse(recipe!.nextRunAt));
    const runner = h.buildRunner();
    await runner.tick();
    await waitFor(() => runner.activeRunCount() === 1, "execution active");

    h.advance(2 * 24 * 60 * 60_000);
    await runner.tick();
    await runner.tick();
    // While a run is active, due occurrences claim NOTHING (at most the one
    // later catch-up, which is still pending).
    expect(await h.ledger.all("SELECT id FROM brief_runs")).toHaveLength(1);

    release();
    // The gated run now notices its own 30-minute budget expired (honest,
    // not resurrected against newer data).
    await waitFor(() => runner.activeRunCount() === 0, "first run settled");
    const stalled = (await h.runs.listRuns(h.account, recipeId, { limit: 50, after: null })).items[0];
    expect(stalled.stage).toBe("failed");
    expect(stalled.failureCode).toBe("BRIEF_DEADLINE_EXCEEDED");

    // With no active run, exactly ONE coalesced catch-up claims the window.
    await runner.tick();
    await waitFor(() => runner.activeRunCount() === 0, "catch-up settled");
    const runs = (await h.runs.listRuns(h.account, recipeId, { limit: 50, after: null })).items;
    expect(runs).toHaveLength(2);
    expect(runs[0].coalescedCount).toBe(2);
    expect(runs[0].stage).toBe("awaiting_review");

    // Awaiting review never blocks the next occurrence.
    h.advance(25 * 60 * 60_000);
    await runner.tick();
    await waitFor(() => runner.activeRunCount() === 0, "next occurrence settled");
    const afterReview = (await h.runs.listRuns(h.account, recipeId, { limit: 50, after: null })).items;
    expect(afterReview).toHaveLength(3);
    expect(afterReview[0].coalescedCount).toBe(1);
  });

  it("manual runs execute the same pipeline and replay their operation idempotently", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "manual_csv");
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const operationId = randomUUID();
    const { run, replayed } = await h.runs.createManualRun(h.account, recipeId, operationId);
    expect(replayed).toBe(false);
    const runner = h.buildRunner();
    runner.kick();
    await waitFor(async () => (await h.runs.getRun(h.account, run.id)).stage !== "queued", "manual run started");
    await waitFor(
      async () => (await h.runs.getRun(h.account, run.id)).stage === "awaiting_review",
      "manual run reviewed"
    );
    const final = await h.runs.getRun(h.account, run.id);
    expect(final.stage).toBe("awaiting_review");
    expect(final.trigger).toBe("manual");
    const replay = await h.runs.createManualRun(h.account, recipeId, operationId);
    expect(replay.replayed).toBe(true);
    expect(replay.run.id).toBe(run.id);
  });
});

// ---------------------------------------------------------------------------
// Crash injection at every committed boundary
// ---------------------------------------------------------------------------

describe("brief runner crash recovery (at-most-one committed artifact per logical stage)", () => {
  const boundaries = [
    "stage-refreshing",
    "refresh-receipts",
    "source-snapshot",
    "stage-analyzing",
    "baseline-selected",
    "analysis-accepted",
    "comparison-persisted",
    "draft-references",
    "outcome-accounted",
    "awaiting-review",
  ] as const satisfies readonly BriefStageBoundary[];

  for (const boundary of boundaries) {
    it(`resumes exactly once after a crash at "${boundary}"`, async () => {
      const h = await harness();
      const connectorId = await seedConnector(h, `crash_${boundary.replace(/[^a-z_]/gi, "_")}`);
      const source = await seedTabularSource(h, `crash_${boundary.replace(/[^a-z_]/gi, "_")}`, connectorId);
      h.fakes.syncBehavior = async () => {
        await bumpSourceGeneration(h, source, 2);
      };
      h.fakes.sourceState = async () =>
        h.fakes.syncCalls.length > 0
          ? { sourceStatus: "ready", readyGeneration: 2, jobStatus: "done", jobGeneration: 2 }
          : { sourceStatus: "index", readyGeneration: 1, jobStatus: "running", jobGeneration: 2 };
      const { recipeId } = await makeRecipe(h, {
        sourceIds: [source],
        comparisonKey: ["metric_label"],
        refreshBindings: [{ source_id: source, kind: "connector", connector_id: connectorId }],
      });

      const first = h.buildRunner();
      first.armCrashAt(boundary);
      const recipe = await h.recipes.getRecipe(h.account, recipeId);
      h.clock = new Date(Date.parse(recipe!.nextRunAt));
      await first.tick();
      await waitFor(() => first.activeRunCount() === 0, "crashed execution unwound");
      expect(await h.ledger.all("SELECT id FROM brief_runs")).toHaveLength(1);

      // Restart: a fresh runner resumes the SAME run to completion.
      const second = h.buildRunner();
      await second.tick();
      await waitFor(() => second.activeRunCount() === 0, "resume settled");
      const runs = (await h.runs.listRuns(h.account, recipeId, { limit: 50, after: null })).items;
      expect(runs).toHaveLength(1);
      const final = runs[0];
      expect(final.stage).toBe("awaiting_review");

      // At-most-one committed artifact per logical stage:
      expect(await h.ledger.all("SELECT id FROM analysis_runs")).toHaveLength(1);
      expect(await h.ledger.all("SELECT id FROM analysis_results")).toHaveLength(1);
      expect(h.fakes.draftCalls).toHaveLength(1);
      const notifications = await h.ledger.all<{ kind: string }>(
        "SELECT kind FROM brief_notifications WHERE run_id=?",
        [final.id]
      );
      expect(notifications.map((row) => row.kind)).toEqual(["first_draft"]);
      // The analysis operation id derives from the run, so acceptance replayed
      // the original durable run rather than creating another.
      const opId = await h.ledger.get<{ operation_id: string }>("SELECT operation_id FROM analysis_runs");
      expect(opId?.operation_id).toBe(deriveBriefAnalysisOperationId(final.id));
    });
  }

  it("an interrupted draft with no persisted references fails visibly and only a fresh explicit retry proceeds", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "orphandraft_csv");
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const crashingRunner = h.buildRunner({
      // The draft was created but the reference write was lost: the runner
      // cannot prove completion and must fail visibly, never retry inline.
      draft: async (request) => {
        h.fakes.draftCalls.push({ title: request.title, tree: request.tree, origin: request.origin });
        throw new Error("lost write after draft creation");
      },
    });
    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    h.clock = new Date(Date.parse(recipe!.nextRunAt));
    await crashingRunner.tick();
    await waitFor(() => crashingRunner.activeRunCount() === 0, "draft-lost execution settled");
    const runs = (await h.runs.listRuns(h.account, recipeId, { limit: 50, after: null })).items;
    expect(runs).toHaveLength(1);
    expect(runs[0].stage).toBe("failed");
    expect(runs[0].documentId).toBeNull();

    const retry = await h.runs.createManualRun(h.account, recipeId, randomUUID());
    const retryRunner = h.buildRunner();
    retryRunner.kick();
    await waitFor(
      async () => (await h.runs.getRun(h.account, retry.run.id)).stage === "awaiting_review",
      "retry reviewed"
    );
  });

  it("shutdown interrupts in-flight work and the next owner resumes from the committed stage", async () => {
    const h = await harness();
    const source = await seedTabularSource(h, "shutdown_csv");
    h.fakes.narrativeBehavior = async (request) => {
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(abortError());
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
      throw abortError();
    };
    const { recipeId } = await makeRecipe(h, { sourceIds: [source], comparisonKey: ["metric_label"] });
    const recipe = await h.recipes.getRecipe(h.account, recipeId);
    h.clock = new Date(Date.parse(recipe!.nextRunAt));
    const first = h.buildRunner();
    await first.tick();
    await waitFor(() => first.activeRunCount() === 1, "execution in flight");
    await first.stop(); // Shutdown interrupt, no cancellation requested.
    const mid = (await h.runs.listRuns(h.account, recipeId)).items[0];
    expect(["queued", "refreshing", "waiting_ready", "analyzing", "drafting"]).toContain(mid.stage);
    expect(h.fakes.draftCalls).toHaveLength(0);

    // A fresh runner (restart) resumes the same run and finishes exactly once.
    h.fakes.narrativeBehavior = async () => "ok after restart";
    const second = h.buildRunner();
    second.start();
    await waitFor(
      async () => (await h.runs.getRun(h.account, mid.id)).stage === "awaiting_review",
      "resumed to review"
    );
    expect(h.fakes.draftCalls).toHaveLength(1);
    expect(await h.ledger.all("SELECT id FROM analysis_runs")).toHaveLength(1);
  });
});
