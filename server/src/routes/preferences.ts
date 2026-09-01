import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { storageRuntime } from "../storageRuntime.js";
import { PREFERENCE_JSON_BODY_LIMIT_BYTES } from "./bodyLimits.js";
import { preferencesBodySchema } from "./schemas.js";

export async function preferencesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/preferences",
    { onRequest: requireAuth, schema: { tags: ["preferences"], summary: "Read personal account defaults" } },
    async (req, reply) => {
      const defaultChatModel = await storageRuntime().chats.getDefaultChatModel(getAccountId(req));
      return reply.send({ default_chat_model: defaultChatModel });
    }
  );

  app.patch(
    "/api/preferences",
    {
      onRequest: requireAuth,
      bodyLimit: PREFERENCE_JSON_BODY_LIMIT_BYTES,
      schema: {
        tags: ["preferences"],
        summary: "Update the personal default chat model",
        body: preferencesBodySchema,
      },
    },
    async (req, reply) => {
      const body = req.body as { default_chat_model: string | null };
      const defaultChatModel = await storageRuntime().chats.setDefaultChatModel(
        getAccountId(req),
        body.default_chat_model
      );
      return reply.send({ default_chat_model: defaultChatModel });
    }
  );
}
