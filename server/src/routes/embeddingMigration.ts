import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { getAccountId, requireAuth } from "../auth.js";
import {
  embeddingMigrationCoordinator,
  EmbeddingMigrationError,
  type EmbeddingMigrationOperations,
} from "../embeddingMigration.js";
import { auditRemoteEgress } from "../egressAudit.js";
import { enforceRemoteEgressConsent } from "../egressPolicy.js";
import { qualifyModelPair, type ModelPairQualificationResult } from "../llm.js";
import { runtimeSettingsStore } from "../runtimeSettings.js";
import {
  SettingsEnvironmentOverrideError,
  SettingsValidationError,
  type EffectiveLlmSettings,
  type SettingsStore,
} from "../settingsStore.js";
import { COMPACT_JSON_BODY_LIMIT_BYTES, BODYLESS_MUTATION_LIMIT_BYTES } from "./bodyLimits.js";
import {
  embeddingMigrationStartBodySchema,
  embeddingMigrationStatusSchema,
  modelQualificationErrorResponseSchema,
} from "./schemas.js";

export const MODEL_PAIR_NOT_QUALIFIED_CODE = "MODEL_PAIR_NOT_QUALIFIED";

export interface EmbeddingMigrationRouteOptions {
  readonly coordinator: EmbeddingMigrationOperations;
  readonly store: SettingsStore;
  readonly qualify?: (
    settings: EffectiveLlmSettings,
    expectedDimension: number
  ) => Promise<ModelPairQualificationResult>;
  readonly consent?: (reply: FastifyReply, accountId: string) => Promise<boolean>;
  readonly audit?: (kind: "remote_turn" | "remote_ingest", accountId: string) => Promise<void>;
}

interface StartBody {
  readonly target_embed_model: string;
  readonly target_dimension: number;
}

export async function embeddingMigrationRoutes(app: FastifyInstance): Promise<void> {
  await createEmbeddingMigrationRoutes({
    coordinator: embeddingMigrationCoordinator(),
    store: runtimeSettingsStore(),
  })(app, {});
}

export function createEmbeddingMigrationRoutes(options: EmbeddingMigrationRouteOptions): FastifyPluginAsync {
  const qualify = options.qualify ?? qualifyModelPair;
  const consent = options.consent ?? enforceRemoteEgressConsent;
  const audit = options.audit ?? auditRemoteEgress;
  return async (app) => {
    app.get(
      "/api/models/embedding-migration",
      {
        onRequest: requireAuth,
        schema: {
          tags: ["models"],
          summary: "Read process-wide embedding migration status",
          response: { 200: embeddingMigrationStatusSchema },
        },
      },
      async (_req, reply) => reply.send(await options.coordinator.status())
    );

    app.post(
      "/api/models/embedding-migration/start",
      {
        onRequest: requireAuth,
        bodyLimit: COMPACT_JSON_BODY_LIMIT_BYTES,
        schema: {
          tags: ["models"],
          summary: "Qualify and start a managed embedding migration",
          body: embeddingMigrationStartBodySchema,
          response: {
            202: embeddingMigrationStatusSchema,
            400: modelQualificationErrorResponseSchema,
            403: modelQualificationErrorResponseSchema,
            409: modelQualificationErrorResponseSchema,
            413: modelQualificationErrorResponseSchema,
            507: modelQualificationErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        try {
          const accountId = getAccountId(req);
          if (!(await consent(reply, accountId))) return;
          const body = req.body as StartBody;
          const baseline = await options.store.read();
          const preview = await options.store.preview({
            embedModel: body.target_embed_model,
            embeddingDimension: body.target_dimension,
          });
          const result = await qualify(preview.settings, body.target_dimension);
          if (!result.chat.qualified || !result.embedding.qualified) {
            return reply.code(409).send({
              error: "model pair qualification failed",
              code: MODEL_PAIR_NOT_QUALIFIED_CODE,
            });
          }
          recordQualificationAudit(audit, "remote_turn", accountId);
          recordQualificationAudit(audit, "remote_ingest", accountId);
          return reply
            .code(202)
            .send(
              await options.coordinator.start(
                { model: body.target_embed_model, dimension: body.target_dimension },
                { baseline: baseline.settings, target: preview.settings }
              )
            );
        } catch (error) {
          return sendMigrationError(req, reply, error);
        }
      }
    );

    for (const operation of ["retry", "cancel", "apply"] as const) {
      app.post(
        `/api/models/embedding-migration/${operation}`,
        {
          onRequest: requireAuth,
          bodyLimit: BODYLESS_MUTATION_LIMIT_BYTES,
          schema: {
            tags: ["models"],
            summary: `${operation} the managed embedding migration`,
            response: {
              202: embeddingMigrationStatusSchema,
              400: modelQualificationErrorResponseSchema,
              403: modelQualificationErrorResponseSchema,
              404: modelQualificationErrorResponseSchema,
              409: modelQualificationErrorResponseSchema,
            },
          },
        },
        async (req, reply) => {
          try {
            const status =
              operation === "retry"
                ? await options.coordinator.retry()
                : operation === "cancel"
                  ? await options.coordinator.cancel()
                  : await options.coordinator.requestApply();
            return reply.code(202).send(status);
          } catch (error) {
            return sendMigrationError(req, reply, error);
          }
        }
      );
    }
  };
}

function sendMigrationError(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  const requestId = String(reply.getHeader("X-Request-ID") || req.id);
  if (error instanceof EmbeddingMigrationError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code, request_id: requestId });
  }
  if (error instanceof SettingsValidationError) {
    return reply.code(400).send({ error: "invalid settings", request_id: requestId });
  }
  if (error instanceof SettingsEnvironmentOverrideError) {
    return reply.code(409).send({ error: "setting is managed by environment", request_id: requestId });
  }
  throw error;
}

function recordQualificationAudit(
  audit: NonNullable<EmbeddingMigrationRouteOptions["audit"]>,
  kind: "remote_turn" | "remote_ingest",
  accountId: string
): void {
  try {
    void audit(kind, accountId).catch(() => undefined);
  } catch {
    // Content-free audit remains best effort.
  }
}
