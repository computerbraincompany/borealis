import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { listEgressEvents } from "../egressAudit.js";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/audit/egress",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["audit"],
        summary: "Content-free remote-egress audit for this account",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
        },
      },
    },
    async (req, reply) => {
      const query = (req.query as { limit?: unknown }) ?? {};
      const limit = typeof query.limit === "number" ? query.limit : 50;
      return reply.send(await listEgressEvents(getAccountId(req), limit));
    }
  );
}
