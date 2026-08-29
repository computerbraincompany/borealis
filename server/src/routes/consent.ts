import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { acknowledgeRemoteEgress, remoteEgressState } from "../egressPolicy.js";
import { recordEgressEvent } from "../egressAudit.js";

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
    async (req, reply) => {
      const accountId = getAccountId(req);
      const state = await acknowledgeRemoteEgress(accountId);
      await recordEgressEvent("consent_acknowledged", accountId, state.endpoint_host);
      return reply.send(state);
    }
  );
}
