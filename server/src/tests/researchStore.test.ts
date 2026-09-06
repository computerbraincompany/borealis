import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LATEST_SQLITE_SCHEMA_VERSION, SCHEMA_V25 } from "../db/migrations.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  ResearchActiveRunError,
  ResearchClaimCapError,
  ResearchEvidenceCapError,
  ResearchEvidenceRefError,
  ResearchInputsNotReadyError,
  ResearchNotFoundError,
  ResearchQueueFullError,
  ResearchRevisionConflictError,
  ResearchRunStateError,
  ResearchScopeEmptyError,
  ResearchStore,
  ResearchTableLimitError,
  type ResearchStoreOptions,
} from "../db/stores/researchStore.js";
import type { SqliteLedger } from "../db/types.js";
import {
  classifyResearchCellPayload,
  RESEARCH_EVIDENCE_MAX,
  ResearchValidationError,
  validateResearchTypedValue,
  type ResearchColumnDeclaration,
} from "../researchSchemas.js";
import {
  createHistoricalSqliteFixture,
  expectedFixtureVersions,
  PENDING_MERGE_SCHEMA_VERSIONS,
} from "./sqliteMigrationFixture.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];
const extraLedgers: SqliteLedger[] = [];
let clock = Date.parse("2026-09-06T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(extraLedgers.splice(0).map((ledger) => ledger.close()));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function setup(options: ResearchStoreOptions = {}): Promise<{
  ledger: SqliteLedger;
  store: ResearchStore;
  filename: string;
}> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const now = options.now ?? (() => new Date((clock += 1_000)));
  return { ledger: resource.ledger, store: new ResearchStore(resource.ledger, { now }), filename: resource.filename };
}

async function secondStore(filename: string): Promise<ResearchStore> {
  const ledger = await openSqliteLedger({ path: filename });
  extraLedgers.push(ledger);
  return new ResearchStore(ledger);
}

async function insertUser(ledger: SqliteLedger, label: string): Promise<string> {
  const id = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    id,
    `${label}-${id}@example.test`,
    "test-hash",
  ]);
  return id;
}

interface SourceSpec {
  status?: "ready" | "index" | "error";
  readyGeneration?: number | null;
}

