import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { EmbeddingReindexRequiredError } from "../embeddingMigration.js";
import { installHttpBoundary } from "../httpErrors.js";
import { createSettingsRoutes, probeSettingsConnection } from "../routes/settings.js";
import {
  createSettingsStore,
  type LlmSettingsPatch,
  type SettingsSnapshot,
  type SettingsStore,
} from "../settingsStore.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const auth = {
  authorization: `Bearer ${signToken({ userId: ACCOUNT_ID, email: "owner@example.test" })}`,
};
const temporaryDirectories: string[] = [];
const apps: FastifyInstance[] = [];
const servers: http.Server[] = [];

async function temporaryStore(
  env: Readonly<Record<string, string | undefined>> = {}
): Promise<{ store: SettingsStore; filename: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-settings-routes-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "settings.json");
  return { store: createSettingsStore({ path: filename, env }), filename };
}

async function buildApp(
  store: SettingsStore,
  options: {
    timeoutMs?: number;
    patch?: (patch: LlmSettingsPatch) => Promise<SettingsSnapshot>;
  } = {}
): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(
    createSettingsRoutes({
      store,
      ...(options.timeoutMs === undefined ? {} : { connectionTimeoutMs: options.timeoutMs }),
      ...(options.patch === undefined ? {} : { patch: options.patch }),
    })
  );
  await app.ready();
  return app;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("authenticated settings routes", () => {
  it("redacts credentials on GET and does not touch settings before authentication", async () => {
    const { store } = await temporaryStore();
    await store.patch({
      llmBaseUrl: "https://models.example.test",
      apiKey: "never-return-this-key",
      chatModel: "chat-model",
      embedModel: "embed-model",
    });
    const read = vi.spyOn(store, "read");
    const app = await buildApp(store);

    const denied = await app.inject({ method: "GET", url: "/api/settings" });
    expect(denied.statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();

    const response = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      llm_base_url: "https://models.example.test",
      llm_api_key_configured: true,
      lm_studio_base_url: null,
      default_chat_model: "chat-model",
      default_embed_model: "embed-model",
      embedding_dimension: 768,
    });
    expect(response.body).not.toContain("never-return-this-key");
    expect(response.json()).not.toHaveProperty("llm_api_key");
  });

  it("PATCH preserves an omitted key, supports explicit clear, and returns only the redacted shape", async () => {
    const { store, filename } = await temporaryStore();
    const app = await buildApp(store);

    const configured = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...auth, "x-request-id": "settings.patch" },
      payload: {
        llm_base_url: "https://provider.example.test",
        llm_api_key: "patch-secret",
        lm_studio_base_url: "http://localhost:1234",
        default_chat_model: "provider-chat",
        default_embed_model: "provider-embed",
        embedding_dimension: 384,
      },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({
      llm_api_key_configured: true,
      default_chat_model: "provider-chat",
      embedding_dimension: 384,
    });
    expect(configured.body).not.toContain("patch-secret");

    const preserved = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: auth,
      payload: { default_chat_model: "provider-chat-v2" },
    });
    expect(preserved.statusCode).toBe(200);
    expect(preserved.json().llm_api_key_configured).toBe(true);
    expect((JSON.parse(await fs.readFile(filename, "utf8")) as { llm_api_key?: string }).llm_api_key).toBe(
      "patch-secret"
    );

    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: auth,
      payload: { llm_api_key: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().llm_api_key_configured).toBe(false);
    expect(cleared.json()).not.toHaveProperty("llm_api_key");
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).not.toHaveProperty("llm_api_key");
  });

  it("returns a stable reindex-required conflict for generic embedding identity changes", async () => {
    const { store } = await temporaryStore();
    const patch = vi.fn(async (_input: LlmSettingsPatch): Promise<SettingsSnapshot> => {
      throw new EmbeddingReindexRequiredError();
    });
    const app = await buildApp(store, { patch });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...auth, "x-request-id": "settings.reindex" },
      payload: { default_embed_model: "new-embed", embedding_dimension: 384 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "embedding reindex is required",
      code: "EMBEDDING_REINDEX_REQUIRED",
      request_id: "settings.reindex",
    });
    expect(patch).toHaveBeenCalledWith({ embedModel: "new-embed", embeddingDimension: 384 });
  });

  it("returns opaque validation and environment-override errors without reflecting values", async () => {
    const { store } = await temporaryStore({ LLM_BASE_URL: "https://environment.example.test" });
    const app = await buildApp(store);
    const unsafeUrl = "http://public.example.test/private?secret=do-not-reflect";

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...auth, "x-request-id": "settings.invalid" },
      payload: { lm_studio_base_url: unsafeUrl },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid settings", request_id: "settings.invalid" });
    expect(invalid.body).not.toContain(unsafeUrl);
    expect(invalid.body).not.toContain("do-not-reflect");

    const managed = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { ...auth, "x-request-id": "settings.managed" },
      payload: { llm_base_url: "https://ignored.example.test" },
    });
    expect(managed.statusCode).toBe(409);
    expect(managed.json()).toEqual({
      error: "setting is managed by environment",
      request_id: "settings.managed",
    });
    expect(managed.body).not.toContain("environment.example.test");
    expect(managed.body).not.toContain("ignored.example.test");
  });

  it("tests a draft with a body-free authenticated GET /v1/models without persisting it", async () => {
    const observations: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
    const origin = await startCatalogServer((req, reply) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        observations.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body,
        });
        reply.writeHead(200, { "Content-Type": "application/json" });
        reply.end('{"data":[],"upstream_secret":"must-not-escape"}');
      });
    });
    const { store } = await temporaryStore();
    const app = await buildApp(store);

    const response = await app.inject({
      method: "POST",
      url: "/api/settings/test",
      headers: auth,
      payload: {
        llm_base_url: origin,
        llm_api_key: "draft-secret-key",
        default_chat_model: "draft-chat",
        default_embed_model: "draft-embed",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, latency_ms: expect.any(Number) });
    expect(response.body).not.toContain("draft-secret-key");
    expect(response.body).not.toContain("must-not-escape");
    expect(response.body).not.toContain(origin);
    expect(observations).toEqual([
      { method: "GET", url: "/v1/models", authorization: "Bearer draft-secret-key", body: "" },
    ]);

    const unchanged = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(unchanged.json()).toMatchObject({
      llm_base_url: "http://127.0.0.1:1234",
      llm_api_key_configured: false,
      default_chat_model: "qwen-chat",
      default_embed_model: "nomic-embed",
    });
  });

  it("turns upstream failure bodies into a bounded 503 and supports an empty draft", async () => {
    const origin = await startCatalogServer((_req, reply) => {
      reply.writeHead(401, { "Content-Type": "text/plain" });
      reply.end("private provider diagnostic and token");
    });
    const { store } = await temporaryStore();
    await store.patch({ llmBaseUrl: origin, apiKey: "stored-secret" });
    const app = await buildApp(store);

    const response = await app.inject({ method: "POST", url: "/api/settings/test", headers: auth });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
    expect(response.body).not.toContain("private provider diagnostic");
    expect(response.body).not.toContain("stored-secret");
    expect(response.body).not.toContain(origin);
  });
});

describe("settings connection probe", () => {
  it("enforces a bounded timeout and never supplies an outbound request body", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      expect(init).not.toHaveProperty("body");
      return new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("private timeout detail")), { once: true });
      });
    });
    const startedAt = Date.now();

    const result = await probeSettingsConnection(
      {
        llmBaseUrl: "https://provider.example.test",
        chatModel: "chat-model",
        embedModel: "embed-model",
        embeddingDimension: 768,
      },
      { fetch: fetchMock, timeoutMs: 15 }
    );

    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.test/v1/models",
      expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) })
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).toEqual({ Accept: "application/json", "Cache-Control": "no-store" });
  });
});

async function startCatalogServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP address");
  return `http://127.0.0.1:${address.port}`;
}
