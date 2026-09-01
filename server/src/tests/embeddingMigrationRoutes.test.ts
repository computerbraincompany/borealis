import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signToken } from "../auth.js";
import {
  EmbeddingMigrationError,
  type EmbeddingMigrationOperations,
  type EmbeddingMigrationStatus,
} from "../embeddingMigration.js";
import { installHttpBoundary } from "../httpErrors.js";
import type { ModelPairQualificationResult } from "../llm.js";
import { createEmbeddingMigrationRoutes, MODEL_PAIR_NOT_QUALIFIED_CODE } from "../routes/embeddingMigration.js";
import { createSettingsStore, type EffectiveLlmSettings, type SettingsStore } from "../settingsStore.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const auth = { authorization: `Bearer ${signToken({ userId: ACCOUNT, email: "owner@example.test" })}` };
const idle: EmbeddingMigrationStatus = {
  phase: "idle",
  target_model: null,
  target_dimension: null,
  source_count: 0,
  chunk_count: 0,
  indexed_count: 0,
  error_code: null,
  restart_required: false,
  can_cancel: false,
  can_retry: false,
  can_apply: false,
};
const building: EmbeddingMigrationStatus = {
  ...idle,
  phase: "building",
  target_model: "new-embed",
  target_dimension: 5,
  source_count: 2,
  chunk_count: 10,
  indexed_count: 3,
  can_cancel: true,
};
const qualified: ModelPairQualificationResult = {
  chat: { qualified: true, reason_code: "qualified", latency_ms: 1 },
  embedding: { qualified: true, reason_code: "qualified", dimension: 5, latency_ms: 1 },
};

const directories: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function makeStore(env: Readonly<Record<string, string | undefined>> = {}): Promise<SettingsStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-embedding-migration-routes-"));
  directories.push(directory);
  const store = createSettingsStore({ path: path.join(directory, "settings.json"), env });
  await store.patch({
    chatModel: "chat-model",
    embedModel: "old-embed",
    ...(env.EMBEDDING_DIM === undefined ? { embeddingDimension: 3 } : {}),
  });
  return store;
}

function operations(overrides: Partial<EmbeddingMigrationOperations> = {}): EmbeddingMigrationOperations {
  return {
    status: vi.fn(async () => idle),
    start: vi.fn(async () => building),
    retry: vi.fn(async () => building),
    cancel: vi.fn(async () => idle),
    requestApply: vi.fn(async (): Promise<EmbeddingMigrationStatus> => ({
      ...building,
      phase: "apply_pending",
      restart_required: true,
    })),
    ...overrides,
  };
}

async function buildApp(options: {
  readonly store: SettingsStore;
  readonly coordinator?: EmbeddingMigrationOperations;
  readonly qualify?: (settings: EffectiveLlmSettings, dimension: number) => Promise<ModelPairQualificationResult>;
  readonly consent?: (reply: FastifyReply, account: string) => Promise<boolean>;
}): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(
    createEmbeddingMigrationRoutes({
      coordinator: options.coordinator ?? operations(),
      store: options.store,
      ...(options.qualify ? { qualify: options.qualify } : {}),
      ...(options.consent ? { consent: options.consent } : { consent: vi.fn(async () => true) }),
      audit: vi.fn(async () => undefined),
    })
  );
  await app.ready();
  return app;
}

