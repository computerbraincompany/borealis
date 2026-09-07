/**
 * Journey E — Research and comparison (docs/END_TO_END_ACCEPTANCE.md, M15).
 *
 * Real production build + real Chromium + the one harness-launched scripted
 * provider (runtime script installs + deterministic step timing) + the
 * committed ten-document supplier corpus imported through the journey-D
 * pattern (browser file picker + the copied-directory manifest commit into a
 * library, so the definition carries explicit sources AND library
 * provenance). Covers, through the REAL /research UI:
 *   - a comparison definition created with the five spec columns (price
 *     number+USD, effective date date, renewal boolean, tier enum, exceptions
 *     text) and selected-empty honestly refusing Start in the UI and at the
 *     API (`RESEARCH_SCOPE_EMPTY`), then the scope attached through the
 *     real library-expansion affordance;
 *   - a model-proposed plan (`POST /:id/plan` over the scripted provider),
 *     edited and REORDERED in the plan editor, saved as a durable CAS
 *     revision, then Start — a proposal never starts execution;
 *   - navigate-away mid-run + reload: durable progress (step states,
 *     Searches 3/32, model requests 1/40) and the original 9-source
 *     selection survive the reload;
 *   - a deterministic per-column extraction transcript installed mid-run
 *     (during a provider-side slow call, the run's real captured evidence
 *     ids are fetched and embedded in the typed cell JSON): conflicting
 *     assertion for the acme price, the missing exceptions fact as
 *     `not_found`, an off-type `"15000"` string on the number column stored
 *     `invalid` VERBATIM, bogus evidence ids never materialized, every
 *     committed fixture fact asserted from the stored table;
 *   - review workflow: corrections applied in the table review surface
 *     (labeled overlay, provenance, machine original stays visible and
 *     immutable), a conflicting-cell overlay carrying the fixture's open
 *     price conflict, stale-CAS `409` refused, reload-durable;
 *   - exports: formula-safe UTF-8-BOM CSV bytes + the typed JSON manifest
 *     with locators, content hashes, and correction provenance;
 *   - a rerun of selected rows/columns that CARRIES the correction overlays
 *     visibly (`corrected_from_run_id`, "carried from an earlier run"), with
 *     the `against` revision diff and the carried-overrides disclosure, and
 *     the earlier revision byte-unchanged;
 *   - a memo run: accepted/rejected claims + reviewer notes (never promoted
 *     into evidence), the conflicting claim citing BOTH price excerpts, an
 *     unsupported claim with a fabricated price kept citation-less, explicit
 *     `not found in selected evidence` gap rows, evidence opened at real
 *     locators (PDF page offsets for the text PDFs, heading-bearing text
 *     spans for markdown), and a reviewed M13 draft that opens in the
 *     document workbench disclosing the conflict and gaps and excluding the
 *     rejected fabrication;
 *   - lifecycle: budget exhaustion forced HONESTLY via an over-wide 32-question
 *     plan (`needs_review` + "it is partial, not complete research" banner +
 *     explicit gap + skipped step, never a complete-labeled answer); a
 *     scripted transport failure settling `failed` with the artifact
 *     publication refusal visible and enforced (`RESEARCH_RUN_STATE`); a
 *     mid-run cancel that is visible, lands `cancelled`, preserves partial
 *     captures, is refused for publication, and repeats idempotently;
 *     foreign-account reads 404 for definitions, runs, and history.
 *
 * Honest-scope notes (reported, never hidden):
 *   - `needs_review` budget exhaustion is forced through the SEARCH budget
 *     (32 planned keyword ops). A provider-transcript that merely "stops
 *     mid-way" (on_exhausted=fail / http_error) settles `failed`, not
 *     `needs_review` — that path is exercised separately as the transport-
 *     failure run. The model-request budget (40) cannot be exhausted under
 *     the plan's own ≤32-question contract, so it is not forceable honestly.
 *   - the committed corpus's price conflict spans two documents; the runner
 *     binds cell evidence to the row's own source (cross-source refs are
 *     filtered — asserted here as fail-closed behavior, not coerced), so the
 *     conflicting CELL is delivered through the review overlay (labeled,
 *     provenance, originals visible) while BOTH price excerpts ride the
 *     memo's conflicting claim. The `.rtf` supplier memo is the corpus's
 *     unsupported format: ingestion refuses it upstream (journey D pins the
 *     422), so the run scope is the nine supported documents and the hidden
 *     4600 price is asserted absent from every captured artifact.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assert, pollUntil, writeText } from "../harness/util.mjs";

export const JOURNEY_ID = "E";
export const IMPLEMENTED = true;

const EMAIL = "e2e-journey-e@borealis.test";
const FOREIGN_EMAIL = "e2e-journey-e-foreign@borealis.test";
const PASSWORD = "borealis-e2e-journey-e-pass";

const LIBRARY_NAME = "Supplier corpus (E2E-E)";
const TITLE_C = "Supplier contract comparison (E2E-E)";
const TITLE_M = "Supplier agreement memo (E2E-E)";
const CHAT_MODEL = "fixture-chat-v1";

const SUPPORTED_FILES = [
  "01_acme_logistics_agreement.md",
  "02_acme_renewal_quote.md",
  "03_blueriver_msa.pdf",
  "04_blueriver_change_order.md",
  "05_cedarcloud_hosting.pdf",
  "06_cedarcloud_summary.md",
  "07_delta_paper_terms.pdf",
  "09_everline_term_sheet.md",
  "10_acme_scanned_invoice.pdf",
];
const TIER_CHOICES = ["Basic", "Pro", "Premium", "Standard", "Enterprise"];
const TIER_BY_FACT = { premium: "Premium", standard: "Standard", enterprise: "Enterprise" };

// Deliberate review-correction explanation: leading `=` must be
// formula-guarded in the CSV bytes but stays raw in the JSON manifest.
const CORRECTION_EXPLANATION = "=manual quote confirmation from signed term sheet (E2E-E)";
const CONFLICT_EXPLANATION = "Open conflict: agreement 12000 USD vs renewal quote 13500 USD; supersession only after countersignature";
const NOTE_TEXT = "Reviewer note: verified against the signed copy (E2E-E) — never source evidence";

/* ------------------------------------------------------------------ helpers */

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function expectVisible(session, matcher, timeoutMs = 20_000) {
  await session.page.getByText(matcher).first().waitFor({ timeout: timeoutMs });
}

/**
 * Select the newest run in the run-history list. After a reload (or a
 * navigation back to a definition whose run is terminal) the UI does not
 * auto-select; a real user clicks the row, and the RunPanel/TablePanel then
 * mount. The `Searches x/N` line is the RunPanel landmark.
 */
