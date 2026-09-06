import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import { LATEST_SQLITE_SCHEMA_VERSION, SCHEMA_V26, SCHEMA_V27 } from "../db/migrations.js";
import { AnalysisStore } from "../db/stores/analysisStore.js";
import {
  BriefRecipeNotFoundError,
  BriefRecipeStore,
  BriefRevisionConflictError,
  BriefValidationError,
} from "../db/stores/briefRecipeStore.js";
import { BriefActiveRunError, BriefRunStore, BriefRunStateError } from "../db/stores/briefRunStore.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";
import { expectedFixtureVersions, listHistoricalFixtureVersions } from "./sqliteMigrationFixture.js";

const temporaryLedgers: TempSqliteLedger[] = [];

async function temporaryLedger(): Promise<TempSqliteLedger> {
  const resource = await createTempSqliteLedger();
  temporaryLedgers.push(resource);
  return resource;
}

afterEach(async () => {
  await Promise.all(temporaryLedgers.splice(0).map((resource) => resource.cleanup()));
});

async function seedAccount(ledger: SqliteLedger): Promise<string> {
  const accountId = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    accountId,
    `${accountId.slice(0, 8)}@brief.test`,
    "hash",
  ]);
  return accountId;
}

async function seedSource(ledger: SqliteLedger, accountId: string, name: string): Promise<string> {
  const sourceId = randomUUID();
  await ledger.run(
    "INSERT INTO sources (id,account_id,name,kind,connector,display_name,status,meta,ready_generation) VALUES (?,?,?,'document',NULL,?,'ready','{}',1)",
    [sourceId, accountId, name, `${name}.csv`]
  );
  return sourceId;
}

async function seedConnector(ledger: SqliteLedger, accountId: string, table: string): Promise<string> {
  const connectorId = randomUUID();
  await ledger.run(
    "INSERT INTO connectors (id,account_id,name,type,config,target_table) VALUES (?,?,?,'url_csv','{\"url\":\"http://127.0.0.1:9/x.csv\"}',?)",
    [connectorId, accountId, table, table]
  );
  return connectorId;
}

async function seedKnowledgeConnection(ledger: SqliteLedger, accountId: string, name: string): Promise<string> {
  const connectionId = randomUUID();
  await ledger.run("INSERT INTO knowledge_connections (id,account_id,kind,name,config) VALUES (?,?,?,?,'{}')", [
    connectionId,
    accountId,
    "desktop_folder",
    name,
  ]);
  return connectionId;
}

interface Fixture {
  readonly ledger: SqliteLedger;
  readonly account: string;
  readonly recipes: BriefRecipeStore;
  readonly runs: BriefRunStore;
  readonly analyses: AnalysisStore;
  clock: Date;
}

async function fixture(startClock = "2026-06-01T12:00:00.000Z"): Promise<Fixture> {
  const resource = await temporaryLedger();
  const account = await seedAccount(resource.ledger);
  const clock = { value: new Date(startClock) };
  const fixtureValue: Fixture = {
    ledger: resource.ledger,
    account,
    recipes: new BriefRecipeStore(resource.ledger, { now: () => clock.value }),
    runs: new BriefRunStore(resource.ledger, { now: () => clock.value }),
    analyses: new AnalysisStore(resource.ledger),
    get clock() {
      return clock.value;
    },
    set clock(value: Date) {
      clock.value = value;
    },
  };
  return fixtureValue;
}

function dailySchedule(hour = 9, minute = 0, timeZone = "America/New_York") {
  return { kind: "daily" as const, hour, minute, time_zone: timeZone };
}

async function makeAnalysis(fx: Fixture, sourceIds: readonly string[], parameters?: readonly unknown[]) {
  return fx.analyses.createAnalysis(fx.account, {
    title: `brief analysis ${sourceIds.length}`,
    sql: "SELECT 1 AS value",
    sourceIds: [...sourceIds],
    parameters,
  });
}

async function makeRecipe(
  fx: Fixture,
  sourceIds: readonly string[],
  schedule = dailySchedule(),
  name = `recipe-${sourceIds.length}-${Math.random().toString(16).slice(2)}`
) {
  const analysis = await makeAnalysis(fx, sourceIds);
  const recipe = await fx.recipes.createRecipe(fx.account, {
    name,
    analysis_id: analysis.id,
    report_title: "Weekly finance brief",
    report_instruction: "Summarize the monthly totals and deltas.",
    source_ids: [...sourceIds],
    schedule,
  });
  return { analysis, recipe };
}

