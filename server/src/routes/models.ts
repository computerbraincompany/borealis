import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { discoverChatModels } from "../llm.js";

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
      const result = await discoverChatModels({ refresh });
      return reply.send({ models: result.models, default_model: config.chatModel, discovery: result.discovery });
    }
  );
}