async function insertSource(ledger: SqliteLedger, accountId: string, spec: SourceSpec = {}): Promise<string> {
  const id = randomUUID();
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,status,meta,ready_generation,size_bytes)
     VALUES (?,?,?,'document',?,?,?,?,?,?)`,
    [
      id,
      accountId,
      `src-${id.slice(0, 8)}`,
      `${id.slice(0, 8)}.md`,
      `/data/${id}/doc.md`,
      spec.status ?? "ready",
      "{}",
      spec.readyGeneration === undefined ? 3 : spec.readyGeneration,
      128,
    ]
  );
  return id;
}

function column(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    label: "Price",
    question: "What is the quoted price?",
    type: "number",
    unit: "USD",
    choices: null,
    ...overrides,
  };
}

function definitionInput(sourceIds: readonly string[], extra: Record<string, unknown> = {}) {
  return {
    title: "Supplier diligence",
    question: "Which supplier offers the best renewal terms?",
    output_kind: "memo" as const,
    source_ids: sourceIds,
    chat_model: "test-chat-model",
    ...extra,
  };
}

const AUTHORIZATION = Object.freeze({
  providerOrigin: "http://127.0.0.1:1234",
  providerLocality: "local" as const,
  providerRevision: 4,
});

async function createReadyDefinition(store: ResearchStore, ledger: SqliteLedger, account: string) {
  const source = await insertSource(ledger, account, { readyGeneration: 7 });
  const definition = await store.createResearchDefinition(account, definitionInput([source]));
  return { definition, source };
}

async function startRunningRun(store: ResearchStore, ledger: SqliteLedger, account: string) {
  const { definition, source } = await createReadyDefinition(store, ledger, account);
  const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
  const running = await store.markResearchRunRunning(account, run.id);
  return { definition, source, run: running };
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function captureEvidence(
  store: ResearchStore,
  account: string,
  runId: string,
  sourceId: string,
  excerpt: string,
  chunkId = randomUUID()
) {
  return store.insertResearchEvidence(account, runId, {
    sourceId,
    generation: 7,
    chunkId,
    label: "proposal.md",
    locators: [{ kind: "text_span", char_start: 0, char_len: excerpt.length }],
    excerpt,
    contentHash: hashOf(excerpt),
    stepOrdinal: 0,
    query: "renewal terms",
  });
}

async function comparisonRun(store: ResearchStore, ledger: SqliteLedger, account: string, columns: readonly Record<string, unknown>[]) {
  const source = await insertSource(ledger, account, { readyGeneration: 7 });
  const definition = await store.createResearchDefinition(
    account,
    definitionInput([source], { output_kind: "comparison", columns })
  );
  const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
  await store.markResearchRunRunning(account, run.id);
  const stored = await store.getResearchDefinition(account, definition.id);
  return { source, definition, run, columns: stored!.revision.columns };
}

describe("research schema", () => {
  it("ships a byte-identical v025 fixture and upgrades a seeded historical installation", async () => {
    expect(expectedFixtureVersions()).toEqual(
      Array.from({ length: LATEST_SQLITE_SCHEMA_VERSION }, (_, index) => index + 1).filter(
        (version) => !PENDING_MERGE_SCHEMA_VERSIONS.includes(version)
      )
    );
    const fixtureSql = await fs.readFile(
      fileURLToPath(new URL("./fixtures/sqlite/v025.sql", import.meta.url)),
      "utf8"
    );
    expect(fixtureSql).toBe(SCHEMA_V25);

    const historical = await createHistoricalSqliteFixture(16);
    try {
      const ledger = await openSqliteLedger({ path: historical.filename });
      try {
        await expect(ledger.get<{ user_version: bigint }>("PRAGMA user_version")).resolves.toEqual({
          user_version: BigInt(LATEST_SQLITE_SCHEMA_VERSION),
        });
        await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
        const store = new ResearchStore(ledger);
        // Selected-empty is a legal stored draft on an upgraded workspace.
        const definition = await store.createResearchDefinition(historical.seed.accountId, definitionInput([]));
        expect(definition.currentRevision).toBe(1);
      } finally {
        await ledger.close();
      }
    } finally {
      await historical.cleanup();
    }
  });

  it("keeps machine cells, definition revisions, and review rows UPDATE-immutable", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "immutable");
    const { source, run, columns } = await comparisonRun(store, ledger, account, [column()]);
    await store.recordResearchMachineCell(account, run.id, {
      columnId: columns[0]!.id,
      rowSourceId: source,
      rawValue: 42,
    });
    await expect(
      ledger.run(
        "UPDATE research_table_cells SET value='99' WHERE run_id=? AND column_id=? AND origin='machine'",
        [run.id, columns[0]!.id]
      )
    ).rejects.toThrow(/constraint violated/i);

    await expect(
      ledger.run(
        "UPDATE research_definition_revisions SET question='x' WHERE definition_id=? AND revision=1",
        [run.definitionId]
      )
    ).rejects.toThrow(/constraint violated/i);

    await store.finishResearchRun(account, run.id, "needs_review");
    const claim = await store.addResearchClaim(account, run.id, {
      kind: "claim",
      text: "Quoted price is 42.",
      classification: "supported",
    });
    await store.applyResearchReviewOps(account, run.id, 1, [{ op: "accept_claim", claim_id: claim.id }]);
    await expect(
      ledger.run("UPDATE research_reviews SET op='reject_claim' WHERE run_id=? AND seq=1", [run.id])
    ).rejects.toThrow(/constraint violated/i);
    void source;
  });
});

describe("ResearchStore definitions", () => {
  it("creates owned drafts, allows selected-empty, and refuses foreign source ids", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const foreign = await insertUser(ledger, "foreign");
    const owned = await insertSource(ledger, account);
    const foreignSource = await insertSource(ledger, foreign);

    const draft = await store.createResearchDefinition(account, definitionInput([]));
    expect(draft.revision.sourceIds).toEqual([]);
    expect(draft.activeRun).toBeNull();

    const created = await store.createResearchDefinition(account, definitionInput([owned]));
    expect(created.sources).toEqual([{ sourceId: owned, availability: "ready", readyGeneration: 3 }]);

    await expect(store.createResearchDefinition(account, definitionInput([foreignSource]))).rejects.toBeInstanceOf(
      ResearchNotFoundError
    );
    // Comparison requires columns; memo forbids them.
    await expect(
      store.createResearchDefinition(account, definitionInput([owned], { output_kind: "comparison" }))
    ).rejects.toBeInstanceOf(ResearchValidationError);
    await expect(
      store.createResearchDefinition(account, definitionInput([owned], { columns: [column()] }))
    ).rejects.toBeInstanceOf(ResearchValidationError);
    // Enum columns require exact choices; non-enum columns forbid them.
    await expect(
      store.createResearchDefinition(
        account,
        definitionInput([owned], { output_kind: "comparison", columns: [column({ type: "enum" })] })
      )
    ).rejects.toBeInstanceOf(ResearchValidationError);
    await expect(
      store.createResearchDefinition(
        account,
        definitionInput([owned], {
          output_kind: "comparison",
          columns: [column({ type: "enum", choices: ["basic", "pro"] })],
        })
      )
    ).resolves.toMatchObject({ currentRevision: 1 });
  });

  it("edits through head CAS, appends immutable revisions, and refuses stale races", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "cas");
    const first = await insertSource(ledger, account);
    const second = await insertSource(ledger, account);
    const definition = await store.createResearchDefinition(account, definitionInput([first]));

    const updated = await store.updateResearchDefinition(account, definition.id, 1, {
      question: "Revised question",
      source_ids: [first, second],
    });
    expect(updated.currentRevision).toBe(2);
    expect(updated.revision.question).toBe("Revised question");
    expect(updated.revision.sourceIds).toEqual([first, second]);
    // An optimistic store may only rewrite the HEAD, so a stale race from a
    // rival connection fails closed and writes nothing.
    const rival = await secondStore(ledger.path);
    await expect(rival.updateResearchDefinition(account, definition.id, 1, { title: "Stale" })).rejects.toBeInstanceOf(
      ResearchRevisionConflictError
    );
    expect((await store.getResearchDefinition(account, definition.id))?.revision.title).toBe("Supplier diligence");

    // Another account cannot read or edit it.
    const other = await insertUser(ledger, "other");
    await expect(store.getResearchDefinition(other, definition.id)).resolves.toBeUndefined();
    await expect(store.updateResearchDefinition(other, definition.id, 2, { title: "Nope" })).rejects.toBeInstanceOf(
      ResearchNotFoundError
    );
  });

  it("refuses deletion while a run is active and allows it once work terminates", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "delete");
    const { definition } = await createReadyDefinition(store, ledger, account);
    const queued = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });

    const active = await store
      .deleteResearchDefinition(account, definition.id)
      .catch((cause) => cause);
    expect(active).toBeInstanceOf(ResearchActiveRunError);
    expect((active as ResearchActiveRunError).existingRunId).toBe(queued.id);

    // A queued run with no dispatched executor cancels immediately, and the
    // owned deletion then cascades run history.
    expect(await store.requestResearchRunCancel(account, queued.id)).toBe("cancelled");
    expect(await store.deleteResearchDefinition(account, definition.id)).toBe(true);
    await expect(store.getResearchDefinition(account, definition.id)).resolves.toBeUndefined();
    expect((await store.listResearchRuns(account, definition.id)).items).toEqual([]);
  });

  it("keeps refusing deletion while an executor has not drained a running run", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "active");
    const { definition, run } = await startRunningRun(store, ledger, account);
    // Cancellation records the durable request as `cancelling`; the durable
    // active state keeps refusing deletion until the executor settles it.
    expect(await store.requestResearchRunCancel(account, run.id)).toBe("cancelling");
    await expect(store.deleteResearchDefinition(account, definition.id)).rejects.toBeInstanceOf(
      ResearchActiveRunError
    );
    expect(await store.finishResearchRun(account, run.id, "failed")).toBe("cancelled");
    expect(await store.deleteResearchDefinition(account, definition.id)).toBe(true);
  });

  it("starts a run only with ready sources: precise conflicts, never silent drops", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "ready");
    const ready = await insertSource(ledger, account, { readyGeneration: 9 });
    const indexing = await insertSource(ledger, account, { status: "index", readyGeneration: null });
    const removed = await insertSource(ledger, account, { readyGeneration: 1 });

    // Creating with an unowned id fails closed (the scope must be owned); a
    // later source deletion is the removed-source Start conflict.
    await expect(
      store.createResearchDefinition(account, definitionInput([ready, randomUUID()]))
    ).rejects.toBeInstanceOf(ResearchNotFoundError);

    const definition = await store.createResearchDefinition(account, definitionInput([ready, indexing, removed]));
    await ledger.run("DELETE FROM sources WHERE id=?", [removed]);
    const error = await store
      .startResearchRun(account, definition.id, { authorization: AUTHORIZATION })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ResearchInputsNotReadyError);
    expect((error as ResearchInputsNotReadyError).unreadySourceIds).toEqual([indexing, removed]);

    const scopeEmpty = await store.createResearchDefinition(account, definitionInput([]));
    await expect(
      store.startResearchRun(account, scopeEmpty.id, { authorization: AUTHORIZATION })
    ).rejects.toBeInstanceOf(ResearchScopeEmptyError);
  });

  it("pins revision, generations, model, provider snapshot, and budgets atomically", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "pin");
    const source = await insertSource(ledger, account, { readyGeneration: 4 });
    const definition = await store.createResearchDefinition(account, definitionInput([source]));

    const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    expect(run.status).toBe("queued");
    expect(run.definitionRevision).toBe(1);
    expect(run.sources).toEqual([{ sourceId: source, generation: 4 }]);
    expect(run.chatModel).toBe("test-chat-model");
    expect(run.providerLocality).toBe("local");
    expect(run.providerRevision).toBe(4);
    expect(run.budgets).toEqual({
      steps: 8,
      searches: 32,
      modelRequests: 40,
      evidence: 100,
      evidenceChars: 200_000,
      wallMs: 900_000,
    });

    // A later refresh and a later definition edit cannot retarget the run.
    await ledger.run("UPDATE sources SET ready_generation=11 WHERE id=?", [source]);
    await store.updateResearchDefinition(account, definition.id, 1, { chat_model: "changed-model" });
    const stored = await store.getResearchRun(account, run.id);
    expect(stored?.sources).toEqual([{ sourceId: source, generation: 4 }]);
    expect(stored?.chatModel).toBe("test-chat-model");
    expect(stored?.definitionRevision).toBe(1);
  });

  it("enforces one active run per definition with the existing run identity, plus the queued cap", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "active-cap");
    const { definition } = await createReadyDefinition(store, ledger, account);
    const first = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    const error = await store
      .startResearchRun(account, definition.id, { authorization: AUTHORIZATION })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ResearchActiveRunError);
    expect((error as ResearchActiveRunError).existingRunId).toBe(first.id);

    // Queued runs of DIFFERENT definitions count toward the 10-queued cap.
    for (let index = 0; index < 8; index += 1) {
      const extra = await createReadyDefinition(store, ledger, account);
      await store.startResearchRun(account, extra.definition.id, { authorization: AUTHORIZATION });
    }
    // Tenth queued run (first + 8 + this) is accepted; the eleventh is refused.
    const lastRoom = await createReadyDefinition(store, ledger, account);
    await store.startResearchRun(account, lastRoom.definition.id, { authorization: AUTHORIZATION });
    const overflow = await createReadyDefinition(store, ledger, account);
    await expect(
      store.startResearchRun(account, overflow.definition.id, { authorization: AUTHORIZATION })
    ).rejects.toBeInstanceOf(ResearchQueueFullError);
  });

  it("honours the expected-revision guard and rejects cross-account starts", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "guard");
    const other = await insertUser(ledger, "intruder");
    const { definition } = await createReadyDefinition(store, ledger, account);
    await store.updateResearchDefinition(account, definition.id, 1, { title: "Renamed" });
    await expect(
      store.startResearchRun(account, definition.id, { expectedRevision: 1, authorization: AUTHORIZATION })
    ).rejects.toBeInstanceOf(ResearchRevisionConflictError);
    await expect(store.startResearchRun(other, definition.id, { authorization: AUTHORIZATION })).rejects.toBeInstanceOf(
      ResearchNotFoundError
    );
  });
});

describe("ResearchStore dossier", () => {
  it("captures immutable evidence and dedupes by run/source/generation/chunk/hash", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "evidence");
    const { definition, source } = await createReadyDefinition(store, ledger, account);
    const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, run.id);

    const stableChunk = randomUUID();
    const first = await captureEvidence(store, account, run.id, source, "Net-30 renewal with a 4% uplift.", stableChunk);
    const again = await captureEvidence(store, account, run.id, source, "Net-30 renewal with a 4% uplift.", stableChunk);
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(first.id);

    const other = await captureEvidence(store, account, run.id, source, "Payment on receipt of invoice.");
    expect(other.deduped).toBe(false);

    const inspection = await store.inspectResearchRun(account, run.id);
    expect(inspection?.counts.evidenceCount).toBe(2);
    expect(inspection?.counts.evidenceCharCount).toBe("Net-30 renewal with a 4% uplift.".length + "Payment on receipt of invoice.".length);

    // Source deletion cannot erase the captured quote (frozen provenance).
    await ledger.run("DELETE FROM sources WHERE id=?", [source]);
    const evidence = await store.listResearchEvidence(account, run.id);
    expect(evidence.items.map((item) => item.excerpt).sort()).toEqual(
      ["Net-30 renewal with a 4% uplift.", "Payment on receipt of invoice."].sort()
    );
  });

  it("refuses evidence outside the frozen generation scope and past the item cap", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "caps");
    const { definition, source } = await createReadyDefinition(store, ledger, account);
    const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, run.id);

    await expect(
      store.insertResearchEvidence(account, run.id, {
        sourceId: source,
        generation: 8, // not the captured generation
        chunkId: randomUUID(),
        label: "x",
        excerpt: "y",
        contentHash: hashOf("y"),
        stepOrdinal: 0,
        query: "q",
      })
    ).rejects.toBeInstanceOf(ResearchRunStateError);

    const chunkOfFirst = randomUUID();
    for (let index = 0; index < RESEARCH_EVIDENCE_MAX; index += 1) {
      await captureEvidence(store, account, run.id, source, `excerpt ${index}`, index === 0 ? chunkOfFirst : randomUUID());
    }
    const overflow = await captureEvidence(store, account, run.id, source, "overflow").catch((cause) => cause);
    expect(overflow).toBeInstanceOf(ResearchEvidenceCapError);
    // A deduped re-capture at the cap is always allowed and counts nothing.
    const deduped = await captureEvidence(store, account, run.id, source, "excerpt 0", chunkOfFirst);
    expect(deduped.deduped).toBe(true);
  });

  it("records claims/gaps with FK-checked evidence refs, conflicting minimums, and per-run caps", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "claims");
    const { definition, source } = await createReadyDefinition(store, ledger, account);
    const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, run.id);
    const evidenceA = (await captureEvidence(store, account, run.id, source, "4% uplift")).id;
    const evidenceB = (await captureEvidence(store, account, run.id, source, "6% uplift")).id;

    const claim = await store.addResearchClaim(account, run.id, {
      kind: "claim",
      text: "The renewal uplift is contested.",
      classification: "conflicting",
      evidenceRefs: [evidenceA, evidenceB],
    });
    expect(claim.evidenceRefs).toEqual([evidenceA, evidenceB]);

    await expect(
      store.addResearchClaim(account, run.id, {
        kind: "claim",
        text: "Dangling reference.",
        classification: "supported",
        evidenceRefs: [randomUUID()],
      })
    ).rejects.toBeInstanceOf(ResearchEvidenceRefError);
    await expect(
      store.addResearchClaim(account, run.id, {
        kind: "claim",
        text: "Conflicting without two excerpts.",
        classification: "conflicting",
        evidenceRefs: [evidenceA],
      })
    ).rejects.toBeInstanceOf(ResearchValidationError);

    // Claims never accept more than five DISTINCT evidence references.
    const extraRefs: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      extraRefs.push((await captureEvidence(store, account, run.id, source, `extra ${index}`)).id);
    }
    await expect(
      store.addResearchClaim(account, run.id, {
        kind: "claim",
        text: "too many refs",
        classification: "supported",
        evidenceRefs: [evidenceA, evidenceB, ...extraRefs],
      })
    ).rejects.toBeInstanceOf(ResearchValidationError);

    const gap = await store.addResearchClaim(account, run.id, {
      kind: "gap",
      text: "No termination clause found in the selected evidence.",
    });
    expect(gap.evidenceRefs).toEqual([]);
    expect(gap.classification).toBeNull();

    for (let index = 0; index < 99; index += 1) {
      await store.addResearchClaim(account, run.id, {
        kind: "claim",
        text: `claim ${index}`,
        classification: "supported",
        evidenceRefs: [evidenceA],
      });
    }
    await expect(
      store.addResearchClaim(account, run.id, { kind: "claim", text: "one over 100", classification: "unsupported" })
    ).rejects.toMatchObject({ code: "RESEARCH_CLAIM_CAP" });
    for (let index = 0; index < 49; index += 1) {
      await store.addResearchClaim(account, run.id, { kind: "gap", text: `gap ${index}` });
    }
    const overGaps = await store
      .addResearchClaim(account, run.id, { kind: "gap", text: "one over 50" })
      .catch((cause) => cause);
    expect(overGaps).toBeInstanceOf(ResearchClaimCapError);
    expect((overGaps as ResearchClaimCapError).code).toBe("RESEARCH_GAP_CAP");
  });

  it("validates typed values without any coercion", () => {
    const numberColumn: ResearchColumnDeclaration = Object.freeze({
      id: randomUUID(),
      label: "Price",
      question: "q",
      type: "number",
      unit: "USD",
      choices: null,
    });
    expect(validateResearchTypedValue(numberColumn, 4.5)).toEqual({ ok: true, value: 4.5 });
    expect(validateResearchTypedValue(numberColumn, "4.5")).toEqual({ ok: false });
    expect(validateResearchTypedValue(numberColumn, true)).toEqual({ ok: false });
    const dateColumn: ResearchColumnDeclaration = { ...numberColumn, type: "date", unit: null };
    expect(validateResearchTypedValue(dateColumn, "2026-02-28").ok).toBe(true);
    expect(validateResearchTypedValue(dateColumn, "2026-02-30").ok).toBe(false);
    expect(validateResearchTypedValue(dateColumn, "2026-13-01").ok).toBe(false);
    expect(validateResearchTypedValue(dateColumn, "02/28/2026").ok).toBe(false);
    const enumColumn: ResearchColumnDeclaration = {
      ...numberColumn,
      type: "enum",
      unit: null,
      choices: Object.freeze(["basic", "pro"] as string[]),
    };
    expect(validateResearchTypedValue(enumColumn, "pro").ok).toBe(true);
    expect(validateResearchTypedValue(enumColumn, "Pro").ok).toBe(false);
    expect(validateResearchTypedValue(enumColumn, "enterprise").ok).toBe(false);
    const booleanColumn: ResearchColumnDeclaration = { ...numberColumn, type: "boolean", unit: null };
    expect(validateResearchTypedValue(booleanColumn, true).ok).toBe(true);
    expect(validateResearchTypedValue(booleanColumn, "true").ok).toBe(false);

    // Unsupported model output stays the original scalar under `invalid`.
    expect(classifyResearchCellPayload(numberColumn, "4.5")).toEqual({ status: "invalid", value: "4.5" });
    expect(classifyResearchCellPayload(numberColumn, undefined)).toEqual({ status: "not_found", value: null });
    expect(classifyResearchCellPayload(numberColumn, null)).toEqual({ status: "not_found", value: null });
    expect(classifyResearchCellPayload(numberColumn, 4.5)).toEqual({ status: "supported", value: 4.5 });
  });

  it("writes correction overlays beside immutable machine cells and caps the table at 1 MiB", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "cells");
    const { source, run, columns } = await comparisonRun(store, ledger, account, [column()]);
    const declared = columns[0]!;

    const machine = await store.recordResearchMachineCell(account, run.id, {
      columnId: declared.id,
      rowSourceId: source,
      rawValue: 1200,
    });
    expect(machine.status).toBe("supported");
    expect(machine.value).toBe(1200);

    // A mistyped value asserted as machine output is preserved verbatim as
    // `invalid` — never coerced, and `not_found` requires a null value.
    const invalidCell = await store.recordResearchMachineCell(account, run.id, {
      columnId: declared.id,
      rowSourceId: source,
      assertedStatus: "invalid",
      rawValue: "about 1200",
    });
    expect(invalidCell.value).toBe("about 1200");
    await expect(
      store.recordResearchMachineCell(account, run.id, {
        columnId: declared.id,
        rowSourceId: source,
        assertedStatus: "supported",
        rawValue: "1200 dollars",
      })
    ).rejects.toBeInstanceOf(ResearchValidationError);

    // Corrections land after the computation settles.
    await store.finishResearchRun(account, run.id, "needs_review");
    const review = await store.applyResearchReviewOps(account, run.id, 1, [
      {
        op: "correct_cell",
        column_id: declared.id,
        row_source_id: source,
        value: 1250,
        explanation: "Corrected from the signed amendment.",
      },
    ]);
    expect(review.reviewRevision).toBe(2);
    expect(review.applied).toBe(1);

    const table = await store.getResearchTable(account, run.id);
    const cells = table?.page.items[0]?.cells ?? [];
    const machineRow = cells.find((cell) => cell.origin === "machine")!;
    const overlay = cells.find((cell) => cell.origin === "correction")!;
    expect(machineRow.value).toBe("about 1200");
    expect(overlay.value).toBe(1250);
    expect(overlay.status).toBe("supported");
    expect(overlay.correctedAt).toBeTruthy();
    expect(overlay.correctedFromRunId).toBeNull();

    // A stale review revision cannot mutate the overlay again.
    await expect(
      store.applyResearchReviewOps(account, run.id, 1, [
        { op: "correct_cell", column_id: declared.id, row_source_id: source, value: 1 },
      ])
    ).rejects.toBeInstanceOf(ResearchRevisionConflictError);

    // 1 MiB serialized cap: many wide cells across rows/columns bind it; the
    // refusing write is rejected with an explicit limit code.
    const manySources: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      manySources.push(await insertSource(ledger, account, { readyGeneration: 2 }));
    }
    const wideColumns = Array.from({ length: 20 }, (_, index) =>
      column({ type: "text", label: `T${index}`, question: "text question", unit: null })
    );
    const wide = await store.createResearchDefinition(
      account,
      definitionInput(manySources, { output_kind: "comparison", columns: wideColumns })
    );
    const wideRun = await store.startResearchRun(account, wide.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, wideRun.id);
    const wideDeclared = (await store.getResearchDefinition(account, wide.id))!.revision.columns;
    const big = "y".repeat(2_000);
    let limitHit = false;
    let writtenCells = 0;
    for (const declaredColumn of wideDeclared) {
      for (const rowSource of manySources) {
        try {
          await store.recordResearchMachineCell(account, wideRun.id, {
            columnId: declaredColumn.id,
            rowSourceId: rowSource,
            rawValue: big,
          });
          writtenCells += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(ResearchTableLimitError);
          limitHit = true;
          break;
        }
      }
      if (limitHit) break;
    }
    expect(limitHit).toBe(true);
    expect(writtenCells).toBeGreaterThan(0);
    // The frozen rows of this table key by the run's own source identities.
    const wideTable = await store.getResearchTable(account, wideRun.id, { limit: 100, after: null });
    expect(wideTable?.page.items.map((item) => item.row_generation).every((generation) => generation === 2)).toBe(true);
    void source;
    void run;
  });
});

describe("ResearchStore review and rerun", () => {
  it("applies review operations with CAS, keeps notes out of evidence, and flags evidence", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "review");
    const { definition, source } = await createReadyDefinition(store, ledger, account);
    const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, run.id);
    const evidenceId = (await captureEvidence(store, account, run.id, source, "The proposal promises 24/7 support.")).id;
    const claim = await store.addResearchClaim(account, run.id, {
      kind: "claim",
      text: "Support is 24/7.",
      classification: "supported",
      evidenceRefs: [evidenceId],
    });
    await store.finishResearchRun(account, run.id, "completed");

    const applied = await store.applyResearchReviewOps(account, run.id, 1, [
      { op: "accept_claim", claim_id: claim.id },
      { op: "add_note", target_kind: "claim", target_id: claim.id, note: "Matches section 4." },
      { op: "add_note", target_kind: "run", note: "Overall scope was adequate." },
      { op: "correct_claim", claim_id: claim.id, text: "Support is 24/7 per the reviewed draft." },
      { op: "flag_evidence", evidence_id: evidenceId, irrelevant: true },
    ]);
    expect(applied.reviewRevision).toBe(2);
    expect(applied.applied).toBe(5);

    const refreshed = await store.getResearchClaim(account, run.id, claim.id);
    expect(refreshed?.reviewState).toBe("accepted");
    expect(refreshed?.userNote).toBe("Matches section 4.");
    expect(refreshed?.correctedText).toBe("Support is 24/7 per the reviewed draft.");
    // The original machine text is never rewritten by a correction.
    expect(refreshed?.text).toBe("Support is 24/7.");

    const inspection = await store.inspectResearchRun(account, run.id);
    // Notes never become evidence; the run-level note surfaces as review data.
    expect(inspection?.counts.evidenceCount).toBe(1);
    expect(inspection?.runNotes).toEqual(["Overall scope was adequate."]);
    expect((await store.listResearchEvidence(account, run.id)).items[0]?.irrelevant).toBe(true);

    await store.applyResearchReviewOps(account, run.id, 2, [{ op: "reject_claim", claim_id: claim.id }]);
    expect((await store.getResearchClaim(account, run.id, claim.id))?.reviewState).toBe("rejected");
    await expect(
      store.applyResearchReviewOps(account, run.id, 3, [{ op: "accept_claim", claim_id: randomUUID() }])
    ).rejects.toThrow(/not found in this run/);

    // A queued run refuses review entirely.
    const other = await createReadyDefinition(store, ledger, account);
    const queued = await store.startResearchRun(account, other.definition.id, { authorization: AUTHORIZATION });
    await expect(
      store.applyResearchReviewOps(account, queued.id, 1, [{ op: "add_note", target_kind: "run", note: "too early" }])
    ).rejects.toBeInstanceOf(ResearchRunStateError);

    // More than 100 operations in one request is refused.
    await expect(
      store.applyResearchReviewOps(
        account,
        run.id,
        3,
        Array.from({ length: 101 }, () => ({ op: "add_note", target_kind: "run", note: "x" }))
      )
    ).rejects.toBeInstanceOf(ResearchValidationError);
  });

  it("reruns capture current generations, link lineage, and carry overrides visibly", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "rerun");
    const source = await insertSource(ledger, account, { readyGeneration: 1 });
    const col = column();
    const definition = await store.createResearchDefinition(
      account,
      definitionInput([source], { output_kind: "comparison", columns: [col] })
    );
    const first = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, first.id);
    const declared = (await store.getResearchDefinition(account, definition.id))!.revision.columns[0]!;
    await store.recordResearchMachineCell(account, first.id, {
      columnId: declared.id,
      rowSourceId: source,
      rawValue: 100,
    });
    await store.finishResearchRun(account, first.id, "completed");
    await store.applyResearchReviewOps(account, first.id, 1, [
      { op: "correct_cell", column_id: declared.id, row_source_id: source, value: 130 },
    ]);

    // The source refreshes to a new generation; the rerun captures the NEW
    // generation while the first run keeps its old frozen identity.
    await ledger.run("UPDATE sources SET ready_generation=2 WHERE id=?", [source]);
    const second = await store.startResearchRun(account, definition.id, {
      authorization: AUTHORIZATION,
      rerunOf: first.id,
      rerunSelection: { row_source_ids: [source], column_ids: [declared.id] },
    });
    expect(second.rerunOf).toBe(first.id);
    expect(second.sources).toEqual([{ sourceId: source, generation: 2 }]);
    expect(second.rerunSelection).toEqual({ row_source_ids: [source], column_ids: [declared.id] });

    await store.markResearchRunRunning(account, second.id);
    // The user override rides into the new result revision as a correction
    // overlay with provenance pointing at the prior run — the machine pass
    // never silently overwrites it.
    await store.recordResearchMachineCell(account, second.id, {
      columnId: declared.id,
      rowSourceId: source,
      rawValue: 90,
    });
    const table = await store.getResearchTable(account, second.id);
    const cells = table?.page.items[0]?.cells ?? [];
    const overlay = cells.find((cell) => cell.origin === "correction")!;
    expect(overlay.value).toBe(130);
    expect(overlay.correctedFromRunId).toBe(first.id);
    expect(cells.find((cell) => cell.origin === "machine")!.value).toBe(90);

    // Lineage must be a prior run of the SAME definition.
    await store.finishResearchRun(account, second.id, "completed");
    const rival = await createReadyDefinition(store, ledger, account);
    await expect(
      store.startResearchRun(account, rival.definition.id, { authorization: AUTHORIZATION, rerunOf: first.id })
    ).rejects.toBeInstanceOf(ResearchRunStateError);
  });
});

describe("ResearchStore steps and recovery", () => {
  it("materializes steps once, persists outcomes before advancing, and retries at most once", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "steps");
    const { definition } = await createReadyDefinition(store, ledger, account);
    const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, run.id);
    const plan = [
      { objective: "Find relevant evidence", questions: ["renewal terms", "termination clause"] },
      { objective: "Synthesize the memo", questions: ["final summary"] },
    ];
    const materialized = await store.materializeResearchSteps(account, run.id, plan);
    expect(materialized.map((step) => step.status)).toEqual(["pending", "pending"]);
    // Idempotent: a retried dispatch keeps the durable set.
    expect(await store.materializeResearchSteps(account, run.id, plan)).toHaveLength(2);

    await store.markResearchStepRunning(account, run.id, 0);
    const done = await store.recordResearchStepOutcome(account, run.id, 0, "done", "captured 4 items");
    expect(done.status).toBe("done");
    expect(done.outcome).toBe("captured 4 items");
    await expect(store.recordResearchStepOutcome(account, run.id, 1, "done")).rejects.toBeInstanceOf(
      ResearchRunStateError
    );

    // Restart: an interrupted running step returns to pending under the SAME
    // identity; a second interrupt exhausts the at-most-once retry.
    await store.markResearchStepRunning(account, run.id, 1);
    let recovery = await store.recoverInterruptedResearchRuns();
    expect(recovery.resumedRuns).toBe(1);
    expect(recovery.retriedSteps).toBe(1);
    let steps = await store.listResearchSteps(account, run.id);
    expect(steps[1]?.status).toBe("pending");
    expect(steps[1]?.attempts).toBe(1);

    await store.markResearchStepRunning(account, run.id, 1);
    recovery = await store.recoverInterruptedResearchRuns();
    expect(recovery.exhaustedSteps).toBe(1);
    steps = await store.listResearchSteps(account, run.id);
    expect(steps[1]?.status).toBe("failed");
    expect(steps[1]?.outcome).toContain("retry");
    await store.recordResearchStepOutcome(account, run.id, 1, "failed", "giving up");

    // A cancel-requested running run settles cancelled at startup.
    await store.requestResearchRunCancel(account, run.id);
    recovery = await store.recoverInterruptedResearchRuns();
    expect(recovery.cancelledRuns).toBe(1);
    expect((await store.getResearchRun(account, run.id))?.status).toBe("cancelled");
  });

  it("enforces usage budgets and cancellation-wins settle semantics", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "budget");
    const { definition } = await createReadyDefinition(store, ledger, account);
    const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, run.id);
    expect(await store.incrementResearchRunUsage(account, run.id, { searches: 32, modelRequests: 40 })).toEqual({
      searchesUsed: 32,
      modelRequestsUsed: 40,
    });
    await expect(store.incrementResearchRunUsage(account, run.id, { searches: 1 })).rejects.toMatchObject({
      code: "RESEARCH_BUDGET_EXHAUSTED",
    });
    await store.requestResearchRunCancel(account, run.id);
    // A retained cancellation request wins over a completing executor.
    expect(await store.finishResearchRun(account, run.id, "completed")).toBe("cancelled");

    const done = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
    await store.markResearchRunRunning(account, done.id);
    expect(await store.finishResearchRun(account, done.id, "completed")).toBe("completed");
    expect(await store.finishResearchRun(account, done.id, "failed", "X")).toBe("completed");
    // Cancel is idempotent and absorbing on terminal runs; cross-account
    // cancellation reports not-owned.
    expect(await store.requestResearchRunCancel(account, done.id)).toBe("completed");
    const other = await insertUser(ledger, "nothere");
    expect(await store.requestResearchRunCancel(other, done.id)).toBeNull();
  });
});
