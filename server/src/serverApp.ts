import fsPromises from "node:fs/promises";
import path from "node:path";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import {
  createApplicationRuntime,
  isApplicationRuntimeLeaseRetained,
  type ApplicationRuntime,
} from "./applicationRuntime.js";
import { setAppLogger } from "./appLogger.js";
import { shutdownActiveRuns, recoverInterruptedRuns } from "./chatRuns.js";
import { config, initializeConfigStorage } from "./config.js";
import { repairDocumentArtifactCleanup, repairDocumentPublications } from "./documentCleanup.js";
import { reconcileBriefPublications } from "./briefReviewService.js";
import { shutdownDatasetWorker } from "./data/datasets.js";
import { createDesktopBootstrapSession, type DesktopBootstrapSession } from "./desktopBootstrap.js";
import { corsOrigin } from "./corsPolicy.js";
import { installHttpBoundary } from "./httpErrors.js";
import { restoreDatasets, startIngestionWorkers, stopIngestionWorkers } from "./ingest.js";
import { runWithRequestContext } from "./requestContext.js";
import { routes, type AutomationSchedulerStatus } from "./routes.js";
import { DEFAULT_BODY_LIMIT_BYTES } from "./routes/bodyLimits.js";
import { acquireWorkspaceLock } from "./workspaceLock.js";

export interface BuildBorealisAppOptions {
  readonly logger?: boolean;
  readonly staticWebDir?: string;
  /**
   * Trusted server-composition mode, derived only from startup options
   * (never from request data). It gates contained-engine process control.
   */
  readonly desktop?: boolean;
  /**
   * Plan 014: the owned application runtime's scheduler status for this
   * instance. `startBorealisServer` always passes the owned runner; omitted
   * composition (isolated static-host/test apps) receives the explicit
   * stopped capability that route composition itself supplies.
   */
  readonly automationScheduler?: AutomationSchedulerStatus;
}

export interface StartBorealisServerOptions extends BuildBorealisAppOptions {
  readonly host?: string;
  readonly port?: number;
  // `desktop` is inherited from BuildBorealisAppOptions: the same trusted
  // composition value gates both the guards below and route composition.
}

export interface RunningBorealisServer {
  readonly app: FastifyInstance;
  readonly host: string;
  readonly port: number;
  readonly bootstrap?: DesktopBootstrapSession;
  close(): Promise<void>;
}

/**
 * Production shell CSP applied to every HTML shell response (direct static
 * HTML and the SPA fallback alike, from this one constant so they cannot
 * drift). It keeps every subresource on the exact Fastify origin, allows only
 * the inline theme bootstrap and inline styles the shell already uses, chart
 * `data:` images, and the sandboxed `srcDoc` report preview under `about:`.
 * Same-origin HTTP frames stay denied: an HTTP frame is still a network
 * frame. Report artifacts carry their own stricter policy and are unaffected.
 */
export const STATIC_UI_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src about:",
].join("; ");

async function canonicalStaticDirectory(directory: string): Promise<string> {
  const resolved = await fsPromises.realpath(path.resolve(directory));
  const stat = await fsPromises.stat(path.join(resolved, "index.html"));
  if (!stat.isFile()) throw new Error("STATIC_WEB_DIR must contain index.html");
  return resolved;
}

async function registerStaticUi(app: FastifyInstance, directory: string): Promise<void> {
  const root = await canonicalStaticDirectory(directory);
  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    serveDotFiles: false,
    dotfiles: "ignore",
    setHeaders(response, filename) {
      if (path.extname(filename) === ".html") {
        response.header("Cache-Control", "no-store");
        response.header("Content-Security-Policy", STATIC_UI_CSP);
      } else if (filename.startsWith(path.join(root, "assets") + path.sep)) {
        response.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  });
}

