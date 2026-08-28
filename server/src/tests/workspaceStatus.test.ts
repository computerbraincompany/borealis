import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../auth.js";
import { installHttpBoundary } from "../httpErrors.js";
import { systemRoutes } from "../routes/system.js";
import {
  classifyProviderLocality,
  createWorkspaceStatus,
  type WorkspaceStatusDependencies,
} from "../workspaceStatus.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const auth = {
  authorization: `Bearer ${signToken({ userId: ACCOUNT_ID, email: "owner@example.test" })}`,
};

const settings = {
  llmBaseUrl: "http://127.0.0.1:1234",
  apiKey: "status-provider-secret",
  chatModel: "qwen3-32b",
  embedModel: "bge-m3",
};

function buildDependencies(
  overrides: Partial<WorkspaceStatusDependencies> & { probe?: WorkspaceStatusDependencies["probe"] } = {}
): WorkspaceStatusDependencies & { probeMock: ReturnType<typeof vi.fn> } {
  const probeMock = vi.fn().mockResolvedValue(true);
  return {
    probeMock,
    now: () => Date.parse("2026-08-29T10:00:00.000Z"),
    llmSettings: vi.fn().mockResolvedValue(settings),
    probe: probeMock,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider locality classification", () => {
  it("classifies loopback origins as local", () => {
    expect(classifyProviderLocality("http://127.0.0.1:1234")).toBe("local");
    expect(classifyProviderLocality("http://localhost:1234")).toBe("local");
    expect(classifyProviderLocality("https://model.localhost:8080")).toBe("local");
    expect(classifyProviderLocality("http://127.254.1.2/v1")).toBe("local");
    expect(classifyProviderLocality("http://0.0.0.0:1234")).toBe("local");
    expect(classifyProviderLocality("http://[::1]:1234")).toBe("local");
    expect(classifyProviderLocality("http://[::]:9000")).toBe("local");
  });

  it("classifies private-network origins as private", () => {
    expect(classifyProviderLocality("http://10.1.2.3:8000")).toBe("private");
    expect(classifyProviderLocality("https://172.16.5.4/v1")).toBe("private");
    expect(classifyProviderLocality("http://172.31.255.1")).toBe("private");
    expect(classifyProviderLocality("http://192.168.1.10:1234")).toBe("private");
    expect(classifyProviderLocality("http://169.254.9.9")).toBe("private");
    expect(classifyProviderLocality("http://100.64.0.1")).toBe("private");
    expect(classifyProviderLocality("http://100.127.255.254")).toBe("private");
    expect(classifyProviderLocality("http://spark.local")).toBe("private");
    expect(classifyProviderLocality("http://desk-side.lan")).toBe("private");
    expect(classifyProviderLocality("http://nas.internal")).toBe("private");
    expect(classifyProviderLocality("http://studio.home")).toBe("private");
    expect(classifyProviderLocality("http://spark")).toBe("private");
    expect(classifyProviderLocality("http://[fd00::1]:8000")).toBe("private");
    expect(classifyProviderLocality("http://[::ffff:10.0.0.5]")).toBe("private");
  });

  it("classifies public origins as remote and fails closed on unparseable input", () => {
    expect(classifyProviderLocality("https://cloud-provider.example.test")).toBe("remote");
    expect(classifyProviderLocality("http://8.8.8.8")).toBe("remote");
    expect(classifyProviderLocality("https://api.localhosting.example")).toBe("remote");
    expect(classifyProviderLocality("http://[2001:db8::1]")).toBe("remote");
    expect(classifyProviderLocality("http://[::ffff:8.8.8.8]")).toBe("remote");
    expect(classifyProviderLocality("not-a-url")).toBe("remote");
  });
});

