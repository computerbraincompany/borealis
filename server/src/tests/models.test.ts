import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateModelIds } from "../config.js";
import { createChatModelDiscovery, discoverChatModels, getLlmClient, normalizeChatModels } from "../llm.js";
import { resolveLlmModelId } from "../llmAliases.js";
import { closeRuntimeSettings, initializeRuntimeSettings, runtimeSettingsStore } from "../runtimeSettings.js";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-models-"));
  await initializeRuntimeSettings({ settingsFile: path.join(temporaryDirectory, "settings.json"), env: {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeRuntimeSettings();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("validateModelIds", () => {
  it("trims and returns distinct valid IDs", () => {
    expect(validateModelIds({ chatModel: "  chat-a  ", embedModel: "  embed-a  " })).toEqual({
      chatModel: "chat-a",
      embedModel: "embed-a",
    });
  });

  it.each([
    [{ chatModel: "   ", embedModel: "embed-a" }, "LLM_CHAT_MODEL"],
    [{ chatModel: "chat-a", embedModel: "   " }, "LLM_EMBED_MODEL"],
    [{ chatModel: "x".repeat(257), embedModel: "embed-a" }, "LLM_CHAT_MODEL"],
    [{ chatModel: "chat-a", embedModel: "x".repeat(257) }, "LLM_EMBED_MODEL"],
  ])("rejects blank and oversized IDs without echoing values", (input, variable) => {
    expect(() => validateModelIds(input)).toThrow(variable);
    try {
      validateModelIds(input);
    } catch (error) {
      expect(String(error)).not.toContain("x".repeat(257));
    }
  });

  it("rejects equal IDs without echoing the ID", () => {
    const value = "private-model-identity";
    expect(() => validateModelIds({ chatModel: value, embedModel: ` ${value} ` })).toThrow(
      "LLM_CHAT_MODEL and LLM_EMBED_MODEL must be distinct"
    );
    try {
      validateModelIds({ chatModel: value, embedModel: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });

  it("rejects logical and physical forms of the same aliased model", () => {
    expect(() =>
      validateModelIds({ chatModel: "nomic-embed", embedModel: "text-embedding-nomic-embed-text-v1.5" })
    ).toThrow("LLM_CHAT_MODEL and LLM_EMBED_MODEL must be distinct");
  });
});

describe("normalizeChatModels", () => {
  it("normalizes a standard page, deduplicates exact IDs, and sorts deterministically", () => {
    expect(
      normalizeChatModels(
        {
          object: "list",
          data: [
            { id: " zeta ", owned_by: " provider-z " },
            { id: "alpha", owned_by: "provider-a" },
            { id: "alpha", owned_by: "duplicate" },
          ],
        },
        "embedding-model"
      )
    ).toEqual([
      { id: "alpha", owned_by: "provider-a" },
      { id: "zeta", owned_by: "provider-z" },
    ]);
  });

  it("drops malformed, blank, oversized, and non-string IDs", () => {
    expect(
      normalizeChatModels(
        {
          data: [null, {}, { id: 42 }, { id: "  " }, { id: "x".repeat(257) }, { id: "valid" }],
        },
        "embedding-model"
      )
    ).toEqual([{ id: "valid" }]);
    expect(normalizeChatModels(null, "embedding-model")).toEqual([]);
    expect(normalizeChatModels({ data: "not-an-array" }, "embedding-model")).toEqual([]);
  });

  it("excludes only the exact configured embedding ID", () => {
    expect(
      normalizeChatModels(
        { data: [{ id: "embed" }, { id: "embed-chat" }, { id: "my-embed" }, { id: "Embed" }] },
        "embed"
      ).map((model) => model.id)
    ).toEqual(["Embed", "embed-chat", "my-embed"]);
  });

  it("publishes logical aliases and hides both forms of the embedding model", () => {
    expect(
      normalizeChatModels(
        {
          data: [
            { id: "qwen/qwen3.6-35b-a3b", owned_by: "LM Studio" },
            { id: "qwen-chat", owned_by: "duplicate" },
            { id: "text-embedding-nomic-embed-text-v1.5" },
            { id: "nomic-embed" },
            { id: "cloud/model-a" },
          ],
        },
        "nomic-embed"
      )
    ).toEqual([{ id: "cloud/model-a" }, { id: "qwen-chat", owned_by: "LM Studio" }]);
  });

  it("trims and bounds string ownership while omitting invalid ownership", () => {
    const models = normalizeChatModels(
      {
        data: [
          { id: "a", owned_by: `  ${"o".repeat(300)}  ` },
          { id: "b", owned_by: "   " },
          { id: "c", owned_by: 123 },
        ],
      },
      "embedding-model"
    );
    expect(models[0].owned_by).toHaveLength(256);
    expect(models[1]).toEqual({ id: "b" });
    expect(models[2]).toEqual({ id: "c" });
  });
});

describe("chat model discovery", () => {
  it("caches successful results for 15 seconds", async () => {
    let now = 1_000;
    const listModels = vi.fn().mockResolvedValue({ data: [{ id: "chat-a" }] });
    const discover = createChatModelDiscovery({ listModels, now: () => now, warn: vi.fn() });

    await expect(discover()).resolves.toEqual({
      models: [{ id: "chat-a" }],
      available_models: [{ id: "chat-a" }],
      discovery: "live",
    });
    now += 14_999;
    await discover();
    expect(listModels).toHaveBeenCalledTimes(1);

    now += 1;
    await discover();
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("coalesces an in-flight request", async () => {
    let resolvePage: ((page: unknown) => void) | undefined;
    const page = new Promise<unknown>((resolve) => {
      resolvePage = resolve;
    });
    const listModels = vi.fn(() => page);
    const discover = createChatModelDiscovery({ listModels, warn: vi.fn() });

    const first = discover();
    const second = discover();
    expect(listModels).toHaveBeenCalledTimes(1);
    resolvePage?.({ data: [{ id: "chat-a" }] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { models: [{ id: "chat-a" }], available_models: [{ id: "chat-a" }], discovery: "live" },
      { models: [{ id: "chat-a" }], available_models: [{ id: "chat-a" }], discovery: "live" },
    ]);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("lets refresh bypass the settled cache", async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "chat-a" }] })
      .mockResolvedValueOnce({ data: [{ id: "chat-b" }] });
    const discover = createChatModelDiscovery({ listModels, warn: vi.fn() });

    await discover();
    await expect(discover()).resolves.toEqual({
      models: [{ id: "chat-a" }],
      available_models: [{ id: "chat-a" }],
      discovery: "live",
    });
    await expect(discover({ refresh: true })).resolves.toEqual({
      models: [{ id: "chat-b" }],
      available_models: [{ id: "chat-b" }],
      discovery: "live",
    });
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("returns a safe degraded state and does not cache failures", async () => {
    const upstreamDetail = "secret-key-and-endpoint-detail";
    const listModels = vi.fn().mockRejectedValue(new Error(upstreamDetail));
    const warn = vi.fn();
    const discover = createChatModelDiscovery({ listModels, warn });

    await expect(discover()).resolves.toEqual({ models: [], available_models: [], discovery: "unavailable" });
    await expect(discover()).resolves.toEqual({ models: [], available_models: [], discovery: "unavailable" });
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("model discovery unavailable");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(upstreamDetail);
  });

  it("uses a five-second timeout and disables SDK retries", async () => {
    const client = await getLlmClient();
    const list = vi.spyOn(client.models, "list").mockResolvedValue({ data: [] } as any);

    await expect(discoverChatModels({ refresh: true })).resolves.toEqual({
      models: [],
      available_models: [],
      discovery: "live",
    });
    expect(list).toHaveBeenCalledWith({ timeout: 5_000, maxRetries: 0 });
  });

  it("excludes the configured embedding model in discovered results", async () => {
    const listModels = vi.fn().mockResolvedValue({
      data: [{ id: "nomic-embed" }, { id: "nomic-embed-chat" }],
    });
    const discover = createChatModelDiscovery({ listModels, warn: vi.fn() });

    await expect(discover()).resolves.toEqual({
      models: [{ id: "nomic-embed-chat" }],
      available_models: [{ id: "nomic-embed" }, { id: "nomic-embed-chat" }],
      discovery: "live",
    });
  });

  it("sends configured aliases to discovery as logical public ids", async () => {
    const listModels = vi.fn().mockResolvedValue({
      data: [{ id: resolveLlmModelId("qwen-chat") }, { id: resolveLlmModelId("nomic-embed") }],
    });
    const discover = createChatModelDiscovery({ listModels, warn: vi.fn() });

    await expect(discover()).resolves.toEqual({
      models: [{ id: "qwen-chat" }],
      available_models: [{ id: "nomic-embed" }, { id: "qwen-chat" }],
      discovery: "live",
    });
  });

  it("rebuilds the SDK client and discovery cache when persisted settings change", async () => {
    const firstClient = await getLlmClient();
    const firstList = vi.spyOn(firstClient.models, "list").mockResolvedValue({ data: [{ id: "first-chat" }] } as any);
    await expect(discoverChatModels()).resolves.toEqual({
      models: [{ id: "first-chat" }],
      available_models: [{ id: "first-chat" }],
      discovery: "live",
    });

    await runtimeSettingsStore().patch({
      llmBaseUrl: "https://second-provider.example.test",
      apiKey: "second-provider-secret",
      chatModel: "second-chat",
      embedModel: "second-embed",
    });
    const secondClient = await getLlmClient();
    expect(secondClient).not.toBe(firstClient);
    expect(secondClient.baseURL).toBe("https://second-provider.example.test/v1");
    const secondList = vi
      .spyOn(secondClient.models, "list")
      .mockResolvedValue({ data: [{ id: "second-embed" }, { id: "second-chat" }] } as any);

    await expect(discoverChatModels()).resolves.toEqual({
      models: [{ id: "second-chat" }],
      available_models: [{ id: "second-chat" }, { id: "second-embed" }],
      discovery: "live",
    });
    expect(firstList).toHaveBeenCalledOnce();
    expect(secondList).toHaveBeenCalledOnce();
  });
});
