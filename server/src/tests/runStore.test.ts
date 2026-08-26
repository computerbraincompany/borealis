import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { encodeBoolean } from "../db/codecs.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  ActiveRunArtifactCleanupError,
  ArtifactNotFoundError,
  ArtifactPathsMissingError,
  RunNotActiveError,
  RunNotCompletableError,
  RunNotFoundError,
  RunStore,
  type ChatRunStatus,
} from "../db/stores/runStore.js";
import type { SqliteLedger } from "../db/types.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];
const extraLedgers: SqliteLedger[] = [];

afterEach(async () => {
  await Promise.all(extraLedgers.splice(0).map((ledger) => ledger.close()));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
});

async function setup(): Promise<{ ledger: SqliteLedger; store: RunStore; filename: string }> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  return { ledger: resource.ledger, store: new RunStore(resource.ledger), filename: resource.filename };
}

async function secondStore(filename: string): Promise<{ ledger: SqliteLedger; store: RunStore }> {
  const ledger = await openSqliteLedger({ path: filename });
  extraLedgers.push(ledger);
  return { ledger, store: new RunStore(ledger) };
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

async function insertChat(ledger: SqliteLedger, accountId: string, label: string): Promise<string> {
  const id = randomUUID();
  await ledger.run("INSERT INTO chats (id,account_id,title,model,source_mode) VALUES (?,?,?,?, 'selected')", [
    id,
    accountId,
    label,
    "chat-model",
  ]);
  return id;
}

async function insertRun(
  ledger: SqliteLedger,
  accountId: string,
  chatId: string,
  status: ChatRunStatus = "running",
  cancelRequested = status === "cancelling"
): Promise<string> {
  const id = randomUUID();
  const timestamp = "2026-08-26T10:00:00.000Z";
  await ledger.run(
    `INSERT INTO chat_runs
       (id,account_id,chat_id,status,cancel_requested,created_at,started_at,finished_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      id,
      accountId,
      chatId,
      status,
      encodeBoolean(cancelRequested),
      timestamp,
      timestamp,
      status === "running" || status === "cancelling" ? null : timestamp,
    ]
  );
  return id;
}

async function insertPendingChart(store: RunStore, accountId: string, runId: string, label: string): Promise<string> {
  const id = randomUUID();
  await store.insertPendingChart({
    id,
    accountId,
    runId,
    spec: { type: "bar", title: label },
    echarts: { series: [{ type: "bar", data: [1, 2] }] },
    pngBase64: `png-${label}`,
  });
  return id;
}

async function insertPendingReport(store: RunStore, accountId: string, runId: string, label: string): Promise<string> {
  const id = randomUUID();
  await store.insertPendingReport({
    id,
    accountId,
    runId,
    title: `${label} report`,
    subtitle: `${label} subtitle`,
    htmlPath: `/safe/${accountId}/${id}/report.html`,
    pdfPath: `/safe/${accountId}/${id}/report.pdf`,
  });
  return id;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RunStore", () => {
  it("reads and terminalizes exact tenant runs with cancellation dominance", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const foreign = await insertUser(ledger, "foreign");
    const chat = await insertChat(ledger, account, "Owner chat");
    const run = await insertRun(ledger, account, chat);

    await expect(store.readRun(account.toUpperCase(), chat.toUpperCase(), run.toUpperCase())).resolves.toMatchObject({
      id: run,
      accountId: account,
      chatId: chat,
      status: "running",
      cancelRequested: false,
      finishedAt: null,
    });
    await expect(store.readBeginStatus(account, chat, run)).resolves.toEqual({
      status: "running",
      cancelRequested: false,
      shouldAbort: false,
    });
    await expect(store.readRun(foreign, chat, run)).resolves.toBeUndefined();
    await expect(store.requestCancel(foreign, chat, run)).resolves.toBeNull();
    await expect(store.finishRun(foreign, chat, run, "failed", "AGENT_FAILED")).rejects.toBeInstanceOf(
      RunNotFoundError
    );

    await expect(store.finishRun(account, chat, run, "completed" as never)).rejects.toBeInstanceOf(TypeError);
    await expect(store.requestCancel(account, chat, run)).resolves.toBe("cancelling");
    await expect(store.requestCancel(account, chat, run)).resolves.toBe("cancelling");
    await expect(store.finishRun(account, chat, run, "failed", "AGENT_FAILED")).resolves.toBe("cancelled");
    await expect(store.requestCancel(account, chat, run)).resolves.toBe("cancelled");
    await expect(store.finishRun(account, chat, run, "failed", "LATE_FAILURE")).resolves.toBe("cancelled");
    await expect(store.readRun(account, chat, run)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      errorCode: "CANCELLED",
      finishedAt: expect.stringMatching(/Z$/),
    });
    await expect(store.readBeginStatus(account, chat, run)).resolves.toMatchObject({ shouldAbort: true });

    const failedChat = await insertChat(ledger, account, "Failure wins");
    const failedRun = await insertRun(ledger, account, failedChat);
    await expect(store.finishRun(account, failedChat, failedRun, "failed", "AGENT_FAILED")).resolves.toBe("failed");
    await expect(store.requestCancel(account, failedChat, failedRun)).resolves.toBe("failed");
    await expect(store.finishRun(account, failedChat, failedRun, "cancelled", "CANCELLED")).resolves.toBe("failed");
    await expect(store.readBeginStatus(account, failedChat, failedRun)).resolves.toMatchObject({
      status: "failed",
      shouldAbort: true,
    });
  });

  it("inserts JSON artifacts only while the exact account run is active", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "artifact-owner");
    const foreign = await insertUser(ledger, "artifact-foreign");
    const chat = await insertChat(ledger, account, "Artifact chat");
    const run = await insertRun(ledger, account, chat);
    const chart = randomUUID();
    const report = randomUUID();

    await expect(
      store.insertPendingReport({
        id: randomUUID(),
        accountId: account,
        runId: run,
        title: "Missing paths",
        htmlPath: "",
        pdfPath: "/safe/report.pdf",
      })
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      store.insertPendingChart({
        id: chart.toUpperCase(),
        accountId: account.toUpperCase(),
        runId: run.toUpperCase(),
        spec: { type: "line", values: [1, 2] },
        echarts: { series: [{ data: [1, 2] }] },
        pngBase64: "cG5n",
      })
    ).resolves.toEqual({ id: chart });
    await expect(
      store.insertPendingReport({
        id: report,
        accountId: account,
        runId: run,
        title: "Artifact report",
        htmlPath: "/safe/report.html",
        pdfPath: "/safe/report.pdf",
      })
    ).resolves.toEqual({ id: report });
    await expect(store.getPendingChart(account.toUpperCase(), run.toUpperCase(), chart.toUpperCase())).resolves.toEqual(
      {
        id: chart,
        spec: { type: "line", values: [1, 2] },
      }
    );
    await expect(store.getPendingChart(foreign, run, chart)).resolves.toBeUndefined();
    await expect(store.getPendingChart(account, randomUUID(), chart)).resolves.toBeUndefined();
    await expect(store.getPublishedChart(account, chart)).resolves.toBeUndefined();
    await expect(store.getPublishedReport(account, report)).resolves.toBeUndefined();
    await expect(
      ledger.get<{ spec: string; echarts: string; chat_id: string }>(
        `SELECT c.spec,c.echarts,r.chat_id
         FROM charts c JOIN reports r ON r.run_id=c.run_id
         WHERE c.id=? AND r.id=?`,
        [chart, report]
      )
    ).resolves.toEqual({
      spec: JSON.stringify({ type: "line", values: [1, 2] }),
      echarts: JSON.stringify({ series: [{ data: [1, 2] }] }),
      chat_id: chat,
    });

    await expect(
      store.insertPendingChart({
        id: randomUUID(),
        accountId: foreign,
        runId: run,
        spec: {},
        echarts: {},
      })
    ).rejects.toBeInstanceOf(RunNotActiveError);
    await store.requestCancel(account, chat, run);
    await expect(
      store.insertPendingReport({
        id: randomUUID(),
        accountId: account,
        runId: run,
        title: "Too late",
        htmlPath: "/safe/late.html",
        pdfPath: "/safe/late.pdf",
      })
    ).rejects.toBeInstanceOf(RunNotActiveError);
  });

  it("atomically publishes selected artifacts, deletes unselected rows, and inserts the assistant", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "complete-owner");
    const foreign = await insertUser(ledger, "complete-foreign");
    const chat = await insertChat(ledger, account, "Completed chat");
    const otherChat = await insertChat(ledger, account, "Other chat");
    const foreignChat = await insertChat(ledger, foreign, "Foreign chat");
    const run = await insertRun(ledger, account, chat);
    const otherRun = await insertRun(ledger, account, otherChat);
    const foreignRun = await insertRun(ledger, foreign, foreignChat);
    const selectedChart = await insertPendingChart(store, account, run, "selected");
    const discardedChart = await insertPendingChart(store, account, run, "discarded");
    const selectedReport = await insertPendingReport(store, account, run, "selected");
    const discardedReport = await insertPendingReport(store, account, run, "discarded");
    const otherChart = await insertPendingChart(store, account, otherRun, "other");
    const foreignReport = await insertPendingReport(store, foreign, foreignRun, "foreign");
    const meta = {
      charts: [selectedChart.toUpperCase(), selectedChart],
      report: selectedReport.toUpperCase(),
      model: "chat-model",
      source_mode: "selected",
      source_ids: [],
      evidence: [],
      query_results: [],
    } as const;

    const completed = await store.completeRunWithAssistant(account, chat, run, {
      content: "Completed answer",
      meta,
    });
    expect(completed).toMatchObject({
      status: "completed",
      message: { content: "Completed answer", meta },
      reportCleanupIntents: [
        {
          id: discardedReport,
          accountId: account,
          runId: run,
          htmlPath: `/safe/${account}/${discardedReport}/report.html`,
          pdfPath: `/safe/${account}/${discardedReport}/report.pdf`,
          attempts: 0,
          lastError: null,
        },
      ],
    });
    await expect(store.readRun(account, chat, run)).resolves.toMatchObject({ status: "completed", errorCode: null });
    await expect(store.getPublishedChart(account, selectedChart)).resolves.toEqual({
      id: selectedChart,
      spec: { type: "bar", title: "selected" },
      echarts: { series: [{ type: "bar", data: [1, 2] }] },
      png_base64: "png-selected",
    });
    await expect(store.getPublishedChart(account, discardedChart)).resolves.toBeUndefined();
    await expect(store.getPublishedReport(account, selectedReport)).resolves.toMatchObject({
      id: selectedReport,
      title: "selected report",
      chat_id: chat,
      chat_title: "Completed chat",
    });
    await expect(store.getPublishedReport(foreign, selectedReport)).resolves.toBeUndefined();
    await expect(store.listPublishedReports(account)).resolves.toHaveLength(1);
    await expect(ledger.get("SELECT 1 FROM reports WHERE id=?", [discardedReport])).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM charts WHERE id=?", [discardedChart])).resolves.toBeUndefined();
    await expect(ledger.get("SELECT status FROM charts WHERE id=?", [otherChart])).resolves.toEqual({
      status: "pending",
    });
    await expect(ledger.get("SELECT status FROM reports WHERE id=?", [foreignReport])).resolves.toEqual({
      status: "pending",
    });
    const assistant = await ledger.get<{ content: string; meta: string }>(
      "SELECT content,meta FROM messages WHERE id=?",
      [completed.status === "completed" ? (completed.message?.id ?? -1) : -1]
    );
    expect(assistant).toEqual({ content: "Completed answer", meta: JSON.stringify(meta) });

    await expect(store.completeRunWithAssistant(account, chat, run, { content: "duplicate", meta })).resolves.toEqual({
      status: "completed",
      reportCleanupIntents: completed.status === "completed" ? completed.reportCleanupIntents : [],
    });
    await expect(store.reservePublishedReportDeletion(foreign, selectedReport)).rejects.toBeInstanceOf(
      ArtifactNotFoundError
    );
    await expect(
      store.reservePublishedReportDeletion(account.toUpperCase(), selectedReport.toUpperCase())
    ).resolves.toMatchObject({
      id: selectedReport,
      accountId: account,
      htmlPath: `/safe/${account}/${selectedReport}/report.html`,
    });
    await expect(store.getPublishedReport(account, selectedReport)).resolves.toBeUndefined();
    await expect(store.deletePublishedChartRow(account, selectedChart)).resolves.toBe(true);
  });

  it("persists discarded and published-delete cleanup intents across crashes and retries", async () => {
    const { ledger, store, filename } = await setup();
    const account = await insertUser(ledger, "cleanup-owner");
    const foreign = await insertUser(ledger, "cleanup-foreign");
    const discardedChat = await insertChat(ledger, account, "Discard cleanup");
    const discardedRun = await insertRun(ledger, account, discardedChat);
    const discardedReport = await insertPendingReport(store, account, discardedRun, "discarded-crash");

    await expect(
      store.completeRunWithAssistant(account, discardedChat, discardedRun, {
        content: "No report selected",
        meta: { charts: [], report: null },
      })
    ).resolves.toMatchObject({
      status: "completed",
      reportCleanupIntents: [{ id: discardedReport, accountId: account, runId: discardedRun, attempts: 0 }],
    });
    await ledger.close();

    const afterCompletionCrash = await secondStore(filename);
    await expect(
      afterCompletionCrash.store.listReportArtifactCleanupIntentsForRun(account, discardedRun)
    ).resolves.toMatchObject([
      { id: discardedReport, accountId: account, runId: discardedRun, attempts: 0, lastError: null },
    ]);
    await expect(
      afterCompletionCrash.store.recordReportArtifactCleanupFailure(foreign, discardedReport, "REMOVE_FAILED")
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(
      afterCompletionCrash.store.recordReportArtifactCleanupFailure(account, discardedReport, "REMOVE_FAILED")
    ).resolves.toMatchObject({ attempts: 1, lastError: "REMOVE_FAILED" });
    await afterCompletionCrash.ledger.close();

    const afterRetryCrash = await secondStore(filename);
    await expect(afterRetryCrash.store.listReportArtifactCleanupIntents(1)).resolves.toMatchObject([
      { id: discardedReport, attempts: 1, lastError: "REMOVE_FAILED" },
    ]);
    await expect(afterRetryCrash.store.listReportArtifactCleanupIntents(0)).rejects.toBeInstanceOf(RangeError);
    await expect(afterRetryCrash.store.clearReportArtifactCleanupIntent(foreign, discardedReport)).resolves.toBe(false);
    await expect(afterRetryCrash.store.clearReportArtifactCleanupIntent(account, discardedReport)).resolves.toBe(true);

    const publishedChat = await insertChat(afterRetryCrash.ledger, account, "Published cleanup");
    const publishedRun = await insertRun(afterRetryCrash.ledger, account, publishedChat);
    const publishedReport = await insertPendingReport(afterRetryCrash.store, account, publishedRun, "published-crash");
    await afterRetryCrash.store.completeRunWithAssistant(account, publishedChat, publishedRun, {
      content: "Published report",
      meta: { charts: [], report: publishedReport },
    });
    const reserved = await afterRetryCrash.store.reservePublishedReportDeletion(account, publishedReport);
    expect(reserved).toMatchObject({
      id: publishedReport,
      accountId: account,
      runId: null,
      attempts: 0,
      htmlPath: `/safe/${account}/${publishedReport}/report.html`,
      pdfPath: `/safe/${account}/${publishedReport}/report.pdf`,
    });
    await expect(afterRetryCrash.store.getPublishedReport(account, publishedReport)).resolves.toBeUndefined();
    await expect(afterRetryCrash.store.reservePublishedReportDeletion(account, publishedReport)).resolves.toEqual(
      reserved
    );
    await afterRetryCrash.ledger.close();

    const afterPublishedDeleteCrash = await secondStore(filename);
    await expect(afterPublishedDeleteCrash.store.listReportArtifactCleanupIntents()).resolves.toEqual([reserved]);
    await expect(
      afterPublishedDeleteCrash.store.recordReportArtifactCleanupFailure(account, publishedReport, "FILES_BUSY")
    ).resolves.toMatchObject({ attempts: 1, lastError: "FILES_BUSY" });
    await afterPublishedDeleteCrash.ledger.close();

    const afterFilesRemovedCrash = await secondStore(filename);
    await expect(afterFilesRemovedCrash.store.listReportArtifactCleanupIntents()).resolves.toMatchObject([
      { id: publishedReport, attempts: 1, lastError: "FILES_BUSY" },
    ]);
    await expect(afterFilesRemovedCrash.store.clearReportArtifactCleanupIntent(account, publishedReport)).resolves.toBe(
      true
    );
    await expect(afterFilesRemovedCrash.store.listReportArtifactCleanupIntents()).resolves.toEqual([]);
    await expect(
      afterFilesRemovedCrash.store.reservePublishedReportDeletion(account, publishedReport)
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);

    const legacyPathlessReport = randomUUID();
    await afterFilesRemovedCrash.ledger.run(
      `INSERT INTO reports (id,account_id,chat_id,status,title,html_path,pdf_path)
       VALUES (?,?,?,'published',?,NULL,NULL)`,
      [legacyPathlessReport, account, publishedChat, "Legacy pathless report"]
    );
    await expect(
      afterFilesRemovedCrash.store.reservePublishedReportDeletion(account, legacyPathlessReport)
    ).resolves.toMatchObject({
      id: legacyPathlessReport,
      accountId: account,
      htmlPath: null,
      pdfPath: null,
    });
    await expect(
      afterFilesRemovedCrash.store.getPublishedReport(account, legacyPathlessReport)
    ).resolves.toBeUndefined();
    await expect(
      afterFilesRemovedCrash.store.clearReportArtifactCleanupIntent(account, legacyPathlessReport)
    ).resolves.toBe(true);
  });

  it("rolls back all publication on chart or report ownership mismatch", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "mismatch");
    const firstChat = await insertChat(ledger, account, "First mismatch chat");
    const secondChat = await insertChat(ledger, account, "Second mismatch chat");
    const firstRun = await insertRun(ledger, account, firstChat);
    const secondRun = await insertRun(ledger, account, secondChat);
    const validChart = await insertPendingChart(store, account, firstRun, "valid");
    const validReport = await insertPendingReport(store, account, firstRun, "valid");
    const otherChart = await insertPendingChart(store, account, secondRun, "other");
    const otherReport = await insertPendingReport(store, account, secondRun, "other");
    const pathlessReport = randomUUID();
    await ledger.run(
      `INSERT INTO reports (id,account_id,chat_id,run_id,status,title,html_path,pdf_path)
       VALUES (?,?,?,?,'pending',?,NULL,?)`,
      [pathlessReport, account, firstChat, firstRun, "Pathless", "/safe/pathless.pdf"]
    );

    await expect(
      store.completeRunWithAssistant(account, firstChat, firstRun, {
        content: "must roll back",
        meta: { charts: [validChart, otherChart], report: validReport },
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_OWNERSHIP_MISMATCH", artifact: "chart" });
    await expect(
      store.completeRunWithAssistant(account, firstChat, firstRun, {
        content: "must also roll back",
        meta: { charts: [validChart], report: otherReport },
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_OWNERSHIP_MISMATCH", artifact: "report" });
    await expect(
      store.completeRunWithAssistant(account, firstChat, firstRun, {
        content: "must require complete paths",
        meta: { charts: [validChart], report: pathlessReport },
      })
    ).rejects.toBeInstanceOf(ArtifactPathsMissingError);
    await expect(store.readRun(account, firstChat, firstRun)).resolves.toMatchObject({ status: "running" });
    await expect(
      ledger.all<{ id: string; status: string }>(
        `SELECT id,status FROM charts WHERE run_id=?
         UNION ALL SELECT id,status FROM reports WHERE run_id=? ORDER BY id`,
        [firstRun, firstRun]
      )
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: validChart, status: "pending" },
        { id: validReport, status: "pending" },
      ])
    );
    await expect(
      ledger.get("SELECT 1 FROM messages WHERE chat_id=? AND role='assistant'", [firstChat])
    ).resolves.toBeUndefined();
  });

  it("lets cancellation linearize before completion with no assistant or publication", async () => {
    const { ledger, store, filename } = await setup();
    const other = await secondStore(filename);
    const account = await insertUser(ledger, "cancel-first");
    const chat = await insertChat(ledger, account, "Cancel first");
    const run = await insertRun(ledger, account, chat);
    const chart = await insertPendingChart(store, account, run, "cancelled");
    const report = await insertPendingReport(store, account, run, "cancelled");
    const cancelEntered = deferred();
    const releaseCancel = deferred();
    const cancelling = store.requestCancel(account, chat, run, {
      afterTransition: async () => {
        cancelEntered.resolve();
        await releaseCancel.promise;
      },
    });
    await cancelEntered.promise;
    let completionSettled = false;
    const completion = other.store
      .completeRunWithAssistant(account, chat, run, {
        content: "must not publish",
        meta: { charts: [chart], report },
      })
      .finally(() => {
        completionSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completionSettled).toBe(false);
    releaseCancel.resolve();
    await expect(cancelling).resolves.toBe("cancelling");
    await expect(completion).resolves.toMatchObject({
      status: "cancelled",
      pendingReportCleanup: [{ id: report, accountId: account, runId: run }],
    });
    await expect(store.readRun(account, chat, run)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      errorCode: "CANCELLED",
    });
    await expect(ledger.get("SELECT status FROM charts WHERE id=?", [chart])).resolves.toEqual({ status: "pending" });
    await expect(ledger.get("SELECT status FROM reports WHERE id=?", [report])).resolves.toEqual({ status: "pending" });
    await expect(
      ledger.get("SELECT 1 FROM messages WHERE chat_id=? AND role='assistant'", [chat])
    ).resolves.toBeUndefined();
  });

  it("lets completion linearize before a late cancellation", async () => {
    const { ledger, store, filename } = await setup();
    const other = await secondStore(filename);
    const account = await insertUser(ledger, "complete-first");
    const chat = await insertChat(ledger, account, "Complete first");
    const run = await insertRun(ledger, account, chat);
    const chart = await insertPendingChart(store, account, run, "completed");
    const completionEntered = deferred();
    const releaseCompletion = deferred();
    const completing = store.completeRunWithAssistant(
      account,
      chat,
      run,
      { content: "completion wins", meta: { charts: [chart], report: null } },
      {
        afterOwnershipValidated: async () => {
          completionEntered.resolve();
          await releaseCompletion.promise;
        },
      }
    );
    await completionEntered.promise;
    let cancellationSettled = false;
    const cancellation = other.store.requestCancel(account, chat, run).finally(() => {
      cancellationSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancellationSettled).toBe(false);
    releaseCompletion.resolve();
    await expect(completing).resolves.toMatchObject({ status: "completed", message: { content: "completion wins" } });
    await expect(cancellation).resolves.toBe("completed");
    await expect(store.getPublishedChart(account, chart)).resolves.toMatchObject({ id: chart });
    await expect(
      ledger.get("SELECT content FROM messages WHERE chat_id=? AND role='assistant'", [chat])
    ).resolves.toEqual({
      content: "completion wins",
    });
  });

  it("linearizes pending artifact reservation against cancellation in both commit orders", async () => {
    const { ledger, store, filename } = await setup();
    const other = await secondStore(filename);
    const account = await insertUser(ledger, "artifact-race");

    const insertFirstChat = await insertChat(ledger, account, "Insert first");
    const insertFirstRun = await insertRun(ledger, account, insertFirstChat);
    const insertedChart = randomUUID();
    const insertionEntered = deferred();
    const releaseInsertion = deferred();
    const inserting = store.insertPendingChart(
      {
        id: insertedChart,
        accountId: account,
        runId: insertFirstRun,
        spec: {},
        echarts: {},
      },
      {
        afterActiveCheck: async () => {
          insertionEntered.resolve();
          await releaseInsertion.promise;
        },
      }
    );
    await insertionEntered.promise;
    const lateCancellation = other.store.requestCancel(account, insertFirstChat, insertFirstRun);
    releaseInsertion.resolve();
    await expect(inserting).resolves.toEqual({ id: insertedChart });
    await expect(lateCancellation).resolves.toBe("cancelling");
    await expect(ledger.get("SELECT status FROM charts WHERE id=?", [insertedChart])).resolves.toEqual({
      status: "pending",
    });

    const cancelFirstChat = await insertChat(ledger, account, "Cancel first insertion");
    const cancelFirstRun = await insertRun(ledger, account, cancelFirstChat);
    const rejectedReport = randomUUID();
    const cancellationEntered = deferred();
    const releaseCancellation = deferred();
    const cancelling = store.requestCancel(account, cancelFirstChat, cancelFirstRun, {
      afterTransition: async () => {
        cancellationEntered.resolve();
        await releaseCancellation.promise;
      },
    });
    await cancellationEntered.promise;
    const rejectedInsertion = other.store.insertPendingReport({
      id: rejectedReport,
      accountId: account,
      runId: cancelFirstRun,
      title: "Must not reserve",
      htmlPath: "/safe/rejected.html",
      pdfPath: "/safe/rejected.pdf",
    });
    releaseCancellation.resolve();
    await expect(cancelling).resolves.toBe("cancelling");
    await expect(rejectedInsertion).rejects.toBeInstanceOf(RunNotActiveError);
    await expect(ledger.get("SELECT 1 FROM reports WHERE id=?", [rejectedReport])).resolves.toBeUndefined();
  });

  it("retains pending report cleanup provenance and only acknowledges the exact observed null-run rows", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "chat-delete");
    const chat = await insertChat(ledger, account, "Deleted chat");
    const run = await insertRun(ledger, account, chat);
    const report = await insertPendingReport(store, account, run, "chat-delete");

    await ledger.run("DELETE FROM chats WHERE id=? AND account_id=?", [chat, account]);
    await expect(
      ledger.get<{ account_id: string; chat_id: null; run_id: null; html_path: string }>(
        "SELECT account_id,chat_id,run_id,html_path FROM reports WHERE id=?",
        [report]
      )
    ).resolves.toEqual({
      account_id: account,
      chat_id: null,
      run_id: null,
      html_path: `/safe/${account}/${report}/report.html`,
    });
    await expect(store.listOrphanedPendingRunGroups()).resolves.toContainEqual({
      accountId: account,
      runId: null,
      reportCount: 1,
      chartCount: 0,
    });
    const observed = await store.listPendingReportCleanupPaths(account, null);
    expect(observed).toMatchObject([{ id: report, accountId: account, runId: null }]);

    const laterChat = await insertChat(ledger, account, "Later deleted chat");
    const laterRun = await insertRun(ledger, account, laterChat);
    const laterReport = await insertPendingReport(store, account, laterRun, "later-chat-delete");
    await ledger.run("DELETE FROM chats WHERE id=? AND account_id=?", [laterChat, account]);

    await expect(store.deletePendingArtifactRows(account, null, observed)).resolves.toEqual({ reports: 1, charts: 0 });
    await expect(ledger.get("SELECT 1 FROM reports WHERE id=?", [report])).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 AS exists_marker FROM reports WHERE id=?", [laterReport])).resolves.toEqual({
      exists_marker: 1n,
    });
    await expect(store.listPendingReportCleanupPaths(account, null)).resolves.toMatchObject([
      { id: laterReport, accountId: account, runId: null },
    ]);
    await expect(store.listReportArtifactCleanupIntents()).resolves.toEqual([]);
  });

  it("queues pending report paths durably when account deletion cascades every owning row", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "account-cascade");
    const chat = await insertChat(ledger, account, "Account cascade");
    const run = await insertRun(ledger, account, chat);
    const report = await insertPendingReport(store, account, run, "account-cascade");

    await ledger.run("DELETE FROM users WHERE id=?", [account]);
    await expect(ledger.get("SELECT 1 FROM reports WHERE id=?", [report])).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM chat_runs WHERE id=?", [run])).resolves.toBeUndefined();
    await expect(store.listReportArtifactCleanupIntents()).resolves.toMatchObject([
      {
        id: report,
        accountId: account,
        htmlPath: `/safe/${account}/${report}/report.html`,
        pdfPath: `/safe/${account}/${report}/report.pdf`,
        attempts: 0,
      },
    ]);
  });

  it("recovers interrupted runs and exposes durable orphan cleanup groups and paths", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "recovery");
    const runningChat = await insertChat(ledger, account, "Running");
    const cancellingChat = await insertChat(ledger, account, "Cancelling");
    const terminalChat = await insertChat(ledger, account, "Terminal");
    const runningRun = await insertRun(ledger, account, runningChat);
    const cancellingRun = await insertRun(ledger, account, cancellingChat, "cancelling", true);
    const terminalRun = await insertRun(ledger, account, terminalChat, "completed");
    const runningReport = await insertPendingReport(store, account, runningRun, "running");
    const runningChart = await insertPendingChart(store, account, runningRun, "running");
    const timestamp = "2026-08-26T10:00:00.000Z";
    const terminalReport = randomUUID();
    const nullRunReport = randomUUID();
    const nullRunChart = randomUUID();
    await ledger.run(
      `INSERT INTO reports
         (id,account_id,chat_id,run_id,status,title,html_path,pdf_path,created_at,updated_at)
       VALUES (?,?,?,?,'pending',?,?,?,?,?)`,
      [
        terminalReport,
        account,
        terminalChat,
        terminalRun,
        "Terminal pending",
        "/safe/terminal.html",
        "/safe/terminal.pdf",
        timestamp,
        timestamp,
      ]
    );
    await ledger.run(
      `INSERT INTO reports
         (id,account_id,run_id,status,title,html_path,pdf_path,created_at,updated_at)
       VALUES (?,?,NULL,'pending',?,?,?,?,?)`,
      [nullRunReport, account, "Null run", "/safe/null.html", "/safe/null.pdf", timestamp, timestamp]
    );
    await ledger.run(
      `INSERT INTO charts (id,account_id,run_id,status,spec,echarts,created_at)
       VALUES (?,?,NULL,'pending','{}','{}',?)`,
      [nullRunChart, account, timestamp]
    );
    await ledger.run(
      `INSERT INTO charts (id,account_id,run_id,status,spec,echarts,created_at)
       VALUES (?,?,?,'pending','{}','{}',?)`,
      [randomUUID(), account, cancellingRun, timestamp]
    );

    await expect(store.deletePendingArtifactRows(account, runningRun, [])).rejects.toBeInstanceOf(
      ActiveRunArtifactCleanupError
    );
    const before = await store.listOrphanedPendingRunGroups();
    expect(before).toEqual(
      expect.arrayContaining([
        { accountId: account, runId: terminalRun, reportCount: 1, chartCount: 0 },
        { accountId: account, runId: null, reportCount: 1, chartCount: 1 },
      ])
    );
    expect(before.some((group) => group.runId === runningRun || group.runId === cancellingRun)).toBe(false);

    await expect(store.recoverInterruptedRuns()).resolves.toBe(2);
    await expect(store.readRun(account, runningChat, runningRun)).resolves.toMatchObject({
      status: "failed",
      errorCode: "SERVER_RESTARTED",
    });
    await expect(store.readRun(account, cancellingChat, cancellingRun)).resolves.toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      errorCode: "CANCELLED",
    });
    await expect(
      store.completeRunWithAssistant(account, runningChat, runningRun, {
        content: "must stay failed",
        meta: { charts: [], report: null },
      })
    ).rejects.toBeInstanceOf(RunNotCompletableError);
    await expect(
      store.completeRunWithAssistant(account, cancellingChat, cancellingRun, {
        content: "must stay cancelled",
        meta: { charts: [], report: null },
      })
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      ledger.get(
        `SELECT 1 FROM messages
         WHERE chat_id IN (?,?) AND role='assistant'`,
        [runningChat, cancellingChat]
      )
    ).resolves.toBeUndefined();
    const groups = await store.listOrphanedPendingRunGroups();
    expect(groups.map((group) => group.runId)).toEqual(
      expect.arrayContaining([null, runningRun, cancellingRun, terminalRun])
    );
    const runningCleanup = await store.listPendingReportCleanupPaths(account, runningRun);
    expect(runningCleanup).toEqual([
      {
        id: runningReport,
        accountId: account,
        runId: runningRun,
        htmlPath: `/safe/${account}/${runningReport}/report.html`,
        pdfPath: `/safe/${account}/${runningReport}/report.pdf`,
      },
    ]);
    const nullRunCleanup = await store.listPendingReportCleanupPaths(account, null);
    expect(nullRunCleanup).toEqual([
      {
        id: nullRunReport,
        accountId: account,
        runId: null,
        htmlPath: "/safe/null.html",
        pdfPath: "/safe/null.pdf",
      },
    ]);
    await expect(store.deletePendingArtifactRows(account, runningRun, runningCleanup)).resolves.toEqual({
      reports: 1,
      charts: 1,
    });
    await expect(store.deletePendingArtifactRows(account, null, nullRunCleanup)).resolves.toEqual({
      reports: 1,
      charts: 1,
    });
    await expect(ledger.get("SELECT 1 FROM reports WHERE id=?", [runningReport])).resolves.toBeUndefined();
    await expect(ledger.get("SELECT 1 FROM charts WHERE id=?", [runningChart])).resolves.toBeUndefined();
  });
});
