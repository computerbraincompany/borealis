import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApplicationRuntime: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
  shutdownActiveRuns: vi.fn(),
  startIngestionWorkers: vi.fn(),
  stopIngestionWorkers: vi.fn(),
  restoreDatasets: vi.fn(),
  shutdownDatasetWorker: vi.fn(),
  createDesktopBootstrapSession: vi.fn(),
  /** Composition options the routes mock received, newest last. */
  routesOptions: [] as Array<Record<string, unknown>>,
}));

// Plan 014: serverApp now owns exactly one ApplicationRuntime per start and
// injects its runner into route composition. These mocks replace the old
// deleted db/automation module-global lifecycle seams.
vi.mock("../applicationRuntime.js", () => ({
  createApplicationRuntime: mocks.createApplicationRuntime,
  isApplicationRuntimeLeaseRetained: (error: unknown) =>
    typeof error === "object" && error !== null && (error as { leaseRetained?: unknown }).leaseRetained === true,
}));
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
  routes: async (app: FastifyInstance, options?: Record<string, unknown>) => {
    mocks.routesOptions.push({ ...(options ?? {}) });
    app.post("/api/echo", async (request) => ({ body: request.body ?? null }));
  },
}));

import { buildBorealisApp, isLoopbackDesktopHost, startBorealisServer, STATIC_UI_CSP } from "../serverApp.js";
import { DEFAULT_BODY_LIMIT_BYTES } from "../routes/bodyLimits.js";
import { config } from "../config.js";
import { acquireWorkspaceLock, WorkspaceLockedError } from "../workspaceLock.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

interface MockRuntimeSpec {
  readonly label: string;
  readonly events: string[];
  readonly stopDrain?: () => Promise<void>;
  readonly quiesceDrain?: () => Promise<void>;
  readonly closeImpl?: (proof: { externalStorageConsumersDrained: boolean }) => Promise<void>;
}

