import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiModule from "@/lib/api";
import { ApiError, chatsApi, modelsApi, sourcesApi, type Chat, type ChatDetail, type Message } from "@/lib/api";
import { ChatView } from "@/pages/ChatView";

vi.mock("@/components/ChatHistory", () => ({
  ChatHistory: ({
    chats,
    onOpen,
    onDelete,
  }: {
    chats: Array<{ id: string; title: string }>;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void | Promise<void>;
  }) => (
    <div>
      {chats.map((chat) => (
        <div key={chat.id}>
          <button onClick={() => onOpen(chat.id)}>Open {chat.title}</button>
          <button onClick={() => void onDelete(chat.id)}>Delete {chat.title}</button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/ChatMessage", () => ({
  ChatMessage: ({ role, content }: { role: string; content: string }) => (
    <article data-testid={`message-${role}`}>{content}</article>
  ),
}));

vi.mock("@/components/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

vi.mock("@/components/ChatSourcePicker", () => ({
  ChatSourcePicker: () => <div data-testid="source-picker" />,
}));

vi.mock("@/components/ToolActivity", () => ({
  ToolActivity: () => <div data-testid="tool-activity" />,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const chat: Chat = {
  id: "chat-a",
  title: "Alpha",
  model: "qwen-chat",
  source_mode: "selected",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const chatB: Chat = {
  ...chat,
  id: "chat-b",
  title: "Beta",
};

function message(id: string, content = id): Message {
  return {
    id,
    role: "assistant",
    content,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function detail(overrides: Partial<ChatDetail> = {}): ChatDetail {
  return {
    ...chat,
    messages: [],
    sources: [],
    active_run: null,
    messages_page: { has_more: false, next_before_message_id: null },
    ...overrides,
  };
}

describe("ChatView orchestration", () => {
  beforeEach(() => {
    window.location.hash = "#/chat";
    vi.spyOn(chatsApi, "list").mockResolvedValue([chat]);
    vi.spyOn(chatsApi, "get").mockResolvedValue(detail());
    vi.spyOn(chatsApi, "create").mockResolvedValue(chat);
    vi.spyOn(chatsApi, "remove").mockResolvedValue({ ok: true });
    vi.spyOn(chatsApi, "cancelRun").mockResolvedValue({ ok: true, run_id: "run-1", status: "cancelling" });
    vi.spyOn(modelsApi, "list").mockResolvedValue({
      models: [{ id: "qwen-chat" }],
      default_model: "qwen-chat",
      discovery: "live",
    });
    vi.spyOn(sourcesApi, "list").mockResolvedValue([]);
  });

  it("keeps stop-before-runId connected, then cancels the owned run before aborting", async () => {
    const user = userEvent.setup();
    const cancelResponse = deferred<{ ok: true; run_id: string; status: "cancelling" }>();
    vi.mocked(chatsApi.cancelRun).mockReturnValue(cancelResponse.promise);
    let emit!: (event: unknown) => void;
    let streamSignal!: AbortSignal;
    vi.spyOn(apiModule, "streamAgentChat").mockImplementation(
      async (_chatId, _content, onEvent, signal) =>
        new Promise<void>((_resolve, reject) => {
          emit = onEvent;
          streamSignal = signal as AbortSignal;
          streamSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }),
    );

    render(<ChatView chatId="chat-a" />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "hello");
    await user.click(screen.getByTitle("Send"));
    await user.click(await screen.findByTitle("Stop generating"));

    expect(chatsApi.cancelRun).not.toHaveBeenCalled();
    expect(streamSignal.aborted).toBe(false);

    act(() => emit({ type: "run-started", run_id: "run-1" }));
    await waitFor(() => expect(chatsApi.cancelRun).toHaveBeenCalledWith("chat-a", "run-1"));
    expect(streamSignal.aborted).toBe(false);

    await act(async () => cancelResponse.resolve({ ok: true, run_id: "run-1", status: "cancelling" }));
    await waitFor(() => expect(streamSignal.aborted).toBe(true));
    expect(await screen.findByText("Generation cancelled.")).toBeInTheDocument();
  });

  it("keeps mutation gates closed until an accepted cancellation is durably terminal", async () => {
    const user = userEvent.setup();
    vi.mocked(chatsApi.get)
      .mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new ApiError(503, "detail temporarily unavailable"))
      .mockResolvedValueOnce(detail({ active_run: { id: "run-cancelling", status: "cancelling" } }))
      .mockResolvedValueOnce(detail({ active_run: null }));
    vi.mocked(chatsApi.cancelRun).mockResolvedValue({
      ok: true,
      run_id: "run-cancelling",
      status: "cancelling",
    });
    vi.spyOn(apiModule, "streamAgentChat").mockImplementation(
      async (_chatId, _content, onEvent, signal) =>
        new Promise<void>((_resolve, reject) => {
          onEvent({ type: "run-started", run_id: "run-cancelling" });
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    );

    render(<ChatView chatId="chat-a" />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "cancel safely");
    await user.click(screen.getByTitle("Send"));
    await user.click(await screen.findByTitle("Stop generating"));

    await waitFor(() => expect(chatsApi.get).toHaveBeenCalledTimes(2));
    expect(screen.getByTitle("Stopping…")).toBeInTheDocument();
    expect(screen.queryByTitle("Send")).not.toBeInTheDocument();

    await waitFor(() => expect(chatsApi.get).toHaveBeenCalledTimes(3), { timeout: 2_000 });
    expect(screen.getByTitle("Stopping…")).toBeInTheDocument();
    expect(screen.queryByTitle("Send")).not.toBeInTheDocument();

    expect(await screen.findByText("Generation cancelled.", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(chatsApi.get).toHaveBeenCalledTimes(4);
  });

  it("rejects a stale same-chat cursor page after a newer detail request owns the view", async () => {
    const user = userEvent.setup();
    const stalePage = deferred<ChatDetail>();
    vi.mocked(chatsApi.get)
      .mockResolvedValueOnce(
        detail({
          messages: [message("m3", "current boundary"), message("m4", "current newest")],
          messages_page: { has_more: true, next_before_message_id: "m3" },
        }),
      )
      .mockReturnValueOnce(stalePage.promise)
      .mockResolvedValueOnce(detail({ messages: [message("fresh", "authoritative same-chat detail")] }));

    render(<ChatView chatId="chat-a" />);
    await screen.findByText("current newest");
    await user.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(chatsApi.get).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(await screen.findByText("authoritative same-chat detail")).toBeInTheDocument();

    await act(async () =>
      stalePage.resolve(
        detail({
          messages: [message("m1", "stale old page"), message("m3", "current boundary")],
          messages_page: { has_more: false, next_before_message_id: null },
        }),
      ),
    );
    expect(screen.queryByText("stale old page")).not.toBeInTheDocument();
    expect(screen.getByText("authoritative same-chat detail")).toBeInTheDocument();
  });

  it("single-flights New Chat and lets a newer manual navigation retain ownership", async () => {
    const createResponse = deferred<Chat>();
    vi.mocked(chatsApi.create).mockReturnValue(createResponse.promise);
    vi.mocked(chatsApi.get).mockResolvedValue(detail());

    render(<ChatView />);
    const newChat = await screen.findByRole("button", { name: "New chat" });
    fireEvent.click(newChat);
    fireEvent.click(newChat);
    expect(chatsApi.create).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Open Alpha" }));
    await waitFor(() => expect(window.location.hash).toBe("#/chat/chat-a"));

    await act(async () => createResponse.resolve({ ...chat, id: "chat-new", title: "New chat" }));
    await waitFor(() => expect(chatsApi.list).toHaveBeenCalledTimes(2));
    expect(chatsApi.get).not.toHaveBeenCalledWith("chat-new", expect.anything());
    expect(window.location.hash).toBe("#/chat/chat-a");
  });

  it("creates and navigates exactly once when the New Chat route is replayed by StrictMode", async () => {
    const createResponse = deferred<Chat>();
    vi.mocked(chatsApi.create).mockReturnValue(createResponse.promise);
    vi.mocked(chatsApi.get).mockResolvedValue(detail({ id: "chat-new", title: "New chat" }));

    render(
      <StrictMode>
        <ChatView newChatRequest="/chat/new?request=1" />
      </StrictMode>,
    );
    await waitFor(() => expect(chatsApi.create).toHaveBeenCalledTimes(1));
    await act(async () => createResponse.resolve({ ...chat, id: "chat-new", title: "New chat" }));

    await waitFor(() => expect(chatsApi.get).toHaveBeenCalledWith("chat-new", { limit: 50 }));
    expect(chatsApi.create).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/chat/chat-new");
  });

  it("rehydrates an active run, cancels it without a local stream, and polls to a terminal UI", async () => {
    vi.spyOn(apiModule, "streamAgentChat");
    vi.mocked(chatsApi.get)
      .mockResolvedValueOnce(detail({ active_run: { id: "run-rehydrated", status: "running" } }))
      .mockResolvedValueOnce(detail({ active_run: null }));
    vi.mocked(chatsApi.cancelRun).mockResolvedValue({
      ok: true,
      run_id: "run-rehydrated",
      status: "cancelling",
    });

    render(<ChatView chatId="chat-a" />);
    fireEvent.click(await screen.findByTitle("Stop generating"));
    await waitFor(() => expect(chatsApi.cancelRun).toHaveBeenCalledWith("chat-a", "run-rehydrated"));

    expect(await screen.findByText("Generation cancelled.", {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(apiModule.streamAgentChat).not.toHaveBeenCalled();
  });

  it("keeps action gates closed while recovering an accepted run after SSE disconnects", async () => {
    const user = userEvent.setup();
    const authoritative = deferred<ChatDetail>();
    vi.mocked(chatsApi.get).mockResolvedValueOnce(detail()).mockReturnValueOnce(authoritative.promise);
    vi.spyOn(apiModule, "streamAgentChat").mockImplementation(async (_chatId, _content, onEvent) => {
      onEvent({ type: "run-started", run_id: "run-disconnected" });
      throw new Error("connection lost");
    });

    render(<ChatView chatId="chat-a" />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "continue on the server");
    await user.click(screen.getByTitle("Send"));

    await waitFor(() => expect(chatsApi.get).toHaveBeenCalledTimes(2));
    expect(screen.getByTitle("Stop generating")).toBeInTheDocument();
    expect(screen.getByText(/generation connection was interrupted/i)).toBeInTheDocument();

    await act(async () => authoritative.resolve(detail({ active_run: { id: "run-disconnected", status: "running" } })));
    expect(await screen.findByTitle("Stop generating")).toBeInTheDocument();
  });

  it("replaces partial SSE output with a terminal authoritative detail after disconnect", async () => {
    const user = userEvent.setup();
    vi.mocked(chatsApi.get)
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(
        detail({
          messages: [message("persisted-assistant", "Persisted complete answer")],
          active_run: null,
        }),
      );
    vi.spyOn(apiModule, "streamAgentChat").mockImplementation(async (_chatId, _content, onEvent) => {
      onEvent({ type: "run-started", run_id: "run-committed" });
      onEvent({ type: "delta", text: "Partial streamed answer" });
      onEvent({ type: "message", content: "Partial streamed answer", meta: { model: "qwen-chat" } });
      // The connection closes after the server persisted its response but
      // before the terminal run-ended event reaches the browser.
    });

    render(<ChatView chatId="chat-a" />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "finish durably");
    await user.click(screen.getByTitle("Send"));

    expect(await screen.findByText("Persisted complete answer")).toBeInTheDocument();
    expect(screen.getAllByTestId("message-assistant")).toHaveLength(1);
    expect(screen.queryByText("Partial streamed answer")).not.toBeInTheDocument();
    expect(screen.queryByText(/generation connection was interrupted/i)).not.toBeInTheDocument();
  });

  it("preserves a safe API rejection and restores the rejected draft", async () => {
    const user = userEvent.setup();
    vi.mocked(chatsApi.get).mockResolvedValue(detail({ active_run: null }));
    vi.spyOn(apiModule, "streamAgentChat").mockRejectedValue(
      new ApiError(413, "Message exceeds the configured character limit"),
    );

    render(<ChatView chatId="chat-a" />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "oversized request");
    await user.click(screen.getByTitle("Send"));

    expect(await screen.findByText("Message exceeds the configured character limit")).toBeInTheDocument();
    expect(screen.queryByText(/generation connection was interrupted/i)).not.toBeInTheDocument();
    expect(composer).toHaveValue("oversized request");
  });

  it("clears a stranded local run when reopening its terminal chat after navigation", async () => {
    const user = userEvent.setup();
    const droppedStream = deferred<void>();
    let alphaReads = 0;
    vi.mocked(chatsApi.list).mockResolvedValue([chat, chatB]);
    vi.mocked(chatsApi.get).mockImplementation(async (id) => {
      if (id === chatB.id) return detail(chatB);
      alphaReads += 1;
      return alphaReads === 1
        ? detail()
        : detail({
            messages: [message("persisted-after-navigation", "Durable answer after navigation")],
            active_run: null,
          });
    });
    vi.spyOn(apiModule, "streamAgentChat").mockImplementation(async (_chatId, _content, onEvent) => {
      onEvent({ type: "run-started", run_id: "run-navigation-drop" });
      return droppedStream.promise;
    });

    render(<ChatView chatId={chat.id} />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "continue while I navigate");
    await user.click(screen.getByTitle("Send"));
    expect(await screen.findByTitle("Stop generating")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Beta" }));
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    await act(async () => droppedStream.reject(new Error("connection lost after navigation")));
    await waitFor(() => expect(chatsApi.list).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(await screen.findByText("Durable answer after navigation")).toBeInTheDocument();
    expect(screen.queryByTitle("Stop generating")).not.toBeInTheDocument();
    const reopenedComposer = screen.getByPlaceholderText("Ask Borealis about your data…");
    await user.type(reopenedComposer, "new turn");
    expect(screen.getByTitle("Send")).toBeEnabled();
  });

  it("does not let a delayed deletion clear a newer chat selection", async () => {
    const user = userEvent.setup();
    const deletion = deferred<{ ok: true }>();
    vi.mocked(chatsApi.list).mockResolvedValue([chat, chatB]);
    vi.mocked(chatsApi.get).mockImplementation(async (id) =>
      id === chatB.id ? detail({ ...chatB, messages: [message("beta", "Beta detail")] }) : detail(),
    );
    vi.mocked(chatsApi.remove).mockReturnValue(deletion.promise);

    render(<ChatView chatId={chat.id} />);
    await screen.findByRole("heading", { name: "Alpha" });
    await user.click(screen.getByRole("button", { name: "Delete Alpha" }));
    await user.click(screen.getByRole("button", { name: "Open Beta" }));
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/chat/chat-b");

    await act(async () => deletion.resolve({ ok: true }));
    expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/chat/chat-b");
  });

  it("clears a chat opened while its deletion is pending once deletion succeeds", async () => {
    const user = userEvent.setup();
    const deletion = deferred<{ ok: true }>();
    vi.mocked(chatsApi.list).mockResolvedValue([chat, chatB]);
    vi.mocked(chatsApi.get).mockImplementation(async (id) =>
      id === chatB.id ? detail(chatB) : detail({ messages: [message("alpha", "Alpha detail")] }),
    );
    vi.mocked(chatsApi.remove).mockReturnValue(deletion.promise);

    render(<ChatView chatId={chatB.id} />);
    await screen.findByRole("heading", { name: "Beta" });
    await user.click(screen.getByRole("button", { name: "Delete Alpha" }));
    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/chat/chat-a");

    await act(async () => deletion.resolve({ ok: true }));
    expect(screen.getByRole("heading", { name: "Chat with Borealis" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/chat");
  });
});
