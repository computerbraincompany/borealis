import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signToken } from "../auth.js";
import { installHttpBoundary } from "../httpErrors.js";
import { qualifyModelPair, type ModelPairQualificationResult, type ModelQualificationFetch } from "../llm.js";
import { resolveLlmModelId } from "../llmAliases.js";
import { SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES } from "../routes/bodyLimits.js";
import { createModelRoutes, DRAFT_REMOTE_EGRESS_ACK_CODE, type ModelRoutesOptions } from "../routes/models.js";
import {
  createSettingsStore,
  DEFAULT_LLM_SETTINGS,
  SettingsValidationError,
  type SettingsStore,
} from "../settingsStore.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const auth = {
  authorization: `Bearer ${signToken({ userId: ACCOUNT_ID, email: "owner@example.test" })}`,
};
const successfulQualification: ModelPairQualificationResult = {
  chat: { qualified: true, reason_code: "qualified", latency_ms: 1 },
  embedding: { qualified: true, reason_code: "qualified", dimension: 3, latency_ms: 1 },
};

const temporaryDirectories: string[] = [];
const apps: FastifyInstance[] = [];

async function temporaryStore(
  env: Readonly<Record<string, string | undefined>> = {}
): Promise<{ store: SettingsStore; filename: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-model-qualification-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "settings.json");
  return { store: createSettingsStore({ path: filename, env }), filename };
}

async function buildApp(
  store: SettingsStore,
  options: Partial<Omit<ModelRoutesOptions, "store">> = {}
): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(createModelRoutes({ store, ...options }));
  await app.ready();
  return app;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function streamingPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { choices?: unknown }).choices))
    return payload;
  return {
    ...(payload as Record<string, unknown>),
    choices: (payload as { choices: unknown[] }).choices.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !("message" in value)) return value;
      const { message, ...choice } = value as Record<string, unknown>;
      return { ...choice, delta: message };
    }),
  };
}

