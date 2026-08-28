import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { acknowledgeRemoteEgress, remoteEgressState } from "../egressPolicy.js";

export async function consentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/consent/remote-egress",
    {
      preHandler: requireAuth,
      schema: { tags: ["consent"], summary: "Remote model-provider egress consent state" },
    },
    async (req, reply) => reply.send(await remoteEgressState(getAccountId(req)))
  );

  app.post(
    "/api/consent/remote-egress",
    {
      preHandler: requireAuth,
      schema: { tags: ["consent"], summary: "Acknowledge remote model-provider egress" },
    },
    async (req, reply) => reply.send(await acknowledgeRemoteEgress(getAccountId(req)))
  );
}
