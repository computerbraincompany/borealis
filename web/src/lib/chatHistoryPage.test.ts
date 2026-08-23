import { prependOlderMessages } from "@/lib/chatHistoryPage";
import type { Message } from "@/lib/api";

const message = (id: string): Message => ({
  id,
  role: "assistant",
  content: id,
  created_at: "2026-01-01T00:00:00Z",
});

describe("prependOlderMessages", () => {
  it("prepends the cursor page in order and deduplicates its boundary", () => {
    expect(prependOlderMessages([message("3"), message("4")], [message("1"), message("2"), message("3")])).toEqual([
      message("1"),
      message("2"),
      message("3"),
      message("4"),
    ]);
  });
});
