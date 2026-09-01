import { settingsDraftProperties } from "../settingsDraft.js";
import { MAX_CHAT_SOURCE_SCOPE } from "../db/stores/chatStore.js";

export const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
export const CHAT_TITLE_MAX_CHARS = 80;
export const CHAT_MODEL_MAX_CHARS = 256;
export const CONNECTOR_DISPLAY_NAME_MAX_CHARS = 120;
export const CONNECTOR_TABLE_MAX_CHARS = 63;
export const CONNECTOR_URL_MAX_CHARS = 2_000;
export const PREFERENCE_MODEL_MAX_CHARS = 200;
export const MAX_CATALOG_STATUS_IDS = 50;

export const modelQualificationBodySchema = {
  type: "object",
  required: ["expected_dimension"],
  additionalProperties: false,
  properties: {
    llm_base_url: settingsDraftProperties.llm_base_url,
    llm_api_key: settingsDraftProperties.llm_api_key,
    default_chat_model: settingsDraftProperties.default_chat_model,
    default_embed_model: settingsDraftProperties.default_embed_model,
    embedding_dimension: settingsDraftProperties.embedding_dimension,
    expected_dimension: { type: "integer", minimum: 1, maximum: 16_384 },
    remote_egress_ack_origin: { type: "string", minLength: 1, maxLength: 2_048 },
  },
} as const;

export const modelQualificationResponseSchema = {
  type: "object",
  required: ["chat", "embedding"],
  additionalProperties: false,
  properties: {
    chat: {
      type: "object",
      required: ["qualified", "reason_code", "latency_ms"],
      additionalProperties: false,
      properties: {
        qualified: { type: "boolean" },
        reason_code: {
          type: "string",
          enum: ["qualified", "unreachable", "tool-call-missing", "tool-call-invalid"],
        },
        latency_ms: { type: "integer", minimum: 0, maximum: 30_000 },
      },
    },
    embedding: {
      type: "object",
      required: ["qualified", "reason_code", "dimension", "latency_ms"],
      additionalProperties: false,
      properties: {
        qualified: { type: "boolean" },
        reason_code: {
          type: "string",
          enum: ["qualified", "unreachable", "embedding-invalid", "dimension-mismatch"],
        },
        dimension: { type: ["integer", "null"], minimum: 0 },
        latency_ms: { type: "integer", minimum: 0, maximum: 30_000 },
      },
    },
  },
} as const;

export const modelQualificationErrorResponseSchema = {
  type: "object",
  required: ["error"],
  additionalProperties: false,
  properties: {
    error: { type: "string" },
    code: { type: "string" },
    request_id: { type: "string" },
  },
} as const;

export const embeddingMigrationStartBodySchema = {
  type: "object",
  required: ["target_embed_model", "target_dimension"],
  additionalProperties: false,
  properties: {
    target_embed_model: { type: "string", minLength: 1, maxLength: 256 },
    target_dimension: { type: "integer", minimum: 1, maximum: 16_384 },
  },
} as const;

export const embeddingMigrationStatusSchema = {
  type: "object",
  required: [
    "phase",
    "target_model",
    "target_dimension",
    "source_count",
    "chunk_count",
    "indexed_count",
    "error_code",
    "restart_required",
    "can_cancel",
    "can_retry",
    "can_apply",
  ],
  additionalProperties: false,
  properties: {
    phase: {
      type: "string",
      enum: ["idle", "snapshotting", "building", "ready_to_apply", "apply_pending", "failed"],
    },
    target_model: { type: ["string", "null"], maxLength: 256 },
    target_dimension: { type: ["integer", "null"], minimum: 1, maximum: 16_384 },
    source_count: { type: "integer", minimum: 0, maximum: 100_000 },
    chunk_count: { type: "integer", minimum: 0, maximum: 1_000_000 },
    indexed_count: { type: "integer", minimum: 0, maximum: 1_000_000 },
    error_code: { type: ["string", "null"], maxLength: 64 },
    restart_required: { type: "boolean" },
    can_cancel: { type: "boolean" },
    can_retry: { type: "boolean" },
    can_apply: { type: "boolean" },
  },
} as const;

export const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

export const catalogStatusBodySchema = {
  type: "object",
  required: ["ids"],
  additionalProperties: false,
  properties: {
    ids: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CATALOG_STATUS_IDS,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

export const connectorBodySchema = {
  type: "object",
  required: ["display_name", "target_table", "type", "config"],
  additionalProperties: false,
  properties: {
    display_name: { type: "string", minLength: 1, maxLength: CONNECTOR_DISPLAY_NAME_MAX_CHARS },
    target_table: { type: "string", pattern: `^[A-Za-z][A-Za-z0-9_]{0,${CONNECTOR_TABLE_MAX_CHARS - 1}}$` },
    type: { type: "string", enum: ["url_csv", "url_json"] },
    config: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: { url: { type: "string", minLength: 1, maxLength: CONNECTOR_URL_MAX_CHARS } },
    },
  },
} as const;

export const connectorScheduleBodySchema = {
  type: "object",
  required: ["schedule_minutes"],
  additionalProperties: false,
  properties: {
    // null removes the derived schedule; otherwise the automation interval.
    schedule_minutes: { type: ["integer", "null"], minimum: 15, maximum: 10_080 },
  },
} as const;

export const preferencesBodySchema = {
  type: "object",
  required: ["default_chat_model"],
  additionalProperties: false,
  properties: {
    // null restores the workspace default; otherwise a bounded, non-blank model id.
    default_chat_model: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: PREFERENCE_MODEL_MAX_CHARS,
      pattern: "\\S",
    },
  },
} as const;

export const sourceScopeBodySchema = {
  type: "object",
  required: ["source_mode"],
  propertyNames: { enum: ["source_mode", "source_ids"] },
  description:
    "Exact union: {source_mode:'all'} or {source_mode:'selected',source_ids:[up to 100 UUIDs]}. Runtime validation rejects every other shape.",
  properties: {
    source_mode: { type: "string", enum: ["all", "selected"] },
    source_ids: {
      type: "array",
      maxItems: MAX_CHAT_SOURCE_SCOPE,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

export const chatCreateBodySchema = {
  type: "object",
  propertyNames: { enum: ["title", "agent_id", "source_mode", "source_ids"] },
  description:
    "Optional title and agent binding plus the exact source-scope union. Omitting scope preserves legacy all-source behavior.",
  properties: {
    // Runtime validation owns type checking so Fastify's coercion cannot turn
    // a numeric title into a valid string before the exact-shape parser sees it.
    title: { minLength: 1, maxLength: CHAT_TITLE_MAX_CHARS, pattern: "\\S" },
    agent_id: { type: "string", pattern: UUID_PATTERN },
    source_mode: { type: "string", enum: ["all", "selected"] },
    source_ids: {
      type: "array",
      maxItems: MAX_CHAT_SOURCE_SCOPE,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

export const chatPatchBodySchema = {
  type: "object",
  propertyNames: { enum: ["title", "model"] },
  description: "Exactly one of title (1-80 characters) or model (1-256 characters).",
  properties: {
    title: { minLength: 1, maxLength: CHAT_TITLE_MAX_CHARS, pattern: "\\S" },
    model: { minLength: 1, maxLength: CHAT_MODEL_MAX_CHARS, pattern: "\\S" },
  },
} as const;