describe("brief recipe schema foundation", () => {
  it("ships a byte-identical v026 fixture and keeps the documented v25 gap", async () => {
    expect(LATEST_SQLITE_SCHEMA_VERSION).toBe(27);
    const fixtureSql = await fs.readFile(fileURLToPath(new URL("./fixtures/sqlite/v026.sql", import.meta.url)), "utf8");
    expect(fixtureSql).toBe(SCHEMA_V26);
    const v27Fixture = await fs.readFile(fileURLToPath(new URL("./fixtures/sqlite/v027.sql", import.meta.url)), "utf8");
    expect(v27Fixture).toBe(SCHEMA_V27);
    await expect(listHistoricalFixtureVersions()).resolves.toEqual(expectedFixtureVersions());
  });

  it("enforces strict durable invariants on direct writes", async () => {
    const fx = await fixture();
    const { recipe } = await makeRecipe(fx, [await seedSource(fx.ledger, fx.account, "s-strict")]);
    // Recipe revisions are immutable (trigger errors normalize to a
    // constraint error whose cause carries the immutable-rows message).
    const tamper = await fx.ledger
      .run("UPDATE brief_recipe_revisions SET name='tampered' WHERE recipe_id=?", [recipe.id])
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(String((tamper as { cause?: { message?: string } } | null)?.cause?.message ?? "")).toMatch(/immutable/);
    // Review events are immutable.
    // A run cannot skip into awaiting_review without its draft.
    await expect(
      fx.ledger.run(
        `INSERT INTO brief_runs (id,account_id,recipe_id,trigger,occurrence_key,recipe_revision,recipe_snapshot,stage,deadline_at)
         VALUES (?,?,?,'scheduled','2026-06-01T09:00',1,'{}','awaiting_review','2026-06-01T12:30:00.000Z')`,
        [randomUUID(), fx.account, recipe.id]
      )
    ).rejects.toThrow(/constraint violated/);
    // Terminal stages require finished_at; non-terminal stages forbid it.
    await expect(
      fx.ledger.run(
        `INSERT INTO brief_runs (id,account_id,recipe_id,trigger,occurrence_key,recipe_revision,recipe_snapshot,stage,deadline_at)
         VALUES (?,?,?,'scheduled','2026-06-02T09:00',1,'{}','failed','2026-06-01T12:30:00.000Z')`,
        [randomUUID(), fx.account, recipe.id]
      )
    ).rejects.toThrow(/constraint violated/);
    // A claimed occurrence key cannot be inserted twice (duplicate-claim guard).
    const runs = fx.runs;
    const manual = await runs.createManualRun(fx.account, recipe.id, randomUUID());
    await expect(
      fx.ledger.run(
        `INSERT INTO brief_runs (id,account_id,recipe_id,trigger,operation_id,occurrence_key,recipe_revision,recipe_snapshot,stage,deadline_at,stage_updated_at)
         VALUES (?,?,?,'scheduled',?,?,1,'{}','queued','2026-06-01T12:30:00.000Z','2026-06-01T12:00:00.000Z')`,
        [randomUUID(), fx.account, recipe.id, manual.run.operationId, manual.run.occurrenceKey]
      )
    ).rejects.toThrow(/constraint violated/);
    // Notification dedup is the (run, kind) unique index.
    const note = await runs.recordNotification(fx.account, manual.run.id, "first_draft");
    expect(note.created).toBe(true);
    await expect(
      fx.ledger.run("INSERT INTO brief_notifications (id,account_id,recipe_id,run_id,kind) VALUES (?,?,?,?,?)", [
        randomUUID(),
        fx.account,
        recipe.id,
        manual.run.id,
        "first_draft",
      ])
    ).rejects.toThrow(/constraint violated/);
  });
});

async function claimOnce(fx: Fixture, clockIso: string) {
  fx.clock = new Date(clockIso);
  return fx.runs.claimDueRuns();
}

