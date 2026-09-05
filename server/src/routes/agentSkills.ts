import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { storageRuntime } from "../storageRuntime.js";
import { SqliteConstraintError } from "../db/types.js";
import { AGENT_TOOLS } from "../agentConfiguration.js";
import { idParamsSchema } from "./schemas.js";
import { LONG_TEXT_JSON_BODY_LIMIT_BYTES, BODYLESS_MUTATION_LIMIT_BYTES } from "./bodyLimits.js";

const bodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "content"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80, pattern: "\\S" },
    description: { type: "string", maxLength: 240 },
    content: { type: "string", minLength: 1, maxLength: 8000, pattern: "\\S" },
  },
} as const;

export async function agentSkillRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/agent-capabilities", { onRequest: requireAuth }, async () => ({ tools: AGENT_TOOLS }));
  app.get("/api/agent-skills", { onRequest: requireAuth }, async (req) => ({
    items: (
      await storageRuntime().ledger.all<{
        id: string;
        name: string;
        description: string;
        content: string;
        version: bigint;
      }>("SELECT id,name,description,content,version FROM agent_skills WHERE account_id=? ORDER BY name,id LIMIT 201", [
        getAccountId(req),
      ])
    ).map((skill) => ({ ...skill, version: Number(skill.version) })),
  }));
  for (const method of ["POST", "PUT"] as const) {
    app.route({
      method,
      url: method === "POST" ? "/api/agent-skills" : "/api/agent-skills/:id",
      onRequest: requireAuth,
      bodyLimit: LONG_TEXT_JSON_BODY_LIMIT_BYTES,
      schema: { body: bodySchema, ...(method === "PUT" ? { params: idParamsSchema } : {}) },
      handler: async (req, reply) => {
        const accountId = getAccountId(req);
        const body = req.body as { name: string; description?: string; content: string };
        const id = method === "POST" ? randomUUID() : (req.params as { id: string }).id;
        const timestamp = new Date().toISOString();
        try {
          const result = await storageRuntime().ledger.withImmediateTransaction((transaction) => {
            const existing =
              method === "PUT"
                ? transaction.get<{ version: bigint }>("SELECT version FROM agent_skills WHERE id=? AND account_id=?", [
                    id,
                    accountId,
                  ])
                : null;
            if (method === "PUT" && !existing) return null;
            if (
              method === "POST" &&
              (transaction.get<{ count: number }>("SELECT count(*) AS count FROM agent_skills WHERE account_id=?", [
                accountId,
              ])?.count ?? 0) >= 200
            )
              return "limit";
            const version = Number(existing?.version ?? 0) + 1;
            if (method === "POST")
              transaction.run(
                "INSERT INTO agent_skills (id,account_id,name,description,content,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                [id, accountId, body.name.trim(), body.description ?? "", body.content, version, timestamp, timestamp]
              );
            else
              transaction.run(
                "UPDATE agent_skills SET name=?,description=?,content=?,version=?,updated_at=? WHERE id=? AND account_id=?",
                [body.name.trim(), body.description ?? "", body.content, version, timestamp, id, accountId]
              );
            transaction.run(
              "INSERT INTO agent_skill_revisions (skill_id,version,content,created_at) VALUES (?,?,?,?)",
              [id, version, body.content, timestamp]
            );
            return { id, name: body.name.trim(), description: body.description ?? "", content: body.content, version };
          });
          if (result === null) return reply.code(404).send({ error: "Skill not found." });
          if (result === "limit")
            return reply
              .code(400)
              .send({ error: "Your skill library is full (200 skills). Remove a skill before adding another." });
          return reply.code(method === "POST" ? 201 : 200).send(result);
        } catch (error) {
          if (error instanceof SqliteConstraintError && error.kind === "unique")
            return reply.code(409).send({ error: "A skill with this name already exists." });
          throw error;
        }
      },
    });
  }
  app.delete(
    "/api/agent-skills/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const result = await storageRuntime().ledger.run("DELETE FROM agent_skills WHERE id=? AND account_id=?", [
        (req.params as { id: string }).id,
        getAccountId(req),
      ]);
      return result.changes ? { ok: true } : reply.code(404).send({ error: "Skill not found." });
    }
  );
}
