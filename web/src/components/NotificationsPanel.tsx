import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, X } from "lucide-react";
import { formatApiError, notificationsApi, type BriefNotification, type BriefNotificationKind } from "@/lib/api";
import { mergeCatalogContinuation, mergeCatalogHead } from "@/lib/catalogMerge";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Local in-app notification tray (M16 step 8). Events are server-written,
 * deduplicated per (run, kind), suppressed entirely for recipes with the
 * per-recipe preference off, and never delivered anywhere outbound. Read and
 * dismiss are explicit per-row durable transitions — nothing here is ever
 * marked automatically. The unread badge is the unread count of the bounded
 * loaded page (default 20, max 50), suffixed "+" when older pages exist.
 */

const PAGE_LIMIT = 20;
const POLL_BASE_MS = 60_000;
const POLL_MAX_MS = 10 * 60_000;

const KIND_LABELS: Record<BriefNotificationKind, string> = {
  first_draft: "New draft ready",
  meaningful_change: "Result changed",
  attention: "Needs attention",
  paused: "Brief auto-paused",
};

export function NotificationsPanel() {
  const [items, setItems] = useState<BriefNotification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreOwnerRef = useRef<number | null>(null);
  const mutationRef = useRef(0);
  const failuresRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      loadingMoreOwnerRef.current = null;
      mutationRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    loadingMoreOwnerRef.current = null;
    setLoadingMore(false);
    try {
      const page = await notificationsApi.list({ limit: PAGE_LIMIT });
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setItems((current) => mergeCatalogHead(page.items, current));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
      failuresRef.current = 0;
      setError(null);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === requestRef.current) {
        failuresRef.current += 1;
        setError(formatApiError(failure, "Notifications are temporarily unavailable."));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Visibility-aware count poll that widens on consecutive failures.
  const unreadCount = items.filter((item) => item.state === "unread").length;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") void refreshRef.current();
      const widened = Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** failuresRef.current);
      timer = window.setTimeout(tick, document.visibilityState === "visible" ? widened : POLL_BASE_MS);
    };
    timer = window.setTimeout(tick, POLL_BASE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const loadMore = async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingMoreOwnerRef.current !== null) return;
    const requestId = ++requestRef.current;
    loadingMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await notificationsApi.list({ cursor, limit: PAGE_LIMIT });
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setItems((current) => mergeCatalogContinuation(current, page.items));
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === requestRef.current)
        setError(formatApiError(failure, "Could not load older notifications."));
    } finally {
      if (loadingMoreOwnerRef.current === requestId) {
        loadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  };

  const transition = async (item: BriefNotification, state: "read" | "dismissed") => {
    if (busyId === item.id) return;
    const requestId = ++mutationRef.current;
    setBusyId(item.id);
    setError(null);
    try {
      const updated = await notificationsApi.setState(item.id, state);
      if (!mountedRef.current || requestId !== mutationRef.current) return;
      setItems((current) => current.map((entry) => (entry.id === item.id ? updated : entry)));
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === mutationRef.current)
        setError(formatApiError(failure, "Could not update the notification."));
    } finally {
      if (mountedRef.current) setBusyId((current) => (current === item.id ? null : current));
    }
  };

  const visible = items.filter((item) => item.state !== "dismissed");
  const badge = unreadCount > 0 ? `${unreadCount}${nextCursor ? "+" : ""}` : null;

  return (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-[18px] w-[18px]" />
        Notifications
        {badge && (
          <span
            className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground"
            aria-label={`${unreadCount} unread notifications${nextCursor ? " (more in older pages)" : ""}`}
          >
            {badge}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1" aria-label="Local notifications">
          <p className="px-1 text-[11px] text-muted-foreground">
            Local inbox only — never sent anywhere. Deduplicated per run and event; per-recipe disable suppresses new
            events. Read and dismiss only when you click them.
          </p>
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {error}{" "}
              <Button variant="link" size="sm" className="h-auto p-0 underline" onClick={() => void refresh()}>
                Retry
              </Button>
            </p>
          )}
          {visible.length === 0 && !error && <p className="px-1 py-1 text-xs text-muted-foreground">Nothing new.</p>}
          {visible.map((item) => (
            <div key={item.id} className="rounded-md border bg-card px-2 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-1">
                <span
                  className={cn("font-medium", item.state === "unread" ? "text-foreground" : "text-muted-foreground")}
                >
                  {KIND_LABELS[item.kind]}
                </span>
                <time dateTime={item.created_at} className="text-[10px] text-muted-foreground">
                  {formatDate(item.created_at)}
                </time>
              </div>
              <p className="mt-0.5 text-muted-foreground">{item.detail}</p>
              <div className="mt-1 flex gap-1">
                {item.state === "unread" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    disabled={busyId === item.id}
                    onClick={() => void transition(item, "read")}
                  >
                    <Check className="h-3 w-3" /> Mark read
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px]"
                  disabled={busyId === item.id}
                  onClick={() => void transition(item, "dismissed")}
                >
                  <X className="h-3 w-3" /> Dismiss
                </Button>
                <a href="#/reviews" className="ml-auto self-center text-[11px] text-primary underline">
                  Open inbox
                </a>
              </div>
            </div>
          ))}
          {nextCursor && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-[11px]"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              Load older notifications
            </Button>
          )}
          {items.length > 0 && visible.length < items.length && (
            <p className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
              <BellOff className="h-3 w-3" /> Dismissed events stay durable but hidden from this tray.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