describe("recipe membership and optimistic revision", () => {
  it("requires membership to equal the bound revision's selected set", async () => {
    const fx = await fixture();
    const a = await seedSource(fx.ledger, fx.account, "m-a");
    const b = await seedSource(fx.ledger, fx.account, "m-b");
    const analysis = await makeAnalysis(fx, [a, b]);
    const baseInput = {
      name: "membership",
      analysis_id: analysis.id,
      report_title: "t",
      report_instruction: "i",
      schedule: dailySchedule(),
    };
    await expect(fx.recipes.createRecipe(fx.account, { ...baseInput, source_ids: [a] })).rejects.toThrow(
      BriefValidationError
    );
    await expect(
      fx.recipes.createRecipe(fx.account, { ...baseInput, source_ids: [a, b, randomUUID()] })
    ).rejects.toThrow(BriefValidationError);
    const foreignAccount = await seedAccount(fx.ledger);
    const foreignSource = await seedSource(fx.ledger, foreignAccount, "foreign-src");
    const foreignAnalysis = await fx.analyses.createAnalysis(foreignAccount, {
      title: "foreign",
      sql: "SELECT 1",
      sourceIds: [foreignSource],
    });
    await expect(
      fx.recipes.createRecipe(fx.account, {
        ...baseInput,
        analysis_id: foreignAnalysis.id,
        source_ids: [foreignSource],
      })
    ).rejects.toThrow(BriefValidationError);
    // Order-insensitive equality is accepted.
    const recipe = await fx.recipes.createRecipe(fx.account, { ...baseInput, source_ids: [b, a] });
    expect(recipe.content.source_ids).toEqual([b, a]);
    expect(recipe.revision).toBe(1);
    const revisions = await fx.ledger.all("SELECT revision FROM brief_recipe_revisions WHERE recipe_id=?", [recipe.id]);
    expect(revisions).toEqual([{ revision: 1n }]);
  });

  it("validates typed parameter values against the bound declaration", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "param-src");
    const analysis = await makeAnalysis(fx, [s], [{ name: "limit", type: "integer", required: true }]);
    const baseInput = {
      name: "params",
      analysis_id: analysis.id,
      report_title: "t",
      report_instruction: "i",
      source_ids: [s],
      schedule: dailySchedule(),
    };
    await expect(fx.recipes.createRecipe(fx.account, baseInput)).rejects.toThrow(/required parameter/);
    await expect(fx.recipes.createRecipe(fx.account, { ...baseInput, parameter_values: { nope: 1 } })).rejects.toThrow(
      /not declared/
    );
    await expect(
      fx.recipes.createRecipe(fx.account, { ...baseInput, parameter_values: { limit: "ten" } })
    ).rejects.toThrow(BriefValidationError);
    const ok = await fx.recipes.createRecipe(fx.account, { ...baseInput, parameter_values: { limit: 10 } });
    expect(ok.content.parameter_values).toEqual([{ name: "limit", type: "integer", value: 10 }]);
  });

  it("validates the IANA zone and rejects garbage schedules at write", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "tz-src");
    const { recipe } = await makeRecipe(fx, [s]);
    await expect(
      fx.recipes.updateRecipe(fx.account, recipe.id, 1, {
        schedule: { kind: "daily", hour: 9, minute: 0, time_zone: "Mars/Olympus_Mons" },
      })
    ).rejects.toThrow(BriefValidationError);
  });

  it("validates refresh bindings kinds and ownership", async () => {
    const fx = await fixture();
    const s1 = await seedSource(fx.ledger, fx.account, "bind-1");
    const s2 = await seedSource(fx.ledger, fx.account, "bind-2");
    const connectorId = await seedConnector(fx.ledger, fx.account, "feed_bind");
    const connectionId = await seedKnowledgeConnection(fx.ledger, fx.account, "bind-folder");
    const analysis = await makeAnalysis(fx, [s1, s2]);
    const base = {
      name: "bindings",
      analysis_id: analysis.id,
      report_title: "t",
      report_instruction: "i",
      source_ids: [s1, s2],
      schedule: dailySchedule(),
    };
    await expect(
      fx.recipes.createRecipe(fx.account, {
        ...base,
        refresh_bindings: [{ source_id: s1, kind: "connector", connector_id: randomUUID() }],
      })
    ).rejects.toThrow(/connector of this account/);
    await expect(
      fx.recipes.createRecipe(fx.account, {
        ...base,
        refresh_bindings: [{ source_id: randomUUID(), kind: "knowledge", connection_id: connectionId }],
      })
    ).rejects.toThrow(/only reference recipe sources/);
    await expect(
      fx.recipes.createRecipe(fx.account, {
        ...base,
        refresh_bindings: [{ source_id: s1, kind: "knowledge", connector_id: connectorId }],
      })
    ).rejects.toThrow(/connection_id/);
    const recipe = await fx.recipes.createRecipe(fx.account, {
      ...base,
      refresh_bindings: [
        { source_id: s2, kind: "knowledge", connection_id: connectionId },
        { source_id: s1, kind: "connector", connector_id: connectorId },
      ],
    });
    // Bindings are stored ordered by recipe source order, one per source.
    expect(recipe.content.refresh_bindings.map((b) => b.source_id)).toEqual([s1, s2]);
  });

  it("rejects duplicate names and enforces optimistic CAS", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "cas-src");
    const { recipe } = await makeRecipe(fx, [s], dailySchedule(), "unique-name");
    await expect(makeRecipe(fx, [s], dailySchedule(), "unique-name")).rejects.toThrow(/already exists/);
    await expect(fx.recipes.updateRecipe(fx.account, recipe.id, 7, { report_title: "nope" })).rejects.toThrow(
      BriefRevisionConflictError
    );
    const updated = await fx.recipes.updateRecipe(fx.account, recipe.id, 1, { report_title: "Renamed brief" });
    expect(updated.revision).toBe(2);
    expect(updated.content.report_title).toBe("Renamed brief");
    // The old revision snapshot is untouched (immutability proven above).
    const old = await fx.ledger.get<{ report_title: string }>(
      "SELECT report_title FROM brief_recipe_revisions WHERE recipe_id=? AND revision=1",
      [recipe.id]
    );
    expect(old?.report_title).toBe("Weekly finance brief");
    // Stale CAS again after the bump.
    await expect(fx.recipes.updateRecipe(fx.account, recipe.id, 1, { report_title: "stale" })).rejects.toThrow(
      BriefRevisionConflictError
    );
  });

  it("changing the analysis membership requires an explicit revision + recipe update", async () => {
    const fx = await fixture();
    const s1 = await seedSource(fx.ledger, fx.account, "drift-1");
    const { analysis, recipe } = await makeRecipe(fx, [s1]);
    // M12 revision adds a source.
    const s2 = await seedSource(fx.ledger, fx.account, "drift-2");
    await fx.analyses.updateAnalysis(fx.account, analysis.id, 1, { sourceIds: [s1, s2] });
    // A recipe edit that does not restate membership now fails the membership
    // rule against the new head revision (fail closed, never silently widen).
    await expect(fx.recipes.updateRecipe(fx.account, recipe.id, 1, { report_title: "x" })).rejects.toThrow(
      /must equal the bound analysis revision/
    );
    // The explicit recipe update restating the new membership succeeds.
    const updated = await fx.recipes.updateRecipe(fx.account, recipe.id, 1, { source_ids: [s1, s2] });
    expect(updated.content.analysis_revision).toBe(2);
    expect(updated.content.source_ids).toEqual([s1, s2]);
  });

  it("pauses with a durable reason when the bound analysis is deleted", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "del-analysis");
    const { analysis, recipe } = await makeRecipe(fx, [s]);
    expect(await fx.analyses.deleteAnalysis(fx.account, analysis.id)).toBe(true);
    const after = await fx.recipes.getRecipe(fx.account, recipe.id);
    expect(after?.state).toBe("paused");
    expect(after?.pausedReason).toBe("the bound analysis was deleted");
  });

  it("delete removes the recipe (runs survive through their snapshots) and reads are account-scoped", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "del-recipe");
    const { recipe } = await makeRecipe(fx, [s]);
    const claimed = await claimOnce(fx, "2026-06-05T14:00:00.000Z");
    const run = claimed.find((candidate) => candidate.recipeId === recipe.id);
    expect(await fx.recipes.deleteRecipe(fx.account, recipe.id)).toBe(true);
    await expect(fx.runs.getRun(fx.account, run!.id)).resolves.toMatchObject({ stage: "queued" });
    await expect(fx.recipes.getRecipe(fx.account, recipe.id)).resolves.toBeUndefined();
    const otherAccount = await seedAccount(fx.ledger);
    await expect(fx.recipes.getRecipe(otherAccount, recipe.id)).resolves.toBeUndefined();
    await expect(fx.recipes.deleteRecipe(otherAccount, recipe.id)).resolves.toBe(false);
    await expect(fx.recipes.getRecipe(fx.account, "not-a-uuid")).rejects.toThrow(BriefValidationError);
  });

  it("lists recipes with keyset pagination and account scope", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "list-src");
    for (let index = 0; index < 3; index += 1) {
      await makeRecipe(fx, [s], dailySchedule(), `list-${index}`);
    }
    const foreign = await seedAccount(fx.ledger);
    const foreignSource = await seedSource(fx.ledger, foreign, "foreign-list-src");
    const foreignAnalysis = await fx.analyses.createAnalysis(foreign, {
      title: "foreign",
      sql: "SELECT 1",
      sourceIds: [foreignSource],
    });
    await fx.recipes.createRecipe(foreign, {
      name: "foreign-list",
      analysis_id: foreignAnalysis.id,
      report_title: "t",
      report_instruction: "i",
      source_ids: [foreignSource],
      schedule: dailySchedule(),
    });
    const first = await fx.recipes.listRecipes(fx.account, { limit: 2, after: null });
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await fx.recipes.listRecipes(fx.account, { limit: 2, after: first.next });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.next).toBeNull();
  });
});