interface MockRuntime {
  readonly label: string;
  readonly object: {
    storage: unknown;
    runner: {
      start: () => void;
      stop: () => Promise<void>;
      tick: () => Promise<void>;
      isRunning: () => boolean;
    };
    startAutomationScheduler: ReturnType<typeof vi.fn>;
    stopAutomationScheduler: ReturnType<typeof vi.fn>;
    startAnalysisRunner: ReturnType<typeof vi.fn>;
    stopAnalysisRunner: ReturnType<typeof vi.fn>;
    startDocumentRewriteRunner: ReturnType<typeof vi.fn>;
    stopDocumentRewriteRunner: ReturnType<typeof vi.fn>;
    startResearchRunner: ReturnType<typeof vi.fn>;
    stopResearchRunner: ReturnType<typeof vi.fn>;
    quiesceDownloads: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  readonly runner: MockRuntime["object"]["runner"];
  readonly closeProofs: Array<{ externalStorageConsumersDrained: boolean }>;
}

function newMockRuntime(spec: MockRuntimeSpec): MockRuntime {
  const { label, events } = spec;
  const runner = {
    start: vi.fn(() => {
      events.push(`${label}:runner-start`);
    }),
    stop: vi.fn(async () => undefined),
    tick: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
  };
  const closeProofs: MockRuntime["closeProofs"] = [];
  const runtime: MockRuntime = {
    label,
    runner,
    closeProofs,
    object: {
      storage: { mockRuntime: label },
      runner,
      startAutomationScheduler: vi.fn(() => {
        events.push(`${label}:scheduler-start`);
      }),
      stopAutomationScheduler: vi.fn(() => {
        events.push(`${label}:scheduler-stop`);
        return spec.stopDrain ? spec.stopDrain() : Promise.resolve();
      }),
      startAnalysisRunner: vi.fn(() => {
        events.push(`${label}:analysis-start`);
      }),
      stopAnalysisRunner: vi.fn(() => {
        events.push(`${label}:analysis-stop`);
        return Promise.resolve();
      }),
      startDocumentRewriteRunner: vi.fn(() => {
        events.push(`${label}:rewrite-start`);
      }),
      stopDocumentRewriteRunner: vi.fn(() => {
        events.push(`${label}:rewrite-stop`);
        return Promise.resolve();
      }),
      startResearchRunner: vi.fn(() => {
        events.push(`${label}:research-start`);
      }),
      stopResearchRunner: vi.fn(() => {
        events.push(`${label}:research-stop`);
        return Promise.resolve();
      }),
      quiesceDownloads: vi.fn(() => {
        events.push(`${label}:download-quiesce`);
        return spec.quiesceDrain ? spec.quiesceDrain() : Promise.resolve();
      }),
      close: vi.fn(async (proof: { externalStorageConsumersDrained: boolean }) => {
        closeProofs.push(proof);
        events.push(`${label}:runtime-close:${proof.externalStorageConsumersDrained ? "proved" : "unproved"}`);
        if (spec.closeImpl) {
          await spec.closeImpl(proof);
          return;
        }
        events.push(`${label}:storage-closed`);
      }),
    },
  };
  return runtime;
}

/**
 * Installs the mocked `createApplicationRuntime`: each start constructs a
 * fresh mock runtime (cycling through `labels`/`specs` once exhausted) and
 * appends it to `runtimes` in creation order.
 */
function useRuntimeFactory(
  runtimes: MockRuntime[],
  labels: string[],
  events: string[],
  specs: Partial<MockRuntimeSpec>[] = []
) {
  let attempt = 0;
  mocks.createApplicationRuntime.mockImplementation(async () => {
    const index = Math.min(attempt, Math.max(labels.length - 1, 0));
    const label = labels[index] ?? `runtime-${attempt}`;
    const spec = specs[Math.min(attempt, Math.max(specs.length - 1, 0))] ?? {};
    attempt += 1;
    const runtime = newMockRuntime({ label, events, ...spec });
    events.push(`${label}:factory`);
    runtimes.push(runtime);
    return runtime.object;
  });
}

/** Exact directive-token map for the shell CSP response header. */
function cspDirectives(header: unknown): Map<string, string[]> {
  expect(typeof header).toBe("string");
  const directives = new Map<string, string[]>();
  for (const part of String(header).split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) directives.set(tokens[0]!.toLowerCase(), tokens.slice(1));
  }
  return directives;
}

function expectShellCsp(header: unknown): void {
  expect(header).toBe(STATIC_UI_CSP);
  const directives = cspDirectives(header);
  expect(directives.get("default-src")).toEqual(["'self'"]);
  expect(directives.get("base-uri")).toEqual(["'none'"]);
  expect(directives.get("object-src")).toEqual(["'none'"]);
  expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  expect(directives.get("form-action")).toEqual(["'self'"]);
  expect(directives.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
  expect(directives.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  expect(directives.get("img-src")).toEqual(["'self'", "data:"]);
  expect(directives.get("font-src")).toEqual(["'self'"]);
  expect(directives.get("connect-src")).toEqual(["'self'"]);
  // Load-bearing: the sandboxed srcDoc preview lives under `about:` and an
  // ordinary same-origin HTTP frame must stay denied.
  expect(directives.get("frame-src")).toEqual(["about:"]);
}

async function staticFixture(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-static-test-"));
  directories.push(directory);
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "index.html"), "<!doctype html><title>Borealis</title><main>shell</main>");
  await fs.writeFile(path.join(directory, "assets", "app-abc123.js"), "globalThis.loaded=true;");
  await fs.writeFile(path.join(directory, ".secret"), "never serve this");
  return directory;
}

