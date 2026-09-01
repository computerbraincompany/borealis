import { useCallback, useEffect, useRef, useState } from "react";
import { connectorsApi, formatApiError, type Connector, type ConnectorSyncStatus } from "@/lib/api";
import { mergeCatalogContinuation } from "@/lib/catalogMerge";
import { selectPollingBatch } from "@/lib/transitionPolling";

const TRANSITIONAL_CONNECTOR_STATUSES = new Set<ConnectorSyncStatus>(["syncing", "indexing"]);
const CONNECTOR_POLL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export function isConnectorTransitioning(connector: Pick<Connector, "sync_status">): boolean {
  return TRANSITIONAL_CONNECTOR_STATUSES.has(connector.sync_status);
}

export function connectorPollDelay(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return CONNECTOR_POLL_DELAYS_MS[Math.min(safeAttempt, CONNECTOR_POLL_DELAYS_MS.length - 1)];
}

/** Own connector list responses and poll only while server state is transitional. */
export function useConnectorCatalog() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollCycle, setPollCycle] = useState(0);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const connectorsRef = useRef<Connector[]>([]);
  const statusPollQueueRef = useRef<string[]>([]);
  const nextCursorRef = useRef<string | null>(null);
  const loadingOwnerRef = useRef<number | null>(null);
  const loadingMoreOwnerRef = useRef<number | null>(null);
  const pollAttemptRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async (showLoading = false): Promise<Connector[] | null> => {
    if (!mountedRef.current) return null;
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
      const statusBatch = selectPollingBatch(
        connectorsRef.current,
        isConnectorTransitioning,
        statusPollQueueRef.current,
      );
      const [pageResult, statusResult] = await Promise.allSettled([
        connectorsApi.list(),
        statusBatch.ids.length
          ? connectorsApi.status(statusBatch.ids)
          : Promise.resolve({ items: [], missing_ids: [] }),
      ]);
      if (!mountedRef.current || requestId !== requestRef.current) return null;
      if (statusBatch.ids.length) statusPollQueueRef.current = statusBatch.nextQueue;
      if (pageResult.status === "rejected" && statusResult.status === "rejected") throw pageResult.reason;

      let latest = connectorsRef.current;
      if (pageResult.status === "fulfilled") {
        const pageIds = new Set(pageResult.value.items.map((connector) => connector.id));
        latest = [...pageResult.value.items, ...latest.filter((connector) => !pageIds.has(connector.id))];
        // Refreshing page one restarts traversal without discarding already
        // loaded older rows. ID dedupe makes revisiting overlap safe.
        nextCursorRef.current = pageResult.value.next_cursor;
        setNextCursor(pageResult.value.next_cursor);
      }
      if (statusResult.status === "fulfilled") {
        const missingIds = new Set(statusResult.value.missing_ids);
        latest = mergeCatalogContinuation(latest, statusResult.value.items).filter(
          (connector) => !missingIds.has(connector.id),
        );
      }
      connectorsRef.current = latest;
      setConnectors(latest);
      const partialFailure =
        pageResult.status === "rejected"
          ? pageResult.reason
          : statusResult.status === "rejected"
            ? statusResult.reason
            : null;
      setError(
        partialFailure ? formatApiError(partialFailure, "Some connector statuses could not be refreshed") : null,
      );
      return latest;
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(formatApiError(failure, "The connector catalog is temporarily unavailable"));
      }
      return null;
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
      const page = await connectorsApi.list({ cursor });
      if (!mountedRef.current || requestId !== requestRef.current) return;
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
      const merged = mergeCatalogContinuation(connectorsRef.current, page.items);
      connectorsRef.current = merged;
      setConnectors(merged);
      setError(null);
    } catch (failure: unknown) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(formatApiError(failure, "Could not load older connectors"));
      }
    } finally {
      if (loadingMoreOwnerRef.current === requestId) {
        loadingMoreOwnerRef.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  }, []);

  const hasTransitioningConnector = connectors.some(isConnectorTransitioning);
  useEffect(() => {
    if (!hasTransitioningConnector) {
      pollAttemptRef.current = 0;
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh().finally(() => {
        pollAttemptRef.current += 1;
        if (mountedRef.current) setPollCycle((current) => current + 1);
      });
    }, connectorPollDelay(pollAttemptRef.current));
    return () => window.clearTimeout(timer);
  }, [hasTransitioningConnector, pollCycle, refresh]);

  /** Apply one mutation response (e.g. schedule update) to the catalog before the reconciling refetch. */
  const applyOne = useCallback((updated: Connector) => {
    if (!mountedRef.current) return;
    const index = connectorsRef.current.findIndex((entry) => entry.id === updated.id);
    if (index === -1) return;
    const next = connectorsRef.current.slice();
    next[index] = updated;
    connectorsRef.current = next;
    setConnectors(next);
  }, []);

  const removeOne = useCallback((connectorId: string) => {
    statusPollQueueRef.current = statusPollQueueRef.current.filter((id) => id !== connectorId);
    setConnectors((current) => {
      const next = current.filter((entry) => entry.id !== connectorId);
      connectorsRef.current = next;
      return next;
    });
  }, []);

  return {
    connectors,
    loading,
    loadingMore,
    hasMore: nextCursor !== null,
    error,
    refresh,
    loadMore,
    applyOne,
    removeOne,
  };
}
