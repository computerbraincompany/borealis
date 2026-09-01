import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import { idParamsSchema } from "./schemas.js";
import { AutomationValidationError, type Automation } from "../automationStore.js";
import { storageRuntime } from "../storageRuntime.js";
import { automationRunner } from "../automationRuntime.js";
import {
  BODYLESS_MUTATION_LIMIT_BYTES,
  COMPACT_JSON_BODY_LIMIT_BYTES,
  LONG_TEXT_JSON_BODY_LIMIT_BYTES,
} from "./bodyLimits.js";

function sendAutomationError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof AutomationValidationError) {
    reply.code(400).send({ error: error.message });
    return true;
  }
  return false;
}

function publicAutomation(automation: Automation) {
  return {
    id: automation.id,
    name: automation.name,
    kind: automation.kind,
    target_id: automation.target_id,
    prompt: automation.prompt,
    schedule_minutes: automation.schedule_minutes,
    state: automation.state,
    consecutive_failures: automation.consecutive_failures,
    last_run_at: automation.last_run_at,
    next_run_at: automation.next_run_at,
    created_at: automation.created_at,
    updated_at: automation.updated_at,
  };
}

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/automations",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const page = await storageRuntime().automations.list(
        getAccountId(req),
        parseCatalogPageQuery("automations", req.query)
      );
      return reply.send(catalogResponse("automations", { items: page.items.map(publicAutomation), next: page.next }));
    }
  );

  app.post(
    "/api/automations",
    {
      onRequest: requireAuth,
      bodyLimit: LONG_TEXT_JSON_BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: "object",
          required: ["name", "kind", "target_id", "schedule_minutes"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            kind: { type: "string", enum: ["connector_sync", "agent_turn"] },
            target_id: {
              type: "string",
              pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            },
            prompt: { type: "string", minLength: 1, maxLength: 8_000 },
            schedule_minutes: { type: "integer", minimum: 15, maximum: 10_080 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          name: string;
          kind: string;
          target_id: string;
          prompt?: string;
          schedule_minutes: number;
        };
        const automation = await storageRuntime().automations.create({
          accountId: getAccountId(req),
          name: body.name,
          kind: body.kind,
          targetId: body.target_id,
          prompt: body.prompt,
          scheduleMinutes: body.schedule_minutes,
        });
        return reply.code(201).send(publicAutomation(automation));
      } catch (error) {
        if (sendAutomationError(reply, error)) return;
        throw error;
      }
    }
  );

  app.patch(
    "/api/automations/:id",
    {
      onRequest: requireAuth,
      bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            state: { type: "string", enum: ["active", "paused"] },
            schedule_minutes: { type: "integer", minimum: 15, maximum: 10_080 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as { name?: string; state?: string; schedule_minutes?: number };
        const automation = await storageRuntime().automations.update(getAccountId(req), (req.params as any).id, {
          name: body.name,
          state: body.state,
          scheduleMinutes: body.schedule_minutes,
        });
        if (!automation) return reply.code(404).send({ error: "automation not found" });
        return reply.send(publicAutomation(automation));
      } catch (error) {
        if (sendAutomationError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/automations/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const deleted = await storageRuntime().automations.delete(getAccountId(req), (req.params as any).id);
      if (!deleted) return reply.code(404).send({ error: "automation not found" });
      return reply.send({ ok: true });
    }
  );

  app.get(
    "/api/automations/:id/runs",
    {
      onRequest: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        },
      },
    },
    async (req, reply) => {
      const query = (req.query as { limit?: unknown }) ?? {};
      const limit = typeof query.limit === "number" ? query.limit : 20;
      return reply.send(await storageRuntime().automations.listRuns(getAccountId(req), (req.params as any).id, limit));
    }
  );

  // The scheduler runs while the server does; the route exists so operators can
  // verify it is alive from the same surface as everything else.
  app.get("/api/automations/_scheduler", { onRequest: requireAuth }, async (_req, reply) => {
    return reply.send({ running: automationRunner().isRunning() });
  });
}