function staticUiNotFound(request: FastifyRequest, reply: FastifyReply): unknown {
  const requestPath = request.url.split(/[?#]/, 1)[0];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    // Malformed paths retain the raw value and cannot enter the SPA fallback.
    decodedPath = "/.";
  }
  const hasDotSegment = decodedPath.split("/").some((segment) => segment.startsWith("."));
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    !hasDotSegment &&
    requestPath !== "/api" &&
    !requestPath.startsWith("/api/") &&
    request.headers.accept?.includes("text/html")
  ) {
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", STATIC_UI_CSP)
      .sendFile("index.html");
  }
  const requestId = String(reply.getHeader("X-Request-ID") || request.id);
  return reply.code(404).send({ error: "not found", request_id: requestId });
}

/** Compose the API and optional same-origin production UI without opening a socket. */
export async function buildBorealisApp(options: BuildBorealisAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: DEFAULT_BODY_LIMIT_BYTES });
  setAppLogger(app.log);
  installHttpBoundary(app, options.staticWebDir ? { notFound: staticUiNotFound } : {});
  // The packaged UI is served from this exact Fastify origin and needs no
  // CORS headers. Omitting them also denies every cross-origin browser. The
  // separate Vite dev server keeps the fixed credentialed allowlist.
  if (!options.staticWebDir) await app.register(cors, { origin: corsOrigin, credentials: true });
  // Plan 007: the trusted desktop composition mode is the only input to the
  // contained-engine authority gate; the default is fail-closed browser mode.
  // Plan 014: the scheduler status capability rides the same typed options.
  await routes(app, { desktop: options.desktop ?? false, automationScheduler: options.automationScheduler });
  if (options.staticWebDir) await registerStaticUi(app, options.staticWebDir);
  return app;
}

function listeningPort(app: FastifyInstance): number {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP socket");
  return address.port;
}

function validateDesktopBinding(host: string): void {
  if (host !== "127.0.0.1") throw new Error("desktop server must bind to 127.0.0.1");
}

/**
 * Quiesce both ingress sources — the HTTP app being closed and the automation
 * scheduler's retained drain — while repeatedly cancelling this process's
 * active chat runs. A request accepted just before close(), or a claim batch
 * already inside acceptChatTurn, can reach beginRun after an earlier registry
 * snapshot, so cancellation continues on the short bounded poll until both
 * sources are observed settled, then runs one final cancellation snapshot.
 * Connector sync claims have no chat controller; the scheduler drain itself
 * awaits their bounded connector/data-service work before storage close.
 *
 * The drain reports positive closure: it rejects when HTTP close or a
 * cancellation snapshot failed, so the caller's external-consumer proof for
 * the owned runtime close can never be granted over a still-live consumer.
 * The scheduler drain's own failure is recorded by the owned runtime close,
 * which joins the same retained promise.
 */
async function drainIngressAndCancelRuns(
  app: FastifyInstance | undefined,
  schedulerDrain: Promise<void>
): Promise<void> {
  let httpClosed = app === undefined;
  let httpCloseFailed = false;
  let runCancellationFailed = false;
  const httpClose = app
    ? app
        .close()
        .catch(() => {
          httpCloseFailed = true;
        })
        .finally(() => {
          httpClosed = true;
        })
    : Promise.resolve();
  let schedulerSettled = false;
  const schedulerClosed = schedulerDrain
    .catch(() => {})
    .finally(() => {
      schedulerSettled = true;
    });
  do {
    await shutdownActiveRuns().catch(() => {
      runCancellationFailed = true;
    });
    // An in-flight request can finish after HTTP close takes its initial
    // idle-socket snapshot. Reap newly idle keep-alive sockets while waiting,
    // without interrupting active publications or other bounded requests.
    if (!httpClosed) app?.server.closeIdleConnections();
    if (!httpClosed || !schedulerSettled) {
      // Race only the sources not yet observed settled plus the bounded poll;
      // including an already-settled source would spin this loop on microtasks.
      const pending: Promise<unknown>[] = [new Promise<void>((resolve) => setTimeout(resolve, 25))];
      if (!httpClosed) pending.push(httpClose);
      if (!schedulerSettled) pending.push(schedulerClosed);
      await Promise.race(pending);
    }
  } while (!httpClosed || !schedulerSettled);
  // One final snapshot covers controllers registered up to the last possible
  // beginRun boundary before either source settled.
  await shutdownActiveRuns().catch(() => {
    runCancellationFailed = true;
  });
  const failed: string[] = [];
  if (httpCloseFailed) failed.push("http-close");
  if (runCancellationFailed) failed.push("run-cancellation");
  if (failed.length > 0) throw new Error(`ingress drain incomplete: ${failed.join(", ")}`);
}

