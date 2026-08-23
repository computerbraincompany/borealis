import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { chatOnce, client, embed, streamingChat } from "../llm.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("explicit model routing", () => {
  it("sends the supplied model through non-streaming chat completions", async () => {
    const create = vi.spyOn(client.chat.completions, "create").mockResolvedValue({
      id: "completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    } as any);

    await chatOnce([], { model: "selected-chat-a" });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "selected-chat-a" }), {
      timeout: 120_000,
      maxRetries: 0,
    });
  });

  it("sends the supplied model through streaming chat completions", async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    const create = vi.spyOn(client.chat.completions, "create").mockReturnValue(chunks() as any);

    const result = await streamingChat([], { model: "selected-chat-b" }, () => {});

    expect(result.choices[0].message.content).toBe("ok");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "selected-chat-b", stream: true }),
      expect.objectContaining({ timeout: 120_000, maxRetries: 0, signal: expect.any(AbortSignal) })
    );
  });

  it.each([
    ["sparse tool index", { tool_calls: [{ index: 1_000_000_000, function: { name: "query_data" } }] }],
    ["oversized content", { content: "x".repeat(32_001) }],
    ["oversized tool arguments", { tool_calls: [{ index: 0, function: { arguments: "x".repeat(20_001) } }] }],
  ])("aborts a provider stream with %s at the accumulation boundary", async (_label, delta) => {
    async function* chunks() {
      yield { choices: [{ delta }] };
    }
    vi.spyOn(client.chat.completions, "create").mockReturnValue(chunks() as any);
    await expect(streamingChat([], { model: "selected-chat-b" }, () => {})).rejects.toThrow(
      "model stream budget exceeded"
    );
  });

  it("keeps embeddings on the configured embedding model as floats", async () => {
    const create = vi.spyOn(client.embeddings, "create").mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }],
    } as any);

    await expect(embed(["hello"])).resolves.toEqual([[0.1, 0.2]]);
    expect(create).toHaveBeenCalledWith(
      {
        model: config.embedModel,
        input: ["hello"],
        encoding_format: "float",
      },
      { timeout: 60_000, maxRetries: 0 }
    );
  });
});