describe("workspace status cache", () => {
  it("serves the TTL cache and probes again only after expiry", async () => {
    let clock = Date.parse("2026-08-29T10:00:00.000Z");
    const dependencies = buildDependencies({ now: () => clock });
    const status = createWorkspaceStatus(dependencies);

    const first = await status();
    const second = await status();
    expect(dependencies.probeMock).toHaveBeenCalledOnce();
    expect(second).toBe(first);

    clock += 20_000;
    const third = await status();
    expect(dependencies.probeMock).toHaveBeenCalledTimes(2);
    expect(third).not.toBe(first);
  });

  it("single-flights concurrent refreshes", async () => {
    let releaseProbe!: (reachable: boolean) => void;
    const probeMock = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseProbe = resolve;
        })
    );
    const status = createWorkspaceStatus({
      now: () => Date.parse("2026-08-29T10:00:00.000Z"),
      llmSettings: vi.fn().mockResolvedValue(settings),
      probe: probeMock,
    });

    const first = status();
    const second = status();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseProbe(true);
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(probeMock).toHaveBeenCalledOnce();
  });

  it("reports an unreachable endpoint as a status, not an error, without disclosure", async () => {
    const dependencies = buildDependencies({
      probe: vi.fn().mockRejectedValue(new Error("secret upstream trace https://provider.example")),
    });
    const status = createWorkspaceStatus(dependencies);

    const result = await status();

    expect(result.endpoint_reachable).toBe(false);
    expect(result.locality).toBe("local");
    expect(JSON.stringify(result)).not.toMatch(/provider\.example|secret|status-provider-secret|1234/i);
  });

  it("keeps chat and embed identities while omitting the LM Studio row when unset", async () => {
    const dependencies = buildDependencies({
      llmSettings: vi.fn().mockResolvedValue({ ...settings, apiKey: undefined, lmStudioBaseUrl: undefined }),
    });
    const status = createWorkspaceStatus(dependencies);

    const result = await status();

    expect(result.chat_model).toBe("qwen3-32b");
    expect(result.embed_model).toBe("bge-m3");
    expect(result.lm_studio_reachable).toBe(null);
  });

  it("probes the distinct LM Studio health endpoint when configured", async () => {
    const dependencies = buildDependencies({
      llmSettings: vi.fn().mockResolvedValue({ ...settings, lmStudioBaseUrl: "http://localhost:1234" }),
    });
    const status = createWorkspaceStatus(dependencies);

    const result = await status();

    expect(result.lm_studio_reachable).toBe(true);
    expect(dependencies.probeMock).toHaveBeenCalledTimes(2);
    expect(dependencies.probeMock).toHaveBeenNthCalledWith(1, "http://127.0.0.1:1234/v1/models", {
      apiKey: "status-provider-secret",
      timeoutMs: 2_000,
    });
    expect(dependencies.probeMock).toHaveBeenNthCalledWith(2, "http://localhost:1234/v1/models", {
      timeoutMs: 2_000,
    });
  });

  it("clamps the probe latency to the probe budget", async () => {
    let clock = 0;
    const dependencies = buildDependencies({
      now: () => clock,
      probe: vi.fn().mockImplementation(async () => {
        clock += 5_000;
        return true;
      }),
    });
    const status = createWorkspaceStatus(dependencies);

    const result = await status();

    expect(result.latency_ms).toBe(2_000);
  });
});

describe("GET /api/status", () => {
  async function buildApp(workspaceStatus: () => Promise<unknown>): Promise<FastifyInstance> {
    const app = Fastify();
    installHttpBoundary(app);
    await app.register(systemRoutes, { workspaceStatus: workspaceStatus as never });
    await app.ready();
    return app;
  }

  it("requires authentication", async () => {
    const app = await buildApp(vi.fn().mockResolvedValue({}));
    const response = await app.inject({ method: "GET", url: "/api/status" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns the ambient snapshot and nothing else", async () => {
    const workspaceStatus = vi.fn().mockResolvedValue({
      locality: "remote",
      endpoint_reachable: true,
      lm_studio_reachable: null,
      chat_model: "qwen3-32b",
      embed_model: "bge-m3",
      checked_at: "2026-08-29T10:00:00.000Z",
      latency_ms: 12,
    });
    const app = await buildApp(workspaceStatus);

    const response = await app.inject({ method: "GET", url: "/api/status", headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      locality: "remote",
      endpoint_reachable: true,
      lm_studio_reachable: null,
      chat_model: "qwen3-32b",
      embed_model: "bge-m3",
      checked_at: "2026-08-29T10:00:00.000Z",
      latency_ms: 12,
    });
    expect(workspaceStatus).toHaveBeenCalledOnce();
    await app.close();
  });

  it("keeps health and status independent", async () => {
    const app = await buildApp(vi.fn().mockResolvedValue({ locality: "local" }));
    const unauthorizedHealth = await app.inject({ method: "GET", url: "/api/health" });
    expect(unauthorizedHealth.statusCode).toBe(401);
    const status = await app.inject({ method: "GET", url: "/api/status", headers: auth });
    expect(status.statusCode).toBe(200);
    await app.close();
  });
});
