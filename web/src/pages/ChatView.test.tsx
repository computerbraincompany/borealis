import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiModule from "@/lib/api";
import {
  ApiError,
  agentsApi,
  chatsApi,
  librariesApi,
  modelsApi,
  sourcesApi,
  type AgentSummary,
  type AttachedSource,
  type CatalogPage,
  type Chat,
  type ChatDetail,
  type ChatModelOption,
  type LibrarySummary,
  type Message,
  type Source,
  type SourceMode,
  type SourceScopeInput,
} from "@/lib/api";
import { resetModelCatalogStoreForTests } from "@/hooks/useModelCatalog";
import { ChatView } from "@/pages/ChatView";

vi.mock("@/components/ChatHistory", () => ({
  ChatHistory: ({
    chats,
    hasMore,
    loadingMore,
    onOpen,
    onDelete,
    onLoadMore,
  }: {
    chats: Array<{ id: string; title: string }>;
    hasMore: boolean;
    loadingMore: boolean;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void | Promise<void>;
    onLoadMore: () => void | Promise<void>;
  }) => (
    <div>
      {chats.map((chat) => (
        <div key={chat.id}>
          <button onClick={() => onOpen(chat.id)}>Open {chat.title}</button>
          <button onClick={() => void onDelete(chat.id)}>Delete {chat.title}</button>
        </div>
      ))}
      {hasMore && (
        <button type="button" disabled={loadingMore} onClick={() => void onLoadMore()}>
          {loadingMore ? "Loading older conversations…" : "Load older conversations"}
        </button>
      )}
    </div>
  ),
}));

vi.mock("@/components/ChatMessage", () => ({
  ChatMessage: ({ role, content }: { role: string; content: string }) => (
    <article data-testid={`message-${role}`}>{content}</article>
  ),
}));

vi.mock("@/components/ModelSelector", () => ({
  ModelSelector: ({
    model,
    models,
    pending,
    streaming,
    onChange,
  }: {
    model: string;
    models: ChatModelOption[];
    pending: boolean;
    streaming: boolean;
    onChange: (model: string) => void;
  }) => (
    <div data-testid="model-selector">
      <button type="button" aria-label={`Chat model: ${model}`} disabled={pending || streaming}>
        {model}
      </button>
      {models
        .filter((option) => option.id !== model)
        .map((option) => (
          <button
            key={option.id}
            type="button"
            aria-label={`Select model: ${option.id}`}
            disabled={pending || streaming}
            onClick={() => onChange(option.id)}
          >
            {option.id}
          </button>
        ))}
    </div>
  ),
}));

