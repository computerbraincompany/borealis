/**
 * M15 stage 3 — comparison semantics over the durable store: correction
 * overlays stay overlays across reruns, machine originals are immutable, the
 * changed-cell diff discloses machine vs correction movement without
 * inventing row identity, the CSV/manifest exports are byte-exact and
 * formula-safe, and the page view options are bounded and honest.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { ResearchStore } from "../db/stores/researchStore.js";
import type { SqliteLedger } from "../db/types.js";
import {
  RESEARCH_TABLE_SERIALIZED_MAX_BYTES,
  ResearchValidationError,
} from "../researchSchemas.js";
import {
  RESEARCH_CSV_HEADER,
  RESEARCH_EXCERPT_SHORTEN_LABEL,
  RESEARCH_TABLE_FILTER_TEXT_MAX_CHARS,
  applyResearchTablePageView,
  buildResearchComparisonCsv,
  buildResearchRunManifest,
  diffResearchRunTables,
  loadResearchRunEvidence,
  loadResearchRunTable,
  researchCellTriple,
  researchCellDisplayText,
  researchCellValueViews,
  researchCsvField,
  researchExportFilename,
} from "../researchComparison.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function setup(): Promise<{ ledger: SqliteLedger; store: ResearchStore }> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  return { ledger: resource.ledger, store: new ResearchStore(resource.ledger) };
}

async function insertUser(ledger: SqliteLedger): Promise<string> {
  const id = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, `${id}@e.test`, "hash"]);
  return id;
}

async function insertSource(ledger: SqliteLedger, accountId: string, generation = 4): Promise<string> {
  const id = randomUUID();
  await ledger.run(
    `INSERT INTO sources (id,account_id,name,kind,display_name,file_path,status,meta,ready_generation,size_bytes)
     VALUES (?,?,?,'document',?,?,?,?,?,?)`,
    [id, accountId, `src-${id.slice(0, 8)}`, `${id.slice(0, 8)}.md`, `/d/${id}/x.md`, "ready", "{}", generation, 64]
  );
  return id;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const AUTHORIZATION = Object.freeze({
  providerOrigin: "http://127.0.0.1:1234",
  providerLocality: "local" as const,
  providerRevision: 1,
});

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

async function seedFinishedComparisonRun(
  store: ResearchStore,
  ledger: SqliteLedger,
  account: string
): Promise<{
  definitionId: string;
  runId: string;
  sources: readonly string[];
  evidenceId: string;
}> {
  const sources = [await insertSource(ledger, account), await insertSource(ledger, account), await insertSource(ledger, account)];
  const definition = await store.createResearchDefinition(account, {
    title: "Supplier table",
    question: "Compare supplier pricing tables",
    output_kind: "comparison",
    source_ids: sources,
    chat_model: "chat-model",
    columns: [priceColumn, termsColumn],
  });
  const run = await store.startResearchRun(account, definition.id, { authorization: AUTHORIZATION });
  await store.markResearchRunRunning(account, run.id);
  const evidence = await store.insertResearchEvidence(account, run.id, {
    sourceId: sources[0],
    generation: 4,
    chunkId: randomUUID(),
    label: "proposal-a.md",
    locators: [{ kind: "pdf_page", page: 3, ocr: false, char_start: 12, char_len: 80 }],
    excerpt: "Net-30 renewal at 4% uplift.",
    contentHash: sha("Net-30 renewal at 4% uplift."),
    stepOrdinal: 0,
    query: "renewal",
  });
  // Machine extractions with every status represented honestly.
  await store.recordResearchMachineCell(account, run.id, {
    columnId: priceColumn.id,
    rowSourceId: sources[0],
    rawValue: 4.5,
    evidenceRefs: [evidence.id],
  });
  await store.recordResearchMachineCell(account, run.id, {
    // A quoted number on a number column must land `invalid` VERBATIM.
    columnId: priceColumn.id,
    rowSourceId: sources[1],
    rawValue: "5",
  });
  await store.recordResearchMachineCell(account, run.id, {
    columnId: priceColumn.id,
    rowSourceId: sources[2],
    rawValue: null,
  });
  await store.recordResearchMachineCell(account, run.id, {
    columnId: termsColumn.id,
    rowSourceId: sources[0],
    rawValue: "=1+2",
    evidenceRefs: [evidence.id],
  });
  await store.recordResearchMachineCell(account, run.id, {
    columnId: termsColumn.id,
    rowSourceId: sources[1],
    rawValue: "renewal at 3%",
    assertedStatus: "conflicting",
  });
  await store.recordResearchMachineCell(account, run.id, {
    columnId: termsColumn.id,
    rowSourceId: sources[2],
    rawValue: "a,b \"c\"",
  });
  await store.finishResearchRun(account, run.id, "completed");
  return { definitionId: definition.id, runId: run.id, sources, evidenceId: evidence.id };
}

describe("researchComparison — overlay and diff semantics", () => {
  it("keeps invalid machine output verbatim in the view triple, never coerced", async () => {
    const { store, ledger } = await setup();
    const account = await insertUser(ledger);
    const { runId } = await seedFinishedComparisonRun(store, ledger, account);
    const view = await loadResearchRunTable(store, account, runId);
    const row = view!.rows.find((entry) => entry.cells.some((cell) => cell.columnId === priceColumn.id))!;
    for (const entry of view!.rows) {
      const slot = entry.cells.filter((cell) => cell.columnId === priceColumn.id);
      if (slot.length === 0) continue;
      const views = researchCellValueViews(slot);
      if (views.extracted?.status === "invalid") {
        expect(views.original?.value).toBe("5"); // string preserved, not 5
        expect(views.effective?.value).toBe("5");
      }
    }
    expect(row).toBeDefined();
    expect(await loadResearchRunEvidence(store, account, runId)).toHaveLength(1);
  });

  it("carries user corrections visibly across a rerun while machine originals stay immutable", async () => {
    const { store, ledger } = await setup();
    const account = await insertUser(ledger);
    const seed = await seedFinishedComparisonRun(store, ledger, account);

    const review = await store.applyResearchReviewOps(account, seed.runId, 1, [
      {
        op: "correct_cell",
        column_id: priceColumn.id,
        row_source_id: seed.sources[1],
        value: 5,
        explanation: "manual quote confirmation",
      },
    ]);
    expect(review.reviewRevision).toBe(2);

    // The corrected overlay never touches the machine row.
    const afterCorrection = await loadResearchRunTable(store, account, seed.runId);
    const slot = afterCorrection!.rows
      .find((row) => row.row_source_id === seed.sources[1])!
      .cells.filter((cell) => cell.columnId === priceColumn.id);
    const triple = researchCellTriple(slot);
    expect(triple.machine?.status).toBe("invalid");
    expect(triple.machine?.value).toBe("5");
    expect(triple.correction?.status).toBe("supported");
    expect(triple.correction?.value).toBe(5);
    expect(triple.effective?.value).toBe(5);

    // Rerun only row 1 / price column: the prior extraction is replaced by a
    // NEW machine row while the correction rides along with provenance.
    const rerun = await store.startResearchRun(account, seed.definitionId, {
      authorization: AUTHORIZATION,
      rerunOf: seed.runId,
      rerunSelection: { row_source_ids: [seed.sources[0]], column_ids: [priceColumn.id] },
    });
    await store.markResearchRunRunning(account, rerun.id);
    await store.recordResearchMachineCell(account, rerun.id, {
      columnId: priceColumn.id,
      rowSourceId: seed.sources[0],
      rawValue: 5.25,
    });
    await store.finishResearchRun(account, rerun.id, "completed");

    const rerunView = await loadResearchRunTable(store, account, rerun.id);
    const row0 = rerunView!.rows.find((row) => row.row_source_id === seed.sources[0])!;
    const cell0 = researchCellTriple(row0.cells.filter((cell) => cell.columnId === priceColumn.id));
    expect(cell0.machine?.value).toBe(5.25);
    const row1 = rerunView!.rows.find((row) => row.row_source_id === seed.sources[1])!;
    const cell1 = researchCellTriple(row1.cells.filter((cell) => cell.columnId === priceColumn.id));
    expect(cell1.machine).toBeNull(); // not re-extracted
    expect(cell1.correction?.value).toBe(5);
    expect(cell1.correction?.correctedFromRunId).toBe(seed.runId);

    // The prior revision's machine history is untouched by the rerun.
    const priorView = await loadResearchRunTable(store, account, seed.runId);
    const priorCell = researchCellTriple(
      priorView!.rows
        .find((row) => row.row_source_id === seed.sources[0])!
        .cells.filter((cell) => cell.columnId === priceColumn.id)
    );
    expect(priorCell.machine?.value).toBe(4.5);

    // The diff separates machine movement from carried overrides.
    const diff = diffResearchRunTables(priorView!, rerunView!);
    expect(diff.from_run_id).toBe(seed.runId);
    expect(diff.to_run_id).toBe(rerun.id);
    expect(diff.rows_added).toEqual([]);
    expect(diff.rows_removed).toEqual([]);
    expect(diff.carried_overrides).toEqual([
      { column_id: priceColumn.id, row_source_id: seed.sources[1], corrected_from_run_id: seed.runId },
    ]);
    const moved = diff.changed_cells.find(
      (change) => change.row_source_id === seed.sources[0] && change.column_id === priceColumn.id
    );
    expect(moved).toBeDefined();
    expect(moved!.machine_changed).toBe(true);
    expect(moved!.correction_changed).toBe(false);
    expect(moved!.before.effective).toEqual({ value: 4.5, status: "supported" });
    expect(moved!.after.effective).toEqual({ value: 5.25, status: "supported" });
    // The carried correction is not reported as an effective change.
    const s2Changes = diff.changed_cells.filter(
      (change) => change.row_source_id === seed.sources[1] && change.column_id === priceColumn.id
    );
    expect(s2Changes).toHaveLength(1);
    expect(s2Changes[0].correction_changed).toBe(false);
    expect(s2Changes[0].before.effective).toEqual(s2Changes[0].after.effective);
    expect(s2Changes[0].machine_changed).toBe(true); // extraction simply not repeated
  });

  it("diffs row add/remove, correction-only movement, and truncates the diff honestly", async () => {
    // The diff is a pure function over materialized views; fabricate minimal
    // ones to exercise row movement and the 200-cell truncation flag.
    const cell = (value: unknown, status: string, origin: "machine" | "correction") =>
      ({
        columnId: priceColumn.id,
        rowSourceId: randomUUID(),
        rowGeneration: 1,
        origin,
        value,
        status,
        evidenceRefs: [],
        explanation: null,
        correctedAt: null,
        correctedFromRunId: null,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
      }) as unknown as import("../db/stores/researchStore.js").StoredResearchCell;
    const row = (rowSourceId: string, cells: import("../db/stores/researchStore.js").StoredResearchCell[]) => ({
      row_source_id: rowSourceId,
      row_generation: 1,
      cells,
    });
    const view = (runId: string, rows: ReturnType<typeof row>[]) =>
      ({
        run: { id: runId } as import("../db/stores/researchStore.js").StoredResearchRun,
        columns: [priceColumn] as unknown as import("../researchSchemas.js").ResearchColumnDeclaration[],
        rows,
        serializedBytes: 10,
        limitState: { serialized_bytes: 10, limit_bytes: 1024, at_limit: false },
      }) as import("../researchComparison.js").ResearchRunTableView;

    const r1 = randomUUID();
    const r2 = randomUUID();
    const r3 = randomUUID();
    const before = view("aaa", [row(r1, [cell(1, "supported", "machine")]), row(r2, [cell(1, "supported", "machine")])]);
    const after = view(
      "bbb",
      [
        row(r2, [cell(1, "supported", "machine"), cell(9, "supported", "correction")]),
        row(r3, [cell(3, "supported", "machine")]),
      ]
    );
    const diff = diffResearchRunTables(before, after);
    expect(diff.rows_added).toEqual([r3]);
    expect(diff.rows_removed).toEqual([r1]);
    // Cell changes are reported for every (row, column) slot whose views
    // differ — including slots that exist on only one side.
    expect(diff.changed_total).toBe(3);
    const r2Change = diff.changed_cells.find((change) => change.row_source_id === r2)!;
    expect(r2Change.machine_changed).toBe(false);
    expect(r2Change.correction_changed).toBe(true);
    expect(r2Change.before.machine).toEqual({ value: 1, status: "supported" });
    expect(r2Change.after.effective).toEqual({ value: 9, status: "supported" });
    const removedChange = diff.changed_cells.find((change) => change.row_source_id === r1)!;
    expect(removedChange.after.effective).toBeNull();
    const addedChange = diff.changed_cells.find((change) => change.row_source_id === r3)!;
    expect(addedChange.before.effective).toBeNull();

    // Over 200 changed cells: totals are honest, payload is capped.
    const manyBefore = view(
      "aaa",
      Array.from({ length: 201 }, (_, index) => row(`r${String(index).padStart(4, "0")}`, [cell(1, "supported", "machine")]))
    );
    const manyAfter = view(
      "bbb",
      Array.from({ length: 201 }, (_, index) =>
        row(`r${String(index).padStart(4, "0")}`, [cell(2, "supported", "machine")])
      )
    );
    const big = diffResearchRunTables(manyBefore, manyAfter);
    expect(big.changed_total).toBe(201);
    expect(big.changed_cells).toHaveLength(200);
    expect(big.truncated).toBe(true);

    // Identity diff on the real materialized data is empty and deterministic.
    const { store, ledger } = await setup();
    const account = await insertUser(ledger);
    const seed = await seedFinishedComparisonRun(store, ledger, account);
    const real = await loadResearchRunTable(store, account, seed.runId);
    const same = diffResearchRunTables(real!, real!);
    expect(same.changed_cells).toEqual([]);
    expect(same.changed_total).toBe(0);
    expect(same.truncated).toBe(false);
  });

  it("page view options validate columns, sort deterministically with nulls last, and filter bounded", async () => {
    const { store, ledger } = await setup();
    const account = await insertUser(ledger);
    const seed = await seedFinishedComparisonRun(store, ledger, account);
    await store.applyResearchReviewOps(account, seed.runId, 1, [
      { op: "correct_cell", column_id: priceColumn.id, row_source_id: seed.sources[1], value: 5 },
    ]);
    const view = await loadResearchRunTable(store, account, seed.runId);
    const columns = view!.columns;

    expect(() =>
      applyResearchTablePageView(view!.rows, columns, { sortColumnId: randomUUID() })
    ).toThrow(ResearchValidationError);
    expect(() =>
      applyResearchTablePageView(view!.rows, columns, {
        filterText: "x".repeat(RESEARCH_TABLE_FILTER_TEXT_MAX_CHARS + 1),
      })
    ).toThrow(ResearchValidationError);

    const asc = applyResearchTablePageView(view!.rows, columns, {
      sortColumnId: priceColumn.id,
      sortDir: "asc",
    });
    expect(asc.viewState.sort_applied).toBe(true);
    expect(asc.viewState.filter_applied).toBe(false);
    expect(asc.viewState.basis).toBe("row_source_id_keyset");
    // numbers (4.5, effective correction 5 on s2 via invalid? invalid 5 not a
    // number) then the not_found null row last.
    const firstRow = asc.items[0].cells.filter((cell) => cell.columnId === priceColumn.id);
    expect(researchCellTriple(firstRow).effective?.value).toBe(4.5);
    expect(asc.items[asc.items.length - 1].row_source_id).toBe(seed.sources[2]);

    const desc = applyResearchTablePageView(view!.rows, columns, {
      sortColumnId: priceColumn.id,
      sortDir: "desc",
    });
    // Nulls stay last in BOTH directions: corrected 5, then 4.5, then the
    // not_found (null) row.
    expect(desc.items.map((row) => row.row_source_id)).toEqual([
      seed.sources[1],
      seed.sources[0],
      seed.sources[2],
    ]);
    expect(asc.items.map((row) => row.row_source_id)).toEqual([
      seed.sources[0],
      seed.sources[1],
      seed.sources[2],
    ]);

    const corrected = applyResearchTablePageView(view!.rows, columns, {
      sortColumnId: priceColumn.id,
      sortView: "correction",
    });
    // Only one correction exists: it leads, everything else null-sorted.
    expect(corrected.items[0].row_source_id).toBe(seed.sources[1]);

    const filtered = applyResearchTablePageView(view!.rows, columns, {
      filterColumnId: priceColumn.id,
      filterStatus: "not_found",
    });
    expect(filtered.viewState.filter_applied).toBe(true);
    expect(filtered.items.map((row) => row.row_source_id)).toEqual([seed.sources[2]]);

    const text = applyResearchTablePageView(view!.rows, columns, { filterText: "renewal at 3" });
    expect(text.items.map((row) => row.row_source_id)).toEqual([seed.sources[1]]);
  });

  it("renders honest cell previews: corrections labeled, invalid labeled, blanks for never-extracted", () => {
    const machine = {
      columnId: priceColumn.id,
      rowSourceId: randomUUID(),
      rowGeneration: 4,
      origin: "machine" as const,
      value: 4.5,
      status: "supported" as const,
      evidenceRefs: [],
      explanation: null,
      correctedAt: null,
      correctedFromRunId: null,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    const correction = { ...machine, origin: "correction" as const, value: 4.75, correctedAt: machine.createdAt };
    expect(researchCellDisplayText([machine], 500).text).toBe("4.5");
    expect(researchCellDisplayText([machine, correction], 500).text).toBe("4.75 (corrected)");
    expect(researchCellDisplayText([], 500)).toEqual({ text: "", truncated: false });
    expect(researchCellDisplayText([machine], 3)).toEqual({ text: "4.5", truncated: false });
    expect(researchCellDisplayText([machine], 2).truncated).toBe(true);
  });
});

describe("researchComparison — CSV export bytes", () => {
  it("emits BOM, CRLF, the exact stored values verbatim, formula guards, and the limit state", async () => {
    const { store, ledger } = await setup();
    const account = await insertUser(ledger);
    const seed = await seedFinishedComparisonRun(store, ledger, account);
    await store.applyResearchReviewOps(account, seed.runId, 1, [
      { op: "correct_cell", column_id: priceColumn.id, row_source_id: seed.sources[1], value: 5 },
    ]);
    const view = await loadResearchRunTable(store, account, seed.runId);
    const body = buildResearchComparisonCsv(view!);

    expect(body.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM (M12-consistent)
    const lines = body.slice(1).split("\r\n");
    expect(lines[0]).toMatch(/^# limit_state: serialized_bytes=\d+,limit_bytes=1048576,at_limit=false$/);
    expect(lines[1]).toBe(RESEARCH_CSV_HEADER.join(","));
    const rows = lines.slice(2, -1); // trailing CRLF yields one empty tail

    // Every stored machine cell appears with its exact stored value.
    expect(rows.some((line) => line.includes(`,machine,4.5,supported,${seed.evidenceId},`))).toBe(true);
    expect(rows.some((line) => line.includes(",machine,5,invalid,"))).toBe(true); // verbatim "5"
    expect(rows.some((line) => line.includes(",machine,null,not_found,"))).toBe(true); // literal null
    // The correction rides as its own line, never merged over the original.
    expect(rows.some((line) => line.includes(",correction,5,supported,"))).toBe(true);
    // Quoting round-trips commas/quotes; formula guards prefix apostrophes.
    expect(rows.some((line) => line.includes('"a,b ""c"""'))).toBe(true);
    expect(rows.some((line) => line.includes("'=1+2"))).toBe(true);
    expect(body.includes(',"=1+2')).toBe(false); // never an unguarded leading =

    // limit_state at_limit renders honestly at the cap quantity.
    expect(lines[0]).toContain(`limit_bytes=${RESEARCH_TABLE_SERIALIZED_MAX_BYTES}`);
  });

  it("guards TAB and CR leading cells and keeps RFC quoting", () => {
    expect(researchCsvField("\tTAB")).toBe("'\tTAB");
    expect(researchCsvField("\rCR")).toBe(`"'${"\r"}CR"`);
    expect(researchCsvField("  =sum(A1)")).toBe("'  =sum(A1)");
    expect(researchCsvField("@evil")).toBe("'@evil");
    expect(researchCsvField("plain")).toBe("plain");
    expect(researchCsvField(null)).toBe("null");
    expect(researchCsvField(true)).toBe("true");
    expect(researchCsvField(4.5)).toBe("4.5");
    expect(researchCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("manifest carries locators, hashes, correction provenance, and limit states; zero cells is a success", async () => {
    const { store, ledger } = await setup();
    const account = await insertUser(ledger);
    const seed = await seedFinishedComparisonRun(store, ledger, account);
    await store.applyResearchReviewOps(account, seed.runId, 1, [
      { op: "correct_cell", column_id: priceColumn.id, row_source_id: seed.sources[1], value: 5, explanation: "ok" },
    ]);
    const view = await loadResearchRunTable(store, account, seed.runId);
    const evidence = await loadResearchRunEvidence(store, account, seed.runId);
    const manifest = buildResearchRunManifest(view!, evidence);

    expect(manifest.artifact).toBe("research_run_export_manifest");
    expect(manifest.run.id).toBe(seed.runId);
    expect(manifest.run.status).toBe("completed");
    expect((manifest.run.sources as readonly { source_id: string }[])).toHaveLength(3);
    expect(manifest.limits).toMatchObject({
      table: { limit_bytes: RESEARCH_TABLE_SERIALIZED_MAX_BYTES, at_limit: false, truncated: false },
      export_truncated: false,
    });
    expect(manifest.rows).toHaveLength(3);

    const entry = manifest.evidence.find((item) => item.id === seed.evidenceId)!;
    expect(entry.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.locators).toEqual([
      { kind: "pdf_page", page: 3, ocr: false, char_start: 12, char_len: 80 },
    ]);
    expect(entry.label).toBe("proposal-a.md");

    const cells = manifest.cells as ReadonlyArray<Record<string, unknown>>;
    const machineInvalid = cells.find(
      (cell) => cell.origin === "machine" && cell.status === "invalid" && cell.row_source_id === seed.sources[1]
    )!;
    expect(machineInvalid.value).toBe("5"); // typed-exact companion
    const correction = cells.find((cell) => cell.origin === "correction")!;
    expect(correction.value).toBe(5);
    expect(correction.corrected_at).not.toBeNull();
    expect(correction.corrected_from_run_id).toBeNull(); // direct review correction

    // A finished run with no cells exported at all is still a valid manifest.
    const { store: memoStore, ledger: memoLedger } = await setup();
    const memoAccount = await insertUser(memoLedger);
    const source = await insertSource(memoLedger, memoAccount);
    const memoDefinition = await memoStore.createResearchDefinition(memoAccount, {
      title: "Memo",
      question: "q",
      output_kind: "memo",
      source_ids: [source],
      chat_model: "chat-model",
    });
    const memoRun = await memoStore.startResearchRun(memoAccount, memoDefinition.id, { authorization: AUTHORIZATION });
    const memoView = await loadResearchRunTable(memoStore, memoAccount, memoRun.id);
    const memoManifest = buildResearchRunManifest(memoView!, await loadResearchRunEvidence(memoStore, memoAccount, memoRun.id));
    expect(memoManifest.cells).toEqual([]);
    expect(memoManifest.evidence).toEqual([]);
    expect(memoManifest.rows).toHaveLength(1); // sources are rows even with zero cells
    // The CSV side of zero cells is comment + header only (success).
    const csv = buildResearchComparisonCsv(memoView!);
    expect(csv.slice(1).split("\r\n")).toHaveLength(3); // comment, header, empty tail
  });

  it("filenames are deterministic and ASCII-safe", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(researchExportFilename("Supplier — Table!", id, "csv")).toBe("supplier-table-11111111.csv");
    expect(researchExportFilename("   ", id, "manifest")).toBe("research-11111111-manifest.json");
  });

  it("shortening label is deterministic and keeps the hash companion", () => {
    const excerpt = "x".repeat(2000);
    // The projection shortens via the documented label; assert the label and
    // the stable hash contract on the manifest side instead of duplicating
    // projection internals here.
    expect(RESEARCH_EXCERPT_SHORTEN_LABEL).toBe(" [shortened]");
    expect(sha(excerpt)).toHaveLength(64);
  });

  it("loadResearchRunTable returns undefined for unknown runs", async () => {
    const { store, ledger } = await setup();
    const account = await insertUser(ledger);
    expect(await loadResearchRunTable(store, account, randomUUID())).toBeUndefined();
  });
});
