import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2, MessageSquareText, Send, Square, Sparkles, X } from "lucide-react";
import {
  chatsApi,
  modelsApi,
  sourcesApi,
  streamAgentChat,
  type AttachedSource,
  type Chat,
  type ChatDetail,
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
import { ToolActivity, type ToolStep } from "@/components/ToolActivity";

const SUGGESTIONS = [
  "Analyze my spending and produce a financial report with charts",
  "What are my biggest monthly expenses? Show a chart",
  "Summarize the documents I uploaded",
  "Build me a professional financial report with recommendations",
];

interface StreamState {
  running: boolean;
  model: string | null;
  text: string;
  reasoning: string;
  steps: ToolStep[];
  error: string | null;
  finalCharts: string[];
  finalReport: string | null;
}

function newStreamState(): StreamState {
  return { running: false, model: null, text: "", reasoning: "", steps: [], error: null, finalCharts: [], finalReport: null };
}

const EMPTY_STREAM_STATE = newStreamState();

export function ChatView({ chatId }: { chatId?: string }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [draft, setDraft] = useState(() => {
    const m = window.location.hash.match(/[?&]q=([^&]*)/);
    return m ? decodeURIComponent(m[1]) : "";
  });
  const [streamsByChat, setStreamsByChat] = useState<Record<string, StreamState>>({});
  const [modelCatalog, setModelCatalog] = useState<ModelsResponse | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogFailed, setModelCatalogFailed] = useState(false);
  const [modelSavingByChat, setModelSavingByChat] = useState<Record<string, boolean>>({});
  const [modelErrorsByChat, setModelErrorsByChat] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesUnavailable, setSourcesUnavailable] = useState(false);
  const [sourceSavingByChat, setSourceSavingByChat] = useState<Record<string, boolean>>({});
  const [sourceErrorsByChat, setSourceErrorsByChat] = useState<Record<string, string>>({});
  const abortByChatRef = useRef(new Map<string, AbortController>());
  const selectedChatIdRef = useRef<string | null>(null);
  const runRevisionByChatRef = useRef(new Map<string, number>());
  const bottomRef = useRef<HTMLDivElement>(null);
  const stepKeyRef = useRef(0);

  const updateStream = useCallback((id: string, updater: (state: StreamState) => StreamState) => {
    setStreamsByChat((current) => {
      const previous = current[id] ?? newStreamState();
      const next = updater(previous);
      return next === previous ? current : { ...current, [id]: next };
    });
  }, []);

  const stream = detail?.id ? streamsByChat[detail.id] ?? EMPTY_STREAM_STATE : EMPTY_STREAM_STATE;

  const loadChats = useCallback(async () => {
    try {
      setChats(await chatsApi.list());
    } catch {}
  }, []);

  const loadModels = useCallback(async (refresh = false) => {
    setModelCatalogLoading(true);
    try {
      setModelCatalog(await modelsApi.list(refresh));
      setModelCatalogFailed(false);
    } catch {
      setModelCatalog(null);
      setModelCatalogFailed(true);
    } finally {
      setModelCatalogLoading(false);
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const latest = await sourcesApi.list();
      setSources(latest);
      setSourcesUnavailable(false);
      setDetail((current) => {
        if (!current) return current;
        const reconciled = reconcileAttachedSources(current.source_mode, current.sources, latest);
        return sameAttachedSources(current.sources, reconciled) ? current : { ...current, sources: reconciled };
      });
    } catch {
      setSourcesUnavailable(true);
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  const loadChat = useCallback(async (id: string) => {
    selectedChatIdRef.current = id;
    try {
      const d = await chatsApi.get(id);
      if (selectedChatIdRef.current !== id) return;
      setStreamsByChat((current) => {
        let next = current;
        for (const [streamChatId, state] of Object.entries(current)) {
          if (streamChatId === id) {
            if (!state.running && !state.error) {
              if (next === current) next = { ...current };
              delete next[streamChatId];
            }
            continue;
          }
          if (!state.error) continue;
          if (next === current) next = { ...current };
          next[streamChatId] = { ...state, error: null };
        }
        return next;
      });
      setDetail(d);
      window.location.hash = `/chat/${id}`;
    } catch (e: any) {
      console.error(e);
      if (selectedChatIdRef.current === id) setDetail(null);
    }
  }, []);

  // initial: if chatId given load it, else just list chats
  useEffect(() => {
    loadChats();
    if (chatId) loadChat(chatId);
  }, [chatId, loadChats, loadChat]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    void loadSources();
    const timer = window.setInterval(() => void loadSources(), 6000);
    return () => window.clearInterval(timer);
  }, [loadSources]);

  // scroll to bottom on updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [detail, stream]);

  const openNewChat = async () => {
    const c = await chatsApi.create();
    setChats((prev) => [c, ...prev]);
    await loadChat(c.id);
  };

  const deleteChat = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (sourceSavingByChat[id] || modelSavingByChat[id] || streamsByChat[id]?.running || abortByChatRef.current.has(id)) return;
    await chatsApi.remove(id);
    setChats((prev) => prev.filter((c) => c.id !== id));
    setStreamsByChat((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setSourceErrorsByChat((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    runRevisionByChatRef.current.delete(id);
    if (id === detail?.id) {
      selectedChatIdRef.current = null;
      setDetail(null);
      window.location.hash = "/chat";
    }
  };

  const selectModel = async (nextModel: string) => {
    if (!detail) return;
    const targetChatId = detail.id;
    if (
      nextModel === detail.model ||
      modelSavingByChat[targetChatId] ||
      sourceSavingByChat[targetChatId] ||
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
      setDetail((current) =>
        current?.id === targetChatId ? { ...current, model: updated.model } : current
      );
      setChats((current) =>
        current.map((chat) => (chat.id === targetChatId ? { ...chat, ...updated } : chat))
      );
    } catch (error: any) {
      setModelErrorsByChat((current) => ({
        ...current,
        [targetChatId]: error?.message || "Could not save the selected model",
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
          : current
      );
      setChats((current) =>
        current.map((chat) =>
          chat.id === targetChatId ? { ...chat, source_mode: updated.source_mode } : chat
        )
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
    void saveSourceScope({ source_mode: "selected", source_ids: remainingIds }).catch((error: any) => {
      setSourceErrorsByChat((current) => ({
        ...current,
        [targetChatId]: error?.message || "Could not remove the source",
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

  const dismissStreamError = () => {
    if (!detail) return;
    updateStream(detail.id, (current) => (current.error ? { ...current, error: null } : current));
  };

  const send = async (text?: string) => {
    const content = (text ?? draft).trim();
    if (!content || !detail) return;
    const runChatId = detail.id;
    if (
      modelSavingByChat[runChatId] ||
      sourceSavingByChat[runChatId] ||
      streamsByChat[runChatId]?.running ||
      abortByChatRef.current.has(runChatId)
    ) {
      return;
    }
    setDraft("");

    // clear the welcome query param
    const base = `/chat/${runChatId}`;
    history.replaceState(null, "", `#${base}`);

    // optimistic local user message
    const optimistic: Message = { id: `local-${Date.now()}`, role: "user", content, created_at: new Date().toISOString() };

    const st: StreamState = {
      running: true,
      model: detail.model,
      text: "",
      reasoning: "",
      steps: [],
      error: null,
      finalCharts: [],
      finalReport: null,
    };
    const runRevision = (runRevisionByChatRef.current.get(runChatId) ?? 0) + 1;
    runRevisionByChatRef.current.set(runChatId, runRevision);
    const abort = new AbortController();
    abortByChatRef.current.set(runChatId, abort);
    setStreamsByChat((current) => ({ ...current, [runChatId]: st }));
    // temporarily hold the optimistic user message until stream refreshes from server
    setDetail((current) =>
      current?.id === runChatId ? { ...current, messages: [...current.messages, optimistic] } : current
    );

    const ownsRun = () => runRevisionByChatRef.current.get(runChatId) === runRevision;
    const isActiveRun = () => ownsRun() && abortByChatRef.current.get(runChatId) === abort;
    let pendingText = "";
    let pendingReasoning = "";
    let cancelScheduled: (() => void) | null = null;
    let runError: string | null = null;

    const flush = () => {
      cancelScheduled = null;
      const textChunk = pendingText;
      const reasoningChunk = pendingReasoning;
      pendingText = "";
      pendingReasoning = "";
      if ((!textChunk && !reasoningChunk) || !isActiveRun()) return;
      updateStream(runChatId, (current) => ({
        ...current,
        text: current.text + textChunk,
        reasoning: current.reasoning + reasoningChunk,
      }));
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

    const emit = (ev: any) => {
      if (!isActiveRun()) return;
      if (ev.type === "step-start") {
        const step: ToolStep = {
          key: ++stepKeyRef.current,
          name: ev.name,
          args: ev.args || {},
          status: "running",
        };
        updateStream(runChatId, (current) => ({ ...current, steps: [...current.steps, step] }));
      } else if (ev.type === "step-end") {
        updateStream(runChatId, (current) => ({
          ...current,
          steps: current.steps.map((step) =>
            step.name === ev.name && step.status === "running"
              ? { ...step, status: ev.result?.error ? "error" : "done", resultPreview: summarizeResult(ev.result) }
              : step
          ),
        }));
      } else if (ev.type === "delta") {
        pendingText += ev.text;
        scheduleFlush();
      } else if (ev.type === "reasoning") {
        pendingReasoning += ev.text;
        scheduleFlush();
      } else if (ev.type === "message") {
        updateStream(runChatId, (current) => ({
          ...current,
          model: typeof ev.meta?.model === "string" ? ev.meta.model : current.model,
          finalCharts: ev.meta?.charts || [],
          finalReport: ev.meta?.report || null,
        }));
      } else if (ev.type === "error") {
        runError = ev.message || "stream failed";
        updateStream(runChatId, (current) => ({ ...current, error: runError }));
      }
    };
    try {
      await streamAgentChat(runChatId, content, emit, abort.signal);
    } catch (e: any) {
      if ((e as Error).name !== "AbortError" && isActiveRun()) {
        runError = e.message || "stream failed";
        updateStream(runChatId, (current) => ({ ...current, error: runError }));
      }
    } finally {
      cancelPendingFlush();
      flush();

      if (isActiveRun()) {
        updateStream(runChatId, (current) => ({ ...current, running: false }));
        abortByChatRef.current.delete(runChatId);
      }

      let appliedAuthoritativeDetail = false;
      if (ownsRun() && selectedChatIdRef.current === runChatId) {
        const authoritative = await chatsApi.get(runChatId).catch(() => null);
        if (authoritative && ownsRun() && selectedChatIdRef.current === runChatId) {
          setDetail((current) => (current?.id === runChatId ? authoritative : current));
          if (!runError) {
            setStreamsByChat((current) => {
              const completed = current[runChatId];
              if (!completed || completed.running || completed.error) return current;
              const next = { ...current };
              delete next[runChatId];
              return next;
            });
          }
          appliedAuthoritativeDetail = true;
        }
      }

      await loadChats();

      if (ownsRun()) {
        const canDiscardStoppedState = selectedChatIdRef.current !== runChatId || appliedAuthoritativeDetail;
        if (!runError && canDiscardStoppedState) {
          setStreamsByChat((current) => {
            const completed = current[runChatId];
            if (!completed || completed.running || completed.error) return current;
            const next = { ...current };
            delete next[runChatId];
            return next;
          });
        }
        runRevisionByChatRef.current.delete(runChatId);
      }
    }
  };

  const stop = () => {
    if (detail) abortByChatRef.current.get(detail.id)?.abort();
  };

  const messages = detail?.messages || [];
  const hasStreamMessage = Boolean(
    stream.text || stream.reasoning || stream.finalCharts.length || stream.finalReport
  );
  const hasStreamActivity = hasStreamMessage || stream.steps.length > 0;
  const isEmpty = messages.length === 0 && !stream.running && !hasStreamActivity;
  const isModelSaving = detail ? Boolean(modelSavingByChat[detail.id]) : false;
  const isSourceSaving = detail ? Boolean(sourceSavingByChat[detail.id]) : false;
  const modelDiscovery = modelCatalog?.discovery ?? (modelCatalogFailed ? "unavailable" : null);
  const modelOptions = modelCatalog?.models ?? [];

  return (
    <div className="flex h-full">
      {/* conversations column */}
      <div className="flex w-[260px] shrink-0 flex-col border-r bg-sidebar/70">
        <div className="px-3 pb-2 pt-4">
          <Button variant="aurora" className="w-full" onClick={openNewChat}>
            <Plus className="h-4 w-4" /> New chat
          </Button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
          {chats.map((c) => {
            const active = c.id === detail?.id;
            const chatRunning = Boolean(streamsByChat[c.id]?.running);
            const chatBusy = chatRunning || Boolean(sourceSavingByChat[c.id]) || Boolean(modelSavingByChat[c.id]);
            return (
              <div
                key={c.id}
                onClick={() => loadChat(c.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2.5 transition-colors",
                  active ? "bg-gradient-to-r from-aurora-teal/12 to-aurora-violet/12 text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <MessageSquareText className={cn("h-4 w-4 shrink-0", active ? "text-aurora-teal" : "text-muted-foreground group-hover:text-foreground")} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.title}</span>
                <button
                  onClick={(e) => deleteChat(e, c.id)}
                  disabled={chatBusy}
                  className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                  title={chatRunning ? "Stop generating before deleting this chat" : chatBusy ? "Wait for chat settings to save" : "Delete chat"}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {chats.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              No conversations yet.
              <br />
              Start a new chat to begin.
            </div>
          )}
        </div>
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
          <div className="text-xs text-muted-foreground">{messages.filter((m) => m.role === "assistant").length} answers</div>
        </header>

        {/* messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
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
                />
              )
            )}

            {(stream.running || hasStreamActivity) && (
              <>
                {hasStreamMessage ? (
                  <ChatMessage
                    role="assistant"
                    content={stream.text}
                    reasoning={stream.reasoning}
                    streaming={stream.running}
                    charts={stream.finalCharts}
                    report={stream.finalReport}
                    model={stream.model || detail?.model}
                  />
                ) : stream.running && stream.steps.length === 0 ? (
                  <div className="flex justify-start">
                    <div className="flex min-w-[80px] items-center gap-3 rounded-2xl rounded-tl-md border bg-surface-subtle px-4 py-3">
                      <span className="inline-flex gap-1.5">
                        {[0, 1, 2].map((i) => (
                          <span key={i} className="h-2 w-2 rounded-full bg-aurora-teal" style={{ animation: `aurora-pulse 1.2s ${i * 0.2}s infinite` }} />
                        ))}
                      </span>
                      <span className="text-xs text-muted-foreground">thinking…</span>
                    </div>
                  </div>
                ) : null}
                {stream.steps.length > 0 && (
                  <ToolActivity steps={stream.steps} className="max-w-[360px]" />
                )}
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
                    disabled={!detail || isModelSaving || isSourceSaving}
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
                            pending={isModelSaving || isSourceSaving}
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
                            sourcesLoading={sourcesLoading || sourcesUnavailable}
                            disabled={isModelSaving || isSourceSaving || stream.running}
                            saving={isSourceSaving}
                            hasMessages={messages.length > 0}
                            onApply={saveSourceScope}
                          />
                        </div>
                        <ActiveSourceScope
                          mode={detail.source_mode}
                          sources={detail.sources}
                          disabled={isModelSaving || isSourceSaving || stream.running}
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
                      onClick={stop}
                      title="Stop generating"
                    >
                      <Square className="fill-current" />
                    </Button>
                  ) : (
                    <Button
                      variant="aurora"
                      size="icon"
                      className="size-11 shrink-0 rounded-xl"
                      disabled={!detail || !draft.trim() || isModelSaving || isSourceSaving}
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

function ActiveSourceScope({
  mode,
  sources,
  disabled,
  error,
  onRemove,
  onDismissError,
}: ActiveSourceScopeProps) {
  return (
    <div className="flex flex-col gap-1.5 px-2" role="group" aria-label="Active chat sources">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Sources
        </span>
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
                <span
                  className={cn(
                    "ml-1 shrink-0",
                    source.status === "error" ? "text-destructive" : "text-warning"
                  )}
                >
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

function toAttachedSource(source: Source): AttachedSource {
  return {
    id: source.id,
    name: source.name,
    display_name: source.display_name,
    kind: source.kind,
    status: source.status,
  };
}

function reconcileAttachedSources(
  mode: SourceMode,
  attached: AttachedSource[],
  available: Source[]
): AttachedSource[] {
  if (mode === "all") return available.map(toAttachedSource);

  const availableById = new Map(available.map((source) => [source.id, source]));
  return attached.flatMap((source) => {
    const current = availableById.get(source.id);
    return current ? [toAttachedSource(current)] : [];
  });
}

function sameAttachedSources(left: AttachedSource[], right: AttachedSource[]): boolean {
  return (
    left.length === right.length &&
    left.every((source, index) => {
      const other = right[index];
      return (
        source.id === other.id &&
        source.name === other.name &&
        source.display_name === other.display_name &&
        source.kind === other.kind &&
        source.status === other.status
      );
    })
  );
}

function summarizeResult(result: any): string {
  if (!result) return "";
  if (result.error) return String(result.error);
  if (typeof result === "object") {
    const r = result as Record<string, any>;
    if (r.ok === true && r.id) return `created ${r.name || "artifact"} (${r.id})`;
    if (Array.isArray(r.rows)) return `${r.rows.length} rows`;
    if (Array.isArray(r)) return `${r.length} items`;
    if (r.count !== undefined) return `${r.count} rows`;
    return JSON.stringify(result).slice(0, 160);
  }
  return String(result).slice(0, 160);
}
