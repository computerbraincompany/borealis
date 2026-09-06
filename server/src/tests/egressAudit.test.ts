import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { remoteEgressState, remoteEgressTargetFromSnapshot } from "../egressPolicy.js";
import { auditRemoteEgressTarget, listEgressEvents, recordEgressEvent } from "../egressAudit.js";
import { installHttpBoundary } from "../httpErrors.js";
import { auditRoutes } from "../routes/audit.js";
import { consentRoutes } from "../routes/consent.js";
import {
  closeRuntimeSettings,
  getRuntimeSettings,
  initializeRuntimeSettings,
  runtimeSettingsStore,
} from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ownerAuth = {
  authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}`,
};

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-egress-audit-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
    lanceDirectory: path.join(runtimeDirectory, "lancedb"),
    embeddingDimension: 3,
  });
  await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    OWNER,
    "owner@example.test",
    "hash",
  ]);
  await initializeRuntimeSettings({ settingsFile: path.join(runtimeDirectory, "settings.json"), env: {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
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
  await app.register(auditRoutes);
  await app.register(consentRoutes);
  await app.ready();
  return app;
}

describe("egress audit", () => {
  it("ships schema v7 with the content-free egress_events table", async () => {
    const version = await storageRuntime().ledger.get<{ user_version: unknown }>("PRAGMA user_version");
    expect(Number(version?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    const columns = await storageRuntime().ledger.all<{ name: string }>("PRAGMA table_info(egress_events)");
    expect(columns.map((column) => column.name).sort()).toEqual([
      "account_id",
      "created_at",
      "endpoint_host",
      "id",
      "kind",
    ]);
  });

  it("records consent, remote turns, and remote ingests without content", async () => {
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider.example" });
    await recordEgressEvent("consent_acknowledged", OWNER, "api.provider.example");
    const remoteTarget = remoteEgressTargetFromSnapshot(await getRuntimeSettings());
    await auditRemoteEgressTarget("remote_turn", OWNER, remoteTarget);
    await auditRemoteEgressTarget("remote_ingest", OWNER, remoteTarget);

    const events = await listEgressEvents(OWNER, 50);
    expect(events.map((event) => event.kind)).toEqual(["remote_ingest", "remote_turn", "consent_acknowledged"]);
    expect(events.every((event) => event.endpoint_host === "api.provider.example")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/prompt|content|sql/i);

    // Loopback targets never write remote events, even when named directly.
    await runtimeSettingsStore().patch({ llmBaseUrl: "http://127.0.0.1:1234" });
    await auditRemoteEgressTarget("remote_turn", OWNER, remoteEgressTargetFromSnapshot(await getRuntimeSettings()));
    expect(await listEgressEvents(OWNER, 50)).toHaveLength(3);
  });

  it("records the acknowledgment through the consent route", async () => {
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider.example" });
    const app = await buildApp();
    const acknowledged = await app.inject({
      method: "POST",
      url: "/api/consent/remote-egress",
      headers: ownerAuth,
    });
    expect(acknowledged.json()).toMatchObject({ endpoint_host: "api.provider.example" });
    const events = await listEgressEvents(OWNER, 50);
    expect(events[0]).toMatchObject({ kind: "consent_acknowledged", endpoint_host: "api.provider.example" });
    const current = await remoteEgressState(OWNER);
    expect(current.required).toBe(true);
  });

  it("never lets an audit failure fail the caller", async () => {
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider.example" });
    const remoteTarget = remoteEgressTargetFromSnapshot(await getRuntimeSettings());
    await closeStorageRuntime();
    await expect(recordEgressEvent("remote_turn", OWNER, null)).resolves.toBeUndefined();
    await expect(auditRemoteEgressTarget("remote_turn", OWNER, remoteTarget)).resolves.toBeUndefined();
  });

  it("serves the bounded audit list tenant-scoped", async () => {
    await recordEgressEvent("remote_turn", OWNER, "api.provider.example");
    const app = await buildApp();

    const unauthenticated = await app.inject({ method: "GET", url: "/api/audit/egress" });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({ method: "GET", url: "/api/audit/egress?limit=10", headers: ownerAuth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]).toMatchObject({ kind: "remote_turn", endpoint_host: "api.provider.example" });

    const oversize = await app.inject({ method: "GET", url: "/api/audit/egress?limit=500", headers: ownerAuth });
    expect(oversize.statusCode).toBe(400);
  });
});
