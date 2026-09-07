/**
 * Journey F — Reviewed weekly brief (docs/END_TO_END_ACCEPTANCE.md row F +
 * milestones/M16-reviewed-briefs.md "Required tests and end-to-end acceptance").
 *
 * Real production build + real Chromium + the harness-launched OpenAI-compatible
 * fixture + a journey-launched authenticated WebDAV fixture serving ONE small
 * finance CSV (columns month,category,amount with an independently computed
 * known sum). Covers the fixed recipe end to end: knowledge-refreshable source
 * (M14 preview/apply into a library), saved analysis with `metric_label` as the
 * comparison key and one typed parameter (M12), the real Automations wizard
 * (analysis-revision pin, parameter seed, membership mirror, weekly civil
 * schedule + IANA zone, knowledge refresh binding, running-app caveat), Run-now
 * executions (manual idempotent pipeline), honest first-run labeling, the
 * keyed +25/+25% change asserted from the STORED comparison object (never from
 * model prose), edit-before-review through the workbench plus the stale-pointer
 * 409 refresh guidance, approve → publishing → approved with real published
 * HTML/PDF bytes, no-change silence, rejection with a durable note, the local
 * notification tray (read/dismiss durability), pause/resume, and recipe
 * deletion with retained run/review snapshots and surviving publications.
 *
 * Attribution (per the acceptance contract): schedule semantics that need an
 * injected clock — DST spring gap / autumn overlap and coalesced-missed
 * occurrence keys — are proven deterministically by the server suite
 * `server/src/tests/briefRunner.test.ts` (injected-clock runner) and
 * `server/src/tests/calendarSchedule.test.ts`. This BROWSER journey therefore
 * drives every execution through the real "Run now" pipeline (manual
 * idempotent runs), asserts the persisted weekly schedule fields, and asserts
 * that the SERVER-COMPUTED next-three occurrence preview renders honestly:
 * every rendered civil↔UTC pair is re-derived with Node's own Intl calendar
 * math (DST-shifted instants included). Production exposes no test-clock
 * control, so the journey never pretends to wait calendar days in the browser.
 *
 * Surface attribution for the published artifact: an approved brief publishes
 * through M13's document-publication service (`publishDocumentRevision`), so
 * the report appears on the Documents workbench + `/api/documents/:id/
 * publications/:pid/export`, never in the legacy `/api/reports` chat-run ledger
 * — the journey asserts that split explicitly (M16 keeps brief drafts/publications
 * out of the legacy report version chain). The coordinator's "/reports"
 * shorthand maps to this Documents-publication surface in the shipped product.
 *
 * Noted shipped-UI limitation (loud, asserted, not worked around silently):
 * the review inbox's "Approve this revision" button always sends the RUN's
 * draft-revision pointer (`row.document_revision_id`), so after a workbench
 * edit the UI approve conflicts (409 + refresh guidance) and no UI control
 * offers the moved head revision. The server contract accepts an explicit
 * head-revision decision, which the journey then performs API-with-session to
 * finish approving the edited revision it actually reviewed.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HarnessError, assert, pollUntil } from "../harness/util.mjs";
import { launchFixture } from "../harness/providers.mjs";

export const JOURNEY_ID = "F";
export const IMPLEMENTED = true;

const EMAIL = "e2e-journey-f@borealis.test";
const FOREIGN_EMAIL = "e2e-journey-f-foreign@borealis.test";
const PASSWORD = "borealis-e2e-journey-f-pass";

const LIBRARY_NAME = "Finance feed (E2E-F)";
const CONNECTION_NAME = "Finance WebDAV (E2E-F)";
const ANALYSIS_TITLE = "Finance total (E2E-F)";
const RECIPE_NAME = "Weekly finance brief (E2E-F)";
const REPORT_TITLE = "Weekly finance summary (E2E-F)";
const WEBDAV_USER = "e2e-f-user";
const TIME_ZONE = "America/New_York";

const NARRATIVE_RUN1 = "NARRATIVE-F-R1-2f09";
const NARRATIVE_REST = "NARRATIVE-F-R2-7ac4";
const EDITED_TOKEN = "EDITED-F-BEFORE-REVIEW-1e58";
const REJECT_NOTE = "Numbers unchanged; holding this week's brief (E2E-F).";

const CSV_V1 = "month,category,amount\n2026-08,rent,40\n2026-08,groceries,35\n2026-08,transport,25\n";
const CSV_V2 = "month,category,amount\n2026-09,rent,60\n2026-09,groceries,40\n2026-09,transport,25\n";

const MEMBERSHIP_NOTE =
  "Recipe membership must equal the bound analysis revision's selected source set.";
const CALENDAR_CAVEAT = "The app/server must be running for schedules to fire — there is no OS scheduler.";
const CONFLICT_GUIDANCE =
  "Refresh the inbox and decide again on the current revision";

/* ------------------------------------------------------------------ helpers */

async function goHash(session, route) {
  await session.page.evaluate((target) => {
    window.location.hash = target;
  }, route);
}

async function expectText(session, text, timeoutMs = 20_000) {
  await session.page.getByText(text).first().waitFor({ timeout: timeoutMs });
}

async function expectIn(scope, matcher, timeoutMs = 20_000) {
  await scope.getByText(matcher).first().waitFor({ timeout: timeoutMs });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Independent expectation: sum the `amount` column straight from CSV bytes. */
function sumAmountColumn(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const amountIndex = header.indexOf("amount");
  assert(amountIndex >= 0, "FIXTURE_CSV_SHAPE", "amount column missing");
  let sum = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    assert(cells.length === header.length, "FIXTURE_CSV_SHAPE", line);
    sum += Number(cells[amountIndex]);
  }
  return sum;
}