vi.mock("@/components/ChatSourcePicker", () => ({
  ChatSourcePicker: ({
    sourceMode,
    attachedSources,
    sources,
    sourcesLoading,
    sourcesHasMore,
    sourcesLoadingMore,
    disabled,
    saving,
    onApply,
    onLoadMoreSources,
    libraries,
    librariesHasMore,
    librariesLoadingMore,
    onLoadMoreLibraries,
  }: {
    sourceMode: SourceMode;
    attachedSources: AttachedSource[];
    sources: Source[];
    sourcesLoading: boolean;
    sourcesHasMore?: boolean;
    sourcesLoadingMore?: boolean;
    disabled: boolean;
    saving: boolean;
    onApply: (scope: SourceScopeInput) => Promise<void>;
    onLoadMoreSources?: () => void | Promise<void>;
    libraries?: Array<{ id: string; name: string }> | null;
    librariesHasMore?: boolean;
    librariesLoadingMore?: boolean;
    onLoadMoreLibraries?: () => void | Promise<void>;
  }) => {
    const sourceLabel =
      sourceMode === "all"
        ? "All sources"
        : attachedSources.length === 0
          ? "No sources"
          : `${attachedSources.length} ${attachedSources.length === 1 ? "source" : "sources"}`;
    const selectionDisabled = disabled || saving || sourcesLoading;

    return (
      <div data-testid="source-picker">
        <button type="button" aria-label={`Chat sources: ${sourceLabel}`} disabled={selectionDisabled}>
          {sourceLabel}
        </button>
        <button
          type="button"
          aria-label="Select source scope: all sources"
          disabled={selectionDisabled}
          onClick={() => void onApply({ source_mode: "all" })}
        >
          All sources
        </button>
        {sources.map((source) => (
          <button
            key={source.id}
            type="button"
            aria-label={`Select source: ${source.display_name}`}
            disabled={selectionDisabled}
            onClick={() => void onApply({ source_mode: "selected", source_ids: [source.id] })}
          >
            {source.display_name}
          </button>
        ))}
        {sourcesHasMore && (
          <button type="button" disabled={sourcesLoadingMore} onClick={() => void onLoadMoreSources?.()}>
            {sourcesLoadingMore ? "Loading more sources…" : "Load more sources"}
          </button>
        )}
        {(libraries ?? []).map((library) => (
          <span key={library.id}>{library.name}</span>
        ))}
        {librariesHasMore && (
          <button type="button" disabled={librariesLoadingMore} onClick={() => void onLoadMoreLibraries?.()}>
            {librariesLoadingMore ? "Loading more libraries…" : "Load more libraries"}
          </button>
        )}
      </div>
    );
  },
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

function catalogPage<T>(items: T[], nextCursor: string | null = null): CatalogPage<T> {
  return { items, next_cursor: nextCursor };
}

const chat: Chat = {
  id: "chat-a",
  title: "Alpha",
  model: "qwen-chat",
  source_mode: "selected",
  agent: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const chatB: Chat = {
  ...chat,
  id: "chat-b",
  title: "Beta",
};

const agentA: AgentSummary = {
  id: "agent-a",
  name: "Analyst",
  current_version: 1,
  instructions: "Analyze the selected data.",
  instructions_chars: 26,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const libraryA: LibrarySummary = {
  id: "library-a",
  name: "Finance library",
  member_count: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const source: Source = {
  id: "source-1",
  name: "quarterly-revenue.pdf",
  kind: "document",
  display_name: "Quarterly revenue.pdf",
  mime: "application/pdf",
  status: "ready",
  created_at: "2026-01-01T00:00:00Z",
};

const attachedSource: AttachedSource = {
  id: source.id,
  name: source.name,
  display_name: source.display_name,
  kind: source.kind,
  status: source.status,
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
    resetModelCatalogStoreForTests();
    window.location.hash = "#/chat";
    vi.spyOn(chatsApi, "list").mockResolvedValue(catalogPage([chat]));
    vi.spyOn(chatsApi, "get").mockResolvedValue(detail());
    vi.spyOn(chatsApi, "create").mockResolvedValue(chat);
    vi.spyOn(chatsApi, "updateModel").mockImplementation(async (id, model) => ({ ...chat, id, model }));
    vi.spyOn(chatsApi, "updateSources").mockResolvedValue({ source_mode: "selected", sources: [] });
    vi.spyOn(chatsApi, "remove").mockResolvedValue({ ok: true });
    vi.spyOn(chatsApi, "cancelRun").mockResolvedValue({ ok: true, run_id: "run-1", status: "cancelling" });
    vi.spyOn(modelsApi, "list").mockResolvedValue({
      models: [{ id: "qwen-chat" }],
      default_model: "qwen-chat",
      account_default_model: null,
      discovery: "live",
    });
    vi.spyOn(sourcesApi, "list").mockResolvedValue(catalogPage([]));
    vi.spyOn(librariesApi, "list").mockResolvedValue(catalogPage([]));
    vi.spyOn(agentsApi, "list").mockResolvedValue(catalogPage([]));
  });

  it("links the conversation footer to Settings with truthful model availability", async () => {
    render(<ChatView />);

    expect(await screen.findByRole("link", { name: "1 chat model available" })).toHaveAttribute("href", "#/settings");
  });

  it("reports unavailable model discovery without showing implementation details", async () => {
    vi.mocked(modelsApi.list).mockResolvedValue({
      models: [],
      default_model: "qwen-chat",
      account_default_model: null,
      discovery: "unavailable",
    });

    render(<ChatView />);

    expect(await screen.findByRole("link", { name: "Model catalog unavailable" })).toBeInTheDocument();
    expect(screen.queryByText(/model endpoint|LM Studio|OpenAI-compatible/i)).not.toBeInTheDocument();
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

  it("shows model and source selectors at the empty chat root without creating a chat", async () => {
    render(<ChatView />);

    expect(await screen.findByRole("button", { name: "Chat model: qwen-chat" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Chat sources: No sources" })).toBeEnabled();
    expect(screen.getAllByText("No sources")).toHaveLength(1);
    // The fail-closed empty scope is now explained before the first turn.
    expect(screen.getByRole("group", { name: "Active chat sources" })).toHaveTextContent("No sources attached");
    expect(chatsApi.create).not.toHaveBeenCalled();
  });

  it("loads every paginated composer catalog beyond its first page without dropping earlier items", async () => {
    const user = userEvent.setup();
    const secondAgent = { ...agentA, id: "agent-b", name: "Researcher" };
    const secondLibrary = { ...libraryA, id: "library-b", name: "Research library" };
    const secondSource = {
      ...source,
      id: "source-2",
      name: "research-notes.pdf",
      display_name: "Research notes.pdf",
    };
    vi.mocked(chatsApi.list).mockImplementation(async (options = {}) =>
      options.cursor === "chats-next" ? catalogPage([chatB]) : catalogPage([chat], "chats-next"),
    );
    vi.mocked(agentsApi.list).mockImplementation(async (options = {}) =>
      options.cursor === "agents-next" ? catalogPage([secondAgent]) : catalogPage([agentA], "agents-next"),
    );
    vi.mocked(librariesApi.list).mockImplementation(async (options = {}) =>
      options.cursor === "libraries-next" ? catalogPage([secondLibrary]) : catalogPage([libraryA], "libraries-next"),
    );
    vi.mocked(sourcesApi.list).mockImplementation(async (options = {}) =>
      options.cursor === "sources-next" ? catalogPage([secondSource]) : catalogPage([source], "sources-next"),
    );

    render(<ChatView />);

    await user.click(await screen.findByRole("button", { name: "Load older conversations" }));
    expect(await screen.findByRole("button", { name: "Open Beta" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Alpha" })).toBeVisible();

    await user.click(await screen.findByRole("button", { name: "Agent: None" }));
    expect(await screen.findByRole("menuitemradio", { name: /Analyst/ })).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Load more agents" }));
    expect(await screen.findByRole("menuitemradio", { name: /Researcher/ })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: /Analyst/ })).toBeVisible();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Load more sources" }));
    expect(await screen.findByRole("button", { name: "Select source: Research notes.pdf" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Select source: Quarterly revenue.pdf" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Load more libraries" }));
    expect(await screen.findByText("Research library")).toBeVisible();
    expect(screen.getByText("Finance library")).toBeVisible();

    expect(chatsApi.list).toHaveBeenCalledWith({ cursor: "chats-next" });
    expect(agentsApi.list).toHaveBeenCalledWith({ cursor: "agents-next" });
    expect(sourcesApi.list).toHaveBeenCalledWith({ cursor: "sources-next" });
    expect(librariesApi.list).toHaveBeenCalledWith({ cursor: "libraries-next" });
  });

  it("makes a fresh chat continuation reachable after the previous traversal completed", async () => {
    const user = userEvent.setup();
    const created = { ...chat, id: "chat-created", title: "Created" };
    const inserted = { ...chat, id: "chat-inserted", title: "Inserted" };
    let headRequests = 0;
    vi.mocked(chatsApi.list).mockImplementation(async (options = {}) => {
      if (options.cursor === "old-chats-page-2") return catalogPage([chatB]);
      if (options.cursor === "fresh-chats-page-2") return catalogPage([inserted, chatB]);
      headRequests += 1;
      return headRequests === 1
        ? catalogPage([chat], "old-chats-page-2")
        : catalogPage([created, chat], "fresh-chats-page-2");
    });
    vi.mocked(chatsApi.create).mockResolvedValue(created);
    vi.mocked(chatsApi.get).mockImplementation(async (id) => detail({ ...created, id }));
    render(<ChatView />);

    await user.click(await screen.findByRole("button", { name: "Load older conversations" }));
    expect(await screen.findByRole("button", { name: "Open Beta" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(headRequests).toBe(2));
    await user.click(await screen.findByRole("button", { name: "Load older conversations" }));

    expect(await screen.findByRole("button", { name: "Open Inserted" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Created" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Alpha" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Open Beta" })).toHaveLength(1);
    expect(chatsApi.list).toHaveBeenCalledWith({ cursor: "fresh-chats-page-2" });
  });

  it("does not narrow an attached selected scope when the source is outside the loaded catalog page", async () => {
    const partialCatalog = deferred<CatalogPage<Source>>();
    const olderAttached = {
      ...attachedSource,
      id: "older-source",
      name: "older-source.pdf",
      display_name: "Older attached source.pdf",
    };
    vi.mocked(chatsApi.get).mockResolvedValue(
      detail({
        source_mode: "selected",
        sources: [olderAttached],
      }),
    );
    vi.mocked(sourcesApi.list).mockReturnValue(partialCatalog.promise);

    render(<ChatView chatId={chat.id} />);
    expect(await screen.findByText("Older attached source.pdf")).toBeVisible();

    await act(async () => partialCatalog.resolve(catalogPage([source], "sources-next")));
    await waitFor(() => expect(sourcesApi.list).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Older attached source.pdf")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove Older attached source.pdf from this chat" })).toBeEnabled();
  });

  it("starts the new-chat selector at the account default and leaves existing chats unchanged", async () => {
    const user = userEvent.setup();
    vi.mocked(modelsApi.list).mockResolvedValue({
      models: [{ id: "qwen-chat" }, { id: "analysis-chat" }],
      default_model: "qwen-chat",
      account_default_model: "analysis-chat",
      discovery: "live",
    });

    render(<ChatView />);

    expect(await screen.findByRole("button", { name: "Chat model: analysis-chat" })).toBeEnabled();

    await user.click(await screen.findByRole("button", { name: "Open Alpha" }));
    expect(await screen.findByRole("button", { name: "Chat model: qwen-chat" })).toBeEnabled();
  });

  it("resolves a new chat's model from the account default when the composer selection is untouched", async () => {
    const user = userEvent.setup();
    const created = { ...chat, id: "chat-new", title: "New chat" };
    const streamResponse = deferred<void>();
    vi.mocked(modelsApi.list).mockResolvedValue({
      models: [{ id: "qwen-chat" }, { id: "analysis-chat" }],
      default_model: "qwen-chat",
      account_default_model: "analysis-chat",
      discovery: "live",
    });
    vi.mocked(chatsApi.create).mockResolvedValue(created);
    vi.mocked(chatsApi.get).mockResolvedValue(detail(created));
    vi.spyOn(apiModule, "streamAgentChat").mockReturnValue(streamResponse.promise);

    render(<ChatView />);
    expect(await screen.findByRole("button", { name: "Chat model: analysis-chat" })).toBeEnabled();

    const composer = screen.getByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "use the account default");
    await user.click(screen.getByTitle("Send"));

    await waitFor(() => expect(apiModule.streamAgentChat).toHaveBeenCalledTimes(1));
    expect(chatsApi.create).toHaveBeenCalledTimes(1);
    expect(chatsApi.updateModel).toHaveBeenCalledOnce();
    expect(chatsApi.updateModel).toHaveBeenCalledWith(created.id, "analysis-chat");

    await act(async () => streamResponse.resolve());
  });

  it("creates once with the selected root scope, saves the selected model, and streams once to that chat", async () => {
    const user = userEvent.setup();
    const created = { ...chat, id: "chat-new", title: "New chat" };
    const selectedModel = "analysis-chat";
    const streamResponse = deferred<void>();
    vi.mocked(modelsApi.list).mockResolvedValue({
      models: [{ id: chat.model }, { id: selectedModel }],
      default_model: chat.model,
      account_default_model: null,
      discovery: "live",
    });
    vi.mocked(sourcesApi.list).mockResolvedValue(catalogPage([source]));
    vi.mocked(chatsApi.create).mockResolvedValue(created);
    vi.mocked(chatsApi.updateModel).mockResolvedValue({ ...created, model: selectedModel });
    vi.mocked(chatsApi.get).mockResolvedValue(detail({ ...created, sources: [attachedSource] }));
    vi.spyOn(apiModule, "streamAgentChat").mockReturnValue(streamResponse.promise);

    render(<ChatView />);
    await user.click(await screen.findByRole("button", { name: `Select model: ${selectedModel}` }));
    const sourceChoice = await screen.findByRole("button", { name: `Select source: ${source.display_name}` });
    await waitFor(() => expect(sourceChoice).toBeEnabled());
    await user.click(sourceChoice);

    expect(screen.getByRole("button", { name: `Chat model: ${selectedModel}` })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Chat sources: 1 source" })).toBeEnabled();

    const composer = screen.getByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "analyze the selected source");
    await user.click(screen.getByTitle("Send"));

    await waitFor(() => expect(apiModule.streamAgentChat).toHaveBeenCalledTimes(1));
    expect(chatsApi.create).toHaveBeenCalledTimes(1);
    expect(chatsApi.create).toHaveBeenCalledWith(
      undefined,
      {
        source_mode: "selected",
        source_ids: [source.id],
      },
      undefined,
      undefined,
      selectedModel,
    );
    expect(chatsApi.updateModel).toHaveBeenCalledOnce();
    expect(chatsApi.updateModel).toHaveBeenCalledWith(created.id, selectedModel);
    expect(apiModule.streamAgentChat).toHaveBeenCalledWith(
      created.id,
      "analyze the selected source",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(vi.mocked(chatsApi.updateModel).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(apiModule.streamAgentChat).mock.invocationCallOrder[0],
    );

    await act(async () => streamResponse.resolve());
  });

  it("preserves the root draft and shows a safe inline error when the selected model cannot be saved", async () => {
    const user = userEvent.setup();
    const created = { ...chat, id: "chat-new", title: "New chat" };
    const selectedModel = "analysis-chat";
    const modelUpdate = deferred<Chat>();
    vi.mocked(modelsApi.list).mockResolvedValue({
      models: [{ id: chat.model }, { id: selectedModel }],
      default_model: chat.model,
      account_default_model: null,
      discovery: "live",
    });
    vi.mocked(chatsApi.create).mockResolvedValue(created);
    vi.mocked(chatsApi.get).mockResolvedValue(detail(created));
    vi.mocked(chatsApi.updateModel).mockReturnValue(modelUpdate.promise);
    vi.spyOn(apiModule, "streamAgentChat");

    render(<ChatView />);
    await user.click(await screen.findByRole("button", { name: `Select model: ${selectedModel}` }));
    const composer = screen.getByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "keep this model-specific draft");
    await user.click(screen.getByTitle("Send"));
    await waitFor(() => expect(chatsApi.updateModel).toHaveBeenCalledWith(created.id, selectedModel));

    await act(async () => modelUpdate.reject(new Error("provider URL and credentials must not reach the UI")));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not apply the selected chat model");
    expect(screen.getByRole("alert")).not.toHaveTextContent("provider URL and credentials");
    expect(composer).toHaveValue("keep this model-specific draft");
    expect(chatsApi.create).toHaveBeenCalledTimes(1);
    expect(apiModule.streamAgentChat).not.toHaveBeenCalled();
  });

  it("keeps a manually opened chat when the root model update resolves later", async () => {
    const user = userEvent.setup();
    const created = { ...chat, id: "chat-new", title: "New chat" };
    const selectedModel = "analysis-chat";
    const modelUpdate = deferred<Chat>();
    vi.mocked(modelsApi.list).mockResolvedValue({
      models: [{ id: chat.model }, { id: selectedModel }],
      default_model: chat.model,
      account_default_model: null,
      discovery: "live",
    });
    vi.mocked(chatsApi.create).mockResolvedValue(created);
    vi.mocked(chatsApi.updateModel).mockReturnValue(modelUpdate.promise);
    vi.mocked(chatsApi.get).mockImplementation(async (id) =>
      id === created.id
        ? detail({ ...created, messages: [message("created-detail", "Created chat detail")] })
        : detail({ ...chat, messages: [message("alpha-detail", "Authoritative Alpha detail")] }),
    );
    vi.spyOn(apiModule, "streamAgentChat");

    render(<ChatView />);
    await user.click(await screen.findByRole("button", { name: `Select model: ${selectedModel}` }));
    const composer = screen.getByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "do not send after I navigate");
    await user.click(screen.getByTitle("Send"));
    await waitFor(() => expect(chatsApi.updateModel).toHaveBeenCalledWith(created.id, selectedModel));

    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(await screen.findByText("Authoritative Alpha detail")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/chat/chat-a");

    await act(async () => modelUpdate.resolve({ ...created, model: selectedModel }));
    await waitFor(() => expect(chatsApi.list).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText("Authoritative Alpha detail")).toBeInTheDocument();
    expect(screen.queryByText("Created chat detail")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#/chat/chat-a");
    expect(chatsApi.get).toHaveBeenCalledTimes(2);
    expect(apiModule.streamAgentChat).not.toHaveBeenCalled();
  });

  it("creates a selected-empty chat on root Enter, sends once, and skips the route replay detail reload", async () => {
    const user = userEvent.setup();
    const created = { ...chat, id: "chat-new", title: "New chat" };
    const streamResponse = deferred<void>();
    let emit!: (event: unknown) => void;
    vi.mocked(chatsApi.create).mockResolvedValue(created);
    vi.mocked(chatsApi.get).mockResolvedValue(detail(created));
    vi.spyOn(apiModule, "streamAgentChat").mockImplementation(
      async (_chatId, _content, onEvent) =>
        new Promise<void>((resolve, reject) => {
          emit = onEvent;
          streamResponse.promise.then(resolve, reject);
        }),
    );

    const { rerender } = render(<ChatView />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    expect(composer).toBeEnabled();
    expect(screen.getByText("qwen-chat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat sources: No sources" })).toBeInTheDocument();

    await user.type(composer, "start from the root{enter}");

    await waitFor(() =>
      expect(apiModule.streamAgentChat).toHaveBeenCalledWith(
        "chat-new",
        "start from the root",
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
    expect(chatsApi.create).toHaveBeenCalledTimes(1);
    expect(chatsApi.create).toHaveBeenCalledWith(
      undefined,
      { source_mode: "selected", source_ids: [] },
      undefined,
      undefined,
      "qwen-chat",
    );
    expect(chatsApi.updateModel).not.toHaveBeenCalled();
    expect(chatsApi.get).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/chat/chat-new");

    rerender(<ChatView chatId="chat-new" />);
    await act(async () => undefined);
    expect(chatsApi.get).toHaveBeenCalledTimes(1);

    act(() => {
      emit({ type: "run-started", run_id: "run-new" });
      emit({ type: "run-ended", run_id: "run-new", status: "completed" });
    });
    await act(async () => streamResponse.resolve());
    await waitFor(() => expect(chatsApi.get).toHaveBeenCalledTimes(2));
  });

  it("single-flights a double Send click while creating the first chat", async () => {
    const user = userEvent.setup();
    const createResponse = deferred<Chat>();
    const created = { ...chat, id: "chat-new", title: "New chat" };
    vi.mocked(chatsApi.create).mockReturnValue(createResponse.promise);
    vi.mocked(chatsApi.get).mockResolvedValue(detail(created));
    vi.spyOn(apiModule, "streamAgentChat").mockImplementation(async (_chatId, _content, onEvent) => {
      onEvent({ type: "run-started", run_id: "run-new" });
      onEvent({ type: "run-ended", run_id: "run-new", status: "completed" });
    });

    render(<ChatView />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "one first turn");
    const sendButton = screen.getByTitle("Send");
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    expect(chatsApi.create).toHaveBeenCalledTimes(1);
    await act(async () => createResponse.resolve(created));
    await waitFor(() => expect(apiModule.streamAgentChat).toHaveBeenCalledTimes(1));
    expect(apiModule.streamAgentChat).toHaveBeenCalledWith(
      "chat-new",
      "one first turn",
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it("creates and submits directly from a root suggestion", async () => {
    const user = userEvent.setup();
    const created = { ...chat, id: "chat-new", title: "New chat" };
    vi.mocked(chatsApi.create).mockResolvedValue(created);
    vi.mocked(chatsApi.get).mockResolvedValue(detail(created));
    vi.spyOn(apiModule, "streamAgentChat").mockImplementation(async (_chatId, _content, onEvent) => {
      onEvent({ type: "run-started", run_id: "run-new" });
      onEvent({ type: "run-ended", run_id: "run-new", status: "completed" });
    });

    render(<ChatView />);
    const suggestion = "Summarize the documents I uploaded";
    await user.click(await screen.findByRole("button", { name: suggestion }));

    await waitFor(() =>
      expect(apiModule.streamAgentChat).toHaveBeenCalledWith(
        "chat-new",
        suggestion,
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
    expect(chatsApi.create).toHaveBeenCalledTimes(1);
  });

  it("keeps the first draft and shows only a safe inline error when creation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(chatsApi.create).mockRejectedValue(new ApiError(503, "Chat service is temporarily unavailable"));
    vi.spyOn(apiModule, "streamAgentChat");

    render(<ChatView />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "keep this draft");
    await user.click(screen.getByTitle("Send"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Chat service is temporarily unavailable");
    expect(composer).toHaveValue("keep this draft");
    expect(window.location.hash).toBe("#/chat");
    expect(apiModule.streamAgentChat).not.toHaveBeenCalled();
  });

  it("does not redirect or send when navigation changes while the new detail is loading", async () => {
    const user = userEvent.setup();
    const created = { ...chat, id: "chat-new", title: "New chat" };
    const createdDetail = deferred<ChatDetail>();
    vi.mocked(chatsApi.create).mockResolvedValue(created);
    vi.mocked(chatsApi.get).mockImplementation(async (id) => {
      if (id === created.id) return createdDetail.promise;
      return detail();
    });
    vi.spyOn(apiModule, "streamAgentChat");

    render(<ChatView />);
    const composer = await screen.findByPlaceholderText("Ask Borealis about your data…");
    await user.type(composer, "do not send after navigation");
    await user.click(screen.getByTitle("Send"));
    await waitFor(() => expect(chatsApi.get).toHaveBeenCalledWith("chat-new", { limit: 50 }));

    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/chat/chat-a");

    await act(async () => createdDetail.resolve(detail(created)));
    await waitFor(() => expect(chatsApi.list).toHaveBeenCalledTimes(2));
    expect(apiModule.streamAgentChat).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/chat/chat-a");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
    vi.mocked(chatsApi.list).mockResolvedValue(catalogPage([chat, chatB]));
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
    vi.mocked(chatsApi.list).mockResolvedValue(catalogPage([chat, chatB]));
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
    vi.mocked(chatsApi.list).mockResolvedValue(catalogPage([chat, chatB]));
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
