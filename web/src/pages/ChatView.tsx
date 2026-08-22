import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Trash2, MessageSquareText, Send, Square, Sparkles } from "lucide-react";
import { chatsApi, streamAgentChat, type Chat, type ChatDetail, type Message } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage } from "@/components/ChatMessage";
import { ToolActivity, type ToolStep } from "@/components/ToolActivity";

const SUGGESTIONS = [
  "Analyze my spending and produce a financial report with charts",
  "What are my biggest monthly expenses? Show a chart",
  "Summarize the documents I uploaded",
  "Build me a professional financial report with recommendations",
];

interface StreamState {
  running: boolean;
  text: string;
  steps: ToolStep[];
  error: string | null;
  finalCharts: string[];
  finalReport: string | null;
}

function newStreamState(): StreamState {
  return { running: false, text: "", steps: [], error: null, finalCharts: [], finalReport: null };
}

export function ChatView({ chatId }: { chatId?: string }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [draft, setDraft] = useState(() => {
    const m = window.location.hash.match(/[?&]q=([^&]*)/);
    return m ? decodeURIComponent(m[1]) : "";
  });
  const [stream, setStream] = useState<StreamState>(newStreamState);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stepKeyRef = useRef(0);

  const loadChats = useCallback(async () => {
    try {
      setChats(await chatsApi.list());
    } catch {}
  }, []);

  const loadChat = useCallback(async (id: string) => {
    try {
      const d = await chatsApi.get(id);
      setDetail(d);
      window.location.hash = `/chat/${id}`;
      setStream(newStreamState());
    } catch (e: any) {
      console.error(e);
      setDetail(null);
      return;
    }
  }, []);

  // initial: if chatId given load it, else just list chats
  useEffect(() => {
    loadChats();
    if (chatId) loadChat(chatId);
  }, [chatId, loadChats, loadChat]);

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
    await chatsApi.remove(id);
    setChats((prev) => prev.filter((c) => c.id !== id));
    if (id === detail?.id) {
      setDetail(null);
      window.location.hash = "/chat";
    }
  };

  const send = async (text?: string) => {
    const content = (text ?? draft).trim();
    if (!content || !detail || stream.running) return;
    setDraft("");

    // clear the welcome query param
    const base = `/chat/${detail.id}`;
    history.replaceState(null, "", `#${base}`);

    // optimistic local user message
    const optimistic: Message = { id: `local-${Date.now()}`, role: "user", content, created_at: new Date().toISOString() };

    const st: StreamState = { running: true, text: "", steps: [], error: null, finalCharts: [], finalReport: null };
    setStream(st);
    // temporarily hold the optimistic user message until stream refreshes from server
    const prevDetail = { ...detail, messages: [...detail.messages, optimistic] };
    setDetail(prevDetail);

    const abort = new AbortController();
    abortRef.current = abort;
    const emit = (ev: any) => {
      if (ev.type === "step-start") {
        const step: ToolStep = {
          key: ++stepKeyRef.current,
          name: ev.name,
          args: ev.args || {},
          status: "running",
        };
        setStream((s) => ({ ...s, steps: [...s.steps, step] }));
      } else if (ev.type === "step-end") {
        setStream((s) => ({
          ...s,
          steps: s.steps.map((step) =>
            step.name === ev.name && step.status === "running"
              ? { ...step, status: ev.result?.error ? "error" : "done", resultPreview: summarizeResult(ev.result) }
              : step
          ),
        }));
      } else if (ev.type === "delta") {
        setStream((s) => ({ ...s, text: s.text + ev.text }));
      } else if (ev.type === "message") {
        setStream((s) => ({ ...s, finalCharts: ev.meta?.charts || [], finalReport: ev.meta?.report || null }));
      } else if (ev.type === "error") {
        setStream((s) => ({ ...s, error: ev.message }));
      }
    };
    try {
      await streamAgentChat(detail.id, content, emit, abort.signal);
    } catch (e: any) {
      if ((e as Error).name !== "AbortError") setStream((s) => ({ ...s, error: e.message || "stream failed" }));
    } finally {
      setStream((s) => ({ ...s, running: false }));
      abortRef.current = null;
      // refresh the conversation from the server (authoritative copy)
      const d = await chatsApi.get(detail.id).catch(() => null);
      if (d) setDetail(d);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const messages = detail?.messages || [];
  const isEmpty = messages.length === 0 && !stream.running;

  return (
    <div className="flex h-full">
      {/* conversations column */}
      <div className="flex w-[260px] shrink-0 flex-col border-r bg-[#0b0f1d]/60">
        <div className="px-3 pb-2 pt-4">
          <Button variant="aurora" className="w-full" onClick={openNewChat}>
            <Plus className="h-4 w-4" /> New chat
          </Button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
          {chats.map((c) => {
            const active = c.id === detail?.id;
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
                  className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  title="Delete chat"
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
            <h2 className="truncate text-[15px] font-semibold">{detail?.title || "Chat with North"}</h2>
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
                  charts={(m.meta as any)?.charts || undefined}
                  report={(m.meta as any)?.report || undefined}
                />
              )
            )}

            {stream.running && (
              <>
                {stream.text || stream.steps.length ? (
                  <ChatMessage role="assistant" content={stream.text} streaming charts={stream.finalCharts} report={stream.finalReport} />
                ) : (
                  <div className="flex justify-start">
                    <div className="flex min-w-[80px] items-center gap-3 rounded-2xl rounded-tl-md border border-white/5 bg-white/[0.02] px-4 py-3">
                      <span className="inline-flex gap-1.5">
                        {[0, 1, 2].map((i) => (
                          <span key={i} className="h-2 w-2 rounded-full bg-aurora-teal" style={{ animation: `aurora-pulse 1.2s ${i * 0.2}s infinite` }} />
                        ))}
                      </span>
                      <span className="text-xs text-muted-foreground">thinking…</span>
                    </div>
                  </div>
                )}
                <ToolActivity steps={stream.steps} className="max-w-[360px]" />
                {stream.error && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                    {stream.error}
                  </div>
                )}
                {!stream.text && !stream.steps.length && stream.error === null && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-3 rounded-2xl rounded-tl-md border border-white/5 bg-white/[0.02] px-4 py-3">
                      <span className="inline-flex gap-1.5">
                        {[0, 1, 2].map((i) => (
                          <span key={i} className="h-2 w-2 rounded-full bg-aurora-teal" style={{ animation: `aurora-pulse 1.2s ${i * 0.2}s infinite` }} />
                        ))}
                      </span>
                      <span className="text-xs text-muted-foreground">thinking…</span>
                    </div>
                  </div>
                )}
              </>
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
                    disabled={!detail}
                    className="group rounded-xl border border-white/5 bg-white/[0.02] p-3 text-left text-[13px] text-muted-foreground transition-colors hover:border-aurora-teal/30 hover:bg-aurora-teal/5 hover:text-foreground disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-aurora-teal/70" />
                      {s}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-card/60 p-2 shadow-xl backdrop-blur focus-within:border-aurora-teal/40">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={detail ? "Ask North about your data…" : "Open or create a chat to get started"}
                rows={1}
                disabled={!detail}
                className="max-h-40 min-h-[44px] flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-[15px] shadow-none focus-visible:ring-0"
                style={{ height: "auto" }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 160) + "px";
                }}
              />
              {stream.running ? (
                <Button variant="outline" size="icon" className="h-11 w-11 shrink-0 rounded-xl" onClick={stop} title="Stop generating">
                  <Square className="h-4 w-4 fill-current" />
                </Button>
              ) : (
                <Button
                  variant="aurora"
                  className="h-11 w-11 shrink-0 rounded-xl"
                  disabled={!detail || !draft.trim()}
                  onClick={() => send()}
                  title="Send"
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              North can make mistakes — verify important results against your source data.
            </p>
          </div>
        </div>
      </div>
    </div>
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
