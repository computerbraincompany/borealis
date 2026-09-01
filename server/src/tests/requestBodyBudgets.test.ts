import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { requireAuth, signToken } from "../auth.js";
import { MAX_CHAT_SOURCE_SCOPE } from "../db/stores/chatStore.js";
import { installHttpBoundary } from "../httpErrors.js";
import {
  COMPACT_JSON_BODY_LIMIT_BYTES,
  CONNECTOR_JSON_BODY_LIMIT_BYTES,
  IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
  PREFERENCE_JSON_BODY_LIMIT_BYTES,
  SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
} from "../routes/bodyLimits.js";
import {
  CHAT_MODEL_MAX_CHARS,
  CHAT_TITLE_MAX_CHARS,
  CONNECTOR_DISPLAY_NAME_MAX_CHARS,
  CONNECTOR_TABLE_MAX_CHARS,
  CONNECTOR_URL_MAX_CHARS,
  PREFERENCE_MODEL_MAX_CHARS,
  chatCreateBodySchema,
  chatPatchBodySchema,
  connectorBodySchema,
  modelQualificationBodySchema,
  preferencesBodySchema,
  sourceScopeBodySchema,
} from "../routes/schemas.js";
import { settingsDraftBodySchema } from "../settingsDraft.js";
import { MAX_API_KEY_CHARS, MAX_ENDPOINT_CHARS, MODEL_ID_MAX_CHARS } from "../settingsStore.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const AUTHORIZATION = `Bearer ${signToken({ userId: ACCOUNT_ID, email: "owner@example.test" })}`;
const JSON_HEADERS = { authorization: AUTHORIZATION, "content-type": "application/json" };
const ASTRAL = "😀";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("derived authenticated request-body budgets", () => {
  it("admits every maximum schema shape when all JSON strings use Unicode escapes", async () => {
    const app = await boundaryApp();
    const sourceIds = scopedSourceIds(MAX_CHAT_SOURCE_SCOPE);
    const cases = [
      {
        name: "settings draft",
        url: "/settings",
        limit: SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
        value: {
          llm_base_url: ASTRAL.repeat(MAX_ENDPOINT_CHARS),
          llm_api_key: ASTRAL.repeat(MAX_API_KEY_CHARS),
          lm_studio_base_url: ASTRAL.repeat(MAX_ENDPOINT_CHARS),
          default_chat_model: ASTRAL.repeat(MODEL_ID_MAX_CHARS),
          default_embed_model: ASTRAL.repeat(MODEL_ID_MAX_CHARS),
          embedding_dimension: 16_384,
        },
      },
      {
        name: "model qualification draft",
        url: "/qualification",
        limit: SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
        value: {
          llm_base_url: ASTRAL.repeat(MAX_ENDPOINT_CHARS),
          llm_api_key: ASTRAL.repeat(MAX_API_KEY_CHARS),
          default_chat_model: ASTRAL.repeat(MODEL_ID_MAX_CHARS),
          default_embed_model: ASTRAL.repeat(MODEL_ID_MAX_CHARS),
          expected_dimension: 16_384,
          remote_egress_ack_origin: ASTRAL.repeat(MAX_ENDPOINT_CHARS),
        },
      },
      {
        name: "chat creation",
        url: "/chat-create",
        limit: IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
        value: {
          title: ASTRAL.repeat(CHAT_TITLE_MAX_CHARS),
          source_mode: "selected",
          source_ids: sourceIds,
          agent_id: sourceIds[0],
        },
      },
      {
        name: "source scope",
        url: "/source-scope",
        limit: IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
        value: { source_mode: "selected", source_ids: sourceIds },
      },
      {
        name: "chat patch",
        url: "/chat-patch",
        limit: COMPACT_JSON_BODY_LIMIT_BYTES,
        value: { model: ASTRAL.repeat(CHAT_MODEL_MAX_CHARS) },
      },
      {
        name: "preference",
        url: "/preference",
        limit: PREFERENCE_JSON_BODY_LIMIT_BYTES,
        value: { default_chat_model: ASTRAL.repeat(PREFERENCE_MODEL_MAX_CHARS) },
      },
      {
        name: "connector",
        url: "/connector",
        limit: CONNECTOR_JSON_BODY_LIMIT_BYTES,
        value: {
          display_name: ASTRAL.repeat(CONNECTOR_DISPLAY_NAME_MAX_CHARS),
          target_table: `a${"b".repeat(CONNECTOR_TABLE_MAX_CHARS - 1)}`,
          type: "url_json",
          config: { url: ASTRAL.repeat(CONNECTOR_URL_MAX_CHARS) },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const payload = maximallyEscapedJson(testCase.value);
      expect(Buffer.byteLength(payload), testCase.name).toBeLessThanOrEqual(testCase.limit);
      const response = await app.inject({
        method: "POST",
        url: testCase.url,
        headers: JSON_HEADERS,
        payload,
      });
      expect(response.statusCode, `${testCase.name}: ${response.body}`).toBe(200);
    }
  });

  it("rejects one-over-schema values as validation errors rather than parser-limit errors", async () => {
    const app = await boundaryApp();
    const sourceIds = scopedSourceIds(MAX_CHAT_SOURCE_SCOPE + 1);
    const cases = [
      {
        name: "settings draft",
        url: "/settings",
        limit: SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
        value: { llm_api_key: ASTRAL.repeat(MAX_API_KEY_CHARS + 1) },
      },
      {
        name: "model qualification draft",
        url: "/qualification",
        limit: SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES,
        value: { expected_dimension: 3, remote_egress_ack_origin: ASTRAL.repeat(MAX_ENDPOINT_CHARS + 1) },
      },
      {
        name: "chat creation",
        url: "/chat-create",
        limit: IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
        value: { source_mode: "selected", source_ids: sourceIds },
      },
      {
        name: "source scope",
        url: "/source-scope",
        limit: IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES,
        value: { source_mode: "selected", source_ids: sourceIds },
      },
      {
        name: "chat patch",
        url: "/chat-patch",
        limit: COMPACT_JSON_BODY_LIMIT_BYTES,
        value: { model: ASTRAL.repeat(CHAT_MODEL_MAX_CHARS + 1) },
      },
      {
        name: "preference",
        url: "/preference",
        limit: PREFERENCE_JSON_BODY_LIMIT_BYTES,
        value: { default_chat_model: ASTRAL.repeat(PREFERENCE_MODEL_MAX_CHARS + 1) },
      },
      {
        name: "connector",
        url: "/connector",
        limit: CONNECTOR_JSON_BODY_LIMIT_BYTES,
        value: {
          display_name: ASTRAL.repeat(CONNECTOR_DISPLAY_NAME_MAX_CHARS + 1),
          target_table: "table",
          type: "url_csv",
          config: { url: "https://example.test/data.csv" },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const payload = maximallyEscapedJson(testCase.value);
      expect(Buffer.byteLength(payload), testCase.name).toBeLessThan(testCase.limit);
      const response = await app.inject({
        method: "POST",
        url: testCase.url,
        headers: JSON_HEADERS,
        payload,
      });
      expect(response.statusCode, `${testCase.name}: ${response.body}`).toBe(400);
      expect(response.statusCode).not.toBe(413);
    }
  });

  it("accepts the exact parser ceiling and rejects one additional byte", async () => {
    const app = await boundaryApp();
    const compact = '{"ok":true}';
    const atLimit = `${compact}${" ".repeat(COMPACT_JSON_BODY_LIMIT_BYTES - Buffer.byteLength(compact))}`;
    const overLimit = `${atLimit} `;

    const accepted = await app.inject({
      method: "POST",
      url: "/exact-boundary",
      headers: JSON_HEADERS,
      payload: atLimit,
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/exact-boundary",
      headers: JSON_HEADERS,
      payload: overLimit,
    });

    expect(Buffer.byteLength(atLimit)).toBe(COMPACT_JSON_BODY_LIMIT_BYTES);
    expect(Buffer.byteLength(overLimit)).toBe(COMPACT_JSON_BODY_LIMIT_BYTES + 1);
    expect(accepted.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json()).toMatchObject({ error: "request payload is too large" });
  });
});

async function boundaryApp(): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 1 });
  apps.push(app);
  installHttpBoundary(app);
  const register = (url: string, bodyLimit: number, body: unknown) => {
    app.post(url, { onRequest: requireAuth, bodyLimit, schema: { body } }, async () => ({ ok: true }));
  };
  register("/settings", SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES, settingsDraftBodySchema);
  register("/qualification", SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES, modelQualificationBodySchema);
  register("/chat-create", IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES, chatCreateBodySchema);
  register("/source-scope", IDENTIFIER_LIST_JSON_BODY_LIMIT_BYTES, sourceScopeBodySchema);
  register("/chat-patch", COMPACT_JSON_BODY_LIMIT_BYTES, chatPatchBodySchema);
  register("/preference", PREFERENCE_JSON_BODY_LIMIT_BYTES, preferencesBodySchema);
  register("/connector", CONNECTOR_JSON_BODY_LIMIT_BYTES, connectorBodySchema);
  register("/exact-boundary", COMPACT_JSON_BODY_LIMIT_BYTES, {
    type: "object",
    required: ["ok"],
    additionalProperties: false,
    properties: { ok: { const: true } },
  });
  await app.ready();
  return app;
}

function scopedSourceIds(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => {
    const suffix = index.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
  });
}

function maximallyEscapedJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return escapedJsonString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(maximallyEscapedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${escapedJsonString(key)}:${maximallyEscapedJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported JSON test value");
}

function escapedJsonString(value: string): string {
  let escaped = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xffff) {
      escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
      continue;
    }
    const scalar = codePoint - 0x10000;
    const high = 0xd800 + (scalar >> 10);
    const low = 0xdc00 + (scalar & 0x3ff);
    escaped += `\\u${high.toString(16)}\\u${low.toString(16)}`;
  }
  return `${escaped}"`;
}
