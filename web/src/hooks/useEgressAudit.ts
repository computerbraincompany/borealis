import { useCallback, useEffect, useState } from "react";
import { auditApi, type EgressEvent } from "@/lib/api";

/** Load the content-free egress audit while Settings is open. */
export function useEgressAudit(limit = 50) {
  const [events, setEvents] = useState<EgressEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setEvents(await auditApi.egress(limit));
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { events, loading, refresh };
}