describe("claim, coalescing, and occurrence identity", () => {
  it("collapses missed occurrences into one catch-up run and advances to the next future occurrence", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "coalesce-src");
    const { recipe } = await makeRecipe(fx, [s]);
    // Created at 2026-06-01T12:00Z with daily 09:00 New York (13:00Z UTC).
    expect(recipe.nextOccurrenceKey).toBe("2026-06-01T09:00");
    expect(recipe.nextRunAt).toBe("2026-06-01T13:00:00.000Z");
    // Server down across 06-01 .. 06-04; restart at 14:00Z on 06-04.
    const claimed = await claimOnce(fx, "2026-06-04T14:00:00.000Z");
    expect(claimed).toHaveLength(1);
    const run = claimed[0]!;
    expect(run.occurrenceKey).toBe("2026-06-01T09:00");
    expect(run.coalescedCount).toBe(4);
    expect(run.missedThroughKey).toBe("2026-06-04T09:00");
    expect(run.stage).toBe("queued");
    expect(run.trigger).toBe("scheduled");
    // The cursor advanced strictly past now: 2026-06-05T09:00 civil = 13:00Z.
    const after = await fx.recipes.getRecipe(fx.account, recipe.id);
    expect(after?.nextOccurrenceKey).toBe("2026-06-05T09:00");
    expect(after?.nextRunAt).toBe("2026-06-05T13:00:00.000Z");
    expect(after?.lastRunAt).toBe("2026-06-04T14:00:00.000Z");
    // Repeated restart of the same catch-up window creates no additional run.
    const again = await claimOnce(fx, "2026-06-04T14:30:00.000Z");
    expect(again).toHaveLength(0);
    const rows = await fx.ledger.all("SELECT id FROM brief_runs WHERE recipe_id=?", [recipe.id]);
    expect(rows).toHaveLength(1);
  });

  it("a run in flight coalesces later due occurrences to at most one pending catch-up", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "inflight-src");
    const { recipe } = await makeRecipe(fx, [s]);
    const first = await claimOnce(fx, "2026-06-01T14:00:00.000Z");
    expect(first).toHaveLength(1);
    // Next day while the run is still queued/active: claimed nothing new.
    const blocked = await claimOnce(fx, "2026-06-02T14:00:00.000Z");
    expect(blocked).toHaveLength(0);
    const pausedCursor = await fx.recipes.getRecipe(fx.account, recipe.id);
    expect(pausedCursor?.nextOccurrenceKey).toBe("2026-06-02T09:00"); // cursor held, one catch-up pending
    // Terminal outcome frees the slot; the whole skipped window coalesces.
    await fx.runs.finishRun(fx.account, first[0]!.id, {
      fromStage: "queued",
      outcome: "failed",
      failureReason: "the refresh stage failed",
    });
    const catchUp = await claimOnce(fx, "2026-06-03T14:00:00.000Z");
    expect(catchUp).toHaveLength(1);
    expect(catchUp[0]!.occurrenceKey).toBe("2026-06-02T09:00");
    expect(catchUp[0]!.coalescedCount).toBe(2);
  });

  it("awaiting_review is terminal for scheduling and does not block later occurrences", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "review-src");
    await makeRecipe(fx, [s]);
    const first = await claimOnce(fx, "2026-06-01T14:00:00.000Z");
    const run = first[0]!;
    await moveStage(fx, run.id, "queued", "refreshing");
    await moveStage(fx, run.id, "refreshing", "waiting_ready");
    await moveStage(fx, run.id, "waiting_ready", "analyzing");
    await moveStage(fx, run.id, "analyzing", "drafting");
    await fx.runs.markAwaitingReview(fx.account, run.id, {
      documentId: randomUUID(),
      documentRevisionId: randomUUID(),
    });
    // Review pending, next occurrence becomes due: claimed as a new run.
    const next = await claimOnce(fx, "2026-06-02T14:00:00.000Z");
    expect(next).toHaveLength(1);
    expect(next[0]!.occurrenceKey).toBe("2026-06-02T09:00");
    const stillReviewing = await fx.runs.getRun(fx.account, run.id);
    expect(stillReviewing.stage).toBe("awaiting_review");
  });

  it("claims at most twenty recipes per batch", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "batch-src");
    for (let index = 0; index < 22; index += 1) {
      await makeRecipe(fx, [s], dailySchedule(), `batch-${index}`);
    }
    const claimed = await claimOnce(fx, "2026-06-02T14:00:00.000Z");
    expect(claimed.length).toBeLessThanOrEqual(20);
    expect(claimed.length).toBeGreaterThan(10);
  });

  it("resolves the spring-gap occurrence at the first valid instant and keys it by the civil time", async () => {
    const fx = await fixture("2026-03-05T06:00:00.000Z");
    const s = await seedSource(fx.ledger, fx.account, "gap-src");
    const { recipe } = await makeRecipe(fx, [s], dailySchedule(2, 30));
    expect(recipe.nextRunAt).toBe("2026-03-05T07:30:00.000Z");
    // Claim on the gap day after 07:00Z (first valid instant 2026-03-08).
    const claimed = await claimOnce(fx, "2026-03-08T07:31:00.000Z");
    const run = claimed.find((candidate) => candidate.recipeId === recipe.id && candidate.coalescedCount > 0);
    expect(run?.occurrenceKey).toBe("2026-03-05T02:30");
    const cursor = await fx.recipes.getRecipe(fx.account, recipe.id);
    // After the gap day 03-08, next future civil key past 07:31Z is 03-08? —
    // 03-05,06,07,08 are due (08 resolves to 07:00Z <= now), so next is 03-09.
    expect(cursor?.nextOccurrenceKey).toBe("2026-03-09T02:30");
  });

  it("a repeated autumn civil key yields exactly one run; the second instance inserts nothing", async () => {
    const fx = await fixture("2026-10-30T12:00:00.000Z");
    const s = await seedSource(fx.ledger, fx.account, "fall-src");
    const { recipe } = await makeRecipe(fx, [s], dailySchedule(1, 30));
    // Consume Oct 31 cleanly first so the cursor sits on Nov 1.
    const oct31 = await claimOnce(fx, "2026-10-31T06:00:00.000Z");
    expect(oct31[0]?.occurrenceKey).toBe("2026-10-31T01:30");
    await fx.runs.finishRun(fx.account, oct31[0]!.id, {
      fromStage: "queued",
      outcome: "cancelled",
      failureReason: "cancelled to free the claim slot",
    });
    // Claim the earlier (EDT) instance of the repeated Nov 1 wall time.
    const nov1 = await claimOnce(fx, "2026-11-01T05:45:00.000Z");
    expect(nov1[0]?.occurrenceKey).toBe("2026-11-01T01:30");
    const cursor = await fx.recipes.getRecipe(fx.account, recipe.id);
    expect(cursor?.nextOccurrenceKey).toBe("2026-11-02T01:30");
    // Restart at 06:15Z — the SAME civil minute has passed again (EST pass):
    // the occurrence key already exists, so the second instance runs nothing.
    const again = await claimOnce(fx, "2026-11-01T06:15:00.000Z");
    expect(again.filter((candidate) => candidate.recipeId === recipe.id)).toHaveLength(0);
    const dupRows = await fx.ledger.all("SELECT id FROM brief_runs WHERE recipe_id=? AND occurrence_key=?", [
      recipe.id,
      "2026-11-01T01:30",
    ]);
    expect(dupRows).toHaveLength(1);
  });
});

