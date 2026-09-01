import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError, sourcesApi, type Source } from "@/lib/api";
import { mergeCatalogContinuation } from "@/lib/catalogMerge";
import { isPendingSource, usePendingSourcePolling } from "@/lib/sourcePolling";
import { selectPollingBatch } from "@/lib/transitionPolling";

interface SourceCatalogOptions {
  onCatalog?: (sources: Source[]) => void;
}

interface PendingSource {
  source: Source;
  /** Latest list request that had already started when this source was created. */
  afterRequestId: number;
}

export function useSourceCatalog({ onCatalog }: SourceCatalogOptions = {}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const sourcesRef = useRef<Source[]>([]);
  const loadingOwnerRef = useRef<number | null>(null);
  const loadingMoreOwnerRef = useRef<number | null>(null);
  const pendingUploadsRef = useRef(new Map<string, PendingSource>());
  const statusPollQueueRef = useRef<string[]>([]);
  const nextCursorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const onCatalogRef = useRef(onCatalog);
  onCatalogRef.current = onCatalog;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async (showLoading = false) => {
    if (!mountedRef.current) return;
    const requestId = ++requestRef.current;
    if (loadingMoreOwnerRef.current !== null) {
      loadingMoreOwnerRef.current = null;
      setLoadingMore(false);
    }
    if (showLoading) {
      loadingOwnerRef.current = requestId;
      setLoading(true);
    }

    try {
      const statusBatch = selectPollingBatch(sourcesRef.current, isPendingSource, statusPollQueueRef.current);
      const [pageResult, statusResult] = await Promise.allSettled([
        sourcesApi.list(),
        statusBatch.ids.length ? sourcesApi.status(statusBatch.ids) : Promise.resolve({ items: [], missing_ids: [] }),
      ]);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      if (statusBatch.ids.length) statusPollQueueRef.current = statusBatch.nextQueue;
      if (pageResult.status === "rejected" && statusResult.status === "rejected") throw pageResult.reason;

      let reconciled = sourcesRef.current;
      if (pageResult.status === "fulfilled") {
        const latest = pageResult.value.items;
        const listedIds = new Set(latest.map((source) => source.id));
        for (const sourceId of listedIds) pendingUploadsRef.current.delete(sourceId);
        const localPending = reconciled.filter(
          (source) => pendingUploadsRef.current.has(source.id) && !listedIds.has(source.id),
        );
        const retainedIds = new Set([...localPending, ...latest].map((source) => source.id));
        reconciled = [...localPending, ...latest, ...reconciled.filter((source) => !retainedIds.has(source.id))];
        // An accepted head response starts a fresh traversal. Older accepted
        // rows stay merged by id, while this continuation makes records inserted
        // beyond the refreshed first page reachable.
        nextCursorRef.current = pageResult.value.next_cursor;
        setNextCursor(pageResult.value.next_cursor);
      }

      if (statusResult.status === "fulfilled") {
        const exactIds = new Set(statusResult.value.items.map((source) => source.id));
        for (const sourceId of exactIds) pendingUploadsRef.current.delete(sourceId);
        const missingIds = new Set(statusResult.value.missing_ids);
        for (const sourceId of missingIds) {
          const pending = pendingUploadsRef.current.get(sourceId);
          if (!pending || requestId > pending.afterRequestId) pendingUploadsRef.current.delete(sourceId);
        }
        reconciled = mergeCatalogContinuation(reconciled, statusResult.value.items).filter(
          (source) => !missingIds.has(source.id),
        );
      }

      setSources(reconciled);
      sourcesRef.current = reconciled;
      const partialFailure =
        pageResult.status === "rejected"
          ? pageResult.reason
          : statusResult.status === "rejected"
            ? statusResult.reason
            : null;
      setError(
        partialFailure
          ? formatApiError(
              partialFailure,
              "Some source statuses could not be refreshed. Your saved sources are unchanged.",
            )
          : null,
      );
      onCatalogRef.current?.(reconciled);
    } catch (error: unknown) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(
          formatApiError(
            error,
            "The source catalog is temporarily unavailable. Your saved chat sources are unchanged.",
          ),
        );
      }
    } finally {
      if (loadingOwnerRef.current === requestId) {
        loadingOwnerRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = nextCursorRef.current;
    if (!mountedRef.current || !cursor || loadingMoreOwnerRef.current !== null) return;
    const requestId = ++requestRef.current;
    loadingMoreOwnerRef.current = requestId;
    setLoadingMore(true);
    try {
      const page = await sourcesApi.list({ cursor });
      if (!mountedRef.current || requestId !== requestRef.current) return;
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
      const merged = mergeCatalogContinuation(sourcesRef.current, page.items);
      sourcesRef.current = merged;
      setSources(merged);
      setError(null);
      onCatalogRef.current?.(merged);
    } catch (error: unknown) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(formatApiError(error, "Could not load older sources"));
      }
    } finally {
      if (loadingMoreOwnerRef.current === requestId) {
        loadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  }, []);

  const addPending = useCallback((source: Source) => {
    if (!mountedRef.current) return;
    pendingUploadsRef.current.set(source.id, { source, afterRequestId: requestRef.current });
    setSources((current) => {
      const next = [source, ...current.filter((item) => item.id !== source.id)];
      sourcesRef.current = next;
      return next;
    });
  }, []);

  const applyOne = useCallback((source: Source) => {
    if (!mountedRef.current) return;
    setSources((current) => {
      const index = current.findIndex((item) => item.id === source.id);
      const next = index < 0 ? [source, ...current] : current.map((item) => (item.id === source.id ? source : item));
      sourcesRef.current = next;
      onCatalogRef.current?.(next);
      return next;
    });
  }, []);

  const removeOne = useCallback((sourceId: string) => {
    pendingUploadsRef.current.delete(sourceId);
    statusPollQueueRef.current = statusPollQueueRef.current.filter((id) => id !== sourceId);
    setSources((current) => {
      const next = current.filter((item) => item.id !== sourceId);
      sourcesRef.current = next;
      onCatalogRef.current?.(next);
      return next;
    });
  }, []);

  usePendingSourcePolling(sources, refresh, pendingUploadsRef.current.size > 0);

  return {
    sources,
    loading,
    loadingMore,
    hasMore: nextCursor !== null,
    error,
    refresh,
    loadMore,
    addPending,
    applyOne,
    removeOne,
  };
}