/** One WebDAV call against the fixture's real transport (Basic auth). */
async function davRequest(origin, method, relPath, { user, password, body, expectStatus, headers = {} }) {
  const auth = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  const res = await fetch(`${origin}${relPath}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...headers },
    body: body ?? undefined,
    redirect: "error",
  });
  const text = await res.text().catch(() => "");
  assert(expectStatus === undefined || res.status === expectStatus, "WEBDAV_STATUS", `${method} ${relPath} → ${res.status}`);
  return text;
}

/**
 * Re-derive one server occurrence pair with Node's own Intl math: formatting
 * `utc_at` in the recipe's zone must reproduce the rendered civil minute.
 */
function civilInZone(utcIso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcIso));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

function weekdayInZone(utcIso, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(utcIso));
}

function numericAgrees(actual, expected) {
  const value = typeof actual === "number" ? actual : Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) < 1e-6;
}

/* ------------------------------------------------------------------ journey */

export async function run(ctx) {
  const { server, provider, browser, workspace, artifactsDir } = ctx;
  const artifacts = [];
  const checks = {};
  const expectedV1 = sumAmountColumn(CSV_V1);
  const expectedV2 = sumAmountColumn(CSV_V2);
  assert(expectedV1 === 100 && expectedV2 === 125, "FIXTURE_SUMS", `${expectedV1}/${expectedV2}`);

  /* -- P0: seed the WebDAV tree with ONE finance CSV, launch the fixture ---- */
  const davRoot = workspace.assertOwnedPath(path.join(workspace.root, "webdav-tree-F"));
  fs.mkdirSync(davRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(davRoot, "finance.csv"), CSV_V1, "utf8");
  const webdavPass = `F-WEBDAV-PASS-${randomUUID()}`;
  const webdav = await launchFixture({
    workspace,
    name: "webdav",
    env: { E2E_WEBDAV_ROOT: davRoot, E2E_WEBDAV_USER: WEBDAV_USER, E2E_WEBDAV_PASS: webdavPass },
  });
  workspace.onCleanup(() => webdav.stop());
  assert(typeof webdav.ready?.origin === "string", "WEBDAV_READY_ORIGIN");
  checks.fixture = { sums: [expectedV1, expectedV2] };

  const session = await browser.newSession({ origin: server.origin });
  let sessionForeign = null;
  try {
    await session.register({ email: EMAIL, password: PASSWORD });
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P1: library + WebDAV connection + preview/apply (D pattern) -------- */
    await goHash(session, "/libraries");
    await expectText(session, "New library");
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

    const knowledge = session.page.locator('section[aria-label="Knowledge connections"]');
    await knowledge.getByRole("button", { name: "WebDAV", exact: true }).click();
    const webdavDialog = session.page.getByRole("dialog", { name: "New WebDAV collection" }).first();
    await webdavDialog.getByLabel("Connection name").fill(CONNECTION_NAME);
    await webdavDialog.getByLabel("Collection URL").fill(`${webdav.ready.origin}/`);
    await webdavDialog.getByLabel("Username").fill(WEBDAV_USER);
    await webdavDialog.getByLabel("Application password").fill(webdavPass);
    await webdavDialog.getByLabel("Target library").selectOption({ label: LIBRARY_NAME });
    await webdavDialog.getByRole("button", { name: "Create connection", exact: true }).click();
    const connCard = knowledge.locator("div.p-4").filter({ hasText: CONNECTION_NAME }).first();
    await connCard.getByText("Not tested yet").waitFor({ timeout: 15_000 });

    // Preview the one CSV and apply it — this is what makes the source
    // knowledge-refreshable for the recipe's bound refresh.
    await connCard.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = session.page.getByRole("dialog", { name: `Preview — ${CONNECTION_NAME}` }).first();
    await expectIn(preview, /1 new/, 30_000);
    await preview.getByLabel("Select finance.csv").check();
    await preview.getByRole("button", { name: /Import selected \(1\)/ }).click();
    const member = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/libraries/${library.id}`, { expectStatus: 200 });
        const found = (res.body?.members ?? []).find((item) => (item.display_name || item.name) === "finance.csv");
        return found && found.status === "ready" ? found : null;
      },
      { deadlineMs: 150_000, intervalMs: 400 }
    );
    assert(Boolean(member), "FINANCE_MEMBER_NOT_READY");
    const financeSourceId = member.id;
    const generationV1 = member.ready_generation;
    assert(typeof generationV1 === "number" && generationV1 >= 1, "FINANCE_GENERATION");

    // The source must be tabular with a real DuckDB table for the analysis.
    const sourceRow = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/sources", { expectStatus: 200 });
        const found = (res.body?.items ?? []).find((item) => item.id === financeSourceId);
        return found?.status === "ready" && found?.tabular?.table ? found : null;
      },
      { deadlineMs: 60_000, intervalMs: 300 }
    );
    assert(Boolean(sourceRow), "FINANCE_NOT_TABULAR");
    const table = sourceRow.tabular.table;
    checks.source = { id_head: financeSourceId.slice(0, 8), table, generation: generationV1 };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P2: saved analysis + baseline result (API-with-browser-session) ---- */
    // The SQL groups to one keyed total row exactly like the M16 acceptance
    // example: metric_label='total' with the changing sum as `value`; the one
    // typed parameter is bound positionally (`?`) and mirrored by the wizard.
    const sql = `SELECT ? AS metric_label, SUM(amount) AS value FROM ${table}`;
    const created = await session.apiFetch("/api/analyses", {
      method: "POST",
      expectStatus: 201,
      body: {
        title: ANALYSIS_TITLE,
        sql,
        parameters: [{ name: "label", type: "string", required: true, default: "total", label: "Metric label" }],
        source_ids: [financeSourceId],
        comparison_key: ["metric_label"],
      },
    });
    const analysisId = created.body?.id;
    assert(typeof analysisId === "string", "ANALYSIS_CREATED");
    const analysisDetail = (await session.apiFetch(`/api/analyses/${analysisId}`, { expectStatus: 200 })).body;
    assert(analysisDetail.current_revision === 1, "ANALYSIS_REVISION");
    assert(JSON.stringify(analysisDetail.comparison_key) === JSON.stringify(["metric_label"]), "ANALYSIS_KEY");

    const baselineRun = await session.apiFetch(`/api/analyses/${analysisId}/runs`, {
      method: "POST",
      expectStatus: 202,
      body: { values: { label: "total" }, operation_id: randomUUID() },
    });
    const baselineRunId = baselineRun.body?.run?.id;
    assert(typeof baselineRunId === "string", "BASELINE_RUN_QUEUED");
    await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/analyses/${analysisId}/runs/${baselineRunId}`, { expectStatus: 200 });
        return res.body?.status === "succeeded" ? true : null;
      },
      { deadlineMs: 60_000, intervalMs: 250 }
    ).then((done) => assert(done === true, "BASELINE_RUN_SUCCEEDED"));
    const baselineResult = await pollUntil(
      async () => (await session.apiFetch(`/api/analyses/${analysisId}/results`, { expectStatus: 200 })).body?.items?.[0] ?? null,
      { deadlineMs: 15_000, intervalMs: 250 }
    );
    assert(Boolean(baselineResult), "BASELINE_RESULT");
    const baselineFull = (await session.apiFetch(`/api/analyses/${analysisId}/results/${baselineResult.id}`, { expectStatus: 200 })).body;
    assert(baselineFull.rows.length === 1 && baselineFull.rows[0][0] === "total", "BASELINE_ROW_SHAPE", JSON.stringify(baselineFull.rows));
    assert(numericAgrees(baselineFull.rows[0][1], expectedV1), "BASELINE_SUM", JSON.stringify(baselineFull.rows));
    await goHash(session, "/analyses");
    await expectText(session, ANALYSIS_TITLE);
    checks.analysis = { key: "metric_label", baseline_sum: expectedV1 };
    artifacts.push(await session.screenshot(artifactsDir));

    // The scripted narrative: run 1 gets a deliberately slow step so the
    // one-active-run window is reliably observable; later runs replay the
    // final text step (repeat-last), one bounded chat call per brief run.
    await provider.setScript({
      steps: [
        { type: "slow", delay_ms: 2500, pieces: [`Weekly finance brief draft narrative ${NARRATIVE_RUN1}.`] },
        { type: "text", pieces: [`Weekly finance brief draft narrative ${NARRATIVE_REST}.`] },
      ],
      onExhausted: "repeat-last",
    });

    /* -- P3: create the recipe through the real Automations wizard ---------- */
    await goHash(session, "/automations");
    await expectText(session, "Reviewed briefs");
    await session.page.getByRole("button", { name: "New brief", exact: true }).click();
    const wizard = session.page.getByRole("dialog", { name: "New reviewed brief" }).first();
    await wizard.getByLabel("Brief name").fill(RECIPE_NAME);
    await wizard.getByLabel("Saved analysis").selectOption(analysisId);
    await expectIn(wizard, "pinned to definition revision 1");
    // Membership mirror: the bound revision's exact source set, disabled.
    await expectIn(wizard, MEMBERSHIP_NOTE);
    const mirror = wizard.getByLabel("Source finance.csv");
    await mirror.waitFor({ timeout: 15_000 });
    assert((await mirror.isChecked()) === true, "MEMBERSHIP_MIRROR_UNCHECKED");
    assert((await mirror.isDisabled()) === true, "MEMBERSHIP_MIRROR_EDITABLE");
    // Typed parameter seeded from the bound revision's declaration default.
    const paramInput = wizard.getByLabel("Parameter label");
    await paramInput.waitFor({ timeout: 15_000 });
    assert((await paramInput.inputValue()) === "total", "PARAMETER_SEED", await paramInput.inputValue());
    await wizard.getByLabel("Report title").fill(REPORT_TITLE);
    await wizard
      .getByLabel("Draft instruction")
      .fill("Summarize the weekly total with the keyed comparison against last week (E2E-F).");
    // Bound refresh: this source refreshes through the knowledge connection.
    await wizard.getByLabel("Refresh mode for finance.csv").selectOption("knowledge");
    const connectionRow = await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/knowledge-connections", { expectStatus: 200 });
        return (res.body?.items ?? []).find((item) => item.name === CONNECTION_NAME) ?? null;
      },
      { deadlineMs: 15_000, intervalMs: 200 }
    );
    assert(Boolean(connectionRow), "CONNECTION_ROW_MISSING");
    await wizard.getByLabel("Knowledge connection for finance.csv").selectOption(connectionRow.id);
    // Civil weekly schedule: Mondays 09:00 in an explicit IANA zone.
    await wizard.getByLabel("Schedule kind").selectOption("weekly");
    await wizard.getByLabel("Weekday").selectOption("1");
    await wizard.getByLabel("Hour (0-23)").fill("9");
    await wizard.getByLabel("Minute (0-59)").fill("0");
    await wizard.getByLabel("Time zone").selectOption(TIME_ZONE);
    // Running-app caveat is a first-class part of the schedule control, and
    // the create form defers the resolved preview to the saved detail.
    await expectIn(wizard, CALENDAR_CAVEAT);
    await expectIn(wizard, "After saving, the recipe detail shows the server's next three run times");
    /* -- Wizard create (the shipped defect BRIEF_WIZARD_NULL_SCHEMA was
     * fixed in d805b4a: the wire body omits unused keys). This journey now
     * exercises the REAL wizard path end to end: one click, a schema-valid
     * POST, 201, and the dialog closing — no API-side workaround. */
    const wizardCreateResponse = session.page
      .waitForResponse((res) => res.url().endsWith("/api/briefs") && res.request().method() === "POST", {
        timeout: 20_000,
      })
      .catch(() => null);
    await wizard.getByRole("button", { name: "Create brief", exact: true }).click();
    const wizardCreate = await wizardCreateResponse;
    assert(wizardCreate !== null, "WIZARD_CREATE_REQUEST_MISSING");
    const wizardStatus = wizardCreate.status();
    assert(wizardStatus === 201, "WIZARD_CREATE_FAILED", String(wizardStatus));
    await wizard.waitFor({ state: "hidden", timeout: 15_000 });
    const recipeCreate = { body: await wizardCreate.json() };
    assert(recipeCreate.body?.id, "RECIPE_NOT_CREATED");
    const recipe = { id: recipeCreate.body.id, ...recipeCreate.body };
    const detail = (await session.apiFetch(`/api/briefs/${recipe.id}`, { expectStatus: 200 })).body;
    // Persisted schedule fields: civil rule + zone + server-owned next run.
    assert(detail.schedule.kind === "weekly", "SCHEDULE_KIND");
    assert(detail.schedule.weekday === 1, "SCHEDULE_WEEKDAY", String(detail.schedule.weekday));
    assert(detail.schedule.hour === 9 && detail.schedule.minute === 0, "SCHEDULE_TIME");
    assert(detail.schedule.time_zone === TIME_ZONE, "SCHEDULE_ZONE", detail.schedule.time_zone);
    assert(JSON.stringify(detail.source_ids) === JSON.stringify([financeSourceId]), "RECIPE_MEMBERSHIP");
    assert(detail.refresh_bindings?.[0]?.kind === "knowledge" && detail.refresh_bindings[0].connection_id === connectionRow.id, "REFRESH_BINDING");
    const paramsJson = JSON.stringify(
      (detail.parameter_values ?? []).map((entry) => [entry.name ?? entry[0], entry.value ?? entry[1]])
    );
    assert(/label/.test(paramsJson) && /total/.test(paramsJson), "RECIPE_PARAMETER", paramsJson);
    // Server-computed next-3 preview: every civil↔UTC pair must reproduce
    // under Node's own Intl calendar math, Mondays 09:00 in the zone.
    const occurrences = detail.next_occurrences ?? [];
    assert(occurrences.length === 3, "OCCURRENCES_COUNT", String(occurrences.length));
    const seenKeys = new Set();
    for (const occurrence of occurrences) {
      assert(!seenKeys.has(occurrence.occurrence_key), "OCCURRENCE_KEY_DUPLICATE");
      seenKeys.add(occurrence.occurrence_key);
      const derived = civilInZone(occurrence.utc_at, TIME_ZONE).replace(" ", "T");
      assert(occurrence.civil === derived, "OCCURRENCE_CIVIL_UTC_MISMATCH", `${occurrence.civil} vs ${derived}`);
      assert(weekdayInZone(occurrence.utc_at, TIME_ZONE) === "Mon", "OCCURRENCE_NOT_MONDAY", occurrence.civil);
      assert(/^\d{4}-\d{2}-\d{2}T09:00$/.test(occurrence.civil), "OCCURRENCE_NOT_0900", occurrence.civil);
      assert(new Date(occurrence.utc_at).getTime() > Date.now(), "OCCURRENCE_IN_PAST", occurrence.utc_at);
    }
    for (let index = 1; index < occurrences.length; index += 1) {
      const deltaDays =
        (new Date(occurrences[index].utc_at).getTime() - new Date(occurrences[index - 1].utc_at).getTime()) / 86_400_000;
      // Weekly civil cadence: seven calendar days, give or take an hour of DST shift.
      assert(Math.abs(deltaDays - 7) <= 1 / 12, "OCCURRENCE_SPACING", String(deltaDays));
    }
    assert(detail.next_run_at === occurrences[0].utc_at, "NEXT_RUN_MISMATCH", `${detail.next_run_at} vs ${occurrences[0].utc_at}`);
    assert(detail.next_occurrence_key === occurrences[0].occurrence_key, "NEXT_KEY_MISMATCH");
    checks.schedule = {
      persisted: "weekly Mon 09:00 " + TIME_ZONE,
      preview_pairs_verified: occurrences.length,
      first_utc: occurrences[0].utc_at,
    };

    const openManage = async () => {
      await goHash(session, "/automations");
      // A fresh mount re-fetches the recipe catalog (API-side changes since
      // the last render — creation, external runs — must be visible).
      await session.page.reload({ waitUntil: "domcontentloaded" });
      await expectText(session, "Reviewed briefs", 30_000);
      const card = session.page.locator("div.p-4").filter({ hasText: RECIPE_NAME }).first();
      await card.getByRole("button", { name: "Manage", exact: true }).click();
      const dialog = session.page.getByRole("dialog", { name: RECIPE_NAME }).first();
      await dialog.waitFor({ timeout: 20_000 });
      return dialog;
    };
    const manage1 = await openManage();
    // The same server-computed three-run preview must RENDER honestly in the
    // manage dialog (local + UTC text lines, not a client-side recompute).
    const previewItems = manage1.locator("li");
    await pollUntil(
      async () => (await manage1.getByText(occurrences[0].civil.replace("T", " ")).count()) > 0,
      { deadlineMs: 20_000, intervalMs: 250 }
    ).then((seen) => assert(seen === true, "PREVIEW_NOT_RENDERED"));
    await expectIn(manage1, occurrences[0].utc_at.replace("T", " ").replace(".000Z", "Z"));
    assert((await previewItems.count()) >= 3, "PREVIEW_ROWS_SHORT", String(await previewItems.count()));
    await expectIn(manage1, CALENDAR_CAVEAT);
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- helpers bound to the recipe ---------------------------------------- */
    const recipeRunNow = async (dialog) => {
      const panel = dialog.locator(`[aria-label="Runs for ${RECIPE_NAME}"]`);
      const runNow = panel.getByRole("button", { name: "Run now", exact: true });
      await runNow.waitFor({ timeout: 20_000 });
      const beforeIds = new Set(
        ((await session.apiFetch(`/api/briefs/${recipe.id}/runs`, { expectStatus: 200 })).body?.items ?? []).map(
          (item) => item.id
        )
      );
      await runNow.click();
      const fresh = await pollUntil(
        async () => {
          const res = await session.apiFetch(`/api/briefs/${recipe.id}/runs`, { expectStatus: 200 });
          return (res.body?.items ?? []).find((item) => !beforeIds.has(item.id)) ?? null;
        },
        { deadlineMs: 30_000, intervalMs: 200 }
      );
      assert(Boolean(fresh), "RUN_NOW_NOT_ACCEPTED");
      return { run: fresh, panel, runNow };
    };
    const pollRun = async (runId, wanted, code, deadlineMs = 180_000) => {
      let last = null;
      await pollUntil(
        async () => {
          const res = await session.apiFetch(`/api/briefs/${recipe.id}/runs/${runId}`, { expectStatus: 200 });
          last = res.body;
          return wanted.includes(last?.stage) ? true : null;
        },
        { deadlineMs, intervalMs: 300 }
      );
      assert(last !== null && wanted.includes(last.stage), code, `run ended as ${last?.stage}/${last?.failure_code}`);
      return last;
    };
    const reviewRow = (name = RECIPE_NAME) => session.page.locator(`[aria-label="Review for ${name}"]`);
    const findReviewRow = async (runId) => {
      const rows = await pollUntil(
        async () => {
          const res = await session.apiFetch("/api/brief-reviews", { expectStatus: 200 });
          return (res.body?.items ?? []).find((item) => item.id === runId) ?? null;
        },
        { deadlineMs: 30_000, intervalMs: 300 }
      );
      assert(Boolean(rows), "REVIEW_ROW_MISSING", runId);
      return rows;
    };
    const notifications = async () =>
      (await session.apiFetch("/api/notifications", { expectStatus: 200 })).body?.items ?? [];

    /* -- P4: Run now #1 → first-run labeling → approve → publication -------- */
    const providerBefore = await provider.state();
    const run1 = await recipeRunNow(manage1);
    // UI-level one-active: the Run now control is disabled while the run
    // executes (Playwright clicks could never double-submit from the UI).
    const disabledDuringActive = await pollUntil(
      async () => ((await run1.runNow.isDisabled().catch(() => false)) === true ? true : null),
      { deadlineMs: 10_000, intervalMs: 150 }
    );
    assert(disabledDuringActive === true, "RUN_NOW_NOT_DISABLED_WHILE_ACTIVE");

    // API-level failure matrix on the same account/session: a second Run-now
    // intent with a DIFFERENT key conflicts (one active run per recipe) while
    // a retry with the SAME key durably replays the original 202.
    session.allowStatuses([409]);
    const duplicate = await session.apiFetch(`/api/briefs/${recipe.id}/runs`, {
      method: "POST",
      body: { operation_id: randomUUID() },
    });
    assert(duplicate.status === 409 && duplicate.body?.code === "BRIEF_ACTIVE_RUN", "DUPLICATE_RUN_NOT_409", String(duplicate.status));
    const runsAfterDuplicate = (await session.apiFetch(`/api/briefs/${recipe.id}/runs`, { expectStatus: 200 })).body?.items ?? [];
    assert(runsAfterDuplicate.length === 1, "DUPLICATE_RUN_CREATED_ROW", String(runsAfterDuplicate.length));
    const replay = await session.apiFetch(`/api/briefs/${recipe.id}/runs`, {
      method: "POST",
      body: { operation_id: run1.run.operation_id },
      expectStatus: 202,
    });
    assert(replay.body?.replayed === true && replay.body?.run?.id === run1.run.id, "RUN_REPLAY_MISMATCH", JSON.stringify(replay.body));
    checks.failure_matrix = ["ui-run-now-disabled-while-active", "second-key-409-BRIEF_ACTIVE_RUN", "same-key-202-replayed"];

    const run1Final = await pollRun(run1.run.id, ["awaiting_review"], "RUN1_AWAITING");
    assert(run1Final.trigger === "manual", "RUN1_TRIGGER");
    // Cosmetic shipped defect (repro: every manual run): briefRunStore
    // .createManualRun inserts coalesced_count=1, so the runs panel/review
    // rows label manual runs "coalesced 1 missed occurrence". Not load-
    // bearing; reported, not asserted, so the journey stays meaningful.
    assert(run1Final.occurrence_key === `manual:${run1.run.operation_id}`, "RUN1_OCCURRENCE_KEY");
    assert(run1Final.analysis_succeeded === true && run1Final.analysis_run_id !== null, "RUN1_ANALYSIS_COMMIT");
    assert(run1Final.baseline_run_id === null, "RUN1_BASELINE_NOT_NULL");
    assert(run1Final.comparison_summary === null, "RUN1_COMPARISON_NOT_NULL", JSON.stringify(run1Final.comparison_summary));
    assert(run1Final.refresh_receipts?.length === 1, "RUN1_RECEIPT_COUNT");
    const receipt1 = run1Final.refresh_receipts[0];
    assert(
      receipt1.kind === "knowledge" && receipt1.outcome === "unchanged" && receipt1.generation === generationV1 && receipt1.label === "verified unchanged",
      "RUN1_RECEIPT",
      JSON.stringify(receipt1)
    );
    const providerAfterRun1 = await provider.state();
    assert(providerAfterRun1.chat_calls - providerBefore.chat_calls === 1, "RUN1_CHAT_CALLS");
    checks.run1 = { stage: "awaiting_review", receipt: "knowledge/unchanged/gen-" + generationV1, chat_calls: 1 };

    await goHash(session, "/reviews");
    await expectText(session, "Awaiting review");
    const row1 = reviewRow().first();
    await expectIn(row1, "awaiting review");
    // Honest first-run labeling: no baseline → nothing claimed, not "no change".
    await expectIn(row1, "No comparison committed for this run yet.");
    await expectIn(row1, /verified unchanged · knowledge · unchanged · gen \d+/);
    artifacts.push(await session.screenshot(artifactsDir));

    await row1.getByRole("button", { name: "Approve this revision", exact: true }).click();
    const run1Approved = await pollRun(run1.run.id, ["approved"], "RUN1_APPROVED");
    assert(run1Approved.reviewed_revision_id === run1Final.document_revision_id, "RUN1_REVIEWED_REVISION");
    assert(run1Approved.publication_operation_id !== null, "RUN1_PUBLICATION_OPERATION");
    const doc1Id = run1Final.document_id;
    const publications1 = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/documents/${doc1Id}/publications`, { expectStatus: 200 });
        const items = res.body?.items ?? [];
        return items.length === 1 ? items : null;
      },
      { deadlineMs: 180_000, intervalMs: 400 }
    );
    assert(Boolean(publications1), "RUN1_PUBLICATION_MISSING");
    assert(publications1[0].version === 1, "RUN1_PUBLICATION_VERSION");
    assert(publications1[0].revision_id === run1Final.document_revision_id, "RUN1_PUBLICATION_REVISION");
    checks.run1_publish = { publication: "v1", document: doc1Id.slice(0, 8) };

    // Published-by-the-app, never outbound: the artifact lives on the
    // Documents publication surface; the legacy chat-run /api/reports ledger
    // is untouched by reviewed briefs (verified here, loudly).
    const legacyReports = await session.apiFetch("/api/reports", { expectStatus: 200 });
    assert((legacyReports.body?.items ?? []).length === 0, "BRIEF_PUBLISHED_TO_LEGACY_REPORTS");
    checks.no_legacy_report_chain = true;

    // Real authenticated browser downloads of the published bytes.
    await goHash(session, `/documents/${doc1Id}`);
    await expectText(session, "Publications");
    await expectText(session, "v1");
    const downloadPublication = async (docId, label, fileHint) => {
      await goHash(session, `/documents/${docId}`);
      await expectText(session, "Publications", 30_000);
      const destination = workspace.assertOwnedPath(path.join(workspace.root, "downloads", fileHint));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const [download] = await Promise.all([
        session.page.waitForEvent("download", { timeout: 120_000 }),
        session.page.getByRole("button", { name: label, exact: true }).first().click(),
      ]);
      await download.saveAs(destination);
      return destination;
    };
    const html1Path = await downloadPublication(doc1Id, "HTML", "run1.html");
    const pdf1Path = await downloadPublication(doc1Id, "PDF", "run1.pdf");
    const html1 = fs.readFileSync(html1Path, "utf8");
    const pdf1 = fs.readFileSync(pdf1Path);
    assert(html1.includes("<html") && html1.includes(NARRATIVE_RUN1), "HTML1_CONTENT");
    assert(html1.includes(String(expectedV1)), "HTML1_VALUE_MISSING");
    assert(!/<(script|img|link|iframe)[^>]+(src|href)="https?:/i.test(html1), "HTML1_EXTERNAL_RESOURCE");
    assert(pdf1.subarray(0, 5).toString("latin1") === "%PDF-", "PDF1_MAGIC");
    // Text-channel baseline for the immutability recheck (same fetch channel
    // used later, so the byte comparison is apples-to-apples).
    const html1Baseline = await session.apiFetchText(
      `/api/documents/${doc1Id}/publications/${publications1[0].id}/export?format=html`,
      { expectStatus: 200 }
    );
    const html1ShaText = sha256(Buffer.from(html1Baseline.text, "utf8"));
    checks.run1_exports = { html_sha_head: html1ShaText.slice(0, 8), pdf_magic: "%PDF-" };
    artifacts.push(await session.screenshot(artifactsDir));

    // Notification rule: exactly one local first_draft event, inbox-only.
    const notificationsAfterRun1 = await notifications();
    assert(notificationsAfterRun1.length === 1, "NOTIFICATION_FIRST_COUNT", String(notificationsAfterRun1.length));
    assert(
      notificationsAfterRun1[0].kind === "first_draft" && notificationsAfterRun1[0].run_id === run1.run.id && notificationsAfterRun1[0].state === "unread",
      "NOTIFICATION_FIRST",
      JSON.stringify(notificationsAfterRun1[0])
    );
    checks.notifications_run1 = "first_draft/unread";

    /* -- P5: upstream change 100→125 → keyed delta → edit → approve #2 ------ */
    await davRequest(webdav.ready.origin, "PUT", "/finance.csv", {
      user: WEBDAV_USER,
      password: webdavPass,
      body: CSV_V2,
      expectStatus: 204,
      headers: { "Content-Type": "text/csv" },
    });
    const manage2 = await openManage();
    const run2 = await recipeRunNow(manage2);
    const run2Final = await pollRun(run2.run.id, ["awaiting_review"], "RUN2_AWAITING");
    // The refresh promoted a NEW generation and the analysis consumed it.
    const receipt2 = run2Final.refresh_receipts?.[0];
    assert(
      receipt2?.kind === "knowledge" && receipt2?.outcome === "promoted" && receipt2?.generation === generationV1 + 1,
      "RUN2_RECEIPT",
      JSON.stringify(receipt2)
    );
    assert(run2Final.baseline_run_id === run1.run.id, "RUN2_BASELINE", String(run2Final.baseline_run_id));
    // The KEYED DELTA comes from the stored comparison object — never prose.
    const comparison2 = run2Final.comparison_summary;
    assert(comparison2?.kind === "compared", "RUN2_COMPARISON_KIND", JSON.stringify(comparison2));
    assert(comparison2.mode === "keyed" && JSON.stringify(comparison2.key_columns) === JSON.stringify(["metric_label"]), "RUN2_COMPARISON_KEYED");
    assert(comparison2.exhaustive === true && comparison2.truncated === false, "RUN2_COMPARISON_EXHAUSTIVE");
    assert(comparison2.changed_total === 1 && comparison2.added_total === 0 && comparison2.removed_total === 0, "RUN2_COMPARISON_TOTALS", JSON.stringify(comparison2));
    const changed2 = comparison2.changed_sample?.[0];
    assert(JSON.stringify(changed2?.key) === JSON.stringify(["total"]), "RUN2_CHANGED_KEY", JSON.stringify(changed2));
    const valueChange2 = changed2?.changes?.find((entry) => entry.column === "value");
    const delta = expectedV2 - expectedV1;
    const percent = Math.round((delta / expectedV1) * 10_000) / 100;
    assert(valueChange2 && numericAgrees(valueChange2.delta, delta), "RUN2_DELTA", JSON.stringify(valueChange2));
    // Current/baseline values behind the delta: 125 vs 100 (→ +25/+25%).
    const currentResult2 = (
      await session.apiFetch(`/api/analyses/${analysisId}/results/${comparison2.current_result_id}`, { expectStatus: 200 })
    ).body;
    const baselineResult2 = (
      await session.apiFetch(`/api/analyses/${analysisId}/results/${comparison2.baseline_result_id}`, { expectStatus: 200 })
    ).body;
    assert(numericAgrees(currentResult2.rows[0][1], expectedV2), "RUN2_CURRENT_VALUE", JSON.stringify(currentResult2.rows));
    assert(numericAgrees(baselineResult2.rows[0][1], expectedV1), "RUN2_BASELINE_VALUE", JSON.stringify(baselineResult2.rows));
    checks.run2_comparison = { delta, percent, mode: "keyed", source: "stored comparison_summary" };

    await goHash(session, "/reviews");
    const row2 = reviewRow().filter({ hasText: run2.run.id.slice(0, 8) }).first();
    await row2.waitFor({ timeout: 20_000 });
    await expectIn(row2, /Keyed comparison on metric_label/);
    await expectIn(row2, /changed 1/);
    await expectIn(row2, /value \+25/);
    await expectIn(row2, /promoted/);
    artifacts.push(await session.screenshot(artifactsDir));

    // Edit-before-review in the M13 workbench: replace the Summary section
    // and save a real new revision (head moves past the review pointer).
    const doc2Id = run2Final.document_id;
    await goHash(session, `/documents/${doc2Id}`);
    await expectText(session, "Save revision");
    const summaryEditor = session.page.getByLabel("Markdown of section 1");
    await summaryEditor.waitFor({ timeout: 20_000 });
    await summaryEditor.fill(`Draft edited before review. ${EDITED_TOKEN}`);
    await session.page.getByRole("button", { name: "Save revision", exact: true }).click();
    const headAfterEdit = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/documents/${doc2Id}`, { expectStatus: 200 });
        const headId = res.body?.current_revision_id;
        return headId && headId !== run2Final.document_revision_id ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 250 }
    );
    assert(Boolean(headAfterEdit), "DRAFT_EDIT_NOT_PERSISTED");
    checks.run2_edit = { head_moved: true };

    // Stale-pointer decision: the shipped UI approve always sends the RUN's
    // draft revision, so after the edit it must conflict with refresh
    // guidance — and the UI never offers the moved head revision (documented
    // shipped limitation; the server contract is exercised next via API).
    await goHash(session, "/reviews");
    const row2b = reviewRow().filter({ hasText: run2.run.id.slice(0, 8) }).first();
    await row2b.waitFor({ timeout: 20_000 });
    await expectIn(row2b, /the draft was edited after this pointer/);
    await row2b.getByRole("button", { name: "Approve this revision", exact: true }).click();
    const row2c = reviewRow().filter({ hasText: run2.run.id.slice(0, 8) }).first();
    await expectIn(row2c, new RegExp(CONFLICT_GUIDANCE.split(" ").join("\\s")));
    const stillAwaiting = (await session.apiFetch(`/api/briefs/${recipe.id}/runs/${run2.run.id}`, { expectStatus: 200 })).body;
    assert(stillAwaiting.stage === "awaiting_review" && stillAwaiting.reviewed_revision_id === null, "STALE_DECISION_WROTE", stillAwaiting.stage);
    checks.failure_matrix.push("stale-pointer-approve-409-BRIEF_REVIEW_REVISION_CONFLICT-with-refresh-guidance");

    // Approve the exact edited head revision through the server contract.
    const headRow = await findReviewRow(run2.run.id);
    assert(headRow.head_moved === true, "HEAD_MOVED_FLAG");
    assert(headRow.document_head_revision_id === headAfterEdit.current_revision_id, "HEAD_ROW_POINTER");
    const decision2 = await session.apiFetch(`/api/brief-reviews/${run2.run.id}/decision`, {
      method: "POST",
      expectStatus: 202,
      body: { decision: "approve", document_revision_id: headAfterEdit.current_revision_id },
    });
    assert(decision2.body?.status === "publishing", "RUN2_DECISION_STATUS", JSON.stringify(decision2.body));
    const run2Approved = await pollRun(run2.run.id, ["approved"], "RUN2_APPROVED");
    assert(run2Approved.reviewed_revision_id === headAfterEdit.current_revision_id, "RUN2_REVIEWED_HEAD");
    const publications2 = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/documents/${doc2Id}/publications`, { expectStatus: 200 });
        const items = res.body?.items ?? [];
        return items.length === 1 ? items : null;
      },
      { deadlineMs: 180_000, intervalMs: 400 }
    );
    assert(Boolean(publications2) && publications2[0].revision_id === headAfterEdit.current_revision_id, "RUN2_PUBLICATION_REVISION");
    const html2Path = await downloadPublication(doc2Id, "HTML", "run2.html");
    const pdf2Path = await downloadPublication(doc2Id, "PDF", "run2.pdf");
    const html2 = fs.readFileSync(html2Path, "utf8");
    assert(html2.includes(EDITED_TOKEN), "HTML2_EDIT_MISSING");
    assert(html2.includes(String(expectedV2)) && html2.includes(String(expectedV1)), "HTML2_PREVIEW_VALUES");
    assert(fs.readFileSync(pdf2Path).subarray(0, 5).toString("latin1") === "%PDF-", "PDF2_MAGIC");
    checks.run2_publish = { edited_head_published: true, html_includes_edit: true };

    // Immutable history: run 1's approved revision/publication bytes unchanged.
    const html1Again = await session.apiFetchText(`/api/documents/${doc1Id}/publications/${publications1[0].id}/export?format=html`, {
      expectStatus: 200,
    });
    assert(html1Again.text.includes(NARRATIVE_RUN1) && !html1Again.text.includes(EDITED_TOKEN), "HTML1_IMMUTABLE");
    assert(sha256(Buffer.from(html1Again.text, "utf8")) === html1ShaText, "HTML1_BYTES_DRIFT");
    const run1After = (await session.apiFetch(`/api/briefs/${recipe.id}/runs/${run1.run.id}`, { expectStatus: 200 })).body;
    assert(run1After.stage === "approved" && run1After.reviewed_revision_id === run1Final.document_revision_id, "RUN1_HISTORY_DRIFT");
    checks.immutable_history = { run1_still_v1: true };

    const notificationsAfterRun2 = await notifications();
    assert(notificationsAfterRun2.length === 2, "NOTIFICATION_SECOND_COUNT", String(notificationsAfterRun2.length));
    assert(
      notificationsAfterRun2.some((item) => item.kind === "meaningful_change" && item.run_id === run2.run.id),
      "NOTIFICATION_MEANINGFUL_CHANGE"
    );

    /* -- P6: unchanged run → honest no-change + notification silence -------- */
    const manage3 = await openManage();
    const run3 = await recipeRunNow(manage3);
    const run3Final = await pollRun(run3.run.id, ["awaiting_review"], "RUN3_AWAITING");
    assert(
      run3Final.refresh_receipts?.[0]?.outcome === "unchanged" && run3Final.refresh_receipts[0].generation === generationV1 + 1,
      "RUN3_RECEIPT",
      JSON.stringify(run3Final.refresh_receipts)
    );
    const comparison3 = run3Final.comparison_summary;
    assert(comparison3?.kind === "compared" && comparison3.mode === "keyed" && comparison3.exhaustive === true, "RUN3_COMPARISON");
    assert(comparison3.changed_total === 0 && comparison3.added_total === 0 && comparison3.removed_total === 0, "RUN3_NO_CHANGE_TOTALS", JSON.stringify(comparison3));
    await goHash(session, "/reviews");
    const row3 = reviewRow().filter({ hasText: run3.run.id.slice(0, 8) }).first();
    await row3.waitFor({ timeout: 20_000 });
    await expectIn(row3, "Deterministically unchanged from the baseline.");
    const notificationsAfterRun3 = await notifications();
    assert(notificationsAfterRun3.length === 2, "NOTIFICATION_NO_CHANGE_LEAK", String(notificationsAfterRun3.length));
    assert(!notificationsAfterRun3.some((item) => item.run_id === run3.run.id), "NOTIFICATION_FOR_RUN3");
    checks.run3 = { comparison: "keyed unchanged", notification: "none (dedup/silence)" };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P7: fourth run → reject with note; no publication ------------------ */
    // Scheduling a new run while run 3's draft still awaits review proves the
    // "awaiting review does not block later occurrences" rule.
    const manage4 = await openManage();
    const run4 = await recipeRunNow(manage4);
    const run4Final = await pollRun(run4.run.id, ["awaiting_review"], "RUN4_AWAITING");
    await goHash(session, "/reviews");
    const row4 = reviewRow().filter({ hasText: run4.run.id.slice(0, 8) }).first();
    await row4.waitFor({ timeout: 20_000 });
    await row4.getByRole("button", { name: "Reject…", exact: true }).click();
    await row4.getByLabel("Rejection note (optional)").fill(REJECT_NOTE);
    await row4.getByRole("button", { name: /Reject \(keeps the run and draft\)/ }).click();
    const run4Decided = await pollRun(run4.run.id, ["rejected"], "RUN4_REJECTED");
    assert(run4Decided.publication_operation_id === null, "REJECT_PUBLISHED");
    await expectIn(
      reviewRow().filter({ hasText: run4.run.id.slice(0, 8) }).first(),
      "Rejection preserved the run and draft for inspection; it cannot publish."
    );
    await expectIn(reviewRow().filter({ hasText: run4.run.id.slice(0, 8) }).first(), REJECT_NOTE);
    // Draft preserved and readable; nothing was ever published for it.
    const doc4 = (await session.apiFetch(`/api/documents/${run4Final.document_id}`, { expectStatus: 200 })).body;
    assert(doc4.id === run4Final.document_id, "REJECTED_DRAFT_GONE");
    const publications4 = (await session.apiFetch(`/api/documents/${run4Final.document_id}/publications`, { expectStatus: 200 })).body;
    assert((publications4.items ?? []).length === 0, "REJECTED_DRAFT_PUBLISHED");
    const legacyAfterReject = await session.apiFetch("/api/reports", { expectStatus: 200 });
    assert((legacyAfterReject.body?.items ?? []).length === 0, "REJECT_PUBLISHED_TO_LEGACY");
    // run 3 is still pending review — the inbox keeps both, never auto-decided.
    const row3Still = reviewRow().filter({ hasText: run3.run.id.slice(0, 8) }).first();
    await expectIn(row3Still, "awaiting review");
    checks.run4 = { rejected_with_note: true, draft_preserved: true, published: false, run3_still_pending: true };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P8: notification tray read/dismiss durability ---------------------- */
    await session.page.reload({ waitUntil: "domcontentloaded" });
    const trayButton = session.page.getByRole("button", { name: /Notifications/ }).first();
    await trayButton.waitFor({ timeout: 20_000 });
    await trayButton.click();
    const tray = session.page.locator('[aria-label="Local notifications"]');
    await tray.waitFor({ timeout: 15_000 });
    await expectIn(tray, "New draft ready");
    await expectIn(tray, "Result changed");
    await expectIn(tray, /never sent anywhere/i);
    const readItem = notificationsAfterRun1[0]; // the first_draft row
    const readButton = tray.locator("div.rounded-md.border").filter({ hasText: "New draft ready" }).first().getByRole("button", { name: "Mark read", exact: true });
    await readButton.click();
    // Durable `read` state + `read_at` via the paginated list (the surface
    // exposes PATCH + list only — there is no per-id GET route).
    const readRow = await pollUntil(
      async () => {
        const items = await notifications();
        const found = items.find((item) => item.id === readItem.id);
        return found?.state === "read" && found?.read_at !== null ? found : null;
      },
      { deadlineMs: 15_000, intervalMs: 250 }
    );
    assert(Boolean(readRow), "NOTIFICATION_READ_NOT_LISTED");
    const dismissTarget = (await notifications()).find((item) => item.kind === "meaningful_change");
    const dismissButton = tray.locator("div.rounded-md.border").filter({ hasText: "Result changed" }).first().getByRole("button", { name: "Dismiss", exact: true });
    await dismissButton.click();
    const dismissedRow = await pollUntil(
      async () => {
        const items = await notifications();
        const found = items.find((item) => item.id === dismissTarget.id);
        return found?.state === "dismissed" ? found : null;
      },
      { deadlineMs: 15_000, intervalMs: 250 }
    );
    assert(Boolean(dismissedRow), "NOTIFICATION_DISMISS_NOT_PERSISTED");
    // Dismissed events stay durable but leave the tray list.
    const visibleTexts = await tray.innerText();
    assert(!visibleTexts.includes("Result changed"), "DISMISSED_STILL_IN_TRAY");
    checks.notifications_tray = { read_durable: true, dismissed_hidden_but_durable: true };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- P9: pause → resume -------------------------------------------------- */
    const manage9 = await openManage();
    await manage9.getByRole("button", { name: /^Pause/, exact: false }).click();
    const pausedRecipe = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/briefs/${recipe.id}`, { expectStatus: 200 });
        return res.body?.state === "paused" ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 250 }
    );
    assert(Boolean(pausedRecipe), "PAUSE_NOT_PERSISTED");
    await goHash(session, "/automations");
    await expectText(session, RECIPE_NAME);
    const pausedCard = session.page.locator("div.p-4").filter({ hasText: RECIPE_NAME }).first();
    await expectIn(pausedCard, /paused/);
    const manage9b = await openManage();
    await manage9b.getByRole("button", { name: /^Resume/, exact: false }).click();
    const resumedRecipe = await pollUntil(
      async () => {
        const res = await session.apiFetch(`/api/briefs/${recipe.id}`, { expectStatus: 200 });
        return res.body?.state === "active" ? res.body : null;
      },
      { deadlineMs: 20_000, intervalMs: 250 }
    );
    assert(Boolean(resumedRecipe), "RESUME_NOT_PERSISTED");
    // Close the manage dialog before touching the cards behind the overlay.
    await session.page.keyboard.press("Escape");
    checks.pause_resume = { paused: true, resumed: true };

    /* -- P9b: foreign-account isolation probes (before deletion) ------------ */
    sessionForeign = await browser.newSession({ origin: server.origin });
    await sessionForeign.register({ email: FOREIGN_EMAIL, password: `${PASSWORD}-foreign` });
    sessionForeign.allowStatuses([404]);
    const foreignBriefs = await sessionForeign.apiFetch("/api/briefs", { expectStatus: 200 });
    assert((foreignBriefs.body?.items ?? []).length === 0, "FOREIGN_BRIEFS_VISIBLE");
    const foreignDetail = await sessionForeign.apiFetch(`/api/briefs/${recipe.id}`);
    assert(foreignDetail.status === 404, "FOREIGN_RECIPE_DETAIL", String(foreignDetail.status));
    const foreignReviews = await sessionForeign.apiFetch("/api/brief-reviews", { expectStatus: 200 });
    assert((foreignReviews.body?.items ?? []).length === 0, "FOREIGN_REVIEWS_VISIBLE");
    const foreignExport = await sessionForeign.apiFetchText(
      `/api/documents/${doc1Id}/publications/${publications1[0].id}/export?format=pdf`
    );
    assert(foreignExport.status === 404, "FOREIGN_EXPORT", String(foreignExport.status));
    const foreignNotifications = await sessionForeign.apiFetch("/api/notifications", { expectStatus: 200 });
    assert((foreignNotifications.body?.items ?? []).length === 0, "FOREIGN_NOTIFICATIONS");
    checks.failure_matrix.push("foreign-account-404-across-briefs-reviews-notifications-export");

    /* -- P9c: delete the recipe; history + publications survive ------------- */
    const card9 = session.page.locator("div.p-4").filter({ hasText: RECIPE_NAME }).first();
    await card9.getByRole("button", { name: `Delete ${RECIPE_NAME}`, exact: true }).click();
    const confirm = session.page.getByRole("alertdialog").filter({ hasText: `Delete “${RECIPE_NAME}”` }).first();
    await confirm.waitFor({ timeout: 15_000 });
    await expectIn(confirm, "Saved results and already-published reports survive");
    await expectIn(confirm, "Pending and rejected drafts are preserved (default)");
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await pollUntil(
      async () => {
        const res = await session.apiFetch("/api/briefs", { expectStatus: 200 });
        return (res.body?.items ?? []).length === 0 ? true : null;
      },
      { deadlineMs: 20_000, intervalMs: 250 }
    ).then((gone) => assert(gone === true, "RECIPE_NOT_DELETED"));
    session.allowStatuses([404]);
    const deletedDetail = await session.apiFetch(`/api/briefs/${recipe.id}`);
    assert(deletedDetail.status === 404 && deletedDetail.body?.code === "BRIEF_RECIPE_NOT_FOUND", "DELETED_RECIPE_DETAIL", String(deletedDetail.status));

    // Retained-snapshot rule: run detail, review rows, publications, and the
    // published bytes all stay readable after the live recipe is gone.
    const run1AfterDelete = await session.apiFetch(`/api/briefs/${recipe.id}/runs/${run1.run.id}`, { expectStatus: 200 });
    assert(
      run1AfterDelete.body?.stage === "approved" && run1AfterDelete.body?.occurrence_key === run1Final.occurrence_key,
      "RUN_DETAIL_AFTER_DELETE",
      JSON.stringify({ s: run1AfterDelete.body?.stage, k: run1AfterDelete.body?.occurrence_key })
    );
    const reviewRow1AfterDelete = await findReviewRow(run1.run.id);
    assert(reviewRow1AfterDelete.recipe_state === null && reviewRow1AfterDelete.comparison_summary === null, "REVIEW_ROW_AFTER_DELETE");
    await goHash(session, "/reviews");
    await expectIn(reviewRow().first(), "recipe deleted");
    const html1Final = await session.apiFetchText(
      `/api/documents/${doc1Id}/publications/${publications1[0].id}/export?format=html`,
      { expectStatus: 200 }
    );
    assert(html1Final.text.includes(NARRATIVE_RUN1) && html1Final.text.includes("<html"), "PUBLICATION_LOST_AFTER_RECIPE_DELETE");
    const row3AfterDelete = await findReviewRow(run3.run.id);
    assert(row3AfterDelete.stage === "awaiting_review", "PENDING_REVIEW_DROPPED_AFTER_DELETE");
    checks.deletion = { reports_survive: true, runs_readable: true, pending_review_preserved: true };
    artifacts.push(await session.screenshot(artifactsDir));

    /* -- wrap: egress accounting + cleanliness ------------------------------ */
    const providerFinal = await provider.state();
    // Exactly one bounded narrative call per executed brief run — nothing
    // else left the machine, and the only configured provider is the loopback
    // fixture, so "no external delivery" is structural here.
    assert(providerFinal.chat_calls - providerBefore.chat_calls === 4, "NARRATIVE_CALL_COUNT", String(providerFinal.chat_calls - providerBefore.chat_calls));
    checks.provider_calls = { chat_delta: providerFinal.chat_calls - providerBefore.chat_calls, narrative_per_run: 1 };

    await server.quiesceWorkers({ token: await session.token() });
    session.assertClean();
    sessionForeign.assertClean();

    return { artifacts, checks };
  } catch (error) {
    const { writeText } = await import("../harness/util.mjs");
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
    await sessionForeign?.close().catch(() => undefined);
  }
}