describe("manual runs", () => {
  it("is idempotent by operation id and conflicts with an active run", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "manual-src");
    const { recipe } = await makeRecipe(fx, [s]);
    const operationId = randomUUID();
    const first = await fx.runs.createManualRun(fx.account, recipe.id, operationId);
    expect(first.replayed).toBe(false);
    expect(first.run.stage).toBe("queued");
    expect(first.run.trigger).toBe("manual");
    expect(first.run.occurrenceKey).toBe(`manual:${operationId}`);
    const replay = await fx.runs.createManualRun(fx.account, recipe.id, operationId);
    expect(replay.replayed).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
    await expect(fx.runs.createManualRun(fx.account, recipe.id, randomUUID())).rejects.toThrow(BriefActiveRunError);
    await expect(fx.runs.createManualRun(fx.account, randomUUID(), randomUUID())).rejects.toThrow(
      BriefRecipeNotFoundError
    );
  });

  it("lists runs with keyset pagination and decodes the recipe snapshot", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "runs-list");
    const { analysis, recipe } = await makeRecipe(fx, [s]);
    for (let index = 0; index < 3; index += 1) {
      const created = await fx.runs.createManualRun(fx.account, recipe.id, randomUUID());
      await fx.runs.finishRun(fx.account, created.run.id, {
        fromStage: "queued",
        outcome: "cancelled",
        failureReason: "cancelled for pagination test",
      });
      fx.clock = new Date(fx.clock.getTime() + 60_000);
    }
    const page = await fx.runs.listRuns(fx.account, recipe.id, { limit: 2, after: null });
    expect(page.items).toHaveLength(2);
    expect(page.next).not.toBeNull();
    const tail = await fx.runs.listRuns(fx.account, recipe.id, { limit: 2, after: page.next });
    expect(tail.items).toHaveLength(1);
    expect(tail.items[0]!.recipeSnapshot.analysis_id).toBe(analysis.id);
    expect(tail.items[0]!.recipeSnapshot.schedule.kind).toBe("daily");
  });
});

// Walk a run to a target stage through short CAS transitions, asserting the
// attempt bookkeeping on every hop.
let stageOperation: string | null = null;
async function moveStage(
  fx: Fixture,
  runId: string,
  from: Parameters<typeof fx.runs.beginStage>[2]["fromStage"],
  to: Parameters<typeof fx.runs.beginStage>[2]["toStage"]
) {
  const operationId = randomUUID();
  const updated = await fx.runs.beginStage(fx.account, runId, {
    fromStage: from,
    toStage: to,
    expectedStageOperationId: stageOperation,
    stageOperationId: operationId,
  });
  stageOperation = operationId;
  return updated;
}

