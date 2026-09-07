import { randomUUID } from "node:crypto";

function check(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
}

/** Real HTTP setup only; the caller owns SIGTERM, process exit and fresh boot. */
export async function prepareBriefLifecycle({
  api,
  provider,
  upload,
  rows,
  wait,
}) {
  const checks = {};
  const sourceId = await upload(
    "lifecycle-brief.csv",
    "metric,amount\noffice,40\noffice,60\n",
  );
  const source = await wait(async () => {
    const catalog = await api("/api/sources");
    return catalog.items.find(
      (item) => item.id === sourceId && item.tabular?.table,
    );
  }, "BRIEF_LIFECYCLE_TABULAR_READY");
  check(
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.tabular.table),
    "BRIEF_LIFECYCLE_TABLE_IDENTIFIER",
  );
  const title = `Lifecycle brief ${randomUUID()}`;
  const analysis = await api("/api/analyses", {
    method: "POST",
    status: 201,
    body: {
      title,
      sql: `SELECT 'total' AS metric_label, SUM(amount) AS value FROM "${source.tabular.table}"`,
      source_ids: [sourceId],
      comparison_key: ["metric_label"],
    },
  });
  const recipe = await api("/api/briefs", {
    method: "POST",
    status: 201,
    body: {
      name: title,
      analysis_id: analysis.id,
      report_title: title,
      report_instruction: "Summarize the verified total for review.",
      source_ids: [sourceId],
      schedule: {
        kind: "weekly",
        weekday: (new Date().getUTCDay() + 1) % 7,
        hour: 9,
        minute: 0,
        time_zone: "UTC",
      },
    },
  });
  await provider.setScript({
    steps: [
      {
        type: "slow",
        delay_ms: 120000,
        pieces: ["This held narrative must never commit before shutdown."],
      },
    ],
    onExhausted: "fail",
  });
  const beforeCalls = (await provider.state()).chat_calls;
  const operationId = randomUUID();
  const accepted = await api(`/api/briefs/${recipe.id}/runs`, {
    method: "POST",
    status: 202,
    body: { operation_id: operationId },
  });
  const runId = accepted.run.id;
  const route = `/api/briefs/${recipe.id}/runs/${runId}`;
  const active = await wait(async () => {
    const run = await api(route);
    check(
      !["failed", "cancelled", "skipped"].includes(run.stage),
      "BRIEF_LIFECYCLE_PRE_SHUTDOWN_TERMINAL",
    );
    return run.stage === "drafting" &&
      (await provider.state()).chat_calls === beforeCalls + 1
      ? run
      : null;
  }, "BRIEF_LIFECYCLE_ACTIVE_NARRATIVE");
  check(
    active.analysis_run_id && !active.document_id,
    "BRIEF_LIFECYCLE_COMMITTED_ANALYSIS_ONLY",
  );
  const initialResults = await rows(
    "SELECT * FROM analysis_results WHERE run_id=?",
    active.analysis_run_id,
  );
  check(initialResults.length === 1, "BRIEF_LIFECYCLE_INITIAL_RESULT");
  check(
    JSON.stringify(JSON.parse(initialResults[0].rows)) ===
      JSON.stringify([["total", 100]]),
    "BRIEF_LIFECYCLE_EXACT_TOTAL",
  );
  const resultSnapshot = JSON.stringify(initialResults);
  check(
    (
      await rows(
        "SELECT id FROM documents WHERE origin_analysis_result_id=?",
        initialResults[0].id,
      )
    ).length === 0,
    "BRIEF_LIFECYCLE_NO_EARLY_DRAFT",
  );
  checks.actual_narrative_active_before_sigterm = true;
  let restartPrepared = false;

  return {
    analysisId: analysis.id,
    sourceId,
    checks,
    // Call after SIGTERM has exited and before starting the new server.
    async prepareRestart() {
      const stopped = await rows(
        "SELECT stage,document_id,analysis_run_id,cancel_requested FROM brief_runs WHERE id=?",
        runId,
      );
      check(
        stopped.length === 1 &&
          stopped[0].stage === "drafting" &&
          stopped[0].document_id === null &&
          stopped[0].analysis_run_id === active.analysis_run_id &&
          stopped[0].cancel_requested === 0,
        "BRIEF_LIFECYCLE_SHUTDOWN_PRESERVED_STAGE",
      );
      await provider.setScript({
        steps: [
          {
            type: "text",
            pieces: [
              "The verified total is 100. This draft resumed after process restart and awaits human review.",
            ],
          },
        ],
        onExhausted: "fail",
      });
      restartPrepared = true;
      checks.shutdown_preserved_drafting_and_analysis = true;
    },
    async verifyAfterRestart({
      api: resumedApi,
      rows: resumedRows,
      wait: resumedWait,
      provider: resumedProvider,
    }) {
      check(restartPrepared, "BRIEF_LIFECYCLE_RESTART_NOT_PREPARED");
      const resumed = await resumedWait(async () => {
        const run = await resumedApi(route);
        check(
          !["failed", "cancelled", "skipped"].includes(run.stage),
          "BRIEF_LIFECYCLE_RESUME_TERMINAL",
        );
        return run.stage === "awaiting_review" ? run : null;
      }, "BRIEF_LIFECYCLE_RESUMED_REVIEW");
      check(
        resumed.id === runId &&
          resumed.analysis_run_id === active.analysis_run_id &&
          resumed.document_id &&
          resumed.document_revision_id &&
          resumed.publication_operation_id === null,
        "BRIEF_LIFECYCLE_SAME_RUN_REVIEW_ONLY",
      );
      const replays = await resumedApi(`/api/briefs/${recipe.id}/runs`, {
        method: "POST",
        status: 202,
        body: { operation_id: operationId },
      });
      check(
        replays.replayed && replays.run.id === runId,
        "BRIEF_LIFECYCLE_ACCEPTANCE_REPLAY",
      );
      check(
        (
          await resumedRows(
            "SELECT id FROM brief_runs WHERE recipe_id=?",
            recipe.id,
          )
        ).length === 1,
        "BRIEF_LIFECYCLE_SINGLE_RUN",
      );
      check(
        (
          await resumedRows(
            "SELECT id FROM analysis_runs WHERE analysis_id=?",
            analysis.id,
          )
        ).length === 1,
        "BRIEF_LIFECYCLE_NO_DUPLICATE_ANALYSIS",
      );
      check(
        JSON.stringify(
          await resumedRows(
            "SELECT * FROM analysis_results WHERE run_id=?",
            active.analysis_run_id,
          ),
        ) === resultSnapshot,
        "BRIEF_LIFECYCLE_RESULT_UNCHANGED",
      );
      const documents = await resumedRows(
        "SELECT id FROM documents WHERE origin_analysis_result_id=?",
        initialResults[0].id,
      );
      check(
        documents.length === 1 && documents[0].id === resumed.document_id,
        "BRIEF_LIFECYCLE_SINGLE_DRAFT",
      );
      const revisions = await resumedRows(
        "SELECT id,payload FROM document_revisions WHERE document_id=?",
        resumed.document_id,
      );
      check(
        revisions.length === 1 &&
          revisions[0].id === resumed.document_revision_id &&
          JSON.stringify(JSON.parse(revisions[0].payload)).includes(
            "resumed after process restart",
          ),
        "BRIEF_LIFECYCLE_RESUMED_NARRATIVE",
      );
      const notifications = await resumedRows(
        "SELECT id,kind FROM brief_notifications WHERE run_id=?",
        runId,
      );
      check(
        notifications.length === 1 && notifications[0].kind === "first_draft",
        "BRIEF_LIFECYCLE_SINGLE_NOTIFICATION",
      );
      check(
        (
          await resumedRows(
            "SELECT id FROM document_publications WHERE document_id=?",
            resumed.document_id,
          )
        ).length === 0,
        "BRIEF_LIFECYCLE_NO_AUTOMATIC_PUBLICATION",
      );
      check(
        (await resumedProvider.state()).chat_calls === beforeCalls + 2,
        "BRIEF_LIFECYCLE_ONE_RESUMED_NARRATIVE",
      );
      Object.assign(checks, {
        same_run_resumed_to_review: true,
        analysis_and_result_reused: true,
        exactly_one_draft_revision: true,
        exactly_one_notification: true,
        no_automatic_publication: true,
        operation_replay_deduplicated: true,
      });
      return checks;
    },
  };
}
