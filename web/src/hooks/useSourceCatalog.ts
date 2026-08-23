import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError, sourcesApi, type Source } from "@/lib/api";
import { usePendingSourcePolling } from "@/lib/sourcePolling";

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
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const loadingOwnerRef = useRef<number | null>(null);
  const pendingUploadsRef = useRef(new Map<string, PendingSource>());
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
    if (showLoading) {
      loadingOwnerRef.current = requestId;
      setLoading(true);
    }

    try {
      const latest = await sourcesApi.list();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      const listedIds = new Set(latest.map((source) => source.id));
      const pending: Source[] = [];
      for (const [sourceId, entry] of pendingUploadsRef.current) {
        if (listedIds.has(sourceId)) {
          pendingUploadsRef.current.delete(sourceId);
        } else if (requestId <= entry.afterRequestId) {
          // A list request that started before the upload response cannot prove
          // the new source is absent. Preserve it until a post-upload response.
          pending.push(entry.source);
        } else {
          // The first authoritative post-upload omission bounds the local ghost
          // and lets pending-only polling terminate.
          pendingUploadsRef.current.delete(sourceId);
        }
      }
      const reconciled = [...pending, ...latest];
      setSources(reconciled);
      setError(null);
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

  const addPending = useCallback((source: Source) => {
    if (!mountedRef.current) return;
    pendingUploadsRef.current.set(source.id, { source, afterRequestId: requestRef.current });
    setSources((current) => [source, ...current.filter((item) => item.id !== source.id)]);
  }, []);

  usePendingSourcePolling(sources, refresh, pendingUploadsRef.current.size > 0);

  return { sources, loading, error, refresh, addPending };
}
