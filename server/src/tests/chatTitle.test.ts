import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ chatOnce: vi.fn(), save: vi.fn() }));
vi.mock("../llm.js", () => ({ chatOnce: mocks.chatOnce }));
vi.mock("../storageRuntime.js", () => ({
  storageRuntime: () => ({ chats: { suggestTitle: mocks.save } }),
}));
import { RemoteEgressConsentRequiredError } from "../egressPolicy.js";
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
  mocks.chatOnce.mockResolvedValue({ choices: [{ message: { content: "Spending overview" } }] });
});
describe("automatic chat titles", () => {
  it("rejects reasoning-only, multiline and oversized suggestions", () => {
    expect(parseSuggestedTitle('<think>private thought</think>"Spending overview"')).toBe("Spending overview");
    for (const value of [null, "<think>unfinished", "Title\nExplanation", "a".repeat(61), ""])
      expect(parseSuggestedTitle(value)).toBeNull();
  });
  it("uses the accepted model, owning account, no tools and a bounded request", async () => {
    await suggestChatTitle("account", turn, new AbortController().signal);
    expect(mocks.chatOnce.mock.calls[0][1]).toMatchObject({
      accountId: "account",
      model: "model",
      maxTokens: 512,
      temperature: 0.2,
    });
    expect(mocks.chatOnce.mock.calls[0][1]).not.toHaveProperty("tools");
    expect(mocks.save).toHaveBeenCalledWith("account", "chat", "Analyze my spending", "Spending overview");
  });
  it("keeps the fallback on failure and on a denied provider-consent boundary", async () => {
    mocks.chatOnce.mockRejectedValue(new Error("private provider failure"));
    await expect(suggestChatTitle("account", turn, new AbortController().signal)).resolves.toBeUndefined();
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.chatOnce.mockClear();
    // The account-scoped LLM boundary denies an unacknowledged remote origin
    // before any transport; the suggestion stays silent and never persists.
    mocks.chatOnce.mockRejectedValue(new RemoteEgressConsentRequiredError());
    await suggestChatTitle("account", turn, new AbortController().signal);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
