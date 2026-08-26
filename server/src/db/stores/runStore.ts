import {
  decodeBoolean,
  decodeIsoTimestamp,
  decodeJson,
  decodeSafeInteger,
  encodeBoolean,
  encodeIsoTimestamp,
  encodeJson,
} from "../codecs.js";
import type { SqliteLedger, SqliteTransaction } from "../types.js";

export type ChatRunStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type TerminalChatRunStatus = "completed" | "failed" | "cancelled";

export type RunStoreErrorCode =
  | "RUN_NOT_FOUND"
  | "RUN_NOT_ACTIVE"
  | "RUN_NOT_COMPLETABLE"
  | "ARTIFACT_OWNERSHIP_MISMATCH"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_PATHS_MISSING"
  | "ARTIFACT_CLEANUP_ACTIVE_RUN";

export class RunStoreError extends Error {
  constructor(
    readonly code: RunStoreErrorCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "RunStoreError";
  }
}

export class RunNotFoundError extends RunStoreError {
  constructor(options: ErrorOptions = {}) {
    super("RUN_NOT_FOUND", "run not found", options);
    this.name = "RunNotFoundError";
  }
}

export class RunNotActiveError extends RunStoreError {
  constructor(options: ErrorOptions = {}) {
    super("RUN_NOT_ACTIVE", "run is no longer active", options);
    this.name = "RunNotActiveError";
  }
}

export class RunNotCompletableError extends RunStoreError {
  constructor(options: ErrorOptions = {}) {
    super("RUN_NOT_COMPLETABLE", "run is not completable", options);
    this.name = "RunNotCompletableError";
  }
}

export class ArtifactOwnershipError extends RunStoreError {
  constructor(
    readonly artifact: "chart" | "report",
    options: ErrorOptions = {}
  ) {
    super("ARTIFACT_OWNERSHIP_MISMATCH", `pending ${artifact} ownership mismatch`, options);
    this.name = "ArtifactOwnershipError";
  }
}

