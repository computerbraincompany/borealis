import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initDb: vi.fn(),
  closeDb: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
  shutdownActiveRuns: vi.fn(),
  startIngestionWorkers: vi.fn(),
  stopIngestionWorkers: vi.fn(),
  restoreDatasets: vi.fn(),
  shutdownDatasetWorker: vi.fn(),
  createDesktopBootstrapSession: vi.fn(),
}));

vi.mock("../db.js", () => ({ initDb: mocks.initDb, closeDb: mocks.closeDb }));
vi.mock("../chatRuns.js", () => ({
  recoverInterruptedRuns: mocks.recoverInterruptedRuns,
  shutdownActiveRuns: mocks.shutdownActiveRuns,
}));
vi.mock("../ingest.js", () => ({
  startIngestionWorkers: mocks.startIngestionWorkers,
  stopIngestionWorkers: mocks.stopIngestionWorkers,
  restoreDatasets: mocks.restoreDatasets,
}));
vi.mock("../data/datasets.js", () => ({ shutdownDatasetWorker: mocks.shutdownDatasetWorker }));
vi.mock("../desktopBootstrap.js", () => ({
  createDesktopBootstrapSession: mocks.createDesktopBootstrapSession,
}));
vi.mock("../routes.js", () => ({
  routes: async (app: FastifyInstance) => {
    app.post("/api/echo", async (request) => ({ body: request.body ?? null }));
  },
}));

import { buildBorealisApp, isLoopbackDesktopHost, startBorealisServer } from "../serverApp.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

async function staticFixture(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-static-test-"));
  directories.push(directory);
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "index.html"), "<!doctype html><title>Borealis</title><main>shell</main>");
  await fs.writeFile(path.join(directory, "assets", "app-abc123.js"), "globalThis.loaded=true;");
  await fs.writeFile(path.join(directory, ".secret"), "never serve this");
  return directory;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.initDb.mockResolvedValue(undefined);
  mocks.closeDb.mockResolvedValue(undefined);
  mocks.recoverInterruptedRuns.mockResolvedValue(0);
  mocks.shutdownActiveRuns.mockResolvedValue(0);
  mocks.startIngestionWorkers.mockResolvedValue(undefined);
  mocks.stopIngestionWorkers.mockResolvedValue(undefined);
  mocks.restoreDatasets.mockResolvedValue({ restored: 0, failed: 0 });
  mocks.shutdownDatasetWorker.mockResolvedValue(undefined);
  mocks.createDesktopBootstrapSession.mockResolvedValue({
    token: "bootstrap-token",
    user: { id: "00000000-0000-4000-8000-000000000001", email: "local@borealis.app" },
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => {})));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Fastify same-origin static host", () => {
  it("serves the shell and fingerprinted assets with distinct cache policies", async () => {
    const app = await buildBorealisApp({ logger: false, staticWebDir: await staticFixture() });
    apps.push(app);

    const shell = await app.inject({ method: "GET", url: "/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain("<main>shell</main>");
    expect(shell.headers["cache-control"]).toBe("no-store");

    const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.body).toContain("globalThis.loaded=true");

    for (const url of ["/.secret", "/%2esecret"]) {
      const dotFile = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(dotFile.statusCode).toBe(404);
      expect(dotFile.body).not.toContain("never serve this");
      expect(dotFile.body).not.toContain("<main>shell</main>");
    }
  });

  it("uses index.html only for non-API HTML navigation, including HEAD", async () => {
    const app = await buildBorealisApp({ logger: false, staticWebDir: await staticFixture() });
    apps.push(app);

    const navigation = await app.inject({
      method: "GET",
      url: "/reports/report-1",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(navigation.statusCode).toBe(200);
    expect(navigation.body).toContain("<main>shell</main>");
    expect(navigation.headers["cache-control"]).toBe("no-store");

    const head = await app.inject({ method: "HEAD", url: "/sources", headers: { accept: "text/html" } });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");

    const nonHtml = await app.inject({ method: "GET", url: "/missing.json", headers: { accept: "application/json" } });
    expect(nonHtml.statusCode).toBe(404);
    expect(nonHtml.json()).toMatchObject({ error: "not found", request_id: expect.any(String) });
  });

  it("never lets the SPA fallback absorb either the exact or nested API namespace", async () => {
    const app = await buildBorealisApp({ logger: false, staticWebDir: await staticFixture() });
    apps.push(app);

    for (const url of ["/api", "/api/unknown"]) {
      const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "not found", request_id: expect.any(String) });
    }
  });

  it("keeps the embedded API same-origin and emits no cross-origin grant", async () => {
    const app = await buildBorealisApp({ logger: false, staticWebDir: await staticFixture() });
    apps.push(app);

    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/echo",
      headers: { origin: "http://127.0.0.1:49152", "content-type": "application/json" },
      payload: { safe: true },
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.json()).toEqual({ body: { safe: true } });
    expect(sameOrigin.headers["access-control-allow-origin"]).toBeUndefined();

    const hostilePreflight = await app.inject({
      method: "OPTIONS",
      url: "/api/echo",
      headers: {
        origin: "https://attacker.invalid",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(hostilePreflight.statusCode).toBe(404);
    expect(hostilePreflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("retains the exact development CORS allowlist when no static UI is mounted", async () => {
    const app = await buildBorealisApp({ logger: false });
    apps.push(app);
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/echo",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");

    const denied = await app.inject({
      method: "OPTIONS",
      url: "/api/echo",
      headers: { origin: "https://attacker.invalid", "access-control-request-method": "POST" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("desktop listener guard", () => {
  it("accepts only the canonical IPv4 loopback binding", () => {
    expect(isLoopbackDesktopHost("127.0.0.1")).toBe(true);
    expect(isLoopbackDesktopHost("localhost")).toBe(false);
    expect(isLoopbackDesktopHost("::1")).toBe(false);
    expect(isLoopbackDesktopHost("0.0.0.0")).toBe(false);
  });

  it("rejects a non-loopback desktop host before opening storage or workers", async () => {
    await expect(
      startBorealisServer({ desktop: true, host: "0.0.0.0", port: 0, staticWebDir: "/does/not/matter" })
    ).rejects.toThrow("desktop server must bind to 127.0.0.1");
    expect(mocks.initDb).not.toHaveBeenCalled();
    expect(mocks.startIngestionWorkers).not.toHaveBeenCalled();
  });

  it("requires a static UI before opening any desktop storage", async () => {
    const previousStaticWebDir = process.env.STATIC_WEB_DIR;
    delete process.env.STATIC_WEB_DIR;
    try {
      await expect(startBorealisServer({ desktop: true, host: "127.0.0.1", port: 0 })).rejects.toThrow(
        "desktop server requires STATIC_WEB_DIR"
      );
      expect(mocks.initDb).not.toHaveBeenCalled();
    } finally {
      if (previousStaticWebDir !== undefined) process.env.STATIC_WEB_DIR = previousStaticWebDir;
    }
  });
});
