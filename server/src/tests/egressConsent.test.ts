import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { endpointHost, isRemoteProvider } from "../egressPolicy.js";
import { installHttpBoundary } from "../httpErrors.js";
import { consentRoutes } from "../routes/consent.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime } from "../storageRuntime.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

const auth = {
  authorization: `Bearer ${signToken({ userId: ACCOUNT_ID, email: "owner@example.test" })}`,
};

let runtimeDirectory = "";
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-egress-consent-"));
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
  await initializeRuntimeSettings({
    settingsFile: path.join(runtimeDirectory, "settings.json"),
    env: {},
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  closeRuntimeSettings();
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(consentRoutes);
  await app.ready();
  return app;
}

describe("remote egress consent", () => {
  it("ships schema v4 with a nullable acknowledgment column on users", async () => {
    const { storageRuntime } = await import("../storageRuntime.js");
    const version = await storageRuntime().ledger.get<{ user_version: unknown }>("PRAGMA user_version");
    expect(Number(version?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    const columns = await storageRuntime().ledger.all<{ name: string }>("PRAGMA table_info(users)");
    expect(columns.map((column) => column.name)).toContain("remote_egress_ack_at");
  });

  it("classifies providers and derives the destination host", () => {
    expect(isRemoteProvider("http://127.0.0.1:1234")).toBe(false);
    expect(isRemoteProvider("http://spark.lan:8000")).toBe(false);
    expect(isRemoteProvider("https://api.provider.example")).toBe(true);
    expect(endpointHost("https://api.provider.example")).toBe("api.provider.example");
    expect(endpointHost("http://127.0.0.1:1234")).toBe("127.0.0.1:1234");
  });

  it("reports local providers as non-gating and without a destination", async () => {
    const app = await buildApp();
    const state = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({ required: false, acknowledged_at: null, endpoint_host: null });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/consent/remote-egress" });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("gates nothing until acknowledged, then unblocks after acknowledging a remote provider", async () => {
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider.example" });
    const app = await buildApp();

    const before = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(before.json()).toEqual({
      required: true,
      acknowledged_at: null,
      endpoint_host: "api.provider.example",
    });

    const acknowledged = await app.inject({ method: "POST", url: "/api/consent/remote-egress", headers: auth });
    expect(acknowledged.statusCode).toBe(200);
    const ackBody = acknowledged.json();
    expect(ackBody).toMatchObject({ required: true, endpoint_host: "api.provider.example" });
    expect(typeof ackBody.acknowledged_at).toBe("string");
    expect(Number.isNaN(Date.parse(ackBody.acknowledged_at))).toBe(false);

    const after = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(after.json()).toMatchObject({ required: true, acknowledged_at: ackBody.acknowledged_at });

    // Switching back to loopback lifts the gate without restarting anything.
    await runtimeSettingsStore().patch({ llmBaseUrl: "http://127.0.0.1:1234" });
    const local = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(local.json()).toEqual({ required: false, acknowledged_at: ackBody.acknowledged_at, endpoint_host: null });
  });
});