describe("managed embedding migration routes", () => {
  it("authenticates status before touching process-wide migration state", async () => {
    const store = await makeStore();
    const coordinator = operations();
    const app = await buildApp({ store, coordinator });

    expect((await app.inject({ method: "GET", url: "/api/models/embedding-migration" })).statusCode).toBe(401);
    expect(coordinator.status).not.toHaveBeenCalled();
    const response = await app.inject({ method: "GET", url: "/api/models/embedding-migration", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(idle);
  });

  it("qualifies the exact target pair before starting and returns only aggregate status", async () => {
    const store = await makeStore();
    const coordinator = operations();
    const qualifyPair = vi.fn(async () => qualified);
    const consent = vi.fn(async () => true);
    const app = await buildApp({ store, coordinator, qualify: qualifyPair, consent });

    const response = await app.inject({
      method: "POST",
      url: "/api/models/embedding-migration/start",
      headers: auth,
      payload: { target_embed_model: "new-embed", target_dimension: 5 },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(building);
    expect(consent).toHaveBeenCalledWith(expect.anything(), ACCOUNT);
    expect(qualifyPair).toHaveBeenCalledWith(
      expect.objectContaining({ chatModel: "chat-model", embedModel: "new-embed", embeddingDimension: 5 }),
      5
    );
    expect(coordinator.start).toHaveBeenCalledWith(
      { model: "new-embed", dimension: 5 },
      {
        baseline: expect.objectContaining({
          chatModel: "chat-model",
          embedModel: "old-embed",
          embeddingDimension: 3,
        }),
        target: expect.objectContaining({
          chatModel: "chat-model",
          embedModel: "new-embed",
          embeddingDimension: 5,
        }),
      }
    );
    expect(response.body).not.toMatch(/request_id|migrationRoot|stateFile|apiKey/);
  });

  it("rejects an unqualified target without creating migration state", async () => {
    const store = await makeStore();
    const coordinator = operations();
    const qualifyPair = vi.fn(async () => ({
      ...qualified,
      embedding: { qualified: false, reason_code: "dimension-mismatch" as const, dimension: 3, latency_ms: 1 },
    }));
    const app = await buildApp({ store, coordinator, qualify: qualifyPair });

    const response = await app.inject({
      method: "POST",
      url: "/api/models/embedding-migration/start",
      headers: auth,
      payload: { target_embed_model: "new-embed", target_dimension: 5 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "model pair qualification failed",
      code: MODEL_PAIR_NOT_QUALIFIED_CODE,
    });
    expect(coordinator.start).not.toHaveBeenCalled();
  });

  it("keeps the start body bounded and rejects environment-managed dimensions", async () => {
    const store = await makeStore({ EMBEDDING_DIM: "3" });
    const qualifyPair = vi.fn(async () => qualified);
    const app = await buildApp({ store, qualify: qualifyPair });

    const oversized = await app.inject({
      method: "POST",
      url: "/api/models/embedding-migration/start",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ target_embed_model: "x".repeat(9_000), target_dimension: 5 }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(qualifyPair).not.toHaveBeenCalled();

    const managed = await app.inject({
      method: "POST",
      url: "/api/models/embedding-migration/start",
      headers: auth,
      payload: { target_embed_model: "new-embed", target_dimension: 5 },
    });
    expect(managed.statusCode).toBe(409);
    expect(managed.body).not.toContain("EMBEDDING_DIM");
    expect(qualifyPair).not.toHaveBeenCalled();
  });

  it("maps retry, cancellation, apply, and stable coordinator failures", async () => {
    const store = await makeStore();
    const coordinator = operations({
      retry: vi.fn(async () => {
        throw new EmbeddingMigrationError("NO_FAILED_MIGRATION", 404);
      }),
    });
    const app = await buildApp({ store, coordinator });

    const retry = await app.inject({
      method: "POST",
      url: "/api/models/embedding-migration/retry",
      headers: { ...auth, "x-request-id": "migration.retry" },
    });
    expect(retry.statusCode).toBe(404);
    expect(retry.json()).toEqual({
      error: "there is no failed embedding migration to retry",
      code: "NO_FAILED_MIGRATION",
      request_id: "migration.retry",
    });

    expect(
      (await app.inject({ method: "POST", url: "/api/models/embedding-migration/cancel", headers: auth })).statusCode
    ).toBe(202);
    expect(
      (await app.inject({ method: "POST", url: "/api/models/embedding-migration/apply", headers: auth })).json()
    ).toMatchObject({ phase: "apply_pending", restart_required: true });
  });
});
