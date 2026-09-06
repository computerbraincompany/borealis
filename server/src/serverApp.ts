import fsPromises from "node:fs/promises";
import path from "node:path";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { setAppLogger } from "./appLogger.js";
import { shutdownActiveRuns, recoverInterruptedRuns } from "./chatRuns.js";
import { config, initializeConfigStorage } from "./config.js";
import { shutdownDatasetWorker } from "./data/datasets.js";
import { closeDb, initDb } from "./db.js";
import { automationRunner } from "./automationRuntime.js";
import { createDesktopBootstrapSession, type DesktopBootstrapSession } from "./desktopBootstrap.js";
import { corsOrigin } from "./corsPolicy.js";
import { installHttpBoundary } from "./httpErrors.js";
import { restoreDatasets, startIngestionWorkers, stopIngestionWorkers } from "./ingest.js";
import { runWithRequestContext } from "./requestContext.js";
import { routes } from "./routes.js";
import { closeRuntimeSettings, initializeRuntimeSettings } from "./runtimeSettings.js";
import { DEFAULT_BODY_LIMIT_BYTES } from "./routes/bodyLimits.js";
import { acquireWorkspaceLock, type WorkspaceLock } from "./workspaceLock.js";

export interface BuildBorealisAppOptions {
  readonly logger?: boolean;
  readonly staticWebDir?: string;
}

export interface StartBorealisServerOptions extends BuildBorealisAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly desktop?: boolean;
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
  await routes(app);
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
 * Synchronously quiesces the automation scheduler and returns its retained
 * drain promise, or an already-settled promise when the scheduler never
 * started. Quiescing stops new claim dispatch before HTTP draining begins;
 * the drain awaits bounded in-flight connector/agent executor work.
 */
function quiesceAutomationScheduler(started: boolean): Promise<void> {
  if (!started) return Promise.resolve();
  return Promise.resolve(automationRunner().stop()).catch(() => {});
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
 */
async function drainIngressAndCancelRuns(
  app: FastifyInstance | undefined,
  schedulerDrain: Promise<void>
): Promise<void> {
  let httpClosed = app === undefined;
  const httpClose = app
    ? app
        .close()
        .catch(() => {})
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
    await shutdownActiveRuns().catch(() => {});
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
  await shutdownActiveRuns().catch(() => {});
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

  let app: FastifyInstance | undefined;
  let workersStarted = false;
  let databaseStarted = false;
  let settingsStarted = false;
  let automationSchedulerStarted = false;
  let workspaceLock: WorkspaceLock | undefined;
  try {
    workspaceLock = await acquireWorkspaceLock(config.storageDir);
    initializeConfigStorage();
    await initializeRuntimeSettings();
    settingsStarted = true;
    await initDb();
    databaseStarted = true;
    app = await buildBorealisApp({ logger: options.logger, staticWebDir });
    const interruptedRuns = await recoverInterruptedRuns();
    if (interruptedRuns) app.log.warn({ interrupted_runs: interruptedRuns }, "recovered interrupted chat runs");
    await startIngestionWorkers();
    workersStarted = true;
    automationRunner().start();
    automationSchedulerStarted = true;
    const bootstrap = desktop ? await createDesktopBootstrapSession() : undefined;
    await app.listen({ port, host });
    const actualPort = listeningPort(app);
    const activeApp = app;
    app.log.info({ host, port: actualPort }, "Borealis server listening");
    const startupReconciliation = runWithRequestContext("dataset-reconciliation.startup", () => restoreDatasets())
      .then((summary) => app?.log.info({ ...summary }, "dataset registry reconciliation finished"))
      .catch(() => app?.log.warn("dataset registry reconciliation failed"));

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        // Quiesce the scheduler the moment close begins — before HTTP
        // draining — so new claim dispatch stops first, then cancel actively
        // while both ingress sources drain and close storage only after the
        // scheduler drain and the final cancellation snapshot settle.
        const schedulerDrain = quiesceAutomationScheduler(automationSchedulerStarted);
        automationSchedulerStarted = false;
        await drainIngressAndCancelRuns(activeApp, schedulerDrain);
        await stopIngestionWorkers().catch(() => {});
        await startupReconciliation;
        await shutdownDatasetWorker().catch(() => {});
        try {
          await closeDb();
        } finally {
          closeRuntimeSettings();
          await workspaceLock?.release();
          workspaceLock = undefined;
        }
      })();
      return closePromise;
    };
    return Object.freeze({ app: activeApp, host, port: actualPort, ...(bootstrap ? { bootstrap } : {}), close });
  } catch (error) {
    // A later listen/bootstrap failure can strand the scheduler started
    // before it. Quiesce it first, then apply the same continuous
    // cancellation/drain to the partially built HTTP app and scheduler: an
    // interval-fired agent turn may cross acceptChatTurn/beginRun after
    // cleanup begins, so a one-shot shutdownActiveRuns is not sufficient.
    const schedulerDrain = quiesceAutomationScheduler(automationSchedulerStarted);
    automationSchedulerStarted = false;
    await drainIngressAndCancelRuns(app, schedulerDrain);
    if (workersStarted) await stopIngestionWorkers().catch(() => {});
    await shutdownDatasetWorker().catch(() => {});
    try {
      if (databaseStarted) await closeDb().catch(() => {});
      if (settingsStarted) closeRuntimeSettings();
    } finally {
      await workspaceLock?.release();
      workspaceLock = undefined;
    }
    throw error;
  }
}

/** Read-only helper for tests and desktop guard assertions. */
export function isLoopbackDesktopHost(host: string): boolean {
  return host === "127.0.0.1";
}
