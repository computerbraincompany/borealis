import { useMemo, useState } from "react";
import { Check, LoaderCircle, MessageSquareText, Pencil, Search, Trash2, X } from "lucide-react";
import { formatApiError, type Chat } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const GROUPS = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;
type GroupName = (typeof GROUPS)[number];

interface ChatHistoryProps {
  chats: Chat[];
  activeChatId?: string;
  busyChatIds: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  /** True while the first page is still loading and no chats are known yet. */
  loading?: boolean;
  /** Load failure for the visible list; distinct from a genuinely empty history. */
  error?: string | null;
  onRetry?: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onLoadMore: () => void | Promise<void>;
}

interface RenameState {
  chatId: string;
  draft: string;
  pending: boolean;
  error: string | null;
}

function groupForActivity(chat: Chat, now: Date): GroupName {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const previousWeek = new Date(today);
  previousWeek.setDate(previousWeek.getDate() - 7);
  const activity = new Date(chat.updated_at || chat.created_at);

  if (!Number.isFinite(activity.getTime())) return "Older";
  if (activity >= today) return "Today";
  if (activity >= yesterday) return "Yesterday";
  if (activity >= previousWeek) return "Previous 7 days";
  return "Older";
}

function validateTitle(value: string): string | null {
  const title = value.trim();
  if (!title) return "Enter a title before saving.";
  if ([...title].length > 80) return "Keep the title to 80 characters or fewer.";
  return null;
}