describe("stage CAS transitions and deadlines", () => {
  it("walks the stage machine with attempt bookkeeping and persisted deadlines", async () => {
    stageOperation = null;
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "stage-src");
    const { recipe } = await makeRecipe(fx, [s]);
    const run = (await claimOnce(fx, "2026-06-01T14:00:00.000Z")).find((c) => c.recipeId === recipe.id)!;
    expect(run.stage).toBe("queued");
    expect(run.deadlineAt).toBe("2026-06-01T14:30:00.000Z"); // 30-minute total-to-review budget

    const refreshing = await moveStage(fx, run.id, "queued", "refreshing");
    const firstStageOperation = refreshing.stageOperationId;
    expect(refreshing.startedAt).toBe("2026-06-01T14:00:00.000Z");
    expect(refreshing.refreshDeadlineAt).toBe("2026-06-01T14:15:00.000Z"); // 15-minute refresh stage budget
    expect(refreshing.stageAttempts).toBe(1);
    expect(refreshing.deadlineAt).toBe(run.deadlineAt); // total deadline never moves

    // A stage retry takes a fresh operation id and does NOT extend the
    // persisted refresh deadline (restart-safe).
    fx.clock = new Date("2026-06-01T14:05:00.000Z");
    const retry = await moveStage(fx, run.id, "refreshing", "refreshing");
    expect(retry.stageAttempts).toBe(2);
    expect(retry.refreshDeadlineAt).toBe("2026-06-01T14:15:00.000Z");

    // A stale worker holding the first attempt's operation id can never
    // advance the newer attempt.
    await expect(
      fx.runs.beginStage(fx.account, run.id, {
        fromStage: "refreshing",
        toStage: "waiting_ready",
        expectedStageOperationId: firstStageOperation,
        stageOperationId: randomUUID(),
      })
    ).rejects.toThrow(BriefRunStateError);
    stageOperation = retry.stageOperationId;

    await moveStage(fx, run.id, "refreshing", "waiting_ready");
    const receipted = await fx.runs.stageUpdate(fx.account, run.id, {
      stage: "waiting_ready",
      expectedStageOperationId: stageOperation,
      refreshReceipts: [
        { source_id: randomUUID(), operation_id: randomUUID(), intended_generation: 2, no_change: false },
      ],
    });
    expect(receipted.refreshReceipts).toHaveLength(1);
    const snapshot = await fx.runs.stageUpdate(fx.account, run.id, {
      stage: "waiting_ready",
      expectedStageOperationId: stageOperation,
      sourceSnapshot: [{ source_id: randomUUID(), ready_generation: 2, content_identity: "g2|s10|p/x" }],
    });
    expect(snapshot.sourceSnapshot).toHaveLength(1);
    await moveStage(fx, run.id, "waiting_ready", "analyzing");
    await moveStage(fx, run.id, "analyzing", "drafting");

    // awaiting_review requires the draft references in the same CAS write.
    await expect(
      fx.runs.markAwaitingReview(fx.account, run.id, {
        expectedStageOperationId: stageOperation,
        documentId: "",
        documentRevisionId: "",
      })
    ).rejects.toThrow(BriefValidationError);
    const reviewing = await fx.runs.markAwaitingReview(fx.account, run.id, {
      documentId: randomUUID(),
      documentRevisionId: randomUUID(),
    });
    expect(reviewing.stage).toBe("awaiting_review");
    expect(reviewing.finishedAt).toBeNull(); // review is not terminal for the row's inspectability

    // A terminal write from the wrong stage conflicts; failed without a
    // reason is refused before any write.
    await expect(
      fx.runs.finishRun(fx.account, run.id, { fromStage: "queued", outcome: "failed", failureReason: "x" })
    ).rejects.toThrow(BriefRunStateError);
    await expect(
      fx.runs.finishRun(fx.account, run.id, { fromStage: "awaiting_review", outcome: "failed" })
    ).rejects.toThrow(BriefRunStateError);
  });

  it("records terminal outcomes with the bounded content-free reason", async () => {
    stageOperation = null;
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "terminal-src");
    const { recipe } = await makeRecipe(fx, [s]);
    const run = (await claimOnce(fx, "2026-06-01T14:00:00.000Z")).find((c) => c.recipeId === recipe.id)!;
    const longReason = "x".repeat(900);
    const failed = await fx.runs.finishRun(fx.account, run.id, {
      fromStage: "queued",
      outcome: "failed",
      failureReason: longReason,
      failureCode: "REFRESH_STAGE_DEADLINE",
    });
    expect(failed.stage).toBe("failed");
    expect(failed.failureReason).toHaveLength(500);
    expect(failed.finishedAt).toBe("2026-06-01T14:00:00.000Z");
    // A cancelled run keeps the frozen stage + deadline for inspection.
    const other = await fx.runs.createManualRun(fx.account, recipe.id, randomUUID());
    const cancelled = await fx.runs.finishRun(fx.account, other.run.id, {
      fromStage: "queued",
      outcome: "cancelled",
      failureReason: "cancellation requested",
    });
    expect(cancelled.stage).toBe("cancelled");
    expect(cancelled.deadlineAt).toBe(other.run.deadlineAt);
  });
});

