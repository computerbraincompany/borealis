import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../pythonClient.js", () => ({ py: { health: vi.fn() } }));

import { createSystemHealthCheck } from "../systemHealth.js";

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
    expect(JSON.stringify(result)).not.toMatch(/localhost|1234|4000|token|key/i);
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
      description: "Chat and embedding requests cannot reach LiteLLM.",
    });
    expect(JSON.stringify(result)).not.toContain("secret upstream trace");
  });
});
