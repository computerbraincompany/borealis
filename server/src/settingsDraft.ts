import {
  MAX_API_KEY_CHARS,
  MAX_ENDPOINT_CHARS,
  MODEL_ID_MAX_CHARS,
  SettingsValidationError,
  type LlmSettingsPatch,
  type SettingsSnapshot,
  type SettingsStore,
} from "./settingsStore.js";

export const HTTP_SETTINGS_DRAFT_FIELDS = Object.freeze([
  "llm_base_url",
  "llm_api_key",
  "lm_studio_base_url",
  "default_chat_model",
  "default_embed_model",
  "embedding_dimension",
] as const);

type HttpSettingsDraftField = (typeof HTTP_SETTINGS_DRAFT_FIELDS)[number];

export const settingsDraftProperties = {
  llm_base_url: { type: "string", minLength: 1, maxLength: MAX_ENDPOINT_CHARS },
  llm_api_key: {
    anyOf: [{ type: "string", minLength: 1, maxLength: MAX_API_KEY_CHARS }, { type: "null" }],
  },
  lm_studio_base_url: {
    anyOf: [{ type: "string", minLength: 1, maxLength: MAX_ENDPOINT_CHARS }, { type: "null" }],
  },
  default_chat_model: { type: "string", minLength: 0, maxLength: MODEL_ID_MAX_CHARS },
  default_embed_model: { type: "string", minLength: 1, maxLength: MODEL_ID_MAX_CHARS },
  embedding_dimension: { type: "integer", minimum: 1, maximum: 16_384 },
} as const;

export const settingsDraftBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: settingsDraftProperties,
} as const;

/** Decode the bounded public draft shape into the canonical Settings patch contract. */
export function decodeSettingsDraftPatch(body: unknown): LlmSettingsPatch {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) throw new SettingsValidationError();
  if (Object.keys(body).some((key) => !HTTP_SETTINGS_DRAFT_FIELDS.includes(key as HttpSettingsDraftField))) {
    throw new SettingsValidationError();
  }

  const patch: {
    llmBaseUrl?: string;
    apiKey?: string | null;
    lmStudioBaseUrl?: string | null;
    chatModel?: string;
    embedModel?: string;
    embeddingDimension?: number;
  } = {};
  if (Object.prototype.hasOwnProperty.call(body, "llm_base_url")) {
    if (typeof body.llm_base_url !== "string") throw new SettingsValidationError("llm_base_url");
    patch.llmBaseUrl = body.llm_base_url;
  }
  if (Object.prototype.hasOwnProperty.call(body, "llm_api_key")) {
    if (body.llm_api_key !== null && typeof body.llm_api_key !== "string") {
      throw new SettingsValidationError("llm_api_key");
    }
    patch.apiKey = body.llm_api_key as string | null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "lm_studio_base_url")) {
    if (body.lm_studio_base_url !== null && typeof body.lm_studio_base_url !== "string") {
      throw new SettingsValidationError("lm_studio_base_url");
    }
    patch.lmStudioBaseUrl = body.lm_studio_base_url as string | null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "default_chat_model")) {
    if (typeof body.default_chat_model !== "string") throw new SettingsValidationError("default_chat_model");
    patch.chatModel = body.default_chat_model;
  }
  if (Object.prototype.hasOwnProperty.call(body, "default_embed_model")) {
    if (typeof body.default_embed_model !== "string") throw new SettingsValidationError("default_embed_model");
    patch.embedModel = body.default_embed_model;
  }
  if (Object.prototype.hasOwnProperty.call(body, "embedding_dimension")) {
    if (!Number.isSafeInteger(body.embedding_dimension)) throw new SettingsValidationError("embedding_dimension");
    patch.embeddingDimension = body.embedding_dimension as number;
  }
  return patch;
}

/** Resolve one draft against stored and environment-managed settings without persisting it. */
export async function resolveEffectiveSettingsDraft(store: SettingsStore, body: unknown): Promise<SettingsSnapshot> {
  const patch = decodeSettingsDraftPatch(body);
  return Object.keys(patch).length ? store.preview(patch) : store.read();
}

/** Copy only Settings fields from a larger validated route body. */
export function selectSettingsDraftFields(body: Record<string, unknown>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const field of HTTP_SETTINGS_DRAFT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) selected[field] = body[field];
  }
  return selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
