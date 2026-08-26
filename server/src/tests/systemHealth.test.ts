import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../dataService.js", () => ({ dataService: { health: vi.fn() } }));
vi.mock("../storageRuntime.js", () => ({ storageRuntime: vi.fn() }));

import { dataService } from "../dataService.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";
import { storageRuntime } from "../storageRuntime.js";
import { checkSystemHealth, createSystemHealthCheck } from "../systemHealth.js";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-health-"));
  await initializeRuntimeSettings({ settingsFile: path.join(temporaryDirectory, "settings.json"), env: {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  closeRuntimeSettings();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("system dependency health", () => {
  it("reports the ordered request path as operational without exposing configuration", async () => {
    const database = vi.fn().mockResolvedValue(true);
    const dataService = vi.fn().mockResolvedValue(true);
    const modelGateway = vi.fn().mockResolvedValue(true);
    const modelRuntime = vi.fn().mockResolvedValue(true);
    const check = createSystemHealthCheck({
      now: () => Date.parse("2026-08-26T09:30:00.000Z"),
      database,
      dataService,
      modelGateway,
      modelRuntime,
    });

    const result = await check();

    expect(result.status).toBe("operational");
    expect(result.checked_at).toBe("2026-08-26T09:30:00.000Z");
    expect(result.services.map((service) => service.id)).toEqual([
      "api",
      "database",
      "data_service",
      "model_gateway",
      "model_runtime",
    ]);
    expect(result.services.every((service) => service.status === "operational")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/localhost|1234|4444|token|key/i);
    expect(database).toHaveBeenCalledOnce();
    expect(dataService).toHaveBeenCalledOnce();
    expect(modelGateway).toHaveBeenCalledOnce();
    expect(modelRuntime).toHaveBeenCalledOnce();
  });

  it("degrades individual dependencies and converts probe exceptions to safe status", async () => {
    const check = createSystemHealthCheck({
      now: () => 0,
      database: vi.fn().mockResolvedValue(true),
      dataService: vi.fn().mockResolvedValue(false),
      modelGateway: vi.fn().mockRejectedValue(new Error("secret upstream trace")),
      modelRuntime: vi.fn().mockResolvedValue(true),
    });

    const result = await check();

    expect(result.status).toBe("degraded");
    expect(result.services.find((service) => service.id === "data_service")).toMatchObject({
      status: "unavailable",
      description: "Dataset queries, charts, and reports are unavailable.",
    });
    expect(result.services.find((service) => service.id === "model_gateway")).toMatchObject({
      status: "unavailable",
      description: "Chat and embedding requests cannot reach the configured endpoint.",
    });
    expect(JSON.stringify(result)).not.toContain("secret upstream trace");
  });

  it("omits the optional runtime when the configured endpoint is LM Studio", async () => {
    const check = createSystemHealthCheck({
      now: () => 0,
      database: vi.fn().mockResolvedValue(true),
      dataService: vi.fn().mockResolvedValue(true),
      modelGateway: vi.fn().mockResolvedValue(true),
    });

    const result = await check();

    expect(result.services.map((service) => service.id)).toEqual(["api", "database", "data_service", "model_gateway"]);
    expect(result.services.find((service) => service.id === "model_gateway")).toMatchObject({
      name: "Model endpoint",
      description: "Model requests can reach the configured endpoint.",
    });
  });

  it("probes the configured OpenAI-compatible catalog once for the deduplicated default", async () => {
    vi.mocked(storageRuntime).mockReturnValue({ ledger: { health: vi.fn().mockResolvedValue(true) } } as never);
    vi.mocked(dataService.health).mockResolvedValue(true);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: { cancel } });
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkSystemHealth();

    expect(result.services.map((service) => service.id)).toEqual(["api", "database", "data_service", "model_gateway"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1234/v1/models", {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("hot-applies a remote endpoint and probes a distinct LM Studio runtime without disclosure", async () => {
    vi.mocked(storageRuntime).mockReturnValue({ ledger: { health: vi.fn().mockResolvedValue(true) } } as never);
    vi.mocked(dataService.health).mockResolvedValue(true);
    await runtimeSettingsStore().patch({
      llmBaseUrl: "https://cloud-provider.example.test",
      apiKey: "health-provider-secret",
      lmStudioBaseUrl: "http://localhost:1234",
    });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: { cancel } });
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkSystemHealth();

    expect(result.services.map((service) => service.id)).toEqual([
      "api",
      "database",
      "data_service",
      "model_gateway",
      "model_runtime",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/cloud-provider|localhost|1234|health-provider-secret/i);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://cloud-provider.example.test/v1/models", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        Authorization: "Bearer health-provider-secret",
      },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost:1234/v1/models", {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
