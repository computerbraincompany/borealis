import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { checkSystemHealth } from "../systemHealth.js";
import { createWorkspaceStatus, type WorkspaceStatus } from "../workspaceStatus.js";
import { engineManager } from "../contained/runtime.js";

export interface SystemRouteOptions {
  /** Test seam; production uses the module-level cached status. */
  readonly workspaceStatus?: () => Promise<WorkspaceStatus>;
}

// The cache lives for the process so the chrome can poll cheaply. The snapshot
// never contains the endpoint URL, credentials, provider errors, or model lists.
const cachedWorkspaceStatus = createWorkspaceStatus({ contained: () => engineManager.snapshot() });

export async function systemRoutes(app: FastifyInstance, options: SystemRouteOptions = {}): Promise<void> {
  const workspaceStatus = options.workspaceStatus ?? cachedWorkspaceStatus;

  app.get(
    "/api/health",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["health"],
        summary: "Check application dependency readiness",
      },
    },
    async (_req, reply) => reply.send(await checkSystemHealth())
  );

  app.get(
    "/api/status",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["health"],
        summary: "Ambient provider locality, model presence, and reachability",
      },
    },
    async () => await workspaceStatus()
  );
}
