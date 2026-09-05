import { useCallback, useEffect, useReducer, useRef, useState, type UIEvent } from "react";
import { Cpu, Loader2, Plus, Send, Square, Sparkles, X } from "lucide-react";
import {
  ApiError,
  chatsApi,
  formatApiError,
  librariesApi,
  parseCitationRefs,
  parseQueryResultArtifacts,
  sourcesApi,
  streamAgentChat,
  type AttachedSource,
  type Chat,
  type ChatDetail,
  type ChatRunTerminalStatus,
  type LibrarySummary,
  type Message,
  type Source,
  type SourceMode,
  type SourceScopeInput,
} from "@/lib/api";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage } from "@/components/ChatMessage";
import { ModelSelector } from "@/components/ModelSelector";
import { AgentSelector } from "@/components/AgentSelector";
import { ChatSourcePicker } from "@/components/ChatSourcePicker";
import { ChatHistory } from "@/components/ChatHistory";
import { ToolActivity } from "@/components/ToolActivity";
import { createStreamState, EMPTY_STREAM_STATE, streamsByChatReducer, type StreamState } from "@/lib/chatStream";
import { useSourceCatalog } from "@/hooks/useSourceCatalog";
import { useChatSessionController } from "@/hooks/useChatSessionController";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { agentsApi, type AgentSummary } from "@/lib/api";
import { useEgressConsentGate } from "@/hooks/useEgressConsentGate";
import { cancelRunThenAbort } from "@/lib/chatRun";
import { prependOlderMessages } from "@/lib/chatHistoryPage";
import { sameAttachedSources } from "@/lib/sourceScope";

const SUGGESTIONS = [
  "Analyze my spending and produce a financial report with charts",
  "What are my biggest monthly expenses? Show a chart",
  "Summarize the documents I uploaded",
  "Build me a professional financial report with recommendations",
];

