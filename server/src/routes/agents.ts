import {
  AGENT_ICONS,
  AGENT_COLORS,
  AGENT_TOOLS,
  AgentConfigurationError,
  type AgentConfiguration,
} from "../agentConfiguration.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import {
  AgentNotFoundError,
  DuplicateAgentError,
  MAX_AGENT_INSTRUCTION_CHARS,
  MAX_AGENT_NAME_CHARS,
} from "../db/stores/agentStore.js";
import { storageRuntime } from "../storageRuntime.js";
import { idParamsSchema } from "./schemas.js";
import { BODYLESS_MUTATION_LIMIT_BYTES, LONG_TEXT_JSON_BODY_LIMIT_BYTES } from "./bodyLimits.js";

// Connected-tool selections and job setup live beside the legacy `tools`
// array (which keeps its built-in-only meaning for old clients). Cross-row
// validation — connection exists/enabled, tool published, schema supported,
// write policy — runs in the agent store transaction; these schemas enforce
// the structural budgets. `mcp_tool_binding` and `job_setup` shapes mirror
// the codec in `agentConfiguration.ts` exactly.
const mcpToolBindingSchema = {
  type: "object",
  required: ["connection_id", "tool_id", "discovery_revision"],
  additionalProperties: false,
  properties: {
    connection_id: { type: "string", format: "uuid" },
    tool_id: { type: "string", format: "uuid" },
    discovery_revision: { type: "integer", minimum: 1, maximum: 1_000_000 },
    allow_write: { type: "boolean" },
  },
} as const;

const jobSetupSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    starter_prompts: {
      type: "array",
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
    output_template: {
      // Discriminated reference: only the bounded instruction variant ships;
      // M13's document-template catalog adds its variant to this codec.
      oneOf: [
        { type: "null" },
        {
          type: "object",
          required: ["kind", "instruction"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", const: "instruction" },
            instruction: { type: "string", minLength: 1, maxLength: 8_000 },
          },
        },
      ],
    },
    library_ids: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string", format: "uuid" } },
  },
} as const;

const agentBodySchema = {
  type: "object",
  required: ["name", "instructions"],
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 240 },
    icon: { type: "string", enum: AGENT_ICONS },
    color: { type: "string", enum: AGENT_COLORS },
    tools: { type: "array", maxItems: 7, uniqueItems: true, items: { type: "string", enum: AGENT_TOOLS } },
    skill_ids: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", format: "uuid" } },
    mcp_tools: { type: "array", maxItems: 16, items: mcpToolBindingSchema },
    job_setup: jobSetupSchema,
    name: { type: "string", minLength: 1, maxLength: MAX_AGENT_NAME_CHARS, pattern: "\\S" },
    instructions: { type: "string", minLength: 1, maxLength: MAX_AGENT_INSTRUCTION_CHARS },
  },
} as const;

const agentPatchSchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    description: { type: "string", maxLength: 240 },
    icon: { type: "string", enum: AGENT_ICONS },
    color: { type: "string", enum: AGENT_COLORS },
    tools: { type: "array", maxItems: 7, uniqueItems: true, items: { type: "string", enum: AGENT_TOOLS } },
    skill_ids: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", format: "uuid" } },
    mcp_tools: { type: "array", maxItems: 16, items: mcpToolBindingSchema },
    job_setup: jobSetupSchema,
    name: { type: "string", minLength: 1, maxLength: MAX_AGENT_NAME_CHARS, pattern: "\\S" },
    instructions: { type: "string", minLength: 1, maxLength: MAX_AGENT_INSTRUCTION_CHARS },
  },
} as const;

function sendAgentError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof AgentConfigurationError) {
    reply.code(400).send({ error: error.message, code: "AGENT_CONFIGURATION_INVALID" });
    return true;
  }
  if (error instanceof DuplicateAgentError) {
    reply.code(409).send({ error: "an agent with this name already exists" });
    return true;
  }
  if (error instanceof AgentNotFoundError) {
    reply.code(404).send({ error: "agent not found" });
    return true;
  }
  return false;
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/agents",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const page = await storageRuntime().agents.listAgents(
        getAccountId(req),
        parseCatalogPageQuery("agents", req.query)
      );
      return reply.send(catalogResponse("agents", page));
    }
  );

  app.post(
    "/api/agents",
    { onRequest: requireAuth, bodyLimit: LONG_TEXT_JSON_BODY_LIMIT_BYTES, schema: { body: agentBodySchema } },
    async (req, reply) => {
      try {
        const body = req.body as { name: string; instructions: string } & Partial<AgentConfiguration>;
        const agent = await storageRuntime().agents.createAgent(getAccountId(req), body.name, body.instructions, body);
        return reply.code(201).send(agent);
      } catch (error) {
        if (sendAgentError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get("/api/agents/:id", { onRequest: requireAuth, schema: { params: idParamsSchema } }, async (req, reply) => {
    const agent = await storageRuntime().agents.getAgentDetail(getAccountId(req), (req.params as any).id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    return reply.send(agent);
  });

  app.patch(
    "/api/agents/:id",
    {
      onRequest: requireAuth,
      bodyLimit: LONG_TEXT_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: agentPatchSchema },
    },
    async (req, reply) => {
      const accountId = getAccountId(req);
      const agentId = (req.params as any).id;
      const body = req.body as { name?: string; instructions?: string } & Partial<AgentConfiguration>;
      try {
        const agent = await storageRuntime().agents.updateAgent(accountId, agentId, body);
        if (!agent) return reply.code(404).send({ error: "agent not found" });
        return reply.send(agent);
      } catch (error) {
        if (sendAgentError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/agents/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const deleted = await storageRuntime().agents.deleteAgent(getAccountId(req), (req.params as any).id);
      if (!deleted) return reply.code(404).send({ error: "agent not found" });
      return reply.send({ ok: true });
    }
  );
}