interface ExternalDrainContext {
  readonly app: FastifyInstance | undefined;
  /** The single owned runtime for this server attempt, if one was created. */
  readonly runtime: ApplicationRuntime | undefined;
  readonly workersStarted: boolean;
  readonly startupReconciliation?: Promise<unknown>;
  /** Positive record of the background reconciliation outcome. */
  readonly reconciliationSettled: () => boolean;
}

/**
 * One teardown orchestration shared by normal close and every startup failure
 * after runtime ownership begins:
 *
 * 1. Synchronously quiesce both owned admission sources before the first
 *    await — the automation scheduler (plan 013) and contained-download
 *    admission (plan 008) — so new claim dispatch and new download
 *    reservations stop before HTTP draining begins.
 * 2. Attempt every independent external storage drain with all-settled
 *    semantics and record each positive result: HTTP plus active chat runs,
 *    ingestion workers (whose owned abort path reaps local OCR helper
 *    children), and startup dataset reconciliation. The DuckDB dataset
 *    worker then drains last, once those consumers are observed settled, so
 *    its shutdown drain faces only already-cancelled or bounded in-flight
 *    native work.
 * 3. Always hand the owned runtime the exact external-consumer proof. The
 *    runtime joins the scheduler/download drains started here, stops the
 *    contained engine, drains the migration coordinator, and closes storage
 *    and settings only under that proof. A rejected proof leaves settings
 *    and storage owned and open, poisons the lease, and rejects.
 *
 * No `close()` resolution or desktop `stopped` acknowledgement can precede
 * the download drain: it is admitted-closed synchronously in step 1 and only
 * ever joined (never skipped) inside the runtime close that gates step 3.
 */
async function drainExternalAndClose(context: ExternalDrainContext): Promise<void> {
  const { app, runtime } = context;
  // Step 1: synchronous admission closure for both owned ingress sources.
  const schedulerDrain = runtime ? runtime.stopAutomationScheduler() : Promise.resolve();
  const downloadDrain = runtime ? runtime.quiesceDownloads() : Promise.resolve();
  // The owned runtime close below joins its own call; attach a no-op handler
  // to this call so an early rejection can never surface as an unhandled
  // rejection while external consumers drain.
  void downloadDrain.catch(() => undefined);
  // Analysis statements are interrupted synchronously while the dataset
  // worker is still alive; the owned runtime close below joins the same
  // drain, and every interrupted run finalizes its durable row (failed, or
  // cancelled when a cancellation was requested) before storage closure.
  const analysisDrain = runtime ? runtime.stopAnalysisRunner() : Promise.resolve();
  void analysisDrain.catch(() => undefined);
  // Document-rewrite transports are interrupted synchronously while the
  // stores are alive; the owned runtime close below joins the same drain, and
  // every interrupted rewrite finalizes its durable row (failed, never
  // replayed; cancelled when a cancellation was requested) before closure.
  const rewriteDrain = runtime ? runtime.stopDocumentRewriteRunner() : Promise.resolve();
  void rewriteDrain.catch(() => undefined);
  // Research model transports are interrupted synchronously while the stores
  // are alive; the owned runtime close below joins the same drain. An
  // interrupted research run stays durable `running` for the bounded at-most-
  // once startup resume, and a run whose cancellation was requested settles
  // `cancelled` — no orphaned active research row crosses storage closure.
  const researchDrain = runtime ? runtime.stopResearchRunner() : Promise.resolve();
  void researchDrain.catch(() => undefined);
  // M16 stage 2: brief executions are quiesced synchronously while the stores
  // are alive; bounded waits interrupt, requested cancellations finalize
  // `cancelled`, and resumable work deliberately stays in its committed stage
  // for the next startup resume before storage closure. The owned runtime
  // close below joins the same drain.
  const briefDrain = runtime ? runtime.stopBriefRunner() : Promise.resolve();
  void briefDrain.catch(() => undefined);

  // Step 2: attempt-all independent external drains with positive records.
  const [ingress, workers, reconciliation] = await Promise.allSettled([
    drainIngressAndCancelRuns(app, schedulerDrain),
    context.workersStarted ? stopIngestionWorkers() : Promise.resolve(),
    context.startupReconciliation ?? Promise.resolve(),
  ]);
  // The DuckDB dataset worker drains last among the external consumers, not
  // concurrently with them: HTTP and ingestion must be observed settled (with
  // their request cancellations already delivered to the worker) before the
  // worker begins draining its own in-flight native work. Tearing the worker
  // down over still-live consumers lets a late health/query RPC be overtaken
  // by the thread's environment cleanup, which aborts the process inside
  // duckdb.node instead of letting close() finish.
  const datasetWorker = await shutdownDatasetWorker().then(
    () => ({ status: "fulfilled" as const, value: undefined }),
    () => ({ status: "rejected" as const, reason: undefined })
  );
  const externalDrained =
    ingress.status === "fulfilled" &&
    workers.status === "fulfilled" &&
    reconciliation.status === "fulfilled" &&
    datasetWorker.status === "fulfilled" &&
    context.reconciliationSettled();

  // Step 3: the proof-bearing owned close. With a false proof it still
  // attempts every owned drain and then rejects without closing settings or
  // storage, so this function rejects alongside it.
  await runtime?.close({ externalStorageConsumersDrained: externalDrained });

  if (!externalDrained) {
    // No runtime existed to carry the proof; an external consumer still
    // failed, so this attempt's unwind is not proven complete.
    const failed: string[] = [];
    if (ingress.status !== "fulfilled") failed.push("ingress");
    if (workers.status !== "fulfilled") failed.push("ingestion");
    if (reconciliation.status !== "fulfilled" || !context.reconciliationSettled()) failed.push("reconciliation");
    if (datasetWorker.status !== "fulfilled") failed.push("dataset-worker");
    throw new Error(`shutdown unwind incomplete: ${failed.join(", ")}`);
  }
}