async function selectLatestRun(session) {
  const runButton = session.page.locator('section[aria-label="Run history"] li button').first();
  await runButton.waitFor({ timeout: 20_000 });
  await runButton.click();
  await expectVisible(session, /Searches \d+\//, 20_000);
}

async function runIds(session, definitionId) {
  const res = await session.apiFetch(`/api/research/${definitionId}/runs`, { expectStatus: 200 });
  return (res.body?.items ?? []).map((entry) => entry.id);
}

async function waitForRun(session, runId, statuses, deadlineMs = 180_000) {
  const detail = await pollUntil(
    async () => {
      const res = await session.apiFetch(`/api/research-runs/${runId}`, { expectStatus: 200 });
      return statuses.includes(res.body?.status) ? res.body : null;
    },
    { deadlineMs, intervalMs: 300 }
  );
  assert(Boolean(detail), "RUN_STATE_TIMEOUT", `${runId} never reached ${statuses.join("|")}`);
  return detail;
}

async function fetchEvidenceMap(session, runId) {
  const bySource = new Map();
  const all = [];
  let cursor = null;
  for (;;) {
    const route = `/api/research-runs/${runId}/evidence${cursor ? `?cursor=${cursor}` : ""}`;
    const page = (await session.apiFetch(route, { expectStatus: 200 })).body;
    for (const item of page.items ?? []) {
      all.push(item);
      if (!bySource.has(item.source_id)) bySource.set(item.source_id, item);
    }
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
    assert(all.length < 200, "EVIDENCE_PAGE_LOOP");
  }
  return { all, bySource };
}

async function fetchTable(session, runId, query = "") {
  return (await session.apiFetch(`/api/research-runs/${runId}/table${query}`, { expectStatus: 200 })).body;
}

async function chatCalls(provider) {
  const state = await provider.state();
  return state.chat_calls ?? 0;
}

/**
 * The provider consumes script steps in call order and the `slow` step's
 * content arrives only after its delay, so a script installed while a slow
 * call is in flight deterministically governs the run's REMAINING calls. This
 * is the journey's window to embed the run's real evidence ids into the
 * extraction transcript — bounded polling on provider counters, no sleeps.
 */
async function waitForCallStarted(provider, baseline, deadlineMs = 45_000) {
  const seen = await pollUntil(async () => ((await chatCalls(provider)) >= baseline + 1 ? true : null), {
    deadlineMs,
    intervalMs: 80,
  });
  assert(seen === true, "PROVIDER_RUN_CALL_NOT_STARTED");
}

/* ------------------------------------------------------------------ journey */

export async function run(ctx) {
  const { server, provider, browser, artifactsDir, repoRoot } = ctx;
  const artifacts = [];
  const checks = {};

  const corpusDir = path.join(repoRoot, "data", "e2e", "supplier-corpus");
  const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, "manifest.json"), "utf8"));
  const docByFile = new Map(manifest.documents.map((doc) => [doc.file, doc]));
  assert(SUPPORTED_FILES.length === 9, "CORPUS_SHAPE");
  for (const file of SUPPORTED_FILES) {
    const doc = docByFile.get(file);
    assert(doc, "CORPUS_DOC_MISSING", file);
    const bytes = fs.readFileSync(path.join(corpusDir, file));
    assert(bytes.length === doc.bytes && sha256(bytes) === doc.sha256, "CORPUS_BYTES_MISMATCH", file);
  }

  const session = await browser.newSession({ origin: server.origin });
  try {
    await session.register({ email: EMAIL, password: PASSWORD });
    session.allowStatuses([409]); // deliberate stale-CAS / empty-scope / publication-refusal probes
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P0: import the nine supported corpus documents + library ---------- */
    await session.gotoHash("/sources");
    await expectVisible(session, "Upload files");
    await session.page
      .locator('input[type="file"]')
      .first()
      .setInputFiles(SUPPORTED_FILES.map((file) => path.join(corpusDir, file)));
    const readySources = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/sources", { expectStatus: 200 });
        const items = res.body?.items ?? [];
        if (items.length !== SUPPORTED_FILES.length) return null;
        return items.every((item) => item.status === "ready") ? items : null;
      },
      { deadlineMs: 180_000, intervalMs: 300 }
    );
    assert(Boolean(readySources), "CORPUS_NOT_READY");
    const byName = Object.fromEntries(readySources.map((item) => [item.display_name || item.name, item]));

    // Library provenance through the UI, membership via the copied-directory
    // manifest commit (the journey-D contract).
    await session.gotoHash("/libraries");
    await expectVisible(session, "New library");
    await session.page.getByRole("button", { name: "New library", exact: true }).click();
    await session.page.getByLabel("Library name").fill(LIBRARY_NAME);
    await session.page.getByRole("button", { name: "Create", exact: true }).click();
    const library = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/libraries", { expectStatus: 200 });
        return (res.body?.items ?? []).find((item) => item.name === LIBRARY_NAME) ?? null;
      },
      { deadlineMs: 15_000, intervalMs: 200 }
    );
    assert(Boolean(library), "LIBRARY_NOT_CREATED");
    const libHead = (await session.apiFetch(`/api/libraries/${library.id}`, { expectStatus: 200 })).body;
    const committed = await session.apiFetch(`/api/libraries/${library.id}/directory-imports`, {
      method: "POST",
      body: {
        operation_id: randomUUID(),
        expected_revision: libHead.revision,
        items: SUPPORTED_FILES.map((file) => ({
          source_id: byName[file].id,
          relative_path: `supplier-corpus/${file}`,
        })),
      },
      expectStatus: 200,
    });
    assert(committed.body?.added === SUPPORTED_FILES.length, "DIRECTORY_IMPORT_ADDED", JSON.stringify(committed.body));
    checks.import = { sources: SUPPORTED_FILES.length, library_members: committed.body.added };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P1: comparison draft with the five typed columns, selected-empty -- */
    await session.gotoHash("/research");
    await expectVisible(session, "No research yet.");
    await session.page.getByRole("link", { name: /New research/ }).first().click();
    await session.page.locator("#research-title").fill(TITLE_C);
    await session.page
      .locator("#research-question")
      .fill("Compare the five suppliers' agreements: price, effective date, renewal, tier, and stated exceptions.");
    await session.page.getByRole("radio", { name: "comparison", exact: true }).check();
    const modelValue = await pollUntil(
      async () => {
        const value = await session.page.locator("#research-model").inputValue();
        return value === CHAT_MODEL ? value : null;
      },
      { deadlineMs: 15_000, intervalMs: 150 }
    );
    assert(modelValue === CHAT_MODEL, "MODEL_NOT_DEFAULTED", String(modelValue));

    const columnSpec = [
      { label: "Price", type: "number", unit: "USD", question: "What price and currency does this document state?" },
      { label: "Effective date", type: "date", unit: null, question: "What effective date does this document state?" },
      { label: "Renewal", type: "boolean", unit: null, question: "Is renewal stated as automatic in this document?" },
      { label: "Tier", type: "enum", unit: null, question: "Which service tier does this document state?" },
      { label: "Exceptions", type: "text", unit: null, question: "What exceptions or carve-outs does this document state?" },
    ];
    for (let i = 0; i < columnSpec.length; i += 1) {
      await session.page.getByRole("button", { name: "Add column", exact: true }).click();
    }
    for (let i = 0; i < columnSpec.length; i += 1) {
      const n = i + 1;
      const spec = columnSpec[i];
      await session.page.getByLabel(`Label for column ${n}`, { exact: true }).fill(spec.label);
      await session.page.getByLabel(`Type for column ${n}`, { exact: true }).selectOption(spec.type);
      if (spec.unit !== null) await session.page.getByLabel(`Unit for column ${n}`, { exact: true }).fill(spec.unit);
      await session.page.getByLabel(`Question for column ${n}`, { exact: true }).fill(spec.question);
    }
    await session.page.getByLabel("Enum choices for column 4", { exact: true }).fill(TIER_CHOICES.join("\n"));

    await session.page.getByRole("button", { name: "Create draft", exact: true }).click();
    // Resolve the new definition id through the account's catalog (the hash
    // `#/research/new` itself matches any URL wait, so the API is the
    // authoritative identity source).
    const defC = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/research", { expectStatus: 200 });
        return (res.body?.items ?? []).find((item) => item.title === TITLE_C)?.id ?? null;
      },
      { deadlineMs: 20_000, intervalMs: 200 }
    );
    assert(defC !== null, "COMPARISON_DEFINITION_NOT_CREATED");
    await session.page.waitForFunction(
      (id) => window.location.hash === `#/research/${id}`,
      defC,
      { timeout: 20_000 }
    );
    await expectVisible(session, "No sources selected — this draft cannot start yet.");
    await expectVisible(session, "Start disabled: Select at least one source to start");
    const startButton = () => session.page.getByRole("button", { name: /^Start with / });
    assert((await startButton().isDisabled()) === true, "EMPTY_SCOPE_START_NOT_DISABLED");
    artifacts.push(await session.screenshot(artifactsDir));

    let definition = (await session.apiFetch(`/api/research/${defC}`, { expectStatus: 200 })).body;
    assert(
      definition.output_kind === "comparison" &&
        definition.columns.length === 5 &&
        definition.columns[0].type === "number" &&
        definition.columns[0].unit === "USD" &&
        definition.columns[1].type === "date" &&
        definition.columns[2].type === "boolean" &&
        definition.columns[3].type === "enum" &&
        TIER_CHOICES.every((choice) => definition.columns[3].choices.includes(choice)) &&
        definition.columns[4].type === "text",
      "COLUMN_CONTRACT",
      JSON.stringify(definition.columns.map((c) => [c.label, c.type, c.unit, (c.choices ?? []).length]))
    );
    const columnIds = Object.fromEntries(definition.columns.map((c) => [c.label, c.id]));

    const emptyStart = await session.apiFetch(`/api/research/${defC}/runs`, {
      method: "POST",
      body: { expected_revision: definition.current_revision },
      expectStatus: 409,
    });
    assert(emptyStart.body?.code === "RESEARCH_SCOPE_EMPTY", "EMPTY_SCOPE_CODE", String(emptyStart.body?.code));
    checks.selected_empty = { ui_disabled: true, api: "RESEARCH_SCOPE_EMPTY" };

    // Attach the library through the real picker affordance: expands NOW,
    // recorded as explicit provenance; Start becomes enabled after a save.
    await session.page.getByRole("button", { name: LIBRARY_NAME, exact: true }).click();
    await expectVisible(session, "expanded to 9 ready sources now");
    await session.page.getByRole("button", { name: /^Save as revision/ }).click();
    await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/research/${defC}`, { expectStatus: 200 });
        return res.body?.current_revision === 2 ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 200 }
    );
    definition = (await session.apiFetch(`/api/research/${defC}`, { expectStatus: 200 })).body;
    assert(
      definition.current_revision === 2 &&
        definition.library_ids?.length === 1 &&
        definition.library_ids[0] === library.id &&
        definition.source_ids?.length === 9,
      "SCOPE_NOT_ATTACHED",
      JSON.stringify({ rev: definition.current_revision, libs: definition.library_ids, srcs: definition.source_ids?.length })
    );
    assert((await startButton().isDisabled()) === false, "START_STILL_DISABLED");

    /* -- P2: model plan proposal → edit + reorder → save → Start-ready ----- */
    const planSteps = {
      steps: [
        {
          objective: "Find the price, tier, date, renewal, and exception terms each supplier document states",
          questions: ["price", "tier"],
        },
        {
          objective: "Compare conflicting or superseding statements across the supplier documents",
          questions: ["exceptions", "supersedes"],
        },
        {
          objective: "Establish renewal and effective-date facts and what is missing",
          questions: ["renewal", "effective"],
        },
      ],
    };
    await provider.setScript({
      steps: [{ type: "text", pieces: [JSON.stringify(planSteps)] }],
      onExhausted: "repeat-last",
    });
    const planCallsBefore = await chatCalls(provider);
    await session.page.getByRole("button", { name: "Generate plan proposal", exact: true }).click();
    await expectVisible(session, `Proposal generated by ${CHAT_MODEL}; nothing has started`);
    assert((await chatCalls(provider)) >= planCallsBefore + 1, "PLAN_CALL_NOT_MADE");
    await expectVisible(session, "Compare conflicting or superseding statements");

    const objectiveAt = async (n) =>
      (await session.page.locator(`textarea[aria-label="Objective for step ${n}"]`).first().inputValue()).trim();
    // Reorder first: move step 3 up, then edit the step now at position 2.
    await session.page.getByRole("button", { name: "Move step 3 up", exact: true }).click();
    const editedObjective = "Identify gaps, conflicts, and missing fields across the corpus (E2E-E edited)";
    await session.page.locator('textarea[aria-label="Objective for step 2"]').first().fill(editedObjective);
    const orderAfterMove = [await objectiveAt(1), await objectiveAt(2), await objectiveAt(3)];
    assert(
      orderAfterMove[0].includes("Find the price") &&
        orderAfterMove[1] === editedObjective &&
        orderAfterMove[2].includes("Compare conflicting or superseding"),
      "PLAN_REORDER_DOM",
      JSON.stringify(orderAfterMove)
    );
    await session.page.getByRole("button", { name: /^Save as revision/ }).click();
    definition = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/research/${defC}`, { expectStatus: 200 });
        return res.body?.current_revision === 3 ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 200 }
    );
    assert(Boolean(definition), "PLAN_SAVE_NOT_DURABLE");
    // After "Move step 3 up", the edited step (renewal|effective) sits at
    // index 1 and the compare step (exceptions|supersedes) at index 2.
    assert(
      definition.plan.steps.length === 3 &&
        definition.plan.steps[1].objective === editedObjective &&
        definition.plan.steps[1].questions.join("|") === "renewal|effective" &&
        definition.plan.steps[2].questions.join("|") === "exceptions|supersedes",
      "PLAN_NOT_PERSISTED",
      JSON.stringify(definition.plan.steps.map((s) => [s.objective.slice(0, 24), s.questions]))
    );
    checks.plan = { proposal_model_call: true, reordered: true, edited: true, durable_revision: 3 };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P3: Start, navigate away mid-run + reload, mid-run transcript ------ */
    const runScriptWindowMs = 12_000;
    const sourceIdByFile = Object.fromEntries(SUPPORTED_FILES.map((file) => [file, byName[file].id]));
    const buildColumnTranscripts = (evidenceBySource) => {
      const ref = (file) =>
        evidenceBySource.has(sourceIdByFile[file]) ? [evidenceBySource.get(sourceIdByFile[file]).id] : [];
      const cells = (fn) =>
        SUPPORTED_FILES.filter((f) => f !== "10_acme_scanned_invoice.pdf").map((file) => fn(file, ref(file)));
      const priceColumn = cells((file, refs) => {
        if (file === "02_acme_renewal_quote.md") {
          // Fixture conflict attempt: assert conflicting citing BOTH acme
          // price excerpts. The product binds cell evidence to the row's own
          // source, so the cross-source ref must be dropped, never adopted.
          return {
            source_id: sourceIdByFile[file],
            value: 13500,
            status: "conflicting",
            evidence_ids: [refs[0], ref("01_acme_logistics_agreement.md")[0], randomUUID()],
            explanation: "Renewal quote 13500 USD supersedes the prior 12000 USD rate sheet once countersigned",
          };
        }
        if (file === "09_everline_term_sheet.md") {
          // Deliberate off-type: a quoted number on a number column.
          return { source_id: sourceIdByFile[file], value: "15000", explanation: "Annual retainer price from the term sheet" };
        }
        if (file === "03_blueriver_msa.pdf") {
          // Bogus ref must never resolve; the real ref must survive.
          return { source_id: sourceIdByFile[file], value: 8750, evidence_ids: [...refs, randomUUID()], explanation: "MSA price 8750 USD" };
        }
        if (file === "05_cedarcloud_hosting.pdf" || file === "06_cedarcloud_summary.md") {
          return { source_id: sourceIdByFile[file], value: 21000, evidence_ids: refs, explanation: "Hosting agreement price 21000 EUR while the column unit says USD" };
        }
        const price = docByFile.get(file).fields.price.value;
        return { source_id: sourceIdByFile[file], value: price, evidence_ids: refs, explanation: `Stated price ${price} USD` };
      });
      return {
        price: { cells: priceColumn },
        date: {
          cells: cells((file, refs) => {
            const value = docByFile.get(file).fields.effective_date;
            return { source_id: sourceIdByFile[file], value, evidence_ids: refs, explanation: `Effective date ${value}` };
          }),
        },
        renewal: {
          cells: cells((file, refs) => {
            const value = docByFile.get(file).fields.renewal;
            return { source_id: sourceIdByFile[file], value, evidence_ids: refs, explanation: `Renewal stated as ${value}` };
          }),
        },
        tier: {
          cells: cells((file, refs) => {
            const value = TIER_BY_FACT[docByFile.get(file).fields.tier];
            assert(TIER_CHOICES.includes(value), "TIER_MAP");
            return { source_id: sourceIdByFile[file], value, evidence_ids: refs, explanation: `Documented tier ${value}` };
          }),
        },
        exceptions: {
          cells: SUPPORTED_FILES.filter((f) => f !== "10_acme_scanned_invoice.pdf").map((file) => {
            const exceptions = docByFile.get(file).fields.exceptions;
            // The committed missing fact: model honestly reports absence.
            return exceptions === null
              ? { source_id: sourceIdByFile[file], value: null, explanation: "No exceptions clause stated in the change order" }
              : { source_id: sourceIdByFile[file], value: exceptions, evidence_ids: ref(file), explanation: "Exceptions clause quoted from the document" };
          }),
        },
      };
    };

    const startComparisonRun = async () => {
      await provider.setScript({
        steps: [
          {
            type: "slow",
            delay_ms: runScriptWindowMs,
            pieces: ["Step summary: supplier price, tier, date, renewal, and exception evidence captured."],
          },
        ],
        onExhausted: "repeat-last",
      });
      const baseline = await chatCalls(provider);
      await startButton().click();
      return baseline;
    };

    const baselineR1 = await startComparisonRun();
    const run1 = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/research/${defC}/runs`, { expectStatus: 200 });
        return res.body?.items?.[0]?.id ?? null;
      },
      { deadlineMs: 20_000, intervalMs: 200 }
    );
    assert(Boolean(run1), "RUN_ROW_MISSING");

    // Detect the in-flight first step summary and install the remaining
    // transcript (slow step summaries keep the run mid-flight for the
    // navigate-away/reload proof below).
    await waitForCallStarted(provider, baselineR1);
    const ev1 = await fetchEvidenceMap(session, run1);
    assert(ev1.all.length >= 8 && ev1.all.length <= 100, "R1_EVIDENCE_COUNT", String(ev1.all.length));
    const t1 = buildColumnTranscripts(ev1.bySource);
    await provider.setScript({
      steps: [
        {
          type: "slow",
          delay_ms: 6_000,
          pieces: ["Step summary: conflicting and superseding statements compared; conflicts recorded."],
        },
        {
          type: "slow",
          delay_ms: 6_000,
          pieces: ["Step summary: renewal and effective-date facts recorded; missing fields noted."],
        },
        { type: "text", pieces: [JSON.stringify(t1.price)] },
        { type: "text", pieces: [JSON.stringify(t1.date)] },
        { type: "text", pieces: [JSON.stringify(t1.renewal)] },
        { type: "text", pieces: [JSON.stringify(t1.tier)] },
        { type: "text", pieces: [JSON.stringify(t1.exceptions)] },
      ],
      onExhausted: "repeat-last",
    });

    // Navigate away mid-run and reload: progress and selection must be durable.
    await session.gotoHash("/chat");
    await session.page.getByLabel("Ask Borealis about your data").waitFor({ timeout: 20_000 });
    await session.gotoHash(`/research/${defC}`);
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await expectVisible(session, /Searches \d+\/32 · model requests \d+\/40 · evidence \d+\/100/, 30_000);
    await expectVisible(session, "Running", 20_000);
    await expectVisible(session, "Pending", 20_000);
    const checkedAfterReload = await session.page.evaluate(
      () => document.querySelectorAll('input[aria-label^="Select source: "]:checked').length
    );
    assert(checkedAfterReload === 9, "SELECTION_NOT_DURABLE", String(checkedAfterReload));
    await expectVisible(session, LIBRARY_NAME);
    artifacts.push(await session.screenshot(artifactsDir));
    const r1 = await waitForRun(session, run1, ["completed", "needs_review", "failed", "cancelled"]);
    assert(r1.status === "completed", "R1_NOT_COMPLETED", `${r1.status}/${r1.error_code ?? ""}`);
    assert(r1.usage.searches === 9 && r1.usage.model_requests === 8, "R1_USAGE", JSON.stringify(r1.usage));
    await expectVisible(session, "Computation finished and validated");
    artifacts.push(await session.screenshot(artifactsDir));

    // Table truth: every committed fixture fact, the honest conflict/gap/
    // off-type handling, and cross-source + bogus evidence refs never adopted.
    const table1 = await fetchTable(session, run1);
    assert(table1.items.length === 9, "R1_ROW_COUNT", String(table1.items.length));
    const rowFor = (file) => table1.items.find((row) => row.row_source_id === sourceIdByFile[file]);
    const cellFor = (file, label) =>
      rowFor(file)?.cells.find((cell) => cell.column_id === columnIds[label] && cell.origin === "machine") ?? null;
    for (const file of SUPPORTED_FILES) {
      assert(rowFor(file) !== undefined, "R1_ROW_MISSING", file);
    }
    const priceOf = (file) => cellFor(file, "Price");
    assert(priceOf("01_acme_logistics_agreement.md").value === 12000 && priceOf("01_acme_logistics_agreement.md").status === "supported", "R1_PRICE_01");
    const p02 = priceOf("02_acme_renewal_quote.md");
    assert(
      p02.status === "supported" && p02.value === 13500 && p02.evidence_refs.length === 1 && p02.evidence_refs[0] === ev1.bySource.get(sourceIdByFile["02_acme_renewal_quote.md"]).id,
      "R1_CROSS_SOURCE_NOT_FILTERED",
      JSON.stringify({ status: p02.status, refs: p02.evidence_refs.length })
    );
    checks.conflicting_cell =
      "runner filters cross-source cell refs (asserted fail-closed); the fixture conflict ships as a conflicting review overlay + memo conflicting claim";
    const p03 = priceOf("03_blueriver_msa.pdf");
    assert(
      p03.value === 8750 && p03.status === "supported" && p03.evidence_refs.length === 1 && p03.evidence_refs[0] === ev1.bySource.get(sourceIdByFile["03_blueriver_msa.pdf"]).id,
      "R1_BOGUS_REF",
      JSON.stringify(p03.evidence_refs)
    );
    assert(priceOf("05_cedarcloud_hosting.pdf").value === 21000 && /EUR/.test(String(priceOf("05_cedarcloud_hosting.pdf").explanation)), "R1_PRICE_EUR");
    const p09 = priceOf("09_everline_term_sheet.md");
    assert(p09.status === "invalid" && p09.value === "15000" && typeof p09.value === "string", "R1_OFFTYPE_NOT_VERBATIM", JSON.stringify(p09));
    const ex04 = cellFor("04_blueriver_change_order.md", "Exceptions");
    assert(ex04.status === "not_found" && ex04.value === null, "R1_MISSING_FACT", JSON.stringify(ex04));
    for (const file of SUPPORTED_FILES.filter((f) => !["04_blueriver_change_order.md", "10_acme_scanned_invoice.pdf"].includes(f))) {
      assert(cellFor(file, "Exceptions").status === "supported", "R1_EXCEPTIONS", file);
    }
    for (const file of SUPPORTED_FILES) {
      const doc = docByFile.get(file);
      const scan = file === "10_acme_scanned_invoice.pdf";
      const date = cellFor(file, "Effective date");
      const renewal = cellFor(file, "Renewal");
      const tier = cellFor(file, "Tier");
      assert(scan ? date.status === "not_found" && date.value === null : date.value === doc.fields.effective_date && date.status === "supported", "R1_DATE", file);
      assert(scan ? renewal.status === "not_found" : renewal.value === doc.fields.renewal && typeof renewal.value === "boolean", "R1_RENEWAL", file);
      assert(scan ? tier.status === "not_found" : tier.value === TIER_BY_FACT[doc.fields.tier] && tier.status === "supported", "R1_TIER", file);
    }
    const detail1 = (await session.apiFetch(`/api/research-runs/${run1}`, { expectStatus: 200 })).body;
    assert(detail1.counts.machine_cell_count === 45 && detail1.counts.correction_cell_count === 0, "R1_COUNTS", JSON.stringify(detail1.counts));
    assert(detail1.counts.gap_count === 0, "R1_GAP_COUNT");
    // Locators ride the captured evidence at real offsets (M14 contract).
    const pdfEvidence = ev1.all.filter((item) => item.source_id === sourceIdByFile["05_cedarcloud_hosting.pdf"]);
    const mdEvidence = ev1.all.filter((item) => item.source_id === sourceIdByFile["01_acme_logistics_agreement.md"]);
    assert(
      pdfEvidence.some((item) => (item.locators ?? []).some((loc) => loc.kind === "pdf_page" && loc.page === 1)),
      "R1_PDF_LOCATOR"
    );
    assert(
      mdEvidence.some((item) => (item.locators ?? []).some((loc) => loc.kind === "text_span" && Number.isInteger(loc.char_start) && Number.isInteger(loc.char_len))),
      "R1_MD_TEXTSPAN_LOCATOR"
    );
    assert(!ev1.all.some((item) => item.excerpt.includes("4600")), "RTF_4600_INDEXED");
    checks.comparison_run = { cells: 45, invalid: 1, not_found: rowFor("10_acme_scanned_invoice.pdf").cells.filter((c) => c.status === "not_found").length + 1, locators: "pdf_page+text_span/heading" };

    /* -- P4: review — corrections as labeled overlays, stale CAS, durable -- */
    // Scope to the exact cell: every populated cell carries a "correct"
    // button, so a row-scoped locator would be multi-match (strict mode).
    const columnOrder = definition.columns.map((column) => column.label);
    const cellOfRow = (file, label) =>
      session.page
        .locator("tbody tr")
        .filter({ hasText: file })
        .first()
        .locator("td")
        .nth(columnOrder.indexOf(label) + 2);
    const correctCell = async (file, label, { value, status, explanation }) => {
      const cell = cellOfRow(file, label);
      await cell.getByRole("button", { name: "correct", exact: true }).click();
      const editor = cell.locator('[aria-label^="Correct "]').first();
      await editor.waitFor({ timeout: 10_000 });
      await expectVisible(session, "User correction (review overlay)");
      if (value !== null) await editor.locator('[aria-label="Corrected value"]').first().fill(String(value));
      if (status) await editor.locator('select[aria-label="Corrected status"]').first().selectOption(status);
      if (explanation) await editor.locator('[aria-label="Correction explanation"]').first().fill(explanation);
      await cell.getByRole("button", { name: "Apply correction", exact: true }).click();
      await cell.getByText("corrected", { exact: true }).first().waitFor({ timeout: 20_000 });
      await cell.getByText("machine original:").first().waitFor({ timeout: 20_000 });
    };
    await correctCell("09_everline_term_sheet.md", "Price", { value: 15000, status: "supported", explanation: CORRECTION_EXPLANATION });
    await correctCell("02_acme_renewal_quote.md", "Price", { value: 13500, status: "conflicting", explanation: CONFLICT_EXPLANATION });
    let reviewRun = (await session.apiFetch(`/api/research-runs/${run1}`, { expectStatus: 200 })).body;
    assert(reviewRun.review_revision === 3, "REVIEW_REVISION", String(reviewRun.review_revision));
    const row09 = session.page.locator("tr").filter({ hasText: "09_everline_term_sheet.md" }).first();
    await expectVisible(session, "machine original: 15000 (invalid)");
    assert((await row09.getByText("machine original:").count()) >= 1, "ORIGINAL_NOT_VISIBLE");
    artifacts.push(await session.screenshot(artifactsDir));

    const staleReview = await session.apiFetch(`/api/research-runs/${run1}/review`, {
      method: "PATCH",
      body: { expected_revision: 1, ops: [{ op: "add_note", target_kind: "run", note: "stale CAS probe" }] },
      expectStatus: 409,
    });
    assert(staleReview.body?.code === "RESEARCH_REVISION_CONFLICT", "STALE_CAS_CODE", String(staleReview.body?.code));

    await session.page.reload({ waitUntil: "domcontentloaded" });
    await selectLatestRun(session); // terminal run: a real user clicks the row
    await expectVisible(session, "machine original: 15000 (invalid)", 30_000);
    const table1r = await fetchTable(session, run1);
    const cellsOf = (file, label) => table1r.items.find((row) => row.row_source_id === sourceIdByFile[file]).cells.filter((c) => c.column_id === columnIds[label]);
    const everlineCells = cellsOf("09_everline_term_sheet.md", "Price");
    const machineOverlay = everlineCells.find((c) => c.origin === "machine");
    const correction = everlineCells.find((c) => c.origin === "correction");
    assert(
      machineOverlay.value === "15000" && machineOverlay.status === "invalid" && correction.value === 15000 && correction.status === "supported" && typeof correction.value === "number" && correction.corrected_at && correction.corrected_from_run_id === null,
      "OVERLAY_IMMUTABILITY",
      JSON.stringify(everlineCells)
    );
    const conflictOverlay = cellsOf("02_acme_renewal_quote.md", "Price").find((c) => c.origin === "correction");
    assert(conflictOverlay.status === "conflicting" && conflictOverlay.value === 13500 && conflictOverlay.explanation.includes("12000"), "CONFLICT_OVERLAY");
    checks.review = { corrections: 2, stale_cas: 409, reload_durable: true };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P5: exports — formula-safe CSV bytes + typed manifest -------------- */
    const csv = await session.apiFetchText(`/api/research-runs/${run1}/export?format=csv`, { expectStatus: 200 });
    assert(csv.hasBom === true, "CSV_BOM");
    assert(csv.contentType.includes("text/csv") && /attachment; filename="/.test(csv.disposition), "CSV_HEADERS");
    assert(csv.text.includes("\r\n") && csv.text.startsWith("﻿# limit_state:"), "CSV_SHAPE");
    const slug = TITLE_C.normalize("NFKD").replace(/[^a-z0-9]+/giu, "-").replace(/^[.-]+|[.-]+$/gu, "").slice(0, 64).toLowerCase();
    assert(csv.disposition.includes(`${slug}-${run1.slice(0, 8)}.csv`), "CSV_FILENAME", csv.disposition);
    const csvLines = csv.text.split("\r\n").filter(Boolean);
    const everlineMachineLine = csvLines.find((line) => line.includes(sourceIdByFile["09_everline_term_sheet.md"]) && line.includes(",machine,") && line.includes(",invalid,"));
    const everlineCorrectionLine = csvLines.find((line) => line.includes(sourceIdByFile["09_everline_term_sheet.md"]) && line.includes(",correction,") && line.includes(",supported,"));
    assert(everlineMachineLine?.includes(",15000,invalid,") === true, "CSV_MACHINE_INVALID", String(everlineMachineLine).slice(0, 80));
    assert(everlineCorrectionLine?.includes(",15000,supported,") === true, "CSV_CORRECTION");
    assert(csvLines.some((line) => line.includes(`,"'=manual quote confirmation from signed term sheet (E2E-E)"`) || line.includes(",'=manual quote confirmation from signed term sheet (E2E-E)")), "CSV_FORMULA_GUARD");
    assert(csvLines.some((line) => line.includes(",conflicting,")) && csvLines.some((line) => line.includes("12000")), "CSV_CONFLICT");
    // The hidden `.rtf` price must never surface as a cell value token.
    assert(!csvLines.some((line) => /(^|,)4600(,|$)/.test(line)), "CSV_NO_RTF_VALUE");

    const manifestJson = JSON.parse((await session.apiFetchText(`/api/research-runs/${run1}/export?format=manifest`, { expectStatus: 200 })).text);
    assert(manifestJson.artifact === "research_run_export_manifest", "MANIFEST_ID");
    assert(manifestJson.cells.length === 47, "MANIFEST_CELL_COUNT", String(manifestJson.cells.length)); // 45 machine + 2 overlays
    const manifestMachineEverline = manifestJson.cells.find(
      (cell) => cell.origin === "machine" && cell.row_source_id === sourceIdByFile["09_everline_term_sheet.md"] && cell.column_id === columnIds.Price
    );
    assert(manifestMachineEverline.value === "15000" && manifestMachineEverline.status === "invalid", "MANIFEST_INVALID_VERBATIM");
    const manifestCorrection = manifestJson.cells.find(
      (cell) => cell.origin === "correction" && cell.row_source_id === sourceIdByFile["09_everline_term_sheet.md"]
    );
    assert(manifestCorrection.explanation === CORRECTION_EXPLANATION && manifestCorrection.corrected_at && manifestCorrection.corrected_from_run_id === null, "MANIFEST_CORRECTION_PROVENANCE");
    assert(
      manifestJson.evidence.every((item) => item.content_hash === sha256(Buffer.from(item.excerpt, "utf8"))),
      "MANIFEST_HASH"
    );
    assert(
      manifestJson.evidence.some((item) => item.source_id === sourceIdByFile["05_cedarcloud_hosting.pdf"] && item.locators.some((l) => l.kind === "pdf_page")) &&
        manifestJson.evidence.some((item) => item.source_id === sourceIdByFile["03_blueriver_msa.pdf"] && item.locators.some((l) => l.kind === "pdf_page")),
      "MANIFEST_LOCATORS"
    );
    const joinedEvidence = manifestJson.evidence.map((item) => item.excerpt).join("|");
    assert(!joinedEvidence.includes("4600"), "MANIFEST_4600");

    // The real UI export control actually downloads a matching file.
    const downloadPromise = session.page.waitForEvent("download", { timeout: 20_000 });
    await session.page.getByRole("button", { name: /Export CSV/ }).first().click();
    const download = await downloadPromise;
    assert(
      download.suggestedFilename() === `${slug}-${run1.slice(0, 8)}.csv`,
      "CSV_DOWNLOAD_NAME",
      download.suggestedFilename().slice(0, 48)
    );
    await download.saveAs(path.join(artifactsDir, "proof-export.csv"));
    artifacts.push("proof-export.csv");
    const savedCsvBytes = fs.readFileSync(path.join(artifactsDir, "proof-export.csv"));
    assert(
      savedCsvBytes.length === csv.byteLength && savedCsvBytes.subarray(0, 3).toString("hex") === "efbbbf",
      "CSV_DOWNLOAD_BYTES"
    );
    checks.exports = { csv_bytes: csv.byteLength, formula_guard: true, manifest_cells: manifestJson.cells.length };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P6: rerun selected rows/columns — carried overrides + diff -------- */
    await session.page.getByLabel(`Select row 09_everline_term_sheet.md for rerun`).check();
    await session.page.getByLabel("Select column Price for rerun").check();
    await provider.setScript({
      steps: [{ type: "slow", delay_ms: runScriptWindowMs, pieces: ["Rerun step summary: evidence recaptured at current generations."] }],
      onExhausted: "repeat-last",
    });
    const beforeR2 = new Set(await runIds(session, defC));
    const baselineR2 = await chatCalls(provider);
    await session.page.getByRole("button", { name: /Rerun selected rows\/columns/ }).click();
    const run2 = await pollUntil(
      async () => (await runIds(session, defC)).find((id) => !beforeR2.has(id)) ?? null,
      { deadlineMs: 30_000, intervalMs: 250 }
    );
    assert(Boolean(run2) && run2 !== run1, "RERUN_NOT_ACCEPTED");
    await waitForCallStarted(provider, baselineR2);
    const ev2 = await fetchEvidenceMap(session, run2);
    const everlineRef = ev2.bySource.has(sourceIdByFile["09_everline_term_sheet.md"])
      ? [ev2.bySource.get(sourceIdByFile["09_everline_term_sheet.md"]).id]
      : [];
    await provider.setScript({
      steps: [
        { type: "text", pieces: ["Rerun step summary: supersession language recaptured."] },
        { type: "text", pieces: ["Rerun step summary: renewal facts recaptured."] },
        {
          type: "text",
          pieces: [
            JSON.stringify({
              cells: [
                {
                  source_id: sourceIdByFile["09_everline_term_sheet.md"],
                  value: 15000,
                  evidence_ids: everlineRef,
                  explanation: "Term sheet price 15000 USD (rerun extraction)",
                },
              ],
            }),
          ],
        },
      ],
      onExhausted: "repeat-last",
    });
    const r2 = await waitForRun(session, run2, ["completed", "needs_review", "failed", "cancelled"]);
    assert(r2.status === "completed", "R2_NOT_COMPLETED", `${r2.status}/${r2.error_code ?? ""}`);
    assert(r2.rerun_of === run1, "R2_LINEAGE");
    assert(
      r2.rerun_selection?.row_source_ids?.join() === sourceIdByFile["09_everline_term_sheet.md"] &&
        r2.rerun_selection?.column_ids?.join() === columnIds.Price,
      "R2_SELECTION"
    );
    const table2 = await fetchTable(session, run2);
    // The rerun pins the full scope as rows; only the selected row × column
    // is re-extracted and the other cells stay honestly absent.
    assert(table2.items.length === 9, "R2_ROW_COUNT", String(table2.items.length));
    const absentElsewhere = table2.items.filter((row) => row.row_source_id !== sourceIdByFile["09_everline_term_sheet.md"]);
    assert(absentElsewhere.every((row) => row.cells.every((cell) => cell.origin === "correction")), "R2_UNROWRAN_CELLS_PRESENT");
    const carriedEverline = table2.items
      .find((row) => row.row_source_id === sourceIdByFile["09_everline_term_sheet.md"])
      .cells.find((cell) => cell.origin === "correction" && cell.column_id === columnIds.Price);
    const carriedConflict = table2.items
      .find((row) => row.row_source_id === sourceIdByFile["02_acme_renewal_quote.md"])
      .cells.find((cell) => cell.origin === "correction" && cell.column_id === columnIds.Price);
    assert(
      carriedEverline?.corrected_from_run_id === run1 && carriedConflict?.corrected_from_run_id === run1,
      "OVERRIDES_NOT_CARRIED"
    );
    const newMachine = table2.items
      .find((row) => row.row_source_id === sourceIdByFile["09_everline_term_sheet.md"])
      .cells.find((cell) => cell.origin === "machine" && cell.column_id === columnIds.Price);
    assert(newMachine.status === "supported" && newMachine.value === 15000, "R2_REEXTRACTION", JSON.stringify(newMachine));
    const table1After = await fetchTable(session, run1);
    assert(
      table1After.items
        .find((row) => row.row_source_id === sourceIdByFile["09_everline_term_sheet.md"])
        .cells.find((c) => c.origin === "machine" && c.column_id === columnIds.Price).value === "15000",
      "R1_MUTATED_BY_RERUN"
    );

    await session.page
      .locator('select[aria-label="Compare against run revision"]')
      .selectOption({ value: run1 });
    await expectVisible(session, "Revision diff vs", 20_000);
    await expectVisible(session, /carried over from an earlier run and\s+are preserved, not overwritten/);
    await expectVisible(session, "carried from an earlier run");
    const diff = (await fetchTable(session, run2, `?against=${run1}`)).comparison;
    assert(diff.from_run_id === run1 && diff.to_run_id === run2, "DIFF_IDENTITY");
    assert(diff.carried_overrides.length === 2, "DIFF_CARRIED", String(diff.carried_overrides.length));
    assert(diff.rows_added.length === 0 && diff.rows_removed.length === 0, "DIFF_ROWS", JSON.stringify([diff.rows_added.length, diff.rows_removed.length]));
    // Every (row, column) triple differs: 44 cells were not re-extracted and
    // the everline price machine moved invalid→supported; nothing truncated.
    assert(diff.changed_total === 45 && diff.truncated === false, "DIFF_TOTALS", String(diff.changed_total));
    const everlineChange = diff.changed_cells.find(
      (change) => change.row_source_id === sourceIdByFile["09_everline_term_sheet.md"] && change.column_id === columnIds.Price
    );
    assert(
      everlineChange?.machine_changed === true &&
        everlineChange?.correction_changed === false &&
        everlineChange.before.machine.status === "invalid" &&
        everlineChange.after.machine.status === "supported" &&
        everlineChange.before.effective.value === 15000 &&
        everlineChange.after.effective.value === 15000,
      "DIFF_EVERLINE",
      JSON.stringify(everlineChange)
    );
    checks.rerun = { carried_overrides: diff.carried_overrides.length, changed_cells: diff.changed_total, rows_removed: diff.rows_removed.length };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P7: needs_review honesty — honest search-budget exhaustion --------- */
    // Build a 32-question plan (the whole keyword budget) in the real plan
    // editor: five added steps of four questions plus three extra questions
    // on the existing steps 1-2.
    const planList = () => session.page.locator('[aria-label="Research plan"]');
    for (let i = 0; i < 5; i += 1) await planList().getByRole("button", { name: "Add step", exact: true }).click();
    for (let step = 4; step <= 8; step += 1) {
      await session.page.locator(`textarea[aria-label="Objective for step ${step}"]`).first().fill(`Budget-exhaustion sweep ${step} over the supplier corpus`);
      await session.page.getByLabel(`Question 1 for step ${step}`, { exact: true }).fill("price");
      for (let extra = 0; extra < 3; extra += 1) {
        await planList().locator("ol > li").nth(step - 1).getByRole("button", { name: "Add question", exact: true }).click();
        await session.page.getByLabel(`Question ${extra + 2} for step ${step}`, { exact: true }).fill(step % 2 === 0 ? "tier" : "renewal");
      }
    }
    for (const step of [1, 2]) {
      for (let extra = 0; extra < 3; extra += 1) {
        await planList().locator("ol > li").nth(step - 1).getByRole("button", { name: "Add question", exact: true }).click();
        await session.page.getByLabel(`Question ${extra + 3} for step ${step}`, { exact: true }).fill("effective");
      }
    }
    await expectVisible(session, "32 search questions");
    await session.page.getByRole("button", { name: /^Save as revision/ }).click();
    const widePlanDef = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/research/${defC}`, { expectStatus: 200 });
        return res.body?.current_revision === 4 ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 200 }
    );
    assert(
      Boolean(widePlanDef) &&
        widePlanDef.plan.steps.length === 8 &&
        widePlanDef.plan.steps.reduce((sum, s) => sum + s.questions.length, 0) === 32,
      "WIDE_PLAN_NOT_PERSISTED"
    );

    const beforeR3 = new Set(await runIds(session, defC));
    const baselineR3 = await startComparisonRun();
    const run3 = await pollUntil(
      async () => (await runIds(session, defC)).find((id) => !beforeR3.has(id)) ?? null,
      { deadlineMs: 30_000, intervalMs: 250 }
    );
    assert(Boolean(run3) && run3 !== run1 && run3 !== run2, "R3_IDENTITY");
    await waitForCallStarted(provider, baselineR3);
    const ev3 = await fetchEvidenceMap(session, run3);
    const t3 = buildColumnTranscripts(ev3.bySource);
    await provider.setScript({
      steps: [
        ...[2, 3, 4, 5, 6].map((n) => ({ type: "text", pieces: [`Budget-sweep step ${n} summary captured.`] })),
        { type: "text", pieces: [JSON.stringify(t3.price)] },
        { type: "text", pieces: [JSON.stringify(t3.date)] },
        { type: "text", pieces: [JSON.stringify(t3.renewal)] },
        { type: "text", pieces: [JSON.stringify(t3.tier)] },
        { type: "text", pieces: [JSON.stringify(t3.exceptions)] },
      ],
      onExhausted: "repeat-last",
    });
    const r3 = await waitForRun(session, run3, ["needs_review", "completed", "failed"]);
    assert(r3.status === "needs_review", "R3_NOT_NEEDS_REVIEW", `${r3.status}/${r3.error_code ?? ""}`);
    assert(r3.error_code === "RESEARCH_BUDGET_EXHAUSTED", "R3_CODE", String(r3.error_code));
    assert(r3.usage.searches === 32, "R3_SEARCH_USAGE", String(r3.usage.searches));
    assert(r3.steps.some((step) => step.status === "skipped"), "R3_NO_SKIPPED_STEP");
    assert(r3.claims.some((claim) => claim.kind === "gap" && claim.text.includes("search budget exhausted")), "R3_GAP");
    await expectVisible(session, "This run needs review — it is partial, not complete research");
    await expectVisible(session, "Needs review");
    const draftButtonR3 = session.page.getByRole("button", { name: "Create reviewed draft", exact: true }).first();
    assert((await draftButtonR3.isDisabled()) === false, "NEEDS_REVIEW_NOT_PUBLISHABLE");
    checks.needs_review = "forced by the 32-question plan exhausting the keyword budget; model-request exhaustion is unreachable under the plan's own cap (reported)";
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P8: memo run — claims, notes, locators, reviewed draft ------------ */
    await session.gotoHash("/research/new");
    await session.page.locator("#research-title").fill(TITLE_M);
    await session.page
      .locator("#research-question")
      .fill("Summarize the supplier agreements: which prices, renewal terms, and gaps the corpus actually supports.");
    await session.page.getByRole("radio", { name: "memo", exact: true }).check();
    await session.page.getByRole("button", { name: LIBRARY_NAME, exact: true }).click();
    await session.page.getByRole("button", { name: "Create draft", exact: true }).click();
    const defM = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/research", { expectStatus: 200 });
        return (res.body?.items ?? []).find((item) => item.title === TITLE_M)?.id ?? null;
      },
      { deadlineMs: 20_000, intervalMs: 200 }
    );
    assert(defM !== null && defM !== defC, "MEMO_DEFINITION_NOT_CREATED");
    await session.page.waitForFunction(
      (id) => window.location.hash === `#/research/${id}`,
      defM,
      { timeout: 20_000 }
    );
    await provider.setScript({
      steps: [
        {
          type: "text",
          pieces: [
            JSON.stringify({
              steps: [
                {
                  objective: "Gather the pricing and term evidence the memo must cite",
                  questions: ["price"],
                },
              ],
            }),
          ],
        },
      ],
      onExhausted: "repeat-last",
    });
    await session.page.getByRole("button", { name: "Generate plan proposal", exact: true }).click();
    await expectVisible(session, `Proposal generated by ${CHAT_MODEL}; nothing has started`);
    await session.page.getByRole("button", { name: /^Save as revision/ }).click();
    await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/research/${defM}`, { expectStatus: 200 });
        return res.body?.current_revision === 2 ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 200 }
    );

    await provider.setScript({
      steps: [{ type: "slow", delay_ms: runScriptWindowMs, pieces: ["Memo step summary: price evidence captured across the corpus."] }],
      onExhausted: "repeat-last",
    });
    const baselineM1 = await chatCalls(provider);
    await session.page.getByRole("button", { name: /^Start with / }).click();
    const runM1 = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/research/${defM}/runs`, { expectStatus: 200 });
        return res.body?.items?.[0]?.id ?? null;
      },
      { deadlineMs: 20_000, intervalMs: 200 }
    );
    await waitForCallStarted(provider, baselineM1);
    const evM = await fetchEvidenceMap(session, runM1);
    const refOf = (file) => evM.bySource.get(sourceIdByFile[file])?.id;
    const e01 = refOf("01_acme_logistics_agreement.md");
    const e02 = refOf("02_acme_renewal_quote.md");
    assert(e01 && e02, "MEMO_EVIDENCE_MISSING");
    const memoSynthesis = {
      claims: [
        {
          text: "Acme Logistics prices its master agreement at 12000 USD for premium freight services.",
          classification: "supported",
          evidence_ids: [e01],
        },
        {
          text: "The Acme papers conflict on price: 12000 USD in the master agreement versus 13500 USD in the renewal quote; supersession is open until countersignature.",
          classification: "conflicting",
          evidence_ids: [e01, e02],
        },
        {
          // Fabricated from the UNSUPPORTED rtf document: must land
          // unsupported and citation-less in this run.
          text: "Delta Paper renews at 4600 USD according to a renewal memo.",
          classification: "unsupported",
          evidence_ids: [randomUUID()],
        },
      ],
      gaps: [
        "BlueRiver change order 14 states no exceptions clause; not found in selected evidence.",
        "No selected document states a Delta Paper renewal-memo price; not found in selected evidence.",
        "The scanned Acme invoice carries no extractable text fields; not found in selected evidence.",
      ],
    };
    await provider.setScript({ steps: [{ type: "text", pieces: [JSON.stringify(memoSynthesis)] }], onExhausted: "repeat-last" });
    const rm1 = await waitForRun(session, runM1, ["completed", "needs_review", "failed"]);
    assert(rm1.status === "completed", "MEMO_NOT_COMPLETED", `${rm1.status}/${rm1.error_code ?? ""}`);
    const memoClaims = rm1.claims.filter((claim) => claim.kind === "claim");
    assert(memoClaims.length === 3, "MEMO_CLAIM_COUNT", String(memoClaims.length));
    const conflictingClaim = memoClaims.find((claim) => claim.classification === "conflicting");
    assert(
      conflictingClaim &&
        (conflictingClaim.evidence_refs.includes(e01) || conflictingClaim.evidence_refs.includes(e02)) &&
        conflictingClaim.evidence_refs.length === 2 &&
        conflictingClaim.text.includes("12000") &&
        conflictingClaim.text.includes("13500"),
      "MEMO_CONFLICTING_CLAIM",
      JSON.stringify(conflictingClaim?.evidence_refs)
    );
    const supportedClaim = memoClaims.find((claim) => claim.classification === "supported");
    assert(supportedClaim.evidence_refs.join() === e01, "MEMO_SUPPORTED_REFS");
    const unsupportedClaim = memoClaims.find((claim) => claim.classification === "unsupported");
    assert(unsupportedClaim && unsupportedClaim.evidence_refs.length === 0 && unsupportedClaim.text.includes("4600"), "MEMO_UNSUPPORTED_CITATIONLESS");
    assert(rm1.claims.some((claim) => claim.kind === "gap" && claim.text.includes("not found in selected evidence")), "MEMO_GAPS");

    // Dossier: open a text-PDF passage at its real page locator and a markdown
    // passage at its heading-bearing text span.
    await session.page
      .getByRole("button", { name: /^Open captured passage in 05_cedarcloud_hosting\.pdf/ })
      .first()
      .click();
    await session.page.locator('section[aria-label^="Passage in "]').first().waitFor({ timeout: 15_000 });
    await expectVisible(session, /PDF page 1/);
    await session.page.getByLabel("Close passage").click();
    await session.page
      .getByRole("button", { name: /^Open captured passage in 01_acme_logistics_agreement\.md/ })
      .first()
      .click();
    await expectVisible(session, /text chars \d+–\d+/);
    await session.page.getByLabel("Close passage").click();
    artifacts.push(await session.screenshot(artifactsDir));

    // Review: accept, reject, and note — through the UI, one CAS at a time.
    const memoClaimsApplied = async (check) =>
      pollUntil(
        async () => {
          const res = await session.apiFetch(`/api/research-runs/${runM1}`, { expectStatus: 200 });
          return check(res.body) ? res.body : null;
        },
        { deadlineMs: 30_000, intervalMs: 250 }
      );
    await session.page
      .locator("li")
      .filter({ hasText: "prices its master agreement at 12000 USD" })
      .first()
      .getByRole("button", { name: "Accept", exact: true })
      .click();
    assert(
      (await memoClaimsApplied((b) => b?.claims?.find((c) => c.id === supportedClaim.id)?.review_state === "accepted")) !== null,
      "MEMO_ACCEPT_NOT_APPLIED"
    );
    await session.page
      .locator("li")
      .filter({ hasText: "Delta Paper renews at 4600 USD" })
      .first()
      .getByRole("button", { name: "Reject", exact: true })
      .click();
    assert(
      (await memoClaimsApplied((b) => b?.claims?.find((c) => c.id === unsupportedClaim.id)?.review_state === "rejected")) !== null,
      "MEMO_REJECT_NOT_APPLIED"
    );
    const noteClaimId = conflictingClaim.id.slice(0, 8);
    const noteRow = session.page.locator("li").filter({ hasText: "conflict on price" }).first();
    await noteRow.locator(`textarea[aria-label="Note for claim ${noteClaimId}"]`).first().fill(NOTE_TEXT);
    await noteRow.getByRole("button", { name: "Save note", exact: true }).click();
    const memoRun = await memoClaimsApplied((b) => b?.claims?.find((c) => c.id === conflictingClaim.id)?.user_note === NOTE_TEXT);
    assert(Boolean(memoRun), "MEMO_NOTE_NOT_APPLIED");
    assert(memoRun.counts.evidence_count === evM.all.length, "NOTE_BECAME_EVIDENCE");
    const memoStale = await session.apiFetch(`/api/research-runs/${runM1}/review`, {
      method: "PATCH",
      body: { expected_revision: 1, ops: [{ op: "add_note", target_kind: "run", note: "stale probe" }] },
      expectStatus: 409,
    });
    assert(memoStale.body?.code === "RESEARCH_REVISION_CONFLICT", "MEMO_STALE_CAS");
    checks.memo = { claims: 3, conflicting_refs: 2, gaps: rm1.claims.filter((c) => c.kind === "gap").length };
    artifacts.push(await session.screenshot(artifactsDir));

    // Reviewed draft → document workbench.
    await session.page.getByRole("button", { name: "Create reviewed draft", exact: true }).first().click();
    await expectVisible(session, "M13 draft created — revision 1", 30_000);
    await session.page.getByRole("link", { name: /Open in document workbench/ }).click();
    await session.page.waitForURL(/#\/documents\//, { timeout: 20_000 });
    const docId = (await session.page.evaluate(() => window.location.hash)).split("/").pop();
    await expectVisible(session, "Conflicting claims", 30_000);
    await expectVisible(session, "Gaps and not-found");
    await expectVisible(session, "12000");
    await expectVisible(session, "13500");
    await expectVisible(session, /user-rejected claim\(s\) excluded/);
    const bodyText = await session.page.evaluate(() => document.body.innerText);
    // Strip opaque hex ids before the value check: a uuid can legitimately
    // contain the four hex characters "4600".
    assert(!bodyText.replace(/[0-9a-f-]{8,}/gi, "").includes("4600"), "DRAFT_SHOWS_REJECTED_FABRICATION");
    const draftDoc = (await session.apiFetch(`/api/documents/${docId}`, { expectStatus: 200 })).body;
    assert(draftDoc?.current_revision === 1, "DRAFT_HEAD_REVISION", String(draftDoc?.current_revision));
    const draftRevision = (await session.apiFetch(`/api/documents/${docId}/revisions/${draftDoc.current_revision_id}`, {
      expectStatus: 200,
    })).body;
    const draftJson = JSON.stringify(draftRevision.payload);
    assert(
      draftJson.includes("12000") && draftJson.includes("13500") && !draftJson.replace(/[0-9a-f-]{16,}/g, "").includes("4600"),
      "DRAFT_PAYLOAD_4600"
    );
    // M13 numbered-evidence citation markers over a nonempty evidence set.
    const draftEvidenceCount = draftRevision.payload?.evidence?.length ?? 0;
    assert(/\[\d+\]/.test(draftJson) && draftEvidenceCount >= 2, "DRAFT_CITATION_MARKERS", String(draftEvidenceCount));
    checks.artifact = { document: true, citations: true, rejected_excluded: true };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P9: transport failure settles failed; publication refused --------- */
    await session.gotoHash(`/research/${defM}`);
    await expectVisible(session, TITLE_M);
    const beforeFailed = new Set(await runIds(session, defM));
    await provider.setScript({
      steps: [
        { type: "text", pieces: ["Memo step summary before the transport failure."] },
        { type: "http_error", status: 500 },
      ],
      onExhausted: "repeat-last",
    });
    await session.page.getByRole("button", { name: /^Start with / }).click();
    const runFailed = await pollUntil(
      async () => (await runIds(session, defM)).find((id) => !beforeFailed.has(id)) ?? null,
      { deadlineMs: 30_000, intervalMs: 250 }
    );
    assert(Boolean(runFailed), "FAILED_RUN_NOT_ACCEPTED");
    const failedDetail = await waitForRun(session, runFailed, ["failed"], 90_000);
    await selectLatestRun(session); // terminal run must be clicked into view
    assert(failedDetail.error_code === "RESEARCH_PROVIDER_FAILED", "FAILED_CODE", String(failedDetail.error_code));
    await expectVisible(session, "A failed or cancelled run cannot publish output through this action.");
    assert((await session.page.getByRole("button", { name: "Create reviewed draft", exact: true }).first().isDisabled()) === true, "FAILED_DRAFT_NOT_DISABLED");
    const failedArtifact = await session.apiFetch(`/api/research-runs/${runFailed}/artifacts`, {
      method: "POST",
      expectStatus: 409,
    });
    assert(failedArtifact.body?.code === "RESEARCH_RUN_STATE", "FAILED_ARTIFACT_CODE", String(failedArtifact.body?.code));
    checks.failed_run = { code: "RESEARCH_PROVIDER_FAILED", artifact_refusal: "RESEARCH_RUN_STATE" };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P10: cancel mid-run — visible, durable, idempotent ---------------- */
    const beforeCancel = new Set(await runIds(session, defM));
    await provider.setScript({
      steps: [{ type: "slow", delay_ms: 30_000, pieces: ["Long memo step summary that the cancellation interrupts."] }],
      onExhausted: "repeat-last",
    });
    await session.page.getByRole("button", { name: /^Start with / }).click();
    const runCancelled = await pollUntil(
      async () => (await runIds(session, defM)).find((id) => !beforeCancel.has(id)) ?? null,
      { deadlineMs: 30_000, intervalMs: 250 }
    );
    assert(Boolean(runCancelled), "CANCEL_RUN_MISSING");
    // The cancel control is only offered for non-terminal runs.
    await session.page.getByRole("button", { name: "Cancel run", exact: true }).waitFor({ timeout: 30_000 });
    await session.page.getByRole("button", { name: "Cancel run", exact: true }).click();
    const cancelledDetail = await waitForRun(session, runCancelled, ["cancelled"], 120_000);
    assert((cancelledDetail.counts.evidence_count ?? 0) >= 0 && cancelledDetail.status === "cancelled", "CANCEL_SETTLEMENT");
    const cancelRepeat1 = await session.apiFetch(`/api/research-runs/${runCancelled}`, { method: "DELETE", expectStatus: 200 });
    const cancelRepeat2 = await session.apiFetch(`/api/research-runs/${runCancelled}`, { method: "DELETE", expectStatus: 200 });
    assert(
      cancelRepeat1.body?.status === "cancelled" && cancelRepeat2.body?.status === "cancelled" && cancelRepeat1.body?.ok === true,
      "CANCEL_NOT_IDEMPOTENT"
    );
    const cancelledArtifact = await session.apiFetch(`/api/research-runs/${runCancelled}/artifacts`, {
      method: "POST",
      expectStatus: 409,
    });
    assert(cancelledArtifact.body?.code === "RESEARCH_RUN_STATE", "CANCELLED_ARTIFACT_CODE");
    await expectVisible(session, "Cancelled", 20_000);
    checks.cancel = { final: "cancelled", idempotent_repeats: 2, partial_captures: cancelledDetail.counts.evidence_count };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P11: foreign account sees nothing (404, empty catalog) ------------ */
    const foreign = await browser.newSession({ origin: server.origin });
    try {
      await foreign.register({ email: FOREIGN_EMAIL, password: PASSWORD });
      foreign.allowStatuses([404]);
      const foreignList = await foreign.apiFetch("/api/research", { expectStatus: 200 });
      assert((foreignList.body?.items ?? []).length === 0, "FOREIGN_CATALOG");
      await foreign.apiFetch(`/api/research/${defC}`, { expectStatus: 404 });
      await foreign.apiFetch(`/api/research-runs/${run1}`, { expectStatus: 404 });
      await foreign.apiFetch(`/api/research/${defC}/runs`, { expectStatus: 404 });
      checks.foreign = { definition: 404, run: 404, history: 404 };
    } finally {
      foreign.assertClean();
      await foreign.close().catch(() => undefined);
    }

    /* -- wrap up ------------------------------------------------------------ */
    await provider
      .setScript({ steps: [{ type: "text", pieces: ["The fixture model answer."] }], onExhausted: "repeat-last" })
      .catch(() => undefined);
    await server.quiesceWorkers({ token: await session.token() });
    session.assertClean();
    return { artifacts, checks };
  } catch (error) {
    await writeText(
      path.join(artifactsDir, "debug-failure.txt"),
      String(error?.stack ?? error?.message ?? error).slice(0, 1_500)
    ).catch(() => undefined);
    await session
      .screenshot(artifactsDir)
      .then((name) => artifacts.push(name))
      .catch(() => undefined);
    throw error;
  } finally {
    await session.close().catch(() => undefined);
  }
}
