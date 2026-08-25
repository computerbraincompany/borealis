import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { checkSystemHealth } from "../systemHealth.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
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
}