export class ArtifactNotFoundError extends RunStoreError {
  constructor(
    readonly artifact: "chart" | "report",
    options: ErrorOptions = {}
  ) {
    super("ARTIFACT_NOT_FOUND", `${artifact} not found`, options);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactPathsMissingError extends RunStoreError {
  constructor(options: ErrorOptions = {}) {
    super("ARTIFACT_PATHS_MISSING", "report artifact paths are unavailable", options);
    this.name = "ArtifactPathsMissingError";
  }
}

export class ActiveRunArtifactCleanupError extends RunStoreError {
  constructor(options: ErrorOptions = {}) {
    super("ARTIFACT_CLEANUP_ACTIVE_RUN", "pending artifacts still belong to an active run", options);
    this.name = "ActiveRunArtifactCleanupError";
  }
}

export interface RunStoreOptions {
  readonly now?: () => Date;
}

export interface StoredChatRun {
  readonly id: string;
  readonly accountId: string;
  readonly chatId: string;
  readonly userMessageId: number | null;
  readonly status: ChatRunStatus;
  readonly cancelRequested: boolean;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface RunBeginStatus {
  readonly status: ChatRunStatus;
  readonly cancelRequested: boolean;
  /** Only `running` without a durable cancellation request may execute. */
  readonly shouldAbort: boolean;
}

export interface RequestCancelTestHooks {
  /** Transaction barrier for behavior tests. Production callers must omit it. */
  readonly afterTransition?: () => Promise<void>;
}

export interface CompleteRunTestHooks {
  /** Transaction barrier for behavior tests. Production callers must omit it. */
  readonly afterOwnershipValidated?: () => Promise<void>;
}

export interface PendingChartInput {
  readonly id: string;
  readonly accountId: string;
  readonly runId: string;
  readonly spec: unknown;
  readonly echarts: unknown;
  readonly pngBase64?: string | null;
}

export interface PendingReportInput {
  readonly id: string;
  readonly accountId: string;
  readonly runId: string;
  readonly title: string;
  readonly subtitle?: string | null;
  /** Deterministic paths are reserved before either artifact is written. */
  readonly htmlPath: string;
  readonly pdfPath: string;
}

export interface InsertPendingArtifactTestHooks {
  /** Transaction barrier for behavior tests. Production callers must omit it. */
  readonly afterActiveCheck?: () => Promise<void>;
}

export interface PublishedChart {
  readonly id: string;
  readonly spec: unknown;
  readonly echarts: unknown;
  readonly png_base64: string | null;
}

export interface PendingChart {
  readonly id: string;
  readonly spec: unknown;
}

export interface PublishedReport {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly chat_id: string | null;
  readonly chat_title: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_path: string | null;
  readonly pdf_path: string | null;
}

export interface PendingReportCleanupPath {
  readonly id: string;
  readonly accountId: string;
  readonly runId: string | null;
  readonly htmlPath: string | null;
  readonly pdfPath: string | null;
}

export interface ReportArtifactCleanupIntent extends PendingReportCleanupPath {
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrphanedPendingRunGroup {
  readonly accountId: string;
  readonly runId: string | null;
  readonly reportCount: number;
  readonly chartCount: number;
}

export interface PendingArtifactDeleteResult {
  readonly reports: number;
  readonly charts: number;
}

export type RunCompletionMeta = Readonly<{
  charts: readonly string[];
  report: string | null;
}>;

export interface RunCompletion<Meta extends RunCompletionMeta = RunCompletionMeta> {
  readonly content: string;
  readonly meta: Meta;
}

export type CompleteRunResult<Meta extends RunCompletionMeta = RunCompletionMeta> =
  | Readonly<{
      status: "completed";
      message?: Readonly<{ id: number; content: string; meta: Meta }>;
      reportCleanupIntents: readonly Readonly<ReportArtifactCleanupIntent>[];
    }>
  | Readonly<{
      status: "cancelled";
      pendingReportCleanup: readonly Readonly<PendingReportCleanupPath>[];
    }>;

interface RunRow {
  id?: unknown;
  account_id?: unknown;
  chat_id?: unknown;
  user_message_id?: unknown;
  status?: unknown;
  cancel_requested?: unknown;
  error_code?: unknown;
  created_at?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
}

interface ActiveRunRow extends RunRow {
  chat_id?: unknown;
}

interface IdRow {
  id?: unknown;
}

interface ChartRow {
  id?: unknown;
  spec?: unknown;
  echarts?: unknown;
  png_base64?: unknown;
}

interface ReportRow {
  id?: unknown;
  account_id?: unknown;
  run_id?: unknown;
  title?: unknown;
  subtitle?: unknown;
  chat_id?: unknown;
  chat_title?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  html_path?: unknown;
  pdf_path?: unknown;
}

interface OrphanRow {
  account_id?: unknown;
  run_id?: unknown;
  report_count?: unknown;
  chart_count?: unknown;
}

interface CleanupIntentRow {
  report_id?: unknown;
  account_id?: unknown;
  run_id?: unknown;
  html_path?: unknown;
  pdf_path?: unknown;
  attempts?: unknown;
  last_error?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_CHARS = 1_024;
const MAX_COMPLETION_CHARTS = 20;
const MAX_REPORT_CLEANUP_INTENTS = 500;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is not stored as text`);
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function inputString(value: string, field: string, maximum = MAX_ID_CHARS, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length < 1) ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new TypeError(`${field} violates the run store input contract`);
  }
  return value;
}

function identity(value: string, field: string): string {
  const normalized = inputString(value, field);
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
}

function runStatus(value: unknown): ChatRunStatus {
  if (
    value === "running" ||
    value === "cancelling" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new TypeError("run status violates the run store contract");
}

function terminalStatus(value: ChatRunStatus): TerminalChatRunStatus | undefined {
  return value === "completed" || value === "failed" || value === "cancelled" ? value : undefined;
}

function decodeRun(row: RunRow): StoredChatRun {
  return Object.freeze({
    id: requiredString(row.id, "run id"),
    accountId: requiredString(row.account_id, "run account id"),
    chatId: requiredString(row.chat_id, "run chat id"),
    userMessageId: row.user_message_id === null ? null : decodeSafeInteger(row.user_message_id, "run user message id"),
    status: runStatus(row.status),
    cancelRequested: decodeBoolean(row.cancel_requested, "run cancel_requested"),
    errorCode: optionalString(row.error_code, "run error_code"),
    createdAt: decodeIsoTimestamp(row.created_at, "run created_at"),
    startedAt: decodeIsoTimestamp(row.started_at, "run started_at"),
    finishedAt: row.finished_at === null ? null : decodeIsoTimestamp(row.finished_at, "run finished_at"),
  });
}

function decodePublishedChart(row: ChartRow): PublishedChart {
  return Object.freeze({
    id: requiredString(row.id, "chart id"),
    spec: decodeJson(row.spec, "chart spec"),
    echarts: decodeJson(row.echarts, "chart echarts"),
    png_base64: optionalString(row.png_base64, "chart png_base64"),
  });
}

function decodePublishedReport(row: ReportRow): PublishedReport {
  return Object.freeze({
    id: requiredString(row.id, "report id"),
    title: requiredString(row.title, "report title"),
    subtitle: optionalString(row.subtitle, "report subtitle"),
    chat_id: optionalString(row.chat_id, "report chat id"),
    chat_title: optionalString(row.chat_title, "report chat title"),
    created_at: decodeIsoTimestamp(row.created_at, "report created_at"),
    updated_at: decodeIsoTimestamp(row.updated_at, "report updated_at"),
    html_path: optionalString(row.html_path, "report html_path"),
    pdf_path: optionalString(row.pdf_path, "report pdf_path"),
  });
}

function decodeCleanupPath(row: ReportRow): PendingReportCleanupPath {
  return Object.freeze({
    id: requiredString(row.id, "report id"),
    accountId: requiredString(row.account_id, "report account id"),
    runId: optionalString(row.run_id, "report run id"),
    htmlPath: optionalString(row.html_path, "report html_path"),
    pdfPath: optionalString(row.pdf_path, "report pdf_path"),
  });
}

function decodeCleanupIntent(row: CleanupIntentRow): ReportArtifactCleanupIntent {
  return Object.freeze({
    id: requiredString(row.report_id, "cleanup report id"),
    accountId: requiredString(row.account_id, "cleanup account id"),
    runId: optionalString(row.run_id, "cleanup run id"),
    htmlPath: optionalString(row.html_path, "cleanup html_path"),
    pdfPath: optionalString(row.pdf_path, "cleanup pdf_path"),
    attempts: decodeSafeInteger(row.attempts, "cleanup attempts"),
    lastError: optionalString(row.last_error, "cleanup last_error"),
    createdAt: decodeIsoTimestamp(row.created_at, "cleanup created_at"),
    updatedAt: decodeIsoTimestamp(row.updated_at, "cleanup updated_at"),
  });
}

function uniqueCompletionChartIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_COMPLETION_CHARTS) {
    throw new TypeError(`completion charts must contain at most ${MAX_COMPLETION_CHARTS} ids`);
  }
  return [...new Set(values.map((value) => identity(value, "completion chart id")))];
}

function placeholders(length: number): string {
  return new Array<string>(length).fill("?").join(",");
}

function boundedPositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function runGroupPredicate(runId: string | null): { sql: string; values: readonly string[] } {
  return runId === null ? { sql: "run_id IS NULL", values: [] } : { sql: "run_id=?", values: [runId] };
}

function observedCleanupReports(
  values: readonly PendingReportCleanupPath[],
  accountId: string,
  runId: string | null
): PendingReportCleanupPath[] {
  if (!Array.isArray(values) || values.length > MAX_REPORT_CLEANUP_INTENTS) {
    throw new TypeError(`cleanup acknowledgement must contain at most ${MAX_REPORT_CLEANUP_INTENTS} reports`);
  }
  const unique = new Map<string, PendingReportCleanupPath>();
  for (const value of values) {
    if (!value || typeof value !== "object") throw new TypeError("cleanup acknowledgement is malformed");
    const report = Object.freeze({
      id: identity(value.id, "cleanup report id"),
      accountId: identity(value.accountId, "cleanup account id"),
      runId: value.runId === null ? null : identity(value.runId, "cleanup run id"),
      htmlPath: value.htmlPath === null ? null : inputString(value.htmlPath, "cleanup report html path", 32_000, true),
      pdfPath: value.pdfPath === null ? null : inputString(value.pdfPath, "cleanup report pdf path", 32_000, true),
    });
    if (report.accountId !== accountId || report.runId !== runId) {
      throw new ArtifactOwnershipError("report");
    }
    const previous = unique.get(report.id);
    if (
      previous &&
      (previous.accountId !== report.accountId ||
        previous.runId !== report.runId ||
        previous.htmlPath !== report.htmlPath ||
        previous.pdfPath !== report.pdfPath)
    ) {
      throw new ArtifactOwnershipError("report");
    }
    unique.set(report.id, report);
  }
  return [...unique.values()];
}

export class RunStore {
  private readonly now: () => Date;

  constructor(
    private readonly ledger: SqliteLedger,
    options: RunStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async readRun(accountIdValue: string, chatIdValue: string, runIdValue: string): Promise<StoredChatRun | undefined> {
    const row = await this.ledger.get<RunRow>(
      `SELECT id,account_id,chat_id,user_message_id,status,cancel_requested,error_code,
              created_at,started_at,finished_at
       FROM chat_runs WHERE id=? AND chat_id=? AND account_id=?`,
      [identity(runIdValue, "run id"), identity(chatIdValue, "chat id"), identity(accountIdValue, "account id")]
    );
    return row ? decodeRun(row) : undefined;
  }

  async readBeginStatus(accountId: string, chatId: string, runId: string): Promise<Readonly<RunBeginStatus> | null> {
    const run = await this.readRun(accountId, chatId, runId);
    return run
      ? Object.freeze({
          status: run.status,
          cancelRequested: run.cancelRequested,
          shouldAbort: run.status !== "running" || run.cancelRequested,
        })
      : null;
  }

  async requestCancel(
    accountIdValue: string,
    chatIdValue: string,
    runIdValue: string,
    hooks: RequestCancelTestHooks = {}
  ): Promise<"cancelling" | TerminalChatRunStatus | null> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const runId = identity(runIdValue, "run id");
    return this.ledger.withImmediateTransaction(async (transaction) => {
      const row = transaction.get<RunRow>(
        "SELECT status,cancel_requested FROM chat_runs WHERE id=? AND chat_id=? AND account_id=?",
        [runId, chatId, accountId]
      );
      if (!row) return null;
      const status = runStatus(row.status);
      const terminal = terminalStatus(status);
      if (terminal) return terminal;
      if (status === "running") {
        const changed = transaction.run(
          `UPDATE chat_runs SET cancel_requested=1,status='cancelling'
           WHERE id=? AND chat_id=? AND account_id=? AND status='running'`,
          [runId, chatId, accountId]
        );
        if (changed.changes !== 1) throw new RunNotActiveError();
      } else if (!decodeBoolean(row.cancel_requested, "run cancel_requested")) {
        transaction.run(
          "UPDATE chat_runs SET cancel_requested=1 WHERE id=? AND chat_id=? AND account_id=? AND status='cancelling'",
          [runId, chatId, accountId]
        );
      }
      await hooks.afterTransition?.();
      return "cancelling";
    });
  }

  async finishRun(
    accountIdValue: string,
    chatIdValue: string,
    runIdValue: string,
    requestedStatus: "failed" | "cancelled",
    errorCodeValue?: string
  ): Promise<TerminalChatRunStatus> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const runId = identity(runIdValue, "run id");
    if (requestedStatus !== "failed" && requestedStatus !== "cancelled") {
      throw new TypeError("finishRun may only fail or cancel a run");
    }
    const requestedErrorCode = errorCodeValue ? inputString(errorCodeValue, "run error code", 128) : null;
    return this.ledger.withImmediateTransaction((transaction) => {
      const row = transaction.get<RunRow>(
        "SELECT status,cancel_requested FROM chat_runs WHERE id=? AND chat_id=? AND account_id=?",
        [runId, chatId, accountId]
      );
      if (!row) throw new RunNotFoundError();
      const current = runStatus(row.status);
      const existingTerminal = terminalStatus(current);
      if (existingTerminal) return existingTerminal;
      const cancellationWins = current === "cancelling" || decodeBoolean(row.cancel_requested, "run cancel_requested");
      const status = cancellationWins ? "cancelled" : requestedStatus;
      const errorCode = status === "cancelled" ? "CANCELLED" : requestedErrorCode;
      const changed = transaction.run(
        `UPDATE chat_runs
         SET status=?,cancel_requested=?,finished_at=?,error_code=?
         WHERE id=? AND chat_id=? AND account_id=? AND status IN ('running','cancelling')`,
        [
          encodeStatus(status),
          encodeBoolean(status === "cancelled" || cancellationWins),
          this.timestamp(),
          errorCode,
          runId,
          chatId,
          accountId,
        ]
      );
      if (changed.changes !== 1) throw new RunNotCompletableError();
      return status;
    });
  }

  async completeRunWithAssistant<Meta extends RunCompletionMeta>(
    accountIdValue: string,
    chatIdValue: string,
    runIdValue: string,
    completion: RunCompletion<Meta>,
    hooks: CompleteRunTestHooks = {}
  ): Promise<CompleteRunResult<Meta>> {
    const accountId = identity(accountIdValue, "account id");
    const chatId = identity(chatIdValue, "chat id");
    const runId = identity(runIdValue, "run id");
    const content = inputString(completion.content, "assistant content", 100_000, true);
    const chartIds = uniqueCompletionChartIds(completion.meta.charts);
    const reportId = completion.meta.report === null ? null : identity(completion.meta.report, "completion report id");
    const encodedMeta = encodeJson(completion.meta, "assistant message metadata");

    return this.ledger.withImmediateTransaction(async (transaction) => {
      const row = transaction.get<RunRow>(
        "SELECT status,cancel_requested FROM chat_runs WHERE id=? AND chat_id=? AND account_id=?",
        [runId, chatId, accountId]
      );
      if (!row) throw new RunNotFoundError();
      const status = runStatus(row.status);

      // Terminal states are absorbing. In particular, a retained cancellation
      // bit must never rewrite a recovered `failed` run on a late callback.
      if (status === "completed") {
        return Object.freeze({
          status: "completed" as const,
          reportCleanupIntents: Object.freeze(this.cleanupIntentsForRunInTransaction(transaction, accountId, runId)),
        });
      }
      if (status === "failed") throw new RunNotCompletableError();
      if (status === "cancelled") {
        return Object.freeze({
          status: "cancelled" as const,
          pendingReportCleanup: Object.freeze(this.pendingReportCleanupInTransaction(transaction, accountId, runId)),
        });
      }

      const cancellationRequested = decodeBoolean(row.cancel_requested, "run cancel_requested");
      if (cancellationRequested || status === "cancelling") {
        const cancelled = transaction.run(
          `UPDATE chat_runs
           SET status='cancelled',cancel_requested=1,finished_at=COALESCE(finished_at,?),error_code='CANCELLED'
           WHERE id=? AND chat_id=? AND account_id=? AND status IN ('running','cancelling')`,
          [this.timestamp(), runId, chatId, accountId]
        );
        if (cancelled.changes !== 1) throw new RunNotCompletableError();
        return Object.freeze({
          status: "cancelled" as const,
          pendingReportCleanup: Object.freeze(this.pendingReportCleanupInTransaction(transaction, accountId, runId)),
        });
      }
      if (status !== "running") throw new RunNotCompletableError();

      const pendingCharts = transaction.all<IdRow>(
        "SELECT id FROM charts WHERE account_id=? AND run_id=? AND status='pending' ORDER BY id",
        [accountId, runId]
      );
      const availableCharts = new Set(pendingCharts.map((pending) => requiredString(pending.id, "chart id")));
      if (chartIds.some((chartId) => !availableCharts.has(chartId))) throw new ArtifactOwnershipError("chart");

      const pendingReports = this.pendingReportCleanupInTransaction(transaction, accountId, runId);
      if (pendingReports.length > MAX_REPORT_CLEANUP_INTENTS) {
        throw new RangeError(`a run may retain at most ${MAX_REPORT_CLEANUP_INTENTS} pending reports`);
      }
      if (reportId !== null && !pendingReports.some((report) => report.id === reportId)) {
        throw new ArtifactOwnershipError("report");
      }
      const selectedReport = reportId === null ? undefined : pendingReports.find((report) => report.id === reportId);
      if (selectedReport && (!selectedReport.htmlPath || !selectedReport.pdfPath)) {
        throw new ArtifactPathsMissingError();
      }
      const cleanupReports = pendingReports.filter((report) => report.id !== reportId);
      await hooks.afterOwnershipValidated?.();

      const timestamp = this.timestamp();
      const cleanupIntents = cleanupReports.map((report) =>
        this.ensureReportCleanupIntentInTransaction(transaction, report, timestamp)
      );

      if (chartIds.length) {
        const published = transaction.run(
          `UPDATE charts SET status='published',run_id=NULL
           WHERE account_id=? AND run_id=? AND status='pending'
             AND id IN (${placeholders(chartIds.length)})`,
          [accountId, runId, ...chartIds]
        );
        if (published.changes !== chartIds.length) throw new ArtifactOwnershipError("chart");
        transaction.run(
          `DELETE FROM charts
           WHERE account_id=? AND run_id=? AND status='pending'
             AND id NOT IN (${placeholders(chartIds.length)})`,
          [accountId, runId, ...chartIds]
        );
      } else {
        transaction.run("DELETE FROM charts WHERE account_id=? AND run_id=? AND status='pending'", [accountId, runId]);
      }

      if (reportId !== null) {
        const published = transaction.run(
          `UPDATE reports SET status='published',run_id=NULL
           WHERE id=? AND account_id=? AND run_id=? AND status='pending'`,
          [reportId, accountId, runId]
        );
        if (published.changes !== 1) throw new ArtifactOwnershipError("report");
        transaction.run(
          `DELETE FROM reports
           WHERE account_id=? AND run_id=? AND status='pending' AND id<>?`,
          [accountId, runId, reportId]
        );
      } else {
        transaction.run("DELETE FROM reports WHERE account_id=? AND run_id=? AND status='pending'", [accountId, runId]);
      }

      const message = transaction.run(
        `INSERT INTO messages (chat_id,role,content,meta,created_at)
         VALUES (?,'assistant',?,?,?)`,
        [chatId, content, encodedMeta, timestamp]
      );
      const terminal = transaction.run(
        `UPDATE chat_runs SET status='completed',finished_at=?,error_code=NULL
         WHERE id=? AND chat_id=? AND account_id=? AND status='running' AND cancel_requested=0`,
        [timestamp, runId, chatId, accountId]
      );
      if (terminal.changes !== 1) throw new RunNotCompletableError();

      return Object.freeze({
        status: "completed" as const,
        message: Object.freeze({ id: message.lastInsertRowid, content, meta: completion.meta }),
        reportCleanupIntents: Object.freeze(cleanupIntents),
      });
    });
  }

  async recoverInterruptedRuns(): Promise<number> {
    return this.ledger.withImmediateTransaction(
      (transaction) =>
        transaction.run(
          `UPDATE chat_runs
         SET status=CASE
               WHEN status='cancelling' OR cancel_requested=1 THEN 'cancelled'
               ELSE 'failed'
             END,
             cancel_requested=CASE
               WHEN status='cancelling' OR cancel_requested=1 THEN 1
               ELSE cancel_requested
             END,
             finished_at=?,
             error_code=CASE
               WHEN status='cancelling' OR cancel_requested=1 THEN 'CANCELLED'
               ELSE 'SERVER_RESTARTED'
             END
         WHERE status IN ('running','cancelling')`,
          [this.timestamp()]
        ).changes
    );
  }

  async insertPendingChart(
    input: PendingChartInput,
    hooks: InsertPendingArtifactTestHooks = {}
  ): Promise<{ readonly id: string }> {
    const id = identity(input.id, "chart id");
    const accountId = identity(input.accountId, "account id");
    const runId = identity(input.runId, "run id");
    const spec = encodeJson(input.spec, "chart spec");
    const echarts = encodeJson(input.echarts, "chart echarts");
    const pngBase64 =
      input.pngBase64 === undefined || input.pngBase64 === null
        ? null
        : inputString(input.pngBase64, "chart png_base64", 50_000_000, true);
    return this.ledger.withImmediateTransaction(async (transaction) => {
      this.requireActiveRun(transaction, accountId, runId);
      await hooks.afterActiveCheck?.();
      transaction.run(
        `INSERT INTO charts (id,account_id,run_id,status,spec,echarts,png_base64,created_at)
         VALUES (?,?,?,'pending',?,?,?,?)`,
        [id, accountId, runId, spec, echarts, pngBase64, this.timestamp()]
      );
      return Object.freeze({ id });
    });
  }

  async insertPendingReport(
    input: PendingReportInput,
    hooks: InsertPendingArtifactTestHooks = {}
  ): Promise<{ readonly id: string }> {
    const id = identity(input.id, "report id");
    const accountId = identity(input.accountId, "account id");
    const runId = identity(input.runId, "run id");
    const title = inputString(input.title, "report title", 200);
    const subtitle =
      input.subtitle === undefined || input.subtitle === null
        ? null
        : inputString(input.subtitle, "report subtitle", 500, true);
    const htmlPath = inputString(input.htmlPath, "report html path", 32_000);
    const pdfPath = inputString(input.pdfPath, "report pdf path", 32_000);
    return this.ledger.withImmediateTransaction(async (transaction) => {
      const run = this.requireActiveRun(transaction, accountId, runId);
      await hooks.afterActiveCheck?.();
      const timestamp = this.timestamp();
      transaction.run(
        `INSERT INTO reports
           (id,account_id,chat_id,run_id,status,title,subtitle,html_path,pdf_path,created_at,updated_at)
         VALUES (?,?,?,?,'pending',?,?,?,?,?,?)`,
        [
          id,
          accountId,
          requiredString(run.chat_id, "run chat id"),
          runId,
          title,
          subtitle,
          htmlPath,
          pdfPath,
          timestamp,
          timestamp,
        ]
      );
      return Object.freeze({ id });
    });
  }

  async getPublishedChart(accountIdValue: string, chartIdValue: string): Promise<PublishedChart | undefined> {
    const row = await this.ledger.get<ChartRow>(
      `SELECT id,spec,echarts,png_base64 FROM charts
       WHERE id=? AND account_id=? AND status='published'`,
      [identity(chartIdValue, "chart id"), identity(accountIdValue, "account id")]
    );
    return row ? decodePublishedChart(row) : undefined;
  }

  async getPendingChart(
    accountIdValue: string,
    runIdValue: string,
    chartIdValue: string
  ): Promise<Readonly<PendingChart> | undefined> {
    const row = await this.ledger.get<ChartRow>(
      `SELECT id,spec FROM charts
       WHERE id=? AND account_id=? AND run_id=? AND status='pending'`,
      [identity(chartIdValue, "chart id"), identity(accountIdValue, "account id"), identity(runIdValue, "run id")]
    );
    return row
      ? Object.freeze({ id: requiredString(row.id, "chart id"), spec: decodeJson(row.spec, "chart spec") })
      : undefined;
  }

  async listPublishedReports(accountIdValue: string): Promise<PublishedReport[]> {
    const accountId = identity(accountIdValue, "account id");
    const rows = await this.ledger.all<ReportRow>(
      `SELECT r.id,r.title,r.subtitle,r.chat_id,c.title AS chat_title,
              r.created_at,r.updated_at,r.html_path,r.pdf_path
       FROM reports r
       LEFT JOIN chats c ON c.id=r.chat_id AND c.account_id=r.account_id
       WHERE r.account_id=? AND r.status='published'
       ORDER BY r.created_at DESC,r.id DESC`,
      [accountId]
    );
    return rows.map((row) => decodePublishedReport(row));
  }

  async getPublishedReport(accountIdValue: string, reportIdValue: string): Promise<PublishedReport | undefined> {
    const row = await this.ledger.get<ReportRow>(
      `SELECT r.id,r.title,r.subtitle,r.chat_id,c.title AS chat_title,
              r.created_at,r.updated_at,r.html_path,r.pdf_path
       FROM reports r
       LEFT JOIN chats c ON c.id=r.chat_id AND c.account_id=r.account_id
       WHERE r.id=? AND r.account_id=? AND r.status='published'`,
      [identity(reportIdValue, "report id"), identity(accountIdValue, "account id")]
    );
    return row ? decodePublishedReport(row) : undefined;
  }

  /**
   * Atomically hides the published row and reserves its exact filesystem work.
   * The durable intent is cleared only after files-first cleanup succeeds.
   */
  async reservePublishedReportDeletion(
    accountIdValue: string,
    reportIdValue: string
  ): Promise<Readonly<ReportArtifactCleanupIntent>> {
    const accountId = identity(accountIdValue, "account id");
    const reportId = identity(reportIdValue, "report id");
    return this.ledger.withImmediateTransaction((transaction) => {
      const report = transaction.get<ReportRow>(
        `SELECT id,account_id,run_id,html_path,pdf_path FROM reports
         WHERE id=? AND account_id=? AND status='published'`,
        [reportId, accountId]
      );
      if (!report) {
        const existing = transaction.get<CleanupIntentRow>(
          `SELECT report_id,account_id,run_id,html_path,pdf_path,attempts,last_error,created_at,updated_at
           FROM report_artifact_cleanup_jobs WHERE report_id=? AND account_id=?`,
          [reportId, accountId]
        );
        if (existing) return decodeCleanupIntent(existing);
        throw new ArtifactNotFoundError("report");
      }

      const cleanup = decodeCleanupPath(report);
      const intent = this.ensureReportCleanupIntentInTransaction(transaction, cleanup, this.timestamp());
      const deleted = transaction.run("DELETE FROM reports WHERE id=? AND account_id=? AND status='published'", [
        reportId,
        accountId,
      ]);
      if (deleted.changes !== 1) throw new ArtifactNotFoundError("report");
      return intent;
    });
  }

  async deletePublishedChartRow(accountIdValue: string, chartIdValue: string): Promise<boolean> {
    return (
      (
        await this.ledger.run("DELETE FROM charts WHERE id=? AND account_id=? AND status='published'", [
          identity(chartIdValue, "chart id"),
          identity(accountIdValue, "account id"),
        ])
      ).changes === 1
    );
  }

  /** Trusted boot-worker view; route callers should use the account-scoped APIs. */
  async listReportArtifactCleanupIntents(limitValue = 100): Promise<ReportArtifactCleanupIntent[]> {
    const limit = boundedPositiveInteger(limitValue, "report cleanup limit", MAX_REPORT_CLEANUP_INTENTS);
    const rows = await this.ledger.all<CleanupIntentRow>(
      `SELECT report_id,account_id,run_id,html_path,pdf_path,attempts,last_error,created_at,updated_at
       FROM report_artifact_cleanup_jobs
       ORDER BY attempts,updated_at,report_id LIMIT ?`,
      [limit]
    );
    return rows.map((row) => decodeCleanupIntent(row));
  }

  async listReportArtifactCleanupIntentsForRun(
    accountIdValue: string,
    runIdValue: string,
    limitValue = 100
  ): Promise<ReportArtifactCleanupIntent[]> {
    const accountId = identity(accountIdValue, "account id");
    const runId = identity(runIdValue, "run id");
    const limit = boundedPositiveInteger(limitValue, "report cleanup limit", MAX_REPORT_CLEANUP_INTENTS);
    const rows = await this.ledger.all<CleanupIntentRow>(
      `SELECT report_id,account_id,run_id,html_path,pdf_path,attempts,last_error,created_at,updated_at
       FROM report_artifact_cleanup_jobs
       WHERE account_id=? AND run_id=?
       ORDER BY report_id LIMIT ?`,
      [accountId, runId, limit]
    );
    return rows.map((row) => decodeCleanupIntent(row));
  }

  async recordReportArtifactCleanupFailure(
    accountIdValue: string,
    reportIdValue: string,
    errorCodeValue: string
  ): Promise<Readonly<ReportArtifactCleanupIntent>> {
    const accountId = identity(accountIdValue, "account id");
    const reportId = identity(reportIdValue, "report id");
    const errorCode = inputString(errorCodeValue, "report cleanup error code", 128);
    return this.ledger.withImmediateTransaction((transaction) => {
      const updated = transaction.run(
        `UPDATE report_artifact_cleanup_jobs
         SET attempts=attempts+1,last_error=?,updated_at=?
         WHERE report_id=? AND account_id=?`,
        [errorCode, this.timestamp(), reportId, accountId]
      );
      if (updated.changes !== 1) throw new ArtifactNotFoundError("report");
      const row = transaction.get<CleanupIntentRow>(
        `SELECT report_id,account_id,run_id,html_path,pdf_path,attempts,last_error,created_at,updated_at
         FROM report_artifact_cleanup_jobs WHERE report_id=? AND account_id=?`,
        [reportId, accountId]
      );
      if (!row) throw new ArtifactNotFoundError("report");
      return decodeCleanupIntent(row);
    });
  }

  /** Call only after both file removals have succeeded or reported missing. */
  async clearReportArtifactCleanupIntent(accountIdValue: string, reportIdValue: string): Promise<boolean> {
    const result = await this.ledger.run(
      "DELETE FROM report_artifact_cleanup_jobs WHERE report_id=? AND account_id=?",
      [identity(reportIdValue, "report id"), identity(accountIdValue, "account id")]
    );
    return result.changes === 1;
  }

  async listOrphanedPendingRunGroups(): Promise<OrphanedPendingRunGroup[]> {
    const rows = await this.ledger.all<OrphanRow>(
      `SELECT p.account_id,p.run_id,
              sum(CASE WHEN p.kind='report' THEN 1 ELSE 0 END) AS report_count,
              sum(CASE WHEN p.kind='chart' THEN 1 ELSE 0 END) AS chart_count
       FROM (
         SELECT account_id,run_id,'report' AS kind FROM reports WHERE status='pending'
         UNION ALL
         SELECT account_id,run_id,'chart' AS kind FROM charts WHERE status='pending'
       ) p
       LEFT JOIN chat_runs r ON r.id=p.run_id AND r.account_id=p.account_id
       WHERE r.id IS NULL OR r.status NOT IN ('running','cancelling')
       GROUP BY p.account_id,p.run_id
       ORDER BY p.account_id,p.run_id`
    );
    return rows.map((row) =>
      Object.freeze({
        accountId: requiredString(row.account_id, "orphan account id"),
        runId: optionalString(row.run_id, "orphan run id"),
        reportCount: decodeSafeInteger(row.report_count, "orphan report count"),
        chartCount: decodeSafeInteger(row.chart_count, "orphan chart count"),
      })
    );
  }

  async listPendingReportCleanupPaths(
    accountIdValue: string,
    runIdValue: string | null,
    limitValue = 100
  ): Promise<PendingReportCleanupPath[]> {
    const accountId = identity(accountIdValue, "account id");
    const runId = runIdValue === null ? null : identity(runIdValue, "run id");
    const limit = boundedPositiveInteger(limitValue, "pending report cleanup limit", MAX_REPORT_CLEANUP_INTENTS);
    const predicate = runGroupPredicate(runId);
    const rows = await this.ledger.all<ReportRow>(
      `SELECT id,account_id,run_id,html_path,pdf_path FROM reports
       WHERE account_id=? AND status='pending' AND ${predicate.sql}
       ORDER BY id LIMIT ?`,
      [accountId, ...predicate.values, limit]
    );
    return rows.map((row) => decodeCleanupPath(row));
  }

  async deletePendingArtifactRows(
    accountIdValue: string,
    runIdValue: string | null,
    observedReportValues: readonly PendingReportCleanupPath[]
  ): Promise<Readonly<PendingArtifactDeleteResult>> {
    const accountId = identity(accountIdValue, "account id");
    const runId = runIdValue === null ? null : identity(runIdValue, "run id");
    const observedReports = observedCleanupReports(observedReportValues, accountId, runId);
    return this.ledger.withImmediateTransaction((transaction) => {
      if (runId !== null) {
        const run = transaction.get<RunRow>("SELECT status FROM chat_runs WHERE id=? AND account_id=?", [
          runId,
          accountId,
        ]);
        if (run && (runStatus(run.status) === "running" || runStatus(run.status) === "cancelling")) {
          throw new ActiveRunArtifactCleanupError();
        }
      }
      const predicate = runGroupPredicate(runId);
      let reports = 0;
      for (const report of observedReports) {
        const deleted = transaction.run(
          `DELETE FROM reports
           WHERE id=? AND account_id=? AND status='pending' AND ${predicate.sql}
             AND html_path IS ? AND pdf_path IS ?`,
          [report.id, accountId, ...predicate.values, report.htmlPath, report.pdfPath]
        );
        if (deleted.changes !== 1) continue;
        const acknowledged = transaction.run(
          `DELETE FROM report_artifact_cleanup_jobs
           WHERE report_id=? AND account_id=? AND run_id IS ?
             AND html_path IS ? AND pdf_path IS ?`,
          [report.id, accountId, runId, report.htmlPath, report.pdfPath]
        );
        if (acknowledged.changes !== 1) throw new ArtifactOwnershipError("report");
        reports += 1;
      }
      const charts = transaction.run(
        `DELETE FROM charts WHERE account_id=? AND status='pending' AND ${predicate.sql}`,
        [accountId, ...predicate.values]
      ).changes;
      return Object.freeze({ reports, charts });
    });
  }

  private timestamp(): string {
    return encodeIsoTimestamp(this.now(), "run store clock");
  }

  private requireActiveRun(transaction: SqliteTransaction, accountId: string, runId: string): ActiveRunRow {
    const run = transaction.get<ActiveRunRow>(
      "SELECT chat_id,status,cancel_requested FROM chat_runs WHERE id=? AND account_id=?",
      [runId, accountId]
    );
    if (!run || runStatus(run.status) !== "running" || decodeBoolean(run.cancel_requested, "run cancel_requested")) {
      throw new RunNotActiveError();
    }
    return run;
  }

  private ensureReportCleanupIntentInTransaction(
    transaction: SqliteTransaction,
    cleanup: PendingReportCleanupPath,
    timestamp: string
  ): ReportArtifactCleanupIntent {
    transaction.run(
      `INSERT INTO report_artifact_cleanup_jobs
         (report_id,account_id,run_id,html_path,pdf_path,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(report_id) DO NOTHING`,
      [cleanup.id, cleanup.accountId, cleanup.runId, cleanup.htmlPath, cleanup.pdfPath, timestamp, timestamp]
    );
    const row = transaction.get<CleanupIntentRow>(
      `SELECT report_id,account_id,run_id,html_path,pdf_path,attempts,last_error,created_at,updated_at
       FROM report_artifact_cleanup_jobs WHERE report_id=?`,
      [cleanup.id]
    );
    if (!row) throw new ArtifactNotFoundError("report");
    const intent = decodeCleanupIntent(row);
    if (
      intent.accountId !== cleanup.accountId ||
      intent.runId !== cleanup.runId ||
      intent.htmlPath !== cleanup.htmlPath ||
      intent.pdfPath !== cleanup.pdfPath
    ) {
      throw new ArtifactOwnershipError("report");
    }
    return intent;
  }

  private cleanupIntentsForRunInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    runId: string
  ): ReportArtifactCleanupIntent[] {
    const rows = transaction.all<CleanupIntentRow>(
      `SELECT report_id,account_id,run_id,html_path,pdf_path,attempts,last_error,created_at,updated_at
       FROM report_artifact_cleanup_jobs
       WHERE account_id=? AND run_id=?
       ORDER BY report_id LIMIT ?`,
      [accountId, runId, MAX_REPORT_CLEANUP_INTENTS + 1]
    );
    if (rows.length > MAX_REPORT_CLEANUP_INTENTS) {
      throw new RangeError(`a run may retain at most ${MAX_REPORT_CLEANUP_INTENTS} cleanup intents`);
    }
    return rows.map((row) => decodeCleanupIntent(row));
  }

  private pendingReportCleanupInTransaction(
    transaction: SqliteTransaction,
    accountId: string,
    runId: string
  ): PendingReportCleanupPath[] {
    return transaction
      .all<ReportRow>(
        `SELECT id,account_id,run_id,html_path,pdf_path FROM reports
         WHERE account_id=? AND run_id=? AND status='pending' ORDER BY id`,
        [accountId, runId]
      )
      .map((row) => decodeCleanupPath(row));
  }
}

function encodeStatus(status: TerminalChatRunStatus): string {
  return status;
}

export function createRunStore(ledger: SqliteLedger, options: RunStoreOptions = {}): RunStore {
  return new RunStore(ledger, options);
}
