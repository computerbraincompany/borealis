import type { FastifyInstance, FastifyReply } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { catalogPageQuerySchema, catalogResponse, parseCatalogPageQuery } from "../catalogPagination.js";
import { connectionService, type ConnectionCreateInput, type ConnectionUpdateInput } from "../connections/service.js";
import { BODYLESS_MUTATION_LIMIT_BYTES, CONNECTION_JSON_BODY_LIMIT_BYTES } from "./bodyLimits.js";
import { MAX_CONNECTION_NAME_CHARS } from "../connections/store.js";
import { MAX_SECRET_VALUE_CHARS } from "../connections/secrets.js";
import { idParamsSchema } from "./schemas.js";

/**
 * Connection management routes (schema v17, Connected agents stage 1).
 *
 * Public failures are always a stable `CONNECTION_*` code with a fixed
 * generic message; provider detail, credentials, and endpoint errors never
 * reach the client. Test/discover are bounded at the service's fixed 15-second
 * deadline, and neither ever issues a content-bearing tool call. DTOs are
 * assembled by the service and carry `credential_state` but never credential
 * material.
 */

const CONNECTION_PUBLIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  CONNECTION_NOT_FOUND: "connection not found",
  CONNECTION_NAME_TAKEN: "a connection with this name already exists",
  CONNECTION_CONFIG_INVALID: "connection configuration is invalid",
  CONNECTION_REVISION_CONFLICT: "the connection changed since it was loaded",
  CONNECTION_LIMIT_REACHED: "the connection limit for this account is reached",
  CONNECTION_INVALID_STATE: "the connection is in an invalid state",
  CONNECTION_DISABLED: "the connection is disabled",
  CONNECTION_CUSTODY_UNAVAILABLE: "stored connection credentials are unavailable",
  CONNECTION_TRANSPORT_UNAVAILABLE: "the connection transport is unavailable",
  CONNECTION_AUTH_REQUIRED: "the connection requires sign-in",
  CONNECTION_AUTH_UNSUPPORTED: "connection sign-in is not available for this connection",
  CONNECTION_TIMEOUT: "the connection operation timed out",
  CONNECTION_HANDSHAKE_FAILED: "the connection handshake failed",
  CONNECTION_DISCOVERY_OVER_LIMIT: "the discovered tool catalog exceeds the supported limits",
  CONNECTION_DISCOVERY_INVALID: "the discovered tool catalog is invalid",
});

function sendConnectionError(reply: FastifyReply, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof code !== "string" || !code.startsWith("CONNECTION_")) return false;
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode > 599) return false;
  reply.code(statusCode).send({ error: CONNECTION_PUBLIC_MESSAGES[code] ?? "connection request failed", code });
  return true;
}

const credentialsBodySchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    headers: {
      type: "object",
      maxProperties: 8,
      propertyNames: { type: "string", pattern: "^[!#$%&'*+\\-.^_`|~0-9A-Za-z]{1,128}$" },
      additionalProperties: { type: "string", minLength: 1, maxLength: MAX_SECRET_VALUE_CHARS },
    },
    env: {
      type: "object",
      maxProperties: 16,
      propertyNames: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" },
      additionalProperties: { type: "string", minLength: 1, maxLength: MAX_SECRET_VALUE_CHARS },
    },
  },
} as const;

const connectionCreateBodySchema = {
  type: "object",
  required: ["name", "kind", "config"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_CONNECTION_NAME_CHARS, pattern: "\\S" },
    kind: { type: "string", enum: ["mcp_http", "mcp_stdio"] },
    enabled: { type: "boolean" },
    // The strict kind-specific non-secret shape is validated at the service
    // boundary; the parser ceiling below is the durable budget.
    config: { type: "object" },
    credentials: credentialsBodySchema,
  },
} as const;

const connectionPatchBodySchema = {
  type: "object",
  required: ["expected_revision"],
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: MAX_CONNECTION_NAME_CHARS, pattern: "\\S" },
    enabled: { type: "boolean" },
    config: { type: "object" },
    // An object replaces stored credentials; null removes them explicitly.
    credentials: { oneOf: [credentialsBodySchema, { type: "null" }] },
    expected_revision: { type: "integer", minimum: 1 },
  },
} as const;

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/connections",
    { onRequest: requireAuth, schema: { querystring: catalogPageQuerySchema } },
    async (req, reply) => {
      const page = await connectionService().list(getAccountId(req), parseCatalogPageQuery("connections", req.query));
      return reply.send(catalogResponse("connections", page));
    }
  );

  app.post(
    "/api/connections",
    {
      onRequest: requireAuth,
      bodyLimit: CONNECTION_JSON_BODY_LIMIT_BYTES,
      schema: { body: connectionCreateBodySchema },
    },
    async (req, reply) => {
      try {
        const connection = await connectionService().create(getAccountId(req), req.body as ConnectionCreateInput);
        return reply.code(201).send(connection);
      } catch (error) {
        if (sendConnectionError(reply, error)) return;
        throw error;
      }
    }
  );

  app.get(
    "/api/connections/:id",
    { onRequest: requireAuth, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        return reply.send(await connectionService().get(getAccountId(req), (req.params as { id: string }).id));
      } catch (error) {
        if (sendConnectionError(reply, error)) return;
        throw error;
      }
    }
  );

  app.patch(
    "/api/connections/:id",
    {
      onRequest: requireAuth,
      bodyLimit: CONNECTION_JSON_BODY_LIMIT_BYTES,
      schema: { params: idParamsSchema, body: connectionPatchBodySchema },
    },
    async (req, reply) => {
      try {
        const connection = await connectionService().update(
          getAccountId(req),
          (req.params as { id: string }).id,
          req.body as ConnectionUpdateInput
        );
        return reply.send(connection);
      } catch (error) {
        if (sendConnectionError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/connections/:id",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        await connectionService().remove(getAccountId(req), (req.params as { id: string }).id);
        return reply.send({ ok: true });
      } catch (error) {
        if (sendConnectionError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/connections/:id/test",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        return reply.send(await connectionService().test(getAccountId(req), (req.params as { id: string }).id));
      } catch (error) {
        if (sendConnectionError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/connections/:id/discover",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        return reply.send(await connectionService().discover(getAccountId(req), (req.params as { id: string }).id));
      } catch (error) {
        if (sendConnectionError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post(
    "/api/connections/:id/authorize",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        return reply.send(await connectionService().authorize(getAccountId(req), (req.params as { id: string }).id));
      } catch (error) {
        if (sendConnectionError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete(
    "/api/connections/:id/authorization",
    { onRequest: requireAuth, bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES, schema: { params: idParamsSchema } },
    async (req, reply) => {
      try {
        return reply.send(await connectionService().revoke(getAccountId(req), (req.params as { id: string }).id));
      } catch (error) {
        if (sendConnectionError(reply, error)) return;
        throw error;
      }
    }
  );
}
