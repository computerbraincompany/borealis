import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { listEgressEvents } from "../egressAudit.js";
import { storageRuntime } from "../storageRuntime.js";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // The local trust boundary: sibling accounts of this same Borealis instance.
  app.get(
    "/api/accounts",
    {
      onRequest: requireAuth,
      schema: { tags: ["audit"], summary: "Workspace accounts available for snapshot sharing" },
    },
    async (req, reply) => {
      const rows = await storageRuntime().ledger.all<{ id?: unknown; email?: unknown }>(
        "SELECT id,email FROM users ORDER BY created_at ASC,email ASC"
      );
      return reply.send(rows.map((row) => ({ id: String(row.id), email: String(row.email) })));
    }
  );

  app.get(
    "/api/audit/egress",
    {
      onRequest: requireAuth,
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
