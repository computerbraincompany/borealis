import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { restoreDatasets, startIngestionWorkers } from "./ingest.js";
import { routes } from "./routes.js";
import { recoverInterruptedRuns } from "./chatRuns.js";
import { setAppLogger } from "./appLogger.js";
import { runWithRequestContext } from "./requestContext.js";
import { corsOrigin } from "./corsPolicy.js";
import { installHttpBoundary } from "./httpErrors.js";

async function main() {
  await initDb();
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  setAppLogger(app.log);
  installHttpBoundary(app);
  await app.register(cors, { origin: corsOrigin, credentials: true });
  await routes(app);
  const interruptedRuns = await recoverInterruptedRuns();
  if (interruptedRuns) app.log.warn({ interrupted_runs: interruptedRuns }, "recovered interrupted chat runs");
  // Reset/claim persisted ingestion leases before accepting uploads; doing
  // this after listen could reset a fresh job started in the startup window.
  await startIngestionWorkers();
  // Recovery must complete before the listening socket is published; otherwise
  // a newly accepted run could be mistaken for work interrupted by this boot.
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ host: config.host, port: config.port }, "Borealis server listening");
  void runWithRequestContext("dataset-reconciliation.startup", () => restoreDatasets())
    .then((summary) => app.log.info({ ...summary }, "dataset registry reconciliation finished"))
    .catch(() => app.log.warn("dataset registry reconciliation failed"));
}

main().catch(() => {
  // Startup failures are intentionally generic: configuration and database
  // errors can contain credentials or local paths.
  process.stderr.write("Borealis server failed to start.\n");
  process.exit(1);
});