async function frameProbeFixture(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-frame-test-"));
  directories.push(directory);
  await fs.writeFile(
    path.join(directory, "index.html"),
    [
      "<!doctype html><title>Frame probe</title>",
      '<iframe name="doc-frame" sandbox="allow-scripts"',
      '  srcdoc="<p id=&quot;doc-marker&quot;>doc-frame-loaded</p>"></iframe>',
      '<iframe name="url-frame" src="/marker-probe.html"></iframe>',
    ].join("\n")
  );
  await fs.writeFile(
    path.join(directory, "marker-probe.html"),
    '<!doctype html><title>probe</title><p id="url-marker">url-frame-loaded</p>'
  );
  return directory;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (Array.isArray(mock)) mock.length = 0;
    else mock.mockReset();
  }
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
  // Default factory: one clean owned runtime per start, events visible to
  // tests through the returned runtime records.
  useRuntimeFactory([], [], []);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => {})));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Fastify same-origin static host", () => {
  it("uses a conservative fail-safe body limit when a route omits one", async () => {
    const app = await buildBorealisApp({ logger: false });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/echo",
      headers: { "content-type": "application/json", "x-request-id": "body.default-limit" },
      payload: { value: "x".repeat(DEFAULT_BODY_LIMIT_BYTES) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: "request payload is too large",
      request_id: "body.default-limit",
    });
  });

  it("serves the shell and fingerprinted assets with distinct cache policies", async () => {
    const app = await buildBorealisApp({ logger: false, staticWebDir: await staticFixture() });
    apps.push(app);

    const shell = await app.inject({ method: "GET", url: "/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain("<main>shell</main>");
    expect(shell.headers["cache-control"]).toBe("no-store");
    expectShellCsp(shell.headers["content-security-policy"]);

    const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.body).toContain("globalThis.loaded=true");
    // The shell CSP is an HTML policy; fingerprinted assets must still load.
    expect(asset.headers["content-security-policy"]).toBeUndefined();

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
    // The SPA fallback must carry the same shell CSP as the direct response.
    expectShellCsp(navigation.headers["content-security-policy"]);

    const head = await app.inject({ method: "HEAD", url: "/sources", headers: { accept: "text/html" } });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");

    const nonHtml = await app.inject({ method: "GET", url: "/missing.json", headers: { accept: "application/json" } });
    expect(nonHtml.statusCode).toBe(404);
    expect(nonHtml.json()).toMatchObject({ error: "not found", request_id: expect.any(String) });
    // JSON error envelopes never become HTML and carry no shell CSP.
    expect(nonHtml.headers["content-security-policy"]).toBeUndefined();
    expect(nonHtml.headers["content-type"]).toContain("application/json");
  });

  it("never lets the SPA fallback absorb either the exact or nested API namespace", async () => {
    const app = await buildBorealisApp({ logger: false, staticWebDir: await staticFixture() });
    apps.push(app);

    for (const url of ["/api", "/api/unknown"]) {
      const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "not found", request_id: expect.any(String) });
      expect(response.headers["content-security-policy"]).toBeUndefined();
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

describe("trusted desktop composition mode", () => {
  it("forwards the composition desktop flag and scheduler capability to route composition, defaulting to browser mode", async () => {
    const browserApp = await buildBorealisApp({ logger: false });
    apps.push(browserApp);
    expect(mocks.routesOptions.at(-1)).toEqual({ desktop: false });

    const desktopApp = await buildBorealisApp({ logger: false, desktop: true });
    apps.push(desktopApp);
    expect(mocks.routesOptions.at(-1)).toEqual({ desktop: true });

    const scheduler = { isRunning: () => true };
    const composedApp = await buildBorealisApp({ logger: false, automationScheduler: scheduler });
    apps.push(composedApp);
    expect(mocks.routesOptions.at(-1)).toEqual({ desktop: false, automationScheduler: scheduler });
  });
});

describe("shell CSP frame behavior in a real browser", () => {
  it("renders the sandboxed srcDoc preview while blocking a same-origin HTTP frame", async () => {
    const { chromium } = await import("playwright");
    const requestedUrls: string[] = [];
    let browser: import("playwright").Browser | undefined;
    let app: FastifyInstance | undefined;
    try {
      app = await buildBorealisApp({ logger: false, staticWebDir: await frameProbeFixture() });
      apps.push(app);
      app.addHook("onRequest", (request, _reply, done) => {
        requestedUrls.push(request.url.split("?")[0] ?? request.url);
        done();
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind a TCP socket");
      const origin = `http://127.0.0.1:${address.port}`;

      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const outboundRequests: string[] = [];
      page.on("request", (request) => outboundRequests.push(request.url()));
      await page.goto(`${origin}/`, { waitUntil: "load" });

      // Chromium permits the sandboxed srcDoc iframe under `frame-src about:`.
      const docMarker = page.frameLocator('iframe[name="doc-frame"]').locator("#doc-marker");
      await docMarker.waitFor({ state: "visible", timeout: 10_000 });
      expect(((await docMarker.textContent()) ?? "").trim()).toBe("doc-frame-loaded");

      // The same-origin HTTP frame never loads and its resource is never requested.
      expect(requestedUrls).toContain("/");
      expect(requestedUrls.some((url) => url.includes("marker-probe"))).toBe(false);
      // A CSP-blocked frame stays on `about:blank` or Chromium's blocked
      // navigation error page; it never reaches a shell-origin document.
      const urlFrame = page.frames().find((frame) => frame.name() === "url-frame");
      const blockedUrl = urlFrame?.url();
      expect(
        blockedUrl === undefined || blockedUrl === "about:blank" || blockedUrl === "chrome-error://chromewebdata/"
      ).toBe(true);

      // The browser made no request outside the exact loopback shell origin.
      for (const url of outboundRequests) {
        expect(url.startsWith(`${origin}/`)).toBe(true);
      }
    } finally {
      await browser?.close().catch(() => {});
      await app?.close().catch(() => {});
    }
  }, 60_000);
});

describe("desktop listener guard", () => {
  it("accepts only the canonical IPv4 loopback binding", () => {
    expect(isLoopbackDesktopHost("127.0.0.1")).toBe(true);
    expect(isLoopbackDesktopHost("localhost")).toBe(false);
    expect(isLoopbackDesktopHost("::1")).toBe(false);
    expect(isLoopbackDesktopHost("0.0.0.0")).toBe(false);
  });

  it("rejects a non-loopback desktop host before creating the runtime or workers", async () => {
    await expect(
      startBorealisServer({ desktop: true, host: "0.0.0.0", port: 0, staticWebDir: "/does/not/matter" })
    ).rejects.toThrow("desktop server must bind to 127.0.0.1");
    expect(mocks.createApplicationRuntime).not.toHaveBeenCalled();
    expect(mocks.startIngestionWorkers).not.toHaveBeenCalled();
  });

  it("requires a static UI before creating the desktop runtime", async () => {
    const previousStaticWebDir = process.env.STATIC_WEB_DIR;
    delete process.env.STATIC_WEB_DIR;
    try {
      await expect(startBorealisServer({ desktop: true, host: "127.0.0.1", port: 0 })).rejects.toThrow(
        "desktop server requires STATIC_WEB_DIR"
      );
      expect(mocks.createApplicationRuntime).not.toHaveBeenCalled();
    } finally {
      if (previousStaticWebDir !== undefined) process.env.STATIC_WEB_DIR = previousStaticWebDir;
    }
  });
});

describe("workspace instance ownership", () => {
  it("refuses startup before creating the runtime when another process owns the workspace lock", async () => {
    const lock = await acquireWorkspaceLock(config.storageDir);
    try {
      await expect(startBorealisServer({ host: "127.0.0.1", port: 0, logger: false })).rejects.toBeInstanceOf(
        WorkspaceLockedError
      );
      expect(mocks.createApplicationRuntime).not.toHaveBeenCalled();
      expect(mocks.startIngestionWorkers).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
  });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const PENDING = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(
      () => "settled",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve(PENDING), 30)),
  ]);
  return outcome === PENDING;
}

/** Runs the lifecycle against a private storage directory, never operator state. */
async function withTempWorkspace(run: () => Promise<void>): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-server-lifecycle-"));
  directories.push(workspace);
  const previousStorageDirectory = config.storageDir;
  config.storageDir = workspace;
  try {
    await run();
  } finally {
    config.storageDir = previousStorageDirectory;
  }
}

describe("automation scheduler drain on server shutdown", () => {
  it("synchronously quiesces scheduler/download admission and defers the owned runtime close until the drain settles", async () => {
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    const drain = deferred();
    const closeSnapshotCounts: number[] = [];
    useRuntimeFactory(runtimes, ["A"], events, [
      {
        stopDrain: () => drain.promise,
        closeImpl: async () => {
          closeSnapshotCounts.push(mocks.shutdownActiveRuns.mock.calls.length);
        },
      },
    ]);

    await withTempWorkspace(async () => {
      const server = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      expect(runtimes).toHaveLength(1);
      const runtimeA = runtimes[0]!;
      expect(runtimeA.object.startAutomationScheduler).toHaveBeenCalledOnce();
      expect(runtimeA.object.startAnalysisRunner).toHaveBeenCalledOnce();
      expect(mocks.shutdownActiveRuns).not.toHaveBeenCalled();
      expect(runtimeA.object.close).not.toHaveBeenCalled();

      const closePromise = server.close();
      // Both admission sources close synchronously as close begins, before
      // the first HTTP drain snapshot, and the owned runtime close has not
      // started.
      expect(runtimeA.object.stopAutomationScheduler).toHaveBeenCalledOnce();
      expect(runtimeA.object.quiesceDownloads).toHaveBeenCalledOnce();
      expect(mocks.shutdownActiveRuns).toHaveBeenCalledTimes(1);
      expect(runtimeA.object.close).not.toHaveBeenCalled();

      // Active-run cancellation repeats while the scheduler drain is held.
      await vi.waitFor(() => expect(mocks.shutdownActiveRuns.mock.calls.length).toBeGreaterThanOrEqual(3), {
        timeout: 10_000,
      });
      expect(runtimeA.object.close).not.toHaveBeenCalled();
      const snapshotsDuringHold = mocks.shutdownActiveRuns.mock.calls.length;

      drain.resolve();
      await closePromise;

      expect(runtimeA.object.close).toHaveBeenCalledOnce();
      expect(runtimeA.closeProofs).toEqual([{ externalStorageConsumersDrained: true }]);
      // Storage closed only after the drain settled and one final snapshot ran.
      expect(closeSnapshotCounts[0]).toBeGreaterThanOrEqual(snapshotsDuringHold + 1);

      // close() stays idempotent through its cached promise.
      await server.close();
      expect(runtimeA.object.stopAutomationScheduler).toHaveBeenCalledOnce();
      expect(runtimeA.object.close).toHaveBeenCalledOnce();
    });
  }, 20_000);

  it("cancels a scheduler-owned controller registered after the first cancellation snapshot", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const claimPausedBeforeBeginRun = deferred();
    const runHeld = deferred();
    let registered = false;

    // The drain models a claim already inside acceptChatTurn that was paused
    // immediately before beginRun when shutdown quiesced the scheduler.
    const stopDrain = () =>
      claimPausedBeforeBeginRun.promise.then(() => {
        events.push("begin-run");
        registered = true;
        // The agent turn keeps running until a later snapshot aborts it.
        return runHeld.promise;
      });
    mocks.shutdownActiveRuns.mockImplementation(async () => {
      events.push("snapshot");
      if (registered) {
        controller.abort();
        events.push("abort");
        runHeld.resolve();
      }
      return registered ? 1 : 0;
    });

    await withTempWorkspace(async () => {
      const runtimes: MockRuntime[] = [];
      useRuntimeFactory(runtimes, ["A"], events, [
        {
          stopDrain,
          closeImpl: async () => {
            events.push("owned-close");
          },
        },
      ]);
      const server = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      const closePromise = server.close();
      expect(events).toContain("A:scheduler-stop");

      // Let the first cancellation snapshot complete with nothing registered.
      await vi.waitFor(() => expect(events).toContain("snapshot"), { timeout: 10_000 });
      expect(registered).toBe(false);
      expect(controller.signal.aborted).toBe(false);
      expect(events).not.toContain("owned-close");

      // beginRun registers only after that snapshot: the registration gap.
      claimPausedBeforeBeginRun.resolve();
      await vi.waitFor(() => expect(events).toContain("begin-run"), { timeout: 10_000 });
      // A later snapshot must abort the newly registered controller.
      await vi.waitFor(() => expect(events).toContain("abort"), { timeout: 10_000 });
      expect(controller.signal.aborted).toBe(true);

      await closePromise;
      expect(events).toContain("owned-close");
      const beginRunIndex = events.indexOf("begin-run");
      const abortIndex = events.indexOf("abort");
      const closeIndex = events.indexOf("owned-close");
      const lastSnapshotIndex = events.lastIndexOf("snapshot");
      expect(beginRunIndex).toBeLessThan(abortIndex);
      // The final cancellation snapshot runs after the late abort and before
      // the owned runtime close (storage/settings closure).
      expect(lastSnapshotIndex).toBeGreaterThan(abortIndex);
      expect(lastSnapshotIndex).toBeLessThan(closeIndex);
    });
  }, 20_000);

  it("drains the scheduler when startup fails after the scheduler started", async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => resolve());
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("occupied listener did not bind a TCP socket");
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    const drain = deferred();
    useRuntimeFactory(runtimes, ["A"], events, [{ stopDrain: () => drain.promise }]);

    try {
      await withTempWorkspace(async () => {
        const startup = startBorealisServer({ host: "127.0.0.1", port: address.port, logger: false });
        await vi.waitFor(
          () => {
            expect(runtimes[0]?.object.stopAutomationScheduler).toHaveBeenCalledOnce();
            expect(mocks.shutdownActiveRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
          },
          { timeout: 10_000 }
        );
        expect(runtimes[0]?.object.close).not.toHaveBeenCalled();
        const snapshotsDuringHold = mocks.shutdownActiveRuns.mock.calls.length;

        drain.resolve();
        await expect(startup).rejects.toThrow(/EADDRINUSE/);
        // The same synchronous quiesce/drain applies, then the proof-bearing
        // owned close — including settings/storage closure it now owns.
        expect(runtimes[0]?.object.close).toHaveBeenCalledOnce();
        expect(runtimes[0]?.closeProofs).toEqual([{ externalStorageConsumersDrained: true }]);
        // The post-drain final snapshot ran before storage close.
        expect(mocks.shutdownActiveRuns.mock.calls.length).toBeGreaterThanOrEqual(snapshotsDuringHold + 1);
      });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  }, 20_000);
});

describe("owned application runtime orchestration", () => {
  it("runs two sequential server lifecycles with distinct runtimes and no cross-owner calls", async () => {
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    useRuntimeFactory(runtimes, ["A", "B"], events);

    await withTempWorkspace(async () => {
      const serverA = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      // App A's scheduler route received exactly runtime A's runner.
      expect(mocks.routesOptions.at(-1)?.automationScheduler).toBe(runtimes[0]!.runner);
      await serverA.close();

      const serverB = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      expect(mocks.routesOptions.at(-1)?.automationScheduler).toBe(runtimes[1]!.runner);
      await serverB.close();

      // Runtime A synchronously quiesced both admission sources and closed
      // before runtime B was created; B's lifecycle mirrors it exactly.
      expect(events).toEqual([
        "A:factory",
        "A:scheduler-start",
        "A:analysis-start",
        "A:rewrite-start",
        "A:research-start",
        "A:scheduler-stop",
        "A:download-quiesce",
        "A:analysis-stop",
        "A:rewrite-stop",
        "A:research-stop",
        "A:runtime-close:proved",
        "A:storage-closed",
        "B:factory",
        "B:scheduler-start",
        "B:analysis-start",
        "B:rewrite-start",
        "B:research-start",
        "B:scheduler-stop",
        "B:download-quiesce",
        "B:analysis-stop",
        "B:rewrite-stop",
        "B:research-stop",
        "B:runtime-close:proved",
        "B:storage-closed",
      ]);

      // Each runtime closed exactly once with a true external proof.
      expect(runtimes[0]!.closeProofs).toEqual([{ externalStorageConsumersDrained: true }]);
      expect(runtimes[1]!.closeProofs).toEqual([{ externalStorageConsumersDrained: true }]);

      // B's lifecycle never invoked methods on A.
      expect(runtimes[0]!.object.stopAutomationScheduler).toHaveBeenCalledOnce();
      expect(runtimes[0]!.object.startAnalysisRunner).toHaveBeenCalledOnce();
      expect(runtimes[0]!.object.stopAnalysisRunner).toHaveBeenCalledOnce();
      expect(runtimes[0]!.object.quiesceDownloads).toHaveBeenCalledOnce();
      expect(runtimes[0]!.object.close).toHaveBeenCalledOnce();
      expect(runtimes[1]!.object.stopAutomationScheduler).toHaveBeenCalledOnce();
      expect(runtimes[1]!.object.quiesceDownloads).toHaveBeenCalledOnce();
      expect(runtimes[1]!.object.close).toHaveBeenCalledOnce();
    });
  }, 20_000);

  it("keeps close unresolved until a held download drain releases, gating settings/storage closure", async () => {
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    const held = deferred();
    useRuntimeFactory(runtimes, ["A"], events, [
      {
        quiesceDrain: () => held.promise,
        closeImpl: async () => {
          // The owned runtime close joins the download drain before it can
          // close settings/storage.
          await held.promise;
          events.push("A:storage-closed");
        },
      },
    ]);

    await withTempWorkspace(async () => {
      const server = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      const closing = server.close();
      await vi.waitFor(() => expect(runtimes[0]?.object.quiesceDownloads).toHaveBeenCalledOnce(), { timeout: 5_000 });
      expect(await isPending(closing)).toBe(true);
      expect(events).not.toContain("A:storage-closed");

      held.resolve();
      await closing;
      expect(events).toContain("A:storage-closed");
    });
  }, 20_000);

  it("keeps close unresolved while an ingestion worker (OCR helper owner) is held", async () => {
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    useRuntimeFactory(runtimes, ["A"], events);
    const held = deferred();
    mocks.stopIngestionWorkers.mockReturnValue(held.promise);

    await withTempWorkspace(async () => {
      const server = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      const closing = server.close();
      await vi.waitFor(() => expect(runtimes[0]?.object.stopAutomationScheduler).toHaveBeenCalledOnce(), {
        timeout: 5_000,
      });
      expect(await isPending(closing)).toBe(true);
      // The owned close may not begin beneath an unfinished ingestion drain.
      expect(runtimes[0]?.object.close).not.toHaveBeenCalled();

      held.resolve();
      await closing;
      expect(runtimes[0]?.closeProofs).toEqual([{ externalStorageConsumersDrained: true }]);
    });
  }, 20_000);

  it("retains the workspace lock while a held migration coordinator drain gates the owned close", async () => {
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    const held = deferred();
    useRuntimeFactory(runtimes, ["A"], events, [
      {
        closeImpl: async () => {
          await held.promise;
          events.push("A:storage-closed");
        },
      },
    ]);

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-server-migration-hold-"));
    directories.push(workspace);
    const previousStorageDirectory = config.storageDir;
    config.storageDir = workspace;
    try {
      const server = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      const closing = server.close();
      await vi.waitFor(() => expect(runtimes[0]?.object.close).toHaveBeenCalledOnce(), { timeout: 5_000 });
      expect(await isPending(closing)).toBe(true);
      // The cross-process workspace lock is retained during the uncertain
      // drain: this workspace cannot be re-acquired.
      await expect(acquireWorkspaceLock(workspace)).rejects.toBeInstanceOf(WorkspaceLockedError);
      expect(events).not.toContain("A:storage-closed");

      held.resolve();
      await closing;
      expect(events).toContain("A:storage-closed");
      await expect(acquireWorkspaceLock(workspace)).resolves.toBeDefined();
    } finally {
      config.storageDir = previousStorageDirectory;
    }
  }, 20_000);

  it("passes a false external proof on ingestion drain failure, skips settings/storage closure, and rejects close", async () => {
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    useRuntimeFactory(runtimes, ["A"], events, [
      {
        closeImpl: async (proof) => {
          if (!proof.externalStorageConsumersDrained) throw new Error("simulated owned close refusal");
          events.push("A:storage-closed");
        },
      },
    ]);
    mocks.stopIngestionWorkers.mockRejectedValue(new Error("simulated ingestion drain failure"));

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-server-ingest-fail-"));
    directories.push(workspace);
    const previousStorageDirectory = config.storageDir;
    config.storageDir = workspace;
    try {
      const server = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      await expect(server.close()).rejects.toThrow("simulated owned close refusal");

      // The owned close was attempted with the exact false proof and
      // refused; settings/storage closure never happened.
      expect(runtimes[0]?.closeProofs).toEqual([{ externalStorageConsumersDrained: false }]);
      expect(events).not.toContain("A:storage-closed");
      // All other independent safe stops were still attempted.
      expect(mocks.shutdownDatasetWorker).toHaveBeenCalledOnce();
      // No graceful stopped acknowledgement: the workspace lock stays
      // retained alongside the poisoned ownership.
      await expect(acquireWorkspaceLock(workspace)).rejects.toBeInstanceOf(WorkspaceLockedError);
    } finally {
      config.storageDir = previousStorageDirectory;
    }
  }, 20_000);

  it("passes a false external proof on dataset worker drain failure and rejects close", async () => {
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    useRuntimeFactory(runtimes, ["A"], events, [
      {
        closeImpl: async (proof) => {
          if (!proof.externalStorageConsumersDrained) throw new Error("simulated owned close refusal");
          events.push("A:storage-closed");
        },
      },
    ]);
    mocks.shutdownDatasetWorker.mockRejectedValue(new Error("simulated dataset drain failure"));

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-server-dataset-fail-"));
    directories.push(workspace);
    const previousStorageDirectory = config.storageDir;
    config.storageDir = workspace;
    try {
      const server = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      await expect(server.close()).rejects.toThrow("simulated owned close refusal");

      expect(runtimes[0]?.closeProofs).toEqual([{ externalStorageConsumersDrained: false }]);
      expect(events).not.toContain("A:storage-closed");
      // Ingestion stop was still attempted alongside the drain.
      expect(mocks.stopIngestionWorkers).toHaveBeenCalledOnce();
      await expect(acquireWorkspaceLock(workspace)).rejects.toBeInstanceOf(WorkspaceLockedError);
    } finally {
      config.storageDir = previousStorageDirectory;
    }
  }, 20_000);

  it("closes only the runtime created by a partially failed startup attempt", async () => {
    const events: string[] = [];
    const runtimes: MockRuntime[] = [];
    useRuntimeFactory(runtimes, ["A", "B"], events);

    await withTempWorkspace(async () => {
      const serverA = await startBorealisServer({ host: "127.0.0.1", port: 0, logger: false });
      await serverA.close();
      const aCloseCalls = runtimes[0]!.object.close.mock.calls.length;

      mocks.recoverInterruptedRuns.mockRejectedValueOnce(new Error("simulated recovery failure"));
      await expect(startBorealisServer({ host: "127.0.0.1", port: 0, logger: false })).rejects.toThrow(
        "simulated recovery failure"
      );

      // The second attempt created runtime B and closed exactly runtime B.
      expect(runtimes).toHaveLength(2);
      expect(runtimes[1]!.object.close).toHaveBeenCalledOnce();
      expect(runtimes[1]!.closeProofs).toEqual([{ externalStorageConsumersDrained: true }]);
      // Runtime A's objects were never touched by B's lifecycle.
      expect(runtimes[0]!.object.close.mock.calls.length).toBe(aCloseCalls);
    });
  }, 20_000);
});
