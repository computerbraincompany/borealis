import fsPromises from "node:fs/promises";
import path from "node:path";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { setAppLogger } from "./appLogger.js";
import { shutdownActiveRuns, recoverInterruptedRuns } from "./chatRuns.js";
import { config } from "./config.js";
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

const MAX_BODY_BYTES = 20 * 1024 * 1024;

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
      if (path.extname(filename) === ".html") response.header("Cache-Control", "no-store");
      else if (filename.startsWith(path.join(root, "assets") + path.sep)) {
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
    return reply.header("Cache-Control", "no-store").sendFile("index.html");
  }
  const requestId = String(reply.getHeader("X-Request-ID") || request.id);
  return reply.code(404).send({ error: "not found", request_id: requestId });
}

/** Compose the API and optional same-origin production UI without opening a socket. */
export async function buildBorealisApp(options: BuildBorealisAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: MAX_BODY_BYTES });
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

async function closeHttpAfterDrainingRuns(app: FastifyInstance): Promise<void> {
  let httpClosed = false;
  const httpClose = app
    .close()
    .catch(() => {})
    .finally(() => {
      httpClosed = true;
    });
  // A request accepted just before close() can reach beginRun after the first
  // registry snapshot. Keep draining until Fastify proves every request ended.
  do {
    await shutdownActiveRuns().catch(() => {});
    if (!httpClosed) {
      await Promise.race([httpClose, new Promise<void>((resolve) => setTimeout(resolve, 25))]);
    }
  } while (!httpClosed);
  await httpClose;
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
  try {
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
        await closeHttpAfterDrainingRuns(activeApp);
        await stopIngestionWorkers().catch(() => {});
        if (automationSchedulerStarted) {
          automationRunner().stop();
          automationSchedulerStarted = false;
        }
        await startupReconciliation;
        await shutdownDatasetWorker().catch(() => {});
        try {
          await closeDb();
        } finally {
          closeRuntimeSettings();
        }
      })();
      return closePromise;
    };
    return Object.freeze({ app: activeApp, host, port: actualPort, ...(bootstrap ? { bootstrap } : {}), close });
  } catch (error) {
    await app?.close().catch(() => {});
    if (workersStarted) await stopIngestionWorkers().catch(() => {});
    await shutdownDatasetWorker().catch(() => {});
    if (databaseStarted) await closeDb().catch(() => {});
    if (settingsStarted) closeRuntimeSettings();
    throw error;
  }
}

/** Read-only helper for tests and desktop guard assertions. */
export function isLoopbackDesktopHost(host: string): boolean {
  return host === "127.0.0.1";
}
