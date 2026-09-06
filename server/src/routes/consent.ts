import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { acknowledgeRemoteEgress, remoteEgressState } from "../egressPolicy.js";
import { recordEgressEvent } from "../egressAudit.js";
import { BODYLESS_MUTATION_LIMIT_BYTES } from "./bodyLimits.js";

export async function consentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/consent/remote-egress",
    {
      onRequest: requireAuth,
      schema: { tags: ["consent"], summary: "Remote model-provider egress consent state" },
    },
    async (req, reply) => reply.send(await remoteEgressState(getAccountId(req)))
  );

  app.post(
    "/api/consent/remote-egress",
    {
      onRequest: requireAuth,
      bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES,
      schema: { tags: ["consent"], summary: "Acknowledge remote model-provider egress" },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      // The result names only the host this call actually persisted; a local/
      // private POST neither rewrites the remembered pair nor emits an event.
      const { state, auditHost } = await acknowledgeRemoteEgress(accountId);
      if (auditHost !== null) await recordEgressEvent("consent_acknowledged", accountId, auditHost);
      return reply.send(state);
    }
  );
}
