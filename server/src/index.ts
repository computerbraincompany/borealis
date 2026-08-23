import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { restoreDatasets } from "./ingest.js";
import { authRoutes } from "./auth.js";
import { routes } from "./routes.js";

async function main() {
  await initDb();
  await restoreDatasets().catch((e) => console.warn("dataset restore skipped", String(e)));
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  await app.register(cors, { origin: true, credentials: true });
  app.get("/health", async () => ({ status: "ok" }));
  await authRoutes(app);
  await routes(app);
  await app.listen({ port: config.port, host: config.host });
  console.log(`Borealis server listening on ${config.host}:${config.port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
