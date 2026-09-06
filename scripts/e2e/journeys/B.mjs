/**
 * Journey B — Repeatable finance analysis (docs/END_TO_END_ACCEPTANCE.md).
 *
 * Real production build + real Chromium + scripted provider; the four
 * deterministic finance CSVs are REGENERATED INTO THE RUN WORKSPACE
 * (`E2E_SAMPLE_DIR`) and byte-compared against the committed fixtures.
 *
 * Covers (M12 "End-to-end acceptance" + the B-relevant lifecycle matrix):
 *   upload/ingest the four files via the real UI picker and get them into an
 *   explicitly `selected` chat scope; a real DuckDB `query_data` tool-call
 *   roundtrip through the scripted provider renders an actual result whose
 *   numbers are checked against independently computed fixture aggregates
 *   (committed expected values — not model prose); promote the verified
 *   full-query capture (>1,500-char SQL, truncated display receipt) through
 *   the UI; edit it to add a typed month parameter + comparison key; rerun
 *   outside chat from the Analyses page for two periods; keyed comparison
 *   with numeric totals; CSV/JSON/manifest export bytes parsed and compared
 *   to the stored snapshot (formula guard + quoting); provenance fields;
 *   browser reload mid-flow and a FULL BACKEND RESTART prove durability;
 *   cancellation of an active run; selected-empty never widens (fails on
 *   referenced tables, succeeds for a table-free query); foreign-account
 *   access is 404 from a second account session; stale-CAS edit is 409;
 *   duplicate submission replays by operation id; a controlled input
 *   replacement (delete → mark-unavailable → re-upload modified bytes →
 *   explicit scope update) yields a truthful keyed diff (Δ from stored
 *   finite values) while the old result stays byte-identical.
 *
 * Screenshots use the harness's content-free sequential names. Numeric
 * expectations come only from `fixtures/lib/finance-expected.mjs`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HarnessError, assert, pollUntil } from "../harness/util.mjs";
import {
  COMMITTED_EXPECTED,
  expectedAnalysisRows,
  expectedColumns,
  numericCellAgrees,
  verifyCommittedExpected,
  withMarker,
} from "../fixtures/lib/finance-expected.mjs";

export const JOURNEY_ID = "B";
export const IMPLEMENTED = true;

const EMAIL_A = "e2e-journey-b@borealis.test";
const EMAIL_B = "e2e-journey-b-foreign@borealis.test";
const PASSWORD = "borealis-e2e-journey-b-pass";
const ANSWER_MARKER = "FINAL-E2E-B-7f3a";

const SELECT_V1 =
  "SELECT LEFT(CAST(date AS VARCHAR), 7) AS month, category, COUNT(*) AS tx_count, " +
  "ROUND(SUM(amount), 2) AS net_amount, '=' || LEFT(CAST(date AS VARCHAR), 7) || '|Borealis-E2E' AS formula_probe, " +
  "'\"low, ' || LEFT(CAST(date AS VARCHAR), 7) || '\"' AS quote_probe " +
  "FROM transactions GROUP BY 1, 2 ORDER BY 1, 2";

const SELECT_V2 =
  "-- Journey B parameterized rerun: the month is bound as a typed value, never interpolated.\n" +
  "SELECT LEFT(CAST(date AS VARCHAR), 7) AS month, category, COUNT(*) AS tx_count, " +
  "ROUND(SUM(amount), 2) AS net_amount, '=' || LEFT(CAST(date AS VARCHAR), 7) || '|Borealis-E2E' AS formula_probe, " +
  "'\"low, ' || LEFT(CAST(date AS VARCHAR), 7) || '\"' AS quote_probe " +
  "FROM transactions WHERE LEFT(CAST(date AS VARCHAR), 7) = ? GROUP BY 1, 2 ORDER BY 1, 2";

/** Capture proof: the promoted SQL must be far above the 1,500-char display ceiling. */
function paddedCaptureSql() {
  let pad = "-- BOREALIS E2E journey B full-query capture proof (never executed from truncated text)\n";
  for (let index = 1; pad.length < 1_560; index += 1) {
    pad += `-- capture-padding-${String(index).padStart(3, "0")} 0123456789abcdef0123456789abcdef\n`;
  }
  return `${pad}${SELECT_V1}`.trim();
}

const ANALYSIS_TITLE = "Monthly category totals (E2E-B)";
const SLOW_SQL =
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3000000) SELECT count(*) AS slow_count FROM c";
const EMPTY_OK_SQL = "SELECT 1 AS one";
const EMPTY_FAIL_SQL = "SELECT COUNT(*) AS n FROM transactions";

/* ------------------------------------------------------------------ helpers */

async function goHash(session, route) {
  await session.page.evaluate((target) => {
    window.location.hash = target;
  }, route);
}

async function expectText(session, text, timeoutMs = 20_000) {
  await session.page.getByText(text).first().waitFor({ timeout: timeoutMs });
}

function numericAgrees(stored, expected) {
  if (!numericCellAgrees(stored, expected)) return false;
  return Math.abs(Math.round(stored * 100) - Math.round(expected * 100)) <= 1e-9 * 100;
}

/** Assert stored result rows deep-equal the independently computed expectations. */
function assertRowsEqual(actualRows, expectedRows, code) {
  assert(Array.isArray(actualRows), code, "rows not an array");
  assert(actualRows.length === expectedRows.length, code, `row count ${actualRows.length} !== ${expectedRows.length}`);
  for (let row = 0; row < expectedRows.length; row += 1) {
    const actual = actualRows[row];
    const expected = expectedRows[row];
    assert(Array.isArray(actual) && actual.length === expected.length, code, `row ${row} shape`);
    for (let col = 0; col < expected.length; col += 1) {
      const a = actual[col];
      const e = expected[col];
      const agrees = typeof e === "number" ? numericAgrees(a, e) : a === e;
      if (!agrees) {
        throw new HarnessError(code, `row ${row} column ${col}: ${JSON.stringify(a)} !== ${JSON.stringify(e)}`);
      }
    }
  }
}