function sseResponse(payloads: readonly unknown[], status = 200): Response {
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

function providerFetch(chatPayload: unknown, embeddingPayload: unknown): ModelQualificationFetch {
  return vi.fn(async (url: string) =>
    url.endsWith("/v1/chat/completions") ? sseResponse([streamingPayload(chatPayload)]) : jsonResponse(embeddingPayload)
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("model-pair qualification service", () => {
  it("uses only fixed synthetic payloads and qualifies exact tool and embedding contracts", async () => {
    const observations: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock: ModelQualificationFetch = vi.fn(async (url, init) => {
      observations.push({ url, init });
      if (url.endsWith("/v1/chat/completions")) {
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  content: "provider-private-content",
                  reasoning_content: "provider-private-reasoning",
                  tool_calls: [
                    {
                      id: "call-qualify",
                      type: "function",
                      function: { name: "borealis_qualify", arguments: '{"ok":true}' },
                    },
                  ],
                },
              },
            ],
          },
        ]);
      }
      return jsonResponse({ data: [{ embedding: [3, 4, 0], provider_private: "discard-me" }] });
    });

    const result = await qualifyModelPair(
      {
        llmBaseUrl: "https://provider.example.test",
        apiKey: "qualification-test-key",
        chatModel: "qwen-chat",
        embedModel: "nomic-embed",
        embeddingDimension: 3,
      },
      3,
      { fetch: fetchMock }
    );

    expect(result).toMatchObject({
      chat: { qualified: true, reason_code: "qualified" },
      embedding: { qualified: true, reason_code: "qualified", dimension: 3 },
    });
    expect(JSON.stringify(result)).not.toMatch(/provider-private|discard-me|qualification-test-key/);
    expect(observations).toHaveLength(2);
    expect(observations.every(({ init }) => init.method === "POST" && init.redirect === "error")).toBe(true);
    expect(
      observations.every(
        ({ init }) => (init.headers as Record<string, string>).Authorization === "Bearer qualification-test-key"
      )
    ).toBe(true);

    const chatBody = JSON.parse(String(observations.find(({ url }) => url.includes("chat/completions"))?.init.body));
    expect(chatBody).toMatchObject({
      model: resolveLlmModelId("qwen-chat"),
      messages: [
        {
          role: "user",
          content: "Call the provided qualification function exactly once with ok set to true.",
        },
      ],
      max_tokens: 1024,
      tool_choice: "required",
      stream: true,
    });
    expect(JSON.stringify(chatBody)).not.toContain("workspace-private-sentinel");
    const embeddingBody = JSON.parse(String(observations.find(({ url }) => url.includes("embeddings"))?.init.body));
    expect(embeddingBody).toEqual({
      model: resolveLlmModelId("nomic-embed"),
      input: ["Borealis embedding qualification probe."],
      encoding_format: "float",
    });
  });

  it.each([
    ["missing call", { choices: [{ message: { content: "plain answer" } }] }, "tool-call-missing"],
    ["malformed envelope", { choices: "invalid" }, "tool-call-invalid"],
    [
      "wrong function",
      {
        choices: [
          {
            message: {
              tool_calls: [
                { id: "call-qualify", type: "function", function: { name: "other", arguments: '{"ok":true}' } },
              ],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
    [
      "malformed arguments",
      {
        choices: [
          {
            message: {
              tool_calls: [
                { id: "call-qualify", type: "function", function: { name: "borealis_qualify", arguments: "{" } },
              ],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
    [
      "oversized arguments",
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-qualify",
                  type: "function",
                  function: { name: "borealis_qualify", arguments: "x".repeat(257) },
                },
              ],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
    [
      "false result",
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-qualify",
                  type: "function",
                  function: { name: "borealis_qualify", arguments: '{"ok":false}' },
                },
              ],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
    [
      "extra argument",
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-qualify",
                  type: "function",
                  function: { name: "borealis_qualify", arguments: '{"ok":true,"extra":true}' },
                },
              ],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
    [
      "multiple calls",
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-one",
                  type: "function",
                  function: { name: "borealis_qualify", arguments: '{"ok":true}' },
                },
                {
                  id: "call-two",
                  type: "function",
                  function: { name: "borealis_qualify", arguments: '{"ok":true}' },
                },
              ],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
    [
      "missing call id",
      {
        choices: [
          {
            message: {
              tool_calls: [{ type: "function", function: { name: "borealis_qualify", arguments: '{"ok":true}' } }],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
    [
      "empty call id",
      {
        choices: [
          {
            message: {
              tool_calls: [
                { id: "", type: "function", function: { name: "borealis_qualify", arguments: '{"ok":true}' } },
              ],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
    [
      "oversized call id",
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "x".repeat(257),
                  type: "function",
                  function: { name: "borealis_qualify", arguments: '{"ok":true}' },
                },
              ],
            },
          },
        ],
      },
      "tool-call-invalid",
    ],
  ] as const)("returns a stable chat reason for %s", async (_label, chatPayload, reasonCode) => {
    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, {
      fetch: providerFetch(chatPayload, { data: [{ embedding: [1, 2, 3] }] }),
    });
    expect(result.chat).toMatchObject({ qualified: false, reason_code: reasonCode });
    expect(result.embedding.qualified).toBe(true);
  });

  it.each([
    ["incremental", "qualify"],
    ["cumulative", "borealis_qualify"],
  ])("qualifies a %s fragmented streaming tool call", async (_label, secondName) => {
    const fetchMock: ModelQualificationFetch = vi.fn(async (url) =>
      url.endsWith("/v1/chat/completions")
        ? sseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-qualify",
                        type: "function",
                        function: { name: "borealis_", arguments: '{"ok":' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { name: secondName, arguments: "true}" } }],
                  },
                },
              ],
            },
          ])
        : jsonResponse({ data: [{ embedding: [1, 2, 3] }] })
    );

    await expect(qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, { fetch: fetchMock })).resolves.toMatchObject({
      chat: { qualified: true, reason_code: "qualified" },
      embedding: { qualified: true, reason_code: "qualified" },
    });
  });

  it("allows a bounded long reasoning stream before the one validated tool call", async () => {
    const prelude = Array.from({ length: 2000 }, () => ({
      choices: [{ delta: { content: "private-thinking-fragment" } }],
    }));
    const tool = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-qualify",
                type: "function",
                function: { name: "borealis_qualify", arguments: '{"ok":true}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const wire = await sseResponse([...prelude, tool]).text();
    expect(Buffer.byteLength(wire)).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(wire)).toBeLessThan(512 * 1024);
    const fetchMock: ModelQualificationFetch = vi.fn(async (url) =>
      url.endsWith("/v1/chat/completions") ? new Response(wire) : jsonResponse({ data: [{ embedding: [1, 2, 3] }] })
    );
    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, { fetch: fetchMock });
    expect(result.chat.qualified).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-thinking-fragment");
    const oversizedFetch: ModelQualificationFetch = vi.fn(async (url) =>
      url.endsWith("/v1/chat/completions")
        ? sseResponse([...prelude, ...prelude, ...prelude, ...prelude, tool])
        : jsonResponse({ data: [{ embedding: [1, 2, 3] }] })
    );
    expect((await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, { fetch: oversizedFetch })).chat.qualified).toBe(false);
  });

  it("reports an exhausted generation budget instead of claiming tool support is missing", async () => {
    const fetchMock: ModelQualificationFetch = vi.fn(async (url) =>
      url.endsWith("/v1/chat/completions")
        ? sseResponse([{ choices: [{ delta: { content: "private unfinished reasoning" }, finish_reason: "length" }] }])
        : jsonResponse({ data: [{ embedding: [1, 2, 3] }] })
    );
    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, { fetch: fetchMock });
    expect(result.chat).toMatchObject({ qualified: false, reason_code: "response-truncated" });
    expect(result.embedding.qualified).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private unfinished reasoning");
  });

  it("rejects a non-streaming chat response even when its tool call would otherwise be valid", async () => {
    const fetchMock: ModelQualificationFetch = vi.fn(async (url) =>
      url.endsWith("/v1/chat/completions")
        ? jsonResponse({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call-qualify",
                      type: "function",
                      function: { name: "borealis_qualify", arguments: '{"ok":true}' },
                    },
                  ],
                },
              },
            ],
          })
        : jsonResponse({ data: [{ embedding: [1, 2, 3] }] })
    );

    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, { fetch: fetchMock });
    expect(result.chat).toMatchObject({ qualified: false, reason_code: "tool-call-invalid" });
    expect(result.embedding.qualified).toBe(true);
  });

  it.each([
    ["missing vector", { data: [] }, "embedding-invalid", null],
    ["multiple vectors", { data: [{ embedding: [1, 2, 3] }, { embedding: [1, 2, 3] }] }, "embedding-invalid", null],
    ["base64 vector", { data: [{ embedding: "encoded" }] }, "embedding-invalid", null],
    ["zero norm", { data: [{ embedding: [0, 0, 0] }] }, "embedding-invalid", 3],
    ["float32 underflow", { data: [{ embedding: [1e-100, 0, 0] }] }, "embedding-invalid", 3],
    ["float32 overflow", { data: [{ embedding: [1e100, 1, 0] }] }, "embedding-invalid", 3],
    ["float32 norm underflow", { data: [{ embedding: [1e-23, 0, 0] }] }, "embedding-invalid", 3],
    ["float32 norm overflow", { data: [{ embedding: [1e20, 0, 0] }] }, "embedding-invalid", 3],
    ["non-number", { data: [{ embedding: [1, "2", 3] }] }, "embedding-invalid", 3],
    ["wrong dimension", { data: [{ embedding: [1, 2] }] }, "dimension-mismatch", 2],
  ] as const)("returns a stable embedding reason for %s", async (_label, embeddingPayload, reasonCode, dimension) => {
    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, {
      fetch: providerFetch(
        {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call-qualify",
                    type: "function",
                    function: { name: "borealis_qualify", arguments: '{"ok":true}' },
                  },
                ],
              },
            },
          ],
        },
        embeddingPayload
      ),
    });
    expect(result.embedding).toMatchObject({ qualified: false, reason_code: reasonCode, dimension });
    expect(result.chat.qualified).toBe(true);
  });

  it("rejects non-finite embedding values and malformed or oversized response bodies without reflecting them", async () => {
    const largePrivatePayload = "provider-private".repeat(50_000);
    const fetchMock: ModelQualificationFetch = vi.fn(async (url) => {
      if (url.endsWith("/v1/chat/completions")) return new Response(largePrivatePayload, { status: 200 });
      return new Response('{"data":[{"embedding":[1e999,1,2],"private":"provider-secret"}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, { fetch: fetchMock });

    expect(result.chat.reason_code).toBe("tool-call-invalid");
    expect(result.embedding).toMatchObject({ reason_code: "embedding-invalid", dimension: 3 });
    expect(JSON.stringify(result)).not.toMatch(/provider-private|provider-secret/);
  });

  it("turns independent abort deadlines and non-success statuses into bounded unreachable results", async () => {
    const observedSignals: AbortSignal[] = [];
    const abortingFetch: ModelQualificationFetch = vi.fn((_url, init) => {
      if (init.signal) observedSignals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    const startedAt = Date.now();

    const timedOut = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, { fetch: abortingFetch, timeoutMs: 10 });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(timedOut.chat).toMatchObject({ qualified: false, reason_code: "timeout" });
    expect(timedOut.embedding).toMatchObject({ qualified: false, reason_code: "timeout", dimension: null });
    expect(timedOut.chat.latency_ms).toBeLessThanOrEqual(10);
    expect(timedOut.embedding.latency_ms).toBeLessThanOrEqual(10);
    expect(abortingFetch).toHaveBeenCalledTimes(2);
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);

    const rejected = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, {
      fetch: vi.fn(async () => new Response("private diagnostic", { status: 401 })),
    });
    expect(rejected.chat.reason_code).toBe("unreachable");
    expect(rejected.embedding.reason_code).toBe("unreachable");
    expect(JSON.stringify(rejected)).not.toContain("private diagnostic");
  });

  it("keeps role outcomes independent when only one provider operation reaches its deadline", async () => {
    const fetchMock: ModelQualificationFetch = vi.fn((url) => {
      if (url.endsWith("/v1/chat/completions")) return new Promise<Response>(() => undefined);
      return Promise.resolve(jsonResponse({ data: [{ embedding: [1, 2, 3] }] }));
    });

    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, 3, { fetch: fetchMock, timeoutMs: 10 });

    expect(result.chat).toMatchObject({ qualified: false, reason_code: "timeout" });
    expect(result.embedding).toMatchObject({ qualified: true, reason_code: "qualified", dimension: 3 });
  });

  it("detects dimensions from validated vectors and checks embeddings before loading chat", async () => {
    const fetchMock = providerFetch(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-probe",
                  type: "function",
                  function: { name: "borealis_qualify", arguments: '{"ok":true}' },
                },
              ],
            },
          },
        ],
      },
      { data: [{ embedding: [1, 2, 3] }] }
    );
    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, null, { fetch: fetchMock });
    expect(result.embedding).toMatchObject({ qualified: true, dimension: 3 });
    expect(vi.mocked(fetchMock).mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/v1/embeddings",
      "/v1/chat/completions",
    ]);
  });

  it("rejects oversized automatically detected vectors", async () => {
    const fetchMock = providerFetch(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-probe",
                  type: "function",
                  function: { name: "borealis_qualify", arguments: '{"ok":true}' },
                },
              ],
            },
          },
        ],
      },
      { data: [{ embedding: Array(16_385).fill(1) }] }
    );
    const result = await qualifyModelPair(DEFAULT_LLM_SETTINGS, null, { fetch: fetchMock });
    expect(result.embedding).toMatchObject({ qualified: false, reason_code: "embedding-invalid" });
  });

  it("rejects invalid expected dimensions before provider access", async () => {
    const fetchMock: ModelQualificationFetch = vi.fn();
    await expect(qualifyModelPair(DEFAULT_LLM_SETTINGS, 0, { fetch: fetchMock })).rejects.toBeInstanceOf(RangeError);
    await expect(qualifyModelPair(DEFAULT_LLM_SETTINGS, 16_385, { fetch: fetchMock })).rejects.toBeInstanceOf(
      RangeError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("model qualification route", () => {
  it("allows automatic detection without saving it and preserves environment dimension constraints", async () => {
    for (const managed of [false, true]) {
      const { store } = await temporaryStore(managed ? { EMBEDDING_DIM: "3" } : {});
      const qualify = vi.fn(async () => successfulQualification);
      const app = await buildApp(store, { qualify });
      const before = await store.read();
      const response = await app.inject({ method: "POST", url: "/api/models/qualify", headers: auth, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(qualify).toHaveBeenCalledWith(before.settings, managed ? 3 : null);
      expect(await store.read()).toEqual(before);
    }
  });

  it("requires the exact canonical remote draft acknowledgment and never persists the draft", async () => {
    const { store, filename } = await temporaryStore();
    const qualify = vi.fn(async () => ({ ...successfulQualification, private_result: "must-be-stripped" }));
    const audit = vi.fn(async () => undefined);
    const app = await buildApp(store, { qualify, audit });
    const draft = {
      llm_base_url: "https://draft-provider.example.test/",
      llm_api_key: "draft-provider-key",
      default_chat_model: "draft-chat",
      default_embed_model: "draft-embed",
      expected_dimension: 3,
    };

    for (const acknowledgment of [undefined, "https://other.example.test", "https://draft-provider.example.test/"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/models/qualify",
        headers: auth,
        payload: {
          ...draft,
          ...(acknowledgment === undefined ? {} : { remote_egress_ack_origin: acknowledgment }),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: DRAFT_REMOTE_EGRESS_ACK_CODE });
      expect(response.body).not.toMatch(/draft-provider|other\.example|draft-provider-key/);
    }
    expect(qualify).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: auth,
      payload: { ...draft, remote_egress_ack_origin: "https://draft-provider.example.test" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(successfulQualification);
    expect(accepted.body).not.toMatch(/private_result|draft-provider|draft-provider-key|draft-chat|draft-embed/);
    expect(qualify).toHaveBeenCalledWith(
      {
        llmBaseUrl: "https://draft-provider.example.test",
        apiKey: "draft-provider-key",
        chatModel: "draft-chat",
        embedModel: "draft-embed",
        embeddingDimension: 768,
      },
      3
    );
    expect(audit.mock.calls).toEqual([
      ["remote_turn", ACCOUNT_ID, "draft-provider.example.test"],
      ["remote_ingest", ACCOUNT_ID, "draft-provider.example.test"],
    ]);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/draft-provider-key|draft-chat|draft-embed/);
    expect((await store.read()).settings).toEqual(DEFAULT_LLM_SETTINGS);
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses environment-managed effective fields and rejects attempts to shadow them", async () => {
    const { store } = await temporaryStore({
      LLM_BASE_URL: "https://environment-provider.example.test",
      LLM_API_KEY: "environment-provider-key",
      LLM_CHAT_MODEL: "environment-chat",
      LLM_EMBED_MODEL: "environment-embed",
    });
    const qualify = vi.fn(async () => successfulQualification);
    const app = await buildApp(store, { qualify, audit: vi.fn(async () => undefined) });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: auth,
      payload: {
        expected_dimension: 3,
        remote_egress_ack_origin: "https://environment-provider.example.test",
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(qualify).toHaveBeenCalledWith(
      {
        llmBaseUrl: "https://environment-provider.example.test",
        apiKey: "environment-provider-key",
        chatModel: "environment-chat",
        embedModel: "environment-embed",
        embeddingDimension: 768,
      },
      3
    );
    expect(accepted.body).not.toMatch(/environment-provider|environment-chat|environment-embed/);

    qualify.mockClear();
    const managed = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: { ...auth, "x-request-id": "qualification.managed" },
      payload: {
        llm_base_url: "https://ignored.example.test",
        expected_dimension: 3,
        remote_egress_ack_origin: "https://ignored.example.test",
      },
    });
    expect(managed.statusCode).toBe(409);
    expect(managed.json()).toEqual({
      error: "setting is managed by environment",
      request_id: "qualification.managed",
    });
    expect(managed.body).not.toMatch(/environment-provider|ignored\.example|environment-provider-key/);
    expect(qualify).not.toHaveBeenCalled();
  });

  it("does not require acknowledgment or emit audit events for a loopback draft", async () => {
    const { store } = await temporaryStore();
    const qualify = vi.fn(async () => successfulQualification);
    const audit = vi.fn(async () => undefined);
    const app = await buildApp(store, { qualify, audit });

    const response = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: auth,
      payload: { expected_dimension: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(qualify).toHaveBeenCalledWith(DEFAULT_LLM_SETTINGS, 3);
    expect(audit).not.toHaveBeenCalled();
  });

  it("keeps content-free audit best-effort for an acknowledged remote draft", async () => {
    const { store } = await temporaryStore();
    const qualify = vi.fn(async () => successfulQualification);
    const audit = vi.fn(async () => {
      throw new Error("private audit failure");
    });
    const app = await buildApp(store, { qualify, audit });

    const response = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: auth,
      payload: {
        llm_base_url: "https://remote.example.test",
        expected_dimension: 3,
        remote_egress_ack_origin: "https://remote.example.test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(successfulQualification);
    expect(response.body).not.toContain("private audit failure");
    expect(audit).toHaveBeenCalledTimes(2);
    expect(qualify).toHaveBeenCalledTimes(1);
  });

  it("authenticates before parsing and enforces the explicit qualification body limit and schema", async () => {
    const { store } = await temporaryStore();
    const read = vi.spyOn(store, "read");
    const qualify = vi.fn(async () => successfulQualification);
    const app = await buildApp(store, { qualify, audit: vi.fn(async () => undefined) });
    const oversizedPrefix = '{"expected_dimension":3,"padding":"';
    const oversizedSuffix = '"}';
    const oversizedPayload = `${oversizedPrefix}${"x".repeat(
      SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES + 1 - Buffer.byteLength(oversizedPrefix) - Buffer.byteLength(oversizedSuffix)
    )}${oversizedSuffix}`;
    expect(Buffer.byteLength(oversizedPayload)).toBe(SETTINGS_DRAFT_JSON_BODY_LIMIT_BYTES + 1);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: { "content-type": "application/json" },
      payload: oversizedPayload,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(qualify).not.toHaveBeenCalled();

    const oversized = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: { ...auth, "content-type": "application/json", "x-request-id": "qualification.large" },
      payload: oversizedPayload,
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body).not.toContain("x".repeat(100));
    expect(read).not.toHaveBeenCalled();

    const invalid = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: auth,
      payload: { expected_dimension: 0 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(qualify).not.toHaveBeenCalled();
  });

  it("names the offending settings field on qualification and omits it when validation has none", async () => {
    const { store } = await temporaryStore();
    const qualify = vi.fn(async () => successfulQualification);
    const app = await buildApp(store, { qualify, audit: vi.fn(async () => undefined) });

    const mismatched = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: { ...auth, "x-request-id": "qualification.dimension" },
      payload: { expected_dimension: 3, embedding_dimension: 4 },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toEqual({
      error: "invalid settings",
      field: "embedding_dimension",
      request_id: "qualification.dimension",
    });

    const identical = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: { ...auth, "x-request-id": "qualification.identical" },
      payload: { expected_dimension: 3, default_chat_model: "same", default_embed_model: "same" },
    });
    expect(identical.statusCode).toBe(400);
    expect(identical.json()).toEqual({
      error: "invalid settings",
      field: "default_embed_model",
      request_id: "qualification.identical",
    });
    expect(qualify).not.toHaveBeenCalled();

    const fieldlessApp = await buildApp(
      {
        read: async () => {
          throw new SettingsValidationError();
        },
        patch: (patch) => store.patch(patch),
        preview: (patch) => store.preview(patch),
        subscribe: (listener) => store.subscribe(listener),
      },
      { qualify, audit: vi.fn(async () => undefined) }
    );
    const fieldless = await fieldlessApp.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: { ...auth, "x-request-id": "qualification.fieldless" },
      payload: { expected_dimension: 3 },
    });
    expect(fieldless.statusCode).toBe(400);
    expect(fieldless.json()).toEqual({ error: "invalid settings", request_id: "qualification.fieldless" });
    expect(fieldless.json()).not.toHaveProperty("field");
    expect(qualify).not.toHaveBeenCalled();
  });

  it("does not reuse durable consent for a remote draft and records only content-free categories when acknowledged", async () => {
    const { store } = await temporaryStore();
    await store.patch({
      llmBaseUrl: "https://new-provider.example.test",
      apiKey: "new-provider-key",
      chatModel: "new-chat",
      embedModel: "new-embed",
    });
    const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-model-qualification-ledger-"));
    temporaryDirectories.push(runtimeDirectory);
    const runtime = await initializeStorageRuntime({
      sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
      lanceDirectory: path.join(runtimeDirectory, "lancedb"),
      embeddingDimension: 3,
    });
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      ACCOUNT_ID,
      "owner@example.test",
      "hash",
    ]);
    await runtime.chats.acknowledgeRemoteEgress(ACCOUNT_ID, "2026-08-31T00:00:00.000Z");
    const app = await buildApp(store, { qualify: vi.fn(async () => successfulQualification) });

    const denied = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: auth,
      payload: { expected_dimension: 3 },
    });
    expect(denied.statusCode).toBe(403);
    expect(await runtime.ledger.all("SELECT * FROM egress_events")).toEqual([]);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/models/qualify",
      headers: auth,
      payload: {
        expected_dimension: 3,
        remote_egress_ack_origin: "https://new-provider.example.test",
      },
    });
    expect(accepted.statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await runtime.ledger.all("SELECT 1 FROM egress_events")).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const events = await storageRuntime().ledger.all<{ kind: string; endpoint_host: string }>(
      "SELECT kind,endpoint_host FROM egress_events ORDER BY id"
    );
    expect(events).toEqual([
      { kind: "remote_turn", endpoint_host: "new-provider.example.test" },
      { kind: "remote_ingest", endpoint_host: "new-provider.example.test" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/new-provider-key|new-chat|new-embed/);
  });
});
