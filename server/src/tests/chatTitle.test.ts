import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), save: vi.fn(), ack: vi.fn(), settings: vi.fn() }));
vi.mock("../llm.js", () => ({ createOpenAiClient: () => ({ chat: { completions: { create: mocks.create } } }) }));
vi.mock("../runtimeSettings.js", () => ({ getEffectiveLlmSettings: mocks.settings }));
vi.mock("../storageRuntime.js", () => ({
  storageRuntime: () => ({ chats: { suggestTitle: mocks.save, getRemoteEgressAckAt: mocks.ack } }),
}));
import { parseSuggestedTitle, suggestChatTitle } from "../chatTitle.js";
import type { AcceptedChatTurn } from "../turnContext.js";
const turn = {
  chatId: "chat",
  model: "model",
  automaticTitleBaseline: "Analyze my spending",
  userMessage: { content: "Analyze my spending" },
} as AcceptedChatTurn;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ llmBaseUrl: "http://127.0.0.1:1234" });
  mocks.create.mockResolvedValue({ choices: [{ message: { content: "Spending overview" } }] });
});
describe("automatic chat titles", () => {
  it("rejects reasoning-only, multiline and oversized suggestions", () => {
    expect(parseSuggestedTitle('<think>private thought</think>"Spending overview"')).toBe("Spending overview");
    for (const value of [null, "<think>unfinished", "Title\nExplanation", "a".repeat(61), ""])
      expect(parseSuggestedTitle(value)).toBeNull();
  });
  it("uses the accepted model, no tools and a bounded request", async () => {
    await suggestChatTitle("account", turn, new AbortController().signal);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ model: "model", max_tokens: 512 });
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(mocks.create.mock.calls[0][1]).toMatchObject({ timeout: 10000, maxRetries: 0 });
    expect(mocks.save).toHaveBeenCalledWith("account", "chat", "Analyze my spending", "Spending overview");
  });
  it("keeps the fallback on failure and does not send data without remote consent", async () => {
    mocks.create.mockRejectedValue(new Error("private provider failure"));
    await expect(suggestChatTitle("account", turn, new AbortController().signal)).resolves.toBeUndefined();
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.create.mockClear();
    mocks.settings.mockResolvedValue({ llmBaseUrl: "https://example.com" });
    mocks.ack.mockResolvedValue(null);
    await suggestChatTitle("account", turn, new AbortController().signal);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