/** Open embedded services, recover durable state, and publish the loopback server. */
export async function startBorealisServer(options: StartBorealisServerOptions = {}): Promise<RunningBorealisServer> {
  const desktop = options.desktop ?? process.env.BOREALIS_DESKTOP === "1";
  const host = options.host ?? config.host;
  const port = options.port ?? config.port;
  const staticWebDir = options.staticWebDir ?? process.env.STATIC_WEB_DIR;
  if (desktop) {
    validateDesktopBinding(host);
    if (!staticWebDir) throw new Error("desktop server requires STATIC_WEB_DIR");
  }

  // Plan 037's cross-process workspace lock is deliberately outside the
  // in-process application-runtime lease: it is acquired before any durable
  // directory or secret is touched and released only after every owned and
  // external consumer is positively closed (or after a complete construction
  // unwind). It is never released on a poisoned or uncertain close.
  let workspaceLock: Awaited<ReturnType<typeof acquireWorkspaceLock>> | undefined;
  let app: FastifyInstance | undefined;
  let runtime: ApplicationRuntime | undefined;
  let workersStarted = false;
  let reconciliationOk = true;
  let startupReconciliation: Promise<unknown> | undefined;
  try {
    workspaceLock = await acquireWorkspaceLock(config.storageDir);
    initializeConfigStorage();
    // One owned runtime: settings, paired stores, the migration coordinator,
    // the contained download lifecycle, and the single automation runner.
    runtime = await createApplicationRuntime();
    app = await buildBorealisApp({
      logger: options.logger,
      staticWebDir,
      desktop,
      automationScheduler: runtime.runner,
    });
    const interruptedRuns = await recoverInterruptedRuns();
    if (interruptedRuns) app.log.warn({ interrupted_runs: interruptedRuns }, "recovered interrupted chat runs");
    // M13 stage 4: interrupted document renders become durable retryable
    // failures with exact-directory artifact cleanup (never an auto-publish),
    // and hidden-document cleanup intents complete. Startup repair never
    // fails boot; failures stay durable for the next boot.
    try {
      const renderRepair = await repairDocumentPublications();
      const deleteRepair = await repairDocumentArtifactCleanup();
      if (renderRepair.attempted || deleteRepair.attempted) {
        app.log.warn(
          {
            document_render_cleanup_completed: renderRepair.completed,
            document_deletions_completed: deleteRepair.completed,
            document_cleanup_failed: renderRepair.failed + deleteRepair.failed,
          },
          "repaired document publication state"
        );
      }
    } catch {
      app.log.warn("document publication repair deferred to the next startup");
    }
    // M16 stage 3: brief runs interrupted mid-publication finalize from
    // their own durable intents only after the M13 render repair above —
    // completed → approved, failed/absent → awaiting_review with the bounded
    // indicator. Aggregate counts only; never IDs/content, and never a boot
    // failure (interrupted work stays durable for the next decision retry).
    try {
      const briefRepair = await reconcileBriefPublications();
      if (briefRepair.attempted) {
        app.log.warn(
          {
            brief_publications_approved: briefRepair.approved,
            brief_publications_returned_to_review: briefRepair.returnedToReview,
          },
          "reconciled interrupted brief publications"
        );
      }
    } catch {
      app.log.warn("brief publication reconciliation deferred to the next startup");
    }
    await startIngestionWorkers();
    workersStarted = true;
    runtime.startAutomationScheduler();
    // M12 stage 2: recover interrupted analysis runs, then resume undispatched
    // queued runs through the owned durable executor.
    runtime.startAnalysisRunner();
    // M13 stage 3: recover interrupted rewrites as durable failures (never
    // replayed), then resume undispatched queued requests.
    runtime.startDocumentRewriteRunner();
    // M15 stage 2: recover interrupted research runs (steps revert to
    // `pending` for the bounded at-most-once retry), then resume resumable
    // rows one per account through the owned durable executor.
    runtime.startResearchRunner();
    // M16 stage 2: resume recovered brief runs from their committed receipts,
    // then claim due occurrences and dispatch at most one brief per account
    // and two globally on an unref'd interval.
    runtime.startBriefRunner();
    const bootstrap = desktop ? await createDesktopBootstrapSession() : undefined;
    await app.listen({ port, host });
    const actualPort = listeningPort(app);
    const activeApp = app;
    const activeRuntime = runtime;
    const activeLock = workspaceLock;
    app.log.info({ host, port: actualPort }, "Borealis server listening");
    startupReconciliation = runWithRequestContext("dataset-reconciliation.startup", () => restoreDatasets())
      .then((summary) => activeApp.log.info({ ...summary }, "dataset registry reconciliation finished"))
      .catch(() => {
        reconciliationOk = false;
        activeApp.log.warn("dataset registry reconciliation failed");
      });

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        await drainExternalAndClose({
          app: activeApp,
          runtime: activeRuntime,
          workersStarted: true,
          startupReconciliation,
          reconciliationSettled: () => reconciliationOk,
        });
        // Every owned and external consumer is positively closed: last,
        // release the cross-process workspace lock.
        await activeLock.release();
      })();
      return closePromise;
    };
    return Object.freeze({ app: activeApp, host, port: actualPort, ...(bootstrap ? { bootstrap } : {}), close });
  } catch (error) {
    // Apply the same synchronous admission closure and attempt-all
    // quiesce/cancel/drain as normal close before the proof-bearing runtime
    // close, against only what this attempt created: a rejected overlapping
    // factory is a startup failure for this attempted server alone and never
    // runs cleanup against another owner's resources.
    let unwindProven = true;
    try {
      await drainExternalAndClose({
        app,
        runtime,
        workersStarted,
        startupReconciliation,
        reconciliationSettled: () => reconciliationOk,
      });
    } catch {
      unwindProven = false;
    }
    // A poisoned runtime close or a factory whose own unwind could not prove
    // closure retains the workspace lock alongside the in-process lease.
    if (unwindProven && !isApplicationRuntimeLeaseRetained(error)) {
      await workspaceLock?.release().catch(() => undefined);
    }
    throw error;
  }
}

/** Read-only helper for tests and desktop guard assertions. */
export function isLoopbackDesktopHost(host: string): boolean {
  return host === "127.0.0.1";
}