export function ChatView({ chatId, newChatRequest }: { chatId?: string; newChatRequest?: string }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [draft, setDraft] = useState(() => {
    const m = window.location.hash.match(/[?&]q=([^&]*)/);
    if (!m) return "";
    // A hand-edited link can carry a malformed % escape; that must not
    // crash the whole view, so fall back to the raw text.
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  });
  const [streamsByChat, dispatchStream] = useReducer(streamsByChatReducer, {});
  const [modelSavingByChat, setModelSavingByChat] = useState<Record<string, boolean>>({});
  const [modelErrorsByChat, setModelErrorsByChat] = useState<Record<string, string>>({});
  const [titleSavingByChat, setTitleSavingByChat] = useState<Record<string, boolean>>({});
  const [sourceSavingByChat, setSourceSavingByChat] = useState<Record<string, boolean>>({});
  const [sourceErrorsByChat, setSourceErrorsByChat] = useState<Record<string, string>>({});
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | null>(null);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [agentCatalogError, setAgentCatalogError] = useState<string | null>(null);
  const [newChatModelSelection, setNewChatModelSelection] = useState<string | null>(null);
  const [newChatAgentSelection, setNewChatAgentSelection] = useState<string | null>(null);
  const [chatsNextCursor, setChatsNextCursor] = useState<string | null>(null);
  const [chatsLoadingMore, setChatsLoadingMore] = useState(false);
  const [chatsLoadMoreError, setChatsLoadMoreError] = useState<string | null>(null);
  const [agentCatalog, setAgentCatalog] = useState<AgentSummary[]>([]);
  const [agentCatalogLoading, setAgentCatalogLoading] = useState(false);
  const [agentCatalogNextCursor, setAgentCatalogNextCursor] = useState<string | null>(null);
  const [agentCatalogLoadingMore, setAgentCatalogLoadingMore] = useState(false);
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [librariesLoading, setLibrariesLoading] = useState(false);
  const [librariesNextCursor, setLibrariesNextCursor] = useState<string | null>(null);
  const [librariesLoadingMore, setLibrariesLoadingMore] = useState(false);
  const [librariesError, setLibrariesError] = useState<string | null>(null);
  const [newChatSourceScope, setNewChatSourceScope] = useState<SourceScopeInput>({
    source_mode: "selected",
    source_ids: [],
  });
  const abortByChatRef = useRef(new Map<string, AbortController>());
  const runRevisionByChatRef = useRef(new Map<string, number>());
  const rehydratedRunByChatRef = useRef(new Map<string, string>());
  const rehydratedCancellingByChatRef = useRef(new Map<string, string>());
  const stopRequestedByChatRef = useRef(new Set<string>());
  const cancellationAcceptedByChatRef = useRef(new Map<string, string>());
  const cancellationByRunRef = useRef(new Map<string, Promise<void>>());
  const bottomRef = useRef<HTMLDivElement>(null);
  // Auto-scroll stays pinned to the newest message unless the user scrolls up
  // to re-read; the scroll handler keeps this flag current.
  const stickToBottomRef = useRef(true);
  const stepKeyRef = useRef(0);
  const chatListRequestRef = useRef(0);
  const chatsNextCursorRef = useRef<string | null>(null);
  const chatsLoadingMoreRef = useRef(false);
  const agentCatalogRequestRef = useRef(0);
  const agentCatalogNextCursorRef = useRef<string | null>(null);
  const agentCatalogLoadingMoreRef = useRef(false);
  const librariesRequestRef = useRef(0);
  const librariesNextCursorRef = useRef<string | null>(null);
  const librariesLoadingMoreRef = useRef(false);
  const newChatRequestRef = useRef<string | null>(null);
  const appliedDetailChatIdRef = useRef<string | null>(null);
  const firstSubmitInFlightRef = useRef(false);
  const firstSubmitTargetChatIdRef = useRef<string | null>(null);
  const firstSubmitSetupCompleteRef = useRef(false);
  const preserveScrollRef = useRef(false);
  const {
    creatingChat,
    selectChat,
    beginDetailRequest,
    ownsDetailRequest,
    clearSelection,
    currentChatId,
    isMounted,
    createChat,
  } = useChatSessionController();
  const { handleConsentError, dialog: consentDialog } = useEgressConsentGate();

  const releaseFirstSubmit = useCallback(() => {
    firstSubmitInFlightRef.current = false;
    firstSubmitTargetChatIdRef.current = null;
    firstSubmitSetupCompleteRef.current = false;
  }, []);

  const stream = detail?.id ? (streamsByChat[detail.id] ?? EMPTY_STREAM_STATE) : EMPTY_STREAM_STATE;
  const {
    catalog: modelCatalog,
    loading: modelCatalogLoading,
    error: modelCatalogError,
    refresh: refreshModels,
  } = useModelCatalog();

  const loadChats = useCallback(async () => {
    const requestId = ++chatListRequestRef.current;
    chatsLoadingMoreRef.current = false;
    setChatsLoadingMore(false);
    setChatsLoadMoreError(null);
    setChatsLoading(true);
    try {
      const page = await chatsApi.list();
      if (!isMounted() || requestId !== chatListRequestRef.current) return;
      setChats((current) => sortChatsByActivity(mergeCatalogHead(page.items, current)));
      chatsNextCursorRef.current = page.next_cursor;
      setChatsNextCursor(page.next_cursor);
      setChatsError(null);
    } catch (error: unknown) {
      if (!isMounted() || requestId !== chatListRequestRef.current) return;
      // A failed first load must not masquerade as an empty history.
      setChatsError(formatApiError(error, "Could not load conversations"));
    } finally {
      if (isMounted() && requestId === chatListRequestRef.current) setChatsLoading(false);
    }
  }, [isMounted]);

  const loadMoreChats = useCallback(async () => {
    const cursor = chatsNextCursorRef.current;
    if (!cursor || chatsLoadingMoreRef.current) return;
    const requestId = ++chatListRequestRef.current;
    chatsLoadingMoreRef.current = true;
    setChatsLoadingMore(true);
    setChatsLoadMoreError(null);
    try {
      const page = await chatsApi.list({ cursor });
      if (!isMounted() || requestId !== chatListRequestRef.current) return;
      chatsNextCursorRef.current = page.next_cursor;
      setChatsNextCursor(page.next_cursor);
      setChats((current) => sortChatsByActivity(mergeCatalogContinuation(current, page.items)));
    } catch (error: unknown) {
      // Keep the cursor available so the user can retry the same page, but
      // never swallow the failure silently.
      if (isMounted() && requestId === chatListRequestRef.current) {
        setChatsLoadMoreError(formatApiError(error, "Could not load older conversations"));
      }
    } finally {
      if (isMounted() && requestId === chatListRequestRef.current) {
        chatsLoadingMoreRef.current = false;
        setChatsLoadingMore(false);
      }
    }
  }, [isMounted]);

  const loadAgents = useCallback(async () => {
    const requestId = ++agentCatalogRequestRef.current;
    agentCatalogLoadingMoreRef.current = false;
    setAgentCatalogLoadingMore(false);
    setAgentCatalogLoading(true);
    try {
      const page = await agentsApi.list();
      if (!isMounted() || requestId !== agentCatalogRequestRef.current) return;
      setAgentCatalog((current) => mergeCatalogHead(page.items, current));
      agentCatalogNextCursorRef.current = page.next_cursor;
      setAgentCatalogNextCursor(page.next_cursor);
      setAgentCatalogError(null);
    } catch (error: unknown) {
      // Agent selection is optional; keep any previously loaded choices but
      // surface the failure so the picker can offer a retry.
      if (isMounted() && requestId === agentCatalogRequestRef.current) {
        setAgentCatalogError(formatApiError(error, "Could not load agents"));
      }
    } finally {
      if (isMounted() && requestId === agentCatalogRequestRef.current) setAgentCatalogLoading(false);
    }
  }, [isMounted]);

  const loadMoreAgents = useCallback(async () => {
    const cursor = agentCatalogNextCursorRef.current;
    if (!cursor || agentCatalogLoadingMoreRef.current) return;
    const requestId = ++agentCatalogRequestRef.current;
    agentCatalogLoadingMoreRef.current = true;
    setAgentCatalogLoadingMore(true);
    try {
      const page = await agentsApi.list({ cursor });
      if (!isMounted() || requestId !== agentCatalogRequestRef.current) return;
      agentCatalogNextCursorRef.current = page.next_cursor;
      setAgentCatalogNextCursor(page.next_cursor);
      setAgentCatalog((current) => mergeCatalogContinuation(current, page.items));
    } catch (error: unknown) {
      // Keep the cursor available so the user can retry the same page, but
      // surface the failure through the picker's retryable error slot.
      if (isMounted() && requestId === agentCatalogRequestRef.current) {
        setAgentCatalogError(formatApiError(error, "Could not load more agents"));
      }
    } finally {
      if (isMounted() && requestId === agentCatalogRequestRef.current) {
        agentCatalogLoadingMoreRef.current = false;
        setAgentCatalogLoadingMore(false);
      }
    }
  }, [isMounted]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Library catalog for the composer's scope picker. A failed load keeps the
  // previous catalog (if any) and surfaces a retryable error to the picker.
  const loadLibraries = useCallback(async () => {
    const requestId = ++librariesRequestRef.current;
    librariesLoadingMoreRef.current = false;
    setLibrariesLoadingMore(false);
    setLibrariesLoading(true);
    try {
      const page = await librariesApi.list();
      if (!isMounted() || requestId !== librariesRequestRef.current) return;
      setLibraries((current) => mergeCatalogHead(page.items, current));
      librariesNextCursorRef.current = page.next_cursor;
      setLibrariesNextCursor(page.next_cursor);
      setLibrariesError(null);
    } catch (error: unknown) {
      if (!isMounted() || requestId !== librariesRequestRef.current) return;
      setLibrariesError(formatApiError(error, "Could not load libraries"));
    } finally {
      if (isMounted() && requestId === librariesRequestRef.current) setLibrariesLoading(false);
    }
  }, [isMounted]);

  const loadMoreLibraries = useCallback(async () => {
    const cursor = librariesNextCursorRef.current;
    if (!cursor || librariesLoadingMoreRef.current) return;
    const requestId = ++librariesRequestRef.current;
    librariesLoadingMoreRef.current = true;
    setLibrariesLoadingMore(true);
    try {
      const page = await librariesApi.list({ cursor });
      if (!isMounted() || requestId !== librariesRequestRef.current) return;
      librariesNextCursorRef.current = page.next_cursor;
      setLibrariesNextCursor(page.next_cursor);
      setLibraries((current) => mergeCatalogContinuation(current, page.items));
      setLibrariesError(null);
    } catch (error: unknown) {
      if (!isMounted() || requestId !== librariesRequestRef.current) return;
      setLibrariesError(formatApiError(error, "Could not load more libraries"));
    } finally {
      if (isMounted() && requestId === librariesRequestRef.current) {
        librariesLoadingMoreRef.current = false;
        setLibrariesLoadingMore(false);
      }
    }
  }, [isMounted]);

  const reconcileCatalog = useCallback((catalog: Source[]) => {
    setDetail((current) => {
      if (!current) return current;
      const reconciled = reconcilePaginatedAttachedSources(current.source_mode, current.sources, catalog);
      return sameAttachedSources(current.sources, reconciled) ? current : { ...current, sources: reconciled };
    });
  }, []);
  const {
    sources,
    loading: sourcesLoading,
    loadingMore: sourcesLoadingMore,
    hasMore: sourcesHasMore,
    error: sourcesError,
    refresh: refreshSources,
    loadMore: loadMoreSources,
    addPending: addPendingSource,
  } = useSourceCatalog({ onCatalog: reconcileCatalog });

  const applyChatDetail = useCallback((next: ChatDetail) => {
    appliedDetailChatIdRef.current = next.id;
    setDetail(next);
    setOlderMessagesLoading(false);
    const activeRun = next.active_run;
    const rehydratedRunId = rehydratedRunByChatRef.current.get(next.id);

    if (activeRun && !abortByChatRef.current.has(next.id)) {
      rehydratedRunByChatRef.current.set(next.id, activeRun.id);
      if (activeRun.status === "cancelling") rehydratedCancellingByChatRef.current.set(next.id, activeRun.id);
      dispatchStream({
        type: "rehydrate",
        chatId: next.id,
        runId: activeRun.id,
        status: activeRun.status,
        model: next.model,
      });
      return;
    }

    if (!activeRun && rehydratedRunId) {
      rehydratedRunByChatRef.current.delete(next.id);
      const wasCancelled =
        cancellationAcceptedByChatRef.current.get(next.id) === rehydratedRunId ||
        rehydratedCancellingByChatRef.current.get(next.id) === rehydratedRunId;
      rehydratedCancellingByChatRef.current.delete(next.id);
      cancellationAcceptedByChatRef.current.delete(next.id);
      stopRequestedByChatRef.current.delete(next.id);
      if (wasCancelled) {
        dispatchStream({
          type: "patch",
          chatId: next.id,
          patch: {
            running: false,
            stopping: false,
            runId: rehydratedRunId,
            terminalStatus: "cancelled",
            error: null,
          },
        });
      } else {
        dispatchStream({ type: "clear", chatId: next.id });
      }
      return;
    }

    if (!activeRun && !abortByChatRef.current.has(next.id)) {
      dispatchStream({ type: "reconcile-no-active-run", chatId: next.id });
    }
  }, []);

  const loadChat = useCallback(
    async (id: string): Promise<ChatDetail | null> => {
      const request = selectChat(id);
      try {
        const next = await chatsApi.get(id, { limit: 50 });
        if (!ownsDetailRequest(request)) return null;
        dispatchStream({ type: "select-chat", chatId: id });
        applyChatDetail(next);
        setOlderMessagesLoading(false);
        setOlderMessagesError(null);
        setDetailError(null);
        window.location.hash = `/chat/${id}`;
        return next;
      } catch (error: unknown) {
        if (ownsDetailRequest(request)) {
          appliedDetailChatIdRef.current = null;
          setDetail(null);
          setDetailError(formatApiError(error, "Could not open this chat"));
        }
        return null;
      }
    },
    [applyChatDetail, ownsDetailRequest, selectChat],
  );

  // Route selection is also an ownership boundary. Returning to the chat root
  // invalidates deferred detail/creation navigation without choosing a chat.
  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    stickToBottomRef.current = true;
    if (chatId) {
      // `loadChat` updates the hash after applying an owned detail. The route
      // render that follows must not issue a duplicate request for that same
      // already-owned detail.
      if (currentChatId() !== chatId || appliedDetailChatIdRef.current !== chatId) {
        void loadChat(chatId);
      }
    } else if (!newChatRequest) {
      clearSelection();
      releaseFirstSubmit();
      appliedDetailChatIdRef.current = null;
      setDetail(null);
      setOlderMessagesLoading(false);
      setOlderMessagesError(null);
      setDetailError(null);
    }
  }, [chatId, clearSelection, currentChatId, loadChat, newChatRequest, releaseFirstSubmit]);

  // Keep the explicit first-submit guard until React has rendered the newly
  // owned detail and the controller has completed synchronous run setup. This
  // closes the small gap between the create callback resolving and the detail
  // state becoming visible to a second submit event.
  useEffect(() => {
    if (!creatingChat && firstSubmitSetupCompleteRef.current && detail?.id === firstSubmitTargetChatIdRef.current) {
      releaseFirstSubmit();
    }
  }, [creatingChat, detail?.id, releaseFirstSubmit]);

  useEffect(() => {
    void refreshSources(true);
  }, [refreshSources]);

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  useEffect(() => {
    const activeRun = detail?.active_run;
    if (!detail || !activeRun || rehydratedRunByChatRef.current.get(detail.id) !== activeRun.id) return;

    let disposed = false;
    let timer: number | undefined;
    let failedAttempts = 0;
    const poll = () => {
      const delay = Math.min(750 * 2 ** failedAttempts, 5000);
      timer = window.setTimeout(async () => {
        const request = beginDetailRequest(detail.id);
        try {
          const next = await chatsApi.get(detail.id, { limit: 50 });
          if (!disposed && ownsDetailRequest(request)) applyChatDetail(next);
        } catch {
          failedAttempts += 1;
          if (!disposed && currentChatId() === detail.id) poll();
        }
      }, delay);
    };
    poll();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyChatDetail, beginDetailRequest, currentChatId, detail, ownsDetailRequest]);

  // scroll to bottom on updates, unless the user scrolled up to re-read
  useEffect(() => {
    if (preserveScrollRef.current) {
      preserveScrollRef.current = false;
      return;
    }
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [detail, stream]);

  const handleMessagesScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const openNewChat = useCallback(async () => {
    setNewChatError(null);
    try {
      await createChat(chatsApi.create, async (created) => {
        chatListRequestRef.current += 1;
        setChats((current) => [created, ...current.filter((chat) => chat.id !== created.id)]);
        await loadChat(created.id);
      });
      // If a newer navigation took ownership, keep the created chat discoverable
      // without allowing its delayed response to yank the current route.
      await loadChats();
    } catch (error: unknown) {
      if (isMounted()) setNewChatError(formatApiError(error, "Could not create a new chat"));
    }
  }, [createChat, isMounted, loadChat, loadChats]);

  useEffect(() => {
    if (!newChatRequest) {
      newChatRequestRef.current = null;
      return;
    }
    if (newChatRequestRef.current === newChatRequest) return;
    newChatRequestRef.current = newChatRequest;
    void openNewChat();
  }, [newChatRequest, openNewChat]);

  const deleteChat = async (id: string) => {
    if (
      sourceSavingByChat[id] ||
      modelSavingByChat[id] ||
      titleSavingByChat[id] ||
      streamsByChat[id]?.running ||
      abortByChatRef.current.has(id)
    ) {
      // Surfaced by the delete confirmation dialog instead of failing silently.
      throw new Error("Wait for this chat to finish its current activity.");
    }
    await chatsApi.remove(id);
    if (!isMounted()) return;
    chatListRequestRef.current += 1;
    setChats((prev) => prev.filter((c) => c.id !== id));
    dispatchStream({ type: "clear", chatId: id });
    setSourceErrorsByChat((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    runRevisionByChatRef.current.delete(id);
    // The selection may have changed while DELETE was in flight. Resolve
    // ownership at response time so a delayed deletion cannot clear a newer
    // chat, while still clearing a chat opened after its deletion began.
    if (currentChatId() === id) {
      clearSelection(id);
      appliedDetailChatIdRef.current = null;
      setDetail((current) => (current?.id === id ? null : current));
      if (currentChatId() === null) window.location.hash = "/chat";
    }
  };

  const renameChat = async (id: string, title: string) => {
    if (
      sourceSavingByChat[id] ||
      modelSavingByChat[id] ||
      titleSavingByChat[id] ||
      streamsByChat[id]?.running ||
      abortByChatRef.current.has(id)
    ) {
      throw new Error("Wait for this chat to finish its current activity.");
    }

    setTitleSavingByChat((current) => ({ ...current, [id]: true }));
    try {
      const updated = await chatsApi.updateTitle(id, title);
      chatListRequestRef.current += 1;
      setChats((current) =>
        sortChatsByActivity(current.map((chat) => (chat.id === id ? { ...chat, ...updated } : chat))),
      );
      setDetail((current) =>
        current?.id === id ? { ...current, title: updated.title, updated_at: updated.updated_at } : current,
      );
      // Reconcile any concurrent background turn activity after the local
      // rename response, while retaining the immediate optimistic ordering if
      // the authoritative refresh is temporarily unavailable.
      await loadChats();
    } finally {
      setTitleSavingByChat((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const loadOlderMessages = async () => {
    if (!detail?.messages_page?.has_more || !detail.messages_page.next_before_message_id || olderMessagesLoading)
      return;
    const chatId = detail.id;
    const beforeMessageId = detail.messages_page.next_before_message_id;
    const request = beginDetailRequest(chatId);
    setOlderMessagesLoading(true);
    setOlderMessagesError(null);
    try {
      const older = await chatsApi.get(chatId, { beforeMessageId, limit: 50 });
      if (!ownsDetailRequest(request)) return;
      setDetail((current) => {
        if (
          !ownsDetailRequest(request) ||
          current?.id !== chatId ||
          current.messages_page?.next_before_message_id !== beforeMessageId
        ) {
          return current;
        }
        preserveScrollRef.current = true;
        return {
          ...current,
          messages: prependOlderMessages(current.messages, older.messages),
          messages_page: older.messages_page,
        };
      });
    } catch (error: unknown) {
      if (ownsDetailRequest(request)) {
        setOlderMessagesError(formatApiError(error, "Could not load older messages"));
      }
    } finally {
      if (ownsDetailRequest(request)) setOlderMessagesLoading(false);
    }
  };

  const selectModel = async (nextModel: string) => {
    if (!detail) return;
    const targetChatId = detail.id;
    if (
      nextModel === detail.model ||
      modelSavingByChat[targetChatId] ||
      sourceSavingByChat[targetChatId] ||
      titleSavingByChat[targetChatId] ||
      streamsByChat[targetChatId]?.running ||
      abortByChatRef.current.has(targetChatId)
    ) {
      return;
    }

    setModelErrorsByChat((current) => {
      if (!(targetChatId in current)) return current;
      const next = { ...current };
      delete next[targetChatId];
      return next;
    });
    setModelSavingByChat((current) => ({ ...current, [targetChatId]: true }));

    try {
      const updated = await chatsApi.updateModel(targetChatId, nextModel);
      setDetail((current) => (current?.id === targetChatId ? { ...current, model: updated.model } : current));
      setChats((current) => current.map((chat) => (chat.id === targetChatId ? { ...chat, ...updated } : chat)));
    } catch (error: unknown) {
      setModelErrorsByChat((current) => ({
        ...current,
        [targetChatId]: formatApiError(error, "Could not save the selected model"),
      }));
    } finally {
      setModelSavingByChat((current) => {
        const next = { ...current };
        delete next[targetChatId];
        return next;
      });
    }
  };

  const dismissModelError = (id: string) => {
    setModelErrorsByChat((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const saveSourceScope = async (scope: SourceScopeInput) => {
    if (!detail) throw new Error("Open a chat before choosing sources");
    const targetChatId = detail.id;
    if (
      sourceSavingByChat[targetChatId] ||
      modelSavingByChat[targetChatId] ||
      titleSavingByChat[targetChatId] ||
      streamsByChat[targetChatId]?.running ||
      abortByChatRef.current.has(targetChatId)
    ) {
      throw new Error("Wait for the current chat activity to finish");
    }

    setSourceErrorsByChat((current) => {
      if (!(targetChatId in current)) return current;
      const next = { ...current };
      delete next[targetChatId];
      return next;
    });
    setSourceSavingByChat((current) => ({ ...current, [targetChatId]: true }));

    try {
      const updated = await chatsApi.updateSources(targetChatId, scope);
      setDetail((current) =>
        current?.id === targetChatId
          ? { ...current, source_mode: updated.source_mode, sources: updated.sources }
          : current,
      );
      setChats((current) =>
        current.map((chat) => (chat.id === targetChatId ? { ...chat, source_mode: updated.source_mode } : chat)),
      );
    } finally {
      setSourceSavingByChat((current) => {
        const next = { ...current };
        delete next[targetChatId];
        return next;
      });
    }
  };

  const removeAttachedSource = (sourceId: string) => {
    if (!detail || detail.source_mode !== "selected") return;
    const targetChatId = detail.id;
    const remainingIds = detail.sources.filter((source) => source.id !== sourceId).map((source) => source.id);
    void saveSourceScope({ source_mode: "selected", source_ids: remainingIds }).catch((error: unknown) => {
      setSourceErrorsByChat((current) => ({
        ...current,
        [targetChatId]: formatApiError(error, "Could not remove the source"),
      }));
    });
  };

  const dismissSourceError = (id: string) => {
    setSourceErrorsByChat((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const uploadSource = async (file: File): Promise<Source> => {
    const uploaded = await sourcesApi.upload(file);
    addPendingSource(uploaded);
    return uploaded;
  };

  const selectNewChatModel = (model: string) => {
    setNewChatError(null);
    setNewChatModelSelection(model);
  };

  const saveNewChatSourceScope = async (scope: SourceScopeInput) => {
    setNewChatError(null);
    setNewChatSourceScope(
      scope.source_mode === "all"
        ? { source_mode: "all" }
        : { source_mode: "selected", source_ids: [...scope.source_ids] },
    );
  };

  const removeNewChatSource = (sourceId: string) => {
    setNewChatError(null);
    setNewChatSourceScope((current) =>
      current.source_mode === "selected"
        ? { source_mode: "selected", source_ids: current.source_ids.filter((id) => id !== sourceId) }
        : current,
    );
  };

  const dismissStreamError = () => {
    if (!detail) return;
    dispatchStream({ type: "patch", chatId: detail.id, patch: { error: null } });
  };

  const cancelKnownRun = useCallback(
    (chatId: string, runId: string, controller: AbortController | null): Promise<void> => {
      const key = `${chatId}:${runId}`;
      const existing = cancellationByRunRef.current.get(key);
      if (existing) return existing;

      const cancellation = (async () => {
        try {
          const status = await cancelRunThenAbort({
            chatId,
            runId,
            controller,
            cancel: chatsApi.cancelRun,
            isCurrent: () =>
              controller
                ? abortByChatRef.current.get(chatId) === controller
                : currentChatId() === chatId && rehydratedRunByChatRef.current.get(chatId) === runId,
            onCancelled: () => cancellationAcceptedByChatRef.current.set(chatId, runId),
          });
          stopRequestedByChatRef.current.delete(chatId);
          if (status === "completed" || status === "failed") {
            dispatchStream({ type: "patch", chatId, patch: { stopping: false } });
          }
        } catch (error: unknown) {
          stopRequestedByChatRef.current.delete(chatId);
          if (error instanceof ApiError && error.status === 404) {
            // The run already reached a terminal state, so there is nothing to
            // cancel; the authoritative detail refresh reconciles the UI.
            const isCurrent = controller
              ? abortByChatRef.current.get(chatId) === controller
              : currentChatId() === chatId && rehydratedRunByChatRef.current.get(chatId) === runId;
            if (isCurrent) {
              dispatchStream({ type: "patch", chatId, patch: { stopping: false, error: null } });
            }
            return;
          }
          const isCurrent = controller
            ? abortByChatRef.current.get(chatId) === controller
            : currentChatId() === chatId && rehydratedRunByChatRef.current.get(chatId) === runId;
          if (isCurrent) {
            dispatchStream({
              type: "patch",
              chatId,
              patch: { stopping: false, error: formatApiError(error, "Could not stop this run") },
            });
          }
          throw error;
        } finally {
          cancellationByRunRef.current.delete(key);
        }
      })();
      cancellationByRunRef.current.set(key, cancellation);
      return cancellation;
    },
    [currentChatId],
  );

  useEffect(() => {
    const activeRun = detail?.active_run;
    if (!detail || !activeRun || !stopRequestedByChatRef.current.has(detail.id)) return;
    const controller = abortByChatRef.current.get(detail.id) ?? null;
    dispatchStream({ type: "patch", chatId: detail.id, patch: { runId: activeRun.id, stopping: true } });
    void cancelKnownRun(detail.id, activeRun.id, controller).catch(() => undefined);
  }, [cancelKnownRun, detail]);

  const sendToChat = (runDetail: ChatDetail, content: string) => {
    const runChatId = runDetail.id;
    if (
      modelSavingByChat[runChatId] ||
      sourceSavingByChat[runChatId] ||
      titleSavingByChat[runChatId] ||
      streamsByChat[runChatId]?.running ||
      abortByChatRef.current.has(runChatId)
    ) {
      return;
    }
    stopRequestedByChatRef.current.delete(runChatId);
    cancellationAcceptedByChatRef.current.delete(runChatId);
    setDraft("");

    // clear the welcome query param
    const base = `/chat/${runChatId}`;
    history.replaceState(null, "", `#${base}`);

    // optimistic local user message
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };

    const st: StreamState = { ...createStreamState(runDetail.model), running: true };
    const runRevision = (runRevisionByChatRef.current.get(runChatId) ?? 0) + 1;
    runRevisionByChatRef.current.set(runChatId, runRevision);
    const abort = new AbortController();
    abortByChatRef.current.set(runChatId, abort);
    dispatchStream({ type: "replace", chatId: runChatId, state: st });
    // temporarily hold the optimistic user message until stream refreshes from server
    setDetail((current) =>
      current?.id === runChatId ? { ...current, messages: [...current.messages, optimistic] } : current,
    );

    const ownsRun = () => runRevisionByChatRef.current.get(runChatId) === runRevision;
    const isActiveRun = () => ownsRun() && abortByChatRef.current.get(runChatId) === abort;
    let pendingText = "";
    let cancelScheduled: (() => void) | null = null;
    let runError: string | null = null;
    let requestRejected = false;
    let currentRunId: string | null = null;
    let terminalStatus: ChatRunTerminalStatus | null = null;

    const flush = () => {
      cancelScheduled = null;
      const textChunk = pendingText;
      pendingText = "";
      if (!textChunk || !isActiveRun()) return;
      dispatchStream({ type: "append", chatId: runChatId, text: textChunk });
    };

    const scheduleFlush = () => {
      if (cancelScheduled) return;
      if (typeof requestAnimationFrame === "function") {
        const id = requestAnimationFrame(flush);
        cancelScheduled = () => cancelAnimationFrame(id);
      } else {
        const id = window.setTimeout(flush, 50);
        cancelScheduled = () => window.clearTimeout(id);
      }
    };

    const cancelPendingFlush = () => {
      const cancel = cancelScheduled;
      cancelScheduled = null;
      if (cancel) cancel();
    };

    const emit = (event: unknown) => {
      if (!isActiveRun()) return;
      const ev = event && typeof event === "object" ? (event as Record<string, unknown>) : null;
      if (ev?.type === "delta" && typeof ev.text === "string") {
        pendingText += ev.text;
        scheduleFlush();
        return;
      }
      if (ev?.type === "error") {
        runError = typeof ev.message === "string" ? ev.message.slice(0, 500) : "Generation failed";
      }
      if (ev?.type === "run-started") {
        const runId = typeof ev.run_id === "string" ? ev.run_id : typeof ev.id === "string" ? ev.id : null;
        if (runId) currentRunId = runId;
      }
      if (
        ev?.type === "run-ended" &&
        (ev.status === "cancelled" || ev.status === "completed" || ev.status === "failed")
      ) {
        terminalStatus = ev.status;
        if (terminalStatus === "cancelled") runError = null;
        if (terminalStatus === "failed" && !runError) runError = "Generation failed";
      }
      dispatchStream({ type: "event", chatId: runChatId, event, stepKey: ++stepKeyRef.current });
      if (currentRunId && stopRequestedByChatRef.current.has(runChatId)) {
        void cancelKnownRun(runChatId, currentRunId, abort).catch(() => undefined);
      }
    };
    void (async () => {
      try {
        await streamAgentChat(runChatId, content, emit, abort.signal);
      } catch (error: unknown) {
        if (!(error instanceof Error && error.name === "AbortError") && isActiveRun()) {
          requestRejected = error instanceof ApiError;
          if (!handleConsentError(error, () => sendToChat(runDetail, content))) {
            runError = formatApiError(error, "The generation stream failed");
            dispatchStream({ type: "patch", chatId: runChatId, patch: { error: runError } });
          }
        }
      } finally {
        cancelPendingFlush();
        flush();

        const cancellationAccepted =
          terminalStatus === "cancelled" || Boolean(cancellationAcceptedByChatRef.current.get(runChatId));
        // A `cancelling` response acknowledges the request but is not terminal.
        // Keep mutation gates closed and retry detail just as we do for an
        // ambiguous dropped connection until durable state proves the run ended.
        const needsAuthoritativeRecovery = terminalStatus === null && !requestRejected;
        if (needsAuthoritativeRecovery && !cancellationAccepted) {
          runError = "The generation connection was interrupted. Checking the server run status…";
        }
        if (isActiveRun()) {
          dispatchStream({
            type: "patch",
            chatId: runChatId,
            patch: {
              // A dropped SSE connection is not a terminal run state. Keep all
              // mutation gates closed until the durable detail endpoint confirms
              // whether the accepted run is still active.
              running: needsAuthoritativeRecovery,
              stopping:
                needsAuthoritativeRecovery && (cancellationAccepted || stopRequestedByChatRef.current.has(runChatId)),
              terminalStatus,
              error: cancellationAccepted ? null : runError,
            },
          });
          abortByChatRef.current.delete(runChatId);
        }

        let appliedAuthoritativeDetail = false;
        let authoritativeHasActiveRun = false;
        if (ownsRun() && currentChatId() === runChatId) {
          let failedAttempts = 0;
          while (ownsRun() && isMounted() && currentChatId() === runChatId) {
            const detailRequest = beginDetailRequest(runChatId);
            try {
              const authoritative = await chatsApi.get(runChatId, { limit: 50 });
              if (!ownsRun() || !ownsDetailRequest(detailRequest)) break;
              authoritativeHasActiveRun = Boolean(authoritative.active_run);
              applyChatDetail(authoritative);
              appliedAuthoritativeDetail = true;
              if (needsAuthoritativeRecovery && !authoritativeHasActiveRun) {
                runError = null;
                if (cancellationAccepted) {
                  dispatchStream({
                    type: "replace",
                    chatId: runChatId,
                    state: {
                      ...createStreamState(runDetail.model),
                      runId: currentRunId,
                      terminalStatus: "cancelled",
                    },
                  });
                } else {
                  // The durable detail is now the complete source of truth. Drop
                  // partial SSE text/artifacts as well as the synthetic transport
                  // warning so a response committed just before disconnect is not
                  // rendered twice beside its persisted assistant message.
                  dispatchStream({ type: "clear", chatId: runChatId });
                }
              }
              break;
            } catch {
              if (!needsAuthoritativeRecovery) break;
              failedAttempts += 1;
              const delay = Math.min(500 * 2 ** (failedAttempts - 1), 5000);
              await new Promise((resolve) => window.setTimeout(resolve, delay));
            }
          }
        }

        await loadChats();

        if (ownsRun()) {
          if (requestRejected && currentChatId() === runChatId && isMounted()) {
            setDraft((current) => current || content);
          }
          const canDiscardStoppedState = currentChatId() !== runChatId || appliedAuthoritativeDetail;
          if (!runError && !cancellationAccepted && !authoritativeHasActiveRun && canDiscardStoppedState) {
            dispatchStream({ type: "clear", chatId: runChatId });
          }
          if (!authoritativeHasActiveRun) {
            cancellationAcceptedByChatRef.current.delete(runChatId);
            stopRequestedByChatRef.current.delete(runChatId);
          }
          runRevisionByChatRef.current.delete(runChatId);
        }
      }
    })();
  };

  const send = async (text?: string) => {
    const content = (text ?? draft).trim();
    if (!content) return;
    setNewChatError(null);

    if (detail) {
      sendToChat(detail, content);
      return;
    }

    if (firstSubmitInFlightRef.current) return;
    firstSubmitInFlightRef.current = true;
    firstSubmitTargetChatIdRef.current = null;
    firstSubmitSetupCompleteRef.current = false;
    const selectedModel =
      (modelCatalog?.models.some((option) => option.id === newChatModelSelection) ? newChatModelSelection : null) ??
      modelCatalog?.account_default_model ??
      modelCatalog?.default_model ??
      null;
    const selectedAgentId = newChatAgentSelection;
    const selectedSourceScope: SourceScopeInput =
      newChatSourceScope.source_mode === "all"
        ? { source_mode: "all" }
        : { source_mode: "selected", source_ids: [...newChatSourceScope.source_ids] };
    let createdChatId: string | null = null;

    try {
      await createChat(
        () =>
          selectedModel
            ? chatsApi.create(undefined, selectedSourceScope, selectedAgentId ?? undefined, undefined, selectedModel)
            : chatsApi.create(undefined, selectedSourceScope, selectedAgentId ?? undefined),
        async (created) => {
          createdChatId = created.id;
          chatListRequestRef.current += 1;
          setChats((current) => [created, ...current.filter((chat) => chat.id !== created.id)]);
          firstSubmitTargetChatIdRef.current = created.id;
          let createdDetail = await loadChat(created.id);

          // Selection/navigation owns the first turn just as it owns the detail.
          // If the user moved elsewhere while creation or detail loading was in
          // flight, leave the created chat in history but do not redirect or send.
          if (!createdDetail) {
            if (currentChatId() === created.id && isMounted()) {
              setNewChatError("The chat was created, but could not be opened. Try selecting it from the chat list.");
            }
            return;
          }
          if (currentChatId() !== created.id) return;

          // Source scope is part of the atomic create request. The model remains
          // a per-chat PATCH, so hold the first turn until the displayed root
          // selection is durably applied and verify ownership again afterward.
          if (selectedModel && selectedModel !== createdDetail.model) {
            const updated = await chatsApi.updateModel(created.id, selectedModel);
            if (!isMounted() || currentChatId() !== created.id) return;
            createdDetail = { ...createdDetail, model: updated.model, updated_at: updated.updated_at };
            setDetail((current) =>
              current?.id === created.id
                ? { ...current, model: updated.model, updated_at: updated.updated_at }
                : current,
            );
            setChats((current) => current.map((chat) => (chat.id === created.id ? { ...chat, ...updated } : chat)));
          }
          if (!isMounted() || currentChatId() !== created.id) return;

          sendToChat(createdDetail, content);
          setNewChatModelSelection(null);
          setNewChatAgentSelection(null);
          setNewChatSourceScope({ source_mode: "selected", source_ids: [] });
          firstSubmitSetupCompleteRef.current = true;
        },
      );
      await loadChats();
    } catch (error: unknown) {
      if (!isMounted()) return;
      setDraft((current) => current || content);
      if (!createdChatId || currentChatId() === createdChatId) {
        setNewChatError(
          formatApiError(
            error,
            createdChatId ? "Could not apply the selected chat model" : "Could not create a new chat",
          ),
        );
      }
      await loadChats();
    } finally {
      if (!firstSubmitSetupCompleteRef.current || currentChatId() !== firstSubmitTargetChatIdRef.current) {
        releaseFirstSubmit();
      }
    }
  };

  const stop = async () => {
    if (!detail) return;
    const chatId = detail.id;
    const controller = abortByChatRef.current.get(chatId) ?? null;
    const runId = streamsByChat[chatId]?.runId ?? detail.active_run?.id ?? null;
    stopRequestedByChatRef.current.add(chatId);
    dispatchStream({ type: "patch", chatId, patch: { stopping: true, error: null } });

    // A freshly accepted POST can be stopped before the first run id arrives.
    // The stream stays connected; `emit` completes the cancellation as soon as
    // it receives the authoritative `run-started` event.
    if (!runId) return;
    await cancelKnownRun(chatId, runId, controller).catch(() => undefined);
  };

  const messages = detail?.messages || [];
  const hasStreamMessage = Boolean(
    stream.text ||
      stream.finalCharts.length ||
      stream.finalReport ||
      stream.finalEvidence.length ||
      stream.finalQueryResults.length,
  );
  const hasStreamActivity = hasStreamMessage || stream.steps.length > 0 || stream.terminalStatus === "cancelled";
  const isEmpty = messages.length === 0 && !stream.running && !hasStreamActivity;
  const isModelSaving = detail ? Boolean(modelSavingByChat[detail.id]) : false;
  const isSourceSaving = detail ? Boolean(sourceSavingByChat[detail.id]) : false;
  const isTitleSaving = detail ? Boolean(titleSavingByChat[detail.id]) : false;
  const modelDiscovery = modelCatalog?.discovery ?? (modelCatalogError ? "unavailable" : null);
  const modelOptions = modelCatalog?.models ?? [];
  const newChatModel =
    (modelCatalog?.models.some((option) => option.id === newChatModelSelection) ? newChatModelSelection : null) ??
    modelCatalog?.account_default_model ??
    modelCatalog?.default_model ??
    "Server default model";
  const newChatAttachedSources =
    newChatSourceScope.source_mode === "selected"
      ? newChatSourceScope.source_ids.flatMap((id) => {
          const source = sources.find((candidate) => candidate.id === id);
          return source ? [source] : [];
        })
      : [];
  const modelStatus = modelCatalogLoading
    ? "Checking available models…"
    : !modelCatalog || modelCatalog.discovery === "unavailable"
      ? "Model catalog unavailable"
      : modelOptions.length === 0
        ? "No chat models advertised"
        : `${modelOptions.length} chat ${modelOptions.length === 1 ? "model" : "models"} available`;
  const answerCount = messages.filter((message) => message.role === "assistant").length;
  // Offered as the retry target for a failed generation; only meaningful for
  // the loaded page, which is also where the error banner lives.
  const lastUserContent = [...messages].reverse().find((message) => message.role === "user")?.content ?? null;

  return (
    <div className="flex h-full">
      {consentDialog}
      {/* conversations column */}
      <div className="flex w-[260px] shrink-0 flex-col border-r bg-sidebar/70">
        <div className="px-3 pb-2 pt-4">
          <Button className="w-full" onClick={openNewChat} disabled={creatingChat}>
            {creatingChat ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} New chat
          </Button>
        </div>
        <ChatHistory
          chats={chats}
          activeChatId={detail?.id}
          hasMore={chatsNextCursor !== null}
          loadingMore={chatsLoadingMore}
          loading={chatsLoading}
          error={chatsError}
          loadMoreError={chatsLoadMoreError}
          onRetry={() => void loadChats()}
          busyChatIds={
            new Set(
              chats
                .filter((chat) =>
                  Boolean(
                    streamsByChat[chat.id]?.running ||
                      sourceSavingByChat[chat.id] ||
                      modelSavingByChat[chat.id] ||
                      titleSavingByChat[chat.id] ||
                      abortByChatRef.current.has(chat.id),
                  ),
                )
                .map((chat) => chat.id),
            )
          }
          onOpen={(id) => void loadChat(id)}
          onDelete={deleteChat}
          onRename={renameChat}
          onLoadMore={loadMoreChats}
        />
        <a
          href="#/settings"
          className="mx-3 mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Cpu className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span>{modelStatus}</span>
        </a>
      </div>

      {/* chat area */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="min-w-0 truncate text-[15px] font-semibold">{detail?.title || "Chat with Borealis"}</h2>
          <div className="text-xs text-muted-foreground">
            {/* Older pages may hold more answers; only claim a total when the loaded page is complete. */}
            {detail?.messages_page?.has_more ? null : `${answerCount} ${answerCount === 1 ? "answer" : "answers"}`}
          </div>
        </header>

        {/* messages */}
        <div
          className="flex-1 overflow-y-auto"
          onScroll={handleMessagesScroll}
          tabIndex={0}
          aria-label="Message history"
        >
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
            {detailError && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                <span className="min-w-0 flex-1">{detailError}</span>
                {chatId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void loadChat(chatId)}
                  >
                    Retry
                  </Button>
                )}
              </div>
            )}
            {detail?.messages_page?.has_more && (
              <div className="flex flex-col items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={olderMessagesLoading || stream.running}
                  onClick={() => void loadOlderMessages()}
                >
                  {olderMessagesLoading && <Loader2 className="animate-spin" />}
                  {olderMessagesLoading ? "Loading older messages…" : "Load older messages"}
                </Button>
                {olderMessagesError && (
                  <span className="text-xs text-destructive" role="alert">
                    {olderMessagesError}
                  </span>
                )}
              </div>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <ChatMessage key={m.id} role="user" content={m.content} />
              ) : (
                <ChatMessage
                  key={m.id}
                  role="assistant"
                  content={m.content}
                  charts={m.meta?.charts || undefined}
                  report={m.meta?.report || undefined}
                  model={m.meta?.model}
                  evidence={m.meta?.evidence}
                  citations={parseCitationRefs(m.meta?.citations)}
                  queryResults={parseQueryResultArtifacts(m.meta?.query_results)}
                />
              ),
            )}

            {(stream.running || hasStreamActivity) && (
              <div className="contents" role="log" aria-live="polite" aria-label="Answer in progress">
                {hasStreamMessage ? (
                  <ChatMessage
                    role="assistant"
                    content={stream.text}
                    streaming={stream.running}
                    charts={stream.finalCharts}
                    report={stream.finalReport}
                    model={stream.model || detail?.model}
                    evidence={stream.finalEvidence}
                    citations={stream.finalCitations}
                    queryResults={stream.finalQueryResults}
                  />
                ) : stream.running && stream.steps.length === 0 ? (
                  <div className="flex justify-start">
                    <div className="flex min-w-[80px] items-center gap-3 rounded-2xl rounded-tl-md border bg-surface-subtle px-4 py-3">
                      <span className="inline-flex gap-1.5">
                        {[0, 1, 2].map((i) => (
                          <span
                            key={i}
                            className="h-2 w-2 animate-status-pulse rounded-full bg-primary"
                            style={{ animationDelay: `${i * 0.2}s` }}
                          />
                        ))}
                      </span>
                      <span className="text-xs text-muted-foreground">thinking…</span>
                    </div>
                  </div>
                ) : null}
                {stream.steps.length > 0 && (
                  <ToolActivity steps={stream.steps} running={stream.running} className="max-w-2xl" />
                )}
              </div>
            )}
            {stream.error && (
              <div
                className="flex flex-wrap items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                <span className="min-w-0 flex-1">{stream.error}</span>
                {!stream.running && lastUserContent && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void send(lastUserContent)}
                  >
                    Resend last message
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={dismissStreamError}
                  aria-label="Dismiss generation error"
                >
                  <X />
                </Button>
              </div>
            )}
            {!stream.running && stream.terminalStatus === "cancelled" && (
              <div className="rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground" role="status">
                Generation cancelled.
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* composer */}
        <div className="border-t bg-background px-6 pb-5 pt-3">
          <div className="mx-auto max-w-4xl">
            {isEmpty && !detailError && (
              <div className="mb-6 grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    disabled={creatingChat || isModelSaving || isSourceSaving || isTitleSaving}
                    className="group rounded-lg border bg-card p-3 text-left text-[13px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      {s}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="rounded-xl border bg-card shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
              <div className="rounded-xl p-2">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Let an IME composition confirm its candidate instead of
                    // submitting the half-composed message.
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Ask Borealis about your data…"
                  aria-label="Ask Borealis about your data"
                  rows={1}
                  disabled={creatingChat}
                  className="max-h-40 min-h-[44px] w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[15px] shadow-none focus-visible:ring-0"
                  style={{ height: "auto" }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 160) + "px";
                  }}
                />
                <div className="flex items-end justify-between gap-2 pt-1">
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {detail ? (
                      <>
                        <div className="flex flex-wrap items-start gap-2">
                          <ModelSelector
                            model={detail.model}
                            models={modelOptions}
                            discovery={modelDiscovery}
                            loading={modelCatalogLoading}
                            pending={creatingChat || isModelSaving || isSourceSaving || isTitleSaving}
                            streaming={stream.running}
                            error={modelErrorsByChat[detail.id] || null}
                            onChange={(model) => void selectModel(model)}
                            onRetry={() => void refreshModels(true)}
                            onDismissError={() => dismissModelError(detail.id)}
                          />
                          <AgentSelector
                            bound={detail.agent}
                            agents={agentCatalog}
                            selection={detail.agent?.id ?? null}
                            loading={false}
                            hasMore={false}
                            loadingMore={false}
                            locked
                            onSelect={() => undefined}
                            onLoadMore={() => undefined}
                          />
                          <ChatSourcePicker
                            key={detail.id}
                            sourceMode={detail.source_mode}
                            attachedSources={detail.sources}
                            sources={sources}
                            sourcesLoading={sourcesLoading}
                            sourcesHasMore={sourcesHasMore}
                            sourcesLoadingMore={sourcesLoadingMore}
                            sourcesError={sourcesError}
                            disabled={
                              creatingChat || isModelSaving || isSourceSaving || isTitleSaving || stream.running
                            }
                            saving={isSourceSaving}
                            hasMessages={messages.length > 0}
                            onApply={saveSourceScope}
                            onUpload={uploadSource}
                            onConsentError={handleConsentError}
                            onRetrySources={() => refreshSources(true)}
                            onLoadMoreSources={loadMoreSources}
                            libraries={libraries}
                            librariesLoading={librariesLoading}
                            librariesHasMore={librariesNextCursor !== null}
                            librariesLoadingMore={librariesLoadingMore}
                            librariesError={librariesError}
                            onRetryLibraries={() => void loadLibraries()}
                            onLoadMoreLibraries={loadMoreLibraries}
                          />
                        </div>
                        <ActiveSourceScope
                          sources={detail.sources}
                          disabled={creatingChat || isModelSaving || isSourceSaving || isTitleSaving || stream.running}
                          error={sourceErrorsByChat[detail.id] || null}
                          onRemove={removeAttachedSource}
                          onDismissError={() => dismissSourceError(detail.id)}
                        />
                      </>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-start gap-2">
                          <ModelSelector
                            model={newChatModel}
                            models={modelOptions}
                            discovery={modelDiscovery}
                            loading={modelCatalogLoading}
                            pending={creatingChat}
                            streaming={false}
                            error={null}
                            onChange={selectNewChatModel}
                            onRetry={() => void refreshModels(true)}
                            onDismissError={() => undefined}
                          />
                          <AgentSelector
                            bound={null}
                            agents={agentCatalog}
                            selection={newChatAgentSelection}
                            loading={agentCatalogLoading}
                            error={agentCatalogError}
                            onRetry={() => void loadAgents()}
                            hasMore={agentCatalogNextCursor !== null}
                            loadingMore={agentCatalogLoadingMore}
                            locked={false}
                            onSelect={setNewChatAgentSelection}
                            onLoadMore={loadMoreAgents}
                          />
                          <ChatSourcePicker
                            key="new-chat"
                            sourceMode={newChatSourceScope.source_mode}
                            attachedSources={newChatAttachedSources}
                            sources={sources}
                            sourcesLoading={sourcesLoading}
                            sourcesHasMore={sourcesHasMore}
                            sourcesLoadingMore={sourcesLoadingMore}
                            sourcesError={sourcesError}
                            disabled={creatingChat}
                            saving={creatingChat}
                            hasMessages={false}
                            onApply={saveNewChatSourceScope}
                            onUpload={uploadSource}
                            onConsentError={handleConsentError}
                            onRetrySources={() => refreshSources(true)}
                            onLoadMoreSources={loadMoreSources}
                            libraries={libraries}
                            librariesLoading={librariesLoading}
                            librariesHasMore={librariesNextCursor !== null}
                            librariesLoadingMore={librariesLoadingMore}
                            librariesError={librariesError}
                            onRetryLibraries={() => void loadLibraries()}
                            onLoadMoreLibraries={loadMoreLibraries}
                          />
                        </div>
                        <ActiveSourceScope
                          sources={newChatAttachedSources}
                          disabled={creatingChat}
                          error={null}
                          showEmptyHint
                          onRemove={removeNewChatSource}
                          onDismissError={() => undefined}
                        />
                      </>
                    )}
                  </div>
                  {stream.running ? (
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-11 shrink-0 rounded-lg"
                      onClick={() => void stop()}
                      disabled={stream.stopping}
                      title={stream.stopping ? "Stopping…" : "Stop generating"}
                      aria-label={stream.stopping ? "Stopping…" : "Stop generating"}
                    >
                      <Square className="fill-current" />
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      size="icon"
                      className="size-11 shrink-0 rounded-lg"
                      disabled={creatingChat || !draft.trim() || isModelSaving || isSourceSaving || isTitleSaving}
                      onClick={() => void send()}
                      title={creatingChat ? "Creating chat…" : "Send"}
                      aria-label={creatingChat ? "Creating chat…" : "Send message"}
                    >
                      {creatingChat ? <Loader2 className="animate-spin" /> : <Send />}
                    </Button>
                  )}
                </div>
              </div>
            </div>
            {newChatError && (
              <p className="mt-2 text-sm text-destructive" role="alert">
                {newChatError}
              </p>
            )}
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              Borealis can make mistakes — verify important results against your source data.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ActiveSourceScopeProps {
  sources: AttachedSource[];
  disabled: boolean;
  error: string | null;
  /** Explain an empty selection before the first turn (fail-closed scope default). */
  showEmptyHint?: boolean;
  onRemove: (sourceId: string) => void;
  onDismissError: () => void;
}

function ActiveSourceScope({
  sources,
  disabled,
  error,
  showEmptyHint = false,
  onRemove,
  onDismissError,
}: ActiveSourceScopeProps) {
  if (sources.length === 0 && !error) {
    if (!showEmptyHint) return null;
    return (
      <div className="flex flex-col gap-1.5 px-2" role="group" aria-label="Active chat sources">
        <p className="text-xs text-muted-foreground">
          No sources attached — answers will not use your uploaded data. Pick sources in the selector above.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 px-2" role="group" aria-label="Active chat sources">
      {sources.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Attached</span>
          {sources.map((source) => (
            <span
              key={source.id}
              className="inline-flex h-6 min-w-0 max-w-52 items-center rounded-md border bg-secondary pl-2 text-[11px] text-secondary-foreground"
            >
              <span className="min-w-0 flex-1 truncate" title={source.display_name}>
                {source.display_name}
              </span>
              {source.status !== "ready" && (
                <span className={cn("ml-1 shrink-0", source.status === "error" ? "text-destructive" : "text-warning")}>
                  · {source.status === "index" ? "processing" : source.status}
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-0.5 size-6 shrink-0 rounded-sm"
                disabled={disabled}
                onClick={() => onRemove(source.id)}
                aria-label={`Remove ${source.display_name} from this chat`}
              >
                <X />
              </Button>
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive" role="alert">
          <span className="min-w-0 flex-1">Source selection unchanged: {error}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={onDismissError}
            aria-label="Dismiss source selection error"
          >
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}

function reconcilePaginatedAttachedSources(
  mode: SourceMode,
  attached: AttachedSource[],
  catalog: Source[],
): AttachedSource[] {
  const catalogById = new Map(catalog.map((source) => [source.id, source]));
  const reconciled = attached.map((source) => {
    const current = catalogById.get(source.id);
    return current
      ? {
          id: current.id,
          name: current.name,
          display_name: current.display_name,
          kind: current.kind,
          status: current.status,
        }
      : source;
  });
  if (mode === "selected") return reconciled;

  const attachedIds = new Set(reconciled.map((source) => source.id));
  return [
    ...reconciled,
    ...catalog
      .filter((source) => !attachedIds.has(source.id))
      .map((source) => ({
        id: source.id,
        name: source.name,
        display_name: source.display_name,
        kind: source.kind,
        status: source.status,
      })),
  ];
}

function sortChatsByActivity(chats: Chat[]): Chat[] {
  return [...chats].sort((left, right) => {
    const leftTime = Date.parse(left.updated_at);
    const rightTime = Date.parse(right.updated_at);
    const safeLeftTime = Number.isFinite(leftTime) ? leftTime : Date.parse(left.created_at) || 0;
    const safeRightTime = Number.isFinite(rightTime) ? rightTime : Date.parse(right.created_at) || 0;
    if (safeLeftTime !== safeRightTime) return safeRightTime - safeLeftTime;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
}
