import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../auth.js";
import {
  embeddingMigrationCoordinator,
  EmbeddingMigrationError,
  EmbeddingReindexRequiredError,
} from "../embeddingMigration.js";
import { runtimeSettingsStore } from "../runtimeSettings.js";
import {
  SettingsEnvironmentOverrideError,
  type EffectiveLlmSettings,
  SettingsValidationError,
  type SettingsStore,
  type LlmSettingsPatch,
  toPublicLlmSettings,
} from "../settingsStore.js";
import { decodeSettingsDraftPatch, resolveEffectiveSettingsDraft, settingsDraftBodySchema } from "../settingsDraft.js";
import { SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES } from "./bodyLimits.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const MAX_CONNECTION_TIMEOUT_MS = 15_000;

type ProbeResponse = Pick<Response, "ok" | "body">;
export type SettingsProbeFetch = (url: string, init: RequestInit) => Promise<ProbeResponse>;

export interface SettingsRoutesOptions {
  readonly store: SettingsStore;
  readonly fetch?: SettingsProbeFetch;
  readonly connectionTimeoutMs?: number;
  readonly now?: () => number;
  readonly patch?: (patch: LlmSettingsPatch) => Promise<Awaited<ReturnType<SettingsStore["patch"]>>>;
}

export interface SettingsConnectionResult {
  readonly ok: boolean;
  readonly latency_ms: number;
}

/** Live singleton-backed plugin used by the application route composer. */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const store = runtimeSettingsStore();
  await createSettingsRoutes({
    store,
    patch: (patch) => embeddingMigrationCoordinator().patchSettings(patch),
  })(app, {});
};

/** Authenticated settings API; register the returned plugin exactly once. */
export function createSettingsRoutes(options: SettingsRoutesOptions): FastifyPluginAsync {
  const timeoutMs = normalizeTimeout(options.connectionTimeoutMs);
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const patchSettings = options.patch ?? ((patch: LlmSettingsPatch) => options.store.patch(patch));

  return async (app) => {
    app.get(
      "/api/settings",
      {
        onRequest: requireAuth,
        schema: { tags: ["settings"], summary: "Read model provider settings" },
      },
      async (_req, reply) => reply.send(toPublicLlmSettings(await options.store.read()))
    );

    app.patch(
      "/api/settings",
      {
        onRequest: requireAuth,
        bodyLimit: SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
        schema: {
          tags: ["settings"],
          summary: "Update model provider settings",
          body: settingsDraftBodySchema,
        },
      },
      async (req, reply) => {
        try {
          const snapshot = await patchSettings(decodeSettingsDraftPatch(req.body));
          return reply.send(toPublicLlmSettings(snapshot));
        } catch (error) {
          return sendSettingsError(req, reply, error);
        }
      }
    );

    app.post(
      "/api/settings/test",
      {
        onRequest: requireAuth,
        preValidation: async (req) => {
          if (req.body === undefined) req.body = {};
        },
        bodyLimit: SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
        schema: {
          tags: ["settings"],
          summary: "Test the model provider connection",
          body: settingsDraftBodySchema,
        },
      },
      async (req, reply) => {
        try {
          const snapshot = await resolveEffectiveSettingsDraft(options.store, req.body);
          const result = await probeSettingsConnection(snapshot.settings, { fetch: fetchImpl, timeoutMs, now });
          if (!result.ok) return reply.code(503).send({ ok: false });
          return reply.send(result);
        } catch (error) {
          return sendSettingsError(req, reply, error);
        }
      }
    );
  };
}

/**
 * Perform the same body-free GET /v1/models probe used by model discovery.
 * The upstream status, body, URL, and thrown error are deliberately discarded.
 */
export async function probeSettingsConnection(
  settings: EffectiveLlmSettings,
  dependencies: {
    readonly fetch?: SettingsProbeFetch;
    readonly timeoutMs?: number;
    readonly now?: () => number;
  } = {}
): Promise<SettingsConnectionResult> {
  const fetchImpl = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = normalizeTimeout(dependencies.timeoutMs);
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const headers: Record<string, string> = { Accept: "application/json", "Cache-Control": "no-store" };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const response = await fetchImpl(`${settings.llmBaseUrl}/v1/models`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, latency_ms: safeLatency(now() - startedAt) };
  } catch {
    return { ok: false, latency_ms: safeLatency(now() - startedAt) };
  } finally {
    clearTimeout(timer);
  }
}

function sendSettingsError(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  const requestId = String(reply.getHeader("X-Request-ID") || req.id);
  if (error instanceof SettingsValidationError) {
    return reply.code(400).send({ error: "invalid settings", request_id: requestId });
  }
  if (error instanceof SettingsEnvironmentOverrideError) {
    return reply.code(409).send({ error: "setting is managed by environment", request_id: requestId });
  }
  if (error instanceof EmbeddingReindexRequiredError) {
    return reply.code(409).send({
      error: "embedding reindex is required",
      code: error.code,
      request_id: requestId,
    });
  }
  if (error instanceof EmbeddingMigrationError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code, request_id: requestId });
  }
  throw error;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_CONNECTION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_CONNECTION_TIMEOUT_MS;
  return Math.min(Math.floor(timeoutMs), MAX_CONNECTION_TIMEOUT_MS);
}

function safeLatency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_CONNECTION_TIMEOUT_MS, Math.round(value)));
}
