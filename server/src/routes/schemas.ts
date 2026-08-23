export const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

export const connectorBodySchema = {
  type: "object",
  required: ["display_name", "target_table", "type", "config"],
  additionalProperties: false,
  properties: {
    display_name: { type: "string", minLength: 1, maxLength: 120 },
    target_table: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,62}$" },
    type: { type: "string", enum: ["url_csv", "url_json"] },
    config: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: { url: { type: "string", minLength: 1, maxLength: 2000 } },
    },
  },
} as const;

export const sourceScopeBodySchema = {
  type: "object",
  description:
    "Exact union: {source_mode:'all'} or {source_mode:'selected',source_ids:[up to 100 UUIDs]}. Runtime validation rejects every other shape.",
  properties: {
    source_mode: { description: "Either all or selected." },
    source_ids: { description: "Required only for selected; an empty array intentionally means no sources." },
  },
} as const;

export const chatCreateBodySchema = {
  type: "object",
  description:
    "Optional title (1-80 characters) plus the exact source-scope union. Omitting scope preserves legacy all-source behavior.",
  properties: {
    title: { description: "Optional 1-80 character title." },
    source_mode: { description: "Either all or selected." },
    source_ids: { description: "Required only when source_mode is selected; at most 100 UUIDs." },
  },
} as const;

export const chatPatchBodySchema = {
  type: "object",
  description: "Exactly one of title (1-80 characters) or model (1-256 characters).",
  properties: {
    title: { description: "A 1-80 character title." },
    model: { description: "A 1-256 character chat model id." },
  },
} as const;
