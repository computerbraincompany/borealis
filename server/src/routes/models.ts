import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { getAccountId, requireAuth } from "../auth.js";
import { endpointHost, isRemoteProvider } from "../egressPolicy.js";
import { recordEgressEvent, type EgressEventKind } from "../egressAudit.js";
import { discoverChatModels, qualifyModelPair, type ModelPairQualificationResult } from "../llm.js";
import { getRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import {
  SettingsEnvironmentOverrideError,
  SettingsValidationError,
  type EffectiveLlmSettings,
  type SettingsStore,
} from "../settingsStore.js";
import { resolveEffectiveSettingsDraft, selectSettingsDraftFields } from "../settingsDraft.js";
import { storageRuntime } from "../storageRuntime.js";
import { SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES } from "./bodyLimits.js";
import {
  modelQualificationBodySchema,
  modelQualificationErrorResponseSchema,
  modelQualificationResponseSchema,
} from "./schemas.js";

export const DRAFT_REMOTE_EGRESS_ACK_CODE = "DRAFT_REMOTE_EGRESS_ACK_REQUIRED";
export const DRAFT_REMOTE_EGRESS_ACK_MESSAGE =
  "Explicit acknowledgment of the canonical draft provider origin is required before qualification.";

interface QualificationBody extends Record<string, unknown> {
  readonly expected_dimension: number;
  readonly embedding_dimension?: number;
  readonly remote_egress_ack_origin?: string;
}

export interface ModelRoutesOptions {
  readonly store: SettingsStore;
  readonly qualify?: (
    settings: EffectiveLlmSettings,
    expectedDimension: number
  ) => Promise<ModelPairQualificationResult>;
  readonly audit?: (kind: EgressEventKind, accountId: string, endpointHost?: string | null) => Promise<void>;
}

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  await createModelRoutes({ store: runtimeSettingsStore() })(app, {});
}

export function createModelRoutes(options: ModelRoutesOptions): FastifyPluginAsync {
  const qualify = options.qualify ?? qualifyModelPair;
  const audit = options.audit ?? recordEgressEvent;
  return async (app) => {
    app.get(
      "/api/models",
      {
        onRequest: requireAuth,
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

    app.post(
      "/api/models/qualify",
      {
        onRequest: requireAuth,
        bodyLimit: SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
        schema: {
          tags: ["models"],
          summary: "Qualify a draft chat and embedding model pair",
          body: modelQualificationBodySchema,
          response: {
            200: modelQualificationResponseSchema,
            400: modelQualificationErrorResponseSchema,
            403: modelQualificationErrorResponseSchema,
            409: modelQualificationErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        try {
          const input = req.body as QualificationBody;
          if (input.embedding_dimension !== undefined && input.embedding_dimension !== input.expected_dimension) {
            throw new SettingsValidationError("embedding_dimension");
          }
          const snapshot = await resolveEffectiveSettingsDraft(options.store, selectSettingsDraftFields(input));
          const settings = snapshot.settings;
          if (isRemoteProvider(settings.llmBaseUrl)) {
            if (input.remote_egress_ack_origin !== settings.llmBaseUrl) {
              return reply.code(403).send({
                error: DRAFT_REMOTE_EGRESS_ACK_MESSAGE,
                code: DRAFT_REMOTE_EGRESS_ACK_CODE,
              });
            }
            const accountId = getAccountId(req);
            const host = endpointHost(settings.llmBaseUrl);
            recordQualificationEgress(audit, "remote_turn", accountId, host);
            recordQualificationEgress(audit, "remote_ingest", accountId, host);
          }
          return reply.send(await qualify(settings, input.expected_dimension));
        } catch (error) {
          return sendModelSettingsError(req, reply, error);
        }
      }
    );
  };
}

function sendModelSettingsError(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  const requestId = String(reply.getHeader("X-Request-ID") || req.id);
  if (error instanceof SettingsValidationError) {
    return reply.code(400).send({ error: "invalid settings", request_id: requestId });
  }
  if (error instanceof SettingsEnvironmentOverrideError) {
    return reply.code(409).send({ error: "setting is managed by environment", request_id: requestId });
  }
  throw error;
}

function recordQualificationEgress(
  audit: NonNullable<ModelRoutesOptions["audit"]>,
  kind: EgressEventKind,
  accountId: string,
  host: string | null
): void {
  try {
    void audit(kind, accountId, host).catch(() => undefined);
  } catch {
    // Best effort and content-free, matching the durable egress audit boundary.
  }
}
