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
import { automationRoutes, type AutomationSchedulerStatus } from "./routes/automations.js";
import { containedRoutes } from "./routes/contained.js";
import { consentRoutes } from "./routes/consent.js";
import { connectionRoutes } from "./routes/connections.js";
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
export type { AutomationSchedulerStatus } from "./routes/automations.js";

/**
 * Fail-closed constant scheduler status used only when composition supplies
 * no owned runner (isolated static-host/test apps). It is a plain constant,
 * never a module-global accessor: production `startBorealisServer` always
 * injects the owned runtime's runner, and direct route/unit composition may
 * pass an explicit stopped test status.
 */
const STOPPED_AUTOMATION_SCHEDULER: AutomationSchedulerStatus = { isRunning: () => false };

export interface RoutesOptions {
  /**
   * Trusted server-composition mode from `buildBorealisApp`; the default is
   * fail-closed browser mode, where no token may control contained-engine
   * host processes.
   */
  readonly desktop?: boolean;
  /**
   * The owned application runtime's scheduler status for this server instance.
   * Omitted composition receives the explicit stopped capability above.
   */
  readonly automationScheduler?: AutomationSchedulerStatus;
}

/** Compose resource plugins while keeping shared HTTP policy in one place. */
export async function routes(app: FastifyInstance, options: RoutesOptions = {}): Promise<void> {
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
  await app.register(automationRoutes, {
    automationScheduler: options.automationScheduler ?? STOPPED_AUTOMATION_SCHEDULER,
  });
  await app.register(chatRoutes);
  await app.register(sourceRoutes);
  await app.register(libraryRoutes);
  await app.register(agentRoutes);
  await app.register(agentSkillRoutes);
  await app.register(containedRoutes, { desktop: options.desktop ?? false });
  await app.register(connectionRoutes);
  await app.register(connectorRoutes);
  await app.register(reportRoutes);
  await app.register(chartRoutes);
  app.get("/api/openapi.json", { onRequest: requireAuth, schema: { hide: true } }, async (_req, reply) =>
    reply.send(app.swagger())
  );
}
