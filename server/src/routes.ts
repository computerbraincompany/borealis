import { agentSkillRoutes } from "./routes/agentSkills.js";
import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import { authRoutes, requireAuth, installAccountSessionValidation } from "./auth.js";
import { config } from "./config.js";
import { installHttpBoundary } from "./httpErrors.js";
import { chartRoutes } from "./routes/charts.js";
import { chatRoutes } from "./routes/chats.js";
import { agentRoutes } from "./routes/agents.js";
import { auditRoutes } from "./routes/audit.js";
import { automationRoutes } from "./routes/automations.js";
import { containedRoutes } from "./routes/contained.js";
import { consentRoutes } from "./routes/consent.js";
import { connectorRoutes } from "./routes/connectors.js";
import { embeddingMigrationRoutes } from "./routes/embeddingMigration.js";
import { libraryRoutes } from "./routes/libraries.js";
import { modelRoutes } from "./routes/models.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { reportRoutes } from "./routes/reports.js";
import { settingsRoutes } from "./routes/settings.js";
import { sourceRoutes } from "./routes/sources.js";
import { systemRoutes } from "./routes/system.js";

export { publicAgentFailureMessage } from "./routes/chats.js";

/** Compose resource plugins while keeping shared HTTP policy in one place. */
export async function routes(app: FastifyInstance): Promise<void> {
  installHttpBoundary(app);
  installAccountSessionValidation(app);
  await app.register(swagger, {
    openapi: {
      info: { title: "Borealis API", version: "0.1.0" },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
      security: [{ bearerAuth: [] }],
    },
  });
  app.get("/health", { schema: { tags: ["health"], summary: "Server health", security: [] } }, async () => ({
    status: "ok",
  }));
  await authRoutes(app);
  await app.register(import("@fastify/multipart"), {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 },
  });

  await app.register(modelRoutes);
  await app.register(embeddingMigrationRoutes);
  await app.register(settingsRoutes);
  await app.register(preferencesRoutes);
  await app.register(systemRoutes);
  await app.register(consentRoutes);
  await app.register(auditRoutes);
  await app.register(automationRoutes);
  await app.register(chatRoutes);
  await app.register(sourceRoutes);
  await app.register(libraryRoutes);
  await app.register(agentRoutes);
  await app.register(agentSkillRoutes);
  await app.register(containedRoutes);
  await app.register(connectorRoutes);
  await app.register(reportRoutes);
  await app.register(chartRoutes);
  app.get("/api/openapi.json", { onRequest: requireAuth, schema: { hide: true } }, async (_req, reply) =>
    reply.send(app.swagger())
  );
}
