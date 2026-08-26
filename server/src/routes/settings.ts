import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../auth.js";
import { runtimeSettingsStore } from "../runtimeSettings.js";
import {
  SettingsEnvironmentOverrideError,
  type EffectiveLlmSettings,
  type LlmSettingsPatch,
  SettingsValidationError,
  type SettingsStore,
  toPublicLlmSettings,
} from "../settingsStore.js";

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const MAX_CONNECTION_TIMEOUT_MS = 15_000;

type ProbeResponse = Pick<Response, "ok" | "body">;
export type SettingsProbeFetch = (url: string, init: RequestInit) => Promise<ProbeResponse>;

export interface SettingsRoutesOptions {
  readonly store: SettingsStore;
  readonly fetch?: SettingsProbeFetch;
  readonly connectionTimeoutMs?: number;
  readonly now?: () => number;
}

export interface SettingsConnectionResult {
  readonly ok: boolean;
  readonly latency_ms: number;
}

/** Live singleton-backed plugin used by the application route composer. */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  await createSettingsRoutes({ store: runtimeSettingsStore() })(app, {});
};

interface HttpSettingsPatch {
  readonly llm_base_url?: unknown;
  readonly llm_api_key?: unknown;
  readonly lm_studio_base_url?: unknown;
  readonly default_chat_model?: unknown;
  readonly default_embed_model?: unknown;
}

const settingsPatchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    llm_base_url: { type: "string", minLength: 1, maxLength: 2_048 },
    llm_api_key: {
      anyOf: [{ type: "string", minLength: 1, maxLength: 8_192 }, { type: "null" }],
    },
    lm_studio_base_url: {
      anyOf: [{ type: "string", minLength: 1, maxLength: 2_048 }, { type: "null" }],
    },
    default_chat_model: { type: "string", minLength: 1, maxLength: 256 },
    default_embed_model: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

/** Authenticated settings API; register the returned plugin exactly once. */
export function createSettingsRoutes(options: SettingsRoutesOptions): FastifyPluginAsync {
  const timeoutMs = normalizeTimeout(options.connectionTimeoutMs);
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;

  return async (app) => {
    app.get(
      "/api/settings",
      {
        preHandler: requireAuth,
        schema: { tags: ["settings"], summary: "Read model provider settings" },
      },
      async (_req, reply) => reply.send(toPublicLlmSettings(await options.store.read()))
    );

    app.patch(
      "/api/settings",
      {
        preHandler: requireAuth,
        bodyLimit: 16 * 1024,
        schema: {
          tags: ["settings"],
          summary: "Update model provider settings",
          body: settingsPatchSchema,
        },
      },
      async (req, reply) => {
        try {
          const snapshot = await options.store.patch(decodeHttpPatch(req.body));
          return reply.send(toPublicLlmSettings(snapshot));
        } catch (error) {
          return sendSettingsError(req, reply, error);
        }
      }
    );

    app.post(
      "/api/settings/test",
      {
        preHandler: requireAuth,
        preValidation: async (req) => {
          if (req.body === undefined) req.body = {};
        },
        bodyLimit: 16 * 1024,
        schema: {
          tags: ["settings"],
          summary: "Test the model provider connection",
          body: settingsPatchSchema,
        },
      },
      async (req, reply) => {
        try {
          const patch = decodeHttpPatch(req.body);
          const snapshot = Object.keys(patch).length ? await options.store.preview(patch) : await options.store.read();
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

function decodeHttpPatch(body: unknown): LlmSettingsPatch {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) throw new SettingsValidationError();
  const allowed = new Set([
    "llm_base_url",
    "llm_api_key",
    "lm_studio_base_url",
    "default_chat_model",
    "default_embed_model",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new SettingsValidationError();

  const patch: {
    llmBaseUrl?: string;
    apiKey?: string | null;
    lmStudioBaseUrl?: string | null;
    chatModel?: string;
    embedModel?: string;
  } = {};
  const input = body as HttpSettingsPatch;
  if (Object.prototype.hasOwnProperty.call(input, "llm_base_url")) {
    if (typeof input.llm_base_url !== "string") throw new SettingsValidationError("llm_base_url");
    patch.llmBaseUrl = input.llm_base_url;
  }
  if (Object.prototype.hasOwnProperty.call(input, "llm_api_key")) {
    if (input.llm_api_key !== null && typeof input.llm_api_key !== "string") {
      throw new SettingsValidationError("llm_api_key");
    }
    patch.apiKey = input.llm_api_key as string | null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "lm_studio_base_url")) {
    if (input.lm_studio_base_url !== null && typeof input.lm_studio_base_url !== "string") {
      throw new SettingsValidationError("lm_studio_base_url");
    }
    patch.lmStudioBaseUrl = input.lm_studio_base_url as string | null;
  }
  if (Object.prototype.hasOwnProperty.call(input, "default_chat_model")) {
    if (typeof input.default_chat_model !== "string") throw new SettingsValidationError("default_chat_model");
    patch.chatModel = input.default_chat_model;
  }
  if (Object.prototype.hasOwnProperty.call(input, "default_embed_model")) {
    if (typeof input.default_embed_model !== "string") throw new SettingsValidationError("default_embed_model");
    patch.embedModel = input.default_embed_model;
  }
  return patch;
}

function sendSettingsError(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  const requestId = String(reply.getHeader("X-Request-ID") || req.id);
  if (error instanceof SettingsValidationError) {
    return reply.code(400).send({ error: "invalid settings", request_id: requestId });
  }
  if (error instanceof SettingsEnvironmentOverrideError) {
    return reply.code(409).send({ error: "setting is managed by environment", request_id: requestId });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