export function ChatHistory({
  chats,
  activeChatId,
  busyChatIds,
  hasMore,
  loadingMore,
  loading = false,
  error = null,
  onRetry,
  onOpen,
  onDelete,
  onRename,
  onLoadMore,
}: ChatHistoryProps) {
  const [search, setSearch] = useState("");
  const [rename, setRename] = useState<RenameState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Chat | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredChats = useMemo(
    () => chats.filter((chat) => chat.title.toLocaleLowerCase().includes(normalizedSearch)),
    [chats, normalizedSearch],
  );
  const groupedChats = useMemo(() => {
    const groups = new Map<GroupName, Chat[]>(GROUPS.map((name) => [name, []]));
    const now = new Date();
    for (const chat of filteredChats) groups.get(groupForActivity(chat, now))?.push(chat);
    return GROUPS.map((name) => ({ name, chats: groups.get(name) || [] })).filter((group) => group.chats.length > 0);
  }, [filteredChats]);

  const beginRename = (chat: Chat) => {
    if (busyChatIds.has(chat.id) || rename?.pending) return;
    setRename({ chatId: chat.id, draft: chat.title, pending: false, error: null });
  };

  const cancelRename = () => {
    if (!rename?.pending) setRename(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteBusyId) return;
    const chatId = deleteTarget.id;
    setDeleteBusyId(chatId);
    setDeleteError(null);
    try {
      await onDelete(chatId);
      setDeleteTarget((current) => (current?.id === chatId ? null : current));
    } catch (failure: unknown) {
      setDeleteError(formatApiError(failure, "Could not delete this conversation. Try again."));
    } finally {
      setDeleteBusyId((current) => (current === chatId ? null : current));
    }
  };

  const saveRename = async () => {
    if (!rename || rename.pending) return;
    const validationError = validateTitle(rename.draft);
    if (validationError) {
      setRename({ ...rename, error: validationError });
      return;
    }

    const chatId = rename.chatId;
    const title = rename.draft.trim();
    setRename({ ...rename, pending: true, error: null });
    try {
      await onRename(chatId, title);
      setRename((current) => (current?.chatId === chatId ? null : current));
    } catch (error: unknown) {
      setRename((current) =>
        current?.chatId === chatId
          ? { ...current, pending: false, error: formatApiError(error, "Could not rename this chat. Try again.") }
          : current,
      );
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        {deleteError && (
          <p
            role="alert"
            className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive"
          >
            {deleteError}
          </p>
        )}
        <label htmlFor="chat-history-search" className="sr-only">
          Search conversations
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="chat-history-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            className="h-9 w-full rounded-lg border bg-card pl-8 pr-8 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Clear conversation search"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {chats.length === 0 && error ? (
          <div className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground" role="alert">
            <p className="text-destructive">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 block w-full rounded-md font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry
              </button>
            )}
          </div>
        ) : chats.length === 0 && loading ? (
          <div className="space-y-1 px-2 py-3" aria-hidden="true">
            {["72%", "88%", "60%", "80%", "68%"].map((width, index) => (
              <div key={index} className="h-9 animate-pulse rounded-lg bg-accent/60" style={{ width }} />
            ))}
          </div>
        ) : chats.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            No conversations yet.
            <br />
            Start a new chat to begin.
          </div>
        ) : filteredChats.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            No conversations match “{search.trim()}”.
            <button
              type="button"
              onClick={() => setSearch("")}
              className="mt-2 block w-full rounded-md font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {groupedChats.map((group) => (
              <section key={group.name} aria-labelledby={`chat-group-${group.name.replace(/\s+/g, "-").toLowerCase()}`}>
                <h3
                  id={`chat-group-${group.name.replace(/\s+/g, "-").toLowerCase()}`}
                  className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"
                >
                  {group.name}
                </h3>
                <div className="space-y-0.5">
                  {group.chats.map((chat) => {
                    const active = chat.id === activeChatId;
                    const busy = busyChatIds.has(chat.id);
                    const editing = rename?.chatId === chat.id;
                    return (
                      <div
                        key={chat.id}
                        className={cn(
                          "group rounded-lg transition-colors",
                          active
                            ? "bg-accent font-semibold text-foreground"
                            : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                        )}
                      >
                        {editing ? (
                          <div
                            className="px-2 py-2"
                            onBlur={(event) => {
                              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) cancelRename();
                            }}
                          >
                            <div className="flex items-center gap-1.5">
                              <MessageSquareText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                              <input
                                autoFocus
                                value={rename.draft}
                                readOnly={rename.pending}
                                onChange={(event) => setRename({ ...rename, draft: event.target.value, error: null })}
                                onKeyDown={(event) => {
                                  if (event.nativeEvent.isComposing) return;
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void saveRename();
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    cancelRename();
                                  }
                                }}
                                className="h-8 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 read-only:opacity-70"
                                aria-label={`Rename ${chat.title}`}
                                aria-busy={rename.pending}
                                aria-invalid={Boolean(rename.error)}
                                aria-describedby={rename.error ? `rename-error-${chat.id}` : undefined}
                              />
                              <button
                                type="button"
                                onClick={() => void saveRename()}
                                disabled={rename.pending}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-success hover:bg-success/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                aria-label={rename.error ? "Retry rename" : "Save chat title"}
                              >
                                {rename.pending ? (
                                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={cancelRename}
                                disabled={rename.pending}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                aria-label="Cancel rename"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="mt-1 min-h-4 pl-[22px] text-[10px] leading-relaxed" aria-live="polite">
                              {rename.pending ? (
                                <span className="text-muted-foreground">Saving title…</span>
                              ) : rename.error ? (
                                <span id={`rename-error-${chat.id}`} className="text-destructive">
                                  {rename.error}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">Enter saves · Escape or blur cancels</span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 px-1 py-1">
                            <button
                              type="button"
                              onClick={() => onOpen(chat.id)}
                              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-current={active ? "page" : undefined}
                            >
                              <MessageSquareText
                                className={cn(
                                  "h-4 w-4 shrink-0",
                                  active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                                )}
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1 truncate text-[13px]">{chat.title}</span>
                              {busy && (
                                <LoaderCircle
                                  className="h-3.5 w-3.5 shrink-0 animate-spin text-primary"
                                  aria-label="Chat is busy"
                                />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => beginRename(chat)}
                              disabled={busy || Boolean(rename?.pending)}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30"
                              aria-label={`Rename ${chat.title}`}
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteError(null);
                                setDeleteTarget(chat);
                              }}
                              disabled={busy || Boolean(rename?.pending) || Boolean(deleteBusyId)}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30"
                              aria-label={`Delete ${chat.title}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
        {hasMore && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void onLoadMore()}
            className="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-md border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
          >
            {loadingMore && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {loadingMore ? "Loading older conversations…" : "Load older conversations"}
          </button>
        )}
      </div>
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.title}”?`}
          description="This permanently removes the conversation and all of its messages. This cannot be undone."
          busy={deleteBusyId === deleteTarget.id}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (deleteBusyId !== deleteTarget.id) setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}
