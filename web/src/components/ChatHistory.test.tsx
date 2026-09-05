import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatHistory } from "@/components/ChatHistory";
import type { Chat } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  formatApiError: (_error: unknown, fallback: string) => fallback,
}));

const chat: Chat = {
  id: "c1",
  title: "Budget chat",
  model: "test-model",
  source_mode: "all",
  agent: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function renderHistory(props: Partial<React.ComponentProps<typeof ChatHistory>> = {}) {
  return render(
    <ChatHistory
      chats={[chat]}
      busyChatIds={new Set()}
      hasMore={false}
      loadingMore={false}
      onOpen={() => undefined}
      onDelete={() => undefined}
      onRename={async () => undefined}
      onLoadMore={() => undefined}
      {...props}
    />,
  );
}

describe("ChatHistory error surfacing", () => {
  it("keeps cached rows visible but shows an inline retry strip when a refresh fails", () => {
    const onRetry = vi.fn();
    renderHistory({ error: "The chat list is temporarily unavailable", onRetry });

    expect(screen.getByRole("alert")).toHaveTextContent("The chat list is temporarily unavailable");
    expect(screen.getByText("Budget chat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows the full error block when there are no cached rows", () => {
    renderHistory({ chats: [], error: "The chat list is temporarily unavailable", onRetry: () => undefined });

    expect(screen.getByRole("alert")).toHaveTextContent("The chat list is temporarily unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("stays silent when the list is healthy", () => {
    renderHistory();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Budget chat")).toBeInTheDocument();
  });
});
