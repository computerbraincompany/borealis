import { useCallback, useEffect, useRef, useState } from "react";
import { auditApi, formatApiError, type EgressEvent } from "@/lib/api";

/** Load the content-free egress audit while Settings is open. */
export function useEgressAudit(limit = 50, enabled = true) {
  const [events, setEvents] = useState<EgressEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const failuresRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setLoading(true);
    try {
      const next = await auditApi.egress(limit, abort.signal);
      if (requestId === requestRef.current && !abort.signal.aborted) {
        failuresRef.current = 0;
        setEvents(next);
        setLoadError(null);
      }
    } catch (failure: unknown) {
      // The section must not silently vanish on a failed load.
      if (requestId === requestRef.current && !abort.signal.aborted) {
        failuresRef.current += 1;
        setLoadError(formatApiError(failure, "Borealis couldn’t load the activity history from the server."));
      }
    } finally {
      if (requestId === requestRef.current && !abort.signal.aborted) setLoading(false);
    }
  }, [limit, enabled]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
      abortRef.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !loadError || loading) return;
    let timer = 0;
    const retry = () => {
      timer = window.setTimeout(
        () => {
          if (document.visibilityState === "visible") void refresh();
          else retry();
        },
        Math.min(5_000 * failuresRef.current, 30_000),
      );
    };
    retry();
    return () => window.clearTimeout(timer);
  }, [enabled, loadError, loading, refresh]);

  return { events, loading, loadError, refresh };
}
