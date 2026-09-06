import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../auth.js";
import { closeConnectionService, configureConnectionService } from "../connections/service.js";
import { FileConnectionSecretStore, FileKeyCustody } from "../connections/secrets.js";
import {
  McpTransportAuthError,
  McpTransportHandshakeError,
  McpTransportUnavailableError,
  setMcpTransportProvider,
  type McpToolDescriptor,
  type McpTransportProvider,
  type McpTransportTarget,
} from "../mcp/client.js";
import { installHttpBoundary } from "../httpErrors.js";
import { connectionRoutes } from "../routes/connections.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const ROUTE_SECRET = "route-secret-token-very-confidential";
const httpConfig = { url: "https://mcp.example.test/mcp" };
const TOOLS: McpToolDescriptor[] = [
  {
    name: "read_file",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

type FakeMode = "tools" | "auth" | "handshake" | "hang" | "over-limit";

class FakeMcpTransportProvider implements McpTransportProvider {
  mode: FakeMode = "tools";
  readonly targets: McpTransportTarget[] = [];
  closes = 0;

  async connect(
    target: McpTransportTarget
  ): Promise<{ listTools: (s: AbortSignal) => Promise<McpToolDescriptor[]>; close: () => Promise<void> }> {
    this.targets.push(structuredClone({ ...target, config: target.config }));
    if (this.mode === "auth") throw new McpTransportAuthError();
    if (this.mode === "handshake") throw new McpTransportHandshakeError();
    const mode = this.mode;
    return {
      listTools: async (signal: AbortSignal): Promise<McpToolDescriptor[]> => {
        if (mode === "hang") {
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new Error("aborted"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        }
        if (mode === "over-limit") {
          return Array.from({ length: 201 }, (_, index) => ({
            name: `tool-${index}`,
            description: "",
            input_schema: { type: "object" },
          }));
        }
        return TOOLS;
      },
      close: async () => {
        this.closes += 1;
      },
    };
  }
}

const apps: FastifyInstance[] = [];
const cleanups: Array<() => Promise<void>> = [];
let fake: FakeMcpTransportProvider;
let root = "";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(connectionRoutes);
  await app.ready();
  return app;
}

async function createConnection(
  app: FastifyInstance,
  body: Record<string, unknown> = { name: "Ops", kind: "mcp_http", config: httpConfig }
): Promise<Record<string, any>> {
  const response = await app.inject({ method: "POST", url: "/api/connections", headers: ownerAuth, body });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Record<string, any>;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-connections-"));
  cleanups.push(async () => {
    await fs.rm(root, { recursive: true, force: true });
    root = "";
  });
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(root, "ledger.sqlite"),
    lanceDirectory: path.join(root, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [FOREIGN, "foreign@example.test"],
  ] as const) {
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
  fake = new FakeMcpTransportProvider();
  configureConnectionService({
    secrets: () =>
      new FileConnectionSecretStore({
        directory: path.join(root, "secrets"),
        custody: new FileKeyCustody(path.join(root, "connections.key")),
      }),
    // Test-only shrink of the fixed 15-second transport bound so timeout
    // behavior is provable without a slow test suite.
    operationTimeoutMs: 150,
  });
  setMcpTransportProvider(fake);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setMcpTransportProvider(undefined);
  closeConnectionService();
  await closeStorageRuntime();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("connection routes", () => {
  it("authenticates, tenant-scopes, and validates every surface", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/api/connections" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/connections",
          body: { name: "X", kind: "mcp_http", config: httpConfig },
        })
      ).statusCode
    ).toBe(401);

    const created = await createConnection(app);
    const id = created.id as string;
    expect((await app.inject({ method: "GET", url: `/api/connections/${id}`, headers: foreignAuth })).statusCode).toBe(
      404
    );
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/connections/${id}`,
          headers: foreignAuth,
          body: { expected_revision: 1, name: "Hijack" },
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/connections/${id}`, headers: foreignAuth })).statusCode
    ).toBe(404);

    const nonHttps = await app.inject({
      method: "POST",
      url: "/api/connections",
      headers: ownerAuth,
      body: { name: "Bad", kind: "mcp_http", config: { url: "http://remote.example.com/mcp" } },
    });
    expect(nonHttps.statusCode).toBe(400);
    expect(nonHttps.json()).toMatchObject({ code: "CONNECTION_CONFIG_INVALID" });

    const badKind = await app.inject({
      method: "POST",
      url: "/api/connections",
      headers: ownerAuth,
      body: { name: "Bad", kind: "webdav", config: {} },
    });
    expect(badKind.statusCode).toBe(400);

    const missingSecretValue = await app.inject({
      method: "POST",
      url: "/api/connections",
      headers: ownerAuth,
      body: {
        name: "Bad",
        kind: "mcp_http",
        config: httpConfig,
        credentials: { headers: { authorization: "a\r\nb" } },
      },
    });
    expect(missingSecretValue.statusCode).toBe(400);
  });

  it("creates redacted connection DTOs that never serialize credentials", async () => {
    const app = await buildApp();
    const created = await createConnection(app, {
      name: "Ops",
      kind: "mcp_http",
      config: httpConfig,
      credentials: { headers: { authorization: `Bearer ${ROUTE_SECRET}` } },
    });
    expect(created).toMatchObject({
      name: "Ops",
      kind: "mcp_http",
      revision: 1,
      discovery_revision: 0,
      enabled: true,
      status: "untested",
      credential_state: "stored",
      config: { kind: "mcp_http", url: "https://mcp.example.test/mcp" },
      tools: [],
    });
    expect(Object.keys(created).sort()).toEqual(
      [
        "config",
        "created_at",
        "credential_state",
        "discovery_revision",
        "enabled",
        "id",
        "kind",
        "name",
        "revision",
        "status",
        "status_code",
        "tools",
        "updated_at",
      ].sort()
    );

    const bodies: string[] = [JSON.stringify(created)];
    const detail = await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth });
    expect(detail.statusCode).toBe(200);
    bodies.push(detail.body);
    const list = await app.inject({ method: "GET", url: "/api/connections", headers: ownerAuth });
    expect(list.statusCode).toBe(200);
    bodies.push(list.body);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, name: "Ops renamed" },
    });
    expect(patched.statusCode).toBe(200);
    bodies.push(patched.body);
    fake.mode = "tools";
    const tested = await app.inject({ method: "POST", url: `/api/connections/${created.id}/test`, headers: ownerAuth });
    expect(tested.statusCode).toBe(200);
    bodies.push(tested.body);
    const discovered = await app.inject({
      method: "POST",
      url: `/api/connections/${created.id}/discover`,
      headers: ownerAuth,
    });
    expect(discovered.statusCode).toBe(200);
    bodies.push(discovered.body);

    for (const body of bodies) {
      expect(body, "public DTO carries credential material").not.toContain(ROUTE_SECRET);
      expect(body).not.toContain("Bearer");
    }
    // The transport itself did receive the bound credentials.
    const lastTarget = fake.targets.at(-1)!;
    expect(lastTarget.secrets?.headers.authorization).toBe(`Bearer ${ROUTE_SECRET}`);
    expect(lastTarget.config).toEqual(expect.objectContaining({ url: "https://mcp.example.test/mcp" }));
    expect(fake.closes).toBe(fake.targets.length);
  });

  it("edits with optimistic revisions, rotates credentials, and enforces quotas", async () => {
    const app = await buildApp();
    const created = await createConnection(app);
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 99, name: "Stale" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "CONNECTION_REVISION_CONFLICT" });

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, name: "Renamed" },
    });
    expect(rename.json()).toMatchObject({ name: "Renamed", revision: 2 });

    const withCreds = await app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 2, credentials: { env: { API_KEY: ROUTE_SECRET } } },
    });
    expect(withCreds.statusCode).toBe(200);
    expect(withCreds.json()).toMatchObject({ revision: 2, credential_state: "stored" });
    expect(withCreds.body).not.toContain(ROUTE_SECRET);

    const revoked = await app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 2, credentials: null },
    });
    expect(revoked.json()).toMatchObject({ credential_state: "none" });

    for (let n = 2; n <= 20; n += 1) {
      await createConnection(app, { name: `Filler ${n}`, kind: "mcp_http", config: httpConfig });
    }
    const quota = await app.inject({
      method: "POST",
      url: "/api/connections",
      headers: ownerAuth,
      body: { name: "Twenty-first", kind: "mcp_http", config: httpConfig },
    });
    expect(quota.statusCode).toBe(409);
    expect(quota.json()).toMatchObject({ code: "CONNECTION_LIMIT_REACHED" });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth })).statusCode
    ).toBe(404);

    const pageOne = await app.inject({ method: "GET", url: "/api/connections?limit=1", headers: ownerAuth });
    expect(pageOne.json().items).toHaveLength(1);
    expect(pageOne.json().next_cursor).toStrictEqual(expect.any(String));
    const excessive = await app.inject({ method: "GET", url: "/api/connections?limit=101", headers: ownerAuth });
    expect(excessive.statusCode).toBe(400);
  });

  it("tests connections with the bounded transport and maps every failure", async () => {
    const app = await buildApp();
    const created = await createConnection(app, {
      name: "Probe",
      kind: "mcp_http",
      config: httpConfig,
      credentials: { headers: { authorization: `Bearer ${ROUTE_SECRET}` } },
    });
    const testUrl = `/api/connections/${created.id}/test`;

    fake.mode = "tools";
    const ok = await app.inject({ method: "POST", url: testUrl, headers: ownerAuth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "ready", status_code: null });
    expect(fake.targets.at(-1)?.secrets?.headers.authorization).toBe(`Bearer ${ROUTE_SECRET}`);

    const disabledPatch = await app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, enabled: false },
    });
    expect(disabledPatch.statusCode).toBe(200);
    const disabled = await app.inject({ method: "POST", url: testUrl, headers: ownerAuth });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ code: "CONNECTION_DISABLED" });
    await app.inject({
      method: "PATCH",
      url: `/api/connections/${created.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, enabled: true },
    });

    fake.mode = "auth";
    const auth = await app.inject({ method: "POST", url: testUrl, headers: ownerAuth });
    expect(auth.statusCode).toBe(409);
    expect(auth.json()).toMatchObject({ code: "CONNECTION_AUTH_REQUIRED" });
    expect(auth.json()).not.toHaveProperty("status");
    let detail = await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth });
    expect(detail.json()).toMatchObject({ status: "disconnected", status_code: "CONNECTION_AUTH_REQUIRED" });

    fake.mode = "handshake";
    const handshake = await app.inject({ method: "POST", url: testUrl, headers: ownerAuth });
    expect(handshake.statusCode).toBe(502);
    expect(handshake.json()).toMatchObject({ code: "CONNECTION_HANDSHAKE_FAILED" });
    detail = await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth });
    expect(detail.json()).toMatchObject({ status: "error", status_code: "CONNECTION_HANDSHAKE_FAILED" });

    fake.mode = "hang";
    const timedOut = await app.inject({ method: "POST", url: testUrl, headers: ownerAuth });
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json()).toMatchObject({ code: "CONNECTION_TIMEOUT" });
    detail = await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth });
    expect(detail.json()).toMatchObject({ status: "error", status_code: "CONNECTION_TIMEOUT" });

    // A wiring-gap (deterministic-unavailable) provider is stable 503 and
    // leaves the connection's status evidence untouched. Production defaults
    // to the SDK transport now; this explicit swap is the unit-test surface.
    const unavailableProvider: McpTransportProvider = Object.freeze({
      connect: async (): Promise<never> => {
        throw new McpTransportUnavailableError();
      },
    });
    const restoreUnavailable = setMcpTransportProvider(unavailableProvider);
    const unavailable = await app.inject({ method: "POST", url: testUrl, headers: ownerAuth });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: "CONNECTION_TRANSPORT_UNAVAILABLE" });
    detail = await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth });
    expect(detail.json()).toMatchObject({ status: "error", status_code: "CONNECTION_TIMEOUT" });
    restoreUnavailable();
    setMcpTransportProvider(fake);
  });

  it("publishes discovery snapshots and reports explicit over-limit catalogs", async () => {
    const app = await buildApp();
    const created = await createConnection(app, { name: "Disc", kind: "mcp_stdio", config: { command: "/bin/true" } });
    const discoverUrl = `/api/connections/${created.id}/discover`;

    fake.mode = "tools";
    const published = await app.inject({ method: "POST", url: discoverUrl, headers: ownerAuth });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      discovery_revision: 1,
      status: "ready",
      tools: [{ name: "read_file", description: "Read a file" }],
    });

    fake.mode = "over-limit";
    const over = await app.inject({ method: "POST", url: discoverUrl, headers: ownerAuth });
    expect(over.statusCode).toBe(502);
    expect(over.json()).toMatchObject({ code: "CONNECTION_DISCOVERY_OVER_LIMIT" });
    const detail = await app.inject({ method: "GET", url: `/api/connections/${created.id}`, headers: ownerAuth });
    expect(detail.json()).toMatchObject({
      status: "error",
      status_code: "CONNECTION_DISCOVERY_OVER_LIMIT",
      // The previous snapshot is intact; nothing was silently dropped.
      discovery_revision: 1,
      tools: [{ name: "read_file" }],
    });
  });

  it("supports authorize/revoke and custody-unavailable disconnected states", async () => {
    const app = await buildApp();
    const created = await createConnection(app, {
      name: "OAuth",
      kind: "mcp_http",
      config: httpConfig,
      credentials: { headers: { authorization: `Bearer ${ROUTE_SECRET}` } },
    });

    const authorize = await app.inject({
      method: "POST",
      url: `/api/connections/${created.id}/authorize`,
      headers: ownerAuth,
    });
    expect(authorize.statusCode).toBe(501);
    expect(authorize.json()).toMatchObject({ code: "CONNECTION_AUTH_UNSUPPORTED" });

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/connections/${created.id}/authorization`,
      headers: ownerAuth,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ credential_state: "none", status: "disconnected" });
    const recordPath = path.join(root, "secrets", OWNER, `${created.id}.json`);
    await expect(fs.stat(recordPath)).rejects.toMatchObject({ code: "ENOENT" });

    // Missing custody yields the actionable disconnected state, not a crash.
    const second = await createConnection(app, {
      name: "Custody",
      kind: "mcp_http",
      config: httpConfig,
      credentials: { headers: { authorization: `Bearer ${ROUTE_SECRET}` } },
    });
    await fs.writeFile(path.join(root, "connections.key"), "corrupted\n", { mode: 0o600 });
    const detail = await app.inject({ method: "GET", url: `/api/connections/${second.id}`, headers: ownerAuth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ credential_state: "unavailable" });
    const test = await app.inject({
      method: "POST",
      url: `/api/connections/${second.id}/test`,
      headers: ownerAuth,
    });
    expect(test.statusCode).toBe(503);
    expect(test.json()).toMatchObject({ code: "CONNECTION_CUSTODY_UNAVAILABLE" });
    const after = await app.inject({ method: "GET", url: `/api/connections/${second.id}`, headers: ownerAuth });
    expect(after.json()).toMatchObject({
      status: "disconnected",
      status_code: "CONNECTION_CUSTODY_UNAVAILABLE",
      credential_state: "unavailable",
    });
    expect(await storageRuntime().ledger.all("SELECT id FROM connections")).toHaveLength(2);
  });
});
