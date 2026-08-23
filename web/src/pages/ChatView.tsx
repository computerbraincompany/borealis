import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Loader2, Plus, Send, Square, Sparkles, X } from "lucide-react";
import {
  ApiError,
  chatsApi,
  formatApiError,
  modelsApi,
  parseQueryResultArtifacts,
  sourcesApi,
  streamAgentChat,
  type AttachedSource,
  type Chat,
  type ChatDetail,
  type ChatRunTerminalStatus,
  type Message,
  type ModelsResponse,
  type Source,
  type SourceMode,
  type SourceScopeInput,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage } from "@/components/ChatMessage";
import { ModelSelector } from "@/components/ModelSelector";
import { ChatSourcePicker } from "@/components/ChatSourcePicker";
import { ChatHistory } from "@/components/ChatHistory";
import { ToolActivity } from "@/components/ToolActivity";
import { createStreamState, EMPTY_STREAM_STATE, streamsByChatReducer, type StreamState } from "@/lib/chatStream";
import { useSourceCatalog } from "@/hooks/useSourceCatalog";
import { useChatSessionController } from "@/hooks/useChatSessionController";
import { cancelRunThenAbort } from "@/lib/chatRun";
import { prependOlderMessages } from "@/lib/chatHistoryPage";
import { reconcileAttachedSources, sameAttachedSources } from "@/lib/sourceScope";

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
    return m ? decodeURIComponent(m[1]) : "";
  });
  const [streamsByChat, dispatchStream] = useReducer(streamsByChatReducer, {});
  const [modelCatalog, setModelCatalog] = useState<ModelsResponse | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogFailed, setModelCatalogFailed] = useState(false);
  const [modelSavingByChat, setModelSavingByChat] = useState<Record<string, boolean>>({});
  const [modelErrorsByChat, setModelErrorsByChat] = useState<Record<string, string>>({});
  const [titleSavingByChat, setTitleSavingByChat] = useState<Record<string, boolean>>({});
  const [sourceSavingByChat, setSourceSavingByChat] = useState<Record<string, boolean>>({});
  const [sourceErrorsByChat, setSourceErrorsByChat] = useState<Record<string, string>>({});
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | null>(null);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const abortByChatRef = useRef(new Map<string, AbortController>());
  const runRevisionByChatRef = useRef(new Map<string, number>());
  const rehydratedRunByChatRef = useRef(new Map<string, string>());
  const rehydratedCancellingByChatRef = useRef(new Map<string, string>());
  const stopRequestedByChatRef = useRef(new Set<string>());
  const cancellationAcceptedByChatRef = useRef(new Map<string, string>());
  const cancellationByRunRef = useRef(new Map<string, Promise<void>>());
  const bottomRef = useRef<HTMLDivElement>(null);
  const stepKeyRef = useRef(0);
  const chatListRequestRef = useRef(0);
  const modelCatalogRequestRef = useRef(0);
  const newChatRequestRef = useRef<string | null>(null);
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

  const stream = detail?.id ? (streamsByChat[detail.id] ?? EMPTY_STREAM_STATE) : EMPTY_STREAM_STATE;

  const loadChats = useCallback(async () => {
    const requestId = ++chatListRequestRef.current;
    try {
      const latest = await chatsApi.list();
      if (isMounted() && requestId === chatListRequestRef.current) setChats(latest);
    } catch {}
  }, [isMounted]);

  const loadModels = useCallback(
    async (refresh = false) => {
      const requestId = ++modelCatalogRequestRef.current;
      setModelCatalogLoading(true);
      try {
        const latest = await modelsApi.list(refresh);
        if (!isMounted() || requestId !== modelCatalogRequestRef.current) return;
        setModelCatalog(latest);
        setModelCatalogFailed(false);
      } catch {
        if (!isMounted() || requestId !== modelCatalogRequestRef.current) return;
        setModelCatalog(null);
        setModelCatalogFailed(true);
      } finally {
        if (isMounted() && requestId === modelCatalogRequestRef.current) setModelCatalogLoading(false);
      }
    },
    [isMounted],
  );

  const reconcileCatalog = useCallback((catalog: Source[]) => {
    setDetail((current) => {
      if (!current) return current;
      const reconciled = reconcileAttachedSources(current.source_mode, current.sources, catalog);
      return sameAttachedSources(current.sources, reconciled) ? current : { ...current, sources: reconciled };
    });
  }, []);
  const {
    sources,
    loading: sourcesLoading,
    error: sourcesError,
    refresh: refreshSources,
    addPending: addPendingSource,
  } = useSourceCatalog({ onCatalog: reconcileCatalog });

  const applyChatDetail = useCallback((next: ChatDetail) => {
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
    async (id: string) => {
      const request = selectChat(id);
      try {
        const next = await chatsApi.get(id, { limit: 50 });
        if (!ownsDetailRequest(request)) return;
        dispatchStream({ type: "select-chat", chatId: id });
        applyChatDetail(next);
        setOlderMessagesLoading(false);
        setOlderMessagesError(null);
        window.location.hash = `/chat/${id}`;
      } catch (error: unknown) {
        if (ownsDetailRequest(request)) {
          console.error(formatApiError(error, "Could not open this chat"));
          setDetail(null);
        }
      }
    },
    [applyChatDetail, ownsDetailRequest, selectChat],
  );

  // Route selection is also an ownership boundary. Returning to the chat root
  // invalidates deferred detail/creation navigation without choosing a chat.
  useEffect(() => {
    loadChats();
    if (chatId) {
      void loadChat(chatId);
    } else if (!newChatRequest) {
      clearSelection();
      setDetail(null);
      setOlderMessagesLoading(false);
      setOlderMessagesError(null);
    }
  }, [chatId, clearSelection, loadChats, loadChat, newChatRequest]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    void refreshSources(true);
  }, [refreshSources]);

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

  // scroll to bottom on updates
  useEffect(() => {
    if (preserveScrollRef.current) {
      preserveScrollRef.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [detail, stream]);

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
    )
      return;
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

  const send = async (text?: string) => {
    const content = (text ?? draft).trim();
    if (!content || !detail) return;
    const runChatId = detail.id;
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

    const st: StreamState = { ...createStreamState(detail.model), running: true };
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
    try {
      await streamAgentChat(runChatId, content, emit, abort.signal);
    } catch (error: unknown) {
      if (!(error instanceof Error && error.name === "AbortError") && isActiveRun()) {
        requestRejected = error instanceof ApiError;
        runError = formatApiError(error, "The generation stream failed");
        dispatchStream({ type: "patch", chatId: runChatId, patch: { error: runError } });
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
                    ...createStreamState(detail.model),
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
  const modelDiscovery = modelCatalog?.discovery ?? (modelCatalogFailed ? "unavailable" : null);
  const modelOptions = modelCatalog?.models ?? [];

  return (
    <div className="flex h-full">
      {/* conversations column */}
      <div className="flex w-[260px] shrink-0 flex-col border-r bg-sidebar/70">
        <div className="px-3 pb-2 pt-4">
          <Button variant="aurora" className="w-full" onClick={openNewChat} disabled={creatingChat}>
            {creatingChat ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} New chat
          </Button>
          {newChatError && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {newChatError}
            </p>
          )}
        </div>
        <ChatHistory
          chats={chats}
          activeChatId={detail?.id}
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
        />
        <div className="px-5 pb-4 pt-2 text-[11px] leading-relaxed text-muted-foreground">
          <span className="text-aurora-teal">●</span> OpenAI-compatible stack · LiteLLM + LM Studio
        </div>
      </div>

      {/* chat area */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold">{detail?.title || "Chat with Borealis"}</h2>
            <span className="hidden items-center gap-1 rounded-md bg-aurora-violet/15 px-2 py-0.5 text-[11px] font-medium text-aurora-violet sm:inline-flex">
              <Sparkles className="h-3 w-3" /> agentic · grounded in your data
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {messages.filter((m) => m.role === "assistant").length} answers
          </div>
        </header>

        {/* messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
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
                  queryResults={parseQueryResultArtifacts(m.meta?.query_results)}
                />
              ),
            )}

            {(stream.running || hasStreamActivity) && (
              <>
                {hasStreamMessage ? (
                  <ChatMessage
                    role="assistant"
                    content={stream.text}
                    streaming={stream.running}
                    charts={stream.finalCharts}
                    report={stream.finalReport}
                    model={stream.model || detail?.model}
                    evidence={stream.finalEvidence}
                    queryResults={stream.finalQueryResults}
                  />
                ) : stream.running && stream.steps.length === 0 ? (
                  <div className="flex justify-start">
                    <div className="flex min-w-[80px] items-center gap-3 rounded-2xl rounded-tl-md border bg-surface-subtle px-4 py-3">
                      <span className="inline-flex gap-1.5">
                        {[0, 1, 2].map((i) => (
                          <span
                            key={i}
                            className="h-2 w-2 rounded-full bg-aurora-teal"
                            style={{ animation: `aurora-pulse 1.2s ${i * 0.2}s infinite` }}
                          />
                        ))}
                      </span>
                      <span className="text-xs text-muted-foreground">thinking…</span>
                    </div>
                  </div>
                ) : null}
                {stream.steps.length > 0 && <ToolActivity steps={stream.steps} className="max-w-[360px]" />}
              </>
            )}
            {stream.error && (
              <div
                className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                <span className="min-w-0 flex-1">{stream.error}</span>
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
        <div className="border-t bg-gradient-to-t from-background via-background to-transparent px-6 pb-5 pt-3">
          <div className="mx-auto max-w-4xl">
            {isEmpty && (
              <div className="mb-6 grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    disabled={!detail || isModelSaving || isSourceSaving || isTitleSaving}
                    className="group rounded-xl border bg-surface-subtle p-3 text-left text-[13px] text-muted-foreground transition-colors hover:border-aurora-teal/30 hover:bg-aurora-teal/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-aurora-teal/70" />
                      {s}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="rounded-2xl bg-gradient-to-r from-border via-primary/50 to-border p-px shadow-xl focus-within:via-primary">
              <div className="rounded-[calc(1rem-1px)] bg-card/90 p-2 backdrop-blur">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={detail ? "Ask Borealis about your data…" : "Open or create a chat to get started"}
                  rows={1}
                  disabled={!detail}
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
                            pending={isModelSaving || isSourceSaving || isTitleSaving}
                            streaming={stream.running}
                            error={modelErrorsByChat[detail.id] || null}
                            onChange={(model) => void selectModel(model)}
                            onRetry={() => void loadModels(true)}
                            onDismissError={() => dismissModelError(detail.id)}
                          />
                          <ChatSourcePicker
                            key={detail.id}
                            sourceMode={detail.source_mode}
                            attachedSources={detail.sources}
                            sources={sources}
                            sourcesLoading={sourcesLoading}
                            sourcesError={sourcesError}
                            disabled={isModelSaving || isSourceSaving || isTitleSaving || stream.running}
                            saving={isSourceSaving}
                            hasMessages={messages.length > 0}
                            onApply={saveSourceScope}
                            onUpload={uploadSource}
                            onRetrySources={() => refreshSources(true)}
                          />
                        </div>
                        <ActiveSourceScope
                          mode={detail.source_mode}
                          sources={detail.sources}
                          disabled={isModelSaving || isSourceSaving || isTitleSaving || stream.running}
                          error={sourceErrorsByChat[detail.id] || null}
                          onRemove={removeAttachedSource}
                          onDismissError={() => dismissSourceError(detail.id)}
                        />
                      </>
                    ) : (
                      <span className="px-2 text-xs text-muted-foreground">Select a chat to choose its model</span>
                    )}
                  </div>
                  {stream.running ? (
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-11 shrink-0 rounded-xl"
                      onClick={() => void stop()}
                      disabled={stream.stopping}
                      title={stream.stopping ? "Stopping…" : "Stop generating"}
                    >
                      <Square className="fill-current" />
                    </Button>
                  ) : (
                    <Button
                      variant="aurora"
                      size="icon"
                      className="size-11 shrink-0 rounded-xl"
                      disabled={!detail || !draft.trim() || isModelSaving || isSourceSaving || isTitleSaving}
                      onClick={() => send()}
                      title="Send"
                    >
                      <Send />
                    </Button>
                  )}
                </div>
              </div>
            </div>
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
  mode: SourceMode;
  sources: AttachedSource[];
  disabled: boolean;
  error: string | null;
  onRemove: (sourceId: string) => void;
  onDismissError: () => void;
}

function ActiveSourceScope({ mode, sources, disabled, error, onRemove, onDismissError }: ActiveSourceScopeProps) {
  return (
    <div className="flex flex-col gap-1.5 px-2" role="group" aria-label="Active chat sources">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Sources</span>
        {mode === "all" ? (
          <span className="inline-flex h-6 items-center rounded-md border bg-secondary px-2 text-[11px] text-secondary-foreground">
            All sources
          </span>
        ) : sources.length === 0 ? (
          <span className="inline-flex h-6 items-center rounded-md border bg-muted px-2 text-[11px] text-muted-foreground">
            No sources
          </span>
        ) : (
          sources.map((source) => (
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
          ))
        )}
      </div>

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