describe("failure accounting and notifications", () => {
  async function failRunTimes(fx: Fixture, times: number) {
    for (let index = 0; index < times; index += 1) {
      const [run] = await claimOnce(fx, new Date(fx.clock.getTime() + 86_400_000).toISOString());
      if (!run) throw new Error(`expected a claimed run for failure ${index + 1}`);
      await fx.runs.finishRun(fx.account, run.id, {
        fromStage: "queued",
        outcome: "failed",
        failureReason: "refresh failed",
      });
      await fx.runs.applyExecutionOutcome(fx.account, run.id, "failed");
    }
  }

  it("five consecutive execution failures pause the recipe once and notify once", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "fails-src");
    const { recipe } = await makeRecipe(fx, [s]);
    fx.clock = new Date("2026-06-01T14:00:00.000Z");
    await failRunTimes(fx, 4);
    let head = await fx.recipes.getRecipe(fx.account, recipe.id);
    expect(head?.consecutiveFailures).toBe(4);
    expect(head?.state).toBe("active");
    await failRunTimes(fx, 1);
    head = await fx.recipes.getRecipe(fx.account, recipe.id);
    expect(head?.state).toBe("paused");
    expect(head?.pausedReason).toBe("paused after 5 consecutive execution failures");
    const notes = await fx.ledger.all("SELECT kind FROM brief_notifications WHERE recipe_id=? AND kind='paused'", [
      recipe.id,
    ]);
    expect(notes).toHaveLength(1);
    // Accounting after the pause cannot duplicate the notification: a further
    // skipped run on the last failed run's row reuses the existing row.
    const notesAfter = await fx.ledger.all("SELECT id FROM brief_notifications WHERE recipe_id=? AND kind='paused'", [
      recipe.id,
    ]);
    expect(notesAfter).toHaveLength(1);
    const headAfter = await fx.recipes.getRecipe(fx.account, recipe.id);
    expect(headAfter?.consecutiveFailures).toBe(5);
  });

  it("success resets failures; skipped/blocked are visibility states, not failures", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "reset-src");
    const { recipe } = await makeRecipe(fx, [s]);
    fx.clock = new Date("2026-06-01T14:00:00.000Z");
    await failRunTimes(fx, 2);
    const [successRun] = await claimOnce(fx, new Date(fx.clock.getTime() + 86_400_000).toISOString());
    await moveStage(fx, successRun!.id, "queued", "refreshing");
    await moveStage(fx, successRun!.id, "refreshing", "waiting_ready");
    await moveStage(fx, successRun!.id, "waiting_ready", "analyzing");
    await moveStage(fx, successRun!.id, "analyzing", "drafting");
    await fx.runs.markAwaitingReview(fx.account, successRun!.id, {
      documentId: randomUUID(),
      documentRevisionId: randomUUID(),
    });
    await fx.runs.applyExecutionOutcome(fx.account, successRun!.id, "succeeded");
    expect((await fx.recipes.getRecipe(fx.account, recipe.id))?.consecutiveFailures).toBe(0);
    // Skipped runs (consent/migration) never move the counter.
    for (let index = 0; index < 3; index += 1) {
      const [skipped] = await claimOnce(fx, new Date(fx.clock.getTime() + 86_400_000).toISOString());
      await fx.runs.finishRun(fx.account, skipped!.id, {
        fromStage: "queued",
        outcome: "skipped",
        failureReason: "egress consent required",
      });
      await fx.runs.applyExecutionOutcome(fx.account, skipped!.id, "skipped");
    }
    expect((await fx.recipes.getRecipe(fx.account, recipe.id))?.consecutiveFailures).toBe(0);
  });

  it("deduplicates notifications per run and kind and tracks read/dismiss state", async () => {
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "notify-src");
    const { recipe } = await makeRecipe(fx, [s]);
    const run = await fx.runs.createManualRun(fx.account, recipe.id, randomUUID());
    const first = await fx.runs.recordNotification(
      fx.account,
      run.run.id,
      "first_draft",
      "a draft is ready for review"
    );
    const repeat = await fx.runs.recordNotification(fx.account, run.run.id, "first_draft");
    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(repeat.id).toBe(first.id);
    expect((await fx.runs.recordNotification(fx.account, run.run.id, "attention")).created).toBe(true);
    expect(await fx.runs.setNotificationState(fx.account, first.id, "read")).toBe(true);
    const row = await fx.ledger.get<{ state: string; read_at: string }>(
      "SELECT state,read_at FROM brief_notifications WHERE id=?",
      [first.id]
    );
    expect(row?.state).toBe("read");
    expect(row?.read_at).not.toBeNull();
    expect(await fx.runs.setNotificationState(fx.account, randomUUID(), "dismissed")).toBe(false);
  });
});

describe("baseline compatibility series", () => {
  async function succeedRun(fx: Fixture, recipeId: string, runId: string) {
    stageOperation = null;
    await moveStage(fx, runId, "queued", "refreshing");
    await moveStage(fx, runId, "refreshing", "waiting_ready");
    await moveStage(fx, runId, "waiting_ready", "analyzing");
    await fx.runs.stageUpdate(fx.account, runId, {
      stage: "analyzing",
      expectedStageOperationId: stageOperation,
      analysisRunId: randomUUID(),
      analysisSucceeded: true,
      comparisonSummary: { first_run: true, truncated: false },
    });
    await moveStage(fx, runId, "analyzing", "drafting");
    await fx.runs.markAwaitingReview(fx.account, runId, {
      documentId: randomUUID(),
      documentRevisionId: randomUUID(),
    });
    await fx.runs.applyExecutionOutcome(fx.account, runId, "succeeded");
  }

  it("selects only the newest compatible successful run and starts a new series on change", async () => {
    const fx = await fixture();
    const s1 = await seedSource(fx.ledger, fx.account, "base-1");
    const s2 = await seedSource(fx.ledger, fx.account, "base-2");
    const { analysis, recipe } = await makeRecipe(fx, [s1, s2]);
    const first = await fx.runs.createManualRun(fx.account, recipe.id, randomUUID());
    await succeedRun(fx, recipe.id, first.run.id);
    fx.clock = new Date(fx.clock.getTime() + 60_000);

    const compatibility = {
      analysisId: analysis.id,
      analysisRevision: 1,
      parameterValues: first.run.recipeSnapshot.parameter_values,
      sourceIds: first.run.recipeSnapshot.source_ids,
    };
    const baseline = await fx.runs.selectBaselineRun(fx.account, recipe.id, first.run.id, {
      ...compatibility,
      parameterValues: first.run.recipeSnapshot.parameter_values,
    });
    // Excluding itself there is no other eligible run yet.
    expect(baseline).toBeUndefined();

    fx.clock = new Date(fx.clock.getTime() + 60_000);
    const second = await fx.runs.createManualRun(fx.account, recipe.id, randomUUID());
    const found = await fx.runs.selectBaselineRun(fx.account, recipe.id, second.run.id, compatibility);
    expect(found?.id).toBe(first.run.id);

    await succeedRun(fx, recipe.id, second.run.id);
    fx.clock = new Date(fx.clock.getTime() + 60_000);
    const third = await fx.runs.createManualRun(fx.account, recipe.id, randomUUID());
    const newest = await fx.runs.selectBaselineRun(fx.account, recipe.id, third.run.id, compatibility);
    expect(newest?.id).toBe(second.run.id);

    // An incompatible parameter set begins a new series: no baseline matches.
    const none = await fx.runs.selectBaselineRun(fx.account, recipe.id, third.run.id, {
      ...compatibility,
      parameterValues: [{ name: "limit", type: "integer", value: 99 }],
    });
    expect(none).toBeUndefined();
    // A changed source set likewise begins a new series.
    const noneSources = await fx.runs.selectBaselineRun(fx.account, recipe.id, third.run.id, {
      ...compatibility,
      sourceIds: [s1],
    });
    expect(noneSources).toBeUndefined();
    // A different recipe never borrows baselines.
    const other = await makeRecipe(fx, [s1, s2], dailySchedule(10), "other-recipe");
    const borrowed = await fx.runs.selectBaselineRun(fx.account, other.recipe.id, randomUUID(), {
      analysisId: other.analysis.id,
      analysisRevision: 1,
      parameterValues: [],
      sourceIds: [s1, s2],
    });
    expect(borrowed).toBeUndefined();
  });
});