/** Minimal RFC-style CSV parser (quotes, doubled quotes, CRLF, BOM). */
function parseCsvExport(text) {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  for (;;) {
    const ch = withoutBom[i];
    if (ch === undefined) break;
    if (inQuotes) {
      if (ch === '"') {
        if (withoutBom[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      if (withoutBom[i] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Run a run-status poll to a wanted terminal status with a bounded deadline. */
async function waitForRun(session, analysisId, runId, wanted, { deadlineMs = 60_000, code }) {
  let last = null;
  await pollUntil(
    async () => {
      const res = await session.apiFetch(`/api/analyses/${analysisId}/runs/${runId}`, { expectStatus: 200 });
      last = res.body;
      return wanted.includes(last?.status);
    },
    { deadlineMs, intervalMs: 250 }
  );
  assert(last !== null && wanted.includes(last.status), code, `run ended as ${last?.status}`);
  return last;
}

/* ------------------------------------------------------------------- journey */

export async function run(ctx) {
  const { server, provider, browser, workspace, artifactsDir, repoRoot } = ctx;
  const artifacts = [];
  const checks = {};
  const sqlV1 = paddedCaptureSql();
  const sqlV2 = SELECT_V2;

  /* -- P0: regenerate the finance fixtures INTO THE RUN WORKSPACE ---------- */
  const inputsDir = workspace.assertOwnedPath(path.join(workspace.root, "inputs"));
  await mkdir(inputsDir, { recursive: true, mode: 0o700 });
  const sampleDir = path.join(inputsDir, "sample");
  const generator = spawnSync("pnpm", ["--filter", "borealis-server", "exec", "tsx", "../data/generate_sample.ts"], {
    cwd: path.join(repoRoot, "server"),
    env: { ...process.env, E2E_SAMPLE_DIR: sampleDir },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert(generator.status === 0, "GENERATOR_FAILED", String(generator.status));
  const fixtureNames = ["accounts.csv", "transactions.csv", "budget.csv", "networth.csv"];
  for (const name of fixtureNames) {
    const generated = await readFile(path.join(sampleDir, name));
    const committed = await readFile(path.join(repoRoot, "data", "sample", name));
    assert(generated.equals(committed), "GENERATOR_BYTES_DIFFER", name);
  }
  const transactionsText = await readFile(path.join(sampleDir, "transactions.csv"), "utf8");
  const helperMismatches = verifyCommittedExpected(transactionsText);
  assert(helperMismatches.length === 0, "EXPECTED_VALUES_DRIFT", helperMismatches.join(" | "));
  const expectedAll = expectedAnalysisRows(transactionsText, null);
  const expectedJune = expectedAnalysisRows(transactionsText, "2025-06");
  const expectedMay = expectedAnalysisRows(transactionsText, "2025-05");
  const expectedJuneChanged = expectedAnalysisRows(withMarker(transactionsText), "2025-06");
  assert(expectedAll.length === COMMITTED_EXPECTED.month_category_keys, "EXPECTED_ROWS_COUNT");
  assert(expectedJune.length === COMMITTED_EXPECTED.june_keys, "EXPECTED_JUNE_ROWS");
  assert(expectedMay.length === COMMITTED_EXPECTED.may_keys, "EXPECTED_MAY_ROWS");
  checks.fixture_rows = COMMITTED_EXPECTED.transaction_rows;
  checks.expected_keys_total = expectedAll.length;
  checks.expected_june = expectedJune.length;
  checks.expected_may = expectedMay.length;

  // The replacement upload must carry the real filename the analysis expects.
  const modifiedUploadDir = path.join(inputsDir, "replacement");
  await mkdir(modifiedUploadDir, { recursive: true, mode: 0o700 });
  const modifiedUploadPath = path.join(modifiedUploadDir, "transactions.csv");
  await writeFile(modifiedUploadPath, withMarker(transactionsText), "utf8");

  /* -- P1: account + the four uploads through the real chat picker --------- */
  const session = await browser.newSession({ origin: server.origin });
  let sessionB = null;
  try {
    await session.register({ email: EMAIL_A, password: PASSWORD });
    artifacts.push(await session.screenshot(artifactsDir));

    const fileInput = () => session.page.locator('input[aria-label="Upload a source file"]');
    const picker = () => session.page.locator('button[aria-label^="Chat sources:"]');
    await picker().click();
    for (const name of fixtureNames) {
      await fileInput().setInputFiles(path.join(sampleDir, name));
      await pollUntil(
        async () => {
          const res = await session.apiFetch("/api/sources", { expectStatus: 200 });
          return (res.body?.items ?? []).length === fixtureNames.indexOf(name) + 1;
        },
        { deadlineMs: 30_000, intervalMs: 200 }
      );
    }
    // Wait until ingestion marks all four tabular sources ready.
    const byName = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/sources", { expectStatus: 200 });
        const items = res.body?.items ?? [];
        if (items.length !== 4) return null;
        if (!items.every((item) => item.status === "ready")) return null;
        const map = {};
        for (const item of items) map[item.display_name] = item;
        return Object.keys(map).length === 4 ? map : null;
      },
      { deadlineMs: 90_000, intervalMs: 300 }
    );
    assert(byName !== null, "SOURCES_NOT_READY");
    for (const [name, table] of [
      ["transactions.csv", "transactions"],
      ["accounts.csv", "accounts"],
      ["budget.csv", "budget"],
      ["networth.csv", "networth"],
    ]) {
      assert(byName[name]?.tabular?.table === table, "TABULAR_TABLE_NAME", `${name} → ${byName[name]?.tabular?.table}`);
    }
    checks.tables = ["transactions", "accounts", "budget", "networth"];
    await expectText(session, "4 sources");
    artifacts.push(await session.screenshot(artifactsDir));
    await picker().click().catch(() => undefined);
    await session.page.keyboard.press("Escape");

    /* -- P2: scripted tool-call roundtrip; real DuckDB result in chat ------- */
    const before = await provider.state();
    await provider.setScript({
      steps: [
        {
          type: "tool_call",
          id: "call_journey_b_capture",
          name_pieces: ["query", "_data"],
          argument_pieces: ['{"sql": ', `${JSON.stringify(sqlV1)}}`],
        },
        {
          type: "text",
          pieces: ["Done. 2025 monthly totals by category are in the query result table above. ", ANSWER_MARKER],
        },
      ],
      onExhausted: "repeat-last",
    });
    await session.page.getByLabel("Ask Borealis about your data").fill("Break down my 2025 activity by month and category.");
    await session.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expectText(session, ANSWER_MARKER, 120_000);
    await expectText(session, "Query result 1");
    await expectText(session, "Preview truncated");
    artifacts.push(await session.screenshot(artifactsDir));

    const after = await provider.state();
    // Exactly three POSTs for the first turn: the scripted tool round, the
    // scripted final text, and the product's non-streaming chat-title probe
    // (which the stream-only fixture rejects and the title flow absorbs).
    await writeFile(
      path.join(artifactsDir, "provider-delta.txt"),
      `chat=+${after.chat_calls - before.chat_calls} embed=+${after.embedding_calls - before.embedding_calls}\n`
    );
    assert(
      after.chat_calls - before.chat_calls === 3,
      "PROVIDER_TURN_ARITY",
      `chat=+${after.chat_calls - before.chat_calls} embed=+${after.embedding_calls - before.embedding_calls}`
    );
    checks.provider_chat_calls = after.chat_calls - before.chat_calls;

    const chats = await session.apiFetch("/api/chats", { expectStatus: 200 });
    const chatList = chats.body?.items ?? chats.body?.chats ?? [];
    assert(chatList.length === 1, "CHAT_COUNT", String(chatList.length));
    const chatId = chatList[0].id;
    const chatDetail = await session.apiFetch(`/api/chats/${chatId}`, { expectStatus: 200 });
    assert(chatDetail.body?.source_mode === "selected", "CHAT_SCOPE_MODE");
    assert((chatDetail.body?.sources ?? []).length === 4, "CHAT_SCOPE_SIZE");
    const assistant = (chatDetail.body?.messages ?? []).find(
      (message) => message.role === "assistant" && (message.meta?.query_results ?? []).length > 0
    );
    assert(assistant !== undefined, "RECEIPT_NOT_PERSISTED");
    assert(assistant.meta.model === provider.models.chatModel, "RUN_MODEL");
    const receipt = assistant.meta.query_results[0];
    assert(typeof receipt.capture_id === "string" && receipt.can_save_analysis === true, "CAPTURE_AFFORDANCE");
    assert(receipt.truncated === true, "RECEIPT_MUST_BE_PREVIEW_TRUNCATED");
    assert(receipt.sql === sqlV1.slice(0, 1_500), "RECEIPT_SQL_IS_SLICED_PREVIEW");
    assert(receipt.row_count === COMMITTED_EXPECTED.month_category_keys, "RECEIPT_ROW_COUNT", String(receipt.row_count));
    assert(receipt.rows.length === 83, "RECEIPT_DISPLAY_CELL_CAP_ROWS", String(receipt.rows.length));
    checks.receipt_preview_rows = receipt.rows.length;

    /* -- P3: promote the verified full capture through the UI --------------- */
    // The verified-capture affordance is the button labelled
    // "Save query as analysis"; the legacy no-capture affordance carries a
    // different accessible name, so this also proves the capture path.
    await session.page.getByRole("button", { name: "Save query as analysis", exact: true }).click();
    await session.page.getByLabel("Analysis title").fill(ANALYSIS_TITLE);
    await session.page.getByRole("button", { name: "Save analysis", exact: true }).click();
    await expectText(session, "Saved — open in Analyses");
    artifacts.push(await session.screenshot(artifactsDir));

    const catalog = await session.apiFetch("/api/analyses", { expectStatus: 200 });
    const items = catalog.body?.items ?? [];
    assert(items.length === 1 && items[0].title === ANALYSIS_TITLE, "PROMOTION_CATALOG");
    const analysisId = items[0].id;
    let detail = (await session.apiFetch(`/api/analyses/${analysisId}`, { expectStatus: 200 })).body;
    assert(detail.current_revision === 1, "PROMOTED_REVISION");
    assert(detail.sql === sqlV1, "PROMOTED_FULL_SQL", `len=${detail.sql?.length}`);
    assert(detail.sql.length > 1_500 && detail.sql.length <= 20_000, "PROMOTED_SQL_BOUNDS", String(detail.sql.length));
    assert((detail.source_ids ?? []).length === 4, "PROMOTED_SOURCES");
    assert(detail.origin?.run_id === null || typeof detail.origin?.run_id === "string", "PROMOTED_ORIGIN_SHAPE");
    assert(typeof detail.origin?.run_id === "string" && detail.origin?.run_id.length > 0, "PROMOTED_ORIGIN_RUN");
    assert(typeof detail.origin?.capture_id === "string", "PROMOTED_ORIGIN_CAPTURE");
    assert(detail.comparison_key === null, "PROMOTED_KEY_EMPTY");

    /* -- P4: edit → month parameter + comparison key + parameterized SQL ---- */
    await goHash(session, "/analyses");
    await expectText(session, "Analyses");
    await session.page.getByRole("button", { name: ANALYSIS_TITLE, exact: false }).first().click();
    await session.page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await session.page.locator("#analysis-comparison-key").fill("month, category");
    await session.page.locator("#analysis-sql").fill(sqlV2);
    await session.page.getByRole("button", { name: "Add parameter", exact: true }).click();
    await session.page.getByLabel("Parameter 1 name").fill("month");
    await session.page.getByLabel("Parameter 1 type").selectOption("string");
    await session.page.getByLabel("Parameter 1 default").fill("2025-06");
    await session.page.getByRole("button", { name: "Save edit", exact: true }).click();
    await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/analyses/${analysisId}`, { expectStatus: 200 });
        detail = res.body;
        return detail?.current_revision === 2;
      },
      { deadlineMs: 15_000, intervalMs: 200 }
    );
    assert(detail.parameters?.length === 1 && detail.parameters[0].name === "month" && detail.parameters[0].type === "string", "EDITED_PARAMETER");
    assert(detail.parameters[0].required === true && detail.parameters[0].default === "2025-06", "EDITED_PARAMETER_SHAPE");
    assert(JSON.stringify(detail.comparison_key) === JSON.stringify(["month", "category"]), "EDITED_KEY");
    assert(detail.sql === sqlV2, "EDITED_SQL");
    await expectText(session, "revision 2");
    await expectText(session, "key: month, category");
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P5: run June outside chat; numbers vs independent expectations ------ */
    const runThroughUi = async ({ analysisId: targetId, month, expectedRows, code }) => {
      const beforeRuns = new Set(
        ((await session.apiFetch(`/api/analyses/${targetId}/runs`, { expectStatus: 200 })).body?.items ?? []).map(
          (item) => item.id
        )
      );
      const beforeResults = new Set(
        ((await session.apiFetch(`/api/analyses/${targetId}/results`, { expectStatus: 200 })).body?.items ?? []).map(
          (item) => item.id
        )
      );
      if (month !== undefined) {
        await session.page.locator("#run-param-month").fill(month);
      }
      await session.page.getByRole("button", { name: "Run now", exact: true }).click();
      const newRun = await pollUntil(
        async () => {
          const page = await session.apiFetch(`/api/analyses/${targetId}/runs`, { expectStatus: 200 });
          return (page.body?.items ?? []).find((item) => !beforeRuns.has(item.id)) ?? null;
        },
        { deadlineMs: 30_000, intervalMs: 250 }
      );
      assert(newRun && typeof newRun.id === "string", `${code}_RUN_ACCEPTED`);
      let finalRun = null;
      try {
        finalRun = await waitForRun(session, targetId, newRun.id, ["succeeded"], {
          deadlineMs: 60_000,
          code: `${code}_RUN`,
        });
      } catch (failure) {
        const runDetail = await session.apiFetch(`/api/analyses/${targetId}/runs/${newRun.id}`, { expectStatus: 200 });
        const sourcesState = await session.apiFetch("/api/sources", { expectStatus: 200 });
        const bindingState = await session.apiFetch(`/api/analyses/${targetId}`, { expectStatus: 200 });
        await writeFile(
          path.join(artifactsDir, "debug-run-failure.txt"),
          JSON.stringify(
            {
              status: runDetail.body?.status,
              error_code: runDetail.body?.error_code,
              sources: (sourcesState.body?.items ?? []).map((item) => ({
                table: item.tabular?.table,
                status: item.status,
                gen: item.ready_generation,
                size: item.size_bytes,
              })),
              bindings: (bindingState.body?.sources ?? []).map((b) => ({
                gen: b.ready_generation,
                identity: b.content_identity,
                unavailable: b.unavailable_at,
              })),
              runSources: (runDetail.body?.sources ?? []).map((s) => ({ gen: s.ready_generation, identity: s.content_identity })),
            },
            null,
            2
          )
        ).catch(() => undefined);
        throw failure;
      }
      assert(finalRun.status === "succeeded", `${code}_STATUS`, `${finalRun.status}/${finalRun.error_code}`);
      const summary = await pollUntil(
        async () => {
          const page = await session.apiFetch(`/api/analyses/${targetId}/results`, { expectStatus: 200 });
          return (page.body?.items ?? []).find((item) => !beforeResults.has(item.id)) ?? null;
        },
        { deadlineMs: 30_000, intervalMs: 250 }
      );
      assert(summary && typeof summary.id === "string", code, "no new stored result after run");
      assert(summary.run_id === newRun.id, `${code}_RESULT_RUN_LINK`);
      const full = (await session.apiFetch(`/api/analyses/${targetId}/results/${summary.id}`, { expectStatus: 200 })).body;
      assertRowsEqual(full.rows, expectedRows, code);
      assert(JSON.stringify(full.columns.map((column) => column.name)) === JSON.stringify(expectedColumns()), `${code}_COLUMNS`);
      assert(full.completeness?.complete === true && (full.completeness?.reasons ?? []).length === 0, `${code}_COMPLETE`);
      return { summary, full };
    };

    const june = await runThroughUi({
      analysisId,
      month: "2025-06",
      expectedRows: expectedJune,
      code: "JUNE_RESULT",
    });
    assert(june.full.parameter_values?.some((binding) => binding.name === "month" && binding.value === "2025-06"), "JUNE_PARAMETER");
    assert(june.full.source_provenance?.length === 4, "JUNE_PROVENANCE_COUNT");
    assert(june.full.schema_fingerprint === june.summary.schema_fingerprint, "SCHEMA_FINGERPRINT");
    // Open the result in the UI and prove the actual numbers render.
    await session.page
      .locator(`li:has(input[aria-label="Select result ${june.summary.id.slice(0, 8)} for comparison"]) button`)
      .first()
      .click();
    await expectText(session, `Result ${june.summary.id.slice(0, 8)}`);
    await session.page.locator(`span[title="${COMMITTED_EXPECTED.june_groceries_net}"]`).first().waitFor({ timeout: 10_000 });
    await session.page.locator(`span[title="=2025-06|Borealis-E2E"]`).first().waitFor({ timeout: 10_000 });
    artifacts.push(await session.screenshot(artifactsDir));
    checks.june_result = june.summary.id.slice(0, 8);

    /* -- P6: browser reload mid-flow proves UI-side durability -------------- */
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await goHash(session, "/analyses");
    await expectText(session, "Analyses", 30_000);
    await session.page.getByRole("button", { name: ANALYSIS_TITLE, exact: false }).first().click();
    await expectText(session, "revision 2");
    await expectText(session, "14 rows");
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P7: full backend restart against the same workspace ---------------- */
    const token = await session.token();
    const pidBeforeRestart = server.pid;
    const restartInfo = await server.restart({ token });
    assert(restartInfo.pid !== pidBeforeRestart, "RESTART_PID_CHANGED");
    assert(server.origin === session.origin, "RESTART_ORIGIN_MOVED");
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await goHash(session, "/analyses");
    await expectText(session, ANALYSIS_TITLE, 30_000);
    const afterRestartDetail = (await session.apiFetch(`/api/analyses/${analysisId}`, { expectStatus: 200 })).body;
    assert(afterRestartDetail.sql === sqlV2 && afterRestartDetail.current_revision === 2, "RESTART_DEFINITION");
    const afterRestartResult = (
      await session.apiFetch(`/api/analyses/${analysisId}/results/${june.summary.id}`, { expectStatus: 200 })
    ).body;
    assertRowsEqual(afterRestartResult.rows, expectedJune, "RESTART_RESULT");
    // Gate on the restarted data plane re-hydrating its dataset registry.
    // The product signal is the source catalog exposing tabular summaries
    // again (worker `listDatasetSummaries` only answers for registered
    // tables). Startup reconciliation is async behind the ready line; runs
    // accepted during that window fail closed as `stale-inputs` (reported
    // product warm-up gap), so the journey waits like a user would.
    await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/sources", { expectStatus: 200 });
        const items = res.body?.items ?? [];
        return items.length === 4 && items.every((item) => item.status === "ready" && item.tabular?.table)
          ? true
          : null;
      },
      { deadlineMs: 60_000, intervalMs: 250 }
    ).then((ready) => assert(ready === true, "RESTART_REGISTRY_HYDRATION"));
    // Reopen the definition detail for the UI-driven second period run.
    await session.page.getByRole("button", { name: ANALYSIS_TITLE, exact: false }).first().click();
    await expectText(session, "revision 2");
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P8: second period + keyed comparison -------------------------------- */
    const may = await runThroughUi({ analysisId, month: "2025-05", expectedRows: expectedMay, code: "MAY_RESULT" });
    const compare = await session.apiFetch(
      `/api/analyses/${analysisId}/compare?left=${june.summary.id}&right=${may.summary.id}`,
      { expectStatus: 200 }
    );
    const cmp = compare.body;
    assert(cmp.mode === "keyed" && JSON.stringify(cmp.key_columns) === JSON.stringify(["month", "category"]), "COMPARE_KEYED");
    assert(cmp.exhaustive === true, "COMPARE_EXHAUSTIVE");
    assert(cmp.removed_total === COMMITTED_EXPECTED.june_keys, "COMPARE_REMOVED", String(cmp.removed_total));
    assert(cmp.added_total === COMMITTED_EXPECTED.may_keys, "COMPARE_ADDED", String(cmp.added_total));
    assert(cmp.changed_total === 0, "COMPARE_CHANGED", String(cmp.changed_total));
    assert(
      cmp.parameters?.changed?.length === 1 &&
        cmp.parameters.changed[0].name === "month" &&
        cmp.parameters.changed[0].left === "2025-06" &&
        cmp.parameters.changed[0].right === "2025-05",
      "COMPARE_PARAMETER_DIFF"
    );
    // Same comparison through the UI checkboxes.
    await session.page.getByLabel(`Select result ${june.summary.id.slice(0, 8)} for comparison`).check();
    await session.page.getByLabel(`Select result ${may.summary.id.slice(0, 8)} for comparison`).check();
    await session.page.getByRole("button", { name: /Compare selected/ }).click();
    await expectText(session, "Keyed on month, category");
    await session.page.getByText(/^Removed \(/).first().waitFor({ timeout: 15_000 });
    await expectText(session, "month: 2025-06 → 2025-05");
    artifacts.push(await session.screenshot(artifactsDir));
    checks.compare = { removed: cmp.removed_total, added: cmp.added_total, changed: cmp.changed_total };

    /* -- P9: exports parse, match the stored snapshot, guard formulas -------- */
    await session.page
      .locator(`li:has(input[aria-label="Select result ${june.summary.id.slice(0, 8)} for comparison"]) button`)
      .first()
      .click();
    await expectText(session, `Result ${june.summary.id.slice(0, 8)}`);
    await session.page.getByRole("button", { name: "csv", exact: true }).click();
    await pollUntil(
      async () => session.page.getByRole("button", { name: "csv", exact: true }).isVisible().catch(() => false),
      { deadlineMs: 15_000, intervalMs: 200 }
    );
    const csvRes = await session.apiFetchText(
      `/api/analyses/${analysisId}/results/${june.summary.id}/export?format=csv`,
      { expectStatus: 200 }
    );
    assert(csvRes.contentType.includes("text/csv"), "CSV_CONTENT_TYPE");
    assert(/filename=/.test(csvRes.disposition) && csvRes.disposition.includes(".csv"), "CSV_DISPOSITION");
    assert(csvRes.disposition.includes("partial") === false, "CSV_NOT_PARTIAL");
    assert(csvRes.text.charCodeAt(0) === 0xfeff, "CSV_BOM");
    assert(csvRes.text.includes(`'=2025-06|Borealis-E2E`), "CSV_FORMULA_GUARD");
    assert(csvRes.text.includes(`"""low, 2025-06"""`), "CSV_QUOTE_ESCAPING");
    const csvRows = parseCsvExport(csvRes.text);
    const csvBody = csvRows.filter((row) => row.length > 1 || row[0] !== "");
    assert(csvBody[0]?.[0] === "month", "CSV_HEADER");
    const csvData = csvBody.slice(1).filter((row) => row[0] !== undefined && row[0] !== "");
    assertRowsEqual(
      csvData.map((row) => [
        row[0],
        row[1],
        Number(row[2]),
        Number(row[3]),
        row[4],
        row[5],
      ]),
      expectedJune.map(([month, category, count, net, formulaProbe, quoteProbe]) => [
        month,
        category,
        count,
        net,
        `'${formulaProbe}`,
        quoteProbe,
      ]),
      "CSV_VS_EXPECTED"
    );
    const jsonRes = await session.apiFetchText(
      `/api/analyses/${analysisId}/results/${june.summary.id}/export?format=json`,
      { expectStatus: 200 }
    );
    const jsonExport = JSON.parse(jsonRes.text);
    assert(jsonExport.result_id === june.summary.id && jsonExport.analysis_id === analysisId, "JSON_IDS");
    assert(JSON.stringify(jsonExport.columns.map((c) => c.name)) === JSON.stringify(expectedColumns()), "JSON_COLUMNS");
    assert(JSON.stringify(jsonExport.rows) === JSON.stringify(june.full.rows), "JSON_ROWS_EXACT");
    assert(jsonExport.partial === false && jsonExport.returned_rows === COMMITTED_EXPECTED.june_keys, "JSON_FLAGS");
    const manifestRes = await session.apiFetchText(
      `/api/analyses/${analysisId}/results/${june.summary.id}/export?format=manifest`,
      { expectStatus: 200 }
    );
    const manifest = JSON.parse(manifestRes.text);
    assert(manifest.artifact === "analysis_result_manifest", "MANIFEST_KIND");
    assert(manifest.exported_result?.id === june.summary.id, "MANIFEST_RESULT_ID");
    assert(manifest.exported_result?.run_id === june.full.run_id, "MANIFEST_RUN_ID");
    assert(
      manifest.parameters?.length === 1 &&
        manifest.parameters[0].name === "month" &&
        manifest.parameters[0].type === "string" &&
        manifest.parameters[0].value === "2025-06",
      "MANIFEST_PARAMETERS"
    );
    assert(
      manifest.source_provenance?.length === 4 &&
        manifest.source_provenance.every(
          (entry) =>
            typeof entry.source_id === "string" && Number.isSafeInteger(entry.ready_generation) && typeof entry.content_identity === "string"
        ) &&
        JSON.stringify(manifest.source_provenance.map((entry) => entry.source_id)) ===
          JSON.stringify(june.full.source_provenance.map((entry) => entry.source_id)),
      "MANIFEST_PROVENANCE"
    );
    assert(manifest.schema_fingerprint === june.full.schema_fingerprint, "MANIFEST_FINGERPRINT");
    checks.export_bytes_checked = ["csv", "json", "manifest"];

    /* -- P10: cancellation path on a dedicated slow analysis ----------------- */
    await session.page.getByRole("button", { name: "All analyses" }).click();
    await session.page.getByRole("button", { name: "New analysis", exact: true }).click();
    await session.page.locator("#analysis-title").fill("Slow probe (E2E-B)");
    await session.page.locator("#analysis-sql").fill(SLOW_SQL);
    await session.page.getByLabel("Select source transactions", { exact: true }).click();
    await session.page.getByRole("button", { name: "Create analysis", exact: true }).click();
    const slowList = await pollUntil(
      async () => {
        const page = await session.apiFetch("/api/analyses", { expectStatus: 200 });
        const found = (page.body?.items ?? []).find((item) => item.title === "Slow probe (E2E-B)");
        return found ?? null;
      },
      { deadlineMs: 15_000, intervalMs: 200 }
    );
    assert(slowList !== null, "SLOW_ANALYSIS_CREATED");
    // The editor's onSaved handler selects the new analysis detail directly.
    const slowRunsBefore = new Set(
      ((await session.apiFetch(`/api/analyses/${slowList.id}/runs`, { expectStatus: 200 })).body?.items ?? []).map((r) => r.id)
    );
    await session.page.getByRole("button", { name: "Run now", exact: true }).click();
    const slowRun = await pollUntil(
      async () => {
        const page = await session.apiFetch(`/api/analyses/${slowList.id}/runs`, { expectStatus: 200 });
        const fresh = (page.body?.items ?? []).find((item) => !slowRunsBefore.has(item.id));
        return fresh ?? null;
      },
      { deadlineMs: 15_000, intervalMs: 150 }
    );
    assert(slowRun !== null, "SLOW_RUN_ACCEPTED");
    await session.page.getByRole("button", { name: "Cancel", exact: true }).first().click();
    const cancelledRun = await waitForRun(session, slowList.id, slowRun.id, ["cancelled"], {
      deadlineMs: 60_000,
      code: "CANCEL_TERMINAL",
    });
    assert(cancelledRun.status === "cancelled", "CANCELLED_STATUS");
    assert(cancelledRun.cancel_requested === true, "CANCEL_REQUESTED_FLAG");
    const slowResults = await session.apiFetch(`/api/analyses/${slowList.id}/results`, { expectStatus: 200 });
    assert((slowResults.body?.items ?? []).length === 0, "CANCEL_PUBLISHED_PARTIAL");
    await expectText(session, "Cancelled");
    artifacts.push(await session.screenshot(artifactsDir));
    checks.cancel_run = slowRun.id.slice(0, 8);

    /* -- P11: lifecycle matrix — stale CAS, foreign account, replay, empty --- */
    session.allowStatuses([409, 404]);
    const staleEdit = await session.apiFetch(`/api/analyses/${analysisId}`, {
      method: "PATCH",
      body: { expected_revision: 1, title: "stale" },
    });
    assert(staleEdit.status === 409 && staleEdit.body?.code === "ANALYSIS_REVISION_CONFLICT", "STALE_CAS", String(staleEdit.status));
    const afterStale = (await session.apiFetch(`/api/analyses/${analysisId}`, { expectStatus: 200 })).body;
    assert(afterStale.current_revision === 2 && afterStale.title === ANALYSIS_TITLE, "STALE_CAS_NO_WRITE");

    sessionB = await browser.newSession({ origin: server.origin });
    await sessionB.register({ email: EMAIL_B, password: `${PASSWORD}-b` });
    sessionB.allowStatuses([404]);
    const foreignList = await sessionB.apiFetch("/api/analyses", { expectStatus: 200 });
    assert((foreignList.body?.items ?? []).length === 0, "FOREIGN_CATALOG_EMPTY");
    const foreignDetail = await sessionB.apiFetch(`/api/analyses/${analysisId}`);
    assert(foreignDetail.status === 404 && foreignDetail.body?.code === "ANALYSIS_NOT_FOUND", "FOREIGN_DETAIL_404");
    const foreignRun = await sessionB.apiFetch(`/api/analyses/${analysisId}/runs`, { method: "POST", body: {} });
    assert(foreignRun.status === 404, "FOREIGN_RUN_404");
    const foreignResult = await sessionB.apiFetchText(`/api/analyses/${analysisId}/results/${june.summary.id}/export?format=json`);
    assert(foreignResult.status === 404, "FOREIGN_EXPORT_404");

    // selected-empty: table-free SQL succeeds; referenced-table SQL fails and
    // never widens to sources the definition does not select.
    const createEmptyAnalysis = async (title, sql) => {
      await session.page.getByRole("button", { name: "All analyses" }).click();
      await session.page.getByRole("button", { name: "New analysis", exact: true }).click();
      await session.page.locator("#analysis-title").fill(title);
      await session.page.locator("#analysis-sql").fill(sql);
      await session.page.getByRole("button", { name: "Create analysis", exact: true }).click();
      const created = await pollUntil(
        async () => {
          const page = await session.apiFetch("/api/analyses", { expectStatus: 200 });
          return (page.body?.items ?? []).find((item) => item.title === title) ?? null;
        },
        { deadlineMs: 15_000, intervalMs: 200 }
      );
      assert(created !== null, "EMPTY_ANALYSIS_CREATED", title);
      assert(created.source_count === 0 && created.unavailable_source_count === 0, "EMPTY_ANALYSIS_SOURCES");
      return created;
    };
    const emptyOk = await createEmptyAnalysis("Empty-scope SELECT 1 (E2E-B)", EMPTY_OK_SQL);
    // onSaved selects the new detail; the selected-empty badge proves scope.
    await expectText(session, "selected-empty scope");
    const emptyOkRun = await session.apiFetch(`/api/analyses/${emptyOk.id}/runs`, {
      method: "POST",
      body: { values: {}, operation_id: randomUUID() },
      expectStatus: 202,
    });
    assert(emptyOkRun.body?.outcome === "queued", "EMPTY_OK_QUEUED");
    await waitForRun(session, emptyOk.id, emptyOkRun.body.run.id, ["succeeded"], { deadlineMs: 60_000, code: "EMPTY_OK_RUN" });
    const emptyOkResult = await pollUntil(
      async () => {
        const page = await session.apiFetch(`/api/analyses/${emptyOk.id}/results`, { expectStatus: 200 });
        return (page.body?.items ?? [])[0] ?? null;
      },
      { deadlineMs: 15_000, intervalMs: 250 }
    );
    assert(emptyOkResult !== null, "EMPTY_OK_RESULT");
    const emptyOkFull = (await session.apiFetch(`/api/analyses/${emptyOk.id}/results/${emptyOkResult.id}`, { expectStatus: 200 })).body;
    assertRowsEqual(emptyOkFull.rows, [[1]], "EMPTY_OK_ROWS");
    assert(emptyOkFull.source_provenance.length === 0, "EMPTY_OK_PROVENANCE");

    // Idempotent duplicate submission: same operation id replays.
    const replayOperation = randomUUID();
    const firstPost = await session.apiFetch(`/api/analyses/${emptyOk.id}/runs`, {
      method: "POST",
      body: { values: {}, operation_id: replayOperation },
      expectStatus: 202,
    });
    assert(firstPost.body?.outcome === "queued", "REPLAY_FIRST_POST_QUEUED");
    await waitForRun(session, emptyOk.id, firstPost.body.run.id, ["succeeded"], {
      deadlineMs: 60_000,
      code: "REPLAY_FIRST_RUN",
    });
    const secondPost = await session.apiFetch(`/api/analyses/${emptyOk.id}/runs`, {
      method: "POST",
      body: { values: {}, operation_id: replayOperation },
      expectStatus: 202,
    });
    assert(
      secondPost.body.outcome === "replayed" && secondPost.body.run.id === firstPost.body.run.id,
      "OPERATION_REPLAY"
    );
    const replayRuns = await session.apiFetch(`/api/analyses/${emptyOk.id}/runs`, { expectStatus: 200 });
    const replayAccepted = (replayRuns.body?.items ?? []).filter((item) => item.operation_id === replayOperation);
    assert(replayAccepted.length === 1, "OPERATION_REPLAY_SINGLE_ROW");

    const emptyFail = await createEmptyAnalysis("Empty-scope table probe (E2E-B)", EMPTY_FAIL_SQL);
    const emptyFailRun = await session.apiFetch(`/api/analyses/${emptyFail.id}/runs`, {
      method: "POST",
      body: { values: {} },
      expectStatus: 202,
    });
    const failedRun = await waitForRun(session, emptyFail.id, emptyFailRun.body.run.id, ["failed"], {
      deadlineMs: 60_000,
      code: "EMPTY_FAIL_TERMINAL",
    });
    assert(typeof failedRun.error_code === "string" && failedRun.error_code.startsWith("ANALYSIS_QUERY"), "EMPTY_FAIL_CODE", failedRun.error_code);
    const emptyFailResults = await session.apiFetch(`/api/analyses/${emptyFail.id}/results`, { expectStatus: 200 });
    assert((emptyFailResults.body?.items ?? []).length === 0, "EMPTY_FAIL_NO_RESULT");
    artifacts.push(await session.screenshot(artifactsDir));
    checks.matrix = ["stale-cas-409", "foreign-404", "operation-replay", "selected-empty-ok", "selected-empty-fail"];

    /* -- P12: controlled input replacement → truthful keyed diff -------------- */
    // Explicit scope shrink first (the supported way to detach a doomed source).
    await session.page.getByRole("button", { name: "All analyses" }).click();
    await session.page.getByRole("button", { name: ANALYSIS_TITLE, exact: false }).first().click();
    await session.page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await session.page.getByLabel("Select source transactions", { exact: true }).click(); // uncheck old transactions
    await session.page.getByRole("button", { name: "Save edit", exact: true }).click();
    await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/analyses/${analysisId}`, { expectStatus: 200 });
        return (res.body?.source_ids ?? []).length === 3 ? res.body : null;
      },
      { deadlineMs: 15_000, intervalMs: 200 }
    ).then((body) => assert(body !== null && body.current_revision === 3, "SCOPE_SHRUNK"));

    // Delete the old transactions source; the slow-probe binding must go
    // unavailable (never retargeted) and its next run must fail stale-inputs.
    const oldTransactionsId = Object.values(byName).find((item) => item.tabular?.table === "transactions").id;
    await session.apiFetch(`/api/sources/${oldTransactionsId}`, { method: "DELETE", expectStatus: 200 });
    const slowDetail = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/analyses/${slowList.id}`, { expectStatus: 200 });
        const unavailable = (res.body?.sources ?? []).filter((source) => source.unavailable_at !== null);
        return unavailable.length === 1 ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 300 }
    );
    assert(slowDetail !== null, "BINDING_MARKED_UNAVAILABLE");
    const staleRun = await session.apiFetch(`/api/analyses/${slowList.id}/runs`, {
      method: "POST",
      body: { values: {} },
      expectStatus: 202,
    });
    assert(staleRun.body?.outcome === "stale-inputs", "DELETED_INPUT_STALE_OUTCOME", String(staleRun.body?.outcome));
    const staleRunFull = await waitForRun(session, slowList.id, staleRun.body.run.id, ["stale-inputs"], {
      deadlineMs: 20_000,
      code: "DELETED_INPUT_STALE_RUN",
    });
    assert(staleRunFull.status === "stale-inputs", "DELETED_INPUT_STALE_STATUS");
    const slowResultsAfterStale = await session.apiFetch(`/api/analyses/${slowList.id}/results`, { expectStatus: 200 });
    assert((slowResultsAfterStale.body?.items ?? []).length === 0, "DELETED_INPUT_NO_PUBLISH");

    // Replace the bytes under the supported upload path and reselect scope.
    await goHash(session, "/sources");
    await session.page.locator('input[type="file"]').setInputFiles(modifiedUploadPath);
    const replacement = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/sources", { expectStatus: 200 });
        const items = (res.body?.items ?? []).filter((item) => item.display_name === "transactions.csv");
        const ready = items.find((item) => item.status === "ready" && item.tabular?.table === "transactions");
        return ready ?? null;
      },
      { deadlineMs: 90_000, intervalMs: 300 }
    );
    assert(replacement !== null, "REPLACEMENT_TABLE_READY");
    assert(replacement.id !== oldTransactionsId, "REPLACEMENT_NEW_ID");
    await goHash(session, "/analyses");
    await session.page.getByRole("button", { name: ANALYSIS_TITLE, exact: false }).first().click();
    await session.page.getByRole("button", { name: "Edit", exact: true }).first().click();
    await session.page.getByLabel("Select source transactions", { exact: true }).click(); // select new transactions
    await session.page.getByRole("button", { name: "Save edit", exact: true }).click();
    await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/analyses/${analysisId}`, { expectStatus: 200 });
        return (res.body?.source_ids ?? []).includes(replacement.id) ? res.body : null;
      },
      { deadlineMs: 15_000, intervalMs: 200 }
    ).then((body) => assert(body !== null, "SCOPE_RESELECTED"));

    // Rerun June against the changed bytes; numbers must move by exactly
    // the independently computed marker delta.
    await session.page.getByRole("button", { name: "All analyses" }).click();
    await session.page.getByRole("button", { name: ANALYSIS_TITLE, exact: false }).first().click();
    const juneChanged = await runThroughUi({
      analysisId,
      month: "2025-06",
      expectedRows: expectedJuneChanged,
      code: "CHANGED_JUNE_RESULT",
    });
    const changedGroceries = juneChanged.full.rows.find(([month, category]) => month === "2025-06" && category === "Groceries");
    assert(
      changedGroceries[2] === COMMITTED_EXPECTED.june_groceries_tx_count + COMMITTED_EXPECTED.marker_delta_tx_count &&
        Math.abs(changedGroceries[3] - (COMMITTED_EXPECTED.june_groceries_net + COMMITTED_EXPECTED.marker_delta_net)) < 1e-6,
      "MARKER_APPLIED_IN_RESULT",
      JSON.stringify(changedGroceries)
    );

    // Old result must be untouched; keyed diff shows exactly the changed rows.
    const oldStill = (await session.apiFetch(`/api/analyses/${analysisId}/results/${june.summary.id}`, { expectStatus: 200 })).body;
    assertRowsEqual(oldStill.rows, expectedJune, "OLD_RESULT_IMMUTABLE");
    const changedCompare = await session.apiFetch(
      `/api/analyses/${analysisId}/compare?left=${june.summary.id}&right=${juneChanged.summary.id}`,
      { expectStatus: 200 }
    );
    const cmp2 = changedCompare.body;
    assert(cmp2.mode === "keyed" && cmp2.exhaustive === true && cmp2.parameters?.same === true, "CHANGED_COMPARE_BASE");
    assert(cmp2.removed_total === 0 && cmp2.added_total === 0 && cmp2.changed_total === 1, "CHANGED_COMPARE_TOTALS", JSON.stringify([cmp2.removed_total, cmp2.added_total, cmp2.changed_total]));
    const changedEntry = (cmp2.changed ?? [])[0];
    assert(changedEntry && JSON.stringify(changedEntry.key) === JSON.stringify(["2025-06", "Groceries"]), "CHANGED_COMPARE_KEY");
    const netChange = changedEntry.changes.find((change) => change.column === "net_amount");
    const countChange = changedEntry.changes.find((change) => change.column === "tx_count");
    assert(netChange && Math.abs(netChange.delta - COMMITTED_EXPECTED.marker_delta_net) < 1e-6, "CHANGED_DELTA_NET", JSON.stringify(netChange));
    assert(countChange && countChange.delta === COMMITTED_EXPECTED.marker_delta_tx_count, "CHANGED_DELTA_COUNT", JSON.stringify(countChange));
    const sourceStatuses = cmp2.sources.map((entry) => entry.status);
    assert(sourceStatuses.filter((status) => status === "same").length === 3, "COMPARE_SOURCES_SAME");
    assert(sourceStatuses.includes("removed") && sourceStatuses.includes("added"), "COMPARE_SOURCES_VERSION_DIFF");
    await session.page.getByLabel(`Select result ${june.summary.id.slice(0, 8)} for comparison`).check();
    await session.page.getByLabel(`Select result ${juneChanged.summary.id.slice(0, 8)} for comparison`).check();
    await session.page.getByRole("button", { name: /Compare selected/ }).click();
    await session.page.getByText(/^Changed \(1/).first().waitFor({ timeout: 15_000 });
    artifacts.push(await session.screenshot(artifactsDir));
    checks.data_change = {
      old_june_groceries_net: COMMITTED_EXPECTED.june_groceries_net,
      new_june_groceries_net: COMMITTED_EXPECTED.june_groceries_net + COMMITTED_EXPECTED.marker_delta_net,
      delta_verified: true,
    };

    /* -- wrap up ------------------------------------------------------------- */
    await server.quiesceWorkers({ token: await session.token() });
    session.assertClean();
    sessionB.assertClean();

    return { artifacts, checks };
  } catch (error) {
    // Failure triage without touching the harness summary contract: stable
    // codes ride in the summary; this file keeps the selector/route detail.
    await writeFile(
      path.join(artifactsDir, "debug-failure.txt"),
      String(error?.stack ?? error?.message ?? error).slice(0, 1_500)
    ).catch(() => undefined);
    artifacts.push(await session.screenshot(artifactsDir).catch(() => "shot-failed.png"));
    throw error;
  } finally {
    await session.close().catch(() => undefined);
    await sessionB?.close().catch(() => undefined);
  }
}
