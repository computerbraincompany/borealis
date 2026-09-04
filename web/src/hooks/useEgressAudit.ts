import { useCallback, useEffect, useRef, useState } from "react";
import { auditApi, formatApiError, type EgressEvent } from "@/lib/api";

/** Load the content-free egress audit while Settings is open. */
export function useEgressAudit(limit = 50) {
  const [events, setEvents] = useState<EgressEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setLoading(true);
    try {
      const next = await auditApi.egress(limit, abort.signal);
      if (requestId === requestRef.current && !abort.signal.aborted) {
        setEvents(next);
        setLoadError(null);
      }
    } catch (failure: unknown) {
      // The section must not silently vanish on a failed load.
      if (requestId === requestRef.current && !abort.signal.aborted) {
        setEvents([]);
        setLoadError(formatApiError(failure, "Could not load the egress audit"));
      }
    } finally {
      if (requestId === requestRef.current && !abort.signal.aborted) setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
      abortRef.current?.abort();
    };
  }, [refresh]);

  return { events, loading, loadError, refresh };
}