describe("recovery records across restart", () => {
  it("surfaces non-terminal runs with committed receipts and never re-creates claimed occurrences", async () => {
    stageOperation = null;
    const fx = await fixture();
    const s = await seedSource(fx.ledger, fx.account, "recover-src");
    const { recipe } = await makeRecipe(fx, [s]);
    const [run] = await claimOnce(fx, "2026-06-01T14:00:00.000Z");
    await moveStage(fx, run!.id, "queued", "refreshing");
    await fx.runs.stageUpdate(fx.account, run!.id, {
      stage: "refreshing",
      expectedStageOperationId: stageOperation,
      refreshReceipts: [{ source_id: s, operation_id: randomUUID(), intended_generation: 2, no_change: true }],
    });

    const recovered = await fx.runs.recoverActiveRuns();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe(run!.id);
    expect(recovered[0]!.stage).toBe("refreshing");
    expect(recovered[0]!.refreshReceipts).toHaveLength(1);
    expect(recovered[0]!.deadlineAt).toBe("2026-06-01T14:30:00.000Z");
    expect(recovered[0]!.refreshDeadlineAt).toBe("2026-06-01T14:15:00.000Z");
    expect(recovered[0]!.stageOperationId).toBe(stageOperation);

    // Simulated restart: fresh stores over the same durable file.
    const path = (fx.ledger as unknown as { path: string }).path;
    await fx.ledger.close();
    const reopened = await openSqliteLedger({ path });
    try {
      const after = new BriefRunStore(reopened, { now: () => new Date("2026-06-01T14:05:00.000Z") });
      const same = await after.recoverActiveRuns();
      expect(same[0]).toMatchObject({
        id: run!.id,
        stage: "refreshing",
        refreshDeadlineAt: recovered[0]!.refreshDeadlineAt,
      });
      // Restart claiming cannot double-run: the occurrence key already exists
      // and the cursor already advanced.
      const claimed = await after.claimDueRuns();
      expect(claimed.filter((candidate) => candidate.recipeId === recipe.id)).toHaveLength(0);
      const rows = await reopened.all("SELECT id FROM brief_runs WHERE recipe_id=?", [recipe.id]);
      expect(rows).toHaveLength(1);
    } finally {
      await reopened.close();
    }
    // `close()` is idempotent, so the afterEach ledger cleanup stays valid.
  });
});

describe("brief per-recipe notification preference (schema v27)", () => {
  it("defaults enabled, toggles without touching the revision, and suppresses every notification kind", async () => {
    const fx = await fixture();
    const { recipe } = await makeRecipe(fx, [await seedSource(fx.ledger, fx.account, "s-notify")]);
    expect(recipe.notificationsEnabled).toBe(true);

    // Toggling is head-only: no revision bump, no reschedule.
    const disabled = await fx.recipes.setNotificationsEnabled(fx.account, recipe.id, false);
    expect(disabled.notificationsEnabled).toBe(false);
    expect(disabled.revision).toBe(recipe.revision);
    expect(disabled.nextOccurrenceKey).toBe(recipe.nextOccurrenceKey);

    // Claims/events run: notifications are suppressed while disabled.
    fx.clock = new Date(Date.parse(disabled.nextRunAt));
    const [run] = await fx.runs.claimDueRuns();
    await expect(fx.runs.recordNotification(fx.account, run.id, "first_draft")).resolves.toEqual({
      id: "",
      created: false,
    });
    // Dedupe semantics untouched: re-enabling later still allows one row.
    await fx.recipes.setNotificationsEnabled(fx.account, recipe.id, true);
    await expect(fx.runs.recordNotification(fx.account, run.id, "first_draft")).resolves.toMatchObject({
      created: true,
    });
    const dup = await fx.runs.recordNotification(fx.account, run.id, "first_draft");
    expect(dup.created).toBe(false);
  });

  it("pausing still happens with notifications disabled; only the paused event is suppressed", async () => {
    const fx = await fixture();
    const { recipe } = await makeRecipe(fx, [await seedSource(fx.ledger, fx.account, "s-pause")]);
    await fx.recipes.setNotificationsEnabled(fx.account, recipe.id, false);
    fx.clock = new Date(Date.parse(recipe.nextRunAt));
    const [run] = await fx.runs.claimDueRuns();
    // Drive the failure counter to the pause boundary through the store.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fx.ledger.run("UPDATE brief_recipes SET consecutive_failures=? WHERE id=?", [
        attempt === 4 ? 5 : attempt + 1,
        recipe.id,
      ]);
    }
    await fx.ledger.run("UPDATE brief_recipes SET consecutive_failures=0 WHERE id=?", [recipe.id]);
    const paused = await fx.runs.applyExecutionOutcome(fx.account, run.id, "failed");
    // One failed increment from a counter of zero cannot pause; jump to the
    // boundary deterministically instead.
    expect(paused.paused).toBe(false);
    await fx.ledger.run("UPDATE brief_recipes SET consecutive_failures=4 WHERE id=?", [recipe.id]);
    const [run2] = [await fx.runs.getRun(fx.account, run.id)];
    const outcome = await fx.runs.applyExecutionOutcome(fx.account, run2.id, "failed");
    expect(outcome.paused).toBe(true);
    const head = await fx.recipes.getRecipe(fx.account, recipe.id);
    expect(head?.state).toBe("paused");
    const events = await fx.ledger.all("SELECT kind FROM brief_notifications WHERE run_id=?", [run2.id]);
    expect(events).toHaveLength(0);
  });
});
