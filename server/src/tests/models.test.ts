import { afterEach, describe, expect, it, vi } from "vitest";
import { config, validateModelIds } from "../config.js";
import {
  client,
  createChatModelDiscovery,
  discoverChatModels,
  normalizeChatModels,
} from "../llm.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateModelIds", () => {
  it("trims and returns distinct valid IDs", () => {
    expect(validateModelIds({ chatModel: "  chat-a  ", embedModel: "  embed-a  " })).toEqual({
      chatModel: "chat-a",
      embedModel: "embed-a",
    });
  });

  it.each([
    [{ chatModel: "   ", embedModel: "embed-a" }, "LITELLM_CHAT_MODEL"],
    [{ chatModel: "chat-a", embedModel: "   " }, "LITELLM_EMBED_MODEL"],
    [{ chatModel: "x".repeat(257), embedModel: "embed-a" }, "LITELLM_CHAT_MODEL"],
    [{ chatModel: "chat-a", embedModel: "x".repeat(257) }, "LITELLM_EMBED_MODEL"],
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
      "LITELLM_CHAT_MODEL and LITELLM_EMBED_MODEL must be distinct"
    );
    try {
      validateModelIds({ chatModel: value, embedModel: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
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

    await expect(discover()).resolves.toEqual({ models: [{ id: "chat-a" }], discovery: "live" });
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
      { models: [{ id: "chat-a" }], discovery: "live" },
      { models: [{ id: "chat-a" }], discovery: "live" },
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
    await expect(discover()).resolves.toEqual({ models: [{ id: "chat-a" }], discovery: "live" });
    await expect(discover({ refresh: true })).resolves.toEqual({ models: [{ id: "chat-b" }], discovery: "live" });
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it("returns a safe degraded state and does not cache failures", async () => {
    const upstreamDetail = "secret-key-and-endpoint-detail";
    const listModels = vi.fn().mockRejectedValue(new Error(upstreamDetail));
    const warn = vi.fn();
    const discover = createChatModelDiscovery({ listModels, warn });

    await expect(discover()).resolves.toEqual({ models: [], discovery: "unavailable" });
    await expect(discover()).resolves.toEqual({ models: [], discovery: "unavailable" });
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("model discovery unavailable");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(upstreamDetail);
  });

  it("uses a five-second timeout and disables SDK retries", async () => {
    const list = vi.spyOn(client.models, "list").mockResolvedValue({ data: [] } as any);

    await expect(discoverChatModels({ refresh: true })).resolves.toEqual({ models: [], discovery: "live" });
    expect(list).toHaveBeenCalledWith({ timeout: 5_000, maxRetries: 0 });
  });

  it("excludes the configured embedding model in discovered results", async () => {
    const listModels = vi.fn().mockResolvedValue({
      data: [{ id: config.embedModel }, { id: `${config.embedModel}-chat` }],
    });
    const discover = createChatModelDiscovery({ listModels, warn: vi.fn() });

    await expect(discover()).resolves.toEqual({
      models: [{ id: `${config.embedModel}-chat` }],
      discovery: "live",
    });
  });
});
