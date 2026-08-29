import { useCallback, useEffect, useRef, useState } from "react";
import { connectorsApi, formatApiError, type Connector, type ConnectorSyncStatus } from "@/lib/api";

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
  const [error, setError] = useState<string | null>(null);
  const [pollCycle, setPollCycle] = useState(0);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const loadingOwnerRef = useRef<number | null>(null);
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
    if (showLoading) {
      loadingOwnerRef.current = requestId;
      setLoading(true);
    }
    try {
      const latest = await connectorsApi.list();
      if (!mountedRef.current || requestId !== requestRef.current) return null;
      setConnectors(latest);
      setError(null);
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
    setConnectors((current) => {
      const index = current.findIndex((entry) => entry.id === updated.id);
      if (index === -1) return current;
      const next = current.slice();
      next[index] = updated;
      return next;
    });
  }, []);

  return { connectors, loading, error, refresh, applyOne };
}
