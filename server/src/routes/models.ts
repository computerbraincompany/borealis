import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { discoverChatModels } from "../llm.js";
import { getRuntimeSettings } from "../runtimeSettings.js";
import { storageRuntime } from "../storageRuntime.js";

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/models",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["models"],
        summary: "List available chat models",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { refresh: { type: "string", enum: ["0", "1"] } },
        },
      },
    },
    async (req, reply) => {
      const refresh = (req.query as { refresh?: unknown }).refresh === "1";
      const [result, runtime, accountDefaultModel] = await Promise.all([
        discoverChatModels({ refresh }),
        getRuntimeSettings(),
        storageRuntime().chats.getDefaultChatModel(getAccountId(req)),
      ]);
      return reply.send({
        models: result.models,
        default_model: runtime.settings.chatModel,
        account_default_model: accountDefaultModel,
        discovery: result.discovery,
      });
    }
  );
}
