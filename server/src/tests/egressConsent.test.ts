import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import {
  endpointHost,
  isRemoteProvider,
  RemoteEgressConsentRequiredError,
  requireRemoteEgressConsent,
} from "../egressPolicy.js";
import { listEgressEvents } from "../egressAudit.js";
import { StoreNotFoundError } from "../db/stores/chatStore.js";
import { SettingsValidationError } from "../settingsStore.js";
import { installHttpBoundary } from "../httpErrors.js";
import { consentRoutes } from "../routes/consent.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
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
  vi.restoreAllMocks();
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
  it("ships the nullable acknowledgment pair on users (v4 timestamp, v14 origin)", async () => {
    const version = await storageRuntime().ledger.get<{ user_version: unknown }>("PRAGMA user_version");
    expect(Number(version?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    const columns = await storageRuntime().ledger.all<{ name: string }>("PRAGMA table_info(users)");
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["remote_egress_ack_at", "remote_egress_ack_origin"])
    );
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

  it("binds a durable acknowledgment to its exact canonical origin (A -> B -> A, then B replaces A)", async () => {
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-a.example" });
    const app = await buildApp();

    const acknowledgedA = await app.inject({ method: "POST", url: "/api/consent/remote-egress", headers: auth });
    expect(acknowledgedA.statusCode).toBe(200);
    await expect(storedPair()).resolves.toMatchObject({ origin: "https://api.provider-a.example" });

    // Consent for A never authorizes B: the public timestamp stays null.
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-b.example" });
    const blockedB = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(blockedB.json()).toEqual({
      required: true,
      acknowledged_at: null,
      endpoint_host: "api.provider-b.example",
    });
    await expect(requireRemoteEgressConsent(ACCOUNT_ID)).rejects.toBeInstanceOf(RemoteEgressConsentRequiredError);

    // Returning to A reuses the durable A acknowledgment.
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-a.example" });
    const backToA = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(backToA.json()).toMatchObject({
      required: true,
      acknowledged_at: acknowledgedA.json().acknowledged_at,
      endpoint_host: "api.provider-a.example",
    });
    await expect(requireRemoteEgressConsent(ACCOUNT_ID)).resolves.toBeUndefined();

    // Acknowledging B replaces A; A is blocked again.
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-b.example" });
    const acknowledgedB = await app.inject({ method: "POST", url: "/api/consent/remote-egress", headers: auth });
    expect(acknowledgedB.statusCode).toBe(200);
    await expect(storedPair()).resolves.toMatchObject({ origin: "https://api.provider-b.example" });
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-a.example" });
    await expect(requireRemoteEgressConsent(ACCOUNT_ID)).rejects.toBeInstanceOf(RemoteEgressConsentRequiredError);
    const blockedA = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(blockedA.json()).toMatchObject({ required: true, acknowledged_at: null });
  });

  it("compares only the canonical origin spelling the Settings parser produces", async () => {
    // An uppercase/host-mixed endpoint is canonicalized by the Settings parser
    // before it reaches consent: the stored pair and every later comparison
    // use the exact same canonical URL.origin string.
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://API.Provider-A.Example" });
    const app = await buildApp();
    const acknowledged = await app.inject({ method: "POST", url: "/api/consent/remote-egress", headers: auth });
    expect(acknowledged.json()).toMatchObject({ required: true, endpoint_host: "api.provider-a.example" });
    await expect(storedPair()).resolves.toMatchObject({ origin: "https://api.provider-a.example" });
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-a.example" });
    await expect(requireRemoteEgressConsent(ACCOUNT_ID)).resolves.toBeUndefined();
    const state = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(state.json().acknowledged_at).not.toBeNull();
  });

  it("never treats a legacy timestamp-only or malformed stored origin as acknowledged", async () => {
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-a.example" });
    const app = await buildApp();

    // A pre-v14 timestamp-only row is unacknowledged for every remote origin.
    await storageRuntime().ledger.run(
      "UPDATE users SET remote_egress_ack_at=?,remote_egress_ack_origin=NULL WHERE id=?",
      ["2026-09-01T00:00:00.000Z", ACCOUNT_ID]
    );
    const legacy = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(legacy.json()).toEqual({
      required: true,
      acknowledged_at: null,
      endpoint_host: "api.provider-a.example",
    });
    await expect(requireRemoteEgressConsent(ACCOUNT_ID)).rejects.toBeInstanceOf(RemoteEgressConsentRequiredError);

    // A malformed stored origin fails closed and is never exposed.
    await storageRuntime().ledger.run("UPDATE users SET remote_egress_ack_origin=? WHERE id=?", [
      "https://user:secret@api.provider-a.example.evil.test/../x",
      ACCOUNT_ID,
    ]);
    await expect(requireRemoteEgressConsent(ACCOUNT_ID)).rejects.toBeInstanceOf(RemoteEgressConsentRequiredError);
    const malformed = await app.inject({ method: "GET", url: "/api/consent/remote-egress", headers: auth });
    expect(malformed.json()).toMatchObject({ acknowledged_at: null });
    expect(JSON.stringify(malformed.json())).not.toContain("secret");

    // An origin that merely looks equivalent but is not the canonical stored
    // string (trailing slash) also fails the exact-match comparison.
    await storageRuntime().ledger.run("UPDATE users SET remote_egress_ack_origin=? WHERE id=?", [
      "https://api.provider-a.example/",
      ACCOUNT_ID,
    ]);
    await expect(requireRemoteEgressConsent(ACCOUNT_ID)).rejects.toBeInstanceOf(RemoteEgressConsentRequiredError);
  });

  it("writes only the canonical pair through the store and preserves account-not-found", async () => {
    const chats = storageRuntime().chats;
    await expect(
      chats.acknowledgeRemoteEgress(ACCOUNT_ID, new Date().toISOString(), "https://api.provider-a.example/payload")
    ).rejects.toBeInstanceOf(SettingsValidationError);
    await expect(
      chats.acknowledgeRemoteEgress(ACCOUNT_ID, new Date().toISOString(), "x".repeat(2049))
    ).rejects.toBeInstanceOf(SettingsValidationError);
    await expect(
      chats.acknowledgeRemoteEgress(
        "99999999-9999-4999-8999-999999999999",
        new Date().toISOString(),
        "https://api.provider-a.example"
      )
    ).rejects.toBeInstanceOf(StoreNotFoundError);
    await expect(chats.getRemoteEgressAcknowledgment("99999999-9999-4999-8999-999999999999")).rejects.toBeInstanceOf(
      StoreNotFoundError
    );

    const timestamp = "2026-09-06T00:00:00.000Z";
    await chats.acknowledgeRemoteEgress(ACCOUNT_ID, timestamp, "https://api.provider-a.example");
    await expect(chats.getRemoteEgressAcknowledgment(ACCOUNT_ID)).resolves.toEqual({
      acknowledgedAt: timestamp,
      origin: "https://api.provider-a.example",
    });
  });

  it("keeps a local/private POST silent: no pair overwrite, no consent event", async () => {
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-a.example" });
    const app = await buildApp();
    // A remote re-acknowledgment legitimately refreshes the pair.
    await app.inject({ method: "POST", url: "/api/consent/remote-egress", headers: auth });
    await app.inject({ method: "POST", url: "/api/consent/remote-egress", headers: auth });
    const eventsBefore = await listEgressEvents(ACCOUNT_ID, 50);
    const pairBefore = await storedPair();
    expect(pairBefore.origin).toBe("https://api.provider-a.example");
    expect(eventsBefore.length).toBeGreaterThan(0);

    await runtimeSettingsStore().patch({ llmBaseUrl: "http://127.0.0.1:1234" });
    const localPost = await app.inject({ method: "POST", url: "/api/consent/remote-egress", headers: auth });
    expect(localPost.statusCode).toBe(200);
    // Compatibility: loopback still displays the remembered timestamp, origin hidden.
    expect(localPost.json()).toEqual({ required: false, acknowledged_at: pairBefore.ts, endpoint_host: null });
    expect(Object.keys(localPost.json()).sort()).toEqual(["acknowledged_at", "endpoint_host", "required"]);

    await expect(storedPair()).resolves.toEqual({ ts: pairBefore.ts, origin: pairBefore.origin });
    await expect(listEgressEvents(ACCOUNT_ID, 50)).resolves.toHaveLength(eventsBefore.length);

    // A private provider bypasses the gate without touching the pair either.
    await runtimeSettingsStore().patch({ llmBaseUrl: "http://spark.local:8000" });
    await expect(requireRemoteEgressConsent(ACCOUNT_ID)).resolves.toBeUndefined();
    await expect(storedPair()).resolves.toEqual({ ts: pairBefore.ts, origin: pairBefore.origin });
  });

  it("attributes the acknowledgment audit to the origin actually persisted across an A -> B race", async () => {
    await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-a.example" });
    const app = await buildApp();
    const chats = storageRuntime().chats;
    const original = chats.acknowledgeRemoteEgress.bind(chats);
    const raced = vi.spyOn(chats, "acknowledgeRemoteEgress").mockImplementation(async (...args) => {
      // A is durably stored first; the effective provider then races to B
      // before the public-state re-read inside acknowledgment.
      await original(...args);
      await runtimeSettingsStore().patch({ llmBaseUrl: "https://api.provider-b.example" });
    });

    const response = await app.inject({ method: "POST", url: "/api/consent/remote-egress", headers: auth });
    raced.mockRestore();

    // The response describes unacknowledged B...
    expect(response.json()).toEqual({
      required: true,
      acknowledged_at: null,
      endpoint_host: "api.provider-b.example",
    });
    // ...the durable pair remains A...
    await expect(storedPair()).resolves.toMatchObject({ origin: "https://api.provider-a.example" });
    // ...and exactly one content-free audit row names A.
    const events = await listEgressEvents(ACCOUNT_ID, 50);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "consent_acknowledged", endpoint_host: "api.provider-a.example" });
  });
});

async function storedPair(): Promise<{ ts: string | null; origin: string | null }> {
  const row = await storageRuntime().ledger.get<{
    remote_egress_ack_at: string | null;
    remote_egress_ack_origin: string | null;
  }>("SELECT remote_egress_ack_at,remote_egress_ack_origin FROM users WHERE id=?", [ACCOUNT_ID]);
  return { ts: row?.remote_egress_ack_at ?? null, origin: row?.remote_egress_ack_origin ?? null };
}
